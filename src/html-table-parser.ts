import { decodeNumericHtmlEntity } from './html-entities';
import {
  parseHtmlTableCellSourceKind,
  parseTableDigits,
  parseTableDecimalMark,
  parseTableDigitGrouping,
  type HtmlTableCellSourceKind,
  type TableDigits,
  type TableDecimalMark,
  type TableDigitGrouping,
} from './table-metadata';

export interface HtmlTableRun {
  type: 'text' | 'softbreak' | 'hardbreak' | 'paragraph' | 'html_comment'; // paragraph: the gap between two of a cell's <p>s
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  href?: string;
  linkStart?: true; // the first run of an <a>, which a run of one before to the same place doesn't join
}

export interface HtmlTableCell {
  runs: HtmlTableRun[];
  colspan?: number;
  rowspan?: number;
  source?: HtmlTableCellSource;
  align?: 'left' | 'center' | 'right';
}

export interface HtmlTableCellSource {
  kind: HtmlTableCellSourceKind;
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
  digits?: TableDigits;
  decimalMark?: TableDecimalMark;
  digitGrouping?: TableDigitGrouping;
  comments?: string[]; // the comments between its rows or cells, which hide what's in them
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

// A tag, whose quoted attributes can hold a > or a <!--
const HTML_TAG_BODY = '\\/?[A-Za-z][^\\s/>]*(?:"[^"]*"|\'[^\']*\'|[^\'">])*>';
const HTML_TAG = '<' + HTML_TAG_BODY;

/** A piece of the HTML in a table, row or cell, as the search for its end
 *  reads it: a comment or a tag whole, so that an end tag in either ends
 *  nothing, or else a character. Each (?=(...))\N takes what it finds whole,
 *  as an atomic group would, and a < takes one of the three, so the search
 *  has one way through the HTML. `group` is the number of its first group
 *  in the search's pattern. A comment with no --> isn't one, as it ends
 *  what holds it (see HTML_REST_IN_COMMENT). */
function htmlContentUnit(group: number): string {
  return '(?:(?=(<!--[\\s\\S]*?-->))\\' + group + '|(?=(' + HTML_TAG + '))\\' + (group + 1)
    + '|[^<]|<(?!!--)(?!' + HTML_TAG_BODY + '))';
}

// A comment with no -->, which runs to the end, past the end tag of what
// holds it, which the browser ends there, so it goes with what holds it,
// whose search reads it as a comment
const HTML_REST_IN_COMMENT = '((?=<!--(?![\\s\\S]*?-->))[\\s\\S]*)';

export function extractHtmlTables(html: string): HtmlTableMeta[] {
  const tables: HtmlTableMeta[] = [];
  // Regex-based extraction intentionally does not support nested <table> blocks.
  // This parser targets simple manuscript tables (<table>/<tr>/<th>/<td>).
  // Not one in a comment, which the browser and Word's export of it hide,
  // which the search goes past whole, to the end where no --> ends it, as
  // it goes past each other tag, whose quoted attribute can hold a <!--.
  // Nor does a </table> in a comment in it end it (see htmlContentUnit).
	const tableRegex = new RegExp('<!--(?:[\\s\\S]*?-->|[\\s\\S]*$)|<table\\b((?:"[^"]*"|\'[^\']*\'|[^\'">])*)>(' + htmlContentUnit(3) + '*?)(?:<\\/table>|' + HTML_REST_IN_COMMENT + ')|' + HTML_TAG, 'gi');
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    if (tableMatch[2] === undefined) continue;
    const attrs = tableMatch[1];
    const comments: string[] = [];
    const rows = extractHtmlTableRows(tableMatch[2] + (tableMatch[5] ?? ''), comments);
    // Invariant: only tables with rows are returned to callers, or with
    // comments that hide all of them, which a caller can't drop unseen.
    if (rows.length > 0 || comments.length > 0) {
      const meta: HtmlTableMeta = { rows };
      if (comments.length > 0) meta.comments = comments;
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
        const parsed = parseTableDigits(digitsMatch[1]);
        if (parsed !== undefined) meta.digits = parsed;
      }
      const decimalMatch = attrs.match(/data-decimal-mark\s*=\s*["']?([^\s"'>]+)["']?/i);
      if (decimalMatch) {
        const parsed = parseTableDecimalMark(decimalMatch[1]);
        if (parsed) meta.decimalMark = parsed;
      }
      const groupingMatch = attrs.match(/data-digit-grouping\s*=\s*["']?([^\s"'>]+)["']?/i);
      if (groupingMatch) {
        const parsed = parseTableDigitGrouping(groupingMatch[1]);
        if (parsed) meta.digitGrouping = parsed;
      }
      tables.push(meta);
    }
  }
  return tables;
}

