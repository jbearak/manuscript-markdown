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
// in the item or after it, which some quotes repeat, imports the
// document, and exports what it wrote again, and checks that Word gets the
// same paragraphs, in the same styles, at the same list levels and
// indents, and that import writes the same Markdown again.

type Style = 'box' | 'note';
type Fence = { kind: 'open'; style: Style; tight: boolean } | { kind: 'close'; tight: boolean };
type Child = { kind: 'para' } | { kind: 'list'; list: List; directive?: 'indent' | 'no-indent' } | { kind: 'quote'; list?: List; repeated?: boolean }
  | { kind: 'inline'; style: Style } | { kind: 'dropped'; html: boolean; plain?: boolean } | Fence;
type Item = { children: Child[] };
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
/** A block an item drops, which holds the line of a quote that repeats */
const droppedArb: fc.Arbitrary<Child> = fc.record({ kind: fc.constant('dropped' as const), html: fc.boolean() });
const listArb: fc.Memo<List> = fc.memo(depth => fc.record({
  ordered: fc.boolean(),
  items: fc.array(fc.record({
    children: fc.array(depth > 1 ? fc.oneof(paraArb, listArb(depth - 1).map(list => ({ kind: 'list' as const, list })), quoteArb(depth - 1), fenceArb, droppedArb)
      : fc.oneof(paraArb, quoteParaArb, fenceArb, droppedArb), { maxLength: 4 }),
  }), { minLength: 1, maxLength: 3 }),
}));
/** A quote of a paragraph, or of a list, whose items, with their fences,
 *  are its paragraphs */
function quoteArb(depth: number): fc.Arbitrary<Child> {
  return fc.oneof(quoteParaArb, listArb(depth).map(list => ({ kind: 'quote' as const, list })));
}
/** Documents of up to six paragraphs, lists of up to three levels, some
 *  after an indent directive, quotes, and fences, at the top level */
const documentArb: fc.Arbitrary<Child[]> = fc.array(fc.oneof(
  paraArb,
  fc.record({ list: listArb(3), directive: fc.constantFrom(undefined, 'indent' as const, 'no-indent' as const) })
    .map(({ list, directive }) => ({ kind: 'list' as const, list, ...(directive ? { directive } : {}) })),
  quoteArb(2),
  fenceArb,
), { minLength: 1, maxLength: 6 });

/** The Markdown of `blocks`, with each paragraph's and item's text unique,
 *  and the custom style each paragraph at the top level takes in Word, or
 *  '' for none: that of the block open at the top level, or of its block
 *  on one line. A block opens and closes at its fences there, and a block
 *  that opens in a list item closes it, but not one in a quote's item,
 *  which the quote drops, and a block on one line closes it.
 *  A blank line between blocks, but not after an opening fence or before a
 *  closing one that is `tight` */
function markdownOf(blocks: Child[]): { md: string; styles: Array<[string, string]> } {
  let n = 0;
  let open: Style | undefined;
  let quoted = false;
  const styles: Array<[string, string]> = [];
  type Chunk = { lines: string[]; fence?: Fence };
  const join = (chunks: Chunk[]): string[] => {
    const lines: string[] = [];
    chunks.forEach((chunk, k) => {
      const tight = k > 0 && (chunks[k - 1].fence?.kind === 'open' && chunks[k - 1].fence!.tight || chunk.fence?.kind === 'close' && chunk.fence.tight);
      if (k > 0 && !tight) lines.push('');
      lines.push(...chunk.lines);
    });
    return lines;
  };
  const chunkOf = (child: Child, indent: string): Chunk => {
    const top = indent === '' && !quoted;
    switch (child.kind) {
      case 'para':
        if (top) styles.push(['p' + n, open ? 'MsCustom' + open[0].toUpperCase() + open.slice(1) : '']);
        return { lines: [indent + 'p' + n++] };
      case 'inline':
        if (top) {
          styles.push(['p' + n, 'MsCustom' + child.style[0].toUpperCase() + child.style.slice(1)]);
          open = undefined;
        }
        return { lines: [indent + '<!-- style: ' + child.style + ' -->p' + n++ + '<!-- /style -->'] };
      case 'quote': {
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
        // it
        const line = indent + (child.plain ? 'x' : '> q');
        return { lines: child.html ? [indent + '<pre>', line, '', indent + 'p' + n++] : [indent + '```', line, indent + '```'] };
      }
      case 'list':
        return { lines: (child.directive ? [indent + '<!-- ' + child.directive + ' -->'] : []).concat(join(child.list.items.map((item, k) => {
          const marker = child.list.ordered ? (k + 1) + '. ' : '- ';
          const inner = indent + ' '.repeat(marker.length);
          return { lines: join([{ lines: [indent + marker + 'i' + n++] }, ...item.children.map(grandchild => chunkOf(grandchild, inner))]) };
        }))) };
      default:
        if (top) open = child.kind === 'open' ? child.style : undefined;
        else if (child.kind === 'open' && !quoted) open = undefined;
        return { lines: [indent + (child.kind === 'open' ? '<!-- style: ' + child.style + ' -->' : '<!-- /style -->')], fence: child };
    }
  };
  return { md: twoStyles + join(blocks.map(block => chunkOf(block, ''))).join('\n') + '\n', styles };
}

/** `blocks` with plain text in the blocks items drop, which Word gets
 *  nothing of */
function withPlainDropped(blocks: Child[]): Child[] {
  const list = (l: List): List => ({ ...l, items: l.items.map(item => ({ children: withPlainDropped(item.children) })) });
  return blocks.map(child => child.kind === 'dropped' ? { ...child, plain: true }
    : child.kind === 'list' ? { ...child, list: list(child.list) }
    : child.kind === 'quote' && child.list ? { ...child, list: list(child.list) } : child);
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
      const { md, styles } = markdownOf(blocks);
      const first = await convertMdToDocx(md);
      // Each paragraph at the top level in the style of the block it's in
      const paragraphs = await paragraphsOf(first.docx);
      expect([md, styles.map(([text]) => [text, paragraphs.find(p => p.endsWith('|' + text))?.split('|')[0]])]).toEqual([md, styles]);
      const back = (await convertDocx(first.docx)).markdown;
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
    }), { numRuns: 100 });
  }, 60000);
});
