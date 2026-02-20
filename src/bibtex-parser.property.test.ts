import { describe, it } from 'bun:test';
import * as fc from 'fast-check';
import { parseBibtex, serializeBibtex, BibtexEntry } from './bibtex-parser';

describe('BibTeX Parser Property Tests', () => {
  /**
   * Property 1 (Fault Condition): For any string s containing no braces,
   * parsing @article{k, title = {{s}}} yields s as the stored title.
   * Validates: Requirements 2.1, 2.2, 2.3
   */
  it('Property 1: double-braced field value is stripped to plain content', () => {
    // Exclude braces (would break the double-brace structure), quotes and backslashes
    // (would confuse the fieldRegex quote-delimiter and escape branches).
    const noBraceString = fc.string({ minLength: 0, maxLength: 40 })
      .filter(s => !s.includes('{') && !s.includes('}') && !s.includes('"') && !s.includes('\\'));

    fc.assert(
      fc.property(noBraceString, (s) => {
        const bibtex = '@article{k, title = {{' + s + '}}}';
        const result = parseBibtex(bibtex);
        const stored = result.get('k')?.fields.get('title');
        if (stored !== s) {
          throw new Error('Expected "' + s + '" but got "' + stored + '"');
        }
        return true;
      }),
      { numRuns: 200 }
    );
  });

  /**
   * Property 3 (Preservation): For any string s that contains no braces, quotes, or backslashes,
   * parsing @article{k, title = {s}} yields s unchanged (single-brace path unaffected).
   * Validates: Requirements 3.1, 3.4
   */
  it('Property 3 (Preservation): single-braced field value is unchanged', () => {
    const safeSingleBraceString = fc.string({ minLength: 1, maxLength: 40 })
      .filter(s =>
        !s.includes('}') && !s.includes('"') && !s.includes('{') && !s.includes('\\')
      );

    fc.assert(
      fc.property(safeSingleBraceString, (s) => {
        const bibtex = '@article{k, title = {' + s + '}}';
        const result = parseBibtex(bibtex);
        const stored = result.get('k')?.fields.get('title');
        if (stored !== s) {
          throw new Error('Expected "' + s + '" but got "' + stored + '"');
        }
        return true;
      }),
      { numRuns: 200 }
    );
  });

  it('Property 2: BibTeX parser round-trip', () => {
    const bibtexEntryArb = fc.record({
      type: fc.constantFrom('article', 'book', 'misc', 'inproceedings'),
      key: fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
      fields: fc.dictionary(
        fc.constantFrom('title', 'author', 'journal', 'year', 'volume', 'pages', 'doi'),
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => 
          !s.includes('}') && !s.includes('"') && !s.includes('{') && !s.includes('\\')
        ),
        { minKeys: 1, maxKeys: 5 }
      ).map(obj => new Map(Object.entries(obj))),
      zoteroKey: fc.option(fc.string({ minLength: 1, maxLength: 10 }).filter(s => 
        !s.includes('}') && !s.includes('"') && !s.includes('{') && !s.includes('\\')
      )),
      zoteroUri: fc.option(fc.string({ minLength: 1, maxLength: 30 }).filter(s => 
        !s.includes('}') && !s.includes('"') && !s.includes('{') && !s.includes('\\')
      ))
    }).map(entry => {
      // Ensure zotero fields are consistent between properties and fields map
      if (entry.zoteroKey) {
        entry.fields.set('zotero-key', entry.zoteroKey);
      }
      if (entry.zoteroUri) {
        entry.fields.set('zotero-uri', entry.zoteroUri);
      }
      
      // Update the properties to match what's actually in the fields
      const actualZoteroKey = entry.fields.get('zotero-key');
      const actualZoteroUri = entry.fields.get('zotero-uri');
      
      return {
        ...entry,
        zoteroKey: actualZoteroKey,
        zoteroUri: actualZoteroUri
      };
    });

    const entriesMapArb = fc.array(bibtexEntryArb, { minLength: 1, maxLength: 3 })
      .map(entries => {
        const map = new Map<string, BibtexEntry>();
        entries.forEach(entry => map.set(entry.key, entry));
        return map;
      });

    fc.assert(
      fc.property(entriesMapArb, (originalEntries) => {
        // Serialize the entries to BibTeX
        const serialized = serializeBibtex(originalEntries);
        
        // Parse the serialized BibTeX back
        const reparsed = parseBibtex(serialized);
        
        // Check that all original entries are preserved
        for (const [key, originalEntry] of originalEntries) {
          const reparsedEntry = reparsed.get(key);
          
          if (!reparsedEntry) {
            throw new Error('Entry missing after round-trip: ' + key);
          }
          
          // Check basic properties
          if (reparsedEntry.type !== originalEntry.type) {
            throw new Error('Type mismatch for ' + key + ': ' + reparsedEntry.type + ' vs ' + originalEntry.type);
          }
          
          if (reparsedEntry.key !== originalEntry.key) {
            throw new Error('Key mismatch: ' + reparsedEntry.key + ' vs ' + originalEntry.key);
          }
          
          // Check all fields are preserved
          for (const [fieldName, fieldValue] of originalEntry.fields) {
            const reparsedValue = reparsedEntry.fields.get(fieldName);
            
            if (reparsedValue !== fieldValue) {
              throw new Error('Field value mismatch for ' + key + '.' + fieldName + ': "' + reparsedValue + '" vs "' + fieldValue + '"');
            }
          }
          
          // Check zotero fields
          if (originalEntry.zoteroKey !== reparsedEntry.zoteroKey) {
            throw new Error('Zotero key mismatch for ' + key + ': "' + reparsedEntry.zoteroKey + '" vs "' + originalEntry.zoteroKey + '"');
          }
          
          if (originalEntry.zoteroUri !== reparsedEntry.zoteroUri) {
            throw new Error('Zotero URI mismatch for ' + key + ': "' + reparsedEntry.zoteroUri + '" vs "' + originalEntry.zoteroUri + '"');
          }
        }
        
        return true;
      }),
      { 
        numRuns: 100,
        verbose: true
      }
    );
  }, { timeout: 10000 });
});