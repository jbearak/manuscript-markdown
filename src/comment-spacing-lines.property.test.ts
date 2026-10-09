import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx, parseMd } from './md-to-docx';

// Export records the blank lines around each comment alone in its
// paragraph, and around a style block's fences, which are comments too, in
// the source, which it reads through the lines each preprocessing step says
// it wrote from (see line-map.ts and parseMd in md-to-docx.ts), as it does
// a quote's (see quote-spacing-lines.property.test.ts). Before, export
// searched the source for each comment's text, from the last one it found,
// which found the same line in a block before it first, as in code. This
// exports documents of comments, with the same text or their own, and
// fences, among paragraphs and blocks preprocessing rewrites or takes out,
// some holding comments' lines, and notes of missing citations, which
// export takes out, after frontmatter or none, with up to three blank lines
// between, and at the end, and checks that each comment's spacing, and
// each fence's, is the same with x for those lines' text, with each block
// a line, and with \r\n for each line end, and that parseMd, with no
// source, reads the same spacing with \r\n or a \r alone for each, as
// markdown-it reads them.

type Block =
  | { kind: 'para' }
  | { kind: 'comment'; repeated: boolean }
  | { kind: 'open' | 'close' }
  | { kind: 'code' | 'html' | 'latex' | 'latexComment' | 'grid' | 'definition' | 'critic' | 'moved' | 'quote' | 'note' }
  | { kind: SplitKind };
// Blocks export splits in two or more, at a revised equation or a paragraph
// break in a revision: a comment after an equation on its line, or after
// such a break, and a quote with an equation in its text
type SplitKind = 'mathComment' | 'breakComment' | 'mathQuote';
const SPLIT_KINDS: readonly string[] = ['mathComment', 'breakComment', 'mathQuote'];
// The blocks whose spacing doesn't hang on the blank lines next to them,
// which can go around a comment split from its block in the 'spaced'
// variant (see markdownOf)
const PLAIN_KINDS: readonly string[] = ['para', 'code', 'latex', 'grid', 'definition', 'critic', 'moved', 'mathComment', 'breakComment'];
const D = '$'.repeat(2);

const blockArb: fc.Arbitrary<Block> = fc.oneof(
  fc.constant({ kind: 'para' as const }),
  fc.record({ kind: fc.constant('comment' as const), repeated: fc.boolean() }),
  fc.constantFrom(...(['open', 'close'] as const).map(kind => ({ kind }))),
  fc.constantFrom(...(['code', 'html', 'latex', 'latexComment', 'grid', 'definition', 'critic', 'moved', 'quote', 'note'] as const).map(kind => ({ kind }))),
  fc.constantFrom(...(['mathComment', 'breakComment', 'mathQuote'] as const).map(kind => ({ kind }))),
);
const documentArb = fc.record({
  frontmatter: fc.boolean(),
  blocks: fc.array(fc.record({ block: blockArb, blank: fc.integer({ min: 0, max: 3 }) }), { minLength: 1, maxLength: 8 }),
  trailing: fc.integer({ min: 0, max: 3 }),
  // The line ends parseMd reads it with, besides \n
  lineEnd: fc.constantFrom('\r\n', '\r'),
});

/** Whether a block is a comment, or a style block's fence, which is one */
const isComment = (block: Block | undefined) => block?.kind === 'comment' || block?.kind === 'open' || block?.kind === 'close';

/** The Markdown of `blocks`, with the lines like comments' in the blocks
 *  preprocessing rewrites `as` written, with x for their text, or each such
 *  block a line of text, but those export splits, and `trailing` blank lines
 *  at the end. Or 'spaced', as written, with a blank line more on each side
 *  of a block a comment is split from, between blocks in PLAIN_KINDS */
