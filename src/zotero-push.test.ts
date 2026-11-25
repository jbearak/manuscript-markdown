import { describe, it, expect } from 'bun:test';
import { createZoteroLinkPlan, type ZoteroCatalogItem } from './zotero-link';
import {
  createZoteroPushPlan,
  zoteroPushWrites,
  type ZoteroItemJson,
  type ZoteroItemSchema,
  type ZoteroPushMode,
} from './zotero-push';
import { applyZoteroPush, formatZoteroPushReport, type ZoteroKeyProvider } from './zotero-push-run';
import {
  authorizeZoteroLocalApi,
  fetchZoteroLibrarySnapshot,
  writeZoteroItems,
  ZoteroLocalApiError,
  type ZoteroFetch,
} from './zotero-local-api';
import { resolveCollection, runZoteroCli } from './zotero-cli';

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
      fields: ['title', 'publicationTitle', 'date', 'volume', 'issue', 'pages', 'series', 'DOI', 'url', 'ISSN', 'citationKey', 'extra', 'abstractNote', 'shortTitle'].map(f => field(f)),
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

function plan(bibText: string, items: readonly ZoteroItemJson[], mode: ZoteroPushMode = 'update') {
  const link = createZoteroLinkPlan(bibText, catalogOf(items));
  return createZoteroPushPlan({
    bibText,
    decisions: link.decisions,
    items: new Map(items.map(i => [i.key, i])),
    schema: SCHEMA,
    collectionKey: COLLECTION,
    mode,
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
        },
        notPushed: [{ field: 'note', reason: 'no-zotero-field' }],
      },
    ]);
  });

  it('never writes a value that still holds TeX', () => {
    const bib = FLATO_BIB.replace('{{Sub-Saharan Africa}}', '\\emph{Sub-Saharan Africa}');
    const p = plan(bib, [FLATO]);
    expect(p.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'title', reason: 'tex' }] });
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
      ['type: JournalArticle', true],
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
    const impossible = plan(FLATO_BIB.replace('year = 2018', 'date = {2024-99-99}'), [forthcoming]);
    expect(impossible.actions[0]).toMatchObject({ kind: 'unchanged', notPushed: [{ field: 'year', reason: 'date-unreadable' }] });
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
    expect(plan(bib, [accessed as ZoteroItemJson]).changed).toBe(false);
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

function writeFetch(respond: (sent: Sent, n: number) => { status: number; body?: unknown; version?: number; text?: string }) {
  const sent: Sent[] = [];
  const fetchFn: ZoteroFetch = async (url, init) => {
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

describe('fetchZoteroLibrarySnapshot', () => {
  it("lets the matcher see Zotero 10's PMID field", async () => {
    const row = {
      key: 'PMID0001',
      library: { type: 'user', id: 1 },
      // The field, not a stale line of Extra, is the one to match on.
      data: { key: 'PMID0001', version: 3, itemType: 'journalArticle', title: 'Paper', PMID: '12345678', extra: 'PMID: 99999999', creators: [] },
      meta: {},
    };
    const fetchFn: ZoteroFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [row],
      headers: { get: (n: string) => (n === 'Last-Modified-Version' ? '7' : n === 'Zotero-Server-ID' ? 'S' : null) },
    });
    const snapshot = await fetchZoteroLibrarySnapshot({ type: 'user' }, { fetchFn });
    const bib = '@article{renamed,\n  title = {A Revised Title},\n  pmid = {12345678}\n}\n';
    const decision = createZoteroLinkPlan(bib, snapshot.catalog).decisions[0];
    expect(decision).toMatchObject({ outcome: 'update', tier: 'isbn-pmid', target: { key: 'PMID0001' } });
    expect(snapshot.libraryVersion).toBe(7);
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
      s.headers['Zotero-API-Key'] === 'OLD' ? { status: 401 } : { status: 200, version: 9, body: { successful: {} } },
    );
    await applyZoteroPush({ type: 'user' }, prepared, provider, { fetchFn });
    expect(provider.invalidated).toBe(1);
    expect(sent.map(s => s.headers['Zotero-API-Key'])).toEqual(['OLD', 'NEW', 'NEW']);
  });

  it("marks a batch whose answer never came as unknown, not unsent", async () => {
    const fetchFn: ZoteroFetch = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    const result = await applyZoteroPush({ type: 'user' }, prepared, keys(), { fetchFn });
    expect(result.error?.kind).toBe('timeout');
    expect(result.outcomes.slice(0, 50).every(o => o === 'unknown')).toBe(true);
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

  it('reports a usage error with exit code 2', async () => {
    const err: string[] = [];
    const code = await runZoteroCli(['push', 'refs.bib'], { out: () => {}, err: line => err.push(line) });
    expect(code).toBe(2);
    expect(err[0]).toBe('--collection is required.');
  });
});
