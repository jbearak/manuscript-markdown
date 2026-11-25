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
  /** The caller's own abort signal fired, rather than this adapter's
   *  deadline.  What that means — usually a pressed Cancel button — is the
   *  caller's knowledge, not this adapter's. */
  | 'aborted'
  /** The personal library's real id is unknown — the user has never logged
   *  in — so no portable URI can be built for its items. */
  | 'user-id-unavailable'
  /** A write was refused for want of a valid local API key: none was sent,
   *  or Zotero no longer knows it (revoked, or a one-time key already
   *  spent).  Authorize again. */
  | 'unauthorized'
  /** The user pressed Deny in Zotero's authorization dialog. */
  | 'authorization-denied'
  /** Zotero answered 403 to a write: the library is read-only to this user,
   *  as a group library they may only view. */
  | 'write-denied'
  /** Zotero refused a write's precondition (412): the library changed after
   *  it was read, or another Zotero instance is answering. */
  | 'library-changed'
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
  init?: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    /** Absent means GET.  Only push writes. */
    method?: string;
    body?: string;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  /** Response headers.  Optional so read-only test transports need not
   *  fake them; the writes need `Zotero-Server-ID` and
   *  `Last-Modified-Version`. */
  readonly headers?: { get(name: string): string | null };
  text?(): Promise<string>;
}>;

export interface ZoteroLocalApiOptions {
  readonly fetchFn?: ZoteroFetch;
  /** Caller-side cancellation (a progress dialog's Cancel button).  Aborting
   *  it aborts the in-flight request, not just the wait for it. */
  readonly signal?: AbortSignal;
}


/** What a write adds to a request, and how its refusals read. */
interface WriteRequest {
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: string;
  /** The error for a status the caller gives meaning to, as 401 for a
   *  write; undefined leaves the status to the generic handling. */
  readonly statusError?: (status: number, text: string) => ZoteroLocalApiError | undefined;
}

type ResponseHeaders = NonNullable<Awaited<ReturnType<ZoteroFetch>>['headers']>;

/** One request against the Local API, returning its JSON body and headers.
 *  The deadline covers reading the body, not just the headers: a response
 *  that stalls mid-body is as hung as one that never came. */
async function requestJson(
  path: string,
  timeoutMs: number,
  options: ZoteroLocalApiOptions,
  write?: WriteRequest,
): Promise<{ body: unknown; headers: ResponseHeaders | undefined }> {
  const fetchFn: ZoteroFetch = options.fetchFn ?? fetch;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const init = {
    signal,
    headers: { 'Zotero-API-Version': ZOTERO_API_VERSION, ...write?.headers },
    ...(write ? { method: write.method, body: write.body } : {}),
  };
  // Fetch can reject a response-body read with generic AbortError even when a
  // timeout caused it.  AbortSignal.any retains the first signal's reason, so
  // that reason — not a later snapshot where both signals may be aborted —
  // distinguishes the deadline from the caller's Cancel button.
  const abortError = (error: unknown): ZoteroLocalApiError | undefined => {
    const name = error instanceof DOMException ? error.name : undefined;
    const abortLike = error === signal.reason || name === 'AbortError' || name === 'TimeoutError';
    if (!abortLike) return undefined;
    if (signal.aborted && deadline.aborted && signal.reason === deadline.reason) {
      return new ZoteroLocalApiError('timeout', 'Zotero did not answer within ' + timeoutMs + 'ms.');
    }
    if (
      signal.aborted &&
      options.signal?.aborted === true &&
      signal.reason === options.signal.reason
    ) {
      return new ZoteroLocalApiError('aborted', 'The caller aborted the request.');
    }
    // Injected transports may throw TimeoutError directly without aborting the
    // supplied signal; preserve that fetch-compatible testing seam.
    if (name === 'TimeoutError') {
      return new ZoteroLocalApiError('timeout', 'Zotero did not answer within ' + timeoutMs + 'ms.');
    }
    return undefined;
  };
  let response: Awaited<ReturnType<ZoteroFetch>>;
  try {
    response = await fetchFn(ZOTERO_LOCAL_API_BASE + path, init);
  } catch (error) {
    const abort = abortError(error);
    if (abort) throw abort;
    // fetch rejects network-level failures as TypeError; on localhost that
    // means nothing is listening.  Anything else — a caller-injected
    // transport blowing up, a RangeError from bad arguments — is not
    // evidence about Zotero and must not tell the user to start it.
    if (error instanceof TypeError) {
      throw new ZoteroLocalApiError('not-running', 'Could not connect to Zotero on localhost:23119.');
    }
    throw new ZoteroLocalApiError('request-failed', 'Request to Zotero failed: ' + String(error));
  }
  if (write !== undefined && !response.ok) {
    let text = '';
    try {
      text = (await response.text?.()) ?? '';
    } catch {
      // The status alone still says what happened.
    }
    // Zotero answers 403 before anything else when the "Allow other
    // applications" setting is off, which the caller's 403 doesn't mean.
    if (response.status === 403 && /not enabled/i.test(text)) {
      throw new ZoteroLocalApiError('api-disabled', 'Zotero is running but its local API is turned off.');
    }
    const error = write.statusError?.(response.status, text);
    if (error) throw error;
    throw new ZoteroLocalApiError(
      'request-failed',
      'Zotero answered HTTP ' + response.status + ' for ' + path + (text ? ': ' + text : '.'),
    );
  }
  // To a read, 403 is the "Allow other applications" setting being off.
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
    const abort = abortError(error);
    if (abort) throw abort;
    throw new ZoteroLocalApiError('request-failed', 'Zotero returned unreadable JSON for ' + path + '.');
  }
  return { body, headers: response.headers };
}

