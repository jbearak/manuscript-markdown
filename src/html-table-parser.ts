import { groupCitationUsages } from './citation-scanner';
import type { CitationOccurrenceMetadata } from './citekey';
import { decodeNumericHtmlEntity } from './html-entities';
import { isGfmDisallowedRawHtmlTagName } from './gfm';
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
  type: 'text' | 'softbreak' | 'hardbreak' | 'citation';
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  href?: string;
  keys?: string[];
  locators?: Map<string, string>;
  suppressAuthorKeys?: Set<string>;
  citationItems?: CitationOccurrenceMetadata[];
  narrative?: boolean;
  /** Visible characters that must stay literal when rendered back to Markdown. */
  literalCharacters?: HtmlTableLiteralCharacter[];
}

export interface HtmlTableLiteralCharacter {
  offset: number;
  value: '@' | '<' | '>';
}

export interface HtmlTableCell {
  runs: HtmlTableRun[];
  colspan?: number;
  rowspan?: number;
  source?: HtmlTableCellSource;
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

interface HtmlCommentToken {
  kind: 'comment';
  start: number;
  end: number;
}

interface HtmlTagToken {
  kind: 'tag';
  start: number;
  end: number;
  name: string;
  closing: boolean;
  attrs: string;
  selfClosing: boolean;
}

type HtmlMarkupToken = HtmlCommentToken | HtmlTagToken;

interface HtmlElementRange {
  open: HtmlTagToken;
  close: HtmlTagToken;
}

interface ParsedHtmlTable {
  start: number;
  end: number;
  meta: HtmlTableMeta;
}

export interface HtmlTableRange {
  start: number;
  end: number;
}

function parseHtmlTagAt(html: string, start: number): HtmlTagToken | undefined {
  if (html[start] !== '<') return undefined;
  let cursor = start + 1;
  let closing = false;
  if (html[cursor] === '/') {
    closing = true;
    cursor++;
  }
  const nameStart = cursor;
  if (!/[A-Za-z]/.test(html[cursor] ?? '')) return undefined;
  cursor++;
  while (/[A-Za-z0-9:-]/.test(html[cursor] ?? '')) cursor++;
  if (!/[\s/>]/.test(html[cursor] ?? '')) return undefined;
  const name = html.slice(nameStart, cursor).toLowerCase();
  const attrsStart = cursor;
  let quote: '"' | "'" | undefined;
  while (cursor < html.length) {
    const char = html[cursor];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '<') {
      // A new opener before this candidate closes makes the candidate malformed.
      return undefined;
    } else if (char === '>') {
      const attrs = html.slice(attrsStart, cursor);
      return {
        kind: 'tag',
        start,
        end: cursor + 1,
        name,
        closing,
        attrs,
        selfClosing: !closing && /\/\s*$/.test(attrs),
      };
    }
    cursor++;
  }
  return undefined;
}

/**
 * Tokenize structural HTML while honoring comment and raw-text boundaries.
 * Script/style content is text until a syntactically valid matching end tag;
 * tag-like content inside it never changes structural depth.
 */
function tokenizeStructuralHtml(html: string): HtmlMarkupToken[] {
  const tokens: HtmlMarkupToken[] = [];
  let rawTextElement: string | undefined;
  let offset = 0;
  while (offset < html.length) {
    const start = html.indexOf('<', offset);
    if (start < 0) break;

    if (rawTextElement) {
      const tag = parseHtmlTagAt(html, start);
      if (tag?.closing && tag.name === rawTextElement) {
        tokens.push(tag);
        rawTextElement = undefined;
        offset = tag.end;
      } else {
        offset = start + 1;
      }
      continue;
    }

    if (html.startsWith('<!--', start)) {
      const close = html.indexOf('-->', start + 4);
      const end = close < 0 ? html.length : close + 3;
      tokens.push({ kind: 'comment', start, end });
      offset = end;
      continue;
    }

    const tag = parseHtmlTagAt(html, start);
    if (!tag) {
      offset = start + 1;
      continue;
    }
    tokens.push(tag);
    if (!tag.closing && isGfmDisallowedRawHtmlTagName(tag.name)) {
      // The self-closing flag is ignored for non-void raw-text elements.
      rawTextElement = tag.name;
    }
    offset = tag.end;
  }
  return tokens;
}

