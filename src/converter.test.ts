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
  ContentItem,
  isToggleOn,
  parseHeadingLevel,
  parseBlockquoteLevel,
  parseCodeBlockStyle,
  parseRunProperties,
  formatLocalIsoMinute,
  getLocalTimezoneOffset,
  citationPandocKeys,
  ZoteroCitation,
} from './converter';
import { convertMdToDocx } from './md-to-docx';

const fixturesDir = join(__dirname, '..', 'test', 'fixtures');
const sampleData = new Uint8Array(readFileSync(join(fixturesDir, 'sample.docx')));
const formattingSampleData = new Uint8Array(readFileSync(join(fixturesDir, 'formatting_sample.docx')));
const tablesData = new Uint8Array(readFileSync(join(fixturesDir, 'tables.docx')));
const commentsData = new Uint8Array(readFileSync(join(fixturesDir, 'comments.docx')));
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

describe('DOCX table conversion', () => {
  test('renders DOCX table as HTML table with paragraph boundaries', async () => {
    const xml = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tblPr><w:tblLook w:firstRow=\"1\"/></w:tblPr>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>H1</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>H2</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '<w:tr>'
      + '<w:tc>'
      + '<w:p><w:r><w:t>first paragraph</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>second paragraph</w:t></w:r></w:p>'
      + '</w:tc>'
      + '<w:tc><w:p><w:r><w:t>value</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('<table>');
    expect(result.markdown).toContain('<th>');
    expect(result.markdown).toContain('<td>');
    expect(result.markdown).toContain('<p>first paragraph</p>');
    expect(result.markdown).toContain('<p>second paragraph</p>');
  });

  test('preserves comments, highlights, citations, and math inside table cells', async () => {
    const cslPayload = JSON.stringify({
      citationItems: [{
        id: 1,
        locator: '20',
        itemData: {
          type: 'article-journal',
          title: 'Cell citation title',
          DOI: '10.1111/cell.1',
          author: [{ family: 'Smith', given: 'A' }],
          issued: { 'date-parts': [[2020]] }
        }
      }],
      properties: { plainCitation: '(Smith 2020)' }
    });

    const xml = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tblPr><w:tblLook w:firstRow=\"1\"/></w:tblPr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p>'
      + '<w:commentRangeStart w:id="1"/>'
      + '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>annotated</w:t></w:r>'
      + '<w:commentRangeEnd w:id="1"/>'
      + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
      + '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + cslPayload + '</w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:r><w:t>(Smith 2020)</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
      + '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>'
      + '</w:p></w:tc></w:tr>'
      + '</w:tbl>'
    );

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file('word/document.xml', xml);
    zip.file('word/comments.xml',
      '<?xml version="1.0"?>'
      + '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:comment w:id="1" w:author="Reviewer" w:date="2025-01-01T00:00:00Z"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:comment>'
      + '</w:comments>');
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('{==annotated==}{>>Reviewer');
    expect(result.markdown).toContain('@smith2020cell, p. 20');
    expect(result.markdown).toContain('$x$');
    expect(result.markdown).toContain('<table>');
  });

  test('uses OOXML header flags and defaults to td when no header signal exists', async () => {
    const withHeader = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tblPr><w:tblLook w:firstRow=\"1\"/></w:tblPr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>H</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc></w:tr>'
      + '</w:tbl>'
    );
    const withoutHeader = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tr><w:tc><w:p><w:r><w:t>H</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc></w:tr>'
      + '</w:tbl>'
    );

    const withHeaderMd = (await convertDocx(await buildSyntheticDocx(withHeader))).markdown;
    const withoutHeaderMd = (await convertDocx(await buildSyntheticDocx(withoutHeader))).markdown;

    expect(withHeaderMd).toContain('<th>');
    expect(withoutHeaderMd).not.toContain('<th>');
    expect(withoutHeaderMd).toContain('<td>');
  });

  test('indents table tags with default 2-space indent', async () => {
    const xml = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tblPr><w:tblLook w:firstRow="1"/></w:tblPr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>H</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc></w:tr>'
      + '</w:tbl>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);

    const tableHtml = result.markdown.match(/<table>[\s\S]*?<\/table>/)?.[0] ?? '';
    expect(tableHtml).toContain('\n  <tr>');
    expect(tableHtml).toContain('\n    <th>');
    expect(tableHtml).toContain('\n      <p>H</p>');
    expect(tableHtml).toContain('\n    </th>');
    expect(tableHtml).toContain('\n  </tr>');
    expect(tableHtml).toContain('\n    <td>');
    expect(tableHtml).toContain('\n      <p>D</p>');
    expect(tableHtml).toContain('\n    </td>');
  });

  test('respects custom tableIndent option', async () => {
    const xml = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr>'
      + '</w:tbl>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf, 'authorYearTitle', { tableIndent: '\t' });

    const tableHtml = result.markdown.match(/<table>[\s\S]*?<\/table>/)?.[0] ?? '';
    expect(tableHtml).toContain('\n\t<tr>');
    expect(tableHtml).toContain('\n\t\t<td>');
    expect(tableHtml).toContain('\n\t\t\t<p>A</p>');
    expect(tableHtml).toContain('\n\t\t</td>');
    expect(tableHtml).toContain('\n\t</tr>');
  });

  test('no indentation when tableIndent is empty string', async () => {
    const xml = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr>'
      + '</w:tbl>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf, 'authorYearTitle', { tableIndent: '' });

    const tableHtml = result.markdown.match(/<table>[\s\S]*?<\/table>/)?.[0] ?? '';
    expect(tableHtml).toContain('\n<tr>');
    expect(tableHtml).toContain('\n<td>');
    expect(tableHtml).toContain('\n<p>A</p>');
  });

  test('reads gridSpan as colspan', async () => {
    const xml = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Span</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('<td colspan="2">');
    expect(result.markdown).toContain('Span');
  });

  test('reads vMerge chain as rowspan', async () => {
    const xml = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Tall</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>R1</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '<w:tr>'
      + '<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>'
      + '<w:tc><w:p><w:r><w:t>R2</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '<w:tr>'
      + '<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>'
      + '<w:tc><w:p><w:r><w:t>R3</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('<td rowspan="3">');
    expect(result.markdown).toContain('Tall');
    expect(result.markdown).toContain('R1');
    expect(result.markdown).toContain('R2');
    expect(result.markdown).toContain('R3');
    // Continuation cells should not appear in output
    const tdCount = (result.markdown.match(/<td/g) || []).length;
    // 1 (rowspan=3) + 3 (R1, R2, R3) = 4 td tags
    expect(tdCount).toBe(4);
  });

  test('reads combined gridSpan and vMerge', async () => {
    const xml = wrapDocumentXml(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Big</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '<w:tr>'
      + '<w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc>'
      + '<w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('<td colspan="2" rowspan="2">');
    expect(result.markdown).toContain('Big');
    expect(result.markdown).toContain('C');
    expect(result.markdown).toContain('D');
  });

  test('keeps table-cell inline rendering semantically equivalent to body inline rendering', () => {
    const comments = new Map([
      ['1', { author: 'Reviewer', text: 'note', date: '2025-01-01T00:00:00Z' }]
    ]);

    const inlineItems = [
      { type: 'text', text: 'start ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'text', text: 'commented', commentIds: new Set(['1']), formatting: { ...DEFAULT_FORMATTING, highlight: true } },
      { type: 'text', text: ' link', commentIds: new Set(), formatting: DEFAULT_FORMATTING, href: 'https://example.com/a(b)' },
      { type: 'citation', text: '(Smith 2020)', commentIds: new Set(), pandocKeys: ['smith2020, p. 20'] },
      { type: 'math', latex: 'x', display: false },
      { type: 'text', text: ' end', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
    ] as any;

    const bodyMarkdown = buildMarkdown(
      [
        { type: 'para' },
        ...inlineItems,
      ] as any,
      comments,
    );

    const tableMarkdown = buildMarkdown(
      [
        {
          type: 'table',
          rows: [
            {
              isHeader: false,
              cells: [{ paragraphs: [inlineItems as any[]] }],
            },
          ],
        },
      ] as any,
      comments,
    );

    const paraMatch = tableMarkdown.match(/<p>([\s\S]*?)<\/p>/);
    expect(paraMatch).not.toBeNull();
    expect(paraMatch?.[1]).toBe(bodyMarkdown);
  });

  test('emits deferred ID comment bodies outside table cell paragraph tags', () => {
    const comments = new Map([
      ['1', { author: 'Reviewer', text: 'note', date: '' }],
    ]);
    const inlineItems = [
      { type: 'text', text: 'commented', commentIds: new Set(['1']), formatting: DEFAULT_FORMATTING },
    ] as any;

    const tableMarkdown = buildMarkdown(
      [
        {
          type: 'table',
          rows: [
            {
              isHeader: false,
              cells: [{ paragraphs: [inlineItems as any[]] }],
            },
          ],
        },
      ] as any,
      comments,
      { alwaysUseCommentIds: true },
    );

    const paraMatch = tableMarkdown.match(/<p>([\s\S]*?)<\/p>/);
    expect(paraMatch).not.toBeNull();
    expect(paraMatch?.[1]).toBe('{#1}commented{/1}');
    expect(paraMatch?.[1]).not.toContain('{#1>>');
    expect(tableMarkdown).toContain('{#1>>Reviewer: note<<}');
    expect(tableMarkdown).toContain('</p>\n      {#1>>Reviewer: note<<}');
  });
});

describe('colspan/rowspan roundtrip', () => {
  test('MD (HTML table with colspan) → DOCX → MD preserves colspan', async () => {
    const md = '<table><tr><td colspan="2">Span</td></tr><tr><td>A</td><td>B</td></tr></table>';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);

    expect(result.markdown).toContain('<td colspan="2">');
    expect(result.markdown).toContain('Span');
    expect(result.markdown).toContain('A');
    expect(result.markdown).toContain('B');
  });

  test('MD (HTML table with rowspan) → DOCX → MD preserves rowspan', async () => {
    const md = '<table><tr><td rowspan="2">Tall</td><td>R1</td></tr><tr><td>R2</td></tr></table>';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);

    expect(result.markdown).toContain('<td rowspan="2">');
    expect(result.markdown).toContain('Tall');
    expect(result.markdown).toContain('R1');
    expect(result.markdown).toContain('R2');
  });

  test('MD (HTML table with colspan+rowspan) → DOCX → MD preserves both', async () => {
    const md = '<table><tr><td colspan="2" rowspan="2">Big</td><td>C</td></tr><tr><td>D</td></tr><tr><td>E</td><td>F</td><td>G</td></tr></table>';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);

    expect(result.markdown).toContain('colspan="2"');
    expect(result.markdown).toContain('rowspan="2"');
    expect(result.markdown).toContain('Big');
  });

  test('indented HTML table roundtrips through DOCX correctly', async () => {
    const indentedMd = [
      '<table>',
      '  <tr>',
      '    <th>',
      '      <p>Header</p>',
      '    </th>',
      '  </tr>',
      '  <tr>',
      '    <td>',
      '      <p>Data</p>',
      '    </td>',
      '  </tr>',
      '</table>',
    ].join('\n');
    const { docx } = await convertMdToDocx(indentedMd);
    const result = await convertDocx(docx);

    expect(result.markdown).toContain('<th>');
    expect(result.markdown).toContain('Header');
    expect(result.markdown).toContain('<td>');
    expect(result.markdown).toContain('Data');
  });
});

