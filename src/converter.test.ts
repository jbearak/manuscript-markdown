import { describe, test, expect, beforeAll } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  extractComments,
  extractZoteroCitations,
  buildCitationKeyMap,
  extractDocumentContent,
  buildMarkdown,
  keepParagraphWhitespace,
  generateBibTeX,
  convertDocx,
  generateCitationKey,
  wrapWithFormatting,
  RunsAfter,
  DEFAULT_FORMATTING,
  RunFormatting,
  ContentItem,
  RevisionInfo,
  isToggleOn,
  parseHeadingLevel,
  parseAlertType,
  parseBlockquoteLevel,
  parseCodeBlockStyle,
  parseRunProperties,
  formatLocalIsoMinute,
  citationPandocKeys,
  itemIdentifier,
  ZoteroCitation,
  extractBibKeyOrder,
  extractBibData,
  extractBibliographyPath,
  extractCalloutLabels,
} from './converter';
import { parseBibtex } from './bibtex-parser';
import { convertMdToDocx, parseMd } from './md-to-docx';
import { GRID_TABLE_PLACEHOLDER_PREFIX } from './grid-table-preprocess';
import { keepParagraphEdgeWhitespace } from './html-entities';

const fixturesDir = join(__dirname, '..', 'test', 'fixtures');
const sampleData = new Uint8Array(readFileSync(join(fixturesDir, 'sample.docx')));
const formattingSampleData = new Uint8Array(readFileSync(join(fixturesDir, 'formatting_sample.docx')));
// tables.docx is generated from markdown in beforeAll below (no committed binary)
let tablesData: Uint8Array;
const commentsData = new Uint8Array(readFileSync(join(fixturesDir, 'comments.docx')));
const expectedMd = readFileSync(join(fixturesDir, 'expected-output.md'), 'utf-8').trimEnd();
const expectedBib = readFileSync(join(fixturesDir, 'expected-output.bib'), 'utf-8').trimEnd();

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


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

  test('uses paraId from the last paragraph when comment has multiple paragraphs', async () => {
    const docXml = wrapDocumentXml('<w:p><w:r><w:t>Body</w:t></w:r></w:p>');
    const commentsXml = '<?xml version=\"1.0\"?>'
      + '<w:comments xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\">'
      + '<w:comment w:id=\"1\" w:author=\"Alice\" w:date=\"2024-01-01T00:00:00Z\">'
      + '<w:p><w:r><w:t>First para.</w:t></w:r></w:p>'
      + '<w:p w14:paraId=\"ABCD1234\" w14:textId=\"77777777\"><w:r><w:t>Second para.</w:t></w:r></w:p>'
      + '</w:comment>'
      + '</w:comments>';

    const buf = await buildSyntheticDocx(docXml, { 'word/comments.xml': commentsXml });
    const comments = await extractComments(buf);
    expect(comments.get('1')?.paraId).toBe('ABCD1234');
  });
});

describe('DOCX table conversion', () => {
  test('renders DOCX table as HTML table with paragraph boundaries when grid disabled', async () => {
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
    const result = await convertDocx(buf, 'authorYearTitle', { gridTableMaxLineWidth: 0 });

    expect(result.markdown).toContain('<table>');
    expect(result.markdown).toContain('<th>');
    expect(result.markdown).toContain('<td>');
    expect(result.markdown).toContain('<p>first paragraph</p>');
    expect(result.markdown).toContain('<p>second paragraph</p>');
  });

  test('ignores generated callout spacer paragraphs inside table cells', async () => {
    const { docx } = await convertMdToDocx('| H |\n| --- |\n| x |');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const spacer = '<w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="6" w:color="007EB5"/></w:pBdr>'
      + '<w:spacing w:after="0" w:line="1" w:lineRule="exact"/><w:ind w:left="240"/></w:pPr></w:p>';
    let cellIndex = 0;
    const documentXml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', documentXml.replace(/<w:tc>/g, match => {
      cellIndex++;
      return cellIndex === 2 ? match + spacer : match;
    }));
    const modifiedDocx = await zip.generateAsync({ type: 'uint8array' });
    const result = await convertDocx(modifiedDocx, 'authorYearTitle', {
      pipeTableMaxLineWidth: 0,
      gridTableMaxLineWidth: 0,
    });

    expect(result.markdown).toContain('| H |');
    expect(result.markdown).toContain('| x |');
    expect(result.markdown).not.toContain('<table>');
    expect(result.markdown).not.toContain('<p></p>');
  });

  test('renders DOCX table with multi-paragraph cell as grid table', async () => {
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

    // Grid table with separate lines for each paragraph
    expect(result.markdown).toMatch(/^\+-+\+-+\+$/m);
    expect(result.markdown).toContain('first paragraph');
    expect(result.markdown).toContain('second paragraph');
    // Both paragraphs appear on separate lines in the grid cell
    expect(result.markdown).toMatch(/first paragraph.*\n.*second paragraph/);
    expect(result.markdown).not.toContain('<table>');
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
    const result = await convertDocx(buf, 'authorYearTitle', { pipeTableMaxLineWidth: 500 });

    expect(result.markdown).toContain(`{====annotated====}{>>@Reviewer (${formatLocalIsoMinute('2025-01-01T00:00:00Z')}) \\| note<<}`);
    expect(result.markdown).toContain('@smith2020cell, p. 20');
    expect(result.markdown).toContain('$x$');
    // Simple table renders as pipe table (explicit high width to avoid fragility)
    expect(result.markdown).toContain('| Header |');
    expect(result.markdown).toContain('| --- |');
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

    const withHeaderMd = (await convertDocx(await buildSyntheticDocx(withHeader), 'authorYearTitle', { pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 })).markdown;
    const withoutHeaderMd = (await convertDocx(await buildSyntheticDocx(withoutHeader), 'authorYearTitle', { pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 })).markdown;

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
    const result = await convertDocx(buf, 'authorYearTitle', { pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 });

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
    const result = await convertDocx(buf, 'authorYearTitle', { tableIndent: '\t', pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 });

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
    const result = await convertDocx(buf, 'authorYearTitle', { tableIndent: '', pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 });

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
      { type: 'citation', text: '(Smith 2020)', commentIds: new Set(), pandocKeys: ['@smith2020, p. 20'] },
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

    // Force HTML so we can extract cell content from <p> tags
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
      { pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 },
    );

    const paraMatch = tableMarkdown.match(/<p>([\s\S]*?)<\/p>/);
    expect(paraMatch).not.toBeNull();
    expect(paraMatch?.[1]).toBe(bodyMarkdown);
  });

  test('emits deferred ID comment bodies after an HTML table', () => {
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
      { alwaysUseCommentIds: true, pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 },
    );

    const paraMatch = tableMarkdown.match(/<p>([\s\S]*?)<\/p>/);
    expect(paraMatch).not.toBeNull();
    expect(paraMatch?.[1]).toBe('{#1}commented{/1}');
    expect(paraMatch?.[1]).not.toContain('{#1>>');
    expect(tableMarkdown).toContain('{#1>>@Reviewer | note<<}');
    expect(tableMarkdown).toContain('</table>\n\n{#1>>@Reviewer | note<<}');
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
    const result = await convertDocx(docx, 'authorYearTitle', { pipeTableMaxLineWidth: 0 });

    expect(result.markdown).toContain('<th>');
    expect(result.markdown).toContain('Header');
    expect(result.markdown).toContain('<td>');
    expect(result.markdown).toContain('Data');
  });
});

describe('Pipe table rendering', () => {
  /** Build a synthetic DOCX from table XML and convert it. */
  async function buildAndConvertTable(
    tableXml: string,
    convertOpts?: Parameters<typeof convertDocx>[2],
    extraFiles?: Record<string, string>,
  ) {
    const xml = wrapDocumentXml(tableXml);
    const buf = await buildSyntheticDocx(xml, extraFiles);
    return convertDocx(buf, 'authorYearTitle', convertOpts);
  }

  test('simple 2x2 table renders as pipe table by default', async () => {
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tblPr><w:tblLook w:firstRow="1"/></w:tblPr>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>H1</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>H2</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );

    expect(result.markdown).toContain('| H1 | H2 |');
    expect(result.markdown).toContain('| --- | --- |');
    expect(result.markdown).toContain('| A | B |');
    expect(result.markdown).not.toContain('<table>');
  });

  test('table with colspan falls back to HTML', async () => {
    const result = await buildAndConvertTable(
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

    expect(result.markdown).toContain('<table>');
    expect(result.markdown).toContain('colspan="2"');
  });

  test('table with rowspan falls back to HTML', async () => {
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Tall</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>R1</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '<w:tr>'
      + '<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>'
      + '<w:tc><w:p><w:r><w:t>R2</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );

    expect(result.markdown).toContain('<table>');
    expect(result.markdown).toContain('rowspan="2"');
  });

  test('table with multi-paragraph cell falls back to grid', async () => {
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc>'
      + '<w:p><w:r><w:t>para one</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>para two</w:t></w:r></w:p>'
      + '</w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );

    expect(result.markdown).toContain('+');
    expect(result.markdown).toContain('para one');
    expect(result.markdown).toContain('para two');
    expect(result.markdown).not.toContain('<table>');
  });

  test('line width exceeding pipe limit falls back to grid', async () => {
    const maxWidth = 80;
    const longText = 'x'.repeat(maxWidth);
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>' + longText + '</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>',
      { pipeTableMaxLineWidth: maxWidth },
    );

    expect(result.markdown).toContain('+');
    expect(result.markdown).toContain(longText);
    expect(result.markdown).not.toContain('<table>');
  });

  test('line width exceeding both pipe and grid limits falls back to HTML', async () => {
    const maxWidth = 80;
    const longText = 'x'.repeat(maxWidth);
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>' + longText + '</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>',
      { pipeTableMaxLineWidth: maxWidth, gridTableMaxLineWidth: maxWidth },
    );

    expect(result.markdown).toContain('<table>');
  });

  test('line width exactly at limit stays as pipe table', async () => {
    const maxWidth = 80;
    // | + space + content + space + | = 4 chars of overhead for a single-cell row
    const fittingText = 'x'.repeat(maxWidth - 4);
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>' + fittingText + '</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>',
      { pipeTableMaxLineWidth: maxWidth },
    );

    expect(result.markdown).not.toContain('<table>');
    expect(result.markdown).toContain('| ' + fittingText + ' |');
  });

  test('pipeTableMaxLineWidth=0 falls back to grid', async () => {
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>',
      { pipeTableMaxLineWidth: 0 },
    );

    // Grid table border present
    expect(result.markdown).toMatch(/^\+-+\+$/m);
    expect(result.markdown).toContain('A');
    // No GFM separator row (pipe table)
    expect(result.markdown).not.toMatch(/^\|(?:\s*:?-+:?\s*\|)+$/m);
    expect(result.markdown).not.toContain('<table>');
  });

  test('pipeTableMaxLineWidth=0 and gridTableMaxLineWidth=0 always uses HTML', async () => {
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>',
      { pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 },
    );

    expect(result.markdown).toContain('<table>');
    expect(result.markdown).not.toContain('| A |');
  });

  test('pipe characters in cell content are escaped', async () => {
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>a|b</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );

    expect(result.markdown).toContain('a\\|b');
    expect(result.markdown).not.toContain('<table>');
  });

  test('backslash and pipe in cell content are each escaped independently', async () => {
    // A literal \| in DOCX content has both characters escaped: \\ and \|.
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>a\\|b</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );

    // The backslash should be escaped and pipe should be escaped independently
    expect(result.markdown).toContain('a\\\\\\|b');
    expect(result.markdown).not.toContain('<table>');
    // The output should have exactly one pipe-table row with this cell
    const lines = result.markdown.split('\n').filter(l => l.includes('a\\\\'));
    expect(lines.length).toBe(1);
  });

  // GFM pipe tables always have a header row; when the DOCX has no header
  // signal, the first row is promoted to header. A round-trip will mark it
  // as a header — this is an accepted trade-off vs falling back to HTML.
  test('table without header row still renders as pipe table', async () => {
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '<w:tr>'
      + '<w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc>'
      + '</w:tr>'
      + '</w:tbl>'
    );

    expect(result.markdown).toContain('| A | B |');
    expect(result.markdown).toContain('| --- | --- |');
    expect(result.markdown).toContain('| C | D |');
  });

  test('commented run in cell with HTML fallback emits comment body exactly once', async () => {
    const commentsXml =
      '<?xml version="1.0"?>'
      + '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:comment w:id="1" w:author="Tester" w:date="2025-06-01T00:00:00Z"><w:p><w:r><w:t>unique review note</w:t></w:r></w:p></w:comment>'
      + '</w:comments>';
    const result = await buildAndConvertTable(
      '<w:tbl>'
      + '<w:tr>'
      + '<w:tc><w:p>'
      + '<w:commentRangeStart w:id="1"/>'
      + '<w:r><w:t>annotated cell</w:t></w:r>'
      + '<w:commentRangeEnd w:id="1"/>'
      + '</w:p>'
      + '<w:p><w:r><w:t>second paragraph</w:t></w:r></w:p>'
      + '</w:tc>'
      + '</w:tr>'
      + '</w:tbl>',
      { alwaysUseCommentIds: true, pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 },
      { 'word/comments.xml': commentsXml },
    );

    // Multi-paragraph cell forces HTML fallback (both pipe and grid disabled)
    expect(result.markdown).toContain('<table>');
    // Comment body text appears exactly once
    const bodyMatches = result.markdown.match(/unique review note/g) || [];
    expect(bodyMatches.length).toBe(1);
  });

  test('frontmatter pipe-table-max-line-width round-trips through MD→DOCX→MD', async () => {
    // Build a simple markdown with a pipe table and a non-default max line width
    const md = [
      '---',
      'pipe-table-max-line-width: 80',
      '---',
      '',
      '| H1 | H2 |',
      '| --- | --- |',
      '| A | B |',
      '',
    ].join('\n');

    // MD → DOCX
    const docxResult = await convertMdToDocx(md);
    const docxBuf = docxResult.docx;

    // DOCX → MD with a different default (120), but the stored value (80) should win
    const mdResult = await convertDocx(docxBuf, 'authorYearTitle', {
      pipeTableMaxLineWidthDefault: 120,
    });

    // The frontmatter should contain the round-tripped value
    expect(mdResult.markdown).toMatch(/pipe-table-max-line-width:\s*80/);
  });

  test('explicit pipe-table-max-line-width: 120 survives round-trip', async () => {
    const md = [
      '---',
      'pipe-table-max-line-width: 120',
      '---',
      '',
      '| H1 | H2 |',
      '| --- | --- |',
      '| A | B |',
      '',
    ].join('\n');

    const docxResult = await convertMdToDocx(md);
    const mdResult = await convertDocx(docxResult.docx, 'authorYearTitle');

    // Even though 120 equals the default, it was explicitly stored and must survive
    expect(mdResult.markdown).toMatch(/pipe-table-max-line-width:\s*120/);
  });

  test('frontmatter grid-table-max-line-width round-trips through MD→DOCX→MD', async () => {
    const md = [
      '---',
      'grid-table-max-line-width: 80',
      '---',
      '',
      '| H1 | H2 |',
      '| --- | --- |',
      '| A | B |',
      '',
    ].join('\n');

    const docxResult = await convertMdToDocx(md);
    const mdResult = await convertDocx(docxResult.docx, 'authorYearTitle', {
      gridTableMaxLineWidthDefault: 120,
    });

    expect(mdResult.markdown).toMatch(/grid-table-max-line-width:\s*80/);
  });

  test('explicit grid-table-max-line-width: 120 survives round-trip', async () => {
    const md = [
      '---',
      'grid-table-max-line-width: 120',
      '---',
      '',
      '| H1 | H2 |',
      '| --- | --- |',
      '| A | B |',
      '',
    ].join('\n');

    const docxResult = await convertMdToDocx(md);
    const mdResult = await convertDocx(docxResult.docx, 'authorYearTitle');

    expect(mdResult.markdown).toMatch(/grid-table-max-line-width:\s*120/);
  });
});

test('pipe table headers round-trip without spurious bold', async () => {
  const md = [
    '| Header 1 | Header 2 |',
    '| --- | --- |',
    '| cell A | cell B |',
    '',
  ].join('\n');

  const { docx } = await convertMdToDocx(md);
  const result = await convertDocx(docx);

  // Headers should not gain **bold** markers on round-trip
  expect(result.markdown).not.toContain('**Header 1**');
  expect(result.markdown).not.toContain('**Header 2**');
  expect(result.markdown).toContain('| Header 1 |');
  expect(result.markdown).toContain('| Header 2 |');
});

describe('Integration: tables.docx fixture', () => {
  const tablesSourceMd = [
    '# Simple Table',
    '',
    '| Row 1 Col 1 | | | | |',
    '| --- | --- | --- | --- | --- |',
    '| Row 2 Col 1 | | | | Row 2 Col 5 |',
    '',
    '# Table With Spanned Header Cols',
    '',
    '<table>',
    '<tr><th>Row 1 Col 1</th><th colspan="2">Row 1 Cols 2-3</th><th colspan="2">Row 1 Cols 4-5</th></tr>',
    '<tr><td></td><td></td><td></td><td></td><td></td></tr>',
    '</table>',
    '',
    '# Complex Table',
    '',
    '<table>',
    '<tr><th>Row 1 Col 1</th><th colspan="3">Row 1 Cols 2-4</th><th>Row 1 Col 5</th></tr>',
    '<tr><td></td><td></td><td></td><td></td><td></td></tr>',
    '<tr><td></td><td></td><td rowspan="2">Rows 3-4 Col 3</td><td></td><td rowspan="2">Rows 3-4 Col 5</td></tr>',
    '<tr><td></td><td></td><td></td></tr>',
    '<tr><td></td><td></td><td></td><td></td><td></td></tr>',
    '</table>',
  ].join('\n');

  beforeAll(async () => {
    const { docx, warnings } = await convertMdToDocx(tablesSourceMd);
    expect(warnings).toEqual([]);
    tablesData = docx;
  });

  test('converts tables.docx and produces three tables (simple one as pipe, complex as HTML)', async () => {
    const result = await convertDocx(tablesData, 'authorYearTitle', { pipeTableMaxLineWidthDefault: 120 });
    // Simple table becomes pipe table; two complex tables remain HTML
    const htmlTables = result.markdown.match(/<table>/g) || [];
    expect(htmlTables.length).toBe(2);
    expect(result.markdown).toContain('| --- |');
  });

  test('simple table has header row and content cells', async () => {
    const result = await convertDocx(tablesData);
    // First table: simple 2x5, first row is header — now a pipe table
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

describe('Table format metadata round-trip', () => {
  test('HTML table format is preserved through MD→DOCX→MD', async () => {
    const htmlTableMd = '<table>\n<tr><th>H1</th><th>H2</th></tr>\n<tr><td>A</td><td>B</td></tr>\n</table>';
    const { docx } = await convertMdToDocx(htmlTableMd);
    const result = await convertDocx(docx);
    // HTML-sourced table should remain HTML on round-trip
    expect(result.markdown).toContain('<table>');
    expect(result.markdown).toContain('H1');
  });

  test('pipe table format is preserved through MD→DOCX→MD', async () => {
    const pipeMd = '| H1 | H2 |\n| --- | --- |\n| A | B |';
    const { docx } = await convertMdToDocx(pipeMd);
    const result = await convertDocx(docx);
    // Pipe-sourced table should remain pipe on round-trip
    expect(result.markdown).toContain('| --- |');
    expect(result.markdown).toContain('| A |');
    expect(result.markdown).not.toContain('<table>');
  });

  test('pipe table empty cells do not gain doubled spaces on round-trip', async () => {
    const pipeMd = '| H1 | H2 | H3 |\n| --- | --- | --- |\n| A | | C |';
    const { docx } = await convertMdToDocx(pipeMd);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('| A | | C |');
    expect(result.markdown).not.toContain('| A |  | C |');
  });
});

describe('Grid table renderer', () => {
  test('grid table is produced for multi-line cells when format is grid', async () => {
    // Build a table with multi-line cells using HTML (which supports multiple paragraphs)
    const htmlMd = [
      '<table>',
      '<tr><th>Header 1</th><th>Header 2</th></tr>',
      '<tr><td><p>Line 1</p><p>Line 2</p></td><td>Single</td></tr>',
      '</table>',
    ].join('\n');
    const { docx } = await convertMdToDocx(htmlMd);
    // Override the stored format to 'grid' for this test
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    // Replace the stored table format from 'html' to 'grid'
    const customXml = await zip.file('docProps/custom.xml')?.async('string') || '';
    const updatedXml = customXml.replace(
      '{"0":"html"}',
      '{"0":"grid"}'
    );
    zip.file('docProps/custom.xml', updatedXml);
    const modifiedDocx = await zip.generateAsync({ type: 'uint8array' });

    const result = await convertDocx(modifiedDocx);
    // Grid table should have + separators and | cell boundaries
    expect(result.markdown).toContain('+');
    expect(result.markdown).toContain('|');
    // Multi-line cell should appear
    expect(result.markdown).toContain('Line 1');
    expect(result.markdown).toContain('Line 2');
    // Should NOT be an HTML table
    expect(result.markdown).not.toContain('<table>');
  });

  test('buildMarkdown renders grid table with header separator', () => {
    const content: ContentItem[] = [
      {
        type: 'table',
        rows: [
          { isHeader: true, cells: [{ paragraphs: [[{ type: 'text', text: 'H1', commentIds: new Set(), formatting: DEFAULT_FORMATTING }]] }, { paragraphs: [[{ type: 'text', text: 'H2', commentIds: new Set(), formatting: DEFAULT_FORMATTING }]] }] },
          { isHeader: false, cells: [{ paragraphs: [[{ type: 'text', text: 'A', commentIds: new Set(), formatting: DEFAULT_FORMATTING }], [{ type: 'text', text: 'B', commentIds: new Set(), formatting: DEFAULT_FORMATTING }]] }, { paragraphs: [[{ type: 'text', text: 'C', commentIds: new Set(), formatting: DEFAULT_FORMATTING }]] }] },
        ],
      },
    ];
    // Force grid format via tableFormatMapping
    const tableFormatMapping = new Map([['0', 'grid']]);
    const md = buildMarkdown(content, new Map(), { pipeTableMaxLineWidth: 0, tableFormatMapping });
    // Should have grid separators
    expect(md).toContain('+');
    expect(md).toContain('| H1');
    expect(md).toContain('| A');
    expect(md).toContain('| B');
    // Header row should use = separator
    expect(md).toMatch(/\+=+\+/);
    // Body rows should use - separator
    expect(md).toMatch(/\+-+\+/);
  });
});

describe('Grid table round-trip', () => {
  test('grid table with multi-line cells round-trips through MD→DOCX→MD', async () => {
    const gridMd = [
      '+----------+----------+',
      '| Header 1 | Header 2 |',
      '+==========+==========+',
      '| Cell 1   | Cell 2   |',
      '|          | line 2   |',
      '+----------+----------+',
      '| Cell 3   | Cell 4   |',
      '+----------+----------+',
    ].join('\n');
    const { docx } = await convertMdToDocx(gridMd);
    const result = await convertDocx(docx);
    // Should produce a grid table (not HTML)
    expect(result.markdown).toContain('+');
    expect(result.markdown).toContain('Header 1');
    expect(result.markdown).toContain('Cell 2');
    expect(result.markdown).toContain('line 2');
    expect(result.markdown).not.toContain('<table>');
  });

  test('grid table preserves vertically offset cell content on round-trip', async () => {
    const gridMd = [
      '+------+------+------+',
      '| Col1 |      |      |',
      '|      | Col2 |      |',
      '|      |      | Col3 |',
      '+======+======+======+',
      '| A    | B    | C    |',
      '+------+------+------+',
    ].join('\n');
    const { docx } = await convertMdToDocx(gridMd);
    const result = await convertDocx(docx);
    // Content vertical position must survive: Col3 on line 3, Col2 on line 2
    const lines = result.markdown.split('\n');
    // Find the header content rows (between first border and === border)
    const firstBorder = lines.findIndex(l => /^\+[-=]/.test(l));
    const eqBorder = lines.findIndex(l => /^\+=/.test(l));
    const headerLines = lines.slice(firstBorder + 1, eqBorder);
    // Col1 should appear on the first header line
    expect(headerLines[0]).toContain('Col1');
    expect(headerLines[0]).not.toContain('Col2');
    // Col2 should appear on the second header line
    expect(headerLines[1]).toContain('Col2');
    expect(headerLines[1]).not.toContain('Col1');
    // Col3 should appear on the third header line
    expect(headerLines[2]).toContain('Col3');
    expect(headerLines[2]).not.toContain('Col2');
  });

  test('simple grid table without multi-line cells preserves grid format', async () => {
    const gridMd = [
      '+------+------+',
      '| H1   | H2   |',
      '+======+======+',
      '| A    | B    |',
      '+------+------+',
    ].join('\n');
    const { docx } = await convertMdToDocx(gridMd);
    const result = await convertDocx(docx);
    // Grid format is preserved even when cells are simple enough for pipe
    expect(result.markdown).toContain('+');
    expect(result.markdown).toContain('|');
  });
});

describe('Horizontal rule round-trip', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);

  const RULE_BORDER = '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>';
  /** The Markdown export makes, with the paragraph after the rule merged into
   *  it: `after`, right after the rule's border, becomes `merged` */
  const withParagraphMergedIntoRule = async (md: string, after: RegExp, merged: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const at = xml.indexOf(RULE_BORDER) + RULE_BORDER.length;
    zip.file('word/document.xml', xml.slice(0, at) + xml.slice(at).replace(after, merged));
    return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
  };

  test('keeps a rule that holds a zero-width comment', async () => {
    // The comment's empty anchor counted as content
    expect(await withParagraphMergedIntoRule('A.\n\n---\n{>>@A (2024-01-15 10:30) | c<<}\n\nB.',
      /^<\/w:pPr><\/w:p><w:p\b[^>]*>(<w:commentRangeStart[\s\S]*?<\/w:r>)<\/w:p>/, '</w:pPr>$1</w:p>'))
      .toBe('A.\n\n---\n{>>@A (2024-01-15 10:30) | c<<}\n\nB.\n');
  });

  test('keeps the zero-width comment on a rule that carries an ordinary section break', async () => {
    // Only the children of a landscape or portrait section's carrier were read
    expect(await withParagraphMergedIntoRule('A.\n\n---\n{>>@A (2024-01-15 10:30) | c<<}\n\nB.',
      /^<\/w:pPr><\/w:p><w:p\b[^>]*>(<w:commentRangeStart[\s\S]*?<\/w:r>)<\/w:p>/,
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr>$1</w:p>'))
      .toBe('A.\n\n---\n{>>@A (2024-01-15 10:30) | c<<}\n\nB.\n');
  });

  test('counts no rule for indent overrides, with a comment or not', async () => {
    // Export counts no rule, and one a comment was added to in Word took the
    // next paragraph's override
    const zip = await JSZip.loadAsync((await convertMdToDocx('# H\n\nA.\n\n---\n\n<!-- no-indent -->\nB.\n\nC.')).docx);
    const commented = await JSZip.loadAsync((await convertMdToDocx('# H\n\nA.\n\n---\n{>>@A (2024-01-15 10:30) | c<<}\n\nB.')).docx);
    const xml = await commented.file('word/document.xml')!.async('string');
    const at = xml.indexOf(RULE_BORDER) + RULE_BORDER.length;
    const comment = /^<\/w:pPr><\/w:p><w:p\b[^>]*>(<w:commentRangeStart[\s\S]*?<\/w:r>)<\/w:p>/.exec(xml.slice(at))![1];
    const doc = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', doc.replace(RULE_BORDER + '</w:pPr>', RULE_BORDER + '</w:pPr>' + comment));
    for (const part of ['word/comments.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels']) {
      zip.file(part, await commented.file(part)!.async('string'));
    }
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)
      .toBe('# H\n\nA.\n\n---\n{>>@A (2024-01-15 10:30) | c<<}\n\n<!-- no-indent -->\nB.\n\nC.\n');
  });

  test('keeps a rule that Word moved a section break onto', async () => {
    // As an empty carrier of the break, it went with the section
    const md = 'A.\n\n---\n\n<!-- landscape -->\n\nWide.\n\n<!-- /landscape -->';
    expect(await withParagraphMergedIntoRule(md,
      /^<\/w:pPr><\/w:p><w:p\b[^>]*><w:pPr>(<w:sectPr[\s\S]*?<\/w:sectPr>)<\/w:pPr><\/w:p>/, '$1</w:pPr></w:p>'))
      .toBe(md + '\n');
  });

  test.each([
    ['a quote', '***\n> q\n\n---\n\nB.', '---\n\n> q\n\n---\n\nB.\n'],
    ['an HTML comment', '___\n<!-- c -->\n\n---\n\nB.', '---\n\n<!-- c -->\n\n---\n\nB.\n'],
  ])('keeps a rule that starts the document, right before %s, from opening frontmatter', async (_name, md, expected) => {
    // ---\n> q up to the next rule read as frontmatter, which lost the quote
    let markdown = md;
    for (let i = 0; i < 2; i++) markdown = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(markdown).toBe(expected);
  });

  test.each([
    ['between paragraphs', 'A.\n\n---\n\nB.'],
    ['at the end', 'A.\n\n---'],
    ['twice in a row', 'A.\n\n---\n\n---\n\nB.'],
    ['between lists', '- a\n\n---\n\n- b'],
    ['between headings', '# H\n\n---\n\n## I'],
    ['after a quote', '> q\n\n---\n\nB.'],
    ['right after a quote', '> q\n---\n\nB.'],
    ['before a table', 'A.\n\n---\n\n| a |\n| --- |\n| b |'],
    ['between a code block and a quote', '```\ncode\n```\n\n---\n\n> q'],
    ['between code blocks', '```\ncode\n```\n\n---\n\n```\nmore\n```'],
    ['between a code block and an alert', '```\ncode\n```\n\n---\n\n> [!NOTE]\n> alert'],
    ['after a code block', '```\ncode\n```\n\n---\n\nB.'],
    ['between a quote and a heading', '> q\n\n---\n\n# H'],
    ['between quotes', '> q\n\n---\n\n> r'],
    ['between a quote and a list', '> q\n\n---\n\n- a'],
  ])('keeps a rule %s', async (_, md) => {
    expect(await roundTrip(md)).toBe(md);
  });

  test('keeps a rule before a title paragraph', async () => {
    // A title after the rule isn't the document's title
    const zip = await JSZip.loadAsync((await convertMdToDocx('---\ntitle: T\n---\n\nBody.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:p\b[^>]*><w:pPr><w:pStyle w:val="Title"\/>/,
      '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>$&'));
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe('---\n\nT\n\nBody.\n');
  });

  test('writes a rule of any kind as ---', async () => {
    expect(await roundTrip('A.\n\n***\n\nB.')).toBe('A.\n\n---\n\nB.');
  });

  test('keeps the text of a paragraph with a bottom border', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/(<w:p\b[^>]*>)(<w:r><w:t>A\.)/,
      '$1<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr>$2'));
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('A.\n\nB.');
  });
});

describe('Ordered list numbering', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  const documentXml = async (docx: Uint8Array) => (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  const numIdsOf = (xml: string) => [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(match => match[1]);

  test('gives each ordered list after the first numbering of its own, as Word counts on through one', async () => {
    const { docx } = await convertMdToDocx('1. a\n2. b\n\nPara.\n\n1. c\n   1. x\n2. d\n   1. y');
    const [a, b, c, x, d, y] = numIdsOf(await documentXml(docx));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // Sublists of a numbered item stay in its list's numbering
    expect([x, d, y]).toEqual([c, c, c]);
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    expect(numbering).toMatch(new RegExp('<w:num w:numId="' + c + '"[^>]*>[^]*?<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>'));
  });

  test.each([
    ['a list after a paragraph', '1. a\n2. b\n\nPara.\n\n1. c\n2. d', undefined],
    ['a list after another delimiter', '1. a\n2. b\n\n1) c\n2) d', '1. a\n2. b\n\n<!-- -->\n\n1. c\n2. d'],
    ['a list after an indent sentinel', '1. a\n2. b\n\n<!-- no-indent -->\n1. c', '1. a\n2. b\n\n<!-- -->\n\n<!-- no-indent -->\n1. c'],
    ['a numbered list after a bulleted one with a sentinel', '- b\n\n<!-- no-indent -->\n1. c', undefined],
    ['nested lists', '1. a\n   1. x\n   2. y\n2. b\n   1. z', undefined],
    ['a list that starts at 3', '1. a\n\nP.\n\n3. c', undefined],
    ['a list after another delimiter that goes on', '1. a\n\n2) b', '1. a\n\n<!-- -->\n\n2. b'],
    ['a sublist after a comment', '1. parent\n   1. a\n\n   <!-- -->\n\n   1. b', undefined],
    ['sentinels around a quote in an item', '<!-- no-indent -->\n1. a\n\n   > q\n2. b\n\nP.\n\n<!-- indent -->\n1. c', undefined],
    ['sentinels around a second paragraph in an item', '<!-- no-indent -->\n- a\n\n  more\n- b\n\nP.\n\n<!-- indent -->\n- c', undefined],
  ])('round-trips the numbering of %s', async (_, md, back) => {
    // Markdown starts each list over; Word has to as well
    expect(await roundTrip(md)).toBe(back ?? md);
    expect(await roundTrip(back ?? md)).toBe(back ?? md);
  });

  test('gives no warning for the comment between two sublists', async () => {
    // Export drops it on purpose, as it does any HTML block in an item
    const { warnings } = await convertMdToDocx('1. parent\n   1. a\n\n   <!-- -->\n\n   1. b');
    expect(warnings).toEqual([]);
    expect((await convertMdToDocx('- parent\n\n  <!-- c -->')).warnings).toHaveLength(1);
    // Between bullet lists, nothing keeps the two apart in Word
    expect((await convertMdToDocx('1. parent\n   - a\n\n   <!-- -->\n\n   - b')).warnings).toHaveLength(1);
  });

  test.each([
    ['goes on', '0', '3. c'],
    ['starts over', '1', '1. c'],
  ])('reads a list that %s after a section break', async (_, restarts, last) => {
    // One numbering instance throughout, as a document made in Word has
    const { docx } = await convertMdToDocx('1. a\n2. b\n\n<!-- landscape -->\n\nT.\n\n<!-- /landscape -->\n\n3. c');
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const first = numIdsOf(xml)[0];
    zip.file('word/document.xml', xml.replace(/<w:numId w:val="\d+"\/>/g, '<w:numId w:val="' + first + '"/>'));
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    zip.file('word/numbering.xml', numbering.replace('<w:abstractNum w:abstractNumId="1" w15:restartNumberingAfterBreak="0"',
      '<w:abstractNum w:abstractNumId="1" w15:restartNumberingAfterBreak="' + restarts + '"'));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('1. a\n2. b\n\n<!-- landscape -->\n\nT.\n\n<!-- /landscape -->\n\n' + last);
  });

  test('reads a list Word numbers on across a paragraph', async () => {
    // One numbering instance throughout, as a document made in Word has
    const { docx } = await convertMdToDocx('1. a\n2. b\n\nPara.\n\n1. c');
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const first = numIdsOf(xml)[0];
    zip.file('word/document.xml', xml.replace(/<w:numId w:val="\d+"\/>/g, '<w:numId w:val="' + first + '"/>'));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('1. a\n2. b\n\nPara.\n\n3. c');
  });

  test('keeps apart two lists Word numbers separately', async () => {
    // The third item starts numbering of its own, right after the second
    const { docx } = await convertMdToDocx('1. a\n2. b\n\nPara.\n\n1. c');
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:p\b[^>]*><w:r><w:t>Para\.<\/w:t><\/w:r><\/w:p>/, ''));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('1. a\n2. b\n\n<!-- -->\n\n1. c');
  });

  test('adds numbering of their own to a template\'s numbering', async () => {
    const templateZip = await JSZip.loadAsync((await convertMdToDocx('1. t')).docx);
    const templateNumbering = await templateZip.file('word/numbering.xml')!.async('string');
    // A format of the template's own, which the document should keep
    templateZip.file('word/numbering.xml', templateNumbering.replace('<w:lvlText w:val="%1."/>', '<w:lvlText w:val="%1)"/>'));
    const templateDocx = await templateZip.generateAsync({ type: 'uint8array' });
    const { docx } = await convertMdToDocx('1. a\n\nP.\n\n1. b', { templateDocx });
    const [a, b] = numIdsOf(await documentXml(docx));
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    expect(numbering).toContain('<w:lvlText w:val="%1)"/>');
    expect(a).not.toBe(b);
    expect(numbering).toMatch(new RegExp('<w:num w:numId="' + b + '"[^>]*><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>'));
  });

  test.each([
    ['landscape', '<!-- landscape -->\n\n1. a\n\n<!-- /landscape -->\n\n1. b'],
    ['portrait', '1. a\n\n<!-- portrait -->\n\n1. b\n\n<!-- /portrait -->'],
  ])('needs nothing between lists a %s section keeps apart', async (_name, md) => {
    expect(await roundTrip(md)).toBe(md);
  });

  const templateWithNumbering = async (edit: (numbering: string) => string) => {
    const templateZip = await JSZip.loadAsync((await convertMdToDocx('1. t')).docx);
    templateZip.file('word/numbering.xml', edit(await templateZip.file('word/numbering.xml')!.async('string')));
    return templateZip.generateAsync({ type: 'uint8array' });
  };

  test('adds no durable IDs to a template without their namespace', async () => {
    // A root start tag broken across lines, with no w16cid
    const templateDocx = await templateWithNumbering(numbering => numbering
      .replace(/ w16cid:durableId="\d+"/g, '')
      .replace(' xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"', '')
      .replace(' mc:Ignorable="w15 w16cid"', ' mc:Ignorable="w15"')
      .replace('<w:numbering ', '<w:numbering\n  '));
    const { docx } = await convertMdToDocx('1. a\n\nP.\n\n1. b', { templateDocx });
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    expect(numbering).toContain('<w:startOverride w:val="1"/>');
    expect(numbering).not.toContain('w16cid');
  });

  test('formats a new list as the template formats its lists', async () => {
    // The template formats its lists in its numbering instance, not the abstract numbering
    const lvl = '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1)"/><w:lvlJc w:val="left"/></w:lvl>';
    const templateDocx = await templateWithNumbering(numbering => numbering.replace(
      /(<w:num w:numId="2"[^>]*><w:abstractNumId w:val="1"\/>)/, '$1<w:lvlOverride w:ilvl="0">' + lvl + '</w:lvlOverride>'));
    const { docx } = await convertMdToDocx('1. a\n\nP.\n\n1. b', { templateDocx });
    const [, b] = numIdsOf(await documentXml(docx));
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    const instance = new RegExp('<w:num w:numId="' + b + '"[^>]*>([^]*?)</w:num>').exec(numbering)?.[1];
    expect(instance).toBe('<w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>' + lvl + '</w:lvlOverride>');
  });

  test('counts on a level that a second instance doesn\'t override', async () => {
    const { docx } = await convertMdToDocx('1. a\n2. b');
    const zip = await JSZip.loadAsync(docx);
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    // An instance of the same numbering that starts only its sublists over
    zip.file('word/numbering.xml', numbering.replace('</w:numbering>',
      '<w:num w:numId="9"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>'));
    const xml = await zip.file('word/document.xml')!.async('string');
    let seen = 0;
    zip.file('word/document.xml', xml.replace(/<w:numId w:val="2"\/>/g, match => seen++ === 1 ? '<w:numId w:val="9"/>' : match));
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('1. a\n2. b');
  });

  test('replaces a template\'s start override written as an element pair', async () => {
    const templateDocx = await templateWithNumbering(numbering => numbering.replace(
      /(<w:num w:numId="2"[^>]*><w:abstractNumId w:val="1"\/>)/,
      '$1<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"></w:startOverride></w:lvlOverride>'));
    const { docx } = await convertMdToDocx('1. a\n\nP.\n\n1. b', { templateDocx });
    const [, b] = numIdsOf(await documentXml(docx));
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    const instance = new RegExp('<w:num w:numId="' + b + '"[^>]*>([^]*?)</w:num>').exec(numbering)?.[1] ?? '';
    expect(instance.match(/<w:startOverride\b/g)).toHaveLength(1);
  });

  test('numbers a sublist in its numbered parent\'s instance', async () => {
    // Word starts it over after each parent item, and a template can number it as 2.1
    const { docx } = await convertMdToDocx('1. p\n   1. x\n2. q\n   1. y');
    expect(new Set(numIdsOf(await documentXml(docx))).size).toBe(1);
  });

  test('starts a restarted sublist\'s numbered ancestors at their items\' numbers', async () => {
    // Its instance counts them on its own, so a label such as %1.%2 shows 2.1
    const md = '1. a\n\n<!-- -->\n\n1. b\n2. c\n   1. x\n\n   <!-- -->\n\n   1. y';
    const { docx } = await convertMdToDocx(md);
    const y = numIdsOf(await documentXml(docx))[4];
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    const instance = new RegExp('<w:num w:numId="' + y + '"[^>]*>([^]*?)</w:num>').exec(numbering)?.[1];
    expect(instance).toBe('<w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="2"/></w:lvlOverride>'
      + '<w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"/></w:lvlOverride>');
    expect(await roundTrip(md)).toBe(md);
  });

  test('puts no break before a numbered list after a bullet list at its level', async () => {
    // The sublist before it is numbered, not the list at the item's level
    expect(await roundTrip('1. a\n   - x\n      1. xx\n   1. y')).not.toContain('<!-- -->');
  });

  test.each([
    '<!-- no-indent -->\n- a\n\n1. b',
    '<!-- no-indent -->\n1. a\n2. b\n\n- c',
    '- a\n\n<!-- indent -->\n1. b\n\n- c',
  ])('keeps an indent directive to the list right after it: %j', async (md) => {
    expect(await roundTrip(md)).toBe(md);
  });

  test('adds no numbering on each export with the last as the template', async () => {
    // The overrides the last export added numbered only its own text
    const md = '1. a\n\nP.\n\n1. b\n\nQ.\n\n3. c';
    const nums = async (docx: Uint8Array) =>
      (await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string')).match(/<w:num\b/g)?.length;
    const first = (await convertMdToDocx(md)).docx;
    const second = (await convertMdToDocx(md, { templateDocx: first })).docx;
    const third = (await convertMdToDocx(md, { templateDocx: second })).docx;
    expect(await nums(second)).toBe(await nums(first));
    expect(await nums(third)).toBe(await nums(first));
    expect(numIdsOf(await documentXml(third))).toEqual(numIdsOf(await documentXml(first)));
  });

  test('keeps the numbering a template\'s styles use', async () => {
    const templateZip = await JSZip.loadAsync((await convertMdToDocx('1. t')).docx);
    const numbering = await templateZip.file('word/numbering.xml')!.async('string');
    templateZip.file('word/numbering.xml', numbering.replace('</w:numbering>',
      '<w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="8"><w:abstractNumId w:val="1"/></w:num></w:numbering>'));
    const styles = await templateZip.file('word/styles.xml')!.async('string');
    templateZip.file('word/styles.xml', styles.replace('</w:styles>',
      '<w:style w:type="paragraph" w:styleId="Numbered"><w:name w:val="Numbered"/><w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr></w:style></w:styles>'));
    const templateDocx = await templateZip.generateAsync({ type: 'uint8array' });
    const { docx } = await convertMdToDocx('1. a\n\nP.\n\n1. b', { templateDocx });
    const merged = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    expect(merged).toContain('<w:num w:numId="7">');
    expect(merged).not.toContain('<w:num w:numId="8">');
    expect(numIdsOf(await documentXml(docx))[1]).toBe('8');
  });

  test.each([
    ['single quotes', (numbering: string) => numbering
      .replace(/<w:num w:numId="2"([^>]*)><w:abstractNumId w:val="1"\/>/, "<w:num w:numId='2'$1><w:abstractNumId w:val='1'/>")],
    ['spaces around its equals signs', (numbering: string) => numbering
      .replace(/<w:num w:numId="2"([^>]*)><w:abstractNumId w:val="1"\/>/, '<w:num w:numId = "2"$1><w:abstractNumId w:val =\n"1"/>')
      .replace('</w:numbering>', '</w:numbering >')],
  ])('reads template numbering written with %s', async (_name, edit) => {
    const templateDocx = await templateWithNumbering(numbering => edit(numbering)
      .replace('<w:lvlText w:val="%1."/>', '<w:lvlText w:val="%1)"/>'));
    const { docx } = await convertMdToDocx('1. a\n\nP.\n\n1. b', { templateDocx });
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    expect(numbering).toContain('<w:lvlText w:val="%1)"/>');
    expect(numbering).toContain('<w:startOverride w:val="1"/>');
  });
});

describe('HTML blocks in list items', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;

  test.each([
    ['an item that is one', '- <div>a</div>\n- b\n'],
    ['one under an item', '- a\n\n  <div>b</div>\n'],
    ['one of more than one line', '- <div>\n  a\n  </div>\n'],
    ['one under an item, of more than one line', '1. a\n\n   <div>\n   b\n   </div>\n'],
    ['one in a numbered sublist', '- a\n  1. <div>b</div>\n'],
    ['a comment of more than one line after one', '- <div>a</div>\n- b {==c==}{>>d\n  e<<}\n'],
    ['one indented past its item', '- a\n\n    <div>b</div>\n'],
    ['one of more than one line indented past its item', '- a\n\n   <div>\n   b\n   </div>\n'],
    ['one of more than one line indented outside a list', ' <div>\n b\n </div>\n'],
    ['a <pre> with a blank line that has the item\'s indent', '- <pre>\n  a\n  \n  b\n  </pre>\n'],
    ['one with Markdown\'s characters and tags in it', '- <div data-x="*"><u>a</u> *b*</div>\n'],
    ['an HTML table with no rows, which is text, as at the top level', '- <table><caption>T</caption></table>\n'],
    ['a processing instruction', '- <?x?>\n'],
    ['one of more than one line that a marker ends', '- <?a\n  b?>\n'],
    ['a declaration', '- <!DOCTYPE html>\n'],
    ['CDATA', '- <![CDATA[x]]>\n'],
    ['a custom element', '- <widget>\n  *raw*\n  </widget>\n'],
    // Which only a blank line ends, which took in the sublist without one
    ['one before a sublist', '- <div>a</div>\n\n  - b\n'],
    ['one under an item before a sublist', '1. a\n\n   <div>b</div>\n\n   1. c\n'],
  ])('keeps %s', async (_name, md) => {
    // Export dropped an HTML block in an item, and import wrote an item's
    // lines after its first at the margin, where they ended the block and
    // the item, as an empty line ends a <pre> there
    expect(await roundTrip(md)).toBe(md);
    expect((await convertMdToDocx(md)).warnings.filter(w => w.includes('dropped'))).toEqual([]);
  });

  test.each([
    ['a quote', '- > quote\n\n  <div>after</div>\n', '- \n  > quote\n\n  <div>after</div>\n'],
    ['a sublist', '- - sub\n\n  <div>after</div>\n', '- \n  - sub\n\n  <div>after</div>\n'],
  ])('keeps one after %s in an item where it was', async (_name, md, expected) => {
    // Taken for the item's own text, it went before the quote
    expect(await roundTrip(md)).toBe(expected);
    expect(await roundTrip(expected)).toBe(expected);
  });

  test.each([
    ['a table', '- a\n\n  <table><tr><td>x</td></tr></table>\n'],
    ['a <pre> with a blank line in it', '- <pre>\n  a\n\n  b\n  </pre>\n'],
    ['a processing instruction with a blank line in it', '- <?a\n\n  b?>\n'],
  ])('warns of %s, which it drops', async (_name, md) => {
    // A table isn't a paragraph an item can hold, and markdown-it ends a
    // <pre> at a blank line in an item, leaving its text as Markdown
    expect((await convertMdToDocx(md)).warnings).toEqual([
      'HTML block inside list item dropped during conversion (not supported). Move the content outside the list for round-trip fidelity.',
    ]);
  });

  test.each([
    ['the next item', '- <pre>\n  text\n- next\n'],
    ['the end', '- a\n\n  <pre>\n  text\n'],
  ])('keeps the text of a <pre> with no closing tag that ends at %s, as at the top level', async (_name, md) => {
    // markdown-it ends it with the item, which loses none of it, but export
    // dropped it all the same. Import writes it as text, as it does one at
    // the top level.
    const result = await convertMdToDocx(md);
    expect(result.warnings).toEqual([]);
    expect(await roundTrip(md)).toContain('\\<pre>\ntext\n');
  });
});

