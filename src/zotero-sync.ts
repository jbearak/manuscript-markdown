/** Metadata sync for "Sync Bibliography from Zotero".
 *
 *  The link planner (`zotero-link.ts`) decides which Zotero item each .bib
 *  entry IS; this module makes the entry's metadata SAY what that item says.
 *  Zotero is the source of truth for every field its BibTeX translator
 *  exports: a field present in both with a different value is rewritten in
 *  place, a field only Zotero has is added, and a field only the .bib has is
 *  preserved — the translator omits plenty of fields Zotero does store, so
 *  "absent from the export" is not evidence of deletion.
 *
 *  Rewrites are byte-surgical.  A changed value replaces exactly the value's
 *  own delimited slice (offsets from the entry body walk), so field order,
 *  the file's layout, and every untouched byte survive.  Because the
 *  replacement text is the translator's own output, a second run compares
 *  equal everywhere and rewrites nothing — the sync is idempotent.
 *
 *  Field policy, applied by name (lowercased):
 *  - `file` is never written: it holds absolute paths on the machine running
 *    Zotero, meaningless to collaborators and to future checkouts.
 *  - `abstract` and `keywords` are updated when the entry already carries
 *    them but never added: they do not affect citations, and adding a long
 *    abstract to every entry would bury a lean bibliography in noise.
 *  - `zotero-key`/`zotero-uri` belong to the link planner, never to sync.
 *  - A Zotero value written as a bare macro reference (`month = aug`) is
 *    skipped: its spelling is not its value, and writing the spelling as a
 *    literal would change what the field means.
 *
 *  Pure: no vscode import, no IO.  Same inputs, same plan. */

import {
  detectBibtexEol,
  detectBibtexFieldIndent,
  detectEntryEol,
  formatBibtexFieldLine,
  parseBibtexWithRaw,
  scanBibtexEntryBody,
  spliceFieldsIntoEntry,
  type BibtexEntryFieldOccurrence,
} from './bibtex-parser';
import {
  summarizeZoteroLinkDecisions,
  type ZoteroLinkDecision,
  type ZoteroLinkSummary,
} from './zotero-link';

/** Fields sync never writes, whatever the translator emits. */
const NEVER_SYNCED: ReadonlySet<string> = new Set(['file', 'zotero-key', 'zotero-uri']);

/** Fields updated in place when present but never added. */
const UPDATE_ONLY: ReadonlySet<string> = new Set(['abstract', 'keywords']);

/** One metadata edit sync plans for an entry. */
export type ZoteroMetadataChange =
  | { readonly kind: 'update'; readonly name: string; readonly from: string; readonly to: string }
  | { readonly kind: 'add'; readonly name: string; readonly to: string }
  /** The entry's own type (`@article` vs `@misc`) changed in Zotero. */
  | { readonly kind: 'type'; readonly from: string; readonly to: string };

/** Why one field in Zotero's export was not applied. */
export type ZoteroMetadataSkipReason =
  /** The .bib writes this field more than once, so "the" value slice to
   *  replace is ambiguous. */
  | 'repeated-field'
  /** Zotero's value is a bare macro reference; its spelling is not its
   *  value. */
  | 'macro-value';

export interface ZoteroMetadataSkip {
  readonly name: string;
  readonly reason: ZoteroMetadataSkipReason;
}

/** The metadata outcome for one matched entry. */
export interface ZoteroEntryMetadataResult {
  /** The .bib entry's citation key. */
  readonly key: string;
  readonly changes: readonly ZoteroMetadataChange[];
  readonly skipped: readonly ZoteroMetadataSkip[];
  /** Zotero produced no usable BibTeX for the matched item, so its metadata
   *  could not be compared at all.  The identity link still applies. */
  readonly unavailable: boolean;
}

export interface ZoteroSyncSummary {
  readonly link: ZoteroLinkSummary;
  /** Entries whose text this plan rewrites (identity fields, metadata, or
   *  both) — the number the confirmation modal should headline. */
  readonly entriesChanged: number;
  /** Matched entries with at least one metadata change. */
  readonly metadataEntries: number;
  /** Total field changes across all entries (type changes included). */
  readonly metadataFields: number;
}

export interface ZoteroSyncPlan {
  /** The link decisions this plan was built over, unchanged. */
  readonly decisions: readonly ZoteroLinkDecision[];
  /** Per matched entry (update and preserve outcomes), in source order. */
  readonly metadata: readonly ZoteroEntryMetadataResult[];
  readonly summary: ZoteroSyncSummary;
  /** The whole file with identity additions and metadata edits applied.
   *  Identical to the input when `changed` is false. */
  readonly updatedText: string;
  readonly changed: boolean;
}

