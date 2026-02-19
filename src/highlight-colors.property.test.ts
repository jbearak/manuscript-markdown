// Feature: lsp-performance-phase2, Property 3: Single-pass decoration extraction equivalence

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

// **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

/**
 * Normalize a highlights map for deterministic comparison:
 * sort entries by color key, sort ranges within each key by start then end.
 */
function normalizeHighlights(
  map: Map<string, Array<{ start: number; end: number }>>
): Array<[string, Array<{ start: number; end: number }>]> {
  return [...map.entries()]
    .map(([key, ranges]) => [key, [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)] as [string, Array<{ start: number; end: number }>])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// --- Generators ---

// Safe content chars that don't interfere with CriticMarkup delimiters
const safeChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 \n'.split(''));
const safeContent = fc.array(safeChar, { minLength: 1, maxLength: 15 }).map(a => a.join(''));

// CriticMarkup and highlight pattern generators
const criticHighlight = safeContent.map(s => `{==${s}==}`);
const criticComment = safeContent.map(s => `{>>${s}<<}`);
const criticAddition = safeContent.map(s => `{++${s}++}`);
const criticDeletion = safeContent.map(s => `{--${s}--}`);
const criticSubstitution = fc.tuple(safeContent, safeContent).map(([a, b]) => `{~~${a}~>${b}~~}`);
const formatHighlight = safeContent.map(s => `==${s}==`);
const coloredHighlight = fc.tuple(safeContent, fc.constantFrom(...VALID_COLOR_IDS)).map(
  ([s, c]) => `==${s}=={${c}}`
);

// Nested: format highlight inside CriticMarkup spans
const nestedHighlightInAddition = safeContent.map(s => `{++text ==` + s + `== more++}`);
const nestedHighlightInDeletion = safeContent.map(s => `{--text ==` + s + `== more--}`);
const nestedHighlightInCritic = safeContent.map(s => `{==text ==` + s + `== more==}`);
const nestedHighlightInComment = safeContent.map(s => `{>>text ==` + s + `== more<<}`);
const nestedColoredInAddition = fc.tuple(safeContent, fc.constantFrom(...VALID_COLOR_IDS)).map(
  ([s, c]) => `{++before ==${s}=={${c}} after++}`
);

const colorGen = fc.constantFrom(...VALID_COLOR_IDS, 'invalid-color');

// Text generator mixing all pattern types including nested
const mixedTextGen = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: safeContent },
    { weight: 2, arbitrary: formatHighlight },
    { weight: 2, arbitrary: coloredHighlight },
    { weight: 2, arbitrary: criticHighlight },
    { weight: 1, arbitrary: criticComment },
    { weight: 1, arbitrary: criticAddition },
    { weight: 1, arbitrary: criticDeletion },
    { weight: 1, arbitrary: criticSubstitution },
    { weight: 2, arbitrary: nestedHighlightInAddition },
    { weight: 2, arbitrary: nestedHighlightInDeletion },
    { weight: 2, arbitrary: nestedHighlightInCritic },
    { weight: 1, arbitrary: nestedHighlightInComment },
    { weight: 1, arbitrary: nestedColoredInAddition },
  ),
  { minLength: 1, maxLength: 8 }
).map(parts => parts.join(' '));

describe('Property 3: Single-pass decoration extraction equivalence', () => {

  test('single-pass extractAllDecorationRanges produces highlight ranges identical to standalone extractHighlightRanges', () => {
    fc.assert(
      fc.property(mixedTextGen, colorGen, (text, defaultColor) => {
        const allResult = extractAllDecorationRanges(text, defaultColor);
        const standaloneHighlights = extractHighlightRanges(text, defaultColor);

        const normalizedAll = normalizeHighlights(allResult.highlights);
        const normalizedStandalone = normalizeHighlights(standaloneHighlights);

        expect(normalizedAll).toEqual(normalizedStandalone);
      }),
      { numRuns: 200 }
    );
  });

  test('extractAllDecorationRanges matches all individual extraction functions', () => {
    fc.assert(
      fc.property(mixedTextGen, colorGen, (text, defaultColor) => {
        const all = extractAllDecorationRanges(text, defaultColor);
        const expectedHighlights = extractHighlightRanges(text, defaultColor);
        const expectedComments = extractCommentRanges(text);
        const expectedAdditions = extractAdditionRanges(text);
        const expectedDeletions = extractDeletionRanges(text);
        const expectedDelimiters = extractCriticDelimiterRanges(text);
        const expectedSubNew = extractSubstitutionNewRanges(text);

        expect(normalizeHighlights(all.highlights)).toEqual(normalizeHighlights(expectedHighlights));
        expect(all.comments).toEqual(expectedComments);
        expect(all.additions).toEqual(expectedAdditions);
        expect(all.deletions).toEqual(expectedDeletions);
        const sortRanges = (a: { start: number; end: number }[]) =>
          [...a].sort((x, y) => x.start - y.start || x.end - y.end);
        expect(sortRanges(all.delimiters)).toEqual(sortRanges(expectedDelimiters));
        expect(all.substitutionNew).toEqual(expectedSubNew);
      }),
      { numRuns: 200 }
    );
  });
});

describe('Nested highlight extraction', () => {
  test('format highlight inside critic highlight', () => {
    const text = '{==text with ==highlighted== word==}{>>comment<<}';
    const result = extractHighlightRanges(text, 'yellow');
    expect(result.has('critic')).toBe(true);
    const yellow = result.get('yellow') ?? [];
    expect(yellow.length).toBe(1);
    const hlText = text.slice(yellow[0].start, yellow[0].end);
    expect(hlText).toBe('==highlighted==');
  });

  test('critic inside format highlight', () => {
    const text = '==text with {==commented==}{>>comment<<}-on word.==';
    const result = extractHighlightRanges(text, 'yellow');
    expect(result.has('critic')).toBe(true);
    const yellow = result.get('yellow') ?? [];
    expect(yellow.length).toBeGreaterThanOrEqual(1);
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
