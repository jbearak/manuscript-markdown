// Export's block preprocessing, which turns the Markdown into what
// markdown-it reads (see parseMd in md-to-docx.ts), and which the
// orientation scan reads it after too, so the two read the same blocks: grid
// tables as placeholders, quotes ended before a line without a >, and bare
// LaTeX environments as display math. Each step keeps the line of the
// Markdown each line it writes comes from, so that the scan can say where a
// block it finds is.

import { computeMarkdownRegions, isInsideCodeRegion, isQuoteLine, keepsLazyLine, QUOTE_START, type MarkdownRegions } from './code-regions';
import { preprocessGridTablesWithSourceMap } from './grid-table-preprocess';
import { wrapBareLatexEnvironmentsWithLines, type ContainerOptions, type LineSpan } from './latex-env-preprocess';

export interface PreprocessedBlocks {
  /** After grid tables and quotes, before LaTeX environments are wrapped */
  deLazified: string;
  /** How the wrap read the quotes and list items of `deLazified`: the lines
   *  of each paragraph that had a lazy line before, whose environments stay
   *  as written, and whether it is a note's body (see ContainerOptions) */
  containers: ContainerOptions;
  output: string;
  /** For each line of `output`, the line of the Markdown it comes from */
  lines: number[];
}

/** The Markdown as markdown-it reads it, before CriticMarkup is
 *  preprocessed, where it is a note's body `inNote` */
export function preprocessBlocks(markdown: string, inNote = false): PreprocessedBlocks {
  const grid = preprocessGridTablesWithSourceMap(markdown);
  const quotes = deLazifyBlockquotesWithLines(grid.output);
  const containers: ContainerOptions = { lazy: inNote ? [] : endedParagraphs(grid.output, quotes).after, inNote };
  const latex = wrapBareLatexEnvironmentsWithLines(quotes.output, containers);
  return { deLazified: quotes.output, containers, output: latex.output, lines: latex.lines.map(line => grid.lines[quotes.lines[line]]) };
}

/** The lines of `markdown` in each paragraph of a quote or a list item, with
 *  a bare environment, whose quote export ends inside it (see
 *  endedParagraphs), where VS Code's preview wraps the text as written: the
 *  environments it leaves as written, as export does */
export function paragraphsExportEnds(markdown: string): LineSpan[] {
  if (!markdown.includes('\\begin{')) return [];
  return endedParagraphs(markdown, deLazifyBlockquotesWithLines(markdown)).before;
}

/**
 * Each paragraph in a quote or a list item, with a bare environment, whose
 * quote export ends inside it, putting a blank line before a line of it
 * (see deLazifyBlockquotesWithLines), or that has a lazy line: by its lines
 * in `markdown`, `before`, and after, of `quotes`, the Markdown with the
 * quotes ended, and for each of its lines, the line it comes from.
 *
 * VS Code's preview reads such a paragraph as written, as one, and export
 * reads its pieces in quotes of their own, or ends a quote before a line
 * the preview reads in it, as one four spaces into a list item after the
 * item's quote, which isQuoteLine takes for no quote's. Their environments
 * stay as written in both (see decideContainers in latex-env-preprocess.ts).
 */
