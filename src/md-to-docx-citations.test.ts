import { describe, it, expect } from 'bun:test';
import { generateCitation, generateMathXml, escapeXml, generateMissingKeysXml } from './md-to-docx-citations';
import { BibtexEntry } from './bibtex-parser';

describe('generateCitation', () => {
  it('produces field code with Zotero metadata', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([
        ['title', 'Test Article'],
        ['author', 'Smith, John'],
        ['year', '2020'],
        ['journal', 'Test Journal']
      ]),
      zoteroKey: 'ABCD1234',
      zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
    });

    const run = { keys: ['smith2020'], text: 'smith2020' };
    const result = generateCitation(run, entries);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('http://zotero.org/users/123/items/ABCD1234');
    expect(result.xml).toContain('(Smith 2020)');
    expect(result.warning).toBeUndefined();
  });

  it('produces field code without Zotero metadata', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([
        ['title', 'Test Article'],
        ['author', 'Smith, John'],
        ['year', '2020']
      ])
    });

    const run = { keys: ['smith2020'], text: 'smith2020' };
    const result = generateCitation(run, entries);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('(Smith 2020)');
    // No uris field for non-Zotero entries
    expect(result.xml).not.toContain('uris');
    expect(result.warning).toBeUndefined();
  });

  it('includes locator in field code', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([
        ['author', 'Smith, John'],
        ['year', '2020']
      ]),
      zoteroKey: 'ABCD1234',
      zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
    });

    const locators = new Map<string, string>();
    locators.set('smith2020', 'p. 20');
    const run = { keys: ['smith2020'], locators, text: 'smith2020, p. 20' };
    const result = generateCitation(run, entries);

    expect(result.xml).toContain('&quot;locator&quot;:&quot;20&quot;');
    expect(result.xml).toContain('&quot;label&quot;:&quot;page&quot;');
    expect(result.xml).toContain('(Smith 2020, p. 20)');
  });

  it('produces single field code with multiple keys', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']]),
      zoteroKey: 'ABCD1234',
      zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
    });
    entries.set('doe2021', {
      type: 'book',
      key: 'doe2021',
      fields: new Map([['author', 'Doe, Jane'], ['year', '2021']]),
      zoteroKey: 'EFGH5678',
      zoteroUri: 'http://zotero.org/users/123/items/EFGH5678'
    });

    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('ABCD1234');
    expect(result.xml).toContain('EFGH5678');
    expect(result.xml).toContain('(Smith 2020; Doe 2021)');
  });

  it('emits single field code for mixed Zotero/non-Zotero grouped citations', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']]),
      zoteroKey: 'ABCD1234',
      zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
    });
    entries.set('doe2021', {
      type: 'book',
      key: 'doe2021',
      fields: new Map([['author', 'Doe, Jane'], ['year', '2021']])
    });

    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries);

    // Both entries should be in a single field code
    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('ABCD1234');
    expect(result.xml).toContain('(Smith 2020; Doe 2021)');
    expect(result.warning).toBeUndefined();
  });

  it('splits mixed group with missing key', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']]),
      zoteroKey: 'ABCD1234',
      zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
    });

    const run = { keys: ['smith2020', 'missingKey'], text: 'smith2020; missingKey' };
    const result = generateCitation(run, entries);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('(@missingKey)');
    expect(result.missingKeys).toEqual(['missingKey']);
    expect(result.warning).toContain('Citation key not found: missingKey');
  });

  it('splits group with resolved and missing keys', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']]),
      zoteroKey: 'ABCD1234',
      zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
    });
    entries.set('doe2021', {
      type: 'book',
      key: 'doe2021',
      fields: new Map([['author', 'Doe, Jane'], ['year', '2021']])
    });

    const run = { keys: ['smith2020', 'doe2021', 'noSuchKey'], text: 'smith2020; doe2021; noSuchKey' };
    const result = generateCitation(run, entries);

    // Both resolved entries share a field code
    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('ABCD1234');
    // Missing key is plain text
    expect(result.xml).toContain('(@noSuchKey)');
    expect(result.missingKeys).toEqual(['noSuchKey']);
  });

  it('pure Zotero group unchanged', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']]),
      zoteroKey: 'ABCD1234',
      zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
    });
    entries.set('doe2021', {
      type: 'book',
      key: 'doe2021',
      fields: new Map([['author', 'Doe, Jane'], ['year', '2021']]),
      zoteroKey: 'EFGH5678',
      zoteroUri: 'http://zotero.org/users/123/items/EFGH5678'
    });

    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('ABCD1234');
    expect(result.xml).toContain('EFGH5678');
    expect(result.missingKeys).toBeUndefined();
  });

  it('pure non-Zotero group emits field code', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']])
    });
    entries.set('doe2021', {
      type: 'book',
      key: 'doe2021',
      fields: new Map([['author', 'Doe, Jane'], ['year', '2021']])
    });

    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('(Smith 2020; Doe 2021)');
    // No uris for non-Zotero entries
    expect(result.xml).not.toContain('uris');
    expect(result.missingKeys).toBeUndefined();
  });

  it('mixed Zotero/non-Zotero group produces single field code regardless of mode', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']]),
      zoteroKey: 'ABCD1234',
      zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
    });
    entries.set('doe2021', {
      type: 'book',
      key: 'doe2021',
      fields: new Map([['author', 'Doe, Jane'], ['year', '2021']])
    });

    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries);

    // All resolved entries share a single field code
    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('(Smith 2020; Doe 2021)');
  });

  it('omits issued date-parts for non-numeric years', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smithInPress', {
      type: 'article',
      key: 'smithInPress',
      fields: new Map([
        ['author', 'Smith, John'],
        ['year', 'in press']
      ]),
      zoteroKey: 'ABCD1234',
      zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
    });

    const run = { keys: ['smithInPress'], text: 'smithInPress' };
    const result = generateCitation(run, entries);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).not.toContain('date-parts');
    expect(result.xml).toContain('(Smith in press)');
  });

  it('maps additional BibTeX entry types to CSL types', () => {
    const typePairs: Array<[string, string]> = [
      ['incollection', 'chapter'],
      ['inbook', 'chapter'],
      ['phdthesis', 'thesis'],
      ['mastersthesis', 'thesis'],
      ['techreport', 'report'],
      ['misc', 'article'],
    ];

    for (const [bibtexType, cslType] of typePairs) {
      const key = `k_${bibtexType}`;
      const entries = new Map<string, BibtexEntry>();
      entries.set(key, {
        type: bibtexType,
        key,
        fields: new Map([
          ['author', 'Smith, John'],
          ['year', '2020'],
          ['title', 'Sample']
        ]),
        zoteroKey: 'ABCD1234',
        zoteroUri: 'http://zotero.org/users/123/items/ABCD1234'
      });

      const run = { keys: [key], text: key };
      const result = generateCitation(run, entries);
      expect(result.xml).toContain('&quot;type&quot;:&quot;' + cslType + '&quot;');
    }
  });

  it('returns warning and missingKeys with unknown key', () => {
    const entries = new Map<string, BibtexEntry>();
    const run = { keys: ['unknown'], text: 'unknown' };
    const result = generateCitation(run, entries);

    expect(result.xml).toBe('<w:r><w:t>(@unknown)</w:t></w:r>');
    expect(result.warning).toBe('Citation key not found: unknown');
    expect(result.missingKeys).toEqual(['unknown']);
  });
});

