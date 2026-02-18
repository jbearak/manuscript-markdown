import { describe, test, expect } from 'bun:test';
import {
  buildMarkdown,
  convertDocx,
  DEFAULT_FORMATTING,
  formatLocalIsoMinute,
} from './converter';
import {
  parseMd,
  convertMdToDocx,
  type DocxGenState,
} from './md-to-docx';
import { generateRuns } from './md-to-docx';
import { preprocessCriticMarkup } from './critic-markup';

function makeState(): DocxGenState {
  return {
    commentId: 0,
    comments: [],
    commentIdMap: new Map(),
    relationships: new Map(),
    nextRId: 1,
    rIdOffset: 5,
    warnings: [],
    hasList: false,
    hasComments: false,
    missingKeys: new Set(),
    replyRanges: [],
  };
}

describe('Overlapping comments: docx-to-md (buildMarkdown)', () => {
  test('non-overlapping comments use traditional syntax', () => {
    const comments = new Map([
      ['c1', { author: 'alice', text: 'comment 1', date: '' }],
    ]);
    const content = [
      {
        type: 'text' as const,
        text: 'hello',
        commentIds: new Set(['c1']),
        formatting: DEFAULT_FORMATTING,
      },
    ];
    const result = buildMarkdown(content, comments);
    expect(result).toContain('{==hello==}');
    expect(result).toContain('{>>alice: comment 1<<}');
    expect(result).not.toContain('{#');
    expect(result).not.toContain('{/');
  });

  test('overlapping comments use ID-based syntax', () => {
    const comments = new Map([
      ['c1', { author: 'alice', text: 'comment 1', date: '' }],
      ['c2', { author: 'bob', text: 'comment 2', date: '' }],
    ]);
    // Simulate overlapping: "AABB" where AA has c1, BB has c1+c2
    const content = [
      {
        type: 'text' as const,
        text: 'AA',
        commentIds: new Set(['c1']),
        formatting: DEFAULT_FORMATTING,
      },
      {
        type: 'text' as const,
        text: 'BB',
        commentIds: new Set(['c1', 'c2']),
        formatting: DEFAULT_FORMATTING,
      },
    ];
    const result = buildMarkdown(content, comments);
    // Should use ID-based syntax (IDs remapped to 1-indexed)
    expect(result).toContain('{#1}');
    expect(result).toContain('{#2}');
    expect(result).toContain('{/1}');
    expect(result).toContain('{/2}');
    // Comment bodies deferred after paragraph text
    expect(result).toContain('{#1>>alice: comment 1<<}');
    expect(result).toContain('{#2>>bob: comment 2<<}');
    // Should NOT use traditional syntax
    expect(result).not.toContain('{==');
  });

  test('overlapping comments with text before, between, and after', () => {
    const comments = new Map([
      ['1', { author: 'alice', text: 'comment 1', date: '' }],
      ['2', { author: 'bob', text: 'comment 2', date: '' }],
    ]);
    // "before {#1}A {#2}B{/2} C{/1} after"
    const content = [
      { type: 'para' as const },
      {
        type: 'text' as const,
        text: 'before ',
        commentIds: new Set<string>(),
        formatting: DEFAULT_FORMATTING,
      },
      {
        type: 'text' as const,
        text: 'A ',
        commentIds: new Set(['1']),
        formatting: DEFAULT_FORMATTING,
      },
      {
        type: 'text' as const,
        text: 'B',
        commentIds: new Set(['1', '2']),
        formatting: DEFAULT_FORMATTING,
      },
      {
        type: 'text' as const,
        text: ' C',
        commentIds: new Set(['1']),
        formatting: DEFAULT_FORMATTING,
      },
      {
        type: 'text' as const,
        text: ' after',
        commentIds: new Set<string>(),
        formatting: DEFAULT_FORMATTING,
      },
    ];
    const result = buildMarkdown(content, comments);
    expect(result).toContain('before ');
    expect(result).toContain('{#1}');
    expect(result).toContain('A ');
    expect(result).toContain('{#2}');
    expect(result).toContain('B');
    expect(result).toContain('{/2}');
    expect(result).toContain(' C');
    expect(result).toContain('{/1}');
    expect(result).toContain(' after');
  });

  test('alwaysUseCommentIds forces ID syntax for non-overlapping', () => {
    const comments = new Map([
      ['c1', { author: 'alice', text: 'note', date: '' }],
    ]);
    const content = [
      {
        type: 'text' as const,
        text: 'hello',
        commentIds: new Set(['c1']),
        formatting: DEFAULT_FORMATTING,
      },
    ];
    const result = buildMarkdown(content, comments, { alwaysUseCommentIds: true });
    // ID "c1" remapped to "1"
    expect(result).toContain('{#1}');
    expect(result).toContain('hello');
    expect(result).toContain('{/1}');
    expect(result).toContain('{#1>>alice: note<<}');
    expect(result).not.toContain('{==');
  });

  test('comment bodies include date when present', () => {
    const comments = new Map([
      ['c1', { author: 'alice', text: 'note', date: '2024-01-15T14:30:00Z' }],
      ['c2', { author: 'bob', text: 'reply', date: '2024-01-15T14:31:00Z' }],
    ]);
    const content = [
      {
        type: 'text' as const,
        text: 'A',
        commentIds: new Set(['c1']),
        formatting: DEFAULT_FORMATTING,
      },
      {
        type: 'text' as const,
        text: 'B',
        commentIds: new Set(['c1', 'c2']),
        formatting: DEFAULT_FORMATTING,
      },
    ];
    const result = buildMarkdown(content, comments);
    const date1 = formatLocalIsoMinute('2024-01-15T14:30:00Z');
    const date2 = formatLocalIsoMinute('2024-01-15T14:31:00Z');
    // IDs remapped to 1-indexed
    expect(result).toContain(`{#1>>alice (${date1}): note<<}`);
    expect(result).toContain(`{#2>>bob (${date2}): reply<<}`);
  });

  test('highlight formatting is stripped in ID-based mode', () => {
    const comments = new Map([
      ['c1', { author: 'alice', text: 'note', date: '' }],
      ['c2', { author: 'bob', text: 'reply', date: '' }],
    ]);
    const content = [
      {
        type: 'text' as const,
        text: 'highlighted',
        commentIds: new Set(['c1']),
        formatting: { ...DEFAULT_FORMATTING, highlight: true },
      },
      {
        type: 'text' as const,
        text: ' both',
        commentIds: new Set(['c1', 'c2']),
        formatting: { ...DEFAULT_FORMATTING, highlight: true },
      },
    ];
    const result = buildMarkdown(content, comments);
    // In ID mode, highlight should be stripped (it was just for Word's comment indication)
    expect(result).not.toContain('{==');
    expect(result).toContain('highlighted');
    expect(result).toContain(' both');
  });

  test('table-only comments are remapped to 1-indexed IDs', () => {
    const comments = new Map([
      ['47', { author: 'alice', text: 'table note', date: '' }],
    ]);
    const content = [
      {
        type: 'table' as const,
        rows: [
          {
            isHeader: false,
            cells: [
              {
                paragraphs: [[
                  {
                    type: 'text' as const,
                    text: 'cell text',
                    commentIds: new Set(['47']),
                    formatting: DEFAULT_FORMATTING,
                  },
                ]],
              },
            ],
          },
        ],
      },
    ];

    const result = buildMarkdown(content as any, comments, { alwaysUseCommentIds: true });
    expect(result).toContain('{#1}cell text{/1}');
    expect(result).toContain('{#1>>alice: table note<<}');
    expect(result).not.toContain('{#47}');
    expect(result).not.toContain('{/47}');
    expect(result).not.toContain('{#47>>');
  });

  test('comment spanning paragraphs uses consistent ID syntax when it overlaps elsewhere', () => {
    const comments = new Map([
      ['a', { author: 'alice', text: 'note A', date: '' }],
      ['b', { author: 'bob', text: 'note B', date: '' }],
    ]);
    const content = [
      { type: 'para' as const },
      {
        type: 'text' as const,
        text: 'p1 ',
        commentIds: new Set(['a']),
        formatting: DEFAULT_FORMATTING,
      },
      { type: 'para' as const },
      {
        type: 'text' as const,
        text: 'p2',
        commentIds: new Set(['a', 'b']),
        formatting: DEFAULT_FORMATTING,
      },
    ];

    const result = buildMarkdown(content as any, comments);
    expect(result).toContain('{#1}p1 {/1}');
    expect(result).toContain('{#1}{#2}p2{/1}{/2}');
    expect(result).toContain('{#1>>alice: note A<<}');
    expect(result).toContain('{#2>>bob: note B<<}');
    expect(result).not.toContain('{>>alice: note A<<}');
    expect((result.match(/alice: note A/g) || []).length).toBe(1);
  });

  test('mapped IDs are reused and new unmapped IDs get non-colliding numeric IDs', () => {
    const comments = new Map([
      ['0', { author: 'alice', text: 'mapped', date: '' }],
      ['5', { author: 'bob', text: 'new from word', date: '' }],
    ]);
    const content = [
      { type: 'text' as const, text: 'A', commentIds: new Set(['0']), formatting: DEFAULT_FORMATTING },
      { type: 'text' as const, text: 'B', commentIds: new Set(['5']), formatting: DEFAULT_FORMATTING },
      { type: 'text' as const, text: 'C', commentIds: new Set(['0', '5']), formatting: DEFAULT_FORMATTING },
    ];
    const result = buildMarkdown(content, comments, {
      commentIdMapping: new Map([['0', 'intro-note']]),
    });
    expect(result).toContain('{#intro-note}');
    expect(result).toContain('{/intro-note}');
    expect(result).toContain('{#1}');
    expect(result).toContain('{/1}');
    expect(result).toContain('{#intro-note>>alice: mapped<<}');
    expect(result).toContain('{#1>>bob: new from word<<}');
  });
});