function endedParagraphs(markdown: string, quotes: { output: string; lines: number[] }): { before: LineSpan[]; after: LineSpan[] } {
  if (quotes.output === markdown || !markdown.includes('\\begin{')) return { before: [], after: [] };
  const { containedParagraphs } = computeMarkdownRegions(markdown, { inlineCode: false, html: 'all', containedParagraphs: true });
  if (containedParagraphs.length === 0) return { before: [], after: [] };
  // The lines of the Markdown a blank line went in before, in order
  const ended: number[] = [];
  for (let i = 0; i + 1 < quotes.lines.length; i++) if (quotes.lines[i] === quotes.lines[i + 1]) ended.push(quotes.lines[i]);
  const lineStarts = [0];
  for (let i = markdown.indexOf('\n'); i !== -1; i = markdown.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  // The first of a sorted list at or past a value
  const firstFrom = (list: number[], value: number) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const before: LineSpan[] = [];
  const after: LineSpan[] = [];
  for (const paragraph of containedParagraphs) {
    const first = firstFrom(lineStarts, paragraph.start + 1) - 1;
    const last = firstFrom(lineStarts, paragraph.end) - 1;
    // A blank line before a line of it but its first
    const at = firstFrom(ended, first + 1);
    if (!paragraph.lazy && !(at < ended.length && ended[at] <= last)) continue;
    before.push({ first, last });
    // Its lines after, which come from those
    const from = firstFrom(quotes.lines, first);
    const to = firstFrom(quotes.lines, last + 1) - 1;
    if (from <= to) after.push({ first: from, last: to });
  }
  return { before, after };
}

/** A line that may be a quote's (see isQuoteLine), before a line with text
 *  that starts as none at the top level does, which lazy continuation can
 *  make the quote's: each place deLazifyBlockquotesWithLines may end one.
 *  Its line ends at a \n, as each line end is here (see normalizeNewlines
 *  in newlines.ts) */
const LAZY_LINE_RE = new RegExp('^' + QUOTE_START + '[^\\n]*\\n(?! {0,3}>)[^\\S\\n]*\\S', 'm');

/**
 * Preserve explicit source semantics for blockquotes by disabling
 * markdown-it lazy continuation behavior (where a non-`>` line can be
 * absorbed into a preceding blockquote paragraph). For roundtrip fidelity
 * we treat a missing `>` as a hard blockquote boundary, but after a quote's
 * line that ends in a line break, where the line goes on after the break,
 * which Word shows in the quote too (see keepsLazyLine).
 *
 * Invariant: de-lazification must not inject blank lines inside a code
 * block or an HTML block, or the block's text changes, and a blank line
 * ends a <div> or the like. Their lines are markdown-it's, at any depth: a
 * line in one that starts with a > or a fence is its text, which neither
 * starts a quote nor opens a code block that runs on past it. Nor before
 * one, which markdown-it ends a quote at, as it reads none of these lazily.
 * The blocks are read as export reads them, with each quote ended before
 * such a line (see exportQuotes in code-regions.ts), as the blank lines put
 * in end a list a quote is in, after which a fence in its item goes on. So
 * a line after a quote's that starts a block there, as an indented code
 * block or a <span> line, starts it only once the quote ends before it,
 * where markdown-it reads the Markdown as written as going on the quote's
 * paragraph, and the blank line goes before it. One that starts a block in
 * the Markdown as written too, as a fence, ends the quote already.
 */
export function deLazifyBlockquotesWithLines(markdown: string): { output: string; lines: number[] } {
  const lines = markdown.split('\n');
  // Nothing to end: the blocks are read only where a line could be lazy
  if (!LAZY_LINE_RE.test(markdown)) return { output: markdown, lines: lines.map((_line, index) => index) };
  const { codeRegions, htmlRegions } = computeMarkdownRegions(markdown, { inlineCode: false, html: 'all', exportQuotes: true });
  // The blocks of the Markdown as written, found at the first block that
  // starts right after a quote's line
  let written: MarkdownRegions | undefined;
  const out: string[] = [];
  const sourceLines: number[] = [];
  // A line of the Markdown, or a blank line inserted before it, as from it
  const push = (line: string, from: number) => { out.push(line); sourceLines.push(from); };
  let inBlockquoteRun = false;
  // Whether the line before is a lazy line kept on the quote's paragraph
  let kept = false;
  let lineStart = 0;

  for (const [index, line] of lines.entries()) {
    let inside = isInsideCodeRegion(lineStart, codeRegions) || isInsideCodeRegion(lineStart, htmlRegions);
    if (inside && inBlockquoteRun) {
      // The line after a quote's starts the block, as the line before is in
      // none. Only a block that starts there in the Markdown as written too
      // ends the quote without a blank line
      written ??= computeMarkdownRegions(markdown, { inlineCode: false, html: 'all' });
      inside = isInsideCodeRegion(lineStart, written.codeRegions) || isInsideCodeRegion(lineStart, written.htmlRegions);
    }
    lineStart += line.length + 1;
    const after = kept;
    kept = false;
    if (inside) {
      // Nor is a line after one lazy, as it holds no paragraph a quote's
      // line could go on
      inBlockquoteRun = false;
      push(line, index);
      continue;
    }
    const isBlank = line.trim() === '';
    const isBlockquoteLine = isQuoteLine(lines, index);

    if (isBlockquoteLine) {
      inBlockquoteRun = true;
      push(line, index);
      continue;
    }

    if (isBlank) {
      inBlockquoteRun = false;
      push(line, index);
      continue;
    }

    if (inBlockquoteRun) {
      // But for one after a line break, which markdown-it and the preview
      // read in the quote's paragraph, after it, which Word shows there too
      // (see keepsLazyLine)
      if (keepsLazyLine(lines, index, after)) {
        kept = true;
        push(line, index);
        continue;
      }
      // Insert a blank line to end the previous blockquote before this
      // non-blank, non-`>` line.
      push('', index);
      inBlockquoteRun = false;
    }

    push(line, index);
  }

  return { output: out.join('\n'), lines: sourceLines };
}
