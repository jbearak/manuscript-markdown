// src/critic-span-seams.test.ts — one Word revision across citations,
// equations, footnotes and formatting changes imports as one CriticMarkup
// span, a seam that would read differently joined keeps its spans, and a
// citation's separating space is not repeated inside a tracked change.

import { describe, expect, it } from 'bun:test';
import { convertMdToDocx } from './md-to-docx';
import { buildMarkdown, convertDocx, DEFAULT_FORMATTING, type ContentItem, type RevisionInfo } from './converter';

const bibtex = `@book{r2025, author={{R Core Team}}, title={R}, year={2025}}
@book{r2026, author={{R Core Team}}, title={R}, year={2026}}
@article{doe2020, author={Doe, Jane}, title={A study}, journal={J}, year={2020}}`;

async function roundTrip(md: string, options: { alwaysUseCommentIds?: boolean } = {}): Promise<string> {
  const { docx } = await convertMdToDocx(md, { bibtex });
  const imported = await convertDocx(docx, 'authorYearTitle', { existingBibtex: bibtex, ...options });
  return imported.markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

const added: RevisionInfo = { type: 'addition', author: 'A', date: '2026-01-01T00:00:00Z' };
const text = (value: string, revision: RevisionInfo | undefined = added, formatting = DEFAULT_FORMATTING, href?: string): ContentItem =>
  ({ type: 'text', text: value, commentIds: new Set(), formatting: { ...formatting }, ...(href ? { href } : {}), ...(revision ? { revision } : {}) });
const plain = (value: string): ContentItem => ({ type: 'text', text: value, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING } });
const math = (latex: string, revision: RevisionInfo = added): ContentItem =>
  ({ type: 'math', latex, display: false, commentIds: new Set(), revision });
const render = (items: ContentItem[]) => buildMarkdown([{ type: 'para' }, ...items], new Map()).trim();

