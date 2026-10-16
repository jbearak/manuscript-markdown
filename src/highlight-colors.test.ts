import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { fastestRun } from './test-timing';
import { wrapColoredHighlight } from './formatting';
import {
  VALID_COLOR_IDS,
  extractHighlightRanges,
  extractCriticDelimiterRanges,
  extractCommentRanges,
  extractAllDecorationRanges,
  editorDecorationRanges,
  setDefaultHighlightColor,
  getDefaultHighlightColor,
  resolveMarkdownColor,
  OOXML_TO_MARKDOWN
} from './highlight-colors';

const colorIdGen = fc.constantFrom(...VALID_COLOR_IDS);
const safeTextGen = fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('=') && !s.includes('{') && !s.includes('}'));

// Feature: highlight-colors, Property 1: Colored highlight wrapping preserves content and produces correct syntax
describe('Property 1: Colored highlight wrapping preserves content', () => {
  it('should produce ==text=={color} and preserve original text', () => {
    fc.assert(
      fc.property(safeTextGen, colorIdGen, (text, color) => {
        const result = wrapColoredHighlight(text, color);
        expect(result.newText).toBe('==' + text + '=={' + color + '}');
        // Extract content between == delimiters
        const extracted = result.newText.slice(2, result.newText.indexOf('=={'));
        expect(extracted).toBe(text);
      }),
      { numRuns: 100 }
    );
  });

});

