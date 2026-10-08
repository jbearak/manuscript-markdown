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
// items, quotes of lists, whose items are the quote's paragraphs, and
// fences anywhere, open or close, with a blank line after or before them or
// none, imports the document, and exports what it wrote again, and checks
// that Word gets the same paragraphs, in the same styles, at the same list
// levels and indents, and that import writes the same Markdown again.

type Style = 'box' | 'note';
type Fence = { kind: 'open'; style: Style; tight: boolean } | { kind: 'close'; tight: boolean };
type Child = { kind: 'para' } | { kind: 'list'; list: List; directive?: 'indent' | 'no-indent' } | { kind: 'quote'; list: List } | { kind: 'inline'; style: Style } | Fence;
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
const listArb: fc.Memo<List> = fc.memo(depth => fc.record({
  ordered: fc.boolean(),
  items: fc.array(fc.record({
    children: fc.array(depth > 1 ? fc.oneof(paraArb, listArb(depth - 1).map(list => ({ kind: 'list' as const, list })), fenceArb) : fc.oneof(paraArb, fenceArb), { maxLength: 4 }),
  }), { minLength: 1, maxLength: 3 }),
}));
/** A quote of a list, whose items, with their fences, are its paragraphs.
 *  Only at the top level: in a list item, a quote, at the end of an item
 *  before a list of the other type or with no blank line between it and a
 *  fence or a block the item drops, comes back so the next trip reads
 *  another document, on main too */
function quoteArb(depth: number): fc.Arbitrary<Child> {
  return listArb(depth).map(list => ({ kind: 'quote' as const, list }));
}
/** Documents of up to six paragraphs, lists of up to three levels, some
 *  after an indent directive, quotes of lists, and fences, at the top level */
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
 *  closing one that is `tight`, unless a quote is on the other side: two
 *  quotes with a fence between them and no blank line on one side of it
 *  come back on lines in a row, which the next trip reads as one
 *  paragraph, on main too */
function markdownOf(blocks: Child[]): { md: string; styles: Array<[string, string]> } {
  let n = 0;
  let open: Style | undefined;
  let quoted = false;
  const styles: Array<[string, string]> = [];
  type Chunk = { lines: string[]; fence?: Fence; quote?: true };
  const join = (chunks: Chunk[]): string[] => {
    const lines: string[] = [];
    chunks.forEach((chunk, k) => {
      const tight = k > 0 && !chunk.quote && !chunks[k - 1].quote && (chunks[k - 1].fence?.kind === 'open' && chunks[k - 1].fence!.tight || chunk.fence?.kind === 'close' && chunk.fence.tight);
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
        quoted = true;
        const lines = chunkOf({ kind: 'list', list: child.list }, '').lines.map(line => indent + (line ? '> ' + line : '>'));
        quoted = false;
        return { lines, quote: true };
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

/** `md` without a blank line between a closing fence at the top level and
 *  a list item after it, which the next trip adds where a quote is before
 *  the fence, which changes nothing it renders, on main too */
function withoutBlankAfterFence(md: string): string {
  return md.replace(/<!-- \/style -->\n\n(?=(?:[-*+]|\d+\.) )/g, fence => fence.slice(0, -1));
}

describe('Style blocks around lists and in their items', () => {
  test('give paragraphs at the top level their block\'s style, keep paragraphs\' styles and list levels in Word over a round trip, and come back the same', async () => {
    await fc.assert(fc.asyncProperty(documentArb, async blocks => {
      // Not a quote at a block's start, which import writes before the
      // block's opening fence, with no blank line between, so the next trip
      // loses the one between the block's next two paragraphs, on main too
      fc.pre(!blocks.some((block, k) => block.kind === 'quote' && blocks[k - 1]?.kind === 'open'));
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
      expect([md, withoutBlankAfterFence((await convertDocx(second.docx)).markdown)]).toEqual([md, withoutBlankAfterFence(back)]);
    }), { numRuns: 100 });
  }, 60000);
});
