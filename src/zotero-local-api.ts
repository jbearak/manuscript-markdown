/** Read-only adapter for Zotero's Local API (`http://localhost:23119/api`).
 *
 *  Turns one selected library into the `ZoteroCatalogItem[]` that
 *  `createZoteroLinkPlan` matches against.  Everything here is measured
 *  behavior of Zotero 9 (see docs/zotero-roundtrip.md once stage 4 lands):
 *
 *  - Zotero not running → the connection is refused.  The API setting off →
 *    HTTP 403 with the body `Local API is not enabled`.  The two read very
 *    differently to a user — "start Zotero" versus "turn on the setting in
 *    Settings → Advanced → Miscellaneous" — so they are distinct error kinds.
 *  - Requests address the personal library as `/users/0/` ("whoever is logged
 *    in"), but a URI written into a document must never carry that
 *    placeholder: every item response includes `library: {type, id}` with the
 *    library's real id, and the canonical URI is built from that.  A personal
 *    library whose real id is unknown (never logged in) cannot yield portable
 *    URIs at all, so the whole fetch fails with `user-id-unavailable` rather
 *    than linking entries to URIs nobody else — and no future login — can
 *    resolve.
 *  - Results are paginated (`Total-Results` header); a full scan of a
 *    20k-item group at 500/page is seconds, while per-entry `q=` searches
 *    return fuzzy false positives — so the whole library is fetched once and
 *    matched in memory.
 *  - Attachments, notes and annotations appear in item listings.  They carry
 *    no bibliography identity and are dropped here so the matcher never sees
 *    them.
 *
 *  No `vscode` import: the transport is a `fetch`-shaped parameter, injected
 *  by tests and defaulted for the extension. */

import type { ZoteroCatalogItem } from './zotero-link';

/** Where Zotero 9 serves its Local API.  Fixed by Zotero, not configurable
 *  in its settings UI. */
const ZOTERO_LOCAL_API_BASE = 'http://localhost:23119/api';

/** Page size for item listings.  Zotero caps pages at 100 by default; 500 cut
 *  a 23k-item scan to ~47 requests in measurement. */
const PAGE_LIMIT = 500;

/** Per-request deadline.  A healthy local Zotero answers a 500-item page in
 *  well under a second; five seconds of silence means something is wedged and
 *  the command should say so instead of hanging the progress dialog. */
const REQUEST_TIMEOUT_MS = 5000;

export type ZoteroLocalApiErrorKind =
  /** Nothing is listening — Zotero is not running. */
  | 'not-running'
  /** Zotero answered 403: the "Allow other applications on this computer to
   *  communicate with Zotero" setting (Settings → Advanced → Miscellaneous)
   *  is off. */
  | 'api-disabled'
  /** A request exceeded its deadline. */
  | 'timeout'
  /** A personal-library item carries no real library id, so no portable URI
   *  can be built for it (the user has never logged in to Zotero). */
  | 'user-id-unavailable'
  /** Any other failed request or unreadable response. */
  | 'request-failed';

export class ZoteroLocalApiError extends Error {
  constructor(
    readonly kind: ZoteroLocalApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ZoteroLocalApiError';
  }
}

/** One library the user can link against. */
export interface ZoteroLibraryRef {
  readonly type: 'user' | 'group';
  /** Group id for groups.  0 for the personal library: its request address is
   *  the `/users/0/` placeholder, and its real id is read from the items it
   *  returns, never from this field. */
  readonly id: number;
  readonly name: string;
  /** As reported by Zotero.  Counts attachments and notes too, so it is an
   *  upper bound on linkable items — display it, don't reason from it. */
  readonly itemCount: number;
}

/** The transport this adapter needs: the WHATWG `fetch` shape, injectable so
 *  tests can serve canned pages and the extension can pass the global. */
export type ZoteroFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface ZoteroLocalApiOptions {
  readonly fetchFn?: ZoteroFetch;
  readonly timeoutMs?: number;
}

/** One GET against the Local API, with the error taxonomy applied. */
async function request(
  path: string,
  options: ZoteroLocalApiOptions,
): ReturnType<ZoteroFetch> {
  const fetchFn = options.fetchFn ?? (fetch as unknown as ZoteroFetch);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let response: Awaited<ReturnType<ZoteroFetch>>;
  try {
    response = await fetchFn(ZOTERO_LOCAL_API_BASE + path, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // An abort is the deadline firing; anything else from a localhost fetch
    // is a refused connection, which means Zotero itself is not running.
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ZoteroLocalApiError('timeout', 'Zotero did not answer within ' + timeoutMs + 'ms.');
    }
    throw new ZoteroLocalApiError('not-running', 'Could not connect to Zotero on localhost:23119.');
  }
  if (response.status === 403) {
    throw new ZoteroLocalApiError(
      'api-disabled',
      'Zotero is running but its local API is turned off.',
    );
  }
  if (!response.ok) {
    throw new ZoteroLocalApiError('request-failed', 'Zotero answered HTTP ' + response.status + ' for ' + path + '.');
  }
  return response;
}

/** The response body as a JSON array, or `request-failed` — the Local API
 *  lists both groups and items as arrays, so anything else is a protocol
 *  surprise worth failing loudly on. */
