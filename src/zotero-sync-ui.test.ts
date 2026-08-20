import { describe, it, expect } from 'bun:test';
import {
  buildUnmatchedBibliography,
  buildZoteroLibraryPickItems,
  describeZoteroLocalApiError,
  formatUnmatchedExportNote,
  formatZoteroSyncConfirmation,
  formatZoteroSyncNoChanges,
  formatZoteroSyncReport,
  formatZoteroSyncSuccess,
  UNMATCHED_EXPORT_MARKER,
} from './zotero-sync-ui';
import { parseBibtexWithRaw } from './bibtex-parser';
import type { ZoteroLinkSummary, ZoteroLinkDecision } from './zotero-link';
import type { ZoteroEntryMetadataResult, ZoteroSyncSummary } from './zotero-sync';
import { zoteroItem } from './zotero-link.fixtures';

// ---------------------------------------------------------------------------
// Library picker
// ---------------------------------------------------------------------------

describe('buildZoteroLibraryPickItems', () => {
  it('sorts groups by name and puts the personal library last', () => {
    const items = buildZoteroLibraryPickItems([
      { groupId: 2, name: 'Zeta', itemCount: 5 },
      { groupId: 1, name: 'Alpha', itemCount: 9 },
    ]);
    expect(items.map(i => i.label)).toEqual(['Alpha', 'Zeta', 'My Library']);
    expect(items[0].scope).toEqual({ type: 'group', groupId: 1 });
    expect(items[2].scope).toEqual({ type: 'user' });
  });

  it('warns on the personal-library row that its links are personal', () => {
    const items = buildZoteroLibraryPickItems([]);
    expect(items).toHaveLength(1);
    // One short clause: QuickPick detail rows truncate, so the "choose a
    // group library" guidance lives in the confirmation modal and docs.
    expect(items[0].detail).toBe('Links to My Library work only for your Zotero account.');
  });
});

// ---------------------------------------------------------------------------
// Error prose
// ---------------------------------------------------------------------------

