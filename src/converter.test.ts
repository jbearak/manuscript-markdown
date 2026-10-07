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
import { annotateHtmlCommentIndices, convertMdToDocx, parseMd } from './md-to-docx';
import { GRID_TABLE_PLACEHOLDER_PREFIX } from './grid-table-preprocess';
import { keepParagraphEdgeWhitespace } from './html-entities';
import { extractAllDecorationRanges } from './highlight-colors';

const fixturesDir = join(__dirname, '..', 'test', 'fixtures');
/** The space export puts after a note's mark, as Word does */
const NOTE_SEPARATOR = '<w:r><w:t xml:space="preserve"> </w:t></w:r>';
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

  test('renders DOCX table with multi-paragraph cell as HTML table though grid enabled', async () => {
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

    // A grid table's cell holds paragraphs as lines, which export reads as
    // one paragraph with line breaks
    expect(result.markdown).not.toMatch(/^\+-+\+-+\+$/m);
    expect(result.markdown).toContain('<table>');
    expect(result.markdown).toContain('<p>first paragraph</p>\n      <p>second paragraph</p>');
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

    // Force HTML so we can extract cell content from <p> tags: a merged
    // cell, which only HTML holds, as a grid table holds a comment
    const tableMarkdown = buildMarkdown(
      [
        {
          type: 'table',
          rows: [
            {
              isHeader: false,
              cells: [{ paragraphs: [inlineItems as any[]], colspan: 2 }],
            },
          ],
        },
      ] as any,
      comments,
      { pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 },
    );

    const paraMatch = tableMarkdown.match(/<p>([\s\S]*?)<\/p>/);
    expect(paraMatch).not.toBeNull();
    // The link as its tag, which export reads in the cell's HTML
    expect(paraMatch?.[1]).toBe(bodyMarkdown.replace('[ link](<https://example.com/a(b)>)', '<a href="https://example.com/a(b)"> link</a>'));
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
              cells: [{ paragraphs: [inlineItems as any[]], colspan: 2 }],
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

  test('table with multi-paragraph cell falls back to HTML', async () => {
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

    // A grid table's lines would export as one paragraph
    expect(result.markdown).toContain('<table>');
    expect(result.markdown).toContain('<p>para one</p>');
    expect(result.markdown).toContain('<p>para two</p>');
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
      + '<w:tr><w:trPr><w:tblHeader/></w:trPr>'
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
      + '<w:tr><w:trPr><w:tblHeader/></w:trPr>'
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

  // GFM pipe tables always have a header row, which export makes the Word
  // table's header, in bold, so a table without one is a grid table
  // without one, rather than a pipe table whose first row becomes a header
  test('writes a table without a header row as a grid table without one', async () => {
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

    expect(result.markdown).toContain('+-----+-----+\n| A   | B   |\n+-----+-----+\n| C   | D   |\n+-----+-----+');
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(result.markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml).not.toContain('<w:tblHeader/>');
    expect(xml).not.toContain('<w:b/>');
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
      + '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p>'
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

    // A merged cell forces HTML fallback, as a grid table holds a comment
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
    // Build a table with multi-line cells using HTML (whose <br> is a line break)
    const htmlMd = [
      '<table>',
      '<tr><th>Header 1</th><th>Header 2</th></tr>',
      '<tr><td>Line 1<br>Line 2</td><td>Single</td></tr>',
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
          { isHeader: false, cells: [{ paragraphs: [[{ type: 'text', text: 'A', commentIds: new Set(), formatting: DEFAULT_FORMATTING }, { type: 'text', text: '\\\n', commentIds: new Set(), formatting: DEFAULT_FORMATTING }, { type: 'text', text: 'B', commentIds: new Set(), formatting: DEFAULT_FORMATTING }]] }, { paragraphs: [[{ type: 'text', text: 'C', commentIds: new Set(), formatting: DEFAULT_FORMATTING }]] }] },
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
  test.each([
    ['a pipe table', '| x |\n| --- |\n| a<br> |\n| **b**<br><br> |\n| <br> |'],
    ['a grid table', '+-------+-----+\n| h     | x   |\n+=======+=====+\n| a<br> | b   |\n|       | c   |\n|       | d   |\n+-------+-----+'],
  ])('keeps a line break at the end of a cell of %s', async (_name, md) => {
    // Import dropped it, which a pipe table can't hold as a line end, and
    // which export read from a grid table's blank lines padding a cell
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    expect(markdown).toBe(md);
  });

  test('keeps spaces and tabs before a line break in a grid table cell', async () => {
    // Export trims them from the line as its padding, and the backslash
    // before them then made the line's end a line break
    const md = '+---------------+-----+\n| x             | y   |\n+===============+=====+\n| a&#32;        | b   |\n| c             |     |\n+---------------+-----+\n| \\\\&#32;&#9;   | d   |\n| e             |     |\n+---------------+-----+';
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    expect(markdown).toBe(md);
  });

  test('keeps the lines of an equation in a grid table cell as they are', async () => {
    // Import took the \\ that ends the equation's line for a line break's
    // backslash, and wrote the space at a line's end as a reference, which
    // the equation then held
    const md = '+-------+-----+\n| x     | y   |\n+=======+=====+\n| $a \\\\ | b   |\n| b$    |     |\n+-------+-----+';
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    expect(markdown).toBe(md);
    const cell = (paragraphs: ContentItem[][]) => ({ colspan: 1, paragraphs });
    const text = (t: string): ContentItem => ({ type: 'text', text: t, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
    const table = { type: 'table', rows: [{ isHeader: true, cells: [cell([[text('x')]])] },
      { isHeader: false, cells: [cell([[text('p '), { type: 'math', latex: 'a \nb', display: false } as ContentItem]])] }] } as unknown as ContentItem;
    expect(buildMarkdown([table], new Map())).toContain('| p $a  |\n| b$    |');
  });

  test('writes a cell\'s last paragraph of spaces alone as HTML, not a grid table\'s line break', () => {
    // A grid table wrote it as a line break, as a line of spaces would be the
    // cell's padding, and the cell's paragraphs as lines, which export read
    // as one paragraph
    const cell = (paragraphs: ContentItem[][]) => ({ colspan: 1, paragraphs });
    const text = (t: string): ContentItem => ({ type: 'text', text: t, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
    const table = { type: 'table', rows: [{ isHeader: true, cells: [cell([[text('x')]]), cell([[text('y')]])] },
      { isHeader: false, cells: [cell([[text('a')], [text(' \t ')]]), cell([[text('b')], [text('c')]])] }] } as unknown as ContentItem;
    expect(buildMarkdown([table], new Map())).toContain('      <p>a</p>\n      <p>&#32;&#9;&#32;</p>');
  });

  test('keeps a backslash at the end of a grid table cell with fewer lines than its row', async () => {
    // Import dropped it as a line break's, and export read the blank line
    // after it as one, so the next round trip lost it too
    const md = '+-------+-----+\n| h     | x   |\n+=======+=====+\n| C:\\\\  | b   |\n|       | c   |\n+-------+-----+';
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    expect(markdown).toBe(md);
  });

  test.each([
    ['wide characters', '+------+-----+\n| x    | y   |\n+======+=====+\n| 中文 | b   |\n| c    | d   |\n+------+-----+'],
    ['a | at the start of a cell', '+-----+-----+\n| x   | y   |\n+=====+=====+\n| |a  | b   |\n| c   | d   |\n+-----+-----+'],
  ])('keeps a grid table with %s', async (_name, md) => {
    // Import pads a cell by display width and writes a | in it as it is,
    // while export cut the cells at the + signs' indices and took a | at a
    // cell's start for its edge
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    expect(markdown).toBe(md);
  });

  test.each([
    ['a | after an emoji', '👍🏽|', '✅✅'],
    ['a | with spaces around it after wide characters', '中文文字', 'x | 𝑎𝑏𝑐𝑑'],
    ['a | in code after wide characters', '中文文字', '`x | 𝑎𝑏𝑐𝑑`'],
  ])('writes a grid table with %s that reads back as written', (_name, first, second) => {
    // A | in a cell under a + by characters, where the line is padded by
    // display columns, could be read as the cell's edge, moving text between
    // cells, so such a table is padded by characters
    const text = (t: string): ContentItem => t.startsWith('`')
      ? { type: 'text', text: t.slice(1, -1), commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, code: true } }
      : { type: 'text', text: t, commentIds: new Set(), formatting: DEFAULT_FORMATTING };
    const table = { type: 'table', rows: [{ isHeader: false, cells: [{ colspan: 1, paragraphs: [[text(first), text('\\\n'), text('x')]] }, { colspan: 1, paragraphs: [[text(second)]] }] }] } as unknown as ContentItem;
    const markdown = buildMarkdown([table], new Map());
    const read = parseMd(markdown).find(token => token.type === 'table')?.rows?.[0].cells
      .map(cell => cell.runs.map(run => run.type === 'hardbreak' ? '\n' : run.code ? '`' + run.text + '`' : run.text).join('').replace(/\n+$/, ''));
    expect(read).toEqual([first + '\nx', second]);
  });

  test('pads a grid table that would read back otherwise by characters, keeping a tracked change in it', async () => {
    const text = (t: string, revision?: object): ContentItem => ({ type: 'text', text: t, commentIds: new Set(), formatting: DEFAULT_FORMATTING, ...(revision ? { revision } : {}) });
    const table = { type: 'table', rows: [
      { isHeader: false, cells: [{ colspan: 1, paragraphs: [[text('中文文字'), text('\\\n'), text('x')]] }, { colspan: 1, paragraphs: [[text('x | 𝑎𝑏𝑐𝑑')]] }] },
      { isHeader: false, cells: [{ colspan: 1, paragraphs: [[text('t', { type: 'addition', author: 'A', date: '2024-01-01T00:00:00Z' })]] }, { colspan: 1, paragraphs: [[text('y')]] }] },
    ] } as unknown as ContentItem;
    const markdown = buildMarkdown([table], new Map());
    expect(markdown).toStartWith('+---------+--------------+\n| 中文文字    | x | 𝑎𝑏𝑐𝑑 |');
    expect(markdown).toContain('| {++t++} | y            |');
    const read = parseMd(markdown).find(token => token.type === 'table')?.rows?.map(row => row.cells.map(cell => cell.runs.map(run => run.type === 'hardbreak' ? '\n' : run.text).join('').replace(/\n+$/, '')));
    expect(read).toEqual([['中文文字\nx', 'x | 𝑎𝑏𝑐𝑑'], ['t', 'y']]);
  });

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
    // Whose start of 0 read as none, so it started at 1
    ['a list that starts at 0', '0. a\n1. b', undefined],
    ['a list that starts at 0 after another', '1. a\n\nP.\n\n0. c\n1. d', undefined],
    ['a sublist that starts at 0', '1. a\n\n   0. x\n   1. y', undefined],
    ['a sublist that starts at 0 in a bullet', '- a\n\n  0. x\n  1. y', undefined],
    ['a list and its sublist that start at 0', '0. a\n\n   0. x', undefined],
    ['a list after another delimiter that goes on', '1. a\n\n2) b', '1. a\n\n<!-- -->\n\n2. b'],
    ['a sublist after a comment', '1. parent\n   1. a\n\n   <!-- -->\n\n   1. b', undefined],
    ['sentinels around a quote in an item', '<!-- no-indent -->\n1. a\n\n   > q\n2. b\n\nP.\n\n<!-- indent -->\n1. c', undefined],
    ['sentinels around a second paragraph in an item', '<!-- no-indent -->\n- a\n\n  more\n- b\n\nP.\n\n<!-- indent -->\n- c', undefined],
  ])('round-trips the numbering of %s', async (_, md, back) => {
    // Markdown starts each list over; Word has to as well
    expect(await roundTrip(md)).toBe(back ?? md);
    expect(await roundTrip(back ?? md)).toBe(back ?? md);
  });

  test('starts a list at 0 in Word where the Markdown does', async () => {
    const { docx } = await convertMdToDocx('0. a\n1. b');
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    const [numId] = numIdsOf(await documentXml(docx));
    expect(numbering).toMatch(new RegExp('<w:num w:numId="' + numId + '"[^>]*>[^]*?<w:lvlOverride w:ilvl="0"><w:startOverride w:val="0"/>'));
  });

  test('gives no warning for the comment between two sublists', async () => {
    // Export drops it on purpose, as Word's numbering keeps it
    const { warnings } = await convertMdToDocx('1. parent\n   1. a\n\n   <!-- -->\n\n   1. b');
    expect(warnings).toEqual([]);
    // Another comment in an item is a hidden paragraph, which export dropped
    // with a warning, as one between bullet lists, which nothing else keeps
    // apart in Word
    expect((await convertMdToDocx('- parent\n\n  <!-- c -->')).warnings).toEqual([]);
    const bullets = '1. parent\n   - a\n\n   <!-- -->\n\n   - b';
    expect((await convertMdToDocx(bullets)).warnings).toEqual([]);
    expect(await roundTrip(bullets)).toBe('1. parent\n   - a\n\n   <!-- -->\n   - b');
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

  test.each([
    ['a list', '1. a\n2. b', '0. a\n1. b'],
    ['a list and its sublist', '1. a\n\n   1. x\n   2. y', '0. a\n\n   0. x\n   1. y'],
  ])('numbers %s whose levels have no w:start from 0, as Word does', async (_name, md, expected) => {
    // It numbered them from 1, which Word shows only where w:start says so
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    expect(numbering).toContain('<w:start w:val="1"/>');
    zip.file('word/numbering.xml', numbering.replace(/<w:start w:val="1"\/>/g, ''));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
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
    ['a list', '1. a\n2. b'],
    ['a list and its sublist', '1. a\n2. b\n   1. x\n   2. y'],
    ['a sublist under a bullet', '- a\n  1. x\n  2. y'],
  ])('reads %s whose levels have no w:numFmt as numbered, as Word does', async (_name, md) => {
    // A level's format is decimal where none is given, and it read such a
    // level as no list's, so its paragraphs lost their numbers
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>');
    zip.file('word/numbering.xml', numbering.replace(/<w:numFmt w:val="decimal"\/>/g, ''));
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe(md);
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

  // A document of [numId, ilvl, text] list paragraphs, numId 0 for a plain
  // one, with instances of the numbered lists' numbering added, and `edit`
  // made to the numbering
  const wordList = async (instances: string, paragraphs: [number, number, string][], edit = (numbering: string) => numbering) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('1. a')).docx);
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    zip.file('word/numbering.xml', edit(numbering.replace('</w:numbering>', instances + '</w:numbering>')));
    const body = paragraphs.map(([numId, ilvl, text]) => '<w:p>' + (numId > 0
      ? '<w:pPr><w:numPr><w:ilvl w:val="' + ilvl + '"/><w:numId w:val="' + numId + '"/></w:numPr></w:pPr>' : '')
      + '<w:r><w:t>' + text + '</w:t></w:r></w:p>').join('');
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:body>[\s\S]*?(?=<w:sectPr)/, () => '<w:body>' + body));
    return strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };
  const instance = (numId: number, starts: [number, number][] = []) => '<w:num w:numId="' + numId + '"><w:abstractNumId w:val="1"/>'
    + starts.map(([ilvl, start]) => '<w:lvlOverride w:ilvl="' + ilvl + '"><w:startOverride w:val="' + start + '"/></w:lvlOverride>').join('')
    + '</w:num>';

  test.each([
    // ECMA-376 Part 1 §17.9.26's example: numId 6 starts the count over for numId 5 too
    ['an instance after another', instance(5) + instance(6, [[0, 1]]), [5, 5, 6, 5], '1. a\n2. b\n\n<!-- -->\n\n1. c\n2. d'],
    ['an instance before another', instance(6, [[0, 1]]) + instance(5), [6, 5, 5], '1. a\n2. b\n3. c'],
    // Its start applies once, at its first paragraph, as Word numbers it
    ['an instance used again', instance(6, [[0, 7]]), [2, 6, 2, 6], '1. a\n\n<!-- -->\n\n7. b\n8. c\n9. d'],
  ])('numbers the instances of one list as one count: %s', async (_name, instances, numIds, md) => {
    expect(await wordList(instances, numIds.map((numId, i): [number, number, string] => [numId, 0, 'abcd'[i]]))).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test('starts a level over at an instance\'s first paragraph at it, after its paragraphs at another', async () => {
    // [MS-DOC] 2.4.6.4 looks for the override at the paragraphs at its level
    const md = '1. a\n\n   7. x\n   8. y';
    expect(await wordList(instance(6, [[1, 7]]), [[6, 0, 'a'], [6, 1, 'x'], [6, 1, 'y']])).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test('starts a level over at its list\'s start after a parent, after an instance\'s override started it', async () => {
    // [MS-DOC] 2.4.6.4 starts a level over at its list's start (steps 3 and
    // 8), which an instance's start override changes only with a level of
    // its own (Determining List Formatting of a Paragraph, steps 6 and 7),
    // and LibreOffice does the same. ECMA-376 Part 1's 2008 edition had the
    // override apply wherever w:lvlRestart starts the level over, as docx4j
    // does; its 2016 edition (§17.9.26) no longer says so
    const md = '1. a\n\n   7. x\n2. b\n   1. y';
    expect(await wordList(instance(6, [[1, 7]]), [[6, 0, 'a'], [6, 1, 'x'], [6, 0, 'b'], [6, 1, 'y']])).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    // Word numbers a list of 1.1 and a top-level item as 1.1, 2
    ['its start', '', '- a\n  1. b\n\n2. c'],
    // As tdf#153104's document has it
    ['an instance\'s override at its first paragraph', instance(6, [[0, 4], [1, 1]]), '- a\n  1. b\n\n5. c'],
  ])('counts a level that a list starts under from %s', async (_name, instances, md) => {
    const numId = instances ? 6 : 2;
    expect(await wordList(instances, [[1, 0, 'a'], [numId, 1, 'b'], [numId, 0, 'c']])).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['an empty element', '<w:lvlOverride w:ilvl="0"/>'],
    ['an element pair', '<w:lvlOverride w:ilvl="0"></w:lvlOverride>'],
  ])('reads an instance\'s level override with nothing in it, written as %s, as a start of 0', async (_name, override) => {
    // Word numbers the level from 0 (tdf#153104), as export reads a
    // template's, where import read the level's own start
    const md = '0. a\n1. b';
    expect(await wordList('<w:num w:numId="6"><w:abstractNumId w:val="1"/>' + override + '</w:num>', [[6, 0, 'a'], [6, 0, 'b']])).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  // Numbering whose level `ilvl` of the numbered lists has a w:lvlRestart of `restart`
  const withLvlRestart = (ilvl: number, restart: number) => (numbering: string) => numbering.replace(new RegExp('(<w:abstractNum w:abstractNumId="1"[^]*?<w:lvl w:ilvl="'
    + ilvl + '"[^>]*><w:start w:val="1"/><w:numFmt w:val="decimal"/>)'), (match: string) => match + '<w:lvlRestart w:val="' + restart + '"/>');

  test.each([
    // Word lets a level go on after a higher one where its w:lvlRestart says
    ['never', 1, 0, [[2, 0, 'a'], [2, 1, 'x'], [2, 1, 'y'], [2, 0, 'b'], [2, 1, 'z']], '1. a\n   1. x\n   2. y\n2. b\n\n   3. z'],
    ['after level 1', 2, 1, [[2, 0, 'a'], [2, 1, 'b'], [2, 2, 'x'], [2, 1, 'c'], [2, 2, 'y'], [2, 0, 'd'], [2, 1, 'e'], [2, 2, 'z']],
      '1. a\n   1. b\n      1. x\n   2. c\n\n      2. y\n2. d\n   1. e\n      1. z'],
    // A lower level than the one it starts over is ignored
    ['after a lower level', 1, 3, [[2, 0, 'a'], [2, 1, 'x'], [2, 0, 'b'], [2, 1, 'y']], '1. a\n   1. x\n2. b\n   1. y'],
  ])('numbers a level that starts over %s as Word does', async (_name, ilvl, restart, paragraphs, md) => {
    expect(await wordList('', paragraphs as [number, number, string][], withLvlRestart(ilvl, restart))).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test('numbers a level as its abstract numbering\'s w:lvlRestart has it, whatever an instance\'s level override has', async () => {
    // Word ignores a w:lvlRestart in a level override's w:lvl ([MS-OI29500]
    // 2.1.282 b), so this level, which the abstract numbering never starts
    // over, goes on under the next parent
    const lvl = '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:lvlRestart w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%2."/><w:lvlJc w:val="left"/></w:lvl>';
    const md = '1. a\n   1. x\n2. b\n\n   2. y';
    expect(await wordList('<w:num w:numId="6"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="1">' + lvl + '</w:lvlOverride></w:num>',
      [[6, 0, 'a'], [6, 1, 'x'], [6, 0, 'b'], [6, 1, 'y']], withLvlRestart(1, 0))).toBe(md);
    expect(await roundTrip(md)).toBe(md);
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

  const roundTripWith = async (md: string, templateDocx: Uint8Array) =>
    strip((await convertDocx((await convertMdToDocx(md, { templateDocx })).docx)).markdown);

  test.each([
    ['after its parent', 1, 1, '1. p\n   1. x\n2. q\n   1. y'],
    ['after its parent, below another level', 2, 2, '1. a\n   1. b\n      1. x\n   2. c\n      1. y'],
    // Word ignores a level below it, and starts it over after any above
    ['after a level below it', 1, 3, '1. p\n   1. x\n2. q\n   1. y'],
  ])('numbers a sublist in its parent\'s instance where a template starts its level over %s', async (_name, ilvl, restart, md) => {
    const templateDocx = await templateWithNumbering(withLvlRestart(ilvl, restart));
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect(new Set(numIdsOf(await documentXml(docx))).size).toBe(1);
    expect(await roundTripWith(md, templateDocx)).toBe(md);
  });

  test.each([
    // Word would go on from the sublist before
    ['never', 1, 0, '1. a\n   1. x\n   2. y\n2. b\n   1. z'],
    ['only after a level above its parent\'s', 2, 1, '1. a\n   1. b\n      1. x\n   2. c\n      1. y'],
    // The Markdown going on, which a sublist's own start keeps either way
    ['never, where the Markdown goes on', 1, 0, '1. a\n   1. x\n   2. y\n2. b\n\n   3. z'],
    ['after its parent, where the Markdown goes on', 1, 1, '1. a\n   1. x\n   2. y\n2. b\n\n   3. z'],
  ])('numbers a sublist as the Markdown does where a template starts its level over %s', async (_name, ilvl, restart, md) => {
    const templateDocx = await templateWithNumbering(withLvlRestart(ilvl, restart));
    const once = await roundTripWith(md, templateDocx);
    expect(once).toBe(md);
    expect(await roundTripWith(once, templateDocx)).toBe(md);
  });

  test('numbers a sublist as the Markdown does where a template\'s numbers take a numId other than 2, which never starts its level over', async () => {
    // The template's numId 2 is a bullet a style uses, so numbers take its
    // numId 3, whose abstract numbering has the level go on
    const templateZip = await JSZip.loadAsync(await templateWithNumbering(numbering => withLvlRestart(1, 0)(numbering)
      .replace(/(<w:num w:numId="2"[^>]*><w:abstractNumId w:val=")1("\/>)/, (_m: string, open: string, close: string) => open + '0' + close)
      .replace('</w:numbering>', '<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num></w:numbering>')));
    templateZip.file('word/styles.xml', (await templateZip.file('word/styles.xml')!.async('string')).replace('</w:styles>',
      '<w:style w:type="paragraph" w:styleId="Listed"><w:name w:val="Listed"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style></w:styles>'));
    const templateDocx = await templateZip.generateAsync({ type: 'uint8array' });
    const md = '1. a\n   1. x\n   2. y\n2. b\n   1. z';
    expect(numIdsOf(await documentXml((await convertMdToDocx(md, { templateDocx })).docx))[0]).toBe('3');
    expect(await roundTripWith(md, templateDocx)).toBe(md);
  });

  test.each([
    ['under one parent', '1. a\n   1. b\n      1. c'],
    ['under two', '1. a\n   1. b\n      1. c\n2. d\n   1. e\n      1. f'],
  ])('starts a sublist of a sublist in its own instance where its parent\'s has none of numId 2\'s start override for it: %s', async (_name, md) => {
    // Its level starts at 5, which numId 2 starts at 1, and the level above
    // never starts over, so that sublist starts in an instance of its own
    const templateDocx = await templateWithNumbering(numbering => withLvlRestart(1, 0)(numbering)
      .replace(/(<w:abstractNum w:abstractNumId="1"[^]*?<w:lvl w:ilvl="2"[^>]*>)<w:start w:val="1"\/>/, (_match, lvl: string) => lvl + '<w:start w:val="5"/>')
      .replace(/(<w:num w:numId="2"[^>]*><w:abstractNumId w:val="1"\/>)/, (instance: string) => instance + '<w:lvlOverride w:ilvl="2"><w:startOverride w:val="1"/></w:lvlOverride>'));
    const once = await roundTripWith(md, templateDocx);
    expect(once).toBe(md);
    expect(await roundTripWith(once, templateDocx)).toBe(md);
  });

  // The level overrides of the instance of the list's paragraph at `index`
  const levelOverridesOf = async (docx: Uint8Array, index: number) => {
    const numId = numIdsOf(await documentXml(docx))[index];
    const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml')!.async('string');
    return new RegExp('<w:num w:numId="' + numId + '"[^>]*><w:abstractNumId w:val="1"/>([^]*?)</w:num>').exec(numbering)?.[1];
  };

  // Numbering whose level `ilvl` of the numbered lists starts at `start`, or
  // has no w:start for undefined, or whose numId 2 starts that level over at it
  const withLevelStart = (ilvl: number, start?: number) => (numbering: string) => numbering.replace(new RegExp('(<w:abstractNum w:abstractNumId="1"[^]*?<w:lvl w:ilvl="'
    + ilvl + '"[^>]*>)<w:start w:val="1"/>'), (_match, lvl: string) => lvl + (start === undefined ? '' : '<w:start w:val="' + start + '"/>'));
  const withStartOverride = (ilvl: number, start: number) => (numbering: string) => numbering.replace(/(<w:num w:numId="2"[^>]*><w:abstractNumId w:val="1"\/>)/,
    (instance: string) => instance + '<w:lvlOverride w:ilvl="' + ilvl + '"><w:startOverride w:val="' + start + '"/></w:lvlOverride>');

  test.each([
    // Word would number it from the template
    ['a sublist\'s level at 0', withLevelStart(1, 0), '1. a\n   1. x\n2. b\n   1. y'],
    ['the top level at 3', withLevelStart(0, 3), '1. a\n2. b'],
    ['its numbered lists\' instance at 5', withStartOverride(0, 5), '1. a\n2. b'],
    // Below 0, which export read as no start or override at all
    ['its numbered lists\' instance at -1', withStartOverride(0, -1), '1. a\n2. b'],
    ['its numbered lists\' instance at -1 and the top level at 3', (numbering: string) => withStartOverride(0, -1)(withLevelStart(0, 3)(numbering)), '3. a\n4. b'],
    ['the top level at -1', withLevelStart(0, -1), '1. a\n2. b'],
    ['a sublist\'s level at -1 in its numbered lists\' instance', withStartOverride(1, -1), '1. a\n   1. x\n2. b\n   1. y'],
  ])('numbers a list as the Markdown does where a template starts %s', async (_name, edit, md) => {
    const templateDocx = await templateWithNumbering(edit);
    const once = await roundTripWith(md, templateDocx);
    expect(once).toBe(md);
    expect(await roundTripWith(once, templateDocx)).toBe(md);
  });

  test.each([
    ['at 1', (numbering: string) => numbering, '1. p\n   1. x\n2. q\n   1. y'],
    ['its instance at 1', withStartOverride(0, 1), '1. p\n   1. x\n2. q\n   1. y'],
    ['a sublist\'s level at 2', withLevelStart(1, 2), '1. a\n\n   2. x\n2. b\n\n   2. y'],
    ['the top level at 3', withLevelStart(0, 3), '3. a\n4. b'],
    ['its numbered lists\' instance at 5', withStartOverride(0, 5), '5. a\n6. b'],
  ])('numbers a list in the instance it can share where a template starts it %s', async (_name, edit, md) => {
    const templateDocx = await templateWithNumbering(edit);
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect([...new Set(numIdsOf(await documentXml(docx)))]).toEqual(['2']);
    expect(await roundTripWith(md, templateDocx)).toBe(md);
  });

  test.each([
    // Word starts it at 0 (ECMA-376 Part 1 §17.9.25)
    ['a level without a start', withLevelStart(1)],
    // Which Word applies at the instance's first paragraph at the level
    ['an override at its level in the instance it would share', withStartOverride(1, 5)],
  ])('starts a sublist over in its own instance where a template has %s', async (_name, edit) => {
    const templateDocx = await templateWithNumbering(edit);
    const md = '1. a\n   1. x\n2. b';
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect(await levelOverridesOf(docx, 1)).toBe('<w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"/></w:lvlOverride>');
    expect(await roundTripWith(md, templateDocx)).toBe(md);
  });

  test.each([
    // Word reads one with nothing in it as a start of 0 (tdf#153104)
    ['an empty level override in the instance it would share', false],
    // A heading's number moves the count on before the list
    ['headings numbered in the same count', true],
  ])('starts a list in its own instance where a template has %s', async (_name, headings) => {
    const templateZip = await JSZip.loadAsync(await templateWithNumbering(numbering => headings
      ? withLevelStart(0, 3)(numbering).replace('</w:numbering>', '<w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num></w:numbering>')
      : withLevelStart(0, 3)(numbering).replace(/(<w:num w:numId="2"[^>]*><w:abstractNumId w:val="1"\/>)/, (instance: string) => instance + '<w:lvlOverride w:ilvl="0"/>')));
    if (headings) {
      const styles = await templateZip.file('word/styles.xml')!.async('string');
      templateZip.file('word/styles.xml', styles.replace(/(<w:style [^>]*w:styleId="Heading1"[^]*?<w:pPr>)/, (style: string) => style + '<w:numPr><w:numId w:val="5"/></w:numPr>'));
    }
    const templateDocx = await templateZip.generateAsync({ type: 'uint8array' });
    const md = '# H\n\n3. a\n4. b';
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect(await levelOverridesOf(docx, 0)).toBe('<w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride>');
    expect(await roundTripWith(md, templateDocx)).toBe(md);
  });

  test('shares the instance with an empty level override in a template with a list that starts at 0', async () => {
    // Word starts it at 0 there, which import read as the level's start
    const templateDocx = await templateWithNumbering(numbering => withLevelStart(0, 3)(numbering)
      .replace(/(<w:num w:numId="2"[^>]*><w:abstractNumId w:val="1"\/>)/, (instance: string) => instance + '<w:lvlOverride w:ilvl="0"/>'));
    const md = '0. a\n1. b';
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect(numIdsOf(await documentXml(docx))).toEqual(['2', '2']);
    const once = await roundTripWith(md, templateDocx);
    expect(once).toBe(md);
    expect(await roundTripWith(once, templateDocx)).toBe(md);
  });

  test.each([
    ['at 1', (numbering: string) => numbering, '- x\n\n1. a\n2. b'],
    ['at 3', withLevelStart(0, 3), '- x\n\n3. a\n4. b'],
  ])('starts a list after bullets in its own instance where a template\'s bullets count with its numbers, which start %s', async (_name, edit, md) => {
    // Bullets in an instance of the numbers' abstract numbering, as a level
    // override makes a bullet's, moved the count of the numbers' instance
    // on, which the list took
    const templateDocx = await templateWithNumbering(numbering => edit(numbering).replace(/(<w:num w:numId="1"[^>]*>)<w:abstractNumId w:val="0"\/>/,
      (_match, num: string) => num + '<w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:lvlOverride>'));
    const { docx } = await convertMdToDocx(md, { templateDocx });
    expect(numIdsOf(await documentXml(docx))[0]).toBe('1');
    expect(await levelOverridesOf(docx, 1)).toBe('<w:lvlOverride w:ilvl="0"><w:startOverride w:val="' + md.slice(md.indexOf('\n\n') + 2, md.indexOf('.')) + '"/></w:lvlOverride>');
    // As Word numbers it. Import reads the bullet as its abstract
    // numbering's number, not the level override's bullet.
    expect((await convertDocx(docx)).markdown).toEndWith(md.slice(md.indexOf('\n\n') + 2) + '\n');
  });

  test.each([
    // An override of the parents' levels would number their lists, as Word
    // counts the instances of a list as one, which gives %1.%2 2.1 without it
    ['a restarted sublist', '1. a\n\n<!-- -->\n\n1. b\n2. c\n   1. x\n\n   <!-- -->\n\n   1. y', 4, 1],
    ['a numbered list in a bullet list in a numbered one', '1. a\n   - b\n     1. c\n     2. d\n2. e', 2, 2],
  ])('starts only its own level over in the numbering of %s', async (_name, md, index, ilvl) => {
    const { docx } = await convertMdToDocx(md);
    expect(await levelOverridesOf(docx, index)).toBe('<w:lvlOverride w:ilvl="' + ilvl + '"><w:startOverride w:val="1"/></w:lvlOverride>');
    expect(await roundTrip(md)).toBe(md);
  });

  test('keeps a template\'s level formats in a sublist\'s numbering without their starts', async () => {
    const lvl = '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1)"/><w:lvlJc w:val="left"/></w:lvl>';
    const templateDocx = await templateWithNumbering(numbering => numbering.replace(/(<w:num w:numId="2"[^>]*><w:abstractNumId w:val="1"\/>)/,
      '$1<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>' + lvl + '</w:lvlOverride><w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"/></w:lvlOverride>'));
    const md = '1. a\n   - b\n     1. c\n2. d';
    const { docx } = await convertMdToDocx(md, { templateDocx });
    // A level override with nothing in it would start its level at 0
    expect(await levelOverridesOf(docx, 2)).toBe('<w:lvlOverride w:ilvl="0">' + lvl + '</w:lvlOverride>'
      + '<w:lvlOverride w:ilvl="2"><w:startOverride w:val="1"/></w:lvlOverride>');
    expect(strip((await convertDocx(docx)).markdown)).toBe(md);
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
    // Its style numbers in the lists' count, so each list starts in a numbering of its own
    expect(numIdsOf(await documentXml(docx))).toEqual(['8', '9']);
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

describe('Empty Word paragraphs before a block', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  // The Markdown of a document of the paragraphs in `body`. Export's
  // numbering numbers with instance 1 a bullet list and with instance 2 a
  // numbered one
  const imported = async (body: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('1. a')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:body>[\s\S]*?(?=<w:sectPr)/, () => '<w:body>' + body));
    return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
  };
  const p = (text: string, pPr = '') => '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + (text ? '<w:r><w:t>' + text + '</w:t></w:r>' : '') + '</w:p>';
  const item = (text: string, numId = 2, ilvl = 0) => p(text, '<w:numPr><w:ilvl w:val="' + ilvl + '"/><w:numId w:val="' + numId + '"/></w:numPr>');
  const heading = (text: string, level: number) => p(text, '<w:pStyle w:val="Heading' + level + '"/>');
  const empty = '<w:p/>';

  test.each([
    ['list items', item('a') + empty + item('b'), '1. a\n2. b'],
    ['bullet list items', item('a', 1) + empty + empty + item('b', 1), '- a\n- b'],
    ['an item and its sublist', item('a') + empty + item('x', 2, 1), '1. a\n   1. x'],
    ['a paragraph and a list', p('A') + empty + item('b'), 'A\n\n1. b'],
    ['a list and a heading', item('a') + empty + heading('G', 2), '1. a\n\n## G'],
    ['a heading and a list', heading('H', 1) + empty + item('b', 1), '# H\n\n- b'],
    ['a paragraph and a heading', p('A') + empty + empty + heading('G', 2), 'A\n\n## G'],
    ['a paragraph and a code block', p('A') + empty + p('code', '<w:pStyle w:val="CodeBlock"/>'), 'A\n\n```\ncode\n```'],
    ['a list and a rule', item('a') + empty + p('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>') + p('B'), '1. a\n\n---\n\nB'],
  ])('reads an empty paragraph between %s as the blank line between them', async (_name, body, md) => {
    // As one before a paragraph: export reads more blank lines as one, so
    // the next trip would drop them
    const markdown = await imported(body);
    expect(strip(markdown)).toBe(md);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  const revision = (kind: string, id: number) => '<w:' + kind + ' w:id="' + id + '" w:author="X" w:date="2024-01-01T00:00:00Z"';
  const markTracked = (kind: string) => '<w:rPr>' + revision(kind, 1) + '/></w:rPr>';
  const tracked = (kind: string, text: string, pPr = '') => '<w:p><w:pPr>' + pPr + markTracked(kind) + '</w:pPr>'
    + revision(kind, 2) + '><w:r><w:' + (kind === 'del' ? 'delText' : 't') + '>' + text + '</w:' + (kind === 'del' ? 'delText' : 't') + '></w:r></w:' + kind + '></w:p>';

  test.each([
    ['a paragraph mark inserted and a heading', p('A', markTracked('ins')) + empty + heading('G', 2), 'A{++\n\n++}\n\n## G'],
    ['an item inserted and an item', tracked('ins', 'a', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') + empty + item('b'), '1. {++a\n\n   ++}\n2. b'],
    ['a paragraph deleted and a list', tracked('del', 'A') + empty + item('b'), '{--A\n\n--}\n\n1. b'],
  ])('reads an empty paragraph between %s as the blank line between them', async (_name, body, md) => {
    // The tracked mark is in the text before it
    const markdown = await imported(body);
    expect(strip(markdown)).toBe(md);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  test('keeps a list item with no text between items', async () => {
    const markdown = await imported(item('a') + item('') + item('b'));
    expect(strip(markdown)).toBe('1. a\n2. \n3. b');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
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
    ['that is an item', '- <!-- c -->\n- b\n'],
    ['under an item', '- a\n\n  <!-- c -->\n'],
    ['of more than one line under an item', '- a\n\n  <!-- c\n  d -->\n'],
    ['under an item before HTML', '- a\n\n  <!-- c -->\n\n  <div>b</div>\n'],
    ['under an item in a sublist', '1. a\n   - b\n\n     <!-- c -->\n'],
    // Which export counted among those of their own, so the next took the
    // blank lines of the one before
    ['under an item before one of its own with blank lines after it', '- a\n\n  <!-- c -->\n\n<!-- c -->\n\n\nP.\n'],
    // Whole, with the HTML between, as at the top level
    ['that is an item and ends a block with HTML in it', '- <!-- c --><div>b</div><!-- d -->\n'],
    ['under an item that ends a block with HTML in it', '- a\n\n  <!-- c --><div>b</div><!-- d -->\n'],
    // Whose lines, with the item's indent, the next one alike matched, so it
    // took the blank line export puts before a grid table
    ['of more than one line under an item before one alike right before a grid table',
      '- a\n\n  <!-- c\n  d -->\n\n<!-- c\nd -->\n+-----+\n| x   |\n+=====+\n| y   |\n+-----+\n'],
    ['under an item before one alike right before a grid table', '- a\n\n  <!-- c -->\n\n<!-- c -->\n+-----+\n| x   |\n+=====+\n| y   |\n+-----+\n'],
  ])('keeps a comment %s, hidden', async (_name, md) => {
    // Export dropped a block that starts with a comment in an item
    expect(await roundTrip(md)).toBe(md);
    expect((await convertMdToDocx(md)).warnings).toEqual([]);
  });

  test.each([
    ['under an item', '- a\n\n  <!-- c --><div>b</div>\n', '- a\n\n  \\<!-- c --><div>b</div>\n'],
    ['under an item, with a space before the HTML', '- a\n\n  <!-- c --> <div>b</div>\n', '- a\n\n  \\<!-- c --> <div>b</div>\n'],
    ['under an item, indented past it', '- a\n\n   <!-- c --><div>b</div>\n', '- a\n\n  &#32;\\<!-- c --><div>b</div>\n'],
    ['that is an item', '- <!-- c --><div>b</div>\n', '- \\<!-- c --><div>b</div>\n'],
  ])('keeps a block a comment starts %s as text, as at the top level', async (_name, md, expected) => {
    // Export dropped it, with the HTML after the comment
    expect((await convertMdToDocx(md)).warnings).toEqual([]);
    expect(await roundTrip(md)).toBe(expected);
    expect(await roundTrip(expected)).toBe(expected);
  });

  test.each([
    ['an item', '- a<!-- c -->\n- b', '<w:r><w:t>a</w:t></w:r>', '', '- <!-- c -->\n- b\n'],
    ['a paragraph under an item', '- a\n\n  b', '<w:r><w:t>b</w:t></w:r>', '<w:r><w:rPr><w:vanish/></w:rPr><w:t>&lt;!-- c --&gt;</w:t></w:r>', '- a\n\n  <!-- c -->\n'],
  ])('keeps %s of a hidden comment from Word', async (_name, md, run, hidden, expected) => {
    // Import wrote its comment, which export dropped, with a warning
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain(run);
    zip.file('word/document.xml', xml.replace(run, hidden));
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe(expected);
    expect((await convertMdToDocx(markdown)).warnings).toEqual([]);
    expect(await roundTrip(markdown)).toBe(markdown);
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
    expect(markdown).toBe('10. a\n    - b\n\n      more\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('indents the items at a level Word skipped alike', async () => {
    // The width of the first marker went in the place of the skipped level's
    expect(await skippingLevel1('- a\n\n  10. b\n  11. c\n')).toBe('- a\n\n  10. b\n  11. c\n');
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

describe('List levels Word skips', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const imported = async (docx: Uint8Array) => strip((await convertDocx(docx)).markdown);
  /** md's export with its list items at `levels` in order, as Word can skip
   *  levels, and `edit` made to its XML */
  const atLevels = async (md: string, levels: number[], edit = (xml: string) => xml) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    let k = 0;
    zip.file('word/document.xml', edit(xml.replace(/<w:ilvl w:val="\d+"\/>/g, () => '<w:ilvl w:val="' + levels[k++] + '"/>')));
    return zip.generateAsync({ type: 'uint8array' });
  };
  /** The kind and text of each paragraph Word shows */
  const shown = async (docx: Uint8Array) => {
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(([p]) => p)
      .filter(p => !p.includes('<w:vanish/>') && /<w:t[ >]/.test(p))
      .map(p => (/<w:numPr>/.test(p) ? 'list' : /<w:pStyle w:val="([^"]*)"/.exec(p)?.[1] ?? 'plain') + ': '
        + [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(t => t[1]).join(''));
  };
  /** The Markdown import writes for docx, after checking that it reads back
   *  the same and that its export shows the same paragraphs as docx */
  const stable = async (docx: Uint8Array) => {
    const markdown = await imported(docx);
    const exported = (await convertMdToDocx(markdown)).docx;
    expect(await imported(exported)).toBe(markdown);
    expect(await shown(exported)).toEqual(await shown(docx));
    return markdown;
  };

  test.each([
    ['a list at level 1 at the start', '- a\n- b\n', [1, 1]],
    ['a list at level 2 at the start', '- a\n- b\n', [2, 2]],
    ['a list at level 1 after a paragraph', 'Text\n\n- a\n- b\n', [1, 1]],
    ['a list at level 2 after a paragraph', 'Text\n\n- a\n- b\n', [2, 2]],
    ['a numbered list at level 1 at the start', '1. a\n2. b\n', [1, 1]],
    ['a numbered list at level 2 after a paragraph', 'Text\n\n1. a\n2. b\n', [2, 2]],
  ])('writes %s at the top level', async (_name, md, levels) => {
    // Indented for its level, it read as a list at the top, or at 4 columns as code
    expect(await stable(await atLevels(md, levels))).toBe(md);
  });

  test('numbers no paragraph at a level above 8, however high', async () => {
    const zip = await JSZip.loadAsync(await atLevels('1. a\n   1. b\n2. c\n', [0, 1000000000, 0]));
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    zip.file('word/numbering.xml', numbering.replace(/(<w:abstractNum w:abstractNumId="1"[^>]*>[\s\S]*?)(<\/w:abstractNum>)/, (_match, levels: string, end: string) =>
      levels + '<w:lvl w:ilvl="1000000000"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>' + end));
    const markdown = await imported(await zip.generateAsync({ type: 'uint8array' }));
    // As Word numbers it, if it opens the file, with no level of its own
    expect(markdown).toBe('1. a\n\nb\n\n2. c\n');
    expect(await imported((await convertMdToDocx(markdown)).docx)).toBe(markdown);
  });

  test.each([
    ['from 0 to 2', '- a\n  - b\n  - c\n- d\n', [0, 2, 2, 0]],
    ['from 0 to 3', '- a\n  - b\n  - c\n- d\n', [0, 3, 3, 0]],
    ['from 0 to 2 in a numbered list', '1. a\n   1. b\n   2. c\n2. d\n', [0, 2, 2, 0]],
    ['from 0 to 3 in a numbered list', '1. a\n   1. b\n   2. c\n2. d\n', [0, 3, 3, 0]],
    ['from 0 to 2 for bullets in a numbered item', '1. a\n   - b\n2. c\n', [0, 2, 0]],
    ['from 0 to 3 for numbers in a bullet item', '- a\n  1. b\n- c\n', [0, 3, 0]],
    ['from 0 to 2 under item 10', '9. a\n10. b\n    - c\n', [0, 0, 2]],
    ['from 0 to 2 and 2 to 4', '1. a\n   1. b\n      1. c\n', [0, 2, 4]],
    ['from 0 to 2, then back to the level skipped', '- a\n  - b\n  - c\n    - d\n', [0, 2, 1, 2]],
  ])('nests an item one level under the item before where Word jumps %s', async (_name, md, levels) => {
    // Indented for its level, it nested a level too deep, or went in the
    // text of the item before, or read as code
    expect(await stable(await atLevels(md, levels))).toBe(md);
  });

  test.each([
    ['paragraph', '- a\n  - b\n\n  more\n  - c\n'],
    ['quote', '- a\n  - b\n\n  > q\n\n  - c\n'],
  ])('nests an item one level under an item whose %s ends the items under it', async (_name, md) => {
    // Word's level 2 indented it under the item at level 1, which Markdown
    // had ended, and it read as level 1
    expect(await stable(await atLevels(md, [0, 1, 2]))).toBe(md);
  });

  test('keeps the number Word shows an item after a level it skipped', async () => {
    // Word numbers it at its own level, which the item under it counted from
    // 1, where Markdown would go on from the items at the level it skipped,
    // which nest at the same depth
    const markdown = await stable(await atLevels('1. a\n   1. b\n   2. c\n   3. d\n', [0, 2, 2, 1]));
    expect(markdown).toBe('1. a\n   1. b\n   2. c\n\n   <!-- -->\n\n   2. d\n');
  });

  test.each([
    ['a paragraph', '- a\n  - b\n\n    more\n', (xml: string) => xml.replace(/w:left="1440"/g, 'w:left="2160"')],
    ['a quote', '- a\n  - b\n\n    > q\n', (xml: string) => xml.replace(/w:left="1680"/g, 'w:left="2400"')],
    ['an equation', '- a\n  - b\n    ' + '$' + '$\n    x\n    ' + '$' + '$\n', (xml: string) => xml],
  ])('indents %s in an item at a level Word skipped as the item', async (_name, md, edit) => {
    // Indented for the level Word gives its item, it went past the item's text
    expect(await stable(await atLevels(md, [0, 2], edit))).toBe(md);
  });

  test.each([
    ['at the start', '- [ ] a\n- [x] b\n', (xml: string) => xml.replace(/w:left="720"/g, 'w:left="2160"')],
    ['under one at level 0', 'Text\n\n- [ ] a\n  - [x] b\n', (xml: string) => xml.replace(/w:left="1440"/g, 'w:left="2880"')],
  ])('writes a task item at a level Word skipped, %s, as a list item', async (_name, md, edit) => {
    // Its indent's level was the item's, which read as code at the start
    expect(await stable(await atLevels(md, [], edit))).toBe(md);
  });

  test.each([
    ['at the start', '- a\n\t- b\n', [2, 2], '-\ta\n-\tb\n'],
    ['after level 0', '- a\n\t- b\n\t- c\n', [0, 2, 2], '-\ta\n\t-\tb\n\t-\tc\n'],
  ])('indents an item at a level Word skipped %s with a tab for each level it nests at', async (_name, md, levels, expected) => {
    // A tab for each level Word gives it read as code
    expect(await stable(await atLevels(md, levels))).toBe(expected);
  });

  /** xml with para before its last paragraph */
  const before = (xml: string, para: string) => xml.slice(0, xml.lastIndexOf('<w:p ')) + para + xml.slice(xml.lastIndexOf('<w:p '));

  test.each([
    ['at the next level', '9. a\n10. b\n    - c\n', [0, 0, 1]],
    ['at a level after one Word skipped', '- a\n  - b\n', [0, 2]],
  ])('nests an item after an empty paragraph in the item before, %s', async (_name, md, levels) => {
    // The empty paragraph lost the width of the item's marker, and the item
    // indented for a bullet's left the numbered item. It's the blank line
    // before the item, which export reads as none, as it writes no empty
    // paragraph between items
    const docx = await atLevels(md, levels, xml => before(xml, '<w:p/>'));
    expect(await imported(docx)).toBe(md);
    expect(await imported((await convertMdToDocx(md)).docx)).toBe(md);
  });

  test.each([
    ['an item at the next level after an empty paragraph', '10. x\n    - b\n', '10. \n\n- b\n', '10. \n\n- b\n', (xml: string) => before(xml, '<w:p/>')],
    ['a paragraph in it', '10. x\n\n    more\n', '10. \n\nmore\n', '10. \n\nmore\n', (xml: string) => xml],
    ['a quote in it after a blank line', '10. x\n\n    > q\n', '10. \n\n> q\n', '10. \n\n> q\n', (xml: string) => xml],
  ])('ends an item with no text before %s, as the blank line does', async (_name, md, expected, again, edit) => {
    // Indented under the item's marker after the blank line, it read as code
    const markdown = await imported(await atLevels(md, [0, 1], xml => edit(xml.replace('<w:r><w:t>x</w:t></w:r>', ''))));
    expect(markdown).toBe(expected);
    expect(await imported((await convertMdToDocx(markdown)).docx)).toBe(again);
  });

  test('keeps a quote right under the marker of an item with no text in it', async () => {
    const markdown = await imported(await atLevels('10. x\n    > q\n', [0], xml => xml.replace('<w:r><w:t>x</w:t></w:r>', '')));
    expect(markdown).toBe('10. \n    > q\n');
    expect(await imported((await convertMdToDocx(markdown)).docx)).toBe(markdown);
  });

  test.each([
    ['a numbered heading', '# T\n\n- a\n\n  more\n', '# T\n\n- a\n\n## H\n\nmore\n', (xml: string) => before(xml,
      '<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="' + /<w:numId w:val="(\d+)"/.exec(xml)![1] + '"/></w:numPr></w:pPr><w:r><w:t>H</w:t></w:r></w:p>',
    ).replace('w:left="720"', 'w:left="1440"')],
    ['a quote out of the list', '- a\n  - b\n\n    more\n', '- a\n  - b\n\n> q\n\nmore\n', (xml: string) => before(xml,
      '<w:p><w:pPr><w:pStyle w:val="GitHubBlockquote"/><w:ind w:left="240"/></w:pPr><w:r><w:t>q</w:t></w:r></w:p>')],
  ])('writes a paragraph indented for an item after %s, which ends the list, in no item', async (_name, md, expected, edit) => {
    // It took the indent of an item that Markdown had ended, which read as code
    const markdown = await imported(await atLevels(md, [0, 1], edit));
    expect(markdown).toBe(expected);
    expect(await imported((await convertMdToDocx(markdown)).docx)).toBe(markdown);
  });

  test('puts an item after a numbered heading at the top', async () => {
    // The heading ended no list, and the item nested under the one before it
    const docx = await atLevels('- a\n\n## H\n\n- b\n', [0, 1], xml => xml.replace('<w:pStyle w:val="Heading2"/>',
      '<w:pStyle w:val="Heading2"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="' + /<w:numId w:val="(\d+)"/.exec(xml)![1] + '"/></w:numPr>'));
    const markdown = await imported(docx);
    expect(markdown).toBe('- a\n\n## H\n\n- b\n');
    expect(await imported((await convertMdToDocx(markdown)).docx)).toBe(markdown);
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

  /** Each paragraph's text in docx, with a tracked mark's type before it */
  const paragraphs = async (docx: Uint8Array) => {
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    return [...xml.matchAll(/<w:p[ >](?:(?!<\/w:p>).)*<\/w:p>/g)].map(([p]) => {
      const mark = /<w:pPr>(?:(?!<\/w:pPr>).)*<w:(ins|del) /.exec(p)?.[1];
      const text = [...p.matchAll(/<w:(?:t|delText)(?: [^>]*)?>([^<]*)<|<w:tab\/>/g)].map(m => m[1] ?? '\t').join('');
      return (mark ? mark + ': ' : '') + text;
    }).filter(text => text !== '');
  };

  test.each([
    ['spaces', '- [ ] &#32;&#32;t', '☐   t'],
    ['a tab', '- [ ] &#9;t', '☐ \tt'],
    ['a no-break space', '- [ ] &nbsp;t', '☐ \u00a0t'],
    ['spaces after a checked box', '- [x] &#32;t', '☒  t'],
    ['spaces in a numbered item', '1. [ ] &#32;t', '☐  t'],
  ])('keeps %s at the start of a task item\'s text', async (_name, md, word) => {
    // The box took them, as references, with the space after it
    const { docx } = await convertMdToDocx(md);
    expect(await paragraphs(docx)).toEqual([word]);
    expect(strip((await convertDocx(docx)).markdown)).toBe(md);
  });

  test.each([
    ['a no-break space before an escape', '- [ ] \u00a0todo\\!', '☐ todo!'],
    ['an em space before an escape', '- [ ] \u2003todo\\!', '☐ todo!'],
    ['a no-break space before a reference', '- [ ] \u00a0&#32;todo', '☐  todo'],
  ])('takes %s after a task item\'s box with the box, as it does without one', async (_name, md, word) => {
    // An escape or a reference after it took only spaces and tabs as the box's
    expect(await paragraphs((await convertMdToDocx(md)).docx)).toEqual([word]);
  });

  test.each([
    ['deleted', '- [ ] XX\n\n  c', 'del', '- [ ] &#32;&#32;{--\n\n  --}c', ['del: ☐   ', 'c']],
    ['inserted', '- [ ] XX\n\n  c', 'ins', '- [ ] &#32;&#32;{++\n\n  ++}c', ['ins: ☐   ', 'c']],
    ['deleted, before another item', '- [ ] XX\n- [ ] c', 'del', '- [ ] &#32;&#32;{--\n\n  --}\n- [ ] c', ['del: ☐   ', '☐ c']],
  ])('keeps the spaces alone after a task item\'s box whose paragraph\'s mark is %s', async (_name, md, type, expected, word) => {
    // The box took them, and the tracked break after them with them, as it
    // then opened the item's text
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/(<w:ind w:left="720" w:hanging="360"\/>)(<\/w:pPr>)/,
      '$1<w:rPr><w:' + type + ' w:id="91" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr>$2')
      .replace('<w:r><w:t>XX</w:t></w:r>', '<w:r><w:t xml:space="preserve">  </w:t></w:r>');
    expect(edited).not.toContain('XX');
    zip.file('word/document.xml', edited);
    const docx = await zip.generateAsync({ type: 'uint8array' });
    expect(await paragraphs(docx)).toEqual(word);
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(expected);
    const again = (await convertMdToDocx(markdown)).docx;
    expect(await paragraphs(again)).toEqual(word);
    expect(strip((await convertDocx(again)).markdown)).toBe(markdown);
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

  test.each([['a table cell'], ['a footnote']])('writes a comment over ==} split between a citation without keys and text in %s in ID syntax', (where) => {
    // The citation, which goes as text there too, wasn't read as text for
    // the anchor's end, which then closed early
    const comments = new Map([['c1', { author: 'A', text: 'c', date: '' }]]);
    const ids = new Set(['c1']);
    const runs: ContentItem[] = [
      { type: 'citation', text: 'x ==', pandocKeys: [], commentIds: ids },
      { type: 'text', text: '} y', commentIds: ids, formatting: DEFAULT_FORMATTING },
    ];
    const md = where === 'a footnote'
      ? buildMarkdown([{ type: 'para' }, { type: 'text', text: 'Body', commentIds: new Set(), formatting: DEFAULT_FORMATTING }, { type: 'footnote_ref', noteId: '1', noteKind: 'footnote', commentIds: new Set() }] as ContentItem[], comments, {
        notes: { map: new Map([['footnote:1', { label: '1', body: [{ type: 'para' } as ContentItem, ...runs], noteKind: 'footnote' as const }]]), assignedLabels: new Map([['footnote:1', '1']]) },
      })
      : buildMarkdown([{ type: 'table', rows: [
        { isHeader: true, cells: [{ paragraphs: [[{ type: 'text', text: 'a', commentIds: new Set(), formatting: DEFAULT_FORMATTING } as ContentItem]] }] },
        { isHeader: false, cells: [{ paragraphs: [runs] }] },
      ] } as ContentItem], comments);
    expect(md).toContain('{#1}x ==} y{/1}');
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

  test.each([
    ['a paragraph', 'A{#1}\n\nb{/1} c.\n' + body(1, 'p') + '\n'],
    ['a heading', '# A{#1}\n\nb{/1} c.\n' + body(1, 'h') + '\n'],
    ['a list item', '- A{#1}\n- b{/1} c.\n' + body(1, 'l') + '\n'],
    ['a quoted paragraph', '> A{#1}\n>\n> b{/1} c.\n> ' + body(1, 'q') + '\n'],
    ['a paragraph that ends in an insertion', '{++A++}{#1}\n\nb{/1} c.\n' + body(1, 'i') + '\n'],
    ['a paragraph, with another comment', 'A{#1}{#2}\n\nb{/1} c{/2}.\n' + body(1, 'one') + '\n' + body(2, 'two') + '\n'],
    ['a paragraph before an equation', 'A{#1}\n\n' + MATH_FENCE + '\nx\n' + MATH_FENCE + '\n\nB{/1}\n' + body(1, 'm') + '\n'],
    ['a footnote\'s paragraph', 'Text.[^1]\n\n[^1]: A{#1}\n\n    b{/1} c.\n    ' + body(1, 'n') + '\n'],
  ])('keeps one that starts at the end of %s', async (_name, md) => {
    // It started at the next paragraph's text, as the paragraph mark it
    // started on had no item to hold it
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['a range that starts at its end', 'A{#1}\n\nb{/1}\n' + body(1, 'p') + '\n', '`A`{#1}\n\nb{/1}\n' + body(1, 'p') + '\n'],
    ['a comment at a point in it', 'A {>>@A (2024-01-15 10:30) | c<<} b\n', '`A `{>>@A (2024-01-15 10:30) | c<<}` b`\n'],
  ])('writes no code for %s where the paragraph\'s mark is code', async (_name, md, expected) => {
    // The empty item that holds it took the mark's formatting, and wrote
    // code's `` as text
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const p = xml.indexOf('<w:p', xml.indexOf('<w:body>'));
    const open = xml.indexOf('>', p) + 1;
    zip.file('word/document.xml', xml.slice(0, open) + '<w:pPr><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr></w:pPr>' + xml.slice(open));
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(expected);
  });

  test('keeps a range open around a table whose cells have comments of their own', () => {
    // A cell's comments in ID syntax closed it in the cell, and it opened again after
    const comments = new Map([['0', { author: 'A', text: 'c', date: '' }], ['1', { author: 'B', text: 'd', date: '' }], ['2', { author: 'C', text: 'e', date: '' }]]);
    const text = (t: string, ids: string[]) => ({ type: 'text', text: t, commentIds: new Set(ids), formatting: DEFAULT_FORMATTING });
    const markdown = buildMarkdown([
      text('P1', ['0']),
      { type: 'para' },
      { type: 'table', rows: [{ isHeader: true, cells: [{ paragraphs: [[text('x ', ['1']), text('y', ['1', '2']), text(' z', ['2'])]] }] }] },
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

  test.each([
    ['a paragraph', 'XX', '&#32;<!-- c -->'],
    ['a quote\'s paragraph', '> XX', '> &#32;<!-- c -->'],
    ['an item\'s paragraph after its first', '- a\n\n  XX', '- a\n\n  &#32;<!-- c -->'],
  ])('keeps a space before one that ends %s out of its hidden run', async (_name, source, md) => {
    // Raw, as an HTML block's indent, it went into the run, where export
    // puts one, or was gone with the block in an item
    // Each paragraph's runs' text, a hidden one's in []
    const texts = async (docx: Uint8Array) => [...(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string'))
      .matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(p => [...p[0].matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map(run => {
        const text = run[0].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '').replace(/<[^>]+>/g, '');
        return run[0].includes('<w:vanish/>') ? '[' + text + ']' : text;
      }).join(''));
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\n' + source + '\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>)[\s\S])*?>XX<\/w:t><\/w:r>/, '<w:r><w:t xml:space="preserve"> </w:t></w:r>'
      + '<w:r><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr><w:t>\u200B&lt;!-- c --&gt;</w:t></w:r>');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const docx = await zip.generateAsync({ type: 'uint8array' });
    const imported = (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(imported).toBe('A.\n\n' + md + '\n\nB.\n');
    expect(await texts((await convertMdToDocx(imported)).docx)).toEqual(await texts(docx));
  });

  test.each([
    ' <!-- c -->',
    // Which a paragraph would read as one comment, as the run holds them
    ' <!-- a ---> <!-- c -->',
  ])('keeps the indent of %s in its hidden run', async (comments) => {
    // Where export writes it, which import writes back as the indent
    const md = 'A.\n\n' + comments + '\n\nB.';
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md + '\n');
  });

  test.each([
    '<!-- c --><br>',
    '<!-- c --> <br>',
    '<!-- c -->\t<br>',
    '<!-- c --> <!-- e --><br>',
    '<!-- c --><br><br>',
    '<!-- c --><br> <br>',
    // Paragraphs, whose space Word shows before the comment's run
    '&#32;<!-- c -->',
    '&#32;<!-- c -->a',
  ])('keeps the blank lines around one of its own after %s', async (before) => {
    // Import counted the paragraph before among comments of their own, as
    // export doesn't, so the next took the blank lines of the one after it
    const md = 'A.\n\n' + before + '\n\n<!-- d -->\nB.\n';
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md);
  });

  test('keeps the blank lines around ones of their own after one Word put a comment on', async () => {
    // Import didn't count it, whose Markdown the comment's syntax is in, so
    // the ones after it took the blank lines of the ones after them
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\n<!-- a -->\n\n\n<!-- b -->\n\n\n\n<!-- c -->\n\nB {==x==}{>>@A (2024-01-15 10:30) | note<<}.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    // The comment's range and reference, moved from x to <!-- a -->'s run
    const start = '<w:commentRangeStart w:id="0"/>';
    const end = '<w:commentRangeEnd w:id="0"/>';
    const reference = /<w:r>(?:(?!<w:r>)[\s\S])*?<w:commentReference w:id="0"\/><\/w:r>/.exec(xml)![0];
    const edited = xml.replace(start, '').replace(end, '').replace(reference, '')
      .replace(/<w:r><w:rPr><w:vanish\/>(?:(?!<w:r>)[\s\S])*?&lt;!-- a --&gt;<\/w:t><\/w:r>/, run => start + run + end + reference);
    expect(edited).toContain(end + reference);
    zip.file('word/document.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(markdown).toBe('A.\n\n<!-- a -->{>>@A (2024-01-15 10:30) | note<<}\n\n\n<!-- b -->\n\n\n\n<!-- c -->\n\nB x.\n');
  });

  test('keeps the blank lines around ones of their own after one whose run Word split', async () => {
    // Export wrote them as one run, a paragraph it counts
    const md = 'A.\n\n<!-- c --><!-- d -->\n\n\n<!-- e -->\n\n\n\n<!-- f -->\n\nB.\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace('&lt;!-- c --&gt;&lt;!-- d --&gt;</w:t></w:r>',
      '&lt;!-- c --&gt;</w:t></w:r><w:r><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr><w:t>&lt;!-- d --&gt;</w:t></w:r>');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md);
  });

  // A comment's hidden run, as export writes one
  const hidden = (text: string) => '<w:r><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr>'
    + ('<w:t xml:space="preserve">\u200B' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</w:t>').replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">') + '</w:r>';
  const visible = (inner: string) => '<w:r>' + inner + '</w:r>';
  const space = visible('<w:t xml:space="preserve"> </w:t>');
  test.each([
    ['a space after it', hidden('<!-- a -->') + space, true],
    ['a tab after it', hidden('<!-- a -->') + visible('<w:tab/>'), true],
    ['a space between it and another', hidden('<!-- a -->') + space + hidden('<!-- z -->'), true],
    ['spaces around one only a block holds', space + hidden('<!-- a\n\nz -->') + space, true],
    // Whose indent export put in its run
    ['an indent in its run and a space after it', hidden(' <!-- a -->') + space, true],
    // Which import writes as a reference, before which export reads a paragraph
    ['a space before it', space + hidden('<!-- a -->'), false],
    ['text after it', hidden('<!-- a -->') + visible('<w:t>x</w:t>'), false],
  ])('counts one with %s among comments of their own where export does what import writes', async (_name, runs, counts) => {
    // Import didn't count one with a space or tab Word put after its run,
    // which export trims, so the ones after it took the blank lines of the
    // ones after them
    const md = 'A.\n\n<!-- a -->\n\n\n<!-- b -->\n\n\n\n<!-- c -->\n\nB.\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r><w:rPr><w:vanish\/>(?:(?!<w:r>)[\s\S])*?&lt;!-- a --&gt;<\/w:t><\/w:r>/, runs);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    // Export counts what import wrote for it, a comment of its own or not
    const tokens = parseMd(markdown);
    annotateHtmlCommentIndices(tokens);
    expect(tokens.filter(token => token.htmlCommentIndex !== undefined).length).toBe(counts ? 3 : 2);
    // And the ones after it keep their blank lines where import counts it too
    expect(markdown.endsWith('\n\n\n<!-- b -->\n\n\n\n<!-- c -->\n\nB.\n')).toBe(counts);
  });

  test.each([
    ['a space', space, ' '],
    ['a tab', visible('<w:tab/>'), '\t'],
  ])('keeps the indent export put in a comment\'s hidden run there with %s Word put after the run', async (_name, after, whitespace) => {
    // The paragraph's runs held more than its comments, so import wrote the
    // indent as a reference, which export showed
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\n <!-- a -->\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r><w:rPr><w:vanish\/>(?:(?!<w:r>)[\s\S])*?&lt;!-- a --&gt;<\/w:t><\/w:r>/, run => run + after);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(markdown).toBe('A.\n\n <!-- a -->' + whitespace + '\n\nB.\n');
    const exported = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(exported).toContain('\u200B &lt;!-- a --&gt;');
  });

  const start = '<w:commentRangeStart w:id="0"/>';
  const end = '<w:commentRangeEnd w:id="0"/>';
  test.each([
    ['its run', start + hidden('<!-- a -->') + end, true],
    ['its run, with a space after the range', start + hidden('<!-- a -->') + end + space, true],
    ['its run, before another', start + hidden('<!-- a -->') + end + hidden('<!-- z -->'), true],
    // Which its paragraph keeps as text between the ID syntax and the comment
    ['its run and a space after it', start + hidden('<!-- a -->') + space + end, false],
    ['a space before it and its run', start + space + hidden('<!-- a -->') + end, false],
  ])('counts one with a Word comment on %s in ID syntax among comments of their own where export does what import writes', async (_name, runs, counts) => {
    // Import didn't count one its {#1} started, which the document's export
    // had counted, and export didn't count what import wrote, so the ones
    // after it took the blank lines of the ones after them
    const md = 'A.\n\n<!-- a -->\n\n\n<!-- b -->\n\n\n\n<!-- c -->\n\nB {==x==}{>>@A (2024-01-15 10:30) | note<<}.';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    // The comment's range and reference, moved from x to around the runs
    const reference = /<w:r>(?:(?!<w:r>)[\s\S])*?<w:commentReference w:id="0"\/><\/w:r>/.exec(xml)![0];
    const edited = xml.replace(start, '').replace(end, '').replace(reference, '')
      .replace(/<w:r><w:rPr><w:vanish\/>(?:(?!<w:r>)[\s\S])*?&lt;!-- a --&gt;<\/w:t><\/w:r>/, runs.replace(end, end + reference));
    expect(edited).toContain(end + reference);
    zip.file('word/document.xml', edited);
    const options = { alwaysUseCommentIds: true };
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }), 'authorYearTitle', options)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(markdown.startsWith('A.\n\n{#1}')).toBe(true);
    const tokens = parseMd(markdown);
    annotateHtmlCommentIndices(tokens);
    expect(tokens.filter(token => token.htmlCommentIndex !== undefined).length).toBe(counts ? 3 : 2);
    const after = '\n\n\n<!-- b -->\n\n\n\n<!-- c -->\n\nB x.\n';
    expect(markdown.endsWith(after)).toBe(counts);
    // A second trip, which reads what export counts, keeps them
    const again = (await convertDocx((await convertMdToDocx(markdown)).docx, 'authorYearTitle', options)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const from = (text: string) => text.slice(text.indexOf('<<}\n'));
    expect(from(again)).toBe(from(markdown));
  });

  test.each([
    'A.\n\n\n{#1}<!-- a -->{/1}\n{#1>>@A (2024-01-15 10:30) | note<<}\n\n\nB.\n',
    'A.\n\n<!-- b -->\n{#1}<!-- a -->{/1}\n{#1>>@A (2024-01-15 10:30) | note<<}\n\n\n\nB.\n',
  ])('keeps the blank lines around one with a Word comment on it in ID syntax in %s', async (md) => {
    // Export didn't count it, nor keep its blank lines, which import then
    // wrote one of
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx, 'authorYearTitle', { alwaysUseCommentIds: true })).markdown;
    expect(markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md);
  });

  const bodies = '{#1>>@A (2024-01-15 10:30) | one<<}\n{#2>>@A (2024-01-15 10:30) | two<<}';
  test.each([
    ['a line end between their openers', '{#1}\n{#2}<!-- a -->{/2}{/1}'],
    ['a line end before their closers', '{#1}{#2}<!-- a -->\n{/2}{/1}'],
    ['a line end between their closers', '{#1}{#2}<!-- a -->{/2}\n{/1}'],
    ['a space between their openers', '{#1} {#2}<!-- a -->{/2}{/1}'],
    ['a tab between their openers', '{#1}\t{#2}<!-- a -->{/2}{/1}'],
    ['a space between their closers', '{#1}{#2}<!-- a -->{/2} {/1}'],
  ])('counts no paragraph of a comment in ID syntax with %s among comments of their own', async (_name, paragraph) => {
    // Word shows the line end as a space in the ranges, which import writes
    // between the syntax and the comment, so it counts no such paragraph,
    // but export dropped it with the line ends before the comments' bodies,
    // and counted it, so the ones after it took the blank lines of the ones
    // after them
    const md = 'A.\n\n' + paragraph + '\n' + bodies + '\n\n\n<!-- b -->\n\n\n\n<!-- c -->\n\nB.\n';
    const tokens = parseMd(md);
    annotateHtmlCommentIndices(tokens);
    expect(tokens.filter(token => token.htmlCommentIndex !== undefined).length).toBe(2);
    const after = '\n\n\n<!-- b -->\n\n\n\n<!-- c -->\n\nB.\n';
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(markdown.endsWith(after)).toBe(true);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(markdown);
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

  test.each([
    ['all of a style block', '<!-- style: quote -->\n<!-- a -->\n<!-- /style -->\n\nB.\n'],
    ['all of a style block, after blank lines', '<!-- style: quote -->\n\n\n<!-- a -->\n<!-- /style -->\n\nB.\n'],
    ['all of a style block with another', 'A.\n\n<!-- style: quote -->\n<!-- a -->\n<!-- b -->\n<!-- /style -->\n\nB.\n'],
    ['at the start of a style block', 'A.\n\n<!-- style: quote -->\n<!-- a -->\n\nText.\n<!-- /style -->\n\nB.\n'],
    ['at the end of a style block', '<!-- style: quote -->\nText.\n\n<!-- a -->\n<!-- /style -->\n\nB.\n'],
  ])('keeps an HTML comment of its own %s in the block, and hidden', async (_name, md) => {
    // Export hid its paragraph without the block's style, so import ended
    // the block before it, or wrote none where it was all of the block
    const docx = (await convertMdToDocx(md)).docx;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:pPr><w:pStyle w:val="MsCustomQuote"/><w:spacing w:after="0" w:line="1" w:lineRule="exact"/><w:rPr><w:vanish/>');
    let markdown = md;
    for (let i = 0; i < 2; i++) markdown = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(markdown).toBe(md);
  });

  test.each([
    ['a landscape section', '<!-- landscape -->\n\n<!-- a --><br>\n\n<!-- /landscape -->\n\nAfter.\n'],
    ['a tight landscape section', '<!-- landscape -->\n<!-- a --><br>\n<!-- /landscape -->\n'],
    ['a portrait section', '<!-- portrait -->\n\n<!-- a --> <!-- b --><br>\n\n<!-- /portrait -->\n\nAfter.\n'],
  ])('keeps the line end after the fence of %s that starts the document before a comment and a line break', async (_name, md) => {
    // Only a comment of its own wrote it, which has no para item there,
    // so the line went on after the fence, which then wasn't one
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
  test('generates unique keys and deduplicates by URI', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations);
    expect(keyMap.size).toBe(3); // Smith appears twice but same URI
    expect(keyMap.get('uri:http://zotero.org/users/0/items/AAAA1111')).toBe('smith2020effects');
    expect(keyMap.get('uri:http://zotero.org/users/0/items/BBBB2222')).toBe('jones2019urban');
    expect(keyMap.get('uri:http://zotero.org/users/0/items/CCCC3333')).toBe('davis2021advances');
  });

  test('supports authorYear format', async () => {
    const citations = await extractZoteroCitations(sampleData);
    const keyMap = buildCitationKeyMap(citations, 'authorYear');
    expect(keyMap.get('uri:http://zotero.org/users/0/items/AAAA1111')).toBe('smith2020');
    expect(keyMap.get('uri:http://zotero.org/users/0/items/BBBB2222')).toBe('jones2019');
    expect(keyMap.get('uri:http://zotero.org/users/0/items/CCCC3333')).toBe('davis2021');
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

  test('run boundary keeps trailing whitespace inside strikethrough, as Word strikes it', async () => {
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
    // In <s>, as ~~ can't close after a space
    expect(result.markdown).toBe('<s>Strike </s>Plain\n');
  });

  test('run boundary keeps trailing whitespace inside highlight delimiters, as Word highlights it', async () => {
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
    expect(result.markdown).toBe('==Mark =={green}Plain\n');
  });
});

describe('Numeric character references in Word\'s XML', () => {
  // Read as the characters they stand for, as an XML parser reads them,
  // where import kept them as text, as \&#x25CF; for a bullet
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const importWith = async (docx: Uint8Array, path: string, from: string, to: string) => {
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file(path)!.async('string');
    expect(xml).toContain(from);
    zip.file(path, xml.replace(from, to));
    return strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };

  test.each([
    ['characters', 'a&#x25CF;b&#233;c&#X1F600;d&#9;e', 'a\u25CFb\u00E9c\u{1F600}d\te'],
    ['characters markup reads', 'x&#60;y&#38;z&#62;&#x22;&#39;', 'x&lt;y&amp;z&gt;"\''],
    ['a reference written as text', '&#38;#x41; &amp;#233;', '&amp;#x41; &amp;#233;'],
  ])('reads %s in text as the characters themselves', async (_name, references, characters) => {
    const { docx } = await convertMdToDocx('PLACEHOLDER');
    const markdown = await importWith(docx, 'word/document.xml', 'PLACEHOLDER', references);
    expect(markdown).toBe(await importWith(docx, 'word/document.xml', 'PLACEHOLDER', characters));
    expect(markdown).not.toContain('&#x25CF;');
  });

  test('reads a carriage return as one, which the line ends XML reads as line feeds aren\'t', async () => {
    // Decoded before parsing, it became a line feed with them
    const { docx } = await convertMdToDocx('PLACEHOLDER');
    expect(await importWith(docx, 'word/document.xml', 'PLACEHOLDER', 'a&#13;b&#xd;&#10;c&#38;#13;')).toBe('a\rb\r\nc\\&#13;\n');
  });

  test('reads them in an attribute, as a link\'s target', async () => {
    const { docx } = await convertMdToDocx('[x](https://example.org/AB)');
    expect(await importWith(docx, 'word/_rels/document.xml.rels', 'https://example.org/AB', 'https://example.org/&#x41;&#66;'))
      .toBe('[x](https://example.org/AB)\n');
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
    expect(wrapWithFormatting('   ', { ...DEFAULT_FORMATTING, bold: true })).toBe('   ');
    // But a highlight's, which == holds, and Word shows the highlight on
    expect(wrapWithFormatting(' Mark ', { ...DEFAULT_FORMATTING, highlight: true })).toBe('== Mark ==');
    expect(wrapWithFormatting(' Mark ', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'green' })).toBe('== Mark =={green}');
    expect(wrapWithFormatting('   ', { ...DEFAULT_FORMATTING, highlight: true, highlightColor: 'green' })).toBe('==   =={green}');
    // And its line breaks, which Word highlights too
    expect(wrapWithFormatting('a\\\n', { ...DEFAULT_FORMATTING, highlight: true })).toBe('==a\\\n==');
    expect(wrapWithFormatting('\\\n', { ...DEFAULT_FORMATTING, highlight: true })).toBe('==\\\n==');
    // And strikethrough's, which Word shows too, and its line breaks', in
    // <s>, as ~~ can't close after whitespace or a line's start
    expect(wrapWithFormatting('Strike ', { ...DEFAULT_FORMATTING, strikethrough: true })).toBe('<s>Strike </s>');
    expect(wrapWithFormatting(' Strike', { ...DEFAULT_FORMATTING, strikethrough: true })).toBe('<s> Strike</s>');
    expect(wrapWithFormatting('   ', { ...DEFAULT_FORMATTING, strikethrough: true })).toBe('<s>   </s>');
    expect(wrapWithFormatting('a \\\n', { ...DEFAULT_FORMATTING, strikethrough: true })).toBe('<s>a \\\n</s>');
    expect(wrapWithFormatting('a\\\n', { ...DEFAULT_FORMATTING, strikethrough: true })).toBe('<s>a\\\n</s>');
    expect(wrapWithFormatting('\\\na', { ...DEFAULT_FORMATTING, strikethrough: true })).toBe('<s>\\\na</s>');
    expect(wrapWithFormatting('a\\\nb', { ...DEFAULT_FORMATTING, strikethrough: true })).toBe('~~a\\\nb~~');
    expect(wrapWithFormatting('Strike ', { ...DEFAULT_FORMATTING, strikethrough: true, bold: true })).toBe('**<s>Strike </s>**');
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

          // A highlight holds whitespace alone too, which Word shows it on
          if ((formatType === 'bold' || formatType === 'italic') && text.trim().length === 0) {
            expect(result).toBe(text);
            return;
          }
          // Strikethrough holds the whitespace at its edges, which Word
          // shows it on, in <s>, as ~~ can't hold it
          if (formatType === 'strikethrough' && /^\s|\s$/.test(text)) {
            expect(result).toMatch(/^<s>[\s\S]*<\/s>$/);
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
  test.each([
    [{ bold: true, italic: true }, ' '],
    [{ italic: true, strikethrough: true }, '*<s> </s>*'],
    [{ bold: true, strikethrough: true }, '**<s> </s>**'],
  ])('wraps whitespace alone with %j as %j', (fmt, expected) => {
    // The property expected struck whitespace bare, which it found only
    // where fast-check made a string of whitespace alone
    expect(wrapWithFormatting(' ', { ...DEFAULT_FORMATTING, ...fmt })).toBe(expected);
  });

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
          let result = wrapWithFormatting(text, fmt);

          // Bold or italic whitespace alone is bare, but struck whitespace
          // keeps its strike in <s>, which Word shows
          if (
            !fmt.code
            && text.trim().length === 0
            && (fmt.bold || fmt.italic)
            && !fmt.strikethrough
            && !fmt.highlight
            && !fmt.underline
            && !fmt.superscript
            && !fmt.subscript
          ) {
            expect(result).toBe(text);
            return;
          }

          // When code is true, the backtick fence is innermost, and the
          // rest goes around it, around each span of it split at an ==,
          // which would close a highlight
          if (fmt.code) {
            for (const part of fmt.highlight ? text.split(/(?<==)(?==)/) : [text]) {
              const fenced = wrapWithFormatting(part, { ...DEFAULT_FORMATTING, code: true });
              expect(result).toContain(fenced);
              result = result.replace(fenced, 'x');
            }
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
    ['an = before a highlight', [run('a='), run('b', { highlight: true })], 'a&#61;==b=='],
    ['an = between highlights', [run('a', { highlight: true }), run('='), run('b', { highlight: true, highlightColor: 'red' })], '==a==&#61;==b=={red}'],
  ])('writes %s as a reference, which would open it a character early', (_name, items, markdown) => {
    // Escaped, as a\===b==, navigation and the grammar read no highlight
    const written = buildMarkdown(items, new Map());
    expect(written).toBe(markdown);
    expect(characters(written)).toEqual(expectedCharacters(items));
  });

  test('keeps highlights side by side apart with the first one\'s color', () => {
    // Their == ran together, as ==yellow====cyan=={turquoise}, which
    // navigation and the grammar read as no highlight
    const items = [run('yellow', { highlight: true }), run('cyan', { highlight: true, highlightColor: 'cyan' })];
    expect(buildMarkdown(items, new Map())).toBe('==yellow=={yellow}==cyan=={turquoise}');
  });

  test('keeps code beside highlighted code with an == apart, with the highlights between them', () => {
    // One span held both, without the highlight, which the == would close
    const items = [run(':) ', { code: true }), run('$==', { code: true, highlight: true })];
    const written = buildMarkdown(items, new Map());
    expect(written).toBe('`:) `==`$=`=={yellow}==`=`=={yellow}');
    expect(characters(written)).toEqual(expectedCharacters(items));
  });

  test('keeps code beside bold code apart, with the bold between them', () => {
    expect(buildMarkdown([run('a', { code: true }), run('b', { code: true, bold: true })], new Map())).toBe('`a`**`b`**');
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

  const inCell = (items: ContentItem[], colspan = 1) => [{ type: 'table', rows: [{ isHeader: false, cells: [{ colspan, paragraphs: [items] }] }] } as unknown as ContentItem];
  test.each([
    ['a paragraph', (items: ContentItem[]) => items, '<!-- c -->'],
    ['a table\'s cell', inCell, '<!-- c -->'],
    // Which Word split from each other at an <!-- in one
    ['a paragraph, as pieces of one', (items: ContentItem[]) => items, ' <!-- c'],
    ['a table\'s cell, as pieces of one', inCell, ' <!-- c'],
    // Whose first piece was read again for each
    ['an HTML table\'s cell, as pieces of one after a long one', (items: ContentItem[]) => inCell(items, 2), '<!-- c', '<!-- ' + 'a'.repeat(32000)],
  ])('writes many HTML comments in %s in linear time', (_name, wrap, text, first = '<!-- a') => {
    // Each comment joined the text of all those after it
    const items = Array.from({ length: 32000 }, (_, i): ContentItem => ({ type: 'html_comment', text: i === 0 ? first : i === 31999 ? ' -->' : text, commentIds: new Set() }));
    const start = performance.now();
    buildMarkdown(wrap(items), new Map());
    expect(performance.now() - start).toBeLessThan(1000);
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
          // link's is as the link of one run of the text writes it, with
          // the escapes its brackets need, as of a citation's @
          const expectedRendering = href
            ? buildMarkdown([{ type: 'text', text: expectedText, commentIds: new Set<string>(), formatting, href }], new Map()).trim()
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
            // Strikethrough with whitespace at its edges is in <s>, which
            // holds it, as ~~ can't
            if (format === 'strikethrough' && linkText.includes('<s>')) continue;
            if (delimiter && (format !== 'subscript' || !formatting.superscript)) {
              expect(linkText).toContain(delimiter);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('keeps the strikethrough of whitespace at the edge of a link\'s text', async () => {
    const content: ContentItem[] = [{
      type: 'text', text: ' *', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, strikethrough: true }, href: 'https://e.com',
    }];
    const markdown = buildMarkdown(content, new Map());
    expect(markdown.trim()).toBe('[<s> \\*</s>](https://e.com)');
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml).toMatch(/<w:strike\/>[\s\S]*?<w:t xml:space="preserve"> \*<\/w:t>/);
  });

  test.each([
    ['struck text that ends in a space', { strikethrough: true }, 'b ', '[~~a~~\\\n<s>b </s>](https://e.com)'],
    ['underlined text', { underline: true }, 'b', '[a\\\n<u>b</u>](https://e.com)'],
  ])('keeps a line of a link that starts with %s in the link', async (_name, formatting, text, md) => {
    // Its tag at the line's start read as one of HTML, which starts a
    // block, so the link split before it, and its line break went outside
    const link = (text: string, fmt: Partial<RunFormatting>): ContentItem =>
      ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...fmt }, href: 'https://e.com' });
    const first = formatting.strikethrough ? formatting : {};
    const markdown = buildMarkdown([link('a', first), link('\\\n', {}), link(text, formatting)], new Map());
    expect(markdown.trim()).toBe(md);
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(1);
    expect(xml).toMatch(/<w:hyperlink [^>]*>(?:(?!<\/w:hyperlink>)[\s\S])*<w:br\/>(?:(?!<\/w:hyperlink>)[\s\S])*>b ?<\/w:t>/);
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
    // The highlight wraps both runs that have it, producing two ==...== regions,
    // with the space Word highlights in the first
    expect(result).toContain('==before ==');
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
          // Under an item at each level before it, as Markdown can't skip one
          const content = [
            ...Array.from({ length: level }, (_, parent) => [
              { type: 'para' as const, listMeta: { type: listType, level: parent } },
              { type: 'text' as const, text: 'parent', commentIds: new Set<string>(), formatting: DEFAULT_FORMATTING },
            ]).flat(),
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
    // Should produce two separate highlight spans: yellow, whose color keeps
    // their == apart, + colored cyan→turquoise
    expect(result).toBe('==yellow=={yellow}==cyan=={turquoise}');
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

describe('code run formatting', () => {
  // Formatting goes outside the backtick fence, where Markdown reads it,
  // and export writes it back onto the code
  test('code + bold puts the bold around the fence', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, bold: true }))
      .toBe('**`text`**');
  });

  test('code + highlight keeps the highlight around the fence', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, highlight: true }))
      .toBe('==`text`==');
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, highlight: true, highlightColor: 'red' }))
      .toBe('==`text`=={red}');
  });

  test('code + italic + strikethrough puts both around the fence', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, italic: true, strikethrough: true }))
      .toBe('*~~`text`~~*');
  });

  test('code + superscript puts the tag around the fence', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: true, superscript: true }))
      .toBe('<sup>`text`</sup>');
  });

  test('non-code bold still produces **text**', () => {
    expect(wrapWithFormatting('text', { ...DEFAULT_FORMATTING, code: false, bold: true }))
      .toBe('**text**');
  });

  test('code + all formatting flags puts them all around the fence', () => {
    const fmt: RunFormatting = {
      bold: true, italic: true, underline: true, strikethrough: true,
      highlight: true, superscript: true, subscript: true, code: true,
    };
    expect(wrapWithFormatting('text', fmt)).toBe('***~~<u>==<sup>`text`</sup>==</u>~~***');
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
    ['a no-break space that starts the paragraph before an address', '&nbsp;[a@b.com](mailto:a@b.com)', '&nbsp;[a\\@b.com](mailto:a@b.com)'],
    // A reference after it, as for whitespace that ends the paragraph,
    // which linkify reads a URL on into, as https://e.com/a&nbsp
    ['a no-break space that ends the paragraph after its path', '[https://e.com/a](https://e.com/a)&nbsp;', '[https\\://e.com/a](https://e.com/a)&nbsp;'],
    ['an ideographic space that ends the paragraph after its path', '[https://e.com/a](https://e.com/a)&#12288;', '[https\\://e.com/a](https://e.com/a)&#12288;'],
  ])('writes a link next to %s in link syntax', async (_name, md, expected) => {
    // Written bare, linkify read the link with the text next to it, or
    // didn't read it as a link
    expect(await roundTrip(md)).toBe(expected + '\n');
  });

  test('writes a link next to a space that ends a line in a grid table\'s cell in link syntax', async () => {
    // A grid cell's lines are trimmed, so the space before the line break
    // went as a reference, which linkify read the URL on into, as
    // https://e.com/a&#32
    const grid = (link: string) => {
      const line = '| ' + link + '&#32; |';
      const border = '+' + '-'.repeat(line.length - 2) + '+';
      const row = (text: string) => '| ' + text.padEnd(line.length - 4) + ' |';
      return [border, row('h'), border.replace(/-/g, '='), line, row('x'), border].join('\n');
    };
    const expected = grid('[https\\://e.com/a](https://e.com/a)');
    expect(await roundTrip(grid('[https://e.com/a](https://e.com/a)'))).toBe(expected + '\n');
    expect(await roundTrip(expected)).toBe(expected + '\n');
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
    // A reference that starts the paragraph before a URL with //, and one
    // after a host or an address, which ends its text
    '&nbsp;https://e.com', 'https://e.com&nbsp;', 'a@b.com&#12288;',
    // A break in the markup after it, which export read as part of the URL
    'https://e.com/a{~~\\\n~>x~~}', 'https://e.com/a{++x\\\ny++}',
  ])('keeps %s bare', async (md) => {
    expect((await roundTrip(md)).replace(/\{>>[^<]*<<\}/, '{>>c<<}')).toBe(md + '\n');
  });

  test.each([
    ['a URL', '$x$[https\\://e.com](https://e.com)'],
    ['an email address', '$x$[a\\@b.com](mailto:a@b.com)'],
  ])('keeps a link to its address after inline math a link, %s', async (_name, md) => {
    // Bare, its first letter kept the closing $ from closing the math
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<m:oMath>');
    expect(await roundTrip(md)).toBe(md + '\n');
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

  test.each([
    ['@', '[\\@x](https://e.com)'],
    ['-@', '[-\\@x](https://e.com)'],
    ['@ before a ;', '[\\@x; y](https://e.com)'],
    ['@ in a comment\'s range', '{==[\\@](https://e.com)==}{>>c<<}'],
    ['@ on a substitution\'s side', '{~~a~>[\\@x](https://e.com)~~}'],
  ])('keeps a link whose text starts with %s a link', async (_name, md) => {
    // Its [@ started a citation, which export reads before a link
    expect(await roundTrip(md)).toBe(md + '\n');
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

/** A Zotero field citing each item, as Zotero writes it: with the item's URI
 *  (when it has one), its ID, and its data. */
function zoteroFieldXml(items: Array<{ family: string; title: string; uri?: string; id?: number }>): string {
  return zoteroFieldOf(items.map((item, k) => ({
    id: item.id ?? k + 1,
    ...(item.uri ? { uris: [item.uri] } : {}),
    itemData: { id: item.id ?? k + 1, type: 'book', title: item.title, author: [{ family: item.family, given: 'J' }], issued: { 'date-parts': [['2020']] } },
  })));
}

/** A Zotero field with these citation items, as Zotero writes them */
function zoteroFieldOf(citationItems: object[]): string {
  const payload = JSON.stringify({ citationItems, properties: { plainCitation: '(x)' } });
  return '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    + '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + payload.replace(/&/g, '&amp;').replace(/</g, '&lt;') + ' </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + '<w:r><w:t>(x)</w:t></w:r>'
    + '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
}

/** The items of each Zotero field in a part of a .docx */
async function zoteroFieldItems(docx: Uint8Array, part: string): Promise<Array<Array<{ uris?: string[]; itemData: { title?: string; author?: Array<{ family?: string }> } }>>> {
  const xml = await (await JSZip.loadAsync(docx)).file(part)?.async('string') ?? '';
  return [...xml.matchAll(/ZOTERO_ITEM CSL_CITATION (.*?) ?<\/w:instrText>/g)].map(m =>
    JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).citationItems);
}

const noteXml = (kind: 'footnote' | 'endnote', content: string) =>
  wrapNotesXml(kind === 'footnote' ? 'footnotes' : 'endnotes', '<w:' + kind + ' w:id="1"><w:p><w:r><w:t xml:space="preserve">n </w:t></w:r>' + content + '</w:p></w:' + kind + '>');

describe('Zotero citations in notes', () => {
  const doe = { family: 'Doe', title: 'T', uri: 'http://zotero.org/users/1/items/AAAAAAA1' };
  const roe = { family: 'Roe', title: 'U', uri: 'http://zotero.org/users/1/items/AAAAAAA2' };
  const poe = { family: 'Poe', title: 'V', uri: 'http://zotero.org/users/1/items/AAAAAAA3' };

  test('gives an item only a note cites a .bib entry, and one an item the body cites too', async () => {
    const docx = await buildSyntheticDocx(wrapDocumentXml('<w:p><w:r><w:t xml:space="preserve">a </w:t></w:r>' + zoteroFieldXml([doe])
      + '<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>'), {
      'word/footnotes.xml': noteXml('footnote', zoteroFieldXml([doe]) + '<w:r><w:t xml:space="preserve"> </w:t></w:r>' + zoteroFieldXml([roe])),
      'word/endnotes.xml': noteXml('endnote', zoteroFieldXml([poe])),
    });
    const result = await convertDocx(docx);
    expect(result.markdown).toBe('a [@doe2020t][^1][^2]\n\n[^1]: n [@doe2020t] [@roe2020u]\n\n[^2]: n [@poe2020v]\n');
    const bib = parseBibtex(result.bibtex);
    expect([...bib.keys()]).toEqual(['doe2020t', 'roe2020u', 'poe2020v']);
    expect(bib.get('roe2020u')?.fields.get('zotero-uri')).toBe(roe.uri);
    expect(bib.get('poe2020v')?.fields.get('zotero-uri')).toBe(poe.uri);
  });

  test('gives items in footnotes and endnotes keys no other item has', async () => {
    const one = { family: 'Doe', title: 'Thing one', uri: 'http://zotero.org/users/1/items/AAAAAAA4' };
    const two = { family: 'Doe', title: 'Thing two', uri: 'http://zotero.org/users/1/items/AAAAAAA5' };
    const docx = await buildSyntheticDocx(wrapDocumentXml('<w:p><w:r><w:t xml:space="preserve">a </w:t></w:r>' + zoteroFieldXml([roe])
      + '<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>'), {
      'word/footnotes.xml': noteXml('footnote', zoteroFieldXml([one])),
      'word/endnotes.xml': noteXml('endnote', zoteroFieldXml([two])),
    });
    const result = await convertDocx(docx);
    expect(result.markdown).toBe('a [@roe2020u][^1][^2]\n\n[^1]: n [@doe2020thing]\n\n[^2]: n [@doe2020thing2]\n');
    expect([...parseBibtex(result.bibtex).keys()]).toEqual(['roe2020u', 'doe2020thing', 'doe2020thing2']);
    const numeric = await convertDocx(docx, 'numeric');
    expect(numeric.markdown).toBe('a [@1][^1][^2]\n\n[^1]: n [@2]\n\n[^2]: n [@3]\n');
    expect([...parseBibtex(numeric.bibtex).keys()]).toEqual(['1', '2', '3']);
  });

  test('adds an item a note cites in Word to the .bib export stored', async () => {
    const bibtex = '@book{doe2020t,\n  author = {Doe, J},\n  title = {{T}},\n  year = {2020},\n}\n';
    const exported = await JSZip.loadAsync((await convertMdToDocx('a [@doe2020t][^1]\n\n[^1]: NOTE\n', { bibtex })).docx);
    const footnotes = await exported.file('word/footnotes.xml')!.async('string');
    // A citation of another item, as Zotero inserts it into the note
    exported.file('word/footnotes.xml', footnotes.replace(/<w:t>NOTE<\/w:t><\/w:r>/, '<w:t xml:space="preserve">n </w:t></w:r>' + zoteroFieldXml([roe])));
    const result = await convertDocx(await exported.generateAsync({ type: 'uint8array' }));
    expect(result.markdown).toContain('[^1]: n [@roe2020u]\n');
    expect([...parseBibtex(result.bibtex).keys()]).toEqual(['doe2020t', 'roe2020u']);
    expect(result.bibtex.startsWith(bibtex)).toBe(true);
  });

  test.each([['a footnote', 'footnote'], ['an endnote', 'endnote']] as const)('keeps a Zotero field only %s has, with its item, from Word to Markdown to Word', async (_name, kind) => {
    const part = 'word/' + kind + 's.xml';
    const docx = await buildSyntheticDocx(wrapDocumentXml('<w:p><w:r><w:t>a</w:t></w:r><w:r><w:' + kind + 'Reference w:id="1"/></w:r></w:p>'), {
      [part]: noteXml(kind, zoteroFieldXml([roe])),
    });
    const first = await convertDocx(docx);
    expect(first.markdown).toContain('[^1]: n [@roe2020u]\n');
    expect([...parseBibtex(first.bibtex).keys()]).toEqual(['roe2020u']);

    const docx2 = (await convertMdToDocx(first.markdown, { bibtex: first.bibtex })).docx;
    const [[item]] = await zoteroFieldItems(docx2, part);
    expect(item.uris).toEqual([roe.uri]);
    expect(item.itemData.title).toBe('U');
    expect(item.itemData.author?.[0].family).toBe('Roe');

    // A second trip changes nothing
    const second = await convertDocx(docx2);
    expect(second.markdown).toContain('[^1]: n [@roe2020u]\n');
    expect(second.bibtex).toBe(first.bibtex);
    const docx3 = (await convertMdToDocx(second.markdown, { bibtex: second.bibtex })).docx;
    expect(await zoteroFieldItems(docx3, part)).toEqual(await zoteroFieldItems(docx2, part));
    const third = await convertDocx(docx3);
    expect(third.markdown).toBe(second.markdown);
    expect(third.bibtex).toBe(second.bibtex);
  });
});

describe('Zotero items with the same title and year', () => {
  const doe = { family: 'Doe', title: 'T', uri: 'http://zotero.org/users/1/items/AAAAAAA1', id: 1 };
  const roe = { family: 'Roe', title: 'T', uri: 'http://zotero.org/users/1/items/AAAAAAA2', id: 2 };
  const body = (fields: string[]) => wrapDocumentXml('<w:p><w:r><w:t xml:space="preserve">x </w:t></w:r>'
    + fields.join('<w:r><w:t xml:space="preserve"> and </w:t></w:r>') + '</w:p>');

  test('keys two items apart by their URIs, and one item cited twice once', async () => {
    const result = await convertDocx(await buildSyntheticDocx(body([zoteroFieldXml([doe]), zoteroFieldXml([roe]), zoteroFieldXml([doe])])));
    expect(result.markdown).toBe('x [@doe2020t] and [@roe2020t] and [@doe2020t]\n');
    const bib = parseBibtex(result.bibtex);
    expect([...bib.keys()]).toEqual(['doe2020t', 'roe2020t']);
    expect(bib.get('doe2020t')?.fields.get('zotero-uri')).toBe(doe.uri);
    expect(bib.get('roe2020t')?.fields.get('zotero-uri')).toBe(roe.uri);
  });

  test('keys two items apart by their IDs where the fields have no URIs', async () => {
    const [d, r] = [{ ...doe, uri: undefined }, { ...roe, uri: undefined }];
    const result = await convertDocx(await buildSyntheticDocx(body([zoteroFieldXml([d]), zoteroFieldXml([r]), zoteroFieldXml([d])])));
    expect(result.markdown).toBe('x [@doe2020t] and [@roe2020t] and [@doe2020t]\n');
    expect([...parseBibtex(result.bibtex).keys()]).toEqual(['doe2020t', 'roe2020t']);
  });

  test('keys two items apart by their authors without a URI, an ID or a DOI', () => {
    const meta = (family: string): ZoteroCitation['items'][number] => ({ authors: [{ family, given: 'J' }], title: 'T', year: '2020', journal: '', volume: '', pages: '', doi: '', type: 'book', fullItemData: {} });
    const citations: ZoteroCitation[] = [{ plainCitation: '', items: [meta('Doe')] }, { plainCitation: '', items: [meta('Roe')] }, { plainCitation: '', items: [meta('Doe')] }];
    const keyMap = buildCitationKeyMap(citations);
    expect(citations.map(c => citationPandocKeys(c, keyMap))).toEqual([['@doe2020t'], ['@roe2020t'], ['@doe2020t']]);
    expect([...parseBibtex(generateBibTeX(citations, keyMap)).keys()]).toEqual(['doe2020t', 'roe2020t']);
  });

  test('keeps each item\'s Zotero field, with its URI and data, from Word to Markdown to Word', async () => {
    const first = await convertDocx(await buildSyntheticDocx(body([zoteroFieldXml([doe]), zoteroFieldXml([roe])])));
    expect(first.markdown).toBe('x [@doe2020t] and [@roe2020t]\n');

    const docx2 = (await convertMdToDocx(first.markdown, { bibtex: first.bibtex })).docx;
    const items = (await zoteroFieldItems(docx2, 'word/document.xml')).map(([item]) => [item.uris?.[0], item.itemData.author?.[0].family, item.itemData.title]);
    expect(items).toEqual([[doe.uri, 'Doe', 'T'], [roe.uri, 'Roe', 'T']]);

    // A second trip changes nothing
    const second = await convertDocx(docx2);
    expect(second.markdown).toContain('x [@doe2020t] and [@roe2020t]\n');
    expect(second.bibtex).toBe(first.bibtex);
    const docx3 = (await convertMdToDocx(second.markdown, { bibtex: second.bibtex })).docx;
    expect(await zoteroFieldItems(docx3, 'word/document.xml')).toEqual(await zoteroFieldItems(docx2, 'word/document.xml'));
    const third = await convertDocx(docx3);
    expect(third.markdown).toBe(second.markdown);
    expect(third.bibtex).toBe(second.bibtex);
  });
});

describe('Zotero items cited in more than one field', () => {
  const body = (fields: string[]) => wrapDocumentXml('<w:p><w:r><w:t xml:space="preserve">x </w:t></w:r>'
    + fields.join('<w:r><w:t xml:space="preserve"> and </w:t></w:r>') + '</w:p>');
  const doeData = { type: 'book', title: 'T', author: [{ family: 'Doe', given: 'J' }], issued: { 'date-parts': [['2020']] }, DOI: '10.1/t' };
  const [old, synced, other] = ['http://zotero.org/users/local/abc/items/AAAAAAA1', 'http://zotero.org/users/1/items/AAAAAAA1', 'http://zotero.org/groups/2/items/AAAAAAA1'];

  test.each([
    ['its URI', { id: 1, uris: [synced] }, { id: 1, uris: [synced], itemData: { id: 1, ...doeData } }],
    ['its ID', { id: 7 }, { id: 7, itemData: { id: 7, ...doeData } }],
    ['its DOI', { itemData: { type: 'book', DOI: '10.1/t' } }, { itemData: doeData }],
  ])('takes an item\'s key and entry from the field with its data, where another field of it, by %s, has less', async (_name, sparse, full) => {
    const result = await convertDocx(await buildSyntheticDocx(body([zoteroFieldOf([sparse]), zoteroFieldOf([full])])));
    expect(result.markdown).toBe('x [@doe2020t] and [@doe2020t]\n');
    const bib = parseBibtex(result.bibtex);
    expect([...bib.keys()]).toEqual(['doe2020t']);
    expect(bib.get('doe2020t')?.fields.get('author')).toBe('Doe, J');
    expect(bib.get('doe2020t')?.fields.get('title')).toBe('T');
  });

  test('takes an item\'s key and entry from the field with its data, where a later field of it has more fields, empty', async () => {
    const empty = { id: 1, type: 'book', title: 'T', author: [], editor: [], translator: [], 'collection-editor': [], issued: {} };
    const fields = [zoteroFieldOf([{ id: 1, uris: [synced], itemData: { id: 1, ...doeData } }]), zoteroFieldOf([{ id: 1, uris: [synced], itemData: empty }])];
    const result = await convertDocx(await buildSyntheticDocx(body(fields)));
    expect(result.markdown).toBe('x [@doe2020t] and [@doe2020t]\n');
    const bib = parseBibtex(result.bibtex);
    expect([...bib.keys()]).toEqual(['doe2020t']);
    expect(bib.get('doe2020t')?.fields.get('author')).toBe('Doe, J');
    expect(bib.get('doe2020t')?.fields.get('year')).toBe('2020');
  });

  test.each([
    ['a URI in common', [[old, synced], [synced]]],
    ['URIs in common through a third field', [[old, synced], [other], [synced, other]]],
  ])('keys an item once whose fields list its URIs differently, with %s', async (_name, uriLists) => {
    const fields = uriLists.map(uris => zoteroFieldOf([{ id: 1, uris, itemData: { id: 1, ...doeData } }]));
    const first = await convertDocx(await buildSyntheticDocx(body(fields)));
    expect(first.markdown).toBe('x ' + uriLists.map(() => '[@doe2020t]').join(' and ') + '\n');
    const bib = parseBibtex(first.bibtex);
    expect([...bib.keys()]).toEqual(['doe2020t']);
    expect(bib.get('doe2020t')?.fields.get('zotero-uri')).toBe(old);

    // Export writes the item's URI in each field, and its text alike in each
    const docx2 = (await convertMdToDocx(first.markdown, { bibtex: first.bibtex })).docx;
    const items = await zoteroFieldItems(docx2, 'word/document.xml');
    expect(items.map(([item]) => item.uris)).toEqual(uriLists.map(() => [old]));
    const xml = await (await JSZip.loadAsync(docx2)).file('word/document.xml')!.async('string');
    expect(new Set([...xml.matchAll(/&quot;plainCitation&quot;:&quot;(.*?)&quot;/g)].map(m => m[1]))).toEqual(new Set(['(Doe, 2020)']));
    const second = await convertDocx(docx2);
    expect(second.markdown).toContain('x ' + uriLists.map(() => '[@doe2020t]').join(' and ') + '\n');
    expect(second.bibtex).toBe(first.bibtex);
  });

  test('keeps an item\'s data from Word to Markdown to Word where its first field has none', async () => {
    const first = await convertDocx(await buildSyntheticDocx(body([zoteroFieldOf([{ id: 1, uris: [synced] }]), zoteroFieldOf([{ id: 1, uris: [synced], itemData: { id: 1, ...doeData } }])])));
    const docx2 = (await convertMdToDocx(first.markdown, { bibtex: first.bibtex })).docx;
    const xml = await (await JSZip.loadAsync(docx2)).file('word/document.xml')!.async('string');
    expect([...xml.matchAll(/&quot;plainCitation&quot;:&quot;(.*?)&quot;/g)].map(m => m[1])).toEqual(['(Doe, 2020)', '(Doe, 2020)']);
    expect((await zoteroFieldItems(docx2, 'word/document.xml')).map(([item]) => item.itemData.author?.[0].family)).toEqual(['Doe', 'Doe']);
    // A second trip changes nothing
    const second = await convertDocx(docx2);
    expect(second.bibtex).toBe(first.bibtex);
    const docx3 = (await convertMdToDocx(second.markdown, { bibtex: second.bibtex })).docx;
    expect(await zoteroFieldItems(docx3, 'word/document.xml')).toEqual(await zoteroFieldItems(docx2, 'word/document.xml'));
    expect((await convertDocx(docx3)).markdown).toBe(second.markdown);
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

  const body = (id: number, text: string, who = 'A') => '{#' + id + '>>@' + who + ' (2024-01-15 10:30) | ' + text + '<<}';
  const overlapping = (first: number, text = 'A') => text + ' {#' + first + '}b {#' + (first + 1) + '}c{/' + first + '} d{/' + (first + 1) + '}.\n    '
    + body(first, 'one') + '\n    ' + body(first + 1, 'two', 'B') + '\n';
  const fence = '$' + '$';
  /** The Word parts of docx a note or a comment shows in */
  const wordParts = async (docx: Uint8Array) => {
    const zip = await JSZip.loadAsync(docx);
    return Promise.all(['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml']
      .map(async part => (await zip.file(part)?.async('string'))?.replace(/ w14:\w+="[^"]*"| w:rsid\w*="[^"]*"/g, '')));
  };

  test.each([
    ['a note\'s first paragraph', 'T.[^1]\n\n[^1]: ' + overlapping(1) + '\n    E.\n'],
    ['a note\'s second paragraph of three', 'T.[^1]\n\n[^1]: A.\n\n    ' + overlapping(1, 'B') + '\n    F.\n'],
    ['each of a note\'s paragraphs', 'T.[^1]\n\n[^1]: ' + overlapping(1) + '\n    ' + overlapping(3, 'E')],
    ['a comment over two of a note\'s paragraphs', 'T.[^1]\n\n[^1]: {#1}A.\n\n    B.{/1}\n    ' + body(1, 'c') + '\n\n    C.\n'],
    ['a comment with a reply', 'T.[^1]\n\n[^1]: A {#1}b {#2}c{/1} d{/2}.\n    ' + body(1, 'one') + '{>>@B (2024-01-15 11:30) | reply<<}\n    ' + body(2, 'two', 'B') + '\n\n    E.\n'],
    ['a paragraph before a code block', 'T.[^1]\n\n[^1]: ' + overlapping(1) + '\n    ```js\n    x\n    ```\n'],
    ['an equation', 'T.[^1]\n\n[^1]: A.\n\n    {#1}' + fence + '\n    x\n    ' + fence + '{/1}\n    ' + body(1, 'c') + '\n\n    B.\n'],
    ['an endnote\'s first paragraph', '---\nnotes: endnotes\n---\n\nT.[^1]\n\n[^1]: ' + overlapping(1) + '\n    E.\n'],
  ])('writes the bodies of comments in ID syntax in %s after their paragraph', async (_name, md) => {
    // They went at the note's end, after all its paragraphs, as the
    // document's go after their paragraph
    const { docx } = await convertMdToDocx(md);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(md);
    const again = (await convertMdToDocx(markdown)).docx;
    expect(await wordParts(again)).toEqual(await wordParts(docx));
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });
});

describe('A comment comments.xml has no body for', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
  const body = (text: string, who = 'A') => '{>>@' + who + ' (2024-01-15 10:30) | ' + text + '<<}';

  test.each([
    ['in the body', 'A {==b==}' + body('c') + ' d.', 'A b d.\n'],
    ['over a paragraph', '{==b==}' + body('c') + '\n\nNext.', 'b\n\nNext.\n'],
    ['in a table cell', '| h |\n| - |\n| A {==b==}' + body('c').replace('|', '\\|') + ' d. |', '| h |\n| --- |\n| A b d. |\n'],
    ['in a footnote', 'Text.[^1]\n\n[^1]: A {==note==}' + body('c') + ' here.', 'Text.[^1]\n\n[^1]: A note here.\n'],
    ['over a footnote\'s text', 'Text.[^1]\n\n[^1]: {==A.==}' + body('c'), 'Text.[^1]\n\n[^1]: A.\n'],
    ['in an endnote', '---\nnotes: endnotes\n---\n\nText.[^1]\n\n[^1]: A {==note==}' + body('c') + ' here.', 'Text.[^1]\n\n[^1]: A note here.\n'],
    ['over part of another\'s range', 'A {#1}b {#2}c{/1} d{/2}.\n{#1>>@A (2024-01-15 10:30) | one<<}\n{#2>>@B (2024-01-15 10:30) | two<<}',
      'A b {==c d==}' + body('two', 'B') + '.\n'],
    ['with a reply', 'A {==b==}' + body('c') + body('r', 'B') + ' d.', 'A {==b==}' + body('r', 'B') + ' d.\n'],
  ])('leaves out its range %s, which Word shows nothing of', async (_name, md, expected) => {
    // {==b==} with no comment after it is a highlight, which export writes as one
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/comments.xml')!.async('string');
    const edited = xml.replace(/<w:comment w:id="0".*?<\/w:comment>/, '');
    expect(edited).not.toBe(xml);
    zip.file('word/comments.xml', edited);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(expected);
    expect(strip((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown)).toBe(markdown);
  });

  test.each([
    ['the space after a note\'s mark', 'T.[^1]\n\n[^1]: {==A.==}' + body('c'), 'word/footnotes.xml',
      NOTE_SEPARATOR + '<w:commentRangeStart w:id="0"/>', '<w:commentRangeStart w:id="0"/>' + NOTE_SEPARATOR, 'T.[^1]\n\n[^1]: A.\n'],
    ['the space after an endnote\'s mark', '---\nnotes: endnotes\n---\n\nT.[^1]\n\n[^1]: {==A.==}' + body('c'), 'word/endnotes.xml',
      NOTE_SEPARATOR + '<w:commentRangeStart w:id="0"/>', '<w:commentRangeStart w:id="0"/>' + NOTE_SEPARATOR, 'T.[^1]\n\n[^1]: A.\n'],
    ['a paragraph of only spaces', 'A.\n\n{==XX==}' + body('c') + '\n\nB.', 'word/document.xml',
      '<w:t>XX</w:t>', '<w:t xml:space="preserve">   </w:t>', 'A.\n\nB.\n'],
    ['a note\'s paragraph of only spaces', 'T.[^1]\n\n[^1]: A.\n\n    {==XX==}' + body('c') + '\n\n    B.', 'word/footnotes.xml',
      '<w:t>XX</w:t>', '<w:t xml:space="preserve">   </w:t>', 'T.[^1]\n\n[^1]: A.\n\n    B.\n'],
  ])('reads %s in its range as it reads it without one', async (_name, md, part, from, to, expected) => {
    // The range was left out only after import had read the whitespace in
    // it as commented text, which kept the space after the mark, and a
    // paragraph of only spaces as one
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const comments = await zip.file('word/comments.xml')!.async('string');
    zip.file('word/comments.xml', comments.replace(/<w:comment w:id="0".*?<\/w:comment>/, ''));
    const xml = await zip.file(part)!.async('string');
    expect(xml).toContain(from);
    zip.file(part, xml.replace(from, to));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(expected);
    expect(strip((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown)).toBe(markdown);
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
    expect(markdown.split('\n')).toContain('See [@smith2020].[^1]');
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
    expect(markdown.split('\n')).toContain('A  b.[^1]');
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

describe('Line breaks a backslash can\'t hold', () => {
  const imported = async (xml: string) => (await convertDocx(await buildSyntheticDocx(wrapDocumentXml(xml)))).markdown
    .replace(/^---\n[\s\S]*?\n---\n?/, '');
  const exportedXml = async (md: string) => (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
  // Each paragraph's text, with a line break as ⏎
  const exportedText = async (md: string) => [...(await exportedXml(md)).matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
    .map(p => p[0].replace(/<w:br\/>/g, '⏎').replace(/<[^>]+>/g, '')).join(' | ');
  const p = (runs: string, style?: string) => '<w:p>' + (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : '') + runs + '</w:p>';
  const r = (inner: string, rPr = '') => '<w:r>' + rPr + inner + '</w:r>';
  const t = (text: string) => '<w:t xml:space="preserve">' + text + '</w:t>';
  const code = '<w:rPr><w:rStyle w:val="CodeChar"/></w:rPr>';

  test.each([
    ['ends a paragraph', p(r(t('a') + '<w:br/>')), 'a<br>\n', 'a⏎'],
    ['ends bold text that ends a paragraph', p(r(t('a') + '<w:br/>', '<w:rPr><w:b/></w:rPr>')), '**a**<br>\n', 'a⏎'],
    ['ends a paragraph after another', p(r(t('a') + '<w:br/><w:br/>')), 'a\\\n<br>\n', 'a⏎⏎'],
    ['is in a heading', p(r(t('a') + '<w:br/>' + t('b')), 'Heading1'), '# a<br>b\n', 'a⏎b'],
    ['ends a heading', p(r(t('a') + '<w:br/>'), 'Heading1'), '# a<br>\n', 'a⏎'],
    // Which markdown-it reads as an HTML block, not a paragraph's text
    ['is all of a paragraph', p(r('<w:br/>')), '<br>\n', '⏎'],
    // A code span can't hold one, so it goes between the code on each side
    ['ends inline code that ends a paragraph', p(r(t('a') + '<w:br/>', code)), '`a`<br>\n', 'a⏎'],
    ['is in inline code in a heading', p(r(t('a') + '<w:br/>' + t('b'), code), 'Heading1'), '# `a`<br>`b`\n', 'a⏎b'],
  ])('writes one that %s as <br>', async (_name, xml, md, text) => {
    // As a \ before a line end, it was a \ in the text at a paragraph's
    // end, and ended a heading, whose text after it was a paragraph
    expect(await imported(xml)).toBe(md);
    expect(await exportedText(md)).toBe(text);
  });

  test.each([
    ['a paragraph', p(r(t('a') + '<w:br/>' + t('  '))), 'a\\\n&#32;&#32;\n'],
    ['a heading', p(r(t('a') + '<w:br/>' + t('  ')), 'Heading1'), '# a<br>&#32;&#32;\n'],
  ])('keeps the spaces after one at the end of %s', async (_name, xml, md) => {
    // After a <br>, they were at the end, where Markdown drops them
    expect(await imported(xml)).toBe(md);
    expect(await exportedText(md)).toBe('a⏎  ');
  });

  // Each paragraph's runs' text, a hidden one's in [], with a line break as ⏎
  const texts = async (docx: Uint8Array) => [...(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string'))
    .matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(p => [...p[0].matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map(run => {
      const text = run[0].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '').replace(/<w:br\/>/g, '⏎').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '');
      return run[0].includes('<w:vanish/>') ? '[' + text + ']' : text;
    }).join(''));
  // A comment's hidden run, as export writes one, its line ends line breaks
  const comment = (text: string) => r(t('\u200B' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">'), '<w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr>');
  test.each([
    ['a space before one that ends a paragraph', 'XX', r(t(' ') + '<w:br/>'), '&#32;<br>'],
    ['spaces before one that ends a paragraph', 'XX', r(t('   ') + '<w:br/>'), '&#32;&#32;&#32;<br>'],
    ['a space and a comment before one that ends a paragraph', 'XX', r(t(' ')) + comment('<!-- c -->') + r('<w:br/>'), '&#32;<!-- c --><br>'],
    // Which only an HTML block holds
    ['a space and a comment with a blank line in it before one that ends a paragraph', 'XX', r(t(' ')) + comment('<!-- a\n\nb -->') + r('<w:br/>'), ' <!-- a\n\nb --><br>'],
    ['a space and a comment that ends in ---> before one that ends a paragraph', 'XX', r(t(' ')) + comment('<!-- a --->') + r('<w:br/>'), ' <!-- a ---><br>'],
    ['a space and a comment with a heading\'s line in it before one that ends a paragraph', 'XX', r(t(' ')) + comment('<!-- a\n# h -->') + r('<w:br/>'), ' <!-- a\n# h --><br>'],
    ['a space and a comment with a blank line in it before one that ends a quote\'s paragraph', '> XX', r(t(' ')) + comment('<!-- a\n\nb -->') + r('<w:br/>'), '>  <!-- a\n>\n> b --><br>'],
    // Two columns past the quote's > and space, which a tab at the margin
    // would be four of
    ['a tab and a comment with a blank line in it before one that ends a quote\'s paragraph', '> XX', r('<w:tab/>') + comment('<!-- a\n\nb -->') + r('<w:br/>'), '> \t<!-- a\n>\n> b --><br>'],
    ['a space, a tab and a comment with a blank line in it before one that ends a quote\'s paragraph', '> XX', r(t(' ') + '<w:tab/>') + comment('<!-- a\n\nb -->') + r('<w:br/>'), '>  \t<!-- a\n>\n> b --><br>'],
    // Which a paragraph reads, as it does the text after it, which the
    // comment's block would read as text with it
    ['a space, a comment and text before one that ends a paragraph', 'XX', r(t(' ')) + comment('<!-- c -->') + r(t('a') + '<w:br/>'), '&#32;<!-- c -->a<br>'],
    ['a space before a comment and text', 'XX', r(t(' ')) + comment('<!-- c -->') + r(t('a')), '&#32;<!-- c -->a'],
    ['a space before a comment and code that looks like one', 'XX', r(t(' ')) + comment('<!-- c -->') + r(t('&lt;!-- d --&gt;'), code), '&#32;<!-- c -->`<!-- d -->`'],
    ['a space before a comment, a \\ and a comment', 'XX', r(t(' ')) + comment('<!-- c -->') + r(t('\\')) + comment('<!-- d -->'), '&#32;<!-- c -->\\\\<!-- d -->'],
    ['a tab, a comment and text before one that ends a quote\'s paragraph', '> XX', r('<w:tab/>') + comment('<!-- c -->') + r(t('a') + '<w:br/>'), '> &#9;<!-- c -->a<br>'],
    ['a space, a comment and text before one that ends an item\'s paragraph after its first', '- a\n\n  XX', r(t(' ')) + comment('<!-- c -->') + r(t('a') + '<w:br/>'), '- a\n\n  &#32;<!-- c -->a<br>'],
    // Which a paragraph reads with the next as one, and the space between
    ['a space, a comment that ends in --->, a space and a comment before one that ends a paragraph', 'XX', r(t(' ')) + comment('<!-- a --->') + r(t(' ')) + comment('<!-- c -->') + r('<w:br/>'), ' <!-- a ---> <!-- c --><br>'],
    ['a space and a comment that ends in ---> and another before one that ends a paragraph', 'XX', r(t(' ')) + comment('<!-- a --->') + comment('<!-- c -->') + r('<w:br/>'), ' <!-- a ---><!-- c --><br>'],
    // Which a paragraph reads apart, as the block doesn't
    ['a space, an empty comment, a space and a comment before one that ends a paragraph', 'XX', r(t(' ')) + comment('<!-->') + r(t(' ')) + comment('<!-- c -->') + r('<w:br/>'), '&#32;<!--> <!-- c --><br>'],
    // After a comment, whose block they were text in
    ['a comment and a space before one that ends a paragraph', 'XX', comment('<!-- c -->') + r(t(' ') + '<w:br/>'), '<!-- c --> <br>'],
    ['a comment and a tab before one that ends a paragraph', 'XX', comment('<!-- c -->') + r('<w:tab/><w:br/>'), '<!-- c -->\t<br>'],
    ['a space between comments before one that ends a paragraph', 'XX', comment('<!-- c -->') + r(t(' ')) + comment('<!-- d -->') + r('<w:br/>'), '<!-- c --> <!-- d --><br>'],
    // Where a \ and line end before the last were text in the comments' block
    ['a comment before two that end a paragraph', 'XX', comment('<!-- c -->') + r('<w:br/><w:br/>'), '<!-- c --><br><br>'],
    ['a comment and a space before two that end a paragraph', 'XX', comment('<!-- c -->') + r(t(' ') + '<w:br/><w:br/>'), '<!-- c --> <br><br>'],
    ['a comment and a tab before three that end a paragraph', 'XX', comment('<!-- c -->') + r('<w:tab/><w:br/><w:br/><w:br/>'), '<!-- c -->\t<br><br><br>'],
    ['a space between comments before two that end a paragraph', 'XX', comment('<!-- c -->') + r(t(' ')) + comment('<!-- d -->') + r('<w:br/><w:br/>'), '<!-- c --> <!-- d --><br><br>'],
    ['a space between two that end a paragraph after a comment', 'XX', comment('<!-- c -->') + r('<w:br/>' + t(' ') + '<w:br/>'), '<!-- c --><br> <br>'],
    ['a space, a comment and a space before two that end a paragraph', 'XX', r(t(' ')) + comment('<!-- c -->') + r(t(' ') + '<w:br/><w:br/>'), '&#32;<!-- c --> <br><br>'],
    ['a comment before two that end a quote\'s paragraph', '> XX', comment('<!-- c -->') + r('<w:br/><w:br/>'), '> <!-- c --><br><br>'],
    ['a space before one that ends a quote\'s paragraph', '> XX', r(t(' ') + '<w:br/>'), '> &#32;<br>'],
    ['a space before one that ends an item\'s paragraph after its first', '- a\n\n  XX', r(t(' ') + '<w:br/>'), '- a\n\n  &#32;<br>'],
    ['a tab before one that ends a paragraph', 'XX', r('<w:tab/><w:br/>'), '&#9;<br>'],
    ['a space before one with text after', 'XX', r(t(' ') + '<w:br/>' + t('b')), '&#32;\\\nb'],
    ['spaces between two', 'XX', r(t('a') + '<w:br/>' + t('  ') + '<w:br/>'), 'a\\\n&#32;&#32;<br>'],
    ['a space before one that ends a list item', '- XX', r(t(' ') + '<w:br/>'), '- &#32;<br>'],
    ['a space before one that ends a heading', '# XX', r(t(' ') + '<w:br/>'), '# &#32;<br>'],
    ['a space before one that ends a table\'s cell', '| a |\n| --- |\n| XX |', r(t(' ') + '<w:br/>'), '| a |\n| --- |\n| &#32;<br> |'],
  ])('keeps %s', async (_name, source, runs, md) => {
    // Raw before a <br>, alone or after comments, the spaces were an HTML
    // block's indent, which export dropped, and as references before a
    // comment only the block holds, the comment was text
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\n' + source + '\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>)[\s\S])*?>XX<\/w:t><\/w:r>/, runs);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const docx = await zip.generateAsync({ type: 'uint8array' });
    const md1 = (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md1).toBe('A.\n\n' + md + '\n\nB.\n');
    const exported = (await convertMdToDocx(md1)).docx;
    expect(await texts(exported)).toEqual(await texts(docx));
    expect((await convertDocx(exported)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md1);
  });

  test.each([
    '<!-- c --><br><br>',
    '<!-- c --> <br><br>',
    '<!-- c -->\t<br><br>',
    '<!-- c --> <!-- d --> <br><br>',
    '<!-- c --><br> <br>',
    '> <!-- c --> <br><br>',
  ])('keeps them in %s, after comments', async (md) => {
    // Import wrote the first as a \ and a line end, the comments' block's text
    const source = 'A.\n\n' + md + '\n\nB.\n';
    const docx = (await convertMdToDocx(source)).docx;
    const md1 = (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md1).toBe(source);
    expect(await texts((await convertMdToDocx(md1)).docx)).toEqual(await texts(docx));
  });

  test.each([
    '> \t<!-- a\n>\n> b --><br>',
    '>  \t<!-- a\n>\n> b --><br>',
  ])('keeps a tab before a comment only an HTML block holds in %s', async (md) => {
    // Import wrote it as a reference, &#9;, which made a paragraph, which
    // read the comment as text
    const source = 'A.\n\n' + md + '\n\nB.\n';
    const docx = (await convertMdToDocx(source)).docx;
    const md1 = (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md1).toBe(source);
    expect(await texts((await convertMdToDocx(md1)).docx)).toEqual(await texts(docx));
  });

  test.each([
    '> &#9;<!-- c -->a<br>',
    '&#32;<!-- c -->a<br>',
  ])('keeps the reference before a comment and text in %s', async (md) => {
    // Import wrote it raw, which made an HTML block, whose text the
    // comment and <br> were
    const source = 'A.\n\n' + md + '\n\nB.\n';
    const docx = (await convertMdToDocx(source)).docx;
    const md1 = (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md1).toBe(source);
    expect(await texts((await convertMdToDocx(md1)).docx)).toEqual(await texts(docx));
  });

  // The rest of a comment's hidden run, which Word split from it, with no ZWSP
  const rest = (text: string) => r(t(text.replace(/</g, '&lt;').replace(/>/g, '&gt;')), '<w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr>');
  test.each([
    ['a space before a run of two comments', 'XX', r(t(' ')) + comment('<!-- a --><!-- b -->'), '&#32;<!-- a --><!-- b -->'],
    ['a tab before a run of two comments in a quote', '> XX', r('<w:tab/>') + comment('<!-- a --><!-- b -->'), '> &#9;<!-- a --><!-- b -->'],
    ['a tab before a run of two comments and text in an item\'s paragraph after its first', '- a\n\n  XX', r('<w:tab/>') + comment('<!-- a --><!-- b -->') + r(t('z')), '- a\n\n  &#9;<!-- a --><!-- b -->z'],
    // Which a paragraph reads as one comment, with the space in the run
    ['a tab before a comment that ends in ---> and the run Word split from it in a quote', '> XX', r('<w:tab/>') + comment('<!-- a --->') + rest(' <!-- c -->'), '> &#9;<!-- a ---> <!-- c -->'],
    ['a space before a run of two comments Word split in the second', 'XX', r(t(' ')) + comment('<!-- a --><!-- b') + rest(' -->'), '&#32;<!-- a --><!-- b -->'],
  ])('keeps %s out of the hidden run', async (_name, source, runs, md) => {
    // Raw, as an HTML block's indent, it went into the run, where export
    // puts one, as import read a run of more than one comment as other
    // than the comments a paragraph reads in it
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\n' + source + '\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>)[\s\S])*?>XX<\/w:t><\/w:r>/, runs);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const docx = await zip.generateAsync({ type: 'uint8array' });
    const md1 = (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md1).toBe('A.\n\n' + md + '\n\nB.\n');
    // With each comment in a run of its own, after a ZWSP, as export writes one
    const merged = async (docx: Uint8Array) => (await texts(docx)).map(text => text.replace(/\]\[/g, '').replace(/\u200B/g, ''));
    const exported = (await convertMdToDocx(md1)).docx;
    expect(await merged(exported)).toEqual(await merged(docx));
    expect((await convertDocx(exported)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md1);
  });

  test.each([
    ['a paragraph', 'XX', comment(' <!-- a -->XYZ<!-- b -->') + r(t(' ')) + comment('<!-- c -->'), ' <!-- a -->XYZ<!-- b --> <!-- c -->'],
    ['a quote\'s paragraph', '> XX', r('<w:tab/>') + comment('<!-- a -->XYZ<!-- b -->'), '> \t<!-- a -->XYZ<!-- b -->'],
    ['an item\'s paragraph after its first', '- a\n\n  XX', r(t(' ')) + comment('<!-- a -->XYZ<!-- b -->'), '- a\n\n   <!-- a -->XYZ<!-- b -->'],
  ])('keeps text outside the comments in a hidden run hidden in %s', async (_name, source, runs, md) => {
    // With references before the comments, a paragraph read them, and
    // showed the text between them
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\n' + source + '\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>)[\s\S])*?>XX<\/w:t><\/w:r>/, runs);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const md1 = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md1).toBe('A.\n\n' + md + '\n\nB.\n');
    const exported = (await convertMdToDocx(md1)).docx;
    const paragraphs = await texts(exported);
    expect(paragraphs.some(text => /\[[^\]]*XYZ[^\]]*\]/.test(text))).toBe(true);
    expect(paragraphs.some(text => text.replace(/\[[^\]]*\]/g, '').includes('XYZ'))).toBe(false);
    const md2 = (await convertDocx(exported)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md2).toBe(md1);
    expect(await texts((await convertMdToDocx(md2)).docx)).toEqual(paragraphs);
  });

  test('keeps a tab before a hidden run of comments with only a space between them out of the run', async () => {
    // A paragraph shows the space, where the block would hide the tab
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\n> XX\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>)[\s\S])*?>XX<\/w:t><\/w:r>/, r('<w:tab/>') + comment('<!-- a --> <!-- b -->'));
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const md1 = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md1).toBe('A.\n\n> &#9;<!-- a --> <!-- b -->\n\nB.\n');
    expect((await convertDocx((await convertMdToDocx(md1)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md1);
  });

  test.each([
    ['a landscape section', '<!-- landscape -->\n\nXX\n\n<!-- /landscape -->', '<!-- landscape -->\n\n&#9;<!-- a -->\n\n<!-- /landscape -->'],
    ['a landscape section with no blank lines in it', '<!-- landscape -->\nXX\n<!-- /landscape -->', '<!-- landscape -->\n&#9;<!-- a -->\n<!-- /landscape -->'],
    ['a portrait section', '<!-- portrait -->\n\nXX\n\n<!-- /portrait -->', '<!-- portrait -->\n\n&#9;<!-- a -->\n\n<!-- /portrait -->'],
  ])('counts the columns of a tab in the hidden run of a comment that starts %s that starts the document from the margin', async (_name, source, md) => {
    // From the end of the fence, as the line end after it, which a para item
    // writes for others, came after, so as two, raw, which made the comment
    // code
    const zip = await JSZip.loadAsync((await convertMdToDocx(source + '\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>)[\s\S])*?>XX<\/w:t><\/w:r>/,
      r(t('\u200B') + '<w:tab/>' + t('&lt;!-- a --&gt;'), '<w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr>'));
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const md1 = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md1).toBe(md + '\n\nB.\n');
    const exported = (await convertMdToDocx(md1)).docx;
    expect(await texts(exported)).toContain('\t[\u200B&lt;!-- a --&gt;]');
    expect((await convertDocx(exported)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md1);
  });

  test('keeps one in inline code between the code on each side', async () => {
    // Inside the code span, the \ was code, and the line end a space
    const md = await imported(p(r(t('a') + '<w:br/>' + t('b'), code)));
    expect(md).toBe('`a`\\\n`b`\n');
    expect(await exportedText(md)).toBe('a⏎b');
  });

  test('reads <br> tags on lines of their own in one block as line breaks', async () => {
    // markdown-it reads them as one HTML block, which was text
    expect(await exportedText('<br>\n<br/>\n\nX')).toBe('⏎⏎ | X');
  });

  test.each([
    ['a paragraph', '{#1}a {#2}b{/1} c{/2}\n{#1>>@A | x<<}\n{#2>>@A | y<<}\n', 'word/document.xml'],
    ['a heading', '# {#1}a {#2}b{/1} c{/2}\n{#1>>@A | x<<}\n{#2>>@A | y<<}\n', 'word/document.xml'],
    ['a quote\'s paragraph', '> {#1}a {#2}b{/1} c{/2}\n> {#1>>@A | x<<}\n> {#2>>@A | y<<}\n', 'word/document.xml'],
    ['a note\'s paragraph', 'T[^1]\n\n[^1]: {#1}a {#2}b{/1} c{/2}\n    {#1>>@A | x<<}\n    {#2>>@A | y<<}\n', 'word/footnotes.xml'],
    ['a note\'s paragraph before another', 'T[^1]\n\n[^1]: {#1}a {#2}b{/1} c{/2}\n    {#1>>@A | x<<}\n    {#2>>@A | y<<}\n\n    d\n', 'word/footnotes.xml'],
  ])('keeps one that ends %s with comments\' bodies after it', async (_name, md, part) => {
    // The bodies' line end took it, as where an older export wrote one
    // there, but so did one in Word, which is <br> where they don't go after
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file(part)!.async('string');
    const end = xml.indexOf('</w:p>', xml.indexOf('>a <'));
    zip.file(part, xml.slice(0, end) + '<w:r><w:br/></w:r>' + xml.slice(end));
    const expected = md.replace('c{/2}', 'c{/2}<br>');
    const imported = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(imported).toBe(expected);
    expect((await convertDocx((await convertMdToDocx(imported)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(expected);
  });

  test('keeps one after a \\ in a comment on a heading a \\ and a line end', async () => {
    // As <br> in the comment's body, it was text there
    const zip = await JSZip.loadAsync((await convertMdToDocx('# H {==x==}{>>a b<<} end')).docx);
    const xml = await zip.file('word/comments.xml')!.async('string');
    const edited = xml.replace('a b', 'a\\</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>b');
    expect(edited).not.toBe(xml);
    zip.file('word/comments.xml', edited);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md).toBe('# H {==x==}{>>a\\\nb<<} end\n');
    const comments = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/comments.xml')!.async('string');
    const body = comments.slice(comments.indexOf('<w:comment '), comments.indexOf('</w:comment>'));
    expect(body.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '')).toBe('a\\\nb');
  });

  test.each([
    ['all of', 'A\n\n<!-- c -->\n\nB', 'A\n\n<!-- c --><br>\n\nB\n'],
    ['after text in', 'A\n\nx <!-- c -->\n\nB', 'A\n\nx <!-- c --><br>\n\nB\n'],
  ])('keeps one after a comment that is %s a paragraph', async (_name, source, md) => {
    // markdown-it read the comment and the <br> as one block, which was text
    const zip = await JSZip.loadAsync((await convertMdToDocx(source)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const end = xml.indexOf('</w:p>', xml.indexOf('c --'));
    zip.file('word/document.xml', xml.slice(0, end) + '<w:r><w:br/></w:r>' + xml.slice(end));
    const imported = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(imported).toBe(md);
    const exported = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    expect(exported).not.toContain('&lt;br');
    expect(exported).toContain('<w:br/>');
    expect(exported).toContain('<w:vanish/>');
  });

  test('reads a list item that is only a <br> as a line break', async () => {
    // markdown-it reads the <br> as an HTML block, which an item keeps
    expect(await exportedText('- <br>\n- b')).toBe('⏎ | b');
    const md = '- <br>\n- b\n';
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md);
  });

  test.each([
    ['its first', 'T.[^1]\n\n[^1]: a **XX**', 'T.[^1]\n\n[^1]: a <br>\n'],
    ['a later one', 'T.[^1]\n\n[^1]: a\n\n    b **XX**', 'T.[^1]\n\n[^1]: a\n\n    b <br>\n'],
    ['all of one', 'T.[^1]\n\n[^1]: **XX**', 'T.[^1]\n\n[^1]: <br>\n'],
  ])('writes one that ends a note\'s paragraph, %s, as <br>', async (_name, source, md) => {
    // A note's text was rendered apart from the document's, with its
    // break as a \ before a line end, which export read as a \
    const zip = await JSZip.loadAsync((await convertMdToDocx(source)).docx);
    const xml = await zip.file('word/footnotes.xml')!.async('string');
    const edited = xml.replace(/<w:r><w:rPr>(?:(?!<\/w:r>).)*<\/w:rPr><w:t>XX<\/w:t><\/w:r>/, '<w:r><w:br/></w:r>');
    expect(edited).not.toBe(xml);
    zip.file('word/footnotes.xml', edited);
    const imported = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(imported).toBe(md);
    const notes = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/footnotes.xml')!.async('string');
    expect(notes).toContain('<w:br/>');
    expect(notes).not.toContain('&lt;br');
  });

  test('escapes a <br> tag in Word\'s text, which export reads as a line break', async () => {
    const md = await imported(p(r(t('a&lt;br&gt;b&lt;br/&gt;c&lt;BR /&gt;'))));
    expect(md).toBe('a&lt;br&gt;b&lt;br/&gt;c&lt;BR /&gt;\n');
    expect(await exportedText(md)).toBe('a&lt;br&gt;b&lt;br/&gt;c&lt;BR /&gt;');
    expect(await exportedText('a<br>b<br/>c<BR >d')).toBe('a⏎b⏎c⏎d');
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
  /** The Markdown for Word's text `text` in a paragraph, and the whole, in
   *  a document whose next paragraph cites `cited`, whose keys export notes
   *  as missing at its end, so import knows them (see knownCitationKeys) */
  const importCited = async (text: string, cited = text) => {
    const markdown = await importText('A.\n\nP XX Q.\n\nB ' + cited + '.', text);
    return { line: markdown.split('\n\n')[1], markdown };
  };
  /** The text of each paragraph of md's export, and whether any is more than text */
  const exported = async (md: string, part = 'word/document.xml') => {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file(part)!.async('string');
    // Less the space export puts after a note's mark, as Word does
    const body = part === 'word/document.xml' ? xml.slice(xml.indexOf('<w:body>'), xml.indexOf('<w:sectPr'))
      : xml.replace(/(<w:(?:footnote|endnote)Ref\/><\/w:r>)<w:r><w:t xml:space="preserve"> <\/w:t><\/w:r>/g, '$1');
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
    // Export runs a prefix's spaces together, and keeps one locator and one
    // - for each key
    '[@a; see  also @b]', '[@a, p. 1; @a, p. 2]', '[-@a; @a]', '[@a; see  also @b](b)',
    // One before a ( in brackets, whose ] closed the outer [ as a link's
    '[[@a,p. 2](https://e.com)]',
    // One after a !, which makes it an image
    '![@a](b)', '![@a][b]',
    // An autolink past the 256 characters the check read, or with a
    // no-break space, which markdown-it allows in one
    '<urn:' + 'x'.repeat(300) + '>', '<ab:c\u00a0d>',
    // An email address linkify finds, past a narrower pattern's
    'foo$@example.com', 'user@bücher.de',
    // A URL or email address that the escape of what follows it ends, where
    // linkify found none before it was escaped
    'http://e.com_', 'a@b.co_',
    // A URL after text with no space, which markdown-it's own linkify rule
    // links where linkify's search doesn't, as after an escape of a letter
    'a_https://e.com', '\u00e9https://e.com', '$https://e.com', '`https://e.com', 'x\\hhttps://e.com', 'x\\\\hhttps://e.com',
    // One whose user, long as it is, comes before its host
    'a_https://' + 'u'.repeat(600) + '@example.com/a',
    // A URL before a tag, raw or written as references, which ends the
    // text linkify reads, where linkify found none in the text with it
    'https://e.com1.<span>', 'https://e.com.<b>x</b>', 'a@b.co.<span>',
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
    ['a $ before it', 'a\\$$x$ b'],
    ['a $ before it after a backslash', 'a\\\\\\$$x$ b'],
    ['two $ before it', 'a\\$\\$$x$ b'],
    ['a $ before it on a substitution\'s side', '{~~old~>a\\$$x$~~}'],
  ])('keeps inline math next to %s as math', async (_name, md) => {
    // Import wrote the character bare, by which the $ next to it opened or
    // closed no math, and the equation came back as text, or a $ before
    // it, which ran into its own as $$
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<m:oMath>');
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test.each([
    ['after it', '$z$&#120;\\$a$'],
    ['after it, with more after', '$z$&#49;\\$a$ b \\$c$'],
    ['before it', '\\$a$&#120;$z$'],
    ['before it, after one that can close at it', '\\$a \\$b$&#120;$z$'],
    ['before an equation that starts with a backslash', 'a \\$b$&#120;$\\alpha$'],
    ['on a substitution\'s side', 'q{~~y~>$z$&#120;\\$a$~~}'],
  ])('keeps a $ next to the letter or digit beside inline math as text, %s', async (_name, md) => {
    // The letter or digit, which kept the $ from opening or closing math, went
    // as a reference, after or before whose ; it did
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    expect((await zip.file('word/document.xml')!.async('string')).match(/<m:oMath>/g)).toHaveLength(1);
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
    ['emphasis', '', '*a* b', ''],
    ['inline math', '', '$a$ b', ''],
    ['a link', '', '[x](https://e.com) b', ''],
    ['a highlight', '', '==a== b', ''],
    ['a code span', '', '`a` b', ''],
    ['a list item\'s marker', '', '- a', ''],
    ['inline math with a $ before it', 'q $', '$a$', ' w'],
    ['the end of an HTML tag before it', 'q <span title="', '*a*">', 'x</span>'],
    ['the end of a URL before a tag', 'https://e.com', '1.', '<span>'],
  ])('keeps the text of a citation without keys that reads as %s as text', async (_name, before, text, after) => {
    // The citation's text went as it was, as Markdown, which the runs
    // beside it didn't read
    const run = (value: string): ContentItem => ({ type: 'text', text: value, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
    const md = buildMarkdown([
      ...(before ? [run(before)] : []),
      { type: 'citation', text, commentIds: new Set(), pandocKeys: [] },
      ...(after ? [run(after)] : []),
    ], new Map());
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    expect([...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]).join(''))
      .toBe((before + text + after).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    expect(xml).not.toMatch(/<m:oMath>|<w:hyperlink|<w:i\/>|<w:highlight|<w:numPr>|<w:rStyle/);
  });

  test('keeps the text of a citation without keys in an HTML table\'s cell that holds what HTML can\'t as its text', async () => {
    // Export reads the cell as HTML, where the citation's escapes were text
    const run = (value: string): ContentItem => ({ type: 'text', text: value, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
    const md = buildMarkdown([{
      type: 'table',
      rows: [
        { isHeader: false, cells: [{ paragraphs: [[{ type: 'citation', text: '*a* <b>', commentIds: new Set(), pandocKeys: [] }, run(' '), { type: 'math', latex: 'y', display: false, commentIds: new Set() }]], colspan: 2 }] },
        { isHeader: false, cells: [{ paragraphs: [[run('b')]] }, { paragraphs: [[run('c')]] }] },
      ],
    } as ContentItem], new Map());
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    expect(xml.slice(xml.indexOf('<w:tc>'), xml.indexOf('</w:tc>')).replace(/<[^>]+>/g, '')).toBe('*a* &lt;b&gt; $y$');
  });

  test.each([
    ['after it', 'mc', [], false, 'q $z$&#49; w'],
    ['before it', 'cm', [], false, 'q &#49;$z$ w'],
    ['after it in a comment\'s range', 'mc', ['c1'], false, 'q {==$z$&#49;==}{>>@R | note<<} w'],
    ['before it in a comment\'s range in ID syntax', 'cm', ['c1'], true, 'q {#1}&#49;$z${/1} w\n{#1>>@R | note<<}'],
    ['after it in a highlight', 'hmc', [], false, 'q ==&#97;$z$&#49;== w'],
    ['after it on a substitution\'s side', 'dmc', [], false, 'q {~~old~>$z$&#49;~~} w'],
  ])('keeps inline math next to a citation without keys whose text is a digit, %s, as math', async (_name, kinds, ids, alwaysUseCommentIds, expected) => {
    // The citation's text went as it was, as a digit by which the $ next to
    // it opened or closed no math, and the equation came back as text
    const highlighted = (kinds as string).startsWith('h') ? { ...DEFAULT_FORMATTING, highlight: true } : DEFAULT_FORMATTING;
    const deleted: RevisionInfo = { type: 'deletion', author: 'A', date: '' };
    const revision: RevisionInfo | undefined = (kinds as string).startsWith('d') ? { ...deleted, type: 'addition' } : undefined;
    const commentIds = () => new Set(ids as string[]);
    const items = [...(kinds as string)].map((kind): ContentItem => {
      if (kind === 'h') return { type: 'text', text: 'a', commentIds: commentIds(), formatting: highlighted };
      if (kind === 'd') return { type: 'text', text: 'old', commentIds: commentIds(), formatting: DEFAULT_FORMATTING, revision: deleted };
      if (kind === 'm') return { type: 'math', latex: 'z', display: false, commentIds: commentIds(), revision };
      return { type: 'citation', text: '1', commentIds: commentIds(), pandocKeys: [], formatting: highlighted, revision };
    });
    const content: ContentItem[] = [
      { type: 'text', text: 'q ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      ...items,
      { type: 'text', text: ' w', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
    ];
    const comments = new Map([['c1', { author: 'R', text: 'note', date: '' } as any]]);
    const md = buildMarkdown(content, comments, { alwaysUseCommentIds: alwaysUseCommentIds as boolean });
    expect(md.trim()).toBe(expected);
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<m:oMath>/g)).toHaveLength(1);
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
    '1.5 times', '50% off', '~a~',
  ])('writes %s as it is', async (text) => {
    expect(await importText('A.\n\nP XX Q.\n\nB.', text)).toBe('A.\n\nP ' + text + ' Q.\n\nB.\n');
  });

  test.each([
    'e.g. [@key]',
    // A citation's locator, which export writes as it is
    '[@missing, _p_]', '[-@smith, p. 2; see @jones]',
    // A citation through a [, which export reads to the ], $x$ and all; a
    // backslash would go into its key, and another each round trip
    '[@[$x$]', '[@a[$x$] b',
  ])('writes %s, as export writes a citation whose key is missing, as it is', async (text) => {
    const { line, markdown } = await importCited(text);
    expect(line).toBe('P ' + text + ' Q.');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['[@key]', '\\[@key]'], ['e.g. [@key]', 'e.g. \\[@key]'], ['[see @a, p. 2; @b]', '\\[see @a, p. 2; @b]'], ['[@key](b)', '\\[@key](b)'],
  ])('escapes %s, Word\'s text of a key export doesn\'t know', async (text, md) => {
    // Export took it for a citation whose key is missing, and added a
    // paragraph that noted it
    const markdown = await importText('A.\n\nP XX Q.\n\nB.', text);
    expect(markdown).toBe('A.\n\nP ' + md + ' Q.\n\nB.\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each(['a {--[@zz]--} b', 'a {~~[@zz]~>b~~} c', 'a {~~[see @zz, p. 2]~>b~~} c'])('keeps %s, whose deleted citation export notes no missing key of, as it is', async (md) => {
    // Export writes a deleted citation as its text, and notes no missing
    // data of its key, so only the deletion says it's a citation's
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test.each([
    ['split across its runs', ['[@smith', '2020]'], '{--[@smith2020]--}'],
    ['with a [ in its key', ['[@a[b]'], '{--[@a[b]--}'],
    ['after a [ of text', ['[x [see @a]'], '{--[x [see @a]--}'],
  ])('keeps a deleted citation %s a citation', (_name, texts, md) => {
    // Its keys were read from each run alone, and to a [ in a key
    const revision = { type: 'deletion' as const, author: 'A', date: '' };
    const items: ContentItem[] = texts.map(text => ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision }));
    expect(buildMarkdown(items, new Map()).trim()).toBe(md);
  });

  test('escapes a citation in Word\'s text of one export doesn\'t know, though it knows the inner one\'s key', async () => {
    // Its [ was escaped, so export read the inner one as a citation
    const { line, markdown } = await importCited('[@a[@b]', '[@b]');
    expect(line).toBe('P \\[@a\\[@b] Q.');
    expect((await exported(markdown)).text[1]).toBe('P [@a[@b] Q.');
  });

  test('escapes Word\'s text of many citations one inside another in linear time', () => {
    // Each [ of one export doesn't know read the text to its ] again
    const time = (n: number) => {
      const start = performance.now();
      buildMarkdown([{ type: 'text', text: '[@a'.repeat(n) + ']', commentIds: new Set(), formatting: DEFAULT_FORMATTING }], new Map());
      return performance.now() - start;
    };
    const small = time(5000);
    expect(time(20000) / small).toBeLessThan(8);
  });

  test('reads the keys of deleted text of many [ in linear time', () => {
    // Four times the text takes about four times as long, not sixteen
    const time = (n: number) => {
      const revision = { type: 'deletion' as const, author: 'A', date: '' };
      const start = performance.now();
      buildMarkdown([{ type: 'text', text: '['.repeat(n) + '@a]', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision }], new Map());
      return performance.now() - start;
    };
    const small = time(20000);
    expect(time(80000) / small).toBeLessThan(8);
  });

  test.each([
    ['in a note, whose missing data export doesn\'t note', 'Text[^1].\n\n[^1]: [@a]', '[^1]: [@a]'],
    ['after a note of its missing data in the first paragraph', '<!-- references -->\n\n[@a]', '[@a]'],
  ])('keeps a citation whose key is missing %s a citation', async (_name, md, line) => {
    // It went escaped, as text of a key export didn't know
    expect((await roundTrip(md)).split('\n')).toContain(line);
  });

  test.each([
    ['a table', '| x |\n|---|\n| 1 |'],
    ['a landscape section', '<!-- landscape -->\n\nB.\n\n<!-- /landscape -->'],
  ])('keeps a citation whose key is missing a citation where the note of its missing data comes before %s', async (_name, block) => {
    // A table or a section's marker starts no paragraph, so the note's
    // paragraph didn't end, and its key went unread
    expect((await roundTrip('A [@a].\n\n<!-- references -->\n\n' + block)).split('\n')).toContain('A [@a].');
  });

  test('keeps Word\'s text of a citation whose key the bibliography has a citation', async () => {
    // As export writes a deleted citation
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\nP XX Q.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('XX', '[@smith2020]'));
    const docx = await zip.generateAsync({ type: 'uint8array' });
    expect(strip((await convertDocx(docx)).markdown)).toBe('A.\n\nP \\[@smith2020] Q.\n');
    const existingBibtex = '@article{smith2020, author = {Smith, J.}, title = {T}, year = {2020}}';
    expect(strip((await convertDocx(docx, undefined, { existingBibtex })).markdown)).toBe('A.\n\nP [@smith2020] Q.\n');
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
    // copied it, as it ended with a link's concatenated syntax. Eight times
    // the links take about eight times as long, not sixty-four, however
    // fast the machine is.
    const time = (links: number) => {
      const items = Array.from({ length: links }, (_, k) => [
        { type: 'text', text: 't' + k, href: 'https://e.com/' + k, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING } },
        { type: 'text', text: ' ', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING } }]).flat();
      const start = performance.now();
      buildMarkdown(items as ContentItem[], new Map());
      return performance.now() - start;
    };
    const small = time(10000);
    expect(time(80000) / small).toBeLessThan(16);
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

  const run = (text: string, rPr = '') => '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:t>' + text + '</w:t></w:r>';
  const change = (tag: string, xml: string) => '<w:' + tag + ' w:id="90" w:author="A" w:date="2024-01-01T00:00:00Z">'
    + (tag === 'del' ? xml.replace(/w:t>/g, 'w:delText>') : xml) + '</w:' + tag + '>';
  const two = '$' + '$';
  test.each([
    ['bold and struck', run('$x') + run('$', '<w:b/>') + run(two, '<w:strike/>')],
    ['in code and italic', run('$x') + run('$', '<w:rStyle w:val="CodeChar"/>') + run(two, '<w:i/>')],
    ['plain and bold, after italic ones', run('$x', '<w:i/>') + run('$') + run(two, '<w:b/>')],
    ['inserted and deleted', run('$x') + change('ins', run('$')) + change('del', run(two, '<w:b/>'))],
    ['underlined and superscript, before an equation', run('$x') + run('$', '<w:u w:val="single"/>')
      + run(two, '<w:vertAlign w:val="superscript"/>') + '<m:oMath><m:r><m:t>(y)</m:t></m:r></m:oMath>'],
  ])('keeps a dollar sign before ones in runs side by side, %s, as text', async (_name, runs) => {
    // The runs' dollar signs ran together in the index of the runs after,
    // as three, which close no math, so the first wasn't escaped, and
    // opened math at the next, which Markdown keeps apart from the others,
    // or at the equation's, which was text then
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\nXX\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace('<w:r><w:t>XX</w:t></w:r>', () => runs);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    const equation = runs.includes('<m:oMath>');
    const exportedXml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(exportedXml.match(/<m:oMath>/g) ?? []).toHaveLength(equation ? 1 : 0);
    expect((await exported(markdown)).text).toEqual(['A.', '$x$' + two + (equation ? '(y)' : ''), 'B.']);
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

  test.each([
    ['after it, as a point comment\'s', 'XX{>>x==y<<}', 'a\\==b{>>x==y<<}', 'a==b'],
    ['after a range after it', 'XX {==c==}{>>x==y<<}', 'a\\==b {==c==}{>>x==y<<}', 'a==b c'],
    ['on a line after it, in ID syntax', '{#1}c{#2}XX{/1}d{/2}\n{#1>>p<<}\n{#2>>x==y<<}', '{#1}c{#2}a\\==b{/1}d{/2}\n{#1>>p<<}\n{#2>>x==y<<}', 'ca==bd'],
    ['on a line after it, in ID syntax, from a range before it', '{#1}c{#2}d{/1}e{/2} XX\n{#1>>x==y<<}\n{#2>>p<<}', '{#1}c{#2}d{/1}e{/2} a\\==b\n{#1>>x==y<<}\n{#2>>p<<}', 'cde a==b'],
    ['before it', 'P{>>x==y<<} XX', 'P{>>x==y<<} a==b', 'P a==b'],
  ])('keeps text\'s == as text where a comment\'s body with == in it goes %s', async (_name, md, expected, text) => {
    // Export read a highlight from the text's == to the body's, which took
    // the body's {>> for text and lost the comment, as the text's == read
    // the runs after it alone. ID syntax writes the bodies after all the
    // text. A body's own == opens none, as its {>> reads first.
    const markdown = await importText('A.\n\n' + md + '\n\nB.', 'a==b');
    expect(markdown).toBe('A.\n\n' + expected + '\n\nB.\n');
    expect((await exported(markdown)).text).toEqual(['A.', text, 'B.']);
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    expect(await zip.file('word/document.xml')!.async('string')).not.toContain('<w:highlight');
    expect(await zip.file('word/comments.xml')?.async('string')).toContain('x==y');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('reads a long comment body for == once over the many paragraphs of its range', () => {
    // Each paragraph the range ended in would read the body. Four times the
    // paragraphs and body take about four times as long, not sixteen,
    // however fast the machine is.
    const time = (n: number) => {
      const body = 'c'.repeat(40 * n) + '==';
      const items = Array.from({ length: n }, () => [{ type: 'para' }, { type: 'text', text: 'a==b', commentIds: new Set(['0']), formatting: DEFAULT_FORMATTING }]).flat();
      const start = performance.now();
      expect(buildMarkdown(items as ContentItem[], new Map([['0', { author: 'A', text: body, date: '' }]]))).toEndWith('a\\==b{/1}\n{#1>>@A | ' + body + '<<}');
      return performance.now() - start;
    };
    const small = time(10000);
    expect(time(40000) / small).toBeLessThan(8);
  });

  const fence = '$' + '$';
  test.each([
    ['an inline equation', 'XX $x==y$', 'a\\==b $x==y$', ['a==b x==y']],
    ['a display equation its paragraph goes on in', 'XX\n' + fence + '\nx==y\n' + fence, 'a\\==b\n' + fence + '\nx==y\n' + fence, ['a==b \nx==y\n']],
    ['the text after a display equation its paragraph goes on in', 'XX\n' + fence + '\nx\n' + fence + ' c==d',
      'a\\==b\n' + fence + '\nx\n' + fence + '&#32;c==d', ['a==b \nx\n c==d']],
    ['the body of a comment on a display equation its paragraph goes on in', 'XX\n{#1}' + fence + '\nx\n' + fence + '{/1}\n{#1>>x==y<<}',
      'a\\==b\n{#1}' + fence + '\nx\n' + fence + '{/1}\n{#1>>x==y<<}', ['a==b \nx\n']],
    ['an inline equation in a comment\'s range', '{==XX $x==y$==}{>>c<<}', '{==a\\==b $x==y$==}{>>c<<}', ['a==b x==y']],
    ['a display equation in a comment\'s range', '{#1}XX\n' + fence + '\nx==y\n' + fence + '{/1}\n{#1>>c<<}',
      '{#1}a\\==b\n' + fence + '\nx==y\n' + fence + '{/1}\n{#1>>c<<}', ['a==b \nx==y\n']],
    ['an inline equation in a pipe table\'s cell', '| h |\n| --- |\n| XX $x==y$ |', '| h |\n| --- |\n| a\\==b $x==y$ |', ['h', 'a==b x==y']],
    ['an inline equation in a grid table\'s cell', '+-------------+-----+\n| h           | x   |\n+=============+=====+\n| XX $x==y$   | b   |\n+-------------+-----+',
      '+--------------+-----+\n| h            | x   |\n+==============+=====+\n| a\\==b $x==y$ | b   |\n+--------------+-----+', ['h', 'x', 'a==b x==y', 'b']],
    ['a display equation in a grid table\'s cell', '+----------+\n| h        |\n+==========+\n| XX ' + fence + '    |\n| x==y     |\n| ' + fence + '       |\n+----------+',
      '+----------+\n| h        |\n+==========+\n| a\\==b ' + fence + ' |\n| x==y     |\n| ' + fence + '       |\n+----------+', ['h', 'a==b \nx==y\n']],
  ])('keeps text\'s == as text before an == in %s', async (_name, md, expected, text) => {
    // Export read a highlight from the text's == to the next, in an
    // equation's LaTeX, which Markdown has as it is, or past a display
    // equation, as the text read the runs after it with each equation as no
    // syntax, and only up to a display equation, past which the paragraph
    // goes on. The LaTeX stays as it was.
    const markdown = await importText('A.\n\n' + md + '\n\nB.', 'a==b');
    expect(markdown).toBe('A.\n\n' + expected + '\n\nB.\n');
    expect((await exported(markdown)).text).toEqual(['A.', ...text, 'B.']);
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    expect(await zip.file('word/document.xml')!.async('string')).not.toContain('<w:highlight');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['an inline equation', 'XX $x==y$', ' a\\==b $x==y$', 'a==b x==y'],
    ['a display equation its paragraph goes on in', 'XX\n    ' + fence + '\n    x==y\n    ' + fence,
      '\n\n    a\\==b\n    ' + fence + '\n    x==y\n    ' + fence, 'a==b \nx==y\n'],
  ])('keeps a note\'s text\'s == as text before an == in %s', async (_name, md, expected, text) => {
    // As in the document's text
    const markdown = await importText('T.[^1]\n\n[^1]: ' + md, 'a==b', 'word/footnotes.xml');
    expect(markdown).toBe('T.[^1]\n\n[^1]:' + expected + '\n');
    expect((await exported(markdown, 'word/footnotes.xml')).text).toEqual([text]);
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    expect(await zip.file('word/footnotes.xml')!.async('string')).not.toContain('<w:highlight');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('escapes a paragraph with many display equations in linear time', () => {
    // The runs before each equation would read the paragraph from it to its
    // end for ==, and the runs after it read it from its start. Four times
    // the equations take about four times as long, not sixteen, however
    // fast the machine is.
    const time = (n: number) => {
      const run = (text: string) => ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
      const items = [...Array.from({ length: n }, () => [run('a==b'), { type: 'math', latex: 'x', display: true, inParagraph: true, commentIds: new Set() }]).flat(), run('c==d')];
      const start = performance.now();
      expect(buildMarkdown(items as ContentItem[], new Map())).toStartWith('a\\==b\n' + fence + '\nx\n' + fence + 'a\\==b\n');
      return performance.now() - start;
    };
    const small = time(5000);
    expect(time(20000) / small).toBeLessThan(8);
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

  test('escapes a long run of URLs in linear time', () => {
    // Each URL's check read the run to its end
    const start = performance.now();
    expect(wrapWithFormatting('a_' + 'https://e.com/'.repeat(1500), DEFAULT_FORMATTING)).toBe('a_' + 'https\\://e.com/'.repeat(1500));
    expect(performance.now() - start).toBeLessThan(500);
  });

  test('escapes a long run of citations\' [ before a ( in linear time', () => {
    // Each [ read the citation to the ] its key ran to
    const start = performance.now();
    expect(wrapWithFormatting('[@'.repeat(100000) + 'a,p. 2](b)', DEFAULT_FORMATTING)).toBe('\\[@'.repeat(100000) + 'a,p. 2](b)');
    // Some 100 ms here, and three seconds read again for each [
    expect(performance.now() - start).toBeLessThan(1500);
  });

  test.each([
    ['bold', { bold: true }], ['italic', { italic: true }], ['struck', { strikethrough: true }], ['highlighted', { highlight: true }],
  ])('writes %s text with a long run of spaces in it in linear time', (_name, formatting) => {
    // A regex with a lazy middle read the spaces again from each one, and
    // found no match past some 20,000 of them, which threw
    const text = 'a' + ' '.repeat(100000) + 'b';
    const start = performance.now();
    expect(wrapWithFormatting(text, { ...DEFAULT_FORMATTING, ...formatting })).toContain(text);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  test('reads a long run of citations for tags in linear time', () => {
    // Each citation's search for a < read the run to its end. Four times
    // the citations take about four times as long, not sixteen, however
    // fast the machine is.
    const time = (n: number) => {
      const text = '[@a] '.repeat(n);
      const start = performance.now();
      expect(buildMarkdown([{ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING }], new Map(), { citationKeys: new Set(['a']) })).toBe(text);
      return performance.now() - start;
    };
    const small = time(50000);
    expect(time(200000) / small).toBeLessThan(8);
  });

  test('escapes a long run of [ in linear time', () => {
    // Each [ looked for its ] through the rest of the text
    const start = performance.now();
    expect(wrapWithFormatting('['.repeat(50000), DEFAULT_FORMATTING)).toBe('\\['.repeat(50000));
    expect(performance.now() - start).toBeLessThan(500);
  });

  test('writes the keys of a citation as they are', async () => {
    // A key's _ took a backslash, which went in the key
    const { line } = await importCited('[@_smith] and [see @smith_, p. 5]', '[@_smith; @smith_]');
    expect(line).toBe('P [@_smith] and [see @smith_, p. 5] Q.');
  });

  test.each([
    ['*x [@a] y*', '<w:i/>'], ['**[@a]**', '<w:b/>'], ['<sup>[@a]</sup>', '<w:vertAlign w:val="superscript"/>'],
    ['~~[@a]~~', '<w:strike/>'], ['<u>[@a]</u>', '<w:u w:val="single"/>'], ['*[@a; @b]*', '<w:i/>'],
  ])('keeps the formatting around %s, whose key is missing', async (md, rPr) => {
    // Export wrote its text with a highlight alone, so Word's text lost the
    // rest, and import, which reads that text's formatting, wrote it without
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toMatch(new RegExp('<w:rPr>' + rPr.replace(/[\\/]/g, '\\$&') + '</w:rPr><w:t>\\[@a'));
    expect(strip((await convertDocx(docx)).markdown).split('\n')[0]).toBe(md);
  });

  test.each([
    ['[@a<b>c]', 'a&lt;b&gt;c'], ['[@a<br>]', 'a&lt;br&gt;'], ['[@a, p<u>]', 'a'], ['[@a, <i>passim</i>]', 'a'],
  ])('writes the tag in %s as it is', async (text, key) => {
    // It was a reference, as for Word's text, which export, as it reads a
    // citation's keys as they are, read as keys, at its ;
    const { line, markdown } = await importCited(text);
    expect(line).toBe('P ' + text + ' Q.');
    expect(markdown).toEndWith('\nCitation data for @' + key + ' was not found in the bibliography file.\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['[@a; <b>see</b> @b]', '[@a; \\<b>see\\</b> @b]'], ['[@a; s<br>e @b]', '[@a; s\\<br>e @b]'],
  ])('writes the tag in the prefix of %s with its < escaped', async (text, md) => {
    // It was a reference, whose ; export took for the end of an item
    const { line, markdown } = await importCited(text, '[@a; @b]');
    expect(line).toBe('P ' + md + ' Q.');
    expect((await exported(markdown)).text[1]).toBe('P ' + text + ' Q.');
  });

  const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  test.each([
    ['a table', '<table><tr><td>y</td></tr></table>] Q.', '&lt;table&gt;&lt;tr&gt;&lt;td&gt;y&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;] Q.'],
    ['a heading', '# y] Q.', '\\# y] Q.'],
    ['a list item', '- y] Q.', '\\- y] Q.'],
    ['a line break\'s tag', '<br>] Q.', '&lt;br&gt;] Q.'],
  ])('writes a bracket of Word\'s with a line break in it before %s as text', async (_name, line, md) => {
    // Export reads a citation's keys and locators as they are, a line break
    // as a backslash and a line's end, and a line after it that starts a
    // block as one, as a table, which took the text after it
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\nXX\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('<w:t>XX</w:t>', '<w:t>P [@a, x</w:t><w:br/><w:t xml:space="preserve">' + escapeXml(line) + '</w:t>'));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('A.\n\nP \\[@a, x\\\n' + md + '\n\nB.\n');
    expect((await exported(markdown)).text[1]).toBe('P [@a, x\n' + line);
  });

  test.each(['[@a<br>]', '[@a, <i>p</i>]', '[@a; <b>see</b> @b]'])('writes the tag in %s in an HTML table\'s cell as text, where export reads no citation', async (text) => {
    // A cell with a tracked change, in a table with merged cells, which
    // only HTML holds, is written as its text
    const zip = await JSZip.loadAsync((await convertMdToDocx('| {++x++} XX y | z |\n|---|---|\n| a | b |\n')).docx);
    const xml = (await zip.file('word/document.xml')!.async('string')).replace(/<w:tr\b[\s\S]*?<\/w:tr>/, row => {
      const [first, second] = [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
      return row.replace(first, first.replace('<w:tcPr>', '<w:tcPr><w:gridSpan w:val="2"/>')).replace(second, '');
    });
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    zip.file('word/document.xml', xml.replace('XX', escapeXml(text)));
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toContain(' ' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + ' y</p>');
    expect((await exported(markdown)).text.some(cell => cell.endsWith(' ' + text + ' y'))).toBe(true);
  });

  /** `md`, a pipe table, with the two cells of its row with XX in them one,
   *  as Word merges them, and `xml` in place of XX, as import writes it, as
   *  an HTML table, which alone holds one */
  const mergedCellTable = async (md: string, xml: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const document = (await zip.file('word/document.xml')!.async('string')).replace(/<w:tr\b(?:(?!<\/w:tr>)[\s\S])*?XX[\s\S]*?<\/w:tr>/, row => {
      const [first, second] = [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
      return row.replace(first, first.replace('<w:tcPr>', '<w:tcPr><w:gridSpan w:val="2"/>')).replace(second, '');
    });
    expect(document).toContain('<w:gridSpan w:val="2"/>');
    zip.file('word/document.xml', document.replace('XX', xml));
    return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
  };

  test.each([
    ['Markdown syntax', '*a* `b` [c](d) $e$ ==f== \\g'],
    ['an HTML tag', '<span>a</span>'],
    ['an entity', '&amp; &lt;'],
    ['spaces HTML runs together', 'a  b   c'],
    ['CriticMarkup and a highlight', '{++a++} b==c=='],
    ['a line break', 'a\nb'],
  ])('keeps %s in an HTML table\'s cell that holds what HTML can\'t as its text', async (_name, text) => {
    // Export reads the cell as HTML, where its escapes were text, its tags
    // tags, its spaces one, and its line break a backslash and a space
    const xml = escapeXml(text).replace('\n', '</w:t><w:br/><w:t xml:space="preserve">');
    const markdown = await mergedCellTable('| {++x++} XX y | z |\n|---|---|\n| a | b |\n', xml);
    expect((await exported(markdown)).text.some(cell => cell.endsWith(' ' + text + ' y'))).toBe(true);
  });

  test('keeps the formatting of the text in an HTML table\'s cell that holds what HTML can\'t', async () => {
    // Its delimiters, as **, were text there
    const markdown = await mergedCellTable('| a | b |\n|---|---|\n| {++x++} **XX** *y* `z` | w |\n', 'bold');
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    const cell = /<w:tc>(?:(?!<\/w:tc>)[\s\S])*?bold[\s\S]*?<\/w:tc>/.exec(xml)![0];
    expect(cell).toMatch(/<w:b\/>[\s\S]*?<w:t[^>]*>bold<\/w:t>/);
    expect(cell).toMatch(/<w:i\/>[\s\S]*?<w:t[^>]*>y<\/w:t>/);
    // The tracked change, which HTML can't hold, as its text
    expect(cell.replace(/<[^>]+>/g, '')).toBe('{++x++} bold y z');
  });

  const insertedRun: ContentItem = { type: 'text', text: 'x', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: { type: 'addition', author: 'A', date: '' } };

  /** Import's Markdown for a table with merged cells, whose first row's
   *  one cell has `runs`, with a tracked change, which HTML can't hold, and
   *  Word's text of that cell when export reads it back, with ↵ for a line
   *  break */
  const fallbackCell = async (runs: ContentItem[]) => {
    const run = (text: string): ContentItem => ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
    const markdown = buildMarkdown([{
      type: 'table',
      rows: [
        { isHeader: false, cells: [{ paragraphs: [runs], colspan: 2 }] },
        { isHeader: false, cells: [{ paragraphs: [[run('b')]] }, { paragraphs: [[run('c')]] }] },
      ],
    } as ContentItem], new Map());
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    return { markdown, text: xml.slice(xml.indexOf('<w:tc>'), xml.indexOf('</w:tc>')).replace(/<w:br\/>/g, '↵').replace(/<[^>]+>/g, '') };
  };

  test.each([
    ['bold at the cell\'s start', ' a', { bold: true }, ' a{++x++}'],
    ['underlined at the cell\'s start', '  a', { underline: true }, '  a{++x++}'],
    ['after a line break', 'a\\\n  b', {}, 'a↵  b{++x++}'],
  ])('keeps the spaces of a run %s in an HTML table\'s cell that holds what HTML can\'t', async (_name, text, formatting, expected) => {
    // HTML dropped them at the edge of the tags of its formatting, or a line
    const { text: cell } = await fallbackCell([{ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting } }, insertedRun]);
    expect(cell).toBe(expected);
  });

  test.each([
    ['ends in an =', 'a=', '==a&#61;=='],
    ['has two =', 'a==b', '==a&#61;&#61;b=='],
    ['has an = before an = at its end', 'a=b=', '==a&#61;b&#61;=='],
    ['has an = before a space at its end', 'a= ', '==a&#61; =='],
  ])('writes a highlighted run that %s in an HTML table\'s cell that holds what HTML can\'t with a highlight\'s ==', async (_name, text, highlight) => {
    // Its = ran into the highlight's ==, which the grammar and navigation
    // read as none, or as a shorter one
    const { markdown, text: cell } = await fallbackCell([{ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, highlight: true } }, insertedRun]);
    expect(markdown).toContain('<p>' + highlight + '{++x++}</p>');
    expect(cell).toBe('==' + text + '=={++x++}');
  });

  test('keeps the spaces of runs that end and start with one in an HTML table\'s cell that holds what HTML can\'t', async () => {
    // HTML ran them together across the runs' tags
    const run = (text: string, formatting: Partial<RunFormatting> = {}): ContentItem => ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting } });
    const { text: cell } = await fallbackCell([run('  ', { bold: true }), run(' a'), run('b ', { italic: true }), run(' c'), insertedRun]);
    expect(cell).toBe('   ab  c{++x++}');
  });

  test.each([
    ['backticks', '`a', 'b`', '&#96;a{++x++}b&#96;'],
    ['tildes', '~~a', 'b~~', '&#126;&#126;a{++x++}b&#126;&#126;'],
  ])('writes the %s of text in an HTML table\'s cell that holds what HTML can\'t as references', async (_name, before, after, expected) => {
    // Navigation read them as code around the change, which it skipped, or
    // as strikethrough, a change of its own
    const run = (text: string): ContentItem => ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
    const { markdown, text: cell } = await fallbackCell([run(before), insertedRun, run(after)]);
    expect(markdown).toContain('<p>' + expected + '</p>');
    expect(cell).toBe(before + '{++x++}' + after);
  });

  test.each([
    ['a bold run after a line break', [['a\\\n', {}], [' b', { bold: true }]], 'a↵ b{++x++}'],
    ['an underlined space before a citation', [['a', {}], [' ', { underline: true }]], 'a [@smith2020]{++x++}'],
    ['a line break before a citation', [['a\\\n', {}]], 'a↵[@smith2020]{++x++}'],
    ['code that ends in a space before a citation', [['a ', { code: true }]], 'a [@smith2020]{++x++}'],
    ['a long run of spaces in bold', [['a' + ' '.repeat(25000) + 'b', { bold: true }]], 'a' + ' '.repeat(25000) + 'b{++x++}'],
  ])('keeps the spaces of %s in an HTML table\'s cell that holds what HTML can\'t', async (_name, runs, expected) => {
    // HTML dropped one at a line's start the run before ended, the
    // separator put a second before a citation after one as a reference or
    // a tag it didn't know, or one at a line's start after a <br>, and the
    // edges of a long run read in time in its square failed
    const items: ContentItem[] = (runs as [string, Partial<RunFormatting>][]).map(([text, formatting]) =>
      ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting } }));
    if ((expected as string).includes('[@')) items.push({ type: 'citation', text: '(Smith 2020)', commentIds: new Set(), pandocKeys: ['@smith2020'] });
    const { text: cell } = await fallbackCell([...items, insertedRun]);
    expect(cell).toBe(expected);
  });

  test('keeps the space between the runs of a joined highlight in an HTML table\'s cell that holds what HTML can\'t inside it', async () => {
    // Outside both runs' ==, it split the highlight in two
    const highlighted = (text: string, formatting: Partial<RunFormatting>): ContentItem =>
      ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, highlight: true, ...formatting } });
    const { markdown } = await fallbackCell([highlighted('a ', { bold: true }), highlighted('b', { italic: true }), insertedRun]);
    expect(markdown).toContain('<p>==<b>a</b> <i>b</i>=={++x++}</p>');
  });

  test('writes text that reads as CriticMarkup in an HTML table\'s cell that holds what HTML can\'t with its braces as references', async () => {
    // Navigation and the grammar read it as a change
    const { markdown } = await fallbackCell([{ type: 'text', text: '{++a++} ', commentIds: new Set(), formatting: DEFAULT_FORMATTING }, insertedRun]);
    expect(markdown).toContain('<p>&#123;++a++&#125; {++x++}</p>');
  });

  test.each([
    ['underlined', { underline: true }, '<u>a </u>'],
    ['bold and underlined', { bold: true, underline: true }, '<b><u>a </u></b>'],
  ])('puts no second space before a citation after a space %s in an HTML table\'s cell that holds what HTML can\'t', async (_name, formatting, run) => {
    // A reference for the space, or a tag the separator didn't know, hid
    // it from the separator
    const { markdown } = await fallbackCell([
      { type: 'text', text: 'a ', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting } },
      { type: 'citation', text: '(Smith 2020)', commentIds: new Set(), pandocKeys: ['@smith2020'] },
      insertedRun,
    ]);
    expect(markdown).toContain('<p>' + run + '[@smith2020]{++x++}</p>');
  });

  test('keeps the spaces of an HTML comment in an HTML table\'s cell that holds what HTML can\'t as they are', async () => {
    // Export keeps a comment's text as it is, references and all
    const { markdown } = await fallbackCell([
      { type: 'text', text: 'a ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'html_comment', text: '<!-- b  c -->', commentIds: new Set() } as ContentItem,
      insertedRun,
    ]);
    expect(markdown).toContain('<!-- b  c -->');
  });

  test('joins the highlights of runs formatted otherwise in an HTML table\'s cell that holds what HTML can\'t', async () => {
    // As one == around both, which the grammar and navigation read as one
    const highlighted = (text: string, formatting: Partial<RunFormatting>): ContentItem =>
      ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, highlight: true, ...formatting } });
    const { markdown } = await fallbackCell([highlighted('a', { bold: true }), highlighted('b', { italic: true }), insertedRun]);
    expect(markdown).toContain('<p>==<b>a</b><i>b</i>=={++x++}</p>');
  });

  test.each([
    ['a bold word before a period', [['word', { bold: true }], ['.', {}]], '{++word.++}'],
    ['a period before an underlined word', [['.', {}], ['word', { underline: true }]], '{++.word++}'],
    // Its &, < and > as XML writes them
    ['an ampersand before a letter in superscript', [['a&', {}], ['b', { superscript: true }]], '{++a&amp;b++}'],
    ['a letter before one highlighted', [['a', {}], ['b', { highlight: true }]], '{++a==b==++}'],
    ['a bold space before text of a tag', [['a ', { bold: true }], ['<b>a</b>', {}]], '{++a &lt;b&gt;a&lt;/b&gt;++}'],
    ['text of a tag before a bold letter', [['<b>a</b>', {}], ['a', { bold: true }]], '{++&lt;b&gt;a&lt;/b&gt;a++}'],
  ])('joins the change of %s in an HTML table\'s cell that holds what HTML can\'t', async (_name, runs, expected) => {
    // The tags and references of its runs, read as Markdown's delimiters
    // and text, split it, which then came back with a second span's braces
    const revision: RevisionInfo = { type: 'addition', author: 'A', date: '' };
    const items = (runs as [string, Partial<RunFormatting>][]).map(([text, formatting]): ContentItem =>
      ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, revision }));
    const { text: cell } = await fallbackCell(items);
    expect(cell).toBe(expected);
  });

  test.each([
    ['at the cell\'s start', [['\\\n', {}]], '↵{++x++}'],
    ['in bold after text', [['a', {}], ['\\\n', { bold: true }]], 'a↵{++x++}'],
  ])('keeps a line break in a run of its own %s in an HTML table\'s cell that holds what HTML can\'t', async (_name, runs, expected) => {
    // It went as Markdown's backslash, which came back as text
    const items = (runs as [string, Partial<RunFormatting>][]).map(([text, formatting]): ContentItem =>
      ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting } }));
    const { text: cell } = await fallbackCell([...items, insertedRun]);
    expect(cell).toBe(expected);
  });

  test('keeps the strikethrough of the spaces at the edges of a run in an HTML table\'s cell that holds what HTML can\'t', async () => {
    // They went outside its tags, as Markdown's delimiters keep them
    const { markdown } = await fallbackCell([
      { type: 'text', text: 'a', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'text', text: ' b\t', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, strikethrough: true } },
      insertedRun,
    ]);
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    const cell = xml.slice(xml.indexOf('<w:tc>'), xml.indexOf('</w:tc>'));
    const struck = [...cell.matchAll(/<w:r>(?:(?!<\/w:r>)[\s\S])*?<w:strike\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g)]
      .map(run => run[0].replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).join('');
    expect(struck).toBe(' b\t');
  });

  test('keeps a link of a line break and bold text after it one link in an HTML table\'s cell that holds what HTML can\'t', async () => {
    // The bold text's tag read as an HTML block's start, which the link
    // split at, and its URL came back twice
    const link = (text: string, formatting: Partial<RunFormatting>): ContentItem =>
      ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, href: 'https://e.com' });
    const { markdown } = await fallbackCell([link('a', { underline: true }), link('\\\n', {}), link('b', { bold: true }), insertedRun]);
    expect(markdown.split('https://e.com')).toHaveLength(2);
  });

  test.each([
    ['a link', [['see ', {}], ['site', {}, 'https://e.com/a?b=1&c=2']], 'see site{++x++}'],
    ['a link in bold', [['see ', {}], ['site', { bold: true }, 'https://e.com/a?b=1&c=2']], 'see site{++x++}'],
    ['a bare link', [['https://e.com/a?b=1&c=2', {}, 'https://e.com/a?b=1&c=2']], 'https://e.com/a?b=1&amp;c=2{++x++}'],
    ['a link after a !', [['see!', {}], ['site', {}, 'https://e.com/a?b=1&c=2']], 'see!site{++x++}'],
    ['a link of runs', [['see ', {}], ['s', {}, 'https://e.com/a?b=1&c=2'], ['ite', { italic: true }, 'https://e.com/a?b=1&c=2']], 'see site{++x++}'],
    ['a link that starts with a space after one', [['see ', {}], [' site', {}, 'https://e.com/a?b=1&c=2']], 'see  site{++x++}'],
    ['a link that starts with a space after a line break', [['see\\\n', {}], [' site', {}, 'https://e.com/a?b=1&c=2']], 'see↵ site{++x++}'],
  ])('keeps %s in an HTML table\'s cell that holds what HTML can\'t', async (_name, runs, expected) => {
    // It went as Markdown's link, whose brackets and URL came back as text
    const items = (runs as [string, Partial<RunFormatting>, string?][]).map(([text, formatting, href]): ContentItem =>
      ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, ...(href ? { href } : {}) }));
    const { markdown, text: cell } = await fallbackCell([...items, insertedRun]);
    expect(cell).toBe(expected);
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const links = [...xml.slice(xml.indexOf('<w:tc>'), xml.indexOf('</w:tc>')).matchAll(/<w:hyperlink r:id="([^"]+)"[\s\S]*?<\/w:hyperlink>/g)];
    expect(links).toHaveLength(1);
    expect(links[0][0].replace(/<[^>]+>/g, '')).toBe(items.filter(item => 'href' in item).map(item => (item as { text: string }).text.replace(/&/g, '&amp;')).join(''));
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).toContain('Id="' + links[0][1] + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://e.com/a?b=1&amp;c=2"');
  });

  test('puts no second space before a citation after a link that ends in one in an HTML table\'s cell that holds what HTML can\'t', async () => {
    // The separator read the link's closing tag as text before the citation
    const { text: cell } = await fallbackCell([
      { type: 'text', text: 'site ', commentIds: new Set(), formatting: DEFAULT_FORMATTING, href: 'https://e.com' },
      { type: 'citation', text: '(Smith 2020)', commentIds: new Set(), pandocKeys: ['@smith2020'] },
      insertedRun,
    ]);
    expect(cell).toBe('site [@smith2020]{++x++}');
  });

  test('keeps a link inserted in an HTML table\'s cell that holds what HTML can\'t', async () => {
    const { markdown, text: cell } = await fallbackCell([
      { type: 'text', text: 'see ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'text', text: 'site', commentIds: new Set(), formatting: DEFAULT_FORMATTING, href: 'https://e.com', revision: { type: 'addition', author: 'A', date: '' } },
    ]);
    expect(cell).toBe('see {++site++}');
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml.slice(xml.indexOf('<w:tc>'), xml.indexOf('</w:tc>'))).toMatch(/<w:hyperlink [^>]*>(?:(?!<\/w:hyperlink>)[\s\S])*site/);
  });

  test.each(['[@a](b)', '[-@a](b)', '[@a]{.underline}', '[@a][b]'])('writes %s with the citation export reads in it', async (text) => {
    // Its [ was escaped as a link's, so a citation whose key is missing,
    // which export writes as its text, came back as text, and stayed text
    // once the bibliography had the key
    const { line, markdown } = await importCited(text, '[@a]');
    expect(line).toBe('P ' + text + ' Q.');
    expect(await roundTrip(markdown)).toBe(markdown);
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
    ['an insertion', 'x{~~~>`++}`~~}y', 'w:ins', ['++}']],
    ['a deletion', 'x{~~`--}`~>~~}y', 'w:del', ['--}']],
    ['a deletion in part of a link', 'x[a{~~`--}`~>~~}b](https://e.com)y', 'w:del', ['--}']],
    ['an insertion at the end of a link', 'x[a{~~~>`++}`~~}](https://e.com)y', 'w:ins', ['++}']],
    ['a deleted link', 'x{~~[`--}`](https://e.com)~>~~}y', 'w:del', ['--}']],
    ['a deletion between two others', 'x{--a--}{~~`--}`~>~~}{--b--}y', 'w:del', ['a', '--}', 'b']],
  ])('keeps the closer of %s in code in its text', async (_name, md, tag, texts) => {
    // It ended the tracked change around it, as an escape in code is text,
    // so it goes on one side of a substitution, and export wrote the empty
    // other side as a change
    const docx = (await convertMdToDocx(md)).docx;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const changed = [...xml.matchAll(new RegExp('<' + tag + '\\b[\\s\\S]*?</' + tag + '>', 'g'))]
      .map(m => m[0].replace(/<[^>]+>/g, ''));
    expect(changed).toEqual(texts);
    expect(xml).not.toContain(tag === 'w:ins' ? '<w:del ' : '<w:ins ');
    expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()).toBe(md);
  });

  test.each([
    ['a deletion', 'P {--`XX`--} Q.', 'a --} b ~> c', 'w:del', 'P {--`a -`--}{--`-} b ~> c`--} Q.'],
    ['a deletion, before a ~~}', 'P {--`XX`--} Q.', 'a --} b ~~} c', 'w:del', 'P {--`a -`--}{--`-} b ~~} c`--} Q.'],
    ['a deletion, after a ~>', 'P {--`XX`--} Q.', '~>--}--}', 'w:del', 'P {--`~>-`--}{--`-}-`--}{--`-}`--} Q.'],
    ['an insertion, before a ~~}', 'P {++`XX`++} Q.', 'a ++} b ~~} c', 'w:ins', 'P {++`a +`++}{++`+} b ~~} c`++} Q.'],
    ['a deletion, in bold', 'P {--**`XX`**--} Q.', 'a --} b ~> c', 'w:del', 'P {--**`a -`**--}{--**`-} b ~> c`**--} Q.'],
    // Each piece of highlighted code with an == in it goes in spans split
    // between the two =
    ['a deletion, highlighted, with an ==', 'P {--==`XX`==--} Q.', 'a==b --} c ~> d', 'w:del',
      'P {--==`a=`=={yellow}==`=b -`=={yellow}--}{--==`-} c ~> d`==--} Q.'],
    ['a deletion in a comment\'s range', 'P {=={--`XX`--}==}{>>c<<} Q.', 'a --} b ~> c', 'w:del',
      'P {=={--`a -`--}{--`-} b ~> c`--}==}{>>c<<} Q.'],
    // Its last pieces, which hold no ~>, were a side of the substitution,
    // where their backticks ran together
    ['a deletion before an insertion', 'P {~~`XX`~>b~~} Q.', '~>--}--}', 'w:del', 'P {--`~>-`--}{--`-}-`--}{--`-}`--}{++b++} Q.'],
    // The highlight's group held the pieces, whose backticks ran together
    ['a deletion in a highlight with an equation', 'P {--==`XX`$x$&#122;==--} Q.', 'a --} b ~> c', 'w:del',
      'P {--==`a -`==--}{--==`-} b ~> c`$x$&#122;==--} Q.'],
  ])('keeps code with the closer of %s in its text', async (_name, md, text, tag, expected) => {
    // A substitution with one side, which holds the closer, can't hold a ~>
    // on the old side, or a ~~}, so the change ended at the closer, and the
    // code's backticks were text, as were the rest of its delimiters
    const markdown = await importText('A.\n\n' + md + '\n\nB.', text);
    expect(markdown).toBe('A.\n\n' + expected + '\n\nB.\n');
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    // In runs of code side by side in the change, as Word shows it
    const runs = [...xml.matchAll(new RegExp('<' + tag + '\\b[\\s\\S]*?</' + tag + '>', 'g'))].flatMap(m => m[0].match(/<w:r>[\s\S]*?<\/w:r>/g) ?? []);
    const code = runs.filter(run => run.includes('<w:rStyle w:val="CodeChar"/>'));
    expect(code.map(run => run.replace(/<[^>]+>/g, '').replace(/&gt;/g, '>')).join('')).toBe(text);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  const revised = (text: string, type: 'addition' | 'deletion', formatting: Partial<RunFormatting> = {}): ContentItem => (
    { type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, revision: { type, author: 'A', date: '2024-01-01T00:00:00Z' } });

  test('writes deleted code of many closers and a ~> before an insertion in linear time', () => {
    // Each piece of the code tried a substitution from it, which built the
    // rest of the deletion as its old side before it declined: about 13 s
    const items = [revised('a --} '.repeat(12000) + '~>', 'deletion', { code: true }), revised('b', 'addition')];
    const start = performance.now();
    expect(buildMarkdown(items, new Map())).toEndWith('{--`-} a -`--}{--`-} ~>`--}{++b++}');
    expect(performance.now() - start).toBeLessThan(2000);
  });

  test('writes a deleted highlight of many runs before code of its closer and a ~> in linear time', () => {
    // Each run read on to the code's pieces for a group, which text of
    // another color there would have kept it from: about 8 s
    const items = [
      ...Array.from({ length: 32000 }, (_, k) => revised('a', 'deletion', { highlight: true, bold: k % 2 === 1 })),
      revised('a --} b ~> c', 'deletion', { highlight: true, code: true }),
    ];
    const start = performance.now();
    expect(buildMarkdown(items, new Map())).toEndWith('{--**==a==**--}{--==`a -`==--}{--==`-} b ~> c`==--}');
    expect(performance.now() - start).toBeLessThan(2000);
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
    // The { before the space and the highlight's closing ==
    const markdown = await importText('A.\n\n<u>==XX==</u>b\n\nB.', '{ ');
    expect(markdown).toContain('<u>==\\{ ==</u>b');
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
    // Which Word showed as text
    ['a comment', '      <p>a<!-- c --> b</p>'],
    ['comments alone and in formatting', '      <p><!-- c --></p>\n      <p><b>x<!-- d -->y</b></p>'],
    // Whose </td> ended the cell, which lost what came after it
    ['a comment with a cell\'s end in it', '      <p><!-- <td>old</td> -->b</p>'],
    // Which hid the rest of the table, as it read no --> after them
    ['an empty comment the browser ends at its >', '      <p>a<!-->b</p>'],
    ['an empty comment the browser ends at its ->', '      <p>a<!--->b</p>'],
    ['a comment the browser ends at its --!>', '      <p>a<!-- c --!>b</p>'],
    // Whose > and < it wrote as references, which hid them from the editor
    ['CriticMarkup\'s delimiters, as text', '      <p>a {~~b~>c~~}{==d==}{>>e &lt;b&gt;<<}</p>'],
  ])('keeps %s', async (_name, cell) => {
    // Import wrote Markdown in the cell, which exports as literal text, with
    // a backslash before each character Markdown would read, and more on
    // each round trip, and a cell's paragraphs as one with a \ break
    const md = table(cell);
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(await roundTrip(md))).toBe(md);
  });

  test.each([
    ['at a link\'s end', '      <p>x <a href="https://e.com">a<br></a>y</p>', 0],
    ['at a link\'s start', '      <p>x<a href="https://e.com"><br>a</a> y</p>', 0],
    ['in a link', '      <p>x <a href="https://e.com">a<br>b</a> y</p>', 0],
    ['that is all of a link', '      <p>x<a href="https://e.com"><br></a>y</p>', 0],
    ['at the end of a link that ends a paragraph', '      <p>x <a href="https://e.com"><b>a</b><br></a></p>', 0],
    ['between two links to one place', '      <p><a href="https://e.com">a</a><br><a href="https://e.com">b</a></p>', 1],
  ] as const)('keeps a line break %s in the hyperlink it\'s in', async (_name, cell, outside) => {
    // Export ended the hyperlink at the break, and import wrote a break at
    // a link's edge out of the link, and one between links to one place in
    // one link of both
    const md = table(cell);
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(cell.match(/<a /g)!.length);
    expect(xml.replace(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/g, '').match(/<w:br\/>/g)?.length ?? 0).toBe(outside);
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(await roundTrip(md))).toBe(md);
  });

  test.each([
    ['<!-->', '<!-- c -->'],
    ['<!--->', '<!-- c -->'],
    ['<!-- c --!>', '<!-- d -->'],
  ])('keeps %s and %s in a cell that Word holds in one hidden run', async (first, second) => {
    // The first went on to the second's -->, with the ZWSP before it, which
    // made no comment HTML holds, and a pipe table that showed the ZWSP
    const md = table('      <p>a' + first + second + 'b</p>');
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const joined = xml.replace(/(?<=&gt;)<\/w:t><\/w:r><w:r><w:rPr><w:vanish\/>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t>(?=\u200B)/, '');
    expect(joined).not.toBe(xml);
    zip.file('word/document.xml', joined);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe(md);
  });

  test.each([
    ['its ZWSP', '\u200B'],
    ['its <', '\u200B&lt;'],
  ])('keeps a comment after one that ends at its --!> where Word splits its run after %s', async (_name, start) => {
    // The < went on the comment before, which inline Markdown reads to a -->
    const md = table('      <p>a<!-- c --!><!-- d -->b</p>');
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const second = [...xml.matchAll(/(<w:r><w:rPr><w:vanish\/>(?:(?!<\/w:rPr>).)*<\/w:rPr>)<w:t>([^<]*)<\/w:t><\/w:r>/g)][1];
    const split = second[1] + '<w:t>' + start + '</w:t></w:r>' + second[1] + '<w:t>' + second[2].slice(start.length) + '</w:t></w:r>';
    expect(second[2].startsWith(start)).toBe(true);
    zip.file('word/document.xml', xml.slice(0, second.index) + split + xml.slice(second.index! + second[0].length));
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe(md);
  });

  test.each([
    ['in HTML', false, table('      <p>a<!-- c --!><!-- d -->b</p>')],
    ['in a table that leaves HTML', true, '| h |\n| --- |\n| {++a++}<!-- c --><!-- d -->b |'],
  ])('keeps a comment after one that ends at its --!> where Word moves its ZWSP to the run before, %s', async (_name, tracked, expected) => {
    // The ZWSP went on the comment before, which got an end after it, which
    // showed in the cell
    const zip = await JSZip.loadAsync((await convertMdToDocx(table('      <p>a<!-- c --!><!-- d -->b</p>'))).docx);
    let xml = await zip.file('word/document.xml')!.async('string');
    const split = xml.replace(/--!&gt;(<\/w:t><\/w:r><w:r><w:rPr><w:vanish\/>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t[^>]*>)\u200B/, (_match, between: string) => '--!&gt;\u200B' + between);
    expect(split).not.toBe(xml);
    xml = tracked ? split.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>a<\/w:t><\/w:r>)/, (_match, run: string) => '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>' + run + '</w:ins>') : split;
    zip.file('word/document.xml', xml);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe(expected);
  });

  test.each([
    ['in HTML', false, table('      <p>a<!-- a <!--->b</p>')],
    ['in a table that leaves HTML', true, '| h |\n| --- |\n| {++a++}<!-- a <!- -->b |'],
  ])('keeps a cell\'s comment hidden that Word splits before an <!-- in it, %s', async (_name, tracked, expected) => {
    // Its pieces were two comments, the second with a space before it, which
    // HTML held as none, and inline Markdown read the first as text
    const zip = await JSZip.loadAsync((await convertMdToDocx(table('      <p>a<!-- a <!--->b</p>'))).docx);
    let xml = await zip.file('word/document.xml')!.async('string');
    const split = xml.replace('\u200B&lt;!-- a &lt;!---&gt;', '\u200B&lt;!-- a</w:t></w:r><w:r><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve"> &lt;!---&gt;');
    expect(split).not.toBe(xml);
    xml = tracked ? split.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>a<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>') : split;
    zip.file('word/document.xml', xml);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe(expected);
  });

  test('keeps a pipe cell\'s comment hidden that Word splits before an <!-- in it after a --!>', async () => {
    // A --!> ended its first piece, as it does an HTML table's comment, but
    // not one inline Markdown reads, and the rest showed
    const md = '| h |\n| --- |\n| a<!-- a --!><!---> secret -->b |';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const split = xml.replace('\u200B&lt;!-- a --!&gt;&lt;!---&gt; secret --&gt;', '\u200B&lt;!-- a --!&gt;</w:t></w:r><w:r><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">&lt;!---&gt; secret --&gt;');
    expect(split).not.toBe(xml);
    zip.file('word/document.xml', split);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe(md);
  });

  test('keeps a cell\'s comment hidden that Word splits before an <!-- in it, in a Word comment\'s range', async () => {
    // Its pieces in the range weren't joined, and the space between showed
    const md = '| h |\n| --- |\n| {#1}a<!-- old <!-- inside -->b{/1} |\n\n{#1>>note<<}';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const split = xml.replace('\u200B&lt;!-- old &lt;!-- inside --&gt;', '\u200B&lt;!-- old</w:t></w:r><w:r><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve"> &lt;!-- inside --&gt;');
    expect(split).not.toBe(xml);
    zip.file('word/document.xml', split);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe(md);
  });

  test.each([
    ['ends at a --!>', 'a<!-- hidden --!>b', 'a<!-- hidden -->b'],
    ['has no end', 'a<!-- x', 'a<!-- x</td></tr></table> -->'],
    ['ends at a --!> before an empty one', 'a<!-- hidden --!><!--->b', 'a<!-- hidden --><!--->b'],
    ['ends at a --> after a -', 'a<!-- hidden --->b', 'a<!-- hidden - -->b'],
  ])('hides a cell\'s comment that %s in a table that leaves HTML', async (_name, cell, expected) => {
    // Inline Markdown read it as text, and showed it
    const zip = await JSZip.loadAsync((await convertMdToDocx('<table><tr><td>XX</td><td>' + cell + '</td></tr></table>\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    // A grid table, as a pipe table needs a header row
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown.split('\n')).toContain('| {++XX++} | ' + expected + ' |');
    expect(markdown).not.toContain('<table');
  });

  test('keeps a table whose cell has a comment with no end as HTML, with an end', async () => {
    // HTML held no such comment, and the table became a pipe table, which
    // showed it
    const markdown = await roundTrip('<table><tr><td>a<!-- x</td></tr></table>\n');
    expect(markdown).toContain('<p>a<!-- x</td></tr></table> --></p>');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('writes a table whose cell has a comment with a blank line in it as no HTML table', async () => {
    // The blank line ended the table's HTML block, which exported as text
    const zip = await JSZip.loadAsync((await convertMdToDocx('<table><tr><td>a<!-- x y -->b</td><td>c</td></tr></table>\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const broken = xml.replace('x y --&gt;', 'x</w:t><w:br/><w:br/><w:t xml:space="preserve">y --&gt;');
    expect(broken).not.toBe(xml);
    zip.file('word/document.xml', broken);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(md).not.toContain('<table>');
    expect(md).toContain('a<!-- x');
    expect((await roundTrip(md)).trim()).toBe(md.trim());
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

  // A Word table, which import writes as a pipe table, a grid table, or
  // HTML past their widths
  const wordTable = (cell: ContentItem[], header = false) => [{ type: 'table', rows: [
    { isHeader: true, cells: [{ paragraphs: [[cellText('x')]] }] },
    { isHeader: header, cells: [{ paragraphs: [cell] }] },
  ] }] as unknown as ContentItem[];
  const cellText = (t: string, ids: string[] = [], formatting: Partial<RunFormatting> = {}, revision?: RevisionInfo) =>
    ({ type: 'text', text: t, commentIds: new Set(ids), formatting: { ...DEFAULT_FORMATTING, ...formatting }, ...(revision ? { revision } : {}) }) as ContentItem;
  const noWidth = { pipeTableMaxLineWidth: 0, gridTableMaxLineWidth: 0 };

  test.each([
    ['a comment', [cellText('a'), cellText('\\\n'), cellText('b'), cellText('c', ['0'])],
      '+----------------------+\n| x                    |\n+======================+\n| a                    |\n| b{==c==}{>>@A | d<<} |\n+----------------------+'],
    ['a tracked change', [cellText('a', [], {}, { type: 'addition', author: 'A', date: '2024-01-01T00:00:00Z' }), cellText('\\\n'), cellText('b')],
      '+---------+\n| x       |\n+=========+\n| {++a++} |\n| b       |\n+---------+'],
    ['a highlight', [cellText('a', [], { highlight: true }), cellText('\\\n'), cellText('b')],
      '+-------+\n| x     |\n+=======+\n| ==a== |\n| b     |\n+-------+'],
  ])('writes a table with a line break and %s, past the widths of a pipe table and a grid table, as a grid table', async (_name, cell, expected) => {
    // It became an HTML table, whose cell exported the comment, the change
    // or the highlight, and the \ of the line break, as literal text
    const markdown = buildMarkdown(wordTable(cell), new Map([['0', { author: 'A', text: 'd', date: '' }]]), noWidth);
    expect(markdown).toBe(expected);
    expect(strip((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).trimEnd()).toBe(markdown);
  });

  test('writes a table of header rows alone with a line break and a highlight as a grid table with its header', async () => {
    // Its grid table had no header, so the next export lost the header's bold
    const markdown = buildMarkdown(wordTable([cellText('a', [], { highlight: true }), cellText('\\\n'), cellText('b')], true), new Map(), noWidth);
    expect(markdown).toBe('+-------+\n| x     |\n+-------+\n| ==a== |\n| b     |\n+=======+');
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:tblHeader\/>/g)?.length).toBe(2);
    expect(strip((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).trimEnd()).toBe(markdown);
  });

  test.each([
    ['', {}],
    [', with a line width of 0, though a cell has a highlight', noWidth],
  ])('keeps a table with a header row after a body row out of a grid table%s', async (_name, widths) => {
    // A grid table's header is its leading rows, so export read the last
    // row as a body row, without its header or its bold
    const markdown = buildMarkdown([{ type: 'table', rows: [
      { isHeader: true, cells: [{ paragraphs: [[cellText('x')]] }] },
      { isHeader: false, cells: [{ paragraphs: [[cellText('a', [], { highlight: true }), cellText('\\\n'), cellText('b')]] }] },
      { isHeader: true, cells: [{ paragraphs: [[cellText('y')]] }] },
    ] }] as unknown as ContentItem[], new Map(), widths);
    expect(markdown).toStartWith('<table>');
    expect(markdown).toContain('    <th>\n      <p>y</p>\n    </th>');
  });

  test('keeps a table\'s header row after a body row the one header row, from Word and from Markdown', async () => {
    // Export marked the first row as the header's look, which import read
    // as a header row, so the body row before the header became one
    const cell = (text: string) => '<w:tc><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:tc>';
    const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>'
      + '<w:tr>' + cell('a') + '</w:tr><w:tr><w:trPr><w:tblHeader/></w:trPr>' + cell('x') + '</w:tr><w:tr>' + cell('b') + '</w:tr></w:tbl></w:body></w:document>';
    const markdown = strip((await convertDocx(await buildSyntheticDocx(xml))).markdown);
    expect(markdown).toBe('<table>\n  <tr>\n    <td>\n      <p>a</p>\n    </td>\n  </tr>\n  <tr>\n    <th>\n      <p>x</p>\n    </th>\n  </tr>\n'
      + '  <tr>\n    <td>\n      <p>b</p>\n    </td>\n  </tr>\n</table>');
    const docx = (await convertMdToDocx(markdown)).docx;
    const exported = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(strip((await convertDocx(docx)).markdown)).toBe(markdown);
    // Word repeats only leading header rows, but keeps a later one's tblHeader
    expect(exported.split('<w:tr>').slice(1).map(row => row.includes('<w:tblHeader/>'))).toEqual([false, true, false]);
    expect(exported).not.toContain('w:firstRow');
  });

  test.each([
    ['a pipe table', {}],
    ['a grid table', { pipeTableMaxLineWidth: 5 }],
    ['a grid table, with a line width of 0, though a cell has a highlight', noWidth],
  ])('escapes a cell\'s text that would be an HTML block in %s, whose cells read inline', async (_name, widths) => {
    // Its text, as it starts the cell, went as it was, as an HTML block's
    // would, and export read the cell's *b* as italic
    const markdown = buildMarkdown([{ type: 'table', rows: [
      { isHeader: true, cells: [{ paragraphs: [[cellText('x')]] }, { paragraphs: [[cellText('y')]] }] },
      { isHeader: false, cells: [{ paragraphs: [[cellText('h', [], { highlight: true })]] }, { paragraphs: [[cellText('<div>a*b*</div>')]] }] },
    ] }] as unknown as ContentItem[], new Map(), widths);
    expect(markdown).toContain('\\<div>a\\*b\\*</div>');
    expect(strip((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).trimEnd()).toBe(markdown);
  });

  test('keeps a table with a cell of paragraphs HTML, with a line width of 0, though another cell has a highlight', async () => {
    // A grid table, which holds the highlight, wrote the paragraphs as
    // lines, which export read as one paragraph with line breaks
    const widths = '---\npipe-table-max-line-width: 0\ngrid-table-max-line-width: 0\n---\n\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(widths + '| h | x |\n| --- | --- |\n| ==a== | XX |')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const two = xml.replace('<w:r><w:t>XX</w:t></w:r></w:p>', '<w:r><w:t>b</w:t></w:r></w:p><w:p><w:r><w:t>c</w:t></w:r></w:p>');
    expect(two).not.toBe(xml);
    zip.file('word/document.xml', two);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toStartWith('<table>');
    expect(markdown).toContain('      <p>b</p>\n      <p>c</p>');
  });

  // The Markdown of a table of one cell, XX, as Word edited it to end with
  // `edited`: Word's own, with no format stored, or a grid table export wrote
  const wordCell = async (md: string | undefined, edited: string) => {
    const docx = md !== undefined ? (await convertMdToDocx(md)).docx
      : await buildSyntheticDocx(wrapDocumentXml('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>XX</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'));
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const cell = xml.replace('<w:r><w:t>XX</w:t></w:r></w:p>', edited);
    expect(cell).not.toBe(xml);
    zip.file('word/document.xml', cell);
    return strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };
  // The cell export writes at index `n`, the first by default, and its
  // paragraphs' text, a line break's as \n and a tab's as \t
  const exportedCell = async (md: string, n = 0) => {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    const cell = xml.split('<w:tc>')[n + 1].split('</w:tc>')[0];
    return { cell, paragraphs: cell.split(/<w:p[ >]/).slice(1).map(p => [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:br\/>|<w:tab\/>/g)]
      .map(m => m[1] ?? (m[0] === '<w:tab/>' ? '\t' : '\n')).join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')) };
  };
  const sources = [['Word\'s own table', undefined], ['a grid table', '+-----+\n| XX  |\n+-----+']] as const;

  test.each(sources)('keeps a cell of two paragraphs of %s as HTML, which keeps them', async (_name, md) => {
    // A grid table wrote them as lines of its cell, which export read as one
    // paragraph with a line break
    const markdown = await wordCell(md, '<w:r><w:t>a</w:t></w:r></w:p><w:p><w:r><w:t>b</w:t></w:r></w:p>');
    expect(markdown).toBe('<table>\n  <tr>\n    <td>\n      <p>a</p>\n      <p>b</p>\n    </td>\n  </tr>\n</table>');
    expect((await exportedCell(markdown)).paragraphs).toEqual(['a', 'b']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each(sources)('keeps a cell of %s with a line break as lines of a grid table', async (_name, md) => {
    const markdown = await wordCell(md, '<w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r></w:p>');
    expect(markdown).toBe('+-----+\n| a   |\n| b   |\n+-----+');
    expect((await exportedCell(markdown)).paragraphs).toEqual(['a\nb']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps == in each of a cell\'s two paragraphs as text', async () => {
    // Neither paragraph's == closed in it, so import wrote them as they were,
    // but export read the grid table cell's lines as one, where they did
    const markdown = await wordCell(undefined, '<w:r><w:t>a==b</w:t></w:r></w:p><w:p><w:r><w:t>c==d</w:t></w:r></w:p>');
    const { cell, paragraphs } = await exportedCell(markdown);
    expect(paragraphs).toEqual(['a==b', 'c==d']);
    expect(cell).not.toContain('<w:highlight');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a cell of two paragraphs, one with a tracked change, HTML, which shows the change as text', async () => {
    // A grid table holds the change, but not the paragraphs, and HTML the
    // paragraphs, but not the change
    const markdown = await wordCell(undefined, '<w:r><w:t>a</w:t></w:r></w:p><w:p><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>b</w:t></w:r></w:ins></w:p>');
    expect(markdown).toBe('<table>\n  <tr>\n    <td>\n      <p>a</p>\n      <p>{++b++}</p>\n    </td>\n  </tr>\n</table>');
    const { cell, paragraphs } = await exportedCell(markdown);
    expect(paragraphs).toEqual(['a', '{++b++}']);
    expect(cell).not.toContain('<w:ins');
  });

  // A table only HTML holds, whose cell, which HTML can't hold, has `items`
  const htmlOnlyTables: Array<[string, (items: ContentItem[]) => ContentItem[]]> = [
    ['a cell of paragraphs', items => [{ type: 'table', rows: [
      { isHeader: false, cells: [{ paragraphs: [items, [cellText('c')]] }] },
    ] }] as unknown as ContentItem[]],
    ['merged cells', items => [{ type: 'table', rows: [
      { isHeader: false, cells: [{ paragraphs: [[cellText('m')]], colspan: 2 }] },
      { isHeader: false, cells: [{ paragraphs: [items] }, { paragraphs: [[cellText('c')]] }] },
    ] }] as unknown as ContentItem[]],
  ];

  test.each(htmlOnlyTables)('writes a comment with a blank line in a cell of a table with %s without it', async (_name, table) => {
    // The blank line ended the table's HTML block, and export read the rest
    // of the table as text
    const markdown = buildMarkdown(table([cellText('a '), { type: 'html_comment', text: '<!-- x\n\ny -->', commentIds: new Set() }, cellText(' b')]), new Map());
    expect(markdown).toContain('      <p>a <!-- x\ny -->&#32;b</p>');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each(htmlOnlyTables)('escapes an equation in a cell of a table with %s, which exports it as text', async (_name, table) => {
    // Export read its <b> as a tag, which dropped the b and made the text
    // after it bold
    const markdown = buildMarkdown(table([cellText('p '), { type: 'math', latex: 'a<b>c', display: false, commentIds: new Set() }, cellText(' q')]), new Map());
    expect(markdown).toContain('      <p>p $a&lt;b&gt;c$ q</p>');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('writes a display equation of lines in a cell of a table only HTML holds with line breaks', async () => {
    // HTML read its line ends as spaces, and the blank line ended the table
    const markdown = buildMarkdown(htmlOnlyTables[0][1]([{ type: 'math', latex: 'a \\\\\n\nb', display: true, inParagraph: true, commentIds: new Set() } as ContentItem]), new Map());
    expect(markdown).toContain('      <p>' + '$'.repeat(2) + '<br>a \\\\<br><br>b<br>' + '$'.repeat(2) + '</p>');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  // A table whose cell of runs `cell` is merged across two columns, which
  // only HTML holds, as import writes it
  const mergedCell = (cell: ContentItem[], comments = new Map<string, { author: string; text: string; date: string }>(), options: Parameters<typeof buildMarkdown>[2] = {}) => buildMarkdown([{ type: 'table', rows: [
    { isHeader: true, cells: [{ paragraphs: [[cellText('h')]], colspan: 2 }] },
    { isHeader: false, cells: [{ paragraphs: [cell], colspan: 2 }] },
  ] }] as unknown as ContentItem[], comments, options);

  test.each([
    ['its {>> and <<}', 'c', 'c'],
    ['a tag in its body', 'x<b>y', 'x&lt;b&gt;y'],
    ['a reference in its body', 'x &amp; y', 'x &amp;amp; y'],
    ['a tab in its body', 'x\ty', 'x&#9;y'],
  ])('writes a comment in a merged cell as the text it exports as, with %s', async (_name, body, html) => {
    // Export read a tag in its body as one, as a <b> that made the rest of
    // the cell bold, and the next import wrote the >> and << it read as
    // text as references
    const markdown = mergedCell([cellText('a '), cellText('b', ['0'])], new Map([['0', { author: 'A', text: body, date: '' }]]));
    expect(markdown).toContain('<p>a {==b==}{>>@A | ' + html + '<<}</p>');
    const { cell, paragraphs } = await exportedCell(markdown, 1);
    expect(cell).not.toContain('<w:b/>');
    expect(paragraphs).toEqual(['a {==b==}{>>@A | ' + body + '<<}']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('writes the body of a comment over an HTML comment in a merged cell as the text it exports as', async () => {
    // Export read the tag in it as one
    const comment = { type: 'html_comment', text: '<!-- x -->', commentIds: new Set(['0']) } as ContentItem;
    const markdown = mergedCell([cellText('a '), comment], new Map([['0', { author: 'A', text: 'y<b>z', date: '' }]]));
    expect(markdown).toContain('<p>a <!-- x -->{>>@A | y&lt;b&gt;z<<}</p>');
    const { cell, paragraphs } = await exportedCell(markdown, 1);
    expect(cell).not.toContain('<w:b/>');
    expect(paragraphs[0]).toEndWith('{>>@A | y<b>z<<}');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('puts no second space before a citation after a comment in a merged cell', async () => {
    // The separator reads past the comment, whose <<} stays as it is, to
    // the space in its range
    const citation = { type: 'citation', text: '(Smith 2020)', commentIds: new Set(), pandocKeys: ['@smith2020'] } as unknown as ContentItem;
    const markdown = mergedCell([cellText('a '), cellText('b ', ['0']), citation], new Map([['0', { author: 'A', text: 'c', date: '' }]]));
    expect(markdown).toContain('<p>a {==b ==}{>>@A | c<<}[@smith2020]</p>');
    const { cell, paragraphs } = await exportedCell(markdown, 1);
    expect(cell).not.toContain('<w:b/>');
    expect(paragraphs).toEqual(['a {==b ==}{>>@A | c<<}[@smith2020]']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  const deleted: RevisionInfo = { type: 'deletion', author: 'A', date: '2024-01-01T00:00:00Z' };
  const inserted: RevisionInfo = { type: 'addition', author: 'A', date: '2024-01-01T00:00:00Z' };
  const linked = (item: ContentItem) => ({ ...item, href: 'https://e.com' }) as ContentItem;

  test.each([
    ['', [cellText('b', [], {}, deleted), cellText('c', [], {}, inserted)], '{~~b~>c~~}', '{~~b~>c~~}'],
    [' of runs', [cellText('b', [], {}, deleted), cellText('x', [], { italic: true }, deleted), cellText('c', [], {}, inserted)], '{~~b<i>x</i>~>c~~}', '{~~bx~>c~~}'],
    [' in a link', [linked(cellText('l')), linked(cellText('m', [], {}, deleted)), linked(cellText('n', [], {}, inserted))], '<a href="https://e.com">l{~~m~>n~~}</a>', 'l{~~m~>n~~}'],
  ])('writes a substitution%s in a merged cell as the text it exports as', async (_name, runs, html, text) => {
    // The next import wrote the > of its ~>, which export read as text, as
    // a reference
    const markdown = mergedCell([cellText('a '), ...runs]);
    expect(markdown).toContain('<p>a ' + html + '</p>');
    const { cell, paragraphs } = await exportedCell(markdown, 1);
    expect(cell).not.toContain('<w:b/>');
    expect(paragraphs).toEqual(['a ' + text]);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('puts no second space before a citation after a substitution in a merged cell', async () => {
    // The separator reads the space the deletion ends with, before the ~>,
    // which stays as it is
    const citation = { type: 'citation', text: '(Smith 2020)', commentIds: new Set(), pandocKeys: ['@smith2020'] } as unknown as ContentItem;
    const markdown = mergedCell([cellText('a '), cellText('b ', [], {}, deleted), cellText('c', [], {}, inserted), citation]);
    expect(markdown).toContain('<p>a {~~b ~>c~~}[@smith2020]</p>');
    const { cell, paragraphs } = await exportedCell(markdown, 1);
    expect(cell).not.toContain('<w:b/>');
    expect(paragraphs).toEqual(['a {~~b ~>c~~}[@smith2020]']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  const citationItem = (keys: string[], extra: object = {}) =>
    ({ type: 'citation', text: '(Smith 2020)', commentIds: new Set(), pandocKeys: keys, ...extra }) as unknown as ContentItem;
  const imageItem = (extra: object = {}) =>
    ({ type: 'image', rId: 'rId9', src: 'media/a.png', alt: 'x<b>y & z', widthPx: 0, heightPx: 0, commentIds: new Set(), ...extra }) as ContentItem;

  test.each([
    ['a citation', [citationItem(['@smith2020, p. <b>3 & 4'])], {},
      '[@smith2020, p. &lt;b&gt;3 &amp; 4]', '[@smith2020, p. <b>3 & 4]'],
    ['a citation in a comment\'s range', [citationItem(['@smith2020, p. <b>3'], { commentIds: new Set(['0']) })], {},
      '{==[@smith2020, p. &lt;b&gt;3]==}{>>@A | c<<}', '{==[@smith2020, p. <b>3]==}{>>@A | c<<}'],
    ['a highlighted citation', [citationItem(['@smith2020, p. <b>3'], { formatting: { ...DEFAULT_FORMATTING, highlight: true } })], {},
      '==[@smith2020, p. &lt;b&gt;3]==', '==[@smith2020, p. <b>3]=='],
    ['a substitution of citations', [citationItem(['@smith2020, p. <b>3'], { revision: deleted }), citationItem(['@jones2021'], { revision: inserted })], {},
      '{~~[@smith2020, p. &lt;b&gt;3]~>[@jones2021]~~}', '{~~[@smith2020, p. <b>3]~>[@jones2021]~~}'],
    ['an image', [imageItem()], {},
      '![x&lt;b&gt;y &amp; z](media/a.png)', '![x<b>y & z](media/a.png)'],
    ['an image from an <img>', [imageItem()], { imageFormatMapping: new Map([['rId9', 'html']]) },
      '&lt;img src="media/a.png" alt="x&amp;lt;b&amp;gt;y &amp;amp; z"&gt;', '<img src="media/a.png" alt="x&lt;b&gt;y &amp; z">'],
    ['an image export couldn\'t embed', [imageItem({ markdown: '![x<b>y](missing.png)' })], {},
      '![x&lt;b&gt;y](missing.png)', '![x<b>y](missing.png)'],
  ])('writes %s in a merged cell as the text it exports as', async (_name, items, options, html, text) => {
    // Export read a tag in its keys or alt text as one, as a <b> that made
    // the rest of the cell bold, or an <img> as one, which a cell drops, and
    // a reference as its character, which the next import wrote as one
    const markdown = mergedCell([cellText('a '), ...items], new Map([['0', { author: 'A', text: 'c', date: '' }]]), options);
    expect(markdown).toContain('<p>a ' + html + '</p>');
    const { cell, paragraphs } = await exportedCell(markdown, 1);
    expect(cell).not.toContain('<w:b/>');
    expect(paragraphs).toEqual(['a ' + text]);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('writes a comment and a substitution in a merged cell with delimiters the editor reads', async () => {
    // Their > and < as references, which export reads as text as it does
    // them as they are, hid the comment and the substitution's sides from
    // the editor and navigation
    const markdown = mergedCell([cellText('a '), cellText('b', [], {}, deleted), cellText('c', [], {}, inserted), cellText('d', ['0'])], new Map([['0', { author: 'A', text: 'x<b>y', date: '' }]]));
    expect(markdown).toContain('<p>a {~~b~>c~~}{==d==}{>>@A | x&lt;b&gt;y<<}</p>');
    const ranges = extractAllDecorationRanges(markdown, 'yellow');
    const texts = (list: Array<{ start: number; end: number }>) => list.map(range => markdown.slice(range.start, range.end));
    expect([texts(ranges.substitutionOld), texts(ranges.substitutionNew), texts(ranges.comments)]).toEqual([['b'], ['c'], ['@A | x&lt;b&gt;y']]);
    const { cell, paragraphs } = await exportedCell(markdown, 1);
    expect(cell).not.toContain('<w:b/>');
    expect(paragraphs).toEqual(['a {~~b~>c~~}{==d==}{>>@A | x<b>y<<}']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a deleted citation whose locator has a ~> out of a substitution in a merged cell', async () => {
    // The next import wrote its > as a reference, as it does text's there,
    // so the Markdown changed; its ~> keeps the citation out of a
    // substitution, whose separator's search would take it for the
    // separator's and leave the citation after it without its space
    const markdown = mergedCell([cellText('a '), citationItem(['@old, p. ~>3'], { revision: deleted }), cellText('b', [], {}, inserted), citationItem(['@new'])]);
    expect(markdown).toContain('<p>a {--[@old, p. ~>3]--}{++b++} [@new]</p>');
    const { cell, paragraphs } = await exportedCell(markdown, 1);
    expect(cell).not.toContain('<w:b/>');
    expect(paragraphs).toEqual(['a {--[@old, p. ~>3]--}{++b++} [@new]']);
    expect(await roundTrip(markdown)).toBe(markdown);
  });
});

describe('HTML around a table in its block', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  const table = (text: string, indent = '') => ['<table>', '  <tr>', '    <td>', '      <p>' + text + '</p>', '    </td>', '  </tr>', '</table>'].map(line => indent + line).join('\n');

  test.each([
    ['a div and a caption', '<div>\n<p>Table 1.</p>\n' + table('a') + '\n</div>\n'],
    ['text after it', table('a') + '\nSource: World Bank,\n2020.\n'],
    // Which import took for the marker it writes where the bibliography
    // goes, at the end
    ['a references comment after it at the end', table('a') + '\n<!-- references -->\n'],
    ['a comment and text after it', table('a') + '\n<!-- TODO: check -->\nSource.\n'],
    ['a table commented out before it', '<div><!-- ' + table('old').replace(/\n/g, ' ') + ' -->\n' + table('a') + '\n</div>\n'],
    ['HTML between two tables', table('a') + '\n<p>Between.</p>\n\n' + table('b') + '\n<p>After.</p>\n'],
    ['a div in a note', 'A[^1].\n\n[^1]: Note.\n\n    <div>\n' + table('a', '    ') + '\n    </div>\n'],
    // Whose line ends were taken for the indent
    ['an indented caption and text', '<div class="t">\n  <p>Table 1.</p>\n' + table('a') + '\n  <p>Source: X.</p>\n</div>\n'],
    ['a div on its lines', '<div>' + table('a') + '</div>\n'],
    // A block a comment or <pre> starts ends on the line of its end, so
    // the table stays on it
    ['a comment on its line', '<!-- Table 1 --><table><tr><td><p>a</p></td></tr></table>\n'],
    ['a comment with a blank line', '<!-- TODO: check\n\nthe totals --><table><tr><td><p>a</p></td></tr></table>\n'],
    ['a pre on its line', '<pre>Table 1</pre><table><tr><td><p>a</p></td></tr></table>\n'],
    // Which Word holds as an element of its own, which export didn't read
    // for the first row
    ['a caption over a first row with a non-breaking hyphen', '<p>Cap</p>\n' + table('COVID\u201119') + '\n'],
    ['a caption over a first row with an optional hyphen', '<p>Cap</p>\n' + table('hy\u00ADphen') + '\n'],
    // Which export took for a field's marker, and left out of the row
    ['a caption over a first row with a field\'s marker as text', '<p>Cap</p>\n' + table('w:fldCharType="begin" a') + '\n'],
  ])('keeps %s', async (_name, md) => {
    // Export dropped the rest of a table's block with no warning
    const { warnings } = await convertMdToDocx(md);
    expect(warnings).toContain('HTML around a table in its HTML block not shown in Word (kept in the Markdown on round-trip).');
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['in its block', table('a') + '\n# Sources\n\nAfter.\n'],
    ['in its block in a note', 'A[^1] B[^2].\n\n[^1]: Note.\n\n    <div>\n' + table('a', '    ') + '\n    Sources\n    </div>\n\n[^2]: Two.\n'],
  ])('keeps the document after a Sources line in the HTML around a table %s', async (_name, md) => {
    // Import took it for the heading of a bibliography Word held as text,
    // and dropped the rest
    expect(await roundTrip(md)).toBe(md);
  });

  test('drops a bibliography Word holds as text after its Sources heading still', async () => {
    expect(await roundTrip(table('a') + '\n\n# Sources\n\nDoe, J. 2020.\n')).toBe(table('a') + '\n');
  });

  test('keeps the HTML around a table whose first row has a line end after a backslash in its code', async () => {
    // Export found the backslash and the line end in the first row, which
    // import read as a line break, and the HTML went
    const markdown = await roundTrip('<div><p>Cap</p>\n<table><tr><td><pre><code>a\\\nb</code></pre></td></tr></table>\n</div>\n');
    expect(markdown.startsWith('<div><p>Cap</p>\n<table>')).toBe(true);
    expect(markdown.endsWith('</table>\n</div>\n')).toBe(true);
  });

  test('applies no directive in a comment on a table\'s line, as markdown-it reads it', async () => {
    // A line end import put after the comment made it the table's directive
    const md = '<!-- table-font-size: 11 --><table><tr><td><p>a</p></td></tr></table>\n';
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(await roundTrip(md))).docx)).file('word/document.xml')!.async('string');
    expect(xml.slice(xml.indexOf('<w:tbl>'))).not.toContain('<w:sz w:val="22"/>');
  });

  test('keeps a grid table\'s lines in a table\'s HTML block as the HTML after it, as a pipe table\'s', async () => {
    // The grid table split the block, and Word showed its </div> as text
    const md = '<div>\n' + table('a') + '\n+-----+\n| g   |\n+=====+\n| b   |\n+-----+\n</div>\n';
    const { docx, warnings } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:tbl>/g)?.length).toBe(1);
    expect(xml).not.toContain('&lt;/div&gt;');
    expect(warnings.some(warning => warning.startsWith('HTML around a table'))).toBe(true);
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(md);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a grid table in a comment in the comment', async () => {
    // Its placeholder went in the comment, and import wrote it as text
    const md = '<!--\n+---+\n| a |\n+---+\n-->\n\nText.\n';
    const markdown = await roundTrip(md);
    expect(markdown).toBe(md);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('puts the HTML around a table back with the same table after Word deletes one before it', async () => {
    // Another took the deleted table's, as the tables' indices shifted
    const md = '<div>\n<p>Table 1.</p>\n<table><tr><td>A</td></tr></table>\n</div>\n\nText.\n\n<div>\n<p>Table 2.</p>\n<table><tr><td>B</td></tr></table>\n</div>\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, ''));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('Text.\n\n<div>\n<p>Table 2.</p>\n' + table('B') + '\n</div>\n');
  });

  test.each([
    ['deletes a grid table before it', '+---+\n| P |\n+===+\n| p |\n+---+\n\n', (xml: string) => xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, ''), ''],
    ['adds a table before it', '', (xml: string) => xml.replace('<w:tbl>', '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>New</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/><w:tbl>'), '+-----+\n| New |\n+-----+\n\n'],
  ])('keeps a table HTML with the HTML around it on its lines where Word %s', async (_name, other, edit, added) => {
    // It took the format export wrote at its index, another table's, and
    // the HTML went around it as blocks, which the next export showed as text
    const md = '<div>\n<p>Cap</p>\n' + table('A') + '\n</div>\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(other + md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', edit(xml));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(added + md);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('puts the HTML around a table back with the same table after Word deletes one before it with the same first row', async () => {
    // The first row matched the deleted table's, which took the index
    const md = '<p>Cap A</p>\n<table><tr><td>H</td></tr><tr><td>a</td></tr></table>\n\n<p>Cap B</p>\n<table><tr><td>H</td></tr><tr><td>b</td></tr></table>\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, ''));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('<p>Cap B</p>\n<table>\n  <tr>\n    <td>\n      <p>H</p>\n    </td>\n  </tr>\n  <tr>\n    <td>\n      <p>b</p>\n    </td>\n  </tr>\n</table>\n');
  });

  test.each([
    ['the first to be alike the second', 'a', 'b'],
    ['the second to be alike the first', 'b', 'a'],
  ])('keeps the HTML around each of two tables with the same first row after Word edits %s', async (_name, from, to) => {
    // The edited one took the HTML of the one it was now alike, and that
    // one none
    const md = '<p>Cap A</p>\n<table><tr><td>H</td></tr><tr><td>a</td></tr></table>\n\n<p>Cap B</p>\n<table><tr><td>H</td></tr><tr><td>b</td></tr></table>\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace('<w:t>' + from + '</w:t>', '<w:t>' + to + '</w:t>');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    const table = (text: string) => '<table>\n  <tr>\n    <td>\n      <p>H</p>\n    </td>\n  </tr>\n  <tr>\n    <td>\n      <p>' + text + '</p>\n    </td>\n  </tr>\n</table>\n';
    expect(markdown).toBe('<p>Cap A</p>\n' + table(from === 'a' ? 'b' : 'a') + '\n<p>Cap B</p>\n' + table(from === 'a' ? 'b' : 'a'));
  });

  test('keeps the HTML around a table off one without any that Word edits to be alike it', async () => {
    // The edited one, first, took the HTML, which the other then lacked
    const md = '<table><tr><td>H</td></tr><tr><td>a</td></tr></table>\n\n<p>Cap B</p>\n<table><tr><td>H</td></tr><tr><td>b</td></tr></table>\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace('<w:t>a</w:t>', '<w:t>b</w:t>');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown.indexOf('<p>Cap B</p>')).toBeGreaterThan(markdown.indexOf('</table>'));
  });

  test('puts the HTML around a table back with the same table after Word deletes one before it, with one alike it after it without any', async () => {
    // Import counted the tables alike export wrote only as far as the one
    // with HTML around it, took the second for one Word made, and gave it
    // the HTML at its index
    const md = table('X') + '\n\n<p>Cap A</p>\n' + table('A') + '\n\n' + table('A') + '\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, ''));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('<p>Cap A</p>\n' + table('A') + '\n\n' + table('A') + '\n');
  });

  test.each([
    ['other HTML', '<p>Cap A</p>\n', '<p>Cap B</p>\n', table('A') + '\n'],
    ['the same HTML', '<p>Cap</p>\n', '<p>Cap</p>\n', '<p>Cap</p>\n' + table('A') + '\n'],
  ])('gives the table Word leaves of two alike with %s around each the HTML only where it was the same', async (_name, first, second, expected) => {
    // Which Word deleted is unknown, and the one left took the first's
    const md = first + table('A') + '\n\n' + second + table('A') + '\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, ''));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(expected);
  });

  test('puts no HTML around a table after Word deletes one before it whose first row\'s text is alike, cut apart elsewhere', async () => {
    // Both first rows read as 2:A|B|C, and the table at the deleted one's
    // index took its caption
    const second = '<table>\n  <tr>\n    <td>\n      <p>A</p>\n    </td>\n    <td>\n      <p>B|C</p>\n    </td>\n  </tr>\n</table>\n';
    const md = '<div>\n<p>Table 1.</p>\n<table><tr><td>A|B</td><td>C</td></tr></table>\n</div>\n\nText.\n\n' + second;
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, ''));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('Text.\n\n' + second);
  });

  test.each([
    ['on the next line', table('a') + '\n' + table('b') + '\n'],
    ['in a div', '<div>\n' + table('a') + '\n' + table('b') + '\n</div>\n'],
    ['with HTML between', '<div>\n<p>A</p>\n' + table('a') + '\n<p>B</p>\n' + table('b') + '\n<p>C</p>\n</div>\n'],
    ['with a comment between', table('a') + '\n<!-- c -->\n' + table('b') + '\n'],
    ['on the line of text after it', table('a') + ' x ' + table('b') + '\n'],
    ['after spaces at its line\'s end', table('a') + '  \n' + table('b') + '\n'],
    ['of three', table('a') + '\n' + table('b') + '\n' + table('c') + '\n'],
    ['in a note', 'A[^1].\n\n[^1]: Note.\n\n    <div>\n' + table('a', '    ') + '\n' + table('b', '    ') + '\n    </div>\n'],
  ])('keeps a table after another in their HTML block %s', async (_name, md) => {
    // A blank line went before it, which split the block in two
    expect(await roundTrip(md)).toBe(md);
  });

  test('warns of no HTML around tables in one block with none but the line end between them', async () => {
    const { warnings } = await convertMdToDocx(table('a') + '\n' + table('b') + '\n');
    expect(warnings.some(w => w.startsWith('HTML around a table'))).toBe(false);
  });

  test('writes a table after another in their HTML block as a block of its own where Word puts a paragraph between them', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('<div>\n' + table('a') + '\n<p>B</p>\n' + table('b') + '\n</div>\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    // The paragraph export writes between the tables, with text in it
    const between = xml.replace(/<\/w:tbl><w:p\b[^>]*\/><w:tbl>/, '</w:tbl><w:p><w:r><w:t>Mid</w:t></w:r></w:p><w:tbl>');
    expect(between).not.toBe(xml);
    zip.file('word/document.xml', between);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('<div>\n' + table('a') + '\n<p>B</p>\n\nMid\n\n' + table('b') + '\n</div>\n');
  });

  test('writes a table after another on the line of a comment that starts their block as a block of its own', async () => {
    // The block ends on the comment's line, so the rest of the table there
    // would be text after it
    const md = '<!-- c --><table><tr><td><p>a</p></td></tr></table> <table><tr><td><p>b</p></td></tr></table>\n';
    const markdown = await roundTrip(md);
    expect(markdown).toBe('<!-- c --><table><tr><td><p>a</p></td></tr></table>\n\n' + table('b') + '\n');
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:tbl>/g)).toHaveLength(2);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps the HTML around tables alike in all their text in order', async () => {
    const md = '<p>Cap A</p>\n' + table('a') + '\n\n<p>Cap B</p>\n' + table('a') + '\n';
    expect(await roundTrip(md)).toBe(md);
  });

  test('keeps the HTML around a table whose first row is shorter than another, which Word pads', async () => {
    // Its first row was the source's, not the padded one import reads
    const markdown = await roundTrip('<p>Cap</p>\n<table><tr><td>A</td></tr><tr><td>b</td><td>c</td></tr></table>\n');
    expect(markdown.startsWith('<p>Cap</p>\n<table>')).toBe(true);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a table on the line of a comment before it where Word adds a line end in a cell\'s comment', async () => {
    // The line end ended the block, and the next export cut the table there
    const zip = await JSZip.loadAsync((await convertMdToDocx('<!-- Caption --><table><tr><td>a<!-- x y -->b</td></tr></table>\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const broken = xml.replace('&lt;!-- x y --&gt;', '&lt;!-- x</w:t><w:br/><w:t xml:space="preserve">y --&gt;');
    expect(broken).not.toBe(xml);
    zip.file('word/document.xml', broken);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    const again = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    const texts = [...(await again.file('word/document.xml')!.async('string')).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]);
    expect(texts).toEqual(['\u200B&lt;!-- Caption --&gt;', 'a', '\u200B&lt;!-- x', 'y --&gt;', 'b']);
  });

  test('drops a comment that would read as a directive before a table on its line where Word adds a line end in a cell\'s comment', async () => {
    // It went on a line of its own, where it read as the table's directive
    const zip = await JSZip.loadAsync((await convertMdToDocx('<!-- table-font-size: 11 --><table><tr><td>a<!-- x y -->b</td></tr></table>\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const broken = xml.replace('&lt;!-- x y --&gt;', '&lt;!-- x</w:t><w:br/><w:t xml:space="preserve">y --&gt;');
    expect(broken).not.toBe(xml);
    zip.file('word/document.xml', broken);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('<table><tr><td><p>a<!-- x\ny -->b</p></td></tr></table>\n');
    const again = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(again.slice(again.indexOf('<w:tbl>'))).not.toContain('<w:sz w:val="22"/>');
  });

  test.each([
    ['around it', '<pre>Caption<table><tr><td>a<!-- x y -->b</td></tr></table></pre>\n', '<pre>Caption<table><tr><td><p>a<!-- x\ny -->b</p></td></tr></table></pre>\n'],
    ['with text after the table', '<pre>Caption\n<table><tr><td>a<!-- x y -->b</td></tr></table>\nNote</pre>\n', '<pre>Caption\n<table><tr><td><p>a<!-- x\ny -->b</p></td></tr></table>\nNote</pre>\n'],
  ])('keeps a <pre> %s where Word adds a line end in a cell\'s comment', async (_name, md, expected) => {
    // The line end doesn't end the <pre>'s block, but its start went, as
    // for a block that ends before the table, and its end stayed
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const broken = xml.replace('&lt;!-- x y --&gt;', '&lt;!-- x</w:t><w:br/><w:t xml:space="preserve">y --&gt;');
    expect(broken).not.toBe(xml);
    zip.file('word/document.xml', broken);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['a <pre> on a line of its own', '<pre>Caption\n<table><tr><td><pre><code>x</code></pre></td></tr></table>\n'],
    ['a <pre> on the table\'s line', '<pre>Caption<table><tr><td><pre><code>x</code></pre></td></tr></table>\n'],
    ['a processing instruction', '<?x a><table><tr><td>b?>c</td></tr></table>\n'],
    ['a CDATA section', '<![CDATA[ a ]]x><table><tr><td>b]]>c</td></tr></table>\n'],
  ])('drops %s before a table whose block a cell ended, which import writes otherwise', async (_name, md) => {
    // The end went as the cell was written, and the block went on over the
    // text after it, which Word then didn't show
    const markdown = await roundTrip(md + '\nAfter.\n');
    expect(markdown.startsWith('<table>')).toBe(true);
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('>After.</w:t>');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('writes a table in Word whose block a comment starts and ends', async () => {
    // The block read as a comment, which hid the table, as import writes
    // the first of two tables on a line with a comment before each
    const md = '<!-- a --><table><tr><td>A</td></tr></table><!-- b --><table><tr><td>B</td></tr></table>\n';
    const markdown = await roundTrip(md);
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:tbl>/g)).toHaveLength(2);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a table whose rows are all commented out as HTML around a table beside it', async () => {
    const md = '<table><!-- <tr><td>old</td></tr> --></table>\n' + table('a') + '\n';
    expect(await roundTrip(md)).toBe(md);
  });

  test('writes no comment that would be a directive around a table that leaves HTML', async () => {
    // A tracked change made a pipe table, and the comment on the table's
    // line a block of its own, which set the table's font size
    const zip = await JSZip.loadAsync((await convertMdToDocx('<!-- table-font-size: 11 --><table><tr><td>XX</td><td>b</td></tr></table>\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('+----------+-----+\n| {++XX++} | b   |\n+----------+-----+\n');
  });

  test('keeps the HTML around a table off a table before it with the same first row and none', async () => {
    // The first table took the second's, as no other had its first row
    const md = table('H') + '\n\n<p>Cap B</p>\n' + table('H').replace('</table>', '<tr><td><p>b</p></td></tr></table>');
    const markdown = await roundTrip(md + '\n');
    expect(markdown.startsWith(table('H') + '\n\n<p>Cap B</p>\n<table>')).toBe(true);
  });

  test.each([
    ['in a div with a caption and text', '<div>\n<p>Cap</p>\n<table>\n<!-- <tr><td>old</td></tr> -->\n</table>\n<p>Source</p>\n</div>\n'],
    ['with a comment that reads as a directive, before a table', '<table><!-- table-font-size: 40 --></table>\n' + table('a') + '\n'],
  ])('keeps a table whose rows are all commented out %s', async (_name, md) => {
    // Its comments alone came back, and one set the next table's font size
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).not.toContain('<w:sz w:val="80"/>');
    expect(await roundTrip(md)).toBe(md);
  });

  test('writes no line of a comment that would be a directive in the HTML around a table that leaves HTML', async () => {
    // A block of its own, it styled the text after it
    const zip = await JSZip.loadAsync((await convertMdToDocx('<table><tr><td>XX</td><td>b</td></tr></table>\n<!-- style: Title -->\nSource\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('+----------+-----+\n| {++XX++} | b   |\n+----------+-----+\n\nSource\n');
  });

  test('keeps the HTML around a table off one alike in all its text before it with none', async () => {
    // The first table took the second's, as it had the same text
    const md = table('a') + '\n\n<div><p>Cap</p>\n' + table('a') + '\n</div>\n';
    expect(await roundTrip(md)).toBe(md);
  });

  test('keeps the HTML around a table off one Word adds before it with the same first row', async () => {
    // The added table took it, at the index of the one it was written with
    const zip = await JSZip.loadAsync((await convertMdToDocx('<div><p>Cap</p>\n<table><tr><td>H</td></tr><tr><td>a</td></tr></table>\n</div>\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, tbl => tbl.replace('>a<', '>z<') + '<w:p/>' + tbl));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown.startsWith('+-----+\n| H   |\n+-----+\n| z   |\n+-----+\n\n<div>')).toBe(true);
    expect(markdown.slice(markdown.indexOf('<div>'))).toBe('<div><p>Cap</p>\n<table>\n  <tr>\n    <td>\n      <p>H</p>\n    </td>\n  </tr>\n  <tr>\n    <td>\n      <p>a</p>\n    </td>\n  </tr>\n</table>\n</div>\n');
  });

  test.each(['{++a++}', '{--a--}', '{==a==}', '{~~a~>b~~}'])('keeps the HTML around a table off a table before it with %s', async cell => {
    // Export didn't count the text of a tracked change or highlight, which
    // import does, so the table before took the HTML as the first alike
    const md = '| ' + cell + ' |\n| --- |\n\n<div><p>Cap</p>\n<table><tr><td>' + cell.replace(/[{}+=~>-]/g, '') + '</td></tr></table>\n</div>\n';
    const markdown = await roundTrip(md);
    expect(markdown.startsWith('| ')).toBe(true);
    expect(markdown).toContain('\n\n<div><p>Cap</p>\n<table>');
  });

  test('keeps the HTML around a table off a table before it with a citation it has no entry for', async () => {
    // Export didn't count the citation's text, which Word shows, and import
    // reads, so the table before took the HTML as the first alike
    const md = '| [@missing] |\n| --- |\n\n<div><p>Cap</p>\n<table><tr><td>[@missing]</td></tr></table>\n</div>\n';
    const markdown = await roundTrip(md);
    expect(markdown.startsWith('| ')).toBe(true);
    expect(markdown).toContain('\n\n<div><p>Cap</p>\n<table>');
  });

  test('keeps the HTML around a table in a note off one alike in a note defined after it', async () => {
    // Export counted the notes' tables in the order they're defined, and
    // import in the order of their labels, so the first note's took it
    const md = 'A[^1] B[^2].\n\n[^2]: Two.\n\n    <div>\n' + table('a', '    ') + '\n    </div>\n\n[^1]: One.\n\n' + table('a', '    ') + '\n';
    const markdown = await roundTrip(md);
    expect(markdown).toContain('[^1]: One.\n\n    <table>');
    expect(markdown).toContain('[^2]: Two.\n\n    <div>\n' + table('a', '    ') + '\n    </div>');
  });

  test('keeps the HTML around a table Word edits, alike an embedded table, at its index', async () => {
    // The embedded table, which export doesn't count, kept it from the table
    const resolver = { readFile: () => new TextEncoder().encode('H\na\n'), resolveRelative: (_base: string, relative: string) => relative };
    const md = '<!-- embed: t.csv headers=1 -->\n\n<div><p>Cap</p>\n<table><tr><th>H</th></tr><tr><td>a</td></tr></table>\n</div>\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md, { embedResolver: resolver, documentPath: '/doc/paper.md' })).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const last = xml.lastIndexOf('<w:tbl>');
    zip.file('word/document.xml', xml.slice(0, last) + xml.slice(last).replace('>a<', '>z<'));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toContain('<div><p>Cap</p>\n<table>');
    expect(markdown).toContain('<p>z</p>');
  });

  test.each([
    ['its own', '<div><p>Cap</p>\n<table><tr><td>a</td></tr></table>\n</div>\n', '<div><p>Cap</p>\n<table>\n  <tr>\n    <td>\n      <p>a</p>\n    </td>\n  </tr>\n</table>\n</div>\n'],
    ['none', '<table><tr><td>a</td></tr></table>\n', table('a') + '\n'],
  ])('gives a table alike an embedded one with HTML around it %s', async (_name, after, expected) => {
    // Export kept the embedded table's HTML, which import, writing its
    // embed directive, left for the table alike it
    const resolver = { readFile: () => new TextEncoder().encode('<table><tr><td>a</td></tr></table><p>Embedded note</p>\n'), resolveRelative: (_base: string, relative: string) => relative };
    const md = '<!-- embed: t.md -->\n\n' + after;
    const { docx } = await convertMdToDocx(md, { embedResolver: resolver, documentPath: '/doc/paper.md' });
    expect(strip((await convertDocx(docx)).markdown)).toBe('<!-- embed: t.md -->\n\n' + expected);
  });

  test('keeps the HTML around a table off one Word adds before it with its text in other cells', async () => {
    // Each table's text without its empty cells was the same
    const first = (md: string) => convertMdToDocx(md).then(({ docx }) => JSZip.loadAsync(docx));
    const zip = await first('<div><p>Cap</p>\n<table><tr><th>H</th><th>I</th></tr><tr><td>a</td><td></td></tr></table>\n</div>\n');
    const added = await (await first('<table><tr><th>H</th><th>I</th></tr><tr><td></td><td>a</td></tr></table>\n')).file('word/document.xml')!.async('string');
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('<w:tbl>', /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(added)![0] + '<w:p/><w:tbl>'));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown.startsWith('| H | I |\n| --- | --- |\n| | a |\n\n<div>')).toBe(true);
    expect(markdown.slice(markdown.indexOf('<div>'))).toBe('<div><p>Cap</p>\n<table>\n  <tr>\n    <th>\n      <p>H</p>\n    </th>\n    <th>\n      <p>I</p>\n    </th>\n  </tr>\n  <tr>\n    <td>\n      <p>a</p>\n    </td>\n    <td>\n      <p></p>\n    </td>\n  </tr>\n</table>\n</div>\n');
  });

  test('keeps the HTML around a table with a cell over two rows', async () => {
    const md = '<div><p>Cap</p>\n<table><tr><td rowspan="2">A</td><td>b</td></tr><tr><td>c</td></tr></table>\n</div>\n';
    const markdown = await roundTrip(md);
    expect(markdown.startsWith('<div><p>Cap</p>\n<table>')).toBe(true);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps the HTML around a table Word edits, at its index', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('<div><p>Cap</p>\n<table><tr><td>H</td></tr><tr><td>a</td></tr></table>\n</div>\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('>a<', '>z<'));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown.startsWith('<div><p>Cap</p>\n<table>')).toBe(true);
    expect(markdown).toContain('<p>z</p>');
  });

  test.each([
    ['comments that read as no directive', '<div>\n<!-- TODO: check -->\n', '\n<!-- Source: World Bank -->\n</div>\n',
      '<div>\n<!-- TODO: check -->\n\n', '\n\n<!-- Source: World Bank -->\n</div>\n'],
    ['text that would read as Markdown', '<div>\n', '\n# Source\n{++Source++} *x* [^1]\n</div>\n',
      '<div>\n\n', '\n\n\\# Source \\{++Source+\\+} \\*x\\* \\[^1]\n</div>\n'],
    // A line of one tag doesn't start a block after text
    ['a line of one tag after text', '', '\n# Source\n<span>\n*x*\n',
      '', '\n\n\\# Source <span> \\*x\\*\n'],
    // Which export reads as no directive, but which went as one
    ['a comment that reads as no style\'s', '', '\n<!-- style -->\n', '', '\n\n<!-- style -->\n'],
    // Which went with the style's comments
    ['a style\'s text between its comments', '', '\n<!-- style: Title -->*Caption*<!-- /style -->\n', '', '\n\n\\*Caption\\*\n'],
    // Which a line of its own made an embed's, and export added its table
    ['no embed\'s comment on the table\'s line', '', '<!-- embed: t.csv -->\n', '', '\n'],
    // Which read as a citation, which export writes as a field where the
    // bibliography holds its key
    ['a citation as text', '', '\nSource [@smith2020; -@doe, p. 2] *x* [see @doe]\n', '', '\n\nSource \\[@smith2020; -@doe, p. 2] \\*x\\* \\[see @doe]\n'],
    // Which pair across one, which read as math
    ['dollar signs around a character reference', '', '\nSource $x &amp; y$ and *a <b>b</b> c*\n', '', '\n\nSource \\$x &amp; y$ and \\*a <b>b</b> c\\*\n'],
    // Which went on across its lines, and the spaces at a line's end, which
    // HTML runs together, but which made a line break
    ['a comment, dollar signs and spaces at a line\'s end across lines', '', '\nSource <!-- hidden\nsecret --> $a\nb$ and  \ncontinued\n', '',
      '\n\nSource <!-- hidden\nsecret --> \\$a b$ and continued\n'],
    // Which escaped the reference or tag after it
    ['a backslash before a character reference or a tag', '', '\nSource\\&amp; and a\\\\<b>b</b>\n', '',
      '\n\nSource\\\\&amp; and a\\\\\\\\<b>b</b>\n'],
    // Which the browser ended at a --!>, or at the end of the block, but
    // which, a block of their own, read on over the table
    ['comments the browser ends where Markdown reads no end', '<!-- cap --!>', ' <!-- open\n', '<!-- cap -->\n\n', '\n\n<!-- open -->\n'],
    // Which inline Markdown reads as no comment, and escaped
    ['a comment the browser ends after a -', '', '\nSource <!-- secret ---> rest\n', '', '\n\nSource <!-- secret - --> rest\n'],
    // Which got an end, as a comment the browser read
    ['an <!-- in an element whose text is no HTML', '', '\n<textarea>a <!-- b --!> c</textarea>\n<textarea>literal <!-- here</textarea>\n', '',
      '\n\n<textarea>a <!-- b --!> c</textarea>\n<textarea>literal <!-- here</textarea>\n'],
    // Which export reads as no directive, but which went as one
    ['comments with a value no table directive reads', '', '\nSource\n<!-- table-digits: TBD -->\n<!-- table-col-widths: TBD -->\n', '',
      '\n\nSource\n<!-- table-digits: TBD -->\n<!-- table-col-widths: TBD -->\n'],
    // Which read as the heading of a bibliography Word holds as text, which
    // import dropped with all after it
    ['a line that would read as a Sources heading', '', '\nSources\nWorld Bank\n\nAfter.\n', '', '\n\nSources World Bank\n\nAfter.\n'],
    // Whose lines a paragraph's lost their indents
    ['a <pre> that goes on past a line of text', '', '\nSource <pre>if ready:\n    run()\n</pre> done\n', '', '\n\nSource\n<pre>if ready:\n    run()\n</pre> done\n'],
    ['a <pre> on a line of text that ends on it', '', '\nSource <pre>a</pre> <b>b</b>\n', '', '\n\nSource <pre>a</pre> <b>b</b>\n'],
    // Whose spaces at the start of a line in it went, as a line's, which
    // changed where the link goes
    ['a tag whose attribute goes on over lines', '', '\nSource <a href="docs/a\n    b">link</a>\n', '', '\n\nSource <a href="docs/a\n    b">link</a>\n'],
    // Whose lines were text after the comment's block, which ended on its line
    ['a <pre> that goes on past a comment on its line', '', '\n<!-- note --><pre>if ready:\n    run()\n</pre>\n', '', '\n\n<!-- note -->\n<pre>if ready:\n    run()\n</pre>\n'],
    ['a <pre> that goes on past a directive on its line', '', '\n<!-- table-font-size: 11 --><pre>if ready:\n    run()\n</pre>\n', '', '\n\n<pre>if ready:\n    run()\n</pre>\n'],
    ['a <pre> that goes on past the end of a comment over lines', '', '\n<!-- note\nend --><pre>if ready:\n    run()\n</pre>\n', '', '\n\n<!-- note\nend -->\n<pre>if ready:\n    run()\n</pre>\n'],
    ['a <pre> on a line of text in a comment', '', '\nSource <!-- a\nb <pre> -->\nc\n', '', '\n\nSource <!-- a\nb <pre> --> c\n'],
    // Which went as one, as between blocks
    ['blank lines in a <pre>', '<pre>a\n\n\nb</pre>', '', '<pre>a\n\n\nb</pre>\n\n', '\n'],
  ])('keeps %s around a table that leaves HTML, as it read', async (_name, beforeHtml, afterHtml, beforeMd, afterMd) => {
    // A comment that reads as no directive went, as one that does, and text
    // read as Markdown, as # Source as a heading
    const zip = await JSZip.loadAsync((await convertMdToDocx(beforeHtml + '<table><tr><td>XX</td><td>b</td></tr></table>' + afterHtml)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(beforeMd + '+----------+-----+\n| {++XX++} | b   |\n+----------+-----+' + afterMd);
  });

  test.each([
    ['text', '\nSource:\n2020.\n', 'Source: 2020.'],
    ['a comment over lines', '\nSource <!-- a\nb --> x\n2020.\n', 'Source <!-- a\nb --> x 2020.'],
  ])('joins the lines of %s around a table that leaves HTML with spaces where line ends are line breaks', async (_name, afterHtml, text) => {
    // HTML read each line end as a space, which the next export made a line
    // break. A comment's are in its hidden run, as ever.
    const zip = await JSZip.loadAsync((await convertMdToDocx('---\nbreaks: true\n---\n\n<table><tr><td>XX</td><td>b</td></tr></table>' + afterHtml)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(strip(markdown).trimStart()).toBe('+----------+-----+\n| {++XX++} | b   |\n+----------+-----+\n\n' + text + '\n');
    const again = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(again.slice(again.indexOf('</w:tbl>')).replace(/<w:r><w:rPr><w:vanish\/>[\s\S]*?<\/w:r>/g, '')).not.toContain('<w:br/>');
  });

  test('keeps the end of a comment over lines that an embed\'s line ends before a table that leaves HTML', async () => {
    // The embed's line went, as export would add its table, with the
    // comment's end, and the comment went on over the table
    const zip = await JSZip.loadAsync((await convertMdToDocx('<!-- hidden\n<!-- embed: t.csv --><table><tr><td>XX</td><td>b</td></tr></table>\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('<!-- hidden\n-->\n\n+----------+-----+\n| {++XX++} | b   |\n+----------+-----+\n');
    const again = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(again.match(/<w:tbl>/g)).toHaveLength(1);
  });

  test.each([
    ['of one row', '\n    +---+---+\n    | a | b |\n    +---+---+\n', '+---+---+ | a | b | +---+---+'],
    ['with a header', '\n    +---+\n    | a |\n    +===+\n    | b |\n    +---+\n', '+---+ | a | +===+ | b | +---+'],
  ])('keeps a grid table\'s lines %s indented as code in the HTML around a table that leaves HTML as text', async (_name, afterHtml, text) => {
    // With their indents gone, they read as a table of their own, which the
    // next export added to Word
    const zip = await JSZip.loadAsync((await convertMdToDocx('<table><tr><td>XX</td><td>b</td></tr></table>' + afterHtml)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('+----------+-----+\n| {++XX++} | b   |\n+----------+-----+\n\n' + text + '\n');
    const again = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(again.match(/<w:tbl>/g)).toHaveLength(1);
  });

  test.each([
    ['a grid table\'s', '\n+---+---+\n| x | y |\n+---+---+\n\nD\n', '+---+---+ | x | y | +---+---+\n\nD\n'],
    ['text\'s', '\nSource:\nWorld Bank,\n2020.\n', 'Source: World Bank, 2020.\n'],
    ['formatting\'s', '\n*a\nb* and `c\nd`\n', '\\*a b\\* and \\`c d\\`\n'],
  ])('joins %s lines in the HTML after a table that leaves HTML, as Word does the next time', async (_name, afterHtml, text) => {
    // Word held them as one paragraph with a space at each line end, which
    // the next trip wrote on one line
    const zip = await JSZip.loadAsync((await convertMdToDocx('A\n\n<table><tr><td>XX</td><td>b</td></tr></table>' + afterHtml)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(strip(markdown)).toBe('A\n\n+----------+-----+\n| {++XX++} | b   |\n+----------+-----+\n\n' + text);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  test('keeps a <!-- references --> at the end of a table\'s HTML block, which ends it', async () => {
    // Import took it for the marker of a bibliography at the end, and the
    // block went on over the text written after it
    const markdown = await roundTrip('<!-- caption --!><table><tr><td>a</td></tr></table>\n\n<!-- references -->\n');
    expect(markdown).toBe('<!-- caption --!><table><tr><td><p>a</p></td></tr></table>\n\n<!-- references -->\n');
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown + '\nAfter.\n')).docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('>After.</w:t>');
  });

  test('drops the HTML around a table in a block with a LaTeX environment, which export wraps as math', async () => {
    // The HTML came back with the dollar signs export put around it
    const md = '<div>\n\\begin{equation}\nx\n\\end{equation}\n<table><tr><td>a</td></tr></table>\n</div>\n';
    expect((await convertMdToDocx(md)).warnings).toContain('HTML around a table in an HTML block with a LaTeX environment dropped during conversion (not supported). Move the environment out of the block for round-trip fidelity.');
    expect(await roundTrip(md)).toBe(table('a') + '\n');
  });

  test.each([
    ['in dollar signs already', '<div>\n$' + '$\\begin{equation}\nx\n\\end{equation}$' + '$\n<table><tr><td>a</td></tr></table>\n</div>\n'],
    ['in dollar signs in a comment', '<div>\n<!--\n$' + '$\\begin{equation}x\\end{equation}$' + '$\n-->\n<table><tr><td>a</td></tr></table>\n</div>\n'],
  ])('keeps the HTML around a table in a block with a LaTeX environment %s, which export leaves as it is', async (_name, md) => {
    // It went, as one export wraps, though export added nothing to it
    const { warnings } = await convertMdToDocx(md);
    expect(warnings.some(w => w.includes('LaTeX environment'))).toBe(false);
    const markdown = await roundTrip(md);
    expect(markdown).toContain('<div>');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('drops the HTML around tables a <pre> holds together in one block', async () => {
    // The <pre> before the first went on over the second where it left
    // HTML, which export then read as HTML, and its tracked change went
    const md = '<pre><table><tr><td>A</td></tr></table><table><tr><td>XX</td><td>b</td></tr></table></pre>\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toContain('HTML around tables in one <pre> or similar HTML block dropped during conversion (not supported). Give each table a block of its own for round-trip fidelity.');
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe(table('A') + '\n\n+----------+-----+\n| {++XX++} | b   |\n+----------+-----+\n');
    const again = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(again.match(/<w:tbl>/g)).toHaveLength(2);
    expect(again).toContain('<w:ins ');
  });

  test.each([
    ['as it is', 'Sources'],
    ['in a character reference', '&#83;ources'],
    ['in tags', '<span>Sources</span>'],
    ['in a style\'s comments', '<!-- style: Title -->Sources<!-- /style -->'],
    // Which the next round trip took out, as they hold nothing
    ['with empty tags on the next line', 'Sources\n<b></b>'],
  ])('drops the HTML around a table that leaves HTML where a line of it alone would read as a Sources heading %s', async (_name, line) => {
    // Word's paragraph of it read as the heading of a bibliography Word
    // holds as text on the next import, which dropped it and all after
    const zip = await JSZip.loadAsync((await convertMdToDocx('<table><tr><td>XX</td><td>b</td></tr></table>\n' + line + '\n\nAfter.\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('+----------+-----+\n| {++XX++} | b   |\n+----------+-----+\n\nAfter.\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['a <pre> around it', '<pre>\n', '\n</pre>\n'],
    ['a <pre> after it whose end is in a comment', '', '\nSource <pre><!-- </pre> -->\n    run()\n</pre>\n'],
    ['a <script> after it whose end is in a comment', '', '\n<span>a</span> <script>// </pre>\nrun()\n</script>\n'],
    ['a comment over lines after text, one of which starts with a tag', '', '\nSource <!-- hidden\n<div>secret</div> -->\n'],
    ['a comment over lines after text, one of which would be a heading', '', '\nSource <!-- hidden\n# Sources\nsecret -->\n'],
  ])('drops %s, which Markdown reads otherwise, from around a table that leaves HTML', async (_name, beforeHtml, afterHtml) => {
    // The <pre> before it, as a block of its own, went on over the table,
    // and an end in a comment ended it early. A line in a comment a line of
    // text starts that starts a block, as a heading, ended the paragraph,
    // and showed what the comment hid
    const zip = await JSZip.loadAsync((await convertMdToDocx(beforeHtml + '<table><tr><td>XX</td><td>b</td></tr></table>' + afterHtml)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('+----------+-----+\n| {++XX++} | b   |\n+----------+-----+\n');
  });

  test.each([
    ['as HTML', false, (i: number) => 'line ' + i + ' $'],
    ['that leaves HTML', true, (i: number) => 'line ' + i + ' $'],
    // Each escaped heading made the line of one tag after it text, and
    // the lines after it were read again
    ['that leaves HTML, of headings and lines of one tag', true, (i: number) => i % 2 ? '<span>' : '# Source'],
    // Each line in a comment, or with a tag, was read to its end
    ['that leaves HTML, in a comment', true, (i: number) => i === 0 ? 'Source <!-- a' : '<div>' + i + ' <pre> x'],
    ['that leaves HTML, with a <pre> on each line', true, (i: number) => 'line ' + i + ' <b>b</b> <pre> x'],
    // Each [ looked on to the end for an @ before its ]
    ['that leaves HTML, with [s and no ] on each line', true, (i: number) => 'line ' + i + ' [a [b [c [d'],
  ])('writes many lines of HTML after a table %s in linear time', async (_name, tracked, line) => {
    // Each line's escape indexed all the lines after it, even for a table
    // that kept the HTML. Four times the lines take about four times as
    // long, not sixteen, however fast the machine is.
    const time = async (lines: number) => {
      const md = '<div>\n<table><tr><td>XX</td><td>b</td></tr></table>\n' + Array.from({ length: lines }, (_, i) => line(i)).join('\n') + '\n</div>\n';
      const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
      const xml = await zip.file('word/document.xml')!.async('string');
      if (tracked) zip.file('word/document.xml', xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>'));
      const docx = await zip.generateAsync({ type: 'uint8array' });
      const start = performance.now();
      await convertDocx(docx);
      return performance.now() - start;
    };
    await time(500);
    const small = await time(2000);
    expect(await time(8000) / small).toBeLessThan(8);
  });

  test('puts the HTML around many tables back in linear time', async () => {
    // Each table read every entry of the HTML export kept
    const { tableFirstRowText, tableContentsFingerprint } = await import('./table-metadata');
    const time = (count: number) => {
      const content: ContentItem[] = [];
      const around = new Map<string, [string, string, string, string, string, string, string]>();
      const formats = new Map<string, string>();
      for (let i = 0; i < count; i++) {
        const text = 'a' + i;
        content.push({ type: 'table', rows: [{ isHeader: false, cells: [{ paragraphs: [[{ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING }]] }] }] });
        around.set(String(i), ['<div>', '</div>', tableFirstRowText([text]), tableContentsFingerprint([[text]]), '0', '', '1']);
        formats.set(String(i), 'html');
      }
      const start = performance.now();
      const markdown = buildMarkdown(content, new Map(), { tableHtmlAroundMapping: around, tableFormatMapping: formats });
      expect(markdown.match(/<div>/g)?.length).toBe(count);
      return performance.now() - start;
    };
    time(1000);
    expect(time(32000) / time(8000)).toBeLessThan(8);
  });

  test('puts the HTML around many tables alike back in linear time', async () => {
    // Each table looked for its index among the keys of all alike it
    const { tableFirstRowText, tableContentsFingerprint } = await import('./table-metadata');
    const time = (count: number) => {
      const content: ContentItem[] = [];
      const around = new Map<string, [string, string, string, string, string, string, string]>();
      const formats = new Map<string, string>();
      for (let i = 0; i < count; i++) {
        content.push({ type: 'table', rows: [{ isHeader: false, cells: [{ paragraphs: [[{ type: 'text', text: 'a', commentIds: new Set(), formatting: DEFAULT_FORMATTING }]] }] }] });
        around.set(String(i), ['<div>', '</div>', tableFirstRowText(['a']), tableContentsFingerprint([['a']]), String(i), '', String(count)]);
        formats.set(String(i), 'html');
      }
      const start = performance.now();
      const markdown = buildMarkdown(content, new Map(), { tableHtmlAroundMapping: around, tableFormatMapping: formats });
      expect(markdown.match(/<div>/g)?.length).toBe(count);
      return performance.now() - start;
    };
    time(1000);
    expect(time(32000) / time(8000)).toBeLessThan(8);
  });

  test('warns of no HTML kept around a table in a list item, which is dropped', async () => {
    const { warnings } = await convertMdToDocx('- <p>Cap</p>\n  <table><tr><td>a</td></tr></table>\n');
    expect(warnings.some(w => w.startsWith('HTML around a table'))).toBe(false);
  });

  test('reads a table whose block starts with a div, after a directive, as the directive\'s', async () => {
    const md = '<!-- table-font-size: 11 -->\n<div>\n<table><tr><td>a</td></tr></table>\n</div>\n';
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    expect(xml.slice(xml.indexOf('<w:tbl>'))).toContain('<w:sz w:val="22"/>');
  });

  test('writes the HTML around a table that leaves HTML, as for a tracked change, as blocks around it and its directives', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('<div>\n<p>Cap</p>\n<table data-font-size="11"><tr><th>h</th></tr><tr><td>XX</td></tr></table>\n</div>\n\nAfter.\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tracked = xml.replace(/<w:r>((?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>)/, '<w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>$1</w:ins>');
    expect(tracked).not.toBe(xml);
    zip.file('word/document.xml', tracked);
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('<div>\n<p>Cap</p>\n\n<!-- table-font-size: 11 -->\n| h |\n| --- |\n| {++XX++} |\n\n</div>\n\nAfter.\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });
});

describe('tables next to each other', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  const parts = async (docx: Uint8Array) => {
    const zip = await JSZip.loadAsync(docx);
    return (await zip.file('word/document.xml')!.async('string')) + ((await zip.file('word/footnotes.xml')?.async('string')) ?? '');
  };
  const pipe = (text: string, indent = '') => [indent + '| ' + text + ' |', indent + '| --- |', indent + '| ' + text + text + ' |'].join('\n');

  test.each([
    ['two tables', pipe('a') + '\n\n' + pipe('b') + '\n'],
    ['a table after one with a directive', pipe('a') + '\n\n<!-- table-font-size: 11 -->\n' + pipe('b') + '\n'],
    ['two tables in a landscape section', '<!-- landscape -->\n' + pipe('a') + '\n\n' + pipe('b') + '\n<!-- /landscape -->\n\nAfter.\n'],
    ['two tables in a note', 'Text[^1].\n\n[^1]: Note.\n\n' + pipe('a', '    ') + '\n\n' + pipe('b', '    ') + '\n'],
    ['two tables in an HTML block', '<div>\n<table>\n  <tr>\n    <td>\n      <p>a</p>\n    </td>\n  </tr>\n</table>\n<table>\n  <tr>\n    <td>\n      <p>b</p>\n    </td>\n  </tr>\n</table>\n</div>\n'],
    ['two tables in a note\'s HTML block', 'Text[^1].\n\n[^1]: Note.\n\n    <div>\n    <table>\n      <tr>\n        <td>\n          <p>a</p>\n        </td>\n      </tr>\n    </table>\n    <table>\n      <tr>\n        <td>\n          <p>b</p>\n        </td>\n      </tr>\n    </table>\n    </div>\n'],
  ])('keeps %s apart in Word with a paragraph, which import reads as nothing', async (_name, md) => {
    // Export wrote them with nothing between them, which Word joins
    const { docx } = await convertMdToDocx(md);
    const xml = await parts(docx);
    expect(xml).not.toContain('</w:tbl><w:tbl>');
    expect(xml).toMatch(/<\/w:tbl><w:p\b[^>]*(?:\/>|>(?:<w:pPr>(?:(?!<\/w:p>)[\s\S])*<\/w:pPr>)?<\/w:p>)<w:tbl>/);
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(md);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps tables a Word user kept apart with an empty paragraph apart', async () => {
    // Import read them with a blank line between, which export wrote as
    // tables with nothing between them
    const zip = await JSZip.loadAsync((await convertMdToDocx('X')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tbl = (text: string) => '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    zip.file('word/document.xml', xml.slice(0, xml.indexOf('<w:body>') + 8) + tbl('a') + '<w:p/>' + tbl('b') + xml.slice(xml.lastIndexOf('<w:sectPr')));
    const markdown = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(markdown).toBe('+-----+\n| a   |\n+-----+\n\n+-----+\n| b   |\n+-----+\n');
    expect(await parts((await convertMdToDocx(markdown)).docx)).not.toContain('</w:tbl><w:tbl>');
    expect(await roundTrip(markdown)).toBe(markdown);
  });
});

describe('a table\'s settings where Word adds or deletes a table before it', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const resolver = { readFile: () => new TextEncoder().encode('H\na\n'), resolveRelative: (_base: string, relative: string) => relative };
  const options = { embedResolver: resolver, documentPath: '/doc/paper.md' };
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md, options)).docx)).markdown);
  const afterWord = async (md: string, edit: (xml: string) => string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md, options)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', edit(xml));
    return strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };
  const deleteFirst = (xml: string) => xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, '');
  const addFirst = (xml: string) => xml.replace('<w:tbl>', '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>New</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/><w:tbl>');
  const table = (text: string, attrs = '', indent = '') => ['<table' + attrs + '>', '  <tr>', '    <td>', '      <p>' + text + '</p>', '    </td>', '  </tr>', '</table>'].map(line => indent + line).join('\n');
  const pipe = '| P |\n| --- |\n| p |\n\n';
  const cases: [string, string, string][] = [
    ['a font size and the HTML around it', pipe, '<div>\n<p>Cap</p>\n' + table('A', ' data-font-size="11"') + '\n</div>\n'],
    ['its HTML format', pipe, table('A') + '\n'],
    ['its directives', table('Z') + '\n\n', '<!-- table-font-size: 11 -->\n<!-- table-col-widths: 2 1 -->\n| P | Q |\n| --- | --- |\n| p | q |\n'],
    ['its number format', pipe, '<!-- table-digits: 2 -->\n| A | B |\n| --- | --- |\n| x | 1.234 |\n'],
    ['its grid table\'s columns', pipe, '+----------+-----+\n| G        | H   |\n+==========+=====+\n| g        | h   |\n+----------+-----+\n'],
    ['its pipe table\'s aligned columns', table('Z') + '\n\n', '| Name | V   |\n|------|-----|\n| a    | b   |\n'],
    ['its orientation', pipe, table('L', ' data-orientation="landscape"') + '\n\nAfter.\n'],
    ['its embed directive', pipe, '<!-- embed: t.csv headers=1 -->\n\nAfter.\n'],
    ['a note\'s table its font size', pipe, 'Text[^1].\n\n[^1]: Note.\n\n' + table('N', ' data-font-size="11"', '    ') + '\n'],
  ];

  test.each(cases)('keeps %s where Word deletes a table before it', async (_name, before, md) => {
    // It took the settings export wrote at its index, the deleted table's
    expect(await roundTrip(before + md)).toBe(before + md);
    const markdown = await afterWord(before + md, deleteFirst);
    expect(markdown).toBe(md);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each(cases)('keeps %s where Word adds a table before it, which takes none', async (_name, before, md) => {
    // The added table took the settings export wrote at its index, and
    // each after it the one's before it
    const markdown = await afterWord(before + md, addFirst);
    expect(markdown).toBe('+-----+\n| New |\n+-----+\n\n' + before + md);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps the settings and HTML around a table Word edits where it deletes a table before it', async () => {
    // Its text, and the index, matched no table export wrote
    const md = '<div>\n<p>Cap</p>\n<table data-font-size="11">\n  <tr>\n    <td>\n      <p>H</p>\n    </td>\n  </tr>\n  <tr>\n    <td>\n      <p>a</p>\n    </td>\n  </tr>\n</table>\n</div>\n';
    const markdown = await afterWord(pipe + md, xml => deleteFirst(xml).replace('>a<', '>z<'));
    expect(markdown).toBe(md.replace('<p>a</p>', '<p>z</p>'));
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('takes a table\'s settings by its index from a document that has no tables\' identities', async () => {
    // As export wrote before it wrote them
    const md = pipe + table('A', ' data-font-size="11"') + '\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const custom = await zip.file('docProps/custom.xml')!.async('string');
    const without = custom.replace(/<property [^>]*name="MANUSCRIPT_TABLE_IDENTITIES_\d+"[^>]*>[\s\S]*?<\/property>/g, '');
    expect(without).not.toBe(custom);
    zip.file('docProps/custom.xml', without);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe(md);
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
      + '<w:tr><w:trPr><w:tblHeader/></w:trPr>' + cell('a') + cell('b') + '</w:tr><w:tr>' + cell('1') + cell('2') + '</w:tr></w:tbl></w:body></w:document>';
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

  const tableNote = (label: string, size: number, cell: string, text = 'Note.') =>
    '[^' + label + ']: ' + text + '\n\n    <!-- table-font-size: ' + size + ' -->\n    | ' + cell + ' |\n    | --- |\n    | 1 |\n';

  test.each([
    ['numbers', '2', '1'],
    ['names', 'b', 'a'],
  ])('keeps each note\'s table settings when notes are defined out of the order of their %s', async (_name, first, second) => {
    // Export numbered the tables in the order the notes were defined, and
    // import in the order it writes them, by label
    const text = 'Text[^' + first + '] and[^' + second + '].\n\n';
    expect(await roundTrip(text + tableNote(first, 12, 'x') + '\n' + tableNote(second, 7, 'y')))
      .toBe(text + tableNote(second, 7, 'y') + '\n' + tableNote(first, 12, 'x'));
  });

  test.each([
    ['in the order of their references', '[^1b]: N.\n\n[^1a]: N.\n'],
    ['out of it', '[^1a]: N.\n\n[^1b]: N.\n'],
  ])('keeps the table settings of notes whose labels have one number, defined %s', async (_name, order) => {
    // Their labels tie, and they keep their references' order, as import
    // read them in documents older versions wrote, which numbered the tables
    // in the order notes were defined: 1b's first here
    const text = 'Text[^1b] and[^1a].\n\n';
    const md = text + order.replace('[^1b]: N.\n', tableNote('1b', 12, 'x')).replace('[^1a]: N.\n', tableNote('1a', 7, 'y'));
    const { docx } = await convertMdToDocx(md);
    const custom = await (await JSZip.loadAsync(docx)).file('docProps/custom.xml')!.async('string');
    expect(custom).toContain('"MANUSCRIPT_TABLE_FONT_SIZES_1"><vt:lpwstr>{"0":"12","1":"7"}<');
    expect(strip((await convertDocx(docx)).markdown)).toBe(text + tableNote('1b', 12, 'x') + '\n' + tableNote('1a', 7, 'y'));
  });

  test.each([
    ['footnotes', ''],
    ['endnotes', '---\nnotes: endnotes\n---\n\n'],
  ])('keeps the table settings of %s whose labels have one number where a tracked reference comes first', async (_name, front) => {
    // Export broke the tie by the references that own the notes, which the
    // tracked one doesn't, and import by the first, which it is
    const text = '{--X[^1a]--} and Y[^1b] and Z[^1a].\n\n';
    const md = text + tableNote('1a', 12, 'x') + '\n' + tableNote('1b', 7, 'y');
    expect((await roundTrip(front + md)).replace(/^\n/, '')).toBe(md);
  });

  test('keeps the table settings of a note after one only another note refers to', async () => {
    // Export made that one in its label's turn, which import, which writes
    // only the notes the text refers to, doesn't read, so the next note
    // read its table's settings
    const md = 'T[^a] and[^c].\n\n[^a]: A[^b].\n\n' + tableNote('b', 7, 'y', 'B.') + '\n' + tableNote('c', 12, 'z', 'C.');
    expect(await roundTrip(md)).toBe('T[^a] and[^c].\n\n[^a]: A.\n\n' + tableNote('c', 12, 'z', 'C.'));
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
  /** The Markdown of md's export, with the text XX in part replaced by
   *  text, and the space export puts after a note's mark before it too, as
   *  text holds what Word puts there */
  const withText = async (md: string, part: string, text: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = (await zip.file(part)!.async('string')).replace(NOTE_SEPARATOR + '<w:r><w:t>XX</w:t></w:r>', '<w:r><w:t>XX</w:t></w:r>');
    zip.file(part, xml.replace('<w:t>XX</w:t>', '<w:t xml:space="preserve">' + text + '</w:t>'));
    return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
  };

  test.each([
    ['four spaces', '    four', 'A.\n\n&#32;&#32;&#32;&#32;four\n\nB.\n'],
    ['a tab', '\tt', 'A.\n\n&#9;t\n\nB.\n'],
    ['two spaces', '  two', 'A.\n\n&#32;&#32;two\n\nB.\n'],
    ['a no-break space', '\u00a0x', 'A.\n\n&nbsp;x\n\nB.\n'],
    ['a no-break space alone', '\u00a0', 'A.\n\n&nbsp;\n\nB.\n'],
    // Which JavaScript's trim takes, as markdown-it trims a paragraph with
    ['an ideographic space', '\u3000\u3000\u6bb5\u843d', 'A.\n\n&#12288;&#12288;\u6bb5\u843d\n\nB.\n'],
    ['an ideographic space alone', '\u3000', 'A.\n\n&#12288;\n\nB.\n'],
    ['a space before an ideographic space', ' \u3000x', 'A.\n\n&#32;&#12288;x\n\nB.\n'],
    ['an em space', '\u2003x', 'A.\n\n&#8195;x\n\nB.\n'],
    ['a zero-width no-break space', '\ufeffx', 'A.\n\n&#65279;x\n\nB.\n'],
  ])('keeps %s at the start of a paragraph', async (_name, text, expected) => {
    // Four spaces or a tab made the paragraph a code block, and Markdown
    // dropped other whitespace there, or the whole paragraph
    const markdown = await withText('A.\n\nXX\n\nB.', 'word/document.xml', text);
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['a no-break space', 'end\u00a0', 'A.\n\nend&nbsp;\n\nB.\n'],
    ['an ideographic space', 'end\u3000', 'A.\n\nend&#12288;\n\nB.\n'],
    ['a line separator', 'end\u2028', 'A.\n\nend&#8232;\n\nB.\n'],
    // Whose reference's & the backslash escaped, which showed the reference
    ['an ideographic space after a backslash', 'end\\\u3000', 'A.\n\nend\\\\&#12288;\n\nB.\n'],
    ['an ideographic space after two backslashes', 'end\\\\\u3000', 'A.\n\nend\\\\\\\\&#12288;\n\nB.\n'],
    ['a no-break space after a backslash', 'end\\\u00a0', 'A.\n\nend\\\\&nbsp;\n\nB.\n'],
    ['an ideographic space after a backslash and a space', 'end\\ \u3000', 'A.\n\nend\\ &#12288;\n\nB.\n'],
  ])('keeps %s at the end of a paragraph', async (_name, text, expected) => {
    const markdown = await withText('A.\n\nXX\n\nB.', 'word/document.xml', text);
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['a table\'s cell', '| a |\n|---|\n| XX |', '| a |\n| --- |\n| &#12288;x&#12288; |\n'],
    ['a list item', '- XX', '- &#12288;x&#12288;\n'],
    ['a quote', '> XX', '> &#12288;x&#12288;\n'],
    ['a heading', '# XX', '# &#12288;x&#12288;\n'],
  ])('keeps an ideographic space at the edges of %s', async (_name, md, expected) => {
    const markdown = await withText(md, 'word/document.xml', '\u3000x\u3000');
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps an ideographic space at the edges of a note', async () => {
    const markdown = await withText('T.[^1]\n\n[^1]: XX', 'word/footnotes.xml', '\u3000x\u3000');
    expect(markdown).toBe('T.[^1]\n\n[^1]: &#12288;x&#12288;\n');
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
    ['spaces', 'a' + ' '.repeat(100000) + 'b\u3000', 'A.\n\na' + ' '.repeat(100000) + 'b&#12288;\n\nB.\n'],
    ['backslashes', '\\'.repeat(100000) + 'b\u3000', 'A.\n\n' + '\\\\'.repeat(99999) + '\\b&#12288;\n\nB.\n'],
  ])('reads a paragraph with a long run of %s in it in linear time', async (_name, text, expected) => {
    // The whitespace at its end was found with a regex, which scanned each
    // run of whitespace in it to its end, as one before the backslashes
    // before it did each run of them
    const start = performance.now();
    expect(await withText('A.\n\nXX\n\nB.', 'word/document.xml', text)).toBe(expected);
    expect(performance.now() - start).toBeLessThan(3000);
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
    // A run of backticks before the code, which closes nothing, ended it.
    // The code on each side of the break is its own span.
    const zip = await JSZip.loadAsync((await convertMdToDocx('A.\n\nXX\n\nB.')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const code = '<w:rPr><w:rStyle w:val="CodeChar"/></w:rPr>';
    const edited = xml.replace('<w:r><w:t>XX</w:t></w:r>', '<w:r><w:t xml:space="preserve">p ```a </w:t></w:r><w:r>' + code + '<w:t>x</w:t></w:r>'
      + '<w:r>' + code + '<w:br/></w:r><w:r>' + code + '<w:t xml:space="preserve">  y</w:t></w:r>');
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    // The code on each side of the line break, which a code span can't hold
    expect(markdown).toContain('p \\`\\`\\`a `x`\\\n`  y`');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
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
    const edited = xml.replace(NOTE_SEPARATOR + '<w:r><w:t>XX</w:t></w:r>', run(separator) + run(text));
    expect(edited).not.toBe(xml);
    zip.file('word/footnotes.xml', edited);
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe(expected);
  });

  test.each([
    ['from before the mark', 'T.[^1]\n\n[^1]: {==A b.==}{>>@A (2024-01-15 10:30) | c<<}\n', 'mark', 'text'],
    ['from the space after the mark', 'T.[^1]\n\n[^1]: {==A b.==}{>>@A (2024-01-15 10:30) | c<<}\n', 'space', 'text'],
    ['from before the mark, over two paragraphs', 'T.[^1]\n\n[^1]: {#1}A.\n\n    B.{/1}\n    {#1>>@A (2024-01-15 10:30) | c<<}\n', 'mark', 'text'],
    ['on the mark alone', 'T.[^1]\n\n[^1]: {>>@A (2024-01-15 10:30) | c<<}A b.\n', 'mark', 'mark'],
  ])('leaves out the space after a note\'s mark in a comment\'s range %s', async (_name, md, start, end) => {
    // The range kept the space, as text's, so Word showed it after the one
    // export writes there; a comment on the mark alone kept it after the
    // comment
    const exported = md.includes('{==') || md.includes('{#1}') ? md : md.replace('{>>@A (2024-01-15 10:30) | c<<}A', '{==A==}{>>@A (2024-01-15 10:30) | c<<}');
    const zip = await JSZip.loadAsync((await convertMdToDocx(exported)).docx);
    const xml = await zip.file('word/footnotes.xml')!.async('string');
    const mark = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>';
    expect(xml).toContain(mark + NOTE_SEPARATOR + '<w:commentRangeStart w:id="0"/>');
    let edited = xml.replace(NOTE_SEPARATOR + '<w:commentRangeStart w:id="0"/>', NOTE_SEPARATOR)
      .replace(mark + NOTE_SEPARATOR, start === 'mark' ? '<w:commentRangeStart w:id="0"/>' + mark + NOTE_SEPARATOR : mark + '<w:commentRangeStart w:id="0"/>' + NOTE_SEPARATOR);
    if (end === 'mark') edited = edited.replace('<w:commentRangeEnd w:id="0"/>', '').replace(mark, mark + '<w:commentRangeEnd w:id="0"/>');
    zip.file('word/footnotes.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe(md);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  test.each([
    ['text', 'A.', 'footnotes'],
    ['code', '`c` A.', 'footnotes'],
    ['formatting', '**b** A.', 'footnotes'],
    ['an insertion', '{++A.++}', 'footnotes'],
    ['a comment', '{==A.==}{>>c<<}', 'footnotes'],
    ['an equation', '$x$ A.', 'footnotes'],
    ['text, in an endnote', 'A.', 'endnotes'],
  ])('writes the space Word puts after a note\'s mark before %s', async (_name, text, notes) => {
    // Export put none before text that didn't start with whitespace, so a
    // note's mark and its text went to Word as no note of Word's has them
    const front = notes === 'endnotes' ? '---\nnotes: endnotes\n---\n\n' : '';
    const md = front + 'T.[^1]\n\n[^1]: ' + text + '\n';
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/' + notes + '.xml')!.async('string');
    expect(xml).toContain((notes === 'endnotes' ? '<w:endnoteRef/>' : '<w:footnoteRef/>') + '</w:r>' + NOTE_SEPARATOR);
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  test('writes a note as Word writes it back as it was', async () => {
    // Word puts a run of a space after the note's mark, which went, so Word
    // got the note's text right after the mark
    const zip = await JSZip.loadAsync((await convertMdToDocx('T.[^1]\n\n[^1]: XX')).docx);
    const xml = await zip.file('word/footnotes.xml')!.async('string');
    const word = xml.replace(NOTE_SEPARATOR + '<w:r><w:t>XX</w:t></w:r>', NOTE_SEPARATOR + '<w:r><w:t>A note.</w:t></w:r>');
    expect(word).not.toBe(xml);
    zip.file('word/footnotes.xml', word);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe('T.[^1]\n\n[^1]: A note.\n');
    const again = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/footnotes.xml')!.async('string');
    const note = (part: string) => /<w:footnote w:id="1">[\s\S]*?<\/w:footnote>/.exec(part)![0].replace(/ w14:\w+="[^"]*"| w:rsid\w*="[^"]*"/g, '');
    expect(note(again)).toBe(note(word));
  });

  test.each([
    ['spaces', '  ', '\tB.', 'T.[^1]\n\n[^1]: &#9;B.\n'],
    ['a space', ' ', '  B.', 'T.[^1]\n\n[^1]: &#32;&#32;B.\n'],
    ['a tab', '\t', '\tB.', 'T.[^1]\n\n[^1]: &#9;B.\n'],
    ['nothing more', '', '\tB.', 'T.[^1]\n\n[^1]: &#9;B.\n'],
  ])('keeps the whitespace that starts a note\'s paragraph after its mark\'s of %s', async (_name, first, text, expected) => {
    // The mark's paragraph left nothing, so the next one's text started the
    // note, and import took its first space or tab for the one Word puts
    // after the mark
    const zip = await JSZip.loadAsync((await convertMdToDocx('T.[^1]\n\n[^1]: XX\n\n    YY')).docx);
    const xml = await zip.file('word/footnotes.xml')!.async('string');
    const run = (t: string) => t === '\t' ? '<w:r><w:tab/></w:r>' : t === '' ? '' : '<w:r><w:t xml:space="preserve">' + t.replace('\t', '</w:t><w:tab/><w:t>') + '</w:t></w:r>';
    const edited = xml.replace(NOTE_SEPARATOR + '<w:r><w:t>XX</w:t></w:r>', run(first)).replace('<w:r><w:t>YY</w:t></w:r>', run(text));
    expect(edited).not.toContain('XX');
    expect(edited).not.toContain('YY');
    zip.file('word/footnotes.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['hidden, before a paragraph of spaces alone', 'footnotes', 'hidden', '  ', '\tB.', '[^1]: &#9;B.\n'],
    ['missing, before a paragraph of spaces alone', 'footnotes', 'missing', '  ', '\tB.', '[^1]: &#9;B.\n'],
    ['hidden, in an empty paragraph of an endnote', 'endnotes', 'hidden', '', '\tB.', '[^1]: &#9;B.\n'],
    ['missing, before an endnote\'s paragraph of spaces alone', 'endnotes', 'missing', ' ', '  B.', '[^1]: &#32;&#32;B.\n'],
    ['missing, before text', 'footnotes', 'missing', ' A.', 'B.', '[^1]: &#32;A.\n\n    B.\n'],
    ['after a space', 'footnotes', 'after a space', 'A.', 'B.', '[^1]: &#32;A.\n\n    B.\n'],
  ])('keeps the whitespace that starts a note whose mark is %s', async (_name, notes, mark, first, text, expected) => {
    // Import took the first space or tab of the note's text for the one Word
    // puts after the mark, though no mark came before it
    const front = notes === 'endnotes' ? '---\nnotes: endnotes\n---\n\n' : '';
    const zip = await JSZip.loadAsync((await convertMdToDocx(front + 'T.[^1]\n\n[^1]: XX\n\n    YY')).docx);
    const part = 'word/' + notes + '.xml';
    const xml = await zip.file(part)!.async('string');
    const tag = notes === 'endnotes' ? 'w:endnoteRef' : 'w:footnoteRef';
    const markRun = new RegExp('<w:r><w:rPr>(<w:rStyle w:val="\\w+"/>)</w:rPr><' + tag + '/></w:r>');
    const marks: Record<string, string> = {
      hidden: '<w:r><w:rPr>$1<w:vanish/></w:rPr><' + tag + '/></w:r>',
      missing: '',
      'after a space': '<w:r><w:t xml:space="preserve"> </w:t></w:r>$&',
    };
    const run = (t: string) => t === '' ? '' : '<w:r><w:t xml:space="preserve">' + t.replace('\t', '</w:t><w:tab/><w:t>') + '</w:t></w:r>';
    expect(xml).toMatch(markRun);
    const edited = xml.replace(markRun, marks[mark]).replace(NOTE_SEPARATOR + '<w:r><w:t>XX</w:t></w:r>', run(first)).replace('<w:r><w:t>YY</w:t></w:r>', run(text));
    expect(edited).not.toContain('XX');
    expect(edited).not.toContain('YY');
    zip.file(part, edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe(front + 'T.[^1]\n\n' + expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['a deletion, in a footnote', 'footnotes', 'del', '[^1]:\n\n    {--\n    \n    --}B.\n'],
    ['an insertion, in a footnote', 'footnotes', 'ins', '[^1]:\n\n    {++\n    \n    ++}B.\n'],
    ['a comment\'s start, in a footnote', 'footnotes', 'comment', '[^1]: {#1}\n\n    B.{/1}\n    {#1>>@A (2024-01-15 10:30) | c<<}\n'],
    ['a deletion, in an endnote', 'endnotes', 'del', '[^1]:\n\n    {--\n    \n    --}B.\n'],
    ['an insertion, in an endnote', 'endnotes', 'ins', '[^1]:\n\n    {++\n    \n    ++}B.\n'],
    ['a comment\'s start, in an endnote', 'endnotes', 'comment', '[^1]: {#1}\n\n    B.{/1}\n    {#1>>@A (2024-01-15 10:30) | c<<}\n'],
  ])('keeps %s at the end of a note\'s paragraph that holds only its reference mark and a space', async (_name, notes, how, expected) => {
    // The space went, and the paragraph held nothing more, so its tracked
    // mark and the comment that starts there went with it. (Export can't
    // write a break or a comment's start where a note's text starts yet.)
    const front = notes === 'endnotes' ? '---\nnotes: endnotes\n---\n\n' : '';
    const body = how === 'comment' ? '{#1}B.{/1}\n    {#1>>@A (2024-01-15 10:30) | c<<}' : 'B.';
    const zip = await JSZip.loadAsync((await convertMdToDocx(front + 'T.[^1]\n\n[^1]: XX\n\n    ' + body)).docx);
    const part = 'word/' + notes + '.xml';
    const xml = await zip.file(part)!.async('string');
    const style = notes === 'endnotes' ? 'EndnoteText' : 'FootnoteText';
    const tag = notes === 'endnotes' ? 'w:endnoteRef' : 'w:footnoteRef';
    const mark = how === 'comment' ? '' : '<w:rPr><w:' + how + ' w:id="91" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr>';
    let edited = xml.replace(new RegExp('<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>(<w:r><w:rPr><w:rStyle w:val="\\w+"/></w:rPr><' + tag + '/></w:r>)' + NOTE_SEPARATOR + '<w:r><w:t>XX</w:t></w:r>'),
      '<w:pPr><w:pStyle w:val="' + style + '"/>' + mark + '</w:pPr>$1<w:r><w:t xml:space="preserve"> </w:t></w:r>' + (how === 'comment' ? '<w:commentRangeStart w:id="0"/>' : ''));
    if (how === 'comment') edited = edited.replace(/<w:commentRangeStart w:id="0"\/>(?=(?:(?!<\/w:p>).)*<w:t>B)/, '');
    expect(edited).not.toContain('XX');
    expect(edited.match(/<w:commentRangeStart/g)?.length ?? 0).toBe(how === 'comment' ? 1 : 0);
    zip.file(part, edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe(front + 'T.[^1]\n\n' + expected);
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

  describe.each([
    ['shown', ''],
    ['hidden', '---\ncallout-labels: false\n---\n\n'],
  ])('with alert labels %s', (_labels, frontmatter) => {
    test.each([
      ['a space', '> [!NOTE] &#32;a\n', ' a'],
      ['two spaces', '> [!NOTE] &#32;&#32;a\n', '  a'],
      ['a tab', '> [!NOTE] &#9;a\n', '\ta'],
      ['a space before bold text', '> [!NOTE] &#32;**a**\n', ' a'],
      ['a space after a later line\'s marker', '> x\n> [!TIP] &#32;b\n', ' b'],
      ['a space in a quote in a quote', '> > [!NOTE] &#32;a\n', ' a'],
    ])('keeps %s written as a reference that starts an alert\'s text on its marker\'s line', async (_name, md, text) => {
      // The marker took the whitespace after it, written as it is and as
      // references, and import the space after the label's line break
      const { docx } = await convertMdToDocx(frontmatter + md);
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      const lead = /<w:pStyle w:val="GitHub(?:Note|Tip)"\/>.*?<\/w:p>/.exec(xml)![0];
      const runs = lead.includes('<w:br/>') ? lead.slice(lead.indexOf('<w:br/>')) : lead;
      expect([...runs.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map(match => match[1] ?? '\t').join('')).toBe(text);
      const markdown = await roundTrip(frontmatter + md);
      expect(markdown).toBe(frontmatter + md);
      expect(await roundTrip(markdown)).toBe(markdown);
    });
  });

  test.each([
    ['a space', '&#32;a'],
    ['two spaces', '&#32;&#32;a'],
  ])('keeps %s that starts an alert\'s text after its marker\'s line, with its label hidden', async (_name, text) => {
    // Import took a space off it as export's, which writes none there
    const md = '---\ncallout-labels: false\n---\n\n> [!NOTE]\n> ' + text + '\n';
    const markdown = await roundTrip(md);
    expect(markdown).toBe(md);
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
    // Import wrote the spaces on a line of their own, which the next import
    // didn't, as Markdown reads them as a blank line
    const markdown = await withText('A.\n\nXX\n\nB.', 'word/document.xml', '   ');
    expect(markdown).toBe('A.\n\nB.\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['a list item', '- a\n- XX\n- b', 'word/document.xml'],
    ['a task item', '- [ ] a\n- [ ] XX', 'word/document.xml'],
    ['a list item\'s later paragraph', '- a\n\n  XX\n- b', 'word/document.xml'],
    ['a quote', '> a\n>\n> XX\n>\n> b', 'word/document.xml'],
    ['an alert, after its label', '> [!NOTE]\n> XX', 'word/document.xml'],
    ['a heading', '# XX\n\nB.', 'word/document.xml'],
    ['a note\'s first paragraph', 'T.[^1]\n\n[^1]: XX\n\n    B.', 'word/footnotes.xml'],
    ['a note\'s later paragraph', 'T.[^1]\n\n[^1]: A.\n\n    XX\n\n    B.', 'word/footnotes.xml'],
  ])('writes a paragraph of spaces and tabs alone in %s as the empty paragraph there', async (_name, md, part) => {
    // Import wrote them as they were, which the next import didn't, as
    // Markdown reads them as a blank line or as nothing
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file(part)!.async('string');
    zip.file(part, xml.replace('<w:r><w:t>XX</w:t></w:r>', ''));
    const empty = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(await withText(md, part, ' \t ')).toBe(empty);
  });

  describe('but not what an empty paragraph would lose', () => {
    /** The Markdown of md's export, with each `from` in part replaced by its `to` */
    const withXml = async (md: string, part: string, ...edits: [string | RegExp, string][]) => {
      const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
      let xml = await zip.file(part)!.async('string');
      for (const [from, to] of edits) {
        expect(xml.replace(from, to)).not.toBe(xml);
        xml = xml.replace(from, to);
      }
      zip.file(part, xml);
      return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    };
    const spaces = '<w:r><w:t xml:space="preserve">  </w:t></w:r>';
    const revision = 'w:id="91" w:author="A" w:date="2024-01-01T00:00:00Z"';

    test.each([
      ['deleted', 'A.\n\nXX\n\nB.', 'word/document.xml', /(<w:p [^>]*>)<w:r><w:t>XX<\/w:t><\/w:r>/,
        '$1<w:pPr><w:rPr><w:del ' + revision + '/></w:rPr></w:pPr>', 'A.\n\n&#32;&#32;{--\n\n--}B.\n'],
      ['inserted', 'A.\n\nXX\n\nB.', 'word/document.xml', /(<w:p [^>]*>)<w:r><w:t>XX<\/w:t><\/w:r>/,
        '$1<w:pPr><w:rPr><w:ins ' + revision + '/></w:rPr></w:pPr>', 'A.\n\n&#32;&#32;{++\n\n++}B.\n'],
      ['deleted, in a note', 'T.[^1]\n\n[^1]: A.\n\n    XX\n\n    B.', 'word/footnotes.xml', /<\/w:pPr><w:r><w:t>XX<\/w:t><\/w:r>/,
        '<w:rPr><w:del ' + revision + '/></w:rPr></w:pPr>', 'T.[^1]\n\n[^1]: A.\n\n    &#32;&#32;{--\n    \n    --}B.\n'],
    ])('keeps a paragraph of spaces alone whose mark is %s', async (_name, md, part, from, to, expected) => {
      // Its text went, and the tracked mark with it, which the next
      // paragraph didn't take, as it had no para item of its own
      const markdown = await withXml(md, part, [from, to + spaces]);
      expect(markdown).toBe(expected);
      expect(await roundTrip(markdown)).toBe(markdown);
    });

    // The paragraph's pPr, which a w:rPr goes at the end of, before its text
    const markOf = (text: string) => new RegExp('(<w:pPr>(?:(?!</w:pPr>).)*)(</w:pPr><w:r><w:t>' + text + '</w:t>)');
    // Or a pPr of its own
    const ownMarkOf = (text: string) => new RegExp('(<w:p [^>]*>)(<w:r><w:t>' + text + '</w:t>)');
    const rPr = (type: string) => '<w:rPr><w:' + type + ' ' + revision + '/></w:rPr>';
    test.each([
      ['deleted, in a quote', '> a\n>\n> XX\n>\n> b', 'word/document.xml', markOf('a'), '$1' + rPr('del') + '$2', spaces,
        '> a{--\n>\n> --}&#32;&#32;\n>\n> b\n'],
      ['inserted, in a quote', '> a\n>\n> XX\n>\n> b', 'word/document.xml', markOf('a'), '$1' + rPr('ins') + '$2', spaces,
        '> a{++\n>\n> ++}&#32;&#32;\n>\n> b\n'],
      ['deleted', 'A.\n\nXX\n\nB.', 'word/document.xml', ownMarkOf('A\\.'), '$1<w:pPr>' + rPr('del') + '</w:pPr>$2',
        '<w:r><w:tab/></w:r>', 'A.{--\n\n--}&#9;\n\nB.\n'],
      ['deleted, in a list item', '- a\n\n  XX\n\n- b', 'word/document.xml', markOf('a'), '$1' + rPr('del') + '$2', spaces,
        '- a{--\n\n  --}&#32;&#32;\n- b\n'],
      ['deleted with its text', 'A.\n\nXX\n\nB.', 'word/document.xml', /(<w:p [^>]*>)<w:r><w:t>A\.<\/w:t><\/w:r>/,
        '$1<w:pPr>' + rPr('del') + '</w:pPr><w:del w:id="92" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>A.</w:delText></w:r></w:del>',
        spaces, '{--A.\n\n--}&#32;&#32;\n\nB.\n'],
      ['inserted, in a note', 'T.[^1]\n\n[^1]: A.\n\n    XX\n\n    B.', 'word/footnotes.xml',
        /(<w:pPr>(?:(?!<\/w:pPr>).)*)(<\/w:pPr>(?:<w:r>(?:(?!<\/w:r>).)*<\/w:r>)*<w:r><w:t>A\.<\/w:t>)/, '$1' + rPr('ins') + '$2', spaces,
        'T.[^1]\n\n[^1]:\n\n    A.{++\n    \n    ++}&#32;&#32;\n\n    B.\n'],
    ])('keeps a paragraph of spaces or tabs alone after one whose mark is %s', async (_name, md, part, mark, to, blank, expected) => {
      // The paragraph lost its text, which the tracked break before it
      // joins to the paragraph before, so the break went with it. Written
      // as they were, at the line's end, export dropped them after the
      // span, and the next import the break the same way.
      const markdown = await withXml(md, part, [mark, to], ['<w:r><w:t>XX</w:t></w:r>', blank]);
      expect(markdown).toBe(expected);
      expect(await roundTrip(markdown)).toBe(markdown);
    });

    test.each([
      ['the body', 'A.\n\nXX{#1}\n\nb{/1} c.\n', 'word/document.xml', 'A.\n\n&#32;&#32;{#1}\n\nb{/1} c.\n', ''],
      ['a note', 'T.[^1]\n\n[^1]: A.\n\n    XX{#1}\n\n    b{/1} c.\n', 'word/footnotes.xml', 'T.[^1]\n\n[^1]: A.\n\n    &#32;&#32;{#1}\n\n    b{/1} c.\n', '    '],
    ])('keeps a comment that starts at the end of a paragraph of spaces alone in %s', async (_name, md, part, expected, indent) => {
      // The paragraph lost its text, and with it the item that holds the
      // start at its mark, so the comment started at the next paragraph's
      const body = indent + '{#1>>@A (2024-01-15 10:30) | c<<}\n';
      const markdown = await withXml(md + body, part, ['<w:r><w:t>XX</w:t></w:r>', spaces]);
      expect(markdown).toBe(expected + body);
      expect(await roundTrip(markdown)).toBe(markdown);
    });

    test.each([
      ['after another', 'A.\n\nXX\n\n<!-- no-indent -->\nB.\n\nC.', spaces, 'A.\n\n<!-- no-indent -->\nB.\n\nC.\n'],
      ['after an empty one', 'A.\n\nXX\n\n<!-- no-indent -->\nB.\n\nC.', '</w:p><w:p>' + spaces, 'A.\n\n<!-- no-indent -->\nB.\n\nC.\n'],
      ['first', 'XX\n\n<!-- no-indent -->\nB.\n\nC.', spaces, '<!-- no-indent -->\nB.\n\nC.\n'],
      ['after a heading', '# H\n\nXX\n\n<!-- no-indent -->\nB.\n\nC.', spaces, '# H\n\n<!-- no-indent -->\nB.\n\nC.\n'],
    ])('keeps the indent override of the paragraph after one of spaces alone %s', async (_name, md, to, expected) => {
      // Export numbered the paragraph, which import no longer counted, so
      // the next paragraph's override went to the one after it
      const markdown = await withXml(md, 'word/document.xml', ['<w:r><w:t>XX</w:t></w:r>', to]);
      expect(markdown).toBe(expected);
      expect(await roundTrip(markdown)).toBe(markdown);
    });

    test.each([
      ['a heading', '# H'], ['a list item', '- l'], ['a rule', '---'],
    ])('keeps the indent override after a code block\'s spacer of spaces alone before %s', async (_name, next) => {
      // Spaces in place of the text, in the paragraph that took the place of
      // the spacer before it too. Import dropped the spacer before the
      // heading, list item or rule, and the count of the paragraph export
      // numbered with it, so the override went to the paragraph after B.
      const md = '```\nc\n```\n\nXX\n\n' + next + '\n\n<!-- no-indent -->\nB.\n\nC.\n';
      const markdown = await withXml(md, 'word/document.xml', [/<\/w:pPr><\/w:p><w:p [^>]*><w:r><w:t>XX<\/w:t><\/w:r>/, '</w:pPr>' + spaces]);
      expect(markdown).toBe('```\nc\n```\n\n' + next + '\n\n<!-- no-indent -->\nB.\n\nC.\n');
      expect(await roundTrip(markdown)).toBe(markdown);
    });

    test('keeps the indent override after a paragraph of spaces alone between two tables', async () => {
      // Import dropped the paragraph between the tables, as it does export's
      // empty one, and its count with it, so the override went to the
      // paragraph after B
      const table = (head: string) => '| ' + head + ' |\n| --- |\n| 1 |\n\n';
      const md = 'A.\n\n' + table('a') + 'XX\n\n' + table('b') + 'B.\n\n<!-- no-indent -->\nC.\n\nD.\n';
      const markdown = await withXml(md, 'word/document.xml', ['<w:r><w:t>XX</w:t></w:r>', spaces]);
      expect(markdown).toBe('A.\n\n' + table('a') + table('b') + 'B.\n\n<!-- no-indent -->\nC.\n\nD.\n');
      expect(await roundTrip(markdown)).toBe(markdown);
    });

    test.each([
      ['deleted', '- [ ] XX\n\n  c', 'del', '- [ ] &#32;&#32;{--\n\n  --}c\n'],
      ['inserted', '- [ ] XX\n\n  c', 'ins', '- [ ] &#32;&#32;{++\n\n  ++}c\n'],
      ['deleted, before another item', '- [ ] XX\n- [ ] c', 'del', '- [ ] &#32;&#32;{--\n\n  --}\n- [ ] c\n'],
    ])('keeps the spaces alone after a task item\'s box whose paragraph\'s mark is %s', async (_name, md, type, expected) => {
      // Import made the item an empty one, but accepting the break the mark
      // is puts the next paragraph's text after them. (Export takes
      // whitespace after the box for the box's, so they don't go back to
      // Word.)
      const markdown = await withXml(md, 'word/document.xml',
        [/(<w:ind w:left="720" w:hanging="360"\/>)(<\/w:pPr>)/, '$1' + rPr(type) + '$2'], ['<w:r><w:t>XX</w:t></w:r>', spaces]);
      expect(markdown).toBe(expected);
    });
  });

  test.each([
    ['a table cell', '| a | b |\n| --- | --- |\n| XX | 2 |', '| a | b |\n| --- | --- |\n| &#32;&#32; | 2 |\n'],
    ['an HTML table cell', '<table>\n  <tr>\n    <td>\n      <p>q</p>\n      <p>XX</p>\n    </td>\n  </tr>\n</table>',
      '<table>\n  <tr>\n    <td>\n      <p>q</p>\n      <p>&#32;&#32;</p>\n    </td>\n  </tr>\n</table>\n'],
    ['a grid table cell', '+-----+-----+\n| x   | y   |\n+=====+=====+\n| XX  | b   |\n+-----+-----+',
      '+------------+-----+\n| x          | y   |\n+============+=====+\n| &#32;&#32; | b   |\n+------------+-----+\n'],
  ])('keeps a paragraph of spaces alone in %s, where an empty one keeps its place', async (_name, md, expected) => {
    // Written as they were, the cell trimmed them, or HTML collapsed them
    const markdown = await withText(md, 'word/document.xml', '  ');
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test('keeps a line of spaces alone after a line break in an HTML table cell', async () => {
    // HTML dropped them at the end of the paragraph, after the <br>
    const md = '<table>\n  <tr>\n    <td>\n      <p>q<br>XX</p>\n    </td>\n  </tr>\n</table>';
    const markdown = await withText(md, 'word/document.xml', '  ');
    expect(markdown).toBe('<table>\n  <tr>\n    <td>\n      <p>q<br>&#32;&#32;</p>\n    </td>\n  </tr>\n</table>\n');
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  test.each([
    ['its paragraph', 'A.\n\nXX\n' + '$' + '$\nx\n' + '$' + '$\n\nB.', 'word/document.xml', 'A.\n\n&#32;&#32;\n' + '$' + '$\nx\n' + '$' + '$\n\nB.\n'],
    ['a note\'s paragraph', 'T.[^1]\n\n[^1]: A.\n\n    XX\n    ' + '$' + '$\n    x\n    ' + '$' + '$',
      'word/footnotes.xml', 'T.[^1]\n\n[^1]: A.\n\n    &#32;&#32;\n    ' + '$' + '$\n    x\n    ' + '$' + '$\n'],
  ])('keeps whitespace alone before an equation in %s', async (_name, md, part, expected) => {
    // Written as it was, Markdown read it as a blank line, which ended the
    // paragraph before the equation. The space export writes for the line
    // end before the equation stays out of the references, or each round
    // trip would add one.
    const markdown = await withText(md, part, '  ');
    expect(markdown).toBe(expected);
    expect(await roundTrip(markdown)).toBe(markdown);
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

  test.each([
    ['a bullet item', '- x\n\n  > [!NOTE] a\n'],
    ['an ordered item', '1. x\n\n   > [!TIP] a\n'],
    ['an item with a wider marker', '10. x\n\n    > [!WARNING] a\n'],
    ['a sublist\'s item', '- x\n  - y\n\n    > [!CAUTION] a\n'],
    ['an item, before a later paragraph', '- x\n\n  > [!IMPORTANT] a\n  >\n  > b\n'],
  ])('keeps text on an alert\'s marker\'s line in %s, with its label shown or hidden', async (_name, md) => {
    // Import took the line break export writes after the label for one the
    // text started with, and wrote the marker on a line of its own
    for (const frontmatter of ['', '---\ncallout-labels: false\n---\n\n']) {
      const { docx } = await convertMdToDocx(frontmatter + md);
      expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')).toBe(md);
    }
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

describe('An alert with nothing after its marker', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
  const hidden = '---\ncallout-labels: false\n---\n\n';

  test.each([
    ['spaces alone on its marker\'s line', '> [!NOTE] &#32;\n', '> [!NOTE]\n'],
    ['a tab alone on its marker\'s line', '> [!TIP] &#9;\n', '> [!TIP]\n'],
    ['spaces alone on the line after its marker', '> [!NOTE]\n> &#32;\n', '> [!NOTE]\n'],
    ['spaces alone before another alert', '> [!CAUTION] &#32;\n> [!WARNING] &#32;\n', '> [!CAUTION]\n> [!WARNING]\n'],
    ['spaces alone in a list item', '- x\n\n  > [!NOTE] &#32;\n', '- x\n\n  > [!NOTE]\n'],
  ])('writes the marker alone for %s, with its label shown or hidden', async (_name, md, expected) => {
    // Import wrote the space after the marker that text on its line goes
    // after, or, with the label hidden, the line end and quote's prefix
    // text on the next line goes after, which the next export read as the
    // marker alone, as Markdown reads spaces alone as nothing
    for (const frontmatter of ['', hidden]) {
      const once = await roundTrip(frontmatter + md);
      expect(strip(once)).toBe(expected);
      expect(await roundTrip(once)).toBe(once);
    }
  });

  test('writes the marker alone for spaces alone before a later paragraph', async () => {
    const once = await roundTrip('> [!IMPORTANT] &#32;&#32;\n>\n> a\n');
    expect(strip(once)).toBe('> [!IMPORTANT]\n>\n> a\n');
    expect(await roundTrip(once)).toBe(once);
  });

  test.each([
    ['alone', '> [!NOTE]\n'],
    ['before a nested quote', '> [!NOTE]\n> > nested\n'],
    ['before a paragraph', '> [!NOTE]\n\na\n'],
    ['before a table', '> [!NOTE]\n\n| a |\n| --- |\n| b |\n'],
    ['before another alert', '> [!NOTE]\n> [!TIP]\n'],
  ])('keeps an alert\'s marker %s where its label is hidden', async (_name, md) => {
    // Its paragraph has nothing in Word, after which import wrote the
    // marker's line end and a quote's prefix, a line of the quote
    expect(strip(await roundTrip(hidden + md))).toBe(md);
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
    // Its line ends were in the paragraph's text, which Word shows as spaces
    ['a code block of lines', '> a\n>\n> ```\n> c\n>   d\n>\n> e\n> ```\n', '> a\n>\n> c\\\n> &#32;&#32;d\\\n> \\\n> e\n', 'Code block inside blockquote exported as a quote paragraph'],
    // Which left an empty paragraph
    ['an empty code block', '> a\n>\n> ```\n>\n> ```\n>\n> b\n', '> a\n>\n> b\n', 'Empty code block inside blockquote dropped during conversion'],
    ['a code block that ends with a blank line', '> ```\n> x\n>\n> ```\n', '> x\n', 'Code block inside blockquote exported as a quote paragraph'],
    ['a code block that ends with a line of spaces', '> ```\n> x\n>   \n> \t\n> ```\n', '> x\n', 'Code block inside blockquote exported as a quote paragraph'],
    ['a code block that starts with a blank line', '> a\n>\n> ```\n>\n> x\n> ```\n', '> a\n>\n> \\\n> x\n', 'Code block inside blockquote exported as a quote paragraph'],
    ['a code block of blank lines', '> a\n>\n> ```\n>\n>\n> ```\n>\n> b\n', '> a\n>\n> b\n', 'Empty code block inside blockquote dropped during conversion'],
    // Whose line read as an alert's marker
    ['a code block with an alert\'s marker', '> a\n>\n> ```\n> x\n> [!NOTE]\n> ```\n', '> a\n>\n> x\\\n> \\[!NOTE]\n', 'Code block inside blockquote exported as a quote paragraph'],
    ['a code block that starts with an alert\'s marker', '> a\n>\n> ```\n> [!NOTE]\n> ```\n', '> a\n>\n> \\[!NOTE]\n', 'Code block inside blockquote exported as a quote paragraph'],
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

  test('keeps a code block of a space that is text', async () => {
    // U+3000 read as a blank line's, and the block was dropped as empty
    const { docx } = await convertMdToDocx('> ```\n> \u3000\n> ```\n');
    expect(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).toContain('<w:t>\u3000</w:t>');
  });

  test.each([['U+3000', '\u3000', '&#12288;'], ['an em space', '\u2003', '&#8195;']])('keeps a code block\'s last line of %s, which markdown-it trims', async (_name, space, reference) => {
    // Written as itself after the line's break, the paragraph's trim took
    // it, and left the break's backslash as text
    const md = '> x\\\n> ' + reference + '\n';
    const { docx } = await convertMdToDocx('> ```\n> x\n> ' + space + '\n> ```\n');
    expect(strip((await convertDocx(docx)).markdown)).toBe(md);
    expect(strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown)).toBe(md);
  });

  test('ends a code block\'s text before a last line of characters XML can\'t hold', async () => {
    // Its line break stayed when they went, and ended the paragraph
    const { docx, warnings } = await convertMdToDocx('> ```\n> x\n> \uFFFF\n> ```\n');
    expect(warnings).toContain('Removed 1 character a Word document can\'t hold, such as control characters');
    expect(strip((await convertDocx(docx)).markdown)).toBe('> x\n');
  });
});

describe('Blocks a note can\'t hold', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const note = (body: string) => 'T.[^1]\n\n[^1]: A.\n\n    ' + body.replace(/\n(?!\n)/g, '\n    ') + '\n';
  test.each([
    // Which left an empty paragraph
    ['an empty code block', note('```\n```\n\nB.'), note('B.'), 'Empty code block inside a note dropped during conversion'],
    ['a horizontal rule', note('---\n\nB.'), note('B.'), 'Horizontal rule inside a note dropped during conversion'],
    // Which a note, with no sections, can't hold, and which left two
    ['an orientation directive', note('<!-- landscape -->\n\nB.\n\n<!-- /landscape -->'), note('B.'), 'Orientation directive inside a note ignored'],
    ['a list', note('- a\n- b'), note('a\n\nb'), 'List inside a note exported as note paragraphs'],
    ['a quote', note('> q'), note('q'), 'Blockquote inside a note exported as note paragraphs'],
    ['a heading', note('# h'), note('h'), 'Heading inside a note exported as a note paragraph'],
  ])('warns of %s', async (_name, md, expected, warning) => {
    // Export changed each with no warning
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([warning + ' (not supported). Move it outside the note for round-trip fidelity.']);
    expect(strip((await convertDocx(docx)).markdown)).toBe(expected);
  });

  test.each([
    ['an alert', note('> [!NOTE]\n> B.')],
    ['an alert with its text after a blank line', note('> [!NOTE]\n>\n> B.')],
    ['an empty list item', note('-\n- B.')],
    ['an empty heading', note('#\n\nB.')],
    ['an orientation directive', note('<!-- landscape -->\n\nB.\n\n<!-- /landscape -->')],
  ])('writes %s with no empty paragraph, or space before its text', async (_name, md) => {
    // An empty list item, heading or alert left an empty paragraph, which
    // import dropped, and an alert's text started with a space for the line
    // end after its marker
    const { docx } = await convertMdToDocx(md);
    const xml = await (await JSZip.loadAsync(docx)).file('word/footnotes.xml')!.async('string');
    const body = /<w:footnote [^>]*w:id="1"[^>]*>([\s\S]*?)<\/w:footnote>/.exec(xml)![1];
    const paragraphs = [...body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(p => p[0].replace(/<w:pPr>[\s\S]*?<\/w:pPr>|<w:rPr>[\s\S]*?<\/w:rPr>/g, '').replace(/<[^>]+>/g, ''));
    // The first after the space after the note's mark
    expect(paragraphs).toEqual([' A.', 'B.']);
  });

  test.each([
    ['a code block', note('```\nc\n  d\n```'), note('```\nc\n  d\n```')],
    ['an indented code block', note('    c'), note('```\nc\n```')],
    ['a code block that starts it', 'T.[^1]\n\n[^1]: ```\n    a\n    b\n    ```\n', 'T.[^1]\n\n[^1]:\n\n    ```\n    a\n    b\n    ```\n'],
  ])('keeps %s in a note a code block, with no warning', async (_name, md, expected) => {
    // A note holds a code block, which it wrote as its lines in a paragraph
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);
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
    // The line break went with the line end before the bodies
    ['after a line break and overlapping comments', 'Seen {#1}a {#2}b{/1} c{/2}\\\n{#1>>one<<}\n{#2>>two<<}\n' + math('') + '\n'],
    ['after two line breaks and overlapping comments', 'Seen {#1}a {#2}b{/1} c{/2}\\\n\\\n{#1>>one<<}\n{#2>>two<<}\n' + math('') + '\n'],
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

  test('keeps an empty line at the end, which Word shows', () => {
    const content: ContentItem[] = [
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: 'code', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      { type: 'para', isCodeBlock: true },
      { type: 'text', text: '', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
    ];
    const md = buildMarkdown(content, new Map());
    expect(md).toBe('```\ncode\n\n```');
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
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // The body of the comment w:id="0" that a test's runs put in
  const commentsXml = '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:comment w:id="0" w:author="A"><w:p><w:r><w:t>c</w:t></w:r></w:p></w:comment></w:comments>';

  test.each([
    ['an empty line', '```\na\n\n```'],
    ['two empty lines', '```\na\n\n\n```'],
    ['empty lines only', '```\n\n\n```'],
  ])('keeps a code block that ends in %s', async (_, md) => {
    // Word shows each as a line of the block, which import took off
    const result = await convertDocx((await convertMdToDocx(md + '\n\nAfter.')).docx);
    expect(result.markdown.trim()).toBe(md + '\n\nAfter.');
  });

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

  test.each([
    ['a backtick', '~~~a`b\ncode\n~~~'],
    ['a backtick, and tildes in its code', '~~~~~a`b\n~~~~ x\n~~~~~'],
  ])('keeps a language with %s in a fence of tildes', async (_, md) => {
    // A backtick fence, whose info string can't hold one, was text
    const result = await convertDocx((await convertMdToDocx(md)).docx);
    expect(result.markdown.trim()).toBe(md);
  });

  test('keeps a language that starts with a tilde and has a backtick out of its fence', async () => {
    // The fence of tildes took its tilde, and the closing fence was shorter
    const zip = await JSZip.loadAsync((await convertMdToDocx('```x\ncode\n```')).docx);
    const xml = await zip.file('docProps/custom.xml')!.async('string');
    const edited = xml.replace('{"0":"x"}', '{"0":"~a`b"}');
    expect(edited).not.toBe(xml);
    zip.file('docProps/custom.xml', edited);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown.trim()).toBe('~~~ ~a`b\ncode\n~~~');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  test('reads an empty paragraph a Word user adds after a code block as the blank line before the heading', async () => {
    // As it reads one before any heading: export reads more blank lines as
    // one, so the next trip would drop them
    const zip = await JSZip.loadAsync((await convertMdToDocx('```\ncode\n```\n\n## H')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:p\b[^>]*><w:pPr><w:spacing w:after="0"\/><\/w:pPr><\/w:p>/, '<w:p/>'));
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown.trim()).toBe('```\ncode\n```\n\n## H');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
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

  test.each([
    ['after its text', '[^a]: Note.\n\n    ```js\n    a\n    b\n    ```\n'],
    ['first', '[^a]:\n\n    ```js\n    a\n    ```\n'],
    ['before text', '[^a]: Note.\n\n    ```js\n    a\n    ```\n\n    After.\n'],
    ['after another', '[^a]: Note.\n\n    ```js\n    a\n    ```\n\n    ```py\n    b\n    ```\n'],
    ['by a table', '[^a]: Note.\n\n    ```js\n    a\n    ```\n\n    | x |\n    | --- |\n    | 1 |\n\n    ```py\n    b\n    ```\n'],
    ['with an empty line', '[^a]: Note.\n\n    ```js\n    a\n    \n    b\n    ```\n'],
  ])('keeps a code block in a note %s, and its language', async (_, note) => {
    // Export wrote one as the note's text, its lines run together in Word,
    // and import as text
    const md = 'Text.[^a]\n\n' + note;
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown).toBe(md);
  });

  test('numbers code blocks in notes on from the body\'s, in the order of the notes\' labels', async () => {
    const note = (label: string, lang: string) => '[^' + label + ']: Note.\n\n    ```' + lang + '\n    x\n    ```\n';
    const text = '```r\nx\n```\n\nText[^b] and[^a].\n\n';
    expect((await convertDocx((await convertMdToDocx(text + note('b', 'py') + '\n' + note('a', 'js'))).docx)).markdown)
      .toBe(text + note('a', 'js') + '\n' + note('b', 'py'));
  });

  test('numbers code blocks in notes after one only another note refers to', async () => {
    // Export numbered that one's in its label's turn, but import, which
    // writes only the notes the text refers to, doesn't read it
    const note = (label: string, lang: string, text = 'Note.') => '[^' + label + ']: ' + text + '\n\n    ```' + lang + '\n    x\n    ```\n';
    const md = 'T[^a] and[^c].\n\n' + note('a', 'python', 'A[^b].') + '\n' + note('b', 'js') + '\n' + note('c', 'r');
    expect(strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown))
      .toBe('T[^a] and[^c].\n\n' + note('a', 'python', 'A.') + '\n' + note('c', 'r'));
  });

  test.each([
    ['the body', '```py\nXX\nYY\n```\n', 'word/document.xml', '```py\nXX\nZZ\nYY\n```\n'],
    ['a note', 'T.[^1]\n\n[^1]: A.\n\n    ```py\n    XX\n    YY\n    ```\n', 'word/footnotes.xml',
      'T.[^1]\n\n[^1]: A.\n\n    ```py\n    XX\n    ZZ\n    YY\n    ```\n'],
  ])('ends a code line at a line break of Word\'s in %s', async (_name, md, part, expected) => {
    // It came back as Markdown's, \\ and a line end, which put a \\ in the code
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file(part)!.async('string');
    const broken = xml.replace('<w:t>XX</w:t>', '<w:t>XX</w:t><w:br/><w:t>ZZ</w:t>');
    expect(broken).not.toBe(xml);
    zip.file(part, broken);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)).toBe(expected);
  });

  test('drops Word\'s space after the note\'s mark in a code paragraph that holds it', async () => {
    // A Word user made the note's first paragraph, its mark's, code
    const zip = await JSZip.loadAsync((await convertMdToDocx('Text.[^a]\n\n[^a]: XX\n')).docx);
    const xml = await zip.file('word/footnotes.xml')!.async('string');
    const edited = xml.replace('<w:pStyle w:val="FootnoteText"/>', '<w:pStyle w:val="CodeBlock"/>')
      .replace(NOTE_SEPARATOR + '<w:r><w:t>XX</w:t></w:r>', '<w:r><w:t xml:space="preserve"> x = 1</w:t></w:r>');
    expect(edited).toContain('CodeBlock');
    zip.file('word/footnotes.xml', edited);
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown)
      .toBe('Text.[^a]\n\n[^a]:\n\n    ```\n    x = 1\n    ```\n');
  });

  test.each([
    ['a tracked change', '<w:del w:id="91" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>old</w:delText></w:r></w:del>'
      + '<w:ins w:id="92" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t>new</w:t></w:r></w:ins>', '{~~old~>new~~}'],
    ['a comment', '<w:commentRangeStart w:id="0"/><w:r><w:t>x</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>', '{==x==}{>>@A | c<<}'],
  ])('keeps a code block in a note with %s as the note\'s paragraphs, which keep it', async (_name, runs, line) => {
    // A code block can't hold it, which went, and a deletion's text with it
    // as the code's
    const zip = await JSZip.loadAsync((await convertMdToDocx('T.[^1]\n\n[^1]: ```\n    XX\n    b\n    ```\n\n    After.\n')).docx);
    const xml = await zip.file('word/footnotes.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>XX<\/w:t><\/w:r>/s, runs);
    expect(edited).not.toBe(xml);
    zip.file('word/footnotes.xml', edited);
    zip.file('word/comments.xml', commentsXml);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown))
      .toBe('T.[^1]\n\n[^1]: ' + line + '\n\n    b\n\n    After.\n');
  });

  test.each([
    // Which went as two, as the code's text took none
    ['a comment across its lines', [
      [/<w:r>(?:(?!<w:r>).)*?<w:t>XX<\/w:t><\/w:r>/s, '<w:commentRangeStart w:id="0"/><w:r><w:t>XX</w:t></w:r>'],
      [/<w:r>(?:(?!<w:r>).)*?<w:t>YY<\/w:t><\/w:r>/s, '<w:r><w:t>YY</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>'],
    ], '    {#1}XX\n\n    YY{/1}\n    {#1>>@A | c<<}'],
    // Which ended the block, whose next lines took the next block's language
    ['an equation', [[/<w:t>XX<\/w:t><\/w:r>/, '<w:t>XX</w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>']], '    X&#88;$x$\n\n    YY'],
    // Which joins it to the paragraph before, whose deletion took the break
    // in, but not into a code block
    ['a tracked break before it', [
      [/<w:pStyle w:val="FootnoteText"\/><\/w:pPr>/, '<w:pStyle w:val="FootnoteText"/><w:rPr><w:del w:id="93" w:author="A" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>'],
      [/<w:t>A\.<\/w:t><\/w:r>/, '<w:t xml:space="preserve">A. </w:t></w:r><w:del w:id="94" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>cut</w:delText></w:r></w:del>'],
    ], '[^1]:\n\n    A. {--cut\n    \n    --}XX\n\n    YY'],
  ] as [string, [RegExp, string][], string, string?][])('keeps a code block in a note with %s as the note\'s paragraphs, and the next its language', async (_name, edits, lines, bodies = '') => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('T.[^1]\n\n[^1]: A.\n\n    ```py\n    XX\n    YY\n    ```\n\n    ```js\n    ZZ\n    ```\n')).docx);
    let xml = await zip.file('word/footnotes.xml')!.async('string');
    for (const [find, replacement] of edits) {
      expect(xml).toMatch(find);
      xml = xml.replace(find, replacement);
    }
    zip.file('word/footnotes.xml', xml);
    zip.file('word/comments.xml', commentsXml);
    expect(strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown))
      .toBe('T.[^1]\n\n' + (lines.startsWith('[^1]:') ? '' : '[^1]: A.\n\n') + lines + '\n\n    ```js\n    ZZ\n    ```\n' + bodies);
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

  test('wrapWithFormatting keeps bold around code', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true, bold: true };
    expect(wrapWithFormatting('hello', fmt)).toBe('**`hello`**');
  });

  test('wrapWithFormatting keeps italic around code', () => {
    const fmt = { ...DEFAULT_FORMATTING, code: true, italic: true };
    expect(wrapWithFormatting('hello', fmt)).toBe('*`hello`*');
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

  test.each([
    '**`bold code`**', '*`italic code`*', '~~`struck code`~~', '<u>`underlined code`</u>', '<sup>`raised code`</sup>',
    '***~~<u>==<sup>`text`</sup>==</u>~~***', 'a<i>`b`</i>c', '*`a`*<b>`b`</b>',
  ])('keeps the formatting around inline code in %s on round-trip', async (md) => {
    // Code dropped it, though export writes it onto the code
    const result = await convertDocx((await convertMdToDocx(md)).docx);
    expect(result.markdown.trim()).toBe(md);
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

    test.each([
      ['{--One {==a==}{>>c<<} end--}', '{--One --}{=={--a--}==}{>>c<<}{-- end--}'],
      ['{--a {>>c<<} b--}', '{--a --}{>>c<<}{-- b--}'],
      ['{--a {#1}b{/1} c--}\n{#1>>c<<}', '{--a --}{=={--b--}==}{>>c<<}{-- c--}'],
      ['{#1>>c<<}{>>r<<}\n\n{--a {#1}b{/1} c--}', '{--a --}{=={--b--}==}{>>c<<}{>>r<<}{-- c--}'],
      ['{~~a {==b==}{>>c<<} d~>x~~}', '{--a --}{=={--b--}==}{>>c<<}{~~ d~>x~~}'],
      ['{--a {++b {>>c<<}++} d--}', '{--a b --}{>>c<<}{-- d--}'],
      ['{++a {#1}b{/1} c++}\n{#1>>c<<}', '{++a ++}{=={++b++}==}{>>c<<}{++ c++}'],
      ['{==b {#1}x{/1}==}{>>c<<}\n{#1>>d<<}', '{#1}b {#2}x{/1}{/2}\n{#1>>c<<}\n{#2>>d<<}'],
      ['{--a {==b {#1}x{/1}==}{>>c<<}--}\n{#1>>d<<}', '{--a --}{#1}{--b --}{#2}{--x--}{/1}{/2}\n{#1>>c<<}\n{#2>>d<<}'],
    ])('keeps the comment in %j', async (md, expected) => {
      // Export skipped a comment in deleted text, and read {#id} and {/id} in
      // a revision's text as literal text, so the comment was lost
      const roundTrip = async (source: string) =>
        (await convertDocx((await convertMdToDocx(source)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
      const md2 = await roundTrip(md);
      expect(md2).toBe(expected + '\n');
      expect(await roundTrip(md2)).toBe(md2);
    });

    test.each([
      ['{++{#1}x{/1}\n{#1>>c<<}++}', '{=={++x++}==}{>>c<<}'],
      ['{--{#1}x{/1}\n{#1>>c<<}--}', '{=={--x--}==}{>>c<<}'],
      ['{~~y~>{#1}x{/1}\n{#1>>c<<}~~}', '{--y--}{=={++x++}==}{>>c<<}'],
      ['{=={#1}x{/1}\n{#1>>c<<}==}{>>d<<}', '{#1}{#2}x{/1}{/2}\n{#1>>d<<}\n{#2>>c<<}'],
      ['{++a {--{#1}x{/1}\n{#1>>c<<}--}++}', '{++a ++}{=={--x--}==}{>>c<<}'],
      ['{++{#1}x{/1} {#1>>c<<}++}', '{=={++x++}==}{>>c<<}'],
      // A revision of a body alone has no text, so it's a body on its line
      ['{#1}x{/1}\n{++{#1>>c<<}++}', '{==x==}{>>c<<}'],
      ['{#1}x{/1}\n{--{#1>>c<<}--}', '{==x==}{>>c<<}'],
    ])('drops the line break before a comment body on its own line in %j', async (md, expected) => {
      // Only a paragraph's own lines lost it, so the break in a revision's
      // text exported as a space, or with breaks: true as a line break
      for (const front of ['', '---\nbreaks: true\n---\n\n']) {
        const { docx } = await convertMdToDocx(front + md);
        const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
        expect(xml).not.toContain('<w:br/>');
        expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')).toBe(expected + '\n');
      }
    });

    test.each([
      ['{++a {#1}x{/1}\n{#1>>c<<}\nb++}', '{++a ++}{=={++x++}==}{>>c<<}{++ b++}', '{++a ++}{=={++x++}==}{>>c<<}{++\\\nb++}'],
      // As x\n{#1>>c<<}y keeps it, with the change marked as Word shows it
      ['{~~{#1}x{/1}\n{#1>>c<<}~>y~~}', '{=={--x--}==}{>>c<<}{~~ ~>y~~}', '{=={--x--}==}{>>c<<}{~~\\\n~>y~~}'],
    ])('keeps one line break across a comment body on its own line in %j', async (md, plain, withBreaks) => {
      for (const [front, expected] of [['', plain], ['---\nbreaks: true\n---\n\n', withBreaks]]) {
        const { docx } = await convertMdToDocx(front + md);
        expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')).toBe(expected + '\n');
      }
    });

    test.each([
      ['{--### A {>>c<<}--}', '{--### A --}{>>c<<}'],
      ['{--### A {#1}b{/1}--}\n{#1>>c<<}', '{--### A --}{=={--b--}==}{>>c<<}'],
      ['{++### A {#1}b{/1}++}\n{#1>>c<<}', '{++### A ++}{=={++b++}==}{>>c<<}'],
    ])('keeps the heading of %j, and its comment', async (md, expected) => {
      // A comment between a revised heading's spans, as import writes it, or
      // its body on a line after, made it text, with a literal ###
      const roundTrip = async (source: string) =>
        (await convertDocx((await convertMdToDocx(source)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
      const md2 = await roundTrip(md);
      expect(md2).toBe(expected + '\n');
      expect(await roundTrip(md2)).toBe(md2);
    });

    test.each([
      ['{--### {==Heading==}{>>comment<<}--}', '{--### --}{=={--Heading--}==}{>>comment<<}'],
      ['{++### {==Heading==}{>>comment<<}++}', '{++### ++}{=={++Heading++}==}{>>comment<<}'],
      ['Prefix {--a{>>c<<}\n\nb--} suffix', 'Prefix {--a\n\n--}{>>c<<}{--b--} suffix'],
      ['Prefix {++a{>>c<<}\n\nb++} suffix', 'Prefix {++a\n\n++}{>>c<<}{++b++} suffix'],
      ['Prefix {~~a{>>c<<}~>\n\nb~~} suffix', 'Prefix {~~a~>\n\n~~}{>>c<<}{++b++} suffix'],
      // An anchor that ends at the break holds it, and export splits it there
      ['Prefix {--a{==b==}{>>c<<}\n\nd--} suffix', 'Prefix {--a--}{=={--b\n\n--}==}{>>c<<}{--d--} suffix'],
      ['Prefix {++a{==b==}{>>c<<}\n\nd++} suffix', 'Prefix {++a++}{=={++b\n\n++}==}{>>c<<}{++d++} suffix'],
      // An anchor of a substitution's old side alone holds the break that
      // opens its new side, a span of the break alone, which export kept
      // in the span to split the anchor at, not moved before it
      ['Prefix {~~{==x==}{>>c<<}~>\n\nb~~} suffix', 'Prefix {=={--x--}{++\n\n++}==}{>>c<<}{++b++} suffix'],
      // A range with text on both sides of the break takes ID syntax, as one
      // across an untracked break does, which {==...==} couldn't hold
      ['P {++{#1}a\n\nb{/1}++} Q\n{#1>>c<<}', 'P {#1}{++a\n\nb++}{/1} Q\n{#1>>c<<}'],
      ['P {--{#1}a\n\nb{/1}--} Q\n{#1>>c<<}', 'P {#1}{--a\n\nb--}{/1} Q\n{#1>>c<<}'],
      ['{--### {>>c<<}--}', '{--### --}{>>c<<}'],
      ['{++### {>>c<<}++}', '{++### ++}{>>c<<}'],
    ])('keeps the revised paragraph mark of %j, beside a comment', async (md, expected) => {
      // Import wrote the heading's marker before the comment's anchor, outside
      // any span, and ended the paragraph its comment ended as an untracked
      // one, so the next export lost the mark's revision
      const roundTrip = async (source: string) =>
        (await convertDocx((await convertMdToDocx(source)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
      const md2 = await roundTrip(md);
      expect(md2).toBe(expected + '\n');
      expect(await roundTrip(md2)).toBe(md2);
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md2)).docx)).file('word/document.xml')!.async('string');
      expect(xml).toMatch(/<w:pPr>(?:(?!<\/w:pPr>).)*<w:rPr>(?:(?!<\/w:rPr>).)*<w:(?:del|ins) /);
    });

    test('keeps the replies of a comment whose anchor export splits at a tracked break', async () => {
      // The replies went after the break, away from the comment they reply to
      const md = 'Prefix {=={--a\n\n--}==}{>>c<<}{>>r<<}{--b--} suffix';
      const { docx } = await convertMdToDocx(md);
      const extended = await (await JSZip.loadAsync(docx)).file('word/commentsExtended.xml')!.async('string');
      expect(extended).toContain('w15:paraIdParent');
      expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '')).toBe(md + '\n');
    });

    test('keeps a line break at the start of a comment\'s anchor export splits at a tracked break', async () => {
      // Export dropped every line break at the anchor's edges, as at a block's
      const md = 'x\n\n{==\\\nq{++a\n\n++}==}{>>c<<}bc';
      const { docx } = await convertMdToDocx(md);
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml.slice(xml.indexOf('<w:body>')).split(/<w:p[ >]/)[2]).toContain('<w:br/>');
      expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '')).toBe(md + '\n');
    });

    test('keeps the text after a tracked break in its comment\'s anchor', async () => {
      // Export ended the anchor at the break, so b went after the comment's range
      const { docx } = await convertMdToDocx('{=={--a\n\nb--}==}{>>c<<}');
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml).toMatch(/<w:delText>b<\/w:delText><\/w:r><\/w:del><w:commentRangeEnd /);
    });

    test.each([
      ['{#1}x{/1}\n\n{++### ++}{++a\n\n{#1>>c<<}++}', '{==x==}{>>c<<}\n\n{++### a++}'],
      // The paragraph's tracked mark, the last's, is the break in the span
      ['{#1}x{/1}\n\n{++a\n\n{#1>>c<<}++}', '{==x==}{>>c<<}\n\n{++a\n\n++}'],
    ])('keeps a comment body after a blank line in a revision in %j', async (md, expected) => {
      // Dropping the break before the body took one of the blank line's two,
      // so the split there took the body for the other
      const { docx, warnings } = await convertMdToDocx(md);
      expect(warnings).toEqual([]);
      expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '')).toBe(expected + '\n');
    });

    test.each([
      ['an untracked tail', [{ text: 'a', ids: ['1'], revision: 'addition' }, { text: ' tail' }], '### {=={++a++}==}{>>c<<} tail'],
      ['an untracked tail without a comment', [{ text: 'a', revision: 'addition' }, { text: ' tail' }], '### {++a++} tail'],
      ['a deletion', [{ text: 'a', ids: ['1'], revision: 'addition' }, { text: 'b', revision: 'deletion' }], '### {=={++a++}==}{>>c<<}{--b--}'],
      ['its revision alone', [{ text: 'a', ids: ['1'], revision: 'addition' }], '{++### ++}{=={++a++}==}{>>c<<}'],
    ] as Array<[string, Array<{ text: string; ids?: string[]; revision?: 'addition' | 'deletion' }>, string]>)(
      'writes the marker of a heading whose mark is inserted, with %s, where export reads the heading back', (_name, runs, expected) => {
      // A span of the marker made export read a heading with more than the
      // revision as a paragraph, with a literal ###
      const content: ContentItem[] = [
        { type: 'para', headingLevel: 3, paraMarkRevision: { type: 'addition', author: 'A', date: '' } },
        ...runs.map((run): ContentItem => ({ type: 'text', text: run.text, commentIds: new Set(run.ids ?? []), formatting: DEFAULT_FORMATTING,
          ...(run.revision ? { revision: { type: run.revision, author: 'A', date: '' } } : {}) })),
      ];
      expect(buildMarkdown(content, new Map([['1', { author: '', date: '', text: 'c' }]]))).toBe(expected);
    });

    test('gives a revised heading\'s mark its revision\'s author, not a comment\'s before its text', async () => {
      const { docx } = await convertMdToDocx('{++### ++}{>>@Alice (2024-01-01 12:00) | c<<}{++H++}', { authorName: 'Bob' });
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml).toContain('<w:pStyle w:val="Heading3"/><w:rPr><w:ins w:id="0" w:author="Bob"/></w:rPr>');
    });

    test('drops the line breaks of comment body lines across a revision\'s end', async () => {
      // Each revision's text lost its own, so the body line that ran on past
      // its end kept the break after it
      const { docx } = await convertMdToDocx('---\nbreaks: true\n---\n\n{++{#1}x{/1}\n{#1>>c<<}\n++}{#2>>d<<}\n{#2}y{/2}');
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml.match(/<w:br\/>/g)).toHaveLength(1);
    });

    test.each([
      ['<u>{++a {#1}x{/1} {#1>>c<<}++}</u>', '{++<u>a </u>++}{=={++<u>x</u>++}==}{>>c<<}{++<u> </u>++}'],
      ['<u>a {#1}x{/1} {#1>>c<<}</u>', '<u>a </u>{==<u>x</u>==}{>>c<<}<u> </u>'],
    ])('keeps the underlined space before a comment body in %j', async (md, expected) => {
      // A revision's text lost it, as its runs don't hold the underline around it
      const { docx } = await convertMdToDocx(md);
      expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '')).toBe(expected + '\n');
    });

    test('drops the line break before a comment body on its own line after a revision that ends in one', async () => {
      // The revision before it was no line break, though its text ended in one
      const { docx } = await convertMdToDocx('---\nbreaks: true\n---\n\n{#1}x{/1}{++a\n++}{++{#1>>c<<}\nb++}');
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml.match(/<w:br\/>/g)).toHaveLength(1);
    });

    test.each([
      ['a <br> at the end of its range', 'x{#1}a<br>{/1}{#1>>c<<}', 1, 'x{==a\\\n==}{>>c<<}'],
      ['a \\ at the end of its range', 'x{#1}a\\\n{/1}{#1>>c<<}', 1, 'x{==a\\\n==}{>>c<<}'],
      ['a <br> at the end of the second of two ranges that overlap', 'x{#1}a{#2}b{/1}c<br>{/2}{#1>>c<<}{#2>>d<<}', 1,
        'x{#1}a{#2}b{/1}c\\\n{/2}\n{#1>>c<<}\n{#2>>d<<}'],
      ['a <br> after its range', 'x{#1}a{/1}<br>{#1>>c<<}', 1, 'x{==a==}{>>c<<}<br>'],
      ['a <br> after the bodies', 'x{#1}a<br>{/1}{#1>>c<<}<br>y', 2, 'x{==a\\\n==}{>>c<<}\\\ny'],
      ['a \\ after a body on its own line', 'x{#1}a{/1}\n{#1>>c<<}\\\ny', 1, 'x{==a==}{>>c<<}\\\ny'],
      ['a <br> at the end of its range in a table\'s cell', '| a | b |\n|---|---|\n| x{#1}a<br>{/1}{#1>>c<<} | y |', 1,
        '| a | b |\n| --- | --- |\n| x{==a<br>==}{>>c<<} | y |'],
    ])('keeps %s beside a comment body, which Word shows', async (_name, md, count, expected) => {
      // Export dropped it as the newline import writes before a body's line
      const { docx } = await convertMdToDocx(md);
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml.match(/<w:br\/>/g)).toHaveLength(count);
      const back = (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
      expect(back).toBe(expected + '\n');
      const again = (await convertDocx((await convertMdToDocx(back)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
      expect(again).toBe(back);
    });

    test.each([
      ['{--<u>{++a\n{>>c<<}b++}</u>--}', '<w:u w:val="single"/>'],
      ['{--==x {++a\n{>>c<<}b++}==--}', '<w:highlight w:val="yellow"/>'],
    ])('keeps the formatting of a deleted line break beside a comment in %j', async (md, rPr) => {
      // The deletion around the break had the outer deletion's formatting alone
      const { docx } = await convertMdToDocx(md);
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml).toContain('<w:r><w:rPr>' + rPr + '</w:rPr><w:delText xml:space="preserve"> </w:delText></w:r>');
    });

    test('keeps the new text of a substitution split at display math whose old text is a comment body', async () => {
      const math = (tex: string) => '$' + '$' + tex + '$' + '$';
      const { docx } = await convertMdToDocx('{#1}x{/1}\n\n{~~{#1>>c<<} ' + math('u') + '~>a ' + math('v') + '~~}');
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml).toMatch(/<w:ins [^>]*><w:r><w:t xml:space="preserve">a /);
    });

    test.each(['{++{#1>>c<<}++}', '{--{#1>>c<<}--}', '{~~{#1>>c<<}~>{#2>>d<<}~~}'])('writes no paragraph for %j after its own', async (body) => {
      // Word got an empty paragraph, as the revision hid the body
      const { docx } = await convertMdToDocx('{#1}x{/1}{#2}y{/2}\n\n' + body);
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml.match(/<w:p[ >]/g)).toHaveLength(1);
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

    test.each([
      ['a quote\'s marker', '> q'],
      ['a list item\'s marker', '- q'],
      ['a heading\'s marker', '# q'],
      ['an ordered list item\'s marker', '1. q'],
      ['a list item\'s + marker', '+ q'],
      ['an HTML block\'s tag', '<div>'],
    ])('keeps %s at the start of a line after a line break on a side of a substitution of several runs as text', async (_name, line) => {
      // It went unescaped there, where it starts a block, so Word's one
      // paragraph came back as two
      const run = (text: string, revision: RevisionInfo, bold = false): ContentItem =>
        ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, bold }, revision });
      const md = buildMarkdown([{ type: 'para' } as any, run('q ', undefined as any), run('old', delRev), run('a\\\n', addRev, true), run(line + '\\\n', addRev), run('z', addRev)], new Map());
      expect(md).toContain('{~~');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      const body = xml.slice(xml.indexOf('<w:body>'), xml.indexOf('<w:sectPr'));
      expect(body.match(/<w:p[ >]/g)).toHaveLength(1);
      expect(body.replace(/<w:br\/>/g, '↵').replace(/<[^>]+>/g, '').trim()).toBe('q olda↵' + line.replace('<', '&lt;').replace('>', '&gt;') + '↵z');
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

    test.each([
      ['a deletion in a comment\'s range before it', true, false],
      ['an insertion in a comment\'s range after it', false, false],
      ['a deletion in a comment\'s range before it, in ID syntax', true, true],
      ['an insertion in a comment\'s range after it, in ID syntax', false, true],
    ])('writes a substitution next to %s', (_name, before, ids) => {
      // The neighbour of its revision kept the pair from standing alone,
      // though no side could take it, and in ID syntax a pair whose
      // comments weren't those open didn't pair
      const text = (t: string, revision: typeof delRev, commented = false): ContentItem =>
        ({ type: 'text', text: t, commentIds: new Set(commented ? ['c1'] : []), formatting: DEFAULT_FORMATTING, revision });
      const content: ContentItem[] = before
        ? [{ type: 'para' } as any, text('d', delRev, true), text('old', delRev), text('new', addRev)]
        : [{ type: 'para' } as any, text('old', delRev), text('new', addRev), text('n', addRev, true)];
      const comments = new Map([['c1', { author: 'R', text: 'review', date: '' } as any]]);
      expect(buildMarkdown(content, comments, { alwaysUseCommentIds: ids })).toContain('{~~old~>new~~}');
    });

    test('keeps inline math after a $ on the new side of a substitution after a comment\'s range in ID syntax', async () => {
      // The substitution, which now forms there, ran the $ into the
      // equation's own
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'commented', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING },
        { type: 'text', text: 'old', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: delRev },
        { type: 'text', text: 'a$', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: addRev },
        { type: 'math', latex: 'z', display: false, commentIds: new Set(), revision: addRev },
      ];
      const comments = new Map([['c1', { author: 'R', text: 'review', date: '' } as any]]);
      const md = buildMarkdown(content, comments, { alwaysUseCommentIds: true });
      expect(md).toContain('{~~old~>a\\$$z$~~}');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(xml).toContain('<m:oMath>');
    });

    test('keeps the $ of text after inline math on the new side of a substitution in a comment\'s range in ID syntax as text', async () => {
      // The substitution, which now forms there, wrote the letter after the
      // equation as a reference, after which the text's $a$ was math
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'text', text: 'q', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
        { type: 'text', text: 'y', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING, revision: delRev },
        { type: 'math', latex: 'z', display: false, commentIds: new Set(['c1']), revision: addRev },
        { type: 'text', text: 'x$a$', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING, revision: addRev },
        { type: 'text', text: 'w', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      ];
      const comments = new Map([['c1', { author: 'R', text: 'review', date: '' } as any]]);
      const md = buildMarkdown(content, comments, { alwaysUseCommentIds: true });
      expect(md).toContain('{~~y~>$z$&#120;\\$a$~~}');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(xml.match(/<m:oMath>/g)).toHaveLength(1);
      expect(xml).toContain('<w:t>x$a$</w:t>');
    });

    test('keeps inline math after a citation without keys on the old side of a substitution in a comment\'s range in ID syntax', async () => {
      // The substitution, which now forms there, wrote the citation's digit
      // before the equation's $, which then didn't open it
      const content: ContentItem[] = [
        { type: 'para' } as any,
        { type: 'citation', text: '1', commentIds: new Set(['c1']), pandocKeys: [], revision: delRev },
        { type: 'math', latex: 'z', display: false, commentIds: new Set(['c1']), revision: delRev },
        { type: 'text', text: 'new', commentIds: new Set(['c1']), formatting: DEFAULT_FORMATTING, revision: addRev },
      ];
      const comments = new Map([['c1', { author: 'R', text: 'review', date: '' } as any]]);
      const md = buildMarkdown(content, comments, { alwaysUseCommentIds: true });
      expect(md).toContain('~>new~~}');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(xml).toContain('<m:oMath>');
      expect(xml).toContain('<w:delText>1</w:delText>');
    });

    test('keeps the tracked mark of a paragraph whose deletion before it follows one in a comment\'s range', async () => {
      // The deletion and the insertion after the mark didn't pair, and the
      // break opened the insertion's span, which export moves it out of
      const revision = 'w:author="A" w:date="2024-01-01T00:00:00Z"';
      const docx = await buildSyntheticDocx(wrapDocumentXml(
        '<w:p><w:pPr><w:rPr><w:ins w:id="1" ' + revision + '/></w:rPr></w:pPr><w:r><w:t>x</w:t></w:r><w:commentRangeStart w:id="0"/>'
        + '<w:del w:id="2" ' + revision + '><w:r><w:delText>d</w:delText></w:r></w:del><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>'
        + '<w:del w:id="3" ' + revision + '><w:r><w:delText>g</w:delText></w:r></w:del></w:p>'
        + '<w:p><w:ins w:id="4" ' + revision + '><w:r><w:t xml:space="preserve">i </w:t></w:r></w:ins><w:r><w:t>a</w:t></w:r></w:p><w:p><w:r><w:t>c</w:t></w:r></w:p>'),
      { 'word/comments.xml': '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="B" w:date="2024-01-01T00:00:00Z"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:comment></w:comments>' });
      const md = (await convertDocx(docx)).markdown;
      expect(md).toContain('{~~g~>\n\ni ~~}a');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(/<w:p[ >](?:(?!<\/w:p>).)*?<w:rPr><w:ins (?:(?!<\/w:p>).)*?<w:t>x<\/w:t>/.test(xml)).toBe(true);
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
      // A break with no deleted text before it is a span of its own, which
      // export keeps, as it moves one that opens a span with text outside it
      expect(await body('<w:p>' + deletedMark + '<w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p>'))
        .toBe('Hello{--\n\n--}World');
      // A deleted heading's mark keeps its own handling
      expect(await body('<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:rPr><w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr></w:pPr>'
        + deletedRun('Gone') + '</w:p><w:p><w:r><w:t>Kept</w:t></w:r></w:p>')).toBe('{--# Gone--}\n\nKept');
    });

    test.each([
      ['deleted after text', 'a{--\n\n--}b'],
      ['inserted after text', 'a{++\n\n++}b'],
      ['after an insertion', '{++a++}{--\n\n--}b'],
      ['before a deletion', 'a{--\n\n--}{--b--}c'],
      ['before an insertion', 'a{--\n\n--}{++X++}b'],
      ['after a comment\'s reference', 'a{>>c<<}{--\n\n--}b'],
      ['after a comment\'s range', '{==a==}{>>c<<}{--\n\n--}b'],
      ['in a comment\'s range', 'a{#1}b{--\n\n--}c{/1}\n{#1>>note<<}'],
      ['at the start of a comment\'s range', 'A{#1}{--\n\n--}b{/1}\n{#1>>note<<}'],
      ['in a quote', '> a{--\n>\n> --}b'],
      ['in a list item', '- a{--\n\n  --}b'],
      // A span in a link ends with it, so the break opened the span after,
      // which export moves it out of
      ['after a deletion in part of a link', 'x[a{--h--}](https://e.com){--\n\n--}{--n--}y'],
      ['after an insertion in part of a link', 'x[a{++h++}](https://e.com){++\n\n++}{++n++}y'],
    ])('keeps a tracked paragraph mark %s in a span of its own', async (_name, md) => {
      // It came back as a plain paragraph break: the span of the break alone
      // was written only where it joined a span of the same revision before it
      const roundTrip = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
      expect(roundTrip.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()).toBe(md);
    });

    test.each([
      ['text', false, 'x{--\\{++\n\nn--}y'],
      ['a citation without keys', true, 'x{--abc\\{++\n\nn--}y'],
    ])('joins a tracked paragraph mark to the span of a deletion of %s that ends in {++', (_name, citation, expected) => {
      // Its escaped {, which a citation without keys is written as text
      // with too, read as the span's opener, before the break, as an
      // insertion's
      const deleted: RevisionInfo = { type: 'deletion', author: 'A', date: '' };
      const run = (text: string, revision?: RevisionInfo): ContentItem =>
        ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING, ...(revision ? { revision } : {}) });
      const end: ContentItem = citation ? { type: 'citation', text: 'abc{++', commentIds: new Set(), pandocKeys: [], revision: deleted } : run('{++', deleted);
      expect(buildMarkdown([
        { type: 'para' }, run('x'), end, { type: 'para', breakRevision: deleted }, run('n', deleted), run('y'),
      ], new Map()).trim()).toBe(expected);
    });

    test.each([[false], [true]])('keeps a change\'s text that starts with a private-use character and a line end as it is, with a tracked mark after it: %p', (mark) => {
      // Read as a tracked break's start, its span took a mark it kept
      const deleted: RevisionInfo = { type: 'deletion', author: 'A', date: '' };
      const run = (text: string, revision?: RevisionInfo): ContentItem =>
        ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING, ...(revision ? { revision } : {}) });
      const md = buildMarkdown([
        { type: 'para' }, run('x'), run('\uE000\ny', deleted),
        ...(mark ? [{ type: 'para', breakRevision: deleted } as ContentItem, run('n', deleted)] : []),
      ], new Map());
      expect(md).not.toContain('\uFFFE');
    });

    test('joins a tracked paragraph mark after a change to part of a link a comment\'s range splits to its span', async () => {
      // Each run of the link is a link of its own, inside the span, which
      // goes on past the break
      const deleted: RevisionInfo = { type: 'deletion', author: 'A', date: '' };
      const run = (text: string, extra: Partial<Extract<ContentItem, { type: 'text' }>> = {}): ContentItem =>
        ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING, ...extra });
      const md = buildMarkdown([
        { type: 'para' }, run('x'),
        run('a', { href: 'https://e.com', link: 1, commentIds: new Set(['c1']) }), run('h', { href: 'https://e.com', link: 1, revision: deleted }),
        { type: 'para', breakRevision: deleted }, run('n', { revision: deleted }), run('y'),
      ], new Map([['c1', { author: 'R', text: 'note', date: '' }]])).trim();
      expect(md).toBe('x{==[a](https://e.com)==}{>>@R | note<<}{--[h](https://e.com)\n\nn--}y');
      const roundTrip = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
      expect(roundTrip.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()).toBe(md);
    });

    test('keeps a deleted line break of a link after the runs of it a comment\'s range ends in, with a substitution\'s break', async () => {
      // The runs before the comment's end are one link, without the line
      // break, which is one of its own, whose span the break and the
      // insertion after it join as a substitution
      const deleted: RevisionInfo = { type: 'deletion', author: 'A', date: '' };
      const run = (text: string, extra: Partial<Extract<ContentItem, { type: 'text' }>> = {}): ContentItem =>
        ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING, ...extra });
      const md = buildMarkdown([
        { type: 'para' }, run('x'),
        run('a', { href: 'https://e.com', link: 1, commentIds: new Set(['c1']) }), run('b', { href: 'https://e.com', link: 1, commentIds: new Set(['c1']) }),
        run('\\\n', { href: 'https://e.com', link: 1, revision: deleted }),
        { type: 'para', breakRevision: deleted }, run('n', { revision: { ...deleted, type: 'addition' } }), run('y'),
      ], new Map([['c1', { author: 'R', text: 'note', date: '' }]])).trim();
      expect(md).toBe('x{==[ab](https://e.com)==}{>>@R | note<<}{~~[\\\n](https://e.com)\n\n~>n~~}y');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(xml.match(/<w:br\/>/g)).toHaveLength(1);
    });

    test('keeps a deleted line break of a link whose runs are one merged, before a tracked mark', async () => {
      // The runs, merged, are one link, without the line break, which is a
      // span of its own with the break, in a link of its own
      const deleted: RevisionInfo = { type: 'deletion', author: 'A', date: '' };
      const run = (text: string, extra: Partial<Extract<ContentItem, { type: 'text' }>> = {}): ContentItem =>
        ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING, ...extra });
      const md = buildMarkdown([
        { type: 'para' }, run('x'),
        run('<sp', { href: 'https://e.com', link: 1 }), run('an a="', { href: 'https://e.com', link: 1 }), run('\\\n', { href: 'https://e.com', link: 1, revision: deleted }),
        { type: 'para', breakRevision: deleted }, run('y'),
      ], new Map()).trim();
      expect(md).toBe('x[\\<span a="](https://e.com){--[\\\n](https://e.com)\n\n--}y');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(xml.match(/<w:br\/>/g)).toHaveLength(1);
    });

    test('keeps a comment over a tracked mark and an empty quoted paragraph after it one range', async () => {
      // The break alone took the ranges the item right after it was in,
      // which was the empty paragraph's, so the comment ended before the
      // break and started again after it, and export wrote two
      const revision = 'w:author="A" w:date="2024-01-01T00:00:00Z"';
      const quote = (mark: boolean) => '<w:pPr><w:pStyle w:val="GitHubBlockquote"/>' + (mark ? '<w:rPr><w:del w:id="1" ' + revision + '/></w:rPr>' : '') + '</w:pPr>';
      const docx = await buildSyntheticDocx(wrapDocumentXml(
        '<w:p>' + quote(true) + '<w:commentRangeStart w:id="0"/><w:r><w:t>a</w:t></w:r></w:p><w:p>' + quote(true) + '</w:p>'
        + '<w:p>' + quote(false) + '<w:r><w:t>b</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>'),
      { 'word/comments.xml': '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="B" w:date="2024-01-01T00:00:00Z"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:comment></w:comments>' });
      const md = (await convertDocx(docx)).markdown;
      expect(md).toContain('> {#1}a{--\n>\n> --}');
      expect(md.match(/\{\/1\}/g)).toHaveLength(1);
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(xml.match(/<w:commentRangeStart /g)).toHaveLength(1);
    });

    test.each(['indent', 'no-indent'])('keeps the %s override of a paragraph after a tracked mark', async override => {
      // The break's text took the paragraph's place, and the override went.
      // The break ends the paragraph before
      const md = 'a\n\n<!-- ' + override + ' -->\nb\n';
      const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
      const xml = await zip.file('word/document.xml')!.async('string');
      const tracked = xml.replace(/(<w:p [^>]*>)((?:(?!<\/w:p>).)*?<w:t>a<\/w:t>)/, '$1<w:pPr><w:rPr><w:del w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr></w:pPr>$2');
      expect(tracked).not.toBe(xml);
      zip.file('word/document.xml', tracked);
      expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md.replace('a', 'a{--\n\n--}'));
    });

    test('keeps a thematic break after a tracked mark', async () => {
      // The break's text took the rule's place. The mark before the rule
      // ends the paragraph before; the rule's own goes, as Markdown has no
      // break after a rule to track
      const md = 'a\n\n---\n\nb\n';
      const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
      const xml = await zip.file('word/document.xml')!.async('string');
      const mark = '<w:rPr><w:del w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr>';
      const tracked = xml.replace(/(<w:p [^>]*>)(<w:r><w:t>a<\/w:t>)/, '$1<w:pPr>' + mark + '</w:pPr>$2').replace('</w:pBdr>', '</w:pBdr>' + mark);
      expect(tracked.split('w:id="99"').length).toBe(3);
      zip.file('word/document.xml', tracked);
      expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe('a{--\n\n--}\n\n---\n\nb\n');
    });

    // The Word document `md` exports, with Word's changes A's, and the marks
    // of the paragraphs whose text is each of `texts` tracked as `type`
    async function withTrackedMarks(md: string, texts: string[], type: 'ins' | 'del'): Promise<Uint8Array> {
      const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
      const revision = 'w:author="A" w:date="2024-01-01T00:00:00Z"';
      let xml = (await zip.file('word/document.xml')!.async('string')).replace(/w:author="Unknown"/g, revision);
      texts.forEach((text, k) => {
        const mark = '<w:rPr><w:' + type + ' w:id="9' + k + '" ' + revision + '/></w:rPr>';
        const tracked = xml.replace(new RegExp('(<w:p(?: [^>]*)?>)(?:<w:pPr>((?:(?!</w:pPr>).)*)</w:pPr>)?((?:(?!</w:p>).)*?<w:(?:t|delText)>' + text + '</w:(?:t|delText)>)'),
          (_m, open: string, pPr: string | undefined, rest: string) => open + '<w:pPr>' + (pPr ?? '') + mark + '</w:pPr>' + rest);
        expect(tracked).not.toBe(xml);
        xml = tracked;
      });
      zip.file('word/document.xml', xml);
      return zip.generateAsync({ type: 'uint8array' });
    }

    // Each paragraph with text or a tracked mark: its text and its mark's revision
    async function trackedMarksOf(docx: Uint8Array): Promise<string[]> {
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      return [...xml.matchAll(/<w:p(?: [^>]*)?>((?:(?!<\/w:p>).)*)<\/w:p>/g)].flatMap(([, p]) => {
        const text = [...p.matchAll(/<w:(?:t|delText)(?: [^>]*)?>([^<]*)</g)].map(t => t[1]).join('');
        const mark = /^<w:pPr>(?:(?!<\/w:pPr>).)*<w:rPr><w:(ins|del) /.exec(p)?.[1];
        return text || mark ? [text + (mark ? ' ¶' + mark : '')] : [];
      });
    }

    // Word → Markdown → Word → Markdown for the document withTrackedMarks makes
    async function tripTrackedMarks(md: string, texts: string[], type: 'ins' | 'del') {
      const strip = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
      const docx = await withTrackedMarks(md, texts, type);
      const imported = strip((await convertDocx(docx)).markdown);
      const exported = (await convertMdToDocx(imported)).docx;
      return { imported, before: await trackedMarksOf(docx), after: await trackedMarksOf(exported), again: strip((await convertDocx(exported)).markdown) };
    }

    test.each([
      ['before a list item', 'a\n\n- item\n', ['a'], 'del', 'a{--\n\n--}\n\n- item\n'],
      ['between list items', '- one\n- two\n', ['one'], 'ins', '- one{++\n\n  ++}\n- two\n'],
      ['after a list', '- one\n\nbody\n', ['one'], 'del', '- one{--\n\n  --}\n\nbody\n'],
      ['of a list item inserted whole', '- one\n- {++two++}\n- three\n', ['two'], 'ins', '- one\n- {++two\n\n  ++}\n- three\n'],
      ['between nested list items', '1. one\n   1. two\n2. three\n', ['two'], 'del', '1. one\n   1. two{--\n\n      --}\n2. three\n'],
      // Indented as the item's text, whatever the markers' widths
      ['after a list item under a numbered one', '1. one\n   - two\n2. three\n', ['two'], 'ins', '1. one\n   - two{++\n\n     ++}\n2. three\n'],
      ['after a list item with a wide number', '10. one\n11. two\n', ['one'], 'del', '10. one{--\n\n    --}\n11. two\n'],
      ['before a thematic break', 'a\n\n---\n\nb\n', ['a'], 'del', 'a{--\n\n--}\n\n---\n\nb\n'],
      ['before a heading', 'a\n\n# Head\n', ['a'], 'ins', 'a{++\n\n++}\n\n# Head\n'],
      ['before a code block', 'a\n\n```\nx\n```\n', ['a'], 'del', 'a{--\n\n--}\n\n```\nx\n```\n'],
    ] as const)('keeps a tracked paragraph mark %s, as a break at the end of its paragraph', async (_name, md, texts, type, expected) => {
      // The break, which can't join the text after it, was dropped
      const { imported, before, after, again } = await tripTrackedMarks(md, [...texts], type);
      expect(imported).toBe(expected);
      expect(after).toEqual(before);
      expect(again).toBe(imported);
    });

    test.each([
      ['after a quote', 'x\n\n> quote\n\nbody\n', ['quote'], 'del', 'x\n\n> quote{--\n>\n> --}\n\nbody\n'],
      ['of a quote inserted whole', 'x\n\n> {++quote++}\n\nbody\n', ['quote'], 'ins', 'x\n\n> {++quote\n>\n> ++}\n\nbody\n'],
      ['before a quote', 'body\n\n> quote\n', ['body'], 'ins', 'body{++\n\n++}\n\n> quote\n'],
      ['after an alert', '> [!NOTE]\n> note\n\nbody\n', ['note'], 'del', '> [!NOTE]\n> note{--\n>\n> --}\n\nbody\n'],
      ['between quotes', '> a\n>\n> > b\n\nz\n', ['a', 'b'], 'del', '> a{--\n>\n> --}\n> > b{--\n> >\n> > --}\n\nz\n'],
    ] as const)('keeps a tracked paragraph mark %s, past the spacer export pads the quote with', async (_name, md, texts, type, expected) => {
      // The mark was the spacer's break's, which import drops
      const { imported, before, after, again } = await tripTrackedMarks(md, [...texts], type);
      expect(imported).toBe(expected);
      expect(after).toEqual(before);
      expect(again).toBe(imported);
    });

    test.each([
      ['a paragraph', 'a\n\nb\n', ['b'], 'del', 'a\n\nb{--\n\n--}\n'],
      ['a paragraph inserted whole', 'a\n\n{++b++}\n', ['b'], 'ins', 'a\n\n{++b\n\n++}\n'],
      ['the only paragraph', '{--b--}\n', ['b'], 'del', '{--b\n\n--}\n'],
      ['a list item', 'a\n\n- b\n', ['b'], 'ins', 'a\n\n- b{++\n\n  ++}\n'],
      ['a quote', 'a\n\n> b\n', ['b'], 'del', 'a\n\n> b{--\n>\n> --}\n'],
    ] as const)('keeps the tracked mark of %s at the end of the document', async (_name, md, texts, type, expected) => {
      // No paragraph after it took it as the break before it
      const { imported, before, after, again } = await tripTrackedMarks(md, [...texts], type);
      expect(imported).toBe(expected);
      expect(after).toEqual(before);
      expect(again).toBe(imported);
    });

    test.each([
      ['before a paragraph', '# Head\n\nBody\n', ['Head'], 'del', '# Head{--\n\n--}Body\n'],
      ['with a change before a paragraph', '# Head{++er++}\n\nBody\n', ['Head'], 'ins', '# Head{++er\n\n++}Body\n'],
      ['before a paragraph with a change', '# Head\n\n{--Old--} body\n', ['Head'], 'del', '# Head{--\n\n--}{--Old--} body\n'],
      ['with a comment', '# {==Head==}{>>c<<}\n\nBody\n', ['Head'], 'ins', '# {==Head==}{>>c<<}{++\n\n++}Body\n'],
      ['before a line break', '# Head\n\nBody\\\nmore\n', ['Head'], 'del', '# Head{--\n\n--}Body<br>more\n'],
      ['before a list item', '# Head\n\n- item\n', ['Head'], 'del', '# Head{--\n\n--}\n\n- item\n'],
      ['before a heading', '# Head\n\n## Sub\n', ['Head'], 'ins', '# Head{++\n\n++}\n\n## Sub\n'],
      ['at the end of the document', 'a\n\n## Head\n', ['Head'], 'del', 'a\n\n## Head{--\n\n--}\n'],
      ['all in its revision', '{--# Head--}\n\nBody\n', ['Head'], 'del', '{--# Head--}\n\nBody\n'],
    ] as const)('keeps the tracked mark of a heading %s', async (_name, md, texts, type, expected) => {
      // It went where the heading's text wasn't all in the mark's revision
      const { imported, before, after, again } = await tripTrackedMarks(md, [...texts], type);
      expect(imported).toBe(expected);
      expect(after).toEqual(before);
      expect(again).toBe(imported);
    });

    test.each([
      ['a paragraph', 'a\n\n| x |\n|---|\n| y |\n\nz\n', ['a'], 'del', 'a{--\n\n--}\n\n| x |\n| --- |\n| y |\n\nz\n'],
      ['a list item', '- a\n\n| x |\n|---|\n| y |\n', ['a'], 'ins', '- a{++\n\n  ++}\n\n| x |\n| --- |\n| y |\n'],
      ['a heading', '# a\n\n| x |\n|---|\n| y |\n', ['a'], 'ins', '# a{++\n\n++}\n\n| x |\n| --- |\n| y |\n'],
      ['each of two paragraphs', 'a\n\n| x |\n|---|\n| y |\n\nb\n\n| x |\n|---|\n| y |\n', ['a', 'b'], 'del',
        'a{--\n\n--}\n\n| x |\n| --- |\n| y |\n\nb{--\n\n--}\n\n| x |\n| --- |\n| y |\n'],
    ] as const)('keeps the tracked mark of %s before a table', async (_name, md, texts, type, expected) => {
      // The table's paragraphs, which take no break, dropped it
      const { imported, before, after, again } = await tripTrackedMarks(md, [...texts], type);
      expect(imported).toBe(expected);
      expect(after).toEqual(before);
      expect(again).toBe(imported);
    });

    test.each([
      ['at the end of a custom style block', '<!-- style: Foo -->\na\n<!-- /style -->\n\nz\n', ['a'], 'del', '<!-- style: foo -->\na{--\n\n--}\n<!-- /style -->\n\nz\n'],
      ['before a custom style block', 'z\n\n<!-- style: Foo -->\na\n<!-- /style -->\n', ['z'], 'ins', 'z{++\n\n++}\n\n<!-- style: foo -->\na\n<!-- /style -->\n'],
      ['at the end of a custom style block before another', '<!-- style: Foo -->\na\n<!-- /style -->\n\n<!-- style: Bar -->\nb\n<!-- /style -->\n', ['a'], 'del',
        '<!-- style: foo -->\na{--\n\n--}\n<!-- /style -->\n\n<!-- style: bar -->\nb\n<!-- /style -->\n'],
      ['at the end of the document in a custom style block', 'z\n\n<!-- style: Foo -->\na\n<!-- /style -->\n', ['a'], 'ins', 'z\n\n<!-- style: foo -->\na{++\n\n++}\n<!-- /style -->\n'],
      ['before a table in a custom style block', '<!-- style: Foo -->\na\n<!-- /style -->\n\n| x |\n|---|\n| y |\n', ['a'], 'del',
        '<!-- style: foo -->\na{--\n\n--}\n<!-- /style -->\n\n| x |\n| --- |\n| y |\n'],
    ] as const)('keeps the tracked mark of a paragraph %s', async (_name, md, texts, type, expected) => {
      // The block's sentinel between the break and the text before it
      // kept the break from it
      const { imported, before, after, again } = await tripTrackedMarks(md, [...texts], type);
      expect(imported).toBe(expected);
      expect(after).toEqual(before);
      expect(again).toBe(imported);
    });

    test.each([
      ['before a landscape section', 'a\n\n<!-- landscape -->\nb\n<!-- /landscape -->\n', ['a'], 'del', 'a{--\n\n--}\n\n<!-- landscape -->\nb\n<!-- /landscape -->\n'],
      ['at the end of a landscape section', 'z\n\n<!-- landscape -->\nb\n<!-- /landscape -->\n\nc\n', ['b'], 'ins', 'z\n\n<!-- landscape -->\nb{++\n\n++}\n<!-- /landscape -->\n\nc\n'],
      ['at the end of a landscape section before another', '<!-- landscape -->\na\n<!-- /landscape -->\n\n<!-- landscape -->\nb\n<!-- /landscape -->\n', ['a'], 'del',
        '<!-- landscape -->\na{--\n\n--}\n<!-- /landscape -->\n\n<!-- landscape -->\nb\n<!-- /landscape -->\n'],
    ] as const)('keeps the tracked mark of a paragraph %s', async (_name, md, texts, type, expected) => {
      // The empty paragraph that holds the section's break, which export
      // writes after it, dropped it
      const { imported, before, after, again } = await tripTrackedMarks(md, [...texts], type);
      expect(imported).toBe(expected);
      expect(after).toEqual(before);
      expect(again).toBe(imported);
    });

    test('drops the tracked mark of a paragraph before a section break Markdown drops', async () => {
      // As the paragraph after would take it, joining the two once accepted
      // where Word joins the paragraph to the break's empty paragraph
      const zip = await JSZip.loadAsync(await withTrackedMarks('a\n\n<!-- landscape -->\nb\n<!-- /landscape -->\n', ['a'], 'del'));
      const xml = await zip.file('word/document.xml')!.async('string');
      const portrait = xml.replace(/<w:pgSz w:w="(\d+)" w:h="(\d+)" w:orient="landscape"\/>/g, (_m, w: string, h: string) => '<w:pgSz w:w="' + h + '" w:h="' + w + '"/>');
      expect(portrait).not.toBe(xml);
      zip.file('word/document.xml', portrait);
      const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
      expect(md).toBe('a\n\nb\n');
    });

    test('keeps the tracked mark of a paragraph before a rule that holds a section break', async () => {
      // The rule, which Word can move a section's break onto, didn't take it
      const zip = await JSZip.loadAsync(await withTrackedMarks('a\n\n---\n\n<!-- landscape -->\nb\n<!-- /landscape -->\n', ['a'], 'del'));
      const xml = await zip.file('word/document.xml')!.async('string');
      const merged = xml.replace(/(<w:pBdr><w:bottom [^>]*\/><\/w:pBdr>)<\/w:pPr><\/w:p><w:p\b[^>]*><w:pPr>(<w:sectPr[\s\S]*?<\/w:sectPr>)<\/w:pPr><\/w:p>/, '$1$2</w:pPr></w:p>');
      expect(merged).not.toBe(xml);
      zip.file('word/document.xml', merged);
      const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
      expect(md).toBe('a{--\n\n--}\n\n---\n\n<!-- landscape -->\nb\n<!-- /landscape -->\n');
      expect(await trackedMarksOf((await convertMdToDocx(md)).docx)).toEqual(['a ¶del', 'b']);
    });

    test('keeps the tracked mark of a note\'s paragraph before a table', async () => {
      // As in the document's body
      const zip = await JSZip.loadAsync((await convertMdToDocx('x[^1]\n\n[^1]: a\n\n    | p |\n    |---|\n    | q |\n')).docx);
      const notes = await zip.file('word/footnotes.xml')!.async('string');
      const tracked = notes.replace(/(<w:p(?: [^>]*)?><w:pPr>(?:(?!<\/w:pPr>).)*?)(<\/w:pPr>(?:(?!<\/w:p>).)*?<w:t>a<\/w:t>)/,
        '$1<w:rPr><w:ins w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr>$2');
      expect(tracked).not.toBe(notes);
      zip.file('word/footnotes.xml', tracked);
      const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
      expect(md).toBe('x[^1]\n\n[^1]:\n\n    a{++\n    \n    ++}\n\n    | p |\n    | --- |\n    | q |\n');
      const exported = (await convertMdToDocx(md)).docx;
      const exportedNotes = await (await JSZip.loadAsync(exported)).file('word/footnotes.xml')!.async('string');
      expect(exportedNotes).toMatch(/<w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr>(?:(?!<\/w:p>).)*?<w:t>a<\/w:t>/);
      expect((await convertDocx(exported)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md);
    });

    test('keeps the tracked mark of a note\'s last paragraph', async () => {
      // No paragraph after it took it as the break before it
      const zip = await JSZip.loadAsync((await convertMdToDocx('x[^1]\n\n[^1]: a\n\n    b\n')).docx);
      const notes = await zip.file('word/footnotes.xml')!.async('string');
      const tracked = notes.replace(/(<w:p(?: [^>]*)?><w:pPr>(?:(?!<\/w:pPr>).)*?)(<\/w:pPr>(?:(?!<\/w:p>).)*?<w:t>b<\/w:t>)/,
        '$1<w:rPr><w:del w:id="99" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr>$2');
      expect(tracked).not.toBe(notes);
      zip.file('word/footnotes.xml', tracked);
      const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
      expect(md).toBe('x[^1]\n\n[^1]: a\n\n    b{--\n    \n    --}\n');
      const exported = (await convertMdToDocx(md)).docx;
      const exportedNotes = await (await JSZip.loadAsync(exported)).file('word/footnotes.xml')!.async('string');
      expect(exportedNotes).toMatch(/<w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr>(?:(?!<\/w:p>).)*?<w:t>b<\/w:t>/);
      expect((await convertDocx(exported)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toBe(md);
    });

    test('writes many tracked marks in linear time', () => {
      // Each read the content on its sides through all the others, moved
      // all the content after it, and read all the Markdown before it.
      // Eight times the marks take about eight times as long, not
      // sixty-four, however fast the machine is, where a bound on the time
      // failed on slower runners. The fastest of three runs, which a pause
      // for garbage collection doesn't slow.
      const revision = { type: 'deletion' as const, author: 'A', date: '' };
      const contentOf = (marks: number) => {
        const content: ContentItem[] = [];
        for (let i = 0; i < marks; i++) {
          content.push(i === 0 ? { type: 'para' } : { type: 'para', breakRevision: revision });
          content.push({ type: 'text', text: 'a' + i, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
        }
        return content;
      };
      const time = (marks: number) => {
        const content = contentOf(marks);
        let fastest = Infinity;
        for (let run = 0; run < 3; run++) {
          const start = performance.now();
          buildMarkdown(content, new Map());
          fastest = Math.min(fastest, performance.now() - start);
        }
        return fastest;
      };
      expect(buildMarkdown(contentOf(3), new Map())).toStartWith('a0{--\n\n--}a1{--\n\n--}a2');
      const large = time(64000);
      expect(large / time(8000)).toBeLessThan(24);
    }, 30000);

    test('escapes the lines of a deletion of many paragraphs in linear time', () => {
      // Each line after a tracked break in the deletion's one run was read
      // to the run's end. Eight times the paragraphs take about eight times
      // as long, not sixty-four, however fast the machine is.
      const revision = { type: 'deletion' as const, author: 'A', date: '' };
      const time = (paragraphs: number) => {
        const content: ContentItem[] = [];
        for (let i = 0; i < paragraphs; i++) {
          content.push(i === 0 ? { type: 'para' } : { type: 'para', breakRevision: revision });
          content.push({ type: 'text', text: 'a' + i, commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision });
        }
        const start = performance.now();
        buildMarkdown(content, new Map());
        return performance.now() - start;
      };
      const small = time(4000);
      expect(time(32000) / small).toBeLessThan(16);
    });

    test.each([
      ['a deletion of a paragraph and the start of the next', '{--a\n\nb--}c'],
      ['an insertion of a paragraph and the start of the next', '{++a\n\nb++}c'],
      ['a deletion from a paragraph\'s end through the next', 'a{--b\n\nc--}'],
      ['the same before another paragraph', 'a{--b\n\nc--}\n\ny'],
      ['a substitution of two paragraphs', '{~~old\n\ntext~>new\n\ntext~~}\n\nz'],
      ['a substitution of two paragraphs for two', '{~~a\n\nb~>c\n\nd~~}\n\nz'],
    ])('keeps the paragraph marks of %s', async (_name, md) => {
      // A paragraph that came back all in the change lost its tracked mark,
      // or took one it didn't have, where the last paragraph's mark is the
      // block's own
      const marks = async (markdown: string) => {
        const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
        return [...xml.matchAll(/<w:p>|<w:p [^>]*>/g)].map(p => /^<w:p[ >](?:(?!<\/w:p>).)*?<w:pPr>(?:(?!<\/w:pPr>).)*<w:rPr><w:(ins|del) /.exec(xml.slice(p.index))?.[1] ?? '');
      };
      const roundTrip = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
      expect(await marks(roundTrip)).toEqual(await marks(md));
    });

    test.each([
      ['spaces before its text', ' foo', 'Keep{--cut\n\n&#32;foo--}\n\nz'],
      ['spaces alone', '  ', 'Keep{--cut\n\n&#32;&#32;--}\n\nz'],
    ])('keeps a deleted paragraph\'s %s after a deleted mark', async (_name, text, expected) => {
      // Export dropped the spaces at the start of the line after the break,
      // and a paragraph of spaces alone with them
      const revision = 'w:author="A" w:date="2024-01-01T00:00:00Z"';
      const deleted = (t: string) => '<w:del w:id="2" ' + revision + '><w:r><w:delText xml:space="preserve">' + t + '</w:delText></w:r></w:del>';
      const docx = await buildSyntheticDocx(wrapDocumentXml('<w:p><w:pPr><w:rPr><w:del w:id="1" ' + revision + '/></w:rPr></w:pPr><w:r><w:t>Keep</w:t></w:r>' + deleted('cut')
        + '</w:p><w:p>' + deleted(text) + '</w:p><w:p><w:r><w:t>z</w:t></w:r></w:p>'));
      const md = (await convertDocx(docx)).markdown;
      expect(md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()).toBe(expected);
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(xml).toContain('<w:delText xml:space="preserve">' + text + '</w:delText>');
    });

    test.each([
      ['a backslash at the end of the paragraph before', '<w:delText>foo\\</w:delText>', '<w:delText>b</w:delText>', 'x{--foo\\\\\n\nb--}y'],
      ['spaces at the end of the paragraph before', '<w:delText xml:space="preserve">a  </w:delText>', '<w:delText>b</w:delText>', 'x{--a&#32;&#32;\n\nb--}y'],
      ['a line break at the end of the paragraph before', '<w:delText>a</w:delText><w:br/>', '<w:delText>b</w:delText>', 'x{--a<br>\n\nb--}y'],
      ['a line break at the start of the paragraph after', '<w:delText>a</w:delText>', '<w:br/><w:delText>b</w:delText>', 'x{--a\n\n\\\nb--}y'],
    ])('keeps %s a deleted mark joins', async (_name, end, start, expected) => {
      // Export read the \ and the line end after it as a line break, and
      // dropped spaces or a line break at the paragraph break
      const revision = 'w:author="A" w:date="2024-01-01T00:00:00Z"';
      const body = '<w:p><w:pPr><w:rPr><w:del w:id="1" ' + revision + '/></w:rPr></w:pPr><w:r><w:t>x</w:t></w:r><w:del w:id="2" ' + revision + '><w:r>' + end
        + '</w:r></w:del></w:p><w:p><w:del w:id="3" ' + revision + '><w:r>' + start + '</w:r></w:del><w:r><w:t>y</w:t></w:r></w:p>';
      const md = (await convertDocx(await buildSyntheticDocx(wrapDocumentXml(body)))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      expect(md).toBe(expected);
      const runs = (xml: string) => [...xml.matchAll(/<w:(?:t|delText)[^>]*>([^<]*)<\/w:(?:t|delText)>|<w:br\/>|<w:p[ >]/g)].map(m => m[1] ?? (m[0] === '<w:br/>' ? '↵' : '¶')).join('');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(runs(xml.slice(xml.indexOf('<w:body>')))).toBe(runs(body));
    });

    test('keeps a mail link after spaces at the start of the paragraph a deleted mark joins', async () => {
      // The spaces, written as references after the link was written bare,
      // kept export from reading the address as a link
      const md = '{--a\n\n&#32;[x\\@example.com](mailto:x@example.com)--}y';
      const roundTrip = (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      expect(roundTrip).toBe(md);
    });

    test.each([
      ['a quote\'s marker after a deleted mark that joins', '', '<w:delText>&gt; q</w:delText><w:br/><w:delText>b</w:delText>', 'x{--a\n\n\\> q\\\nb--}y'],
      ['a quote\'s marker after a deleted mark that joins in a quote', 'GitHubBlockquote', '<w:delText>&gt; q</w:delText><w:br/><w:delText>b</w:delText>', '> x{--a\n>\n> \\> q\\\n> b--}y'],
      ['a list item\'s marker after a deleted mark that joins', '', '<w:delText>- m</w:delText>', 'x{--a\n\n\\- m--}y'],
      ['a heading\'s marker after a deleted mark that joins', '', '<w:delText># t</w:delText>', 'x{--a\n\n\\# t--}y'],
    ])('escapes %s', async (_name, style, start, expected) => {
      // The mark kept escaping from seeing the start of a line, and export
      // read a > there as a quote's, which ended at the line break after.
      // A paragraph with text, past the quote's border paragraphs
      const revision = 'w:author="A" w:date="2024-01-01T00:00:00Z"';
      const pStyle = style ? '<w:pStyle w:val="' + style + '"/>' : '';
      const body = '<w:p><w:pPr>' + pStyle + '<w:rPr><w:del w:id="1" ' + revision + '/></w:rPr></w:pPr><w:r><w:t>x</w:t></w:r><w:del w:id="2" ' + revision + '><w:r><w:delText>a</w:delText>'
        + '</w:r></w:del></w:p><w:p>' + (pStyle ? '<w:pPr>' + pStyle + '</w:pPr>' : '') + '<w:del w:id="3" ' + revision + '><w:r>' + start + '</w:r></w:del><w:r><w:t>y</w:t></w:r></w:p>';
      const md = (await convertDocx(await buildSyntheticDocx(wrapDocumentXml(body)))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      expect(md).toBe(expected);
      const runs = (xml: string) => [...xml.matchAll(/<w:(?:t|delText)[^>]*>([^<]*)<\/w:(?:t|delText)>|<w:br\/>|<w:p[ >](?=(?:(?!<\/w:p>).)*?<w:(?:t|delText)[ >])/g)].map(m => m[1] ?? (m[0] === '<w:br/>' ? '↵' : '¶')).join('');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(runs(xml.slice(xml.indexOf('<w:body>')))).toBe(runs(body));
    });

    test('escapes a quote\'s marker at the start of a line after a line break in a deleted run of other formatting', async () => {
      // Its text was written after the span the run before it ended, though
      // it went on in that span, and export read the > as a quote's
      const revision = 'w:author="A" w:date="2024-01-01T00:00:00Z"';
      const body = '<w:p><w:r><w:t>x</w:t></w:r><w:del w:id="1" ' + revision + '><w:r><w:rPr><w:b/></w:rPr><w:delText>a</w:delText><w:br/></w:r>'
        + '<w:r><w:delText>&gt; q</w:delText><w:br/><w:delText>b</w:delText></w:r></w:del><w:r><w:t>y</w:t></w:r></w:p>';
      const md = (await convertDocx(await buildSyntheticDocx(wrapDocumentXml(body)))).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      expect(md).toBe('x{--**a**\\\n\\> q\\\nb--}y');
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(xml.match(/<w:p[ >]/g)).toHaveLength(1);
      expect(xml.match(/<w:br\/>/g)).toHaveLength(2);
    });

    test.each([
      ['with its mark', true, 'x\n\n{--a\n\n--}y'],
      ['without its mark', false, 'x\n\n{--a--}\n\ny'],
    ])('keeps a paragraph Word deleted whole %s', async (_name, tracked, expected) => {
      // With its mark, it came back as {--a--} on a line of its own, whose
      // mark export doesn't track, so accepting the deletion left an empty
      // paragraph
      const deletedMark = '<w:pPr><w:rPr><w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr></w:pPr>';
      const docx = await buildSyntheticDocx(wrapDocumentXml('<w:p><w:r><w:t>x</w:t></w:r></w:p><w:p>' + (tracked ? deletedMark : '')
        + '<w:del w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>a</w:delText></w:r></w:del></w:p><w:p><w:r><w:t>y</w:t></w:r></w:p>'));
      const md = (await convertDocx(docx)).markdown;
      expect(md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()).toBe(expected);
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
      expect(/<w:pPr><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr><w:del [^>]*><w:r><w:delText>a</.test(xml)).toBe(tracked);
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

describe('Missing citation keys', () => {
  test.each([
    ['a space', 'P [@a b] Q', 'a b'],
    // Whose ` the note's escaped ` closed as a code span
    ['a backtick', 'P [@a`b c] Q', 'a\\`b c'],
    // Which import writes as it is, as HTML, which export writes as text
    ['a tag', 'P [@a<span>] Q', 'a<span>'],
    // Whose <<} CriticMarkup paired with the {>> in the citation
    ['CriticMarkup\'s delimiters', 'P [@a<<}{>>b] Q', 'a<<}\\{>>b'],
  ])('writes the note of a missing key with %s once', async (_name, md, key) => {
    // The note for it, which export strips and writes anew, wasn't
    // stripped, and another was added each round trip
    const roundTrip = async (markdown: string) => (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    const once = await roundTrip(md);
    expect(once).toBe(md + '\n\nCitation data for @' + key + ' was not found in the bibliography file.\n');
    expect(await roundTrip(once)).toBe(once);
  });

  test.each([
    // Which export writes as a space, as Word shows it, where import reads
    // the line end in Word's text as one, after which it read no citation
    ['with a line end in its key', 'P [@a\nb] Q', 'P [@a b] Q\n\nCitation data for @a b was not found in the bibliography file.\n'],
    ['with a line end in its locator', 'P [@a, p.\n2] Q', 'P [@a, p. 2] Q\n\nCitation data for @a was not found in the bibliography file.\n'],
    // Which import writes on the line after the comment's end
    ['after a comment', 'P [@a] Q\n\n<!--\nc\n-->\n', 'P [@a] Q\n\n<!--\nc\n-->\nCitation data for @a was not found in the bibliography file.\n'],
    ['with carriage returns', 'P [@a] Q\r\n\r\nCitation data for @a was not found in the bibliography file.\r\n',
      'P [@a] Q\n\nCitation data for @a was not found in the bibliography file.\n'],
    // Whose key import wrote with a character reference, whose ; the search
    // took for the end of a citation's item
    ['with a reference in a key', 'P [@a] Q\n\nCitation data for @a&lt;b&gt;c was not found in the bibliography file.\n',
      'P [@a] Q\n\nCitation data for @a was not found in the bibliography file.\n'],
    // Which export reads as a paragraph of its own, after a quote, as markdown-it doesn't
    ['after a quote', 'P [@a] Q\n\n> x\nCitation data for @a was not found in the bibliography file.\n',
      'P [@a] Q\n\n> x\n\nCitation data for @a was not found in the bibliography file.\n'],
    // Which export reads as a paragraph of its own, before a note's definition
    ['before a note\'s definition', 'P [@a] Q[^1]\n\nCitation data for @a was not found in the bibliography file.\n[^1]: N\n',
      'P [@a] Q[^1]\n\nCitation data for @a was not found in the bibliography file.\n\n[^1]: N\n'],
    // Whose key linkify makes a link of
    ['with a URL for a key', 'P [@https://example.com] Q\n\nCitation data for @https://example.com was not found in the bibliography file.\n',
      'P [@https://example.com] Q\n\nCitation data for @https\\://example.com was not found in the bibliography file.\n'],
    // Whose ] linkify decoded
    ['with a URL with %5D for a key', 'P [@https://example.com/a%5Db] Q\n\nCitation data for @https://example.com/a%5Db was not found in the bibliography file.\n',
      'P [@https://example.com/a%5Db] Q\n\nCitation data for @https\\://example.com/a%5Db was not found in the bibliography file.\n'],
    // Which export reads as a paragraph of its own, after a grid table's border
    ['after a grid table', 'P [@a] Q\n\n+---+\n| a |\n+---+\nCitation data for @a was not found in the bibliography file.\n',
      'P [@a] Q\n\n+-----+\n| a   |\n+-----+\n\nCitation data for @a was not found in the bibliography file.\n'],
  ])('writes the note of a missing key %s once', async (_name, md, expected) => {
    // It wasn't stripped, as a line between blank lines, or one a line feed
    // ends, and another was added
    const roundTrip = async (markdown: string) => (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(await roundTrip(md)).toBe(expected);
    expect(await roundTrip(expected)).toBe(expected);
  });

  test.each([
    ['a code block', '```\nCitation data for @a b was not found in the bibliography file.\n```\n'],
    ['a code block, with a key of one word', '```\nCitation data for @a was not found in the bibliography file.\n```\n'],
    ['an HTML block', '<div>\nCitation data for @a was not found in the bibliography file.\n</div>\n'],
    // That goes on past blank lines, before a code block, whose region the
    // search found first
    ['an HTML block before a code block', '<pre>\n\nCitation data for @a was not found in the bibliography file.\n\n</pre>\n\n```\nx\n```\n'],
    // Which it opens or ends
    ['a comment it opens', 'Citation data for @a b{>>c was not found in the bibliography file.\n\nf<<}\n'],
    ['a comment it ends', 'P{>>c\n\nCitation data for @a b<<} was not found in the bibliography file.\n'],
    // Whose lines export reads as one paragraph, the comment's
    ['a comment', 'P{>>c\n\nCitation data for @a b was not found in the bibliography file.\n\nd<<} Q.\n'],
  ])('keeps a line like a note in %s', async (_name, md) => {
    // It was stripped as export's note, though a note is a paragraph
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown).toBe(md);
  });

  test.each([
    ['a heading', 'Citation data for @a b was not found in the bibliography file.\n===\n', '# Citation data for @a b was not found in the bibliography file.\n'],
    ['a paragraph', 'P\nCitation data for @a b was not found in the bibliography file.\n', 'P Citation data for @a b was not found in the bibliography file.\n'],
  ])('keeps a line like a note that is part of %s', async (_name, md, expected) => {
    // A note is a paragraph of its own
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown).toBe(expected);
  });

  test.each([
    ['a comment', 'P\n\nCitation data for @a<!-- c --> was not found in the bibliography file.\n',
      'P\n\nCitation data for @a<!-- c --> was not found in the bibliography file.\n'],
    ['a break', 'P\n\nCitation data for @a<br> was not found in the bibliography file.\n',
      'P\n\nCitation data for @a\\\n&#32;was not found in the bibliography file.\n'],
    ['formatting', 'P\n\nCitation data for @a<u> was not found in the bibliography file.\n',
      'P\n\nCitation data for @a<u> was not found in the bibliography file.</u>\n'],
  ])('keeps a line like a note with %s, whose HTML export reads as no text of a key\'s', async (_name, md, expected) => {
    // It was stripped, and the comment, break or formatting with it
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown).toBe(expected);
  });

  test('keeps a line like the note of a key no citation could have', async () => {
    // A key ends at a comma, so it was no note of export's
    const md = 'P\n\nCitation data for @Smith, Alice was not found in the bibliography file.\n';
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown).toBe(md);
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

  test.each(['png', 'JPG'])('names an image Word names %s, an extension alone, as its media file', async name => {
    // It took the name, from which export read no format, and left it out
    const tmpDir = join(require('os').tmpdir(), 'mms-test-img-ext-' + Date.now());
    const { mkdirSync, writeFileSync, rmSync } = require('fs');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'x.png'), TINY_PNG);
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync((await convertMdToDocx('![a](x.png){width=100 height=100}', { sourceDir: tmpDir })).docx);
      const xml = await zip.file('word/document.xml')!.async('string');
      const named = xml.replace(/ name="x\.png"/, ' name="' + name + '"');
      expect(named).not.toBe(xml);
      zip.file('word/document.xml', named);
      const result = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
      const source = /!\[a\]\(([^)]+)\)/.exec(result.markdown)![1];
      expect(source).toMatch(/^[^.]+\.png$/);
      expect([...result.images!.keys()]).toEqual([source]);
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
    ['an empty HTML comment and another', 'A <!--><!-- b --> B'],
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
    // Which a table's comment ends at, but not one inline Markdown reads
    ['an HTML comment after a --!> in it', 'A <!-- a --!> b --> B', 12],
    // Which reads as a payload's start, but in a comment with no end yet
    ['an HTML comment before a ZWSP and an image\'s Markdown in it', 'A <!-- a \u200B![y](n.png)\u200B tail --> B', 8],
    ['an HTML comment after a --!> in it before a ZWSP and an image\'s Markdown', 'A <!-- a --!>\u200B![y](n.png)\u200B tail --> B', 12],
    // Which got an end, though the next ended it
    ['an HTML comment before a <!-- in it', 'A <!-- a <!-- b --> C', 8],
    // Which read as its end
    ['an HTML comment after a <!---> in it', 'A <!-- a <!---> b --> C', 14],
    // Which read as its end
    ['an HTML comment after an empty one', '<!--><!-- c -->', 12],
    ['an HTML comment after an empty one, in its <!--', '<!--><!-- c -->', 7],
    ['an HTML comment around an empty one, and after it', 'A <!-- a <!--->b --> B', [8, 16]],
  ])('joins %s when Word splits its run', async (_name, md, at) => {
    // Without the start of its opener, the run before it was dropped
    const { docx } = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const rPr = '<w:r><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr>';
    const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const encode = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cuts = [0, ...[at].flat(), Infinity];
    const split = xml.replace(new RegExp(rPr + '<w:t>([^<]*)</w:t></w:r>'), (_m, text: string) =>
      cuts.slice(1).map((cut, k) => rPr + '<w:t>' + encode(decode(text).slice(cuts[k], cut)) + '</w:t></w:r>').join(''));
    expect(split).not.toBe(xml);
    zip.file('word/document.xml', split);
    const markdown = (await convertDocx(new Uint8Array(await zip.generateAsync({ type: 'uint8array' })))).markdown;
    expect(markdown).toContain(md);
  });

  test.each([
    ['text', 'A <!-- a --!>\u200B b --> B'],
    ['an image\'s Markdown', 'A <!-- a --!>\u200B![y](n.png)\u200B tail --> B'],
    ['a comment\'s start', 'A <!-- a --!>\u200B<!-- b --> B'],
  ])('keeps a ZWSP and %s in an HTML comment after a --!> in it, which inline Markdown reads on', async (_name, md) => {
    // It read as the start of another hidden payload, and the rest went
    expect((await roundTrip(md)).markdown).toBe(md + '\n');
  });

  test('keeps a comment block with trailing whitespace, with no other end', async () => {
    // An end went on the comment, after its whitespace, which showed it
    const md = '<!-- c -->  \n\nText.';
    expect((await roundTrip(md)).markdown).toBe(md + '\n');
  });

  test('keeps a ZWSP after a ---> in an HTML comment, which inline Markdown reads on', async () => {
    // It read as the comment's end, and the rest went
    const md = 'A <!-- a ---> b --->\u200Btail --> B';
    expect((await roundTrip(md)).markdown).toBe(md + '\n');
  });

  test('keeps a ZWSP and an image\'s Markdown in a pipe cell\'s comment after a --!> in it', async () => {
    // A --!> ended it, as in an HTML table's cell, and the rest went
    const md = '| A |\n| --- |\n| B <!-- a --!>\u200B![y](n.png)\u200B tail --> C |';
    expect((await roundTrip(md)).markdown).toBe(md + '\n');
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

describe('Line breaks in a pipe table\'s cells', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');

  test.each([
    '| a |\n| --- |\n| x<br>y |\n',
    '| a<br>b | c |\n| --- | --- |\n| x<br><br>y | **p<br>q** |\n',
    '| a |\n| --- |\n| `x`<br>`y` |\n',
    '| a |\n| --- |\n| x\\\\<br>y |\n',
    '| a |\n| --- |\n| x <br> y |\n',
    '| a |\n| --- |\n| {++x<br>y++} |\n',
    '| a |\n| --- |\n| `x`<br>$y$<br>{>>c<<} |\n',
    // Line breaks at a cell's end, which Word shows as its blank lines
    '| a |\n| --- |\n| x<br>y<br><br> |\n',
    '| a |\n| --- |\n| x<br> |\n',
  ])('keeps %j a pipe table', async (md) => {
    // A line break made it an HTML table, as a cell's line can't hold the
    // backslash and line end of one
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['after LaTeX\'s \\\\', 'a \\\\\nb'],
    ['after a backslash in a LaTeX comment', 'a % c \\\nb'],
  ])('writes no pipe table where an equation has a line end in it, %s', (_name, latex) => {
    // Which isn't a line break
    const cell = { paragraphs: [[{ type: 'math', latex, display: false }]] };
    const table = { type: 'table', rows: [{ isHeader: false, cells: [cell] }] } as unknown as ContentItem;
    expect(buildMarkdown([table], new Map())).not.toStartWith('| ');
  });
});

describe('Markdown across Word runs', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, '');
  const run = (text: string, rPr = '') => '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + text + '</w:t></w:r>';
  /** The document export makes of XX, with its run as `runs` */
  const withRuns = async (runs: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('XX')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>XX<\/w:t><\/w:r>/s, runs);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    return zip.generateAsync({ type: 'uint8array' });
  };
  /** The body's runs, their text and formatting, and its links */
  const shown = async (docx: Uint8Array) => {
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const body = xml.slice(xml.indexOf('<w:body>'), xml.lastIndexOf('<w:sectPr'));
    return [...body.matchAll(/<w:hyperlink\b|<w:r>([\s\S]*?)<\/w:r>/g)].map(([r, inner]) => r === '<w:hyperlink' ? 'link'
      : (inner.match(/<w:(?:b|i|strike|highlight|rStyle)\b[^>]*>/g) ?? []).join('') + (inner.match(/<w:t[^>]*>([^<]*)<\/w:t>/)?.[1] ?? ''));
  };

  test.each([
    ['a citation\'s key', run('[@a') + run('b]', '<w:b/>'), '\\[@a**b]**'],
    ['a citation\'s key in italic', run('[@a') + run('b]', '<w:i/>'), '\\[@a*b]*'],
    ['a citation\'s locator', run('[@a, p. ') + run('2', '<w:b/>') + run(']'), '\\[@a, p. **2**]'],
    ['a citation\'s prefix, whose formatting the ] ends', run('[see ') + run('x @a]', '<w:b/>'), '\\[see **x @a]**'],
    ['a citation\'s prefix, whose formatting the [ starts', run('x [see', '<w:b/>') + run(' y @a]'), '**x \\[see** y @a]'],
    ['a citation\'s later prefix', run('[@a; see ') + run('x', '<w:i/>') + run(' @b]'), '\\[@a; see *x* @b]'],
    ['a URL\'s host', run('https://') + run('e.com', '<w:strike/>'), 'https\\://~~e.com~~'],
    ['a highlighted URL\'s host', run('https://') + run('e.com', '<w:highlight w:val="yellow"/>'), 'https\\://==e.com=='],
    ['a URL\'s host in code', run('https://') + run('e.com', '<w:rStyle w:val="CodeChar"/>'), 'https\\://`e.com`'],
    ['a URL\'s host with a run struck', run('https://') + run('e', '<w:strike/>') + run('.com'), 'https\\://~~e~~.com'],
    ['a URL in the delimiters of its strikethrough', run('https://', '<w:strike/>') + run(' e.com'), '~~https\\://~~ e.com'],
  ])('keeps Word\'s text as text where Markdown would read %s across runs', async (_name, runs, md) => {
    // Export read the delimiters between the runs as part of the citation's
    // text, as the key a**b, or linkify as part of the URL's
    const docx = await withRuns(runs);
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(md + '\n');
    expect(await shown((await convertMdToDocx(markdown)).docx)).toEqual(await shown(docx));
  });

  test.each([
    ['at its end', run('a ', '<w:strike/>') + run('b'), '<s>a </s>b'],
    ['at its start', run('a') + run(' b', '<w:strike/>'), 'a<s> b</s>'],
    ['alone', run('a') + run(' ', '<w:strike/>') + run('b'), 'a<s> </s>b'],
    ['alone at the paragraph\'s start', run('  ', '<w:strike/>') + run('b'), '<s>  </s>b'],
    ['at the paragraph\'s end', run('a ', '<w:strike/>'), '<s>a </s>'],
    ['in bold', run('a ', '<w:b/><w:strike/>') + run('b'), '<b><s>a </s></b>b'],
    ['after a backslash', run('a\\ ', '<w:strike/>') + run('b'), '<s>a\\\\ </s>b'],
  ])('keeps the strikethrough of whitespace %s', async (_name, runs, md) => {
    // It went outside the ~~, which can't hold it, or the run went plain
    const docx = await withRuns(runs);
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(md + '\n');
    expect(await shown((await convertMdToDocx(markdown)).docx)).toEqual(await shown(docx));
  });

  test.each([
    ['struck', [{ strikethrough: true }], '<s>see </s>[@doe2020]'],
    ['struck, bold and italic', [{ strikethrough: true, bold: true, italic: true }], '***<s>see </s>***[@doe2020]'],
    ['highlighted, bold and italic', [{ highlight: true, bold: true, italic: true }], '***==see ==***[@doe2020]'],
    ['underlined, bold and italic', [{ underline: true, bold: true, italic: true }], '***<u>see </u>***[@doe2020]'],
    ['struck and bold on a substitution\'s new side', [{}, { strikethrough: true, bold: true }], '{~~x~>**<s>see </s>**~~}[@doe2020]'],
    ['highlighted and bold on a substitution\'s new side', [{}, { highlight: true, bold: true }], '{~~x~>**==see ==**~~}[@doe2020]'],
    ['struck and bold on a substitution\'s old side', [{ strikethrough: true, bold: true }, {}], '{~~**<s>see </s>**~>x~~}[@doe2020]'],
  ])('puts no second space before a citation after a space at the end of text %s', (_name, formats, md) => {
    // The space was read before the </s>, as text's, and before the closes
    // of emphasis inside the outermost, which aren't marked, nor any once a
    // substitution's side is resolved
    const revision = (type: 'deletion' | 'addition') => formats.length > 1 ? { revision: { type, author: 'A', date: '' } } : {};
    const items: ContentItem[] = [
      ...formats.map((formatting, i) => ({
        type: 'text' as const, text: !!formatting.strikethrough || !!formatting.highlight || !!formatting.underline ? 'see ' : 'x',
        commentIds: new Set<string>(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, ...revision(i === 0 ? 'deletion' : 'addition'),
      })),
      { type: 'citation', text: '(Doe 2020)', commentIds: new Set(), pandocKeys: ['@doe2020'] },
    ];
    expect(buildMarkdown(items, new Map()).trim()).toBe(md);
  });

  test('writes a substitution whose side is code of many * in linear time', () => {
    // A regex for the closes at the side's end tried each way to split the
    // run of * into * and **, before it found the code's `
    const revision = (type: 'deletion' | 'addition') => ({ type, author: 'A', date: '' });
    const start = performance.now();
    const items: ContentItem[] = [
      { type: 'text', text: 'x', commentIds: new Set(), formatting: DEFAULT_FORMATTING, revision: revision('deletion') },
      { type: 'text', text: '*'.repeat(60), commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, code: true }, revision: revision('addition') },
    ];
    expect(buildMarkdown(items, new Map()).trim()).toBe('{~~x~>`' + '*'.repeat(60) + '`~~}');
    expect(performance.now() - start).toBeLessThan(500);
  });

  test.each([
    ['struck, before a digit', run('https://', '<w:strike/>') + run('1'), '{++~~https\\://~~++}{++1++}'],
    ['struck, before a letter', run('https://', '<w:strike/>') + run('e.com'), '{++~~https\\://~~++}{++e.com++}'],
    ['in code, before a letter', run('https://', '<w:rStyle w:val="CodeChar"/>') + run('e.com'), '{++`https://`++}{++e.com++}'],
  ])('keeps a URL\'s scheme %s in the same insertion, in a span of its own, as text', async (_name, runs, md) => {
    // Linkify read the text after it as the host, as if the spans joined,
    // though the span's delimiters came between, and read them as the host
    const docx = await withRuns('<w:ins w:id="91" w:author="A" w:date="2026-01-01T00:00:00Z">' + runs + '</w:ins>');
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(md + '\n');
    expect(await shown((await convertMdToDocx(markdown)).docx)).toEqual(await shown(docx));
  });

  test.each([
    ['an email address', run('x@y.com='), 'x\\@y.com&#61;==note=='],
    ['an email address in a sentence', run('mail x@y.com='), 'mail x\\@y.com&#61;==note=='],
  ])('keeps %s before an = before a highlight as text', async (_name, runs, md) => {
    // The = went as a reference, before the highlight's ==, which ended the
    // text linkify read, where it found the address
    const docx = await withRuns(runs + run('note', '<w:highlight w:val="yellow"/>'));
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(md + '\n');
    expect(await shown((await convertMdToDocx(markdown)).docx)).toEqual(await shown(docx));
  });

  test('keeps a citation across runs in a tracked change as text', async () => {
    const markdown = strip((await convertDocx(await withRuns(run('[@a')
      + '<w:ins w:id="91" w:author="A" w:date="2026-01-01T00:00:00Z">' + run('b]') + '</w:ins>'))).markdown);
    expect(markdown).toBe('\\[@a{++b]++}\n');
    expect(strip((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown)).toBe(markdown);
  });

  test.each([
    ['', {}, 'q \\[@key[^1] z'],
    [' in bold', { bold: true }, 'q **\\[@key**[^1] z'],
    [' underlined', { underline: true }, 'q <u>\\[@key</u>[^1] z'],
  ])('keeps the [ of text that starts a citation before a note reference%s as text', (_name, formatting, md) => {
    // The reference's ] closed the citation, which took the reference
    const run = (text: string, f: Partial<RunFormatting> = {}): ContentItem => ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...f } });
    const notes = { map: new Map([['footnote:1', { label: '1', body: [{ type: 'para' } as ContentItem, run('N')], noteKind: 'footnote' as const }]]), assignedLabels: new Map([['footnote:1', '1']]) };
    const out = buildMarkdown([{ type: 'para' } as ContentItem, run('q '), run('[@key', formatting), { type: 'footnote_ref', noteId: '1', noteKind: 'footnote', commentIds: new Set() } as ContentItem, run(' z')], new Map(), { notes });
    expect(out.split('\n\n[^1]:')[0]).toBe(md);
  });

  test('keeps a note reference after text that starts a citation', async () => {
    const markdown = 'q \\[@key[^1] z\n\n[^1]: N\n';
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:footnoteReference');
    expect(xml).toContain('[@key');
  });

  /** A Zotero citation of Doe's book, as a field */
  const zoteroField = (rPr = '') => '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION '
    + '{"citationItems":[{"id":1,"itemData":{"id":1,"type":"book","title":"T","author":[{"family":"Doe","given":"J"}],"issued":{"date-parts":[["2020"]]}}}]} '
    + '</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run('(Doe 2020)', rPr) + '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const inserted = (runs: string) => '<w:ins w:id="91" w:author="A" w:date="2026-01-01T00:00:00Z">' + runs + '</w:ins>';

  test.each([
    ['[@a ', run('[@a ') + zoteroField(), '\\[@a [@doe2020t]'],
    ['[@a', run('[@a') + zoteroField(), '\\[@a [@doe2020t]'],
    ['[@', run('[@') + zoteroField(), '\\[@ [@doe2020t]'],
    ['[-@a ', run('[-@a ') + zoteroField(), '\\[-@a [@doe2020t]'],
    ['[@a; ', run('[@a; ') + zoteroField(), '\\[@a; [@doe2020t]'],
    ['[@a, p. 2 ', run('[@a, p. 2 ') + zoteroField(), '\\[@a, p. 2 [@doe2020t]'],
    ['[@a in bold', run('[@a', '<w:b/>') + zoteroField(), '**\\[@a** [@doe2020t]'],
    ['[@a before a highlighted citation', run('[@a ') + zoteroField('<w:highlight w:val="yellow"/>'), '\\[@a ==[@doe2020t]=='],
    ['[@a before an inserted citation', run('[@a ') + inserted(zoteroField()), '\\[@a {++[@doe2020t]++}'],
    ['[@a inserted with the citation', inserted(run('[@a ') + zoteroField()), '{++\\[@a [@doe2020t]++}'],
    ['[@a before two citations', run('[@a ') + zoteroField() + run(' and ') + zoteroField(), '\\[@a [@doe2020t] and [@doe2020t]'],
  ])('keeps the [ of text %j before a citation as text', async (_name, runs, md) => {
    // Export read from the [ to the citation's ], as one citation of the
    // key a [@doe2020t, which took the citation
    const docx = await withRuns(run('x ') + runs);
    const { markdown, bibtex } = await convertDocx(docx);
    expect(strip(markdown)).toBe('x ' + md + '\n');
    const again = (await convertMdToDocx(markdown, { bibtex })).docx;
    expect(await (await JSZip.loadAsync(again)).file('word/document.xml')!.async('string')).toContain('ZOTERO_ITEM CSL_CITATION');
    expect(strip((await convertDocx(again)).markdown).replace(/^\n+/, '')).toBe('x ' + md + '\n');
  });

  test('keeps the [ of text before a citation in a note as text', () => {
    const text = (value: string): ContentItem => ({ type: 'text', text: value, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
    const citation: ContentItem = { type: 'citation', text: '(Doe 2020)', commentIds: new Set(), pandocKeys: ['@doe2020'] };
    const notes = { map: new Map([['footnote:1', { label: '1', body: [{ type: 'para' } as ContentItem, text('y [@a '), citation], noteKind: 'footnote' as const }]]), assignedLabels: new Map([['footnote:1', '1']]) };
    const out = buildMarkdown([{ type: 'para' } as ContentItem, text('q'), { type: 'footnote_ref', noteId: '1', noteKind: 'footnote', commentIds: new Set() } as ContentItem], new Map(), { notes });
    expect(out.split('\n\n[^1]: ')[1].trim()).toBe('y \\[@a [@doe2020]');
  });

  test.each(['x \\[@a [@doe2020]\n', 'x \\[-@a; [@doe2020]\n', 'x [see @a, [@doe2020]\n', 'x @a [@doe2020]\n'])('keeps %j as it is', async (md) => {
    const bibtex = '@book{doe2020,\n  author = {Doe, J},\n  title = {T},\n  year = {2020},\n}\n';
    const { markdown } = await convertDocx((await convertMdToDocx(md, { bibtex })).docx);
    expect(strip(markdown).replace(/^\n+/, '')).toBe(md);
  });

  test('keeps the [ of text that starts an image around a note reference as text', () => {
    // Read as its ], the reference's left the [ before it unescaped
    const run = (text: string): ContentItem => ({ type: 'text', text, commentIds: new Set(), formatting: DEFAULT_FORMATTING });
    const notes = { map: new Map([['footnote:1', { label: '1', body: [{ type: 'para' } as ContentItem, run('N')], noteKind: 'footnote' as const }]]), assignedLabels: new Map([['footnote:1', '1']]) };
    const out = buildMarkdown([{ type: 'para' } as ContentItem, run('![text'), { type: 'footnote_ref', noteId: '1', noteKind: 'footnote', commentIds: new Set() } as ContentItem, run('](image.png)')], new Map(), { notes });
    expect(out.split('\n\n[^1]:')[0]).toBe('!\\[text[^1]](image.png)');
  });

  test.each([
    // A prefix whose formatting closes in it, which export reads as text
    '[see *x* @a]\n', '[x **y** @a] and [see `c` @b]\n', '[see {++x++} @a]\n', '{==[see *x* @a]==}{>>c<<}\n',
    // A host its delimiters end
    'https://**e.com**\n', 'https://{++e.com++}\n',
  ])('keeps %j as it is', async (md) => {
    expect(strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown)).toBe(md);
  });

  test.each([['[@a', 'b]'], ['[see ', 'x @a]'], ['https://', 'e']])('escapes runs of %j and struck %j in linear time', (text, struck) => {
    const items = Array.from({ length: 32000 }, (_, k) => (
      { type: 'text', text: k % 2 ? struck : text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, strikethrough: k % 2 === 1 } }));
    const start = performance.now();
    buildMarkdown(items as ContentItem[], new Map());
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe('Highlights across runs', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  /** The document export makes of `md`, with its run of XX in `part` as `runs` */
  const withRuns = async (runs: string, md = 'XX', part = 'word/document.xml') => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file(part)!.async('string');
    const broken = xml.replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>XX<\/w:t><\/w:r>/s, runs);
    expect(broken).not.toBe(xml);
    zip.file(part, broken);
    return zip.generateAsync({ type: 'uint8array' });
  };
  const markdownOf = async (docx: Uint8Array) => (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  const fromWord = async (runs: string, md = 'XX', part = 'word/document.xml') => markdownOf(await withRuns(runs, md, part));
  /** The runs of a document's `part` as Word shows them: each one's text
   *  after its formatting, and a + or - in a tracked change, with the text
   *  of those alike side by side joined, and its links */
  const shownRuns = async (docx: Uint8Array, part = 'word/document.xml') => {
    const xml = await (await JSZip.loadAsync(docx)).file(part)!.async('string');
    const shown: string[] = [];
    let change = '';
    let last: string | undefined;
    for (const [tag, inner] of xml.matchAll(/<\/?w:(?:ins|del)\b[^>]*>|<w:hyperlink\b|<w:r>([\s\S]*?)<\/w:r>/g)) {
      if (tag === '<w:hyperlink') {
        shown.push('link');
        last = undefined;
      } else if (inner === undefined) {
        change = tag.startsWith('</') ? '' : tag.startsWith('<w:ins') ? '+' : '-';
        continue;
      }
      const format = change + (inner.match(/<w:(?:b|i|strike|highlight)\b[^>]*>|<w:rStyle w:val="CodeChar"\/>/g) ?? []).sort().join('');
      const text = [...inner.matchAll(/<w:(?:t|delText)\b[^>]*>([^<]*)<|<w:tab\/>/g)].map(m => m[1] ?? '\t').join('');
      if (format === last) shown[shown.length - 1] += text;
      else shown.push(format + text);
      last = format;
    }
    return shown;
  };
  const highlighted = (text: string, rPr = '', color = 'yellow') => '<w:r><w:rPr>' + rPr + '<w:highlight w:val="' + color + '"/></w:rPr><w:t xml:space="preserve">' + text + '</w:t></w:r>';
  const plain = (text: string) => '<w:r><w:t xml:space="preserve">' + text + '</w:t></w:r>';

  test.each([
    '==a *b* c==\n', '==a **b** d=={red}\n', '==a <u>b</u> <sup>c</sup>==\n', '**==a==** b\n', '*==a==* ==b==\n',
    // Code, which navigation reads no highlight around, and another color,
    // whose == the joined highlight's would run into, keep theirs apart
    '==a== ==`b`== ==c==\n', '==a== *==b==* ==c== ==d=={red}\n',
  ])('keeps %j as it is', async (md) => {
    // Each run had a highlight of its own, so the spaces between them,
    // which Word highlighted, lost theirs
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['a highlighted space at its end', highlighted('a ') + '<w:r><w:t>b</w:t></w:r>', '==a ==b\n'],
    ['a highlighted space at its start', '<w:r><w:t>a</w:t></w:r>' + highlighted(' b'), 'a== b==\n'],
    ['highlighted spaces alone', '<w:r><w:t>a</w:t></w:r>' + highlighted('  ') + '<w:r><w:t>b</w:t></w:r>', 'a==  ==b\n'],
    ['runs highlighted alike', highlighted('a ') + highlighted('b', '<w:i/>') + highlighted(' c'), '==a *b* c==\n'],
    // Whose edge ~, which a highlight inside the ~~ kept from them, the ~~
    // read as theirs once the highlight went around them
    ['struck text with a ~ at its edge', highlighted('a ') + highlighted('~', '<w:strike/>'), '==a ~~\\~~~==\n'],
  ])('keeps Word\'s highlight with %s', async (_name, runs, md) => {
    // Its edge spaces went outside it, where Word showed them without it
    expect(await fromWord(runs)).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['a }', highlighted('a ') + plain('}'), '==a ==\\}\n'],
    ['a } with no space before it', highlighted('a') + plain('}'), '==a==\\}\n'],
    ['a color in braces', highlighted('a ') + plain('{red}'), '==a ==\\{red}\n'],
    ['a color in braces with no space before it', highlighted('a') + plain('{red}'), '==a==\\{red}\n'],
  ])('escapes %s after a highlight', async (_name, runs, md) => {
    // Its == read them as its own: ==a==} as CriticMarkup's ==}, which the
    // preview and navigation read as no highlight, and ==a=={red} as its
    // color, which lost the text
    expect(await fromWord(runs)).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    'P {====a ==\\{red}==}{>>c<<} Q\n', '{~~==a ==\\{red}~>x~~}\n', '{++==a ==\\{red}++}\n', '{--==a ==\\}--}\n',
  ])('keeps the escape after a highlight in %j', async (md) => {
    // In a comment, a substitution or a tracked change, which the escape
    // read the Markdown before it without
    expect(await roundTrip(md)).toBe(md);
  });

  const exported = '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>}x</w:t></w:r>';

  test.each([
    ['a comment over it', highlighted('}x'), 'P {==XX==}{>>c<<} Q', 'P {====\\}x====}{>>c<<} Q\n',
      '<w:commentRangeStart w:id="0"/>' + exported + '<w:commentRangeEnd w:id="0"/>', ['c']],
    ['a comment over text before it', plain('a') + highlighted('}x'), 'P {==XX==}{>>c<<} Q', 'P {==a==\\}x====}{>>c<<} Q\n',
      '<w:commentRangeStart w:id="0"/><w:r><w:t>a</w:t></w:r>' + exported + '<w:commentRangeEnd w:id="0"/>', ['c']],
    ['comments over it in ID syntax', highlighted('}x'), 'P {#1}{#2}XX{/2}{/1} Q\n{#1>>c<<}\n{#2>>d<<}', 'P {#1}{#2}==\\}x=={/1}{/2} Q\n{#1>>c<<}\n{#2>>d<<}\n',
      '<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/>' + exported + '<w:commentRangeEnd w:id="0"/>', ['c', 'd']],
    ['no comment', highlighted('}x'), 'XX', '==\\}x==\n', '>' + exported + '</w:p>', []],
  ])('escapes a } that starts a highlight\'s text with %s', async (_name, runs, template, md, xml, bodies) => {
    // Its == and the } read as CriticMarkup's ==}, which ended the comment's
    // range there, as in {====}x====}, which Word showed as x} with neither
    // the comment nor the highlight
    expect(await fromWord(runs, template)).toBe(md);
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    expect(await zip.file('word/document.xml')!.async('string')).toContain(xml);
    const comments = await zip.file('word/comments.xml')?.async('string') ?? '';
    expect([...comments.matchAll(/<w:t>([^<]*)<\/w:t>/g)].map(m => m[1])).toEqual(bodies);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    '{++==a ==b++}\n', '{++a== b==++}\n', '{--==a ==b--}\n', '{++==a==b++}\n', '{++==a *b*==++}\n', '{++a==b *c*==++}\n',
  ])('keeps %j one tracked change', async (md) => {
    // Its runs' spans didn't join at a highlight's ==, so it came back as
    // {++==a ==++}{++b++}, and ==a *b*== as two highlights
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['before another color\'s', highlighted('  ') + highlighted('b', '', 'red'), 'XX', '==  =={yellow}==b=={red}\n'],
    ['after another color\'s', highlighted('a', '', 'red') + highlighted('  ') + highlighted('b', '', 'blue'), 'XX', '==a=={red}==  =={yellow}==b=={blue}\n'],
    ['after an =', plain('a=') + highlighted('  ') + plain('b'), 'XX', 'a&#61;==  ==b\n'],
    ['at the end of a comment\'s text', highlighted('a', '', 'red') + highlighted('  '), 'P {==XX==}{>>c<<} Q', 'P {====a=={red}==  ====}{>>c<<} Q\n'],
    ['at the start of a comment\'s text', highlighted('  ') + highlighted('a', '', 'red'), 'P {==XX==}{>>c<<} Q', 'P {====  =={yellow}==a=={red}==}{>>c<<} Q\n'],
  ])('keeps the highlight of spaces alone %s', async (_name, runs, template, md) => {
    // They went without it where its == ran into the other highlight's, as
    // in ==  ====b=={red}, or the text's =, which navigation and the grammar
    // read as no highlight, the other's either
    const docx = await withRuns(runs, template);
    expect(await markdownOf(docx)).toBe(md);
    expect(await shownRuns((await convertMdToDocx(md)).docx)).toEqual(await shownRuns(docx));
    expect(await roundTrip(md)).toBe(md);
  });

  const tracked = (tag: 'ins' | 'del', runs: string) => '<w:' + tag + ' w:id="' + (tag === 'del' ? 1 : 2) + '" w:author="A" w:date="2026-01-01T00:00:00Z">'
    + (tag === 'del' ? runs.replace(/w:t\b/g, 'w:delText') : runs) + '</w:' + tag + '>';

  test.each([
    ['an = before it on the old side', tracked('del', plain('=') + highlighted(' ')) + tracked('ins', plain('new')), '{~~&#61;== ==~>new~~}\n'],
    ['an = before it on the new side', tracked('del', plain('old')) + tracked('ins', plain('=') + highlighted(' ') + plain('new')), '{~~old~>&#61;== ==new~~}\n'],
    ['an = before a tab', tracked('del', plain('old')) + tracked('ins', plain('=') + highlighted('\t') + plain('new')), '{~~old~>&#61;==\t==new~~}\n'],
    ['an = before it and text', tracked('del', plain('old')) + tracked('ins', plain('=') + highlighted(' y')), '{~~old~>&#61;== y==~~}\n'],
    ['another color\'s highlight after it', tracked('del', plain('old')) + tracked('ins', highlighted('y ') + highlighted('z', '', 'red')), '{~~old~>==y =={yellow}==z=={red}~~}\n'],
    ['another color\'s highlight before it', tracked('del', plain('old')) + tracked('ins', highlighted('y') + highlighted(' z', '', 'red')), '{~~old~>==y=={yellow}== z=={red}~~}\n'],
  ])('writes a substitution with the highlight of whitespace on a side next to %s', async (_name, runs, md) => {
    // Resolving the side moved the whitespace out of its highlight, or the
    // highlight with it, so the side's items went in spans of their own, as
    // {--\=--}{--== ==--}{++new++}
    const docx = await withRuns(runs);
    expect(await markdownOf(docx)).toBe(md);
    expect(await shownRuns((await convertMdToDocx(md)).docx)).toEqual(await shownRuns(docx));
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([['new', 'addition'], ['old', 'deletion']] as const)('writes many deletions before a highlighted space after an = on the %s side in linear time', (_side, type) => {
    // Each start in the deletions built its sides again, which each declined
    // where resolving them moved the space out of its highlight
    const item = (text: string, revision: 'addition' | 'deletion', formatting: Partial<RunFormatting> = {}) => (
      { type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, revision: { type: revision, author: 'A', date: '' } });
    const items = [
      ...Array.from({ length: 32000 }, (_, k) => item('d', 'deletion', { bold: k % 2 === 1 })),
      item('=', type), item(' ', type, { highlight: true }), item('n', 'addition'),
    ];
    const start = performance.now();
    expect(buildMarkdown(items as ContentItem[], new Map())).toEndWith(type === 'addition' ? '**~>&#61;== ==n~~}' : '**&#61;== ==~>n~~}');
    expect(performance.now() - start).toBeLessThan(3000);
  });

  const revised = (text: string, type: 'addition' | 'deletion', formatting: Partial<RunFormatting> = {}, commentIds = new Set<string>()): ContentItem => (
    { type: 'text', text, commentIds, formatting: { ...DEFAULT_FORMATTING, ...formatting }, revision: { type, author: 'A', date: '' } });
  const deletedMath = (latex: string): ContentItem => ({ type: 'math', latex, display: false, commentIds: new Set(), revision: { type: 'deletion', author: 'A', date: '' } });

  test.each([
    // Whose ~> or ~~} its ~~ makes, once resolving drops the mark after it
    ['struck text starting with > at the old side\'s end', [revised('>y', 'deletion', { strikethrough: true }), revised('n', 'addition')], 1000, '{--**d**--}{--~~>y~~--}{++n++}'],
    ['struck text starting with } at the old side\'s end', [revised('}y', 'deletion', { strikethrough: true }), revised('n', 'addition')], 1000, '{--**d**--}{--~~}y~~--}{++n++}'],
    ['an insertion in a comment\'s range', [revised('n', 'addition', {}, new Set(['1']))], 8000, '{--**d**--}{=={++n++}==}'],
    ['a deletion in a comment\'s range', [revised('z', 'deletion', {}, new Set(['1'])), revised('n', 'addition')], 8000, '{--**d**--}{=={--z--}==}{++n++}'],
    ['a ~~} on the new side', [revised('n', 'addition', { strikethrough: true }), revised('}', 'addition')], 1000, '{++~~n~~++}{++}++}'],
    ['two equations in a row on the old side', [deletedMath('x'), deletedMath('y'), revised('n', 'addition')], 1000, '{--$x$--}{--$y$--}{++n++}'],
    ['an empty new side', [revised('', 'addition'), revised('', 'addition')], 1000, '{--**d**--}{++++}'],
  ] as const)('writes many deletions before %s, from which no substitution holds, in linear time', (_name, tail, size, end) => {
    // Each start in the deletions built its sides again, or read to their
    // end again, and declined as the first had
    const items = (n: number) => [...Array.from({ length: n }, (_, k) => revised('d', 'deletion', { bold: k % 2 === 1 })), ...tail];
    // The fastest of a few runs, which a pause for garbage collection
    // doesn't slow
    const time = (n: number) => {
      const content = items(n);
      let fastest = Infinity;
      for (let k = 0; k < 5; k++) {
        const start = performance.now();
        buildMarkdown(content, new Map());
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    expect(buildMarkdown(items(size), new Map())).toEndWith(end);
    // About 2 in linear time, and 4 in time in the square of the deletions
    expect(time(2 * size) / time(size)).toBeLessThan(3);
  }, 30000);

  test('keeps a substitution from after an equation and an empty run before struck text resolving writes as <s>', () => {
    // The run before the struck text was taken to write alike from each
    // start, past the equation, after which its letter is a reference
    const items = [
      revised('>a', 'deletion', { strikethrough: true }), deletedMath('x'), revised('', 'deletion', { bold: true }), revised('c', 'deletion'),
      revised('}.', 'deletion', { strikethrough: true }), revised('new', 'addition'),
    ];
    expect(buildMarkdown(items, new Map())).toBe('{--~~>a~~--}{--$x$--}{~~c<s>}.</s>~>new~~}');
  });

  test.each([
    ['', '{--~~>a~~--}{--**x**--}{--~~>a~~--}{--**x**--}{++c++}'],
    [' in a link', '[{--~~>a~~--}{--**x**--}{--~~>a~~--}{~~**x**~>c~~}](https://e.com)'],
  ])('writes many deletions of struck text that starts with > between bold ones before an insertion%s in linear time', (link, end) => {
    // Resolving writes each struck run's ~~ before its > as a ~>, which
    // kept the starts before the last from a substitution only where all
    // the runs before it wrote alike, as struck ones don't, or in a link,
    // only up to the first, so each start built its sides again
    const inLink = (item: ContentItem): ContentItem => (link ? { ...item, href: 'https://e.com', link: 1 } as ContentItem : item);
    const items = (n: number) => [
      ...Array.from({ length: n }, () => [revised('>a', 'deletion', { strikethrough: true }), revised('x', 'deletion', { bold: true })]).flat(),
      revised('c', 'addition'),
    ].map(inLink);
    const time = (n: number) => {
      const content = items(n);
      let fastest = Infinity;
      for (let k = 0; k < 5; k++) {
        const start = performance.now();
        buildMarkdown(content, new Map());
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    expect(buildMarkdown(items(2), new Map())).toBe(end);
    // About 2 in linear time, and 4 in time in the square of the deletions
    expect(time(2000) / time(1000)).toBeLessThan(3);
  }, 60000);

  test('writes many deletions before an empty one and struck text that starts with > before an insertion in linear time', () => {
    // The empty run writes nothing, so the run before the struck one is
    // the last that writes, which was taken to be the empty one, so that
    // no start was kept from a substitution and each built its sides again
    const items = (n: number) => [
      ...Array.from({ length: n }, () => [revised('d', 'deletion'), revised('d', 'deletion', { bold: true })]).flat(),
      revised('', 'deletion', { italic: true }), revised('>a', 'deletion', { strikethrough: true }), revised('new', 'addition'),
    ];
    const time = (n: number) => {
      const content = items(n);
      let fastest = Infinity;
      for (let k = 0; k < 5; k++) {
        const start = performance.now();
        buildMarkdown(content, new Map());
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    expect(buildMarkdown(items(2), new Map())).toBe('{--d--}{--**d**--}{--d--}{--**d**--}{----}{--~~>a~~--}{++new++}');
    // About 2 in linear time, and 4 in time in the square of the deletions
    expect(time(2000) / time(1000)).toBeLessThan(3);
  }, 120000);

  test.each([
    ['a link\'s line break', '{--~~>a~~--}{~~[\\\n](https://e.com)<s>>b.</s>c~>new~~}\n'],
    ['an equation', '{--~~>a~~--}{--$x$--}{~~c<s>}.</s>~>new~~}\n'],
  ])('keeps a substitution from after struck text that starts with > and %s, before struck text resolving writes as <s>', async (_name, md) => {
    // The later struck text's ~~ before its > or }, which resolving writes
    // as <s> where text comes before or after it, was taken for a ~> or ~~}
    // that kept each start before it from a substitution, as the first's
    // is, so the runs went in spans, where the link lost its line break
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['an = and a highlighted space', [['=', {}], [' ', { highlight: true }], ['n', {}]], '{++=++}{++== ==n++}'],
    ['text', [['new', {}]], '{++new++}'],
  ] as const)('writes many deletions that end in a ~> before an insertion of %s in linear time', (_name, added, md) => {
    // The ~>, which would split the substitution, kept each start in the
    // deletions from one, and each built its sides again. Four times the
    // deletions take about four times as long, not sixteen.
    const item = (text: string, revision: 'addition' | 'deletion', formatting: Partial<RunFormatting> = {}) => (
      { type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, revision: { type: revision, author: 'A', date: '' } });
    const time = (n: number) => {
      const items = [
        ...Array.from({ length: n }, (_, k) => item('d', 'deletion', { bold: k % 2 === 1 })), item('x~>', 'deletion'),
        ...added.map(([text, formatting]) => item(text, 'addition', formatting)),
      ];
      const start = performance.now();
      expect(buildMarkdown(items as ContentItem[], new Map())).toEndWith('{--x~>--}' + md);
      return performance.now() - start;
    };
    const small = time(1000);
    expect(time(4000) / small).toBeLessThan(8);
  });

  test.each([
    ['alone', highlighted('x@y.com=', '', 'red'), '==x\\@y.com&#61;=={red}\n'],
    ['on a substitution\'s old side', tracked('del', highlighted('a ') + highlighted('x@y.com=', '', 'red')) + tracked('ins', highlighted('new')),
      '{~~==a =={yellow}==x\\@y.com&#61;=={red}~>==new==~~}\n'],
    ['on a substitution\'s new side', tracked('del', plain('old')) + tracked('ins', highlighted('a ') + highlighted('x@y.com=', '', 'red')),
      '{~~old~>==a =={yellow}==x\\@y.com&#61;=={red}~~}\n'],
  ])('keeps an email address before an = in a highlight %s as text', async (_name, runs, md) => {
    // Linkify found no address in x@y.com=, so its @ went unescaped, but the
    // = went as a reference, which ends the text linkify reads, so export
    // linked x@y.com
    const docx = await withRuns(runs);
    expect(await markdownOf(docx)).toBe(md);
    expect(await shownRuns((await convertMdToDocx(md)).docx)).toEqual(await shownRuns(docx));
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['a line break of a link', [['a', undefined, {}, true], ['\\\n', 'deletion', {}, true], ['=', 'addition'], [' ', 'addition', { highlight: true }], ['n', 'addition']], '[a{--\\\n--}](https://e.com){++'],
    ['a link after a !', [['!'], ['=', 'deletion', {}, true], [' ', 'deletion', { highlight: true }, true], ['n', 'addition', {}, true], ['x', 'addition']], '\\![{~~'],
  ] as const)('keeps the changes at a link\'s end with %s in the link, before an insertion after it by a highlighted space next to an =', (_name, runs, part) => {
    // A substitution took them, in a link of their own, which in spans of
    // their own lost the break's link, and read as an image after the !
    const items = runs.map(([text, revision, formatting, linked]: readonly [string, ('addition' | 'deletion')?, Partial<RunFormatting>?, boolean?]) => ({
      type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting },
      ...(revision ? { revision: { type: revision, author: 'A', date: '' } } : {}), ...(linked ? { href: 'https://e.com', link: 1 } : {}),
    }));
    expect(buildMarkdown(items as ContentItem[], new Map())).toContain(part);
  });

  test.each([
    ['text\'s = after it', tracked('del', plain('old')) + tracked('ins', highlighted('y ') + plain('=')), '{~~old~>==y ==\\=~~}\n'],
    ['text between it and an =', tracked('del', plain('old')) + tracked('ins', plain('=x') + highlighted(' y')), '{~~old~>=x== y==~~}\n'],
  ])('writes a substitution with a highlighted space next to %s', async (_name, runs, md) => {
    expect(await fromWord(runs)).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test('keeps a highlight\'s edge space in a comment beside another color\'s', async () => {
    const md = 'P {====a== ==  =={red}==}{>>c<<} Q\n';
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['a }', highlighted('a ') + highlighted('}', '<w:b/>'), '==a ==**==\\}==**\n'],
    ['an =', highlighted('a ') + highlighted('b', '<w:i/>') + highlighted('=c'), '==a ==*==b==*===c==\n'],
  ])('joins no highlight through %s', async (_name, runs, md) => {
    // Which navigation and the grammar read no highlight around, so they
    // read none around its neighbours' text either
    expect(await fromWord(runs)).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  const code = (text: string, rPr = '', color = 'yellow') => highlighted(text, '<w:rStyle w:val="CodeChar"/>' + rPr, color);
  /** Highlighted code as export writes it, a run of each text */
  const codeRuns = (texts: string[], rPr = '', color = 'yellow', t = 'w:t') => texts.map(text =>
    '<w:r><w:rPr><w:rStyle w:val="CodeChar"/>' + rPr + '<w:highlight w:val="' + color + '"/></w:rPr><' + t + '>' + text + '</' + t + '></w:r>').join('');
  const exportedPart = async (md: string, part = 'word/document.xml') =>
    (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file(part)!.async('string');

  test.each([
    ['an == in it', code('x =='), '==`x =`=={yellow}==`=`=={yellow}\n', codeRuns(['x =', '='])],
    ['an == at its start', code('==x'), '==`=`=={yellow}==`=x`=={yellow}\n', codeRuns(['=', '=x'])],
    ['= alone', code('==='), '==`=`=={yellow}==`=`=={yellow}==`=`=={yellow}\n', codeRuns(['=', '=', '='])],
    ['a } after an ==', code('a==}b'), '==`a=`=={yellow}==`=}b`=={yellow}\n', codeRuns(['a=', '=}b'])],
    ['an == in another color', code('x ==', '', 'red'), '==`x =`=={red}==`=`=={red}\n', codeRuns(['x =', '='], '', 'red')],
    ['an == in bold', code('x ==', '<w:b/>'), '**==`x =`=={yellow}==`=`=={yellow}**\n', codeRuns(['x =', '='], '<w:b/>')],
    ['an == before highlighted text', code('x ==') + highlighted(' b'), '==`x =`=={yellow}==`=`=={yellow}== b==\n', codeRuns(['x =', '='])],
    ['an == after runs highlighted alike', highlighted('a ') + highlighted('b', '<w:i/>') + plain(' ') + code('x =='),
      '==a *b*== ==`x =`=={yellow}==`=`=={yellow}\n', codeRuns(['x =', '='])],
  ])('keeps the highlight of code with %s', async (_name, runs, md, exported) => {
    // Code dropped it, which the == would close, even in code, as in
    // ==`x ==`==, and export wrote it without
    expect(await fromWord(runs)).toBe(md);
    expect(await exportedPart(md)).toContain(exported);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['an insertion', tracked('ins', code('x ==')), 'XX', '{++==`x =`=={yellow}==`=`=={yellow}++}\n', codeRuns(['x =', '='])],
    ['a deletion', tracked('del', code('x ==')), 'XX', '{--==`x =`=={yellow}==`=`=={yellow}--}\n', codeRuns(['x =', '='], '', 'yellow', 'w:delText')],
    ['a substitution\'s side', tracked('del', plain('old')) + tracked('ins', code('x ==')), 'XX', '{~~old~>==`x =`=={yellow}==`=`=={yellow}~~}\n',
      codeRuns(['x =', '='])],
    ['a comment\'s text', code('x =='), 'P {==XX==}{>>c<<} Q', 'P {====`x =`=={yellow}==`=`=={yellow}==}{>>c<<} Q\n', codeRuns(['x =', '='])],
    ['a table\'s cell', code('x =='), '| a | b |\n|---|---|\n| XX | z |', '| a | b |\n| --- | --- |\n| ==`x =`=={yellow}==`=`=={yellow} | z |\n',
      codeRuns(['x =', '='])],
    ['a note', code('x =='), 'P[^1]\n\n[^1]: XX', 'P[^1]\n\n[^1]: ==`x =`=={yellow}==`=`=={yellow}\n', codeRuns(['x =', '=']), 'word/footnotes.xml'],
  ])('keeps the highlight of code with an == in %s', async (_name, runs, template, md, exported, part = 'word/document.xml') => {
    expect(await fromWord(runs, template, part)).toBe(md);
    expect(await exportedPart(md, part)).toContain(exported);
    expect(await roundTrip(md)).toBe(md);
  });

  test('keeps the highlight of code with an == beside a highlighted note reference', async () => {
    // Which go in one highlight but for the code, whose == would close it
    const md = 'P ==a[^1]== ==`x =`=={yellow}==`=`=={yellow}\n\n[^1]: N\n';
    expect(await exportedPart(md)).toContain(codeRuns(['x =', '=']));
    expect(await roundTrip(md)).toBe(md);
  });

  /** The document export makes of `template`, with its run of XX as `runs`,
   *  which hold its note's reference in place of its own */
  const withNoteIn = async (runs: string, template = 'XX[^1]\n\n[^1]: N') => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(template)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const reference = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>';
    expect(xml).toContain(reference);
    const moved = xml.replace(reference, '').replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>XX<\/w:t><\/w:r>/s, runs);
    zip.file('word/document.xml', moved);
    return zip.generateAsync({ type: 'uint8array' });
  };
  const highlightedNote = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:highlight w:val="yellow"/></w:rPr><w:footnoteReference w:id="1"/></w:r>';
  const struck = (text: string) => highlighted(text, '<w:strike/>');

  test.each([
    ['a struck } and code with a deletion\'s closer', 'XX[^1]', tracked('del', struck('}') + code('a --}') + highlightedNote),
      '{--~~==\\}==~~--}{~~==`a --}`[^1]==~>~~}'],
    ['a struck } and code with an insertion\'s closer', 'XX[^1]', tracked('ins', struck('}') + code('a ++}') + highlightedNote),
      '{++~~==\\}==~~++}{~~~>==`a ++}`[^1]==~~}'],
    ['code with the closer, then a struck }', 'XX[^1]', tracked('del', code('a --}') + struck('}') + highlightedNote),
      '{~~==`a --}`==~>~~}{--==~~}~~[^1]==--}'],
    ['a > after struck text and code with the closer', 'XX[^1]', tracked('del', highlightedNote + struck('a') + highlighted('&gt;') + code('a --}')),
      '{--==[^1]~~a~~>==--}{~~==`a --}`==~>~~}'],
    ['text with a ~> and code with the closer', 'XX[^1]', tracked('del', highlighted('a ~&gt; b') + code('c --}') + highlightedNote),
      '{--==a ~> b==--}{~~==`c --}`[^1]==~>~~}'],
    ['a struck } and code with the closer before an insertion', 'XX[^1]', tracked('del', struck('}') + code('a --}') + highlightedNote) + tracked('ins', plain('c')),
      '{~~~~==\\}==~~==`a --}`[^1]==~>c~~}'],
    ['a struck } and code with the closer in a comment\'s range', 'P {==XX==}{>>c<<} Q[^1]', tracked('del', struck('}') + code('a --}') + highlightedNote),
      'P {=={--~~==\\}==~~--}{~~==`a --}`[^1]==~>~~}==}{>>c<<} Q'],
  ])('keeps a tracked change\'s highlight with a note reference, %s, in spans the change\'s can hold', async (_name, template, runs, md) => {
    // Its one span had the closer and what a substitution can't hold, as
    // {~~==~~}~~`a --}`[^1]==~>~~}, whose ~~} ended it, and Word lost the
    // change and the highlight of the text after
    const docx = await withNoteIn(runs, template + '\n\n[^1]: N');
    const withNote = md + '\n\n[^1]: N\n';
    expect(await markdownOf(docx)).toBe(withNote);
    expect(await shownRuns((await convertMdToDocx(withNote)).docx)).toEqual(await shownRuns(docx));
    expect(await roundTrip(withNote)).toBe(withNote);
  });

  test('keeps a tracked change\'s highlight with a note reference in one span where it holds a struck } that reads as a tag', async () => {
    // Whose } can't close a ~~ before the letter after it
    const docx = await withNoteIn(tracked('del', struck('}') + highlighted('b') + code('a --}') + highlightedNote));
    const md = '{~~==<s>}</s>b`a --}`[^1]==~>~~}\n\n[^1]: N\n';
    expect(await markdownOf(docx)).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['text', highlightedNote + highlighted('a='), '==[^1]a&#61;=='],
    ['an = alone', highlightedNote + highlighted('='), '==[^1]&#61;=='],
    ['text with a backslash', highlightedNote + highlighted('a\\='), '==[^1]a\\\\&#61;=='],
    ['text of another color', highlightedNote.replace('yellow', 'red') + highlighted('a=', '', 'red'), '==[^1]a&#61;=={red}'],
    ['text after an equation', highlighted('b') + '<m:oMath><m:r><m:t>q</m:t></m:r></m:oMath>' + highlighted('a=') + plain(' ') + highlightedNote, '==&#98;$q$&#97;&#61;== ==[^1]=='],
    ['text before an equation', highlightedNote + highlighted('a=') + '<m:oMath><m:r><m:t>q</m:t></m:r></m:oMath>', '==[^1]a&#61;==$q$'],
    ['text in an insertion', tracked('ins', highlightedNote + highlighted('a=')), '{++==[^1]a&#61;==++}'],
    ['text before =b', highlightedNote + highlighted('a=') + plain('=b'), '==[^1]a&#61;==\\=b'],
  ])('keeps the highlight of %s that ends in = after a note reference', async (_name, runs, md) => {
    // The = ran into the highlight's closing ==, as in ==[^1]a===, which
    // export read as the highlight's closer, and the = after it without it
    const docx = await withNoteIn(runs);
    const withNote = md + '\n\n[^1]: N\n';
    expect(await markdownOf(docx)).toBe(withNote);
    expect(await shownRuns((await convertMdToDocx(withNote)).docx)).toEqual(await shownRuns(docx));
    expect(await roundTrip(withNote)).toBe(withNote);
  });

  test('writes a long run in a tracked change\'s highlight that its span can\'t hold whole in linear time', () => {
    // Each group the span held in it was found from the run's whole length
    const deleted = { type: 'deletion', author: 'A', date: '' } as const;
    const item = (text: string, formatting: Partial<RunFormatting> = {}) =>
      ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, highlight: true, ...formatting }, revision: deleted });
    const note = (k: number) =>
      ({ type: 'footnote_ref', noteId: String(k), noteKind: 'footnote', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, highlight: true }, revision: deleted });
    const time = (n: number) => {
      const items = [{ type: 'para' }, ...Array.from({ length: n }, (_, k) => [item('}', { strikethrough: true }), item(' b'), item('c --}', { code: true }), note(k + 1)]).flat()];
      let fastest = Infinity;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        const markdown = buildMarkdown(items as ContentItem[], new Map());
        expect(markdown.slice(markdown.lastIndexOf('{--~~'))).toBe('{--~~==\\}==~~--}{--== b==--}{~~==`c --}`[^' + n + ']==~>~~}');
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    const small = time(400);
    expect(time(800) / small).toBeLessThan(3);
  });

  test('writes the = that ends a highlight after a note reference and many backslashes in linear time', () => {
    // A regex found the backslashes before the = from each of them in turn,
    // and past some thousands of them gave up, which left the = as it was
    const highlight = { ...DEFAULT_FORMATTING, highlight: true };
    const time = (n: number) => {
      const items = Array.from({ length: 5 }, (_, k) => [{ type: 'para' },
        { type: 'footnote_ref', noteId: String(k + 1), noteKind: 'footnote', commentIds: new Set(), formatting: highlight },
        { type: 'text', text: '\\'.repeat(n) + 'a=', commentIds: new Set(), formatting: highlight }]).flat();
      let fastest = Infinity;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        const markdown = buildMarkdown(items as ContentItem[], new Map());
        fastest = Math.min(fastest, performance.now() - start);
        expect(markdown.endsWith('a&#61;==')).toBe(true);
      }
      return fastest;
    };
    const small = time(4000);
    expect(time(8000) / small).toBeLessThan(3);
    // Where the regex gave up
    time(16000);
  });

  test('reads a highlighted run of many line breaks in linear time', async () => {
    // A regex with a lazy middle found the breaks at its edges, which past
    // some thousands of them found no match and threw
    const start = performance.now();
    expect(await fromWord('<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>a</w:t>' + '<w:br/>'.repeat(16000) + '<w:t>b</w:t></w:r>'))
      .toBe('==a' + '\\\n'.repeat(16000) + 'b==\n');
    expect(performance.now() - start).toBeLessThan(3000);
  });

  test('keeps a highlight\'s edge space outside it before a comment\'s ==}', async () => {
    // Which export read as one highlight in the comment, ==a=={red}==b ==
    const md = '{====a=={red}==b== ==}{>>c<<}\n';
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['an =', highlighted('b') + plain('=c'), '==b==\\=c\n'],
    ['an = after an edge space', highlighted('a ') + plain('=b'), '==a ==\\=b\n'],
    ['an = after a joined highlight', highlighted('a ') + highlighted('b', '<w:b/>') + plain('=c'), '==a **b**==\\=c\n'],
    ['==', highlighted('b') + plain('==c'), '==b==\\==c\n'],
  ])('escapes %s after a highlight', async (_name, runs, md) => {
    // Which navigation and the grammar read with the highlight's ==, as in
    // ==b===c, as no highlight
    expect(await fromWord(runs)).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    '{=={++==a *b*==++}==}{>>c<<}\n', '{~~==a *b*==~>x~~}\n', '{~~x~>==a *b*==~~}\n',
  ])('joins the highlights of runs alike in %j', async (md) => {
    // In a comment's text or a substitution's side, each run had a
    // highlight of its own, and an insertion's split in two at them
    expect(await roundTrip(md)).toBe(md);
  });

  test('reads many runs in one tracked change in linear time', async () => {
    // The escape after a highlight read the Markdown before each run, which
    // copied all of it. Four times the runs take about four times as long,
    // not sixteen, however fast the machine is.
    const time = async (runs: number) => {
      const md = '{++' + Array.from({ length: runs }, () => 'a *b* ').join('').trimEnd() + '++}\n';
      const docx = (await convertMdToDocx(md)).docx;
      const start = performance.now();
      expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '')).toBe(md);
      return performance.now() - start;
    };
    const small = await time(10000);
    expect(await time(40000) / small).toBeLessThan(8);
  });

  test('writes a paragraph of many comments in linear time', () => {
    // Each comment's text read which highlights join from its start to the
    // paragraph's end, and kept what it read
    const n = 20000;
    const comments = new Map(Array.from({ length: n }, (_, k) => [String(k), { author: 'A', text: 'c', date: '' }]));
    const items = Array.from({ length: 2 * n }, (_, k) => (
      { type: 'text', text: k % 2 ? 'x' : ' a ', commentIds: new Set(k % 2 ? [String((k - 1) / 2)] : []), formatting: DEFAULT_FORMATTING }));
    const start = performance.now();
    buildMarkdown(items as ContentItem[], comments);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  test('reads many runs highlighted alike in linear time', async () => {
    // Each run's highlight joins its neighbours' if theirs do, which is
    // read for the whole range at once
    const md = '==' + Array.from({ length: 20000 }, (_, k) => k % 2 ? '*a*' : 'b ').join('') + '==\n';
    const docx = (await convertMdToDocx(md)).docx;
    const start = performance.now();
    expect((await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '')).toBe(md);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  const cell = '| h |\n|---|\n| XX |';
  const note = 'P[^1]\n\n[^1]: XX';
  const comment = 'P {==XX==}{>>c<<} Q';

  test.each([
    ['an =', plain('a=') + highlighted(' b'), 'XX', 'a&#61;== b==\n'],
    ['an = with no space', plain('a=') + highlighted('b'), 'XX', 'a&#61;==b==\n'],
    ['an = after another highlight', highlighted('a') + plain('=') + highlighted(' b', '', 'red'), 'XX', '==a==&#61;== b=={red}\n'],
    ['an = before runs highlighted alike', plain('x=') + highlighted(' a') + highlighted('b', '<w:b/>'), 'XX', 'x&#61;== a**b**==\n'],
    ['another color\'s highlight', highlighted('a ') + highlighted('b', '', 'red'), 'XX', '==a =={yellow}==b=={red}\n'],
    ['another color\'s highlight before it', highlighted('a') + highlighted(' b', '', 'red'), 'XX', '==a=={yellow}== b=={red}\n'],
    ['another color\'s highlight with no space', highlighted('a') + highlighted('b', '', 'red'), 'XX', '==a=={yellow}==b=={red}\n'],
    ['highlighted code', highlighted('a ') + highlighted('b', '<w:rStyle w:val="CodeChar"/>'), 'XX', '==a =={yellow}==`b`==\n'],
    ['highlighted code before it', highlighted('b', '<w:rStyle w:val="CodeChar"/>') + highlighted(' a'), 'XX', '==`b`=={yellow}== a==\n'],
    ['an = in a table\'s cell', plain('a=') + highlighted(' b'), cell, '| h |\n| --- |\n| a&#61;== b== |\n'],
    ['another color\'s highlight in a table\'s cell', highlighted('a ') + highlighted('b', '', 'red'), cell, '| h |\n| --- |\n| ==a =={yellow}==b=={red} |\n'],
    ['an = in a note', plain('a=') + highlighted(' b'), note, 'P[^1]\n\n[^1]: a&#61;== b==\n'],
    ['another color\'s highlight in a note', highlighted('a ') + highlighted('b', '', 'red'), note, 'P[^1]\n\n[^1]: ==a =={yellow}==b=={red}\n'],
    ['an = in a comment\'s text', plain('a=') + highlighted(' b'), comment, 'P {==a&#61;== b====}{>>c<<} Q\n'],
    ['another color\'s highlight in a comment\'s text', highlighted('a ') + highlighted('b', '', 'red'), comment, 'P {====a =={yellow}==b=={red}==}{>>c<<} Q\n'],
    // Which navigation and the grammar read whole
    ['a comment\'s {==', highlighted(' a') + plain(' x'), comment, 'P {==== a== x==}{>>c<<} Q\n'],
    ['a comment\'s ==}', plain('x ') + highlighted('a '), comment, 'P {==x ==a ====}{>>c<<} Q\n'],
  ])('keeps a highlight and its edge space next to %s', async (_name, runs, template, md) => {
    // The space went outside the highlight where an = ran into its ==, as in
    // ==a ====b=={red} and a=== b==, which navigation and the grammar read
    // as no highlight, as they did with no space or with the = escaped
    const part = template === note ? 'word/footnotes.xml' : 'word/document.xml';
    const docx = await withRuns(runs, template, part);
    expect(await markdownOf(docx)).toBe(md);
    expect(await shownRuns((await convertMdToDocx(md)).docx, part)).toEqual(await shownRuns(docx, part));
    expect(await roundTrip(md)).toBe(md);
  });

  const run = (text: string, formatting: Partial<RunFormatting> = {}, revision?: RevisionInfo) =>
    ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, ...(revision ? { revision } : {}) }) as ContentItem;
  const citation = (formatting: Partial<RunFormatting> = {}, revision?: RevisionInfo) =>
    ({ type: 'citation', text: '(Doe 2020)', pandocKeys: ['@doe2020'], commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, ...(revision ? { revision } : {}) }) as ContentItem;
  const inserted: RevisionInfo = { type: 'addition', author: 'A', date: '2024-01-01T00:00:00Z' };
  const deleted: RevisionInfo = { ...inserted, type: 'deletion' };

  test.each([
    ['a highlight that ends in a space', [run('Seen '), run('a ', { highlight: true }), citation()], 'Seen ==a ==[@doe2020]'],
    ['bold around a highlight that ends in a space', [run('Seen '), run('a ', { highlight: true, bold: true }), citation()], 'Seen **==a ==**[@doe2020]'],
    ['an inserted highlight that ends in a space', [run('Seen '), run('a ', { highlight: true }, inserted), citation({}, inserted)], 'Seen {++==a ==++}{++[@doe2020]++}'],
    ['underlined text that ends in a space', [run('Seen '), run('a ', { underline: true }), citation()], 'Seen <u>a </u>[@doe2020]'],
    // A substitution's sides are resolved apart, so their highlights' ==
    // have no marks
    ['a substitution whose new side ends in a highlighted space', [run('Seen '), run('x', {}, deleted), run('a ', { highlight: true }, inserted), citation()], 'Seen {~~x~>==a ==~~}[@doe2020]'],
    ['a substitution whose old side ends in a highlighted space', [run('Seen '), run('a ', { highlight: true }, deleted), run('y', {}, inserted), citation()], 'Seen {~~==a ==~>y~~}[@doe2020]'],
    ['a substitution whose new side ends in a space highlighted in a color', [run('Seen '), run('x', {}, deleted), run('a ', { highlight: true, highlightColor: 'red' }, inserted), citation()], 'Seen {~~x~>==a =={red}~~}[@doe2020]'],
    ['a substitution whose new side ends in a highlighted space after an escaped backslash', [run('Seen '), run('x', {}, deleted), run('a\\', {}, inserted), run('b ', { highlight: true }, inserted), citation()], 'Seen {~~x~>a\\\\==b ==~~}[@doe2020]'],
  ])('puts no second space before a citation after %s', (_name, items, md) => {
    // The space before the citation read the formatting's close as the text
    // before it, and added one
    expect(buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim()).toBe(md);
  });

  test.each(['{red-}', '{-red}'])('puts a space before a citation after a highlight that ends in a space and text %s, which is no color', (text) => {
    // It read the text as the highlight's color, and the space before it
    // as the text before the citation, as with {x}, which is escaped
    expect(buildMarkdown([{ type: 'para' }, run('Seen '), run('a ', { highlight: true }), run(text), citation()] as ContentItem[], new Map()).trim())
      .toBe('Seen ==a ==' + text + ' [@doe2020]');
  });

  test('joins the highlights of runs formatted otherwise before text in braces that is no color', () => {
    // It read the text as the next highlight's color, which no other had,
    // and wrote two, as ==**a**====*b*=={red-}, as before {x}, escaped
    expect(buildMarkdown([{ type: 'para' }, run('x '), run('a', { highlight: true, bold: true }), run('b', { highlight: true, italic: true }), run('{red-}')] as ContentItem[], new Map()).trim())
      .toBe('x ==**a**<i>b</i>=={red-}');
  });

  test.each([
    ['text', run('a==', {}, inserted), 'a\\=='],
    ['a citation without keys', { type: 'citation', text: 'Smith 2020 ==', pandocKeys: [], commentIds: new Set(), revision: inserted } as ContentItem, 'Smith 2020 \\=='],
  ])('puts a space before a citation after a substitution whose side ends in %s\'s ==, which it escapes', (_name, item, side) => {
    expect(buildMarkdown([{ type: 'para' }, run('Seen '), run('x', {}, deleted), item, citation()] as ContentItem[], new Map()).trim())
      .toBe('Seen {~~x~>' + side + '~~} [@doe2020]');
  });

  test.each([
    ['== after a space', [run('a ==', {}, inserted)]],
    ['== and a color after a space', [run('a =={red}', {}, inserted)]],
    ['== and a color after a space, after a highlight', [run('b ', { highlight: true }, inserted), run('a =={red}', {}, inserted)]],
    ['== and a color after a space, after code\'s ==', [run('==', { code: true }, inserted), run('a =={red}', {}, inserted)]],
    ['== and a color after a space, after a link with == in its URL', [{ ...run('b', {}, inserted), href: 'https://e.com/?token==' } as ContentItem, run('a =={red}', {}, inserted)]],
    ['== and a color after a space, after math with ==', [{ type: 'math', latex: 'a==b', display: false, commentIds: new Set(), revision: inserted } as ContentItem, run(' a =={red}', {}, inserted)]],
    ['== and a color no highlight takes, after a highlighted space', [run('a ', { highlight: true }, inserted), run('{red-}', {}, inserted)]],
  ])('puts a space before a citation after a substitution whose side ends in text\'s %s, which opens no highlight', (_name, items) => {
    // It read the == as a highlight's close, though none opened, as the
    // close of one before it or code's == did, and the space before it as
    // the side's last
    const md = buildMarkdown([{ type: 'para' }, run('Seen '), run('x', {}, deleted), ...items, citation()] as ContentItem[], new Map()).trim();
    expect(md).toEndWith('~~} [@doe2020]');
  });

  test('puts no second space before a citation after a substitution whose side ends in a highlighted space after code\'s ==', () => {
    // Code's == is text, which opens no highlight and closes none
    const md = buildMarkdown([{ type: 'para' }, run('Seen '), run('x', {}, deleted), run('==', { code: true }, inserted), run('b ', { highlight: true }, inserted), citation()] as ContentItem[], new Map()).trim();
    expect(md).toEndWith('==b ==~~}[@doe2020]');
  });

  test.each([
    ['', [run('Seen'), citation({ highlight: true })], 'Seen ==[@doe2020]=='],
    [' in a substitution', [run('Seen'), run('x', {}, { ...inserted, type: 'deletion' }), citation({ highlight: true }, inserted)], 'Seen{~~x~> ==[@doe2020]==~~}'],
  ])('puts the space before a highlighted citation outside its highlight%s', (_name, items, md) => {
    // The highlight held it, as it holds its edge spaces, so export
    // highlighted a space Word doesn't have
    expect(buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim()).toBe(md);
  });

  test.each([
    ['a } at its start', [run('Seen '), run('}x', { highlight: true }), citation({ highlight: true })], 'Seen ==\\}x [@doe2020]=='],
  ])('escapes %s in a highlight of a citation and text', async (_name, items, md) => {
    // Which read with the highlight's == as CriticMarkup's ==}, as in
    // ==}x [@doe2020]==, which export read as no highlight
    const markdown = buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim();
    expect(markdown).toBe(md);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')).toStartWith(md + '\n');
  });

  test.each([
    ['a {', [run('Seen '), citation({ highlight: true }), run('a{\\\n', { highlight: true }), run('b')], 'Seen ==[@doe2020]a{\\\n==b', 'Seen ==[@doe2020]a\\{\\\n==b'],
    ['a { after an escaped backslash', [run('Seen '), citation({ highlight: true }), run('a\\{\\\n', { highlight: true }), run('b')], 'Seen ==[@doe2020]a\\\\{\\\n==b', 'Seen ==[@doe2020]a\\\\\\{\\\n==b'],
  ])('keeps %s before a line break at the end of a highlight of a citation and text in it', async (_name, items, md, back) => {
    // The highlight holds the line break, which Word highlights, so its ==
    // comes after it, not after the {, where the two read as {==. Export
    // writes the break in a run of its own, after which the { ends a run's
    // text, which escapes it.
    const markdown = buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim();
    expect(markdown).toBe(md);
    const trip = async (text: string) => (await convertDocx((await convertMdToDocx(text)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    expect(await trip(markdown)).toStartWith(back + '\n');
    expect(await trip(back)).toStartWith(back + '\n');
  });

  test.each([
    ['struck', [run('https://', { highlight: true, strikethrough: true }), run(' b', { highlight: true })], '==~~https\\://~~ b=='],
    ['before its host', [run('https://', { highlight: true }), run('e.com', { highlight: true })], '==https\\://e.com=='],
  ])('escapes the scheme of a URL in a highlight that joins the runs after it, %s', async (_name, items, md) => {
    // Export's linkify read the joined highlight's text on past the run, as
    // https://~~, which took the strikethrough's closer, or https://e.com
    const markdown = buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim();
    expect(markdown).toBe(md);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()).toBe(md);
  });

  const noteRef = { type: 'footnote_ref', noteId: '1', noteKind: 'footnote', commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, highlight: true } } as ContentItem;

  test.each([
    ['a highlight', [run('http://'), run(' b', { highlight: true })], 'http\\://== b=='],
    ['a highlight after text', [run('x ftp://'), run('\tb', { highlight: true, highlightColor: 'red' })], 'x ftp\\://==\tb=={red}'],
    ['struck text in a highlight', [run('https://'), run(' b', { highlight: true, strikethrough: true })], 'https\\://~~== b==~~'],
    ['highlighted code', [run('http://'), run(' b', { highlight: true, code: true })], 'http\\://==` b`=='],
    ['highlighted superscript', [run('http://'), run(' b', { highlight: true, superscript: true })], 'http\\://==<sup> b</sup>=='],
    ['runs highlighted alike', [run('http://'), run(' b', { highlight: true, bold: true }), run('c', { highlight: true })], 'http\\://== **b**c=='],
    ['runs highlighted alike with no space', [run('http://'), run('b', { highlight: true, underline: true }), run('c', { highlight: true })], 'http\\://==<u>b</u>c=='],
    ['a highlighted note reference', [run('http://'), noteRef], 'http\\://==[^1]=='],
    ['bold text and a note reference highlighted alike', [run('http://'), run('b', { highlight: true, bold: true }), noteRef], 'http\\://==**b**[^1]=='],
  ])('escapes the scheme of a URL before %s, whose == goes before the text and the space at its start', async (_name, items, md) => {
    // Export's linkify read the == on with the URL, as http://==, which took
    // the highlight's opener, so the highlight's text lost it and came back
    // with its closer as text, as http://== b\==
    const markdown = buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim();
    expect(markdown).toBe(md);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()).toBe(md);
  });

  const yellow = '<w:highlight w:val="yellow"/>';

  test.each([
    ['an =', [run('x='), run(' a', { highlight: true }), noteRef], 'x&#61;== a[^1]==', ['x=', yellow + ' a']],
    ['an = with no space', [run('x='), noteRef, run(' a', { highlight: true })], 'x&#61;==[^1] a==', ['x=', yellow + ' a']],
    ['another color\'s highlight', [noteRef, run('a ', { highlight: true }), run('b', { highlight: true, highlightColor: 'red' })], '==[^1]a =={yellow}==b=={red}',
      [yellow + 'a ', '<w:highlight w:val="red"/>b']],
  ])('keeps a highlight with a note reference in it and its edge space next to %s', async (_name, items, md, runs) => {
    // The space went outside the highlight where the = ran into its ==, as
    // x= ==a[^1]==, which navigation and the grammar read as no highlight
    // with the =, as they did x\===[^1] a==
    expect(buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim()).toBe(md);
    const withNote = md + '\n\n[^1]: n\n';
    expect(await shownRuns((await convertMdToDocx(withNote)).docx)).toEqual(runs);
    expect(await roundTrip(withNote)).toBe(withNote);
  });

  test.each([
    ['a table\'s cell', '| h |\n|---|\n| XX |', '| h |\n| --- |\n| http\\://== b== |\n'],
    ['a comment\'s range', 'P {==XX==}{>>c<<} Q', 'P {==http\\://== b====}{>>c<<} Q\n'],
    ['a substitution', 'P {~~x~>XX~~} Q', 'P {~~x~>http\\://== b==~~} Q\n'],
  ])('escapes the scheme of a URL before a highlight\'s space in %s', async (_name, template, md) => {
    expect(await fromWord(plain('http://') + highlighted(' b'), template)).toBe(md);
    expect(await roundTrip(md)).toBe(md);
  });

  test.each([
    ['emphasis around it', [run('http://'), run(' b', { highlight: true, bold: true })], 'http://**== b==**'],
    ['a space before it', [run('http://'), run(' b', { bold: true })], 'http:// **b**'],
  ])('writes the scheme of a URL before a highlight or emphasis with %s as it is', (_name, items, md) => {
    // Whose * ends the URL before the highlight's ==, as the space does
    // before emphasis
    expect(buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim()).toBe(md);
  });

  test.each([
    ['a ~~ inside emphasis, which keeps it', [run('https://', { highlight: true, italic: true, strikethrough: true }), run('example.com', { highlight: true })],
      '==<i>~~https\\://~~</i>example.com=='],
    ['a ~~ inside emphasis, outside a highlight', [run('https://', { italic: true, strikethrough: true }), run('example.com')], '<i>~~https\\://~~</i>example.com'],
    ['an escaped _ in a highlight', [run('https://', { highlight: true }), run('_', { highlight: true, strikethrough: true })], '==https\\://~~\\_~~=='],
    ['an escaped _', [run('https://'), run('a_', { strikethrough: true })], 'https\\://~~a\\_~~'],
    ['a highlight\'s color', [run('https://'), run('e.com', { highlight: true, highlightColor: 'red' }), run('e_x')], 'https\\://==e.com=={red}e_x'],
    ['a ~~ that can\'t close, a tag', [run('https://'), run('~-', { code: true }), run('e-', { strikethrough: true }), run('Z')], 'https\\://`~-`<s>e-</s>Z'],
    ['a ~~ that runs into the one before it, a tag', [run('x http://', { strikethrough: true }), run('e_x', { strikethrough: true, highlight: true }), run('Z')],
      '~~x http\\://~~<s>==e_x==</s>Z'],
    ['highlights that don\'t join', [run('http://'), run('~-', { highlight: true }), run('c ', { highlight: true, italic: true }), run('~', { highlight: true, code: true }), run('Z')],
      'http\\://==~-==*==c ==*==`~`==Z'],
  ])('escapes the scheme of a URL whose host goes on as the runs after it write it, past %s', async (_name, items, md) => {
    // The host was read from the runs' text and delimiters, not their
    // Markdown: with a ~~ as a tag where it wasn't, or as one where it was,
    // which ends the host, as an escape's backslash or a color's { does, and
    // after a _, which keeps a host from ending, linkify found none
    const markdown = buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim();
    expect(markdown).toBe(md);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()).toBe(md);
  });

  test.each([
    ['a space at the end of its run', [run('x http:// ', { highlight: true }), run('d e', { highlight: true, strikethrough: true }), run('Z')], '==x http:// ~~d e~~==Z'],
    ['a ~~ that closes after it, a tag', [run('https://', { strikethrough: true }), run('example.com')], '<s>https://</s>example.com'],
  ])('writes the scheme of a URL before %s as it is', (_name, items, md) => {
    expect(buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim()).toBe(md);
  });

  const keyless = (commentIds: string[] = [], revision?: RevisionInfo) =>
    ({ type: 'citation', text: '{1}', pandocKeys: [], commentIds: new Set(commentIds), formatting: DEFAULT_FORMATTING, ...(revision ? { revision } : {}) }) as ContentItem;

  test.each([
    ['', [run('Seen '), run('a ', { highlight: true }), keyless()], 'Seen ==a ==\\{1}'],
    [' in a comment\'s range', [run('Seen '), { ...run('a ', { highlight: true }), commentIds: new Set(['0']) }, keyless(['0'])], 'Seen {====a ==\\{1}==}{>>@A | n<<}'],
    [' in a substitution', [run('Seen '), run('x', {}, { ...inserted, type: 'deletion' }), run('a ', { highlight: true }, inserted), keyless([], inserted)], 'Seen {~~x~>==a ==\\{1}~~}'],
  ])('escapes the text of a citation without keys after a highlight, whose == would take it as a color%s', (_name, items, md) => {
    // Export read ==a =={1} as a highlight colored 1, without the text
    expect(buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map([['0', { author: 'A', text: 'n', date: '' }]])).trim()).toBe(md);
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

  // A document from Word, with no stored settings
  const fromWord = (...paragraphs: [string, string?][]) => buildSyntheticDocx(wrapDocumentXml(paragraphs.map(([text, style]) => '<w:p>'
    + (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : '') + '<w:r><w:t>' + text + '</w:t></w:r></w:p>').join('')));
  const paragraphStyles = async (docx: Uint8Array) => {
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    return [...xml.matchAll(/<w:pStyle w:val="([^"]+)"/g)].map(m => m[1]);
  };

  test.each(['Quote', 'IntenseQuote'])('keeps the %s style of a quote from Word', async (style) => {
    const { markdown } = await convertDocx(await fromWord(['Start.'], ['q', style]));
    expect(markdown).toBe('---\nblockquote-style: ' + style + '\n---\n\nStart.\n\n> q\n');
    expect(await paragraphStyles((await convertMdToDocx(markdown)).docx)).toEqual([style]);
  });

  test('takes the style most quotes from Word are in, the first on a tie, and not an alert\'s', async () => {
    const frontmatter = async (...paragraphs: [string, string?][]) =>
      /^---\n([\s\S]*?)\n---/.exec((await convertDocx(await fromWord(...paragraphs))).markdown)?.[1] ?? '';
    expect(await frontmatter(['a', 'IntenseQuote'], ['b'], ['c', 'Quote'], ['d'], ['e', 'Quote'])).toBe('blockquote-style: Quote');
    expect(await frontmatter(['a', 'IntenseQuote'], ['b'], ['c', 'Quote'])).toBe('blockquote-style: IntenseQuote');
    expect(await frontmatter(['a', 'GitHubNote'], ['b', 'GitHubNote'], ['c'], ['d', 'Quote'])).toBe('blockquote-style: Quote');
  });

  test('adds no blockquote-style for quotes in GitHub\'s style', async () => {
    expect((await convertDocx(await fromWord(['Start.'], ['q', 'GitHubBlockquote']))).markdown).toBe('Start.\n\n> q\n');
    expect((await convertDocx((await convertMdToDocx('Start.\n\n> q\n')).docx)).markdown).toBe('Start.\n\n> q\n');
  });

  test('keeps a stored blockquote-style over the style of the quotes', async () => {
    expect(await frontmatterOf('---\nblockquote-style: IntenseQuote\n---\n\n> q', async zip => {
      // As if the quote were restyled in Word
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file('word/document.xml', xml.replace(/w:val="IntenseQuote"/g, 'w:val="Quote"'));
    })).toBe('blockquote-style: IntenseQuote');
  });
});

describe('Links in a tracked change', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;

  test.each([
    ['before a word', 'x {++[a](https://e.com)b++} y'],
    ['after a word', 'x {++b[a](https://e.com)++} y'],
    ['before emphasis', 'x {++[a](https://e.com)*b*++} y'],
    ['after emphasis', 'x {++*b*[a](https://e.com)++} y'],
    ['after code', 'x {++`c`[a](https://e.com)++} y'],
    ['after math', 'x {++$c$[a](https://e.com)++} y'],
    ['before a link to one place', 'x {++[a](https://e.com)[b](https://e.com)++} y'],
    ['in a deletion, before a word', 'x {--[a](https://e.com)b--} y'],
    ['in a deletion, after a word', 'x {--b[a](https://e.com)--} y'],
    ['in a deletion, before a link to one place', 'x {--[a](https://e.com)[b](https://e.com)--} y'],
    ['in a substitution', 'x {~~[a](https://e.com)b~>c[d](https://e.com)~~} y'],
  ])('keeps a change with a link %s one change', async (_name, md) => {
    // The change was split at the link's ) or [, which bordered no syntax
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test('keeps an insertion that ends in ! apart from a link after it, which would read as an image', async () => {
    expect(await roundTrip('x {++b!++}{++[a](https://e.com)++} y')).toBe('x {++b!++}{++[a](https://e.com)++} y\n');
  });

  test('keeps two links to one place in an insertion two hyperlinks', async () => {
    const { docx } = await convertMdToDocx('x {++[a](https://e.com)[b](https://e.com)++} y');
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:hyperlink /g)?.length).toBe(2);
  });
});

describe('An & in a tracked change', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const roundTrip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);

  test.each([
    ['an insertion of a space and emphasis', 'x {++ *&*++} y'],
    ['an insertion of a word, a space and emphasis', 'x {++a *b&c*++} y'],
    ['a deletion of a space and bold', 'x {-- **&**--} y'],
    ['an insertion of an entity\'s text', 'x {++\u3000*\\&amp;*++} y'],
  ])('keeps %s with an & one change', async (_name, md) => {
    // An & split the change at each of its runs' edges, as &am and p; would
    // read as an entity, which runs with Markdown between them can't
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test.each([
    ['&am', 'p;', 'x {++\\&amp;++}'],
    ['a &a', 'mp;', 'x {++a \\&amp;++}'],
    ['&#3', '8;', 'x {++\\&#38;++}'],
    ['foo&bar@ex', 'ample.com', 'x {++foo&bar\\@example.com++}'],
    ['foobar@ex', 'ample.com', 'x foobar\\@example.com', false],
  ])('writes %s and %s, which Markdown shows nothing between, as one text', (a, b, expected, tracked = true) => {
    // Runs whose formatting differs only in a highlight's color without the
    // highlight, which Word's text never has, joined, and an entity or an
    // email address formed where they met
    const revision = tracked ? { type: 'addition' as const, author: 'A', date: '' } : undefined;
    const text = (t: string, formatting: RunFormatting) => ({ type: 'text' as const, text: t, commentIds: new Set<string>(), formatting, revision });
    const markdown = buildMarkdown([
      { type: 'para' },
      { type: 'text', text: 'x ', commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      text(a, DEFAULT_FORMATTING),
      text(b, { ...DEFAULT_FORMATTING, highlightColor: 'red' }),
    ] as ContentItem[], new Map());
    expect(markdown).toBe(expected);
  });
});

describe('Links of more than one run', () => {
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
  // The line breaks of a document's body that are in no hyperlink
  const breaksOutsideLinks = async (docx: Uint8Array) => {
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    return xml.replace(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/g, '').match(/<w:br\/>/g)?.length ?? 0;
  };
  // A Word document of `body`, whose hyperlinks r:id="L" go to
  // https://e.com, with comments 0 and 1
  const wordWithLinks = async (body: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com) {==c==}{>>note<<} {==d==}{>>other<<}')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const id = /<w:hyperlink r:id="(rId\d+)"/.exec(xml)![1];
    zip.file('word/document.xml', xml.replace(/<w:body>[\s\S]*?(?=<w:sectPr)/, () => '<w:body>' + body.replace(/r:id="L"/g, 'r:id="' + id + '"')));
    return zip.generateAsync({ type: 'uint8array' });
  };
  const text = (t: string) => '<w:r><w:t xml:space="preserve">' + t + '</w:t></w:r>';
  const lineBreak = '<w:r><w:br/></w:r>';
  const link = (runs: string) => '<w:hyperlink r:id="L">' + runs + '</w:hyperlink>';
  const start = (id: number) => '<w:commentRangeStart w:id="' + id + '"/>';
  const end = (id: number) => '<w:commentRangeEnd w:id="' + id + '"/>';
  const reference = (id: number) => '<w:r><w:commentReference w:id="' + id + '"/></w:r>';
  const inserted = (runs: string) => '<w:ins w:id="9" w:author="A" w:date="2024-01-01T00:00:00Z">' + runs + '</w:ins>';
  const deleted = (runs: string) => '<w:del w:id="8" w:author="A" w:date="2024-01-01T00:00:00Z">' + runs.replace(/w:t\b/g, 'w:delText') + '</w:del>';
  // Each hyperlink of a document's body: its target, and its runs' text,
  // with a deletion's in {- -}, an insertion's in {+ +} and a line break as ⏎
  const hyperlinksOf = async (docx: Uint8Array) => {
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    return [...xml.matchAll(/<w:hyperlink r:id="(rId\d+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/g)].map(([, id, runs]) =>
      new RegExp('Id="' + id + '"[^>]*Target="([^"]*)"').exec(rels)![1] + ' ' + runs.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '')
        .replace(/<w:ins\b[^>]*>/g, '{+').replace(/<\/w:ins>/g, '+}').replace(/<w:del\b[^>]*>/g, '{-').replace(/<\/w:del>/g, '-}')
        .replace(/<w:br\/>/g, '⏎').replace(/<[^>]+>/g, ''));
  };

  test.each([
    ['with formatting', '[a **b** c](https://e.com)'],
    ['with several kinds of formatting', '[a *b* `c` ~~d~~ e](https://e.com)'],
    ['with a line break', '[link\\\ntext](https://e.com)'],
    ['with a line break before formatting', '[a\\\n**b**](https://e.com)'],
    ['with an insertion in part of it', '[a {++b++} c](https://e.com)'],
    ['with a deletion in part of it', '[a {--b--} c](https://e.com)'],
    ['with a substitution in part of it', '[a {~~b~>d~~} c](https://e.com)'],
    ['that is a substitution', '[{~~b~>d~~}](https://e.com)'],
    ['in an insertion', '{++[a **b** c](https://e.com)++}'],
    ['in a comment', '{==[a **b** c](https://e.com)==}{>>note<<}'],
    ['in a list item', '- [a **b** c](https://e.com)'],
    ['in a note', 'Text.[^1]\n\n[^1]: [a **b** c](https://e.com)'],
    ['in a deletion', '{--[a **b** c](https://e.com)--}'],
    ['with a line break, in a deletion', '{--[a\\\nb **c**](https://e.com)--}'],
  ])('keeps a link %s one link', async (_name, md) => {
    // Each run, and each side of a line break, was a link of its own
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test.each([
    ['brackets', '[\\[a **b** c\\]](https://e.com)'],
    ['formatting that is emphasis only as HTML there', '[a<b>b.</b>c](https://e.com)'],
    ['an @ first, which would read as a citation', '[\\@user **name**](https://e.com)'],
    ['a -@ first', '[-\\@user **name**](https://e.com)'],
    ['a substitution of formatted text', '[{~~a **b** c~>d *e* f~~}](https://e.com)'],
    ['a substitution of formatted text in part of it', '[x {~~a **b**~>d~~} y](https://e.com)'],
    ['a ! before it and an insertion first in it', '\\![{++a++} b](https://e.com)'],
    ['a ! before it and a deletion first in it', 'x\\![{--a--} **b**](https://e.com)'],
  ])('writes a link of more than one run with %s as a link of one run', async (_name, md) => {
    // Each run's Markdown read neither the link around it nor the runs
    // beside it, and a substitution paired only the runs at its seam
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test('writes a link of several deleted runs that an insertion replaces in a substitution', async () => {
    // The link kept its runs from the substitution, so the insertion went
    // in a span of its own, which the ++} in its code closed
    const zip = await JSZip.loadAsync((await convertMdToDocx('[a **b**](https://e.com)`cd`')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const revision = ' w:author="A" w:date="2024-01-01T00:00:00Z"';
    const replaced = xml.replace(/(<w:hyperlink [^>]*>)([\s\S]*?)<\/w:hyperlink>(<w:r><w:rPr><w:rStyle w:val="CodeChar"\/><\/w:rPr>)<w:t>cd<\/w:t><\/w:r>/,
      (_m, open: string, runs: string, code: string) => open + '<w:del w:id="91"' + revision + '>'
        + runs.replace(/<w:t\b/g, '<w:delText').replace(/<\/w:t>/g, '</w:delText>') + '</w:del></w:hyperlink>'
        + '<w:ins w:id="92"' + revision + '>' + code + '<w:t xml:space="preserve">c ++} d</w:t></w:r></w:ins>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe('{~~[a **b**](https://e.com)~>`c ++} d`~~}\n');
  });

  test.each([
    ['one run', '<w:r><w:t xml:space="preserve"> @user]</w:t></w:r>', '[ \\@user\\]](https://e.com)\n'],
    ['runs', '<w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>@user</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>]</w:t></w:r>',
      '[ \\@user<b>\\]</b>](https://e.com)\n'],
    ['one run, whose key starts outside the BMP', '<w:r><w:t xml:space="preserve">see @𝒜]</w:t></w:r>', '[see \\@𝒜\\]](https://e.com)\n'],
  ])('escapes the key in a link\'s text of %s that reads as a citation before its escaped ]', async (_name, runs, expected) => {
    // Export ends a citation at the first ], escaped too, which hid the
    // link's ](, so the link was a citation
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const replaced = xml.replace('<w:r><w:t>ab</w:t></w:r>', runs);
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe(expected);
    expect(await roundTrip(md.slice(0, -1))).toBe(md);
  });

  test('escapes the many keys in a link\'s text that reads as a citation before its escaped ] in linear time', () => {
    // Each key was escaped after a parse of the label, as it grew
    const items: ContentItem[] = [' @user'.repeat(2000) + ']', 'x'].map((text, k) => ({ type: 'text', text,
      href: 'https://e.com', link: 1, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, bold: k === 0 } }));
    const start = performance.now();
    const md = buildMarkdown(items, new Map());
    expect(performance.now() - start).toBeLessThan(1000);
    expect(md).toContain(' \\@user'.repeat(1999) + '\\]');
  });

  test('leaves the key in a link\'s code as it is, where a backslash would be text', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const replaced = xml.replace('<w:r><w:t>ab</w:t></w:r>',
      '<w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:t xml:space="preserve">see @user]</w:t></w:r>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe('[`see @user]`](https://e.com)\n');
  });

  test('writes a substitution in a link from a later deletion where one from the first doesn\'t hold', async () => {
    // A struck } wrote a ~~} in the deletions' side, and the deletions after
    // it took spans of their own, one ending at the --} in its code
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const revision = ' w:author="A" w:date="2024-01-01T00:00:00Z"';
    const deleted = (id: number, rPr: string, text: string) => '<w:del w:id="' + id + '"' + revision + '><w:r><w:rPr>' + rPr + '</w:rPr>'
      + '<w:delText xml:space="preserve">' + text + '</w:delText></w:r></w:del>';
    const replaced = xml.replace('<w:r><w:t>ab</w:t></w:r>', deleted(91, '<w:strike/>', '}') + deleted(92, '<w:rStyle w:val="CodeChar"/>', 'a --} b')
      + deleted(93, '<w:b/>', 'x') + '<w:ins w:id="94"' + revision + '><w:r><w:t>y</w:t></w:r></w:ins>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe('[{--~~}~~--}{~~`a --} b`**x**~>y~~}](https://e.com)\n');
    expect(await roundTrip(md.slice(0, -1))).toBe(md);
  });

  test('keeps a change of code with a --} at a link\'s end in the link, where its insertion goes on after a split', async () => {
    // A span of the deletion alone ended at the --} in its code, and then a
    // substitution of the deletion and insertion took them out of the link
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const revision = ' w:author="A" w:date="2024-01-01T00:00:00Z"';
    const replaced = xml.replace('<w:r><w:t>ab</w:t></w:r>', '<w:r><w:t xml:space="preserve">x </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>y</w:t></w:r>'
      + '<w:del w:id="91"' + revision + '><w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:delText xml:space="preserve">a --} b</w:delText></w:r></w:del>'
      + '<w:ins w:id="92"' + revision + '><w:r><w:br/></w:r><w:r><w:t xml:space="preserve"># b</w:t></w:r></w:ins>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe('[x **y**{~~`a --} b`~>\\\n~~}](https://e.com){++[# b](https://e.com)++}\n');
    const docx = (await convertMdToDocx(md.slice(0, -1))).docx;
    expect(await hyperlinksOf(docx)).toEqual(['https://e.com x y{-a --} b-}{+⏎+}', 'https://e.com {+# b+}']);
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  test('keeps a deletion of code with a --} that ends a link in the link, before its insertion after the link', async () => {
    // A span of the deletion alone ended at the --} in its code, and then a
    // substitution of the deletion and insertion took it out of the link
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com) z')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const revision = ' w:author="A" w:date="2024-01-01T00:00:00Z"';
    const replaced = xml.replace('<w:r><w:t>ab</w:t></w:r></w:hyperlink>', '<w:r><w:t xml:space="preserve">x </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>y</w:t></w:r>'
      + '<w:del w:id="91"' + revision + '><w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:delText xml:space="preserve">a --} b</w:delText></w:r></w:del>'
      + '</w:hyperlink><w:ins w:id="92"' + revision + '><w:r><w:t>c</w:t></w:r></w:ins>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe('[x **y**{~~`a --} b`~>~~}](https://e.com){++c++} z\n');
    const docx = (await convertMdToDocx(md.slice(0, -1))).docx;
    expect(await hyperlinksOf(docx)).toEqual(['https://e.com x y{-a --} b-}']);
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  test('keeps a substitution in a link whose insertion goes on after it in the link, and the rest of a ++} in code after it', async () => {
    // A span of the rest of the insertion ended at the ++} in its code, and
    // then a substitution of all of it took the link's runs out of the link
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com) z')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const revision = ' w:author="A" w:date="2024-01-01T00:00:00Z"';
    const replaced = xml.replace('<w:r><w:t>ab</w:t></w:r></w:hyperlink>', '<w:del w:id="91"' + revision + '><w:r><w:delText>a</w:delText></w:r></w:del>'
      + '<w:ins w:id="92"' + revision + '><w:r><w:t>b</w:t></w:r></w:ins></w:hyperlink>'
      + '<w:ins w:id="93"' + revision + '><w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:t xml:space="preserve">c ++} d</w:t></w:r></w:ins>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe('[{~~a~>b~~}](https://e.com){~~~>`c ++} d`~~} z\n');
    const docx = (await convertMdToDocx(md.slice(0, -1))).docx;
    expect(await hyperlinksOf(docx)).toEqual(['https://e.com {-a-}{+b+}']);
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  test.each([
    ['', '<span a="'],
    [', whose quoted value holds a >', '<span a="a>b'],
  ])('keeps the runs of a deleted link apart where one leaves a tag open%s', async (_name, text) => {
    // One link's text read the tag across the bold's delimiters as HTML
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const replaced = xml.replace(/<w:hyperlink [^>]*><w:r><w:t>ab<\/w:t><\/w:r><\/w:hyperlink>/, link => '<w:del w:id="91" w:author="A" w:date="2024-01-01T00:00:00Z">'
      + link.replace('<w:r><w:t>ab</w:t></w:r>', '<w:r><w:rPr><w:b/></w:rPr><w:delText>' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
        + '</w:delText></w:r><w:r><w:delText>"&gt;</w:delText></w:r>') + '</w:del>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe('{--[**\\' + text + '**](https://e.com)--}{--[">](https://e.com)--}\n');
    expect(await roundTrip(md.slice(0, -1))).toBe(md);
  });

  test.each([
    ['a quoted value', '<span a="', '">'],
    ['an unquoted value', '<span a=x', '>'],
  ])('escapes a tag with %s left open in a link\'s text, which the link after it to one place could close', async (_name, first, second) => {
    // The tag took the first link's ](url) and the second's [ as its
    // attribute's, which export wrote as text
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const bold = (text: string) => '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</w:t></w:r>';
    const replaced = xml.replace(/(<w:hyperlink [^>]*>)<w:r><w:t>ab<\/w:t><\/w:r><\/w:hyperlink>/, (_m, open: string) =>
      open + bold(first) + '</w:hyperlink>' + open + bold(second) + '</w:hyperlink>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe('[**\\' + first + '**](https://e.com)[**' + second + '**](https://e.com)\n');
    expect(await roundTrip(md.slice(0, -1))).toBe(md);
  });

  test.each([
    ['in code, as it is', '<w:rStyle w:val="CodeChar"/>', '<span a="', '[`<span a="`](https://e.com)'],
    ['inside a whole tag, as it is', '', '<a b="<span c=">', '[<a b="<span c=">](https://e.com)'],
    ['after a backslash of the text, escaped', '', '\\<span a="', '[\\\\\\<span a="](https://e.com)'],
    // Whose closing == isn't an attribute's =, where markdown-it reads no tag
    ['before a highlight\'s ==, as it is', '<w:highlight w:val="yellow"/>', '<A +', '[==<A +==](https://e.com)'],
    ['with no attribute, as it is', '', '<span ', '[<span ](https://e.com)'],
  ])('writes the < of a tag left open in a link\'s text %s', async (_name, rPr, text, expected) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const replaced = xml.replace('<w:r><w:t>ab</w:t></w:r>', '<w:r><w:rPr>' + rPr + '</w:rPr><w:t xml:space="preserve">'
      + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</w:t></w:r>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe(expected + '\n');
  });

  test('keeps the spans of two deleted links apart where a tag one leaves open could close in the other', async () => {
    // A span of both, joined as their first runs could, read the tag across them as HTML
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    let id = 90;
    const deleted = (text: string, bold = false) => '<w:del w:id="' + (id++) + '" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r>'
      + (bold ? '<w:rPr><w:b/></w:rPr>' : '') + '<w:delText xml:space="preserve">' + text + '</w:delText></w:r></w:del>';
    const replaced = xml.replace(/<w:hyperlink ([^>]*)><w:r><w:t>ab<\/w:t><\/w:r><\/w:hyperlink>/, (_m, attrs: string) =>
      '<w:hyperlink ' + attrs + '>' + deleted('a', true) + deleted('&lt;span a="') + '</w:hyperlink>' + deleted(' ')
      + '<w:hyperlink ' + attrs + '>' + deleted('b', true) + deleted('"&gt;') + '</w:hyperlink>');
    expect(replaced).not.toBe(xml);
    zip.file('word/document.xml', replaced);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe('{--[**a**\\<span a="](https://e.com) --}{--[**b**">](https://e.com)--}\n');
    expect(await roundTrip(md.slice(0, -1))).toBe(md);
  });

  test.each([
    ['near its end', (k: number) => k === 31997 ? '<span a="' : 'a'],
    ['in every other run', (k: number) => k % 2 === 0 ? '<span a="' : 'x'],
  ])('writes a link of many runs with a tag left open %s in linear time', (_name, text) => {
    // The link was read to its end and taken apart at the tag, and read
    // again from each run after
    const items: ContentItem[] = Array.from({ length: 32000 }, (_, k) => ({ type: 'text', text: text(k),
      href: 'https://e.com', link: 1, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, bold: k % 2 === 0 } }));
    const start = performance.now();
    buildMarkdown(items, new Map());
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test.each([
    ['links to one place', (k: number): Partial<ContentItem> => ({ href: 'https://e.com', link: k + 1, formatting: DEFAULT_FORMATTING })],
    ['runs of other formatting by turns', (k: number): Partial<ContentItem> => ({ formatting: { ...DEFAULT_FORMATTING, bold: k % 2 === 0 } })],
  ])('writes a deletion of many %s in linear time', (_name, fields) => {
    // Each run tried a substitution from it, and each link read past it for
    // one, each through the rest of the deletion
    const items = Array.from({ length: 32000 }, (_, k) => ({ type: 'text', text: 'a', commentIds: new Set(),
      revision: { type: 'deletion', author: 'A', date: '2024-01-01T00:00:00Z' }, ...fields(k) }) as ContentItem);
    const start = performance.now();
    buildMarkdown(items, new Map());
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('keeps a link whose text starts with an inserted # a link, not a heading', async () => {
    // Export read the link's first run, {++# ++}, as an inserted heading's
    const md = '[{++# 123++}{++ (fixed)++}](https://e.com)';
    const { docx } = await convertMdToDocx(md);
    expect(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).not.toContain('Heading1');
    expect((await convertDocx(docx)).markdown).toBe('{++[# 123 (fixed)](https://e.com)++}\n');
  });

  test.each([
    ['deleted runs', (k: number): ContentItem[] => [{ type: 'text', text: 'a', href: 'https://e.com', link: 1, commentIds: new Set(),
      formatting: { ...DEFAULT_FORMATTING, bold: k % 2 === 0 }, revision: { type: 'deletion', author: 'A', date: '2024-01-01T00:00:00Z' } }]],
    ['substitutions', (_k: number): ContentItem[] => [
      { type: 'text', text: 'a', href: 'https://e.com', link: 1, commentIds: new Set(), formatting: DEFAULT_FORMATTING,
        revision: { type: 'deletion', author: 'A', date: '2024-01-01T00:00:00Z' } },
      { type: 'text', text: 'b', href: 'https://e.com', link: 1, commentIds: new Set(), formatting: DEFAULT_FORMATTING,
        revision: { type: 'addition', author: 'A', date: '2024-01-01T00:00:00Z' } },
      { type: 'text', text: ' ', href: 'https://e.com', link: 1, commentIds: new Set(), formatting: DEFAULT_FORMATTING }]],
  ])('writes a link of many %s in linear time', (_name, runs) => {
    // Each deleted run rendered the rest of its deletion, and each side of
    // a substitution read the paragraph's runs up to its end
    const items: ContentItem[] = [
      { type: 'text', text: 'x ', href: 'https://e.com', link: 1, commentIds: new Set(), formatting: DEFAULT_FORMATTING },
      ...Array.from({ length: 4000 }, (_, k) => runs(k)).flat()];
    const start = performance.now();
    buildMarkdown(items, new Map());
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('merges the runs of a link in linear time', () => {
    // Each merge read whether the text so far ended with a line break,
    // which flattened it
    const items: ContentItem[] = Array.from({ length: 48000 }, () => (
      { type: 'text', text: 'a'.repeat(100), href: 'https://e.com', link: 1, commentIds: new Set(), formatting: DEFAULT_FORMATTING }));
    const start = performance.now();
    buildMarkdown(items, new Map());
    expect(performance.now() - start).toBeLessThan(3000);
  });

  test('keeps a soft line break in a link in the link', async () => {
    expect(await roundTrip('[link\ntext](https://e.com)')).toBe('[link text](https://e.com)\n');
  });

  test.each([
    ['to different places', '[a **b**](https://e.com)[c](https://f.com)'],
    ['to one place', '[a](https://e.com)[b](https://e.com)'],
    ['to one place, with formatting', '[**a**](https://e.com)[*b*](https://e.com)'],
    ['to one place, in a comment', '{==[a](https://e.com)[b](https://e.com)==}{>>note<<}'],
    ['to one place, with formatting, in a comment', '{==[**a**](https://e.com)[*b*](https://e.com)==}{>>note<<}'],
  ])('keeps links %s apart', async (_name, md) => {
    // Import joined runs of one place across the hyperlinks they were in
    expect(await roundTrip(md)).toBe(md + '\n');
  });

  test.each([
    ['code', '`ab`', '`a`\\\n`b`\n'],
    ['code in a link', '[`ab`](https://e.com)', '[`a`\\\n`b`](https://e.com)\n'],
  ])('keeps a line break in %s', async (_name, md, expected) => {
    // A code span took the break in, and read it as a space
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const broken = xml.replace('<w:t>ab</w:t>', '<w:t>a</w:t><w:br/><w:t>b</w:t>');
    expect(broken).not.toBe(xml);
    zip.file('word/document.xml', broken);
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe(expected);
  });

  test.each([
    ['a heading', '<w:t>a</w:t><w:br/><w:t># x</w:t>', '[a\\\n](https://e.com)[# x](https://e.com)\n'],
    ['a list item', '<w:t>a</w:t><w:br/><w:t>b</w:t><w:br/><w:t>- c</w:t>', '[a\\\nb\\\n](https://e.com)[- c](https://e.com)\n'],
    ['an ordered list item', '<w:t>a</w:t><w:br/><w:t>1. x</w:t>', '[a\\\n](https://e.com)[1. x](https://e.com)\n'],
    ['a heading, in formatting', '<w:t>a</w:t><w:br/><w:t>#</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t> x</w:t>',
      '[a\\\n](https://e.com)[# *x*](https://e.com)\n'],
    ['text', '<w:t>a</w:t><w:br/><w:t>#x</w:t>', '[a\\\n#x](https://e.com)\n'],
    ['nothing', '<w:t>a</w:t><w:br/>', '[a\\\n](https://e.com)\n'],
    ['a LaTeX environment, after a bold break', '<w:t>a</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:br/></w:r><w:r><w:t>\\begin{align}x\\end{align}</w:t>',
      '[a\\\n](https://e.com)[\\begin{align}x\\end{align}](https://e.com)\n'],
    ['a heading, after a break that starts the link', '<w:br/><w:t># x</w:t>', '[\\\n](https://e.com)[# x](https://e.com)\n'],
  ])('splits a link after the line break before a line that would start %s', async (_name, runs, expected) => {
    // One link's text ran across the line, which Markdown read as a block,
    // and the break before it went between the links, out of the hyperlink
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const broken = xml.replace('<w:t>ab</w:t>', runs);
    expect(broken).not.toBe(xml);
    zip.file('word/document.xml', broken);
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe(expected);
    const docx = (await convertMdToDocx(md.slice(0, -1))).docx;
    expect(await breaksOutsideLinks(docx)).toBe(0);
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  describe('A line break in a link of its own', () => {
    test.each([
      ['that is all of the link', text('x') + link(lineBreak) + text('y'), 'x[\\\n](https://e.com)y\n'],
      ['at the link\'s end, after a comment\'s range over the rest',
        text('x ') + link(start(0) + text('a') + end(0) + lineBreak) + reference(0) + text('y'),
        'x {==[a](https://e.com)==}{>>note<<}[\\\n](https://e.com)y\n'],
      ['at the link\'s start, before a comment\'s range over the rest',
        text('x') + link(lineBreak + start(0) + text('a')) + end(0) + reference(0) + text(' y'),
        'x[\\\n](https://e.com){==[a](https://e.com)==}{>>note<<} y\n'],
      ['at the link\'s end, after a comment\'s range in another\'s',
        text('x ') + start(1) + link(start(0) + text('a') + end(0) + lineBreak) + reference(0) + end(1) + reference(1) + text('y'),
        'x {#2}{#1}[a](https://e.com){/2}[\\\n](https://e.com){/1}y\n{#1>>other<<}\n{#2>>note<<}\n'],
      ['inserted, at the link\'s end, after a comment\'s range over the rest',
        text('x ') + link(inserted(start(0) + text('a') + end(0) + lineBreak)) + reference(0) + text('y'),
        'x {=={++[a](https://e.com)++}==}{>>note<<}{++[\\\n](https://e.com)++}y\n'],
    ])('keeps a line break %s in the hyperlink', async (_name, runs, expected) => {
      // A break alone of a link's runs was written as a break, out of the link
      const md = (await convertDocx(await wordWithLinks('<w:p>' + runs + '</w:p>'))).markdown;
      expect(md).toBe(expected);
      const docx = (await convertMdToDocx(md)).docx;
      expect(await breaksOutsideLinks(docx)).toBe(0);
      expect((await convertDocx(docx)).markdown).toBe(md);
    });
  });

  describe('A line break in a link that Word shows formatting on', () => {
    const formattedBreak = (rPr: string) => '<w:r><w:rPr>' + rPr + '</w:rPr><w:br/></w:r>';
    const underlined = formattedBreak('<w:u w:val="single"/>');
    const highlighted = formattedBreak('<w:highlight w:val="yellow"/>');
    const struckBreak = formattedBreak('<w:strike/>');
    // The formatting of each line break of a document's body
    const breakFormatting = async (docx: Uint8Array) => {
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      return [...xml.matchAll(/<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?<w:br\/><\/w:r>/g)].map(([, rPr]) =>
        [...(rPr ?? '').matchAll(/<w:(u|highlight|strike)\b/g)].map(match => match[1]).join(','));
    };

    test.each([
      ['underlined, between text', text('x ') + link(text('a') + underlined + text('b')) + text(' y'), 'x [a<u>\\\n</u>b](https://e.com) y\n', 'u'],
      ['highlighted, at the link\'s end', text('x ') + link(text('a') + highlighted) + text('y'), 'x [a==\\\n==](https://e.com)y\n', 'highlight'],
      ['underlined, at the link\'s start', text('x') + link(underlined + text('a')) + text(' y'), 'x[<u>\\\n</u>a](https://e.com) y\n', 'u'],
      ['struck, between text', text('x ') + link(text('a') + struckBreak + text('b')) + text(' y'), 'x [a<s>\\\n</s>b](https://e.com) y\n', 'strike'],
      ['struck, at the link\'s end', text('x ') + link(text('a') + struckBreak) + text('y'), 'x [a<s>\\\n</s>](https://e.com)y\n', 'strike'],
      // Whose == the link's ](url) keeps from a line alone, which would
      // read as a heading's underline, so it needs no <br>
      ['highlighted, at the end of a link that ends the paragraph', text('x ') + link(text('a') + highlighted), 'x [a==\\\n==](https://e.com)\n', 'highlight'],
    ])('keeps a line break in a link in its formatting and the hyperlink, %s', async (_name, runs, expected, formatting) => {
      // The break lost its formatting in the link, though not outside one
      const word = await wordWithLinks('<w:p>' + runs + '</w:p>');
      const md = (await convertDocx(word)).markdown;
      expect(md).toBe(expected);
      const docx = (await convertMdToDocx(md)).docx;
      expect(await hyperlinksOf(docx)).toEqual(await hyperlinksOf(word));
      expect(await breakFormatting(docx)).toEqual([formatting]);
      expect((await convertDocx(docx)).markdown).toBe(md);
    });

    test('keeps an underlined line break before a line that would start a heading in its formatting, at the end of the link the line splits', async () => {
      const word = await wordWithLinks('<w:p>' + text('x ') + link(text('a') + underlined + text('# b')) + text(' y') + '</w:p>');
      const md = (await convertDocx(word)).markdown;
      expect(md).toBe('x [a<u>\\\n</u>](https://e.com)[# b](https://e.com) y\n');
      const docx = (await convertMdToDocx(md)).docx;
      expect(await hyperlinksOf(docx)).toEqual(['https://e.com a⏎', 'https://e.com # b']);
      expect(await breakFormatting(docx)).toEqual(['u']);
      expect((await convertDocx(docx)).markdown).toBe(md);
    });
  });

  test.each([
    ['a deletion at its end, and the insertion after it', link(text('a ') + deleted(text('b'))) + inserted(text('c')),
      'x [a {--b--}](https://e.com){++c++} y\n'],
    ['a substitution at its end, and more of the insertion after it', link(text('a ') + deleted(text('b')) + inserted(text('c'))) + inserted(text(' d')),
      'x [a {~~b~>c~~}](https://e.com){++ d++} y\n'],
    ['a substitution of all of it, and more of the insertion after it', link(deleted(text('a')) + inserted(text('b'))) + inserted(text(' c')),
      'x [{~~a~>b~~}](https://e.com){++ c++} y\n'],
    ['a deletion at its end, more of it after it, and the insertion', link(text('a ') + deleted(text('b'))) + deleted(text(' z')) + inserted(text('c')),
      'x [a {--b--}](https://e.com){-- z--}{++c++} y\n'],
    ['a deletion at its end, and the insertion in a link to one place after it', link(text('a ') + deleted(text('b'))) + link(inserted(text('c'))),
      'x [a {--b--}](https://e.com){++[c](https://e.com)++} y\n'],
    ['a substitution and a deletion at its end, and the insertion after it', link(text('a ') + deleted(text('b')) + inserted(text('c')) + deleted(text('d'))) + inserted(text('e')),
      'x [a {~~b~>c~~}{--d--}](https://e.com){++e++} y\n'],
  ])('keeps a link with %s one hyperlink', async (_name, runs, expected) => {
    // The changed runs at the link's end went to a substitution with the
    // insertion after the link, in a link of their own, as a hyperlink of
    // their own
    const word = await wordWithLinks('<w:p>' + text('x ') + runs + text(' y') + '</w:p>');
    const md = (await convertDocx(word)).markdown;
    expect(md).toBe(expected);
    const docx = (await convertMdToDocx(md)).docx;
    expect(await hyperlinksOf(docx)).toEqual(await hyperlinksOf(word));
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  const code = (t: string) => '<w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:t xml:space="preserve">' + t + '</w:t></w:r>';
  const italic = (t: string) => '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">' + t + '</w:t></w:r>';
  const struck = (t: string) => '<w:r><w:rPr><w:strike/></w:rPr><w:t xml:space="preserve">' + t + '</w:t></w:r>';
  test.each([
    ['a deletion of all of it before an insertion', text('x ') + link(deleted(code('a --} b') + italic('~&gt;'))) + inserted(text('c')),
      'x [{~~`a --} b`~>~~}{--*~>*--}](https://e.com){++c++} y\n'],
    ['a deletion of all of it', text('x ') + link(deleted(code('a --} b') + italic('~&gt;'))),
      'x [{~~`a --} b`~>~~}{--*~>*--}](https://e.com) y\n'],
    ['a deletion of all of it ending in code that ends in the closer, before an insertion', text('x ') + link(deleted(italic('~&gt;') + code('a --}'))) + inserted(text('c')),
      'x [{--*~>*--}{~~`a --}`~>~~}](https://e.com){++c++} y\n'],
    ['a deletion of all of it with a ~~} in code, before an insertion', text('x ') + link(deleted(code('a --} b') + text(' ') + code('~~}'))) + inserted(text('c')),
      'x [{~~`a --} b`~>~~}{-- `~~}`--}](https://e.com){++c++} y\n'],
    ['an insertion of all of it with a ~~} in code', text('x ') + link(inserted(code('a ++} b') + text(' ') + code('~~}'))),
      'x [{~~~>`a ++} b`~~}{++ `~~}`++}](https://e.com) y\n'],
    ['a deletion of all of it, after a !', text('x !') + link(deleted(code('a --} b') + italic('~&gt;'))),
      'x \\![{~~`a --} b`~>~~}{--*~>*--}](https://e.com) y\n'],
    // Whose ~~ the marks of emphasis kept from the } or > after them, as
    // a substitution's side is written once they resolve
    ['a struck } before code, in a deletion of all of it before an insertion', text('x ') + link(deleted(struck('}') + code('a --}'))) + inserted(text('c')),
      'x [{--~~}~~--}{~~`a --}`~>~~}](https://e.com){++c++} y\n'],
    ['a struck > before code, in a deletion of all of it', text('x ') + link(deleted(struck('&gt;a') + code('a --}'))),
      'x [{--~~>a~~--}{~~`a --}`~>~~}](https://e.com) y\n'],
    ['a struck } before code, in an insertion of all of it', text('x ') + link(inserted(struck('}') + code('a ++}'))),
      'x [{++~~}~~++}{~~~>`a ++}`~~}](https://e.com) y\n'],
  ])('puts the change of a link with %s in spans of its runs inside the link, where no span around it holds the closer in its code', async (_name, runs, expected) => {
    // The span around the link ended at the closer in its code, and export
    // wrote the rest of the link as text, which lost the code and the link.
    // Before an insertion, the link's runs went in links of their own.
    const word = await wordWithLinks('<w:p>' + runs + text(' y') + '</w:p>');
    const md = (await convertDocx(word)).markdown;
    expect(md).toBe(expected);
    const docx = (await convertMdToDocx(md)).docx;
    // Each run in a change of its own
    const joined = async (docx: Uint8Array) => (await hyperlinksOf(docx)).map(link => link.replace(/-\}\{-|\+\}\{\+/g, ''));
    expect(await joined(docx)).toEqual(await joined(word));
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  test('keeps a deletion of all of a link with the closer in its code around it, where the ~> of its marked emphasis is a tag\'s', async () => {
    // The ~~ of the struck .b's marks, which resolve as <s>, before the >
    // read as a ~> that the substitution around the link couldn't hold
    const word = await wordWithLinks('<w:p>' + text('x ') + link(deleted(text('x') + struck('.b') + text('&gt;') + code('a --}'))) + text(' y') + '</w:p>');
    const md = (await convertDocx(word)).markdown;
    expect(md).toBe('x {~~[x<s>.b</s>>`a --}`](https://e.com)~>~~} y\n');
    const docx = (await convertMdToDocx(md)).docx;
    expect(await hyperlinksOf(docx)).toEqual(await hyperlinksOf(word));
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  test.each([
    ['a deletion of all of it', text('x ') + link(deleted(code('a --} ~&gt; b'))),
      'x [{--`a -`--}{--`-} ~> b`--}](https://e.com) y\n'],
    ['an insertion of all of it', text('x ') + link(inserted(code('a ++} ~~} b'))),
      'x [{++`a +`++}{++`+} ~~} b`++}](https://e.com) y\n'],
    ['the closer at its end, in a deletion of all of it', text('x ') + link(deleted(code('~&gt; a --}'))),
      'x [{--`~> a -`--}{--`-}`--}](https://e.com) y\n'],
    ['more of the link after it, in a deletion of all of it before an insertion', text('x ') + link(deleted(code('a --} ~&gt; b') + italic('q'))) + inserted(text('c')),
      'x [{--`a -`--}{--`-} ~> b`--}{--*q*--}](https://e.com){++c++} y\n'],
    ['part of the link before it, in a deletion of the rest', text('x ') + link(text('p ') + deleted(code('a --} ~&gt; b'))),
      'x [p {--`a -`--}{--`-} ~> b`--}](https://e.com) y\n'],
    ['a deletion before it, in an insertion of all of it', text('x ') + deleted(text('z')) + link(inserted(code('a ++} ~~} b'))),
      'x {--z--}[{++`a +`++}{++`+} ~~} b`++}](https://e.com) y\n'],
  ])('splits code with a change\'s closer and a ~> or ~~} in a link into pieces in spans inside the link, with %s', async (_name, runs, expected) => {
    // A span around the link ended at the closer in its code, and export
    // wrote the rest of the link as text
    const word = await wordWithLinks('<w:p>' + runs + text(' y') + '</w:p>');
    const md = (await convertDocx(word)).markdown;
    expect(md).toBe(expected);
    const docx = (await convertMdToDocx(md)).docx;
    // The code's pieces in runs of their own
    const joined = async (docx: Uint8Array) => (await hyperlinksOf(docx)).map(link => link.replace(/-\}\{-|\+\}\{\+/g, ''));
    expect(await joined(docx)).toEqual(await joined(word));
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  test('keeps a deletion of all of a link around it where a line break in code ends it before a line that would start a block', async () => {
    // The code and the break, which stays apart from the line after it,
    // read as pieces of code, in spans of their own, which the next trip
    // didn't keep
    const codeBreak = '<w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:br/></w:r>';
    const word = await wordWithLinks('<w:p>' + text('x ') + link(deleted(code('a') + codeBreak + text('# b'))) + text(' y') + '</w:p>');
    const md = (await convertDocx(word)).markdown;
    expect(md).toBe('x {--[`a`\\\n](https://e.com)[# b](https://e.com)--} y\n');
    expect((await convertDocx((await convertMdToDocx(md)).docx)).markdown).toBe(md);
  });

  test('writes many pieces of deleted code in a link before an insertion in it in linear time', () => {
    // Each start in the pieces built the substitution's sides again. Twice
    // the pieces take about twice as long, not four times.
    const time = (n: number) => {
      const item = (text: string, type: 'addition' | 'deletion', code: boolean) => ({
        type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, code }, href: 'https://e.com', link: 1,
        revision: { type, author: 'A', date: '' },
      });
      const items = [item('a --} ~> '.repeat(n), 'deletion', true), item('c', 'addition', false)] as ContentItem[];
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const start = performance.now();
        expect(buildMarkdown(items, new Map())).toEndWith('{--`-} ~> `--}{++c++}](https://e.com)');
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const small = time(2000);
    expect(time(4000) / small).toBeLessThan(3);
  });

  test('tries a substitution in a link from later deletions of many runs with a ~> in linear time', () => {
    // Each start past a run with a ~ built the deletions' side again,
    // though a ~> later in it kept each from holding. Twice the runs take
    // about twice as long, not four times.
    const time = (n: number) => {
      const item = (text: string, type: 'addition' | 'deletion', formatting: Partial<RunFormatting>) => ({
        type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, href: 'https://e.com', link: 1,
        revision: { type, author: 'A', date: '' },
      });
      const items = [
        ...Array.from({ length: n }, () => [item('~>', 'deletion', { italic: true }), item('x', 'deletion', { bold: true })]).flat(),
        item('c', 'addition', {}),
      ] as ContentItem[];
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const start = performance.now();
        expect(buildMarkdown(items, new Map())).toEndWith('{--*~>*--}{~~**x**~>c~~}](https://e.com)');
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const small = time(500);
    expect(time(1000) / small).toBeLessThan(3);
  });

  test('keeps a link whole before a line that would start a note, whose [ is escaped', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('[ab](https://e.com)')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('<w:t>ab</w:t>', '<w:t>a</w:t><w:br/><w:t>[^1]: x</w:t>'));
    const md = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(md).toBe('[a\\\n\\[^1\\]: x](https://e.com)\n');
    expect(await roundTrip(md.slice(0, -1))).toBe(md);
  });

  test('reads a Word hyperlink of several runs and a line break as one link', async () => {
    const xml = '<?xml version="1.0"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'
      + '<w:p><w:hyperlink r:id="rId1"><w:r><w:t xml:space="preserve">a </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:hyperlink></w:p>'
      + '</w:body></w:document>';
    const rels = '<?xml version="1.0"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://e.com" TargetMode="External"/>'
      + '</Relationships>';
    const result = await convertDocx(await buildSyntheticDocx(xml, { 'word/_rels/document.xml.rels': rels }));
    expect(result.markdown).toBe('[a *b\\\nc*](https://e.com)\n');
  });
});

describe('Formatting Word shows on whitespace', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, '');
  const HL = '<w:highlight w:val="yellow"/>', U = '<w:u w:val="single"/>', S = '<w:strike/>';
  /** A run of `content`, where ^ is a line break, | a tab and the rest text */
  const run = (content: string, rPr = '') => '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '')
    + content.split(/([\^|])/).filter(Boolean).map(c => c === '^' ? '<w:br/>' : c === '|' ? '<w:tab/>' : '<w:t xml:space="preserve">' + c + '</w:t>').join('') + '</w:r>';
  const revision = (tag: 'ins' | 'del', runs: string) => '<w:' + tag + ' w:id="90" w:author="A" w:date="2024-01-01T00:00:00Z">'
    + (tag === 'del' ? runs.replace(/<(\/?)w:t\b/g, '<$1w:delText') : runs) + '</w:' + tag + '>';
  /** The document export makes of `md`, with its run of XX as `runs` */
  const withRuns = async (runs: string, md = 'XX') => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>XX<\/w:t><\/w:r>/s, runs);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    return zip.generateAsync({ type: 'uint8array' });
  };
  /** The body's text, a line break as ⏎ and a tab as →, in pieces of the
   *  formatting Word shows on them, and its tracked changes */
  const shown = async (docx: Uint8Array) => {
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const body = xml.slice(xml.indexOf('<w:body>'), xml.lastIndexOf('<w:sectPr'));
    const pieces: string[] = [];
    for (const [, tag, inner] of body.matchAll(/<(\/?w:(?:ins|del|p))\b[^>]*>|<w:r>([\s\S]*?)<\/w:r>/g)) {
      if (tag) { pieces.push('<' + tag.replace('w:', '') + '>'); continue; }
      const format = (inner.match(/<w:(?:u|strike|highlight|rStyle)\b[^>]*>/g) ?? []).filter(p => !p.includes('CommentReference')).join('');
      const text = inner.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '').replace(/<w:br\/>/g, '⏎').replace(/<w:tab\/>/g, '→').replace(/<[^>]+>/g, '');
      const last = pieces.length - 1;
      if (pieces[last]?.startsWith(format + '|')) pieces[last] += text;
      else if (text) pieces.push(format + '|' + text);
    }
    return pieces;
  };
  /** Word's runs to Markdown and back, which holds what Word showed */
  const roundTrip = async (runs: string, md: string, template = 'XX') => {
    const docx = await withRuns(runs, template);
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(md + '\n');
    const again = (await convertMdToDocx(markdown)).docx;
    expect(await shown(again)).toEqual(await shown(docx));
    expect(strip((await convertDocx(again)).markdown)).toBe(markdown);
  };

  test.each([
    ['underlined, alone', run('x') + run('^', U) + run('y'), 'x<u>\\\n</u>y'],
    ['underlined, alone at the paragraph\'s end', run('x') + run('^', U), 'x<u>\\\n</u>'],
    ['struck, at a run\'s end', run('x') + run('a^', S) + run('y'), 'x<s>a\\\n</s>y'],
    ['struck, at a run\'s start', run('x') + run('^a', S) + run('y'), 'x<s>\\\na</s>y'],
    ['struck, alone', run('x') + run('^', S) + run('y'), 'x<s>\\\n</s>y'],
    ['struck, at the paragraph\'s end', run('x') + run('a^', S), 'x<s>a\\\n</s>'],
    ['highlighted, at a run\'s end', run('x') + run('a^', HL) + run('y'), 'x==a\\\n==y'],
    ['highlighted, at a run\'s start', run('x') + run('^a', HL) + run('y'), 'x==\\\na==y'],
    ['highlighted, alone', run('x') + run('^', HL) + run('y'), 'x==\\\n==y'],
    ['highlighted red, alone', run('x') + run('^', '<w:highlight w:val="red"/>') + run('y'), 'x==\\\n=={red}y'],
    ['highlighted, at the paragraph\'s start', run('^a', HL) + run('y'), '==\\\na==y'],
    ['highlighted, in bold', run('x') + run('a^', '<w:b/>' + HL) + run('y'), 'x<b>==a\\\n==</b>y'],
    ['highlighted, between highlighted runs of other formatting', run('x ') + run('a', '<w:b/>' + HL) + run('^', HL) + run('c', '<w:i/>' + HL) + run(' y'), 'x ==**a**\\\n*c*== y'],
    // Where == alone on the last line would read as a heading's underline
    ['highlighted, at the paragraph\'s end', run('x') + run('a^', HL), 'x==a<br>=='],
    ['highlighted, alone at the paragraph\'s end', run('x') + run('^', HL), 'x==<br>=='],
    ['highlighted, in a tracked insertion', run('x') + revision('ins', run('a^', HL)) + run('y'), 'x{++==a\\\n==++}y'],
    ['highlighted, in a tracked deletion', run('x') + revision('del', run('a^', HL)) + run('y'), 'x{--==a\\\n==--}y'],
    ['struck, alone in a tracked insertion', run('x') + revision('ins', run('^', S)) + run('y'), 'x{++<s>\\\n</s>++}y'],
  ])('keeps the formatting of a line break %s', async (_name, runs, md) => {
    // The break went outside the formatting, where Word showed it on it
    await roundTrip(runs, md);
  });

  const CODE = '<w:rStyle w:val="CodeChar"/>';
  test.each([
    ['highlighted code', run('x') + run('a^b', CODE + HL) + run('y'), 'x==`a`\\\n`b`==y', HL],
    ['highlighted code, at its end', run('x') + run('a^', CODE + HL) + run('y'), 'x==`a`\\\n==y', HL],
    ['highlighted code, alone', run('x') + run('^', CODE + HL) + run('y'), 'x==\\\n==y', HL],
    ['highlighted code, at the paragraph\'s end', run('x') + run('a^', CODE + HL), 'x==`a`<br>==', HL],
    ['underlined code', run('x') + run('a^b', CODE + U) + run('y'), 'x<u>`a`\\\n`b`</u>y', U],
    ['struck code, at its start', run('x') + run('^a', CODE + S) + run('y'), 'x<s>\\\n`a`</s>y', S],
    ['highlighted code, in a tracked deletion', run('x') + revision('del', run('a^b', CODE + HL)) + run('y'), 'x{--==`a`\\\n`b`==--}y', HL],
    // In the highlight of the spans an == splits the code into
    ['highlighted code with an == in it', run('x') + run('a^x ==y', CODE + HL) + run('z'), 'x==`a`\\\n`x =`=={yellow}==`=y`=={yellow}z', HL],
    ['underlined, highlighted code with an == in it, at its end', run('x') + run('x ==y^', CODE + U + HL) + run('z'), 'x<u>==`x =`=={yellow}==`=y`\\\n=={yellow}</u>z', HL + U],
  ])('keeps the formatting of a line break in %s', async (_name, runs, md, rPr) => {
    // The break went between spans of the code in their formatting each,
    // which left it out, as ==`a`==\\\n==`b`==. Markdown can't hold code's
    // style on it.
    const docx = await withRuns(runs);
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(md + '\n');
    const again = (await convertMdToDocx(markdown)).docx;
    const xml = await (await JSZip.loadAsync(again)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:r><w:rPr>' + rPr + '</w:rPr><w:br/></w:r>');
    // Export writes the break in a run of its own, without code's style,
    // which reads back as the code's
    expect(strip((await convertDocx(again)).markdown)).toBe(markdown);
  });

  const item = (text: string, formatting: Partial<RunFormatting> = {}, revision?: RevisionInfo) =>
    ({ type: 'text', text, commentIds: new Set(), formatting: { ...DEFAULT_FORMATTING, ...formatting }, ...(revision ? { revision } : {}) }) as ContentItem;
  const citation = (revision?: RevisionInfo) =>
    ({ type: 'citation', text: '(Doe 2020)', pandocKeys: ['@doe2020'], commentIds: new Set(), ...(revision ? { revision } : {}) }) as ContentItem;
  const inserted: RevisionInfo = { type: 'addition', author: 'A', date: '2024-01-01T00:00:00Z' };

  test.each([
    ['code that ends in a space', [item('Seen '), item('a ', { code: true }), citation()], 'Seen `a `[@doe2020]'],
    ['code with spaces at both ends, which pad its backticks', [item('Seen '), item(' a ', { code: true }), citation()], 'Seen `  a  `[@doe2020]'],
    ['code that ends in a space after a backtick', [item('Seen '), item('a` ', { code: true }), citation()], 'Seen ``a` ``[@doe2020]'],
    ['highlighted code that ends in a space', [item('Seen '), item('a ', { code: true, highlight: true }), citation()], 'Seen ==`a `==[@doe2020]'],
    ['inserted code that ends in a space', [item('Seen '), item('a ', { code: true }, inserted), citation(inserted)], 'Seen {++`a `[@doe2020]++}'],
  ])('puts no second space before a citation after %s', (_name, items, md) => {
    // The backtick that closes the code read as the text before the
    // citation, not the space in it, which export writes
    expect(buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim()).toBe(md);
  });

  test.each([
    ['code that ends in a backtick, which pads it', [item('Seen '), item('a`', { code: true }), citation()], 'Seen `` a` `` [@doe2020]'],
    ['code that ends in a backslash', [item('Seen '), item('a\\', { code: true }), citation()], 'Seen `a\\` [@doe2020]'],
  ])('puts a space before a citation after %s', (_name, items, md) => {
    expect(buildMarkdown([{ type: 'para' }, ...items] as ContentItem[], new Map()).trim()).toBe(md);
  });

  test('reads code that ends in a space before a citation back as it is', async () => {
    // Word got a second space, between the code and the citation
    const bibtex = '@article{doe2020,\n  author = {Doe, Jane},\n  title = {Title},\n  journal = {J},\n  year = {2020}\n}\n';
    const md = 'Seen `a `[@doe2020] here.\n';
    const { docx } = await convertMdToDocx(md, { bibtex });
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).not.toContain('<w:t xml:space="preserve"> </w:t>');
    expect(strip((await convertDocx(docx)).markdown).trimStart()).toBe(md);
  });

  const B = '<w:b/>';
  const around = (change: string) => run('x ') + change + run(' y');
  test.each([
    ['at the end of bold', around(revision('ins', run('a^', B))), 'x {++**a**\\\n++} y'],
    ['after bold', around(revision('ins', run('a', B) + run('^'))), 'x {++**a**\\\n++} y'],
    ['between bold', around(revision('ins', run('a', B) + run('^') + run('b', B))), 'x {++**a**\\\n**b**++} y'],
    ['after italic, in a deletion', around(revision('del', run('a', '<w:i/>') + run('^'))), 'x {--*a*\\\n--} y'],
    ['after bold, at the paragraph\'s end', run('x ') + revision('ins', run('a', B) + run('^')), 'x {++**a**\\\n++}'],
    ['at the end of bold code', around(revision('ins', run('a^', CODE + B))), 'x {++**`a`**\\\n++} y'],
    ['after bold code', around(revision('ins', run('a', CODE + B) + run('^'))), 'x {++**`a`**\\\n++} y'],
    ['after italic code, in a deletion', around(revision('del', run('a', CODE + '<w:i/>') + run('^'))), 'x {--*`a`*\\\n--} y'],
    ['after struck code', around(revision('ins', run('a', CODE + S) + run('^'))), 'x {++~~`a`~~\\\n++} y'],
  ])('keeps a line break %s in its tracked change\'s span', async (_name, runs, md) => {
    // The span a line break started couldn't join one that ended in
    // emphasis, so the break, which export writes after bold, not in it,
    // came back in a span of its own: {++**a**++}{++\\\n++}
    const markdown = strip((await convertDocx(await withRuns(runs))).markdown);
    expect(markdown).toBe(md + '\n');
    expect(strip((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown)).toBe(markdown);
  });

  // A table with merged cells, which only HTML holds
  const TABLE = '<table>\n  <tr>\n    <td colspan="2">\n      <p>h</p>\n    </td>\n  </tr>\n  <tr>\n    <td>\n      <p>XX</p>\n    </td>\n    <td>\n      <p>z</p>\n    </td>\n  </tr>\n</table>';
  test.each([
    ['underlined, at a run\'s end', run('x') + run('a^', U) + run('b'), 'x<u>a<br></u>b'],
    ['struck, at a run\'s start', run('x') + run('^a', S) + run('b'), 'x<s><br>a</s>b'],
    ['underlined, alone', run('x') + run('^', U) + run('y'), 'x<u><br></u>y'],
    ['underlined, at the paragraph\'s end', run('x') + run('a^', U), 'x<u>a<br></u>'],
    ['underlined, twice', run('x') + run('a^^', U) + run('y'), 'x<u>a<br><br></u>y'],
    ['underlined and bold', run('x') + run('a^', U + '<w:b/>') + run('b'), 'x<b><u>a<br></u></b>b'],
    ['struck, after struck code', run('x') + run('a', CODE + S) + run('^', S) + run('b'), 'x<s><code>a</code><br></s>b'],
    // Which, unlike Markdown's, holds it
    ['in struck code', run('x') + run('a^', CODE + S) + run('b'), 'x<s><code>a<br></code></s>b'],
  ])('keeps the formatting of a line break %s in an HTML table\'s cell', async (_name, runs, html) => {
    // The break went outside the formatting, and export gave it none
    await roundTrip(runs, TABLE.replace('XX', html), TABLE);
  });

  test('writes <br> before the == of a highlight that ends the text before an equation', async () => {
    // == alone on the line before it read as a heading's underline
    const md = 'x==a<br>==\n$$\nE\n$$\n';
    expect(strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown)).toBe(md);
  });
});

describe('HTML comments between Word runs', () => {
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, '');
  const run = (text: string, rPr = '') => '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + text + '</w:t></w:r>';
  /** A comment, as export writes one: a hidden run of its text after a
   *  zero-width space */
  const comment = (text: string) => '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">​' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</w:t></w:r>';
  /** The document export makes of `md`, with its run of XX as `runs` */
  const withRuns = async (runs: string, md = 'XX') => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const edited = xml.replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>XX<\/w:t><\/w:r>/s, runs);
    expect(edited).not.toBe(xml);
    zip.file('word/document.xml', edited);
    return zip.generateAsync({ type: 'uint8array' });
  };
  /** The body as Word shows it: each run's text, but for hidden ones, with
   *  its emphasis, highlight and style, and its equations and links */
  const shown = async (docx: Uint8Array) => {
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const body = xml.slice(xml.indexOf('<w:body>'), xml.lastIndexOf('<w:sectPr'));
    return [...body.matchAll(/<m:oMath\b|<w:hyperlink\b|<w:r>([\s\S]*?)<\/w:r>/g)]
      .filter(([, inner]) => !inner?.includes('<w:vanish/>'))
      .map(([r, inner]) => inner === undefined ? r : (inner.match(/<w:(?:b|i|highlight|rStyle)\b[^>]*>/g) ?? []).join('')
        + [...inner.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(''))
      .filter(Boolean);
  };

  test.each([
    ['a $ before one with a $', run('A cost $') + comment('<!-- x$ -->') + run(' B'), 'A cost \\$<!-- x$ --> B'],
    ['a $ before one with a $, at the paragraph\'s end', run('A cost $') + comment('<!-- x$ -->'), 'A cost \\$<!-- x$ -->'],
    ['a $ before two, the second with a $', run('A $') + comment('<!-- x -->') + comment('<!-- y$ -->') + run(' B'), 'A \\$<!-- x --><!-- y$ --> B'],
    ['a $ in italic before one with a $', run('A ') + run('cost $', '<w:i/>') + comment('<!-- x$ -->') + run(' B'), 'A *cost \\$*<!-- x$ --> B'],
    ['an == before one with an ==', run('A ==a') + comment('<!-- x== -->') + run(' B'), 'A \\==a<!-- x== --> B'],
    ['a citation\'s [@ before one with a ]', run('A [@doe2020t') + comment('<!-- ] -->') + run(' B'), 'A \\[@doe2020t<!-- ] --> B'],
    ['a $ before one with a $, in a table\'s cell', run('A cost $') + comment('<!-- x$ -->') + run(' B'), '| a |\n| --- |\n| A cost \\$<!-- x$ --> B |', '| a |\n|---|\n| XX |'],
    // Which a link's text reads past, as markdown-it does its label
    ['a [ before one with a ], before ](b)', run('A [a') + comment('<!-- ] -->') + run('](b) B'), 'A \\[a<!-- ] -->](b) B'],
    ['a [ before one with a [, before ](b)', run('A [a') + comment('<!-- [ -->') + run('](b) B'), 'A \\[a<!-- [ -->](b) B'],
    ['a [ before one with ](c)', run('A [a') + comment('<!-- ](c) -->') + run(' B'), 'A [a<!-- ](c) --> B'],
  ])('keeps %s as text', async (_name, runs, md, template = 'XX') => {
    // The comment's text was left out of what the runs before it read
    // after them, so they didn't escape the $, == or [ that export pairs
    // with one in it: math, a highlight or a citation, as in $<!-- x$ -->
    const docx = await withRuns(runs, template);
    const markdown = strip((await convertDocx(docx)).markdown);
    expect(markdown).toBe(md + '\n');
    const again = (await convertMdToDocx(markdown)).docx;
    expect(await shown(again)).toEqual(await shown(docx));
    expect(strip((await convertDocx(again)).markdown)).toBe(markdown);
  });
});
