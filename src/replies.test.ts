import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { xmlParser } from './xml-parser';
import {
  convertDocx,
  extractComments,
  extractCommentThreads,
  groupCommentThreads,
  buildMarkdown,
  DEFAULT_FORMATTING,
  type Comment,
} from './converter';
import {
  parseMd,
  convertMdToDocx,
} from './md-to-docx';
import { preprocessCriticMarkup, findMatchingClose } from './critic-markup';

const FIXTURE_PATH = path.join(__dirname, '..', 'test', 'fixtures', 'replies.docx');

describe('findMatchingClose', () => {
  test('finds close for simple {>>...<<}', () => {
    const src = 'hello<<}world';
    expect(findMatchingClose(src, 0)).toBe(5);
  });

  test('finds close with one nested {>>...<<}', () => {
    const src = 'parent {>>reply<<} end<<}';
    expect(findMatchingClose(src, 0)).toBe(22);
  });

  test('finds close with multiple nested {>>...<<}', () => {
    const src = '{>>r1<<} {>>r2<<} end<<}';
    expect(findMatchingClose(src, 0)).toBe(21);
  });

  test('finds close with a nested ID comment', () => {
    const src = 'parent {#reply-1>>nested<<} end<<}';
    expect(findMatchingClose(src, 0)).toBe(src.lastIndexOf('<<}'));
  });

  test('finds close with mixed plain and ID comment nesting', () => {
    const src = 'parent {>>plain {#reply_2>>nested<<} tail<<} end<<}';
    expect(findMatchingClose(src, 0)).toBe(src.lastIndexOf('<<}'));
  });

  test('returns -1 when no close found', () => {
    expect(findMatchingClose('no close here', 0)).toBe(-1);
  });
});