async function requestArray(path: string, options: ZoteroLocalApiOptions): Promise<{
  rows: unknown[];
  totalResults: number | undefined;
}> {
  const response = await request(path, options);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ZoteroLocalApiError('request-failed', 'Zotero returned unreadable JSON for ' + path + '.');
  }
  if (!Array.isArray(body)) {
    throw new ZoteroLocalApiError('request-failed', 'Zotero returned a non-list response for ' + path + '.');
  }
  const header = response.headers.get('Total-Results');
  const totalResults = header === null ? undefined : Number(header);
  return { rows: body, totalResults: Number.isFinite(totalResults) ? totalResults : undefined };
}

/** Every row of a paginated listing.
 *
 *  Advances by the rows actually received rather than by the page limit, so a
 *  server that returns short pages is walked correctly, and stops on an empty
 *  page whatever `Total-Results` claims — a header that overstates the total
 *  must not loop the command forever. */
async function requestAllPages(path: string, options: ZoteroLocalApiOptions): Promise<unknown[]> {
  const all: unknown[] = [];
  let start = 0;
  for (;;) {
    const separator = path.includes('?') ? '&' : '?';
    const { rows, totalResults } = await requestArray(
      path + separator + 'limit=' + PAGE_LIMIT + '&start=' + start,
      options,
    );
    all.push(...rows);
    if (rows.length === 0) break;
    start += rows.length;
    if (totalResults === undefined || start >= totalResults) break;
  }
  return all;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** The libraries the running Zotero can serve: every group, then the personal
 *  library last.  (The command's picker keeps that order: group URIs resolve
 *  for every member, personal URIs only for their owner, so groups are the
 *  collaborative default.) */
export async function listZoteroLibraries(
  options: ZoteroLocalApiOptions = {},
): Promise<ZoteroLibraryRef[]> {
  const groupsPromise = requestAllPages('/users/0/groups', options);
  // Only the header is wanted; one item is the smallest page Zotero serves.
  // Trashed items are excluded, as they are from the catalog fetch: a count
  // of what the command can actually link against.
  const countPromise = requestArray('/users/0/items?limit=1', options);
  const [groupRows, count] = await Promise.all([groupsPromise, countPromise]);

  const refs: ZoteroLibraryRef[] = [];
  for (const row of groupRows) {
    const record = asRecord(row);
    const data = asRecord(record?.data);
    const id = typeof record?.id === 'number' ? record.id : undefined;
    const name = asString(data?.name);
    if (id === undefined || name === undefined) continue;
    const meta = asRecord(record?.meta);
    const numItems = typeof meta?.numItems === 'number' ? meta.numItems : 0;
    refs.push({ type: 'group', id, name, itemCount: numItems });
  }
  refs.sort((a, b) => a.name.localeCompare(b.name));
  refs.push({ type: 'user', id: 0, name: 'My Library', itemCount: count.totalResults ?? 0 });
  return refs;
}

/** Item types that carry no bibliography identity of their own. */
const NON_BIBLIOGRAPHIC_TYPES: ReadonlySet<string> = new Set([
  'attachment',
  'note',
  'annotation',
]);

/** One API item row reduced to a catalog item, or undefined for rows the
 *  matcher must never see (attachments, notes, malformed rows). */
function toCatalogItem(row: unknown): ZoteroCatalogItem | undefined {
  const record = asRecord(row);
  const data = asRecord(record?.data);
  if (data === undefined) return undefined;
  const key = asString(data.key);
  if (key === undefined) return undefined;
  const itemType = asString(data.itemType);
  if (itemType === undefined || NON_BIBLIOGRAPHIC_TYPES.has(itemType)) return undefined;

  // The canonical URI comes from the row's own `library`, not from how the
  // request was addressed: `/users/0/` is a placeholder that names no
  // library, and writing it into a document would produce links nobody can
  // resolve.  Group and personal rows carry the same shape.
  const library = asRecord(record?.library);
  const libraryType = library?.type;
  const libraryId = library?.id;
  if (
    (libraryType !== 'user' && libraryType !== 'group') ||
    typeof libraryId !== 'number' ||
    !Number.isInteger(libraryId) ||
    libraryId < 1
  ) {
    throw new ZoteroLocalApiError(
      'user-id-unavailable',
      'Zotero reported no real library id for item ' + key +
        '; log in to Zotero so items have portable identities.',
    );
  }
  const uri =
    'http://zotero.org/' +
    (libraryType === 'user' ? 'users/' : 'groups/') +
    libraryId +
    '/items/' +
    key;

  return {
    key,
    uri,
    title: asString(data.title),
    citationKey: asString(data.citationKey),
    doi: asString(data.DOI),
    isbn: asString(data.ISBN),
    extra: asString(data.extra),
  };
}

/** Every bibliographic item in one library, in matcher-ready form.
 *
 *  Fetches the whole library: identifier matching needs the full catalog to
 *  detect ambiguity, and a paged scan is fast where per-item searches are
 *  both slow and fuzzy. */
export async function fetchZoteroCatalog(
  library: ZoteroLibraryRef,
  options: ZoteroLocalApiOptions = {},
): Promise<ZoteroCatalogItem[]> {
  const path = library.type === 'user' ? '/users/0/items' : '/groups/' + library.id + '/items';
  const rows = await requestAllPages(path, options);
  const items: ZoteroCatalogItem[] = [];
  for (const row of rows) {
    const item = toCatalogItem(row);
    if (item) items.push(item);
  }
  return items;
}
