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

  test.each([
    ['a comment', 'a <!-- c --> b', [{ type: 'text', text: 'a ' }, { type: 'html_comment', text: '<!-- c -->' }, { type: 'text', text: 'b' }]],
    ['a comment after a break', 'a<br><!-- c --> b', [{ type: 'text', text: 'a' }, { type: 'softbreak', text: '\n' }, { type: 'html_comment', text: '<!-- c -->' }, { type: 'text', text: 'b' }]],
    ['a tag', 'a <b> b</b>', [{ type: 'text', text: 'a ' }, { type: 'text', text: 'b', bold: true }]],
  ])('runs whitespace together across %s, as HTML does', (_name, cell, expected) => {
    // Word showed two spaces where HTML shows one
    expect(runs(cell)).toEqual(expected);
  });

  test('keeps a break that ends a paragraph before a comment', () => {
    // The comment hid the break from the </p>, so it went as one ending the cell
    expect(runs('<p>a<br><!-- c --></p>')).toEqual([{ type: 'text', text: 'a' }, { type: 'softbreak', text: '\n' }, { type: 'html_comment', text: '<!-- c -->' }]);
  });

  test.each([
    ['a table\'s body', '<table><tbody title="<!--"><tr><td>a</td></tr></tbody></table>'],
    ['a div around it', '<div title="<!--"><table><tr><td>a</td></tr></table></div>'],
    ['a row', '<table><tr title="<!--"><td>a</td></tr></table>'],
    ['a tag between cells', '<table><tr><span title="<!--"></span><td>a</td></tr></table>'],
    ['a tag in a cell', '<table><tr><td><span title="<!-- >">a</span></td></tr></table>'],
  ])('reads a table past a <!-- in an attribute of %s', (_name, html) => {
    // Which read as a comment to the end, which hid the rows
    expect(extractHtmlTables(html).map(table => table.rows.map(row => row.cells.map(cell => cell.runs.map(run => run.text).join(''))))).toEqual([[['a']]]);
  });

  test.each([
    ['a cell', '<table><tr><td><!-- <td>old</td> -->b</td><td>c</td></tr></table>', [['<!-- <td>old</td> -->b', 'c']]],
    ['a row', '<table><tr><td>a<!-- </tr><tr> --></td></tr><tr><td>b</td></tr></table>', [['a<!-- </tr><tr> -->'], ['b']]],
    ['a table', '<table><tr><td>a<!-- </table> --></td></tr><tr><td>b</td></tr></table>', [['a<!-- </table> -->'], ['b']]],
  ])('reads no end of %s in a comment in it', (_name, html, expected) => {
    // Which ended it there, and lost the rest
    expect(extractHtmlTables(html).map(table => table.rows.map(row => row.cells.map(cell => cell.runs.map(run => run.text).join('')))))
      .toEqual([expected]);
  });

  test.each(['<!-->', '<!--->'])('reads %s as an empty comment, as the browser and markdown-it do', comment => {
    // Which ran to the next --> or the end, and hid the rest of the table
    const [table] = extractHtmlTables('<table><tr><td>a' + comment + 'b</td><td>c</td></tr>' + comment + '<tr><td>d</td></tr></table>');
    expect(table.rows.map(row => row.cells.map(cell => cell.runs.map(run => run.type === 'html_comment' ? '[' + run.text + ']' : run.text).join(''))))
      .toEqual([['a[' + comment + ']b', 'c'], ['d']]);
    expect(table.comments).toEqual([comment]);
  });

  test('reads a comment to a --!>, at which the browser ends one', () => {
    // Which ran to the end, and hid the rest of the table
    const [table] = extractHtmlTables('<table><tr><td>a<!-- c --!>b</td><td>c</td></tr><!-- d --!><tr><td>e</td></tr></table>');
    expect(table.rows.map(row => row.cells.map(cell => cell.runs.map(run => run.text).join('')))).toEqual([['a<!-- c --!>b', 'c'], ['e']]);
    expect(table.comments).toEqual(['<!-- d --!>']);
  });

  test('reads the cells before a comment with no -->, which runs to the end, as one', () => {
    // Which the browser ends the row and table at
    const [table] = extractHtmlTables('<table><tr><td>a</td><!-- <td>b</td></tr></table>');
    expect(table.rows.map(row => row.cells.map(cell => cell.runs.map(run => run.text).join('')))).toEqual([['a']]);
    expect(table.comments).toEqual(['<!-- <td>b</td></tr></table>']);
  });

  test('reads a table with many <!-- and no --> in linear time', () => {
    const start = performance.now();
    extractHtmlTables('<table><tr><td>' + '<!--'.repeat(20000) + '</td></tr></table>');
    extractHtmlTables('<table><tr>' + '<td>a<!-- c --><b title="<!--">x</b></td>'.repeat(2000) + '</tr></table>');
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test.each([
    ['before a table', '<div><script>const s = "<!--";</script><table><tr><td>a</td></tr></table></div>', [['a']]],
    ['in a cell', '<table><tr><td><script>"<!--"</script>a</td><td>b</td></tr></table>', [['"<!--"a', 'b']]],
    ['between rows', '<table><tr><td>a</td></tr><style>/* </tr><!-- */</style><tr><td>b</td></tr></table>', [['a'], ['b']]],
    ['with a cell\'s end tag in it', '<table><tr><td><SCRIPT>"</td>"</script>a</td></tr></table>', [['"</td>"a']]],
  ])('reads a <!-- or an end tag in a <script> or a <style> %s as text', (_name, html, expected) => {
    // A <!-- in one began a comment, which ran to the end, and hid the table
    expect(extractHtmlTables(html).map(table => table.rows.map(row => row.cells.map(cell => cell.runs.map(run => run.text).join('')))))
      .toEqual([expected]);
  });

  test('reads no table in a <script>', () => {
    expect(extractHtmlTables('<script>"<table><tr><td>x</td></tr></table>"</script><table><tr><td>a</td></tr></table>')
      .map(table => table.rows.map(row => row.cells.map(cell => cell.runs.map(run => run.text).join(''))))).toEqual([[['a']]]);
  });

  test.each([
    ['a tag with no >', '<table><tr><td><' + 'a'.repeat(32000)],
    ['many tags with no >', '<table><tr><td>' + '<a '.repeat(32000)],
    ['many cells with no >', '<table><tr>' + '<td '.repeat(32000)],
    ['many comments in a cell', '<table><tr><td>' + '<!-- c --> '.repeat(64000) + '</td></tr></table>'],
  ])('reads %s in linear time', (_name, html) => {
    const start = performance.now();
    extractHtmlTables(html);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('reads a table of 100,000 rows', () => {
    // Its search held a state for each piece of the table, which ran past
    // the regex engine's stack, and read none, or threw in Node
    const [table] = extractHtmlTables('<table>' + '<tr><td>a</td><td>b</td></tr>'.repeat(100000) + '</table>');
    expect(table?.rows.length).toBe(100000);
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

  test('gives a line break the formatting around it', () => {
    // As text, which Word shows on it, as an underline
    expect(runs('<u>a<br></u><s><b><br>b</b></s>')).toEqual([
      { type: 'text', text: 'a', underline: true }, { type: 'softbreak', text: '\n', underline: true },
      { type: 'softbreak', text: '\n', bold: true, strikethrough: true }, { type: 'text', text: 'b', bold: true, strikethrough: true },
    ]);
  });

  test('reads a link whose target has the other quote in it', () => {
    expect(runs('<a href="https://e.com/O\'Brien">o</a>')).toEqual([{ type: 'text', text: 'o', href: 'https://e.com/O\'Brien', linkStart: true }]);
  });

  test('marks where each link starts, though the one before goes to the same place', () => {
    expect(runs('<a href="u">a <b>b</b></a><a href="u">c</a>')).toEqual([
      { type: 'text', text: 'a ', href: 'u', linkStart: true }, { type: 'text', text: 'b', bold: true, href: 'u' },
      { type: 'text', text: 'c', href: 'u', linkStart: true },
    ]);
  });

  test('reads a line break in a link as the link\'s, which starts it where it comes first', () => {
    // A break in a link was no link's, so the link's hyperlink ended at it
    expect(runs('<a href="u">a<br>b</a><br><a href="u"><br>c</a>')).toEqual([
      { type: 'text', text: 'a', href: 'u', linkStart: true }, { type: 'softbreak', text: '\n', href: 'u' }, { type: 'text', text: 'b', href: 'u' },
      { type: 'softbreak', text: '\n' },
      { type: 'softbreak', text: '\n', href: 'u', linkStart: true }, { type: 'text', text: 'c', href: 'u' },
    ]);
  });

  test('keeps a line break in a paragraph, and the formatting around it', () => {
    expect(runs('<p><b>a<br>b</b></p>')).toEqual([
      { type: 'text', text: 'a', bold: true },
      { type: 'softbreak', text: '\n', bold: true },
      { type: 'text', text: 'b', bold: true },
    ]);
  });

  test('keeps whitespace written as references, which HTML neither collapses nor trims', () => {
    expect(runs('<p>&#9;a &#32;b&nbsp;</p>')).toEqual([{ type: 'text', text: '\ta  b ' }]);
  });

  test('reads a named reference in an attribute only by a whole name, as the browser does', () => {
    // href read &notit; as ¬it;, by &not, which HTML reads without its ; in
    // text, but not in an attribute, where a letter follows it
    expect(runs('<a href="x&notit;y&not;z&copy;">t&notit;</a>')).toEqual([{ type: 'text', text: 't\u00acit;', href: 'x&notit;y\u00acz\u00a9', linkStart: true }]);
  });

  test('reads a reference once, so the text one writes stays text', () => {
    // &#38; made an & of the next reference, which read as one too
    expect(runs('&#38;#x80; &#38;#128; &amp;#128;')).toEqual([{ type: 'text', text: '&#x80; &#128; &#128;' }]);
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

