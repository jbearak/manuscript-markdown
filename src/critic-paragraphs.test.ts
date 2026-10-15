import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { convertMdToDocx, parseMd } from './md-to-docx';
import { convertDocx } from './converter';
import { preprocessCriticMarkup } from './critic-markup';
import { createMarkdownItWithPlugin, renderWithPlugin } from './test-helpers';
import { fastestRun } from './test-timing';
import { xmlAttributeValue } from './xml-parser';

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

  // The sequences a replacement string reads as patterns, as $& for what it
  // matched, which the author's name of a mark export added to a pPr took;
  // $1 and $<a>, which a string pattern leaves as they are, too. Written by
  // concatenation, as a replacement string would read these very lines.
  const dollarAuthors = ['$' + '$', '$' + '&', '$' + '`', '$' + "'", '$' + '1', '$' + '<a>'].map(sequence => 'A' + sequence + 'B');
  const markedParagraphs = [
    ['a list item', '- x {++a\n\n  b++} y\n- next'],
    ['a quote', '> x {--a\n>\n> b--} y'],
    ['a custom style', '<!-- style: special -->\nx {++a\n\nb++} y\n<!-- /style -->'],
    ['an HTML table\'s cell', '<table>\n  <tr>\n    <th>\n      <p>h</p>\n    </th>\n  </tr>\n  <tr>\n    <td>\n      <p>c{++</p>\n      <p>++}e</p>\n    </td>\n  </tr>\n</table>'],
  ];
  it.each(dollarAuthors.flatMap(authorName => markedParagraphs.map(([where, md]) => [where, authorName, md])))(
    'tracks the mark of a paragraph in %s by an author named %s, as named', async (_where, authorName, md) => {
      const trip = async (markdown: string) => {
        const { docx } = await convertMdToDocx(markdown, { authorName });
        const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
        expect(XMLValidator.validate(xml)).toBe(true);
        // The mark's and the text's, all as named
        expect(xml).toMatch(/<w:pPr>(?:(?!<\/w:pPr>).)*<w:rPr><w:(?:ins|del) [^>]*\/><\/w:rPr><\/w:pPr>/);
        const authors = [...xml.matchAll(/ w:author="([^"]*)"/g)].map(match => xmlAttributeValue(match[1]));
        expect(authors.length).toBeGreaterThan(0);
        expect(new Set(authors)).toEqual(new Set([authorName]));
        return (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      };
      // One span, as the mark's revision is the text's
      const once = await trip(md);
      expect(once).toBe(md);
      expect(await trip(once)).toBe(once);
    });

  it('keeps a wholly deleted paragraph\'s mark in its deletion, and a break export leaves untracked as it is', async () => {
    // The deletion came back as {--Gone.--} on a line of its own, whose mark
    // export didn't track
    expect(await roundTrip('{--Gone.\n\n--}Kept.')).toBe('{--Gone.\n\n--}Kept.');
    // Export moves a break that opens a span with text outside it
    expect(await roundTrip('Kept.{++\n\nNew.++}')).toBe('Kept.\n\n{++New.++}');
  });
});

