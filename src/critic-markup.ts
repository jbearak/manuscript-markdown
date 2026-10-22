import type MarkdownIt from 'markdown-it';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import { type CodeRegion, computeMarkdownRegions, isInsideCodeRegion, mergeRegions } from './code-regions';
import { computeDollarMathRegions, DOCX_DOLLAR_MATH_OPTIONS, findDollarMathAt, isEscapedAt } from './math-delimiters';
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

/** Put back the line breaks preprocessCriticMarkup wrote as placeholders
 * that no rule read, which a span's would have, as where it joined the
 * paragraphs around an opener markdown-it read in raw HTML, as in
 * z <!-- $ {++ --> a, a blank line and b ++}, and where Word export wrote
 * the placeholder in Word's text and the preview in its HTML, and in a
 * quote, > <b t="a {==, a blank line and x==}">, whose joined lines are an
 * HTML block: a text token's as a softbreak, two for a blank line, as a
 * placeholder at a token's start is read (see paraPlaceholderRule), a code
 * span's as spaces, as markdown-it reads its line ends, and another
 * token's, as an equation's or an HTML block's, as the line ends. Preview
 * and Word export must install the same rule, last. */
export function criticBreaksLeftOver(md: MarkdownIt): void {
  const restore = (state: StateCore, tokens: Token[]): Token[] => {
    let restored: Token[] | undefined;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.children) token.children = restore(state, token.children);
      const breaks = token.content.includes(CRITIC_BREAK_SENTINEL) ? [...iterateCriticBreaks(token.content)] : [];
      if (breaks.length > 0 && token.type !== 'text') {
        token.content = token.type === 'code_inline'
          ? token.content.replace(CRITIC_BREAK_PLACEHOLDER_RE, ' ')
          : restoreCriticLineBreaks(token.content);
      }
      if (breaks.length === 0 || token.type !== 'text') {
        restored?.push(token);
        continue;
      }
      restored ??= tokens.slice(0, index);
      const content = token.content;
      const push = (type: string, text: string) => {
        const piece = new state.Token(type, type === 'softbreak' ? 'br' : '', 0);
        piece.level = token.level;
        piece.content = text;
        restored!.push(piece);
      };
      let last = 0;
      for (const found of breaks) {
        if (found.index > last) {
          if (last === 0) {
            token.content = content.slice(0, found.index);
            restored.push(token);
          } else {
            push('text', content.slice(last, found.index));
          }
        }
        for (let line = 0; line < found.lineCount; line++) push('softbreak', '');
        last = found.index + found.length;
      }
      if (last < content.length) push('text', content.slice(last));
    }
    return restored ?? tokens;
  };
  md.core.ruler.push('critic_breaks_left_over', state => {
    for (const token of state.tokens) {
      if (token.children) token.children = restore(state, token.children);
      else if (token.content.includes(CRITIC_BREAK_SENTINEL)) token.content = restoreCriticLineBreaks(token.content);
    }
  });
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
  // A span over a line end can't start in a pipe table, whose cells
  // markdown-it reads on their row's line alone, so its opener is text
  // there (see isInTableCell). Joining the lines took the rows out of the
  // table, as | a {++ | b |, its delimiter row and | {++c++} | d |, all
  // one paragraph. A span from before the table, or from the start of its
  // first line, to a closer in it still takes the lines, which the table
  // is then text in, as a comment's sample of a table is. One region for
  // each table, as two can touch, as a table and one in a quote after it,
  // but for one in math (see tablesOutsideMath)
  tableRegions: CodeRegion[];
  // The raw HTML in a paragraph's or a heading's text, as z <!-- {++ -->,
  // where an opener is text, as markdown-it reads the HTML first, but whose
  // code and equations the inert regions' readers read as text's
  inlineHtmlRegions: CodeRegion[];
  // The lines of each paragraph's, heading's and table row's text, which
  // markdown-it's inline parse reads on its own (see equationsAtOpeners)
  inlineBlocks: CodeRegion[];
}

