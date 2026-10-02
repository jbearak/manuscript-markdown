// src/critic-footnotes.test.ts — a footnote reference inside a tracked change
// exports as a Word note reference inside the revision, keeps its note, and
// imports back where it was.

import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

const bibtex = `@article{doe2020, author={Doe, Jane}, title={A study}, journal={J}, year={2020}}`;

async function exportParts(md: string) {
  const { docx, warnings } = await convertMdToDocx(md, { bibtex });
  const zip = await JSZip.loadAsync(docx);
  const document = await zip.file('word/document.xml')!.async('string');
  const notes = await zip.file('word/footnotes.xml')?.async('string') ?? '';
  return { docx, warnings, body: document.slice(document.indexOf('<w:body>')), notes };
}

async function roundTrip(md: string): Promise<string> {
  const { docx } = await convertMdToDocx(md, { bibtex });
  const imported = await convertDocx(docx, 'authorYearTitle', { existingBibtex: bibtex });
  return imported.markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/<!-- references -->\n\n/, '').trim();
}

const revisions = (body: string, tag: 'w:ins' | 'w:del') => body.match(new RegExp('<' + tag + ' [^>]*>[\\s\\S]*?</' + tag + '>', 'g')) ?? [];

describe('a footnote reference inside a tracked change', () => {
  it.each([
    ['an insertion', 'Seen {++more.[^1] Then++} on.\n\n[^1]: Note.', 'w:ins'],
    ['a deletion', 'Seen {--more.[^1] Then--} on.\n\n[^1]: Note.', 'w:del'],
    ['the old side of a substitution', 'Seen {~~old[^1]~>new~~} on.\n\n[^1]: Note.', 'w:del'],
    ['the new side of a substitution', 'Seen {~~old~>new[^1]~~} on.\n\n[^1]: Note.', 'w:ins'],
  ] as const)('exports as a note inside %s and round-trips', async (_, md, tag) => {
    const { body, notes, warnings } = await exportParts(md);
    expect(revisions(body, tag).some(xml => xml.includes('<w:footnoteReference w:id="1"/>'))).toBe(true);
    expect(body).not.toContain('[^1]');
    expect(notes).toContain('Note.');
    expect(warnings).toEqual([]);
    expect(await roundTrip(md)).toBe(md);
  });

  it('round-trips in a table cell', async () => {
    const md = '| a | b |\n| --- | --- |\n| {++x[^1]++} | y |\n\n[^1]: Note.';
    expect(await roundTrip(md)).toBe(md);
  });

  it.each([
    ['a citation', '{++a [@doe2020][^1]++}.'],
    ['an equation', '{++a $x$[^1]++}.'],
    ['emphasis, code and a closing quote', '{++*a*[^1] `c`[^1] "q"[^1]++}.'],
    ['a word, before another', '{++before[^1]after++}.'],
  ])('stays in one span after %s', async (_, text) => {
    const md = text + '\n\n[^1]: Note.';
    expect(await roundTrip(md)).toBe(md);
  });

  it('keeps one deletion around a note referenced twice in it', async () => {
    const md = 'Seen {--a[^1]b[^1]c--}.\n\n[^1]: Note.';
    expect(await roundTrip(md)).toBe(md);
  });

  it('numbers a note\'s citations where the reference that owns the note is', async () => {
    const md = '---\ncsl: ieee\n---\n\n{--x[^1]--} then [@a2020] and B[^1].\n\n[^1]: Note [@b2020].';
    const numbered = `@article{a2020, author={Alpha, A}, title={A}, journal={J}, year={2020}}
@article{b2020, author={Beta, B}, title={B}, journal={J}, year={2020}}`;
    const { docx } = await convertMdToDocx(md, { bibtex: numbered });
    const zip = await JSZip.loadAsync(docx);
    const document = await zip.file('word/document.xml')!.async('string');
    const notes = await zip.file('word/footnotes.xml')!.async('string');
    // The deleted reference doesn't own the note, so B's note comes after [@a2020]
    expect(document).toContain('<w:t>[1]</w:t>');
    expect(notes).toContain('<w:t>[2]</w:t>');
  });

  it('registers the citations of a note referenced only from deleted text', async () => {
    const { notes } = await exportParts('Seen {--x[^1]--} on.\n\n[^1]: Note [@doe2020].');
    expect(notes).toContain('ADDIN ZOTERO_ITEM');
    expect(notes).toContain('(Doe, 2020)');
  });
});