describe('generateMissingKeysXml', () => {
  it('produces paragraphs for missing keys', () => {
    const xml = generateMissingKeysXml(['foo', 'bar']);
    expect(xml).toContain('Citation data for @foo was not found in the bibliography file.');
    expect(xml).toContain('Citation data for @bar was not found in the bibliography file.');
    // Should be proper OOXML paragraphs
    expect(xml).toContain('<w:p>');
    expect(xml).toContain('</w:p>');
  });

  it('returns empty string for no missing keys', () => {
    expect(generateMissingKeysXml([])).toBe('');
  });
});

describe('generateMathXml', () => {
  it('produces m:oMath for inline', () => {
    const result = generateMathXml('x^2', false);
    expect(result).toMatch(/^<m:oMath>.*<\/m:oMath>$/);
    expect(result).not.toContain('m:oMathPara');
  });

  it('produces m:oMathPara for display', () => {
    const result = generateMathXml('x^2', true);
    expect(result).toMatch(/^<m:oMathPara><m:oMath>.*<\/m:oMath><\/m:oMathPara>$/);
  });

  it('handles complex LaTeX', () => {
    const result = generateMathXml('\\frac{a}{b} + \\sqrt{c}', false);
    expect(result).toContain('<m:oMath>');
    expect(result).toContain('</m:oMath>');
  });
});

describe('escapeXml', () => {
  it('escapes XML special characters', () => {
    expect(escapeXml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
    expect(escapeXml('normal text')).toBe('normal text');
  });
});