describe('Comment reply threads: DOCX→MD', () => {
  const fixtureExists = fs.existsSync(FIXTURE_PATH);

  (fixtureExists ? test : test.skip)('converts replies.docx with nested reply syntax', async () => {
    const data = fs.readFileSync(FIXTURE_PATH);
    const result = await convertDocx(new Uint8Array(data));
    const md = result.markdown;

    // Reply comments should NOT get their own range IDs
    // Count range start markers {#N}
    const rangeStarts = md.match(/\{#\d+\}/g) || [];
    // Only top-level (non-reply) comments should have ranges
    // The fixture has 3 top-level comments
    expect(rangeStarts.length).toBe(3);

    // Nested replies should appear as {>>...<<} inside the parent body
    expect(md).toContain('{>>');
    expect(md).toContain('<<}');

    // Each parent comment body with replies should have the pattern:
    // {#N>>@author (date) | text
    //   {>>@reply author (date) | reply text<<}
    // <<}
    const parentWithReplies = /\{#\d+>>[\s\S]*?\n\s+\{>>[\s\S]*?<<\}\n<<\}/;
    expect(parentWithReplies.test(md)).toBe(true);
  });
});

describe('extractCommentThreads', () => {
  test('returns empty map when no commentsExtended.xml', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    const data = await zip.generateAsync({ type: 'uint8array' });
    const threads = await extractCommentThreads(data);
    expect(threads.size).toBe(0);
  });

  test('extracts paraId→parentParaId mappings', async () => {
    const zip = new JSZip();
    zip.file('word/commentsExtended.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w15">
  <w15:commentEx w15:paraId="AAAA0001" w15:done="0"/>
  <w15:commentEx w15:paraId="AAAA0002" w15:paraIdParent="AAAA0001" w15:done="0"/>
  <w15:commentEx w15:paraId="AAAA0003" w15:paraIdParent="AAAA0001" w15:done="0"/>
</w15:commentsEx>`);
    const data = await zip.generateAsync({ type: 'uint8array' });
    const threads = await extractCommentThreads(data);
    expect(threads.size).toBe(2);
    expect(threads.get('AAAA0002')).toBe('AAAA0001');
    expect(threads.get('AAAA0003')).toBe('AAAA0001');
  });
});

describe('groupCommentThreads', () => {
  test('attaches replies to parent and returns replyIds', () => {
    const comments = new Map<string, Comment>([
      ['0', { author: 'Alice', text: 'Parent', date: '2024-01-01T00:00:00Z', paraId: 'P001' }],
      ['1', { author: 'Bob', text: 'Reply 1', date: '2024-01-02T00:00:00Z', paraId: 'P002' }],
      ['2', { author: 'Carol', text: 'Reply 2', date: '2024-01-03T00:00:00Z', paraId: 'P003' }],
      ['3', { author: 'Dave', text: 'Standalone', date: '2024-01-04T00:00:00Z', paraId: 'P004' }],
    ]);

    const threads = new Map<string, string>([
      ['P002', 'P001'], // Reply 1 → Parent
      ['P003', 'P001'], // Reply 2 → Parent
    ]);

    const replyIds = groupCommentThreads(comments, threads);

    // Replies should be attached to parent
    const parent = comments.get('0')!;
    expect(parent.replies).toHaveLength(2);
    expect(parent.replies![0]).toEqual({ author: 'Bob', text: 'Reply 1', date: '2024-01-02T00:00:00Z' });
    expect(parent.replies![1]).toEqual({ author: 'Carol', text: 'Reply 2', date: '2024-01-03T00:00:00Z' });

    // Reply IDs should be in the set
    expect(replyIds.has('1')).toBe(true);
    expect(replyIds.has('2')).toBe(true);
    expect(replyIds.has('0')).toBe(false);
    expect(replyIds.has('3')).toBe(false);
  });

  test('returns empty set when no threads', () => {
    const comments = new Map<string, Comment>([
      ['0', { author: 'Alice', text: 'Comment', date: '', paraId: 'P001' }],
    ]);
    const threads = new Map<string, string>();
    const replyIds = groupCommentThreads(comments, threads);
    expect(replyIds.size).toBe(0);
  });
});

describe('Comment reply threads: MD→DOCX', () => {
  test('parses nested reply syntax and generates separate comments', async () => {
    const md = `This is {#1}some text{/1}

{#1>>@Alice (2024-01-15T14:30-05:00) | Parent comment
  {>>@Bob (2024-01-16T10:00-05:00) | First reply<<}
  {>>@Carol (2024-01-17T09:00-05:00) | Second reply<<}
<<}`;

    const result = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(result.docx);

    // Check comments.xml has 3 comments (parent + 2 replies)
    const commentsXml = await zip.file('word/comments.xml')!.async('string');
    const parser = xmlParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      preserveOrder: true,
    });
    const parsed = parser.parse(commentsXml);

    // Find all w:comment elements
    function findAll(nodes: any[], tag: string): any[] {
      const results: any[] = [];
      for (const node of nodes) {
        if (node[tag] !== undefined) results.push(node);
        for (const key of Object.keys(node)) {
          if (key !== ':@' && Array.isArray(node[key])) {
            results.push(...findAll(node[key], tag));
          }
        }
      }
      return results;
    }

    const commentNodes = findAll(parsed, 'w:comment');
    expect(commentNodes.length).toBe(3);

    // Check that commentsExtended.xml exists and has reply structure
    const extFile = zip.file('word/commentsExtended.xml');
    expect(extFile).not.toBeNull();
    const extXml = await extFile!.async('string');
    expect(extXml).toContain('w15:paraIdParent');

    // Threaded comments package parts required for Word to preserve replies
    expect(zip.file('word/commentsIds.xml')).not.toBeNull();
    expect(zip.file('word/commentsExtensible.xml')).not.toBeNull();
    expect(zip.file('word/people.xml')).not.toBeNull();

    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(relsXml).toContain('commentsExtended');
    expect(relsXml).toContain('commentsIds');
    expect(relsXml).toContain('commentsExtensible');
    expect(relsXml).toContain('relationships/people');

    const contentTypesXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(contentTypesXml).toContain('/word/commentsExtended.xml');
    expect(contentTypesXml).toContain('/word/commentsIds.xml');
    expect(contentTypesXml).toContain('/word/commentsExtensible.xml');
    expect(contentTypesXml).toContain('/word/people.xml');

    // Check that w14:paraId is on the last <w:p> of each <w:comment>
    const commentBlocks = commentsXml.match(/<w:comment[\s\S]*?<\/w:comment>/g)!;
    expect(commentBlocks.length).toBeGreaterThan(0);
    for (const block of commentBlocks) {
      const paragraphs = block.match(/<w:p[^>]*>/g)!;
      expect(paragraphs.length).toBeGreaterThan(0);
      const lastP = paragraphs[paragraphs.length - 1];
      expect(lastP).toContain('w14:paraId');
    }
  });

  test('anchors parent and reply comment ranges in document.xml', async () => {
    const md = `This is {#1}some text{/1}

{#1>>@Alice (2024-01-15T14:30-05:00) | Parent comment
  {>>@Bob (2024-01-16T10:00-05:00) | First reply<<}
  {>>@Carol (2024-01-17T09:00-05:00) | Second reply<<}
<<}`;

    const result = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')!.async('string');

    // Parent comment (id=0) should have range markers
    expect(docXml).toContain('w:commentRangeStart w:id="0"');
    expect(docXml).toContain('w:commentRangeEnd w:id="0"');

    // Reply comments should also be anchored so Word retains threading metadata on save.
    expect(docXml).toContain('w:commentRangeStart w:id=\"1\"');
    expect(docXml).toContain('w:commentRangeEnd w:id=\"1\"');
    expect(docXml).toContain('w:commentReference w:id=\"1\"');
    expect(docXml).toContain('w:commentRangeStart w:id=\"2\"');
    expect(docXml).toContain('w:commentRangeEnd w:id=\"2\"');
    expect(docXml).toContain('w:commentReference w:id=\"2\"');
  });

  test('parses markdown without replies (no commentsExtended.xml)', async () => {
    const md = `This is {#1}some text{/1}

{#1>>@Alice (2024-01-15T14:30-05:00) | Just a comment<<}`;

    const result = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(result.docx);

    // No commentsExtended.xml since there are no replies
    const extFile = zip.file('word/commentsExtended.xml');
    expect(extFile).toBeNull();
    expect(zip.file('word/commentsIds.xml')).toBeNull();
    expect(zip.file('word/commentsExtensible.xml')).toBeNull();
    expect(zip.file('word/people.xml')).toBeNull();
  });
});

describe('Comment reply threads: round-trip', () => {
  test('MD→DOCX→MD preserves reply structure (single comment)', async () => {
    const md = `This is {#1}some text{/1}

{#1>>@Alice (2024-01-15T14:30-05:00) | Parent comment
  {>>@Bob (2024-01-16T10:00-05:00) | First reply<<}
  {>>@Carol (2024-01-17T09:00-05:00) | Second reply<<}
<<}`;

    // MD → DOCX
    const { docx } = await convertMdToDocx(md);

    // DOCX → MD
    const result = await convertDocx(docx);
    const roundTripped = result.markdown;

    // Should contain all comment content
    expect(roundTripped).toContain('Parent comment');
    expect(roundTripped).toContain('First reply');
    expect(roundTripped).toContain('Second reply');

    // Nested replies should be present (inside the parent's {>>...<<} or {#id>>...<<})
    // With a single comment, buildMarkdown uses traditional {==...==}{>>...<<} syntax,
    // but replies are still nested inside the parent body
    const nestedReply = /\{>>[^\n]*<<\}/;
    expect(nestedReply.test(roundTripped)).toBe(true);
  });

  test('MD→DOCX→MD preserves reply structure (overlapping comments)', async () => {
    const md = `This is {#1}{#2}some text{/1} more text{/2}

{#1>>@Alice (2024-01-15T14:30-05:00) | Parent comment
  {>>@Bob (2024-01-16T10:00-05:00) | Reply to Alice<<}
<<}
{#2>>@Dave (2024-01-15T15:00-05:00) | Another comment<<}`;

    // MD → DOCX
    const { docx } = await convertMdToDocx(md);

    // DOCX → MD
    const result = await convertDocx(docx);
    const roundTripped = result.markdown;

    // With overlapping comments, ID-based syntax is used
    // Should have 2 range start markers (not 3, since the reply doesn't get its own range)
    const rangeStarts = roundTripped.match(/\{#\d+\}/g) || [];
    expect(rangeStarts.length).toBe(2);

    // Should contain nested reply
    expect(roundTripped).toContain('Reply to Alice');
    expect(roundTripped).toContain('Parent comment');
    expect(roundTripped).toContain('Another comment');
  });
});

describe('preprocessCriticMarkup: nested replies', () => {
  test('preserves paragraph breaks inside comment with nested replies', () => {
    const input = `{#1>>@Alice (2024-01-15) | Parent

  {>>@Bob | Reply<<}
<<}`;
    const result = preprocessCriticMarkup(input);
    // The \n\n between "Parent" and the reply should be replaced with placeholder
    expect(result).not.toContain('\n\n');
    expect(result).toContain('\uE000PARA\uE000');
  });
});

describe('Non-ID comment replies (inline {>>...<<})', () => {
  test('non-ID comment with replies round-trips through MD→DOCX→MD', async () => {
    const md = `{==some text==}{>>@Alice (2024-01-15T14:30-05:00) | Parent comment
  {>>@Bob (2024-01-16T10:00-05:00) | Reply<<}
<<}`;

    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);

    // comments.xml should have 2 comments (parent + reply)
    const commentsXml = await zip.file('word/comments.xml')!.async('string');
    expect((commentsXml.match(/w:comment /g) || []).length).toBe(2);

    // commentsExtended.xml should exist with reply linkage
    const extFile = zip.file('word/commentsExtended.xml');
    expect(extFile).not.toBeNull();
    const extXml = await extFile!.async('string');
    expect(extXml).toContain('w15:paraIdParent');
  });
});

describe('Consecutive reply format preservation', () => {
  test('consecutive reply format round-trips as consecutive', async () => {
    const md = `{==some text==}{>>@Alice (2024-01-15T14:30-05:00) | Parent comment<<}{>>@Bob (2024-01-16T10:00-05:00) | Reply<<}`;

    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);

    // Should preserve consecutive format (no nested indentation)
    expect(result.markdown).toContain('Parent comment<<}{>>@Bob');
    expect(result.markdown).not.toContain('\n  {>>');
  });

  test('nested reply format round-trips as nested', async () => {
    const md = `{==some text==}{>>@Alice (2024-01-15T14:30-05:00) | Parent comment
  {>>@Bob (2024-01-16T10:00-05:00) | Reply<<}
<<}`;

    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);

    // Should preserve nested format
    expect(result.markdown).toContain('\n  {>>@Bob');
    expect(result.markdown).toContain('\n<<}');
  });

  test('consecutive replies preserve reply-on-reply entries', async () => {
    const md = `{==some text==}{>>@Alice (2024-01-15T14:30-05:00) | Parent comment<<}{>>@Bob (2024-01-16T10:00-05:00) | Mid reply
  {>>@Carol (2024-01-17T09:00-05:00) | Nested reply<<}
<<}`;

    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);

    const commentsXml = await zip.file('word/comments.xml')!.async('string');
    expect((commentsXml.match(/w:comment /g) || []).length).toBe(3);

    const extXml = await zip.file('word/commentsExtended.xml')!.async('string');
    expect((extXml.match(/w15:paraIdParent/g) || []).length).toBe(2);
  });

  test.each([
    ['the body', 'A {#1}b {#2}c{/1} d{/2}.\n{#1>>@A (2024-01-15 10:30) | one<<}{>>@B (2024-01-15 11:30) | r1<<}{>>@C (2024-01-15 12:30) | r2<<}\n'
      + '{#2>>@B (2024-01-15 10:30) | two<<}\n'],
    ['a footnote', 'Text.[^1]\n\n[^1]: {#1}A {#2}b{/1} c{/2}.\n    {#1>>@A (2024-01-15 10:30) | one<<}{>>@B (2024-01-15 11:30) | reply<<}\n'
      + '    {#2>>@B (2024-01-15 10:30) | two<<}\n'],
    ['a table', '| a | b |\n| --- | --- |\n| {#1}x {#2}y{/1} z{/2} | 2 |\n\n'
      + '{#1>>@A (2024-01-15 10:30) | one<<}{>>@B (2024-01-15 11:30) | reply<<}\n{#2>>@B (2024-01-15 10:30) | two<<}\n'],
  ])('reads consecutive replies after an ID body in %s as its replies', async (_name, md) => {
    // Import writes them so where the comment takes ID syntax, and export
    // read each as a comment of its own, without a range
    const { docx } = await convertMdToDocx(md);
    const extXml = await (await JSZip.loadAsync(docx)).file('word/commentsExtended.xml')!.async('string');
    expect((extXml.match(/w15:paraIdParent/g) || []).length).toBe(md.split('{>>').length - 1);
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  test('keeps a reply to a consecutive reply after an ID body a reply to it', async () => {
    // As after a {==...==} anchor, rather than a reply to the comment
    const md = 'A {#1}b {#2}c{/1} d{/2}.\n{#1>>@A (2024-01-15 10:30) | one<<}{>>@B (2024-01-15 11:30) | r1\n'
      + '  {>>@C (2024-01-15 12:30) | nested<<}\n<<}\n{#2>>@B (2024-01-15 10:30) | two<<}';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const commentsXml = await zip.file('word/comments.xml')!.async('string');
    const paraIdOf = (text: string) => new RegExp('w14:paraId="([^"]+)"(?:(?!</w:comment>)[^])*?>' + text + '<').exec(commentsXml)?.[1];
    const extXml = await zip.file('word/commentsExtended.xml')!.async('string');
    expect(extXml).toContain('w15:paraId="' + paraIdOf('r1') + '" w15:paraIdParent="' + paraIdOf('one') + '"');
    expect(extXml).toContain('w15:paraId="' + paraIdOf('nested') + '" w15:paraIdParent="' + paraIdOf('r1') + '"');
  });

  test('leaves a comment after an ID body and a space a comment of its own', async () => {
    const { docx } = await convertMdToDocx('A {#1}b{/1}.\n{#1>>@A (2024-01-15 10:30) | one<<} {>>@B (2024-01-15 11:30) | two<<}');
    const extXml = await (await JSZip.loadAsync(docx)).file('word/commentsExtended.xml')?.async('string');
    expect(extXml ?? '').not.toContain('w15:paraIdParent');
  });
});

/** Word's comments, each as its text, an * where its range holds nothing,
 *  and after a < the text of the comment it replies to */
async function wordThreads(docx: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(docx);
  const commentsXml = await zip.file('word/comments.xml')!.async('string');
  const extXml = (await zip.file('word/commentsExtended.xml')?.async('string')) ?? '';
  let ranges = '';
  for (const part of ['word/document.xml', 'word/footnotes.xml']) ranges += (await zip.file(part)?.async('string')) ?? '';
  const comments = [...commentsXml.matchAll(/<w:comment w:id="(\d+)"[^>]*>(?:(?!<\/w:comment>)[^])*?w14:paraId="(\w+)"(?:(?!<\/w:comment>)[^])*?<w:t>([^<]*)<\/w:t>/g)]
    .map(([, id, paraId, text]) => ({ id, paraId, text }));
  const parents = new Map([...extXml.matchAll(/w15:paraId="(\w+)" w15:paraIdParent="(\w+)"/g)].map(([, paraId, parent]) => [paraId, parent]));
  return comments.map(c => {
    const parent = comments.find(p => p.paraId === parents.get(c.paraId));
    const empty = ranges.includes('<w:commentRangeStart w:id="' + c.id + '"/><w:commentRangeEnd w:id="' + c.id + '"/>');
    return c.text + (empty ? '*' : '') + (parent ? ' < ' + parent.text : '');
  }).sort();
}

describe('A comment on no text right after a range', () => {
  // Import wrote its body right after the range's, as
  // {==t==}{>>one<<}{>>two<<}, which export reads as a comment and its reply
  const one = '{#c1>>@A (2024-01-15 10:30) | one<<}';
  const two = '{>>@B (2024-01-15 11:30) | two<<}';

  test.each([
    ['a paragraph', 'P {#c1}t{/c1}' + two + ' Q\n\n' + one],
    ['a note', 'T.[^1]\n\n[^1]: P {#c1}t{/c1}' + two + ' Q\n    ' + one],
    ['a table cell', '| h |\n| --- |\n| P {#c1}t{/c1}' + two.replace('|', '\\|') + ' Q |\n\n' + one],
    ['an alert', '> [!NOTE]\n> P {#c1}t{/c1}' + two + ' Q\n\n' + one],
    ['an equation', 'P {#c1}$x${/c1}' + two + ' Q\n\n' + one],
    ['emphasis', 'P {#c1}**t**{/c1}' + two + ' Q\n\n' + one],
  ])('keeps it a comment of its own in %s', async (_name, md) => {
    const first = await convertMdToDocx(md);
    expect(await wordThreads(first.docx)).toEqual(['one', 'two*']);
    const imported = (await convertDocx(first.docx)).markdown;
    const second = await convertMdToDocx(imported);
    expect(await wordThreads(second.docx)).toEqual(['one', 'two*']);
    expect((await convertDocx(second.docx)).markdown).toBe(imported);
  });

  test('writes them in ID syntax, each body after the paragraph', async () => {
    const md = 'P {#c1}t{/c1}' + two + ' Q\n\n' + one;
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown)
      .toBe('P {#c1}t{/c1}{#1}{/1} Q\n{#1>>@B (2024-01-15 11:30) | two<<}\n' + one + '\n');
  });

  /** Export's document for `md`, with the space between the two comments out
   *  of the part that holds it, as Word has a comment on no text right at
   *  the end of another's range, and with `edit` */
  async function wordWithout(md: string, part: string, edit = (xml: string) => xml): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file(part)!.async('string');
    const space = /(<w:commentReference w:id="\d+"\/><\/w:r>)<w:r><w:t xml:space="preserve"> <\/w:t><\/w:r>(<w:commentRangeStart)/;
    expect(xml).toMatch(space);
    zip.file(part, edit(xml.replace(space, (_m, reference: string, start: string) => reference + start)));
    return zip.generateAsync({ type: 'uint8array' });
  }

  test.each([
    ['a paragraph', 'P {==t==}{>>@A (2024-01-15 10:30) | one<<} ' + two + ' Q', 'word/document.xml'],
    ['a note', 'T.[^1]\n\n[^1]: P {==t==}{>>@A (2024-01-15 10:30) | one<<} ' + two + ' Q', 'word/footnotes.xml'],
    ['a table cell', '| h |\n| --- |\n| P {==t==}{>>@A (2024-01-15 10:30) \\| one<<} ' + two.replace('|', '\\|') + ' Q |', 'word/document.xml'],
    ['an alert', '> [!NOTE]\n> P {==t==}{>>@A (2024-01-15 10:30) | one<<} ' + two + ' Q', 'word/document.xml'],
    ['an equation', 'P {==$x$==}{>>@A (2024-01-15 10:30) | one<<} ' + two + ' Q', 'word/document.xml'],
  ])('keeps Word\'s comment on no text at a range\'s end a comment of its own in %s', async (_name, md, part) => {
    const word = await wordWithout(md, part);
    expect(await wordThreads(word)).toEqual(['one', 'two*']);
    const imported = (await convertDocx(word)).markdown;
    const second = await convertMdToDocx(imported);
    expect(await wordThreads(second.docx)).toEqual(['one', 'two*']);
    expect((await convertDocx(second.docx)).markdown).toBe(imported);
  });

  /** `xml` with `pattern` replaced by `to`, where it's found */
  const edited = (pattern: RegExp | string, to: string) => (xml: string) => {
    expect(xml).toMatch(pattern);
    return xml.replace(pattern, to);
  };
  // The header row's two cells as one, which only an HTML table holds
  const merged = edited(/(<w:tc><w:tcPr>)((?:(?!<\/w:tc>)[^])*?<\/w:tc>)<w:tc>(?:(?!<\/w:tc>)[^])*?<\/w:tc>/, '$1<w:gridSpan w:val="2"/>$2');
  // The X a paragraph starts with out, which then starts with an HTML comment
  const withoutX = edited('<w:r><w:t>X</w:t></w:r>', '');
  const ranged = '{==t==}{>>@A (2024-01-15 10:30) | one<<}';

  test.each([
    ['an HTML table\'s cell', '| h | i |\n| --- | --- |\n| P ' + ranged.replace('|', '\\|') + ' ' + two.replace('|', '\\|') + ' Q | z |', 'word/document.xml', merged],
    ['a paragraph that starts with an HTML comment', 'X<!-- h -->P ' + ranged + ' ' + two + ' Q', 'word/document.xml', withoutX],
    ['a list item that starts with an HTML comment', '- X<!-- h -->P ' + ranged + ' ' + two + ' Q', 'word/document.xml', withoutX],
    ['a quote that starts with an HTML comment', '> X<!-- h -->P ' + ranged + ' ' + two + ' Q', 'word/document.xml', withoutX],
    ['a note that starts with an HTML comment', 'T.[^1]\n\n[^1]: X<!-- h -->P ' + ranged + ' ' + two + ' Q', 'word/footnotes.xml', withoutX],
    // Whose fence import puts right before the comment, with no paragraph
    // between them
    ['a landscape section\'s first paragraph that starts with an HTML comment', '<!-- landscape -->\n\nX<!-- h -->P ' + ranged + ' ' + two + ' Q\n\nR\n\n<!-- /landscape -->\n\nS', 'word/document.xml', withoutX],
    ['a portrait section\'s first paragraph that starts with an HTML comment', '<!-- portrait -->\n\nX<!-- h -->P ' + ranged + ' ' + two + ' Q\n\nR\n\n<!-- /portrait -->\n\nS', 'word/document.xml', withoutX],
    ['a landscape section\'s only paragraph that starts with an HTML comment', '<!-- landscape -->\n\nX<!-- h -->P ' + ranged + ' ' + two + ' Q\n\n<!-- /landscape -->', 'word/document.xml', withoutX],
  ])('writes Word\'s comment on no text at a range\'s end in %s as before, where export reads ID syntax as text', async (_name, md, part, edit) => {
    // ID syntax there went to Word as text, and the bodies after the table
    // or the paragraph, with no range, were lost on the next trip
    const imported = (await convertDocx(await wordWithout(md, part, edit))).markdown;
    expect(imported).toContain(ranged + two);
    expect(imported).not.toContain('{#');
    expect((await convertDocx((await convertMdToDocx(imported)).docx)).markdown).toBe(imported);
  });

  test('keeps the replies Word has on each', async () => {
    const md = 'P {==t==}{>>@A (2024-01-15 10:30) | one\n  {>>@C (2024-01-15 12:30) | r1<<}\n<<} '
      + '{>>@B (2024-01-15 11:30) | two\n  {>>@D (2024-01-15 13:30) | r2<<}\n<<} Q';
    const word = await wordWithout(md, 'word/document.xml');
    expect(await wordThreads(word)).toEqual(['one', 'r1 < one', 'r2 < two', 'two']);
    const imported = (await convertDocx(word)).markdown;
    const second = await convertMdToDocx(imported);
    expect(await wordThreads(second.docx)).toEqual(['one', 'r1 < one', 'r2 < two', 'two']);
    expect((await convertDocx(second.docx)).markdown).toBe(imported);
  });

  test.each([
    ['a reply', 'P {==t==}{>>@A (2024-01-15 10:30) | one<<}' + two + ' Q', ['one', 'two < one']],
    ['a nested reply', 'P {==t==}{>>@A (2024-01-15 10:30) | one\n  ' + two + '\n<<} Q', ['one', 'two < one']],
    ['a space between', 'P {==t==}{>>@A (2024-01-15 10:30) | one<<} ' + two + ' Q', ['one', 'two*']],
    ['a comment on no text alone', 'P ' + two + ' Q', ['two*']],
    ['two comments on no text', 'P {>>@A (2024-01-15 10:30) | one<<}' + two + ' Q', ['one*', 'two*']],
    ['ranges that touch', 'P {==t==}{>>@A (2024-01-15 10:30) | one<<}{==u==}' + two + ' Q', ['one', 'two']],
    ['a comment on no text before a range', 'P ' + two + '{==t==}{>>@A (2024-01-15 10:30) | one<<} Q', ['one', 'two*']],
  ])('leaves %s as it was', async (_name, md, threads) => {
    const { docx } = await convertMdToDocx(md);
    expect(await wordThreads(docx)).toEqual(threads);
    expect((await convertDocx(docx)).markdown).toBe(md + '\n');
  });
});

/** Word's comments, each as its text, the text its range holds in [ ],
 *  after a < the text of the comment it replies to, and its author and
 *  date */
async function wordComments(docx: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(docx);
  const commentsXml = await zip.file('word/comments.xml')!.async('string');
  const extXml = (await zip.file('word/commentsExtended.xml')?.async('string')) ?? '';
  let body = '';
  for (const part of ['word/document.xml', 'word/footnotes.xml']) body += (await zip.file(part)?.async('string')) ?? '';
  const texts = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');
  const parents = new Map([...extXml.matchAll(/w15:paraId="(\w+)" w15:paraIdParent="(\w+)"/g)].map(([, paraId, parent]) => [paraId, parent]));
  const comments = [...commentsXml.matchAll(/<w:comment w:id="(\d+)"([^>]*)>((?:(?!<\/w:comment>)[^])*)/g)]
    .map(([, id, attrs, xml]) => ({ id, attrs, paraId: /w14:paraId="(\w+)"/.exec(xml)?.[1] ?? '', text: texts(xml) }));
  return comments.map(c => {
    const parent = comments.find(p => p.paraId === parents.get(c.paraId));
    const range = body.split('<w:commentRangeStart w:id="' + c.id + '"/>')[1]?.split('<w:commentRangeEnd w:id="' + c.id + '"/>')[0] ?? '';
    const author = /w:author="([^"]*)"/.exec(c.attrs)?.[1];
    const date = /w:date="([^"]*)"/.exec(c.attrs)?.[1];
    return c.text + ' [' + texts(range) + ']' + (parent ? ' < ' + parent.text : '') + (author ? ' by ' + author : '') + (date ? ' at ' + date : '');
  }).sort();
}

describe('A comment on no text with replies written one after another', () => {
  // Import wrote it inline as {>>c<<}{>>r<<}, which export reads as two
  // comments on no text, so from the next export on the reply was a
  // comment of its own
  const body = '{#c2>>@B (2024-01-15 11:30) | c<<}{>>@C (2024-01-15 12:30) | r<<}';
  const containers: [string, (point: string, bodies: string) => string][] = [
    ['a paragraph', (p, b) => 'P ' + p + ' Q\n\n' + b],
    ['a list item', (p, b) => '- P ' + p + ' Q\n\n' + b],
    ['a quote', (p, b) => '> P ' + p + ' Q\n\n' + b],
    ['an alert', (p, b) => '> [!NOTE]\n> P ' + p + ' Q\n\n' + b],
    ['a heading', (p, b) => '# P ' + p + ' Q\n\n' + b],
    ['a note', (p, b) => 'T.[^1]\n\n[^1]: P ' + p + ' Q\n    ' + b],
    ['a table cell', (p, b) => '| h |\n| --- |\n| P ' + p + ' Q |\n\n' + b],
  ];
  const withoutDates = (comments: string[]) => comments.map(c => c.replace(/ at \S+$/, ''));

  /** Checks that `word`'s comments are `threads`, but their dates, and
   *  that import's Markdown gives Word the same comments, dates too, and
   *  comes back the same. Returns that Markdown */
  async function keepsComments(word: Uint8Array, threads: string[]): Promise<string> {
    const comments = await wordComments(word);
    expect(withoutDates(comments)).toEqual(threads);
    const imported = (await convertDocx(word)).markdown;
    const second = await convertMdToDocx(imported);
    expect(await wordComments(second.docx)).toEqual(comments);
    expect((await convertDocx(second.docx)).markdown).toBe(imported);
    return imported;
  }

  test.each(containers)('keeps its reply in %s', async (_name, wrap) => {
    await keepsComments((await convertMdToDocx(wrap('{#c2}{/c2}', body))).docx, ['c [] by B', 'r [] < c by C']);
  });

  const at = (md: string) => 'P ' + md + ' Q\n\n';
  test.each([
    ['two replies', at('{#c2}{/c2}') + body + '{>>@D (2024-01-15 13:30) | s<<}', ['c [] by B', 'r [] < c by C', 's [] < c by D']],
    ['no authors or dates', at('{#c2}{/c2}') + '{#c2>>c<<}{>>r<<}', ['c []', 'r [] < c']],
    ['authors and no dates', at('{#c2}{/c2}') + '{#c2>>@B | c<<}{>>@C | r<<}', ['c [] by B', 'r [] < c by C']],
    ['it at the paragraph\'s start', '{#c2}{/c2} P\n\n' + body, ['c [] by B', 'r [] < c by C']],
    ['it at the paragraph\'s end', 'P {#c2}{/c2}\n\n' + body, ['c [] by B', 'r [] < c by C']],
    ['it between letters', 'P{#c2}{/c2}Q\n\n' + body, ['c [] by B', 'r [] < c by C']],
    ['it after a range and a space', at('{#c1}t{/c1} {#c2}{/c2}') + '{#c1>>@A (2024-01-15 10:30) | a<<}\n' + body, ['a [t] by A', 'c [] by B', 'r [] < c by C']],
    ['another comment on no text after it', at('{#c2}{/c2}{#c3}{/c3}') + body + '\n{#c3>>@D (2024-01-15 13:30) | d<<}', ['c [] by B', 'd [] by D', 'r [] < c by C']],
    ['it in emphasis', at('**a {#c2}{/c2} b**') + body, ['c [] by B', 'r [] < c by C']],
    ['it in an addition', at('{++a {#c2}{/c2} b++}') + body, ['c [] by B', 'r [] < c by C']],
  ])('keeps its replies with %s', async (_name, md, threads) => {
    await keepsComments((await convertMdToDocx(md)).docx, threads);
  });

  test('writes it in ID syntax, with its body and replies after the paragraph', async () => {
    const md = 'P {#c2}{/c2} Q\n\n{#c2>>c<<}{>>r<<}';
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown).toBe('P {#c2}{/c2} Q\n{#c2>>c<<}{>>r<<}\n');
  });

  /** Word's document for `md`, export's, with comment c by B on no text and
   *  its reply r by C as Word writes them, the reply's parent in
   *  commentsExtended.xml, with Word's paraIds and no IDs export named, and
   *  where `consecutive`, the record export keeps of replies written one
   *  after another, which Word keeps with the document's other properties */
  async function inWord(md: string, consecutive: boolean): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const part = md.includes('[^1]:') ? 'word/footnotes.xml' : 'word/document.xml';
    expect(await zip.file(part)!.async('string')).toContain('<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id="0"/>');
    const comment = (id: string, author: string, date: string, paraId: string, text: string) => '<w:comment w:id="' + id + '" w:author="' + author
      + '" w:date="' + date + '" w:initials="' + author + '"><w:p w14:paraId="' + paraId + '" w14:textId="77777777"><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>'
      + '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r><w:r><w:t>' + text + '</w:t></w:r></w:p></w:comment>';
    zip.file('word/comments.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">'
      + comment('0', 'B', '2024-01-15T11:30:00Z', '3A1F0C01', 'c') + comment('1', 'C', '2024-01-15T12:30:00Z', '3A1F0C02', 'r') + '</w:comments>');
    zip.file('word/commentsExtended.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">'
      + '<w15:commentEx w15:paraId="3A1F0C01" w15:done="0"/><w15:commentEx w15:paraId="3A1F0C02" w15:paraIdParent="3A1F0C01" w15:done="0"/></w15:commentsEx>');
    const custom = await zip.file('docProps/custom.xml')!.async('string');
    const property = (name: string) => new RegExp('<property [^>]*name="' + name + '"[^>]*>(?:(?!</property>)[^])*</property>');
    expect(custom).toMatch(property('MANUSCRIPT_CONSECUTIVE_REPLY_COMMENTS'));
    const record = consecutive ? '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="MANUSCRIPT_CONSECUTIVE_REPLY_COMMENTS"><vt:lpwstr>3A1F0C01</vt:lpwstr></property>' : '';
    zip.file('docProps/custom.xml', custom.replace(property('MANUSCRIPT_CONSECUTIVE_REPLY_COMMENTS'), record).replace(property('MANUSCRIPT_COMMENT_IDS_\\d+'), ''));
    return zip.generateAsync({ type: 'uint8array' });
  }

  test.each(containers)('keeps the reply Word has to it in %s', async (_name, wrap) => {
    const imported = await keepsComments(await inWord(wrap('{#c2}{/c2}', body), true), ['c [] by B', 'r [] < c by C']);
    expect(imported).toMatch(/\{#1\}\{\/1\}[^]*\{#1>>@B \([^)]*\) \| c<<\}\{>>@C \([^)]*\) \| r<<\}/);
  });

  test.each(containers)('keeps Word\'s own reply to a comment on no text in %s, nested as before', async (_name, wrap) => {
    // With no record of the form, import nests it in the comment's body,
    // which export reads as its reply
    const imported = await keepsComments(await inWord(wrap('{#c2}{/c2}', body), false), ['c [] by B', 'r [] < c by C']);
    expect(imported).toMatch(/\| c\n[ >]*\{>>@C \([^)]*\) \| r<<\}\n[ >]*<<\}/);
  });

  test.each([
    ['a nested reply', 'P {>>@B (2024-01-15 11:30) | c\n  {>>@C (2024-01-15 12:30) | r<<}\n<<} Q'],
    ['no reply', 'P {>>@B (2024-01-15 11:30) | c<<} Q'],
    ['a comment on no text after it', 'P {>>@B (2024-01-15 11:30) | c<<}{>>@C (2024-01-15 12:30) | r<<} Q'],
    ['a range and a reply', 'P {==t==}{>>@B (2024-01-15 11:30) | c<<}{>>@C (2024-01-15 12:30) | r<<} Q'],
  ])('leaves a comment with %s as it was', async (_name, md) => {
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown).toBe(md + '\n');
  });

  /** `xml` with `pattern` replaced by `to`, where it's found */
  const edited = (pattern: RegExp | string, to: string) => (xml: string) => {
    expect(xml).toMatch(pattern);
    return xml.replace(pattern, to);
  };
  test.each([
    // The header row's two cells as one, which only an HTML table holds
    ['an HTML table\'s cell', '| P {#c2}{/c2} Q | i |\n| --- | --- |\n| y | z |\n\n' + body,
      edited(/(<w:tc><w:tcPr>)((?:(?!<\/w:tc>)[^])*?<\/w:tc>)<w:tc>(?:(?!<\/w:tc>)[^])*?<\/w:tc>/, '$1<w:gridSpan w:val="2"/>$2')],
    // The X out, so the paragraph starts with an HTML comment
    ['a paragraph that starts with an HTML comment', 'X<!-- h -->P {#c2}{/c2} Q\n\n' + body, edited('<w:r><w:t>X</w:t></w:r>', '')],
  ])('writes it in %s inline as before, where export reads ID syntax as text', async (_name, md, edit) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    zip.file('word/document.xml', edit(await zip.file('word/document.xml')!.async('string')));
    const imported = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(imported).toContain('P {>>@B (2024-01-15 11:30) | c<<}{>>@C (2024-01-15 12:30) | r<<} Q');
    expect(imported).not.toContain('{#');
  });
});

