import { describe, it } from 'bun:test';
import * as fc from 'fast-check';
import { generateCitation } from './md-to-docx-citations';
import type { BibtexEntry } from './bibtex-parser';

/**
 * Validates: Requirements 1.1, 2.1
 *
 * Property 1: Fault Condition — Non-Zotero Entries Receive Citation Key String IDs
 *
 * For any BibtexEntry where zoteroKey is undefined and zoteroUri is undefined,
 * buildCitationFieldCode (via generateCitation) SHALL assign the citation key
 * string as the id to both citationItem.id and citationItem.itemData.id.
 * Since Zotero uses numeric IDs internally, a string ID cannot match any
 * library item, causing Zotero to fall back to embedded itemData.
 */

/** Extract the CSL_CITATION JSON object from the OOXML field code string. */
function extractCslCitation(xml: string): any {
  const marker = 'ADDIN ZOTERO_ITEM CSL_CITATION ';
  const start = xml.indexOf(marker);
  if (start === -1) throw new Error('CSL_CITATION marker not found in XML');
  const jsonStart = start + marker.length;
  // The JSON ends at the closing " </w:instrText>" (with a leading space)
  const jsonEnd = xml.indexOf(' </w:instrText>', jsonStart);
  if (jsonEnd === -1) throw new Error('instrText closing tag not found');
  let raw = xml.slice(jsonStart, jsonEnd);
  // Unescape XML entities that escapeXml() may have introduced
  raw = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  return JSON.parse(raw);
}

/** Generator for a simple alphanumeric citation key. */
const citationKeyArb = fc.string({ minLength: 1, maxLength: 12 })
  .filter(s => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

/** Generator for a BibTeX type. */
const bibtexTypeArb = fc.constantFrom('article', 'book', 'inproceedings', 'misc', 'phdthesis');

/** Generator for a non-Zotero BibtexEntry (no zotero-key / zotero-uri). */
const nonZoteroEntryArb = fc.record({
  key: citationKeyArb,
  type: bibtexTypeArb,
  title: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
  author: fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z\s]+$/.test(s) && s.trim().length > 0),
}).map(({ key, type, title, author }): BibtexEntry => {
  const fields = new Map<string, string>();
  fields.set('title', title);
  fields.set('author', author);
  return { key, type, fields };
  // zoteroKey and zoteroUri are intentionally omitted (undefined)
});

describe('Zotero citation ID — fault condition exploration', () => {
  it('Property 1: Non-Zotero entries receive citation key string as id', () => {
    fc.assert(
      fc.property(nonZoteroEntryArb, (entry) => {
        const entries = new Map<string, BibtexEntry>();
        entries.set(entry.key, entry);

        const itemIdMap = new Map<string, string | number>();
        const result = generateCitation(
          { keys: [entry.key], text: entry.key },
          entries,
          undefined, // no citeproc engine
          undefined, // no usedCitationIds
          itemIdMap
        );

        const csl = extractCslCitation(result.xml);
        const citationItem = csl.citationItems[0];

        // The id must be a string equal to the citation key
        if (typeof citationItem.id !== 'string' || citationItem.id !== entry.key) {
          return false;
        }
        // itemData.id must match citationItem.id
        if (citationItem.itemData.id !== citationItem.id) {
          return false;
        }
        // Must have synthetic uris so Zotero falls back to embedded itemData
        if (!Array.isArray(citationItem.uris) || citationItem.uris.length !== 1) {
          return false;
        }
        if (citationItem.uris[0] !== 'http://zotero.org/users/local/embedded/items/' + entry.key) {
          return false;
        }
        return true;
      }),
      { numRuns: 100 }
    );
  });
});

import { expect } from 'bun:test';

/**
 * Generator for a Zotero-linked BibtexEntry (has zotero-key and zotero-uri).
 * Uses short bounded strings to avoid timeouts per AGENTS.md guidance.
 */
const zoteroEntryArb = fc.record({
  key: citationKeyArb,
  type: bibtexTypeArb,
  title: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
  author: fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[a-zA-Z\s]+$/.test(s) && s.trim().length > 0),
  zoteroKey: fc.string({ minLength: 4, maxLength: 8 }).filter(s => /^[A-Z0-9]+$/.test(s)),
}).map(({ key, type, title, author, zoteroKey }): BibtexEntry => {
  const fields = new Map<string, string>();
  fields.set('title', title);
  fields.set('author', author);
  fields.set('zotero-key', zoteroKey);
  fields.set('zotero-uri', 'http://zotero.org/users/0/items/' + zoteroKey);
  return {
    key,
    type,
    fields,
    zoteroKey,
    zoteroUri: 'http://zotero.org/users/0/items/' + zoteroKey,
  };
});

