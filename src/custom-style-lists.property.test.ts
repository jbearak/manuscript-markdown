import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';

// Style blocks go around lists, items and the paragraphs in items, at the
// top level and in items, and close each other where they nest, which
// export and import each work out apart (see applyCustomStyleSentinels and
// extractListItems in md-to-docx.ts, and the fence pass in convertDocx).
// This exports documents of paragraphs, some in blocks on one line, and
// lists, nested and of either type, some after an indent directive, which
// Word may have as one with the list before, with paragraphs in their
// items, quotes, of paragraphs or of lists, whose items are the quote's
// paragraphs, at the top level and in items, and fences anywhere, open or
// close, with a blank line after or before them or none, and blocks an item
// drops, a fenced code block or an HTML block, that hold the line of a quote
// in the item or after it, which some quotes repeat, or a directive, with a
// blank line on one side or both, or a rule or a fenced code block on an
// item's marker line, or a directive there, which is the item's text, and,
// at the top level, blocks Word can't give a style block's style, which
// keep their own, as code, tables, headings, thematic breaks and alerts,
// and others it can, as display math and HTML blocks. It imports the
// document, and exports what it wrote again, and checks that Word gets the
// same paragraphs, in the same styles, at the same list levels and
// indents, that import writes each block Word can't style in the style
// block it was in, and that import writes the same Markdown again, as it
// does without the blocks items drop, with the blank lines on the side of
// each with more.

type Style = 'box' | 'note';
type Fence = { kind: 'open'; style: Style; tight: boolean } | { kind: 'close'; tight: boolean };
type Unit = 'code' | 'pipe' | 'html' | 'heading' | 'hr' | 'alert' | 'math' | 'div';
type Child = { kind: 'para' } | { kind: 'list'; list: List; directive?: 'indent' | 'no-indent' } | { kind: 'quote'; list?: List; repeated?: boolean }
  | { kind: 'inline'; style: Style } | { kind: 'dropped'; html: boolean | 'directive'; plain?: boolean; tight?: 'before' | 'after' } | { kind: 'unit'; unit: Unit } | Fence;
/** A block an item drops on its marker line, as - ***, or a directive
 *  there, which the item keeps as its text */
type MarkerBlock = { kind: 'rule' | 'fence' | 'directive'; plain?: boolean };
type Item = { children: Child[]; marker?: MarkerBlock };
type List = { ordered: boolean; items: Item[] };

const twoStyles = '---\nstyles:\n  box:\n    font-style: italic\n  note:\n    font-style: bold\n---\n\n';

const fenceArb: fc.Arbitrary<Fence> = fc.oneof(
  fc.record({ kind: fc.constant('open' as const), style: fc.constantFrom<Style>('box', 'note'), tight: fc.boolean() }),
  fc.record({ kind: fc.constant('close' as const), tight: fc.boolean() }),
);
const paraArb: fc.Arbitrary<Child> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: 'para' as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('inline' as const), style: fc.constantFrom<Style>('box', 'note') }) },
);
/** A quote of a paragraph, of its own text or of the text some quotes
 *  repeat */
const quoteParaArb: fc.Arbitrary<Child> = fc.record({ kind: fc.constant('quote' as const), repeated: fc.boolean() });
/** A block an item drops, which holds the line of a quote that repeats, or
 *  a directive, with no blank line before it or after it where it's
 *  `tight`, but one on the other side */
const droppedArb: fc.Arbitrary<Child> = fc.record({
  kind: fc.constant('dropped' as const),
  html: fc.constantFrom<boolean | 'directive'>(true, false, 'directive'),
  tight: fc.constantFrom(undefined, 'before' as const, 'after' as const),
}).map(child => child.html === true && child.tight === 'after' ? { ...child, tight: undefined } : child);
const listArb: fc.Memo<List> = fc.memo(depth => fc.record({
  ordered: fc.boolean(),
  items: fc.array(fc.record({
    children: fc.array(depth > 1 ? fc.oneof(paraArb, listArb(depth - 1).map(list => ({ kind: 'list' as const, list })), quoteArb(depth - 1), fenceArb, droppedArb)
      : fc.oneof(paraArb, quoteParaArb, fenceArb, droppedArb), { maxLength: 4 }),
    marker: fc.oneof({ weight: 4, arbitrary: fc.constant(undefined) },
      { weight: 1, arbitrary: fc.constantFrom<MarkerBlock['kind']>('rule', 'fence', 'directive').map(kind => ({ kind })) }),
  // Before nothing in the item, or a quote, a sublist or a style block's
  // fence, but not a paragraph or a directive, which is the item's own text
  // after the block too
  }).map(({ children, marker }) => marker && (children.length === 0 || ['list', 'quote', 'open', 'close'].includes(children[0].kind))
    ? { children, marker } : { children }), { minLength: 1, maxLength: 3 }),
}));
/** A quote of a paragraph, or of a list, whose items, with their fences,
 *  are its paragraphs */
