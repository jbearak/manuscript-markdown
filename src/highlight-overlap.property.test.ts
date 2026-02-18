import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { extractHighlightRanges, VALID_COLOR_IDS } from './highlight-colors';

// Reference implementation using .some() for comparison
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
  const criticRanges = result.get('critic') || [];
  const hlRe = /(?<!\{)==([^}=]+)==(?:\{([a-z0-9-]+)\})?/g;
  while ((m = hlRe.exec(text)) !== null) {
    const mEnd = m.index + m[0].length;
    const insideCritic = criticRanges.some(r => (r.start - 3) <= m!.index && mEnd <= (r.end + 3));
    if (insideCritic) { continue; }
    const colorId = m[2];
    if (colorId && VALID_COLOR_IDS.includes(colorId)) {
      push(colorId, m.index, mEnd);
    } else if (colorId) {
      push(resolvedDefaultColor, m.index, mEnd);
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
});
