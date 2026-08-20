import { describe, it, expect } from 'bun:test';
import {
  listZoteroLibraries,
  fetchZoteroCatalog,
  ZoteroLocalApiError,
  type ZoteroFetch,
  type ZoteroLibraryRef,
} from './zotero-local-api';

// ---------------------------------------------------------------------------
// Transport fakes
// ---------------------------------------------------------------------------

interface CannedResponse {
  status?: number;
  body?: unknown;
  totalResults?: number;
}

/** A fetch that answers each URL from a route table and records what was
 *  asked.  Routes match by substring so tests state only what they are
 *  about. */
function fakeFetch(
  routes: Array<[match: string, respond: (url: string) => CannedResponse]>,
): { fetchFn: ZoteroFetch; requests: string[] } {
  const requests: string[] = [];
  const fetchFn: ZoteroFetch = async url => {
    requests.push(url);
    const route = routes.find(([match]) => url.includes(match));
    if (!route) throw new Error('unrouted URL in test: ' + url);
    const canned = route[1](url);
    const status = canned.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          name === 'Total-Results' && canned.totalResults !== undefined
            ? String(canned.totalResults)
            : null,
      },
      json: async () => canned.body,
    };
  };
  return { fetchFn, requests };
}

const startOf = (url: string): number => Number(new URL(url).searchParams.get('start') ?? '0');

/** An item row as the Local API shapes it. */
function apiItem(
  key: string,
  fields: Partial<{
    itemType: string;
    title: string;
    DOI: string;
    ISBN: string;
    extra: string;
    citationKey: string;
  }> = {},
  library: { type: 'user' | 'group'; id: number } | null = { type: 'group', id: 2295646 },
): unknown {
  return {
    key,
    library: library === null ? undefined : { type: library.type, id: library.id, name: 'L' },
    data: { key, itemType: fields.itemType ?? 'journalArticle', ...fields },
  };
}

const GROUP_LIB: ZoteroLibraryRef = { type: 'group', id: 2295646, name: 'G', itemCount: 3 };
const USER_LIB: ZoteroLibraryRef = { type: 'user', id: 0, name: 'My Library', itemCount: 3 };

async function expectKind(promise: Promise<unknown>, kind: string): Promise<ZoteroLocalApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ZoteroLocalApiError);
    const apiError = error as ZoteroLocalApiError;
    expect(apiError.kind).toBe(kind);
    return apiError;
  }
  throw new Error('expected the call to reject with ' + kind);
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