function quoteArb(depth: number): fc.Arbitrary<Child> {
  return fc.oneof(quoteParaArb, listArb(depth).map(list => ({ kind: 'quote' as const, list })));
}
/** A block at the top level Word can't give a style block's style, or,
 *  as display math or an HTML block, can */
const unitArb: fc.Arbitrary<Child> = fc.record({ kind: fc.constant('unit' as const), unit: fc.constantFrom<Unit>('code', 'pipe', 'html', 'heading', 'hr', 'alert', 'math', 'div') });
/** Documents of up to eight paragraphs, lists of up to three levels, some
 *  after an indent directive, quotes, other blocks, and fences, at the top
 *  level */
const documentArb: fc.Arbitrary<Child[]> = fc.array(fc.oneof(
  paraArb,
  fc.record({ list: listArb(3), directive: fc.constantFrom(undefined, 'indent' as const, 'no-indent' as const) })
    .map(({ list, directive }) => ({ kind: 'list' as const, list, ...(directive ? { directive } : {}) })),
  quoteArb(2),
  unitArb,
  fenceArb,
), { minLength: 1, maxLength: 8 });

/** The Markdown of `blocks`, with each paragraph's and item's text unique,
 *  the custom style each paragraph at the top level takes in Word, or ''
 *  for none: that of the block open at the top level, or of its block on
 *  one line, and the style block each block Word can't style is in, by its
 *  text, or else, for a thematic break, which has none, its place among
 *  them. A block opens and closes at its fences there, and a block that
 *  opens in a list item closes it, but not one in a quote's item, which
 *  the quote drops, and a block on one line closes it.
 *  A blank line between blocks, but not after an opening fence or before a
 *  closing one that is `tight`, unless an HTML table or a <div> is the
 *  last block before it, which would take in what's on the next line */
