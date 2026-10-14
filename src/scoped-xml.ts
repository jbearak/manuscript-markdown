import { XMLValidator } from 'fast-xml-parser';
import { isXmlCharacter, xmlBuilder, xmlParser } from './xml-parser';

// --- XML read by namespace ---
// A part's XML in order, as the parser's preserveOrder gives it, read with
// the namespace each prefix is bound to where an element is, so that an
// element or attribute is known by its namespace and local name, as
// Namespaces in XML has it, whatever prefix a part writes it with, or
// rebinds around it. Markup compatibility's elements and attributes are
// known that way too, whatever prefix its namespace has.
//
// parseOrdered reads only XML that is well-formed and namespace-well-formed,
// and that the parser reads as it is, so that buildOrdered writes it back,
// and none with a DOCTYPE, which no part of a package has (ECMA-376
// Part 2 §8.1.4). XML that isn't well-formed is no round trip's input,
// since Word opens no part that isn't. Where parseOrdered takes some,
// through a gap in fast-xml-parser's validator, as a reference to an
// entity nothing declares, <a>&missing;</a>, or text after the last
// element, <a/>garbage, that's a known limit, not a case for another
// check here.

/** An element, its name with its children and ':@' with its attributes,
 *  or a text node, '#text' */
export type XmlNode = Record<string, unknown> & { ':@'?: Record<string, string> };

/** An element in order, its attributes as written, which the builder writes back */
export const ORDERED_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  suppressEmptyNode: true,
};

export const nameOf = (node: XmlNode) => Object.keys(node).find(key => key !== ':@')!;
export const childrenOf = (node: XmlNode) => node[nameOf(node)] as XmlNode[];

// Characters a name can start with, from U+3400 on (XML 1.0 §2.3), more
// than a document has names past U+FFFF of
const FIRST_SUBSTITUTE = 0x3400, LAST_SUBSTITUTE = 0xD7FF;

/**
 * XML as fast-xml-parser's validator reads it as XML 1.0 does, or none
 * where it can't be. The validator takes no character past U+FFFF in a
 * name, as XML does those to U+EFFFF, so it's given, in place of each such
 * character, one it takes, of those from U+3400 the XML doesn't hold, a
 * different one for each, so that names that differ stay apart, in an
 * attribute repeated or an end tag that matches its start; namespaceProblems
 * checks names. And the validator and the parser take Unicode's spaces but
 * XML's (XML 1.0 §2.3), as U+3000, for spaces between names in a tag, where
 * they're no part of XML's markup, so it's given one that's no space there,
 * nor in a name, but is in text or a value. Two of them, U+1680 and U+FEFF,
 * can be in a name, which the parser would read as two, so it isn't read;
 * but a byte order mark before the document, which isn't in it.
 */
function forValidator(xml: string): string | undefined {
  const astral = xml.match(NAME_CHARACTER_PAST_FFFF);
  let text = xml;
  if (astral) {
    const held = new Set<number>();
    for (let i = 0; i < xml.length; i++) {
      const code = xml.charCodeAt(i);
      if (code >= FIRST_SUBSTITUTE && code <= LAST_SUBSTITUTE) held.add(code);
    }
    const substitutes = new Map<string, string>();
    let next = FIRST_SUBSTITUTE;
    for (const character of astral) {
      if (substitutes.has(character)) continue;
      while (next <= LAST_SUBSTITUTE && held.has(next)) next++;
      if (next > LAST_SUBSTITUTE) return undefined;
      substitutes.set(character, String.fromCharCode(next++));
    }
    text = xml.replace(NAME_CHARACTER_PAST_FFFF, character => substitutes.get(character)!);
  }
  return text.replace(/(?!^)[\v\f\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/g, '\u00D7');
}

// The characters here are read by UTF-16 code unit, or by code point, and
// never with a regular expression's u flag, whose reading of text depends
// on the engine: Bun 1.3.9's, which builds the CLI, read some pairs of
// characters from U+D800 up, as U+F8FF U+FDCF, as one past U+FFFF, so
// that a name of the two was read as one character a name can have, and
// U+FFFE after U+F8FF went for a character XML allows.

// A character a name can have past U+FFFF, from U+10000 to U+EFFFF, as the
// surrogates of UTF-16 that write it
const NAME_CHARACTER_PAST_FFFF = /[\uD800-\uDB7F][\uDC00-\uDFFF]/g;
/** Whether text has a character XML doesn't allow (XML 1.0 §2.2), a lone
 *  surrogate too, by code point */
function hasNonXmlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (!isXmlCharacter(code)) return true;
    if (code > 0xFFFF) i++;
  }
  return false;
}
// A reference to a character, decimal or hexadecimal (XML 1.0 §4.1), as
// xmlParser reads one
const CHARACTER_REFERENCE = /&#(?:([0-9]+)|[xX]([0-9a-fA-F]+));/g;

/** fast-xml-parser's handler of an element named as one of an object's
 *  properties, which it would rename: a refusal instead (see
 *  parseOrdered) */
const refuseName = (name: string): never => {
  throw new Error('An element named ' + name + ' is read as none');
};

/** XML's nodes, in order, or none where it isn't well-formed, nor
 *  namespace-well-formed (see namespaceProblems), which a reader must
 *  report (Namespaces in XML 1.0 §8), in the scope outside it where it's
 *  given, as a document's, which is empty, or a part's: so what export
 *  reads of a template breaks none of those rules. A part whose scope
 *  isn't given may use prefixes bound outside it. None too where the
 *  parser wouldn't read it as it is, so that buildOrdered would write
 *  something else: where it has a character XML doesn't allow, or a
 *  reference to one, which the parser leaves as text (see xmlParser), or
 *  an element named as one of a JavaScript object's properties, as
 *  toString, which the parser renames, or constructor, which it refuses.
 *  Nor where it has a DOCTYPE, which the parser refuses, as no part of a
 *  package has one */
export function parseOrdered(xml: string, outer?: Scope): XmlNode[] | undefined {
  if (hasNonXmlCharacter(xml)) return undefined;
  // The parser reads past a tag closed out of turn, which the validator
  // doesn't (see forValidator)
  const validated = forValidator(xml);
  if (validated === undefined || XMLValidator.validate(validated) !== true) return undefined;
  // Nor does it take an end tag closed as an empty element's, </a/>, for
  // one that isn't well-formed, which the parser skips. Out of comments,
  // character data sections and instructions, which can hold one, </ is
  // only ever an end tag's start, and &# a reference's.
  const markup = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '');
  if (/<\/[^>]*\/>/.test(markup)) return undefined;
  for (const [, decimal, hexadecimal] of markup.matchAll(CHARACTER_REFERENCE)) {
    if (!isXmlCharacter(decimal !== undefined ? Number(decimal) : parseInt(hexadecimal!, 16))) return undefined;
  }
  let nodes: XmlNode[];
  try {
    nodes = xmlParser({ ...ORDERED_OPTIONS, onDangerousProperty: refuseName }).parse(xml) as XmlNode[];
  } catch {
    return undefined;
  }
  return namespaceProblems(nodes, outer).length === 0 ? nodes : undefined;
}

/** Nodes as XML, each element's attributes as they are */
export function buildOrdered(nodes: XmlNode[]): string {
  return xmlBuilder(ORDERED_OPTIONS).build(nodes) as string;
}

export const MARKUP_COMPATIBILITY = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
/** WordprocessingML's namespace, as Transitional and Strict have it */
export const WORDPROCESSINGML: ReadonlySet<string> = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
// The namespace xml: is bound to, always
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
// The namespace the prefix xmlns is bound to, whose attributes are
// declarations
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
// The prefixes Namespaces in XML 1.0 §3 reserves, each bound to its
// namespace, which no other prefix, nor the default, can be bound to (see
// namespaceProblems)
const RESERVED_PREFIXES: ReadonlyMap<string, string> = new Map([['xml', XML_NAMESPACE], ['xmlns', XMLNS_NAMESPACE]]);

