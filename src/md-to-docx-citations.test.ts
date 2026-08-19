import { describe, it, expect } from 'bun:test';
import { generateCitation, generateCitationId, generateMathXml, escapeXml, generateMissingKeysXml, htmlToOoxmlRuns, generateFallbackText } from './md-to-docx-citations';
import { BibtexEntry, parseBibtex } from './bibtex-parser';
import { parseMd, type MdRun } from './md-to-docx';

/** Extract and parse the CSL_CITATION JSON from a Zotero field code XML string. */
function extractCsl(xml: string) {
  const m = xml.match(/CSL_CITATION (.+?) <\/w:instrText>/);
  if (!m) return undefined;
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020'], text: 'smith2020' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('http://zotero.org/users/123/items/ABCD1234');
    expect(result.xml).toContain('(Smith 2020)');
    expect(result.warning).toBeUndefined();

    // Extract JSON from the field code to verify structure
    const csl = extractCsl(result.xml);
    expect(csl).toBeDefined();

    // Defect 1: citationID is a random alphanumeric string
    expect(csl.citationID).toMatch(/^[a-z0-9]{8}$/);

    // Defect 2: formattedCitation and plainCitation in properties
    expect(csl.properties.formattedCitation).toBe('(Smith 2020)');
    expect(csl.properties.plainCitation).toBe('(Smith 2020)');

    // Defect 3: key order — citationID, properties, citationItems, schema
    const keys = Object.keys(csl);
    expect(keys).toEqual(['citationID', 'properties', 'citationItems', 'schema']);

    // Defect 3: schema URL present
    expect(csl.schema).toBe('https://github.com/citation-style-language/schema/raw/master/csl-citation.json');

    // Defect 4: outer id on citationItem matches itemData.id
    expect(csl.citationItems[0].id).toBe(csl.citationItems[0].itemData.id);
    expect(typeof csl.citationItems[0].id).toBe('number');
  });

  it('embeds decoded TeX accents while preserving opaque citation metadata', () => {
    const entries = parseBibtex(String.raw`@article{muller2024,
  author = {M{\"u}ller, Jane},
  title = {{\"U}ber Caf\'{e} research},
  year = {2024},
  doi = {10.1000/M{\"u}ller\_id},
  zotero-key = {AB\_CD},
  zotero-uri = {http://zotero.org/groups/1/items/AB\_CD#frag}
}`);
    const result = generateCitation(
      { keys: ['muller2024'], text: 'muller2024' },
      entries,
      undefined,
      new Set<string>(),
      new Map<string, string | number>(),
    );

    const csl = extractCsl(result.xml);
    expect(csl.citationItems[0].itemData.author).toEqual([
      { family: 'Müller', given: 'Jane' },
    ]);
    expect(csl.citationItems[0].itemData.title).toBe('Über Café research');
    expect(csl.citationItems[0].itemData.DOI).toBe(String.raw`10.1000/M{\"u}ller\_id`);
    expect(csl.citationItems[0].uris[0]).toBe(String.raw`http://zotero.org/groups/1/items/AB\_CD#frag`);
    expect(csl.properties.plainCitation).toBe('(Müller 2024)');
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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020'], text: 'smith2020' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('(Smith 2020)');
    // Non-Zotero entries get synthetic uris so Zotero falls back to embedded itemData
    expect(result.xml).toContain('http://zotero.org/users/local/embedded/items/smith2020');
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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const locators = new Map<string, string>();
    locators.set('smith2020', 'p. 20');
    const run = { keys: ['smith2020'], locators, text: 'smith2020, p. 20' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('ABCD1234');
    expect(result.xml).toContain('EFGH5678');
    expect(result.xml).toContain('(Smith 2020; Doe 2021)');

    // Verify both citationItems have distinct numeric IDs
    const csl = extractCsl(result.xml);
    expect(csl.citationItems.length).toBe(2);
    expect(csl.citationItems[0].id).toBe(csl.citationItems[0].itemData.id);
    expect(csl.citationItems[1].id).toBe(csl.citationItems[1].itemData.id);
    expect(csl.citationItems[0].id).not.toBe(csl.citationItems[1].id);
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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020', 'missingKey'], text: 'smith2020; missingKey' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('[@missingKey]');
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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020', 'doe2021', 'noSuchKey'], text: 'smith2020; doe2021; noSuchKey' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

    // Both resolved entries share a field code
    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('ABCD1234');
    // Missing key is plain text
    expect(result.xml).toContain('[@noSuchKey]');
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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('(Smith 2020; Doe 2021)');
    // Non-Zotero entries get synthetic uris for Zotero compatibility
    expect(result.xml).toContain('http://zotero.org/users/local/embedded/items/smith2020');
    expect(result.xml).toContain('http://zotero.org/users/local/embedded/items/doe2021');
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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020', 'doe2021'], text: 'smith2020; doe2021' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smithInPress'], text: 'smithInPress' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
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
      const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);
      expect(result.xml).toContain('&quot;type&quot;:&quot;' + cslType + '&quot;');
    }
  });

  it('returns warning and missingKeys with unknown key', () => {
    const entries = new Map<string, BibtexEntry>();
    const run = { keys: ['unknown'], text: 'unknown' };
    const result = generateCitation(run, entries);

    expect(result.xml).toBe('<w:r><w:t>[@unknown]</w:t></w:r>');
    expect(result.warning).toBe('Citation key not found: unknown');
    expect(result.missingKeys).toEqual(['unknown']);
  });

  it('generates unique citationIDs across multiple calls with shared set', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']])
    });

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const ids: string[] = [];

    for (let i = 0; i < 10; i++) {
      const run = { keys: ['smith2020'], text: 'smith2020' };
      const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);
      ids.push(extractCsl(result.xml).citationID);
    }

    // All IDs should be unique
    expect(new Set(ids).size).toBe(10);
    // All IDs should be 8-char alphanumeric
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  it('reuses stable numeric item IDs for the same citation key', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']])
    });

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();

    // Call twice with same key
    const run1 = { keys: ['smith2020'], text: 'smith2020' };
    const result1 = generateCitation(run1, entries, undefined, usedIds, itemIdMap);
    const run2 = { keys: ['smith2020'], text: 'smith2020' };
    const result2 = generateCitation(run2, entries, undefined, usedIds, itemIdMap);

    const csl1 = extractCsl(result1.xml);
    const csl2 = extractCsl(result2.xml);

    // Same key should get the same numeric ID
    expect(csl1.citationItems[0].id).toBe(csl2.citationItems[0].id);
    // But citationIDs should differ
    expect(csl1.citationID).not.toBe(csl2.citationID);
  });
});