function findMatchedElements(
  tokens: readonly HtmlMarkupToken[],
  names: ReadonlySet<string>,
  start: number,
  end: number,
  barrierNames: ReadonlySet<string> = new Set(),
): HtmlElementRange[] {
  const elements: HtmlElementRange[] = [];
  const stack: HtmlTagToken[] = [];
  let barrierDepth = 0;
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (tokens[middle].start < start) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.start >= end) break;
    if (token.kind !== 'tag' || token.end > end) continue;
    if (barrierNames.has(token.name)) {
      if (token.closing) barrierDepth = Math.max(0, barrierDepth - 1);
      else barrierDepth++;
      continue;
    }
    if (barrierDepth > 0 || !names.has(token.name)) continue;
    if (!token.closing) {
      stack.push(token);
      continue;
    }
    const open = stack[stack.length - 1];
    if (!open || open.name !== token.name) continue;
    stack.pop();
    if (stack.length === 0) elements.push({ open, close: token });
  }
  return elements;
}

function parseTableMeta(
  html: string,
  tokens: readonly HtmlMarkupToken[],
  element: HtmlElementRange,
): HtmlTableMeta | undefined {
  const attrs = element.open.attrs;
  const embedIdxMatch = attrs.match(/data-embed-idx\s*=\s*["']?(\d+)["']?/i);
  const embedIdx = embedIdxMatch ? parseInt(embedIdxMatch[1], 10) : undefined;
  const rows = extractHtmlTableRows(
    html,
    tokens,
    element.open.end,
    element.close.start,
    embedIdx !== undefined && Number.isFinite(embedIdx),
  );
  // Invariant: only non-empty row sets are returned to callers.
  if (rows.length === 0) return undefined;

  const meta: HtmlTableMeta = { rows };
  const fontSizeMatch = attrs.match(/data-font-size\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
  if (fontSizeMatch) {
    const n = parseFloat(fontSizeMatch[1]);
    if (isFinite(n) && n > 0) meta.fontSize = n;
  }
  // Separate quote branches preserve apostrophes inside double-quoted values.
  const fontMatch = attrs.match(/data-font\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"]+))/i);
  const fontVal = fontMatch ? (fontMatch[1] ?? fontMatch[2] ?? fontMatch[3]) : undefined;
  if (fontVal) {
    const normalized = decodeHtmlEntities(fontVal).trim().replace(/\s+/g, ' ');
    if (normalized) meta.font = normalized;
  }
  const orientMatch = attrs.match(/data-orientation\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"]+))/i);
  const orientVal = (orientMatch?.[1] ?? orientMatch?.[2] ?? orientMatch?.[3])?.trim().toLowerCase();
  if (orientVal === 'landscape' || orientVal === 'portrait') meta.orientation = orientVal;
  const colWidthsMatch = attrs.match(/data-col-widths\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"]+))/i);
  const colWidthsVal = (colWidthsMatch?.[1] ?? colWidthsMatch?.[2] ?? colWidthsMatch?.[3])?.trim();
  if (colWidthsVal) {
    const parsed = parseColWidthsAttr(colWidthsVal);
    if (parsed) meta.colWidths = parsed;
  }
  if (embedIdx !== undefined && Number.isFinite(embedIdx)) meta.embedIdx = embedIdx;
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
  return meta;
}

function parseHtmlTables(html: string): ParsedHtmlTable[] {
  const tokens = tokenizeStructuralHtml(html);
  const tableElements = findMatchedElements(tokens, new Set(['table']), 0, html.length);
  return tableElements.flatMap(element => {
    const meta = parseTableMeta(html, tokens, element);
    return meta ? [{ start: element.open.start, end: element.close.end, meta }] : [];
  });
}

export function extractHtmlTables(html: string): HtmlTableMeta[] {
  return parseHtmlTables(html).map(table => table.meta);
}

export function extractHtmlTableRanges(html: string): HtmlTableRange[] {
  return parseHtmlTables(html).map(table => ({ start: table.start, end: table.end }));
}

/** Parse a selection only when its complete non-whitespace content is one table. */
export function extractStandaloneHtmlTable(html: string): HtmlTableMeta | undefined {
  const tables = parseHtmlTables(html);
  if (tables.length !== 1) return undefined;
  const table = tables[0];
  if (html.slice(0, table.start).trim() || html.slice(table.end).trim()) return undefined;
  return table.meta;
}

function extractHtmlTableRows(
  html: string,
  tokens: readonly HtmlMarkupToken[],
  start: number,
  end: number,
  citationsInert: boolean,
): HtmlTableRow[] {
  const rows: HtmlTableRow[] = [];
  const rowElements = findMatchedElements(
    tokens,
    new Set(['tr']),
    start,
    end,
    new Set(['table']),
  );
  for (const row of rowElements) {
    const cells = extractHtmlTableCells(
      html,
      tokens,
      row.open.end,
      row.close.start,
      citationsInert,
    );
    if (cells.length === 0) continue;
    rows.push({
      cells: cells.map(cell => ({
        runs: cell.runs,
        ...(cell.source ? { source: cell.source } : {}),
        ...(cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {}),
        ...(cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
      })),
      header: cells.some(cell => cell.isHeader),
    });
  }
  return rows;
}

function extractHtmlTableCells(
  html: string,
  tokens: readonly HtmlMarkupToken[],
  start: number,
  end: number,
  citationsInert: boolean,
): Array<{ runs: HtmlTableRun[]; isHeader: boolean; colspan?: number; rowspan?: number; source?: HtmlTableCellSource }> {
  const cells: Array<{ runs: HtmlTableRun[]; isHeader: boolean; colspan?: number; rowspan?: number; source?: HtmlTableCellSource }> = [];
  const cellElements = findMatchedElements(
    tokens,
    new Set(['th', 'td']),
    start,
    end,
    new Set(['table', 'tr']),
  );
  for (const cell of cellElements) {
    const isHeader = cell.open.name === 'th';
    const attrs = cell.open.attrs;
    const cellHtml = html.slice(cell.open.end, cell.close.start);
    const { runs, display } = parseHtmlCellRuns(cellHtml, citationsInert);
    const colspanMatch = attrs.match(/colspan\s*=\s*["']?(\d+)/i);
    const rowspanMatch = attrs.match(/rowspan\s*=\s*["']?(\d+)/i);
    const colspan = colspanMatch ? parseInt(colspanMatch[1], 10) : undefined;
    const rowspan = rowspanMatch ? parseInt(rowspanMatch[1], 10) : undefined;
    const kind = parseHtmlTableCellSourceKind(extractAttr(attrs, 'data-mm-kind'));
    const rawValueText = extractAttr(attrs, 'data-mm-raw');
    const rawValue = rawValueText !== undefined ? Number(rawValueText) : undefined;
    const sourceFormat = extractAttr(attrs, 'data-mm-format');
    cells.push({
      runs,
      isHeader,
      ...(colspan && colspan > 1 ? { colspan } : {}),
      ...(rowspan && rowspan > 1 ? { rowspan } : {}),
      ...(kind ? { source: { kind, display, ...(rawValue !== undefined && Number.isFinite(rawValue) ? { rawValue } : {}), ...(sourceFormat ? { sourceFormat } : {}) } } : {}),
    });
  }
  return cells;
}

function extractAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  const value = match ? match[1] ?? match[2] ?? match[3] : undefined;
  return value === undefined ? undefined : decodeHtmlEntities(value);
}

type EntityDerivedCharacter = '@' | '<' | '>';

interface HtmlCitationProjection {
  text: string;
  scannerText: string;
  rawStarts: number[];
  rawEnds: number[];
  entityDerived: Array<EntityDerivedCharacter | undefined>;
  preserveWhitespace: boolean[];
  literalAt: boolean[];
  literalAngles: boolean[];
  inertRanges: Array<{ start: number; end: number }>;
  markupTokens: HtmlMarkupToken[];
}

interface ProjectedHtmlSource {
  text: string;
  literalCharacters: HtmlTableLiteralCharacter[];
}

function matchHtmlEntityAt(text: string, offset: number): string | undefined {
  return text.slice(offset).match(
    /^&(?:#\d+|#x[0-9a-fA-F]+|nbsp|lt|gt|quot|apos|amp);/,
  )?.[0];
}

function scannerTextForEntity(value: string): string {
  // These are masks only; source offsets and entity provenance live in parallel
  // arrays, so an authored occurrence of the same character is never rewritten.
  if (value === '@') return '§';
  if (value === '<') return '‹';
  if (value === '>') return '›';
  return value;
}

function htmlCitationProjection(
  cellHtml: string,
  citationsInert: boolean,
): HtmlCitationProjection {
  const text: string[] = [];
  const scannerText: string[] = [];
  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  const entityDerived: Array<EntityDerivedCharacter | undefined> = [];
  const preserveWhitespace: boolean[] = [];
  const inertFlags: boolean[] = [];
  const literalAtFlags: boolean[] = [];
  const literalAngleFlags: boolean[] = [];
  const markupTokens = tokenizeStructuralHtml(cellHtml);
  let rawTextElement: string | undefined;
  let codeDepth = 0;
  let offset = 0;

  const append = (
    visible: string,
    rawStart: number,
    rawEnd: number,
    inert: boolean,
    preserve: boolean,
    literalAt: boolean,
    entity?: EntityDerivedCharacter,
  ) => {
    const scannerVisible = entity ? scannerTextForEntity(visible) : visible;
    for (let i = 0; i < visible.length; i++) {
      text.push(visible[i]);
      scannerText.push(scannerVisible[i]);
      rawStarts.push(rawStart);
      rawEnds.push(rawEnd);
      entityDerived.push(entity);
      preserveWhitespace.push(preserve);
      inertFlags.push(citationsInert || inert);
      literalAtFlags.push(citationsInert || literalAt);
      literalAngleFlags.push(literalAt);
    }
  };
  const appendText = (
    start: number,
    end: number,
    inert: boolean,
    preserve: boolean,
    literalAt: boolean,
  ) => {
    for (let cursor = start; cursor < end;) {
      if (cellHtml[cursor] === '&') {
        const entity = matchHtmlEntityAt(cellHtml, cursor);
        if (entity) {
          const rawEnd = cursor + entity.length;
          const decoded = decodeHtmlEntities(entity);
          const derived = decoded === '@' || decoded === '<' || decoded === '>'
            ? decoded
            : undefined;
          append(decoded, cursor, rawEnd, inert, preserve, literalAt, derived);
          cursor = rawEnd;
          continue;
        }
      }
      append(cellHtml[cursor], cursor, cursor + 1, inert, preserve, literalAt);
      cursor++;
    }
  };

  for (const token of markupTokens) {
    const inRawText = rawTextElement !== undefined;
    const inert = inRawText || codeDepth > 0;
    appendText(offset, token.start, inert, inert, inRawText);
    if (token.kind === 'comment') {
      offset = token.end;
      continue;
    }

    const currentlyInert = rawTextElement !== undefined || codeDepth > 0;
    if (token.name === 'br' || (token.name === 'p' && token.closing)) {
      append('\n', token.start, token.end, currentlyInert, false, false);
    }
    if (token.name === 'code') {
      // A slash on a non-void element is ignored by HTML; <code/> stays open.
      if (token.closing) codeDepth = Math.max(0, codeDepth - 1);
      else codeDepth++;
    }
    if (isGfmDisallowedRawHtmlTagName(token.name)) {
      if (token.closing && rawTextElement === token.name) rawTextElement = undefined;
      else if (!token.closing) rawTextElement = token.name;
    }
    offset = token.end;
  }
  const inRawText = rawTextElement !== undefined;
  const inert = inRawText || codeDepth > 0;
  appendText(offset, cellHtml.length, inert, inert, inRawText);

  const inertRanges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < inertFlags.length;) {
    if (!inertFlags[start]) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < inertFlags.length && inertFlags[end]) end++;
    inertRanges.push({ start, end });
    start = end;
  }

  return {
    text: text.join(''),
    scannerText: scannerText.join(''),
    rawStarts,
    rawEnds,
    entityDerived,
    preserveWhitespace,
    literalAt: literalAtFlags,
    literalAngles: literalAngleFlags,
    inertRanges,
    markupTokens,
  };
}

function sourceForHtmlProjectionRange(
  cellHtml: string,
  projection: HtmlCitationProjection,
  start: number,
  end: number,
): ProjectedHtmlSource {
  let text = '';
  const literalCharacters: HtmlTableLiteralCharacter[] = [];
  for (let offset = start; offset < end;) {
    const rawStart = projection.rawStarts[offset];
    const rawEnd = projection.rawEnds[offset];
    if (rawStart === undefined || rawEnd === undefined) {
      offset++;
      continue;
    }
    let next = offset + 1;
    while (
      next < end
      && projection.rawStarts[next] === rawStart
      && projection.rawEnds[next] === rawEnd
    ) next++;
    const raw = cellHtml.slice(rawStart, rawEnd);
    const visible = raw.startsWith('&')
      ? decodeHtmlEntities(raw)
      : projection.text.slice(offset, next);
    for (let index = 0; index < visible.length; index++) {
      const projectedOffset = Math.min(offset + index, next - 1);
      const derived = projection.entityDerived[projectedOffset];
      if (derived) {
        literalCharacters.push({ offset: text.length + index, value: derived });
      } else if (
        (visible[index] === '<' || visible[index] === '>')
        && projection.literalAngles[projectedOffset]
      ) {
        literalCharacters.push({
          offset: text.length + index,
          value: visible[index] as '<' | '>',
        });
      } else if (
        visible[index] === '@'
        && projection.literalAt[projectedOffset]
      ) {
        literalCharacters.push({ offset: text.length + index, value: '@' });
      }
    }
    text += visible;
    offset = next;
  }
  return { text, literalCharacters };
}

function sourceForRawHtmlRange(
  cellHtml: string,
  projection: HtmlCitationProjection,
  start: number,
  end: number,
): ProjectedHtmlSource {
  const projectedOffset = (rawOffset: number): number => {
    let low = 0;
    let high = projection.rawStarts.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (projection.rawStarts[middle] < rawOffset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return sourceForHtmlProjectionRange(
    cellHtml,
    projection,
    projectedOffset(start),
    projectedOffset(end),
  );
}

function displayForHtmlProjection(projection: HtmlCitationProjection): string {
  let display = '';
  let pendingSpace = false;
  for (let offset = 0; offset < projection.text.length; offset++) {
    const char = projection.text[offset];
    if (projection.preserveWhitespace[offset]) {
      if (pendingSpace && display) display += ' ';
      pendingSpace = false;
      display += char;
    } else if (/[ \t\r\n]/.test(char)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && display) display += ' ';
      pendingSpace = false;
      display += char;
    }
  }
  return display;
}

function normalizeProjectedWhitespace(source: ProjectedHtmlSource): ProjectedHtmlSource {
  let text = '';
  const literalCharacters: HtmlTableLiteralCharacter[] = [];
  const literalByOffset = new Map(source.literalCharacters.map(item => [item.offset, item.value]));
  for (let offset = 0; offset < source.text.length;) {
    if (/[ \t\r\n]/.test(source.text[offset])) {
      text += ' ';
      do offset++; while (offset < source.text.length && /[ \t\r\n]/.test(source.text[offset]));
      continue;
    }
    const literal = literalByOffset.get(offset);
    if (literal) literalCharacters.push({ offset: text.length, value: literal });
    text += source.text[offset];
    offset++;
  }
  return { text, literalCharacters };
}

function parseHtmlCellRuns(
  cellHtml: string,
  citationsInert = false,
): {
  runs: HtmlTableRun[];
  display: string;
} {
  const runs: HtmlTableRun[] = [];
  const depths = {
    bold: 0,
    italic: 0,
    underline: 0,
    strikethrough: 0,
    code: 0,
    superscript: 0,
    subscript: 0,
  };
  const hrefStack: Array<string | undefined> = [];

  const projection = htmlCitationProjection(cellHtml, citationsInert);
  const display = displayForHtmlProjection(projection);
  const visibleGroups = projection.scannerText.includes('@')
    ? groupCitationUsages(projection.scannerText)
    : [];
  const citationGroups: Array<
    ReturnType<typeof groupCitationUsages>[number]
    & { projectedStart: number; projectedEnd: number }
  > = [];
  const hasContiguousCitationSource = (
    usage: ReturnType<typeof groupCitationUsages>[number]['usages'][number],
  ): boolean => {
    let previousEnd = projection.rawEnds[usage.atStart];
    if (previousEnd === undefined) return false;
    let validationEnd = usage.keyEnd;
    if (
      usage.key.endsWith('--')
      && projection.scannerText[usage.keyEnd] === '}'
    ) {
      // Removed tags must not manufacture CriticMarkup adjacency.
      validationEnd++;
    }
    for (let offset = usage.atStart + 1; offset < validationEnd; offset++) {
      if (projection.rawStarts[offset] !== previousEnd) return false;
      previousEnd = projection.rawEnds[offset];
      if (previousEnd === undefined) return false;
    }
    return true;
  };
  let inertRangeIndex = 0;
  for (const group of visibleGroups) {
    if (!group.usages.every(hasContiguousCitationSource)) continue;
    while (
      inertRangeIndex < projection.inertRanges.length
      && projection.inertRanges[inertRangeIndex].end <= group.start
    ) inertRangeIndex++;
    const inertRange = projection.inertRanges[inertRangeIndex];
    if (inertRange && group.start < inertRange.end && group.end > inertRange.start) continue;
    const rawStart = projection.rawStarts[group.start];
    const rawEnd = projection.rawEnds[group.end - 1];
    if (rawStart === undefined || rawEnd === undefined) continue;
    citationGroups.push({
      ...group,
      start: rawStart,
      end: rawEnd,
      projectedStart: group.start,
      projectedEnd: group.end,
    });
  }
  let citationIndex = 0;

  const runFormatting = () => ({
    ...(depths.bold > 0 ? { bold: true } : {}),
    ...(depths.italic > 0 ? { italic: true } : {}),
    ...(depths.underline > 0 ? { underline: true } : {}),
    ...(depths.strikethrough > 0 ? { strikethrough: true } : {}),
    ...(depths.code > 0 ? { code: true } : {}),
    ...(depths.superscript > 0 ? { superscript: true } : {}),
    ...(depths.subscript > 0 ? { subscript: true } : {}),
    ...(hrefStack[hrefStack.length - 1] ? { href: hrefStack[hrefStack.length - 1] } : {}),
  });
  const adjustDepth = (key: keyof typeof depths, closing: boolean) => {
    depths[key] = closing ? Math.max(0, depths[key] - 1) : depths[key] + 1;
  };
  const applyTag = (token: HtmlTagToken, emitBreaks: boolean) => {
    const { closing, name, attrs } = token;
    if (name === 'br') {
      if (emitBreaks) runs.push({ type: 'softbreak', text: '\n' });
    } else if (name === 'b' || name === 'strong') {
      adjustDepth('bold', closing);
    } else if (name === 'i' || name === 'em') {
      adjustDepth('italic', closing);
    } else if (name === 'u') {
      adjustDepth('underline', closing);
    } else if (name === 's' || name === 'del' || name === 'strike') {
      adjustDepth('strikethrough', closing);
    } else if (name === 'code') {
      // Non-void elements ignore self-closing syntax, including <code/>.
      adjustDepth('code', closing);
    } else if (name === 'sup') {
      adjustDepth('superscript', closing);
    } else if (name === 'sub') {
      adjustDepth('subscript', closing);
    } else if (name === 'a') {
      if (!closing) {
        const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
        hrefStack.push(hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : undefined);
      } else if (hrefStack.length > 0) {
        hrefStack.pop();
      }
    } else if (name === 'p' && closing && emitBreaks) {
      runs.push({ type: 'softbreak', text: '\n' });
    }
  };

  let citationTagIndex = 0;
  const applyTagsInsideCitation = (start: number, end: number) => {
    while (
      citationTagIndex < projection.markupTokens.length
      && projection.markupTokens[citationTagIndex].end <= start
    ) citationTagIndex++;
    while (
      citationTagIndex < projection.markupTokens.length
      && projection.markupTokens[citationTagIndex].start < end
    ) {
      const token = projection.markupTokens[citationTagIndex];
      if (token.kind === 'tag') applyTag(token, false);
      citationTagIndex++;
    }
  };
  const locatorSource = (
    group: typeof citationGroups[number],
    itemIndex: number,
  ): ProjectedHtmlSource | undefined => {
    const item = group.items[itemIndex];
    const usage = group.usages[itemIndex];
    if (!item?.locator || !usage) return undefined;
    const limit = group.usages[itemIndex + 1]?.atStart ?? group.projectedEnd - 1;
    const start = projection.scannerText.indexOf(item.locator, usage.keyEnd);
    if (start < usage.keyEnd || start + item.locator.length > limit) return undefined;
    return sourceForHtmlProjectionRange(
      cellHtml,
      projection,
      start,
      start + item.locator.length,
    );
  };
  const emitPlainText = (start: number, end: number) => {
    if (end <= start) return;
    let source = sourceForRawHtmlRange(cellHtml, projection, start, end);
    if (depths.code === 0) source = normalizeProjectedWhitespace(source);
    if (!source.text) return;
    runs.push({
      type: 'text',
      text: source.text,
      ...(source.literalCharacters.length > 0
        ? { literalCharacters: source.literalCharacters }
        : {}),
      ...runFormatting(),
    });
  };
  const emitContent = (start: number, end: number) => {
    let cursor = start;
    while (
      citationIndex < citationGroups.length
      && citationGroups[citationIndex].end <= start
    ) citationIndex++;
    while (citationIndex < citationGroups.length) {
      const group = citationGroups[citationIndex];
      if (group.start >= end) break;
      emitPlainText(cursor, group.start);
      const locators = new Map<string, string>();
      const suppressAuthorKeys = new Set<string>();
      const itemSources = group.items.map((_item, index) => locatorSource(group, index));
      group.items.forEach((item, index) => {
        const locator = itemSources[index]?.text;
        if (locator !== undefined) locators.set(item.key, locator);
        if (item.suppressAuthor) suppressAuthorKeys.add(item.key);
      });
      const suppressed = group.form === 'bracket'
        && group.items[0]?.suppressAuthor === true;
      const contentStart = group.form === 'bare'
        ? group.projectedStart + 1
        : group.projectedStart + (suppressed ? 3 : 2);
      const contentEnd = group.form === 'bare'
        ? group.projectedEnd
        : group.projectedEnd - 1;
      const content = sourceForHtmlProjectionRange(
        cellHtml,
        projection,
        contentStart,
        contentEnd,
      );
      const prefix = suppressed ? '-@' : '';
      const literalCharacters = content.literalCharacters.map(item => ({
        offset: item.offset + prefix.length,
        value: item.value,
      }));
      const keys = group.usages.map(usage => usage.key);
      const citationItems = new Set(keys).size < keys.length
        ? group.items.map((item, index) => ({
            key: item.key,
            suppressAuthor: item.suppressAuthor,
            ...(itemSources[index] ? { locator: itemSources[index]!.text } : {}),
          }))
        : undefined;
      runs.push({
        type: 'citation',
        text: prefix + content.text,
        keys,
        ...(locators.size > 0 ? { locators } : {}),
        ...(suppressAuthorKeys.size > 0 ? { suppressAuthorKeys } : {}),
        ...(citationItems ? { citationItems } : {}),
        ...(group.form === 'bare' ? { narrative: true } : {}),
        ...(literalCharacters.length > 0 ? { literalCharacters } : {}),
        ...runFormatting(),
      });
      applyTagsInsideCitation(group.start, group.end);
      cursor = group.end;
      citationIndex++;
    }
    emitPlainText(cursor, end);
  };

  // Markup inside one citation is applied after its atomic run is emitted.
  let lastIndex = 0;
  let tagCitationIndex = 0;
  for (const token of projection.markupTokens) {
    while (
      tagCitationIndex < citationGroups.length
      && citationGroups[tagCitationIndex].end <= token.start
    ) tagCitationIndex++;
    const citation = citationGroups[tagCitationIndex];
    if (citation && token.start >= citation.start && token.end <= citation.end) continue;

    emitContent(lastIndex, token.start);
    lastIndex = token.end;
    if (token.kind === 'tag') applyTag(token, true);
  }
  emitContent(lastIndex, cellHtml.length);

  const trimStart = (run: HtmlTableRun) => {
    const count = run.text.length - run.text.trimStart().length;
    if (count === 0) return;
    run.text = run.text.slice(count);
    if (run.literalCharacters) {
      run.literalCharacters = run.literalCharacters
        .filter(item => item.offset >= count)
        .map(item => ({ ...item, offset: item.offset - count }));
      if (run.literalCharacters.length === 0) delete run.literalCharacters;
    }
  };
  const trimEnd = (run: HtmlTableRun) => {
    const length = run.text.trimEnd().length;
    if (length === run.text.length) return;
    run.text = run.text.slice(0, length);
    if (run.literalCharacters) {
      run.literalCharacters = run.literalCharacters.filter(item => item.offset < length);
      if (run.literalCharacters.length === 0) delete run.literalCharacters;
    }
  };

  if (runs.length > 0) {
    const first = runs[0];
    if (first.type === 'text' && !first.code) {
      trimStart(first);
      if (!first.text) runs.shift();
    }
  }
  if (runs.length > 0) {
    const last = runs[runs.length - 1];
    if (last.type === 'softbreak') runs.pop();
    else if (last.type === 'text' && !last.code) {
      trimEnd(last);
      if (!last.text) runs.pop();
    }
  }

  if (runs.length === 0) runs.push({ type: 'text', text: '' });
  return { runs, display };
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
