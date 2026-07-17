import { type CodeRegion, computeCodeRegions, isInsideCodeRegion } from './code-regions';
import MarkdownIt from 'markdown-it';

export interface OrientationDiagnostic {
  kind: 'unclosed' | 'orphaned' | 'nested' | 'crossed';
  /** The directive name that triggered the diagnostic (e.g. 'landscape') */
  directiveName: string;
  /** Character (UTF-16 code unit) offset of the diagnostic directive, suitable for use with LSP positionAt() */
  start: number;
  /** Character (UTF-16 code unit) end offset of the diagnostic directive */
  end: number;
  /** For nested/crossed: the name of the conflicting opener */
  relatedName?: string;
  /** For nested/crossed: character (UTF-16 code unit) offset of the conflicting opener */
  relatedStart?: number;
  /** For nested/crossed: character (UTF-16 code unit) end offset of the conflicting opener */
  relatedEnd?: number;
}

/**
 * Scan text for orientation directive errors: unclosed opens, orphaned closes,
 * nested opens, and crossed (out-of-order) closes. Skips directives inside
 * code regions (fenced code blocks, inline code).
 *
 * Only one orientation can be active at a time — opening `<!-- portrait -->`
 * while `<!-- landscape -->` is active (or vice versa) is reported as nested.
 */
/**
 * Returns true when the match is on its own line (possibly with leading whitespace)
 * and NOT indented 4+ spaces or a tab (which markdown-it treats as a code block).
 * Inline uses (other content on the same line) return false.
 */
function isStandaloneDirective(text: string, matchStart: number, matchEnd: number): boolean {
  // Find line boundaries
  let lineStart = matchStart;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
  let lineEnd = matchEnd;
  while (lineEnd < text.length && text[lineEnd] !== '\n') lineEnd++;

  // Check for non-whitespace before or after the match on the same line
  const before = text.slice(lineStart, matchStart);
  const after = text.slice(matchEnd, lineEnd);
  if (/\S/.test(before) || /\S/.test(after)) return false;

  // Reject indented code blocks: 4+ spaces or tab at start of line
  if (/^(\t| {4})/.test(before)) return false;

  return true;
}

const md = new MarkdownIt({ html: true, linkify: true });
const HTML_COMMENT_ONLY_RE = /^<!--[\s\S]*?-->\s*$/;

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function mergeRegions(regions: CodeRegion[]): CodeRegion[] {
  if (regions.length <= 1) return regions;
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const merged: CodeRegion[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const next = sorted[i];
    if (next.start <= prev.end) {
      prev.end = Math.max(prev.end, next.end);
    } else {
      merged.push({ start: next.start, end: next.end });
    }
  }
  return merged;
}

function computeLiteralHtmlBlockRegions(text: string): CodeRegion[] {
  const lineStarts = lineStartOffsets(text);
  const lineOffset = (line: number): number => line < lineStarts.length ? lineStarts[line] : text.length;
  const regions: CodeRegion[] = [];
  for (const token of md.parse(text, {})) {
    if (token.type !== 'html_block') continue;
    if (HTML_COMMENT_ONLY_RE.test(token.content.trim())) continue;
    if (!token.map) continue;
    regions.push({
      start: lineOffset(token.map[0]),
      end: lineOffset(token.map[1]),
    });
  }
  return regions;
}

export function scanOrientationDirectives(text: string, codeRegions?: CodeRegion[]): OrientationDiagnostic[] {
  const regions = mergeRegions([
    ...(codeRegions ?? computeCodeRegions(text)),
    ...computeLiteralHtmlBlockRegions(text),
  ]);
  const directiveRe = /<!--\s*(\/?)(landscape|portrait)\s*-->/gi;
  const openStack: { name: string; start: number; end: number }[] = [];
  const results: OrientationDiagnostic[] = [];

  let m: RegExpExecArray | null;
  while ((m = directiveRe.exec(text)) !== null) {
    if (isInsideCodeRegion(m.index, regions)) continue;
    if (!isStandaloneDirective(text, m.index, m.index + m[0].length)) continue;
    const isClose = m[1] === '/';
    const name = m[2].toLowerCase();
    const start = m.index;
    const end = start + m[0].length;

    if (!isClose) {
      if (openStack.length > 0) {
        const existing = openStack[openStack.length - 1];
        results.push({
          kind: 'nested',
          directiveName: name,
          start,
          end,
          relatedName: existing.name,
          relatedStart: existing.start,
          relatedEnd: existing.end,
        });
        // Don't push — keep original opener so "unclosed" points to the root.
        // The converter in md-to-docx.ts handles graceful recovery (close + reopen)
        // independently; this scanner's job is accurate diagnostics.
      } else {
        openStack.push({ name, start, end });
      }
    } else {
      if (openStack.length > 0) {
        const top = openStack[openStack.length - 1];
        if (top.name === name) {
          openStack.pop();
        } else {
          // Crossed close: <!-- /portrait --> while <!-- landscape --> is active
          results.push({
            kind: 'crossed',
            directiveName: name,
            start,
            end,
            relatedName: top.name,
            relatedStart: top.start,
            relatedEnd: top.end,
          });
          // Don't pop — the wrong opener stays active
        }
      } else {
        results.push({
          kind: 'orphaned',
          directiveName: name,
          start,
          end,
        });
      }
    }
  }

  for (const entry of openStack) {
    results.push({
      kind: 'unclosed',
      directiveName: entry.name,
      start: entry.start,
      end: entry.end,
    });
  }

  return results;
}
