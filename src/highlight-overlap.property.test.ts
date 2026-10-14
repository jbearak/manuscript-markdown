import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { extractAllDecorationRanges, extractHighlightRanges, VALID_COLOR_IDS } from './highlight-colors';

// The editor's highlights, which extractHighlightRanges finds another way
// (see highlight-colors.property.test.ts), for text of any characters
const sortEntries = (m: Map<string, Array<{ start: number; end: number }>>) =>
  [...m.entries()]
    .map(([key, ranges]) => [key, [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

describe('Property 4: Highlight extraction equivalence on text of any characters', () => {
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

  test('extractHighlightRanges finds the editor\'s highlights', () => {
    fc.assert(
      fc.property(textGen, colorGen, (text, defaultColor) => {
        const actual = extractHighlightRanges(text, defaultColor);
        const expected = extractAllDecorationRanges(text, defaultColor).highlights;
        expect(sortEntries(actual)).toEqual(sortEntries(expected));
      }),
      { numRuns: 200 }
    );
  });

  test('a format highlight that opens in a critic highlight can\'t close outside it', () => {
    const text = '{==x ==bridge==} ==tail==';
    const actual = extractHighlightRanges(text, 'yellow');
    expect(sortEntries(actual)).toEqual(sortEntries(extractAllDecorationRanges(text, 'yellow').highlights));
    // As export and the preview read it: ==bridge has no closing == in the
    // critic highlight, and ==tail== is a highlight by itself
    expect((actual.get('yellow') ?? []).map(r => text.slice(r.start, r.end))).toEqual(['==tail==']);
    expect((actual.get('critic') ?? []).map(r => text.slice(r.start, r.end))).toEqual(['x ==bridge']);
  });
});
