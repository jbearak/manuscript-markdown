import { describe, it } from 'bun:test';
import * as fc from 'fast-check';
import { parseBibtex, serializeBibtex, readBibtexFields, quotedValueEnds, BibtexEntry } from './bibtex-parser';

describe('BibTeX Parser Property Tests', () => {
  // A field's whitespace as BibTeX reads it: a run of it one space, and
  // none at either end
  const asBibtexReadsIt = (s: string) => s.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ | $/g, '');

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
        const expected = asBibtexReadsIt(s).normalize('NFC');
        if (stored !== expected) {
          throw new Error('Expected "' + expected + '" but got "' + stored + '"');
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
        const expected = asBibtexReadsIt(s).normalize('NFC');
        if (stored !== expected) {
          throw new Error('Expected "' + expected + '" but got "' + stored + '"');
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
      ).map(obj => new Map(Object.entries(obj).map(([fieldName, value]) => [
        fieldName,
        fieldName === 'doi' ? value : asBibtexReadsIt(value).normalize('NFC'),
      ]))),
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
describe('BibTeX field reader parity', () => {
  // The regex the field reader replaced, which read braces only so deep
  const fieldRegex = /(\w+(?:-\w+)*)\s*=\s*(?:\{((?:[^{}]|\{(?:[^{}]|\{[^}]*\})*\})*)\}|"((?:\\.|[^"\\])*)"|(\w+))/g;
  const byRegex = (body: string) => [...body.matchAll(fieldRegex)].map(([, name, braced, quoted, bare]) =>
    ({ name, value: braced ?? quoted ?? bare, braced: braced !== undefined }));
  // Its deepest braces, every one counted, as the regex counts them
  const depth = (body: string) => {
    let at = 0;
    let most = 0;
    for (const c of body) {
      if (c === '{') most = Math.max(most, ++at);
      else if (c === '}') at = Math.max(0, at - 1);
    }
    return most;
  };

  // Where it ended a quoted value otherwise than BibTeX: at a " in a group,
  // which a " at any depth of braces may be, and at none after a backslash
  // before a line end
  const quotesAsBibtex = (body: string) => {
    let at = 0;
    for (const c of body) {
      if (c === '{') at++;
      else if (c === '}') at = Math.max(0, at - 1);
      else if (c === '"' && at > 0) return false;
    }
    return !/\\[\n\r\u2028\u2029]/.test(body);
  };

  /**
   * A body of fields, and anything else, reads as the regex read it, where
   * its braces nest no deeper than the regex read them: three levels, with
   * a field's own; and where the regex ended a quoted value where BibTeX
   * does (quotesAsBibtex).
   */
  it('reads an entry body as the regex did, where its braces nest as deep as the regex read them', () => {
    const atom = fc.constantFrom('title', 'year', 'a-b', 'x1', '-', ' = ', '=', ' ', '\n', ',', '{', '}', '{a}', '{a {b}}', '"', '\\"', '\\', '\\\\',
      '\\\n', '\\{', '\\}', 'a b', '2020', '@', '%', '\u00A0', '\u2028');
    fc.assert(
      fc.property(fc.array(atom, { maxLength: 30 }).map(atoms => atoms.join('')), body => {
        fc.pre(depth(body) <= 3 && quotesAsBibtex(body));
        const read = readBibtexFields(body);
        const expected = byRegex(body);
        if (JSON.stringify(read) !== JSON.stringify(expected)) throw new Error(JSON.stringify(body) + ' read as ' + JSON.stringify(read) + ', not ' + JSON.stringify(expected));
        return true;
      }),
      { numRuns: 5000 }
    );
  });

  /**
   * Where each " ends the quoted value it opens, read at once for the text,
   * is where a scan from it ends it: at the next " outside the value's
   * groups that no odd run of backslashes escapes, with a } at depth 0
   * taking none off.
   */
  it('ends the value each " opens where a scan from it ends it', () => {
    const scanFrom = (text: string, open: number) => {
      let depth = 0;
      let backslashes = 0;
      for (let i = open + 1; i < text.length; i++) {
        const c = text[i];
        if (c === '"' && depth === 0 && backslashes % 2 === 0) return i;
        if (c === '{') depth++;
        else if (c === '}' && depth > 0) depth--;
        backslashes = c === '\\' ? backslashes + 1 : 0;
      }
      return -1;
    };
    const atom = fc.constantFrom('"', '"', '{', '}', '\\', 'a', ' ', '{"}', '\\"', '}}', '{{');
    fc.assert(
      fc.property(fc.array(atom, { maxLength: 40 }).map(atoms => atoms.join('')), text => {
        const ends = quotedValueEnds(text);
        for (let i = 0; i < text.length; i++) {
          const expected = text[i] === '"' ? scanFrom(text, i) : -1;
          if (ends[i] !== expected) throw new Error(JSON.stringify(text) + ' ends the " at ' + i + ' at ' + ends[i] + ', not ' + expected);
        }
        return true;
      }),
      { numRuns: 5000 }
    );
  });
});
