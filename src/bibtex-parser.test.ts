import { describe, it, expect } from 'bun:test';
import { parseBibtex, parseBibtexWithRaw, findDuplicateBibtexKeys, detectBibtexEol, serializeBibtex, stripOuterBraces, mergeBibtex, extractRawField, spliceFieldsIntoEntry, BibtexEntry } from './bibtex-parser';

describe('BibTeX Parser', () => {
  it('parses basic entry', () => {
    const input = '@article{key1,\n  title = {Test Title},\n  author = {John Doe}\n}';
    const result = parseBibtex(input);
    
    expect(result.size).toBe(1);
    const entry = result.get('key1')!;
    expect(entry.type).toBe('article');
    expect(entry.key).toBe('key1');
    expect(entry.fields.get('title')).toBe('Test Title');
    expect(entry.fields.get('author')).toBe('John Doe');
  });

  it('parses multiple entries', () => {
    const input = `@article{key1,
  title = {First Title}
}

@book{key2,
  title = {Second Title}
}`;
    const result = parseBibtex(input);
    
    expect(result.size).toBe(2);
    expect(result.get('key1')?.fields.get('title')).toBe('First Title');
    expect(result.get('key2')?.fields.get('title')).toBe('Second Title');
  });

  it('parses entries with zotero fields', () => {
    const input = `@article{key1,
  title = {Test},
  zotero-key = {ABC123},
  zotero-uri = {zotero://select/items/ABC123}
}`;
    const result = parseBibtex(input);
    
    const entry = result.get('key1')!;
    expect(entry.zoteroKey).toBe('ABC123');
    expect(entry.zoteroUri).toBe('zotero://select/items/ABC123');
  });

  it('handles nested braces in title', () => {
    const input = '@article{key1,\n  title = {{Nested {Braces} Title}}\n}';
    const result = parseBibtex(input);
    
    expect(result.get('key1')?.fields.get('title')).toBe('Nested {Braces} Title');
  });

  it('handles quoted field values', () => {
    const input = '@article{key1,\n  title = "Quoted Title",\n  author = "Jane Doe"\n}';
    const result = parseBibtex(input);
    
    const entry = result.get('key1')!;
    expect(entry.fields.get('title')).toBe('Quoted Title');
    expect(entry.fields.get('author')).toBe('Jane Doe');
  });

  it('handles quoted values with escaped backslashes before quotes', () => {
    const input = String.raw`@article{key1,
  title = "He said \\\"hello\\\\\\\" there",
  author = {Jane Doe}
}

@article{key2,
  title = {Second Entry}
}`;
    const result = parseBibtex(input);
    expect(result.has('key1')).toBe(true);
    expect(result.has('key2')).toBe(true);
    expect(result.get('key1')?.fields.get('author')).toBe('Jane Doe');
    expect(result.get('key2')?.fields.get('title')).toBe('Second Entry');
  });

  it('skips malformed entries gracefully', () => {
    const input = `@article{key1,
  title = {Good Entry}
}

@article{key2,
  title = {Missing closing brace

@article{key3,
  title = {Another Good Entry}
}`;
    const result = parseBibtex(input);
    
    expect(result.size).toBe(2);
    expect(result.has('key1')).toBe(true);
    expect(result.has('key3')).toBe(true);
    expect(result.has('key2')).toBe(false);
  });

  it('handles empty input', () => {
    const result = parseBibtex('');
    expect(result.size).toBe(0);
  });

  it('handles special characters in values', () => {
    const input = '@article{key1,\n  title = {Title with \\& \\% \\$ symbols}\n}';
    const result = parseBibtex(input);
    
    expect(result.get('key1')?.fields.get('title')).toBe('Title with & % $ symbols');
  });

  it('serializes basic entry', () => {
    const entries = new Map<string, BibtexEntry>();
    const fields = new Map([
      ['title', 'Test Title'],
      ['author', 'John Doe']
    ]);
    
    entries.set('key1', {
      type: 'article',
      key: 'key1',
      fields
    });
    
    const result = serializeBibtex(entries);
    expect(result).toContain('@article{key1,');
    expect(result).toContain('title = {Test Title}');
    expect(result).toContain('author = {John Doe}');
  });

  it('serializes with zotero fields', () => {
    const entries = new Map<string, BibtexEntry>();
    const fields = new Map([
      ['title', 'Test'],
      ['zotero-key', 'ABC123'],
      ['zotero-uri', 'zotero://select/items/ABC123']
    ]);
    
    entries.set('key1', {
      type: 'article',
      key: 'key1',
      fields,
      zoteroKey: 'ABC123',
      zoteroUri: 'zotero://select/items/ABC123'
    });
    
    const result = serializeBibtex(entries);
    expect(result).toContain('zotero-key = {ABC123}');
    expect(result).toContain('zotero-uri = {zotero://select/items/ABC123}');
  });

  it('round-trip preserves data', () => {
    const input = `@article{key1,
  title = {Test Title},
  author = {John Doe},
  doi = {10.1000/test_doi},
  zotero-key = {ABC123}
}`;
    
    const parsed = parseBibtex(input);
    const serialized = serializeBibtex(parsed);
    const reparsed = parseBibtex(serialized);
    
    const original = parsed.get('key1')!;
    const roundtrip = reparsed.get('key1')!;
    
    expect(roundtrip.type).toBe(original.type);
    expect(roundtrip.key).toBe(original.key);
    expect(roundtrip.fields.get('title')).toBe(original.fields.get('title'));
    expect(roundtrip.fields.get('author')).toBe(original.fields.get('author'));
    expect(roundtrip.fields.get('doi')).toBe(original.fields.get('doi'));
    expect(roundtrip.zoteroKey).toBe(original.zoteroKey);
  });

  it('escapes special characters in all fields including DOI', () => {
    const entries = new Map<string, BibtexEntry>();
    const fields = new Map([
      ['title', 'Title & More'],
      ['doi', '10.1000/test_doi'],
      ['zotero-key', 'ABC_123']
    ]);
    
    entries.set('key1', {
      type: 'article',
      key: 'key1',
      fields
    });
    
    const result = serializeBibtex(entries);
    expect(result).toContain('title = {Title \\& More}');
    expect(result).toContain('doi = {10.1000/test_doi}'); // DOI is verbatim (not LaTeX-escaped)
    expect(result).toContain('zotero-key = {ABC_123}'); // Not escaped (alphanumeric identifiers)
  });

  it('skips @type{key, patterns inside field values', () => {
    const input = [
      '@article{key1,',
      '  note = {see @book{ref1, p.5}},',
      '  year = {2020}',
      '}',
      '',
      '@book{real2021,',
      '  year = {2021}',
      '}',
    ].join('\n');
    const entries = parseBibtex(input);
    expect(entries.has('key1')).toBe(true);
    expect(entries.has('real2021')).toBe(true);
    // The spurious @book{ref1, inside the note field must not appear
    expect(entries.has('ref1')).toBe(false);
    expect(entries.size).toBe(2);
  });
});