/** One GET against the Local API, returning its body as a JSON array — the
 *  list endpoints this adapter reads list arrays, so anything else is a
 *  protocol surprise worth failing loudly on. */
async function requestArray(
  path: string,
  timeoutMs: number,
  options: ZoteroLocalApiOptions,
): Promise<unknown[]> {
  return (await requestArrayWithHeaders(path, timeoutMs, options)).rows;
}

async function requestArrayWithHeaders(
  path: string,
  timeoutMs: number,
  options: ZoteroLocalApiOptions,
): Promise<{ rows: unknown[]; headers: ResponseHeaders | undefined }> {
  const { body, headers } = await requestJson(path, timeoutMs, options);
  if (!Array.isArray(body)) {
    throw new ZoteroLocalApiError('request-failed', 'Zotero returned a non-list response for ' + path + '.');
  }
  return { rows: body, headers };
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

/** Zotero's primary creator role by item type.  Its BibTeX translator writes
 *  this role as `author`; accepting every author-like role globally would pick
 *  secondary creators (for example a book contributor). */
const PRIMARY_CREATOR_BY_ITEM_TYPE: Readonly<Record<string, string>> = {
  artwork: 'artist',
  audioRecording: 'performer',
  bill: 'sponsor',
  blogPost: 'author',
  book: 'author',
  bookSection: 'author',
  case: 'author',
  computerProgram: 'programmer',
  conferencePaper: 'author',
  dataset: 'author',
  dictionaryEntry: 'author',
  document: 'author',
  email: 'author',
  encyclopediaArticle: 'author',
  film: 'director',
  forumPost: 'author',
  hearing: 'contributor',
  instantMessage: 'author',
  interview: 'interviewee',
  journalArticle: 'author',
  letter: 'author',
  magazineArticle: 'author',
  manuscript: 'author',
  map: 'cartographer',
  newspaperArticle: 'author',
  patent: 'inventor',
  podcast: 'podcaster',
  preprint: 'author',
  presentation: 'presenter',
  radioBroadcast: 'creator',
  report: 'author',
  standard: 'author',
  statute: 'author',
  thesis: 'author',
  tvBroadcast: 'director',
  videoRecording: 'creator',
  webpage: 'author',
};

/** First primary Zotero creator as the metadata fallback compares it: family
 *  name for a personal creator, whole name for a single-field organization. */
function firstPrimaryCreator(
  data: Record<string, unknown>,
  itemType: string,
): string | undefined {
  if (!Array.isArray(data.creators)) return undefined;
  const primaryRole = PRIMARY_CREATOR_BY_ITEM_TYPE[itemType];
  if (primaryRole === undefined) return undefined;
  for (const value of data.creators) {
    const creator = asRecord(value);
    if (creator?.creatorType !== primaryRole) continue;
    return asString(creator.name) ?? asString(creator.lastName);
  }
  return undefined;
}

/** The fields of one item row, reduced to exactly what the catalog carries —
 *  the full row (all creators, tags, relations) is dropped here, before the
 *  whole result is held at once.  Returns undefined for rows the matcher must
 *  never see: non-bibliographic or malformed.  A key that is not 8 uppercase
 *  alphanumerics is malformed by definition — everything written into a
 *  document is validated against that same pattern, so admitting it here
 *  would put an unwritable item in the catalog. */
function readItemRow(row: unknown): {
  key: string;
  userLibraryId: number | undefined;
  title: string | undefined;
  author: string | undefined;
  containerTitle: string | undefined;
  year: string | undefined;
  citationKey: string | undefined;
  doi: string | undefined;
  isbn: string | undefined;
  url: string | undefined;
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
  const meta = asRecord(record?.meta);
  const userLibraryId = library?.type === 'user' ? asLibraryId(library.id) : undefined;
  return {
    key,
    userLibraryId,
    title:
      asString(data.title) ??
      asString(data.caseName) ??
      asString(data.subject) ??
      asString(data.nameOfAct),
    author: firstPrimaryCreator(data, itemType),
    containerTitle:
      asString(data.publicationTitle) ??
      asString(data.blogTitle) ??
      asString(data.bookTitle) ??
      asString(data.proceedingsTitle) ??
      asString(data.dictionaryTitle) ??
      asString(data.encyclopediaTitle) ??
      asString(data.forumTitle) ??
      asString(data.sessionTitle) ??
      asString(data.programTitle) ??
      asString(data.websiteTitle),
    year:
      asString(meta?.parsedDate) ??
      asString(data.date) ??
      asString(data.dateDecided) ??
      asString(data.issueDate) ??
      asString(data.dateEnacted),
    citationKey: asString(data.citationKey),
    doi: asString(data.DOI),
    isbn: asString(data.ISBN),
    url: asString(data.url),
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
  return catalogFromRows(scope, await requestArray(libraryPrefix(scope) + '/items/top', CATALOG_TIMEOUT_MS, options));
}

/** The request prefix for a library: `/users/0` ("whoever is logged in") or
 *  the group's. */
function libraryPrefix(scope: ZoteroLibraryScope): string {
  return scope.type === 'user' ? '/users/0' : '/groups/' + scope.groupId;
}

/** The catalog from the rows of `/items/top`. */
function catalogFromRows(scope: ZoteroLibraryScope, rows: readonly unknown[]): ZoteroCatalogItem[] {
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

  return read.map(({
    key,
    title,
    author,
    containerTitle,
    year,
    citationKey,
    doi,
    isbn,
    url,
    extra,
  }) => ({
    key,
    uri: formatZoteroItemUri(libraryType, libraryId, key),
    title,
    author,
    containerTitle,
    year,
    citationKey,
    doi,
    isbn,
    url,
    extra,
  }));
}

/** How many item keys ride in one `itemKey=` batch.  The parameter is a
 *  comma-joined list in the query string; 50 keys is ~450 bytes of URL,
 *  comfortably under every parser's limits, and each response arrives in
 *  milliseconds. */
const BIBTEX_BATCH_SIZE = 50;

/** The BibTeX exports for the given item keys, keyed by item key.
 *
 *  Fetched in batches via `?itemKey=…&include=bibtex` rather than riding on
 *  the catalog request: asking the translator to render an entire library
 *  multiplies the catalog's response ~40x (measured 42MB and 33s for 17k
 *  items), while a matched bibliography is at most a few hundred keys.
 *  Batches run sequentially — the server reruns its search per request, and
 *  hammering it in parallel starves the Zotero UI.
 *
 *  A returned row proves the item exists even when its export is empty, so
 *  present keys map to the export or `''`.  A requested key omitted from the
 *  response is absent from the result.  The distinction lets the sync planner
 *  report an unusable export separately from a missing item. */
export async function fetchZoteroBibtex(
  scope: ZoteroLibraryScope,
  keys: readonly string[],
  options: ZoteroLocalApiOptions = {},
): Promise<Map<string, string>> {
  const prefix = scope.type === 'user' ? '/users/0' : '/groups/' + scope.groupId;
  const result = new Map<string, string>();
  for (let i = 0; i < keys.length; i += BIBTEX_BATCH_SIZE) {
    const batch = keys.slice(i, i + BIBTEX_BATCH_SIZE);
    const rows = await requestArray(
      prefix + '/items?itemKey=' + batch.join(',') + '&include=bibtex',
      CATALOG_TIMEOUT_MS,
      options,
    );
    for (const row of rows) {
      const record = asRecord(row);
      const key = asString(record?.key);
      // A row with empty or missing bibtex still proves the item exists —
      // presence in this map means "Zotero has the item", and the empty
      // string downgrades to metadata-not-checked downstream.  Absence from
      // the map is the signal that Zotero no longer has the key at all.
      if (key !== undefined) {
        result.set(key, asString(record?.bibtex) ?? '');
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Push: collections, the library snapshot, the schema, authorization, writes
// ---------------------------------------------------------------------------
//
// Measured against Zotero 10.0.9, whose Local API takes writes:
//
// - A write needs a local API key (header Zotero-API-Key), which only a
//   person can grant: POST /api/local/authorize shows a dialog in Zotero with
//   Allow (a key good for one write request), Always Allow (a lasting key)
//   and Deny.  Zotero spends a one-time key when it checks it, so even a
//   write that then fails uses it up.
// - A write must name the Zotero instance it was planned against
//   (Zotero-Server-ID, from any response); another instance answers 412.
// - POST /items takes at most 50 objects.  A keyed object is merged into the
//   item, after Zotero checks its `version` against the item's; an object
//   without a key is created.  Each object's outcome is reported by its
//   index, so one failing object does not fail the request.
// - If-Unmodified-Since-Version on the request fails the whole batch with
//   412 when anything in the library changed since that version.  Zotero
//   checks it once, before saving the batch's objects one by one, so it
//   catches a change made between plan and write, not one made while the
//   batch is being saved.

/** One collection, with its place in the tree spelled out. */
export interface ZoteroCollectionSummary {
  readonly key: string;
  readonly name: string;
  /** Names from the top-level collection down, joined with " / ". */
  readonly path: string;
  readonly itemCount: number;
}

/** Every collection in the library, sorted by path. */
export async function listZoteroCollections(
  scope: ZoteroLibraryScope,
  options: ZoteroLocalApiOptions = {},
): Promise<ZoteroCollectionSummary[]> {
  const rows = await requestArray(libraryPrefix(scope) + '/collections', LIST_TIMEOUT_MS, options);
  const byKey = new Map<string, { name: string; parent: string | undefined; itemCount: number }>();
  for (const row of rows) {
    const record = asRecord(row);
    const data = asRecord(record?.data);
    const key = asString(data?.key);
    const name = asString(data?.name);
    if (key === undefined || name === undefined) continue;
    const numItems = asRecord(record?.meta)?.numItems;
    byKey.set(key, {
      name,
      parent: asString(data?.parentCollection),
      itemCount: typeof numItems === 'number' ? numItems : 0,
    });
  }
  const pathOf = (key: string, seen = new Set<string>()): string => {
    const c = byKey.get(key)!;
    if (c.parent === undefined || !byKey.has(c.parent) || seen.has(key)) return c.name;
    seen.add(key);
    return pathOf(c.parent, seen) + ' / ' + c.name;
  };
  return [...byKey.entries()]
    .map(([key, c]) => ({ key, name: c.name, path: pathOf(key), itemCount: c.itemCount }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The whole library as push reads it, from one request: the matcher's
 *  catalog, each item's full JSON, the library's version, and which Zotero
 *  answered. */
export interface ZoteroLibrarySnapshot {
  readonly catalog: ZoteroCatalogItem[];
  readonly items: Map<string, import('./zotero-push').ZoteroItemJson>;
  readonly libraryVersion: number;
  readonly serverId: string;
}

export async function fetchZoteroLibrarySnapshot(
  scope: ZoteroLibraryScope,
  options: ZoteroLocalApiOptions = {},
): Promise<ZoteroLibrarySnapshot> {
  // The version is read before the items, by a request of its own: Zotero
  // reads a response's version after building its rows, so a write landing
  // between the two would be in the version but not the rows, and the
  // version check would then let a create duplicate it.
  const { headers } = await requestArrayWithHeaders(libraryPrefix(scope) + '/items/top?limit=1', LIST_TIMEOUT_MS, options);
  const libraryVersion = readVersion(headers);
  const serverId = headers?.get('Zotero-Server-ID') ?? '';
  const { rows, headers: rowHeaders } = await requestArrayWithHeaders(libraryPrefix(scope) + '/items/top', CATALOG_TIMEOUT_MS, options);
  if (libraryVersion === undefined || serverId === '') {
    throw new ZoteroLocalApiError(
      'request-failed',
      'Zotero did not report its library version and server id; writing needs Zotero 10 or later.',
    );
  }
  // Both reads must come from one Zotero: a profile switched between them
  // would pair one library's version with another's items, and the version
  // check would then pass a write planned against the wrong library.
  if (rowHeaders?.get('Zotero-Server-ID') !== serverId) {
    throw new ZoteroLocalApiError('library-changed', 'A different Zotero answered while the library was being read.');
  }
  // Only the catalog's items, the bibliographic ones, with the identity
  // URI the catalog gives each, so a stored link to another library's item
  // with the same key is told apart.
  const catalog = catalogFromRows(scope, rows);
  const uris = new Map(catalog.map(c => [c.key, c.uri]));
  const items = new Map<string, import('./zotero-push').ZoteroItemJson>();
  for (const row of rows) {
    const record = asRecord(row);
    const data = asRecord(record?.data);
    const key = asString(data?.key);
    const itemType = asString(data?.itemType);
    if (data === undefined || key === undefined || itemType === undefined) continue;
    if (typeof data.version !== 'number' || !uris.has(key)) continue;
    const parsedDate = asString(asRecord(record?.meta)?.parsedDate);
    items.set(key, { ...data, key, itemType, version: data.version, parsedDate, uri: uris.get(key) });
  }
  // Zotero 10 has a PMID field, where the matcher reads PMIDs from Extra
  // only; give it both, for push alone.
  const pushCatalog = catalog.map(c => {
    const pmid = asString(items.get(c.key)?.PMID);
    // First, so the matcher, which takes the first PMID line, reads the
    // field over a stale line of Extra.
    return pmid === undefined ? c : { ...c, extra: 'PMID: ' + pmid + (c.extra ? '\n' + c.extra : '') };
  });
  return { catalog: pushCatalog, items, libraryVersion, serverId };
}

/** Zotero's item types, their fields and their creator roles. */
export async function fetchZoteroSchema(
  options: ZoteroLocalApiOptions = {},
): Promise<import('./zotero-push').ZoteroItemSchema> {
  const { body } = await requestJson('/schema', LIST_TIMEOUT_MS, options);
  // The planner reads every type (their names find `Type:` lines in Extra)
  // and the CSL mappings, so one malformed part makes the schema unreadable
  // rather than quietly smaller.
  const unreadable = () => new ZoteroLocalApiError('request-failed', 'Zotero returned an unreadable schema.');
  const isString = (v: unknown) => typeof v === 'string';
  const isStringList = (v: unknown) => Array.isArray(v) && v.every(isString);
  const isFieldList = (v: unknown) =>
    Array.isArray(v) &&
    v.every(f => isString(asRecord(f)?.field) && (asRecord(f)?.baseField === undefined || isString(asRecord(f)?.baseField)));
  const isRoleList = (v: unknown) => Array.isArray(v) && v.every(c => isString(asRecord(c)?.creatorType));
  const isMap = (v: unknown, valueOk: (x: unknown) => boolean) =>
    v === undefined || (asRecord(v) !== undefined && Object.values(asRecord(v)!).every(valueOk));
  const itemTypes = asRecord(body)?.itemTypes;
  if (
    !Array.isArray(itemTypes) ||
    itemTypes.length === 0 ||
    !itemTypes.every(t => isString(asRecord(t)?.itemType) && isFieldList(asRecord(t)?.fields) && isRoleList(asRecord(t)?.creatorTypes))
  ) {
    throw unreadable();
  }
  const csl = asRecord(body)?.csl;
  const cslRecord = asRecord(csl);
  const cslFields = asRecord(cslRecord?.fields);
  if (
    csl !== undefined &&
    (cslRecord === undefined ||
      !isMap(cslRecord.types, isStringList) ||
      !isMap(cslRecord.names, isString) ||
      (cslRecord.fields !== undefined &&
        (cslFields === undefined || !isMap(cslFields.text, isStringList) || !isMap(cslFields.date, isString))))
  ) {
    throw unreadable();
  }
  return {
    itemTypes: itemTypes as import('./zotero-push').ZoteroItemSchema['itemTypes'],
    csl: cslRecord as import('./zotero-push').ZoteroItemSchema['csl'],
  };
}

/** How long Zotero's authorization dialog may wait for a person. */
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;

/** Ask Zotero for a key to write with.  Zotero shows a dialog and this waits
 *  for the person at it.  `remember` is false for Allow: the key is then good
 *  for one write request. */
export async function authorizeZoteroLocalApi(
  appName: string,
  /** The Zotero the key is for, which Zotero requires on every POST. */
  serverId: string,
  options: ZoteroLocalApiOptions = {},
): Promise<{ key: string; remember: boolean }> {
  const { body } = await requestJson('/local/authorize', AUTHORIZE_TIMEOUT_MS, options, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': serverId },
    body: JSON.stringify({ appName }),
    statusError: status =>
      status === 403
        ? new ZoteroLocalApiError('authorization-denied', 'Zotero denied access.')
        : status === 404
          ? new ZoteroLocalApiError('request-failed', 'This Zotero cannot grant write access; writing needs Zotero 10 or later.')
          : status === 412
            ? new ZoteroLocalApiError('library-changed', 'A different Zotero is answering than the one this command read.')
          : status === 429
            ? new ZoteroLocalApiError('request-failed', 'Zotero is refusing further authorization requests for now. Wait a minute and try again.')
            : undefined,
  });
  const record = asRecord(body);
  const key = asString(record?.key);
  if (key === undefined) {
    throw new ZoteroLocalApiError('request-failed', 'Zotero returned no key.');
  }
  return { key, remember: record?.remember === true };
}

/** One object's outcome in a write, by its index in the request. */
export type ZoteroWriteOutcome =
  | { readonly status: 'success'; readonly key: string; readonly version: number }
  | { readonly status: 'unchanged'; readonly key: string }
  | { readonly status: 'failed'; readonly key?: string; readonly code: number; readonly message: string };

/** Up to 50 item objects in one request.  Throws only when the request as a
 *  whole was refused; each object's own outcome is in the result. */
export async function writeZoteroItems(
  scope: ZoteroLibraryScope,
  objects: ReadonlyArray<Record<string, unknown>>,
  auth: {
    readonly apiKey: string;
    readonly serverId: string;
    /** The library version the plan was made at, or the last write's. */
    readonly libraryVersion: number;
    readonly writeToken: string;
  },
  options: ZoteroLocalApiOptions = {},
): Promise<{ outcomes: ZoteroWriteOutcome[]; libraryVersion: number | undefined }> {
  if (objects.length === 0 || objects.length > 50) {
    throw new RangeError('A write takes 1 to 50 objects, not ' + objects.length);
  }
  const { body, headers } = await requestJson(libraryPrefix(scope) + '/items', CATALOG_TIMEOUT_MS, options, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Zotero-API-Key': auth.apiKey,
      'Zotero-Server-ID': auth.serverId,
      'If-Unmodified-Since-Version': String(auth.libraryVersion),
      'Zotero-Write-Token': auth.writeToken,
    },
    body: JSON.stringify(objects),
    statusError: (status, text) =>
      status === 401
        ? new ZoteroLocalApiError('unauthorized', 'Zotero refused the key: ' + (text || 'unauthorized') + '.')
        : status === 403
          ? new ZoteroLocalApiError('write-denied', 'Zotero refused to write to this library: ' + (text || 'write access denied') + '.')
          : status === 412
            ? new ZoteroLocalApiError('library-changed', text || 'The library changed since it was read.')
            : undefined,
  });
  const results = asRecord(body);
  const outcomes: ZoteroWriteOutcome[] = objects.map(() => ({
    status: 'failed',
    code: 0,
    message: 'Zotero reported no outcome for this object.',
  }));
  for (const [index, value] of Object.entries(asRecord(results?.successful) ?? {})) {
    const record = asRecord(value);
    const key = asString(record?.key);
    const version = record?.version;
    if (key !== undefined && typeof version === 'number' && outcomes[Number(index)] !== undefined) {
      outcomes[Number(index)] = { status: 'success', key, version };
    }
  }
  for (const [index, value] of Object.entries(asRecord(results?.unchanged) ?? {})) {
    if (typeof value === 'string' && outcomes[Number(index)] !== undefined) {
      outcomes[Number(index)] = { status: 'unchanged', key: value };
    }
  }
  for (const [index, value] of Object.entries(asRecord(results?.failed) ?? {})) {
    const record = asRecord(value);
    if (outcomes[Number(index)] !== undefined) {
      outcomes[Number(index)] = {
        status: 'failed',
        key: asString(record?.key),
        code: typeof record?.code === 'number' ? record.code : 0,
        message: asString(record?.message) ?? 'failed',
      };
    }
  }
  return { outcomes, libraryVersion: readVersion(headers) };
}

/** A response's Last-Modified-Version, or undefined when it has none: a
 *  missing header is not version 0. */
function readVersion(headers: ResponseHeaders | undefined): number | undefined {
  const raw = headers?.get('Last-Modified-Version')?.trim();
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** The items changed in the library since a version, each with its
 *  version now (undefined where the row doesn't say). */
export async function fetchZoteroItemVersionsSince(
  scope: ZoteroLibraryScope,
  since: number,
  options: ZoteroLocalApiOptions = {},
): Promise<Map<string, number | undefined>> {
  const rows = await requestArray(libraryPrefix(scope) + '/items?since=' + since + '&includeTrashed=1', CATALOG_TIMEOUT_MS, options);
  const versions = new Map<string, number | undefined>();
  for (const row of rows) {
    const record = asRecord(row);
    const key = asString(record?.key) ?? asString(asRecord(record?.data)?.key);
    const version = record?.version ?? asRecord(record?.data)?.version;
    // Since 0, Zotero lists every item, and one never saved since its
    // migration is at 0: unchanged, not another writer's.
    if (since === 0 && version === 0) continue;
    if (key !== undefined) versions.set(key, typeof version === 'number' ? version : undefined);
  }
  return versions;
}

/** Which Zotero is answering: the Zotero-Server-ID every response carries,
 *  which a write key is filed under. */
export async function fetchZoteroServerId(options: ZoteroLocalApiOptions = {}): Promise<string> {
  const { headers } = await requestJson('/users/0/groups', LIST_TIMEOUT_MS, options);
  const serverId = headers?.get('Zotero-Server-ID');
  if (!serverId) {
    throw new ZoteroLocalApiError('request-failed', 'Zotero did not say which instance it is; writing needs Zotero 10 or later.');
  }
  return serverId;
}