function markdownOf({ frontmatter, blocks, trailing }: { frontmatter: boolean; blocks: Array<{ block: Block; blank: number }>; trailing: number }, as: 'written' | 'x' | 'line' | 'spaced'): string {
  let n = 0;
  const plain = (k: number) => k < 0 || k >= blocks.length || PLAIN_KINDS.includes(blocks[k].block.kind);
  // Where a blank line is on each side already, so the blocks stay apart
  const spaced = (k: number) => as === 'spaced' && k >= 0 && k < blocks.length
    && (blocks[k].block.kind === 'mathComment' || blocks[k].block.kind === 'breakComment') && plain(k - 1) && plain(k + 1)
    && (k === 0 || blocks[k].blank > 0) && (k + 1 === blocks.length || blocks[k + 1].blank > 0);
  // The blank lines more before each block, and at the end
  const extra = (k: number) => (k > 0 && spaced(k) ? 1 : 0) + (spaced(k - 1) ? 1 : 0);
  const like = (line: string) => as === 'written' ? line : line.replace(/<!-- c -->|<!-- \/style -->/, '<!-- x -->');
  const body = blocks.map(({ block, blank }, k) => {
    let text: string;
    if (block.kind === 'para') text = 'p' + n++;
    else if (block.kind === 'comment') text = block.repeated ? '<!-- c -->' : '<!-- c' + n++ + ' -->';
    else if (block.kind === 'open') text = '<!-- style: box -->';
    else if (block.kind === 'close') text = '<!-- /style -->';
    // A note export takes out, or a note's definition, which it takes out
    // too, as a line of its own
    else if (block.kind === 'note') text = as === 'line' ? '[^d' + n++ + ']: x' : 'Citation data for @k' + n++ + ' was not found in the bibliography file.';
    else if (as === 'line' && block.kind !== 'latexComment' && !SPLIT_KINDS.includes(block.kind)) {
      // A note's definition stays one, which Word gets nothing of
      text = block.kind === 'definition' ? '[^d' + n++ + ']: x' : 'x' + n++;
    } else {
      switch (block.kind) {
        case 'code': text = '```\n' + like('<!-- c -->') + '\n' + like('<!-- /style -->') + '\n```'; break;
        case 'html': text = '<div>\n' + like('<!-- c -->') + '\n' + like('<!-- /style -->') + '\n</div>'; break;
        case 'latex': text = '\\begin{equation}\na\nb\n\\end{equation}'; break;
        // A comment's line in one is a comment, which ends the paragraph
        // markdown-it reads the environment as
        case 'latexComment': text = '\\begin{equation}\n' + like('<!-- c -->') + '\n\\end{equation}'; break;
        case 'grid': text = '+--------------+\n| ' + like('<!-- c -->') + '   |\n+--------------+'; break;
        case 'definition': text = '[^d' + n++ + ']: note\n    more\n\n    again'; break;
        case 'critic': text = '{++a\n' + like('<!-- c -->') + '\n\n' + like('<!-- /style -->') + '\nb++}'; break;
        case 'quote': text = '> ' + like('<!-- c -->') + '\n>\n> q' + n++; break;
        case 'mathComment': text = '{--' + D + 'x' + n++ + D + '--}' + like('<!-- c -->'); break;
        case 'breakComment': text = 'a' + n++ + '{++\n\n++}' + like('<!-- c -->'); break;
        case 'mathQuote': text = '> a' + n++ + ' {--' + D + 'x' + D + '--} b'; break;
        default: text = 'p' + n++ + ' {++\nadded++}';
      }
    }
    // An HTML block goes on to a blank line, which a line after it would be
    // in, as text after a quote, or a LaTeX environment, would go on in it.
    // A note is a paragraph of its own, which a comment ends, and a line of
    // another paragraph otherwise
    const before = blocks[k - 1]?.block;
    const open = before?.kind === 'html' || before?.kind === 'latexComment' || before?.kind === 'quote' || before?.kind === 'mathQuote'
      || (before?.kind === 'note' || block.kind === 'note') && !isComment(before) && !isComment(block);
    return (k > 0 ? '\n'.repeat((open ? Math.max(1, blank) : blank) + 1 + extra(k)) : '') + text;
  }).join('') + '\n' + '\n'.repeat(trailing + extra(blocks.length));
  return (frontmatter ? '---\nstyles:\n  box:\n    font-style: italic\n---\n\n' : '') + body;
}

/** The blank lines before and after each comment alone in its paragraph,
 *  or with IDs, that parseMd reads in `markdown`, with no source */
const parsedSpacing = (markdown: string) => parseMd(markdown)
  .filter(token => token.blankLinesBefore !== undefined || token.blankLinesAfter !== undefined)
  .map(token => [token.blankLinesBefore, token.blankLinesAfter]);

/** The comments' spacing, and the style blocks' fences', that export
 *  records in `docx`'s custom properties, and the quotes' too where `quotes` */
