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
  maskCriticDelimiters,
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

  it('maskCriticDelimiters masks {#id>> and <<} delimiters', () => {
    const text = '{#abc>>hello<<}';
    const masked = maskCriticDelimiters(text);
    expect(masked).toBe('       hello   ');
    expect(masked.length).toBe(text.length);
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