describe('Integration: tables.docx fixture', () => {
  test('converts tables.docx and produces three tables', async () => {
    const result = await convertDocx(tablesData);
    const tables = result.markdown.match(/<table>/g) || [];
    expect(tables.length).toBe(3);
  });

  test('simple table has header row and content cells', async () => {
    const result = await convertDocx(tablesData);
    // First table: simple 2x5, first row is header
    expect(result.markdown).toContain('<th>');
    expect(result.markdown).toContain('Row 1 Col 1');
    expect(result.markdown).toContain('Row 2 Col 1');
    expect(result.markdown).toContain('Row 2 Col 5');
  });

  test('spanned-header table has colspan=2 cells', async () => {
    const result = await convertDocx(tablesData);
    expect(result.markdown).toContain('Row 1 Cols 2-3');
    expect(result.markdown).toContain('Row 1 Cols 4-5');
    // These cells should have colspan="2"
    expect(result.markdown).toContain('colspan="2"');
  });

  test('complex table has both colspan and rowspan', async () => {
    const result = await convertDocx(tablesData);
    // Table 3: Row 1 Cols 2-4 (colspan=3)
    expect(result.markdown).toContain('Row 1 Cols 2-4');
    expect(result.markdown).toContain('colspan="3"');
    // Rows 3-4 Col 3 and Rows 3-4 Col 5 each have rowspan=2
    expect(result.markdown).toContain('Rows 3-4 Col 3');
    expect(result.markdown).toContain('Rows 3-4 Col 5');
    expect(result.markdown).toContain('rowspan="2"');
  });

  test('complex table roundtrips: DOCX → MD → DOCX → MD preserves spans', async () => {
    const firstPass = await convertDocx(tablesData);
    const { docx } = await convertMdToDocx(firstPass.markdown);
    const secondPass = await convertDocx(docx);

    // colspan attributes preserved
    expect(secondPass.markdown).toContain('colspan="3"');
    expect(secondPass.markdown).toContain('colspan="2"');
    // rowspan attributes preserved
    expect(secondPass.markdown).toContain('rowspan="2"');
    // Content preserved
    expect(secondPass.markdown).toContain('Row 1 Cols 2-4');
    expect(secondPass.markdown).toContain('Rows 3-4 Col 3');
    expect(secondPass.markdown).toContain('Rows 3-4 Col 5');
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

  test('prefers stored citation-key over algorithmic generation', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Smith 2020)',
      items: [{
        authors: [{ family: 'Smith', given: 'Alice' }],
        title: 'Effects of climate on agriculture',
        year: '2020',
        journal: 'Journal of Testing',
        volume: '10',
        pages: '1-15',
        doi: '10.1234/test.2020.001',
        type: 'article-journal',
        fullItemData: {},
        citationKey: 'smith2020',   // stored key (shorter than algorithmic "smith2020effects")
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    expect(keyMap.get('doi:10.1234/test.2020.001')).toBe('smith2020');
  });

  test('falls back to algorithmic key when stored key collides', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Smith 2020; Jones 2019)',
      items: [
        {
          authors: [{ family: 'Smith', given: 'Alice' }],
          title: 'First paper',
          year: '2020',
          journal: '',
          volume: '',
          pages: '',
          doi: '10.1234/a',
          type: 'article-journal',
          fullItemData: {},
          citationKey: 'mykey',
        },
        {
          authors: [{ family: 'Jones', given: 'Bob' }],
          title: 'Second paper',
          year: '2019',
          journal: '',
          volume: '',
          pages: '',
          doi: '10.1234/b',
          type: 'article-journal',
          fullItemData: {},
          citationKey: 'mykey',   // collides with first item
        },
      ],
    }];
    const keyMap = buildCitationKeyMap(citations);
    expect(keyMap.get('doi:10.1234/a')).toBe('mykey');
    // Second item falls through to algorithmic generation
    expect(keyMap.get('doi:10.1234/b')).toBe('jones2019second');
  });

  test('numeric format ignores stored citation-key', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(1)',
      items: [{
        authors: [{ family: 'Smith', given: 'Alice' }],
        title: 'Test',
        year: '2020',
        journal: '',
        volume: '',
        pages: '',
        doi: '10.1234/test',
        type: 'article-journal',
        fullItemData: {},
        citationKey: 'smith2020',
      }],
    }];
    const keyMap = buildCitationKeyMap(citations, 'numeric');
    expect(keyMap.get('doi:10.1234/test')).toBe('1');
  });
});

