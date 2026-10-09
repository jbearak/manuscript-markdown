import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { type LineEdit, lineCount, linesAfterEdits } from './line-map';
import { preprocessCriticMarkupWithLines } from './critic-markup';

// Export records the blank lines around each quote in the source, which it
// reads through the lines each preprocessing step says it wrote from (see
// line-map.ts and annotateBlockquoteSpacing in md-to-docx.ts). Steps rewrite
// blocks to other lines, or take them out: grid tables, LaTeX environments,
// notes' definitions, and CriticMarkup spans over many lines, which they
// join, and code and HTML blocks hold lines that look like quotes'. Before,
// export searched the source for each quote's lines, which found such a
// block's lines first where they were the same. This exports documents of
// quotes, at the top level and in an item of a sublist, alerts or not,
// some with a comment's body over two lines on the marker's line, with the
// same text or their own, among paragraphs and such blocks, notes of
// missing citations, which export takes out, and tables whose cells number
// formatting writes on fewer lines, with up to three blank lines between,
// and at the end, which export trims, with table-digits and callout-labels
// set or not, and checks that each quote's spacing is the same with x for
// the text of the lines like quotes' in those blocks, and with each block a
// line, but a LaTeX environment with a line of > in it, which starts a
// quote there, each comment's body on one line, and with no blank lines at
// the end.

type Block =
  | { kind: 'para' }
  | { kind: 'quote'; repeated: boolean; nested: boolean; alert: boolean; body: boolean }
  | { kind: 'code' | 'html' | 'latex' | 'latexQuote' | 'grid' | 'definition' | 'critic' | 'moved' | 'note' | 'numbers' };

const blockArb: fc.Arbitrary<Block> = fc.oneof(
  fc.constant({ kind: 'para' as const }),
  fc.record({ kind: fc.constant('quote' as const), repeated: fc.boolean(), nested: fc.boolean(), alert: fc.boolean(), body: fc.boolean() }),
  fc.constantFrom(...(['code', 'html', 'latex', 'latexQuote', 'grid', 'definition', 'critic', 'moved', 'note', 'numbers'] as const).map(kind => ({ kind }))),
);
const documentArb = fc.record({
  tableDigits: fc.boolean(),
  calloutLabels: fc.boolean(),
  blocks: fc.array(fc.record({ block: blockArb, blank: fc.integer({ min: 0, max: 3 }) }), { minLength: 1, maxLength: 8 }),
  trailing: fc.integer({ min: 0, max: 3 }),
});

/** Whether a block is a quote at the top level */
const topQuote = (block: Block | undefined) => block?.kind === 'quote' && !block.nested;

/** The Markdown of `blocks`, with the lines like quotes' in the blocks
 *  preprocessing rewrites `as` written, with x for their text, or each such
 *  block a line, and as written, `trailing` blank lines at the end */
function markdownOf({ blocks, trailing, tableDigits, calloutLabels }: { blocks: Array<{ block: Block; blank: number }>; trailing: number; tableDigits: boolean; calloutLabels: boolean },
  as: 'written' | 'x' | 'line'): string {
  let n = 0;
  const settings = (tableDigits ? 'table-digits: 2\n' : '') + (calloutLabels ? '' : 'callout-labels: false\n');
  const like = (line: string) => as === 'written' ? line : line.replace(/q$/, 'x');
  const body = blocks.map(({ block, blank }, k) => {
    let text: string;
    if (block.kind === 'para') text = 'p' + n++;
    else if (block.kind === 'quote') {
      const line = block.repeated ? 'q' : 'p' + n++;
      const indent = block.nested ? '    ' : '';
      // A comment's body after an alert's marker, which shows nothing there,
      // over two lines, or on one
      const commentBody = !block.alert || !block.body ? '' : as === 'line' ? '{#b' + n++ + '>>a b<<}\n' + indent + '> '
        : '{#b' + n++ + '>>a\n' + indent + '> b<<}\n' + indent + '> ';
      const marker = (block.alert ? '> [!NOTE] ' : '> ') + commentBody;
      text = block.nested ? '- a' + n++ + '\n  - b' + n++ + '\n\n' + indent + marker + line : marker + line;
    } else if (block.kind === 'note') {
      // A note export takes out, or a note's definition, which it takes out
      // too, as a line of its own
      text = as === 'line' ? '[^d' + n++ + ']: x' : 'Citation data for @k' + n++ + ' was not found in the bibliography file.';
    } else if (as === 'line' && block.kind !== 'latexQuote') {
      // A note's definition stays one, which Word gets nothing of. Another
      // is a comment, which no quote's text goes on into, as a line of
      // text after one would
      text = block.kind === 'definition' ? '[^d' + n++ + ']: x' : '<!-- x -->';
    } else {
      switch (block.kind) {
        case 'code': text = '```\n' + like('> q') + '\n' + like('    > q') + '\n```'; break;
        case 'html': text = '<div>\n' + like('> q') + '\n' + like('    > q') + '\n</div>'; break;
        case 'latex': text = '\\begin{equation}\na\n' + like('    > q') + '\n\\end{equation}'; break;
        // A line of > at a line's start in one starts a quote in it
        case 'latexQuote': text = '\\begin{equation}\n' + like('> q') + '\n\\end{equation}'; break;
        case 'grid': text = '+-----+\n| ' + like('> q') + ' |\n+-----+'; break;
        case 'definition': text = '[^d' + n++ + ']: note\n    more\n\n    again'; break;
        case 'critic': text = '{++a\n' + like('> q') + '\n\n' + like('    > q') + '\nb++}'; break;
        // A cell of a dash for a zero over lines, which number formatting
        // writes as 0.00 on one, with table-digits set
        case 'numbers': text = '<table><tr><td data-mm-kind="number" data-mm-raw="0">\n-\n</td></tr></table>'; break;
        default: text = 'p' + n++ + ' {++\nadded++}';
      }
    }
    // An HTML block goes on to a blank line, which a line after it would be
    // in, as a quote in a list item's text, or in a LaTeX environment, would
    // go on in one, which export doesn't end, as it does a quote at the top
    // level. A note is a paragraph of its own, which a quote at the top
    // level ends, and a line of another paragraph otherwise
    const before = blocks[k - 1]?.block;
    const open = before?.kind === 'html' || before?.kind === 'numbers' || before?.kind === 'latexQuote' || before?.kind === 'quote' && before.nested
      || (before?.kind === 'note' || block.kind === 'note') && !topQuote(before) && !topQuote(block);
    return (k > 0 ? '\n'.repeat((open ? Math.max(1, blank) : blank) + 1) : '') + text;
  }).join('') + '\n' + (as === 'written' ? '\n'.repeat(trailing) : '');
  return (settings ? '---\n' + settings + '---\n\n' : '') + body;
}

