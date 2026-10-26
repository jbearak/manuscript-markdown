import { describe, it, expect } from 'bun:test';
import { parseBibtex, parseBibtexWithRaw, scanBibtexEntryBody, findDuplicateBibtexKeys, detectBibtexEol, detectEntryEol, serializeBibtex, BIBTEX_TEXT_SYMBOLS, bibtexFieldAsPlainText, stripOuterBraces, stripWrappingBraces, mergeBibtex, extractRawField, spliceFieldsIntoEntry, BibtexEntry } from './bibtex-parser';
import { fastestRun } from './test-timing';
import { parseAuthors } from './md-to-docx-citations';

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
      expect(fastestRun(() => expect(stripWrappingBraces(wrapped)).toBe('x'))).toBeLessThan(1000);
    }, 30000);
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

describe('BibTeX text symbols', () => {
  // A letter's or symbol's command, as \ss or \textregistered, stayed as it
  // was written, so citeproc showed Stra\ss e
  const field = (name: string, value: string) => parseBibtex('@article{k,\n  ' + name + ' = {' + value + '}\n}').get('k')?.fields.get(name);

  it.each([
    ['a letter, with the space after it, which ends its command', String.raw`Stra\ss e`, 'Stra\u00DFe'],
    ['a letter with an empty group after it', String.raw`Stra\ss{}e`, 'Stra\u00DFe'],
    ['a letter in a group', String.raw`Stra{\ss}e`, 'Stra\u00DFe'],
    ['a letter in a group, with a space', String.raw`J{\o }rgensen`, 'J\u00F8rgensen'],
    ['a capital letter', String.raw`\O{}stergaard`, '\u00D8stergaard'],
    // Whose braces are the command's
    ['a capital letter as a command\'s argument', String.raw`A \textsc{\O} B`, 'A \\textsc{\u00D8} B'],
    ['a capital letter as a command\'s argument after a space', String.raw`A \textsc {\O} B`, 'A \\textsc {\u00D8} B'],
    ['a capital letter as a command\'s second argument', String.raw`A \textcolor{red}{\O} B`, 'A \\textcolor{red}{\u00D8} B'],
    ['a capital letter as a command\'s second argument after a space', String.raw`A \textcolor{red} {\O} B`, 'A \\textcolor{red} {\u00D8} B'],
    ['a capital letter as a command\'s second argument after a command\'s group', String.raw`A \textcolor{\mycolor}{\O} B`, 'A \\textcolor{\\mycolor}{\u00D8} B'],
    ['a letter as a command\'s second argument after a letter\'s group', String.raw`\texorpdfstring{\ss}{\o}`, '\\texorpdfstring{\u00DF}{\u00F8}'],
    // Whose braces stay after any group a command could take as its
    // argument, but not after a letter read as its letter, which takes
    // none, as read so far
    ['letters in groups after a letter\'s group', String.raw`{\l}{\L}`, '\u0142\u0141'],
    ['a letter in a group after a letter\'s command and its empty group', String.raw`\OE{} {\l}`, '\u0152 \u0142'],
    ['a letter in a group after a letter\'s command', String.raw`\ss{\O}`, '\u00DF\u00D8'],
    // Whose empty group, after the space that ends the command, is nothing
    ['a letter, a space and an empty group', String.raw`Stra\ss {}e`, 'Stra\u00DFe'],
    ['a letter that starts a group with more in it', String.raw`H. C. {\O rsted}`, 'H. C. {\u00D8rsted}'],
    ['letters of other languages', String.raw`{\AA}ngstr{\"o}m \ae{} \OE{} \l{}\L{} \i{} \th{}`, '\u00C5ngstr\u00F6m \u00E6 \u0152 \u0142\u0141 \u0131 \u00FE'],
    ['symbols', String.raw`\textregistered{} \copyright{} \texttrademark{} \dag{} \ddag{} \S{} \P{}`, '\u00AE \u00A9 \u2122 \u2020 \u2021 \u00A7 \u00B6'],
    ['a symbol with the space after it, which ends its command', String.raw`\S 3`, '\u00A73'],
    ['dashes and an ellipsis', String.raw`a\textendash{}b\textemdash{}c\ldots`, 'a\u2013b\u2014c\u2026'],
    ['quotation marks', String.raw`\textquotedblleft{}a\textquotedblright{} \guillemotleft{}b\guillemotright`, '\u201Ca\u201D \u00ABb\u00BB'],
    ['currency and units', String.raw`\pounds 5, \texteuro{}6, 20\textdegree{}C`, '\u00A35, \u20AC6, 20\u00B0C'],
    // Whose control space stays as written (see below)
    ['a symbol before a control space', String.raw`\dag\ y`, '\u2020\\ y'],
  ])('reads %s as the character LaTeX prints', (_name, value, expected) => {
    expect(field('title', value)).toBe(expected);
  });

  it.each([
    // pandoc 3.12 drops it, as a command it doesn't know, which stays as
    // written here
    ['\\SS', String.raw`STRA\SS E`, String.raw`STRA\SS E`],
    ['a longer command it doesn\'t know', String.raw`\ssx b`, String.raw`\ssx b`],
    ['a symbol with its empty group in a group', String.raw`{\textasciicircum{}} x`, '{^} x'],
    ['an accent on a dotless i', String.raw`\"{\i}`, '\u00EF'],
    // The commands of the other characters that are BibTeX's or TeX's
    // syntax, which stay as written: a backslash, whose escape, \\, LaTeX
    // reads as a line break
    ['a backslash', String.raw`a\textbackslash{}b`, String.raw`a\textbackslash{}b`],
    ['a tilde and a circumflex without their empty group', String.raw`a\textasciitilde b\textasciicircum c`, String.raw`a\textasciitilde b\textasciicircum c`],
    ['quotes that make a ligature in pairs', String.raw`\textquotesingle\textquotesingle{} \textasciigrave\textasciigrave{}`, String.raw`\textquotesingle\textquotesingle{} \textasciigrave\textasciigrave{}`],
  ])('reads %s as before', (_name, value, expected) => {
    expect(field('title', value)).toBe(expected);
  });

  // The commands of a brace and a dollar sign, as the escapes a value as TeX
  // keeps, which stayed as written while a value had no TeX
  it.each([
    ['braces', String.raw`\textbraceleft{}a\textbraceright{}`, '{a}', String.raw`\{a\}`],
    ['braces in groups of their own', String.raw`{\textbraceleft}a{\textbraceright}`, '{a}', String.raw`\{a\}`],
    ['a dollar sign', String.raw`\textdollar{}5 or \textdollar 6`, '$5 or $6', String.raw`\$5 or \$6`],
  ])('reads %s as the characters, kept as TeX as their escapes', (_name, value, text, tex) => {
    const entry = parseBibtex('@article{k,\n  title = {' + value + '}\n}').get('k')!;
    expect(entry.fields.get('title')).toBe(text);
    expect(entry.texFields?.get('title')).toBe(tex);
  });

  it('reads a title with each of their commands back the same once it\'s written', () => {
    for (const command of ['textbraceleft', 'textbraceright', 'textdollar']) {
      for (const written of ['A \\' + command + '{} B', 'A {\\' + command + '} B', 'A \\' + command + ' B']) {
        const once = parseBibtex('@article{k,\n  title = {' + written + '},\n  year = {2020}\n}').get('k')!;
        const twice = parseBibtex(serializeBibtex(new Map([['k', once]]))).get('k');
        expect(twice?.fields.get('title')).toBe(once.fields.get('title'));
        expect(twice?.texFields?.get('title')).toBe(once.texFields?.get('title'));
        expect(twice?.fields.get('year')).toBe('2020');
      }
    }
  });

  // A lone brace's command read as written, as \textbraceleft{}, which the
  // .bib file written back held escaped; or a brace alone in a value
  // written back as an escaped brace, which the scanner counts, so the
  // entry read on past its end, or ended at the brace
  it.each([
    ['a left brace alone', String.raw`A \textbraceleft{} B`, 'A { B', String.raw`{A \textbraceleft{} B}`],
    ['a right brace alone', String.raw`A \textbraceright{} B`, 'A } B', String.raw`{A \textbraceright{} B}`],
    ['a right brace before a left one, each alone', String.raw`\textbraceright{}A\textbraceleft{}`, '}A{', String.raw`{\textbraceright{}A\textbraceleft{}}`],
    ['a brace alone among braces that pair', String.raw`\{a\} \textbraceright{} {b}`, '{a} } {b}', String.raw`{\{a\} \textbraceright{} \{b\}}`],
  ])('reads %s as the brace, and writes it back as its command, so the entry reads back whole', (_name, value, text, written) => {
    const once = parseBibtex('@article{k,\n  title = {' + value + '},\n  year = {2020}\n}');
    expect(once.get('k')!.fields.get('title')).toBe(text);
    const serialized = serializeBibtex(once);
    expect(serialized).toContain('title = ' + written + ',');
    const twice = parseBibtex(serialized).get('k');
    expect(twice?.fields.get('title')).toBe(text);
    expect(twice?.fields.get('year')).toBe('2020');
  });

  // In math too
  it('reads a brace alone in math as the brace, and writes the value as text, so the entry reads back whole', () => {
    const once = parseBibtex('@article{k,\n  title = {' + String.raw`$\textbraceleft$ x` + '},\n  year = {2020}\n}');
    expect(once.get('k')!.fields.get('title')).toBe('${$ x');
    const serialized = serializeBibtex(once);
    expect(serialized).toContain('title = {' + String.raw`\$\textbraceleft{}\$ x` + '},');
    const twice = parseBibtex(serialized).get('k');
    expect(twice?.fields.get('title')).toBe('${$ x');
    expect(twice?.fields.get('year')).toBe('2020');
  });

  // A value with no TeX, as DOCX import's, whose brace alone was written
  // escaped, so the entry read on past its end
  it.each([
    ['a left brace alone', 'A { B'],
    ['a right brace alone', 'A } B'],
    ['braces that don\'t pair', '}A{ {b}'],
  ])('writes %s in a value with no TeX as commands, so the entry reads back whole', (_name, title) => {
    const entry: BibtexEntry = { type: 'article', key: 'k', fields: new Map([['title', title], ['year', '2020']]) };
    const twice = parseBibtex(serializeBibtex(new Map([['k', entry]]))).get('k');
    expect(twice?.fields.get('title')).toBe(title);
    expect(twice?.fields.get('year')).toBe('2020');
  });

  it('shows a brace\'s command as the brace in the language server', () => {
    const entry = parseBibtex('@article{k,\n  title = {A \\textbraceleft{} {B} \\textdollar{}5}\n}').get('k')!;
    expect(bibtexFieldAsPlainText(entry, 'title')).toBe('A { B $5');
  });

  // Braces read before the names were split hid the and between them
  it('splits names at an and between brace commands', () => {
    expect(parseAuthors(field('author', String.raw`Jane \textbraceleft{}Doe and Smith\textbraceright{}, John`)!)).toHaveLength(2);
  });

  it.each([
    ['author', String.raw`\textbackslash{}Doe and \textdollar{}Smith, \textbraceleft{}Jane`],
  ])('reads the commands of a brace, a backslash and a dollar sign in %s as before', (name, value) => {
    expect(field(name, value)).toBe(value);
  });

  // A bracket's command read as the bracket, so a bracket with the rest of
  // a tag written as it is, as in <i\textgreater{}, made a tag of
  // formatting, which citeproc read as italic, and dropped
  it.each([
    ['a closing bracket after the rest of a tag', String.raw`<i\textgreater{}x</i\textgreater{}`],
    ['an opening bracket before the rest of a tag', String.raw`\textless{}i>x`],
    ['brackets around a letter', String.raw`\textless{}i\textgreater{}x\textless{}/i\textgreater{}`],
    ['a straight double quote', String.raw`\textquotedbl{}x\textquotedbl{}`],
    // A control space, which, as a space, completed a tag
    ['a control space in a tag', String.raw`A <span\ class="nocase">TEST</span> B`],
  ])('reads %s as before', (_name, value) => {
    expect(field('title', value)).toBe(value);
  });

  // Which TeX reads as a character, not as the command's end, and a note
  // keeps a line end, which citeproc reads a line at a time
  it.each([
    ['a note\'s line end', 'note', 'A \\ss\noriginal-date: 1850', 'A \u00DF\noriginal-date: 1850'],
    ['a no-break space', 'title', 'a \\ss\u00A0b', 'a \u00DF\u00A0b'],
  ])('keeps %s after a letter\'s command', (_name, name, value, expected) => {
    expect(field(name, value)).toBe(expected);
  });

  // As on main: BibTeX splits names, and reads a word's case, before TeX
  // reads a command, and serializeBibtex would have to write a name back
  // as it was read, a later step's
  it.each([
    ['author', String.raw`Gau\ss and Doe, Jane`, String.raw`Gau\ss and Doe, Jane`],
    ['editor', String.raw`{\dh}orsteinn Meier, Hans`, String.raw`{\dh}orsteinn Meier, Hans`],
    ['author', String.raw`{Gau\ss\ Inc.} and \\ss`, String.raw`{Gau\ss\ Inc.} and \ss`],
  ])('reads the text symbols\' commands in %s as before', (name, value, expected) => {
    expect(field(name, value)).toBe(expected);
  });

  it('reads a title with each text symbol\'s command back the same once it\'s written', () => {
    for (const command of Object.keys(BIBTEX_TEXT_SYMBOLS)) {
      for (const written of ['A \\' + command + '{} B', 'A {\\' + command + '} B', 'A \\' + command + ' B']) {
        const once = parseBibtex('@article{k,\n  title = {' + written + '}\n}');
        const twice = parseBibtex(serializeBibtex(once));
        expect(twice.get('k')!.fields.get('title')).toBe(once.get('k')!.fields.get('title'));
      }
    }
  });

  it('writes a symbol back as its character, which reads back the same', () => {
    const once = parseBibtex('@article{k,\n  title = {Stra\\ss e \\textregistered{}}\n}');
    const serialized = serializeBibtex(once);
    expect(serialized).toContain('title = {Stra\u00DFe \u00AE}');
    expect(parseBibtex(serialized).get('k')!.fields.get('title')).toBe(once.get('k')!.fields.get('title'));
  });
});

