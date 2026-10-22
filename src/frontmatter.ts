export type NoteType = 'in-text' | 'footnotes' | 'endnotes';

import { pushAll } from './arrays';
import {
  parseTableDigits,
  parseTableDecimalMark,
  parseTableDigitGrouping,
  type TableDigits,
  type TableDecimalMark,
  type TableDigitGrouping,
} from './table-number-format';

export type { TableDigits, TableDecimalMark, TableDigitGrouping } from './table-number-format';

const NOTE_TYPE_NAMES: Record<string, NoteType> = {
  'in-text': 'in-text',
  'footnotes': 'footnotes',
  'endnotes': 'endnotes',
  '0': 'in-text',
  '1': 'footnotes',
  '2': 'endnotes',
};

const NOTE_TYPE_TO_NUMBER: Record<NoteType, number> = {
  'in-text': 0,
  'footnotes': 1,
  'endnotes': 2,
};

export function noteTypeFromNumber(n: number): NoteType {
  if (n === 1) return 'footnotes';
  if (n === 2) return 'endnotes';
  return 'in-text';
}

export function noteTypeToNumber(nt: NoteType): number {
  return NOTE_TYPE_TO_NUMBER[nt];
}

export type NotesMode = 'footnotes' | 'endnotes';

/** A user-defined custom paragraph style declared in the `styles:` frontmatter block. */
export interface CustomStyleDef {
  font?: string;
  fontSize?: number;       // points
  fontStyle?: string;      // normalized: bold-italic-...-center
  spacingBefore?: number;  // points
  spacingAfter?: number;   // points
  paragraphIndent?: number | 'none'; // inches; 'none' = explicit zero first-line indent
}

/**
 * The keys whose list export reads as an inline array, as
 * `header-font: [Georgia, Arial]`, so a block list under one too, as
 * `header-font:` then `  - Georgia` and `  - Arial` (see readBlockLists).
 */
export const ARRAY_KEYS: ReadonlySet<string> = new Set([
  'header-font', 'header-font-size', 'header-font-style',
  'title-font', 'title-font-size', 'title-font-style', 'table-col-widths',
]);

/**
 * The keys parseFrontmatter reads that take one value, aliases among them.
 * A block list under one reads as the key repeated, which keeps one of its
 * items, as a repeated key keeps one of its values. Of the other keys it
 * reads, `title` takes several, one for each time it's written, and
 * `styles` and `crossref` a mapping.
 */
export const SINGLE_VALUE_KEYS: ReadonlySet<string> = new Set([
  'author', 'csl', 'locale', 'zotero-notes', 'note-type', 'notes', 'timezone',
  'bibliography', 'bib', 'bibtex', 'font', 'code-font', 'font-size', 'code-font-size',
  'code-background-color', 'code-background', 'code-font-color', 'code-color', 'code-block-inset',
  'table-font', 'table-font-size', 'pipe-table-max-line-width', 'grid-table-max-line-width',
  'table-borders', 'table-digits', 'table-decimal-mark', 'table-digit-grouping',
  'blockquote-style', 'callout-labels', 'colors', 'breaks', 'line-spacing', 'paragraph-indent',
  'bibliography-hanging-indent', 'fig-cap-location', 'tbl-cap-location',
]);

/** The keys parseFrontmatter reads, each of which import writes from what the Word document has */
const READ_KEYS: ReadonlySet<string> = new Set([...SINGLE_VALUE_KEYS, ...ARRAY_KEYS, 'title', 'styles', 'crossref']);

/** Quarto's mappings, of whose keys export reads some: `crossref`'s
 *  fig-title, tbl-title and title-delim. One with none of those, as
 *  `crossref: {fig-prefix: Fig.}`, gives no setting import could write
 *  back, so it goes as written, as a key export reads nothing from (see
 *  frontmatterLayout). */
const PARTLY_READ_KEYS: ReadonlySet<string> = new Set(['crossref']);

/** An item of a block list in frontmatter, as `  - One` after `title:` */
export interface BlockListItem {
  /** The index of its line among the frontmatter's */
  line: number;
  /** The offset in that line of its text, past the `-` and the spaces after it, those that end the line too */
  start: number;
  /** The offset in that line past its text, before the spaces that end the line */
  end: number;
  /**
   * The indices of the lines after it more indented than its `-`. They're
   * no value: export reads them as it reads the lines after a key's value,
   * each as a key's line where it has a colon.
   */
  more: number[];
  /** Its text, on its line, as a value is after a key: an item is one line */
  text: string;
  /** Whether it's a mapping, as `- name: Jane`, not text */
  mapping: boolean;
  /**
   * Whether it's text YAML would read on past its line: it has lines in
   * `more`, or it opens a quote its line doesn't close, which YAML would
   * close on a later line, past blank lines and lines that start with #
   */
  continued: boolean;
}

/** A line's indentation, of spaces and tabs */
function indentOf(line: string): number {
  let k = 0;
  while (line[k] === ' ' || line[k] === '\t') k++;
  return k;
}

/** Whether a line is blank, as the line after frontmatter's opening one can't be */
function isBlankLine(line: string): boolean {
  return /^[ \t]*\r?$/.test(line);
}

/** Whether text after a line's indentation is an item of a block list: a `-`, then a space, a tab or the line's end */
function isListItem(content: string): boolean {
  return content[0] === '-' && (content.length === 1 || content[1] === ' ' || content[1] === '\t');
}

/**
 * For text that starts with a quote, the index of the quote that closes
 * it, past \" in double quotes and '' in single, or -1 where none does
 */
function closingQuoteAt(text: string): number {
  return closingQuoteFrom(text, 0);
}

/** For a quote at `start` in text, the index of the quote that closes it, as closingQuoteAt has it */
function closingQuoteFrom(text: string, start: number): number {
  const quote = text[start];
  for (let k = start + 1; k < text.length; k++) {
    if (quote === '"' && text[k] === '\\') k++;
    else if (text[k] === quote && quote === "'" && text[k + 1] === "'") k++;
    else if (text[k] === quote) return k;
  }
  return -1;
}

/**
 * Whether an item's text is a mapping, as YAML reads it: a key, plain or
 * quoted, then a `:` before a space, a tab or the end, as `name: Jane` or
 * `"a": b`. A `:` inside quotes, as in `"a: b"`, or in a comment, after a
 * space and a `#`, as in `One # note: x` or `#1: x`, isn't one, nor is one
 * before other text, as in `https://x.org`.
 */
function isMappingItem(text: string): boolean {
  if (text[0] === '"' || text[0] === "'") {
    let k = closingQuoteAt(text);
    if (k < 0) return false;
    k++;
    while (text[k] === ' ' || text[k] === '\t') k++;
    return text[k] === ':' && (k + 1 === text.length || text[k + 1] === ' ' || text[k + 1] === '\t');
  }
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    // A comment, which a space before the item's text starts too
    if (c === '#' && (k === 0 || text[k - 1] === ' ' || text[k - 1] === '\t')) return false;
    if (c === ':' && (k + 1 === text.length || text[k + 1] === ' ' || text[k + 1] === '\t')) return true;
  }
  return false;
}

