import { describe, it, expect } from 'bun:test';
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const WML = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="' + REL.slice(0, -1) + '" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
// A 1x1 PNG, and another, a picture bullet's
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const BULLET = new Uint8Array([...PNG, 1, 2]);
const LANDSCAPE_MD = 'Intro\n\n<!-- landscape -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<!-- /landscape -->\n\nAfter';

const para = (text: string, style: string) => '<w:p><w:pPr><w:pStyle w:val="' + style + '"/></w:pPr><w:r><w:t>' + text + '</w:t></w:r></w:p>';
const part = (tag: 'hdr' | 'ftr', body: string) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:' + tag + ' ' + NS + '>' + body + '</w:' + tag + '>';
const logo = '<w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill>' +
  '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
const pageField = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';

/**
 * A template as Word saves one: a running head with a logo, a page number,
 * a first-page header and footer, even-page ones, and its settings' even and
 * odd headers. `shuffled` numbers its relationships as an older Word does,
 * the headers' among the IDs export gives its own parts. `landscapeLast`
 * adds a landscape section, the last, with its own default header and footer.
 * `headerList` numbers the even header's paragraph with the template's
 * numId 3, which nothing else uses, directly or through its style, a style
 * based on one that numbers. `pictureBullet` bullets that list with an
 * image the numbering names.
 */