/** `tableRegions` but for those a dollar math span with a line end
 *  reaches, as in $$, then x {++a | b, --- | --- and c | d++}, then $$:
 *  the block parse, which reads no math, reads a table there, where export
 *  and the preview read the math, its lines joined with the span's. The
 *  spans are those moveLeadingBreakOutsideCritic leaves alone, and those
 *  read with the dollars in code and HTML too, as a closing $$ indented
 *  four spaces after the table, which the block parse reads as code, is
 *  the math's for export. Each is read with the display delimiters of two
 *  dollars alone, and with those export reads too (see
 *  DOCX_DOLLAR_MATH_OPTIONS), as $$, a table's lines and $$$. Any of them
 *  takes the table out, so the rule reads no more tables than with one
 *  alone. A bare LaTeX environment is in one, as preprocessing wraps it in
 *  $$ first */
function tablesOutsideMath(source: string, tableRegions: CodeRegion[], inertRegions: CodeRegion[]): CodeRegion[] {
  if (tableRegions.length === 0) return tableRegions;
  const overLines: CodeRegion[] = [];
  for (const excluded of [inertRegions, undefined]) {
    for (const options of [{}, DOCX_DOLLAR_MATH_OPTIONS]) {
      for (const span of spansOverLines(source, computeDollarMathRegions(source, excluded, options))) overLines.push(span);
    }
  }
  overLines.sort((a, b) => a.start - b.start);
  if (overLines.length === 0) return tableRegions;
  // The last end of the spans before the next, which may reach past it
  let next = 0;
  let reach = -1;
  return tableRegions.filter(table => {
    while (next < overLines.length && overLines[next].start < table.end) reach = Math.max(reach, overLines[next++].end);
    return reach <= table.start;
  });
}

/** `regions` but for those with a dollar sign before them and another
 *  after them, anywhere in `source`, but for escaped ones, which open and
 *  close no equation. Export reads CriticMarkup in an equation as the
 *  equation's change and no HTML there, as in $x <y z={++w >, a blank line
 *  and v++}$, and an equation can reach a block from another over the
 *  blocks CriticMarkup spans join, or open where a read of the math pairs
 *  the dollar sign with another, as one in a comment before it. So any
 *  region an equation could hold is left as on main. A region holds no
 *  dollar sign (see constructEndsAt in code-regions.ts), so an equation
 *  that holds any of it holds all of it, from before it to after it */
function outsideDollars(source: string, regions: CodeRegion[]): CodeRegion[] {
  if (regions.length === 0) return regions;
  let first = source.indexOf('$');
  while (first !== -1 && isEscapedAt(source, first)) first = source.indexOf('$', first + 1);
  if (first === -1) return regions;
  let last = source.lastIndexOf('$');
  while (isEscapedAt(source, last)) last = source.lastIndexOf('$', last - 1);
  return regions.filter(region => first >= region.end || last < region.start);
}

/** The spans of `spans`, in order, with a line end, read from the end of
 *  the line of the last, which a later one on that line reads again */
function spansOverLines(source: string, spans: CodeRegion[]): CodeRegion[] {
  const overLines: CodeRegion[] = [];
  let lineEnd = -1;
  for (const span of spans) {
    if (lineEnd < span.start) {
      lineEnd = span.start;
      while (lineEnd < source.length && source.charCodeAt(lineEnd) !== 0x0A && source.charCodeAt(lineEnd) !== 0x0D) lineEnd++;
    }
    if (lineEnd < span.end) overLines.push(span);
  }
  return overLines;
}

/** The region of `regions`, sorted and apart, that holds `offset` */
function regionAt(offset: number, regions: readonly CodeRegion[]): CodeRegion | undefined {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (offset < regions[mid].start) hi = mid - 1;
    else if (offset >= regions[mid].end) lo = mid + 1;
    else return regions[mid];
  }
  return undefined;
}

