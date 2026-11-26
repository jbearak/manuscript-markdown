import { describe, it, expect } from 'bun:test';
import { createZoteroLinkPlan, type ZoteroCatalogItem } from './zotero-link';
import {
  createZoteroPushPlan,
  pushItemKey,
  zoteroPushWrites,
  type ZoteroItemJson,
  type ZoteroItemSchema,
  type ZoteroPushMode,
} from './zotero-push';
import { applyZoteroPush, formatZoteroPushReport, prepareZoteroPush, type ZoteroKeyProvider } from './zotero-push-run';
import {
  authorizeZoteroLocalApi,
  fetchZoteroLibrarySnapshot,
  fetchZoteroSchema,
  writeZoteroItems,
  ZoteroLocalApiError,
  type ZoteroFetch,
} from './zotero-local-api';
import { resolveCollection, runZoteroCli } from './zotero-cli';
import { parseAuthors } from './md-to-docx-citations';

// A slice of Zotero 10's /api/schema: the types these tests use.
const field = (name: string, baseField?: string) => (baseField ? { field: name, baseField } : { field: name });
const SCHEMA: ZoteroItemSchema = {
  csl: {
    types: { 'article-journal': ['journalArticle'], chapter: ['bookSection'], report: ['report'] },
    names: { author: 'author', editor: 'editor', translator: 'translator' },
  },
  itemTypes: [
    {
      itemType: 'journalArticle',
      fields: ['title', 'publicationTitle', 'date', 'volume', 'issue', 'pages', 'series', 'DOI', 'url', 'accessDate', 'ISSN', 'citationKey', 'extra', 'abstractNote', 'shortTitle'].map(f => field(f)),
      creatorTypes: [{ creatorType: 'author' }, { creatorType: 'editor' }, { creatorType: 'translator' }],
    },
    {
      itemType: 'report',
      fields: [
        field('title'), field('reportNumber', 'number'), field('reportType', 'type'), field('institution', 'publisher'),
        field('place'), field('date'), field('seriesTitle'), field('pages'), field('DOI'), field('ISBN'), field('url'),
        field('citationKey'), field('extra'),
      ],
      creatorTypes: [{ creatorType: 'author' }, { creatorType: 'editor' }],
    },
    {
      itemType: 'book',
      fields: ['title', 'date', 'publisher', 'place', 'ISBN', 'url', 'citationKey', 'extra'].map(f => field(f)),
      creatorTypes: [{ creatorType: 'author' }, { creatorType: 'editor' }],
    },
    {
      itemType: 'bookSection',
      fields: [field('title'), field('bookTitle', 'publicationTitle'), field('date'), field('ISBN'), field('pages'), field('citationKey'), field('extra')],
      creatorTypes: [{ creatorType: 'author' }, { creatorType: 'editor' }],
    },
    {
      itemType: 'document',
      fields: ['title', 'date', 'publisher', 'place', 'url', 'citationKey', 'extra'].map(f => field(f)),
      creatorTypes: [{ creatorType: 'author' }],
    },
  ],
};

const COLLECTION = 'COLL0001';

function item(key: string, data: Record<string, unknown>): ZoteroItemJson {
  return {
    key,
    version: 10,
    itemType: 'journalArticle',
    collections: [COLLECTION],
    creators: [],
    uri: 'http://zotero.org/users/1/items/' + key,
    ...data,
  } as ZoteroItemJson;
}

function catalogOf(items: readonly ZoteroItemJson[]): ZoteroCatalogItem[] {
  return items.map(i => ({
    key: i.key,
    uri: 'http://zotero.org/users/1/items/' + i.key,
    title: typeof i.title === 'string' ? i.title : undefined,
    citationKey: typeof i.citationKey === 'string' ? i.citationKey : undefined,
    doi: typeof i.DOI === 'string' ? i.DOI : undefined,
    isbn: typeof i.ISBN === 'string' ? i.ISBN : undefined,
    year: i.parsedDate,
    containerTitle: typeof i.publicationTitle === 'string' ? i.publicationTitle : undefined,
    author: Array.isArray(i.creators) && i.creators.length > 0 ? (i.creators[0] as { lastName?: string }).lastName : undefined,
  }));
}

// The salt of the libraries libraryApi serves: its server id, user scope.
const TEST_SALT = 'SERVER\nuser';

function plan(bibText: string, items: readonly ZoteroItemJson[], mode: ZoteroPushMode = 'update', takenElsewhere: readonly string[] = []) {
  const link = createZoteroLinkPlan(bibText, catalogOf(items));
  return createZoteroPushPlan({
    bibText,
    decisions: link.decisions,
    items: new Map(items.map(i => [i.key, i])),
    schema: SCHEMA,
    collectionKey: COLLECTION,
    mode,
    keySalt: TEST_SALT,
    takenKeys: new Set([...items.map(i => i.key), ...takenElsewhere]),
  });
}

const FLATO = item('FLATO001', {
  title: 'The differential mortality of undesired infants in sub-Saharan Africa',
  publicationTitle: 'Demography',
  date: '2018-02-01',
  parsedDate: '2018-02-01',
  volume: '55',
  issue: '1',
  pages: '271–294',
  DOI: '10.1007/s13524-017-0638-3',
  citationKey: 'flato2018differential',
  creators: [
    { creatorType: 'author', firstName: 'Martin', lastName: 'Flatø' },
    { creatorType: 'translator', firstName: 'Ann', lastName: 'Other' },
  ],
});

// As Better BibTeX exports it: title-cased with protected words, an
// escaped letter in the name, a ligature dash, the year alone.
const FLATO_BIB = `@article{flato2018differential,
  title = {The Differential Mortality of Undesired Infants in {{Sub-Saharan Africa}}},
  author = {Flat{\\o}, Martin},
  year = 2018,
  journal = {Demography},
  volume = {55},
  number = {1},
  pages = {271--294},
  doi = {10.1007/s13524-017-0638-3},
  keywords = {/unread},
  file = {pdf/flato2018differential.pdf}
}
`;

