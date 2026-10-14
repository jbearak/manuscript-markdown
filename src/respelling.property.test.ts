import { describe, expect, it, test } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';
import { canonicalParts, respellDocx } from './test-respell';
import { xmlAttribute, xmlStartTag } from './xml-elements';

// XML spells one document many ways: with whitespace inside a tag, an
// attribute's value in either quotes, a > or the other quote in it as it
// is or escaped, a character as a reference, a namespace declared again on
// an element inside, and comments, CDATA sections and processing
// instructions between elements, whose text may look like elements.
// Import, and export, which reads a template's styles and numbering, read
// them as an XML parser does (see xml-elements.ts and xml-parser.ts), so
// what they make of them doesn't depend on how they're spelled. This makes
// templates of what they read there: Normal's size in the document
// defaults, headings based on headings, fonts for other scripts holding a
// >, theme fonts, tracked changes' records, a style a list links to, a
// heading style of another language's ID, numbering of more character
// references than a parser's default cap, Normal's character spacing
// beside its paragraph spacing, a default table style that gives tables a
// size, and a header with a list. It spells their styles and numbering
// otherwise (see TEMPLATE_PARTS), their numbers too, as a size or a numId
// (see test-respell.ts), and checks that import gives the Markdown, and
// export with the template the document, that it gives for the template as
// written. And as a style's ID is a name like any other, it gives the
// template's styles IDs that hold what XML escapes, a tab and line ends
// among it, and checks that import and export give what they give for
// plain IDs.

/** The parts of a template respelled: its styles and its numbering */
const TEMPLATE_PARTS = (path: string) => path === 'word/styles.xml' || path === 'word/numbering.xml';

/** What templates and documents hold: headings, a title, bullets, numbers
 *  and numbers from 3, which take an instance of the template's, a table,
 *  code, a quote, an alert and a custom style */
const BODY = '# One\n\n## Two\n\n### Three\n\nText with **bold**, a [link](https://example.com/?a=1&b=2), and `code`.\n\n'
  + '- a\n- b\n\n1. c\n2. d\n\nThen.\n\n3. e\n4. f\n\n| x | y |\n|---|--:|\n| 1 | 2 |\n\n```\ncode\n```\n\n> quote\n\n> [!NOTE]\n> Note.\n\n'
  + '<!-- style: pullquote -->\n\nPulled.\n\n<!-- /style -->\n';

/** The template's own frontmatter, its fonts' names holding what XML escapes */
const TEMPLATE_FRONTMATTER = [
  'title: T',
  'title: T\nfont: "A > B"\nheader-font: "O\'Reilly Sans"\ntitle-font: \'Q "x"\'',
  'font-size: 12\nheader-font-size: [20, 16]\ncode-font: Courier New\nheader-font-style: [bold-center, italic]',
  'styles:\n  pullquote:\n    font: "C & D"\n    font-size: 13\n    font-style: italic\ntable-font: Georgia\ntable-font-size: 9',
];

/** What a template has beyond what export writes */
interface Variant {
  frontmatter: string;
  /** Normal's size in the document defaults, and none in Normal */
  defaultsSize?: number;
  /** Heading 2 based on Heading 1, and Heading 3 on Heading 2 */
  chain: boolean;
  /** Heading 1's and the title's font for East Asian text, which holds a > */
  eastAsia: boolean;
  /** Heading 2's font the theme's */
  theme: boolean;
  /** Tracked changes' records in Heading 1, Normal and the document
   *  defaults, by an author whose name holds a > and quotes */
  records: boolean;
  /** Bullets' instance numbered through a numbering style it links to
   *  (w:numStyleLink) */
  linked: boolean;
  /** Numbering with abstract numberings of more character references, in
   *  their levels' text, than a parser takes by default */
  references: boolean;
  /** Normal's character spacing, a w:spacing in its rPr, which isn't the
   *  paragraph spacing export sets */
  characterSpacing: boolean;
  /** A default table style other than Normal Table that gives tables' text
   *  a size, between the document defaults and the table's paragraphs'
   *  style */
  tableStyle: boolean;
  /** A header with a paragraph of a list only it uses, and a drawing,
   *  whose ID export gives anew, whose numbering export keeps */
  header: boolean;
}

const variantArb: fc.Arbitrary<Variant> = fc.record({
  frontmatter: fc.constantFrom(...TEMPLATE_FRONTMATTER),
  defaultsSize: fc.constantFrom(undefined, 22, 24, 26),
  chain: fc.boolean(),
  eastAsia: fc.boolean(),
  theme: fc.boolean(),
  records: fc.boolean(),
  linked: fc.boolean(),
  references: fc.boolean(),
  characterSpacing: fc.boolean(),
  tableStyle: fc.boolean(),
  header: fc.boolean(),
});

