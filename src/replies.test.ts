import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
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
    const parser = new XMLParser({
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
