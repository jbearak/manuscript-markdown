import { describe, expect, it, test } from 'bun:test';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';
import { pushedMathChanges } from './tracked-math';

const RPR = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';

/** A document from Word with `paragraph`'s XML in place of a paragraph of
 *  an equation alone */
async function wordDocx(paragraph: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync((await convertMdToDocx('A $x$ B.\n')).docx);
  const xml = await zip.file('word/document.xml')!.async('string');
  zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => paragraph));
  return zip.generateAsync({ type: 'uint8array' });
}

const imported = async (paragraph: string) => (await convertDocx(await wordDocx(paragraph))).markdown;

/** Word's run of `text` in its change `change`, as Word saves one */
const wordRun = (change: string, id: number, text: string) =>
  '<m:r><w:' + change + ' w:id="' + id + '" w:author="Lab">' + RPR + '<m:t xml:space="preserve">' + text + '</m:t></w:' + change + '></m:r>';
/** Word's accent over `base`, its mark of `change`, or none */
const wordAccent = (base: string, change?: string) => '<m:acc><m:accPr><m:chr m:val="ˆ"/><m:ctrlPr>'
  + (change ? '<w:' + change + ' w:id="9" w:author="Lab">' + RPR + '</w:' + change + '>' : RPR) + '</m:ctrlPr></m:accPr><m:e>' + base + '</m:e></m:acc>';

describe('pushedMathChanges', () => {
  it('puts a change around an equation with a structure on its runs, and marks the structure', () => {
    const xml = '<w:del w:id="5" w:author="A"><m:oMath><m:r><m:t>y</m:t></m:r><m:acc><m:accPr><m:chr m:val="ˆ"/></m:accPr>'
      + '<m:e><m:r><m:t>π</m:t></m:r></m:e></m:acc><m:r><m:t>z</m:t></m:r></m:oMath></w:del>';
    let id = 10;
    expect(pushedMathChanges(xml, () => id++)).toBe('<m:oMath><w:del w:id="5" w:author="A"><m:r><m:t>y</m:t></m:r></w:del>'
      + '<m:acc><m:accPr><m:chr m:val="ˆ"/><m:ctrlPr><w:del w:id="11" w:author="A">' + RPR + '</w:del></m:ctrlPr></m:accPr>'
      + '<m:e><w:del w:id="10" w:author="A"><m:r><m:t>π</m:t></m:r></w:del></m:e></m:acc>'
      + '<w:del w:id="12" w:author="A"><m:r><m:t>z</m:t></m:r></w:del></m:oMath>');
  });

  it('keeps a structure\'s own control properties in its mark, and its mark where it has one', () => {
    const own = '<w:rPr><w:sz w:val="20"/></w:rPr>';
    const xml = '<w:ins w:id="1" w:author="A"><m:d><m:dPr><m:begChr m:val="["/><m:ctrlPr>' + own + '</m:ctrlPr></m:dPr><m:e>'
      + '<m:f><m:fPr><m:ctrlPr><w:del w:id="2" w:author="B">' + RPR + '</w:del></m:ctrlPr></m:fPr><m:num/><m:den/></m:f></m:e></m:d></w:ins>';
    let id = 10;
    expect(pushedMathChanges(xml, () => id++)).toBe('<m:d><m:dPr><m:begChr m:val="["/><m:ctrlPr><w:ins w:id="10" w:author="A">' + own
      + '</w:ins></m:ctrlPr></m:dPr><m:e><m:f><m:fPr><m:ctrlPr><w:del w:id="2" w:author="B">' + RPR + '</w:del></m:ctrlPr></m:fPr>'
      + '<m:num/><m:den/></m:f></m:e></m:d>');
  });

  it('puts a change around a display paragraph on each of its equations, of runs alone too', () => {
    const xml = '<w:del w:id="5" w:author="A"><m:oMathPara><m:oMath><m:acc><m:accPr/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:acc></m:oMath>'
      + '<m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></m:oMathPara></w:del>';
    let id = 10;
    expect(pushedMathChanges(xml, () => id++)).toBe('<m:oMathPara><m:oMath><m:acc><m:accPr><m:ctrlPr><w:del w:id="10" w:author="A">' + RPR
      + '</w:del></m:ctrlPr></m:accPr><m:e><w:del w:id="5" w:author="A"><m:r><m:t>x</m:t></m:r></w:del></m:e></m:acc></m:oMath>'
      + '<m:oMath><w:del w:id="11" w:author="A"><m:r><m:t>y</m:t></m:r></w:del></m:oMath></m:oMathPara>');
  });

  it('leaves a change of runs alone as it is, in an equation or around one, and text\'s', () => {
    for (const xml of ['<w:del w:id="1"><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:del>',
      '<m:oMath><w:ins w:id="1"><m:r><m:t>x</m:t></m:r></w:ins></m:oMath>', '<w:del w:id="1"><w:r><w:delText>x</w:delText></w:r></w:del>']) {
      expect(pushedMathChanges(xml, () => 0)).toBe(xml);
    }
  });
});