describe('double-brace fix', () => {
  // Promoted from exploratory tests — these now pass on the fixed code.

  it('strips inner braces from double-braced title', () => {
    const result = parseBibtex('@article{k, title = {{My Title}}}');
    expect(result.get('k')?.fields.get('title')).toBe('My Title');
  });

  it('preserves one brace level for double-braced institutional author (Req 2.3)', () => {
    // author/editor fields use {Name} as a semantic signal for literal/institutional
    // names in downstream CSL processing — so {{Name}} stores as {Name}, not Name.
    const result = parseBibtex('@article{k, author = {{World Health Organization}}}');
    expect(result.get('k')?.fields.get('author')).toBe('{World Health Organization}');
  });

  it('strips inner braces from double-braced unicode title', () => {
    const result = parseBibtex('@article{k, title = {{Über die Natur}}}');
    expect(result.get('k')?.fields.get('title')).toBe('Über die Natur');
  });

  describe('stripOuterBraces edge cases', () => {
    it('{} (empty brace pair) → empty string', () => {
      expect(stripOuterBraces('{}')).toBe('');
    });

    it('{a} → "a"', () => {
      expect(stripOuterBraces('{a}')).toBe('a');
    });

    it('{a} (single-brace) → "a" (unchanged — single-brace path)', () => {
      // stripOuterBraces strips any single wrapping pair; the "single-brace path"
      // means parseBibtex already stripped the outer delimiters before calling it,
      // so braceValue here is just 'a' with no braces at all.
      expect(stripOuterBraces('a')).toBe('a');
    });

    it('{a}{b} (two separate groups) → "{a}{b}" (not stripped)', () => {
      expect(stripOuterBraces('{a}{b}')).toBe('{a}{b}');
    });

    it('{The {RNA} Paradox} → "The {RNA} Paradox" (partial inner group, not stripped)', () => {
      expect(stripOuterBraces('{The {RNA} Paradox}')).toBe('The {RNA} Paradox');
    });
  });

  it('LaTeX escape: {Caf\\\'\\{e\\}} parses without brace corruption', () => {
    // unescapeBibtex handles \& \% \$ etc. but not accent sequences like \'.
    // The important thing is that the partial inner brace {e} does NOT trigger
    // double-brace stripping (braceValue is "Caf\'{e}", which does not start with '{').
    const result = parseBibtex("@article{k, title = {Caf\\'{e}}}");
    expect(result.get('k')?.fields.get('title')).toBe("Caf\\'{e}");
  });
});

