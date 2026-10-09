import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

/**
 * Word reads a number an attribute holds by its value, whatever its
 * spelling, so import must too: an ID or index it matches or looks up, as
 * a list's w:numId or a comment's w:id, and a number it compares, as the
 * hanging indent export gives a task item. The respellings are those the
 * attribute's schema type allows, as an xsd:integer or xsd:unsignedLong:
 * leading zeros, a plus sign, and whitespace around the number, and, for a
 * measure, as a page's size, an indent or a font's size, a universal
 * measure that's the same size, as 18pt or 0.25in for 360 twips.
 */

// The attributes of what export writes that hold an integer, by element and
// attribute, as `w:numId@w:val`, and whether it may have a minus sign, as
// an xsd:integer (ST_DecimalNumber, ST_SignedTwipsMeasure, a DrawingML
// coordinate), or not, as an xsd:unsignedLong (ST_TwipsMeasure,
// ST_HpsMeasure, ST_EighthPointMeasure). Not those that look like numbers but
// are none: an ST_OnOff, as w:i's `0`, or hex digits, as a w14:paraId.
const SIGNED = [
  'w:commentRangeStart@w:id', 'w:commentRangeEnd@w:id', 'w:commentReference@w:id', 'w:comment@w:id',
  'w:ins@w:id', 'w:del@w:id', 'w:bookmarkStart@w:id', 'w:bookmarkEnd@w:id',
  'w:footnoteReference@w:id', 'w:endnoteReference@w:id', 'w:footnote@w:id', 'w:endnote@w:id',
  'w:numId@w:val', 'w:ilvl@w:val', 'w:num@w:numId', 'w:abstractNum@w:abstractNumId', 'w:abstractNumId@w:val',
  'w:lvl@w:ilvl', 'w:lvlOverride@w:ilvl', 'w:start@w:val', 'w:startOverride@w:val',
  'w:gridSpan@w:val', 'w:outlineLvl@w:val', 'w:uiPriority@w:val',
  'w:latentStyles@w:count', 'w:latentStyles@w:defUIPriority', 'w:lsdException@w:uiPriority',
  'w:ind@w:left', 'w:ind@w:right', 'w:spacing@w:line', 'w:pgMar@w:top', 'w:pgMar@w:bottom',
  'w:tblW@w:w', 'w:tcW@w:w', 'w:tblInd@w:w', 'w:top@w:w', 'w:bottom@w:w', 'w:left@w:w', 'w:right@w:w',
  'w:zoom@w:percent', 'wp:extent@cx', 'wp:extent@cy', 'a:ext@cx', 'a:ext@cy', 'a:off@x', 'a:off@y',
  'wp:effectExtent@l', 'wp:effectExtent@t', 'wp:effectExtent@r', 'wp:effectExtent@b',
];
const UNSIGNED = [
  'w:sz@w:val', 'w:szCs@w:val', 'w:kern@w:val',
  'w:top@w:sz', 'w:bottom@w:sz', 'w:left@w:sz', 'w:right@w:sz', 'w:insideH@w:sz', 'w:insideV@w:sz',
  'w:top@w:space', 'w:bottom@w:space', 'w:left@w:space', 'w:right@w:space', 'w:insideH@w:space', 'w:insideV@w:space',
  'w:cols@w:space', 'w:gridCol@w:w', 'w:ind@w:firstLine', 'w:ind@w:hanging',
  'w:pgMar@w:left', 'w:pgMar@w:right', 'w:pgMar@w:header', 'w:pgMar@w:footer', 'w:pgMar@w:gutter',
  'w:pgSz@w:w', 'w:pgSz@w:h', 'w:spacing@w:after', 'w:spacing@w:before', 'w:defaultTabStop@w:val',
  'm:lMargin@m:val', 'm:rMargin@m:val', 'm:wrapIndent@m:val',
  'wp:docPr@id', 'pic:cNvPr@id', 'wp:inline@distT', 'wp:inline@distB', 'wp:inline@distL', 'wp:inline@distR', 'a:ln@w',
];
const SIGNS = new Map([...SIGNED.map(name => [name, true] as const), ...UNSIGNED.map(name => [name, false] as const)]);

