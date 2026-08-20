/** User-facing text and picker data for "Sync Bibliography from Zotero".
 *
 *  Everything the command shows a user — library picker rows, error prose,
 *  the confirmation modal, the output-channel report — is composed here as
 *  pure functions of plan/adapter data, so the wording is testable and the
 *  `extension.ts` wiring stays a thin shell.
 *
 *  Notifications avoid the plan's own vocabulary: "unmatched" becomes "not
 *  found in Zotero", "preserved" becomes "already up to date" — the report in
 *  the output channel is where the precise terms live.
 *
 *  No `vscode` import.  The picker rows use QuickPick's field names (label /
 *  description / detail) but are plain data. */

import type {
  ZoteroLinkDecision,
  ZoteroLinkConflictReason,
  ZoteroLinkUnmatchedReason,
} from './zotero-link';
import type {
  ZoteroEntryMetadataResult,
  ZoteroMetadataNotCheckedReason,
  ZoteroMetadataSkipReason,
  ZoteroSyncSummary,
} from './zotero-sync';
import type {
  ZoteroGroupSummary,
  ZoteroLibraryScope,
  ZoteroLocalApiErrorKind,
} from './zotero-local-api';
import { detectBibtexEol } from './bibtex-parser';

// ---------------------------------------------------------------------------
// Library picker
// ---------------------------------------------------------------------------

export interface ZoteroLibraryPickItem {
  readonly label: string;
  readonly description: string;
  readonly detail?: string;
  readonly scope: ZoteroLibraryScope;
}

/** Group libraries first (sorted by name), the personal library always last:
 *  group URIs resolve for every member, personal URIs only for their owner,
 *  so for a shared manuscript the groups are the right choice and the
 *  ordering should say so.  The count is Zotero's own `numItems`, which
 *  includes attachments and notes — an upper bound, shown only as a size
 *  hint. */
export function buildZoteroLibraryPickItems(
  groups: readonly ZoteroGroupSummary[],
): ZoteroLibraryPickItem[] {
  const items: ZoteroLibraryPickItem[] = [...groups]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(group => ({
      label: group.name,
      description: 'Group · ' + group.itemCount + ' items',
      scope: { type: 'group', groupId: group.groupId },
    }));
  items.push({
    label: 'My Library',
    description: 'Personal',
    // One clause only: QuickPick detail rows truncate, so the guidance
    // ("choose a group library for shared manuscripts") lives in the
    // confirmation modal and the docs instead.
    detail: 'Links to My Library work only for your Zotero account.',
    scope: { type: 'user' },
  });
  return items;
}

// ---------------------------------------------------------------------------
// Error prose
// ---------------------------------------------------------------------------

/** What the user should do about each adapter failure.  The two setup
 *  failures name the exact user action: `not-running` means nothing answered
 *  on the port, `api-disabled` means Zotero answered 403 because the
 *  "Allow other applications…" setting is off — different fixes, and telling
 *  the user the wrong one strands them.
 *
 *  `aborted` is excluded: the caller aborting is its own action, so there is
 *  nothing to tell the user, and the exclusion makes forgetting to suppress
 *  it a type error rather than an empty notification. */
export function describeZoteroLocalApiError(
  kind: Exclude<ZoteroLocalApiErrorKind, 'aborted'>,
): string {
  switch (kind) {
    case 'not-running':
      return (
        'Could not connect to Zotero. Start Zotero on this computer, then run this command again.'
      );
    case 'api-disabled':
      return (
        'Zotero is running, but other applications are not allowed to talk to it. ' +
        'In Zotero, open Settings → Advanced → Miscellaneous, check ' +
        '"Allow other applications on this computer to communicate with Zotero", ' +
        'then run this command again.'
      );
    case 'timeout':
      return 'Zotero did not answer in time. If it is busy syncing, try again in a moment.';
    case 'user-id-unavailable':
      return (
        'Zotero reported no account id for My Library, so its items have no address ' +
        'other applications can resolve. Log in to your Zotero account in Zotero, ' +
        'or choose a group library instead.'
      );
    case 'request-failed':
      return 'The request to Zotero failed unexpectedly. See the output channel for details.';
  }
}

