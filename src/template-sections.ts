// A template's headers and footers, which export copies into the document.
//
// A template's sectPr names its headers and footers, and its printer
// settings, by relationship ID. Export reuses the template's trailing sectPr,
// so it copies each part a reference names, with the parts that part names
// in turn (a header's images), their own relationships and their content
// types. Those relationships are document.xml's first, rId1 to rIdN, before
// export's own, so their IDs stay sequential (dirty-flag invariant #6) and
// the rId remap after generation, which only moves IDs above the reserved
// ones, leaves them.
//
// Invariants:
// - The export's first section carries the references and the title page
//   setting. A section without a reference of a type takes the previous
//   section's, so the sections export adds for orientation continue the
//   headers and footers, and only the document's first page is a title
//   page. The template's trailing sectPr goes without them.
// - The references are the ones the template's last section shows, each
//   type its own or the last earlier section's. The title page setting is
//   the template's first section's, whose first page is the document's. So
//   a previous export, whose first section holds the references, gives back
//   the same ones.
// - Each section export writes takes the page number format of the
//   template's last section, and only the first takes its start, the
//   template's first section's or else its last's. A start in a later
//   section would number that section's pages over, so the template's
//   trailing sectPr goes without its pgNumType, which each sectPr gets in
//   its schema place.
// - The references, title page and page numbering are read as Word reads
//   a sectPr, by namespace, from the choice or fallback of markup
//   compatibility's alternatives it reads, or from a wrapper whose content
//   it reads as the sectPr's own (see effectiveSectPr). Each goes into a
//   section with the declarations and markup compatibility's settings it
//   uses (see moved), so the sections export adds have them.
// - The trailing sectPr is written as Word reads it (see effectiveSectPr),
//   under export's prefixes, with markup compatibility's alternatives and
//   wrappers in place of what Word reads of them, as Word itself writes it
//   on save. So the properties export gives it go into its own children
//   (see withProperties), each once, in CT_SectPr's order, where every
//   consumer reads them, and every reader finds them there by name.
// - Where the template is an export whose last section's layout, its
//   break type, page or columns, export changed for the document's sake,
//   as it turns the page for a final fence and fits the columns to it, the
//   trailing sectPr has the template's own layout back, as export recorded
//   it (see TEMPLATE_LAYOUT_PROPERTY), so exporting again lays the sections
//   out alike. Not where any of the section's layout has changed since, as
//   in Word, what export changed or not, whose layout is then the
//   template's.
// - A reference goes if the template lacks its relationship or part, or
//   its relationship is of another type. Kept, it would name nothing, or a
//   part export writes for something else.
// - The trailing sectPr's other relationship IDs, as its printer
//   settings', get document.xml's, those in a tracked change's old
//   properties, w:sectPrChange, too. An element whose relationship or part
//   the template lacks goes.
// - The parts read as XML, by the XML parser, in the encoding their BOM or
//   declaration names. A part export doesn't change goes as it came; one it
//   changes goes as UTF-8.
// - A copied part's relationships, and the numbering's, are rId1 to rIdN
//   (dirty-flag invariant #6). Where the template's skip some, export
//   numbers them over and rewrites the part's references to them, each
//   attribute in the relationships namespace, whatever its prefix, and
//   VML's o:relid (see withRelationshipIds).
// - What a copied part names in the template's other parts stays named.
//   Export keeps the template's styles whole. With a header or footer it
//   writes the template's numbering, which keeps the instances the parts
//   (see `numIds`) and the styles use, and with that numbering the parts
//   it names, as a picture bullet's image (see md-to-docx.ts). Export
//   writes its own comments and notes, so a reference to one of the
//   template's goes. It writes its own custom properties too, so a
//   DOCPROPERTY field's property goes with them (see customProperties).
//   The core and app properties, as Title or Company, stay export's.

import type JSZip from 'jszip';
import { escapeXmlAttribute, xmlAttributeValue, xmlBuilder, xmlParser, xmlTextValue } from './xml-parser';
import { withXmlAttribute, xmlAttribute, xmlInteger, xmlLastMatch, xmlOn, xmlStartTags, xmlTwips } from './xml-elements';
import { EXPORT_CONTEXT, EXPORT_NAMESPACES, MARKUP_COMPATIBILITY, NO_COMPATIBILITY, ORDERED_OPTIONS, WORDPROCESSINGML, WORD_UNDERSTOOD_NAMESPACES, attributesOf, buildOrdered, childrenOf, contextIn, effectiveSectPr, expandName, expandedNameOf, isElement, isIgnored, isNamed, moved, nameOf, parseOrdered, readsChoice, scopeIn, sectPrPropertyOf, withProperties, type Context, type Scope, type XmlNode } from './scoped-xml';

interface Relationship {
  id: string;
  type: string;
  /** The Target attribute, as the source part names it */
  target: string;
  external: boolean;
  /** The part's path, for an internal target */
  path?: string;
}

/** A part the template's sections name, as the template holds it */
interface TemplatePart {
  data: Uint8Array;
  /** Its text, for a part export can change */
  xml?: string;
  contentType?: string;
  /** Whether the template types it by its extension */
  byExtension: boolean;
  /** Its relationships part, as the template holds it */
  rels?: Rels;
  /** Only the numbering names it, so it goes only with the template's numbering */
  numberingOnly: boolean;
}

/** A relationships part, as the template holds it, and its relationships */
interface Rels {
  data: Uint8Array;
  relationships: Relationship[];
  /** Their new IDs, where they aren't rId1 to rIdN already (see sequentialIds) */
  ids?: Map<string, string>;
}

export interface TemplateRelationship {
  type: string;
  /** The template's path for the part, or the URL of an external target */
  target: string;
  external: boolean;
}