// What a measure of SIGNS is in, where its schema type may be a universal
// measure, a decimal number and a unit, as 0.25in: twips, as an
// ST_TwipsMeasure or ST_SignedTwipsMeasure; half-points, as an
// ST_HpsMeasure; or a width's unit, as an ST_MeasurementOrPercent, twips
// where its w:type is dxa. Not an ST_EighthPointMeasure or ST_PointMeasure,
// as a border's w:sz and w:space, nor a DrawingML coordinate, which have
// no unit.
type Measure = 'twips' | 'half-points';
const MEASURES = new Map<string, Measure | 'width'>([
  ...['w:ind@w:left', 'w:ind@w:right', 'w:ind@w:firstLine', 'w:ind@w:hanging', 'w:spacing@w:line', 'w:spacing@w:after', 'w:spacing@w:before',
    'w:pgSz@w:w', 'w:pgSz@w:h', 'w:pgMar@w:top', 'w:pgMar@w:bottom', 'w:pgMar@w:left', 'w:pgMar@w:right',
    'w:pgMar@w:header', 'w:pgMar@w:footer', 'w:pgMar@w:gutter', 'w:cols@w:space', 'w:gridCol@w:w', 'w:defaultTabStop@w:val',
    'm:lMargin@m:val', 'm:rMargin@m:val', 'm:wrapIndent@m:val'].map(name => [name, 'twips'] as const),
  ...['w:sz@w:val', 'w:szCs@w:val', 'w:kern@w:val'].map(name => [name, 'half-points'] as const),
  ...['w:tblW@w:w', 'w:tcW@w:w', 'w:tblInd@w:w', 'w:top@w:w', 'w:bottom@w:w', 'w:left@w:w', 'w:right@w:w'].map(name => [name, 'width'] as const),
]);

// Twips in each unit of a universal measure, as a fraction: a pica, pc or
// pi, is 12 points, an inch 72, and a centimeter 1/2.54 of an inch
const TWIPS_PER_UNIT: Record<string, [number, number]> = { in: [1440, 1], pt: [20, 1], pc: [240, 1], pi: [240, 1], cm: [144000, 254], mm: [14400, 254] };

/** p/q as a decimal number, as 0.25, where it's one with at most six
 *  digits after its point */
function decimal(p: number, q: number): string | undefined {
  for (let digits = 0; digits <= 6; digits++) {
    const scaled = Math.abs(p) * 10 ** digits;
    if (scaled % q !== 0) continue;
    const text = String(scaled / q).padStart(digits + 1, '0');
    return (p < 0 ? '-' : '') + text.slice(0, text.length - digits) + (digits ? '.' + text.slice(text.length - digits) : '');
  }
  return undefined;
}

/** A measure's whole number, `value`, as the universal measure in `unit`
 *  that's exactly its size, as 0.25in for 360 twips, or else in points,
 *  as 1 twip is 0.05pt but no finite decimal of inches. A size is in
 *  points, the one unit Word reads a size in. A number that's no measure
 *  stays as it is. */
function inUnit(value: string, measure: Measure | undefined, unit: string): string {
  if (!measure) return value;
  const n = Number(value);
  if (measure === 'half-points') return decimal(n, 2) + 'pt';
  const [twips, per] = TWIPS_PER_UNIT[unit];
  const exact = decimal(n * per, twips);
  return exact !== undefined ? exact + unit : decimal(n, 20) + 'pt';
}

/** The ways a number may be spelled, by its plain spelling, as `12` or
 *  `-1`, and what it's a measure of, if it's one */
const SPELLINGS: Record<string, (value: string, measure?: Measure) => string> = {
  plain: value => value,
  'a leading zero': value => value.replace(/\d/, '0$&'),
  'leading zeros': value => value.replace(/\d/, '00$&'),
  'a plus sign': value => value.startsWith('-') ? value : '+' + value,
  'whitespace around it': value => ' ' + value + ' ',
  'all of them': value => ' ' + (value.startsWith('-') ? '-00' + value.slice(1) : '+00' + value) + '\t',
  'points': (value, measure) => inUnit(value, measure, 'pt'),
  'inches': (value, measure) => inUnit(value, measure, 'in'),
  'picas': (value, measure) => inUnit(value, measure, 'pc'),
  'picas as pi': (value, measure) => inUnit(value, measure, 'pi'),
  'centimeters': (value, measure) => inUnit(value, measure, 'cm'),
  'millimeters': (value, measure) => inUnit(value, measure, 'mm'),
  'points with zeros': (value, measure) => {
    const spelled = inUnit(value, measure, 'pt');
    return measure ? spelled.replace(/\d/, '0$&').replace(/(\.\d+)?pt$/, (_unit, point?: string) => (point ?? '.') + '0pt') : spelled;
  },
};

