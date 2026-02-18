import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import {
  extractHighlightRanges,
  extractCommentRanges,
  extractAdditionRanges,
  extractDeletionRanges,
  extractCriticDelimiterRanges,
  extractSubstitutionNewRanges,
  extractAllDecorationRanges,
  VALID_COLOR_IDS,
} from './highlight-colors';

describe('Property 3: Single-Pass Decoration Extraction Equivalence', () => {
  // Use safe content (no CriticMarkup-significant chars) to ensure
  // single-pass and individual extractors agree on non-overlapping patterns.
  // Equivalence holds only for non-nested inputs: extractAllDecorationRanges
  // supports nested comment depth via findMatchingClose, while the individual
  // extractCommentRanges uses a non-greedy regex that does not.
  const safeChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 \n'.split(''));
  const safeContent = fc.array(safeChar, { minLength: 1, maxLength: 20 }).map(a => a.join(''));

  const criticPatternGen = fc.oneof(
    safeContent.map(s => `{++${s}++}`),
    safeContent.map(s => `{--${s}--}`),
    safeContent.map(s => `{==${s}==}`),
    safeContent.map(s => `{>>${s}<<}`),
    fc.tuple(safeContent, safeContent).map(([a, b]) => `{~~${a}~>${b}~~}`),
    safeContent.map(s => `==${s}==`),
    fc.tuple(safeContent, fc.constantFrom(...VALID_COLOR_IDS)).map(
      ([s, c]) => `==${s}=={${c}}`
    ),
  );

  const textGen = fc.array(
    fc.oneof(criticPatternGen, safeContent),
    { minLength: 1, maxLength: 10 }
  ).map(parts => parts.join(' '));

  const colorGen = fc.constantFrom(...VALID_COLOR_IDS, 'invalid-color');

  test('extractAllDecorationRanges matches individual functions', () => {
    fc.assert(
      fc.property(textGen, colorGen, (text, defaultColor) => {
        const all = extractAllDecorationRanges(text, defaultColor);
        const expectedHighlights = extractHighlightRanges(text, defaultColor);
        const expectedComments = extractCommentRanges(text);
        const expectedAdditions = extractAdditionRanges(text);
        const expectedDeletions = extractDeletionRanges(text);
        const expectedDelimiters = extractCriticDelimiterRanges(text);
        const expectedSubNew = extractSubstitutionNewRanges(text);

        // Compare highlights map
        expect([...all.highlights.entries()].sort((a, b) => a[0].localeCompare(b[0])))
          .toEqual([...expectedHighlights.entries()].sort((a, b) => a[0].localeCompare(b[0])));
        expect(all.comments).toEqual(expectedComments);
        expect(all.additions).toEqual(expectedAdditions);
        expect(all.deletions).toEqual(expectedDeletions);
        const sortRanges = (a: { start: number; end: number }[]) => [...a].sort((x, y) => x.start - y.start || x.end - y.end);
        expect(sortRanges(all.delimiters)).toEqual(sortRanges(expectedDelimiters));
        expect(all.substitutionNew).toEqual(expectedSubNew);
      }),
      { numRuns: 200 }
    );
  });

  test('extractAllDecorationRanges preserves format highlights inside additions', () => {
    const text = '{++added ==highlighted== text++}';
    const all = extractAllDecorationRanges(text, 'yellow');
    const expectedHighlights = extractHighlightRanges(text, 'yellow');
    expect([...all.highlights.entries()].sort((a, b) => a[0].localeCompare(b[0])))
      .toEqual([...expectedHighlights.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  });
});