describe('CriticMarkup\'s markers in a pipe table\'s cells', () => {
  async function roundTrip(md: string): Promise<{ markdown: string; table: boolean; placeholder: boolean }> {
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const imported = await convertDocx(docx);
    return {
      markdown: imported.markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim(),
      table: xml.includes('<w:tbl>'),
      placeholder: xml.includes(''),
    };
  }
  const comments = async (source: string) => {
    const { docx } = await convertMdToDocx(source);
    return (await (await JSZip.loadAsync(docx)).file('word/comments.xml')?.async('string')) ?? '';
  };

  it.each([
    ['an opener in a cell before a later row\'s closer', '| a {++ | b |\n|---|---|\n| {++c++} | d |', '| a \\{++ | b |\n| --- | --- |\n| {++c++} | d |'],
    ['an opener at a row\'s end', '| a | b {++\n|---|---|\n| c | d++} |', '| a | b \\{++ |\n| --- | --- |\n| c | d+\\+} |'],
    ['a comment\'s opener', '| a {>> | b |\n|---|---|\n| c<<} | d |', '| a \\{>> | b |\n| --- | --- |\n| c<<} | d |'],
    ['a span in a cell', '| a {++b++} | c |\n|---|---|\n| d | e |', '| a {++b++} | c |\n| --- | --- |\n| d | e |'],
    // An equation on one line leaves the table a table
    ['an opener in a cell after an equation in it', '| $x$ {++ | b |\n|---|---|\n| {++c++} | d |', '| $x$ \\{++ | b |\n| --- | --- |\n| {++c++} | d |'],
  ])('keeps the table with %s, as markdown-it reads its cells', async (_name, md, expected) => {
    // Preprocessing paired the opener with a closer past the cell's end and
    // wrote the line ends between as placeholders, which took the rows out
    // of the table, all one paragraph
    const once = await roundTrip(md);
    expect(once.table).toBe(true);
    expect(once.placeholder).toBe(false);
    expect(once.markdown).toBe(expected);
    expect((await roundTrip(expected)).markdown).toBe(expected);
  });

  it.each([
    ['in a display equation', '$$\nx {++a | b\n--- | ---\nc | d++}\n$$', '$$\nx {++a | b\n--- | ---\nc | d++}\n$$'],
    ['in a bare LaTeX environment', '\\begin{equation}\nx {++a | b\n--- | ---\nc | d++}\n\\end{equation}', '$$\nx {++a | b\n--- | ---\nc | d++}\n$$'],
    ['in an inline equation over lines', 'Text $a {++b | c\n--- | ---\nd | e++}$ after.', 'Text $a {++b | c\n--- | ---\nd | e++}$ after.'],
    // The block parse reads the closer's line as code, which the math
    // spans that leave code alone didn't read
    ['in a display equation whose closing $$ is indented four spaces', '$$\nx {++a | b\n--- | ---\nc | d++}\n    $$', '$$\nx {++a | b\n--- | ---\nc | d++}\n$$'],
    // Read with the code's $$ too, the equation's opener closed a span
    // from it, and its closer opened one
    // Export reads a run of more than two dollars as a display delimiter
    // too, where the math spans, of two alone, read none
    ['in a display equation closed with $$$', '$$\nx {++a | b\n--- | ---\nc | d++}\n$$$', '$$\nx {++a | b\n--- | ---\nc | d++}\n$$$'],
    ['in a display equation opened and closed with $$$', '$$$\nx {++a | b\n--- | ---\nc | d++}\n$$$', '$$\n$\nx {++a | b\n--- | ---\nc | d++}\n$$$'],
    ['in a display equation after $$ in a code block', '```\n$$\n```\n\n$$\nx {++a | b\n--- | ---\nc | d++}\n$$', '```\n$$\n```\n\n$$\nx {++a | b\n--- | ---\nc | d++}\n$$'],
  ])('keeps an insertion whose lines look like a table %s in the equation, as before', async (_name, md, expected) => {
    // The block parse, which reads no math, read a table there, and the
    // opener in its cell as text, so export and the preview made a table
    // of the equation's lines, with its $$ and the markers as text
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).not.toContain('<w:tbl>');
    expect(xml).toContain('<m:oMath');
    expect(xml).toContain('<w:ins ');
    expect((await roundTrip(md)).markdown).toBe(expected);
    expect((await roundTrip(expected)).markdown).toBe(expected);
    const html = renderWithPlugin(md);
    expect(html).not.toContain('<table');
    expect(html).toContain('<ins class="manuscript-markdown-addition">');
  });

  it('leaves an opener in a merged cell of an HTML table, before a later row\'s closer, as before', async () => {
    // An HTML table is an HTML block, whose CriticMarkup preprocessing
    // leaves alone, and the table rule doesn't read
    const md = '<table>\n  <tr>\n    <td colspan="2">a {++b</td>\n  </tr>\n  <tr>\n    <td>c++}</td>\n    <td>d</td>\n  </tr>\n</table>';
    const expected = '<table>\n  <tr>\n    <td colspan="2">\n      <p>a {++b</p>\n    </td>\n  </tr>\n  <tr>\n    <td>\n      <p>c++}</p>\n    </td>\n    <td>\n      <p>d</p>\n    </td>\n  </tr>\n</table>';
    const once = await roundTrip(md);
    expect(once.table).toBe(true);
    expect(once.placeholder).toBe(false);
    expect(once.markdown).toBe(expected);
    expect((await roundTrip(expected)).markdown).toBe(expected);
  });

  it('renders the table with an opener in a cell before a later row\'s closer in the preview', () => {
    const html = renderWithPlugin('| a {++ | b |\n|---|---|\n| {++c++} | d |');
    expect(html).toContain('<th>a {++</th>');
    expect(html).toContain('<td><ins class="manuscript-markdown-addition">c</ins></td>');
  });

  it.each([
    ['moved there from the end of the line before', 'Before.{>>\na | b\n--- | ---\nc | d<<}', 'Before.\n\n{>>a | b\n--- | ---\nc | d<<}'],
    ['alone in its paragraph', '{>>a | b\n--- | ---\nc | d<<}', '{>>a | b\n--- | ---\nc | d<<}'],
    ['in a quote', '> {>>a | b\n> --- | ---\n> c | d<<}', '> {>>a | b\n> --- | ---\n> c | d<<}'],
  ])('reads a comment\'s opener at the start of a table\'s first line, %s, as before the table', async (_name, md, expected) => {
    // As a cell's text, the comment's lines were a table, and the markers
    // text in it
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    expect(await zip.file('word/document.xml')!.async('string')).not.toContain('<w:tbl>');
    expect(await zip.file('word/comments.xml')!.async('string')).toContain('a | b');
    expect((await roundTrip(md)).markdown).toBe(expected);
    expect((await roundTrip(expected)).markdown).toBe(expected);
    const html = renderWithPlugin(md);
    expect(html).toContain('manuscript-markdown-comment-indicator');
    expect(html).not.toContain('<table>');
  });

  it('reads a comment\'s opener at the start of a quoted table\'s first line as before it, after a table it touches', async () => {
    // Merged with the first table's lines, the opener read as in its cell
    const md = 'a | b\n--- | ---\nc | d\n> {>>x | y\n> --- | ---\n> z | w<<}';
    const expected = '| a | b |\n| --- | --- |\n| c | d |\n> {>>x | y\n> --- | ---\n> z | w<<}';
    expect(await comments(md)).toContain('x | y');
    const once = await roundTrip(md);
    expect(once.table).toBe(true);
    expect(once.markdown).toBe(expected);
    expect((await roundTrip(expected)).markdown).toBe(expected);
    const html = renderWithPlugin(md);
    expect(html).toContain('<td>d</td>');
    expect(html).toContain('<blockquote>\n<p><span class="manuscript-markdown-comment-indicator"');
  });

  it('reads an opener in a table that a comment before it takes the lines of as a span\'s', async () => {
    // The comment's lines are joined, which leaves the table's rows a
    // paragraph's, so the opener is in no cell, and the insertion's blank
    // line is the span's
    const md = '{>>a | b\n--- | ---\nc | d<<} {++one\n\ntwo++}';
    const once = await roundTrip(md);
    expect(once.table).toBe(false);
    expect(once.placeholder).toBe(false);
    expect(once.markdown).toBe(md);
    const { docx } = await convertMdToDocx(md);
    expect(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).toContain('<w:ins ');
    expect(renderWithPlugin(md)).toContain('<p><ins class="manuscript-markdown-addition">two</ins></p>');
  });

  it('moves an opener at a line\'s end in a table that a comment before it takes the lines of to a paragraph of its own', async () => {
    // Read as in the table's cell, it stayed, so its line end went into the
    // insertion, and the text before it, Kept., into its paragraph
    const md = '{>>a | b\n--- | ---\nc | d<<} Kept.{++\nNew.++}';
    const expected = '{>>a | b\n--- | ---\nc | d<<} Kept.\n\n{++New.++}';
    expect(preprocessCriticMarkup(md)).toEndWith(' Kept.\n\n{++New.++}');
    expect((await roundTrip(md)).markdown).toBe(expected);
    expect((await roundTrip(expected)).markdown).toBe(expected);
  });

  it.each([
    ['after text', 'Before {#1}anchor{/1}\n\n{#1>>a | b\n--- | ---\nc | d<<}', 'Before {#1}anchor{/1}\n{#1>>a | b\n--- | ---\nc | d<<}'],
    ['after a heading\'s text', '# Head {#1}anchor{/1}\n\n{#1>>a | b\n--- | ---\nc | d<<}', '# Head {#1}anchor{/1}\n{#1>>a | b\n--- | ---\nc | d<<}'],
    ['after a list item\'s text', '- item {#1}anchor{/1}\n\n{#1>>a | b\n--- | ---\nc | d<<}', '- item {#1}anchor{/1}\n{#1>>a | b\n--- | ---\nc | d<<}'],
    ['after text with a | on its first line', 'x | y {#1}anchor{/1}\n\n{#1>>a\n--- | ---\nc | d<<}', 'x | y {#1}anchor{/1}\n{#1>>a\n--- | ---\nc | d<<}'],
    // A list item's marker or a heading's #, before the comment on its
    // line, makes the opener a cell's
    ['on no text at a list item\'s start', '- {#1}{/1}text\n\n{#1>>a | b\n--- | ---\nc | d<<}', '- {#1}{/1}text\n{#1>>a | b\n--- | ---\nc | d<<}'],
    ['on no text at an ordered list item\'s start', '1. {#1}{/1}text\n\n{#1>>a | b\n--- | ---\nc | d<<}', '1. {#1}{/1}text\n{#1>>a | b\n--- | ---\nc | d<<}'],
    ['on no text at a heading\'s start', '# {#1}{/1}Head\n\n{#1>>a | b\n--- | ---\nc | d<<}', '# {#1}{/1}Head\n{#1>>a | b\n--- | ---\nc | d<<}'],
    // After the label Word shows, which import drops, so in ID syntax it
    // didn't need
    ['on no text at the start of an alert\'s first paragraph', '> [!NOTE]\n> {>>a | b\n> --- | ---\n> c | d<<} after.', '> [!NOTE]\n> {#1}{/1} after.\n> {#1>>a | b\n> --- | ---\n> c | d<<}'],
    ['on a space alone in its paragraph', 'Before\n\n{#1} {/1}\n\n{#1>>a | b\n--- | ---\nc | d<<}', 'Before\n\n{#1} {/1}\n{#1>>a | b\n--- | ---\nc | d<<}'],
    // Where the line written before the body differs from the paragraph's
    // text: an alert's marker, a closing $$, and a heading's line break
    ['in an alert\'s first paragraph', '> [!NOTE]\n> Before {#1}anchor{/1}\n\n{#1>>a | b\n--- | ---\nc | d<<}', '> [!NOTE]\n> Before {#1}anchor{/1}\n> {#1>>a | b\n> --- | ---\n> c | d<<}'],
    ['after a display equation in its paragraph', 'x\n$$\ny\n$$\nBefore {#1}anchor{/1}\n\n{#1>>a | b\n--- | ---\nc | d<<}', 'x\n$$\ny\n$$&#32;Before {#1}anchor{/1}\n{#1>>a | b\n--- | ---\nc | d<<}'],
    ['after a heading\'s line break', '# a<br>b {#1}anchor{/1}\n\n{#1>>a | b\n--- | ---\nc | d<<}', '# a<br>b {#1}anchor{/1}\n{#1>>a | b\n--- | ---\nc | d<<}'],
    ['before text with an == in it, as the body has', 'Before {#1}anchor{/1} x\\==y\n\n{#1>>a | b\n--- | ---\nx==y<<}', 'Before {#1}anchor{/1} x\\==y\n{#1>>a | b\n--- | ---\nx==y<<}'],
    ['with a reply', 'Before {#1}anchor{/1}\n\n{#1>>a | b\n--- | ---\nc | d\n  {>>reply<<}\n<<}', 'Before {#1}anchor{/1}\n{#1>>a | b\n--- | ---\nc | d\n  {>>reply<<}\n<<}'],
    ['whose reply has the delimiter row', 'Before {#1}anchor{/1}\n\n{#1>>note\n  {>>a | b\n  --- | ---<<}\n<<}', 'Before {#1}anchor{/1}\n{#1>>note\n  {>>a | b\n  --- | ---<<}\n<<}'],
  ])('writes a Word comment whose lines make a table %s in ID syntax, which export reads', async (_name, md, expected) => {
    // Import wrote the body after its anchor, as {==anchor==}{>>a | b, whose
    // lines markdown-it reads as a table with the opener in a cell, which
    // export reads as text, and dropped the comment
    const lines = md.includes('reply') ? /reply|a \| b/g : /--- \| ---/g;
    expect(await comments(md)).toMatch(lines);
    const once = await roundTrip(md);
    expect(once.markdown).toBe(expected);
    expect(once.table).toBe(false);
    expect(await comments(once.markdown)).toBe(await comments(md));
    expect((await roundTrip(expected)).markdown).toBe(expected);
  });

  it.each([
    ['of lines that make no table', 'Before {==anchor==}{>>a | b\nc | d<<}'],
    ['of one line that reads as a delimiter row', 'Before {==anchor==}{>>--- | ---<<}'],
    // Its body starts the table's first line, where it opens before the table
    ['on no text at a paragraph\'s start', 'Before\n\n{>>a | b\n--- | ---\nc | d<<} after'],
    ['on no text in a quote', '> {#1}{/1}\n\n{#1>>a | b\n--- | ---\nc | d<<}', '> {>>a | b\n> --- | ---\n> c | d<<}'],
    ['on no text at the start of an alert\'s second paragraph', '> [!NOTE]\n> Text.\n>\n> {>>a | b\n> --- | ---\n> c | d<<} after.'],
  ])('writes a Word comment %s after its anchor, as before', async (_name, md, expected = md) => {
    const once = await roundTrip(md);
    expect(once.markdown).toBe(expected);
    expect(once.table).toBe(false);
    expect(await comments(expected)).toBe(await comments(md));
    expect((await roundTrip(expected)).markdown).toBe(expected);
  });

  it.each([
    ['after text', 'Before {#1}anchor{/1}\n{#1>>note<<}{>>REPLY<<}', 'Before {#1}anchor{/1}\n{#1>>note\n  {>>a | b\n--- | ---\nc | d<<}\n<<}', 1],
    ['after text, after another reply', 'Before {#1}anchor{/1}\n{#1>>note<<}{>>one<<}{>>REPLY<<}', 'Before {#1}anchor{/1}\n{#1>>note\n  {>>one<<}\n  {>>a | b\n--- | ---\nc | d<<}\n<<}', 2],
    ['on no text at a paragraph\'s start', 'Before\n\n{#1}{/1} after.\n{#1>>note<<}{>>REPLY<<}', 'Before\n\n{>>note\n  {>>a | b\n--- | ---\nc | d<<}\n<<} after.', 1],
  ])('writes a Word comment\'s replies in a row, one of whose lines make a table, %s as replies in its body, which export reads', async (_name, md, expected, replies) => {
    // As {>>note<<}{>>a | b, the reply's opener was in the cell of the
    // table its lines make, which export read as text, and dropped the reply
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/comments.xml')!.async('string');
    expect(xml).toContain('>REPLY<');
    zip.file('word/comments.xml', xml.replace('>REPLY<', '>a | b</w:t><w:br/><w:t xml:space="preserve">--- | ---</w:t><w:br/><w:t xml:space="preserve">c | d<'));
    const once = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    expect(once).toBe(expected);
    const next = await JSZip.loadAsync((await convertMdToDocx(once)).docx);
    expect(await next.file('word/document.xml')!.async('string')).not.toContain('<w:tbl>');
    expect(await next.file('word/comments.xml')!.async('string')).toMatch(/>a \| b<\/w:t>(?:(?!c \| d)[\s\S])*<w:br\/>(?:(?!c \| d)[\s\S])*>--- \| ---<\/w:t>(?:(?!c \| d)[\s\S])*<w:br\/>(?:(?!c \| d)[\s\S])*>c \| d</);
    expect((await next.file('word/commentsExtended.xml')!.async('string')).match(/w15:paraIdParent=/g)).toHaveLength(replies);
    expect((await roundTrip(expected)).markdown).toBe(expected);
  });

  it('reads many openers in a table\'s cells before a later closer in linear time', () => {
    const time = (rows: number) => {
      const text = '| a | b |\n|---|---|\n' + '| {++ | x |\n'.repeat(rows) + '\nz ++}\n';
      return fastestRun(() => preprocessCriticMarkup(text));
    };
    expect(time(80_000) / time(20_000)).toBeLessThan(8);
  }, 30000);

  it('reads many comments with one in them in a table\'s cells before later closers in linear time', () => {
    const time = (rows: number) => {
      const text = '| a | b |\n|---|---|\n' + '| {>> {>>x<<} | y |\n'.repeat(rows) + '\n' + 'z <<}\n'.repeat(rows);
      return fastestRun(() => preprocessCriticMarkup(text));
    };
    expect(time(16_000) / time(4_000)).toBeLessThan(8);
  }, 30000);
});

