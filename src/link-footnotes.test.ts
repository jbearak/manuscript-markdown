// src/link-footnotes.test.ts — a note reference in a link's text keeps the
// link: export reads [a[^1] b](u) as a link, as Pandoc does, and writes the
// reference inside its w:hyperlink, and import writes the hyperlink back as
// one link around it. And a note reference after a ! that a ( follows,
// in a link or not, stays a note: import escapes the !, which would make
// ![^1](x) an image.

import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

async function exportBody(md: string): Promise<{ docx: Uint8Array; body: string }> {
  const { docx } = await convertMdToDocx(md);
  const document = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  return { docx, body: document.slice(document.indexOf('<w:body>')) };
}

async function roundTrip(md: string): Promise<string> {
  return (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
}

describe('a note reference in a link', () => {
  it.each([
    ['a footnote', '', 'w:footnoteReference'],
    ['an endnote', '---\nnotes: endnotes\n---\n\n', 'w:endnoteReference'],
  ])('exports %s inside the link\'s one hyperlink', async (_, frontmatter, tag) => {
    const { body } = await exportBody(frontmatter + 'A [B[^1] C](https://example.com) D\n\n[^1]: Note.\n');
    expect(body.match(/<w:hyperlink /g)).toHaveLength(1);
    const link = body.slice(body.indexOf('<w:hyperlink '), body.indexOf('</w:hyperlink>'));
    expect(link).toContain('<' + tag + ' w:id="1"/>');
    expect(link).toContain('>B</w:t>');
    expect(link).toContain('> C</w:t>');
    expect(body).not.toContain('[B');
  });

  const note = '\n\n[^1]: Note.\n';
  it.each([
    ['in the middle', 'A [B[^1] C](https://example.com) D' + note],
    ['at the start', 'A [[^1] C](https://example.com) D' + note],
    ['at the end', 'A [B [^1]](https://example.com) D' + note],
    ['alone', 'A [[^1]](https://example.com) D' + note],
    ['in an endnote document', '---\nnotes: endnotes\n---\n\nA [B[^1] C](https://example.com) D' + note],
    ['with a named label', 'A [B[^a-note] C](https://example.com) D\n\n[^a-note]: Note.\n'],
    ['with a named label, at the start', 'A [[^a-note] C](https://example.com) D\n\n[^a-note]: Note.\n'],
    ['with a named label, after a picture', 'A [![x](https://example.com/x.png)[^a-note]](https://example.com) D\n\n[^a-note]: Note.\n'],
    ['with a named label, in a comment\'s range', 'A {==[[^a-note] C](https://example.com)==}{>>c<<} D\n\n[^a-note]: Note.\n'],
    ['with a named label, after a picture in a comment\'s range',
      'A {==[![x](https://example.com/x.png)[^a-note]](https://example.com)==}{>>c<<} D\n\n[^a-note]: Note.\n'],
    ['with a named label, after a picture in overlapping comments\' ranges',
      'X {#1}A {#2}[![x](https://example.com/x.png)[^a-note]](https://example.com){/1} D{/2} E\n{#1>>c<<}\n{#2>>d<<}\n\n[^a-note]: Note.\n'],
    ['with a named label, after text in overlapping comments\' ranges',
      'X {#1}A {#2}[B[^a-note] C](https://example.com){/1} D{/2} E\n{#1>>c<<}\n{#2>>d<<}\n\n[^a-note]: Note.\n'],
    ['with a named label, in overlapping comments\' ranges',
      'X {#1}A {#2}[[^a-note] C](https://example.com){/1} D{/2} E\n{#1>>c<<}\n{#2>>d<<}\n\n[^a-note]: Note.\n'],
    ['with a named label, in a substitution', 'A {~~[[^a-note] C](https://example.com)~>x~~} D\n\n[^a-note]: Note.\n'],
    ['a second time, as a cross-reference', 'A[^1] and [B[^1] C](https://example.com) D' + note],
    ['in a link to the same place as the next', 'A [B[^1]](https://example.com)[C](https://example.com) D' + note],
    ['after the link to the same place before', 'A [B](https://example.com)[[^1] C](https://example.com) D' + note],
    ['after a !', 'A\\![[^1] C](https://example.com) D' + note],
    ['after a !, on the old side of a substitution', 'A {~~Wow\\![[^1]](https://example.com)~>x~~} D' + note],
    ['after a !, in a comment\'s range', 'A {==Wow\\![[^1] C](https://example.com)==}{>>c<<} D' + note],
    ['after a !, in overlapping comments\' ranges',
      'X {#1}A {#2}Wow\\![[^1] C](https://example.com){/1} D{/2} E\n{#1>>c<<}\n{#2>>d<<}' + note],
    ['highlighted', 'A [B ==[^1]==](https://example.com) D' + note],
    ['highlighted in a color', 'A [B ==[^1]=={red}](https://example.com) D' + note],
    ['in a comment\'s range', 'A {==[[^1] C](https://example.com)==}{>>c<<} D' + note],
    ['in overlapping comments\' ranges', 'X {#1}A {#2}[[^1] C](https://example.com){/1} D{/2} E\n{#1>>c<<}\n{#2>>d<<}' + note],
    ['in an insertion', 'A {++[B[^1] C](https://example.com)++} D' + note],
    ['in a deletion', 'A {--[B[^1] C](https://example.com)--} D' + note],
    ['in a substitution', 'A {~~[[^1] C](https://example.com)~>x~~} D' + note],
    ['inserted in the link', 'A [B{++[^1]++} C](https://example.com) D' + note],
    ['in a heading', '# A [B[^1] C](https://example.com)' + note],
    ['in a list item', '- A [B[^1] C](https://example.com) D' + note],
    ['in a table\'s cell', '| h |\n| --- |\n| [B[^1] C](https://example.com) |' + note],
    ['before text in parentheses', 'A [B[^1](extra) C](https://example.com) D' + note],
    ['after a $ that its link\'s URL closes', 'A \\$[[^1]](https://example.com/$) B' + note],
    ['alone, on the old side of a substitution', 'A {~~[[^1]](https://example.com)~>x~~} D' + note],
    ['alone and highlighted, on the old side of a substitution', 'A {~~[==[^1]==](https://example.com)~>x~~} D' + note],
    ['deleted at the start, where an insertion follows', 'A [{--[^1]--}{++x++} C](https://example.com) D' + note],
    ['deleted at the start, where an insertion follows, in overlapping comments\' ranges',
      'X {#1}A {#2}[{--[^1]--}{++x++} C](https://example.com){/1} D{/2} E\n{#1>>c<<}\n{#2>>d<<}' + note],
    ['in a note, to another', 'A[^1]\n\n[^1]: See [x[^2] y](https://example.com).\n\n[^2]: Other.\n'],
    ['in a note, as a cross-reference', 'A[^1] B[^2]\n\n[^1]: See [x[^2] y](https://example.com).\n\n[^2]: Other.\n'],
  ])('keeps the link around one %s', async (_, md) => {
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(await roundTrip(once)).toBe(once);
  });

  it.each([
    ['a reference link', 'A [B[^1] C][r] D\n\n[r]: https://example.com' + note, 'A [B[^1] C](https://example.com) D' + note],
    // The highlight is Word's on each run, the reference's too
    ['a highlight around the link', 'A ==[B[^1] C](https://example.com)== D' + note,
      'A [==B=={yellow}==[^1]=={yellow}== C==](https://example.com) D' + note],
    ['a highlight around a link that starts with it', 'A ==[[^1] C](https://example.com)== D' + note,
      'A [==[^1]=={yellow}== C==](https://example.com) D' + note],
  ])('keeps the link in %s', async (_, md, back) => {
    const once = await roundTrip(md);
    expect(once).toBe(back);
    expect(await roundTrip(once)).toBe(once);
  });
});

describe('a note reference after a !', () => {
  const note = '\n\n[^1]: Note.\n';
  it.each([
    ['before a (', 'A Wow\\![^1](extra) D' + note],
    ['before a (, in a link', 'A [Wow\\![^1](extra)](https://example.com) D' + note],
    ['before a (, in a link in an insertion', 'A {++[Wow\\![^1](extra)](https://example.com)++} D' + note],
    ['before a (, in a highlight', 'A ==Wow\\![^1](extra)== D' + note],
    ['before a (, in a comment\'s range', 'A {==Wow\\![^1](extra)==}{>>c<<} D' + note],
    ['before a (, in overlapping comments\' ranges', 'X {#1}A {#2}Wow\\![^1](extra){/1} D{/2} E\n{#1>>c<<}\n{#2>>d<<}' + note],
    ['before a (, on the old side of a substitution', 'A {~~Wow\\![^1](extra)~>x~~} D' + note],
    ['before a (, after a backslash of Word\'s', 'A Wow\\\\\\![^1](extra) D' + note],
    // An image only before a (, so the ! stays as it is before anything else
    ['before anything else', 'A Wow![^1] D' + note],
    ['before another note', 'A Wow![^1][^2](x) D' + note + '\n[^2]: Other.\n'],
    ['before anything else, in a link', 'A [Wow![^1] C](https://example.com) D' + note],
    ['before a link whose text starts with a (', 'A Wow![^1][(x)](https://example.com) D' + note],
  ])('keeps its note %s', async (_, md) => {
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(await roundTrip(once)).toBe(once);
  });
});
