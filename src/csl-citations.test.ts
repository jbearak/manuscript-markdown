import { describe, test, expect } from 'bun:test';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import {
  createCiteprocEngine,
  renderCitationText,
  renderBibliography,
  generateCitation,
  generateBibliographyXml,
  buildItemData,
} from './md-to-docx-citations';
import { loadStyle, loadLocale, BUNDLED_STYLES } from './csl-loader';
import {
  zoteroStyleShortName,
  zoteroStyleFullId,
} from './converter';
import { parseBibtex } from './bibtex-parser';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Sample BibTeX for testing
const SAMPLE_BIBTEX = `
@article{smith2020effects,
  author = {Smith, Alice},
  title = {{Effects of climate on agriculture}},
  journal = {Journal of Testing},
  volume = {10},
  pages = {1-15},
  year = {2020},
  doi = {10.1234/test.2020.001},
  zotero-key = {AAAA1111},
  zotero-uri = {http://zotero.org/users/0/items/AAAA1111},
}

@article{jones2019urban,
  author = {Jones, Bob and Lee, Carol},
  title = {{Urban planning and public health}},
  journal = {Review of Studies},
  volume = {5},
  pages = {100-120},
  year = {2019},
  doi = {10.1234/test.2019.002},
  zotero-key = {BBBB2222},
  zotero-uri = {http://zotero.org/users/0/items/BBBB2222},
}

@article{davis2021advances,
  author = {Davis, Eve},
  title = {{Advances in renewable energy systems}},
  journal = {Energy Research Letters},
  volume = {3},
  pages = {45-60},
  year = {2021},
  doi = {10.1234/test.2021.003},
  zotero-key = {CCCC3333},
  zotero-uri = {http://zotero.org/users/0/items/CCCC3333},
}
`;

// ============================================================================
// Frontmatter tests
// ============================================================================

describe('parseFrontmatter', () => {
  test('parses CSL, locale, and zotero-notes fields', () => {
    const input = '---\ncsl: apa\nlocale: en-US\nzotero-notes: footnotes\n---\nBody text here.';
    const { metadata, body } = parseFrontmatter(input);
    expect(metadata.csl).toBe('apa');
    expect(metadata.locale).toBe('en-US');
    expect(metadata.noteType).toBe('footnotes');
    expect(body).toBe('Body text here.');
  });

  test('parses legacy numeric zotero-notes values', () => {
    expect(parseFrontmatter('---\nzotero-notes: 0\n---\n').metadata.noteType).toBe('in-text');
    expect(parseFrontmatter('---\nzotero-notes: 1\n---\n').metadata.noteType).toBe('footnotes');
    expect(parseFrontmatter('---\nzotero-notes: 2\n---\n').metadata.noteType).toBe('endnotes');
  });

  test('handles missing frontmatter', () => {
    const input = 'Just some plain markdown.';
    const { metadata, body } = parseFrontmatter(input);
    expect(metadata.csl).toBeUndefined();
    expect(body).toBe('Just some plain markdown.');
  });

  test('handles frontmatter with only CSL', () => {
    const input = '---\ncsl: chicago-author-date\n---\nParagraph.';
    const { metadata, body } = parseFrontmatter(input);
    expect(metadata.csl).toBe('chicago-author-date');
    expect(metadata.locale).toBeUndefined();
    expect(metadata.noteType).toBeUndefined();
    expect(body).toBe('Paragraph.');
  });

  test('handles quoted values', () => {
    const input = '---\ncsl: "apa"\nlocale: \'en-GB\'\n---\nText.';
    const { metadata } = parseFrontmatter(input);
    expect(metadata.csl).toBe('apa');
    expect(metadata.locale).toBe('en-GB');
  });

  test('handles unclosed frontmatter (no end delimiter)', () => {
    const input = '---\ncsl: apa\nSome text without closing delimiter';
    const { metadata, body } = parseFrontmatter(input);
    expect(metadata.csl).toBeUndefined();
    expect(body).toBe(input);
  });
});

describe('serializeFrontmatter', () => {
  test('serializes all fields', () => {
    const result = serializeFrontmatter({ csl: 'apa', locale: 'en-US', noteType: 'footnotes' });
    expect(result).toBe('---\ncsl: apa\nlocale: en-US\nzotero-notes: footnotes\n---\n');
  });

  test('returns empty string for empty metadata', () => {
    expect(serializeFrontmatter({})).toBe('');
  });

  test('omits undefined fields', () => {
    const result = serializeFrontmatter({ csl: 'ieee' });
    expect(result).toBe('---\ncsl: ieee\n---\n');
    expect(result).not.toContain('locale');
    expect(result).not.toContain('zotero-notes');
  });
});

