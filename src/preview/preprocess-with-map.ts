/**
 * Wrapper functions that run each preprocessor and compute a LineMap
 * tracking how preprocessed line numbers correspond to original line numbers.
 *
 * These wrappers call the original preprocessor to get the output, then
 * diff the original and output line arrays to build the mapping. This avoids
 * modifying the original preprocessors (which are also used by md-to-docx).
 *
 * Invariant: the line-walk logic in preprocessGridTablesWithMap must stay in
 * sync with preprocessGridTables in ../grid-table-preprocess.ts if the grid
 * table format ever changes.
 */

import { LineMap } from './line-map';
import { preprocessGridTables } from '../grid-table-preprocess';
import { wrapBareLatexEnvironments } from '../latex-env-preprocess';
import { preprocessCriticMarkup } from '../critic-markup';

/**
 * Build a LineMap by comparing original and output line arrays.
 *
 * Scans both arrays in parallel. Unchanged lines retain exact provenance.
 * Changed regions are mapped monotonically across the corresponding input
 * region, so a collapsed region maps to its first source line and synthetic
 * lines map to the adjacent source boundary. Every output boundary receives a
 * mapping; relying only on unchanged anchors would map a changed first line to
 * the first later anchor.
 *
 * This is a simplified diff that works well for our preprocessors, which make
 * isolated, non-overlapping replacements with unique surrounding context.
 */
function buildMapFromLines(origLines: string[], outLines: string[]): LineMap {
  if (origLines.length === outLines.length) {
    // Quick check: if all lines match, return identity
    let allMatch = true;
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i] !== outLines[i]) { allMatch = false; break; }
    }
    if (allMatch) return LineMap.identity();
  }

  const mappings = new Array<number>(outLines.length + 1);
  const originalPositions = new Map<string, number[]>();
  for (let line = 0; line < origLines.length; line++) {
    const value = origLines[line];
    if (value.trim() === '') continue;
    const positions = originalPositions.get(value);
    if (positions) positions.push(line);
    else originalPositions.set(value, [line]);
  }

  const firstAtOrAfter = (positions: number[], minimum: number): number | undefined => {
    let lo = 0;
    let hi = positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (positions[mid] < minimum) lo = mid + 1;
      else hi = mid;
    }
    return lo < positions.length ? positions[lo] : undefined;
  };

  const mapChangedRegion = (
    originalStart: number,
    originalEnd: number,
    outputStart: number,
    outputEnd: number,
  ) => {
    const originalCount = originalEnd - originalStart;
    const outputCount = outputEnd - outputStart;
    for (let line = outputStart; line < outputEnd; line++) {
      if (originalCount <= 0) {
        mappings[line] = Math.min(originalStart, origLines.length);
      } else {
        const relative = line - outputStart;
        mappings[line] = originalStart + Math.min(
          originalCount - 1,
          Math.floor(relative * originalCount / outputCount),
        );
      }
    }
  };

  let oi = 0; // original index
  let pi = 0; // preprocessed (output) index

  while (oi < origLines.length && pi < outLines.length) {
    if (origLines[oi] === outLines[pi]) {
      while (oi < origLines.length && pi < outLines.length && origLines[oi] === outLines[pi]) {
        mappings[pi] = oi;
        oi++;
        pi++;
      }
      continue;
    }

    let anchorOriginal: number | undefined;
    let anchorOutput: number | undefined;
    for (let pScan = pi; pScan < outLines.length; pScan++) {
      if (outLines[pScan].trim() === '') continue;
      const positions = originalPositions.get(outLines[pScan]);
      const match = positions ? firstAtOrAfter(positions, oi) : undefined;
      if (match !== undefined) {
        anchorOriginal = match;
        anchorOutput = pScan;
        break;
      }
    }

    if (anchorOriginal === undefined || anchorOutput === undefined) {
      mapChangedRegion(oi, origLines.length, pi, outLines.length);
      oi = origLines.length;
      pi = outLines.length;
      break;
    }

    mapChangedRegion(oi, anchorOriginal, pi, anchorOutput);
    oi = anchorOriginal;
    pi = anchorOutput;
  }

  if (pi < outLines.length) {
    mapChangedRegion(oi, origLines.length, pi, outLines.length);
  }
  // Token maps use an exclusive end-line boundary, so retain the final source
  // boundary as well as each output line's start provenance.
  mappings[outLines.length] = origLines.length;

  return LineMap.fromLineMappings(mappings);
}

/** Preprocess grid tables and return the output with a line map. */
export function preprocessGridTablesWithMap(src: string): { output: string; map: LineMap } {
  const output = preprocessGridTables(src);
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: buildMapFromLines(src.split('\n'), output.split('\n')) };
}

/** Preprocess bare LaTeX environments and return the output with a line map. */
export function wrapBareLatexEnvironmentsWithMap(src: string): { output: string; map: LineMap } {
  const output = wrapBareLatexEnvironments(src);
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: buildMapFromLines(src.split('\n'), output.split('\n')) };
}

/** Preprocess CriticMarkup and return the output with a line map. */
export function preprocessCriticMarkupWithMap(src: string): { output: string; map: LineMap } {
  const output = preprocessCriticMarkup(src);
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: buildMapFromLines(src.split('\n'), output.split('\n')) };
}
