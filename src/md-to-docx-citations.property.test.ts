import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { buildItemData, generateCitation } from './md-to-docx-citations';
import { BibtexEntry, parseBibtex } from './bibtex-parser';

describe('Property Tests: citation field code reconstruction', () => {
  it('Property 10: Citations with Zotero metadata produce valid field codes', () => {
    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    fc.assert(
      fc.property(
        fc.record({
          key: fc.constantFrom('smith2020', 'doe2021', 'test123'),
          author: fc.constantFrom('Smith, John', 'Doe, Jane', 'Test, Author'),
          year: fc.constantFrom(2020, 2021, 2022),
          zoteroKey: fc.constantFrom('ABCD1234', 'EFGH5678', 'IJKL9012'),
          hasLocator: fc.boolean()
        }),
        ({ key, author, year, zoteroKey, hasLocator }) => {
          const entries = new Map<string, BibtexEntry>();
          entries.set(key, {
            type: 'article',
            key,
            fields: new Map([
              ['author', author],
              ['year', String(year)]
            ]),
            zoteroKey,
            zoteroUri: `http://zotero.org/users/123/items/${zoteroKey}`
          });

          const locators = hasLocator ? new Map([[key, 'p. 20']]) : undefined;
          const run = { keys: [key], locators, text: key };

          const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

          // Property: Output contains ZOTERO_ITEM CSL_CITATION
          expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');

          // Property: citationItems contain correct URIs
          expect(result.xml).toContain(zoteroKey);

          // Property: Locators are included when present
          if (hasLocator) {
            expect(result.xml).toContain('&quot;locator&quot;:&quot;20&quot;');
          }

          // Structural: JSON has correct key order and required fields
          const m = result.xml.match(/CSL_CITATION (.+?) <\/w:instrText>/);
          if (m) {
            const decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            const csl = JSON.parse(decoded);
            expect(Object.keys(csl)).toEqual(['citationID', 'properties', 'citationItems', 'schema']);
            expect(csl.citationID).toMatch(/^[a-z0-9]{8}$/);
            expect(csl.properties.formattedCitation).toBeDefined();
            expect(csl.citationItems[0].id).toBe(csl.citationItems[0].itemData.id);
          }

          return true;
        }
      ),
      { numRuns: 20 }
    );
  });

  it('Property 11: Citations without Zotero metadata produce field codes with itemData', () => {
    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    fc.assert(
      fc.property(
        fc.record({
          key: fc.constantFrom('smith2020', 'doe2021', 'test123'),
          author: fc.constantFrom('Smith, John', 'Doe, Jane', 'Test, Author'),
          year: fc.constantFrom(2020, 2021, 2022),
          hasLocator: fc.boolean()
        }),
        ({ key, author, year, hasLocator }) => {
          const entries = new Map<string, BibtexEntry>();
          entries.set(key, {
            type: 'article',
            key,
            fields: new Map([
              ['author', author],
              ['year', String(year)]
            ])
            // No zoteroKey or zoteroUri
          });

          const locators = hasLocator ? new Map([[key, 'p. 20']]) : undefined;
          const run = { keys: [key], locators, text: key };

          const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

          // Property: Output contains field code, not plain text
          expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');

          // Property: itemData is present
          expect(result.xml).toContain('itemData');

          // Property: Non-Zotero entries get synthetic uris for Zotero compatibility
          expect(result.xml).toContain('http://zotero.org/users/local/embedded/items/' + key);

          // Property: Locators are included when present
          if (hasLocator) {
            expect(result.xml).toContain('&quot;locator&quot;:&quot;20&quot;');
          }

          // Structural: schema URL present
          const m = result.xml.match(/CSL_CITATION (.+?) <\/w:instrText>/);
          if (m) {
            const decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            const csl = JSON.parse(decoded);
            expect(csl.schema).toBe('https://github.com/citation-style-language/schema/raw/master/csl-citation.json');
          }

          return true;
        }
      ),
      { numRuns: 20 }
    );
  });
});

describe('Property Tests: BibTeX names with groups', () => {
  /**
   * A name of words, groups of words, spaces and commas splits as BibTeX
   * splits it, only outside its groups: none of its parts in citeproc's
   * data holds a group's brace, and together they hold each of its
   * characters but its spaces, braces and commas, once, in any order.
   */
  it('splits a name only outside its groups, losing no text', () => {
    const atom = fc.constantFrom('John', 'Ann', 'van', 'Smith-Jones', 'al-Hassan', '{van Beethoven}', '{Mary Ann}', '{Smith, Jones}', '{x}', '{a {b} c}', ' ', ', ');
    fc.assert(
      fc.property(fc.array(atom, { minLength: 1, maxLength: 8 }).map(atoms => atoms.join('')), author => {
        const entry = parseBibtex('@book{b,\n  author = {' + author + '}\n}').get('b');
        // A name of more than three parts loses the rest, as pandoc reads it
        // (see bibtexNameParts in md-to-docx-citations.ts)
        let depth = 0;
        let commas = 0;
        for (const char of author) {
          if (char === '{') depth++;
          else if (char === '}') depth = Math.max(0, depth - 1);
          else if (char === ',' && depth === 0) commas++;
        }
        fc.pre(entry !== undefined && /[^ ,{}]/.test(author) && commas <= 2);
        const cited = (buildItemData(entry!).author ?? []) as Array<Record<string, string | undefined>>;
        const failure = JSON.stringify(author) + ' read as ' + JSON.stringify(cited);
        const text = (value: string) => [...value.replace(/[\s{},]/g, '')].sort().join('');
        const person = (name: Record<string, string | undefined>) => ['given', 'dropping-particle', 'family', 'suffix'].map(key => name[key] ?? '').join('');
        const parts = cited.map(name => name.literal ?? person(name)).join('');
        if (cited.some(name => name.literal === undefined && /[{}]/.test(person(name)))) throw new Error(failure);
        if (text(parts) !== text(author)) throw new Error(failure);
        return true;
      }),
      { numRuns: 1000 }
    );
  });
});
