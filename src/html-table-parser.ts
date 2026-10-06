import { decodeHtmlAttribute, decodeHtmlCharacterReferences as decodeHtmlEntities } from './html-entities';
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
  href?: string; // the <a> a text run or line break is in
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
  start?: number;      // the table's offset in the HTML searched, from its <table
  end?: number;        // and past its </table>
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

// A comment: to its --> or --!>, at which the browser ends one too, or an
// empty one that the browser and markdown-it end sooner, <!--> or <!--->;
// or else, where none ends it, to the end
const HTML_COMMENT = '<!--(?:-?>|[\\s\\S]*?--!?>)';
const HTML_COMMENT_OR_REST = '<!--(?:-?>|[\\s\\S]*?--!?>|[\\s\\S]*$)';
// A tag's attributes, whose quoted values can hold a > or a <!--. A < out
// of quotes ends them, so that the search for a > from a < with none goes
// no further than the next <, and each < is looked past once.
const HTML_ATTRS = '(?:"[^"]*"|\'[^\']*\'|[^\'"<>])*';
// A tag: its name, and then its attributes, which start where it ends, so
// the search has one way to split them
const HTML_TAG_BODY = '\\/?[A-Za-z][^\\s/<>]*(?:[\\s/]' + HTML_ATTRS + ')?>';
const HTML_TAG = '<' + HTML_TAG_BODY;
// An element whose text the browser reads as no HTML, as a <script>'s, in
// which a <!-- or a </td> is text, to its end tag
const RAW_TEXT_NAME = '(?:script|style|textarea|title|xmp|iframe|noembed|noframes)';

// Its start tag, with its name a group of the search's
const RAW_TEXT_START = '<(' + RAW_TEXT_NAME + ')(?=[\\s/>])' + HTML_ATTRS + '>';

const COMMENT_AT = new RegExp(HTML_COMMENT, 'y');
const RAW_TEXT_AT = new RegExp(RAW_TEXT_START + '[\\s\\S]*?<\\/\\1\\s*>', 'iy');
const RAW_TEXT_START_AT = new RegExp(RAW_TEXT_START, 'iy');
const TAG_AT = new RegExp(HTML_TAG, 'y');

/** The piece of `html` at `at`, as the browser reads it: a comment, or an
 *  element whose text is no HTML, whole, to its end, so that a tag in it is
 *  none; a tag; or else text, to the next <, or a < that starts none. One
 *  with no end is `rest`, which runs to the end, past the end tag of what
 *  holds it, which the browser ends there. */
export function htmlPieceAt(html: string, at: number): { end: number; kind: 'comment' | 'raw' | 'tag' | 'text'; rest?: true } {
  if (html[at] !== '<') {
    const next = html.indexOf('<', at + 1);
    return { end: next === -1 ? html.length : next, kind: 'text' };
  }
  COMMENT_AT.lastIndex = at;
  if (COMMENT_AT.test(html)) return { end: COMMENT_AT.lastIndex, kind: 'comment' };
  if (html.startsWith('<!--', at)) return { end: html.length, kind: 'comment', rest: true };
  RAW_TEXT_AT.lastIndex = at;
  if (RAW_TEXT_AT.test(html)) return { end: RAW_TEXT_AT.lastIndex, kind: 'raw' };
  RAW_TEXT_START_AT.lastIndex = at;
  if (RAW_TEXT_START_AT.test(html)) return { end: html.length, kind: 'raw', rest: true };
  TAG_AT.lastIndex = at;
  if (TAG_AT.test(html)) return { end: TAG_AT.lastIndex, kind: 'tag' };
  return { end: at + 1, kind: 'text' };
}

/** The elements whose start tags `name` finds in `html`, past the pieces
 *  between them (see htmlPieceAt), with the comments among those in
 *  `comments`: each one's name, attributes and content, to its end tag, or
 *  else to the end, where a piece in it with no end runs to it, and where
 *  it starts and ends. One with neither is none. A search for the end goes
 *  piece by piece, so its cost is the content's length, and one that found
 *  none past a point finds none past a later one. */
function htmlElements(html: string, name: RegExp, comments?: string[]): Array<{ name: string; attrs: string; content: string; start: number; end: number }> {
  const elements: Array<{ name: string; attrs: string; content: string; start: number; end: number }> = [];
  // Where a search for each end tag found none from
  const noEndFrom = new Map<string, number>();
  for (let at = 0; at < html.length;) {
    const start = at;
    const piece = htmlPieceAt(html, at);
    at = piece.end;
    if (piece.kind === 'comment') comments?.push(html.slice(start, at));
    const tag = piece.kind === 'tag' ? name.exec(html.slice(start, at)) : null;
    if (!tag || at >= (noEndFrom.get(tag[1].toLowerCase()) ?? Infinity)) continue;
    const endTag = '</' + tag[1].toLowerCase() + '>';
    for (let k = at; k < html.length;) {
      const inner = htmlPieceAt(html, k);
      if (inner.rest || inner.kind === 'tag' && html.slice(k, inner.end).toLowerCase() === endTag) {
        elements.push({ name: tag[1], attrs: html.slice(start + 1 + tag[1].length, at - 1), content: html.slice(at, inner.rest ? html.length : k), start, end: inner.end });
        at = inner.end;
        break;
      }
      k = inner.end;
    }
    if (elements[elements.length - 1]?.start !== start) noEndFrom.set(tag[1].toLowerCase(), at);
  }
  return elements;
}