describe('createZoteroPushPlan', () => {
  it('plans nothing for an export of the item it came from', () => {
    const p = plan(FLATO_BIB, [FLATO]);
    expect(p.changed).toBe(false);
    expect(p.actions).toEqual([{ kind: 'unchanged', entryKey: 'flato2018differential', itemKey: 'FLATO001', notPushed: [] }]);
  });

  it('reads a value Zotero keeps in Extra as the field it stands for', () => {
    const report = item('REPORT01', {
      itemType: 'report',
      title: 'Seeing the unseen',
      citationKey: 'unfpa2022seeing',
      extra: 'Series: State of world population 2022',
      date: '2022',
      parsedDate: '2022',
    });
    const bib = '@techreport{unfpa2022seeing,\n  title = {Seeing the Unseen},\n  year = 2022,\n  series = {State of World Population 2022}\n}\n';
    expect(plan(bib, [report]).changed).toBe(false);
  });

  it('changes what the entry changes, and keeps the other creators in place', () => {
    const bib = FLATO_BIB.replace('Flat{\\o}, Martin', 'Flat{\\o}, Martin and Smith, Jane').replace('year = 2018', 'year = 2019');
    const p = plan(bib, [FLATO]);
    const action = p.actions[0];
    expect(action.kind).toBe('update');
    if (action.kind !== 'update') return;
    expect(action.changes.map(c => c.field)).toEqual(['date', 'creators:author']);
    expect(action.patch).toEqual({
      key: 'FLATO001',
      version: 10,
      date: '2019',
      creators: [
        { creatorType: 'author', lastName: 'Flatø', firstName: 'Martin' },
        { creatorType: 'author', lastName: 'Smith', firstName: 'Jane' },
        { creatorType: 'translator', firstName: 'Ann', lastName: 'Other' },
      ],
    });
  });

  it("keeps Zotero's fuller date when the entry's parts agree", () => {
    expect(plan(FLATO_BIB.replace('year = 2018', 'year = 2018,\n  month = feb'), [FLATO]).changed).toBe(false);
    const p = plan(FLATO_BIB.replace('year = 2018', 'year = 2018,\n  month = mar'), [FLATO]);
    expect(p.actions[0].kind === 'update' && p.actions[0].patch.date).toBe('2018-03');
  });

  it('only adds a matched item to the collection in add mode', () => {
    const elsewhere = { ...FLATO, collections: ['OTHER001'] };
    const p = plan(FLATO_BIB.replace('year = 2018', 'year = 2019'), [elsewhere], 'add');
    expect(p.summary).toMatchObject({ added: 1, updated: 0 });
    const action = p.actions[0];
    expect(action.kind === 'update' && action.patch).toEqual({ key: 'FLATO001', version: 10, collections: ['OTHER001', COLLECTION] });
  });

  it('creates an entry Zotero lacks, in the collection, with its citation key', () => {
    const bib = `@techreport{doe2026new,
  title = {A New Report on {U.S.} Births},
  author = {Doe, Jane and {National Center for Health Statistics}},
  year = 2026,
  month = mar,
  number = {12},
  type = {Data Brief},
  institution = {NCHS},
  address = {Hyattsville, MD},
  note = {Hand added}
}
`;
    const p = plan(bib, [FLATO]);
    expect(p.actions).toEqual([
      {
        kind: 'create',
        entryKey: 'doe2026new',
        itemType: 'report',
        data: {
          itemType: 'report',
          title: 'A New Report on U.S. Births',
          reportNumber: '12',
          institution: 'NCHS',
          place: 'Hyattsville, MD',
          reportType: 'Data Brief',
          date: '2026-03',
          creators: [
            { creatorType: 'author', lastName: 'Doe', firstName: 'Jane' },
            { creatorType: 'author', name: 'National Center for Health Statistics' },
          ],
          citationKey: 'doe2026new',
          collections: [COLLECTION],
          key: pushItemKey(TEST_SALT, 'doe2026new'),
          version: 0,
        },
        notPushed: [{ field: 'note', reason: 'no-zotero-field' }],
      },
    ]);
  });

  it('never writes a value that still holds TeX', () => {
    const bib = FLATO_BIB.replace('{{Sub-Saharan Africa}}', '\\emph{Sub-Saharan Africa}, Revised');
    const p = plan(bib, [FLATO]);
    expect(p.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'title', reason: 'tex' }] });
    // Zotero's own text, the formatting set aside, is no difference to report.
    const same = plan(FLATO_BIB.replace('{{Sub-Saharan Africa}}', '\\emph{Sub-Saharan Africa}'), [FLATO]);
    expect(same.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
  });

  it('leaves an entry matched only by its metadata alone', () => {
    const bib = FLATO_BIB.replace('flato2018differential,', 'someotherkey,').replace(/ {2}doi = .*\n/, '');
    const p = plan(bib, [FLATO]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'weak-match' });
    expect(zoteroPushWrites(p)).toEqual([]);
  });

  it("leaves an entry alone when its DOI isn't its item's", () => {
    const p = plan(FLATO_BIB.replace('10.1007/s13524-017-0638-3', '10.1/other'), [FLATO]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'identity-disagreement' });
  });

  it("leaves an entry linked to another library's item with the same key alone", () => {
    const bib = FLATO_BIB.replace(
      'keywords = {/unread},',
      'zotero-key = {FLATO001},\n  zotero-uri = {http://zotero.org/groups/9/items/FLATO001},\n  keywords = {/unread},',
    );
    const p = plan(bib.replace('year = 2018', 'year = 2019'), [FLATO]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'other-library' });
  });

  it("leaves an item alone that Zotero would rewrite from its Extra on any save", () => {
    const withExtra = { ...FLATO, collections: [], volume: undefined, extra: 'Volume: 55' };
    const p = plan(FLATO_BIB, [withExtra as ZoteroItemJson], 'add');
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'extra-would-migrate', detail: 'Volume' });
    // A line naming a field the type lacks stays in Extra, so it's no bar.
    const series = { ...FLATO, collections: [], extra: 'Original title: Something' };
    expect(plan(FLATO_BIB, [series as ZoteroItemJson], 'add').actions[0].kind).toBe('update');
  });

  it("won't give an item a DOI another item has", () => {
    const other = item('OTHER001', { title: 'Other', DOI: '10.1/taken', citationKey: 'other2000' });
    const noDoi = { ...FLATO, DOI: undefined } as unknown as ZoteroItemJson;
    const p = plan(FLATO_BIB.replace('10.1007/s13524-017-0638-3', '10.1/taken'), [noDoi, other]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'doi-owned-elsewhere', detail: 'OTHER001' });
  });

  it("reads an item's DOI from Extra too", () => {
    const extraDoi = { ...FLATO, DOI: undefined, extra: 'DOI: 10.1/real' } as unknown as ZoteroItemJson;
    const p = plan(FLATO_BIB.replace('10.1007/s13524-017-0638-3', '10.1/other'), [extraDoi]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'identity-disagreement' });
  });

  it("doesn't take a chapter for its book by their shared ISBN", () => {
    const book = item('BOOK0001', { itemType: 'book', title: 'The Book', ISBN: '9780306406157', citationKey: 'book2000', creators: [] });
    const chapter = '@incollection{chapter2000,\n  title = {A Chapter},\n  booktitle = {The Book},\n  isbn = {978-0-306-40615-7}\n}\n';
    expect(plan(chapter, [book]).actions[0]).toMatchObject({ kind: 'skip', reason: 'weak-match' });
  });

  it("doesn't write a macro's name for its text", () => {
    const bib = '@string{dem = {Demography}}\n' + FLATO_BIB.replace('journal = {Demography}', 'journal = dem');
    expect(plan(bib, [FLATO]).actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'journal', reason: 'macro' }] });
  });

  it("reads 'and others' as the start of the list", () => {
    const two = { ...FLATO, creators: [...(FLATO.creators as unknown[]), { creatorType: 'author', firstName: 'Jane', lastName: 'Smith' }] };
    const bib = FLATO_BIB.replace('Flat{\\o}, Martin', 'Flat{\\o}, Martin and others');
    expect(plan(bib, [two as ZoteroItemJson]).changed).toBe(false);
    const wrong = plan(bib.replace('Flat{\\o}, Martin', 'Doe, Ann'), [two as ZoteroItemJson]);
    expect(wrong.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'author', reason: 'incomplete-names' }] });
    const created = plan(bib, []).actions[0];
    expect(created.kind === 'create' && created.data.creators).toEqual([{ creatorType: 'author', lastName: 'Flatø', firstName: 'Martin' }]);
  });

  it('leaves alone an entry whose identifier is written with TeX the matcher reads otherwise', () => {
    const p = plan(FLATO_BIB.replace('keywords', 'url = {\\url{https://x.org/a\\_b}},\n  keywords'), [FLATO]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'unreadable-identifier', detail: 'url' });
  });

  it("reads escaped punctuation in an ISSN but won't write braces", () => {
    const withIssn = { ...FLATO, ISSN: '0070-3370' };
    expect(plan(FLATO_BIB.replace('keywords', 'issn = {0070-3370},\n  keywords'), [withIssn as ZoteroItemJson]).changed).toBe(false);
    const braced = plan(FLATO_BIB.replace('keywords', 'issn = {0070{-}3371},\n  keywords'), [withIssn as ZoteroItemJson]);
    expect(braced.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'issn', reason: 'tex' }] });
  });

  it('only takes a DOI-shaped DOI', () => {
    const noDoi = { ...FLATO, DOI: undefined } as unknown as ZoteroItemJson;
    const p = plan(FLATO_BIB.replace('10.1007/s13524-017-0638-3', '10.x/'), [noDoi]);
    expect(p.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'doi', reason: 'unreadable-doi' }] });
  });

  it('reads Type: lines by CSL names too, and legacy {:field:value} lines', () => {
    const cases: Array<[string, boolean]> = [
      ['Type: chapter', true],
      ['Type: article-journal', true],
      ['Type: journalArticle', true],
      ['type: JournalArticle', false],
      ['Original author: Smith, Ann', false],
      ['Issued: 2001-2002', false],
      ['{:volume:13}', true],
      ['Type: article', false],
      ['Original title: Something', false],
    ];
    for (const [extra, skipped] of cases) {
      const it = { ...FLATO, collections: [], volume: undefined, extra };
      const action = plan(FLATO_BIB.replace(/ {2}volume = .*\n/, ''), [it as ZoteroItemJson], 'add').actions[0];
      expect([extra, action.kind === 'skip' && action.reason]).toEqual([extra, skipped ? 'extra-would-migrate' : false]);
    }
  });

  it("reads a base field's label as the type's own field", () => {
    const report = item('REPORT02', { itemType: 'report', title: 'R', citationKey: 'r2000', collections: [], extra: 'Publisher: NCHS' });
    const action = plan('@techreport{r2000,\n  title = {R}\n}\n', [report], 'add').actions[0];
    expect(action).toMatchObject({ kind: 'skip', reason: 'extra-would-migrate', detail: 'Publisher' });
  });

  it("reads a base field's label whatever the type's own field holds", () => {
    const report = item('REPORT03', { itemType: 'report', title: 'R', citationKey: 'r2001', collections: [], institution: 'A', extra: 'Publisher: B' });
    expect(plan('@techreport{r2001,\n  title = {R}\n}\n', [report], 'add').actions[0]).toMatchObject({ reason: 'extra-would-migrate' });
  });

  it('takes an ISBN only for a whole work', () => {
    const dictionary = item('DICT0001', { itemType: 'book', title: 'The Dictionary', ISBN: '9780306406157', citationKey: 'dict2000' });
    const entry = '@inreference{word2000,\n  title = {A Word},\n  isbn = {978-0-306-40615-7}\n}\n';
    expect(plan(entry, [dictionary]).actions[0]).toMatchObject({ kind: 'skip', reason: 'weak-match' });
  });

  it("doesn't take a match by a value that isn't a DOI", () => {
    const odd = item('ODD00001', { title: 'Other', DOI: '10.x/', citationKey: 'odd2000' });
    const bib = FLATO_BIB.replace('flato2018differential,', 'someone2018,').replace('10.1007/s13524-017-0638-3', '10.x/');
    expect(plan(bib, [odd]).actions[0]).toMatchObject({ kind: 'skip', reason: 'weak-match' });
  });

  it('reads identifiers as written, before the parser reads TeX away', () => {
    const bib = '@article{x2000,\n  title = {X},\n  pmid = {\\url{12345678}}\n}\n';
    expect(plan(bib, []).actions[0]).toMatchObject({ kind: 'skip', reason: 'unreadable-identifier', detail: 'pmid' });
  });

  it("counts only the DOIs it would write in collisions", () => {
    const bib = '@article{a2000,\n  title = {A},\n  doi = {{10.1234/a}}\n}\n\n@article{b2000,\n  title = {B},\n  doi = {10.1234/a}\n}\n';
    expect(plan(bib, []).actions.map(a => a.kind)).toEqual(['create', 'create']);
  });

  it("won't give an item a PMID it doesn't have, or another item's", () => {
    const withPmid = { ...FLATO, PMID: '11111111' };
    const other = item('OTHER002', { title: 'Other', PMID: '22222222', citationKey: 'other2001' });
    const bib = FLATO_BIB.replace(/ {2}doi = .*\n/, '').replace('keywords', 'pmid = {22222222},\n  keywords');
    expect(plan(bib, [withPmid as ZoteroItemJson, other]).actions[0]).toMatchObject({ kind: 'skip', reason: 'pmid-disagreement' });
    const noPmid = plan(bib, [FLATO, other]).actions[0];
    expect(noPmid).toMatchObject({ kind: 'skip', reason: 'pmid-disagreement', detail: 'FLATO001, OTHER002' });
  });

  it("doesn't take a book for a chapter of it by their shared ISBN", () => {
    const chapter = item('CHAP0001', { itemType: 'bookSection', title: 'A Chapter', ISBN: '9780306406157', citationKey: 'chap2000' });
    const book = '@book{book2000,\n  title = {The Book},\n  isbn = {978-0-306-40615-7}\n}\n';
    expect(plan(book, [chapter]).actions[0]).toMatchObject({ kind: 'skip', reason: 'weak-match' });
  });

  it('takes an https link for the same item', () => {
    const bib = FLATO_BIB.replace(
      'keywords = {/unread},',
      'zotero-key = {FLATO001},\n  zotero-uri = {https://zotero.org/users/1/items/FLATO001},\n  keywords = {/unread},',
    );
    expect(plan(bib, [FLATO]).actions[0].kind).toBe('unchanged');
  });

  it('reads only real dates and standard month names', () => {
    const forthcoming = { ...FLATO, date: 'forthcoming', parsedDate: undefined } as ZoteroItemJson;
    for (const date of ['2024-99-99', '2023-02-29']) {
      const impossible = plan(FLATO_BIB.replace('year = 2018', `date = {${date}}`), [forthcoming]);
      expect(impossible.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'year', reason: 'date-unreadable' }] });
    }
    expect(plan(FLATO_BIB.replace('year = 2018', 'date = {2024-02-29}'), [forthcoming]).actions[0].kind).toBe('update');
    const custom = plan('@string{janissue = {August}}\n' + FLATO_BIB.replace('year = 2018', 'year = 2018,\n  month = janissue'), [FLATO]);
    expect(custom.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'year', reason: 'macro' }] });
    const named = plan(FLATO_BIB.replace('year = 2018', 'year = 2018,\n  month = {February}'), [FLATO]);
    expect(named.changed).toBe(false);
    // A date field is read before year, so a year macro beside it is no bar.
    const both = plan('@string{yr = {2018}}\n' + FLATO_BIB.replace('year = 2018', 'year = yr,\n  date = {2018-02-01}'), [FLATO]);
    expect(both.changed).toBe(false);
  });

  it("keeps Zotero's access time on the same day", () => {
    const accessed = { ...FLATO, accessDate: '2020-01-01T14:32:02Z' };
    const bib = FLATO_BIB.replace('keywords', 'urldate = {2020-01-01},\n  keywords');
    const same = plan(bib, [accessed as ZoteroItemJson]);
    expect(same.actions[0]).toEqual({ kind: 'unchanged', entryKey: 'flato2018differential', itemKey: 'FLATO001', notPushed: [] });
    const other = plan(bib.replace('2020-01-01', '2020-01-02'), [accessed as ZoteroItemJson]).actions[0];
    expect(other.kind === 'update' && other.patch.accessDate).toBe('2020-01-02');
    // Zotero would drop an access date it can't read, and the one it had.
    for (const bad of ['not recorded', '2020-01-02T:', '2020-02-30', '2020-01-02T25:00:00Z', '2020-01-02 10:30:00']) {
      const unreadable = plan(bib.replace('2020-01-01', bad), [accessed as ZoteroItemJson]).actions[0];
      expect([bad, unreadable]).toMatchObject([bad, { kind: 'unchanged', notPushed: [{ field: 'urldate', reason: 'date-unreadable' }] }]);
    }
    const timed = plan(bib.replace('2020-01-01', '2020-01-02T10:30:00Z'), [accessed as ZoteroItemJson]).actions[0];
    expect(timed.kind === 'update' && timed.patch.accessDate).toBe('2020-01-02T10:30:00Z');
    // A time on the same day is still a different time.
    const sameDay = plan(bib.replace('2020-01-01', '2020-01-01T09:00:00Z'), [accessed as ZoteroItemJson]).actions[0];
    expect(sameDay.kind === 'update' && sameDay.patch.accessDate).toBe('2020-01-01T09:00:00Z');
  });

  it("tells an organization's one-field name from a person's", () => {
    const smith = { ...FLATO, creators: [{ creatorType: 'author', lastName: 'Smith', firstName: 'Jane' }] };
    const p = plan(FLATO_BIB.replace('Flat{\\o}, Martin', '{Smith, Jane}'), [smith as ZoteroItemJson]);
    expect(p.actions[0].kind === 'update' && p.actions[0].patch.creators).toEqual([{ creatorType: 'author', name: 'Smith, Jane' }]);
  });

  it("counts a DOI an entry gives though its item won't be written", () => {
    // A skipped entry still names its work, so another can't take its DOI.
    const blocked = item('BLOCK001', { title: 'A', citationKey: 'a2000', extra: 'Type: book' });
    const bib = '@article{a2000,\n  title = {A},\n  doi = {10.1234/a}\n}\n\n@article{b2000,\n  title = {B},\n  doi = {10.1234/a}\n}\n';
    expect(plan(bib, [blocked]).actions.map(a => (a.kind === 'skip' ? a.reason : a.kind))).toEqual(['duplicate-doi', 'duplicate-doi']);
  });

  it('counts a DOI from entries skipped for sharing an item', () => {
    const target = item('SHARED01', { title: 'A', citationKey: 'a2000' });
    const bib =
      '@article{a2000,\n  title = {A},\n  doi = {10.1234/a}\n}\n\n' +
      '@article{b2000,\n  title = {A},\n  zotero-key = {SHARED01},\n  zotero-uri = {http://zotero.org/users/1/items/SHARED01}\n}\n\n' +
      '@article{c2000,\n  title = {C},\n  doi = {10.1234/a}\n}\n';
    expect(plan(bib, [target]).actions.map(a => (a.kind === 'skip' ? a.reason : a.kind))).toEqual([
      'duplicate-doi',
      'duplicate-target',
      'duplicate-doi',
    ]);
  });

  it('counts a DOI two new entries share though one item type can\'t hold it', () => {
    // The test schema's book has no DOI field; the two entries still name
    // one work.
    const bib = '@book{a2000,\n  title = {A},\n  doi = {10.1234/a}\n}\n\n@article{b2000,\n  title = {B},\n  doi = {10.1234/a}\n}\n';
    expect(plan(bib, []).actions.map(a => a.kind)).toEqual(['skip', 'skip']);
    const misc = '@misc{a,\n  title = {A},\n  pmid = {222}\n}\n\n@misc{b,\n  title = {A},\n  pmid = {222}\n}\n';
    expect(plan(misc, []).actions).toMatchObject([
      { kind: 'skip', reason: 'duplicate-identifier' },
      { kind: 'skip', reason: 'duplicate-identifier' },
    ]);
  });

  it("counts the DOI of an entry it can't create", () => {
    const bib = '@inreference{a2000,\n  title = {A},\n  doi = {10.1234/a}\n}\n\n@article{b2000,\n  title = {B},\n  doi = {10.1234/a}\n}\n';
    expect(plan(bib, []).actions.map(a => a.kind === 'skip' ? a.reason : a.kind)).toEqual(['duplicate-doi', 'duplicate-doi']);
  });

  it("replaces a free-text date Zotero can't read", () => {
    const forthcoming = { ...FLATO, date: 'forthcoming', parsedDate: undefined };
    const p = plan(FLATO_BIB, [forthcoming as ZoteroItemJson]);
    expect(p.actions[0].kind === 'update' && p.actions[0].changes).toEqual([{ field: 'date', from: 'forthcoming', to: '2018' }]);
  });

  it('leaves two entries for one item alone', () => {
    const twin = FLATO_BIB.replace('flato2018differential,', 'flatotwin,');
    const p = plan(FLATO_BIB + '\n' + twin, [FLATO]);
    expect(p.actions.map(a => a.kind === 'skip' && a.reason)).toEqual(['duplicate-target', 'duplicate-target']);
  });
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: unknown[];
}