describe('Blocks in list items', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
  const warningsOf = async (md: string) => (await convertMdToDocx(md)).warnings;

  test.each([
    ['a quote', '- > quote\n\n  after\n', '- \n  > quote\n\n  after\n'],
    ['a sublist', '- - sub\n\n  after\n', '- \n  - sub\n\n  after\n'],
  ])('keeps a paragraph after %s in an item where it was', async (_name, md, expected) => {
    // Taken for the item's own text, it went before the quote or sublist
    expect(await roundTrip(md)).toBe(expected);
    expect(await roundTrip(expected)).toBe(expected);
  });

  test.each([
    ['an item that is one', '- # h\n', '- h\n'],
    ['one under an item', '- a\n\n  # h\n', '- a\n\n  h\n'],
    ['a setext one', '- a\n  ---\n', '- a\n'],
  ])('keeps the text of a heading in %s, with a warning', async (_name, md, expected) => {
    // The heading's text was the item's, or went, with no warning
    expect(await roundTrip(md)).toBe(expected);
    expect(await warningsOf(md)).toEqual([
      'Heading inside list item exported as a paragraph (not supported). Move the heading outside the list for round-trip fidelity.',
    ]);
  });

  test('keeps the [ ] of a heading that starts an item as its text, not a task\'s box', () => {
    // GFM reads a box only in a paragraph that starts the item
    const [item] = parseMd('- # [ ] h\n');
    expect(item.taskChecked).toBeUndefined();
    expect(item.runs.map(run => run.text).join('')).toBe('[ ] h');
  });

  test('warns of a horizontal rule, which it drops', async () => {
    expect(await warningsOf('- a\n\n  ---\n')).toEqual([
      'Horizontal rule inside list item dropped during conversion (not supported). Move the content outside the list for round-trip fidelity.',
    ]);
  });

  test('takes no text from a table it drops', async () => {
    // Its first cell's text was the item's
    expect(await roundTrip('- | x |\n  |---|\n  | 1 |\n')).toBe('- \n');
  });
});

describe('Lists nested in lists of the other kind', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;

  test.each([
    ['a bullet list in a numbered item', '1. a\n   - b\n2. c\n'],
    ['a numbered list in a bullet item', '- a\n  1. b\n- c\n'],
    ['three levels, numbered first', '1. a\n   - x\n     1. xx\n   1. y\n'],
    ['three levels, bullets first', '- a\n  1. x\n     - xx\n  - y\n'],
    ['paragraphs under each', '1. a\n   - b\n\n     cont b\n\n   more a\n2. c\n'],
    ['a bullet list in item 10', '9. b\n10. c\n    - d\n11. e\n'],
    ['a tracked break in a bullet item in a numbered item', '1. a\n   - x {++a\n\n     b++} y\n'],
    ['a tracked break in a numbered item in a bullet item', '- a\n  1. x {++a\n\n     b++} y\n'],
    ['a tracked break in a bullet item in item 10', '10. a\n    - x {++a\n\n      b++} y\n'],
  ])('keeps %s', async (_name, md) => {
    // Indented as a list of its own kind would be, the sublist came out of
    // its item on the next round trip, with blank lines around it
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(await roundTrip(md))).toBe(md);
  });

  test.each([
    ['a bullet item', '- parent\n\n  3. child\n'],
    ['a numbered item', '1. parent\n\n   3. child\n'],
    ['a bullet item, before an empty item', '- a\n\n  - \n    - b\n'],
    ['a bullet item, before an empty numbered item', '- parent\n\n  1. \n     - grand\n'],
    ['a bullet item, after an empty item and a paragraph', '- a\n\n  3. \n\n  more\n\n  3. c\n'],
  ])('keeps the blank line before a sublist from 3 or empty in %s', async (_name, md) => {
    // Only a list from 1 can interrupt the item's text: without the blank
    // line, the sublist was read back as part of that text
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(await roundTrip(md))).toBe(md);
  });

  /** The Markdown of md's export with its level-1 list items at level 2, as Word can skip a level */
  const skippingLevel1 = async (md: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:ilvl w:val="1"\/>/g, '<w:ilvl w:val="2"/>').replace(/w:left="1440"/g, 'w:left="2160"'));
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    zip.file('word/numbering.xml', numbering.replace(/<w:lvlOverride w:ilvl="1">/g, '<w:lvlOverride w:ilvl="2">'));
    return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
  };

  test('indents a paragraph in an item at a level Word skipped under its marker', async () => {
    // It took the indent of a list of its own kind, which left the item
    const markdown = await skippingLevel1('10. a\n    - b\n\n      more\n');
    expect(markdown).toBe('10. a\n      - b\n\n        more\n');
    expect(await roundTrip(markdown)).toBe('10. a\n    - b\n\n      more\n');
  });

  test('indents the items at a level Word skipped alike', async () => {
    // The width of the first marker went in the place of the skipped level's
    expect(await skippingLevel1('- a\n\n  10. b\n  11. c\n')).toBe('- a\n\n     10. b\n     11. c\n');
  });

  test.each([
    ['a sublist from 3', '1. \n   3. child\n'],
    ['a bullet sublist', '1. \n   - child\n'],
    ['a numbered sublist', '- \n  1. child\n'],
  ])('puts no blank line between an empty item and %s', async (_name, md) => {
    // A blank line ends an item that starts with one, and the sublist came out of it
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(await roundTrip(md))).toBe(md);
  });
});

describe('Task list round-trip', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);

  test.each([
    ['a bulleted task list', '- [ ] t\n- [x] u'],
    ['a nested task item', 'A.\n\n- [ ] t\n  - [x] nested\n- [ ] v\n\nB.'],
    ['a numbered task list', '1. [ ] o\n2. [x] p'],
    ['a task item after a plain one', '- a\n- [ ] t'],
    ['a task item with a second paragraph', '- [ ] t\n\n  more\n- [x] u'],
    ['a task item with formatting', '- [ ] **bold** t'],
    ['a task item after a code block', '```\nx\n```\n\n- [ ] t\n- [x] u'],
    ['a numbered task item after a code block', '```\nx\n```\n\n1. [ ] t'],
  ])('keeps %s', async (_, md) => {
    expect(await roundTrip(md)).toBe(md);
  });

  test('leaves a tracked change to the box in the text', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('- [ ] todo')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('<w:r><w:t xml:space="preserve">☐ </w:t></w:r>',
      '<w:del w:id="90" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">☐ </w:delText></w:r></w:del>'
      + '<w:ins w:id="91" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">☒ </w:t></w:r></w:ins>'));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('- {~~☐ ~>☒ ~~}todo');
  });

  test.each([
    ['the box and its space', '<w:r><w:t>☐</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>'],
    ['the box and the text', '<w:r><w:t>☐</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>to</w:t></w:r>'],
  ])('reads a task item whose runs split %s', async (_name, runs) => {
    // Only a box and its space in one run made a task item
    const zip = await JSZip.loadAsync((await convertMdToDocx('- [ ] todo')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const split = runs.includes('>to<')
      ? xml.replace('<w:r><w:t xml:space="preserve">☐ </w:t></w:r><w:r><w:t>todo</w:t></w:r>', runs + '<w:r><w:t>do</w:t></w:r>')
      : xml.replace('<w:r><w:t xml:space="preserve">☐ </w:t></w:r>', runs);
    expect(split).not.toBe(xml);
    zip.file('word/document.xml', split);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('- [ ] todo');
  });

  test.each([
    ['the box alone', '<w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">☐ </w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:t>todo</w:t></w:r>', '- {==☐ ==}{>>@A (2024-01-15 10:30) | c<<}todo'],
    ['the box and the text', '<w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">☐ </w:t></w:r><w:r><w:t>todo</w:t></w:r><w:commentRangeEnd w:id="0"/>', '- [ ] {==todo==}{>>@A (2024-01-15 10:30) | c<<}'],
  ])('keeps a comment on %s', async (_name, runs, expected) => {
    // A comment on the box alone lost its range with the box
    const zip = await JSZip.loadAsync((await convertMdToDocx('- [ ] {==todo==}{>>@A (2024-01-15 10:30) | c<<}')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const moved = xml.replace('<w:r><w:t xml:space="preserve">☐ </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>todo</w:t></w:r><w:commentRangeEnd w:id="0"/>', runs);
    expect(moved).not.toBe(xml);
    zip.file('word/document.xml', moved);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps an empty paragraph shaped like a task item from making the next one a task', async () => {
    // The next paragraph took its paragraph marker, with the task level on it
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\n☐ not a task')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const empty = xml.replace(/(<w:p [^>]*>)(?=(?:(?!<\/w:p>).)*☐ not a task)/, '<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:p>$1');
    expect(empty).not.toBe(xml);
    zip.file('word/document.xml', empty);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('A.\n\n\n\n☐ not a task');
  });

  test('keeps a paragraph that only starts with a box', async () => {
    expect(await roundTrip('☐ not a task')).toBe('☐ not a task');
  });
});

describe('List indent round-trip', () => {
  test('does not infer an ordinary left-indented paragraph as a list continuation', async () => {
    const { docx } = await convertMdToDocx('- item\n\nBody');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    let replacedBody = false;
    const modifiedXml = documentXml.replace(
      /(<w:p\b[^>]*>)(<w:r><w:t>Body<\/w:t><\/w:r><\/w:p>)/,
      (_full, open: string, body: string) => {
        replacedBody = true;
        return open + '<w:pPr><w:ind w:left="720"/></w:pPr>' + body;
      },
    );
    expect(replacedBody).toBe(true);
    zip.file('word/document.xml', modifiedXml);
    const modified = await zip.generateAsync({ type: 'uint8array' });

    expect((await convertDocx(modified)).markdown).toContain('- item\n\nBody');
  });

  test('tab-indented lists round-trip with tabs', async () => {
    const md = '- item 1\n\t- nested\n\t\t- deep';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    // The converter normalizes space-after-marker to tab-after-marker for
    // tab-indented lists, so input `\t- nested` becomes `\t-\tnested`.
    expect(result.markdown).toContain('\t-\tnested');
  });

  test('space-indented lists round-trip with spaces', async () => {
    const md = '- item 1\n  - nested\n    - deep';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('  - nested');
    expect(result.markdown).not.toContain('\t');
  });

  test('unordered bullets normalize to dash while preserving list-contained blockquotes', async () => {
    const md = '* **Clinical phrasing:**\n  > quoted text';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('- **Clinical phrasing:**');
    expect(result.markdown).toContain('  > quoted text');
  });
});

describe('legacy hidden metadata compatibility', () => {
  test('legacy _bqg/_lic/_lim hidden runs are stripped from markdown output', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
      + '<w:r><w:rPr><w:vanish/></w:rPr><w:t>\u200B_lim:*</w:t></w:r>'
      + '<w:r><w:t>List item</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:pStyle w:val="GitHubBlockquote"/><w:spacing w:after="0"/><w:ind w:left="960"/></w:pPr>'
      + '<w:r><w:rPr><w:vanish/></w:rPr><w:t>\u200B_bqg7</w:t></w:r>'
      + '<w:r><w:rPr><w:vanish/></w:rPr><w:t>\u200B_lic:bullet:1:1</w:t></w:r>'
      + '<w:r><w:t>Quoted line</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);

    expect(result.markdown).not.toContain('_bqg');
    expect(result.markdown).not.toContain('_lic:');
    expect(result.markdown).not.toContain('_lim:');
    expect(result.markdown).toContain('List item');
    expect(result.markdown).toContain('Quoted line');
  });
});

describe('Comments over equations', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;

  test.each([
    ['an equation', 'A {==$x$==}{>>@A (2024-01-15 10:30) | c<<} z.\n'],
    ['an equation between words', 'A {==before $x$ after==}{>>@A (2024-01-15 10:30) | c<<} z.\n'],
    ['two equations', 'A {==$x$ and $y$==}{>>@A (2024-01-15 10:30) | c<<} z.\n'],
    ['an equation between formatted words', 'A {==**b** $x$ *i*==}{>>@A (2024-01-15 10:30) | c<<} z.\n'],
    ['an inserted equation', 'A {==t {++$y$++}==}{>>@A (2024-01-15 10:30) | c<<}.\n'],
    ['an equation in a heading', '# H {==$x$==}{>>@A (2024-01-15 10:30) | c<<}\n'],
    ['an equation in a table cell', '| a | b |\n| --- | --- |\n| {==$x$==}{>>@A (2024-01-15 10:30) \\| c<<} | 2 |\n'],
    ['an equation in bold text', 'A {==**b $x$ c**==}{>>@A (2024-01-15 10:30) | c<<} z.\n'],
    ['an equation in italic text', 'A {==*i $x$*==}{>>@A (2024-01-15 10:30) | c<<} z.\n'],
    ['an equation in a footnote', 'Text.[^1]\n\n[^1]: A {==$x$==}{>>@A (2024-01-15 10:30) | c<<} z.\n'],
    ['an equation between words in a footnote', 'Text.[^1]\n\n[^1]: A {==before $x$ after==}{>>@A (2024-01-15 10:30) | c<<} z.\n'],
  ])('keeps a comment over %s', async (_name, md) => {
    // The equation came out of the range, splitting the comment in two, or
    // the comment went missing
    expect(await roundTrip(md)).toBe(md);
  });

  test('writes a comment over text with ==} in ID syntax', async () => {
    // Where {==...==} would end at the text's ==}
    const markdown = await roundTrip('A {==x \\=\\=} y==}{>>@A (2024-01-15 10:30) | c<<} z.');
    expect(markdown).toBe('A {#1}x ==} y{/1} z.\n{#1>>@A (2024-01-15 10:30) | c<<}\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['the body', 'A {==x \\=\\=} y==}{>>@A (2024-01-15 10:30) | c<<} z.', 'A {#1}x ==} y{/1} z.\n{#1>>@A (2024-01-15 10:30) | c<<}\n'],
    ['a footnote', 'Text.[^1]\n\n[^1]: A {==x \\=\\=} y==}{>>@A (2024-01-15 10:30) | c<<} z.',
      'Text.[^1]\n\n[^1]: A {#1}x ==} y{/1} z.\n    {#1>>@A (2024-01-15 10:30) | c<<}\n'],
    ['a table cell', '| a | b |\n| --- | --- |\n| {==x \\=\\=} y==}{>>@A (2024-01-15 10:30) \\| c<<} | 2 |',
      '| a | b |\n| --- | --- |\n| {#1}x ==} y{/1} | 2 |\n\n{#1>>@A (2024-01-15 10:30) | c<<}\n'],
  ])('writes a comment over ==} split between runs in %s in ID syntax', async (_name, md, expected) => {
    // Word splits text into runs anywhere, and neither run held all of ==}
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    for (const part of ['word/document.xml', 'word/footnotes.xml']) {
      const xml = await zip.file(part)?.async('string');
      if (xml === undefined) continue;
      zip.file(part, xml.replace(/(<w:r>(?:<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?)<w:t([^>]*)>x ==\} y<\/w:t><\/w:r>/,
        (_match, run: string, attrs: string) => run + '<w:t' + attrs + '>x ==</w:t></w:r>' + run + '<w:t' + attrs + '>} y</w:t></w:r>'));
    }
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe(expected);
  });

  test('writes a comment over text with ==} in a footnote in ID syntax', async () => {
    const markdown = await roundTrip('Text.[^1]\n\n[^1]: A {==x \\=\\=} y==}{>>@A (2024-01-15 10:30) | c<<} z.');
    expect(markdown).toBe('Text.[^1]\n\n[^1]: A {#1}x ==} y{/1} z.\n    {#1>>@A (2024-01-15 10:30) | c<<}\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps bold text around an equation in a comment in ID syntax', () => {
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    const bold = { ...DEFAULT_FORMATTING, bold: true };
    const markdown = buildMarkdown([
      { type: 'text', text: 'b ', commentIds: new Set(['0']), formatting: bold },
      { type: 'math', latex: '\\text{a ==}', display: false, commentIds: new Set(['0']) },
      { type: 'text', text: ' c', commentIds: new Set(['0']), formatting: bold },
    ], comments);
    expect(markdown).toBe('{#1}**b $\\text{a ==}$ c**{/1}\n{#1>>@A | c<<}');
  });

  test.each([
    ['an equation', { type: 'math', latex: 'x', display: false, commentIds: new Set(['0']) }, '$x$'],
    ['text', { type: 'text', text: 'b', commentIds: new Set(['0']), formatting: DEFAULT_FORMATTING }, 'b'],
  ])('writes a comment over %s and an image in one anchor', (_name, first, markdown) => {
    // The anchor couldn't hold the image, and both got a copy of the comment
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    expect(buildMarkdown([
      first,
      { type: 'image', rId: 'rId9', src: 'media/a.png', alt: '', widthPx: 10, heightPx: 10, commentIds: new Set(['0']) },
    ] as ContentItem[], comments)).toBe('{==' + markdown + '![](media/a.png){width=10 height=10}==}{>>@A | c<<}');
  });

  test.each([
    ['', [], '{==![](media/a.png){width=10 height=10}==}{>>@A | c<<}'],
    [' between text', [['a ', false], [' b', false]], 'a {==![](media/a.png){width=10 height=10}==}{>>@A | c<<} b'],
    [' and text after it', [['a ', false], [' b', true]], 'a {==![](media/a.png){width=10 height=10} b==}{>>@A | c<<}'],
  ] as Array<[string, Array<[string, boolean]>, string]>)('writes a comment over an image%s in an anchor', (_name, around, expected) => {
    // A comment over only an image had no range
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    const text = ([value, commented]: [string, boolean]) =>
      ({ type: 'text', text: value, commentIds: new Set(commented ? ['0'] : []), formatting: DEFAULT_FORMATTING });
    expect(buildMarkdown([
      ...around.slice(0, 1).map(text),
      { type: 'image', rId: 'rId9', src: 'media/a.png', alt: '', widthPx: 10, heightPx: 10, commentIds: new Set(['0']) },
      ...around.slice(1).map(text),
    ] as ContentItem[], comments)).toBe(expected);
  });

  test.each([
    ['alt text', { alt: 'a==}b' }, '![a==}b](media/a.png){width=10 height=10}'],
    ['path', { src: 'media/a==}.png' }, '![](media/a==}.png){width=10 height=10}'],
    ['Markdown', { markdown: '![](x==}.png)' }, '![](x==}.png)'],
  ])('writes a comment over an image with ==} in its %s in ID syntax', (_name, image, markdown) => {
    // The ==} ended the {==...==} around the image
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    expect(buildMarkdown([
      { type: 'image', rId: 'rId9', src: 'media/a.png', alt: '', widthPx: 10, heightPx: 10, commentIds: new Set(['0']), ...image },
    ] as ContentItem[], comments)).toBe('{#1}' + markdown + '{/1}\n{#1>>@A | c<<}');
  });

  test('writes a comment over ==} in ID syntax in every paragraph it spans', () => {
    // Not in the one paragraph with ==} alone, which made two comments of it
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    const markdown = buildMarkdown([
      { type: 'text', text: 'a', commentIds: new Set(['0']), formatting: DEFAULT_FORMATTING },
      { type: 'para' },
      { type: 'text', text: 'b ==} c', commentIds: new Set(['0']), formatting: DEFAULT_FORMATTING },
    ] as ContentItem[], comments);
    expect(markdown).not.toContain('{==');
    expect(markdown.match(/@A \| c/g)).toHaveLength(1);
  });

  test('writes a comment over an equation with ==} in ID syntax', () => {
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    const markdown = buildMarkdown([
      { type: 'text', text: 'A ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'math', latex: '\\text{a ==}', display: false, commentIds: new Set(['0']) },
    ], comments);
    expect(markdown).toBe('A {#1}$\\text{a ==}${/1}\n{#1>>@A | c<<}');
  });
});

describe('Comments across paragraphs', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
  const body = (id: number, text: string) => '{#' + id + '>>@A (2024-01-15 10:30) | ' + text + '<<}';
  const MATH_FENCE = '$' + '$';

  test.each([
    ['two paragraphs', '{#1}First para\n\nsecond{/1} para.\n' + body(1, 'spans') + '\n'],
    ['three paragraphs', 'A {#1}b\n\nc\n\nd{/1} e.\n' + body(1, 'three') + '\n'],
    ['a heading and a paragraph', '# {#1}Head\n\nbody{/1} rest.\n' + body(1, 'h') + '\n'],
    ['list items', '- {#1}one\n- two{/1} x\n' + body(1, 'l') + '\n'],
    ['quoted paragraphs', '> {#1}q1\n>\n> q2{/1} z\n> ' + body(1, 'q') + '\n'],
    ['an equation between paragraphs', '{#1}A\n\n' + MATH_FENCE + '\nx\n' + MATH_FENCE + '\n\nB{/1}\n' + body(1, 'm') + '\n'],
    ['a code block between paragraphs', '{#1}A\n\n```\ncode\n```\n\nB{/1}\n' + body(1, 'c') + '\n'],
    ['another comment it overlaps', '{#1}A {#2}b\n\nc{/1} d{/2}.\n' + body(1, 'one') + '\n' + body(2, 'two') + '\n'],
    ['paragraphs in a footnote', 'Text.[^1]\n\n[^1]: x {#1}A\n\n    B\n\n    C{/1} c.\n    ' + body(1, 'n') + '\n'],
    ['paragraphs in the body and in a footnote', '{#1}P1\n\nP2{/1}.[^1]\n' + body(1, 'b') + '\n\n[^1]: {#2}A\n\n    B{/2} c.\n    ' + body(2, 'n') + '\n'],
  ])('keeps one comment over %s', async (_name, md) => {
    // Each paragraph got a copy of the comment, which export made into a comment each
    expect(await roundTrip(md)).toBe(md);
  });

  test('keeps a range open around a table whose cells have comments of their own', () => {
    // A cell's comments in ID syntax closed it in the cell, and it opened again after
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }], ['1', { author: 'B', text: 'd', date: '' }], ['2', { author: 'C', text: 'e', date: '' }]]);
    const text = (t: string, ids: string[]) => ({ type: 'text', text: t, commentIds: new Set(ids), formatting: DEFAULT_FORMATTING });
    const markdown = buildMarkdown([
      text('P1', ['0']),
      { type: 'para' },
      { type: 'table', rows: [{ cells: [{ paragraphs: [[text('x ', ['1']), text('y', ['1', '2']), text(' z', ['2'])]] }] }] },
      { type: 'para' },
      text('P2', ['0']),
    ] as ContentItem[], comments);
    expect(markdown).toBe('{#1}P1\n\n| {#2}x {#3}y{/2} z{/3} |\n| --- |\n\n{#2>>@B | d<<}\n{#3>>@C | e<<}\n\nP2{/1}\n{#1>>@A | c<<}');
  });

  test('closes a range that ends in a code block in the text before it', () => {
    // A code block can't hold an ID marker, so the range ended nowhere, without its body
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    const markdown = buildMarkdown([
      { type: 'text', text: 'A ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'text', text: 'b', commentIds: new Set(['0']), formatting: DEFAULT_FORMATTING },
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: 'code', commentIds: new Set(['0']), formatting: DEFAULT_FORMATTING },
    ] as ContentItem[], comments);
    expect(markdown).toContain('A {==b==}{>>@A | c<<}');
  });
});

