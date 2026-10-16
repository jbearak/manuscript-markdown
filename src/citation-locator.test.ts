import { describe, it, expect } from 'bun:test';
import JSZip from 'jszip';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readCitationLocator, citationLocatorText, type CitationLocator } from './citation-locator';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { createCiteprocEngine, generateCitation, generateFallbackText } from './md-to-docx-citations';
import { parseBibtex } from './bibtex-parser';
import { fastestRun } from './test-timing';

describe('readCitationLocator, as Pandoc reads the text after a key', () => {
  // Pandoc 3.12's readings (pandoc --citeproc with a style that prints the
  // locator, its label and the suffix), but for a range's dash, which its
  // citeproc shows as an en dash, and for {A to B} and {33}, a locator
  // Pandoc reads with no label, which export writes as a page's
  it.each<[string, CitationLocator]>([
    ['p. 33', { locator: '33', label: 'page' }],
    ['pp. 33-35', { locator: '33-35', label: 'page' }],
    ['33', { locator: '33', label: 'page' }],
    ['33-35, 38', { locator: '33-35, 38', label: 'page' }],
    ['p.33', { locator: '33', label: 'page' }],
    ['P. 33', { locator: '33', label: 'page' }],
    ['pages 33-35', { locator: '33-35', label: 'page' }],
    ['chap. 2', { locator: '2', label: 'chapter' }],
    ['chaps. 2-3', { locator: '2-3', label: 'chapter' }],
    ['chapter 2', { locator: '2', label: 'chapter' }],
    ['c. 2', { locator: '2', label: 'chapter' }],
    ['sec. 3', { locator: '3', label: 'section' }],
    ['§ 3', { locator: '3', label: 'section' }],
    ['§§ 3-4', { locator: '3-4', label: 'section' }],
    ['para. 4', { locator: '4', label: 'paragraph' }],
    ['¶¶ 4-5', { locator: '4-5', label: 'paragraph' }],
    ['fig. 2', { locator: '2', label: 'figure' }],
    ['vols. 3-4', { locator: '3-4', label: 'volume' }],
    ['ll. 10-12', { locator: '10-12', label: 'line' }],
    ['n. 7', { locator: '7', label: 'note' }],
    ['no. 3', { locator: '3', label: 'issue' }],
    ['bk. 1', { locator: '1', label: 'book' }],
    ['col. 2', { locator: '2', label: 'column' }],
    ['fol. 3', { locator: '3', label: 'folio' }],
    ['op. 9', { locator: '9', label: 'opus' }],
    ['pt. 2', { locator: '2', label: 'part' }],
    ['s.v. 3', { locator: '3', label: 'sub verbo' }],
    ['sub verbo 3', { locator: '3', label: 'sub verbo' }],
    ['vv. 3-4', { locator: '3-4', label: 'verse' }],
    ['chap. iv', { locator: 'iv', label: 'chapter' }],
    ['chap. mix', { locator: 'mix', label: 'chapter' }],
    ['pp. iv, 33', { locator: 'iv, 33', label: 'page' }],
    ['p. 33, emphasis added', { locator: '33', label: 'page', suffix: ', emphasis added' }],
    ['p. 33 and passim', { locator: '33', label: 'page', suffix: ' and passim' }],
    ['p. 33, 35, and 37', { locator: '33, 35', label: 'page', suffix: ', and 37' }],
    ['chap. 2, sec. 3', { locator: '2', label: 'chapter', suffix: ', sec. 3' }],
    ['p. 33ff.', { locator: '33ff', label: 'page', suffix: '.' }],
    ['p. 3—5', { locator: '3', label: 'page', suffix: '—5' }],
    ['p. (1)(a)', { locator: '(1)(a)', label: 'page' }],
    ['emphasis added', { suffix: ', emphasis added' }],
    ['ch. 2', { suffix: ', ch. 2' }],
    ['I think', { suffix: ', I think' }],
    ['ii', { suffix: ', ii' }],
    ['chap. civil', { suffix: ', chap. civil' }],
    ['s.v. foo', { suffix: ', s.v. foo' }],
    ['{A to B}', { locator: 'A to B' }],
    ['{33}', { locator: '33' }],
    ['{3}', { locator: '3', label: 'page' }],
    ['{chap. A to B}', { locator: 'A to B', label: 'chapter' }],
    ['{p. 33, emphasis added}', { locator: '33, emphasis added', label: 'page' }],
    ['{pp. iv, vi-xi} with suffix here', { locator: 'iv, vi-xi', label: 'page', suffix: ' with suffix here' }],
    ['{} x', { suffix: ' x' }],
    ['{}x', { suffix: ', x' }],
    ['{},x', { suffix: ',x' }],
    ['{}.x', { suffix: '.x' }],
    ['{p. 2}35', { locator: '2', label: 'page', suffix: '35' }],
    ['{p. 2} iv', { locator: '2', label: 'page', suffix: ' iv' }],
  ])('reads %j', (text, expected) => {
    expect(readCitationLocator(text)).toEqual(expected);
  });

  it('keeps a line end in a locator, as export did before', () => {
    expect(readCitationLocator('p. 1\n2')).toEqual({ locator: '1\n2', label: 'page' });
    expect(readCitationLocator('p.\n2')).toEqual({ locator: '2', label: 'page' });
  });

  // The terms of CSL's en-US locale, which citeproc renders with here and
  // Pandoc reads in an English document
  it('reads each term of the locale for its label', () => {
    const xml = readFileSync(join(__dirname, 'csl-locales', 'locales-en-US.xml'), 'utf8');
    const labels = ['book', 'chapter', 'column', 'figure', 'folio', 'issue', 'line', 'note', 'opus', 'page', 'paragraph', 'part', 'section', 'sub-verbo', 'verse', 'volume'];
    let count = 0;
    for (const label of labels) {
      for (const term of xml.matchAll(new RegExp('<term name="' + label + '"[^>]*>([\\s\\S]*?)</term>', 'g'))) {
        for (const form of term[1].matchAll(/<(?:single|multiple)>([^<]*)</g)) {
          expect([form[1], readCitationLocator(form[1] + ' 2')]).toEqual([form[1], { locator: '2', label: label.replace('-', ' ') }]);
          count++;
        }
      }
    }
    expect(count).toBe(70);
  });

  it('reads a long text in linear time', () => {
    const texts = [
      'x-'.repeat(40000) + 'x',
      'p. ' + '1, '.repeat(40000) + '2',
      'emphasis '.repeat(40000),
      '{' + 'a '.repeat(40000) + '}',
      '('.repeat(80000),
      's.v. ' + 'iv.'.repeat(40000),
    ];
    // A quadratic search took minutes here; linear takes milliseconds
    for (const text of texts) expect(fastestRun(() => readCitationLocator(text))).toBeLessThan(2000);
    expect(fastestRun(() => citationLocatorText('1-'.repeat(40000) + '1', 'chapter', ', x'.repeat(40000)))).toBeLessThan(2000);
  }, 60000);
});