/** Whether an opener at `offset` is in a pipe table's cell (see
 *  tableRegions): in a table, but for at the start of its first line's
 *  text, past the indent and quote markers, where a span opens before the
 *  cells, over the table's lines, as import writes a Word comment in ID
 *  syntax whose text looks like a table, {#1>>a | b, --- | --- and c | d<<},
 *  and as moveLeadingBreakOutsideCritic moves an opener from the end of
 *  the line before, as in Before.{>>. Nor is it in one where a span before
 *  it whose lines preprocessing joins ends at or past the table's start,
 *  `joinedEnd`: a line of the table is then in a paragraph's line, which
 *  leaves its rows a paragraph's lines */
function isInTableCell(source: string, offset: number, tableRegions: readonly CodeRegion[], joinedEnd = -1): boolean {
  const region = regionAt(offset, tableRegions);
  if (!region || joinedEnd >= region.start) return false;
  let textStart = region.start;
  while (textStart < offset && (source[textStart] === ' ' || source[textStart] === '\t' || source[textStart] === '>')) textStart++;
  return offset !== textStart;
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
  const { codeRegions, htmlRegions, listRegions, tableRegions, inlineHtmlRegions, inlineBlocks } = computeMarkdownRegions(content, {
    html: 'all',
    includeLists,
    includeTables: true,
    inlineHtml: true,
    inlineBlocks: true,
  });
  const inertRegions = mergeRegions([...codeRegions, ...htmlRegions]);
  const analysis: CriticBlockAnalysis = {
    source: content,
    inertRegions,
    tableRegions: tablesOutsideMath(content, tableRegions, inertRegions),
    inlineHtmlRegions: outsideDollars(content, inlineHtmlRegions),
    inlineBlocks,
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
  const { source: markdown, inertRegions, listRegions, tableRegions, inlineHtmlRegions } = analysis;
  const mathRegions = computeDollarMathRegions(markdown, inertRegions);
  const closers = criticCloserSearch(markdown);
  const edits: LineEdit[] = [];
  const moved = (offset: number, full: string, text: string) => {
    edits.push({ start: offset, end: offset + full.length, text });
    return text;
  };
  // An opener in a table's cell stays, as it starts no span (see
  // isInTableCell), read with the spans before it whose lines preprocessing
  // joins, found once, where an opener is in a table, and the end of the
  // last before the opener read
  let joined: ReturnType<typeof joinedSpans> | undefined;
  let next = 0;
  let joinedEnd = -1;
  const inTableCell = (offset: number): boolean => {
    if (!isInTableCell(markdown, offset, tableRegions)) return false;
    joined ??= joinedSpans(analysis);
    while (next < joined.length && joined[next].start < offset) joinedEnd = joined[next++].closeIdx;
    return isInTableCell(markdown, offset, tableRegions, joinedEnd);
  };
  const transformed = markdown.replace(
    /(\{\+\+|\{--|\{~~|\{==|\{>>)(\n(?:[ \t]*(?:>[ \t]*)?\n)?)([ \t]*(?:(?:>[ \t]*)+)?)/g,
    (full, open: string, leadingBreak: string, nextPrefix: string, offset: number) => {
      if (isInsideCodeRegion(offset, inertRegions) || isInsideCodeRegion(offset, inlineHtmlRegions) || isEscapedAt(markdown, offset) ||
          isInsideCodeRegion(offset, mathRegions) || isInsideCodeRegion(offset, listRegions)) return full;
      const contentStart = offset + open.length;
      const closePos = open === '{>>'
        ? closers.matching(contentStart)
        : closers.next(open === '{++' ? '++}' : open === '{--' ? '--}' : open === '{==' ? '==}' : '~~}', contentStart);
      if (closePos === -1 || inTableCell(offset)) return full;
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

/** A comment's text as the preview's tooltip shows it. Where it holds its
 *  replies, as {>>note {>>reply<<}<<}, which export reads as Word's replies
 *  (extractReplies in md-to-docx.ts), that's its own text and then each
 *  reply's on a line of its own, as the tooltip shows a comment and the
 *  replies after it, {>>note<<}{>>reply<<}. A reply's text is all that's
 *  in it, a {>>...<<} in it too, as export writes it. Its closers are
 *  paired in one pass, as the preview calls this for each comment of a
 *  nest of them */
export function commentTooltipText(content: string): string {
  const first = content.indexOf('{>>');
  if (first === -1) return content;
  const closers = criticCloserSearch(content);
  const lines = [content.slice(0, first).trimEnd()];
  for (let open = first; open !== -1; open = content.indexOf('{>>', open)) {
    const close = closers.matching(open + 3);
    if (close === -1) break;
    lines.push(content.slice(open + 3, close));
    open = close + 3;
  }
  return lines.join('\n');
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
/** The CriticMarkup spans of `analysis`'s source in one pass from the left:
 *  from an opener not escaped nor in code, an HTML block or raw HTML in a
 *  paragraph's text (see inlineHtmlRegions), to its closer,
 *  the first after it but for a comment's, which is past its replies. An
 *  opener in a table's cell pairs only with a closer on its line (see
 *  isInTableCell). A span with a line end, whose lines preprocessing joins,
 *  takes the tables it reaches out of their rows, so the openers after it
 *  are read with the end of the last. An opener in an equation pairs only
 *  with a closer in it (see equationsAtOpeners). */
function* criticSpans(analysis: CriticBlockAnalysis): IterableIterator<{ start: number; contentStart: number; closeIdx: number }> {
  const { source, inertRegions, tableRegions, inlineHtmlRegions } = analysis;
  const closers = criticCloserSearch(source);
  const equations = equationsAtOpeners(analysis);
  let searchFrom = 0;
  // The end of the line of the last opener read, and of the last span
  // with a line end
  let lineEnd = -1;
  let joinedEnd = -1;
  while (true) {
    const candidate = findNextCriticOpener(source, searchFrom);
    if (!candidate) return;

    const contentStart = candidate.index + candidate.open.length;
    searchFrom = contentStart;
    if (isInsideCodeRegion(candidate.index, inertRegions) || isInsideCodeRegion(candidate.index, inlineHtmlRegions)
      || isEscapedAt(source, candidate.index)) continue;
    const equation = equations.at(candidate.index);
    const closeIdx = candidate.nested
      ? closers.matching(contentStart)
      : closers.next(candidate.close, contentStart);
    if (closeIdx === -1) continue;
    if (equation && closeIdx + candidate.close.length > equation.end) continue;
    if (candidate.open === '{~~') {
      const separatorPos = closers.next('~>', contentStart);
      if (separatorPos === -1 || separatorPos >= closeIdx) continue;
    }
    if (lineEnd < contentStart) {
      lineEnd = contentStart;
      while (lineEnd < source.length && source.charCodeAt(lineEnd) !== 0x0A && source.charCodeAt(lineEnd) !== 0x0D) lineEnd++;
    }
    const overLines = closeIdx > lineEnd;
    if (overLines && isInTableCell(source, candidate.index, tableRegions, joinedEnd)) continue;
    yield { start: candidate.index, contentStart, closeIdx };
    if (overLines) joinedEnd = closeIdx;
    searchFrom = closeIdx + candidate.close.length;
    equations.past(searchFrom);
  }
}

/** The equation export's inline parse reads an opener in (see mathRule in
 *  md-to-docx.ts), for the openers of criticSpans in order. The dollar math
 *  pairs a dollar sign with the next over any line end, as preprocessing's
 *  placeholders, so an opener in an equation, as in $x^{++}$, paired with
 *  a closer past it, in the next paragraph's text or its equation, joined
 *  the paragraphs, and the equation, which ends first, kept the placeholder,
 *  which went into Word's text. So such an opener starts no span. A span in
 *  an equation, as $a{++b++}$, is the equation's change, and joins its
 *  lines, which the equation holds.
 *  The equations are read only where this reads them as markdown-it does,
 *  and an opener is read as in none elsewhere, as before: an equation
 *  counts only if the text before it from its paragraph's start, or a
 *  heading's or a table row's, holds no construct markdown-it may read
 *  first, whose text may hold a dollar sign (see UNMODELED), nor a dollar
 *  sign that opens one past the paragraph's end, and if it ends in that
 *  paragraph. Then markdown-it reads each dollar sign there as
 *  findDollarMathAt does, and the equation, whatever it holds. A paragraph
 *  that starts in a span before is that span's paragraph's, whose text
 *  holds its {. */
function equationsAtOpeners({ source, inlineBlocks }: CriticBlockAnalysis): {
  at(offset: number): { start: number; end: number } | undefined;
  past(offset: number): void;
} {
  // The next paragraph to read, the end of the last, where it's read to,
  // or -1 past a construct, the first dollar sign and construct from there,
  // or the source's end, and the last equation read
  let next = 0;
  let paragraphEnd = -1;
  let from = -1;
  let dollar = -1;
  let construct = -1;
  let equation: { start: number; end: number } | undefined;
  return {
    at(offset) {
      while (next < inlineBlocks.length && inlineBlocks[next].start <= offset) {
        from = inlineBlocks[next].start;
        paragraphEnd = inlineBlocks[next++].end;
        equation = undefined;
      }
      if (equation && equation.end > offset) return equation;
      equation = undefined;
      while (from !== -1 && from < offset) {
        if (dollar < from) {
          dollar = source.indexOf('$', from);
          if (dollar === -1) dollar = source.length;
        }
        if (construct < from) {
          UNMODELED.lastIndex = from;
          construct = UNMODELED.exec(source)?.index ?? source.length;
        }
        const to = Math.min(dollar, offset);
        if (construct < to) {
          from = -1;
          break;
        }
        if (to === offset) {
          from = offset;
          break;
        }
        const match = findDollarMathAt(source, to, DOCX_DOLLAR_MATH_OPTIONS);
        if (match?.kind !== 'math') {
          from = to + 1;
        } else if (match.end > paragraphEnd) {
          // A span after may join the paragraphs to its end
          from = -1;
          break;
        } else {
          from = match.end;
          if (match.end > offset) return equation = match;
        }
      }
      return undefined;
    },
    // After a span, whose lines it joins, so a paragraph that starts in it
    // is its paragraph's
    past(offset) {
      while (next < inlineBlocks.length && inlineBlocks[next].start < offset) paragraphEnd = inlineBlocks[next++].end;
    },
  };
}

/** What markdown-it may read before the math rule reads a dollar sign in it
 *  or after it: a link, an image or a citation's bracket, a footnote's, a
 *  tag, a comment or an autolink, a highlight, a code span, an escape, a
 *  URL, an email, CriticMarkup, and a table's cell, which is read on its
 *  own. And a quote, whose lines without a > export reads as a paragraph
 *  of their own (see deLazifyBlockquotesWithLines in block-preprocess.ts),
 *  where the parse that reads the paragraphs here reads them as the
 *  quote's. */
const UNMODELED = /[[\]<>`\\@{}!|]|==|:\/\/|mailto:|www\./gi;

/** The spans of criticSpans whose lines preprocessing joins, those with a
 *  line end, in order */
function joinedSpans(analysis: CriticBlockAnalysis): Array<{ start: number; contentStart: number; closeIdx: number }> {
  return [...criticSpans(analysis)].filter(({ contentStart, closeIdx }) => /[\r\n]/.test(analysis.source.slice(contentStart, closeIdx)));
}

/** The payloads of the CriticMarkup spans in `markdown`, as [start, end),
 *  whose line ends preprocessCriticMarkup keeps from markdown-it's block
 *  parse, and with them the indent after each, which a list item's
 *  paragraph's would lose */
export function criticPayloadRanges(markdown: string): Array<[number, number]> {
  if (!/\{(?:\+\+|--|~~|==|>>|#)/.test(markdown)) return [];
  return [...criticSpans(computeCriticBlockAnalysis(markdown))].map(({ contentStart, closeIdx }) => [contentStart, closeIdx]);
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
  const { source: result } = analysis;
  const moved = movedAnalysis && movedAnalysis.edits.length > 0 ? { source: result, edits: movedAnalysis.edits } : undefined;
  const segments: string[] = [];
  const edits: LineEdit[] = [];
  let lastPos = 0;
  for (const { start, contentStart, closeIdx } of criticSpans(analysis)) {
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