/** The IDs of Heading 1, as Word in another language gives it, and of the
 *  style bullets link to */
interface StyleIds { heading: string; list: string }

const PLAIN_IDS: StyleIds = { heading: 'Berschrift1', list: 'LinkedList' };
/** IDs that hold what XML escapes, a tab and line ends, which an attribute
 *  holds as references, and a character outside ASCII, which a respelling
 *  can write as one */
const SPECIAL_IDS: StyleIds = { heading: 'Über"schrift\'\t1', list: 'O\'Reilly&"Co">\n\r1' };

/** An attribute's value as canonicalXml writes it */
const escapeXml = (text: string) => text.replace(/[&<>"\t\n\r]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#x9;', '\n': '&#xA;', '\r': '&#xD;' } as Record<string, string>)[c]);

/** `xml` with the style `id`'s element as `edit` gives it, as export writes
 *  it */
const editStyle = (xml: string, id: string, edit: (style: string) => string) =>
  xml.replace(new RegExp('<w:style [^>]*w:styleId="' + id + '"[^>]*>[\\s\\S]*?</w:style>'), edit);

/** A style's rPr with `rFonts` set in its w:rFonts, or one first */
const withRFonts = (style: string, rFonts: (tag: string | undefined) => string) => /<w:rFonts [^>]*\/>/.test(style)
  ? style.replace(/<w:rFonts [^>]*\/>/, tag => rFonts(tag))
  : /<w:rPr>/.test(style) ? style.replace('<w:rPr>', () => '<w:rPr>' + rFonts(undefined)) : style.replace('</w:style>', () => '<w:rPr>' + rFonts(undefined) + '</w:rPr></w:style>');

const AUTHOR = ' w:author="A &gt; B &quot;Q&quot; \'R\'" w:date="2024-01-01T00:00:00Z"';

/** A template export makes of `variant`, its styles' IDs `ids` */
async function template(variant: Variant, ids: StyleIds): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync((await convertMdToDocx('---\n' + variant.frontmatter + '\n---\n\n' + BODY)).docx);
  let styles = await zip.file('word/styles.xml')!.async('string');
  let numbering = await zip.file('word/numbering.xml')!.async('string');
  let document = await zip.file('word/document.xml')!.async('string');
  if (variant.defaultsSize !== undefined) {
    const size = '<w:sz w:val="' + variant.defaultsSize + '"/><w:szCs w:val="' + variant.defaultsSize + '"/>';
    styles = editStyle(styles, 'Normal', style => style.replace(/<w:sz w:val="\d+"\/><w:szCs w:val="\d+"\/>/, '').replace('<w:rPr></w:rPr>', ''))
      .replace(/(<w:rPrDefault>[\s\S]*?)<w:sz w:val="\d+"\/><w:szCs w:val="\d+"\/>/, (_match, before: string) => before + size);
  }
  if (variant.chain) {
    styles = editStyle(styles, 'Heading2', style => style.replace('<w:basedOn w:val="Normal"/>', '<w:basedOn w:val="Heading1"/>'));
    styles = editStyle(styles, 'Heading3', style => style.replace('<w:basedOn w:val="Normal"/>', '<w:basedOn w:val="Heading2"/>'));
  }
  if (variant.eastAsia) {
    for (const id of ['Heading1', 'Title']) {
      styles = editStyle(styles, id, style => withRFonts(style, tag => tag ? tag.replace('/>', ' w:eastAsia="A &gt; B"/>') : '<w:rFonts w:eastAsia="A &gt; B"/>'));
    }
  }
  if (variant.theme) styles = editStyle(styles, 'Heading2', style => withRFonts(style, () => '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/>'));
  if (variant.records) {
    styles = editStyle(styles, 'Heading1', style => style.replace('</w:rPr>', '<w:rPrChange w:id="901"' + AUTHOR + '><w:rPr><w:i/><w:sz w:val="30"/></w:rPr></w:rPrChange></w:rPr>'));
    styles = editStyle(styles, 'Normal', style => style.replace('</w:pPr>', '<w:pPrChange w:id="902"' + AUTHOR + '><w:pPr><w:jc w:val="center"/></w:pPr></w:pPrChange></w:pPr>'));
    styles = styles.replace('</w:rPr></w:rPrDefault>', '<w:rPrChange w:id="903"' + AUTHOR + '><w:rPr><w:sz w:val="40"/></w:rPr></w:rPrChange></w:rPr></w:rPrDefault>');
  }
  if (variant.linked) {
    // numId 1's abstract numbering links to the style, whose numId 3 is of
    // the bullets' abstract numbering, so bullets take numId 1 as it is
    numbering = numbering.replace('<w:num ', '<w:abstractNum w:abstractNumId="100"><w:numStyleLink w:val="' + escapeXml(ids.list) + '"/></w:abstractNum>\n<w:num ')
      .replace(/(<w:num w:numId="1"[^>]*>)<w:abstractNumId w:val="0"\/>/, (_match, start: string) => start + '<w:abstractNumId w:val="100"/>')
      .replace('</w:numbering>', '<w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num>\n</w:numbering>');
    styles = styles.replace('</w:styles>', '<w:style w:type="numbering" w:styleId="' + escapeXml(ids.list) + '"><w:name w:val="Linked List"/>'
      + '<w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr></w:style></w:styles>');
  }
  if (variant.references) {
    // 120 of nine levels each, whose text is an A written as a reference
    const levels = Array.from({ length: 9 }, (_, k) => '<w:lvl w:ilvl="' + k + '"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="&#65;"/></w:lvl>').join('');
    numbering = numbering.replace('<w:num ', () => Array.from({ length: 120 }, (_, k) => '<w:abstractNum w:abstractNumId="' + (200 + k) + '">' + levels + '</w:abstractNum>\n').join('') + '<w:num ');
  }
  if (variant.characterSpacing) {
    // In its rPr's schema order, before the size
    styles = editStyle(styles, 'Normal', style => /<w:sz /.test(style) ? style.replace('<w:sz ', '<w:spacing w:val="20"/><w:sz ')
      : /<w:rPr>/.test(style) ? style.replace('</w:rPr>', '<w:spacing w:val="20"/></w:rPr>') : style.replace('</w:style>', '<w:rPr><w:spacing w:val="20"/></w:rPr></w:style>'));
  }
  if (variant.tableStyle) {
    styles = editStyle(styles, 'TableNormal', style => style.replace(' w:default="1"', ''))
      .replace('</w:styles>', '<w:style w:type="table" w:default="1" w:styleId="PlainTable"><w:name w:val="Plain Table"/>'
        + '<w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:tblPr/></w:style></w:styles>');
  }
  if (variant.header) {
    // numId 9, which only the header uses, and a drawing whose ID export
    // gives anew, from 1
    numbering = numbering.replace('</w:numbering>', '<w:num w:numId="9"><w:abstractNumId w:val="1"/></w:num>\n</w:numbering>');
    zip.file('word/header1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
      + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr></w:pPr><w:r><w:t>Head</w:t></w:r></w:p>'
      + '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="5" name="Shape 5"/>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"/></a:graphic></wp:inline></w:drawing></w:r></w:p></w:hdr>');
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    zip.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rId900" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'));
    const types = await zip.file('[Content_Types].xml')!.async('string');
    zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'));
    document = document.replace(/(<w:sectPr\b[^>]*>)(?![\s\S]*<w:sectPr\b)/, (_match, start: string) => start + '<w:headerReference w:type="default" r:id="rId900"/>');
  }
  // Heading 1 by another ID, which its name, heading 1, makes it
  const headingId = (xml: string) => xml.replace(/(w:styleId|w:val)="Heading1"/g, (_match, name: string) => name + '="' + escapeXml(ids.heading) + '"');
  zip.file('word/styles.xml', headingId(styles));
  zip.file('word/numbering.xml', numbering);
  zip.file('word/document.xml', headingId(document));
  return zip.generateAsync({ type: 'uint8array' });
}

/** The frontmatter of the document exported with a template: fonts whose
 *  names hold what XML escapes, sizes, one a heading's base may give, font
 *  styles, and what changes a template's Normal, code, tables, quotes,
 *  alerts and custom styles */
const frontmatterArb: fc.Arbitrary<string> = fc.record({
  font: fc.constantFrom(undefined, 'Garamond', '"A > B"'),
  'header-font': fc.constantFrom(undefined, 'Helvetica', '\'O\'Reilly & "Co"\''),
  'header-font-size': fc.constantFrom(undefined, '10', '[10, 14]', '[20, 10]', '[12, 11]'),
  'header-font-style': fc.constantFrom(undefined, '[bold-center, italic]', 'normal', '[underline, smallcaps]'),
  title: fc.constantFrom(undefined, 'New'),
  'title-font': fc.constantFrom(undefined, 'Didot'),
  'font-size': fc.constantFrom(undefined, '12'),
  'code-font': fc.constantFrom(undefined, 'Courier New'),
  'table-font': fc.constantFrom(undefined, 'Georgia'),
  'line-spacing': fc.constantFrom(undefined, '1.5'),
  colors: fc.constantFrom(undefined, 'github'),
  styles: fc.constantFrom(undefined, '\n  pullquote:\n    font: Baskerville\n    font-style: italic'),
}).map(fields => Object.entries(fields).filter(([, value]) => value !== undefined)
  .map(([key, value]) => key + ':' + (value!.startsWith('\n') ? '' : ' ') + value).join('\n'));

const exportWith = async (md: string, templateDocx: Uint8Array) => canonicalParts((await convertMdToDocx(md, { templateDocx })).docx);
const importOf = async (docx: Uint8Array) => (await convertDocx(docx)).markdown;

/** Each part of `actual` against `expected`'s, by path */
function expectSameParts(actual: Record<string, string>, expected: Record<string, string>) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const path of Object.keys(expected)) expect([path, actual[path]]).toEqual([path, expected[path]]);
}

