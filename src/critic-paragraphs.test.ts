import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { convertMdToDocx, parseMd } from './md-to-docx';
import { convertDocx } from './converter';
import { createMarkdownItWithPlugin, renderWithPlugin } from './test-helpers';

const example = '{++This is a sentence.\n\nThis sentence is in another paragraph.\n++}';

describe('paragraphs inside CriticMarkup additions', () => {
  it('exports the reported example as two Word paragraphs and preserves them on import', async () => {
    const { docx } = await convertMdToDocx(example);
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toContain('This is a sentence.');
    expect(paragraphs[1]).toContain('This sentence is in another paragraph.');
    for (const paragraph of paragraphs) expect(paragraph).toContain('<w:ins');
    const imported = await convertDocx(docx);
    const body = imported.markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    expect(body.split(/\n\s*\n/)).toHaveLength(2);
    expect(body).toContain('{++This is a sentence.++}');
    expect(body).toContain('{++This sentence is in another paragraph.');
  });

  it('renders the reported example as two preview paragraphs with original source maps', () => {
    const md = createMarkdownItWithPlugin();
    const tokens = md.parse(example, {});
    expect(tokens.filter(t => t.type === 'paragraph_open').map(t => t.map)).toEqual([[0, 1], [2, 4]]);
    const html = md.render(example);
    expect(html.match(/<p>/g)).toHaveLength(2);
    expect(html.match(/<ins class="manuscript-markdown-addition">/g)).toHaveLength(2);
    expect(html).not.toContain('<br>');
    expect(html).not.toContain('\uE000');
  });

  it('exports a multi-paragraph deletion as two revised Word paragraphs', async () => {
    const { docx } = await convertMdToDocx('{--deleted\n\nmore--}');
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toContain('<w:delText>deleted</w:delText>');
    expect(paragraphs[1]).toContain('<w:delText>more</w:delText>');
    for (const paragraph of paragraphs) expect(paragraph).toMatch(/<w:del\b/);
  });

  it('keeps emphasis and surrounding text in the correct paragraphs', () => {
    const input = 'Before {++**one\n\ntwo**++} after';
    const tokens = parseMd(input);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].runs[0].text).toBe('Before ');
    expect(tokens[1].runs.at(-1)?.text).toBe(' after');
    for (const [index, text] of ['one', 'two'].entries()) {
      expect(tokens[index].runs.find(r => r.type === 'critic_add')?.innerRuns)
        .toEqual([expect.objectContaining({ text, bold: true })]);
    }
    const html = renderWithPlugin(input);
    expect(html).toContain('<p>Before <ins class="manuscript-markdown-addition"><strong>one</strong></ins></p>');
    expect(html).toContain('<p><ins class="manuscript-markdown-addition"><strong>two</strong></ins> after</p>');
  });

  for (const eol of ['\n', '\r\n', '\r']) {
    it('recognizes blank lines with whitespace for ' + JSON.stringify(eol), () => {
      const input = '{++one' + eol + ' \t' + eol + 'two++}';
      expect(parseMd(input)).toHaveLength(2);
      expect(renderWithPlugin(input).match(/<p>/g)).toHaveLength(2);
    });
  }

  it('keeps a single newline and explicit HTML breaks within one paragraph', () => {
    for (const input of ['{++one\ntwo++}', '{++one<br><br>two++}', '{++one<br>\ntwo++}']) {
      expect(parseMd(input)).toHaveLength(1);
      expect(renderWithPlugin(input).match(/<p>/g)).toHaveLength(1);
    }
  });

  it('counts ordinary newlines before and after a revised paragraph boundary in preview maps', () => {
    const input = 'Before\n{++one\n\ntwo++}\nafter';
    const tokens = createMarkdownItWithPlugin().parse(input, {});
    expect(tokens.filter(t => t.type === 'paragraph_open').map(t => t.map)).toEqual([[0, 2], [3, 5]]);
  });

  it('preserves nested revisions and highlights across a blank line', () => {
    for (const inner of ['{--one\n\ntwo--}', '{==one\n\ntwo==}']) {
      const input = '{++' + inner + '++}';
      expect(parseMd(input)).toHaveLength(2);
      expect(renderWithPlugin(input).match(/<p>/g)).toHaveLength(2);
    }
  });

  it('does not produce empty paragraphs at the edges of an addition', () => {
    for (const input of ['{++\n\nfirst\n\nsecond\n\n++}', '{++first\n\nsecond\n\n\n++}']) {
      expect(parseMd(input)).toHaveLength(2);
      expect(renderWithPlugin(input).match(/<p>/g)).toHaveLength(2);
    }
  });

  it('consumes extra blank lines without adding breaks to the next preview paragraph', () => {
    for (const count of [3, 4, 5]) {
      const md = createMarkdownItWithPlugin();
      md.set({ breaks: true });
      const input = '{++one' + '\n'.repeat(count) + 'two++}';
      const tokens = md.parse(input, {});
      expect(tokens.filter(t => t.type === 'paragraph_open').map(t => t.map))
        .toEqual([[0, 1], [count, count + 1]]);
      expect(md.render(input)).toContain('<p><ins class="manuscript-markdown-addition">two</ins></p>');
      expect(md.render(input)).not.toContain('<br>');
    }
    expect(renderWithPlugin('{++one\n\n<br>two++}'))
      .toContain('<p><ins class="manuscript-markdown-addition"><br>two</ins></p>');
  });

  it('keeps blank lines inside code and inline math from splitting the paragraph', () => {
    for (const input of ['{++one `code\n\nspan` two++}', '{++one $x {--old\n\nmore--} y$ two++}']) {
      expect(parseMd(input)).toHaveLength(1);
      expect(renderWithPlugin(input).match(/<p>/g)).toHaveLength(1);
    }
    expect(parseMd('{++one $x\n\ny$ two++}')).toHaveLength(1);
  });

  it('retains list and blockquote context on continuation paragraphs', () => {
    const list = parseMd('5. {++one\n\n   two++}\n6. next');
    expect(list.map(t => t.type)).toEqual(['list_item', 'paragraph', 'list_item']);
    expect(list[1].listContinuation).toEqual({ type: 'ordered', level: 1 });
    const quote = parseMd('> {++one\n>\n> two++}');
    expect(quote.map(t => t.type)).toEqual(['blockquote', 'blockquote']);
    const html = renderWithPlugin('> {++one\n>\n> two++}');
    expect(html.match(/<blockquote>/g)).toHaveLength(1);
    expect(html.match(/<p>/g)).toHaveLength(2);
  });
});
