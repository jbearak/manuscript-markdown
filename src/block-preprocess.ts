// Export's block preprocessing, which turns the Markdown into what
// markdown-it reads (see parseMd in md-to-docx.ts), and which the
// orientation scan reads it after too, so the two read the same blocks: grid
// tables as placeholders, quotes ended before a line without a >, and bare
// LaTeX environments as display math. Each step keeps the line of the
// Markdown each line it writes comes from, so that the scan can say where a
// block it finds is.

import { computeMarkdownRegions, isInsideCodeRegion } from './code-regions';
import { preprocessGridTablesWithSourceMap } from './grid-table-preprocess';
import { wrapBareLatexEnvironmentsWithLines } from './latex-env-preprocess';

export interface PreprocessedBlocks {
  /** After grid tables and quotes, before LaTeX environments are wrapped */
  deLazified: string;
  output: string;
  /** For each line of `output`, the line of the Markdown it comes from */
  lines: number[];
}

/** The Markdown as markdown-it reads it, before CriticMarkup is preprocessed */
export function preprocessBlocks(markdown: string): PreprocessedBlocks {
  const grid = preprocessGridTablesWithSourceMap(markdown);
  const quotes = deLazifyBlockquotesWithLines(grid.output);
  const latex = wrapBareLatexEnvironmentsWithLines(quotes.output);
  return { deLazified: quotes.output, output: latex.output, lines: latex.lines.map(line => grid.lines[quotes.lines[line]]) };
}

/** A line that starts as a quote's, at the top level or in a list item one level in */
const QUOTE_LINE_RE = /^ {0,3}>/;
/** A quote's line, before a line with text that starts as none does, which
 *  lazy continuation can make the quote's. Its line ends at a \n alone, as
 *  the lines here do, past a \r, which a . doesn't match */
const LAZY_LINE_RE = /^ {0,3}>[^\n]*\n(?! {0,3}>)[^\S\n]*\S/m;

/**
 * Preserve explicit source semantics for blockquotes by disabling
 * markdown-it lazy continuation behavior (where a non-`>` line can be
 * absorbed into a preceding blockquote paragraph). For roundtrip fidelity
 * we treat a missing `>` as a hard blockquote boundary.
 *
 * Invariant: de-lazification must not inject blank lines inside a code
 * block or an HTML block, or the block's text changes, and a blank line
 * ends a <div> or the like. Their lines are markdown-it's, at any depth: a
 * line in one that starts with a > or a fence is its text, which neither
 * starts a quote nor opens a code block that runs on past it. Nor before
 * one, which markdown-it ends a quote at, as it reads none of these lazily.
 */
function deLazifyBlockquotesWithLines(markdown: string): { output: string; lines: number[] } {
  const lines = markdown.split('\n');
  // Nothing to end: the blocks are read only where a line could be lazy
  if (!LAZY_LINE_RE.test(markdown)) return { output: markdown, lines: lines.map((_line, index) => index) };
  const { codeRegions, htmlRegions } = computeMarkdownRegions(markdown, { inlineCode: false, html: 'all' });
  const out: string[] = [];
  const sourceLines: number[] = [];
  // A line of the Markdown, or a blank line inserted before it, as from it
  const push = (line: string, from: number) => { out.push(line); sourceLines.push(from); };
  let inBlockquoteRun = false;
  let lineStart = 0;

  for (const [index, line] of lines.entries()) {
    const inside = isInsideCodeRegion(lineStart, codeRegions) || isInsideCodeRegion(lineStart, htmlRegions);
    lineStart += line.length + 1;
    if (inside) {
      // Nor is a line after one lazy, as it holds no paragraph a quote's
      // line could go on
      inBlockquoteRun = false;
      push(line, index);
      continue;
    }
    const isBlank = line.trim() === '';
    const isBlockquoteLine = QUOTE_LINE_RE.test(line);

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
      // Insert a blank line to end the previous blockquote before this
      // non-blank, non-`>` line.
      push('', index);
      inBlockquoteRun = false;
    }

    push(line, index);
  }

  return { output: out.join('\n'), lines: sourceLines };
}
