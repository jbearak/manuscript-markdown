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
// - A reference goes if the template lacks its relationship or part, or
//   its relationship is of another type. Kept, it would name nothing, or a
//   part export writes for something else.
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
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

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

type XmlNode = Record<string, unknown> & { ':@'?: Record<string, string> };

/** An element in order, its attributes as written, which the builder writes back */
const ORDERED_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  suppressEmptyNode: true,
};

/** A package part (relationships, content types, settings, custom
 *  properties) as data, its prefixes dropped, its text as it is, with
 *  its character references, as &#x2019;, read too */
const partParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: true,
});

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

const nameOf = (node: XmlNode) => Object.keys(node).find(key => key !== ':@')!;
const childrenOf = (node: XmlNode) => node[nameOf(node)] as XmlNode[];

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

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A part's relationships part, if it has one */
async function relsOf(zip: JSZip, path: string): Promise<Rels | undefined> {
  const data = await zip.file(relsPathOf(path))?.async('uint8array');
  if (!data) return undefined;
  const relationships = relationshipsOf(path, decodeXml(data));
  return { data, relationships, ids: sequentialIds(relationships) };
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
      const namespace = prefix === 'xmlns' ? decodeEntities(double ?? single) : undefined;
      if (namespace !== undefined && RELATIONSHIPS_NAMESPACES.has(namespace)) relationshipPrefixes.add(name);
      else if (namespace === OFFICE_NAMESPACE) officePrefixes.add(name);
    }
  }
  return xml.replace(TAG, tag => tag.startsWith('<!') ? tag : tag.replace(ATTRIBUTE,
    (attribute, space: string, prefix: string | undefined, name: string, equals: string, double: string | undefined, single: string | undefined) => {
      const id = ids.get(decodeEntities(double ?? single!));
      const namesOne = prefix !== undefined && (relationshipPrefixes.has(prefix) || officePrefixes.has(prefix) && name === 'relid');
      if (id === undefined || !namesOne) return attribute;
      const quote = double === undefined ? "'" : '"';
      return space + prefix + ':' + name + equals + quote + id + quote;
    }));
}

/** A relationships part */
const relsXml = (relationships: Relationship[]) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  relationships.map(r => '<Relationship Id="' + escapeAttr(r.id) + '" Type="' + escapeAttr(r.type) + '" Target="' + escapeAttr(r.target) + '"' +
    (r.external ? ' TargetMode="External"' : '') + '/>').join('') + '</Relationships>';

/** The sectPrs that are a section's own, in order: a paragraph's and the
 *  body's, but not the one a tracked change to one holds */
function sectPrsOf(documentXml: string): string[] {
  const sectPrs: string[] = [];
  let depth = 0, start = 0;
  for (const m of documentXml.matchAll(/<w:sectPr(?=[\s>/])[^>]*?(\/?)>|<\/w:sectPr\s*>/g)) {
    if (m[0].startsWith('</')) {
      if (depth > 0 && --depth === 0) sectPrs.push(documentXml.slice(start, m.index! + m[0].length));
    } else if (m[1]) {
      if (depth === 0) sectPrs.push(m[0]);
    } else if (depth++ === 0) {
      start = m.index!;
    }
  }
  return sectPrs;
}

/** A sectPr's element, parsed */
function parseSectPr(xml: string): XmlNode | undefined {
  try {
    return (new XMLParser(ORDERED_OPTIONS).parse(xml) as XmlNode[]).find(node => nameOf(node) === 'w:sectPr');
  } catch {
    return undefined;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);|&#(x[0-9a-f]+|\d+);/gi,
  (_, name: string | undefined, code: string | undefined) => name ? ENTITIES[name.toLowerCase()] : String.fromCodePoint(code![0] === 'x' || code![0] === 'X' ? parseInt(code!.slice(1), 16) : parseInt(code!, 10)));

/** The properties a part's DOCPROPERTY fields name, simple fields' and
 *  those whose code runs hold, in pieces, between begin and separate */