async function headerTemplate(opts: { shuffled?: boolean; landscapeLast?: boolean; headerList?: 'direct' | 'style'; pictureBullet?: boolean } = {}): Promise<Uint8Array> {
  const base = await JSZip.loadAsync((await convertMdToDocx('Template text')).docx);
  const zip = new JSZip();
  for (const path of ['word/styles.xml', 'word/theme/theme1.xml', 'word/fontTable.xml', 'word/webSettings.xml', 'docProps/core.xml', 'docProps/app.xml', '_rels/.rels']) {
    zip.file(path, await base.file(path)!.async('uint8array'));
  }
  if (opts.headerList) {
    const numbering = await (await JSZip.loadAsync((await convertMdToDocx('- a\n\n1. b')).docx)).file('word/numbering.xml')!.async('string');
    const level = opts.pictureBullet ? '<w:numFmt w:val="bullet"/><w:lvlText w:val="\uF0B7"/><w:lvlPicBulletId w:val="0"/>' : '<w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/>';
    zip.file('word/numbering.xml', numbering
      .replace('<w:abstractNum ', (opts.pictureBullet ? '<w:numPicBullet w:numPicBulletId="0"><w:pict><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:9pt;height:9pt">' +
        '<v:imagedata r:id="rId1" o:title=""/></v:shape></w:pict></w:numPicBullet>\n' : '') + '<w:abstractNum ')
      .replace('<w:num ', '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/>' + level + '</w:lvl></w:abstractNum>\n<w:num ')
      .replace('</w:numbering>', '<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num>\n</w:numbering>')
      .replace('<w:numbering ', '<w:numbering xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="' + REL.slice(0, -1) + '" '));
    if (opts.pictureBullet) {
      zip.file('word/_rels/numbering.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + 'image" Target="media/image2.png"/></Relationships>');
      zip.file('word/media/image2.png', BULLET);
    }
    if (opts.headerList === 'style') {
      zip.file('word/styles.xml', (await base.file('word/styles.xml')!.async('string')).replace('</w:styles>',
        '<w:style w:type="paragraph" w:styleId="HeaderListBase"><w:name w:val="Header List Base"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="HeaderList"><w:name w:val="Header List"/><w:basedOn w:val="HeaderListBase"/></w:style></w:styles>'));
    }
  }
  zip.file('word/settings.xml', (await base.file('word/settings.xml')!.async('string')).replace('<w:characterSpacingControl', '<w:evenAndOddHeaders/><w:characterSpacingControl'));
  const rels: Array<[string, string]> = [['styles', 'styles.xml'], ['settings', 'settings.xml'], ['webSettings', 'webSettings.xml'],
    ...(opts.headerList ? [['numbering', 'numbering.xml']] as Array<[string, string]> : []),
    ['header', 'header1.xml'], ['header', 'header2.xml'], ['footer', 'footer1.xml'], ['footer', 'footer2.xml'], ['header', 'header3.xml'], ['footer', 'footer3.xml'],
    ...(opts.landscapeLast ? [['header', 'header4.xml'], ['footer', 'footer4.xml']] as Array<[string, string]> : []),
    ['fontTable', 'fontTable.xml'], ['theme', 'theme/theme1.xml']];
  const id = (target: string) => 'rId' + (opts.shuffled ? rels.length - rels.findIndex(r => r[1] === target) : rels.findIndex(r => r[1] === target) + 1);
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.map(([type, target]) => '<Relationship Id="' + id(target) + '" Type="' + REL + type + '" Target="' + target + '"/>').join('') + '</Relationships>');
  zip.file('word/header1.xml', part('hdr', '<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>' + logo + '<w:r><w:t>RUNNING HEAD</w:t></w:r></w:p>'));
  zip.file('word/_rels/header1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + 'image" Target="media/image1.png"/></Relationships>');
  zip.file('word/media/image1.png', PNG);
  zip.file('word/header2.xml', part('hdr', para('FIRST HEADER', 'Header')));
  zip.file('word/header3.xml', part('hdr', opts.headerList === 'direct'
    ? '<w:p><w:pPr><w:pStyle w:val="Header"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>EVEN HEADER</w:t></w:r></w:p>'
    : para('EVEN HEADER', opts.headerList === 'style' ? 'HeaderList' : 'Header')));
  zip.file('word/footer1.xml', part('ftr', '<w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:r><w:t xml:space="preserve">Page </w:t></w:r>' + pageField + '</w:p>'));
  zip.file('word/footer2.xml', part('ftr', para('FIRST FOOTER', 'Footer')));
  zip.file('word/footer3.xml', part('ftr', para('EVEN FOOTER', 'Footer')));
  if (opts.landscapeLast) {
    zip.file('word/header4.xml', part('hdr', para('LANDSCAPE HEADER', 'Header')));
    zip.file('word/footer4.xml', part('ftr', para('LANDSCAPE FOOTER', 'Footer')));
  }
  const margins = '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>';
  // References in the order Word writes them
  const portrait = '<w:sectPr w:rsidR="00A1B2C3" w:rsidSect="00A1B2C3">' +
    '<w:headerReference w:type="even" r:id="' + id('header3.xml') + '"/><w:headerReference w:type="default" r:id="' + id('header1.xml') + '"/>' +
    '<w:footerReference w:type="even" r:id="' + id('footer3.xml') + '"/><w:footerReference w:type="default" r:id="' + id('footer1.xml') + '"/>' +
    '<w:headerReference w:type="first" r:id="' + id('header2.xml') + '"/><w:footerReference w:type="first" r:id="' + id('footer2.xml') + '"/>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' + margins + '<w:cols w:space="720"/><w:titlePg/><w:docGrid w:linePitch="360"/></w:sectPr>';
  const body = opts.landscapeLast
    ? '<w:p><w:r><w:t>Template text</w:t></w:r></w:p><w:p><w:pPr>' + portrait + '</w:pPr></w:p><w:p><w:r><w:t>Wide</w:t></w:r></w:p>' +
      '<w:sectPr w:rsidR="00A1B2C3"><w:headerReference w:type="default" r:id="' + id('header4.xml') + '"/><w:footerReference w:type="default" r:id="' + id('footer4.xml') + '"/>' +
      '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>' + margins + '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>'
    : '<w:p><w:r><w:t>Template text</w:t></w:r></w:p>' + portrait;
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ' + NS + '><w:body>' + body + '</w:body></w:document>');
  const override = (name: string, type: string) => '<Override PartName="/word/' + name + '" ContentType="' + type + '"/>';
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    override('document.xml', WML + 'document.main+xml') + override('styles.xml', WML + 'styles+xml') + override('settings.xml', WML + 'settings+xml') +
    override('webSettings.xml', WML + 'webSettings+xml') + override('fontTable.xml', WML + 'fontTable+xml') + override('theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml') +
    (opts.headerList ? override('numbering.xml', WML + 'numbering+xml') : '') +
    rels.filter(([type]) => type === 'header' || type === 'footer').map(([type, target]) => override(target, WML + type + '+xml')).join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>');
  const docx = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  expect(await packageProblems(docx)).toEqual([]);
  return docx;
}

const attr = (tag: string, name: string) => new RegExp('\\s' + name + '="([^"]*)"').exec(tag)?.[1];
function resolveTarget(source: string, target: string): string {
  const segments = source.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}
const relsPathOf = (path: string) => path.replace(/[^/]+$/, name => '_rels/' + name + '.rels');
/** A part's text, UTF-16 by its BOM */
async function textOf(zip: JSZip, path: string): Promise<string | undefined> {
  const bytes = await zip.file(path)?.async('uint8array');
  return bytes && new TextDecoder(bytes[0] === 0xFF && bytes[1] === 0xFE ? 'utf-16le' : 'utf-8').decode(bytes);
}
/** A template with one of its parts changed */
async function editTemplate(docx: Uint8Array, path: string, edit: (xml: string) => string | Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);
  zip.file(path, edit((await textOf(zip, path))!));
  return zip.generateAsync({ type: 'uint8array' });
}
/** Text in UTF-16, as some tools write XML */
const utf16 = (xml: string) => {
  const bytes = new Uint8Array(2 + xml.length * 2);
  bytes.set([0xFF, 0xFE]);
  for (let i = 0; i < xml.length; i++) bytes.set([xml.charCodeAt(i) & 0xFF, xml.charCodeAt(i) >> 8], 2 + i * 2);
  return bytes;
};

