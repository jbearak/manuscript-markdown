import { describe, it, expect } from 'bun:test';
import {
  buildEmbedPathTargetUri,
  buildOpenWorksheetCommandUri,
  findAvailableEmbedSheetRanges,
  findEmbedPathRanges,
  findEmbedSheetRanges,
} from './embed-link-provider';

describe('findEmbedPathRanges', () => {
  it('finds a bare path', () => {
    const text = '<!-- embed: data/table.csv -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('data/table.csv');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('data/table.csv');
  });

  it('finds a double-quoted path', () => {
    const text = '<!-- embed: "my data/table.csv" -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('my data/table.csv');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('my data/table.csv');
  });

  it('finds a single-quoted path', () => {
    const text = "<!-- embed: 'my data/table.csv' -->";
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('my data/table.csv');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('my data/table.csv');
  });

  it('finds path with XLSX params (only path portion)', () => {
    const text = '<!-- embed: data/results.xlsx sheet=Demographics range=A1:F20 -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('data/results.xlsx');
    expect(ranges[0].sheet).toBe('Demographics');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('data/results.xlsx');
  });

  it('carries the effective last worksheet selector for filepath navigation', () => {
    expect(findEmbedPathRanges(
      '<!-- embed: book.xlsx sheet=First sheet="Second Sheet" -->',
    )[0].sheet).toBe('Second Sheet');
    expect(findEmbedPathRanges(
      '<!-- embed: book.xlsx sheet=First sheet=2 -->',
    )[0].sheet).toBe('2');
  });

  it('finds multiple directives across lines', () => {
    const text = [
      'Some text',
      '<!-- embed: one.csv -->',
      '',
      '<!-- embed: two.tsv -->',
    ].join('\n');
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(2);
    expect(ranges[0].path).toBe('one.csv');
    expect(ranges[1].path).toBe('two.tsv');
    // Verify columns by slicing the individual lines
    const lines = text.split('\n');
    expect(lines[ranges[0].line].slice(ranges[0].startCol, ranges[0].endCol)).toBe('one.csv');
    expect(lines[ranges[1].line].slice(ranges[1].startCol, ranges[1].endCol)).toBe('two.tsv');
  });

  it('skips directives inside fenced code blocks', () => {
    const text = [
      '```',
      '<!-- embed: inside-fence.csv -->',
      '```',
      '<!-- embed: outside.csv -->',
    ].join('\n');
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('outside.csv');
  });

  it('handles indented directive', () => {
    const text = '  <!-- embed: data/table.csv -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('data/table.csv');
  });

  it('returns empty for non-embed comments', () => {
    const text = '<!-- table-font: Arial -->';
    expect(findEmbedPathRanges(text)).toEqual([]);
  });

  it('returns empty for text with no directives', () => {
    expect(findEmbedPathRanges('just some text')).toEqual([]);
    expect(findEmbedPathRanges('')).toEqual([]);
  });

  it('handles extra whitespace around embed keyword', () => {
    const text = '<!--   embed:   data/table.csv   -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('data/table.csv');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('data/table.csv');
  });

  it('handles path that is a substring of the prefix', () => {
    const text = '<!-- embed: embed/file.csv -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('embed/file.csv');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('embed/file.csv');
  });
});

