/** Running "Push Bibliography to Zotero": reading what the plan needs,
 *  writing it, and the report.  Shared by the extension and the CLI, so the
 *  two can't drift.  No vscode import: the key store and the transport come
 *  from the caller. */

import { createZoteroLinkPlan } from './zotero-link';
import {
  fetchZoteroLibrarySnapshot,
  fetchZoteroSchema,
  writeZoteroItems,
  ZoteroLocalApiError,
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
  collectionKey: string,
  mode: ZoteroPushMode,
  options: ZoteroLocalApiOptions = {},
): Promise<ZoteroPushPrepared | undefined> {
  const snapshot = await fetchZoteroLibrarySnapshot(scope, options);
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
  /** Each write's outcome, by its place in `zoteroPushWrites(plan)`; absent
   *  for writes never sent. */
  readonly outcomes: ReadonlyArray<ZoteroWriteOutcome | undefined>;
  /** Why writing stopped early, if it did. */
  readonly error?: ZoteroLocalApiError;
}

const BATCH = 50;

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
  const outcomes: Array<ZoteroWriteOutcome | undefined> = writes.map(() => undefined);
  let libraryVersion = prepared.libraryVersion;
  for (let start = 0; start < writes.length; start += BATCH) {
    const batch = writes.slice(start, start + BATCH);
    let result: Awaited<ReturnType<typeof writeZoteroItems>> | undefined;
    for (let attempt = 0; result === undefined; attempt++) {
      // A key that can't be had (no key saved, the dialog denied) ends the
      // push as it is; only a key Zotero refused is asked for again.
      let apiKey: string;
      try {
        apiKey = await keys.get();
      } catch (error) {
        if (error instanceof ZoteroLocalApiError) return { outcomes, error };
        throw error;
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
          await keys.invalidate();
          continue;
        }
        if (error instanceof ZoteroLocalApiError) return { outcomes, error };
        throw error;
      }
    }
    result.outcomes.forEach((o, i) => (outcomes[start + i] = o));
    libraryVersion = result.libraryVersion;
  }
  return { outcomes };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const SKIP_PROSE: Readonly<Record<ZoteroPushSkipReason, string>> = {
  conflict: 'the entry cannot be read safely',
  ambiguous: 'several Zotero items match',
  'weak-match': 'matched only by URL or title, author and year; link it with a citation key or DOI',
  'other-library': 'linked to an item in another library',
  'identity-disagreement': "its DOI differs from the matched item's",
  'duplicate-target': 'another entry matches the same item',
  'duplicate-doi': 'another new entry has the same DOI',
  'unsupported-type': 'no Zotero item type for this entry type',
};

const NOT_PUSHED_PROSE: Readonly<Record<ZoteroFieldNotPushedReason, string>> = {
  'no-zotero-field': 'no Zotero field',
  tex: 'TeX left after decoding',
  'date-unreadable': 'date not readable',
  'zotero-date-unparsed': "Zotero's date is free text",
  'duplicate-zotero-field': 'another field gives the same Zotero field',
  'no-creator-role': 'no such creator role',
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
    if (a.kind !== 'skip' && a.kind !== 'unchanged' && a.notPushed.length > 0) {
      lines.push('    not pushed: ' + a.notPushed.map(n => `${n.field} (${NOT_PUSHED_PROSE[n.reason]})`).join(', '));
    }
  }
  if (result?.error) lines.push('Stopped: ' + result.error.message);
  return lines.join('\n');
}

/** Whether every write was made. */
export function zoteroPushSucceeded(result: ZoteroPushResult): boolean {
  return result.error === undefined && result.outcomes.every(o => o !== undefined && o.status !== 'failed');
}
