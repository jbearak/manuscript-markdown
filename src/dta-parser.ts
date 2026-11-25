// -----------------------------------------------------------
// Synchronous .dta parser facade
//
// Reads a .dta Uint8Array and returns an HTML <table> string.
// @jbearak/dta-parser's reader is synchronous, which the embed
// pipeline needs.
// -----------------------------------------------------------

import { formatValue, isMissing, openDta } from '@jbearak/dta-parser';
import type { Cell, EncodingName, ValueLabels, Variable } from '@jbearak/dta-parser';
import type { EmbedDirective } from './embed-preprocess';
import { pushAll } from './arrays';

const DEFAULT_MAX_DTA_FILE_SIZE = 10_485_760; // 10 MB

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Parse a .dta file from a Uint8Array and return an HTML
 * <table> string.
 *
 * @param data - The full .dta file contents
 * @param directive - Embed directive (path and optional
 *   headers param)
 * @param maxFileSize - Maximum allowed file size in bytes
 *   (default 10 MB)
 */
export function parseDta(
  data: Uint8Array,
  directive: EmbedDirective,
  maxFileSize: number = DEFAULT_MAX_DTA_FILE_SIZE
): string {
  if (data.byteLength > maxFileSize) {
    const limitMb = (maxFileSize / 1_048_576).toFixed(1);
    return '<p><strong>Error: .dta file exceeds maximum'
      + ' size (' + limitMb + ' MB)</strong></p>';
  }

  // --- Read all observation rows, with value label sets ---
  const { variables, rows, valueLabelTables } = readTable(data);

  // --- Determine header and body rows ---
  const headerCount = directive.headers;

  let headerRows: FormattedCell[][];
  let bodyStartIdx: number;

  if (headerCount !== undefined) {
    // Use first N data rows as headers
    headerRows = [];
    const limit = Math.min(headerCount, rows.length);
    for (let r = 0; r < limit; r++) {
      headerRows.push(
        rows[r].map((cell, c) =>
          formatCell(cell, variables[c], valueLabelTables[c])
        )
      );
    }
    bodyStartIdx = headerCount;
  } else {
    // Default: variable names as header
    headerRows = [
      variables.map(v => ({ html: escapeHtml(v.name), kind: 'text' }))
    ];
    bodyStartIdx = 0;
  }

  // Build body rows
  const bodyRows: FormattedCell[][] = [];
  for (let r = bodyStartIdx; r < rows.length; r++) {
    bodyRows.push(
      rows[r].map((cell, c) =>
        formatCell(cell, variables[c], valueLabelTables[c])
      )
    );
  }

  // --- Render HTML table ---
  const parts: string[] = [];
  parts.push('<table>');

  if (headerRows.length > 0) {
    parts.push('<thead>');
    for (const row of headerRows) {
      parts.push('<tr>');
      for (const cell of row) {
        parts.push('<th' + sourceAttrs(cell) + '>' + cell.html + '</th>');
      }
      parts.push('</tr>');
    }
    parts.push('</thead>');
  }

  if (bodyRows.length > 0) {
    parts.push('<tbody>');
    for (const row of bodyRows) {
      parts.push('<tr>');
      for (const cell of row) {
        parts.push('<td' + sourceAttrs(cell) + '>' + cell.html + '</td>');
      }
      parts.push('</tr>');
    }
    parts.push('</tbody>');
  }

  parts.push('</table>');
  return parts.join('');
}

interface DtaTable {
  release: number;
  variables: readonly Variable[];
  rows: Cell[][];
  valueLabelTables: (ValueLabels | undefined)[];
  /**
   * Text the file holds that the table doesn't show: the data label,
   * timestamp, sort order and characteristics (which include the notes).
   * Read only before release 118, where it is evidence of the encoding.
   */
  otherText: string[];
}

function readTableAs(data: Uint8Array, encoding?: EncodingName): DtaTable {
  const reader = openDta(data, encoding ? { encoding } : undefined);
  try {
    const { info, variables } = reader;
    // One lookup per set, so variables sharing a set share its object.
    const sets = new Map<string, ValueLabels | undefined>();
    const labelsOf = (name: string): ValueLabels | undefined => {
      if (!sets.has(name)) sets.set(name, reader.valueLabels(name));
      return sets.get(name);
    };
    const otherText: string[] = [];
    if (info.release < 118) {
      otherText.push(info.label, info.timestamp);
      pushAll(otherText, info.sortedBy);
      // Only evidence, so characteristics the library can't read, as
      // damaged ones, don't keep the table from being read.
      try {
        for (const c of reader.characteristics()) otherText.push(c.variable, c.name, c.value);
      } catch {
        // No more evidence from them.
      }
    }
    return {
      release: info.release,
      variables,
      rows: reader.readRows(0, info.nobs),
      valueLabelTables: variables.map(v => (v.valueLabels ? labelsOf(v.valueLabels) : undefined)),
      otherText,
    };
  } finally {
    reader.close();
  }
}

