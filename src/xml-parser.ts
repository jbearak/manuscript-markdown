// One way to read XML into fast-xml-parser's nodes and to write them back,
// for every parser and builder in src to read and write text and values as
// XML 1.0 does. Its exports:
//
// - xmlParser(options): a parser of XML as text, XmlTextParser, not bytes,
//   that reads each reference to a character, &#9; or &#x2019;, and to one
//   of the five entities XML declares, &amp; &lt; &gt; &quot; &apos;, as
//   what it stands for, once, however many there are, in time linear in
//   the text. In an attribute's value, a tab, line feed or carriage return
//   written as itself is a space (XML 1.0 §3.3.3), and one written as a
//   reference stays what it is. It refuses XML with a DOCTYPE, which no
//   part of a package has (ECMA-376 Part 2 §8.1.4), so it reads no entity
//   one declares.
// - xmlBuilder(options): an XMLBuilder that writes what xmlParser read as it
//   was: in text, the characters markup reads, & < > " ', as entities; in
//   an attribute's value, which it writes between double quotes, & < > "
//   as entities, and a tab, line feed or carriage return as a reference, as
//   a carriage return in text, which a reader would otherwise read as other
//   white space.
// - escapeXmlAttribute(value): an attribute's value written so, between
//   double quotes, for XML built as text.
// - xmlAttributeValue(value): an attribute's value as xmlParser reads it,
//   for a reader of tags as text (see xmlAttribute in xml-elements.ts).
// - xmlTextValue(text): text between tags as xmlParser reads it, for a
//   reader of XML as text (see docPropertyNames in template-sections.ts).
// - XML_ENTITIES: how many entities fast-xml-parser reads, and how long one
//   a DOCTYPE declares can be.
// - isXmlCharacter(code), hasNonXmlCharacter(text) and
//   withoutNonXmlCharacters(text): XML's characters (§2.2), read by code
//   point, which every check in src of the characters XML holds goes
//   through, never a regular expression's u flag (see hasNonXmlCharacter).
//
// fast-xml-parser can't do this itself. It reads a reference to a character
// only with htmlEntities, which reads HTML's entities too, and only after
// it has read the entities, so that an attribute's value no longer tells a
// tab written as one from a reference to one; and its default caps how many
// entities it reads at a thousand, and throws past that, so it refused a
// long document, valid as it is. So the parser replaces no entity itself,
// and its processors read each text and value as the document has it.
//
// Every parser in src is built with xmlParser: md-to-docx.ts reads a
// template's numbering with parseOrdered (see scoped-xml.ts), and its
// styles with xml-elements.ts's readers, whose values are read as
// xmlAttributeValue reads them. Of the builders, buildOrdered's, which
// writes a template's numbering again, and a template's sections' are
// built with xmlBuilder; converter.ts's of a title paragraph isn't yet.

import { XMLBuilder, XMLParser, type X2jOptions, type XmlBuilderOptions } from 'fast-xml-parser';

/**
 * How a parser reads entities: the five XML declares and references to
 * characters, with no cap on how many, and those a DOCTYPE declares (which
 * Word never writes) of one character at most, as it refuses a longer one.
 * fast-xml-parser counts every &quot;, &lt;, &gt; and &apos; toward
 * maxTotalExpansions, and a long manuscript passes any fixed count (Zotero
 * field codes are full of &quot;), as a part's relationships can (a link's
 * target may hold many &apos;). Leaving it uncapped is safe because no
 * expansion can grow the text: standard entities replace 4+ characters with
 * one, and maxEntitySize holds DOCTYPE entities to one character in place of
 * a reference of at least three. xmlParser's parser has these limits too,
 * though it reads no XML with a DOCTYPE, and replaces no entity itself.
 */
export const XML_ENTITIES = {
  enabled: true,
  maxTotalExpansions: Infinity,
  maxEntitySize: 1,
  maxExpandedLength: 1000000,
};