export interface TemplateSections {
  /** The template's trailing sectPr without its header and footer references,
   *  title page setting or page numbering, its other relationship IDs renumbered */
  sectPr?: string;
  /** The references the export's first section takes, with IDs from rId1 */
  references: string;
  titlePg: boolean;
  /** The pgNumType the export's first section takes, and the one its other
   *  sections take, which has no start, or '' for none */
  pgNumType: { first: string; others: string };
  /** The template's settings show different headers on even pages */
  evenAndOddHeaders: boolean;
  /** document.xml's relationships rId1 to rIdN */
  relationships: TemplateRelationship[];
  parts: Map<string, TemplatePart>;
  /** The numbering instances the parts use, which the template's numbering keeps */
  numIds: Set<number>;
  /** The relationships of the template's numbering, which go with it */
  numberingRels?: Rels;
  /** The template's custom properties that the parts' DOCPROPERTY fields
   *  show, each with its type, as vt:lpwstr's lpwstr, and its value */
  customProperties: Array<{ name: string; type: string; value: string }>;
}

/** A package part (relationships, content types, settings, custom
 *  properties) as data, its prefixes dropped, its text as it is, with
 *  its character references, as &#x2019;, read too, and however many
 *  entities it has (see xmlParser) */
const partParser = xmlParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: true,
});

/** A package part as data (see partParser), or undefined where it isn't
 *  XML the parser reads */
export function parsePart(xml: string): unknown {
  try {
    return partParser.parse(xml);
  } catch {
    return undefined;
  }
}

/** The attributes of each child of a part's root named `name` */
function elementsOf(xml: string | undefined, root: string, name: string): Record<string, string>[] {
  if (xml === undefined) return [];
  try {
    const found = (partParser.parse(xml) as Record<string, Record<string, unknown> | undefined>)[root]?.[name];
    return (Array.isArray(found) ? found : found === undefined ? [] : [found])
      .map(element => typeof element === 'object' && element !== null ? element as Record<string, string> : {});
  } catch {
    return [];
  }
}