describe('Comments over display equations', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
  const body = (id: number, text: string) => '{#' + id + '>>@A (2024-01-15 10:30) | ' + text + '<<}';
  const MATH_FENCE = '$' + '$';
  const equation = MATH_FENCE + '\nx\n' + MATH_FENCE;

  test.each([
    ['an equation alone', 'A.\n\n{#1}' + equation + '{/1}\n' + body(1, 'c') + '\n\nB.\n'],
    ['text and the equation after it', '{#1}A\n\n' + equation + '{/1}\n' + body(1, 'c') + '\n\nB.\n'],
    ['an equation and the text after it', 'A.\n\n{#1}' + equation + '\n\nB{/1}\n' + body(1, 'c') + '\n'],
    ['an equation in a footnote', 'Text.[^1]\n\n[^1]: A.\n\n    {#1}' + MATH_FENCE + '\n    x\n    ' + MATH_FENCE + '{/1}\n    ' + body(1, 'n') + '\n'],
    ['an equation in a quote', '> A.\n>\n> {#1}' + MATH_FENCE + '\n> x\n> ' + MATH_FENCE + '{/1}\n> ' + body(1, 'q') + '\n'],
  ])('keeps a comment over %s', async (_name, md) => {
    // An equation couldn't hold the comment's markers, so a comment over it
    // alone went missing
    expect(await roundTrip(md)).toBe(md);
  });

  test('writes a comment over text and the equation after it in its paragraph in ID syntax', () => {
    // Word keeps both in one paragraph; Markdown has two blocks
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    const markdown = buildMarkdown([
      { type: 'text', text: 'A ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'text', text: 'b', commentIds: new Set(['0']), formatting: DEFAULT_FORMATTING },
      { type: 'math', latex: 'x', display: true, commentIds: new Set(['0']) },
    ] as ContentItem[], comments);
    expect(markdown).toBe('A {#1}b\n\n' + equation + '{/1}\n{#1>>@A | c<<}');
  });

  test('puts the body after text that follows the equation in its paragraph', () => {
    // The body went between the closing fence and the text, which gained a
    // space before it on the next round trip
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    const markdown = buildMarkdown([
      { type: 'math', latex: 'x', display: true, commentIds: new Set(['0']) },
      { type: 'text', text: 'B', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
    ] as ContentItem[], comments);
    expect(markdown).toBe('{#1}' + equation + '{/1}B\n{#1>>@A | c<<}');
  });
});

describe('Comments with more than one line', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  const body = (text: string) => '{>>@A (2024-01-15 10:30) | ' + text + '<<}';

  test.each([
    ['two paragraphs', 'A {==b==}' + body('one\n\ntwo') + ' c.'],
    ['a line break', 'A {==b==}' + body('one\ntwo') + ' c.'],
    ['two paragraphs in a list item', '- A {==b==}' + body('one\n\ntwo') + ' c.\n- d'],
    ['a line break in a quote', '> A {==b==}' + body('one\n> two') + ' c.'],
    ['two paragraphs in a quote', '> A {==b==}' + body('one\n>\n> two') + ' c.'],
    ['a line break in an alert in a list', '1. item\n\n   > [!NOTE]\n   > A {==b==}' + body('one\n   > two') + ' c.'],
    ['an empty first paragraph', 'A {==b==}' + body('\n\ntwo') + ' c.'],
    ['spaces at its start', 'A {==b==}' + body('  two') + ' c.'],
    ['two paragraphs in a table cell', '| h |\n| --- |\n| {#1}b{/1} |\n\n{#1>>@A (2024-01-15 10:30) | one\n\ntwo<<}'],
    ['a reply in a table cell', '| h |\n| --- |\n| {#1}b{/1} |\n\n{#1>>@A (2024-01-15 10:30) | one\n  {>>@B (2024-01-15 10:31) | two<<}\n<<}'],
  ])('keeps a comment with %s', async (_name, md) => {
    // Import joined the comment's paragraphs with nothing between them, and
    // export wrote a line's end into the text, where Word writes a break.
    // In a quote, the body's next line lacked the quote's prefix; in a table
    // cell, which can't hold a line's end, the table became HTML, where the
    // comment was text; and export took a blank line, or more than one
    // space, after | as the space before the text
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['a quote', '> A\\\n> b'],
    ['an alert', '> [!NOTE]\n> A\\\n> b\\\n> c'],
  ])('keeps the prefix of a line after a line break in %s', async (_name, md) => {
    expect(await roundTrip(md)).toBe(md);
  });

  test('writes the body of a comment with paragraphs in an HTML table after the table', async () => {
    // A blank line in the body ended the table's HTML; a cell of a table
    // only HTML holds, as with merged cells, writes the comment as text
    const md = '<table>\n  <tr>\n    <td colspan="2">h</td>\n  </tr>\n  <tr>\n    <td>XX</td>\n    <td>y</td>\n  </tr>\n</table>\n\nA {==b==}' + body('one\n\ntwo') + ' c.';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    let xml = await zip.file('word/document.xml')!.async('string');
    const start = '<w:commentRangeStart w:id="0"/>';
    const end = /<w:commentRangeEnd w:id="0"\/>(<w:r>(?:(?!<\/w:r>).)*?<w:commentReference w:id="0"\/><\/w:r>)/.exec(xml)!;
    xml = xml.replace(start, '').replace(end[0], '')
      .replace(/<w:r>(?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>/, run => start + run + '<w:commentRangeEnd w:id="0"/>' + end[1]);
    zip.file('word/document.xml', xml);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    const table = markdown.slice(0, markdown.indexOf('</table>'));
    expect(table).toContain('{#1}XX{/1}');
    expect(table).not.toContain('\n\n');
    expect(markdown.slice(table.length)).toBe('</table>\n\n{#1>>@A (2024-01-15 10:30) | one\n\ntwo<<}\n\nA b c.');
  });

  test('writes a comment whose text starts with a break in ID syntax', async () => {
    // After {==b==}, export took the {>> before the break for an opener at
    // a line's end, and moved the body to a paragraph of its own
    const md = 'A {#1}b{/1} c.\n{#1>>\n\ntwo<<}';
    expect(await roundTrip(md)).toBe(md);
  });

  test('writes a reply whose text starts with a break on a line of its own', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('A {==b==}' + body('one') + '{>>@B (2024-01-15 10:31) | two<<} c.')).docx);
    const xml = await zip.file('word/comments.xml')!.async('string');
    const edited = xml.replace('w:author="B" w:initials="B"', 'w:author="" w:initials=""')
      .replace('<w:t>two</w:t></w:r></w:p>', '</w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p>');
    expect(edited).not.toBe(xml);
    zip.file('word/comments.xml', edited);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('A {==b==}{>>@A (2024-01-15 10:30) | one\n  {>>\n\ntwo<<}\n<<} c.');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps the text of a comment with paragraphs in a list item', async () => {
    const { docx } = await convertMdToDocx('- A {==b==}' + body('one\n\ntwo') + ' c.');
    expect([...(await extractComments(docx)).values()].map(c => c.text)).toEqual(['one\n\ntwo']);
  });

  test('leaves out a page break and deleted text in a comment', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('A {==b==}' + body('one') + ' c.')).docx);
    const xml = await zip.file('word/comments.xml')!.async('string');
    const edited = xml.replace('<w:t>one</w:t></w:r>', '<w:t>one</w:t><w:br w:type="page"/><w:t>two</w:t></w:r>'
      + '<w:del w:id="9" w:author="A" w:date="2024-01-15T10:30:00Z"><w:r><w:br/><w:delText>gone</w:delText></w:r></w:del>');
    expect(edited).not.toBe(xml);
    zip.file('word/comments.xml', edited);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('A {==b==}' + body('onetwo') + ' c.');
  });

  test('joins a comment\'s paragraph whose mark is deleted to the next', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('A {==b==}' + body('one\n\ntwo') + ' c.')).docx);
    const xml = await zip.file('word/comments.xml')!.async('string');
    const edited = xml.replace(/(<w:p>)(<w:r><w:rPr><w:rStyle w:val="CommentReference"\/>)/,
      '$1<w:pPr><w:rPr><w:del w:id="9" w:author="A" w:date="2024-01-15T10:30:00Z"/></w:rPr></w:pPr>$2');
    expect(edited).not.toBe(xml);
    zip.file('word/comments.xml', edited);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('A {==b==}' + body('onetwo') + ' c.');
  });

  test('writes a comment\'s paragraphs and line breaks as Word does', async () => {
    const { docx } = await convertMdToDocx('A {==b==}' + body('one\ntwo\n\nthree') + ' c.');
    const xml = await (await JSZip.loadAsync(docx)).file('word/comments.xml')!.async('string');
    expect(xml).toContain('<w:t>one</w:t><w:br/><w:t>two</w:t></w:r></w:p>');
    expect(xml).toContain('<w:r><w:t>three</w:t></w:r></w:p>');
  });
});

describe('Dateless comment round-trip', () => {
  test('standalone comment without date round-trips without gaining a date', async () => {
    const md = 'Some text.\n\n{>>This is a comment without a date<<}';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('{>>');
    expect(result.markdown).toContain('{>>This is a comment without a date<<}');
    // Should NOT contain a parenthesized date like (2026-02-25 23:12)
    expect(result.markdown).not.toMatch(/\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/);
  });
});

describe('Tab-after-marker list round-trip', () => {
  test('dash-tab list items round-trip with tabs', async () => {
    const md = '-\tItem one\n-\tItem two\n-\tItem three';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('-\tItem one');
    expect(result.markdown).toContain('-\tItem two');
  });
});

describe('Ordered list counter continuation after nested bullets', () => {
  test('counter resumes after nested bullet sub-list', async () => {
    const md = '1. A\n2. B\n   - X\n   - Y\n3. C';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    // The ordered list must continue at 3 after returning from the nested bullets
    expect(result.markdown).toMatch(/3\.\s+C/);
  });
});

describe('HTML comment blank line round-trip', () => {
  test('blank lines before HTML comment are preserved', async () => {
    const md = 'Paragraph one.\n\n\n\n<!-- A comment -->\n\nParagraph two.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    // Should have 3 blank lines (4 newlines) before the comment, not 1
    expect(result.markdown).toContain('Paragraph one.\n\n\n\n<!-- A comment -->');
  });

  test('zero extra blank lines before HTML comment are preserved', async () => {
    const md = 'Paragraph one.\n\n<!-- A comment -->\n\nParagraph two.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    // Default 1 blank line preserved
    expect(result.markdown).toContain('Paragraph one.\n\n<!-- A comment -->');
    // Should NOT have extra blank lines
    expect(result.markdown).not.toContain('Paragraph one.\n\n\n<!-- A comment -->');
  });

  test('tight comment before grid table preserves zero-gap spacing', async () => {
    const md = '<!-- portrait -->\n## Table 1\n\nParagraph text\n<!-- Begin Table 1 -->\n+---+---+\n| A | B |\n+===+===+\n| 1 | 2 |\n+---+---+';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    // 0 blank lines before comment (tight against paragraph)
    expect(result.markdown).toContain('Paragraph text\n<!-- Begin Table 1 -->');
    expect(result.markdown).not.toContain('Paragraph text\n\n<!-- Begin Table 1 -->');
    // 0 blank lines after comment (tight against grid table)
    expect(result.markdown).toContain('<!-- Begin Table 1 -->\n+');
    expect(result.markdown).not.toContain('<!-- Begin Table 1 -->\n\n+');
  });

  test('tight comment after-gap (0 blank lines after comment)', async () => {
    const md = '<!-- comment -->\nNext paragraph.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- comment -->\nNext paragraph');
    expect(result.markdown).not.toContain('<!-- comment -->\n\nNext paragraph');
  });

  test('default comment after-gap (1 blank line) is preserved', async () => {
    const md = '<!-- comment -->\n\nNext paragraph.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- comment -->\n\nNext paragraph');
    expect(result.markdown).not.toContain('<!-- comment -->\n\n\nNext paragraph');
  });

  test('duplicate single-line comments get correct gaps', async () => {
    const md = '<!-- note -->\nText\n\n\n<!-- note -->\n\nMore';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    // First comment: 0 gap after (tight against Text)
    expect(result.markdown).toContain('<!-- note -->\nText');
    expect(result.markdown).not.toContain('<!-- note -->\n\nText');
    // Second comment: default 1 blank line gap after
    expect(result.markdown).toContain('<!-- note -->\n\nMore');
    expect(result.markdown).not.toContain('<!-- note -->\n\n\nMore');
  });

  test('multi-line comment gap preservation', async () => {
    const md = 'Before\n<!--\nmulti\n-->\nAfter';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    // Tight gaps (0 blank lines) before and after
    expect(result.markdown).toContain('Before\n<!--\nmulti\n-->\nAfter');
    expect(result.markdown).not.toContain('Before\n\n<!--');
    expect(result.markdown).not.toContain('-->\n\nAfter');
  });

  test('multiline HTML comments preserve internal newlines', async () => {
    const md = 'Before\n\n<!--\n\nLine one\n\nLine two\n\n-->\n\nAfter';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    // Export should encode internal line breaks explicitly for hidden comment runs.
    expect(documentXml).toContain('<w:vanish/>');

    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!--\n\nLine one\n\nLine two\n\n-->');
  });

  test('hidden html comment runs with w:br are reconstructed with newlines', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>Before</w:t></w:r></w:p>'
      + '<w:p><w:r><w:rPr><w:vanish/></w:rPr>'
      + '<w:t xml:space=\"preserve\">\u200B&lt;!--</w:t>'
      + '<w:br/>'
      + '<w:br/>'
      + '<w:t xml:space=\"preserve\">Line one</w:t>'
      + '<w:br/>'
      + '<w:br/>'
      + '<w:t xml:space=\"preserve\">Line two</w:t>'
      + '<w:br/>'
      + '<w:br/>'
      + '<w:t xml:space=\"preserve\">--&gt;</w:t>'
      + '</w:r></w:p>'
      + '<w:p><w:r><w:t>After</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('<!--\n\nLine one\n\nLine two\n\n-->');
  });

  test('Word-split hidden HTML comment runs are reassembled', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>Before</w:t></w:r></w:p>'
      + '<w:p>'
      + '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">\u200B</w:t></w:r>'
      + '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">&lt;!--</w:t></w:r>'
      + '<w:r><w:rPr><w:vanish/></w:rPr><w:br/></w:r>'
      + '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">Line one</w:t><w:br/></w:r>'
      + '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">--&gt;</w:t></w:r>'
      + '</w:p>'
      + '<w:p><w:r><w:t>After</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('<!--\nLine one\n-->');
  });

  test.each([
    ['a quote', '> a\n>\n> <!-- c -->\n>\n> b'],
    ['a quote alone', '> <!-- c -->'],
    ['a quote in a list item', '- a\n\n  > <!-- c -->'],
    ['a heading', '# <!-- c -->'],
    ['a quote, before one with blank lines before it', '> <!-- c -->\n\nA.\n\n\n<!-- d -->\n\nB.'],
  ])('keeps one that starts a paragraph in %s', async (_name, md) => {
    // Import wrote it as a comment of its own, on a line after a blank
    // line, out of the quote or heading, and took the blank lines export
    // keeps for the next one of its own as its
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
    expect(markdown).toBe(md + '\n');
  });
});

describe('Sentinel gap round-trip', () => {
  test.each([
    ['a landscape section', '<!-- landscape -->\n\nWide.\n\n<!-- /landscape -->\n\nAfter.\n'],
    ['a tight landscape section', '<!-- landscape -->\nWide.\n<!-- /landscape -->\n'],
    ['a style block', '<!-- style: quote -->\nQuoted.\n<!-- /style -->\n\nAfter.\n'],
    ['a landscape section after frontmatter', '---\ntitle: T\n---\n\n<!-- landscape -->\n\nWide.\n\n<!-- /landscape -->\n\nAfter.\n'],
    ['a landscape section right after frontmatter', '---\ntitle: T\n---\n<!-- landscape -->\n\nWide.\n\n<!-- /landscape -->\n'],
    ['a style block after frontmatter', '---\ntitle: T\n---\n\n<!-- style: quote -->\nQuoted.\n<!-- /style -->\n\nAfter.\n'],
  ])('puts no blank lines before %s that starts the document', async (_name, md) => {
    // They grew by one or more with each round trip
    let markdown = md;
    for (let i = 0; i < 2; i++) markdown = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(markdown).toBe(md);
  });

  test('keeps a section after a paragraph of whitespace on a line of its own', async () => {
    const md = '&nbsp;\n\n<!-- landscape -->\n\nWide.\n\n<!-- /landscape -->\n';
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
    expect(markdown).toBe(md);
  });

  test('portrait sentinel with no blank line after opening', async () => {
    const md = 'Before.\n\n<!-- portrait -->\n## Table 1\n\nSome text.\n\n<!-- /portrait -->\n\nAfter.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- portrait -->\n## Table 1');
    expect(result.markdown).not.toContain('<!-- portrait -->\n\n## Table 1');
  });

  test('portrait sentinel with blank line after opening', async () => {
    const md = 'Before.\n\n<!-- portrait -->\n\n## Table 1\n\nSome text.\n\n<!-- /portrait -->\n\nAfter.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- portrait -->\n\n## Table 1');
    expect(result.markdown).not.toContain('<!-- portrait -->\n\n\n## Table 1');
  });

  test('tight /portrait before-gap (no blank line before close)', async () => {
    const md = 'Before.\n\n<!-- portrait -->\n\nSome text.\n<!-- /portrait -->\n\nAfter.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('Some text.\n<!-- /portrait -->');
    expect(result.markdown).not.toContain('Some text.\n\n<!-- /portrait -->');
  });

  test('blank line before /portrait', async () => {
    const md = 'Before.\n\n<!-- portrait -->\n\nSome text.\n\n<!-- /portrait -->\n\nAfter.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('Some text.\n\n<!-- /portrait -->');
    expect(result.markdown).not.toContain('Some text.\n\n\n<!-- /portrait -->');
  });

  test('tight consecutive portrait close then open', async () => {
    const md = 'Before.\n\n<!-- portrait -->\n\nFirst section.\n\n<!-- /portrait -->\n<!-- portrait -->\n\nSecond section.\n\n<!-- /portrait -->\n\nAfter.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- /portrait -->\n<!-- portrait -->');
    expect(result.markdown).not.toContain('<!-- /portrait -->\n\n<!-- portrait -->');
  });

  test('blank line between portrait close and open', async () => {
    const md = 'Before.\n\n<!-- portrait -->\n\nFirst section.\n\n<!-- /portrait -->\n\n<!-- portrait -->\n\nSecond section.\n\n<!-- /portrait -->\n\nAfter.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- /portrait -->\n\n<!-- portrait -->');
    expect(result.markdown).not.toContain('<!-- /portrait -->\n\n\n<!-- portrait -->');
  });

  test('landscape sentinel gaps preserved', async () => {
    const md = 'Before.\n\n<!-- landscape -->\n## Wide Table\n\nContent.\n<!-- /landscape -->\n\nAfter.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- landscape -->\n## Wide Table');
    expect(result.markdown).toContain('Content.\n<!-- /landscape -->');
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

  test('ignores empty author records before a valid author', async () => {
    const cslPayload = JSON.stringify({
      citationItems: [{
        itemData: {
          type: 'article-journal',
          title: 'Useful Study',
          author: [{}, { family: 'Smith', given: 'Alice' }],
          issued: { 'date-parts': [[2020]] },
        },
      }],
      properties: { plainCitation: '(Smith 2020)' },
    });
    const xml = wrapDocumentXml(
      '<w:p>'
      + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
      + '<w:r><w:instrText> ADDIN ZOTERO_ITEM CSL_CITATION '
      + cslPayload
      + '</w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
      + '</w:p>'
    );
    const citations = await extractZoteroCitations(await buildSyntheticDocx(xml));

    expect(citations[0].items[0].authors).toEqual([{ family: 'Smith', given: 'Alice' }]);
    expect([...buildCitationKeyMap(citations).values()]).toEqual(['smith2020useful']);
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
      expect(citItems[0].pandocKeys).toContain('@smith2020effects, p. 15');
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
    expect(result.markdown).toBe('**Bold** Plain\n');
  });

  test('run boundary hoists trailing whitespace outside italic delimiters', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file('word/document.xml', `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:rPr><w:i/></w:rPr>
        <w:t>Italic </w:t>
      </w:r>
      <w:r><w:t>Plain</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`);
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const result = await convertDocx(buf);
    expect(result.markdown).toBe('*Italic* Plain\n');
  });

  test('run boundary hoists trailing whitespace outside strikethrough delimiters', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file('word/document.xml', `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:rPr><w:strike/></w:rPr>
        <w:t>Strike </w:t>
      </w:r>
      <w:r><w:t>Plain</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`);
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const result = await convertDocx(buf);
    expect(result.markdown).toBe('~~Strike~~ Plain\n');
  });

  test('run boundary hoists trailing whitespace outside highlight delimiters', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file('word/document.xml', `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:rPr><w:highlight w:val="green"/></w:rPr>
        <w:t>Mark </w:t>
      </w:r>
      <w:r><w:t>Plain</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`);
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const result = await convertDocx(buf);
    expect(result.markdown).toBe('==Mark=={green} Plain\n');
  });
});

describe('convertDocx (end-to-end)', () => {
  test('produces expected markdown', async () => {
    const result = await convertDocx(sampleData);
    const expectedMdLocal = expectedMd
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
  test('moves edge whitespace outside delimiter-based formatting markers', () => {
    expect(wrapWithFormatting('Bold ', { ...DEFAULT_FORMATTING, bold: true })).toBe('**Bold** ');
    expect(wrapWithFormatting(' Bold', { ...DEFAULT_FORMATTING, italic: true })).toBe(' *Bold*');
    expect(wrapWithFormatting(' Bold ', { ...DEFAULT_FORMATTING, bold: true, italic: true })).toBe(' ***Bold*** ');
    expect(wrapWithFormatting('Strike ', { ...DEFAULT_FORMATTING, strikethrough: true })).toBe('~~Strike~~ ');
    expect(wrapWithFormatting(' Mark ', { ...DEFAULT_FORMATTING, highlight: true })).toBe(' ==Mark== ');
    expect(wrapWithFormatting(' Mark ', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'green' })).toBe(' ==Mark=={green} ');
    expect(wrapWithFormatting('   ', { ...DEFAULT_FORMATTING, bold: true })).toBe('   ');
    expect(wrapWithFormatting('   ', { ...DEFAULT_FORMATTING, strikethrough: true })).toBe('   ');
    expect(wrapWithFormatting('   ', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'green' })).toBe('   ');
  });

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

          if ((formatType === 'bold' || formatType === 'italic' || formatType === 'strikethrough' || formatType === 'highlight') && text.trim().length === 0) {
            expect(result).toBe(text);
            return;
          }

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
          if (formatType === 'bold' || formatType === 'italic' || formatType === 'strikethrough' || formatType === 'highlight') {
            expect(result).toMatch(new RegExp(`^\\s*${escapeForRegex(open)}`));
            expect(result).toMatch(new RegExp(`${escapeForRegex(close)}\\s*$`));
          } else {
            expect(result.startsWith(open)).toBe(true);
            expect(result.endsWith(close)).toBe(true);
          }
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

          if (
            !fmt.code
            && text.trim().length === 0
            && (fmt.bold || fmt.italic || fmt.strikethrough || fmt.highlight)
            && !fmt.underline
            && !fmt.superscript
            && !fmt.subscript
          ) {
            expect(result).toBe(text);
            return;
          }

          // When code is true, other formatting is stripped, except a
          // highlight around the backtick fence, which an == in it would close
          if (fmt.code) {
            expect(result).toMatch(fmt.highlight && !text.includes('==') ? /^==`[\s\S]*`==$/ : /^`[\s\S]*`$/);
            return;
          }

          // Check nesting order without assuming wrappers begin at column 0,
          // because delimiter-based formatting hoists edge whitespace outward.
          const openTokens = [];
          const closeTokens = [];
          if (fmt.bold && result.includes('**')) {
            openTokens.push('**');
            closeTokens.unshift('**');
          }
          if (fmt.italic && result.includes('*')) {
            openTokens.push('*');
            closeTokens.unshift('*');
          }
          if (fmt.strikethrough && result.includes('~~')) {
            openTokens.push('~~');
            closeTokens.unshift('~~');
          }
          if (fmt.underline && result.includes('<u>')) {
            openTokens.push('<u>');
            closeTokens.unshift('</u>');
          }
          if (fmt.highlight && result.includes('==')) {
            openTokens.push('==');
            closeTokens.unshift('==');
          }
          if (fmt.superscript && result.includes('<sup>')) {
            openTokens.push('<sup>');
            closeTokens.unshift('</sup>');
          } else if (fmt.subscript && result.includes('<sub>')) {
            openTokens.push('<sub>');
            closeTokens.unshift('</sub>');
          }

          let fromStart = 0;
          for (const token of openTokens) {
            const index = result.indexOf(token, fromStart);
            expect(index).toBeGreaterThanOrEqual(0);
            fromStart = index + token.length;
          }

          let closeSearchFrom = fromStart;
          for (const token of closeTokens) {
            const index = result.indexOf(token, closeSearchFrom);
            expect(index).toBeGreaterThanOrEqual(0);
            closeSearchFrom = index + token.length;
          }
        }
      ),
      { numRuns: 100 }
    );
  });

});

describe('Emphasis between runs', () => {
  const run = (text: string, formatting: Partial<RunFormatting> = {}): ContentItem =>
    ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting } });
  const FORMATS = ['bold', 'italic', 'strikethrough', 'underline', 'superscript', 'highlight', 'code'] as const;
  // Each character's text and formats, as Markdown reads them back
  const characters = (markdown: string) => parseMd(markdown).flatMap(token => token.runs ?? [])
    .flatMap(r => [...r.text].map(c => c + ':' + FORMATS.filter(f => r[f]).join('+')));
  // ...and as the runs have them
  const expectedCharacters = (items: ContentItem[]) => items
    .flatMap(item => item.type === 'text' ? [...item.text].map(c => c + ':' + FORMATS.filter(f => item.formatting[f]).join('+')) : []);

  test.each([
    ['bold starting with punctuation after a letter', [run('a'), run('.b', { bold: true })], 'a<b>.b</b>'],
    ['italic ending with punctuation before a letter', [run('a.', { italic: true }), run('b')], '<i>a.</i>b'],
    ['bold italic ending with punctuation before a digit', [run('--', { bold: true, italic: true }), run('1a')], '<b>*--*</b>1a'],
    ['italic before bold', [run('a', { italic: true }), run('b', { bold: true })], '*a*<b>b</b>'],
    ['bold before bold italic', [run('x', { bold: true }), run('y', { bold: true, italic: true })], '**x**<b>*y*</b>'],
    ['bold underline after a letter', [run('a'), run('b', { bold: true, underline: true })], 'a<b><u>b</u></b>'],
    ['strikethrough superscript after a letter', [run('a'), run('b', { strikethrough: true, superscript: true })], 'a<s><sup>b</sup></s>'],
  ])('writes %s as HTML', (_name, items, markdown) => {
    const written = buildMarkdown(items, new Map());
    expect(written).toBe(markdown);
    expect(characters(written)).toEqual(expectedCharacters(items));
  });

  test.each([
    ['bold after a letter', [run('a'), run('b', { bold: true })], 'a**b**'],
    ['bold ending with punctuation before a space', [run('Note:', { bold: true }), run(' text')], '**Note:** text'],
    ['bold italic after a letter', [run('a'), run('b', { bold: true, italic: true })], 'a***b***'],
    ['strikethrough before bold strikethrough', [run('a', { strikethrough: true }), run('b', { bold: true, strikethrough: true })], '~~a~~**~~b~~**'],
    ['bold after an escaped asterisk', [run('*'), run('b', { bold: true })], '\\***b**'],
  ])('keeps %s as Markdown', (_name, items, markdown) => {
    expect(buildMarkdown(items, new Map())).toBe(markdown);
  });

  test('writes HTML in a comment', () => {
    const items = [run('a'), run('.b', { bold: true })].map(item => ({ ...item, commentIds: new Set(['c1']) })) as ContentItem[];
    const comments = new Map([['c1', { author: 'R', text: 'note', date: '2024-01-01T00:00:00Z' }]]);
    expect(buildMarkdown(items, comments)).toStartWith('{==a<b>.b</b>==}');
  });

  test.each([
    ['a struck >a for b', [['>a', { strikethrough: true }]], [['b', {}]]],
    ['a for a struck }b', [['a', {}]], [['}b', { strikethrough: true }]]],
    ['struck >a and c for b and d', [['>a', { strikethrough: true }], ['c', {}]], [['b', {}], ['d', {}]]],
  ] as Array<[string, Array<[string, Partial<RunFormatting>]>, Array<[string, Partial<RunFormatting>]>]>)('keeps %s, a substitution, as written', (_name, deleted, added) => {
    // A mark hid the ~> or ~~} its strikethrough's delimiters made from
    // the check that the substitution reads back: {~~~~>a~~~>b~~}
    const revision = (type: 'deletion' | 'addition') => ({ type, author: 'A', date: '2024-01-01T00:00:00Z' });
    const side = (runs: typeof deleted, type: 'deletion' | 'addition') =>
      runs.map(([text, formatting]) => ({ ...run(text, formatting), revision: revision(type) }) as ContentItem);
    const written = buildMarkdown([run('x '), ...side(deleted, 'deletion'), ...side(added, 'addition'), run(' y')], new Map());
    const runs = parseMd(written).flatMap(token => token.runs ?? []);
    const read = (type: string) => runs.filter(r => r.type === type || r.type === 'critic_sub')
      .flatMap(r => r.type === 'critic_sub' ? (type === 'critic_del' ? r.oldRuns : r.newRuns) ?? [] : r.innerRuns ?? [{ ...r, type: 'text' }])
      .flatMap(r => [...r.text].map(c => c + (r.strikethrough ? '~' : '')));
    const expected = (side: typeof deleted) => side.flatMap(([text, f]) => [...text].map(c => c + (f.strikethrough ? '~' : '')));
    expect(read('critic_del')).toEqual(expected(deleted));
    expect(read('critic_add')).toEqual(expected(added));
  });

  test('closes bold with equations in it before a letter', () => {
    const items: ContentItem[] = [run('x', { bold: true }), { type: 'math', latex: 'y', display: false, commentIds: new Set() }, run('.', { bold: true }), run('z')];
    // The x before the equation's $ is a reference, after which it opens
    expect(buildMarkdown(items, new Map())).toBe('<b>&#120;$y$.</b>z');
  });

  test.each([
    ['an = before a highlight', [run('a='), run('b', { highlight: true })], 'a\\===b=='],
    ['an = between highlights', [run('a', { highlight: true }), run('='), run('b', { highlight: true, highlightColor: 'red' })], '==a==\\===b=={red}'],
  ])('escapes %s, which would open it a character early', (_name, items, markdown) => {
    const written = buildMarkdown(items, new Map());
    expect(written).toBe(markdown);
    expect(characters(written)).toEqual(expectedCharacters(items));
  });

  test('keeps highlights side by side as they are', () => {
    const items = [run('yellow', { highlight: true }), run('cyan', { highlight: true, highlightColor: 'cyan' })];
    expect(buildMarkdown(items, new Map())).toBe('==yellow====cyan=={turquoise}');
  });

  test.each([
    ['bold', [run('a', { code: true }), run('b', { code: true, bold: true })], '`ab`'],
    ['a highlight with ==, which code drops', [run(':) ', { code: true }), run('$==', { code: true, highlight: true })], '`:) $==`'],
  ])('writes code beside code with %s as one span', (_name, items, markdown) => {
    // Their backticks ran into one: `a``b`
    expect(buildMarkdown(items, new Map())).toBe(markdown);
  });

  test('keeps highlighted code beside code apart', () => {
    expect(buildMarkdown([run('a', { code: true }), run('b', { code: true, highlight: true })], new Map())).toBe('`a`==`b`==');
  });

  test('keeps code beside bold code apart in an HTML table', () => {
    // HTML keeps the bold outside code, which one span lost
    const cell = { colspan: 2, paragraphs: [[run('a', { code: true }), run('b', { code: true, bold: true })]] };
    const table = { type: 'table', rows: [{ isHeader: false, cells: [cell] }] } as unknown as ContentItem;
    expect(buildMarkdown([table], new Map())).toContain('<p><code>a</code><b><code>b</code></b></p>');
  });

  test('writes a long paragraph of formatted runs in linear time', () => {
    const items = Array.from({ length: 40000 }, (_, i) => run(i % 2 ? 'a.' : '.b', { bold: i % 3 === 0, italic: i % 5 === 0 }));
    const start = performance.now();
    buildMarkdown(items, new Map());
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('property: adjacent runs read back with their formatting', () => {
    const format = fc.record({
      bold: fc.boolean(), italic: fc.boolean(), strikethrough: fc.boolean(), underline: fc.boolean(),
      superscript: fc.boolean(), highlight: fc.boolean(), code: fc.boolean(),
    });
    const text = fc.array(fc.constantFrom(...'ab1.:(),!?-"\' \u00e9\u4e2d'), { minLength: 1, maxLength: 3 }).map(c => c.join(''));
    fc.assert(fc.property(fc.array(fc.tuple(text, format), { minLength: 2, maxLength: 4 }), runs => {
      const items = runs.map(([t, f]) => run(t, f.code ? { code: true, highlight: f.highlight } : { ...f, code: false }));
      // Whitespace's formatting doesn't show
      const visible = (cs: string[]) => cs.filter(c => !/^\s:/.test(c));
      expect(visible(characters(buildMarkdown(items, new Map())))).toEqual(visible(expectedCharacters(items)));
    }), { numRuns: 300 });
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
          // The paragraph's text starts its line, and nothing follows it,
          // and whitespace at its edges takes character references; a
          // link's text is the link's alone, inside its brackets
          const expectedRendering = href
            ? wrapWithFormatting(expectedText, formatting, false, RunsAfter.of('').linkTo(href))
            : keepParagraphEdgeWhitespace(wrapWithFormatting(expectedText, formatting, true, RunsAfter.of('')), true, true);
          
          // The result should contain the merged rendering for the combined text.
          expect(result).toContain(expectedRendering);
          
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
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0 && !s.includes(']') && !s.includes(')')),
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
          const linkMatch = result.match(/\[(.*?)\]\((.*?)\)/s);
          expect(linkMatch).not.toBeNull();
          
          const linkText = linkMatch![1];

          // When code is true, all other formatting is stripped — only backticks
          if (formatting.code) {
            expect(linkText).toContain('`');
            return;
          }

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
    expect(result).toBe(`{==normal **bold**==}{>>@Reviewer (${formatLocalIsoMinute('2025-01-01T00:00:00Z')}) | note<<}`);
  });

  test('highlighted commented text produces nested {====text====} delimiters', () => {
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
    expect(result).toBe(`{====highlighted====}{>>@Reviewer (${formatLocalIsoMinute('2025-01-01T00:00:00Z')}) | note<<}`);
  });

  test('highlight spanning into a comment region is preserved with ID-based syntax', () => {
    // In Word, a highlight can start before and end within a commented-on region.
    // With ID-based syntax ({#id}...{/id}), the tags carry no highlight semantics,
    // so the user-applied highlight must be preserved on both sides of the boundary.
    const comments = new Map([
      ['c1', { author: 'Reviewer', text: 'good point', date: '2025-01-01T00:00:00Z' }]
    ]);
    const content: any[] = [
      { type: 'para' },
      { type: 'text', text: 'before ', commentIds: new Set<string>(), formatting: { ...DEFAULT_FORMATTING, highlight: true } },
      { type: 'text', text: 'overlap', commentIds: new Set(['c1']), formatting: { ...DEFAULT_FORMATTING, highlight: true } },
      { type: 'text', text: ' after', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING },
    ];

    const result = buildMarkdown(content, comments, { alwaysUseCommentIds: true });
    // The highlight wraps both runs that have it, producing two ==...== regions
    expect(result).toContain('==before== ');
    expect(result).toContain('==overlap==');
    // Comment boundary markers are present
    expect(result).toContain('{#1}');
    expect(result).toContain('{/1}');
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
          // A list of the other kind at the same level is one of its own; a
          // sublist of the other kind is nested, with no blank line
          const startsAdjacentList = items.some((item, idx) => idx > 0 && item.level === items[idx - 1].level && item.type !== items[idx - 1].type);
          if (startsAdjacentList) {
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
    // Should produce two separate highlight spans: plain yellow + colored cyan→turquoise
    expect(result).toBe('==yellow====cyan=={turquoise}');
  });
});

