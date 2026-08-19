/**
 * Property tests for the pure Zotero-linking core.
 *
 * The three properties are the ones a user's .bib file depends on:
 *
 *   1. Byte preservation — every byte outside an inserted field line survives.
 *   2. Idempotency — running the command on its own output is a no-op.
 *   3. No fuzzy matching — descriptive metadata never produces a link.
 */
import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import {
  createZoteroLinkPlan,
  normalizeDoi,
  type ZoteroCatalogItem,
} from './zotero-link';
import { parseBibtex } from './bibtex-parser';

const GROUP_URI_BASE = 'http://zotero.org/groups/2295646/items/';

/** An 8-character Zotero item key. */
const itemKeyArb = fc
  .array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')), {
    minLength: 8,
    maxLength: 8,
  })
  .map(chars => chars.join(''));

/** A citation key: no comma, brace or whitespace, so it survives a .bib header. */
const citeKeyArb = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9_:.-]{0,15}$/)
  .filter(s => s.length > 0);

/** A DOI in the shape the normalizer accepts. */
const doiArb = fc
  .tuple(
    fc.integer({ min: 1000, max: 99999 }),
    fc.stringMatching(/^[a-z0-9.-]{1,12}$/).filter(s => s.length > 0),
  )
  .map(([registrant, suffix]) => '10.' + registrant + '/' + suffix);

/** Text safe inside a braced BibTeX field value: no braces, quotes, backslashes,
 *  percent signs or at-signs, all of which are structural to the scanner. */
