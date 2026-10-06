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
    // The break goes in the insertion, whose mark Word tracks
    expect(body).toBe('{++This is a sentence.\n\nThis sentence is in another paragraph.++}');
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

describe('tracked paragraph marks', () => {
  async function documentParagraphs(md: string): Promise<string[]> {
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    return xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
  }

  async function roundTrip(md: string): Promise<string> {
    const { docx } = await convertMdToDocx(md);
    const imported = await convertDocx(docx);
    return imported.markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  }

  it('splits a substitution at a paragraph break in its old text and deletes the paragraph mark', async () => {
    const paragraphs = await documentParagraphs('Start {~~old text.\n\nNew para~>replacement~~} end.');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toContain('<w:delText>old text.</w:delText>');
    expect(paragraphs[0]).toMatch(/<w:pPr>(?:(?!<\/w:pPr>).)*<w:rPr><w:del w:id="\d+" w:author="[^"]*"[^>]*\/><\/w:rPr><\/w:pPr>/);
    expect(paragraphs[1]).toContain('<w:delText>New para</w:delText>');
    expect(paragraphs[1]).toContain('<w:t>replacement</w:t>');
    expect(paragraphs[1]).not.toContain('<w:rPr><w:del ');
  });

  it('marks the paragraph mark inside additions, deletions, and the new text of a substitution', async () => {
    const cases: Array<[string, 'ins' | 'del']> = [
      ['x {++a\n\nb++} y', 'ins'],
      ['A {--deleted\n\n--}B', 'del'],
      ['x {~~a~>b\n\nc~~} y', 'ins'],
    ];
    for (const [md, el] of cases) {
      const paragraphs = await documentParagraphs(md);
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0]).toContain('<w:rPr><w:' + el + ' w:id=');
      expect(paragraphs[1]).not.toMatch(/<w:pPr>.*<w:rPr><w:(?:ins|del) /);
    }
  });

  it('imports a tracked paragraph break inside the CriticMarkup span when text remains on both sides', async () => {
    for (const md of [
      'Start {~~old text.\n\nNew para~>replacement~~} end.',
      'A {--deleted\n\n--}B',
      'x {++a\n\nb++} y',
      'x {~~a~>b\n\nc~~} y',
      // A break that opens the new side follows the old side, a deletion
      'x {~~a~>\n\nb~~} y',
      'x {~~a~>\n\n~~} y',
      'x {~~**a**~>\n\nb~~} y',
      '- x {~~a~>\n\n  b~~} y',
      // ...and with a break in the old side too
      'x {~~a\n\nb~>\n\nc~~} y',
      '- x {~~a\n\n  b~>\n\n  c~~} y',
    ]) {
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('leaves untracked a break that both sides of a substitution end and start with', async () => {
    // Accepting or rejecting the change leaves the break either way
    const paragraphs = await documentParagraphs('x {~~a\n\n~>\n\nc~~} y');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).not.toMatch(/<w:pPr>.*<w:rPr><w:(?:ins|del) /);
    expect(await roundTrip('x {~~a\n\n~>\n\nc~~} y')).toBe('x {--a--}\n\n{++c++} y');
  });

  it('tracks the mark of a heading a revision splits', async () => {
    // A heading's break was left untracked, as import read a revised heading
    // mark only as a wholly revised heading. It writes one all in the
    // revision so, and the mark of one that isn't as the break after its text
    const paragraphs = await documentParagraphs('# {++a\n\nb++} y');
    expect(paragraphs[0]).toContain('w:val="Heading1"');
    expect(paragraphs[0]).toContain('<w:rPr><w:ins ');
    expect(paragraphs[1]).not.toMatch(/<w:pPr>.*<w:rPr><w:(?:ins|del) /);
    expect(await roundTrip('# {++a\n\nb++} y')).toBe('{++# a++}\n\n{++b++} y');
    for (const md of ['# a{++\n\n++}b', '# a{--x\n\ny--}b', '## a {++c\n\n++}\n\n- d']) {
      const [heading] = await documentParagraphs(md);
      expect(heading).toMatch(/<w:pStyle w:val="Heading\d"\/><w:rPr><w:(?:ins|del) /);
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('keeps a formatted substitution whole, across a break or not', async () => {
    // Word stores each formatted run of a side separately; import pairs the sides
    for (const md of [
      'x {~~**a**\n\n**b**~>*c*\n\n*d*~~} y',
      'x {~~**a**\n\nb~>c~~} y',
      'x {~~a~>*c*\n\nd~~} y',
      'x {~~**a** b~>c~~} y',
    ]) {
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('keeps adjacent equations on one side of a substitution apart', async () => {
    // One span for the side would run the equations' dollar signs together
    for (const md of ['See {--x--}{++$a$++}{++$b$++} here.', 'See {--$a$--}{--$b$--}{++y++} here.', 'See {~~x~>$a$ $b$~~} here.']) {
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('keeps private-use characters in the text around a tracked break', async () => {
    for (const md of ['A\uE000B\uE001C {++x\n\nmore++} end', 'A\uE000 {++x\n\nmore++} end \uE001']) {
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('keeps a break inside the span after a link, math, code or formatting', async () => {
    // The link, code or emphasis closes before the break, which stays in the span
    for (const md of [
      'x {++[a](https://e.com)\n\nb++} y',
      'x {++$a$\n\nb++} y',
      'x {--$a$\n\nb--} y',
      'x {++`a`\n\nb++} y',
      'x {++**a**\n\nb++} y',
      'x {++*a*\n\n*b*++} y',
      'x {++H~2~\n\nb++} y',
    ]) {
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('tracks and restores paragraph breaks inside revisions in notes', async () => {
    const md = 'Text[^1] here.\n\n[^1]: Start {~~a\n\n    b~>c~~} end.';
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    const notes = await zip.file('word/footnotes.xml')!.async('string');
    expect(notes).toMatch(/<w:rPr><w:del w:id="\d+"[^>]*\/><\/w:rPr><\/w:pPr>(?:(?!<\/w:p>).)*<w:delText>a<\/w:delText>/);
    const imported = await roundTrip(md);
    expect(imported).toContain('Start {~~a\n    \n    b~>c~~} end.');
  });

  it('restores tracked breaks inside list items, quotes and custom styles', async () => {
    for (const md of [
      '- x {++a\n\n  b++} y\n- next',
      '1. x {++a\n\n   b++} y',
      '> x {++a\n>\n> b++} y',
      '> [!NOTE]\n> x {++a\n>\n> b++} y',
      '<!-- style: special -->\nx {++a\n\nb++} y\n<!-- /style -->',
    ]) {
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('keeps a wholly deleted paragraph\'s mark in its deletion, and a break export leaves untracked as it is', async () => {
    // The deletion came back as {--Gone.--} on a line of its own, whose mark
    // export didn't track
    expect(await roundTrip('{--Gone.\n\n--}Kept.')).toBe('{--Gone.\n\n--}Kept.');
    // Export moves a break that opens a span with text outside it
    expect(await roundTrip('Kept.{++\n\nNew.++}')).toBe('Kept.\n\n{++New.++}');
  });
});
