/**
 * The preview's preprocessors, which are export's, each with a LineMap from
 * the lines it writes back to the lines it read, so VS Code's data-line
 * scroll sync attributes name the source's lines.
 *
 * Each map is the line provenance the preprocessor itself keeps for export
 * (see line-map.ts in src), so the preview and export agree on where each
 * line comes from, and no diff of input and output has to guess it.
 */

import { LineMap } from './line-map';
import { preprocessGridTablesWithSourceMap } from '../grid-table-preprocess';
import { wrapBareLatexEnvironmentsWithLines } from '../latex-env-preprocess';
import { paragraphsExportEnds } from '../block-preprocess';
import { preprocessCriticMarkupWithLines } from '../critic-markup';
import { lineCount, withEnd } from '../line-map';

/** Preprocess grid tables and return the output with a line map. */
export function preprocessGridTablesWithMap(src: string): { output: string; map: LineMap } {
  const { output, lines } = preprocessGridTablesWithSourceMap(src);
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: LineMap.fromLineMappings(withEnd(lines, lineCount(src))) };
}

/** Preprocess bare LaTeX environments and return the output with a line
 *  map, leaving those in a quote's paragraph export ends the quote inside,
 *  which export leaves (see paragraphsExportEnds) */
export function wrapBareLatexEnvironmentsWithMap(src: string): { output: string; map: LineMap } {
  const { output, lines } = wrapBareLatexEnvironmentsWithLines(src, { lazy: paragraphsExportEnds(src) });
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: LineMap.fromLineMappings(withEnd(lines, lineCount(src))) };
}

/** Preprocess CriticMarkup and return the output with a line map. */
export function preprocessCriticMarkupWithMap(src: string): { output: string; map: LineMap } {
  const { output, lines } = preprocessCriticMarkupWithLines(src);
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: LineMap.fromLineMappings(lines) };
}
