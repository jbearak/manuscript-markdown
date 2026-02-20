import { describe, it, expect } from 'bun:test';
import { parseBibtex, serializeBibtex, stripOuterBraces, BibtexEntry } from './bibtex-parser';

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
