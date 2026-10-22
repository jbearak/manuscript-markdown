import { afterAll, describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';
import { childrenOf, isElement, nameOf, parseOrdered, type XmlNode } from './scoped-xml';
import { renderWithPlugin } from './test-helpers';

// Captions and cross-references in a document Word itself saved. The tests
// in figure-captions.test.ts, table-captions.test.ts and
// cross-references.test.ts build their XML by hand, in the shapes Word
// writes; these read test/fixtures/word-captions.docx, which Word wrote,
// and skip until it's there. They check that import reads Word's captions
// and cross-references as a figure, a table's caption and references to
// them, that export writes them back as Word wrote them, that a second
// round trip gives the same Markdown, and that neither warns.
//
// To make the document in Word, for Windows or Mac (the menus are the
// same but where the steps say otherwise):
//
// 1. Make a new blank document.
// 2. Type a sentence of plain words, as "This document tests captions.",
//    and press Enter.
// 3. Insert a small PNG or JPEG picture from a file: Insert > Pictures >
//    This Device (Mac: Insert > Pictures > Picture from File). Leave its
//    layout In Line with Text, as Word inserts it.
// 4. Click the picture to select it, then References > Insert Caption
//    (on a Mac, also the menu bar's Insert > Caption). Label: Figure.
//    Position: Below selected item. Leave Numbering as it is (1, 2, 3,
//    with no chapter number) and Exclude label from caption unchecked. In
//    the Caption box, after "Figure 1", type a colon, a space and a few
//    plain words, as "Figure 1: A picture of a cat". Click OK.
// 5. Click at the end of the caption and press Enter. Insert a table of
//    two columns and two rows (Insert > Table) and type a word or a number
//    in each cell.
// 6. Click in the table, then References > Insert Caption again. Label:
//    Table. Position: Above selected item. After "Table 1", type a colon,
//    a space and a few plain words, as "Table 1: Counts by year". Click
//    OK.
// 7. Click in the empty paragraph below the table and type "See ". Then
//    References > Cross-reference (on a Mac, also the menu bar's Insert >
//    Cross-reference). Reference type: Figure. Insert reference to: Only
//    label and number. Leave Insert as hyperlink checked. Pick the
//    figure's caption, click Insert, then Close. Type " and ", insert a
//    cross-reference the same way with Reference type: Table, and type
//    ".".
// 8. Save it as a Word Document (.docx) at test/fixtures/word-captions.docx.

const FIXTURE = join(__dirname, '..', 'test', 'fixtures', 'word-captions.docx');
const HAS_FIXTURE = existsSync(FIXTURE);

let dir: string | undefined;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The Markdown and warnings of a document's import, as the extension
 *  imports one, with its images written in `into`, where the Markdown
 *  says they are */
async function importDocx(docx: Uint8Array, into: string): Promise<{ md: string; warnings: string[] }> {
  const { markdown, warnings, images } = await convertDocx(docx);
  for (const [name, bytes] of images ?? []) {
    mkdirSync(dirname(join(into, name)), { recursive: true });
    writeFileSync(join(into, name), bytes);
  }
  return { md: markdown, warnings };
}

let wordImport: Promise<{ word: Uint8Array; md: string; warnings: string[] }> | undefined;
/** The document Word saved, and its import */
function imported() {
  wordImport ??= (async () => {
    dir = mkdtempSync(join(tmpdir(), 'word-saved-captions-'));
    const word = new Uint8Array(readFileSync(FIXTURE));
    return { word, ...await importDocx(word, dir) };
  })();
  return wordImport;
}

const trips = new Map<boolean, Promise<{ docx: Uint8Array; warnings: string[]; back: string; backWarnings: string[] }>>();
/** The export of the document's import, with the document as its template,
 *  as the extension and the CLI export to a .docx that's there, or with
 *  none, and that export's import */
function exported(withTemplate: boolean) {
  let trip = trips.get(withTemplate);
  if (!trip) {
    trip = (async () => {
      const { word, md } = await imported();
      const { docx, warnings } = await convertMdToDocx(md, { sourceDir: dir, ...(withTemplate ? { templateDocx: word } : {}) });
      const back = await importDocx(docx, mkdtempSync(join(dir!, 'back-')));
      return { docx, warnings, back: back.md, backWarnings: back.warnings };
    })();
    trips.set(withTemplate, trip);
  }
  return trip;
}

// --- What a body holds of captions and cross-references ---

/** A paragraph's content in order, as far as these tests read it: its
 *  text, its fields' parts, its bookmarks and its pictures */
type Piece =
  | { text: string }
  | { instruction: string }
  | { fieldChar: string }
  | { bookmarkStart: string; name: string }
  | { bookmarkEnd: string }
  | { picture: true };

const attribute = (node: XmlNode | undefined, name: string): string => node?.[':@']?.['@_' + name] ?? '';
const elementsOf = (node: XmlNode): XmlNode[] => (childrenOf(node) ?? []).filter(isElement);
const childNamed = (node: XmlNode | undefined, name: string) => node && elementsOf(node).find(child => nameOf(child) === name);
const textOf = (node: XmlNode): string => (childrenOf(node) ?? []).map(child => typeof child['#text'] === 'string' ? child['#text'] : '').join('');

/** The pieces of the content `nodes`, after `out`'s. Properties, and text
 *  Word shows as deleted, are none. */
function piecesOf(nodes: XmlNode[], out: Piece[] = []): Piece[] {
  for (const node of nodes.filter(isElement)) {
    const name = nameOf(node);
    if (name.endsWith('Pr') || name === 'w:del' || name === 'w:moveFrom') continue;
    if (name === 'w:t') out.push({ text: textOf(node) });
    else if (name === 'w:tab') out.push({ text: '\t' });
    else if (name === 'w:br' || name === 'w:cr') out.push({ text: '\n' });
    else if (name === 'w:instrText') out.push({ instruction: textOf(node) });
    else if (name === 'w:fldChar') out.push({ fieldChar: attribute(node, 'w:fldCharType') });
    else if (name === 'w:fldSimple') {
      out.push({ fieldChar: 'begin' }, { instruction: attribute(node, 'w:instr') }, { fieldChar: 'separate' });
      piecesOf(elementsOf(node), out);
      out.push({ fieldChar: 'end' });
    } else if (name === 'w:bookmarkStart') out.push({ bookmarkStart: attribute(node, 'w:id'), name: attribute(node, 'w:name') });
    else if (name === 'w:bookmarkEnd') out.push({ bookmarkEnd: attribute(node, 'w:id') });
    else if (name === 'w:drawing' || name === 'w:pict' || name === 'mc:AlternateContent') out.push({ picture: true });
    else piecesOf(elementsOf(node), out);
  }
  return out;
}

/** A field's instruction with its words one space apart, and without
 *  \* MERGEFORMAT, which only keeps the result's formatting as Word
 *  updates it */
const instructionOf = (text: string) => text.replace(/\\\*\s*MERGEFORMAT\b/gi, ' ').trim().split(/\s+/).join(' ');

/**
 * A paragraph's pieces as text: `shown`, as Word shows it, and `written`,
 * with each field as {instruction|result}, its instruction as instructionOf
 * gives it, with a REF field's bookmark as `marks` names it, and with the
 * start and end of each bookmark `marks` names as ⟦ and ⟧. `names` gives
 * each bookmark's name by its ID. Also the paragraph's fields'
 * instructions, and the names of the bookmarks that start in it.
 */
function readPieces(pieces: Piece[], names: Map<string, string>, marks: Map<string, string>) {
  let written = '';
  let shown = '';
  const instructions: string[] = [];
  const starts: string[] = [];
  const open: Array<{ instruction: string; result: string; separated: boolean }> = [];
  const write = (text: string) => {
    const field = open[open.length - 1];
    if (!field) written += text;
    else if (field.separated) field.result += text;
  };
  for (const piece of pieces) {
    if ('text' in piece) {
      write(piece.text);
      if (open.every(field => field.separated)) shown += piece.text;
    } else if ('instruction' in piece) {
      const field = open[open.length - 1];
      if (field && !field.separated) field.instruction += piece.instruction;
    } else if ('fieldChar' in piece) {
      if (piece.fieldChar === 'begin') {
        open.push({ instruction: '', result: '', separated: false });
      } else if (piece.fieldChar === 'separate' && open.length > 0) {
        open[open.length - 1].separated = true;
      } else if (piece.fieldChar === 'end' && open.length > 0) {
        const field = open.pop()!;
        const instruction = instructionOf(field.instruction);
        instructions.push(instruction);
        const marked = instruction.replace(/^REF (\S+)/, (match, name: string) => marks.has(name.toLowerCase()) ? 'REF ' + marks.get(name.toLowerCase()) : match);
        write('{' + marked + '|' + field.result + '}');
      }
    } else if ('bookmarkStart' in piece) {
      if (open.length === 0) starts.push(piece.name);
      if (marks.has(piece.name.toLowerCase())) write('⟦');
    } else if ('bookmarkEnd' in piece) {
      if (marks.has((names.get(piece.bookmarkEnd) ?? '').toLowerCase())) write('⟧');
    } else {
      write('[picture]');
    }
  }
  return { written, shown, instructions, starts };
}

/** A block of a body that holds a caption, a cross-reference or what a
 *  caption is of: a picture's paragraph, a table, a caption, which is a
 *  paragraph with a SEQ field, with its style's name, or a paragraph with
 *  a REF field */
interface Block {
  kind: 'picture' | 'table' | 'caption' | 'references';
  style?: string;
  /** Its text, with its fields and bookmarks, as readPieces writes them */
  written?: string;
  /** Its text as Word shows it */
  shown?: string;
}

/**
 * The blocks of the body of `docx` that hold its captions, its
 * cross-references and what the captions are of, in order. A REF field's
 * bookmark is named by the caption it starts in, as ⟨Figure 1⟩, its SEQ
 * field's identifier and result, or ⟨elsewhere⟩, so that the names Word
 * and export give their bookmarks don't count, nor do their IDs, rsids and
 * the rest; nor does a bookmark no REF field goes to, as Word's _GoBack.
 * A run's formatting doesn't count either.
 */
async function blocksOf(docx: Uint8Array): Promise<Block[]> {
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file('word/document.xml')!.async('string');
  const styles = await zip.file('word/styles.xml')?.async('string') ?? '';
  const styleNames = new Map<string, string>();
  for (const [style] of styles.matchAll(/<w:style\b[\s\S]*?<\/w:style>/g)) {
    const id = /\bw:styleId="([^"]*)"/.exec(style)?.[1];
    const name = /<w:name w:val="([^"]*)"/.exec(style)?.[1];
    if (id !== undefined && name !== undefined) styleNames.set(id, name.toLowerCase());
  }
  const document = parseOrdered(xml.slice(xml.indexOf('<w:document')))!.find(node => nameOf(node) === 'w:document')!;
  const read = elementsOf(childNamed(document, 'w:body')!).flatMap((node): Array<{ table: true } | { style: string | undefined; pieces: Piece[] }> => {
    if (nameOf(node) === 'w:tbl') return [{ table: true }];
    if (nameOf(node) !== 'w:p') return [];
    const styleId = attribute(childNamed(childNamed(node, 'w:pPr'), 'w:pStyle'), 'w:val');
    return [{ style: styleId ? styleNames.get(styleId) ?? styleId : undefined, pieces: piecesOf(elementsOf(node)) }];
  });
  const names = new Map<string, string>();
  for (const block of read) {
    if ('pieces' in block) for (const piece of block.pieces) if ('bookmarkStart' in piece) names.set(piece.bookmarkStart, piece.name);
  }
  // Each REF field's bookmark, named by the caption it starts in
  const unmarked = read.map(block => 'pieces' in block ? readPieces(block.pieces, names, new Map()) : undefined);
  const marks = new Map<string, string>();
  for (const paragraph of unmarked) {
    for (const instruction of paragraph?.instructions ?? []) {
      const name = /^REF (\S+)/.exec(instruction)?.[1];
      if (name) marks.set(name.toLowerCase(), '⟨elsewhere⟩');
    }
  }
  for (const paragraph of unmarked) {
    const identifier = /^SEQ (\S+)/.exec(paragraph?.instructions.find(instruction => instruction.startsWith('SEQ ')) ?? '')?.[1];
    if (!paragraph || !identifier) continue;
    const number = /\{SEQ [^|]*\|([^}]*)\}/.exec(paragraph.written)?.[1] ?? '';
    for (const name of paragraph.starts) if (marks.has(name.toLowerCase())) marks.set(name.toLowerCase(), '⟨' + identifier + ' ' + number + '⟩');
  }
  return read.flatMap((block): Block[] => {
    if (!('pieces' in block)) return [{ kind: 'table' }];
    const { written, shown, instructions } = readPieces(block.pieces, names, marks);
    if (instructions.some(instruction => instruction.startsWith('SEQ '))) return [{ kind: 'caption', style: block.style, written, shown }];
    if (instructions.some(instruction => instruction.startsWith('REF '))) return [{ kind: 'references', written, shown }];
    return block.pieces.some(piece => 'picture' in piece) ? [{ kind: 'picture' }] : [];
  });
}

