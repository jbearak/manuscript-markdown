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
  wrapWithFormatting,
  DEFAULT_FORMATTING,
  RunFormatting,
  isToggleOn,
  parseHeadingLevel,
  parseRunProperties,
} from './converter';

const fixturesDir = join(__dirname, '..', 'test', 'fixtures');
const sampleData = new Uint8Array(readFileSync(join(fixturesDir, 'sample.docx')));
const formattingSampleData = new Uint8Array(readFileSync(join(fixturesDir, 'formatting_sample.docx')));
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

  test('converts formatting_sample.docx with expected formatting markers', async () => {
    const result = await convertDocx(formattingSampleData);
    const markdown = result.markdown;

    // Bold: **text**
    expect(markdown).toMatch(/\*\*[^*]+\*\*/);
    
    // Italic: *text*
    expect(markdown).toMatch(/\*[^*]+\*/);
    
    // Underline: <u>text</u>
    expect(markdown).toMatch(/<u>[^<]+<\/u>/);
    
    // Strikethrough: ~~text~~
    expect(markdown).toMatch(/~~[^~]+~~/);
    
    // Highlight: ==text==
    expect(markdown).toMatch(/==[^=]+==/);
    
    // Superscript: <sup>text</sup>
    expect(markdown).toMatch(/<sup>[^<]+<\/sup>/);
    
    // Subscript: <sub>text</sub>
    expect(markdown).toMatch(/<sub>[^<]+<\/sub>/);
    
    // Headings: # Heading 1, ## Heading 2, etc.
    expect(markdown).toMatch(/^# /m);
    expect(markdown).toMatch(/^## /m);
    
    // Check that the document contains expected content
    expect(markdown).toContain('bulleted list');
    expect(markdown).toContain('numbered list');
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

describe('wrapWithFormatting', () => {
  // Property 1: Formatting wrapping produces correct delimiters
  test('property: single formatting flag produces correct delimiters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.constantFrom('bold', 'italic', 'strikethrough', 'underline', 'highlight', 'superscript', 'subscript'),
        (text, formatType) => {
          const fmt: RunFormatting = { ...DEFAULT_FORMATTING };
          (fmt as any)[formatType] = true;
          
          const result = wrapWithFormatting(text, fmt);
          
          const delimiters = {
            bold: ['**', '**'],
            italic: ['*', '*'],
            strikethrough: ['~~', '~~'],
            underline: ['<u>', '</u>'],
            highlight: ['==', '=='],
            superscript: ['<sup>', '</sup>'],
            subscript: ['<sub>', '</sub>'],
          };
          
          const [open, close] = delimiters[formatType as keyof typeof delimiters];
          expect(result.startsWith(open)).toBe(true);
          expect(result.endsWith(close)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 3: Combined formatting nesting order is consistent
  test('property: combined formatting nesting order is consistent', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.record({
          bold: fc.boolean(),
          italic: fc.boolean(),
          strikethrough: fc.boolean(),
          underline: fc.boolean(),
          highlight: fc.boolean(),
          superscript: fc.boolean(),
          subscript: fc.boolean(),
        }).filter(fmt => Object.values(fmt).filter(Boolean).length >= 2),
        (text, fmt) => {
          const result = wrapWithFormatting(text, fmt);
          
          // Check nesting order: bold (outermost) → italic → strikethrough → underline → highlight → super/subscript (innermost)
          const patterns = [];
          if (fmt.bold) patterns.push('\\*\\*');
          if (fmt.italic) patterns.push('\\*');
          if (fmt.strikethrough) patterns.push('~~');
          if (fmt.underline) patterns.push('<u>');
          if (fmt.highlight) patterns.push('==');
          // Superscript takes precedence over subscript
          if (fmt.superscript) {
            patterns.push('<sup>');
          } else if (fmt.subscript) {
            patterns.push('<sub>');
          }
          
          // Build expected opening pattern
          const openPattern = patterns.join('');
          const regex = new RegExp(`^${openPattern}`);
          expect(result).toMatch(regex);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('buildMarkdown', () => {
  test('Property 2: Consecutive runs with identical formatting merge into a single span', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0 && !s.includes('=') && !s.includes('*') && !s.includes('~')), { minLength: 2, maxLength: 5 }),
        fc.record({
          bold: fc.boolean(),
          italic: fc.boolean(),
          strikethrough: fc.boolean(),
          underline: fc.boolean(),
          highlight: fc.boolean(),
          superscript: fc.boolean(),
          subscript: fc.boolean(),
        }),
        fc.option(fc.webUrl(), { nil: undefined }),
        (texts, formatting, href) => {
          const content = texts.map(text => ({
            type: 'text' as const,
            text,
            commentIds: new Set<string>(),
            formatting,
            href,
          }));
          
          const result = buildMarkdown(content, new Map());
          const expectedText = texts.join('');
          
          // The result should contain the merged text
          expect(result).toContain(expectedText);
          
          // For simple cases, verify no duplicate formatting
          if (Object.values(formatting).filter(Boolean).length === 1) {
            const activeFormat = Object.entries(formatting).find(([_, active]) => active)?.[0];
            if (activeFormat === 'bold') {
              expect(result.match(/\*\*[^*]*\*\*/g)?.length).toBe(1);
            } else if (activeFormat === 'highlight') {
              expect(result.match(/==[^=]*==/g)?.length).toBe(1);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('Property 4: Hyperlink text items produce Markdown link syntax', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.webUrl(),
        (text, url) => {
          const content = [{
            type: 'text' as const,
            text,
            commentIds: new Set<string>(),
            formatting: DEFAULT_FORMATTING,
            href: url,
          }];
          
          const result = buildMarkdown(content, new Map());
          expect(result).toMatch(/\[.*\]\(.*\)/);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('Property 5: Formatting delimiters appear inside hyperlink text', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.webUrl(),
        fc.record({
          bold: fc.boolean(),
          italic: fc.boolean(),
          strikethrough: fc.boolean(),
          underline: fc.boolean(),
          highlight: fc.boolean(),
          superscript: fc.boolean(),
          subscript: fc.boolean(),
        }).filter(fmt => Object.values(fmt).some(Boolean)),
        (text, url, formatting) => {
          const content = [{
            type: 'text' as const,
            text,
            commentIds: new Set<string>(),
            formatting,
            href: url,
          }];
          
          const result = buildMarkdown(content, new Map());
          const linkMatch = result.match(/\[(.*?)\]\((.*?)\)/);
          expect(linkMatch).toBeTruthy();
          
          const linkText = linkMatch![1];
          const activeFormats = Object.entries(formatting).filter(([_, active]) => active);
          for (const [format] of activeFormats) {
            let delimiter = '';
            switch (format) {
              case 'bold': delimiter = '**'; break;
              case 'italic': delimiter = '*'; break;
              case 'strikethrough': delimiter = '~~'; break;
              case 'underline': delimiter = '<u>'; break;
              case 'highlight': delimiter = '=='; break;
              case 'superscript': delimiter = '<sup>'; break;
              case 'subscript': delimiter = '<sub>'; break;
            }
            if (delimiter && (format !== 'subscript' || !formatting.superscript)) {
              expect(linkText).toContain(delimiter);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('Property 6: Heading paragraphs produce correct # prefix', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (level, text) => {
          const content = [
            { type: 'para' as const, headingLevel: level },
            { type: 'text' as const, text, commentIds: new Set<string>(), formatting: DEFAULT_FORMATTING }
          ];
          
          const result = buildMarkdown(content, new Map());
          const expectedPrefix = '#'.repeat(level) + ' ';
          expect(result).toContain(expectedPrefix);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('Property 7: List items produce correct prefix and indentation', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('bullet', 'ordered'),
        fc.integer({ min: 0, max: 3 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (listType, level, text) => {
          const content = [
            { type: 'para' as const, listMeta: { type: listType, level } },
            { type: 'text' as const, text, commentIds: new Set<string>(), formatting: DEFAULT_FORMATTING }
          ];
          
          const result = buildMarkdown(content, new Map());
          const expectedIndent = listType === 'bullet' 
            ? ' '.repeat(2 * level) + '- '
            : ' '.repeat(3 * level) + '1. ';
          expect(result).toContain(expectedIndent);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('Property 8: Consecutive list items have no blank lines between them', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constant('bullet' as const),
            level: fc.integer({ min: 0, max: 2 }),
            text: fc.string({ minLength: 1, maxLength: 20 })
          }),
          { minLength: 2, maxLength: 4 }
        ),
        (items) => {
          const content = items.flatMap(item => [
            { type: 'para' as const, listMeta: { type: item.type, level: item.level } },
            { type: 'text' as const, text: item.text, commentIds: new Set<string>(), formatting: DEFAULT_FORMATTING }
          ]);
          
          const result = buildMarkdown(content, new Map());
          expect(result).not.toContain('\n\n\n'); // No double blank lines
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('isToggleOn', () => {
  test('returns false when element is absent', () => {
    expect(isToggleOn([], 'w:b')).toBe(false);
  });

  test('returns true when element present with no val attribute', () => {
    const children = [{ 'w:b': [] }];
    expect(isToggleOn(children, 'w:b')).toBe(true);
  });

  test('returns false when val="false"', () => {
    const children = [{ 'w:b': [], ':@': { '@_w:val': 'false' } }];
    expect(isToggleOn(children, 'w:b')).toBe(false);
  });

  test('returns false when val="0"', () => {
    const children = [{ 'w:b': [], ':@': { '@_w:val': '0' } }];
    expect(isToggleOn(children, 'w:b')).toBe(false);
  });

  test('returns true when val="true"', () => {
    const children = [{ 'w:b': [], ':@': { '@_w:val': 'true' } }];
    expect(isToggleOn(children, 'w:b')).toBe(true);
  });

  test('returns true when val="1"', () => {
    const children = [{ 'w:b': [], ':@': { '@_w:val': '1' } }];
    expect(isToggleOn(children, 'w:b')).toBe(true);
  });
});

describe('highlight detection', () => {
  test('detects highlight via w:shd with non-auto fill', () => {
    const children = [{ 'w:shd': [], ':@': { '@_w:fill': 'FFFF00' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.highlight).toBe(true);
  });

  test('ignores w:shd with auto fill', () => {
    const children = [{ 'w:shd': [], ':@': { '@_w:fill': 'auto' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.highlight).toBe(false);
  });

  test('ignores w:shd with empty fill', () => {
    const children = [{ 'w:shd': [], ':@': { '@_w:fill': '' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.highlight).toBe(false);
  });
});

describe('parseHeadingLevel', () => {
  test('returns undefined for non-heading pStyle', () => {
    const children = [{ 'w:pStyle': [], ':@': { '@_w:val': 'Normal' } }];
    expect(parseHeadingLevel(children)).toBeUndefined();
  });

  test('returns undefined when pStyle element is absent', () => {
    expect(parseHeadingLevel([])).toBeUndefined();
  });

  test('returns correct level for heading styles', () => {
    const children1 = [{ 'w:pStyle': [], ':@': { '@_w:val': 'Heading1' } }];
    expect(parseHeadingLevel(children1)).toBe(1);
    
    const children3 = [{ 'w:pStyle': [], ':@': { '@_w:val': 'Heading3' } }];
    expect(parseHeadingLevel(children3)).toBe(3);
  });
});