/** The DOCX with each integer of its XML parts in the attributes `only`,
 *  or else in all of SIGNS, spelled as `spell` gives for it, what it's a
 *  measure of, and its place among them, in order */
async function respelled(docx: Uint8Array, spell: (value: string, measure: Measure | undefined, index: number) => string, only?: { part: string; attributes: string[] }): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);
  let index = 0;
  for (const name of Object.keys(zip.files).sort()) {
    if (!/^word\/.*\.xml$/.test(name) || only && name !== only.part) continue;
    const xml = await zip.file(name)!.async('string');
    zip.file(name, xml.replace(/<([\w:]+)(\s[^>]*)>/g, (_tag, element: string, attributes: string) => '<' + element
      + attributes.replace(/([\w:]+)="(-?\d+)"/g, (whole, attribute: string, value: string) => {
        const name = element + '@' + attribute;
        if (only ? !only.attributes.includes(name) : !SIGNS.has(name)) return whole;
        const measure = MEASURES.get(name);
        const twips = measure === 'width' ? /\sw:type="dxa"/.test(attributes) ? 'twips' : undefined : measure;
        return attribute + '="' + spell(value, twips, index++) + '"';
      }) + '>'));
  }
  return zip.generateAsync({ type: 'uint8array' });
}

// Each as import writes it, so that it comes back as it is
const LISTS = '1. First\n2. Second\n   1. Nested\n   2. Nested again\n3. Third\n\nBetween lists.\n\n5. Five\n6. Six\n\n- Bullet\n  - Sub bullet\n';
const TASKS = '- [ ] Task\n- [x] Done\n';
const NOTES = 'A note.[^1] Another.[^2] The first again.[^1]\n\n[^1]: The first, which refers on.[^3]\n\n[^2]: The second.\n\n[^3]: The third.\n';
const COMMENTS = 'A {==comment==}{>>@Ann (2024-01-01 10:00) | A note.<<} here.\n\nA range {#2}that goes on\n\nover two paragraphs{/2} and ends.\n{#2>>@Bob (2024-01-02 11:00) | Across.<<}\n';
const ALERT = 'Before.\n\n> [!NOTE]\n> An alert.\n\nAfter.\n';
const CODE = '```python\nprint("code")\n```\n\nAfter the code.\n';
// A quote the body ends with, which export pads with a spacer paragraph
// before the notes' definitions
const QUOTE = '> A quote at the end.[^1]\n\n[^1]: Its note.\n';
// The document's size, its headings' and its title's, a table's, and a
// custom style's spacing and indent
const SIZES = '---\nfont-size: 12\nstyles:\n  pullquote:\n    font-size: 13\n    spacing-before: 12\n    spacing-after: 6\n    paragraph-indent: 0.25\n'
  + 'header-font-size: [17.5, 14, 13, 12, 11, 10]\ntitle-font-size: 30.5\n---\n\n<!-- style: pullquote -->\n\nStyled text.\n\n<!-- /style -->\n\n'
  + '<!-- table-font-size: 7 -->\n| A | B |\n| --- | --- |\n| a | b |\n';
const DOCUMENTS: Record<string, string> = {
  'lists': LISTS + '\n' + TASKS,
  'notes and comments': NOTES.replace('\n\n[^1]', '\n\n' + COMMENTS + '\n[^1]'),
  'endnotes': '---\nnotes: endnotes\n---\n\n' + NOTES,
  'a quote before notes': QUOTE,
  'sizes': SIZES,
  'blocks': '# Heading\n\n' + ALERT + '\n' + CODE + '\n| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |\n\n'
    + '<table>\n<tr><th colspan="2">Merged</th></tr>\n<tr><td rowspan="2">R</td><td>1</td></tr>\n<tr><td>2</td></tr>\n</table>\n\n'
    + 'Text with {++an insertion++} and {--a deletion--}, and math $x^2$.\n\n<!-- landscape -->\n\nWide.\n\n<!-- /landscape -->\n\n'
    + '![A picture](sample.png){width=1in}\n',
};