/** Whitespace-insensitive value equality: the .bib may wrap a long value
 *  across lines where the translator writes one; that layout difference is
 *  not a metadata difference. */
function valuesEqual(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/** The parsed pieces of Zotero's BibTeX export for one item, or undefined
 *  when the export is missing, empty, or not one clean entry. */
function readZoteroBibtex(bibtex: string | undefined):
  | {
      readonly type: string;
      readonly fields: readonly BibtexEntryFieldOccurrence[];
    }
  | undefined {
  if (bibtex === undefined || bibtex.trim().length === 0) return undefined;
  const parsed = parseBibtexWithRaw(bibtex);
  if (parsed.ranges.length !== 1 || !parsed.ranges[0].trusted) return undefined;
  const range = parsed.ranges[0];
  const raw = bibtex.slice(range.start, range.end);
  const body = scanBibtexEntryBody(raw);
  if (body.unbalanced || body.entryType === undefined) return undefined;
  return { type: body.entryType.raw.toLowerCase(), fields: body.fields };
}

interface EntryEdit {
  /** Non-overlapping replacements within the entry's raw text, in offset
   *  order: changed values, and the type token when it changed. */
  readonly replacements: readonly { start: number; end: number; text: string }[];
  /** Field lines to splice in before the closer. */
  readonly additions: readonly string[];
}

/** Plan the metadata edits for one entry against one Zotero export.
 *  `rawEntry` must be the exact source slice for the entry; its body is
 *  already known editable — the link planner refuses entries whose lexical
 *  level is ambiguous before they can reach an update/preserve outcome. */
function planEntryMetadata(
  rawEntry: string,
  zotero: NonNullable<ReturnType<typeof readZoteroBibtex>>,
): { edit: EntryEdit; changes: ZoteroMetadataChange[]; skipped: ZoteroMetadataSkip[] } {
  const body = scanBibtexEntryBody(rawEntry);
  const occurrenceCounts = new Map<string, number>();
  const lastOccurrence = new Map<string, BibtexEntryFieldOccurrence>();
  for (const field of body.fields) {
    occurrenceCounts.set(field.name, (occurrenceCounts.get(field.name) ?? 0) + 1);
    lastOccurrence.set(field.name, field);
  }

  const replacements: { start: number; end: number; text: string }[] = [];
  const additions: string[] = [];
  const changes: ZoteroMetadataChange[] = [];
  const skipped: ZoteroMetadataSkip[] = [];
  // Lazy: most entries add nothing, and the indent regex only matters when
  // one does.
  let indentCache: string | undefined;
  const indent = () => (indentCache ??= detectBibtexFieldIndent(rawEntry));

  const sourceType = body.entryType;
  if (sourceType !== undefined && sourceType.raw.toLowerCase() !== zotero.type) {
    replacements.push({ start: sourceType.start, end: sourceType.end, text: zotero.type });
    changes.push({ kind: 'type', from: sourceType.raw, to: zotero.type });
  }

  // Translator order; it never repeats a field, so first occurrence is the
  // occurrence.
  const seen = new Set<string>();
  for (const field of zotero.fields) {
    if (seen.has(field.name)) continue;
    seen.add(field.name);
    if (NEVER_SYNCED.has(field.name)) continue;
    if (field.delimiter === 'bare' && !/^\d+$/.test(field.value)) {
      skipped.push({ name: field.name, reason: 'macro-value' });
      continue;
    }

    const existing = lastOccurrence.get(field.name);
    if (existing === undefined) {
      if (UPDATE_ONLY.has(field.name)) continue;
      additions.push(formatBibtexFieldLine(field.name, field.value, indent()));
      changes.push({ kind: 'add', name: field.name, to: field.value });
      continue;
    }
    if ((occurrenceCounts.get(field.name) ?? 0) > 1) {
      skipped.push({ name: field.name, reason: 'repeated-field' });
      continue;
    }
    if (valuesEqual(existing.value, field.value)) continue;
    replacements.push({
      start: existing.valueStart,
      end: existing.valueEnd,
      text: '{' + field.value + '}',
    });
    changes.push({ kind: 'update', name: field.name, from: existing.value, to: field.value });
  }

  replacements.sort((a, b) => a.start - b.start);
  return { edit: { replacements, additions }, changes, skipped };
}

/** Apply one entry's replacements and additions to its raw text. */
function rewriteEntry(rawEntry: string, edit: EntryEdit, documentEol: () => '\n' | '\r\n'): string {
  let text = rawEntry;
  if (edit.replacements.length > 0) {
    const chunks: string[] = [];
    let pos = 0;
    for (const { start, end, text: replacement } of edit.replacements) {
      chunks.push(rawEntry.slice(pos, start), replacement);
      pos = end;
    }
    chunks.push(rawEntry.slice(pos));
    text = chunks.join('');
  }
  if (edit.additions.length > 0) {
    text = spliceFieldsIntoEntry(text, [...edit.additions], detectEntryEol(text) ?? documentEol());
  }
  return text;
}

/** Combine the link plan's identity additions with metadata edits into one
 *  rewrite of the whole file.
 *
 *  Metadata applies to `update` and `preserve` outcomes alike: an entry that
 *  was linked on a previous run is exactly the entry whose Zotero-side edits
 *  a later run exists to pull in.  Everything else (ambiguous, conflict,
 *  unmatched) is untouched, as in the link plan.
 *
 *  `bibtexByKey` maps Zotero item keys to that item's BibTeX export; a
 *  missing or unusable entry downgrades gracefully — the identity fields are
 *  still written, and the entry is reported as metadata-unavailable. */
export function createZoteroSyncPlan(
  text: string,
  decisions: readonly ZoteroLinkDecision[],
  bibtexByKey: ReadonlyMap<string, string>,
): ZoteroSyncPlan {
  let documentEolCache: '\n' | '\r\n' | null = null;
  const documentEol = () => (documentEolCache ??= detectBibtexEol(text));

  // Several entries may target the same Zotero item; parse its export once.
  // Unusable exports are cached too (as undefined), so they are not re-parsed
  // per entry either.
  const parsedByKey = new Map<string, ReturnType<typeof readZoteroBibtex>>();
  const zoteroFor = (key: string) => {
    if (!parsedByKey.has(key)) parsedByKey.set(key, readZoteroBibtex(bibtexByKey.get(key)));
    return parsedByKey.get(key);
  };

  const metadata: ZoteroEntryMetadataResult[] = [];
  const chunks: string[] = [];
  let pos = 0;
  let entriesChanged = 0;
  let metadataEntries = 0;
  let metadataFields = 0;

  for (const decision of decisions) {
    if (decision.outcome !== 'update' && decision.outcome !== 'preserve') continue;

    const rawEntry = text.slice(decision.entry.start, decision.entry.end);
    const zotero = zoteroFor(decision.target.key);

    let edit: EntryEdit = { replacements: [], additions: [] };
    let changes: readonly ZoteroMetadataChange[] = [];
    let skipped: readonly ZoteroMetadataSkip[] = [];
    if (zotero !== undefined) {
      const planned = planEntryMetadata(rawEntry, zotero);
      edit = planned.edit;
      changes = planned.changes;
      skipped = planned.skipped;
    }

    let identityLines: string[] = [];
    if (decision.outcome === 'update' && decision.additions.length > 0) {
      const indent = detectBibtexFieldIndent(rawEntry);
      identityLines = decision.additions.map(a => formatBibtexFieldLine(a.name, a.value, indent));
    }
    const combined: EntryEdit = {
      replacements: edit.replacements,
      additions: [...edit.additions, ...identityLines],
    };

    metadata.push({
      key: decision.entry.key,
      changes,
      skipped,
      unavailable: zotero === undefined,
    });
    if (changes.length > 0) {
      metadataEntries++;
      metadataFields += changes.length;
    }

    if (combined.replacements.length === 0 && combined.additions.length === 0) continue;
    entriesChanged++;
    chunks.push(text.slice(pos, decision.entry.start), rewriteEntry(rawEntry, combined, documentEol));
    pos = decision.entry.end;
  }
  chunks.push(text.slice(pos));
  const updatedText = chunks.join('');

  return {
    decisions,
    metadata,
    summary: {
      link: summarizeZoteroLinkDecisions(decisions),
      entriesChanged,
      metadataEntries,
      metadataFields,
    },
    updatedText,
    changed: updatedText !== text,
  };
}

/** The Zotero item keys whose BibTeX the sync needs: every matched entry's
 *  target, deduplicated, in source order. */
export function zoteroSyncKeys(decisions: readonly ZoteroLinkDecision[]): string[] {
  const keys = new Set<string>();
  for (const decision of decisions) {
    if (decision.outcome === 'update' || decision.outcome === 'preserve') {
      keys.add(decision.target.key);
    }
  }
  return [...keys];
}
