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
