import { afterAll, describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMarkdown, convertDocx, DEFAULT_FORMATTING } from './converter';
import { convertMdToDocx, parseMd } from './md-to-docx';
import { renderWithPlugin } from './test-helpers';
import { fastestRun, fastestRunAsync } from './test-timing';

// A figure is an image alone in its paragraph with a label after it, as
// ![Caption](map.png){#fig-map}. Export writes Word's caption for it, and
// import reads Word's captions back as figures (see captions.ts).

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dir = mkdtempSync(join(tmpdir(), 'figure-captions-'));
writeFileSync(join(dir, 'map.png'), PNG);
// Where import puts a Word document's image, for its Markdown's export
mkdirSync(join(dir, 'media'));
writeFileSync(join(dir, 'media', 'image1.png'), PNG);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function exported(md: string, templateDocx?: Uint8Array) {
  const { docx, warnings } = await convertMdToDocx(md, { sourceDir: dir, ...(templateDocx ? { templateDocx } : {}) });
  const zip = await JSZip.loadAsync(docx);
  const document = await zip.file('word/document.xml')!.async('string');
  const body = document.slice(document.indexOf('<w:body>'), document.indexOf('<w:sectPr'))
    .replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, '<DRAWING/>')
    .replace(/ w14:paraId="[^"]*" w14:textId="[^"]*" w:rsidR="[^"]*" w:rsidRDefault="[^"]*"/g, '');
  const styles = await zip.file('word/styles.xml')!.async('string');
  const custom = await zip.file('docProps/custom.xml')?.async('string');
  return { docx, document, body, styles, custom, warnings };
}

const imported = async (docx: Uint8Array) => (await convertDocx(docx, 'pandoc', { imageFolder: 'media' })).markdown;

