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
import {
  loadStyle,
  loadLocale,
  isCslAvailable,
  registerBundledCslAssets,
  BUNDLED_STYLES,
} from './csl-loader';
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
    expect(metadata.zoteroNotes).toBe('footnotes');
    expect(body).toBe('Body text here.');
  });

  test('parses legacy numeric zotero-notes values', () => {
    expect(parseFrontmatter('---\nzotero-notes: 0\n---\n').metadata.zoteroNotes).toBe('in-text');
    expect(parseFrontmatter('---\nzotero-notes: 1\n---\n').metadata.zoteroNotes).toBe('footnotes');
    expect(parseFrontmatter('---\nzotero-notes: 2\n---\n').metadata.zoteroNotes).toBe('endnotes');
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
    expect(metadata.zoteroNotes).toBeUndefined();
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
    const result = serializeFrontmatter({ csl: 'apa', locale: 'en-US', zoteroNotes: 'footnotes' });
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

  test('does not emit duplicate when fieldOrder has canonical before alias', () => {
    const result = serializeFrontmatter(
      { zoteroNotes: 'endnotes' },
      ['zotero-notes', 'note-type'],
    );
    expect(result).toBe('---\nzotero-notes: endnotes\n---\n');
    // Should appear exactly once
    expect(result.match(/zotero-notes/g)?.length).toBe(1);
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

  test('loads both NLM variants through public aliases with upstream metadata intact', () => {
    expect(BUNDLED_STYLES).toContain('nlm');
    expect(BUNDLED_STYLES).toContain('nlm-brackets');

    const standardXml = loadStyle('nlm');
    expect(standardXml).toContain('<title>NLM/Vancouver: Citing Medicine 2nd edition (citation-sequence)</title>');
    expect(standardXml).toContain('<id>http://www.zotero.org/styles/nlm-citation-sequence</id>');
    expect(standardXml).toContain('http://creativecommons.org/licenses/by-sa/3.0/');
    expect(standardXml).toContain('<layout delimiter="," prefix="(" suffix=")">');

    const bracketsXml = loadStyle('nlm-brackets');
    expect(bracketsXml).toContain('<title>NLM/Vancouver: Citing Medicine 2nd edition (citation-sequence, brackets)</title>');
    expect(bracketsXml).toContain('<id>http://www.zotero.org/styles/nlm-citation-sequence-brackets</id>');
    expect(bracketsXml).toContain('http://creativecommons.org/licenses/by-sa/3.0/');
    expect(bracketsXml).toContain('<layout delimiter="," prefix="[" suffix="]">');
  });

  test('loads styles and locales from registered native assets', () => {
    const styleXml = '<?xml version="1.0"?><style xmlns="http://purl.org/net/xbiblio/csl"></style>';
    const localeXml = '<?xml version="1.0"?><locale xmlns="http://purl.org/net/xbiblio/csl"></locale>';
    registerBundledCslAssets({
      styles: new Map([['embedded-test', styleXml]]),
      locales: new Map([['zz-ZZ', localeXml]]),
    });
    try {
      expect(isCslAvailable('embedded-test')).toBe(true);
      expect(loadStyle('embedded-test')).toBe(styleXml);
      expect(loadLocale('zz-ZZ')).toBe(localeXml);
    } finally {
      registerBundledCslAssets(undefined);
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

  test('maps both NLM public aliases to and from canonical Zotero IDs', () => {
    const standard = 'http://www.zotero.org/styles/nlm-citation-sequence';
    const brackets = 'http://www.zotero.org/styles/nlm-citation-sequence-brackets';
    expect(zoteroStyleFullId('nlm')).toBe(standard);
    expect(zoteroStyleShortName(standard)).toBe('nlm');
    expect(zoteroStyleFullId('nlm-brackets')).toBe(brackets);
    expect(zoteroStyleShortName(brackets)).toBe('nlm-brackets');
  });

  test('keeps Vancouver separate from the NLM alias', () => {
    expect(zoteroStyleFullId('vancouver')).toBe('http://www.zotero.org/styles/vancouver');
    expect(zoteroStyleShortName('http://www.zotero.org/styles/vancouver')).toBe('vancouver');
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
    engine.updateItems([...entries.keys()]);

    const text = renderCitationText(engine, ['smith2020effects']);
    expect(text).toBeDefined();
    // IEEE uses [1] style numeric citations
    expect(text).toMatch(/\[?\d+\]?/);
  });

  test('renders the standard and bracketed NLM citation-sequence variants', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const standard = createCiteprocEngine(entries, 'nlm');
    const brackets = createCiteprocEngine(entries, 'nlm-brackets');
    standard.updateItems(['jones2019urban', 'smith2020effects']);
    brackets.updateItems(['jones2019urban', 'smith2020effects']);

    expect(renderCitationText(standard, ['jones2019urban'])).toBe('(1)');
    expect(renderCitationText(standard, ['smith2020effects'])).toBe('(2)');
    expect(renderCitationText(brackets, ['jones2019urban'])).toBe('[1]');
    expect(renderCitationText(brackets, ['smith2020effects'])).toBe('[2]');
    expect(renderCitationText(brackets, ['jones2019urban', 'smith2020effects'])).toBe('[1,2]');
  });

  test('keeps Vancouver parenthesized numeric citations', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'vancouver');
    engine.updateItems(['smith2020effects']);

    expect(renderCitationText(engine, ['smith2020effects'])).toBe('(1)');
  });
});

describe('renderBibliography', () => {
  test('renders bibliography for APA', () => {
    const entries = parseBibtex(SAMPLE_BIBTEX);
    const engine = createCiteprocEngine(entries, 'apa');
    expect(engine).toBeDefined();

    // Register items and process citations before bibliography works
    engine.updateItems(['smith2020effects', 'jones2019urban', 'davis2021advances']);
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
    const itemIdMap = new Map<string, string | number>();
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
    const itemIdMap = new Map<string, string | number>();
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
    engine.updateItems(['smith2020effects', 'jones2019urban']);
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
  test('generates custom.xml with bib key order even without CSL', async () => {
    const md = 'Some text [@smith2020effects].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    expect(customXml).toContain('MANUSCRIPT_BIB_KEY_ORDER');
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

  test('bibliography does not add trailing blank lines on round-trip', async () => {
    const md = '---\ncsl: apa\n---\n\nHello [@smith2020effects].\n\n<!-- end -->';
    const docxResult = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const mdResult = await convertDocx(docxResult.docx);
    // Should end with exactly one trailing newline (POSIX), not two
    expect(mdResult.markdown).toMatch(/<!-- end -->\n$/);
    expect(mdResult.markdown).not.toMatch(/<!-- end -->\n\n$/);
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
    expect(docXml).toContain('Zotero');
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

});

// ============================================================================
// Footnote/endnote citations in bibliography
// ============================================================================

describe('Footnote/endnote citations in bibliography', () => {
  test('footnote-only citation appears in bibliography', async () => {
    const md = '---\ncsl: apa\n---\n\nSome text.[^fn1]\n\n[^fn1]: See [@davis2021advances].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');

    // The bibliography should include the footnote-only entry
    expect(docXml).toContain('Davis');
    expect(docXml).toContain('Advances in renewable energy systems');
  });

  test('both main-body and footnote-only citations appear in bibliography', async () => {
    const md = '---\ncsl: apa\n---\n\nMain body text [@smith2020effects].[^fn1]\n\n[^fn1]: Footnote cites [@jones2019urban].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');

    // Both entries should appear in the bibliography
    expect(docXml).toContain('Smith');
    expect(docXml).toContain('Effects of climate on agriculture');
    expect(docXml).toContain('Jones');
    expect(docXml).toContain('Urban planning and public health');
  });

  test('endnote-only citation appears in bibliography', async () => {
    const md = '---\ncsl: apa\nnotes: endnotes\n---\n\nSome text.[^en1]\n\n[^en1]: See [@davis2021advances].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');

    // The bibliography should include the endnote-only entry
    expect(docXml).toContain('Davis');
    expect(docXml).toContain('Advances in renewable energy systems');
  });
});

// ============================================================================
// Bibliography marker placement (<!-- references -->)
// ============================================================================

describe('Bibliography marker placement', () => {
  test('marker places bibliography at marker position in OOXML', async () => {
    const md = '---\ncsl: apa\n---\n\nMain text [@smith2020effects].\n\n<!-- references -->\n\nSupplementary text.\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string') || '';

    // Bibliography should appear before supplementary text
    const biblIdx = docXml.indexOf('ZOTERO_BIBL');
    const suppIdx = docXml.indexOf('Supplementary text');
    expect(biblIdx).toBeGreaterThan(-1);
    expect(suppIdx).toBeGreaterThan(-1);
    expect(biblIdx).toBeLessThan(suppIdx);
  });

  test('without marker, bibliography goes at end (default)', async () => {
    const md = '---\ncsl: apa\n---\n\nMain text [@smith2020effects].\n\nMore text.\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string') || '';

    const biblIdx = docXml.indexOf('ZOTERO_BIBL');
    const moreIdx = docXml.indexOf('More text');
    expect(biblIdx).toBeGreaterThan(moreIdx);
  });

  test('citations after marker are included in bibliography', async () => {
    const md = '---\ncsl: apa\n---\n\nMain text [@smith2020effects].\n\n<!-- references -->\n\nSupplementary [@jones2019urban].\n';
    const result = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string') || '';

    // Both cited works should appear in the bibliography
    expect(docXml).toContain('Smith');
    expect(docXml).toContain('Jones');
    // Bibliography should be between main and supplementary text
    const biblIdx = docXml.indexOf('ZOTERO_BIBL');
    const suppIdx = docXml.indexOf('Supplementary');
    expect(biblIdx).toBeLessThan(suppIdx);
  });

  test('round-trip preserves marker when bibliography is mid-document', async () => {
    const md = '---\ncsl: apa\n---\n\nMain text [@smith2020effects].\n\n<!-- references -->\n\nSupplementary material.\n';
    const docxResult = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });
    const mdResult = await convertDocx(docxResult.docx);

    expect(mdResult.markdown).toContain('<!-- references -->');
    // Marker should appear between main text and supplementary material
    const markerIdx = mdResult.markdown.indexOf('<!-- references -->');
    const mainIdx = mdResult.markdown.indexOf('Main text');
    const suppIdx = mdResult.markdown.indexOf('Supplementary material');
    expect(markerIdx).toBeGreaterThan(mainIdx);
    expect(markerIdx).toBeLessThan(suppIdx);
  });

  test('round-trip without marker does not inject one', async () => {
    const md = '---\ncsl: apa\n---\n\nSome text [@smith2020effects].\n';
    const docxResult = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });
    const mdResult = await convertDocx(docxResult.docx);

    expect(mdResult.markdown).not.toContain('<!-- references -->');
    expect(mdResult.markdown).not.toContain('<!-- bibliography -->');
  });

  test('<!-- bibliography --> alias round-trips as <!-- references -->', async () => {
    const md = '---\ncsl: apa\n---\n\nMain text [@smith2020effects].\n\n<!-- bibliography -->\n\nAfter bib.\n';
    const docxResult = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });
    const mdResult = await convertDocx(docxResult.docx);

    expect(mdResult.markdown).toContain('<!-- references -->');
  });

  test('standard NLM round-trips through its canonical Zotero ID', async () => {
    const md = '---\ncsl: nlm\n---\n\nCitation [@smith2020effects].\n';
    const docxResult = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docxResult.docx);
    const docXml = await zip.file('word/document.xml')?.async('string') ?? '';
    const customXml = await zip.file('docProps/custom.xml')?.async('string') ?? '';
    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const field = docXml.match(/CSL_CITATION\s+(.*?)\s*<\/w:instrText>/);

    expect(field).not.toBeNull();
    expect(JSON.parse(decode(field![1])).properties.plainCitation).toBe('(1)');
    expect(customXml).toContain('http://www.zotero.org/styles/nlm-citation-sequence');
    expect(customXml).not.toContain('nlm-citation-sequence-brackets');

    const roundTrip = await convertDocx(docxResult.docx);
    expect(roundTrip.markdown).toContain('csl: nlm');
  });

  test('NLM brackets works offline through Markdown-to-DOCX with cited-only bibliography', async () => {
    const md = '---\ncsl: nlm-brackets\n---\n\nFirst [@davis2021advances], then [@smith2020effects].\n';
    const docxResult = await convertMdToDocx(md, { bibtex: SAMPLE_BIBTEX });
    expect(docxResult.warnings).toEqual([]);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docxResult.docx);
    const docXml = await zip.file('word/document.xml')?.async('string') ?? '';
    const customXml = await zip.file('docProps/custom.xml')?.async('string') ?? '';
    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const fieldCodes = [...docXml.matchAll(/CSL_CITATION\s+(.*?)\s*<\/w:instrText>/g)];

    expect(fieldCodes.length).toBe(2);
    expect(JSON.parse(decode(fieldCodes[0][1])).properties.plainCitation).toBe('[1]');
    expect(JSON.parse(decode(fieldCodes[1][1])).properties.plainCitation).toBe('[2]');
    expect(customXml).toContain('http://www.zotero.org/styles/nlm-citation-sequence-brackets');
    expect(docXml).toContain('ZOTERO_BIBL');
    expect(docXml).toContain('Advances in renewable energy systems');
    expect(docXml).toContain('Effects of climate on agriculture');
    expect(docXml).not.toContain('Urban planning and public health');

    const roundTrip = await convertDocx(docxResult.docx);
    expect(roundTrip.markdown).toContain('csl: nlm-brackets');
  });

  test('numeric CSL style assigns citation numbers by document order, not bib-file order', async () => {
    // Bib file has entries in alphabetical order: alpha, beta, gamma
    const bibtex = `
@article{alpha2020,
  author = {Alpha, A.},
  title = {Alpha paper},
  journal = {J},
  year = {2020},
}
@article{beta2020,
  author = {Beta, B.},
  title = {Beta paper},
  journal = {J},
  year = {2020},
}
@article{gamma2020,
  author = {Gamma, G.},
  title = {Gamma paper},
  journal = {J},
  year = {2020},
}
`;
    // Document cites gamma first, then alpha — should be numbered 1, 2 (not 3, 1)
    const md = '---\ncsl: science\n---\n\nFirst [@gamma2020], then [@alpha2020].\n';
    const docxResult = await convertMdToDocx(md, { bibtex });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docxResult.docx);
    const docXml = await zip.file('word/document.xml')?.async('string') ?? '';

    // The visible citation text for @gamma2020 (cited first) should be "1"
    // and @alpha2020 (cited second) should be "2", not their bib-file positions (3, 1)
    // Science style wraps numbers in <i> tags, so the visible text is "(1)" and "(2)"
    // In the OOXML, these appear as <w:t> runs within the field codes.
    // Extract the plainCitation values from the two ZOTERO_ITEM field codes
    const fieldCodes = [...docXml.matchAll(/CSL_CITATION\s+(.*?)\s*<\/w:instrText>/g)];
    expect(fieldCodes.length).toBe(2);

    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const first = JSON.parse(decode(fieldCodes[0][1]));
    const second = JSON.parse(decode(fieldCodes[1][1]));

    expect(first.properties.plainCitation).toBe('(1)');
    expect(second.properties.plainCitation).toBe('(2)');
  });

  test('footnote citations are numbered at the point of the footnote reference, not after body', async () => {
    const bibtex = `
@article{alpha2020,
  author = {Alpha, A.},
  title = {Alpha paper},
  journal = {J},
  year = {2020},
}
@article{beta2020,
  author = {Beta, B.},
  title = {Beta paper},
  journal = {J},
  year = {2020},
}
`;
    // Footnote [^1] references @alpha2020; the body later cites @beta2020.
    // @alpha2020 should be (1) because the footnote ref appears first in the body.
    const md = '---\ncsl: science\n---\n\nSee note[^1], then [@beta2020].\n\n[^1]: Footnote text [@alpha2020].\n';
    const docxResult = await convertMdToDocx(md, { bibtex });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docxResult.docx);

    // Citations in footnotes go into footnotes.xml, not document.xml
    const footnotesXml = await zip.file('word/footnotes.xml')?.async('string') ?? '';
    const docXml = await zip.file('word/document.xml')?.async('string') ?? '';

    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    const fnFields = [...footnotesXml.matchAll(/CSL_CITATION\s+(.*?)\s*<\/w:instrText>/g)];
    const bodyFields = [...docXml.matchAll(/CSL_CITATION\s+(.*?)\s*<\/w:instrText>/g)];

    expect(fnFields.length).toBe(1);
    expect(bodyFields.length).toBe(1);

    const fnCitation = JSON.parse(decode(fnFields[0][1]));
    const bodyCitation = JSON.parse(decode(bodyFields[0][1]));

    // @alpha2020 in footnote should be (1) since footnote ref comes first in body
    expect(fnCitation.properties.plainCitation).toBe('(1)');
    // @beta2020 in body should be (2)
    expect(bodyCitation.properties.plainCitation).toBe('(2)');
  });
});