describe('findEmbedSheetRanges', () => {
  it('finds an unquoted sheet value and carries the workbook path', () => {
    const text = '<!-- embed: data/results.xlsx sheet=Demographics range=A1:F20 -->';
    const ranges = findEmbedSheetRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      path: 'data/results.xlsx',
      sheetName: 'Demographics',
      line: 0,
    });
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('Demographics');
  });

  it('ranges only the text inside double-quoted sheet names', () => {
    const text = '<!-- embed: ../output/manuscript_tables.xlsx sheet="Table A1" -->';
    const ranges = findEmbedSheetRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].sheetName).toBe('Table A1');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('Table A1');
    expect(text[ranges[0].startCol - 1]).toBe('"');
    expect(text[ranges[0].endCol]).toBe('"');
  });

  it('supports single-quoted paths and sheet names', () => {
    const text = "  <!-- embed: 'tables/my workbook.xlsx' sheet='Sheet One' -->";
    const ranges = findEmbedSheetRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('tables/my workbook.xlsx');
    expect(ranges[0].sheetName).toBe('Sheet One');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('Sheet One');
  });

  it('is case-insensitive for the sheet key', () => {
    const text = '<!-- embed: book.xlsx SHEET="Summary" -->';
    expect(findEmbedSheetRanges(text)[0].sheetName).toBe('Summary');
  });

  it('skips directives without a path or sheet name', () => {
    expect(findEmbedSheetRanges('<!-- embed: -->')).toEqual([]);
    expect(findEmbedSheetRanges('<!-- embed: book.xlsx -->')).toEqual([]);
    expect(findEmbedSheetRanges('<!-- embed: book.xlsx sheet= -->')).toEqual([]);
    expect(findEmbedSheetRanges('<!-- embed: book.xlsx sheet="" -->')).toEqual([]);
  });

  it('does not link numeric 1-based sheet selectors', () => {
    expect(findEmbedSheetRanges('<!-- embed: book.xlsx sheet=2 -->')).toEqual([]);
    expect(findEmbedSheetRanges('<!-- embed: book.xlsx sheet="2" -->')).toEqual([]);
  });

  it('links each named selector as the literal worksheet reference it contains', () => {
    const named = '<!-- embed: book.xlsx sheet=First sheet="Second Sheet" -->';
    const namedRanges = findEmbedSheetRanges(named);
    expect(namedRanges.map((range) => range.sheetName)).toEqual(['First', 'Second Sheet']);
    expect(namedRanges.map((range) => named.slice(range.startCol, range.endCol)))
      .toEqual(['First', 'Second Sheet']);

    const endingNumeric = '<!-- embed: book.xlsx sheet=First sheet=2 -->';
    const numericRanges = findEmbedSheetRanges(endingNumeric);
    expect(numericRanges.map((range) => range.sheetName)).toEqual(['First']);
    expect(endingNumeric.slice(numericRanges[0].startCol, numericRanges[0].endCol))
      .toBe('First');
  });

  it('only links sheet names for XLSX embeds, case-insensitively', () => {
    expect(findEmbedSheetRanges('<!-- embed: data.csv sheet="Summary" -->')).toEqual([]);
    expect(findEmbedSheetRanges('<!-- embed: book.xls sheet="Summary" -->')).toEqual([]);
    expect(findEmbedSheetRanges('<!-- embed: BOOK.XLSX sheet="Summary" -->')).toHaveLength(1);
  });

  it('skips malformed quoted values', () => {
    expect(findEmbedSheetRanges('<!-- embed: book.xlsx sheet="Unclosed -->')).toEqual([]);
    expect(findEmbedSheetRanges("<!-- embed: book.xlsx sheet='Unclosed -->")).toEqual([]);
    expect(findEmbedSheetRanges('<!-- embed: book.xlsx sheet=part" quoted" -->')).toEqual([]);
  });

  it('skips directives in fenced and inline code', () => {
    const text = [
      '`<!-- embed: inline.xlsx sheet="Inline" -->`',
      '```md',
      '<!-- embed: fenced.xlsx sheet="Fenced" -->',
      '```',
      '<!-- embed: real.xlsx sheet="Real Sheet" -->',
    ].join('\n');
    const ranges = findEmbedSheetRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].sheetName).toBe('Real Sheet');
    expect(ranges[0].line).toBe(4);
  });
});

describe('buildOpenWorksheetCommandUri', () => {
  it('safely encodes one object argument with the public command contract', () => {
    const uri = 'file:///tmp/a%20b/book%23one.xlsx';
    const sheetName = 'A&B ? #1 / 日本語';
    const commandUri = buildOpenWorksheetCommandUri(uri, sheetName);
    const [command, query] = commandUri.split('?');

    expect(command).toBe('command:tableViewer.openWorkbookAtSheet');
    expect(JSON.parse(decodeURIComponent(query))).toEqual([{ uri, sheetName }]);
  });
});

describe('buildEmbedPathTargetUri', () => {
  const workbookUri = 'file:///tmp/book.xlsx';

  it('opens the effective named or numeric XLSX worksheet through Table Viewer', () => {
    for (const sheet of ['Second Sheet', '2']) {
      const target = buildEmbedPathTargetUri(workbookUri, 'book.xlsx', sheet, true);
      const [command, query] = target.split('?');
      expect(command).toBe('command:tableViewer.openWorkbookAtSheet');
      expect(JSON.parse(decodeURIComponent(query))).toEqual([{ uri: workbookUri, sheetName: sheet }]);
    }
  });

  it('preserves the ordinary file target without an effective supported worksheet', () => {
    expect(buildEmbedPathTargetUri(workbookUri, 'book.xlsx', undefined, true))
      .toBe(workbookUri);
    expect(buildEmbedPathTargetUri(workbookUri, 'book.xlsx', 'Summary', false))
      .toBe(workbookUri);
    expect(buildEmbedPathTargetUri('file:///tmp/data.csv', 'data.csv', 'Summary', true))
      .toBe('file:///tmp/data.csv');
  });
});

describe('findAvailableEmbedSheetRanges', () => {
  const text = '<!-- embed: book.xlsx sheet="Table A1" -->';

  it('returns sheet links when Table Viewer is available', () => {
    expect(findAvailableEmbedSheetRanges(text, true)).toHaveLength(1);
  });

  it('returns no sheet links when Table Viewer is unavailable', () => {
    expect(findAvailableEmbedSheetRanges(text, false)).toEqual([]);
  });
});
