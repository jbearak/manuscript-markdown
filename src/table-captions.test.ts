import { afterAll, describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { convertDocx } from './converter';
import { convertMdToDocx, parseMd } from './md-to-docx';
import { renderWithPlugin } from './test-helpers';
import { fastestRun, fastestRunAsync } from './test-timing';

// A table's caption is the paragraph right after it that starts with a
// colon and ends with a label, as : Caption {#tbl-x}. Export writes Word's
// caption for it, above the table unless tbl-cap-location says below, and
// import reads Word's captions of tables back so (see captions.ts).

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dir = mkdtempSync(join(tmpdir(), 'table-captions-'));
writeFileSync(join(dir, 'map.png'), PNG);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function exported(md: string) {
  const { docx, warnings } = await convertMdToDocx(md, { sourceDir: dir });
  const zip = await JSZip.loadAsync(docx);
  const document = await zip.file('word/document.xml')!.async('string');
  const body = document.slice(document.indexOf('<w:body>'), document.indexOf('<w:sectPr'))
    .replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '<TABLE/>')
    .replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, '<DRAWING/>')
    .replace(/ w14:paraId="[^"]*" w14:textId="[^"]*" w:rsidR="[^"]*" w:rsidRDefault="[^"]*"/g, '');
  const styles = await zip.file('word/styles.xml')!.async('string');
  const custom = await zip.file('docProps/custom.xml')?.async('string');
  return { docx, body, styles, custom, warnings };
}

const imported = async (docx: Uint8Array) => (await convertDocx(docx, 'pandoc', { imageFolder: 'media' })).markdown;
const trip = async (md: string) => imported((await convertMdToDocx(md, { sourceDir: dir })).docx);

/** The body's paragraphs and tables, one to an entry */
const blocks = (body: string) => body.match(/<w:p>[\s\S]*?<\/w:p>|<w:p\/>|<TABLE\/>/g) ?? [];
/** A paragraph's text, as Word shows it, its fields' results with it */
const shown = (paragraph: string) => paragraph.replace(/<w:instrText[^>]*>[^<]*<\/w:instrText>|<[^>]+>/g, '');

/** Word's caption, as Word writes it with Insert Caption, with its number's field */
function seqField(n: number, id = 'Table'): string {
  return '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> SEQ ' + id + ' \\* ARABIC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:noProof/></w:rPr><w:t>' + n + '</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
}

interface CaptionOptions { title?: string; id?: string; sep?: string; bookmark?: string; after?: string }

function caption(n: number, text: string, opts: CaptionOptions = {}): string {
  const title = opts.title ?? 'Table';
  const bookmarkStart = opts.bookmark ? '<w:bookmarkStart w:id="' + (100 + n) + '" w:name="' + opts.bookmark + '"/>' : '';
  const bookmarkEnd = opts.bookmark ? '<w:bookmarkEnd w:id="' + (100 + n) + '"/>' : '';
  const rest = text || opts.sep ? '<w:r><w:t xml:space="preserve">' + (opts.sep ?? ': ') + text + '</w:t></w:r>' : '';
  return '<w:p><w:pPr><w:pStyle w:val="Caption"/><w:keepNext/></w:pPr>' + bookmarkStart + '<w:r><w:t xml:space="preserve">' + title + ' </w:t></w:r>'
    + seqField(n, opts.id ?? 'Table') + bookmarkEnd + rest + (opts.after ?? '') + '</w:p>';
}

/** A table of a header row and a row, as Word writes one */
function table(head: string, cell = '1', inner = ''): string {
  const tc = (text: string) => '<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>' + inner + '</w:tc>';
  return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="0020" w:firstRow="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>'
    + '<w:tr><w:trPr><w:tblHeader/></w:trPr>' + tc(head) + '</w:tr><w:tr>' + tc(cell) + '</w:tr></w:tbl>';
}

const para = (text: string) => '<w:p><w:r><w:t xml:space="preserve">' + text + '</w:t></w:r></w:p>';