// A reference to a character, decimal or hexadecimal, or to an entity by its
// name (XML 1.0 §4.1). A hexadecimal one with an X, which XML doesn't
// allow, is read too, as import read it before, which no well-formed
// document has
const REFERENCE = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([^\s&;#<>"']+));/g;
// The five entities XML declares (XML 1.0 §4.6)
const ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', '\'']]);

/** Whether a code point is one of XML's characters (XML 1.0 §2.2) */
export const isXmlCharacter = (code: number) => code === 0x9 || code === 0xA || code === 0xD
  || code >= 0x20 && code <= 0xD7FF || code >= 0xE000 && code <= 0xFFFD || code >= 0x10000 && code <= 0x10FFFF;

/** Whether text has a character XML doesn't allow (XML 1.0 §2.2), a lone
 *  surrogate too. Read by code point, not with a regular expression's u
 *  flag, whose reading of text depends on the engine: Bun 1.3.9's, which
 *  CI and the CLI's builds run, read a UTF-16 unit from U+D800 to U+DBFF
 *  or U+F800 to U+FBFF, and one from U+DC00 to U+DFFF or U+FC00 to U+FFFF
 *  after it, as U+F8FF U+FFFE, as one character past U+FFFF, which XML
 *  allows */
export function hasNonXmlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (!isXmlCharacter(code)) return true;
    if (code > 0xFFFF) i++;
  }
  return false;
}

/** Text without the characters XML doesn't allow (see
 *  hasNonXmlCharacter), and how many it had */
export function withoutNonXmlCharacters(text: string): { text: string; removed: number } {
  let kept = '', from = 0, removed = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    const width = code > 0xFFFF ? 2 : 1;
    if (!isXmlCharacter(code)) {
      kept += text.slice(from, i);
      from = i + width;
      removed++;
    }
    i += width - 1;
  }
  return { text: removed === 0 ? text : kept + text.slice(from), removed };
}

/** Text with each reference read as what it stands for, in one pass, so
 *  that &amp;#65; is the text &#65;: one to one of the five entities XML
 *  declares, or to a character. One to no character of XML's, or to an
 *  entity XML doesn't declare, is left as it is */
function decoded(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(REFERENCE, (reference, decimal?: string, hexadecimal?: string, entity?: string) => {
    if (entity !== undefined) return ENTITIES.get(entity) ?? reference;
    const code = decimal !== undefined ? Number(decimal) : parseInt(hexadecimal!, 16);
    return isXmlCharacter(code) ? String.fromCodePoint(code) : reference;
  });
}

/** An attribute's value, as written between its quotes, as XML reads it: a
 *  tab or line end written as itself a space (XML 1.0 §3.3.3), a carriage
 *  return and line feed one line end (§2.11), and then each reference read
 *  (see decoded), so one to a tab or line end stays what it is. The parser
 *  reads each value so, and xmlAttribute (see xml-elements.ts) each value
 *  of a tag it reads, so that both read a template's the same */
export const xmlAttributeValue = (value: string): string => decoded(value.replace(/\r\n?|[\t\n]/g, ' '));

/** Text between tags, as written, as XML reads it: a carriage return and
 *  line feed, or a carriage return alone, a line feed (XML 1.0 §2.11), and
 *  then each reference read (see decoded). The parser reads each text so,
 *  as it's given text whose line ends are line feeds already */
export const xmlTextValue = (text: string): string => decoded(text.replace(/\r\n?/g, '\n'));

// What holds no markup, each by how it starts and ends: a comment, an
// instruction and a character data section
const NO_MARKUP = [['<!--', '-->'], ['<?', '?>'], ['<![CDATA[', ']]>']] as const;

/** Whether XML has a DOCTYPE, wherever it is, out of what holds no markup
 *  (see NO_MARKUP). In one pass, linear in the XML */
