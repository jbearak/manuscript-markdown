import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';

// The blank lines before list items, which make their lists loose, go to
// Word as records keyed by each item's list block and place in it, which
// export and import count apart (see listBlockPlaces in converter.ts). This
// exports documents of lists, nested and of either type, with paragraphs
// and quotes in their items, between paragraphs, headings and quotes, and
// checks that each item comes back with the blank line before it, or none,
// as it had.

type Run = { ordered: boolean; loose: boolean; items: Item[] };
type Item = { sublists: Run[]; sublistLoose: boolean; para: boolean; quote: boolean };
type Block = { kind: 'para' | 'heading' | 'quote' } | { kind: 'list'; runs: Run[]; directive?: 'indent' | 'no-indent' };

/** Documents of up to four blocks, with quotes or without, and with
 *  paragraphs in items at every level, or only at the top one (`paras`) */
function documentArb(quotes: boolean, paras: 'all' | 'top'): fc.Arbitrary<Block[]> {
  const itemArb: fc.Memo<Item> = fc.memo(depth => fc.record({
    sublists: depth > 1 ? fc.array(runArb(depth - 1), { maxLength: 2 }) : fc.constant([]),
    sublistLoose: fc.boolean(),
    para: paras === 'all' || depth === 3 ? fc.boolean() : fc.constant(false),
    quote: quotes ? fc.boolean() : fc.constant(false),
  }));
  const runArb = (depth: number): fc.Arbitrary<Run> => fc.record({
    ordered: fc.boolean(),
    loose: fc.boolean(),
    items: fc.array(itemArb(depth), { minLength: 1, maxLength: 3 }),
  });
  const blockArb: fc.Arbitrary<Block> = fc.oneof(
    fc.constant({ kind: 'para' as const }),
    fc.constant({ kind: 'heading' as const }),
    ...(quotes ? [fc.constant({ kind: 'quote' as const })] : []),
    fc.record({
      runs: fc.array(runArb(3), { minLength: 1, maxLength: 3 }),
      directive: fc.constantFrom(undefined, 'indent' as const, 'no-indent' as const),
    }).map(({ runs, directive }) => ({ kind: 'list' as const, runs, ...(directive ? { directive } : {}) })),
  );
  return fc.array(blockArb, { minLength: 1, maxLength: 4 });
}

/** The Markdown of `blocks`, with each item's text unique, and the texts of
 *  its items, and of those that start a list at the top level, as one after
 *  a paragraph in the item before does where a template numbers the
 *  paragraph (`numbered`) */
function markdownOf(blocks: Block[], numbered = false): { md: string; firsts: Set<string>; items: string[] } {
  let n = 0;
  const firsts = new Set<string>();
  const items: string[] = [];
  // Runs side by side at a level alternate their type, a change of which
  // starts a list, as runs of one type would be one list
  const runsOf = (runs: Run[]) => runs.map((run, k) => ({ ...run, ordered: k === 0 ? run.ordered : (k % 2 === 1) !== runs[0].ordered }));
  const runLines = (runs: Run[], indent: string, top: boolean): string[] => {
    const lines: string[] = [];
    runsOf(runs).forEach((run, r) => {
      run.items.forEach((item, k) => {
        const text = 'i' + n++;
        items.push(text);
        const marker = run.ordered ? (k + 1) + '. ' : '- ';
        // After a quote, a blank line, as an item right after one would be
        // its text, lazily, and before a list of the other type, as import
        // writes one between lists
        const afterQuote = /> q\d+$/.test(lines[lines.length - 1] ?? '');
        const afterPara = k > 0 && run.items[k - 1].para;
        const blank = lines.length > 0 && (afterQuote || (k > 0 ? run.loose : r > 0));
        if (blank) lines.push('');
        if (top && (k === 0 || numbered && afterPara)) firsts.add(text);
        lines.push(indent + marker + text);
        const inner = indent + ' '.repeat(marker.length);
        if (item.sublists.length) {
          if (item.sublistLoose) lines.push('');
          lines.push(...runLines(item.sublists, inner, false));
        }
        if (item.para) lines.push('', inner + 'c' + n++);
        if (item.quote) lines.push('', inner + '> q' + n++);
      });
    });
    return lines;
  };
  const md = blocks.map(block => block.kind === 'para' ? 'p' + n++
    : block.kind === 'heading' ? '# h' + n++
      : block.kind === 'quote' ? '> q' + n++
        // After a list too, which Word shows as one with the list before it
        // where they're of the same type, as export writes nothing for the
        // directive between them
        : (block.directive ? '<!-- ' + block.directive + ' -->\n' : '') + runLines(block.runs, '', true).join('\n')).join('\n\n') + '\n';
  return { md, firsts, items };
}

