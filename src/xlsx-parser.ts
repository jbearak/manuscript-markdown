import * as XLSX from '@e965/xlsx';
import type { HtmlTableMeta, HtmlTableRow, HtmlTableCell, HtmlTableRun, HtmlTableCellSource } from './html-table-parser';
import { isCurrencySourceFormat, selectExcelFormatSection, stripExcelFormatLiterals } from './table-number-format';

export interface XlsxParseOptions {
  sheet?: string;   // sheet name or 1-based index
  range?: string;   // cell range (A1:F20) or named range
  headers?: number; // number of header rows (default 1)
}

interface SpreadsheetFormatApi {
  is_date?: (format: string) => boolean;
}

const spreadsheetFormatApi = XLSX.SSF as unknown as SpreadsheetFormatApi;

function isDateFormat(format: string): boolean {
  return spreadsheetFormatApi.is_date?.(format) ?? false;
}

function classifyXlsxCellKind(cell: XLSX.CellObject, sourceFormat: string | undefined): HtmlTableCellSource['kind'] {
  if (cell.t === 'b') return 'boolean';

  const activeFormat = sourceFormat && typeof cell.v === 'number'
    ? selectExcelFormatSection(sourceFormat, cell.v)
    : sourceFormat ?? '';
  let semanticSourceFormat = activeFormat;
  let semanticFormat = stripExcelFormatLiterals(semanticSourceFormat);
  let semanticValue = typeof cell.v === 'number' ? cell.v : 1;
  const activeIsDate = Boolean(activeFormat && isDateFormat(activeFormat));

  // A placeholder-only zero section retains the positive section's semantics.
  if (cell.v === 0 && !activeIsDate && !/[0#?]/.test(semanticFormat) && sourceFormat) {
    semanticValue = 1;
    semanticSourceFormat = selectExcelFormatSection(sourceFormat, semanticValue);
    semanticFormat = stripExcelFormatLiterals(semanticSourceFormat);
  }

  if (cell.t === 'd' || (cell.t === 'n' && semanticSourceFormat && isDateFormat(semanticSourceFormat))) {
    return 'date';
  }
  if (cell.t !== 'n') return 'text';
  if (sourceFormat && /%/.test(semanticFormat)) return 'percent';
  if (sourceFormat && /[Ee][+-]?0+/.test(semanticFormat)) return 'scientific';
  if (sourceFormat && isCurrencySourceFormat(sourceFormat, semanticValue)) return 'currency';
  if (sourceFormat) {
    const mask = semanticFormat.trim().replace(/[()]/g, '').replace(/^[+-]+|[+-]+$/g, '');
    if (/^0{2,}$/.test(mask) || /^0+(?:[- /]0+)+$/.test(mask)) return 'identifier';
  }
  return 'number';
}

/**
 * Parse an XLSX buffer into HtmlTableMeta.
 *
 * Sheet resolution: 1-based index if numeric, name match otherwise, first sheet if omitted.
 * Range resolution: explicit cell ref, named range, or auto-detect bounding rectangle.
 * Merged cells produce colspan/rowspan on the top-left cell.
 */
export function parseXlsx(data: Uint8Array, options?: XlsxParseOptions): HtmlTableMeta {
	const wb = XLSX.read(data, { type: 'array', cellNF: true, cellDates: false });
  const headerCount = options?.headers ?? 1;

  // --- Sheet resolution ---
  let ws = resolveSheet(wb, options?.sheet);

  // --- Range resolution (may switch ws if named range points to another sheet) ---
  const rangeResult = resolveRange(wb, ws, options?.range);
  const rangeRef = rangeResult.range;
  if (rangeResult.ws) ws = rangeResult.ws;

  // --- Parse cells within range ---
  const range = XLSX.utils.decode_range(rangeRef);
  const merges = ws['!merges'] || [];

  // Build a set of cells that are "covered" by a merge (not the top-left origin)
  const coveredCells = new Set<string>();
  const mergeMap = new Map<string, { colspan?: number; rowspan?: number }>();

  for (const merge of merges) {
    const colspan = merge.e.c - merge.s.c + 1;
    const rowspan = merge.e.r - merge.s.r + 1;
    const originKey = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
    if (colspan > 1 || rowspan > 1) {
      const info: { colspan?: number; rowspan?: number } = {};
      if (colspan > 1) info.colspan = colspan;
      if (rowspan > 1) info.rowspan = rowspan;
      mergeMap.set(originKey, info);
    }
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (r === merge.s.r && c === merge.s.c) continue;
        coveredCells.add(XLSX.utils.encode_cell({ r, c }));
      }
    }
  }

  const rows: HtmlTableRow[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: HtmlTableCell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellRef = XLSX.utils.encode_cell({ r, c });
      if (coveredCells.has(cellRef)) continue;

      const cell = ws[cellRef];
      const text = cell ? (cell.w ?? XLSX.utils.format_cell(cell) ?? String(cell.v ?? '')) : '';
      const runs: HtmlTableRun[] = [{ type: 'text', text }];
      const tableCell: HtmlTableCell = { runs };

      if (cell) {
        const sourceFormat = typeof cell.z === 'string' ? cell.z : undefined;
        const kind = classifyXlsxCellKind(cell, sourceFormat);
        tableCell.source = {
          kind,
          display: text,
          ...(typeof cell.v === 'number' && kind !== 'date' && kind !== 'identifier' ? { rawValue: cell.v } : {}),
          ...(sourceFormat ? { sourceFormat } : {}),
        };
      }

      const mergeInfo = mergeMap.get(cellRef);
      if (mergeInfo) {
        if (mergeInfo.colspan) tableCell.colspan = mergeInfo.colspan;
        if (mergeInfo.rowspan) tableCell.rowspan = mergeInfo.rowspan;
      }

      cells.push(tableCell);
    }

    const rowIdx = r - range.s.r;
    rows.push({ cells, header: rowIdx < headerCount });
  }

  return { rows };
}

