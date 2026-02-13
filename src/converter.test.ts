import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  extractComments,
  extractZoteroCitations,
  buildCitationKeyMap,
  extractDocumentContent,
  buildMarkdown,
  generateBibTeX,
  convertDocx,
  generateCitationKey,
} from './converter';

const fixturesDir = join(__dirname, '..', 'test', 'fixtures');
const sampleData = new Uint8Array(readFileSync(join(fixturesDir, 'sample.docx')));
const expectedMd = readFileSync(join(fixturesDir, 'expected-output.md'), 'utf-8').trimEnd();
const expectedBib = readFileSync(join(fixturesDir, 'expected-output.bib'), 'utf-8').trimEnd();

describe('extractComments', () => {
  test('extracts all comments with correct metadata', async () => {
    const comments = await extractComments(sampleData);
    expect(comments.size).toBe(3);
    expect(comments.get('1')?.author).toBe('Alice Reviewer');
    expect(comments.get('2')?.author).toBe('Bob Editor');
    expect(comments.get('1')?.text).toContain('scope of these trends');
    expect(comments.get('2')?.text).toContain('which regions');
    expect(comments.get('3')?.text).toContain('framework reference');
  });
});

describe('extractZoteroCitations', () => {
  test('extracts Zotero citations in document order', async () => {
    const citations = await extractZoteroCitations(sampleData);
    expect(citations.length).toBe(3);
    expect(citations[0].plainCitation).toBe('(Smith 2020)');
    expect(citations[0].items.length).toBe(1);
    expect(citations[1].plainCitation).toBe('(Jones 2019; Smith 2020)');
    expect(citations[1].items.length).toBe(2);
    expect(citations[2].plainCitation).toBe('(Davis 2021)');
    expect(citations[2].items.length).toBe(1);
  });

  test('extracts split w:instrText across multiple w:r elements', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const davis = citations[2];
    expect(davis.plainCitation).toBe('(Davis 2021)');
    expect(davis.items[0].title).toBe('Advances in renewable energy systems');
    expect(davis.items[0].doi).toBe('10.1234/test.2021.003');
  });

  test('extracts correct metadata from citation items', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const smith = citations[0].items[0];
    expect(smith.title).toBe('Effects of climate on agriculture');
    expect(smith.year).toBe('2020');
    expect(smith.doi).toBe('10.1234/test.2020.001');
    expect(smith.authors[0].family).toBe('Smith');
  });
});

describe('buildCitationKeyMap', () => {
  test('generates unique keys and deduplicates by DOI', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations);
    expect(keyMap.size).toBe(3); // Smith appears twice but same DOI
    expect(keyMap.get('doi:10.1234/test.2020.001')).toBe('smith2020effects');
    expect(keyMap.get('doi:10.1234/test.2019.002')).toBe('jones2019urban');
    expect(keyMap.get('doi:10.1234/test.2021.003')).toBe('davis2021advances');
  });

  test('supports authorYear format', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations, 'authorYear');
    expect(keyMap.get('doi:10.1234/test.2020.001')).toBe('smith2020');
    expect(keyMap.get('doi:10.1234/test.2019.002')).toBe('jones2019');
    expect(keyMap.get('doi:10.1234/test.2021.003')).toBe('davis2021');
  });

  test('supports numeric format', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations, 'numeric');
    expect(keyMap.size).toBe(3);
  });
});

describe('generateCitationKey', () => {
  test('authorYearTitle format', () => {
    expect(generateCitationKey('Smith', '2020', 'The effects of climate'))
      .toBe('smith2020effects');
  });

  test('skips articles in title', () => {
    expect(generateCitationKey('Jones', '2019', 'A study of urban planning'))
      .toBe('jones2019study');
  });

  test('authorYear format', () => {
    expect(generateCitationKey('Smith', '2020', 'anything', 'authorYear'))
      .toBe('smith2020');
  });

  test('cleans special characters from surname', () => {
    expect(generateCitationKey('O\'Brien-Smith', '2020', 'Test title'))
      .toBe('obriensmith2020test');
  });

  // Feature: docx-converter, Property 1: citation key alphanumeric invariant
  test('property: output contains only lowercase alphanumeric chars', () => {
    fc.assert(
      fc.property(
        fc.string(), fc.string(), fc.string(),
        (surname, year, title) => {
          const key = generateCitationKey(surname, year, title);
          expect(key).toMatch(/^[a-z0-9]*$/);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: docx-converter, Property 2: citation key determinism
  test('property: deterministic — same inputs produce same output', () => {
    fc.assert(
      fc.property(
        fc.string(), fc.string(), fc.string(),
        (surname, year, title) => {
          const a = generateCitationKey(surname, year, title);
          const b = generateCitationKey(surname, year, title);
          expect(a).toBe(b);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: docx-converter, Property 3: citation key starts with letter given letter surname
  test('property: non-empty surname with letters produces key starting with lowercase letter', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter(s => /^[a-zA-Z]/.test(s)),
        fc.string(), fc.string(),
        (surname, year, title) => {
          const key = generateCitationKey(surname, year, title);
          expect(key).toMatch(/^[a-z]/);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('extractDocumentContent', () => {
  test('extracts text, citations, and paragraphs', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations);
    const content = await extractDocumentContent(sampleData, citations, keyMap);

    const types = content.map(c => c.type);
    expect(types).toContain('text');
    expect(types).toContain('citation');
    expect(types).toContain('para');
  });

  test('tracks comment ranges on text items', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations);
    const content = await extractDocumentContent(sampleData, citations, keyMap);

    const commented = content.filter(c => c.type === 'text' && c.commentIds.size > 0);
    expect(commented.length).toBeGreaterThan(0);
  });

  test('citation items have pandoc keys', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations);
    const content = await extractDocumentContent(sampleData, citations, keyMap);

    const citItems = content.filter(c => c.type === 'citation');
    expect(citItems.length).toBe(3);
    if (citItems[0].type === 'citation') {
      expect(citItems[0].pandocKeys).toContain('smith2020effects');
    }
  });
});

describe('convertDocx (end-to-end)', () => {
  test('produces expected markdown', async () => {
    const result = await convertDocx(sampleData);
    expect(result.markdown.trimEnd()).toBe(expectedMd);
  });

  test('produces expected bibtex', async () => {
    const result = await convertDocx(sampleData);
    expect(result.bibtex.trimEnd()).toBe(expectedBib);
  });

  test('handles empty docx gracefully', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>');
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('Hello');
    expect(result.bibtex).toBe('');
  });
});