function markdownOf(blocks: Child[], mark = ''): { md: string; styles: Array<[string, string]>; units: Array<[string, string]>; recorded: boolean } {
  let n = 0;
  let open: Style | undefined;
  let quoted = false;
  let rules = 0;
  const styles: Array<[string, string]> = [];
  const units: Array<[string, string]> = [];
  // The style block open at the top level, as export counts it: whether
  // Word has a paragraph of it, has a block of it Word can't style, has one
  // since its last paragraph, and has one between its paragraphs. And the
  // block closed last that Word has a paragraph of, with whether such blocks
  // came after it outside any block, while nothing else has since
  type Counted = { style: Style; styled: boolean; unstyled: boolean; trail: boolean; inner: boolean };
  let counted: Counted | undefined;
  let closed: (Counted & { after: boolean }) | undefined;
  // Whether export records the blocks Word can't style all through, which
  // it doesn't past a block of only such blocks, or after a block with them
  // between its paragraphs and only them since, where another of its style
  // starts (see recording in generateDocumentXml)
  let recorded = true;
  const closeCounted = (implicit = false): void => {
    if (counted?.unstyled && !counted.styled) recorded = false;
    closed = counted?.styled && !implicit ? { ...counted, after: false } : implicit ? undefined : closed;
    counted = undefined;
  };
  const styledBlock = (): void => {
    if (!counted) {
      closed = undefined;
      return;
    }
    if (!counted.styled && closed?.style === counted.style) {
      // The two are one where nothing parts their paragraphs in Word
      if (!closed.trail && !closed.after && !counted.unstyled) counted.inner = closed.inner;
      else if (closed.inner) recorded = false;
    }
    if (counted.styled && counted.trail) counted.inner = true;
    counted.styled = true;
    counted.trail = false;
    closed = undefined;
  };
  const unstyledBlock = (): void => {
    if (!counted) {
      if (closed) closed.after = true;
      return;
    }
    counted.unstyled = true;
    if (counted.styled) counted.trail = true;
  };
  type Chunk = { lines: string[]; fence?: Fence; tight?: 'before' | 'after'; loose?: boolean };
  const join = (chunks: Chunk[]): string[] => {
    const lines: string[] = [];
    // Whether the last block but a fence is an HTML table or block that
    // only a blank line ends, as a <div>'s. A fence on the next line would
    // be its HTML, which the Markdown then reads as going on in it, and
    // after an HTML table import writes the block after a fence it drops on
    // the next line, as on main, which the table's HTML block takes in
    let afterTable = false;
    chunks.forEach((chunk, k) => {
      const tight = k > 0 && !afterTable && (chunks[k - 1].fence?.kind === 'open' && chunks[k - 1].fence!.tight || chunk.fence?.kind === 'close' && chunk.fence.tight
        || chunks[k - 1].tight === 'after' || chunk.tight === 'before');
      if (k > 0 && !tight) lines.push('');
      lines.push(...chunk.lines);
      if (!chunk.fence) afterTable = !!chunk.loose;
    });
    return lines;
  };
  // A block an item drops on its marker line, `start`, with no blank line
  // after it, after which an item that starts empty holds nothing more. Its
  // other lines end in `mark`, where there is one, and its marker line is
  // the marker alone then, as Word has the item's paragraph. But a
  // directive, which is the item's text
  const markerChunk = (block: MarkerBlock, start: string, inner: string): Chunk => ({
    lines: [block.kind === 'directive' ? start + '<!-- landscape -->' : mark ? start.trimEnd() : start + (block.kind === 'rule' ? '***' : '```'),
      ...(block.kind === 'fence' ? [inner + (block.plain ? 'x' : '> q'), inner + '```'].map(line => line + mark) : [])],
    tight: 'after',
  });
  // `text` where a fence is an item's first block after one the item drops
  // on its marker line, which the item has as its text, as no text comes
  // before it, and which opens or closes no block (see extractListItems)
  const chunkOf = (child: Child, indent: string, text = false): Chunk => {
    const top = indent === '' && !quoted;
    switch (child.kind) {
      case 'para':
        if (top) {
          styles.push(['p' + n, open ? 'MsCustom' + open[0].toUpperCase() + open.slice(1) : '']);
          styledBlock();
        }
        return { lines: [indent + 'p' + n++] };
      case 'inline':
        if (top) {
          styles.push(['p' + n, 'MsCustom' + child.style[0].toUpperCase() + child.style.slice(1)]);
          open = undefined;
          if (counted?.style !== child.style) {
            closeCounted();
            counted = { style: child.style, styled: false, unstyled: false, trail: false, inner: false };
          }
          styledBlock();
          closeCounted();
        }
        return { lines: [indent + '<!-- style: ' + child.style + ' -->p' + n++ + '<!-- /style -->'] };
      case 'quote': {
        if (top) unstyledBlock();
        if (!child.list) return { lines: [indent + '> ' + (child.repeated ? 'q' : 'p' + n++)] };
        // In a quote, which may be in another
        const outer = quoted;
        quoted = true;
        const lines = chunkOf({ kind: 'list', list: child.list }, '').lines.map(line => indent + (line ? '> ' + line : '>'));
        quoted = outer;
        return { lines };
      }
      case 'dropped': {
        // Its line the same as a quote's that repeats at its indent, but
        // where it's `plain`. An HTML block without its end, which a blank
        // line ends in the item, the item drops with more of the item after
        // it. Each line it has ends in `mark`, where there is one
        const line = indent + (child.plain ? 'x' : '> q');
        const lines = child.html === 'directive' ? [indent + '<!-- landscape -->']
          : child.html ? [indent + '<pre>', line] : [indent + '```', line, indent + '```'];
        return { lines: lines.map(dropped => dropped + mark).concat(child.html === true ? ['', indent + 'p' + n++] : []), tight: child.tight };
      }
      case 'unit': {
        const text = 'u' + n++;
        if (child.unit !== 'math') units.push([child.unit === 'hr' ? '---' + rules++ : text, open ?? '']);
        if (child.unit === 'math' || child.unit === 'div') styledBlock();
        else unstyledBlock();
        switch (child.unit) {
          case 'code': return { lines: ['```', text, '```'] };
          case 'pipe': return { lines: ['| ' + text + ' |', '|---|', '| x |'] };
          case 'html': return { lines: ['<table><tr><td>' + text + '</td></tr></table>'], loose: true };
          case 'heading': return { lines: ['## ' + text] };
          case 'hr': return { lines: ['---'] };
          case 'alert': return { lines: ['> [!NOTE]', '> ' + text] };
          case 'math': return { lines: ['$' + '$', text, '$' + '$'] };
          default: return { lines: ['<div>' + text + '</div>'], loose: true };
        }
      }
      case 'list':
        if (top) styledBlock();
        return { lines: (child.directive ? [indent + '<!-- ' + child.directive + ' -->'] : []).concat(join(child.list.items.map((item, k) => {
          const marker = child.list.ordered ? (k + 1) + '. ' : '- ';
          const inner = indent + ' '.repeat(marker.length);
          // Not in a quote, whose items' blocks the quote drops
          const first = item.marker && !quoted ? markerChunk(item.marker, indent + marker, inner) : { lines: [indent + marker + 'i' + n++] };
          const dropsMarker = !!item.marker && item.marker.kind !== 'directive' && !quoted;
          return { lines: join([first, ...item.children.map((grandchild, c) => chunkOf(grandchild, inner, dropsMarker && c === 0))]) };
        }))) };
      default:
        if (text) {
          // The item's text, which opens or closes no block
        } else if (top) {
          if (child.kind === 'close' || open !== child.style) closeCounted();
          if (child.kind === 'open' && open !== child.style) counted = { style: child.style, styled: false, unstyled: false, trail: false, inner: false };
          open = child.kind === 'open' ? child.style : undefined;
        } else if (child.kind === 'open' && !quoted) {
          // Which closes the block open at the top level with no fence
          if (counted) closeCounted(true);
          open = undefined;
        }
        return { lines: [indent + (child.kind === 'open' ? '<!-- style: ' + child.style + ' -->' : '<!-- /style -->')], fence: child };
    }
  };
  const md = twoStyles + join(blocks.map(block => chunkOf(block, ''))).join('\n') + '\n';
  closeCounted();
  return { md, styles, units, recorded };
}