describe('mergeBibtex line endings', () => {
  it('splices each entry using its own line ending, not the file majority', () => {
    // A mixed-ending file must not have its minority-convention entries
    // rewritten to the majority one: `k` is all-LF and must stay that way
    // even though the CRLF entry makes CRLF dominant overall.
    const existing = '@article{k,\n  title = {T},\n  note = {keep}\n}';
    const produced = '@article{other,\r\n  title = {O}\r\n}\r\n\r\n@article{k,\n  title = {T}\n}';
    const merged = mergeBibtex(existing, produced);

    expect(merged).toContain('@article{k,\n  title = {T},\n  note = {keep}\n}');
    expect(merged).toContain('@article{other,\r\n  title = {O}\r\n}');
  });

  it('falls back to the document convention for a single-line entry', () => {
    // A one-line entry carries no newline to infer from, so the surrounding
    // document decides.
    const existing = '@article{k, title = {T}, note = {keep}}';
    const produced = '@article{first,\r\n  year = {2020}\r\n}\r\n\r\n@article{k, title = {T}}';
    expect(mergeBibtex(existing, produced)).toContain('@article{k, title = {T},\r\n  note = {keep}\r\n}');
  });
});

describe('mergeBibtex', () => {
  it('preserves existing-only entries verbatim', () => {
    const existing = '@article{onlyExisting,\n  title = {{Only Existing}},\n  year = {2020}\n}';
    const produced = '@article{onlyProduced,\n  title = {Only Produced},\n  year = {2021}\n}';
    const result = mergeBibtex(existing, produced);
    // Existing-only entry appears first (existing order), produced-only appended
    expect(result).toContain('@article{onlyExisting,');
    expect(result).toContain('{{Only Existing}}');
    expect(result).toContain('@article{onlyProduced,');
    expect(result.indexOf('onlyExisting')).toBeLessThan(result.indexOf('onlyProduced'));
  });

  it('appends produced-only entries after existing entries', () => {
    const existing = '@article{key1,\n  title = {Existing},\n  year = {2020}\n}';
    const produced = '@article{key1,\n  title = {Updated},\n  year = {2020}\n}\n\n@article{key2,\n  title = {New Entry},\n  year = {2021}\n}';
    const result = mergeBibtex(existing, produced);
    expect(result).toContain('@article{key2,');
    expect(result).toContain('New Entry');
  });

  it('uses produced field values when both have the same field', () => {
    const existing = '@article{key1,\n  title = {Old Title},\n  year = {2020}\n}';
    const produced = '@article{key1,\n  title = {New Title},\n  year = {2020}\n}';
    const result = mergeBibtex(existing, produced);
    expect(result).toContain('New Title');
    expect(result).not.toContain('Old Title');
  });

  it('preserves existing-only fields when produced is missing them', () => {
    const existing = '@article{key1,\n  title = {Title},\n  abstract = {An abstract},\n  year = {2020}\n}';
    const produced = '@article{key1,\n  title = {Title},\n  year = {2020}\n}';
    const result = mergeBibtex(existing, produced);
    expect(result).toContain('abstract');
    expect(result).toContain('An abstract');
  });

  it('preserves double-brace title formatting in existing-only entries', () => {
    const existing = '@article{key1,\n  title = {{Double Braced Title}},\n  year = {2020}\n}';
    const produced = '';
    const result = mergeBibtex(existing, produced);
    expect(result).toContain('{{Double Braced Title}}');
  });

  it('returns existing when produced is empty', () => {
    const existing = '@article{key1,\n  title = {Title},\n  year = {2020}\n}';
    const result = mergeBibtex(existing, '');
    expect(result).toBe(existing);
  });

  it('returns produced when existing is empty', () => {
    const produced = '@article{key1,\n  title = {Title},\n  year = {2020}\n}';
    const result = mergeBibtex('', produced);
    expect(result).toBe(produced);
  });
});

