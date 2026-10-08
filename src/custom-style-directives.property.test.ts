import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';

// An indent directive goes to the paragraph after it that Word shows, past
// comments, a style block's fences, which are comments till
// applyCustomStyleSentinels reads them, and a block on one line of comments
// alone, but not past one with text, which is the paragraph (see parseMd
// and showsInWord in md-to-docx.ts). Import writes the directive before the
// paragraph, inside a block it opens. This exports documents of paragraphs,
// some in blocks on one line, blocks on one line of comments alone,
// directives, comments and fences, open or close, with a blank line between
// each or none, and checks that Word gives each paragraph the indent of
// the directive before it. It imports the document, and exports what it
// wrote again, and checks that Word gets the same paragraphs, in the same
// styles, with the same first-line indents, and that import writes the same
// Markdown again.

type Block =
  | { kind: 'para' }
  | { kind: 'inline'; style: 'box' | 'note'; comments: boolean }
  | { kind: 'directive'; value: 'indent' | 'no-indent' }
  | { kind: 'comment' }
  | { kind: 'open'; style: 'box' | 'note' }
  | { kind: 'close' };

/** Frontmatter with two styles, and with `double`, double spacing, which
 *  indents each paragraph, so a `no-indent` directive shows */
const frontmatter = (double: boolean) => '---\n' + (double ? 'line-spacing: double\n' : '') + 'styles:\n  box:\n    font-style: italic\n  note:\n    font-style: bold\n---\n\n';

const styleArb = fc.constantFrom<'box' | 'note'>('box', 'note');
const blockArb: fc.Arbitrary<Block> = fc.oneof(
  fc.constant({ kind: 'para' as const }),
  fc.record({ kind: fc.constant('inline' as const), style: styleArb, comments: fc.boolean() }),
  fc.record({ kind: fc.constant('directive' as const), value: fc.constantFrom<'indent' | 'no-indent'>('indent', 'no-indent') }),
  fc.constant({ kind: 'comment' as const }),
  fc.record({ kind: fc.constant('open' as const), style: styleArb }),
  fc.constant({ kind: 'close' as const }),
);
/** Up to eight blocks, each with a blank line before it or none, and
 *  whether the document is double spaced */
const documentArb = fc.record({
  blocks: fc.array(fc.record({ block: blockArb, blank: fc.boolean() }), { minLength: 1, maxLength: 8 }),
  double: fc.boolean(),
});

/** The Markdown of `blocks`, with each paragraph's text unique, and
 *  whether Word should indent the first line of each paragraph it shows:
 *  where the directive closest before it, past comments, fences and blocks
 *  on one line of comments alone, which Word shows nothing of, is
 *  `indent`, or with none, where the document is `double` spaced. A
 *  paragraph after another with no blank line between would be its next
 *  line, so one goes there */
function markdownOf({ blocks, double }: { blocks: { block: Block; blank: boolean }[]; double: boolean }): { md: string; indents: Array<[string, boolean]> } {
  let n = 0;
  let md = '';
  let directive: 'indent' | 'no-indent' | undefined;
  const indents: Array<[string, boolean]> = [];
  const shown = (text: string) => {
    indents.push([text, directive === 'indent' || double && directive !== 'no-indent']);
    directive = undefined;
    return text;
  };
  blocks.forEach(({ block, blank }, k) => {
    let line: string;
    switch (block.kind) {
      case 'para': line = shown('p' + n++); break;
      case 'inline': line = '<!-- style: ' + block.style + ' -->' + (block.comments ? '<!-- c' + n++ + ' -->' : shown('p' + n++)) + '<!-- /style -->'; break;
      case 'directive': line = '<!-- ' + block.value + ' -->'; directive = block.value; break;
      case 'comment': line = '<!-- c' + n++ + ' -->'; break;
      case 'open': line = '<!-- style: ' + block.style + ' -->'; break;
      default: line = '<!-- /style -->';
    }
    if (k > 0) md += blank || block.kind === 'para' && blocks[k - 1].block.kind === 'para' ? '\n\n' : '\n';
    md += line;
  });
  return { md: frontmatter(double) + md + '\n', indents };
}

/** Each paragraph with text Word shows in the document of `docx`: its
 *  style, first-line indent and text. Not a paragraph of hidden text, as a
 *  comment alone in one is */
async function paragraphsOf(docx: Uint8Array): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  return [...xml.matchAll(/<w:p\b[^>]*>((?:(?!<\/w:p>).)*)<\/w:p>/gs)].map(([, p]) => {
    const pPr = /<w:pPr>((?:(?!<\/w:pPr>).)*)<\/w:pPr>/s.exec(p)?.[1] ?? '';
    const text = [...p.matchAll(/<w:r\b(?:(?!<\/w:r>).)*<\/w:r>/gs)].filter(([run]) => !run.includes('<w:vanish/>'))
      .flatMap(([run]) => [...run.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1])).join('');
    return [/<w:pStyle w:val="([^"]*)"/.exec(pPr)?.[1] ?? '', /<w:ind w:firstLine="(\d+)"/.exec(pPr)?.[1] ?? '', text].join('|');
  }).filter(p => !p.endsWith('|'));
}

describe('Indent directives beside style blocks', () => {
  test('give the paragraph after them its indent, keep paragraphs\' styles and indents in Word over a round trip, and come back the same', async () => {
    await fc.assert(fc.asyncProperty(documentArb, async document => {
      const { md, indents } = markdownOf(document);
      const first = await convertMdToDocx(md);
      // Each paragraph with the indent of the directive before it
      const paragraphs = await paragraphsOf(first.docx);
      expect([md, indents.map(([text]) => [text, paragraphs.find(p => p.endsWith('|' + text))?.split('|')[1] === '720'])]).toEqual([md, indents]);
      const back = (await convertDocx(first.docx)).markdown;
      const second = await convertMdToDocx(back);
      // With the Markdown, for a failure's report
      expect([md, back, await paragraphsOf(second.docx)]).toEqual([md, back, paragraphs]);
      expect([md, (await convertDocx(second.docx)).markdown]).toEqual([md, back]);
    }), { numRuns: 100 });
  }, 60000);
});