/** The style block at the top level each block Word can't style is in in
 *  `markdown`, by its text, as markdownOf gives them, or for a thematic
 *  break, by its place among them: a line in the block's style is between
 *  its fences at the top level, with no block opened in a list item or on
 *  one line since */
function unitsIn(markdown: string, units: Array<[string, string]>): Array<[string, string]> {
  // Past the frontmatter, whose fences are lines of ---
  const lines = markdown.slice(markdown.indexOf('\n---\n', 3) + 5).split('\n');
  const styleAt: string[] = [];
  let open = '';
  for (const line of lines) {
    const fence = /^<!-- (?:style: (\w+)|\/style) -->$/.exec(line);
    if (fence) open = fence[1] ?? '';
    else if (/^\s*<!-- style: \w+ -->/.test(line)) open = '';
    styleAt.push(open);
  }
  const rules = lines.flatMap((line, k) => line === '---' ? [k] : []);
  return units.map(([text]) => {
    const at = text.startsWith('---') ? rules[Number(text.slice(3))] : lines.findIndex(line => new RegExp('\\b' + text + '\\b').test(line));
    return [text, at === undefined || at === -1 ? 'missing' : styleAt[at]];
  });
}

/** `blocks` with plain text in the blocks items drop, which Word gets
 *  nothing of */
function withPlainDropped(blocks: Child[]): Child[] {
  const list = (l: List): List => ({ ...l, items: l.items.map(item => ({ children: withPlainDropped(item.children), ...(item.marker ? { marker: { ...item.marker, plain: true } } : {}) })) });
  return blocks.map(child => child.kind === 'dropped' ? { ...child, plain: true }
    : child.kind === 'list' ? { ...child, list: list(child.list) }
    : child.kind === 'quote' && child.list ? { ...child, list: list(child.list) } : child);
}

/** Whether blocks an item drops are all that parts two lists of a kind in
 *  an item of `blocks`, which are one list without them, as Word has them.
 *  Each of the two may be tight, where the one list is loose, with the
 *  blank lines around the blocks between its items */
function droppedPartsLists(blocks: Child[]): boolean {
  const parts = (list?: List) => !!list && list.items.some(item => droppedPartsLists(item.children));
  return blocks.some((child, k) => {
    if ((child.kind === 'list' || child.kind === 'quote') && parts(child.list)) return true;
    if (child.kind !== 'list') return false;
    let next = k + 1;
    while (blocks[next]?.kind === 'dropped') next++;
    const after = blocks[next];
    return next > k + 1 && after?.kind === 'list' && !after.directive && after.list.ordered === child.list.ordered;
  });
}

