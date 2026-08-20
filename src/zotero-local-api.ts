/** Read-only adapter for Zotero's Local API (`http://localhost:23119/api`).
 *
 *  Turns one selected library into the `ZoteroCatalogItem[]` that
 *  `createZoteroLinkPlan` matches against.  Everything here is measured
 *  behavior of Zotero 9:
 *
 *  - Zotero not running → the connection is refused.  The API setting off →
 *    HTTP 403 with the body `Local API is not enabled`.  The two read very
 *    differently to a user — "start Zotero" versus "turn on the setting in
 *    Settings → Advanced → Miscellaneous" — so they are distinct error kinds.
 *  - The catalog is fetched in ONE unpaginated request.  The Local API has no
 *    default or maximum `limit`, and its server reruns the *whole* library
 *    search and sort for every request before slicing out a page — so a paged
 *    scan multiplies that work per page and, worse, a write landing between
 *    pages shifts the offsets and silently skips or duplicates an item.  One
 *    request is one coherent snapshot.  (Measured: 17,471 rows in 2.3s.)
 *  - `/items/top` rather than `/items`: child attachments, notes and
 *    annotations never leave the server (17,471 vs 23,134 rows on the same
 *    library).  Standalone non-bibliographic items still appear and are
 *    dropped here so the matcher never sees them.
 *  - Requests address the personal library as `/users/0/` ("whoever is logged
 *    in"), but a URI written into a document must never carry that
 *    placeholder.  For a group, the selected group id is authoritative — it
 *    is in the request URL itself.  For the personal library, the real id is
 *    resolved once from the `library` envelope the rows carry when the user
 *    has an account; without one no portable URI exists at all, so the fetch
 *    fails with `user-id-unavailable` rather than linking entries to URIs
 *    nobody — including the user after a future login — can resolve.
 *
 *  No `vscode` import: the transport is a `fetch`-shaped parameter, injected
 *  by tests and defaulted for the extension.  (Stage-4 note: the default
 *  targets the extension host's localhost, which is only the user's desktop
 *  when the extension runs locally — the command must not offer this feature
 *  in remote workspaces.) */

import { formatZoteroItemUri, ZOTERO_ITEM_KEY_RE, type ZoteroCatalogItem } from './zotero-link';

/** Where Zotero 9 serves its Local API.  Fixed by Zotero, not configurable
 *  in its settings UI. */
const ZOTERO_LOCAL_API_BASE = 'http://localhost:23119/api';

/** Only one API version is served locally; pinning it turns a future default
 *  change into an explicit error instead of silently reshaped JSON. */
const ZOTERO_API_VERSION = '3';

/** Deadline for the group listing — a few rows, answered in milliseconds. */
const LIST_TIMEOUT_MS = 5000;

/** Deadline for the one whole-catalog request, body included.  Measured
 *  2.3s for a 17k-item group; the headroom is for cold caches and slower
 *  machines, not for retries. */
const CATALOG_TIMEOUT_MS = 60000;

export type ZoteroLocalApiErrorKind =
  /** Nothing is listening — Zotero is not running. */
  | 'not-running'
  /** Zotero answered 403: the "Allow other applications on this computer to
   *  communicate with Zotero" setting (Settings → Advanced → Miscellaneous)
   *  is off. */
  | 'api-disabled'
  /** A request exceeded its deadline. */
  | 'timeout'
  /** The caller's own abort signal fired — the user cancelled.  Never worth
   *  showing: the user knows what they did. */
  | 'cancelled'
  /** The personal library's real id is unknown — the user has never logged
   *  in — so no portable URI can be built for its items. */
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

/** Which library to fetch.  The personal library needs no id: its request
 *  address is the `/users/0/` placeholder, and the identity its URIs carry is
 *  resolved from the rows it returns. */
export type ZoteroLibraryScope =
  | { readonly type: 'user' }
  | { readonly type: 'group'; readonly groupId: number };

/** One group the running Zotero can serve, as data — ordering, labels and
 *  the personal-library entry are the picker's business, not the adapter's. */
export interface ZoteroGroupSummary {
  readonly groupId: number;
  readonly name: string;
  /** As reported by Zotero.  Counts attachments and notes too, so it is an
   *  upper bound on linkable items — display it, don't reason from it. */
  readonly itemCount: number;
}

/** The transport this adapter needs: the WHATWG `fetch` shape, injectable so
 *  tests can serve canned responses and the extension can pass the global. */