describe('extractRawField', () => {
  it('extracts double-braced value', () => {
    const entry = '@article{k,\n  title = {{My Title}},\n  year = {2020}\n}';
    const result = extractRawField(entry, 'title');
    expect(result).toBe('  title = {{My Title}},');
  });

  it('extracts quoted value', () => {
    const entry = '@article{k,\n  title = "My Title",\n  year = {2020}\n}';
    const result = extractRawField(entry, 'title');
    expect(result).toBe('  title = "My Title",');
  });

  it('extracts bare numeric value', () => {
    const entry = '@article{k,\n  title = {Title},\n  year = 2020,\n  author = {Doe}\n}';
    const result = extractRawField(entry, 'year');
    expect(result).toBe('  year = 2020,');
  });

  it('returns null when field is not present', () => {
    const entry = '@article{k,\n  title = {Title},\n  year = {2020}\n}';
    expect(extractRawField(entry, 'abstract')).toBeNull();
  });

  it('extracts multi-line brace-delimited value', () => {
    const entry = '@article{k,\n  abstract = {Line one\nLine two\nLine three},\n  year = {2020}\n}';
    const result = extractRawField(entry, 'abstract');
    expect(result).toBe('  abstract = {Line one\nLine two\nLine three},');
  });

  it('handles escaped braces in brace-delimited value', () => {
    const entry = '@article{k,\n  title = {A \\{special\\} title},\n  year = {2020}\n}';
    const result = extractRawField(entry, 'title');
    expect(result).toBe('  title = {A \\{special\\} title},');
  });
});

describe('spliceFieldsIntoEntry', () => {
  it('splices a single field before closing brace', () => {
    const entry = '@article{k,\n  title = {Title}\n}';
    const result = spliceFieldsIntoEntry(entry, ['  year = {2020}']);
    expect(result).toContain('title = {Title}');
    expect(result).toContain('year = {2020}');
    expect(result).toEndWith('\n}');
  });

  it('adds trailing comma to last produced field when missing', () => {
    const entry = '@article{k,\n  title = {Title}\n}';
    const result = spliceFieldsIntoEntry(entry, ['  year = {2020}']);
    // The produced entry's last field "title = {Title}" should get a comma added
    expect(result).toContain('title = {Title},');
  });

  it('is a no-op when fieldTexts is empty', () => {
    const entry = '@article{k,\n  title = {Title}\n}';
    expect(spliceFieldsIntoEntry(entry, [])).toBe(entry);
  });

  it('handles entry with trailing comma on last field', () => {
    const entry = '@article{k,\n  title = {Title},\n}';
    const result = spliceFieldsIntoEntry(entry, ['  year = {2020}']);
    expect(result).toContain('year = {2020}');
    expect(result).toEndWith('\n}');
  });

  it('strips trailing comma from last spliced field', () => {
    const entry = '@article{k,\n  title = {Title}\n}';
    const result = spliceFieldsIntoEntry(entry, ['  abstract = {An abstract},', '  year = {2020},']);
    // Last spliced field should not end with comma
    expect(result).toContain('year = {2020}\n}');
  });
});

