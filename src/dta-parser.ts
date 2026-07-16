// -----------------------------------------------------------
// Synchronous .dta parser facade
//
// Reads a .dta Uint8Array and returns an HTML <table> string.
// Calls Sight's internal parser modules directly, bypassing
// the async DtaFile class, because the embed pipeline is
// synchronous.
// -----------------------------------------------------------

import {
  apply_display_format,
  build_gso_index,
  is_legacy_format,
  is_missing_value_object,
  missing_type_to_label_key,
  parse_legacy_metadata,
  parse_metadata,
  parse_value_labels,
  read_rows_from_buffer,
  resolve_strl,
} from '@jbearak/dta-parser';
import type {
  DtaMetadata,
  VariableInfo,
  RowCell,
} from '@jbearak/dta-parser';
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

  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;

  // --- Parse metadata ---
  // Stata format versions 113-115 are legacy
  const firstByte = data[0];
  const isLegacy =
    firstByte === 113
    || firstByte === 114
    || firstByte === 115;

  let metadata: DtaMetadata;
  if (isLegacy) {
    metadata = parse_legacy_metadata(
      buffer, data.byteLength
    );
  } else {
    metadata = parse_metadata(buffer);
  }

  // --- Read all observation rows ---
  const rows = read_rows_from_buffer(
    buffer, metadata, 0, metadata.nobs
  );

  // --- Resolve strL variables ---
  const hasStrl = metadata.variables.some(
    v => v.type === 'strL'
  );
  if (hasStrl) {
    const gsoIndex = build_gso_index(buffer, metadata);
    const dataTagLen =
      is_legacy_format(metadata.format_version) ? 0 : 6;

    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < metadata.nvar; c++) {
        const variable = metadata.variables[c];
        if (variable.type !== 'strL') continue;

        const pointerOffset =
          metadata.section_offsets.data
          + dataTagLen
          + r * metadata.obs_length
          + variable.byte_offset;

        const resolved = resolve_strl(
          buffer, metadata, gsoIndex, pointerOffset
        );
        if (resolved !== null) {
          rows[r][c] = resolved;
        }
      }
    }
  }

  // --- Parse value label tables ---
  const valueLabelTables = parse_value_labels(
    buffer, metadata
  );

  // --- Determine header and body rows ---
  const variables = metadata.variables;
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
          formatCell(cell, variables[c], valueLabelTables)
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
        formatCell(cell, variables[c], valueLabelTables)
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
  cell: RowCell,
  variable: VariableInfo,
  valueLabelTables: Map<string, Map<number, string>>
): FormattedCell {
  const labelTable = variable.value_label_name
    ? valueLabelTables.get(variable.value_label_name)
    : undefined;

  // Missing values
  if (is_missing_value_object(cell)) {
    let display: string;
    if (labelTable) {
      const labelKey = missing_type_to_label_key(
        cell.missing_type
      );
      const label = labelTable.get(labelKey);
      display = label ?? cell.missing_type;
    } else {
      display = cell.missing_type;
    }
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
    const formatted = apply_display_format(
      cell, variable.format
    );
    const display = formatted ?? String(cell);
    const kind = /^%t/i.test(variable.format) ? (/%tc/i.test(variable.format) ? 'time' : 'date')
      : /e/i.test(variable.format) ? 'scientific' : 'number';
    return {
      html: escapeHtml(display),
      kind,
      ...(kind === 'number' || kind === 'scientific' ? { rawValue: cell } : {}),
      sourceFormat: variable.format,
    };
  }

  // String values
  return { html: escapeHtml(String(cell)), kind: 'text' };
}