async function commentSpacing(docx: Uint8Array, quotes = false): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(docx)).file('docProps/custom.xml')?.async('string') ?? '';
  return [...xml.matchAll(/<property\b[^>]*name="(MANUSCRIPT_(?:HTML_COMMENT|SENTINEL|BLOCKQUOTE)_[^"]*)"[^>]*>(?:(?!<\/property>).)*?<vt:lpwstr>([^<]*)<\/vt:lpwstr>/gs)]
    .filter(([, name]) => quotes || !name.startsWith('MANUSCRIPT_BLOCKQUOTE_'))
    .map(([, name, value]) => name + '=' + value);
}

describe('Comment spacing through preprocessing', () => {
  const styles = '---\nstyles:\n  box:\n    font-style: italic\n---\n\n';
  test.each([
    ['a comment\'s line in a code block before it', '```\n<!-- c -->\n```\n\n\n<!-- c -->\n\np\n'],
    ['a comment\'s line in an HTML block before it, which came back as text', '<div>\n<!-- c -->\n</div>\n\n\n<!-- c -->\n\np\n'],
    ['a style block\'s fence\'s line in a code block before it', styles + '```\n<!-- style: box -->\n```\n\n\n<!-- style: box -->\n\np\n\n<!-- /style -->\n\nq\n'],
  ])('keeps the blank lines around a comment past %s', async (_name, md) => {
    // Export searched the source for the comment's text, and found the
    // block's line first, with no blank lines around it
    const back = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
    expect(back).toBe(md);
    expect((await convertDocx((await convertMdToDocx(back)).docx)).markdown).toBe(md);
  });

  test.each([['\\r', '\r'], ['\\r\\n', '\r\n'], ['\\n', '\n']])('reads the blank lines around a comment past line ends of %s', (_name, eol) => {
    // The steps before markdown-it split lines at \n alone, and a \r alone
    // ends one where markdown-it reads it, so the lines spacing read held
    // none of the blank lines after the comment
    const spacing = (markdown: string) => parsedSpacing(markdown.replace(/\n/g, eol));
    expect(spacing('<!-- c -->\n\n\ntext')).toEqual([[0, 2]]);
    expect(spacing('text\n\n<!-- c -->\n\n\n\ntext')).toEqual([[1, 3]]);
  });

  test('records no blank lines around a comment split from a block, which are the block\'s', async () => {
    // A comment after a revised equation on its line is a block of its own
    // in Word, which had the line's blank lines: two before it, which came
    // back after the equation
    const back = (await convertDocx((await convertMdToDocx('p\n\n\n{--' + D + 'x' + D + '--}<!-- c -->\n\nq\n')).docx)).markdown;
    expect(back).toBe('p\n\n{--' + D + '\nx\n' + D + '--}\n\n<!-- c -->\n\nq\n');
    for (const md of ['p\n\n\n{--' + D + 'x' + D + '--}<!-- c -->\n\n\nq\n', 'p\n\n\na{++\n\n++}<!-- c -->\n\n\nq\n']) {
      expect([md, parsedSpacing(md)]).toEqual([md, []]);
    }
  });

  test('is the same with other text in the blocks preprocessing rewrites, with each of them a line, with other line ends, and with more blank lines around a comment split from its block', async () => {
    await fc.assert(fc.asyncProperty(documentArb, async document => {
      const written = markdownOf(document, 'written');
      const spacing = await commentSpacing((await convertMdToDocx(written)).docx);
      // With the Markdown, for a failure's report
      for (const as of ['x', 'line'] as const) {
        const other = markdownOf(document, as);
        expect([written, other, await commentSpacing((await convertMdToDocx(other)).docx)]).toEqual([written, other, spacing]);
      }
      const other = written.replace(/\n/g, document.lineEnd);
      expect([written, other, parsedSpacing(other)]).toEqual([written, other, parsedSpacing(written)]);
      const crlf = written.replace(/\n/g, '\r\n');
      expect([written, crlf, await commentSpacing((await convertMdToDocx(crlf)).docx)]).toEqual([written, crlf, spacing]);
      // A comment split from its block has none of its own blank lines,
      // nor does a quote take any of them
      const spaced = markdownOf(document, 'spaced');
      if (spaced !== written) {
        const quotes = await commentSpacing((await convertMdToDocx(written)).docx, true);
        expect([written, spaced, await commentSpacing((await convertMdToDocx(spaced)).docx, true)]).toEqual([written, spaced, quotes]);
      }
    }), { numRuns: 100 });
  }, 60000);
});
