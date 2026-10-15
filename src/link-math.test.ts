// src/link-math.test.ts — an inline equation in a link's text keeps the
// link: export writes its m:oMath inside the link's w:hyperlink, which
// ECMA-376 lets hold math, and import writes the hyperlink back as one link
// around it. Display math stays out of the hyperlink, as before.

import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
const documentXml = async (docx: Uint8Array) => (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
const exportXml = async (md: string) => documentXml((await convertMdToDocx(md)).docx);
// Never a literal double dollar in this file (see CLAUDE.md)
const fence = '$'.repeat(2);

describe('an inline equation in a link', () => {
  test.each([
    ['at the start of its text', 'See [$x$ link](https://e.org) b.'],
    ['in the middle of its text', 'See [a $x$ b](https://e.org) c.'],
    ['at the end of its text', 'See [link $x$](https://e.org) b.'],
    ['as all its text', 'See [$x$](https://e.org) b.'],
    ['twice', 'See [$x$ and $y^2$](https://e.org) b.'],
    ['in a link to the same place as the next', 'See [$x$](https://e.org)[$y$](https://e.org) b.'],
    ['after a line break', 'See [a\\\n$x$ b](https://e.org) c.'],
    ['between formatted text', 'See [**a** $x$ *b*](https://e.org) c.'],
    ['highlighted', 'See [a ==$x$== b](https://e.org) c.'],
    ['inserted in the link', 'See [a {++$x$++} b](https://e.org) c.'],
    ['deleted in the link', 'See [a {--$x$--} b](https://e.org) c.'],
    ['in an insertion', 'See {++[a $x$ b](https://e.org)++} c.'],
    ['in a deletion', 'See {--[a $x$ b](https://e.org) c--} d.'],
    ['in a comment\'s range', 'See {==[a $x$ b](https://e.org)==}{>>note<<} c.'],
    ['in a heading', '# See [a $x$ b](https://e.org)'],
    ['in a list item', '- See [a $x$ b](https://e.org) c.'],
    ['in a note', 'Text.[^1]\n\n[^1]: See [a $x$ b](https://e.org) c.'],
    ['on the old side of a substitution', 'See {~~[$x$](https://e.org)~>b~~} c.'],
    ['on the new side of a substitution', 'See {~~b~>[$x$](https://e.org)~~} c.'],
    ['after text, on the old side of a substitution', 'See {~~[a $x$](https://e.org)~>b~~} c.'],
    ['before text, on the old side of a substitution', 'See {~~[$x$ b](https://e.org)~>c~~} d.'],
    ['before text, on the new side of a substitution', 'See {~~c~>[$x$ b](https://e.org)~~} d.'],
    ['before text, on a side with text after the link', 'See {~~[$x$ b](https://e.org) c~>d~~} e.'],
  ])('%s stays in the link', async (_name, md) => {
    // The equation ended the link, or was a link's text alone, which lost it
    const once = await roundTrip(md);
    expect(once).toBe(md + '\n');
    expect(await roundTrip(once)).toBe(once);
  });

  test.each([
    // Bold, which no equation shows, goes on the text beside it, as outside
    // a link's
    ['in bold', 'See **a [$x$](https://e.org) b** c.', 'See **a** [$x$](https://e.org) **b** c.'],
    // A substitution of equations in a link is a deletion and an insertion
    // in it, as Word has them
    ['substituted in the link', 'See [{~~$x$~>$y$~~}](https://e.org) b.', 'See [{--$x$--}{++$y$++}](https://e.org) b.'],
  ])('%s stays in the link', async (_name, md, expected) => {
    const once = await roundTrip(md);
    expect(once).toBe(expected + '\n');
    expect(await roundTrip(once)).toBe(once);
  });

  test('exports inside the link\'s one hyperlink', async () => {
    const xml = await exportXml('See [a $x$ b](https://e.org) c.');
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(1);
    expect(xml).toMatch(/<w:hyperlink [^>]*>(?:(?!<\/w:hyperlink>)[\s\S])*<m:oMath>(?:(?!<\/w:hyperlink>)[\s\S])*> b<\/w:t>/);
  });

  test('exports inside a deleted link\'s one hyperlink', async () => {
    const xml = await exportXml('See {--[a $x$ b](https://e.org) c--} d.');
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(1);
    expect(xml).toMatch(/<w:hyperlink [^>]*>(?:(?!<\/w:hyperlink>)[\s\S])*<m:oMath>(?:(?!<\/w:hyperlink>)[\s\S])*> b<\/w:delText>/);
  });
});

describe('escapes next to a linked equation', () => {
  test.each([
    // A ! before it would make the link an image
    ['a ! before a link of an equation', 'Wow\\![$x$](https://e.org) b.'],
    ['a ! before a link that starts with an equation', 'Wow\\![$x$ b](https://e.org) c.'],
    ['a ! before it, in a comment\'s range', '{==Wow\\![$x$](https://e.org)==}{>>n<<} c.'],
    ['a ! before it, in overlapping comments\' ranges', 'X {#1}A {#2}Wow\\![$x$ C](https://e.org){/1} D{/2} E\n{#1>>c<<}\n{#2>>d<<}'],
    ['a ! before it, on the old side of a substitution', 'A {~~Wow\\![$x$](https://e.org)~>x~~} D'],
    ['a ! at the end of another link before it', 'See [a!](https://e.org)[$x$](https://f.org) b.'],
    // After its highlight's closing ==, the next export would read them as
    // the highlight's color or delimiters
    ['a color after its highlight', 'See [==$x$==\\{red} b](https://e.org) c.'],
    ['a color after its highlight in a color', 'See [==$x$=={red}\\{red} b](https://e.org) c.'],
    ['a } after its highlight', 'See [==$x$==\\} b](https://e.org) c.'],
    ['an = after its highlight', 'See [==$x$==\\= b](https://e.org) c.'],
    ['a color after a highlighted note reference', 'See [==[^1]==\\{red} b](https://e.org) c.\n\n[^1]: N.'],
    // A [ before it that a ] in the link's text would close, as a citation
    ['a citation\'s [ before it', 'See \\[@k [$x$](https://e.org) b.'],
    ['a citation\'s [ before a ] in it', 'See \\[@k [$]$](https://e.org) c.'],
    ['brackets in it', 'See [$[0,1]$ b](https://e.org) c.'],
    ['a ] in it', 'See [a $]$](https://e.org) c.'],
    // The link's text is escaped, as a < of a tag it would leave open at
    // its end, but not the LaTeX, which export reads as it is
    ['a < in it, as of a tag', 'See [$x<y z=1$](https://e.org) b.'],
    ['a < in it, after text', 'See [a $x<y z=1$](https://e.org) b.'],
    ['a < in it, in an insertion', 'See {++[$x<y z=1$](https://e.org)++} c.'],
    ['a < in it, inserted in the link', 'See [a {++$x<y z=1$++}](https://e.org) b.'],
    ['_ and * in it', 'See [$a_b * c_d$](https://e.org) b.'],
    ['escaped braces in it', 'See [$\\{x\\}$](https://e.org) b.'],
    ['a backslash command in it', 'See [$a\\backslash b$](https://e.org) c.'],
    ['an @ in it', 'See [$@x$](https://e.org) b.'],
    ['an == in it', 'See [$x == y$](https://e.org) b.'],
    // Emphasis and highlights right next to it
    ['italic text right before it', 'See *a*[$x$](https://e.org) b.'],
    ['bold text right before it', 'See **a**[$x$](https://e.org) b.'],
    ['italic text before it in the link', 'See [*a*$x$](https://e.org) b.'],
    ['italic text after it in the link', 'See [$x$*a*](https://e.org) b.'],
    ['code after it in the link', 'See [$x$`a`](https://e.org) b.'],
    ['highlighted text right before it', 'See ==a==[$x$](https://e.org) b.'],
    ['highlighted text right after it', 'See [$x$](https://e.org)==a== b.'],
  ])('keeps %s', async (_name, md) => {
    const once = await roundTrip(md);
    expect(once).toBe(md + '\n');
    expect(await roundTrip(once)).toBe(once);
  });
});

describe('text next to an equation in a Word link', () => {
  // `md`'s export with the text around its equation in the link, `a ` and
  // ` b`, as `before` and `after`, which no space keeps from it
  const glued = async (md: string, before: string, after: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace('>a </w:t>', '>' + before + '</w:t>').replace('> b</w:t>', '>' + after + '</w:t>');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    return zip.generateAsync({ type: 'uint8array' });
  };

  test.each([
    ['letters', 'See [a $x$ b](https://e.org) c.', 'a', 'b', 'See [&#97;$x$&#98;](https://e.org) c.'],
    ['dollar signs', 'See [a $x$ b](https://e.org) c.', 'a$', '$b', 'See [a\\$' + '$x$\\$b](https://e.org) c.'],
    ['a _ and a digit', 'See [a $x$ b](https://e.org) c.', 'a_', '9', 'See [a&#95;$x$&#57;](https://e.org) c.'],
    ['letters, in an insertion', 'See {++[a $x$ b](https://e.org)++} c.', 'a', 'b', 'See {++[&#97;$x$&#98;](https://e.org)++} c.'],
    // Outside a link, too, an insertion's delimiters keep them apart
    ['letters, by an inserted equation', 'See [a {++$x$++} b](https://e.org) c.', 'a', 'b', 'See [a{++$x$++}b](https://e.org) c.'],
    // Text with dollar signs, whose last letter or digit goes as a
    // reference, after which a $ could close math: they're escaped, as
    // outside a link, or the next export would read $a$ as an equation
    ['dollar signs before a letter', 'See [a $x$ b](https://e.org) c.', '$a$z', ' b', 'See [\\$a$&#122;$x$ b](https://e.org) c.'],
    ['dollar signs before a digit', 'See [a $x$ b](https://e.org) c.', '$a$1', ' b', 'See [\\$a$&#49;$x$ b](https://e.org) c.'],
    ['dollar signs before a letter, in an insertion', 'See {++[a $x$ b](https://e.org)++} c.', '$a$z', ' b', 'See {++[\\$a$&#122;$x$ b](https://e.org)++} c.'],
  ])('keeps %s from it', async (_name, md, before, after, expected) => {
    // The text ran into the equation's $, which export read as text
    const once = (await convertDocx(await glued(md, before, after))).markdown;
    expect(once).toBe(expected + '\n');
    const xml = await exportXml(once);
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(1);
    expect(xml.match(/<m:oMath>/g)).toHaveLength(1);
    expect(xml).toMatch(/<w:hyperlink [^>]*>(?:(?!<\/w:hyperlink>)[\s\S])*<m:oMath>/);
    expect(await roundTrip(once)).toBe(once);
  });
});

describe('math by a link', () => {
  test('keeps a Word link around an equation in a table that comes back as HTML', async () => {
    // A cell's equation is its Markdown there, as text, in the link it's in
    const md = '<table>\n<tr><td rowspan="2">See <a href="https://e.org">X</a> b</td><td>c</td></tr>\n<tr><td>d</td></tr>\n</table>';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<\/w:r>).)*<w:t[^>]*>X<\/w:t><\/w:r>/, '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>');
    expect(edited).toMatch(/<w:hyperlink [^>]*><m:oMath>/);
    zip.file('word/document.xml', edited);
    const once = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(once).toContain('<p>See <a href="https://e.org">$x$</a> b</p>');
    expect(await roundTrip(once)).toBe(once);
  });

  test('display math in a link\'s text stays out of the hyperlink', async () => {
    // As before: a link of the equation alone is dropped, and it comes back
    // on lines of its own
    const md = 'See [' + fence + 'x' + fence + '](https://e.org) b.';
    const xml = await exportXml(md);
    expect(xml).not.toContain('<w:hyperlink');
    expect(xml).toContain('<m:oMathPara>');
    const once = await roundTrip(md);
    expect(once).toBe('See\n' + fence + '\nx\n' + fence + '&#32;b.\n');
    expect(await roundTrip(once)).toBe(once);
  });

  // `outside`: the equation that stays out of the hyperlink
  test.each([
    ['a link without math', 'See [link](https://e.org) b.', ''],
    ['an equation after a link', 'See [link](https://e.org) $x$ b.', 'x'],
    ['an equation right after a link', 'See [a $x$ b](https://e.org)$y$ c.', 'y'],
  ])('%s is unchanged', async (_name, md, outside) => {
    const xml = await exportXml(md);
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(1);
    if (outside) {
      expect(xml).toContain('<m:t>' + outside + '</m:t>');
      expect(xml).not.toMatch(new RegExp('<w:hyperlink [^>]*>(?:(?!</w:hyperlink>)[\\s\\S])*<m:t>' + outside + '</m:t>'));
    }
    const once = await roundTrip(md);
    expect(once).toBe(md + '\n');
    expect(await roundTrip(once)).toBe(once);
  });
});
