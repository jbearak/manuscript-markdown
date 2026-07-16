import { describe, expect, test } from 'bun:test';
import { extractHtmlTables } from './html-table-parser';

describe('HTML table metadata', () => {
  test('parses shared numeric attributes', () => {
    const [table] = extractHtmlTables('<table data-digits="2" data-decimal-mark="midpoint" data-digit-grouping="thin-space"><tr><td>1</td></tr></table>');
    expect(table).toMatchObject({
      digits: 2,
      decimalMark: 'midpoint',
      digitGrouping: 'thin-space',
    });
  });

  test('accepts only exact cell source kinds', () => {
    const [table] = extractHtmlTables('<table><tr><td data-mm-kind="number" data-mm-raw="12">12</td><td data-mm-kind="NUMBER">12</td><td data-mm-kind=" number ">12</td><td data-mm-kind="unknown">12</td></tr></table>');
    expect(table.rows[0].cells[0].source).toMatchObject({ kind: 'number', rawValue: 12 });
    expect(table.rows[0].cells[1].source).toBeUndefined();
    expect(table.rows[0].cells[2].source).toBeUndefined();
    expect(table.rows[0].cells[3].source).toBeUndefined();
  });
});