describe('citationLocatorText, as import writes a locator', () => {
  it.each<[string | undefined, string | undefined, string | undefined, string]>([
    ['33', 'page', undefined, 'p. 33'],
    ['33-35', 'page', undefined, 'pp. 33-35'],
    ['33, 35', 'page', undefined, 'pp. 33, 35'],
    ['33ff', 'page', undefined, 'p. 33ff'],
    ['2', 'chapter', undefined, 'chap. 2'],
    ['2-3', 'chapter', undefined, 'chaps. 2-3'],
    ['3', 'section', undefined, 'sec. 3'],
    ['2', 'figure', undefined, 'fig. 2'],
    ['2', 'sub verbo', undefined, 's.v. 2'],
    ['2', 'sub-verbo', undefined, 's.v. 2'],
    ['iv', 'volume', undefined, 'vol. iv'],
    // A page's, as citeproc takes a locator without a label
    ['2', undefined, undefined, 'p. 2'],
    ['33', 'page', ', emphasis added', 'p. 33, emphasis added'],
    ['33', 'page', ' and passim', 'p. 33 and passim'],
    ['33', 'page', '.', 'p. 33.'],
    // citeproc puts a space before it anyway
    ['2', 'page', 'emphasis added', 'p. 2 emphasis added'],
    // In braces, where the plain form would read otherwise
    ['A to B', 'chapter', undefined, '{chap. A to B}'],
    ['33, emphasis added', 'page', undefined, '{pp. 33, emphasis added}'],
    ['2', 'page', '35', '{p. 2}35'],
    ['2', 'page', ' iv', '{p. 2} iv'],
    [undefined, undefined, ', emphasis added', 'emphasis added'],
    [undefined, undefined, ', 33 more', '{}33 more'],
    [undefined, undefined, ' x', '{} x'],
    [undefined, undefined, '.x', '{}.x'],
    [undefined, undefined, 'emphasis added', '{} emphasis added'],
    [undefined, undefined, undefined, ''],
  ])('writes %j, %j and %j as %j', (locator, label, suffix, expected) => {
    expect(citationLocatorText(locator, label, suffix)).toBe(expected);
  });

  it('writes what reads back as the reading of any text', () => {
    const words = ['p.', 'pp.', 'chap.', 'c.', 'ch.', 'sec.', '§', '¶', 's.v.', 'vol.', 'iv', 'mix', 'I', 'x', '33', '3-5', '12a', 'A1', 'A', '2.1', '33ff',
      'emphasis', 'and', 'passim', 'Table', ',', '.', '(', ')', '(1)', '{', '}', '{}', ':', '—', '!', '5'];
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const n = 1 + Math.floor(random() * 6);
      for (let k = 0; k < n; k++) text += (k && random() < 0.7 ? ' ' : '') + words[Math.floor(random() * words.length)];
      const read = readCitationLocator(text.trim());
      // A page's, as export writes a locator Pandoc reads no label for
      const label = read.locator ? read.label ?? 'page' : undefined;
      const written = citationLocatorText(read.locator, label, read.suffix);
      if (!written) continue;
      expect([text, readCitationLocator(written)]).toEqual([text, { ...(read.locator ? { locator: read.locator, label } : {}), ...(read.suffix ? { suffix: read.suffix } : {}) }]);
    }
  });
});