describe('zotero-local-api error taxonomy', () => {
  it('reports a refused connection as Zotero not running', async () => {
    const fetchFn: ZoteroFetch = async () => {
      throw new TypeError('fetch failed: connection refused');
    };
    await expectKind(fetchZoteroCatalog(GROUP_LIB, { fetchFn }), 'not-running');
  });

  it('reports HTTP 403 as the local API being disabled', async () => {
    // Zotero running with the "Allow other applications…" setting off answers
    // 403 — a different user action than starting Zotero, so a distinct kind.
    const { fetchFn } = fakeFetch([['/items', () => ({ status: 403 })]]);
    await expectKind(fetchZoteroCatalog(GROUP_LIB, { fetchFn }), 'api-disabled');
  });

  it('reports an abort as a timeout', async () => {
    const fetchFn: ZoteroFetch = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    await expectKind(fetchZoteroCatalog(GROUP_LIB, { fetchFn }), 'timeout');
  });

  it('passes its deadline to the transport as an abort signal', async () => {
    let sawSignal: AbortSignal | undefined;
    const fetchFn: ZoteroFetch = async (_url, init) => {
      sawSignal = init?.signal;
      return {
        ok: true,
        status: 200,
        headers: { get: () => '0' },
        json: async () => [],
      };
    };
    await fetchZoteroCatalog(GROUP_LIB, { fetchFn, timeoutMs: 1234 });
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it('reports other HTTP failures with their status', async () => {
    const { fetchFn } = fakeFetch([['/items', () => ({ status: 500 })]]);
    const error = await expectKind(fetchZoteroCatalog(GROUP_LIB, { fetchFn }), 'request-failed');
    expect(error.message).toContain('500');
  });

  it('reports a non-list response as a failed request', async () => {
    const { fetchFn } = fakeFetch([['/items', () => ({ body: { not: 'a list' } })]]);
    await expectKind(fetchZoteroCatalog(GROUP_LIB, { fetchFn }), 'request-failed');
  });
});

// ---------------------------------------------------------------------------
// Catalog fetching
// ---------------------------------------------------------------------------

describe('fetchZoteroCatalog', () => {
  it('maps item rows to catalog items with canonical group URIs', async () => {
    const { fetchFn } = fakeFetch([
      ['/groups/2295646/items', () => ({
        body: [apiItem('ABCD1234', { title: 'T', DOI: '10.1/a', ISBN: '9780306406157', extra: 'PMID: 123' })],
        totalResults: 1,
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_LIB, { fetchFn });
    expect(items).toEqual([
      {
        key: 'ABCD1234',
        uri: 'http://zotero.org/groups/2295646/items/ABCD1234',
        title: 'T',
        citationKey: undefined,
        doi: '10.1/a',
        isbn: '9780306406157',
        extra: 'PMID: 123',
      },
    ]);
  });

  it('builds personal URIs from the real library id, never /users/0/', async () => {
    // Requests address the personal library as the /users/0/ placeholder, but
    // each row's `library` carries the real id — the only id worth writing.
    const { fetchFn, requests } = fakeFetch([
      ['/users/0/items', () => ({
        body: [apiItem('ABCD1234', {}, { type: 'user', id: 2417153 })],
        totalResults: 1,
      })],
    ]);
    const items = await fetchZoteroCatalog(USER_LIB, { fetchFn });
    expect(items[0].uri).toBe('http://zotero.org/users/2417153/items/ABCD1234');
    expect(requests[0]).toContain('/users/0/items');
  });

  it('fails the whole fetch when a personal item has no real library id', async () => {
    // A URI built without a real id is one nobody — including the user after
    // a future login — can resolve.  Better to link nothing than that.
    const { fetchFn } = fakeFetch([
      ['/users/0/items', () => ({
        body: [apiItem('ABCD1234', {}, null)],
        totalResults: 1,
      })],
    ]);
    await expectKind(fetchZoteroCatalog(USER_LIB, { fetchFn }), 'user-id-unavailable');
  });

  it('rejects a library id of 0 as unavailable, not as an identity', async () => {
    const { fetchFn } = fakeFetch([
      ['/users/0/items', () => ({
        body: [apiItem('ABCD1234', {}, { type: 'user', id: 0 })],
        totalResults: 1,
      })],
    ]);
    await expectKind(fetchZoteroCatalog(USER_LIB, { fetchFn }), 'user-id-unavailable');
  });

  it('drops attachments, notes and annotations', async () => {
    const { fetchFn } = fakeFetch([
      ['/items', () => ({
        body: [
          apiItem('AAAAAAAA', { itemType: 'attachment' }),
          apiItem('BBBBBBBB', { itemType: 'note' }),
          apiItem('CCCCCCCC', { itemType: 'annotation' }),
          apiItem('DDDDDDDD', { itemType: 'book' }),
        ],
        totalResults: 4,
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_LIB, { fetchFn });
    expect(items.map(i => i.key)).toEqual(['DDDDDDDD']);
  });

  it('skips malformed rows without failing the fetch', async () => {
    const { fetchFn } = fakeFetch([
      ['/items', () => ({
        body: [null, 42, { data: {} }, apiItem('DDDDDDDD')],
        totalResults: 4,
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_LIB, { fetchFn });
    expect(items.map(i => i.key)).toEqual(['DDDDDDDD']);
  });

  it('walks every page of a paginated listing', async () => {
    // 1200 items at limit=500: three pages, the last one short.
    const all = Array.from({ length: 1200 }, (_, i) =>
      apiItem('K' + String(i).padStart(7, '0')),
    );
    const { fetchFn, requests } = fakeFetch([
      ['/items', url => ({
        body: all.slice(startOf(url), startOf(url) + 500),
        totalResults: 1200,
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_LIB, { fetchFn });
    expect(items.length).toBe(1200);
    expect(items[0].key).toBe('K0000000');
    expect(items[1199].key).toBe('K0001199');
    expect(requests.length).toBe(3);
    expect(requests.every(u => u.includes('limit=500'))).toBe(true);
  });

  it('advances by rows received, not by the page limit', async () => {
    // A server that serves short pages must still be walked completely.
    const all = Array.from({ length: 250 }, (_, i) =>
      apiItem('K' + String(i).padStart(7, '0')),
    );
    const { fetchFn, requests } = fakeFetch([
      ['/items', url => ({
        body: all.slice(startOf(url), startOf(url) + 100),
        totalResults: 250,
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_LIB, { fetchFn });
    expect(items.length).toBe(250);
    expect(requests.length).toBe(3);
  });

  it('stops on an empty page even when Total-Results overstates', async () => {
    // A lying header must not loop the command forever.
    const { fetchFn, requests } = fakeFetch([
      ['/items', url => ({
        body: startOf(url) === 0 ? [apiItem('AAAAAAAA')] : [],
        totalResults: 9999,
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_LIB, { fetchFn });
    expect(items.length).toBe(1);
    expect(requests.length).toBe(2);
  });

  it('stops after one page when Total-Results is missing', async () => {
    const { fetchFn, requests } = fakeFetch([
      ['/items', () => ({ body: [apiItem('AAAAAAAA')] })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_LIB, { fetchFn });
    expect(items.length).toBe(1);
    expect(requests.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Library listing
// ---------------------------------------------------------------------------

describe('listZoteroLibraries', () => {
  const groupRow = (id: number, name: string, numItems: number) => ({
    id,
    data: { id, name },
    meta: { numItems },
  });

  it('lists groups sorted by name with the personal library last', async () => {
    const { fetchFn } = fakeFetch([
      ['/users/0/groups', () => ({ body: [groupRow(2, 'Zeta', 5), groupRow(1, 'Alpha', 9)] })],
      ['/users/0/items', () => ({ body: [], totalResults: 1393 })],
    ]);
    const libraries = await listZoteroLibraries({ fetchFn });
    expect(libraries.map(l => l.name)).toEqual(['Alpha', 'Zeta', 'My Library']);
    expect(libraries[0]).toEqual({ type: 'group', id: 1, name: 'Alpha', itemCount: 9 });
    expect(libraries[2]).toEqual({ type: 'user', id: 0, name: 'My Library', itemCount: 1393 });
  });

  it('offers the personal library even with no groups', async () => {
    const { fetchFn } = fakeFetch([
      ['/users/0/groups', () => ({ body: [] })],
      ['/users/0/items', () => ({ body: [], totalResults: 0 })],
    ]);
    const libraries = await listZoteroLibraries({ fetchFn });
    expect(libraries).toEqual([{ type: 'user', id: 0, name: 'My Library', itemCount: 0 }]);
  });

  it('skips malformed group rows', async () => {
    const { fetchFn } = fakeFetch([
      ['/users/0/groups', () => ({ body: [null, { id: 'x' }, groupRow(7, 'Ok', 1)] })],
      ['/users/0/items', () => ({ body: [], totalResults: 0 })],
    ]);
    const libraries = await listZoteroLibraries({ fetchFn });
    expect(libraries.map(l => l.name)).toEqual(['Ok', 'My Library']);
  });

  it('surfaces the not-running error from either request', async () => {
    const fetchFn: ZoteroFetch = async () => {
      throw new TypeError('connection refused');
    };
    await expectKind(listZoteroLibraries({ fetchFn }), 'not-running');
  });
});
