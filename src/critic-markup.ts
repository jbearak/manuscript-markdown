import { type CodeRegion, computeMarkdownRegions, isInsideCodeRegion, mergeRegions } from './code-regions';
import { computeDollarMathRegions, isEscapedAt } from './math-delimiters';

// Placeholder used to preserve paragraph breaks inside CriticMarkup spans.
// Uses Private Use Area characters to avoid markdown-it's normalize step
// which replaces \u0000 with \uFFFD.
export const PARA_PLACEHOLDER = '\uE000PARA\uE000';
export const LINE_PLACEHOLDER = '\uE000LINE\uE000';

function protectLineBreaks(content: string): string {
  // A visually blank Markdown line may contain indentation or trailing spaces.
  // Protect CRLF as well because this preprocessor runs before markdown-it's
  // normalize rule converts line endings.
  return content
    .replace(/(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/g, PARA_PLACEHOLDER)
    .replace(/\r\n|\r|\n/g, LINE_PLACEHOLDER);
}

export function restoreCriticLineBreaks(content: string): string {
  return content
    .split(PARA_PLACEHOLDER).join('\n\n')
    .split(LINE_PLACEHOLDER).join('\n');
}

interface CriticBlockAnalysis {
  source: string;
  inertRegions: CodeRegion[];
}

interface CriticLeadingBreakAnalysis extends CriticBlockAnalysis {
  listRegions: CodeRegion[];
}

function computeCriticBlockAnalysis(content: string): CriticBlockAnalysis;
function computeCriticBlockAnalysis(content: string, includeLists: true): CriticLeadingBreakAnalysis;
function computeCriticBlockAnalysis(
  content: string,
  includeLists = false,
): CriticBlockAnalysis | CriticLeadingBreakAnalysis {
  const { codeRegions, htmlRegions, listRegions } = computeMarkdownRegions(content, {
    html: 'all',
    includeLists,
  });
  const inertRegions = mergeRegions([...codeRegions, ...htmlRegions]);
  return includeLists
    ? { source: content, inertRegions, listRegions }
    : { source: content, inertRegions };
}

const LEADING_CRITIC_BREAK_RE = /(?:\{\+\+|\{--|\{~~|\{==|\{>>)(?:\r\n|\r|\n)/;

function moveLeadingBreakOutsideCritic(analysis: CriticLeadingBreakAnalysis): CriticBlockAnalysis {
  // When an opener is stranded at the end of a line, start the Critic span in
  // a new paragraph. Authors commonly put the opener at the end of the prior
  // paragraph's last line; a single source newline otherwise remains a soft
  // break and incorrectly pulls that paragraph into the revision.
  const { source: markdown, inertRegions, listRegions } = analysis;
  const mathRegions = computeDollarMathRegions(markdown, inertRegions);
  let changed = false;
  const transformed = markdown.replace(
    /(\{\+\+|\{--|\{~~|\{==|\{>>)((?:\r\n|\r|\n)(?:[ \t]*(?:>[ \t]*)?(?:\r\n|\r|\n))?)([ \t]*(?:(?:>[ \t]*)+)?)/g,
    (full, open: string, leadingBreak: string, nextPrefix: string, offset: number) => {
      if (isInsideCodeRegion(offset, inertRegions) || isEscapedAt(markdown, offset) ||
          isInsideCodeRegion(offset, mathRegions) || isInsideCodeRegion(offset, listRegions)) return full;
      const contentStart = offset + open.length;
      const closePos = open === '{>>'
        ? findMatchingClose(markdown, contentStart)
        : markdown.indexOf(open === '{++' ? '++}' : open === '{--' ? '--}' : open === '{==' ? '==}' : '~~}', contentStart);
      if (closePos === -1) return full;
      if (open === '{~~') {
        const separatorPos = markdown.indexOf('~>', contentStart);
        if (separatorPos === -1 || separatorPos >= closePos) return full;
      }
      const lineStart = Math.max(
        markdown.lastIndexOf('\n', offset - 1),
        markdown.lastIndexOf('\r', offset - 1),
      ) + 1;
      const linePrefix = markdown.slice(lineStart, offset);
      if (linePrefix.trim().length === 0) return full;

      const quoteMatch = linePrefix.match(/^((?:[ \t]{0,3}>[ \t]?)+)/);
      const lineEndings = leadingBreak.match(/\r\n|\r|\n/g) ?? [];
      const eol = lineEndings[0] ?? '\n';

      if (quoteMatch) {
        // The following line must remain in the same quote depth. Put the
        // opener after its quote prefix and synthesize a quoted blank line
        // when the author supplied only a soft line break.
        const quoteDepth = (quoteMatch[1].match(/>/g) ?? []).length;
        const nextQuoteDepth = (nextPrefix.match(/>/g) ?? []).length;
        if (nextQuoteDepth < quoteDepth) return full;
        const paragraphBreak = lineEndings.length > 1
          ? leadingBreak
          : eol + quoteMatch[1].trimEnd() + eol;
        changed = true;
        return paragraphBreak + nextPrefix + open;
      }

      // Preserve an existing blank line. For a lone newline, add the second
      // newline needed to form a Markdown paragraph boundary.
      const paragraphBreak = lineEndings.length > 1 ? leadingBreak : eol + eol;
      changed = true;
      return paragraphBreak + open + nextPrefix;
    },
  );
  return changed ? computeCriticBlockAnalysis(transformed) : analysis;
}

function quoteDepthAt(content: string, offset: number): number {
  const lineStart = Math.max(content.lastIndexOf('\n', offset - 1), content.lastIndexOf('\r', offset - 1)) + 1;
  let prefix = content.slice(lineStart, offset);
  let depth = 0;
  while (true) {
    // Code blocks have already been excluded, so leading whitespace here can
    // be list-container indentation before the first blockquote marker.
    const match = prefix.match(/^[ \t]*>[ \t]?/);
    if (!match) return depth;
    depth++;
    prefix = prefix.slice(match[0].length);
  }
}

function stripQuoteContinuationPrefixes(content: string, depth: number): string {
  if (depth === 0 || !/[\r\n]/.test(content)) return content;
  return content.replace(/(\r\n|\r|\n)([^\r\n]*)/g, (_full, eol: string, line: string) => {
    let remainder = line;
    for (let level = 0; level < depth; level++) {
      const match = remainder.match(/^[ \t]*>[ \t]?/);
      if (!match) return eol + line;
      remainder = remainder.slice(match[0].length);
    }
    return eol + remainder;
  });
}

/**
 * Find the matching close marker for `<<}` accounting for nested `{>>...<<}` pairs.
 * Returns the index of the matching `<<}` or -1 if not found.
 */
export function findMatchingClose(src: string, startPos: number): number {
  let depth = 1;
  let pos = startPos;
  while (pos < src.length && depth > 0) {
    const nextClose = src.indexOf('<<}', pos);
    if (nextClose === -1) break;
    // Only an opener before this close can affect its nesting depth. Bounding
    // the scan here prevents every sequential comment from searching the
    // entire remaining document for an absent opener variant.
    const nextOpen = findNextCommentOpenerBefore(src, pos, nextClose);
    if (nextOpen) {
      depth++;
      pos = nextOpen.index + nextOpen.length;
    } else {
      depth--;
      if (depth === 0) return nextClose;
      pos = nextClose + 3;
    }
  }
  return -1;
}

function findNextCommentOpenerBefore(
  src: string,
  pos: number,
  endExclusive: number,
): { index: number; length: number } | undefined {
  for (let i = pos; i < endExclusive - 2; i++) {
    if (src.charCodeAt(i) !== 0x7B) continue; // {
    if (src.charCodeAt(i + 1) === 0x3E && src.charCodeAt(i + 2) === 0x3E) {
      return { index: i, length: 3 };
    }
    if (src.charCodeAt(i + 1) !== 0x23) continue; // #
    let end = i + 2;
    while (end < endExclusive) {
      const char = src.charCodeAt(end);
      if ((char >= 0x30 && char <= 0x39) || (char >= 0x41 && char <= 0x5A) ||
          (char >= 0x61 && char <= 0x7A) || char === 0x5F || char === 0x2D) {
        end++;
      } else {
        break;
      }
    }
    if (end > i + 2 && end + 1 < endExclusive &&
        src.charCodeAt(end) === 0x3E && src.charCodeAt(end + 1) === 0x3E) {
      return { index: i, length: end + 2 - i };
    }
  }
  return undefined;
}

interface CriticOpener {
  index: number;
  open: string;
  close: string;
  nested?: boolean;
}

/**
 * Find the next CriticMarkup opener in one forward scan. Keeping this as a
 * single scanner is important: independently searching for every marker type
 * makes a document containing many instances of only one type quadratic,
 * because every absent type rescans the entire remaining suffix each time.
 */
function findNextCriticOpener(src: string, pos: number): CriticOpener | undefined {
  for (let i = pos; i < src.length - 2; i++) {
    if (src.charCodeAt(i) !== 0x7B) continue; // {
    const markerChar = src.charCodeAt(i + 1);
    if (src.charCodeAt(i + 2) === markerChar) {
      if (markerChar === 0x2B) return { index: i, open: '{++', close: '++}' };
      if (markerChar === 0x2D) return { index: i, open: '{--', close: '--}' };
      if (markerChar === 0x7E) return { index: i, open: '{~~', close: '~~}' };
      if (markerChar === 0x3D) return { index: i, open: '{==', close: '==}' };
      if (markerChar === 0x3E) return { index: i, open: '{>>', close: '<<}', nested: true };
    }
    if (markerChar !== 0x23) continue; // #

    let end = i + 2;
    while (end < src.length) {
      const char = src.charCodeAt(end);
      if ((char >= 0x30 && char <= 0x39) || (char >= 0x41 && char <= 0x5A) ||
          (char >= 0x61 && char <= 0x7A) || char === 0x5F || char === 0x2D) {
        end++;
      } else {
        break;
      }
    }
    if (end > i + 2 && src.charCodeAt(end) === 0x3E && src.charCodeAt(end + 1) === 0x3E) {
      return { index: i, open: src.slice(i, end + 2), close: '<<}', nested: true };
    }
  }
  return undefined;
}

/**
 * Preprocess markdown source: replace \n\n inside CriticMarkup spans with a
 * placeholder so markdown-it's block parser doesn't split them into separate
 * paragraphs.
 */
export function preprocessCriticMarkup(markdown: string): string {
  // Fast path: if no CriticMarkup opening markers, return unchanged
  if (!markdown.includes('{++') && !markdown.includes('{--') &&
      !markdown.includes('{~~') && !markdown.includes('{>>') &&
      !markdown.includes('{==') && !markdown.includes('{#')) {
    return markdown;
  }

  const analysis = LEADING_CRITIC_BREAK_RE.test(markdown)
    ? moveLeadingBreakOutsideCritic(computeCriticBlockAnalysis(markdown, true))
    : computeCriticBlockAnalysis(markdown);
  const { source: result, inertRegions } = analysis;
  const segments: string[] = [];
  let lastPos = 0;
  let searchFrom = 0;
  while (true) {
    const candidate = findNextCriticOpener(result, searchFrom);
    if (!candidate) break;

    const contentStart = candidate.index + candidate.open.length;
    if (isInsideCodeRegion(candidate.index, inertRegions) || isEscapedAt(result, candidate.index)) {
      searchFrom = contentStart;
      continue;
    }
    const closeIdx = candidate.nested
      ? findMatchingClose(result, contentStart)
      : result.indexOf(candidate.close, contentStart);
    if (closeIdx === -1) {
      searchFrom = contentStart;
      continue;
    }
    if (candidate.open === '{~~') {
      const separatorPos = result.indexOf('~>', contentStart);
      if (separatorPos === -1 || separatorPos >= closeIdx) {
        searchFrom = contentStart;
        continue;
      }
    }

    const content = result.slice(contentStart, closeIdx);
    // Single-line spans need no transformation. Besides avoiding needless
    // allocations, this prevents quoteDepthAt from searching backward through
    // an ever-growing single line for every span.
    if (/[\r\n]/.test(content)) {
      const withoutQuotePrefixes = stripQuoteContinuationPrefixes(content, quoteDepthAt(result, candidate.index));
      const protectedContent = protectLineBreaks(withoutQuotePrefixes);
      segments.push(result.slice(lastPos, contentStart));
      segments.push(protectedContent);
      lastPos = closeIdx;
    }
    searchFrom = closeIdx + candidate.close.length;
  }
  if (segments.length > 0) segments.push(result.slice(lastPos));

  return segments.length > 0 ? segments.join('') : result;
}