// Through Word: export, Word's field and text, and the next import. Each
// set of cases goes through one document, a paragraph P<n> each, as each
// export's style takes a while to load.
const BIB = '@article{doe2020,\n  author = {Doe, Jane},\n  title = {A Title},\n  journal = {Journal},\n  year = {2020},\n  zotero-key = {ABCD1234},\n  zotero-uri = {http://zotero.org/users/1/items/ABCD1234}\n}\n\n'
  + '@book{roe2019,\n  author = {Roe, Rick},\n  title = {A Book},\n  publisher = {Pub},\n  year = {2019},\n  zotero-key = {EFGH5678},\n  zotero-uri = {http://zotero.org/users/1/items/EFGH5678}\n}\n';
const STYLE = 'chicago-author-date';
type FieldItem = { locator?: string; label?: string; prefix?: string; suffix?: string; 'suppress-author'?: boolean };
type Field = { items: FieldItem[]; shown: string };
type Trip = { first: Field; markdown: string; next: Field };
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FIELD_RE = /(CSL_CITATION )(.*?)( <\/w:instrText>[\s\S]*?fldCharType="separate"\/><\/w:r>)([\s\S]*?)(<w:r><w:fldChar w:fldCharType="end"\/>)/g;
const once = <T,>(make: () => Promise<T>) => { let made: Promise<T> | undefined; return () => made ??= make(); };