describe('Overlapping comments: md-to-docx (parseMd)', () => {
  test('parses {#id} range start marker', () => {
    const tokens = parseMd('text {#1}marked{/1}{#1>>alice: note<<}');
    const runs = tokens[0]?.runs;
    expect(runs).toBeDefined();
    const rangeStart = runs!.find(r => r.type === 'comment_range_start');
    expect(rangeStart).toBeDefined();
    expect(rangeStart!.commentId).toBe('1');
  });

  test('parses {/id} range end marker', () => {
    const tokens = parseMd('text {#1}marked{/1}{#1>>alice: note<<}');
    const runs = tokens[0]?.runs;
    const rangeEnd = runs!.find(r => r.type === 'comment_range_end');
    expect(rangeEnd).toBeDefined();
    expect(rangeEnd!.commentId).toBe('1');
  });

  test('parses {#id>>...<<} comment body with ID', () => {
    const tokens = parseMd('{#myid>>alice (2024-01-15T14:30): This is a comment<<}');
    const runs = tokens[0]?.runs;
    const body = runs!.find(r => r.type === 'comment_body_with_id');
    expect(body).toBeDefined();
    expect(body!.commentId).toBe('myid');
    expect(body!.author).toBe('alice');
    expect(body!.date).toBe('2024-01-15T14:30');
    expect(body!.commentText).toBe('This is a comment');
  });

  test('parses alphanumeric IDs with hyphens and underscores', () => {
    const tokens = parseMd('{#my-id_123}text{/my-id_123}{#my-id_123>>note<<}');
    const runs = tokens[0]?.runs;
    const start = runs!.find(r => r.type === 'comment_range_start');
    const end = runs!.find(r => r.type === 'comment_range_end');
    const body = runs!.find(r => r.type === 'comment_body_with_id');
    expect(start!.commentId).toBe('my-id_123');
    expect(end!.commentId).toBe('my-id_123');
    expect(body!.commentId).toBe('my-id_123');
  });

  test('overlapping comment syntax parsed alongside regular text', () => {
    const md = 'This is {#1}first {#2}second{/2} third{/1}\n\n{#1>>alice: comment 1<<}\n\n{#2>>bob: comment 2<<}';
    const tokens = parseMd(md);
    const firstParaRuns = tokens[0]?.runs;
    expect(firstParaRuns).toBeDefined();

    const starts = firstParaRuns!.filter(r => r.type === 'comment_range_start');
    const ends = firstParaRuns!.filter(r => r.type === 'comment_range_end');
    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);
  });
});

