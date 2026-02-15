import { describe, it } from 'bun:test';
import * as fc from 'fast-check';
import { parseBibtex, serializeBibtex, BibtexEntry } from './bibtex-parser';

describe('BibTeX Parser Property Tests', () => {
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