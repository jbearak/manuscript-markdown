import { describe, it, expect } from 'bun:test';
import {
  listZoteroGroups,
  fetchZoteroCatalog,
  ZoteroLocalApiError,
  type ZoteroFetch,
  type ZoteroLibraryScope,
} from './zotero-local-api';

// ---------------------------------------------------------------------------
// Transport fakes
// ---------------------------------------------------------------------------

interface CannedResponse {
  status?: number;
  body?: unknown;
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
      json: async () => canned.body,
    };
  };
  return { fetchFn, requests };
}

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

const GROUP_SCOPE: ZoteroLibraryScope = { type: 'group', groupId: 2295646 };
const USER_SCOPE: ZoteroLibraryScope = { type: 'user' };

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
    await expectKind(fetchZoteroCatalog(GROUP_SCOPE, { fetchFn }), 'not-running');
  });

  it('reports HTTP 403 as the local API being disabled', async () => {
    // Zotero running with the "Allow other applications…" setting off answers
    // 403 — a different user action than starting Zotero, so a distinct kind.
    const { fetchFn } = fakeFetch([['/items', () => ({ status: 403 })]]);
    await expectKind(fetchZoteroCatalog(GROUP_SCOPE, { fetchFn }), 'api-disabled');
  });

  it('reports an abort during the request as a timeout', async () => {
    const fetchFn: ZoteroFetch = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    await expectKind(fetchZoteroCatalog(GROUP_SCOPE, { fetchFn }), 'timeout');
  });

  it('distinguishes a caller abort from its own deadline', async () => {
    const controller = new AbortController();
    const fetchFn: ZoteroFetch = async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    };
    await expectKind(
      fetchZoteroCatalog(GROUP_SCOPE, { fetchFn, signal: controller.signal }),
      'aborted',
    );
  });

  it('reports a deadline timeout even when the caller aborts moments later', async () => {
    // Classification must ride on the rejection's own name, not on signal
    // state sampled afterwards: the deadline fired first, so it is a timeout
    // the user should hear about, even though Cancel was pressed too.
    const controller = new AbortController();
    const fetchFn: ZoteroFetch = async () => {
      controller.abort();
      throw new DOMException('timed out', 'TimeoutError');
    };
    await expectKind(
      fetchZoteroCatalog(GROUP_SCOPE, { fetchFn, signal: controller.signal }),
      'timeout',
    );
  });

  it('reports an abort while reading the body as a timeout too', async () => {
    // Headers arriving before the deadline while the body stalls is as hung
    // as a request that never answered — not "unreadable JSON".
    const fetchFn: ZoteroFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    });
    await expectKind(fetchZoteroCatalog(GROUP_SCOPE, { fetchFn }), 'timeout');
  });

  it('does not blame Zotero for a non-network transport failure', async () => {
    // Only TypeError is fetch's connection-failure shape; anything else is a
    // defect in the transport or its arguments, and "start Zotero" would be
    // the wrong advice.
    const fetchFn: ZoteroFetch = async () => {
      throw new RangeError('bad argument');
    };
    await expectKind(fetchZoteroCatalog(GROUP_SCOPE, { fetchFn }), 'request-failed');
  });

  it('passes its deadline to the transport as an abort signal', async () => {
    let sawSignal: AbortSignal | undefined;
    const fetchFn: ZoteroFetch = async (_url, init) => {
      sawSignal = init?.signal;
      return { ok: true, status: 200, json: async () => [] };
    };
    await fetchZoteroCatalog(GROUP_SCOPE, { fetchFn });
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it('pins the API version on every request', async () => {
    let sawHeaders: Record<string, string> | undefined;
    const fetchFn: ZoteroFetch = async (_url, init) => {
      sawHeaders = init?.headers;
      return { ok: true, status: 200, json: async () => [] };
    };
    await fetchZoteroCatalog(GROUP_SCOPE, { fetchFn });
    expect(sawHeaders?.['Zotero-API-Version']).toBe('3');
  });

  it('reports other HTTP failures with their status', async () => {
    const { fetchFn } = fakeFetch([['/items', () => ({ status: 500 })]]);
    const error = await expectKind(fetchZoteroCatalog(GROUP_SCOPE, { fetchFn }), 'request-failed');
    expect(error.message).toContain('500');
  });

  it('reports unreadable and non-list responses as failed requests', async () => {
    const badJson: ZoteroFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('unexpected token');
      },
    });
    await expectKind(fetchZoteroCatalog(GROUP_SCOPE, { fetchFn: badJson }), 'request-failed');

    const { fetchFn } = fakeFetch([['/items', () => ({ body: { not: 'a list' } })]]);
    await expectKind(fetchZoteroCatalog(GROUP_SCOPE, { fetchFn }), 'request-failed');
  });
});