// ============================================================================
// CSL Loader tests
// ============================================================================

describe('CSL Loader', () => {
  test('loads all bundled styles', () => {
    for (const name of BUNDLED_STYLES) {
      const xml = loadStyle(name);
      expect(xml).toContain('<style');
      expect(xml).toContain('</style>');
    }
  });

  test('loads en-US locale', () => {
    const xml = loadLocale('en-US');
    expect(xml).toContain('<locale');
  });

  test('falls back to en-US for unknown locales', () => {
    const xml = loadLocale('xx-XX');
    expect(xml).toContain('<locale');
  });

  test('throws for unknown style names', () => {
    expect(() => loadStyle('nonexistent-style-xyz')).toThrow();
  });
});

// ============================================================================
// Zotero style name helpers
// ============================================================================

describe('Zotero style name helpers', () => {
  test('zoteroStyleShortName strips prefix', () => {
    expect(zoteroStyleShortName('http://www.zotero.org/styles/apa')).toBe('apa');
    expect(zoteroStyleShortName('http://www.zotero.org/styles/chicago-author-date')).toBe('chicago-author-date');
  });

  test('zoteroStyleShortName passes through non-Zotero IDs', () => {
    expect(zoteroStyleShortName('custom-style')).toBe('custom-style');
  });

  test('zoteroStyleFullId adds prefix', () => {
    expect(zoteroStyleFullId('apa')).toBe('http://www.zotero.org/styles/apa');
  });

  test('zoteroStyleFullId passes through full URLs', () => {
    expect(zoteroStyleFullId('http://www.zotero.org/styles/apa')).toBe('http://www.zotero.org/styles/apa');
  });
});

// ============================================================================
// Citeproc engine tests
// ============================================================================

describe('createCiteprocEngine', () => {
  test('creates engine with APA style', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');
    expect(engine).toBeDefined();
  });

  test('creates engine with Chicago author-date style', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'chicago-author-date');
    expect(engine).toBeDefined();
  });

  test('returns undefined for nonexistent style', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'nonexistent-xyz');
    expect(engine).toBeUndefined();
  });
});

describe('renderCitationText', () => {
  test('renders APA-style citation', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');
    expect(engine).toBeDefined();

    const text = renderCitationText(engine, ['smith2020effects']);
    expect(text).toBeDefined();
    expect(text).toContain('Smith');
    expect(text).toContain('2020');
  });

  test('renders grouped citation', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');

    const text = renderCitationText(engine, ['smith2020effects', 'jones2019urban']);
    expect(text).toBeDefined();
    expect(text).toContain('Smith');
    expect(text).toContain('Jones');
  });

  test('renders citation with locator', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');

    const locators = new Map([['smith2020effects', 'p. 15']]);
    const text = renderCitationText(engine, ['smith2020effects'], locators);
    expect(text).toBeDefined();
    expect(text).toContain('15');
  });

  test('renders IEEE-style numeric citation', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'ieee');

    const text = renderCitationText(engine, ['smith2020effects']);
    expect(text).toBeDefined();
    // IEEE uses [1] style numeric citations
    expect(text).toMatch(/\[?\d+\]?/);
  });
});

describe('renderBibliography', () => {
  test('renders bibliography for APA', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');
    expect(engine).toBeDefined();

    // Need to process at least one citation before bibliography works
    renderCitationText(engine, ['smith2020effects', 'jones2019urban', 'davis2021advances']);

    const bib = renderBibliography(engine);
    expect(bib).toBeDefined();
    expect(bib!.entries.length).toBeGreaterThan(0);
    // Should contain author names
    expect(bib!.entries.join('')).toContain('Smith');
  });
});

// ============================================================================
// generateCitation with citeproc engine
// ============================================================================

describe('generateCitation with citeproc', () => {
  test('uses citeproc-rendered text in field code', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');

    const run = {
      keys: ['smith2020effects'],
      locators: new Map<string, string>(),
      text: 'smith2020effects',
    };

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, number>();
    const result = generateCitation(run, entries, engine, usedIds, itemIdMap);
    expect(result.xml).toContain('ZOTERO_ITEM');
    expect(result.xml).toContain('Smith');
    expect(result.xml).toContain('2020');
  });

  test('falls back to plain text when no engine', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);

    const run = {
      keys: ['smith2020effects'],
      locators: new Map<string, string>(),
      text: 'smith2020effects',
    };

    const usedIds = new Set<string>();
    const itemIdMap = new Map<string, number>();
    const result = generateCitation(run, entries, undefined, usedIds, itemIdMap);
    expect(result.xml).toContain('ZOTERO_ITEM');
    expect(result.xml).toContain('Smith');
  });
});

