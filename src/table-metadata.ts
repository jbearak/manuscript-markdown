// Dependency-free lexical contracts shared by table parsers and formatters.

// Formatting expands each cell by this value, so an explicit bound prevents a
// malformed document setting from allocating an unbounded output string.
export const MAX_TABLE_DIGITS = 1000;

export type TableDigits = number | 'source';

export const TABLE_DECIMAL_MARKS = ['source', 'point', 'comma', 'midpoint'] as const;
export type TableDecimalMark = typeof TABLE_DECIMAL_MARKS[number];

export const TABLE_DIGIT_GROUPINGS = ['source', 'none', 'comma', 'period', 'space', 'thin-space'] as const;
export type TableDigitGrouping = typeof TABLE_DIGIT_GROUPINGS[number];

export interface TableNumberFormat {
  digits?: TableDigits;
  decimalMark?: TableDecimalMark;
  digitGrouping?: TableDigitGrouping;
}

export function parseTableDigits(raw: string): TableDigits | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'source') return 'source';
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed <= MAX_TABLE_DIGITS) return parsed;
  }
  return undefined;
}

export function parseTableDecimalMark(raw: string): TableDecimalMark | undefined {
  const value = raw.trim().toLowerCase();
  return (TABLE_DECIMAL_MARKS as readonly string[]).includes(value)
    ? value as TableDecimalMark
    : undefined;
}

export function parseTableDigitGrouping(raw: string): TableDigitGrouping | undefined {
  const value = raw.trim().toLowerCase();
  return (TABLE_DIGIT_GROUPINGS as readonly string[]).includes(value)
    ? value as TableDigitGrouping
    : undefined;
}

export const HTML_TABLE_CELL_SOURCE_KINDS = [
  'text',
  'number',
  'percent',
  'scientific',
  'currency',
  'date',
  'time',
  'boolean',
  'identifier',
  'label',
  'missing',
] as const;

export type HtmlTableCellSourceKind = typeof HTML_TABLE_CELL_SOURCE_KINDS[number];

export function parseHtmlTableCellSourceKind(raw: string | undefined): HtmlTableCellSourceKind | undefined {
  if (raw === undefined) return undefined;
  return (HTML_TABLE_CELL_SOURCE_KINDS as readonly string[]).includes(raw)
    ? raw as HtmlTableCellSourceKind
    : undefined;
}

/** A table's first row, as export and import of the HTML around an HTML
 *  table both find it: its cells' count and each one's text, spaces run
 *  together, apart as no cell's text can be, as a | can be in one */
export function tableFirstRowText(cells: string[]): string {
  return cells.length + ':' + cells.map(cell => cell.replace(/\s+/g, ' ').trim()).join('\u001f');
}

/** Which table's text the rows' cells' `rows` are, as export and import of
 *  the HTML around an HTML table both find it: each cell's text, spaces run
 *  together, row by row, but for the empty cells at a row's end, as Word
 *  pads a short row with, hashed */
export function tableContentsFingerprint(rows: string[][]): string {
  const text = rows.map(cells => {
    const texts = cells.map(cell => cell.replace(/\s+/g, ' ').trim());
    while (texts.length > 0 && !texts[texts.length - 1]) texts.pop();
    return texts.join('\u001f');
  }).join('\u001e');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return text.length + ':' + (hash >>> 0).toString(16);
}
