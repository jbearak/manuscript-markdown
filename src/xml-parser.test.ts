import { describe, it, expect } from 'bun:test';
import JSZip from 'jszip';
import { convertDocx, extractZoteroPrefs } from './converter';
import { convertMdToDocx } from './md-to-docx';
import { escapeXmlAttribute, hasNonXmlCharacter, withoutNonXmlCharacters, xmlBuilder, xmlParser, xmlTextValue } from './xml-parser';
import { fastestRun } from './test-timing';
import { xmlAttribute } from './xml-elements';

// More than fast-xml-parser's default limit of a thousand references to
// entities, of which every &lt;, &gt;, &quot; and &apos; counts
const MANY = 1001;

const OPTIONS = { ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, parseTagValue: false, parseAttributeValue: false, trimValues: false };

describe('a parser xmlParser builds', () => {
  it('reads each reference to a character, and to one of the five entities, once, and leaves another as it is', () => {
    // &amp;lt; is the text &lt;, and &#38;#65; the text &#65;. &#0; and
    // &#xFFFE; are no characters of XML's, and &nbsp; an entity XML doesn't
    // declare. &#X43;, with an X XML doesn't allow, is read as import read it
    const [a] = xmlParser(OPTIONS).parse('<a b="&#65;&#x42;&#X43;&amp;lt;&#38;#65;&#0;&nbsp;&apos;&quot;&gt;">&#65;&amp;amp;&#xFFFE;&#x1F600;</a>');
    expect(a[':@']['@_b']).toBe('ABC&lt;&#65;&#0;&nbsp;\'">');
    expect(a.a[0]['#text']).toBe('A&amp;&#xFFFE;\u{1F600}');
  });

  it('refuses XML with a DOCTYPE, which no part of a package has, but reads one a comment, an instruction or a character data section holds', () => {
    // The entities one declares were read, but not as XML reads them, a tab
    // in an attribute's value as a space, nor a carriage return in text as
    // a line feed, and a ] in a value ended its declarations. A package's
    // XML has no DOCTYPE (ECMA-376 Part 2 §8.1.4), so none is read
    for (const xml of ['<!DOCTYPE a [<!ENTITY t "\t">]><a b="&t;"/>', '<!DOCTYPE a [<!ENTITY r "\r">]><a>&r;</a>', '<!DOCTYPE a [<!ENTITY e "]">]><a>&e;</a>', '<!DOCTYPE a><a/>', '<a/><!DOCTYPE a>']) {
      expect(() => xmlParser(OPTIONS).parse(xml)).toThrow(/DOCTYPE/);
    }
    const [a] = xmlParser(OPTIONS).parse('<a><!-- <!DOCTYPE x> --><?p <!DOCTYPE y>?><![CDATA[<!DOCTYPE z>]]>&amp;x;</a>');
    expect(a.a.filter((node: object) => '#text' in node).map((text: { '#text': string }) => text['#text']).join('')).toBe('<!DOCTYPE z>&x;');
    // Nor is a reference to an entity XML doesn't declare, of a name an
    // object has either
    expect(xmlParser(OPTIONS).parse('<a>&constructor;&__proto__;</a>')[0].a[0]['#text']).toBe('&constructor;&__proto__;');
  });

  it('reads an attribute\'s tab, line feed and carriage return as spaces, as XML does (XML 1.0 §3.3.3), but not text\'s', () => {
    const [a] = xmlParser(OPTIONS).parse('<a b="1\t2\n3\r\n4\r5&#9;6">1\t2\n3\r\n4</a>');
    expect(a[':@']['@_b']).toBe('1 2 3 4 5\t6');
    expect(a.a[0]['#text']).toBe('1\t2\n3\n4');
  });

  // xmlAttribute, which reads a template's styles, reads a value as the
  // parser does, so export writes back the value Word reads
  it.each([
    ['a tab, line feed and carriage return written as themselves', '1\t2\n3\r4'],
    ['a line end of a carriage return and a line feed', '1\r\n2'],
    ['each written as a reference', '1&#9;2&#xA;3&#13;4'],
    ['references that are no character of XML\'s, or to no entity XML declares', '&#0;&#xFFFE;&nbsp;&#X43;'],
    ['an escaped reference', '&amp;#65;&amp;amp;'],
  ])('reads %s in an attribute as xmlAttribute does', (_name, value) => {
    const [a] = xmlParser(OPTIONS).parse('<a b="' + value + '"/>');
    expect(xmlAttribute('<a b="' + value + '"/>', 'b')).toBe(a[':@']['@_b']);
  });

  // xmlTextValue, which reads a template's field codes, reads text as the
  // parser does, and each as XML reads it
  it.each([
    ['a tab, line feed and carriage return written as themselves', '1\t2\n3\r4', '1\t2\n3\n4'],
    ['a line end of a carriage return and a line feed', '1\r\n2', '1\n2'],
    ['each written as a reference', '1&#9;2&#xA;3&#13;4', '1\t2\n3\r4'],
    ['references that are no character of XML\'s, or to no entity XML declares', '&#0;&#x110000;&nbsp;&AMP;&#X43;', '&#0;&#x110000;&nbsp;&AMP;C'],
    ['an escaped reference', '&amp;#65;&amp;amp;', '&#65;&amp;'],
  ])('reads %s in text as xmlTextValue does', (_name, text, expected) => {
    const [a] = xmlParser(OPTIONS).parse('<a>' + text + '</a>');
    expect(xmlTextValue(text)).toBe(expected);
    expect(a.a[0]['#text']).toBe(expected);
  });

  it('reads more than a thousand references to entities, which fast-xml-parser\'s default limit refuses', () => {
    const xml = '<a b="' + '&quot;'.repeat(MANY) + '">' + '&lt;'.repeat(MANY) + '</a>';
    expect(xmlParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml)).toEqual({ a: { '#text': '<'.repeat(MANY), '@_b': '"'.repeat(MANY) } });
  });

  it('reads a character data section as it is', () => {
    const [a] = xmlParser(OPTIONS).parse('<a>&amp;<![CDATA[&amp;&#65;]]>&#65;</a>');
    expect(a.a.map((text: { '#text': string }) => text['#text']).join('')).toBe('&&amp;&#65;A');
  });

  it('refuses bytes, which it would read with no section kept as it is', () => {
    const bytes = Buffer.from('<a><![CDATA[&amp;&#65;]]></a>') as unknown as string;
    expect(() => xmlParser(OPTIONS).parse(bytes)).toThrow(TypeError);
  });
});