describe('wrapWithFormatting colored highlights', () => {
  test('default/yellow highlight produces plain ==text==', () => {
    expect(wrapWithFormatting('hello', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'yellow' }))
      .toBe('==hello==');
  });

  test('highlight without highlightColor produces plain ==text==', () => {
    expect(wrapWithFormatting('hello', { ...DEFAULT_FORMATTING, highlight: true }))
      .toBe('==hello==');
  });

  test('OOXML named color (cyan) produces ==text=={turquoise}', () => {
    expect(wrapWithFormatting('hello', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'cyan' }))
      .toBe('==hello=={turquoise}');
  });

  test('OOXML named color (green) produces ==text=={green}', () => {
    expect(wrapWithFormatting('hello', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'green' }))
      .toBe('==hello=={green}');
  });

  test('hex color from w:shd (00FF00) produces ==text=={green}', () => {
    expect(wrapWithFormatting('hello', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: '00FF00' }))
      .toBe('==hello=={green}');
  });

  test('unknown color falls back to plain ==text==', () => {
    expect(wrapWithFormatting('hello', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'unknown' }))
      .toBe('==hello==');
  });

  test('hex yellow (FFFF00) produces plain ==text==', () => {
    expect(wrapWithFormatting('hello', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'FFFF00' }))
      .toBe('==hello==');
  });
});

describe('code run formatting stripping', () => {
  test('code + bold produces only backtick-fenced text', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, bold: true }))
      .toBe('`text`');
  });

  test('code + highlight keeps the highlight around the fence', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, highlight: true }))
      .toBe('==`text`==');
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, highlight: true, highlightColor: 'red' }))
      .toBe('==`text`=={red}');
  });

  test('code + italic + strikethrough produces only backtick-fenced text', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, italic: true, strikethrough: true }))
      .toBe('`text`');
  });

  test('code + superscript produces only backtick-fenced text', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, superscript: true }))
      .toBe('`text`');
  });

  test('non-code bold still produces **text**', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: false, bold: true }))
      .toBe('**text**');
  });

  test('code + all formatting flags produces highlighted backtick-fenced text', () => {
    const fmt: RunFormatting = {
      bold: true, italic: true, underline: true, strikethrough: true,
      highlight: true, superscript: true, subscript: true, code: true,
    };
    expect(wrapWithFormatting('text', fmt)).toBe('==`text`==');
  });
});

describe('colored highlight round-trip', () => {
  test('DOCX with green highlight → MD → DOCX → MD preserves ==text=={green}', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>green text</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const pass1 = await convertDocx(buf);
    expect(pass1.markdown).toContain('==green text=={green}');

    const { docx: docx2 } = await convertMdToDocx(pass1.markdown);
    const pass2 = await convertDocx(docx2);
    expect(pass2.markdown).toContain('==green text=={green}');
  });

  test('DOCX with cyan highlight → MD produces ==text=={turquoise}', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:rPr><w:highlight w:val="cyan"/></w:rPr><w:t>cyan text</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('==cyan text=={turquoise}');
  });

  test('DOCX with yellow highlight → MD produces plain ==text==', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>yellow text</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('==yellow text==');
    expect(result.markdown).not.toContain('==yellow text=={');
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

describe('A heading whose text ends in #', () => {
  const heading = async (text: string) => (await convertDocx(await buildSyntheticDocx(wrapDocumentXml(
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">' + text + '</w:t></w:r></w:p>',
  )))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');

  test.each([
    ['C #', '# C \\#\n'],
    ['C ##', '# C \\##\n'],
    ['C\t#', '# C\t\\#\n'],
    ['#', '# \\#\n'],
    ['C #a', '# C #a\n'],
    ['C#', '# C#\n'],
  ])('keeps the # of %j', async (text, md) => {
    // Markdown reads a run of # at a heading's end, after a space or tab or
    // as all its text, as its closing sequence, and drops it
    expect(await heading(text)).toBe(md);
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml.replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).toContain(text);
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
        // A letter or digit next to the equation's $ is a character
        // reference, which reads as it
        const md = result.markdown.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));

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
    const displayBlock = '$$' + '\n' + 'E=mc^2' + '\n' + '$$';
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
        zoteroUri: 'http://zotero.org/users/0/items/AB_CD%23#fragment~1',
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('zotero-key = {ABCD1234}');
    expect(bib).toContain('zotero-uri = {http://zotero.org/users/0/items/AB_CD%23#fragment~1}');
  });

  test('generateBibTeX emits TeX-safe literal tilde and circumflex commands', () => {
    const title = 'A ~B ^C and ~ B ^ C';
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title, year: '2020', journal: 'J', volume: '1',
        pages: '1-2', doi: '', type: 'article-journal', fullItemData: {},
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);

    expect(bib).toContain(
      String.raw`title = {{A \textasciitilde{}B \textasciicircum{}C and \textasciitilde{} B \textasciicircum{} C}}`
    );
    expect([...parseBibtex(bib).values()][0]?.fields.get('title')).toBe(title);
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

  test('generateBibTeX with originalKeyOrder reorders output', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(A; B; C)',
      items: [
        { authors: [{ family: 'Alpha', given: 'A' }], title: 'Alpha Title', year: '2020', journal: 'J', volume: '1', pages: '1', doi: '', type: 'article-journal', fullItemData: {} },
        { authors: [{ family: 'Beta', given: 'B' }], title: 'Beta Title', year: '2021', journal: 'J', volume: '2', pages: '2', doi: '', type: 'article-journal', fullItemData: {} },
        { authors: [{ family: 'Gamma', given: 'G' }], title: 'Gamma Title', year: '2022', journal: 'J', volume: '3', pages: '3', doi: '', type: 'article-journal', fullItemData: {} },
      ],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const keys = [...keyMap.values()];
    const alphaKey = keys.find(k => k.includes('alpha'))!;
    const betaKey = keys.find(k => k.includes('beta'))!;
    const gammaKey = keys.find(k => k.includes('gamma'))!;
    // Request reversed order
    const bib = generateBibTeX(citations, keyMap, [gammaKey, betaKey, alphaKey]);
    const entryOrder = [...bib.matchAll(/@article\{([^,]+),/g)].map(m => m[1]);
    expect(entryOrder).toEqual([gammaKey, betaKey, alphaKey]);
  });

  test('generateBibTeX with null originalKeyOrder preserves current behavior', () => {
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
    const bib1 = generateBibTeX(citations, keyMap);
    const bib2 = generateBibTeX(citations, keyMap, null);
    expect(bib2).toBe(bib1);
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

  test('citationPandocKeys writes Zotero prefixes before the key', () => {
    const citation: ZoteroCitation = {
      plainCitation: '(e.g., A; B)',
      items: [
        { authors: [{ family: 'A', given: 'X' }], title: 'T1', year: '2020', journal: 'J', volume: '1', pages: '1', doi: '10.1/a', type: 'article-journal', fullItemData: {}, prefix: 'e.g.,', suppressAuthor: true, locator: '4' },
        // Pandoc-significant characters and line breaks would change how the item parses
        { authors: [{ family: 'B', given: 'Y' }], title: 'T2', year: '2021', journal: 'J', volume: '2', pages: '2', doi: '10.1/b', type: 'article-journal', fullItemData: {}, prefix: 'see [also];\n@here' },
      ],
    };
    const keyMap = buildCitationKeyMap([citation]);
    const [a, b] = citation.items.map(meta => keyMap.get(itemIdentifier(meta)));
    expect(citationPandocKeys(citation, keyMap)).toEqual(['e.g., -@' + a + ', p. 4', 'see also here @' + b]);
  });

  test('citationPandocKeys escapes only prefix text that would parse as Markdown formatting', () => {
    const meta = (title: string, prefix: string) => ({ authors: [], title, year: '2020', journal: '', volume: '', pages: '', doi: '', type: 'article-journal', fullItemData: {}, prefix });
    const citation: ZoteroCitation = {
      plainCitation: '',
      items: [meta('T1', 'see *also* `x` $5 {++y++} <i>z</i> ==w== ~~v~~ a\\b'), meta('T2', 'for n = 10, p < .05, A & B ~ C')],
    };
    const keyMap = buildCitationKeyMap([citation]);
    const [a, b] = citation.items.map(m => keyMap.get(itemIdentifier(m)));
    expect(citationPandocKeys(citation, keyMap)).toEqual([
      'see \\*also\\* \\`x\\` \\$5 \\{++y++} \\<i>z\\</i> \\=\\=w\\=\\= \\~\\~v\\~\\~ a\\\\b @' + a,
      'for n = 10, p < .05, A & B ~ C @' + b,
    ]);
  });

  test('extracts Zotero citation prefixes', async () => {
    const payload = {
      citationID: 'abc',
      properties: { plainCitation: '(e.g., A 2020)', noteIndex: 0 },
      citationItems: [{ id: 1, prefix: ' e.g., ', itemData: { type: 'article-journal', title: 'T', issued: { 'date-parts': [[2020]] } } }],
    };
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + JSON.stringify(payload).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + ' </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body></w:document>';
    const zip = new JSZip();
    zip.file('word/document.xml', xml);
    const citations = await extractZoteroCitations(zip);
    expect(citations[0].items[0].prefix).toBe('e.g.,');
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
    expect(result.markdown).toContain('the second\\\nsentence o');
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
    expect(result.markdown).toContain('second\\\nsentence');
  });

  test('idempotent round-trip: docx→md→docx→md→docx→md', async () => {
    // Pass 1: original docx → md
    const pass1 = await convertDocx(commentsData);

    // Pass 2: md → docx → md
    const { docx: docx2 } = await convertMdToDocx(pass1.markdown);
    const pass2 = await convertDocx(docx2);

    // Pass 3: md → docx → md
    const { docx: docx3 } = await convertMdToDocx(pass2.markdown);
    const pass3 = await convertDocx(docx3);

    // The original DOCX fixture has a trailing <w:br/> at end of a paragraph
    // which becomes a backslash-newline in markdown. Trailing hard breaks
    // before deferred comments are semantically empty and may shift across
    // passes. Normalize trailing backslash-breaks and per-line trailing
    // whitespace to test semantic stability.
    const normalize = (s: string) =>
      s.replace(/[ \t]+$/gm, '').replace(/(\\?\n)+$/, '').replace(/\\\n(?=\n*\{#\d+>>|\n*\{>>)/g, '\n').replace(/\n{2,}(?=\{#\d+>>|\{>>)/g, '\n');
    expect(normalize(pass2.markdown)).toBe(normalize(pass3.markdown));
  });
});

describe('Bare links', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;

  test.each([
    ['another to a different place', '[https://e.com](https://e.com)[https://f.com](https://f.com)', '[https\\://e.com](https://e.com)https://f.com'],
    ['a letter', '[https://e.com](https://e.com)abc', '[https\\://e.com](https://e.com)abc'],
    ['a path', '[https://e.com](https://e.com)/x', '[https\\://e.com](https://e.com)/x'],
    ['a domain', '[https://e.com](https://e.com).org', '[https\\://e.com](https://e.com).org'],
    ['a letter before it', 'abc[https://e.com](https://e.com)', 'abc[https\\://e.com](https://e.com)'],
    ['a colon before an address', 'Contact:[a@b.com](mailto:a@b.com)', 'Contact:[a\\@b.com](mailto:a@b.com)'],
    ['a letter, in a comment\'s range', '{==[https://e.com](https://e.com)abc==}{>>c<<}', '{==[https\\://e.com](https://e.com)abc==}{>>c<<}'],
    ['a colon after its path', '[https://e.com/a](https://e.com/a): x', '[https\\://e.com/a](https://e.com/a): x'],
    ['a quote before an address', 'x"[a@b.com](mailto:a@b.com)', 'x"[a\\@b.com](mailto:a@b.com)'],
    ['a backslash, which escapes its scheme', '\\\\[https://e.com](https://e.com)', '\\\\https://e.com'],
    ['a line break after its path', '[https://e.com/a](https://e.com/a)\\\nx', '[https\\://e.com/a](https://e.com/a)\\\nx'],
    ['bold after its path', '[https://e.com/a](https://e.com/a)**b**', '[https\\://e.com/a](https://e.com/a)**b**'],
    ['strikethrough after it', '[https://e.com](https://e.com)~~b~~', '[https\\://e.com](https://e.com)~~b~~'],
    ['a highlight after it', '[https://e.com](https://e.com)==b==', '[https\\://e.com](https://e.com)==b=='],
    ['code after it', '[https://e.com](https://e.com)`b`', '[https\\://e.com](https://e.com)`b`'],
    ['an equation after it', '[https://e.com](https://e.com)$x$', '[https\\://e.com](https://e.com)$x$'],
    ['a link after its path', '[https://e.com/a](https://e.com/a)[b](https://f.com)', '[https\\://e.com/a](https://e.com/a)[b](https://f.com)'],
    ['an insertion after its path', '[https://e.com/a](https://e.com/a){++b++}', '[https\\://e.com/a](https://e.com/a){++b++}'],
    // markdown-it links no address but a URL with // that starts its text
    // after an escape or a reference
    ['an escaped [ before an address', 'a\\[[mailto:a@b.com](mailto:a@b.com)', 'a\\[[mailto:a\\@b.com](mailto:a@b.com)'],
    ['an escaped * before an address', 'x\\*[mailto:a@b.com](mailto:a@b.com)', 'x\\*[mailto:a\\@b.com](mailto:a@b.com)'],
    ['a backslash before an address', 'a\\\\[mailto:a@b.com](mailto:a@b.com)', 'a\\\\[mailto:a\\@b.com](mailto:a@b.com)'],
    ['a space that starts the paragraph before an address', '&#32;[mailto:a@b.com](mailto:a@b.com)', '&#32;[mailto:a\\@b.com](mailto:a@b.com)'],
    ['a space that starts a line before an address', 'a\\\n&#32;[a@b.com](mailto:a@b.com)', 'a\\\n&#32;[a\\@b.com](mailto:a@b.com)'],
  ])('writes a link next to %s in link syntax', async (_name, md, expected) => {
    // Written bare, linkify read the link with the text next to it, or
    // didn't read it as a link
    expect(await roundTrip(md)).toBe(expected + '\n');
  });

  test.each([
    ['a percent-encoded space', '[https://e.com/a%20b](https://e.com/a%20b)', '[https\\://e.com/a%20b](https://e.com/a%20b)'],
    ['punycode', '[https://xn--bcher-kva.de](https://xn--bcher-kva.de)', '[https\\://xn--bcher-kva.de](https://xn--bcher-kva.de)'],
    ['an asterisk at its end', '[https://e.com/a\\*](https://e.com/a*)', '[https\\://e.com/a\\*](https://e.com/a*)'],
  ])('writes a link to an address with %s in link syntax', async (_name, md, expected) => {
    // Linkify's link showed it decoded, or left the * out
    expect(await roundTrip(md)).toBe(expected + '\n');
  });

  test.each([
    '(https://e.com)', 'https://e.com.', 'see https://e.com, and', '(a@b.com)', 'a@b.com.', '"https://e.com"',
    '**b**https://e.com', '{++https://e.com++}', 'x {++https://e.com++} y', 'https://e.com\\\nx', 'https://e.com[^1]\n\n[^1]: n',
    // Unicode punctuation and symbols, which linkify ends a link at or reads one after
    'https://e.com\u2026 next', '\u201chttps://e.com\u201d', '\u00a9https://e.com', '\u00e9https://e.com', 'https://e.com,x',
    'https://e.com/a.', '{==https://e.com/a==}{>>c<<}', 'first_last@e.com',
    // A ! before it, escaped for a link's [, isn't, and an escaped & starts
    // no reference
    'a!mailto:a@b.com', 'a\\&#33;mailto:a@b.com', '&#32;https://e.com',
    // A break in the markup after it, which export read as part of the URL
    'https://e.com/a{~~\\\n~>x~~}', 'https://e.com/a{++x\\\ny++}',
  ])('keeps %s bare', async (md) => {
    expect((await roundTrip(md)).replace(/\{>>[^<]*<<\}/, '{>>c<<}')).toBe(md + '\n');
  });

  test.each([
    ['a link', '[ab](https://e.com)', '\\![ab](https://e.com)'],
    ['a link to its address, before a letter', '[https://e.com](https://e.com)x', '\\![https\\://e.com](https://e.com)x'],
    ['a link in a comment\'s range', '{==[ab](https://e.com)==}{>>c<<}', '{==\\![ab](https://e.com)==}{>>c<<}'],
  ])('escapes a ! before %s', async (_name, md, expected) => {
    // ![ made the link an image
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace('<w:hyperlink', '<w:r><w:t>!</w:t></w:r><w:hyperlink');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe(expected + '\n');
    expect(await roundTrip(markdown.slice(0, -1))).toBe(markdown);
  });

  test('escapes a ! before a link on a substitution\'s side', async () => {
    // A side has no spans of its own to keep them apart
    const md = 'A {~~a~>Wow\\![x](https://e.com)~~} b';
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test.each([
    'Really![^1]\n\n[^1]: Note.',
    'Really!{~~a~>b~~}',
  ])('leaves a ! alone before what no link starts: %s', async (md) => {
    expect(await roundTrip(md)).toBe(md + '\n');
  });
});

describe('w:br line break handling', () => {
  test.each([
    ['a deletion', 'a{--\\\n--} b'],
    ['an insertion', 'a{++\\\n++} b'],
    ['one that starts its paragraph', '{++\\\n++}b'],
    ['a deletion in a quote', '> a{--\\\n> --} b'],
    ['a substitution\'s side', 'a{~~\\\n~>x~~} b'],
    ['one with comments, by ID', 'Seen {#1}a {#2}b{/1}{--\\\n--} c{/2} on.\n{#1>>one<<}\n{#2>>two<<}'],
  ])('keeps a tracked change of a line break alone, %s', async (_name, md) => {
    // Import wrote the break bare, without the change
    const strip = (m: string) => m.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown)).toBe(md + '\n');
  });

  test('w:br without type attribute emits backslash-newline', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>before</w:t></w:r><w:r><w:br/><w:t>after</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('before\\\nafter');
  });

  test('w:br with type="textWrapping" emits backslash-newline', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>a</w:t></w:r><w:r><w:br w:type="textWrapping"/><w:t>b</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('a\\\nb');
  });

  test('w:br with type="page" does not emit newline', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>a</w:t></w:r><w:r><w:br w:type="page"/><w:t>b</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).not.toContain('a\\\nb');
    expect(result.markdown).not.toContain('a\nb');
  });

  test('w:br round-trips through md→docx→md', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>line one</w:t></w:r><w:r><w:br/><w:t>line two</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const pass1 = await convertDocx(buf);
    expect(pass1.markdown).toContain('line one\\\nline two');

    const { docx: docx2 } = await convertMdToDocx(pass1.markdown);
    const pass2 = await convertDocx(docx2);
    expect(pass2.markdown).toContain('line one\\\nline two');
  });
});

