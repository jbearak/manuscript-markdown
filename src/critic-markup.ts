import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { type CodeRegion, computeMarkdownRegions, isInsideCodeRegion, mergeRegions } from './code-regions';
import { computeDollarMathRegions, isEscapedAt } from './math-delimiters';
import { type LineEdit, type LineMap, lineCount, linesAfterEdits, sameLines, throughLines } from './line-map';

// Placeholder used to preserve paragraph breaks inside CriticMarkup spans.
// Uses Private Use Area characters to avoid markdown-it's normalize step
// which replaces \u0000 with \uFFFD.
const CRITIC_BREAK_SENTINEL = String.fromCharCode(0xE000);
export const PARA_PLACEHOLDER = CRITIC_BREAK_SENTINEL + 'PARA' + CRITIC_BREAK_SENTINEL;
export const LINE_PLACEHOLDER = CRITIC_BREAK_SENTINEL + 'LINE' + CRITIC_BREAK_SENTINEL;
const CRITIC_BREAK_PLACEHOLDER_RE = new RegExp(CRITIC_BREAK_SENTINEL + '(?:PARA|LINE)' + CRITIC_BREAK_SENTINEL, 'g');

/** End a link linkify finds at a break preprocessCriticMarkup wrote as a
 * placeholder, as at the line end it stands for. Its letters, as any but a
 * space, went on a URL before it, so https://e.com{++a, a line break and
 * b++} took the markup in. Nor is a destination or an autolink with one in
 * it a link's, as with the line end, which none holds, where markdown-it
 * read [a](<u{++x, a line break and y++}>) as a link to a URL with the
 * placeholder in it. A title, which may go over a line end, has the line
 * end back. Preview and Word export must install the same rule. */
export function criticBreaksEndLinks(md: MarkdownIt): void {
  const linkify = md.linkify;
  const spaced = (text: string) => text.includes(CRITIC_BREAK_SENTINEL)
    ? text.replace(CRITIC_BREAK_PLACEHOLDER_RE, placeholder => ' '.repeat(placeholder.length))
    : text;
  const { test, match, matchAtStart } = linkify;
  linkify.test = text => test.call(linkify, spaced(text));
  linkify.match = text => match.call(linkify, spaced(text));
  linkify.matchAtStart = text => matchAtStart.call(linkify, spaced(text));
  // A placeholder, as it is or as normalizeLink encodes it before
  // validateLink reads it, but not the sentinel alone, which a URL may hold
  const placeholderIn = new RegExp([CRITIC_BREAK_SENTINEL, encodeURI(CRITIC_BREAK_SENTINEL)]
    .map(sentinel => sentinel + '(?:PARA|LINE)' + sentinel).join('|'));
  const validateLink = md.validateLink;
  md.validateLink = url => !placeholderIn.test(url) && validateLink.call(md, url);
  const restoreTitles = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      const title = token.type === 'link_open' || token.type === 'image' ? token.attrGet('title') : null;
      if (title) token.attrSet('title', restoreCriticLineBreaks(title));
      if (token.children) restoreTitles(token.children);
    }
  };
  md.core.ruler.after('inline', 'critic_breaks_in_link_titles', state => restoreTitles(state.tokens));
}

/** Put back the line breaks preprocessCriticMarkup wrote as placeholders
 * in CriticMarkup's text in raw inline HTML, as in a comment, z <!-- {++x,
 * a line break and y++} -->, or a tag's attribute, which hold the text as
 * it is, and which kept the placeholders, where Word export hid them in the
 * comment's run and the preview wrote them in its HTML. Preview and Word
 * export must install the same rule. */
export function criticBreaksInRawHtml(md: MarkdownIt): void {
  const restore = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === 'html_inline') token.content = restoreCriticLineBreaks(token.content);
      if (token.children) restore(token.children);
    }
  };
  md.core.ruler.after('inline', 'critic_breaks_in_raw_html', state => restore(state.tokens));
}

export type CriticBreakKind = 'line' | 'paragraph';

interface CriticProtectedBreak {
  kind: CriticBreakKind;
  index: number;
  length: number;
  lineCount: number;
}