// ============================================================================
// Bibliography XML generation
// ============================================================================

describe('generateBibliographyXml', () => {
  test('generates ZOTERO_BIBL field code', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');
    renderCitationText(engine, ['smith2020effects']);

    const xml = generateBibliographyXml(engine);
    expect(xml).toContain('ZOTERO_BIBL');
    expect(xml).toContain('CSL_BIBLIOGRAPHY');
    expect(xml).toContain('fldCharType="begin"');
    expect(xml).toContain('fldCharType="end"');
  });

  test('includes bibliography entries', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');
    renderCitationText(engine, ['smith2020effects', 'jones2019urban']);

    const xml = generateBibliographyXml(engine);
    expect(xml).toContain('Smith');
  });

  test('preserves uncited/omitted/custom arrays', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');
    renderCitationText(engine, ['smith2020effects']);

    const biblData = { uncited: [['http://example.com']], omitted: [], custom: [] };
    const xml = generateBibliographyXml(engine, biblData);
    expect(xml).toContain('http://example.com');
  });
});

// ============================================================================
// MD→DOCX roundtrip with CSL style
// ============================================================================

describe('MD→DOCX with CSL frontmatter', () => {
  test('generates DOCX with Zotero field codes using APA style', async () => {
    const md = '---\ncsl: apa\n---\n\nSome text [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });
    expect(result.docx).toBeDefined();
    expect(result.warnings.length).toBe(0);
  });

  test('generated DOCX contains custom.xml with ZOTERO_PREF', async () => {
    const md = '---\ncsl: apa\n---\n\nSome text [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    expect(customXml).toBeDefined();
    expect(customXml).toContain('ZOTERO_PREF_1');
    expect(customXml).toContain('http://www.zotero.org/styles/apa');
  });

  test('generated DOCX contains ZOTERO_BIBL field', async () => {
    const md = '---\ncsl: apa\n---\n\nSome text [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');
    expect(docXml).toContain('ZOTERO_BIBL');
  });

  test('content types includes custom properties', async () => {
    const md = '---\ncsl: apa\n---\n\nSome text [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const ctXml = await zip.file('[Content_Types].xml')?.async('string');
    expect(ctXml).toContain('custom-properties');
  });

  test('rels includes custom properties relationship', async () => {
    const md = '---\ncsl: apa\n---\n\nSome text [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const relsXml = await zip.file('_rels/.rels')?.async('string');
    expect(relsXml).toContain('custom-properties');
    expect(relsXml).toContain('docProps/custom.xml');
  });
});

describe('MD→DOCX without CSL frontmatter', () => {
  test('does not generate custom.xml when no CSL specified', async () => {
    const md = 'Some text [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const customXml = zip.file('docProps/custom.xml');
    expect(customXml).toBeNull();
  });

  test('does not generate ZOTERO_BIBL when no CSL specified', async () => {
    const md = 'Some text [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');
    expect(docXml).not.toContain('ZOTERO_BIBL');
  });
});

// ============================================================================
// DOCX→MD roundtrip: prefs extraction and bibliography skip
// ============================================================================

describe('DOCX→MD→DOCX roundtrip', () => {
  test('roundtrip preserves CSL style in frontmatter', async () => {
    const md = '---\ncsl: apa\n---\n\nSome text [@smith2020effects].\n';
    const docxResult = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const mdResult = await convertDocx(docxResult.docx);
    expect(mdResult.markdown).toContain('csl: apa');
    expect(mdResult.zoteroPrefs).toBeDefined();
    expect(mdResult.zoteroPrefs?.styleId).toContain('apa');
  });

  test('ZOTERO_BIBL content is not in markdown output', async () => {
    const md = '---\ncsl: apa\n---\n\nSome text [@smith2020effects].\n';
    const docxResult = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const mdResult = await convertDocx(docxResult.docx);
    // The bibliography rendered text should not appear in the markdown
    // (it's inside a ZOTERO_BIBL field that we skip)
    // The markdown should contain the citation but not the bibliography text
    expect(mdResult.markdown).toMatch(/@smith2020effects/);
    // Should not contain "Sources" heading either
    expect(mdResult.markdown).not.toMatch(/^#+\s*Sources/m);
  });
});

// ============================================================================
// buildItemData
// ============================================================================

describe('buildItemData', () => {
  test('builds CSL-JSON from BibTeX entry', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const entry = entries.get('smith2020effects')!;
    const itemData = buildItemData(entry);

    expect(itemData.type).toBe('article-journal');
    expect(itemData.title).toContain('Effects of climate on agriculture');
    expect(itemData.author).toEqual([{ family: 'Smith', given: 'Alice' }]);
    expect(itemData.issued).toEqual({ 'date-parts': [[2020]] });
    expect(itemData['container-title']).toBe('Journal of Testing');
    expect(itemData.volume).toBe('10');
    expect(itemData.page).toBe('1-15');
    expect(itemData.DOI).toBe('10.1234/test.2020.001');
  });
});