describe('a builder xmlBuilder builds', () => {
  it('writes what the parser read as it was, an attribute\'s white space too, which it writes as references', () => {
    const xml = '<a b="1 2&#9;3&#xA;4&#xD;5&amp;6&lt;7&gt;8&quot;9\'">x\ty\nz&#xD;&amp;&lt;&gt;</a>';
    expect(xmlBuilder(OPTIONS).build(xmlParser(OPTIONS).parse(xml))).toBe(xml);
  });

  it('escapes an attribute\'s tab, line feed and carriage return, which a reader would read as spaces, and the characters markup reads between double quotes, but an apostrophe', () => {
    // Export wrote an apostrophe as itself, as Word does, and reads a
    // template's fonts as their text, so &apos; would come back as its text
    expect(escapeXmlAttribute('a\tb\nc\rd&<>"\'e')).toBe('a&#9;b&#xA;c&#xD;d&amp;&lt;&gt;&quot;\'e');
  });

  it('reads and writes a long run of references in linear time', () => {
    const parser = xmlParser(OPTIONS), builder = xmlBuilder(OPTIONS);
    const xml = '<a b="' + '&#9;&amp;'.repeat(100000) + '">' + '&#x2019;&lt;'.repeat(100000) + '</a>';
    expect(fastestRun(() => builder.build(parser.parse(xml)))).toBeLessThan(1000);
  }, 30000);
});

