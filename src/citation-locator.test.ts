import { describe, it, expect } from 'bun:test';
import JSZip from 'jszip';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readCitationLocator, citationLocatorText, type CitationLocator } from './citation-locator';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { createCiteprocEngine, generateCitation, generateFallbackText, renderCitationText } from './md-to-docx-citations';
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

  // Not Pandoc's: citeproc's abbreviations of a label, which Pandoc reads
  // as text, or before a word that isn't a number, and which main's export
  // wrote as a page's locator, which Word showed as that label. In lower
  // case, before whitespace, as citeproc reads them, with any word after
  // one, as citeproc takes it
  it.each<[string, CitationLocator]>([
    ['ch. 2', { locator: '2', label: 'chapter' }],
    ['ch. 2-3', { locator: '2-3', label: 'chapter' }],
    ['ch.  2', { locator: '2', label: 'chapter' }],
    ['ch. A', { locator: 'A', label: 'chapter' }],
    ['ch. 2, emphasis added', { locator: '2', label: 'chapter', suffix: ', emphasis added' }],
    ['{ch. A to B}', { locator: 'A to B', label: 'chapter' }],
    ['sv. word', { locator: 'word', label: 'sub verbo' }],
    ['vrs. 2', { locator: '2', label: 'verse' }],
    ['app. A', { locator: 'A', label: 'appendix' }],
    ['r. 2', { locator: '2', label: 'rule' }],
    ['supp. 2', { locator: '2', label: 'supplement' }],
    ['tbl. 3', { locator: '3', label: 'table' }],
    ['sec. A', { locator: 'A', label: 'section' }],
    ['fig. A, emphasis added', { locator: 'A', label: 'figure', suffix: ', emphasis added' }],
    ['l. A', { locator: 'A', label: 'line' }],
    // Which main's export read as a page's, with anything after it
    ['p. A', { locator: 'A', label: 'page' }],
    ['pp. passim', { locator: 'passim', label: 'page' }],
    // Which citeproc reads as no label: in another case, without a space,
    // or one it shows as Preprint or as a page
    ['Ch. 2', { suffix: ', Ch. 2' }],
    ['Sec. A', { suffix: ', Sec. A' }],
    ['ch.2', { locator: 'ch.2', label: 'page' }],
    ['art. 2', { suffix: ', art. 2' }],
    ['subpara. 2', { suffix: ', subpara. 2' }],
    ['ch.', { suffix: ', ch.' }],
  ])('reads %j as citeproc did', (text, expected) => {
    expect(readCitationLocator(text)).toEqual(expected);
  });

  // A brace or a backslash after a backslash is that character as text,
  // so a locator can hold a brace no other closes, and so are a ;, a [, a ]
  // and an @, as Pandoc reads them, so they end no item or citation and
  // start no key; a backslash before any other character is text
  it.each<[string, CitationLocator]>([
    ['p. A\\{B', { locator: 'A{B', label: 'page' }],
    ['{p. A\\{B}', { locator: 'A{B', label: 'page' }],
    ['{p. \\}\\{}', { locator: '}{', label: 'page' }],
    ['{p. A\\\\}', { locator: 'A\\', label: 'page' }],
    ['p. 2, see \\{x\\}', { locator: '2', label: 'page', suffix: ', see {x}' }],
    ['p. 2\\x', { locator: '2', label: 'page', suffix: '\\x' }],
    ['p. 2\\; 5', { locator: '2; 5', label: 'page' }],
    ['p. 4\\; also elsewhere', { locator: '4', label: 'page', suffix: '; also elsewhere' }],
    ['p. 4 \\[n. 2\\]', { locator: '4', label: 'page', suffix: ' [n. 2]' }],
    ['p. 3 \\]x', { locator: '3', label: 'page', suffix: ' ]x' }],
    ['via \\@x', { suffix: ', via @x' }],
    ['p. 2, see \\[^1\\]', { locator: '2', label: 'page', suffix: ', see [^1]' }],
  ])('reads the escapes in %j', (text, expected) => {
    expect(readCitationLocator(text)).toEqual(expected);
  });

  // A tag citeproc reads is part of a word, as export read it in a page's
  // locator before, which Word showed as its markup, as a superscript 2:
  // not split at its /, as the reader split <sup>2</sup> into the locator
  // <sup>2< and the suffix /sup>. A word without a digit is no page's
  // without a term, as ii.
  it.each<[string, CitationLocator]>([
    ['<sup>2</sup>', { locator: '<sup>2</sup>', label: 'page' }],
    ['p. <sup>2</sup>', { locator: '<sup>2</sup>', label: 'page' }],
    ['<sub>2</sub>', { locator: '<sub>2</sub>', label: 'page' }],
    ['p. <i>iv</i>', { locator: '<i>iv</i>', label: 'page' }],
    ['chap. <b>2</b>', { locator: '<b>2</b>', label: 'chapter' }],
    ['p. <sc>2</sc>', { locator: '<sc>2</sc>', label: 'page' }],
    ['p. <span class="nocase">2</span>', { locator: '<span class="nocase">2</span>', label: 'page' }],
    ['p. <span class="nodecor">2</span>', { locator: '<span class="nodecor">2</span>', label: 'page' }],
    ['p. <span style="font-variant:small-caps;">2</span>', { locator: '<span style="font-variant:small-caps;">2</span>', label: 'page' }],
    ['p. 2<sup>a</sup>', { locator: '2<sup>a</sup>', label: 'page' }],
    ['p. 2</i>', { locator: '2</i>', label: 'page' }],
    ['pp. <sup>2</sup>-<sup>5</sup>', { locator: '<sup>2</sup>-<sup>5</sup>', label: 'page' }],
    ['<sup>2</sup>, emphasis added', { locator: '<sup>2</sup>', label: 'page', suffix: ', emphasis added' }],
    ['p. 2, <sup>a</sup>', { locator: '2', label: 'page', suffix: ', <sup>a</sup>' }],
    ['p. 2 <sup>a</sup> b', { locator: '2', label: 'page', suffix: ' <sup>a</sup> b' }],
    ['<i>iv</i>', { suffix: ', <i>iv</i>' }],
  ])('reads the tags in %j as part of a word', (text, expected) => {
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
      'app. ' + 'A, '.repeat(40000),
    ];
    // A quadratic search took minutes here; linear takes milliseconds
    for (const text of texts) expect(fastestRun(() => readCitationLocator(text))).toBeLessThan(2000);
    expect(fastestRun(() => citationLocatorText('1-'.repeat(40000) + '1', 'chapter', ', x'.repeat(40000)))).toBeLessThan(2000);
  }, 60000);

  // A run of one character, at 16,000 and at 64,000, in several places,
  // read and written: linear work takes 4 times as long at 64,000, where a
  // scan that read a run of spaces or backslashes again from each of its
  // characters took 16 times as long, and seconds
  it.each([' ', '1', ',', '-', '{', '}', '{}', 'i', 'M', '\\', '<sup>', '<i>1</i>', ';', '[', ']', '@', '\\;', '\\]'])('reads and writes a long run of %j in linear time', run => {
    const places = [(text: string) => text, (text: string) => 'p. ' + text, (text: string) => '1' + text + '2', (text: string) => '{p. 1' + text + '}'];
    const works = [
      (text: string) => readCitationLocator(text),
      (text: string) => citationLocatorText(text, 'page', undefined),
      (text: string) => citationLocatorText('2', 'chapter', text),
      (text: string) => citationLocatorText(undefined, undefined, text),
    ];
    for (const place of places) {
      for (const work of works) {
        const [small, large] = [16000, 64000].map(length => place(run.repeat(length / run.length)));
        const [smallTime, largeTime] = [fastestRun(() => work(small)), fastestRun(() => work(large))];
        expect(largeTime).toBeLessThan(2000);
        expect(largeTime).toBeLessThan(8 * smallTime + 100);
      }
    }
  }, 120000);
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
    // A label of citeproc's abbreviations alone
    ['A', 'appendix', undefined, 'app. A'],
    ['2-3', 'table', undefined, 'tbl. 2-3'],
    ['2', 'rule', undefined, 'r. 2'],
    ['2', 'supplement', undefined, 'supp. 2'],
    // As Pandoc reads it too, not sec. A, which it reads as text
    ['A', 'section', undefined, '{sec. A}'],
    ['A', 'page', undefined, '{p. A}'],
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
    [undefined, undefined, ', ch. 2', '{}ch. 2'],
    [undefined, undefined, ', sec. A', '{}sec. A'],
    // A brace no other closes, and a backslash before a brace, escaped
    ['A{B', 'page', undefined, '{p. A\\{B}'],
    ['A}B', 'chapter', ', for more', '{chap. A\\}B}, for more'],
    ['A\\', 'page', undefined, '{p. A\\\\}'],
    ['A\\{B', 'page', undefined, '{p. A\\\\\\{B}'],
    ['2', 'page', ', see \\{x', 'p. 2, see \\\\\\{x'],
    // A ;, a [, a ] and an @, escaped, which main dropped, and a backslash
    // right before one, escaped too
    ['2; 5', 'page', undefined, 'pp. 2\\; 5'],
    ['4', 'page', '; also elsewhere', 'p. 4\\; also elsewhere'],
    ['3', 'page', ' ]x', 'p. 3 \\]x'],
    [undefined, undefined, ', via @x', 'via \\@x'],
    ['2', 'page', ', see [^1]', 'p. 2, see \\[^1\\]'],
    ['a\\;b', 'page', undefined, '{p. a\\\\\\;b}'],
    // Which Pandoc, as export, reads as the locator 4 and the suffix
    // [n. 2], which citeproc shows the same
    ['4 [n. 2]', 'page', undefined, 'p. 4 \\[n. 2\\]'],
    // A tag, part of the locator's word, as main wrote it, and in a suffix
    ['<sup>2</sup>', 'page', undefined, 'p. <sup>2</sup>'],
    ['<i>iv</i>', 'chapter', undefined, 'chap. <i>iv</i>'],
    ['<span class="nocase">2</span>', 'page', undefined, 'p. <span class="nocase">2</span>'],
    ['2', 'page', ', <sup>a</sup>', 'p. 2, <sup>a</sup>'],
    [undefined, undefined, undefined, ''],
  ])('writes %j, %j and %j as %j', (locator, label, suffix, expected) => {
    expect(citationLocatorText(locator, label, suffix)).toBe(expected);
  });

  it('writes what reads back as the reading of any text', () => {
    const words = ['p.', 'pp.', 'chap.', 'c.', 'ch.', 'sec.', '§', '¶', 's.v.', 'vol.', 'iv', 'mix', 'I', 'x', '33', '3-5', '12a', 'A1', 'A', '2.1', '33ff',
      'emphasis', 'and', 'passim', 'Table', ',', '.', '(', ')', '(1)', '{', '}', '{}', ':', '—', '!', '5', '<sup>2</sup>', '<i>iv</i>', '<i>', '</i>', '2</sup>',
      '<span class="nocase">', ';', '2;', '[', '[n.', ']', '2]', '@', '@x', '\\;', '\\]'];
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
/** A field's items, Word's text for it, and each run of that text with
 *  formatting, as ['superscript', '2'] */
type Field = { items: FieldItem[]; shown: string; formatted: Array<[string, string]> };
type Trip = { first: Field; markdown: string; next: Field };
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FIELD_RE = /(CSL_CITATION )(.*?)( <\/w:instrText>[\s\S]*?fldCharType="separate"\/><\/w:r>)([\s\S]*?)(<w:r><w:fldChar w:fldCharType="end"\/>)/g;
const once = <T,>(make: () => Promise<T>) => { let made: Promise<T> | undefined; return () => made ??= make(); };

/** The citation fields of a document's body, in order: each one's items,
 *  without their data, and the text Word shows for it, with its formatting */
async function fields(docx: Uint8Array): Promise<Field[]> {
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  return [...xml.matchAll(FIELD_RE)].map(m => ({
    items: (JSON.parse(unescape(m[2])).citationItems as Array<Record<string, unknown>>).map(({ locator, label, prefix, suffix, 'suppress-author': sa }) =>
      JSON.parse(JSON.stringify({ locator, label, prefix, suffix, 'suppress-author': sa })) as FieldItem),
    shown: unescape([...m[4].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]).join('')),
    formatted: [...m[4].matchAll(/<w:rPr>(.*?)<\/w:rPr><w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(r =>
      [[...r[1].matchAll(/<w:(\w+)(?: w:val="([^"]*)")?\/>/g)].map(p => p[2] ?? p[1]).join(' '), unescape(r[2])] as [string, string]),
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
  const { docx, shown } = await zoteroDocument(cases);
  const imported = await convertDocx(docx);
  const next = await convertMdToDocx(imported.markdown, { bibtex: imported.bibtex });
  const [before, markdown, after] = [await fields(docx), paragraphs(imported.markdown), await fields(next.docx)];
  return cases.map((_c, k) => ({ shown: shown[k], first: before[k], markdown: markdown[k], next: after[k] }));
}

/** A document with a paragraph for each case, as fromZotero reads, and the
 *  text Word shows for each one's field */
async function zoteroDocument(cases: ZoteroCase[]): Promise<{ docx: Uint8Array; shown: string[] }> {
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
  return { docx: await zip.generateAsync({ type: 'uint8array' }), shown };
}

/** Each paragraph's Markdown at each of two imports from `docx`, and its
 *  field at the export after each */
async function twoTrips(docx: Uint8Array): Promise<{ markdowns: string[][]; exported: Field[][] }> {
  const markdowns: string[][] = [];
  const exported: Field[][] = [];
  let current = docx;
  for (let trip = 0; trip < 2; trip++) {
    const imported = await convertDocx(current);
    markdowns.push(paragraphs(imported.markdown));
    current = (await convertMdToDocx(imported.markdown, { bibtex: imported.bibtex })).docx;
    exported.push(await fields(current));
  }
  return { markdowns, exported };
}

const TERMS: Array<[label: string, term: string]> = [
  ['book', 'bk.'], ['chapter', 'chap.'], ['column', 'col.'], ['figure', 'fig.'], ['folio', 'fol.'], ['issue', 'no.'], ['line', 'l.'], ['note', 'n.'],
  ['opus', 'op.'], ['page', 'p.'], ['paragraph', 'para.'], ['part', 'pt.'], ['section', 'sec.'], ['sub verbo', 's.v.'], ['verse', 'v.'], ['volume', 'vol.'],
];

const SUFFIXES: Array<[string, FieldItem]> = [
  ['A [@doe2020, p. 33, emphasis added] b.\n', { locator: '33', label: 'page', suffix: ', emphasis added' }],
  ['A [@doe2020, chap. 2 and passim] b.\n', { locator: '2', label: 'chapter', suffix: ' and passim' }],
  ['A [@doe2020, emphasis added] b.\n', { suffix: ', emphasis added' }],
  // Not one of Pandoc's terms, nor of citeproc's: a suffix, shown as written
  ['A [@doe2020, Ch. 2] b.\n', { suffix: ', Ch. 2' }],
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

// citeproc's abbreviations, which main's export wrote as a page's locator,
// and Word showed as the label: each one's text, its field's item, and its
// Markdown at the import, with the label's own term where it has one
const COMPATIBLE: Array<[string, FieldItem, string]> = [
  ['ch. 2', { locator: '2', label: 'chapter' }, 'chap. 2'],
  ['ch. 2-3', { locator: '2-3', label: 'chapter' }, 'chaps. 2-3'],
  ['sv. 3', { locator: '3', label: 'sub verbo' }, 's.v. 3'],
  ['vrs. 2', { locator: '2', label: 'verse' }, 'v. 2'],
  ['app. A', { locator: 'A', label: 'appendix' }, 'app. A'],
  ['r. 2', { locator: '2', label: 'rule' }, 'r. 2'],
  ['supp. 2', { locator: '2', label: 'supplement' }, 'supp. 2'],
  ['tbl. 3', { locator: '3', label: 'table' }, 'tbl. 3'],
  ['sec. A', { locator: 'A', label: 'section' }, '{sec. A}'],
  ['fig. A', { locator: 'A', label: 'figure' }, '{fig. A}'],
  ['vol. A-C', { locator: 'A-C', label: 'volume' }, '{vol. A-C}'],
];
// Which main showed as chaps. 2, emphasis added, the suffix in the locator
const COMPATIBLE_SUFFIX = 'ch. 2, emphasis added';

const ZOTERO_COMPATIBLE: Array<[FieldItem, string]> = [
  [{ locator: 'A', label: 'appendix' }, 'app. A'],
  [{ locator: '2-3', label: 'table' }, 'tbl. 2-3'],
  [{ locator: '4', label: 'rule' }, 'r. 4'],
  [{ locator: '2', label: 'supplement' }, 'supp. 2'],
];

// What citeproc reads as markup in a suffix, which Word shows as written,
// as main showed a suffix in the locator, and in a prefix, which citeproc
// formats, as on main: each one's Markdown, its field's items, Word's text
// and its formatting
const AFFIXES: Array<[string, FieldItem[], string, Array<[string, string]>]> = [
  ['A [@doe2020, p. 2, <i>emphasis</i>] b.\n', [{ locator: '2', label: 'page', suffix: ', <i>emphasis</i>' }], '(Doe 2020, 2, <i>emphasis</i>)', []],
  ['A [@doe2020, p. 2, "emphasis added"] b.\n', [{ locator: '2', label: 'page', suffix: ', "emphasis added"' }], '(Doe 2020, 2, "emphasis added")', []],
  ["A [@doe2020, p. 2, it's 'x'] b.\n", [{ locator: '2', label: 'page', suffix: ", it's 'x'" }], "(Doe 2020, 2, it's 'x')", []],
  ['A [@doe2020, {}<sup>2</sup>] b.\n', [{ suffix: ', <sup>2</sup>' }], '(Doe 2020, <sup>2</sup>)', []],
  ['A [see "x" @doe2020] b.\n', [{ prefix: 'see "x"' }], '(see \u201cx\u201d Doe 2020)', []],
  ['A [\\<i>see\\</i> @doe2020, p. 2] b.\n', [{ locator: '2', label: 'page', prefix: '<i>see</i>' }], '(see Doe 2020, 2)', [['i', 'see']]],
];

// A brace no other closes, escaped: each one's Markdown and its field's item
const ESCAPES: Array<[string, FieldItem]> = [
  ['A [@doe2020, {p. A\\{B}] b.\n', { locator: 'A{B', label: 'page' }],
  ['A [@doe2020, {chap. A\\}B}, for more] b.\n', { locator: 'A}B', label: 'chapter', suffix: ', for more' }],
];

const ZOTERO_ESCAPES: Array<[FieldItem, string]> = [
  [{ locator: 'A{B', label: 'page' }, '{p. A\\{B}'],
  [{ locator: '2', label: 'page', suffix: ', see \\{x' }, 'p. 2, see \\\\\\{x'],
];

// A tag in a locator, part of its word, which main's export wrote as a
// page's locator and Word showed as its markup, and in a suffix after one,
// which Word shows as written, as main showed it in the locator: each
// one's text after the key, its field's item, Word's text and its
// formatting, and its Markdown at the import, as main wrote it
const LOCATOR_TAGS: Array<[string, FieldItem, string, Array<[string, string]>, string]> = [
  ['<sup>2</sup>', { locator: '<sup>2</sup>', label: 'page' }, '(Roe 2019, 2)', [['superscript', '2']], 'p. <sup>2</sup>'],
  ['<sub>2</sub>', { locator: '<sub>2</sub>', label: 'page' }, '(Roe 2019, 2)', [['subscript', '2']], 'p. <sub>2</sub>'],
  ['p. <i>iv</i>', { locator: '<i>iv</i>', label: 'page' }, '(Roe 2019, iv)', [['i', 'iv']], 'p. <i>iv</i>'],
  ['p. <sc>2</sc>', { locator: '<sc>2</sc>', label: 'page' }, '(Roe 2019, 2)', [['smallCaps', '2']], 'p. <sc>2</sc>'],
  ['p. <span class="nocase">2</span>', { locator: '<span class="nocase">2</span>', label: 'page' }, '(Roe 2019, 2)', [], 'p. <span class="nocase">2</span>'],
  ['<sup>2</sup>, emphasis added', { locator: '<sup>2</sup>', label: 'page', suffix: ', emphasis added' }, '(Roe 2019, 2, emphasis added)', [['superscript', '2']], 'p. <sup>2</sup>, emphasis added'],
  ['p. 2, <sup>a</sup>', { locator: '2', label: 'page', suffix: ', <sup>a</sup>' }, '(Roe 2019, 2, <sup>a</sup>)', [], 'p. 2, <sup>a</sup>'],
  // Which main wrote as a page's locator, sec. <b>2</b>, which citeproc
  // showed as the section's
  ['sec. <b>2</b>', { locator: '<b>2</b>', label: 'section' }, '(Roe 2019, sec. 2)', [['b', '2']], 'sec. <b>2</b>'],
];

// Zotero's locator with a tag, imported as main wrote it
const ZOTERO_TAGS: Array<[FieldItem, string, Array<[string, string]>]> = [
  [{ locator: '<sup>2</sup>', label: 'page' }, 'p. <sup>2</sup>', [['superscript', '2']]],
  [{ locator: '<i>iv</i>', label: 'chapter' }, 'chap. <i>iv</i>', [['i', 'iv']]],
];

const markdownTrips = once(() => fromMarkdown([...TERMS.map(([, term]) => 'A [@doe2020, ' + term + ' 2] b.\n'), ...SUFFIXES.map(([md]) => md), ...MORE, ...GUARDS.map(([md]) => md),
  ...COMPATIBLE.map(([text]) => 'A [@roe2019, ' + text + '] b.\n'), 'A [@roe2019, ' + COMPATIBLE_SUFFIX + '] b.\n',
  ...AFFIXES.map(([md]) => md), ...ESCAPES.map(([md]) => md), ...LOCATOR_TAGS.map(([text]) => 'A [@roe2019, ' + text + '] b.\n')]));
const zoteroTrips = once(() => fromZotero([
  ...TERMS.map(([label]) => ({ keys: ['doe2020'], items: [{ locator: '2', label }] })),
  ...ZOTERO_SUFFIXES.map(([item]) => ({ keys: ['doe2020'], items: [item] })),
  ...ZOTERO_MORE,
  // Edited by hand (see the guard below)
  { keys: ['doe2020'], items: [{ locator: '2', label: 'page' }], edited: '(Doe 2020, 2, my emphasis)' },
  ...ZOTERO_COMPATIBLE.map(([item]) => ({ keys: ['doe2020'], items: [item] })),
  ...ZOTERO_ESCAPES.map(([item]) => ({ keys: ['doe2020'], items: [item] })),
  // Zotero's markup in a suffix (see the test below)
  { keys: ['doe2020'], items: [{ locator: '2', label: 'page', suffix: ', <i>sic</i>' }] },
  ...ZOTERO_TAGS.map(([item]) => ({ keys: ['doe2020'], items: [item] })),
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

  const compatible = TERMS.length + SUFFIXES.length + MORE.length + GUARDS.length;
  const zoteroCompatible = TERMS.length + ZOTERO_SUFFIXES.length + ZOTERO_MORE.length + 1;

  // As Word showed main's field, which held the text as a page's locator
  it.each(COMPATIBLE.map((c, k) => [...c, compatible + k] as const))('exports %j with its label, as Word showed it before, and imports it back', async (text, item, back, k) => {
    const trip = await markdownTrip(k);
    expect(trip.first.items).toEqual([item]);
    expect(trip.first.shown).toBe(rendered(['roe2019'], [{ locator: text, label: 'page' }]));
    expect(trip.markdown).toBe('A [@roe2019, ' + back + '] b.\n');
    expect(trip.next).toEqual(trip.first);
  }, 60000);

  it('exports a suffix after citeproc\'s abbreviation\'s locator', async () => {
    const trip = await markdownTrip(compatible + COMPATIBLE.length);
    expect(trip.first.items).toEqual([{ locator: '2', label: 'chapter', suffix: ', emphasis added' }]);
    expect(trip.first.shown).toBe(rendered(['roe2019'], trip.first.items));
    expect(trip.markdown).toBe('A [@roe2019, chap. 2, emphasis added] b.\n');
    expect(trip.next).toEqual(trip.first);
  }, 60000);

  it.each(ZOTERO_COMPATIBLE.map((c, k) => [...c, zoteroCompatible + k] as const))('imports Zotero\'s %j with citeproc\'s abbreviation', async (item, written, k) => {
    const trip = await zoteroTrip(k);
    expect(trip.markdown).toBe('A [@doe2020, ' + written + '] b.\n');
    expect(trip.next.items).toEqual([item]);
    expect(trip.next.shown).toBe(trip.shown);
  }, 60000);

  const affixes = compatible + COMPATIBLE.length + 1;
  const escapes = affixes + AFFIXES.length;
  const zoteroEscapes = zoteroCompatible + ZOTERO_COMPATIBLE.length;

  it.each(AFFIXES.map((c, k) => [...c, affixes + k] as const))('shows the markup of %j in Word as main did', async (md, items, shown, formatted, k) => {
    const trip = await markdownTrip(k);
    expect(trip.first.items).toEqual(items);
    expect(trip.first.shown).toBe(shown);
    expect(trip.first.formatted).toEqual(formatted);
    expect(trip.markdown).toBe(md);
    expect(trip.next).toEqual(trip.first);
  }, 60000);

  it.each(ESCAPES.map((c, k) => [...c, escapes + k] as const))('exports the escaped brace in %j', async (md, item, k) => {
    const trip = await markdownTrip(k);
    expect(trip.first.items).toEqual([item]);
    expect(trip.markdown).toBe(md);
    expect(trip.next).toEqual(trip.first);
  }, 60000);

  // As main kept a locator, as p. A{B, which it read to the ]
  it.each(ZOTERO_ESCAPES.map((c, k) => [c[0], zoteroEscapes + k] as const))('keeps Zotero\'s %j through import and export', async (item, k) => {
    const trip = await zoteroTrip(k);
    expect(trip.next.items).toEqual([item]);
    expect(trip.next.shown).toBe(trip.shown);
  }, 60000);

  it.each(ZOTERO_ESCAPES.map((c, k) => [...c, zoteroEscapes + k] as const))('imports Zotero\'s %j with its braces escaped', async (_item, written, k) => {
    expect((await zoteroTrip(k)).markdown).toBe('A [@doe2020, ' + written + '] b.\n');
  }, 60000);

  // Not fixed: the field keeps Zotero's markup, as <i>sic</i>, which Zotero
  // shows when it refreshes the field, but Word's text at the next export
  // shows it as written, as citeproc has no escape for it
  it('keeps Zotero\'s markup in a suffix in the field, and shows it as written', async () => {
    const trip = await zoteroTrip(zoteroEscapes + ZOTERO_ESCAPES.length);
    expect(trip.markdown).toBe('A [@doe2020, p. 2, <i>sic</i>] b.\n');
    expect(trip.next.items).toEqual([{ locator: '2', label: 'page', suffix: ', <i>sic</i>' }]);
    expect(trip.next.shown).toBe('(Doe 2020, 2, <i>sic</i>)');
  }, 60000);

  const locatorTags = escapes + ESCAPES.length;
  const zoteroTags = zoteroEscapes + ZOTERO_ESCAPES.length + 1;

  it.each(LOCATOR_TAGS.map((c, k) => [...c, locatorTags + k] as const))('exports the tag in %j as part of the locator', async (text, item, shown, formatted, back, k) => {
    const trip = await markdownTrip(k);
    expect(trip.first.items).toEqual([item]);
    expect(trip.first.shown).toBe(shown);
    expect(trip.first.formatted).toEqual(formatted);
    expect(trip.markdown).toBe('A [@roe2019, ' + back + '] b.\n');
    expect(trip.next).toEqual(trip.first);
  }, 60000);

  it.each(ZOTERO_TAGS.map((c, k) => [...c, zoteroTags + k] as const))('imports Zotero\'s %j as main did', async (item, written, formatted, k) => {
    const trip = await zoteroTrip(k);
    expect(trip.markdown).toBe('A [@doe2020, ' + written + '] b.\n');
    expect(trip.next.items).toEqual([item]);
    expect(trip.next.shown).toBe(trip.shown);
    expect(trip.next.formatted).toEqual(formatted);
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

  // A suffix's markup goes to citeproc as private-use stand-ins (see
  // AFFIX_MARKUP), which came back as markup where citeproc showed one of
  // them already, as in a name: (Roe&#60; 2019) for every citation
  it('keeps a private-use character citeproc shows, as in a name', () => {
    const pua = String.fromCharCode(0xe000);
    const bib = '@book{roe2019,\n  author = {Roe' + pua + ', Rick},\n  title = {A Book},\n  publisher = {Pub},\n  year = {2019}\n}\n';
    const puaEngine = createCiteprocEngine(parseBibtex(bib), STYLE)!;
    expect(renderCitationText(puaEngine, ['roe2019'])).toBe('(Roe' + pua + ' 2019)');
    expect(renderCitationText(puaEngine, ['roe2019'], new Map([['roe2019', 'p. 2, see ' + pua]]))).toBe('(Roe' + pua + ' 2019, 2, see ' + pua + ')');
    // Where the suffix's markup is then citeproc's, as Zotero shows it
    expect(renderCitationText(puaEngine, ['roe2019'], new Map([['roe2019', 'p. 2, <i>sic</i>']]))).toBe('(Roe' + pua + ' 2019, 2, <i>sic</i>)');
    const plain = createCiteprocEngine(parseBibtex(BIB), STYLE)!;
    expect(renderCitationText(plain, ['roe2019'], new Map([['roe2019', 'p. 2, <i>sic</i>']]))).toBe('(Roe 2019, 2, &#60;i&#62;sic&#60;/i&#62;)');
  });

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

// A ;, a [, a ] and an @ in a citation's prefix, its locator and its
// suffix, which import dropped, so Zotero's pp. 2; 5 came back as p. 2 5
// and cf. @twitter as cf. twitter, and which export had no escape for, so
// [@doe2020, p. 2\; 5] ended its item at the ; and [@doe2020, p. 4 \[n. 2\]]
// its citation at the first ]. Escaped, as Pandoc reads them. Each case's
// field's items, its Markdown at each import, and, where Pandoc reads the
// locator otherwise, the items export writes, which citeproc shows the same
const ZOTERO_CHARACTERS: Array<[FieldItem[], string, FieldItem[]?]> = [
  [[{ locator: '2; 5', label: 'page' }], 'A [@doe2020, pp. 2\\; 5] b.\n'],
  [[{ locator: '4', label: 'page', suffix: '; also elsewhere' }], 'A [@doe2020, p. 4\\; also elsewhere] b.\n'],
  [[{ locator: '4 [n. 2]', label: 'page' }], 'A [@doe2020, p. 4 \\[n. 2\\]] b.\n', [{ locator: '4', label: 'page', suffix: ' [n. 2]' }]],
  [[{ locator: '3', label: 'page', suffix: ' ]x' }], 'A [@doe2020, p. 3 \\]x] b.\n'],
  [[{ prefix: 'cf. @twitter' }], 'A [cf. \\@twitter @doe2020] b.\n'],
  [[{ suffix: ', via @x' }], 'A [@doe2020, via \\@x] b.\n'],
  [[{ locator: '2', label: 'page', suffix: ', see [^1]' }], 'A [@doe2020, p. 2, see \\[^1\\]] b.\n'],
  [[{ locator: '2; 5', label: 'page' }, { prefix: 'see [also]' }], 'A [@doe2020, pp. 2\\; 5; see \\[also\\] @roe2019] b.\n'],
];

// Each case's Markdown and its field's items at the first export
const MARKDOWN_CHARACTERS: Array<[string, FieldItem[]]> = [
  ['A [@doe2020, pp. 2\\; 5] b.\n', [{ locator: '2; 5', label: 'page' }]],
  ['A [@doe2020, p. 4\\; also elsewhere] b.\n', [{ locator: '4', label: 'page', suffix: '; also elsewhere' }]],
  ['A [@doe2020, p. 4 \\[n. 2\\]] b.\n', [{ locator: '4', label: 'page', suffix: ' [n. 2]' }]],
  ['A [@doe2020, p. 3 \\]x] b.\n', [{ locator: '3', label: 'page', suffix: ' ]x' }]],
  ['A [cf. \\@twitter @doe2020] b.\n', [{ prefix: 'cf. @twitter' }]],
  ['A [@doe2020, via \\@x] b.\n', [{ suffix: ', via @x' }]],
  ['A [@doe2020, pp. 2\\; 5; see \\[also\\] @roe2019] b.\n', [{ locator: '2; 5', label: 'page' }, { prefix: 'see [also]' }]],
  // A \] that a later ] ends the citation after, with no [ before it, as
  // Pandoc reads it, where main ended the citation at the \]
  ['A [@doe2020, p. 3, so\\] y] b.\n', [{ locator: '3', label: 'page', suffix: ', so] y' }]],
];

// As main read them: a \] that ends the citation where no later ] does, or
// where a [ no backslash escapes comes first, whose backslash, a suffix's,
// Word shows. Each one's Markdown and its field's items
const MARKDOWN_CHARACTER_GUARDS: Array<[string, FieldItem[]]> = [
  ['A [@doe2020, p. 3\\] b.\n', [{ locator: '3', label: 'page', suffix: '\\' }]],
  ['A [@doe2020, x\\] and [b](https://e.org) d.\n', [{ suffix: ', x\\' }]],
  ['A [see @doe2020, p. 2; @roe2019, chap. 3, for more] b.\n', [{ locator: '2', label: 'page', prefix: 'see' }, { locator: '3', label: 'chapter', suffix: ', for more' }]],
];

// Not fixed: a [ or a ] in a citation whose first item has a prefix,
// which import drops, as main did, as export reads any [ there, escaped or
// not, as starting a later citation (see citationEnd): Zotero's field's
// items, its Markdown at each import, and the items export writes
const ZOTERO_BRACKETS_DROPPED: Array<[FieldItem[], string, FieldItem[]]> = [
  [[{ prefix: 'see [also]' }], 'A [see also @doe2020] b.\n', [{ prefix: 'see also' }]],
  [[{ prefix: 'see', locator: '4 [n. 2]', label: 'page' }], 'A [see @doe2020, {p. 4 n. 2}] b.\n', [{ prefix: 'see', locator: '4 n. 2', label: 'page' }]],
];

const keysIn = (md: string) => [...md.matchAll(/@(doe2020|roe2019)/g)].map(m => m[1]);
/** The fields of the first export of a document of these paragraphs'
 *  Markdown, and each import and export over two trips */
const markdownTwoTrips = async (paragraphs: string[]) => {
  const md = paragraphs.map((p, n) => 'P' + n + ' ' + p);
  const { docx } = await convertMdToDocx('---\ncsl: ' + STYLE + '\n---\n\n' + md.join('\n'), { bibtex: BIB });
  return { first: await fields(docx), ...(await twoTrips(docx)) };
};
const characterTrips = once(() => markdownTwoTrips(MARKDOWN_CHARACTERS.map(([md]) => md)));
// Apart, so main's fields of the cases above leave theirs in place
const characterGuardTrips = once(() => markdownTwoTrips(MARKDOWN_CHARACTER_GUARDS.map(([md]) => md)));
const zoteroCharacterTrips = once(async () => {
  const { docx, shown } = await zoteroDocument([...ZOTERO_CHARACTERS, ...ZOTERO_BRACKETS_DROPPED].map(([items, written]) => ({ keys: keysIn(written), items })));
  return { shown, ...(await twoTrips(docx)) };
});

describe('a citation\'s ;, [, ] and @ through Word, over two trips', () => {
  it.each(ZOTERO_CHARACTERS.map((c, k) => [c[0], c[1], c[2] ?? c[0], k] as const))('imports Zotero\'s %j escaped, as %j', async (_items, written, items, k) => {
    const { shown, markdowns, exported } = await zoteroCharacterTrips();
    expect(markdowns[0][k]).toBe(written);
    expect(exported[0][k].items).toEqual(items);
    expect(exported[0][k].shown).toBe(shown[k]);
    expect(markdowns[1][k]).toBe(written);
    expect(exported[1][k]).toEqual(exported[0][k]);
  }, 60000);

  it.each(MARKDOWN_CHARACTERS.map((c, k) => [...c, k] as const))('exports the escapes in %j', async (md, items, k) => {
    const { first, markdowns, exported } = await characterTrips();
    expect(first[k].items).toEqual(items);
    expect(first[k].shown).toBe(rendered(keysIn(md), items));
    expect(markdowns[0][k]).toBe(md);
    expect(exported[0][k]).toEqual(first[k]);
    expect(markdowns[1][k]).toBe(md);
    expect(exported[1][k]).toEqual(first[k]);
  }, 60000);

  // Which pass on main too
  it.each(ZOTERO_BRACKETS_DROPPED.map((c, k) => [...c, ZOTERO_CHARACTERS.length + k] as const))('Not fixed: imports Zotero\'s %j without its brackets, as %j, as main did', async (_items, written, items, k) => {
    const { markdowns, exported } = await zoteroCharacterTrips();
    expect(markdowns[0][k]).toBe(written);
    expect(exported[0][k].items).toEqual(items);
    expect(markdowns[1][k]).toBe(written);
    expect(exported[1][k]).toEqual(exported[0][k]);
  }, 60000);

  // Guards, which pass on main too: the field each export writes
  it.each(MARKDOWN_CHARACTER_GUARDS.map((c, k) => [...c, k] as const))('exports %j as main did', async (_md, items, k) => {
    const { first, markdowns, exported } = await characterGuardTrips();
    expect(first[k].items).toEqual(items);
    expect(exported[0][k]).toEqual(first[k]);
    expect(markdowns[1][k]).toBe(markdowns[0][k]);
    expect(exported[1][k]).toEqual(first[k]);
  }, 60000);
});