let pictureId = 0;
function picture(): string {
  const id = ++pictureId;
  return '<w:p><w:pPr><w:keepNext/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="952500" cy="952500"/><wp:docPr id="' + id + '" name="Picture ' + id + '" descr=""/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="' + id + '" name="Picture ' + id + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

const NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const CAPTION_STYLE = '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:spacing w:after="200" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="44546A"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>';

/** A .docx as Word writes one, with the body given */
async function wordDocx(body: string, opts: { footnotes?: string } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>');
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' + CAPTION_STYLE + '</w:styles>');
  zip.file('word/media/image1.png', PNG);
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + '><w:body>' + body + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>');
  if (opts.footnotes) zip.file('word/footnotes.xml', opts.footnotes);
  return zip.generateAsync({ type: 'uint8array' });
}

/** A pipe table's Markdown, as import writes Word's table() */
const pipe = (head: string, cell = '1') => '| ' + head + ' |\n| --- |\n| ' + cell + ' |\n';

describe('exporting a table\'s caption', () => {
  it('writes Word\'s caption above the table, numbered, kept with it, with a bookmark of its label', async () => {
    const { body, styles, custom, warnings } = await exported('Intro.\n\n| a |\n|---|\n| 1 |\n\n: Rates *by* region {#tbl-rates}\n\n+---+\n| g |\n+---+\n\n: Grid {#tbl-grid}\n\n<table><tr><td>h</td></tr></table>\n\n: HTML {#tbl-html}\n');
    expect(warnings).toEqual([]);
    expect(blocks(body)).toEqual([
      '<w:p><w:r><w:t>Intro.</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Caption"/><w:keepNext/></w:pPr><w:bookmarkStart w:id="0" w:name="tbl_rates"/><w:r><w:t xml:space="preserve">Table </w:t></w:r>' + seqField(1) + '<w:bookmarkEnd w:id="0"/><w:r><w:t xml:space="preserve">: </w:t></w:r><w:r><w:t xml:space="preserve">Rates </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>by</w:t></w:r><w:r><w:t xml:space="preserve"> region</w:t></w:r></w:p>',
      '<TABLE/>',
      '<w:p><w:pPr><w:pStyle w:val="Caption"/><w:keepNext/></w:pPr><w:bookmarkStart w:id="1" w:name="tbl_grid"/><w:r><w:t xml:space="preserve">Table </w:t></w:r>' + seqField(2) + '<w:bookmarkEnd w:id="1"/><w:r><w:t xml:space="preserve">: </w:t></w:r><w:r><w:t>Grid</w:t></w:r></w:p>',
      '<TABLE/>',
      '<w:p><w:pPr><w:pStyle w:val="Caption"/><w:keepNext/></w:pPr><w:bookmarkStart w:id="2" w:name="tbl_html"/><w:r><w:t xml:space="preserve">Table </w:t></w:r>' + seqField(3) + '<w:bookmarkEnd w:id="2"/><w:r><w:t xml:space="preserve">: </w:t></w:r><w:r><w:t>HTML</w:t></w:r></w:p>',
      '<TABLE/>',
    ]);
    expect(styles).toContain('<w:style w:type="paragraph" w:styleId="Caption">');
    expect(custom).toContain('name="MANUSCRIPT_TBL_CAP_LOCATION"><vt:lpwstr>top</vt:lpwstr>');
    expect(custom).not.toContain('MANUSCRIPT_FIG_CAP_LOCATION');
    expect(custom).not.toContain('MANUSCRIPT_CAPTION_LABELS_');
  });

  it('writes the title and delimiter crossref: gives, and the caption below where tbl-cap-location: bottom', async () => {
    const { body, custom } = await exported('---\ncrossref:\n  tbl-title: Exhibit\n  title-delim: "."\ntbl-cap-location: bottom\n---\n\n| a |\n|---|\n| 1 |\n\n: A table {#tbl-a}\n\n| b |\n|---|\n| 2 |\n\n: {#tbl-e}\n');
    expect(blocks(body)).toEqual([
      '<TABLE/>',
      '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:bookmarkStart w:id="0" w:name="tbl_a"/><w:r><w:t xml:space="preserve">Exhibit </w:t></w:r>' + seqField(1, 'Exhibit') + '<w:bookmarkEnd w:id="0"/><w:r><w:t xml:space="preserve">. </w:t></w:r><w:r><w:t>A table</w:t></w:r></w:p>',
      '<TABLE/>',
      // A caption with no text takes no delimiter
      '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:bookmarkStart w:id="1" w:name="tbl_e"/><w:r><w:t xml:space="preserve">Exhibit </w:t></w:r>' + seqField(2, 'Exhibit') + '<w:bookmarkEnd w:id="1"/></w:p>',
    ]);
    expect(custom).toContain('name="MANUSCRIPT_TBL_CAP_LOCATION"><vt:lpwstr>bottom</vt:lpwstr>');
  });

  it('numbers tables apart from figures', async () => {
    const { body } = await exported('![A map](map.png){#fig-map}\n\n| a |\n|---|\n| 1 |\n\n: A table {#tbl-a}\n\n![Another](map.png){#fig-b}\n');
    expect(blocks(body).map(shown)).toEqual(['', 'Figure 1: A map', 'Table 1: A table', '', '', 'Figure 2: Another']);
  });

  it('takes the caption\'s text from the colon and the whitespace after it to the whitespace before the label', async () => {
    const { body } = await exported('| a |\n|---|\n| 1 |\n\n:   &#32;Spaced  \\\n  {#tbl-a}\n');
    expect(blocks(body).map(shown)).toEqual(['Table 1:  Spaced', '']);
  });

  it('writes as its Markdown each part of a caption Word\'s caption can\'t hold, and warns', async () => {
    const { body, warnings } = await exported('| a |\n|---|\n| 1 |\n\n: A *b* [^n] {>>c<<} {++d++} {#tbl-x}\n\n[^n]: Note.\n');
    const captionParagraph = blocks(body).find(p => p.includes('Caption'))!;
    expect(shown(captionParagraph)).toBe('Table 1: A b [^n] {&gt;&gt;c&lt;&lt;} {++d++}');
    expect(captionParagraph).toContain('<w:r><w:rPr><w:i/></w:rPr><w:t>b</w:t></w:r>');
    expect(warnings).toContain('The caption of table {#tbl-x} has a citation, a note, a comment, a tracked change, a line break or an image, which Word gets as its Markdown, as text, in its caption.');
  });

  it('gives no caption to a paragraph that isn\'t right after a table at the top level, and warns', async () => {
    const md = '---\nstyles:\n  wide:\n    font: Arial\n---\n\nText.\n\n: After text {#tbl-a}\n\n- item\n\n  | a |\n  |---|\n  | 1 |\n\n  : In a list {#tbl-b}\n\n<!-- style: wide -->\n\n| a |\n|---|\n| 1 |\n\n: In a style block {#tbl-c}\n\n<!-- /style -->\n\n| a |\n|---|\n| 1 |\n\n<!-- a comment -->\n\n: After a comment {#tbl-d}\n\n| a |\n|---|\n| 1 |\n\nText: not a caption {#tbl-e}\n';
    const { body, styles, warnings } = await exported(md);
    expect(body).not.toContain('Caption');
    expect(body).not.toContain('SEQ');
    expect(styles).not.toContain('w:styleId="Caption"');
    for (const label of ['tbl-a', 'tbl-b', 'tbl-c', 'tbl-d', 'tbl-e']) {
      expect(warnings).toContain('The label {#' + label + '} labels no table: a label ends a paragraph right after a table at the top level that starts with a colon, as : Caption {#' + label + '}. Word gets no label there.');
    }
  });
});

describe('importing Word\'s table captions', () => {
  it('reads a caption above a table, as Word writes one, as the table\'s', async () => {
    const md = await imported(await wordDocx(para('Intro.') + caption(1, 'Rates by region', { bookmark: '_Ref1' }) + table('a') + caption(2, 'Second') + table('b') + para('After.')));
    expect(md).toBe('Intro.\n\n' + pipe('a') + '\n: Rates by region {#tbl-rates-by-region}\n\n' + pipe('b') + '\n: Second {#tbl-second}\n\nAfter.\n');
  });

  it('keeps the captions\' place, title and separator in the frontmatter', async () => {
    expect(await imported(await wordDocx(table('a') + caption(1, 'Below', { title: 'Exhibit', id: 'Exhibit', sep: '. ' }) + table('b') + caption(2, 'More', { title: 'Exhibit', id: 'Exhibit', sep: '. ' }))))
      .toBe('---\ncrossref:\n  tbl-title: Exhibit\n  title-delim: "."\ntbl-cap-location: bottom\n---\n\n' + pipe('a') + '\n: Below {#tbl-below}\n\n' + pipe('b') + '\n: More {#tbl-more}\n');
  });

  it('takes the label of a bookmark export named, and numbers the tables afresh', async () => {
    expect(await imported(await wordDocx(caption(7, 'Est', { bookmark: 'tbl_est' }) + table('a') + caption(3, '') + table('b'))))
      .toBe(pipe('a') + '\n: Est {#tbl-est}\n\n' + pipe('b') + '\n: {#tbl-2}\n');
  });

  it('reads figures\' and tables\' captions together, each kind numbered apart', async () => {
    const md = await imported(await wordDocx(picture() + caption(1, 'A map', { title: 'Figure', id: 'Figure' }) + caption(1, 'A table') + table('a')));
    expect(md).toBe('![A map](media/image1.png){#fig-a-map width=100 height=100}\n\n' + pipe('a') + '\n: A table {#tbl-a-table}\n');
  });

  it('gives a caption between a picture and a table to the one its title names', async () => {
    expect(await imported(await wordDocx(picture() + caption(1, 'Below the picture', { title: 'Figure', id: 'Figure' }) + table('a'))))
      .toBe('![Below the picture](media/image1.png){#fig-below-the-picture width=100 height=100}\n\n' + pipe('a'));
    expect(await imported(await wordDocx(picture() + caption(1, 'Above the table') + table('a'))))
      .toBe('![](media/image1.png){width=100 height=100}\n\n' + pipe('a') + '\n: Above the table {#tbl-above-the-table}\n');
    // A title neither has leaves it as text
    expect(await imported(await wordDocx(picture() + caption(1, 'Either', { title: 'Exhibit', id: 'Exhibit' }) + table('a'))))
      .toContain('Exhibit 1: Either');
  });

  it('leaves the tables\' captions as text where their delimiter isn\'t the figures\', which are as many', async () => {
    const md = await imported(await wordDocx(picture() + caption(1, 'A map', { title: 'Figure', id: 'Figure' }) + para('Text.') + caption(1, 'A table', { sep: '. ' }) + table('a')));
    expect(md).toBe('![A map](media/image1.png){#fig-a-map width=100 height=100}\n\nText.\n\nTable 1. A table\n\n' + pipe('a'));
  });

  it('leaves the tables\' captions as text where their title makes the figures\' SEQ identifier, which would number them together', async () => {
    const md = await imported(await wordDocx(picture() + caption(1, 'A map', { title: 'Fig.', id: 'Figure' }) + para('Text.') + caption(1, 'A table', { title: 'Fig' }) + table('a')));
    expect(md).toBe('---\ncrossref:\n  fig-title: Fig.\n---\n\n![A map](media/image1.png){#fig-a-map width=100 height=100}\n\nText.\n\nFig 1: A table\n\n' + pipe('a'));
    // Where the tables are more, the figures' stay text
    const more = await imported(await wordDocx(picture() + caption(1, 'A map', { id: 'Figure', title: 'Figure' }) + para('Text.') + caption(1, 'A', { title: 'Figure' }) + table('a') + caption(2, 'B', { title: 'Figure' }) + table('b')));
    expect(more).toContain('Figure 1: A map');
    expect(more).toContain(': A {#tbl-a}');
    expect(more).toContain('tbl-title: Figure');
  });

  // A caption export can't write as Word has it stays as it is, as text, and
  // so do the others of its series
  const unread: [string, string][] = [
    ['separators that differ', caption(1, 'A', { sep: '. ' }) + table('a') + caption(2, 'B') + table('b')],
    ['a paragraph between it and its table', caption(1, 'Gap') + '<w:p/>' + table('a') + para('After.')],
    ['a tracked change', caption(1, '', { sep: ': ', after: '<w:ins w:id="5" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>New</w:t></w:r></w:ins>' }) + table('a')],
    ['a field of its series in a table', caption(1, 'Body') + table('a', '1', '<w:p>' + seqField(2) + '</w:p>')],
    ['captions of its series above a table and below a picture', caption(1, 'Above') + table('a') + picture() + caption(2, 'Below')],
    ['captions each between two tables', table('a') + caption(1, 'A') + table('b') + caption(2, 'B') + table('c')],
  ];
  it.each(unread)('leaves a caption with %s as text', async (_name, body) => {
    const md = await imported(await wordDocx(body));
    expect(md).not.toContain('{#tbl-');
    expect(md).toMatch(/Table \d/);
    expect(md).not.toContain('tbl-cap-location');
  });
});

describe('table captions\' round trips', () => {
  it('reads back each caption export writes, as it was, the same each time', async () => {
    const bodies = [
      'Intro.\n\n' + pipe('a') + '\n: Rates *by* region, $x^2$, [a link](https://example.com/a) and ==hi== {#tbl-rates}\n\nAfter.\n',
      pipe('a') + '\n: {#tbl-empty}\n\n' + pipe('b') + '\n: Brackets [0, 1) and a \\\\ {#tbl-b}\n',
      pipe('a') + '\n' + pipe('b') + '\n: Second only {#tbl-b}\n\n' + pipe('c'),
      '+-----+\n| g   |\n+-----+\n\n: Grid {#tbl-g}\n',
      '<!-- table-orientation: landscape -->\n' + pipe('a') + '\n: Landscape {#tbl-a}\n\nAfter.\n',
      '<!-- landscape -->\n\n' + pipe('a') + '\n: In a section {#tbl-a}\n\n<!-- /landscape -->\n\nAfter.\n',
      '# Head\n\n' + pipe('a') + '\n: After a heading {#tbl-a}\n',
      '```\ncode\n```\n\n' + pipe('a') + '\n: After code {#tbl-a}\n',
      '> quote\n\n' + pipe('a') + '\n: After a quote {#tbl-a}\n',
      '![A map](map.png){#fig-map}\n\n' + pipe('a') + '\n: With a figure {#tbl-a}\n',
      pipe('a') + '\n: Two spaces  kept {#tbl-a_b}\n\n' + pipe('b') + '\n: &#32;Leading {#tbl-a-b}\n',
    ];
    for (const location of ['top', 'bottom']) {
      for (const body of bodies) {
        const md = '---\ncrossref:\n  tbl-title: Exhibit\ntbl-cap-location: ' + location + '\n---\n\n' + body;
        const back = md.replace('](map.png){#fig-map}', '](media/map.png){#fig-map width=1 height=1}');
        const once = await trip(md);
        expect(once).toBe(back);
        const twice = await trip(once);
        expect(twice).toBe(once);
        expect(await trip(twice)).toBe(once);
      }
    }
  });

  it('writes Word\'s caption back as Word had it, in its place', async () => {
    const word = await wordDocx(caption(1, 'Rates by region', { bookmark: '_Ref1', sep: '. ' }) + table('a') + caption(2, 'More', { sep: '. ' }) + table('b'));
    const { body } = await exported(await imported(word));
    expect(blocks(body).map(block => block === '<TABLE/>' ? block : shown(block))).toEqual(['Table 1. Rates by region', '<TABLE/>', 'Table 2. More', '<TABLE/>']);
  });
});

describe('previewing a table\'s caption', () => {
  it('shows a table\'s caption above it, numbered apart from the figures', () => {
    const html = renderWithPlugin('Intro.\n\n| a |\n|---|\n| 1 |\n\n: Rates *by* region {#tbl-rates}\n\n![A map](map.png){#fig-map}\n\n<table><tr><td>h</td></tr></table>\n\n: {#tbl-html}\n');
    expect(html).toContain('<p>Intro.</p>\n<p id="tbl-rates" class="manuscript-markdown-table-caption">Table 1: Rates <em>by</em> region</p>\n<table>');
    expect(html).toContain('<figcaption>Figure 1: A map</figcaption>');
    expect(html).toMatch(/<p id="tbl-html" class="manuscript-markdown-table-caption">Table 2<\/p>\n<div[^>]*><table><tr><td>h<\/td><\/tr><\/table>/);
  });

  it('shows the title, delimiter and place the frontmatter gives, and no caption but after a table at the top level', () => {
    const html = renderWithPlugin('---\ncrossref:\n  tbl-title: Exhibit\n  title-delim: "."\ntbl-cap-location: bottom\n---\n\n+---+\n| g |\n+---+\n\n: Grid {#tbl-g}\n\nText.\n\n: After text {#tbl-a}\n\n<!-- style: wide -->\n\n| a |\n|---|\n| 1 |\n\n: Styled {#tbl-s}\n\n<!-- /style -->\n');
    expect(html).toContain('</table>\n<p id="tbl-g" class="manuscript-markdown-table-caption">Exhibit 1. Grid</p>');
    expect(html).toContain('<p>: After text </p>');
    expect(html).toContain('<p>: Styled </p>');
  });
});

describe('table captions in linear time', () => {
  const tables = (n: number) => Array.from({ length: n }, (_, i) => '| a |\n|---|\n| ' + i + ' |\n\n: Caption ' + i + ' of *rates* {#tbl-c' + i + '}\n\nText.\n').join('\n');

  it('exports and imports many captioned tables in time linear in their number', async () => {
    const small = tables(100);
    const large = tables(400);
    const smallExport = await fastestRunAsync(() => convertMdToDocx(small, { sourceDir: dir }));
    const largeExport = await fastestRunAsync(() => convertMdToDocx(large, { sourceDir: dir }));
    expect(largeExport).toBeLessThan(8 * smallExport + 100);
    expect(largeExport).toBeLessThan(5000);
    const smallDocx = (await convertMdToDocx(small, { sourceDir: dir })).docx;
    const largeDocx = (await convertMdToDocx(large, { sourceDir: dir })).docx;
    const smallImport = await fastestRunAsync(() => convertDocx(smallDocx));
    const largeImport = await fastestRunAsync(() => convertDocx(largeDocx));
    expect(largeImport).toBeLessThan(8 * smallImport + 100);
    expect(largeImport).toBeLessThan(5000);
  });

  it('reads a caption\'s line of many labels in time linear in its length', () => {
    for (const unit of [' {#tbl-a}', '{#', ' {#tbl-a']) {
      const text = (n: number) => '| a |\n|---|\n| 1 |\n\n: ' + unit.repeat(Math.ceil(n / unit.length)).slice(0, n) + ' {#tbl-z}\n';
      const small = fastestRun(() => parseMd(text(16000)));
      const large = fastestRun(() => parseMd(text(64000)));
      expect(large).toBeLessThan(8 * small + 100);
      expect(large).toBeLessThan(2000);
      const smallPreview = fastestRun(() => renderWithPlugin(text(16000)));
      const largePreview = fastestRun(() => renderWithPlugin(text(64000)));
      expect(largePreview).toBeLessThan(8 * smallPreview + 100);
      expect(largePreview).toBeLessThan(4000);
    }
  });
});