describe('import of a part with more than a thousand references to entities', () => {
  it('reads a document\'s text', async () => {
    // A guard: import's parser of a document had settings of its own, with
    // no cap, which xmlParser's are
    const md = Array.from({ length: 600 }, (_, i) => 'A < B > C ' + i).join('\n\n');
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/&(?:lt|gt|quot|apos);/g)!.length).toBeGreaterThan(1000);
    const md1 = (await convertDocx(docx)).markdown;
    expect(md1).toContain('C 599');
    expect((await convertDocx((await convertMdToDocx(md1)).docx)).markdown).toBe(md1);
  });

  it('reads the citation style of Zotero\'s preferences of data version 3', async () => {
    // Its parser had fast-xml-parser's default limit, and read no style
    const prefs = '<data data-version="3" zotero-version="5.0"><session id="abc"/>'
      + '<style id="http://www.zotero.org/styles/apa" locale="en-US" hasBibliography="1"/>'
      + '<prefs><pref name="note" value="' + '&apos;'.repeat(MANY) + '"/><pref name="noteType" value="0"/></prefs></data>';
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const zip = new JSZip();
    zip.file('docProps/custom.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
      + '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ZOTERO_PREF_1"><vt:lpwstr>' + escape(prefs) + '</vt:lpwstr></property></Properties>');
    expect((await extractZoteroPrefs(zip))?.styleId).toBe('http://www.zotero.org/styles/apa');
  });
});

describe('XML\'s characters', () => {
  // UTF-16 units at the edges of XML's characters and of the surrogates,
  // and those Bun 1.3.9's regular expressions with the u flag read two of
  // as one character past U+FFFF: one from U+F800 to U+FBFF, or a lead
  // surrogate, and one from U+FC00 to U+FFFF, or a trail surrogate, after it
  const UNITS = [0x0, 0x8, 0x9, 0xA, 0xD, 0x1F, 0x20, 0x41, 0xD7FF, 0xD800, 0xDBFF, 0xDC00, 0xDFFF, 0xE000,
    0xF7FF, 0xF800, 0xF8FF, 0xF900, 0xFB01, 0xFBFF, 0xFC00, 0xFE0F, 0xFF0C, 0xFFFD, 0xFFFE, 0xFFFF];
  const isXml = (code: number) => code === 0x9 || code === 0xA || code === 0xD || code >= 0x20 && code <= 0xD7FF
    || code >= 0xE000 && code <= 0xFFFD || code >= 0x10000 && code <= 0x10FFFF;
  /** Text's characters, as UTF-16 writes them, a lone surrogate as itself */
  const characters = (text: string) => {
    const out: string[] = [];
    for (let i = 0; i < text.length; i++) {
      const pair = /^[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text.slice(i, i + 2));
      out.push(text.slice(i, pair ? i + 2 : i + 1));
      if (pair) i++;
    }
    return out;
  };

  it('are found and removed by code point, in every text of one to three of the units at their edges', () => {
    // Bun 1.3.9 read U+F8FF U+FFFE as one character, which XML allows, with
    // a regular expression's u flag, so export kept U+FFFE
    const texts = UNITS.flatMap(a => [[a], ...UNITS.flatMap(b => [[a, b], ...UNITS.map(c => [a, b, c])])]).map(units => String.fromCharCode(...units));
    const wrong = texts.filter(text => {
      const kept = characters(text).filter(character => isXml(character.codePointAt(0)!));
      const removed = withoutNonXmlCharacters(text);
      return hasNonXmlCharacter(text) !== (kept.join('') !== text) || removed.text !== kept.join('') || removed.removed !== characters(text).length - kept.length;
    });
    expect(wrong.map(text => [...text].map(c => c.charCodeAt(0).toString(16)).join(' '))).toEqual([]);
  });
});