describe('Multi-level reply chain flattening', () => {
  test('deep reply chains are flattened to root parent', () => {
    const comments = new Map<string, Comment>([
      ['0', { author: 'Alice', text: 'Root', date: '', paraId: 'P001' }],
      ['1', { author: 'Bob', text: 'Reply to root', date: '', paraId: 'P002' }],
      ['2', { author: 'Carol', text: 'Reply to reply', date: '', paraId: 'P003' }],
    ]);

    // P002 → P001 (Bob replies to Alice)
    // P003 → P002 (Carol replies to Bob — deeper chain)
    const threads = new Map<string, string>([
      ['P002', 'P001'],
      ['P003', 'P002'],
    ]);

    const replyIds = groupCommentThreads(comments, threads);

    // Both Bob and Carol should be reply IDs
    expect(replyIds.has('1')).toBe(true);
    expect(replyIds.has('2')).toBe(true);

    // Root comment should have both replies flattened
    const root = comments.get('0')!;
    expect(root.replies).toBeDefined();
    expect(root.replies!.length).toBe(2);
    expect(root.replies!.some(r => r.text === 'Reply to root')).toBe(true);
    expect(root.replies!.some(r => r.text === 'Reply to reply')).toBe(true);
  });
});

describe('No-reply regression', () => {
  test('comments without replies produce standard format', () => {
    const comments = new Map<string, Comment>([
      ['1', { author: 'Alice', text: 'Simple comment', date: '2024-01-15T14:30:00Z' }],
    ]);
    const content = [
      { type: 'para' as const },
      {
        type: 'text' as const,
        text: 'Hello world',
        commentIds: new Set(['1']),
        formatting: DEFAULT_FORMATTING,
      },
    ];
    const md = buildMarkdown(content, comments);
    // Should use traditional inline syntax since no overlapping
    expect(md).toContain('{==Hello world==}');
    expect(md).toContain('{>>@Alice');
    expect(md).toContain('<<}');
    // Should NOT have nested reply pattern
    expect(md).not.toContain('\n  {>>');
  });
});

