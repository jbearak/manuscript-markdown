import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { wrapColoredHighlight } from './formatting';
import { VALID_COLOR_IDS, extractHighlightRanges } from './highlight-colors';

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
        expect(doc.slice(criticRanges[0].start, criticRanges[0].end)).toBe(doc);
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

  it('should fall back to default for unrecognized color', () => {
    fc.assert(
      fc.property(safeTextGen, (text) => {
        const doc = '==' + text + '=={bogus}';
        const ranges = extractHighlightRanges(doc, 'yellow');
        const yellowRanges = ranges.get('yellow') || [];
        expect(yellowRanges.length).toBe(1);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: highlight-colors, Property 9: Default highlight color respects configuration
describe('Property 9: Default highlight color respects configuration', () => {
  const { VALID_COLOR_IDS, setDefaultHighlightColor, getDefaultHighlightColor, extractHighlightRanges } = require('./highlight-colors');
  const colorIdGen = fc.constantFrom(...VALID_COLOR_IDS as string[]);
  const safeTextGen = fc.string({ minLength: 1, maxLength: 50 }).filter(
    (s: string) => !s.includes('=') && !s.includes('{') && !s.includes('}')
  );

  it('should apply configured default color to ==text== in extractHighlightRanges', () => {
    fc.assert(
      fc.property(safeTextGen, colorIdGen, (text: string, configColor: string) => {
        const doc = '==' + text + '==';
        const ranges = extractHighlightRanges(doc, configColor);
        const colorRanges = ranges.get(configColor) || [];
        expect(colorRanges.length).toBe(1);
      }),
      { numRuns: 100 }
    );
  });

  it('should update getDefaultHighlightColor after setDefaultHighlightColor', () => {
    fc.assert(
      fc.property(colorIdGen, (color: string) => {
        setDefaultHighlightColor(color);
        expect(getDefaultHighlightColor()).toBe(color);
      }),
      { numRuns: 14 }
    );
    // Reset
    setDefaultHighlightColor('yellow');
  });

  it('should fall back to yellow for invalid config values', () => {
    setDefaultHighlightColor('not-a-color');
    expect(getDefaultHighlightColor()).toBe('yellow');
    setDefaultHighlightColor('yellow');
  });
});