export function extractHtmlTables(html: string): HtmlTableMeta[] {
  const tables: HtmlTableMeta[] = [];
  // Regex-based extraction intentionally does not support nested <table> blocks.
  // This parser targets simple manuscript tables (<table>/<tr>/<th>/<td>).
  // Not one in a comment, which the browser and Word's export of it hide,
  // nor in an element whose text is no HTML, as a <script>, nor a quoted
  // attribute, and no </table> in one of them ends one (see htmlElements).
  for (const table of htmlElements(html, /^<(table)(?=[\s/>])/i)) {
    const attrs = table.attrs;
    const comments: string[] = [];
    const rows = extractHtmlTableRows(table.content, comments);
    // Invariant: only tables with rows are returned to callers, or with
    // comments that hide all of them, which a caller can't drop unseen.
    if (rows.length > 0 || comments.length > 0) {
      const meta: HtmlTableMeta = { rows, start: table.start, end: table.end };
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
        const normalized = decodeHtmlAttribute(fontVal).trim().replace(/\s+/g, ' ');
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
  for (const row of htmlElements(tableHtml, /^<(tr)(?=[\s/>])/i, comments)) {
    const cells = extractHtmlTableCells(row.content, comments);
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
  for (const cell of htmlElements(rowHtml, /^<(th|td)(?=[\s/>])/i, comments)) {
    const isHeader = cell.name.toLowerCase() === 'th';
    const attrs = cell.attrs;
    const runs = parseHtmlCellRuns(cell.content);
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
    return value === undefined ? undefined : decodeHtmlAttribute(value);
  }
  return undefined;
}

/**
 * A cell's source text with its whitespace collapsed, as HTML lays it out.
 * A space or tab written as a character reference stays, since import
 * writes them for whitespace a cell would otherwise lose; a line break so
 * written is the end of a line like any other, however it's written, as
 * &#10;, &#xA, without its ;, as the browser reads one, or &NewLine;.
 */
function collapseHtmlWhitespace(rawText: string): string {
  return rawText.replace(/&#(?:0*1[03](?![0-9])|[xX]0*[aAdD](?![0-9a-fA-F]));?|&NewLine;/g, ' ').replace(/[ \t\r\n]+/g, ' ');
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
  // The index of the last run that shows, before any comments after it,
  // which don't, kept as each run is added, as a cell can hold many comments
  let shown = -1;
  const pushRun = (run: HtmlTableRun) => {
    runs.push(run);
    if (run.type !== 'html_comment') shown = runs.length - 1;
  };
  const startParagraph = () => {
    if (paragraphs > 0) {
      const last = runs[shown];
      if (last?.type === 'text' && !last.code) {
        last.text = last.text.replace(/[ \t\r\n]+$/, '');
        if (!last.text) runs.splice(shown, 1);
      }
      pushRun({ type: 'paragraph', text: '\n\n' });
    }
    paragraphs++;
    paragraphClosed = false;
    atParagraphStart = true;
  };
  const startContent = () => {
    if (paragraphs === 0 || paragraphClosed) startParagraph();
    atParagraphStart = false;
  };
  const formatting = (): Partial<HtmlTableRun> => ({
    ...(bold ? { bold } : {}),
    ...(italic ? { italic } : {}),
    ...(underline ? { underline } : {}),
    ...(strikethrough ? { strikethrough } : {}),
    ...(code ? { code } : {}),
    ...(superscript ? { superscript } : {}),
    ...(subscript ? { subscript } : {}),
  });
  const emitText = (rawText: string) => {
    let text = code ? rawText : collapseHtmlWhitespace(rawText);
    // Whitespace runs together with a space the text before ends with, as
    // HTML has it, past tags and comments, which show nothing
    const before = runs[shown];
    if (!code && (paragraphClosed || atParagraphStart || before?.type === 'softbreak' || before?.type === 'text' && !before.code && before.text.endsWith(' '))) {
      text = text.replace(/^ /, '');
    }
    if (!text) return;
    startContent();
    pushRun({
      type: 'text', text,
      ...formatting(),
      ...(href ? { href } : {}),
      ...(href && linkStart ? { linkStart: true as const } : {}),
    });
    linkStart = false;
  };

  // Tokenize the HTML into tags, comments, and text segments. A tag's
  // quoted attribute can hold a > or a <!--. An element whose text is no
  // HTML, as a <script>, is text, as its tags were, and a <!-- in it too.
  const tagRegex = new RegExp(HTML_COMMENT_OR_REST + '|' + RAW_TEXT_START + '([\\s\\S]*?)(?:<\\/\\1\\s*>|$)|<(\\/?)(\\w+)\\b(' + HTML_ATTRS + ')>', 'gi');
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
      pushRun({ type: 'html_comment', text: match[0] });
      continue;
    }
    if (match[1] !== undefined) {
      emitText(match[2]);
      continue;
    }
    const isClose = match[3] === '/';
    const tag = match[4].toLowerCase();
    const attrs = match[5];

    if (tag === 'br') {
      startContent();
      // In the formatting around it, as text, which Word shows on it, as an
      // underline, as export reads a line break in Markdown, and in an <a>,
      // the link's, as Word's hyperlink holds it
      pushRun({ type: 'softbreak', text: '\n', ...formatting(), ...(href ? { href } : {}), ...(href && linkStart ? { linkStart: true as const } : {}) });
      linkStart = false;
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
        href = hrefMatch ? decodeHtmlAttribute(hrefMatch[1] ?? hrefMatch[2]) : undefined;
        linkStart = true;
      } else {
        href = undefined;
      }
    } else if (tag === 'p') {
      const last = runs[shown];
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
    let k = runs.length - 1;
    while (k >= 0 && runs[k].type === 'html_comment') k--;
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
