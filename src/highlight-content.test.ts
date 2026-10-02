// src/highlight-content.test.ts — a format highlight's content exports as
// Markdown, as the preview renders it: emphasis, code, equations, citations
// and CriticMarkup become Word formatting, fields and revisions rather than
// literal text (highlight-footnotes.test.ts covers note references). Import
// writes highlighted citations, note references and code back in the
// highlight, so they round-trip. A comment nested in a highlight or a
// revision keeps its range.

import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { buildMarkdown, convertDocx, DEFAULT_FORMATTING, type ContentItem } from './converter';
import { orderRPr } from './md-to-docx-citations';

const bibtex = `@article{doe2020, author={Doe, Jane}, title={A study}, journal={J}, year={2020}}`;

async function exportParts(md: string) {
  const { docx, warnings } = await convertMdToDocx(md, { bibtex });
  const zip = await JSZip.loadAsync(docx);
  const document = await zip.file('word/document.xml')!.async('string');
  const notes = await zip.file('word/footnotes.xml')?.async('string') ?? '';
  return { docx, warnings, body: document.slice(document.indexOf('<w:body>')), notes };
}

async function imported(docx: Uint8Array): Promise<string> {
  const result = await convertDocx(docx, 'authorYearTitle', { existingBibtex: bibtex });
  return result.markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

// The run holding `text`, with its properties
const runWith = (body: string, text: string) =>
  body.match(new RegExp('<w:r>(?:(?!</w:r>).)*<w:t[^>]*>' + text + '</w:t></w:r>'))?.[0] ?? '';

describe('Markdown in a format highlight', () => {
  it('exports emphasis and an insertion as Word formatting and a revision', async () => {
    const { body } = await exportParts('Seen ==a *b* {++c++}== on.');
    expect(body).not.toContain('*b*');
    expect(body).not.toContain('{++');
    expect(runWith(body, 'b')).toContain('<w:i/>');
    expect(runWith(body, 'b')).toContain('<w:highlight w:val="yellow"/>');
    expect(body).toMatch(/<w:ins [^>]*><w:r><w:rPr><w:highlight w:val="yellow"\/><\/w:rPr><w:t>c<\/w:t><\/w:r><\/w:ins>/);
  });

  it('exports a citation as a highlighted field', async () => {
    const { body } = await exportParts('Seen ==a [@doe2020]=={red} on.');
    expect(body).toContain('ADDIN ZOTERO_ITEM');
    expect(body).not.toContain('[@doe2020]');
    expect(runWith(body, '\\(Doe, 2020\\)')).toContain('<w:highlight w:val="red"/>');
  });

  it('writes a highlight among other run properties in schema order', async () => {
    // A superscript citation style, underline and a table's own font
    const { body } = await exportParts('---\ncsl: nature\ntable-font-size: 9\n---\n\nSeen ==a [@doe2020]== and <u>==c==</u> on.'
      + '\n\n<!-- table-font: Courier New -->\n\n| A |\n|---|\n| ==b[^1]== |\n| ==[@missing]== |\n\n[^1]: Note.');
    expect(body).toContain('<w:highlight w:val="yellow"/><w:vertAlign w:val="superscript"/>');
    expect(body).toContain('<w:highlight w:val="yellow"/><w:u w:val="single"/>');
    expect(body).toContain('<w:rStyle w:val="FootnoteReference"/><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:highlight w:val="yellow"/>');
    for (const [, properties] of body.matchAll(/<w:rPr>(.*?)<\/w:rPr>/g)) expect(orderRPr(properties)).toBe(properties);
  });

  it('keeps a URL in it as the text of a link around it', async () => {
    const { docx, body } = await exportParts('Seen [==https://inner.example==](https://outer.example) on.');
    const rels = await (await JSZip.loadAsync(docx)).file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).toContain('Target="https://outer.example"');
    expect(rels).not.toContain('inner.example');
    expect(body.match(/<w:hyperlink /g)).toHaveLength(1);
  });

  it('exports code as highlighted code and an equation as an equation', async () => {
    const { body } = await exportParts('Seen ==a `c` $x$== on.');
    expect(runWith(body, 'c')).toContain('<w:rStyle w:val="CodeChar"/><w:highlight w:val="yellow"/>');
    expect(body).toContain('<m:oMath>');
    expect(body).not.toContain('$x$');
  });

  it('reads emphasis and a revision back in highlights of their own', async () => {
    const { docx } = await exportParts('Seen ==a *b* {++c++}== on.');
    expect(await imported(docx)).toBe('Seen ==a== *==b==* {++==c==++} on.');
  });
});