/** The citation fields of a document's body, in order: each one's items,
 *  without their data, and the text Word shows for it */
async function fields(docx: Uint8Array): Promise<Field[]> {
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  return [...xml.matchAll(FIELD_RE)].map(m => ({
    items: (JSON.parse(unescape(m[2])).citationItems as Array<Record<string, unknown>>).map(({ locator, label, prefix, suffix, 'suppress-author': sa }) =>
      JSON.parse(JSON.stringify({ locator, label, prefix, suffix, 'suppress-author': sa })) as FieldItem),
    shown: unescape([...m[4].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]).join('')),
  }));
}

let engine: ReturnType<typeof createCiteprocEngine>;
/** What citeproc shows for `items` of these keys in the style, as Zotero
 *  shows its field */
function rendered(keys: string[], items: FieldItem[]): string {
  engine ??= createCiteprocEngine(parseBibtex(BIB), STYLE);
  return unescape(engine!.makeCitationCluster(items.map((item, k) => ({ id: keys[k], ...item }))).replace(/<[^>]*>/g, ''));
}

/** Each paragraph's Markdown in import's, by its number */
function paragraphs(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '').matchAll(/^P(\d+) (.*)$/gm)) out[Number(m[1])] = m[2] + '\n';
  return out;
}

/** A document's paragraphs, each as Markdown `md` gives it, through Word:
 *  each one's field at the first export, its Markdown at the import, and
 *  its field at the next export */
async function fromMarkdown(md: string[]): Promise<Trip[]> {
  const first = await convertMdToDocx('---\ncsl: ' + STYLE + '\n---\n\n' + md.map((p, n) => 'P' + n + ' ' + p).join('\n'), { bibtex: BIB });
  const imported = await convertDocx(first.docx);
  const next = await convertMdToDocx(imported.markdown, { bibtex: imported.bibtex });
  const [before, markdown, after] = [await fields(first.docx), paragraphs(imported.markdown), await fields(next.docx)];
  return md.map((_p, n) => ({ first: before[n], markdown: markdown[n], next: after[n] }));
}

type ZoteroCase = { keys: string[]; items: FieldItem[]; text?: string; edited?: string };
/** A document with a paragraph for each case, whose field cites its `keys`
 *  with its `items`, as Zotero writes them, shown as citeproc shows them, or
 *  as `edited` by hand: each one's Markdown at the import, and its field at
 *  the next export, with the text Word showed first */
async function fromZotero(cases: ZoteroCase[]): Promise<Array<Trip & { shown: string }>> {
  const md = cases.map(({ keys, text = 'A CITE b.' }, n) => 'P' + n + ' ' + text.replace('CITE', '[' + keys.map(key => '@' + key).join('; ') + ']') + '\n');
  const zip = await JSZip.loadAsync((await convertMdToDocx('---\ncsl: ' + STYLE + '\n---\n\n' + md.join('\n'), { bibtex: BIB })).docx);
  const xml = await zip.file('word/document.xml')!.async('string');
  const shown = cases.map(({ keys, items, edited }) => edited ?? rendered(keys, items));
  let n = 0;
  zip.file('word/document.xml', xml.replace(FIELD_RE, (_all, open: string, json: string, separate: string, _result: string, end: string) => {
    const { items, edited } = cases[n];
    const citation = JSON.parse(unescape(json));
    citation.citationItems = citation.citationItems.map((item: Record<string, unknown>, k: number) => {
      const { locator: _l, label: _b, prefix: _p, suffix: _s, 'suppress-author': _a, ...rest } = item;
      return { ...rest, ...items[k] };
    });
    citation.properties = { ...citation.properties, formattedCitation: shown[n], plainCitation: shown[n], ...(edited ? { dontUpdate: true } : {}) };
    return open + escape(JSON.stringify(citation)) + separate + '<w:r><w:t xml:space="preserve">' + escape(shown[n++]) + '</w:t></w:r>' + end;
  }));
  const docx = await zip.generateAsync({ type: 'uint8array' });
  const imported = await convertDocx(docx);
  const next = await convertMdToDocx(imported.markdown, { bibtex: imported.bibtex });
  const [before, markdown, after] = [await fields(docx), paragraphs(imported.markdown), await fields(next.docx)];
  return cases.map((_c, k) => ({ shown: shown[k], first: before[k], markdown: markdown[k], next: after[k] }));
}

