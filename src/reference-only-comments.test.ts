import { describe, test, expect } from 'bun:test';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';

// WordprocessingML lets a comment's w:commentReference alone mark it at a
// point, with no w:commentRangeStart or w:commentRangeEnd; import dropped
// such a comment, text and all.

/** `md` exported, with `edit` applied to `part`'s XML, imported */
async function roundTrip(md: string, edit: (xml: string) => string, part = 'word/document.xml'): Promise<string> {
  const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
  zip.file(part, edit(await zip.file(part)!.async('string')));
  return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
}

const noRanges = (xml: string) => xml.replace(/<w:commentRange(?:Start|End) w:id="\d+"\/>/g, '');

describe('comments marked by their reference alone', () => {
  for (const md of [
    'Body.{>>note<<}\n',
    'One {>>a<<}two{>>b<<} three.\n',
    '---\ntitle: T\n---\n\n{>>note<<}\n\nBody.\n',
  ]) {
    test('import keeps ' + JSON.stringify(md), async () => {
      expect(await roundTrip(md, noRanges)).toBe(md);
    });
  }

  test('keep their authors, dates and replies', async () => {
    const md = 'Body.{>>@alice (2024-01-15 14:30) | note\n  {>>@bob (2024-01-16 09:00) | reply<<}\n<<} More.\n';
    const ranged = await roundTrip(md, xml => xml);
    expect(ranged).toContain('@bob');
    expect(await roundTrip(md, noRanges)).toBe(ranged);
  });

  test('beside a comment with a range, each reads as its own', async () => {
    const md = '{==Marked==}{>>a<<} and here{>>b<<}.\n';
    const ranged = await roundTrip(md, xml => xml);
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const ids = [...xml.matchAll(/<w:commentReference w:id="(\d+)"\/>/g)].map(m => m[1]);
    expect(ids.length).toBe(2);
    const second = new RegExp('<w:commentRange(?:Start|End) w:id="' + ids[1] + '"/>', 'g');
    expect(await roundTrip(md, x => x.replace(second, ''))).toBe(ranged);
  });

  test('after the text before the reference in its run', async () => {
    const out = await roundTrip('Body.{>>note<<}\n', xml => noRanges(xml).replace(
      /<w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr>(<w:commentReference w:id="\d+"\/>)<\/w:r>/,
      '<w:r><w:t>X</w:t>$1</w:r>'));
    expect(out).toBe('Body.X{>>note<<}\n');
  });

  test('in a footnote', async () => {
    const md = 'Text.[^1]\n\n[^1]: Note.{>>c<<}\n';
    const ranged = await roundTrip(md, xml => xml, 'word/footnotes.xml');
    expect(ranged).toContain('{>>c<<}');
    expect(await roundTrip(md, noRanges, 'word/footnotes.xml')).toBe(ranged);
  });
});
