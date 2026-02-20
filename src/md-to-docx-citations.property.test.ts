import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { generateCitation } from './md-to-docx-citations';
import { BibtexEntry } from './bibtex-parser';

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