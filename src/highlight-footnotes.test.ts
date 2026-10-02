// src/highlight-footnotes.test.ts — a format highlight's content exports as
// literal text, except a note reference, which keeps its note and is
// highlighted with the text around it.

import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

async function exportParts(md: string) {
  const { docx, warnings } = await convertMdToDocx(md);
  const zip = await JSZip.loadAsync(docx);
  const document = await zip.file('word/document.xml')!.async('string');
  const notes = await zip.file('word/footnotes.xml')?.async('string') ?? '';
  return { docx, warnings, body: document.slice(document.indexOf('<w:body>')), notes };
}

async function imported(docx: Uint8Array): Promise<string> {
  return (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

describe('a note reference in a format highlight', () => {
  it.each([
    ['a highlight', 'Seen ==a[^1]== on.', 'yellow'],
    ['a colored highlight', 'Seen ==a[^1]=={red} on.', 'red'],
    ['a highlight in an insertion', 'Seen {++==a[^1]==++} on.', 'yellow'],
  ])('keeps its note in %s', async (_, text, color) => {
    const { docx, body, notes, warnings } = await exportParts(text + '\n\n[^1]: Note.');
    expect(body).toContain('<w:rPr><w:rStyle w:val="FootnoteReference"/><w:highlight w:val="' + color + '"/></w:rPr><w:footnoteReference w:id="1"/>');
    expect(body).not.toContain('[^1]');
    expect(notes).toContain('Note.');
    expect(warnings).toEqual([]);
    // Import doesn't read a highlight on the mark, as with **a[^1]**
    const markdown = await imported(docx);
    expect(markdown).toContain('==a==');
    expect(markdown).toContain('[^1]');
    expect(markdown).toEndWith('\n\n[^1]: Note.');
  });

  it.each([
    ['an insertion', 'Seen {++==a[^1]b==++} on.', 'Seen {++==a==[^1]==b==++} on.'],
    ['a deletion', 'Seen {--==a[^1]b==--} on.', 'Seen {--==a==[^1]==b==--} on.'],
    ['bold in an insertion', 'Seen {++**==a[^1]b==**++} on.', 'Seen {++**==a==**[^1]**==b==**++} on.'],
    ['struck through in an insertion', 'Seen {++~~==a[^1]b==~~++} on.', 'Seen {++~~==a==~~[^1]~~==b==~~++} on.'],
    ['underlined in an insertion', 'Seen {++<u>==a[^1]b==</u>++} on.', 'Seen {++<u>==a==</u>[^1]<u>==b==</u>++} on.'],
  ])('keeps one revision in %s', async (_, text, back) => {
    const { docx } = await exportParts(text + '\n\n[^1]: Note.');
    // The mark comes back outside the highlight, but inside the revision
    expect(await imported(docx)).toBe(back + '\n\n[^1]: Note.');
    expect(await imported((await exportParts(back + '\n\n[^1]: Note.')).docx)).toBe(back + '\n\n[^1]: Note.');
  });

  it('keeps the rest of the content literal', async () => {
    const { body } = await exportParts('Seen ==a *b*[^1] c== on.\n\n[^1]: Note.');
    expect(body).toContain('<w:t>a *b*</w:t>');
    expect(body).toContain('<w:t xml:space="preserve"> c</w:t>');
    expect(body).toContain('<w:footnoteReference w:id="1"/>');
  });

  it.each([
    ['escaped and in a code span', 'a `[^1]` \\[^1] b', ''],
    ['in an image\'s alt text', '![alt[^1]](x.png) b', ''],
    ['in a reference image\'s alt text', '![alt[^1]][img] b', '\n\n[img]: x.png'],
    ['in a comment with an ID', 'a {#c>>comment[^1]<<} b', ''],
    ['in a reference image\'s alt text, in a custom style', '![alt[^1]][img] b', '\n\n[img]: x.png', 'style'],
    ['in a reference image\'s alt text, in a note', '![alt[^1]][img] b', '\n\n[img]: x.png', 'note'],
  ])('leaves a reference %s as text', async (_, content, definitions, context = '') => {
    const highlight = 'Seen ==' + content + '[^2]== on.';
    if (context === 'note') {
      // The note's highlight uses the document's definition, and [^1] stays alt text
      const { notes, warnings } = await exportParts('Main[^3].\n\n[^3]: ' + highlight + definitions + '\n\n[^1]: One.\n\n[^2]: Two.');
      expect(notes).toContain('<w:t>' + content + '</w:t>');
      expect(warnings).toContain('Footnote definition [^1] has no matching reference in the document.');
      return;
    }
    const paragraph = context === 'style' ? '<!-- style: Foo -->' + highlight + '<!-- /style -->' : highlight;
    const { body, warnings } = await exportParts(paragraph + definitions + '\n\n[^1]: One.\n\n[^2]: Two.');
    expect(body).toContain('<w:t>' + content.replace(/>/g, '&gt;').replace(/</g, '&lt;') + '</w:t>');
    expect(body.match(/<w:footnoteReference /g)).toHaveLength(1);
    expect(warnings).toEqual(['Footnote definition [^1] has no matching reference in the document.']);
  });
});