/**
 * The block list after the key that starts the line at index `at`, where
 * the key's value is empty or a comment, as `title:` then `  - One` and
 * `  - Two`: the lines after the key of its items, each a `-` then a space
 * or the line's end, with blank lines and comments between them. A line
 * more indented than an item's `-` goes with that item. Returns the items
 * and the index of the list's last line, or undefined where no item
 * follows the key. A key indented, as in a mapping, opens none, nor does
 * a comment or an item.
 *
 * Linear time: it reads the list's lines once each, and where the key opens
 * none, the blank lines and comments after it, which no other key has after
 * it.
 */
export function blockListAfter(lines: readonly string[], at: number): { items: BlockListItem[]; last: number } | undefined {
  const header = lines[at].replace(/\r$/, '');
  if (header[0] === ' ' || header[0] === '\t' || header[0] === '#' || isListItem(header)) return undefined;
  const colon = header.indexOf(':');
  if (colon <= 0 || !/^(?:[ \t]*|[ \t]+#.*)$/.test(header.slice(colon + 1))) return undefined;
  const items: BlockListItem[] = [];
  let last = at;
  // The indentation of the last item's `-`
  let dash = -1;
  for (let k = at + 1; k < lines.length; k++) {
    const line = lines[k].replace(/\r$/, '');
    const indent = indentOf(line);
    const content = line.slice(indent).trimEnd();
    // Blank lines and comments don't end it
    if (!content.trim() || content[0] === '#') continue;
    if (items.length > 0 && indent > dash) {
      items[items.length - 1].more.push(k);
      last = k;
      continue;
    }
    if (!isListItem(content)) break;
    const start = indent + 1 + indentOf(line.slice(indent + 1));
    const text = content.slice(1).trim();
    items.push({ line: k, start, end: Math.max(start, indent + content.length), more: [], text, mapping: isMappingItem(text), continued: false });
    dash = indent;
    last = k;
  }
  if (items.length === 0) return undefined;
  for (const item of items) {
    item.continued = !item.mapping && (item.more.length > 0 || ((item.text[0] === '"' || item.text[0] === "'") && closingQuoteAt(item.text) < 0));
  }
  return { items, last };
}

/**
 * The block list readBlockLists reads after line `at`, with its key: that
 * of blockListAfter, after any key but `styles`, which takes a mapping
 * that parseFrontmatter reads itself. Where it isn't undefined, the next
 * list is past `last`.
 */
export function blockListOf(lines: readonly string[], at: number): { key: string; items: BlockListItem[]; last: number } | undefined {
  const line = lines[at];
  const colon = line.indexOf(':');
  const key = colon > 0 ? line.slice(0, colon).trim() : '';
  const list = key && key !== 'styles' ? blockListAfter(lines, at) : undefined;
  return list && { key, items: list.items, last: list.last };
}

/**
 * The lines a block list in frontmatter stands for, which parseFrontmatter
 * then reads, as a key's lines: for a key in ARRAY_KEYS, the inline array of
 * its items, and for another key, as `title`, the key once for each item,
 * each as the key written with that value is read. An item is its line:
 * the lines after it that go with it are read as before, as the lines
 * after a key's value are, and so are a mapping's, which is no value.
 * Where no item is text, the key is as written. `warnings` gets what
 * export reads differently from what the list holds, under a key it
 * reads: a mapping, an item that goes on past its line, and more than one
 * value for a key that takes one.
 */
function readBlockLists(lines: string[], warnings: string[]): string[] {
  const read: string[] = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const list = blockListOf(lines, k);
    if (!list) {
      read.push(line);
      continue;
    }
    const key = list.key;
    k = list.last;
    const array = ARRAY_KEYS.has(key);
    const known = array || key === 'title' || SINGLE_VALUE_KEYS.has(key);
    // The items of text, and in their order each item's lines but an
    // array's, which is one line
    const texts: string[] = [];
    const itemLines: string[] = [];
    for (const item of list.items) {
      const shown = '`- ' + (item.text.length > 60 ? item.text.slice(0, 60) + '…' : item.text) + '`';
      if (item.mapping) {
        itemLines.push(lines[item.line]);
        if (known) warnings.push('Frontmatter `' + key + '` has a list item that is a mapping, which export doesn\'t read: ' + shown + '. Put the item in quotes to read it as text.');
      } else {
        texts.push(item.text);
        if (!array) itemLines.push(key + ': ' + item.text);
      }
      for (const more of item.more) itemLines.push(lines[more]);
      if (item.continued && known) {
        warnings.push('Frontmatter `' + key + '` has a list item that goes on past its line, or opens a quote that doesn\'t close on it, and export reads only its line: '
          + shown + '. Write the item on one line, with any quote it opens closed.');
      }
    }
    if (texts.length === 0) {
      read.push(line);
    } else if (array) {
      // Its items, each as a value after the key is read, as the inline
      // array reads its own, without those that are empty
      const values = texts.map(unquote).filter(value => value.length > 0);
      read.push(values.length > 0 ? key + ': [' + values.join(', ') + ']' : key + ':');
    }
    pushAll(read, itemLines);
    const count = texts.filter(text => unquote(text).length > 0).length;
    if (SINGLE_VALUE_KEYS.has(key) && count > 1) {
      warnings.push('Frontmatter `' + key + '` takes one value, but its list has ' + count
        + ' items. Export used only one, as it does for `' + key + '` repeated.');
    }
  }
  return read;
}

/**
 * The text of a YAML scalar on one line, `raw`, as after a key's colon:
 * one in double quotes, with its escapes read, one in single quotes, where
 * '' is a quote, or one in none, to a comment, which a space and a # start.
 * Undefined where a quote doesn't close on the line or text follows it.
 */
export function yamlScalar(raw: string): string | undefined {
  const text = raw.trim();
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return text.replace(/(^|[ \t])#.*$/, '').trim();
  let value = '';
  let at = 1;
  for (; at < text.length; at++) {
    const c = text[at];
    if (quote === "'") {
      if (c !== "'") value += c;
      else if (text[at + 1] === "'") value += text[++at];
      else break;
    } else if (c === '"') {
      break;
    } else if (c !== '\\') {
      value += c;
    } else {
      const e = text[++at];
      const hex = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
      if (hex > 0) {
        const digits = text.slice(at + 1, at + 1 + hex);
        const code = parseInt(digits, 16);
        if (digits.length < hex || !/^[0-9A-Fa-f]+$/.test(digits) || code > 0x10FFFF) return undefined;
        value += String.fromCodePoint(code);
        at += hex;
      } else {
        const escaped = YAML_ESCAPES[e];
        if (escaped === undefined) return undefined;
        value += escaped;
      }
    }
  }
  if (at >= text.length) return undefined;
  const rest = text.slice(at + 1).trim();
  return rest === '' || rest.startsWith('#') ? value : undefined;
}

const YAML_ESCAPES: Record<string, string> = {
  '0': '\0', 'a': '\x07', 'b': '\b', 't': '\t', '\t': '\t', 'n': '\n', 'v': '\v', 'f': '\f', 'r': '\r', 'e': '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', 'N': '\x85', '_': '\xa0', 'L': '\u2028', 'P': '\u2029',
};

/** `value` as a YAML scalar yamlScalar reads back as it is: as written
 *  where it's words, digits and periods YAML reads as text, in double
 *  quotes otherwise */
export function yamlScalarText(value: string): string {
  if (/^[\p{L}\p{N}.(](?:[\p{L}\p{N} .()]*[\p{L}\p{N}.)])?$/u.test(value) && !/^(?:null|true|false|yes|no|on|off|y|n|[-+.\d][\d.e+-]*)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/** A value as parseFrontmatter reads it after a key, without a quote at its start or end */
function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

/** Parse a value that may be a YAML inline array `[v1, v2, ...]` or bare comma-separated values. */
export function parseInlineArray(value: string): string[] {
  let inner = value;
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1);
  if (!inner.includes(',')) return [inner.trim()].filter(s => s.length > 0);
  return inner.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// Design rationale: A single combined header-font-style field was chosen over
// separate CSS-style fields (font-style, font-weight, font-decoration) because:
// 1. One field is simpler for authors than three separate fields.
// 2. Manuscript authors are not web developers — CSS distinctions between
//    font-style, font-weight, and text-decoration are unfamiliar.
// 3. Word only supports bold on/off (no numeric weights 100–900), so a
//    separate font-weight field accepting numbers would be misleading.
const VALID_STYLE_PARTS = new Set(['bold', 'italic', 'underline', 'smallcaps', 'allcaps', 'center']);
const CANONICAL_ORDER = ['bold', 'italic', 'underline', 'smallcaps', 'allcaps', 'center'];

/** Validate and normalize a Font_Style value to canonical order (bold-italic-underline-smallcaps-allcaps-center). */
export function normalizeFontStyle(raw: string): string | undefined {
  const lower = raw.toLowerCase().trim();
  if (!lower) return undefined;
  if (lower === 'normal') return 'normal';
  const parts = lower.split('-');
  const unique = [...new Set(parts)];
  if (unique.length !== parts.length) return undefined;
  if (!unique.every(p => VALID_STYLE_PARTS.has(p))) return undefined;
  // smallcaps and allcaps are mutually exclusive (Word only supports one at a time)
  if (unique.includes('smallcaps') && unique.includes('allcaps')) return undefined;
  return unique.sort((a, b) => CANONICAL_ORDER.indexOf(a) - CANONICAL_ORDER.indexOf(b)).join('-');
}

export type BlockquoteStyle = 'Quote' | 'IntenseQuote' | 'GitHub';

const BLOCKQUOTE_STYLE_NAMES: Record<string, BlockquoteStyle> = {
  'quote': 'Quote',
  'intensequote': 'IntenseQuote',
  'github': 'GitHub',
};

/** Normalize a raw blockquote-style value (case-insensitive). */
export function normalizeBlockquoteStyle(raw: string): BlockquoteStyle | undefined {
  return BLOCKQUOTE_STYLE_NAMES[raw.toLowerCase().trim()];
}

export type ColorScheme = 'github' | 'guttmacher';

const COLOR_SCHEME_NAMES: Record<string, ColorScheme> = {
  'github': 'github',
  'guttmacher': 'guttmacher',
};

/** Normalize a raw colors value (case-insensitive). */
export function normalizeColorScheme(raw: string): ColorScheme | undefined {
  return COLOR_SCHEME_NAMES[raw.toLowerCase().trim()];
}

export interface Frontmatter {
  title?: string[];
  author?: string;
  csl?: string;
  locale?: string;
  zoteroNotes?: NoteType;
  notes?: NotesMode;
  timezone?: string;
  bibliography?: string;
  font?: string;
  codeFont?: string;
  fontSize?: number;
  codeFontSize?: number;
  headerFont?: string[];
  headerFontSize?: number[];
  headerFontStyle?: string[];
  titleFont?: string[];
  titleFontSize?: number[];
  titleFontStyle?: string[];
  codeBackgroundColor?: string;
  codeFontColor?: string;
  codeBlockInset?: number;
  pipeTableMaxLineWidth?: number;
  gridTableMaxLineWidth?: number;
  tableFont?: string;
  tableFontSize?: number;
  tableColWidths?: number[] | 'equal' | 'auto';
  tableBorders?: 'horizontal' | 'solid' | 'none';
  tableDigits?: TableDigits;
  tableDecimalMark?: TableDecimalMark;
  tableDigitGrouping?: TableDigitGrouping;
  blockquoteStyle?: BlockquoteStyle;
  calloutLabels?: boolean;
  colors?: ColorScheme;
  styles?: Record<string, CustomStyleDef>;
  breaks?: boolean;
  lineSpacing?: string | number;
  paragraphIndent?: number | 'none';
  bibliographyHangingIndent?: boolean;
  /** Quarto's `crossref` keys export reads, the words and delimiter a caption shows (see captions.ts) */
  crossref?: CrossrefOptions;
  /** Quarto's fig-cap-location: whether a figure's caption goes above or below it */
  figCapLocation?: 'top' | 'bottom';
  /** Quarto's tbl-cap-location: whether a table's caption goes above or below it */
  tblCapLocation?: 'top' | 'bottom';
}

/** The keys of Quarto's `crossref` mapping export reads */
export interface CrossrefOptions {
  figTitle?: string;
  tblTitle?: string;
  titleDelim?: string;
}

/**
 * The line that opens frontmatter: just ---, with YAML right after it. As
 * Pandoc has it, --- before a blank line is a horizontal rule, as is ----.
 * Keep the frontmatter patterns elsewhere in step with this one.
 */
export const FRONTMATTER_OPENING_RE = /^---[ \t]*\r?\n(?![ \t]*\r?\n)/;
/** The line that closes it, which can end in spaces too. */
export const FRONTMATTER_CLOSING_RE = /\n---[ \t]*(?=\r?\n|$)/;

function frontmatterBodyStartOffset(markdown: string): number | undefined {
  const leadingTrimmedLength = markdown.length - markdown.trimStart().length;
  const trimmed = markdown.slice(leadingTrimmedLength);
  if (!FRONTMATTER_OPENING_RE.test(trimmed)) return undefined;

  const endMatch = trimmed.substring(3).match(FRONTMATTER_CLOSING_RE);
  if (!endMatch) return undefined;
  const closeEnd = endMatch.index! + 3 + endMatch[0].length;
  const consumedLeadingNewline = trimmed.slice(closeEnd).match(/^\r?\n/)?.[0].length ?? 0;
  return leadingTrimmedLength + closeEnd + consumedLeadingNewline;
}

/** Replace YAML frontmatter characters with spaces while preserving length and newlines. */
export function maskFrontmatter(markdown: string): string {
  const bodyStart = frontmatterBodyStartOffset(markdown);
  if (bodyStart === undefined) return markdown;
  return markdown.slice(0, bodyStart).replace(/[^\r\n]/g, ' ') + markdown.slice(bodyStart);
}

/** Parse a col-widths value: "2 1 1", "2,1,1", "[2, 1, 1]", "equal", "auto". */
export function parseColWidths(raw: string): number[] | 'equal' | 'auto' | undefined {
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

/** Expand ratios to match numCols by repeating the last value. */
export function expandColWidths(ratios: number[] | 'equal', numCols: number): number[] {
  if (ratios === 'equal') return Array(numCols).fill(1);
  if (ratios.length >= numCols) return ratios.slice(0, numCols);
  const result = [...ratios];
  const last = ratios[ratios.length - 1];
  while (result.length < numCols) result.push(last);
  return result;
}

/** Convert ratios to OOXML fiftieths-of-percent (sum = 5000). */
export function colWidthsToPct(ratios: number[]): number[] {
  const total = ratios.reduce((a, b) => a + b, 0);
  if (total === 0) return ratios.map(() => Math.floor(5000 / ratios.length));
  const raw = ratios.map(r => r / total * 5000);
  // Largest-remainder rounding to ensure exact sum of 5000
  const widths = raw.map(v => Math.floor(v));
  const remaining = 5000 - widths.reduce((a, b) => a + b, 0);
  const byRemainder = raw
    .map((v, i) => ({ i, frac: v - widths[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remaining; k++) widths[byRemainder[k].i] += 1;
  return widths;
}

/**
 * Split YAML frontmatter (delimited by `---`) from the markdown body.
 * Returns the parsed metadata and the remaining body text, with `warnings`
 * where it reads something other than what's written (see readBlockLists).
 */
export function parseFrontmatter(markdown: string): { metadata: Frontmatter; body: string; fieldOrder: string[]; warnings?: string[] } {
  const bodyStart = frontmatterBodyStartOffset(markdown);
  if (bodyStart === undefined) {
    return { metadata: {}, body: markdown, fieldOrder: [] };
  }
  const body = markdown.slice(bodyStart);
  const warnings: string[] = [];
  const { metadata, fieldOrder } = readFrontmatterLines(frontmatterYaml(markdown).trimEnd().split('\n'), warnings);

  // Title inline array: if exactly one title entry looks like [v1, v2, ...], expand it
  if (metadata.title && metadata.title.length === 1) {
    const t = metadata.title[0];
    if (t.startsWith('[') && t.endsWith(']')) {
      metadata.title = parseInlineArray(t);
    }
  }

  return warnings.length > 0 ? { metadata, body, fieldOrder, warnings } : { metadata, body, fieldOrder };
}

/**
 * The YAML of frontmatter the Markdown has, from the line after the opening
 * one, with its indentation, which says whether a key there opens a block
 * list, as the language server reads it, to the line end before the
 * closing one
 */
function frontmatterYaml(markdown: string): string {
  const trimmed = markdown.trimStart();
  const endMatch = trimmed.substring(3).match(FRONTMATTER_CLOSING_RE)!;
  const endIdx = endMatch.index! + 3;
  return trimmed.slice(3, endIdx).replace(/^[ \t]*\r?\n/, '');
}

/** The settings frontmatter's lines give, and the keys they have, in order, as parseFrontmatter reads them */
function readFrontmatterLines(lines: string[], warnings: string[]): { metadata: Frontmatter; fieldOrder: string[] } {
  const metadata: Frontmatter = {};
  const fieldOrder: string[] = [];
  const seenFields = new Set<string>();
  // Each block list as the lines it stands for, as `title:` then `  - One`
  // and `  - Two` as `title: One` and `title: Two`
  const yamlLines = readBlockLists(lines, warnings);
  for (let lineIdx = 0; lineIdx < yamlLines.length; lineIdx++) {
    const line = yamlLines[lineIdx];
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!seenFields.has(key)) {
      seenFields.add(key);
      fieldOrder.push(key);
    }

    // Handle nested `styles:` block specially
    if (key === 'styles') {
      const styles: Record<string, CustomStyleDef> = {};
      let currentName: string | undefined;
      let nameIndent = -1; // indent of the first style-name line (auto-detected)
      // Scan subsequent indented lines
      while (lineIdx + 1 < yamlLines.length) {
        const nextLine = yamlLines[lineIdx + 1];
        // Stop at non-indented lines (next top-level key or blank)
        if (nextLine.length > 0 && !nextLine.startsWith(' ') && !nextLine.startsWith('\t')) break;
        lineIdx++;
        const trimmed = nextLine.trimStart();
        if (!trimmed) continue; // skip blank lines within the block
        const indent = nextLine.length - trimmed.length;
        const innerColon = trimmed.indexOf(':');
        if (innerColon < 0) continue;
        const innerKey = trimmed.slice(0, innerColon).trim();
        const innerVal = trimmed.slice(innerColon + 1).trim().replace(/^["']|["']$/g, '');
        // Auto-detect the style-name indent level from the first indented line
        if (nameIndent < 0) nameIndent = indent;
        if (indent <= nameIndent) {
          // Style name level
          currentName = innerKey;
          if (!styles[currentName]) styles[currentName] = {};
        } else if (currentName) {
          // Property level (4-space indent)
          const def = styles[currentName];
          switch (innerKey) {
            case 'font':
              if (innerVal) def.font = innerVal;
              break;
            case 'font-size': {
              const n = parseFloat(innerVal);
              if (isFinite(n) && n > 0) def.fontSize = n;
              break;
            }
            case 'font-style': {
              const norm = normalizeFontStyle(innerVal);
              if (norm) def.fontStyle = norm;
              break;
            }
            case 'spacing-before': {
              const n = parseFloat(innerVal);
              if (isFinite(n) && n >= 0) def.spacingBefore = n;
              break;
            }
            case 'spacing-after': {
              const n = parseFloat(innerVal);
              if (isFinite(n) && n >= 0) def.spacingAfter = n;
              break;
            }
            case 'paragraph-indent': {
              const lower = innerVal.toLowerCase();
              if (lower === 'none') {
                def.paragraphIndent = 'none';
              } else {
                const n = parseFloat(innerVal);
                if (isFinite(n) && n >= 0) def.paragraphIndent = n;
              }
              break;
            }
          }
        }
      }
      if (Object.keys(styles).length > 0) metadata.styles = styles;
      continue;
    }

    // Quarto's `crossref:` mapping, of whose keys export reads fig-title,
    // tbl-title and title-delim, each a value of YAML's, in quotes or none,
    // on its line, at the indentation of the mapping's first key: a line
    // indented more is a value of a key it doesn't read. A comment, at any
    // indentation, ends no mapping in YAML, nor here.
    if (key === 'crossref') {
      const crossref: CrossrefOptions = {};
      let keyIndent = -1;
      while (lineIdx + 1 < yamlLines.length) {
        const nextLine = yamlLines[lineIdx + 1];
        if (nextLine.length > 0 && !nextLine.startsWith(' ') && !nextLine.startsWith('\t') && !nextLine.startsWith('#')) break;
        lineIdx++;
        const inner = nextLine.trimStart();
        if (!inner || inner.startsWith('#')) continue;
        const indent = nextLine.length - inner.length;
        if (keyIndent < 0) keyIndent = indent;
        const innerColon = inner.indexOf(':');
        if (indent !== keyIndent || innerColon < 0) continue;
        const innerVal = yamlScalar(inner.slice(innerColon + 1));
        if (innerVal === undefined) continue;
        switch (inner.slice(0, innerColon).trim()) {
          case 'fig-title':
            if (innerVal) crossref.figTitle = innerVal;
            break;
          case 'tbl-title':
            if (innerVal) crossref.tblTitle = innerVal;
            break;
          case 'title-delim':
            crossref.titleDelim = innerVal;
            break;
        }
      }
      if (Object.keys(crossref).length > 0) metadata.crossref = crossref;
      continue;
    }

    switch (key) {
      case 'title':
        if (!metadata.title) metadata.title = [];
        metadata.title.push(value);
        break;
      case 'author':
        if (value) metadata.author = value;
        break;
      case 'csl':
        metadata.csl = value;
        break;
      case 'locale':
        metadata.locale = value;
        break;
      case 'zotero-notes':
      case 'note-type': {
        const nt = NOTE_TYPE_NAMES[value];
        if (nt) metadata.zoteroNotes = nt;
        break;
      }
      case 'notes': {
        if (value === 'footnotes' || value === 'endnotes') {
          metadata.notes = value;
        }
        break;
      }
      case 'timezone':
        if (value && /^[+-]\d{2}:\d{2}$/.test(value)) metadata.timezone = value;
        break;
      // Implementation note: accepts bibliography / bib / bibtex (first match wins).
      // Normalize with normalizeBibPath(); resolution order: relative to .md dir →
      // workspace root → fallback {basename}.bib. CLI --bib takes precedence.
      case 'bibliography':
      case 'bib':
      case 'bibtex':
        if (value && !metadata.bibliography) metadata.bibliography = value;
        break;
      case 'font':
        if (value) metadata.font = value;
        break;
      case 'code-font':
        if (value) metadata.codeFont = value;
        break;
      case 'font-size': {
        const n = parseFloat(value);
        if (isFinite(n) && n > 0) metadata.fontSize = n;
        break;
      }
      case 'code-font-size': {
        const n = parseFloat(value);
        if (isFinite(n) && n > 0) metadata.codeFontSize = n;
        break;
      }
      case 'header-font':
        if (value) metadata.headerFont = parseInlineArray(value);
        break;
      case 'header-font-size': {
        const arr = parseInlineArray(value).map(s => parseFloat(s)).filter(n => isFinite(n) && n > 0);
        if (arr.length > 0) metadata.headerFontSize = arr;
        break;
      }
      case 'header-font-style': {
        const arr = parseInlineArray(value).map(s => normalizeFontStyle(s)).filter((s): s is string => s !== undefined);
        if (arr.length > 0) metadata.headerFontStyle = arr;
        break;
      }
      case 'title-font':
        if (value) metadata.titleFont = parseInlineArray(value);
        break;
      case 'title-font-size': {
        const arr = parseInlineArray(value).map(s => parseFloat(s)).filter(n => isFinite(n) && n > 0);
        if (arr.length > 0) metadata.titleFontSize = arr;
        break;
      }
      case 'title-font-style': {
        const arr = parseInlineArray(value).map(s => normalizeFontStyle(s)).filter((s): s is string => s !== undefined);
        if (arr.length > 0) metadata.titleFontStyle = arr;
        break;
      }
      case 'code-background-color':
      case 'code-background': {
        if (/^[0-9A-Fa-f]{6}$/.test(value) || value === 'none' || value === 'transparent') {
          metadata.codeBackgroundColor = value;
        }
        break;
      }
      case 'code-font-color':
      case 'code-color': {
        if (/^[0-9A-Fa-f]{6}$/.test(value)) {
          metadata.codeFontColor = value;
        }
        break;
      }
      case 'code-block-inset': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n > 0 && value.trim() === String(n)) {
          metadata.codeBlockInset = n;
        }
        break;
      }
      case 'table-font':
        if (value) metadata.tableFont = value;
        break;
      case 'table-font-size': {
        const n = parseFloat(value);
        if (isFinite(n) && n > 0) metadata.tableFontSize = n;
        break;
      }
      // 0 = disable pipe tables (always HTML); positive = max line width
      case 'pipe-table-max-line-width': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n >= 0 && value.trim() === String(n)) {
          metadata.pipeTableMaxLineWidth = n;
        }
        break;
      }
      case 'grid-table-max-line-width': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n >= 0 && value.trim() === String(n)) {
          metadata.gridTableMaxLineWidth = n;
        }
        break;
      }
      case 'table-col-widths': {
        const parsed = parseColWidths(value);
        if (parsed) metadata.tableColWidths = parsed;
        break;
      }
      case 'table-borders': {
        const v = value.toLowerCase();
        if (v === 'horizontal' || v === 'solid' || v === 'none') metadata.tableBorders = v;
        break;
      }
      case 'table-digits': {
        const parsed = parseTableDigits(value);
        if (parsed !== undefined) metadata.tableDigits = parsed;
        break;
      }
      case 'table-decimal-mark': {
        const parsed = parseTableDecimalMark(value);
        if (parsed !== undefined) metadata.tableDecimalMark = parsed;
        break;
      }
      case 'table-digit-grouping': {
        const parsed = parseTableDigitGrouping(value);
        if (parsed !== undefined) metadata.tableDigitGrouping = parsed;
        break;
      }
      case 'blockquote-style': {
        const style = normalizeBlockquoteStyle(value);
        if (style) metadata.blockquoteStyle = style;
        break;
      }
      case 'callout-labels':
        if (value === 'true') metadata.calloutLabels = true;
        else if (value === 'false') metadata.calloutLabels = false;
        break;
      case 'colors': {
        const scheme = normalizeColorScheme(value);
        if (scheme) metadata.colors = scheme;
        break;
      }
      case 'breaks':
        if (value === 'true') metadata.breaks = true;
        else if (value === 'false') metadata.breaks = false;
        break;
      case 'line-spacing': {
        const lower = value.toLowerCase();
        if (lower === 'single' || lower === '1.5' || lower === 'double') {
          metadata.lineSpacing = lower;
        } else {
          const n = parseFloat(value);
          if (isFinite(n) && n > 0) metadata.lineSpacing = n;
        }
        break;
      }
      case 'paragraph-indent': {
        const lower = value.toLowerCase();
        if (lower === 'none') {
          metadata.paragraphIndent = 'none';
        } else {
          const n = parseFloat(value);
          if (isFinite(n) && n >= 0) metadata.paragraphIndent = n;
        }
        break;
      }
      case 'bibliography-hanging-indent':
        if (value === 'true') metadata.bibliographyHangingIndent = true;
        else if (value === 'false') metadata.bibliographyHangingIndent = false;
        break;
      case 'fig-cap-location':
        if (value === 'top' || value === 'bottom') metadata.figCapLocation = value;
        break;
      case 'tbl-cap-location':
        if (value === 'top' || value === 'bottom') metadata.tblCapLocation = value;
        break;
    }
  }
  return { metadata, fieldOrder };
}

/**
 * Frontmatter's top-level keys in their order, for a Word document to keep
 * for import: the name of each key parseFrontmatter reads, whose value
 * import takes from the document, so that an edit in Word wins, and as
 * written each key it reads nothing from, as `date`, `abstract` or
 * Quarto's `format`, which import puts back where it was among them.
 */
export type FrontmatterLayout = Array<string | { text: string }>;

/**
 * The key of a line YAML reads as a key of a block mapping at the line's
 * start, without its quotes: one in quotes, with no escape, as `\x74` or
 * `''`, or plain, which starts with no character YAML reads otherwise
 * there, as `{`, `[`, `-`, `?`, `&` or `%`, and has no comment, then a
 * colon before a space, a tab or the line's end. Undefined where YAML
 * reads no such key there, as at a flow mapping's `{` or `}`, a document's
 * end, `...`, or a directive, and for a key with an escape, which could
 * spell one parseFrontmatter reads, as `"\x74itle"` does `title`.
 */
function blockKeyOf(line: string): string | undefined {
  if (line[0] === '"' || line[0] === "'") {
    const close = closingQuoteAt(line);
    if (close < 0) return undefined;
    const key = line.slice(1, close);
    if (key.includes(line[0] === '"' ? '\\' : "''")) return undefined;
    let k = close + 1;
    while (line[k] === ' ' || line[k] === '\t') k++;
    if (line[k] !== ':' || !(k + 1 === line.length || line[k + 1] === ' ' || line[k + 1] === '\t')) return undefined;
    return key;
  }
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(line)) return undefined;
  const colon = line.search(/:(?=[ \t]|$)/);
  if (colon < 0) return undefined;
  const key = line.slice(0, colon).trimEnd();
  return /[ \t]#/.test(key) ? undefined : key;
}

/**
 * How a line of frontmatter's YAML ends, for its splitting into entries:
 * 'open' where a value in quotes or a flow collection, as `[a,` or
 * `{a: 1,`, that starts in it goes on past it, as onto a line at its start
 * that looks like a key's, or where a literal or folded value starts in
 * it, as at `|` or `>-`, the column its lines are past, or undefined. A
 * quote in plain text, as in `it's`, starts no value, nor does one in a
 * comment. Some lines YAML reads otherwise read as 'open', which only
 * keeps less.
 */
function yamlLineEnd(line: string): 'open' | number | undefined {
  let depth = 0;
  // Whether a value can start here, where a quote opens one
  let nodeStart = true;
  // The column of the node a value here is under, and of the last value
  // that started outside flow collections, as a key
  let parent = indentOf(line);
  let scalarStart = -1;
  for (let k = parent; k < line.length; k++) {
    const c = line[k];
    if (c === ' ' || c === '\t') continue;
    // A comment
    if (c === '#' && (k === 0 || line[k - 1] === ' ' || line[k - 1] === '\t')) break;
    const spaceAfter = k + 1 === line.length || line[k + 1] === ' ' || line[k + 1] === '\t';
    if (nodeStart && (c === '"' || c === "'")) {
      const close = closingQuoteFrom(line, k);
      if (close < 0) return 'open';
      if (depth === 0) scalarStart = k;
      k = close;
      nodeStart = false;
    } else if ((c === '[' || c === '{') && (nodeStart || depth > 0)) {
      depth++;
      nodeStart = true;
    } else if ((c === ']' || c === '}') && depth > 0) {
      depth--;
      nodeStart = false;
    } else if (c === ',' && depth > 0) {
      nodeStart = true;
    } else if ((c === '-' || c === '?') && nodeStart && spaceAfter) {
      if (depth === 0) parent = k;
    } else if (c === ':' && (spaceAfter || depth > 0)) {
      if (depth === 0 && scalarStart >= 0) parent = scalarStart;
      nodeStart = true;
    } else if ((c === '|' || c === '>') && nodeStart && depth === 0) {
      return parent;
    } else if ((c === '&' || c === '!') && nodeStart) {
      // An anchor or a tag, before the value
      while (k + 1 < line.length && line[k + 1] !== ' ' && line[k + 1] !== '\t') k++;
    } else {
      if (nodeStart && depth === 0) scalarStart = k;
      nodeStart = false;
    }
  }
  return depth > 0 ? 'open' : undefined;
}

/**
 * An anchor, as `&base` before a value, which an alias, `*base`, refers to
 * elsewhere, in a line of frontmatter. Some text that isn't one matches
 * too, which only keeps less.
 */
const ANCHOR_RE = /(?:^|[ \t[{,])&[^ \t[\]{},]/;

/**
 * Frontmatter's top-level entries, by the indices of their lines, where
 * it's a block mapping, as YAML reads it, of keys at their lines' start:
 * each a key's line, with the comments and blank lines right before it and
 * the lines after it up to the next one's, those indented, as a mapping's
 * or a literal value's, and a list's items. The comments and blank lines at
 * the end go with the last entry. Undefined where a line is none of those,
 * as in a flow mapping, `{`, then its keys, then `}`, or frontmatter
 * indented as a whole, or where a value goes on past its line other than
 * as a literal or folded one, whose lines are indented, as a value in
 * quotes or a flow collection does, which a line at its start that looks
 * like a key's could be part of (see yamlLineEnd). Their entries would read
 * otherwise apart. A line at its start in a plain value of several lines,
 * as YAML reads one, is no key's, and none of the others.
 */
function topLevelEntries(lines: readonly string[]): { key: string; yamlKey: string; start: number; end: number }[] | undefined {
  const entries: { key: string; yamlKey: string; start: number; end: number }[] = [];
  // The last line not a comment or blank, after which the next entry starts
  let content = -1;
  // The column a literal or folded value's lines are past, in one
  let literal = -1;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k].replace(/\r$/, '');
    if (literal >= 0) {
      if (isBlankLine(line)) continue;
      if (indentOf(line) > literal) {
        content = k;
        continue;
      }
      literal = -1;
    }
    if (isBlankLine(line) || line[0] === '#') continue;
    const end = yamlLineEnd(line);
    if (end === 'open') return undefined;
    if (end !== undefined) literal = end;
    if (line[0] === ' ' || line[0] === '\t' || isListItem(line)) {
      // A line of the key before it
      if (entries.length === 0) return undefined;
    } else {
      const yamlKey = blockKeyOf(line);
      if (yamlKey === undefined) return undefined;
      if (entries.length > 0) entries[entries.length - 1].end = content + 1;
      // The key as parseFrontmatter reads it too, to the first colon
      entries.push({ key: line.slice(0, line.indexOf(':')).trim(), yamlKey, start: content + 1, end: lines.length });
    }
    content = k;
  }
  return entries;
}

/**
 * The layout of the Markdown's frontmatter (see FrontmatterLayout), where
 * it has a key export reads nothing from: one whose name parseFrontmatter
 * doesn't read, as YAML reads it or as parseFrontmatter does, none of whose
 * lines gives a setting. A line of a key it reads, in a mapping or a
 * literal value under the key, gives one, which export writes to Word, and
 * the key goes as before, as import writes the setting. Each key held is
 * its lines as written, quotes, comments, spaces at line ends and all, with
 * the comments and blank lines before it, and those at the frontmatter's
 * end after the last, which a literal value that keeps its line ends, as
 * `|+`, has. Undefined, so that the keys go as before, where the
 * frontmatter isn't a block mapping topLevelEntries reads, or a key that
 * goes has an anchor, which a key held could refer to.
 */
export function frontmatterLayout(markdown: string): FrontmatterLayout | undefined {
  if (frontmatterBodyStartOffset(markdown) === undefined) return undefined;
  const lines = frontmatterYaml(markdown).split('\n');
  const entries = topLevelEntries(lines);
  if (!entries) return undefined;
  const layout: FrontmatterLayout = [];
  const named = new Set<string>();
  let unused = false;
  for (const entry of entries) {
    const entryLines = lines.slice(entry.start, entry.end);
    // As parseFrontmatter reads its lines among the others', as no block
    // list or mapping it reads goes past an entry's
    const { metadata, fieldOrder } = readFrontmatterLines(entryLines, []);
    const last = layout[layout.length - 1];
    if ((PARTLY_READ_KEYS.has(entry.key) || !READ_KEYS.has(entry.key) && !READ_KEYS.has(entry.yamlKey)) && Object.keys(metadata).length === 0) {
      // With those right before it, as nothing goes between them
      if (typeof last === 'object') last.text += '\n' + entryLines.join('\n');
      else layout.push({ text: entryLines.join('\n') });
      unused = true;
      continue;
    }
    if (entryLines.some(line => ANCHOR_RE.test(line))) return undefined;
    // The blank lines it starts with, after a key held, go with that key,
    // as a literal value's that keeps its line ends, as `|+`, do
    let blank = 0;
    while (blank < entryLines.length && isBlankLine(entryLines[blank])) blank++;
    if (typeof last === 'object' && blank > 0) last.text += '\n' + entryLines.slice(0, blank).join('\n');
    for (const key of fieldOrder) {
      if (!READ_KEYS.has(key) || named.has(key)) continue;
      named.add(key);
      layout.push(key);
    }
  }
  return unused ? layout : undefined;
}

/**
 * Serialize a Frontmatter object to a YAML frontmatter string.
 * Returns empty string if metadata has no fields. With a layout (see
 * frontmatterLayout), its keys export reads nothing from go back where they
 * were among the keys written from `metadata`, whose order is the
 * layout's, then `fieldOrder`'s for the rest, and a key in neither, as one
 * added in Word, goes after them all.
 */
export function serializeFrontmatter(metadata: Frontmatter, fieldOrder?: string[], layout?: FrontmatterLayout): string {
  const lines: string[] = [];
  const emitArr = (key: string, arr: (string | number)[] | undefined) => {
    if (!arr || arr.length === 0) return;
    if (arr.length === 1) lines.push(key + ': ' + arr[0]);
    else lines.push(key + ': [' + arr.join(', ') + ']');
  };

  // Map from YAML key name to emission function
  const emitters: Record<string, () => void> = {
    'title': () => { if (metadata.title && metadata.title.length > 0) { for (const t of metadata.title) lines.push(`title: ${t}`); } },
    'author': () => { if (metadata.author) lines.push(`author: ${metadata.author}`); },
    'csl': () => { if (metadata.csl) lines.push(`csl: ${metadata.csl}`); },
    'locale': () => { if (metadata.locale) lines.push(`locale: ${metadata.locale}`); },
    'zotero-notes': () => { if (metadata.zoteroNotes) lines.push(`zotero-notes: ${metadata.zoteroNotes}`); },
    'note-type': () => emitters['zotero-notes'](),
    'notes': () => { if (metadata.notes) lines.push(`notes: ${metadata.notes}`); },
    'timezone': () => { if (metadata.timezone) lines.push(`timezone: ${metadata.timezone}`); },
    'bibliography': () => { if (metadata.bibliography) lines.push(`bibliography: ${metadata.bibliography}`); },
    'bib': () => emitters['bibliography'](),
    'bibtex': () => emitters['bibliography'](),
    'font': () => { if (metadata.font) lines.push('font: ' + metadata.font); },
    'code-font': () => { if (metadata.codeFont) lines.push('code-font: ' + metadata.codeFont); },
    'font-size': () => { if (metadata.fontSize !== undefined) lines.push('font-size: ' + metadata.fontSize); },
    'code-font-size': () => { if (metadata.codeFontSize !== undefined) lines.push('code-font-size: ' + metadata.codeFontSize); },
    'header-font': () => emitArr('header-font', metadata.headerFont),
    'header-font-size': () => emitArr('header-font-size', metadata.headerFontSize),
    'header-font-style': () => emitArr('header-font-style', metadata.headerFontStyle),
    'title-font': () => emitArr('title-font', metadata.titleFont),
    'title-font-size': () => emitArr('title-font-size', metadata.titleFontSize),
    'title-font-style': () => emitArr('title-font-style', metadata.titleFontStyle),
    'table-font': () => { if (metadata.tableFont) lines.push('table-font: ' + metadata.tableFont); },
    'table-font-size': () => { if (metadata.tableFontSize !== undefined) lines.push('table-font-size: ' + metadata.tableFontSize); },
    'table-col-widths': () => { if (metadata.tableColWidths) lines.push('table-col-widths: ' + (typeof metadata.tableColWidths === 'string' ? metadata.tableColWidths : metadata.tableColWidths.join(' '))); },
    'table-borders': () => { if (metadata.tableBorders) lines.push('table-borders: ' + metadata.tableBorders); },
    'table-digits': () => { if (metadata.tableDigits !== undefined) lines.push('table-digits: ' + metadata.tableDigits); },
    'table-decimal-mark': () => { if (metadata.tableDecimalMark) lines.push('table-decimal-mark: ' + metadata.tableDecimalMark); },
    'table-digit-grouping': () => { if (metadata.tableDigitGrouping) lines.push('table-digit-grouping: ' + metadata.tableDigitGrouping); },
    'code-background-color': () => { if (metadata.codeBackgroundColor) lines.push('code-background-color: ' + metadata.codeBackgroundColor); },
    'code-background': () => emitters['code-background-color'](),
    'code-font-color': () => { if (metadata.codeFontColor) lines.push('code-font-color: ' + metadata.codeFontColor); },
    'code-color': () => emitters['code-font-color'](),
    'code-block-inset': () => { if (metadata.codeBlockInset !== undefined) lines.push('code-block-inset: ' + metadata.codeBlockInset); },
    'pipe-table-max-line-width': () => { if (metadata.pipeTableMaxLineWidth !== undefined) lines.push('pipe-table-max-line-width: ' + metadata.pipeTableMaxLineWidth); },
    'grid-table-max-line-width': () => { if (metadata.gridTableMaxLineWidth !== undefined) lines.push('grid-table-max-line-width: ' + metadata.gridTableMaxLineWidth); },
    'blockquote-style': () => { if (metadata.blockquoteStyle) lines.push('blockquote-style: ' + metadata.blockquoteStyle); },
    'callout-labels': () => { if (metadata.calloutLabels !== undefined) lines.push('callout-labels: ' + metadata.calloutLabels); },
    'colors': () => { if (metadata.colors) lines.push('colors: ' + metadata.colors); },
    'styles': () => {
      if (!metadata.styles || Object.keys(metadata.styles).length === 0) return;
      lines.push('styles:');
      for (const [name, def] of Object.entries(metadata.styles)) {
        lines.push('  ' + name + ':');
        if (def.font) lines.push('    font: ' + def.font);
        if (def.fontSize !== undefined) lines.push('    font-size: ' + def.fontSize);
        if (def.fontStyle) lines.push('    font-style: ' + def.fontStyle);
        if (def.spacingBefore !== undefined) lines.push('    spacing-before: ' + def.spacingBefore);
        if (def.spacingAfter !== undefined) lines.push('    spacing-after: ' + def.spacingAfter);
        if (def.paragraphIndent !== undefined) lines.push('    paragraph-indent: ' + def.paragraphIndent);
      }
    },
    'breaks': () => { if (metadata.breaks !== undefined) lines.push('breaks: ' + metadata.breaks); },
    'line-spacing': () => { if (metadata.lineSpacing !== undefined) lines.push('line-spacing: ' + metadata.lineSpacing); },
    'paragraph-indent': () => { if (metadata.paragraphIndent !== undefined) lines.push('paragraph-indent: ' + metadata.paragraphIndent); },
    'bibliography-hanging-indent': () => { if (metadata.bibliographyHangingIndent !== undefined) lines.push('bibliography-hanging-indent: ' + metadata.bibliographyHangingIndent); },
    'crossref': () => {
      const crossref = metadata.crossref;
      if (!crossref) return;
      const keys: string[] = [];
      if (crossref.figTitle !== undefined) keys.push('  fig-title: ' + yamlScalarText(crossref.figTitle));
      if (crossref.tblTitle !== undefined) keys.push('  tbl-title: ' + yamlScalarText(crossref.tblTitle));
      if (crossref.titleDelim !== undefined) keys.push('  title-delim: ' + yamlScalarText(crossref.titleDelim));
      if (keys.length === 0) return;
      lines.push('crossref:');
      pushAll(lines, keys);
    },
    'fig-cap-location': () => { if (metadata.figCapLocation) lines.push('fig-cap-location: ' + metadata.figCapLocation); },
    'tbl-cap-location': () => { if (metadata.tblCapLocation) lines.push('tbl-cap-location: ' + metadata.tblCapLocation); },
  };

  // Default emission order (backward compatible)
  const defaultOrder = [
    'title', 'author', 'csl', 'locale', 'zotero-notes', 'notes', 'timezone',
    'bibliography', 'font', 'code-font', 'font-size', 'code-font-size',
    'header-font', 'header-font-size', 'header-font-style',
    'title-font', 'title-font-size', 'title-font-style',
    'table-font', 'table-font-size', 'table-col-widths', 'table-borders',
    'table-digits', 'table-decimal-mark', 'table-digit-grouping',
    'code-background-color', 'code-font-color', 'code-block-inset',
    'pipe-table-max-line-width', 'grid-table-max-line-width',
    'blockquote-style', 'callout-labels', 'colors', 'styles', 'breaks',
    'line-spacing', 'paragraph-indent', 'bibliography-hanging-indent',
    'crossref', 'fig-cap-location', 'tbl-cap-location',
  ];

  const aliasToCanonical: Record<string, string> = {
    'note-type': 'zotero-notes',
    'bib': 'bibliography',
    'bibtex': 'bibliography',
    'code-background': 'code-background-color',
    'code-color': 'code-font-color',
  };

  const canonicalToAliases: Record<string, string[]> = {};
  for (const [alias, canonical] of Object.entries(aliasToCanonical)) {
    if (!canonicalToAliases[canonical]) canonicalToAliases[canonical] = [];
    canonicalToAliases[canonical].push(alias);
  }

  const order = fieldOrder && fieldOrder.length > 0 ? fieldOrder : defaultOrder;
  const emitted = new Set<string>();

  const emit = (key: string) => {
    if (emitted.has(key)) return;
    emitted.add(key);
    const canonical = aliasToCanonical[key];
    if (canonical) {
      emitted.add(canonical);
      const siblingAliases = canonicalToAliases[canonical];
      if (siblingAliases) for (const a of siblingAliases) emitted.add(a);
    }
    const aliases = canonicalToAliases[key];
    if (aliases) for (const a of aliases) emitted.add(a);
    const emitter = emitters[key];
    if (emitter) emitter();
  };
  // The keys export read nothing from, as written, each after the keys
  // before it in the Markdown that are written here and before those after
  // it. One that's first goes without the blank lines it starts with,
  // which would make the opening --- a rule.
  for (const item of layout ?? []) {
    if (typeof item === 'string') {
      emit(item);
      continue;
    }
    const held = item.text.split('\n');
    let start = 0;
    if (lines.length === 0) while (start < held.length && isBlankLine(held[start])) start++;
    pushAll(lines, held.slice(start));
  }
  for (const key of order) emit(key);

  // Emit any remaining fields not in the provided order
  for (const key of defaultOrder) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    const emitter = emitters[key];
    if (emitter) emitter();
  }

  if (lines.length === 0) return '';
  return '---\n' + lines.join('\n') + '\n---\n';
}

/** Ensure a bibliography path ends with .bib */
export function normalizeBibPath(p: string): string {
  if (!p) return p;
  return p.endsWith('.bib') ? p : p + '.bib';
}
