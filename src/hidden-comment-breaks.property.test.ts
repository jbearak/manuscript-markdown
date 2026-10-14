// Plain paragraphs of shown text, line breaks and hidden comment runs, in
// any order: where import writes comments after a line break in HTML blocks
// of their own (see breakBeforeComment in converter.ts), Word shows and
// hides what it did through DOCX → Markdown → DOCX, and the Markdown comes
// back the same from its own DOCX. Elsewhere import writes what main does.

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

/** A run Word shows, a line break, a hidden run of comments, which Word
 *  may have split into runs side by side at `cuts`, or an equation, whose
 *  characters `text` are, each in a run of its own, as export writes them */
type Part = { kind: 'shown' | 'break' | 'hidden' | 'math'; text: string; cuts?: number[] };
const shown = (text: string): Part => ({ kind: 'shown', text });
const hidden = (text: string, cuts?: number[]): Part => ({ kind: 'hidden', text, cuts });
const lineBreakPart: Part = { kind: 'break', text: '' };
const math = (text: string): Part => ({ kind: 'math', text });

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shownRun = (text: string) => '<w:r><w:t xml:space="preserve">' + escape(text) + '</w:t></w:r>';
/** A hidden run as export writes a comment's, with its line ends as Word's
 *  line breaks, but for the rest of one Word split, which has no zero-width
 *  space */
const hiddenRun = (text: string, first = true) => '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">' + (first ? '​' : '')
  + escape(text).replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">') + '</w:t></w:r>';
const lineBreak = '<w:r><w:br/></w:r>';
/** A hidden part's text as the runs Word split it into */
function fragments(part: Part): string[] {
  const cuts = [...new Set(part.cuts ?? [])].filter(cut => cut > 0 && cut < part.text.length).sort((a, b) => a - b);
  return [...cuts, part.text.length].map((cut, k) => part.text.slice(k === 0 ? 0 : cuts[k - 1], cut));
}
const mathRuns = (text: string) => '<m:oMath>' + [...text].map(c => '<m:r><m:t>' + escape(c) + '</m:t></m:r>').join('') + '</m:oMath>';
const runsOf = (parts: Part[]) => parts.map(part => part.kind === 'shown' ? shownRun(part.text) : part.kind === 'math' ? mathRuns(part.text)
  : part.kind === 'break' ? lineBreak : fragments(part).map((text, k) => hiddenRun(text, k === 0)).join('')).join('');

/** A document from `md`, with a paragraph of `XX`, with the runs of `parts`
 *  in that paragraph's place */
async function withParts(md: string, parts: Part[]): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
  const xml = await zip.file('word/document.xml')!.async('string');
  const edited = xml.replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>XX<\/w:t><\/w:r>/s, () => runsOf(parts));
  if (edited === xml) throw new Error('No XX in ' + md);
  zip.file('word/document.xml', edited);
  return zip.generateAsync({ type: 'uint8array' });
}

const hiddenRPr = /<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<w:vanish\/>/;
const bodyOf = async (docx: Uint8Array) => {
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  return xml.slice(xml.indexOf('<w:body>'), xml.lastIndexOf('<w:sectPr'));
};

/** What Word shows of a document: each paragraph's style and indent, and
 *  the text, tabs and line breaks of its runs that aren't hidden, with a
 *  paragraph whose mark is hidden, which Word joins to the next, as part
 *  of the next. With the spaces and tabs of its text, but for those next
 *  to a hidden run, which a hidden run's whitespace may show as where it
 *  keeps words apart, and with all else, as a \ that a line break left as
 *  text */
async function whatWordShows(docx: Uint8Array): Promise<string> {
  let out = '';
  let joined = '';
  for (const [paragraph] of (await bodyOf(docx)).matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraph)?.[0] ?? '';
    let text = '';
    for (const [run] of paragraph.matchAll(/<w:r[ >][\s\S]*?<\/w:r>|<m:r>[\s\S]*?<\/m:r>/g)) {
      // Where a hidden run is, as \u0001
      if (hiddenRPr.test(run)) { text += '\u0001'; continue; }
      for (const [token, t] of run.matchAll(/<[wm]:t[^>]*>([^<]*)<\/[wm]:t>|<w:br\/>|<w:tab\/>/g)) text += t ?? (token === '<w:br/>' ? '⏎' : '\t');
    }
    if (hiddenRPr.test(pPr)) { joined += text; continue; }
    const style = /<w:pStyle w:val="([^"]*)"/.exec(pPr)?.[1] ?? '';
    out += '[' + style + (pPr.includes('w:firstLine=') ? ' indent' : '') + ']' + joined + text + '¶';
    joined = '';
  }
  return (out + joined).replace(/[ \t]*\u0001[ \t]*/g, '');
}

/** The text Word hides, with its line breaks as line ends, without the
 *  zero-width spaces export starts each run with, and without spaces and
 *  tabs, as the indent import gives a line of a comment that would start
 *  a block, or the line ends outside the comments, which Word hides around
 *  them, but with those in each comment */
async function whatWordHides(docx: Uint8Array): Promise<string> {
  let out = '';
  for (const [run] of (await bodyOf(docx)).matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)) {
    if (hiddenRPr.test(run)) for (const [, t] of run.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br\/>/g)) out += t ?? '\n';
  }
  return out.replace(/[ \t​]/g, '').replace(/\n+(?=&lt;!--)|(?<=--&gt;)\n+/g, '');
}

