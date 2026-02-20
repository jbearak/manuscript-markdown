import { describe, it, expect } from 'bun:test';
import { generateCitation, generateCitationId, generateMathXml, escapeXml, generateMissingKeysXml, htmlToOoxmlRuns } from './md-to-docx-citations';
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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020'], text: 'smith2020' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(result.xml).toContain('http://zotero.org/users/123/items/ABCD1234');
    expect(result.xml).toContain('(Smith 2020)');
    expect(result.warning).toBeUndefined();

    // Extract JSON from the field code to verify structure
    const jsonMatch = result.xml.match(/CSL_CITATION (.+?) <\/w:instrText>/);
    expect(jsonMatch).toBeTruthy();
    const decoded = jsonMatch![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const csl = JSON.parse(decoded);

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
    const jsonMatch = result.xml.match(/CSL_CITATION (.+?) <\/w:instrText>/);
    const decoded = jsonMatch![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const csl = JSON.parse(decoded);
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

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, string | number>();
    const run = { keys: ['smith2020', 'doe2021', 'noSuchKey'], text: 'smith2020; doe2021; noSuchKey' };
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);

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

    expect(result.xml).toBe('<w:r><w:t>(@unknown)</w:t></w:r>');
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
      const jsonMatch = result.xml.match(/CSL_CITATION (.+?) <\/w:instrText>/);
      const decoded = jsonMatch![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const csl = JSON.parse(decoded);
      ids.push(csl.citationID);
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

    const extract = (xml: string) => {
      const m = xml.match(/CSL_CITATION (.+?) <\/w:instrText>/);
      return JSON.parse(m![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    };

    const csl1 = extract(result1.xml);
    const csl2 = extract(result2.xml);

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
    expect(result).toBe('<w:r><w:t xml:space="preserve">hello world</w:t></w:r>');
  });

  it('applies italic and bold formatting', () => {
    const result = htmlToOoxmlRuns('<i>italic</i> and <b>bold</b>');
    expect(result).toContain('<w:rPr><w:i/></w:rPr>');
    expect(result).toContain('<w:t xml:space="preserve">italic</w:t>');
    expect(result).toContain('<w:rPr><w:b/></w:rPr>');
    expect(result).toContain('<w:t xml:space="preserve">bold</w:t>');
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
    const afterMatch = result.match(/<w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">AFTER<\/w:t><\/w:r>/);
    expect(afterMatch).toBeTruthy();
    expect(afterMatch![0]).toContain('<w:smallCaps/>');
  });

  it('clears small-caps when its own span closes', () => {
    const html = '<span style="font-variant:small-caps;">caps</span>normal';
    const result = htmlToOoxmlRuns(html);
    // "normal" should NOT have smallCaps
    const normalMatch = result.match(/<w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">normal<\/w:t><\/w:r>/);
    expect(normalMatch).toBeTruthy();
    expect(normalMatch![0]).not.toContain('<w:smallCaps/>');
  });

  it('handles mixed superscript and italic', () => {
    const result = htmlToOoxmlRuns('<sup><i>text</i></sup>');
    expect(result).toContain('<w:i/>');
    expect(result).toContain('<w:vertAlign w:val="superscript"/>');
    expect(result).toContain('<w:t xml:space="preserve">text</w:t>');
  });
});