/** Why this command is unavailable in remote workspaces (Remote SSH, WSL,
 *  containers): the extension runs next to the workspace, so "localhost" is
 *  the remote machine, not the desktop where Zotero runs. */
export const ZOTERO_REMOTE_WORKSPACE_MESSAGE =
  'Sync Bibliography from Zotero needs Zotero running on the same machine as this window. ' +
  'This workspace is remote, so the command cannot reach the Zotero on your desktop. ' +
  'Open the bibliography in a local window to sync it.';

// ---------------------------------------------------------------------------
// Confirmation modal
// ---------------------------------------------------------------------------

export interface ZoteroSyncConfirmation {
  /** The modal's headline question. */
  readonly message: string;
  /** The modal's detail block: counts, then the personal-library warning
   *  when one was selected. */
  readonly detail: string;
}

const plural = (n: number, noun: string, nouns: string = noun + 's'): string =>
  n + ' ' + (n === 1 ? noun : nouns);

/** The entries a run does not rewrite, phrased for a notification: "3 already
 *  in sync, 1 matched more than one item, 2 not found in Zotero".  The
 *  already-in-sync count is derived (total minus rewritten minus held back
 *  minus not-checked), so entries whose link is preserved but whose metadata
 *  changes — or was never compared — are never miscounted as untouched. */
function describeUntouched(summary: ZoteroSyncSummary): string {
  const { link } = summary;
  const inSync =
    link.totalEntries -
    summary.entriesChanged -
    summary.entriesNotChecked -
    link.ambiguous -
    link.conflicts -
    link.unmatched;
  const untouched: string[] = [];
  if (inSync > 0) untouched.push(inSync + ' already in sync');
  if (summary.entriesNotChecked > 0) {
    untouched.push(summary.entriesNotChecked + ' could not be checked');
  }
  if (link.ambiguous > 0) untouched.push(link.ambiguous + ' matched more than one item');
  if (link.conflicts > 0) untouched.push(plural(link.conflicts, 'conflict'));
  if (link.unmatched > 0) untouched.push(link.unmatched + ' not found in Zotero');
  return untouched.join(', ');
}

/** The notification for a run that has nothing to write: every entry is
 *  already in sync, not found, or held back — and the message says which. */
export function formatZoteroSyncNoChanges(summary: ZoteroSyncSummary, filename: string): string {
  const untouched = describeUntouched(summary);
  const detail = untouched.length > 0 ? ' (' + untouched + ')' : '';
  return 'No changes to "' + filename + '"' + detail + '.';
}

/** The completion notification once the file was written: what was linked
 *  and what had its metadata updated, in that order. */
export function formatZoteroSyncSuccess(summary: ZoteroSyncSummary, filename: string): string {
  const parts: string[] = [];
  if (summary.link.updates > 0) {
    parts.push('linked ' + plural(summary.link.updates, 'entry', 'entries') + ' to Zotero');
  }
  if (summary.metadataEntries > 0) {
    parts.push('updated metadata in ' + plural(summary.metadataEntries, 'entry', 'entries'));
  }
  return 'Synced "' + filename + '": ' + parts.join(' and ') + '.';
}

/** The modal shown before anything is written.  Only `entriesChanged`
 *  entries will change; everything else is enumerated so "left unchanged" is
 *  a statement, not an implication. */
