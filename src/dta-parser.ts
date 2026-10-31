// -----------------------------------------------------------
// Synchronous .dta parser facade
//
// Reads a .dta Uint8Array and returns an HTML <table> string.
// @jbearak/dta-parser's reader is synchronous, which the embed
// pipeline needs.
// -----------------------------------------------------------

import { formatValue, isMissing, openDta } from '@jbearak/dta-parser';
import type { Cell, ValueLabels, Variable } from '@jbearak/dta-parser';
import type { EmbedDirective } from './embed-preprocess';

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
  const reader = openDta(data);
  const variables = reader.variables;
  let rows: Cell[][];
  let valueLabelTables: (ValueLabels | undefined)[];
  try {
    rows = reader.readRows(0, reader.info.nobs);
    valueLabelTables = variables.map(v =>
      v.valueLabels ? reader.valueLabels(v.valueLabels) : undefined
    );
  } finally {
    reader.close();
  }

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
