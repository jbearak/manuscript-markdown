// Export's block preprocessing, which turns the Markdown into what
// markdown-it reads (see parseMd in md-to-docx.ts), and which the
// orientation scan reads it after too, so the two read the same blocks: grid
// tables as placeholders, quotes ended before a line without a >, and bare
// LaTeX environments as display math. Each step keeps the line of the
// Markdown each line it writes comes from, so that the scan can say where a
// block it finds is.

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

/**
 * Preserve explicit source semantics for blockquotes by disabling
 * markdown-it lazy continuation behavior (where a non-`>` line can be
 * absorbed into a preceding blockquote paragraph). For roundtrip fidelity
 * we treat a missing `>` as a hard blockquote boundary.
 */
function deLazifyBlockquotesWithLines(markdown: string): { output: string; lines: number[] } {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const sourceLines: number[] = [];
  // A line of the Markdown, or a blank line inserted before it, as from it
  const push = (line: string, from: number) => { out.push(line); sourceLines.push(from); };
  let inBlockquoteRun = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;

  for (const [index, line] of lines.entries()) {
    const fenceMatch = line.match(/^ {0,3}([`~]{3,})/);
    if (fenceMatch) {
      const run = fenceMatch[1];
      const runChar = run[0] as '`' | '~';
      // Invariant: de-lazification must not inject blank lines inside fenced
      // code blocks, or code content roundtrip fidelity is corrupted.
      if (!fenceChar) {
        if (inBlockquoteRun) {
          push('', index);
          inBlockquoteRun = false;
        }
        fenceChar = runChar;
        fenceLen = run.length;
      } else if (runChar === fenceChar && run.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      push(line, index);
      continue;
    }
    if (fenceChar) {
      push(line, index);
      continue;
    }
    const isBlank = line.trim() === '';
    const isBlockquoteLine = /^ {0,3}>/.test(line);

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