describe('Overlapping comments: OOXML generation', () => {
  test('comment_range_start generates commentRangeStart XML', () => {
    const state = makeState();
    const runs = [
      { type: 'comment_range_start' as const, text: '', commentId: 'abc' },
      { type: 'text' as const, text: 'content' },
      { type: 'comment_range_end' as const, text: '', commentId: 'abc' },
      { type: 'comment_body_with_id' as const, text: '', commentId: 'abc', author: 'alice', commentText: 'note' },
    ];
    const xml = generateRuns(runs, state);
    expect(xml).toContain('<w:commentRangeStart w:id="0"/>');
    expect(xml).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(xml).toContain('<w:commentReference w:id="0"/>');
    expect(state.comments.length).toBe(1);
    expect(state.comments[0].author).toBe('alice');
    expect(state.comments[0].text).toBe('note');
    expect(state.hasComments).toBe(true);
  });

  test('multiple overlapping comments get unique numeric IDs', () => {
    const state = makeState();
    const runs = [
      { type: 'comment_range_start' as const, text: '', commentId: '1' },
      { type: 'comment_range_start' as const, text: '', commentId: '2' },
      { type: 'text' as const, text: 'overlap' },
      { type: 'comment_range_end' as const, text: '', commentId: '2' },
      { type: 'comment_range_end' as const, text: '', commentId: '1' },
      { type: 'comment_body_with_id' as const, text: '', commentId: '1', author: 'a', commentText: 'c1' },
      { type: 'comment_body_with_id' as const, text: '', commentId: '2', author: 'b', commentText: 'c2' },
    ];
    const xml = generateRuns(runs, state);
    expect(xml).toContain('<w:commentRangeStart w:id="0"/>');
    expect(xml).toContain('<w:commentRangeStart w:id="1"/>');
    expect(xml).toContain('<w:commentRangeEnd w:id="1"/>');
    expect(xml).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(state.comments.length).toBe(2);
  });

  test('same markdown ID maps to same numeric ID across range markers and body', () => {
    const state = makeState();
    const runs = [
      { type: 'comment_range_start' as const, text: '', commentId: 'foo' },
      { type: 'text' as const, text: 'text' },
      { type: 'comment_range_end' as const, text: '', commentId: 'foo' },
      { type: 'comment_body_with_id' as const, text: '', commentId: 'foo', author: 'alice', commentText: 'note' },
    ];
    generateRuns(runs, state);
    // All three should map to the same numeric ID
    const numericId = state.commentIdMap.get('foo');
    expect(numericId).toBe(0);
    expect(state.comments[0].id).toBe(0);
  });
});