function writeFetch(
  respond: (sent: Sent, n: number) => { status: number; body?: unknown; version?: number; text?: string },
  /** What the between-batch check finds changed since a version. */
  changedSince: () => unknown[] = () => [],
) {
  const sent: Sent[] = [];
  const fetchFn: ZoteroFetch = async (url, init) => {
    if (url.includes('/items?since=')) return { ok: true, status: 200, json: async () => changedSince() };
    const s = { url, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '[]') as unknown[] };
    sent.push(s);
    const r = respond(s, sent.length);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => r.text ?? '',
      headers: { get: (name: string) => (name === 'Last-Modified-Version' && r.version !== undefined ? String(r.version) : null) },
    };
  };
  return { fetchFn, sent };
}

describe('writeZoteroItems', () => {
  it('sends the key, server, version and write token, and reads each outcome by index', async () => {
    const { fetchFn, sent } = writeFetch(() => ({
      status: 200,
      version: 12,
      body: {
        successful: { '0': { key: 'NEWKEY01', version: 12 } },
        unchanged: { '1': 'FLATO001' },
        failed: { '2': { key: 'GONE0001', code: 412, message: 'item version mismatch' } },
      },
    }));
    const result = await writeZoteroItems(
      { type: 'group', groupId: 7 },
      [{ itemType: 'report' }, { key: 'FLATO001', version: 10 }, { key: 'GONE0001', version: 3 }],
      { apiKey: 'KEY', serverId: 'SERVER', libraryVersion: 11, writeToken: 'token123' },
      { fetchFn },
    );
    expect(sent[0].url).toBe('http://localhost:23119/api/groups/7/items');
    expect(sent[0].headers).toMatchObject({
      'Zotero-API-Key': 'KEY',
      'Zotero-Server-ID': 'SERVER',
      'If-Unmodified-Since-Version': '11',
      'Zotero-Write-Token': 'token123',
    });
    expect(result).toEqual({
      libraryVersion: 12,
      outcomes: [
        { status: 'success', key: 'NEWKEY01', version: 12 },
        { status: 'unchanged', key: 'FLATO001' },
        { status: 'failed', key: 'GONE0001', code: 412, message: 'item version mismatch' },
      ],
    });
  });

  it('tells a refused key and a changed library apart', async () => {
    const write = (status: number) =>
      writeZoteroItems({ type: 'user' }, [{ itemType: 'report' }], { apiKey: 'K', serverId: 'S', libraryVersion: 1, writeToken: 'token123' }, {
        fetchFn: writeFetch(() => ({ status, text: 'nope' })).fetchFn,
      }).catch((e: ZoteroLocalApiError) => e.kind);
    expect(await write(401)).toBe('unauthorized');
    expect(await write(412)).toBe('library-changed');
    expect(await write(403)).toBe('write-denied');
    const disabled = await writeZoteroItems({ type: 'user' }, [{ itemType: 'report' }], { apiKey: 'K', serverId: 'S', libraryVersion: 1, writeToken: 'token123' }, {
      fetchFn: writeFetch(() => ({ status: 403, text: 'Local API is not enabled' })).fetchFn,
    }).catch((e: ZoteroLocalApiError) => e.kind);
    expect(disabled).toBe('api-disabled');
  });
});

describe('authorizeZoteroLocalApi', () => {
  it('names the Zotero it asks, as Zotero requires of every POST', async () => {
    const { fetchFn, sent } = writeFetch(() => ({ status: 200, body: { key: 'NEWKEY', remember: true } }));
    expect(await authorizeZoteroLocalApi('App', 'SERVER', { fetchFn })).toEqual({ key: 'NEWKEY', remember: true });
    expect(sent[0].url).toBe('http://localhost:23119/api/local/authorize');
    expect(sent[0].headers['Zotero-Server-ID']).toBe('SERVER');
  });
});

describe('fetchZoteroSchema', () => {
  const schemaFetch = (body: unknown): ZoteroFetch => async () => ({ ok: true, status: 200, json: async () => body });
  const good = { itemType: 'report', fields: [{ field: 'title' }], creatorTypes: [{ creatorType: 'author' }] };
  it('reads a whole schema', async () => {
    const schema = await fetchZoteroSchema({ fetchFn: schemaFetch({ itemTypes: [good], csl: { types: { report: ['report'] }, names: {}, fields: { text: {}, date: {} } } }) });
    expect(schema.itemTypes.map(t => t.itemType)).toEqual(['report']);
  });
  it('refuses one with a malformed type or CSL mapping, rather than reading less of it', async () => {
    const bad = [
      { itemTypes: [good, { itemType: 'book', fields: [null], creatorTypes: [] }] },
      { itemTypes: [good], csl: { fields: { text: { title: null } } } },
      { itemTypes: [good], csl: { types: { chapter: 'bookSection' } } },
    ];
    for (const body of bad) {
      expect(await fetchZoteroSchema({ fetchFn: schemaFetch(body) }).catch((e: ZoteroLocalApiError) => e.kind)).toBe('request-failed');
    }
  });
});

describe('fetchZoteroLibrarySnapshot', () => {
  it("lets the matcher see Zotero 10's PMID field", async () => {
    const row = {
      key: 'PMID0001',
      library: { type: 'user', id: 1 },
      // The field, not a stale line of Extra, is the one to match on.
      data: { key: 'PMID0001', version: 3, itemType: 'journalArticle', title: 'Paper', PMID: '12345678', extra: 'PMID: 99999999', creators: [] },
      meta: {},
    };
    const fetchFn: ZoteroFetch = async url => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('format=versions') ? { PMID0001: 3 } : [row]),
      headers: { get: (n: string) => (n === 'Last-Modified-Version' ? '7' : n === 'Zotero-Server-ID' ? 'S' : null) },
    });
    const snapshot = await fetchZoteroLibrarySnapshot({ type: 'user' }, { fetchFn });
    const bib = '@article{renamed,\n  title = {A Revised Title},\n  pmid = {12345678}\n}\n';
    const decision = createZoteroLinkPlan(bib, snapshot.catalog).decisions[0];
    expect(decision).toMatchObject({ outcome: 'update', tier: 'isbn-pmid', target: { key: 'PMID0001' } });
    expect(snapshot.libraryVersion).toBe(7);
  });
});

describe('applyZoteroPush, when the key store fails', () => {
  it('keeps the writes already made', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `@article{key${i},\n  title = {Title ${i}},\n  year = 2020\n}\n`).join('\n');
    const prepared = { plan: plan(many, []), serverId: 'S', libraryVersion: 1 };
    let calls = 0;
    const provider: ZoteroKeyProvider = {
      async get() {
        if (++calls > 1) throw new Error('keychain locked');
        return 'KEY';
      },
      async invalidate() {},
    };
    const { fetchFn } = writeFetch(
      s => ({ status: 200, version: 2, body: { successful: Object.fromEntries(s.body.map((_, i) => [String(i), { key: 'W' + String(i).padStart(7, '0'), version: 2 }])) } }),
      () => [],
    );
    const result = await applyZoteroPush({ type: 'user' }, prepared, provider, { fetchFn });
    expect(result.error?.message).toContain('keychain locked');
    expect(result.outcomes.slice(0, 50).every(o => o !== undefined && o !== 'unknown' && o.status === 'success')).toBe(true);
    expect(result.outcomes.slice(0, 50).length).toBe(50);
    expect(result.outcomes[50]).toBeUndefined();
  });
});

describe('applyZoteroPush', () => {
  const many = Array.from({ length: 51 }, (_, i) => `@article{key${i},\n  title = {Title ${i}},\n  year = 2020\n}\n`).join('\n');
  const prepared = { plan: plan(many, []), serverId: 'SERVER', libraryVersion: 5 };

  function keys(): ZoteroKeyProvider & { invalidated: number } {
    const provider = {
      invalidated: 0,
      async get() {
        return provider.invalidated === 0 ? 'OLD' : 'NEW';
      },
      async invalidate() {
        provider.invalidated++;
      },
    };
    return provider;
  }

  it('writes 50 at a time, each batch at the version the last one left', async () => {
    const { fetchFn, sent } = writeFetch((s, n) => ({
      status: 200,
      version: 5 + n,
      body: { successful: Object.fromEntries(s.body.map((_, i) => [String(i), { key: 'K000000' + n, version: 5 + n }])) },
    }));
    const result = await applyZoteroPush({ type: 'user' }, prepared, keys(), { fetchFn });
    expect(sent.map(s => [s.body.length, s.headers['If-Unmodified-Since-Version']])).toEqual([[50, '5'], [1, '6']]);
    expect(result.error).toBeUndefined();
    expect(result.outcomes.every(o => o?.status === 'success')).toBe(true);
    expect(formatZoteroPushReport(prepared.plan, 'Coll', result)).toContain('+ key50: create a journalArticle [done: K0000002]');
  });

  it('asks for a key again once when Zotero refuses one', async () => {
    const provider = keys();
    const { fetchFn, sent } = writeFetch(s =>
      s.headers['Zotero-API-Key'] === 'OLD'
        ? { status: 401 }
        : { status: 200, version: 9, body: { successful: Object.fromEntries(s.body.map((_, i) => [String(i), { key: 'NEW0000' + i, version: 9 }])) } },
      () => [{ key: 'NEW00000', version: 9 }],
    );
    const result = await applyZoteroPush({ type: 'user' }, prepared, provider, { fetchFn });
    expect(provider.invalidated).toBe(1);
    expect(sent.map(s => s.headers['Zotero-API-Key'])).toEqual(['OLD', 'NEW', 'NEW']);
    expect(result.error).toBeUndefined();
    expect(result.outcomes.every(o => o !== undefined && o !== 'unknown' && o.status === 'success')).toBe(true);
  });

  it("stops before a batch when another writer changed the library during the last", async () => {
    const { fetchFn, sent } = writeFetch(
      s => ({ status: 200, version: 6, body: { successful: Object.fromEntries(s.body.map((_, i) => [String(i), { key: 'MINE' + String(i).padStart(4, '0'), version: 6 }])) } }),
      () => [{ key: 'MINE0000', version: 6 }, { key: 'THEIRS01', version: 6 }],
    );
    const result = await applyZoteroPush({ type: 'user' }, prepared, keys(), { fetchFn });
    expect(sent.length).toBe(1);
    expect(result.error?.kind).toBe('library-changed');
    expect(result.error?.message).toContain('THEIRS01');
    expect(result.outcomes[50]).toBeUndefined();
  });

  it('stops before a batch when another writer changed an item the push just wrote', async () => {
    // The other writer's edit lands while the batch saves, so the batch's
    // own library version (7) already includes it and the next batch's
    // version check alone would pass; only the item's version tells.
    const { fetchFn, sent } = writeFetch(
      s => ({ status: 200, version: 7, body: { successful: Object.fromEntries(s.body.map((_, i) => [String(i), { key: 'MINE' + String(i).padStart(4, '0'), version: 6 }])) } }),
      () => [{ key: 'MINE0000', version: 7 }],
    );
    const result = await applyZoteroPush({ type: 'user' }, prepared, keys(), { fetchFn });
    expect(sent.length).toBe(1);
    expect(result.error?.message).toContain('MINE0000');
    expect(result.outcomes.slice(0, 50)).toEqual(
      Array.from({ length: 50 }, (_, i) => ({ status: 'success', key: 'MINE' + String(i).padStart(4, '0'), version: 6 })),
    );
    expect(result.outcomes[50]).toBeUndefined();
  });

  it("stops before a batch when Zotero didn't say the library's version", async () => {
    const { fetchFn, sent } = writeFetch(s => ({ status: 200, body: { successful: Object.fromEntries(s.body.map((_, i) => [String(i), { key: 'K' + i, version: 1 }])) } }));
    const result = await applyZoteroPush({ type: 'user' }, prepared, keys(), { fetchFn });
    expect(sent.length).toBe(1);
    expect(result.error?.kind).toBe('request-failed');
  });

  it("marks a batch whose answer never came as unknown, not unsent", async () => {
    const fetchFn: ZoteroFetch = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    const result = await applyZoteroPush({ type: 'user' }, prepared, keys(), { fetchFn });
    expect(result.error?.kind).toBe('timeout');
    expect(result.outcomes.slice(0, 50)).toEqual(Array.from({ length: 50 }, () => 'unknown'));
    expect(result.outcomes[50]).toBeUndefined();
  });

  it('marks a batch as unknown when the connection drops, which may be after sending', async () => {
    const fetchFn: ZoteroFetch = async () => {
      throw new TypeError('socket hang up');
    };
    const result = await applyZoteroPush({ type: 'user' }, prepared, keys(), { fetchFn });
    expect(result.outcomes[0]).toBe('unknown');
  });

  it('stops at a changed library and sends nothing more', async () => {
    const { fetchFn, sent } = writeFetch(() => ({ status: 412, text: 'Library has been modified' }));
    const result = await applyZoteroPush({ type: 'user' }, prepared, keys(), { fetchFn });
    expect(sent.length).toBe(1);
    expect(result.error?.kind).toBe('library-changed');
    expect(result.outcomes.every(o => o === undefined)).toBe(true);
  });
});

