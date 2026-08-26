import { describe, it, expect } from 'bun:test';
import MarkdownIt from 'markdown-it';
import { manuscriptMarkdownPlugin } from './manuscript-markdown-plugin';

/** Parse markdown with the plugin and return tokens with their .map values. */
function parseWithPlugin(src: string): Array<{ type: string; map: [number, number] | null }> {
  const md = new MarkdownIt({ html: true });
  (md as any).manuscriptColors = 'github'; // suppress color scheme marker
  md.use(manuscriptMarkdownPlugin);
  const env = {};
  const tokens = md.parse(src, env);
  return tokens.map(t => ({ type: t.type, map: t.map }));
}

/** Find the first token of a given type. */
function findToken(tokens: Array<{ type: string; map: [number, number] | null }>, type: string) {
  return tokens.find(t => t.type === type);
}

/** Find all tokens of a given type. */
function findAllTokens(tokens: Array<{ type: string; map: [number, number] | null }>, type: string) {
  return tokens.filter(t => t.type === type);
}

describe('Scroll sync: token .map remapping after preprocessing', () => {
  describe('grid tables', () => {
    it('remaps paragraph after grid table to correct original line', () => {
      const src = [
        'Before',               // 0
        '',                     // 1
        '+---+---+',            // 2
        '| a | b |',            // 3
        '+---+---+',            // 4
        '| c | d |',            // 5
        '+---+---+',            // 6
        '',                     // 7
        'After paragraph',      // 8
      ].join('\n');

      const tokens = parseWithPlugin(src);
      // Find the paragraph_open for "After paragraph"
      const paragraphs = findAllTokens(tokens, 'paragraph_open');
      // The last paragraph_open should be "After paragraph"
      const afterPara = paragraphs[paragraphs.length - 1];
      expect(afterPara).toBeDefined();
      expect(afterPara.map).not.toBeNull();
      expect(afterPara.map![0]).toBe(8);
    });

    it('preserves correct map for content before grid table', () => {
      const src = [
        'Before',               // 0
        '',                     // 1
        '+---+---+',            // 2
        '| a | b |',            // 3
        '+---+---+',            // 4
      ].join('\n');

      const tokens = parseWithPlugin(src);
      const para = findToken(tokens, 'paragraph_open');
      expect(para).toBeDefined();
      expect(para!.map![0]).toBe(0);
    });

    it('remaps heading after grid table correctly', () => {
      const src = [
        '+---+---+',            // 0
        '| a | b |',            // 1
        '+---+---+',            // 2
        '| c | d |',            // 3
        '+---+---+',            // 4
        '',                     // 5
        '# Heading After',      // 6
      ].join('\n');

      const tokens = parseWithPlugin(src);
      const heading = findToken(tokens, 'heading_open');
      expect(heading).toBeDefined();
      expect(heading!.map![0]).toBe(6);
    });
  });

  describe('LaTeX environments', () => {
    it('remaps paragraph after LaTeX block with collapsed blank lines', () => {
      const src = [
        'Before',                    // 0
        '',                          // 1
        '\\begin{equation}',         // 2
        'x = 1',                     // 3
        '',                          // 4
        'y = 2',                     // 5
        '\\end{equation}',           // 6
        '',                          // 7
        'After paragraph',           // 8
      ].join('\n');

      const tokens = parseWithPlugin(src);
      const paragraphs = findAllTokens(tokens, 'paragraph_open');
      const afterPara = paragraphs[paragraphs.length - 1];
      expect(afterPara).toBeDefined();
      expect(afterPara.map).not.toBeNull();
      expect(afterPara.map![0]).toBe(8);
    });
  });

  describe('CriticMarkup', () => {
    it('keeps a leading changed line anchored before a later unchanged line', () => {
      const tokens = parseWithPlugin('Before {++a\nb++}\nAfter');
      const paragraph = findToken(tokens, 'paragraph_open');

      expect(paragraph).toBeDefined();
      expect(paragraph!.map).toEqual([0, 3]);
    });

    it('remaps paragraph after CriticMarkup with internal blank lines', () => {
      const src = [
        '{++added text',             // 0
        '',                          // 1
        'more added text++}',        // 2
        '',                          // 3
        'After paragraph',           // 4
      ].join('\n');

      const tokens = parseWithPlugin(src);
      const paragraphs = findAllTokens(tokens, 'paragraph_open');
      const afterPara = paragraphs[paragraphs.length - 1];
      expect(afterPara).toBeDefined();
      expect(afterPara.map).not.toBeNull();
      expect(afterPara.map![0]).toBe(4);
    });
  });

  describe('combined preprocessors', () => {
    it('remaps correctly when grid table and CriticMarkup both present', () => {
      const src = [
        '+---+---+',            // 0
        '| a | b |',            // 1
        '+---+---+',            // 2
        '| c | d |',            // 3
        '+---+---+',            // 4
        '',                     // 5
        '{++added',             // 6
        '',                     // 7
        'more++}',              // 8
        '',                     // 9
        'Final paragraph',      // 10
      ].join('\n');

      const tokens = parseWithPlugin(src);
      const paragraphs = findAllTokens(tokens, 'paragraph_open');
      const finalPara = paragraphs[paragraphs.length - 1];
      expect(finalPara).toBeDefined();
      expect(finalPara.map).not.toBeNull();
      expect(finalPara.map![0]).toBe(10);
    });
  });

  describe('merged alerts', () => {
    it('split blockquote_open tokens retain .map from the original blockquote', () => {
      const src = [
        '> [!NOTE]',
        '> note text',
        '> [!TIP]',
        '> tip text',
      ].join('\n');

      const tokens = parseWithPlugin(src);
      const bqOpens = findAllTokens(tokens, 'blockquote_open');
      // The multi-alert split should produce two blockquote_open tokens, both with .map
      expect(bqOpens.length).toBe(2);
      for (const bq of bqOpens) {
        expect(bq.map).not.toBeNull();
      }
    });
  });

  describe('no preprocessing needed', () => {
    it('preserves correct maps for plain markdown', () => {
      const src = [
        '# Heading',            // 0
        '',                     // 1
        'Paragraph one',        // 2
        '',                     // 3
        'Paragraph two',        // 4
      ].join('\n');

      const tokens = parseWithPlugin(src);
      const heading = findToken(tokens, 'heading_open');
      expect(heading!.map![0]).toBe(0);

      const paragraphs = findAllTokens(tokens, 'paragraph_open');
      expect(paragraphs[0].map![0]).toBe(2);
      expect(paragraphs[1].map![0]).toBe(4);
    });
  });
});