describe('parseBibtex via parseBibtexWithRaw parity', () => {
  // parseBibtex delegates to parseBibtexWithRaw — verify parsed output
  // matches expectations on a non-trivial multi-entry input so drift in
  // the single implementation is caught.
  it('produces identical results for complex input', () => {
    const input = [
      '@article{Smith2020,',
      '  title = {{A Complex Title}},',
      '  author = {{World Health Organization}},',
      '  year = {2020},',
      '  doi = {10.1000/test}',
      '}',
      '',
      '@book{Jones2021,',
      '  title = "Quoted Book Title",',
      '  editor = {Jane Doe},',
      '  year = 2021',
      '}',
      '',
      '@inproceedings{malformed,',
      '  title = {Missing closing brace',
      '',
      '@misc{Valid2022,',
      '  note = {see @article{ref, p.5}},',
      '  year = {2022}',
      '}',
    ].join('\n');

    const result = parseBibtex(input);

    // Should parse 3 valid entries, skip malformed
    expect(result.size).toBe(3);
    expect(result.has('Smith2020')).toBe(true);
    expect(result.has('Jones2021')).toBe(true);
    expect(result.has('Valid2022')).toBe(true);
    expect(result.has('malformed')).toBe(false);

    // Verify field-level parsing
    expect(result.get('Smith2020')!.fields.get('title')).toBe('A Complex Title');
    expect(result.get('Smith2020')!.fields.get('author')).toBe('{World Health Organization}');
    expect(result.get('Jones2021')!.fields.get('title')).toBe('Quoted Book Title');
    expect(result.get('Jones2021')!.fields.get('year')).toBe('2021');
    expect(result.get('Valid2022')!.fields.get('year')).toBe('2022');

    // Spurious @article{ref inside note must not appear
    expect(result.has('ref')).toBe(false);
  });
});