const TERMS: Array<[label: string, term: string]> = [
  ['book', 'bk.'], ['chapter', 'chap.'], ['column', 'col.'], ['figure', 'fig.'], ['folio', 'fol.'], ['issue', 'no.'], ['line', 'l.'], ['note', 'n.'],
  ['opus', 'op.'], ['page', 'p.'], ['paragraph', 'para.'], ['part', 'pt.'], ['section', 'sec.'], ['sub verbo', 's.v.'], ['verse', 'v.'], ['volume', 'vol.'],
];

const SUFFIXES: Array<[string, FieldItem]> = [
  ['A [@doe2020, p. 33, emphasis added] b.\n', { locator: '33', label: 'page', suffix: ', emphasis added' }],
  ['A [@doe2020, chap. 2 and passim] b.\n', { locator: '2', label: 'chapter', suffix: ' and passim' }],
  ['A [@doe2020, emphasis added] b.\n', { suffix: ', emphasis added' }],
  // Not one of Pandoc's terms, which is chap.: a suffix, shown as written
  ['A [@doe2020, ch. 2] b.\n', { suffix: ', ch. 2' }],
  ['A [@doe2020, {chap. A to B}] b.\n', { locator: 'A to B', label: 'chapter' }],
];

const ZOTERO_SUFFIXES: Array<[FieldItem, string, FieldItem?]> = [
  [{ locator: '2', label: 'page', suffix: ', emphasis added' }, 'p. 2, emphasis added'],
  [{ suffix: ', emphasis added' }, 'emphasis added'],
  [{ locator: '2', label: 'chapter', suffix: '.' }, 'chap. 2.'],
  // citeproc puts a space before it anyway, so Word shows the same
  [{ locator: '2', label: 'page', suffix: 'emphasis added' }, 'p. 2 emphasis added', { locator: '2', label: 'page', suffix: ' emphasis added' }],
  [{ suffix: 'emphasis added' }, '{} emphasis added', { suffix: ' emphasis added' }],
  [{ locator: 'A to B', label: 'chapter' }, '{chap. A to B}'],
];

const MORE = [
  'A [see @doe2020, chap. 2, for more] b.\n',
  'Doe [-@doe2020, chap. 3, emphasis added] b.\n',
  'A [see @doe2020, p. 4; @roe2019, fig. 2, and passim] b.\n',
  'A [@doe2020, pp. 3-5; @roe2019, chaps. 2-3] b.\n',
];

const ZOTERO_MORE: ZoteroCase[] = [
  { keys: ['doe2020'], items: [{ locator: '4', label: 'page', prefix: 'see', suffix: ', for more' }] },
  { keys: ['doe2020'], items: [{ locator: '3', label: 'chapter', 'suppress-author': true }], text: 'Doe CITE b.' },
  { keys: ['doe2020', 'roe2019'], items: [{ locator: '3-5', label: 'section', suffix: ', emphasis added' }, { locator: 'iv', label: 'volume', prefix: 'also' }] },
];

