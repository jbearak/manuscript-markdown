import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import MarkdownIt from 'markdown-it';
import { commentEnds, linearInlineComments } from './inline-html-comments';
import { parseMd } from './md-to-docx';
import { manuscriptMarkdownPlugin } from './preview/manuscript-markdown-plugin';
import { fastestRun } from './test-timing';

// The text after <!-- of markdown-it's comment regex (see html_re.mjs)
const COMMENT_TEXT_RE = /^(?:[^-]|-[^-]|--[^>])*-->/;

const pieces = ['<!--', '-->', '--->', '<!-->', '<!--->', '-', '--', '>', '<', '!', 'a', ' ', '\n', '`', '*', '[', ']', '(', ')', '<a>', '</a>'];
const texts = fc.array(fc.constantFrom(...pieces), { maxLength: 30 }).map(parts => parts.join(''));

describe('comments in a paragraph\'s text', () => {
  test('end where markdown-it\'s regex ends them, from each offset', () => {
    fc.assert(fc.property(texts, src => {
      const ends = commentEnds(src);
      for (let at = 0; at <= src.length; at++) {
        const match = COMMENT_TEXT_RE.exec(src.slice(at));
        expect(ends[at]).toBe(match ? at + match[0].length - 3 : -1);
      }
    }), { numRuns: 1000 });
  });

  test('render as markdown-it renders them', () => {
    const plain = new MarkdownIt({ html: true });
    const linear = new MarkdownIt({ html: true }).use(linearInlineComments);
    fc.assert(fc.property(texts, src => {
      expect(linear.render(src)).toBe(plain.render(src));
    }), { numRuns: 1000 });
  });

  test.each([
    ['export', (text: string) => parseMd(text)],
    ['the preview', (text: string) => new MarkdownIt({ html: true }).use(manuscriptMarkdownPlugin).render(text)],
  ])('are read in %s in time linear in a paragraph of many that don\'t end', (_name, read) => {
    // markdown-it's regex read the rest of the paragraph from each <!--,
    // and markdown-it reads <!-- ---> as text, so a paragraph of many took
    // time past the square of their number. Among inline Markdown, so the
    // time is long enough that the timer's noise doesn't decide the ratio
    const time = (n: number) => {
      const text = ('a <!-- ---> ' + '*b* `c` [d](e) '.repeat(4)).repeat(n) + '\n';
      return fastestRun(() => read(text));
    };
    time(500);
    const small = time(500);
    expect(time(2000) / small).toBeLessThan(8);
  }, 120000);
});