/** Text Word shows, with what may start a block, or end a comment */
const shownText = fc.constantFrom('A', 'B E', '# A', '- A', '> A', '1. A', '*', '```', '<div>', ' ', '\t', 'A ', ' A', 'E --> F', '-->');
/** Comments, most with a blank line, which no paragraph holds, or a line
 *  that would start a block, or empty, or one that ends in --->, which
 *  inline Markdown reads on to the next --> */
const comment = fc.constantFrom('<!-- c -->', '<!-- c\n\nd -->', '<!-- c\n\nd -->', '<!-- c\n# d\n\ne -->', '<!-- c\nd -->', '<!-- c\n# d -->',
  '<!-- c\n- d -->', '<!-- c\n```\nd -->', '<!-- c\n    d -->', '<!-->', '<!--->', '<!-- m --->', '<!-- indent -->', '<!-- landscape -->');
/** The whitespace around a hidden run's comments: spaces and tabs, and,
 *  at the paragraph's end, line ends, which are Word's line breaks in the
 *  hidden run, which elsewhere go as main writes them (see
 *  hidden-comment-line-ends.property.test.ts) */
const gap = fc.constantFrom('', '', ' ', '\t', '    ');
const endGap = fc.constantFrom('', '', ' ', '\t', '    ', '\n');
const hiddenText = fc.tuple(gap, fc.array(fc.tuple(comment, gap), { minLength: 1, maxLength: 3 }))
  .map(([lead, rest]) => lead + rest.map(([c, after]) => c + after).join(''));
/** Where Word may split a hidden run: anywhere after its first <!--, but
 *  not in a <!--, where import loses the comment after another */
function cutPoints(text: string): number[] {
  const inOpening = new Set<number>();
  for (const found of text.matchAll(/<!--/g)) for (let k = 1; k < 4; k++) inOpening.add(found.index + k);
  const points: number[] = [];
  for (let k = text.indexOf('<!--') + 4; k < text.length; k++) if (!inOpening.has(k)) points.push(k);
  return points;
}
const hiddenPart = fc.tuple(hiddenText, fc.array(fc.nat(1000), { maxLength: 2 }))
  .map(([text, cuts]) => hidden(text, cuts.map(n => cutPoints(text)[n % Math.max(1, cutPoints(text).length)] ?? 0)));
const part: fc.Arbitrary<Part[]> = fc.oneof(
  { weight: 2, arbitrary: shownText.map(text => [shown(text)]) },
  { weight: 3, arbitrary: fc.constant([lineBreakPart]) },
  { weight: 3, arbitrary: hiddenPart.map(p => [p]) },
  // Spaces or tabs Word shows between hidden runs
  { weight: 1, arbitrary: fc.tuple(hiddenPart, fc.constantFrom(' ', '\t', '    '), hiddenPart).map(([a, space, b]) => [a, shown(space), b]) },
  // An equation, as one with a -->, which a comment that reads on may end at
  { weight: 1, arbitrary: fc.constantFrom('V-->W', 'V').map(text => [shown(' '), math(text), shown(' ')]) },
  // Many line breaks in a row
  { weight: 1, arbitrary: fc.integer({ min: 2, max: 200 }).map(n => Array.from({ length: n }, () => lineBreakPart)) },
);

/** A line break, then hidden runs, most often of a comment with a blank
 *  line in it, and spaces or tabs Word shows, as at a paragraph's end */
const tail = fc.array(fc.oneof({ weight: 3, arbitrary: fc.tuple(endGap, fc.constantFrom('<!-- c\n\nd -->', '<!-- c\n# d\n\ne -->'), endGap)
  .map(([a, c, b]) => hidden(a + c + b)) }, { weight: 2, arbitrary: hiddenPart }, { weight: 1, arbitrary: fc.constantFrom(' ', '\t').map(shown) }),
{ minLength: 1, maxLength: 3 }).map(ps => [lineBreakPart, ...ps]);

/** A plain paragraph that starts with text Word shows, as one that starts
 *  with a comment starts an HTML block, alone or before another, which
 *  most often ends in a line break and hidden runs */
const paragraph = fc.tuple(fc.constantFrom('XX', 'XX\n\nnext', 'before\n\nXX'), fc.array(part, { maxLength: 5 }), fc.option(tail, { freq: 3 }))
  .map(([md, groups, end]): [string, Part[]] => [md, [shown('Source'), ...groups.flat(), ...end ?? []]]);

describe('hidden comment runs after a line break at a plain paragraph\'s end', () => {
  test('keep what Word shows and hides, and their Markdown, through a round trip, where they go in blocks of their own', async () => {
    let blocks = 0;
    await fc.assert(fc.asyncProperty(paragraph, fc.boolean(), async ([md, parts], alwaysUseCommentIds) => {
      const docx = await withParts(md, parts);
      const markdown = (await convertDocx(docx, undefined, { alwaysUseCommentIds })).markdown;
      if (!markdown.includes('<br>\n\n<!--')) return;
      blocks++;
      const again = (await convertMdToDocx(markdown)).docx;
      expect(await whatWordShows(again)).toBe(await whatWordShows(docx));
      expect(await whatWordHides(again)).toBe(await whatWordHides(docx));
      expect((await convertDocx(again, undefined, { alwaysUseCommentIds })).markdown).toBe(markdown);
    }), { numRuns: 300, seed: 326 });
    // The forms were taken, not only main's
    expect(blocks).toBeGreaterThan(10);
  }, { timeout: 120000 });
});
