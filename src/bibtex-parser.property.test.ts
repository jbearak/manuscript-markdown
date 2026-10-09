import { describe, it } from 'bun:test';
import * as fc from 'fast-check';
import { parseBibtex, parseBibtexWithRaw, serializeBibtex, readBibtexFields, quotedValueEnds, readEntryEnds, scanBibtexEntryBody, extractRawField, mergeBibtex, BibtexEntry } from './bibtex-parser';

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
  // The regex the field reader replaced, which read braces only so deep,
  // with names and bare values as BibTeX reads them: each run of an
  // identifier's characters whole, and none that starts with a digit for a
  // name, though its value is read past, and a number's digits; with a
  // space other than ASCII's a space, as \s is
  const identifier = '[^\\s\\x00-\\x1f"#%\'(),={}]';
  const fieldRegex = new RegExp('((?<!' + identifier + ')' + identifier + '+)\\s*=\\s*(?:\\{((?:[^{}]|\\{(?:[^{}]|\\{[^}]*\\})*\\})*)\\}|"((?:\\\\.|[^"\\\\])*)"|([0-9]+|' + identifier + '+))', 'g');
  const byRegex = (body: string) => [...body.matchAll(fieldRegex)].filter(([, name]) => !/^[0-9]/.test(name)).map(([, name, braced, quoted, bare]) =>
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
      '\\\n', '\\{', '\\}', 'a b', '2020', '@', '%', '\u00A0', '\u2028', ':', '\u00E9');
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

  /**
   * Where an entry ends, as the tables read for all entries at once find it,
   * after one doesn't end, is where a scan from its start ends it, as the
   * parser reads each until then: for a body, at the }, or the ) of a paren
   * entry, at its level, past groups and quoted values there, and in a paren
   * entry, pairs of parens, where " is text; and for a comment, at the
   * delimiter that pairs with its opening one.
   */
  it('ends each entry in the tables where a scan from its start ends it', () => {
    const atom = fc.constantFrom('{', '}', '(', ')', '"', '"', '\\', '\\"', '\\{', 'a', ' ', '\n', '{"}', '(a)', '{a}', '"a"', '@a{k,');
    fc.assert(
      fc.property(fc.array(atom, { maxLength: 40, size: 'max' }).map(atoms => atoms.join('')), input => {
        const tables = readEntryEnds(input, false);
        for (let at = 0; at <= input.length; at++) {
          for (const closer of ['}', ')'] as const) {
            const scanned = readEntryEnds(input).body(at, closer);
            if (tables.body(at, closer) !== scanned) throw new Error(JSON.stringify(input) + ' ends the body at ' + at + ' to ' + closer + ' at ' + tables.body(at, closer) + ', not ' + scanned);
            if (input[at] !== (closer === ')' ? '(' : '{')) continue;
            const comment = readEntryEnds(input).comment(at, closer);
            if (tables.comment(at, closer) !== comment) throw new Error(JSON.stringify(input) + ' ends the comment at ' + at + ' at ' + tables.comment(at, closer) + ', not ' + comment);
          }
        }
        return true;
      }),
      { numRuns: 5000 }
    );
  });

  /**
   * All readers agree, or the editor refuses: an entry's fields, as
   * scanBibtexEntryBody reads them for Zotero link's edits, are the
   * parser's, unless it finds the entry unbalanced, which Zotero link
   * refuses to edit, or finds a comment or a concatenation in it, which it
   * refuses too; and an entry it edits is one BibTeX reads with no error,
   * with the same fields; and each field extractRawField copies for
   * mergeBibtex reads as the parser read it in the entry, with its escaped
   * braces and quotes, a backslash before a line end, and a field repeated.
   * Names and bare values are at the edges of BibTeX's identifiers, with
   * characters other than letters, at their start too, as :doi, or a digit,
   * which none starts with, or a no-break space, which BibTeX reads in one
   * and the parser as a space, with a comma between fields or not, and a
   * word between them that is no field's.
   */
  it('reads an entry\'s fields as the parser does in each reader, or the editor refuses the entry', () => {
    const content = fc.array(fc.constantFrom('a', ' ', '{', '}', '\\{', '\\}', '"', '\\"', '\\\\', '\\', '{"}', '\n', ',', '=', 'doi = ', '{x}', '%', '#'), { maxLength: 6, size: 'max' })
      .map(atoms => atoms.join(''));
    const value = fc.oneof(content.map(c => '{' + c + '}'), content.map(c => '"' + c + '"'), fc.constantFrom('2020', 'jan', 'x-y', '10.1/a', 'a:b'));
    const name = fc.constantFrom('title', 'doi', 'note', 'x-y', ':doi', 'x:doi', '1doi', 'doi:', '+', '\u00E9t\u00E9', 'a\\b', 'a@b', '\u00A0doi', 'doi\u00A0');
    const field = fc.tuple(name, value).map(([n, v]) => n + ' = ' + v);
    const separator = fc.constantFrom(',\n  ', ',\n  ', ',', '\n  ', ', x ', ',\r\n\t', ',\u00A0');
    const body = fc.array(fc.tuple(field, separator), { minLength: 1, maxLength: 4, size: 'max' })
      .map(fields => fields.map(([f, sep], k) => (k === 0 ? '' : sep) + f).join(''));
    fc.assert(
      fc.property(body, fields => {
        const result = parseBibtexWithRaw('@article{k,\n  ' + fields + '\n}');
        const entry = result.parsed.get('k');
        const raw = result.raw.get('k');
        if (!entry || !raw) return true;
        const header = /^@\w+\s*[{(]\s*[^,\s]+\s*,/.exec(raw)!;
        const parsed = readBibtexFields(raw.slice(header[0].length, -1)).map(read => [read.name.toLowerCase(), read.value]);
        const scan = scanBibtexEntryBody(raw);
        if (!scan.unbalanced && !scan.hasTopLevelComment && !scan.hasConcatenation) {
          const scanned = scan.fields.map(read => [read.name, read.value]);
          if (JSON.stringify(scanned) !== JSON.stringify(parsed)) throw new Error(JSON.stringify(raw) + ' scanned as ' + JSON.stringify(scanned) + ', parsed as ' + JSON.stringify(parsed));
          let read: Array<[string, string[]]>;
          try {
            read = readAsBibtex(raw);
          } catch (error) {
            throw new Error(JSON.stringify(raw) + ' edited, which BibTeX reads with an error: ' + (error as Error).message);
          }
          const asBibtex = read.map(([n, [part]]) => [n.toLowerCase(), /^[{"]/.test(part) ? part.slice(1, -1) : part]);
          if (JSON.stringify(asBibtex) !== JSON.stringify(parsed)) throw new Error(JSON.stringify(raw) + ' read by BibTeX as ' + JSON.stringify(asBibtex) + ', parsed as ' + JSON.stringify(parsed));
        }
        for (const [name] of parsed) {
          const rawField = extractRawField(raw, name);
          if (rawField === null) continue;
          const again = parseBibtex('@article{k,\n' + rawField.replace(/,$/, '') + '\n}').get('k')?.fields.get(name);
          if (again !== entry.fields.get(name)) throw new Error(JSON.stringify(raw) + "'s " + name + ' extracted as ' + JSON.stringify(rawField) + ' reads as ' + JSON.stringify(again) + ', not ' + JSON.stringify(entry.fields.get(name)));
        }
        return true;
      }),
      { numRuns: 5000 }
    );
  });

  /** An entry's fields as BibTeX reads them (bibtex.web's get_bib_command_or_entry_and_process):
   *  its name, and each part of its value, as written, in braces, each
   *  brace counted, an escaped one too, in quotes, to the first " in no
   *  group that no odd run of backslashes escapes, a number or a macro,
   *  with a # between each two; a comma after each but the last, which may
   *  have one too, and nothing else. Throws where BibTeX would report an
   *  error. BibTeX, and btparse, end a quoted value at the first " in no
   *  group, escaped or not; the parser reads \" as a quote in the value
   *  (quotedValueEnds), and so does this. */
  const readAsBibtex = (entry: string): Array<[string, string[]]> => {
    const header = /^@\w+\{[^,\s{}]+,/.exec(entry);
    if (!header) throw new Error('no header');
    let i = header[0].length;
    const white = () => { while (/[ \t\n\r]/.test(entry[i] ?? '')) i++; };
    const part = (): string => {
      const start = i;
      if (entry[i] === '{' || entry[i] === '"') {
        let depth = 0;
        let backslashes = 0;
        for (i++; i < entry.length; i++) {
          const escaped = backslashes % 2 === 1;
          backslashes = entry[i] === '\\' ? backslashes + 1 : 0;
          if (entry[i] === '{') depth++;
          else if (entry[i] === '}' && depth > 0) depth--;
          else if (depth === 0 && entry[start] === '{' && entry[i] === '}') return entry.slice(start, ++i);
          else if (depth === 0 && entry[start] === '"' && entry[i] === '"' && !escaped) return entry.slice(start, ++i);
        }
        throw new Error('unclosed value at ' + start);
      }
      const bare = /^(?:\d+|[^\d\x00-\x20"#%'(),={}][^\x00-\x20"#%'(),={}]*)/.exec(entry.slice(i));
      if (!bare) throw new Error('no value at ' + i);
      i += bare[0].length;
      return bare[0];
    };
    const fields: Array<[string, string[]]> = [];
    for (;;) {
      white();
      if (entry[i] === '}' && i === entry.length - 1) return fields;
      const name = /^[^\d\x00-\x20"#%'(),={}][^\x00-\x20"#%'(),={}]*/.exec(entry.slice(i));
      if (!name) throw new Error('no field name at ' + i);
      i += name[0].length;
      white();
      if (entry[i++] !== '=') throw new Error('no = at ' + (i - 1));
      white();
      const parts = [part()];
      for (white(); entry[i] === '#'; white()) {
        i++;
        white();
        parts.push(part());
      }
      fields.push([name[0], parts]);
      if (entry[i] === ',') i++;
      else if (!(entry[i] === '}' && i === entry.length - 1)) throw new Error('no comma at ' + i);
    }
  };

  /**
   * mergeBibtex copies each field the produced entry lacks from the
   * existing entry, wherever it is there, on a line of its own or after
   * another field, repeated or not, with a comma after it or not, braced,
   * quoted, a number, a macro or a concatenation of them: the entry it
   * writes is one BibTeX reads with no error, and each field copied reads
   * as BibTeX read it in the existing entry, the last of a repeated name,
   * as the parser keeps the last, each of the produced entry's as it was.
   * The existing file's @string declarations stay, as written, those
   * before the entry before it and those after it after it, so BibTeX
   * reads each macro the entry uses as the existing file declared it.
   */
  it('copies each field the produced entry lacks into an entry BibTeX reads, as BibTeX read it', () => {
    const content = fc.array(fc.constantFrom('a', ' ', ',', '=', '#', '%', '{x}', '{"}', '\n', '\\&', 'doi = ', '{a {b} c}'), { maxLength: 4 })
      .map(atoms => atoms.join(''));
    const part = fc.oneof(content.map(c => '{' + c + '}'), content.map(c => '"' + c + '"'), fc.constantFrom('2020', 'jan', 'feb', 'x-y', 'a:b', 'extra', 'Other', 'none'));
    // Declarations before the entry, each after those it uses: other uses
    // extra, and jan is declared again, which the entry then reads; and
    // after it
    const declarations = fc.subarray(['@string{extra = {Custom text}}', '@string(other = "x" # Extra)', '@string{unused = {u}}', '@STRING{jan = {January}}']);
    const declarationsAfter = fc.subarray(['@string{none = {N}}', '@string(late = "l")']);
    const value = fc.array(part, { minLength: 1, maxLength: 3 }).chain(parts => fc.array(fc.constantFrom(' # ', '#', ' #\n    '), { minLength: parts.length - 1, maxLength: parts.length - 1 })
      .map(hashes => parts.map((p, k) => (k === 0 ? '' : hashes[k - 1]) + p).join('')));
    const name = fc.constantFrom('note', 'url', 'month', 'title', 'Note', 'x-y', 'year', ':note', 'x:url', 'doi:', '\u00E9t\u00E9', 'a\\b');
    const existingFields = fc.array(fc.tuple(name, value, fc.constantFrom(',\n  ', ', ', ',', ' ,\n\t')), { minLength: 1, maxLength: 5 });
    const producedNames = fc.subarray(['note', 'url', 'month', 'title', 'year']);
    fc.assert(
      fc.property(existingFields, fc.boolean(), producedNames, fc.boolean(), declarations, declarationsAfter, (fields, lastComma, produced, oneLine, declared, declaredAfter) => {
        const body = fields.map(([n, v, sep], k) => n + ' = ' + v + (k < fields.length - 1 ? sep : lastComma ? ',' : '')).join('');
        const entry = '@article{k,\n  ' + body + '\n}';
        const existing = declared.map(d => d + '\n').join('') + entry + declaredAfter.map(d => '\n' + d).join('');
        const producedEntry = oneLine
          ? '@article{k, ' + produced.map(n => n + ' = {P}').join(', ') + '}'
          : '@article{k,\n' + produced.map(n => '  ' + n + ' = {P}').join(',\n') + '\n}';
        const before = readAsBibtex(entry);
        const merged = mergeBibtex(existing, producedEntry);
        const at = merged.indexOf('@article{k,');
        const tail = declaredAfter.map(d => '\n\n' + d).join('');
        let after: Array<[string, string[]]>;
        try {
          after = readAsBibtex(merged.slice(at, merged.length - tail.length));
        } catch (error) {
          throw new Error(JSON.stringify(existing) + ' merged into ' + JSON.stringify(producedEntry) + ' as ' + JSON.stringify(merged) + ', which BibTeX reads with an error: ' + (error as Error).message);
        }
        const failure = JSON.stringify(existing) + ' merged into ' + JSON.stringify(producedEntry) + ' as ' + JSON.stringify(merged);
        const lower = (fieldName: string) => fieldName.toLowerCase();
        const kept = after.slice(0, produced.length);
        if (JSON.stringify(kept) !== JSON.stringify(produced.map(n => [n, ['{P}']]))) throw new Error(failure);
        const copied = after.slice(produced.length);
        const expected = new Map<string, [string, string[]]>();
        for (const field of before) {
          if (produced.includes(lower(field[0]))) continue;
          // The parser's order, of each name's first, and its value, the last's
          const first = expected.get(lower(field[0]));
          expected.set(lower(field[0]), first ? [field[0], field[1]] : field);
        }
        if (JSON.stringify(copied) !== JSON.stringify([...expected.values()])) throw new Error(failure + ', copied ' + JSON.stringify(copied) + ', not ' + JSON.stringify([...expected.values()]));
        // The existing file's declarations, where they were
        const declaring = declared.map(d => d + '\n\n').join('');
        if (merged.slice(0, at) !== declaring || !merged.endsWith(tail)) throw new Error(failure + ', not with ' + JSON.stringify(declaring) + ' before and ' + JSON.stringify(tail) + ' after');
        return true;
      }),
      { numRuns: 2000 }
    );
  });
});