const exported = new Map<string, Promise<{ docx: Uint8Array; markdown: string }>>();
/** A Markdown document's DOCX, and the Markdown import gives for it */
function exportedOf(markdown: string): Promise<{ docx: Uint8Array; markdown: string }> {
  let found = exported.get(markdown);
  if (!found) {
    found = (async () => {
      const { docx } = await convertMdToDocx(markdown, { sourceDir: import.meta.dir + '/..' });
      return { docx, markdown: (await convertDocx(docx)).markdown };
    })();
    exported.set(markdown, found);
  }
  return found;
}

describe('Numbers in attributes, whatever their spelling', () => {
  it('imports a document whose numbers are respelled as it imports the document', async () => {
    // Each number in its own spelling, so an ID and its reference may differ
    const names = Object.keys(SPELLINGS);
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...Object.keys(DOCUMENTS)),
      fc.array(fc.constantFrom(...names), { minLength: 1, maxLength: 64 }),
      async (document, choices) => {
        const { docx, markdown } = await exportedOf(DOCUMENTS[document]);
        const again = await respelled(docx, (value, measure, index) => SPELLINGS[choices[index % choices.length]](value, measure));
        expect((await convertDocx(again)).markdown).toBe(markdown);
      },
    ), { numRuns: 40 });
  }, 60000);

  it.each(Object.keys(DOCUMENTS))('imports %s with every number in every spelling as it imports the document', async (document) => {
    const { docx, markdown } = await exportedOf(DOCUMENTS[document]);
    for (const spelling of Object.values(SPELLINGS)) {
      expect((await convertDocx(await respelled(docx, spelling))).markdown).toBe(markdown);
    }
  });

  it.each([
    ['a list paragraph\'s w:numId with a leading zero', LISTS, 'word/document.xml', ['w:numId@w:val'], 'a leading zero'],
    ['a list paragraph\'s w:ilvl with a plus sign', LISTS, 'word/document.xml', ['w:ilvl@w:val'], 'a plus sign'],
    ['a list instance\'s w:numId with a leading zero', LISTS, 'word/numbering.xml', ['w:num@w:numId'], 'a leading zero'],
    ['an abstract numbering\'s w:abstractNumId with whitespace around it', LISTS, 'word/numbering.xml', ['w:abstractNum@w:abstractNumId'], 'whitespace around it'],
    ['a numbering level\'s w:ilvl with leading zeros', LISTS, 'word/numbering.xml', ['w:lvl@w:ilvl'], 'leading zeros'],
    ['a task item\'s hanging indent with a leading zero', TASKS, 'word/document.xml', ['w:ind@w:hanging'], 'a leading zero'],
    ['a note reference\'s w:id with a leading zero', NOTES, 'word/document.xml', ['w:footnoteReference@w:id'], 'a leading zero'],
    ['a note\'s w:id with a plus sign', NOTES, 'word/footnotes.xml', ['w:footnote@w:id'], 'a plus sign'],
    ['a comment range\'s w:id with a leading zero', COMMENTS, 'word/document.xml', ['w:commentRangeStart@w:id', 'w:commentRangeEnd@w:id'], 'a leading zero'],
    ['a comment\'s w:id with whitespace around it', COMMENTS, 'word/comments.xml', ['w:comment@w:id'], 'whitespace around it'],
    ['the line height of a quote\'s spacer paragraph with a leading zero', QUOTE, 'word/document.xml', ['w:spacing@w:line'], 'a leading zero'],
    ['a task item\'s hanging indent in points', TASKS, 'word/document.xml', ['w:ind@w:hanging'], 'points'],
    ['a task item\'s left indent in inches', TASKS, 'word/document.xml', ['w:ind@w:left'], 'inches'],
    ['the line height of a quote\'s spacer paragraph in points', QUOTE, 'word/document.xml', ['w:spacing@w:line'], 'points'],
    ['the document\'s sizes in points', SIZES, 'word/styles.xml', ['w:sz@w:val', 'w:szCs@w:val'], 'points'],
  ])('imports a document with %s as it imports the document', async (_name, markdown, part, attributes, spelling) => {
    // The ID didn't match its other spelling, or the number the one export
    // writes, so the list, the note, the comment or the quote's spacer
    // was lost, and the spacer came back as blank lines
    const { docx, markdown: imported } = await exportedOf(markdown);
    expect(imported).toBe(markdown);
    const again = await respelled(docx, SPELLINGS[spelling], { part, attributes });
    expect(again).not.toEqual(docx);
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  it('imports a section whose page is wider than it\'s high, in inches and points, with no orientation, as landscape', async () => {
    // Word shows a page wider than it's high as landscape, but its size in
    // units read as no size, so the section lost its fences, and export
    // made it portrait
    const markdown = 'Tall.\n\n<!-- landscape -->\n\nWide.\n\n<!-- /landscape -->\n\nTall again.\n';
    const { docx, markdown: imported } = await exportedOf(markdown);
    expect(imported).toBe(markdown);
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const sized = xml.replace(/<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"\/>/, () => '<w:pgSz w:w="11in" w:h="612pt"/>');
    expect(sized).not.toBe(xml);
    zip.file('word/document.xml', sized);
    const again = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(again).toBe(markdown);
    expect((await convertDocx((await convertMdToDocx(again)).docx)).markdown).toBe(markdown);
  });

  it('imports the size Word set in points on all of a table\'s text as the table\'s size', async () => {
    // Word shows the table's text in 8 points, but import read no size,
    // so the table kept the size it had
    const markdown = '<!-- table-font-size: 7 -->\n| A | B |\n| --- | --- |\n| a | b |\n';
    const { docx, markdown: imported } = await exportedOf(markdown);
    expect(imported).toBe(markdown);
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const sized = xml.replace(/(<w:szCs|<w:sz) w:val="14"\/>/g, (_whole, element: string) => element + ' w:val="8.4pt"/>');
    expect(sized).not.toBe(xml);
    zip.file('word/document.xml', sized);
    const again = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    const resized = markdown.replace('table-font-size: 7', 'table-font-size: 8');
    expect(again).toBe(resized);
    expect((await convertDocx((await convertMdToDocx(again)).docx)).markdown).toBe(resized);
  });

  it('imports a custom style\'s spacing and indent in centimeters from its style where the document doesn\'t store the style', async () => {
    // Import reads the style's spacing and indent where the document's
    // properties don't hold the style, as where another tool dropped
    // them, but read none in centimeters, so the style lost them
    const markdown = '---\nstyles:\n  pullquote:\n    spacing-before: 18\n    spacing-after: 9\n    paragraph-indent: 0.25\n---\n\n'
      + '<!-- style: pullquote -->\n\nStyled text.\n\n<!-- /style -->\n';
    const { docx, markdown: imported } = await exportedOf(markdown);
    expect(imported).toBe(markdown);
    const zip = await JSZip.loadAsync(docx);
    const properties = await zip.file('docProps/custom.xml')!.async('string');
    const unstored = properties.replace(/<property\b[^>]*name="MANUSCRIPT_CUSTOM_STYLES[^"]*"[^>]*>[\s\S]*?<\/property>/g, '');
    expect(unstored).not.toBe(properties);
    zip.file('docProps/custom.xml', unstored);
    const plain = await zip.generateAsync({ type: 'uint8array' });
    expect((await convertDocx(plain)).markdown).toBe(markdown);
    const again = await respelled(plain, SPELLINGS.centimeters, { part: 'word/styles.xml', attributes: ['w:spacing@w:before', 'w:spacing@w:after', 'w:ind@w:firstLine'] });
    expect(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string')).toContain('<w:spacing w:before="0.635cm" w:after="0.3175cm"/><w:ind w:firstLine="0.635cm"/>');
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  it('imports a comment\'s replies whose w15:paraId Word gave in lowercase', async () => {
    // Hex digits in either case are one number, as Word reads them, but the
    // reply's and its parent's paraIds didn't match their comments', so
    // each reply came back as a comment of its own
    const docx = new Uint8Array(await Bun.file(import.meta.dir + '/../test/fixtures/replies.docx').arrayBuffer());
    const { markdown } = await convertDocx(docx);
    expect(markdown).toContain('\n  {>>@');
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/commentsExtended.xml')!.async('string');
    const lower = xml.replace(/(w15:paraId(?:Parent)?=")([^"]*)"/g, (_whole, attribute: string, value: string) => attribute + value.toLowerCase() + '"');
    expect(lower).not.toBe(xml);
    zip.file('word/commentsExtended.xml', lower);
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe(markdown);
  });
});