/** The paragraphs of a document body, one to a line */
const paragraphs = (body: string) => body.match(/<w:p>[\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];

/** Word's caption, as Word writes it with Insert Caption, with its number's field */
function seqField(n: number, id = 'Figure', rPr = ''): string {
  const r = rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '';
  return '<w:r>' + r + '<w:fldChar w:fldCharType="begin"/></w:r><w:r>' + r + '<w:instrText xml:space="preserve"> SEQ ' + id + ' \\* ARABIC </w:instrText></w:r><w:r>' + r + '<w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr>' + rPr + '<w:noProof/></w:rPr><w:t>' + n + '</w:t></w:r><w:r>' + r + '<w:fldChar w:fldCharType="end"/></w:r>';
}

interface CaptionOptions { title?: string; id?: string; sep?: string; bookmark?: string; simple?: boolean; labelRPr?: string; style?: string; after?: string }

function caption(n: number, text: string, opts: CaptionOptions = {}): string {
  const title = opts.title ?? 'Figure';
  const id = opts.id ?? 'Figure';
  const rPr = opts.labelRPr ? '<w:rPr>' + opts.labelRPr + '</w:rPr>' : '';
  const field = opts.simple
    ? '<w:fldSimple w:instr=" SEQ ' + id + ' \\* ARABIC "><w:r><w:rPr><w:noProof/></w:rPr><w:t>' + n + '</w:t></w:r></w:fldSimple>'
    : seqField(n, id, opts.labelRPr);
  const bookmarkStart = opts.bookmark ? '<w:bookmarkStart w:id="' + n + '" w:name="' + opts.bookmark + '"/>' : '';
  const bookmarkEnd = opts.bookmark ? '<w:bookmarkEnd w:id="' + n + '"/>' : '';
  const rest = text || opts.sep ? '<w:r><w:t xml:space="preserve">' + (opts.sep ?? ': ') + text + '</w:t></w:r>' : '';
  return '<w:p><w:pPr><w:pStyle w:val="' + (opts.style ?? 'Caption') + '"/></w:pPr>' + bookmarkStart
    + '<w:r>' + rPr + '<w:t xml:space="preserve">' + title + ' </w:t></w:r>' + field + bookmarkEnd + rest + (opts.after ?? '') + '</w:p>';
}

let pictureId = 0;
function picture(descr = ''): string {
  const id = ++pictureId;
  return '<w:p><w:pPr><w:keepNext/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="952500" cy="952500"/><wp:docPr id="' + id + '" name="Picture ' + id + '" descr="' + descr + '"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="' + id + '" name="Picture ' + id + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

const para = (text: string) => '<w:p><w:r><w:t xml:space="preserve">' + text + '</w:t></w:r></w:p>';

/** A caption whose text after its separator is the runs given */
const captionOf = (inner: string) => caption(1, '', { sep: ': ', after: inner });

const NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

function stylesXml(captionStyle: string | undefined): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' + (captionStyle ?? '') + '</w:styles>';
}

const wordCaptionStyle = (id = 'Caption', color = '44546A') => '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:spacing w:after="200" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="' + color + '"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>';

/** A .docx as Word writes one, with the body given */
async function wordDocx(body: string, opts: { captionStyle?: string | null; footnotes?: string } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a" TargetMode="External"/></Relationships>');
  zip.file('word/styles.xml', stylesXml(opts.captionStyle === null ? undefined : opts.captionStyle ?? wordCaptionStyle()));
  zip.file('word/media/image1.png', PNG);
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + '><w:body>' + body + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>');
  if (opts.footnotes) zip.file('word/footnotes.xml', opts.footnotes);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('exporting a figure', () => {
  it('writes Word\'s caption below the image, numbered, with a bookmark of its label', async () => {
    const { body, styles, custom, warnings } = await exported('Intro.\n\n![A *map* of rates](map.png){#fig-map}\n\n![Second](map.png){#fig-b}\n');
    expect(warnings).toEqual([]);
    expect(paragraphs(body)).toEqual([
      '<w:p><w:r><w:t>Intro.</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:keepNext/></w:pPr><w:r><DRAWING/></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:bookmarkStart w:id="0" w:name="fig_map"/><w:r><w:t xml:space="preserve">Figure </w:t></w:r>' + seqField(1) + '<w:bookmarkEnd w:id="0"/><w:r><w:t xml:space="preserve">: </w:t></w:r><w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>map</w:t></w:r><w:r><w:t xml:space="preserve"> of rates</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:keepNext/></w:pPr><w:r><DRAWING/></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:bookmarkStart w:id="1" w:name="fig_b"/><w:r><w:t xml:space="preserve">Figure </w:t></w:r>' + seqField(2) + '<w:bookmarkEnd w:id="1"/><w:r><w:t xml:space="preserve">: </w:t></w:r><w:r><w:t>Second</w:t></w:r></w:p>',
    ]);
    expect(styles).toContain('<w:style w:type="paragraph" w:styleId="Caption">');
    // Each bookmark's name gives its label back, so no property maps them
    expect(custom ?? '').not.toContain('MANUSCRIPT_CAPTION_LABELS_');
  });

  it('gives the image its caption\'s text as alt text, or fig-alt\'s', async () => {
    const { document } = await exported('![A *map*](map.png){#fig-map}\n\n![B](map.png){#fig-b fig-alt="The \\"alt\\""}\n\n![C](map.png){#fig-c fig-alt=""}\n');
    expect(document.match(/descr="[^"]*"/g)).toEqual(['descr="A map"', 'descr="The &quot;alt&quot;"', 'descr=""']);
  });

  it('writes the title and delimiter crossref: gives, and the caption above where fig-cap-location: top', async () => {
    const { body } = await exported('---\ncrossref:\n  fig-title: Supplementary Fig.\n  title-delim: "."\nfig-cap-location: top\n---\n\n![A map](map.png){#fig-map}\n\n![](map.png){#fig-e}\n');
    expect(paragraphs(body)).toEqual([
      '<w:p><w:pPr><w:pStyle w:val="Caption"/><w:keepNext/></w:pPr><w:bookmarkStart w:id="0" w:name="fig_map"/><w:r><w:t xml:space="preserve">Supplementary Fig. </w:t></w:r>' + seqField(1, 'Supplementary_Fig') + '<w:bookmarkEnd w:id="0"/><w:r><w:t xml:space="preserve">. </w:t></w:r><w:r><w:t>A map</w:t></w:r></w:p>',
      '<w:p><w:r><DRAWING/></w:r></w:p>',
      // A caption with no text takes no delimiter
      '<w:p><w:pPr><w:pStyle w:val="Caption"/><w:keepNext/></w:pPr><w:bookmarkStart w:id="1" w:name="fig_e"/><w:r><w:t xml:space="preserve">Supplementary Fig. </w:t></w:r>' + seqField(2, 'Supplementary_Fig') + '<w:bookmarkEnd w:id="1"/></w:p>',
      '<w:p><w:r><DRAWING/></w:r></w:p>',
    ]);
  });

  it('keeps in a property each label its bookmark\'s name doesn\'t give back', async () => {
    const { body, custom } = await exported('![A](map.png){#fig-a_b}\n\n![B](map.png){#fig-a-b}\n\n![C](map.png){#fig-c}\n');
    expect(body.match(/w:name="[^"]*"/g)).toEqual(['w:name="fig_a_b"', 'w:name="fig_a_b_2"', 'w:name="fig_c"']);
    const json = custom!.match(/MANUSCRIPT_CAPTION_LABELS_1"><vt:lpwstr>([^<]*)/)![1].replace(/&quot;/g, '"');
    expect(JSON.parse(json)).toEqual({ fig_a_b: 'fig-a_b', fig_a_b_2: 'fig-a-b' });
  });

  it('writes no caption for an image that\'s no figure, and warns', async () => {
    const md = 'Text and ![inline](map.png){#fig-in} here.\n\n> ![Quoted](map.png){#fig-q}\n\n- ![Listed](map.png){#fig-l}\n\n[![Linked](map.png){#fig-k}](https://example.com)\n';
    const { body, styles, warnings } = await exported(md);
    expect(body).not.toContain('Caption');
    expect(body).not.toContain('SEQ');
    expect(styles).not.toContain('w:styleId="Caption"');
    for (const label of ['fig-in', 'fig-q', 'fig-l', 'fig-k']) {
      expect(warnings.some(w => w.startsWith('The image labeled {#' + label + '} is no figure'))).toBe(true);
    }
  });

  it('warns of a label that labels no figure, and writes nothing of it, as of a comment range\'s start', async () => {
    const { body, warnings } = await exported('Text {#fig-x} and {#tbl-y} here.\n');
    expect(paragraphs(body).map(p => p.replace(/<[^>]+>/g, ''))).toEqual(['Text and here.']);
    expect(warnings).toEqual([
      'The label {#fig-x} labels no figure: a label goes right after an image alone in its paragraph, as ![Caption](map.png){#fig-x}. Word gets no label there.',
      'The label {#tbl-y} labels no table: export doesn\'t write a table\'s caption yet. Word gets no label there.',
    ]);
  });

  it('adds no Caption style to a document with no figure', async () => {
    const { styles } = await exported('![Plain](map.png)\n');
    expect(styles).not.toContain('w:styleId="Caption"');
  });

  it('keeps a template\'s Caption style, and adds Word\'s where the template has none', async () => {
    const red = await exported('![A](map.png){#fig-a}\n', await wordDocx(para('x'), { captionStyle: wordCaptionStyle('Caption', 'FF0000') }));
    expect(red.styles).toContain('<w:color w:val="FF0000"/>');
    expect(red.styles.match(/w:styleId="Caption"/g)).toHaveLength(1);
    const none = await exported('![A](map.png){#fig-a}\n', await wordDocx(para('x'), { captionStyle: null }));
    expect(none.styles).toContain('w:styleId="Caption"');
    expect(none.body).toContain('<w:pStyle w:val="Caption"/>');
  });
});

describe('importing Word\'s captions', () => {
  it('reads each caption, with its image, as a figure with a label', async () => {
    const md = await imported(await wordDocx(para('Intro.') + picture() + caption(1, 'Rates by region', { bookmark: '_Ref1' }) + picture('alt words') + caption(2, 'Second one') + para('After.')));
    expect(md).toBe('Intro.\n\n![Rates by region](media/image1.png){#fig-rates-by-region width=100 height=100 fig-alt=""}\n\n![Second one](media/image1.png){#fig-second-one width=100 height=100 fig-alt="alt words"}\n\nAfter.\n');
  });

  it('keeps the caption\'s separator, title and place in the frontmatter', async () => {
    expect(await imported(await wordDocx(picture() + caption(1, 'Rates', { simple: true, sep: '. ' }) + picture() + caption(2, 'More', { simple: true, sep: '. ' }))))
      .toBe('---\ncrossref:\n  title-delim: "."\n---\n\n![Rates](media/image1.png){#fig-rates width=100 height=100 fig-alt=""}\n\n![More](media/image1.png){#fig-more width=100 height=100 fig-alt=""}\n');
    expect(await imported(await wordDocx(para('Intro.') + caption(1, 'Top one') + picture() + caption(2, 'Top two') + picture())))
      .toBe('---\nfig-cap-location: top\n---\n\nIntro.\n\n![Top one](media/image1.png){#fig-top-one width=100 height=100 fig-alt=""}\n\n![Top two](media/image1.png){#fig-top-two width=100 height=100 fig-alt=""}\n');
    expect(await imported(await wordDocx(picture() + caption(1, 'Karte', { title: 'Abbildung', id: 'Abbildung', style: 'Beschriftung' }), { captionStyle: wordCaptionStyle('Beschriftung') })))
      .toBe('---\ncrossref:\n  fig-title: Abbildung\n---\n\n![Karte](media/image1.png){#fig-karte width=100 height=100 fig-alt=""}\n');
    expect(await imported(await wordDocx(picture() + caption(1, 'Dashed', { sep: ' \u2014 ' }) + picture() + caption(2, 'Tabbed', { title: 'Fig.', id: 'Fig', sep: '\t' }))))
      .toContain('crossref:\n  title-delim: " \u2014"\n---\n\n![Dashed]');
  });

  it('takes the label of a bookmark export named, and numbers the figures afresh', async () => {
    expect(await imported(await wordDocx(picture() + caption(7, 'Map', { bookmark: 'fig_map' }) + picture() + caption(3, 'Map'))))
      .toBe('![Map](media/image1.png){#fig-map width=100 height=100 fig-alt=""}\n\n![Map](media/image1.png){#fig-map-2 width=100 height=100 fig-alt=""}\n');
    expect(await imported(await wordDocx(picture() + caption(1, '')))).toBe('![](media/image1.png){#fig-1 width=100 height=100}\n');
  });

  it('reads a caption\'s formatting, math and links', async () => {
    const formatted = captionOf('<w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>map</w:t></w:r><w:r><w:t xml:space="preserve"> of </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>rates</w:t></w:r><w:r><w:t xml:space="preserve"> and H</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>2</w:t></w:r><w:r><w:t xml:space="preserve">O </w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>hi</w:t></w:r><w:r><w:t xml:space="preserve"> [see] *star*</w:t></w:r>');
    expect(await imported(await wordDocx(picture() + formatted)))
      .toBe('![A *map* of **rates** and H<sub>2</sub>O ==hi== [see] \\*star\\*](media/image1.png){#fig-a-map-of-rates-and width=100 height=100 fig-alt=""}\n');
    expect(await imported(await wordDocx(picture() + captionOf('<w:r><w:t xml:space="preserve">Rate </w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>'))))
      .toBe('![Rate $x$](media/image1.png){#fig-rate width=100 height=100 fig-alt=""}\n');
    expect(await imported(await wordDocx(picture() + captionOf('<w:hyperlink r:id="rId20"><w:r><w:t>link</w:t></w:r></w:hyperlink>'))))
      .toBe('![[link](https://example.com/a)](media/image1.png){#fig-link width=100 height=100 fig-alt=""}\n');
  });

  // A caption export can't write as Word has it stays as it is, as text, and
  // so do the others of its numbers' series, which otherwise would number
  // from 1 again, and show a number twice
  const unread: [string, string, { footnotes?: string }][] = [
    ['a tracked change', picture() + captionOf('<w:ins w:id="5" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>New</w:t></w:r></w:ins>'), {}],
    ['a comment', picture() + captionOf('<w:commentRangeStart w:id="1"/><w:r><w:t>Commented</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>'), {}],
    ['a line break', picture() + captionOf('<w:r><w:t>A</w:t><w:br/><w:t>B</w:t></w:r>'), {}],
    ['a chapter\'s number', picture() + '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t xml:space="preserve">Figure </w:t></w:r><w:fldSimple w:instr=" STYLEREF 1 \\s "><w:r><w:t>2</w:t></w:r></w:fldSimple><w:r><w:t>-</w:t></w:r>' + seqField(1) + '<w:r><w:t xml:space="preserve">: Chapter</w:t></w:r></w:p>', {}],
    ['a label in bold', picture() + caption(1, 'Bold label', { labelRPr: '<w:b/>' }), {}],
    ['separators that differ', picture() + caption(1, 'A', { sep: '. ' }) + picture() + caption(2, 'B'), {}],
    ['no separator', picture() + caption(1, 'Joined', { sep: '' }), {}],
    ['a separator alone', picture() + caption(1, '', { sep: ':' }), {}],
    ['a paragraph between', picture() + '<w:p/>' + caption(1, 'Gap'), {}],
    ['text by the image', '<w:p><w:r><w:t>x</w:t></w:r>' + picture().slice('<w:p>'.length) + caption(1, 'Mixed'), {}],
    ['a caption in a table', picture() + caption(1, 'Body') + '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>' + caption(2, 'In a cell') + '</w:tc></w:tr></w:tbl>', {}],
    ['a caption in a note', picture() + caption(1, 'Body'), { footnotes: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p>' + seqField(2) + '</w:p></w:footnote></w:footnotes>' }],
  ];
  it.each(unread)('leaves a caption with %s as text', async (_name, body, opts) => {
    const md = await imported(await wordDocx(body, opts));
    expect(md).not.toContain('{#fig-');
    expect(md).toContain('![](media/image1.png){width=100 height=100}');
    expect(md).not.toContain('crossref');
  });

  it('reads the series with the most captions, and leaves the others as text', async () => {
    const md = await imported(await wordDocx(picture() + caption(1, 'A') + picture() + caption(2, 'B') + picture() + caption(1, 'S', { title: 'Supplementary Figure', id: 'SFig' })));
    expect(md).toBe('![A](media/image1.png){#fig-a width=100 height=100 fig-alt=""}\n\n![B](media/image1.png){#fig-b width=100 height=100 fig-alt=""}\n\n![](media/image1.png){width=100 height=100}\n\nSupplementary Figure 1: S\n');
  });

  it('gives a comment named as a caption\'s label a number, as its {#fig-map} would start no range', () => {
    const comments = new Map([['0', { author: 'alice', text: 'note', date: '' }]]);
    const content = [{ type: 'text' as const, text: 'A', commentIds: new Set(['0']), formatting: DEFAULT_FORMATTING }];
    const md = buildMarkdown(content, comments, { alwaysUseCommentIds: true, commentIdMapping: new Map([['0', 'fig-map']]) });
    expect(md).toContain('{#1}');
    expect(md).not.toContain('fig-map');
  });
});

describe('figures\' round trips', () => {
  const trip = async (md: string) => imported((await convertMdToDocx(md, { sourceDir: dir })).docx);

  it('reads back each figure export writes, as it was', async () => {
    for (const [md, back] of [
      ['Intro.\n\n![A *map* of rates](map.png){#fig-map}\n\nAfter.\n', 'Intro.\n\n![A *map* of rates](media/map.png){#fig-map width=1 height=1}\n\nAfter.\n'],
      ['---\ncrossref:\n  fig-title: Fig.\n  title-delim: "."\nfig-cap-location: top\n---\n\n![A map](map.png){#fig-map}\n\n![Second $x^2$ **bold**](map.png){#fig-two}\n',
        '---\ncrossref:\n  fig-title: Fig.\n  title-delim: "."\nfig-cap-location: top\n---\n\n![A map](media/map.png){#fig-map width=1 height=1}\n\n![Second $x^2$ **bold**](media/map.png){#fig-two width=1 height=1}\n'],
      ['![](map.png){#fig-a_b}\n\n![Rates [2010] \\*](map.png){#fig-rates fig-alt="A \\"map\\""}\n', '![](media/map.png){#fig-a_b width=1 height=1}\n\n![Rates [2010] \\*](media/map.png){#fig-rates width=1 height=1 fig-alt="A \\"map\\""}\n'],
      ['![Caption](map.png){#fig-x}\n\n![Caption](map.png){#fig-x}\n', '![Caption](media/map.png){#fig-x width=1 height=1}\n\n![Caption](media/map.png){#fig-x-2 width=1 height=1}\n'],
      ['![[link](https://example.com/a) and ==hi==](map.png){#fig-k}\n', '![[link](https://example.com/a) and ==hi==](media/map.png){#fig-k width=1 height=1}\n'],
    ]) {
      const once = await trip(md);
      expect(once).toBe(back);
      expect(await trip(once)).toBe(once);
    }
  });

  it('writes Word\'s caption back as Word had it', async () => {
    const word = await wordDocx(picture() + caption(1, 'Rates by region', { bookmark: '_Ref1', sep: '. ' }) + picture('Alt') + caption(2, 'More', { sep: '. ' }));
    const { body } = await exported(await imported(word));
    expect(paragraphs(body).filter(p => p.includes('Caption')).map(p => p.replace(/<w:instrText[^>]*>[^<]*<\/w:instrText>|<[^>]+>/g, ''))).toEqual(['Figure 1. Rates by region', 'Figure 2. More']);
    const { document } = await exported(await imported(word));
    expect(document.match(/descr="[^"]*"/g)).toEqual(['descr=""', 'descr="Alt"']);
  });
});

describe('previewing a figure', () => {
  it('shows a figure with its caption, numbered', () => {
    const html = renderWithPlugin('Intro.\n\n![A *map* of rates](map.png){#fig-map width=2in}\n\n![Second](b.png){#fig-b fig-alt="Alt &amp; text"}\n\nSee ![inline](c.png){#fig-c}.\n');
    expect(html).toContain('<figure id="fig-map" class="manuscript-markdown-figure"><img src="map.png" alt="A map of rates" style="width: 2in"><figcaption>Figure 1: A <em>map</em> of rates</figcaption></figure>');
    expect(html).toContain('<figure id="fig-b" class="manuscript-markdown-figure"><img src="b.png" alt="Alt &amp; text"><figcaption>Figure 2: Second</figcaption></figure>');
    expect(html).toContain('<p>See <img src="c.png" alt="inline">.</p>');
  });

  it('shows the title, delimiter and place the frontmatter gives, and no figure in a quote or style block', () => {
    const html = renderWithPlugin('---\ncrossref:\n  fig-title: Fig.\n  title-delim: "."\nfig-cap-location: top\n---\n\n![A map](map.png){#fig-map width=300}\n\n<!-- style: wide -->\n\n![Styled](s.png){#fig-s}\n\n<!-- /style -->\n\n> ![Quoted](q.png){#fig-q}\n\n![](e.png){#fig-e}\n');
    expect(html).toContain('<figure id="fig-map" class="manuscript-markdown-figure"><figcaption>Fig. 1. A map</figcaption><img src="map.png" alt="A map" width="300"></figure>');
    expect(html).toContain('<p><img src="s.png" alt="Styled"></p>');
    expect(html).toContain('<p><img src="q.png" alt="Quoted"></p>');
    expect(html).toContain('<figure id="fig-e" class="manuscript-markdown-figure"><figcaption>Fig. 2</figcaption><img src="e.png" alt=""></figure>');
  });
});

describe('figures in linear time', () => {
  const figures = (n: number) => Array.from({ length: n }, (_, i) => '![Caption ' + i + ' of *rates*](map.png){#fig-c' + i + '}\n\nText.\n').join('\n');

  it('exports and imports many figures in time linear in their number', async () => {
    const small = figures(100);
    const large = figures(400);
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

  it('reads images with labels that never close in time linear in their length', () => {
    for (const unit of ['![a](b){#fig-a ', '![a](b){#fig-a fig-alt="', '![a](b){#fig-a {']) {
      const text = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      const small = fastestRun(() => parseMd(text(16000)));
      const large = fastestRun(() => parseMd(text(64000)));
      expect(large).toBeLessThan(8 * small + 100);
      expect(large).toBeLessThan(2000);
    }
  });
});
