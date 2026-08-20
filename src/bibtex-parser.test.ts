import { describe, it, expect } from 'bun:test';
import { parseBibtex, parseBibtexWithRaw, scanBibtexEntryBody, findDuplicateBibtexKeys, detectBibtexEol, detectEntryEol, serializeBibtex, stripOuterBraces, stripWrappingBraces, mergeBibtex, extractRawField, spliceFieldsIntoEntry, BibtexEntry } from './bibtex-parser';

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

  describe('stripWrappingBraces', () => {
    it('agrees with stripOuterBraces looped to a fixed point', () => {
      // stripOuterBraces is the independent reference: single-pair semantics,
      // written separately.  Looping it with trims is the whole specification
      // of stripWrappingBraces on balanced input; on unbalanced input the
      // contract is identity, since brace pairing is meaningless there.  This
      // exhaustive differential is what caught this function's last two
      // defects — the suite's own examples, written from the same mental
      // model as the code, did not.
      const reference = (s: string): string => {
        for (;;) {
          s = s.trim();
          const t = stripOuterBraces(s);
          if (t === s) return s;
          s = t;
        }
      };
      const balanced = (s: string): boolean => {
        let depth = 0;
        for (const ch of s) {
          if (ch === '{') depth++;
          else if (ch === '}' && --depth < 0) return false;
        }
        return depth === 0;
      };
      const alphabet = ['{', '}', 'a', ' '];
      const walk = (s: string, left: number): void => {
        const trimmed = s.trim();
        expect(stripWrappingBraces(trimmed)).toBe(balanced(s) ? reference(s) : trimmed);
        if (left === 0) return;
        for (const ch of alphabet) walk(s + ch, left - 1);
      };
      walk('', 8);
    });

    it('strips deep brace nesting without quadratic cost', () => {
      // Calling stripOuterBraces in a loop rescans the whole value per pair;
      // this case took seconds.
      const wrapped = '{'.repeat(50000) + 'x' + '}'.repeat(50000);
      const started = performance.now();
      expect(stripWrappingBraces(wrapped)).toBe('x');
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  it('decodes a braced LaTeX accent without corrupting surrounding braces', () => {
    const result = parseBibtex("@article{k, title = {Caf\\'{e}}}");
    expect(result.get('k')?.fields.get('title')).toBe('Café');
  });
});

describe('BibTeX TeX accent decoding', () => {
  it('decodes equivalent umlaut spellings in creator names', () => {
    const spellings = [
      String.raw`M\"uller`,
      String.raw`M\"{u}ller`,
      String.raw`M{\"u}ller`,
    ];

    for (const [index, spelling] of spellings.entries()) {
      const entries = parseBibtex('@article{k' + index + ', author = {' + spelling + ', Jane}}');
      expect(entries.get('k' + index)?.fields.get('author')).toBe('Müller, Jane');
    }
  });

  it('decodes the standard BibTeX text accents and dotless letter operands', () => {
    const cases: Array<[string, string]> = [
      ["\\`a", 'à'],
      [String.raw`\'e`, 'é'],
      [String.raw`\^o`, 'ô'],
      [String.raw`\"u`, 'ü'],
      [String.raw`\~n`, 'ñ'],
      [String.raw`\=a`, 'ā'],
      [String.raw`\.z`, 'ż'],
      [String.raw`\u{g}`, 'ğ'],
      [String.raw`\v{S}`, 'Š'],
      [String.raw`\H{o}`, 'ő'],
      [String.raw`\c{c}`, 'ç'],
      [String.raw`\k{a}`, 'ą'],
      [String.raw`\d{s}`, 'ṣ'],
      [String.raw`\b{d}`, 'ḏ'],
      [String.raw`\r{a}`, 'å'],
      [String.raw`\t{oo}`, 'o͡o'],
      [String.raw`\'{\i}`, 'í'],
      [String.raw`\^{\j}`, 'ĵ'],
    ];

    for (const [index, [source, expected]] of cases.entries()) {
      const entries = parseBibtex('@article{k' + index + ', title = {' + source + '}}');
      expect(entries.get('k' + index)?.fields.get('title')).toBe(expected.normalize('NFC'));
    }
  });

  it('preserves structural braces while consuming accent-owned braces', () => {
    const input = String.raw`@article{k,
  title = {{The {RNA} response by M{\"u}ller and {\"U}ber}},
  author = {{M{\"u}ller Institute and Research}}
}`;
    const entry = parseBibtex(input).get('k')!;

    expect(entry.fields.get('title')).toBe('The {RNA} response by Müller and Über');
    expect(entry.fields.get('author')).toBe('{Müller Institute and Research}');
  });

  it('preserves unknown and malformed TeX commands', () => {
    const value = String.raw`\LaTeX \unknown{Text} \"{} \"{ue}`;
    const entry = parseBibtex('@article{k, title = {' + value + '}}').get('k')!;
    expect(entry.fields.get('title')).toBe(value);
  });

  it('preserves unsupported commands that match Object prototype properties', () => {
    const value = String.raw`\constructor{u} \toString{u} \hasOwnProperty{u}`;
    const entry = parseBibtex('@article{k, title = {' + value + '}}').get('k')!;
    expect(entry.fields.get('title')).toBe(value);
  });

  it('leaves identifier, path, and Zotero fields exactly unchanged', () => {
    const input = String.raw`@article{k,
  doi = {10.1000/M{\"u}ller\_x},
  url = {https://example.test/M{\"u}ller?q=a\_b#frag~1},
  isbn = {978\_M{\"u}ller},
  issn = {1234\_5678},
  file = {C\:\\Papers\\M{\"u}ller\;paper.pdf},
  zotero-key = {AB\_CD},
  zotero-uri = {http://zotero.org/groups/1/items/M{\"u}ller\_x#frag}
}`;
    const entry = parseBibtex(input).get('k')!;

    expect(entry.fields.get('doi')).toBe(String.raw`10.1000/M{\"u}ller\_x`);
    expect(entry.fields.get('url')).toBe(String.raw`https://example.test/M{\"u}ller?q=a\_b#frag~1`);
    expect(entry.fields.get('isbn')).toBe(String.raw`978\_M{\"u}ller`);
    expect(entry.fields.get('issn')).toBe(String.raw`1234\_5678`);
    expect(entry.fields.get('file')).toBe(String.raw`C\:\\Papers\\M{\"u}ller\;paper.pdf`);
    expect(entry.zoteroKey).toBe(String.raw`AB\_CD`);
    expect(entry.zoteroUri).toBe(String.raw`http://zotero.org/groups/1/items/M{\"u}ller\_x#frag`);
  });

  it('normalizes semantic text to NFC but does not normalize opaque fields', () => {
    const decomposed = 'Café';
    const input = '@article{k, title = {' + decomposed + '}, doi = {' + decomposed + '}}';
    const entry = parseBibtex(input).get('k')!;

    expect(entry.fields.get('title')).toBe('Café');
    expect(entry.fields.get('doi')).toBe(decomposed);
  });

  it('round-trips literal tilde and circumflex characters without treating them as accents', () => {
    const entries = new Map<string, BibtexEntry>([[
      'k',
      { type: 'article', key: 'k', fields: new Map([['title', 'A ~ B ^ C']]) },
    ]]);

    const serialized = serializeBibtex(entries);
    expect(serialized).toContain(
      String.raw`title = {A \textasciitilde{} B \textasciicircum{} C}`
    );
    expect(parseBibtex(serialized).get('k')?.fields.get('title')).toBe('A ~ B ^ C');
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

  it('marks entries recovered after an unterminated one as untrusted', () => {
    // Recovery is a heuristic: once the scanner has lost sync it cannot tell a
    // real entry from an entry-shaped field value indented on its own line.
    // Navigation still wants the location, so the range is reported — but
    // flagged, because splicing into a guess would corrupt the file.
    const input = '@article{broken,\n  title = {no close brace\n\n@article{good,\n  year = {2021}\n}';
    const { parsed, ranges, rangesTrusted } = parseBibtexWithRaw(input);
    expect([...parsed.keys()]).toEqual(['good']);
    expect(ranges.map(r => r.key)).toEqual(['good']);
    expect(ranges[0].trusted).toBe(false);
    expect(rangesTrusted).toBe(false);
  });

  it('marks an entry nested in an unterminated one as untrusted', () => {
    // The mirror case that makes the flag necessary: `fake` is indented on its
    // own line inside broken's note value, and is lexically identical to a
    // recovered entry. Neither may be spliced into.
    const input = '@article{broken,\n  note = {\n    @book{fake, doi = {10.1/not-real}}';
    const { ranges, rangesTrusted } = parseBibtexWithRaw(input);
    expect(ranges.every(r => !r.trusted)).toBe(true);
    expect(rangesTrusted).toBe(false);
  });

  it('reports no range for an entry inside a malformed-header construct', () => {
    // `@article{` opens but its header has no citation key, so its body is
    // that construct's data — consumed whole, never scanned into.
    const input = '@article{not a valid header\n  note = {@book{fake, doi = {10.1/not-real}}}\n}';
    expect(parseBibtexWithRaw(input).ranges).toEqual([]);
  });

  it('keeps a recovered occurrence from silently aliasing a trusted range', () => {
    // parsed/raw keep only the last occurrence, so the recovered second `dup`
    // replaces the value behind the first — trusted — range. If the recovered
    // occurrence were dropped from ranges, a caller could match the second
    // entry's DOI and splice into the first. Reporting both keeps the
    // ambiguity visible to findDuplicateBibtexKeys.
    const input = '@article{dup, doi = {10.1/a}}\n\n@article{broken,\n  title = {unterminated\n\n@article{dup, doi = {10.2/b}}';
    const { parsed, ranges, rangesTrusted } = parseBibtexWithRaw(input);

    expect(parsed.get('dup')?.fields.get('doi')).toBe('10.2/b');
    expect(ranges.filter(r => r.key === 'dup').map(r => r.trusted)).toEqual([true, false]);
    expect(findDuplicateBibtexKeys(ranges).has('dup')).toBe(true);
    expect(rangesTrusted).toBe(false);
  });

  it('marks every range trusted in a well-formed file', () => {
    const input = '@string{j = "J"}\n@article{a, year = {2020}}\n@comment{aside}\n@book{b, year = {2021}}';
    const { ranges, rangesTrusted } = parseBibtexWithRaw(input);
    expect(ranges.map(r => r.key)).toEqual(['a', 'b']);
    expect(ranges.every(r => r.trusted)).toBe(true);
    expect(rangesTrusted).toBe(true);
  });

  it('handles parenthesized entries and declarations', () => {
    // BibTeX accepts either delimiter. Skipping the paren form would both miss
    // real entries and leave a paren @comment's contents exposed as entries.
    const entry = '@article(smith2020,\n  doi = {10.1/x}\n)';
    const { parsed, ranges } = parseBibtexWithRaw(entry);
    expect(ranges.map(r => r.key)).toEqual(['smith2020']);
    expect(entry.slice(ranges[0].start, ranges[0].end)).toBe(entry);
    expect(parsed.get('smith2020')?.fields.get('doi')).toBe('10.1/x');

    // Braces inside a paren entry's field values still balance independently.
    expect(parseBibtexWithRaw('@article(k, title = {a (b) c}, y = {1})').parsed.get('k')?.fields.get('title'))
      .toBe('a (b) c');

    expect(parseBibtexWithRaw('@comment(text:\n  @article{fake, doi = {10.1/no}}\n)').ranges).toEqual([]);
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

  it('does not break a tie on a header inside a pseudo-entry', () => {
    // A bare regex matches `@book{fake,` inside the comment and would read
    // that comment's bare LF as the document's convention. The real structural
    // newline is the CRLF between the two top-level constructs.
    expect(detectBibtexEol('@comment{see @book{fake,\ntext}}\r\n@article{k, title = {T}}')).toBe('\r\n');
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

  it('inserts the comma after the last field token without reflowing', () => {
    // No comma yet, so one has to land right after `{T}` — but inserting a
    // character before the following newline does not require removing it.
    const raw = '@article{k,\n  title = {T}\n}';
    expect(spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD},'])).toBe(
      '@article{k,\n  title = {T},\n  zotero-key = {ABCD}\n}',
    );
  });

  it('keeps whitespace the comma insertion had to step over', () => {
    // The trailing spaces and the blank line are unrelated bytes: the comma
    // goes in front of them, and they survive verbatim.
    const raw = '@article{k,\n  title = {T}   \n\n}';
    expect(spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD},'])).toBe(
      '@article{k,\n  title = {T},   \n\n  zotero-key = {ABCD}\n}',
    );
  });
});

describe('detectEntryEol', () => {
  // Distinguishes an entry's own layout from bytes inside its field values.
  it('reports null when every newline is inside a field value', () => {
    expect(detectEntryEol('@article{k, title = {T}, note = {a\nb}}')).toBe(null);
  });

  it('ignores a newline inside a quoted value', () => {
    expect(detectEntryEol('@article{k, note = "a\nb"}')).toBe(null);
  });

  it('reports the newline that separates fields', () => {
    expect(detectEntryEol('@article{k,\n  note = {a\r\nb}\n}')).toBe('\n');
  });

  it('reports CRLF for a CRLF-laid-out entry', () => {
    expect(detectEntryEol('@article{k,\r\n  note = {a\nb}\r\n}')).toBe('\r\n');
  });

  it('counts a newline in the header, before the opening delimiter', () => {
    expect(detectEntryEol('@article\r\n{k, title = {T}}')).toBe('\r\n');
  });

  it('handles paren entries the same way', () => {
    expect(detectEntryEol('@article(k, note = {a\nb})')).toBe(null);
    expect(detectEntryEol('@article(k,\r\n  note = {x}\r\n)')).toBe('\r\n');
  });
});

describe('mergeBibtex entry line endings', () => {
  it('does not let a newline inside a field value pick the splice EOL', () => {
    // `note`'s bare LF is payload. The entry is structurally single-line, so
    // the restored field must follow the document's CRLF convention.
    const existing = '@article{k,\r\n  title = {T},\r\n  extra = {keep}\r\n}';
    const produced = '@book{x, title = {X}}\r\n\r\n@article{k, title = {T}, note = {a\nb}}';
    const merged = mergeBibtex(existing, produced);
    expect(merged).toContain('\r\n  extra = {keep}\r\n}');
    // The payload newline itself is untouched.
    expect(merged).toContain('note = {a\nb}');
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

describe('paren-delimited entries', () => {
  // BibTeX accepts `@type(...)` as well as `@type{...}`, but only braces
  // delimit *field values*. A paren inside a braced value is ordinary text
  // with no obligation to balance, so the two depths must be tracked apart.
  it('does not let an unmatched ( inside a field value swallow the entry', () => {
    const input = '@article(k, title = {Analysis (Part I}, year = {2020})\n\n@book{b, title = {T}}';
    const { parsed, ranges } = parseBibtexWithRaw(input);
    expect([...parsed.keys()]).toEqual(['k', 'b']);
    expect(input.slice(ranges[0].start, ranges[0].end)).toBe(
      '@article(k, title = {Analysis (Part I}, year = {2020})',
    );
  });

  it('does not let an unmatched ) inside a field value truncate the entry', () => {
    const input = '@article(k, title = {Analysis ) Part}, year = {2020})';
    const { ranges } = parseBibtexWithRaw(input);
    expect(input.slice(ranges[0].start, ranges[0].end)).toBe(input);
  });

  it('closes a paren entry on its own delimiter, not a field brace', () => {
    const input = '@article(k, title = {x}) @book(j, title = {y})';
    const { ranges } = parseBibtexWithRaw(input);
    expect(ranges.map((r) => input.slice(r.start, r.end))).toEqual([
      '@article(k, title = {x})',
      '@book(j, title = {y})',
    ]);
  });

  it('splices into a paren entry without rewriting its closer', () => {
    // Deriving the closer from lastIndexOf('}') would emit `}` here and leave
    // an entry that no longer parses.
    const raw = '@article(k,\n  title = {T}\n)';
    expect(spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD},'])).toBe(
      '@article(k,\n  title = {T},\n  zotero-key = {ABCD}\n)',
    );
  });

  it('splices into a paren entry whose last field is already comma-terminated', () => {
    const raw = '@article(k,\n  title = {T},\n)';
    expect(spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD},'])).toBe(
      '@article(k,\n  title = {T},\n  zotero-key = {ABCD}\n)',
    );
  });

  it('leaves text alone when it does not end in a closing delimiter', () => {
    // Callers always pass an exact parsed range, so this is defence in depth:
    // with no delimiter to preserve there is no safe place to splice.
    const raw = '@article{k, title = T';
    expect(spliceFieldsIntoEntry(raw, ['  zotero-key = {ABCD},'])).toBe(raw);
  });
});

describe('delimiting entries that contain blank lines', () => {
  // converter.ts filters newly generated entries by key before appending them
  // to a stored .bib. It used to split that text on blank lines, which cuts an
  // entry in half as soon as a field value contains one — `abstract` and
  // `note` come through from Zotero verbatim and routinely do. The half
  // without the header was then dropped as keyless, appending truncated
  // BibTeX. The parser delimits by structure, so the blank line is payload.
  it('keeps an entry whole when a field value contains a blank line', () => {
    const entryA = '@article{keyA,\n  abstract = {First para.\n\n  Second para.},\n  year = {2020}\n}';
    const entryB = '@book{keyB,\n  title = {T}\n}';
    const generated = entryA + '\n\n' + entryB;

    const { ranges } = parseBibtexWithRaw(generated);
    expect(ranges.map((r) => r.key)).toEqual(['keyA', 'keyB']);
    expect(generated.slice(ranges[0].start, ranges[0].end)).toBe(entryA);
    expect(generated.slice(ranges[1].start, ranges[1].end)).toBe(entryB);
  });
});

describe('entries inside % comments', () => {
  // BibTeX ignores the rest of a line after `%`, so an entry-shaped run of
  // characters there is prose. Reporting it would hand out a range that a
  // splice could write into — and since only the first line carries the `%`,
  // a multi-line splice would push part of it back out of the comment.
  it('does not report an entry commented out with %', () => {
    const { parsed, ranges } = parseBibtexWithRaw('% @article{fake, t = {T}}\n@book{real, t = {R}}');
    expect(ranges.map((r) => r.key)).toEqual(['real']);
    expect([...parsed.keys()]).toEqual(['real']);
  });

  it('skips the whole comment line, not just the first header on it', () => {
    const text = '@a{one, t={1}} % note @b{fake, t={2}} @c{alsofake, t={3}}\n@d{two, t={4}}';
    const { ranges } = parseBibtexWithRaw(text);
    expect(ranges.map((r) => r.key)).toEqual(['one', 'two']);
  });

  it('handles consecutive comment lines', () => {
    const { ranges } = parseBibtexWithRaw('% @a{x, t={1}}\n% @b{y, t={2}}\n@book{real, t = {R}}');
    expect(ranges.map((r) => r.key)).toEqual(['real']);
  });

  it('handles a comment that ends the text without a newline', () => {
    const { ranges } = parseBibtexWithRaw('@book{real, t = {R}}\n% @a{fake, t={1}}');
    expect(ranges.map((r) => r.key)).toEqual(['real']);
  });

  it('does not let a % inside a field value comment out a later entry', () => {
    // `50% off` is field payload. The comment search stops at the start of the
    // gap, so it never reads that `%` out of the preceding entry.
    const { ranges } = parseBibtexWithRaw('@article{a, note = {50% off}} @book{real, t = {R}}');
    expect(ranges.map((r) => r.key)).toEqual(['a', 'real']);
  });

  it('does not let a % inside a field value comment out an adjacent entry', () => {
    // Same, with no whitespace at all between the two entries.
    const { ranges } = parseBibtexWithRaw('@article{a, note = {50% off}}@book{real, t = {R}}');
    expect(ranges.map((r) => r.key)).toEqual(['a', 'real']);
  });

  it('does not let a % inside a keyless construct comment out what follows', () => {
    // The `%` sits inside `@book{...}`'s balanced body, which is that
    // construct's content, not ignored text — so it comments out nothing after
    // the construct ends. Found by fuzzing.
    const text = '@book{x@@% @book{nested, t={1}}} @book{real, t = {y}}';
    const { ranges } = parseBibtexWithRaw(text);
    expect(ranges.map((r) => r.key)).toEqual(['real']);
    expect(ranges[0].trusted).toBe(true);
  });

  it('leaves a % inside an @comment body alone', () => {
    const { ranges } = parseBibtexWithRaw('@comment{% @a{fake, t={1}}}\n@book{real, t = {R}}');
    expect(ranges.map((r) => r.key)).toEqual(['real']);
  });
});

describe('parseBibtexWithRaw constructEnds', () => {
  // `constructEnds` is deliberately off the public result type — only
  // `detectBibtexEol` consumes it, and a caller could mistake it for entries.
  // These tests pin the boundary rules directly rather than only through the
  // line-ending behavior they drive, so reach it by an explicit cast.
  const scan = (text: string) =>
    parseBibtexWithRaw(text) as ReturnType<typeof parseBibtexWithRaw> & { constructEnds: number[] };

  // Boundaries, not entries: they mark where the scanner last stood outside
  // every construct, including the pseudo-entries that never become ranges.
  it('records an end for every cleanly consumed construct', () => {
    const text = '@comment{x}@article{k, t = {T}}@string(y = {z})';
    const { constructEnds, ranges } = scan(text);
    expect(ranges.map((r) => r.key)).toEqual(['k']);
    expect(constructEnds).toEqual([11, 31, 47]);
    for (const end of constructEnds) {
      expect(text[end - 1] === '}' || text[end - 1] === ')').toBe(true);
    }
  });

  it('records nothing for a construct it could not delimit', () => {
    const { constructEnds } = scan('@article{k, t = {unclosed');
    expect(constructEnds).toEqual([]);
  });

  it('records nothing found after sync is lost, balanced or not', () => {
    // `fake` is internally balanced but may well be sitting inside `bad`'s
    // unclosed field value, so it marks no known top-level position.
    const { constructEnds, ranges } = scan(
      '@article{bad, title = {x\n@book{fake, t = {y}}\n',
    );
    expect(ranges.map((r) => r.trusted)).toEqual([false]);
    expect(constructEnds).toEqual([]);
  });

  it('keeps ends recorded before sync was lost', () => {
    const text = '@article{ok, t = {T}}\n@article{bad, title = {x\n@book{fake, t = {y}}\n';
    const { constructEnds } = scan(text);
    expect(constructEnds).toEqual([21]);
    expect(text[constructEnds[0] - 1]).toBe('}');
  });
});

describe('detectBibtexEol tie boundary', () => {
  // On a tie the sampled newline must come from the gap *between* constructs.
  // Reaching for the next newline anywhere after an entry lands inside the
  // following one and reports its interior ending as the document's.
  it('samples the gap after an entry, not the next entry interior', () => {
    const text = '@article{a,\r\n  note = {x\ny}\r\n}\r\n\r\n@book{b,\r\n  title = {T}\r\n}';
    expect(detectBibtexEol(text)).toBe('\r\n');
  });

  it('is symmetric for the mirror-image LF document', () => {
    const text = '@article{a,\n  note = {x\r\ny}\n}\n\n@book{b,\n  title = {T}\n}';
    expect(detectBibtexEol(text)).toBe('\n');
  });

  it('falls back to the leading gap when the entry ends the text', () => {
    const text = '\r\n@article{a,\r\n  note = {x\ny}}';
    expect(detectBibtexEol(text)).toBe('\r\n');
  });

  it('reaches the structural newline behind a top-level % comment', () => {
    // One bare LF inside a field, one CRLF outside the entry: a tie. Stopping
    // the gap scan at the `%` would leave only the field's LF to fall back on.
    expect(detectBibtexEol('@article{k, note = {a\nb}}% trailing comment\r\n')).toBe('\r\n');
  });

  it('stops the gap scan at the next entry rather than reading into it', () => {
    // A genuine tie with no structural newline anywhere: each entry hides one
    // in a field value and the gap between them has none. Without the header
    // guard the forward scan would run into `b` and answer with its CRLF.
    const text = '@article{a, note = {x\ny}}   @book{b, t = {A\r\nB}}';
    expect(detectBibtexEol(text)).toBe('\n');
  });

  it('walks past delimiters and stray @ signs in a trailing comment', () => {
    // A `}`, `)` or `@` out here is a character in ignored text, not a
    // boundary. Stopping on one hides the structural newline behind it and
    // leaves only a field's interior newline to fall back on.
    for (const comment of ['% stray } here', '% stray ) here', '% ask a@b.com']) {
      const text = '@article{k, note = {a\nb}}' + comment + '\r\n';
      expect(detectBibtexEol(text)).toBe('\r\n');
    }
  });

  it('does not skip a newline the header guard looked across', () => {
    // `@book\r\n{b, …}` is a real header — the scanner accepts a newline before
    // the delimiter — but that newline is structural and is exactly what the
    // tie needs. The guard must not answer `true` from across it.
    const text = '@article{a, note = {x\ny}}@book\r\n{b, title = {T}}';
    expect(detectBibtexEol(text)).toBe('\r\n');
  });

  it('does not treat a construct header inside a comment as a boundary', () => {
    // `@book{` is prose once a `%` has opened a comment, so the scan continues
    // to the real line ending rather than stopping short.
    const text = '@article{k, note = {a\nb}}% see @book{other}\r\n';
    expect(detectBibtexEol(text)).toBe('\r\n');
  });

  it('requires a real header, not a bare @, to stop the scan', () => {
    // `@ ` with no type name is prose. The tie must resolve from the CRLF
    // after it, not from the field's LF.
    const text = '@article{k, note = {a\nb}} @ \r\n';
    expect(detectBibtexEol(text)).toBe('\r\n');
  });

  it('anchors on a pseudo-entry that ends the text', () => {
    // `@comment` never becomes a range, but the newline after it is as
    // structural as any other. Without a boundary there, the tie falls back to
    // the payload LF inside `note`.
    expect(detectBibtexEol('@article{k, note = {a\nb}}@comment{aside}\r\n')).toBe('\r\n');
  });

  it('anchors on a pseudo-entry sitting between two entries', () => {
    const text = '@article{k, note = {a\nb}}@comment{aside}\r\n@book{b, title = {T}}';
    expect(detectBibtexEol(text)).toBe('\r\n');
  });

  it('anchors on @string and @preamble too', () => {
    expect(detectBibtexEol('@article{k, note = {a\nb}}@string(x = {y})\r\n')).toBe('\r\n');
    expect(detectBibtexEol('@article{k, note = {a\nb}}@preamble{"x"}\r\n')).toBe('\r\n');
  });

  it('anchors on a keyless header the scanner consumed', () => {
    expect(detectBibtexEol('@article{}\r\n@book{k, note = {a\nb}}')).toBe('\r\n');
  });

  it('still samples the leading gap when nothing follows any construct', () => {
    // The forward pass finds nothing, so the gap before the first construct is
    // the only anchor left.
    expect(detectBibtexEol('\r\n@article{k, note = {a\nb}}')).toBe('\r\n');
  });

  it('does not anchor on a construct recovered after sync loss', () => {
    // Two leading top-level CRLFs against two bare LFs inside `bad`'s unclosed
    // field value. `fake` is balanced but not known to be top-level, so the LF
    // after it is payload — the leading gap is the only real anchor.
    const text = '\r\n\r\n@article{bad, title = {x\n@book{fake, t = {y}}\n';
    expect(detectBibtexEol(text)).toBe('\r\n');
  });

  it('still anchors on constructs recorded before sync was lost', () => {
    const text = '@article{ok, t = {T}}\r\n@article{bad, title = {x\n';
    expect(detectBibtexEol(text)).toBe('\r\n');
  });

  it('ignores untrusted ranges when sampling the boundary', () => {
    // `bad` is never closed, so `good` is only recovered at a line start and
    // may well sit inside `bad`'s field value. The LF preceding it is not
    // inter-construct whitespace, and must not outvote the document's CRLF.
    const text = '@article{bad,\r\n  title = {unclosed\n@book{good, t = {y}}';
    const { ranges } = parseBibtexWithRaw(text);
    expect(ranges.map((r) => r.trusted)).toEqual([false]);
    expect(detectBibtexEol(text)).toBe('\r\n');
  });
});


describe('scanBibtexEntryBody', () => {
  const scan = (raw: string) => scanBibtexEntryBody(raw);

  it('lists field names in source order, including repeats', () => {
    const raw = '@article{k,\n  title = {T},\n  doi = {10.1/a},\n  doi = {10.1/b}\n}';
    expect(scan(raw).fieldNames).toEqual(['title', 'doi', 'doi']);
  });

  it('reads a field name whole whatever it starts with', () => {
    // BibTeX field names are not identifiers: everything up to the separator
    // belongs to the name.  Reporting `doi` for `:doi` would let a caller act
    // on an identifier the entry does not have.
    expect(scan('@article{k,\n  _doi = {10.1/a}\n}').fields).toEqual([
      { name: '_doi', value: '10.1/a', delimiter: 'brace' },
    ]);
    for (const name of ['1doi', ':doi', '+doi', '.doi', '/doi', '@doi', '-doi']) {
      expect(scan('@article{k,\n  ' + name + ' = {10.1/a}\n}').fieldNames).toEqual([name]);
    }
  });

  it('does not mistake a bare value for a field name', () => {
    // `jan` is a value here, not a field: no `=` follows it.
    expect(scan('@article{k,\n  month = jan,\n  year = {2020}\n}').fieldNames)
      .toEqual(['month', 'year']);
  });

  it('reports a percent at the entry own level', () => {
    expect(scan('@article{k,\n  doi = {10.1/a} % note\n}').hasTopLevelComment).toBe(true);
    expect(scan('@article{k,\n%  doi = {10.1/a}\n}').hasTopLevelComment).toBe(true);
  });

  it('does not report a percent inside a field value', () => {
    expect(scan('@article{k,\n  note = {50% off}\n}').hasTopLevelComment).toBe(false);
    expect(scan('@article{k,\n  note = "50% off"\n}').hasTopLevelComment).toBe(false);
    expect(scan('@article{k,\n  note = {50\\% off}\n}').hasTopLevelComment).toBe(false);
  });

  it('does not report an escaped percent at the top level', () => {
    expect(scan('@article{k,\n  title = {T} \\% x\n}').hasTopLevelComment).toBe(false);
  });

  it('reports concatenation at the entry own level only', () => {
    expect(scan('@article{k,\n  doi = "10.1/" # "a"\n}').hasConcatenation).toBe(true);
    expect(scan('@article{k,\n  note = {issue #3}\n}').hasConcatenation).toBe(false);
    expect(scan('@article{k,\n  note = "issue #3"\n}').hasConcatenation).toBe(false);
  });

  it('reads a paren-delimited entry', () => {
    const raw = '@article(k,\n  doi = {10.1/a} % note\n)';
    expect(scan(raw).fieldNames).toEqual(['doi']);
    expect(scan(raw).hasTopLevelComment).toBe(true);
  });

  it('treats a brace-protected quote inside a quoted value as data', () => {
    const raw = '@article{k,\n  title = "a {"} b",\n  doi = {10.1/a}\n}';
    expect(scan(raw).fieldNames).toEqual(['title', 'doi']);
    expect(scan(raw).hasTopLevelComment).toBe(false);
  });

  it('returns each field occurrence with the value it read', () => {
    const raw = '@article{k,\n  title = {T},\n  note = "q",\n  year = 2020\n}';
    expect(scan(raw).fields).toEqual([
      { name: 'title', value: 'T', delimiter: 'brace' },
      { name: 'note', value: 'q', delimiter: 'quote' },
      { name: 'year', value: '2020', delimiter: 'bare' },
    ]);
  });

  it('does not report field-shaped text inside a value', () => {
    const raw = '@article{k,\n  note = {see doi = {10.1/b} there},\n  doi = {10.1/a}\n}';
    expect(scan(raw).fields.map(f => f.name)).toEqual(['note', 'doi']);
  });

  it('reads repeated fields on one line', () => {
    const raw = '@article{k, doi = {10.1/a}, doi = {10.1/b}}';
    expect(scan(raw).fields.map(f => f.value)).toEqual(['10.1/a', '10.1/b']);
  });

  it('reports an entry whose escaped brace unbalances the body', () => {
    // The range was measured with escapes counted as structural, so the value
    // here swallows the range's own closing brace.  Which reading is right
    // depends on the tool; either way the boundaries cannot be trusted.
    expect(scan('@article{k,\n  note = {literal \\} brace}').unbalanced).toBe(true);
  });

  it('does not report balanced escaped braces as unbalanced', () => {
    expect(scan('@article{k,\n  title = {A \\{b\\} c}\n}').unbalanced).toBe(false);
  });

  it('returns nothing for text that is not an entry', () => {
    expect(scan('not an entry')).toEqual({
      hasTopLevelComment: false,
      hasConcatenation: false,
      fieldNames: [],
      fields: [],
      unbalanced: false,
    });
  });
});