describe('BibTeX ties, empty groups and \\url', () => {
  // A tie, an empty group and a \url stayed as written, so citeproc showed
  // a~b, a-{}-b and \url{https://e.com/a_b}
  const field = (name: string, value: string) => parseBibtex('@article{k,\n  ' + name + ' = {' + value + '}\n}').get('k')?.fields.get(name);

  it.each([
    ['a tie, a no-break space', String.raw`a~b`, 'a\u00A0b'],
    ['ties around spaces and together', String.raw`a ~ b, x~~y`, 'a \u00A0 b, x\u00A0\u00A0y'],
    ['a tie in a group', String.raw`{a~b} c`, '{a\u00A0b} c'],
    ['an empty group, which is nothing', String.raw`a{}b`, 'ab'],
    ['a tilde\'s and a circumflex\'s accent on nothing', String.raw`\~{} and \^{}`, '~ and ^'],
    ['a \\url\'s argument, as written', String.raw`See \url{https://e.com/a_b~c--d}.`, 'See https://e.com/a_b~c--d.'],
    ['a \\url\'s argument after a space', String.raw`\url {e.com}`, 'e.com'],
    ['a \\url\'s escaped characters', String.raw`\url{a\_b\%c\#d\&e\~f\{g\}h\\i}`, 'a_b%c#d&e~f{g}h\\i'],
    ['a \\url\'s groups', String.raw`\url{a{b}c}`, 'a{b}c'],
    ['an empty \\url', String.raw`a\url{}b`, 'ab'],
    // A $ that ends no math is text
    ['a tie after a $ that ends no math', String.raw`$5 and a~b`, '$5 and a\u00A0b'],
    ['a tie between escaped $', String.raw`\$ a~b \$`, '$ a\u00A0b $'],
    ['a \\url\'s escaped caret', String.raw`\url{https://e.com/a\^b}`, 'https://e.com/a^b'],
    ['a \\url\'s escaped braces that pair', String.raw`\url{a\{b\}c}`, 'a{b}c'],
    // Whose spaces are one, as BibTeX reads a field's
    ['an empty group between spaces', String.raw`a {} b`, 'a b'],
    ['an empty group at an edge, before a space', String.raw`{} a`, 'a'],
  ])('reads %s as TeX prints it', (_name, value, expected) => {
    expect(field('title', value)).toBe(expected);
  });

  it.each([
    // Math, which this doesn't read yet, where a ~ is math's
    ['a tie and an empty group in math', String.raw`$a~b{}$ c`, '$a~b{}$ c'],
    // Display math, with two $ on each side, joined so that the source
    // has no pair of $, which text replacement corrupts
    ['a tie in display math', '$' + '$a~b$' + '$', '$' + '$a~b$' + '$'],
    ['a tie in math after a display math\'s $ alone', '$' + '$a$b~c$' + '$', '$' + '$a$b~c$' + '$'],
    ['a tie in math after inline math', String.raw`$a$ and $b~c$`, '$a$ and $b~c$'],
    // A command this doesn't know, with the group that ends it
    ['a command\'s empty group', String.raw`\foo{}bar`, String.raw`\foo{}bar`],
    ['an accent\'s empty group', String.raw`\"{}x`, String.raw`\"{}x`],
    // A tilde's accent, whose ~ is no tie
    ['a tilde\'s accent before a space', String.raw`\~ x`, String.raw`\~ x`],
    ['a \\url with no group', String.raw`\url x`, String.raw`\url x`],
    // A \url whose argument's braces, counting the escaped ones, don't
    // pair, as main reads it, whose argument read as it prints would have
    // braces that don't pair, which the .bib file written back would hold
    // escaped, which the scanner counts
    ['a \\url whose braces don\'t pair', String.raw`\url{\}x\{}`, String.raw`\url{}x{}`],
    ['a tie in a \\url whose braces don\'t pair', String.raw`\url{\}a~\{}`, String.raw`\url{}a~{}`],
    // Whether or not a $ before it starts math
    ['a \\url whose braces don\'t pair after a $ that ends no math', String.raw`$5 \url{\}a{}~\{}`, String.raw`$5 \url{}a{}~{}`],
    ['a \\url whose braces don\'t pair after math', String.raw`$5$ \url{\}a{}~\{}`, String.raw`$5$ \url{}a{}~{}`],
    ['a \\url whose braces don\'t pair in math', String.raw`$5 \url{\}a{}~\{}$`, String.raw`$5 \url{}a{}~{}$`],
    // Math, where a \url, \~{} and \^{} are math's
    ['a \\url in math', String.raw`$\url{a~b}$`, String.raw`$\url{a~b}$`],
    ['a tilde\'s and a circumflex\'s accent on nothing in math', String.raw`$\^{}$ and $\~{}$`, String.raw`$\^{}$ and $\~{}$`],
    // An empty group a command could take as its argument, as a symbol's
    // group does (see 'BibTeX text symbols')
    ['an empty group after a command and a space', String.raw`\foo {}bar`, String.raw`\foo {}bar`],
    ['an empty group after a command\'s group', String.raw`\textcolor{red}{} x`, String.raw`\textcolor{red}{} x`],
    ['a longer command', String.raw`\urlx{a}`, String.raw`\urlx{a}`],
  ])('reads %s as before', (_name, value, expected) => {
    expect(field('title', value)).toBe(expected);
  });

  it.each([
    ['url', 'http://x/~a{}b'],
    ['doi', '10.1/a~b{}'],
  ])('keeps a %s as written', (name, value) => {
    expect(field(name, value)).toBe(value);
  });

  // As on main: BibTeX splits a name's words at a tie once it has split the
  // names, so the names would need their ties read once they're split, a
  // later step's
  it.each([
    ['a \\url whose braces don\'t pair', String.raw`\url{\}x\{}`],
    ['a tie after a \\url whose braces don\'t pair', String.raw`\url{\}a~\{} b~c`],
    ['an empty group between spaces', String.raw`a {} b`],
  ])('reads %s back the same once it\'s written', (_name, value) => {
    const once = parseBibtex('@article{k,\n  title = {' + value + '},\n  year = {2020}\n}');
    const twice = parseBibtex(serializeBibtex(once)).get('k');
    expect(twice?.fields.get('title')).toBe(once.get('k')!.fields.get('title'));
    expect(twice?.fields.get('year')).toBe('2020');
  });

  it('keeps ties in names as written', () => {
    expect(field('author', 'D.~E. Knuth and Smith~and~Jones')).toBe('D.~E. Knuth and Smith~and~Jones');
  });

  it('reads \\url arguments that end nothing in linear time', () => {
    // Each \url's { that its \} doesn't close, which a search for the end of
    // each would read to the end of the field
    const value = String.raw`\url{a\}`.repeat(20000);
    expect(fastestRun(() => expect(field('note', value)).toBe(String.raw`\url{a}`.repeat(20000)))).toBeLessThan(500);
  }, 30000);
});