function hasDoctype(xml: string): boolean {
  if (!xml.includes('<!DOCTYPE')) return false;
  for (let i = xml.indexOf('<'); i >= 0; i = xml.indexOf('<', i + 1)) {
    if (xml.startsWith('<!DOCTYPE', i)) return true;
    const passed = NO_MARKUP.find(([start]) => xml.startsWith(start, i));
    if (!passed) continue;
    const end = xml.indexOf(passed[1], i + passed[0].length);
    if (end < 0) return false;
    i = end + passed[1].length - 1;
  }
  return false;
}

/** XML with each & in a character data section written as &amp;, which the
 *  parser gives its text processor as it gives it text, so that it reads
 *  the section as it is. Not in a comment or an instruction, which can
 *  hold what looks like one */
const withSectionsEscaped = (xml: string) => !xml.includes('<![CDATA[') ? xml
  : xml.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>/g, (markup, section?: string) =>
    section === undefined ? markup : '<![CDATA[' + section.replace(/&/g, '&amp;') + ']]>');

/** fast-xml-parser's parser, reading text and values as XML does (see the
 *  file's header) */
class ReferenceParser extends XMLParser {
  private readonly sectionsAsText: boolean;
  constructor(options: X2jOptions) {
    super({
      ...options,
      // No entity replaced where the processors would read it again
      processEntities: { ...XML_ENTITIES, tagFilter: () => false },
      htmlEntities: false,
      attributeValueProcessor: (_name, value) => xmlAttributeValue(value),
      tagValueProcessor: (_name, value) => xmlTextValue(value),
    });
    // A section kept apart is given no processor
    this.sectionsAsText = !options.cdataPropName;
  }

  // Bytes would reach the processors with no section escaped and no
  // DOCTYPE found, so only text is read. A DOCTYPE's entities would reach
  // them as fast-xml-parser reads them, not as XML does, and a package's
  // XML has none (ECMA-376 Part 2 §8.1.4, which has a reader take one for
  // an error), so XML with one isn't read
  override parse(xml: string | Uint8Array, validation?: Parameters<XMLParser['parse']>[1]): ReturnType<XMLParser['parse']> {
    if (typeof xml !== 'string') throw new TypeError('xmlParser reads XML as text, not bytes');
    if (hasDoctype(xml)) throw new Error('xmlParser reads no XML with a DOCTYPE, which no part of a package has');
    return super.parse(this.sectionsAsText ? withSectionsEscaped(xml) : xml, validation);
  }
}

/** A parser of XML as text */
export interface XmlTextParser {
  parse(xml: string): ReturnType<XMLParser['parse']>;
}

/** A parser with `options` that reads text and values as XML does (see the
 *  file's header), its own processors of text and values in place of any
 *  `options` has */
export const xmlParser = (options: X2jOptions): XmlTextParser => new ReferenceParser(options);

/** Text written for XML: the characters markup reads as entities, and a
 *  carriage return, which a reader would read as a line feed, as a
 *  reference */
const escapeXmlText = (text: string) => text.replace(/[&<>"'\r]/g, character => ESCAPES[character]);
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;', '\t': '&#9;', '\n': '&#xA;', '\r': '&#xD;' };

/** An attribute's value written for XML between double quotes: the
 *  characters markup reads as entities there, & < > ", and a tab, line feed
 *  or carriage return, which a reader would read as a space (XML 1.0
 *  §3.3.3), as a reference. An apostrophe, which ends no value between
 *  double quotes, stays as it is, as Word writes it, and as export did, so
 *  that its readers of a template's text, which export may have written,
 *  read it as before */
export const escapeXmlAttribute = (value: string): string => value.replace(/[&<>"\t\n\r]/g, character => ESCAPES[character]);

/** A builder with `options` that writes what xmlParser read as it was (see
 *  the file's header), its own processors of text and values in place of
 *  any `options` has */
export const xmlBuilder = (options: XmlBuilderOptions): XMLBuilder => new XMLBuilder({
  ...options,
  processEntities: false,
  tagValueProcessor: (_name, value) => typeof value === 'string' ? escapeXmlText(value) : value,
  attributeValueProcessor: (_name, value) => typeof value === 'string' ? escapeXmlAttribute(value) : value,
});