describe('zotero CLI', () => {
  const collections = [
    { key: 'AAAA0001', name: 'Papers', path: 'Papers', itemCount: 1 },
    { key: 'BBBB0001', name: 'Drafts', path: 'Papers / Drafts', itemCount: 1 },
    { key: 'CCCC0001', name: 'Drafts', path: 'Other / Drafts', itemCount: 1 },
  ];

  it('finds a collection by key, path, or a name only it has', () => {
    expect(resolveCollection('CCCC0001', collections).key).toBe('CCCC0001');
    expect(resolveCollection('Papers / Drafts', collections).key).toBe('BBBB0001');
    expect(resolveCollection('Papers', collections).key).toBe('AAAA0001');
    expect(() => resolveCollection('Drafts', collections)).toThrow(/Several collections/);
    const twins = [...collections, { key: 'DDDD0001', name: 'Papers', path: 'Papers', itemCount: 0 }];
    expect(() => resolveCollection('Papers', twins)).toThrow(/Several collections/);
  });

  it("won't pick a top-level collection by a name one inside another shares", () => {
    const nested = [
      { key: 'ROOT0001', name: 'Drafts', path: 'Drafts', itemCount: 0 },
      { key: 'CHLD0001', name: 'Drafts', path: 'Papers / Drafts', itemCount: 0 },
    ];
    expect(() => resolveCollection('Drafts', nested)).toThrow(/Several collections[^]*ROOT0001[^]*CHLD0001/);
    expect(resolveCollection('Papers / Drafts', nested).key).toBe('CHLD0001');
  });

  it("refuses a .bib that isn't UTF-8", async () => {
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'zcli-'));
    const file = require('path').join(dir, 'latin1.bib');
    require('fs').writeFileSync(file, Buffer.from([0x40, 0x61, 0x7b, 0x63, 0x61, 0x66, 0xe9, 0x2c, 0x7d]));
    const err: string[] = [];
    const groups: ZoteroFetch = async url => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('/collections') ? [{ data: { key: 'AAAA0001', name: 'Papers' }, meta: { numItems: 0 } }] : []),
    });
    const code = await runZoteroCli(['push', file, '--collection', 'Papers'], { out: () => {}, err: l => err.push(l), api: { fetchFn: groups } });
    expect(code).toBe(1);
    expect(err[0]).toContain('not plain UTF-8');
  });

  it('reports a usage error with exit code 2', async () => {
    const err: string[] = [];
    const code = await runZoteroCli(['push', 'refs.bib'], { out: () => {}, err: line => err.push(line) });
    expect(code).toBe(2);
    expect(err[0]).toBe('--collection is required.');
  });
});

// ---------------------------------------------------------------------------
// The release audit's cases, run through the Local API adapter as a push
// runs them: the snapshot gives the matcher Extra, as the plan helper's
// catalog doesn't.
// ---------------------------------------------------------------------------

const AUDIT_SCHEMA: ZoteroItemSchema = {
  csl: SCHEMA.csl,
  itemTypes: [
    ...SCHEMA.itemTypes.map(t =>
      t.itemType === 'journalArticle'
        ? { ...t, fields: [...t.fields, field('PMID'), field('journalAbbreviation')] }
        : t.itemType === 'book'
          ? { ...t, fields: [...t.fields, field('numPages'), field('series'), field('seriesNumber')] }
          : t,
    ),
    {
      itemType: 'audioRecording',
      fields: ['title', 'date', 'ISBN', 'url', 'citationKey', 'extra'].map(f => field(f)),
      creatorTypes: [{ creatorType: 'performer' }],
    },
  ],
};

/** A Local API that serves `items` and records what is POSTed. */
function libraryApi(items: readonly ZoteroItemJson[], schema: ZoteroItemSchema = AUDIT_SCHEMA, trashed: readonly string[] = []) {
  const posts: Array<Array<Record<string, unknown>>> = [];
  const rows = items.map(({ uri: _uri, parsedDate, ...data }) => ({
    key: data.key,
    library: { type: 'user', id: 1 },
    data,
    meta: parsedDate === undefined ? {} : { parsedDate },
  }));
  const headers = (version: number) => ({
    get: (n: string) => (n === 'Last-Modified-Version' ? String(version) : n === 'Zotero-Server-ID' ? 'SERVER' : null),
  });
  const fetchFn: ZoteroFetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '[]') as Array<Record<string, unknown>>;
      posts.push(body);
      const successful = Object.fromEntries(body.map((o, i) => [String(i), { key: (o.key as string) ?? 'NEW0000' + i, version: 11 }]));
      return { ok: true, status: 200, json: async () => ({ successful }), headers: headers(11) };
    }
    const body = path.endsWith('/schema')
      ? schema
      : path.endsWith('/items/top')
        ? rows
        : url.includes('format=versions')
          ? Object.fromEntries([...items.map(i => [i.key, i.version] as const), ...trashed.map(k => [k, 0] as const)])
          : [];
    return { ok: true, status: 200, json: async () => body, headers: headers(10) };
  };
  return { fetchFn, posts };
}

async function pushThroughApi(bib: string, items: readonly ZoteroItemJson[], mode: ZoteroPushMode = 'update') {
  const api = libraryApi(items);
  const prepared = await prepareZoteroPush({ type: 'user' }, bib, COLLECTION, mode, api);
  if (prepared === undefined) throw new Error('blocked');
  await applyZoteroPush({ type: 'user' }, prepared, { get: async () => 'KEY', invalidate: async () => {} }, api);
  return { plan: prepared.plan, posts: api.posts, report: formatZoteroPushReport(prepared.plan, 'Coll') };
}

describe('push: an entry writes only the item it clearly owns', () => {
  // Zotero's BibTeX export gives an item the key in a `Citation Key:` line
  // of its Extra over the one in its field (buildCiteKey in BibTeX.js), so
  // A exports as cite-A, the key in B's field.
  const A = item('AAAA2222', { title: 'Title A', citationKey: 'old-A', extra: 'Citation Key: cite-A' });
  const B = item('BBBB2222', { title: 'Title B', citationKey: 'cite-A', extra: 'Citation Key: cite-B' });

  it('leaves alone an entry whose citation key two items answer to', async () => {
    const { plan: p, posts } = await pushThroughApi('@article{cite-A,\n  title = {Title A edited}\n}\n', [A, B]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'citation-key-conflict', detail: 'BBBB2222, AAAA2222' });
    expect(posts).toEqual([]);
  });

  it("leaves alone an entry whose key only one item's Extra gives", async () => {
    // The matcher reads B by the key in its field, so cite-B finds nothing.
    // Zotero exports B as cite-B, but another item may make that key unseen
    // (generatedCitationKey is close, not exact), so push won't take B.
    const { plan: p, posts } = await pushThroughApi('@article{cite-B,\n  title = {Title B}\n}\n', [A, B]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'extra-key-only', detail: 'BBBB2222' });
    expect(posts).toEqual([]);
    // Nor when the title, author and year agree with that item too.
    const one = item('AAAA2222', { title: 'Old title', citationKey: 'native', extra: 'Citation Key: manual' });
    const edited = await pushThroughApi('@article{manual,\n  title = {New title}\n}\n', [one]);
    expect(edited.plan.actions[0]).toMatchObject({ kind: 'skip' });
    expect(edited.posts).toEqual([]);
  });

  it("doesn't count an item's key in its field and its Extra as two claims", async () => {
    const same = item('SAME0001', { title: 'Same', citationKey: 'same', extra: 'Citation Key: same' });
    const { plan: p } = await pushThroughApi('@article{same,\n  title = {Same edited}\n}\n', [same]);
    expect(p.actions[0]).toMatchObject({ kind: 'update', changes: [{ field: 'title', to: 'Same edited' }] });
  });

  it('reads a PMID as the matcher does, for whose it is and what is written', async () => {
    const k = item('AAAA2222', { title: 'Original', citationKey: 'k', PMID: '111' });
    const other = item('BBBB2222', { title: 'Other', citationKey: 'b', PMID: '222' });
    const prefixed = await pushThroughApi('@article{k,\n  title = {Other paper},\n  pmid = {PMID: 222}\n}\n', [k, other]);
    expect(prefixed.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'pmid-disagreement' });
    expect(prefixed.posts).toEqual([]);
    // Its own PMID, prefixed, is the same PMID.
    const own = await pushThroughApi('@article{k,\n  title = {Original},\n  pmid = {PMID: 111}\n}\n', [k, other]);
    expect(own.plan.actions[0]).toMatchObject({ kind: 'unchanged' });
    // One it can't read never replaces a real one.
    const pending = await pushThroughApi('@article{k,\n  pmid = {pending}\n}\n', [k]);
    expect(pending.plan.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'pmid', reason: 'unreadable-pmid' }] });
    expect(pending.posts).toEqual([]);
  });

  it("won't give a book another book's ISBN", async () => {
    const k = item('AAAA2222', { itemType: 'book', title: 'Original', citationKey: 'k', ISBN: '9780261103573' });
    const clrs = item('BBBB2222', { itemType: 'book', title: 'Introduction to Algorithms', citationKey: 'b', ISBN: '9780262033848' });
    const { plan: p, posts } = await pushThroughApi('@book{k,\n  title = {Introduction to Algorithms},\n  isbn = {9780262033848}\n}\n', [k, clrs]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'isbn-owned-elsewhere', detail: 'BBBB2222' });
    expect(posts).toEqual([]);
  });

  it("doesn't take another kind of item for a book by the ISBN they share", async () => {
    const audio = item('AAAA2222', { itemType: 'audioRecording', title: 'Music accompanying Jane', citationKey: 'audio', ISBN: '9780262033848' });
    const { plan: p, posts } = await pushThroughApi('@book{book,\n  title = {Jane: a biography},\n  isbn = {9780262033848}\n}\n', [audio]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'weak-match' });
    expect(posts).toEqual([]);
  });

  it('never writes a field the entry gives twice', async () => {
    const k = item('AAAA2222', { title: 'Original record', citationKey: 'k' });
    const { plan: p, posts } = await pushThroughApi('@article{k,\n  title = {First},\n  title = {Second}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'title', reason: 'repeated-field' }] });
    expect(posts).toEqual([]);
  });
});