/**
 * What Word would repair in a package: a part without a content type, a
 * relationship to no part, a reference to no relationship or to one of
 * another type, document.xml's relationship IDs out of sequence, a drawing
 * ID twice, XML that isn't well-formed
 */
async function packageProblems(docx: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(docx);
  const problems: string[] = [];
  const files = Object.keys(zip.files).filter(path => !zip.files[path].dir);
  const types = (await textOf(zip, '[Content_Types].xml'))!;
  const defaults = new Set([...types.matchAll(/<Default\b[^>]*>/g)].map(([tag]) => attr(tag, 'Extension')!.toLowerCase()));
  const overrides = new Map([...types.matchAll(/<Override\b[^>]*>/g)].map(([tag]) => [attr(tag, 'PartName')!.slice(1), attr(tag, 'ContentType')!]));
  for (const path of files) {
    if (path !== '[Content_Types].xml' && !overrides.has(path) && !defaults.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase())) problems.push(path + ' has no content type');
    if (/^word\/(header|footer)\d+\.xml$/.test(path) && overrides.get(path) !== WML + path.slice(5, 11) + '+xml') problems.push(path + ' is typed ' + overrides.get(path));
  }
  for (const path of overrides.keys()) if (!files.includes(path)) problems.push('a content type for no part ' + path);
  const docPrIds = new Set<string>();
  const numIds = new Set([...(await textOf(zip, 'word/numbering.xml') ?? '').matchAll(/<w:num w:numId="(\d+)"/g)].map(m => m[1]));
  for (const path of files.filter(path => /\.xml$/.test(path))) {
    const xml = (await textOf(zip, path))!;
    if (XMLValidator.validate(xml) !== true) problems.push(path + ' is not well-formed');
    for (const [, numId] of xml.matchAll(/<w:numId w:val="(\d+)"/g)) if (!numIds.has(numId)) problems.push(path + ': numId ' + numId + ' has no numbering');
    const rels = new Map<string, string>();
    const relsXml = await textOf(zip, relsPathOf(path));
    for (const [tag] of relsXml?.matchAll(/<Relationship\b[^>]*>/g) ?? []) {
      rels.set(attr(tag, 'Id')!, attr(tag, 'Type')!.slice(attr(tag, 'Type')!.lastIndexOf('/') + 1));
      if (attr(tag, 'TargetMode') !== 'External' && !files.includes(resolveTarget(path, attr(tag, 'Target')!))) problems.push(relsPathOf(path) + ' targets no part: ' + attr(tag, 'Target'));
    }
    if (path === 'word/document.xml') {
      const ids = [...rels.keys()].map(id => parseInt(id.slice(3), 10)).sort((a, b) => a - b);
      if (ids.some((n, i) => n !== i + 1)) problems.push('document.xml relationship IDs ' + ids.join(','));
    }
    for (const [tag, element] of xml.matchAll(/<\w+:(\w+)\b[^>]*\sr:(?:id|embed|link)="[^"]*"[^>]*>/g)) {
      const id = /\sr:(?:id|embed|link)="([^"]*)"/.exec(tag)![1];
      const type = rels.get(id);
      if (!type) problems.push(path + ': ' + element + ' ' + id + ' names no relationship');
      else if (/^(header|footer)Reference$/.test(element) && type !== element.slice(0, 6)) problems.push(path + ': ' + element + ' ' + id + ' names a ' + type);
    }
    for (const [, docPrId] of xml.matchAll(/<wp:docPr\b[^>]*\sid="(\d+)"/g)) {
      if (docPrIds.has(docPrId)) problems.push('drawing ID ' + docPrId + ' twice');
      docPrIds.add(docPrId);
    }
  }
  return problems;
}