describe('A template spelled otherwise', () => {
  test('imports, and exports a document, as it does as written', async () => {
    await fc.assert(fc.asyncProperty(variantArb, fc.boolean(), frontmatterArb, fc.integer({ min: 1, max: 0x7fffffff }), async (variant, special, frontmatter, seed) => {
      const templateDocx = await template(variant, special ? SPECIAL_IDS : PLAIN_IDS);
      const respelled = await respellDocx(templateDocx, seed, TEMPLATE_PARTS);
      expect(await importOf(respelled)).toBe(await importOf(templateDocx));
      const md = '---\n' + frontmatter + '\n---\n\n' + BODY;
      const exported = await exportWith(md, templateDocx);
      expectSameParts(await exportWith(md, respelled), exported);
      // What export keeps of the template: Normal's character spacing, and
      // the instance the header's list takes
      if (variant.characterSpacing) expect(/<w:style [^>]*w:styleId="Normal"[\s\S]*?<\/w:style>/.exec(exported['word/styles.xml'])?.[0]).toMatch(/<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<w:spacing w:val="20"\/>/);
      if (variant.header) expect(exported['word/numbering.xml']).toContain('<w:num w:numId="9"><w:abstractNumId w:val="1"/></w:num>');
    }), { numRuns: 30 });
  }, 120000);

  test.each(readdirSync(join(__dirname, '..', 'test', 'fixtures')).filter(name => name.endsWith('.docx')).sort())('%s imports, and exports a document, as it does as written', async name => {
    const templateDocx = new Uint8Array(readFileSync(join(__dirname, '..', 'test', 'fixtures', name)));
    const md = '---\nfont: Garamond\nheader-font-size: [10, 14]\nheader-font-style: [bold-center, italic]\n---\n\n' + BODY;
    const markdown = await importOf(templateDocx);
    const exported = await exportWith(md, templateDocx);
    for (const seed of [1, 2, 3]) {
      const respelled = await respellDocx(templateDocx, seed * 7919, TEMPLATE_PARTS);
      expect(await importOf(respelled)).toBe(markdown);
      expectSameParts(await exportWith(md, respelled), exported);
    }
  }, 60000);
});

