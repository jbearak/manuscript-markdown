import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';

// An equation in a Word paragraph of a code style, which a fence can't hold
// as an equation, goes in the code as its LaTeX between dollar signs (see
// codeMathAsText in converter.ts). Each case exports Markdown with the
// equation in a paragraph of its own, moves it into the code, and imports.

const DOC = 'word/document.xml';
const DOLLARS = '$' + '$';

/** The Markdown import gives `md` exported, with what the paragraph of its
 *  first equation, `tag` (m:oMath or m:oMathPara), holds, its comment's
 *  markers too, taken out of it, which is dropped, and put into the code run
 *  holding `line`, between `before` and `after`, which it's replaced by */
async function importMoved(md: string, tag: string, line: string, before: string, after = line.slice(before.length)): Promise<string> {
  return (await importMovedWarning(md, tag, line, before, after)).markdown;
}

/** As importMoved, with import's warnings */
async function importMovedWarning(md: string, tag: string, line: string, before: string, after: string): Promise<{ markdown: string; warnings: string[] }> {
  const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
  let xml = await zip.file(DOC)!.async('string');
  const math = xml.match(new RegExp('<' + tag + '[ >]'))![0];
  // The paragraph that holds the equation
  const at = xml.indexOf(math);
  const start = Math.max(xml.lastIndexOf('<w:p>', at), xml.lastIndexOf('<w:p ', at));
  const end = xml.indexOf('</w:p>', at) + '</w:p>'.length;
  const para = xml.slice(start, end);
  const content = para.replace(/^<w:p\b[^>]*>(?:<w:pPr>.*?<\/w:pPr>)?/, '').slice(0, -'</w:p>'.length);
  xml = xml.slice(0, start) + xml.slice(end);
  const escaped = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const runs = [...xml.matchAll(/<w:r>(<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/g)]
    .filter(m => m[2] === escaped(line));
  expect(runs).toHaveLength(1);
  const [run, rPr = ''] = runs[0];
  const piece = (t: string) => t ? '<w:r>' + rPr + '<w:t xml:space="preserve">' + escaped(t) + '</w:t></w:r>' : '';
  xml = xml.replace(run, piece(before) + content + piece(after));
  zip.file(DOC, xml);
  return convertDocx(await zip.generateAsync({ type: 'uint8array' }));
}

/** The Markdown after another round trip of `md` */
async function again(md: string): Promise<string> {
  return (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
}

const CODE = '```r\nx <- 1\ny <- 2\n```';

describe('an equation in a code block', () => {
  for (const [name, before, expected] of [
    ['at the end of a line', 'x <- 1', 'x <- 1$x^2$'],
    ['in the middle of a line', 'x <- ', 'x <- $x^2$1'],
    ['at the start of a line', '', '$x^2$x <- 1'],
  ] as const) {
    test('is its LaTeX in the code, ' + name, async () => {
      const out = await importMoved('$x^2$\n\n' + CODE + '\n\nAfter.\n', 'm:oMath', 'x <- 1', before);
      expect(out).toBe('```r\n' + expected + '\ny <- 2\n```\n\nAfter.\n');
      expect(await again(out)).toBe(out);
    });
  }

  test('with a warning, as export writes it back as code text', async () => {
    const { warnings } = await importMovedWarning('$x^2$\n\n' + CODE + '\n', 'm:oMath', 'x <- 1', 'x <- 1', '');
    expect(warnings).toEqual(['Wrote 1 equation in code as its LaTeX, as a code block can\'t hold an equation; it is now code text.']);
  });

  test('alone on a line', async () => {
    const out = await importMoved('$x^2$\n\n```r\nx <- 1\nLINE\ny <- 2\n```\n\nAfter.\n', 'm:oMath', 'LINE', '', '');
    expect(out).toBe(CODE.replace('1\n', '1\n$x^2$\n') + '\n\nAfter.\n');
    expect(await again(out)).toBe(out);
  });

  test('of more than one line, each a line of the code', async () => {
    // A LaTeX comment, which export keeps in the equation, ends a line, with
    // a \\ before its end, which a line break of Word's reads as in text
    const md = DOLLARS + '\nx % note \\\\\ny\n' + DOLLARS + '\n\n' + CODE + '\n\nAfter.\n';
    const out = await importMoved(md, 'm:oMathPara', 'x <- 1', 'x <- 1');
    expect(out).toBe('```r\nx <- 1' + DOLLARS + 'x % note \\\\\ny' + DOLLARS + '\ny <- 2\n```\n\nAfter.\n');
    expect(await again(out)).toBe(out);
  });

  test('as a display equation, between double dollar signs', async () => {
    const md = DOLLARS + '\nx^2\n' + DOLLARS + '\n\n' + CODE + '\n\nAfter.\n';
    const out = await importMoved(md, 'm:oMathPara', 'y <- 2', '');
    expect(out).toBe('```r\nx <- 1\n' + DOLLARS + 'x^2' + DOLLARS + 'y <- 2\n```\n\nAfter.\n');
    expect(await again(out)).toBe(out);
  });

  test('with a comment on it, which goes after the block', async () => {
    const out = await importMoved('{==$x^2$==}{>>note<<}\n\n' + CODE + '\n\nAfter.\n', 'm:oMath', 'x <- 1', 'x <- 1');
    expect(out).toStartWith('```r\nx <- 1$x^2$\ny <- 2\n```\n\n');
    expect(out).toContain('{>>note<<}');
    expect(await again(out)).toBe(out);
  });
});