// Feature: highlight-colors, Property 6: Highlight range extraction finds colored highlights and CriticMarkup highlights
describe('Property 6: Highlight range extraction', () => {
  it('should find colored highlights grouped by color', () => {
    fc.assert(
      fc.property(safeTextGen, colorIdGen, (text, color) => {
        const doc = '==' + text + '=={' + color + '}';
        const ranges = extractHighlightRanges(doc, 'yellow');
        const colorRanges = ranges.get(color) || [];
        expect(colorRanges.length).toBe(1);
        expect(doc.slice(colorRanges[0].start, colorRanges[0].end)).toBe(doc);
      }),
      { numRuns: 100 }
    );
  });

  it('should find CriticMarkup highlights under critic key', () => {
    fc.assert(
      fc.property(safeTextGen, (text) => {
        const doc = '{==' + text + '==}';
        const ranges = extractHighlightRanges(doc, 'yellow');
        const criticRanges = ranges.get('critic') || [];
        expect(criticRanges.length).toBe(1);
        expect(doc.slice(criticRanges[0].start, criticRanges[0].end)).toBe(text);
      }),
      { numRuns: 100 }
    );
  });

  it('should use default color for highlights without color suffix', () => {
    fc.assert(
      fc.property(safeTextGen, colorIdGen, (text, defaultColor) => {
        const doc = '==' + text + '==';
        const ranges = extractHighlightRanges(doc, defaultColor);
        const defaultRanges = ranges.get(defaultColor) || [];
        expect(defaultRanges.length).toBe(1);
      }),
      { numRuns: 100 }
    );
  });

  it('should fall back to configured default for unrecognized color', () => {
    fc.assert(
      fc.property(safeTextGen, colorIdGen, (text, defaultColor) => {
        const doc = '==' + text + '=={bogus}';
        const ranges = extractHighlightRanges(doc, defaultColor);
        const defaultRanges = ranges.get(defaultColor) || [];
        expect(defaultRanges.length).toBe(1);
      }),
      { numRuns: 100 }
    );
  });

  it('should fall back to yellow when configured default is invalid', () => {
    fc.assert(
      fc.property(safeTextGen, (text) => {
        const doc = '==' + text + '=={bogus}';
        const ranges = extractHighlightRanges(doc, 'not-a-color');
        const yellowRanges = ranges.get('yellow') || [];
        expect(yellowRanges.length).toBe(1);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Delimiter extraction for editor decorations', () => {
  it('skips regular comment delimiters so grammar scopes color them', () => {
    const text = '{>>note<<}';
    const delimiters = extractCriticDelimiterRanges(text).map(r => text.slice(r.start, r.end));
    expect(delimiters).not.toContain('{>>');
    expect(delimiters).not.toContain('<<}');
  });

  it('skips ID-comment closing <<} so TextMate tag scope can color it', () => {
    const text = '{#2>>note<<}';
    const delimiters = extractCriticDelimiterRanges(text).map(r => text.slice(r.start, r.end));

    expect(delimiters).not.toContain('<<}');
  });

  it('skips highlight delimiters so grammar tag scopes color them', () => {
    const text = '{==highlighted==}';
    const delimiters = extractCriticDelimiterRanges(text).map(r => text.slice(r.start, r.end));
    expect(delimiters).not.toContain('{==');
    expect(delimiters).not.toContain('==}');
  });

  it('still extracts non-comment Critic delimiters for muted decoration', () => {
    const text = '{++add++}';
    const delimiters = extractCriticDelimiterRanges(text).map(r => text.slice(r.start, r.end));

    expect(delimiters).toContain('{++');
    expect(delimiters).toContain('++}');
  });
});

describe('Editor decorations for CriticMarkup without its closers', () => {
  it('finds them in time linear in the text', () => {
    // Each opener, and each in a format highlight, searched the rest of the
    // text for its closer, a comment's for its matching <<}, again where
    // none was, so a text of many took time in the square of their number
    const input = (n: number) => 'x {++ a {-- b {~~ c {== d {>> e {#a>> f == g {++ h {>> i '.repeat(n);
    expect(extractAllDecorationRanges(input(2), 'yellow').additions).toEqual([]);
    const time = (n: number) => {
      const text = input(n);
      return fastestRun(() => extractAllDecorationRanges(text, 'yellow'));
    };
    time(10000);
    const small = time(10000);
    expect(time(40000) / small).toBeLessThan(8);
  }, 60000);

  it('finds critic highlights in additions, deletions and substitutions in time linear in the text', () => {
    // Each {== in a span whose ==} is past the span's end, at the text's end
    const input = (n: number) => 'x {-- a {== b --} c {++ d {== e ++} f {~~ g {== h ~> i {== j ~~} '.repeat(n) + '==}';
    expect(extractAllDecorationRanges(input(2), 'yellow').highlights.get('critic')).toBeUndefined();
    const time = (n: number) => {
      const text = input(n);
      return fastestRun(() => extractAllDecorationRanges(text, 'yellow'));
    };
    time(10000);
    const small = time(10000);
    expect(time(40000) / small).toBeLessThan(8);
  }, 60000);
});

// Each opener with no closer after it, and each {== in a span's text with
// no ==} after it there, searched the rest of the text, or of the span's
describe('Highlight and comment ranges for CriticMarkup without its closers', () => {
  it.each(['{>>', '{++', '{--', '{~~', '{==', '{#c1>>'])('finds the highlights in a text of many %s with no closer in linear time', (opener) => {
    const text = '{==a==} ' + ('word ' + opener + ' more text here\n').repeat(100_000) + '==b==';
    let found = new Map<string, Array<{ start: number; end: number }>>();
    // Quadratic searching took seconds here; linear takes milliseconds
    expect(fastestRun(() => { found = extractHighlightRanges(text, 'yellow'); })).toBeLessThan(1000);
    expect(found).toEqual(new Map([['critic', [{ start: 3, end: 4 }]], ['yellow', [{ start: text.length - 5, end: text.length }]]]));
  }, 60000);

  it('finds the highlights in an insertion of many {== with no closer in linear time', () => {
    const text = '{++{==a==} ' + 'word {== more text here\n'.repeat(20_000) + '++}';
    let found = new Map<string, Array<{ start: number; end: number }>>();
    expect(fastestRun(() => { found = extractHighlightRanges(text, 'yellow'); })).toBeLessThan(1000);
    expect(found).toEqual(new Map([['critic', [{ start: 6, end: 7 }]]]));
  }, 60000);

  it.each(['{>>', '{#c1>>'])('finds the comments in a text of many %s with no closer in linear time', (opener) => {
    const text = '{>>a<<} ' + ('word ' + opener + ' more text here\n').repeat(100_000);
    let found: Array<{ start: number; end: number }> = [];
    expect(fastestRun(() => { found = extractCommentRanges(text); })).toBeLessThan(1000);
    expect(found).toEqual([{ start: 3, end: 4 }]);
  }, 60000);
});

// A { after an odd run of backslashes opens no CriticMarkup, as export and
// the preview read it: the last backslash escapes it
describe('Editor decorations skip an escaped CriticMarkup opener', () => {
  type Range = { start: number; end: number };
  /** Each decoration's text in document order: a delimiter as itself, a
   *  span's text after what it is */
  const decorations = (text: string) => {
    const all = extractAllDecorationRanges(text, 'yellow');
    const named: Array<[string, Range]> = [
      ...[...all.additionDelimiters, ...all.deletionDelimiters, ...all.substitutionDelimiters, ...all.highlightDelimiters, ...all.commentDelimiters]
        .map(range => ['', range] as [string, Range]),
      ...all.additions.map(range => ['addition: ', range] as [string, Range]),
      ...all.deletions.map(range => ['deletion: ', range] as [string, Range]),
      ...all.substitutionOld.map(range => ['old: ', range] as [string, Range]),
      ...all.substitutionNew.map(range => ['new: ', range] as [string, Range]),
      ...all.comments.map(range => ['comment: ', range] as [string, Range]),
      ...[...all.highlights].flatMap(([key, list]) => list.map(range => [key + ': ', range] as [string, Range])),
    ];
    return named
      .sort((a, b) => a[1].start - b[1].start || b[1].end - a[1].end)
      .map(([name, range]) => name + text.slice(range.start, range.end));
  };

  it.each<[string, string, string[]]>([
    ['an escaped insertion', 'a \\{++x++} b', []],
    ['an escaped deletion', 'a \\{--x--} b', []],
    ['an escaped substitution', 'a \\{~~x~>y~~} b', []],
    ['an escaped comment', 'a \\{>>c<<} b', []],
    ['an escaped comment with an ID', 'a \\{#1>>c<<} b', []],
    ['an escaped critic highlight', 'a \\{==x==} b', []],
    ['an insertion after three backslashes', 'a \\\\\\{++x++} b', []],
    ['an escaped critic highlight in an insertion', '{++a \\{==x==} b++}', ['{++', 'addition: a \\{==x==} b', '++}']],
    ['a critic highlight in an insertion beside an escaped deletion', '{++a \\{--x--} {==y==} b++}', ['{++', 'addition: a \\{--x--} {==y==} b', '{==', 'critic: y', '==}', '++}']],
    ['an insertion', 'a {++x++} b', ['{++', 'addition: x', '++}']],
    ['an insertion after an escaped backslash', 'a \\\\{++x++} b', ['{++', 'addition: x', '++}']],
    ['a substitution', 'a {~~x~>y~~} b', ['{~~', 'old: x', '~>', 'new: y', '~~}']],
    ['a critic highlight and its comment', 'a {==x==}{>>c<<} b', ['{==', 'critic: x', '==}', '{>>', 'comment: c', '<<}']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(decorations(text)).toEqual(expected);
    // And extractHighlightRanges as extractAllDecorationRanges
    expect([...extractHighlightRanges(text, 'yellow')]).toEqual([...extractAllDecorationRanges(text, 'yellow').highlights]);
  });
});

// Feature: highlight-colors, Property 9: Default highlight color respects configuration
describe('Property 9: Default highlight color respects configuration', () => {

  it('should apply configured default color to ==text== in extractHighlightRanges', () => {
    fc.assert(
      fc.property(safeTextGen, colorIdGen, (text, configColor) => {
        const doc = '==' + text + '==';
        const ranges = extractHighlightRanges(doc, configColor);
        const colorRanges = ranges.get(configColor) || [];
        expect(colorRanges.length).toBe(1);
      }),
      { numRuns: 100 }
    );
  });

  it('should update getDefaultHighlightColor after setDefaultHighlightColor', () => {
    const originalDefault = getDefaultHighlightColor();
    try {
      fc.assert(
        fc.property(colorIdGen, (color) => {
          setDefaultHighlightColor(color);
          expect(getDefaultHighlightColor()).toBe(color);
        }),
        { numRuns: 14 }
      );
    } finally {
      setDefaultHighlightColor(originalDefault);
    }
  });

  it('should fall back to yellow for invalid config values', () => {
    const originalDefault = getDefaultHighlightColor();
    try {
      setDefaultHighlightColor('not-a-color');
      expect(getDefaultHighlightColor()).toBe('yellow');
    } finally {
      setDefaultHighlightColor(originalDefault);
    }
  });
});

describe('resolveMarkdownColor', () => {
  it('maps OOXML named colors to markdown names', () => {
    for (const [ooxml, markdown] of Object.entries(OOXML_TO_MARKDOWN)) {
      expect(resolveMarkdownColor(ooxml)).toBe(markdown);
    }
  });

  it('maps specific OOXML names correctly', () => {
    expect(resolveMarkdownColor('cyan')).toBe('turquoise');
    expect(resolveMarkdownColor('magenta')).toBe('pink');
    expect(resolveMarkdownColor('darkBlue')).toBe('dark-blue');
    expect(resolveMarkdownColor('darkCyan')).toBe('teal');
    expect(resolveMarkdownColor('darkMagenta')).toBe('violet');
    expect(resolveMarkdownColor('darkRed')).toBe('dark-red');
    expect(resolveMarkdownColor('darkYellow')).toBe('dark-yellow');
    expect(resolveMarkdownColor('darkGray')).toBe('gray-50');
    expect(resolveMarkdownColor('lightGray')).toBe('gray-25');
  });

  it('maps identity colors (same name in both systems)', () => {
    expect(resolveMarkdownColor('yellow')).toBe('yellow');
    expect(resolveMarkdownColor('green')).toBe('green');
    expect(resolveMarkdownColor('blue')).toBe('blue');
    expect(resolveMarkdownColor('red')).toBe('red');
    expect(resolveMarkdownColor('black')).toBe('black');
  });

  it('maps hex values without # prefix', () => {
    expect(resolveMarkdownColor('00FF00')).toBe('green');
    expect(resolveMarkdownColor('FFFF00')).toBe('yellow');
    expect(resolveMarkdownColor('00FFFF')).toBe('turquoise');
    expect(resolveMarkdownColor('FF0000')).toBe('red');
  });

  it('maps hex values with # prefix', () => {
    expect(resolveMarkdownColor('#00FF00')).toBe('green');
    expect(resolveMarkdownColor('#FFFF00')).toBe('yellow');
    expect(resolveMarkdownColor('#0000FF')).toBe('blue');
  });

  it('maps lowercase hex values', () => {
    expect(resolveMarkdownColor('00ff00')).toBe('green');
    expect(resolveMarkdownColor('ffff00')).toBe('yellow');
  });

  it('returns undefined for unknown values', () => {
    expect(resolveMarkdownColor('unknown')).toBeUndefined();
    expect(resolveMarkdownColor('FF8C00')).toBeUndefined();
    expect(resolveMarkdownColor('')).toBeUndefined();
  });
});

describe('Comment-with-ID {#id>>...<<} handling', () => {
  it('extractCommentRanges returns content range for {#id>>...<<}', () => {
    const text = '{#abc>>hello<<}';
    const ranges = extractCommentRanges(text);
    expect(ranges.length).toBe(1);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe('hello');
  });

  it('extractCommentRanges handles both plain and ID comments', () => {
    const text = '{>>plain<<} and {#x1>>with id<<}';
    const ranges = extractCommentRanges(text);
    expect(ranges.length).toBe(2);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe('plain');
    expect(text.slice(ranges[1].start, ranges[1].end)).toBe('with id');
  });

  it('extractHighlightRanges reads {#id>>...<<} as one span, whose } a format highlight holds', () => {
    const text = '==a {#abc>>b}c<<} d==';
    const yellow = extractHighlightRanges(text, 'yellow').get('yellow') ?? [];
    expect(yellow.map(r => text.slice(r.start, r.end))).toEqual([text]);
  });

  it('extractAllDecorationRanges populates comments and commentDelimiters for {#id>>...<<}', () => {
    const text = '{#foo>>note<<}';
    const result = extractAllDecorationRanges(text, 'yellow');
    expect(result.comments.length).toBe(1);
    expect(text.slice(result.comments[0].start, result.comments[0].end)).toBe('note');
    expect(result.commentDelimiters.length).toBe(2);
    // Opener: {#foo>>
    expect(text.slice(result.commentDelimiters[0].start, result.commentDelimiters[0].end)).toBe('{#foo>>');
    // Closer: <<}
    expect(text.slice(result.commentDelimiters[1].start, result.commentDelimiters[1].end)).toBe('<<}');
  });

  it('format highlight spanning {#id>>...<<} is detected', () => {
    const text = '==before {#x>>comment<<} after==';
    const result = extractAllDecorationRanges(text, 'yellow');
    const yellowRanges = result.highlights.get('yellow') || [];
    expect(yellowRanges.length).toBe(1);
    expect(result.comments.length).toBe(1);
    expect(text.slice(result.comments[0].start, result.comments[0].end)).toBe('comment');
  });
});

// An == after an odd run of backslashes opens no highlight, as export and the
// preview read it: the last backslash escapes its first =. One before a
// closing == escapes nothing, as in export.
describe('Editor decorations skip an escaped highlight opener', () => {
  /** The text of each format highlight, not critic, in document order */
  const formatHighlights = (text: string, ranges: Map<string, Array<{ start: number; end: number }>>) =>
    [...ranges.entries()]
      .filter(([key]) => key !== 'critic')
      .flatMap(([, list]) => list)
      .sort((a, b) => a.start - b.start)
      .map(range => text.slice(range.start, range.end));

  it.each<[string, string, string[]]>([
    ['an escaped opener before a highlight', 'a \\== b ==c==', ['==c==']],
    ['an escaped opener', '\\==x==', []],
    ['an opener after three backslashes', '\\\\\\==x== y', []],
    ['an escaped opener of a colored highlight', 'x \\==a=={red} y', []],
    ['the opener after an escaped one', '\\==a==b==', ['==b==']],
    ['an escaped opener right after a highlight', '==a\\==\\==b==', ['==a\\==']],
    ['an escaped opener in an insertion', '{++a \\==x== b++}', []],
    ['an escaped opener around a comment', 'a \\==x {>>c<<} y== b', []],
    ['a highlight', 'a ==x== b', ['==x==']],
    ['a colored highlight', 'a ==x=={red} b', ['==x=={red}']],
    ['a critic highlight', 'a {==x==} b', []],
    ['a highlight after an escaped backslash', 'a \\\\==x== b', ['==x==']],
    ['a highlight after two escaped backslashes', 'a \\\\\\\\==x== b', ['==x==']],
    ['a colored highlight after an escaped backslash', '\\\\==x=={red}', ['==x=={red}']],
    ['a highlight after an escaped backslash in an insertion', '{++\\\\==x==++}', ['==x==']],
    ['a backslash before the closer, which escapes none', '==a\\== b', ['==a\\==']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(formatHighlights(text, extractHighlightRanges(text, 'yellow'))).toEqual(expected);
    expect(formatHighlights(text, extractAllDecorationRanges(text, 'yellow').highlights)).toEqual(expected);
  });

  it('keeps a critic highlight\'s text', () => {
    const text = 'a {==x==} \\==y== b';
    expect((extractHighlightRanges(text, 'yellow').get('critic') ?? []).map(r => text.slice(r.start, r.end))).toEqual(['x']);
    expect((extractAllDecorationRanges(text, 'yellow').highlights.get('critic') ?? []).map(r => text.slice(r.start, r.end))).toEqual(['x']);
  });
});

// An == right after a { that an odd run of backslashes escapes opens a
// highlight, as export and the preview read it: the { is text, as in
// \{==x==\}, which import writes for Word's literal braces around a
// highlight. One right after a { no odd run escapes opens none, as before
describe('Editor decorations read an == after an escaped { as a highlight\'s opener', () => {
  /** Each highlight's text in document order, after its key */
  const highlights = (text: string, ranges: Map<string, Array<{ start: number; end: number }>>) =>
    [...ranges.entries()]
      .flatMap(([key, list]) => list.map(range => ({ key, range })))
      .sort((a, b) => a.range.start - b.range.start)
      .map(({ key, range }) => key + ': ' + text.slice(range.start, range.end));

  it.each<[string, string, string[]]>([
    ['an escaped { and } around a highlight', '\\{==x==\\}', ['yellow: ==x==']],
    ['a highlight after three backslashes and a {', '\\\\\\{==x==\\}', ['yellow: ==x==']],
    ['an escaped { and } around a highlight in text', 'a \\{==x==\\} b', ['yellow: ==x==']],
    ['a colored highlight after an escaped {', 'a \\{==x=={red} b', ['red: ==x=={red}']],
    ['a highlight after an escaped { without a closing brace', 'a \\{==x== b', ['yellow: ==x==']],
    ['an escaped { and } around a highlight in an insertion', '{++a \\{==x==\\} b++}', ['yellow: ==x==']],
    ['an escaped { and } around a highlight in a critic highlight', '{==a \\{==x==\\} b==}', ['critic: a \\{==x==\\} b', 'yellow: ==x==']],
    ['an escaped critic highlight, whose == before a } closes none', 'a \\{==x==} b', []],
    ['a critic highlight', 'a {==x==} b', ['critic: x']],
    ['a critic highlight after an escaped backslash', 'a \\\\{==x==} b', ['critic: x']],
    ['a highlight', 'a ==x== b', ['yellow: ==x==']],
    ['an escaped opener', 'a \\==x== b', []],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(highlights(text, extractAllDecorationRanges(text, 'yellow').highlights)).toEqual(expected);
    expect(highlights(text, extractHighlightRanges(text, 'yellow'))).toEqual(expected);
  });

  // Export reads a highlight there, its { text, but the preview none, and
  // only a search past it for its ==} could tell the two apart
  it('reads no highlight after a {== that no ==} closes, as the preview does', () => {
    const text = 'a {==x== b';
    expect(highlights(text, extractAllDecorationRanges(text, 'yellow').highlights)).toEqual([]);
    expect(highlights(text, extractHighlightRanges(text, 'yellow'))).toEqual([]);
  });
});

// A closing == right after a { that no odd run of backslashes escapes, a
// {=='s, closes no highlight, as export and the preview read it, whether or
// not a ==} closes that {==: a == b {==c==}{>>n<<}, which import writes for
// Word's a == b before a commented c, is a critic highlight on c. The
// decorations read a {== that a ==} closes as its own span, but closed a
// highlight on the == of one that none closes, and on the == of any {== in
// a CriticMarkup span's text
describe('Editor decorations read no highlight that a {==\'s == would close', () => {
  /** Each highlight's text in document order, after its key */
  const highlights = (text: string, ranges: Map<string, Array<{ start: number; end: number }>>) =>
    [...ranges.entries()]
      .flatMap(([key, list]) => list.map(range => ({ key, range })))
      .sort((a, b) => a.range.start - b.range.start)
      .map(({ key, range }) => key + ': ' + text.slice(range.start, range.end));

  it.each<[string, string, string[]]>([
    ['an opener before a {== that no ==} closes', 'P ==a {==c Q', []],
    ['a colored highlight\'s opener before a {== that no ==} closes', 'P ==a {=={red} Q', []],
    ['an opener before a critic highlight in an insertion', '{++==a {==c==} b++}', ['critic: c']],
    ['an opener before a {== that no ==} closes in an insertion', '{++==a {==c b++}', []],
    // As before
    ['an == in text before a commented critic highlight', 'P a == b {==c==}{>>n<<} Q', ['critic: c']],
    ['an opener before a critic highlight', 'P ==a {==c==} Q', ['critic: c']],
    ['an opener after an escaped one before a critic highlight', 'P \\==a b== {==c==} Q', ['critic: c']],
    ['a highlight closed after an escaped {', 'P ==a \\{==c Q', ['yellow: ==a \\{==']],
    ['a colored highlight closed after an escaped {', 'P ==a \\{=={red} Q', ['red: ==a \\{=={red}']],
    ['a highlight closed after an escaped { in an insertion', '{++==a \\{==c b++}', ['yellow: ==a \\{==']],
    ['a highlight', '==a==', ['yellow: ==a==']],
    ['a { in a highlight', '==a {b==', ['yellow: ==a {b==']],
    ['a highlight around a critic highlight', '==a {==c==} b==', ['yellow: ==a {==c==} b==', 'critic: c']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(highlights(text, extractAllDecorationRanges(text, 'yellow').highlights)).toEqual(expected);
    expect(highlights(text, extractHighlightRanges(text, 'yellow'))).toEqual(expected);
  });
});

// One == the editor read as a format highlight's opener, as x == y in a
// paragraph or keep if foreign == 1 in a Stata block, took the next
// highlight's opener as its closer, and so on through the document: its scan
// read past a paragraph's end, and dropped what overlapped code only after.
// Export and the preview read each highlight in its paragraph's text alone,
// and in a table's cell's.
describe('Editor decorations pair no highlight past its paragraph', () => {
  type Range = { start: number; end: number };
  /** What the editor paints, in document order: each highlight's text after
   *  its key, each span's text after what it is */
  const painted = (text: string) => {
    const all = editorDecorationRanges(text, 'yellow');
    const named: Array<[string, Range]> = [
      ...[...all.highlights].flatMap(([key, list]) => list.map(range => [key, range] as [string, Range])),
      ...all.additions.map(range => ['addition', range] as [string, Range]),
      ...all.deletions.map(range => ['deletion', range] as [string, Range]),
      ...all.substitutionOld.map(range => ['old', range] as [string, Range]),
      ...all.substitutionNew.map(range => ['new', range] as [string, Range]),
      ...all.comments.map(range => ['comment', range] as [string, Range]),
    ];
    return named
      .sort((a, b) => a[1].start - b[1].start || b[1].end - a[1].end)
      .map(([name, range]) => name + ': ' + text.slice(range.start, range.end));
  };
  const ab = ['yellow: ==a==', 'yellow: ==b=='];

  it.each<[string, string, string[]]>([
    ['an == in a paragraph before one with highlights', 'If x == y then.\n\nSee ==a== and ==b==.', ab],
    ['an == in a code span before a paragraph with highlights', 'A `x == y` b.\n\nSee ==a== and ==b==.', ab],
    ['an == in a code span before one highlight', 'A `x == y` b.\n\nSee ==a==.', ['yellow: ==a==']],
    ['an == in a fenced block', '```stata\nkeep if foreign == 1\n```\n\nSee ==a== and ==b==.', ab],
    ['an == in an indented block', '    keep if foreign == 1\n\nSee ==a== and ==b==.', ab],
    ['an == before colored highlights', 'If x == y.\n\n==a=={red} and ==b=={blue}', ['red: ==a=={red}', 'blue: ==b=={blue}']],
    ['an == in a list item before the next', '- x == y\n- See ==a== and ==b==', ab],
    ['an == in a heading before the paragraph under it', '# x == y\nSee ==a== and ==b==', ab],
    ['an == in a quote\'s paragraph before its next', '> x == y\n>\n> See ==a== and ==b==', ab],
    ['an == in a table\'s row before the next', '| x == y |\n|---|\n| ==a== and ==b== |', ab],
    ['an opener and a closer a blank line apart', '==a\n\nb==', []],
    ['an opener and a closer a fenced block apart', '==a\n```\nx\n```\nb== and ==c==', ['yellow: == and ==']],
    ['an opener and a closer in a table\'s cells', '| a | b |\n|---|---|\n| ==x | y== |', []],
    ['an == before a paragraph with highlights and a code span', 'x == y\n\n`code` ==a== and ==b==', ab],
    // Its paragraph's == that export reads as text closed it before
    ['an == before an equation that holds one', 'x == y\n\n$a == b$ ==real==', ['yellow: ==real==']],
    ['an == before a link whose destination holds one', 'x == y\n\n[l](u==v) ==real==', ['yellow: ==real==']],
    ['an == before an HTML comment that holds one', 'x == y\n\na <!-- == --> ==real==', ['yellow: ==real==']],
    // A comment's <<} and an autolink, after which export reads on
    ['an == before a comment and a highlight', 'x == y\n\np {>>q<<} ==r==', ['comment: q', 'yellow: ==r==']],
    ['an == before an email address\'s autolink and a highlight', 'x == y\n\n<a@b.co> ==r==', ['yellow: ==r==']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(painted(text)).toEqual(expected);
  });

  // As before, and as export and the preview read them
  it.each<[string, string, string[]]>([
    ['a highlight over a line end in its paragraph', '==a\nb==', ['yellow: ==a\nb==']],
    ['a highlight over a line end in a list item', '- ==a\n  b==', ['yellow: ==a\n  b==']],
    ['a highlight over a line end in a quote', '> ==a\n> b==', ['yellow: ==a\n> b==']],
    ['an == before a highlight in its paragraph, which export pairs with the highlight\'s opener', 'If x == y then ==a==.', ['yellow: == y then ==']],
    ['an insertion over a blank line', '{++a\n\nb++}', ['addition: a\n\nb']],
    ['a critic highlight over a blank line', '{==a\n\nb==}', ['critic: a\n\nb']],
    ['a highlight over a blank line in an insertion', '{++==a\n\nb==++}', ['yellow: ==a\n\nb==', 'addition: ==a\n\nb==']],
    ['a highlight around an insertion over a blank line', '==a {++b\n\nc++} d==', ['yellow: ==a {++b\n\nc++} d==', 'addition: b\n\nc']],
    ['a comment\'s opener in a code span', 'A `{>>` b.\n\nSee {>>a<<} and {>>b<<}.', ['comment: a', 'comment: b']],
    ['an escaped opener', '\\==a\n\nb ==c==', ['yellow: ==c==']],
    ['highlights and CriticMarkup in code', '`==a== {++b++}`\n\n```\n{--c--}\n```', []],
    ['a highlight that holds a code span', '==a `b` c==', []],
    ['an insertion that holds a code span', '{++a `b` c++}', []],
    ['an insertion whose closer is in a code span', '{++a `x++}` b++} {++c++}', ['addition: c']],
    // Where a paragraph holds an == that export reads as text, as one in
    // code, the highlights the editor read before, in that paragraph
    ['an == in code before an HTML comment that holds one', '`x == y` <!-- == --> ==real==', ['yellow: ==real==']],
    ['an == before a paragraph that holds one in code', 'x == y\n\n`==` ==real==', ['yellow: ==real==']],
    ['an insertion and a comment after an == in code', 'a `c== ` {>> `==a` {++b++} {>>b<<} c', ['addition: b', 'comment: b']],
    // An == that export reads as text, in a URL that linkify links, in a
    // link's destination past a ( ) in it, or in its title past a ), in a
    // link's text past a [ ] in it, or in an autolink, which a lone ==
    // before it closed before
    ['an == in code before a URL that holds one', '`x == y`\n\nhttps://example.com/?q==yes==', []],
    ['an == in code before a URL that holds one and a highlight', '`x == y`\n\nhttps://e.com/?q==a ==b==', ['yellow: ==b==']],
    ['an == in code before a link whose destination holds one after a ( )', '`x == y`\n\n[a](u(x)==y) ==d==', ['yellow: ==d==']],
    ['an == in code before a link whose title holds one after a )', '`x == y`\n\n[a](u "x ) == y") ==d==', ['yellow: ==d==']],
    ['an == in code before a citation that holds one after a [ ]', '`x == y`\n\n[see [x] == @key] ==d==', ['yellow: ==d==']],
    ['an == in code before an autolink that holds one', '`x == y`\n\n<https://e.com/?q==a> ==r==', ['yellow: ==r==']],
  ])('reads %s as before', (_name, text, expected) => {
    expect(painted(text)).toEqual(expected);
  });

  // An == or an opener in code still pairs as before, so export and the
  // preview read a and b in each, where the editor reads as before
  it.each<[string, string, string[]]>([
    ['an == in a code span before highlights in its paragraph', 'A `x == y` b ==a== and ==b==.', ['yellow: == and ==']],
    ['an insertion\'s opener in a code span', 'A `{++` b.\n\nSee {++a++} and {++b++}.', ['addition: b']],
  ])('still reads %s as before', (_name, text, expected) => {
    expect(painted(text)).toEqual(expected);
  });

  // Each paragraph's end is found by binary search, and each range's
  // overlap with code too, where each stepped through every code region
  // before it, which took seconds here; linear takes milliseconds
  it.each<[string, (n: number) => string]>([
    ['many lone == in paragraphs', n => 'If x == y then.\n\n'.repeat(n) + 'See ==a==.'],
    ['many lone == in one paragraph', n => 'x == y '.repeat(n) + '\n'],
    ['many code spans holding ==, each before a highlight', n => 'A `x == y` b ==a==.\n'.repeat(n)],
    ['many code spans before many highlights', n => '`x` '.repeat(n) + '\n\n' + '==a== '.repeat(n)],
    ['many CriticMarkup openers with no closer in code', n => 'a `{++` `{--` `{~~` `{==` `{>>` b\n'.repeat(n) + '{++c++}'],
    ['many table rows with highlights across cells', n => '| a | b |\n|---|---|\n' + '| ==x | y== and ==z== |\n'.repeat(n)],
    ['many paragraphs that hold an == in code, each after a lone ==', n => 'x == y\n\n`==` ==a==\n\n'.repeat(n)],
    ['many paragraphs that hold an == after a <, a [ or a $', n => 'x == y\n\na <b ==c [d ==e] $f == g\n\n'.repeat(n)],
    ['many paragraphs that hold an == in a URL or a link', n => 'x == y\n\na https://e.com/?q==b [c](d(e)==f) ==g==\n\n'.repeat(n)],
    ['many paragraphs that hold an opener in code, before one closer', n => 'x == y\n\n' + 'a `{++` b\n\n'.repeat(n) + '==z== {++end++}'],
  ])('decorates %s in linear time', (_name, input) => {
    const text = input(100_000);
    expect(fastestRun(() => editorDecorationRanges(text, 'yellow'))).toBeLessThan(1000);
  }, 120000);

  it('reads what those texts hold', () => {
    expect(painted('If x == y then.\n\n'.repeat(3) + 'See ==a==.')).toEqual(['yellow: ==a==']);
    expect(painted('A `x == y` b ==a==.\n'.repeat(2))).toEqual(['yellow: ==a==']);
    expect(painted('a `{++` `{--` `{~~` `{==` `{>>` b\n'.repeat(2) + '{++c++}')).toEqual([]);
    expect(painted('| a | b |\n|---|---|\n' + '| ==x | y== and ==z== |\n'.repeat(2))).toEqual(['yellow: == and ==', 'yellow: == and ==']);
    expect(painted('x == y\n\n`==` ==a==\n\n'.repeat(2))).toEqual(['yellow: ==a==', 'yellow: ==a==']);
    expect(painted('x == y\n\na <b ==c [d ==e] $f == g\n\n'.repeat(2))).toEqual(['yellow: ==e] $f ==', 'yellow: ==e] $f ==']);
    expect(painted('x == y\n\na https://e.com/?q==b [c](d(e)==f) ==g==\n\n'.repeat(2))).toEqual(['yellow: ==f) ==', 'yellow: ==b [c](d(e)==', 'yellow: ==g==']);
    expect(painted('x == y\n\n' + 'a `{++` b\n\n'.repeat(2) + '==z== {++end++}')).toEqual(['yellow: ==z==']);
  });
});

describe('Editor decorations read the blocks a span over lines joins', () => {
  type Range = { start: number; end: number };
  /** What the editor paints, in document order (see the describe above) */
  const painted = (text: string) => {
    const all = editorDecorationRanges(text, 'yellow');
    const named: Array<[string, Range]> = [
      ...[...all.highlights].flatMap(([key, list]) => list.map(range => [key, range] as [string, Range])),
      ...all.additions.map(range => ['addition', range] as [string, Range]),
      ...all.deletions.map(range => ['deletion', range] as [string, Range]),
      ...all.substitutionOld.map(range => ['old', range] as [string, Range]),
      ...all.substitutionNew.map(range => ['new', range] as [string, Range]),
      ...all.comments.map(range => ['comment', range] as [string, Range]),
    ];
    return named
      .sort((a, b) => a[1].start - b[1].start || b[1].end - a[1].end)
      .map(([name, range]) => name + ': ' + text.slice(range.start, range.end));
  };

  // Export and the preview join a span's lines before they read the blocks,
  // so the lines after it go on in its paragraph, where a parse of the text
  // reads a heading or a table. A span in code in a highlight is text to
  // them, whose closer comes after it; read as text to its }, the
  // highlight's scan would end there, and its closing == open the next
  it.each<[string, string, string[]]>([
    ['a highlight after an insertion over a heading\'s line', '{++a\n# b++} ==c\nd==', ['addition: a\n# b', 'yellow: ==c\nd==']],
    ['a highlight after a comment over a heading\'s line', '{>>a\n# b<<} ==c\nd==', ['comment: a\n# b', 'yellow: ==c\nd==']],
    ['a highlight after an insertion over a table\'s rows', '{++a\n| b |\n| - |\n++} ==c\nd==', ['addition: a\n| b |\n| - |\n', 'yellow: ==c\nd==']],
    ['a highlight after an insertion over a heading\'s line, with \\r\\n', '{++a\r\n# b++} ==c\r\nd==', ['addition: a\r\n# b', 'yellow: ==c\r\nd==']],
    ['the highlight after one that holds an insertion in code', '==a `{++b++}` c==. Next ==d==.', ['yellow: ==d==']],
    ['the highlight after one that holds a deletion in code', '==a `{--b--}` c== ==d==', ['yellow: ==d==']],
    ['the highlight after one that holds a substitution in code', '==a `{~~b~>c~~}` d== ==e==', ['yellow: ==e==']],
    ['the highlight after one that holds a comment in code', '==a `{>>b<<}` c== ==d==', ['yellow: ==d==']],
    ['the highlight after one that holds a comment with an ID in code', '==a `{#x>>b<<}` c== ==d==', ['yellow: ==d==']],
    ['the highlight after one that holds an opener in code whose span ends past it', '==a `{++b` c++} d== ==e==', ['yellow: ==e==']],
    ['an insertion in an HTML block after an opener in code', '```{++```\n<!--{++b++}', []],
    ['a critic highlight in a link\'s definition after an opener in code', '[1]:`{==`{==c==}', []],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(painted(text)).toEqual(expected);
  });

  // As before, and as export and the preview read them
  it.each<[string, string, string[]]>([
    ['a highlight after an insertion over a list item\'s line', '{++a\n- b++} ==c\nd==', ['addition: a\n- b', 'yellow: ==c\nd==']],
    ['a highlight after a fenced block a span\'s fence line opens', '==\n\n{--a\n--}\n```\n==\n```\n==l==', ['deletion: a\n', 'yellow: ==l==']],
    ['a highlight after a code span after a span over lines', '==\n\n{--a\n--} `==`==l==', ['deletion: a\n', 'yellow: ==l==']],
    ['an insertion in a note\'s definition, which export reads in the note', '[^1]: {++a++}', ['addition: a']],
  ])('reads %s as before', (_name, text, expected) => {
    expect(painted(text)).toEqual(expected);
  });

  // The blocks are read from what preprocessing writes, by offsets it maps
  // once, and each span in code from its closer, found by binary search
  it.each<[string, number, (n: number) => string]>([
    ['many code spans holding spans in highlights', 100_000, n => '==a `{++b++}` c== '.repeat(n)],
    ['many openers in code whose spans end past it, in highlights', 100_000, n => '==a `{++b` c '.repeat(n) + '++}'],
    ['many spans over lines', 50_000, n => '{++a\n# b++} ==c\nd==\n\n'.repeat(n)],
    ['many HTML blocks and links\' definitions', 50_000, n => '<div>\n==a== {++b++}\n</div>\n\n[l]: u\n\n'.repeat(n)],
  ])('decorates %s in linear time', (_name, n, input) => {
    const text = input(n);
    expect(fastestRun(() => editorDecorationRanges(text, 'yellow'))).toBeLessThan(1000);
  }, 120000);

  it('reads what those texts hold', () => {
    expect(painted('==a `{++b++}` c== '.repeat(2))).toEqual([]);
    expect(painted('==a `{++b` c '.repeat(2) + '++}')).toEqual([]);
    expect(painted('{++a\n# b++} ==c\nd==\n\n'.repeat(2))).toEqual(['addition: a\n# b', 'yellow: ==c\nd==', 'addition: a\n# b', 'yellow: ==c\nd==']);
    expect(painted('<div>\n==a== {++b++}\n</div>\n\n[l]: u\n\n'.repeat(2))).toEqual(['yellow: ==a==', 'addition: b', 'yellow: ==a==', 'addition: b']);
  });
});

describe('Editor decorations read as before where export may read the blocks otherwise', () => {
  type Range = { start: number; end: number };
  /** What the editor paints, in document order (see the describe above) */
  const painted = (text: string) => {
    const all = editorDecorationRanges(text, 'yellow');
    const named: Array<[string, Range]> = [
      ...[...all.highlights].flatMap(([key, list]) => list.map(range => [key, range] as [string, Range])),
      ...all.additions.map(range => ['addition', range] as [string, Range]),
      ...all.deletions.map(range => ['deletion', range] as [string, Range]),
      ...all.substitutionOld.map(range => ['old', range] as [string, Range]),
      ...all.substitutionNew.map(range => ['new', range] as [string, Range]),
      ...all.comments.map(range => ['comment', range] as [string, Range]),
    ];
    return named
      .sort((a, b) => a[1].start - b[1].start || b[1].end - a[1].end)
      .map(([name, range]) => name + ': ' + text.slice(range.start, range.end));
  };

  // A note's definition's later line, which a parse reads as a link's
  // title, and a span after a backtick that the parse of code spans pairs
  // across an HTML block, which export reads, and a highlight before a span
  // across a table's rows, which preprocessing leaves as it is, so export
  // reads each row on its own. And a span after code spans whose backticks
  // the parse pairs across blocks
  it.each<[string, string, string[]]>([
    ['an insertion on a note\'s definition\'s later line', 'See[^1].\n\n[^1]: https://example.com\n    "{++added++}"', ['addition: added']],
    ['an insertion after a backtick a code span\'s parse pairs across an HTML block', 'Before `\n<div>\n</div>\n\n` {++added++}\n# After `', ['addition: added']],
    ['a deletion after code spans whose backticks pair across blocks', '- `{>>` x ` b\n\n- `{--` y\n\n# `<<}`\n\n{--d--}', ['deletion: d']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(painted(text)).toEqual(expected);
  });

  // Where neither the opener nor the closer either reading takes is in such
  // a block, though what the editor read before held one
  it.each<[string, string, string[]]>([
    ['an == in a paragraph before an HTML comment\'s block and a paragraph with highlights', 'If x == y.\n\n<!-- note -->\n\nSee ==a== and ==b==.', ['yellow: ==a==', 'yellow: ==b==']],
    ['an opener and a closer an HTML block apart', '==b\n\n<div>\n\nc== d', []],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(painted(text)).toEqual(expected);
  });

  it('reads the highlight after one before a span across a table\'s rows, as before', () => {
    // Its opener's scan read past the row's end
    expect(painted('| x == y |\n|---|\n| ==b {++c |\n| d++} ==e== |')).toContain('yellow: ==e==');
  });

  it('reads the rows of a table with a span across them as export does', () => {
    // Before, the first row's lone == took the second's opener
    expect(painted('| x == y |\n|---|\n| ==b {++c |\n| d++} ==e== |')).toEqual(['addition: c |\n| d', 'yellow: ==e==']);
  });

  // An == in an HTML block that closed a highlight before, which the editor
  // reads as before, closes none and opens none, as before: the highlight
  // the editor read before was the one after a, which it no longer reads
  it('reads the highlight after an HTML block whose == closed one before, as before', () => {
    expect(painted('x == y\n\n==a==\n\n<div>\n==\n</div>\n\n==b==')).toContain('yellow: ==b==');
  });

  it('reads the highlights around an HTML block whose == closed one before as export does', () => {
    expect(painted('x == y\n\n==a==\n\n<div>\n==\n</div>\n\n==b==')).toEqual(['yellow: ==a==', 'yellow: ==b==']);
  });

  // Where the highlight that a lone == took before ends in an HTML block,
  // which export reads as HTML, or on a quote's lazy line, before which
  // export ends the quote. And spans from code, and the highlights in a
  // span's text, which the editor reads as before
  it.each<[string, string, string[]]>([
    ['an insertion in an HTML block after an opener in code', '`{++`\n\n<div>\n{++b++}\n</div>', []],
    ['a highlight in an HTML block after an == in code', '`x == y`\n\n<div>\n==h==\n</div>', []],
    ['a highlight in an HTML comment\'s block after a lone == in a list item', '- a == `b`\n\n<!--\n==h==\n-->', []],
    ['a highlight in a comment\'s text after an == in a code span over a blank line', '{>>a `x == \n\ny` ==d== b<<}', []],
    ['an insertion in an HTML comment\'s block in a comment from code', '`{#x>>`\n\n<!--\n{++i++}\n-->\n\n```\n<<}\n```', []],
    ['a highlight from a quote\'s line to a lazy line after an == in code', '```\nx == 1\n```\n\n> q ==h\ni==', []],
  ])('reads %s as before', (_name, text, expected) => {
    expect(painted(text)).toEqual(expected);
  });

  // What the editor read before is read once at most, and each unsure
  // region's overlap found by binary search
  it.each<[string, number, (n: number) => string]>([
    ['many openers in code before HTML blocks', 50_000, n => '`{++`\n\n<div>\n{++b++}\n</div>\n\n'.repeat(n)],
    ['many == in code before HTML blocks', 50_000, n => '`x == y`\n\n<div>\n==h==\n</div>\n\n'.repeat(n)],
    ['many lone == before an HTML block', 100_000, n => 'x == y\n\n'.repeat(n) + '<div>\n==h==\n</div>'],
    ['many lone == each before an HTML comment\'s block and a highlight', 50_000, n => 'x == y\n\n<!-- c -->\n\n==a==\n\n'.repeat(n)],
    ['many highlights each before an HTML block that holds an ==', 50_000, n => 'x == y\n\n==a==\n\n<div>\n==\n</div>\n\n'.repeat(n)],
    ['many quotes with a lazy line', 50_000, n => '> a ==h\nb==\n\n'.repeat(n)],
    ['many code spans whose backticks pair across blocks', 100_000, n => '`{>>` x ` b\n\n'.repeat(n) + '<<}'],
    ['many comments that hold code spans over blank lines', 50_000, n => '{>>a `x == \n\ny` ==d== b<<}\n\n'.repeat(n)],
  ])('decorates %s in linear time', (_name, n, input) => {
    const text = input(n);
    expect(fastestRun(() => editorDecorationRanges(text, 'yellow'))).toBeLessThan(1000);
  }, 120000);

  it('reads what those texts hold', () => {
    expect(painted('`{++`\n\n<div>\n{++b++}\n</div>\n\n'.repeat(2))).toEqual([]);
    // The second block's highlight, as before
    expect(painted('`x == y`\n\n<div>\n==h==\n</div>\n\n'.repeat(2))).toEqual(['yellow: ==h==']);
    expect(painted('x == y\n\n'.repeat(2) + '<div>\n==h==\n</div>')).toEqual(['yellow: ==h==']);
    expect(painted('`{>>` x ` b\n\n'.repeat(2) + '<<}')).toEqual([]);
    expect(painted('{>>a `x == \n\ny` ==d== b<<}\n\n'.repeat(2))).toEqual([]);
    expect(painted('x == y\n\n<!-- c -->\n\n==a==\n\n'.repeat(2))).toEqual(['yellow: ==a==', 'yellow: ==a==']);
    expect(painted('x == y\n\n==a==\n\n<div>\n==\n</div>\n\n'.repeat(2))).toEqual(['yellow: ==a==', 'yellow: ==a==']);
  });
});