function extractHtmlTableRows(tableHtml: string, comments: string[]): HtmlTableRow[] {
  const rows: HtmlTableRow[] = [];
  // Similarly, nested <tr> structures are out of scope for this lightweight parser.
  // Not one in a comment, as for a table (see extractHtmlTables).
	const rowRegex = new RegExp('<!--(?:[\\s\\S]*?-->|[\\s\\S]*$)|<tr\\b(?:"[^"]*"|\'[^\']*\'|[^\'">])*?>(' + htmlContentUnit(2) + '*?)(?:<\\/tr>|' + HTML_REST_IN_COMMENT + ')|' + HTML_TAG, 'gi');
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    if (rowMatch[0].startsWith('<!--')) {
      comments.push(rowMatch[0]);
      continue;
    }
    if (rowMatch[1] === undefined) continue;
    const cells = extractHtmlTableCells(rowMatch[1] + (rowMatch[4] ?? ''), comments);
    // Invariant: rows with no cells are skipped.
    if (cells.length > 0) {
      rows.push({
        cells: cells.map(cell => ({
          runs: cell.runs,
          ...(cell.source ? { source: cell.source } : {}),
          ...(cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {}),
          ...(cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
          ...(cell.align ? { align: cell.align } : {}),
        })),
        header: cells.some(c => c.isHeader)
      });
    }
  }
  return rows;
}

function extractHtmlTableCells(rowHtml: string, comments: string[]): Array<HtmlTableCell & { isHeader: boolean }> {
  const cells: Array<HtmlTableCell & { isHeader: boolean }> = [];
  // Nested table-cell tags are not supported; this matches flat <th>/<td> content only.
  // Not one in a comment, as for a table (see extractHtmlTables).
	const cellRegex = new RegExp('<!--(?:[\\s\\S]*?-->|[\\s\\S]*$)|<(th|td)\\b((?:"[^"]*"|\'[^\']*\'|[^\'">])*)>(' + htmlContentUnit(4) + '*?)(?:<\\/\\1>|' + HTML_REST_IN_COMMENT + ')|' + HTML_TAG, 'gi');
  let cellMatch: RegExpExecArray | null;
  while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
    if (cellMatch[0].startsWith('<!--')) {
      comments.push(cellMatch[0]);
      continue;
    }
    if (cellMatch[1] === undefined) continue;
    const isHeader = cellMatch[1].toLowerCase() === 'th';
    const attrs = cellMatch[2];
    const runs = parseHtmlCellRuns(cellMatch[3] + (cellMatch[6] ?? ''));
    const colspan = parseInt(extractAttr(attrs, 'colspan') ?? '', 10) || undefined;
    const rowspan = parseInt(extractAttr(attrs, 'rowspan') ?? '', 10) || undefined;
    const kind = parseHtmlTableCellSourceKind(extractAttr(attrs, 'data-mm-kind'));
    const rawValueText = extractAttr(attrs, 'data-mm-raw');
    const rawValue = rawValueText !== undefined ? Number(rawValueText) : undefined;
    const sourceFormat = extractAttr(attrs, 'data-mm-format');
    // A text-align style, as markdown-it writes one, or else an align
    // attribute, which the style overrides in HTML: the last declaration,
    // as CSS reads it, but an !important one over the others
    const declarations = [...(extractAttr(attrs, 'style') ?? '').matchAll(/(?:^|;)\s*text-align\s*:\s*([^;!]*?)\s*(!\s*important\s*)?(?=;|$)/gi)];
    const declaration = declarations.filter(d => d[2]).pop() ?? declarations.pop();
    const alignMatch = declaration
      ? /^(left|center|right)$/i.exec(declaration[1])
      : /^\s*(left|center|right)\s*$/i.exec(extractAttr(attrs, 'align') ?? '');
    cells.push({
      runs,
      isHeader,
      ...(alignMatch ? { align: alignMatch[1].toLowerCase() as HtmlTableCell['align'] } : {}),
      ...(colspan && colspan > 1 ? { colspan } : {}),
      ...(rowspan && rowspan > 1 ? { rowspan } : {}),
      ...(kind ? { source: { kind, display: runs.map(run => run.text).join(''), ...(rawValue !== undefined && Number.isFinite(rawValue) ? { rawValue } : {}), ...(sourceFormat ? { sourceFormat } : {}) } } : {}),
    });
  }
  return cells;
}

function extractAttr(attrs: string, name: string): string | undefined {
  // Attribute by attribute, so a name is a whole one, not the end of
  // another's, as data-align's, nor in another's value
  for (const match of attrs.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    if (match[1].toLowerCase() !== name.toLowerCase()) continue;
    const value = match[2] ?? match[3] ?? match[4];
    return value === undefined ? undefined : decodeHtmlEntities(value);
  }
  return undefined;
}

