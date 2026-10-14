import { describe, it, expect } from 'bun:test';
import JSZip from 'jszip';
import * as fc from 'fast-check';
import { XMLValidator } from 'fast-xml-parser';
import fc from 'fast-check';
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

const MARKUP_COMPATIBILITY = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
/**
 * What a namespace-aware reader finds wrong with a part's names: a prefix
 * no declaration in scope binds, on an element, an attribute, or in one of
 * markup compatibility's lists of prefixes, and a name in one of the
 * examples' namespaces, urn:example:..., which no consumer knows, where it
 * isn't ignorable. And each such name, by its local name and namespace.
 */
function namespaceProblems(xml: string): { problems: string[]; names: Array<[string, string]> } {
  const problems: string[] = [];
  const names: Array<[string, string]> = [];
  const open: Array<{ scope: Map<string, string>; ignorable: Set<string> }> = [{ scope: new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]), ignorable: new Set() }];
  for (const [, close, name, attributeText, empty] of xml.matchAll(/<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g)) {
    if (close) { open.pop(); continue; }
    const parent = open[open.length - 1];
    const scope = new Map(parent.scope);
    const attributes = [...attributeText.matchAll(/\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, qname, double, single]) => [qname, double ?? single] as const);
    for (const [qname, value] of attributes) {
      if (qname === 'xmlns') scope.set('', value);
      else if (qname.startsWith('xmlns:')) scope.set(qname.slice('xmlns:'.length), value);
    }
    /** A name's namespace and local name, or none where it has no prefix and is an attribute's */
    const resolve = (qname: string, attribute: boolean): [string, string] | undefined => {
      const colon = qname.indexOf(':');
      if (colon === -1) return attribute || !scope.has('') ? undefined : [scope.get('')!, qname];
      const namespace = scope.get(qname.slice(0, colon));
      if (namespace === undefined) problems.push(qname + ' is unbound');
      return namespace === undefined ? undefined : [namespace, qname.slice(colon + 1)];
    };
    const ignorable = new Set(parent.ignorable);
    const element = resolve(name, false);
    for (const [qname, value] of attributes) {
      if (qname === 'xmlns' || qname.startsWith('xmlns:')) continue;
      const attribute = resolve(qname, true);
      const isList = attribute?.[0] === MARKUP_COMPATIBILITY && ['Ignorable', 'MustUnderstand', 'ProcessContent', 'PreserveElements', 'PreserveAttributes'].includes(attribute[1])
        || !qname.includes(':') && qname === 'Requires' && element?.[0] === MARKUP_COMPATIBILITY && element[1] === 'Choice';
      if (!isList) continue;
      for (const token of value.split(/\s+/).filter(Boolean)) {
        const prefix = token.includes(':') ? token.slice(0, token.indexOf(':')) : token;
        if (!scope.has(prefix)) problems.push(qname + ' names ' + prefix + ', which is unbound');
        else if (attribute?.[1] === 'Ignorable') ignorable.add(scope.get(prefix)!);
      }
    }
    for (const [namespace, local] of [element, ...attributes.filter(([qname]) => qname !== 'xmlns' && !qname.startsWith('xmlns:')).map(([qname]) => resolve(qname, true))]
      .filter((resolved): resolved is [string, string] => resolved !== undefined)) {
      if (!namespace.startsWith('urn:example:')) continue;
      names.push([local, namespace]);
      if (!ignorable.has(namespace)) problems.push(local + ' in ' + namespace + ' is not ignorable');
    }
    if (!empty) open.push({ scope, ignorable });
  }
  return { problems, names };
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

  it('take the last section\'s where the template\'s relationships hold more than a thousand references to entities', async () => {
    // The parser of a part had fast-xml-parser's default limit of a
    // thousand, of which every &apos; counts, and read the relationships as
    // none, so the template's headers and footers went
    const target = 'https://example.com/' + '&apos;'.repeat(1001);
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/_rels/document.xml.rels', xml => xml.replace('</Relationships>',
      () => '<Relationship Id="rId99" Type="' + REL + 'hyperlink" Target="' + target + '" TargetMode="External"/></Relationships>'));
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['landscape titlePg header:even=EVEN HEADER header:default=LANDSCAPE HEADER footer:even=EVEN FOOTER ' +
      'footer:default=LANDSCAPE FOOTER header:first=FIRST HEADER footer:first=FIRST FOOTER']);
    const md1 = (await convertDocx(docx)).markdown;
    expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
  });

  it('take the last section\'s, each as that section shows it, and the first\'s title page', async () => {
    const { docx } = await convertMdToDocx('Hello', { templateDocx: await headerTemplate({ landscapeLast: true }) });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['landscape titlePg header:even=EVEN HEADER header:default=LANDSCAPE HEADER footer:even=EVEN FOOTER ' +
      'footer:default=LANDSCAPE FOOTER header:first=FIRST HEADER footer:first=FIRST FOOTER']);
  });

  it.each([['paragraph', 'w:p'], ['paragraph\'s properties', 'w:pPr']])('take a section\'s references by the prefixes its %s binds, not the document element\'s', async (_, element) => {
    // r, which the document element binds to another namespace and the
    // section's paragraph to the relationships', got a prefix of its own
    // there, so its references named no relationship, and its even and
    // first-page headers and footers were dropped
    const templateDocx = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => xml
      .replace(/(<w:document\b[^>]*?) xmlns:r="[^"]*"/, (_, open: string) => open + ' xmlns:r="urn:example:other"')
      .replace('<w:p><w:pPr><w:sectPr ', () => element === 'w:p' ? '<w:p xmlns:r="' + REL.slice(0, -1) + '"><w:pPr><w:sectPr ' : '<w:p><w:pPr xmlns:r="' + REL.slice(0, -1) + '"><w:sectPr ')
      .replace('<w:sectPr w:rsidR="00A1B2C3">', () => '<w:sectPr xmlns:r="' + REL.slice(0, -1) + '" w:rsidR="00A1B2C3">'));
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['landscape titlePg header:even=EVEN HEADER header:default=LANDSCAPE HEADER footer:even=EVEN FOOTER ' +
      'footer:default=LANDSCAPE FOOTER header:first=FIRST HEADER footer:first=FIRST FOOTER']);
  });

  // Each place a template can bind a prefix, the one it uses for an
  // extension's namespace or one of export's it binds to that namespace,
  // and each section property export takes that can use it
  const bindings = ['the document element', 'the body', 'the section\'s paragraph', 'the section\'s paragraph\'s properties', 'the sectPr', 'the property itself'] as const;
  const properties = [
    ['a reference the last section takes from an earlier one', 'first', /<w:headerReference w:type="even"/],
    ['the last section\'s reference', 'last', /<w:headerReference w:type="default"/],
    ['columns', 'last', /<w:cols\b/],
    ['the document grid', 'last', /<w:docGrid\b/],
    ['page numbering', 'last', /<w:pgNumType\b/],
    ['an element of the extension\'s', 'last', /<PREFIX:extra\b/],
  ] as const;
  const cases = bindings.flatMap(binding => properties.flatMap(([property, section, element]) =>
    // A paragraph holds only an earlier section's properties
    (['ext', 'mc'] as const).flatMap(prefix => /paragraph/.test(binding) && section === 'last' ? [] : [[binding, property, prefix, section, element] as const])));
  it.each(cases)('go with the namespace their template binds where it binds it on %s, for %s, with prefix %s', async (binding, _, prefix, section, element) => {
    // A reference an earlier section's sectPr held went in the first
    // section with a prefix for a namespace that sectPr declared, which
    // nothing in the export did
    const MCE = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
    // The prefix bound to the extension's namespace, ignorable, and, where
    // it's mc, another for markup compatibility
    const declarations = prefix === 'ext' ? 'xmlns:ext="urn:example:ext" mc:Ignorable="ext"' : 'xmlns:mc="urn:example:ext" xmlns:mce="' + MCE + '" mce:Ignorable="mc"';
    const template = await editTemplate(await headerTemplate({ landscapeLast: true }), 'word/document.xml', xml => {
      const at = section === 'first' ? xml.indexOf('<w:sectPr') : xml.lastIndexOf('<w:sectPr');
      const end = xml.indexOf('</w:sectPr>', at);
      let sectPr = xml.slice(at, end).replace(/<w:cols\b/, () => '<w:pgNumType w:fmt="lowerRoman"/><w:cols')
        + (element.source.includes('PREFIX') ? '<' + prefix + ':extra/>' : '');
      const target = new RegExp(element.source.replace('PREFIX', prefix));
      sectPr = sectPr.replace(target, open => open + (binding === 'the property itself' ? ' ' + declarations : '') + ' ' + prefix + ':flag="1"');
      if (binding === 'the sectPr') sectPr = sectPr.replace('<w:sectPr ', () => '<w:sectPr ' + declarations + ' ');
      xml = xml.slice(0, at) + sectPr + xml.slice(end);
      // Markup compatibility's prefix, where the template binds mc to the extension's namespace elsewhere,
      // in place of the document element's own declaration of it
      xml = xml.replace(' xmlns:mc="' + MCE + '"', () => '').replace('<w:document ', () => '<w:document ' + (binding !== 'the document element' ? 'xmlns:mc="' + MCE + '"' : prefix === 'ext' ? 'xmlns:mc="' + MCE + '" ' + declarations : declarations) + ' ');
      if (binding === 'the body') xml = xml.replace('<w:body>', () => '<w:body ' + declarations + '>');
      if (binding === 'the section\'s paragraph') xml = xml.replace('<w:p><w:pPr><w:sectPr', () => '<w:p ' + declarations + '><w:pPr><w:sectPr');
      if (binding === 'the section\'s paragraph\'s properties') xml = xml.replace('<w:p><w:pPr><w:sectPr', () => '<w:p><w:pPr ' + declarations + '><w:sectPr');
      return xml;
    });
    // The extension's names the template has, by where they are, which are its own
    expect(namespaceProblems((await textOf(await JSZip.loadAsync(template), 'word/document.xml'))!).problems).toEqual([]);
    for (const md of ['Hello', LANDSCAPE_MD]) {
      const { docx } = await convertMdToDocx(md, { templateDocx: template });
      expect(await packageProblems(docx)).toEqual([]);
      const { problems, names } = namespaceProblems((await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!);
      expect(problems).toEqual([]);
      // Each of the extension's names in its namespace, and the property's
      // flag, and the element, where export takes the section's own
      expect(names.every(([, namespace]) => namespace === 'urn:example:ext')).toBe(true);
      expect(names.some(([name]) => name === 'flag')).toBe(true);
      // The inherited reference still names the even header
      const zip = await JSZip.loadAsync(docx);
      const firstSectPr = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec((await textOf(zip, 'word/document.xml'))!)![0];
      const id = /<w:headerReference\b(?=[^>]*\sw:type="even")[^>]*\sr:id="([^"]*)"/.exec(firstSectPr)?.[1];
      const target = new RegExp('<Relationship\\b(?=[^>]*\\sId="' + id + '")[^>]*\\sTarget="([^"]*)"').exec((await textOf(zip, 'word/_rels/document.xml.rels'))!)?.[1];
      expect(await textOf(zip, 'word/' + target)).toContain('EVEN HEADER');
    }
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

  // CDATA in the last section is text to an XML parser, though it looks
  // like the body's end tag, written here as the real one isn't, or a page
  it.each([
    ['the body\'s end tag', '</w:body>'],
    ['a landscape page', '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>'],
  ])('go in the last section where it holds CDATA that looks like %s', async (_name, text) => {
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml', xml => xml.replace('</w:body>', '</w:body\n>')
      .replace(/<w:sectPr\b[^>]*>(?![\s\S]*<w:sectPr\b)/, sectPr => sectPr + '<![CDATA[' + text + ']]>'));
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(await sectionHeaders(docx)).toEqual(['portrait titlePg ' + ALL_HEADERS]);
  });

  // A sectPr holds elements alone, with whitespace between them (CT_SectPr),
  // so what else the template's last one holds as text, a CDATA section's or
  // other, goes from each section export writes, in it and in a property of
  // it, and its properties stay
  it.each([
    ['a CDATA section', '<![CDATA[<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>]]>'],
    ['other text', 'stray'],
  ])('leave out %s the template\'s last section holds', async (_name, text) => {
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml', xml => xml.replace('<w:cols w:space="720"/><w:titlePg/>',
      () => text + '<w:pgBorders>' + text + '<w:top w:val="single" w:sz="4" w:space="24" w:color="auto"/></w:pgBorders>\n  <w:cols w:space="720"/><w:titlePg/>'));
    const { docx } = await convertMdToDocx(LANDSCAPE_MD, { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    const sectPrs = [...(await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map(([sectPr]) => sectPr);
    expect(sectPrs.length).toBeGreaterThan(1);
    for (const sectPr of sectPrs) expect(sectPr.replace(/<[^>]*>/g, '').trim()).toBe('');
    expect(sectPrs[sectPrs.length - 1]).toContain('<w:pgBorders><w:top w:val="single" w:sz="4" w:space="24" w:color="auto"/></w:pgBorders>');
  });

  // Its numId read as import reads it, by its value (see xmlInteger)
  it.each([
    ['a plus sign', '+3'],
    ['whitespace around it', ' 3 '],
  ])('keep the numbering of a header\'s list whose numId is written with %s', async (_name, numId) => {
    const templateDocx = await editTemplate(await headerTemplate({ headerList: 'direct' }), 'word/header3.xml',
      xml => xml.replace('<w:numId w:val="3"/>', () => '<w:numId w:val="' + numId + '"/>'));
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    const zip = await JSZip.loadAsync(docx);
    expect((await textOf(zip, 'word/header3.xml'))!).toContain('<w:numId w:val="' + numId + '"/>');
    expect((await textOf(zip, 'word/numbering.xml'))!).toContain('<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num>');
  });

  // The header's drawing ID read by its value, as an xsd:unsignedInt's, so
  // it's no other drawing's
  it('give a header\'s drawing whose ID is written with a plus sign an ID of its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'template-sections-'));
    try {
      writeFileSync(join(dir, 'a.png'), PNG);
      const templateDocx = await editTemplate(await headerTemplate(), 'word/header1.xml', xml => xml.replace('<wp:docPr id="1"', '<wp:docPr id="+1"'));
      const { docx } = await convertMdToDocx('![a](a.png)', { templateDocx, sourceDir: dir });
      expect(await packageProblems(docx)).toEqual([]);
      const zip = await JSZip.loadAsync(docx);
      expect((await textOf(zip, 'word/document.xml'))!).toContain('<wp:docPr id="1"');
      expect((await textOf(zip, 'word/header1.xml'))!).toContain('<wp:docPr id="2"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An attribute's references read as XML reads them, where export gives a
  // header's relationships new IDs, so one to no character of XML's, which
  // isn't well-formed, stays as written
  it('keep a header whose relationships take new IDs and whose attribute holds a reference to no character of XML\'s', async () => {
    let templateDocx = await editTemplate(await headerTemplate(), 'word/header1.xml', xml => xml.replace('<w:p>', '<w:p w:rsidR="&#x110000;">').replace('r:embed="rId1"', 'r:embed="rId5"'));
    templateDocx = await editTemplate(templateDocx, 'word/_rels/header1.xml.rels', xml => xml.replace('Id="rId1"', 'Id="rId5"'));
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await sectionHeaders(docx)).toEqual(['portrait titlePg ' + ALL_HEADERS]);
    const zip = await JSZip.loadAsync(docx);
    const header = (await textOf(zip, 'word/header1.xml'))!;
    expect(header).toContain('<w:p w:rsidR="&#x110000;">');
    expect(header).toContain('r:embed="rId1"');
    expect((await textOf(zip, 'word/_rels/header1.xml.rels'))!).toContain('Id="rId1"');
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
    // The hyperlink's target has a tab and a carriage return, each written
    // as a reference, which the relationships keep as one.
    const namespace = REL.slice(0, -1);
    let templateDocx = await editTemplate(await headerTemplate({ headerList: 'direct', pictureBullet: true }), 'word/_rels/header1.xml.rels', xml => xml.replace('Id="rId1"', 'Id="rId4"')
      .replace('</Relationships>', '<Relationship Id="rId9" Type="' + REL + 'image" Target="media/image1.png"/><Relationship Id="rId7" Type="' + REL + 'hyperlink" Target="https://example.com/a&#9;b&#xD;c" TargetMode="External"/></Relationships>'));
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
    expect(rels).toEqual(['rId1 image media/image1.png', 'rId2 hyperlink https://example.com/a&#9;b&#xD;c', 'rId3 image media/image1.png']);
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

// The children of CT_SectPr in its order (ECMA-376 Part 1 §17.6.17), the
// references, any of up to six, first
const SECT_PR_ORDER = ['headerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols',
  'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange'];
// Word's narrowest column, in twips
const NARROWEST_COLUMN = 720;
/** An element's children, each whole, as a sectPr's */
function childrenOf(element: string): string[] {
  const children: string[] = [];
  let depth = 0, start = 0;
  const inner = element.replace(/^<[^>]*>/, '').replace(/<\/[^>]+>$/, '');
  for (const m of inner.matchAll(/<(\/?)([\w.:-]+)\b[^>]*?(\/?)>/g)) {
    if (m[1]) { if (--depth === 0) children.push(inner.slice(start, m.index! + m[0].length)); }
    else if (m[3]) { if (depth === 0) children.push(m[0]); }
    else if (depth++ === 0) start = m.index!;
  }
  return children;
}
/** A sectPr's children as a consumer reads them that takes, of markup
 *  compatibility's alternatives, and of those in them, or in its columns,
 *  `branch`, or, where it's Word, the choice where it needs w14, which Word
 *  understands, and else the fallback */
function readAs(sectPr: string, branch: 'mc:Choice' | 'mc:Fallback' | 'Word'): string[] {
  const flatten = (children: string[]): string[] => children.flatMap(child => {
    if (child.startsWith('<w:cols') && child.includes('<mc:AlternateContent')) return [/^<[^>]*>/.exec(child)![0] + flatten(childrenOf(child)).join('') + '</w:cols>'];
    if (!child.startsWith('<mc:AlternateContent')) return [child];
    const branches = childrenOf(child);
    const taken = branch !== 'Word' ? branch : branches.some(b => b.startsWith('<mc:Choice Requires="w14"')) ? 'mc:Choice' : 'mc:Fallback';
    const chosen = branches.find(b => b.startsWith('<' + taken));
    return chosen ? flatten(childrenOf(chosen)) : [];
  });
  return flatten(childrenOf(sectPr));
}
const attributeOf = (element: string | undefined, name: string) => element ? new RegExp('\\sw:' + name + '="([^"]*)"').exec(element)?.[1] : undefined;
// Twips in the units a measure can give
const TWIPS_PER: Record<string, number> = { mm: 1440 / 25.4, cm: 1440 / 2.54, in: 1440, pt: 20, pc: 240, pi: 240 };
/** A measure in twips, or in one of those units, in twips */
const twips = (value: string | undefined) => {
  const m = /^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)?$/.exec(value ?? '');
  return m ? Math.round(Number(m[1]) * (m[2] ? TWIPS_PER[m[2]] : 1)) : undefined;
};
/** The width of the text of a section whose properties are `read`, and of
 *  its narrowest column, and what's wrong with its columns: one narrower
 *  than Word makes them, or columns of their own widths, with the spaces
 *  after them, wider than the text */
function columnsOf(read: string[]): { text: number; narrowest: number; problem?: string } {
  const pgSz = read.find(child => child.startsWith('<w:pgSz')), pgMar = read.find(child => child.startsWith('<w:pgMar')), cols = read.find(child => child.startsWith('<w:cols'));
  const text = (twips(attributeOf(pgSz, 'w')) ?? 12240) - (twips(attributeOf(pgMar, 'left')) ?? 1440) - (twips(attributeOf(pgMar, 'right')) ?? 1440);
  if (cols && /^(?:0|false|off)$/.test(attributeOf(cols, 'equalWidth') ?? '')) {
    const own = [...cols.matchAll(/<w:col\b[^>]*>/g)].map(([col]) => col);
    const widths = own.map(col => twips(attributeOf(col, 'w')) ?? 0);
    const total = own.reduce((sum, col, i) => sum + widths[i] + (i < own.length - 1 ? twips(attributeOf(col, 'space')) ?? 0 : 0), 0);
    const narrowest = Math.min(...widths);
    return { text, narrowest, problem: narrowest < NARROWEST_COLUMN ? 'a column ' + narrowest + ' wide' : total > text ? 'columns ' + total + ' wide in ' + text : undefined };
  }
  if (!cols) return { text, narrowest: text };
  const num = Number(attributeOf(cols, 'num') ?? 1), space = twips(attributeOf(cols, 'space')) ?? 720;
  const narrowest = (text - (num - 1) * space) / num;
  return { text, narrowest, problem: num > 1 && narrowest < NARROWEST_COLUMN ? num + ' columns ' + space + ' apart in ' + text : undefined };
}
/** What's wrong with a sectPr as each of markup compatibility's
 *  alternatives in it reads: a child out of CT_SectPr's order or twice, or
 *  columns that don't fit (see columnsOf) */
function sectPrProblems(sectPr: string): string[] {
  const problems: string[] = [];
  for (const branch of ['mc:Choice', 'mc:Fallback'] as const) {
    const read = readAs(sectPr, branch);
    let last = -1;
    for (const child of read) {
      const name = /^<w:(\w+)/.exec(child)?.[1] ?? child;
      const rank = SECT_PR_ORDER.indexOf(name === 'footerReference' ? 'headerReference' : name);
      if (rank === -1) problems.push(branch + ': ' + name + ' is no section property');
      else if (rank < last || rank === last && rank !== 0) problems.push(branch + ': ' + name + ' out of order or twice');
      last = Math.max(last, rank);
    }
    const { problem } = columnsOf(read);
    if (problem) problems.push(branch + ': ' + problem);
  }
  return problems;
}

describe('a template\'s section properties, in each section export writes', () => {
  // A template's properties in CT_SectPr's order, each as markup
  // compatibility's choice and fallback would have it, where they hold it
  // Columns, their measures each in twips or in points, as `measure` writes them
  type Columns = { num: number; space?: number } | Array<{ width: number; space: number }>;
  const equalColumns = fc.record({ num: fc.integer({ min: 1, max: 3 }), space: fc.option(fc.constantFrom(0, 360, 720, 4000, 9600, 12000), { nil: undefined }) });
  const ownColumns = fc.array(fc.record({ width: fc.integer({ min: 500, max: 13000 }), space: fc.constantFrom(0, 360, 720) }), { minLength: 1, maxLength: 3 });
  const columns = fc.option(fc.oneof<fc.Arbitrary<Columns>[]>(equalColumns, ownColumns), { nil: undefined });
  // Columns of their own widths can be held in alternatives in the columns
  const colsXml = (columns: Columns, measure: (twips: number) => string, held: boolean) => {
    if (!Array.isArray(columns)) return '<w:cols w:num="' + columns.num + '"' + (columns.space === undefined ? '' : ' w:space="' + measure(columns.space) + '"') + '/>';
    const own = columns.map(({ width, space }, i) => '<w:col w:w="' + measure(width) + '"' + (i < columns.length - 1 ? ' w:space="' + measure(space) + '"' : '') + '/>').join('');
    return '<w:cols w:num="' + columns.length + '" w:space="720" w:equalWidth="0">'
      + (held ? '<mc:AlternateContent><mc:Choice Requires="w14">' + own + '</mc:Choice><mc:Fallback>' + own + '</mc:Fallback></mc:AlternateContent>' : own) + '</w:cols>';
  };
  const property = (xml: string) => fc.option(fc.constant(xml), { nil: undefined });
  const template = fc.record({
    landscape: fc.boolean(),
    left: fc.constantFrom(720, 1440, 2160),
    right: fc.constantFrom(720, 1440, 2160),
    footnotePr: property('<w:footnotePr><w:numFmt w:val="lowerRoman"/></w:footnotePr>'),
    endnotePr: property('<w:endnotePr><w:numFmt w:val="upperRoman"/></w:endnotePr>'),
    pgMar: fc.boolean(),
    paperSrc: property('<w:paperSrc w:first="1" w:other="1"/>'),
    pgBorders: property('<w:pgBorders><w:top w:val="single" w:sz="4" w:space="24" w:color="auto"/></w:pgBorders>'),
    lnNumType: property('<w:lnNumType w:countBy="1"/>'),
    pgNumType: property('<w:pgNumType w:fmt="lowerRoman"/>'),
    cols: columns,
    // The fallback's own columns, where they differ
    fallbackCols: columns,
    formProt: property('<w:formProt w:val="0"/>'),
    vAlign: property('<w:vAlign w:val="center"/>'),
    noEndnote: property('<w:noEndnote/>'),
    titlePg: property('<w:titlePg/>'),
    textDirection: property('<w:textDirection w:val="lrTb"/>'),
    bidi: property('<w:bidi w:val="0"/>'),
    docGrid: property('<w:docGrid w:linePitch="360"/>'),
    // Whether each property starts a run of them of its own, whether each
    // run is held in alternatives, whether Word reads its choice, which
    // needs w14, or its fallback, as its choice needs another namespace,
    // and whether those alternatives are in a choice's of their own
    starts: fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
    held: fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
    read: fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
    nested: fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
    // Whether margins are in inches, and columns in points
    units: fc.boolean(),
    // And whether columns of their own widths are in alternatives in them
    heldColumns: fc.boolean(),
  }).map(t => {
    const inches = (twips: number) => t.units ? twips / 1440 + 'in' : String(twips);
    const points = (twips: number) => t.units ? twips / 20 + 'pt' : String(twips);
    const margins = '<w:pgMar w:top="1440" w:right="' + inches(t.right) + '" w:bottom="1440" w:left="' + inches(t.left) + '" w:header="720" w:footer="720" w:gutter="0"/>';
    const page = t.landscape ? '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>' : '<w:pgSz w:w="12240" w:h="15840"/>';
    const properties: Array<[string, string]> = [t.footnotePr, t.endnotePr, page, t.pgMar ? margins : undefined, t.paperSrc, t.pgBorders, t.lnNumType, t.pgNumType]
      .filter((xml): xml is string => xml !== undefined).map(xml => [xml, xml]);
    if (t.cols) properties.push([colsXml(t.cols, points, t.heldColumns), colsXml(t.fallbackCols ?? t.cols, points, t.heldColumns)]);
    for (const xml of [t.formProt, t.vAlign, t.noEndnote, t.titlePg, t.textDirection, t.bidi, t.docGrid]) if (xml) properties.push([xml, xml]);
    const runs: Array<Array<[string, string]>> = [];
    properties.forEach((p, i) => i > 0 && !t.starts[i] ? runs[runs.length - 1].push(p) : runs.push([p]));
    return '<w:sectPr>' + runs.map((run, i) => {
      const [choice, fallback] = [0, 1].map(side => run.map(p => p[side]).join(''));
      if (!t.held[i]) return choice;
      const alternatives = '<mc:AlternateContent><mc:Choice Requires="' + (t.read[i] ? 'w14"' : 'x" xmlns:x="urn:example:x"') + '>' + choice + '</mc:Choice><mc:Fallback>' + fallback + '</mc:Fallback></mc:AlternateContent>';
      return t.nested[i] ? '<mc:AlternateContent><mc:Choice Requires="w14">' + alternatives + '</mc:Choice><mc:Fallback>' + fallback + '</mc:Fallback></mc:AlternateContent>' : alternatives;
    }).join('') + '</w:sectPr>';
  })
    // As Word lets a template be: its columns fit its own page
    .filter(sectPr => sectPrProblems(sectPr).length === 0);
  const figure = '![f](f.png){width=1200 height=600}';
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const documents = [
    'P ' + figure + '\n\n' + table + '\n\n<!-- landscape -->\n\n' + figure + '\n\n' + table + '\n\n<!-- /landscape -->\n\n<!-- portrait -->\n\n' + figure + '\n\n' + table
      + '\n\n<!-- /portrait -->\n\n<!-- table-orientation: landscape -->\n' + table + '\n\nEnd ' + figure + '\n',
    'P.\n\n<!-- portrait -->\n\n' + figure + '\n\n' + table + '\n\n<!-- /portrait -->\n',
    'P.\n\n<!-- landscape -->\n\n' + figure + '\n\n' + table + '\n\n<!-- /landscape -->\n',
  ];

  it('keep CT_SectPr\'s order, each once, and columns that fit, and size their tables and images to fit them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'template-sections-'));
    try {
      writeFileSync(join(dir, 'f.png'), PNG);
      const base = await JSZip.loadAsync((await convertMdToDocx('x')).docx);
      const baseXml = await base.file('word/document.xml')!.async('string');
      await fc.assert(fc.asyncProperty(template, async sectPr => {
        base.file('word/document.xml', baseXml.replace(/<w:sectPr\b(?![\s\S]*<w:sectPr\b)[\s\S]*<\/w:sectPr>/, () => sectPr));
        const templateDocx = await base.generateAsync({ type: 'uint8array' });
        for (const md of documents) {
          const { docx } = await convertMdToDocx(md, { templateDocx, sourceDir: dir });
          const xml = (await textOf(await JSZip.loadAsync(docx), 'word/document.xml'))!;
          expect(XMLValidator.validate(xml)).toBe(true);
          // Each section's content, before its properties, and those
          let from = 0;
          for (const match of xml.matchAll(/<w:sectPr\b[^>]*>(?:(?!<w:sectPr\b)[\s\S])*?<\/w:sectPr>/g)) {
            const [own] = match, content = xml.slice(from, match.index);
            from = match.index! + own.length;
            expect(sectPrProblems(own)).toEqual([]);
            // A section export adds has what Word reads of alternatives
            if (xml.startsWith('</w:pPr>', from)) expect(own).not.toContain('mc:AlternateContent');
            // Its tables span the narrowest column Word shows, and its
            // images fit it, to within rounding
            const { narrowest } = columnsOf(readAs(own, 'Word'));
            for (const [, grid] of content.matchAll(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/g)) {
              const widths = [...grid.matchAll(/<w:gridCol w:w="(-?\d+)"/g)].map(([, width]) => Number(width));
              for (const width of widths) expect(width).toBeGreaterThan(0);
              expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(narrowest + widths.length);
            }
            for (const [, cx, cy] of content.matchAll(/<wp:extent cx="(-?\d+)" cy="(-?\d+)"/g)) {
              expect(Math.min(Number(cx), Number(cy))).toBeGreaterThan(0);
              expect(Number(cx)).toBeLessThanOrEqual((narrowest / 15 + 1) * 9525);
            }
          }
        }
      }), { numRuns: 100 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('a template\'s last section without a w:rsidR or columns', () => {
  // Its sectPr came back as it was, where Word adds both on open, marking
  // the document changed (dirty-flag invariant 11), as the sections export
  // adds before it have them
  const page = '<w:pgSz w:w="12240" w:h="15840"/>', turned = '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>';
  const margins = '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>';
  const columns = '<w:cols w:space="720"/>', grid = '<w:docGrid w:linePitch="360"/>';
  const fenced = 'A\n\n<!-- landscape -->\n\nB\n\n<!-- /landscape -->\n';
  /** A template whose last sectPr is `sectPr` */
  const withLast = async (sectPr: string) => editTemplate((await convertMdToDocx('Template text')).docx, 'word/document.xml',
    xml => xml.replace(/<w:sectPr\b(?![\s\S]*<w:sectPr\b)[\s\S]*<\/w:sectPr>/, () => sectPr));
  /** Each sectPr export writes of `md` with `templateDocx`, its rsid as
   *  RSID, where the Markdown comes back from Word as it was, and again */
  const sectPrsOf = async (md: string, templateDocx: Uint8Array) => {
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    const md1 = (await convertDocx(docx)).markdown;
    expect(md1).toBe(md);
    expect((await convertDocx((await convertMdToDocx(md1, { templateDocx })).docx)).markdown).toBe(md1);
    const zip = await JSZip.loadAsync(docx);
    const rsid = /<w:rsidRoot w:val="([^"]+)"/.exec((await textOf(zip, 'word/settings.xml'))!)![1];
    return [...(await textOf(zip, 'word/document.xml'))!.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map(([sectPr]) => sectPr.split(rsid).join('RSID'));
  };

  it.each([
    ['only its page and margins', '<w:sectPr>' + page + margins + '</w:sectPr>', 'Hello\n', '<w:sectPr w:rsidR="RSID">' + page + margins + columns + '</w:sectPr>'],
    ['a document grid, which columns go before', '<w:sectPr>' + page + margins + grid + '</w:sectPr>', 'Hello\n', '<w:sectPr w:rsidR="RSID">' + page + margins + columns + grid + '</w:sectPr>'],
    ['columns of its own', '<w:sectPr>' + page + margins + '<w:cols w:num="2" w:space="720"/>' + grid + '</w:sectPr>', 'Hello\n',
      '<w:sectPr w:rsidR="RSID">' + page + margins + '<w:cols w:num="2" w:space="720"/>' + grid + '</w:sectPr>'],
    ['another rsid', '<w:sectPr w:rsidSect="00AB12CD">' + page + margins + '</w:sectPr>', 'Hello\n', '<w:sectPr w:rsidR="RSID" w:rsidSect="00AB12CD">' + page + margins + columns + '</w:sectPr>'],
    ['a section break before it', '<w:sectPr>' + page + margins + grid + '</w:sectPr>', fenced + '\nC\n', '<w:sectPr w:rsidR="RSID">' + page + margins + columns + grid + '</w:sectPr>'],
    ['a fence that ends it', '<w:sectPr>' + page + margins + grid + '</w:sectPr>', fenced, '<w:sectPr w:rsidR="RSID">' + turned + margins + columns + grid + '</w:sectPr>'],
  ])('gets them, as a section break has them, where it has %s', async (_name, sectPr, md, expected) => {
    const sectPrs = await sectPrsOf(md, await withLast(sectPr));
    expect(sectPrs[sectPrs.length - 1]).toBe(expected);
    for (const each of sectPrs) expect(each).toMatch(/^<w:sectPr w:rsidR="[^"]+"[^>]*>.*<w:cols [^>]*\/>/);
  });

  it('gets them among the template\'s references, title page and document grid, in CT_SectPr\'s order', async () => {
    const templateDocx = await editTemplate(await headerTemplate(), 'word/document.xml',
      xml => xml.replace('<w:sectPr w:rsidR="00A1B2C3" w:rsidSect="00A1B2C3">', '<w:sectPr w:rsidSect="00A1B2C3">').replace(columns, ''));
    const sectPrs = await sectPrsOf('Hello\n', templateDocx);
    expect(sectPrs).toHaveLength(1);
    expect(sectPrs[0]).toMatch(/^<w:sectPr w:rsidR="RSID" w:rsidSect="00A1B2C3">(?:<w:(?:header|footer)Reference [^>]*\/>){6}<w:pgSz /);
    expect(sectPrs[0].replace(/<w:(?:header|footer)Reference [^>]*\/>/g, '')).toBe('<w:sectPr w:rsidR="RSID" w:rsidSect="00A1B2C3">' + page + margins + columns + '<w:titlePg/>' + grid + '</w:sectPr>');
  });

  it.each([['Hello\n'], [fenced + '\nC\n']])('comes back as the template has it where it has both: %j', async md => {
    const sectPr = '<w:sectPr w:rsidR="00AB12CD" w:rsidSect="00AB12CD">' + page + margins + '<w:cols w:num="2" w:space="720"/>' + grid + '</w:sectPr>';
    const sectPrs = await sectPrsOf(md, await withLast(sectPr));
    expect(sectPrs[sectPrs.length - 1]).toBe(sectPr);
  });
});

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
      [LANDSCAPE_MD, ['nextPage 12240 15840 ', 'nextPage 15840 12240 landscape', 'nextPage 12240 15840 ']],
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

  // The template's instance at the numId export's own take, read as import
  // reads it, by its value (see xmlInteger), goes, so no two have one
  it.each([
    ['a plus sign', '+1'],
    ['a plus sign and a leading zero', '+01'],
  ])('gives bullets their own where its numbers\' numId 1 is written with %s', async (_name, numId) => {
    const md = '- bullet\n\n1. one\n2. two';
    const { docx } = await convertMdToDocx(md, { templateDocx: await listTemplate(numbering => decimalAt1(numbering).replace('<w:num w:numId="1"', () => '<w:num w:numId="' + numId + '"')) });
    expect(await packageProblems(docx)).toEqual([]);
    expect(body((await convertDocx(docx)).markdown)).toBe(md + '\n');
    const numIds = [...(await textOf(await JSZip.loadAsync(docx), 'word/numbering.xml'))!.matchAll(/<w:num w:numId="([^"]*)"/g)].map(m => Number(m[1]));
    expect(new Set(numIds).size).toBe(numIds.length);
  });

  // However many references to entities the numbering holds, which
  // fast-xml-parser caps by default, it's read as the template's, whose
  // numbers have their format
  it('gives numbers the template\'s format where its numbering holds more than a thousand references to entities', async () => {
    const levels = Array.from({ length: 9 }, (_, k) => '<w:lvl w:ilvl="' + k + '"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="&quot;"/></w:lvl>').join('');
    const templateDocx = await listTemplate(numbering => numbering
      .replace(/(<w:abstractNum w:abstractNumId="1"[\s\S]*?<w:numFmt w:val=")decimal"/, (_match, before: string) => before + 'lowerRoman"')
      .replace('<w:num ', () => Array.from({ length: 120 }, (_, k) => '<w:abstractNum w:abstractNumId="' + (200 + k) + '">' + levels + '</w:abstractNum>\n').join('') + '<w:num '));
    const md = '3. a\n4. b';
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect(await packageProblems(docx)).toEqual([]);
    expect(body((await convertDocx(docx)).markdown)).toBe(md + '\n');
    const numbering = (await textOf(await JSZip.loadAsync(docx), 'word/numbering.xml'))!;
    expect(numbering).toContain('<w:numFmt w:val="lowerRoman"/>');
    expect(numbering.match(/<w:lvlText w:val="&quot;"\/>/g)).toHaveLength(1080);
    expect(numbering).toMatch(/<w:num w:numId="\d+"[^>]*><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"\/>/);
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
  it.each([
    ['one character', 'x'],
    // The parser of a part had fast-xml-parser's default limit of a
    // thousand, and read the template's properties as none
    ['more than a thousand references to entities', '&quot;'.repeat(1001)],
  ])('keep the custom properties they show, after export\'s own, where another of the template\'s holds %s', async (_, unshown) => {
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
      property(4, 'Unshown', '<vt:lpwstr>' + unshown + '</vt:lpwstr>') + '</Properties>');
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

  // A field's code read as XML reads it: a reference to no character of
  // XML's, or to an entity XML doesn't declare, as &AMP;, stays as written,
  // so the field names no property the template has
  it.each([
    ['a reference to no character of XML\'s', '&#x110000;'],
    ['an entity XML doesn\'t declare', '&AMP;'],
  ])('show no property where a field\'s code holds %s', async (_name, reference) => {
    let templateDocx = await editTemplate(await headerTemplate(), 'word/footer2.xml', xml => xml.replace('<w:r><w:t>FIRST FOOTER</w:t></w:r>',
      '<w:fldSimple w:instr=" DOCPROPERTY &quot;A ' + reference + ' B&quot; "><w:r><w:t>42</w:t></w:r></w:fldSimple>'));
    templateDocx = await editTemplate(templateDocx, 'docProps/custom.xml', () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="A &amp; B"><vt:i4>42</vt:i4></property></Properties>');
    templateDocx = await editTemplate(templateDocx, '_rels/.rels', xml => xml.replace('</Relationships>',
      '<Relationship Id="rId9" Type="' + REL + 'custom-properties" Target="docProps/custom.xml"/></Relationships>'));
    templateDocx = await editTemplate(templateDocx, '[Content_Types].xml', xml => xml.replace('</Types>',
      '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'));
    const { docx } = await convertMdToDocx('Hello', { templateDocx });
    expect(await sectionHeaders(docx)).toEqual(['portrait titlePg ' + ALL_HEADERS.replace('FIRST FOOTER', '42')]);
    expect((await textOf(await JSZip.loadAsync(docx), 'docProps/custom.xml')) ?? '').not.toContain('name="A &amp; B"');
  });
});