/** The quote spacing export records in `docx`'s custom properties, but
 *  quotes' places after sublists, which hold a hash of their text */
async function quoteSpacing(docx: Uint8Array): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(docx)).file('docProps/custom.xml')?.async('string') ?? '';
  return [...xml.matchAll(/<property\b[^>]*name="(MANUSCRIPT_BLOCKQUOTE_[^"]*)"[^>]*>(?:(?!<\/property>).)*?<vt:lpwstr>([^<]*)<\/vt:lpwstr>/gs)]
    .filter(([, name]) => !name.startsWith('MANUSCRIPT_BLOCKQUOTE_LIST_LEVELS'))
    .map(([, name, value]) => name + '=' + value);
}

describe('Quote spacing through preprocessing', () => {
  test('is the same with other text in the blocks preprocessing rewrites, and with each of them a line', async () => {
    await fc.assert(fc.asyncProperty(documentArb, async document => {
      const written = markdownOf(document, 'written');
      const spacing = await quoteSpacing((await convertMdToDocx(written)).docx);
      // With the Markdown, for a failure's report
      for (const as of ['x', 'line'] as const) {
        const other = markdownOf(document, as);
        expect([written, other, await quoteSpacing((await convertMdToDocx(other)).docx)]).toEqual([written, other, spacing]);
      }
    }), { numRuns: 100 });
  }, 60000);
});