/** An XML part's text, in the encoding its BOM or declaration names */
export function decodeXml(bytes: Uint8Array): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xFF && bytes[1] === 0xFE || bytes[0] === 0x3C && bytes[1] === 0) encoding = 'utf-16le';
  else if (bytes[0] === 0xFE && bytes[1] === 0xFF || bytes[0] === 0 && bytes[1] === 0x3C) encoding = 'utf-16be';
  else if (!(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)) {
    const declaration = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
    const declared = /^<\?xml\b[^>]*?\sencoding\s*=\s*["']([^"']+)["']/.exec(declaration)?.[1];
    // UTF-16 without its BOM starts with <'s two bytes, which the bytes aren't
    if (declared && !/^utf-?16/i.test(declared)) encoding = declared;
  }
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** XML text as export writes it, in UTF-8, which its declaration then says */
export const asUtf8 = (xml: string) => xml.replace(/^(<\?xml\b[^>]*?\sencoding\s*=\s*)(["'])[^"']*\2/, (_, before: string, quote: string) => before + quote + 'UTF-8' + quote);

/** Whether an on-off property that is present is on: its w:val isn't "0", "false" or "off" */
const isOn = (val: unknown) => typeof val !== 'string' || !/^(?:0|false|off)$/.test(val);

/** The path of a part's relationships part */
const relsPathOf = (part: string) => {
  const slash = part.lastIndexOf('/');
  return part.slice(0, slash + 1) + '_rels/' + part.slice(slash + 1) + '.rels';
};

/** A relationship's target as a path in the package, from its source part */
function resolveTarget(source: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = source.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.' && segment !== '') segments.push(segment);
  }
  return segments.join('/');
}

/** The target that names a part from a source part */
function relativeTarget(source: string, part: string): string {
  const from = source.split('/').slice(0, -1);
  const to = part.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return '../'.repeat(from.length - common) + to.slice(common).join('/');
}

/** A part's relationships, in order */
function relationshipsOf(source: string, xml: string | undefined): Relationship[] {
  const relationships: Relationship[] = [];
  for (const r of elementsOf(xml, 'Relationships', 'Relationship')) {
    const id = r['@_Id'], type = r['@_Type'], target = r['@_Target'];
    if (typeof id !== 'string' || typeof type !== 'string' || typeof target !== 'string') continue;
    const external = r['@_TargetMode'] === 'External';
    relationships.push({ id, type, target, external, path: external ? undefined : resolveTarget(source, target) });
  }
  return relationships;
}

/** A part's relationships part, if it has one */
async function relsOf(zip: JSZip, path: string): Promise<Rels | undefined> {
  const data = await zip.file(relsPathOf(path))?.async('uint8array');
  if (!data) return undefined;
  const relationships = relationshipsOf(path, decodeXml(data));
  return { data, relationships, ids: sequentialIds(relationships) };
}

/** The path of the part that a part's relationship of a type names, as
 *  `theme` for its theme, by the relationship's target */
export async function relatedPartPath(zip: JSZip, source: string, type: string): Promise<string | undefined> {
  return (await relsOf(zip, source))?.relationships.find(r => r.path !== undefined && r.type.endsWith('/relationships/' + type))?.path;
}

/** The paths of the parts a part's relationships of the types given name,
 *  as `header` and `footer` for the headers and footers a document's
 *  sections show, whatever their names */
export async function relatedPartPaths(zip: JSZip, source: string, types: readonly string[]): Promise<string[]> {
  const suffixes = types.map(type => '/relationships/' + type);
  return ((await relsOf(zip, source))?.relationships ?? [])
    .filter(r => r.path !== undefined && suffixes.some(suffix => r.type.endsWith(suffix))).map(r => r.path!);
}

/**
 * New IDs for a part's relationships, rId1 up in the order of their
 * numbers, if they aren't rId1 to rIdN already. A part from a tool other
 * than Word can skip some, as rId7 with no rId1, and Word, which numbers
 * them without gaps (dirty-flag invariant #6), renumbers them on open.
 */
function sequentialIds(relationships: Relationship[]): Map<string, string> | undefined {
  const number = (r: Relationship) => /^rId[1-9]\d*$/.test(r.id) ? parseInt(r.id.slice(3), 10) : Infinity;
  const sorted = [...relationships].sort((a, b) => number(a) - number(b) || 0);
  if (sorted.every((r, i) => number(r) === i + 1)) return undefined;
  return new Map(sorted.map((r, i) => [r.id, 'rId' + (i + 1)]));
}

/** The relationships namespace, transitional and strict, whose attributes,
 *  as r:id, r:embed or a diagram's r:dm, name a part's relationships */
const RELATIONSHIPS_NAMESPACES = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']);
/** VML's office namespace, whose relid attribute names one too */
const OFFICE_NAMESPACE = 'urn:schemas-microsoft-com:office:office';
/** A start tag, or a comment or CDATA section, whose text holds no tag */
const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^\s!?/>][^\s/>]*(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g;
/** A tag's attribute, its prefix apart, matched whole so that none is found in another's value */
const ATTRIBUTE = /(\s)(?:([^\s=/>:]+):)?([^\s=/>]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g;

/**
 * A part's XML with the relationship IDs its attributes name changed to
 * their new `ids`: those of the attributes in the relationships namespace,
 * by whatever prefix the part binds it to, and of VML's o:relid. Text and
 * other attributes stay, though their value is an old ID.
 */
export function withRelationshipIds(xml: string, ids: Map<string, string> | undefined): string {
  if (!ids) return xml;
  const relationshipPrefixes = new Set<string>(), officePrefixes = new Set<string>();
  for (const [tag] of xml.matchAll(TAG)) {
    for (const [, , prefix, name, , double, single] of tag.matchAll(ATTRIBUTE)) {
      const namespace = prefix === 'xmlns' ? xmlAttributeValue(double ?? single!) : undefined;
      if (namespace !== undefined && RELATIONSHIPS_NAMESPACES.has(namespace)) relationshipPrefixes.add(name);
      else if (namespace === OFFICE_NAMESPACE) officePrefixes.add(name);
    }
  }
  return xml.replace(TAG, tag => tag.startsWith('<!') ? tag : tag.replace(ATTRIBUTE,
    (attribute, space: string, prefix: string | undefined, name: string, equals: string, double: string | undefined, single: string | undefined) => {
      const id = ids.get(xmlAttributeValue(double ?? single!));
      const namesOne = prefix !== undefined && (relationshipPrefixes.has(prefix) || officePrefixes.has(prefix) && name === 'relid');
      if (id === undefined || !namesOne) return attribute;
      const quote = double === undefined ? "'" : '"';
      return space + prefix + ':' + name + equals + quote + id + quote;
    }));
}

/** A relationships part */
const relsXml = (relationships: Relationship[]) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  relationships.map(r => '<Relationship Id="' + escapeXmlAttribute(r.id) + '" Type="' + escapeXmlAttribute(r.type) + '" Target="' + escapeXmlAttribute(r.target) + '"' +
    (r.external ? ' TargetMode="External"' : '') + '/>').join('') + '</Relationships>';

/** A comment, CDATA section, processing instruction or declaration, an end
 *  tag, or a start tag, by its name, attributes and whether it's empty. An
 *  instruction ends at ?>, as what it holds can look like markup */
const NODE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![\s\S]*?>|<\/([^\s>]+)\s*>|<([^\s!?/>][^\s/>]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

/**
 * The sectPrs that are a section's own, in order, as Word reads the body: a
 * paragraph's and the body's, but not one a tracked change to one holds,
 * nor one in a branch of markup compatibility's alternatives Word doesn't
 * read (see chosenBranch), or in an element Word ignores with all it holds
 * (see isIgnored), as the compatibility check reads them. Each comes with
 * the context around it (see Context): what its ancestors, as the document
 * element, the body and its paragraph, declare, and markup compatibility's
 * settings they make. Known by namespace, whatever their prefix.
 */
function sectPrsOf(documentXml: string): Array<{ xml: string; around: Context }> {
  const sectPrs: Array<{ xml: string; around: Context }> = [];
  // Each open element: the context in it, whether it's a sectPr, whether
  // Word reads it, and, of alternatives, whether Word reads one of their
  // branches already
  type Open = { context: Context; isSectPr: boolean; read: boolean; alternatives?: { chosen: boolean } };
  const open: Open[] = [{ context: { scope: new Map(), compatibility: NO_COMPATIBILITY }, isSectPr: false, read: true }];
  let depth = 0, start = 0, around = open[0].context;
  for (const m of documentXml.matchAll(NODE)) {
    const [whole, end, name, attributes, empty] = m;
    if (end !== undefined) {
      const closed = open.length > 1 ? open.pop()! : undefined;
      if (closed?.isSectPr && depth > 0 && --depth === 0) sectPrs.push({ xml: documentXml.slice(start, m.index! + whole.length), around });
      continue;
    }
    if (name === undefined) continue;
    const parent = open[open.length - 1];
    // Nothing in what Word doesn't read is read
    if (!parent.read) {
      if (!empty) open.push({ ...parent, isSectPr: false, alternatives: undefined });
      continue;
    }
    // Only a start tag that declares something or says how to read it
    // changes the context, which the tag alone, parsed, gives; and only a
    // choice's, or that of an element of a namespace Word doesn't
    // understand, says whether Word reads it
    const parsed = () => parseOrdered('<' + name + attributes + '/>', parent.context.scope)?.[0];
    let tag = /xmlns|Ignorable|ProcessContent/.test(attributes) ? parsed() : undefined;
    const context = tag ? contextIn(tag, parent.context) : parent.context;
    const { namespace, local } = expandName(name, context.scope);
    const isCompatibility = (element: string) => namespace === MARKUP_COMPATIBILITY && local === element;
    let read = true;
    if (parent.alternatives) {
      // Of alternatives, the first choice Word reads, or else the fallback
      read = !parent.alternatives.chosen && (isCompatibility('Choice') ? (tag ??= parsed()) !== undefined && readsChoice(tag, parent.context.scope) : isCompatibility('Fallback'));
      if (read) parent.alternatives.chosen = true;
    } else if (namespace !== undefined && !WORD_UNDERSTOOD_NAMESPACES.has(namespace)) {
      tag ??= parsed();
      read = tag === undefined || !isIgnored(tag, parent.context.scope, parent.context.compatibility);
    }
    const isSectPr = read && local === 'sectPr' && WORDPROCESSINGML.has(namespace ?? '');
    if (isSectPr && depth === 0) {
      around = parent.context;
      if (empty) sectPrs.push({ xml: whole, around });
      else start = m.index!;
    }
    if (empty) continue;
    if (isSectPr) depth++;
    open.push({ context, isSectPr, read, ...(read && isCompatibility('AlternateContent') ? { alternatives: { chosen: false } } : {}) });
  }
  return sectPrs;
}

/** The properties a part's DOCPROPERTY fields name, simple fields' and
 *  those whose code runs hold, in pieces, between begin and separate, each
 *  code with its references read as an XML parser reads them (see
 *  xmlAttributeValue and xmlTextValue) */
function docPropertyNames(xml: string): string[] {
  const codes: string[] = [];
  for (const m of xml.matchAll(/<w:fldSimple\b[^>]*?\sw:instr\s*=\s*(["'])([\s\S]*?)\1/g)) codes.push(xmlAttributeValue(m[2]));
  const open: Array<{ code: string; done: boolean }> = [];
  for (const m of xml.matchAll(/<w:fldChar\b[^>]*?\sw:fldCharType\s*=\s*["'](begin|separate|end)["']|<w:instrText\b[^>]*>([^<]*)<\/w:instrText\s*>/g)) {
    const field = open[open.length - 1];
    if (m[1] === 'begin') {
      open.push({ code: '', done: false });
    } else if (m[1] === undefined) {
      if (field && !field.done) field.code += xmlTextValue(m[2]);
    } else if (field) {
      // A field's code ends at its separator, or at its end without one
      if (!field.done) codes.push(field.code);
      field.done = true;
      if (m[1] === 'end') open.pop();
    }
  }
  return codes.flatMap(code => {
    const name = /^\s*DOCPROPERTY\s+(?:"([^"]*)"|(\S+))/i.exec(code);
    return name ? [name[1] ?? name[2]] : [];
  });
}

/** A reference to a comment or a note, which the template's other parts hold */
const COMMENT_OR_NOTE = /<w:(commentRangeStart|commentRangeEnd|commentReference|footnoteReference|endnoteReference)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:\1\s*>)/g;

/** A part's XML with each drawing's ID (wp:docPr's id) from `next` on, as
 *  `next` gives them, each tag read as an XML parser reads it (see
 *  xmlStartTags), and each ID by its value, however it's written (see
 *  xmlInteger), so that one written +1 takes a new one too */
function withDocPrIds(xml: string, next: () => number): string {
  let out = '';
  let at = 0;
  for (const { tag, start, end } of xmlStartTags(xml, ['wp:docPr'])) {
    if (xmlInteger(xmlAttribute(tag, 'id')) === undefined) continue;
    out += xml.slice(at, start) + withXmlAttribute(tag, 'id', String(next()));
    at = end;
  }
  return out + xml.slice(at);
}


// The section properties export gives sections of its own, which the
// template's trailing sectPr goes without
const TAKEN_PROPERTIES: ReadonlySet<string> = new Set(['headerReference', 'footerReference', 'titlePg', 'pgNumType']);

/** The children of a WordprocessingML element in a sectPr, in `scope`,
 *  without text but whitespace: CT_SectPr, and each of WordprocessingML's
 *  elements it holds, holds elements alone, with whitespace between them
 *  (XML 1.0 §3.2.1), so other text, as a CDATA section's, which the parser
 *  reads as text, is no property and goes. Each of WordprocessingML's
 *  elements among them likewise; another namespace's, as an extension's,
 *  whose content the schema doesn't give, stays as it is */
function elementsOnly(nodes: XmlNode[], scope: Scope): XmlNode[] {
  return nodes.filter(node => isElement(node) || !('#text' in node) || /^[ \t\r\n]*$/.test(String(node['#text']))).map(node => {
    if (!isElement(node)) return node;
    const inner = scopeIn(node, scope), name = nameOf(node);
    return WORDPROCESSINGML.has(expandName(name, inner).namespace ?? '') ? { ...node, [name]: elementsOnly(childrenOf(node), inner) } : node;
  });
}

/** A template's headers and footers, the parts they name, and its trailing
 *  sectPr, and the parts its numbering names */
/** The custom property, in chunks from 1, in which export records the
 *  layout it wrote in the last section and the template's own last
 *  section's, where it changed that for the document's sake (see
 *  templateLayoutRecord), which a later export that takes the document as
 *  its template puts back */
export const TEMPLATE_LAYOUT_PROPERTY = 'MANUSCRIPT_TEMPLATE_LAYOUT_';
/** A layout property, its name, as export wrote it, and as the template
 *  had it, each as XML in export's document, or '' for none */
export type LayoutEntry = [property: string, written: string, template: string];
// A section's layout, which export changes in the template's own last
// section: its break type, a new page after a break; its page, which a
// final fence turns; and its columns, which it fits to that page
const LAYOUT_PROPERTIES = ['type', 'pgSz', 'cols'];

/** Each of a sectPr's layout properties as Word reads it, in export's
 *  document (see effectiveSectPr), as XML with what it uses there of the
 *  sectPr (see moved), or '' where it hasn't one */
function layoutOf(sectPr: XmlNode): Map<string, string> {
  const inside = contextIn(sectPr, EXPORT_CONTEXT);
  return new Map(LAYOUT_PROPERTIES.map(property => {
    const node = childrenOf(sectPr).find(child => sectPrPropertyOf(child, inside.scope) === property);
    return [property, node ? buildOrdered([moved(node, inside, EXPORT_CONTEXT)]) : ''];
  }));
}

// Attributes of layout properties whose value is the default, which a
// property says as well by leaving it out (ECMA-376 Part 1 §17.6.4,
// §17.6.13 and §17.6.22, and [MS-OI29500] Part 1 Section 17.6.4, b, for
// w:equalWidth, and Section 17.6.3 for a column's w:space), and on-off
// attributes, which say on and off in more ways
const LAYOUT_DEFAULTS: Record<string, Record<string, string>> = {
  pgSz: { orient: 'portrait' }, cols: { num: '1', space: '720', equalWidth: '1', sep: '0' }, col: { space: '0' }, type: { val: 'nextPage' },
};
const ON_OFF_ATTRIBUTES = new Set(['equalWidth', 'sep']);
// Layout properties a section says as well by leaving them out: a new
// page for its break, and one column (ECMA-376 Part 1 §17.6.22 and
// §17.6.4). A page it leaves out has no size of its own, which isn't one
const LAYOUT_ELEMENT_DEFAULTS: Record<string, string> = { type: '<w:type/>', cols: '<w:cols/>' };

/** What a layout property, as XML in export's document (see layoutOf), or
 *  '' where a section hasn't one, says, alike for two that say the same
 *  however they write it: in any order of attributes, under any prefix,
 *  with what says the default left out, an element too, a measure in twips,
 *  in whatever unit it's given, a number as its value, and an on-off value
 *  as on or off (see xmlOn), and with what Word ignores of columns left
 *  out; each element by its expanded name, and its elements, as a column,
 *  in order */
function layoutKey(property: string, xml: string): string {
  const node = parseOrdered(xml || (LAYOUT_ELEMENT_DEFAULTS[property] ?? ''))?.find(isElement);
  if (!node) return xml;
  // An element's, and of the last of columns of their own widths, `isLast`,
  // without the space after it, which Word ignores, as fitColumns does
  const key = (element: XmlNode, scope: Scope, isLast = false): unknown[] => {
    const property = sectPrPropertyOf(element, scope), defaults = LAYOUT_DEFAULTS[property] ?? {};
    let attributes = attributesOf(element, scope).filter(attribute => attribute.namespace !== MARKUP_COMPATIBILITY).flatMap(({ namespace, local, value }) => {
      const wml = namespace !== undefined && WORDPROCESSINGML.has(namespace);
      let said = value.trim();
      if (wml && ON_OFF_ATTRIBUTES.has(local)) said = xmlOn(said) ? '1' : '0';
      else if (xmlTwips(said) !== undefined) said = String(xmlTwips(said));
      return wml && (defaults[local] === said || isLast && local === 'space') ? [] : [(wml ? '' : namespace ?? '') + ' ' + local + '=' + said];
    }).sort();
    const inner = scopeIn(element, scope);
    let children = childrenOf(element).filter(isElement);
    // Of columns, what Word reads (see fitColumns in md-to-docx.ts): each
    // w:col's width and space where w:equalWidth is off and there are any,
    // but the space after the last, and not w:num and w:space, and else
    // those, and not the w:col
    const isColumn = (child: XmlNode) => sectPrPropertyOf(child, inner) === 'col';
    let last = -1;
    if (property === 'cols') {
      if (attributes.includes(' equalWidth=0') && children.some(isColumn)) {
        attributes = attributes.filter(attribute => !/^ (?:num|space)=/.test(attribute));
        last = children.map(isColumn).lastIndexOf(true);
      } else children = children.filter(child => !isColumn(child));
    }
    return [expandedNameOf(element, scope), attributes, children.map((child, i) => key(child, inner, i === last))];
  };
  return JSON.stringify(key(node, EXPORT_NAMESPACES));
}
/** Whether two of a section's layout property, as XML, say the same (see
 *  layoutKey) */
const sameLayout = (property: string, one: string, other: string) => layoutKey(property, one) === layoutKey(property, other);

/** Where export changed the layout of the template's own last section,
 *  `templateSectPr`, in what it wrote in the last section, `written`, both
 *  sectPrs in its document, each layout property as it wrote it and as the
 *  template had it, every one, changed or not, so that a change since to
 *  any stops the template's being put back (see withTemplateLayout); or
 *  none where it changed none */
export function templateLayoutRecord(templateSectPr: string, written: string): LayoutEntry[] {
  const [template, wrote] = [templateSectPr, written].map(xml => {
    const sectPr = parseOrdered(xml)?.find(isElement);
    return sectPr && layoutOf(effectiveSectPr(sectPr, EXPORT_CONTEXT));
  });
  if (!template || !wrote || LAYOUT_PROPERTIES.every(property => sameLayout(property, template.get(property)!, wrote.get(property)!))) return [];
  return LAYOUT_PROPERTIES.map(property => [property, wrote.get(property)!, template.get(property)!]);
}

/** The layout a template's custom properties record (see
 *  TEMPLATE_LAYOUT_PROPERTY), none where they record none, or what they
 *  record isn't such, each layout property once */
function recordedLayout(properties: Record<string, string>[]): LayoutEntry[] {
  const chunks = new Map<number, string>();
  for (const property of properties) {
    const name = property['@_name'];
    const type = Object.keys(property).find(key => !key.startsWith('@_') && key !== '#text');
    const value = type && property[type];
    const n = typeof name === 'string' && name.startsWith(TEMPLATE_LAYOUT_PROPERTY) ? Number(name.slice(TEMPLATE_LAYOUT_PROPERTY.length)) : NaN;
    if (Number.isInteger(n) && n >= 1 && typeof value === 'string') chunks.set(n, value);
  }
  if (chunks.size === 0) return [];
  let json = '';
  for (let n = 1; chunks.has(n); n++) json += chunks.get(n);
  try {
    const record: unknown = JSON.parse(json);
    return Array.isArray(record) && record.length === LAYOUT_PROPERTIES.length
      && record.every(entry => Array.isArray(entry) && entry.length === 3 && entry.every(part => typeof part === 'string'))
      && LAYOUT_PROPERTIES.every(property => record.some(entry => entry[0] === property))
      ? record as LayoutEntry[] : [];
  } catch {
    return [];
  }
}

/** A trailing sectPr, as Word reads it in export's document, with the
 *  layout export recorded as the template's own in place of what it wrote,
 *  where the sectPr still says what it wrote, every layout property of it,
 *  however it writes it (see layoutKey), as after a rewrite of its XML */
function withTemplateLayout(sectPr: XmlNode, record: LayoutEntry[]): XmlNode {
  const layout = layoutOf(sectPr);
  if (record.length === 0 || record.some(([property, written]) => !sameLayout(property, layout.get(property)!, written))) return sectPr;
  const changes = record.filter(([property, written, template]) => !sameLayout(property, written, template));
  const inside = contextIn(sectPr, EXPORT_CONTEXT), changed = new Set(changes.map(([property]) => property));
  const kept = { ...sectPr, [nameOf(sectPr)]: childrenOf(sectPr).filter(child => !changed.has(sectPrPropertyOf(child, inside.scope))) };
  return withProperties(kept, EXPORT_CONTEXT, changes.flatMap(([, , template]) => template ? parseOrdered(template) ?? [] : []), EXPORT_CONTEXT);
}

export async function readTemplateSections(zip: JSZip): Promise<TemplateSections> {
  const result: TemplateSections = { references: '', titlePg: false, pgNumType: { first: '', others: '' }, evenAndOddHeaders: false, relationships: [], parts: new Map(), numIds: new Set(), customProperties: [] };
  const shownProperties = new Set<string>();
  const read = async (path: string) => {
    const file = zip.file(path);
    return file ? decodeXml(await file.async('uint8array')) : undefined;
  };
  const types = await read('[Content_Types].xml');
  const overrides = new Map<string, string>(), defaults = new Map<string, string>();
  for (const o of elementsOf(types, 'Types', 'Override')) {
    if (typeof o['@_PartName'] === 'string' && typeof o['@_ContentType'] === 'string') overrides.set(o['@_PartName'].replace(/^\//, '').toLowerCase(), o['@_ContentType']);
  }
  for (const d of elementsOf(types, 'Types', 'Default')) {
    if (typeof d['@_Extension'] === 'string' && typeof d['@_ContentType'] === 'string') defaults.set(d['@_Extension'].toLowerCase(), d['@_ContentType']);
  }

  /** Take a part, and the parts it names, for copying. Those only the
   *  numbering names go only with it. */
  const take = async (path: string, numberingOnly = false): Promise<void> => {
    if (result.parts.has(path)) return;
    const file = zip.file(path);
    if (!file) return;
    const override = overrides.get(path.toLowerCase());
    const part: TemplatePart = {
      data: await file.async('uint8array'),
      contentType: override ?? defaults.get(path.slice(path.lastIndexOf('.') + 1).toLowerCase()),
      byExtension: override === undefined,
      numberingOnly,
    };
    result.parts.set(path, part);
    if (/\.xml$/i.test(path) || /xml$/.test(part.contentType ?? '')) {
      part.xml = decodeXml(part.data);
      if (!numberingOnly) {
        // Each numId by its value, as import reads it (see xmlInteger), so
        // that one written +3 or with whitespace around it is in use
        for (const { tag } of xmlStartTags(part.xml, ['w:numId'])) {
          const numId = xmlInteger(xmlAttribute(tag, 'w:val'));
          if (numId !== undefined) result.numIds.add(numId);
        }
        for (const name of docPropertyNames(part.xml)) shownProperties.add(name.toLowerCase());
      }
    }
    part.rels = await relsOf(zip, path);
    for (const relationship of part.rels?.relationships ?? []) {
      if (relationship.path) await take(relationship.path, numberingOnly);
    }
  };

  const documentXml = await read('word/document.xml') ?? '';
  // The body's end tag, however it's written, and not one a comment, CDATA
  // section or processing instruction holds (see xmlLastMatch)
  const bodyClose = xmlLastMatch(documentXml, /<\/w:body\s*>/)?.index;
  const sectPrs = sectPrsOf(bodyClose === undefined ? documentXml : documentXml.slice(0, bodyClose)).map(({ xml, around }) => {
    // None that breaks Namespaces in XML where it is, which Word refuses
    const node = parseOrdered(xml, around.scope)?.find(isElement);
    return node && { node, around };
  });
  const last = sectPrs[sectPrs.length - 1];
  if (last) {
    const documentRels = new Map(relationshipsOf('word/document.xml', await read('word/_rels/document.xml.rels')).map(r => [r.id, r]));
    /** A template relationship's ID among document.xml's, or none if it names
     *  nothing, or something other than a part of `type` */
    const ids = new Map<string, string>();
    const idFor = async (templateId: string | undefined, type?: string): Promise<string | undefined> => {
      const relationship = templateId === undefined ? undefined : documentRels.get(templateId);
      if (!relationship || relationship.path !== undefined && !zip.file(relationship.path)) return undefined;
      if (type && !relationship.type.endsWith('/' + type)) return undefined;
      if (ids.has(relationship.id)) return ids.get(relationship.id);
      if (relationship.path) await take(relationship.path);
      result.relationships.push({ type: relationship.type, target: relationship.path ?? relationship.target, external: relationship.external });
      const id = 'rId' + result.relationships.length;
      ids.set(relationship.id, id);
      return id;
    };
    const builder = xmlBuilder(ORDERED_OPTIONS);

    // Each sectPr's properties as Word reads them, under export's prefixes
    // (see effectiveSectPr), which the references, title page and page
    // numbering come from, each moved out of it into export's document,
    // with what it uses there of the template's declarations and markup
    // compatibility's settings
    const properties = sectPrs.map(sectPr => {
      if (!sectPr) return [];
      const effective = effectiveSectPr(sectPr.node, sectPr.around), inside = contextIn(effective, EXPORT_CONTEXT);
      return childrenOf(effective).filter(isElement).map(node => ({ name: sectPrPropertyOf(node, inside.scope), node: moved(node, inside, EXPORT_CONTEXT) }));
    });
    const named = (sectPr: Array<{ name: string; node: XmlNode }> | undefined, name: string) => sectPr?.find(property => property.name === name)?.node;
    const attribute = (node: XmlNode, namespaces: string | ReadonlySet<string>, local: string) =>
      attributesOf(node, EXPORT_NAMESPACES).find(name => name.local === local && (typeof namespaces === 'string' ? name.namespace === namespaces : namespaces.has(name.namespace ?? '')));

    // Each type of reference as the last section shows it
    const references = new Map<string, { name: string; node: XmlNode }>();
    for (const sectPr of properties) {
      for (const property of sectPr) {
        if (property.name === 'headerReference' || property.name === 'footerReference') references.set(property.name + ':' + (attribute(property.node, WORDPROCESSINGML, 'type')?.value ?? 'default'), property);
      }
    }
    for (const { name, node } of references.values()) {
      const templateId = attribute(node, RELATIONSHIPS_NAMESPACES, 'id');
      const id = await idFor(templateId?.value, name === 'headerReference' ? 'header' : 'footer');
      if (id) result.references += buildOrdered([{ [nameOf(node)]: [], ':@': { ...node[':@'], [templateId!.key]: id } }]);
    }
    const titlePg = named(properties[0], 'titlePg');
    result.titlePg = !!titlePg && isOn(attribute(titlePg, WORDPROCESSINGML, 'val')?.value);

    // The page number format of the last section, as its numerals, which
    // each section export writes takes, and the start, which only the first
    // takes, so that the pages count on through the sections export adds.
    // The start is the first section's, whose first page is the document's,
    // as a previous export writes it, or else the last's.
    // Export's document writes WordprocessingML's attributes under w:, as
    // the template's are, read under export's prefixes
    const pageNumbersOf = (sectPr: Array<{ name: string; node: XmlNode }> | undefined) => named(sectPr, 'pgNumType')?.[':@'];
    const { '@_w:start': lastStart, ...format } = pageNumbersOf(properties[properties.length - 1]) ?? {};
    const start = pageNumbersOf(properties[0])?.['@_w:start'] ?? lastStart;
    const pgNumType = (attributes: Record<string, string>) => Object.keys(attributes).length === 0 ? '' : builder.build([{ 'w:pgNumType': [], ':@': attributes }]) as string;
    // Its attributes in the schema's order, which Word writes: fmt, start, chapStyle, chapSep
    result.pgNumType = {
      first: pgNumType({ ...(format['@_w:fmt'] === undefined ? {} : { '@_w:fmt': format['@_w:fmt'] }), ...(start === undefined ? {} : { '@_w:start': start }), ...format }),
      others: pgNumType(format),
    };

    // The trailing sectPr, whose other relationships, as its printer
    // settings', get their IDs, or go with what names them. So do those in
    // a tracked change's old properties, w:sectPrChange, which can name
    // printer settings too, and which kept the template's IDs, naming
    // another of the document's parts or none
    const withIds = async (nodes: XmlNode[]): Promise<XmlNode[]> => {
      const kept: XmlNode[] = [];
      for (const node of nodes) {
        const name = nameOf(node);
        const templateId = node[':@']?.['@_r:id'];
        const id = templateId === undefined ? undefined : await idFor(templateId);
        if (templateId !== undefined && !id) continue;
        const children = node[name];
        kept.push({ ...node, ...(Array.isArray(children) ? { [name]: await withIds(children as XmlNode[]) } : {}), ...(id ? { ':@': { ...node[':@'], '@_r:id': id } } : {}) });
      }
      return kept;
    };
    // The trailing sectPr as Word reads it, as Word writes it on save,
    // with the layout export recorded as the template's, where it changed
    // it, and without what export gives sections of their own, or text,
    // which it can't hold (see elementsOnly)
    const trailing = withTemplateLayout(effectiveSectPr(last.node, last.around), recordedLayout(elementsOf(await read('docProps/custom.xml'), 'Properties', 'property')));
    const inside = contextIn(trailing, EXPORT_CONTEXT);
    const own = elementsOnly(childrenOf(trailing), inside.scope).filter(node => !TAKEN_PROPERTIES.has(sectPrPropertyOf(node, inside.scope)));
    result.sectPr = buildOrdered([{ ...trailing, [nameOf(trailing)]: await withIds(own) }]);
  }

  // What the numbering names, as a picture bullet's image, after the
  // sections' parts, which some of it can be too
  result.numberingRels = await relsOf(zip, 'word/numbering.xml');
  for (const relationship of result.numberingRels?.relationships ?? []) {
    if (relationship.path) await take(relationship.path, true);
  }

  // A property a field shows, which the template, not export, holds
  for (const property of elementsOf(await read('docProps/custom.xml'), 'Properties', 'property')) {
    const name = property['@_name'];
    const type = Object.keys(property).find(key => !key.startsWith('@_') && key !== '#text');
    const value = type && property[type];
    if (typeof name === 'string' && shownProperties.has(name.toLowerCase()) && typeof value === 'string') result.customProperties.push({ name, type: type!, value });
  }

  const [evenAndOdd] = elementsOf(await read('word/settings.xml'), 'settings', 'evenAndOddHeaders');
  result.evenAndOddHeaders = evenAndOdd !== undefined && isOn(evenAndOdd['@_val']);
  return result;
}

/** A sectPr export writes, in its document, with `element`, one or more
 *  section properties, among its own children in CT_SectPr's order (see
 *  withProperties), in place of any of their names. Elements and
 *  attributes are known by their namespaces, whatever their prefixes. */
function withChild(sectPr: string, element: string): string {
  const parsed = element ? parseOrdered(sectPr)?.find(isElement) : undefined;
  const added = parsed && parseOrdered(element);
  if (!parsed || !added || !isNamed(parsed, EXPORT_NAMESPACES, WORDPROCESSINGML, 'sectPr')) return sectPr;
  return buildOrdered([withProperties(parsed, EXPORT_CONTEXT, added, EXPORT_CONTEXT)]);
}

/**
 * A sectPr export writes, with the template's page number format, and, if
 * it is the document's first section, the start of its page numbers, its
 * header and footer references and its title page setting. The sections
 * after the first take its headers and footers and count its pages on.
 */
export function withTemplateSection(sectPr: string, sections: TemplateSections, first: boolean): string {
  sectPr = withChild(sectPr, first ? sections.pgNumType.first : sections.pgNumType.others);
  if (!first) return sectPr;
  sectPr = withChild(sectPr, sections.references);
  return sections.titlePg ? withChild(sectPr, '<w:titlePg/>') : sectPr;
}

/**
 * Copy the parts a template's sections name into the export, and, if the
 * export's numbering is the template's, the parts that names, each at its
 * template path or, where export has a part there, as its images, the next
 * free name like it. A drawing's ID, which the document's drawings share,
 * continues from `nextDocPrId`. Returns document.xml's relationships, with
 * targets from it, and the content types the parts need, the extensions'
 * where the export types none of them otherwise.
 */
export function addTemplateSectionParts(
  zip: JSZip,
  sections: TemplateSections,
  nextDocPrId: number,
  extensionTypes: Map<string, string>,
  templateNumbering: boolean,
): { relationships: TemplateRelationship[]; defaults: Map<string, string>; overrides: Map<string, string> } {
  const paths = new Map<string, string>();
  const taken = (path: string) => zip.file(path) !== null || [...paths.values()].includes(path);
  const parts = [...sections.parts].filter(([, part]) => templateNumbering || !part.numberingOnly);
  for (const [path] of parts) {
    let free = path;
    const m = /^(.*?)(\d*)(\.[^./]*)?$/.exec(path)!;
    for (let n = m[2] ? parseInt(m[2], 10) : 1; taken(free); n++) free = m[1] + n + (m[3] ?? '');
    paths.set(path, free);
  }
  /** A part's relationships, at its path in the export, their targets the
   *  parts' there, and their IDs, if `ids` gives new ones, in its order */
  const addRels = (target: string, rels: Rels, ids: Map<string, string> | undefined) => {
    const moved = (r: Relationship) => r.path === undefined || !paths.has(r.path) || paths.get(r.path) === r.path ? undefined : paths.get(r.path);
    if (!ids && !rels.relationships.some(moved)) {
      zip.file(relsPathOf(target), rels.data);
      return;
    }
    const relationships = rels.relationships.map(r => ({ ...r, id: ids?.get(r.id) ?? r.id, target: moved(r) ? relativeTarget(target, moved(r)!) : r.target }));
    if (ids) relationships.sort((a, b) => parseInt(a.id.slice(3), 10) - parseInt(b.id.slice(3), 10));
    zip.file(relsPathOf(target), relsXml(relationships));
  };
  const defaults = new Map<string, string>(), overrides = new Map<string, string>();
  for (const [path, part] of parts) {
    const target = paths.get(path)!;
    // New IDs for its relationships, which only an XML part, whose
    // references to them export rewrites, takes
    const ids = part.xml === undefined ? undefined : part.rels?.ids;
    const xml = part.xml === undefined ? undefined
      : withDocPrIds(withRelationshipIds(part.xml, ids).replace(COMMENT_OR_NOTE, ''), () => nextDocPrId++);
    zip.file(target, xml !== undefined && xml !== part.xml ? asUtf8(xml) : part.data);
    if (part.rels) addRels(target, part.rels, ids);
    if (!part.contentType) continue;
    const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
    const known = extensionTypes.get(ext) ?? defaults.get(ext);
    if (part.byExtension && (known === undefined || known === part.contentType)) {
      if (known === undefined) defaults.set(ext, part.contentType);
    } else {
      overrides.set(target, part.contentType);
    }
  }
  // The numbering's references to its relationships take their new IDs in
  // md-to-docx.ts, which writes it
  if (templateNumbering && sections.numberingRels) addRels('word/numbering.xml', sections.numberingRels, sections.numberingRels.ids);
  const relationships = sections.relationships.map(r => r.external ? r : { ...r, target: relativeTarget('word/document.xml', paths.get(r.target) ?? r.target) });
  return { relationships, defaults, overrides };
}