export function formatZoteroSyncConfirmation(
  summary: ZoteroSyncSummary,
  scope: ZoteroLibraryScope,
): ZoteroSyncConfirmation {
  const { link } = summary;
  const untouched = describeUntouched(summary);

  const lines: string[] = [];
  if (link.updates > 0) {
    lines.push(
      link.updates +
        ' of ' +
        plural(link.totalEntries, 'entry', 'entries') +
        ' will be linked to Zotero items.',
    );
  }
  if (summary.metadataEntries > 0) {
    lines.push(
      'Metadata will be updated in ' +
        plural(summary.metadataEntries, 'entry', 'entries') +
        ' (' +
        plural(summary.metadataFields, 'field') +
        ').',
    );
  }
  if (untouched.length > 0) {
    lines.push(untouched + ' — left unchanged.');
  }
  if (scope.type === 'user') {
    lines.push(
      'Warning: these links point into My Library, so they work only for your ' +
        'Zotero account. Collaborators’ Word will fall back to embedded ' +
        'metadata and stop refreshing these citations. Zotero addresses ' +
        'personal libraries per account; only group libraries have addresses ' +
        'every member can resolve — for a shared manuscript, choose a group ' +
        'library instead.',
    );
  }
  return {
    message:
      'Update ' + plural(summary.entriesChanged, 'bibliography entry', 'bibliography entries') + ' from Zotero?',
    detail: lines.join('\n\n'),
  };
}

// ---------------------------------------------------------------------------
// Output-channel report
// ---------------------------------------------------------------------------

const CONFLICT_PROSE: Readonly<Record<ZoteroLinkConflictReason, string>> = {
  'duplicate-bibtex-key': 'this citation key appears more than once in the file',
  'invalid-zotero-key': 'zotero-key is not an 8-character item key',
  'invalid-zotero-uri': 'zotero-uri is not a Zotero identity URI',
  'zotero-key-uri-mismatch': 'zotero-key and zotero-uri name different items',
  'unknown-zotero-key': 'no item in the selected library has this zotero-key',
  'entry-not-editable': 'the entry’s boundaries could not be determined safely',
  'ambiguous-comment': 'a % outside any field makes the entry’s extent ambiguous',
  'concatenated-field': 'an identifier field uses # concatenation',
  'duplicate-field': 'an identifier field appears twice with different values',
  'symbolic-field': 'an identifier field is a @string macro reference',
};

const UNMATCHED_PROSE: Readonly<Record<ZoteroLinkUnmatchedReason, string>> = {
  'no-exact-match': 'no item in the selected library shares an identifier',
  'no-identifiers': 'no citation key, DOI, ISBN or PMID to match on',
};

function reportLine(decision: ZoteroLinkDecision): string {
  const key = decision.entry.key;
  switch (decision.outcome) {
    case 'update': {
      const title = decision.target.title !== undefined ? ' — ' + decision.target.title : '';
      return key + ' → ' + decision.target.key + ' (' + decision.evidence.join(', ') + ')' + title;
    }
    case 'preserve':
      return key + ' → ' + decision.target.key;
    case 'ambiguous':
      return (
        key +
        ': ' +
        decision.candidates.length +
        ' items share its ' +
        decision.evidence.join(', ') +
        ' (' +
        decision.candidates.map(c => c.key).join(', ') +
        ')'
      );
    case 'conflict': {
      const detail = decision.detail.length > 0 ? ' ("' + decision.detail + '")' : '';
      return key + ': ' + CONFLICT_PROSE[decision.reason] + detail;
    }
    case 'unmatched':
      return key + ': ' + UNMATCHED_PROSE[decision.reason];
  }
}

const REPORT_SECTIONS: ReadonlyArray<
  [outcome: ZoteroLinkDecision['outcome'], heading: string]
> = [
  ['update', 'New links'],
  ['preserve', 'Already linked'],
  ['ambiguous', 'Ambiguous (left unchanged)'],
  ['conflict', 'Conflicts (left unchanged)'],
  ['unmatched', 'Unmatched (left unchanged)'],
];

const SKIP_PROSE: Readonly<Record<ZoteroMetadataSkipReason, string>> = {
  'repeated-field': 'the field appears more than once in the entry',
  'macro-value': 'Zotero exports it as a macro reference, not a literal value',
};

/** Report prose per not-checked reason. */
const NOT_CHECKED_PROSE: Record<ZoteroMetadataNotCheckedReason, string> = {
  'different-library': 'links to an item in a different Zotero library than the one selected',
  'item-missing': 'the selected library no longer has this item',
  'unusable-export': 'Zotero produced no usable BibTeX for this item',
};

/** One report line per entry with metadata activity: the fields updated,
 *  added, or the type change, comma-joined. */