const GUARDS: Array<[string, FieldItem[], string]> = [
  ['A [@doe2020, p. 33] b.\n', [{ locator: '33', label: 'page' }], 'A [@doe2020, p. 33] b.\n'],
  // A number alone is a page, as Pandoc reads it; import writes its term
  ['A [@doe2020, 33] b.\n', [{ locator: '33', label: 'page' }], 'A [@doe2020, p. 33] b.\n'],
  ['A [see @doe2020; @roe2019] b.\n', [{ prefix: 'see' }, {}], 'A [see @doe2020; @roe2019] b.\n'],
  ['A [-@doe2020] b.\n', [{ 'suppress-author': true }], 'A [-@doe2020] b.\n'],
];

const markdownTrips = once(() => fromMarkdown([...TERMS.map(([, term]) => 'A [@doe2020, ' + term + ' 2] b.\n'), ...SUFFIXES.map(([md]) => md), ...MORE, ...GUARDS.map(([md]) => md)]));
const zoteroTrips = once(() => fromZotero([
  ...TERMS.map(([label]) => ({ keys: ['doe2020'], items: [{ locator: '2', label }] })),
  ...ZOTERO_SUFFIXES.map(([item]) => ({ keys: ['doe2020'], items: [item] })),
  ...ZOTERO_MORE,
  // Edited by hand (see the guard below)
  { keys: ['doe2020'], items: [{ locator: '2', label: 'page' }], edited: '(Doe 2020, 2, my emphasis)' },
]));
const markdownTrip = async (k: number) => (await markdownTrips())[k];
const zoteroTrip = async (k: number) => (await zoteroTrips())[k];

describe('a citation\'s locator, its label and its suffix through Word', () => {
  it.each(TERMS.map((term, k) => [...term, k] as const))('exports %s from its term, %s, and imports it back', async (label, term, k) => {
    const trip = await markdownTrip(k);
    expect(trip.first.items).toEqual([{ locator: '2', label }]);
    expect(trip.first.shown).toBe(rendered(['doe2020'], [{ locator: '2', label }]));
    expect(trip.markdown).toBe('A [@doe2020, ' + term + ' 2] b.\n');
    expect(trip.next).toEqual(trip.first);
  }, 60000);

  it.each(TERMS.map((term, k) => [...term, k] as const))('imports Zotero\'s %s as its term, %s', async (label, term, k) => {
    const trip = await zoteroTrip(k);
    expect(trip.markdown).toBe('A [@doe2020, ' + term + ' 2] b.\n');
    expect(trip.next.items).toEqual([{ locator: '2', label }]);
    expect(trip.next.shown).toBe(trip.shown);
  }, 60000);

  it.each(SUFFIXES.map((c, k) => [...c, TERMS.length + k] as const))('exports a suffix after the locator in %j', async (md, item, k) => {
    const trip = await markdownTrip(k);
    expect(trip.first.items).toEqual([item]);
    expect(trip.first.shown).toBe(rendered(['doe2020'], [item]));
    expect(trip.markdown).toBe(md);
    expect(trip.next).toEqual(trip.first);
  }, 60000);

  it.each(ZOTERO_SUFFIXES.map((c, k) => [c[0], c[1], c[2] ?? c[0], TERMS.length + k] as const))('imports Zotero\'s %j', async (_item, written, exported, k) => {
    const trip = await zoteroTrip(k);
    expect(trip.markdown).toBe('A [@doe2020, ' + written + '] b.\n');
    expect(trip.next.items).toEqual([exported]);
    expect(trip.next.shown).toBe(trip.shown);
  }, 60000);

  const more = TERMS.length + SUFFIXES.length;
  const zoteroMore = TERMS.length + ZOTERO_SUFFIXES.length;

  it('keeps a prefix and a suffix', async () => {
    const trip = await markdownTrip(more);
    expect(trip.first.items).toEqual([{ locator: '2', label: 'chapter', prefix: 'see', suffix: ', for more' }]);
    expect(trip.first.shown).toBe(rendered(['doe2020'], trip.first.items));
    expect(trip.markdown).toBe(MORE[0]);
    const zotero = await zoteroTrip(zoteroMore);
    expect(zotero.markdown).toBe('A [see @doe2020, p. 4, for more] b.\n');
    expect(zotero.next.items).toEqual([{ locator: '4', label: 'page', prefix: 'see', suffix: ', for more' }]);
    expect(zotero.next.shown).toBe(zotero.shown);
  }, 60000);

  it('keeps a label and a suffix with suppress-author', async () => {
    const trip = await markdownTrip(more + 1);
    expect(trip.first.items).toEqual([{ locator: '3', label: 'chapter', suffix: ', emphasis added', 'suppress-author': true }]);
    expect(trip.first.shown).toBe(rendered(['doe2020'], trip.first.items));
    expect(trip.markdown).toBe(MORE[1]);
    const zotero = await zoteroTrip(zoteroMore + 1);
    expect(zotero.markdown).toBe('Doe [-@doe2020, chap. 3] b.\n');
    expect(zotero.next.items).toEqual([{ locator: '3', label: 'chapter', 'suppress-author': true }]);
    expect(zotero.next.shown).toBe(zotero.shown);
  }, 60000);

  it('keeps each item\'s label and suffix in a citation of more than one', async () => {
    const trip = await markdownTrip(more + 2);
    expect(trip.first.items).toEqual([{ locator: '4', label: 'page', prefix: 'see' }, { locator: '2', label: 'figure', suffix: ', and passim' }]);
    expect(trip.first.shown).toBe(rendered(['doe2020', 'roe2019'], trip.first.items));
    expect(trip.markdown).toBe(MORE[2]);
    expect(trip.next).toEqual(trip.first);
    const zotero = await zoteroTrip(zoteroMore + 2);
    expect(zotero.markdown).toBe('A [@doe2020, secs. 3-5, emphasis added; also @roe2019, vol. iv] b.\n');
    expect(zotero.next.items).toEqual(ZOTERO_MORE[2].items);
    expect(zotero.next.shown).toBe(zotero.shown);
  }, 60000);

  it('imports a plural locator with the plural term', async () => {
    const trip = await markdownTrip(more + 3);
    expect(trip.first.items).toEqual([{ locator: '3-5', label: 'page' }, { locator: '2-3', label: 'chapter' }]);
    expect(trip.markdown).toBe(MORE[3]);
  }, 60000);
});