describe('BibTeX dashes and quotes', () => {
  // TeX's ligatures, as -- and ``, stayed as written, so citeproc showed
  // 1990--2000 and ``Title''
  const field = (name: string, value: string) => parseBibtex('@article{k,\n  ' + name + ' = {' + value + '}\n}').get('k')?.fields.get(name);

  it.each([
    ['an en dash', 'title', 'A--B', 'A\u2013B'],
    ['an em dash', 'title', 'A---B', 'A\u2014B'],
    ['four hyphens, an em dash and a hyphen', 'title', 'A----B', 'A\u2014-B'],
    ['double quotes', 'title', "``A'' B", '\u201CA\u201D B'],
    ['a dash and quotes in a group', 'title', "x {``a--b''}", 'x {\u201Ca\u2013b\u201D}'],
    ['a page range', 'pages', '1--10', '1\u201310'],
    ['a dash in a field other than a title', 'publisher', 'A--B', 'A\u2013B'],
    // An empty group breaks a ligature, as import writes one
    ['hyphens an empty group parts', 'title', 'a-{}-b-{}-{}-c', 'a--b---c'],
    ['quotes an empty group parts', 'title', "`{}`a'{}'", "``a''"],
  ])('reads %s as TeX prints it', (_name, name, value, expected) => {
    expect(field(name, value)).toBe(expected);
  });

  it.each([
    ['a hyphen', 'a-b c - d', 'a-b c - d'],
    ['single quotes', "`a' b's", "`a' b's"],
    ['dashes and quotes in math', "$a--b''$ c", "$a--b''$ c"],
    ['a dash in a \\url\'s argument', String.raw`\url{a--b''}`, "a--b''"],
    ['a discretionary hyphen before a hyphen', String.raw`a\--b`, String.raw`a\--b`],
  ])('reads %s as before', (_name, value, expected) => {
    expect(field('title', value)).toBe(expected);
  });

  // As on main: names would need them read once they're split, and
  // serializeBibtex to write them back as they were read, a later step's
  it.each([
    ['author', "Smith--Jones, ``Ann''"],
    ['editor', 'Smith---Jones'],
  ])('keeps dashes and quotes in %s as written', (name, value) => {
    expect(field(name, value)).toBe(value);
  });

  it('writes hyphens and quotes that TeX would join so they read back the same, but not in names', () => {
    const value = "a--b ``c'' d---e";
    const serialized = serializeBibtex(new Map([['k', { type: 'article', key: 'k', fields: new Map([['title', value], ['author', 'Smith--Jones, Ann']]) }]]));
    expect(serialized).toContain("title = {a-{}-b `{}`c'{}' d-{}-{}-e}");
    expect(serialized).toContain('author = {Smith--Jones, Ann}');
    const fields = parseBibtex(serialized).get('k')!.fields;
    expect(fields.get('title')).toBe(value);
    expect(fields.get('author')).toBe('Smith--Jones, Ann');
  });
});