/** Each prefix in scope, and '' for the default namespace, with the
 *  namespace it's bound to */
export type Scope = ReadonlyMap<string, string>;

/** The scope inside an element: the scope around it, with its own
 *  declarations, which its own name and attributes are read in too */
export function scopeIn(node: XmlNode, outer: Scope): Scope {
  let scope: Map<string, string> | undefined;
  for (const [key, value] of Object.entries(node[':@'] ?? {})) {
    const prefix = key === '@_xmlns' ? '' : key.startsWith('@_xmlns:') ? key.slice('@_xmlns:'.length) : undefined;
    if (prefix !== undefined) (scope ??= new Map(outer)).set(prefix, value);
  }
  return scope ?? outer;
}

/** The namespace a prefix is bound to in a scope, xml's for xml, which
 *  every document binds without declaring it (Namespaces in XML 1.0 §3),
 *  or none where it isn't bound: for the prefix of a name, or of a token of
 *  markup compatibility's lists, as Requires */
export const namespaceOfPrefix = (prefix: string, scope: Scope): string | undefined => prefix === 'xml' ? XML_NAMESPACE : scope.get(prefix);

/** A prefix bound to a namespace in a scope, xml for xml's, which no other
 *  prefix can be bound to (Namespaces in XML 1.0 §3), or none where none
 *  is: namespaceOfPrefix the other way */
export function prefixOfNamespace(namespace: string, scope: Scope): string | undefined {
  if (namespace === XML_NAMESPACE) return 'xml';
  for (const [prefix, bound] of scope) if (prefix && bound === namespace) return prefix;
  return undefined;
}

/** XML 1.0's characters a name starts with, NameStartChar (§2.3), a colon
 *  among them, each range from its first code point to its last. Names
 *  are read against these by code point (see NAME_CHARACTER_PAST_FFFF) */
export const XML_NAME_START_CHARACTERS: ReadonlyArray<readonly [number, number]> = [[0x3A, 0x3A], [0x41, 0x5A], [0x5F, 0x5F], [0x61, 0x7A],
  [0xC0, 0xD6], [0xD8, 0xF6], [0xF8, 0x2FF], [0x370, 0x37D], [0x37F, 0x1FFF], [0x200C, 0x200D], [0x2070, 0x218F], [0x2C00, 0x2FEF],
  [0x3001, 0xD7FF], [0xF900, 0xFDCF], [0xFDF0, 0xFFFD], [0x10000, 0xEFFFF]];
/** XML 1.0's characters a name goes on with, NameChar (§2.3) */
export const XML_NAME_CHARACTERS: ReadonlyArray<readonly [number, number]> = [...XML_NAME_START_CHARACTERS,
  [0x2D, 0x2E], [0x30, 0x39], [0xB7, 0xB7], [0x300, 0x36F], [0x203F, 0x2040]];
const isWithin = (ranges: ReadonlyArray<readonly [number, number]>, code: number) => ranges.some(([first, last]) => code >= first && code <= last);
/** Whether text is an NCName, a name of XML's without a colon (Namespaces
 *  in XML 1.0 §3) */
function isNCName(text: string): boolean {
  let first = true;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0x3A || !isWithin(first ? XML_NAME_START_CHARACTERS : XML_NAME_CHARACTERS, code)) return false;
    first = false;
  }
  return !first;
}
/** Whether a name is a QName, an NCName or a prefix and a local name that
 *  are, with a colon between (Namespaces in XML 1.0 §4) */
const isQName = (name: string) => {
  const colon = name.indexOf(':');
  return colon === -1 ? isNCName(name) : isNCName(name.slice(0, colon)) && isNCName(name.slice(colon + 1));
};

/**
 * What in nodes, and what they hold, breaks the rules of Namespaces in XML
 * 1.0, in the scope outside them, each as a line that names it:
 * - an element's or an attribute's name, a declaration's too, that isn't
 *   a QName (§3, §4), which is all that's said of that name;
 * - a declaration that §3 forbids of its reserved names: xml bound to a
 *   namespace but its own, xmlns declared, or the namespace of either
 *   bound to another prefix or as the default; or an element's name with
 *   the prefix xmlns;
 * - a declaration of a prefix with no namespace, which undeclares it (§5);
 * - and where the scope outside is given, a prefix of an element's or an
 *   attribute's name that nothing binds (§5), or two attributes of one
 *   element with one expanded name (§6.3), or with one as Word reads it,
 *   Strict's namespace for Transitional's (see asTransitional), which
 *   canonical writes under one name: read so, which of the two a consumer
 *   takes isn't known. Where it isn't, of a part of a document, a prefix
 *   may be bound outside it.
 * The one test of those rules, which parseOrdered reads nothing that
 * breaks, and the check of markup compatibility checks.
 */
export function namespaceProblems(nodes: XmlNode[], outer: Scope | undefined): string[] {
  return nodes.flatMap(node => {
    if (!isElement(node)) return [];
    const name = nameOf(node);
    const problems: string[] = [];
    for (const [key, value] of Object.entries(node[':@'] ?? {})) {
      const qname = key.slice('@_'.length);
      if (!isQName(qname)) {
        problems.push('not a name ' + qname + ' on ' + name);
        continue;
      }
      const prefix = qname === 'xmlns' ? '' : qname.startsWith('xmlns:') ? qname.slice('xmlns:'.length) : undefined;
      if (prefix === undefined) continue;
      const reserved = RESERVED_PREFIXES.get(prefix);
      if (reserved === undefined ? [...RESERVED_PREFIXES.values()].includes(value) : prefix !== 'xml' || value !== reserved) problems.push('reserved ' + qname + ' on ' + name);
      else if (prefix && !value) problems.push('undeclared ' + qname + ' on ' + name);
    }
    const inner = outer && scopeIn(node, outer);
    if (!isQName(name)) problems.push('not a name ' + name);
    else if (name.startsWith('xmlns:')) problems.push('reserved prefix of ' + name);
    else if (inner && name.includes(':') && expandName(name, inner).namespace === undefined) problems.push('unbound ' + name);
    if (outer) {
      const names = new Set<string>();
      for (const attribute of attributesOf(node, outer)) {
        const qname = attribute.key.slice('@_'.length);
        if (!isQName(qname)) continue;
        if (qname.includes(':') && attribute.namespace === undefined) problems.push('unbound ' + qname + ' on ' + name);
        const expanded = (attribute.namespace && asTransitional(attribute.namespace)) + ' ' + attribute.local;
        if (names.has(expanded)) problems.push('repeated ' + qname + ' on ' + name);
        names.add(expanded);
      }
    }
    return [...problems, ...namespaceProblems(childrenOf(node), inner)];
  });
}

/** A name as Namespaces in XML reads it: its namespace and local name */
export interface ExpandedName { namespace: string | undefined; local: string }

/** The namespace and local name of a qualified name in a scope: an
 *  element's without a prefix is the default namespace's, an attribute's
 *  none's, and one whose prefix isn't bound none's */
export function expandName(qname: string, scope: Scope, attribute = false): ExpandedName {
  const colon = qname.indexOf(':');
  // xmlns="" leaves none
  if (colon === -1) return { namespace: attribute ? undefined : scope.get('') || undefined, local: qname };
  const prefix = qname.slice(0, colon);
  return { namespace: namespaceOfPrefix(prefix, scope), local: qname.slice(colon + 1) };
}

