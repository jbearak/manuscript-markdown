// Feature: lsp-performance-phase2, Property 3: Single-pass decoration extraction equivalence

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import {
  extractHighlightRanges,
  extractCommentRanges,
  extractAdditionRanges,
  extractDeletionRanges,
  extractCriticDelimiterRanges,
  extractSubstitutionOldRanges,
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
const safeId = fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 5 }).map(a => a.join(''));
const criticCommentWithId = fc.tuple(safeId, safeContent).map(([id, s]) => `{#` + id + `>>` + s + `<<}`);
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
// Right at the {==, whose = would keep the == from opening but for masking
const highlightAtCriticStart = safeContent.map(s => `{====` + s + `== more==}`);
const nestedHighlightInComment = safeContent.map(s => `{>>text ==` + s + `== more<<}`);
const nestedHighlightInIdComment = fc.tuple(safeId, safeContent).map(([id, s]) => `{#` + id + `>>text ==` + s + `== more<<}`);
const nestedColoredInAddition = fc.tuple(safeContent, fc.constantFrom(...VALID_COLOR_IDS)).map(
  ([s, c]) => `{++before ==${s}=={${c}} after++}`
);

// Nested: critic highlight inside an addition, a deletion or one side of a
// substitution, which export and the preview show highlighted there
const criticInAddition = fc.tuple(safeContent, safeContent).map(([a, b]) => `{++` + a + `{==` + b + `==}++}`);
const criticInDeletion = fc.tuple(safeContent, safeContent).map(([a, b]) => `{--{==` + a + `==}` + b + `--}`);
const criticInSubstitution = fc.tuple(safeContent, safeContent).map(([a, b]) => `{~~{==` + a + `==}~>` + b + ` {==` + a + `==}~~}`);

const colorGen = fc.constantFrom(...VALID_COLOR_IDS, 'invalid-color');

// One well-formed piece of any pattern type, including nested
const mixedPiece = fc.oneof(
    { weight: 3, arbitrary: safeContent },
    { weight: 2, arbitrary: formatHighlight },
    { weight: 2, arbitrary: coloredHighlight },
    { weight: 2, arbitrary: criticHighlight },
    { weight: 1, arbitrary: criticComment },
    { weight: 1, arbitrary: criticCommentWithId },
    { weight: 1, arbitrary: criticAddition },
    { weight: 1, arbitrary: criticDeletion },
    { weight: 1, arbitrary: criticSubstitution },
    { weight: 2, arbitrary: nestedHighlightInAddition },
    { weight: 2, arbitrary: nestedHighlightInDeletion },
    { weight: 2, arbitrary: nestedHighlightInCritic },
    { weight: 1, arbitrary: highlightAtCriticStart },
    { weight: 1, arbitrary: nestedHighlightInComment },
    { weight: 1, arbitrary: nestedHighlightInIdComment },
    { weight: 1, arbitrary: nestedColoredInAddition },
    { weight: 1, arbitrary: criticInAddition },
    { weight: 1, arbitrary: criticInDeletion },
    { weight: 1, arbitrary: criticInSubstitution },
);

// Text generator mixing all pattern types including nested
const mixedTextGen = fc.array(mixedPiece, { minLength: 1, maxLength: 8 }).map(parts => parts.join(' '));

