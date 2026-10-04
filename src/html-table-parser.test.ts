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

describe('HTML table cell paragraphs', () => {
  const runs = (cell: string) => extractHtmlTables('<table><tr><td>' + cell + '</td></tr></table>')[0].rows[0].cells[0].runs;

  test('separates a cell\'s paragraphs with a paragraph run, apart from its line breaks', () => {
    // Each </p> was one break, and the whitespace between paragraphs a space
    expect(runs('\n  <p>a</p>\n  <p> b<br><br>c</p>\n')).toEqual([
      { type: 'text', text: 'a' },
      { type: 'paragraph', text: '\n\n' },
      { type: 'text', text: 'b' },
      { type: 'softbreak', text: '\n' },
      { type: 'softbreak', text: '\n' },
      { type: 'text', text: 'c' },
    ]);
  });

  test('keeps an empty paragraph', () => {
    // A paragraph run only separated paragraphs with text
    const paragraph = { type: 'paragraph', text: '\n\n' };
    expect(runs('<p></p>\n<p>a</p><p> </p><p>b</p><p></p>')).toEqual([
      paragraph, { type: 'text', text: 'a' }, paragraph, paragraph, { type: 'text', text: 'b' }, paragraph,
    ]);
    expect(runs('a<p>b</p>c')).toEqual([
      { type: 'text', text: 'a' }, paragraph, { type: 'text', text: 'b' }, paragraph, { type: 'text', text: 'c' },
    ]);
  });

  test('keeps a line break at the end of a paragraph, but not of a cell', () => {
    expect(runs('<p>a<br></p>')).toEqual([{ type: 'text', text: 'a' }, { type: 'softbreak', text: '\n' }]);
    expect(runs('a<br>')).toEqual([{ type: 'text', text: 'a' }]);
  });

  test('reads a link whose target has the other quote in it', () => {
    expect(runs('<a href="https://e.com/O\'Brien">o</a>')).toEqual([{ type: 'text', text: 'o', href: 'https://e.com/O\'Brien' }]);
  });

  test('keeps a line break in a paragraph, and the formatting around it', () => {
    expect(runs('<p><b>a<br>b</b></p>')).toEqual([
      { type: 'text', text: 'a', bold: true },
      { type: 'softbreak', text: '\n' },
      { type: 'text', text: 'b', bold: true },
    ]);
  });

  test('keeps whitespace written as references, which HTML neither collapses nor trims', () => {
    expect(runs('<p>&#9;a &#32;b&nbsp;</p>')).toEqual([{ type: 'text', text: '\ta  b ' }]);
  });
});

describe('HTML table cell alignment', () => {
  test.each([
    ['an align attribute', '<td align="center">a</td>', 'center'],
    ['a text-align style', '<td style="color: red; text-align: right">a</td>', 'right'],
    ['markdown-it\'s style', '<th style="text-align:left">a</th>', 'left'],
    ['a text-align style over an align attribute', '<td align="left" style="text-align:right">a</td>', 'right'],
    ['an !important text-align style', '<td align="left" style="text-align:right!important">a</td>', 'right'],
    ['an !important text-align style over a later one', '<td style="text-align: right !important; text-align: left">a</td>', 'right'],
    ['the last text-align style', '<td style="text-align: left; text-align: center">a</td>', 'center'],
    ['a text-align style Word has no alignment for, over an align attribute', '<td align="left" style="text-align: justify">a</td>', undefined],
    ['neither', '<td>a</td>', undefined],
    ['no alignment from data-align or data-style', '<td data-align="center" data-style="text-align: right">a</td>', undefined],
    ['no alignment from another attribute\'s value', '<td title=\'x align="center"\'>a</td>', undefined],
  ])('reads %s', (_name, cell, align) => {
    const [table] = extractHtmlTables('<table><tr>' + cell + '</tr></table>');
    expect(table.rows[0].cells[0].align).toBe(align);
  });

  test('reads colspan and rowspan as whole attribute names', () => {
    const [table] = extractHtmlTables('<table><tr><td data-colspan="2" data-rowspan="2">a</td><td colspan="2" rowspan="3">b</td></tr></table>');
    expect(table.rows[0].cells.map(cell => [cell.colspan, cell.rowspan])).toEqual([[undefined, undefined], [2, 3]]);
  });
});

