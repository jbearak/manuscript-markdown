import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { parseStyleLayouts, styledProperty } from './converter';
import type { CellPlace, StyledParagraph } from './converter';
import type { XmlNode } from './omml';

/**
 * Import reads a paragraph's and a run's properties through the style
 * hierarchy with one resolver (styledProperty in converter.ts). This
 * compares it, over generated styles.xml, each level setting or leaving
 * each property, with a reference that layers the levels as ECMA-376 Part
 * 1, 17.7.2 has Word apply them, each over the last: the document's
 * defaults, the default paragraph style where the paragraph has no style of
 * its own (which Word puts under the table style, as LibreOffice reads it),
 * the table style, its whole table, then its parts for where the cell is,
 * the paragraph's own style, the run's character style, and the paragraph's
 * or run's own properties. A style's base goes under it. Word matches a
 * style's ID whatever its case, a style without a w:type is a paragraph
 * style, and Word ignores the elements of DefaultParagraphFont, NoList and
 * TableNormal (MS-OI29500, Part 1 17.7.4.17).
 */

type Kind = 'pPr' | 'rPr';
// The properties of each kind, by tag, which each level sets or leaves
const PROPERTIES: Record<Kind, string[]> = { pPr: ['w:jc', 'w:bidi'], rPr: ['w:sz', 'w:rtl'] };
/** Each property's raw w:val, '' for one without it, by tag */
type Settings = Record<string, string | undefined>;
type Properties = Record<Kind, Settings>;

const PART_TYPES = ['wholeTable', 'band1Vert', 'band2Vert', 'band1Horz', 'band2Horz', 'firstCol', 'lastCol',
  'firstRow', 'lastRow', 'nwCell', 'neCell', 'swCell', 'seCell'];
// IDs differing only in case, and styles whose elements Word ignores
const IDS = ['Normal', 'normal', 'A', 'a', 'B', 'C', 'TableNormal', 'DefaultParagraphFont'];
const IGNORED = new Set(['nolist', 'defaultparagraphfont', 'tablenormal']);

interface ModelStyle {
  /** Its w:type, or none, which is a paragraph style */
  type?: 'paragraph' | 'character' | 'table' | 'numbering';
  id: string;
  /** Its w:default, where it has one */
  isDefault?: string;
  basedOn?: string;
  properties: Properties;
  parts: [string, Properties][];
  rowBand?: number;
  colBand?: number;
}
interface Model { defaults: Properties; styles: ModelStyle[] }
interface Query { kind: Kind; paragraph: StyledParagraph; rStyle?: string; own: Settings }

const valueArb = fc.option(fc.oneof(fc.constant(''), fc.integer({ min: 1, max: 999 }).map(String)), { nil: undefined, freq: 2 });
const settingsArb = (kind: Kind) => fc.tuple(...PROPERTIES[kind].map(() => valueArb))
  .map(values => Object.fromEntries(PROPERTIES[kind].map((tag, i) => [tag, values[i]])) as Settings);
const propertiesArb = fc.record({ pPr: settingsArb('pPr'), rPr: settingsArb('rPr') });
const idArb = fc.constantFrom(...IDS, 'Missing');
const styleArb: fc.Arbitrary<ModelStyle> = fc.record({
  type: fc.option(fc.constantFrom('paragraph', 'character', 'table', 'numbering') as fc.Arbitrary<ModelStyle['type'] & string>, { nil: undefined }),
  id: fc.constantFrom(...IDS),
  isDefault: fc.option(fc.constantFrom('1', 'true', '0'), { nil: undefined }),
  basedOn: fc.option(idArb, { nil: undefined }),
  properties: propertiesArb,
  parts: fc.uniqueArray(fc.tuple(fc.constantFrom(...PART_TYPES), propertiesArb), { maxLength: 4, selector: ([type]) => type }),
  rowBand: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
  colBand: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
});
const typeOf = (style: ModelStyle) => style.type ?? 'paragraph';
const modelArb: fc.Arbitrary<Model> = fc.record({
  defaults: propertiesArb,
  // One style of each type and ID, as styles.xml has
  styles: fc.uniqueArray(styleArb, { maxLength: 10, selector: style => typeOf(style) + ' ' + style.id }),
});
const placeArb: fc.Arbitrary<CellPlace> = fc.record({ rows: fc.integer({ min: 1, max: 5 }), cols: fc.integer({ min: 1, max: 5 }) }).chain(({ rows, cols }) =>
  fc.record({
    row: fc.integer({ min: 0, max: rows - 1 }), rows: fc.constant(rows), col: fc.integer({ min: 0, max: cols - 1 }), cols: fc.constant(cols),
    look: fc.record({ firstRow: fc.boolean(), lastRow: fc.boolean(), firstColumn: fc.boolean(), lastColumn: fc.boolean(), noHBand: fc.boolean(), noVBand: fc.boolean() }),
  }).chain(place => fc.integer({ min: 1, max: cols - place.col }).map(span => ({ ...place, span }))));