describe('line break semantics', () => {
  test('trailing backslash produces w:br and round-trips', async () => {
    const md = 'Hello world\\\nNew line here';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('Hello world\\\nNew line here');
  });

  test('bare newline does not produce w:br (soft break = space)', async () => {
    const md = 'Hello world\nSame paragraph';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    // Soft break should be rendered as space — no backslash-newline in output
    expect(result.markdown).not.toContain('\\\n');
    expect(result.markdown).toContain('Hello world Same paragraph');
  });

  test('breaks: true frontmatter makes bare newlines hard breaks', async () => {
    const md = '---\nbreaks: true\n---\nHello world\nNew line here';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('Hello world\\\nNew line here');
  });

  test('two trailing spaces produce w:br', async () => {
    const md = 'Hello world  \nNew line here';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('Hello world\\\nNew line here');
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

    expect(result.markdown).toContain('[^1]:\n\n    ' + '$' + '$' + '\n    E=mc^2\n    ' + '$' + '$');
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
    const displayMathBlock = '$$\n    x^2\n    $$';
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

describe('Comments in notes', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;

  test.each([
    ['a comment', 'Text.[^1]\n\n[^1]: A {==note==}{>>@A (2024-01-15 10:30) | c<<} here.\n'],
    ['a comment with a reply', 'Text.[^1]\n\n[^1]: A {==note==}{>>@A (2024-01-15 10:30) | c<<}{>>@B (2024-01-15 11:30) | r<<} here.\n'],
    ['a comment without a range', 'Text.[^1]\n\n[^1]: A {>>@A (2024-01-15 10:30) | point<<} here.\n'],
    ['overlapping comments', 'Text.[^1]\n\n[^1]: {#1}A {#2}b{/1} c{/2}.\n    {#1>>@A (2024-01-15 10:30) | one<<}\n    {#2>>@B (2024-01-15 10:30) | two<<}\n'],
    ['overlapping comments in the body too', 'A {#5}b {#6}c{/5} d{/6}.[^1]\n{#5>>@A (2024-01-15 10:30) | one<<}\n{#6>>@B (2024-01-15 10:30) | two<<}\n\n'
      + '[^1]: Note {#7}x {#8}y{/7} z{/8}.\n    {#7>>@A (2024-01-15 10:30) | n1<<}\n    {#8>>@B (2024-01-15 10:30) | n2<<}\n'],
    ['a comment in an endnote', '---\nnotes: endnotes\n---\n\nText.[^1]\n\n[^1]: A {==note==}{>>@A (2024-01-15 10:30) | c<<} here.\n'],
  ])('keeps %s', async (_name, md) => {
    expect(await roundTrip(md)).toBe(md);
  });
});

describe('HTML comments in notes', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;

  test.each([
    ['in a line', 'Text.[^1]\n\n[^1]: A <!-- x --> z.\n'],
    ['side by side', 'Text.[^1]\n\n[^1]: A <!-- x --><!-- y --> z.\n'],
    ['on a line of its own', 'Text.[^1]\n\n[^1]: A.\n\n    <!-- c -->\n\n    B.\n'],
    ['over two lines', 'Text.[^1]\n\n[^1]:\n\n    A <!-- x\n    y --> z.\n'],
    ['in an endnote', '---\nnotes: endnotes\n---\n\nText.[^1]\n\n[^1]: A <!-- x --> z.\n'],
  ])('keeps an HTML comment %s', async (_name, md) => {
    // Import read the hidden run export puts it in as text, with the
    // zero-width space before it, which added one more on each round trip
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(await roundTrip(md))).toBe(md);
  });

  test('reads a citation whose field code is hidden', async () => {
    // The field's runs went unread, so the citation came back as plain text,
    // and hidden text beside its field characters mustn't show
    const bibtex = '@article{smith2020,\n  author = {Smith, Jane},\n  title = {T},\n  journal = {J},\n  year = {2020},\n}';
    const zip = await JSZip.loadAsync((await convertMdToDocx('See [@smith2020].[^1]\n\n[^1]: See [@smith2020].', { bibtex })).docx);
    for (const part of ['word/document.xml', 'word/footnotes.xml']) {
      const xml = await zip.file(part)!.async('string');
      const hidden = xml.replace(/<w:r>(<w:rPr>)?(?=(?:(?!<\/w:r>).)*<w:(?:fldChar|instrText)\b)/g,
        (_match, rPr?: string) => '<w:r>' + (rPr ? rPr + '<w:vanish/>' : '<w:rPr><w:vanish/></w:rPr>'))
        .replace(/<w:fldChar w:fldCharType="begin"\/>/g, '$&<w:t>secret</w:t>');
      expect(hidden).toContain('<w:vanish/></w:rPr><w:fldChar w:fldCharType="begin"/><w:t>secret</w:t>');
      zip.file(part, hidden);
    }
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toContain('\nSee [@smith2020].[^1]\n');
    expect(markdown).toContain('\n[^1]: See [@smith2020].\n');
    expect(markdown).not.toContain('secret');
  });

  test('leaves out a citation hidden from its begin to its end', async () => {
    // Its field characters and code went on to the walk, which added it
    const bibtex = '@article{smith2020,\n  author = {Smith, Jane},\n  title = {T},\n  journal = {J},\n  year = {2020},\n}';
    const zip = await JSZip.loadAsync((await convertMdToDocx('A [@smith2020] b.[^1]\n\n[^1]: N [@smith2020] b.', { bibtex })).docx);
    for (const part of ['word/document.xml', 'word/footnotes.xml']) {
      const xml = await zip.file(part)!.async('string');
      // Every run from the citation's begin to its end
      const hidden = xml.replace(/<w:r>(?:(?!<w:r>).)*?<w:fldChar w:fldCharType="begin"\/>.*?<w:fldChar w:fldCharType="end"\/><\/w:r>/,
        (field) => field.replace(/<w:r>(<w:rPr>)?/g, (_match, rPr?: string) => '<w:r>' + (rPr ? rPr + '<w:vanish/>' : '<w:rPr><w:vanish/></w:rPr>')));
      expect(hidden).not.toBe(xml);
      zip.file(part, hidden);
    }
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toContain('\nA  b.[^1]\n');
    expect(markdown).toContain('\n[^1]: N  b.\n');
  });

  test('keeps hidden text after an HTML comment out of it', async () => {
    // It joined the closed comment, and showed after its -->
    for (const part of ['word/document.xml', 'word/footnotes.xml']) {
      const zip = await JSZip.loadAsync((await convertMdToDocx('A <!-- x --> b.[^1]\n\n[^1]: N <!-- x --> b.')).docx);
      const xml = await zip.file(part)!.async('string');
      const hidden = xml.replace(/<w:t>\u200B&lt;!-- x --&gt;<\/w:t><\/w:r>/, '$&<w:r><w:rPr><w:vanish/></w:rPr><w:t>secret</w:t></w:r>');
      expect(hidden).not.toBe(xml);
      zip.file(part, hidden);
      expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe('A <!-- x --> b.[^1]\n\n[^1]: N <!-- x --> b.\n');
    }
  });

  test.each(['0', 'false', 'off'])('keeps the text of a run with w:vanish="%s"', async (val) => {
    // The run is visible, though it has a w:vanish
    for (const part of ['word/document.xml', 'word/footnotes.xml']) {
      const zip = await JSZip.loadAsync((await convertMdToDocx('A b.[^1]\n\n[^1]: N b.')).docx);
      const xml = await zip.file(part)!.async('string');
      zip.file(part, xml.replace(/<w:r><w:t>([AN]) b\.<\/w:t>/, (_match, letter: string) =>
        '<w:r><w:rPr><w:vanish w:val="' + val + '"/></w:rPr><w:t>' + letter + ' b.</w:t>'));
      expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe('A b.[^1]\n\n[^1]: N b.\n');
    }
  });
});

describe('Word text that reads as Markdown', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  /** The Markdown for md's export, with its text XX in `part` replaced by text */
  const importText = async (md: string, text: string, part = 'word/document.xml') => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file(part)!.async('string');
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const edited = xml.replace(/<w:(t|delText)(?: [^>]*)?>([^<]*)XX([^<]*)<\/w:\1>/, (_m, tag: string, before: string, after: string) =>
      '<w:' + tag + ' xml:space="preserve">' + before + escaped + after + '</w:' + tag + '>');
    expect(edited).not.toBe(xml);
    zip.file(part, edited);
    return strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  /** The text of each paragraph of md's export, and whether any is more than text */
  const exported = async (md: string, part = 'word/document.xml') => {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file(part)!.async('string');
    const body = part === 'word/document.xml' ? xml.slice(xml.indexOf('<w:body>'), xml.indexOf('<w:sectPr')) : xml;
    const text = [...body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
      .map(p => p[0].replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
      .filter(Boolean);
    const formatted = /<w:(?:b|i|strike|highlight|vertAlign|hyperlink|ins|del|commentRangeStart|numPr|footnoteReference)\b|<m:oMath|<w:pStyle w:val="(?:Heading|Quote|GitHub)/.test(body);
    return { text, formatted };
  };

  test.each([
    'a\\.b', '_a_', '__a__', 'snake__case', '`c`', '[a](b)', '![a](b)', '[a]{.underline}', '[^1]', '$x$', '$' + '$', '~~s~~', '==h==',
    '{++a++}', '{--a--}', '{~~a~>b~~}', '{>>c<<}', '{==h==}', '{#1}', '{/1}', '<!-- c -->', '&amp;', '&nbsp;', '&#32;',
    '<http://e.com>', 'http://e.com', 'a@b.com', '\\[', '\\\\', 'end\\', '<img src="x.png">', '$x$_', 'a === b === c',
    // Escaping the second $ let the first close at the third
    '$ then $a$_ v', '$x then $a$_ v',
    // Escaping the inner [ left the outer one a link's
    '[[`](`)`',
    // Four or more = pair as an empty highlight
    'a ==== b',
    // A citation whose items export gives back otherwise
    '[@a; see_also_x]', '[@a;@b]',
    // A citation lookalike before a (, which export reads as one
    '[@a](b)',
    // An autolink past the 256 characters the check read, or with a
    // no-break space, which markdown-it allows in one
    '<urn:' + 'x'.repeat(300) + '>', '<ab:c\u00a0d>',
    // An email address linkify finds, past a narrower pattern's
    'foo$@example.com', 'user@bücher.de',
    // A URL or email address that the escape of what follows it ends, where
    // linkify found none before it was escaped
    'http://e.com_', 'a@b.co_',
  ])('keeps %s in a paragraph as text', async (text) => {
    // Import wrote Word's text as it was, and export read it as Markdown:
    // emphasis, code, a link, math, a tracked change, a comment, a
    // character reference, or a backslash escape
    const markdown = await importText('A.\n\nP XX Q.\n\nB.', text);
    expect(await exported(markdown)).toEqual({ text: ['A.', 'P ' + text + ' Q.', 'B.'], formatted: false });
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each(['https://e.com', '<https://e.com>'])('keeps %s, a link a comment is over, a link', async (md) => {
    // Its escapes, as for text, kept linkify from it: {==https\://e.com==}
    expect(await roundTrip('A {==' + md + '==}{>>c<<} B.')).toContain('{==https://e.com==}');
  });

  test.each([
    '# h', '###### h', '- a', '+ a', '* a', '-', '1. a', '1) a', '2020. A year', '> q', '>q', '```', '~~~', '---', '***', '___', '- - -',
    '<div>', '<!-- c -->', '[x]: /u', '[^x]: n', '\\begin{equation}x\\end{equation}',
  ])('keeps %s at the start of a paragraph or line as text', async (text) => {
    // A heading, list, quote, code block, thematic break, HTML block,
    // definition or equation took the text, or the paragraph went missing
    for (const md of ['A.\n\nXX\n\nB.', 'A.\n\nP\\\nXX\n\nB.']) {
      const markdown = await importText(md, text);
      const lines = md.includes('P') ? ['A.', 'P\n' + text, 'B.'] : ['A.', text, 'B.'];
      expect(await exported(markdown)).toEqual({ text: lines, formatted: false });
    }
  });

  test.each([
    ['===', '==='], ['--', '--'],
  ])('keeps %s after a line break as text', async (text) => {
    // It made the line before it a heading
    const markdown = await importText('A.\n\nP\\\nXX\n\nB.', text);
    expect(await exported(markdown)).toEqual({ text: ['A.', 'P\n' + text, 'B.'], formatted: false });
  });

  test.each([
    ['a list item', '- XX\n- b', '[ ] a'],
    ['a list item', '- XX\n- b', '1. a'],
    ['a quote', '> A.\n>\n> XX', '[!NOTE] x'],
    ['a quote', '> XX', '# h'],
    ['a note', 'T.[^1]\n\n[^1]: XX', '- a'],
    ['a list item in bold', '- **XX**\n- b', '[ ] a'],
    ['a quote in bold', '> A.\n>\n> **XX**', '[!NOTE] x'],
    ['a list item in code', '- `XX`\n- b', '[ ] a'],
    ['a quote in code', '> A.\n>\n> `XX`', '[!NOTE] x'],
    ['a list item in a link', '- [XX](https://e.com)\n- b', '[ ] a'],
  ])('keeps the text at the start of %s as text', async (_name, md, text) => {
    // A task's box, an alert's marker, a list or a heading took it, and
    // export found a box or marker through code, formatting or a link
    const part = md.includes('[^1]') ? 'word/footnotes.xml' : 'word/document.xml';
    const markdown = await importText(md, text, part);
    expect((await exported(markdown, part)).text).toContain(text);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a line that reads as a table\'s delimiter row as text', async () => {
    // The line before it became the header of a table
    const markdown = await importText('A.\n\na | b\\\nXX\n\nB.', '--- | ---');
    expect(await exported(markdown)).toEqual({ text: ['A.', 'a | b\n--- | ---', 'B.'], formatted: false });
  });

  test.each([
    ['after it', '$x$\\$ Q'],
    ['before a number', 'a $x$\\$5'],
    ['in a substitution', '{~~$x$\\$~>b~~}'],
    // An equation that starts the other side is no $ of text
    ['before an equation on a substitution\'s other side', '{~~a $x$~>$y$ c~~}'],
    ['in bold', '**a $x$\\$ Q**'],
    ['in a highlight', '==a $x$\\$ Q=='],
    ['in a comment\'s range', '{==a $x$\\$ Q==}{>>c<<}'],
  ])('keeps a $ right after inline math as text, %s', async (_name, md) => {
    // Import wrote it bare, and with the equation's closing $ it read as
    // no math
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test.each([
    ['after a tracked change', '{++$x$++}$ Q'],
    ['after a comment', '{==$x$==}{>>c<<}$ Q'],
    ['in a tracked change after one', '{++$x$++}{--$ Q--}'],
    ['on a substitution\'s other side', '{~~a $x$~>$ Q~~}'],
    ['after bold', '**a $x$**$ Q'],
    ['in a link', '{==a $x$[$5](https://e.com)==}{>>c<<}'],
  ])('keeps a $ after inline math that a delimiter comes between bare, %s', async (_name, md) => {
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test.each([
    ['a letter after it', 'the $x_i$&#115; are'],
    ['a digit before it', '&#50;$x$ and'],
    ['_ before it', 'a&#95;$x$'],
    ['a backslash and letter before it', 'a\\\\&#97;$x$'],
    ['a letter after it in bold', '**the $x_i$&#115;**'],
    ['a digit before it in a highlight', '==&#50;$x$ b=='],
    ['a letter after it in a comment\'s range', '{==the $x_i$&#115;==}{>>c<<}'],
    ['a letter after it in a substitution', '{~~$x$&#97;~>b~~}'],
  ])('keeps inline math next to %s as math', async (_name, md) => {
    // Import wrote the character bare, by which the $ next to it opened or
    // closed no math, and the equation came back as text
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<m:oMath>');
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test('keeps a backslash a citation\'s text ends with before a letter next to inline math', () => {
    // The backslash escaped the & of the letter's reference
    expect(buildMarkdown([
      { type: 'citation', text: '\\', commentIds: new Set(), pandocKeys: [] },
      { type: 'text', text: 'a', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'math', latex: 'x', display: false, commentIds: new Set() },
    ], new Map())).toBe('\\\\&#97;$x$');
  });

  test.each([
    '<div>\nx\n</div>', '<script>x</script>', '<p>a</p>', '<details>\n<summary>s</summary>\nx\n</details>',
    '<span>x</span> y', 'a\\\n<span>x</span>',
    // Escapes in a tag, which Markdown keeps raw, were text there
    '<span title="https://example.com">x</span>', '<a href="mailto:a@b.com">x</a>', '<span title="*a* [b] $c$ a_b ==c==">x</span> y',
    // Escapes in an HTML block, which Markdown keeps raw, were text there
    '<div>https://example.com</div>', '<pre>`code`</pre>', '<div>*a* [b] a_b</div>',
    // Blocks of the other kinds markdown-it reads, but a comment
    '<?xml version="1.0"?>', '<![CDATA[a*b* [c]]]>', '<!DOCTYPE html>', '<custom>\na*b*\n</custom>', '</custom>',
  ])('keeps the HTML %s as it is', async (md) => {
    // Import escaped a tag that started the paragraph or a line, which
    // export writes as text
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test.each([
    ['a heading', 'A.\n\n# XX\n\nB.'],
    ['a tracked change', 'A.\n\n{++XX++}\n\nB.'],
    ['a deleted heading', 'A.\n\n{--# XX--}\n\nB.'],
  ])('escapes the text of an HTML block in %s', async (_name, md) => {
    // Its tag doesn't start a block there, so *a* was italics
    const markdown = await importText(md, '<div>*a* [b](c) $x$</div>');
    expect(markdown).toContain('\\*a\\* \\[b](c) \\$x$');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['formatting after it', 'A.\n\nXX **b**\n\nB.', '<div>'],
    ['a line break after it', 'A.\n\nXX\\\nb\n\nB.', '<div>'],
    ['no closing tag', 'A.\n\nXX\n\nB.', '<script>'],
    ['no end', 'A.\n\nXX\n\nB.', '<?php echo 1;'],
    ['a tag import writes as a reference', 'A.\n\nXX\n\nB.', '<b>'],
  ])('keeps an HTML block\'s tag at the start of a paragraph with %s as text', async (_name, md, text) => {
    // The paragraph's text was raw HTML, so its formatting, escapes and
    // line breaks, or the paragraphs after it, were text
    const markdown = await importText(md, text);
    expect((await exported(markdown)).text).toEqual(['A.', md.slice(4, md.indexOf('\n\nB')).replace('XX', text).replace(/\*\*/g, '').replace('\\\n', '\n'), 'B.']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    'snake_case_name', 'C:\\Users\\x', 'costs $5 and $10', 'a == b', 'x < y > z', 'AT&T', '[sic]', 'see [1].', '#hashtag', 'a - b',
    '1.5 times', '50% off', '~a~', 'e.g. [@key]',
    // A citation's locator, which export writes as it is
    '[@missing, _p_]', '[-@smith, p. 2; see @jones]',
    // A citation through a [, which export reads to the ], $x$ and all; a
    // backslash would go into its key, and another each round trip
    '[@[$x$]', '[@a[$x$] b',
  ])('writes %s as it is', async (text) => {
    expect(await importText('A.\n\nP XX Q.\n\nB.', text)).toBe('A.\n\nP ' + text + ' Q.\n\nB.\n');
  });

  test('keeps dollar signs around formatted text in a comment\'s range as text', async () => {
    // $**x**$ in the range was an equation
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\nP {==XX==}{>>c<<} Q.\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace('<w:r><w:t>XX</w:t></w:r>', '<w:r><w:t>$</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r><w:r><w:t>$</w:t></w:r>');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect((await exported(markdown)).text).toEqual(['A.', 'P $x$ Q.', 'B.']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a dollar sign at the end of a run before formatted dollar signs as text', async () => {
    // The two looked like $$ with the formatting's delimiters left out, so
    // the first wasn't escaped, and opened math at the second's closer
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\n~~XX~~<sub>YY</sub>\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace('<w:t>XX</w:t>', '<w:t>:$</w:t>').replace('<w:t>YY</w:t>', '<w:t>$b$_</w:t>');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(await exported(markdown)).toEqual({ text: ['A.', ':$$b$_', 'B.'], formatted: true });
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each(['[', '$', 'a[b$'])('escapes runs with %s that can\'t join in linear time', (text) => {
    // Each run's [ or $ read the text of all the runs after it
    const items = Array.from({ length: 32000 }, (_, k) => (
      { type: 'text', text: 'a' + text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, bold: k % 2 === 0 } }));
    const start = performance.now();
    buildMarkdown(items as ContentItem[], new Map());
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('writes a paragraph of many links in linear time', () => {
    // Each run read whether the Markdown before it ended a line, which
    // copied it, as it ended with a link's concatenated syntax
    const items = Array.from({ length: 80000 }, (_, k) => [
      { type: 'text', text: 't' + k, href: 'https://e.com/' + k, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING } },
      { type: 'text', text: ' ', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING } }]).flat();
    const start = performance.now();
    buildMarkdown(items as ContentItem[], new Map());
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('escapes many paragraphs in linear time', () => {
    // Each paragraph's runs read an index of the text from the document's start
    const items = Array.from({ length: 8000 }, () => [
      { type: 'text', text: 'a', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING } }, { type: 'para' }]).flat();
    const start = performance.now();
    buildMarkdown(items as ContentItem[], new Map());
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test.each([
    ['a dollar sign before one in the next run, as a subscript', 'A.\n\nXX\n\nB.',
      '<w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>$</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>$_</w:t></w:r>', '$$_'],
    ['a dollar sign in a link before one after it', 'A.\n\n[XX](https://e.com)\n\nB.',
      '<w:r><w:t>$</w:t></w:r></w:hyperlink><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>$_</w:t></w:r><w:hyperlink><w:r><w:t>x</w:t></w:r>', '$$_x'],
    ['a dollar sign in a substitution\'s side before one in the next run', 'A.\n\n{~~XX~>cd~~}\n\nB.',
      '<w:r><w:delText>$</w:delText></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:delText>$_</w:delText></w:r>', '$$_cd'],
    ['a == in a run before one in the next', 'A.\n\nXX\n\nB.',
      '<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>x==a</w:t></w:r><w:r><w:t xml:space="preserve"> {==b</w:t></w:r>', 'x==a {==b'],
    ['a backslash before a line break at the end of bold text', 'A.\n\nXX\n\nB.',
      '<w:r><w:rPr><w:b/></w:rPr><w:t>a\\</w:t><w:br/></w:r><w:r><w:t>c</w:t></w:r>', 'a\\\nc'],
  ])('keeps %s as text', async (_name, md, runs, text) => {
    // Runs' dollar signs ran together in the index of the runs after, and
    // a link's text and a substitution's side had none, so math opened;
    // a == paired with one in the next run as a highlight; a line break's
    // backslash escaped bold's closer
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r><w:t>XX<\/w:t><\/w:r>|<w:r><w:delText>XX<\/w:delText><\/w:r>/, runs);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect((await exported(markdown)).text).toEqual(['A.', text, 'B.']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each(['[x](y)', '[^1]', '[@x]', 'a]b', 'a[b', '[a]', '$x', '!'].flatMap(text => [
    [text, 'P [XX](https://e.com/a$b) Q.'],
    [text, 'P {==[XX](https://e.com/a$b)==}{>>c<<} Q.'],
    [text, 'P {~~z~>[XX](https://e.com/a$b)~~} Q.'],
  ]))('keeps %s, a link\'s text, as it is, in %s', async (text, md) => {
    // A ] that a [ in it didn't close ended the link's text, a link, note
    // or citation in it made it none, and a $ in it closed at its URL's
    const markdown = await importText('A.\n\n' + md + '\n\nB.', text);
    expect((await exported(markdown)).text).toEqual(['A.', md.replace(/\{[=~]+|[=~]+\}|\{>>c<<\}|~>|\[|\]\(.*?\)/g, '').replace('XX', text), 'B.']);
    expect(markdown.split('](https://e.com/a$b)')).toHaveLength(2);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([['[@', 'https://e.com/a'], ['[@x ', 'https://e.com/a'], ['$a', 'https://e.com/a$/b']])('keeps %s before a link to %s as text', async (text, href) => {
    // The link's ] closed a citation the text opened, and a $ in its URL
    // the text's math, as the text read the link's text alone after it
    const markdown = await importText('A.\n\nP XX[b](' + href + ') Q.\n\nB.', text);
    expect((await exported(markdown)).text).toEqual(['A.', 'P ' + text + 'b Q.', 'B.']);
    expect(markdown.split('[b](' + href + ')')).toHaveLength(2);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([['{=={'], ['a==b']])('escapes the == of %s before highlighted text, which it pairs with', async (text) => {
    // The runs after it read as the highlighted text alone, without its ==
    const markdown = await importText('A.\n\nXX==x==\n\nB.', text);
    expect((await exported(markdown)).text).toEqual(['A.', text + 'x', 'B.']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('escapes bold text with math in it for the syntax in its paragraph alone', async () => {
    // It read the runs after it to the end of the document, so a == in a
    // later paragraph escaped one in it, as a highlight's text did
    const markdown = await importText('**XX $m$**\n\nx == y', 'a==b');
    expect(markdown).toContain('**a==b $m$**\n\nx == y');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([['[@a', 'https://e.com/a'], ['$a', 'https://e.com/a$/b']])('keeps %s before a link whose text is its URL, %s, as text', async (text, href) => {
    // Read as its URL alone, the link left the text before it as it was,
    // but after a letter, where linkify doesn't find it, it's written with
    // its text in brackets, whose ] closed a citation the text opened
    const markdown = await importText('A.\n\nP XX<' + href + '> Q.\n\nB.', text);
    expect((await exported(markdown)).text).toEqual(['A.', 'P ' + text + href + ' Q.', 'B.']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('escapes many dollar signs in linear time', () => {
    // Each $ read the text's Markdown whole, with the runs after it, and
    // each escape built it anew
    const start = performance.now();
    expect(wrapWithFormatting('$a$ '.repeat(25000), DEFAULT_FORMATTING, false, RunsAfter.of(' x'))).toBe('\\$a$ '.repeat(25000));
    expect(performance.now() - start).toBeLessThan(500);
  });

  test('escapes a long run of [ in linear time', () => {
    // Each [ looked for its ] through the rest of the text
    const start = performance.now();
    expect(wrapWithFormatting('['.repeat(50000), DEFAULT_FORMATTING)).toBe('\\['.repeat(50000));
    expect(performance.now() - start).toBeLessThan(500);
  });

  test('writes the keys of a citation as they are', async () => {
    // A key's _ took a backslash, which went in the key
    const markdown = await importText('A.\n\nP XX Q.\n\nB.', '[@_smith] and [see @smith_, p. 5]');
    expect(markdown).toBe('A.\n\nP [@_smith] and [see @smith_, p. 5] Q.\n\nB.\n');
  });

  test('writes a line start of formatted text as it is', async () => {
    // Its delimiter starts the line
    const markdown = await importText('A.\n\n**XX** b.\n\nB.', '1. Introduction');
    expect(markdown).toBe('A.\n\n**1. Introduction** b.\n\nB.\n');
  });

  test('keeps dollar signs around formatted text as text', async () => {
    // $**x**$ was an equation
    const markdown = await importText('A.\n\nP XX**x**$ Q.\n\nB.', '$');
    expect((await exported(markdown)).text).toEqual(['A.', 'P $x$ Q.', 'B.']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['an insertion', 'P {++XX++} Q.', '{++a++} b', 'w:ins'],
    ['a deletion', 'P {--XX--} Q.', 'x --} y', 'w:del'],
    ['a substitution', 'P {~~XX~>c~~} Q.', 'a ~> b', 'w:del'],
  ])('keeps the closer of %s in its text', async (_name, md, text, tag) => {
    // The text's closer ended the tracked change around it, or its ~> split it
    const markdown = await importText('A.\n\n' + md + '\n\nB.', text);
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    const changed = [...xml.matchAll(new RegExp('<' + tag + '\\b[\\s\\S]*?</' + tag + '>', 'g'))]
      .map(m => m[0].replace(/<[^>]+>/g, '').replace(/&gt;/g, '>'));
    expect(changed).toEqual([text]);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['bold', '**XX**b', '\\ '],
    ['a highlight', '==XX==b', '{ '],
    ['strikethrough', '~~XX~~b', ')\\ '],
  ])('keeps a \\ or { before the space at the end of %s as text', async (_name, md, text) => {
    // The space goes outside the delimiters, after which the \ escaped the
    // closer and the { opened a comment's range with it
    const markdown = await importText('A.\n\n' + md + '\n\nB.', text);
    expect(await exported(markdown)).toEqual({ text: ['A.', text + 'b', 'B.'], formatted: true });
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a { before the space at the end of an underlined highlight as text', async () => {
    // The highlight's == go inside the space, as in a highlight alone
    const markdown = await importText('A.\n\n<u>==XX==</u>b\n\nB.', '{ ');
    expect(markdown).toContain('<u>==\\{== </u>b');
    expect(await exported(markdown)).toEqual({ text: ['A.', '{ b', 'B.'], formatted: true });
  });

  test.each(['~a', 'a~', '~', '~a~', 'a\\~', ' ~a'])('keeps %s in a strikethrough as text', async (text) => {
    // A ~ at the edge joined the ~~ around it, which ~~~a~~ reads as ~ and
    // struck a
    const markdown = await importText('A.\n\n~~XX~~\n\nB.', text);
    expect(await exported(markdown)).toEqual({ text: ['A.', text.trimEnd(), 'B.'], formatted: true });
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each(['a==', '==a', 'a == b', 'a=', 'a = b', 'a\\=', 'a\\\\=', 'a{', '{'])('keeps %s in a highlight as text', async (text) => {
    // The highlight closed at its ==, which a backslash didn't keep from it
    const markdown = await importText('A.\n\n==XX==\n\nB.', text);
    expect(await exported(markdown)).toEqual({ text: ['A.', text, 'B.'], formatted: true });
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['in bold', 'A.\n\nXX**x$\\_** Z\n\nB.', 'P $1', 'P $1x$_ Z'],
    ['in an equation', 'A.\n\nXX $(x)$ Z\n\nB.', 'P $a', undefined],
  ])('keeps a dollar sign whose math would close in a later run %s as text', async (_name, md, text, expected) => {
    // The run's escapes and formatting, yet to come, or the equation's
    // dollar signs, let it close where the run's text didn't
    const markdown = await importText(md, text);
    expect(markdown).toContain(text.replace('$', '\\$'));
    if (expected) expect((await exported(markdown)).text).toEqual(['A.', expected, 'B.']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a bracket apart from a link whose ] is in a later run', async () => {
    const markdown = await importText('A.\n\nXX**b**](c)\n\nB.', 'P [a');
    expect(await exported(markdown)).toEqual({ text: ['A.', 'P [ab](c)', 'B.'], formatted: true });
    expect(markdown).toContain('P \\[a');
  });
});

describe('HTML table cells', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  const table = (cell: string) => '<table>\n  <tr>\n    <th>\n      <p>h</p>\n    </th>\n  </tr>\n  <tr>\n    <td>\n' + cell + '\n    </td>\n  </tr>\n</table>';

  test.each([
    ['formatting', '      <p><b>b</b> <i>i</i> <u>u</u> <s>s</s> x<sup>2</sup> H<sub>2</sub>O <code>c</code> <a href="https://e.com/?a=1&amp;b=2">l</a></p>'],
    ['nested formatting', '      <p><b><i>bi</i></b> <b>b <i>bi</i></b></p>'],
    ['characters HTML or Markdown would read', '      <p>a &lt; b &amp;&amp; c &gt; d * _ [x] `y` {++w++}</p>'],
    ['two paragraphs and a line break', '      <p>a</p>\n      <p>b<br>c</p>'],
    ['two line breaks, apart from two paragraphs', '      <p>a<br><br>b</p>'],
    ['empty paragraphs', '      <p></p>\n      <p>a</p>\n      <p></p>\n      <p>b</p>\n      <p></p>'],
    ['a line break at the end of a paragraph', '      <p>a<br></p>'],
    ['a space at the start of a line', '      <p>a<br>&#32;b</p>'],
    ['a link whose target has an apostrophe', '      <p><a href="https://e.com/O\'Brien">o</a></p>'],
    ['whitespace HTML would collapse', '      <p>a&#9;b &#32;c</p>'],
    ['a space at the start of a line before formatting', '      <p>&#32;<b>x</b> &#32;<i>y</i><br>&#32;&#32;<b>&#32;z</b>&nbsp;</p>'],
  ])('keeps %s', async (_name, cell) => {
    // Import wrote Markdown in the cell, which exports as literal text, with
    // a backslash before each character Markdown would read, and more on
    // each round trip, and a cell's paragraphs as one with a \ break
    const md = table(cell);
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(await roundTrip(md))).toBe(md);
  });

  test('writes a cell\'s paragraphs as paragraphs of the Word cell', async () => {
    const { docx } = await convertMdToDocx(table('      <p>a</p>\n      <p>b</p>'));
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const cell = xml.split('<w:tc>')[2];
    expect(cell.match(/<w:p[ >]/g)).toHaveLength(2);
    expect(cell).not.toContain('<w:br/>');
  });

  test('reads a Word cell with two paragraphs, under a bold header, as HTML', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('| h |\n| --- |\n| XX |')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const two = xml.replace('<w:r><w:t>XX</w:t></w:r></w:p>', '<w:r><w:t>a</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>b</w:t></w:r></w:p>');
    expect(two).not.toBe(xml);
    zip.file('word/document.xml', two);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(table('      <p>a</p>\n      <p><b>b</b></p>'));
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('writes a table whose cells hold what HTML can\'t in a format that can, unless it needs HTML', () => {
    // Its comment exported as literal text
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }]]);
    const text = (t: string, ids: string[] = []) => ({ type: 'text', text: t, commentIds: new Set(ids), formatting: DEFAULT_FORMATTING });
    const markdown = (colspan: number) => buildMarkdown([{ type: 'table', rows: [
      { isHeader: true, cells: [{ paragraphs: [[text('h')]], colspan }] },
      { isHeader: false, cells: [{ paragraphs: [[text('a '), text('b', ['0'])]], colspan }] },
    ] }] as ContentItem[], comments, { tableFormatMapping: new Map([['0', 'html']]) });
    expect(markdown(1)).toBe('| h |\n| --- |\n| a {==b==}{>>@A \\| c<<} |');
    expect(markdown(2)).toStartWith('<table>\n  <tr>\n    <th colspan="2">');
  });
});

describe('Tabs', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

  test.each([
    ['a paragraph', 'a\tb', 'word/document.xml'],
    ['a paragraph\'s start', '&#9;t', 'word/document.xml'],
    ['a line\'s start after a line break', 'a\\\n&#9;t', 'word/document.xml'],
    ['a note', 'T.[^1]\n\n[^1]: a\tb', 'word/footnotes.xml'],
    ['a comment', '{==x==}{>>@A (2024-01-15 10:30) | a\tb<<}', 'word/comments.xml'],
    ['a comment\'s start', '{==x==}{>>@A (2024-01-15 10:30) | \tb<<}', 'word/comments.xml'],
    ['a comment\'s second paragraph', '{==x==}{>>@A (2024-01-15 10:30) | a\n\n\tb<<}', 'word/comments.xml'],
    ['a deletion', '{--a\tb--}', 'word/document.xml'],
    ['an HTML comment', 'A <!-- a\tb --> c.', 'word/document.xml'],
    ['a table cell', '| a\tb |\n| --- |', 'word/document.xml'],
    ['a code block', '```\na\tb\n```', 'word/document.xml'],
  ])('keeps a tab in %s', async (_name, md, part) => {
    // Export wrote a tab in the text, where Word writes a w:tab, which import
    // dropped
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file(part)!.async('string');
    expect(xml).toContain('<w:tab/>');
    expect(xml).not.toMatch(/<w:(?:t|delText)\b[^>]*>[^<]*\t/);
    expect(strip((await convertDocx(docx)).markdown)).toBe(md);
  });

  test('keeps a tab in a citation Markdown writes as text', async () => {
    const { docx } = await convertMdToDocx('T [@missing, p.\t2].');
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:tab/>');
    expect(xml).not.toMatch(/<w:t\b[^>]*>[^<]*\t/);
    expect(strip((await convertDocx(docx)).markdown)).toStartWith('T [@missing, p.\t2].');
  });

  test('leaves a deleted tab out of a comment', async () => {
    // A deleted run's tab became text of the comment, though its other text
    // didn't
    const zip = await JSZip.loadAsync((await convertMdToDocx('{==x==}{>>@A (2024-01-15 10:30) | kept<<}')).docx);
    const xml = await zip.file('word/comments.xml')!.async('string');
    const deleted = xml.replace(/(<w:t>kept<\/w:t><\/w:r>)/, '$1<w:del w:id="90" w:author="A"><w:r><w:tab/><w:delText>gone</w:delText></w:r></w:del>');
    expect(deleted).not.toBe(xml);
    zip.file('word/comments.xml', deleted);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('{==x==}{>>@A (2024-01-15 10:30) | kept<<}');
  });

  test('leaves a paragraph\'s tab stops out of its text', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('a\tb')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const stops = xml.replace(/(<w:p [^>]*>)/, '$1<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>');
    expect(stops).not.toBe(xml);
    zip.file('word/document.xml', stops);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('a\tb');
  });
});

describe('Hyphens, symbols and carriage returns', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

  test.each([
    ['a non-breaking hyphen', 'w:noBreakHyphen', 'COVID‑19'],
    ['an optional hyphen', 'w:softHyphen', 'hy­phen'],
  ])('keeps %s', async (_name, element, md) => {
    // Import dropped Word's element for it, so COVID‑19 came back COVID19
    for (const [text, part] of [[md, 'word/document.xml'], ['T.[^1]\n\n[^1]: ' + md, 'word/footnotes.xml'],
      ['{==x==}{>>@A (2024-01-15 10:30) | ' + md + '<<}', 'word/comments.xml'], ['{--' + md + '--}', 'word/document.xml']]) {
      const { docx } = await convertMdToDocx(text);
      const xml = await (await JSZip.loadAsync(docx)).file(part)!.async('string');
      expect(xml).toContain('<' + element + '/>');
      expect(strip((await convertDocx(docx)).markdown)).toBe(text);
    }
  });

  test('reads a Symbol font character as the Unicode one it shows', async () => {
    // Word writes one picked from the Symbol font as a w:sym, which import
    // dropped, so p ≤ 0.05 came back p  0.05. One from another font, as
    // Wingdings, has no Unicode character to be.
    const sym = (font: string, char: string) => '<w:sym w:font="' + font + '" w:char="' + char + '"/>';
    const docx = await buildSyntheticDocx(wrapDocumentXml('<w:p><w:r><w:t xml:space="preserve">p </w:t>'
      + sym('Symbol', 'F0A3') + sym('Symbol', 'F061') + sym('SYMBOL', '0062') + sym('Wingdings', 'F0FC') + sym('Symbol', 'F080')
      + '<w:t xml:space="preserve"> 0.05</w:t></w:r></w:p>'));
    expect(strip((await convertDocx(docx)).markdown)).toBe('p ≤αβ 0.05');
  });

  test('reads a Symbol font character in a comment', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('{==x==}{>>@A (2024-01-15 10:30) | a XX<<}')).docx);
    const xml = await zip.file('word/comments.xml')!.async('string');
    const sym = xml.replace(/<w:t( [^>]*)?>a XX<\/w:t>/, '<w:t xml:space="preserve">a </w:t><w:sym w:font="Symbol" w:char="F0B1"/>');
    expect(sym).not.toBe(xml);
    zip.file('word/comments.xml', sym);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('{==x==}{>>@A (2024-01-15 10:30) | a ±<<}');
  });

  test('reads a carriage return as a line break', async () => {
    // Import dropped it, which Word shows as a line break
    const zip = await JSZip.loadAsync((await convertMdToDocx('a\\\nb')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const cr = xml.replace('<w:br/>', '<w:cr/>');
    expect(cr).not.toBe(xml);
    zip.file('word/document.xml', cr);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('a\\\nb');
  });
});

describe('Table alignment', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);

  test.each([
    ['a pipe table', '| a | b | c | d |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |\n'],
    ['a column of empty cells', '| a | |\n| --- | ---: |\n| 1 | |\n'],
    ['an aligned pipe table', '| Name  | Value |\n|:------|------:|\n| Alpha | 1     |\n'],
    ['an aligned pipe table of narrow columns', '| a   | b   |\n|:---:|:---:|\n| 1   | 2   |\n'],
    ['a grid table', '+-----+-----+\n| a   | b   |\n+:====+====:+\n| 1   | 2   |\n|     |     |\n| 3   | 4   |\n+-----+-----+\n'],
    ['a grid table without a header', '+:----+----:+\n| 1   | 2   |\n|     |     |\n| 3   | 4   |\n+-----+-----+\n'],
    ['an HTML table', '<table>\n  <tr>\n    <th align="center">\n      <p>a</p>\n    </th>\n    <th>\n      <p>b</p>\n    </th>\n  </tr>\n'
      + '  <tr>\n    <td colspan="2" align="right">\n      <p>x</p>\n    </td>\n  </tr>\n</table>\n'],
  ])('keeps the alignment of %s', async (_name, md) => {
    // Export dropped it, and a grid table with it was text
    expect(await roundTrip(md)).toBe(md);
  });

  test('writes a column\'s alignment as its paragraphs\'', async () => {
    const { docx } = await convertMdToDocx('| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |');
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const row = xml.split('<w:tr>')[2];
    expect([...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(tc => /<w:jc w:val="(\w+)"\/>/.exec(tc[0])?.[1]))
      .toEqual(['left', 'center', 'right', undefined]);
    expect(row).toContain('<w:spacing w:after="0"/><w:jc w:val="left"/>');
  });

  test('writes at least three dashes in a column, as number formatting reads', async () => {
    // A colon took the place of a dash
    expect(await roundTrip('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')).toBe('| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n');
  });

  test('writes only an alignment a separator gives from a grid table placeholder', async () => {
    // The placeholder's JSON went in the XML as written
    const data = { rows: [{ cells: ['a', 'b'], header: false }], colWidths: [3, 3], aligns: ['"/><w:injected/><w:jc w:val="left', 'right'] };
    const md = GRID_TABLE_PLACEHOLDER_PREFIX + Buffer.from(JSON.stringify(data)).toString('base64') + ' -->';
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    expect(xml).not.toContain('w:injected');
    expect([...xml.matchAll(/<w:jc w:val="(\w+)"\/>/g)].map(m => m[1])).toEqual(['right']);
  });

  test('counts an alignment\'s colons in the width of a pipe table\'s separator', async () => {
    // It took six characters a column, and wrote a line past the limit
    const cell = (text: string) => '<w:tc><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>' + text + '</w:t></w:r></w:p></w:tc>';
    const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>'
      + '<w:tr>' + cell('a') + cell('b') + '</w:tr><w:tr>' + cell('1') + cell('2') + '</w:tr></w:tbl></w:body></w:document>';
    const docx = await buildSyntheticDocx(xml);
    const markdown = async (width: number) => (await convertDocx(docx, 'authorYearTitle', { pipeTableMaxLineWidth: width })).markdown;
    expect(await markdown(17)).toContain('| :---: | :---: |');
    expect(await markdown(16)).not.toContain('| :---: | :---: |');
  });

  test('reads the alignment of a cell\'s paragraphs in a content control', async () => {
    // Only a cell's own paragraphs counted
    const zip = await JSZip.loadAsync((await convertMdToDocx('| a | b |\n| :---: | ---: |\n| 1 | 2 |')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const wrapped = xml.replace(/(<w:tc>(?:(?!<\/w:tc>)[\s\S])*?)(<w:p[ >][\s\S]*?<\/w:p>)(<\/w:tc>)/g, (_m, a, p, b) => a + '<w:sdt><w:sdtContent>' + p + '</w:sdtContent></w:sdt>' + b);
    expect(wrapped.match(/<w:sdtContent>/g)).toHaveLength(4);
    zip.file('word/document.xml', wrapped);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('| a | b |\n| :---: | ---: |\n| 1 | 2 |\n');
  });

  test.each([
    ['|a|b|\n|:---|---:|\n|1|2|', '| a | b |\n| :--- | ---: |\n| 1 | 2 |\n'],
    ['|a|long|\n|:---:|---|\n|1|2|', '| a | long |\n| :---: | --- |\n| 1 | 2 |\n'],
    ['|aaaaa|\n|:---:|\n|11111|', '| aaaaa |\n| :---: |\n| 11111 |\n'],
  ])('keeps a compact pipe table with alignment compact: %s', async (md, expected) => {
    // :--- or :---: was taken for a column padded to its width
    expect(await roundTrip(md)).toBe(expected);
  });

  test('keeps a padded pipe table with an empty cell padded', async () => {
    // Number formatting doubled the empty cell's whitespace, and its line
    // no longer lined up with the others
    const md = '|     | b   |\n|:----|----:|\n| 1   | 2   |\n';
    expect(await roundTrip(md)).toBe(md);
  });

  test('leaves out a right-to-left paragraph\'s alignment but center', async () => {
    // start and end are the other way around there
    const zip = await JSZip.loadAsync((await convertMdToDocx('| a | b |\n| :---: | ---: |\n| 1 | 2 |')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const rtl = xml.replace(/<w:pPr><w:pStyle w:val="TableParagraph"\/>/g, '<w:pPr><w:pStyle w:val="TableParagraph"/><w:bidi/>');
    expect(rtl).not.toBe(xml);
    zip.file('word/document.xml', rtl);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('| a | b |\n| :---: | --- |\n| 1 | 2 |\n');
  });

  test('reads a column\'s alignment from its paragraphs\' style or its table\'s', async () => {
    // Only a paragraph's own alignment counted
    const zip = await JSZip.loadAsync((await convertMdToDocx('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |')).docx);
    const styles = await zip.file('word/styles.xml')!.async('string');
    zip.file('word/styles.xml', styles.replace('</w:styles>',
      '<w:style w:type="paragraph" w:styleId="Right"><w:name w:val="Right"/><w:pPr><w:jc w:val="right"/></w:pPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="RightCell"><w:name w:val="Right Cell"/><w:basedOn w:val="Right"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="LeftCell"><w:name w:val="Left Cell"/><w:pPr><w:jc w:val="left"/></w:pPr></w:style>'
      + '<w:style w:type="table" w:styleId="Centered"><w:name w:val="Centered"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style></w:styles>'));
    const xml = await zip.file('word/document.xml')!.async('string');
    let column = 0;
    const styled = xml.replace('<w:tblPr>', '<w:tblPr><w:tblStyle w:val="Centered"/>')
      .replace(/<w:tc>[\s\S]*?<\/w:tc>/g, tc => tc.replace('<w:pStyle w:val="TableParagraph"/>', ['', '<w:pStyle w:val="RightCell"/>', '<w:pStyle w:val="LeftCell"/>'][column++ % 3]));
    expect(styled.match(/RightCell/g)).toHaveLength(2);
    zip.file('word/document.xml', styled);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('| a | b | c |\n| :---: | ---: | --- |\n| 1 | 2 | 3 |\n');
  });

  test('reads a column\'s alignment from the default table style', async () => {
    // A table without a style of its own takes the default one
    const zip = await JSZip.loadAsync((await convertMdToDocx('| a | b |\n| --- | --- |\n| 1 | 2 |')).docx);
    const styles = await zip.file('word/styles.xml')!.async('string');
    const centered = styles.replace(/(w:styleId="TableNormal">[\s\S]*?)<w:tblPr>/, (_m, before) => before + '<w:pPr><w:jc w:val="center"/></w:pPr><w:tblPr>');
    expect(centered).not.toBe(styles);
    zip.file('word/styles.xml', centered);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe('| a | b |\n| :---: | :---: |\n| 1 | 2 |\n');
  });

  /** md's import, with styles added to styles.xml, Normal centered or not, and the table's tblPr and cells' paragraphs changed */
  const withStyles = async (md: string, styles: string, tblPr: (xml: string) => string, paragraph: (column: number) => string, centerNormal = false) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const stylesXml = await zip.file('word/styles.xml')!.async('string');
    zip.file('word/styles.xml', stylesXml.replace('</w:styles>', styles + '</w:styles>')
      .replace(/(w:styleId="Normal">[\s\S]*?<w:pPr>)/, (_m, before: string) => before + (centerNormal ? '<w:jc w:val="center"/>' : '')));
    const xml = await zip.file('word/document.xml')!.async('string');
    const columns = md.split('\n')[0].split('|').length - 2;
    let cell = 0;
    zip.file('word/document.xml', tblPr(xml).replace(/<w:tc>[\s\S]*?<\/w:tc>/g, tc => tc.replace('<w:pStyle w:val="TableParagraph"/>', paragraph(cell++ % columns))));
    return strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };

  test.each([
    ['its bands', '<w:tblStylePr w:type="band1Vert"><w:pPr><w:jc w:val="center"/></w:pPr></w:tblStylePr><w:tblStylePr w:type="band2Vert"><w:pPr><w:jc w:val="right"/></w:pPr></w:tblStylePr>',
      '<w:tblLook w:val="0000"/>', '| :---: | ---: | :---: |'],
    ['its last column, from tblLook\'s bits', '<w:tblStylePr w:type="lastCol"><w:pPr><w:jc w:val="right"/></w:pPr></w:tblStylePr>',
      '<w:tblLook w:val="0500"/>', '| --- | --- | ---: |'],
    ['its last column, which tblLook leaves off', '<w:tblStylePr w:type="lastCol"><w:pPr><w:jc w:val="right"/></w:pPr></w:tblStylePr>',
      '<w:tblLook w:val="0400"/>', '| --- | --- | --- |'],
  ])('reads a column\'s alignment from %s in the table style', async (_name, parts, look, separator) => {
    // Only the table style's own paragraph properties counted
    const markdown = await withStyles('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |',
      '<w:style w:type="table" w:styleId="Parts"><w:name w:val="Parts"/>' + parts + '</w:style>',
      xml => xml.replace(/<w:tblLook [^>]*\/>/, '<w:tblStyle w:val="Parts"/>' + look), () => '');
    expect(markdown).toBe('| a | b | c |\n' + separator + '\n| 1 | 2 | 3 |\n');
  });

  test('reads the alignment of a table of one row from its first row\'s part of the table style', async () => {
    const markdown = await withStyles('| a | b |\n| --- | --- |',
      '<w:style w:type="table" w:styleId="Parts"><w:name w:val="Parts"/><w:tblStylePr w:type="firstRow"><w:pPr><w:jc w:val="center"/></w:pPr></w:tblStylePr></w:style>',
      xml => xml.replace(/<w:tblLook [^>]*\/>/, '<w:tblStyle w:val="Parts"/><w:tblLook w:firstRow="1"/>'), () => '');
    expect(markdown).toBe('| a | b |\n| :---: | :---: |\n');
  });

  test('reads the default paragraph style\'s alignment only where a paragraph has no other style', async () => {
    // A style of its own, without a base, took the default's, a centered
    // Normal
    const markdown = await withStyles('| a | b |\n| --- | --- |\n| 1 | 2 |',
      '<w:style w:type="paragraph" w:styleId="Plain"><w:name w:val="Plain"/></w:style>',
      xml => xml, column => column === 0 ? '<w:pStyle w:val="Plain"/>' : '', true);
    expect(markdown).toBe('| a | b |\n| --- | :---: |\n| 1 | 2 |\n');
    // A style styles.xml doesn't have is the default
    const missing = await withStyles('| a | b |\n| --- | --- |\n| 1 | 2 |',
      '<w:style w:type="paragraph" w:styleId="Plain"><w:name w:val="Plain"/></w:style>',
      xml => xml, column => column === 0 ? '<w:pStyle w:val="Plain"/>' : '<w:pStyle w:val="Missing"/>', true);
    expect(missing).toBe('| a | b |\n| --- | :---: |\n| 1 | 2 |\n');
  });

  test('keeps a padded pipe table padded when a row has no closing pipe', async () => {
    // Its last cell's width counted against the separator's, which closes
    expect(await roundTrip('| Name | Value |\n|:-----|------:|\n| Abcd | 1\n')).toBe('| Name | Value |\n|:-----|------:|\n| Abcd | 1     |\n');
  });

  test('keeps a padded pipe table padded when number formatting widens its cells', async () => {
    // Its rows no longer lined up once formatted
    const md = '---\ntable-digits: 2\n---\n\n| Name  | Value |\n|:------|------:|\n| Alpha | 1     |\n| Beta  | 12345 |\n';
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown)
      .toBe('---\ntable-digits: 2\n---\n\n| Name  | Value    |\n|:------|---------:|\n| Alpha | 1.00     |\n| Beta  | 12345.00 |\n');
  });

  test.each([
    ['', '| Val |\n|-----|\n| 123 |\n', '| Val    |\n|--------|\n| 123.00 |\n'],
    [' in a note', 'Text.[^1]\n\n[^1]: Note.\n\n    | Val |\n    |-----|\n    | 123 |\n',
      'Text.[^1]\n\n[^1]: Note.\n\n    | Val    |\n    |--------|\n    | 123.00 |\n'],
  ])('keeps a narrow padded pipe table%s padded when number formatting widens its cells', async (_name, body, expected) => {
    // Its cells, a space on a side, no longer lined up once formatted
    const front = '---\ntable-digits: 2\n---\n\n';
    expect((await convertDocx((await convertMdToDocx(front + body)).docx)).markdown).toBe(front + expected);
  });

  test('keeps a padded pipe table without a closing pipe padded', async () => {
    // The last cell's padding, which a line can end in or not, counted
    expect(await roundTrip('Name  |Value\n:-----|----:\nAlpha |1\n')).toBe('| Name  | Value |\n|:------|------:|\n| Alpha | 1     |\n');
  });

  test('leaves out the alignment of a column whose cells differ', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('| a | b |\n| :-: | --: |\n| 1 | 2 |\n| 3 | 4 |')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/(<w:jc w:val=")right("\/><\/w:pPr><w:r><w:t>4<)/, (_m, a, b) => a + 'center' + b);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown))
      .toBe('| a | b |\n| :---: | --- |\n| 1 | 2 |\n| 3 | 4 |\n');
  });
});

describe('Whitespace at the edges of a paragraph', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
  /** The Markdown of md's export, with the text XX in part replaced by text */
  const withText = async (md: string, part: string, text: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file(part)!.async('string');
    zip.file(part, xml.replace('<w:t>XX</w:t>', '<w:t xml:space="preserve">' + text + '</w:t>'));
    return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
  };

  test.each([
    ['four spaces', '    four', 'A.\n\n&#32;&#32;&#32;&#32;four\n\nB.\n'],
    ['a tab', '\tt', 'A.\n\n&#9;t\n\nB.\n'],
    ['two spaces', '  two', 'A.\n\n&#32;&#32;two\n\nB.\n'],
    ['a no-break space', '\u00a0x', 'A.\n\n&nbsp;x\n\nB.\n'],
    ['a no-break space alone', '\u00a0', 'A.\n\n&nbsp;\n\nB.\n'],
  ])('keeps %s at the start of a paragraph', async (_name, text, expected) => {
    // Four spaces or a tab made the paragraph a code block, and Markdown
    // dropped other whitespace there, or the whole paragraph
    const markdown = await withText('A.\n\nXX\n\nB.', 'word/document.xml', text);
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a no-break space at the end of a paragraph', async () => {
    const markdown = await withText('A.\n\nXX\n\nB.', 'word/document.xml', 'end\u00a0');
    expect(markdown).toBe('A.\n\nend&nbsp;\n\nB.\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['a space', 'end\u00a0 ', 'A.\n\nend&nbsp; \n\nB.\n'],
    ['a tab', 'end\u00a0\t', 'A.\n\nend&nbsp;\t\n\nB.\n'],
  ])('keeps a no-break space at the end of a paragraph before %s', async (_name, text, expected) => {
    // Markdown trims the space or tab, which Word doesn't show, and the
    // no-break space with it
    const markdown = await withText('A.\n\nXX\n\nB.', 'word/document.xml', text);
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe('A.\n\nend&nbsp;\n\nB.\n');
  });

  test.each([
    ['a paragraph', 'A.\n\np\\\nXX\n\nB.', 'word/document.xml', 'A.\n\np\\\n&#9;&#32;t\n\nB.\n'],
    ['a list item', '- p\\\n  XX\n- b', 'word/document.xml', '- p\\\n&#9;&#32;t\n- b\n'],
    ['a note', 'T.[^1]\n\n[^1]: A.\n\n    p\\\n    XX', 'word/footnotes.xml', 'T.[^1]\n\n[^1]: A.\n\n    p\\\n    &#9;&#32;t\n'],
    ['a grid table\'s cell', '+-----+\n| a   |\n+=====+\n| p\\  |\n| XX  |\n|     |\n| z   |\n+-----+', 'word/document.xml',
      '+------------+\n| a          |\n+============+\n| p          |\n| &#9;&#32;t |\n|            |\n| z          |\n+------------+\n'],
  ])('keeps the whitespace at the start of a line after a line break in %s', async (_name, md, part, expected) => {
    // Markdown drops it there
    const markdown = await withText(md, part, '\t t');
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['an HTML comment', 'A <!-- x\\\n  y --> b.\n'],
    ['math', 'A $x\\\n  y$ b.\n'],
    ['an HTML tag', 'A <span title="a\\\n  b">x</span> c.\n'],
  ])('leaves the whitespace after a backslash at a line\'s end in %s as it is', async (_name, md) => {
    // Its text is raw, where a reference is text
    expect(await roundTrip(md)).toBe(md);
  });

  test('leaves the whitespace after a backslash at a line\'s end in an HTML block as it is', () => {
    // Its text is raw. A round trip escapes the tag, as it can't tell the
    // backslash from a line break of Word's, which would be raw text there.
    expect(keepParagraphWhitespace('<script>x\\\n  y</script>', true, true)).toBe('<script>x\\\n  y</script>');
  });

  test.each([
    'A [@smith, p.\\\n  2] b.', 'A [see @smith, p.\\\n  2] b.', 'A [see @ékey, p.\\\n  2] b.',
  ])('leaves the whitespace after a backslash at a line\'s end in a citation as it is: %s', (text) => {
    // A citation's text is raw, and a reference split it at its ;
    expect(keepParagraphWhitespace(text, true, true)).toBe(text);
  });

  test.each([
    ['a key after its first item', 'A [a; @smith, p.'], ['a formatted prefix', 'A [*see* @smith, p.'],
  ])('keeps the whitespace after a line break in a bracket that is no citation, with %s', (_name, before) => {
    // It was taken for a citation, whose text is raw
    expect(keepParagraphWhitespace(before + '\\\n  2]', true, true)).toBe(before + '\\\n&#32;&#32;2]');
  });

  test.each(['<!-->', '<!--->'])('keeps the whitespace after a line break after the comment %s', (comment) => {
    // The comment went on to the next -->
    expect(keepParagraphWhitespace('A ' + comment + ' x\\\n  y -->', true, true)).toBe('A ' + comment + ' x\\\n&#32;&#32;y -->');
  });

  test('keeps the whitespace after a line break past comments that don\'t close', () => {
    // Each opener searched to the end for its closer
    for (const opener of ['<!--', '{>>', '`']) {
      const text = 'A ' + opener.repeat(30000) + 'x\\\n\t y';
      const start = performance.now();
      expect(keepParagraphWhitespace(text, false, false)).toEndWith('x\\\n&#9;&#32;y');
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  test('leaves the whitespace in code after a line break as it is', async () => {
    // A run of backticks before the code, which closes nothing, ended it
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\nXX\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const code = '<w:rPr><w:rStyle w:val="CodeChar"/></w:rPr>';
    const edited = xml.replace('<w:r><w:t>XX</w:t></w:r>', '<w:r><w:t xml:space="preserve">p ```a </w:t></w:r><w:r>' + code + '<w:t>x</w:t></w:r>'
      + '<w:r>' + code + '<w:br/></w:r><w:r>' + code + '<w:t xml:space="preserve">  y</w:t></w:r>');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toContain('p \\`\\`\\`a `x\\\n  y`');
  });

  test.each([
    ['a paragraph that starts with a tab and has a backtick', '\ta`b', '', '&#9;a\\`b\\\n&#9;&#32;t'],
    ['an HTML comment with a backtick, before code', 'p <!-- ` --> q', '<w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:t>c</w:t></w:r>',
      'p \\<!-- \\` --> q\\\n&#9;&#32;t`c`'],
  ])('keeps the whitespace after a line break in %s', async (_name, before, after, expected) => {
    // The scan for code read the paragraph as indented code, or paired the
    // comment's backtick with the code's, and left the whitespace as it was
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\nXX\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace('<w:r><w:t>XX</w:t></w:r>', '<w:r><w:t xml:space="preserve">' + before.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      + '</w:t><w:br/><w:t xml:space="preserve">\t t</w:t></w:r>' + after);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe('A.\n\n' + expected + '\n\nB.\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['a list item', '- XX\n- b', 'word/document.xml', '- &#9;t\n- b\n'],
    ['a quote', '> XX', 'word/document.xml', '> &#9;t\n'],
    ['a heading', '# XX', 'word/document.xml', '# &#9;t\n'],
    ['a note\'s second paragraph', 'T.[^1]\n\n[^1]: A.\n\n    XX', 'word/footnotes.xml', 'T.[^1]\n\n[^1]: A.\n\n    &#9;t\n'],
  ])('keeps a tab at the start of %s', async (_name, md, part, expected) => {
    const markdown = await withText(md, part, '\tt');
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['a tab', '&#9;t'], ['spaces', '&#32;&#32;t'], ['a space before bold', '&#32;**t**'],
  ])('keeps %s at the start of a note', async (_name, text) => {
    // Import took it all for the space Word puts after the note's mark
    const md = 'T.[^1]\n\n[^1]: ' + text + '\n';
    expect(await roundTrip(md)).toBe(md);
  });

  test('keeps the whitespace at the start of a note after a comment\'s body', async () => {
    // Export looked for it in the body, which goes with the comment
    const md = 'T.[^1]\n\n[^1]: {#1>>c<<}\n    &#32;t {#1}x{/1}\n';
    expect(await roundTrip(md)).toBe('T.[^1]\n\n[^1]: &#32;t {==x==}{>>c<<}\n');
  });

  test.each([
    ['a space', ' ', 't', 'T.[^1]\n\n[^1]: t\n'],
    ['a tab', '\t', 't', 'T.[^1]\n\n[^1]: t\n'],
    ['a space, before text that starts with spaces', ' ', '  t', 'T.[^1]\n\n[^1]: &#32;&#32;t\n'],
    ['a tab, before text that starts with spaces', '\t', '  t', 'T.[^1]\n\n[^1]: &#32;&#32;t\n'],
  ])('leaves out %s Word puts after a note\'s mark', async (_name, separator, text, expected) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('T.[^1]\n\n[^1]: XX')).docx);
    const xml = await zip.file('word/footnotes.xml')!.async('string');
    const run = (t: string) => t === '\t' ? '<w:r><w:tab/></w:r>' : '<w:r><w:t xml:space="preserve">' + t + '</w:t></w:r>';
    const edited = xml.replace('<w:r><w:t>XX</w:t></w:r>', run(separator) + run(text));
    expect(edited).not.toBe(xml);
    zip.file('word/footnotes.xml', edited);
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe(expected);
  });

  test.each([
    ['a table cell', '| a | b |\n| --- | --- |\n| XX | 2 |', '| a | b |\n| --- | --- |\n| &#9;t&nbsp; | 2 |\n'],
    ['an HTML table cell', '<table>\n  <tr>\n    <td>\n      <p>XX</p>\n    </td>\n  </tr>\n</table>',
      '<table>\n  <tr>\n    <td>\n      <p>&#9;t&nbsp;</p>\n    </td>\n  </tr>\n</table>\n'],
    ['an alert', '> [!NOTE]\n> XX', '> [!NOTE]\n> &#9;t&nbsp;\n'],
    ['a paragraph before a table', 'XX\n\n| a | b |\n| --- | --- |\n| 1 | 2 |', '&#9;t&nbsp;\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'],
    ['a paragraph before an equation', 'XX\n\n' + '$' + '$\nx\n' + '$' + '$', '&#9;t&nbsp;\n\n' + '$' + '$\nx\n' + '$' + '$\n'],
    ['a paragraph before a section', 'XX\n\n<!-- landscape -->\n\nW.\n\n<!-- /landscape -->', '&#9;t&nbsp;\n\n<!-- landscape -->\n\nW.\n\n<!-- /landscape -->\n'],
  ])('keeps the whitespace at the edges of %s', async (_name, md, expected) => {
    // An alert's label took the whitespace after it, and the end of the
    // text before a block that isn't a paragraph didn't count as its end
    const markdown = await withText(md, 'word/document.xml', '\tt\u00a0');
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps the whitespace after the space that follows an alert\'s label on its line', async () => {
    // The bold label took all of it
    const zip = await JSZip.loadAsync((await convertMdToDocx('> [!NOTE]\n> XX')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const sameLine = xml.replace('<w:r><w:br/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>XX</w:t></w:r>',
      '<w:r><w:t xml:space="preserve">  \tt</w:t></w:r>');
    expect(sameLine).not.toBe(xml);
    zip.file('word/document.xml', sameLine);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe('> [!NOTE]\n> &#32;&#9;t\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps the whitespace at the edges of a note\'s text after an equation in its paragraph', async () => {
    // Text after an equation in its paragraph goes on from the closing
    // fence, as in the document's body, with its whitespace kept
    const fence = '$' + '$';
    const zip = await JSZip.loadAsync((await convertMdToDocx('T.[^1]\n\n[^1]: A.\n\n    ' + fence + '\n    x\n    ' + fence)).docx);
    const xml = await zip.file('word/footnotes.xml')!.async('string');
    zip.file('word/footnotes.xml', xml.replace('</m:oMathPara>', '</m:oMathPara><w:r><w:t xml:space="preserve">\tt\u00a0</w:t></w:r>'));
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe('T.[^1]\n\n[^1]: A.\n\n    ' + fence + '\n    x\n    ' + fence + '&#9;t&nbsp;\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('drops the space or tab after a note\'s mark, but keeps a no-break space', async () => {
    expect(await withText('T.[^1]\n\n[^1]: XX', 'word/footnotes.xml', '\tt')).toBe('T.[^1]\n\n[^1]: t\n');
    expect(await withText('T.[^1]\n\n[^1]: XX', 'word/footnotes.xml', '\u00a0')).toBe('T.[^1]\n\n[^1]: &nbsp;\n');
  });

  test('leaves a paragraph of spaces alone, an empty paragraph to Markdown', async () => {
    expect(await withText('A.\n\nXX\n\nB.', 'word/document.xml', '   ')).not.toContain('&#32;');
  });
});

describe('DOCX footnote cross-reference import', () => {
  function wrapCustomPropsXml(props: Record<string, string>): string {
    let xml = '<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">';
    let pid = 2;
    for (const [name, value] of Object.entries(props)) {
      xml += '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="' + pid + '" name="' + name + '"><vt:lpwstr>' + value + '</vt:lpwstr></property>';
      pid++;
    }
    xml += '</Properties>';
    return xml;
  }

  test('NOTEREF field with cross-ref custom property resolves to footnote_ref', async () => {
    // Build a synthetic docx with:
    // 1. First ref: normal w:footnoteReference
    // 2. Second ref: NOTEREF field pointing to bookmark _Ref100000001
    // 3. Footnote body with bookmark around footnoteRef
    // 4. Custom property mapping the bookmark
    const docXml = wrapDocumentXml(
      '<w:p>'
      + '<w:r><w:t>First</w:t></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'
      + '<w:r><w:t> and second</w:t></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:instrText xml:space="preserve"> NOTEREF _Ref100000001 \\f \\h </w:instrText></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:t>1</w:t></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>'
      + '</w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes',
      '<w:footnote w:id="1">'
      + '<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>'
      + '<w:bookmarkStart w:id="0" w:name="_Ref100000001"/>'
      + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>'
      + '<w:bookmarkEnd w:id="0"/>'
      + '<w:r><w:t> Shared footnote content.</w:t></w:r></w:p>'
      + '</w:footnote>'
    );
    const crossRefMapping = JSON.stringify({ '_Ref100000001': 'footnote:1' });
    const customPropsXml = wrapCustomPropsXml({ 'MANUSCRIPT_FOOTNOTE_CROSSREFS_1': crossRefMapping });

    const buf = await buildSyntheticDocx(docXml, {
      'word/footnotes.xml': footnotesXml,
      'docProps/custom.xml': customPropsXml,
    });
    const result = await convertDocx(buf);

    // Both the normal ref and the cross-ref should appear as [^1]
    const refs = result.markdown.match(/\[\^1\]/g);
    expect(refs).not.toBeNull();
    expect(refs!.length).toBe(3); // 2 inline refs + 1 definition
    expect(result.markdown).toContain('[^1]: Shared footnote content.');
  });

  test('NOTEREF display text is not emitted as regular text', async () => {
    const docXml = wrapDocumentXml(
      '<w:p>'
      + '<w:r><w:t>Before</w:t></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'
      + '<w:r><w:t> middle</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
      + '<w:r><w:instrText xml:space="preserve"> NOTEREF _Ref100000001 \\f \\h </w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:r><w:t>1</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
      + '<w:r><w:t> after</w:t></w:r>'
      + '</w:p>'
    );
    const footnotesXml = wrapNotesXml('footnotes',
      '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> Note.</w:t></w:r></w:p></w:footnote>'
    );
    const crossRefMapping = JSON.stringify({ '_Ref100000001': 'footnote:1' });
    const customPropsXml = wrapCustomPropsXml({ 'MANUSCRIPT_FOOTNOTE_CROSSREFS_1': crossRefMapping });

    const buf = await buildSyntheticDocx(docXml, {
      'word/footnotes.xml': footnotesXml,
      'docProps/custom.xml': customPropsXml,
    });
    const result = await convertDocx(buf);

    // The display text "1" from the NOTEREF field should NOT appear as literal text
    // It should be replaced by the [^1] reference
    expect(result.markdown).toContain('Before[^1] middle[^1] after');
    expect(result.markdown).toContain('[^1]: Note.');
  });

  test('unresolved NOTEREF field suppresses display text (no custom property)', async () => {
    // NOTEREF field without MANUSCRIPT_FOOTNOTE_CROSSREFS — display text should be suppressed
    const docXml = wrapDocumentXml(
      '<w:p>'
      + '<w:r><w:t>Before</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
      + '<w:r><w:instrText xml:space="preserve"> NOTEREF _Ref999 \\f \\h </w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:r><w:t>1</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
      + '<w:r><w:t> after</w:t></w:r>'
      + '</w:p>'
    );
    const buf = await buildSyntheticDocx(docXml);
    const result = await convertDocx(buf);

    // The display text "1" should NOT appear — it's from the unresolved NOTEREF field
    expect(result.markdown.trim()).toBe('Before after');
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

  test('returns 1 for GitHub style without explicit indent', () => {
    const children = [{ 'w:pStyle': [], ':@': { '@_w:val': 'GitHub' } }];
    expect(parseBlockquoteLevel(children)).toBe(1);
  });
  test('returns 1 for GitHubBlockquote style (Word-saved)', () => {
    const children = [{ 'w:pStyle': [], ':@': { '@_w:val': 'GitHubBlockquote' } }];
    expect(parseBlockquoteLevel(children)).toBe(1);
  });

  test('returns level based on 240-twip indent for GitHub style', () => {
    const children = [
      { 'w:pStyle': [], ':@': { '@_w:val': 'GitHub' } },
      { 'w:ind': [], ':@': { '@_w:left': '480' } },
    ];
    expect(parseBlockquoteLevel(children)).toBe(2);
  });

  test('returns level based on 240-twip indent for GitHub alert styles', () => {
    const children = [
      { 'w:pStyle': [], ':@': { '@_w:val': 'GitHubWarning' } },
      { 'w:ind': [], ':@': { '@_w:left': '480' } },
    ];
    expect(parseBlockquoteLevel(children)).toBe(2);
  });
});

describe('parseAlertType', () => {
  test('parses GitHub alert style names', () => {
    expect(parseAlertType([{ 'w:pStyle': [], ':@': { '@_w:val': 'GitHubNote' } }])).toBe('note');
    expect(parseAlertType([{ 'w:pStyle': [], ':@': { '@_w:val': 'GitHubTip' } }])).toBe('tip');
    expect(parseAlertType([{ 'w:pStyle': [], ':@': { '@_w:val': 'GitHubImportant' } }])).toBe('important');
    expect(parseAlertType([{ 'w:pStyle': [], ':@': { '@_w:val': 'GitHubWarning' } }])).toBe('warning');
    expect(parseAlertType([{ 'w:pStyle': [], ':@': { '@_w:val': 'GitHubCaution' } }])).toBe('caution');
  });

  test('returns undefined for non-alert styles', () => {
    expect(parseAlertType([{ 'w:pStyle': [], ':@': { '@_w:val': 'GitHub' } }])).toBeUndefined();
    expect(parseAlertType([{ 'w:pStyle': [], ':@': { '@_w:val': 'Normal' } }])).toBeUndefined();
  });
});

describe('Blockquote round-trip', () => {
  test('extracts string-valued callout labels robustly and returns null when omitted', async () => {
    const { docx: explicitDocx } = await convertMdToDocx('> [!NOTE]\n> Body', { calloutLabels: false });
    expect(await extractCalloutLabels(explicitDocx)).toBe(false);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(explicitDocx);
    const customXml = await zip.file('docProps/custom.xml')!.async('string');
    zip.file('docProps/custom.xml', customXml.replace('<vt:lpwstr>false</vt:lpwstr>', '<vt:lpwstr> TRUE </vt:lpwstr>'));
    const normalizedDocx = await zip.generateAsync({ type: 'uint8array' });
    expect(await extractCalloutLabels(normalizedDocx)).toBe(true);

    const { docx: omittedDocx } = await convertMdToDocx('> [!NOTE]\n> Body');
    expect(await extractCalloutLabels(omittedDocx)).toBeNull();
  });

  test('restores explicit false callout-labels frontmatter', async () => {
    const md = '---\ncallout-labels: false\n---\n\n> [!NOTE]\n> Body';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('callout-labels: false');
    expect(result.markdown).toContain('> [!NOTE]\n> Body');
  });

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

  test('DOCX with GitHub style detected as blockquote', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:pPr><w:pStyle w:val="GitHub"/><w:ind w:left="240"/></w:pPr>'
      + '<w:r><w:t>github styled</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('> github styled');
  });

  test('GitHub-style blockquote round-trips through md→docx→md', async () => {
    const md = '> quoted text';
    const { docx } = await convertMdToDocx(md, { blockquoteStyle: 'GitHub' });
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('> quoted text');
  });

  test('nested GitHub-style blockquote round-trips', async () => {
    const md = '> > nested';
    const { docx } = await convertMdToDocx(md, { blockquoteStyle: 'GitHub' });
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('> > nested');
  });

  test('alert blockquote round-trips to canonical markdown alert syntax', async () => {
    const md = '> [!WARNING]\n> Be careful';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('> [!WARNING]\n> Be careful');
  });

  test('DOCX alert style converts to markdown alert syntax', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:pPr><w:pStyle w:val="GitHubTip"/><w:ind w:left="240"/></w:pPr>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t>◈ Tip </w:t></w:r>'
      + '<w:r><w:t>Helpful advice</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('> [!TIP]\n> Helpful advice');
  });

  test('DOCX alert style without a visible prefix reconstructs canonical alert syntax', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:pPr><w:pStyle w:val="GitHubTip"/><w:ind w:left="240"/></w:pPr>'
      + '<w:r><w:t>Helpful advice</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('> [!TIP]\n> Helpful advice');
  });

  test('DOCX alert with hard break after prefix keeps marker-only form and paragraph break', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:pPr><w:pStyle w:val="GitHubNote"/><w:ind w:left="240"/></w:pPr>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t>※ Note </w:t></w:r>'
      + '<w:r><w:br/></w:r>'
      + '<w:r><w:t>This is a note.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>This is a paragraph.</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);
    expect(result.markdown).toContain('> [!NOTE]\n> This is a note.\n\nThis is a paragraph.');
    expect(result.markdown).not.toContain('> [!NOTE] This is a note.');
  });

  test('literal alert marker text inside an alert paragraph is preserved', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:pPr><w:pStyle w:val="GitHubNote"/><w:ind w:left="240"/></w:pPr>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t>※ Note </w:t></w:r>'
      + '<w:r><w:br/></w:r>'
      + '<w:r><w:t>First paragraph.</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:pStyle w:val="GitHubNote"/><w:ind w:left="240"/></w:pPr>'
      + '<w:r><w:t>[!NOTE] literal marker text</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('> [!NOTE]\n> First paragraph.');
    // Escaped, which export otherwise took for a second alert's marker
    expect(result.markdown).toContain('> \\[!NOTE] literal marker text');
    const { docx } = await convertMdToDocx(result.markdown);
    expect(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).toContain('[!NOTE] literal marker text');
  });

  test('list-contained inline alert with hard break rewrites to marker-only form', () => {
    const markdown = buildMarkdown(
      [
        { type: 'para', listMeta: { type: 'ordered', level: 0, startNumber: 10 } },
        { type: 'text', text: 'Clinical phrasing:', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
        {
          type: 'para',
          blockquoteLevel: 1,
          alertType: 'note',
          blockquoteGroupIndex: 0,
          listContinuation: { type: 'ordered', level: 0, markerWidth: 4 },
        },
        { type: 'text', text: '※ Note \\\nThis is a note.', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      ],
      new Map(),
      { blockquoteAlertInlineByGroup: new Map([[0, true]]) },
    );

    expect(markdown).toContain('10. Clinical phrasing:\n    > [!NOTE]\n    > This is a note.');
    expect(markdown).not.toContain('10. Clinical phrasing:\n    > [!NOTE] This is a note.');
  });

  test('metadata-free DOCX preserves blank lines around blockquotes structurally', async () => {
    const xml = wrapDocumentXml(
      '<w:p><w:r><w:t>Before paragraph.</w:t></w:r></w:p>'
      + '<w:p/>'
      + '<w:p/>'
      + '<w:p><w:pPr><w:pStyle w:val="GitHubBlockquote"/><w:ind w:left="240"/></w:pPr><w:r><w:t>Quoted line</w:t></w:r></w:p>'
      + '<w:p/>'
      + '<w:p/>'
      + '<w:p><w:r><w:t>After paragraph.</w:t></w:r></w:p>'
    );
    const buf = await buildSyntheticDocx(xml);
    const result = await convertDocx(buf);

    expect(result.markdown).toContain('Before paragraph.\n\n\n> Quoted line');
    expect(result.markdown).toContain('> Quoted line\n\n\nAfter paragraph.');
  });

  test.each([
    ['notes\' definitions', '> Q[^1]\n\n[^1]: Note.'],
    ['notes\' definitions after a paragraph before it', 'P[^1]\n\n> Q\n\n[^1]: Note.'],
    ['notes\' definitions after the next quote', '> A[^1]\n>\n> B\n\n[^1]: N.'],
    ['a quote in a list item', '- a\n\n  > q[^1]\n\n[^1]: N.'],
  ])('adds no blank lines between a quote the body ends with and %s', async (_name, md) => {
    // Export read the blank line before the definitions as one before more
    // of the body, and wrote an empty paragraph for it after the quote,
    // which import wrote as blank lines before its own
    const once = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
    expect(once).toBe(md + '\n');
  });

  test('keeps the blank lines after a quote before the body\'s text after definitions', async () => {
    const md = '> Q\n\n[^1]: Note.\n\n\nP[^1]';
    const once = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
    expect(once).toBe('> Q\n\nP[^1]\n\n[^1]: Note.\n');
  });
});

describe('A quote after a deeper one', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');

  test.each([
    ['a nested quote', '> > q\n>\n> b\n'],
    ['a quote two deep', '> > > q\n> >\n> > b\n>\n> c\n'],
    ['an alert', '> > [!NOTE]\n> > q\n>\n> b\n'],
    ['a nested quote in a list item', '- a\n\n  > > q\n  >\n  > b\n'],
  ])('keeps its text out of %s', async (_name, md) => {
    // Import wrote no line between them, so the shallower quote's text
    // continued the deeper one's paragraph
    const { docx } = await convertMdToDocx(md);
    expect(strip((await convertDocx(docx)).markdown)).toBe(md);
  });

  test.each([
    ['a list item', '- a\n\n  > > q\n> b\n'],
    ['a sublist', '- a\n  - b\n\n    > > q\n  > c\n'],
  ])('writes no line between them where it\'s out of %s the deeper is in', async (_name, md) => {
    // The indent ends the deeper quote
    const { docx } = await convertMdToDocx(md);
    expect(strip((await convertDocx(docx)).markdown)).toBe(md);
  });
});

describe('Blocks a quote can\'t hold', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');

  test.each([
    ['a list', '> - a\n>\n>   b\n> - c\n', '> a\n>\n> b\n>\n> c\n', 'List inside blockquote exported as quote paragraphs'],
    ['a list with a quote in an item', '> - a\n>\n>   > q\n', '> a\n> > q\n', 'List inside blockquote exported as quote paragraphs'],
    ['a heading', '> # h\n>\n> b\n', '> h\n>\n> b\n', 'Heading inside blockquote exported as a quote paragraph'],
    ['a code block', '> a\n>\n> ```\n> c\n> ```\n>\n> b\n', '> a\n>\n> c\n>\n> b\n', 'Code block inside blockquote exported as a quote paragraph'],
    ['a code block in a quote in a list item', '- a\n\n  > ```\n  > c\n  > ```\n', '- a\n\n  > c\n', 'Code block inside blockquote exported as a quote paragraph'],
    ['a table', '> a\n>\n> | t |\n> |---|\n> | u |\n>\n> b\n', '> a\n>\n> b\n', 'Table inside blockquote dropped during conversion'],
    ['an HTML table', '> a\n>\n> <table><tr><td>t</td></tr></table>\n>\n> b\n', '> a\n>\n> b\n', 'Table inside blockquote dropped during conversion'],
    ['a horizontal rule', '> a\n>\n> ---\n>\n> b\n', '> a\n>\n> b\n', 'Horizontal rule inside blockquote dropped during conversion'],
    // Which took the blank lines around the quote, and joined the quote to
    // the paragraph after it
    ['a table that starts the quote', 'p\n\n> | t |\n> |---|\n> | u |\n>\n> q\n', 'p\n\n> q\n', 'Table inside blockquote dropped during conversion'],
    ['a horizontal rule that ends the quote', '> q\n>\n> ---\n\n\np\n', '> q\n\n\np\n', 'Horizontal rule inside blockquote dropped during conversion'],
    ['a table that is all of a nested quote', 'p\n\n\n> > | t |\n> > |---|\n> > | u |\n>\n> b\n', 'p\n\n\n> b\n', 'Table inside blockquote dropped during conversion'],
    // Whose marker line was the rule's, so its text went under it
    ['a horizontal rule before an alert', '> ---\n>\n> [!NOTE] body\n', '> [!NOTE] body\n', 'Horizontal rule inside blockquote dropped during conversion'],
  ])('warns of %s', async (_name, md, expected, warning) => {
    // Export changed or dropped each with no warning, and left an empty
    // paragraph where a table or rule was. A list item's continuation kept
    // the item's indent, and came back as a quote four deep, a quote in the
    // item lost the outer quote's level, and a code block's last line end
    // split the quote in two
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([warning + ' (not supported). Move it outside the quote for round-trip fidelity.']);
    expect(strip((await convertDocx(docx)).markdown)).toBe(expected);
  });
});

describe('Display math in a paragraph\'s text', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  const fence = '$' + '$';
  const math = (prefix: string) => fence + '\n' + prefix + 'x\n' + prefix + fence;

  test.each([
    ['after its text', 'a\n' + math('') + '\n'],
    ['after its text in a quote', '> a\n> ' + math('> ') + '\n'],
    ['after its text in a list item', '- a\n  ' + math('  ') + '\n'],
    ['after a later paragraph\'s text in a list item', '1. a\n\n   b\n   ' + math('   ') + '\n2. c\n'],
    ['first in a list item', '- ' + math('  ') + '\n'],
    ['after a line break', 'a\\\n' + math('') + '\n'],
    ['after an alert\'s marker', '> [!NOTE]\n> ' + math('> ') + '\n'],
    ['after an alert\'s first line', '> [!TIP]\n> a\n> ' + math('> ') + '\n'],
    // An empty run comes before it there
    ['first in a task item', '- [ ] ' + math('  ') + '\n'],
    ['after an alert\'s marker on its line', '> [!NOTE] ' + math('> ') + '\n'],
    // Whose bodies go after the text, before it
    ['after overlapping comments in a quote', '> Seen {#1}a {#2}b{/1} c{/2}\n> {#1>>one<<}\n> {#2>>two<<}\n> ' + math('> ') + '\n'],
    ['in a footnote', 'P[^1]\n\n[^1]:\n\n    Note\n    ' + math('    ') + '\n'],
    ['in a footnote\'s later paragraph', 'P[^1]\n\n[^1]: a\n\n    b\n    ' + math('    ') + '\n'],
    // Its line went after the break's line end, which left a blank line
    ['after a line break in a footnote', 'P[^1]\n\n[^1]:\n\n    a\\\n    ' + math('    ') + '\n'],
  ])('keeps it %s', async (_name, md) => {
    // Import wrote a blank line before it, which ended the paragraph, and
    // the quote or list item around it, out of which the equation went
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['at the top level', ''],
    ['in a quote', '> '],
    ['in a list item', '- '],
  ])('keeps two of Word\'s in a row in their paragraph %s', async (_name, prefix) => {
    // The second went out of the paragraph, and its quote or list item
    const zip = await JSZip.loadAsync((await convertMdToDocx(prefix + 'a**XX**')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const equation = (x: string) => '<m:oMathPara><m:oMath><m:r><m:t>' + x + '</m:t></m:r></m:oMath></m:oMathPara>';
    zip.file('word/document.xml', xml.replace(/<w:r><w:rPr><w:b\/>(?:(?!<\/w:r>).)*XX<\/w:t><\/w:r>/, equation('x') + equation('y')));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    const lines = prefix ? (prefix === '> ' ? '> ' : '  ') : '';
    expect(markdown).toBe(prefix + 'a\n' + lines + math(lines) + '\n' + lines + math(lines).replace('x', 'y') + '\n');
  });

  test('keeps a blank line before one after a heading\'s text', async () => {
    // Which a line can't go on, so the equation came back after it
    const md = '# H\n\n' + math('') + '\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx('# H**XX**')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:r><w:rPr><w:b\/>(?:(?!<\/w:r>).)*XX<\/w:t><\/w:r>/, '<m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>'));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['before a paragraph', '> [!NOTE]\n>\n> a\n'],
    ['before two', '> [!WARNING]\n>\n> a\n>\n> b\n'],
  ])('keeps an alert\'s marker alone in its paragraph %s', async (_name, md) => {
    // Import wrote the marker's line end and the quote's > after it, as
    // for text, which made an empty line of the quote
    expect(await roundTrip(md)).toBe(md);
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
  test.each([
    ['a heading', '```\ncode\n```\n\n## H'],
    ['a level 4 heading', '```\ncode\n```\n\n#### H'],
    ['a bulleted list', '```\ncode\n```\n\n- a'],
    ['a numbered list', '```\ncode\n```\n\n1. a'],
    ['a paragraph', '```\ncode\n```\n\nB.'],
  ])('keeps one blank line between a code block and %s', async (_, md) => {
    const result = await convertDocx((await convertMdToDocx(md)).docx);
    expect(result.markdown.trim()).toBe(md);
  });

  test('keeps an empty paragraph a Word user adds after a code block', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('```\ncode\n```\n\n## H')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:p\b[^>]*><w:pPr><w:spacing w:after="0"\/><\/w:pPr><\/w:p>/, '<w:p/>'));
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown.trim()).toBe('```\ncode\n```\n\n\n\n## H');
  });

  test('keeps an empty paragraph that follows a table, not the code block', async () => {
    // What import makes of the table and what follows, with an empty paragraph before the heading
    const afterTable = async (md: string) => {
      const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file('word/document.xml', xml.replace(/(<w:p\b[^>]*><w:pPr><w:pStyle w:val="Heading2"\/>)/, '<w:p/>$1'));
      const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
      return markdown.slice(markdown.indexOf('| a |'));
    };
    const table = '| a |\n| --- |\n| b |\n\n## H';
    // Right after the fence, with no empty paragraph between
    expect(await afterTable('```\ncode\n```\n' + table)).toBe(await afterTable('Text.\n\n' + table));
  });

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

  test('wrapWithFormatting adds padding when text has leading and trailing spaces', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true };
    expect(wrapWithFormatting(' hello ', fmt)).toBe('`  hello  `');
  });

  test('wrapWithFormatting does not pad all-space content', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true };
    expect(wrapWithFormatting('   ', fmt)).toBe('`   `');
  });

  test.each([' ', '  ', '   ', '     ', ' \t ', ' \u00a0 '])('wrapWithFormatting writes code of %j as code that reads back as it', (text) => {
    // Code of spaces alone reads as it is, as CommonMark has it; ' \t '
    // isn't, and takes padding against losing a space from each end
    const written = wrapWithFormatting(text, { ...DEFAULT_FORMATTING, code: true });
    expect(parseMd('a ' + written + ' b')[0].runs.find(run => run.code)?.text).toBe(text);
  });

  test('wrapWithFormatting strips bold when code is true', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true, bold: true };
    expect(wrapWithFormatting('hello', fmt)).toBe('`hello`');
  });

  test('wrapWithFormatting strips italic when code is true', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true, italic: true };
    expect(wrapWithFormatting('hello', fmt)).toBe('`hello`');
  });
});

describe('Selective escaping for literal HTML-like text', () => {
  test('escapes literal <sup> and </sup> in plain text', () => {
    expect(wrapWithFormatting('x <sup>2</sup>', DEFAULT_FORMATTING)).toBe('x &lt;sup&gt;2&lt;/sup&gt;');
  });

  test.each(['b', 'strong', 'i', 'em', 's', 'del', 'strike'])('escapes literal <%s> in plain text, which reads as formatting', tag => {
    expect(wrapWithFormatting('x <' + tag + '>y</' + tag + '>', DEFAULT_FORMATTING)).toBe('x &lt;' + tag + '&gt;y&lt;/' + tag + '&gt;');
  });

  test('escapes literal table tags in plain text', () => {
    expect(wrapWithFormatting('<table><tr><td>x</td></tr></table>', DEFAULT_FORMATTING))
      .toBe('&lt;table&gt;&lt;tr&gt;&lt;td&gt;x&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;');
  });

  test('does not escape plain inequality angle brackets or ampersand', () => {
    expect(wrapWithFormatting('A < B & C > D', DEFAULT_FORMATTING)).toBe('A < B & C > D');
  });

  test('does not escape non-sensitive tags', () => {
    expect(wrapWithFormatting('A <foo> B', DEFAULT_FORMATTING)).toBe('A <foo> B');
  });
});

describe('Inline code round-trip', () => {
  test('inline code survives MD→DOCX→MD', async () => {
    const md = 'Some `inline code` here';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('Some `inline code` here');
  });

  test('bold inline code strips bold on round-trip', async () => {
    const md = '**`bold code`**';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    // Code runs strip all non-code formatting (bold is incidental in DOCX)
    expect(result.markdown.trim()).toBe('`bold code`');
  });

  test('italic inline code strips italic on round-trip', async () => {
    const md = '*`italic code`*';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    // Code runs strip all non-code formatting (italic is incidental in DOCX)
    expect(result.markdown.trim()).toBe('`italic code`');
  });

  test('inline code containing backticks round-trips correctly', async () => {
    const md = 'Use `` `backtick` `` in code';
    const docxResult = await convertMdToDocx(md);
    const result = await convertDocx(docxResult.docx);
    expect(result.markdown.trim()).toBe('Use `` `backtick` `` in code');
  });
});

// ---------------------------------------------------------------------------
// Track changes (CriticMarkup)
// ---------------------------------------------------------------------------

describe('Track changes (CriticMarkup)', () => {
  const AUTHOR = 'Test Author';
  const DATE = '2024-01-15T10:30:00Z';

  // Helper: wrap document XML with r: namespace for hyperlink tests
  function wrapDocumentXmlWithR(bodyContent: string): string {
    return '<?xml version="1.0"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
      + ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<w:body>' + bodyContent + '</w:body>'
      + '</w:document>';
  }

  // Common revision objects
  const addRev: RevisionInfo = { type: 'addition', author: AUTHOR, date: DATE };
  const delRev: RevisionInfo = { type: 'deletion', author: AUTHOR, date: DATE };

  describe('Parsing', () => {
    test('w:ins creates addition with author/date', async () => {
      const xml = wrapDocumentXml(
        '<w:p><w:ins w:author="Alice" w:date="2024-06-01T00:00:00Z">'
        + '<w:r><w:t>added</w:t></w:r>'
        + '</w:ins></w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('{++added++}');
    });

    test('w:del creates deletion with author/date', async () => {
      const xml = wrapDocumentXml(
        '<w:p><w:del w:author="Bob" w:date="2024-06-01T00:00:00Z">'
        + '<w:r><w:delText>removed</w:delText></w:r>'
        + '</w:del></w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('{--removed--}');
    });

    test('w:delText handled same as w:t inside w:del', async () => {
      const xml = wrapDocumentXml(
        '<w:p><w:del w:author="A" w:date="2024-01-01T00:00:00Z">'
        + '<w:r><w:delText>hello</w:delText></w:r>'
        + '</w:del></w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('{--hello--}');
    });

    test('revision context does not leak to siblings', async () => {
      const xml = wrapDocumentXml(
        '<w:p>'
        + '<w:ins w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>new</w:t></w:r></w:ins>'
        + '<w:r><w:t> normal</w:t></w:r>'
        + '</w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('{++new++} normal');
    });

    test('revision propagates through hyperlinks', async () => {
      const xml = wrapDocumentXmlWithR(
        '<w:p><w:ins w:author="A" w:date="2024-01-01T00:00:00Z">'
        + '<w:hyperlink r:id="rId1"><w:r><w:t>link</w:t></w:r></w:hyperlink>'
        + '</w:ins></w:p>'
      );
      const relsXml = '<?xml version="1.0"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>'
        + '</Relationships>';
      const buf = await buildSyntheticDocx(xml, { 'word/_rels/document.xml.rels': relsXml });
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('{++[link](https://example.com)++}');
    });

    test.each([
      'P {--A [a](https://e.com/ab) B--} Q.',
      'P {~~[a](https://e.com/ab)~>z~~} Q.',
      'P {=={--[a](https://e.com/ab)--}==}{>>c<<} Q.',
      'P[^1] Q.\n\n[^1]: N {--[a](https://e.com/n)--} x.',
    ])('keeps a deleted link in %j a link', async (md) => {
      // Export wrote its runs without their hyperlink
      const result = await convertDocx((await convertMdToDocx(md)).docx);
      expect(result.markdown.replace(/^---\n[\s\S]*?\n---\n/, '')).toBe(md + '\n');
    });

    test('revision in footnote body', async () => {
      const docXml = wrapDocumentXml(
        '<w:p><w:r><w:t>Text</w:t></w:r>'
        + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
      );
      const footnotesXml = wrapNotesXml('footnotes',
        '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>'
        + '<w:ins w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t> added note</w:t></w:r></w:ins>'
        + '</w:p></w:footnote>'
      );
      const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
      const result = await convertDocx(buf);
      expect(result.markdown).toContain('[^1]: {++ added note++}');
    });

    test('revision in endnote body', async () => {
      const docXml = wrapDocumentXml(
        '<w:p><w:r><w:t>Text</w:t></w:r>'
        + '<w:r><w:endnoteReference w:id="1"/></w:r></w:p>'
      );
      const endnotesXml = wrapNotesXml('endnotes',
        '<w:endnote w:id="1"><w:p><w:r><w:endnoteRef/></w:r>'
        + '<w:del w:author="B" w:date="2024-02-01T00:00:00Z"><w:r><w:delText> old note</w:delText></w:r></w:del>'
        + '</w:p></w:endnote>'
      );
      const buf = await buildSyntheticDocx(docXml, { 'word/endnotes.xml': endnotesXml });
      const result = await convertDocx(buf);
      expect(result.markdown).toContain('[^1]: {-- old note--}');
    });

    test('w:moveTo creates addition', async () => {
      const xml = wrapDocumentXml(
        '<w:p><w:moveTo w:author="Alice" w:date="2024-06-01T00:00:00Z">'
        + '<w:r><w:t>moved here</w:t></w:r>'
        + '</w:moveTo></w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('{++moved here++}');
    });

    test('w:moveFrom creates deletion', async () => {
      const xml = wrapDocumentXml(
        '<w:p><w:moveFrom w:author="Bob" w:date="2024-06-01T00:00:00Z">'
        + '<w:r><w:delText>moved away</w:delText></w:r>'
        + '</w:moveFrom></w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('{--moved away--}');
    });

    test('w:moveFrom handles w:t as well as w:delText', async () => {
      const xml = wrapDocumentXml(
        '<w:p><w:moveFrom w:author="A" w:date="2024-01-01T00:00:00Z">'
        + '<w:r><w:t>hello</w:t></w:r>'
        + '</w:moveFrom></w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('{--hello--}');
    });

    test('w:moveTo in footnote body', async () => {
      const docXml = wrapDocumentXml(
        '<w:p><w:r><w:t>Text</w:t></w:r>'
        + '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
      );
      const footnotesXml = wrapNotesXml('footnotes',
        '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>'
        + '<w:moveTo w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t> moved note</w:t></w:r></w:moveTo>'
        + '</w:p></w:footnote>'
      );
      const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
      const result = await convertDocx(buf);
      expect(result.markdown).toContain('[^1]: {++ moved note++}');
    });

    test('w:moveFrom revision context does not leak to siblings', async () => {
      const xml = wrapDocumentXml(
        '<w:p>'
        + '<w:moveFrom w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:moveFrom>'
        + '<w:r><w:t> normal</w:t></w:r>'
        + '</w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('{--gone--} normal');
    });

    test('moveFrom range markers are harmless', async () => {
      const xml = wrapDocumentXml(
        '<w:p>'
        + '<w:moveFromRangeStart w:id="0" w:name="move1"/>'
        + '<w:r><w:t>normal</w:t></w:r>'
        + '<w:moveFromRangeEnd w:id="0"/>'
        + '</w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('normal');
    });

    test('moveTo range markers are harmless', async () => {
      const xml = wrapDocumentXml(
        '<w:p>'
        + '<w:moveToRangeStart w:id="1" w:name="move1"/>'
        + '<w:r><w:t>normal</w:t></w:r>'
        + '<w:moveToRangeEnd w:id="1"/>'
        + '</w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown.trim()).toBe('normal');
    });
  });

  describe('Rendering', () => {
    test('text addition renders {++text++}', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'added', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: addRev },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('{++added++}');
    });

    test('text deletion renders {--text--}', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'removed', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: delRev },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('{--removed--}');
    });

    test('bold inside addition', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'bold', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, bold: true }, revision: addRev },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('{++**bold**++}');
    });

    test('italic inside deletion', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'italic', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, italic: true }, revision: delRev },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('{--*italic*--}');
    });

    test('footnote ref with addition revision', async () => {
      const docXml = wrapDocumentXml(
        '<w:p><w:ins w:author="A" w:date="2024-01-01T00:00:00Z">'
        + '<w:r><w:footnoteReference w:id="1"/></w:r>'
        + '</w:ins></w:p>'
      );
      const footnotesXml = wrapNotesXml('footnotes',
        '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> A note.</w:t></w:r></w:p></w:footnote>'
      );
      const buf = await buildSyntheticDocx(docXml, { 'word/footnotes.xml': footnotesXml });
      const result = await convertDocx(buf);
      expect(result.markdown).toContain('{++[^1]++}');
    });

    test('substitution: same author+date renders {~~old~>new~~}', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'old', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: delRev },
        { type: 'text', text: 'new', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: addRev },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('{~~old~>new~~}');
    });

    test('substitution with formatting', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'old', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, bold: true }, revision: delRev },
        { type: 'text', text: 'new', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, italic: true }, revision: addRev },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('{~~**old**~>*new*~~}');
    });

    test('substitution NOT triggered when authors differ', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'old', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: { type: 'deletion', author: 'Alice', date: DATE } },
        { type: 'text', text: 'new', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: { type: 'addition', author: 'Bob', date: DATE } },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('{--old--}{++new++}');
    });

    test('substitution NOT triggered when dates differ', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'old', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: { type: 'deletion', author: AUTHOR, date: '2024-01-01T00:00:00Z' } },
        { type: 'text', text: 'new', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: { type: 'addition', author: AUTHOR, date: '2024-12-31T00:00:00Z' } },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('{--old--}{++new++}');
    });

    test('substitution skipped when comment IDs present', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'old', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING, revision: delRev },
        { type: 'text', text: 'new', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING, revision: addRev },
      ];
      const comments = new Map([['c1', { author: 'R', text: 'review', date: '' } as any]]);
      const md = buildMarkdown(content, comments);
      // Should render separately (not as substitution) because comment IDs are present
      expect(md).toContain('{--old--}');
      expect(md).toContain('{++new++}');
      expect(md).not.toContain('{~~');
    });

    test('mixed revisions in same paragraph', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'keep ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
        { type: 'text', text: 'removed', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: delRev },
        { type: 'text', text: ' still here ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
        { type: 'text', text: 'added', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: addRev },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('keep {--removed--} still here {++added++}');
    });

    test('inline math with revision', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'math', latex: 'x^2', display: false, commentIds: new Set(), revision: addRev },
      ];
      const md = buildMarkdown(content, new Map());
      expect(md.trim()).toBe('{++$x^2$++}');
    });

    test('a deleted paragraph mark after deleted text imports inside the deletion', async () => {
      const deletedMark = '<w:pPr><w:rPr><w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr></w:pPr>';
      const deletedRun = (text: string) => '<w:del w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>' + text + '</w:delText></w:r></w:del>';
      const body = async (xml: string) => (await convertDocx(await buildSyntheticDocx(wrapDocumentXml(xml)))).markdown
        .replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      expect(await body(
        '<w:p>' + deletedMark + '<w:r><w:t>Keep </w:t></w:r>' + deletedRun('cut') + '</w:p>'
        + '<w:p>' + deletedRun('more') + '<w:r><w:t> kept</w:t></w:r></w:p>',
      )).toBe('Keep {--cut\n\nmore--} kept');
      // Word joins all three paragraphs on Accept All
      expect(await body(
        '<w:p>' + deletedMark + '<w:r><w:t>A </w:t></w:r>' + deletedRun('x') + '</w:p>'
        + '<w:p>' + deletedMark + deletedRun('B') + '</w:p>'
        + '<w:p><w:r><w:t>C</w:t></w:r></w:p>',
      )).toBe('A {--x\n\nB\n\n--}C');
      // Export moves a break that opens a span outside it, so a break with no
      // deleted text before it stays an ordinary paragraph break
      expect(await body('<w:p>' + deletedMark + '<w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p>'))
        .toBe('Hello\n\nWorld');
      // A deleted heading's mark keeps its own handling
      expect(await body('<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:rPr><w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr></w:pPr>'
        + deletedRun('Gone') + '</w:p><w:p><w:r><w:t>Kept</w:t></w:r></w:p>')).toBe('{--# Gone--}\n\nKept');
    });

    test('CriticMarkup inside math survives a round trip', async () => {
      const fence = '$'.repeat(2);
      for (const md of [
        'See $a {++b++} c$ here.', 'See $a {--b--} c$ here.', 'See $a {~~b~>d~~} c$ here.',
        'See $x = {++\\frac{1}{2}++} + y$ here.',
        // A change inside a structure, as import writes Word's edits to one
        'See $x^{{++2++}}$ here.', 'See $\\frac{a}{{--b--} c}$ here.', 'See $x_{{++i++}}^{{~~2~>3~~}}$ here.',
        'See $\\text{a } {++\\text{b c}++} \\text{ d}$ here.',
        // Spacing around the markup stays as written
        'See $a{++b++}c$ here.', 'See $a\u2003{++b++}c$ here.', 'See $\\alpha{}{++x++}$ here.', 'See ${++\\alpha++}{}x$ here.', 'See $x{~~\\beta~>\\alpha~~}{}y$ here.',
        // An equation that's only a tracked space keeps it
        'See ${++ ++}$ here.', 'See ${-- --}$ here.',
        'See $\\left\\langle{}x\\right\\rangle{}{++y++}$ here.',
        // A script binds to what's before it once the change is accepted or rejected
        'See $x^{{++2++}}{+++y^3++}$ here.', 'See $x{++y^3++}{--z--}$ here.',
        // An equation Word can't track in part comes back replaced
        'See ${~~\\sqrt[3]{x}~>\\sqrt[4]{x}~~}$ here.',
        // A LaTeX comment's braces aren't structure
        'See $\\frac{{++a % }\nb++}}{c}$ here.',
        'Text\n\n' + fence + '\na {++b++} c\n' + fence + '\n\nmore', 'Text\n\n' + fence + '\na {~~b~>d~~} c\n' + fence + '\n\nmore',
        // Whole tracked equations next to other equations keep their boundaries
        'See {~~$b$~>$d$~~} here.', 'See {++$b$++}$c$ here.', 'See {++$a$++}{--$b$--} here.',
      ]) {
        const { docx } = await convertMdToDocx(md);
        const imported = (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
        expect(imported).toBe(md);
      }
    });

    test('display math with revision', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'math', latex: 'E=mc^2', display: true, commentIds: new Set(), revision: delRev },
      ];
      const md = buildMarkdown(content, new Map());
      // Display math inside deletion markers
      expect(md).toContain('{--');
      expect(md).toContain('E=mc^2');
      expect(md).toContain('--}');
    });

    test('image with addition revision', async () => {
      const docXml = wrapDocumentXml(
        '<w:p><w:ins w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:drawing>'
        + '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
        + '<wp:extent cx="914400" cy="914400"/>'
        + '<wp:docPr name="img" descr="test image"/>'
        + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + '<pic:blipFill><a:blip r:embed="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></pic:blipFill>'
        + '</pic:pic></a:graphicData></a:graphic></wp:inline>'
        + '</w:drawing></w:r></w:ins></w:p>'
      );
      const relsXml = '<?xml version="1.0"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
        + '</Relationships>';
      const buf = await buildSyntheticDocx(docXml, { 'word/_rels/document.xml.rels': relsXml });
      const result = await convertDocx(buf);
      expect(result.markdown).toContain('{++');
      expect(result.markdown).toContain('test image');
      expect(result.markdown).toContain('++}');
    });

    test('revision inside grouped comment path (ID-based)', () => {
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'commented', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING, revision: addRev },
        { type: 'text', text: ' also', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING },
      ];
      const comments = new Map([['c1', { author: 'Rev', text: 'note', date: '', replies: [] } as any]]);
      const md = buildMarkdown(content, comments);
      expect(md).toContain('{++commented++}');
    });
  });

  describe('Integration', () => {
    test('multi-change document with mixed substitution/separate markers', async () => {
      const xml = wrapDocumentXml(
        '<w:p>'
        + '<w:r><w:t>Before </w:t></w:r>'
        // substitution pair — same author+date
        + '<w:del w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>old</w:delText></w:r></w:del>'
        + '<w:ins w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>new</w:t></w:r></w:ins>'
        + '<w:r><w:t> middle </w:t></w:r>'
        // separate — different authors
        + '<w:del w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del>'
        + '<w:ins w:author="B" w:date="2024-01-01T00:00:00Z"><w:r><w:t>arrived</w:t></w:r></w:ins>'
        + '<w:r><w:t> after</w:t></w:r>'
        + '</w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      const md = result.markdown.trim();
      // First pair: substitution
      expect(md).toContain('{~~old~>new~~}');
      // Second pair: separate markers (different authors)
      expect(md).toContain('{--gone--}');
      expect(md).toContain('{++arrived++}');
    });

    test('track changes across multiple paragraphs', async () => {
      const xml = wrapDocumentXml(
        '<w:p><w:ins w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>First added</w:t></w:r></w:ins></w:p>'
        + '<w:p><w:del w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>Second removed</w:delText></w:r></w:del></w:p>'
        + '<w:p><w:r><w:t>Third normal</w:t></w:r></w:p>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown).toContain('{++First added++}');
      expect(result.markdown).toContain('{--Second removed--}');
      expect(result.markdown).toContain('Third normal');
    });

    test('revision inside table cell', async () => {
      const xml = wrapDocumentXml(
        '<w:tbl>'
        + '<w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>'
        + '<w:tblGrid><w:gridCol w:w="5000"/><w:gridCol w:w="5000"/></w:tblGrid>'
        + '<w:tr>'
        + '<w:tc><w:p><w:r><w:t>Header 1</w:t></w:r></w:p></w:tc>'
        + '<w:tc><w:p><w:r><w:t>Header 2</w:t></w:r></w:p></w:tc>'
        + '</w:tr>'
        + '<w:tr>'
        + '<w:tc><w:p><w:ins w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>added cell</w:t></w:r></w:ins></w:p></w:tc>'
        + '<w:tc><w:p><w:del w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>removed cell</w:delText></w:r></w:del></w:p></w:tc>'
        + '</w:tr>'
        + '</w:tbl>'
      );
      const buf = await buildSyntheticDocx(xml);
      const result = await convertDocx(buf);
      expect(result.markdown).toContain('{++added cell++}');
      expect(result.markdown).toContain('{--removed cell--}');
    });
  });
});

describe('extractBibKeyOrder', () => {
  // Key order includes all entries from the .bib, not just cited ones.
  // This preserves uncited entries across round-trips.
  test('reads chunked MANUSCRIPT_BIB_KEY_ORDER_* from DOCX ZIP (includes uncited keys)', async () => {
    const bib = '@article{key1,\n  author = {A},\n}\n\n@article{key2,\n  author = {B},\n}';
    // Only key1 is cited, but key2 is still in the bib — both keys should be stored
    const { docx } = await convertMdToDocx('Hello [@key1].', { bibtex: bib });
    const result = await extractBibKeyOrder(docx);
    expect(result).toEqual(['key1', 'key2']);
  });

  test('returns null when no bib key order is stored', async () => {
    const { docx } = await convertMdToDocx('Hello world.');
    const result = await extractBibKeyOrder(docx);
    expect(result).toBeNull();
  });
});

describe('extractBibData', () => {
  test('reads .bib data from DOCX custom properties (round-trip)', async () => {
    const bib = '@article{key1,\n  author = {A},\n}\n\n@article{key2,\n  author = {B},\n}';
    const { docx } = await convertMdToDocx('Hello [@key1].', { bibtex: bib });
    const result = await extractBibData(docx);
    expect(result).not.toBeNull();
    expect(result).toContain('@article{key1,');
    expect(result).toContain('@article{key2,');
  });

  test('returns null when no .bib was provided', async () => {
    const { docx } = await convertMdToDocx('Hello world.');
    const result = await extractBibData(docx);
    expect(result).toBeNull();
  });

  test('uncited entries survive round-trip via stored .bib data', async () => {
    const bib = '@article{cited1,\n  author = {A},\n  title = {{Title A}},\n  year = {2020},\n}\n\n@article{uncited1,\n  author = {B},\n  title = {{Uncited Entry}},\n  year = {2021},\n}';
    const md = 'Some text [@cited1].\n';
    const { docx } = await convertMdToDocx(md, { bibtex: bib });
    // Round-trip: convert DOCX back to markdown
    const result = await convertDocx(docx, 'authorYearTitle');
    // Layer 1 (stored .bib data) should preserve the uncited entry
    expect(result.bibtex).toContain('@article{uncited1,');
    expect(result.bibtex).toContain('Uncited Entry');
  });

  test('new Zotero entries (added in Word) are appended to stored .bib', async () => {
    // Use sampleData which has Zotero citations (smith2020, jones2019, davis2021)
    // but no stored .bib data — add stored .bib data manually
    const storedBib = '@article{myentry,\n  author = {Custom, Author},\n  title = {{My Custom Entry}},\n  year = {2022},\n}';
    const { docx } = await convertMdToDocx('Text [@myentry].', { bibtex: storedBib });
    const result = await convertDocx(docx, 'authorYearTitle');
    // Stored entry preserved via Layer 1
    expect(result.bibtex).toContain('@article{myentry,');
    expect(result.bibtex).toContain('My Custom Entry');
  });

  test('XML-special characters in .bib survive chunked property round-trip', async () => {
    const bib = '@article{special1,\n  author = {O\'Brien, J. & Partners},\n  title = {{Results for x < 50 & y > 100}},\n  year = {2020},\n}';
    const { docx } = await convertMdToDocx('Text [@special1].', { bibtex: bib });
    const result = await extractBibData(docx);
    expect(result).toBe(bib);
  });

  test('TeX accents in stored .bib source survive DOCX round-trip exactly', async () => {
    const bib = String.raw`@article{muller2024,
  author = {M{\"u}ller, Jane},
  title = {Caf\'{e} research},
  year = {2024},
}`;
    const { docx } = await convertMdToDocx('Text [@muller2024].', { bibtex: bib });
    const stored = await extractBibData(docx);
    expect(stored).toBe(bib);

    const roundTrip = await convertDocx(docx);
    expect(roundTrip.bibtex).toBe(bib);
  });
});

describe('extractBibliographyPath', () => {
  test('reads bibliography path from DOCX custom properties', async () => {
    const md = '---\nbibliography: ../correspondence.bib\ncsl: bmj\n---\n\nText [@key1].';
    const bib = '@article{key1,\n  author = {A},\n  year = {2020},\n}';
    const { docx } = await convertMdToDocx(md, { bibtex: bib });
    expect(await extractBibliographyPath(docx)).toBe('../correspondence.bib');
  });

  test('convertDocx falls back to preferred bibliography path when DOCX has none stored', async () => {
    const md = 'Text [@key1].';
    const bib = '@article{key1,\n  author = {A},\n  year = {2020},\n}';
    const { docx } = await convertMdToDocx(md, { bibtex: bib });
    const result = await convertDocx(docx, 'authorYearTitle', {
      preferredBibliographyPath: '../correspondence.bib',
    });
    expect(result.markdown).toContain('bibliography: ../correspondence.bib');
  });
});

describe('convertDocx existingBibtex (post-processing merge)', () => {
  const EXISTING_BIB = `@article{smith2020,
  author = {Smith, Alice},
  title = {{Effects of climate on agriculture}},
  year = {2020},
}

@article{uncitedEntry,
  author = {Nobody, X},
  title = {{Not cited anywhere}},
  year = {2000},
}`;

  test('uses existingBibtex when no stored .bib in ZIP', async () => {
    // sampleData has Zotero citations but no stored .bib or key order
    const result = await convertDocx(sampleData, 'authorYearTitle', {
      existingBibtex: EXISTING_BIB,
    });
    // Should contain the existing .bib content verbatim (including uncited entry)
    expect(result.bibtex).toContain('uncitedEntry');
    expect(result.bibtex).toContain('Not cited anywhere');
    // The existing smith2020 entry should be from the existing .bib, not regenerated
    expect(result.bibtex).toContain('@article{smith2020,');
  });

  test('merges key order (Layer 2) with existingBibtex', async () => {
    const storedBib = '@article{key1,\n  author = {A, X},\n  title = {{Title A}},\n  year = {2020},\n}\n\n@article{key2,\n  author = {B, Y},\n  title = {{Title B}},\n  year = {2021},\n}';
    const md = 'Some text [@key1].\n';
    const { docx } = await convertMdToDocx(md, { bibtex: storedBib });
    // Strip MANUSCRIPT_BIB_DATA_* props so Layer 1 is unavailable and Layer 2 kicks in
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const customXml = await zip.file('docProps/custom.xml')!.async('string');
    const stripped = customXml.replace(/<property[^>]*name="MANUSCRIPT_BIB_DATA_[^"]*"[^>]*>[\s\S]*?<\/property>/g, '');
    zip.file('docProps/custom.xml', stripped);
    const modifiedDocx = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const result = await convertDocx(modifiedDocx, 'authorYearTitle', {
      existingBibtex: EXISTING_BIB,
    });
    // Layer 2 regenerates from Zotero metadata — should contain the cited key
    expect(result.bibtex).toContain('key1');
    // Existing-only entries are also preserved (merge, not preference)
    expect(result.bibtex).toContain('uncitedEntry');
    expect(result.bibtex).toContain('Not cited anywhere');
  });

  test('appends new Zotero entries not in existing .bib', async () => {
    // sampleData has smith2020, jones2019, davis2021 Zotero citations.
    // Provide existing .bib with only smith2020 — jones2019 and davis2021 should be appended.
    const partialBib = '@article{smith2020effects,\n  author = {Smith, Alice},\n  title = {{Effects}},\n  year = {2020},\n}';
    const result = await convertDocx(sampleData, 'authorYearTitle', {
      existingBibtex: partialBib,
    });
    // Existing entry preserved
    expect(result.bibtex).toContain('@article{smith2020effects,');
    // New entries appended (jones and davis keys from Zotero regeneration)
    expect(result.bibtex).toContain('jones2019');
    expect(result.bibtex).toContain('davis2021');
  });
});

describe('Landscape section round-trip', () => {
  test('fence-based landscape round-trips through MD→DOCX→MD', async () => {
    const md = 'Before\n\n<!-- landscape -->\n\nTable title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nTable note\n\n<!-- /landscape -->\n\nAfter';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- landscape -->');
    expect(result.markdown).toContain('<!-- /landscape -->');
    expect(result.markdown).toContain('Table title');
    expect(result.markdown).toContain('Table note');
    expect(result.markdown).toContain('Before');
    expect(result.markdown).toContain('After');
  });

  test('data-orientation="landscape" on HTML table round-trips', async () => {
    const md = '<table data-orientation="landscape">\n<tr><th>H</th></tr>\n<tr><td>D</td></tr>\n</table>';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('data-orientation="landscape"');
  });

  test('<!-- table-orientation: landscape --> directive round-trips for pipe table', async () => {
    const md = '<!-- table-orientation: landscape -->\n\n| A | B |\n| - | - |\n| 1 | 2 |';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('table-orientation: landscape');
    expect(result.markdown).toContain('| A |');
  });

  test('landscape DOCX section produces body sectPr with page dimensions', async () => {
    const md = '<!-- landscape -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<!-- /landscape -->';
    const { docx } = await convertMdToDocx(md);
    // Verify the OOXML has landscape section properties
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:orient="landscape"');
    expect(docXml).toContain('w:w="15840"');
    expect(docXml).toContain('w:h="12240"');
  });

  test('body-level sectPr is emitted even without landscape sections', async () => {
    const md = 'Simple paragraph';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    // Should have a closing sectPr with US Letter portrait dimensions
    // Extract final sectPr block and verify it contains expected page dimensions
    const sectPrMatch = docXml.match(/<w:sectPr[^>]*>[\s\S]*?<\/w:sectPr>\s*<\/w:body>/);
    expect(sectPrMatch).not.toBeNull();
    expect(sectPrMatch![0]).toContain('w:w="12240"');
    expect(sectPrMatch![0]).toContain('w:h="15840"');
  });
});

describe('A section at the start of the document', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);

  test.each([
    ['a landscape section', '<!-- landscape -->\n\nText.\n\n<!-- /landscape -->\n\nAfter.'],
    ['a portrait section', '<!-- portrait -->\n\nText.\n\n<!-- /portrait -->\n\nAfter.'],
    ['a landscape section with no blank lines', '<!-- landscape -->\nText.\n<!-- /landscape -->'],
    ['comment ranges in a landscape section', '<!-- landscape -->\n\nSeen {#1}a {#2}b{/1} c{/2} on.\n{#1>>one<<}\n{#2>>two<<}\n\n<!-- /landscape -->'],
  ])('keeps the opener of %s apart from its first paragraph', async (_, md) => {
    // Its first paragraph has no paragraph marker of its own on import
    expect(await roundTrip(md)).toBe(md);
  });

  test('adds no blank line before display math that opens it', async () => {
    // Without the custom property for sentinel gaps, as for a Word document
    const fence = '$' + '$';
    const zip = await JSZip.loadAsync((await convertMdToDocx('<!-- landscape -->\n\n' + fence + '\nx^2\n' + fence + '\n\n<!-- /landscape -->')).docx);
    zip.remove('docProps/custom.xml');
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toStartWith('<!-- landscape -->\n\n' + fence + '\nx^2');
  });
});

describe('A section break on the last paragraph of its section', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  // Moves each section break from its empty carrier onto the paragraph
  // before, as Word does when the carrier is deleted
  const withoutCarriers = async (md: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(
      /(<w:p\b[^>]*>)(<w:pPr>((?:(?!<\/w:pPr>).)*)<\/w:pPr>)?((?:(?!<w:p[ >]).)*?<\/w:p>)<w:p\b[^>]*><w:pPr>(<w:sectPr\b(?:(?!<\/w:sectPr>).)*<\/w:sectPr>)<\/w:pPr><\/w:p>/g,
      (_m, open, _pPr, props, rest, sectPr) => open + '<w:pPr>' + (props ?? '') + sectPr + '</w:pPr>' + rest));
    return strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };

  test.each([
    ['a landscape section', '<!-- landscape -->\n\nText.\n\n<!-- /landscape -->\n\nAfter.'],
    ['two paragraphs', 'Before.\n\n<!-- landscape -->\n\nA.\n\nB.\n\n<!-- /landscape -->\n\nAfter.'],
    ['a heading', 'Before.\n\n<!-- landscape -->\n\n## Head\n\n<!-- /landscape -->\n\nAfter.'],
    ['a list', 'A.\n\n<!-- landscape -->\n\n- x\n- y\n\n<!-- /landscape -->\n\nC.'],
    ['a portrait section', 'A.\n\n<!-- portrait -->\n\nB.\n\n<!-- /portrait -->\n\nC.'],
  ])('keeps the paragraphs and fences of %s', async (_, md) => {
    expect(await withoutCarriers(md)).toBe(md);
  });

  test('takes a carrier with an empty run for an empty carrier', async () => {
    // A table with its own orientation, which needs no fences
    const md = 'A.\n\n<table data-orientation="landscape">\n<tr><td>a</td></tr>\n</table>\n\nC.';
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/(<w:sectPr\b[\s\S]*?<\/w:sectPr><\/w:pPr>)(<\/w:p>)/g, '$1<w:r><w:t/></w:r>$2'));
    const withEmptyRuns = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(withEmptyRuns).toBe(strip((await convertDocx(docx)).markdown));
  });

  test('adds no blank lines before an HTML comment that opens it', async () => {
    // Without the custom property for sentinel gaps, as for a Word document
    const zip = await JSZip.loadAsync((await convertMdToDocx('<!-- landscape -->\n<!-- note -->\nText.\n<!-- /landscape -->')).docx);
    zip.remove('docProps/custom.xml');
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toStartWith('<!-- landscape -->\n<!-- note -->\n');
  });
});