const fieldTextArb = fc
  .string({ minLength: 0, maxLength: 30 })
  .map(s => s.replace(/[{}"\\%@\r\n]/g, ''));

interface GeneratedEntry {
  readonly key: string;
  readonly doi?: string;
  readonly title: string;
}

const entryArb: fc.Arbitrary<GeneratedEntry> = fc.record({
  key: citeKeyArb,
  doi: fc.option(doiArb, { nil: undefined }),
  title: fieldTextArb,
});

/** A whole .bib file with unique citation keys. */
const bibArb = fc
  .uniqueArray(entryArb, { minLength: 1, maxLength: 8, selector: e => e.key })
  .map(entries => {
    const text = entries
      .map(e => {
        const fields = ['  title = {' + e.title + '}'];
        if (e.doi) fields.push('  doi = {' + e.doi + '}');
        return '@article{' + e.key + ',\n' + fields.join(',\n') + '\n}';
      })
      .join('\n\n') + '\n';
    return { entries, text };
  });

/** Zotero items covering an arbitrary subset of the file's DOIs. */
function itemsForArb(entries: readonly GeneratedEntry[]): fc.Arbitrary<ZoteroCatalogItem[]> {
  const withDoi = entries.filter(e => e.doi);
  return fc
    .tuple(
      fc.array(fc.boolean(), { minLength: withDoi.length, maxLength: withDoi.length }),
      fc.array(itemKeyArb, { minLength: withDoi.length, maxLength: withDoi.length }),
    )
    .map(([mask, keys]) =>
      withDoi
        .map((entry, i) => ({ entry, include: mask[i], key: keys[i] }))
        .filter(x => x.include)
        .map(x => ({ key: x.key, uri: GROUP_URI_BASE + x.key, doi: x.entry.doi })),
    );
}

/** Split a .bib into the source text of each entry, so an untouched entry can
 *  be compared byte-for-byte against the plan's output. */
function entryTexts(text: string): string[] {
  return text
    .split(/\n(?=@)/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** The same entry with a comma terminating its last field — the one byte a
 *  splice is allowed to add outside the inserted lines.  Inserted at the end
 *  of the last field's text, not by rewriting the whole tail, so this compares
 *  against exactly what a correct splice produces. */
function withTerminatingComma(entryText: string): string {
  const closer = entryText.length - 1;
  const head = entryText.slice(0, closer).trimEnd();
  return head + ',' + entryText.slice(head.length);
}

describe('Property 1: byte preservation', () => {
  it('changes only the entries it links, and only by adding field lines', () => {
    fc.assert(
      fc.property(
        bibArb.chain(bib => itemsForArb(bib.entries).map(items => ({ bib, items }))),
        ({ bib, items }) => {
          const plan = createZoteroLinkPlan(bib.text, items);
          expect(plan.blocked).toBeUndefined();

          const linked = new Set(
            plan.decisions.filter(d => d.outcome === 'update').map(d => d.entry.key),
          );

          const before = entryTexts(bib.text);
          const after = entryTexts(plan.updatedText);
          expect(after.length).toBe(before.length);

          for (let i = 0; i < before.length; i++) {
            const original = before[i];
            const key = bib.entries[i].key;
            if (!linked.has(key)) {
              // Untouched entries are identical bytes.
              expect(after[i]).toBe(original);
              continue;
            }
            // A linked entry keeps every original byte in order.  The only
            // insertions are the two field lines and, if the last existing
            // field had none, a comma terminating it.
            const withoutInserted = after[i]
              .split('\n')
              .filter(line => !/^\s*zotero-(?:key|uri) = \{[^}]*\},?$/.test(line))
              .join('\n');
            expect([original, withTerminatingComma(original)]).toContain(withoutInserted);
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('leaves the file untouched when nothing matches', () => {
    fc.assert(
      fc.property(bibArb, bib => {
        const plan = createZoteroLinkPlan(bib.text, []);
        expect(plan.updatedText).toBe(bib.text);
        expect(plan.changed).toBe(false);
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('Property 2: idempotency', () => {
  it('rerunning over the plan output changes nothing further', () => {
    fc.assert(
      fc.property(
        bibArb.chain(bib => itemsForArb(bib.entries).map(items => ({ bib, items }))),
        ({ bib, items }) => {
          const first = createZoteroLinkPlan(bib.text, items);
          const second = createZoteroLinkPlan(first.updatedText, items);
          expect(second.changed).toBe(false);
          expect(second.updatedText).toBe(first.updatedText);
          // Every entry the first run linked is now recognized as already
          // linked, not relinked or reported.
          expect(second.summary.preserved).toBe(
            first.summary.preserved + first.summary.updates,
          );
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a linked entry parses back to the item it was linked to', () => {
    fc.assert(
      fc.property(
        bibArb.chain(bib => itemsForArb(bib.entries).map(items => ({ bib, items }))),
        ({ bib, items }) => {
          const plan = createZoteroLinkPlan(bib.text, items);
          const reparsed = parseBibtex(plan.updatedText);
          for (const decision of plan.decisions) {
            if (decision.outcome !== 'update') continue;
            const entry = reparsed.get(decision.entry.key)!;
            expect(entry.zoteroKey).toBe(decision.target.key);
            expect(entry.zoteroUri).toBe(decision.target.uri);
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('Property 3: no fuzzy matching', () => {
  it('identical descriptive metadata never links anything', () => {
    fc.assert(
      fc.property(
        citeKeyArb,
        fieldTextArb,
        itemKeyArb,
        fc.integer({ min: 1900, max: 2030 }),
        (key, title, itemKey, year) => {
          const bib =
            '@article{' + key + ',\n' +
            '  title = {' + title + '},\n' +
            '  author = {Doe, Jane},\n' +
            '  year = {' + year + '},\n' +
            '  journal = {Journal of Things}\n' +
            '}\n';
          // A Zotero item agreeing on every descriptive field, and on nothing
          // exact.  Its citation key is deliberately different from the entry's.
          const plan = createZoteroLinkPlan(bib, [
            { key: itemKey, uri: GROUP_URI_BASE + itemKey, title, citationKey: key + '-x' },
          ]);
          expect(plan.changed).toBe(false);
          expect(plan.summary.updates).toBe(0);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a DOI links only to the item carrying the same normalized DOI', () => {
    fc.assert(
      fc.property(doiArb, doiArb, citeKeyArb, itemKeyArb, (entryDoi, itemDoi, key, itemKey) => {
        const bib = '@article{' + key + ',\n  doi = {' + entryDoi + '}\n}\n';
        const plan = createZoteroLinkPlan(bib, [
          { key: itemKey, uri: GROUP_URI_BASE + itemKey, doi: itemDoi },
        ]);
        const shouldMatch = normalizeDoi(entryDoi) === normalizeDoi(itemDoi);
        expect(plan.summary.updates).toBe(shouldMatch ? 1 : 0);
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it('a DOI differing only in case still links', () => {
    fc.assert(
      fc.property(doiArb, citeKeyArb, itemKeyArb, (doi, key, itemKey) => {
        const bib = '@article{' + key + ',\n  doi = {' + doi.toUpperCase() + '}\n}\n';
        const plan = createZoteroLinkPlan(bib, [
          { key: itemKey, uri: GROUP_URI_BASE + itemKey, doi },
        ]);
        expect(plan.summary.updates).toBe(1);
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('Property 4: one decision per entry', () => {
  it('reports every entry exactly once, in source order', () => {
    fc.assert(
      fc.property(
        bibArb.chain(bib => itemsForArb(bib.entries).map(items => ({ bib, items }))),
        ({ bib, items }) => {
          const plan = createZoteroLinkPlan(bib.text, items);
          expect(plan.decisions.map(d => d.entry.key)).toEqual(bib.entries.map(e => e.key));
          const s = plan.summary;
          expect(s.updates + s.preserved + s.ambiguous + s.conflicts + s.unmatched).toBe(
            s.totalEntries,
          );
          expect(s.totalEntries).toBe(bib.entries.length);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});
