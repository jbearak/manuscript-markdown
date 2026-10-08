import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { generateCitation, orderRPr, generateCitationId, generateMathXml, escapeXml, generateMissingKeysXml, htmlToOoxmlRuns, generateFallbackText, bibliographyEntryAsShown, createCiteprocEngine, renderBibliography, renderCitationText, textElements } from './md-to-docx-citations';
import { BibtexEntry, parseBibtex } from './bibtex-parser';
import { parseMd, convertMdToDocx, type MdRun } from './md-to-docx';
import { fastestRun } from './test-timing';

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

  it.each([
    ['p.', 'p. 2\n0'],
    ['pp.', 'pp. 2\n0'],
  ])('reads the page of a locator after %s over a line break without its label', (_label, locator) => {
    // The label stayed in it, where import wrote another before it, as p. p.
    const entries = new Map<string, BibtexEntry>([['smith2020', {
      type: 'article',
      key: 'smith2020',
      fields: new Map([['author', 'Smith, John'], ['year', '2020']]),
    }]]);
    const run = { keys: ['smith2020'], locators: new Map([['smith2020', locator]]), text: 'smith2020, ' + locator };
    const result = generateCitation(run, entries, undefined, new Set<string>(), new Map<string, string | number>());
    expect(result.xml).toContain('&quot;locator&quot;:&quot;2\\n0&quot;');
    expect(result.xml).toContain('&quot;label&quot;:&quot;page&quot;');
  });

  it('keeps the label of a page locator over a line break once', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const { convertDocx } = await import('./converter');
    const bibtex = '@article{smith2020,\n  author = {Smith, Jane},\n  title = {T},\n  journal = {J},\n  year = {2020},\n}';
    const md = 'A [@smith2020, p. 1\n2] b.';
    const markdown = (await convertDocx((await convertMdToDocx(md, { bibtex })).docx)).markdown;
    expect(markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')).toBe(md + '\n');
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

  it('writes a key\'s line ends as spaces, in linear time', () => {
    // Its whitespace was read again from each space in it
    expect(fastestRun(() => {
      const xml = generateMissingKeysXml(['a  \n  b', 'c' + ' '.repeat(200000) + 'd']);
      expect(xml).toContain('Citation data for @a b was not found');
    })).toBeLessThan(500);
  }, 30000);

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

describe('bibliographyEntryAsShown', () => {
  // As citeproc writes an entry, and HTML lays it out
  const runs = (html: string) => htmlToOoxmlRuns(bibliographyEntryAsShown(html));

  it('writes a number in the margin, and the text beside it after a tab', () => {
    expect(runs('  <div class="csl-entry">\n    <div class="csl-left-margin">1. </div><div class="csl-right-inline">Doe J. <i>Title</i>.</div>\n  </div>\n'))
      .toBe('<w:r><w:t>1.</w:t><w:tab/></w:r><w:r><w:t xml:space="preserve">Doe J. </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>Title</w:t></w:r><w:r><w:t>.</w:t></w:r>');
  });

  it.each([
    ['a block', '  <div class="csl-entry">Doe J. Title.\n\n    <div class="csl-block">A note.</div>\n</div>\n'],
    ['an indented line', '  <div class="csl-entry">Doe J. Title.<div class="csl-indent">A note.</div>\n  </div>\n'],
  ])('writes %s on a line of its own', (_name, html) => {
    expect(runs(html)).toBe('<w:r><w:t>Doe J. Title.</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>A note.</w:t></w:r>');
  });

  it('runs whitespace together into one space, across formatting', () => {
    expect(runs('<div class="csl-entry">A <i> B\t</i>\n C </div>'))
      .toBe('<w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">B </w:t></w:r><w:r><w:t>C</w:t></w:r>');
  });

  it('keeps a non-breaking space, which HTML shows', () => {
    expect(runs('<div class="csl-entry">A\u00A0 \u00A0 B</div>')).toBe('<w:r><w:t>A\u00A0 \u00A0 B</w:t></w:r>');
  });
});

describe('htmlToOoxmlRuns formatting citeproc writes', () => {
  // citeproc turns off an outer element's formatting with a span inside it
  const t = (rPr: string, text: string) => '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + textElements(text) + '</w:r>';

  it.each([
    ['normal text in italic', '<i>a <span style="font-style:normal;">b</span> c</i>', t('<w:i/>', 'a ') + t('', 'b') + t('<w:i/>', ' c')],
    ['italic in italic', '<i>a <i>b</i> c</i>', t('<w:i/>', 'a ') + t('<w:i/>', 'b') + t('<w:i/>', ' c')],
    ['oblique', '<em>a</em>', t('<w:i/>', 'a')],
    ['normal weight in bold', '<b>a <span style="font-weight:normal;">b</span></b>', t('<w:b/>', 'a ') + t('', 'b')],
    ['normal small caps in small caps', '<span style="font-variant:small-caps;">a <span style="font-variant:normal;">b</span> c</span>',
      t('<w:smallCaps/>', 'a ') + t('', 'b') + t('<w:smallCaps/>', ' c')],
    ['an underline', '<span style="text-decoration:underline;">a</span>', t('<w:u w:val="single"/>', 'a')],
    ['no underline in an underline', '<span style="text-decoration:underline;">a <span style="text-decoration:none;">b</span></span>',
      t('<w:u w:val="single"/>', 'a ') + t('', 'b')],
    ['the baseline in a superscript', '<sup>a<span style="baseline">b</span></sup>', t('<w:vertAlign w:val="superscript"/>', 'a') + t('', 'b')],
    ['the baseline in a subscript', '<sub>a<span style="baseline">b</span></sub>', t('<w:vertAlign w:val="subscript"/>', 'a') + t('', 'b')],
    ['italic in normal text in italic', '<i>a <span style="font-style:normal;">b <i>c</i></span></i>', t('<w:i/>', 'a ') + t('', 'b ') + t('<w:i/>', 'c')],
  ])('writes %s', (_name, html, expected) => {
    expect(htmlToOoxmlRuns(html)).toBe(expected);
  });

  it('writes a title in an italic title as roman, as citeproc formats it', async () => {
    const bibtex = '@book{b,\n  author = {Smith, Sam},\n  title = {The <i>Origin</i> of Species},\n  publisher = {Press},\n  year = {2019}\n}\n';
    const { docx } = await convertMdToDocx('A [@b].\n', { bibtex });
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const entry = xml.match(/<w:pStyle w:val="Bibliography"\/>.*?<\/w:p>/)![0];
    expect(entry).toContain('<w:r><w:t>Origin</w:t></w:r>');
    expect(entry).toContain('<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> of Species</w:t></w:r>');
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
describe('citation prefixes', () => {
  function findCitationRun(tokens: ReturnType<typeof parseMd>): MdRun | undefined {
    for (const tok of tokens) {
      if (tok.runs) {
        const run = tok.runs.find(r => r.type === 'citation');
        if (run) return run;
      }
    }
    return undefined;
  }

  function makeEntries() {
    const entries = new Map<string, BibtexEntry>();
    entries.set('smith2020', { type: 'article', key: 'smith2020', fields: new Map([['author', 'Smith, John'], ['year', '2020']]) });
    entries.set('doe2021', { type: 'book', key: 'doe2021', fields: new Map([['author', 'Doe, Jane'], ['year', '2021']]) });
    return entries;
  }

  it('parses a prefix before the first key', () => {
    const run = findCitationRun(parseMd('[e.g., @smith2020; @doe2021]'));
    expect(run).toBeDefined();
    expect(run!.keys).toEqual(['smith2020', 'doe2021']);
    expect(run!.prefixes).toEqual(['e.g.,', '']);
    expect(run!.text).toBe('e.g., @smith2020; @doe2021');
  });

  it('parses per-item prefixes alongside locators and suppress-author', () => {
    const run = findCitationRun(parseMd('[see @smith2020, p. 4; see also -@doe2021]'));
    expect(run!.keys).toEqual(['smith2020', 'doe2021']);
    expect(run!.prefixes).toEqual(['see', 'see also']);
    expect(run!.locators!.get('smith2020')).toBe('p. 4');
    expect(run!.suppressAuthorKeys).toEqual(new Set(['doe2021']));
  });

  it('leaves unprefixed citations without prefixes', () => {
    const run = findCitationRun(parseMd('[@smith2020; @doe2021]'));
    expect(run!.prefixes).toBeUndefined();
  });

  it.each([
    ['an email address', '[write to me@example.com]'],
    ['link text mentioning someone', '[see @smith2020](https://example.com)'],
    ['reference link text', '[see @smith2020][ref]'],
    ['a key only after the first item', '[see above; @smith2020]'],
    ['an @ that does not start a key', '[5 @ 3]'],
    ['an @ inside a code span', '[see `git show @HEAD`]'],
    ['a prefix with CriticMarkup', '[see {++new++} @smith2020]'],
    ['a prefix with emphasis', '[see *also* @smith2020]'],
    ['emphasis around the key', '[*see @smith2020*]'],
    ['math around the key', '[see $x @smith2020$]'],
    ['an escaped @', '[see \\@smith2020]'],
    ['a shortcut reference link', '[see @smith2020]\n\n[see @smith2020]: https://example.com'],
  ])('does not treat %s as a citation', (_label, md) => {
    expect(findCitationRun(parseMd(md))).toBeUndefined();
  });

  it.each([
    ['[for n = 10, see @smith2020]', 'for n = 10, see'],
    ['[p < .05 in @smith2020]', 'p < .05 in'],
    ['[Smith & Jones, see @smith2020]', 'Smith & Jones, see'],
    ['[see \\*also\\* @smith2020]', 'see *also*'],
    ['[see https://example.com and @smith2020]', 'see https://example.com and'],
    ['[see https://example.com/a\\_b%20c @smith2020]', 'see https://example.com/a_b%20c'],
  ])('accepts punctuation that is not formatting: %s', (md, prefix) => {
    const run = findCitationRun(parseMd(md));
    expect(run!.keys).toEqual(['smith2020']);
    expect(run!.prefixes).toEqual([prefix]);
  });

  it('treats the key as opaque, so underscores in it are not emphasis', () => {
    const run = findCitationRun(parseMd('[see @_smith2020_]'));
    expect(run!.keys).toEqual(['_smith2020_']);
    expect(run!.prefixes).toEqual(['see']);
  });

  it('rejects an explicit autolink in the prefix', () => {
    expect(findCitationRun(parseMd('[see <https://example.com> @smith2020]'))).toBeUndefined();
  });

  it('keeps the link for a shortcut reference link', () => {
    const runs = parseMd('[see @smith2020]\n\n[see @smith2020]: https://example.com').flatMap(t => t.runs);
    expect(runs.some(r => r.href === 'https://example.com')).toBe(true);
  });

  it('accepts a non-ASCII key after a prefix', () => {
    const run = findCitationRun(parseMd('[see @Öztürk2020]'));
    expect(run!.keys).toEqual(['Öztürk2020']);
    expect(run!.prefixes).toEqual(['see']);
  });

  it('keeps distinct prefixes when a cluster repeats a key', () => {
    const run = findCitationRun(parseMd('[see @smith2020; compare @smith2020]'));
    expect(run!.keys).toEqual(['smith2020', 'smith2020']);
    expect(run!.prefixes).toEqual(['see', 'compare']);

    const csl = extractCsl(generateCitation(run!, makeEntries(), undefined, new Set(), new Map()).xml);
    expect(csl.citationItems.map((item: { prefix?: string }) => item.prefix)).toEqual(['see', 'compare']);
  });

  it('keeps prefixes with their items when some keys are missing', () => {
    const run = findCitationRun(parseMd('[e.g., @absent, p. 4; see @smith2020]'))!;
    const result = generateCitation(run, makeEntries(), undefined, new Set(), new Map());
    const csl = extractCsl(result.xml);
    expect(csl.citationItems.map((item: { prefix?: string }) => item.prefix)).toEqual(['see']);
    expect(result.xml).toContain('[e.g., @absent, p. 4]');
    expect(result.missingKeys).toEqual(['absent']);
  });

  it('starts the citation at an inner bracket rather than swallowing it as prefix', () => {
    const run = findCitationRun(parseMd('[aside [@smith2020]'));
    expect(run!.keys).toEqual(['smith2020']);
    expect(run!.prefixes).toBeUndefined();
  });

  it('writes the prefix to the Zotero citation item and keeps the cluster unsorted', () => {
    const run = { keys: ['smith2020', 'doe2021'], text: 'e.g., @smith2020; @doe2021', prefixes: ['e.g.,', ''] };
    const csl = extractCsl(generateCitation(run, makeEntries(), undefined, new Set(), new Map()).xml);
    expect(csl.citationItems[0].prefix).toBe('e.g.,');
    expect(csl.citationItems[1].prefix).toBeUndefined();
    expect(csl.properties.unsorted).toBe(true);
    expect(csl.properties.plainCitation).toBe('(e.g., Smith 2020; Doe 2021)');
  });

  it('does not mark unprefixed clusters unsorted', () => {
    const run = { keys: ['smith2020', 'doe2021'], text: '@smith2020; @doe2021' };
    const csl = extractCsl(generateCitation(run, makeEntries(), undefined, new Set(), new Map()).xml);
    expect(csl.properties.unsorted).toBeUndefined();
  });

  it('keeps the prefix in plain text for missing keys', () => {
    const run = { keys: ['john'], text: 'TODO ask @john', prefixes: ['TODO ask'] };
    const result = generateCitation(run, makeEntries());
    expect(result.xml).toContain('[TODO ask @john]');
    expect(result.missingKeys).toEqual(['john']);
  });

  it('fallback text: prefix precedes the author, or the year when suppressed', () => {
    const prefixes = ['e.g.,', 'cf.'];
    expect(generateFallbackText(['smith2020', 'doe2021'], makeEntries(), undefined, new Set(['doe2021']), prefixes))
      .toBe('(e.g., Smith 2020; cf. 2021)');
  });
});

describe('a BibTeX field wrapped across lines', () => {
  // Its line end and indentation went to citeproc, which wrote them as
  // no-break spaces, a gap in the bibliography and in a note's citation
  const bibtex = '@book{b,\n  author = {Smith,\n    Sam},\n  title = {A long title that\n           wraps onto a second line},\n  publisher = {Press},\n  year = {2019}\n}\n';

  it.each(['apa', 'chicago-notes-bibliography'])('shows one space in %s', style => {
    const engine = createCiteprocEngine(parseBibtex(bibtex), style)!;
    engine.updateItems(['b']);
    const entry = renderBibliography(engine)!.entries[0];
    expect(entry).toMatch(/that wraps/i);
    expect(entry).not.toContain('\u00A0');
    expect(renderCitationText(engine, ['b'])).not.toContain('\u00A0');
  });
});

describe('orderRPr', () => {
  it('puts run properties in schema order', () => {
    expect(orderRPr('<w:i/><w:b/><w:vertAlign w:val="superscript"/><w:smallCaps/><w:highlight w:val="red"/><w:sz w:val="18"/>'))
      .toBe('<w:b/><w:i/><w:smallCaps/><w:sz w:val="18"/><w:highlight w:val="red"/><w:vertAlign w:val="superscript"/>');
  });

  // Word writes a style's properties on lines of their own where it's asked
  // to indent its XML, and a tracked change's record holds others
  it('puts properties with whitespace between them, and ones that hold others, in schema order', () => {
    const record = '<w:rPrChange w:id="1" w:author="A"><w:rPr><w:i/><w:b/></w:rPr></w:rPrChange>';
    expect(orderRPr('\n  <w:b w:val="0"/>\n  ' + record + '\n  <w:rFonts w:ascii="A" w:hAnsi="A"></w:rFonts>\r\n\t<w:sz w:val="32" />\n'))
      .toBe('\n  <w:rFonts w:ascii="A" w:hAnsi="A"></w:rFonts>\n  <w:b w:val="0"/>\r\n\t<w:sz w:val="32" />\n  ' + record + '\n');
  });

  it('keeps an element it doesn\'t know in its place', () => {
    expect(orderRPr('<w:u w:val="single"/><w:foo/><w:b/>')).toBe('<w:b/><w:foo/><w:u w:val="single"/>');
    expect(orderRPr('<w:lang w:val="en-US"/><w14:ligatures w14:val="standard"/><w:b/>')).toBe('<w:b/><w14:ligatures w14:val="standard"/><w:lang w:val="en-US"/>');
  });

  it('leaves properties with text, a comment or a tag left open among them as they were', () => {
    for (const children of ['<w:u w:val="single"/>text<w:b/>', '<w:u w:val="single"/><!-- note --><w:b/>', '<w:u w:val="single"/><w:rPrChange><w:b/>', '<w:u w:val="single"/></w:rPr><w:b/>']) {
      expect(orderRPr(children)).toBe(children);
    }
  });

  // CT_RPr's children, in the order ECMA-376 Part 1 §17.3.2.28 gives them
  const SCHEMA_ORDER = [
    'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow',
    'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern',
    'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs',
    'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange',
  ];
  it('puts any of the properties, in any order and with any whitespace between them, in schema order, each once', () => {
    const element = (name: string) => fc.constantFrom(
      '<w:' + name + ' w:val="1"/>',
      '<w:' + name + '/>',
      '<w:' + name + '></w:' + name + '>',
      '<w:' + name + ' w:id="2"><w:rPr><w:b/><w:sz w:val="20"/></w:rPr></w:' + name + '>',
    );
    const whitespace = fc.constantFrom('', ' ', '\n', '\r\n    ', '\t\t');
    const properties = fc.shuffledSubarray(SCHEMA_ORDER).chain(names => fc.tuple(
      fc.constant(names), fc.tuple(...names.map(element)), fc.array(whitespace, { minLength: names.length + 1, maxLength: names.length + 1 })));
    fc.assert(fc.property(properties, ([names, elements, spaces]) => {
      const children = elements.map((xml, index) => spaces[index] + xml).join('') + spaces[elements.length];
      const ordered = orderRPr(children);
      // Each element once, in schema order, and the same whitespace
      const byRank = elements.map((xml, index) => ({ xml, rank: SCHEMA_ORDER.indexOf(names[index]) })).sort((a, b) => a.rank - b.rank);
      expect(ordered.replace(/>[ \t\r\n]+</g, '><').trim()).toBe(byRank.map(({ xml }) => xml).join(''));
      expect(ordered.replace(/[^ \t\r\n]/g, '').length).toBe(children.replace(/[^ \t\r\n]/g, '').length);
      expect(ordered.length).toBe(children.length);
    }), { numRuns: 200 });
  });
});