export type ZoteroFetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export interface ZoteroLocalApiOptions {
  readonly fetchFn?: ZoteroFetch;
  /** Caller-side cancellation (a progress dialog's Cancel button).  Aborting
   *  it aborts the in-flight request, not just the wait for it. */
  readonly signal?: AbortSignal;
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');

/** One GET against the Local API, returning its body as a JSON array — both
 *  endpoints this adapter uses list arrays, so anything else is a protocol
 *  surprise worth failing loudly on.  The deadline covers reading the body,
 *  not just the headers: a response that stalls mid-body is as hung as one
 *  that never came. */
async function requestArray(
  path: string,
  timeoutMs: number,
  options: ZoteroLocalApiOptions,
): Promise<unknown[]> {
  const fetchFn: ZoteroFetch = options.fetchFn ?? fetch;
  const deadline = AbortSignal.timeout(timeoutMs);
  const init = {
    signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
    headers: { 'Zotero-API-Version': ZOTERO_API_VERSION },
  };
  const aborted = (): ZoteroLocalApiError =>
    options.signal?.aborted
      ? new ZoteroLocalApiError('cancelled', 'The user cancelled the request.')
      : new ZoteroLocalApiError('timeout', 'Zotero did not answer within ' + timeoutMs + 'ms.');
  let response: Awaited<ReturnType<ZoteroFetch>>;
  try {
    response = await fetchFn(ZOTERO_LOCAL_API_BASE + path, init);
  } catch (error) {
    if (isAbort(error)) {
      throw aborted();
    }
    // fetch rejects network-level failures as TypeError; on localhost that
    // means nothing is listening.  Anything else — a caller-injected
    // transport blowing up, a RangeError from bad arguments — is not
    // evidence about Zotero and must not tell the user to start it.
    if (error instanceof TypeError) {
      throw new ZoteroLocalApiError('not-running', 'Could not connect to Zotero on localhost:23119.');
    }
    throw new ZoteroLocalApiError('request-failed', 'Request to Zotero failed: ' + String(error));
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
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbort(error)) {
      throw aborted();
    }
    throw new ZoteroLocalApiError('request-failed', 'Zotero returned unreadable JSON for ' + path + '.');
  }
  if (!Array.isArray(body)) {
    throw new ZoteroLocalApiError('request-failed', 'Zotero returned a non-list response for ' + path + '.');
  }
  return body;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** A server-assigned library id: a positive integer.  `0`, negatives and
 *  fractions name no library, and interpolating one into a request path or a
 *  URI would address something that does not exist. */
const asLibraryId = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;

/** The groups the running Zotero can serve, in server order. */
export async function listZoteroGroups(
  options: ZoteroLocalApiOptions = {},
): Promise<ZoteroGroupSummary[]> {
  const rows = await requestArray('/users/0/groups', LIST_TIMEOUT_MS, options);
  const groups: ZoteroGroupSummary[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    const groupId = asLibraryId(record?.id);
    const name = asString(asRecord(record?.data)?.name);
    if (groupId === undefined || name === undefined) continue;
    const numItems = asRecord(record?.meta)?.numItems;
    groups.push({ groupId, name, itemCount: typeof numItems === 'number' ? numItems : 0 });
  }
  return groups;
}

/** Item types that carry no bibliography identity of their own.  `/items/top`
 *  already excludes children, but standalone attachments and notes are
 *  top-level items. */
const NON_BIBLIOGRAPHIC_TYPES: ReadonlySet<string> = new Set([
  'attachment',
  'note',
  'annotation',
]);

/** The fields of one item row, reduced to exactly what the catalog carries —
 *  the full row (creators, tags, relations) is dropped here, before the whole
 *  result is held at once.  Returns undefined for rows the matcher must never
 *  see: non-bibliographic or malformed.  A key that is not 8 uppercase
 *  alphanumerics is malformed by definition — everything written into a
 *  document is validated against that same pattern, so admitting it here
 *  would put an unwritable item in the catalog. */
function readItemRow(row: unknown): {
  key: string;
  userLibraryId: number | undefined;
  title: string | undefined;
  citationKey: string | undefined;
  doi: string | undefined;
  isbn: string | undefined;
  extra: string | undefined;
} | undefined {
  const record = asRecord(row);
  const data = asRecord(record?.data);
  if (data === undefined) return undefined;
  const key = asString(data.key);
  if (key === undefined || !ZOTERO_ITEM_KEY_RE.test(key)) return undefined;
  const itemType = asString(data.itemType);
  if (itemType === undefined || NON_BIBLIOGRAPHIC_TYPES.has(itemType)) return undefined;
  const library = asRecord(record?.library);
  const userLibraryId = library?.type === 'user' ? asLibraryId(library.id) : undefined;
  return {
    key,
    userLibraryId,
    title: asString(data.title),
    citationKey: asString(data.citationKey),
    doi: asString(data.DOI),
    isbn: asString(data.ISBN),
    extra: asString(data.extra),
  };
}

/** Every bibliographic item in one library, in matcher-ready form.
 *
 *  For a group, every URI is built from the selected group id — the request
 *  URL is the authority, and a row's own `library` envelope, present or
 *  garbled, cannot redirect an item into a different library.  For the
 *  personal library the real user id is resolved once across the rows. */
export async function fetchZoteroCatalog(
  scope: ZoteroLibraryScope,
  options: ZoteroLocalApiOptions = {},
): Promise<ZoteroCatalogItem[]> {
  const path =
    scope.type === 'user' ? '/users/0/items/top' : '/groups/' + scope.groupId + '/items/top';
  const rows = await requestArray(path, CATALOG_TIMEOUT_MS, options);

  const read = [];
  for (const row of rows) {
    const item = readItemRow(row);
    if (item) read.push(item);
  }

  let libraryType: 'user' | 'group';
  let libraryId: number;
  if (scope.type === 'group') {
    libraryType = 'group';
    libraryId = scope.groupId;
  } else {
    // The rows all belong to one library, so they must agree on its id.
    // None carrying one means the user has never logged in: Zotero has no
    // portable identity for these items, and neither can this command.
    const ids = new Set<number>();
    for (const item of read) {
      if (item.userLibraryId !== undefined) ids.add(item.userLibraryId);
    }
    if (ids.size > 1) {
      throw new ZoteroLocalApiError(
        'request-failed',
        'Zotero reported conflicting ids for the personal library.',
      );
    }
    const id = ids.values().next().value;
    if (read.length > 0 && id === undefined) {
      throw new ZoteroLocalApiError(
        'user-id-unavailable',
        'Zotero reported no account id for the personal library; ' +
          'its items have no identity other applications can resolve.',
      );
    }
    libraryType = 'user';
    libraryId = id ?? 0; // unused: with no rows there is nothing to format
  }

  return read.map(({ key, title, citationKey, doi, isbn, extra }) => ({
    key,
    uri: formatZoteroItemUri(libraryType, libraryId, key),
    title,
    citationKey,
    doi,
    isbn,
    extra,
  }));
}