describe('a highlight read back', () => {
  it.each([
    ['a citation', 'Seen ==a [@doe2020]=={red} on.'],
    ['a citation first', 'Seen ==[@doe2020] a== on.'],
    ['a note reference alone', 'Seen ==[^1]== on.'],
    ['code and a note reference', 'Seen ==a `c` b[^1]== on.'],
    ['code alone', 'Seen ==`c`=={red} on.'],
    ['an equation', 'Seen ==a $x$ b== on.'],
    ['a note reference beside another highlight', 'Seen ==a=={red}==[^1]== on.'],
    ['a note reference in a comment', 'Seen {==a ==[^1]==, b==}{>>c<<} on.'],
    ['a citation in a comment', 'Seen {====a [@doe2020]=={red}==}{>>c<<} on.'],
    ['a citation starting a comment', 'Seen {====[@doe2020]====}{>>c<<} on.'],
    ['a citation in an insertion', 'Seen {++==[@doe2020]==++} on.'],
    ['a citation in a deletion', 'Seen {--==a [@doe2020]==--} on.'],
    ['a note reference on the new side of a substitution', 'Seen {~~old~>==a[^1]==~~} on.'],
    ['a citation on the new side of a substitution', 'Seen {~~old~>==[@doe2020]==~~} on.'],
    ['an equation in an insertion', 'Seen {++==a $x$ b==++} on.'],
    ['a note reference in an insertion in a comment', 'Seen {==a {++==[^1]==++}==}{>>c<<} on.'],
  ])('keeps %s in it', async (_, text) => {
    const note = text.includes('[^1]') ? '\n\n[^1]: Note.' : '';
    const { docx } = await exportParts(text + note);
    expect(await imported(docx)).toBe(text + note);
  });

  it('leaves out code with an == in it, which would close it', async () => {
    const { docx } = await exportParts('Seen ==x `a = b` y[^1]== and ==`c = d`== on.\n\n[^1]: Note.');
    // Word can highlight such code, though Markdown can't
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('>a = b<', '>a == b<').replace('>c = d<', '>c == d<'));
    const back = await imported(await zip.generateAsync({ type: 'uint8array' }));
    expect(back).toBe('Seen ==x== `a == b` ==y[^1]== and `c == d` on.\n\n[^1]: Note.');
  });

  it('keeps a citation whose text has an == in it, which Markdown doesn\'t show', async () => {
    const { docx } = await exportParts('Seen ==[@doe2020]== on.');
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('>(Doe, 2020)<');
    zip.file('word/document.xml', xml.replace('>(Doe, 2020)<', '>(Doe == 2020)<'));
    expect(await imported(await zip.generateAsync({ type: 'uint8array' }))).toBe('Seen ==[@doe2020]== on.');
  });

  it('keeps a citation in it in a note', async () => {
    const { docx } = await exportParts('Main[^1].\n\n[^1]: ==see [@doe2020]=={red}');
    expect(await imported(docx)).toEndWith('\n\n[^1]: ==see [@doe2020]=={red}');
  });

  it('keeps note references in it across comments with IDs', async () => {
    const text = 'Seen {#1}==a[^1]== {#2}==b=={/1}==[^2] c=={/2} on.';
    const { docx } = await exportParts(text + '\n{#1>>one<<}\n{#2>>two<<}\n\n[^1]: N1.\n\n[^2]: N2.');
    expect(await imported(docx)).toStartWith(text);
  });

  it.each([
    ['a citation in a list item', '- ==[@doe2020]== a'],
    ['a citation in an insertion', '{++==[@doe2020]==++} a'],
  ])('keeps %s at the start of a block without a space before it', async (_, text) => {
    const { docx } = await exportParts(text);
    expect(await imported(docx)).toBe(text);
  });

  it('reads a long highlight of text alone in linear time', () => {
    const items: ContentItem[] = Array.from({ length: 20000 }, (_, i) => ({
      type: 'text', text: 'w' + (i % 10) + ' ', commentIds: new Set(),
      formatting: { ...DEFAULT_FORMATTING, highlight: true, italic: i % 2 === 1 },
    }));
    const started = performance.now();
    const markdown = buildMarkdown([{ type: 'para' }, ...items], new Map());
    // Looking for a group from each item afresh took seconds here
    expect(performance.now() - started).toBeLessThan(2000);
    expect(markdown).toStartWith('==w0== *==w1==*');
  });

  it('puts bold around an equation inside the highlight', async () => {
    // Highlighted spaces show in Word, where bold ones don't
    const { docx } = await exportParts('Seen **==a $x$ b==** on.');
    const back = await imported(docx);
    expect(back).toBe('Seen ==**a** $x$ **b**== on.');
    expect(await imported((await exportParts(back)).docx)).toBe(back);
  });
});

describe('a comment nested in a highlight or a revision', () => {
  it('covers its text inside a format highlight', async () => {
    const { docx, body } = await exportParts('Seen ==text with {==commented==}{>>comment<<} word.== on.');
    expect(body).toMatch(/<w:commentRangeStart w:id="0"\/><w:r><w:rPr><w:highlight w:val="yellow"\/><\/w:rPr><w:t>commented<\/w:t><\/w:r><w:commentRangeEnd w:id="0"\/>/);
    expect(await imported(docx)).toContain('{====commented====}{>>comment<<}');
  });

  it.each([
    ['alone', 'Seen {==[@doe2020]==}{>>c<<} on.'],
    ['first', 'Seen {==[@doe2020] a==}{>>c<<} on.'],
    ['last', 'Seen {==a [@doe2020]==}{>>c<<} on.'],
  ])('keeps a citation %s in its range', async (_, text) => {
    const { docx } = await exportParts(text);
    expect(await imported(docx)).toBe(text);
  });

  it.each([
    ['plain', 'Seen{==[@doe2020]==}{>>c<<} on.', 'Seen {==[@doe2020]==}{>>c<<} on.'],
    ['highlighted', 'Seen{====[@doe2020]====}{>>c<<} on.', 'Seen {====[@doe2020]====}{>>c<<} on.'],
  ])('puts the space before a %s citation opening its range outside it', async (_, text, back) => {
    const { docx } = await exportParts(text);
    expect(await imported(docx)).toBe(back);
  });

  it('covers its text inside an insertion, without a highlight', async () => {
    const { docx, body } = await exportParts('Seen {++a {==b==}{>>c<<} d++} on.');
    expect(body).toMatch(/<w:commentRangeStart w:id="0"\/><w:r><w:t>b<\/w:t><\/w:r><w:commentRangeEnd w:id="0"\/>/);
    expect(await imported(docx)).toBe('Seen {++a ++}{=={++b++}==}{>>c<<}{++ d++} on.');
  });
});
