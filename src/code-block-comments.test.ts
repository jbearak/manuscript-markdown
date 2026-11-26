import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';

// A Word comment on a code block's text, which a fence can't hold, goes
// after the block on no text (see commentsOnlyInCode in converter.ts). Each
// case exports Markdown with its comments on a paragraph's text, moves their
// markers into the code as a Word user's comment would be, and imports.

const ALICE = '@alice (2024-01-15 14:30) | ';
const BOB = '@bob (2024-01-15 15:00) | ';
const DOC = 'word/document.xml';

/** The comment's range start, end and reference markers of comment `id` */
function markers(xml: string, id: number): { start: string; end: string; ref: string } {
  const start = '<w:commentRangeStart w:id="' + id + '"/>';
  const end = '<w:commentRangeEnd w:id="' + id + '"/>';
  const ref = '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + id + '"/></w:r>';
  for (const marker of [start, end, ref]) expect(xml).toContain(marker);
  return { start, end, ref };
}

/** `xml` with `marker` put before or after `text` in the one run that holds it,
 *  which it splits there */
function putAt(xml: string, text: string, marker: string, after: boolean): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const runs = [...xml.matchAll(/<w:r>(<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/g)]
    .filter(m => m[2].includes(escaped));
  expect(runs).toHaveLength(1);
  const [run, rPr = '', content] = runs[0];
  const at = content.indexOf(escaped) + (after ? escaped.length : 0);
  const piece = (t: string) => t ? '<w:r>' + rPr + '<w:t xml:space="preserve">' + t + '</w:t></w:r>' : '';
  return xml.replace(run, piece(content.slice(0, at)) + marker + piece(content.slice(at)));
}

type Move = { id: number; from?: string; to?: string };

/** The Markdown import gives `md` exported, with each comment's markers
 *  moved: its range from before `from` to after `to`, where given, and its
 *  reference after its range's end */
async function importMoved(md: string, moves: Move[], ids = false): Promise<{ markdown: string; warnings: string[] }> {
  const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
  let xml = await zip.file(DOC)!.async('string');
  for (const { id, from, to } of moves) {
    const { start, end, ref } = markers(xml, id);
    if (from !== undefined) xml = putAt(xml.replace(start, ''), from, start, false);
    if (to !== undefined) xml = putAt(xml.replace(end, '').replace(ref, ''), to, end + ref, true);
  }
  zip.file(DOC, xml);
  const { markdown, warnings } = await convertDocx(await zip.generateAsync({ type: 'uint8array' }), undefined, { alwaysUseCommentIds: ids });
  return { markdown, warnings };
}

/** The Markdown after another round trip of `md` */
async function again(md: string, ids = false): Promise<string> {
  return (await convertDocx((await convertMdToDocx(md)).docx, undefined, { alwaysUseCommentIds: ids })).markdown;
}

const CODE = '```r\nx <- 1\ny <- 2\n```';
const ONE_WARNING = 'Moved 1 comment on code to after its code block, as a code block can\'t hold a comment\'s range; it now marks no text.';