describe('describeZoteroLocalApiError', () => {
  it('tells the user to start Zotero when nothing answered', () => {
    expect(describeZoteroLocalApiError('not-running')).toContain('Start Zotero');
  });

  it('names the exact setting when the API is disabled', () => {
    const prose = describeZoteroLocalApiError('api-disabled');
    expect(prose).toContain('Settings → Advanced → Miscellaneous');
    expect(prose).toContain('Allow other applications on this computer to communicate with Zotero');
  });

  it('covers every showable error kind with non-empty prose', () => {
    // 'aborted' is excluded from the parameter type: the caller aborting is
    // its own action, so there is nothing to show.
    const kinds: Parameters<typeof describeZoteroLocalApiError>[0][] = [
      'not-running',
      'api-disabled',
      'timeout',
      'user-id-unavailable',
      'request-failed',
    ];
    for (const kind of kinds) {
      expect(describeZoteroLocalApiError(kind).length).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// Confirmation modal
// ---------------------------------------------------------------------------

const linkSummaryOf = (partial: Partial<ZoteroLinkSummary>): ZoteroLinkSummary => ({
  totalEntries: 0,
  updates: 0,
  preserved: 0,
  ambiguous: 0,
  conflicts: 0,
  unmatched: 0,
  updatesByTier: { existing: 0, 'citation-key': 0, doi: 0, 'isbn-pmid': 0 },
  ...partial,
});

/** A sync summary whose derived fields default to "links only, no metadata":
 *  entriesChanged mirrors the link updates unless stated otherwise. */
const summaryOf = (
  link: Partial<ZoteroLinkSummary>,
  sync: Partial<Omit<ZoteroSyncSummary, 'link'>> = {},
): ZoteroSyncSummary => {
  const linkSummary = linkSummaryOf(link);
  return {
    link: linkSummary,
    entriesChanged: linkSummary.updates,
    metadataEntries: 0,
    metadataFields: 0,
    metadataUnavailable: 0,
    ...sync,
  };
};

describe('formatZoteroSyncConfirmation', () => {
  it('states what will change and what stays untouched', () => {
    const c = formatZoteroSyncConfirmation(
      summaryOf({ totalEntries: 10, updates: 4, preserved: 3, ambiguous: 1, conflicts: 1, unmatched: 1 }),
      { type: 'group', groupId: 1 },
    );
    expect(c.message).toBe('Update 4 bibliography entries from Zotero?');
    expect(c.detail).toContain('4 of 10 entries will be linked to Zotero items.');
    expect(c.detail).toContain(
      '3 already in sync, 1 matched more than one item, 1 conflict, 1 not found in Zotero — left unchanged.',
    );
  });

  it('counts metadata updates separately from new links', () => {
    const c = formatZoteroSyncConfirmation(
      summaryOf(
        { totalEntries: 10, updates: 2, preserved: 8 },
        { entriesChanged: 5, metadataEntries: 3, metadataFields: 7 },
      ),
      { type: 'group', groupId: 1 },
    );
    expect(c.message).toBe('Update 5 bibliography entries from Zotero?');
    expect(c.detail).toContain('2 of 10 entries will be linked to Zotero items.');
    expect(c.detail).toContain('Metadata will be updated in 3 entries (7 fields).');
    // 10 total − 5 rewritten = 5 already in sync, even though 8 are "preserved"
    // in link terms — three of those preserved entries get metadata edits.
    expect(c.detail).toContain('5 already in sync — left unchanged.');
  });

  it('omits the link line when only metadata changes', () => {
    const c = formatZoteroSyncConfirmation(
      summaryOf(
        { totalEntries: 4, updates: 0, preserved: 4 },
        { entriesChanged: 2, metadataEntries: 2, metadataFields: 3 },
      ),
      { type: 'group', groupId: 1 },
    );
    expect(c.detail).not.toContain('will be linked');
    expect(c.detail).toContain('Metadata will be updated in 2 entries (3 fields).');
  });

  it('uses singular forms for one entry', () => {
    const c = formatZoteroSyncConfirmation(
      summaryOf({ totalEntries: 1, updates: 1 }),
      { type: 'group', groupId: 1 },
    );
    expect(c.message).toBe('Update 1 bibliography entry from Zotero?');
    expect(c.detail).toContain('1 of 1 entry will be linked to Zotero items.');
  });

  it('warns about personal links only for the personal library', () => {
    const summary = summaryOf({ totalEntries: 2, updates: 2 });
    const group = formatZoteroSyncConfirmation(summary, { type: 'group', groupId: 1 });
    expect(group.detail).not.toContain('Warning');
    const personal = formatZoteroSyncConfirmation(summary, { type: 'user' });
    expect(personal.detail).toContain('only for your');
    // The warning attributes the behavior to Zotero's addressing scheme
    // (so it does not read as an extension limitation) and points at the
    // collaborative alternative.
    expect(personal.detail).toContain('Zotero addresses personal libraries per account');
    expect(personal.detail).toContain('choose a group library');
  });
});

// ---------------------------------------------------------------------------
// Output-channel report
// ---------------------------------------------------------------------------

const entryAt = (key: string) => ({
  key,
  start: 0,
  end: 1,
  keyStart: 0,
  keyEnd: 1,
  trusted: true,
});

const noMetadata: ZoteroEntryMetadataResult[] = [];

describe('formatZoteroSyncReport', () => {
  it('renders every outcome in its own section, with counts derived from the decisions', () => {
    const decisions: ZoteroLinkDecision[] = [
      {
        outcome: 'update',
        entry: entryAt('a'),
        tier: 'doi',
        evidence: ['doi'],
        target: zoteroItem('AAAAAAAA', { title: 'Paper A' }),
        additions: [],
      },
      { outcome: 'preserve', entry: entryAt('b'), target: zoteroItem('BBBBBBBB') },
      {
        outcome: 'ambiguous',
        entry: entryAt('c'),
        tier: 'isbn-pmid',
        evidence: ['isbn'],
        candidates: [zoteroItem('CCCCCCC1'), zoteroItem('CCCCCCC2')],
      },
      { outcome: 'conflict', entry: entryAt('d'), reason: 'unknown-zotero-key', detail: 'XXXXXXXX' },
      { outcome: 'unmatched', entry: entryAt('e'), reason: 'no-identifiers' },
    ];
    const report = formatZoteroSyncReport(decisions, noMetadata, 'Guttmacher Library');

    expect(report).toContain('Sync Bibliography from Zotero — Guttmacher Library, 5 entries');
    expect(report).toContain(
      'linked 1, already linked 1, metadata updated in 0, ambiguous 1, conflicts 1, unmatched 1',
    );
    expect(report).toContain('New links:\n  a → AAAAAAAA (doi) — Paper A');
    expect(report).toContain('Already linked:\n  b → BBBBBBBB');
    expect(report).toContain('Ambiguous (left unchanged):\n  c: 2 items share its isbn (CCCCCCC1, CCCCCCC2)');
    expect(report).toContain(
      'Conflicts (left unchanged):\n  d: no item in the selected library has this zotero-key ("XXXXXXXX")',
    );
    expect(report).toContain('Unmatched (left unchanged):\n  e: no citation key, DOI, ISBN or PMID to match on');
  });

  it('omits empty sections', () => {
    const report = formatZoteroSyncReport(
      [{ outcome: 'unmatched', entry: entryAt('a'), reason: 'no-exact-match' }],
      noMetadata,
      'G',
    );
    expect(report).toContain('Unmatched');
    expect(report).not.toContain('New links');
    expect(report).not.toContain('Conflicts');
    expect(report).not.toContain('Metadata');
  });

  it('lists metadata updates, skips, and unavailability with their reasons', () => {
    const metadata: ZoteroEntryMetadataResult[] = [
      {
        key: 'a',
        changes: [
          { kind: 'update', name: 'title', from: 'Old', to: 'New' },
          { kind: 'add', name: 'volume', to: '12' },
          { kind: 'type', from: 'misc', to: 'article' },
        ],
        skipped: [{ name: 'month', reason: 'macro-value' }],
        unavailable: false,
      },
      { key: 'b', changes: [], skipped: [{ name: 'doi', reason: 'repeated-field' }], unavailable: false },
      { key: 'c', changes: [], skipped: [], unavailable: true },
    ];
    const report = formatZoteroSyncReport(
      [
        {
          outcome: 'update',
          entry: entryAt('a'),
          tier: 'doi',
          evidence: ['doi'],
          target: zoteroItem('AAAAAAAA'),
          additions: [],
        },
      ],
      metadata,
      'G',
    );
    expect(report).toContain('metadata updated in 1');
    expect(report).toContain('Metadata updates:\n  a: title updated, volume added, type @misc → @article');
    expect(report).toContain(
      'Metadata fields not applied:\n' +
        '  a: month — Zotero exports it as a macro reference, not a literal value\n' +
        '  b: doi — the field appears more than once in the entry',
    );
    expect(report).toContain('Metadata unavailable');
    expect(report).toContain('\n  c');
  });
});

describe('formatZoteroSyncSuccess', () => {
  it('reports links and metadata updates in plain language', () => {
    expect(
      formatZoteroSyncSuccess(
        summaryOf({ totalEntries: 9, updates: 4 }, { entriesChanged: 6, metadataEntries: 3, metadataFields: 5 }),
        'refs.bib',
      ),
    ).toBe('Synced "refs.bib": linked 4 entries to Zotero and updated metadata in 3 entries.');
  });

  it('mentions only what happened', () => {
    expect(
      formatZoteroSyncSuccess(summaryOf({ totalEntries: 2, updates: 1 }), 'refs.bib'),
    ).toBe('Synced "refs.bib": linked 1 entry to Zotero.');
    expect(
      formatZoteroSyncSuccess(
        summaryOf({ totalEntries: 2, updates: 0 }, { entriesChanged: 1, metadataEntries: 1, metadataFields: 2 }),
        'refs.bib',
      ),
    ).toBe('Synced "refs.bib": updated metadata in 1 entry.');
  });
});

describe('formatZoteroSyncNoChanges', () => {
  it('says why nothing changed', () => {
    const message = formatZoteroSyncNoChanges(
      summaryOf({ totalEntries: 5, preserved: 3, ambiguous: 1, unmatched: 1 }),
      'refs.bib',
    );
    expect(message).toBe(
      'No changes to "refs.bib" (3 already in sync, 1 matched more than one item, 1 not found in Zotero).',
    );
  });

  it('stays plain for an empty bibliography', () => {
    expect(formatZoteroSyncNoChanges(summaryOf({}), 'refs.bib')).toBe('No changes to "refs.bib".');
  });
});

// ---------------------------------------------------------------------------
// Unmatched export
// ---------------------------------------------------------------------------

describe('buildUnmatchedBibliography', () => {
  const bib = '@article{one,\n  title = {T1},\n}\n\n@article{two,\n  doi = {10.1/x},\n}\n';
  // The parser owns range offsets; hand-maintained copies would drift.
  const [entryOne, entryTwo] = parseBibtexWithRaw(bib).ranges;

  it('exports unmatched entries byte-exactly with a reason comment each', () => {
    const out = buildUnmatchedBibliography(
      bib,
      [
        { outcome: 'unmatched', entry: entryOne, reason: 'no-identifiers' },
        { outcome: 'unmatched', entry: entryTwo, reason: 'no-exact-match' },
      ],
      'Guttmacher Library',
    );
    expect(out).toBeDefined();
    // The ownership guard in extension.ts recognizes its own output by this
    // marker as the first line; a generated file must always start with it.
    expect(out!.startsWith(UNMATCHED_EXPORT_MARKER)).toBe(true);
    expect(out).toContain('could not find in Guttmacher Library');
    expect(out).toContain('% one: no citation key, DOI, ISBN or PMID to match on');
    expect(out).toContain('% two: no item in the selected library shares an identifier');
    // Byte-exact entry slices.
    expect(out).toContain(bib.slice(entryOne.start, entryOne.end));
    expect(out).toContain(bib.slice(entryTwo.start, entryTwo.end));
    expect(out!.endsWith('\n')).toBe(true);
  });

  it('exports only unmatched entries, never ambiguous or conflicted ones', () => {
    // Their items are already in the library (or the entry needs fixing);
    // importing them again would create duplicates.
    const out = buildUnmatchedBibliography(
      bib,
      [
        {
          outcome: 'ambiguous',
          entry: entryOne,
          tier: 'doi',
          evidence: ['doi'],
          candidates: [zoteroItem('AAAAAAAA'), zoteroItem('BBBBBBBB')],
        },
        { outcome: 'conflict', entry: entryOne, reason: 'duplicate-field', detail: 'doi' },
        { outcome: 'unmatched', entry: entryTwo, reason: 'no-exact-match' },
      ],
      'G',
    );
    expect(out).toContain('@article{two');
    expect(out).not.toContain('@article{one');
  });

  it('returns undefined when nothing is unmatched', () => {
    expect(
      buildUnmatchedBibliography(
        bib,
        [{ outcome: 'preserve', entry: entryOne, target: zoteroItem('AAAAAAAA') }],
        'G',
      ),
    ).toBeUndefined();
    expect(buildUnmatchedBibliography(bib, [], 'G')).toBeUndefined();
  });

  it('matches the source line ending in generated lines', () => {
    const crlfBib = bib.replace(/\n/g, '\r\n');
    const [crlfEntry] = parseBibtexWithRaw(crlfBib).ranges;
    const out = buildUnmatchedBibliography(
      crlfBib,
      [{ outcome: 'unmatched', entry: crlfEntry, reason: 'no-identifiers' }],
      'G',
    );
    // Every line break — generated and sliced alike — is CRLF.
    expect(out).not.toMatch(/(?<!\r)\n/);
  });
});

describe('formatUnmatchedExportNote', () => {
  it('walks the user through the round trip in plain language', () => {
    expect(formatUnmatchedExportNote(2, 'refs-unmatched.bib')).toBe(
      ' 2 entries in your .bib file were not found in Zotero, so they were copied to ' +
        'a new file, "refs-unmatched.bib", that you can import into Zotero (File → Import). ' +
        'After importing, run this command again to link them.',
    );
    expect(formatUnmatchedExportNote(1, 'refs-unmatched.bib')).toContain('1 entry in your .bib file was');
  });
});