describe('push: never a second copy of a work the library has', () => {
  it('creates neither of two new entries with one PMID or one whole-work ISBN', async () => {
    const pmids = await pushThroughApi('@article{a,\n  pmid = {222},\n  title = {One}\n}\n\n@article{b,\n  pmid = {222},\n  title = {One}\n}\n', []);
    expect(pmids.plan.actions).toMatchObject([
      { kind: 'skip', reason: 'duplicate-identifier', detail: 'PMID 222' },
      { kind: 'skip', reason: 'duplicate-identifier', detail: 'PMID 222' },
    ]);
    // An ISBN-10 and the ISBN-13 of the same edition are one ISBN.
    const isbns = await pushThroughApi('@book{a,\n  isbn = {0306406152},\n  title = {One}\n}\n\n@book{b,\n  isbn = {978-0-306-40615-7},\n  title = {One}\n}\n', []);
    expect(isbns.plan.actions).toMatchObject([
      { kind: 'skip', reason: 'duplicate-identifier', detail: 'ISBN 9780306406157' },
      { kind: 'skip', reason: 'duplicate-identifier', detail: 'ISBN 9780306406157' },
    ]);
    expect([...pmids.posts, ...isbns.posts]).toEqual([]);
  });

  it("doesn't create a book whose ISBN-10 is an existing book's ISBN-13", async () => {
    const book = item('AAAA2222', { itemType: 'book', title: 'The same book', ISBN: '9780306406157', citationKey: 'old' });
    const { plan: p, posts } = await pushThroughApi('@book{new,\n  title = {The same book},\n  isbn = {0306406152}\n}\n', [book]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'isbn-owned-elsewhere', detail: 'AAAA2222' });
    expect(posts).toEqual([]);
  });

  it("reads identifiers in Extra's old {:doi:…} and {:pmid:…} lines", async () => {
    const doi = item('AAAA2222', { title: 'A', citationKey: 'other', extra: '{:doi:10.1000/a}' });
    const byDoi = await pushThroughApi('@article{x,\n  doi = {10.1000/a},\n  title = {A}\n}\n', [doi]);
    expect(byDoi.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'doi-owned-elsewhere', detail: 'AAAA2222' });
    const pmid = item('AAAA2222', { itemType: 'book', title: 'A', citationKey: 'other', extra: '{:pmid:12345}' });
    const byPmid = await pushThroughApi('@article{x,\n  pmid = {12345},\n  title = {A}\n}\n', [pmid]);
    expect(byPmid.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'pmid-disagreement', detail: 'AAAA2222' });
    expect([...byDoi.posts, ...byPmid.posts]).toEqual([]);
  });

  it("won't create an item it couldn't find again by its citation key", async () => {
    const noKey: ZoteroItemSchema = {
      ...AUDIT_SCHEMA,
      itemTypes: AUDIT_SCHEMA.itemTypes.map(t => (t.itemType === 'journalArticle' ? { ...t, fields: t.fields.filter(f => f.field !== 'citationKey') } : t)),
    };
    const api = libraryApi([], noKey);
    const prepared = await prepareZoteroPush({ type: 'user' }, '@article{k,\n  title = {Article}\n}\n', COLLECTION, 'add', api);
    expect(prepared?.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'no-citation-key-field' });
    expect(prepared?.plan.changed).toBe(false);
  });

  it('creates each item under a key from its citation key, which a retry names too', async () => {
    // Zotero's writeMultipleObjects: a keyed object Zotero lacks is created
    // under that key; one it has is refused when its version differs.
    const stored = new Map<string, ZoteroItemJson>();
    let libraryVersion = 10;
    const save = (o: Record<string, unknown>) => {
      const key = typeof o.key === 'string' ? o.key : 'NEW' + String(stored.size).padStart(5, '0');
      const had = stored.get(key);
      if (had !== undefined && o.version !== had.version) return { failed: { key, code: 412, message: 'item version mismatch' } };
      stored.set(key, { ...(o as ZoteroItemJson), version: ++libraryVersion, uri: undefined });
      return { ok: { key, version: libraryVersion } };
    };
    let finishFirst: (() => void) | undefined;
    const headers = { get: (n: string) => (n === 'Last-Modified-Version' ? String(libraryVersion) : n === 'Zotero-Server-ID' ? 'SERVER' : null) };
    const fetchFn: ZoteroFetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '[]') as Array<Record<string, unknown>>;
        if (finishFirst === undefined) {
          // The first request saves a, then its answer is lost while b saves.
          save(body[0]);
          finishFirst = () => void save(body[1]);
          throw new DOMException('timed out', 'TimeoutError');
        }
        const results = body.map(save);
        const successful = Object.fromEntries(results.flatMap((r, i) => (r.ok ? [[String(i), r.ok]] : [])));
        const failed = Object.fromEntries(results.flatMap((r, i) => (r.failed ? [[String(i), r.failed]] : [])));
        return { ok: true, status: 200, json: async () => ({ successful, failed }), headers };
      }
      const rows = [...stored.values()].map(data => ({ key: data.key, library: { type: 'user', id: 1 }, data, meta: {} }));
      const body = path.endsWith('/schema')
        ? AUDIT_SCHEMA
        : path.endsWith('/items/top')
          ? rows
          : url.includes('format=versions')
            ? Object.fromEntries([...stored.values()].map(i => [i.key, i.version]))
            : [];
      return { ok: true, status: 200, json: async () => body, headers };
    };
    const bib = '@article{a,\n  title = {A}\n}\n\n@article{b,\n  title = {B}\n}\n';
    const run = async () => {
      const prepared = (await prepareZoteroPush({ type: 'user' }, bib, COLLECTION, 'add', { fetchFn }))!;
      return { prepared, result: await applyZoteroPush({ type: 'user' }, prepared, { get: async () => 'KEY', invalidate: async () => {} }, { fetchFn }) };
    };
    const first = await run();
    expect(zoteroPushWrites(first.prepared.plan)).toMatchObject([
      { citationKey: 'a', key: pushItemKey(TEST_SALT, 'a'), version: 0 },
      { citationKey: 'b', key: pushItemKey(TEST_SALT, 'b'), version: 0 },
    ]);
    expect(first.result.outcomes).toEqual(['unknown', 'unknown']);
    const retry = await run();
    expect(retry.prepared.plan.actions.map(a => a.kind)).toEqual(['unchanged', 'create']);
    finishFirst!();
    expect([...stored.values()].map(i => i.citationKey)).toEqual(['a', 'b']);
  });

  it('says what a refused create means', () => {
    const p = plan('@article{a,\n  title = {A}\n}\n', []);
    const report = formatZoteroPushReport(p, 'Coll', { outcomes: [{ status: 'failed', key: pushItemKey(TEST_SALT, 'a'), code: 412, message: 'item version mismatch' }] });
    expect(report).toContain('Zotero already has an item under this key, ' + pushItemKey(TEST_SALT, 'a'));
  });

  it("won't create an item under a key the library holds anywhere, trash included", async () => {
    // A trashed item at version 0, as every item is in a library never
    // saved since Zotero's migration: Zotero would take a create there for
    // an update.
    const key = pushItemKey(TEST_SALT, 'k');
    const trashed = await (async () => {
      const api = libraryApi([], AUDIT_SCHEMA, [key]);
      return (await prepareZoteroPush({ type: 'user' }, '@article{k,\n  title = {New study}\n}\n', COLLECTION, 'add', api))!.plan;
    })();
    expect(trashed.actions[0]).toMatchObject({ kind: 'skip', reason: 'key-taken', detail: key + ", held by an item in Zotero's trash, or a note or attachment" });
    expect(trashed.changed).toBe(false);
    // Held by another work, as two citation keys whose item keys collide.
    const other = item(key, { title: 'A', citationKey: 'paper906599' });
    const report = formatZoteroPushReport(plan('@article{k,\n  title = {B}\n}\n', [other]), 'Coll');
    expect(report).toContain('held by the item with citation key paper906599');
    expect(report).not.toContain('zotero-key');
  });

  it('gives an entry another item key in another library, or from another Zotero', async () => {
    const keys = await Promise.all(
      [{ type: 'user' } as const, { type: 'group', groupId: 6 } as const].map(async scope => {
        const prepared = await prepareZoteroPush(scope, '@article{smith2020,\n  title = {Lakes}\n}\n', COLLECTION, 'add', libraryApi([]));
        return zoteroPushWrites(prepared!.plan)[0].key;
      }),
    );
    expect(keys[0]).not.toBe(keys[1]);
    expect(pushItemKey('A\nuser', 'smith2020')).not.toBe(pushItemKey('B\nuser', 'smith2020'));
  });

  it('creates neither of two entries whose item keys collide', () => {
    // Found by search: two citation keys with one item key in this library.
    expect(pushItemKey(TEST_SALT, 'paper299592')).toBe(pushItemKey(TEST_SALT, 'paper332929'));
    const p = plan('@article{paper299592,\n  title = {A}\n}\n\n@article{paper332929,\n  title = {B}\n}\n', [], 'add');
    expect(p.actions).toMatchObject([
      { kind: 'skip', reason: 'key-taken', detail: pushItemKey(TEST_SALT, 'paper299592') + ', which entry paper332929 would get too' },
      { kind: 'skip', reason: 'key-taken', detail: pushItemKey(TEST_SALT, 'paper299592') + ', which entry paper299592 would get too' },
    ]);
  });

  it("leaves an entry alone when the item push made for its key no longer has it, and another does", () => {
    // Push created k under its key; k was renamed in Zotero, and another
    // item was given the citation key k.
    const made = item(pushItemKey(TEST_SALT, 'k'), { title: 'My study', citationKey: 'renamed' });
    const theirs = item('BBBB2222', { title: 'Their study', citationKey: 'k' });
    const p = plan('@article{k,\n  title = {My study}\n}\n', [made, theirs]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'citation-key-moved', detail: made.key + ' and BBBB2222' });
  });

  it('reads and writes in the Zotero the collection was chosen from', async () => {
    const chosen = { key: COLLECTION, name: 'Drafts', path: 'Drafts', itemCount: 0, serverId: 'OTHER' };
    const error = await prepareZoteroPush({ type: 'user' }, '@article{k,\n  title = {T}\n}\n', chosen, 'add', libraryApi([])).catch(e => e);
    expect(error).toBeInstanceOf(ZoteroLocalApiError);
    expect((error as ZoteroLocalApiError).kind).toBe('library-changed');
  });
});

describe("push: an unchanged export never damages Zotero's metadata", () => {
  const authors = [
    { creatorType: 'author', firstName: 'Jane', lastName: 'Doe' },
    { creatorType: 'translator', name: 'Translators Guild' },
    { creatorType: 'author', firstName: 'John', lastName: 'Smith' },
  ];

  it('reads names as BibTeX does: and in any case, ties, escaped braces', () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators: authors });
    expect(plan('@article{k,\n  author = {Doe, Jane AND Smith, John}\n}\n', [k]).actions[0]).toMatchObject({ kind: 'unchanged' });
    const ties = plan('@article{k,\n  author = {Jane~Doe and Ludwig~van~Beethoven}\n}\n', []).actions[0];
    expect(ties).toMatchObject({
      kind: 'create',
      data: {
        creators: [
          { creatorType: 'author', lastName: 'Doe', firstName: 'Jane' },
          { creatorType: 'author', lastName: 'van Beethoven', firstName: 'Ludwig' },
        ],
      },
    });
    const council = item('AAAA2222', { title: 'T', citationKey: 'k', creators: [{ creatorType: 'author', name: 'Research {EU} Council' }] });
    expect(plan('@article{k,\n  author = {{Research \\{EU\\} Council}}\n}\n', [council]).actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
    // Read as written, a list wrapped over lines is still split at its ands,
    // and an accent is still read.
    const wrapped = plan("@article{k,\n  author = {{Research \\{EU\\} Council} and\n    Mu\\~noz, Jos\\'e}\n}\n", []).actions[0];
    expect(wrapped).toMatchObject({
      kind: 'create',
      data: { creators: [{ creatorType: 'author', name: 'Research {EU} Council' }, { creatorType: 'author', lastName: 'Muñoz', firstName: 'José' }] },
    });
    // An escaped tilde is a tilde, not a tie.
    const tilde = plan('@article{k,\n  author = {Doe\\textasciitilde{}Roe, Jane}\n}\n', []).actions[0];
    expect(tilde).toMatchObject({ kind: 'create', data: { creators: [{ creatorType: 'author', lastName: 'Doe~Roe', firstName: 'Jane' }] } });
  });

  it("doesn't write a name BibTeX doesn't read as one", () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators: authors });
    for (const names of [' and ', 'Doe,Dr.,Jane,Smith', 'Doe, Jane and and Smith, John']) {
      const p = plan(`@article{k,\n  author = {${names}}\n}\n`, [k]);
      expect(p.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'author', reason: 'unreadable-names' }] });
    }
  });

  it('keeps each creator in its place when a name changes', () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators: authors });
    const p = plan('@article{k,\n  author = {Doe, Janet and Smith, John}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({
      kind: 'update',
      patch: { creators: [{ creatorType: 'author', lastName: 'Doe', firstName: 'Janet' }, authors[1], authors[2]] },
    });
  });

  it("never writes math, and reads Zotero's rich text as its text", () => {
    const cases: Array<[string, string]> = [
      ['Average $x^{12}$', 'Average $x^{12}$'],
      ['The {NASA} report', 'The <span class="nocase">NASA</span> report'],
      ['On E. coli growth', 'On <i>E. coli</i> growth'],
      ['H$_2$O uptake', 'H<sub>2</sub>O uptake'],
      // As Zotero's BibTeX export writes <i> and <sub> (mapHTMLmarkup).
      ['On \\textit{E. coli} growth', 'On <i>E. coli</i> growth'],
      ['H$_{\\textrm{2}}$O uptake', 'H<sub>2</sub>O uptake'],
      ['Cats \\& dogs', 'Cats &amp; dogs'],
    ];
    for (const [entry, zotero] of cases) {
      const p = plan(`@article{k,\n  title = {${entry}}\n}\n`, [item('AAAA2222', { title: zotero, citationKey: 'k' })]);
      expect([entry, p.actions[0]]).toMatchObject([entry, { kind: 'unchanged', notPushed: [] }]);
    }
    // One dollar sign alone is text.
    expect(plan('@article{k,\n  title = {The $100 Startup}\n}\n', []).actions[0]).toMatchObject({ kind: 'create', data: { title: 'The $100 Startup' } });
    // Other math is left out, not written without its groups.
    const other = plan('@article{k,\n  title = {Average $x^{13}$}\n}\n', [item('AAAA2222', { title: 'Average $x^{12}$', citationKey: 'k' })]);
    expect(other.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'title', reason: 'math' }] });
  });

  it('reads journal beside fjournal as the abbreviation', async () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', publicationTitle: 'Journal of Biology', journalAbbreviation: 'J. Biol.' });
    const same = await pushThroughApi('@article{k,\n  journal = {J. Biol.},\n  fjournal = {Journal of Biology}\n}\n', [k]);
    expect(same.plan.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
    const created = await pushThroughApi('@article{n,\n  journal = {J. Biol.},\n  fjournal = {Journal of Biology}\n}\n', []);
    expect(created.posts[0][0]).toMatchObject({ publicationTitle: 'Journal of Biology', journalAbbreviation: 'J. Biol.' });
  });

  it("doesn't replace a list Zotero's answer didn't give whole", () => {
    const noCollections = { ...item('AAAA2222', { title: 'T', citationKey: 'k' }), collections: undefined } as unknown as ZoteroItemJson;
    expect(plan('@article{k,\n  title = {T}\n}\n', [noCollections], 'add').actions[0]).toMatchObject({ kind: 'skip', reason: 'incomplete-item', detail: 'collections' });
    const oddCollections = item('AAAA2222', { title: 'T', citationKey: 'k', collections: 'OTHER001' });
    expect(plan('@article{k,\n  title = {T}\n}\n', [oddCollections], 'add').actions[0]).toMatchObject({ kind: 'skip', reason: 'incomplete-item' });
    const noCreators = { ...item('AAAA2222', { title: 'T', citationKey: 'k' }), creators: undefined } as unknown as ZoteroItemJson;
    expect(plan('@article{k,\n  author = {Jane Doe}\n}\n', [noCreators]).actions[0]).toMatchObject({ kind: 'skip', reason: 'incomplete-item', detail: 'creators' });
  });
});

describe('fetchZoteroLibrarySnapshot, read from one Zotero', () => {
  it('refuses items from another Zotero than the version came from', async () => {
    const fetchFn: ZoteroFetch = async url => ({
      ok: true,
      status: 200,
      json: async () => [],
      headers: { get: (n: string) => (n === 'Last-Modified-Version' ? '4' : n === 'Zotero-Server-ID' ? (url.includes('limit=1') ? 'A' : 'B') : null) },
    });
    const error = await fetchZoteroLibrarySnapshot({ type: 'user' }, { fetchFn }).catch((e: ZoteroLocalApiError) => e);
    expect(error).toBeInstanceOf(ZoteroLocalApiError);
    expect((error as ZoteroLocalApiError).kind).toBe('library-changed');
  });
});

