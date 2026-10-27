import { describe, expect, test } from 'bun:test';
import MarkdownIt from 'markdown-it';
import { parseMd } from './md-to-docx';
import { manuscriptMarkdownPlugin } from './preview/manuscript-markdown-plugin';

const preview = new MarkdownIt({ html: true, linkify: true }).use(manuscriptMarkdownPlugin);
const paragraph = (markdown: string) => /<p>[\s\S]*<\/p>/.exec(preview.render(markdown))?.[0];

/** The runs of the paragraph export reads `markdown` as, a link's with its href */
function exported(markdown: string): string[] {
  const token = parseMd(markdown).find(t => t.type === 'paragraph');
  return (token?.runs ?? []).map(run => run.type === 'hardbreak' ? '<br>' : run.href ? run.text + ' -> ' + run.href : run.text);
}

describe('a backslash at a line end after a URL', () => {
  test.each([
    ['https://e.com/a\\\nb', 'https://e.com/a'],
    ['see https://e.com/a.\\\nb', 'https://e.com/a'],
    ['https://e.com/a\\b\\\nc', 'https://e.com/a\\b'],
  ])('is a hard break, not the URL\'s, in %j', (markdown, url) => {
    expect(paragraph(markdown)).toContain('<a href="' + encodeURI(url) + '">' + url + '</a>');
    expect(paragraph(markdown)).toContain('<br>');
    expect(exported(markdown)).toContain('<br>');
    expect(exported(markdown)).toContain(url + ' -> ' + encodeURI(url));
  });

  test('is a hard break in CriticMarkup\'s text', () => {
    expect(paragraph('{++https://e.com/a\\\nb++}')).toContain('<a href="https://e.com/a">https://e.com/a</a><br>');
  });

  test('before a blank line in CriticMarkup\'s text is dropped from the URL, as from text, in both', () => {
    // The preview reads the blank line's placeholder, export the line ends
    const markdown = '{++https://e.com/a\\\n\nb++}';
    expect(preview.render(markdown)).toContain('<a href="https://e.com/a">https://e.com/a</a></ins>');
    const runs = parseMd(markdown).flatMap(token => token.criticParaMarkRun?.innerRuns ?? token.runs ?? []);
    expect(runs.filter(run => run.href).map(run => run.text + ' -> ' + run.href)).toEqual(['https://e.com/a -> https://e.com/a']);
  });

  test('escaped, as \\\\, is the URL\'s, and starts no break', () => {
    expect(paragraph('https://e.com/a\\\\\nb')).not.toContain('<br>');
    expect(exported('https://e.com/a\\\\\nb')).not.toContain('<br>');
  });
});
