import { describe, it, expect } from 'bun:test';
import { createZoteroSyncPlan, zoteroSyncKeys } from './zotero-sync';
import { createZoteroLinkPlan, type ZoteroLinkDecision } from './zotero-link';
import { zoteroItem } from './zotero-link.fixtures';

/** Plan links against a catalog, then sync against the exports — the same
 *  two-step pipeline the command runs. */
function sync(
  bib: string,
  catalog: Parameters<typeof createZoteroLinkPlan>[1],
  bibtexByKey: Record<string, string>,
) {
  const link = createZoteroLinkPlan(bib, catalog);
  expect(link.blocked).toBeUndefined();
  return createZoteroSyncPlan(bib, link.decisions, new Map(Object.entries(bibtexByKey)));
}

const zoteroExport = (fields: string, type = 'article') =>
  '\n@' + type + '{smith_title_2020,\n\t' + fields + '\n}\n';

describe('createZoteroSyncPlan', () => {
  const catalog = [zoteroItem('AAAAAAAA', { doi: '10.1/x', title: 'T' })];

  it('rewrites a changed field value in place, layout untouched', () => {
    const bib = '@article{a,\n  title = {Old Title},\n  doi = {10.1/x},\n}\n';
    const plan = sync(bib, catalog, {
      AAAAAAAA: zoteroExport('title = {New Title},\n\tdoi = {10.1/x},'),
    });
    expect(plan.changed).toBe(true);
    expect(plan.updatedText).toContain('  title = {New Title},');
    // The DOI matched, so its bytes are untouched.
    expect(plan.updatedText).toContain('  doi = {10.1/x},');
    expect(plan.summary.metadataFields).toBe(1);
    expect(plan.metadata[0].changes).toEqual([
      { kind: 'update', name: 'title', from: 'Old Title', to: 'New Title' },
    ]);
  });

  it('adds fields Zotero has that the entry lacks', () => {
    const bib = '@article{a,\n  doi = {10.1/x},\n}\n';
    const plan = sync(bib, catalog, {
      AAAAAAAA: zoteroExport('doi = {10.1/x},\n\tvolume = {12},\n\tpages = {1--10},'),
    });
    expect(plan.updatedText).toContain('  volume = {12},');
    expect(plan.updatedText).toContain('  pages = {1--10},');
    expect(plan.metadata[0].changes.map(c => c.kind)).toEqual(['add', 'add']);
  });

  it('preserves fields only the .bib has', () => {
    // The translator omits many fields Zotero stores, so absence from the
    // export is not evidence of deletion.
    const bib = '@article{a,\n  doi = {10.1/x},\n  note = {mine},\n  custom = {kept},\n}\n';
    const plan = sync(bib, catalog, { AAAAAAAA: zoteroExport('doi = {10.1/x},') });
    expect(plan.updatedText).toContain('note = {mine}');
    expect(plan.updatedText).toContain('custom = {kept}');
  });

  it('is idempotent: syncing the synced text plans no changes', () => {
    const bib = '@article{a,\n  title = {Old},\n  doi = {10.1/x},\n}\n';
    const exports = {
      AAAAAAAA: zoteroExport('title = {New},\n\tdoi = {10.1/x},\n\tvolume = {3},'),
    };
    const first = sync(bib, catalog, exports);
    expect(first.changed).toBe(true);
    const second = sync(first.updatedText, catalog, exports);
    expect(second.changed).toBe(false);
    expect(second.summary.metadataFields).toBe(0);
  });

  it('updates the entry type when Zotero changed it', () => {
    const bib = '@misc{a,\n  doi = {10.1/x},\n}\n';
    const plan = sync(bib, catalog, { AAAAAAAA: zoteroExport('doi = {10.1/x},', 'article') });
    expect(plan.updatedText).toContain('@article{a,');
    expect(plan.metadata[0].changes).toContainEqual({
      kind: 'type',
      from: 'misc',
      to: 'article',
    });
  });

  it('applies metadata to preserved (already linked) entries too', () => {
    // The whole point of a second run: pull in edits made in Zotero since.
    const bib =
      '@article{a,\n  title = {Old},\n  zotero-key = {AAAAAAAA},\n' +
      '  zotero-uri = {http://zotero.org/groups/2295646/items/AAAAAAAA},\n}\n';
    const plan = sync(bib, catalog, { AAAAAAAA: zoteroExport('title = {New},') });
    expect(plan.decisions[0].outcome).toBe('preserve');
    expect(plan.updatedText).toContain('title = {New}');
    // The identity fields themselves are the link planner's; sync never
    // rewrites them.
    expect(plan.updatedText).toContain('zotero-key = {AAAAAAAA}');
  });

  it('never writes file, zotero-key, or zotero-uri from the export', () => {
    const bib = '@article{a,\n  doi = {10.1/x},\n}\n';
    const plan = sync(bib, catalog, {
      AAAAAAAA: zoteroExport(
        'doi = {10.1/x},\n\tfile = {PDF:/Users/someone/Zotero/x.pdf:application/pdf},',
      ),
    });
    expect(plan.updatedText).not.toContain('file =');
  });

  it('updates abstract and keywords in place but never adds them', () => {
    const withAbstract = '@article{a,\n  doi = {10.1/x},\n  abstract = {old words},\n}\n';
    const exports = {
      AAAAAAAA: zoteroExport('doi = {10.1/x},\n\tabstract = {new words},\n\tkeywords = {k1, k2},'),
    };
    const updated = sync(withAbstract, catalog, exports);
    expect(updated.updatedText).toContain('abstract = {new words}');
    expect(updated.updatedText).not.toContain('keywords');

    const without = '@article{a,\n  doi = {10.1/x},\n}\n';
    const untouched = sync(without, catalog, exports);
    expect(untouched.updatedText).not.toContain('abstract');
    expect(untouched.updatedText).not.toContain('keywords');
  });

  it('skips a field Zotero writes as a bare macro reference', () => {
    const bib = '@article{a,\n  doi = {10.1/x},\n}\n';
    const plan = sync(bib, catalog, {
      AAAAAAAA: zoteroExport('doi = {10.1/x},\n\tmonth = aug,\n\tyear = {2020},'),
    });
    expect(plan.updatedText).not.toContain('month');
    expect(plan.updatedText).toContain('year = {2020}');
    expect(plan.metadata[0].skipped).toContainEqual({ name: 'month', reason: 'macro-value' });
  });

  it('skips a field the .bib writes twice with the same value', () => {
    // Two same-value titles pass the link planner's contradiction check but
    // still leave "the" slice to replace ambiguous.
    const bib = '@article{a,\n  title = {T},\n  title = {T},\n  doi = {10.1/x},\n}\n';
    const plan = sync(bib, catalog, {
      AAAAAAAA: zoteroExport('title = {New},\n\tdoi = {10.1/x},'),
    });
    expect(plan.updatedText).toContain('title = {T},\n  title = {T},');
    expect(plan.metadata[0].skipped).toContainEqual({ name: 'title', reason: 'repeated-field' });
  });

  it('treats whitespace-only value differences as equal', () => {
    const bib = '@article{a,\n  title = {A Long\n    Wrapped Title},\n  doi = {10.1/x},\n}\n';
    const plan = sync(bib, catalog, {
      AAAAAAAA: zoteroExport('title = {A Long Wrapped Title},\n\tdoi = {10.1/x},'),
    });
    // The identity fields are still added (fresh match), but the wrapped
    // title is not a metadata difference.
    expect(plan.summary.metadataFields).toBe(0);
    expect(plan.updatedText).toContain('title = {A Long\n    Wrapped Title}');
  });

  it('degrades to identity-only when the export is missing or unusable', () => {
    const bib = '@article{a,\n  title = {Old},\n  doi = {10.1/x},\n}\n';
    for (const exports of [{}, { AAAAAAAA: '\n\n' }, { AAAAAAAA: '@article{broken' }]) {
      const plan = sync(bib, catalog, exports);
      // The link fields still land; the metadata is untouched.
      expect(plan.updatedText).toContain('zotero-key = {AAAAAAAA}');
      expect(plan.updatedText).toContain('title = {Old}');
      expect(plan.metadata[0].unavailable).toBe(true);
      expect(plan.summary.metadataUnavailable).toBe(1);
    }
  });

  it('leaves ambiguous, conflicted and unmatched entries byte-identical', () => {
    const twin = [zoteroItem('AAAAAAAA', { doi: '10.1/x' }), zoteroItem('BBBBBBBB', { doi: '10.1/x' })];
    const bib =
      '@article{amb,\n  title = {Old},\n  doi = {10.1/x},\n}\n\n' +
      '@article{un,\n  title = {Old},\n}\n';
    const plan = sync(bib, twin, {
      AAAAAAAA: zoteroExport('title = {New},'),
      BBBBBBBB: zoteroExport('title = {New},'),
    });
    expect(plan.changed).toBe(false);
    expect(plan.updatedText).toBe(bib);
  });

  it('uses CRLF for added fields in a CRLF entry', () => {
    const bib = '@article{a,\r\n  doi = {10.1/x},\r\n}\r\n';
    const plan = sync(bib, catalog, {
      AAAAAAAA: zoteroExport('doi = {10.1/x},\n\tvolume = {5},'),
    });
    expect(plan.updatedText).toContain('  volume = {5},\r\n');
    expect(plan.updatedText).not.toMatch(/(?<!\r)\n/);
  });

  it('reports the link summary alongside the metadata counts', () => {
    const bib = '@article{a,\n  title = {Old},\n  doi = {10.1/x},\n}\n';
    const plan = sync(bib, catalog, { AAAAAAAA: zoteroExport('title = {New},') });
    expect(plan.summary.link.updates).toBe(1);
    expect(plan.summary.metadataEntries).toBe(1);
    expect(plan.summary.metadataFields).toBe(1);
  });
});

describe('zoteroSyncKeys', () => {
  it('collects target keys from update and preserve decisions, deduplicated', () => {
    const entry = { key: 'k', start: 0, end: 1, keyStart: 0, keyEnd: 1, trusted: true };
    const target = { key: 'AAAAAAAA', uri: 'http://zotero.org/groups/1/items/AAAAAAAA' };
    const decisions: ZoteroLinkDecision[] = [
      { outcome: 'update', entry, tier: 'doi', evidence: ['doi'], target, additions: [] },
      { outcome: 'preserve', entry, target },
      { outcome: 'unmatched', entry, reason: 'no-identifiers' },
    ];
    expect(zoteroSyncKeys(decisions)).toEqual(['AAAAAAAA']);
  });
});
