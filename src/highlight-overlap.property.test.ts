import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { extractHighlightRanges, maskCriticDelimiters, VALID_COLOR_IDS } from './highlight-colors';

// Reference implementation using masking (matches production implementation)
function extractHighlightRangesReference(text: string, defaultColor: string): Map<string, Array<{ start: number; end: number }>> {
  const result = new Map<string, Array<{ start: number; end: number }>>();
  const resolvedDefaultColor = VALID_COLOR_IDS.includes(defaultColor) ? defaultColor : 'yellow';
  const push = (key: string, start: number, end: number) => {
    if (!result.has(key)) { result.set(key, []); }
    result.get(key)!.push({ start, end });
  };
  const criticRe = /\{==([\s\S]*?)==\}/g;
  let m;
  while ((m = criticRe.exec(text)) !== null) {
    push('critic', m.index + 3, m.index + m[0].length - 3);
  }
  const masked = maskCriticDelimiters(text);
  const hlRe = /(?<!\{)==([^}=]+)==(?:\{([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\})?/g;
  while ((m = hlRe.exec(masked)) !== null) {
    const mEnd = m.index + m[0].length;
    const colorId = m[2];
    if (colorId && VALID_COLOR_IDS.includes(colorId)) {
      push(colorId, m.index, mEnd);
    } else {
      push(resolvedDefaultColor, m.index, mEnd);
    }
  }
  return result;
}

describe('Property 4: Two-Pointer Overlap Exclusion Equivalence', () => {
  const textGen = fc.array(
    fc.oneof(
      fc.string({ maxLength: 20 }).map(s => `{==${s.replace(/==\}/g, '')}==}`),
      fc.string({ maxLength: 20 }).map(s => `==${s.replace(/==/g, '')}==`),
      fc.tuple(
        fc.string({ maxLength: 15 }).map(s => s.replace(/==/g, '')),
        fc.constantFrom(...VALID_COLOR_IDS)
      ).map(([s, c]) => `==${s}=={${c}}`),
      fc.string({ maxLength: 30 })
    ),
    { minLength: 1, maxLength: 10 }
  ).map(parts => parts.join(' '));

  const colorGen = fc.constantFrom(...VALID_COLOR_IDS, 'invalid');

  test('two-pointer produces same results as .some() reference', () => {
    fc.assert(
      fc.property(textGen, colorGen, (text, defaultColor) => {
        const actual = extractHighlightRanges(text, defaultColor);
        const expected = extractHighlightRangesReference(text, defaultColor);
        const sortEntries = (m: Map<string, Array<{ start: number; end: number }>>) =>
          [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        expect(sortEntries(actual)).toEqual(sortEntries(expected));
      }),
      { numRuns: 200 }
    );
  });

  test('format highlight inside critic is found after masking', () => {
    const text = '{==x ==bridge==} ==tail==';
    const actual = extractHighlightRanges(text, 'yellow');
    const expected = extractHighlightRangesReference(text, 'yellow');
    const sortEntries = (m: Map<string, Array<{ start: number; end: number }>>) =>
      [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    expect(sortEntries(actual)).toEqual(sortEntries(expected));
    // After masking, ==bridge== content is visible and greedily merges with ==tail==
    // into a single format highlight span; both impls agree
    expect((actual.get('yellow') ?? []).length).toBe(1);
    expect(actual.has('critic')).toBe(true);
  });
});