function docPropertyNames(xml: string): string[] {
  const codes: string[] = [];
  for (const m of xml.matchAll(/<w:fldSimple\b[^>]*?\sw:instr\s*=\s*(["'])([\s\S]*?)\1/g)) codes.push(decodeEntities(m[2]));
  const open: Array<{ code: string; done: boolean }> = [];
  for (const m of xml.matchAll(/<w:fldChar\b[^>]*?\sw:fldCharType\s*=\s*["'](begin|separate|end)["']|<w:instrText\b[^>]*>([^<]*)<\/w:instrText\s*>/g)) {
    const field = open[open.length - 1];
    if (m[1] === 'begin') {
      open.push({ code: '', done: false });
    } else if (m[1] === undefined) {
      if (field && !field.done) field.code += decodeEntities(m[2]);
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

const NUM_ID = /<w:numId\b[^>]*?\sw:val\s*=\s*(["'])(\d+)\1/g;
/** A reference to a comment or a note, which the template's other parts hold */
const COMMENT_OR_NOTE = /<w:(commentRangeStart|commentRangeEnd|commentReference|footnoteReference|endnoteReference)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:\1\s*>)/g;
const DOC_PR_ID = /(<wp:docPr\b[^>]*?\sid\s*=\s*)(["'])\d+\2/g;

/** A template's headers and footers, the parts they name, and its trailing
 *  sectPr, and the parts its numbering names */
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
        for (const m of part.xml.matchAll(NUM_ID)) result.numIds.add(parseInt(m[2], 10));
        for (const name of docPropertyNames(part.xml)) shownProperties.add(name.toLowerCase());
      }
    }
    part.rels = await relsOf(zip, path);
    for (const relationship of part.rels?.relationships ?? []) {
      if (relationship.path) await take(relationship.path, numberingOnly);
    }
  };

  const documentXml = await read('word/document.xml') ?? '';
  const bodyClose = documentXml.lastIndexOf('</w:body>');
  const sectPrs = sectPrsOf(bodyClose < 0 ? documentXml : documentXml.slice(0, bodyClose)).map(parseSectPr);
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
    const builder = new XMLBuilder(ORDERED_OPTIONS);

    // Each type of reference as the last section shows it
    const references = new Map<string, XmlNode>();
    for (const sectPr of sectPrs) {
      for (const node of sectPr ? childrenOf(sectPr) : []) {
        const name = nameOf(node);
        if (name === 'w:headerReference' || name === 'w:footerReference') references.set(name + ':' + (node[':@']?.['@_w:type'] ?? 'default'), node);
      }
    }
    for (const node of references.values()) {
      const name = nameOf(node);
      const id = await idFor(node[':@']?.['@_r:id'], name === 'w:headerReference' ? 'header' : 'footer');
      if (id) result.references += builder.build([{ [name]: [], ':@': { ...node[':@'], '@_r:id': id } }]);
    }
    result.titlePg = !!sectPrs[0] && childrenOf(sectPrs[0]).some(node => nameOf(node) === 'w:titlePg' && isOn(node[':@']?.['@_w:val']));

    // The page number format of the last section, as its numerals, which
    // each section export writes takes, and the start, which only the first
    // takes, so that the pages count on through the sections export adds.
    // The start is the first section's, whose first page is the document's,
    // as a previous export writes it, or else the last's.
    const pageNumbersOf = (sectPr: XmlNode | undefined) => sectPr && childrenOf(sectPr).find(node => nameOf(node) === 'w:pgNumType')?.[':@'];
    const { '@_w:start': lastStart, ...format } = pageNumbersOf(last) ?? {};
    const start = pageNumbersOf(sectPrs[0])?.['@_w:start'] ?? lastStart;
    const pgNumType = (attributes: Record<string, string>) => Object.keys(attributes).length === 0 ? '' : builder.build([{ 'w:pgNumType': [], ':@': attributes }]) as string;
    // Its attributes in the schema's order, which Word writes: fmt, start, chapStyle, chapSep
    result.pgNumType = {
      first: pgNumType({ ...(format['@_w:fmt'] === undefined ? {} : { '@_w:fmt': format['@_w:fmt'] }), ...(start === undefined ? {} : { '@_w:start': start }), ...format }),
      others: pgNumType(format),
    };

    // The trailing sectPr, whose other relationships, as its printer
    // settings', get their IDs, or go with what names them
    const kept: XmlNode[] = [];
    for (const node of childrenOf(last)) {
      const name = nameOf(node);
      if (name === 'w:headerReference' || name === 'w:footerReference' || name === 'w:titlePg' || name === 'w:pgNumType') continue;
      const templateId = node[':@']?.['@_r:id'];
      const id = templateId === undefined ? undefined : await idFor(templateId);
      if (templateId === undefined) kept.push(node);
      else if (id) kept.push({ ...node, ':@': { ...node[':@'], '@_r:id': id } });
    }
    result.sectPr = builder.build([{ 'w:sectPr': kept, ':@': last[':@'] }]) as string;
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

/** sectPr's children after pgNumType, which pgNumType goes before, in CT_SectPr's order (ECMA-376) */
const AFTER_PG_NUM_TYPE = /<w:(?:cols|formProt|vAlign|noEndnote|titlePg|textDirection|bidi|rtlGutter|docGrid|printerSettings|sectPrChange)(?=[\s/>])/;
/** sectPr's children after titlePg, which titlePg goes before */
const AFTER_TITLE_PG = /<w:(?:textDirection|bidi|rtlGutter|docGrid|printerSettings|sectPrChange)\b/;

/** A sectPr with `element` among its own children, before the first that
 *  `before` finds, or after them, and before a tracked change to them */
function withChild(sectPr: string, element: string, before: RegExp): string {
  const open = /^<w:sectPr\b[^>]*?(\/?)>/.exec(sectPr);
  if (!open || !element) return sectPr;
  const xml = open[1] ? open[0].slice(0, -2) + '>' + '</w:sectPr>' : sectPr;
  const start = open[1] ? open[0].length - 1 : open[0].length;
  const change = xml.indexOf('<w:sectPrChange', start);
  const own = xml.slice(start, change < 0 ? xml.lastIndexOf('</w:sectPr>') : change);
  const at = start + (before.exec(own)?.index ?? own.length);
  return xml.slice(0, at) + element + xml.slice(at);
}

/**
 * A sectPr export writes, with the template's page number format, and, if
 * it is the document's first section, the start of its page numbers, its
 * header and footer references and its title page setting. The sections
 * after the first take its headers and footers and count its pages on.
 */
export function withTemplateSection(sectPr: string, sections: TemplateSections, first: boolean): string {
  sectPr = withChild(sectPr, first ? sections.pgNumType.first : sections.pgNumType.others, AFTER_PG_NUM_TYPE);
  if (!first) return sectPr;
  sectPr = withChild(sectPr, sections.references, /^/);
  return sections.titlePg ? withChild(sectPr, '<w:titlePg/>', AFTER_TITLE_PG) : sectPr;
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
    const xml = part.xml === undefined ? undefined : withRelationshipIds(part.xml, ids)
      .replace(COMMENT_OR_NOTE, '').replace(DOC_PR_ID, (_, before: string, quote: string) => before + quote + (nextDocPrId++) + quote);
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