function resolveSheet(wb: XLSX.WorkBook, sheet?: string): XLSX.WorkSheet {
  if (sheet === undefined) {
    return wb.Sheets[wb.SheetNames[0]];
  }

  // Try as 1-based index
  const idx = Number(sheet);
  if (Number.isInteger(idx) && idx >= 1) {
    if (idx > wb.SheetNames.length) {
      throw new Error('Sheet index ' + idx + ' out of range (workbook has ' + wb.SheetNames.length + ' sheets)');
    }
    return wb.Sheets[wb.SheetNames[idx - 1]];
  }

  // Try as name
  const ws = wb.Sheets[sheet];
  if (!ws) {
    throw new Error('Sheet "' + sheet + '" not found in workbook');
  }
  return ws;
}

function resolveRange(wb: XLSX.WorkBook, ws: XLSX.WorkSheet, range?: string): { range: string; ws?: XLSX.WorkSheet } {
  if (!range) {
    // Auto-detect bounding rectangle by scanning actual cell keys
    let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
    for (const key of Object.keys(ws)) {
      if (key.startsWith('!')) continue;
      const cell = XLSX.utils.decode_cell(key);
      if (cell.r < minR) minR = cell.r;
      if (cell.r > maxR) maxR = cell.r;
      if (cell.c < minC) minC = cell.c;
      if (cell.c > maxC) maxC = cell.c;
    }
    if (maxR < 0) throw new Error('Sheet is empty');
    return { range: XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } }) };
  }

  // Check if it's a cell reference (contains a colon with letter-number patterns)
  if (/^[A-Z]+\d+:[A-Z]+\d+$/i.test(range.replace(/\$/g, ''))) {
    return { range };
  }

  // Try as named range
  const names = wb.Workbook?.Names;
  if (names) {
    const found = names.find(n => n.Name === range);
    if (found && found.Ref) {
      // Ref format: 'SheetName'!$A$1:$B$2 or SheetName!A1:B2
      const refPart = found.Ref.replace(/^.*!/, '').replace(/\$/g, '');
      // Extract the sheet name from the ref and switch to it if different
      const sheetMatch = found.Ref.match(/^'?([^'!]+)'?!/);
      const targetSheet = sheetMatch ? wb.Sheets[sheetMatch[1]] : undefined;
      return { range: refPart, ws: targetSheet };
    }
  }

  throw new Error('Named range "' + range + '" not found in workbook');
}