/**
 * A cell's source text with its whitespace collapsed, as HTML lays it out.
 * A space or tab written as a character reference stays, since import
 * writes them for whitespace a cell would otherwise lose; a line break so
 * written is the end of a line like any other.
 */
function collapseHtmlWhitespace(rawText: string): string {
  return rawText.replace(/&#(?:0*1[03]|x0*[ad]);/gi, ' ').replace(/[ \t\r\n]+/g, ' ');
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
  // Whether the next text starts an <a>
  let linkStart = false;

  // Each <p> starts a paragraph of the cell, as does content before any <p>
  // or after a </p>. A paragraph run separates two of them, so an empty <p>
  // is an empty paragraph. Whitespace between paragraphs, or at the start of
  // one or of a line, is the HTML's layout.
  let paragraphs = 0;
  let paragraphClosed = false;
  let atParagraphStart = true;
  // A <br> at the end of a <p>, which stays, unlike one at the end of a cell
  const closedBreaks = new Set<HtmlTableRun>();
  // The last run that shows, before any comments after it, which don't
  const lastShown = () => {
    let k = runs.length - 1;
    while (k >= 0 && runs[k].type === 'html_comment') k--;
    return k;
  };
  const startParagraph = () => {
    if (paragraphs > 0) {
      const k = lastShown();
      const last = runs[k];
      if (last?.type === 'text' && !last.code) {
        last.text = last.text.replace(/[ \t\r\n]+$/, '');
        if (!last.text) runs.splice(k, 1);
      }
      runs.push({ type: 'paragraph', text: '\n\n' });
    }
    paragraphs++;
    paragraphClosed = false;
    atParagraphStart = true;
  };
  const startContent = () => {
    if (paragraphs === 0 || paragraphClosed) startParagraph();
    atParagraphStart = false;
  };
  const emitText = (rawText: string) => {
    let text = code ? rawText : collapseHtmlWhitespace(rawText);
    // Whitespace runs together with a space the text before ends with, as
    // HTML has it, past tags and comments, which show nothing
    const before = runs[lastShown()];
    if (!code && (paragraphClosed || atParagraphStart || before?.type === 'softbreak' || before?.type === 'text' && !before.code && before.text.endsWith(' '))) {
      text = text.replace(/^ /, '');
    }
    if (!text) return;
    startContent();
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
      ...(href && linkStart ? { linkStart: true as const } : {}),
    });
    linkStart = false;
  };

  // Tokenize the HTML into tags, comments, and text segments. A tag's
  // quoted attribute can hold a > or a <!--.
  const tagRegex = /<!--(?:[\s\S]*?-->|[\s\S]*$)|<(\/?)(\w+)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(cellHtml)) !== null) {
    // Emit any text before this tag
    if (match.index > lastIndex) emitText(cellHtml.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;

    // A comment, which the browser hides, as Word's export of it does. It
    // goes in the paragraph before it, or else the one after it, as it
    // starts none, which would show as an empty one.
    if (match[0].startsWith('<!--')) {
      runs.push({ type: 'html_comment', text: match[0] });
      continue;
    }
    const isClose = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attrs = match[3];

    if (tag === 'br') {
      startContent();
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
        const hrefMatch = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        href = hrefMatch ? decodeHtmlEntities(hrefMatch[1] ?? hrefMatch[2]) : undefined;
        linkStart = true;
      } else {
        href = undefined;
      }
    } else if (tag === 'p') {
      const last = runs[lastShown()];
      if (!isClose) startParagraph();
      else {
        if (last?.type === 'softbreak') closedBreaks.add(last);
        paragraphClosed = true;
      }
    }
  }

  // Emit any trailing text
  if (lastIndex < cellHtml.length) emitText(cellHtml.slice(lastIndex));

  // Trim leading/trailing whitespace from the run sequence. Runs hold the
  // source text until here, so whitespace written as a character reference,
  // such as &#9; or &nbsp;, neither collapses nor trims.
  if (runs.length > 0) {
    const k = runs.findIndex(run => run.type !== 'html_comment');
    const first = runs[k];
    if (first?.type === 'text' && !first.code) {
      first.text = first.text.replace(/^[ \t\r\n]+/, '');
      if (!first.text) runs.splice(k, 1);
    }
  }
  if (runs.length > 0) {
    const k = lastShown();
    const last = runs[k];
    if (last?.type === 'softbreak' && !closedBreaks.has(last)) runs.splice(k, 1);
    else if (last?.type === 'text' && !last.code) {
      last.text = last.text.replace(/[ \t\r\n]+$/, '');
      if (!last.text) runs.splice(k, 1);
    }
  }
  for (const run of runs) {
    if (run.type === 'text') run.text = decodeHtmlEntities(run.text);
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
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