describe('parseBibtexWithRaw source ranges', () => {
  // Source ranges let callers splice edits into the original text by offset
  // instead of re-finding raw substrings, which is ambiguous when two
  // entries share a citation key.
  it('reports ranges that slice back to the exact raw entry text', () => {
    const input = [
      '% leading comment',
      '',
      '@article{smith2020,',
      '  title = {{First}},',
      '  doi = {10.1/a}',
      '}',
      '',
      '@book{jones2021,',
      '  title = {{Second}}',
      '}',
      '',
      '% trailing comment',
    ].join('\n');

    const { raw, ranges } = parseBibtexWithRaw(input);

    for (const range of ranges) {
      expect(input.slice(range.start, range.end)).toBe(raw.get(range.key));
    }
    expect(ranges.map(r => r.key)).toEqual(['smith2020', 'jones2021']);
    expect(input.slice(ranges[0].start)).toStartWith('@article{smith2020,');
    expect(input.slice(ranges[1].start)).toStartWith('@book{jones2021,');
  });

  it('reports ranges in ascending, non-overlapping order', () => {
    const input = '@article{a,\n  year = {2020}\n}\n\n@book{b,\n  year = {2021}\n}';
    const { ranges } = parseBibtexWithRaw(input);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i - 1].end).toBeLessThanOrEqual(ranges[i].start);
    }
  });

  it('flags duplicate citation keys so callers can refuse to edit them', () => {
    const input = '@article{dup,\n  doi = {10.1/a}\n}\n\n@article{dup,\n  doi = {10.2/b}\n}';
    const { parsed, ranges } = parseBibtexWithRaw(input);

    // The parsed map collapses to one entry — that is exactly why ranges
    // keeps both occurrences and the duplicate must be reported.
    expect(parsed.size).toBe(1);
    expect(ranges).toHaveLength(2);
    expect(input.slice(ranges[0].start, ranges[0].end)).toContain('10.1/a');
    expect(input.slice(ranges[1].start, ranges[1].end)).toContain('10.2/b');
    expect(findDuplicateBibtexKeys(ranges).has('dup')).toBe(true);
  });

  it('reports no duplicates for distinct keys', () => {
    const { ranges } = parseBibtexWithRaw('@article{a,\n  year = {2020}\n}\n\n@book{b,\n  year = {2021}\n}');
    expect(findDuplicateBibtexKeys(ranges).size).toBe(0);
  });

  it('treats case-different keys as distinct, matching parseBibtex', () => {
    const { parsed, ranges } = parseBibtexWithRaw('@article{Smith,\n  year = {2020}\n}\n\n@article{smith,\n  year = {2021}\n}');
    expect(parsed.size).toBe(2);
    expect(findDuplicateBibtexKeys(ranges).size).toBe(0);
  });

  it('reports no entry for citation-like text inside a pseudo-entry', () => {
    // @string/@comment/@preamble bodies are arbitrary text. An @article quoted
    // inside one is data, and splicing fields into it would corrupt the
    // declaration — so it must not be reported as an addressable entry.
    for (const input of [
      '@string{snippet = "@article{fake, doi = {10.1/x}}"}',
      '@comment{note, @article{fake, doi = {10.1/x}}}',
      '@preamble{"@article{fake, doi = {10.1/x}}"}',
    ]) {
      const { parsed, ranges } = parseBibtexWithRaw(input);
      expect(ranges).toEqual([]);
      expect(parsed.size).toBe(0);
    }
  });

  it('still finds real entries surrounding a pseudo-entry', () => {
    const input = '@string{jgl = "Journal"}\n@article{real, year = {2020}}\n@comment{aside}\n@book{alsoreal, year = {2021}}';
    const { ranges } = parseBibtexWithRaw(input);
    expect(ranges.map(r => r.key)).toEqual(['real', 'alsoreal']);
  });

  it('does not report an entry nested inside an unterminated one', () => {
    // `broken` never closes, so everything after it is inside its field value.
    // A range for `fake` would point into that value, not at a real entry.
    const input = '@article{broken,\n  note = {see @book{fake, year = {2020}}';
    expect(parseBibtexWithRaw(input).ranges).toEqual([]);
  });

  it('still parses entries recovered after an unterminated one, without ranging them', () => {
    // Recovery is a heuristic: once the scanner has lost sync it cannot tell a
    // real entry from an entry-shaped field value indented on its own line.
    // `parsed` keeps the best-effort result, but `ranges` — which callers
    // splice into — must not trade on a guess.
    const input = '@article{broken,\n  title = {no close brace\n\n@article{good,\n  year = {2021}\n}';
    const { parsed, ranges } = parseBibtexWithRaw(input);
    expect([...parsed.keys()]).toEqual(['good']);
    expect(ranges).toEqual([]);
  });

  it('never reports a range for an entry nested in an unterminated one', () => {
    // The mirror case that makes the above necessary: `fake` is indented on
    // its own line inside broken's note value, and is lexically identical to
    // a recovered entry.  Ranging either one would corrupt the file.
    const input = '@article{broken,\n  note = {\n    @book{fake, doi = {10.1/not-real}}';
    expect(parseBibtexWithRaw(input).ranges).toEqual([]);
  });

  it('reports no range for an entry inside a malformed-header construct', () => {
    // `@article{` opens but its header has no citation key, so its body is
    // that construct's data — not a place to splice fields into.
    const input = '@article{not a valid header\n  note = {@book{fake, doi = {10.1/not-real}}}\n}';
    expect(parseBibtexWithRaw(input).ranges).toEqual([]);
  });

  it('does not let a stray quote in a comment expose its contents', () => {
    // A comment is prose: the lone `"` is ordinary text, and must not put the
    // scanner into quote mode and swallow the comment's closing brace.
    const input = '@comment{He wrote "\n  @article{fake, doi = {10.1/not-real}}\n}';
    expect(parseBibtexWithRaw(input).ranges).toEqual([]);
  });

  it('spans the whole entry when a quote is brace-protected', () => {
    // BibTeX lets `{"}` protect a literal quote inside a quoted value. Ending
    // the entry at the protective group would report a truncated range and
    // splice fields into the middle of the title.
    const input = '@article{k, title = "A {"}quoted{"} word", year = {2020}}';
    const { ranges } = parseBibtexWithRaw(input);
    expect(ranges).toHaveLength(1);
    expect(input.slice(ranges[0].start, ranges[0].end)).toBe(input);
  });

  it('omits an entry whose closing brace is never found', () => {
    // There is no trustworthy end offset for an unclosed entry, so it must not
    // appear at all — a caller splicing into a guessed range would corrupt the
    // rest of the file.  Entries *before* it are already delimited and stay.
    const input = '@article{good,\n  year = {2021}\n}\n\n@article{broken,\n  title = {no close brace';
    const { ranges } = parseBibtexWithRaw(input);

    expect(ranges.map(r => r.key)).toEqual(['good']);
    expect(input.slice(ranges[0].start, ranges[0].end)).toBe('@article{good,\n  year = {2021}\n}');
  });

  it('returns no ranges for input with no entries', () => {
    expect(parseBibtexWithRaw('').ranges).toEqual([]);
    expect(parseBibtexWithRaw('% just a comment\n\nsome prose\n').ranges).toEqual([]);
  });

  // The following cases came from the LSP's own entry scanner, which these
  // ranges replaced.  They guard the boundary detection that document symbols
  // and go-to-definition depend on.
  it('spans exactly one entry when several are present', () => {
    const input = '@article{alpha2020,\n  year = {2020}\n}\n\n@book{beta2021,\n  year = {2021}\n}';
    const { ranges } = parseBibtexWithRaw(input);
    expect(ranges.map(r => r.key)).toEqual(['alpha2020', 'beta2021']);
    expect(input.slice(ranges[0].start, ranges[0].end)).toBe('@article{alpha2020,\n  year = {2020}\n}');
    expect(input.slice(ranges[1].start, ranges[1].end)).toBe('@book{beta2021,\n  year = {2021}\n}');
  });

  it('counts nested braces in field values', () => {
    const input = '@article{nested2020,\n  title = {{Nested {Braces} Here}},\n  year = {2020}\n}';
    const { ranges } = parseBibtexWithRaw(input);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].end).toBe(input.length);
  });

  it('treats braces and quotes inside values as literal text', () => {
    // A " inside {...} is an ordinary character in BibTeX, and a } inside "..."
    // must not close the entry — an odd number of quotes must not desync either.
    for (const input of [
      '@article{quoted, title = "A {Title} Here", year = {2020}}',
      '@article{braced, title = {say "hi" and "bye"}, year = {2020}}',
      '@article{oddquote, title = {say "hi" there"}, year = {2020}}',
    ]) {
      const { ranges } = parseBibtexWithRaw(input);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].end).toBe(input.length);
    }
  });

  it('ignores an @type{key, pattern inside a field value', () => {
    const input = '@article{first2020,\n  note = {see @book{ref1, p.5}},\n  year = {2020}\n}\n\n@book{second2021,\n  year = {2021}\n}';
    const { ranges } = parseBibtexWithRaw(input);
    // `ref1` is a reference in prose, not a declaration.
    expect(ranges.map(r => r.key)).toEqual(['first2020', 'second2021']);
    expect(ranges[1].start).toBeGreaterThanOrEqual(ranges[0].end);
  });

  it('brackets the citation key even when it spells the entry type', () => {
    const input = '@article{article,\n  year = {2020}\n}';
    const { ranges } = parseBibtexWithRaw(input);
    expect(input.slice(ranges[0].keyStart, ranges[0].keyEnd)).toBe('article');
    // Must point past the opening brace, not at the type name.
    expect(ranges[0].keyStart).toBe(input.indexOf('{') + 1);
  });

  it('brackets a key containing punctuation', () => {
    const input = '@inproceedings{conf-key2021,\n  year = {2021}\n}';
    const { ranges } = parseBibtexWithRaw(input);
    expect(input.slice(ranges[0].keyStart, ranges[0].keyEnd)).toBe('conf-key2021');
  });
});