describe('citekey round-trip preservation', () => {
  const BIBTEX = `
@article{smith2020,
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

@article{customKey99,
  author = {Jones, Bob},
  title = {{Urban planning and public health}},
  journal = {Review of Studies},
  volume = {5},
  pages = {100-120},
  year = {2019},
  doi = {10.1234/test.2019.002},
  zotero-key = {BBBB2222},
  zotero-uri = {http://zotero.org/users/0/items/BBBB2222},
}
`.trim();

  test('MD→DOCX→MD preserves original citekeys', async () => {
    const md = 'Some text [@smith2020]. More text [@customKey99].\n';
    const docxResult = await convertMdToDocx(md, { bibtex: BIBTEX });
    const mdResult = await convertDocx(docxResult.docx);

    // The original citekeys should be preserved, not regenerated
    expect(mdResult.markdown).toContain('@smith2020');
    expect(mdResult.markdown).toContain('@customKey99');
    // Should NOT contain algorithmically generated keys
    expect(mdResult.markdown).not.toContain('smith2020effects');
    expect(mdResult.markdown).not.toContain('jones2019urban');
  });

  test('citation-key is stored in DOCX field code itemData', async () => {
    const md = 'Text [@smith2020].\n';
    const docxResult = await convertMdToDocx(md, { bibtex: BIBTEX });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docxResult.docx);
    const docXml = await zip.file('word/document.xml')!.async('string');

    // The field code JSON should contain citation-key
    expect(docXml).toContain('citation-key');
    expect(docXml).toContain('smith2020');
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
    const { content } = await extractDocumentContent(sampleData, citations, keyMap);

    const types = content.map(c => c.type);
    expect(types).toContain('text');
    expect(types).toContain('citation');
    expect(types).toContain('para');
  });

  test('tracks comment ranges on text items', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations);
    const { content } = await extractDocumentContent(sampleData, citations, keyMap);

    const commented = content.filter(c => c.type === 'text' && c.commentIds.size > 0);
    expect(commented.length).toBeGreaterThan(0);
  });

  test('citation items have pandoc keys', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations);
    const { content } = await extractDocumentContent(sampleData, citations, keyMap);

    const citItems = content.filter(c => c.type === 'citation');
    expect(citItems.length).toBe(3);
    if (citItems[0].type === 'citation') {
      expect(citItems[0].pandocKeys).toContain('smith2020effects, p. 15');
    }
  });

  test('inherits paragraph-level run formatting defaults and allows run-level override', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file('word/document.xml', `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr>
        <w:rPr><w:b/></w:rPr>
      </w:pPr>
      <w:r><w:t>Bold </w:t></w:r>
      <w:r>
        <w:rPr><w:b w:val="false"/></w:rPr>
        <w:t>Plain</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`);
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const result = await convertDocx(buf);
    expect(result.markdown).toBe('**Bold **Plain');
  });
});