describe('BibTeX values as TeX', () => {
  // A value's escaped braces, as \{, read as the braces, the same as a
  // group's, so the language server, which takes a group's braces off a
  // title, showed \{RNA\} as RNA
  const read = (name: string, value: string) => parseBibtex('@article{k,\n  ' + name + ' = ' + value + ',\n  year = {2020}\n}').get('k')!;

  it.each([
    ['escaped braces', String.raw`\{RNA\} and {RNA}`, String.raw`\{RNA\} and {RNA}`, '{RNA} and {RNA}'],
    ['an escaped backslash', String.raw`a\\b and \foo`, String.raw`a\\b and \foo`, String.raw`a\b and \foo`],
    ['an escaped dollar sign', String.raw`\$5 and 6\$`, String.raw`\$5 and 6\$`, '$5 and 6$'],
    ['a \\url\'s braces, backslashes and dollar signs', String.raw`\url{a{b}\\c\$d$e}`, String.raw`a\{b\}\\c\$d\$e`, String.raw`a{b}\c$d$e`],
  ])('keeps %s escaped in the value as TeX, and reads the text as before', (_name, value, tex, text) => {
    const entry = read('title', '{' + value + '}');
    expect(entry.texFields!.get('title')).toBe(tex);
    expect(entry.fields.get('title')).toBe(text);
  });

  it.each([
    ['author', String.raw`\{Smith\}, John`],
    ['doi', String.raw`10.1/a\{b\}`],
  ])('keeps no TeX of %s, as before', (name, value) => {
    const entry = read(name, '{' + value + '}');
    expect(entry.texFields!.has(name)).toBe(false);
  });

  it.each([
    ['a group and escaped braces', String.raw`{The {RNA} of \{x\}}`, 'The RNA of {x}'],
    ['an escaped backslash and dollar sign', String.raw`{a\\b \$5}`, String.raw`a\b $5`],
  ])('shows %s as plain text', (_name, value, expected) => {
    expect(bibtexFieldAsPlainText(read('title', value), 'title')).toBe(expected);
  });

  it('shows a value with no TeX without its braces, as before', () => {
    const entry: BibtexEntry = { type: 'article', key: 'k', fields: new Map([['title', '{The RNA} of {x}']]) };
    expect(bibtexFieldAsPlainText(entry, 'title')).toBe('The RNA of x');
    expect(bibtexFieldAsPlainText(read('author', String.raw`{{Smith}, John}`), 'author')).toBe('Smith, John');
  });

  // Whether a command could take a group as its argument is read from the
  // value as read so far, kept as it's read (see ArgumentContext)
  it.each([
    ['letters', 'a'.repeat(20000) + '{}'.repeat(20000)],
    ['spaces', 'a' + ' {}'.repeat(60000)],
  ])('reads many empty groups after %s in linear time', (_name, value) => {
    expect(fastestRun(() => read('title', '{' + value + '}'))).toBeLessThan(500);
  }, 30000);

  // Which read the value so far again at each group, which V8 copied each
  // time, as it was built by concatenation, so four times as many groups
  // took sixteen times as long
  it('reads many groups in a note in linear time', () => {
    const time = (n: number) => {
      const value = '{' + '{b} '.repeat(n) + '}';
      return fastestRun(() => read('note', value));
    };
    time(160000);
    expect(time(640000) / time(160000)).toBeLessThan(8);
  }, 30000);

  // An accent's group a command could take as its argument read as the
  // accented letter, without its braces, so the command's name ran into the
  // letter, as \textitx̱
  it.each([
    ['a command\'s group', String.raw`A \textit{\b{x}}`, 'A \\textit{x\u0331}'],
    ['a command\'s group after a space', String.raw`\textsc {\'e}`, '\\textsc {\u00E9}'],
    ['a group after a group', String.raw`\textcolor{red}{\"o}`, '\\textcolor{red}{\u00F6}'],
  ])('reads an accent in %s, keeping a group\'s braces', (_name, value, text) => {
    expect(read('title', '{' + value + '}').fields.get('title')).toBe(text);
  });

  // However long a command's name, or a run of backslashes before one
  it.each([
    ['a command with a long name', '\\' + 'a'.repeat(65) + ' {}X', '\\' + 'a'.repeat(65) + ' {}X'],
    ['a command after many escaped backslashes', '\\\\'.repeat(40) + '\\foo {}X', '\\'.repeat(40) + '\\foo {}X'],
  ])('keeps the empty group after %s as its argument', (_name, value, text) => {
    const once = read('title', '{' + value + '}');
    expect(once.texFields!.get('title')).toBe(value);
    expect(once.fields.get('title')).toBe(text);
  });
});

