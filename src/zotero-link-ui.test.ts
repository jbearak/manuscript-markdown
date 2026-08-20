import { describe, it, expect } from 'bun:test';
import {
  buildZoteroLibraryPickItems,
  describeZoteroLocalApiError,
  formatZoteroLinkConfirmation,
  formatZoteroLinkNoChanges,
  formatZoteroLinkReport,
} from './zotero-link-ui';
import type { ZoteroLinkSummary, ZoteroLinkDecision } from './zotero-link';
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
    expect(items[0].detail).toContain('group library');
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

const summaryOf = (partial: Partial<ZoteroLinkSummary>): ZoteroLinkSummary => ({
  totalEntries: 0,
  updates: 0,
  preserved: 0,
  ambiguous: 0,
  conflicts: 0,
  unmatched: 0,
  updatesByTier: { existing: 0, 'citation-key': 0, doi: 0, 'isbn-pmid': 0 },
  ...partial,
});

describe('formatZoteroLinkConfirmation', () => {
  it('states what will change and what stays untouched', () => {
    const c = formatZoteroLinkConfirmation(
      summaryOf({ totalEntries: 10, updates: 4, preserved: 3, ambiguous: 1, conflicts: 1, unmatched: 1 }),
      { type: 'group', groupId: 1 },
    );
    expect(c.message).toBe('Add Zotero links to 4 bibliography entries?');
    expect(c.detail).toContain('4 of 10 entries will get Zotero links.');
    expect(c.detail).toContain('3 already linked, 1 ambiguous, 1 conflict, 1 unmatched — left unchanged.');
  });

  it('uses singular forms for one entry', () => {
    const c = formatZoteroLinkConfirmation(
      summaryOf({ totalEntries: 1, updates: 1 }),
      { type: 'group', groupId: 1 },
    );
    expect(c.message).toBe('Add Zotero links to 1 bibliography entry?');
    expect(c.detail).toContain('1 of 1 entry will get Zotero links.');
  });

  it('warns about personal links only for the personal library', () => {
    const summary = summaryOf({ totalEntries: 2, updates: 2 });
    const group = formatZoteroLinkConfirmation(summary, { type: 'group', groupId: 1 });
    expect(group.detail).not.toContain('Warning');
    const personal = formatZoteroLinkConfirmation(summary, { type: 'user' });
    expect(personal.detail).toContain('only for your');
    // The warning must not read as an extension limitation, and must point
    // at the collaborative alternative.
    expect(personal.detail).toContain('not a limitation of this extension');
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

describe('formatZoteroLinkReport', () => {
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
    const report = formatZoteroLinkReport(decisions, 'Guttmacher Library');

    expect(report).toContain('Guttmacher Library, 5 entries');
    expect(report).toContain('linked 1, already linked 1, ambiguous 1, conflicts 1, unmatched 1');
    expect(report).toContain('New links:\n  a → AAAAAAAA (doi) — Paper A');
    expect(report).toContain('Already linked (unchanged):\n  b → BBBBBBBB');
    expect(report).toContain('Ambiguous (left unchanged):\n  c: 2 items share its isbn (CCCCCCC1, CCCCCCC2)');
    expect(report).toContain(
      'Conflicts (left unchanged):\n  d: no item in the selected library has this zotero-key ("XXXXXXXX")',
    );
    expect(report).toContain('Unmatched (left unchanged):\n  e: no citation key, DOI, ISBN or PMID to match on');
  });

  it('omits empty sections', () => {
    const report = formatZoteroLinkReport(
      [{ outcome: 'unmatched', entry: entryAt('a'), reason: 'no-exact-match' }],
      'G',
    );
    expect(report).toContain('Unmatched');
    expect(report).not.toContain('New links');
    expect(report).not.toContain('Conflicts');
  });
});

describe('formatZoteroLinkNoChanges', () => {
  it('says why nothing changed', () => {
    const message = formatZoteroLinkNoChanges(
      summaryOf({ totalEntries: 5, preserved: 3, ambiguous: 1, unmatched: 1 }),
      'refs.bib',
    );
    expect(message).toBe('No new Zotero links for "refs.bib" (3 already linked, 1 ambiguous, 1 unmatched).');
  });

  it('stays plain for an empty bibliography', () => {
    expect(formatZoteroLinkNoChanges(summaryOf({}), 'refs.bib')).toBe(
      'No new Zotero links for "refs.bib".',
    );
  });
});