describe('detectBibtexEol', () => {
  it('reports the dominant ending', () => {
    expect(detectBibtexEol('@article{a,\n  year = {2020}\n}')).toBe('\n');
    expect(detectBibtexEol('@article{a,\r\n  year = {2020}\r\n}')).toBe('\r\n');
  });

  it('defaults to LF when the text has no newline at all', () => {
    expect(detectBibtexEol('@article{a, year = {2020}}')).toBe('\n');
    expect(detectBibtexEol('')).toBe('\n');
  });

  it('breaks a tie on the newline after the entry header', () => {
    // Counts alone cannot separate a structural newline from one inside a
    // field value, so the tie-break looks at the newline that follows the
    // header — that one is always structural.
    expect(detectBibtexEol('@article{k,\r\n  note = {a\nb}}')).toBe('\r\n');
    expect(detectBibtexEol('@article{k,\n  note = {a\r\nb}}')).toBe('\n');
  });

  it('falls back to the first newline when there is no header to consult', () => {
    // Bare text with no entry: nothing marks a structural newline, so the
    // first one is the best available signal.
    expect(detectBibtexEol('a\r\nb\nc')).toBe('\r\n');
    expect(detectBibtexEol('a\nb\r\nc')).toBe('\n');
  });

  it('does not let a lone CRLF outvote a majority of LF lines', () => {
    expect(detectBibtexEol('a\nb\nc\nd\r\ne')).toBe('\n');
  });

  it('does not let a CRLF inside one field decide the entry layout', () => {
    // The structural newline after the header is LF; the only CRLF is inside
    // the note value. Counting bare LF separately keeps the entry on LF.
    const raw = '@article{k,\n  note = {a\r\nb}}';
    expect(detectBibtexEol(raw)).toBe('\n');
    expect(spliceFieldsIntoEntry(raw, ['  zotero-key = {K},'])).toBe(
      '@article{k,\n  note = {a\r\nb},\n  zotero-key = {K}\n}',
    );
  });
});