describe('comments on a code block', () => {
  test('one on part of a line goes after the fence', async () => {
    const { markdown, warnings } = await importMoved('Para {==word==}{>>' + ALICE + 'on code<<}.\n\n' + CODE + '\n\nAfter.\n',
      [{ id: 0, from: '<- 1', to: '<- 1' }]);
    expect(markdown).toBe('Para word.\n\n' + CODE + '\n\n{>>' + ALICE + 'on code<<}\n\nAfter.\n');
    expect(warnings).toEqual([ONE_WARNING]);
    expect(await again(markdown)).toBe(markdown);
  });

  test('one over several lines, at the end of the document', async () => {
    const { markdown } = await importMoved('Para {==word==}{>>' + ALICE + 'on code<<}.\n\n' + CODE + '\n',
      [{ id: 0, from: 'x <-', to: '- 2' }]);
    expect(markdown).toBe('Para word.\n\n' + CODE + '\n\n{>>' + ALICE + 'on code<<}\n');
    expect(await again(markdown)).toBe(markdown);
  });

  test('two on one block go after it in their order', async () => {
    const { markdown, warnings } = await importMoved('Para {==a==}{>>' + ALICE + 'one<<} {==b==}{>>' + BOB + 'two<<}.\n\n' + CODE + '\n\nAfter.\n',
      [{ id: 0, from: 'x', to: 'x' }, { id: 1, from: '2', to: '2' }]);
    expect(markdown).toBe('Para a b.\n\n' + CODE + '\n\n{>>' + ALICE + 'one<<} {>>' + BOB + 'two<<}\n\nAfter.\n');
    expect(warnings).toEqual(['Moved 2 comments on code to after their code blocks, as a code block can\'t hold a comment\'s range; they now mark no text.']);
    expect(await again(markdown)).toBe(markdown);
  });

  test('one with a reply written inside it keeps it there', async () => {
    const { markdown } = await importMoved('Para {==word==}{>>' + ALICE + 'on code\n  {>>' + BOB + 'reply<<}\n<<}.\n\n' + CODE + '\n\nAfter.\n',
      [{ id: 0, from: 'x', to: '1' }, { id: 1, from: 'x', to: '1' }]);
    expect(markdown).toBe('Para word.\n\n' + CODE + '\n\n{>>' + ALICE + 'on code\n  {>>' + BOB + 'reply<<}\n<<}\n\nAfter.\n');
    expect(await again(markdown)).toBe(markdown);
  });

  test('one with a reply written after it keeps it after, in ID syntax, as a comment on no text takes', async () => {
    const { markdown } = await importMoved('Para {==word==}{>>' + ALICE + 'on code<<}{>>' + BOB + 'reply<<}.\n\n' + CODE + '\n\nAfter.\n',
      [{ id: 0, from: 'x', to: '1' }, { id: 1, from: 'x', to: '1' }]);
    expect(markdown).toBe('Para word.\n\n' + CODE + '\n\n{#1}{/1}\n{#1>>' + ALICE + 'on code<<}{>>' + BOB + 'reply<<}\n\nAfter.\n');
    expect(await again(markdown)).toBe(markdown);
  });

  test('one in ID syntax, where every comment takes it, stays so', async () => {
    const { markdown } = await importMoved('Para {==word==}{>>' + ALICE + 'on code<<}.\n\n' + CODE + '\n\nAfter.\n',
      [{ id: 0, from: '<- 1', to: '<- 1' }], true);
    expect(markdown).toBe('Para word.\n\n' + CODE + '\n\n{#1}{/1}\n{#1>>' + ALICE + 'on code<<}\n\nAfter.\n');
    expect(await again(markdown, true)).toBe(markdown);
  });

  test('one on the first of two blocks in a row goes between them', async () => {
    const { markdown } = await importMoved('Para {==word==}{>>' + ALICE + 'on code<<}.\n\n' + CODE + '\n\n```\nz\n```\n',
      [{ id: 0, from: 'x', to: 'x' }]);
    expect(markdown).toBe('Para word.\n\n' + CODE + '\n\n{>>' + ALICE + 'on code<<}\n\n```\nz\n```\n');
    expect(await again(markdown)).toBe(markdown);
  });

  test('keeps a paragraph\'s stored indent on its paragraph', async () => {
    const { markdown } = await importMoved('Para {==word==}{>>' + ALICE + 'on code<<}.\n\n' + CODE + '\n\n<!-- no-indent -->\nAfter.\n',
      [{ id: 0, from: 'x', to: 'x' }]);
    expect(markdown).toBe('Para word.\n\n' + CODE + '\n\n{>>' + ALICE + 'on code<<}\n\n<!-- no-indent -->\nAfter.\n');
    expect(await again(markdown)).toBe(markdown);
  });

  test('leaves one on text after a note\'s reference, which ends the fence, where it is', async () => {
    // Not an equation, which the code holds as its LaTeX (see codeMathAsText)
    const zip = await JSZip.loadAsync((await convertMdToDocx('Para {==word==}{>>' + ALICE + 'on code<<}.[^1]\n\n' + CODE + '\n\n[^1]: Note.\n')).docx);
    let xml = await zip.file(DOC)!.async('string');
    const { start, end, ref } = markers(xml, 0);
    const note = xml.match(/<w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:footnoteReference w:id="\d+"\/><\/w:r>/)![0];
    xml = putAt(putAt(xml.replace(start, '').replace(end, '').replace(ref, '').replace(note, ''), 'x <- 1', start, false), 'x <- 1', end + ref, true);
    zip.file(DOC, xml.replace(start, note + start));
    const { markdown, warnings } = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
    expect(markdown).toContain('{==x <- 1==}{>>' + ALICE + 'on code<<}');
    expect(warnings).toEqual([]);
  });

  test('moves one on text after an equation, which the code holds as its LaTeX, as any on code', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('Para {==word==}{>>' + ALICE + 'on code<<}.\n\n' + CODE + '\n')).docx);
    let xml = await zip.file(DOC)!.async('string');
    const { start, end, ref } = markers(xml, 0);
    xml = putAt(putAt(xml.replace(start, '').replace(end, '').replace(ref, ''), 'x <- 1', start, false), 'x <- 1', end + ref, true);
    zip.file(DOC, xml.replace(start, '<m:oMath><m:r><m:t>a</m:t></m:r></m:oMath>' + start));
    const { markdown, warnings } = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
    expect(markdown).toBe('Para word.\n\n```r\n$a$x <- 1\ny <- 2\n```\n\n{>>' + ALICE + 'on code<<}\n');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toStartWith('Wrote 1 equation in code');
    expect(warnings[1]).toStartWith('Moved 1 comment on code');
    expect(await again(markdown)).toBe(markdown);
  });

  test('one from the paragraph before into the block keeps its range on the text', async () => {
    const { markdown, warnings } = await importMoved('Para {==word==}{>>' + ALICE + 'into code<<}.\n\n' + CODE + '\n\nAfter.\n',
      [{ id: 0, to: '<- 1' }]);
    expect(markdown).toBe('Para {==word.==}{>>' + ALICE + 'into code<<}\n\n' + CODE + '\n\nAfter.\n');
    expect(warnings).toEqual([]);
    expect(await again(markdown)).toBe(markdown);
  });

  test('one from the block into the paragraph after keeps its range on the text', async () => {
    const { markdown, warnings } = await importMoved(CODE + '\n\nAfter {==word==}{>>' + ALICE + 'out of code<<}.\n',
      [{ id: 0, from: 'y' }]);
    expect(markdown).toBe(CODE + '\n\n{==After word==}{>>' + ALICE + 'out of code<<}.\n');
    expect(warnings).toEqual([]);
    expect(await again(markdown)).toBe(markdown);
  });

  test('a code block with no comment imports as before, with no warning', async () => {
    const md = 'Para {==word==}{>>' + ALICE + 'on text<<}.\n\n' + CODE + '\n\nAfter.\n';
    const { markdown, warnings } = await importMoved(md, []);
    expect(markdown).toBe(md);
    expect(warnings).toEqual([]);
  });

  test('one from the block into the first cell of a table right after it, with no paragraph between, keeps its range on the cell', async () => {
    // As Word writes them; export puts an empty paragraph between the two
    const zip = await JSZip.loadAsync((await convertMdToDocx('Para {==word==}{>>' + ALICE + 'on code<<}.\n\n' + CODE + '\n\n| cell | b |\n| --- | --- |\n| c | d |\n')).docx);
    let xml = await zip.file(DOC)!.async('string');
    const { start, end, ref } = markers(xml, 0);
    xml = putAt(xml.replace(start, ''), '<- 2', start, false);
    xml = putAt(xml.replace(end, '').replace(ref, ''), 'cell', end + ref, true);
    const between = /<w:p(?: [^>]*)?><w:pPr><w:spacing w:after="0"\/><\/w:pPr><\/w:p>(?=<w:tbl>)/;
    expect(xml).toMatch(between);
    zip.file(DOC, xml.replace(between, ''));
    const { markdown, warnings } = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
    expect(markdown).toBe('Para word.\n\n' + CODE + '\n\n| {==cell==}{>>' + ALICE.replace('|', '\\|') + 'on code<<} | b |\n| --- | --- |\n| c | d |\n');
    expect(warnings).toEqual([]);
    expect(await again(markdown)).toBe(markdown);
  });
});