describe('push: smaller fixes from the release audit', () => {
  it("puts a book's pages and number in its page count and series number", async () => {
    const { posts } = await pushThroughApi('@book{k,\n  pages = {250},\n  number = {3},\n  series = {Library series}\n}\n', []);
    expect(posts[0][0]).toMatchObject({ numPages: '250', seriesNumber: '3', series: 'Library series' });
  });

  it('writes a year before 1000 with its four digits', () => {
    expect(plan('@article{k,\n  date = {0044-03-15}\n}\n', []).actions[0]).toMatchObject({ kind: 'create', data: { date: '0044-03-15' } });
  });

  it('writes to a personal library with no Zotero account, leaving entries linked by URI alone', async () => {
    const local = { ...item('AAAA2222', { title: 'A study', citationKey: 'old' }) };
    const api = libraryApi([local]);
    const fetchFn: ZoteroFetch = async (url, init) => {
      const r = await api.fetchFn(url, init);
      if (!url.includes('/items/top') || url.includes('limit=1')) return r;
      const rows = (await r.json()) as Array<Record<string, unknown>>;
      return { ...r, json: async () => rows.map(row => ({ ...row, library: { type: 'user', id: 0 } })) };
    };
    const bib = '@article{new,\n  title = {Another study}\n}\n\n@article{old,\n  title = {A study},\n  zotero-uri = {http://zotero.org/users/5/items/AAAA2222}\n}\n';
    const prepared = await prepareZoteroPush({ type: 'user' }, bib, COLLECTION, 'add', { fetchFn });
    expect(prepared?.plan.actions).toMatchObject([
      { kind: 'create', entryKey: 'new' },
      { kind: 'skip', entryKey: 'old', reason: 'other-library' },
    ]);
  });

  it("reports an object Zotero's answer left out as unknown, not failed", async () => {
    const { fetchFn } = writeFetch(() => ({ status: 200, version: 2, body: { successful: {} } }));
    const prepared = { plan: plan('@article{a,\n  title = {A}\n}\n', []), serverId: 'S', libraryVersion: 1 };
    const result = await applyZoteroPush({ type: 'user' }, prepared, { get: async () => 'K', invalidate: async () => {} }, { fetchFn });
    expect(result.outcomes).toEqual(['unknown']);
    expect(formatZoteroPushReport(prepared.plan, 'Coll', result)).toContain('[outcome unknown');
  });
});

describe('push: review follow-ups', () => {
  it("counts an ISBN an update would replace against a create's", () => {
    const book = item('AAAA2222', { itemType: 'book', title: 'Old', citationKey: 'k', ISBN: '9780261103573' });
    const bib = '@book{k,\n  title = {Old},\n  isbn = {9780306406157}\n}\n\n@book{n,\n  title = {New},\n  isbn = {0306406152}\n}\n';
    expect(plan(bib, [book]).actions).toMatchObject([
      { kind: 'skip', reason: 'duplicate-identifier' },
      { kind: 'skip', reason: 'duplicate-identifier' },
    ]);
  });

  it('counts a DOI or PMID in Extra though the field has another', () => {
    const both = item('AAAA2222', { title: 'A', citationKey: 'a', DOI: '10.1000/one', extra: 'DOI: 10.1000/two\n{:pmid:12345}', PMID: '999' });
    expect(plan('@article{x,\n  title = {B},\n  doi = {10.1000/two}\n}\n', [both]).actions[0]).toMatchObject({ kind: 'skip', reason: 'doi-owned-elsewhere' });
    expect(plan('@article{x,\n  title = {B},\n  pmid = {12345}\n}\n', [both]).actions[0]).toMatchObject({ kind: 'skip', reason: 'pmid-disagreement' });
  });

  it("reads a lone journal that is Zotero's abbreviation as unchanged", async () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', publicationTitle: 'Journal of Biology', journalAbbreviation: 'J. Biol.' });
    const { plan: p, posts } = await pushThroughApi('@article{k,\n  journal = {J. Biol.}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({ kind: 'unchanged' });
    expect(posts).toEqual([]);
  });

  it("reads editor as Zotero's export writes it, series editors among the editors", () => {
    const creators = [
      { creatorType: 'seriesEditor', firstName: 'Sam', lastName: 'Series' },
      { creatorType: 'editor', firstName: 'Ed', lastName: 'Itor' },
    ];
    const k = item('AAAA2222', { itemType: 'book', title: 'T', citationKey: 'k', creators });
    expect(plan('@book{k,\n  editor = {Series, Sam and Itor, Ed}\n}\n', [k]).actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
    expect(plan('@book{k,\n  editor = {Itor, Edward}\n}\n', [k]).actions[0]).toMatchObject({
      kind: 'unchanged',
      notPushed: [{ field: 'editor', reason: 'series-editors' }],
    });
  });

  it('never writes math in a name', () => {
    const p = plan('@article{k,\n  author = {{Group $x^{12}$}}\n}\n', []);
    expect(p.actions[0]).toMatchObject({ kind: 'create', notPushed: [{ field: 'author', reason: 'tex' }] });
  });
});

describe("push: citation keys as Zotero's export gives them", () => {
  it('counts the key the export makes for an item with none stored', async () => {
    const strata = item('AAAA2222', {
      title: 'Strata',
      parsedDate: '2020',
      date: '2020',
      creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
    });
    const soil = item('BBBB2222', { title: 'Soil', citationKey: 'doe_strata_2020', extra: 'Citation Key: other' });
    const { plan: p, posts } = await pushThroughApi('@article{doe_strata_2020,\n  title = {Strata},\n  author = {Doe, Jane},\n  year = {2020}\n}\n', [strata, soil]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'citation-key-conflict' });
    expect(posts).toEqual([]);
    // An undated item with no author or key exports as noauthor_undated_nodate.
    const undated = item('CCCC2222', { title: 'Undated' });
    const again = await pushThroughApi('@article{noauthor_undated_nodate,\n  title = {Undated}\n}\n', [undated]);
    expect(again.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'generated-key', detail: 'CCCC2222' });
    expect(again.posts).toEqual([]);
  });

  it("reads Extra's key as Zotero's export does, only from a line labelled Citation Key", async () => {
    const strata = item('AAAA2222', { title: 'Strata', citationKey: 'native', extra: 'CitationKey: obsolete\nCitation Key: exported' });
    const soil = item('BBBB2222', { title: 'Soil', citationKey: 'exported', extra: 'Citation Key: other' });
    const { plan: p, posts } = await pushThroughApi('@article{exported,\n  title = {Strata}\n}\n\n@article{other,\n  title = {Soil}\n}\n', [strata, soil]);
    expect(p.actions).toMatchObject([
      { kind: 'skip', reason: 'citation-key-conflict' },
      { kind: 'skip', reason: 'extra-key-only', detail: 'BBBB2222' },
    ]);
    expect(posts).toEqual([]);
  });

  it("counts every identifier line of Extra, not just the first", async () => {
    const twoDois = item('AAAA2222', { title: 'A', citationKey: 'a', extra: 'DOI: 10.1000/a\n{:doi:10.1000/b}' });
    expect(plan('@article{x,\n  title = {Other},\n  doi = {10.1000/b}\n}\n', [twoDois]).actions[0]).toMatchObject({ kind: 'skip', reason: 'doi-owned-elsewhere' });
    const isbnInExtra = item('BBBB2222', { itemType: 'book', title: 'Second book', citationKey: 'b', extra: 'ISBN: 9780262033848' });
    expect(plan('@book{new,\n  title = {Second book},\n  isbn = {9780262033848}\n}\n', [isbnInExtra]).actions[0]).toMatchObject({
      kind: 'skip',
      reason: 'isbn-owned-elsewhere',
    });
  });

  it('stops reading a library whose item comes without its version', async () => {
    const A = item('AAAA2222', { title: 'A', citationKey: 'old-A', extra: 'Citation Key: cite-A' });
    const api = libraryApi([{ ...A, version: undefined } as unknown as ZoteroItemJson]);
    const error = await prepareZoteroPush({ type: 'user' }, '@article{cite-A,\n  title = {A edited}\n}\n', COLLECTION, 'update', api).catch(e => e);
    expect(error).toBeInstanceOf(ZoteroLocalApiError);
    expect(api.posts).toEqual([]);
  });
});

describe('push: ISBNs, as a work and its volumes and chapters share them', () => {
  it("won't give a book another book's ISBN from a chapter's entry", () => {
    const first = item('AAAA2222', { itemType: 'book', title: 'Original', citationKey: 'k', ISBN: '9780262033848' });
    const other = item('BBBB2222', { itemType: 'book', title: 'Other', citationKey: 'b', ISBN: '9780306406157' });
    expect(plan('@incollection{k,\n  title = {First},\n  isbn = {9780306406157}\n}\n', [first, other]).actions[0]).toMatchObject({
      kind: 'skip',
      reason: 'isbn-owned-elsewhere',
      detail: 'BBBB2222',
    });
  });

  it("doesn't hold a set's ISBN against a volume that has it", () => {
    const vol1 = item('AAAA2222', { itemType: 'book', title: 'Volume One', citationKey: 'vol1', ISBN: '9780262033848' });
    const vol2 = item('BBBB2222', { itemType: 'book', title: 'Volume Two', citationKey: 'vol2', ISBN: '9780262033848' });
    const bib = '@book{vol1,\n  title = {Volume {One}},\n  isbn = {9780262033848}\n}\n\n@book{vol2,\n  title = {Volume {Two}},\n  isbn = {9780262033848}\n}\n';
    expect(plan(bib, [vol1, vol2]).actions.map(a => a.kind)).toEqual(['unchanged', 'unchanged']);
    const edited = plan(bib.replace('Volume {One}', 'Volume One, Revised'), [vol1, vol2]);
    expect(edited.actions[0]).toMatchObject({ kind: 'update', changes: [{ field: 'title', to: 'Volume One, Revised' }] });
  });

  it("takes an ISBN-10 for an ISBN-13 only when its check digit is right", () => {
    const vol = item('AAAA2222', { itemType: 'book', title: 'Volume One', citationKey: 'volume' });
    const other = item('BBBB2222', { itemType: 'book', title: 'Other', citationKey: 'b', ISBN: '9780306406157' });
    // 0306406152 is the ISBN-10 of 9780306406157; 0306406153 is no ISBN.
    const p = plan('@book{volume,\n  title = {Volume One revised},\n  isbn = {0306406153}\n}\n', [vol, other]);
    expect(p.actions[0]).toMatchObject({ kind: 'update' });
  });
});

describe('push: names and text, as BibTeX and Zotero write them', () => {
  it('parts names at an and between spaces before a tie reads as a space', () => {
    const p = plan('@article{k,\n  author = {Doe~and~Smith}\n}\n', []);
    expect(p.actions[0]).toMatchObject({ kind: 'create', data: { creators: [{ creatorType: 'author', lastName: 'and Smith', firstName: 'Doe' }] } });
  });

  it('reads AND as the DOCX export reads it', () => {
    expect(parseAuthors('Barnes AND Noble')).toEqual([{ family: 'Barnes' }, { family: 'Noble' }]);
  });

  it("keeps a two-field name with no first name, as Zotero's export writes it", () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators: [{ creatorType: 'author', firstName: '', lastName: 'Garcia Lopez' }] });
    expect(plan('@article{k,\n  author = {Garcia Lopez}\n}\n', [k]).actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
  });

  it('reports a formula that changed, without writing it', () => {
    const cases: Array<[string, string]> = [
      ['E = mc$_{2}$', 'E = mc<sup>2</sup>'],
      ['Average $x^12$', 'Average $x^{12}$'],
    ];
    for (const [entry, zotero] of cases) {
      const p = plan(`@article{k,\n  title = {${entry}}\n}\n`, [item('AAAA2222', { title: zotero, citationKey: 'k' })]);
      expect([entry, p.actions[0]]).toMatchObject([entry, { kind: 'unchanged', notPushed: [{ field: 'title', reason: 'math' }] }]);
    }
  });

  it('writes a name with escaped dollar signs', () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators: [{ creatorType: 'author', name: 'Rates $3 and $8' }] });
    expect(plan('@article{k,\n  author = {{Rates \\$5 and \\$10}}\n}\n', [k]).actions[0]).toMatchObject({
      kind: 'update',
      patch: { creators: [{ creatorType: 'author', name: 'Rates $5 and $10' }] },
    });
  });

  it("reads Zotero's export of its entities and nocase spans as the same text", () => {
    const amp = item('AAAA2222', { title: 'Cats &amp; dogs', citationKey: 'k' });
    expect(plan('@article{k,\n  title = {Cats \\&amp; dogs}\n}\n', [amp]).actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
    const nasa = item('AAAA2222', { title: 'The <span class="nocase">NASA</span> report', citationKey: 'k' });
    const exported = '@article{k,\n  title = {The {\\textless}span class="nocase"{\\textgreater}{NASA}{\\textless}/span{\\textgreater} report}\n}\n';
    expect(plan(exported, [nasa]).actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
  });

  it('reports an editor list that drops a series editor', () => {
    const creators = [
      { creatorType: 'seriesEditor', firstName: 'Sue', lastName: 'Lane' },
      { creatorType: 'editor', firstName: 'Ed', lastName: 'Doe' },
    ];
    const k = item('AAAA2222', { itemType: 'book', title: 'T', citationKey: 'k', creators });
    expect(plan('@book{k,\n  editor = {Doe, Ed}\n}\n', [k]).actions[0]).toMatchObject({
      kind: 'unchanged',
      notPushed: [{ field: 'editor', reason: 'series-editors' }],
    });
  });

  it('leaves a lone journal alone that could be either the full title or the abbreviation', () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', publicationTitle: 'Journal of Biology', journalAbbreviation: 'J. Biol.' });
    expect(plan('@article{k,\n  journal = {J. Biol. Sci.}\n}\n', [k]).actions[0]).toMatchObject({
      kind: 'unchanged',
      notPushed: [{ field: 'journal', reason: 'ambiguous-journal' }],
    });
    // Zotero's full title, as written, is no change.
    expect(plan('@article{k,\n  journal = {Journal of Biology}\n}\n', [k]).actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
  });
});