/** The Markdown `marked`, the lines of the blocks items drop marked (see
 *  markdownOf), without them: the blank lines on either side of each, or
 *  of a run of them, as many as on the side with more */
function withoutDropped(marked: string, mark: string): string {
  const lines = marked.split('\n');
  const kept: string[] = [];
  for (let k = 0; k < lines.length;) {
    if (!lines[k].endsWith(mark)) {
      kept.push(lines[k++]);
      continue;
    }
    let before = 0;
    while (kept.length > 0 && kept[kept.length - 1] === '') { kept.pop(); before++; }
    while (k < lines.length && lines[k].endsWith(mark)) k++;
    let after = 0;
    while (k < lines.length - 1 && lines[k] === '') { k++; after++; }
    for (let blank = 0; blank < Math.max(before, after); blank++) kept.push('');
  }
  return kept.join('\n');
}

/** Each paragraph with text Word shows in the document of `docx`: its
 *  style, list level, left indent and text. Not its list, which export
 *  starts anew at a fence at the top level between items, with the number
 *  it goes on with, where import writes one, as where a block that opens in
 *  an item closes one open there, which export keeps no record of. Not a
 *  paragraph of hidden text, as a comment alone in one is, which import
 *  writes where a list starts over, as after an empty style block */
async function paragraphsOf(docx: Uint8Array): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  return [...xml.matchAll(/<w:p\b[^>]*>((?:(?!<\/w:p>).)*)<\/w:p>/gs)].map(([, p]) => {
    const pPr = /<w:pPr>((?:(?!<\/w:pPr>).)*)<\/w:pPr>/s.exec(p)?.[1] ?? '';
    const level = /<w:numPr>/.test(pPr) ? /<w:ilvl w:val="(\d+)"/.exec(pPr)?.[1] ?? '0' : '-';
    const text = [...p.matchAll(/<w:r\b(?:(?!<\/w:r>).)*<\/w:r>/gs)].filter(([run]) => !run.includes('<w:vanish/>'))
      .flatMap(([run]) => [...run.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1])).join('');
    return [/<w:pStyle w:val="([^"]*)"/.exec(pPr)?.[1] ?? '', level, /<w:ind w:left="(\d+)"/.exec(pPr)?.[1] ?? '', text].join('|');
  }).filter(p => !p.endsWith('|'));
}