function metadataLine(result: ZoteroEntryMetadataResult): string {
  const parts = result.changes.map(change => {
    switch (change.kind) {
      case 'update':
        return change.name + ' updated';
      case 'add':
        return change.name + ' added';
      case 'type':
        return 'type @' + change.from + ' → @' + change.to;
    }
  });
  return result.key + ': ' + parts.join(', ');
}

/** The full per-entry report, for the output channel.  Sections appear only
 *  when non-empty, each entry on its own line, in source order.  Takes the
 *  decisions and metadata results alone — every count in the header is
 *  derived from them, so the report cannot disagree with its own sections. */
export function formatZoteroSyncReport(
  decisions: readonly ZoteroLinkDecision[],
  metadata: readonly ZoteroEntryMetadataResult[],
  libraryLabel: string,
): string {
  const byOutcome = new Map<ZoteroLinkDecision['outcome'], ZoteroLinkDecision[]>();
  for (const decision of decisions) {
    const bucket = byOutcome.get(decision.outcome);
    if (bucket) bucket.push(decision);
    else byOutcome.set(decision.outcome, [decision]);
  }
  const count = (outcome: ZoteroLinkDecision['outcome']): number =>
    byOutcome.get(outcome)?.length ?? 0;
  const metadataUpdated = metadata.filter(m => m.changes.length > 0);
  const metadataSkipped = metadata.filter(m => m.skipped.length > 0);
  const metadataNotChecked = metadata.filter(m => m.notChecked !== undefined);

  const lines: string[] = [
    'Sync Bibliography from Zotero — ' +
      libraryLabel +
      ', ' +
      plural(decisions.length, 'entry', 'entries'),
    'linked ' +
      count('update') +
      ', already linked ' +
      count('preserve') +
      ', metadata updated in ' +
      metadataUpdated.length +
      ', ambiguous ' +
      count('ambiguous') +
      ', conflicts ' +
      count('conflict') +
      ', unmatched ' +
      count('unmatched'),
  ];
  for (const [outcome, heading] of REPORT_SECTIONS) {
    const matching = byOutcome.get(outcome);
    if (matching === undefined) continue;
    lines.push('', heading + ':');
    for (const decision of matching) lines.push('  ' + reportLine(decision));
  }
  if (metadataUpdated.length > 0) {
    lines.push('', 'Metadata updates:');
    for (const result of metadataUpdated) lines.push('  ' + metadataLine(result));
  }
  if (metadataSkipped.length > 0) {
    lines.push('', 'Metadata fields not applied:');
    for (const result of metadataSkipped) {
      for (const skip of result.skipped) {
        lines.push('  ' + result.key + ': ' + skip.name + ' — ' + SKIP_PROSE[skip.reason]);
      }
    }
  }
  if (metadataNotChecked.length > 0) {
    lines.push('', 'Metadata not checked:');
    for (const result of metadataNotChecked) {
      lines.push('  ' + result.key + ' — ' + NOT_CHECKED_PROSE[result.notChecked!]);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Unmatched export
// ---------------------------------------------------------------------------

/** First line of every generated unmatched export.  The sidecar's path is
 *  predictable (`<name>-unmatched.bib`), so before overwriting or deleting a
 *  file there the command checks for this marker — a file without it was
 *  authored by the user and must not be destroyed. */
export const UNMATCHED_EXPORT_MARKER =
  '% Entries "Sync Bibliography from Zotero" could not find in ';

/** The marker written while the command was named "Link Bibliography to
 *  Zotero".  Still recognized by the ownership check, so sidecars from
 *  earlier runs are replaced rather than blocking the export. */
const LEGACY_UNMATCHED_EXPORT_MARKER =
  '% Entries "Link Bibliography to Zotero" could not match in ';

/** Whether an existing sidecar's content is this command's own output —
 *  current or legacy marker.  This module owns both spellings, so a future
 *  marker migration changes only this file. */
export function isUnmatchedExportOurs(text: string): boolean {
  return (
    text.startsWith(UNMATCHED_EXPORT_MARKER) || text.startsWith(LEGACY_UNMATCHED_EXPORT_MARKER)
  );
}

/** A .bib of just the unmatched entries, for a second round trip: import
 *  this file into Zotero (File → Import), then run Sync Bibliography from
 *  Zotero again — the imported items match on the identifiers they were
 *  imported with.
 *
 *  Only `unmatched` entries are exported.  Ambiguous and conflicted entries
 *  are deliberately left out: their items are already in the library (or the
 *  entry itself needs fixing), so importing them again would create the very
 *  duplicates the ambiguity tier refuses to guess between.
 *
 *  Entries are exported as-is; `@string` macros and `crossref`/`xdata`
 *  parents they reference are not chased.  The bibliographies this command
 *  targets — Better BibTeX exports and this extension's own converter
 *  output — never emit those constructs, and chasing them would mean
 *  re-implementing BibTeX inheritance for a file Zotero re-parses anyway.
 *
 *  Each entry is the byte-exact slice from the source bibliography, prefixed
 *  with a `%` comment naming why it did not match.  Returns undefined when
 *  nothing is unmatched, so no stale file is written.  Generated lines use
 *  the source file's own line ending. */
export function buildUnmatchedBibliography(
  bibliographyText: string,
  decisions: readonly ZoteroLinkDecision[],
  libraryLabel: string,
): string | undefined {
  const unmatched = decisions.filter(d => d.outcome === 'unmatched');
  if (unmatched.length === 0) return undefined;

  const eol = detectBibtexEol(bibliographyText);
  const chunks: string[] = [
    UNMATCHED_EXPORT_MARKER + libraryLabel + '.',
    '% Generated by Manuscript Markdown; this file is overwritten on every run.',
    '% To sync them: import this file into Zotero (File -> Import), then run the',
    '% command again. Matching uses exact identifiers only, so entries with no',
    '% identifiers will match by their citation key if Better BibTeX manages it.',
    '',
  ];
  for (const decision of unmatched) {
    chunks.push('% ' + reportLine(decision));
    chunks.push(bibliographyText.slice(decision.entry.start, decision.entry.end));
    chunks.push('');
  }
  chunks.pop();
  return chunks.join(eol) + eol;
}

/** The sentence appended to the completion notification when an unmatched
 *  export was written beside the bibliography.  Deliberately plain: it walks
 *  the user through the round trip instead of naming plan outcomes. */
export function formatUnmatchedExportNote(unmatchedCount: number, filename: string): string {
  return (
    ' ' +
    plural(unmatchedCount, 'entry', 'entries') +
    ' in your .bib file ' +
    (unmatchedCount === 1 ? 'was' : 'were') +
    ' not found in Zotero, so they were copied to a new file, "' +
    filename +
    '", that you can import into Zotero (File → Import). After importing, run ' +
    'this command again to link them.'
  );
}

/** The sentence appended when the sidecar exists but is not this command's
 *  output (no marker, or unsaved edits), so it was left untouched.  Phrased
 *  as a note, not an error: by the time it is shown, any links are already
 *  committed. */
export function formatUnmatchedExportBlockedNote(
  unmatchedCount: number,
  filename: string,
): string {
  return (
    ' ' +
    plural(unmatchedCount, 'entry was', 'entries were') +
    ' not found in Zotero, but "' +
    filename +
    '" was left untouched — it has unsaved edits or was not generated by this ' +
    'command. Move it aside and run the command again to export them.'
  );
}

/** The sentence appended when writing the sidecar itself failed. */
export function formatUnmatchedExportFailedNote(
  unmatchedCount: number,
  filename: string,
): string {
  return (
    ' ' +
    plural(unmatchedCount, 'entry was', 'entries were') +
    ' not found in Zotero, but "' +
    filename +
    '" could not be written — the per-entry report lists them.'
  );
}

/** The sentence appended when an outdated export from an earlier run could
 *  not be removed: without it the leftover file reads as current. */
export function formatStaleUnmatchedExportNote(filename: string): string {
  return (
    ' An outdated "' +
    filename +
    '" from an earlier run could not be removed; its entries are all in Zotero now.'
  );
}
