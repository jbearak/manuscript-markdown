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
    listStartOverrides: [],
    hasComments: false,
    missingKeys: new Set(),
    replyRanges: [],
    nextParaId: 1,
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
    expect(result).toContain('{>>@alice | comment 1<<}');
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
    expect(result).toContain('{#1>>@alice | comment 1<<}');
    expect(result).toContain('{#2>>@bob | comment 2<<}');
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
    expect(result).toContain('{#1>>@alice | note<<}');
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
    expect(result).toContain(`{#1>>@alice (${date1}) | note<<}`);
    expect(result).toContain(`{#2>>@bob (${date2}) | reply<<}`);
  });

  test('highlight formatting is preserved in ID-based mode', () => {
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
    expect(result).toContain('==highlighted==');
    expect(result).toContain('== both==');
  });

  test('highlighted text inside non-overlapping comment produces {====text====}', () => {
    const comments = new Map([
      ['c1', { author: 'alice', text: 'note', date: '' }],
    ]);
    const content = [
      {
        type: 'text' as const,
        text: 'text',
        commentIds: new Set(['c1']),
        formatting: { ...DEFAULT_FORMATTING, highlight: true },
      },
    ];
    const result = buildMarkdown(content, comments);
    expect(result).toContain('{====text====}');
    expect(result).toContain('{>>@alice | note<<}');
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
    expect(result).toContain('{#1>>@alice | table note<<}');
    expect(result).not.toContain('{#47}');
    expect(result).not.toContain('{/47}');
    expect(result).not.toContain('{#47>>');
  });

  test('comment spanning paragraphs keeps one ID range when it overlaps elsewhere', () => {
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
    // Not closed at the end of the first paragraph and opened again
    expect(result).toContain('{#1}p1\n\n{#2}p2{/1}{/2}');
    expect((result.match(/\{#1\}/g) || []).length).toBe(1);
    expect(result).toContain('{#1>>@alice | note A<<}');
    expect(result).toContain('{#2>>@bob | note B<<}');
    expect(result).not.toContain('{>>@alice | note A<<}');
    expect((result.match(/@alice \| note A/g) || []).length).toBe(1);
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
    expect(result).toContain('{#intro-note>>@alice | mapped<<}');
    expect(result).toContain('{#1>>@bob | new from word<<}');
  });
});

describe('Overlapping comments: md-to-docx (parseMd)', () => {
  test('parses {#id} range start marker', () => {
    const tokens = parseMd('text {#1}marked{/1}{#1>>@alice | note<<}');
    const runs = tokens[0]?.runs;
    expect(runs).toBeDefined();
    const rangeStart = runs!.find(r => r.type === 'comment_range_start');
    expect(rangeStart).toBeDefined();
    expect(rangeStart!.commentId).toBe('1');
  });

  test('parses {/id} range end marker', () => {
    const tokens = parseMd('text {#1}marked{/1}{#1>>@alice | note<<}');
    const runs = tokens[0]?.runs;
    const rangeEnd = runs!.find(r => r.type === 'comment_range_end');
    expect(rangeEnd).toBeDefined();
    expect(rangeEnd!.commentId).toBe('1');
  });

  test('parses {#id>>...<<} comment body with ID', () => {
    const tokens = parseMd('{#myid>>@alice (2024-01-15T14:30) | This is a comment<<}');
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
    const md = 'This is {#1}first {#2}second{/2} third{/1}\n\n{#1>>@alice | comment 1<<}\n\n{#2>>@bob | comment 2<<}';
    const tokens = parseMd(md);
    const firstParaRuns = tokens[0]?.runs;
    expect(firstParaRuns).toBeDefined();

    const starts = firstParaRuns!.filter(r => r.type === 'comment_range_start');
    const ends = firstParaRuns!.filter(r => r.type === 'comment_range_end');
    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);
  });

  test('{====text====} parses as critic_highlight with highlight=true', () => {
    const tokens = parseMd('{====text====}{>>@alice | note<<}');
    const runs = tokens[0]?.runs;
    expect(runs).toBeDefined();
    const hl = runs!.find(r => r.type === 'critic_highlight' && r.text === 'text');
    expect(hl).toBeDefined();
    expect(hl!.highlight).toBe(true);
  });

  test('{====text=={green}==} parses as critic_highlight with highlight and color', () => {
    const tokens = parseMd('{====text=={green}==}{>>@alice | note<<}');
    const runs = tokens[0]?.runs;
    expect(runs).toBeDefined();
    const hl = runs!.find(r => r.type === 'critic_highlight' && r.text === 'text');
    expect(hl).toBeDefined();
    expect(hl!.highlight).toBe(true);
    expect(hl!.highlightColor).toBe('green');
  });

  test('=={==text==}== parses as critic_highlight with highlight=true', () => {
    const tokens = parseMd('=={==text==}==');
    const runs = tokens[0]?.runs;
    expect(runs).toBeDefined();
    const hl = runs!.find(r => r.type === 'critic_highlight' && r.text === 'text');
    expect(hl).toBeDefined();
    expect(hl!.highlight).toBe(true);
  });

  test('=={==text==}=={green} parses as critic_highlight with highlight and color', () => {
    const tokens = parseMd('=={==text==}=={green}');
    const runs = tokens[0]?.runs;
    expect(runs).toBeDefined();
    const hl = runs!.find(r => r.type === 'critic_highlight' && r.text === 'text');
    expect(hl).toBeDefined();
    expect(hl!.highlight).toBe(true);
    expect(hl!.highlightColor).toBe('green');
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
    const input = '{#1>>@alice | first\n\nsecond<<}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
    expect(result).toContain('{#1>>');
    expect(result).toContain('<<}');
  });
});

describe('Overlapping comments: round-trip', () => {
  test('non-overlapping comments round-trip through md-to-docx', async () => {
    const md = '{==highlighted==}{>>@alice | note<<}';
    const result = await convertMdToDocx(md, { authorName: 'test' });
    expect(result.docx).toBeDefined();
    expect(result.docx.length).toBeGreaterThan(0);
  });

  test('ID-based comments produce valid DOCX', async () => {
    const md = '{#1}text{/1}{#1>>@alice | note<<}';
    const result = await convertMdToDocx(md, { authorName: 'test' });
    expect(result.docx).toBeDefined();
    expect(result.docx.length).toBeGreaterThan(0);
  });

  test('overlapping ID-based comments produce valid DOCX', async () => {
    const md = '{#1}first {#2}overlap{/2} last{/1}\n\n{#1>>@alice | comment one<<}\n\n{#2>>@bob | comment two<<}';
    const result = await convertMdToDocx(md, { authorName: 'test' });
    expect(result.docx).toBeDefined();
    expect(result.docx.length).toBeGreaterThan(0);
  });

  test('preserves non-numeric comment IDs through md→docx→md', async () => {
    const md = '{#intro-note}A {#second-note}B{/second-note} C{/intro-note}\n\n{#intro-note>>@alice | first<<}\n\n{#second-note>>@bob | second<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const roundtrip = await convertDocx(docx);
    expect(roundtrip.markdown).toContain('{#intro-note}');
    expect(roundtrip.markdown).toContain('{/intro-note}');
    expect(roundtrip.markdown).toContain('{#second-note}');
    expect(roundtrip.markdown).toContain('{/second-note}');
    expect(roundtrip.markdown).toContain('{#intro-note>>@alice | first<<}');
    expect(roundtrip.markdown).toContain('{#second-note>>@bob | second<<}');
  });

  test('preserves overlapping non-numeric IDs through md→docx→md', async () => {
    const md = '{#intro-note}A {#conclusion-remark}B{/conclusion-remark} C{/intro-note}\n\n{#intro-note>>@alice | first<<}\n\n{#conclusion-remark>>@bob | second<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const roundtrip = await convertDocx(docx);
    expect(roundtrip.markdown).toContain('{#intro-note}');
    expect(roundtrip.markdown).toContain('{#conclusion-remark}');
    expect(roundtrip.markdown).toContain('{/intro-note}');
    expect(roundtrip.markdown).toContain('{/conclusion-remark}');
    expect(roundtrip.markdown).toContain('{#intro-note>>@alice | first<<}');
    expect(roundtrip.markdown).toContain('{#conclusion-remark>>@bob | second<<}');
  });

  test('falls back to numeric IDs when mapping custom property is missing', async () => {
    const md = '{#intro-note}A {#second-note}B{/second-note} C{/intro-note}\n\n{#intro-note>>@alice | first<<}\n\n{#second-note>>@bob | second<<}';
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
    expect(roundtrip.markdown).toContain('{#1>>@alice | first<<}');
    expect(roundtrip.markdown).toContain('{#2>>@bob | second<<}');
    expect(roundtrip.markdown).not.toContain('{#intro-note}');
  });

  test('stores comment ID mapping in docProps/custom.xml', async () => {
    const md = '{#intro-note}text{/intro-note}\n\n{#intro-note>>@alice | note<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    expect(customXml).toBeDefined();
    expect(customXml || '').toContain('MANUSCRIPT_COMMENT_IDS_1');
    const rawValue = (customXml || '').match(/name="MANUSCRIPT_COMMENT_IDS_1"[\s\S]*?<vt:lpwstr>([^<]*)<\/vt:lpwstr>/);
    expect(rawValue).not.toBeNull();
    const parsed = JSON.parse(rawValue![1]);
    expect(parsed['0']).toBe('intro-note');
  });

  test('{====text====} round-trips with highlighted text in comment', async () => {
    const md = '{====text====}{>>@alice | note<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const roundtrip = await convertDocx(docx);
    expect(roundtrip.markdown).toContain('{====text====}');
  });

  test.each([
    ['of two colors', '{====a=={red}==b====}'],
    ['of another color after', '{====a=={yellow}==b=={red}==}'],
    ['with text between them', '{====a== b ==c====}'],
    ['after text', '{==a ==b====}'],
  ])('keeps highlights side by side in a comment\'s text %s', async (_name, anchor) => {
    // Export took its first == and last for one highlight around all of
    // it, and the == between for another's, so ==a=={red}==b== was a
    // yellow a{red}b
    const { docx } = await convertMdToDocx(anchor + '{>>@alice | note<<}', { authorName: 'test' });
    expect((await convertDocx(docx)).markdown).toContain(anchor + '{>>@alice');
  });

  test('{==text==} without inner highlight round-trips without double-wrapping', async () => {
    const md = '{==text==}{>>@alice | note<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const roundtrip = await convertDocx(docx);
    // Should NOT produce {====text====} — the {==...==} is comment syntax, not a highlight
    expect(roundtrip.markdown).toContain('{==text==}');
    expect(roundtrip.markdown).not.toContain('{====text====}');
  });

  test('=={==text==}== round-trips as highlighted text', async () => {
    const md = '=={==text==}==';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const roundtrip = await convertDocx(docx);
    expect(roundtrip.markdown).toContain('==text==');
  });

  test('consecutive {>>...<<} blocks are threaded as parent-reply', async () => {
    const md = '{==text==}{>>@alice (2024-01-01 00:00) | parent note<<}{>>@bob (2024-01-02 00:00) | reply note<<}';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const roundtrip = await convertDocx(docx);
    expect(roundtrip.markdown).toContain('parent note');
    expect(roundtrip.markdown).toContain('reply note');
    // Reply should be nested inside the parent comment block
    expect(roundtrip.markdown).toContain('{>>@alice');
    expect(roundtrip.markdown).toMatch(/\{>>@bob.*reply note/);
  });

  test('standalone {>>comment<<} round-trips without anchor', async () => {
    const md = 'Before.\n\n{>>@alice (2024-01-01 00:00) | standalone note<<}\n\nAfter.';
    const { docx } = await convertMdToDocx(md, { authorName: 'test' });
    const roundtrip = await convertDocx(docx);
    expect(roundtrip.markdown).toContain('{>>');
    expect(roundtrip.markdown).toContain('standalone note');
    expect(roundtrip.markdown).not.toContain('{====}');
  });
});

describe('Overlapping comments: where the bodies go', () => {
  const seen = 'Seen {#1}a {#2}b{/1} c{/2} on.';
  const bodies = '{#1>>one<<}\n{#2>>two<<}';
  async function imported(md: string): Promise<string> {
    const { docx } = await convertMdToDocx(md);
    return (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  }

  test.each([
    ['on the lines after the paragraph', seen + '\n' + bodies, seen + '\n' + bodies],
    ['in a paragraph of their own', seen + '\n\n{#1>>one<<}\n\n{#2>>two<<}', seen + '\n' + bodies],
    ['at the end of the line', seen + ' {#1>>one<<} {#2>>two<<}', seen + '\n' + bodies],
    ['at the start of the line', '{#1>>one<<} ' + seen + '\n{#2>>two<<}', seen + '\n' + bodies],
    ['at the end of the line in a range', '{#2}{#1}x{/1} {#1>>one<<}{/2}\n\nNext {#2>>two<<}', '{#2}{#1}x{/2}{/1}\n' + bodies + '\n\nNext'],
    ['between lines of text', seen + '\n' + bodies + '\nMore.', 'Seen {#1}a {#2}b{/1} c{/2} on. More.\n' + bodies],
    ['in a pipe table', '| A |\n|---|\n| ' + seen + ' {#1>>one<<} {#2>>two<<} |', '| A |\n| --- |\n| ' + seen + ' |\n\n' + bodies],
    // In a quote, they stay in it: a line without > would start a paragraph
    ['in a quote paragraph of their own', '> ' + seen + '\n>\n> {#1>>one<<}\n> {#2>>two<<}\n\nAfter.', '> ' + seen + '\n> {#1>>one<<}\n> {#2>>two<<}\n\nAfter.'],
    ['in quote paragraphs before the text', '> {#1>>one<<}\n>\n> {#2>>two<<}\n>\n> ' + seen + '\n\nAfter.', '> ' + seen + '\n> {#1>>one<<}\n> {#2>>two<<}\n\nAfter.'],
    ['in quote paragraphs around the text', '> {#1>>one<<}\n>\n> ' + seen + '\n>\n> {#2>>two<<}\n\nAfter.', '> ' + seen + '\n> {#1>>one<<}\n> {#2>>two<<}\n\nAfter.'],
    ['in a nested quote', '> > ' + seen + '\n> >\n> > {#1>>one<<}\n> > {#2>>two<<}', '> > ' + seen + '\n> > {#1>>one<<}\n> > {#2>>two<<}'],
    // Its marker alone in its paragraph, as the bodies are no text
    ['on an alert\'s marker line', '> [!NOTE] {#1>>one<<} {#2>>two<<}\n>\n> ' + seen, '> [!NOTE]\n>\n> ' + seen + '\n> {#1>>one<<}\n> {#2>>two<<}'],
    ['in an alert', '> [!NOTE]\n> ' + seen + '\n>\n> {#1>>one<<}\n> {#2>>two<<}', '> [!NOTE]\n> ' + seen + '\n> {#1>>one<<}\n> {#2>>two<<}'],
  ])('come back the same way %s', async (_, md, back) => {
    // Their line breaks and spaces aren't text in Word
    expect(await imported(md)).toBe(back);
    expect(await imported(back)).toBe(back);
  });

  test.each([
    ['on the lines after its marker', '> [!NOTE]\n> {#1>>one<<}\n> {#2>>two<<}\n>\n> ' + seen, '> [!NOTE]\n> ' + seen + '\n> {#1>>one<<}\n> {#2>>two<<}'],
    ['on its marker line', '> [!NOTE] {#1>>one<<} {#2>>two<<}\n>\n> ' + seen, '> [!NOTE]\n> ' + seen + '\n> {#1>>one<<}\n> {#2>>two<<}'],
  ])('leave no empty alert lead with a hidden label %s', async (_, md, back) => {
    const hidden = '---\ncallout-labels: false\n---\n\n';
    expect(await imported(hidden + md)).toBe(back);
    expect(await imported(hidden + back)).toBe(back);
  });

  const quoted = '> ' + seen + '\n> {#1>>one<<}\n> {#2>>two<<}';
  test.each([
    ['a quote right after them', '> ' + seen + '\n' + bodies + '\n> next', quoted + '\n\n> next', quoted + '\n>\n> next'],
    ['a quote after a blank line', '> ' + seen + '\n\n' + bodies + '\n> next', quoted + '\n\n> next', quoted + '\n>\n> next'],
    ['an alert', '> ' + seen + '\n\n' + bodies + '\n> [!NOTE]\n> next', quoted + '\n> [!NOTE]\n> next', quoted + '\n> [!NOTE]\n> next'],
  ])('keep %s apart from the quote they go into', async (_, md, back, again) => {
    expect(await imported(md)).toBe(back);
    // A blank line between two quotes reads as one, as without bodies
    expect(await imported(back)).toBe(again);
  });

  test('keep the blocks around a paragraph of bodies apart', async () => {
    const md = seen + '\n\n```js\nx\n```\n\n' + bodies + '\n\n```py\ny\n```';
    expect(await imported(md)).toBe(seen + '\n' + bodies + '\n\n```js\nx\n```\n\n```py\ny\n```');
  });

  test.each([
    ['code', '` ` X'],
    ['a link', '[ ](http://x.org) X'],
  ])('keep whitespace that shows as %s on their line', async (_, line) => {
    expect(await imported(seen + '\n\n' + line + ' {#1>>one<<} {#2>>two<<}')).toBe(seen + '\n' + bodies + '\n\n' + line);
  });

  test('keep two lists apart in a paragraph of their own', async () => {
    // As an empty paragraph, which ends the first list; import keeps them
    // apart with a comment, so the second keeps its numbering and override
    const back = await imported('1. ' + seen + '\n\n' + bodies + '\n\n<!-- no-indent -->\n1. Next');
    expect(back).toBe('1. ' + seen + '\n' + bodies + '\n\n<!-- -->\n\n<!-- no-indent -->\n1. Next');
    expect(await imported(back)).toBe(back);
  });

  test('space a list item\'s quote from a paragraph of their own before another list', async () => {
    const { docx } = await convertMdToDocx('1. ' + seen + '\n\n   > Quote.\n\n' + bodies + '\n\n1. Next');
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    // As before any paragraph after the list: the quote's spacing, then the empty paragraph
    expect(xml).toMatch(/<w:p[^>]*><w:pPr><w:spacing w:after="0"\/><\/w:pPr><\/w:p><w:p[^>]*><\/w:p><w:p[^>]*><w:pPr><w:numPr>/);
  });

  test('end a restarted list\'s numbering in a paragraph of their own', async () => {
    const { docx } = await convertMdToDocx('3. ' + seen + '\n\n' + bodies + '\n\n1. Next');
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    // The second list starts afresh rather than going on from 3
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(match => match[1]);
    expect(numIds).toHaveLength(2);
    expect(numIds[0]).not.toBe(numIds[1]);
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    expect(numbering).toContain('<w:num w:numId="' + numIds[1] + '"');
    expect(numbering).toMatch(new RegExp('w:numId="' + numIds[1] + '"[^]*?<w:startOverride w:val="1"/>'));
  });

  test.each([
    ['', 'Note {#1}x {#2}y{/1}{/2}.\n\n    {#1>>one<<}\n\n    {#2>>two<<}'],
    [' in a quote', '> Note {#1}x {#2}y{/1}{/2}.\n    >\n    > {#1>>one<<}\n    > {#2>>two<<}'],
    [' before the text', '{#1>>one<<}\n\n    {#2>>two<<}\n\n    Note {#1}x {#2}y{/1}{/2}.'],
  ])('leave no empty paragraphs in a note%s', async (_, definition) => {
    const { docx } = await convertMdToDocx('Main[^1].\n\n[^1]: ' + definition);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const notes = await zip.file('word/footnotes.xml')!.async('string');
    const note = notes.slice(notes.indexOf('<w:footnote w:id="1">'));
    expect(note.match(/<w:p[ >]/g)).toHaveLength(1);
    expect((await zip.file('word/comments.xml')!.async('string')).match(/<w:comment /g)).toHaveLength(2);
  });

  test('leave no spaces or empty paragraphs in Word', async () => {
    const { docx } = await convertMdToDocx(seen + '\n' + bodies + '\n\n{#1>>one<<}\n\nNext.');
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:t xml:space="preserve"> on.</w:t></w:r></w:p><w:p');
    expect(xml).not.toContain('<w:t xml:space="preserve"> </w:t>');
    expect(xml).not.toMatch(/<w:p[^>]*><\/w:p>/);
    expect(xml).toContain('>Next.</w:t>');
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
