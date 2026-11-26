/** Running "Push Bibliography to Zotero": reading what the plan needs,
 *  writing it, and the report.  Shared by the extension and the CLI, so the
 *  two can't drift.  No vscode import: the key store and the transport come
 *  from the caller. */

import { createZoteroLinkPlan } from './zotero-link';
import {
  fetchZoteroItemVersionsSince,
  fetchZoteroLibrarySnapshot,
  fetchZoteroSchema,
  writeZoteroItems,
  ZoteroLocalApiError,
  type ZoteroCollectionSummary,
  type ZoteroLibraryScope,
  type ZoteroLocalApiOptions,
  type ZoteroWriteOutcome,
} from './zotero-local-api';
import {
  createZoteroPushPlan,
  zoteroPushWrites,
  type ZoteroFieldNotPushedReason,
  type ZoteroPushMode,
  type ZoteroPushPlan,
  type ZoteroPushSkipReason,
} from './zotero-push';

/** The name Zotero's authorization dialog shows. */
export const ZOTERO_APP_NAME = 'Manuscript Markdown';

/** The plan, with what writing it needs from the read it was made from. */
export interface ZoteroPushPrepared {
  readonly plan: ZoteroPushPlan;
  readonly serverId: string;
  readonly libraryVersion: number;
}

/** Read the library and plan the push.  Undefined when the bibliography
 *  can't be parsed safely. */
export async function prepareZoteroPush(
  scope: ZoteroLibraryScope,
  bibText: string,
  /** The collection, as listed (whose Zotero the library must be read
   *  from), or its key. */
  collection: string | ZoteroCollectionSummary,
  mode: ZoteroPushMode,
  options: ZoteroLocalApiOptions = {},
): Promise<ZoteroPushPrepared | undefined> {
  const snapshot = await fetchZoteroLibrarySnapshot(scope, options);
  // A collection key names a collection in one Zotero: a profile switched
  // since it was chosen would put the items in another's.
  const collectionKey = typeof collection === 'string' ? collection : collection.key;
  if (typeof collection !== 'string' && collection.serverId !== undefined && collection.serverId !== snapshot.serverId) {
    throw new ZoteroLocalApiError('library-changed', 'A different Zotero is answering than the one the collection was chosen from.');
  }
  const schema = await fetchZoteroSchema(options);
  const link = createZoteroLinkPlan(bibText, snapshot.catalog);
  if (link.blocked !== undefined) return undefined;
  const plan = createZoteroPushPlan({
    bibText,
    decisions: link.decisions,
    items: snapshot.items,
    schema,
    collectionKey,
    mode,
    keySalt: snapshot.serverId + '\n' + (scope.type === 'user' ? 'user' : 'group ' + scope.groupId),
    takenKeys: snapshot.takenKeys,
  });
  return { plan, serverId: snapshot.serverId, libraryVersion: snapshot.libraryVersion };
}

/** Where write keys come from.  `get` may ask Zotero for one, which shows a
 *  dialog; `invalidate` drops a key Zotero refused, so the next `get` asks
 *  again. */
export interface ZoteroKeyProvider {
  get(): Promise<string>;
  invalidate(): Promise<void>;
}

export interface ZoteroPushResult {
  /** Each write's outcome, by its place in `zoteroPushWrites(plan)`;
   *  `unknown` for a write in a request that failed in a way that leaves
   *  open whether Zotero made it, as a timeout; absent for writes never
   *  sent. */
  readonly outcomes: ReadonlyArray<Exclude<ZoteroWriteOutcome, { status: 'unreported' }> | 'unknown' | undefined>;
  /** Why writing stopped early, if it did. */
  readonly error?: ZoteroLocalApiError;
}

const BATCH = 50;

/** An error from outside the adapter, as a key store's, as the adapter's. */
function asApiError(error: unknown): ZoteroLocalApiError {
  return error instanceof ZoteroLocalApiError
    ? error
    : new ZoteroLocalApiError('request-failed', 'Getting a key to write with failed: ' + (error instanceof Error ? error.message : String(error)));
}

function writeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Send the plan's writes in batches.  Each batch is made against the
 *  library version the last one left, so a change made in Zotero meanwhile
 *  stops the push rather than being overwritten.  A refused key is asked for
 *  again once per batch. */
