import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import JSZip from 'jszip';
import { normalizeNewlines } from './newlines';
import { convertMdToDocx, hasCitations, parseMd } from './md-to-docx';
import { convertDocx } from './converter';
import { scanOrientationDirectives } from './orientation-scan';
import { preprocessEmbeds } from './embed-preprocess';
import { manuscriptMarkdownPlugin } from './preview/manuscript-markdown-plugin';
import { main } from './cli';

/** `text` with each \n as `eol`, or, for 'mixed', as \n, \r\n and \r in
 *  turn, but \r\n for a \r before a \n, which would make one line end of
 *  the two */
function withLineEnds(text: string, eol: '\n' | '\r\n' | '\r' | 'mixed'): string {
  if (eol !== 'mixed') return text.replace(/\n/g, eol);
  let k = 0;
  return text.replace(/\n(?=(\n?))/g, (_end, next: string) => {
    const end = ['\n', '\r\n', '\r'][k++ % 3];
    return end === '\r' && next ? '\r\n' : end;
  });
}

const LINE_ENDS = ['\r\n', '\r', 'mixed'] as const;

/** Word's body, but the revision IDs that differ from one export to the
 *  next, the import Markdown and the warnings, for `markdown` */
async function exported(markdown: string, embedResolver?: Parameters<typeof preprocessEmbeds>[1]): Promise<{ xml: string; markdown: string; warnings: string[] }> {
  const result = await convertMdToDocx(markdown, embedResolver ? { embedResolver, documentPath: '/doc/file.md' } : undefined);
  const xml = await (await JSZip.loadAsync(result.docx)).file('word/document.xml')!.async('string');
  return {
    xml: xml.replace(/ w:rsid\w*="[^"]*"/g, ''),
    markdown: (await convertDocx(result.docx)).markdown,
    warnings: result.warnings,
  };
}

describe('normalizeNewlines', () => {
  it('reads each line end as markdown-it\'s normalize rule does', () => {
    // The text markdown-it's core rules after normalize read
    const md = new MarkdownIt();
    let normalized = '';
    md.core.ruler.after('normalize', 'capture', state => { normalized = state.src; });
    fc.assert(fc.property(fc.array(fc.constantFrom('\r', '\n', '\r\n', 'a', ' ')).map(parts => parts.join('')), text => {
      md.parse(text, {});
      expect(normalizeNewlines(text)).toBe(normalized);
    }), { numRuns: 500 });
  });
});