const queryArb: fc.Arbitrary<Query> = fc.record({
  kind: fc.constantFrom('pPr', 'rPr') as fc.Arbitrary<Kind>,
  paragraph: fc.record({
    style: fc.option(idArb, { nil: undefined }),
    // Undefined for a paragraph out of a table, '' for a table without a style
    tableStyle: fc.option(fc.oneof(fc.constant(''), idArb), { nil: undefined }),
    place: fc.option(placeArb, { nil: undefined }),
  }),
  rStyle: fc.option(idArb, { nil: undefined }),
  own: fc.record({ pPr: settingsArb('pPr'), rPr: settingsArb('rPr') }),
}).map(({ own, ...query }) => ({ ...query, own: own[query.kind] }));

/** Settings as a w:pPr's or w:rPr's children's XML */
const settingsXml = (settings: Settings) => Object.entries(settings)
  .map(([tag, value]) => value === undefined ? '' : '<' + tag + (value === '' ? '' : ' w:val="' + value + '"') + '/>').join('');
/** Settings as a w:pPr's or w:rPr's children, as import parses them */
const settingsNodes = (settings: Settings): XmlNode[] => Object.entries(settings).filter(([, value]) => value !== undefined)
  .map(([tag, value]) => ({ [tag]: [], ...(value === '' ? {} : { ':@': { '@_w:val': value } }) }) as XmlNode);
const propertiesXml = (properties: Properties) => '<w:pPr>' + settingsXml(properties.pPr) + '</w:pPr><w:rPr>' + settingsXml(properties.rPr) + '</w:rPr>';

function stylesXml(model: Model): string {
  return '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults>'
    + '<w:rPrDefault><w:rPr>' + settingsXml(model.defaults.rPr) + '</w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr>' + settingsXml(model.defaults.pPr) + '</w:pPr></w:pPrDefault></w:docDefaults>'
    + model.styles.map(style => '<w:style' + (style.type ? ' w:type="' + style.type + '"' : '')
      + (style.isDefault !== undefined ? ' w:default="' + style.isDefault + '"' : '') + ' w:styleId="' + style.id + '">'
      + '<w:name w:val="' + style.id + '"/>' + (style.basedOn ? '<w:basedOn w:val="' + style.basedOn + '"/>' : '')
      + propertiesXml(style.properties)
      + (style.rowBand || style.colBand ? '<w:tblPr>' + (style.rowBand ? '<w:tblStyleRowBandSize w:val="' + style.rowBand + '"/>' : '')
        + (style.colBand ? '<w:tblStyleColBandSize w:val="' + style.colBand + '"/>' : '') + '</w:tblPr>' : '')
      + style.parts.map(([type, properties]) => '<w:tblStylePr w:type="' + type + '">' + propertiesXml(properties) + '</w:tblStylePr>').join('')
      + '</w:style>').join('') + '</w:styles>';
}

const NONE: Properties = { pPr: {}, rPr: {} };
/** A style as Word reads it: nothing of one whose elements it ignores */
const asRead = (style: ModelStyle): ModelStyle => IGNORED.has(style.id.toLowerCase())
  ? { ...style, basedOn: undefined, properties: NONE, parts: [], rowBand: undefined, colBand: undefined } : style;
/** The style of a type by ID, or else the first whose ID differs only in case */
const find = (model: Model, type: string, id: string | undefined) => {
  const styles = model.styles.filter(style => typeOf(style) === type);
  return id ? styles.find(style => style.id === id) ?? styles.find(style => style.id.toLowerCase() === id.toLowerCase()) : undefined;
};
/** The first style of a type that's the default */
const defaultOf = (model: Model, type: string) =>
  model.styles.find(style => typeOf(style) === type && ['1', 'true', 'on'].includes(style.isDefault ?? ''));