/** What comes before the item whose text is `text` in `md` that export
 *  records: for the first of a list at the top level (`first`), which
 *  starts a block, an indent directive, or else nothing; for another, a
 *  blank line, or none */
function before(md: string, text: string, first: boolean): string | boolean | undefined {
  const lines = md.split('\n');
  const at = lines.findIndex(line => new RegExp('^[ >]*(?:[-*+]|\\d+[.)]) +' + text + '$').test(line));
  if (at === -1) return undefined;
  const line = at > 0 ? lines[at - 1] : '';
  return first ? /^<!--/.test(line) && line : /^[ >]*$/.test(line);
}

/** A template whose default paragraph style numbers its paragraphs, and
 *  with `quotes` false, not its quote style's */
async function normalNumbered(quotes = true): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync((await convertMdToDocx('1. a')).docx);
  const styles = (await zip.file('word/styles.xml')!.async('string'))
    .replace(/<w:style [^>]*w:default="1"[^>]*w:styleId="Normal">[^]*?<w:pPr>/, (match: string) => match + '<w:numPr><w:numId w:val="2"/></w:numPr>')
    .replace(quotes ? /(?!)/ : /<w:style [^>]*w:styleId="GitHubBlockquote"[^>]*>[^]*?<w:pPr>/, (match: string) => match + '<w:numPr><w:numId w:val="0"/></w:numPr>');
  zip.file('word/styles.xml', styles);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('The blank lines before list items and the indent directives before lists', () => {
  /** Each item's text, with what comes before it in `md` and in `back` */
  const compared = (md: string, back: string, items: string[], firsts: Set<string>) =>
    items.map(text => [text, before(back, text, firsts.has(text)), before(md, text, firsts.has(text))]);

  test('come back where they were', async () => {
    await fc.assert(fc.asyncProperty(documentArb(true, 'all'), async blocks => {
      const { md, firsts, items } = markdownOf(blocks);
      const back = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
      for (const [text, got, had] of compared(md, back, items, firsts)) expect([text, got]).toEqual([text, had]);
    }), { numRuns: 60 });
  }, 60000);

  test('come back where they were where a template numbers paragraphs', async () => {
    // Which Word numbers as items, and which export wrote as paragraphs, as
    // it does an item's, which then starts a list, at the top level, so
    // there are paragraphs only in top-level items. A quote's too, which
    // Word shows as an item, as import writes it, so there are none
    const templateDocx = await normalNumbered();
    await fc.assert(fc.asyncProperty(documentArb(false, 'top'), async blocks => {
      const { md, firsts, items } = markdownOf(blocks, true);
      const back = (await convertDocx((await convertMdToDocx(md, { templateDocx })).docx)).markdown;
      for (const [text, got, had] of compared(md, back, items, firsts)) expect([text, got]).toEqual([text, had]);
    }), { numRuns: 60 });
  }, 60000);

  test('come back where they were where a template numbers paragraphs but not quotes', async () => {
    // Whose spacers, with no style, the template would number, but import
    // drops them, so they start no list. Quotes in items stay quotes. Not
    // in a list's last item, after which export writes empty paragraphs,
    // which the template numbers, so Word shows empty items there
    const templateDocx = await normalNumbered(false);
    const quoteEnds = (runs: Run[]): boolean => runs.some(run => run.items[run.items.length - 1].quote || run.items.some(item => quoteEnds(item.sublists)));
    await fc.assert(fc.asyncProperty(documentArb(true, 'top'), async blocks => {
      fc.pre(!blocks.some(block => block.kind === 'list' && quoteEnds(block.runs)));
      const { md, firsts, items } = markdownOf(blocks, true);
      const back = (await convertDocx((await convertMdToDocx(md, { templateDocx })).docx)).markdown;
      for (const [text, got, had] of compared(md, back, items, firsts)) expect([text, got]).toEqual([text, had]);
    }), { numRuns: 60 });
  }, 60000);
});