describe('convertDocx (end-to-end)', () => {
  test('produces expected markdown', async () => {
    const result = await convertDocx(sampleData);
    const expectedMdLocal = expectedMd
      .replace('{{TZ}}', getLocalTimezoneOffset())
      .replace('{{TS1}}', formatLocalIsoMinute('2025-01-15T10:30:00Z'))
      .replace('{{TS2}}', formatLocalIsoMinute('2025-01-16T14:00:00Z'))
      .replace('{{TS3}}', formatLocalIsoMinute('2025-01-17T09:15:00Z'));
    expect(result.markdown.trimEnd()).toBe(expectedMdLocal);
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
    
    // Lists: bulleted (- ) and numbered (1. )
    expect(markdown).toMatch(/^- /m);
    expect(markdown).toMatch(/^1\. /m);
    
    // Check that the document contains expected content
    expect(markdown).toContain('bulleted list');
    expect(markdown).toContain('numbered list');
    const bulletedLine = markdown.split('\n').find(line => line === '- One');
    const numberedLine = markdown.split('\n').find(line => line === '1. One');
    expect(bulletedLine).toBe('- One');
    expect(numberedLine).toBe('1. One');
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
        fc.constantFrom('bold', 'italic', 'strikethrough', 'underline', 'highlight', 'superscript', 'subscript', 'code'),
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
            code: ['`', '`'],
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
          code: fc.boolean(),
        }).filter(fmt => Object.values(fmt).filter(Boolean).length >= 2),
        (text, fmt) => {
          const result = wrapWithFormatting(text, fmt);

          // Check nesting order: bold (outermost) → italic → strikethrough → underline → highlight → super/subscript → code (innermost)
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
          if (fmt.code) patterns.push('`');
          
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
          code: fc.boolean(),
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
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes(']') && !s.includes(')')),
        fc.webUrl(),
        fc.record({
          bold: fc.boolean(),
          italic: fc.boolean(),
          strikethrough: fc.boolean(),
          underline: fc.boolean(),
          highlight: fc.boolean(),
          superscript: fc.boolean(),
          subscript: fc.boolean(),
          code: fc.boolean(),
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

  test('text without href outputs as plain text (unresolvable hyperlink fallback)', () => {
    const content = [{
      type: 'text' as const,
      text: 'link text',
      commentIds: new Set<string>(),
      formatting: DEFAULT_FORMATTING,
      // href is undefined - simulates unresolvable r:id
    }];
    
    const result = buildMarkdown(content, new Map());
    expect(result).toBe('link text');
    expect(result).not.toContain('[');
    expect(result).not.toContain(']');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
  });

  test('href with parentheses is emitted using safe markdown link destination', () => {
    const content = [{
      type: 'text' as const,
      text: 'link',
      commentIds: new Set<string>(),
      formatting: DEFAULT_FORMATTING,
      href: 'https://example.com/a_(b)'
    }];

    const result = buildMarkdown(content, new Map());
    expect(result).toBe('[link](<https://example.com/a_(b)>)');
  });

  test('commented text across differently formatted runs emits one annotation block', () => {
    const comments = new Map([
      ['c1', { author: 'Reviewer', text: 'note', date: '2025-01-01T00:00:00Z' }]
    ]);
    const content = [
      {
        type: 'text' as const,
        text: 'normal ',
        commentIds: new Set(['c1']),
        formatting: DEFAULT_FORMATTING
      },
      {
        type: 'text' as const,
        text: 'bold',
        commentIds: new Set(['c1']),
        formatting: { ...DEFAULT_FORMATTING, bold: true }
      }
    ];

    const result = buildMarkdown(content, comments);
    expect(result).toBe(`{==normal **bold**==}{>>Reviewer (${formatLocalIsoMinute('2025-01-01T00:00:00Z')}): note<<}`);
  });

  test('highlighted commented text does not produce doubled == delimiters', () => {
    const comments = new Map([
      ['c1', { author: 'Reviewer', text: 'note', date: '2025-01-01T00:00:00Z' }]
    ]);
    const content = [
      {
        type: 'text' as const,
        text: 'highlighted',
        commentIds: new Set(['c1']),
        formatting: { ...DEFAULT_FORMATTING, highlight: true }
      }
    ];

    const result = buildMarkdown(content, comments);
    expect(result).toBe(`{==highlighted==}{>>Reviewer (${formatLocalIsoMinute('2025-01-01T00:00:00Z')}): note<<}`);
    expect(result).not.toContain('{====');
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
            type: fc.constantFrom('bullet' as const, 'ordered' as const),
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
          const hasTypeTransition = items.some((item, idx) => idx > 0 && item.type !== items[idx - 1].type);
          if (hasTypeTransition) {
            expect(result).toContain('\n\n');
          }
          expect(result).not.toContain('\n\n\n'); // No double blank lines
        }
      ),
      { numRuns: 100 }
    );
  });

  test('heading-first content does not start with leading blank lines', () => {
    const content = [
      { type: 'para' as const, headingLevel: 2 },
      { type: 'text' as const, text: 'Heading', commentIds: new Set<string>(), formatting: DEFAULT_FORMATTING }
    ];

    const result = buildMarkdown(content, new Map());
    expect(result).toBe('## Heading');
    expect(result.startsWith('\n')).toBe(false);
  });

  test('list-first content does not start with leading blank lines', () => {
    const content = [
      { type: 'para' as const, listMeta: { type: 'bullet' as const, level: 0 } },
      { type: 'text' as const, text: 'Item', commentIds: new Set<string>(), formatting: DEFAULT_FORMATTING }
    ];

    const result = buildMarkdown(content, new Map());
    expect(result).toBe('- Item');
    expect(result.startsWith('\n')).toBe(false);
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

describe('highlightColor extraction', () => {
  test('stores color name from w:highlight', () => {
    const children = [{ 'w:highlight': [], ':@': { '@_w:val': 'yellow' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.highlight).toBe(true);
    expect(formatting.highlightColor).toBe('yellow');
  });

  test('stores hex value from w:shd', () => {
    const children = [{ 'w:shd': [], ':@': { '@_w:fill': 'FFFF00' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.highlight).toBe(true);
    expect(formatting.highlightColor).toBe('FFFF00');
  });

  test('does not store color when highlight is none', () => {
    const children = [{ 'w:highlight': [], ':@': { '@_w:val': 'none' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.highlight).toBe(false);
    expect(formatting.highlightColor).toBeUndefined();
  });

  test('stores different highlight colors', () => {
    const children1 = [{ 'w:highlight': [], ':@': { '@_w:val': 'cyan' } }];
    const formatting1 = parseRunProperties(children1);
    expect(formatting1.highlightColor).toBe('cyan');

    const children2 = [{ 'w:highlight': [], ':@': { '@_w:val': 'magenta' } }];
    const formatting2 = parseRunProperties(children2);
    expect(formatting2.highlightColor).toBe('magenta');
  });

  test('w:highlight with cyan stores cyan', () => {
    const children = [{ 'w:highlight': [], ':@': { '@_w:val': 'cyan' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.highlight).toBe(true);
    expect(formatting.highlightColor).toBe('cyan');
  });

  test('w:shd with auto fill does not store highlightColor', () => {
    const children = [{ 'w:shd': [], ':@': { '@_w:fill': 'auto' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.highlight).toBe(false);
    expect(formatting.highlightColor).toBeUndefined();
  });

  test('formattingEquals distinguishes different highlight colors via buildMarkdown', () => {
    const content = [
      {
        type: 'text' as const,
        text: 'yellow',
        commentIds: new Set<string>(),
        formatting: { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'yellow' }
      },
      {
        type: 'text' as const,
        text: 'cyan',
        commentIds: new Set<string>(),
        formatting: { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'cyan' }
      }
    ];

    const result = buildMarkdown(content, new Map());
    // Should produce two separate highlight spans, not merged
    expect(result).toBe('==yellow====cyan==');
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


// ---------------------------------------------------------------------------
// Property tests for converter integration (Task 4.3)
// ---------------------------------------------------------------------------


/** Wrap body XML in the standard w:document envelope with both w: and m: namespaces */
function wrapDocumentXml(bodyContent: string): string {
  return '<?xml version="1.0"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
    + '<w:body>' + bodyContent + '</w:body>'
    + '</w:document>';
}

// Generator: short alphanumeric string for math variable names
const mathVar = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
);

// Generator: short text strings for paragraph content (no special chars that break XML)
const safeText = fc.array(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 '.split('')),
  { minLength: 1, maxLength: 10 },
).map(arr => arr.join('').trim()).filter(s => s.length > 0);

// ---------------------------------------------------------------------------
// Feature: docx-equation-conversion, Property 1: Delimiter selection matches element type
// **Validates: Requirements 1.1, 2.1**
// ---------------------------------------------------------------------------

describe('Feature: docx-equation-conversion, Property 1: Delimiter selection matches element type', () => {
  test('inline m:oMath produces $...$ delimiters in output', () => {
    fc.assert(
      fc.asyncProperty(mathVar, async (v) => {
        const xml = wrapDocumentXml(
          '<w:p><m:oMath><m:r><m:t>' + v + '</m:t></m:r></m:oMath></w:p>'
        );
        const buf = await buildSyntheticDocx(xml);
        const result = await convertDocx(buf);
        const md = result.markdown;
        // Must contain $v$ but NOT $$v$$
        expect(md).toContain('$' + v + '$');
        // Ensure it's not wrapped in display $$ delimiters
        // Check that the match is single-$ by verifying no $$ surrounds it
        const ddIndex = md.indexOf('$$');
        if (ddIndex !== -1) {
          // If $$ appears, it should not be wrapping our variable
          expect(md).not.toContain('$$' + '\n' + v + '\n' + '$$');
        }
      }),
      { numRuns: 30 },
    );
  });

  test('display m:oMathPara produces $$ delimiters in output', () => {
    fc.assert(
      fc.asyncProperty(mathVar, async (v) => {
        const xml = wrapDocumentXml(
          '<m:oMathPara><m:oMath><m:r><m:t>' + v + '</m:t></m:r></m:oMath></m:oMathPara>'
        );
        const buf = await buildSyntheticDocx(xml);
        const result = await convertDocx(buf);
        const md = result.markdown;
        // Must contain $$\nv\n$$
        expect(md).toContain('$$' + '\n' + v + '\n' + '$$');
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: docx-equation-conversion, Property 2: Display equations are separated by blank lines
// **Validates: Requirements 2.2**
// ---------------------------------------------------------------------------

describe('Feature: docx-equation-conversion, Property 2: Display equations are separated by blank lines', () => {
  test('display equation has blank lines separating it from surrounding text', () => {
    fc.assert(
      fc.asyncProperty(safeText, mathVar, safeText, async (before, v, after) => {
        const xml = wrapDocumentXml(
          '<w:p><w:r><w:t>' + before + '</w:t></w:r></w:p>'
          + '<m:oMathPara><m:oMath><m:r><m:t>' + v + '</m:t></m:r></m:oMath></m:oMathPara>'
          + '<w:p><w:r><w:t>' + after + '</w:t></w:r></w:p>'
        );
        const buf = await buildSyntheticDocx(xml);
        const result = await convertDocx(buf);
        const md = result.markdown;

        const displayBlock = '$$' + '\n' + v + '\n' + '$$';
        expect(md).toContain(displayBlock);

        // Find the display block position and verify blank lines around it
        const idx = md.indexOf(displayBlock);
        expect(idx).toBeGreaterThan(0);

        // Check blank line before: the two chars before the $$ should be \n\n
        const preceding = md.substring(0, idx);
        expect(preceding.endsWith('\n\n')).toBe(true);

        // Check blank line after: after the display block, next content should be preceded by \n\n
        const following = md.substring(idx + displayBlock.length);
        expect(following.startsWith('\n\n')).toBe(true);
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: docx-equation-conversion, Property 8: Mixed content preservation
// **Validates: Requirements 1.2, 3A.1**
// ---------------------------------------------------------------------------

describe('Feature: docx-equation-conversion, Property 8: Mixed content preservation', () => {
  test('paragraphs with text and inline math preserve both in document order', () => {
    fc.assert(
      fc.asyncProperty(safeText, mathVar, safeText, async (textBefore, v, textAfter) => {
        const xml = wrapDocumentXml(
          '<w:p>'
          + '<w:r><w:t>' + textBefore + '</w:t></w:r>'
          + '<m:oMath><m:r><m:t>' + v + '</m:t></m:r></m:oMath>'
          + '<w:r><w:t>' + textAfter + '</w:t></w:r>'
          + '</w:p>'
        );
        const buf = await buildSyntheticDocx(xml);
        const result = await convertDocx(buf);
        const md = result.markdown;

        // Output must contain the text before, the inline math, and the text after
        expect(md).toContain(textBefore);
        expect(md).toContain('$' + v + '$');
        expect(md).toContain(textAfter);

        // Verify document order: textBefore appears before $v$, which appears before textAfter
        const idxBefore = md.indexOf(textBefore);
        const idxMath = md.indexOf('$' + v + '$');
        const idxAfter = md.lastIndexOf(textAfter);
        expect(idxBefore).toBeLessThan(idxMath);
        expect(idxMath).toBeLessThan(idxAfter);
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: DOCX equation conversion (Task 4.4)
// ---------------------------------------------------------------------------

describe('Integration: DOCX equation conversion', () => {
  test('inline equation produces $...$ (Req 1.1, 1.3)', async () => {
    const xml = wrapDocumentXml(
      '<w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('$x$');
  });

  test('display equation produces ' + '$$' + '...' + '$$' + ' with blank lines (Req 2.1, 2.2)', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>Before</w:t></w:r></w:p>'
      + '<m:oMathPara><m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath></m:oMathPara>'
      + '<w:p><w:r><w:t>After</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    const md = result.markdown;

    const displayBlock = '$$' + '\n' + '\\mathrm{E=mc^2}' + '\n' + '$$';
    expect(md).toContain(displayBlock);

    // Verify blank line before display block
    const idx = md.indexOf(displayBlock);
    const preceding = md.substring(0, idx);
    expect(preceding.endsWith('\n\n')).toBe(true);

    // Verify blank line after display block
    const following = md.substring(idx + displayBlock.length);
    expect(following.startsWith('\n\n')).toBe(true);
  });

  test('mixed text + inline equation preserves both (Req 1.2)', async () => {
    const xml = wrapDocumentXml(
      '<w:p>'
      + '<w:r><w:t>The value </w:t></w:r>'
      + '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>'
      + '<w:r><w:t> is positive.</w:t></w:r>'
      + '</w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('The value $x$ is positive.');
  });

  test('empty m:oMath is skipped (Req 6.3)', async () => {
    const xml = wrapDocumentXml(
      '<w:p><m:oMath></m:oMath></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).not.toContain('$');
  });

  test('display math between same-type list items preserves a blank line before the next list item', () => {
    const content = [
      { type: 'para', listMeta: { type: 'bullet', level: 0 } },
      { type: 'text', text: 'item1', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'math', latex: 'x', display: true },
      { type: 'para', listMeta: { type: 'bullet', level: 0 } },
      { type: 'text', text: 'item2', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
    ] as any;
    const markdown = buildMarkdown(content, new Map());
    expect(markdown).toBe('- item1\n\n$$\nx\n$$\n\n- item2');
  });

  test('fraction in inline equation (Req 3.1)', async () => {
    const xml = wrapDocumentXml(
      '<w:p><m:oMath>'
      + '<m:f>'
      + '<m:num><m:r><m:t>a</m:t></m:r></m:num>'
      + '<m:den><m:r><m:t>b</m:t></m:r></m:den>'
      + '</m:f>'
      + '</m:oMath></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('$\\frac{a}{b}$');
  });
});
describe('Zotero citation roundtrip', () => {
  test('extracts zoteroKey and zoteroUri from local library URI', async () => {
    const citations = await extractZoteroCitations(sampleData);
    // citation1 has URI http://zotero.org/users/0/items/AAAA1111
    expect(citations[0].items[0].zoteroKey).toBe('AAAA1111');
    expect(citations[0].items[0].zoteroUri).toBe('http://zotero.org/users/0/items/AAAA1111');
  });

  test('extracts keys from all URI formats', async () => {
    // Build a synthetic docx with different URI formats
    const cslPayload = JSON.stringify({
      citationItems: [
        { id: 1, uris: ['http://zotero.org/users/local/abc/items/LLLL1111'], itemData: { type: 'book', title: 'Local', author: [{ family: 'A', given: 'B' }], issued: { 'date-parts': [[2020]] } } },
        { id: 2, uris: ['http://zotero.org/users/12345/items/SSSS2222'], itemData: { type: 'book', title: 'Synced', author: [{ family: 'C', given: 'D' }], issued: { 'date-parts': [[2021]] } } },
        { id: 3, uris: ['http://zotero.org/groups/99/items/GGGG3333'], itemData: { type: 'book', title: 'Group', author: [{ family: 'E', given: 'F' }], issued: { 'date-parts': [[2022]] } } },
      ],
      properties: { plainCitation: '(test)' },
    });
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
      + '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + cslPayload + '</w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:r><w:t>(test)</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    );
    const docx = await buildSyntheticDocx(xml);
    const citations = await extractZoteroCitations(docx);
    expect(citations[0].items[0].zoteroKey).toBe('LLLL1111');
    expect(citations[0].items[1].zoteroKey).toBe('SSSS2222');
    expect(citations[0].items[2].zoteroKey).toBe('GGGG3333');
  });

  test('handles missing uris gracefully', async () => {
    const cslPayload = JSON.stringify({
      citationItems: [{ id: 1, itemData: { type: 'book', title: 'No URI', author: [{ family: 'X', given: 'Y' }], issued: { 'date-parts': [[2020]] } } }],
      properties: { plainCitation: '(test)' },
    });
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
      + '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + cslPayload + '</w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:r><w:t>(test)</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    );
    const docx = await buildSyntheticDocx(xml);
    const citations = await extractZoteroCitations(docx);
    expect(citations[0].items[0].zoteroKey).toBeUndefined();
    expect(citations[0].items[0].zoteroUri).toBeUndefined();
  });

  test('handles malformed URI without item key', async () => {
    const cslPayload = JSON.stringify({
      citationItems: [{ id: 1, uris: ['http://zotero.org/bad/path'], itemData: { type: 'book', title: 'Bad URI', author: [{ family: 'X', given: 'Y' }], issued: { 'date-parts': [[2020]] } } }],
      properties: { plainCitation: '(test)' },
    });
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
      + '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + cslPayload + '</w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:r><w:t>(test)</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    );
    const docx = await buildSyntheticDocx(xml);
    const citations = await extractZoteroCitations(docx);
    expect(citations[0].items[0].zoteroKey).toBeUndefined();
    expect(citations[0].items[0].zoteroUri).toBe('http://zotero.org/bad/path');
  });

  test('generateBibTeX emits zotero-key and zotero-uri when present', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test Title', year: '2020', journal: 'J', volume: '1',
        pages: '1-2', doi: '10.1/test', type: 'article-journal',
        fullItemData: {}, zoteroKey: 'ABCD1234',
        zoteroUri: 'http://zotero.org/users/0/items/ABCD1234',
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('zotero-key = {ABCD1234}');
    expect(bib).toContain('zotero-uri = {http://zotero.org/users/0/items/ABCD1234}');
  });

  test('generateBibTeX omits zotero fields when absent', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test Title', year: '2020', journal: 'J', volume: '1',
        pages: '1-2', doi: '10.1/test', type: 'article-journal',
        fullItemData: {},
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).not.toContain('zotero-key');
    expect(bib).not.toContain('zotero-uri');
  });

  test('generateBibTeX preserves DOI verbatim (no LaTeX escaping)', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test Title', year: '2020', journal: 'J', volume: '1',
        pages: '1-2', doi: '10.1/some_thing_test', type: 'article-journal',
        fullItemData: {},
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('doi = {10.1/some_thing_test}');
  });

  test('citationPandocKeys includes locator suffix', () => {
    const citation: ZoteroCitation = {
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test Title', year: '2020', journal: 'J', volume: '1',
        pages: '1-2', doi: '10.1/test', type: 'article-journal',
        fullItemData: {}, locator: '42',
      }],
    };
    const keyMap = buildCitationKeyMap([citation]);
    const keys = citationPandocKeys(citation, keyMap);
    expect(keys[0]).toContain(', p. 42');
  });

  test('citationPandocKeys handles numeric locator', () => {
    const citation: ZoteroCitation = {
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test Title', year: '2020', journal: 'J', volume: '1',
        pages: '1-2', doi: '10.1/test', type: 'article-journal',
        fullItemData: {}, locator: 15 as any,
      }],
    };
    const keyMap = buildCitationKeyMap([citation]);
    const keys = citationPandocKeys(citation, keyMap);
    expect(keys[0]).toContain(', p. 15');
  });

  test('citationPandocKeys handles locator "0"', () => {
    const citation: ZoteroCitation = {
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test Title', year: '2020', journal: 'J', volume: '1',
        pages: '1-2', doi: '10.1/test', type: 'article-journal',
        fullItemData: {}, locator: '0',
      }],
    };
    const keyMap = buildCitationKeyMap([citation]);
    const keys = citationPandocKeys(citation, keyMap);
    expect(keys[0]).toContain(', p. 0');
  });

  test('citationPandocKeys omits locator when absent', () => {
    const citation: ZoteroCitation = {
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test Title', year: '2020', journal: 'J', volume: '1',
        pages: '1-2', doi: '10.1/test', type: 'article-journal',
        fullItemData: {},
      }],
    };
    const keyMap = buildCitationKeyMap([citation]);
    const keys = citationPandocKeys(citation, keyMap);
    expect(keys[0]).not.toContain(', p.');
  });

  test('grouped citation preserves per-item locators', () => {
    const citation: ZoteroCitation = {
      plainCitation: '(A; B)',
      items: [
        { authors: [{ family: 'A', given: 'X' }], title: 'T1', year: '2020', journal: 'J', volume: '1', pages: '1', doi: '10.1/a', type: 'article-journal', fullItemData: {}, locator: '20' },
        { authors: [{ family: 'B', given: 'Y' }], title: 'T2', year: '2021', journal: 'J', volume: '2', pages: '2', doi: '10.1/b', type: 'article-journal', fullItemData: {} },
      ],
    };
    const keyMap = buildCitationKeyMap([citation]);
    const keys = citationPandocKeys(citation, keyMap);
    expect(keys[0]).toContain(', p. 20');
    expect(keys[1]).not.toContain(', p.');
  });

  test('end-to-end: sample DOCX produces BibTeX with zotero-key and markdown with locators', async () => {
    const result = await convertDocx(sampleData);
    // BibTeX should contain zotero-key fields
    expect(result.bibtex).toContain('zotero-key = {AAAA1111}');
    expect(result.bibtex).toContain('zotero-key = {BBBB2222}');
    expect(result.bibtex).toContain('zotero-key = {CCCC3333}');
    // Markdown should contain locators
    expect(result.markdown).toContain('@smith2020effects, p. 15');
    expect(result.markdown).toContain('@jones2019urban, p. 110');
    // Davis has no locator
    expect(result.markdown).toContain('@davis2021advances]');
    expect(result.markdown).not.toContain('@davis2021advances, p.');
  });
});

describe('Integration: comments.docx fixture', () => {
  test('converts comments.docx without garbling text', async () => {
    const result = await convertDocx(commentsData);
    // The document contains: "This is the first sentence of a paragraph.
    // This is the second<br>sentence of a paragraph.."
    // with overlapping comments. Verify text is not garbled.
    expect(result.markdown).toContain('This is');
    expect(result.markdown).toContain('the first sentence of a');
    expect(result.markdown).toContain('paragraph.');
    expect(result.markdown).toContain('the second\nsentence o');
    expect(result.markdown).toContain('f a paragraph.');
    // Must NOT concatenate "second" and "sentence" without a break
    expect(result.markdown).not.toContain('secondsentence');
  });

  test('preserves overlapping comment structure with 1-indexed IDs', async () => {
    const result = await convertDocx(commentsData);
    // Three overlapping comments → must use ID-based syntax, 1-indexed
    expect(result.markdown).toContain('{#1}');
    expect(result.markdown).toContain('{#2}');
    expect(result.markdown).toContain('{#3}');
    expect(result.markdown).toContain('{/1}');
    expect(result.markdown).toContain('{/2}');
    expect(result.markdown).toContain('{/3}');
    // Should NOT contain 0-indexed IDs
    expect(result.markdown).not.toContain('{#0}');
    expect(result.markdown).not.toContain('{/0}');
  });

  test('preserves all three comment bodies', async () => {
    const result = await convertDocx(commentsData);
    expect(result.markdown).toContain('Merp');
    expect(result.markdown).toContain('This is comment 1.');
    expect(result.markdown).toContain('This is comment 2.');
  });

  test('preserves w:br as line break in markdown', async () => {
    const result = await convertDocx(commentsData);
    // The docx has <w:br/> between "second" and "sentence"
    expect(result.markdown).toContain('second\nsentence');
  });

  test('idempotent round-trip: docx→md→docx→md→docx→md', async () => {
    // Pass 1: original docx → md
    const pass1 = await convertDocx(commentsData);

    // Pass 2: md → docx → md
    const { docx: docx2 } = await convertMdToDocx(pass1.markdown);
    const pass2 = await convertDocx(docx2);

    // Pass 3: md → docx → md (should be identical to pass 2)
    const { docx: docx3 } = await convertMdToDocx(pass2.markdown);
    const pass3 = await convertDocx(docx3);

    expect(pass2.markdown).toBe(pass3.markdown);
  });
});

describe('w:br line break handling', () => {
  test('w:br without type attribute emits newline', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>before</w:t></w:r><w:r><w:br/><w:t>after</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('before\nafter');
  });

  test('w:br with type="textWrapping" emits newline', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>a</w:t></w:r><w:r><w:br w:type="textWrapping"/><w:t>b</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('a\nb');
  });

  test('w:br with type="page" does not emit newline', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>a</w:t></w:r><w:r><w:br w:type="page"/><w:t>b</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).not.toContain('a\nb');
  });

  test('w:br round-trips through md→docx→md', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>line one</w:t></w:r><w:r><w:br/><w:t>line two</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const pass1 = await convertDocx(buf);
    expect(pass1.markdown).toContain('line one\nline two');

    const { docx: docx2 } = await convertMdToDocx(pass1.markdown);
    const pass2 = await convertDocx(docx2);
    expect(pass2.markdown).toContain('line one\nline two');
  });
});

// Helpers for footnote tests
async function buildSyntheticDocx(documentXml: string, extraParts?: Record<string, string>): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  zip.file('word/document.xml', documentXml);
  if (extraParts) {
    for (const [path, content] of Object.entries(extraParts)) {
      zip.file(path, content);
    }
  }
  return zip.generateAsync({ type: 'uint8array' });
}

function wrapNotesXml(noteType: 'footnotes' | 'endnotes', content: string): string {
  const root = 'w:' + noteType;
  const el = noteType === 'footnotes' ? 'w:footnote' : 'w:endnote';
  return '<?xml version="1.0"?>'
    + '<' + root + ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<' + el + ' w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></' + el + '>'
    + '<' + el + ' w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></' + el + '>'
    + content
    + '</' + root + '>';
}

describe('DOCX footnote extraction', () => {
  test('extracts footnote references and definitions from DOCX', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Hello world</w:t></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1">'
      + '<w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>'
      + '<w:r><w:t> This is a footnote.</w:t></w:r></w:p>'
      + '</w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('Hello world[^1]');
    expect(result.markdown).toContain('[^1]: This is a footnote.');
  });

  test('extracts multiple footnotes in order', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>First</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r>'
      + '<w:r><w:t> second</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="2"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> Note one.</w:t></w:r></w:p></w:footnote>'
      + '<w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> Note two.</w:t></w:r></w:p></w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('First[^1] second[^2]');
    expect(result.markdown).toContain('[^1]: Note one.');
    expect(result.markdown).toContain('[^2]: Note two.');
  });

  test('extracts endnotes and sets notes: endnotes in frontmatter', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:endnoteReference w:id="1"/></w:r></w:p>'
    );
    const endnotesXml = wrapNotesXml('endnotes', 
      '<w:endnote w:id="1"><w:p><w:r><w:endnoteRef/></w:r><w:r><w:t> An endnote.</w:t></w:r></w:p></w:endnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/endnotes.xml': endnotesXml });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('notes: endnotes');
    expect(result.markdown).toContain('Text[^1]');
    expect(result.markdown).toContain('[^1]: An endnote.');
  });

  test('extracts formatted footnote content (bold/italic)', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>'
      + '<w:r><w:t> Some </w:t></w:r>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>'
      + '<w:r><w:t> and </w:t></w:r>'
      + '<w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r>'
      + '<w:r><w:t> text.</w:t></w:r>'
      + '</w:p></w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('[^1]: Some **bold** and *italic* text.');
  });

  test('extracts multi-paragraph footnotes', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1">'
      + '<w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> First paragraph.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>'
      + '</w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('[^1]: First paragraph.');
    expect(result.markdown).toContain('\n\n    Second paragraph.');
  });

  test('skips separator and continuationSeparator footnotes', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> Real note.</w:t></w:r></w:p></w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
    const result = await convertDocx(buf);

    // Should only have the real note, no separator content
    expect(result.markdown).toContain('[^1]: Real note.');
    // Separator content should not appear as footnote definitions
    const defMatches = result.markdown.match(/\[\^\d+\]:/g);
    expect(defMatches).toHaveLength(1);
  });

  test('documents without footnotes produce no footnote output', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>No footnotes here.</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(docXml);
    const result = await convertDocx(buf);

    expect(result.markdown).not.toContain('[^');
  });

  test('restores named labels via MANUSCRIPT_FOOTNOTE_IDS mapping', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> A note.</w:t></w:r></w:p></w:footnote>'
    );
    const customXml = '<?xml version="1.0"?>'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
      + '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MANUSCRIPT_FOOTNOTE_IDS_1">'
      + '<vt:lpwstr>{"1":"my-note"}</vt:lpwstr>'
      + '</property>'
      + '</Properties>';
    const buf = await buildSyntheticDocx(docXml, {
      'word/footnotes.xml': footnotesXml,
      'docProps/custom.xml': customXml,
    });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('Text[^my-note]');
    expect(result.markdown).toContain('[^my-note]: A note.');
  });

  test('footnote body with hyperlink produces markdown link', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>'
      + '<w:r><w:t> See </w:t></w:r>'
      + '<w:hyperlink r:id="rId1"><w:r><w:t>example</w:t></w:r></w:hyperlink>'
      + '<w:r><w:t>.</w:t></w:r>'
      + '</w:p></w:footnote>'
    );
    const relsXml = '<?xml version="1.0"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>'
      + '</Relationships>';
    const buf = await buildSyntheticDocx(docXml, {
      'word/footnotes.xml': footnotesXml,
      'word/_rels/footnotes.xml.rels': relsXml,
    });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('[^1]: See [example](https://example.com).');
  });

  test('footnote body with inline math produces $latex$', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>'
      + '<w:r><w:t> Where </w:t></w:r>'
      + '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>'
      + '<w:r><w:t> is defined.</w:t></w:r>'
      + '</w:p></w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('[^1]: Where $x$ is defined.');
  });

  test('footnote body with display math uses block footnote form', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id=\"1\"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes',
      '<w:footnote w:id=\"1\"><w:p><w:r><w:footnoteRef/></w:r></w:p>'
      + '<m:oMathPara><m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath></m:oMathPara>'
      + '</w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('[^1]:\n\n    $$\n    \\mathrm{E=mc^2}\n    $$');
  });

  test('footnote body with text then display math does not duplicate equation', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes',
      '<w:footnote w:id="1">'
      + '<w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> Here is an equation:</w:t></w:r></w:p>'
      + '<m:oMathPara><m:oMath><m:r><m:t>x^2</m:t></m:r></m:oMath></m:oMathPara>'
      + '</w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
    const result = await convertDocx(buf);

    // Should contain exactly one instance of the display math block
    const displayMathBlock = '$$\n    \\mathrm{x^2}\n    $$';
    const occurrences = (result.markdown.match(/\$\$[\s\S]*?x\^2[\s\S]*?\$\$/g) || []).length;
    expect(occurrences).toBe(1);
    expect(result.markdown).toContain('[^1]: Here is an equation:');
    expect(result.markdown).toContain(displayMathBlock);
  });

  test('footnote body with table produces HTML table', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>'
      + '<w:r><w:t> See table:</w:t></w:r></w:p>'
      + '<w:tbl>'
      + '<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr>'
      + '</w:tbl>'
      + '</w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('[^1]: See table:');
    // Table content should appear in the footnote definition area
    expect(result.markdown).toContain('A');
    expect(result.markdown).toContain('B');
  });

  test('footnote body with Zotero citation field produces [@key]', async () => {
    const cslPayload = JSON.stringify({
      citationItems: [{
        itemData: {
          type: 'article-journal',
          title: 'Test Article',
          author: [{ family: 'Smith', given: 'John' }],
          issued: { 'date-parts': [[2020]] },
          'container-title': 'Journal',
          volume: '1',
          page: '1-10',
          DOI: '10.1234/test',
        },
      }],
      properties: { plainCitation: '(Smith 2020)' },
    });
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>'
      + '<w:r><w:t> As noted in </w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
      + '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + cslPayload + '</w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:r><w:t>(Smith 2020)</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
      + '<w:r><w:t>.</w:t></w:r>'
      + '</w:p></w:footnote>'
    );
    const buf = await buildSyntheticDocx(docXml, {
      'word/footnotes.xml': footnotesXml,
    });
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('[^1]:');
    expect(result.markdown).toContain('@smith2020test');
  });

  test('mixed footnotes + endnotes does not set notes: endnotes in frontmatter', async () => {
    const docXml = wrapDocumentXml(
      '<w:p><w:r><w:t>Text</w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="1"/></w:r>'
      + '<w:r><w:endnoteReference w:id="1"/></w:r></w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes', 
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> A footnote.</w:t></w:r></w:p></w:footnote>'
    );
    const endnotesXml = wrapNotesXml('endnotes', 
      '<w:endnote w:id="1"><w:p><w:r><w:endnoteRef/></w:r><w:r><w:t> An endnote.</w:t></w:r></w:p></w:endnote>'
    );
    const buf = await buildSyntheticDocx(docXml, {
      'word/footnotes.xml': footnotesXml,
      'word/endnotes.xml': endnotesXml,
    });
    const result = await convertDocx(buf);

    expect(result.markdown).not.toContain('notes: endnotes');
    expect(result.markdown).toContain('[^1]: A footnote.');
    expect(result.markdown).toContain('[^2]: An endnote.');
  });

  test('deferred comments in footnote body are rendered after definition', async () => {
    // Construct content items directly to test buildMarkdown rendering
    const docContent: ContentItem[] = [
      { type: 'text', text: 'Body text', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'footnote_ref', noteId: '1', noteKind: 'footnote', commentIds: new Set() },
    ];
    const comments = new Map([
      ['c1', { author: 'Reviewer', text: 'fn comment', date: '' }],
    ]);
    const noteBody: ContentItem[] = [
      { type: 'text', text: 'Note text', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING },
    ];
    const notesMap = new Map([
      ['footnote:1', { label: '1', body: noteBody, noteKind: 'footnote' as const }],
    ]);
    const assignedLabels = new Map([['footnote:1', '1']]);
    const md = buildMarkdown(docContent, comments, {
      alwaysUseCommentIds: true,
      notes: { map: notesMap, assignedLabels },
    });

    expect(md).toContain('[^1]:');
    expect(md).toContain('fn comment');
    expect(md.indexOf('fn comment')).toBeGreaterThan(md.indexOf('[^1]:'));
  });
});
describe('parseBlockquoteLevel', () => {
  test('returns 1 for Quote style without explicit indent', () => {
    const children = [{ 'w:pStyle': [], ':@': { '@_w:val': 'Quote' } }];
    expect(parseBlockquoteLevel(children)).toBe(1);
  });

  test('returns 1 for IntenseQuote style (case-insensitive)', () => {
    const children = [{ 'w:pStyle': [], ':@': { '@_w:val': 'IntenseQuote' } }];
    expect(parseBlockquoteLevel(children)).toBe(1);
  });

  test('returns level based on indent', () => {
    const children = [
      { 'w:pStyle': [], ':@': { '@_w:val': 'Quote' } },
      { 'w:ind': [], ':@': { '@_w:left': '1440' } },
    ];
    expect(parseBlockquoteLevel(children)).toBe(2);
  });

  test('returns undefined for non-quote style', () => {
    const children = [{ 'w:pStyle': [], ':@': { '@_w:val': 'Normal' } }];
    expect(parseBlockquoteLevel(children)).toBeUndefined();
  });

  test('returns undefined when pStyle is absent', () => {
    expect(parseBlockquoteLevel([])).toBeUndefined();
  });
});

describe('Blockquote round-trip', () => {
  test('single blockquote round-trips through md→docx→md', async () => {
    const md = '> quoted text';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('> quoted text');
  });

  test('nested blockquote round-trips through md→docx→md', async () => {
    const md = '> > nested';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('> > nested');
  });

  test('DOCX with Quote style detected as blockquote', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:pPr><w:pStyle w:val="Quote"/><w:ind w:left="720"/></w:pPr>'
      + '<w:r><w:t>quoted text</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('> quoted text');
  });

  test('DOCX with IntenseQuote style detected as blockquote', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:pPr><w:pStyle w:val="IntenseQuote"/><w:ind w:left="720"/></w:pPr>'
      + '<w:r><w:t>intense</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('> intense');
  });
});

