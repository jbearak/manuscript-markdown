import { describe, it, expect } from 'bun:test';
import JSZip from 'jszip';
import * as fc from 'fast-check';
import { XMLValidator } from 'fast-xml-parser';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { fastestRunAsync } from './test-timing';
import { documentCompatibilityProblems } from './markup-compatibility-check';
import { EXPORT_CONTEXT, EXPORT_NAMESPACES, MARKUP_COMPATIBILITY as MC_NAMESPACE, NO_COMPATIBILITY, buildOrdered, childrenOf as childNodesOf, compatibilityIn, contextIn, expandName, isElement, isNamed, isProcessedWrapper, nameOf, parseOrdered, resolvedNode, scopeIn, sectPrPropertyOf, type Compatibility, type Context, type Scope, type XmlNode } from './scoped-xml';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const WML = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
// What the templates' document element declares, as Word's does, markup
// compatibility's and w14's too, which the alternatives of their section
// properties use
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="' + REL.slice(0, -1) + '" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
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
 * another type, a part's relationship IDs out of sequence, a drawing ID
 * twice, XML that isn't well-formed
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
    // Markup compatibility's rules, which the section properties export
    // takes from the template, and moves, keep: every prefix bound, and
    // each namespace Word doesn't understand ignorable where it's used
    else if (path === 'word/document.xml') problems.push(...documentCompatibilityProblems(xml).map(problem => path + ': ' + problem));
    for (const [, numId] of xml.matchAll(/<w:numId w:val="(\d+)"/g)) if (!numIds.has(numId)) problems.push(path + ': numId ' + numId + ' has no numbering');
    const rels = new Map<string, string>();
    const relsXml = await textOf(zip, relsPathOf(path));
    for (const [tag] of relsXml?.matchAll(/<Relationship\b[^>]*>/g) ?? []) {
      rels.set(attr(tag, 'Id')!, attr(tag, 'Type')!.slice(attr(tag, 'Type')!.lastIndexOf('/') + 1));
      if (attr(tag, 'TargetMode') !== 'External' && !files.includes(resolveTarget(path, attr(tag, 'Target')!))) problems.push(relsPathOf(path) + ' targets no part: ' + attr(tag, 'Target'));
    }
    const ids = [...rels.keys()].map(id => /^rId\d+$/.test(id) ? parseInt(id.slice(3), 10) : NaN).sort((a, b) => a - b);
    if (ids.some((n, i) => n !== i + 1)) problems.push(path + ' relationship IDs ' + [...rels.keys()].join(','));
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

  it('go in the first section where it is a bibliography\'s own, before a section that starts the document', async () => {
    // Export writes the bibliography's section break after the sections
    // after it, once it knows the bibliography lists something
    const md = '---\ncsl: apa\n---\n<!-- references -->\n\n<!-- landscape -->\n\nWide [@key1].\n\n<!-- /landscape -->\n\nAfter\n';
    const bibtex = '@article{key1, author={Smith, John}, title={Title}, journal={J}, year={2020}}';
    const { docx } = await convertMdToDocx(md, { templateDocx: await headerTemplate(), bibtex });
    expect(await packageProblems(docx)).toEqual([]);
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

  it.each([
    ['the section\'s own', 'rId12'],
    ['others of their own', 'rId13'],
    ['none', 'rId99'],
  ])('give the printer settings a tracked change to the last section names, %s, the export\'s IDs', async (_name, oldId) => {
    // The change kept the template's ID, which named another of the
    // export's parts, or none
    const zip = await JSZip.loadAsync(await headerTemplate());
    const settings = new Uint8Array([7, 7, 7]), oldSettings = new Uint8Array([8, 8]);
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    zip.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rId12" Type="' + REL + 'printerSettings" Target="printerSettings/printerSettings1.bin"/>'
      + '<Relationship Id="rId13" Type="' + REL + 'printerSettings" Target="printerSettings/printerSettings2.bin"/></Relationships>'));
    zip.file('word/printerSettings/printerSettings1.bin', settings);
    zip.file('word/printerSettings/printerSettings2.bin', oldSettings);
    const types = await zip.file('[Content_Types].xml')!.async('string');
    zip.file('[Content_Types].xml', types.replace('<Default ', '<Default Extension="bin" ContentType="' + WML + 'printerSettings"/><Default '));
    const change = (id: string) => '<w:sectPrChange w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>'
      + (id ? '<w:printerSettings r:id="' + id + '"/>' : '') + '</w:sectPr></w:sectPrChange>';
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('<w:docGrid w:linePitch="360"/></w:sectPr>', '<w:docGrid w:linePitch="360"/><w:printerSettings r:id="rId12"/>' + change(oldId) + '</w:sectPr>'));
    let templateDocx = await zip.generateAsync({ type: 'uint8array' });
    for (let md of ['[a link](https://example.com)', LANDSCAPE_MD]) {
      // Through Word and back, and again with the export as the template,
      // which changes nothing
      const markdown: string[] = [];
      for (let trip = 0; trip < 2; trip++) {
        const { docx } = await convertMdToDocx(md, { templateDocx });
        expect(await packageProblems(docx)).toEqual([]);
        const out = await JSZip.loadAsync(docx);
        const documentXml = await out.file('word/document.xml')!.async('string');
        const outRels = [...(await out.file('word/_rels/document.xml.rels')!.async('string')).matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => tag);
        const partOf = async (id: string) => {
          const relationship = outRels.find(tag => attr(tag, 'Id') === id);
          expect(relationship && attr(relationship, 'Type')).toBe(REL + 'printerSettings');
          return out.file('word/' + attr(relationship!, 'Target'))!.async('uint8array');
        };
        const [own, old] = [...documentXml.matchAll(/<w:printerSettings r:id="(\w+)"\/>/g)].map(m => m[1]);
        expect(await partOf(own)).toEqual(settings);
        if (oldId === 'rId99') expect(documentXml).toContain(change('') + '</w:sectPr>');
        else expect(await partOf(old)).toEqual(oldId === 'rId12' ? settings : oldSettings);
        md = (await convertDocx(docx)).markdown;
        markdown.push(md);
        templateDocx = docx;
      }
      expect(markdown[1]).toBe(markdown[0]);
    }
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

  it('keep the last section\'s attribute values as XML reads them, white space as a space and a reference to a character as that character', async () => {
    // A reference, read as text, was written back with its & escaped, so
    // a tab, a line feed or a character written as one became the text of
    // the reference, and mc:ProcessContent's two names one
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      return xml.slice(0, last) + xml.slice(last)
        .replace('<w:sectPr ', () => '<w:sectPr xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:e="urn:example:e" mc:Ignorable="e" mc:ProcessContent="e:x&#9;e:y" e:lit="a\tb\r\nc" e:ref="a&#9;b&#xA;c&#xD;d&#x2019;e&amp;#9;" ')
        .replace(/<w:pgMar\b/, () => '<w:pgMar e:ref="p&#10;q"');
    });
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    const xml = (await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!;
    const last = xml.slice(xml.lastIndexOf('<w:sectPr'));
    expect(last).toContain(' mc:ProcessContent="e:x&#9;e:y" e:lit="a b c" e:ref="a&#9;b&#xA;c&#xD;d\u2019e&amp;#9;"');
    expect(last).toContain(' e:ref="p&#xA;q"');
    const md1 = (await convertDocx(docx)).markdown;
    const docx2 = (await convertMdToDocx(md1, { templateDocx })).docx;
    expect((await convertDocx(docx2)).markdown).toBe(md1);
    expect((await textOf(await JSZip.loadAsync(docx2), 'word/document.xml'))!.slice(-last.length)).toBe(last);
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

  it('number each part\'s relationships from rId1, and its references to them with them', async () => {
    // A header and the numbering whose relationships skip IDs, as a tool
    // other than Word writes them. The header names them by r:embed, by
    // another prefix for the relationships namespace, and by VML's o:relid.
    const namespace = REL.slice(0, -1);
    let templateDocx = await editTemplate(await headerTemplate({ headerList: 'direct', pictureBullet: true }), 'word/_rels/header1.xml.rels', xml => xml.replace('Id="rId1"', 'Id="rId4"')
      .replace('</Relationships>', '<Relationship Id="rId9" Type="' + REL + 'image" Target="media/image1.png"/><Relationship Id="rId7" Type="' + REL + 'hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>'));
    templateDocx = await editTemplate(templateDocx, 'word/header1.xml', xml => xml.replace('r:embed="rId1"', 'r:embed="rId4"').replace('<w:r><w:t>RUNNING HEAD</w:t></w:r>',
      '<w:hyperlink xmlns:rel="' + namespace + '" rel:id = \'rId7\'><w:r><w:t>RUNNING HEAD</w:t></w:r></w:hyperlink>' +
      // An ID as text and as a bookmark's name, which stay
      '<w:bookmarkStart w:id="0" w:name="rId7"/><w:r><w:t>r:id="rId9"</w:t></w:r><w:bookmarkEnd w:id="0"/>' +
      '<w:r><w:pict xmlns:v="urn:schemas-microsoft-com:vml" xmlns:office="urn:schemas-microsoft-com:office:office"><v:shape id="s" style="width:9pt;height:9pt"><v:imagedata office:relid="rId9"/></v:shape></w:pict></w:r>'));
    templateDocx = await editTemplate(templateDocx, 'word/_rels/numbering.xml.rels', xml => xml.replace('Id="rId1"', 'Id="rId3"'));
    templateDocx = await editTemplate(templateDocx, 'word/numbering.xml', xml => xml.replace('r:id="rId1"', 'r:id="rId3"'));
    const word1 = (await convertMdToDocx('Hello', { templateDocx })).docx;
    expect(await packageProblems(word1)).toEqual([]);
    const zip = await JSZip.loadAsync(word1);
    const rels = [...(await textOf(zip, 'word/_rels/header1.xml.rels'))!.matchAll(/<Relationship Id="(\w+)" Type="[^"]*\/(\w+)" Target="([^"]*)"/g)].map(m => m.slice(1).join(' '));
    expect(rels).toEqual(['rId1 image media/image1.png', 'rId2 hyperlink https://example.com/', 'rId3 image media/image1.png']);
    const header = (await textOf(zip, 'word/header1.xml'))!;
    for (const reference of ['r:embed="rId1"', 'rel:id = \'rId2\'', 'office:relid="rId3"', 'w:name="rId7"', '<w:t>r:id="rId9"</w:t>']) expect(header).toContain(reference);
    expect((await textOf(zip, 'word/_rels/numbering.xml.rels'))!).toContain('Id="rId1"');
    expect((await textOf(zip, 'word/numbering.xml'))!).toContain('<v:imagedata r:id="rId1"');
    // The next export changes them no more
    const word2 = await JSZip.loadAsync((await convertMdToDocx('Hello', { templateDocx: word1 })).docx);
    for (const path of ['word/header1.xml', 'word/_rels/header1.xml.rels', 'word/_rels/numbering.xml.rels']) {
      expect(await word2.file(path)!.async('string')).toBe(await zip.file(path)!.async('string'));
    }
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

/** Each section's pgNumType, which goes between its pgMar and its cols, or '' */
async function pageNumbering(docx: Uint8Array): Promise<string[]> {
  const xml = (await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!;
  return [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map(([sectPr]) => {
    const pgNumType = /<w:pgNumType\b[^>]*>/.exec(sectPr)?.[0] ?? '';
    return !pgNumType || /<w:pgMar\b[^>]*\/><w:pgNumType\b[^>]*\/><w:cols\b/.test(sectPr) ? pgNumType : 'out of place: ' + pgNumType;
  });
}

describe('a template\'s page numbering', () => {
  /** A template whose sections' page numbering is `pgNumType` */
  const numberedTemplate = async (pgNumType: string) =>
    editTemplate(await headerTemplate(), 'word/document.xml', xml => xml.replace('<w:cols ', pgNumType + '<w:cols '));

  it('counts on through the sections export adds, which take its format, from the start the first section takes', async () => {
    const format = 'w:fmt="lowerRoman" w:chapStyle="1" w:chapSep="emDash"';
    for (const [pgNumType, first, others] of [
      // The footer's PAGE field showed 1, 2 and 1, which the last section's restart gave
      ['<w:pgNumType w:start="1"/>', '<w:pgNumType w:start="1"/>', ''],
      ['<w:pgNumType ' + format.replace(' ', ' w:start="3" ') + '/>', '<w:pgNumType ' + format.replace(' ', ' w:start="3" ') + '/>', '<w:pgNumType ' + format + '/>'],
    ]) {
      const templateDocx = await numberedTemplate(pgNumType);
      const word1 = (await convertMdToDocx(LANDSCAPE_MD, { templateDocx })).docx;
      expect(await packageProblems(word1)).toEqual([]);
      expect(await pageNumbering(word1)).toEqual([first, others, others]);
      // A document of one section keeps the start in it
      expect(await pageNumbering((await convertMdToDocx('Hello', { templateDocx })).docx)).toEqual([first]);
      // And so does the next export, whose template has the start in its first section
      expect(await pageNumbering((await convertMdToDocx('Hello', { templateDocx: word1 })).docx)).toEqual([first]);
      const md1 = (await convertDocx(word1)).markdown;
      const word2 = (await convertMdToDocx(md1, { templateDocx: word1 })).docx;
      expect(await pageNumbering(word2)).toEqual(await pageNumbering(word1));
    }
  });

  it('starts where the template\'s last section does, if its first section doesn\'t say', async () => {
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml',
      xml => xml.replace(/(<w:cols [^>]*\/><w:docGrid [^>]*\/><\/w:sectPr><\/w:body>)/, '<w:pgNumType w:fmt="upperLetter" w:start="5"/>$1'));
    const { docx } = await convertMdToDocx(LANDSCAPE_MD, { templateDocx });
    expect(await pageNumbering(docx)).toEqual(['<w:pgNumType w:fmt="upperLetter" w:start="5"/>', '<w:pgNumType w:fmt="upperLetter"/>', '<w:pgNumType w:fmt="upperLetter"/>']);
  });
});

describe('a template\'s section properties that export adds to a section', () => {
  it('go among the section\'s own properties, not into markup compatibility\'s alternatives among them that hold only properties CT_SectPr puts after them', async () => {
    // The page numbering went into the choice that holds the columns, and
    // the title page into the one that holds the document grid, so a
    // consumer that read the fallback had neither
    const alternatives = (property: string) => '<mc:AlternateContent><mc:Choice Requires="w14">' + property + '</mc:Choice><mc:Fallback>' + property + '</mc:Fallback></mc:AlternateContent>';
    const columns = alternatives('<w:cols w:num="2" w:space="720"/>'), grid = alternatives('<w:docGrid w:linePitch="360"/>');
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml', xml => xml.replace('<w:cols w:space="720"/><w:titlePg/><w:docGrid w:linePitch="360"/>',
      () => '<w:pgNumType w:fmt="lowerRoman"/>' + columns + '<w:titlePg/>' + grid));
    for (const [md, sections] of [['Hello', ['portrait titlePg ' + ALL_HEADERS]], [LANDSCAPE_MD, ['portrait titlePg ' + ALL_HEADERS, 'landscape', 'portrait']]] as const) {
      const word1 = (await convertMdToDocx(md, { templateDocx })).docx;
      expect(await packageProblems(word1)).toEqual([]);
      expect(await sectionHeaders(word1)).toEqual(sections);
      const xml = (await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!;
      // The last section, the template's own, has them among its own
      // properties as Word reads them, with no alternatives, in CT_SectPr's
      // order, and the title page only where it's the first
      expect(xml).not.toContain('AlternateContent');
      const last = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].pop()![0];
      expect(last).toContain('<w:pgNumType w:fmt="lowerRoman"/><w:cols w:num="2" w:space="720"/>' + (md === 'Hello' ? '<w:titlePg/>' : '') + '<w:docGrid w:linePitch="360"/></w:sectPr>');
      const md1 = (await convertDocx(word1)).markdown;
      const word2 = (await convertMdToDocx(md1, { templateDocx })).docx;
      expect(await sectionHeaders(word2)).toEqual(sections);
      expect((await convertDocx(word2)).markdown).toBe(md1);
    }
  });

  const margins = '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>';
  /** Markup compatibility's alternatives, under `prefix`, of a choice and,
   *  where it's given, a fallback */
  const held = (choice: string, fallback?: string, prefix = 'mc') => '<' + prefix + ':AlternateContent><' + prefix + ':Choice Requires="w14">' + choice + '</' + prefix + ':Choice>'
    + (fallback === undefined ? '' : '<' + prefix + ':Fallback>' + fallback + '</' + prefix + ':Fallback>') + '</' + prefix + ':AlternateContent>';
  const columns = '<w:cols w:num="2" w:space="720"/>', aligned = '<w:vAlign w:val="center"/>', grid = '<w:docGrid w:linePitch="360"/>';
  // The last section as Word reads it, which it writes on save: the choice
  // Word reads, with the properties export gives it in their places
  const asRead = margins + '{pgNumType}' + columns + aligned + '<w:titlePg/>' + grid;
  it.each([
    ['hold properties it puts before them and after them', '', held(margins + columns, margins + columns) + held(aligned + grid, aligned + grid), asRead],
    ['hold such properties and have no fallback', '', margins + columns + held(aligned + grid), asRead],
    ['have another prefix for their namespace and hold only properties it puts after them', ' xmlns:compat="http://schemas.openxmlformats.org/markup-compatibility/2006"',
      margins + held(columns, columns, 'compat') + grid, margins + '{pgNumType}' + columns + '<w:titlePg/>' + grid],
  ])('go in CT_SectPr\'s order, among the last section\'s properties as Word reads them, where markup compatibility\'s alternatives among the template\'s %s', async (_, declarations, properties, expected) => {
    // The page numbering and title page went before the alternatives that
    // held columns or the document grid, and so before the margins or
    // vertical alignment in them, against CT_SectPr, and a consumer that
    // read no choice, where they had no fallback, had no title page; and
    // alternatives under another prefix were read as some other property,
    // so the page numbering went after the columns they held. The template's
    // first section gives the page number start and title page, which
    // export's first section takes, here its only one, its last
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      return xml.slice(0, last).replace(margins + '<w:cols w:space="720"/>', () => margins + '<w:pgNumType w:start="5"/><w:cols w:space="720"/>')
        + xml.slice(last).replace('<w:sectPr ', () => '<w:sectPr' + declarations + ' ').replace(margins + '<w:cols w:space="720"/>' + grid, () => properties);
    });
    const word1 = (await convertMdToDocx('Hello', { templateDocx })).docx;
    expect(await packageProblems(word1)).toEqual([]);
    const xml = (await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!;
    // Markup compatibility's elements under the template's prefix, or the
    // one export's document binds to their namespace
    const asMc = (sectPr: string) => sectPr.replace(/(<\/?)compat:/g, (_, start: string) => start + 'mc:');
    const last = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].pop()![0];
    expect(asMc(last)).toContain(asMc('<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>' + expected.split('{pgNumType}').join('<w:pgNumType w:start="5"/>') + '</w:sectPr>'));
    expect(last).not.toContain('AlternateContent');
    const md1 = (await convertDocx(word1)).markdown;
    expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
  });

  /** The names of a sectPr's properties as a consumer reads them that reads
   *  `branch` of markup compatibility's alternatives, and the content of
   *  the wrappers Word reads as their parent's; an element of another
   *  namespace than WordprocessingML's by its name */
  const propertiesAsRead = (sectPr: string, branch: 'Choice' | 'Fallback') => {
    const read = (nodes: XmlNode[], scope: Scope, compatibility: Compatibility): string[] => nodes.flatMap(node => {
      if (!isElement(node)) return [];
      const inner = scopeIn(node, scope), within = compatibilityIn(node, scope, compatibility);
      if (isNamed(node, scope, MC_NAMESPACE, 'AlternateContent')) {
        const chosen = childNodesOf(node).find(child => isNamed(child, inner, MC_NAMESPACE, branch));
        return chosen ? read(childNodesOf(chosen), scopeIn(chosen, inner), compatibilityIn(chosen, inner, within)) : [];
      }
      if (isProcessedWrapper(node, scope, compatibility)) return read(childNodesOf(node), inner, within);
      return [sectPrPropertyOf(node, scope) || nameOf(node)];
    });
    const parsed = parseOrdered(sectPr)!.find(isElement)!;
    return read(childNodesOf(parsed), scopeIn(parsed, EXPORT_NAMESPACES), compatibilityIn(parsed, EXPORT_NAMESPACES, NO_COMPATIBILITY));
  };
  /** The last sectPr of a document export writes from a template with its
   *  last section's properties after its page size given by `edit`, whose
   *  first section gives the page number start and title page, which
   *  export's first section takes, here its only one, its last */
  const lastSectPr = async (edit: (sectPr: string) => string) => {
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      return xml.slice(0, last).replace(margins + '<w:cols w:space="720"/>', () => margins + '<w:pgNumType w:start="5"/><w:cols w:space="720"/>') + edit(xml.slice(last));
    });
    const word1 = (await convertMdToDocx('Hello', { templateDocx })).docx;
    expect(await packageProblems(word1)).toEqual([]);
    const md1 = (await convertDocx(word1)).markdown;
    expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
    const xml = (await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!;
    return [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].pop()![0];
  };
  // The template's first section's references, in its order
  const references = ['headerReference', 'headerReference', 'footerReference', 'footerReference', 'headerReference', 'footerReference'];

  it('go into a choice or fallback that binds their prefix to another namespace as WordprocessingML\'s elements still', async () => {
    // The page numbering went into each of the alternatives unchanged, so
    // under a choice that bound w to another namespace and wrote the
    // margins and columns under another prefix, it was no longer
    // WordprocessingML's, and a consumer that read that choice had none
    const wml = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const rebound = margins.split('w:').join('localw:') + columns.split('w:').join('localw:');
    const last = await lastSectPr(sectPr => sectPr.replace(margins + '<w:cols w:space="720"/>' + grid, () =>
      '<mc:AlternateContent xmlns:mc="' + MC_NAMESPACE + '"><mc:Choice Requires="w14" xmlns:w="urn:example:other" xmlns:localw="' + wml + '">' + rebound + '</mc:Choice>'
      + '<mc:Fallback>' + margins + columns + '</mc:Fallback></mc:AlternateContent>' + aligned + grid));
    const expected = [...references, 'pgSz', 'pgMar', 'pgNumType', 'cols', 'vAlign', 'titlePg', 'docGrid'];
    expect(propertiesAsRead(last, 'Choice')).toEqual(expected);
    expect(propertiesAsRead(last, 'Fallback')).toEqual(expected);
  });

  it('go where each consumer reads them in their place, across alternatives whose choices need the same namespace', async () => {
    // The page numbering went into the first choice, after the margins, as
    // its fallback's columns, of another prefix, come after it; but the
    // second choice's page borders came after that, so Word read the page
    // numbering before them, against CT_SectPr
    const wml = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const borders = '<w:pgBorders><w:top w:val="single" w:sz="4" w:space="24" w:color="auto"/></w:pgBorders>';
    const alternatives = (choice: string, fallback: string) => '<mc:AlternateContent xmlns:mc="' + MC_NAMESPACE + '"><mc:Choice Requires="w14">' + choice + '</mc:Choice><mc:Fallback>' + fallback + '</mc:Fallback></mc:AlternateContent>';
    const last = await lastSectPr(sectPr => sectPr.replace(margins + '<w:cols w:space="720"/>' + grid, () =>
      alternatives(margins, '<localw:cols xmlns:localw="' + wml + '" localw:space="720"/>') + alternatives(borders + columns, grid)));
    // As Word reads them, the choices, whichever a consumer would have read
    expect(last).not.toContain('AlternateContent');
    expect(propertiesAsRead(last, 'Fallback')).toEqual([...references, 'pgSz', 'pgMar', 'pgBorders', 'pgNumType', 'cols', 'titlePg']);
  });

  it('go after the references and among the properties a wrapper holds whose content Word reads as its parent\'s, in their places there', async () => {
    // The properties in a wrapper that mc:ProcessContent named had no
    // place in CT_SectPr's order, so the references, page numbering and
    // title page went after it, and so after the page size, margins and
    // columns in it, against CT_SectPr
    const last = await lastSectPr(sectPr => {
      const start = sectPr.indexOf('<w:pgSz'), end = sectPr.indexOf('</w:sectPr>');
      return sectPr.slice(0, start).replace('<w:sectPr ', () => '<w:sectPr xmlns:mc="' + MC_NAMESPACE + '" xmlns:ext="urn:example:ext" mc:Ignorable="ext" mc:ProcessContent="ext:wrap" ')
        + '<ext:wrap>' + sectPr.slice(start, end) + '</ext:wrap>' + sectPr.slice(end);
    });
    // The wrapper's content, in its place, as Word reads it
    expect(last).not.toContain('<ext:wrap');
    expect(propertiesAsRead(last, 'Choice')).toEqual([...references, 'pgSz', 'pgMar', 'pgNumType', 'cols', 'titlePg', 'docGrid']);
  });
});

describe('a template\'s page numbering, title page and references held in markup compatibility\'s alternatives or a wrapper', () => {
  const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
  const references = 'header:even=EVEN HEADER header:default=LANDSCAPE HEADER footer:even=EVEN FOOTER footer:default=LANDSCAPE FOOTER header:first=FIRST HEADER footer:first=FIRST FOOTER';
  /** Each section's orientation, title page, headers and footers (see
   *  sectionHeaders) and page numbering, every pgNumType it has, as Word
   *  reads its properties: with markup compatibility's alternatives and
   *  wrappers in place of what it reads of them (see resolvedNode) */
  const sectionsAsRead = async (docx: Uint8Array) => {
    const read = await editTemplate(docx, 'word/document.xml', xml => xml.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, sectPr =>
      buildOrdered([resolvedNode(parseOrdered(sectPr)!.find(isElement)!, EXPORT_CONTEXT)])));
    const xml = (await textOf(await JSZip.loadAsync(read), 'word/document.xml'))!;
    const numbering = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map(([sectPr]) => [...sectPr.matchAll(/<w:pgNumType\b[^>]*>/g)].map(([tag]) => tag).join(' '));
    return { headers: await sectionHeaders(read), numbering };
  };
  it.each([
    ['markup compatibility\'s alternatives, in the choice Word reads and in the fallback', '',
      (xml: string) => '<mc:AlternateContent ' + MC + '><mc:Choice Requires="w14">' + xml + '</mc:Choice><mc:Fallback>' + xml + '</mc:Fallback></mc:AlternateContent>', '<mc:AlternateContent'],
    ['markup compatibility\'s alternatives, in the fallback Word reads, whose choice it doesn\'t', '',
      (xml: string) => '<mc:AlternateContent ' + MC + '><mc:Choice Requires="x" xmlns:x="urn:example:x"/><mc:Fallback>' + xml + '</mc:Fallback></mc:AlternateContent>', '<mc:AlternateContent'],
    ['a wrapper whose content Word reads as its parent\'s', ' ' + MC + ' xmlns:ext="urn:example:ext" mc:Ignorable="ext" mc:ProcessContent="ext:wrap"',
      (xml: string) => '<ext:wrap>' + xml + '</ext:wrap>', '<ext:wrap'],
  ])('go to every section as Word reads them, and to the last once, where the template holds them in %s', async (_, declarations, held, container) => {
    // They were read only as the sectPr's own children, so the sections
    // export added had neither the last section's page number format nor
    // its references, and the first no title page; and the last section
    // kept them where the template held them, beside those export gave it,
    // as a document of one section has the start and references the
    // template's first section gives: two of each
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      const first = xml.slice(0, last).replace('<w:titlePg/>', () => held('<w:titlePg/>')).replace('<w:cols ', () => '<w:pgNumType w:start="5"/><w:cols ');
      return (first + xml.slice(last).replace(/<w:headerReference w:type="default"[^>]*\/><w:footerReference w:type="default"[^>]*\/>/, own => held(own))
        .replace('<w:cols ', () => held('<w:pgNumType w:fmt="lowerRoman"/>') + '<w:cols ')).split('<w:sectPr ').join('<w:sectPr' + declarations + ' ');
    });
    for (const [md, headers, numbering] of [
      ['Hello', ['landscape titlePg ' + references], ['<w:pgNumType w:fmt="lowerRoman" w:start="5"/>']],
      [LANDSCAPE_MD, ['portrait titlePg ' + references, 'landscape', 'landscape'], ['<w:pgNumType w:fmt="lowerRoman" w:start="5"/>', '<w:pgNumType w:fmt="lowerRoman"/>', '<w:pgNumType w:fmt="lowerRoman"/>']],
    ] as Array<[string, string[], string[]]>) {
      const word1 = (await convertMdToDocx(md, { templateDocx })).docx;
      expect(await packageProblems(word1)).toEqual([]);
      expect(await sectionsAsRead(word1)).toEqual({ headers, numbering });
      // Nothing is left where the template held them
      const xml = (await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!;
      expect(xml).not.toContain(container);
      const md1 = (await convertDocx(word1)).markdown;
      const word2 = (await convertMdToDocx(md1, { templateDocx })).docx;
      expect((await convertDocx(word2)).markdown).toBe(md1);
      expect(await sectionsAsRead(word2)).toEqual({ headers, numbering });
    }
  });

  /** The prefixes of document.xml's names that nothing binds where they
   *  are, and its names in `namespace` that aren't ignorable where they are */
  const unread = async (docx: Uint8Array, namespace: string) => {
    const [document] = parseOrdered((await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!)!.filter(isElement);
    const problems: string[] = [];
    const walk = (node: XmlNode, context: Context) => {
      if (!isElement(node)) return;
      const inner = contextIn(node, context);
      const names = [{ qname: nameOf(node), attribute: false }, ...Object.keys(node[':@'] ?? {}).map(key => ({ qname: key.slice(2), attribute: true }))]
        .filter(({ qname }) => qname !== 'xmlns' && !qname.startsWith('xmlns:'));
      for (const { qname, attribute } of names) {
        const expanded = expandName(qname, inner.scope, attribute);
        if (qname.includes(':') && expanded.namespace === undefined) problems.push('unbound ' + qname);
        if (expanded.namespace === namespace && !inner.compatibility.ignorable.has(namespace)) problems.push('not ignorable ' + qname);
      }
      for (const child of childNodesOf(node)) walk(child, inner);
    };
    walk(document, { scope: new Map(), compatibility: NO_COMPATIBILITY });
    return problems;
  };

  it('take with them, into the sections export adds, the namespaces they use and the settings that make those ignorable', async () => {
    // The page numbering out of the template's alternatives kept its
    // extension's attribute, but not the declaration of its prefix, or that
    // it's ignorable, which the template's sectPr gave it, so the sections
    // export added used a prefix bound to nothing
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      const numbering = '<w:pgNumType w:fmt="lowerRoman" e:hint="foo"/>';
      return xml.slice(0, last) + xml.slice(last).replace('<w:sectPr ', () => '<w:sectPr ' + MC + ' xmlns:e="urn:example:ext" mc:Ignorable="e" ')
        .replace('<w:cols ', () => '<mc:AlternateContent><mc:Choice Requires="w14">' + numbering + '</mc:Choice><mc:Fallback>' + numbering + '</mc:Fallback></mc:AlternateContent><w:cols ');
    });
    const word1 = (await convertMdToDocx(LANDSCAPE_MD, { templateDocx })).docx;
    expect(await packageProblems(word1)).toEqual([]);
    expect(await unread(word1, 'urn:example:ext')).toEqual([]);
    const { numbering } = await sectionsAsRead(word1);
    expect(numbering.map(tag => /w:fmt="(\w+)"/.exec(tag)?.[1])).toEqual(['lowerRoman', 'lowerRoman', 'lowerRoman']);
    const md1 = (await convertDocx(word1)).markdown;
    expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
  });

  it.each([
    ['w', ''],
    ['q', ' xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'],
  ])('give the sections export adds margins with the namespaces they use and the settings that make those ignorable, where the template writes them %s:pgMar', async (prefix, declaration) => {
    // The breaks took the margins' attributes as they were written, an
    // extension's among them, without the declaration of its prefix, or
    // that it's ignorable, which the template's sectPr gave it, so they
    // used a prefix bound to nothing
    let margins = '';
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      return xml.slice(0, last) + xml.slice(last).replace('<w:sectPr ', () => '<w:sectPr ' + MC + declaration + ' xmlns:e="urn:example:ext" mc:Ignorable="e" ')
        .replace(/<w:pgMar\b([^>]*?)\/>/, (_, attributes: string) => {
          margins = attributes;
          return '<' + prefix + ':pgMar' + attributes.split(' w:').join(' ' + prefix + ':') + ' e:hint="1"/>';
        });
    });
    const word1 = (await convertMdToDocx(LANDSCAPE_MD, { templateDocx })).docx;
    expect(await packageProblems(word1)).toEqual([]);
    expect(await unread(word1, 'urn:example:ext')).toEqual([]);
    // Each section has the template's margins
    const xml = (await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!;
    const sectionMargins = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map(([sectPr]) => /<w:pgMar\b[^>]*>/.exec(sectPr)?.[0]);
    expect(sectionMargins).toHaveLength(3);
    for (const tag of sectionMargins) for (const attribute of margins.trim().split(/\s+/)) expect(tag).toContain(attribute);
    const md1 = (await convertDocx(word1)).markdown;
    expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
  });

  it('are read by their namespace, whatever prefix the template gives it', async () => {
    // Their readers knew them only as w:, so a template that wrote its
    // section's properties under another prefix gave no references, title
    // page or page numbering, and the trailing sectPr went without them
    const WML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml', xml => {
      const start = xml.lastIndexOf('<w:sectPr'), end = xml.lastIndexOf('</w:sectPr>') + '</w:sectPr>'.length;
      const sectPr = xml.slice(start, end).replace('<w:cols ', () => '<w:pgNumType w:fmt="upperRoman" w:start="3"/><w:cols ')
        .replace(/(<\/?|\s)w:/g, (_, before: string) => before + 'q:').replace('<q:sectPr ', () => '<q:sectPr xmlns:q="' + WML + '" ');
      return xml.slice(0, start) + sectPr + xml.slice(end);
    });
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionsAsRead(docx)).toEqual({ headers: ['portrait titlePg ' + ALL_HEADERS], numbering: ['<w:pgNumType w:fmt="upperRoman" w:start="3"/>'] });
  });

  it('go without a namespace the template names in mc:MustUnderstand that Word doesn\'t understand, which makes Word refuse the document', async () => {
    // The last section kept the template's mc:MustUnderstand, as its page
    // numbering did in each section export added, so Word, which doesn't
    // understand the namespace, would refuse to open the document, ignorable
    // as the namespace is. A namespace Word understands stays named
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      return xml.slice(0, last) + xml.slice(last).replace('<w:sectPr ', () => '<w:sectPr ' + MC + ' xmlns:x="urn:example:x" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="x w14" mc:MustUnderstand="x" ')
        .replace('<w:cols ', () => '<w:pgNumType w:fmt="lowerRoman" mc:MustUnderstand="x w14"/><w:cols ');
    });
    for (const md of ['Hello', LANDSCAPE_MD]) {
      const word1 = (await convertMdToDocx(md, { templateDocx })).docx;
      expect(await packageProblems(word1)).toEqual([]);
      const xml = (await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!;
      expect([...xml.matchAll(/MustUnderstand="([^"]*)"/g)].map(([, list]) => list)).toEqual(md === 'Hello' ? ['w14'] : ['w14', 'w14', 'w14']);
      const { numbering } = await sectionsAsRead(word1);
      expect(numbering.every(tag => tag.includes('w:fmt="lowerRoman"'))).toBe(true);
      const md1 = (await convertDocx(word1)).markdown;
      expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
    }
  });

  it.each([
    ['a choice', (pgMar: string) => '<mc:AlternateContent><mc:Choice Requires="w14" mc:PreserveAttributes="e:hint">' + pgMar.replace('/>', () => ' e:hint="1"/>') + '</mc:Choice><mc:Fallback>' + pgMar + '</mc:Fallback></mc:AlternateContent>'],
    ['a wrapper whose content Word reads', (pgMar: string) => '<x:wrap mc:PreserveAttributes="e:hint">' + pgMar.replace('/>', () => ' e:hint="1"/>') + '</x:wrap>'],
  ])('keep, written as Word reads them, out of %s, the attributes the template preserves there', async (_, held) => {
    // The choice or wrapper went, with its mc:PreserveAttributes, but the
    // attribute it preserved stayed, so an editor that keeps only what
    // markup compatibility tells it to could drop it on save
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      return xml.slice(0, last) + xml.slice(last).replace('<w:sectPr ', () => '<w:sectPr ' + MC + ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:e="urn:example:e" xmlns:x="urn:example:x" mc:Ignorable="e x" mc:ProcessContent="x:wrap" ')
        .replace(/<w:pgMar\b[^>]*\/>/, held);
    });
    const word1 = (await convertMdToDocx('Hello', { templateDocx })).docx;
    expect(await packageProblems(word1)).toEqual([]);
    const xml = (await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!;
    const last = xml.slice(xml.lastIndexOf('<w:sectPr'));
    expect(last.match(/<w:pgMar\b[^>]*\/>/g)).toEqual([expect.stringMatching(/ e:hint="1" mc:PreserveAttributes="e:hint"\/>$/)]);
    expect(last).not.toMatch(/AlternateContent|<x:wrap/);
    const md1 = (await convertDocx(word1)).markdown;
    expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
  });

  it.each([
    ['DrawingML\'s, which export\'s document doesn\'t bind', 'a', ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'],
    ['w16du\'s, a later Word\'s, which export\'s document doesn\'t bind', 'w16du', ' xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du"'],
    ['xml\'s, which no document declares', 'xml', ''],
  ])('leave the last section the page of the choice Word reads, which needs %s', async (_, requires, declaration) => {
    // Word was taken to understand only what export's document element
    // binds, and xml to be bound to nothing, so the last section, written
    // as Word reads it, had the fallback's Letter page where Word reads the
    // choice's A4 one
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      return xml.slice(0, last) + xml.slice(last).replace(/<w:pgSz\b[^>]*\/>/, () => '<mc:AlternateContent ' + MC + '><mc:Choice Requires="' + requires + '"' + declaration + '><w:pgSz w:w="11906" w:h="16838"/></mc:Choice>'
        + '<mc:Fallback><w:pgSz w:w="12240" w:h="15840"/></mc:Fallback></mc:AlternateContent>');
    });
    const word1 = (await convertMdToDocx('Hello', { templateDocx })).docx;
    expect(await packageProblems(word1)).toEqual([]);
    const xml = (await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!;
    const last = xml.slice(xml.lastIndexOf('<w:sectPr'));
    expect(last.match(/<w:pgSz\b[^>]*\/>/g)).toEqual(['<w:pgSz w:w="11906" w:h="16838"/>']);
    expect(last).not.toContain('AlternateContent');
    const md1 = (await convertDocx(word1)).markdown;
    expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
  });

  it.each([
    ['a prefix that nothing binds, of an element', '', '', '<x:ext/>'],
    ['a prefix that nothing binds, of an attribute', '', ' x:a="1"', ''],
    ['two attributes of one expanded name', ' xmlns:v="http://schemas.openxmlformats.org/wordprocessingml/2006/main"', ' v:start="4"', ''],
    ['a prefix undeclared', ' xmlns:p=""', '', ''],
    ['xmlns\'s namespace bound to a prefix', ' xmlns:p="http://www.w3.org/2000/xmlns/"', '', ''],
    ['Strict\'s and Transitional\'s attribute of one local name, which Word reads as one', ' xmlns:s="http://purl.oclc.org/ooxml/wordprocessingml/main"', ' s:start="4"', ''],
  ])('are read from none of a sectPr that breaks Namespaces in XML where it is, which Word refuses, with %s, so export writes none of that', async (_, declarations, attributes, element) => {
    // Export read the sectPr as it was, and wrote a name nothing bound into
    // its document, or one of the two attributes
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml', xml => {
      const start = xml.lastIndexOf('<w:sectPr');
      return xml.slice(0, start) + xml.slice(start).replace('<w:sectPr ', () => '<w:sectPr' + declarations + ' ')
        .replace('<w:cols ', () => '<w:pgNumType w:fmt="upperRoman" w:start="3"' + attributes + '/>' + element + '<w:cols ');
    });
    const word1 = (await convertMdToDocx('Hello', { templateDocx })).docx;
    expect(await packageProblems(word1)).toEqual([]);
    expect(await sectionsAsRead(word1)).toEqual({ headers: ['portrait'], numbering: [''] });
    const md1 = (await convertDocx(word1)).markdown;
    expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
  });

  it('go where Word reads them in their place, where the template\'s alternatives keep other properties after taking them out', async () => {
    // The page numbering went before the first columns, in a choice Word
    // doesn't read, not into the fallback it reads, which had held the
    // template's, so Word read none
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => {
      const last = xml.lastIndexOf('<w:sectPr');
      return xml.slice(0, last).replace('<w:cols ', () => '<w:pgNumType w:start="5"/><w:cols ') + xml.slice(last).replace(/<w:cols [^>]*\/>/, () =>
        '<mc:AlternateContent ' + MC + '><mc:Choice Requires="x" xmlns:x="urn:example:x"><w:cols w:num="3" w:space="720"/></mc:Choice>'
        + '<mc:Fallback><w:pgNumType w:fmt="lowerRoman"/><w:cols w:num="2" w:space="720"/></mc:Fallback></mc:AlternateContent>');
    });
    const word1 = (await convertMdToDocx('Hello', { templateDocx })).docx;
    expect(await packageProblems(word1)).toEqual([]);
    const { numbering } = await sectionsAsRead(word1);
    expect(numbering).toEqual(['<w:pgNumType w:fmt="lowerRoman" w:start="5"/>']);
    const xml = (await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!;
    const last = buildOrdered([resolvedNode(parseOrdered([...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].pop()![0])!.find(isElement)!, EXPORT_CONTEXT)]);
    expect(last).toContain('<w:pgNumType w:fmt="lowerRoman" w:start="5"/><w:cols w:num="2" w:space="720"/>');
  });

  it('are read and written as the last section\'s own page and break, not as those an extension Word ignores holds', async () => {
    // Its page and break were read and written as the first that XML of
    // export's prefixes held, which was the extension's, so the sections
    // export added had its A4 page turned, a last section's page turned
    // to a fence's was the extension's, and that section's break stayed
    // the template's where it was to start a new page
    const WML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const declarations = ' xmlns:x="urn:example:x" xmlns:q="' + WML + '" mc:Ignorable="x"';
    const plain = await editTemplate(await headerTemplate(), 'word/document.xml', xml => xml
      .replace('<w:sectPr ', () => '<w:sectPr' + declarations + ' ').replace('<w:pgSz ', () => '<w:type w:val="continuous"/><w:pgSz '));
    const templateDocx = await editTemplate(plain, 'word/document.xml', xml => xml.replace('<w:type ', () =>
      '<x:ext><q:type q:val="evenPage"/><q:pgSz q:w="16838" q:h="11906" q:orient="landscape"/></x:ext><w:type '));
    /** Each section's own break and page, as its sectPr's children */
    const sections = async (docx: Uint8Array) => {
      const xml = (await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!;
      return [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map(([sectPr]) => {
        const [node] = parseOrdered(sectPr, EXPORT_NAMESPACES)!.filter(isElement), scope = scopeIn(node, EXPORT_NAMESPACES);
        const child = (property: string) => childNodesOf(node).find(child => sectPrPropertyOf(child, scope) === property)?.[':@'] ?? {};
        return [child('type')['@_w:val'], ...['w', 'h', 'orient'].map(name => child('pgSz')['@_w:' + name])].join(' ');
      });
    };
    for (const [md, expected] of [
      [LANDSCAPE_MD, ['nextPage 12240 15840 ', 'nextPage 15840 12240 landscape', 'continuous 12240 15840 ']],
      ['Intro\n\n<!-- landscape -->\n\nWide\n\n<!-- /landscape -->', ['nextPage 12240 15840 ', 'nextPage 15840 12240 landscape']],
    ] as Array<[string, string[]]>) {
      const word1 = (await convertMdToDocx(md, { templateDocx })).docx;
      expect(await packageProblems(word1)).toEqual([]);
      expect(await sections(word1)).toEqual(expected);
      expect(await sections((await convertMdToDocx(md, { templateDocx: plain })).docx)).toEqual(expected);
      // The extension stays as it was
      expect((await textOf(await JSZip.loadAsync(word1), 'word/document.xml'))!).toContain('<x:ext><w:type w:val="evenPage"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></x:ext>');
      const md1 = (await convertDocx(word1)).markdown;
      expect(body(md1)).toBe(body((await convertDocx((await convertMdToDocx(md, { templateDocx: plain })).docx)).markdown));
      const word2 = (await convertMdToDocx(md1, { templateDocx })).docx;
      expect((await convertDocx(word2)).markdown).toBe(md1);
      expect(await sections(word2)).toEqual(expected);
    }
  });

  it.each([
    ['a choice Word doesn\'t read, before the fallback it reads', (real: string, decoy: string) =>
      '<mc:AlternateContent><mc:Choice Requires="x" xmlns:x="urn:example:x">' + decoy + '</mc:Choice><mc:Fallback>' + real + '</mc:Fallback></mc:AlternateContent>'],
    ['the fallback of a choice Word reads', (real: string, decoy: string) =>
      '<mc:AlternateContent><mc:Choice Requires="w14">' + real + '</mc:Choice><mc:Fallback>' + decoy + '</mc:Fallback></mc:AlternateContent>'],
    ['a choice after the one Word reads', (real: string, decoy: string) =>
      '<mc:AlternateContent><mc:Choice Requires="w14">' + real + '</mc:Choice><mc:Choice Requires="w14">' + decoy + '</mc:Choice></mc:AlternateContent>'],
    ['a choice Word doesn\'t read, in a paragraph\'s properties', (real: string, decoy: string) =>
      decoy.replace(/<q:sectPr\b[\s\S]*<\/q:sectPr>/, sectPr => '<mc:AlternateContent><mc:Choice Requires="e">' + sectPr + '</mc:Choice><mc:Fallback/></mc:AlternateContent>') + real],
    ['an extension Word ignores', (real: string, decoy: string) => '<e:ext>' + decoy + '</e:ext>' + real],
    ['an extension Word ignores, in a paragraph\'s properties', (real: string, decoy: string) =>
      decoy.replace(/<q:sectPr\b[\s\S]*<\/q:sectPr>/, sectPr => '<e:ext>' + sectPr + '</e:ext>') + real],
    ['an extension Word ignores, with the real one in a wrapper whose content Word reads', (real: string, decoy: string) =>
      '<e:ext><e:wrap>' + decoy + '</e:wrap></e:ext><e:wrap>' + real + '</e:wrap>'],
    ['an extension Word ignores, after an instruction in it that holds what looks like an end tag', (real: string, decoy: string) =>
      '<e:ext><?metadata <data>A</data> ?>' + decoy + '</e:ext>' + real],
  ])('come from no section Word doesn\'t read, as one in %s', async (_, held) => {
    // Every sectPr in the body was a section's, so the first section's page
    // numbering and title page came from one Word doesn't read, and a
    // reference from it took the place of the real one
    const plain = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => xml
      .replace('<w:document ', () => '<w:document xmlns:e="urn:example:e" mc:Ignorable="e" mc:ProcessContent="e:wrap" ')
      .replace('<w:titlePg/>', () => '<w:pgNumType w:start="5"/><w:titlePg/>'));
    const xml = (await textOf(await JSZip.loadAsync(plain), 'word/document.xml'))!;
    const real = /<w:p><w:pPr><w:sectPr\b[\s\S]*?<\/w:sectPr><\/w:pPr><\/w:p>/.exec(xml)![0];
    const header = /<w:headerReference w:type="default" r:id="(\w+)"/.exec(real)![1];
    const decoy = '<w:p><w:pPr><q:sectPr xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><q:headerReference q:type="first" r:id="' + header + '"/>'
      + '<q:pgSz q:w="15840" q:h="12240" q:orient="landscape"/><q:pgNumType q:start="99"/></q:sectPr></w:pPr></w:p>';
    const templateDocx = await editTemplate(plain, 'word/document.xml', xml => xml.replace(real, () => held(real, decoy)));
    for (const md of ['Hello', LANDSCAPE_MD]) {
      const expected = (await convertMdToDocx(md, { templateDocx: plain })).docx;
      const { headers, numbering } = await sectionsAsRead(expected);
      expect(headers[0]).toContain('titlePg');
      expect(numbering[0]).toContain('w:start="5"');
      const word1 = (await convertMdToDocx(md, { templateDocx })).docx;
      expect(await packageProblems(word1)).toEqual([]);
      // The document, but for its revision IDs, each export's own
      const documentOf = async (docx: Uint8Array) => (await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!.replace(/ w:rsid\w*="[0-9A-F]{8}"/g, '');
      expect(await documentOf(word1)).toBe(await documentOf(expected));
      const md1 = (await convertDocx(word1)).markdown;
      const word2 = (await convertMdToDocx(md1, { templateDocx })).docx;
      expect((await convertDocx(word2)).markdown).toBe(md1);
      expect(await sectionsAsRead(word2)).toEqual({ headers, numbering });
    }
  });

  it('are read and written only from what Word reads, whatever sections and properties alternatives and extensions hold where Word doesn\'t read them', async () => {
    // The template's own sections: a paragraph's, which can be in a wrapper
    // or a branch Word reads, and the body's, which breaks on the same page
    const WML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const plain = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => xml
      .replace('<w:document ', () => '<w:document xmlns:e="urn:example:e" xmlns:q="' + WML + '" mc:Ignorable="e" mc:ProcessContent="e:wrap" ')
      .replace('<w:titlePg/>', () => '<w:pgNumType w:start="5"/><w:titlePg/>')
      .replace(/(<w:sectPr\b[^>]*>(?:<w:(?:header|footer)Reference [^>]*\/>)*)(<w:pgSz w:w="15840")/, (_, before: string, page: string) => before + '<w:type w:val="continuous"/>' + page));
    const xml = (await textOf(await JSZip.loadAsync(plain), 'word/document.xml'))!;
    const real = /<w:p><w:pPr><w:sectPr\b[\s\S]*?<\/w:sectPr><\/w:pPr><\/w:p>/.exec(xml)![0];
    const ids = [...new Set([...xml.matchAll(/ r:id="(\w+)"/g)].map(([, id]) => id))];
    // Where Word doesn't read what's held: a choice it doesn't read, a
    // fallback or choice after one it does, and an extension it ignores,
    // in a wrapper whose content it reads too
    const unread = fc.constantFrom(
      (inner: string) => '<mc:AlternateContent><mc:Choice Requires="e">' + inner + '</mc:Choice><mc:Fallback/></mc:AlternateContent>',
      (inner: string) => '<mc:AlternateContent><mc:Choice Requires="w14"/><mc:Fallback>' + inner + '</mc:Fallback></mc:AlternateContent>',
      (inner: string) => '<mc:AlternateContent><mc:Choice Requires="w14"/><mc:Choice Requires="w14">' + inner + '</mc:Choice></mc:AlternateContent>',
      (inner: string) => '<e:ext>' + inner + '</e:ext>',
      (inner: string) => '<e:wrap><e:ext>' + inner + '</e:ext></e:wrap>');
    // And where it reads it, as the template's own
    const readAs = fc.constantFrom(
      (inner: string) => inner,
      (inner: string) => '<e:wrap>' + inner + '</e:wrap>',
      (inner: string) => '<mc:AlternateContent><mc:Choice Requires="e"/><mc:Fallback>' + inner + '</mc:Fallback></mc:AlternateContent>',
      (inner: string) => '<mc:AlternateContent><mc:Choice Requires="w14">' + inner + '</mc:Choice><mc:Fallback/></mc:AlternateContent>');
    // Section properties of their own, under w: or another prefix of
    // WordprocessingML's
    const property = fc.tuple(fc.constantFrom('w', 'q'), fc.constantFrom(
      (p: string) => '<' + p + ':headerReference ' + p + ':type="first" r:id="{id}"/>',
      (p: string) => '<' + p + ':footerReference ' + p + ':type="default" r:id="{id}"/>',
      (p: string) => '<' + p + ':type ' + p + ':val="evenPage"/>',
      (p: string) => '<' + p + ':pgSz ' + p + ':w="16838" ' + p + ':h="11906" ' + p + ':orient="landscape"/>',
      (p: string) => '<' + p + ':pgNumType ' + p + ':fmt="upperLetter" ' + p + ':start="99"/>',
      (p: string) => '<' + p + ':titlePg ' + p + ':val="0"/>',
      (p: string) => '<' + p + ':cols ' + p + ':num="3"/>'), fc.constantFrom(...ids))
      .map(([p, of, id]) => of(p).replace('{id}', id));
    const properties = fc.array(property, { minLength: 1, maxLength: 3 }).map(list => list.join(''));
    // A section's properties Word doesn't read, as a paragraph's, or only
    // its sectPr held so
    const unreadSection = fc.tuple(unread, fc.boolean(), fc.constantFrom('w', 'q'), properties).map(([held, whole, p, inner]) => {
      const sectPr = '<' + p + ':sectPr>' + inner + '</' + p + ':sectPr>';
      return whole ? held('<w:p><w:pPr>' + sectPr + '</w:pPr></w:p>') : '<w:p><w:pPr>' + held(sectPr) + '</w:pPr></w:p>';
    });
    const template = fc.record({
      before: fc.array(unreadSection, { maxLength: 2 }),
      own: readAs,
      after: fc.array(unreadSection, { maxLength: 2 }),
      // Properties Word doesn't read among the last section's, each before
      // one of them
      last: fc.array(fc.tuple(fc.nat(), unread, properties), { maxLength: 3 }),
      md: fc.constantFrom('Hello', LANDSCAPE_MD, 'Intro\n\n<!-- landscape -->\n\nWide\n\n<!-- /landscape -->'),
    });
    /** Each section's own properties as Word reads them, its sectPr's
     *  children of WordprocessingML's, as written */
    const sections = async (docx: Uint8Array) => {
      const document = (await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!;
      return [...document.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map(([sectPr]) => {
        const [node] = parseOrdered(sectPr, EXPORT_NAMESPACES)!.filter(isElement), scope = scopeIn(node, EXPORT_NAMESPACES);
        return childNodesOf(resolvedNode(node, EXPORT_CONTEXT)).filter(child => sectPrPropertyOf(child, scope) !== '').map(child => buildOrdered([child]));
      });
    };
    const expected = new Map<string, string[][]>();
    await fc.assert(fc.asyncProperty(template, async ({ before, own, after, last, md }) => {
      if (!expected.has(md)) expected.set(md, await sections((await convertMdToDocx(md, { templateDocx: plain })).docx));
      const templateDocx = await editTemplate(plain, 'word/document.xml', document => {
        const start = document.lastIndexOf('<w:sectPr'), open = document.indexOf('>', start) + 1;
        const children = [...document.slice(open, document.indexOf('</w:sectPr>', open)).matchAll(/<w:[^>]*\/>/g)].map(([child]) => child);
        for (const [at, held, inner] of last) children.splice(at % (children.length + 1), 0, held(inner));
        return document.slice(0, open).replace(real, () => before.join('') + own(real) + after.join('')) + children.join('') + document.slice(document.indexOf('</w:sectPr>', open));
      });
      expect(await sections((await convertMdToDocx(md, { templateDocx })).docx)).toEqual(expected.get(md)!);
    }), { numRuns: 40 });
  }, 60000);
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

  /** A template whose numbering has `count` instances, numIds 1 up, each of
   *  an abstract numbering that links (w:numStyleLink) to a numbering style
   *  whose w:numPr gives the instance `linked(k)`, and the definitions
   *  `definitions`, the styles' IDs from `prefix` */
  const linkedTemplate = async (count: number, linked: (k: number) => number, definitions = '', prefix = 'L') => {
    const nums = (numbering: string) => numbering.replace(/<w:abstractNum\b[\s\S]*<\/w:num>/, () => definitions
      + Array.from({ length: count }, (_, k) => '<w:abstractNum w:abstractNumId="' + (100 + k) + '"><w:numStyleLink w:val="' + prefix + k + '"/></w:abstractNum>').join('')
      + Array.from({ length: count }, (_, k) => '<w:num w:numId="' + (k + 1) + '"><w:abstractNumId w:val="' + (100 + k) + '"/></w:num>').join(''));
    const styles = (xml: string) => xml.replace('</w:styles>', () => Array.from({ length: count }, (_, k) => '<w:style w:type="numbering" w:styleId="' + prefix + k + '"><w:name w:val="l' + k + '"/>'
      + '<w:pPr><w:numPr><w:numId w:val="' + linked(k) + '"/></w:numPr></w:pPr></w:style>').join('') + '</w:styles>');
    return editTemplate(await listTemplate(nums), 'word/styles.xml', styles);
  };

  it.each([
    // numId 1 links to a style whose instance, numId 2, is of the bullets, so
    // its lists take numId 1 as the template has it
    ['an instance whose abstract numbering links to a style of bullets', (k: number) => k === 0 ? 2 : k + 1, '<w:num w:numId="1"><w:abstractNumId w:val="100"/>', '<w:numId w:val="1"/>', 'L'],
    // Read as an XML parser reads it, in either quotes
    ['an instance whose abstract numbering links to a style of bullets whose ID holds an apostrophe', (k: number) => k === 0 ? 2 : k + 1, '<w:num w:numId="1"><w:abstractNumId w:val="100"/>', '<w:numId w:val="1"/>', 'O\'Reilly'],
    // Each style's instance its own, which has no format
    ['instances whose abstract numberings link back to them', (k: number) => k + 1, undefined, undefined, 'L'],
  ])('gives bullets the template\'s where it has %s', async (_name, linked, keep, bulletNumId, prefix) => {
    // numId 2's abstract numbering has bullets; the rest link to styles
    const bullets = '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/></w:lvl></w:abstractNum>';
    let templateDocx = await linkedTemplate(3, linked, bullets, prefix);
    templateDocx = await editTemplate(templateDocx, 'word/numbering.xml', numbering => numbering.replace('<w:num w:numId="2"><w:abstractNumId w:val="101"/>', '<w:num w:numId="2"><w:abstractNumId w:val="7"/>'));
    const md = '- a\n- b';
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(body((await convertDocx(docx)).markdown)).toBe(md + '\n');
    const document = (await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!;
    if (bulletNumId) expect(document).toContain(bulletNumId);
    else expect(document).not.toContain('<w:numId w:val="1"/>');
    if (keep) expect((await textOf(await JSZip.loadAsync(docx), 'word/numbering.xml'))!).toContain(keep);
  });

  // A style's numId is read as an XML parser reads it, a character reference
  // in it too, and as import reads it, by its value, so the instance it
  // gives stays the template's
  it.each([
    ['a character reference', '&#50;'],
    ['a plus sign and a leading zero', '+02'],
    ['whitespace around it', ' 2 '],
  ])('gives bullets the template\'s where a numbering style links to them by a numId written with %s', async (_name, numId) => {
    const bullets = '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/></w:lvl></w:abstractNum>';
    // Only L0's numId is 2, which nothing else uses
    let templateDocx = await linkedTemplate(3, k => k === 0 ? 2 : 3, bullets);
    templateDocx = await editTemplate(templateDocx, 'word/numbering.xml', numbering => numbering.replace('<w:num w:numId="2"><w:abstractNumId w:val="101"/>', '<w:num w:numId="2"><w:abstractNumId w:val="7"/>'));
    templateDocx = await editTemplate(templateDocx, 'word/styles.xml', styles => styles.replace(/(<w:style w:type="numbering" w:styleId="L0">[\s\S]*?<w:numId w:val=")2"/, (_match, before: string) => before + numId + '"'));
    expect(await textOf(await JSZip.loadAsync(templateDocx), 'word/styles.xml')).toContain('<w:numId w:val="' + numId + '"/>');
    const md = '- a\n- b';
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(body((await convertDocx(docx)).markdown)).toBe(md + '\n');
    const zip = await JSZip.loadAsync(docx);
    expect((await textOf(zip, 'word/document.xml'))!).toContain('<w:numId w:val="1"/>');
    expect((await textOf(zip, 'word/numbering.xml'))!).toContain('<w:num w:numId="2"><w:abstractNumId w:val="7"/>');
  });

  // Each instance found by a search of all of them, and each style a link
  // names by a search of all the styles
  it('gives lists their own numbering beside a template\'s many that link to numbering styles in linear time', async () => {
    const time = async (count: number) => {
      const templateDocx = await linkedTemplate(count, k => k + 1);
      return fastestRunAsync(async () => expect((await convertMdToDocx('- a\n\n1. b', { templateDocx })).docx.length).toBeGreaterThan(0));
    };
    await time(500);
    const small = await time(2000);
    expect(await time(8000) / small).toBeLessThan(8);
  }, 30000);
});

describe('a template header\'s DOCPROPERTY fields', () => {
  it('keep the custom properties they show, after export\'s own', async () => {
    let templateDocx = await headerTemplate();
    // A complex field whose code is in pieces, and a simple field
    templateDocx = await editTemplate(templateDocx, 'word/header2.xml', xml => xml.replace('<w:r><w:t>FIRST HEADER</w:t></w:r>',
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DOCPROPERTY </w:instrText></w:r>' +
      '<w:r><w:instrText>ClientName</w:instrText></w:r><w:r><w:instrText xml:space="preserve"> \\* MERGEFORMAT </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Acme</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'));
    templateDocx = await editTemplate(templateDocx, 'word/footer2.xml', xml => xml.replace('<w:r><w:t>FIRST FOOTER</w:t></w:r>',
      '<w:fldSimple w:instr=" DOCPROPERTY &quot;Project Code&quot; "><w:r><w:t>42</w:t></w:r></w:fldSimple>'));
    const property = (pid: number, name: string, value: string) => '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="' + pid + '" name="' + name + '">' + value + '</property>';
    templateDocx = await editTemplate(templateDocx, 'docProps/custom.xml', () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      property(2, 'ClientName', '<vt:lpwstr>Acme &amp; Sons "Ltd" &#x2019;</vt:lpwstr>') + property(3, 'Project Code', '<vt:i4>42</vt:i4>') +
      property(4, 'Unshown', '<vt:lpwstr>x</vt:lpwstr>') + '</Properties>');
    templateDocx = await editTemplate(templateDocx, '_rels/.rels', xml => xml.replace('</Relationships>',
      '<Relationship Id="rId9" Type="' + REL + 'custom-properties" Target="docProps/custom.xml"/></Relationships>'));
    templateDocx = await editTemplate(templateDocx, '[Content_Types].xml', xml => xml.replace('</Types>',
      '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'));
    expect(await packageProblems(templateDocx)).toEqual([]);

    const { docx } = await convertMdToDocx('---\ncsl: apa\n---\n\nHello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    const custom = (await textOf(await JSZip.loadAsync(docx), 'docProps/custom.xml'))!;
    const properties = [...custom.matchAll(/<property [^>]*pid="(\d+)" name="([^"]*)">(.*?)<\/property>/g)];
    expect(properties.map(m => m[1])).toEqual(properties.map((_, i) => String(i + 2)));
    expect(properties.slice(-2).map(m => m[2] + '=' + m[3])).toEqual(['ClientName=<vt:lpwstr>Acme &amp; Sons "Ltd" \u2019</vt:lpwstr>', 'Project Code=<vt:i4>42</vt:i4>']);
    expect(properties.slice(0, -2).every(m => /^(MANUSCRIPT|ZOTERO)_/.test(m[2]))).toBe(true);
    expect(properties.length).toBeGreaterThan(2);
    expect(custom).not.toContain('Unshown');
  });
});