// Malformed text: delimiters and pieces of them, unpaired, crossing and
// nested, side by side with no space between them, as in
// {--{==~>==}}~~}--} and ==a{=={=={>>==}b, which the pieces above, each
// well formed and set apart by spaces, never make. The highlights' are
// drawn more often: with all drawn alike, too few texts had a highlight
// that closes in a critic highlight it starts before, as the second does.
const fragment = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('{==', '==}', '==') },
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      '{>>', '<<}', '{++', '++}', '{--', '--}', '{~~', '~~}', '{#x>>',
      '~>', '=', '{', '}', '~', '>', '<', '-', '+', '{red}', 'a', 'b', ' ', '\n', '\\',
    ),
  },
);
const malformedTextGen = fc.array(
  fc.oneof({ weight: 6, arbitrary: fragment }, { weight: 1, arbitrary: mixedPiece }),
  { minLength: 1, maxLength: 16 }
).map(parts => parts.join(''));

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

  test('on malformed text too', () => {
    fc.assert(
      fc.property(malformedTextGen, colorGen, (text, defaultColor) => {
        expect(normalizeHighlights(extractAllDecorationRanges(text, defaultColor).highlights))
          .toEqual(normalizeHighlights(extractHighlightRanges(text, defaultColor)));
      }),
      { numRuns: 5000 }
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
        const expectedSubOld = extractSubstitutionOldRanges(text);
        const expectedSubNew = extractSubstitutionNewRanges(text);

        expect(normalizeHighlights(all.highlights)).toEqual(normalizeHighlights(expectedHighlights));
        expect(all.comments).toEqual(expectedComments);
        expect(all.additions).toEqual(expectedAdditions);
        expect(all.deletions).toEqual(expectedDeletions);
        const sortRanges = (a: { start: number; end: number }[]) =>
          [...a].sort((x, y) => x.start - y.start || x.end - y.end);
        const allDelimiters = [...all.additionDelimiters, ...all.deletionDelimiters, ...all.substitutionDelimiters];
        expect(sortRanges(allDelimiters)).toEqual(sortRanges(expectedDelimiters));
        expect(all.substitutionOld).toEqual(expectedSubOld);
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

  test.each([
    ['{====a====}{>>c<<}', 'yellow', '==a=='],
    ['x {====a== b==}{>>c<<}', 'yellow', '==a=='],
    ['{====a=={red}==}{>>c<<}', 'red', '==a=={red}'],
  ])('format highlight right at the start of a critic highlight, %j, for editor decorations too', (text, color, highlighted) => {
    // The = of the {== before it kept the decorations from reading its ==
    // as an opener, as the preview and extractHighlightRanges do
    for (const highlights of [extractHighlightRanges(text, 'yellow'), extractAllDecorationRanges(text, 'yellow').highlights]) {
      expect((highlights.get(color) ?? []).map(r => text.slice(r.start, r.end))).toEqual([highlighted]);
    }
  });

  test.each([
    // A critic highlight in an addition, a deletion or one side of a
    // substitution, which export and the preview show highlighted there
    ['{--{==~>==}}~~}--}', { critic: ['~>'] }],
    ['{--a {==b==} c--}', { critic: ['b'] }],
    ['x {++a {==b==} c++} y', { critic: ['b'] }],
    ['{~~a {==b==}~>c {==d==}~~}', { critic: ['b', 'd'] }],
    ['=={++a {==b==} c++}==', { critic: ['b'], yellow: ['=={++a {==b==} c++}=='] }],
    // But not one in a comment, whose text export writes as it is, or one
    // that runs past a substitution's ~> or out of its span
    ['{>>a {==b==} c<<}', {}],
    ['{~~a {==b~>c==}~~}', {}],
    ['{++~>{==b++}==}', {}],
    // Nor any in text that holds another opener, as before: there a {== can
    // be in a comment, or run past a nested substitution's ~>
    ['{++{>>a {==b==} c<<}++}', {}],
    ['{++{~~a {==b~>c==}~~}++}', {}],
    ['{--{#n1>>a {==b==} c<<}--}', {}],
    // That is each side of a substitution by itself
    ['{~~a {==b==}~>{>>c<<}~~}', { critic: ['b'] }],
    // A format highlight that would close in a critic highlight it starts
    // before, or outside the span it starts in, is none
    ['==a{=={=={>>==}b', { critic: ['{=={>>'] }],
    ['==a {==b==c==}', { critic: ['b==c'] }],
    ['{>>b==<<}==', {}],
  ])('%j: the editor\'s highlights and extractHighlightRanges\'s are export\'s', (text, expected) => {
    for (const highlights of [extractHighlightRanges(text, 'yellow'), extractAllDecorationRanges(text, 'yellow').highlights]) {
      const found = Object.fromEntries([...highlights].map(([key, ranges]) =>
        [key, [...ranges].sort((x, y) => x.start - y.start).map(r => text.slice(r.start, r.end))]));
      expect(found).toEqual(expected);
    }
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
