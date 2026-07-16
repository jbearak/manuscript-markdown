import { decodeNumericHtmlEntity } from './html-entities';

export interface HtmlTableRun {
  type: 'text' | 'softbreak' | 'hardbreak';
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  href?: string;
}

export interface HtmlTableCell {
  runs: HtmlTableRun[];
  colspan?: number;
  rowspan?: number;
  source?: HtmlTableCellSource;
}

export interface HtmlTableCellSource {
  kind: 'text' | 'number' | 'percent' | 'scientific' | 'currency' | 'date' | 'time' | 'boolean' | 'identifier' | 'label' | 'missing';
  display: string;
  rawValue?: number;
  sourceFormat?: string;
}

export interface HtmlTableRow {
  cells: HtmlTableCell[];
  header: boolean;
}

export interface HtmlTableMeta {
  rows: HtmlTableRow[];
  fontSize?: number;   // from data-font-size attribute
  font?: string;       // from data-font attribute
  orientation?: 'landscape' | 'portrait'; // from data-orientation attribute
  colWidths?: number[] | 'equal' | 'auto'; // from data-col-widths attribute
  embedIdx?: number;   // from data-embed-idx attribute (set by embed preprocessing)
  digits?: import('./table-number-format').TableDigits;
  decimalMark?: import('./table-number-format').TableDecimalMark;
  digitGrouping?: import('./table-number-format').TableDigitGrouping;
}

/** Parse data-col-widths attribute value (inline to avoid circular dependency with frontmatter.ts). */
function parseColWidthsAttr(raw: string): number[] | 'equal' | 'auto' | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'equal') return 'equal';
  if (trimmed === 'auto') return 'auto';
  let inner = trimmed;
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1);
  const parts = inner.split(/[\s,]+/).filter(s => s.length > 0);
  if (parts.length === 0) return undefined;
  const nums = parts.map(s => Number(s));
  if (nums.some(n => !Number.isFinite(n) || n <= 0)) return undefined;
  return nums;
}