describe('Style blocks around lists and in their items', () => {
  test('give paragraphs at the top level their block\'s style, keep paragraphs\' styles and list levels in Word over a round trip, and come back the same', async () => {
    await fc.assert(fc.asyncProperty(documentArb, async blocks => {
      const { md, styles, units, recorded } = markdownOf(blocks);
      const first = await convertMdToDocx(md);
      // Each paragraph at the top level in the style of the block it's in
      const paragraphs = await paragraphsOf(first.docx);
      expect([md, styles.map(([text]) => [text, paragraphs.find(p => p.endsWith('|' + text))?.split('|')[0]])]).toEqual([md, styles]);
      const back = (await convertDocx(first.docx)).markdown;
      // Each block Word can't style in the style block it was in, where
      // export records them
      if (recorded) expect([md, back, unitsIn(back, units)]).toEqual([md, back, units]);
      const second = await convertMdToDocx(back);
      // With the Markdown, for a failure's report, which comes back as it
      // was the first time
      expect([md, back, await paragraphsOf(second.docx)]).toEqual([md, back, paragraphs]);
      expect([md, (await convertDocx(second.docx)).markdown]).toEqual([md, back]);
      // Word gets nothing of the blocks items drop, so it gets the same
      // with other text in them, and import writes the same Markdown, with
      // the blank lines around each quote, which the search for a quote's
      // lines in the source took from such a block's that held them
      const other = markdownOf(withPlainDropped(blocks)).md;
      if (other !== md) {
        const plain = await convertMdToDocx(other);
        expect([md, other, await paragraphsOf(plain.docx)]).toEqual([md, other, paragraphs]);
        expect([md, other, (await convertDocx(plain.docx)).markdown]).toEqual([md, other, back]);
      }
      // And the same without them, with the blank lines on the side of each
      // with more, which import writes around a quote beside one, or before
      // an item after one. Not where they part two lists, which are one
      // without them (see droppedPartsLists)
      const without = withoutDropped(markdownOf(blocks, '\u0000').md, '\u0000');
      if (without !== md && !droppedPartsLists(blocks)) {
        const none = await convertMdToDocx(without);
        expect([md, without, await paragraphsOf(none.docx)]).toEqual([md, without, paragraphs]);
        // Import closes a style block between a quote in an item and one
        // after the list that a blank line alone parts, and writes two
        // blank lines after the fence it puts in there, on main too, which
        // is no block's an item drops. Where such a block parts the quotes,
        // it writes one. So the blank lines after a closing fence right after
        // a quote in an item, blank lines aside, read as one, where import
        // put one in: where it writes more closing fences, or more right
        // after such a quote. That's one it moved there where the Markdown
        // closes the block after the quote after the list, as the quote has
        // no style of the block's in Word. The blank lines after each other
        // fence count
        const noneBack = (await convertDocx(none.docx)).markdown;
        const closings = (text: string) => (text.match(/^<!-- \/style -->$/gm) ?? []).length;
        const afterItemQuotes = (text: string) => (text.match(/^ +>.*\n+<!-- \/style -->$/gm) ?? []).length;
        const putIn = closings(noneBack) > closings(without) || afterItemQuotes(noneBack) > afterItemQuotes(without);
        const oneAfterFences = (text: string) => putIn ? text.replace(/^( +>.*\n+<!-- \/style -->\n)\n+/gm, (_blank, fence: string) => fence + '\n') : text;
        expect([md, without, oneAfterFences(noneBack)]).toEqual([md, without, oneAfterFences(back)]);
      }
    }), {
      numRuns: 100,
      examples: [
        // A <div> right before a closing fence that is tight, which a blank
        // line parts, as the fence would be the <div>'s HTML
        [[{ kind: 'open', style: 'box', tight: false }, { kind: 'unit', unit: 'div' }, { kind: 'close', tight: true }, { kind: 'para' }]],
        // A style block's fence in an item, after a rule on its marker line,
        // which the item has as its text
        [[{ kind: 'open', style: 'box', tight: false }, { kind: 'list', list: { ordered: false, items: [{ children: [{ kind: 'list', list: { ordered: false, items: [
          { children: [{ kind: 'open', style: 'box', tight: false }], marker: { kind: 'rule' } }, { children: [] }] } }] }] } }, { kind: 'para' }]],
        // A quote in an item and one after the list in a style block, which
        // a directive the item drops parts
        [[{ kind: 'open', style: 'box', tight: false }, { kind: 'list', list: { ordered: false, items: [{ children: [
          { kind: 'quote', list: { ordered: false, items: [{ children: [] }] } }, { kind: 'dropped', html: 'directive', tight: undefined }], marker: { kind: 'rule' } }] } },
        { kind: 'quote', list: { ordered: false, items: [{ children: [] }] } }]],
        // The same, parted by a fenced code block the item drops, in a style
        // block that closes after the quote after the list, whose fence
        // import moves to before that quote
        [[{ kind: 'open', style: 'box', tight: false }, { kind: 'list', list: { ordered: false, items: [{ children: [
          { kind: 'quote', repeated: false }, { kind: 'dropped', html: false, tight: undefined }] }] } },
        { kind: 'quote', repeated: false }, { kind: 'close', tight: false }]],
        // Quotes of lists parted by a directive the item drops, where import
        // writes the fence it puts in right after the item's quote, with no
        // blank line between them
        [[{ kind: 'open', style: 'box', tight: false }, { kind: 'list', list: { ordered: false, items: [{ children: [
          { kind: 'quote', list: { ordered: false, items: [{ children: [] }] } }, { kind: 'dropped', html: 'directive', tight: undefined }] }] } },
        { kind: 'quote', list: { ordered: false, items: [{ children: [] }] } }, { kind: 'inline', style: 'box' }]],
        // A code block before a list whose first item holds nothing before
        // a quote, as a block on its marker line drops, which import took
        // for the paragraph export writes between a code block and a quote,
        // and dropped
        [[{ kind: 'unit', unit: 'code' }, { kind: 'list', list: { ordered: false, items: [{ children: [{ kind: 'quote', repeated: false }], marker: { kind: 'rule' } }] } }]],
        [[{ kind: 'unit', unit: 'code' }, { kind: 'list', list: { ordered: true, items: [
          { children: [{ kind: 'quote', list: { ordered: false, items: [{ children: [] }] } }], marker: { kind: 'fence' } }] } }]],
      ],
    });
  }, 60000);
});