describe('a tracked change to an equation, as Word saves it', () => {
  // Word's own XML, as it saved what export writes (see pushedMathChanges)
  it('reads an equation deleted whole back around the equation', async () => {
    const math = '<m:oMath>' + wordRun('del', 0, 'y = ') + wordAccent(wordRun('del', 2, 'π'), 'del') + wordRun('del', 3, '(x) + z') + '</m:oMath>';
    expect(await imported(math)).toBe('A {--$y = \\hat{\\pi}(x) + z$--} B.\n');
  });

  it('reads a structure inserted whole in an equation back around the structure', async () => {
    const math = '<m:oMath><m:r><m:t xml:space="preserve">a + </m:t></m:r>' + wordAccent(wordRun('ins', 2, 'b'), 'ins')
      + '<m:r><m:t xml:space="preserve"> + c</m:t></m:r></m:oMath>';
    expect(await imported(math)).toBe('A $a + {++\\hat{b}++} + c$ B.\n');
  });

  it('keeps the text of runs whose changes Word saved in them, where a structure has no mark', async () => {
    // As Word saved an equation export wrote before structures had marks,
    // which import wrote as $\hat{}$, without its text
    const math = '<m:oMath>' + wordRun('del', 0, 'y = ') + wordAccent(wordRun('del', 2, 'π')) + wordRun('del', 3, '(x) + z') + '</m:oMath>';
    expect(await imported(math)).toBe('A ${--y = --}\\hat{{--\\pi--}}{--(x) + z--}$ B.\n');
  });

  it('reads a structure marked deleted, with one unmarked in it, as its parts\' changes', async () => {
    // The inner accent isn't in the deletion, so the outer can't hold it
    const math = '<m:oMath>' + wordAccent(wordAccent(wordRun('del', 2, 'x')), 'del') + '</m:oMath>';
    expect(await imported(math)).toBe('A $\\hat{\\hat{{--x--}}}$ B.\n');
  });

  it('keeps each equation of a display equation\'s paragraph where only one is in a change', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('$$\nq\n$$\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/, () => '<m:oMathPara><m:oMath>'
      + wordAccent(wordRun('del', 2, 'x'), 'del') + '</m:oMath><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></m:oMathPara>'));
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe('$$\n{--\\hat{x}--}\n$$\n$$\ny\n$$\n');
  });

  it('reads a display paragraph whose equations are each in its change, one around the equation, as in the change', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('$$\nq\n$$\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/, () => '<m:oMathPara><m:oMath>'
      + wordAccent(wordRun('del', 2, 'x'), 'del') + '</m:oMath><w:del w:id="3" w:author="Lab"><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></w:del></m:oMathPara>'));
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toContain('\\hat{x}');
    expect(markdown).toContain('y');
    expect(markdown.startsWith('{--')).toBe(true);
  });

  it('reads a structure marked deleted, with a run inserted in it, as its parts\' changes', async () => {
    const math = '<m:oMath>' + wordAccent(wordRun('ins', 2, 'b'), 'del') + '</m:oMath>';
    expect(await imported(math)).toBe('A $\\hat{{++b++}}$ B.\n');
  });
});

describe('a tracked change to an equation with structures', () => {
  test.each([
    'A {--$y = \\hat{\\pi}(x) + z$--} B.\n',
    'A {++$\\frac{1}{\\hat{a}} + q$++} B.\n',
    'A $a + {--\\hat{b}--} + {++\\overline{c}++} + d$ B.\n',
    'A {~~$\\hat{x}$~>$\\hat{y}$~~} B.\n',
    'A {--$\\sqrt{\\left(\\frac{a}{b}\\middle|c\\right)}$ and $c$--} B.\n',
    '{--$$\n\\hat{y} = \\sum_ix_i\n$$--}\n\nAfter.\n',
    // Of runs alone, around an equation or in it, as before
    'A {++$x$++} and ${++x++}$ B.\n',
  ])('comes back as written: %s', async (md) => {
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    // No change holds a structure, which Word reads for its runs alone
    expect(xml).not.toMatch(/<w:(?:ins|del) [^>]*>(?:(?!<\/w:(?:ins|del)>).)*<m:(?:acc|f|rad|d|nary|sSub|bar)>/);
    expect((await convertDocx(docx)).markdown).toBe(md);
  });
});