describe('BibTeX field whitespace', () => {
  // A value wrapped across lines kept its line end and indentation, which
  // citeproc writes as no-break spaces, so the bibliography showed a gap
  const field = (name: string, value: string) => parseBibtex('@article{k,\n  ' + name + ' = ' + value + '\n}').get('k')?.fields.get(name);

  it.each([
    ['a line end and indentation', '{A long title that\n           wraps}', 'A long title that wraps'],
    ['a carriage return and line feed', '{A long title that\r\n\twraps}', 'A long title that wraps'],
    ['runs of spaces and tabs', '{A  long\t\ttitle}', 'A long title'],
    ['whitespace at the edges', '{ A title\n  }', 'A title'],
    ['a quoted value', '"A long title that\n           wraps"', 'A long title that wraps'],
    ['spaces around protecting braces', '{ {RNA} }', 'RNA'],
    ['spaces inside protecting braces', '{{ RNA }}', 'RNA'],
    ['an accent over a line end', '{Fran\\c\n    cois}', 'François'],
  ])('reads %s as one space, or none at an edge', (_name, value, expected) => {
    expect(field('title', value)).toBe(expected);
  });

  it('reads an author list wrapped across lines', () => {
    expect(field('author', '{Doe, Jane and\n    Roe, Rick}')).toBe('Doe, Jane and Roe, Rick');
  });

  it('keeps a no-break space written as itself', () => {
    expect(field('title', '{A\u00A0\n  B}')).toBe('A\u00A0 B');
    expect(field('title', '{\u00A0A }')).toBe('\u00A0A');
  });

  it('keeps a note\'s line ends, which citeproc reads a line at a time', () => {
    expect(field('note', '{original-date: 1850\n    PMID:  123\n}')).toBe('original-date: 1850\nPMID: 123');
  });

  it('reads a note\'s blank lines in linear time', () => {
    // Its trim of line ends at its edges read the rest of a run of them
    // again from each one in it
    expect(fastestRun(() => expect(field('note', '{a' + '\n'.repeat(40000) + 'b}')).toBe('a' + '\n'.repeat(40000) + 'b'))).toBeLessThan(500);
  }, 30000);

  it('drops a note\'s blank lines at its edges, but not between its lines', () => {
    expect(field('note', '{\n \n\ta\n\n \n b \n\n}')).toBe('a\n\n\nb');
    expect(field('note', '{ \n\n }')).toBe('');
  });

  it.each([
    ['url', '{https://example.org/a\n    b}', 'https://example.org/a\n    b'],
    ['doi', '{ 10.1234/abc }', ' 10.1234/abc '],
  ])('leaves %s, which is verbatim, as it is', (name, value, expected) => {
    expect(field(name, value)).toBe(expected);
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
  // Which copied a field as far as a reader that lets a backslash escape any
  // character reads it, where the parser, as BibTeX, counts an escaped brace
  // as a brace: so the note ended at its first ", in the group \{ opens, and
  // in the entry written, the parser read on past it, into the fields after
  it('copies a field the produced entry lacks as the parser reads it', () => {
    const existing = '@article{k,\n  note = "a \\{ b",\n  x = "c \\} d",\n  year = {2020}\n}';
    const produced = '@article{k,\n  title = {T},\n  year = {2020}\n}';
    const before = parseBibtex(existing).get('k')!.fields;
    // One value, to the last ", which holds x's text
    expect(before.get('note')).toContain('x = ');
    expect(before.has('x')).toBe(false);
    const merged = parseBibtex(mergeBibtex(existing, produced)).get('k')!.fields;
    expect(merged.get('note')).toBe(before.get('note'));
    expect(merged.get('title')).toBe('T');
    expect(merged.get('year')).toBe('2020');
  });

  // Which cut each field out of the existing entry: a field last there,
  // with no comma after it, which went before another, as a repeated name
  // keeps its first place among the fields, with no comma between them; a
  // macro on a line after another field, which it wrote in braces, as the
  // text, not the month, and a concatenation, of which it took the first
  // part. Each is written as the parser read it, and the splice adds the
  // commas.
  it.each([
    ['a field last in its entry, before another', '  note = {N1},\n  url = {U},\n  note = {N2}', '  note = {N2},\n  url = {U}'],
    ['a macro on a line after another field', '  month = jan,\n  year = {2020}, month = feb', '  month = feb,\n  year = {2020}'],
    ['a concatenation', '  note = "a " # b #\n    {c},\n  year = 2020', '  note = "a " # b # {c},\n  year = 2020'],
    ['a concatenation last in its entry, on a line after another field', '  year = 2020, note = jan # "~1"', '  year = 2020,\n  note = jan # "~1"'],
  ])('copies %s the produced entry lacks as BibTeX reads it', (_name, body, copied) => {
    const merged = mergeBibtex('@article{k,\n' + body + '\n}', '@article{k,\n  title = {T}\n}');
    expect(merged).toBe('@article{k,\n  title = {T},\n' + copied + '\n}');
  });

  // Which copied a field that uses a macro an @string declares, as
  // note = extra, but none of the file's declarations, so BibTeX warned the
  // macro was undefined and dropped the field's text. The existing file's
  // declarations stay, as written, each before the first entry that came
  // after it there, so BibTeX reads each macro where it read it before
  it.each([
    ['a field that uses a macro an @string declares', '@string{extra = {Custom text}}\n\n@article{k, title = {Title}, note = extra}',
      '@string{extra = {Custom text}}\n\n@article{k,\n  title = {Title},\n  note = extra\n}'],
    ['declarations that use each other, in braces and parens', '@string{a = {A}}\n@string(b = a # {B})\n@article{k, title = {Title}, note = {x} # b}',
      '@string{a = {A}}\n@string(b = a # {B})\n@article{k,\n  title = {Title},\n  note = {x} # b\n}'],
    ['an entry only in the existing file that uses a macro', '@string{extra = {E}}\n@book{b, note = Extra}\n@article{k, title = {Title}}',
      '@string{extra = {E}}\n@book{b, note = Extra}\n@article{k,\n  title = {Title}\n}'],
    ['a declaration between entries, and one after them', '@book{b, note = {N}}\n@STRING{x = {X}}\n@article{k, title = {Title}, note = x}\n@string{y = {Y}}',
      '@book{b, note = {N}}\n@STRING{x = {X}}\n@article{k,\n  title = {Title},\n  note = x\n}\n@string{y = {Y}}'],
    ['a macro declared again between entries', '@string{x = {1}}\n@book{b, note = x}\n@string{x = {2}}\n@article{k, title = {Title}, note = x}',
      '@string{x = {1}}\n@book{b, note = x}\n@string{x = {2}}\n@article{k,\n  title = {Title},\n  note = x\n}'],
    // Guards: a declaration's text in a comment and in a field, which
    // BibTeX reads none in
    ['a declaration\'s text in a comment and in a field', '@comment{@string{x = {X}}}\n@article{k, title = {Title}, note = {@string{y = {Y}}}}',
      '@comment{@string{x = {X}}}\n@article{k,\n  title = {Title},\n  note = {@string{y = {Y}}}\n}'],
  ])('merges %s, with the file\'s declarations where they were', (_name, existing, merged) => {
    expect(mergeBibtex(existing, '@article{k,\n  title = {Title}\n}')).toBe(merged);
  });

  // Which wrote an entry whose key the existing file gives more than once,
  // whose last text and fields the parser keeps, where its first was, so
  // before a declaration only the last follows, of a macro it then used
  // before BibTeX had read it, or before one that declares a macro again,
  // whose value it then read otherwise. It goes where its last was, and
  // each other entry and declaration stays where it was
  it.each([
    ['twice, with a macro declared between them', '@article{k, title = {A}}\n@string{j = "J"}\n@article{k, journal = j}', '@article{k,\n  title = {Title}\n}',
      '@string{j = "J"}\n@article{k,\n  title = {Title},\n  journal = j\n}'],
    ['twice, with a macro declared between them, the last with the produced field', '@article{k, title = {A}}\n@string{x = {X}}\n@article{k, title = {Title}, note = x}', '@article{k,\n  title = {Title}\n}',
      '@string{x = {X}}\n@article{k,\n  title = {Title},\n  note = x\n}'],
    ['twice, with a macro declared between them, which the produced file lacks', '@article{k, title = {A}}\n@string{j = "J"}\n@article{k, journal = j}', '@article{p,\n  title = {P}\n}',
      '@string{j = "J"}\n@article{k, journal = j}\n\n@article{p,\n  title = {P}\n}'],
    ['twice, with a macro declared again between them, after an entry that uses it', '@string{x = {1}}\n@article{k, title = {A}}\n@book{b, note = x}\n@string{x = {2}}\n@article{k, note = x}', '@article{k,\n  title = {Title}\n}',
      '@string{x = {1}}\n@book{b, note = x}\n@string{x = {2}}\n@article{k,\n  title = {Title},\n  note = x\n}'],
    ['three times, among other entries', '@book{a, note = {A}}\n@article{k, title = {1}}\n@book{b, note = {B}}\n@article{k, title = {2}}\n@string{j = "J"}\n@book{c, note = {C}}\n@article{k, journal = j}\n@book{d, note = {D}}', '@article{k,\n  title = {Title}\n}',
      '@book{a, note = {A}}\n@book{b, note = {B}}\n@string{j = "J"}\n@book{c, note = {C}}\n@article{k,\n  title = {Title},\n  journal = j\n}\n@book{d, note = {D}}'],
  ])('merges an entry the file gives %s, where its last was', (_name, existing, produced, merged) => {
    expect(mergeBibtex(existing, produced)).toBe(merged);
    expect(mergeBibtex(merged, produced)).toBe(merged);
  });

  // Which wrote the file's entries and declarations alone, with one blank
  // line between each two, so a .bib that went through Word and back lost
  // its % comments, its @comment and @preamble, and its own blank lines
  it.each([
    ['% comments before, between and after its entries',
      '% Header\n% two lines\n\n@article{k, title = {A}}\n\n% Section ----\n\n@book{b, note = {B}}\n% trailing\n',
      '% Header\n% two lines\n\n@article{k,\n  title = {Title}\n}\n\n% Section ----\n\n@book{b, note = {B}}\n% trailing\n'],
    ['a comment right above an entry, and no blank line between two',
      '@book{b, note = {B}}\n% Verified: https://example.org/k\n@article{k, title = {A}}\n@book{c, note = {C}}',
      '@book{b, note = {B}}\n% Verified: https://example.org/k\n@article{k,\n  title = {Title}\n}\n@book{c, note = {C}}'],
    ['two blank lines between entries',
      '@book{b, note = {B}}\n\n\n@article{k, title = {A}}\n',
      '@book{b, note = {B}}\n\n\n@article{k,\n  title = {Title}\n}\n'],
    ['@comment and @preamble',
      '@preamble{"\\newcommand{\\x}{X}"}\n@comment{jabref-meta: databaseType:bibtex;}\n@article{k, title = {A}}',
      '@preamble{"\\newcommand{\\x}{X}"}\n@comment{jabref-meta: databaseType:bibtex;}\n@article{k,\n  title = {Title}\n}'],
  ])('keeps %s as written', (_name, existing, merged) => {
    expect(mergeBibtex(existing, '@article{k,\n  title = {Title}\n}')).toBe(merged);
    expect(mergeBibtex(merged, '@article{k,\n  title = {Title}\n}')).toBe(merged);
  });

  it('appends a produced-only entry after the file\'s last comment, before its own ending', () => {
    const existing = '% Header\n\n@book{b, note = {B}}\n\n% Last section\n';
    expect(mergeBibtex(existing, '@article{n,\n  title = {N}\n}'))
      .toBe('% Header\n\n@book{b, note = {B}}\n\n% Last section\n\n@article{n,\n  title = {N}\n}\n');
  });

  it('appends a produced-only entry in the line ends of a CRLF file', () => {
    const existing = '% Header\r\n\r\n@book{b, note = {B}}\r\n';
    expect(mergeBibtex(existing, '@article{n, title = {N}}'))
      .toBe('% Header\r\n\r\n@book{b, note = {B}}\r\n\r\n@article{n, title = {N}}\r\n');
  });

  it('drops the earlier copies of many repeated keys in linear time', () => {
    const time = (n: number) => {
      const text = Array.from({ length: n }, (_, k) => '@book{d, note = {' + k + '}}\n% c' + k).join('\n') + '\n';
      return fastestRun(() => mergeBibtex(text, '@article{other,\n  title = {T}\n}'));
    };
    time(4000);
    expect(time(16000) / time(4000)).toBeLessThan(8);
  }, 30000);

  // Which dropped an earlier copy of a repeated key, so the text on either
  // side of it joined: a `@comment` before it and a `{` after it then read
  // as a comment that held the entries, or a declaration, up to its `}`
  it.each([
    ['an entry', '@comment\n@book{k, title = {old}}\n{\n@book{b, title = {keep}}\n}\n@book{k, title = {last}}', ['b', 'k']],
    ['a declaration', '@comment\n@book{k, title = {old}}\n{\n@string{x = {X}}\n}\n@book{k, title = {last}, note = x}', ['k']],
  ])('keeps %s that dropping a repeated key would put in a comment', (_name, existing, keys) => {
    const merged = mergeBibtex(existing, '@book{k,\n  title = {new}\n}');
    expect([...parseBibtex(merged).keys()].sort()).toEqual(keys);
    expect(parseBibtexWithRaw(merged).rangesTrusted).toBe(true);
    if (existing.includes('@string')) expect(merged).toMatch(/^@string\{x = \{X\}\}\n\n@book\{k,/);
  });

  // Guard: a file the scan loses its place in, whose text between entries
  // may be part of one, is merged from its entries and declarations alone
  it('writes the entries and declarations alone of a file the scan loses its place in', () => {
    const existing = '% c\n@string{j = "J"}\n@book{b, note = {unclosed}\n@article{k, title = {A}}';
    expect(parseBibtexWithRaw(existing).rangesTrusted).toBe(false);
    expect(mergeBibtex(existing, '@article{k,\n  title = {Title}\n}')).not.toContain('% c');
  });

  it('keeps the declarations between many entries in linear time', () => {
    const time = (n: number) => {
      const text = Array.from({ length: n }, (_, k) => '@string{m' + k + ' = {x}}\n@article{e' + k + ', note = m' + k + '}').join('\n');
      return fastestRun(() => mergeBibtex(text, '@article{e0,\n  title = {T}\n}'));
    };
    time(4000);
    expect(time(16000) / time(4000)).toBeLessThan(8);
  }, 30000);

  // Which read a field in a braced part of a concatenation, as the doi here,
  // which BibTeX reads as the note's text, and copied it
  it('reads no field in a part of a concatenation', () => {
    const existing = '@article{k,\n  note = 2020 # {doi = a},\n  year = 2021\n}';
    expect([...parseBibtex(existing).get('k')!.fields.keys()]).toEqual(['note', 'year']);
    expect(mergeBibtex(existing, '@article{k,\n  title = {T}\n}')).toBe('@article{k,\n  title = {T},\n  note = 2020 # {doi = a},\n  year = 2021\n}');
  });

  // Each part of a concatenation read once, as the field's, and each field
  // copied once, however many parts or fields there are
  it.each([
    ['many parts', (n: number) => '  note = "a"' + ' # b # {c}'.repeat(n)],
    ['many fields with parts', (n: number) => Array.from({ length: n }, (_, k) => '  f' + k + ' = "a" # b # {c = d}').join(',\n')],
    ['many fields in a part', (n: number) => '  note = 1 # {' + ' x = y,'.repeat(n) + '}'],
  ])('copies a concatenation with %s in linear time', (_name, body) => {
    const time = (n: number) => {
      const existing = '@article{k,\n' + body(n) + '\n}';
      return fastestRun(() => mergeBibtex(existing, '@article{k,\n  title = {T}\n}'));
    };
    time(4000);
    expect(time(16000) / time(4000)).toBeLessThan(8);
  }, 30000);

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

  // Which it read otherwise than the parser: the first of a repeated name,
  // where the parser keeps the last; a quoted value to its first ", in a
  // group, which BibTeX reads on past; and one to a " that an escaped brace,
  // which BibTeX counts, put in a group
  it.each([
    ['a repeated name, the last', '  doi = {a},\n  doi = {b}', 'doi', '  doi = {b},'],
    ['a quoted value with a " in a group', '  title = "a {"} b",\n  year = {2020}', 'title', '  title = "a {"} b",'],
    ['a quoted value with an escaped brace', '  note = "a \\{ b",\n  x = "c \\} d",\n  year = {2020}', 'note', '  note = "a \\{ b",\n  x = "c \\} d",'],
    // And one on a line after another, which it found none of, on a line of
    // its own
    ['a field after another on its line', '  year = {2020}, title = {T}', 'title', '  title = {T},'],
    // Guard: a macro, as written, not in braces
    ['a macro', '  month = jan,\n  year = {2020}', 'month', '  month = jan,'],
  ])('extracts %s as the parser reads it', (_name, body, field, expected) => {
    expect(extractRawField('@article{k,\n' + body + '\n}', field)).toBe(expected);
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
  // Each tried the next entry at a line's start by reading on from its start,
  // to the input's end where that entry didn't end either, so these took
  // seconds; the entry after them, which ends, is still read
  it.each([
    ['an unclosed group', '@article{k,\n x = {\n'],
    ['no end', '@article{k,\n'],
    ['parens and no end', '@article(k,\n x = {a}\n'],
    ['an unclosed pair of parens', '@article(k,\n x = (a\n'],
    ['no key', '@article{,\n'],
    ['an unclosed comment', '@comment{\n'],
    ['an unclosed comment in parens', '@comment(\n'],
    ['an unclosed string', '@string{\n'],
  ])('reads many entries with %s in linear time', (_name, entry) => {
    const input = entry.repeat(20000) + '@book{b,\n  title = {T}\n}\n';
    expect(fastestRun(() => {
      const { parsed, ranges } = parseBibtexWithRaw(input);
      expect(ranges.map(range => range.key)).toEqual(['b']);
      expect(parsed.get('b')?.fields.get('title')).toBe('T');
    })).toBeLessThan(1000);
  }, 60000);

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
    const raw = '@article{k,\n  _doi = {10.1/a}\n}';
    expect(scan(raw).fields).toEqual([
      {
        name: '_doi',
        value: '10.1/a',
        delimiter: 'brace',
        valueStart: raw.indexOf('{10.1/a}'),
        valueEnd: raw.indexOf('{10.1/a}') + '{10.1/a}'.length,
      },
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
    // Value offsets bracket the delimited text, so the slice round-trips.
    const at = (text: string) => ({
      valueStart: raw.indexOf(text),
      valueEnd: raw.indexOf(text) + text.length,
    });
    expect(scan(raw).fields).toEqual([
      { name: 'title', value: 'T', delimiter: 'brace', ...at('{T}') },
      { name: 'note', value: 'q', delimiter: 'quote', ...at('"q"') },
      { name: 'year', value: '2020', delimiter: 'bare', ...at('2020') },
    ]);
    for (const field of scan(raw).fields) {
      expect(raw.slice(field.valueStart, field.valueEnd)).toContain(field.value);
    }
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

  it('reports the entry-type token with offsets that slice back to it', () => {
    const raw = '@Article{k,\n  year = {2020}\n}';
    const entryType = scan(raw).entryType;
    expect(entryType).toBeDefined();
    expect(entryType!.raw).toBe('Article');
    expect(raw.slice(entryType!.start, entryType!.end)).toBe('Article');
    expect(scan('not an entry').entryType).toBeUndefined();
  });

  // Which the walk read otherwise than the parser, whose fields a citation
  // shows, and said nothing, so an edit by offset changed text the parser
  // read as another field, or none: a quoted value whose \{ BibTeX counts as
  // a brace, so its " is in a group and the value reads on, to y's last ";
  // a name the parser reads in part, as doi of :doi; a field in what the
  // walk took for a stray value; and a bare value the parser reads in part
  it.each([
    ['an escaped brace in a quoted value', '  note = "a \\{ b",\n  doi = {10.1/a},\n  y = "c \\} d"'],
    ['a name that starts with a digit, which BibTeX reads as none', '  1doi = {10.1/a}'],
    ['a field in a stray value', '  title = {T} "x,\n  doi = {10.1/a},\n  note = "'],
    ['a bare value the parser reads in part', '  doi = 10.1000/abc'],
    // And text BibTeX reads as an error, after which it reads none of the
    // entry, where the parser reads on: a field with no comma before it, a
    // word that is no field's name, a value no field has, a field with no
    // value, a comma or a # with no value before it, or a # with none after
    // it, and an = with no name
    ['a field with no comma before it', '  title = {T}\n  doi = {10.1/a}'],
    ['a word that is no field\'s name', '  title = {T},\n  x doi = {10.1/a}'],
    ['a value no field has', '  title = {T} {x},\n  doi = {10.1/a}'],
    ['a field with no value', '  title = {T},\n  doi ='],
    ['a field with no value before a comma', '  doi = ,\n  title = {T}'],
    ['a comma with no field before it', '  title = {T},,\n  doi = {10.1/a}'],
    ['a # with no value before it', '  title = {T}, # {x},\n  doi = {10.1/a}'],
    ['a # with no value after it', '  doi = {10.1/a} #'],
    ['an = with no name before it', '  title = {T},=\n  doi = {10.1/a}'],
    // Spaces BibTeX reads in a name or a macro's, where the parser reads
    // a space, and a character it reads as neither
    ['a no-break space between fields', '  title = {T},\u00A0doi = {10.1/a}'],
    ['a no-break space after a name', '  doi\u00A0= {10.1/a}'],
    ['a no-break space after a value', '  title = {T}\u00A0,\n  doi = {10.1/a}'],
    ['a form feed between fields', '  title = {T},\f\n  doi = {10.1/a}'],
  ])('refuses to edit an entry with %s', (_name, body) => {
    expect(scan('@article{k,\n' + body + '\n}').unbalanced).toBe(true);
  });

  // Guards: values every reader ends in the same place
  it.each([
    ['an escaped quote', '  note = "a \\" b",\n  doi = {10.1/a}'],
    ['a quote in a group', '  note = "a {"} b",\n  doi = {10.1/a}'],
    ['escaped braces that pair', '  note = "a \\{ b \\}",\n  doi = {10.1/a}'],
    ['a concatenation', '  doi = "10.1/" # "a"'],
    ['a name with a colon in it, as the parser reads it', '  x:y = {a},\n  doi = {10.1/a}'],
    ['a trailing comma', '  doi = {10.1/a},'],
    ['line ends of a carriage return and a line feed', '  title = {T},\r\n\tdoi = {10.1/a}\r\n'],
  ])('edits an entry with %s', (_name, body) => {
    const raw = '@article{k,\n' + body + '\n}';
    expect(scan(raw).unbalanced).toBe(false);
    expect(scan(raw).fieldNames).toContain('doi');
  });
});

describe('BibTeX field reader', () => {
  // A regex read a braced value's groups only three deep, with the field's
  // braces, and the rest of the value was lost; and a value long enough,
  // which it gave up on, so the entry had none of its fields
  const fields = (body: string) => {
    const entry = parseBibtex('@article{k,\n' + body + '\n}').get('k');
    return entry && Object.fromEntries(entry.fields);
  };

  // Which read a name, or a bare value, as a word, as \w, where BibTeX reads
  // all of an identifier, as bibtex.web's scan_identifier does, so the
  // parser read :doi as doi, a field the entry doesn't have, and a macro
  // x-y as x; and read a name in a run that starts with a digit, which
  // BibTeX reads as no name, and none in the value after it
  it.each([
    ['a name that starts with a colon', '  :doi = {10.1/a},\n  year = 2020', { ':doi': '10.1/a', year: '2020' }],
    ['a name with a colon in it', '  x:doi = {10.1/a}', { 'x:doi': '10.1/a' }],
    ['a name of characters that aren\'t letters', '  +.@/é\\x = {a}', { '+.@/é\\x': 'a' }],
    ['a macro with a hyphen', '  month = x-y,\n  year = 2020', { month: 'x-y', year: '2020' }],
    ['a name that starts with a digit', '  1doi = {title = {Y}},\n  year = 2020', { year: '2020' }],
    ['a name in the run a number starts', '  year = 2020title = {x}', { year: '2020' }],
    // Guards: a number, a bare value BibTeX reads to its first character
    // that isn't a digit, and a name and a macro of letters
    ['a number before what isn\'t one', '  doi = 10.1000/abc', { doi: '10' }],
    ['a name and a macro of letters', '  month = jan', { month: 'jan' }],
  ])('reads %s as BibTeX does', (_name, body, expected) => {
    expect(fields(body)).toEqual(expected);
  });

  // Guard: a no-break space, which BibTeX reads in the name after it, so
  // the body walk refuses the entry, the parser reads as a space, as before
  it('reads a no-break space before a name as a space', () => {
    expect(fields('  title = {T},\u00A0doi = {10.1/a}')).toEqual({ title: 'T', doi: '10.1/a' });
  });

  it.each([
    ['four levels of groups', '{a {b {c {d} e} f} g}', 'a {b {c {d} e} f} g'],
    ['a group four deep that holds a group', '{a {b {c {d {e} f} g} h} i}', 'a {b {c {d {e} f} g} h} i'],
    ['groups 10,000 deep', '{a ' + '{'.repeat(10000) + 'x' + '}'.repeat(10000) + ' b}', 'a ' + '{'.repeat(10000) + 'x' + '}'.repeat(10000) + ' b'],
  ])('reads a braced value of %s whole', (_name, value, expected) => {
    expect(fields('  title = ' + value + ',\n  year = {2020}')).toEqual({ title: expected, year: '2020' });
  });

  // Which ended at the " in the group, as the regex read it, so the value
  // lost the rest, where BibTeX, and the parser where it found the entry's
  // end, read on to the " after the group
  it.each([
    ['a " in a group', '"a {"} b"', 'a {"} b'],
    ['a quoted word in a group', '"a {"b"} c"', 'a {"b"} c'],
    ['a " in a group in a group', '"a {{"} b} c"', 'a {{"} b} c'],
    // Guards: an escaped ", an escaped backslash at the end, and a } alone
    ['an escaped "', String.raw`"a \" b"`, String.raw`a \" b`],
    ['an escaped backslash at the end', String.raw`"a \\"`, 'a \\'],
    ['a } with no { before it', '"a } b"', 'a } b'],
  ])('reads a quoted value with %s whole, and the field after it', (_name, value, expected) => {
    expect(fields('  title = ' + value + ',\n  year = {2020}')).toEqual({ title: expected, year: '2020' });
  });

  // Where a quoted value ended none, the search for a field went on from
  // its name, to the next quoted value, which read the rest of the body
  // again, as each before it had
  it('reads a body of quoted values in groups that end none in time linear in its length', () => {
    const bib = (n: number) => '@article{k,\n{' + 'x="{'.repeat(n) + '}'.repeat(n + 1) + ', year={2020}\n}';
    expect(parseBibtex(bib(4000)).get('k')?.fields.get('year')).toBe('2020');
    // Each run parses the body 40 times, some milliseconds of work, as one
    // parse took under a millisecond, where the timer's noise decided the
    // ratio, at sizes where reading the body again for each value fails in
    // seconds
    const time = (n: number) => {
      const text = bib(n);
      return fastestRun(() => {
        for (let k = 0; k < 40; k++) parseBibtex(text);
      });
    };
    time(1000);
    const small = time(1000);
    expect(time(4000) / small).toBeLessThan(8);
  }, 30000);

  // Each run of an identifier's characters is read once, from its start,
  // the rest of one a number starts too
  it.each([
    ['words with no = after them', (n: number) => '  ' + 'x:y '.repeat(n) + '\n  year = 2020', { year: '2020' }],
    ['numbers that run into names', (n: number) => '  ' + 'a = 1b'.repeat(n) + ',\n  year = 2020', { a: '1', year: '2020' }],
  ])('reads a body of %s in linear time', (_name, body, expected) => {
    expect(fields(body(4000))).toEqual(expected);
    const time = (n: number) => {
      const text = body(n);
      return fastestRun(() => {
        for (let k = 0; k < 10; k++) fields(text);
      });
    };
    time(4000);
    const small = time(4000);
    expect(time(16000) / small).toBeLessThan(8);
  }, 30000);

  it.each([
    ['braced', (text: string) => '{' + text + '}'],
    ['quoted', (text: string) => '"' + text + '"'],
  ])('reads a long %s value, and the fields after it, in linear time', (_name, delimit) => {
    const text = 'a b '.repeat(150000) + 'c';
    expect(fastestRun(() => expect(fields('  title = ' + delimit(text) + ',\n  year = {2020}')).toEqual({ title: text, year: '2020' }))).toBeLessThan(1000);
  }, 30000);
});

describe('citation keys', () => {
  // Which the parser read otherwise than BibTeX and biber both: a key ran on
  // past an @, so an entry with no key took the next line's header for its
  // key, as @book{b; and a key needed a comma after it, so an entry with no
  // fields, which both read, was none. And an @ in a key, which BibTeX
  // reads in it and biber reads as an error, as no entry
  it.each([
    ['an entry with no key, then an entry on the next line', '@article{\n@book{b,\n  title = {T}\n}\n', [['b', 'T']]],
    ['an entry with no fields', '@article{k}\n@book{b, title = {T}}', [['k', undefined], ['b', 'T']]],
    ['an entry with no fields and spaces around its key', '@article{ k }', [['k', undefined]]],
    ['a paren entry with no fields', '@article(k)', [['k', undefined]]],
    ['an @ in a key, which biber reads as no key', '@article{a@b,\n  title = {T}\n}\n@book{c, title = {U}}', [['c', 'U']]],
    // Guards: a key of characters other than letters, which both read, a }
    // in a paren entry's key, which BibTeX reads, and a space before a key's
    // comma
    ['a key of characters other than letters', "@article{a:b/c.d-e+f'g\u00E9, title = {T}}", [["a:b/c.d-e+f'g\u00E9", 'T']]],
    ['a } in a paren entry\'s key', '@article(a}b, title = {T})', [['a}b', 'T']]],
    ['a space before a key\'s comma', '@article{k , title = {T}}', [['k', 'T']]],
  ])('reads %s as BibTeX and biber do', (_name, input, expected) => {
    expect([...parseBibtex(input)].map(([key, entry]) => [key, entry.fields.get('title')])).toEqual(expected);
  });

  it('reads an entry with no fields as all of its text, its key where it is', () => {
    const input = '@article{ k }';
    const { raw, ranges } = parseBibtexWithRaw(input);
    expect(raw.get('k')).toBe(input);
    expect(ranges.map(range => input.slice(range.keyStart, range.keyEnd))).toEqual(['k']);
  });

  // Guard: the walk reads no field in an entry with no fields, and edits it,
  // and a field added to it reads back
  it('edits an entry with no fields', () => {
    const raw = '@article{k}';
    expect(scanBibtexEntryBody(raw)).toMatchObject({ fields: [], unbalanced: false, hasConcatenation: false });
    expect(parseBibtex(spliceFieldsIntoEntry(raw, ['  doi = {10.1/a}'])).get('k')?.fields.get('doi')).toBe('10.1/a');
  });

  // Which took a key's last ( or { for the opener of an entry with no key,
  // so left out the comma after the key, and the entry read no key: for
  // DOCX import's merge into an existing .bib file, and for Zotero link and
  // sync, which add fields to an entry the same way
  it.each([
    ['a paren entry whose key ends in a (', '@article(k(, doi = {10.1/a})', '@article(k()', 'k('],
    ['a brace entry whose key ends in a {', '@article{k{, doi = {10.1/a}}', '@article{k{}', 'k{'],
    ['a brace entry whose key is a {', '@article{{, doi = {10.1/a}}', '@article{{}', '{'],
    // Guards: an entry with no fields whose key ends otherwise, and one with
    // a comma after its key, which takes no other
    ['a paren entry whose key ends in a letter', '@article(k, doi = {10.1/a})', '@article(k)', 'k'],
    ['a brace entry with a comma after its key', '@article{k{, doi = {10.1/a}}', '@article{k{,}', 'k{'],
  ])('adds a field to %s, with no fields', (_name, existing, produced, key) => {
    const spliced = spliceFieldsIntoEntry(produced, ['  doi = {10.1/a}']);
    expect(parseBibtex(spliced).get(key)?.fields.get('doi')).toBe('10.1/a');
    expect(spliced).not.toContain(',,');
    const merged = mergeBibtex(existing, produced);
    expect(parseBibtex(merged).get(key)?.fields.get('doi')).toBe('10.1/a');
    expect(merged).not.toContain(',,');
    expect(mergeBibtex(existing, merged)).toBe(merged);
  });
});

describe('entry types', () => {
  // Which the parser read as a word, as \w+, right after the @, where
  // BibTeX reads an identifier there (bibtex.web's scan_identifier), after
  // any white space: so an entry whose type has a hyphen, a colon, a period
  // or a letter of another language, or white space after its @, was no
  // entry; and a type that starts with a digit, which BibTeX reads as none,
  // was one
  it.each([
    ['a hyphen', '@my-type{k, title = {T}}', [['k', 'my-type', 'T']]],
    ['a colon and a period', '@x:y.z{k, title = {T}}', [['k', 'x:y.z', 'T']]],
    ['a letter of another language', '@artículo{k, title = {T}}', [['k', 'artículo', 'T']]],
    ['white space after its @, and line ends', '@ article\n{k, title = {T}}', [['k', 'article', 'T']]],
    ['a hyphen, in parens', '@my-type(k, title = {T})', [['k', 'my-type', 'T']]],
    ['a digit at its start', '@2article{k, title = {T}}\n@book{b, title = {U}}', [['b', 'book', 'U']]],
    // Guards: a type of letters, and an @ in prose before an entry
    ['letters', '@Article{k, title = {T}}', [['k', 'article', 'T']]],
    ['an @ in prose before an entry', 'Write to me@example.com.\n@book{b, title = {U}}', [['b', 'book', 'U']]],
  ])('reads an entry whose type has %s as BibTeX does', (_name, input, expected) => {
    expect([...parseBibtex(input)].map(([key, entry]) => [key, entry.type, entry.fields.get('title')])).toEqual(expected);
  });

  // Which found the body of an entry whose type has a hyphen by `@\w+`, so
  // found none: the merge wrote a field it copies from its parsed value, a
  // macro as text, and Zotero link refused to edit the entry
  it('copies and edits the fields of an entry whose type has a hyphen', () => {
    const existing = '@my-type{k,\n  title = {T},\n  month = jan\n}';
    expect(extractRawField(existing, 'month')).toBe('  month = jan,');
    expect(mergeBibtex(existing, '@my-type{k,\n  title = {T}\n}')).toBe(existing);
    expect(scanBibtexEntryBody('@my-type{k,\n  doi = {10.1/a}\n}')).toMatchObject({ unbalanced: false });
  });

  it('reads the type of an entry with white space after its @ where it is, for Zotero link', () => {
    const raw = '@ my-type{k,\n  doi = {10.1/a}\n}';
    const { entryType, fields } = scanBibtexEntryBody(raw);
    expect(entryType).toEqual({ raw: 'my-type', start: 2, end: 9 });
    expect(fields.map(field => field.name)).toEqual(['doi']);
  });

  // Which took a header whose type has a hyphen for no header, so the line
  // end that told which the file's are was read from the entry after it
  it('ends the text after an entry at a header whose type has a hyphen', () => {
    expect(detectBibtexEol('@article{a, note = {x\ny}}   @my-type{b, t = {A\r\nB}}'))
      .toBe(detectBibtexEol('@article{a, note = {x\ny}}   @book{b, t = {A\r\nB}}'));
  });

  // Each @ in a run of an identifier's characters, which BibTeX reads in
  // one, is read once
  it.each([
    ['in the text between entries', (n: number) => '@x'.repeat(n) + '\n@book{b, title = {U}}'],
    ['after an entry, before a line end', (n: number) => '@article{a, note = {x\ny}}' + '@x'.repeat(n) + '\r\n'],
    ['that start with digits', (n: number) => '@1x'.repeat(n) + '\n@book{b, title = {U}}'],
  ])('reads a run of @s %s in linear time', (_name, text) => {
    const time = (n: number) => {
      const input = text(n);
      // Each run reads the text ten times, as one read takes too little
      // time for a pause to be lost in it
      return fastestRun(() => {
        for (let k = 0; k < 10; k++) {
          parseBibtex(input);
          detectBibtexEol(input);
        }
      }, 5);
    };
    // At sizes where a run takes long enough that the timer's noise
    // doesn't decide the ratio, and a quadratic read still takes seconds
    time(16000);
    const small = time(16000);
    expect(time(64000) / small).toBeLessThan(8);
  }, 30000);
});

describe('repeated fields', () => {
  // BibTeX reads the first of a field given twice and warns ("I'm ignoring
  // k's extra "title" field"), but biber reads the last, with no warning, as
  // Text::BibTeX stores each value under its name in turn, and this parser
  // reads the last as biber does. Each name an entry gives more than once is
  // reported, once, as BibTeX compares names, in lower case
  it.each([
    ['a field given twice', '@article{k, title = {A}, title = {B}}', ['title'], 'B'],
    ['a field given twice, in other cases', '@article{k, title = {A}, TITLE = {B}}', ['title'], 'B'],
    ['a field given three times', '@article{k, title = {A}, title = {B}, title = "C"}', ['title'], 'C'],
    ['two fields each given twice', '@article{k, year = 1, title = {A}, year = 2, title = {B}}', ['year', 'title'], 'B'],
    ['no field given twice', '@article{k, title = {A}, year = 2020}', undefined, 'A'],
  ])('reports %s', (_name, text, repeated, title) => {
    const { parsed, ranges } = parseBibtexWithRaw(text);
    expect(ranges[0].repeatedFields).toEqual(repeated);
    expect(parsed.get('k')?.fields.get('title')).toBe(title);
  });

  it('reports a repeated field for each entry that has one', () => {
    const { ranges } = parseBibtexWithRaw('@article{a, title = {A}}\n@book{b, note = {x}, note = {y}}\n@misc{c, Note = 1, note = 2}');
    expect(ranges.map(range => range.repeatedFields)).toEqual([undefined, ['note'], ['note']]);
  });
});