describe('one revision across citations, equations and formatting', () => {
  it.each([
    ['a citation inside an insertion', 'Seen in fecundability {++changes [@doe2020].++} Next.'],
    ['an insertion that opens with the space before a citation', 'Seen{++ [@doe2020]++}. Next.'],
    ['a deletion around a citation', '{--Gone [@doe2020], too.--} Kept.'],
    ['an equation inside an insertion', 'Seen {++in month $t$, conditional++} on.'],
    ['an equation after a hyphen', 'Seen {++split-$\\hat{R}$ statistic++} on.'],
    ['a formatting change', '{++*Notes:* Typical text.++}'],
  ])('keeps %s in one span', async (_, md) => {
    expect(await roundTrip(md)).toBe(md);
  });

  it('pairs a deleted citation, which export writes as its key, with the citation replacing it', async () => {
    const md = 'R 4.{~~5~>6~~}. {~~[@r2025]~>[@r2026]~~}.';
    expect(await roundTrip(md)).toBe(md);
  });

  it('keeps a deletion and an addition apart when the old side holds ~>', () => {
    const deleted: RevisionInfo = { ...added, type: 'deletion' };
    const citation: ContentItem = { type: 'citation', text: '(Doe 2020)', commentIds: new Set(), pandocKeys: ['@doe2020'], revision: added };
    expect(render([plain('Seen '), text('old~>value', deleted), citation])).toBe('Seen {--old~>value--}{++[@doe2020]++}');
    expect(render([plain('Seen '), text('a~>b', deleted), text('c')])).toBe('Seen {--a~>b--}{++c++}');
  });

  it('keeps one span with comment IDs', async () => {
    expect(await roundTrip('A {==note==}{>>c<<} and {++more [@doe2020].++}', { alwaysUseCommentIds: true }))
      .toContain('{++more [@doe2020].++}');
  });

  it.each([
    ['an equation before a letter', [math('t'), text('th')], '{++$t$++}{++th++}'],
    ['a letter before an equation', [text('x'), math('t')], '{++x++}{++$t$++}'],
    ['two equations', [math('a'), math('b')], '{++$a$++}{++$b$++}'],
    ['emphasis ending in punctuation before a letter', [text('a.', added, { ...DEFAULT_FORMATTING, italic: true }), text('b')], '{++*a.*++}{++b++}'],
    ['an exclamation mark before a link', [text('Wow!'), text('x', added, DEFAULT_FORMATTING, 'https://example.com')], '{++Wow!++}{++[x](https://example.com)++}'],
  ])('keeps the spans apart at %s', (_, items, expected) => {
    expect(render(items)).toBe(expected);
  });

  it('keeps a footnote reference after a sentence in the span', () => {
    // Export writes a reference inside an insertion as text, so this can't round-trip yet
    const note: ContentItem = { type: 'footnote_ref', noteId: '1', noteKind: 'footnote', commentIds: new Set(), revision: added };
    expect(render([text('more.'), note, text(' Then')])).toBe('{++more.[^1] Then++}');
  });

  it.each([
    ['a backtick', [text('` '), text('b', added, { ...DEFAULT_FORMATTING, code: true })], '{++` ++}{++`b`++}'],
    ['a dollar sign', [text('costs $ '), math('t')], '{++costs $ ++}{++$t$++}'],
  ])('keeps a span apart whose text has %s of its own, even across a space', (_, items, expected) => {
    expect(render(items)).toBe(expected);
  });

  it('joins text with a delimiter of its own only to a span without that kind', () => {
    const italic = { ...DEFAULT_FORMATTING, italic: true };
    expect(render([text('Notes:', added, italic), text(' sd_alpha [1]')])).toBe('{++*Notes:* sd_alpha [1]++}');
    expect(render([math('t'), text(' sd_alpha')])).toBe('{++$t$ sd_alpha++}');
    expect(render([math('t'), text(' costs $')])).toBe('{++$t$++}{++ costs $++}');
  });

  it.each([
    ['stars', '*a ', 'b*'],
    ['the halves of an HTML tag', '<a ', 'b>'],
  ])('keeps plain citations apart whose %s would pair', (_, first, second) => {
    const plainCitation = (value: string): ContentItem => ({ type: 'citation', text: value, commentIds: new Set(), pandocKeys: [], revision: added });
    expect(render([plainCitation(first), plainCitation(second)])).toBe('{++' + first + '++}{++' + second + '++}');
  });

  it('joins a plain citation, whose text may hold a URL, only across whitespace', () => {
    const plainCitation: ContentItem = { type: 'citation', text: 'https://example.com', commentIds: new Set(), pandocKeys: [], revision: added };
    expect(render([plainCitation, text('suffix')])).toBe('{++https://example.com++}{++suffix++}');
    expect(render([plainCitation, text(' more')])).toBe('{++https://example.com more++}');
  });

  it('keeps an & apart, which could form an entity across the seam', () => {
    const plainCitation: ContentItem = { type: 'citation', text: 'p; y', commentIds: new Set(), pandocKeys: [], revision: added };
    expect(render([text('x &am'), plainCitation])).toBe('{++x &am++}{++p; y++}');
  });

  it('joins code whose text has a delimiter, which stays literal', () => {
    expect(render([text('see '), text('a_b', added, { ...DEFAULT_FORMATTING, code: true }), text(' here')])).toBe('{++see `a_b` here++}');
  });

  it('joins a bare URL to a span only across whitespace', () => {
    const url = 'https://example.com';
    expect(render([text(url, added, DEFAULT_FORMATTING, url), text('suffix')])).toBe('{++' + url + '++}{++suffix++}');
    expect(render([text('see'), text(url, added, DEFAULT_FORMATTING, url)])).toBe('{++see++}{++' + url + '++}');
    expect(render([text('see '), text(url, added, DEFAULT_FORMATTING, url), text(' more')])).toBe('{++see ' + url + ' more++}');
  });

  it('joins a long revision of many runs in linear time', () => {
    const italic = { ...DEFAULT_FORMATTING, italic: true };
    const items = Array.from({ length: 20000 }, (_, i) => text('w' + (i % 10) + ' ', added, i % 2 ? DEFAULT_FORMATTING : italic));
    const started = performance.now();
    const markdown = render(items);
    // Quadratic joining took seconds here; linear takes milliseconds
    expect(performance.now() - started).toBeLessThan(2000);
    expect(markdown.match(/\{\+\+/g)).toHaveLength(1);
  });

  it('keeps the spans of different revisions apart', () => {
    const other: RevisionInfo = { ...added, author: 'B' };
    expect(render([text('a '), math('t', other)])).toBe('{++a ++}{++$t$++}');
  });
});

describe('the space before a citation in a tracked change', () => {
  it('is not repeated after an inserted space', async () => {
    const md = 'Seen {++a ++}[@doe2020] here.';
    expect(await roundTrip(md)).toBe(md);
  });

  it('is not added when a view the citation shows in already ends with one', () => {
    const citation: ContentItem = { type: 'citation', text: '(Doe 2020)', commentIds: new Set(), pandocKeys: ['@doe2020'] };
    const deleted: RevisionInfo = { ...added, type: 'deletion' };
    // The other view keeps the citation against its text, as Word has it
    expect(render([plain('Seen'), text(' '), citation])).toBe('Seen{++ ++}[@doe2020]');
    expect(render([plain('Seen '), text('x', deleted), citation])).toBe('Seen {--x--}[@doe2020]');
  });

  it('is added when no view the citation shows in ends with one', () => {
    const citation: ContentItem = { type: 'citation', text: '(Doe 2020)', commentIds: new Set(), pandocKeys: ['@doe2020'] };
    expect(render([plain('Seen'), text(' x'), citation])).toBe('Seen{++ x++} [@doe2020]');
  });

  it('is added after a comment whose replies indent their lines', () => {
    const citation: ContentItem = { type: 'citation', text: '(Doe 2020)', commentIds: new Set(), pandocKeys: ['@doe2020'] };
    const commented: ContentItem = { ...plain('Seen'), commentIds: new Set(['1']) } as ContentItem;
    const comments = new Map([['1', { author: 'A', text: 'c', date: '', replies: [{ author: 'B', text: 'r', date: '' }] }]]);
    expect(buildMarkdown([{ type: 'para' }, commented, citation], comments).trim()).toEndWith('<<} [@doe2020]');
  });
});