describe('a label referenced more than once', () => {
  it.each([
    ['before', 'A[^1] and {++b[^1]++} and {--c[^1]--}.'],
    ['after', '{++b[^1]++} and {--c[^1]--} then A[^1].'],
  ])('gives the note to the untracked reference when it comes %s the tracked ones', async (_, text) => {
    const md = text + '\n\n[^1]: Note.';
    const { body } = await exportParts(md);
    expect(body.match(/<w:footnoteReference /g)).toHaveLength(1);
    for (const xml of [...revisions(body, 'w:ins'), ...revisions(body, 'w:del')]) expect(xml).not.toContain('<w:footnoteReference');
    // The tracked references cross-reference the note, the deleted one as deleted field code
    expect(revisions(body, 'w:ins')[0]).toContain('<w:instrText xml:space="preserve"> NOTEREF');
    expect(revisions(body, 'w:del')[0]).toContain('<w:delInstrText xml:space="preserve"> NOTEREF');
    expect(await roundTrip(md)).toBe(md);
  });

  it('gives the note to the first tracked reference when none is untracked', async () => {
    const md = '{--a[^1]--} then {++b[^1]++} and {--c[^1]--}.\n\n[^1]: Note.';
    const { body } = await exportParts(md);
    expect(revisions(body, 'w:del')[0]).toContain('<w:footnoteReference w:id="1"/>');
    expect(revisions(body, 'w:ins')[0]).toContain('NOTEREF');
    expect(revisions(body, 'w:del')[1]).toContain('<w:delInstrText xml:space="preserve"> NOTEREF');
    expect(await roundTrip(md)).toBe(md);
  });

  it('numbers each note where the reference that owns it is', async () => {
    const md = '{++b[^1]++} then A[^2] then C[^1].\n\n[^1]: One.\n\n[^2]: Two.';
    const { body } = await exportParts(md);
    // Word numbers A's note 1 and C's note 2, which the inserted cross-reference shows
    expect(body.match(/<w:footnoteReference [^>]*>/g)).toEqual(['<w:footnoteReference w:id="1"/>', '<w:footnoteReference w:id="2"/>']);
    expect(revisions(body, 'w:ins')[0]).toContain('<w:t>2</w:t>');
    expect(await roundTrip(md)).toBe(md);
  });

  it.each([
    ['a deleted cross-reference comes before the note', '{--x[^1]--} A[^2] B[^1].'],
    ['an inserted cross-reference comes before the note', '{++b[^2]++} A[^1] C[^2].'],
  ])('keeps each label on its note when %s', async (_, text) => {
    const md = text + '\n\n[^1]: One.\n\n[^2]: Two.';
    expect(await roundTrip(md)).toBe(md);
  });

  it('gives an endnote to the untracked reference', async () => {
    const md = '---\nnotes: endnotes\n---\n\n{++b[^1]++} then A[^1].\n\n[^1]: Note.';
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    const body = await zip.file('word/document.xml')!.async('string');
    expect(revisions(body, 'w:ins')[0]).toContain('NOTEREF');
    expect(body.match(/<w:endnoteReference /g)).toHaveLength(1);
    expect(body).not.toContain('<w:footnoteReference');
  });
});

describe('a footnote reference in a comment', () => {
  it.each([
    ['alone', 'Seen {==[^1]==}{>>c<<} on.'],
    ['after text', 'Seen {==hi[^1]==}{>>c<<} on.'],
    ['in an insertion', 'Seen {==a {++b[^1]++}==}{>>c<<} on.'],
  ])('stays in the range %s', async (_, text) => {
    const md = text + '\n\n[^1]: Note.';
    expect(await roundTrip(md)).toBe(md);
  });
});