describe('CriticMarkup\'s openers in raw HTML in a paragraph\'s text', () => {
  async function roundTrip(md: string): Promise<{ markdown: string; placeholder: boolean; revision: boolean }> {
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    let placeholder = false;
    let revision = false;
    for (const part of ['word/document.xml', 'word/footnotes.xml']) {
      const xml = await zip.file(part)?.async('string') ?? '';
      if (xml.includes('')) placeholder = true;
      if (/<w:(?:ins|del) /.test(xml)) revision = true;
    }
    const imported = await convertDocx(docx);
    return { markdown: imported.markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim(), placeholder, revision };
  }

  it.each([
    ['an insertion\'s opener in a comment', 'z <!-- {++ -->\n{++real++}', 'z <!-- {++ --> {++real++}'],
    ['one in a tag\'s attribute', 'z <span title="{++">x</span>\n{++real++}', 'z <span title="{++">x</span> {++real++}'],
    ['one before a blank line', 'z <!-- {++ -->\n\n{++real++}', 'z <!-- {++ -->\n\n{++real++}'],
    ['one at the end of a comment\'s line', 'z <!-- {++\n-->\n{++real++}', 'z <!-- {++\n--> {++real++}'],
    ['a deletion\'s', 'z <!-- {-- -->\n{--real--}', 'z <!-- {-- --> {--real--}'],
    ['a substitution\'s', 'z <!-- {~~ -->\n{~~a~>b~~}', 'z <!-- {~~ --> {~~a~>b~~}'],
    ['a comment\'s', 'z <!-- {>> -->\n{++real++} c<<}', 'z <!-- {>> --> {++real++} c<<}'],
    ['one in a heading', '# z <!-- {++ -->\n\n{++real++}', '# z <!-- {++ -->\n\n{++real++}'],
    ['one in a setext heading', 'z <!-- {++ -->\n===\n\n{++real++}', '# z <!-- {++ -->\n\n{++real++}'],
    ['one in a list item', '- z <!-- {++ -->\n  {++real++}', '- z <!-- {++ --> {++real++}'],
    ['one in a quote', '> z <!-- {++ -->\n> {++real++}', '> z <!-- {++ --> {++real++}'],
    ['one in a tag over a quote\'s lines', '> z <span\n> title="{++">x</span>\n> {++real++}', '> z <span\n> title="{++">x</span> {++real++}'],
    ['one in a note', 'A[^1]\n\n[^1]: z <!-- {++ -->\n    {++real++}', 'A[^1]\n\n[^1]: z <!-- {++ --> {++real++}'],
    // Which open and close no equation
    ['one between escaped dollar signs', 'Costs \\$5, z <!-- {++ -->\n{++real++} or \\$6', 'Costs $5, z <!-- {++ --> {++real++} or $6'],
    // A table's cell holds one line, so the table rule leaves the opener alone
    ['one in a table\'s cell, as before', '| h <!-- {++ --> | k |\n|---|---|\n| {++real++} | d |', '| h <!-- {++ --> | k |\n| --- | --- |\n| {++real++} | d |'],
  ])('reads %s as text, as markdown-it does', async (_name, md, expected) => {
    // Preprocessing paired the opener with the closer of the span after it
    // and wrote the line ends between as placeholders, which went to Word
    // and the preview, and came back
    const once = await roundTrip(md);
    expect(once.placeholder).toBe(false);
    expect(once.revision).toBe(true);
    expect(once.markdown).toBe(expected);
    expect((await roundTrip(expected)).markdown).toBe(expected);
    expect(renderWithPlugin(md)).not.toContain('');
  });

  it('renders the span after an opener in a comment in the preview', () => {
    expect(renderWithPlugin('z <!-- {++ -->\n{++real++}')).toContain('<p>z <!-- {++ -->\n<ins class="manuscript-markdown-addition">real</ins></p>');
  });

  it.each([
    ['an escaped <', 'z \\<!-- {--b -->\n\nc--}', 'z \\<!-- {--b -->\n\nc--}'],
    ['an empty comment', 'z <!--> {--b -->\n\nc--}', 'z <!--> {--b -->\n\nc--}'],
    ['a code span with <!-- in it', 'z `<!--` {--b -->\n\nc--}', 'z `<!--` {--b -->\n\nc--}'],
    ['a code span that ends in a comment', '`a <!-- ` {--b -->\n\nc--}', '`a <!-- ` {--b -->\n\nc--}'],
    ['an insertion that ends in a comment', '{++a <!-- ++} {--b -->\n\nc--}', '{++a \\<!-- ++} {--b -->\n\nc--}'],
    ['a tag, with the opener after it', 'z <b>{--b</b>\n\nc--}', 'z {--**b&lt;/b&gt;**\n\n**c**--}'],
  ])('reads an opener after %s as a span\'s, as before', async (_name, md, expected) => {
    // markdown-it reads no HTML around the opener
    const once = await roundTrip(md);
    expect(once.placeholder).toBe(false);
    expect(once.revision).toBe(true);
    expect(once.markdown).toBe(expected);
    expect((await roundTrip(expected)).markdown).toBe(expected);
    expect(renderWithPlugin(md)).toContain('<del class="manuscript-markdown-deletion">c</del>');
  });

  it.each([
    // Export reads CriticMarkup in an equation as the equation's change, and
    // no HTML there
    ['in an equation', '$x <y z={++w >\n\nv++}$', '$x <y z={++w >\n\nv++}$', 1, 1],
    // The math's reads paired the comment's dollar sign with the equation's
    ['in an equation after a $ in a comment', 'z <!-- $ --> $\\alpha <y z={++w >\n\nv++}$', 'z <!-- $ --> $\\alpha <y z={++w >\n\nv++}$', 1, 1],
    // And the equation reaches the HTML's block over a blank line a span
    // before it joins
    ['in an equation over blocks a span joins, after a $ in a comment', 'z <!-- $ --> $\\alpha {++a\n\nb++} <y z={--w >\n\nv--}$',
      'z <!-- $ --> $\\alpha {++a\n\nb++} <y z={--w >\n\nv--}$', 1, 1],
    // Each side of a substitution is read on its own, so the comment in the
    // old text doesn't end in it
    ['in a substitution\'s new text, after a comment from its old text', '{~~old <!-- ~>before{++\nnew -->++}~~}', '{~~old \\<!-- ~>before\n\nnew -->~~}', 2, 0],
  ])('reads an opener in HTML %s as a span\'s, as before', async (_name, md, expected, paragraphs, equations) => {
    // The HTML region held the opener, so its span's lines weren't joined:
    // the equation was two paragraphs of text, and the substitution's
    // opener at a line's end wasn't moved to a paragraph of its own
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const body = xml.slice(xml.indexOf('<w:body>'), xml.indexOf('<w:sectPr'));
    expect(body.match(/<w:p[ >]/g)).toHaveLength(paragraphs);
    expect((body.match(/<m:oMath>/g) ?? []).length).toBe(equations);
    expect(body).toContain('<w:ins ');
    const once = await roundTrip(md);
    expect(once.placeholder).toBe(false);
    expect(once.markdown).toBe(expected);
    expect((await roundTrip(expected)).markdown).toBe(expected);
    const html = renderWithPlugin(md);
    expect(html).not.toContain('\uE000');
    expect(html).toMatch(/<(?:ins|del) class="manuscript-markdown-(?:addition|deletion)">(?:<span class="manuscript-markdown-math-fallback">w &gt;|new --&gt;)/);
  });

  it('reads many comments and tags in a paragraph\'s text in linear time', () => {
    const time = (lines: number) => {
      const text = 'z ' + '<span title="{++">x</span> <!-- {++ --> <a b="` <!-- {++\n'.repeat(lines) + '\n{++real++}\n';
      return fastestRun(() => preprocessCriticMarkup(text));
    };
    expect(time(16_000) / time(4_000)).toBeLessThan(8);
  }, 30000);
});