export async function applyZoteroPush(
  scope: ZoteroLibraryScope,
  prepared: ZoteroPushPrepared,
  keys: ZoteroKeyProvider,
  options: ZoteroLocalApiOptions = {},
): Promise<ZoteroPushResult> {
  const writes = zoteroPushWrites(prepared.plan);
  const outcomes: Array<Exclude<ZoteroWriteOutcome, { status: 'unreported' }> | 'unknown' | undefined> = writes.map(() => undefined);
  let libraryVersion = prepared.libraryVersion;
  // The items this push has written, with the version each write left.
  const written = new Map<string, number>();
  let lastSent = libraryVersion;
  for (let start = 0; start < writes.length; start += BATCH) {
    const batch = writes.slice(start, start + BATCH);
    // A batch's version may include another writer's change made while it
    // was saved; before the next, check that only this push's writes moved
    // the library: no other item changed, and none of ours since we wrote it.
    // (After the last batch there is nothing left to write over a change.)
    if (start > 0) {
      try {
        const changed = await fetchZoteroItemVersionsSince(scope, lastSent, options);
        const others = [...changed].filter(([k, v]) => written.get(k) === undefined || v === undefined || v !== written.get(k)).map(([k]) => k);
        if (others.length > 0) {
          return {
            outcomes,
            error: new ZoteroLocalApiError('library-changed', 'Items changed in Zotero during the push: ' + others.join(', ') + '.'),
          };
        }
      } catch (error) {
        if (error instanceof ZoteroLocalApiError) return { outcomes, error };
        throw error;
      }
    }
    let result: Awaited<ReturnType<typeof writeZoteroItems>> | undefined;
    for (let attempt = 0; result === undefined; attempt++) {
      // A key that can't be had (no key saved, the dialog denied) ends the
      // push as it is; only a key Zotero refused is asked for again.
      let apiKey: string;
      try {
        apiKey = await keys.get();
      } catch (error) {
        // Whatever failed, the writes already made stay in the result.
        return { outcomes, error: asApiError(error) };
      }
      try {
        result = await writeZoteroItems(
          scope,
          batch,
          { apiKey, serverId: prepared.serverId, libraryVersion, writeToken: writeToken() },
          options,
        );
      } catch (error) {
        if (error instanceof ZoteroLocalApiError && error.kind === 'unauthorized' && attempt === 0) {
          try {
            await keys.invalidate();
          } catch (invalidateError) {
            return { outcomes, error: asApiError(invalidateError) };
          }
          continue;
        }
        if (error instanceof ZoteroLocalApiError) {
          // Zotero refused these statuses before writing anything; after
          // any other failure the batch may have been written.
          // (A dropped connection reads as not-running, but the batch may
          // have been sent, so it is unknown.)
          const refused = ['unauthorized', 'write-denied', 'library-changed', 'api-disabled'];
          if (!refused.includes(error.kind)) batch.forEach((_, i) => (outcomes[start + i] = 'unknown'));
          return { outcomes, error };
        }
        throw error;
      }
    }
    result.outcomes.forEach((o, i) => (outcomes[start + i] = o.status === 'unreported' ? 'unknown' : o));
    for (const o of result.outcomes) if (o.status === 'success') written.set(o.key, o.version);
    lastSent = libraryVersion;
    if (result.libraryVersion === undefined) {
      if (start + BATCH < writes.length) {
        return {
          outcomes,
          error: new ZoteroLocalApiError('request-failed', 'Zotero did not report the library version after a write, so the push stopped.'),
        };
      }
    } else {
      libraryVersion = result.libraryVersion;
    }
  }
  return { outcomes };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const SKIP_PROSE: Readonly<Record<ZoteroPushSkipReason, string>> = {
  conflict: 'the entry cannot be read safely',
  ambiguous: 'several Zotero items match',
  'weak-match':
    'matched only by URL, by title, author and year, or by an ISBN a book shares with its parts or with another kind of item; link it with a citation key or DOI',
  'other-library': 'linked to an item in another library',
  'identity-disagreement': "its DOI differs from the matched item's",
  'duplicate-target': 'another entry matches the same item',
  'duplicate-doi': 'another entry would give the same DOI to an item',
  'doi-owned-elsewhere': 'another item in the library has its DOI',
  'pmid-disagreement': "its PMID is another item's, or its matched item has another",
  'citation-key-conflict':
    'another Zotero item answers to its citation key, in its Citation Key field or a "Citation Key:" line of Extra; link the entry with zotero-key',
  'isbn-owned-elsewhere': "its ISBN is another item's",
  'possible-existing':
    'an item with no citation key stored has its title and names, so it may be that item; if it is, give it the citation key in Zotero',
  'generated-key':
    "Zotero's BibTeX export makes this citation key for an item with none stored, so it may be that item; if it is, give it the citation key in Zotero",

  'duplicate-identifier': 'another entry would give the same identifier to an item',
  'incomplete-item': "Zotero's answer did not give the whole list that writing would replace",
  'no-citation-key-field':
    'Zotero has no Citation Key field for this item type, so the next push could not find the item and would create it again',
  'key-taken': "Zotero already holds the item key push would create this entry's item under, so push won't create it",
  'citation-key-moved':
    'push created an item for this citation key before, and another item has the citation key now, so which one the entry means is unclear; check both in Zotero',
  'unsupported-type': 'no Zotero item type for this entry type',
  'unreadable-identifier': 'an identifier is written with TeX; write it plain',
  'extra-would-migrate':
    "saving the item would make Zotero move these lines of its Extra field into fields; move them in Zotero first",
};

const NOT_PUSHED_PROSE: Readonly<Record<ZoteroFieldNotPushedReason, string>> = {
  'no-zotero-field': 'no Zotero field',
  tex: 'TeX left after decoding',
  'date-unreadable': 'date not readable',
  'duplicate-zotero-field': 'another field gives the same Zotero field',
  'no-creator-role': 'no such creator role',
  macro: "a @string macro's name",
  'incomplete-names': "ends with 'and others' and differs from Zotero's first names",
  'unreadable-doi': 'not a DOI',
  'unreadable-pmid': 'not a PubMed id',
  'unreadable-names': 'a name BibTeX does not read as one',
  math: 'TeX math, which Zotero would not keep as written',
  'ambiguous-journal': 'Zotero has a full title and an abbreviation, and this could be either; give fjournal too, or change it in Zotero',
  'series-editors': "Zotero's export lists its series editors as editors; change them in Zotero",
  'repeated-field': 'given more than once',
};

/** One line saying what the plan does. */
export function formatZoteroPushSummary(plan: ZoteroPushPlan, collection: string): string {
  const s = plan.summary;
  const parts = [
    s.created + ' to create',
    s.added + ' to add to the collection',
    ...(plan.mode === 'update' ? [s.updated + ' to update'] : []),
    s.unchanged + ' unchanged',
    s.skipped + ' skipped',
  ];
  return `"${collection}": ${s.entries} entries, ` + parts.join(', ') + '.';
}

/** The plan entry by entry, and, once written, each write's outcome. */
export function formatZoteroPushReport(
  plan: ZoteroPushPlan,
  collection: string,
  result?: ZoteroPushResult,
): string {
  const lines = [formatZoteroPushSummary(plan, collection)];
  let write = 0;
  for (const a of plan.actions) {
    const outcome = a.kind === 'create' || a.kind === 'update' ? result?.outcomes[write++] : undefined;
    const done =
      result === undefined || (a.kind !== 'create' && a.kind !== 'update')
        ? ''
        : outcome === undefined
          ? ' [not sent]'
          : outcome === 'unknown'
            ? ' [outcome unknown: run the push again to check]'
          : outcome.status === 'failed' && a.kind === 'create' && outcome.code === 412
            ? ` [failed: Zotero already has an item under this key, ${String(a.data.key)}, which was free when push read the library: an earlier push may have been saving it. Run the push again to see what is there.]`
          : outcome.status === 'failed'
            ? ` [failed: ${outcome.message}]`
            : outcome.status === 'success'
              ? ` [done: ${outcome.key}]`
              : ' [unchanged]';
    switch (a.kind) {
      case 'create':
        lines.push(`+ ${a.entryKey}: create a ${a.itemType}${done}`);
        break;
      case 'update':
        lines.push(`~ ${a.entryKey} (${a.itemKey}):${a.addToCollection ? ' add to the collection' : ''}${done}`);
        for (const c of a.changes) lines.push(`    ${c.field}: "${c.from}" → "${c.to}"`);
        break;
      case 'skip':
        lines.push(`! ${a.entryKey}: skipped, ${SKIP_PROSE[a.reason]}${a.detail ? ` (${a.detail})` : ''}`);
        break;
      case 'unchanged':
        break;
    }
    if (a.kind === 'unchanged' && a.notPushed.length > 0) lines.push(`= ${a.entryKey} (${a.itemKey}): unchanged`);
    if (a.kind !== 'skip' && a.notPushed.length > 0) {
      lines.push('    not pushed: ' + a.notPushed.map(n => `${n.field} (${NOT_PUSHED_PROSE[n.reason]})`).join(', '));
    }
  }
  if (result?.error) lines.push('Stopped: ' + result.error.message + ' Run the push again to finish it; it plans only what is still to do.');
  return lines.join('\n');
}

/** Whether every write was made. */
export function zoteroPushSucceeded(result: ZoteroPushResult): boolean {
  return (
    result.error === undefined &&
    result.outcomes.every(o => o !== undefined && o !== 'unknown' && o.status !== 'failed')
  );
}
