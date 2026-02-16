import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { generateCitation } from './md-to-docx-citations';
import { BibtexEntry } from './bibtex-parser';

describe('Property Tests: citation field code reconstruction', () => {
  it('Property 10: Citations with Zotero metadata produce valid field codes', () => {
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
          
          const result = generateCitation(run, entries);
          
          // Property: Output contains ZOTERO_ITEM CSL_CITATION
          expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
          
          // Property: citationItems contain correct URIs
          expect(result.xml).toContain(zoteroKey);
          
          // Property: Locators are included when present
          if (hasLocator) {
            expect(result.xml).toContain('&quot;locator&quot;:&quot;20&quot;');
          }
          
          return true;
        }
      ),
      { numRuns: 20 }
    );
  });

  it('Property 11: Citations without Zotero metadata produce field codes with itemData', () => {
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

          const result = generateCitation(run, entries);

          // Property: Output contains field code, not plain text
          expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');

          // Property: itemData is present
          expect(result.xml).toContain('itemData');

          // Property: No uris field for non-Zotero entries
          expect(result.xml).not.toContain('uris');

          // Property: Locators are included when present
          if (hasLocator) {
            expect(result.xml).toContain('&quot;locator&quot;:&quot;20&quot;');
          }

          return true;
        }
      ),
      { numRuns: 20 }
    );
  });
});