describe('push: round three of review', () => {
  it('rewrites only the coauthor the entry changes', () => {
    const creators = [
      { creatorType: 'author', firstName: '', lastName: 'Garcia Lopez' },
      { creatorType: 'author', firstName: 'Ann', lastName: 'Reed' },
    ];
    const k = item('AAAA2222', { title: 'Field studies', citationKey: 'k', creators });
    const p = plan('@article{k,\n  author = {Garcia Lopez and Reed, Anne}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({
      kind: 'update',
      patch: { creators: [creators[0], { creatorType: 'author', lastName: 'Reed', firstName: 'Anne' }] },
    });
    const one = item('AAAA2222', { title: 'Field studies', citationKey: 'k', creators: [creators[0]] });
    const appended = plan('@article{k,\n  author = {Garcia Lopez and Reed, Anne}\n}\n', [one]);
    expect(appended.actions[0]).toMatchObject({ kind: 'update', patch: { creators: [creators[0], { lastName: 'Reed', firstName: 'Anne' }] } });
  });

  it("holds back an export of a keyless item, whether or not push makes Zotero's key for it", () => {
    // Keys Zotero's export makes, with letters decomposition doesn't reduce
    // and years it reads its own way.
    const cases: Array<[string, string, string]> = [
      ['sondergaard_spring_nodate', 'Søndergaard', ''],
      ['coeur_spring_nodate', 'Cœur', ''],
      ['gros_spring_nodate', 'Groß', ''],
      ['lukasik_spring_nodate', 'Łukasik', ''],
      ['doe_spring_44', 'Doe', '0044'],
      ['doe_spring_200bce', 'Doe', '200 BCE'],
    ];
    for (const [key, last, date] of cases) {
      const keyless = item('AAAA2222', {
        title: 'The spring atlas',
        date,
        creators: [{ creatorType: 'author', firstName: 'Ada', lastName: last }],
      });
      const year = date === '' ? '' : '  year = {' + date.replace(/^0+/, '') + '},\n';
      const p = plan(`@article{${key},\n  title = {The spring atlas},\n  author = {${last}, Ada},\n${year}}\n`, [keyless], 'add');
      expect([key, p.actions[0].kind]).toEqual([key, 'skip']);
    }
    // A key push can't make, as for a thorn, still finds the item by its
    // title and names.
    const thorn = item('AAAA2222', { title: 'The spring atlas', creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Þórsson' }] });
    const p = plan('@article{thorsson_spring_nodate,\n  title = {The spring atlas},\n  author = {Þórsson, Ada}\n}\n', [thorn], 'add');
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'possible-existing', detail: 'AAAA2222' });
  });

  it('reports a formula whose groups or case changed', () => {
    const cases: Array<[string, string]> = [
      ['Ratio $\\frac{ab}{c}$', 'Ratio $\\frac{a}{bc}$'],
      ['Rate $p$', 'Rate $P$'],
    ];
    for (const [entry, zotero] of cases) {
      const p = plan(`@article{k,\n  title = {${entry}}\n}\n`, [item('AAAA2222', { title: zotero, citationKey: 'k' })]);
      expect([entry, p.actions[0]]).toMatchObject([entry, { kind: 'unchanged', notPushed: [{ field: 'title', reason: 'math' }] }]);
    }
    const same = plan('@article{k,\n  title = {Ratio $\\frac{a}{bc}$}\n}\n', [item('AAAA2222', { title: 'Ratio $\\frac{a}{bc}$', citationKey: 'k' })]);
    expect(same.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
  });

  it("doesn't take a weak match for the item whose Extra alone gives the entry's key", async () => {
    const doe = item('AAAA2222', {
      title: 'Tidal basins',
      citationKey: 'doe2020',
      extra: 'Citation Key: manual',
      date: '2020',
      parsedDate: '2020',
      pages: '21–30',
      creators: [{ creatorType: 'author', firstName: 'Ann', lastName: 'Doe' }],
    });
    const bib = '@article{manual,\n  title = {Tidal basins},\n  author = {Doe, Ann},\n  year = {2020},\n  pages = {21--30}\n}\n';
    const edited = await pushThroughApi(bib.replace('21--30', '21--31'), [doe]);
    expect(edited.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'weak-match' });
    expect(edited.posts).toEqual([]);
    // Finding 1 of the third review: A's export key, which push can't make
    // (Ħ), is B's Extra line, and A matches B weakly.
    const a = item('AAAA2222', { title: 'Winter notes', publicationTitle: 'Journal of Field Studies', pages: '10–20', creators: [{ creatorType: 'author', firstName: '', lastName: 'Ħasan Lopez' }] });
    const b = item('BBBB2222', {
      title: 'Winter migrations',
      citationKey: 'winter-migrations',
      extra: 'Citation Key: hasan_lopez_winter_nodate',
      publicationTitle: 'Journal of Field Studies',
      pages: '1–2',
      creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lopez' }],
    });
    const exported = '@article{hasan_lopez_winter_nodate,\n  title = {Winter notes},\n  journal = {Journal of Field Studies},\n  author = {Ħasan Lopez},\n  pages = {10--20}\n}\n';
    for (const items of [[a, b], [a, { ...b, title: 'Summer migrations', publicationTitle: 'Other Journal' }]]) {
      const r = await pushThroughApi(exported, items as ZoteroItemJson[]);
      expect(r.plan.actions[0].kind).toBe('skip');
      expect(r.posts).toEqual([]);
    }
  });

  it("reads Zotero's swung dash, tilde and circumflex as its export writes them", () => {
    const pages = item('AAAA2222', { title: 'T', citationKey: 'k', pages: '100⁓120' });
    expect(plan('@article{k,\n  pages = {100--120}\n}\n', [pages]).actions[0]).toMatchObject({ kind: 'unchanged' });
    const tilde = item('AAAA2222', { title: 'A model with ~ error', citationKey: 'k' });
    expect(plan('@article{k,\n  title = {A model with {\\textasciitilde} error}\n}\n', [tilde]).actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
    const hat = item('AAAA2222', { title: 'A^2 + B^2', citationKey: 'k' });
    expect(plan('@article{k,\n  title = {A{\\textasciicircum}2 + {B}{\\textasciicircum}2}\n}\n', [hat]).actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
  });
});

describe("push: CodeRabbit's review of round two", () => {
  const authors = [
    { creatorType: 'author', firstName: 'Jane', lastName: 'Doe' },
    { creatorType: 'author', firstName: 'John', lastName: 'Smith' },
  ];

  it('leaves an entry with a concatenated name list alone', () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators: authors });
    const p = plan('@article{k,\n  author = {Doe, Jane and {Research \\textasciitilde{} Development}} # { and Smith, John}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'conflict', detail: 'concatenated-field' });
  });

  it("won't write a name list with an escaped brace outside its groups", () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators: authors });
    const p = plan('@article{k,\n  author = {Doe, Jane\\{ AND Smith, John\\}}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'author', reason: 'unreadable-names' }] });
  });

  it("doesn't take an empty fjournal for a full title", () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', publicationTitle: 'Journal of Biology', journalAbbreviation: 'J. Biol.' });
    const p = plan('@article{k,\n  journal = {New Biology Journal},\n  fjournal = {}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'journal', reason: 'ambiguous-journal' }] });
  });

  it('reads many keyless items that make one key in linear time', () => {
    const items = Array.from({ length: 2000 }, (_, i) => item('K' + String(i).padStart(7, '2'), { title: 'Untitled ' + i }));
    const start = performance.now();
    const p = plan('@article{noauthor_untitled_nodate,\n  title = {Something else}\n}\n', items, 'add');
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'citation-key-conflict' });
    expect(performance.now() - start).toBeLessThan(5000);
  });

  it("reserves an ISBN two chapters' entries would give two books", () => {
    const one = item('AAAA2222', { itemType: 'book', title: 'One', citationKey: 'one' });
    const two = item('BBBB2222', { itemType: 'book', title: 'Two', citationKey: 'two' });
    const bib = '@incollection{one,\n  title = {One},\n  isbn = {9780262033848}\n}\n\n@incollection{two,\n  title = {Two},\n  isbn = {9780262033848}\n}\n';
    expect(plan(bib, [one, two]).actions.map(a => a.kind)).toEqual(['skip', 'skip']);
    // Chapters share their book's ISBN.
    const chapterA = item('CCCC2222', { itemType: 'bookSection', title: 'A', citationKey: 'a' });
    const chapterB = item('DDDD2222', { itemType: 'bookSection', title: 'B', citationKey: 'b' });
    const parts = '@incollection{a,\n  title = {A},\n  isbn = {9780262033848}\n}\n\n@incollection{b,\n  title = {B},\n  isbn = {9780262033848}\n}\n';
    expect(plan(parts, [chapterA, chapterB]).actions.map(a => a.kind)).toEqual(['update', 'update']);
  });
});

describe('push: round four, a skip never withdraws a claim', () => {
  it("won't give an item a DOI, PMID or ISBN an entry skipped for another reason gives too", () => {
    // A keyless, undated Editorial by Ann Doe holds the first entry back as
    // possibly that item; it still names the DOI.
    const editorial = item('AAAA2222', { title: 'Editorial', creators: [{ creatorType: 'author', firstName: 'Ann', lastName: 'Doe' }] });
    const winter = item('BBBB2222', { title: 'Winter surveys', citationKey: 'winter' });
    for (const field of ['doi = {10.1234/editorial}', 'pmid = {987654}']) {
      const bib = `@article{editorial,\n  title = {Editorial},\n  author = {Doe, Ann},\n  ${field}\n}\n\n@article{winter,\n  title = {Winter surveys},\n  ${field}\n}\n`;
      const p = plan(bib, [editorial, winter]);
      expect([field, p.actions.map(a => a.kind)]).toEqual([field, ['skip', 'skip']]);
      expect(p.changed).toBe(false);
    }
  });
});

describe('push: round four, fjournal and exact comparison', () => {
  it('reads journal as the abbreviation beside any non-empty fjournal, even one it can\'t write', () => {
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', publicationTitle: 'Journal of Biology' });
    for (const fjournal of ['\\textit{Journal of Biology}', 'Journal of $B$iology']) {
      const p = plan(`@article{k,\n  journal = {J. Biol.},\n  fjournal = {${fjournal}}\n}\n`, [k]);
      const action = p.actions[0];
      expect(action.kind === 'update' ? action.patch : {}).not.toHaveProperty('publicationTitle');
    }
  });

  it('writes a coauthor whose name changed only in case', () => {
    const creators = [
      { creatorType: 'author', firstName: 'Eva', lastName: 'Mcdonald' },
      { creatorType: 'author', firstName: 'Ann', lastName: 'Reed' },
    ];
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators });
    const p = plan('@article{k,\n  author = {McDonald, Eva and Reed, Anne}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({
      kind: 'update',
      patch: { creators: [{ lastName: 'McDonald', firstName: 'Eva' }, { lastName: 'Reed', firstName: 'Anne' }] },
    });
  });

  it('reports a formula that changed only in its spaces or font', () => {
    const cases: Array<[string, string]> = [
      ['Growth $\\text{ab}$', 'Growth $\\text{a b}$'],
      ['Transform $\\sinx$', 'Transform $\\sin x$'],
      ['Vector $\\mathit{x}$', 'Vector $\\mathbf{x}$'],
    ];
    for (const [entry, zotero] of cases) {
      const p = plan(`@article{k,\n  title = {${entry}}\n}\n`, [item('AAAA2222', { title: zotero, citationKey: 'k' })]);
      expect([entry, p.actions[0]]).toMatchObject([entry, { kind: 'unchanged', notPushed: [{ field: 'title', reason: 'math' }] }]);
    }
  });
});

describe('push: round four, the create safety net reads names as exported, role by role', () => {
  it("holds back an unchanged export push can't make the key for", () => {
    // Ħ: Zotero's export drops it from the key, push doesn't know how.
    const hasan = item('AAAA2222', {
      title: 'Winter notes',
      publicationTitle: 'Journal of Field Studies',
      pages: '10–20',
      creators: [{ creatorType: 'author', firstName: '', lastName: 'Ħasan Lopez' }],
    });
    const exported = '@article{hasan_lopez_winter_nodate,\n  title = {Winter notes},\n  journal = {Journal of Field Studies},\n  author = {Ħasan Lopez},\n  pages = {10--20}\n}\n';
    expect(plan(exported, [hasan], 'add').actions[0]).toMatchObject({ kind: 'skip', reason: 'possible-existing', detail: 'AAAA2222' });
    // A day alone, which Zotero reads as no year, and a translator the
    // entry's author list doesn't hold.
    const lee = item('BBBB2222', {
      title: 'Winter notes',
      date: '23',
      parsedDate: '0000-00-23',
      creators: [
        { creatorType: 'author', firstName: 'Ann', lastName: 'Lee' },
        { creatorType: 'translator', firstName: 'Eva', lastName: 'Reed' },
      ],
    });
    const leeBib = '@article{lee_winter_nodate,\n  title = {Winter notes},\n  author = {Lee, Ann},\n  translator = {Reed, Eva}\n}\n';
    expect(plan(leeBib, [lee], 'add').actions[0].kind).toBe('skip');
  });

  it('holds back an entry whose names it can\'t read', () => {
    // An unreadable list is not an empty one: Jane Doe may be in it.
    const editorial = item('AAAA2222', { title: 'Editorial', creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }] });
    const p = plan('@article{x,\n  title = {Editorial},\n  author = {Doe, Jane\\{ AND Smith, John\\}}\n}\n', [editorial], 'add');
    expect(p.actions[0]).toMatchObject({ kind: 'skip', reason: 'possible-existing' });
  });

  it('gives its own reading of a name two stored creators export alike', () => {
    const creators = [
      { creatorType: 'author', firstName: '', lastName: 'Reed, Ann' },
      { creatorType: 'author', firstName: 'Ann', lastName: 'Reed' },
      { creatorType: 'author', firstName: 'Eva', lastName: 'Kim' },
    ];
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators });
    const p = plan('@article{k,\n  author = {Reed, Ann and Kim, Eva}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({ kind: 'update', patch: { creators: [{ lastName: 'Reed', firstName: 'Ann' }, creators[2]] } });
  });
});