describe('Portrait section round-trip', () => {
  test('fence-based portrait round-trips through MD→DOCX→MD', async () => {
    const md = 'Before\n\n<!-- portrait -->\n\nTable title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nTable note\n\n<!-- /portrait -->\n\nAfter';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- portrait -->');
    expect(result.markdown).toContain('<!-- /portrait -->');
    expect(result.markdown).toContain('Table title');
    expect(result.markdown).toContain('Table note');
    expect(result.markdown).toContain('Before');
    expect(result.markdown).toContain('After');
  });

  test('data-orientation="portrait" on HTML table round-trips', async () => {
    const md = '<table data-orientation="portrait">\n<tr><th>H</th></tr>\n<tr><td>D</td></tr>\n</table>';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('data-orientation="portrait"');
  });

  test('<!-- table-orientation: portrait --> directive round-trips for pipe table', async () => {
    const md = '<!-- table-orientation: portrait -->\n\n| A | B |\n| - | - |\n| 1 | 2 |';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('table-orientation: portrait');
    expect(result.markdown).toContain('| A |');
  });

  test('portrait DOCX section uses portrait dimensions (no landscape orient)', async () => {
    const md = '<!-- portrait -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<!-- /portrait -->';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).not.toContain('w:orient="landscape"');
    // All section breaks should have portrait dimensions
    const pgSzMatches = docXml.match(/<w:pgSz[^/]*\/>/g) || [];
    for (const m of pgSzMatches) {
      expect(m).toContain('w:w="12240"');
      expect(m).toContain('w:h="15840"');
    }
  });

  test('mixed landscape then portrait round-trips correctly', async () => {
    const md = '<!-- landscape -->\n\nLandscape content\n\n<!-- /landscape -->\n\n<!-- portrait -->\n\nPortrait content\n\n<!-- /portrait -->';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- landscape -->');
    expect(result.markdown).toContain('<!-- /landscape -->');
    expect(result.markdown).toContain('<!-- portrait -->');
    expect(result.markdown).toContain('<!-- /portrait -->');
    expect(result.markdown).toContain('Landscape content');
    expect(result.markdown).toContain('Portrait content');
  });

  test('mixed portrait then landscape round-trips correctly', async () => {
    const md = '<!-- portrait -->\n\nPortrait content\n\n<!-- /portrait -->\n\n<!-- landscape -->\n\nLandscape content\n\n<!-- /landscape -->';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- portrait -->');
    expect(result.markdown).toContain('<!-- /portrait -->');
    expect(result.markdown).toContain('<!-- landscape -->');
    expect(result.markdown).toContain('<!-- /landscape -->');
  });

  test('consecutive portrait blocks round-trip without blank pages', async () => {
    const md = 'Before\n\n<!-- portrait -->\n\nBlock 1\n\n<!-- /portrait -->\n\n<!-- portrait -->\n\nBlock 2\n\n<!-- /portrait -->\n\nAfter';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('Block 1');
    expect(result.markdown).toContain('Block 2');
    // Should have two portrait open/close pairs
    const openCount = (result.markdown.match(/<!-- portrait -->/g) || []).length;
    const closeCount = (result.markdown.match(/<!-- \/portrait -->/g) || []).length;
    expect(openCount).toBe(2);
    expect(closeCount).toBe(2);

    // DOCX-level verification: check section breaks have portrait dimensions
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    // Portrait sections: w:w="12240" w:h="15840", no orient attribute
    const sectPrMatches = docXml.match(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g) || [];
    // At least 2 paragraph-level sectPr for the two portrait close breaks
    const portraitSectPrs = sectPrMatches.filter(s =>
      s.includes('w:w="12240"') && s.includes('w:h="15840"') && !s.includes('w:orient="landscape"')
    );
    expect(portraitSectPrs.length).toBeGreaterThanOrEqual(2);
  });

  test('consecutive landscape blocks round-trip with DOCX verification', async () => {
    const md = 'Before\n\n<!-- landscape -->\n\nBlock A\n\n<!-- /landscape -->\n\n<!-- landscape -->\n\nBlock B\n\n<!-- /landscape -->\n\nAfter';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('Block A');
    expect(result.markdown).toContain('Block B');
    const openCount = (result.markdown.match(/<!-- landscape -->/g) || []).length;
    const closeCount = (result.markdown.match(/<!-- \/landscape -->/g) || []).length;
    expect(openCount).toBe(2);
    expect(closeCount).toBe(2);

    // DOCX-level verification: check section breaks have landscape dimensions
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    const sectPrMatches = docXml.match(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g) || [];
    // Landscape sections: w:orient="landscape" with w:w="15840" w:h="12240"
    const landscapeSectPrs = sectPrMatches.filter(s =>
      s.includes('w:orient="landscape"') && s.includes('w:w="15840"') && s.includes('w:h="12240"')
    );
    expect(landscapeSectPrs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('round-trip regression: image path preservation', () => {
  // Minimal 1x1 white PNG (67 bytes)
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
    'Nl7BcQAAAABJRU5ErkJggg==', 'base64');

  test('image with directory components round-trips full path', async () => {
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(join(tmpDir, 'output'), { recursive: true });
    writeFileSync(join(tmpDir, 'output', 'figure_1.png'), TINY_PNG);
    try {
      // markdown references image relative to a subdir
      const md = '![alt text](output/figure_1.png){width=200 height=150}\n';
      const { docx } = await convertMdToDocx(md, { sourceDir: tmpDir });
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('![alt text](output/figure_1.png)');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('deleted image round-trips', async () => {
    // A deletion left its image out
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img4-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'image.png'), TINY_PNG);
    try {
      const md = 'A {--![alt](image.png){width=100 height=100}--} b.\n';
      const { docx } = await convertMdToDocx(md, { sourceDir: tmpDir });
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml).toMatch(/<w:del\b[^>]*><w:r><w:drawing>/);
      const result = await convertDocx(docx);
      expect(result.markdown).toContain(md);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['', '{==![](image.png){width=100 height=100}==}{>>c<<}'],
    [' and text', 'a {==![](image.png){width=100 height=100} b==}{>>c<<}'],
    [' in a table', '| a |\n| --- |\n| {==![](image.png){width=100 height=100}==}{>>c<<} |'],
  ])('keeps a comment over an image%s', async (_name, md) => {
    // A comment over only an image lost its range, and one over more took ID syntax
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img-comment-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'image.png'), TINY_PNG);
    try {
      const { docx } = await convertMdToDocx(md, { sourceDir: tmpDir });
      expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/>>[^<]*<</g, '>>c<<'))
        .toBe(md + '\n');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['a footnote', 'Text.[^1]\n\n[^1]: a ![x](image.png){width=100 height=100} b'],
    ['an endnote', '---\nnotes: endnotes\n---\n\nText.[^1]\n\n[^1]: ![x](image.png){width=100 height=100}'],
    ['a note\'s table', 'Text.[^1]\n\n[^1]: Note.\n\n    | a |\n    | --- |\n    | ![x](image.png){width=100 height=100} |'],
    ['a note, as HTML, after an image in Markdown', '![y](image.png){width=100 height=100}\n\nText.[^1]\n\n[^1]: <img src="image.png" alt="x" width="100" height="100">'],
    ['a note, in Markdown, after an image as HTML', '<img src="image.png" alt="y" width="100" height="100">\n\nText.[^1]\n\n[^1]: ![x](image.png){width=100 height=100}'],
  ])('keeps an image in %s', async (_name, md) => {
    // Import read no images in notes, and gave a note's image the format
    // of the document's image with its relationship ID
    const tmpDir = join(require('os').tmpdir(), 'mms-test-note-img-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'image.png'), TINY_PNG);
    try {
      const { docx } = await convertMdToDocx(md, { sourceDir: tmpDir });
      const result = await convertDocx(docx);
      expect(result.markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')).toBe(md.replace(/^---\n[\s\S]*?\n---\n\n/, '') + '\n');
      expect([...(result.images?.keys() ?? [])]).toEqual(['image.png']);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['in the document', '![a](a/x.png){width=100 height=100} ![b](b/x.png){width=100 height=100}'],
    ['in the document and a note', '![a](a/x.png){width=100 height=100}\n\nText.[^1]\n\n[^1]: ![b](b/x.png){width=100 height=100}'],
  ])('writes distinct images with one name %s to files of their own', async (_name, md) => {
    // One file per name kept the first image's, which both then showed
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img-names-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(join(tmpDir, 'a'), { recursive: true });
    mkdirSync(join(tmpDir, 'b'), { recursive: true });
    writeFileSync(join(tmpDir, 'a', 'x.png'), TINY_PNG);
    writeFileSync(join(tmpDir, 'b', 'x.png'), Buffer.concat([TINY_PNG, Buffer.from('X')]));
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync((await convertMdToDocx(md, { sourceDir: tmpDir })).docx);
      for (const part of ['word/document.xml', 'word/footnotes.xml']) {
        const xml = await zip.file(part)?.async('string');
        if (xml) zip.file(part, xml.replace(/ name="[ab]\/x\.png"/g, ' name="photo.png"'));
      }
      const result = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
      const sources = [...result.markdown.matchAll(/!\[[ab]\]\(([^)]+)\)/g)].map(match => match[1]);
      expect(new Set(sources)).toEqual(new Set(['photo.png', 'photo-2.png']));
      expect(new Set([...result.images!.values()].map(bytes => bytes.length))).toEqual(new Set([TINY_PNG.length, TINY_PNG.length + 1]));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('writes no file for an image in a note nothing references', async () => {
    // A stale note's image took a file, and the name of the document's
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img-stale-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(join(tmpDir, 'a'), { recursive: true });
    mkdirSync(join(tmpDir, 'b'), { recursive: true });
    writeFileSync(join(tmpDir, 'a', 'x.png'), TINY_PNG);
    writeFileSync(join(tmpDir, 'b', 'x.png'), Buffer.concat([TINY_PNG, Buffer.from('X')]));
    try {
      const md = 'Text.[^1]\n\n![a](a/x.png){width=100 height=100}\n\n[^1]: ![b](b/x.png){width=100 height=100}';
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync((await convertMdToDocx(md, { sourceDir: tmpDir })).docx);
      for (const part of ['word/document.xml', 'word/footnotes.xml']) {
        const xml = await zip.file(part)!.async('string');
        const edited = xml.replace(/ name="[ab]\/x\.png"/g, ' name="photo.png"').replace(/<w:footnoteReference [^>]*\/>/g, '');
        expect(edited).not.toBe(xml);
        zip.file(part, edited);
      }
      const result = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
      expect(result.markdown).toContain('![a](photo.png)');
      expect(result.markdown).not.toContain('![b]');
      expect([...result.images!.entries()].map(([name, bytes]) => [name, bytes.length])).toEqual([['photo.png', TINY_PNG.length]]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['the notes\' part', 'endnotes:rId1', '<img src="image.png"'],
    ['another part, whose rId1 is another image', 'footnotes:rId1', '![x](image.png)'],
    ['no part, as export wrote before', 'rId1', '<img src="image.png"'],
  ])('reads a note image\'s format from a mapping for %s', async (_name, key, expected) => {
    // Footnotes and endnotes number their relationships apart, so one
    // mapping for both gave an endnote's image a footnote's format
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img-part-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'image.png'), TINY_PNG);
    try {
      const md = '---\nnotes: endnotes\n---\nText.[^1]\n\n[^1]: <img src="image.png" alt="x" width="100" height="100">';
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync((await convertMdToDocx(md, { sourceDir: tmpDir })).docx);
      const custom = await zip.file('docProps/custom.xml')!.async('string');
      expect(custom).toContain('{"endnotes:rId1":"html"}');
      zip.file('docProps/custom.xml', custom.replace('endnotes:rId1', key));
      const result = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
      expect(result.markdown).toContain('[^1]: ' + expected);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('keeps a note\'s HTML image whose format is in the document\'s mapping', async () => {
    // As export wrote it before the notes had a mapping of their own
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img-legacy-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'image.png'), TINY_PNG);
    try {
      const md = 'Text.[^1]\n\n[^1]: <img src="image.png" alt="x" width="100" height="100">';
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync((await convertMdToDocx(md, { sourceDir: tmpDir })).docx);
      const custom = await zip.file('docProps/custom.xml')!.async('string');
      expect(custom).toContain('MANUSCRIPT_NOTE_IMAGE_FORMATS');
      zip.file('docProps/custom.xml', custom.replace(/MANUSCRIPT_NOTE_IMAGE_FORMATS/g, 'MANUSCRIPT_IMAGE_FORMATS').replace(/footnotes:rId/g, 'rId'));
      const result = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
      expect(result.markdown).toContain('[^1]: <img src="image.png" alt="x" width="100" height="100">');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('image with simple filename round-trips correctly', async () => {
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img2-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'image.png'), TINY_PNG);
    try {
      const md = '![](image.png){width=100 height=100}\n';
      const { docx } = await convertMdToDocx(md, { sourceDir: tmpDir });
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('![](image.png)');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('round-trip regression: images export cannot embed', () => {
  async function roundTrip(md: string, sourceDir?: string) {
    const { docx, warnings } = await convertMdToDocx(md, sourceDir ? { sourceDir } : undefined);
    const markdown = (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
    return { markdown, warnings };
  }

  test.each([
    ['a missing file', '![alt](missing.png)', 'Image not found'],
    ['a URL', 'Text ![a b](http://example.com/x.png "Title") more.', 'is a URL or data URI'],
    ['a data URI', '![x](data:image/png;base64,AAAA)', 'is a URL or data URI'],
    ['an unsupported format', '![alt](figure.tiff){width=100 height=50}', 'Unsupported image format'],
    ['a path with spaces', '![a\\]b](<my figure.png>)', 'Image not found'],
    ['an HTML image', 'Text <img src="http://example.com/x.png" alt="a"> more.', 'is a URL or data URI'],
    ['an HTML image block', '<img src="missing.png" alt="a" width="20">', 'Image not found'],
    ['an image in a quote', '> ![alt](missing.png)', 'Image not found'],
    ['an image in a list', '- ![alt](missing.png)', 'Image not found'],
    ['an image in a table', '| a |\n| --- |\n| ![x](missing.png) |', 'Image not found'],
    ['an image in a footnote', 'Text[^1].\n\n[^1]: ![x](missing.png)', 'Image not found'],
    ['an inserted image', '{++![alt](missing.png)++}', 'Image not found'],
    ['a deleted image', 'A {--![alt](missing.png)--} b.', 'Image not found'],
    ['an escape in a URL', '![x](https://example.com/a%2Fb.png)', 'is a URL or data URI'],
    ['a formatted description and a title', '![**b** x](missing.png "t")', 'Image not found'],
  ])('keeps %s', async (_name, md, warning) => {
    const { markdown, warnings } = await roundTrip(md);
    expect(markdown).toBe(md + '\n');
    expect(warnings.some(w => w.includes(warning))).toBe(true);
  });

  test('keeps an image whose file cannot be read', async () => {
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img3-' + Date.now());
    const { mkdirSync, rmSync } = require('fs');
    mkdirSync(join(tmpDir, 'folder.png'), { recursive: true });
    try {
      const { markdown, warnings } = await roundTrip('![alt](folder.png)', tmpDir);
      expect(markdown).toBe('![alt](folder.png)\n');
      expect(warnings.some(w => w.includes('folder.png'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('hides the image in Word', async () => {
    const { docx } = await convertMdToDocx('A ![alt](missing.png) b');
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:vanish/>');
    expect(xml).toContain('\u200B![alt](missing.png)\u200B');
    expect(xml).not.toContain('<w:drawing>');
  });

  test.each([
    ['two images', 'A ![x](m.png)![y](n.png) B'],
    ['two HTML comments', 'A <!-- a --><!-- b --> B'],
    ['an HTML comment and an image', 'A <!-- a -->![y](n.png) B'],
    ['an image and an HTML comment', 'A ![y](n.png)<!-- a --> B'],
  ])('reads %s that Word joins in one run', async (_name, md) => {
    // Their ZWSPs went in the Markdown, or the image after a comment went
    // missing
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const rPr = '<w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr>';
    const joined = xml.replace(new RegExp('(<w:r>' + rPr + '(?:(?!</w:r>).)*)</w:r><w:r>' + rPr), (_m, run) => run);
    expect(joined).not.toBe(xml);
    zip.file('word/document.xml', joined);
    const markdown = (await convertDocx(new Uint8Array(await zip.generateAsync({ type: 'uint8array' })))).markdown;
    expect(markdown.replace(/^---\n[\s\S]*?\n---\n/, '')).toBe(md + '\n');
  });

  test.each([
    ['an image', 'A ![alt](missing.png) b', 9],
    ['an image after its ZWSP', 'A ![alt](missing.png) b', 1],
    ['an image after its !', 'A ![alt](missing.png) b', 2],
    ['an HTML comment after its <', 'A <!-- c --> b', 2],
  ])('joins %s when Word splits its run', async (_name, md, at) => {
    // Without the start of its opener, the run before it was dropped
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const rPr = '<w:r><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr>';
    const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const encode = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const split = xml.replace(new RegExp(rPr + '<w:t>([^<]*)</w:t></w:r>'), (_m, text: string) =>
      rPr + '<w:t>' + encode(decode(text).slice(0, at)) + '</w:t></w:r>' + rPr + '<w:t>' + encode(decode(text).slice(at)) + '</w:t></w:r>');
    expect(split).not.toBe(xml);
    zip.file('word/document.xml', split);
    const markdown = (await convertDocx(new Uint8Array(await zip.generateAsync({ type: 'uint8array' })))).markdown;
    expect(markdown).toContain(md);
  });

  test('keeps a ZWSP in an image\'s Markdown as a character reference', async () => {
    // It closed the image there
    const { markdown } = await roundTrip('![x\u200By](missing.png)');
    expect(markdown).toBe('![x&#8203;y](missing.png)\n');
    expect((await roundTrip(markdown.trimEnd())).markdown).toBe(markdown);
  });
});

describe('round-trip regression: LaTeX nary subscript-only', () => {
  test('\\sum\\limits_w does not gain spurious ^{}', async () => {
    const md = '$\\sum\\limits_w$\n';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('\\sum\\limits_w');
    expect(result.markdown).not.toContain('^{}');
  });
});

describe('round-trip regression: pipe table alignment', () => {
  test('aligned pipe table preserves column padding', async () => {
    const md = [
      '| Name   | Value |',
      '| ------ | ----- |',
      '| Alpha  | 1     |',
      '| Beta   | 2     |',
      '',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    // The separator should have dashes longer than minimum 3
    const lines = result.markdown.split('\n');
    const sepLine = lines.find(l => /^\|[\s\-:|]+\|$/.test(l));
    expect(sepLine).toBeDefined();
    // Should have padded dashes, not minimal ---
    const segments = sepLine!.split('|').slice(1, -1);
    expect(segments.some(s => s.replace(/[^-]/g, '').length > 3)).toBe(true);
  });

  test('compact pipe table stays compact', async () => {
    const md = [
      '| Name | Value |',
      '| --- | --- |',
      '| A | 1 |',
      '',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    const lines = result.markdown.split('\n');
    const sepLine = lines.find(l => /^\|[\s\-:|]+\|$/.test(l));
    expect(sepLine).toBeDefined();
    const segments = sepLine!.split('|').slice(1, -1);
    // All segments should have exactly 3 dashes (compact)
    expect(segments.every(s => s.replace(/[^-]/g, '').length === 3)).toBe(true);
  });
});

describe('XML entity limits', () => {
  test('a document with more than 10,000 standard entities converts', async () => {
    // Long manuscripts pass this easily: every Zotero field code is full of &quot;
    const paragraph = '<w:p><w:r><w:t>&quot;q&quot; &lt;r&gt;</w:t></w:r></w:p>';
    const docx = await buildSyntheticDocx(wrapDocumentXml(paragraph.repeat(3000)));
    const result = await convertDocx(docx);
    expect(result.markdown.split('"q"').length - 1).toBe(3000);
  });

  test('a DOCTYPE entity longer than one character is refused', async () => {
    const xml = wrapDocumentXml('<w:p><w:r><w:t>' + '&big;'.repeat(200) + '</w:t></w:r></w:p>')
      .replace('<?xml version="1.0"?>', '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY big "' + 'A'.repeat(9000) + '">]>');
    await expect(convertDocx(await buildSyntheticDocx(xml))).rejects.toThrow(/exceeds maximum allowed size/);
  });

  test('a DOCTYPE after the root element is held to the same entity size', async () => {
    // fast-xml-parser reads a DOCTYPE wherever it appears
    const xml = wrapDocumentXml('<!DOCTYPE x [<!ENTITY big "AA">]><w:p><w:r><w:t>&big;</w:t></w:r></w:p>');
    await expect(convertDocx(await buildSyntheticDocx(xml))).rejects.toThrow(/exceeds maximum allowed size/);
  });

  test('one-character and empty DOCTYPE entities expand any number of times', async () => {
    const xml = wrapDocumentXml('<w:p><w:r><w:t>' + '&x;&z;'.repeat(5000) + '</w:t></w:r></w:p>')
      .replace('<?xml version="1.0"?>', '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x ""><!ENTITY z "Z">]>');
    const result = await convertDocx(await buildSyntheticDocx(xml));
    expect(result.markdown).toContain('Z'.repeat(5000));
  });

  test('DOCTYPE inside CDATA, a comment, or a processing instruction is just content', async () => {
    const xml = wrapDocumentXml(
      '<!-- <!DOCTYPE x> --><?note <!DOCTYPE y>?>'
      + '<w:p><w:r><w:t><![CDATA[<!DOCTYPE html>]]></w:t></w:r></w:p>',
    );
    const result = await convertDocx(await buildSyntheticDocx(xml));
    expect(result.markdown).toContain('DOCTYPE html');
  });

  test('DOCTYPE in document text is just text', async () => {
    const docx = await buildSyntheticDocx(wrapDocumentXml('<w:p><w:r><w:t>&lt;!DOCTYPE html&gt;</w:t></w:r></w:p>'));
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('DOCTYPE html');
  });
});

describe('Frontmatter settings round-trip', () => {
  const frontmatterOf = async (md: string, edit?: (zip: JSZip) => Promise<void>) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    await edit?.(zip);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    return /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? '';
  };

  test.each([
    'locale: en-GB',
    'zotero-notes: endnotes',
    'notes: endnotes',
    'timezone: -05:00',
    'blockquote-style: IntenseQuote',
    'colors: guttmacher',
    'breaks: true',
    'code-font: Courier New',
    'code-font-size: 9',
  ])('keeps %s', async (setting) => {
    // With nothing in the document that shows the setting
    expect(await frontmatterOf('---\n' + setting + '\n---\n\nText.')).toBe(setting);
  });

  test('keeps comment dates in the stored timezone', async () => {
    // Whatever the system's timezone, which export doesn't read them in
    const md = '---\ntimezone: +05:45\n---\n\n{==Text==}{>>@A (2024-01-15 23:30) | Note.<<}';
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
    expect(markdown).toContain('{>>@A (2024-01-15 23:30) | Note.<<}');
  });

  test('formats a timestamp in a given offset', () => {
    expect(formatLocalIsoMinute('2024-01-15T17:45:00Z', '+05:45')).toBe('2024-01-15 23:30');
    expect(formatLocalIsoMinute('2024-01-15T02:00:00Z', '-05:00')).toBe('2024-01-14 21:00');
  });

  test.each(['code-font', 'font', 'header-font'])('keeps a %s with an ampersand in its name', async (key) => {
    expect(await frontmatterOf('---\n' + key + ': A & B\n---\n\n# H\n\nText.\n\n```\ncode\n```')).toBe(key + ': A & B');
  });

  test('takes the kind of notes the document has over the stored setting', async () => {
    expect(await frontmatterOf('---\nnotes: footnotes\n---\n\nText.[^1]\n\n[^1]: Note.', async zip => {
      // As if the notes became endnotes in Word
      const footnotes = await zip.file('word/footnotes.xml')!.async('string');
      zip.file('word/endnotes.xml', footnotes.replace(/footnote/g, 'endnote').replace(/Footnote/g, 'Endnote'));
      zip.remove('word/footnotes.xml');
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file('word/document.xml', xml.replace(/footnoteReference/g, 'endnoteReference').replace(/FootnoteReference/g, 'EndnoteReference'));
    })).toBe('notes: endnotes');
  });

  test('reads a code font set in Word', async () => {
    expect(await frontmatterOf('```\ncode\n```', async zip => {
      const styles = await zip.file('word/styles.xml')!.async('string');
      zip.file('word/styles.xml', styles.replace(/(w:styleId="CodeBlock">[\s\S]*?)Consolas/, '$1Menlo').replace(/(w:styleId="CodeBlock">[\s\S]*?)Consolas/, '$1Menlo'));
    })).toBe('code-font: Menlo');
  });
});