// ============================================================================
// CSL file path resolution (relative, absolute, bundled)
// ============================================================================

describe('CSL file path resolution', () => {
  const apaCslPath = join(__dirname, 'csl-styles', 'apa.csl');
  const apaCslContent = readFileSync(apaCslPath, 'utf-8');

  test('resolves a relative .csl path via sourceDir', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'csl-test-'));
    try {
      writeFileSync(join(tmpDir, 'my-style.csl'), apaCslContent);
      const md = '---\ncsl: my-style.csl\n---\n\nText [@smith2020effects].\n';
      const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX, sourceDir: tmpDir });
      expect(result.warnings.length).toBe(0);
      expect(result.docx).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('resolves an absolute .csl path', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'csl-test-'));
    try {
      const absPath = join(tmpDir, 'abs-style.csl');
      writeFileSync(absPath, apaCslContent);
      const md = `---\ncsl: ${absPath}\n---\n\nText [@smith2020effects].\n`;
      const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });
      expect(result.warnings.length).toBe(0);
      expect(result.docx).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('warns when relative .csl path does not exist in sourceDir', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'csl-test-'));
    try {
      const md = '---\ncsl: nonexistent.csl\n---\n\nText [@smith2020effects].\n';
      const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX, sourceDir: tmpDir });
      expect(result.warnings.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('warns when relative .csl path has no sourceDir', async () => {
    const md = '---\ncsl: some-style.csl\n---\n\nText [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });
    expect(result.warnings.some(w => w.includes('cannot be resolved'))).toBe(true);
  });

  test('bundled style names are unaffected by sourceDir', async () => {
    const md = '---\ncsl: apa\n---\n\nText [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX, sourceDir: '/nonexistent' });
    expect(result.warnings.length).toBe(0);
    expect(result.docx).toBeDefined();
  });
});

// ============================================================================
// Mixed citation groups in full pipeline
// ============================================================================

const MIXED_BIBTEX = `
@article{zotEntry,
  author = {Zotero, Alice},
  title = {{A Zotero Article}},
  journal = {Journal of Testing},
  year = {2020},
  zotero-key = {ZOT11111},
  zotero-uri = {http://zotero.org/users/0/items/ZOT11111},
}

@article{plainEntry,
  author = {Plain, Bob},
  title = {{A Plain Article}},
  journal = {Other Journal},
  year = {2021},
}
`;

describe('Mixed citation groups in pipeline', () => {
  test('mixed group produces single field code for all resolved entries', async () => {
    const md = '---\ncsl: apa\n---\n\nText [@zotEntry; @plainEntry].\n';
    const result = await convertMdToDocx(md, { bibtex: MIXED_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');

    // Both entries should be in a single field code
    expect(docXml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(docXml).toContain('ZOT11111');
    // Non-Zotero entry should also be in the field code (via itemData)
    expect(docXml).toContain('Plain');
  });

  test('missing keys appear after bibliography in DOCX', async () => {
    const md = '---\ncsl: apa\n---\n\nText [@zotEntry; @noSuchKey].\n';
    const result = await convertMdToDocx(md, { bibtex: MIXED_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');

    // Should have the missing key note after bibliography
    expect(docXml).toContain('Citation data for @noSuchKey was not found in the bibliography file.');
    // Should still have the Zotero field code
    expect(docXml).toContain('ZOTERO_ITEM CSL_CITATION');
    // Warning should mention the missing key
    expect(result.warnings.some(w => w.includes('noSuchKey'))).toBe(true);
  });

  test('mixed group produces single field code regardless of mixedCitationStyle', async () => {
    const md = '---\ncsl: apa\n---\n\nText [@zotEntry; @plainEntry].\n';
    const result = await convertMdToDocx(md, { bibtex: MIXED_BIBTEX, mixedCitationStyle: 'unified' });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');

    // All resolved entries share a single field code
    expect(docXml).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(docXml).toContain('Zotero');
    expect(docXml).toContain('Plain');
  });
});