interface CriticHeadingPrefix {
  prefix: string;
  marker: string;
  level: number;
}

const ATX_CRITIC_HEADING_RE = /^(#{1,6}) /;

export function matchCriticHeadingPrefix(text: string): CriticHeadingPrefix | undefined {
  const match = ATX_CRITIC_HEADING_RE.exec(text);
  if (!match) return undefined;
  return { prefix: match[0], marker: match[1], level: match[1].length };
}

export function matchCriticBreakAt(content: string, index: number): CriticProtectedBreak | undefined {
  if (content.startsWith(PARA_PLACEHOLDER, index)) {
    return { kind: 'paragraph', index, length: PARA_PLACEHOLDER.length, lineCount: 2 };
  }
  if (content.startsWith(LINE_PLACEHOLDER, index)) {
    return { kind: 'line', index, length: LINE_PLACEHOLDER.length, lineCount: 1 };
  }
  return undefined;
}

function findNextCriticBreak(content: string, from = 0): CriticProtectedBreak | undefined {
  for (let index = content.indexOf(CRITIC_BREAK_SENTINEL, from);
    index !== -1;
    index = content.indexOf(CRITIC_BREAK_SENTINEL, index + 1)) {
    const match = matchCriticBreakAt(content, index);
    if (match) return match;
  }
  return undefined;
}

export function* iterateCriticBreaks(content: string, from = 0): IterableIterator<CriticProtectedBreak> {
  for (let match = findNextCriticBreak(content, from); match;
    match = findNextCriticBreak(content, match.index + match.length)) {
    yield match;
  }
}

export function hasCriticBreak(content: string): boolean {
  return findNextCriticBreak(content) !== undefined;
}

function protectLineBreaks(content: string): string {
  // A visually blank Markdown line may contain indentation or trailing spaces.
  return content
    .replace(/\n[ \t]*\n/g, PARA_PLACEHOLDER)
    .replace(/\n/g, LINE_PLACEHOLDER);
}

export function restoreCriticLineBreaks(content: string): string {
  if (!content.includes(CRITIC_BREAK_SENTINEL)) return content;
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
  const analysis: CriticBlockAnalysis = {
    source: content,
    inertRegions: mergeRegions([...codeRegions, ...htmlRegions]),
  };
  return includeLists ? { ...analysis, listRegions } : analysis;
}

const LEADING_CRITIC_BREAK_RE = /(?:\{\+\+|\{--|\{~~|\{==|\{>>)\n/;

/** The analysis of the Markdown with each opener stranded at a line's end
 *  moved, and the edits that moved them */
function moveLeadingBreakOutsideCritic(analysis: CriticLeadingBreakAnalysis): CriticBlockAnalysis & { edits: LineEdit[] } {
  // When an opener is stranded at the end of a line, start the Critic span in
  // a new paragraph. Authors commonly put the opener at the end of the prior
  // paragraph's last line; a single source newline otherwise remains a soft
  // break and incorrectly pulls that paragraph into the revision.
  const { source: markdown, inertRegions, listRegions } = analysis;
  const mathRegions = computeDollarMathRegions(markdown, inertRegions);
  const closers = criticCloserSearch(markdown);
  const edits: LineEdit[] = [];
  const moved = (offset: number, full: string, text: string) => {
    edits.push({ start: offset, end: offset + full.length, text });
    return text;
  };
  const transformed = markdown.replace(
    /(\{\+\+|\{--|\{~~|\{==|\{>>)(\n(?:[ \t]*(?:>[ \t]*)?\n)?)([ \t]*(?:(?:>[ \t]*)+)?)/g,
    (full, open: string, leadingBreak: string, nextPrefix: string, offset: number) => {
      if (isInsideCodeRegion(offset, inertRegions) || isEscapedAt(markdown, offset) ||
          isInsideCodeRegion(offset, mathRegions) || isInsideCodeRegion(offset, listRegions)) return full;
      const contentStart = offset + open.length;
      const closePos = open === '{>>'
        ? closers.matching(contentStart)
        : closers.next(open === '{++' ? '++}' : open === '{--' ? '--}' : open === '{==' ? '==}' : '~~}', contentStart);
      if (closePos === -1) return full;
      if (open === '{~~') {
        const separatorPos = closers.next('~>', contentStart);
        if (separatorPos === -1 || separatorPos >= closePos) return full;
      }
      // A span of the break alone, as import writes a tracked paragraph
      // mark in a comment's anchor, {=={--x--}{++\n\n++}==}{>>c<<}, which
      // the anchor splits at, or after text in no revision or another, as
      // a{--\n\n--}b, with the markers of the quote it's in, as
      // > a{--\n>\n> --}b: moved out, it would leave the break untracked
      // and the span empty
      if (blankWithoutQuotePrefixes(markdown, contentStart, closePos, quoteDepthAt(markdown, offset))) return full;
      const lineStart = markdown.lastIndexOf('\n', offset - 1) + 1;
      const linePrefix = markdown.slice(lineStart, offset);
      if (linePrefix.trim().length === 0) return full;

      const quoteMatch = linePrefix.match(/^((?:[ \t]{0,3}>[ \t]?)+)/);
      // The break is a line end, or two around a blank line
      const blankLine = leadingBreak !== '\n';

      if (quoteMatch) {
        // The following line must remain in the same quote depth. Put the
        // opener after its quote prefix and synthesize a quoted blank line
        // when the author supplied only a soft line break.
        const quoteDepth = (quoteMatch[1].match(/>/g) ?? []).length;
        const nextQuoteDepth = (nextPrefix.match(/>/g) ?? []).length;
        if (nextQuoteDepth < quoteDepth) return full;
        const paragraphBreak = blankLine
          ? leadingBreak
          : '\n' + quoteMatch[1].trimEnd() + '\n';
        return moved(offset, full, paragraphBreak + nextPrefix + open);
      }

      // Preserve an existing blank line. For a lone newline, add the second
      // newline needed to form a Markdown paragraph boundary.
      const paragraphBreak = blankLine ? leadingBreak : '\n\n';
      return moved(offset, full, paragraphBreak + open + nextPrefix);
    },
  );
  return edits.length > 0 ? { ...computeCriticBlockAnalysis(transformed), edits } : { ...analysis, edits };
}

function quoteDepthAt(content: string, offset: number): number {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
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
  if (depth === 0 || !content.includes('\n')) return content;
  return content.replace(/\n([^\n]*)/g, (_full, line: string) => {
    let remainder = line;
    for (let level = 0; level < depth; level++) {
      const match = remainder.match(/^[ \t]*>[ \t]?/);
      if (!match) return '\n' + line;
      remainder = remainder.slice(match[0].length);
    }
    return '\n' + remainder;
  });
}

const WHITESPACE_RE = /\s/;

/** Whether `text` from `start` to `end`, with `depth` quote markers taken
 *  off each line but its first, as stripQuoteContinuationPrefixes takes
 *  them, is whitespace, as /^\s*$/ reads it. It reads up to the first
 *  character that isn't, without building the text, so the openers at a
 *  line's end in a quote that share one closer, each of which the check
 *  stripped to the closer, read the text once: each stops at the next
 *  opener at the latest. */
function blankWithoutQuotePrefixes(text: string, start: number, end: number, depth: number): boolean {
  const isSpaceOrTab = (at: number) => at < end && (text.charCodeAt(at) === 0x20 || text.charCodeAt(at) === 0x09);
  let i = start;
  while (true) {
    // The rest of the line
    for (; i < end && text.charCodeAt(i) !== 0x0A; i++) {
      if (!WHITESPACE_RE.test(text[i])) return false;
    }
    if (i >= end) return true;
    // The next line, after its markers, or all of it where it has fewer
    i++;
    let after = i;
    for (let level = 0; level < depth; level++) {
      let at = after;
      while (isSpaceOrTab(at)) at++;
      if (at >= end || text.charCodeAt(at) !== 0x3E) { after = i; break; }
      after = isSpaceOrTab(at + 1) ? at + 2 : at + 1;
    }
    i = after;
  }
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

/** The closers of the CriticMarkup in one text, for a scan that looks for
 *  the closer of each opener it meets. A search with indexOf or
 *  findMatchingClose for each read the rest of the text again where none
 *  was, so many openers without a closer took time in their number times
 *  the text's length. Here each closer's offsets are found once, in one
 *  pass, and each search is a binary search of them; each comment's
 *  matching <<} comes from one pass over the comments' openers and closers.
 *  The results are indexOf's and findMatchingClose's. */
export interface CriticCloserSearch {
  readonly src: string;
  /** `src.indexOf(closer, from)` */
  next(closer: string, from: number): number;
  /** `findMatchingClose(src, from)` */
  matching(from: number): number;
}

export function criticCloserSearch(src: string): CriticCloserSearch {
  const offsets = new Map<string, number[]>();
  let matches: Map<number, number> | undefined;
  return {
    src,
    next(closer, from) {
      let at = offsets.get(closer);
      if (!at) {
        at = [];
        for (let k = src.indexOf(closer); k !== -1; k = src.indexOf(closer, k + 1)) at.push(k);
        offsets.set(closer, at);
      }
      // The first at or after `from`
      let lo = 0;
      let hi = at.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (at[mid] < from) lo = mid + 1;
        else hi = mid;
      }
      return lo < at.length ? at[lo] : -1;
    },
    matching(from) {
      matches ??= commentMatches(src);
      return matches.get(from) ?? findMatchingClose(src, from);
    },
  };
}

/** For the end of each comment's opener in `src`, its matching <<}, or -1
 *  for none, from one pass in which each <<} closes the innermost opener
 *  still open. The openers and closers are those findMatchingClose reads,
 *  found the same way, and as none overlaps another, it reads the same ones
 *  from the end of any opener. */
function commentMatches(src: string): Map<number, number> {
  const matches = new Map<number, number>();
  const open: number[] = [];
  let pos = 0;
  let nextClose = src.indexOf('<<}');
  while (true) {
    const opener = findNextCommentOpenerBefore(src, pos, nextClose === -1 ? src.length : nextClose);
    if (opener) {
      pos = opener.index + opener.length;
      open.push(pos);
      matches.set(pos, -1);
      continue;
    }
    if (nextClose === -1) return matches;
    const contentStart = open.pop();
    if (contentStart !== undefined) matches.set(contentStart, nextClose);
    pos = nextClose + 3;
    nextClose = src.indexOf('<<}', pos);
  }
}

const stateSearches = new WeakMap<object, CriticCloserSearch>();

/** The closer search of a markdown-it state's text, made once for the
 *  state, for a rule markdown-it calls at each opener in it */
export function criticCloserSearchOf(state: { src: string }): CriticCloserSearch {
  let search = stateSearches.get(state);
  if (!search || search.src !== state.src) stateSearches.set(state, search = criticCloserSearch(state.src));
  return search;
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
 * paragraphs. Without `moveLeadingBreaks`, a span's opener stranded at a
 * line's end stays there, so each line end of the source is one of the
 * result's or in its placeholders, one in a line's and two in a blank
 * line's, which count the source's lines.
 */
/** The CriticMarkup spans of `source` in one pass from the left: from an
 *  opener not escaped nor in code or an HTML block, to its closer, the first
 *  after it but for a comment's, which is past its replies. */
function* criticSpans(source: string, inertRegions: CodeRegion[]): IterableIterator<{ start: number; contentStart: number; closeIdx: number }> {
  const closers = criticCloserSearch(source);
  let searchFrom = 0;
  while (true) {
    const candidate = findNextCriticOpener(source, searchFrom);
    if (!candidate) return;

    const contentStart = candidate.index + candidate.open.length;
    searchFrom = contentStart;
    if (isInsideCodeRegion(candidate.index, inertRegions) || isEscapedAt(source, candidate.index)) continue;
    const closeIdx = candidate.nested
      ? closers.matching(contentStart)
      : closers.next(candidate.close, contentStart);
    if (closeIdx === -1) continue;
    if (candidate.open === '{~~') {
      const separatorPos = closers.next('~>', contentStart);
      if (separatorPos === -1 || separatorPos >= closeIdx) continue;
    }
    yield { start: candidate.index, contentStart, closeIdx };
    searchFrom = closeIdx + candidate.close.length;
  }
}

/** The payloads of the CriticMarkup spans in `markdown`, as [start, end),
 *  whose line ends preprocessCriticMarkup keeps from markdown-it's block
 *  parse, and with them the indent after each, which a list item's
 *  paragraph's would lose */
export function criticPayloadRanges(markdown: string): Array<[number, number]> {
  if (!/\{(?:\+\+|--|~~|==|>>|#)/.test(markdown)) return [];
  return [...criticSpans(markdown, computeCriticBlockAnalysis(markdown).inertRegions)].map(({ contentStart, closeIdx }) => [contentStart, closeIdx]);
}

/** `markdown` with each CriticMarkup span's line ends in placeholders, so
 *  markdown-it reads the span as one block. Its line ends are \n alone (see
 *  normalizeNewlines in newlines.ts), as each caller gives them. */
export function preprocessCriticMarkup(markdown: string, moveLeadingBreaks = true): string {
  return criticPreprocessed(markdown, moveLeadingBreaks).output;
}

/** The Markdown as preprocessCriticMarkup writes it, and for each of its
 *  lines, and one past the last, the line of `markdown` it comes from (see
 *  line-map.ts): a span's lines, joined, from its first, and those an
 *  opener moved past its line's end starts, from the opener's */
export function preprocessCriticMarkupWithLines(markdown: string, moveLeadingBreaks = true): { output: string; lines: LineMap } {
  const { output, moved, edits } = criticPreprocessed(markdown, moveLeadingBreaks);
  if (!moved) return { output, lines: edits.length > 0 ? linesAfterEdits(markdown, edits) : sameLines(lineCount(markdown)) };
  return { output, lines: throughLines(linesAfterEdits(moved.source, edits), linesAfterEdits(markdown, moved.edits)) };
}

/** The Markdown as preprocessCriticMarkup writes it, from the Markdown with
 *  the openers stranded at a line's end `moved`, where any were, by the
 *  edits of each span's line ends to placeholders */
function criticPreprocessed(markdown: string, moveLeadingBreaks: boolean): { output: string; moved?: { source: string; edits: LineEdit[] }; edits: LineEdit[] } {
  // Fast path: if no CriticMarkup opening markers, return unchanged
  if (!markdown.includes('{++') && !markdown.includes('{--') &&
      !markdown.includes('{~~') && !markdown.includes('{>>') &&
      !markdown.includes('{==') && !markdown.includes('{#')) {
    return { output: markdown, edits: [] };
  }

  const movedAnalysis = moveLeadingBreaks && LEADING_CRITIC_BREAK_RE.test(markdown)
    ? moveLeadingBreakOutsideCritic(computeCriticBlockAnalysis(markdown, true))
    : undefined;
  const analysis = movedAnalysis ?? computeCriticBlockAnalysis(markdown);
  const { source: result, inertRegions } = analysis;
  const moved = movedAnalysis && movedAnalysis.edits.length > 0 ? { source: result, edits: movedAnalysis.edits } : undefined;
  const segments: string[] = [];
  const edits: LineEdit[] = [];
  let lastPos = 0;
  for (const { start, contentStart, closeIdx } of criticSpans(result, inertRegions)) {
    const content = result.slice(contentStart, closeIdx);
    // Single-line spans need no transformation. Besides avoiding needless
    // allocations, this prevents quoteDepthAt from searching backward through
    // an ever-growing single line for every span.
    if (content.includes('\n')) {
      const withoutQuotePrefixes = stripQuoteContinuationPrefixes(content, quoteDepthAt(result, start));
      const protectedContent = protectLineBreaks(withoutQuotePrefixes);
      segments.push(result.slice(lastPos, contentStart));
      segments.push(protectedContent);
      edits.push({ start: contentStart, end: closeIdx, text: protectedContent });
      lastPos = closeIdx;
    }
  }
  if (segments.length > 0) segments.push(result.slice(lastPos));

  return { output: segments.length > 0 ? segments.join('') : result, moved, edits };
}