describe('Real-world multi-thread comment export (no duplicates, threaded replies)', () => {
  // Threads modeled on user's manuscript patterns
  const md = [
    // Thread 1: simple highlight + comment with 1 reply
    '{==goals ==}{>>@Megan Kavanaugh (2025-12-10 10:18) | reproductive goals?',
    '  {>>@Jonathan Bearak (2026-03-02 11:54) | Life goals is broader than reproductive goals.<<}',
    '<<}',
    '',
    // Thread 2: highlight + comment with 2 replies
    '{==Typical-person==}{>>@Megan Kavanaugh (2025-12-10 10:38) | similar to comment in the abstract',
    '  {>>@Kathryn Kost (2026-03-01 02:04) | See if this works.<<}',
    '  {>>@Jonathan Bearak (2026-03-03 04:21) | I appreciate the attempt to address this comment here.<<}',
    '<<}',
    '',
    // Thread 3: highlight with track changes inside + comment with 2 replies
    '{==Our model simultaneously fits {--the probabilities of abortion--}{++the monthly probability of conceiving a pregnancy ending in abortion++} to both data sources==}{>>@Isaac Maddow-Zimet (2025-12-12 11:16) | What is this probability referring to?',
    '  {>>@Kathryn Kost (2026-03-01 02:45) | If IMZ language is correct, put it in.<<}',
    '  {>>@Jonathan Bearak (2026-03-03 08:18) | Revised to clarify.<<}',
    '<<}',
    '',
    // Thread 4: simple highlight + comment with 1 reply
    '{==abortions==}{>>@Isaac Maddow-Zimet (2025-12-15 05:10) | Why are we bounding the uniform prior at 0.01?',
    '  {>>@Kathryn Kost (2026-03-01 07:06) | Add explanatory sentence here.<<}',
    '<<}',
  ].join('\n');

  test('produces exactly 10 comments (4 parents + 6 replies), no duplicates', async () => {
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);

    const commentsXml = await zip.file('word/comments.xml')!.async('string');
    const commentMatches = commentsXml.match(/w:comment /g) || [];
    expect(commentMatches.length).toBe(10);

    // No duplicate comment IDs
    const idMatches = [...commentsXml.matchAll(/w:comment [^>]*w:id="(\d+)"/g)];
    const ids = idMatches.map(m => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all replies are threaded (have paraIdParent in commentsExtended.xml)', async () => {
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);

    const extXml = await zip.file('word/commentsExtended.xml')!.async('string');
    // 6 replies should have paraIdParent
    const parentMatches = extXml.match(/w15:paraIdParent/g) || [];
    expect(parentMatches.length).toBe(6);

    // 10 total commentEx entries (4 parents + 6 replies)
    const exMatches = extXml.match(/w15:commentEx /g) || [];
    expect(exMatches.length).toBe(10);
  });

  test('reply comment anchors in document.xml match allocated reply IDs', async () => {
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);

    const commentsXml = await zip.file('word/comments.xml')!.async('string');
    const docXml = await zip.file('word/document.xml')!.async('string');

    // Extract all comment IDs from comments.xml
    const commentIds = [...commentsXml.matchAll(/w:comment [^>]*w:id="(\d+)"/g)].map(m => m[1]);

    // Every comment ID should have a commentReference in document.xml
    for (const id of commentIds) {
      expect(docXml).toContain('w:commentReference w:id="' + id + '"');
    }
  });
});