describe('parseCodeBlockStyle', () => {
  test('returns true for CodeBlock style', () => {
    const children = [{ 'w:pStyle': [], ':@': { '@_w:val': 'CodeBlock' } }];
    expect(parseCodeBlockStyle(children)).toBe(true);
  });

  test('returns true case-insensitively', () => {
    const children = [{ 'w:pStyle': [], ':@': { '@_w:val': 'codeblock' } }];
    expect(parseCodeBlockStyle(children)).toBe(true);
  });

  test('returns false for non-code-block style', () => {
    const children = [{ 'w:pStyle': [], ':@': { '@_w:val': 'Normal' } }];
    expect(parseCodeBlockStyle(children)).toBe(false);
  });

  test('returns false when pStyle is absent', () => {
    expect(parseCodeBlockStyle([])).toBe(false);
  });
});

describe('Code block detection in extractDocumentContent', () => {
  test('detects CodeBlock paragraphs', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>'
      + '<w:r><w:t>code line</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buf);
    const { content } = await extractDocumentContent(zip, [], new Map());
    const paraItem = content.find(item => item.type === 'para');
    expect(paraItem).toBeDefined();
    expect(paraItem!.type === 'para' && paraItem!.isCodeBlock).toBe(true);
  });
});

describe('buildMarkdown code block emission', () => {
  test('emits basic code fence from code block paragraphs', () => {
    const content: ContentItem[] = [
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: 'line 1', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: 'line 2', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
    ];
    const md = buildMarkdown(content, new Map());
    expect(md).toBe('```\nline 1\nline 2\n```');
  });

  test('emits code fence with language from codeBlockLangs', () => {
    const content: ContentItem[] = [
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: 'print("hi")', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
    ];
    const langs = new Map([['0', 'python']]);
    const md = buildMarkdown(content, new Map(), { codeBlockLangs: langs });
    expect(md).toBe('```python\nprint("hi")\n```');
  });

  test('trims trailing empty lines', () => {
    const content: ContentItem[] = [
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: 'code', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: '', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
    ];
    const md = buildMarkdown(content, new Map());
    expect(md).toBe('```\ncode\n```');
  });

  test('emits consecutive code blocks with different languages', () => {
    const content: ContentItem[] = [
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: 'print("a")', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'para' },
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: 'cat("b")', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
    ];
    const langs = new Map([['0', 'python'], ['1', 'r']]);
    const md = buildMarkdown(content, new Map(), { codeBlockLangs: langs });
    expect(md).toContain('```python\nprint("a")\n```');
    expect(md).toContain('```r\ncat("b")\n```');
  });
});