/** Each section's orientation and title page, and the text of each header and footer its references name */
async function sectionHeaders(docx: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(docx);
  const xml = (await textOf(zip, 'word/document.xml'))!;
  const relsXml = (await textOf(zip, 'word/_rels/document.xml.rels'))!;
  const targets = new Map([...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [attr(tag, 'Id')!, attr(tag, 'Target')!]));
  const sections: string[] = [];
  for (const [sectPr] of xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)) {
    let section = (sectPr.includes('w:orient="landscape"') ? 'landscape' : 'portrait') + (sectPr.includes('<w:titlePg/>') ? ' titlePg' : '');
    for (const [, kind, type, id] of sectPr.matchAll(/<w:(header|footer)Reference w:type="(\w+)" r:id="(\w+)"\/>/g)) {
      const target = targets.get(id);
      const text = target && await textOf(zip, 'word/' + target);
      section += ' ' + kind + ':' + type + '=' + (text === undefined ? '(none)' : text.replace(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/g, '{$1}').replace(/<[^>]+>/g, '').trim());
    }
    sections.push(section);
  }
  return sections;
}

const ALL_HEADERS = 'header:even=EVEN HEADER header:default=RUNNING HEAD footer:even=EVEN FOOTER footer:default=Page { PAGE }1 header:first=FIRST HEADER footer:first=FIRST FOOTER';