/** HTML's text, its tags dropped and its references read */
const htmlText = (html: string) => html.replace(/<[^>]+>/g, '')
  .replace(/&(?:#(\d+)|#x([0-9A-Fa-f]+)|(amp|lt|gt|quot|apos));/g, (_match, decimal: string | undefined, hex: string | undefined, name: string | undefined) =>
    name ? { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }[name]! : String.fromCodePoint(decimal !== undefined ? Number(decimal) : parseInt(hex!, 16)));

/** Markdown's text with its backslash escapes read */
const unescaped = (md: string) => md.replace(/\\([!-/:-@[-`{-~])/g, (_match, character: string) => character);

const WITH_AND_WITHOUT_TEMPLATE: Array<[string, boolean]> = [['with the Word document as its template', true], ['with no template', false]];

describe.skipIf(!HAS_FIXTURE)(HAS_FIXTURE
  ? 'Captions and cross-references Word wrote, in test/fixtures/word-captions.docx'
  : 'Captions and cross-references Word wrote (skipped: there\'s no test/fixtures/word-captions.docx yet; the steps at the top of word-saved-captions.test.ts make it in Word)', () => {
  it('reads the document the steps make: a picture with its caption below, a table with its caption above, and a paragraph that refers to both', async () => {
    const blocks = await blocksOf((await imported()).word);
    expect(blocks.map(block => block.kind)).toEqual(['picture', 'caption', 'caption', 'table', 'references']);
    expect(blocks[1].written).toContain('{SEQ Figure \\* ARABIC|1}');
    expect(blocks[2].written).toContain('{SEQ Table \\* ARABIC|1}');
    expect(blocks[4].written).toMatch(/\{REF ⟨Figure 1⟩[^|]*\|Figure 1\}/);
    expect(blocks[4].written).toMatch(/\{REF ⟨Table 1⟩[^|]*\|Table 1\}/);
  });

  it('imports the picture as a figure with a label, the table\'s caption as its caption line with a label, and the cross-references as references to them', async () => {
    const { word, md } = await imported();
    const blocks = await blocksOf(word);
    const figures = [...md.matchAll(/^!\[((?:\\.|[^\\\]])*)\]\([^\n]*?\)\{#(fig-[A-Za-z0-9_-]+)(?: [^}\n]*)?\}$/gm)];
    expect(figures.map(figure => figure[0])).toHaveLength(1);
    const [figure, figureCaption, figureLabel] = figures[0];
    const tableCaptions = [...md.matchAll(/^: (.*) \{#(tbl-[A-Za-z0-9_-]+)\}$/gm)];
    expect(tableCaptions.map(caption => caption[0])).toHaveLength(1);
    const [, tableCaption, tableLabel] = tableCaptions[0];
    // Right after its table, as Quarto writes a table's caption, and after
    // the figure
    expect(md.slice(0, tableCaptions[0].index).trimEnd().split('\n').pop()).toMatch(/^[|+]/);
    expect(md.indexOf(figure)).toBeLessThan(tableCaptions[0].index!);
    // Word's places for the captions are Quarto's, which the frontmatter
    // needn't name
    expect(md).not.toMatch(/^(?:fig|tbl)-cap-location:/m);

    // Each caption's text is Word's, after its label, number and separator
    expect(blocks[1].shown).toEndWith(' ' + unescaped(figureCaption));
    expect(blocks[2].shown).toEndWith(' ' + unescaped(tableCaption));

    // Word's paragraph, with a reference to the figure or the table for
    // each of its cross-references, one in brackets as one without
    const references = blocks[4].written!.replace(/\{REF ⟨(Figure|Table) 1⟩[^|]*\|[^}]*\}/g, (_match, kind: string) => '@' + (kind === 'Figure' ? figureLabel : tableLabel));
    expect(md.split('\n').map(line => line.replace(/\[(@(?:fig|tbl)-[A-Za-z0-9_-]+)\]/g, (_match, reference: string) => reference))).toContain(references);
  });

  it('previews the captions and the cross-references as Word shows them', async () => {
    const { word, md } = await imported();
    const blocks = await blocksOf(word);
    const html = renderWithPlugin(md);
    expect(htmlText(/<figcaption>([\s\S]*?)<\/figcaption>/.exec(html)?.[1] ?? '')).toBe(blocks[1].shown!);
    expect(htmlText(/<p id="tbl-[^"]*" class="manuscript-markdown-table-caption">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '')).toBe(blocks[2].shown!);
    expect(htmlText(/<p\b[^>]*>((?:(?!<\/p>)[\s\S])*manuscript-markdown-cross-reference(?:(?!<\/p>)[\s\S])*)<\/p>/.exec(html)?.[1] ?? '')).toBe(blocks[4].shown!);
  });

  it.each(WITH_AND_WITHOUT_TEMPLATE)('exports the Markdown, %s, with the captions, SEQ fields, bookmarks and REF fields Word wrote', async (_name, withTemplate) => {
    const { word } = await imported();
    expect(await blocksOf((await exported(withTemplate)).docx)).toEqual(await blocksOf(word));
  });

  it.each(WITH_AND_WITHOUT_TEMPLATE)('reads the Markdown back the same from its export, %s', async (_name, withTemplate) => {
    expect((await exported(withTemplate)).back).toBe((await imported()).md);
  });

  it('warns of nothing in import or export', async () => {
    expect((await imported()).warnings).toEqual([]);
    for (const [, withTemplate] of WITH_AND_WITHOUT_TEMPLATE) {
      const { warnings, backWarnings } = await exported(withTemplate);
      expect(warnings).toEqual([]);
      expect(backWarnings).toEqual([]);
    }
  });
});