describe('Code block round-trip', () => {
  test('single code block with language survives MD→DOCX→MD', async () => {
    const md = '```stata\ndisplay "hello"\n```';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('```stata\ndisplay "hello"\n```');
  });

  test('code block without language survives round-trip', async () => {
    const md = '```\nplain code\n```';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('```\nplain code\n```');
  });

  test('consecutive code blocks with different languages survive round-trip', async () => {
    const md = '```python\nprint("a")\n```\n\n```r\ncat("b")\n```';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('```python\nprint("a")\n```\n\n```r\ncat("b")\n```');
  });

  test('code block containing backticks uses longer fence on round-trip', async () => {
    const md = '````\nSome ```backticks``` inside\n````';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('````\nSome ```backticks``` inside\n````');
  });

  test('multi-line code block survives round-trip', async () => {
    const md = '```javascript\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n```';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('```javascript\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n```');
  });
});

describe('Inline code import (CodeChar detection)', () => {
  test('parseRunProperties detects CodeChar style', () => {
    const children = [{ 'w:rStyle': [], ':@': { '@_w:val': 'CodeChar' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.code).toBe(true);
  });

  test('parseRunProperties detects CodeChar case-insensitively', () => {
    const children = [{ 'w:rStyle': [], ':@': { '@_w:val': 'codechar' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.code).toBe(true);
  });

  test('parseRunProperties does not set code for other styles', () => {
    const children = [{ 'w:rStyle': [], ':@': { '@_w:val': 'Emphasis' } }];
    const formatting = parseRunProperties(children);
    expect(formatting.code).toBe(false);
  });

  test('parseRunProperties resets inherited code when rStyle is non-CodeChar', () => {
    const base = { ...DEFAULT_FORMATTING, code: true };
    const children = [{ 'w:rStyle': [], ':@': { '@_w:val': 'Emphasis' } }];
    const formatting = parseRunProperties(children, base);
    expect(formatting.code).toBe(false);
  });

  test('wrapWithFormatting wraps text with backticks when code is true', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true };
    expect(wrapWithFormatting('hello', fmt)).toBe('`hello`');
  });

  test('wrapWithFormatting uses double-backtick fence when text contains backticks', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true };
    expect(wrapWithFormatting('a`b', fmt)).toBe('``a`b``');
  });

  test('wrapWithFormatting handles text with multiple backtick runs', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true };
    expect(wrapWithFormatting('a``b', fmt)).toBe('```a``b```');
  });

  test('wrapWithFormatting adds padding when text starts with backtick', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true };
    expect(wrapWithFormatting('`start', fmt)).toBe('`` `start ``');
  });

  test('wrapWithFormatting adds padding when text ends with backtick', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true };
    expect(wrapWithFormatting('end`', fmt)).toBe('`` end` ``');
  });

  test('wrapWithFormatting applies code inside bold', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true, bold: true };
    expect(wrapWithFormatting('hello', fmt)).toBe('**`hello`**');
  });

  test('wrapWithFormatting applies code inside italic', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true, italic: true };
    expect(wrapWithFormatting('hello', fmt)).toBe('*`hello`*');
  });
});

describe('Inline code round-trip', () => {
  test('inline code survives MD→DOCX→MD', async () => {
    const md = 'Some `inline code` here';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('Some `inline code` here');
  });

  test('bold inline code survives round-trip', async () => {
    const md = '**`bold code`**';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('**`bold code`**');
  });

  test('italic inline code survives round-trip', async () => {
    const md = '*`italic code`*';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('*`italic code`*');
  });

  test('inline code containing backticks round-trips correctly', async () => {
    const md = 'Use `` `backtick` `` in code';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('Use `` `backtick` `` in code');
  });
});

