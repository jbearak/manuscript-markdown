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
//   uses (see moved). The trailing sectPr, under export's prefixes (see
//   canonical), goes without them in every alternative and wrapper too
//   (see mapProperties), so the sections export adds have them, and the
//   last has each once, where each consumer reads it (see placed).
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
import { XMLParser } from 'fast-xml-parser';
import { XML_ENTITIES, xmlBuilder } from './xml-parser';
import { EXPORT_CONTEXT, EXPORT_NAMESPACES, MARKUP_COMPATIBILITY, NO_COMPATIBILITY, ORDERED_OPTIONS, WORD_UNDERSTOOD_NAMESPACES, WORDPROCESSINGML, attributeNamed, attributesOf, buildOrdered, canonical, childrenOf, contextIn, effectiveSectPr, expandName, isElement, isIgnored, isNamed, isProcessedWrapper, mapProperties, moved, nameOf, parseOrdered, readsChoice, scopeIn, sectPrPropertyOf, sectPrRank, type Context, type XmlNode } from './scoped-xml';
import { pushAll } from './arrays';

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
 *  its character references, as &#x2019;, read too */
const partParser = new XMLParser({
  processEntities: XML_ENTITIES,
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

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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


// The section properties export gives sections of its own, which the
// template's trailing sectPr goes without
const TAKEN_PROPERTIES: ReadonlySet<string> = new Set(['headerReference', 'footerReference', 'titlePg', 'pgNumType']);

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
  const sectPrs = sectPrsOf(bodyClose < 0 ? documentXml : documentXml.slice(0, bodyClose)).map(({ xml, around }) => {
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
    // The trailing sectPr, under export's prefixes, without what export
    // gives sections of their own, wherever a consumer reads it (see
    // mapProperties)
    const trailing = canonical(last.node, last.around);
    const own = mapProperties(childrenOf(trailing), contextIn(trailing, EXPORT_CONTEXT), (node, context) => TAKEN_PROPERTIES.has(sectPrPropertyOf(node, context.scope)) ? [] : [node]);
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

/**
 * A place among a sectPr's children that a property can go: before the
 * child at `index` of the children of the container that `at` leads to, a
 * path of child indexes from the sectPr's through wrappers whose content
 * Word reads as their parent's, and through markup compatibility's
 * alternatives and their choices and fallbacks; or, `fallback`, in a
 * fallback of their own of the alternatives at `at`, which have none.
 */
interface Slot { at: number[]; index: number; fallback: boolean }
const slotKey = (slot: Slot) => slot.at.join('/') + (slot.fallback ? '+' : ':' + slot.index);

const isAlternatives = (node: XmlNode, context: Context) => isNamed(node, context.scope, MARKUP_COMPATIBILITY, 'AlternateContent');
const isWrapper = (node: XmlNode, context: Context) => isProcessedWrapper(node, context.scope, context.compatibility);
/** A choice's or fallback's namespaces its Requires names, as they're bound
 *  there, none for a fallback, or none if it's neither */
function requiredBy(branch: XmlNode, context: Context): string[] | undefined {
  if (isNamed(branch, context.scope, MARKUP_COMPATIBILITY, 'Fallback')) return [];
  if (!isNamed(branch, context.scope, MARKUP_COMPATIBILITY, 'Choice')) return undefined;
  const inner = scopeIn(branch, context.scope);
  // A choice that requires nothing is none (ECMA-376 Part 3 §10.2.1)
  const prefixes = (attributeNamed(branch, context.scope, undefined, 'Requires') ?? '').split(/\s+/).filter(Boolean);
  return prefixes.length === 0 ? undefined : prefixes.map(prefix => inner.get(prefix) ?? 'unbound:' + prefix);
}

/** The namespaces the choices among a sectPr's children, `nodes`, in a
 *  context, require, at any depth of alternatives and wrappers */
function requiredIn(nodes: XmlNode[], context: Context, required = new Set<string>()): Set<string> {
  for (const node of nodes.filter(isElement)) {
    if (!isAlternatives(node, context) && !isWrapper(node, context)) continue;
    const inner = contextIn(node, context);
    for (const branch of isAlternatives(node, context) ? childrenOf(node).filter(isElement) : [node]) {
      if (branch !== node) for (const namespace of requiredBy(branch, inner) ?? []) required.add(namespace);
      requiredIn(childrenOf(branch), branch === node ? inner : contextIn(branch, inner), required);
    }
  }
  return required;
}

/** What a consumer reads of a sectPr's children, `nodes`, in a context, that
 *  understands the namespaces `understood`: each property's place in
 *  CT_SectPr's order (see sectPrRank), -1 for one it doesn't have, and each
 *  slot it sees, in order. Of markup compatibility's alternatives it reads
 *  the first choice whose Requires it understands, or else the fallback, or
 *  else nothing, where a fallback of their own would be */
type Reading = Array<{ rank: number } | { slot: Slot }>;
function readingOf(nodes: XmlNode[], context: Context, understood: ReadonlySet<string>, at: number[]): Reading {
  const reading: Reading = [];
  nodes.forEach((node, i) => {
    reading.push({ slot: { at, index: i, fallback: false } });
    if (!isElement(node)) return;
    if (isAlternatives(node, context)) {
      const inner = contextIn(node, context), branches = childrenOf(node);
      const chosen = branches.findIndex(branch => isElement(branch) && (requiredBy(branch, inner) ?? ['']).every(namespace => understood.has(namespace)));
      if (chosen === -1) reading.push({ slot: { at: [...at, i], index: -1, fallback: true } });
      else pushAll(reading, readingOf(childrenOf(branches[chosen]), contextIn(branches[chosen], inner), understood, [...at, i, chosen]));
    } else if (isWrapper(node, context)) {
      pushAll(reading, readingOf(childrenOf(node), contextIn(node, context), understood, [...at, i]));
    } else {
      reading.push({ rank: sectPrRank(sectPrPropertyOf(node, context.scope)) });
    }
  });
  reading.push({ slot: { at, index: nodes.length, fallback: false } });
  return reading;
}

/** The slots in a reading where a property whose place in CT_SectPr's order
 *  is `rank` is in its place: after every property CT_SectPr puts before it
 *  or with it, and before every one it puts after it; or, where the
 *  properties are out of that order, before the first it puts after it */
function placesIn(reading: Reading, rank: number): Set<string> {
  const ranks = reading.map(entry => 'rank' in entry ? entry.rank : -1);
  const places = new Set<string>();
  reading.forEach((entry, p) => {
    if ('slot' in entry && ranks.slice(0, p).every(other => other <= rank) && ranks.slice(p + 1).every(other => other === -1 || other > rank)) places.add(slotKey(entry.slot));
  });
  if (places.size > 0) return places;
  const first = ranks.findIndex(other => other > rank);
  const end = first === -1 ? reading.length : first;
  let start = end - 1;
  while (start >= 0 && ranks[start] === -1) start--;
  for (let p = start + 1; p < end; p++) {
    const entry = reading[p];
    if ('slot' in entry) places.add(slotKey(entry.slot));
  }
  return places;
}

/** The sets of a set's members, up to six of them, or else none and the
 *  members Word understands */
function readersOf(required: Set<string>): Array<Set<string>> {
  const members = [...required];
  if (members.length > 6) return [new Set(), new Set(members.filter(namespace => WORD_UNDERSTOOD_NAMESPACES.has(namespace)))];
  return Array.from({ length: 2 ** members.length }, (_, n) => new Set(members.filter((__, i) => n & (1 << i))));
}

/**
 * A sectPr's children, `nodes`, in a context, with `added`, section
 * properties read in export's document (see EXPORT_CONTEXT), whose place
 * in CT_SectPr's order is `rank`, where every consumer reads them in that
 * place, once: one that understands any of the namespaces their choices
 * require, whichever alternatives it reads, and Word too. A slot that every
 * consumer sees, among the sectPr's own children, is first, and else slots
 * in choices, fallbacks or wrappers, each that only consumers that read it
 * there see, and, where alternatives that hold properties on both sides of
 * that place have no fallback, one of their own, which a consumer that
 * understands none of their choices reads. Of slots alike, the last is
 * first, before the first property CT_SectPr puts after them. Where no
 * set of slots gives every consumer one, they go where Word reads them in
 * their place. Never within a tracked change's old properties,
 * w:sectPrChange, last. Each goes moved into its place (see moved).
 */
function placed(nodes: XmlNode[], context: Context, added: XmlNode[], rank: number): XmlNode[] {
  const required = requiredIn(nodes, context);
  const readers = readersOf(required);
  const readings = readers.map(understood => readingOf(nodes, context, understood, []));
  const places = readings.map(reading => placesIn(reading, rank));
  // Each slot with the consumers that see it, and where the first of them does
  const slots = new Map<string, { slot: Slot; readers: Set<number>; position: number }>();
  readings.forEach((reading, r) => reading.forEach((entry, position) => {
    if (!('slot' in entry)) return;
    const key = slotKey(entry.slot);
    const known = slots.get(key);
    if (known) known.readers.add(r);
    else slots.set(key, { slot: entry.slot, readers: new Set([r]), position });
  }));
  const candidates = [...slots.entries()].filter(([key, { readers: seen }]) => [...seen].every(r => places[r].has(key))).map(([, value]) => value)
    .sort((a, b) => b.readers.size - a.readers.size || a.slot.at.length - b.slot.at.length || Number(a.slot.fallback) - Number(b.slot.fallback) || b.position - a.position);
  const cover = (remaining: ReadonlySet<number>): Slot[] | undefined => {
    if (remaining.size === 0) return [];
    const reader = [...remaining].reduce((least, r) => Math.min(least, r), Infinity);
    for (const candidate of candidates) {
      if (!candidate.readers.has(reader) || [...candidate.readers].some(r => !remaining.has(r))) continue;
      const rest = cover(new Set([...remaining].filter(r => !candidate.readers.has(r))));
      if (rest) return [candidate.slot, ...rest];
    }
    return undefined;
  };
  let chosen = cover(new Set(readers.keys()));
  if (!chosen) {
    const word = readers.findIndex(understood => [...required].every(namespace => understood.has(namespace) === WORD_UNDERSTOOD_NAMESPACES.has(namespace)));
    const best = [...slots.values()].filter(({ slot }) => places[word].has(slotKey(slot)) && slots.get(slotKey(slot))!.readers.has(word))
      .sort((a, b) => a.slot.at.length - b.slot.at.length || Number(a.slot.fallback) - Number(b.slot.fallback) || b.position - a.position)[0];
    chosen = best ? [best.slot] : [];
  }
  return withAdded(nodes, context, [], chosen, added);
}

const startsWith = (path: number[], prefix: number[]) => prefix.every((index, i) => path[i] === index);
const samePath = (a: number[], b: number[]) => a.length === b.length && startsWith(a, b);

/** Children, `nodes`, of the container `at` leads to, in a context, with
 *  `added` in each of the slots given there, and in containers in them */
function withAdded(nodes: XmlNode[], context: Context, at: number[], slots: Slot[], added: XmlNode[]): XmlNode[] {
  const placedIn = (where: Context) => added.map(node => moved(node, EXPORT_CONTEXT, where));
  const result: XmlNode[] = [];
  nodes.forEach((node, i) => {
    if (slots.some(slot => !slot.fallback && samePath(slot.at, at) && slot.index === i)) pushAll(result, placedIn(context));
    const path = [...at, i];
    if (!isElement(node) || !slots.some(slot => startsWith(slot.at, path))) {
      result.push(node);
      return;
    }
    const inner = contextIn(node, context);
    if (!isAlternatives(node, context)) {
      result.push({ ...node, [nameOf(node)]: withAdded(childrenOf(node), inner, path, slots, added) });
      return;
    }
    const branches = childrenOf(node).map((branch, j) => slots.some(slot => startsWith(slot.at, [...path, j]))
      ? { ...branch, [nameOf(branch)]: withAdded(childrenOf(branch), contextIn(branch, inner), [...path, j], slots, added) } : branch);
    // A fallback of their own, under the prefix their name has
    const name = nameOf(node), prefix = name.slice(0, name.indexOf(':') + 1);
    const fallback = slots.some(slot => slot.fallback && samePath(slot.at, path)) ? [{ [prefix + 'Fallback']: placedIn(inner) }] : [];
    result.push({ ...node, [name]: [...branches, ...fallback] });
  });
  if (slots.some(slot => !slot.fallback && samePath(slot.at, at) && slot.index === nodes.length)) pushAll(result, placedIn(context));
  return result;
}

/** A sectPr export writes, in its document, with `element`, one or more
 *  section properties of the name `property`, among its own children in
 *  CT_SectPr's order (see placed). Elements and attributes are known by
 *  their namespaces, whatever their prefixes. */
function withChild(sectPr: string, element: string, property: string): string {
  const parsed = element ? parseOrdered(sectPr)?.find(isElement) : undefined;
  const added = parsed && parseOrdered(element)?.filter(isElement);
  if (!parsed || !added || !isNamed(parsed, EXPORT_NAMESPACES, WORDPROCESSINGML, 'sectPr')) return sectPr;
  return buildOrdered([{ ...parsed, [nameOf(parsed)]: placed(childrenOf(parsed), contextIn(parsed, EXPORT_CONTEXT), added, sectPrRank(property)) }]);
}

/**
 * A sectPr export writes, with the template's page number format, and, if
 * it is the document's first section, the start of its page numbers, its
 * header and footer references and its title page setting. The sections
 * after the first take its headers and footers and count its pages on.
 */
export function withTemplateSection(sectPr: string, sections: TemplateSections, first: boolean): string {
  sectPr = withChild(sectPr, first ? sections.pgNumType.first : sections.pgNumType.others, 'pgNumType');
  if (!first) return sectPr;
  sectPr = withChild(sectPr, sections.references, 'headerReference');
  return sections.titlePg ? withChild(sectPr, '<w:titlePg/>', 'titlePg') : sectPr;
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