describe('push: round five', () => {
  it("leaves a creator list alone that the entry gives as Zotero exports it, twins and all", () => {
    // A surname-only "Reed, Ann" beside the person Ann Reed export alike.
    const creators = [
      { creatorType: 'author', firstName: '', lastName: 'Reed, Ann' },
      { creatorType: 'author', firstName: 'Ann', lastName: 'Reed' },
      { creatorType: 'author', firstName: '', lastName: 'Garcia Lopez' },
      { creatorType: 'author', firstName: '', lastName: 'Garcia Lopez' },
    ];
    const k = item('AAAA2222', { title: 'T', citationKey: 'k', creators });
    const p = plan('@article{k,\n  author = {Reed, Ann and Reed, Ann and Garcia Lopez and Garcia Lopez}\n}\n', [k]);
    expect(p.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [] });
  });

  it("won't take a citation-key match while another, keyless item is the entry's by title and names", async () => {
    // Seed 4066, reduced: the keyless article's export key, which push can't
    // make (Ħ), is the book's own citation key.
    const book = item('BBBB2222', {
      itemType: 'book',
      title: 'Editorial notes',
      citationKey: 'hasan_editorial_nodate',
      numPages: '120',
      creators: [{ creatorType: 'author', firstName: 'Eva', lastName: 'Kim' }],
    });
    const article = item('AAAA2222', {
      title: 'Editorial',
      pages: '12–23',
      creators: [
        { creatorType: 'author', firstName: 'Sam', lastName: 'Ħasan' },
        { creatorType: 'author', firstName: 'Eva', lastName: 'Kim' },
      ],
    });
    const bib = '@article{hasan_editorial_nodate,\n  title = {Editorial},\n  author = {Ħasan, Sam and Kim, Eva},\n  pages = {12--23}\n}\n';
    for (const mode of ['add', 'update'] as const) {
      const r = await pushThroughApi(bib, [book, article], mode);
      expect(r.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'plain-match-elsewhere', detail: 'BBBB2222 and AAAA2222' });
      expect(r.posts).toEqual([]);
    }
    // The ordinary case: the item the key names is the plain match itself.
    const own = item('AAAA2222', { ...article, citationKey: 'hasan_editorial_nodate' });
    expect(plan(bib, [own]).actions[0]).toMatchObject({ kind: 'unchanged' });
  });
});

describe('push: round six', () => {
  it('reads each keyless title a bounded number of times however many entries are matched by key', () => {
    // A plan that compared every keyless item against every entry read each
    // one's title once per entry; read once a plan (keylessTitles), a
    // title's reads don't grow with the bibliography.
    let reads = 0;
    const items: ZoteroItemJson[] = [];
    let bib = '';
    for (let i = 0; i < 100; i++) {
      items.push(item('K' + String(i).padStart(7, '0'), { title: 'Keyed ' + i, citationKey: 'key' + i, creators: [{ creatorType: 'author', firstName: 'Ann', lastName: 'Author' + i }] }));
      const keyless = item('L' + String(i).padStart(7, '0'), { creators: [{ creatorType: 'author', firstName: 'Bo', lastName: 'Other' + i }] });
      const title = 'Keyless ' + i;
      Object.defineProperty(keyless, 'title', { enumerable: true, get: () => (reads++, title) });
      items.push(keyless);
      bib += '@article{key' + i + ',\n  title = {Keyed ' + i + '},\n  author = {Author' + i + ', Ann}\n}\n\n';
    }
    const p = plan(bib, items);
    expect(p.actions.filter(a => a.kind === 'unchanged')).toHaveLength(100);
    expect(reads).toBeLessThan(100 * 10);
  });

  it('still finds a keyless item whose title differs only in markup and case', async () => {
    const book = item('BBBB2222', { itemType: 'book', title: 'Editorial notes', citationKey: 'hasan_editorial_nodate', creators: [{ creatorType: 'author', firstName: 'Eva', lastName: 'Kim' }] });
    const article = item('AAAA2222', { title: 'The <i>Editorial</i>', creators: [{ creatorType: 'author', firstName: 'Eva', lastName: 'Kim' }] });
    const bib = '@article{hasan_editorial_nodate,\n  title = {The \\emph{editorial}},\n  author = {Kim, Eva}\n}\n';
    for (const mode of ['add', 'update'] as const) {
      const r = await pushThroughApi(bib, [book, article], mode);
      expect(r.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'plain-match-elsewhere', detail: 'BBBB2222 and AAAA2222' });
    }
  });

  it('still finds a keyless item by a title push compares loosely, as one with math', () => {
    const book = item('BBBB2222', { itemType: 'book', title: 'Rates notes', citationKey: 'ratesbook', creators: [{ creatorType: 'author', firstName: 'Eva', lastName: 'Kim' }] });
    const article = item('AAAA2222', { title: 'Rates of $x^2$ growth', creators: [{ creatorType: 'author', firstName: 'Eva', lastName: 'Kim' }] });
    const bib = '@article{ratesbook,\n  title = {Rates of $x^2$ growth},\n  author = {Kim, Eva}\n}\n';
    expect(plan(bib, [book, article]).actions[0]).toMatchObject({ kind: 'skip', reason: 'plain-match-elsewhere', detail: 'BBBB2222 and AAAA2222' });
  });
});

describe('push: a stored creator the entry moves', () => {
  const reed = { creatorType: 'author', firstName: 'Ann', lastName: 'Reed' };
  const garcia = { creatorType: 'author', firstName: '', lastName: 'Garcia Lopez' };
  const kim = { creatorType: 'author', firstName: 'Eva', lastName: 'Kim' };
  const editor = { creatorType: 'editor', firstName: 'Ed', lastName: 'Long' };
  const translator = { creatorType: 'translator', firstName: 'Fran', lastName: 'Lee' };
  const update = (creators: object[], author: string) => {
    const a = plan('@book{k,\n  title = {T},\n  author = {' + author + '}\n}\n', [item('AAAA2222', { itemType: 'book', title: 'T', citationKey: 'k', creators })]).actions[0];
    if (a.kind !== 'update') throw new Error('expected an update, got ' + a.kind);
    return a;
  };

  it('keeps a moved last name with no first name as one last name', () => {
    const a = update([reed, garcia], 'Garcia Lopez and Reed, Ann');
    expect(a.patch.creators).toEqual([garcia, reed]);
    expect(a.changes).toEqual([{ field: 'creators:author', from: 'Reed, Ann; Garcia Lopez', to: 'Garcia Lopez; Reed, Ann' }]);
  });

  it('keeps it when an author is inserted or deleted before it, and says other roles move', () => {
    const stored = [reed, editor, garcia, translator, kim];
    const inserted = update(stored, 'Reed, Ann and Singh, Ira and Garcia Lopez and Kim, Eva');
    expect(inserted.patch.creators).toEqual([reed, { creatorType: 'author', lastName: 'Singh', firstName: 'Ira' }, garcia, kim, editor, translator]);
    expect(inserted.changes.map(c => c.field)).toEqual(['creators:author', 'creators']);
    expect(inserted.changes[1].to).toBe('author Reed, Ann; author Singh, Ira; author Garcia Lopez; author Kim, Eva; editor Long, Ed; translator Lee, Fran');
    const deleted = update(stored, 'Garcia Lopez and Kim, Eva');
    expect(deleted.patch.creators).toEqual([garcia, kim, editor, translator]);
  });

  it('keeps both of two creators that export alike on a reorder, but not on a deletion', () => {
    const surname = { creatorType: 'author', firstName: '', lastName: 'Reed, Ann' };
    const swapped = update([surname, editor, reed, translator, kim], 'Kim, Eva and Reed, Ann and Reed, Ann');
    expect(swapped.patch.creators).toEqual([kim, editor, surname, translator, reed]);
    // Which of the two was deleted can't be told: the entry's reading.
    const deleted = update([surname, reed, kim], 'Reed, Ann and Kim, Eva');
    expect(deleted.patch.creators).toEqual([{ creatorType: 'author', lastName: 'Reed', firstName: 'Ann' }, kim]);
  });

  it("gives the entry's reading where it repeats a name", () => {
    const a = update([reed, garcia], 'Garcia Lopez and Garcia Lopez');
    expect(a.patch.creators).toEqual([
      { creatorType: 'author', lastName: 'Lopez', firstName: 'Garcia' },
      garcia,
    ]);
  });
});

describe('push: a match by identifier while another, keyless item is the plain match', () => {
  // Seed 1897, reduced: the keyless book's entry has the section's DOI.
  const book = item('ZZZZ2222', {
    itemType: 'book',
    title: 'Field atlas',
    // Zotero reads 23 as a day, so its export's key is oster_field_nodate,
    // where push's reading makes oster_field_23.
    date: '23',
    DOI: '10.4242/winter.b',
    creators: [
      { creatorType: 'editor', firstName: 'Bo', lastName: 'Øster' },
      { creatorType: 'author', firstName: 'Ann', lastName: 'Reed' },
    ],
  });
  const section = item('ZZZZ2223', {
    itemType: 'bookSection',
    title: 'Field atlas',
    citationKey: 'kim_field_1998',
    DOI: '10.4242/winter.a',
    creators: [{ creatorType: 'author', firstName: 'Eva', lastName: 'Kim' }],
  });
  const bib = '@book{oster_field_nodate,\n  title = {Field atlas},\n  doi = {10.4242/winter.a},\n  author = {Reed, Ann},\n  editor = {Øster, Bo}\n}\n';

  it("won't follow an edited DOI to another item while the entry's own is keyless", async () => {
    for (const mode of ['add', 'update'] as const) {
      const r = await pushThroughApi(bib, [book, section], mode);
      expect(r.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'plain-match-elsewhere', detail: 'ZZZZ2223 and ZZZZ2222' });
      expect(r.posts).toEqual([]);
    }
  });

  it('nor an ISBN', () => {
    const isbnBook = item('ZZZZ2225', { itemType: 'book', title: 'Other atlas', ISBN: '9780262033848', citationKey: 'x' });
    const byIsbn = '@book{oster_field_nodate,\n  title = {Field atlas},\n  isbn = {9780262033848},\n  author = {Reed, Ann},\n  editor = {Øster, Bo}\n}\n';
    expect(plan(byIsbn, [book, isbnBook]).actions[0]).toMatchObject({ kind: 'skip', reason: 'plain-match-elsewhere', detail: 'ZZZZ2225 and ZZZZ2222' });
  });

  it('nor a PMID', async () => {
    const pmidItem = item('ZZZZ2226', { title: 'Other', PMID: '12345678', citationKey: 'y' });
    const keylessArticle = item('ZZZZ2227', { title: 'Field notes', creators: [{ creatorType: 'author', firstName: 'Ann', lastName: 'Reed' }] });
    const byPmid = '@article{fieldnotes,\n  title = {Field notes},\n  pmid = {12345678},\n  author = {Reed, Ann}\n}\n';
    const r = await pushThroughApi(byPmid, [keylessArticle, pmidItem], 'update');
    expect(r.plan.actions[0]).toMatchObject({ kind: 'skip', reason: 'plain-match-elsewhere', detail: 'ZZZZ2226 and ZZZZ2227' });
  });

  it('still updates a keyless item its own DOI matches', () => {
    const article = item('ZZZZ2228', {
      title: 'Field notes',
      DOI: '10.4242/notes',
      pages: '1–5',
      creators: [{ creatorType: 'author', firstName: 'Ann', lastName: 'Reed' }],
    });
    const edited = '@article{reed_field_nodate,\n  title = {Field notes},\n  doi = {10.4242/notes},\n  author = {Reed, Ann},\n  pages = {1--6}\n}\n';
    expect(plan(edited, [article]).actions[0]).toMatchObject({ kind: 'update', itemKey: 'ZZZZ2228', changes: [{ field: 'pages' }] });
  });
});

describe('push: no notice for a title given as Zotero exports it', () => {
  const titled = (stored: string, tex: string) =>
    plan('@article{k,\n  title = {' + tex + '}\n}\n', [item('AAAA2222', { title: stored, citationKey: 'k' })]).actions[0];

  it('is quiet on unchanged exports with escapes beside letters, math signs and scripts', () => {
    // As Zotero's BibTeX export writes each stored title.
    for (const [stored, tex] of [
      ['Cost $5 per m<sup>2</sup>', 'Cost \\$5 per m$^{\\textrm{2}}$'],
      ['x~y', 'x{\\textasciitilde}y'],
      ['x^y', 'x{\\textasciicircum}y'],
      ['Ratio $\\frac{a}{bc}$', 'Ratio \\${\\textbackslash}frac\\{a\\}\\{bc\\}\\$'],
      ['Model ~ H<sub>2</sub>O', 'Model {\\textasciitilde} {H}$_{\\textrm{2}}${O}'],
      ['<i>K</i><sub>D</sub>', '\\textit{{K}}$_{\\textrm{{D}}}$'],
    ]) {
      expect(titled(stored, tex)).toMatchObject({ kind: 'unchanged', notPushed: [] });
    }
  });

  it('still reports an edit of any of them', () => {
    for (const [stored, tex] of [
      ['Cost $5 per m<sup>2</sup>', 'Cost \\$6 per m$^{\\textrm{2}}$'],
      ['Cost $5 per m<sup>2</sup>', 'Cost \\$5 per m$^{\\textrm{3}}$'],
      ['x~y', 'x{\\textasciitilde}z'],
      ['x^y', 'x{\\textasciicircum}Y'],
      ['Ratio $\\frac{a}{bc}$', 'Ratio $\\frac{ab}{c}$'],
      ['Ratio $\\frac{a}{bc}$', 'Ratio \\${\\textbackslash}frac\\{ab\\}\\{c\\}\\$'],
      ['Model ~ H<sub>2</sub>O', 'Model {\\textasciitilde} {H}$_{\\textrm{3}}${O}'],
    ]) {
      const a = titled(stored, tex);
      expect(a.kind === 'unchanged' ? a.notPushed.map(n => n.field) : a.kind).toEqual(['title']);
    }
  });
});
