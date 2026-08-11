import { parseEmbedDirective } from './embed-preprocess';
import { computeCodeRegions, overlapsCodeRegion } from './code-regions';

// ---------------------------------------------------------------------------
// Pure helper — testable without VS Code
// ---------------------------------------------------------------------------

export interface EmbedPathRange {
  /** The unquoted file path */
  path: string;
  /** The directive's effective last-value-wins worksheet selector, when present. */
  sheet?: string;
  /** 0-based line number */
  line: number;
  /** Start column (inclusive) of the path text within the line */
  startCol: number;
  /** End column (exclusive) of the path text within the line */
  endCol: number;
}

export interface EmbedSheetRange {
  /** The workbook path from the embed directive */
  path: string;
  /** The decoded worksheet name */
  sheetName: string;
  /** 0-based line number */
  line: number;
  /** Start column (inclusive) of the worksheet name, excluding quotes */
  startCol: number;
  /** End column (exclusive) of the worksheet name, excluding quotes */
  endCol: number;
}

/**
 * Regex to locate the path token (first non-whitespace token after `embed:`)
 * inside a validated embed directive line.  Captures:
 *   [1] double-quoted path  OR
 *   [2] single-quoted path  OR
 *   [3] unquoted path
 */
const PATH_RE = /<!--\s*embed:\s*(?:"([^"]+)"|'([^']+)'|(\S+?))\s*(?:-->|[\s])/;

/**
 * Scan document text and return the location of each embed-directive file path.
 * Skips directives inside fenced code blocks / inline code spans.
 */
export function findEmbedPathRanges(text: string): EmbedPathRange[] {
  const results: EmbedPathRange[] = [];
  const codeRegions = computeCodeRegions(text);
  const lines = text.split('\n');

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineEnd = offset + line.length;

    if (!overlapsCodeRegion(offset, lineEnd, codeRegions)) {
      const trimmed = line.trim();
      const directive = parseEmbedDirective(trimmed);
      if (directive) {
        const m = line.match(PATH_RE);
        if (m) {
          // Determine which capture group matched
          const pathText = m[1] ?? m[2] ?? m[3];
          if (pathText) {
            // The path is always a suffix of m[0] (possibly followed by a
            // closing quote).  lastIndexOf reliably finds the rightmost
            // occurrence, which is the actual path position.
            const startCol = m.index! + m[0].lastIndexOf(pathText);
            const endCol = startCol + pathText.length;
            results.push({
              path: directive.path,
              sheet: directive.sheet,
              line: i,
              startCol,
              endCol,
            });
          }
        }
      }
    }

    offset = lineEnd + 1; // +1 for newline
  }

  return results;
}

interface SourceToken {
  value: string;
  start: number;
  end: number;
  /** Source ranges for quoted portions, excluding their quote characters. */
  quotedParts: Array<{ start: number; end: number }>;
}

/**
 * Tokenize a directive body while retaining source locations. This mirrors the
 * embed parser's space-delimited, quote-aware grammar, but rejects an
 * unterminated quoted value so malformed directives do not become links.
 */
function tokenizeWithRanges(body: string, bodyStart: number): SourceToken[] | null {
  const tokens: SourceToken[] = [];
  let i = 0;

  while (i < body.length) {
    while (i < body.length && body[i] === ' ') i++;
    if (i >= body.length) break;

    const start = i;
    let value = '';
    const quotedParts: Array<{ start: number; end: number }> = [];

    while (i < body.length && body[i] !== ' ') {
      if (body[i] === '"' || body[i] === "'") {
        const quote = body[i];
        i++;
        const quotedStart = i;
        while (i < body.length && body[i] !== quote) {
          value += body[i];
          i++;
        }
        if (i >= body.length) return null;
        quotedParts.push({
          start: bodyStart + quotedStart,
          end: bodyStart + i,
        });
        i++;
      } else {
        value += body[i];
        i++;
      }
    }

    if (value) {
      tokens.push({ value, start: bodyStart + start, end: bodyStart + i, quotedParts });
    }
  }

  return tokens;
}

/**
 * Scan document text and return source ranges for worksheet names in embed
 * directives. Only the value text is ranged, so quotes remain ordinary text.
 */
export function findEmbedSheetRanges(text: string): EmbedSheetRange[] {
  const results: EmbedSheetRange[] = [];
  const codeRegions = computeCodeRegions(text);
  const lines = text.split('\n');

  let offset = 0;
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];
    const lineEnd = offset + line.length;

    if (!overlapsCodeRegion(offset, lineEnd, codeRegions)) {
      const directive = parseEmbedDirective(line.trim());
      const prefix = /<!--\s*embed:\s*/.exec(line);
      const close = line.lastIndexOf('-->');

      if (directive?.path && /\.xlsx$/i.test(directive.path) && prefix?.index !== undefined && close >= 0) {
        const bodyStart = prefix.index + prefix[0].length;
        const bodyEnd = close;
        const body = line.slice(bodyStart, bodyEnd).trimEnd();
        const tokens = tokenizeWithRanges(body, bodyStart);

        // tokens[0] is the workbook path; remaining tokens are parameters.
        for (const token of tokens?.slice(1) ?? []) {
          const equalIndex = token.value.indexOf('=');
          if (equalIndex <= 0 || token.value.slice(0, equalIndex).toLowerCase() !== 'sheet') {
            continue;
          }

          const sheetName = token.value.slice(equalIndex + 1);
          // Numeric selectors are 1-based worksheet indexes in embed syntax,
          // while Table Viewer's public command resolves exact sheet names.
          if (!sheetName || /^\d+$/.test(sheetName)) continue;

          const source = line.slice(token.start, token.end);
          const sourceEqualIndex = source.indexOf('=');
          if (sourceEqualIndex < 0) continue;

          const valueStart = token.start + sourceEqualIndex + 1;
          const quotedValue = token.quotedParts.find((part) => part.start === valueStart + 1);
          // Quotes are supported only when they wrap the whole value, matching
          // the documented sheet="Sheet Name" form. Reject ambiguous partial
          // quoting instead of producing a misleading source range.
          if (
            token.quotedParts.length > 0 &&
            (!quotedValue || token.quotedParts.length !== 1 || quotedValue.end !== token.end - 1)
          ) {
            continue;
          }
          const startCol = quotedValue?.start ?? valueStart;
          const endCol = quotedValue?.end ?? token.end;
          if (startCol >= endCol) continue;

          results.push({
            path: directive.path,
            sheetName,
            line: lineNumber,
            startCol,
            endCol,
          });
        }
      }
    }

    offset = lineEnd + 1;
  }

  return results;
}

/** Apply the extension-availability policy used by the document-link provider. */
export function findAvailableEmbedSheetRanges(
  text: string,
  tableViewerAvailable: boolean,
): EmbedSheetRange[] {
  return tableViewerAvailable ? findEmbedSheetRanges(text) : [];
}

/** Build a command URI whose payload is exactly one open-at-sheet argument. */
export function buildOpenWorksheetCommandUri(uri: string, sheetName: string): string {
  const args = [{ uri, sheetName }];
  return 'command:tableViewer.openWorkbookAtSheet?' + encodeURIComponent(JSON.stringify(args));
}

/** Build the filepath link target, using the directive's effective worksheet when possible. */
export function buildEmbedPathTargetUri(
  workbookUri: string,
  embedPath: string,
  effectiveSheet: string | undefined,
  tableViewerAvailable: boolean,
): string {
  return tableViewerAvailable && effectiveSheet && /\.xlsx$/i.test(embedPath)
    ? buildOpenWorksheetCommandUri(workbookUri, effectiveSheet)
    : workbookUri;
}