/** Whether a node is an element, not text, a comment or an instruction */
export const isElement = (node: XmlNode) => !/^[#?]/.test(nameOf(node));

const inNamespace = (namespace: string | undefined, namespaces: string | ReadonlySet<string> | undefined) =>
  typeof namespaces === 'string' || namespaces === undefined ? namespace === namespaces : namespace !== undefined && namespaces.has(namespace);

/** Whether a node, in a scope, is an element of one of `namespaces`, or
 *  of the one given, named `local` */
export function isNamed(node: XmlNode, scope: Scope, namespaces: string | ReadonlySet<string>, local: string): boolean {
  if (!isElement(node)) return false;
  const name = expandName(nameOf(node), scopeIn(node, scope));
  return name.local === local && inNamespace(name.namespace, namespaces);
}

/** An element's attributes, in a scope, but its declarations, each by its
 *  key, as the parser has it, its namespace and local name, and its value */
export function attributesOf(node: XmlNode, scope: Scope): Array<{ key: string; namespace: string | undefined; local: string; value: string }> {
  const inner = scopeIn(node, scope);
  return Object.entries(node[':@'] ?? {}).flatMap(([key, value]) => {
    const qname = key.slice('@_'.length);
    return qname === 'xmlns' || qname.startsWith('xmlns:') ? [] : [{ key, ...expandName(qname, inner, true), value }];
  });
}

/** An element's attribute, in a scope, by its namespace, one of
 *  `namespaces`, or none for one without a prefix, and its local name */
export function attributeNamed(node: XmlNode, scope: Scope, namespaces: string | ReadonlySet<string> | undefined, local: string): string | undefined {
  return attributesOf(node, scope).find(name => name.local === local && inNamespace(name.namespace, namespaces))?.value;
}

/** An element's children that are elements, each with the scope it's in */
export function elementsIn(node: XmlNode, scope: Scope): Array<{ node: XmlNode; scope: Scope }> {
  const inner = scopeIn(node, scope);
  const children = node[nameOf(node)];
  return Array.isArray(children) ? (children as XmlNode[]).filter(isElement).map(child => ({ node: child, scope: inner })) : [];
}

// --- Section properties ---

/** The section property an element in a scope is, its local name in
 *  WordprocessingML's namespace, whatever its prefix, or '' where it's in
 *  another, or isn't an element: what CT_SectPr's order knows it by (see
 *  sectPrRank). Properties are matched by their expanded names (see
 *  expandedNameOf) */
export function sectPrPropertyOf(node: XmlNode, scope: Scope): string {
  if (!isElement(node)) return '';
  const name = expandName(nameOf(node), scopeIn(node, scope));
  return name.namespace !== undefined && WORDPROCESSINGML.has(name.namespace) ? name.local : '';
}

// WordprocessingML's Transitional namespace, which its Strict one is read as
const TRANSITIONAL_WORDPROCESSINGML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// The relationships' Transitional namespace
const TRANSITIONAL_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// Strict's namespaces of WordprocessingML and the relationships, each with
// the Transitional one export reads it as and writes under its prefix
const TRANSITIONAL_OF: ReadonlyMap<string, string> = new Map([
  ['http://purl.oclc.org/ooxml/wordprocessingml/main', TRANSITIONAL_WORDPROCESSINGML],
  ['http://purl.oclc.org/ooxml/officeDocument/relationships', TRANSITIONAL_RELATIONSHIPS],
]);
/** A namespace as export reads it, Strict's WordprocessingML and
 *  relationships as Transitional's, the one place it maps them */
export const asTransitional = (namespace: string): string => TRANSITIONAL_OF.get(namespace) ?? namespace;

/** An element's expanded name in a scope, its namespace and local name,
 *  whatever its prefix, as one string that two elements share where they
 *  are of one name, an extension's as WordprocessingML's, Strict's read as
 *  Transitional's; or none, where it isn't an element. Section properties
 *  are matched by it, so that none stands for another of some other name */
export function expandedNameOf(node: XmlNode, scope: Scope): string | undefined {
  if (!isElement(node)) return undefined;
  const { namespace, local } = expandName(nameOf(node), scopeIn(node, scope));
  return (namespace === undefined ? '' : asTransitional(namespace)) + ' ' + local;
}

/** CT_SectPr's children in its order (ECMA-376 Part 1 §17.6.17), the
 *  references, any of up to six, headers' and footers' in any order, first */
export const SECT_PR_ORDER: readonly string[] = ['headerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols',
  'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange'];

/** A section property's place in CT_SectPr's order, a footer's reference's
 *  a header's, or -1 for one it doesn't have */
export const sectPrRank = (property: string) => SECT_PR_ORDER.indexOf(property === 'footerReference' ? 'headerReference' : property);

// --- Markup compatibility ---
// A template's section properties, read and written as one model:
// - effectiveSectPr reads a sectPr as Word reads it in export's document,
//   under export's prefixes, with markup compatibility's alternatives and
//   wrappers resolved, which every reader of a property uses.
// - moved takes a node from one context to another with the declarations
//   and markup compatibility's settings it uses, wherever a node goes:
//   out of alternatives or a wrapper, out of a template's sectPr, or into
//   another.
// - withProperties puts properties into a sectPr as Word reads it, in
//   CT_SectPr's order.
// - mapProperties visits each property of a sectPr that keeps its
//   alternatives and wrappers, in each of them.

/** The namespaces export's document element binds, by the prefixes it
 *  binds them to, in its order. Word understands them, among others (see
 *  WORD_UNDERSTOOD_NAMESPACES) */
export const EXPORT_NAMESPACES: Scope = new Map([
  ['wpc', 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas'],
  ['mc', MARKUP_COMPATIBILITY],
  ['o', 'urn:schemas-microsoft-com:office:office'],
  ['r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'],
  ['m', 'http://schemas.openxmlformats.org/officeDocument/2006/math'],
  ['v', 'urn:schemas-microsoft-com:vml'],
  ['wp', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'],
  ['wp14', 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing'],
  ['w10', 'urn:schemas-microsoft-com:office:word'],
  ['w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'],
  ['w14', 'http://schemas.microsoft.com/office/word/2010/wordml'],
  ['w15', 'http://schemas.microsoft.com/office/word/2012/wordml'],
  ['wpg', 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup'],
  ['wpi', 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk'],
  ['wne', 'http://schemas.microsoft.com/office/word/2006/wordml'],
  ['wps', 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'],
]);
/**
 * Every namespace Word 2016 and later reads in a document's WordprocessingML
 * and DrawingML, which it understands as markup compatibility has it
 * (ECMA-376 Part 3): so it reads a choice that requires only these, and
 * none of them is ignored. Not only those export's document element binds
 * (see EXPORT_NAMESPACES). From these lists, as published on the dates
 * given:
 * - ECMA-376's, Transitional's and Strict's (Part 1), of WordprocessingML,
 *   the relationships, math, shared types, custom XML, bibliography,
 *   DrawingML and its pictures, drawings in a document, charts, diagrams
 *   and locked canvases, and the schema library; VML's and the Office
 *   namespaces with it (Part 4); markup compatibility's (Part 3); and xml's
 *   (Namespaces in XML 1.0).
 * - [MS-DOCX], revision 23.0 of 18 August 2026: every namespace it
 *   specifies, w14, w15, the w16 family, and that of a comment's entity,
 *   2026/wordml/cei.
 * - [MS-ODRAWXML], revision 35.0 of 6 October 2026: each namespace it
 *   specifies for drawings any Office application reads, Word's among
 *   them. Not those it gives another application or Word for the web
 *   alone: Excel's drawing, xdr14 (2010/spreadsheetDrawing), PowerPoint's
 *   ink actions, iact (2014/inkAction), and live feeds (2021/livefeed,
 *   PowerPoint 2021 and later), and oEmbed (word/2020/oembed, Word for the
 *   web only). Nor four whose readers it doesn't name, and which aren't
 *   known to be Word: 2013/main/command, 2018/animation,
 *   2018/animation/model3d and 2021/scriptlink.
 * - [MS-OEXTXML], revision 5.0 of 20 August 2024: oel.
 * - Those Word declares on the document element it writes, but no list
 *   above has: wne, wpi, and the chartex namespaces cx1 to cx8.
 */
export const WORD_UNDERSTOOD_NAMESPACES: ReadonlySet<string> = new Set([
  // ECMA-376 Part 1, Transitional
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://schemas.openxmlformats.org/officeDocument/2006/math',
  'http://schemas.openxmlformats.org/officeDocument/2006/sharedTypes',
  'http://schemas.openxmlformats.org/officeDocument/2006/customXml',
  'http://schemas.openxmlformats.org/officeDocument/2006/bibliography',
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://schemas.openxmlformats.org/drawingml/2006/picture',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  'http://schemas.openxmlformats.org/drawingml/2006/chart',
  'http://schemas.openxmlformats.org/drawingml/2006/chartDrawing',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  'http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas',
  'http://schemas.openxmlformats.org/drawingml/2006/compatibility',
  'http://schemas.openxmlformats.org/schemaLibrary/2006/main',
  // ECMA-376 Part 1, Strict
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/math',
  'http://purl.oclc.org/ooxml/officeDocument/sharedTypes',
  'http://purl.oclc.org/ooxml/officeDocument/customXml',
  'http://purl.oclc.org/ooxml/officeDocument/bibliography',
  'http://purl.oclc.org/ooxml/drawingml/main',
  'http://purl.oclc.org/ooxml/drawingml/picture',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
  'http://purl.oclc.org/ooxml/drawingml/chart',
  'http://purl.oclc.org/ooxml/drawingml/chartDrawing',
  'http://purl.oclc.org/ooxml/drawingml/diagram',
  'http://purl.oclc.org/ooxml/drawingml/lockedCanvas',
  'http://purl.oclc.org/ooxml/schemaLibrary/main',
  // ECMA-376 Part 4, VML and the Office namespaces with it
  'urn:schemas-microsoft-com:vml',
  'urn:schemas-microsoft-com:office:office',
  'urn:schemas-microsoft-com:office:word',
  'urn:schemas-microsoft-com:office:excel',
  'urn:schemas-microsoft-com:office:powerpoint',
  // ECMA-376 Part 3, and Namespaces in XML 1.0
  MARKUP_COMPATIBILITY,
  XML_NAMESPACE,
  // [MS-DOCX]
  'http://schemas.microsoft.com/office/word/2010/wordml',
  'http://schemas.microsoft.com/office/word/2012/wordml',
  'http://schemas.microsoft.com/office/word/2015/wordml/symex',
  'http://schemas.microsoft.com/office/word/2016/wordml/cid',
  'http://schemas.microsoft.com/office/word/2018/wordml',
  'http://schemas.microsoft.com/office/word/2018/wordml/cex',
  'http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash',
  'http://schemas.microsoft.com/office/word/2023/wordml/word16du',
  'http://schemas.microsoft.com/office/word/2024/wordml/sdtformatlock',
  'http://schemas.microsoft.com/office/word/2026/wordml/cei',
  // [MS-ODRAWXML]: drawings in a document
  'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
  'http://schemas.microsoft.com/office/word/2012/wordprocessingDrawing',
  // DrawingML, its pictures and themes
  'http://schemas.microsoft.com/office/drawing/2010/main',
  'http://schemas.microsoft.com/office/drawing/2012/main',
  'http://schemas.microsoft.com/office/drawing/2014/main',
  'http://schemas.microsoft.com/office/drawing/2016/11/main',
  'http://schemas.microsoft.com/office/drawing/2010/picture',
  'http://schemas.microsoft.com/office/thememl/2012/main',
  'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
  'http://schemas.microsoft.com/office/drawing/2017/decorative',
  'http://schemas.microsoft.com/office/drawing/2017/model3d',
  'http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor',
  'http://schemas.microsoft.com/office/drawing/2018/sketchyshapes',
  'http://schemas.microsoft.com/office/drawing/2020/classificationShape',
  'http://schemas.microsoft.com/office/drawing/2022/imageformula',
  // Charts
  'http://schemas.microsoft.com/office/drawing/2007/8/2/chart',
  'http://schemas.microsoft.com/office/drawing/2010/chartDrawing',
  'http://schemas.microsoft.com/office/drawing/2012/chart',
  'http://schemas.microsoft.com/office/drawing/2012/chartStyle',
  'http://schemas.microsoft.com/office/drawing/2014/chart',
  'http://schemas.microsoft.com/office/drawing/2014/chart/ac',
  'http://schemas.microsoft.com/office/drawing/2015/06/chart',
  'http://schemas.microsoft.com/office/drawing/2017/03/chart',
  'http://schemas.microsoft.com/office/drawing/2014/chartex',
  // Diagrams
  'http://schemas.microsoft.com/office/drawing/2008/diagram',
  'http://schemas.microsoft.com/office/drawing/2010/diagram',
  'http://schemas.microsoft.com/office/drawing/2016/11/diagram',
  'http://schemas.microsoft.com/office/drawing/2016/12/diagram',
  // Ink
  'http://schemas.microsoft.com/ink/2010/main',
  'http://schemas.microsoft.com/office/drawing/2016/ink',
  // [MS-OEXTXML]
  'http://schemas.microsoft.com/office/2019/extlst',
  // Word's own document element
  'http://schemas.microsoft.com/office/word/2006/wordml',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingInk',
  'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex',
  'http://schemas.microsoft.com/office/drawing/2015/10/21/chartex',
  'http://schemas.microsoft.com/office/drawing/2016/5/9/chartex',
  'http://schemas.microsoft.com/office/drawing/2016/5/10/chartex',
  'http://schemas.microsoft.com/office/drawing/2016/5/11/chartex',
  'http://schemas.microsoft.com/office/drawing/2016/5/12/chartex',
  'http://schemas.microsoft.com/office/drawing/2016/5/13/chartex',
  'http://schemas.microsoft.com/office/drawing/2016/5/14/chartex',
]);
/** Whether Word understands a namespace (see WORD_UNDERSTOOD_NAMESPACES) */
const isUnderstood = (namespace: string | undefined) => namespace !== undefined && WORD_UNDERSTOOD_NAMESPACES.has(namespace);

/** Of markup compatibility's alternatives in a scope, the choice or
 *  fallback Word reads: the first mc:Choice whose Requires names only
 *  namespaces it understands (see WORD_UNDERSTOOD_NAMESPACES), xml's too,
 *  which no document declares, or else mc:Fallback, or else none (ECMA-376
 *  Part 3 §10.2). The scope around it is the one inside the alternatives */
export function chosenBranch(alternatives: XmlNode, scope: Scope): XmlNode | undefined {
  for (const { node: branch, scope: outer } of elementsIn(alternatives, scope)) {
    if (isNamed(branch, outer, MARKUP_COMPATIBILITY, 'Choice')) {
      if (readsChoice(branch, outer)) return branch;
    } else if (isNamed(branch, outer, MARKUP_COMPATIBILITY, 'Fallback')) return branch;
  }
  return undefined;
}

/** Whether Word reads a choice in a scope where it reads none before it:
 *  where its Requires names namespaces, each one it understands, as
 *  chosenBranch has it */
export function readsChoice(choice: XmlNode, scope: Scope): boolean {
  const requires = requiresOf(choice, scope);
  return requires.length > 0 && requires.every(isUnderstood);
}

/** The namespaces a choice in a scope requires, each its Requires names by
 *  a prefix bound where the choice is, or none for one that isn't */
export function requiresOf(choice: XmlNode, scope: Scope): Array<string | undefined> {
  const inner = scopeIn(choice, scope);
  return (attributeNamed(choice, scope, undefined, 'Requires') ?? '').split(/\s+/).filter(Boolean).map(prefix => namespaceOfPrefix(prefix, inner));
}

/** Of markup compatibility's settings in effect in an element, those of
 *  namespaces, mc:Ignorable's, or of names, mc:ProcessContent's,
 *  mc:PreserveElements' and mc:PreserveAttributes' */
export type Setting = 'ignorable' | 'processContent' | 'preserveElements' | 'preserveAttributes';

/**
 * Markup compatibility's attributes (ECMA-376 Part 3 §10.1), each a list of
 * prefixes, alone, or before an element's or an attribute's local name, or
 * *, as `of` has it: of the setting each makes in its element, and in what
 * the element holds, which a node moved out of it takes with it where it
 * holds what the setting is of, any name in a namespace or an element or an
 * attribute (see moved); and of what each namespace named needs where it
 * is, to be ignorable or understood. mc:MustUnderstand makes no setting:
 * it's its element's own, met where a consumer reads the element, as Word
 * did a choice or a wrapper it reads, which, flattened, leave theirs (see
 * withMustUnderstandMet). The one list of them, which each reader and
 * writer of them goes through: compatibilityIn, moved, canonical, and the
 * check of markup compatibility, so that none leaves one out.
 */
export const COMPATIBILITY_LISTS: ReadonlyArray<{ local: string; setting?: Setting; of: 'namespaces' | 'elements' | 'attributes'; needs?: 'ignorable' | 'understood' }> = [
  { local: 'Ignorable', setting: 'ignorable', of: 'namespaces' },
  { local: 'ProcessContent', setting: 'processContent', of: 'elements', needs: 'ignorable' },
  { local: 'PreserveElements', setting: 'preserveElements', of: 'elements', needs: 'ignorable' },
  { local: 'PreserveAttributes', setting: 'preserveAttributes', of: 'attributes', needs: 'ignorable' },
  { local: 'MustUnderstand', of: 'namespaces', needs: 'understood' },
];

/** Markup compatibility's settings in effect in an element (see
 *  COMPATIBILITY_LISTS): the namespaces mc:Ignorable makes ignorable there,
 *  and the names the others name, each as its namespace and its local
 *  name, or * for any in that namespace, with a space between */
export type Compatibility = { readonly [setting in Setting]: ReadonlySet<string> };
export const NO_COMPATIBILITY: Compatibility = { ignorable: new Set(), processContent: new Set(), preserveElements: new Set(), preserveAttributes: new Set() };

/** A token of a list of markup compatibility's of names, prefix:local,
 *  read in a scope, as its setting has it, or none where nothing binds its
 *  prefix */
function entryOf(token: string, of: 'namespaces' | 'elements' | 'attributes', scope: Scope): string | undefined {
  if (of === 'namespaces') return token ? namespaceOfPrefix(token, scope) : undefined;
  const colon = token.indexOf(':');
  const namespace = colon > 0 ? namespaceOfPrefix(token.slice(0, colon), scope) : undefined;
  return namespace && namespace + ' ' + token.slice(colon + 1);
}
/** The namespace of an entry of a setting */
const namespaceOfEntry = (entry: string, of: 'namespaces' | 'elements' | 'attributes') => of === 'namespaces' ? entry : entry.slice(0, entry.indexOf(' '));

/** The settings in effect in an element in a scope: those around it, with
 *  its own, whose prefixes are read where it is */
export function compatibilityIn(node: XmlNode, scope: Scope, outer: Compatibility): Compatibility {
  const own = COMPATIBILITY_LISTS.flatMap(list => {
    const value = list.setting && attributeNamed(node, scope, MARKUP_COMPATIBILITY, list.local);
    return value === undefined ? [] : [{ setting: list.setting!, of: list.of, value }];
  });
  if (own.length === 0) return outer;
  const inner = scopeIn(node, scope);
  const settings: Record<Setting, ReadonlySet<string>> = { ...outer };
  for (const { setting, of, value } of own) {
    const entries = new Set(outer[setting]);
    for (const token of value.split(/\s+/)) {
      const entry = entryOf(token, of, inner);
      if (entry) entries.add(entry);
    }
    settings[setting] = entries;
  }
  return settings;
}

/** Whether Word ignores an element in a scope, with the settings in effect
 *  around it, but reads its content as its parent's: an element of an
 *  ignorable namespace Word doesn't understand that mc:ProcessContent
 *  names (ECMA-376 Part 3 §10.1.2), as a wrapper an extension puts around
 *  properties. Not where choices around it require its namespace, `required`,
 *  which a consumer that reads them understands, and reads it as itself. */
export function isProcessedWrapper(node: XmlNode, scope: Scope, compatibility: Compatibility, required: ReadonlySet<string> = new Set()): boolean {
  if (!isElement(node)) return false;
  const { namespace, local } = expandName(nameOf(node), scopeIn(node, scope));
  if (namespace === undefined || isUnderstood(namespace) || required.has(namespace)) return false;
  const own = compatibilityIn(node, scope, compatibility);
  return own.ignorable.has(namespace) && (own.processContent.has(namespace + ' ' + local) || own.processContent.has(namespace + ' *'));
}

/** Whether Word ignores an element in a scope, with the settings in effect
 *  around it, and all it holds: one of an ignorable namespace Word doesn't
 *  understand, or a choice it reads doesn't require, which isn't a wrapper
 *  whose content it reads (see isProcessedWrapper; ECMA-376 Part 3
 *  §10.1.1) */
export function isIgnored(node: XmlNode, scope: Scope, compatibility: Compatibility, required: ReadonlySet<string> = new Set()): boolean {
  if (!isElement(node)) return false;
  const { namespace } = expandName(nameOf(node), scopeIn(node, scope));
  return namespace !== undefined && !isUnderstood(namespace) && !required.has(namespace)
    && compatibilityIn(node, scope, compatibility).ignorable.has(namespace) && !isProcessedWrapper(node, scope, compatibility, required);
}

/** Whether an element, by its expanded name, under a parent, by its own,
 *  holds an extension: it's an ext in an extLst of its namespace, which a
 *  consumer that `knows` reads as the application that knows the
 *  extension does, not by markup compatibility's rules ([MS-OEXTXML]). So
 *  what it holds is as it is, alternatives too. The one test of this, for
 *  Word (see resolvedNode) and for the compatibility check */
export const holdsExtension = (own: ExpandedName, parent: ExpandedName | undefined, knows: (namespace: string) => boolean) =>
  own.local === 'ext' && parent?.local === 'extLst' && own.namespace !== undefined && own.namespace === parent.namespace && knows(own.namespace);

/** Where an element is: the scope and markup compatibility's settings in
 *  effect there */
export interface Context { scope: Scope; compatibility: Compatibility }

/** The context inside an element in a context, with its own declarations
 *  and markup compatibility's settings */
export const contextIn = (node: XmlNode, outer: Context): Context =>
  ({ scope: scopeIn(node, outer.scope), compatibility: compatibilityIn(node, outer.scope, outer.compatibility) });

/** The prefixes export's document element makes ignorable, in its order */
export const EXPORT_IGNORABLE: readonly string[] = ['w14', 'w15', 'wp14'];

/** The context inside export's document element, which binds
 *  EXPORT_NAMESPACES and makes EXPORT_IGNORABLE ignorable */
export const EXPORT_CONTEXT: Context = {
  scope: EXPORT_NAMESPACES,
  compatibility: { ...NO_COMPATIBILITY, ignorable: new Set(EXPORT_IGNORABLE.map(prefix => EXPORT_NAMESPACES.get(prefix)!)) },
};

// Markup compatibility's attributes that list prefixes, alone, as
// mc:Ignorable does, or before a name, as mc:ProcessContent does, on any
// element (see COMPATIBILITY_LISTS), and a choice's Requires, which has no
// prefix of its own (ECMA-376 Part 3 §10.2.1)
const PREFIX_LISTS = new Set(COMPATIBILITY_LISTS.map(list => list.local));
const listsPrefixes = (node: XmlNode, scope: Scope, attribute: ExpandedName) =>
  attribute.namespace === MARKUP_COMPATIBILITY ? PREFIX_LISTS.has(attribute.local)
    : attribute.namespace === undefined && attribute.local === 'Requires' && isNamed(node, scope, MARKUP_COMPATIBILITY, 'Choice');
/** The prefix of a token of such a list, '' for none */
const prefixOfToken = (token: string) => token.includes(':') ? token.slice(0, token.indexOf(':')) : token;

/** The prefixes declared in an element, or in any element in it */
const declaredIn = (node: XmlNode): string[] => [
  ...Object.keys(node[':@'] ?? {}).filter(key => key.startsWith('@_xmlns:')).map(key => key.slice('@_xmlns:'.length)),
  ...(isElement(node) && Array.isArray(node[nameOf(node)]) ? childrenOf(node).flatMap(declaredIn) : []),
];

/** The prefixes an element in a scope, and every element in it, uses, in
 *  their names and markup compatibility's lists of prefixes, where nothing
 *  in it declares them, '' for the default namespace of an element of no
 *  prefix; the namespaces of all their names, and of the tokens of
 *  markup compatibility's lists; and those of the elements, and of the
 *  attributes */
function usesOf(node: XmlNode, scope: Scope): { prefixes: Set<string>; namespaces: Set<string>; elements: Set<string>; attributes: Set<string> } {
  const prefixes = new Set<string>(), namespaces = new Set<string>(), elements = new Set<string>(), attributes = new Set<string>();
  const walk = (element: XmlNode, outer: Scope, declared: ReadonlySet<string>) => {
    if (!isElement(element)) return;
    const inner = scopeIn(element, outer);
    const here = new Set(declared);
    for (const key of Object.keys(element[':@'] ?? {})) {
      if (key === '@_xmlns') here.add('');
      else if (key.startsWith('@_xmlns:')) here.add(key.slice('@_xmlns:'.length));
    }
    const use = (prefix: string) => {
      if (prefix !== 'xml' && !here.has(prefix)) prefixes.add(prefix);
    };
    const name = nameOf(element);
    use(name.includes(':') ? name.slice(0, name.indexOf(':')) : '');
    const own = expandName(name, inner);
    if (own.namespace !== undefined) {
      namespaces.add(own.namespace);
      elements.add(own.namespace);
    }
    for (const attribute of attributesOf(element, outer)) {
      const qname = attribute.key.slice('@_'.length);
      // An attribute of no prefix is in no namespace
      if (qname.includes(':')) use(qname.slice(0, qname.indexOf(':')));
      if (attribute.namespace !== undefined) {
        namespaces.add(attribute.namespace);
        attributes.add(attribute.namespace);
      }
      if (!listsPrefixes(element, outer, attribute)) continue;
      for (const token of attribute.value.split(/\s+/).filter(Boolean)) {
        use(prefixOfToken(token));
        // And the namespace a markup compatibility list names, which its
        // context can make ignorable, as mc:ProcessContent's, mc:Preserve*'s
        // and mc:MustUnderstand's need, not a choice's Requires, which
        // needs it understood
        const namespace = attribute.namespace === MARKUP_COMPATIBILITY ? namespaceOfPrefix(prefixOfToken(token), inner) : undefined;
        if (namespace !== undefined) namespaces.add(namespace);
      }
    }
    const children = element[name];
    if (Array.isArray(children)) for (const child of children as XmlNode[]) walk(child, inner, here);
  };
  walk(node, scope, new Set());
  return { prefixes, namespaces, elements, attributes };
}

/**
 * An element moved from where `from` is the context around it to where `to`
 * is, so that it means what it did there. It declares each prefix it uses,
 * and the default namespace, that `from` binds otherwise than `to`, but
 * those it declares itself, xmlns="" for no default namespace where it had
 * none. Each namespace it uses that `from` makes ignorable and `to`
 * doesn't, it makes ignorable, and each name that mc:ProcessContent,
 * mc:PreserveElements or mc:PreserveAttributes names in `from` and not in
 * `to`, of the namespace of an element it holds, or of an attribute for
 * mc:PreserveAttributes, it names in its own (see COMPATIBILITY_LISTS), by
 * the prefix bound to that namespace where it is, or by a new one, as ns1,
 * that it declares where none is, since those lists name namespaces by the
 * prefixes bound where they are (ECMA-376 Part 3 §10.1).
 */
export function moved(node: XmlNode, from: Context, to: Context): XmlNode {
  if (!isElement(node)) return node;
  const attributes: Record<string, string> = { ...node[':@'] };
  const uses = usesOf(node, from.scope);
  for (const prefix of uses.prefixes) {
    const namespace = from.scope.get(prefix) ?? (prefix ? undefined : '');
    if (namespace !== undefined && namespace !== (to.scope.get(prefix) ?? (prefix ? undefined : ''))) attributes[prefix ? '@_xmlns:' + prefix : '@_xmlns'] = namespace;
  }
  // Of each setting, what `from` has and `to` hasn't of what it holds
  const settings = COMPATIBILITY_LISTS.flatMap(list => {
    if (!list.setting) return [];
    const there = to.compatibility[list.setting];
    const entries = [...from.compatibility[list.setting]].filter(entry => !there.has(entry) && uses[list.of].has(namespaceOfEntry(entry, list.of)));
    return entries.length === 0 ? [] : [{ local: list.local, of: list.of, entries }];
  });
  if (settings.length === 0) return Object.keys(attributes).length === Object.keys(node[':@'] ?? {}).length ? node : { ...node, ':@': attributes };
  // The scope inside it, with what it declares, and any new prefixes
  const scope = new Map(scopeIn({ ...node, ':@': attributes }, to.scope));
  const taken = new Set([...scope.keys(), ...declaredIn(node)]);
  const prefixFor = (namespace: string): string => {
    const bound = prefixOfNamespace(namespace, scope);
    if (bound !== undefined) return bound;
    let n = 1;
    while (taken.has('ns' + n)) n++;
    taken.add('ns' + n);
    scope.set('ns' + n, namespace);
    attributes['@_xmlns:ns' + n] = namespace;
    return 'ns' + n;
  };
  // Its own list of each, in COMPATIBILITY_LISTS' order, with the entries
  // it hasn't on it, mc:Ignorable's first
  for (const { local, of, entries } of settings) {
    const own = attributesOf({ ...node, ':@': attributes }, to.scope).find(attribute => attribute.namespace === MARKUP_COMPATIBILITY && attribute.local === local);
    const listed = (own?.value ?? '').split(/\s+/).filter(Boolean);
    const named = new Set(listed.map(token => entryOf(token, of, scope)));
    const more = entries.filter(entry => !named.has(entry))
      .map(entry => of === 'namespaces' ? prefixFor(entry) : prefixFor(namespaceOfEntry(entry, of)) + ':' + entry.slice(entry.indexOf(' ') + 1));
    if (more.length > 0) attributes[own?.key ?? '@_' + prefixFor(MARKUP_COMPATIBILITY) + ':' + local] = [...listed, ...more].join(' ');
  }
  return { ...node, ':@': attributes };
}

/** Whether Word reads, by markup compatibility's rules, none of what an
 *  element in a context holds, under a parent, by its expanded name: an
 *  element it ignores with all it holds (see isIgnored), which
 *  mc:PreserveElements can keep, or an extension (see holdsExtension), which
 *  the application that knows the extension reads. Where reading a node as
 *  Word does stops (see resolvedNode), and so does meeting its
 *  mc:MustUnderstand (see withMustUnderstandMet) */
const isOpaque = (node: XmlNode, parent: ExpandedName, context: Context, required?: ReadonlySet<string>) =>
  isElement(node) && (holdsExtension(expandName(nameOf(node), scopeIn(node, context.scope)), parent, isUnderstood)
    || isIgnored(node, context.scope, context.compatibility, required));

/** What Word reads of an element in a context, under a parent, by its
 *  expanded name: of markup compatibility's alternatives, the children of
 *  the choice or fallback it reads (see chosenBranch), or none, and of a
 *  wrapper whose content it reads as its parent's (see isProcessedWrapper),
 *  its children, each as Word reads it under that parent and moved out of
 *  them (see moved); of an element whose content Word reads none of (see
 *  isOpaque), the element as it is; or else the element as Word reads it
 *  (see resolvedNode) */
function asRead(node: XmlNode, context: Context, parent: ExpandedName): XmlNode[] {
  if (!isElement(node) || isOpaque(node, parent, context)) return [node];
  let inner: Context, children: XmlNode[];
  if (isNamed(node, context.scope, MARKUP_COMPATIBILITY, 'AlternateContent')) {
    const branch = chosenBranch(node, context.scope);
    if (!branch) return [];
    inner = contextIn(branch, contextIn(node, context));
    children = childrenOf(branch);
  } else if (isProcessedWrapper(node, context.scope, context.compatibility)) {
    inner = contextIn(node, context);
    children = childrenOf(node);
  } else {
    return [resolvedNode(node, context)];
  }
  // All they hold, text too, which only an element moves with what it uses
  return children.flatMap(child => asRead(child, inner, parent)).map(child => moved(child, inner, context));
}

/** An element in a context as Word reads it: with each of markup
 *  compatibility's alternatives and wrappers in it, at any depth, in place
 *  of what Word reads of them (see asRead). Not a tracked change's old
 *  properties, w:sectPrChange, which keep theirs, nor what an extension
 *  holds (see holdsExtension), which the application that knows the
 *  extension reads. */
export function resolvedNode(node: XmlNode, context: Context): XmlNode {
  const name = nameOf(node), children = node[name];
  if (!Array.isArray(children) || isNamed(node, context.scope, WORDPROCESSINGML, 'sectPrChange')) return node;
  const inner = contextIn(node, context), own = expandName(name, inner.scope);
  return { ...node, [name]: (children as XmlNode[]).flatMap(child => asRead(child, inner, own)) };
}

/**
 * Section properties, `nodes`, in a context, each in place of what `visit`
 * gives for it, with the context it's in: among them, in each choice and
 * fallback of markup compatibility's alternatives among them, and in each
 * wrapper whose content Word reads as its parent's (see isProcessedWrapper),
 * at any depth, so that whichever a consumer reads, it reads what `visit`
 * gives. Never within a property, as a tracked change's old ones,
 * w:sectPrChange, which `visit` is given whole. Alternatives that held a
 * property, and hold nothing in any choice or fallback, go, and so does a
 * wrapper that held one and holds nothing, but white space. Text stays,
 * and so does what holds it. In a choice, an element of a namespace it
 * requires is no wrapper, since a consumer that reads the choice
 * understands it, and `visit` is given it whole, as it is where choices
 * around `nodes` require its namespace, `required`.
 */
export function mapProperties(nodes: XmlNode[], context: Context, visit: (node: XmlNode, context: Context) => XmlNode[], required: ReadonlySet<string> = new Set()): XmlNode[] {
  return nodes.flatMap(node => {
    if (!isElement(node)) return [node];
    const isAlternatives = isNamed(node, context.scope, MARKUP_COMPATIBILITY, 'AlternateContent');
    if (!isAlternatives && !isProcessedWrapper(node, context.scope, context.compatibility, required)) return visit(node, context);
    const inner = contextIn(node, context);
    const isChoice = (branch: XmlNode) => isNamed(branch, inner.scope, MARKUP_COMPATIBILITY, 'Choice');
    const isBranch = (branch: XmlNode) => isChoice(branch) || isNamed(branch, inner.scope, MARKUP_COMPATIBILITY, 'Fallback');
    /** What's required within a branch: what's required around it, and
     *  what a choice requires */
    const within = (branch: XmlNode) => !isChoice(branch) ? required
      : new Set([...required, ...requiresOf(branch, inner.scope).filter((namespace): namespace is string => namespace !== undefined)]);
    const children = childrenOf(node);
    const kept = !isAlternatives ? mapProperties(children, inner, visit, required)
      : children.map(branch => isBranch(branch) ? { ...branch, [nameOf(branch)]: mapProperties(childrenOf(branch), contextIn(branch, inner), visit, within(branch)) } : branch);
    /** Whether children hold something, an element or text but white
     *  space, or, of alternatives, a choice or fallback of them does */
    const isContent = (child: XmlNode) => isElement(child) || nameOf(child) === '#text' && String(child['#text']).trim() !== '';
    const holds = (list: XmlNode[]) => isAlternatives ? list.some(branch => isBranch(branch) && childrenOf(branch).some(isContent)) : list.some(isContent);
    return holds(children) && !holds(kept) ? [] : [{ ...node, [nameOf(node)]: kept }];
  });
}

// The namespaces export writes under prefixes of its own: WordprocessingML's
// and the relationships', Strict's read as Transitional's (see
// asTransitional), and markup compatibility's, one for both (ECMA-376 Part 3)
const EXPORT_PREFIXES = new Map([
  [TRANSITIONAL_WORDPROCESSINGML, 'w'],
  [TRANSITIONAL_RELATIONSHIPS, 'r'],
  [MARKUP_COMPATIBILITY, 'mc'],
]);

/**
 * An element in a context, as it reads in export's document (see
 * EXPORT_CONTEXT): its names and attributes in WordprocessingML's, the
 * relationships' and markup compatibility's namespaces under export's
 * prefixes for them, w:, r: and mc:, whatever prefix it, or what's around
 * it, binds them to, so that a name read or written by its prefix is the
 * element it names. A prefix of export's that it binds to another namespace
 * gets one of its own in its place, as ns1, declared where it was, and
 * markup compatibility's lists of prefixes name them as they're named. What
 * it uses of the context, as a prefix only an ancestor declares, or a
 * namespace an ancestor makes ignorable, it takes with it (see moved).
 */
export function canonical(node: XmlNode, around: Context): XmlNode {
  const exportPrefixes = new Set(EXPORT_PREFIXES.values());
  // Every prefix in scope or declared in it, which a new one can't be
  const taken = new Set([...around.scope.keys(), ...declaredIn(node), ...exportPrefixes]);
  const fresh = new Map<string, string>();
  /** The prefix a namespace bound to a prefix has in export's document */
  const renamed = (prefix: string, namespace: string): string => {
    const exported = EXPORT_PREFIXES.get(asTransitional(namespace));
    if (exported !== undefined) return exported;
    if (!exportPrefixes.has(prefix)) return prefix;
    let own = fresh.get(namespace);
    if (own === undefined) {
      let n = 1;
      while (taken.has('ns' + n)) n++;
      own = 'ns' + n;
      taken.add(own);
      fresh.set(namespace, own);
    }
    return own;
  };
  const walk = (element: XmlNode, outer: Scope): XmlNode => {
    if (!isElement(element)) return element;
    const scope = scopeIn(element, outer);
    /** A prefix as export's document writes it, or itself where it's unbound */
    const prefixOf = (prefix: string): string => {
      const namespace = scope.get(prefix);
      return namespace === undefined ? prefix : renamed(prefix, namespace);
    };
    const rename = (qname: string, attribute: boolean): string => {
      const colon = qname.indexOf(':');
      const prefix = colon === -1 ? '' : qname.slice(0, colon);
      // xml:'s, and an attribute of no prefix, which is in no namespace
      if (prefix === 'xml' || attribute && colon === -1) return qname;
      const own = prefixOf(prefix);
      return (own ? own + ':' : '') + qname.slice(colon + 1);
    };
    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(element[':@'] ?? {})) {
      const qname = key.slice('@_'.length);
      if (qname === 'xmlns' || qname.startsWith('xmlns:')) {
        // A declaration of a namespace export writes under its own prefix,
        // which its document binds, goes, and one of a prefix of export's
        // for another namespace declares the prefix in its place
        const prefix = qname === 'xmlns' ? '' : qname.slice('xmlns:'.length);
        const own = value ? renamed(prefix, value) : prefix;
        if (!(value && EXPORT_PREFIXES.has(asTransitional(value)))) attributes[own ? '@_xmlns:' + own : '@_xmlns'] = value;
        continue;
      }
      const attribute = expandName(qname, scope, true);
      attributes['@_' + rename(qname, true)] = listsPrefixes(element, outer, attribute)
        ? value.split(/(\s+)/).map(token => /^\s*$/.test(token) ? token : prefixOf(prefixOfToken(token)) + token.slice(prefixOfToken(token).length)).join('')
        : value;
    }
    const name = nameOf(element), children = element[name];
    return {
      [rename(name, false)]: Array.isArray(children) ? (children as XmlNode[]).map(child => walk(child, scope)) : children,
      ...(element[':@'] ? { ':@': attributes } : {}),
    };
  };
  // The scope around it as export's document writes it, which binds its
  // prefixes as export's does
  const scope = new Map([...exportPrefixes].map(prefix => [prefix, EXPORT_NAMESPACES.get(prefix)!]));
  for (const [prefix, namespace] of around.scope) {
    const own = renamed(prefix, namespace);
    scope.set(own, exportPrefixes.has(own) ? EXPORT_NAMESPACES.get(own)! : namespace);
  }
  // And the settings around it, whose namespaces are read as its names are,
  // so that a Strict one ignorable there is ignorable as export writes it
  const compatibility: Record<Setting, ReadonlySet<string>> = { ...around.compatibility };
  for (const { setting, of } of COMPATIBILITY_LISTS) {
    if (setting) compatibility[setting] = new Set([...around.compatibility[setting]].map(entry => asTransitional(namespaceOfEntry(entry, of)) + entry.slice(namespaceOfEntry(entry, of).length)));
  }
  return moved(walk(node, around.scope), { scope, compatibility }, EXPORT_CONTEXT);
}

/** An element in a scope with each namespace that mc:MustUnderstand names
 *  in it, at any depth, and that Word doesn't understand, out of the list,
 *  and the list gone where that leaves it none. Word rejects a document
 *  whose mc:MustUnderstand names a namespace it doesn't understand,
 *  ignorable or not (ECMA-376 Part 3), so a template's sectPr that does
 *  wouldn't open in Word, and export, which writes for Word, leaves the
 *  namespace out rather than carry that into its document. Its content
 *  stays as it was, ignorable where it was. But not where a choice that
 *  requires the namespace holds the list, which Word reads only where it
 *  understands it, nor in what Word reads none of (see isOpaque), as
 *  resolvedNode keeps it */
function withMustUnderstandMet(node: XmlNode, context: Context, required: ReadonlySet<string> = new Set()): XmlNode {
  if (!isElement(node)) return node;
  const { scope } = context, inner = contextIn(node, context);
  let attributes = node[':@'];
  const list = attributesOf(node, scope).find(attribute => attribute.namespace === MARKUP_COMPATIBILITY && attribute.local === 'MustUnderstand');
  if (list) {
    const kept = list.value.split(/\s+/).filter(prefix => {
      const namespace = prefix ? namespaceOfPrefix(prefix, inner.scope) : undefined;
      return namespace !== undefined && (isUnderstood(namespace) || required.has(namespace));
    });
    attributes = { ...attributes };
    if (kept.length > 0) attributes[list.key] = kept.join(' ');
    else delete attributes[list.key];
  }
  let within = required;
  if (isNamed(node, scope, MARKUP_COMPATIBILITY, 'Choice')) {
    within = new Set([...required, ...requiresOf(node, scope).filter((namespace): namespace is string => namespace !== undefined)]);
  }
  const name = nameOf(node), children = node[name], own = expandName(name, inner.scope);
  const met = (child: XmlNode) => isOpaque(child, own, inner, within) ? child : withMustUnderstandMet(child, inner, within);
  return {
    [name]: Array.isArray(children) ? (children as XmlNode[]).map(met) : children,
    ...(attributes ? { ':@': attributes } : {}),
  };
}

/** A sectPr in a context as Word reads it in export's document: under
 *  export's prefixes (see canonical), with each of markup compatibility's
 *  alternatives and wrappers in it in place of what Word reads of them (see
 *  resolvedNode), so that each of its properties is one of its children,
 *  once, which a reader finds by its name, and which goes into another
 *  section moved out of it (see moved), and naming in mc:MustUnderstand
 *  only what Word understands (see withMustUnderstandMet) */
export const effectiveSectPr = (sectPr: XmlNode, around: Context): XmlNode =>
  resolvedNode(canonical(withMustUnderstandMet(sectPr, around), around), EXPORT_CONTEXT);

/**
 * A sectPr, in a context, whose properties are its own children, with
 * `added`, section properties read where `from` is, in place of those of
 * their expanded names among them (see expandedNameOf), and moved into it
 * (see moved). WordprocessingML's each go before the first property
 * CT_SectPr puts after them, a tracked change's old properties,
 * w:sectPrChange, last of all, or after them, in the order given. An
 * extension's, which CT_SectPr doesn't place, goes where the first of its
 * name was, or else after CT_SectPr's properties, before a tracked change's
 * old ones. What else the sectPr holds stays, of other names, an
 * extension's too, and its text. It doesn't look into markup
 * compatibility's alternatives, which such a sectPr hasn't (see
 * effectiveSectPr).
 */
export function withProperties(sectPr: XmlNode, around: Context, added: XmlNode[], from: Context): XmlNode {
  const inside = contextIn(sectPr, around);
  const rankIn = (node: XmlNode, scope: Scope) => sectPrRank(sectPrPropertyOf(node, scope));
  const byName = new Map<string, XmlNode[]>();
  for (const node of added.filter(isElement)) {
    const name = expandedNameOf(node, from.scope)!;
    byName.set(name, [...(byName.get(name) ?? []), node]);
  }
  // Those of an extension's name in place of the first of it
  const inPlace = new Set<string>();
  let children = childrenOf(sectPr).flatMap(child => {
    const name = expandedNameOf(child, inside.scope);
    if (name === undefined || !byName.has(name)) return [child];
    if (rankIn(child, inside.scope) !== -1 || inPlace.has(name)) return [];
    inPlace.add(name);
    return byName.get(name)!.map(node => moved(node, from, inside));
  });
  for (const node of added.filter(isElement)) {
    if (inPlace.has(expandedNameOf(node, from.scope)!)) continue;
    const rank = rankIn(node, from.scope);
    const before = rank === -1 ? sectPrRank('sectPrChange') : rank + 1;
    const at = children.findIndex(child => rankIn(child, inside.scope) >= before);
    const placed = moved(node, from, inside);
    children = at === -1 ? [...children, placed] : [...children.slice(0, at), placed, ...children.slice(at)];
  }
  return { ...sectPr, [nameOf(sectPr)]: children };
}