/**
 * Validates: Requirements 3.1, 3.2, 3.3
 *
 * Property 2: Preservation — Zotero-Linked Entries and Stable Mapping Unchanged
 *
 * These tests observe behaviour on UNFIXED code and must PASS, confirming that
 * Zotero-linked entries produce uris arrays, stable mapping is maintained, and
 * grouped citations with both Zotero and non-Zotero entries produce a single
 * field code with all entries.
 */
describe('Zotero citation ID — preservation', () => {
  it('Property 2a: Zotero-linked entries produce uris array containing the entry zoteroUri', () => {
    fc.assert(
      fc.property(zoteroEntryArb, (entry) => {
        const entries = new Map<string, BibtexEntry>();
        entries.set(entry.key, entry);

        const itemIdMap = new Map<string, string | number>();
        const result = generateCitation(
          { keys: [entry.key], text: entry.key },
          entries,
          undefined,
          undefined,
          itemIdMap
        );

        const csl = extractCslCitation(result.xml);
        const citationItem = csl.citationItems[0];

        // Zotero-linked entries must have a uris array with the entry's zoteroUri
        expect(citationItem.uris).toBeDefined();
        expect(citationItem.uris).toContain(entry.zoteroUri);

        // The numeric id must be stable (stored in itemIdMap)
        expect(typeof citationItem.id).toBe('number');
        expect(itemIdMap.get(entry.key)).toBe(citationItem.id);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 2b: Same citation key called twice with same itemIdMap produces the same id', () => {
    fc.assert(
      fc.property(nonZoteroEntryArb, (entry) => {
        const entries = new Map<string, BibtexEntry>();
        entries.set(entry.key, entry);

        const itemIdMap = new Map<string, string | number>();

        // First call
        const result1 = generateCitation(
          { keys: [entry.key], text: entry.key },
          entries,
          undefined,
          undefined,
          itemIdMap
        );
        const csl1 = extractCslCitation(result1.xml);
        const id1 = csl1.citationItems[0].id;

        // Second call with the same itemIdMap
        const result2 = generateCitation(
          { keys: [entry.key], text: entry.key },
          entries,
          undefined,
          undefined,
          itemIdMap
        );
        const csl2 = extractCslCitation(result2.xml);
        const id2 = csl2.citationItems[0].id;

        // Both calls must produce the same id
        expect(id1).toBe(id2);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 2c: Grouped citation with Zotero and non-Zotero entries produces single field code with all entries', () => {
    fc.assert(
      fc.property(
        zoteroEntryArb,
        nonZoteroEntryArb.filter(e => e.key.length > 0),
        (zotEntry, nonZotEntry) => {
          // Ensure distinct keys
          fc.pre(zotEntry.key !== nonZotEntry.key);

          const entries = new Map<string, BibtexEntry>();
          entries.set(zotEntry.key, zotEntry);
          entries.set(nonZotEntry.key, nonZotEntry);

          const itemIdMap = new Map<string, string | number>();
          const result = generateCitation(
            { keys: [zotEntry.key, nonZotEntry.key], text: zotEntry.key + '; ' + nonZotEntry.key },
            entries,
            undefined,
            undefined,
            itemIdMap
          );

          const csl = extractCslCitation(result.xml);

          // Must have exactly 2 citation items in a single field code
          expect(csl.citationItems).toHaveLength(2);

          // Find the Zotero and non-Zotero items by URI pattern
          const zotItem = csl.citationItems.find((ci: any) =>
            ci.uris && ci.uris.some((u: string) => u.includes('/users/0/items/'))
          );
          const nonZotItem = csl.citationItems.find((ci: any) =>
            ci.uris && ci.uris.some((u: string) => u.includes('/local/embedded/items/'))
          );

          // Zotero entry must have real uris
          expect(zotItem).toBeDefined();
          expect(zotItem.uris).toContain(zotEntry.zoteroUri);

          // Non-Zotero entry must have a string id and synthetic uris
          expect(nonZotItem).toBeDefined();
          expect(typeof nonZotItem.id).toBe('string');
          expect(nonZotItem.uris[0]).toBe('http://zotero.org/users/local/embedded/items/' + nonZotEntry.key);
        }
      ),
      { numRuns: 50 }
    );
  });
});