/** Every piece of text the reader decoded. */
function tableText(table: DtaTable): string[] {
  const text: string[] = [...table.otherText];
  for (const v of table.variables) text.push(v.name, v.label, v.format, v.valueLabels);
  // Visit each value label set once: wide files share one across many variables.
  for (const labels of new Set(table.valueLabelTables)) {
    if (labels) for (const label of labels.values()) text.push(label);
  }
  for (const row of table.rows) {
    for (const cell of row) if (typeof cell === 'string') text.push(cell);
  }
  return text;
}

/**
 * Read a .dta file, choosing how to decode text in files before
 * release 118. Those files name no encoding: Stata 13 and earlier wrote
 * the platform's code page, while R's foreign::write.dta and other tools
 * write UTF-8. The library decodes them as windows-1252 unless told
 * otherwise, so where that read has non-ASCII text, read again as UTF-8
 * and keep that read when all its text was valid UTF-8: no U+FFFD but
 * one the file holds itself, which is valid UTF-8 (EF BF BD) and reads
 * as three characters in windows-1252.
 * All the file's text counts, shown in the table or not: one string
 * UTF-8 can't read proves the file isn't UTF-8. Where every string reads
 * as UTF-8, nothing settles the question and the UTF-8 read wins.
 * Release 118 and later declare UTF-8 and are read once, as is.
 */
function readTable(data: Uint8Array): DtaTable {
  const table = readTableAs(data);
  if (table.release >= 118) return table;
  const text = tableText(table);
  if (!text.some(t => /[\u0080-\uffff]/.test(t))) return table;
  const utf8 = readTableAs(data, 'utf-8');
  const utf8Text = tableText(utf8);
  const count = (t: string, part: string) => t.split(part).length - 1;
  // Both reads give the same strings in the same order, so each U+FFFD
  // the file holds has its three bytes in the windows-1252 read of its
  // string; one more than those is a byte UTF-8 couldn't read.
  const unreadable = utf8Text.length !== text.length
    || utf8Text.some((t, i) => count(t, '\ufffd') > count(text[i], '\u00ef\u00bf\u00bd'));
  return unreadable ? table : utf8;
}

interface FormattedCell {
  html: string;
  kind: 'text' | 'number' | 'scientific' | 'date' | 'time' | 'label' | 'missing';
  rawValue?: number;
  sourceFormat?: string;
}

function sourceAttrs(cell: FormattedCell): string {
  if (cell.kind === 'text') return '';
  let attrs = ' data-mm-kind="' + cell.kind + '"';
  if (cell.rawValue !== undefined) attrs += ' data-mm-raw="' + cell.rawValue + '"';
  if (cell.sourceFormat) attrs += ' data-mm-format="' + escapeHtml(cell.sourceFormat) + '"';
  return attrs;
}

function formatCell(
  cell: Cell,
  variable: Variable,
  labelTable: ValueLabels | undefined
): FormattedCell {
  // Missing values (formatValue shows the label of a labelled one)
  if (isMissing(cell)) {
    const display = formatValue(cell, variable.format, labelTable);
    return { html: '<span class="mm-missing-value">' + escapeHtml(display) + '</span>', kind: 'missing' };
  }

  // Value label lookup (numeric values only)
  if (typeof cell === 'number' && labelTable) {
    const label = labelTable.get(cell);
    if (label !== undefined) {
      return { html: escapeHtml(label), kind: 'label' };
    }
  }

  // Display format
  if (typeof cell === 'number') {
    const display = formatValue(cell, variable.format);
    const kind = /^%t/i.test(variable.format) ? (/%tc/i.test(variable.format) ? 'time' : 'date')
      : /e/i.test(variable.format) ? 'scientific' : 'number';
    return {
      html: escapeHtml(display),
      kind,
      ...(kind === 'number' || kind === 'scientific' ? { rawValue: cell } : {}),
      sourceFormat: variable.format,
    };
  }

  // String values; formatValue describes a binary strL by its length
  const text = typeof cell === 'string' ? cell : formatValue(cell, variable.format);
  return { html: escapeHtml(text), kind: 'text' };
}