describe('Line maps', () => {
  /** Whether `at` ends a line of `text`, as markdown-it ends one */
  const endsLineAt = (text: string, at: number) => text[at] === '\n' || (text[at] === '\r' && text[at + 1] !== '\n');

  /** The lines of `input` after `edits`, character by character, as the
   *  contract in line-map.ts has them */
  function linesByCharacter(input: string, edits: LineEdit[]): number[] {
    // Each character of the output, and where it was copied from
    const chars: Array<{ char: string; from?: number }> = [];
    let cursor = 0;
    for (const edit of edits) {
      for (; cursor < edit.start; cursor++) chars.push({ char: input[cursor], from: cursor });
      for (const char of edit.text.split('')) chars.push({ char });
      cursor = edit.end;
    }
    for (; cursor < input.length; cursor++) chars.push({ char: input[cursor], from: cursor });
    const output = chars.map(({ char }) => char).join('');
    const lineOf = (position: number) => {
      let line = 0;
      for (let at = 0; at < position; at++) if (endsLineAt(input, at)) line++;
      return line;
    };
    // The lines of the characters copied of those from `from` to `to`
    const copied = (from: number, to: number) => chars.slice(from, to).flatMap(({ from: at }) => at === undefined ? [] : [lineOf(at)]);
    const ranges: Array<[number, number]> = [];
    let start = 0;
    for (let at = 0; at < output.length; at++) {
      if (endsLineAt(output, at)) {
        ranges.push([start, at + 1]);
        start = at + 1;
      }
    }
    ranges.push([start, output.length]);
    const last = lineOf(input.length);
    return [...ranges.map(([from, to]) => {
      const own = copied(from, to);
      // Not blank, of spaces and tabs alone
      if (own.length > 0 && /[^ \t\r\n]/.test(output.slice(from, to))) return own[0];
      const before = copied(0, from);
      const after = copied(from, chars.length);
      return Math.min(before.length > 0 ? before[before.length - 1] + 1 : 0, after.length > 0 ? after[0] : last);
    }), last + 1];
  }

  // Text of lines and parts of them, with each line end markdown-it reads,
  // whole lines, blank or not, or none, so that edits take out or replace
  // whole lines, or parts, put lines in at a line's start, start and end the
  // text, and come one after another
  const lineEndArb = fc.constantFrom('\n', '\r\n', '\r');
  const partArb = fc.array(fc.constantFrom('a', ' ', '\t', '\n', '\r\n', '\r'), { maxLength: 5 }).map(parts => parts.join(''));
  const wholeLinesArb = fc.array(fc.tuple(fc.constantFrom('', ' ', 'a', 'ab '), lineEndArb).map(([text, end]) => text + end), { minLength: 1, maxLength: 3 })
    .map(lines => lines.join(''));
  const textArb = fc.oneof(fc.constant(''), partArb, wholeLinesArb);
  const editsArb = fc.record({
    parts: fc.array(fc.record({ keep: textArb, removed: textArb, text: textArb }), { maxLength: 5 }),
    tail: textArb,
    // Blank lines at the end, which export trims to a line end
    trim: fc.option(fc.integer({ min: 1, max: 3 })),
  });

  test('give each line after edits the line of its first copied character, or blank or with none, the line after the last before it, or the next\'s', () => {
    fc.assert(fc.property(editsArb, ({ parts, tail, trim }) => {
      let input = '';
      let output = '';
      const edits: LineEdit[] = [];
      for (const { keep, removed, text } of parts) {
        input += keep;
        output += keep;
        edits.push({ start: input.length, end: input.length + removed.length, text });
        input += removed;
        output += text;
      }
      input += tail;
      output += tail;
      if (trim !== null) {
        edits.push({ start: input.length, end: input.length + 1 + trim, text: '\n' });
        input += '\n'.repeat(1 + trim);
        output += '\n';
      }
      const lines = linesAfterEdits(input, edits);
      expect(lines).toEqual(linesByCharacter(input, edits));
      expect(lines).toHaveLength(lineCount(output) + 1);
      expect(lines[lines.length - 1]).toBe(lineCount(input));
      // In order
      for (let k = 1; k < lines.length; k++) expect(lines[k]).toBeGreaterThanOrEqual(lines[k - 1]);
    }), { numRuns: 5000 });
  });

  test('give a line after lines taken out its own, but a blank one the first of them, and a line after a trim of the blank lines at the end the one after the last kept', () => {
    // Codex's: export took out the note of a missing citation before an
    // alert, and trimmed the blank lines after one
    expect(linesAfterEdits('removed\n> [!NOTE] q\n', [{ start: 0, end: 8, text: '' }])).toEqual([1, 2, 3]);
    expect(linesAfterEdits('p\n\n\n> [!NOTE] q\n\n\n', [{ start: 15, end: 18, text: '\n' }])).toEqual([0, 1, 2, 3, 4, 7]);
    // Notes after a comment, which import wrote right after it: the blank
    // line after the first comes from it, as the comment's last line's
    // next, so the comment's lines end before it
    expect(linesAfterEdits('-->\nnote\n\nnote\n', [{ start: 4, end: 9, text: '' }, { start: 10, end: 15, text: '' }])).toEqual([0, 1, 3, 5]);
  });

  test('give each line CriticMarkup preprocessing writes the line of its start', () => {
    const partArb = fc.constantFrom('a', 'b', ' ', '\n', '\n\n', '> ', '{++', '++}', '{--', '--}', '{>>', '<<}', '{==', '==}', '```', '- ');
    fc.assert(fc.property(fc.array(partArb, { maxLength: 20 }).map(parts => parts.join('')), markdown => {
      const { output, lines } = preprocessCriticMarkupWithLines(markdown);
      expect(lines).toHaveLength(output.split('\n').length + 1);
      expect(lines[lines.length - 1]).toBe(markdown.split('\n').length);
      const source = markdown.split('\n');
      output.split('\n').forEach((line, k) => {
        // A line with no span's placeholders, which no edit wrote, is the
        // source's line it comes from
        if (lines[k + 1] === lines[k] + 1 && !/\uE000/.test(line) && !line.includes('{') && source[lines[k]] !== undefined && !source[lines[k]].includes('{')) expect(line).toBe(source[lines[k]]);
      });
    }), { numRuns: 3000 });
  });
});