describe('generateCitationId', () => {
  it('generates 8-character alphanumeric strings', () => {
    for (let i = 0; i < 20; i++) {
      const id = generateCitationId();
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  it('avoids collisions with used IDs set', () => {
    const used = new Set<string>();
    for (let i = 0; i < 50; i++) {
      generateCitationId(used);
    }
    expect(used.size).toBe(50);
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

describe('htmlToOoxmlRuns', () => {
  it('passes through plain text', () => {
    const result = htmlToOoxmlRuns('hello world');
    // No leading/trailing space → no xml:space="preserve"
    expect(result).toBe('<w:r><w:t>hello world</w:t></w:r>');
  });

  it('applies italic and bold formatting', () => {
    const result = htmlToOoxmlRuns('<i>italic</i> and <b>bold</b>');
    expect(result).toContain('<w:rPr><w:i/></w:rPr>');
    expect(result).toContain('<w:t>italic</w:t>');
    expect(result).toContain('<w:rPr><w:b/></w:rPr>');
    expect(result).toContain('<w:t>bold</w:t>');
  });

  it('decodes HTML entities without double-encoding', () => {
    // citeproc outputs &amp; for &, &#x2013; for en-dash
    const result = htmlToOoxmlRuns('Smith &amp; Jones, 2020&#x2013;2021');
    expect(result).toContain('Smith &amp; Jones, 2020\u20132021');
    // Must NOT contain double-encoded &amp;amp;
    expect(result).not.toContain('&amp;amp;');
  });

  it('decodes &nbsp; as non-breaking space', () => {
    const result = htmlToOoxmlRuns('a&nbsp;b');
    expect(result).toContain('a\u00A0b');
  });

  it('decodes numeric character references', () => {
    // &#8211; is en-dash, &#39; is apostrophe
    const result = htmlToOoxmlRuns('2020&#8211;2021 it&#39;s');
    expect(result).toContain('2020\u20132021');
    expect(result).toContain("it's");
  });

  it('handles nested nocase span inside small-caps span', () => {
    // small-caps wraps nocase: closing nocase should not clear small-caps
    const html = '<span style="font-variant:small-caps;">BEFORE<span class="nocase">inner</span>AFTER</span>';
    const result = htmlToOoxmlRuns(html);
    // All three text segments should have smallCaps
    expect(result).toContain('<w:smallCaps/>');
    // "AFTER" must still have smallCaps
    const afterMatch = result.match(/<w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t>AFTER<\/w:t><\/w:r>/);
    expect(afterMatch).not.toBeNull();
    expect(afterMatch![0]).toContain('<w:smallCaps/>');
  });

  it('clears small-caps when its own span closes', () => {
    const html = '<span style="font-variant:small-caps;">caps</span>normal';
    const result = htmlToOoxmlRuns(html);
    // "normal" should NOT have smallCaps
    const normalMatch = result.match(/<w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t>normal<\/w:t><\/w:r>/);
    expect(normalMatch).not.toBeNull();
    expect(normalMatch![0]).not.toContain('<w:smallCaps/>');
  });

  it('handles mixed superscript and italic', () => {
    const result = htmlToOoxmlRuns('<sup><i>text</i></sup>');
    expect(result).toContain('<w:i/>');
    expect(result).toContain('<w:vertAlign w:val="superscript"/>');
    expect(result).toContain('<w:t>text</w:t>');
  });
});

describe('per-item suppress-author', () => {
  const smithEntry: BibtexEntry = {
    type: 'article',
    key: 'smith2020',
    fields: new Map([['author', 'Smith, John'], ['year', '2020']]),
  };
  const doeEntry: BibtexEntry = {
    type: 'book',
    key: 'doe2021',
    fields: new Map([['author', 'Doe, Jane'], ['year', '2021']]),
  };

  function makeEntries() {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', smithEntry);
    entries.set('doe2021', doeEntry);
    return entries;
  }

  it('mixed suppress first: [-@smith; @jones] suppresses only smith', () => {
    const entries = makeEntries();
    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = {
      keys: ['smith2020', 'doe2021'],
      text: '-@smith2020; doe2021',
      suppressAuthorKeys: new Set(['smith2020']),
    };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);
    const csl = extractCsl(result.xml);
    expect(csl).toBeDefined();
    expect(csl.citationItems[0]['suppress-author']).toBe(true);
    expect(csl.citationItems[1]['suppress-author']).toBeUndefined();
  });

  it('mixed suppress second: [@smith; -@jones] suppresses only jones', () => {
    const entries = makeEntries();
    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = {
      keys: ['smith2020', 'doe2021'],
      text: 'smith2020; -@doe2021',
      suppressAuthorKeys: new Set(['doe2021']),
    };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);
    const csl = extractCsl(result.xml);
    expect(csl).toBeDefined();
    expect(csl.citationItems[0]['suppress-author']).toBeUndefined();
    expect(csl.citationItems[1]['suppress-author']).toBe(true);
  });

  it('no suppress: [@smith; @jones] has no suppress-author on either', () => {
    const entries = makeEntries();
    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = {
      keys: ['smith2020', 'doe2021'],
      text: 'smith2020; doe2021',
    };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);
    const csl = extractCsl(result.xml);
    expect(csl).toBeDefined();
    expect(csl.citationItems[0]['suppress-author']).toBeUndefined();
    expect(csl.citationItems[1]['suppress-author']).toBeUndefined();
  });

  it('fallback text: per-key suppress produces year-only for suppressed key', () => {
    const entries = makeEntries();
    const result = generateFallbackText(
      ['smith2020', 'doe2021'],
      entries,
      undefined,
      new Set(['smith2020'])
    );
    // smith2020 is suppressed → year only; doe2021 is not → "Doe 2021"
    expect(result).toBe('(2020; Doe 2021)');
  });

  it('fallback text: suppress second key only', () => {
    const entries = makeEntries();
    const result = generateFallbackText(
      ['smith2020', 'doe2021'],
      entries,
      undefined,
      new Set(['doe2021'])
    );
    // smith2020 normal → "Smith 2020"; doe2021 suppressed → year only
    expect(result).toBe('(Smith 2020; 2021)');
  });
});

describe('parseMd per-item suppress-author', () => {
  function findCitationRun(tokens: ReturnType<typeof parseMd>): MdRun | undefined {
    for (const tok of tokens) {
      if (tok.runs) {
        const run = tok.runs.find(r => r.type === 'citation');
        if (run) return run;
      }
    }
    return undefined;
  }

  it('[-@smith; @jones] produces suppressAuthorKeys with smith only', () => {
    const tokens = parseMd('[-@smith2020; @doe2021]');
    const run = findCitationRun(tokens);
    expect(run).toBeDefined();
    expect(run!.keys).toEqual(['smith2020', 'doe2021']);
    expect(run!.suppressAuthorKeys).toEqual(new Set(['smith2020']));
  });

  it('[@smith; -@jones] produces suppressAuthorKeys with jones only', () => {
    const tokens = parseMd('[@smith2020; -@doe2021]');
    const run = findCitationRun(tokens);
    expect(run).toBeDefined();
    expect(run!.keys).toEqual(['smith2020', 'doe2021']);
    expect(run!.suppressAuthorKeys).toEqual(new Set(['doe2021']));
  });

  it('[@smith; @jones] produces no suppressAuthorKeys', () => {
    const tokens = parseMd('[@smith2020; @doe2021]');
    const run = findCitationRun(tokens);
    expect(run).toBeDefined();
    expect(run!.keys).toEqual(['smith2020', 'doe2021']);
    expect(run!.suppressAuthorKeys).toBeUndefined();
  });

  it('[-@smith] single suppress still works', () => {
    const tokens = parseMd('[-@smith2020]');
    const run = findCitationRun(tokens);
    expect(run).toBeDefined();
    expect(run!.keys).toEqual(['smith2020']);
    expect(run!.suppressAuthorKeys).toEqual(new Set(['smith2020']));
  });

  it('[@smith] single normal has no suppressAuthorKeys', () => {
    const tokens = parseMd('[@smith2020]');
    const run = findCitationRun(tokens);
    expect(run).toBeDefined();
    expect(run!.keys).toEqual(['smith2020']);
    expect(run!.suppressAuthorKeys).toBeUndefined();
  });

  it('[-@smith; -@jones] all suppressed', () => {
    const tokens = parseMd('[-@smith2020; -@doe2021]');
    const run = findCitationRun(tokens);
    expect(run).toBeDefined();
    expect(run!.keys).toEqual(['smith2020', 'doe2021']);
    expect(run!.suppressAuthorKeys).toEqual(new Set(['smith2020', 'doe2021']));
  });
});