describe('a template\'s headers and footers', () => {
  it('go into the export with their relationships, images and content types', async () => {
    const { docx } = await convertMdToDocx('Hello', { templateDocx: await headerTemplate() });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['portrait titlePg ' + ALL_HEADERS]);
    const zip = await JSZip.loadAsync(docx);
    // The running head's logo, through the header's own relationships
    expect(await zip.file('word/_rels/header1.xml.rels')!.async('string')).toContain('Target="media/image1.png"');
    expect(await zip.file('word/media/image1.png')!.async('uint8array')).toEqual(PNG);
    // Word shows the even-page ones only with this setting
    expect(await zip.file('word/settings.xml')!.async('string')).toContain('<w:evenAndOddHeaders/>');
  });

  it('keep their parts where the template\'s IDs are the ones export gives its own parts', async () => {
    const { docx } = await convertMdToDocx('[a link](https://example.com)', { templateDocx: await headerTemplate({ shuffled: true }) });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['portrait titlePg ' + ALL_HEADERS]);
  });

  it('go in the first section, which the sections export adds for orientation continue', async () => {
    const { docx } = await convertMdToDocx(LANDSCAPE_MD, { templateDocx: await headerTemplate() });
    expect(await packageProblems(docx)).toEqual([]);
    // A section without a reference takes the one before's, and only the
    // document's first page is a title page
    expect(await sectionHeaders(docx)).toEqual(['portrait titlePg ' + ALL_HEADERS, 'landscape', 'portrait']);
  });

  it('take the last section\'s, each as that section shows it, and the first\'s title page', async () => {
    const { docx } = await convertMdToDocx('Hello', { templateDocx: await headerTemplate({ landscapeLast: true }) });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['landscape titlePg header:even=EVEN HEADER header:default=LANDSCAPE HEADER footer:even=EVEN FOOTER ' +
      'footer:default=LANDSCAPE FOOTER header:first=FIRST HEADER footer:first=FIRST FOOTER']);
  });

  it('keep their images apart from the Markdown\'s, whose names they had', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'template-sections-'));
    try {
      writeFileSync(join(dir, 'a.png'), PNG);
      writeFileSync(join(dir, 'b.png'), new Uint8Array([...PNG, 0]));
      const { docx } = await convertMdToDocx('![a](a.png)\n\n![b](b.png)', { templateDocx: await headerTemplate(), sourceDir: dir });
      expect(await packageProblems(docx)).toEqual([]);
      const zip = await JSZip.loadAsync(docx);
      expect(await zip.file('word/_rels/header1.xml.rels')!.async('string')).toContain('Target="media/image2.png"');
      expect((await zip.file('word/media/image1.png')!.async('uint8array')).length).toBe(PNG.length + 1);
      // The Markdown's images still read back as they were
      expect((await convertDocx(docx)).markdown).toContain('![a](a.png){width=1 height=1}\n\n![b](b.png){width=1 height=1}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drop a reference that names no part, or a part of another kind', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('P')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).toContain('Id="rId1" Type="' + REL + 'styles"');
    zip.file('word/document.xml', xml.replace(/<w:sectPr\b[^>]*>(?=[\s\S]*<\/w:body>)(?![\s\S]*<w:sectPr)/,
      sectPr => sectPr + '<w:headerReference w:type="default" r:id="rId99"/><w:footerReference w:type="default" r:id="rId1"/>'));
    const { docx } = await convertMdToDocx('Hello', { templateDocx: await zip.generateAsync({ type: 'uint8array' }) });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['portrait']);
  });

  it('come with the other relationships the last section names, as its printer settings\'', async () => {
    const zip = await JSZip.loadAsync(await headerTemplate());
    const settings = new Uint8Array([7, 7, 7]);
    // Its ID, after the template's others, is one export gives its own parts
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    zip.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rId12" Type="' + REL + 'printerSettings" Target="printerSettings/printerSettings1.bin"/></Relationships>'));
    zip.file('word/printerSettings/printerSettings1.bin', settings);
    const types = await zip.file('[Content_Types].xml')!.async('string');
    zip.file('[Content_Types].xml', types.replace('<Default ', '<Default Extension="bin" ContentType="' + WML + 'printerSettings"/><Default '));
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('<w:docGrid w:linePitch="360"/></w:sectPr>', '<w:docGrid w:linePitch="360"/><w:printerSettings r:id="rId12"/></w:sectPr>'));
    const { docx } = await convertMdToDocx('[a link](https://example.com)', { templateDocx: await zip.generateAsync({ type: 'uint8array' }) });
    expect(await packageProblems(docx)).toEqual([]);
    const out = await JSZip.loadAsync(docx);
    const id = /<w:printerSettings r:id="(\w+)"\/><\/w:sectPr>/.exec(await out.file('word/document.xml')!.async('string'))?.[1];
    const relationship = [...(await out.file('word/_rels/document.xml.rels')!.async('string')).matchAll(/<Relationship\b[^>]*>/g)].find(([tag]) => attr(tag, 'Id') === id)?.[0];
    expect(relationship && attr(relationship, 'Type')).toBe(REL + 'printerSettings');
    expect(await out.file('word/' + attr(relationship!, 'Target'))!.async('uint8array')).toEqual(settings);
  });

  it('come from the last section\'s own properties, not those a tracked change to them holds', async () => {
    const zip = await JSZip.loadAsync(await headerTemplate());
    // Word keeps the section's earlier properties, a landscape page without
    // a title page, in the change
    const earlier = '<w:sectPrChange w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>' +
      '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/><w:cols w:space="720"/></w:sectPr></w:sectPrChange>';
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('<w:docGrid w:linePitch="360"/></w:sectPr>', '<w:docGrid w:linePitch="360"/>' + earlier + '</w:sectPr>'));
    const { docx } = await convertMdToDocx(LANDSCAPE_MD, { templateDocx: await zip.generateAsync({ type: 'uint8array' }) });
    expect(await packageProblems(docx)).toEqual([]);
    const out = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    // The change stays as it was, and each section has the template's page,
    // the first its headers, footers and title page
    expect(out).toContain(earlier + '</w:sectPr>');
    const sectPrs = out.replace(earlier, '').match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g) ?? [];
    expect(sectPrs.map(sectPr => [/<w:pgSz\b[^>]*>/.exec(sectPr)?.[0], /<w:pgMar w:top="(\d+)"/.exec(sectPr)?.[1], sectPr.match(/<w:(?:header|footer)Reference\b/g)?.length ?? 0, sectPr.includes('<w:titlePg/>')])).toEqual([
      ['<w:pgSz w:w="12240" w:h="15840"/>', '1440', 6, true],
      ['<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>', '1440', 0, false],
      ['<w:pgSz w:w="12240" w:h="15840"/>', '1440', 0, false],
    ]);
  });

  it('stay through Word → Markdown → Word, and a second trip changes nothing', async () => {
    for (const md of ['Hello', LANDSCAPE_MD]) {
      const word1 = (await convertMdToDocx(md, { templateDocx: await headerTemplate() })).docx;
      const md1 = (await convertDocx(word1)).markdown;
      // The template is the document itself, as Export to Word takes it
      const word2 = (await convertMdToDocx(md1, { templateDocx: word1 })).docx;
      expect((await convertDocx(word2)).markdown).toBe(md1);
      const word3 = (await convertMdToDocx(md1, { templateDocx: word2 })).docx;
      expect(await packageProblems(word3)).toEqual([]);
      expect(await sectionHeaders(word2)).toEqual(await sectionHeaders(word1));
      expect(await sectionHeaders(word3)).toEqual(await sectionHeaders(word1));
      const [zip1, zip3] = await Promise.all([JSZip.loadAsync(word1), JSZip.loadAsync(word3)]);
      const parts = (zip: JSZip) => Object.keys(zip.files).filter(path => /header|footer|media/.test(path)).sort();
      expect(parts(zip3)).toEqual(parts(zip1));
      for (const path of parts(zip1)) {
        expect(await zip3.file(path)!.async('string')).toBe(await zip1.file(path)!.async('string'));
      }
    }
  });

  it('keep the numbering of a header\'s list, which export neither drops nor gives a list of its own', async () => {
    const templateDocx = await headerTemplate({ headerList: 'direct' });
    const numId3 = /<w:num w:numId="3"[^>]*>[\s\S]*?<\/w:num>/;
    for (const md of ['Hello', '8. item']) {
      const { docx } = await convertMdToDocx(md, { templateDocx });
      expect(await packageProblems(docx)).toEqual([]);
      const numbering = (await textOf(await JSZip.loadAsync(docx), 'word/numbering.xml'))!;
      expect(numId3.exec(numbering)?.[0]).toBe('<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num>');
    }
  });

  it('drop a header\'s references to the template\'s comments and notes, which export doesn\'t keep', async () => {
    const templateDocx = await editTemplate(await headerTemplate(), 'word/header2.xml', xml => xml.replace('<w:r><w:t>FIRST HEADER</w:t></w:r>',
      '<w:commentRangeStart w:id="0"/><w:r><w:t>FIRST HEADER</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:footnoteReference w:id="1"></w:footnoteReference></w:r>'));
    const { docx } = await convertMdToDocx('Text[^1]\n\n[^1]: A note.', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    const header = (await textOf(await JSZip.loadAsync(docx), 'word/header2.xml'))!;
    expect(header).toContain('FIRST HEADER');
    expect(header).not.toMatch(/<w:(comment\w+|footnoteReference)\b/);
  });

  it('come from references with an end tag', async () => {
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml',
      xml => xml.replace(/(<w:headerReference w:type="default" r:id="\w+")\/>/, '$1></w:headerReference>'));
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['portrait titlePg ' + ALL_HEADERS]);
  });

  it('come from XML whose attributes have single quotes and space around =', async () => {
    const requote = (xml: string) => xml.replace(/ ([\w:]+)="([^"]*)"/g, (_, name: string, value: string) => ' ' + name + ' = \'' + value + '\'');
    let templateDocx = await headerTemplate();
    for (const path of ['word/_rels/document.xml.rels', '[Content_Types].xml', 'word/document.xml', 'word/settings.xml']) {
      templateDocx = await editTemplate(templateDocx, path, xml => xml.replace(/(<\?xml[^>]*>\s*<[^>]*>)([\s\S]*)$/, (_, head: string, rest: string) => head + requote(rest)));
    }
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['portrait titlePg ' + ALL_HEADERS]);
    expect((await textOf(await JSZip.loadAsync(docx), 'word/settings.xml'))!).toContain('<w:evenAndOddHeaders/>');
  });

  it('come from parts in UTF-16, which go as they came', async () => {
    let templateDocx = await headerTemplate();
    const asUtf16 = (xml: string) => utf16(xml.replace('encoding="UTF-8"', 'encoding="UTF-16"'));
    for (const path of ['word/_rels/header1.xml.rels', 'word/header1.xml', 'word/footer1.xml']) templateDocx = await editTemplate(templateDocx, path, asUtf16);
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['portrait titlePg ' + ALL_HEADERS]);
    const [template, zip] = await Promise.all([JSZip.loadAsync(templateDocx), JSZip.loadAsync(docx)]);
    expect(await zip.file('word/media/image1.png')!.async('uint8array')).toEqual(PNG);
    for (const path of ['word/_rels/header1.xml.rels', 'word/header1.xml', 'word/footer1.xml']) {
      expect(await zip.file(path)!.async('uint8array')).toEqual(await template.file(path)!.async('uint8array'));
    }
  });

  it('go as UTF-8 from a part in UTF-16 that export changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'template-sections-'));
    try {
      writeFileSync(join(dir, 'a.png'), PNG);
      const templateDocx = await editTemplate(await headerTemplate(), 'word/header1.xml', xml => utf16(xml.replace('encoding="UTF-8"', 'encoding="UTF-16"')));
      // The Markdown's image takes the header's drawing ID, which then changes
      const { docx } = await convertMdToDocx('![a](a.png)', { templateDocx, sourceDir: dir });
      expect(await packageProblems(docx)).toEqual([]);
      const header = await (await JSZip.loadAsync(docx)).file('word/header1.xml')!.async('string');
      expect(header).toStartWith('<?xml version="1.0" encoding="UTF-8"');
      expect(header).toContain('<wp:docPr id="2"');
      expect(header).toContain('RUNNING HEAD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keep a header\'s numbering where the template\'s numbering lacks export\'s bullets and numbers', async () => {
    // The template's numbering has no numId 2, which numbered lists take
    const templateDocx = await editTemplate(await headerTemplate({ headerList: 'direct' }), 'word/numbering.xml',
      xml => xml.replace(/<w:num w:numId="2"[^>]*>[\s\S]*?<\/w:num>\s*/, ''));
    for (const md of ['8. item', '- a\n\n1. b\n\n3. c']) {
      const { docx } = await convertMdToDocx(md, { templateDocx });
      expect(await packageProblems(docx)).toEqual([]);
      const numbering = (await textOf(await JSZip.loadAsync(docx), 'word/numbering.xml'))!;
      expect(/<w:num w:numId="3"[^>]*>[\s\S]*?<\/w:num>/.exec(numbering)?.[0]).toBe('<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num>');
      // Export's numbers, as an abstract numbering of their own
      const abstractNumId = /<w:num w:numId="2"[^>]*><w:abstractNumId w:val="(\d+)"\/>/.exec(numbering)?.[1];
      expect(abstractNumId).toBe('8');
      expect(numbering).toMatch(new RegExp('<w:abstractNum w:abstractNumId="8"[^>]*>[\\s\\S]*?<w:numFmt w:val="decimal"/>'));
    }
  });

  it('keep the numbering a header\'s list takes through its style', async () => {
    const { docx } = await convertMdToDocx('Hello', { templateDocx: await headerTemplate({ headerList: 'style' }) });
    // The style's numId has its numbering
    expect(await packageProblems(docx)).toEqual([]);
    const numbering = (await textOf(await JSZip.loadAsync(docx), 'word/numbering.xml'))!;
    expect(numbering).toContain('<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num>');
  });

  it('keep the image of a header list\'s picture bullet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'template-sections-'));
    try {
      writeFileSync(join(dir, 'a.png'), PNG);
      writeFileSync(join(dir, 'b.png'), PNG);
      const templateDocx = await headerTemplate({ headerList: 'direct', pictureBullet: true });
      // The Markdown's images take the template's images' names
      for (const md of ['Hello', '![a](a.png)\n\n![b](b.png)\n\n- c']) {
        const { docx } = await convertMdToDocx(md, { templateDocx, sourceDir: dir });
        expect(await packageProblems(docx)).toEqual([]);
        const zip = await JSZip.loadAsync(docx);
        const target = /Target="([^"]+)"/.exec((await textOf(zip, 'word/_rels/numbering.xml.rels'))!)![1];
        expect(await zip.file('word/' + target)!.async('uint8array')).toEqual(BULLET);
        expect((await textOf(zip, 'word/numbering.xml'))!).toContain('<w:numPicBullet w:numPicBulletId="0">');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Markdown without its frontmatter */
const body = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
/** An instance's abstract numbering's first level's format */
const firstLevelFormat = (numbering: string, numId: string) => {
  const abstractNumId = new RegExp('<w:num w:numId="' + numId + '"[^>]*><w:abstractNumId w:val="(\\d+)"/>').exec(numbering)?.[1];
  const abstractNum = new RegExp('<w:abstractNum w:abstractNumId="' + abstractNumId + '"[^>]*>([\\s\\S]*?)</w:abstractNum>').exec(numbering)?.[1];
  return /<w:lvl w:ilvl="0"[^>]*>[\s\S]*?<w:numFmt w:val="(\w+)"/.exec(abstractNum ?? '')?.[1];
};

describe('a template\'s numbering', () => {
  /** A template whose numbering's numIds 1 and 2 are formatted by `edit` */
  const listTemplate = async (edit: (numbering: string) => string) => editTemplate((await convertMdToDocx('- a\n\n1. b')).docx, 'word/numbering.xml', edit);
  const decimalAt1 = (numbering: string) => numbering.replace(/(<w:num w:numId="1"[^>]*>)<w:abstractNumId w:val="0"\/>/, '$1<w:abstractNumId w:val="1"/>');

  it.each([
    ['numbers at numId 1', decimalAt1, '- bullet\n\n1. one\n2. two'],
    ['numbers at numId 1 and no numId 2', (numbering: string) => decimalAt1(numbering).replace(/<w:num w:numId="2"[^>]*>[\s\S]*?<\/w:num>\s*/, ''), '- bullet\n\n8. item'],
    ['bullets at numId 2', (numbering: string) => numbering.replace(/(<w:num w:numId="2"[^>]*>)<w:abstractNumId w:val="1"\/>/, '$1<w:abstractNumId w:val="0"/>'), '1. one\n2. two\n\n- bullet'],
  ])('gives bullets and numbers their own where it has %s', async (_name, edit, md) => {
    const { docx } = await convertMdToDocx(md, { templateDocx: await listTemplate(edit) });
    expect(await packageProblems(docx)).toEqual([]);
    expect(body((await convertDocx(docx)).markdown)).toBe(md + '\n');
  });

  it('gives bullets their own numbering, not the header\'s numbers at numId 1, the same on the next export', async () => {
    let templateDocx = await editTemplate(await headerTemplate({ headerList: 'direct' }), 'word/numbering.xml',
      numbering => decimalAt1(numbering).replace(/<w:num w:numId="2"[^>]*>[\s\S]*?<\/w:num>\s*/, ''));
    templateDocx = await editTemplate(templateDocx, 'word/header3.xml', xml => xml.replace('<w:numId w:val="3"/>', '<w:numId w:val="1"/>'));
    const md = '- bullet\n\n8. item';
    const first = (await convertMdToDocx(md, { templateDocx })).docx;
    const second = (await convertMdToDocx(md, { templateDocx: first })).docx;
    for (const docx of [first, second]) {
      expect(await packageProblems(docx)).toEqual([]);
      expect(body((await convertDocx(docx)).markdown)).toBe(md + '\n');
      const zip = await JSZip.loadAsync(docx);
      const numbering = (await textOf(zip, 'word/numbering.xml'))!;
      // The header's list keeps the template's numbers
      expect((await textOf(zip, 'word/header3.xml'))!).toContain('<w:numId w:val="1"/>');
      expect(firstLevelFormat(numbering, '1')).toBe('decimal');
      const bullet = /<w:numId w:val="(\d+)"\/>/.exec((await textOf(zip, 'word/document.xml'))!)![1];
      expect(firstLevelFormat(numbering, bullet)).toBe('bullet');
    }
    const numbering = async (docx: Uint8Array) => (await textOf(await JSZip.loadAsync(docx), 'word/numbering.xml'))!.match(/<w:(abstractNum|num) /g);
    expect(await numbering(second)).toEqual(await numbering(first));
  });
});