describe('Line ends as markdown-it reads them', () => {
  // markdown-it reads \r\n and a \r alone as a line end, as \n. Export's
  // steps before it split lines at \n alone, or at \r\n too, so a document
  // with a \r alone, or some of each, lost its frontmatter, a quote's line
  // without a >, or a blank line
  const documents: Array<[string, string]> = [
    ['frontmatter', '---\ntitle: T\nstyles:\n  box:\n    font-style: italic\n---\n\n\np\n'],
    ['a quote with a line without a > after it', '> q\nx\n\n> r\n>\n> s\n\n\n> t\n'],
    ['an alert', '> [!NOTE]\n> n\n\np\n'],
    ['a landscape section', 'p\n\n<!-- landscape -->\n\nq\n\n<!-- /landscape -->\n\nr\n'],
    ['a style directive with styles in frontmatter', '---\nstyles:\n  box:\n    font-style: italic\n---\n\n<!-- style: box -->\np\n\nq\n<!-- /style -->\n'],
    ['a quote with a line after it in a list item', '- i\n\n  > q\n  x\n\n- j\n'],
  ];

  it.each(documents.flatMap(([name, md]) => LINE_ENDS.map(eol => [name, JSON.stringify(eol), md, eol] as const)))(
    'exports %s with %s line ends as with \\n', async (_name, _eolName, md, eol) => {
      const lf = await exported(md);
      expect(await exported(withLineEnds(md, eol))).toEqual(lf);
    });

  it.each(LINE_ENDS.map(eol => [JSON.stringify(eol), eol] as const))(
    'exports a note\'s definition after fenced code with %s line ends as with \\n', async (_eolName, eol) => {
      // The definition went into the fence's lines, which a bare \r put one
      // line later
      const md = 'T [^1]\n```\nx\n```\n[^1]: Note.\n';
      const lf = await exported(md);
      expect(lf.markdown).toContain('[^1]: Note.');
      expect(await exported(withLineEnds(md, eol))).toEqual(lf);
    });

  it.each([
    ['a paragraph break', '{++a\n\nb++}'],
    ['a line break', '{++a\nb++}'],
    ['a blank line of spaces', '{++before\n   \nafter++}'],
    ['an opener at a line\'s end', 'Before{++\nafter++}'],
    ['an opener at a quote line\'s end', '> Before{++\n> after++}'],
    ['code after an indented line', 'Intro\n\n    {++first\n    second++}'],
    ['code in a fence before it', '~~~\n{++code\nline++}\n~~~\nAfter {++revision\nline++}'],
  ])('reads a CriticMarkup span with %s with any line end as with \\n', (_name, md) => {
    for (const eol of LINE_ENDS) expect(parseMd(withLineEnds(md, eol))).toEqual(parseMd(md));
  });

  it('embeds the tables of a Markdown file with any line end as with \\n', () => {
    const file = '<!-- table-digits: 1 -->\n\n| A |\n|---|\n| 1.25 |\n\n+---+\n| B |\n+---+\n';
    const resolverOf = (text: string) => ({
      resolveRelative: (_document: string, path: string) => '/doc/' + path,
      readFile: (path: string) => path === '/doc/table.md' ? new TextEncoder().encode(text) : null,
    });
    const lf = preprocessEmbeds('<!-- embed: table.md -->', resolverOf(file), '/doc/file.md');
    expect(lf).toContain('<table');
    for (const eol of LINE_ENDS) {
      expect(preprocessEmbeds('<!-- embed: table.md -->', resolverOf(withLineEnds(file, eol)), '/doc/file.md')).toBe(lf);
    }
  });

  it.each(LINE_ENDS.map(eol => [JSON.stringify(eol), eol] as const))(
    'finds the bibliography a file\'s frontmatter names in the CLI with %s line ends', async (_eolName, eol) => {
      // The CLI read no frontmatter, so it loaded no bibliography
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newlines-'));
      const argv = process.argv;
      try {
        fs.writeFileSync(path.join(dir, 'refs.bib'), '@article{smith2020,\n  author = {Smith, Jane},\n  title = {A Title},\n  journal = {J},\n  year = {2020}\n}\n');
        fs.writeFileSync(path.join(dir, 'doc.md'), withLineEnds('---\nbibliography: refs.bib\n---\n\nText [@smith2020].\n', eol));
        process.argv = ['bun', 'cli', path.join(dir, 'doc.md')];
        await main();
        const xml = await (await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'doc.docx')))).file('word/document.xml')!.async('string');
        expect(xml).toContain('Smith');
      } finally {
        process.argv = argv;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

  it('reads frontmatter in the preview with any line end', () => {
    // Its breaks: true makes a line end in a paragraph a line break
    const md = new MarkdownIt({ html: true });
    manuscriptMarkdownPlugin(md);
    const source = '---\nbreaks: true\n---\n\na\nb\n';
    const lf = md.render(source);
    expect(lf).toContain('<br>');
    for (const eol of LINE_ENDS) expect(md.render(withLineEnds(source, eol))).toBe(lf);
  });

  it('flags the same orientation directives with any line end, where they are', () => {
    const md = 'p\n\n<!-- landscape -->\n\n- i\n\n  q\n\n  <!-- /landscape -->\n\n[^1]: n\n\n    <!-- portrait -->\n';
    const lf = scanOrientationDirectives(md).map(d => [d.kind, md.slice(d.start, d.end)]);
    expect(lf.length).toBeGreaterThan(0);
    for (const eol of LINE_ENDS) {
      const text = withLineEnds(md, eol);
      expect(scanOrientationDirectives(text).map(d => [d.kind, text.slice(d.start, d.end)])).toEqual(lf);
    }
  });

  it.each([
    ['&#13;&#10;', '"a&#13;&#10;b"', '"a\nb"'],
    ['&#13;', '"a&#13;b"', '"a\nb"'],
    ['&#10;', '"a&#10;b"', '"a\nb"'],
  ])('writes a line end that %s in the title of an image export can\'t embed decodes to as \\n', async (_name, title, written) => {
    // The title, which markdown-it decodes after the line ends are read,
    // went into the hidden text with a \r, which Word read as a second line
    // end, so the image came back with a blank line in its title, which no
    // longer reads as one
    const { docx } = await convertMdToDocx('![a][r]\n\n[r]: missing.png ' + title + '\n');
    expect(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).not.toContain('\r');
    const back = (await convertDocx(docx)).markdown;
    expect(back).toBe('![a](missing.png ' + written + ')\n');
    expect((await convertDocx((await convertMdToDocx(back)).docx)).markdown).toBe(back);
  });

  it.each([['&#13;&#10;'], ['&#13;']])('writes a line end that %s in the attributes of an image export can\'t embed decodes to as \\n', async reference => {
    // As in its title: the attributes went into the hidden text with a \r,
    // which Word read as a second line end, so they came back apart from
    // the image. They come back as with &#10;, which is \n alone
    const { docx } = await convertMdToDocx('![a](missing.png){width=100' + reference + 'height=100}\n');
    expect(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).not.toContain('\r');
    const lf = (await convertDocx((await convertMdToDocx('![a](missing.png){width=100&#10;height=100}\n')).docx)).markdown;
    expect(lf).toBe('![a](missing.png){width=100\nheight=100}\n');
    expect((await convertDocx(docx)).markdown).toBe(lf);
  });

  it.each([
    ['a citation in a note\'s second paragraph', 'p[^1]\n\n[^1]: n\n\n    see [@key]\n', true],
    ['a citation in a note', 'p[^1]\n\n[^1]: see [@key]\n', true],
    ['a citation after frontmatter', '---\ntitle: T\n---\n\np [@key]\n', true],
    ['a citation in fenced code', '```\n[@key]\n```\n', false],
  ])('finds whether a document cites anything with any line end, with %s', (_name, md, cites) => {
    // The extension asks of the editor's text, which can have \r\n, and
    // the steps hasCitations runs read \n alone, so a note's definition with
    // a \r alone kept its second paragraph from the note
    for (const eol of LINE_ENDS) expect([eol, hasCitations(withLineEnds(md, eol))]).toEqual([eol, cites]);
  });

  // Documents of blocks, with blank lines between them, in frontmatter or none
  const blockArb = fc.constantFrom(
    'p\nq', '# H', '- a\n- b\n\n  c\n  - d', '1. x\n2. y', '> q\nx', '> r\n>\n> s', '> [!NOTE]\n> n',
    '```js\nx\n\ny\n```', '    code\n\n    more', '<div>\na\n</div>', '<!-- c\nd -->',
    'a {++b\n\nc++} d {--e\nf--}', '{>>note\nline<<}', 'a {#1}b{/1}\n\n{#1>>c\n\nd<<}', 'a[^1]\n\n[^1]: n1\n\n    n2',
    '+---+---+\n| a | b |\n+===+===+\n| c | d |\n+---+---+', '<!-- table-digits: 1 -->\n\n| a |\n|---|\n| 1.25 |',
    '\\begin{equation}\nx\n\\end{equation}', '$' + '$\ny\n$' + '$', '<!-- landscape -->\n\nl\n\n<!-- /landscape -->',
    '<!-- style: box -->\nst\n<!-- /style -->', 'a\\\nb  \nc<br>\nd', '- i\n\n  > q\n  x', '---', '- [ ] t',
  );
  const documentArb = fc.record({
    frontmatter: fc.boolean(),
    blocks: fc.array(fc.tuple(blockArb, fc.constantFrom('\n\n', '\n\n\n')), { minLength: 1, maxLength: 6 }),
  }).map(({ frontmatter, blocks }) => (frontmatter ? '---\ntitle: T\nstyles:\n  box:\n    font-style: italic\n---\n\n' : '')
    + blocks.map(([block, gap]) => block + gap).join('').replace(/\n+$/, '\n'));

  it('exports a document with \\r\\n, \\r or some of each and \\n as line ends as with \\n alone', async () => {
    await fc.assert(fc.asyncProperty(documentArb, fc.constantFrom(...LINE_ENDS), async (md, eol) => {
      expect(await exported(withLineEnds(md, eol))).toEqual(await exported(md));
    }), { numRuns: 60 });
  }, 120000);
});