describe('A template whose style IDs hold what XML escapes', () => {
  /** `text` with each special ID, as canonicalParts writes it in an
   *  attribute, and as it is, the plain one's */
  const plain = (text: string) => (['heading', 'list'] as const).reduce((out, key) =>
    out.split('"' + escapeXml(SPECIAL_IDS[key]) + '"').join('"' + PLAIN_IDS[key] + '"').split(SPECIAL_IDS[key]).join(PLAIN_IDS[key]), text);

  test('imports, and exports a document, as it does with plain IDs', async () => {
    await fc.assert(fc.asyncProperty(variantArb, frontmatterArb, async (variant, frontmatter) => {
      const special = await template(variant, SPECIAL_IDS);
      const plainIds = await template(variant, PLAIN_IDS);
      expect(plain(await importOf(special))).toBe(await importOf(plainIds));
      const md = '---\n' + frontmatter + '\n---\n\n' + BODY;
      const exported = await exportWith(md, special);
      expectSameParts(Object.fromEntries(Object.entries(exported).map(([path, xml]) => [path, plain(xml)])), await exportWith(md, plainIds));
    }), { numRuns: 20 });
  }, 120000);
});

describe('A template whose XML holds what an XML parser reads otherwise than its text looks', () => {
  /** A template whose styles.xml `edit` gives, from an export */
  const withStylesXml = async (edit: (styles: string) => string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('# One\n\nText.\n')).docx);
    zip.file('word/styles.xml', edit(await zip.file('word/styles.xml')!.async('string')));
    return zip.generateAsync({ type: 'uint8array' });
  };
  const documentOf = async (docx: Uint8Array) => (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');

  // A comment's text is no style, though it looks like one: Heading 1 is the
  // style after it of the name heading 1
  it('gives headings the style named heading 1 after a comment that looks like one', async () => {
    const templateDocx = await withStylesXml(styles => styles.replace(/<w:style\b[^>]*w:styleId="Heading1"/, style =>
      '<!-- <w:style w:type="paragraph" w:styleId="GhostHeading"><w:name w:val="heading 1"/></w:style> -->' + style.replace('Heading1', 'RealHeading'))
      .replace(/w:val="Heading1"/g, 'w:val="RealHeading"'));
    const { docx } = await convertMdToDocx('# One\n', { templateDocx });
    const document = await documentOf(docx);
    expect(document).toContain('<w:pStyle w:val="RealHeading"/>');
    expect(document).not.toContain('GhostHeading');
    expect(await importOf(docx)).toBe(await importOf((await convertMdToDocx('# One\n')).docx));
  });

  // An XML parser reads a tab or line end written as it is in an attribute
  // as a space, and one written as a reference as itself, so export gives
  // the headings the style's ID as Word reads it
  it.each([
    ['a line feed', '&#xA;', '\n'],
    ['a tab', '&#x9;', '\t'],
    ['a carriage return', '&#xD;', '\r'],
    ['a tab written as itself', '\t', ' '],
    ['a line feed written as itself', '\n', ' '],
  ])('gives headings the template\'s style whose ID holds %s', async (_name, written, read) => {
    const id = 'My' + written + 'Heading';
    const templateDocx = await withStylesXml(styles => styles.replace('w:styleId="Heading1"', 'w:styleId="' + id + '"').replace(/w:val="Heading1"/g, 'w:val="' + id + '"'));
    const { docx } = await convertMdToDocx('# One\n', { templateDocx });
    expect(xmlAttribute(xmlStartTag(await documentOf(docx), 'w:pStyle')!.tag, 'w:val')).toBe('My' + read + 'Heading');
    expect(await importOf(docx)).toBe(await importOf((await convertMdToDocx('# One\n')).docx));
  });

  // Export adds its abstract numbering after the template's last, and the
  // whitespace and comments after it, where a comment that looks like its
  // end tag changes nothing
  it('adds numbering after a comment after the template\'s last abstract numbering, as it does without it', async () => {
    const variant: Variant = { frontmatter: TEMPLATE_FRONTMATTER[0], defaultsSize: undefined, chain: false, eastAsia: false, theme: false, records: false, linked: true, references: false, characterSpacing: false, tableStyle: false, header: false };
    const templateDocx = await template(variant, PLAIN_IDS);
    const zip = await JSZip.loadAsync(templateDocx);
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    zip.file('word/numbering.xml', numbering.replace(/<\/w:abstractNum>(?![\s\S]*<\/w:abstractNum>)/, end => end + '<!-- </w:abstractNum> -->'));
    expectSameParts(await exportWith(BODY, await zip.generateAsync({ type: 'uint8array' })), await exportWith(BODY, templateDocx));
  });

  // Export's custom style takes the place of the template's, and what
  // follows it, whitespace and a comment, stays as it was
  it('replaces a custom style a comment follows as it does without the comment', async () => {
    const templateDocx = await template({ frontmatter: TEMPLATE_FRONTMATTER[3], defaultsSize: undefined, chain: false, eastAsia: false, theme: false, records: false, linked: false, references: false, characterSpacing: false, tableStyle: false, header: false }, PLAIN_IDS);
    const zip = await JSZip.loadAsync(templateDocx);
    const styles = await zip.file('word/styles.xml')!.async('string');
    const commented = styles.replace(/(<w:style [^>]*w:styleId="MsCustomPullquote"[\s\S]*?<\/w:style>)/, (_match, style: string) => style + '<!-- </w:style> -->');
    expect(commented).not.toBe(styles);
    zip.file('word/styles.xml', commented);
    const md = '---\nstyles:\n  pullquote:\n    font: Baskerville\n---\n\n' + BODY;
    expectSameParts(await exportWith(md, await zip.generateAsync({ type: 'uint8array' })), await exportWith(md, templateDocx));
  });
});