describe('Overlapping comments: preprocessing', () => {
  test('preprocessCriticMarkup handles {#id>>...<<} with paragraph breaks', () => {
    const input = '{#1>>alice: first\n\nsecond<<}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
    expect(result).toContain('{#1>>');
    expect(result).toContain('<<}');
  });
});

describe('Overlapping comments: round-trip', () => {
  test('non-overlapping comments round-trip through md-to-docx', async () => {
    const md = '{==highlighted==}{>>alice: note<<}';
    const result = await convertMdToDocx(md, { authorName: 'test' });
    expect(result.docx).toBeDefined();
    expect(result.docx.length).toBeGreaterThan(0);
  });

  test('ID-based comments produce valid DOCX', async () => {
    const md = '{#1}text{/1}{#1>>alice: note<<}';
    const result = await convertMdToDocx(md, { authorName: 'test' });
    expect(result.docx).toBeDefined();
    expect(result.docx.length).toBeGreaterThan(0);
  });

  test('overlapping ID-based comments produce valid DOCX', async () => {
    const md = '{#1}first {#2}overlap{/2} last{/1}\n\n{#1>>alice: comment one<<}\n\n{#2>>bob: comment two<<}';
    const result = await convertMdToDocx(md, { authorName: 'test' });
    expect(result.docx).toBeDefined();
    expect(result.docx.length).toBeGreaterThan(0);
  });

  test('preserves non-numeric comment IDs through md→docx→md', async () => {
    const md = '{#intro-note}A {#second-note}B{/second-note} C{/intro-note}\n\n{#intro-note>>alice: first<<}\n\n{#second-note>>bob: second<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const roundtrip = await convertDocx(docx);
    expect(roundtrip.markdown).toContain('{#intro-note}');
    expect(roundtrip.markdown).toContain('{/intro-note}');
    expect(roundtrip.markdown).toContain('{#second-note}');
    expect(roundtrip.markdown).toContain('{/second-note}');
    expect(roundtrip.markdown).toContain('{#intro-note>>alice');
    expect(roundtrip.markdown).toContain('first<<}');
    expect(roundtrip.markdown).toContain('{#second-note>>bob');
    expect(roundtrip.markdown).toContain('second<<}');
  });

  test('preserves overlapping non-numeric IDs through md→docx→md', async () => {
    const md = '{#intro-note}A {#conclusion-remark}B{/conclusion-remark} C{/intro-note}\n\n{#intro-note>>alice: first<<}\n\n{#conclusion-remark>>bob: second<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const roundtrip = await convertDocx(docx);
    expect(roundtrip.markdown).toContain('{#intro-note}');
    expect(roundtrip.markdown).toContain('{#conclusion-remark}');
    expect(roundtrip.markdown).toContain('{/intro-note}');
    expect(roundtrip.markdown).toContain('{/conclusion-remark}');
    expect(roundtrip.markdown).toContain('{#intro-note>>alice');
    expect(roundtrip.markdown).toContain('first<<}');
    expect(roundtrip.markdown).toContain('{#conclusion-remark>>bob');
    expect(roundtrip.markdown).toContain('second<<}');
  });

  test('falls back to numeric IDs when mapping custom property is missing', async () => {
    const md = '{#intro-note}A {#second-note}B{/second-note} C{/intro-note}\n\n{#intro-note>>alice: first<<}\n\n{#second-note>>bob: second<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    zip.remove('docProps/custom.xml');
    const noMappingDocx = await zip.generateAsync({ type: 'uint8array' });
    const roundtrip = await convertDocx(noMappingDocx);
    expect(roundtrip.markdown).toContain('{#1}');
    expect(roundtrip.markdown).toContain('{/1}');
    expect(roundtrip.markdown).toContain('{#2}');
    expect(roundtrip.markdown).toContain('{/2}');
    expect(roundtrip.markdown).toContain('{#1>>alice');
    expect(roundtrip.markdown).toContain('{#2>>bob');
    expect(roundtrip.markdown).not.toContain('{#intro-note}');
  });

  test('stores comment ID mapping in docProps/custom.xml', async () => {
    const md = '{#intro-note}text{/intro-note}\n\n{#intro-note>>alice: note<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    expect(customXml).toBeDefined();
    expect(customXml || '').toContain('MANUSCRIPT_COMMENT_IDS_1');
    expect(customXml || '').toContain('&quot;0&quot;:&quot;intro-note&quot;');
  });
});

describe('Overlapping comments: CLI config', () => {
  test('parseArgs accepts --always-use-comment-ids flag', () => {
    const { parseArgs } = require('./cli');
    const opts = parseArgs(['node', 'cli', 'input.docx', '--always-use-comment-ids']);
    expect(opts.alwaysUseCommentIds).toBe(true);
  });

  test('parseArgs defaults alwaysUseCommentIds to false', () => {
    const { parseArgs } = require('./cli');
    const opts = parseArgs(['node', 'cli', 'input.docx']);
    expect(opts.alwaysUseCommentIds).toBe(false);
  });
});
