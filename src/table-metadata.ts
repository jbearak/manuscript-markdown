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

/** A cell's text as export and import of the HTML around an HTML table
 *  both find it: with no line break, which import reads as a backslash and
 *  a line end, as it reads one in Word's text, and spaces run together */
const identityCellText = (text: string): string => text.replace(/\\\n/g, '').replace(/\s+/g, ' ').trim();

/** A table's first row, as both find it: its cells' count and each one's
 *  text, apart as no cell's text can be, as a | can be in one */
export function tableFirstRowText(cells: string[]): string {
  return cells.length + ':' + cells.map(identityCellText).join('\u001f');
}

/** Text's length and hash, which tell it from other text in little room */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return text.length + ':' + (hash >>> 0).toString(16);
}

/** The start of a paragraph's text, as export finds it in the paragraph it
 *  writes and import in the paragraph it reads (see identityCellText), its
 *  first 32 characters, hashed, which edits past them leave alone. Import
 *  applies the place export records for a quote group only to a group whose
 *  start this is, of its first paragraph with text past an alert's label
 *  (see blockquoteListLevelProps in md-to-docx.ts) */
export function paragraphStartFingerprint(text: string): string {
  return fingerprint(identityCellText(text).slice(0, 32));
}

/** Which table's text the rows' cells' `rows` are, as both find it: each
 *  cell's text, row by row, but for the empty cells at a row's end, as Word
 *  pads a short row with, hashed */
export function tableContentsFingerprint(rows: string[][]): string {
  return fingerprint(rows.map(cells => {
    const texts = cells.map(identityCellText);
    while (texts.length > 0 && !texts[texts.length - 1]) texts.pop();
    return texts.join('\u001f');
  }).join('\u001e'));
}

/** A table export wrote, as it writes each one's for import to find its
 *  settings by: the body's '', or its note's kind and ID, as `footnote:2`,
 *  and its first row's and its text's fingerprints, from its cells' `rows` */
export type TableIdentity = [scope: string, firstRow: string, contents: string];

export function tableIdentity(rows: string[][], scope: string): TableIdentity {
  return [scope, fingerprint(tableFirstRowText(rows[0] ?? [])), tableContentsFingerprint(rows)];
}

/** The most pairs of items, between the first and last alike, that
 *  alikeInOrder compares, which pairs none of them past it, as the tables
 *  of a document of thousands would take long to compare, and leaves them
 *  to the weaker tests of matchTables */
const MAX_COMPARED_TABLES = 1 << 22;

/** The positions in `a` and `b` of the most items alike in both, in order,
 *  as a diff finds them */
function alikeInOrder(a: string[], b: string[]): [number, number][] {
  const pairs: [number, number][] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) pairs.push([start, start++]);
  let endA = a.length, endB = b.length;
  const tail: [number, number][] = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) tail.unshift([--endA, --endB]);
  const n = endA - start, m = endB - start;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_COMPARED_TABLES) {
    // The count alike in a[i..] and b[j..], from the ends
    const count = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        count[i * (m + 1) + j] = a[start + i] === b[start + j] ? count[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(count[(i + 1) * (m + 1) + j], count[i * (m + 1) + j + 1]);
      }
    }
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[start + i] === b[start + j]) pairs.push([start + i++, start + j++]);
      else if (count[(i + 1) * (m + 1) + j] >= count[i * (m + 1) + j + 1]) i++;
      else j++;
    }
  }
  return pairs.concat(tail);
}

/**
 * Which of the tables export wrote (`written`, by the index it wrote each
 * at) each one import reads (`read`, in its order) is, or undefined for one
 * that's none of them, as one Word added, so each keeps its own settings,
 * as its format and font, where Word added or deleted a table before it:
 * the same tables, in order, in the body and in the notes, then, between
 * two, one with the same first row, as a table whose cells Word edited,
 * and then the rest in order, where as many are left on each side, as a
 * table Word edited the first row of.
 */
export function matchTables(written: TableIdentity[], read: TableIdentity[]): (number | undefined)[] {
  const matched: (number | undefined)[] = read.map(() => undefined);
  const keys = [(id: TableIdentity) => id.join('\n'), (id: TableIdentity) => id[0] + '\n' + id[1]];
  const pair = (a: number[], b: number[], level: number): void => {
    if (level === keys.length) {
      if (a.length === b.length) a.forEach((index, k) => { matched[b[k]] = index; });
      return;
    }
    let lastA = 0, lastB = 0;
    const alike = alikeInOrder(a.map(index => keys[level](written[index])), b.map(index => keys[level](read[index])));
    for (const [x, y] of [...alike, [a.length, b.length]]) {
      pair(a.slice(lastA, x), b.slice(lastB, y), level + 1);
      if (x < a.length) matched[b[y]] = a[x];
      lastA = x + 1;
      lastB = y + 1;
    }
  };
  const indices = (ids: TableIdentity[], inBody: boolean) => ids.flatMap((id, index) => (id[0] === '') === inBody ? [index] : []);
  for (const inBody of [true, false]) pair(indices(written, inBody), indices(read, inBody), 0);
  return matched;
}
