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

  test('extractAllDecorationRanges preserves format highlights inside additions (pre-existing)', () => {
    const text = '{++added ==highlighted== text++}';
    const all = extractAllDecorationRanges(text, 'yellow');
    const expectedHighlights = extractHighlightRanges(text, 'yellow');
    expect([...all.highlights.entries()].sort((a, b) => a[0].localeCompare(b[0])))
      .toEqual([...expectedHighlights.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  });
});

describe('Nested highlight extraction', () => {
  test('format highlight inside critic highlight', () => {
    const text = '{==text with ==highlighted== word==}{>>comment<<}';
    const result = extractHighlightRanges(text, 'yellow');
    // Critic range covers content of {==...==}
    expect(result.has('critic')).toBe(true);
    // ==highlighted== is found inside the critic span
    const yellow = result.get('yellow') ?? [];
    expect(yellow.length).toBe(1);
    const hlText = text.slice(yellow[0].start, yellow[0].end);
    expect(hlText).toBe('==highlighted==');
  });

  test('critic inside format highlight', () => {
    const text = '==text with {==commented==}{>>comment<<}-on word.==';
    const result = extractHighlightRanges(text, 'yellow');
    // Critic range from {==commented==}
    expect(result.has('critic')).toBe(true);
    // The outer ==...== spans the whole sentence (masking removes critic delimiters)
    const yellow = result.get('yellow') ?? [];
    expect(yellow.length).toBeGreaterThanOrEqual(1);
    // The outer format highlight should start at position 0
    expect(yellow.some(r => r.start === 0)).toBe(true);
  });

  test('multiple format highlights inside critic', () => {
    const text = '{==outer ==one== and ==two== text==}';
    const result = extractHighlightRanges(text, 'yellow');
    expect(result.has('critic')).toBe(true);
    const yellow = result.get('yellow') ?? [];
    expect(yellow.length).toBe(2);
    expect(text.slice(yellow[0].start, yellow[0].end)).toBe('==one==');
    expect(text.slice(yellow[1].start, yellow[1].end)).toBe('==two==');
  });

  test('addition inside format highlight', () => {
    const text = '==text {++added++} more==';
    const result = extractHighlightRanges(text, 'yellow');
    const yellow = result.get('yellow') ?? [];
    expect(yellow.length).toBe(1);
    // The format highlight spans the whole thing
    expect(text.slice(yellow[0].start, yellow[0].end)).toBe('==text {++added++} more==');
  });

  test('comment inside format highlight', () => {
    const text = '==text {>>note<<} more==';
    const result = extractHighlightRanges(text, 'yellow');
    const yellow = result.get('yellow') ?? [];
    expect(yellow.length).toBe(1);
    expect(text.slice(yellow[0].start, yellow[0].end)).toBe('==text {>>note<<} more==');
  });
});