export function extractHtmlTables(html: string): HtmlTableMeta[] {
  const tables: HtmlTableMeta[] = [];
  // Regex-based extraction intentionally does not support nested <table> blocks.
  // This parser targets simple manuscript tables (<table>/<tr>/<th>/<td>).
	const tableRegex = /<table\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const attrs = tableMatch[1];
    const rows = extractHtmlTableRows(tableMatch[2]);
    // Invariant: only non-empty row sets are returned to callers.
    if (rows.length > 0) {
      const meta: HtmlTableMeta = { rows };
      const fontSizeMatch = attrs.match(/data-font-size\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
      if (fontSizeMatch) {
        const n = parseFloat(fontSizeMatch[1]);
        if (isFinite(n) && n > 0) meta.fontSize = n;
      }
      // data-font regex: separate double-quoted and single-quoted branches so that
      // apostrophes inside double-quoted values (e.g. "O'Brien Sans") are preserved.
      // After extraction the value is HTML-entity-decoded and whitespace-normalized.
      const fontMatch = attrs.match(/data-font\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"]+))/i);
      const fontVal = fontMatch ? (fontMatch[1] ?? fontMatch[2] ?? fontMatch[3]) : undefined;
      if (fontVal) {
        const normalized = decodeHtmlEntities(fontVal).trim().replace(/\s+/g, ' ');
        if (normalized) meta.font = normalized;
      }
      // data-orientation: "landscape" or "portrait"
      // Uses separate quote branches (like data-font) so whitespace-padded values are handled.
      const orientMatch = attrs.match(/data-orientation\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"]+))/i);
      const orientVal = (orientMatch?.[1] ?? orientMatch?.[2] ?? orientMatch?.[3])?.trim().toLowerCase();
      if (orientVal === 'landscape' || orientVal === 'portrait') meta.orientation = orientVal;
      // data-col-widths: "2,1,1", "equal", "auto", etc.
      const colWidthsMatch = attrs.match(/data-col-widths\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"]+))/i);
      const colWidthsVal = (colWidthsMatch?.[1] ?? colWidthsMatch?.[2] ?? colWidthsMatch?.[3])?.trim();
      if (colWidthsVal) {
        const parsed = parseColWidthsAttr(colWidthsVal);
        if (parsed) meta.colWidths = parsed;
      }
      // data-embed-idx: integer index set by embed preprocessing for round-trip
      const embedIdxMatch = attrs.match(/data-embed-idx\s*=\s*["']?(\d+)["']?/i);
      if (embedIdxMatch) {
        const idx = parseInt(embedIdxMatch[1], 10);
        if (Number.isFinite(idx)) meta.embedIdx = idx;
      }
      const digitsMatch = attrs.match(/data-digits\s*=\s*["']?([^\s"'>]+)["']?/i);
      if (digitsMatch) {
        const raw = digitsMatch[1].toLowerCase();
        const numeric = Number(raw);
        const parsed = raw === 'source' ? 'source' : /^\d+$/.test(raw) && Number.isSafeInteger(numeric) && numeric <= 1000 ? numeric : undefined;
        if (parsed !== undefined) meta.digits = parsed;
      }
      const decimalMatch = attrs.match(/data-decimal-mark\s*=\s*["']?([^\s"'>]+)["']?/i);
      if (decimalMatch) {
        const raw = decimalMatch[1].toLowerCase();
        const parsed = raw === 'source' || raw === 'point' || raw === 'comma' || raw === 'midpoint' ? raw : undefined;
        if (parsed) meta.decimalMark = parsed;
      }
      const groupingMatch = attrs.match(/data-digit-grouping\s*=\s*["']?([^\s"'>]+)["']?/i);
      if (groupingMatch) {
        const raw = groupingMatch[1].toLowerCase();
        const parsed = raw === 'source' || raw === 'none' || raw === 'comma' || raw === 'period' || raw === 'space' || raw === 'thin-space' ? raw : undefined;
        if (parsed) meta.digitGrouping = parsed;
      }
      tables.push(meta);
    }
  }
  return tables;
}

function extractHtmlTableRows(tableHtml: string): HtmlTableRow[] {
  const rows: HtmlTableRow[] = [];
  // Similarly, nested <tr> structures are out of scope for this lightweight parser.
	const rowRegex = /<tr\b(?:"[^"]*"|'[^']*'|[^'">])*?>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells = extractHtmlTableCells(rowMatch[1]);
    // Invariant: rows with no cells are skipped.
    if (cells.length > 0) {
      rows.push({
        cells: cells.map(cell => ({
          runs: cell.runs,
          ...(cell.source ? { source: cell.source } : {}),
          ...(cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {}),
          ...(cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
        })),
        header: cells.some(c => c.isHeader)
      });
    }
  }
  return rows;
}

function extractHtmlTableCells(rowHtml: string): Array<{ runs: HtmlTableRun[]; isHeader: boolean; colspan?: number; rowspan?: number; source?: HtmlTableCellSource }> {
  const cells: Array<{ runs: HtmlTableRun[]; isHeader: boolean; colspan?: number; rowspan?: number; source?: HtmlTableCellSource }> = [];
  // Nested table-cell tags are not supported; this matches flat <th>/<td> content only.
	const cellRegex = /<(th|td)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1>/gi;
  let cellMatch: RegExpExecArray | null;
  while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
    const isHeader = cellMatch[1].toLowerCase() === 'th';
    const attrs = cellMatch[2];
    const runs = parseHtmlCellRuns(cellMatch[3]);
    const colspanMatch = attrs.match(/colspan\s*=\s*["']?(\d+)/i);
    const rowspanMatch = attrs.match(/rowspan\s*=\s*["']?(\d+)/i);
    const colspan = colspanMatch ? parseInt(colspanMatch[1], 10) : undefined;
    const rowspan = rowspanMatch ? parseInt(rowspanMatch[1], 10) : undefined;
    const kindRaw = extractAttr(attrs, 'data-mm-kind');
    const validKinds: HtmlTableCellSource['kind'][] = ['text', 'number', 'percent', 'scientific', 'currency', 'date', 'time', 'boolean', 'identifier', 'label', 'missing'];
    const kind = validKinds.includes(kindRaw as HtmlTableCellSource['kind']) ? kindRaw as HtmlTableCellSource['kind'] : undefined;
    const rawValueText = extractAttr(attrs, 'data-mm-raw');
    const rawValue = rawValueText !== undefined ? Number(rawValueText) : undefined;
    const sourceFormat = extractAttr(attrs, 'data-mm-format');
    cells.push({
      runs,
      isHeader,
      ...(colspan && colspan > 1 ? { colspan } : {}),
      ...(rowspan && rowspan > 1 ? { rowspan } : {}),
      ...(kind ? { source: { kind, display: runs.map(run => run.text).join(''), ...(rawValue !== undefined && Number.isFinite(rawValue) ? { rawValue } : {}), ...(sourceFormat ? { sourceFormat } : {}) } } : {}),
    });
  }
  return cells;
}

function extractAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  const value = match ? match[1] ?? match[2] ?? match[3] : undefined;
  return value === undefined ? undefined : decodeHtmlEntities(value);
}

function parseHtmlCellRuns(cellHtml: string): HtmlTableRun[] {
  const runs: HtmlTableRun[] = [];
  let bold = false;
  let italic = false;
  let underline = false;
  let strikethrough = false;
  let code = false;
  let superscript = false;
  let subscript = false;
  let href: string | undefined;

  // Tokenize the HTML into tags and text segments
  const tagRegex = /<(\/?)(\w+)\b([^>]*)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(cellHtml)) !== null) {
    // Emit any text before this tag
    if (match.index > lastIndex) {
      const rawText = cellHtml.slice(lastIndex, match.index);
      const decoded = decodeHtmlEntities(rawText);
			const text = code ? decoded : decoded.replace(/[ \t\r\n]+/g, ' ');
      if (text) {
        runs.push({
          type: 'text', text,
          ...(bold ? { bold } : {}),
          ...(italic ? { italic } : {}),
          ...(underline ? { underline } : {}),
          ...(strikethrough ? { strikethrough } : {}),
          ...(code ? { code } : {}),
          ...(superscript ? { superscript } : {}),
          ...(subscript ? { subscript } : {}),
          ...(href ? { href } : {}),
        });
      }
    }
    lastIndex = match.index + match[0].length;

    const isClose = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attrs = match[3];

    if (tag === 'br') {
      runs.push({ type: 'softbreak', text: '\n' });
    } else if (tag === 'b' || tag === 'strong') {
      bold = !isClose;
    } else if (tag === 'i' || tag === 'em') {
      italic = !isClose;
    } else if (tag === 'u') {
      underline = !isClose;
    } else if (tag === 's' || tag === 'del' || tag === 'strike') {
      strikethrough = !isClose;
    } else if (tag === 'code') {
      code = !isClose;
    } else if (tag === 'sup') {
      superscript = !isClose;
    } else if (tag === 'sub') {
      subscript = !isClose;
    } else if (tag === 'a') {
      if (!isClose) {
        const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
        href = hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : undefined;
      } else {
        href = undefined;
      }
    } else if (tag === 'p' && isClose) {
      // Treat </p> as a soft break to separate paragraphs within a cell.
      runs.push({ type: 'softbreak', text: '\n' });
    }
  }

  // Emit any trailing text
  if (lastIndex < cellHtml.length) {
    const rawText = cellHtml.slice(lastIndex);
    const decoded = decodeHtmlEntities(rawText);
		const text = code ? decoded : decoded.replace(/[ \t\r\n]+/g, ' ');
    if (text) {
      runs.push({
        type: 'text', text,
        ...(bold ? { bold } : {}),
        ...(italic ? { italic } : {}),
        ...(underline ? { underline } : {}),
        ...(strikethrough ? { strikethrough } : {}),
        ...(code ? { code } : {}),
        ...(superscript ? { superscript } : {}),
        ...(subscript ? { subscript } : {}),
        ...(href ? { href } : {}),
      });
    }
  }

  // Trim leading/trailing whitespace from the run sequence
  if (runs.length > 0) {
    const first = runs[0];
    if (first.type === 'text' && !first.code) {
      first.text = first.text.replace(/^\s+/, '');
      if (!first.text) runs.shift();
    }
  }
  if (runs.length > 0) {
    const last = runs[runs.length - 1];
    if (last.type === 'softbreak') runs.pop();
    else if (last.type === 'text' && !last.code) {
      last.text = last.text.replace(/\s+$/, '');
      if (!last.text) runs.pop();
    }
  }

  // Keep shape stable for callers expecting at least one run per cell.
  if (runs.length === 0) {
    runs.push({ type: 'text', text: '' });
  }

  return runs;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (entity, code) => decodeNumericHtmlEntity(entity, code, 10))
    .replace(/&#x([0-9a-fA-F]+);/g, (entity, hex) => decodeNumericHtmlEntity(entity, hex, 16))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