describe('guards: citations main wrote as these already', () => {
  it.each(GUARDS.map((c, k) => [...c, TERMS.length + SUFFIXES.length + MORE.length + k] as const))('exports %j', async (_md, items, back, k) => {
    const trip = await markdownTrip(k);
    expect(trip.first.items).toEqual(items);
    expect(trip.markdown).toBe(back);
  }, 60000);

  it('shows the locator\'s text as written without a style', () => {
    const entries = parseBibtex(BIB);
    const locators = new Map([['doe2020', 'chap. 2, emphasis added']]);
    expect(generateFallbackText(['doe2020'], entries, locators)).toBe('(Doe 2020, chap. 2, emphasis added)');
  });

  it('writes a missing key\'s citation as its text', () => {
    const result = generateCitation({ keys: ['nokey'], locators: new Map([['nokey', 'chap. 2, emphasis added']]), text: '@nokey, chap. 2, emphasis added' }, parseBibtex(BIB));
    expect(result.xml).toContain('[@nokey, chap. 2, emphasis added]');
  });

  // Not fixed: a citation edited by hand in Word (Zotero's dontUpdate) has
  // no Markdown form, and comes back as its items, which the next export
  // shows as citeproc does
  it('imports a citation edited by hand as its items', async () => {
    const trip = await zoteroTrip(TERMS.length + ZOTERO_SUFFIXES.length + ZOTERO_MORE.length);
    expect(trip.markdown).toBe('A [@doe2020, p. 2] b.\n');
    expect(trip.next.shown).toBe(rendered(['doe2020'], [{ locator: '2', label: 'page' }]));
  }, 60000);
});