/** A style and its bases, each once, nearest first */
const chainOf = (model: Model, type: string, style: ModelStyle | undefined) => {
  const chain: ModelStyle[] = [];
  for (; style && !chain.includes(style); style = find(model, type, asRead(style).basedOn)) chain.push(style);
  return chain;
};
/** The parts of a table style a cell takes, in the order Word applies them */
function partsFor(place: CellPlace, rowBand: number, colBand: number): string[] {
  const { row, rows, col, span, cols, look } = place;
  const [firstRow, lastRow] = [look.firstRow && row === 0, look.lastRow && row === rows - 1];
  const [firstCol, lastCol] = [look.firstColumn && col === 0, look.lastColumn && col + span >= cols];
  // A band is every colBand columns, or rowBand rows, past a first column
  // or row the table formats as one
  const vertical = Math.floor((col - (look.firstColumn ? 1 : 0)) / colBand) % 2 === 0 ? 'band1Vert' : 'band2Vert';
  const horizontal = Math.floor((row - (look.firstRow ? 1 : 0)) / rowBand) % 2 === 0 ? 'band1Horz' : 'band2Horz';
  return [
    !look.noVBand && !firstCol && !lastCol && vertical, !look.noHBand && !firstRow && !lastRow && horizontal,
    firstCol && 'firstCol', lastCol && 'lastCol', firstRow && 'firstRow', lastRow && 'lastRow',
    firstRow && firstCol && 'nwCell', firstRow && lastCol && 'neCell', lastRow && firstCol && 'swCell', lastRow && lastCol && 'seCell',
  ].filter((part): part is string => !!part);
}

/** A property's value and level, as Word layers the levels, or unknown */
function reference(model: Model, query: Query, tag: string): { value?: string; from?: string } | 'unknown' {
  const { kind, paragraph } = query;
  const UNKNOWN = Symbol('unknown');
  const layers: [string, Settings | undefined | typeof UNKNOWN][] = [];
  // A style's chain, its farthest base first
  const add = (from: string, chain: ModelStyle[], settings: (style: ModelStyle) => Settings | undefined) => {
    for (const style of [...chain].reverse()) layers.push([from, settings(asRead(style))]);
  };
  layers.push(['defaults', model.defaults[kind]]);
  const defaultParagraph = defaultOf(model, 'paragraph');
  const named = find(model, 'paragraph', paragraph.style);
  const ownStyle = named && named !== defaultParagraph ? named : undefined;
  if (!ownStyle) add('defaultParagraph', chainOf(model, 'paragraph', defaultParagraph), style => style.properties[kind]);
  if (paragraph.tableStyle !== undefined) {
    const table = chainOf(model, 'table', find(model, 'table', paragraph.tableStyle) ?? defaultOf(model, 'table'));
    const part = (style: ModelStyle, type: string) => style.parts.find(([partType]) => partType === type)?.[1][kind];
    add('table', table, style => style.properties[kind]);
    add('table', table, style => part(style, 'wholeTable'));
    if (paragraph.place) {
      const band = (size: 'rowBand' | 'colBand') => table.map(asRead).find(style => style[size] !== undefined)?.[size] ?? 1;
      for (const type of partsFor(paragraph.place, band('rowBand'), band('colBand'))) add('table', table, style => part(style, type));
    } else if (table.map(asRead).some(style => style.parts.some(([type, properties]) => type !== 'wholeTable' && properties[kind][tag] !== undefined))) {
      layers.push(['table', UNKNOWN]);
    }
  }
  if (ownStyle) add('paragraph', chainOf(model, 'paragraph', ownStyle), style => style.properties[kind]);
  if (kind === 'rPr' && query.rStyle) {
    const character = find(model, 'character', query.rStyle);
    if (character) add('character', chainOf(model, 'character', character), style => style.properties.rPr);
    else layers.push(['character', UNKNOWN]);
  }
  layers.push(['own', query.own]);
  for (const [from, settings] of layers.reverse()) {
    if (settings === UNKNOWN) return 'unknown';
    if (settings?.[tag] !== undefined) return { value: settings[tag], from };
  }
  return {};
}

describe('the style hierarchy', () => {
  it('gives a property as a reference layering of ECMA-376 Part 1, 17.7.2 does, over generated styles', async () => {
    await fc.assert(fc.asyncProperty(modelArb, fc.array(queryArb, { minLength: 1, maxLength: 6 }), async (model, queries) => {
      const zip = new JSZip();
      zip.file('word/styles.xml', stylesXml(model));
      const layouts = await parseStyleLayouts(zip);
      for (const query of queries) {
        const own = settingsNodes(query.own);
        if (query.rStyle) own.push({ 'w:rStyle': [], ':@': { '@_w:val': query.rStyle } } as XmlNode);
        for (const tag of PROPERTIES[query.kind]) {
          const read = (properties: XmlNode[]) => {
            const node = properties.find(child => child[tag] !== undefined);
            return node ? String(node[':@']?.['@_w:val'] ?? '') : undefined;
          };
          const resolved = styledProperty(layouts, query.kind, own, query.paragraph, read);
          expect(resolved === undefined ? 'unknown' : { ...resolved }).toEqual(reference(model, query, tag));
        }
      }
    }), { numRuns: 1000 });
  });
});