describe('spliceFieldsIntoEntry whitespace preservation', () => {
  // Adding a field must not double as a reformat: any byte the splice did not
  // need to touch has to survive, or linking produces spurious diff noise.
  it('keeps a blank line the author left before the closing brace', () => {
    const raw = '@article{k,\n  title = {T},\n\n}';
    expect(spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD},'])).toBe(
      '@article{k,\n  title = {T},\n\n  zotero-key = {ABCD}\n}',
    );
  });

  it('keeps trailing spaces after an already-comma-terminated field', () => {
    const raw = '@article{k,\n  title = {T},   \n}';
    expect(spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD},'])).toBe(
      '@article{k,\n  title = {T},   \n  zotero-key = {ABCD}\n}',
    );
  });

  it('trims only when the comma must follow the last field token', () => {
    // No comma yet, so the comma has to land right after `{T}` — the newline
    // between it and the brace is necessarily rewritten.
    const raw = '@article{k,\n  title = {T}\n}';
    expect(spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD},'])).toBe(
      '@article{k,\n  title = {T},\n  zotero-key = {ABCD}\n}',
    );
  });
});

describe('spliceFieldsIntoEntry line endings', () => {
  // A CRLF .bib must stay CRLF: mixed endings show up as whole-file diff
  // noise on Windows checkouts.
  it('uses CRLF for inserted fields when the entry uses CRLF', () => {
    const raw = '@article{smith2020,\r\n  author = {Smith, J},\r\n  doi = {10.1/x}\r\n}';
    const out = spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD1234},', '  zotero-uri = {http://zotero.org/groups/1/items/ABCD1234},']);

    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).toContain('\r\n  zotero-key = {ABCD1234},\r\n');
    expect(out).toContain('\r\n  zotero-uri = {http://zotero.org/groups/1/items/ABCD1234}\r\n}');
  });

  it('keeps LF entries on LF', () => {
    const raw = '@article{smith2020,\n  doi = {10.1/x}\n}';
    const out = spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD1234},']);
    expect(out).not.toContain('\r');
    expect(out).toContain('\n  zotero-key = {ABCD1234}\n}');
  });

  it('uses the caller-supplied EOL for a single-line entry that has none', () => {
    // A one-line entry in a CRLF file carries no newline to infer from, so the
    // caller's document convention has to win.
    const raw = '@article{smith2020, doi = {10.1/x}}';
    const out = spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD1234},'], '\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).toContain('\r\n  zotero-key = {ABCD1234}\r\n}');
  });

  it('does not let one CRLF field make an otherwise-LF entry CRLF', () => {
    const raw = '@article{smith2020,\n  note = {line one\r\n  line two},\n  doi = {10.1/x}\n}';
    const out = spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD1234},'], detectBibtexEol(raw));
    expect(out).toContain('\n  zotero-key = {ABCD1234}\n}');
    // The pre-existing CRLF inside the note field must survive untouched.
    expect(out).toContain('line one\r\n  line two');
  });
});