// ---------------------------------------------------------------------------
// Catalog fetching
// ---------------------------------------------------------------------------

describe('fetchZoteroCatalog', () => {
  it('fetches top-level items in one unpaginated request', async () => {
    // One request is one coherent snapshot; /items/top keeps child
    // attachments and notes on the server.
    const { fetchFn, requests } = fakeFetch([
      ['/groups/2295646/items/top', () => ({ body: [apiItem('ABCD1234')] })],
    ]);
    await fetchZoteroCatalog(GROUP_SCOPE, { fetchFn });
    expect(requests).toEqual(['http://localhost:23119/api/groups/2295646/items/top']);
  });

  it('maps item rows to catalog items with canonical group URIs', async () => {
    const { fetchFn } = fakeFetch([
      ['/groups/2295646/items/top', () => ({
        body: [apiItem('ABCD1234', { title: 'T', DOI: '10.1/a', ISBN: '9780306406157', extra: 'PMID: 123' })],
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_SCOPE, { fetchFn });
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

  it('builds group URIs from the selected group, whatever the rows claim', async () => {
    // The request URL is the authority on which library the rows belong to.
    // A row with a missing or garbled `library` envelope must neither fail
    // the fetch nor redirect its item into another library.
    const { fetchFn } = fakeFetch([
      ['/groups/2295646/items/top', () => ({
        body: [
          apiItem('AAAAAAAA', {}, null),
          apiItem('BBBBBBBB', {}, { type: 'user', id: 2417153 }),
        ],
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_SCOPE, { fetchFn });
    expect(items.map(i => i.uri)).toEqual([
      'http://zotero.org/groups/2295646/items/AAAAAAAA',
      'http://zotero.org/groups/2295646/items/BBBBBBBB',
    ]);
  });

  it('builds personal URIs from the real library id, never /users/0/', async () => {
    // Requests address the personal library as the /users/0/ placeholder, but
    // each row's `library` carries the real id — the only id worth writing.
    const { fetchFn, requests } = fakeFetch([
      ['/users/0/items/top', () => ({
        body: [
          apiItem('ABCD1234', {}, { type: 'user', id: 2417153 }),
          // A row whose envelope is missing rides along on its siblings' id.
          apiItem('EFGH5678', {}, null),
        ],
      })],
    ]);
    const items = await fetchZoteroCatalog(USER_SCOPE, { fetchFn });
    expect(items.map(i => i.uri)).toEqual([
      'http://zotero.org/users/2417153/items/ABCD1234',
      'http://zotero.org/users/2417153/items/EFGH5678',
    ]);
    expect(requests[0]).toContain('/users/0/items/top');
  });

  it.each([
    ['no library envelope at all', null],
    ['a library id of 0', { type: 'user' as const, id: 0 }],
    ['a negative library id', { type: 'user' as const, id: -1 }],
    ['a fractional library id', { type: 'user' as const, id: 1.5 }],
    ['a NaN library id', { type: 'user' as const, id: Number.NaN }],
  ])('fails a personal fetch whose rows carry %s', async (_what, library) => {
    // A URI built without a real id is one nobody — including the user after
    // a future login — can resolve.  Better to link nothing than that.
    const { fetchFn } = fakeFetch([
      ['/users/0/items/top', () => ({ body: [apiItem('ABCD1234', {}, library)] })],
    ]);
    await expectKind(fetchZoteroCatalog(USER_SCOPE, { fetchFn }), 'user-id-unavailable');
  });

  it('returns an empty catalog for an empty personal library, id or not', async () => {
    const { fetchFn } = fakeFetch([['/users/0/items/top', () => ({ body: [] })]]);
    expect(await fetchZoteroCatalog(USER_SCOPE, { fetchFn })).toEqual([]);
  });

  it('fails when personal rows disagree about the library id', async () => {
    const { fetchFn } = fakeFetch([
      ['/users/0/items/top', () => ({
        body: [
          apiItem('AAAAAAAA', {}, { type: 'user', id: 1 }),
          apiItem('BBBBBBBB', {}, { type: 'user', id: 2 }),
        ],
      })],
    ]);
    await expectKind(fetchZoteroCatalog(USER_SCOPE, { fetchFn }), 'request-failed');
  });

  it('drops standalone attachments, notes and annotations', async () => {
    const { fetchFn } = fakeFetch([
      ['/items/top', () => ({
        body: [
          apiItem('AAAAAAAA', { itemType: 'attachment' }),
          apiItem('BBBBBBBB', { itemType: 'note' }),
          apiItem('CCCCCCCC', { itemType: 'annotation' }),
          apiItem('DDDDDDDD', { itemType: 'book' }),
        ],
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_SCOPE, { fetchFn });
    expect(items.map(i => i.key)).toEqual(['DDDDDDDD']);
  });

  it('skips malformed rows without failing the fetch', async () => {
    // Includes keys that are not 8 uppercase alphanumerics: everything
    // written into a document is validated against that pattern, so a row
    // that fails it would be an unwritable catalog item.
    const { fetchFn } = fakeFetch([
      ['/items/top', () => ({
        body: [null, 42, { data: {} }, apiItem('abcd1234'), apiItem('TOOLONGKEY1'), apiItem('DDDDDDDD')],
      })],
    ]);
    const items = await fetchZoteroCatalog(GROUP_SCOPE, { fetchFn });
    expect(items.map(i => i.key)).toEqual(['DDDDDDDD']);
  });
});

// ---------------------------------------------------------------------------
// Group listing
// ---------------------------------------------------------------------------

describe('listZoteroGroups', () => {
  const groupRow = (id: number, name: string, numItems: number) => ({
    id,
    data: { id, name },
    meta: { numItems },
  });

  it('lists groups in server order with their reported item counts', async () => {
    const { fetchFn } = fakeFetch([
      ['/users/0/groups', () => ({ body: [groupRow(2, 'Zeta', 5), groupRow(1, 'Alpha', 9)] })],
    ]);
    const groups = await listZoteroGroups({ fetchFn });
    expect(groups).toEqual([
      { groupId: 2, name: 'Zeta', itemCount: 5 },
      { groupId: 1, name: 'Alpha', itemCount: 9 },
    ]);
  });

  it('returns an empty list when there are no groups', async () => {
    const { fetchFn } = fakeFetch([['/users/0/groups', () => ({ body: [] })]]);
    expect(await listZoteroGroups({ fetchFn })).toEqual([]);
  });

  it('skips malformed group rows and rejects non-identity ids', async () => {
    const { fetchFn } = fakeFetch([
      ['/users/0/groups', () => ({
        body: [null, { id: 'x' }, groupRow(0, 'Zero', 1), groupRow(-3, 'Neg', 1), groupRow(7, 'Ok', 1)],
      })],
    ]);
    const groups = await listZoteroGroups({ fetchFn });
    expect(groups.map(g => g.name)).toEqual(['Ok']);
  });

  it('surfaces the not-running error', async () => {
    const fetchFn: ZoteroFetch = async () => {
      throw new TypeError('connection refused');
    };
    await expectKind(listZoteroGroups({ fetchFn }), 'not-running');
  });
});
