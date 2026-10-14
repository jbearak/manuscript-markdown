import { describe, it, expect } from 'bun:test';
import { escapeXmlAttribute, xmlBuilder, xmlParser } from './xml-parser';
import { fastestRun } from './test-timing';

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
    const xml = '<a b="1 2&#9;3&#xA;4&#xD;5&amp;6&lt;7&gt;8&quot;9&apos;">x\ty\nz&#xD;&amp;&lt;&gt;</a>';
    expect(xmlBuilder(OPTIONS).build(xmlParser(OPTIONS).parse(xml))).toBe(xml);
  });

  it('escapes an attribute\'s tab, line feed and carriage return, which a reader would read as spaces, and the characters markup reads', () => {
    expect(escapeXmlAttribute('a\tb\nc\rd&<>"\'e')).toBe('a&#9;b&#xA;c&#xD;d&amp;&lt;&gt;&quot;&apos;e');
  });

  it('reads and writes a long run of references in linear time', () => {
    const parser = xmlParser(OPTIONS), builder = xmlBuilder(OPTIONS);
    const xml = '<a b="' + '&#9;&amp;'.repeat(100000) + '">' + '&#x2019;&lt;'.repeat(100000) + '</a>';
    expect(fastestRun(() => builder.build(parser.parse(xml)))).toBeLessThan(1000);
  }, 30000);
});
