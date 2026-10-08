import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { asXmlNodes, ommlToLatex, type XmlNode } from './omml';
import { resolveMarkdownColor } from './highlight-colors';
import { FRONTMATTER_OPENING_RE, Frontmatter, NotesMode, parseFrontmatter, serializeFrontmatter, noteTypeFromNumber, noteTypeToNumber, parseColWidths, type BlockquoteStyle, type CustomStyleDef } from './frontmatter';
import { gfmAlertTitle, parseGfmAlertMarker, toGfmAlertMarker, type GfmAlertType } from './gfm';
import { emuToPixels, isSupportedImageFormat, resolveImageFilename } from './image-utils';
import { keepParagraphEdgeWhitespace } from './html-entities';
import htmlBlockNames from 'markdown-it/lib/common/html_blocks.mjs';
import { HTML_OPEN_CLOSE_TAG_RE, HTML_TAG_RE } from 'markdown-it/lib/common/html_re.mjs';
import { isMdAsciiPunct, isPunctChar, isWhiteSpace, unescapeAll } from 'markdown-it/lib/common/utils.mjs';
import { computeCodeRegions, computeMarkdownRegions, isInsideCodeRegion } from './code-regions';
import { findDollarMathAt } from './math-delimiters';
import { getDisplayWidth, GRID_TABLE_SEPARATOR_RE, readGridTableCells, type TableAlign } from './grid-table-preprocess';
import { escapeBibtexText, parseBibtex, parseBibtexWithRaw, mergeBibtex } from './bibtex-parser';
import { blocksAsRead, citationEndInText, commentsEnd, compareNoteLabels, countsForIndent, customStyleId, directiveRest, htmlBlocksIn, isLineBreakBlock, linkifiedColons, linkifiedText, linkifyMatches, outsideComments, parseMd, readsAsParagraph, readsCommentsInline, startsHtmlBlock } from './md-to-docx';
import { parseEmbedDirective } from './embed-preprocess';
import { parseTableDigits, parseTableDecimalMark, parseTableDigitGrouping } from './table-number-format';
import { matchTables, tableContentsFingerprint, tableFirstRowText, tableIdentity as tableIdentityOf, type TableIdentity } from './table-metadata';
import { htmlPieceAt } from './html-table-parser';
import { publicStyleNameForZoteroId, zoteroStyleIdForName } from './csl-loader';
import { extractZoteroKey } from './zotero-link';
import { DISPLAY_MATH_ENVIRONMENTS } from './latex-env-preprocess';

// --- Implementation notes ---
// Table parsing:
// - Handle pipes in code/quotes; careful boundary detection
// - Prefer HTML table output; preserve in-cell semantics
// - Table HTML with ID comments: emit deferred bodies outside <p> tags
//
// Commented text:
// - Group adjacent runs by identical commentIds even when formatting differs
// - Comment ID remap: collect IDs from top-level and nested table-cell paragraphs
// - Cross-paragraph overlap detection: global via detectGlobalOverlaps() during
//   buildMarkdown metadata collection, not per-segment
// - Non-numeric comment ID roundtrip: persist mapping in docProps/custom.xml under
//   MANUSCRIPT_COMMENT_IDS[_N]
//
// Run formatting:
// - Apply w:pPr/w:rPr defaults; only override for explicit run-level w:rPr
//
// Hyperlinks:
// - Wrap URLs with parens, whitespace, [, or ] in angle brackets
//
// Zotero:
// - URI key extraction: /\/items\/([A-Z0-9]{8})$/ works for all three URI formats
// - citationItems: check both uris (array) and uri (singular)
// - Locators: belong in Pandoc citations ([@key, p. 20]), not BibTeX entries
// - Numeric locators: coerce to string with String() during extraction
// - Grouped citations: mixed groups always produce unified output
//
// CSL:
// - Year: only set issued.date-parts when year is fully numeric; never emit [[null]]
//
// Citations:
// - buildCitationKeyMap: one map for the body's and the notes' citations, so no
//   two items share a key and each gets a .bib entry, wherever it's cited
//
// Footnotes:
// - Multi-line indent: use block form when bodyParts[0] is multi-line; indent all
//   continuation lines
// - Fence detection: check for continuation lines before fence markers when currentLabel
//   is defined
// - Display math: treat item.type === 'math' && item.display as its own body part
// - stopBeforeDisplayMath: body/footnote renderInlineRange calls must pass
//   { stopBeforeDisplayMath: true }; table-cell calls (via renderInlineSegment)
//   intentionally omit this since display math doesn't split table cells

/** Matches a "Sources" heading (with or without leading `#` markers). */
const SOURCES_HEADING_RE = /^(?:#+\s*)?Sources\s*$/;

// Types

export interface Comment {
  author: string;
  text: string;
  date: string;
  paraId?: string;         // w14:paraId from <w:p> in comments.xml
  replies?: CommentReply[];
  consecutiveReplies?: boolean; // true when original MD used consecutive {>>...<<} format for replies
}
export async function extractBlockquotePreContentBlankLineMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_BLOCKQUOTE_PRE_CONTENT_BLANK_LINES');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const groupIdx = parseInt(key, 10);
      // Preserve sentinel -1 (used when non-blockquote content exists between
      // groups in source) in addition to non-negative blank-line counts.
      if (isNaN(groupIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < -1) continue;
      mapping.set(groupIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}
export async function extractBlockquotePostContentBlankLineMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_BLOCKQUOTE_POST_CONTENT_BLANK_LINES');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const groupIdx = parseInt(key, 10);
      if (isNaN(groupIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < -1) continue;
      mapping.set(groupIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

const ALERT_STYLE_TO_TYPE: Record<string, GfmAlertType> = {
  githubnote: 'note',
  githubtip: 'tip',
  githubimportant: 'important',
  githubwarning: 'warning',
  githubcaution: 'caution',
};

const ALERT_GLYPH_TO_TYPE: Record<string, GfmAlertType> = {
  '※': 'note',
  '◈': 'tip',
  '‼': 'important',
  '▲': 'warning',
  '⛒': 'caution',
};

export interface CommentReply {
  author: string;
  text: string;
  date: string;
}

export interface CitationMetadata {
  authors: Array<{ family?: string; given?: string; literal?: string }>;
  title: string;
  year: string;
  journal: string;
  volume: string;
  pages: string;
  doi: string;
  type: string;
  fullItemData: Record<string, unknown>;
  zoteroKey?: string;
  zoteroUri?: string;
  zoteroUris?: string[];  // all the URIs the field lists for the item, its own first (see citedItems)
  itemId?: string;        // the item's ID in the field (see itemIdentifier)
  locator?: string;
  citationKey?: string;   // CSL citation-key preserved for round-trip
  suppressAuthor?: boolean; // [-@key] Pandoc suppress-author form
  prefix?: string;          // [e.g., @key] Pandoc citation prefix
}

/** Each Zotero field in the document produces one of these. */
export interface ZoteroCitation {
  /** The plainCitation text from Zotero (e.g. "(Bearak et al. 2020)") */
  plainCitation: string;
  /** Metadata for each cited item in this field */
  items: CitationMetadata[];
}

/** Character-level formatting flags */
export interface RunFormatting {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  highlight: boolean;
  highlightColor?: string;
  superscript: boolean;
  subscript: boolean;
  code: boolean;
}

/** Returns true when any formatting flag is set (text won't survive GFM autolink). */
function hasFormatting(fmt: RunFormatting): boolean {
  return fmt.bold || fmt.italic || fmt.underline || fmt.strikethrough ||
    fmt.highlight || fmt.superscript || fmt.subscript || fmt.code;
}

/** List metadata for a paragraph */
export interface ListMeta {
  type: 'bullet' | 'ordered';
  level: number; // 0-based indentation level
  startNumber?: number; // ordered list start number (when ≠ 1)
  wordNumber?: number; // ordered: the number Word shows for the item (see wordListCounter)
  wordStarts?: boolean; // ordered: Word starts its level's numbering over at the item
  bulletMarker?: '-' | '*' | '+'; // authored unordered-list marker for round-trip
  taskChecked?: boolean; // a task list item, checked or not
}

export const DEFAULT_FORMATTING: Readonly<RunFormatting> = Object.freeze({
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  highlight: false,
  superscript: false,
  subscript: false,
  code: false,
});

// Revision-bearing elements mapped to their CriticMarkup type.
// w:ins/w:moveTo → addition, w:del/w:moveFrom → deletion.
const REVISION_ELEMENTS: Record<string, 'addition' | 'deletion'> = {
  'w:ins': 'addition', 'w:del': 'deletion',
  'w:moveTo': 'addition', 'w:moveFrom': 'deletion',
};

// Tags that are interpreted semantically by the MD→DOCX parser/preview pipeline
// and therefore must be escaped when they occur as literal plain text in DOCX.
const MARKDOWN_HTML_SENSITIVE_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  's',
  'del',
  'strike',
  'u',
  'sup',
  'sub',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'img',
  'br',
]);

const HTML_LIKE_TAG_RE = /<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*?)?\/?>/;
const HTML_LIKE_TAG_AT = new RegExp(HTML_LIKE_TAG_RE.source, 'y');

// Whether export reads the text markedFormatting writes as Markdown: not in
// an HTML table's cell, which it reads as HTML (see renderHtmlTable)
let readsMarkdown = true;

// The keys export knows of: those of the document's citations and its
// bibliography, those whose citation data it found missing, as the notes
// it writes at the document's end say, as "Citation data for @a was not
// found in the bibliography file.", and those of a deletion's citations,
// whose missing data it doesn't note. It writes a citation of them as its
// text where it can't write the citation, as for a missing key or in a
// deletion, so that text, as [@a], stays a citation (see citationKnown)
let knownCitationKeys: ReadonlySet<string> = new Set();

// Whether export notes the missing citation data of a citation here, which
// it doesn't for one in a note, whose text, as [@a], stays a citation
let citationsNoted = true;

const MISSING_CITATION_NOTE_RE = /^Citation data for @(.+) was not found in the bibliography file\.$/;

/** The keys of the notes of missing citation data in `content`: a
 *  paragraph of plain text alone, as export writes one, the first too,
 *  which no para item starts */
function missingCitationKeys(content: ContentItem[]): Set<string> {
  const keys = new Set<string>();
  let text: string | undefined = '';
  const end = () => {
    const note = text !== undefined ? MISSING_CITATION_NOTE_RE.exec(text) : null;
    if (note) keys.add(note[1]);
  };
  for (const item of content) {
    if (item.type === 'para') {
      end();
      text = '';
    } else if (endsInlineRange(item)) {
      // A table, a section's or a style's marker or the bibliography's
      // starts no para item, but ends the paragraph before it
      end();
      text = undefined;
    } else if (text !== undefined) {
      text = item.type === 'text' && !item.href && !item.revision && !hasFormatting(item.formatting) ? text + item.text : undefined;
    }
  }
  end();
  return keys;
}

/** The keys of the text of citations in deletions in `content` and its
 *  tables' cells, as [@a], read across the runs of a deletion, which
 *  mergeConsecutiveRuns joins, and from a [ to the first ] after it, as
 *  export reads [@a[b] */
function deletedCitationKeys(content: ContentItem[]): Set<string> {
  const keys = new Set<string>();
  const readText = (text: string) => {
    // Each [ once, and the ] after it once for all the [ before it: a [ with
    // another before its ] is a citation's only where a key starts it
    for (let i = text.indexOf('['), close = -1; i !== -1;) {
      if (close < i) close = text.indexOf(']', i);
      if (close === -1) break;
      const inner = text.indexOf('[', i + 1);
      if (inner !== -1 && inner < close && !/^-?@/.test(text.slice(i + 1, i + 3))) {
        i = inner;
        continue;
      }
      for (const key of bracketKeys(text.slice(i + 1, close))) keys.add(key);
      i = text.indexOf('[', close + 1);
    }
  };
  const read = (items: ContentItem[]) => {
    let deleted = '';
    for (const item of items) {
      if (item.type === 'text' && item.revision?.type === 'deletion') {
        deleted += item.text;
        continue;
      }
      readText(deleted);
      deleted = '';
      if (item.type === 'table') for (const row of item.rows) for (const cell of row.cells) cell.paragraphs.forEach(read);
    }
    readText(deleted);
  };
  read(content);
  return keys;
}

/** A run's line break as export reads it there */
function lineBreakText(): string {
  return readsMarkdown ? '\\\n' : '<br>';
}

/** Syntax, CriticMarkup's, a citation's or an image's, as export reads it
 *  there: in an HTML table's cell, which holds it as text, as import writes
 *  that text when it comes back (see htmlLineCharacters), with its <, > and
 *  & as references, but for those of CriticMarkup's delimiters, so a tag in
 *  a comment's body, a citation's locator or an image's alt text stays
 *  text, and it reads back as written. A body in ID syntax goes after the
 *  table, where export reads Markdown, as it is. */
function syntaxText(markdown: string): string {
  return readsMarkdown ? markdown : htmlLineCharacters(markdown).join('');
}

/** A run of a line break alone as Markdown, in a link of its own where it's
 *  a link's, as where it's all of the link's runs or a comment's range
 *  leaves it out of the rest, which keeps it in the hyperlink */
function lineBreakRun(item: { href?: string }): string {
  return item.href ? markdownLink(lineBreakText(), item.href) : lineBreakText();
}

/** `text` with the tags export reads as formatting or a line break written
 *  as text, but for one at a position in `raw`, which export reads as it is,
 *  as in a citation's keys (see escapeMarkdownChars) */
function escapeSensitiveHtmlLikeTags(text: string, raw?: Set<number>): string {
  return text.replace(new RegExp(HTML_LIKE_TAG_RE.source, 'g'), (fullMatch, tagName: string, offset: number) => {
    if (!MARKDOWN_HTML_SENSITIVE_TAGS.has(tagName.toLowerCase()) || raw?.has(offset)) return fullMatch;
    return fullMatch.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
}

// The HTML blocks markdown-it reads that can start inside a paragraph: all
// but a line of one tag (see its html_block rule)
// The HTML blocks that end at their own marker, not at a blank line
const HTML_BLOCK_ENDS_AT_MARKER = /^<(?:(?:script|pre|style|textarea)(?=[\s>]|$)|!--|\?|![A-Za-z]|!\[CDATA\[)/i;

const HTML_BLOCK_IN_PARAGRAPH = [
  /^<(script|pre|style|textarea)(?=(\s|>|$))/i, /^<!--/, /^<\?/, /^<![A-Z]/, /^<!\[CDATA\[/,
  new RegExp('^</?(' + htmlBlockNames.join('|') + ')(?=(\\s|/?>|$))', 'i'),
];

// The HTML blocks that end at a marker, with it: a script, pre, style or
// textarea, a processing instruction, a declaration and a CDATA section
const HTML_BLOCKS_WITH_END: Array<[RegExp, RegExp]> = [
  [HTML_BLOCK_IN_PARAGRAPH[0], /<\/(script|pre|style|textarea)>/i],
  [HTML_BLOCK_IN_PARAGRAPH[2], /\?>/], [HTML_BLOCK_IN_PARAGRAPH[3], />/], [HTML_BLOCK_IN_PARAGRAPH[4], /\]\]>/],
];
// A line of one tag, which starts an HTML block, though not in a paragraph
const HTML_TAG_LINE = new RegExp(HTML_OPEN_CLOSE_TAG_RE.source + '\\s*$');

/** Whether text is an HTML block that ends in it, which Markdown reads as it
 *  is: one of a block's tag or that starts with a line of one tag, which a
 *  blank line ends, or one that ends at a marker with it. Not a comment,
 *  which export reads as the converter's own, nor a line of a tag import
 *  writes as a reference (see escapeSensitiveHtmlLikeTags) */
function isHtmlBlock(text: string): boolean {
  const withEnd = HTML_BLOCKS_WITH_END.find(([start]) => start.test(text));
  if (withEnd) return withEnd[1].test(text);
  const line = text.split('\n', 1)[0];
  const tag = HTML_LIKE_TAG_RE.exec(line);
  return HTML_BLOCK_IN_PARAGRAPH[5].test(text)
    || HTML_TAG_LINE.test(line) && !(tag && MARKDOWN_HTML_SENSITIVE_TAGS.has(tag[1].toLowerCase()));
}

// An HTML tag, comment or the like, as markdown-it reads one, from an offset
const HTML_TAG_AT = new RegExp(HTML_TAG_RE.source.replace(/^\^/, ''), 'y');
/** An HTML comment's or declaration's start, or an autolink, a URL's as
 *  markdown-it reads one, of any length, with no space, control character,
 *  < or > after its scheme, or an email address's, at lastIndex */
const COMMENT_OR_AUTOLINK_AT = /<(?:[!?]|[A-Za-z][A-Za-z\d+.-]{1,31}:[!-;=?-\uFFFF]*>|[^\s<>@]+@[^\s<>]+>)/y;

/**
 * The offsets of the lines after a paragraph's line breaks, a backslash at a
 * line's end, outside the text its Markdown keeps raw: an HTML block, an
 * HTML comment or tag, a comment's body, code, math and a citation. One
 * pass from the left,
 * as Markdown reads them: an escaped character, a comment, a run of
 * backticks with the code up to the next run as long, math, a tag, or a
 * bracket with a citation's key, up to the next ], takes the text it
 * covers. A closer's search goes on from where its last one ended, so the
 * pass is linear, but for math and tags, whose search is the parser's.
 */
function lineStartsAfterBreaks(text: string): number[] {
  const starts: number[] = [];
  // Each closer's offset from its last search, -1 for none
  const closers = new Map<string, number>();
  const closerFrom = (closer: string, from: number): number => {
    let at = closers.get(closer);
    if (at === undefined || (at !== -1 && at < from)) closers.set(closer, at = text.indexOf(closer, from));
    return at;
  };
  // The start of each run of backticks, by its length, and each length's
  // first run not yet passed
  const runs = new Map<number, number[]>();
  for (const run of text.matchAll(/`+/g)) {
    const list = runs.get(run[0].length);
    if (list) list.push(run.index);
    else runs.set(run[0].length, [run.index]);
  }
  const passed = new Map<number, number>();
  const runFrom = (length: number, from: number): number => {
    const list = runs.get(length) ?? [];
    let k = passed.get(length) ?? 0;
    while (k < list.length && list[k] < from) k++;
    passed.set(length, k);
    return k < list.length ? list[k] : -1;
  };
  const comment = /\{(?:#[\w-]+)?>>/y;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') starts.push(i + 2);
      i += 2;
    } else if (c === '<' && /^<!---?>/.test(text.slice(i, i + 6))) {
      // A comment as short as <!--> or <!--->
      i += text[i + 4] === '>' ? 5 : 6;
    } else if (c === '<' && text.startsWith('<!--', i)) {
      const end = closerFrom('-->', i + 4);
      i = end === -1 ? i + 4 : end + 3;
    } else if (c === '{' && (comment.lastIndex = i, comment.test(text))) {
      const end = closerFrom('<<}', comment.lastIndex);
      i = end === -1 ? comment.lastIndex : end + 3;
    } else if (c === '`') {
      let length = 1;
      while (text[i + length] === '`') length++;
      const end = runFrom(length, i + length);
      i = end === -1 ? i + length : end + length;
    } else if (c === '$') {
      const math = findDollarMathAt(text, i, { displayRun: 'at-least' });
      i = math?.kind === 'math' ? math.end : i + 1;
    } else if (c === '<' && /[A-Za-z/!?]/.test(text[i + 1] ?? '')) {
      HTML_TAG_AT.lastIndex = i;
      i = HTML_TAG_AT.test(text) ? HTML_TAG_AT.lastIndex : i + 1;
    } else if (c === '[') {
      // A citation, as export reads one, whose text it keeps as it is.
      // One with a [ before its ] would start with a key, which the
      // search for both rules out first, as it goes on from the last.
      const close = closerFrom(']', i + 1);
      const open = closerFrom('[', i + 1);
      const end = close !== -1 && (open === -1 || open > close || /^-?@/.test(text.slice(i + 1, i + 3)))
        ? citationEndInText(text, i) : -1;
      i = end === -1 ? i + 1 : end + 1;
    } else {
      i++;
    }
  }
  // Not in an HTML block, which a paragraph can start, or a line in it
  const html = text.includes('<') ? computeMarkdownRegions(text, { includeCode: false, html: 'all' }).htmlRegions : [];
  return html.length > 0 ? starts.filter(start => !isInsideCodeRegion(start, html)) : starts;
}

/**
 * A paragraph's text with the whitespace Markdown would lose written as
 * character references: at its edges (see keepParagraphEdgeWhitespace), and
 * the spaces and tabs at the start of a line after a line break, which
 * Markdown drops there, outside the text it keeps raw.
 */
export function keepParagraphWhitespace(text: string, atStart: boolean, atEnd: boolean): string {
  const reference = (whitespace: string) => whitespace.replace(/[ \t]/g, c => c === ' ' ? '&#32;' : '&#9;');
  if (text.includes('\\\n')) {
    let kept = '';
    let last = 0;
    const indent = /[ \t]+/y;
    for (const start of lineStartsAfterBreaks(text)) {
      indent.lastIndex = start;
      const whitespace = indent.exec(text);
      if (!whitespace) continue;
      kept += text.slice(last, start) + reference(whitespace[0]);
      last = indent.lastIndex;
    }
    text = kept + text.slice(last);
  }
  return keepParagraphEdgeWhitespace(text, atStart, atEnd);
}

// A line break as Markdown writes one, a \ that isn't escaped before a line
// end, with the escaped ones before it, and the spaces and tabs after it if
// they end the text
const HARD_BREAK = /(?<!\\)((?:\\\\)*)\\\n([ \t]+$)?/g;
const HARD_BREAK_AT_END = /(?<!\\)((?:\\\\)*)\\\n$/;
// One before the == of a highlight that ends the text, but for spaces and
// tabs, which alone on the text's last line would read as a heading's
// underline (see wrapHighlight)
const HARD_BREAK_BEFORE_HIGHLIGHT_CLOSE_AT_END = /(?<!\\)((?:\\\\)*)\\\n(==[ \t]*)$/;
const HARD_BREAKS_AT_END = /(?<!\\)((?:\\\\)*)(?:\\\n)+$/;
/** HTML comments that start a paragraph's text, after its indent, each with
 *  the spaces and tabs after it, and the line breaks after them that end it,
 *  with the spaces and tabs between them: the two, where they're all of it.
 *  Found as commentsEnd finds the comments, as the regex this was ran many
 *  times slower past some tens of thousands of a comment's characters. */
function commentsBeforeBreaks(text: string): [string, string] | undefined {
  if (!text.endsWith('\\\n')) return undefined;
  let start = 0;
  while (text[start] === ' ' || text[start] === '\t') start++;
  const end = commentsEnd(text, start);
  if (end === start) return undefined;
  for (let at = end; text.startsWith('\\\n', at);) {
    at += 2;
    if (at === text.length) return [text.slice(0, end), text.slice(end)];
    while (text[at] === ' ' || text[at] === '\t') at++;
  }
  return undefined;
}

/** The column a line's text ends at, as Markdown counts them, a tab going
 *  on to the next stop, every four columns */
function columnAfter(line: string): number {
  let column = 0;
  for (const c of line) column = c === '\t' ? column + 4 - column % 4 : column + 1;
  return column;
}

/** Whether the last line of `output`, before the line ends after it, is an
 *  HTML comment of its own, as Markdown reads one, whose HTML block ends at
 *  that line, after a quote's > or an indent: back from the end, to that
 *  line's start alone */
function afterCommentLine(output: string[]): boolean {
  let line = '';
  for (let k = output.length - 1; k >= 0; k--) {
    const piece = k === output.length - 1 || line === '' ? output[k].replace(/\n+$/, '') : output[k];
    const start = piece.lastIndexOf('\n');
    line = piece.slice(start + 1) + line;
    if (start !== -1 || (line !== '' && k === 0)) break;
  }
  return /^(?:[ \t]*>)*[ \t]*<!--(?:(?!-->)[\s\S])*-->[ \t]*$/.test(line);
}

/** Whether an item of `target` from `index`, where a comment's range
 *  started, is in the range, `id`'s, or the one before, an HTML comment that
 *  the rest of its hidden run, which Word split after the range's start,
 *  joined (see readHiddenText), which is then in the range all of it */
function rangeHolds(target: ContentItem[], index: number, id: string): boolean {
  for (let k = Math.max(0, index - 1); k < target.length; k++) {
    const item = target[k];
    if ('commentIds' in item && item.commentIds?.has(id)) return true;
  }
  return false;
}

/**
 * An empty item at the end of a paragraph's items in `target`, from `from`,
 * for the comments whose ranges start after its text, at its mark, and end
 * in a paragraph after it, which start there, as a zero-width one does, not
 * at the next one's text. It has no formatting, which would write code's ``
 * as text.
 */
function startRangesAtMark(
  target: ContentItem[], from: number, starts: Map<string, { target: ContentItem[]; index: number }>, active: Set<string>,
): void {
  const empty = (id: string, index: number) => !target.slice(index).some(item => 'commentIds' in item && item.commentIds?.has(id));
  if ([...starts].some(([id, start]) => start.target === target && start.index >= from && active.has(id) && empty(id, start.index))) {
    target.push({ type: 'text', text: '', formatting: DEFAULT_FORMATTING, commentIds: new Set(active), href: undefined });
  }
}

/**
 * Drops a paragraph's items in `target`, from `from`, where they are spaces
 * and tabs alone, as plain, bold or italic text, which Markdown writes as
 * they are and reads as a blank line, so that the paragraph is an empty one,
 * with the same Markdown as Word's empty paragraph there. Text Markdown
 * writes in tags or delimiters, as underlined text or code, or with a
 * comment, a tracked change or a link, stays, as does a no-break space,
 * which a Word user keeps an empty line with. Returns whether it dropped
 * them.
 */
function dropBlankParagraphText(target: ContentItem[], from: number): boolean {
  const items = target.slice(from);
  if (!items.some(item => item.type === 'text' && item.text !== '') || !items.every(isBlankText)) return false;
  target.length = from;
  return true;
}

/** Whether `item` is spaces and tabs alone, or nothing, that Markdown writes
 *  as they are (see dropBlankParagraphText) */
function isBlankText(item: ContentItem): item is Extract<ContentItem, { type: 'text' }> {
  return isPlainText(item) && /^[ \t]*$/.test(item.text);
}

/** Whether `item` is text whose whitespace Markdown writes as it is, in no
 *  change, comment's range, link or formatting written around it */
function isPlainText(item: ContentItem): item is Extract<ContentItem, { type: 'text' }> {
  return item.type === 'text' && item.commentIds.size === 0 && !item.revision && !item.href
    && !item.formatting.underline && !item.formatting.strikethrough && !item.formatting.highlight
    && !item.formatting.code && !item.formatting.superscript && !item.formatting.subscript;
}

/** Whether text next to an item starts or ends a Markdown block there: at
 *  the end of the content, a paragraph break, a table, or a display
 *  equation, which is a block of its own in Markdown. */
function isMarkdownBlockEdge(item: ContentItem | undefined): boolean {
  return item === undefined || isStructuralBoundaryItem(item) || (item.type === 'math' && !!item.display);
}

/** Whether `item` is display math in the paragraph of the text before it,
 *  which the paragraph goes on in, on the lines after the text */
function isInParagraphMath(item: ContentItem | undefined): boolean {
  return item?.type === 'math' && item.display && !!item.inParagraph;
}

const ASCII_PUNCTUATION_RE = /[!-\/:-@[-`{-~]/;
const WORD_CHARACTER_RE = /[\p{L}\p{N}]/u;

/** Whether the run of = at `start`, `length` long, could open or close a
 *  highlight, whose == pairs with the next, wherever it is: in the text or
 *  the runs `after` it */
function equalsOpensHighlight(text: string, start: number, length: number, after?: RunsAfter): boolean {
  if (length < 2) return false;
  // Four or more pair with each other, as an empty highlight
  if (length >= 4 || start === 0 || start + length === text.length) return true;
  const first = text.indexOf('==');
  return first + 2 <= start || text.lastIndexOf('==') >= start + length || !!after?.hasEquals;
}

/** Where a line of Word's text, from `start` to `end`, starts a block in
 *  Markdown, the character a backslash goes before */
function blockSyntaxAt(text: string, start: number, end: number): number | undefined {
  const line = text.slice(start, end);
  const indent = /^ {0,3}/.exec(line)![0].length;
  const rest = line.slice(indent);
  const at = start + indent;
  // A heading, list item or quote
  if (/^(?:#{1,6}|[-+*])(?:[ \t]|$)/.test(rest) || rest[0] === '>') return at;
  const ordered = /^(\d{1,9})[.)](?:[ \t]|$)/.exec(rest);
  if (ordered) return at + ordered[1].length;
  // A thematic break, or an underline that makes the line before a heading
  if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest) || /^(?:=+|-+)[ \t]*$/.test(rest)) return at;
  // An HTML block, unless escapeSensitiveHtmlLikeTags writes the tag as
  // text. A line of one tag only starts one at a paragraph's start, where
  // the paragraph is that line, as export writes it, and reads as it is.
  const tag = HTML_LIKE_TAG_RE.exec(rest);
  if (HTML_BLOCK_IN_PARAGRAPH.some(opener => opener.test(rest)) && !(tag?.index === 0 && MARKDOWN_HTML_SENSITIVE_TAGS.has(tag[1].toLowerCase()))) return at;
  // A table's delimiter row, under a line that would be its header
  if (rest.includes('|') && /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(rest)) return at;
  // A task list item's box, an alert's marker, or a link's definition
  if (/^\[(?:[ xX]\]|!)/.test(rest) || /^\[[^\]]+\]:/.test(rest)) return at;
  // A LaTeX environment, which export reads as display math
  const environment = /^\\begin\{([a-zA-Z*]+)\}/.exec(rest);
  if (environment && DISPLAY_MATH_ENVIRONMENTS.has(environment[1])) return at;
  return undefined;
}

/** A text's ]s and runs of dollar signs, where they are, and the run of
 *  each length class, one sign or more, at or after each run */
interface TextIndex {
  text: string;
  closers: number[];
  /** The ]s outside a comment's text, which a link's text can close at, as
   *  markdown-it reads its label past a comment, though a citation's key
   *  ends at one in it */
  linkClosers: number[];
  dollarRuns: Array<{ start: number; length: number }>;
  dollarStarts: number[];
  nextSingle: number[];
  nextDouble: number[];
  /** Where each run of two or more = starts */
  equals: number[];
  /** Where the last == that isn't in the text goes, as in a comment's
   *  body or past a display equation, after the runs before it in their
   *  Markdown block, or -1 (see laterEqualsAfter) */
  laterEquals: number;
  /** Where each @, ; and [ is */
  ats: number[];
  semicolons: number[];
  openers: number[];
  /** Where each note reference and citation is, whose [ before its ]
   *  ends a citation before it, as [^1] and [@b] do */
  bracketed: number[];
}

/** `text`'s index, where a run of dollar signs ends at each of `bounds`,
 *  the starts of runs, between which formatting's or a span's delimiters
 *  can come, with note references and citations at `bracketed`, the last
 *  == that isn't in it at `laterEquals`, and comments from each even one
 *  of `comments` to the next */
function indexText(text: string, bounds: ReadonlySet<number> = new Set(), bracketed: number[] = [], laterEquals = -1, comments: number[] = []): TextIndex {
  const closers: number[] = [];
  const dollarRuns: Array<{ start: number; length: number }> = [];
  const equals: number[] = [];
  const ats: number[] = [];
  const semicolons: number[] = [];
  const openers: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ']') closers.push(i);
    else if (text[i] === '@') ats.push(i);
    else if (text[i] === ';') semicolons.push(i);
    else if (text[i] === '[') openers.push(i);
    else if (text[i] === '=' && text[i + 1] === '=' && text[i - 1] !== '=') equals.push(i);
    else if (text[i] === '$') {
      let length = 1;
      while (text[i + length] === '$' && !bounds.has(i + length)) length++;
      dollarRuns.push({ start: i, length });
      i += length - 1;
    }
  }
  const nextSingle: number[] = new Array(dollarRuns.length + 1).fill(-1);
  const nextDouble: number[] = new Array(dollarRuns.length + 1).fill(-1);
  for (let k = dollarRuns.length - 1; k >= 0; k--) {
    nextSingle[k] = dollarRuns[k].length === 1 ? k : nextSingle[k + 1];
    nextDouble[k] = dollarRuns[k].length > 1 ? k : nextDouble[k + 1];
  }
  const linkClosers = comments.length === 0 ? closers : closers.filter(at => lowerBound(comments, at + 1) % 2 === 0);
  return { text, closers, linkClosers, dollarRuns, dollarStarts: dollarRuns.map(run => run.start), nextSingle, nextDouble, equals, laterEquals, ats, semicolons, openers, bracketed };
}

/** The first of `sorted` at or after `value` */
function lowerBound(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The items of a paragraph whose text an index reads, where each starts
 *  in it, and which of them is the first of the runs after one */
interface IndexedRuns {
  offsets: number[];
  items: ContentItem[];
  at: number;
}

/** The most of the runs after one that a URL's host in it reads on into
 *  (see RunsAfter.hostAfter): more than a host's 253 characters */
const HOST_LOOKAHEAD = 256;

/** The delimiters Markdown writes around a run's text for its formatting,
 *  as wrapFormatting writes them, outermost first, to open and close it */
function formattingDelimiters(fmt: RunFormatting): [string, string] {
  const parts: Array<[string, string]> = [];
  if (fmt.bold) parts.push(['**', '**']);
  if (fmt.italic) parts.push(['*', '*']);
  if (fmt.strikethrough) parts.push(['~~', '~~']);
  if (fmt.underline) parts.push(['<u>', '</u>']);
  if (fmt.highlight) parts.push(['==', '==']);
  if (fmt.superscript) parts.push(['<sup>', '</sup>']);
  else if (fmt.subscript) parts.push(['<sub>', '</sub>']);
  if (fmt.code) parts.push(['`', '`']);
  return [parts.map(part => part[0]).join(''), parts.map(part => part[1]).reverse().join('')];
}

/** Whether a run's text is all its Markdown is, with no delimiters around it */
function isBareRun(item: ContentItem | undefined): item is ContentItem & { type: 'text' } {
  return item?.type === 'text' && !item.href && !hasFormatting(item.formatting);
}

/** Whether any of `sorted` is from `from` to before `to` */
function anyBetween(sorted: number[], from: number, to: number): boolean {
  const k = lowerBound(sorted, from);
  return k < sorted.length && sorted[k] < to;
}

/** The text of the runs after one in its paragraph, as escapeMarkdownChars
 *  reads it, from an index of the paragraph's text, which each of its runs
 *  reads from where it ends */
export class RunsAfter {
  /** `prefix` comes before the runs, as a link's text has its ](url), and
   *  `link` says the text is a link's. `runs` are the items the text is
   *  of, where they're known, as they're not for a link's text. */
  constructor(private readonly index: TextIndex, private readonly from: number, private readonly prefix = '', readonly link = false,
    private readonly runs?: IndexedRuns) {}

  /** The runs after as text alone, where it's all there is */
  static of(text: string): RunsAfter {
    return new RunsAfter(indexText(text), 0);
  }

  /** These after a link's ](url), for its text */
  linkTo(href: string): RunsAfter {
    return new RunsAfter(this.index, this.from, '](' + formatHrefForMarkdown(href) + ')' + this.prefix, true);
  }

  /** The first character, '' for none */
  get first(): string {
    return this.prefix[0] ?? this.index.text[this.from] ?? '';
  }

  /** Whether an inline equation comes first, past empty runs, before which
   *  a letter or digit at the end of the run before goes as a reference
   *  (see textNextToMath) */
  get mathFirst(): boolean {
    if (this.prefix || !this.runs) return false;
    const { items } = this.runs;
    let k = this.runs.at;
    while (items[k]?.type === 'text' && (items[k] as ContentItem & { type: 'text' }).text === '') k++;
    const item = items[k];
    return item?.type === 'math' && !item.display;
  }

  /** Whether two = are next to each other, which can close a highlight, in
   *  these or after them in their block, as in a comment's body or past a
   *  display equation */
  get hasEquals(): boolean {
    return this.prefix.includes('==') || this.from <= this.index.laterEquals
      || lowerBound(this.index.equals, this.from) < this.index.equals.length;
  }

  /** The character after the nth ] a link's text can close at, from 0: ''
   *  at the end, and undefined without an nth */
  afterCloser(n: number): string | undefined {
    for (let k = 0; k < this.prefix.length; k++) {
      if (this.prefix[k] === ']' && n-- === 0) return this.prefix[k + 1] ?? this.index.text[this.from] ?? '';
    }
    const { linkClosers } = this.index;
    const k = lowerBound(linkClosers, this.from) + n;
    return k < linkClosers.length ? this.index.text[linkClosers[k] + 1] ?? '' : undefined;
  }

  /** The dollar signs, with what is between them as \u0001, as far as any
   *  can close math before them: the first single one, which closes $, and
   *  after one at the start, which a $ before can join, the first two or
   *  more, which close $$. Those between, which close neither, are left
   *  out, and runs of more than three signs are three, which close the
   *  same. Two side by side in Word's text, which are in runs of their own
   *  (see indexText), have \u0001 between them too, for the delimiters
   *  Markdown has between those runs. */
  dollars(): string {
    const { dollarRuns, nextSingle, nextDouble } = this.index;
    const k = lowerBound(this.index.dollarStarts, this.from);
    const leading = !this.prefix && k < dollarRuns.length && dollarRuns[k].start === this.from;
    const kept = new Set([leading ? k : -1, nextSingle[k], leading ? nextDouble[k + 1] : -1].filter(run => run >= 0));
    // A $ in a link's URL, which Markdown has as it is, can close math too
    let text = this.prefix.includes('$') ? this.prefix : this.prefix ? '\u0001' : '';
    let end = this.from;
    for (const run of [...kept].sort((a, b) => a - b)) {
      // As in **$**~~\$\$~~
      if (dollarRuns[run].start > end || end > this.from) text += '\u0001';
      text += '$'.repeat(Math.min(dollarRuns[run].length, 3));
      end = dollarRuns[run].start + dollarRuns[run].length;
    }
    return end < this.index.text.length ? text + '\u0001' : text;
  }

  /** Whether the citation export would read from a [ in the run before
   *  these, which no ] after it there closes, to the first ] in these,
   *  takes delimiters between the runs for its text, as it reads them as
   *  they are, where it's known. Its keys and locators do, where its first
   *  item's key starts in that run (`keyFirst`), as in [@a**b]**, and so
   *  does the prefix of a first item that starts there and ends in these,
   *  where formatting, a tracked change or a comment opens or closes in
   *  the brackets but not both, as in [see **x @a]**, or one its first
   *  item ends in, as in [see **x; y** @a]: export reads a prefix whose
   *  formatting closes in it, as in [see *x* @a], as text. With no @ for a
   *  key, or a [ before the ], it reads none. A note reference's [^1] is
   *  one with a [ before its ], and so is a citation's [@b]: where one
   *  comes first, the citation is one whose key comes right after its [
   *  (`direct`), which takes it, as [@a[^1] and [@a [@b] do, and no other. */
  citationTakesDelimiters(keyFirst: boolean, direct: boolean): boolean {
    if (!this.runs || this.prefix) return false;
    const { closers, ats, openers, semicolons, bracketed } = this.index;
    const c = lowerBound(closers, this.from);
    const n = lowerBound(bracketed, this.from);
    if (n < bracketed.length && (c >= closers.length || bracketed[n] < closers[c])) return direct;
    if (c >= closers.length) return false;
    if (keyFirst) return true;
    const close = closers[c];
    if (!anyBetween(ats, this.from, close) || anyBetween(openers, this.from, close)) return false;
    const { offsets, items, at } = this.runs;
    // The run with the ]
    const last = lowerBound(offsets, close + 1) - 1;
    const self = items[at - 1];
    const closing = items[last];
    if (!isBareRun(self) || !isBareRun(closing) || !revisionsEqual(self.revision, closing.revision)
      || !commentSetsEqual(self.commentIds, closing.commentIds)) return true;
    return anyBetween(semicolons, this.from, offsets[last]);
  }

  /** The Markdown the run before these and these write after its text, as
   *  far as a URL's host at its end could go on into: its closing
   *  delimiters, and each run's Markdown as markedFormatting writes it,
   *  escapes, whitespace and all, to the first space or / in it, which ends
   *  a host, and a space for anything else, as a tracked change's or a
   *  comment's delimiters, or a highlighted note reference, after its ==,
   *  at most `limit` characters in all. Where a
   *  ~~ that opens a run may be written as a tag, which ends a host (see
   *  resolveEmphasis), as where it runs into the ~~ before it, the Markdown
   *  up to it as well. None where the runs aren't known. A highlight's text
   *  export reads apart, but for the runs highlighted alike after it, which
   *  it may join (see joinHighlights), so they're read without it. A run of
   *  the revision that may start a span of its own, where appendRevised
   *  can't join their seam, is read both ways: after the span's delimiters,
   *  which end a host, and joined. */
  hostAfter(limit: number): string[] {
    if (!this.runs || this.prefix) return [];
    const { items, at, offsets } = this.runs;
    const self = items[at - 1];
    if (self?.type !== 'text' || self.href) return [];
    const color = highlightColorOf(self);
    const formatting = (run: ContentItem & { type: 'text' }): RunFormatting => color ? { ...run.formatting, highlight: false } : run.formatting;
    // Whitespace at its end, which its text is read without (see
    // markedFormatting), goes after the delimiters it's outside of
    if (/\s$/.test(self.text)) return [formattingDelimiters(formatting(self))[1] + ' '];
    // Whether the highlight of `run`, at k, goes around the rest of its
    // formatting, its == first, where it joins the runs beside it (see
    // joinsHighlight) or is one with a note reference or citation (see
    // renderHighlightGroup), read from the paragraph's start as from the
    // start of the range it's rendered in: the run before these, which has
    // no highlight where this is read, joins none.
    const around = (run: ContentItem & { type: 'text' }, k: number): boolean =>
      joinsHighlight(items, k, 0, items.length) || highlightGroupEnd(items, k, items.length, run.commentIds) > k;
    // The runs' Markdown, with its marks, to the first that ends a host. Each
    // reads the runs after it without their runs, so this reads no further.
    let written = '';
    let end = '';
    const closers = formattingDelimiters(formatting(self))[1];
    // The runs' Markdown up to each seam a span may start at
    const splits: string[] = [];
    for (let k = at; written.length < limit; k++) {
      const item = items[k];
      if (item?.type !== 'text' || item.href || !revisionsEqual(item.revision, self.revision)
        || !commentSetsEqual(item.commentIds, self.commentIds) || (color && highlightColorOf(item) !== color)) {
        // A highlighted note reference's ==, but not a citation's, which a
        // space goes before (see citationSeparator)
        const highlighted = !color && item?.type === 'footnote_ref'
          && !!highlightColorOf(item) && revisionsEqual(item.revision, self.revision) && commentSetsEqual(item.commentIds, self.commentIds);
        end = (highlighted ? '==' : '') + ' ';
        break;
      }
      const fmt = formatting(item);
      const run = markedFormatting(item.text, fmt, false, new RunsAfter(this.index, offsets[k + 1]), false, !color && !!fmt.highlight && around(item, k));
      if (self.revision) {
        const before = closers + written;
        const kinds = delimiterKinds(before + self.text);
        if (!canJoinSpans(before.slice(-1) || self.text.slice(-1), run) || [...delimiterKinds(run)].some(kind => kinds.has(kind))) splits.push(written);
      }
      written += run;
      if (/[\s/]/.test(run)) break;
    }
    return [closers + joinHighlights(written) + end, ...splits.map(split => closers + joinHighlights(split) + ' ')]
      .flatMap(markdown => hostsIn(markdown, self.text, formatting(self), limit));
  }

}

/** The hosts `markdown`, written after a run's `text` in its formatting
 *  `own`, may go on into, at most `limit` characters (see
 *  RunsAfter.hostAfter) */
function hostsIn(markdown: string, text: string, own: RunFormatting, limit: number): string[] {
  // A ~~ that would close after punctuation, as after https://, before a
  // letter, or open before punctuation after one, is a tag, where it's
  // marked, outside emphasis, which keeps it as it is, as in
  // <i>~~https://~~</i>
  const tag = (inner: string, outer: string) => flankClass(inner.charCodeAt(0)) === FLANK_PUNCT
    && flankClass(outer.charCodeAt(0)) === FLANK_OTHER;
  if (markdown.startsWith('~~') && !own.italic && !own.bold && tag(text.slice(-1), markdown.slice(2))) return [];
  const ends: string[] = [];
  let host = '';
  for (let i = 0; i < markdown.length && host.length < limit; i++) {
    const c = markdown[i];
    if (/[\s/]/.test(c)) return [...ends, host + c];
    if (c === EMPHASIS_OPEN['~~']) {
      // One that can't open is a tag, and one that can may be, as where it
      // can't close
      let inner = i + 1;
      while (markdown[inner] === '~') inner++;
      if (tag(markdown[inner] ?? ' ', i >= 3 ? markdown[i - 3] : text.slice(-1))) return [...ends, host.slice(0, -2) + ' '];
      ends.push(host.slice(0, -2) + ' ');
    } else if (c.charCodeAt(0) > 6) {
      host += c;
    }
  }
  return [...ends, host];
}

/** The ranges of the keys and locators of the citation export reads in
 *  `text` from the [ at `open` to the ] at `close`, where its items, as
 *  export writes a citation whose key is missing as its text, give that
 *  text back; undefined where they don't, as for [@a,p. 2]. Export runs a
 *  prefix's spaces together, and keeps one locator and one - for each key,
 *  the last, so [see  also @a] and [@a, p. 1; @a, p. 2] don't, nor does
 *  one with a line break in it. */
function citationKeyRanges(text: string, open: number, close: number): Array<[number, number]> | undefined {
  const inner = text.slice(open + 1, close);
  // A line break, which export would read as a backslash and a line's end,
  // and where a line in it that starts a block, as <table> or #, would read
  // as one
  if (inner.includes('\n')) return undefined;
  let offset = open + 1;
  const raw: Array<[number, number]> = [];
  const locators = new Map<string, string>();
  const suppressed = new Set<string>();
  const items = inner.split(';').flatMap(part => {
    const item = part.trim();
    const start = /(^|\s)(-?)@/.exec(item);
    const prefix = start ? item.slice(0, start.index).trim().replace(/\s+/g, ' ') : '';
    const rest = start ? item.slice(start.index + start[0].length).trim() : item;
    const comma = rest.indexOf(',');
    const key = comma === -1 ? rest : rest.slice(0, comma).trim();
    if (start) raw.push([offset + part.indexOf(item) + start.index + start[1].length, offset + part.length]);
    offset += part.length + 1;
    if (!rest) return [];
    if (comma !== -1) locators.set(key, rest.slice(comma + 1).trim());
    if (start?.[2]) suppressed.add(key);
    return [{ prefix, key }];
  });
  return '[' + items.map(({ prefix, key }) => (prefix ? prefix + ' ' : '') + (suppressed.has(key) ? '-@' : '@') + key
    + (locators.get(key) ? ', ' + locators.get(key) : '')).join('; ') + ']' === text.slice(open, close + 1) ? raw : undefined;
}

/** Whether a key of the citation from the [ at `open` to the ] at `close`
 *  in `text` is one export knows (see knownCitationKeys), so it may have
 *  written the citation as its text. Word's own text that reads as a
 *  citation of another key export would take for one, and note missing,
 *  so it's text. */
function citationKnown(text: string, open: number, close: number): boolean {
  return !citationsNoted || bracketKeys(text.slice(open + 1, close)).some(key => knownCitationKeys.has(key));
}

/** The keys of the citation between brackets whose text is `inner`, as
 *  citationKeyRanges reads them */
function bracketKeys(inner: string): string[] {
  return inner.split(';').flatMap(part => {
    const item = part.trim();
    const start = /(^|\s)-?@/.exec(item);
    if (!start) return [];
    const rest = item.slice(start.index + start[0].length).trim();
    const comma = rest.indexOf(',');
    return [comma === -1 ? rest : rest.slice(0, comma).trim()];
  });
}

/** A tracked break's end mark (see joinTrackedParagraphBreaks): a
 *  private-use character after a line end and the next line's prefix, a
 *  quote's markers or a list's indent. One of the document's own there
 *  takes an escape after it that it doesn't need, which reads the same. */
const TRACKED_BREAK_END_RE = /\n[> \t]*[\uE000-\uF8FF]/g;

/** Whether text ends with a line break or a tracked break, so the text
 *  after it in its span starts a line */
const endsLine = (text: string): boolean => text.endsWith('\n') || /\n[> \t]*[\uE000-\uF8FF]$/.test(text);

/**
 * Word's text as Markdown that reads as that text: a backslash goes before
 * each character Markdown would take for syntax, but only there, so most
 * text reads as it is. A character that could pair with one in the runs
 * around the text, as an opening [ whose ] isn't in it, is escaped too.
 * The text starts a line where `lineStart` says so and after each line
 * break (a backslash and a line's end, which stays as it is), where a block
 * can start. Code is literal, and doesn't come here. Where export reads
 * a citation, as `rawTags` says, the positions in the Markdown of its keys
 * and locators, which export reads as they are, go in it, and a tag in a
 * prefix has its < escaped. Where the text's = go as references
 * (`equalsAsReferences`, see markedFormatting), linkify reads them so.
 */
function escapeMarkdownChars(text: string, lineStart = false, after?: RunsAfter, rawTags?: Set<number>, beforeMath = false, equalsAsReferences = false): string {
  const escaped = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    // A tracked change's closer, which would end one around the text (a
    // comment's range with ==} goes in ID syntax)
    if ((c === '+' || c === '-') && next === c && text[i + 2] === '}') escaped.add(i + 1);
    if (c === '\\') {
      if (next !== '\n' && (next === undefined || ASCII_PUNCTUATION_RE.test(next))) escaped.add(i);
    } else if (c === '*' || c === '`') {
      escaped.add(i);
    } else if (c === '_') {
      // Not inside a word, where _ can't be emphasis, as in snake_case
      if (!(WORD_CHARACTER_RE.test(text[i - 1] ?? '') && WORD_CHARACTER_RE.test(next ?? ''))) escaped.add(i);
    } else if (c === '~') {
      // Strikethrough, or a code fence
      if (text[i - 1] === '~' || next === '~') escaped.add(i);
    } else if (c === '=') {
      if (text[i - 1] !== '=') {
        // Every other one, so no two that are left pair
        const length = /^=+/.exec(text.slice(i))![0].length;
        if (equalsOpensHighlight(text, i, length, after)) for (let k = 0; k < length; k += 2) escaped.add(i + k);
      }
    } else if (c === '{') {
      // CriticMarkup, or a comment's range
      if (next === undefined || /^(?:\+\+|--|~~|>>|==|#|\/)/.test(text.slice(i + 1, i + 3))) escaped.add(i);
    } else if (c === '<') {
      // An HTML comment, which export hides, or an autolink
      COMMENT_OR_AUTOLINK_AT.lastIndex = i;
      if (COMMENT_OR_AUTOLINK_AT.test(text)) escaped.add(i);
    } else if (c === '&') {
      // An entity or character reference
      if (/^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/.test(text.slice(i, i + 40))) escaped.add(i);
    }
  }
  // A URL or email address, which linkify would make a link of, as export's
  // linkify finds them: the colon after the scheme, or the @
  for (const link of linkifyMatches(text)) {
    const at = link.schema.endsWith(':') && link.schema !== 'mailto:' ? link.index + link.schema.length - 1 : text.indexOf('@', link.index);
    if (at >= link.index && at < link.lastIndex) escaped.add(at);
  }
  // The start of each line: the text's, if it starts one, each after a
  // line break, and each after a tracked break's end mark, a private-use
  // character after its line end and the next line's prefix (see
  // joinTrackedParagraphBreaks)
  const starts = lineStart ? [0] : [];
  for (let k = text.indexOf('\\\n'); k !== -1; k = text.indexOf('\\\n', k + 2)) starts.push(k + 2);
  if (text.includes('\n')) for (const end of text.matchAll(TRACKED_BREAK_END_RE)) starts.push(end.index + end[0].length);
  for (const start of starts) {
    // To its line's end, a line break's or a tracked break's, so each line
    // is read alone and once
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : text[newline - 1] === '\\' ? newline - 1 : newline;
    const at = blockSyntaxAt(text, start, end);
    if (at !== undefined) escaped.add(at);
  }
  // Every bracket in a link's text: a ] that a [ in it doesn't close would
  // end it, and a [ that starts a link, note reference or citation in it
  // makes it none, as markdown-it nests none in its text
  if (after?.link) {
    for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) escaped.add(i);
    for (let i = text.indexOf(']'); i !== -1; i = text.indexOf(']', i + 1)) escaped.add(i);
  }
  // A [ that would start a link, image, note reference or span: [a](b),
  // [a][b], [a]{.underline} or [^1]. From the right, as an escaped [ inside
  // one doesn't nest. Each [ that isn't escaped closes at the nearest ]
  // after it that no [ inside it closes at, or else in the runs `after` it,
  // at the ] after those the [s inside it that close there take; a [ in
  // those runs doesn't nest, as it may yet be escaped. Without them, it's
  // escaped, as one of them could close it. One export reads as a
  // citation, before a ( too, whose items give its text back, stays one,
  // as with the keys below, where no [ is in it. One whose ] is in the runs
  // after, which export would read as a citation that takes the delimiters
  // between the runs for its text, is escaped too (see
  // RunsAfter.citationTakesDelimiters).
  const closers: number[] = [];
  let openAfter = 0;
  // The nearest [ after the one at i, -1 for none
  let nextOpen = -1;
  // The nearest ; and key's @ after a space, as in [see @a, after i, -1 for
  // none, and whether a ] is
  let nextSemicolon = -1;
  let nextKey = -1;
  let closerAfter = false;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ']') {
      closers.push(i);
      closerAfter = true;
    } else if (text[i] === ';') nextSemicolon = i;
    else if (text[i] === '@' && /[\p{L}\p{N}_]/u.test(text[i + 1] ?? '')
      && (/\s/.test(text[i - 1] ?? '') || text[i - 1] === '-' && /\s/.test(text[i - 2] ?? ''))) nextKey = text[i - 1] === '-' ? i - 1 : i;
    if (text[i] !== '[') continue;
    const inner = nextOpen;
    nextOpen = i;
    if (escaped.has(i)) continue;
    const close = closers[closers.length - 1];
    let opens: boolean;
    if (text[i + 1] === '^') opens = true;
    // With no [ before its ], so each citation's text is read once, nor a
    // ! before it, which makes it an image's
    else if (close !== undefined && (inner === -1 || inner > close) && text[i - 1] !== '!' && /^-?@/.test(text.slice(i + 1, i + 3))
      && citationEndInText(text, i) === close && citationKeyRanges(text, i, close) && citationKnown(text, i, close)) opens = false;
    else if (close !== undefined) opens = '([{'.includes(text[close + 1] ?? (after?.first || ' '));
    else if (!after) opens = true;
    else {
      // What follows the ] in the runs after
      const follows = after.afterCloser(openAfter);
      opens = follows !== undefined && '([{'.includes(follows || ' ');
      // A citation to a ] in them, which export reads to the first ], past
      // any [, where its keys start after the [, and otherwise only with no
      // [ before its ] and its first item's key, if it ends here, here
      if (!opens && !closerAfter) {
        const direct = /^-?@/.test(text.slice(i + 1, i + 3));
        const keyFirst = direct || nextKey !== -1 && (nextSemicolon === -1 || nextKey < nextSemicolon);
        opens = (direct || inner === -1 && (keyFirst || nextSemicolon === -1)) && after.citationTakesDelimiters(keyFirst, direct);
      }
    }
    if (opens) escaped.add(i);
    else if (close !== undefined) closers.pop();
    else openAfter++;
  }
  // A citation's keys and locators, which a bracket around them takes as
  // they are: export writes a citation whose key is missing as that text,
  // from its items, so a bracket stays one where they give its text back,
  // and its prefixes, which export decodes, keep their escapes. Any other
  // bracket export would read as a citation is text.
  const keys = new Set<number>();
  const prefixTags = new Set<number>();
  // The next < from the citation at hand, found once for the whole text,
  // not again from each citation's [
  let tag = text.indexOf('<');
  // As export reads one: an @ after the [ takes it to the next ], past any
  // [ before it, and whatever follows, as [@a[b] or [@a](b) do; any other
  // [ starts one only with no [ before its ] (see citationEnd)
  for (let i = text.indexOf('['), close = -1; i !== -1; i = text.indexOf('[', i + 1)) {
    if (close <= i) close = text.indexOf(']', i);
    if (close === -1) break;
    if (escaped.has(i)) continue;
    const open = text.indexOf('[', i + 1);
    if (open !== -1 && open < close && !/^-?@/.test(text.slice(i + 1, i + 3))) continue;
    if (citationEndInText(text, i) !== close) continue;
    const raw = citationKeyRanges(text, i, close);
    if (!raw) {
      escaped.add(i);
      continue;
    }
    // Text, as is each [ in it, which export would read as a citation's once
    // the first is escaped, as in [@a[@b]
    if (!citationKnown(text, i, close)) {
      for (let k = i; k !== -1 && k < close; k = text.indexOf('[', k + 1)) escaped.add(k);
      i = close;
      continue;
    }
    for (const [start, end] of raw) for (let k = start; k < end; k++) keys.add(k);
    // A tag in a prefix, which export decodes, has its < escaped, not
    // written as a reference, whose ; would end an item
    while (rawTags && tag !== -1 && tag < i) tag = text.indexOf('<', tag + 1);
    for (; rawTags && tag !== -1 && tag < close; tag = text.indexOf('<', tag + 1)) {
      HTML_LIKE_TAG_AT.lastIndex = tag;
      const name = HTML_LIKE_TAG_AT.exec(text)?.[1];
      if (!keys.has(tag) && name && MARKDOWN_HTML_SENSITIVE_TAGS.has(name.toLowerCase())) prefixTags.add(tag);
    }
    i = close;
  }
  for (const k of keys) escaped.delete(k);
  for (const k of prefixTags) escaped.add(k);
  // An HTML tag Markdown keeps raw, which export writes as its text, takes
  // no escapes, which would be text there; a comment's or one
  // escapeSensitiveHtmlLikeTags writes as text has its < escaped
  const inTag = new Set<number>();
  for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i + 1)) {
    if (escaped.has(i)) continue;
    HTML_TAG_AT.lastIndex = i;
    const tag = HTML_TAG_AT.exec(text)?.[0];
    const name = tag && /^<\/?([A-Za-z][A-Za-z\d-]*)/.exec(tag)?.[1];
    if (!tag || !name || MARKDOWN_HTML_SENSITIVE_TAGS.has(name.toLowerCase())) continue;
    for (let k = i + 1; k < i + tag.length; k++) {
      escaped.delete(k);
      inTag.add(k);
    }
    i += tag.length - 1;
  }
  // A URL or email address linkify finds in the text as escaped, which an
  // escape can end where linkify found none in Word's text, as the \ in
  // http://e.com\_ ends http://e.com. A tag ends the text linkify reads
  // too, as one Markdown keeps raw or one written as references, &lt; and
  // &gt;, which are tokens of their own, so a < or > is a space here: in
  // https://e.com1.<span> linkify finds no URL, but it links https://e.com1
  // in https://e.com1. before the tag. So is an = written as &#61;, without
  // its escape: linkify finds no address in x@y.com=, but links x@y.com in
  // x@y.com&#61;.
  if (/[:@]/.test(text)) {
    let markdown = '';
    const from = new Map<number, number>();
    for (let k = 0; k < text.length; k++) {
      const reference = equalsAsReferences && text[k] === '=';
      if (escaped.has(k) && !reference) markdown += '\\';
      from.set(markdown.length, k);
      markdown += text[k] === '<' || text[k] === '>' || reference ? ' ' : text[k];
    }
    const colonsIn = (markdown: string) => [...linkifyMatches(markdown).map(link => link.schema.endsWith(':') && link.schema !== 'mailto:' ? link.index + link.schema.length - 1 : markdown.indexOf('@', link.index)), ...linkifiedColons(markdown)];
    const colons = colonsIn(markdown);
    // An = at the end before another, as a highlight's ==, which
    // resolveEmphasis writes as a reference there, so it ends the text
    // linkify reads, as an escape does, as in x@y.com&#61;==a==
    if (after?.first === '=' && /(?:^|[^\\])(?:\\\\)*=$/.test(markdown)) {
      colons.push(...colonsIn(markdown.slice(0, -1) + '\\=').filter(colon => colon < markdown.length - 1));
    }
    // A URL whose host goes on in the runs after, as https:// before struck
    // e.com, where the delimiters between, as ~~, don't end it, in any way
    // they may be written
    const scheme = markdown.lastIndexOf('://');
    if (after && scheme !== -1 && !/[\s/]/.test(markdown.slice(scheme + 3))) {
      for (const host of after.hostAfter(HOST_LOOKAHEAD)) colons.push(...colonsIn(markdown + host).filter(colon => colon < markdown.length));
    }
    for (const colon of colons) {
      const at = from.get(colon);
      if (at !== undefined && !keys.has(at) && !inTag.has(at)) escaped.add(at);
    }
  }
  // Dollar signs, last: whether one opens math depends on the escapes
  // around it, as a \ before the _ after $x$ lets the $ close it. In the
  // text as Markdown reads it, Word's own backslashes, which this doubles,
  // aren't escapes; math can close in the runs after the text. From the
  // right, since escaping a $ can let one before it close at a later $.
  // The escapes after each are final, so a $ closes at the nearest after
  // it that isn't escaped, and what is between needn't be read: building
  // the Markdown for each took time in the square of the text's length.
  // The runs after, as their escapes and formatting are yet to come: only
  // their dollar signs, any of which can close math, whatever is around it,
  // and between them what is neither a space nor a word, as a delimiter
  let afterText: string | undefined;
  // A letter or digit before an equation (`beforeMath`) goes as a
  // reference, whose ; a $ before it can close math at (see textNextToMath)
  const reference = beforeMath && WORD_NEXT_TO_MATH.test(text[text.length - 1] ?? '') ? text.length - 1 : -1;
  /** The kth character as Markdown has it, Word's backslash as \u0001 */
  const char = (k: number) => text[k] === '\\' ? '\u0001' : k === reference ? ';' : text[k];
  /** The first character Markdown has for the kth, its escape if it has
   *  one, or of `rest` after the text, '' at the end */
  const read = (k: number, rest: string) => k < text.length ? (escaped.has(k) ? '\\' : char(k)) : rest[k - text.length] ?? '';
  let nearest = -1;
  /** Whether the single $ at i opens math, with `between` and the runs
   *  after following the text (see findDollarMathAt) */
  const opensMath = (i: number, between: string): boolean => {
    const rest = between + afterText;
    const before = i > 0 ? char(i - 1) : '';
    // Its Markdown from the character before it, as findDollarMathAt reads it
    const exactly = () => {
      let markdown = before;
      for (let k = i; k < text.length; k++) markdown += (escaped.has(k) ? '\\' : '') + char(k);
      return findDollarMathAt(markdown + rest, before.length, { displayRun: 'at-least' })?.kind === 'math';
    };
    // With a $ after it, display math's
    if (read(i + 1, rest) === '$') return exactly();
    if (/\w/.test(before)) return false;
    if (/\d/.test(read(i + 1, rest))) {
      // A price, as $5, isn't math
      let k = i + 1;
      while (/^[\d,.]$/.test(read(k, rest))) k++;
      if (read(k, rest) === '' || /\s/.test(read(k, rest))) return false;
    }
    if (nearest === -1) return findDollarMathAt('\u0001$\u0001' + rest, 1, { displayRun: 'at-least' })?.kind === 'math';
    // The nearest closes it, unless it's in a run of them
    const next = read(nearest + 1, rest);
    return next === '$' ? exactly() : !/\w/.test(next);
  };
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '$') continue;
    if (!keys.has(i) && !inTag.has(i) && !escaped.has(i)) {
      if (text[i - 1] === '$' || text[i + 1] === '$') {
        escaped.add(i);
      } else {
        afterText ??= after ? after.dollars() : '';
        // with formatting's delimiters between the runs, or not
        if (opensMath(i, '') || (afterText && opensMath(i, '\u0001'))) escaped.add(i);
      }
    }
    if (!escaped.has(i)) nearest = i;
  }
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (escaped.has(i)) result += '\\';
    if (keys.has(i) || prefixTags.has(i)) rawTags?.add(result.length);
    result += text[i];
  }
  return result;
}

export type RevisionInfo = { type: 'addition' | 'deletion'; author: string; date: string };

export interface ListContinuation {
  type: 'bullet' | 'ordered';
  level: number; // 0-based parent list nesting level for Markdown rendering
  markerWidth?: number; // ordered-list marker width (e.g. "10. " => 4)
  indent?: number; // columns of the item's content: its marker and its parents'
}

interface StructuralListContext {
  type: 'bullet' | 'ordered';
  level: number;
  markerWidth?: number;
}

export type ContentItem =
  | {
      type: 'text';
      text: string;
      commentIds: Set<string>;
      formatting: RunFormatting;
      href?: string;           // hyperlink URL if inside w:hyperlink
      link?: number;           // which w:hyperlink, so two to one place stay two links
      revision?: RevisionInfo;
    }
  // lineStart: the citation starts the paragraph after a tracked break,
  // which some views of the change join to the text before it
  | { type: 'citation'; text: string; commentIds: Set<string>; pandocKeys: string[]; revision?: RevisionInfo; formatting?: RunFormatting; lineStart?: boolean }
  | { type: 'table'; rows: TableRow[] }
  | {
      type: 'para';
      headingLevel?: number;   // 1–6 if heading, undefined otherwise
      listMeta?: ListMeta;     // present if list item
      isTitle?: boolean;       // true if Word "Title" paragraph style
      blockquoteLevel?: number; // 1+ if Quote/IntenseQuote paragraph style
      listContinuation?: ListContinuation; // parent list context for continuation paragraphs/blocks
      alertType?: GfmAlertType; // present for GitHub alert styles
      isCodeBlock?: boolean;   // true if Word "Code Block" paragraph style
      blockquoteGroupIndex?: number; // sequential group index from md→docx gap metadata
      isBlockquoteSpacer?: boolean; // generated visual spacer; retained only as an import grouping boundary
      customStyleName?: string;      // user-defined custom style name (from MsCustomXxx pStyle)
      paragraphLeftIndentTwips?: number; // raw OOXML left indent for structural inference
      spacerShaped?: boolean; // its only property is w:spacing after="0", as on the empty paragraph export puts after a code block
      horizontalRule?: boolean; // an empty paragraph with only a bottom border, as export writes a thematic break
      taskLevel?: number; // 0-based level of an indented paragraph shaped like a bulleted task item (see markTaskListItems)
      generatedListContinuation?: boolean; // explicit Manuscript continuation paragraph style
      blockquoteIndentUnitTwips?: 240 | 720; // base indent unit for blockquote styles
      blockquoteStyle?: BlockquoteStyle; // Quote, IntenseQuote or GitHub style of a quote that isn't an alert
      emptyParagraphCount?: number; // count of collapsed consecutive empty paragraphs
      indentOverride?: 'indent' | 'no-indent'; // per-paragraph indent override for round-trip
      blankParagraphs?: number; // paragraphs of spaces and tabs alone it stands for (see dropBlankParagraphText), which count among export's paragraphs, or that a cleanup dropped before it (see dropCodeBlockSeparators)
      listBlockStart?: boolean; // the first item of a list block, which a list indent override goes before
      paraMarkRevision?: RevisionInfo; // w:ins/w:del on the paragraph mark (pPr > rPr) — whole paragraph inserted/deleted
      breakRevision?: RevisionInfo; // w:ins/w:del on the previous paragraph's mark, which is the break before this one
    }
  // inParagraph: display math in a w:p, which goes on in its text, not a
  // body's m:oMathPara of its own
  | { type: 'math'; latex: string; display: boolean; commentIds: Set<string>; revision?: RevisionInfo; inParagraph?: boolean }
  | { type: 'footnote_ref'; noteId: string; noteKind: 'footnote' | 'endnote'; commentIds: Set<string>; revision?: RevisionInfo; formatting?: RunFormatting }
  | { type: 'html_comment'; text: string; commentIds: Set<string> }
  | { type: 'image'; rId: string; src: string; alt: string; widthPx: number; heightPx: number; commentIds: Set<string>; revision?: RevisionInfo; markdown?: string }
  | { type: 'landscape_open' }
  | { type: 'landscape_close' }
  | { type: 'portrait_open' }
  | { type: 'portrait_close' }
  | { type: 'bibliography_marker' }
  | { type: 'custom_style_open'; styleName: string }
  | { type: 'custom_style_close' };
export interface FootnoteBody {
  id: string;
  content: ContentItem[];
}

/** Context for parsing rich content in footnote/endnote bodies. */
interface NoteBodyContext {
  relationshipMap: Map<string, string>;
  /** The notes' own image relationships, and where and to which files
   *  their images go, which the document's share */
  images?: { relationships: Map<string, string>; folder: string; files: ImageFiles };
  /** The IDs of the notes the document references, which only have images:
   *  another's would take a file, and a name, for an image nothing shows */
  referenced?: ReadonlySet<string>;
  /** The Zotero citations of the notes' part, in order */
  zoteroCitations: ZoteroCitation[];
  /** The key of each item the document cites, in its body or its notes */
  keyMap: Map<string, string>;
  numberingDefs: NumberingDefs;
  numberingStartOverrides?: NumberingStartOverrides;
  format: CitationKeyFormat;
  replyIds?: Set<string>;
  /** See extractDocumentContent's */
  commentBodies?: ReadonlySet<string>;
  styleLayouts?: StyleLayouts;
}

export interface TableRow {
  isHeader: boolean;
  cells: TableCell[];
}
export interface TableCell {
  paragraphs: ContentItem[][];
  colspan?: number;
  rowspan?: number;
  align?: TableAlign;
}

/** A Word cell's paragraphs, in any element around them, as a content
 *  control's, but not a nested table's */
function cellParagraphs(nodes: XmlNode[]): XmlNode[] {
  return nodes.flatMap(node => node['w:p'] !== undefined ? [node]
    : Object.keys(node).filter(key => key !== ':@' && key !== 'w:tbl' && Array.isArray(node[key]))
      .flatMap(key => cellParagraphs(asXmlNodes(node[key]))));
}

/** A paragraph's alignment and direction, where something sets them */
interface ParagraphLayout { jc?: string; bidi?: boolean }

/** The alignment and direction styles.xml gives paragraphs: each style's,
 *  its own or its base's, the document's defaults, and which paragraph and
 *  table styles are the defaults */
export interface StyleLayouts {
  styles: Map<string, ParagraphLayout>;
  /** A table style's layouts for parts of a table, by tblStylePr type, and
   *  how many rows and columns a band takes */
  tables: Map<string, { parts: Map<string, ParagraphLayout>; rowBand: number; colBand: number }>;
  defaults: ParagraphLayout;
  defaultParagraphStyle?: string;
  defaultTableStyle?: string;
  /** The ID import reads a built-in paragraph style by, as `Heading1`, for
   *  each style the document gives another, by its name (see
   *  BUILT_IN_PARAGRAPH_STYLES) */
  builtInIds?: Map<string, string>;
}

/** The built-in paragraph styles import reads by their IDs, in the text or
 *  in styles.xml (see extractFontOverridesFromStyles), by their names in
 *  styles.xml, lowercased. Word gives a built-in style an ID from its name
 *  in the language it runs in, as `berschrift1` for German's Überschrift 1
 *  and `Standard` for Normal, but keeps its English name, `heading 1`, in
 *  w:name. */
const BUILT_IN_PARAGRAPH_STYLES = new Map<string, string>([
  ['normal', 'Normal'],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(level => ['heading ' + level, 'Heading' + level] as [string, string]),
  ['title', 'Title'], ['quote', 'Quote'], ['intense quote', 'IntenseQuote'],
]);

/** The document's own ID of each w:pStyle useBuiltInStyleIds gave a
 *  built-in style's, by which styles.xml gives the style's layout */
const documentStyleIds = new WeakMap<XmlNode, string>();

/** A paragraph's style's ID in the document, as styles.xml has it */
function documentStyleId(pStyle: XmlNode): string {
  return documentStyleIds.get(pStyle) ?? getAttr(pStyle, 'val');
}

/** Gives each paragraph of a built-in style the ID import reads it by, in
 *  place of the document's, which documentStyleId keeps (see
 *  StyleLayouts.builtInIds) */
function useBuiltInStyleIds(nodes: XmlNode[], ids: Map<string, string> | undefined): void {
  if (!ids?.size) return;
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (key === 'w:pStyle') {
        const id = node[':@']?.['@_w:val'];
        if (typeof id === 'string' && ids.has(id)) {
          documentStyleIds.set(node, id);
          node[':@']!['@_w:val'] = ids.get(id);
        }
      } else if (key !== ':@' && Array.isArray(value)) {
        useBuiltInStyleIds(value, ids);
      }
    }
  }
}

/** A pPr's alignment and direction, where it sets them */
function paragraphLayout(pPrChildren: XmlNode[]): ParagraphLayout {
  const jc = pPrChildren.find(c => c['w:jc'] !== undefined);
  const bidi = pPrChildren.some(c => c['w:bidi'] !== undefined);
  return { ...(jc ? { jc: getAttr(jc, 'val') } : {}), ...(bidi ? { bidi: isToggleOn(pPrChildren, 'w:bidi') } : {}) };
}

/** Read styles.xml's paragraph alignment and direction */
export async function parseStyleLayouts(zip: JSZip): Promise<StyleLayouts> {
  const parsed = await readZipXml(zip, 'word/styles.xml');
  const layouts: StyleLayouts = { styles: new Map(), tables: new Map(), defaults: {} };
  if (!parsed) return layouts;
  const pPrOf = (children: XmlNode[]) => {
    const pPr = children.find(c => c['w:pPr'] !== undefined);
    return pPr ? asXmlNodes(pPr['w:pPr']) : [];
  };
  const pPrDefault = findAllDeep(parsed, 'w:pPrDefault')[0];
  if (pPrDefault) layouts.defaults = paragraphLayout(pPrOf(asXmlNodes(pPrDefault['w:pPrDefault'])));
  const own = new Map<string, { layout: ParagraphLayout; basedOn: string; parts: Map<string, ParagraphLayout>; rowBand?: number; colBand?: number }>();
  // The ID each built-in paragraph style is read by, by the document's
  const builtIn = new Map<string, string>();
  for (const node of findAllDeep(parsed, 'w:style')) {
    const children = asXmlNodes(node['w:style']);
    const id = getAttr(node, 'styleId');
    const basedOn = children.find(c => c['w:basedOn'] !== undefined);
    const parts = new Map(children.filter(c => c['w:tblStylePr'] !== undefined)
      .map(c => [getAttr(c, 'type'), paragraphLayout(pPrOf(asXmlNodes(c['w:tblStylePr'])))]));
    const tblPr = children.find(c => c['w:tblPr'] !== undefined);
    const band = (name: string) => {
      const size = tblPr && asXmlNodes(tblPr['w:tblPr']).find(c => c[name] !== undefined);
      return size ? parseInt(getAttr(size, 'val'), 10) || undefined : undefined;
    };
    const name = children.find(c => c['w:name'] !== undefined);
    const builtInId = getAttr(node, 'type') === 'paragraph' && name ? BUILT_IN_PARAGRAPH_STYLES.get(getAttr(name, 'val').toLowerCase()) : undefined;
    if (builtInId && builtInId.toLowerCase() !== id.toLowerCase()) builtIn.set(id, builtInId);
    own.set(id, {
      layout: paragraphLayout(pPrOf(children)), basedOn: basedOn ? getAttr(basedOn, 'val') : '',
      parts, rowBand: band('w:tblStyleRowBandSize'), colBand: band('w:tblStyleColBandSize'),
    });
    if (['1', 'true', 'on'].includes(getAttr(node, 'default'))) {
      if (getAttr(node, 'type') === 'paragraph') layouts.defaultParagraphStyle ??= id;
      else if (getAttr(node, 'type') === 'table') layouts.defaultTableStyle ??= id;
    }
  }
  const resolve = (id: string, seen: Set<string>): ParagraphLayout => {
    const style = own.get(id);
    if (!style || seen.has(id)) return {};
    seen.add(id);
    return { ...resolve(style.basedOn, seen), ...style.layout };
  };
  for (const id of own.keys()) layouts.styles.set(id, resolve(id, new Set()));
  // A built-in style's ID, where no style of the document has it, goes for
  // the style; its layout stays under its own (see documentStyleId)
  const ids = new Set([...own.keys()].map(id => id.toLowerCase()));
  for (const [id, builtInId] of builtIn) {
    if (!ids.has(builtInId.toLowerCase())) (layouts.builtInIds ??= new Map()).set(id, builtInId);
  }
  // A table style's parts, each its own or its base's
  const resolveTable = (id: string, seen: Set<string>): { parts: Map<string, ParagraphLayout>; rowBand: number; colBand: number } => {
    const style = own.get(id);
    if (!style || seen.has(id)) return { parts: new Map(), rowBand: 1, colBand: 1 };
    seen.add(id);
    const base = resolveTable(style.basedOn, seen);
    const parts = new Map(base.parts);
    for (const [type, layout] of style.parts) parts.set(type, { ...parts.get(type), ...layout });
    return { parts, rowBand: style.rowBand ?? base.rowBand, colBand: style.colBand ?? base.colBand };
  };
  for (const id of own.keys()) layouts.tables.set(id, resolveTable(id, new Set()));
  return layouts;
}

/** Where a cell is in its table, and which of the table style's parts the
 *  table turns on */
interface CellPlace { row: number; rows: number; col: number; span: number; cols: number; look: TableLook }
interface TableLook { firstRow: boolean; lastRow: boolean; firstColumn: boolean; lastColumn: boolean; noHBand: boolean; noVBand: boolean }

/** How many grid columns a table has, from its tblGrid, or else its widest row */
function tableColumnCount(tblChildren: XmlNode[]): number {
  const grid = tblChildren.find(c => c['w:tblGrid'] !== undefined);
  const gridCols = grid ? asXmlNodes(grid['w:tblGrid']).filter(c => c['w:gridCol'] !== undefined).length : 0;
  if (gridCols > 0) return gridCols;
  return Math.max(0, ...tblChildren.filter(c => c['w:tr'] !== undefined).map(tr => asXmlNodes(tr['w:tr'])
    .filter(c => c['w:tc'] !== undefined).reduce((n, tc) => {
      const tcPr = asXmlNodes(tc['w:tc']).find(c => c['w:tcPr'] !== undefined);
      const span = tcPr && asXmlNodes(tcPr['w:tcPr']).find(c => c['w:gridSpan'] !== undefined);
      return n + (span ? parseInt(getAttr(span, 'val'), 10) || 1 : 1);
    }, 0)));
}

/** A table's tblLook, from its attributes or else its w:val's bits */
function tableLook(tblChildren: XmlNode[]): TableLook {
  const tblPr = tblChildren.find(c => c['w:tblPr'] !== undefined);
  const look = tblPr ? asXmlNodes(tblPr['w:tblPr']).find(c => c['w:tblLook'] !== undefined) : undefined;
  const bits = parseInt(getAttr(look, 'val') || '0', 16) || 0;
  const flag = (name: string, bit: number) => {
    const value = getAttr(look, name);
    return value ? ['1', 'true', 'on'].includes(value) : (bits & bit) !== 0;
  };
  return {
    firstRow: flag('firstRow', 0x20), lastRow: flag('lastRow', 0x40), firstColumn: flag('firstColumn', 0x80),
    lastColumn: flag('lastColumn', 0x100), noHBand: flag('noHBand', 0x200), noVBand: flag('noVBand', 0x400),
  };
}

/** A table style's layout for a cell: the whole table's, then its bands',
 *  its first or last column's and row's, and its corner's, each over the
 *  last, as Word applies them */
function tableStyleLayout(layouts: StyleLayouts | undefined, style: string, place?: CellPlace): ParagraphLayout {
  const table = layouts?.tables.get(style);
  const layout: ParagraphLayout = { ...layouts?.styles.get(style), ...table?.parts.get('wholeTable') };
  if (!table || !place) return layout;
  const { row, rows, col, span, cols, look } = place;
  const firstRow = look.firstRow && row === 0;
  const lastRow = look.lastRow && row === rows - 1;
  const firstCol = look.firstColumn && col === 0;
  const lastCol = look.lastColumn && col + span >= cols;
  const parts: string[] = [];
  if (!look.noVBand && !firstCol && !lastCol) {
    parts.push(Math.floor((col - (look.firstColumn ? 1 : 0)) / table.colBand) % 2 === 0 ? 'band1Vert' : 'band2Vert');
  }
  if (!look.noHBand && !firstRow && !lastRow) {
    parts.push(Math.floor((row - (look.firstRow ? 1 : 0)) / table.rowBand) % 2 === 0 ? 'band1Horz' : 'band2Horz');
  }
  if (firstCol) parts.push('firstCol');
  if (lastCol) parts.push('lastCol');
  if (firstRow) parts.push('firstRow');
  if (lastRow) parts.push('lastRow');
  if (firstRow && firstCol) parts.push('nwCell');
  if (firstRow && lastCol) parts.push('neCell');
  if (lastRow && firstCol) parts.push('swCell');
  if (lastRow && lastCol) parts.push('seCell');
  for (const part of parts) Object.assign(layout, table.parts.get(part));
  return layout;
}

/** A table's style, from its tblPr, or the default table style */
function tableStyleId(tblChildren: XmlNode[], layouts?: StyleLayouts): string {
  const tblPr = tblChildren.find(c => c['w:tblPr'] !== undefined);
  const style = tblPr ? asXmlNodes(tblPr['w:tblPr']).find(c => c['w:tblStyle'] !== undefined) : undefined;
  return style ? getAttr(style, 'val') : layouts?.defaultTableStyle ?? '';
}

/** A Word cell's alignment, its paragraphs' when they all share one. A
 *  paragraph's own setting comes first, then its style's, which takes in
 *  the default paragraph style only through its base, the table's style's
 *  for where the cell is, the default paragraph style's where it has no
 *  other, and the document's defaults, as Word reads them. Left from a
 *  style is what Word does with none, so only a paragraph's own left aligns
 *  its column. In a right-to-left paragraph only center counts, as start
 *  and end, and what left and right mean there, turn around. */
function cellAlignment(tcChildren: XmlNode[], layouts?: StyleLayouts, tableStyle = '', place?: CellPlace): TableAlign | undefined {
  const aligns = new Set<TableAlign | undefined>();
  const fromStyle = (id: string | undefined) => (id && layouts?.styles.get(id)) || {};
  const fromTable = tableStyleLayout(layouts, tableStyle, place);
  for (const p of cellParagraphs(tcChildren)) {
    const pPr = asXmlNodes(p['w:p']).find(c => c['w:pPr'] !== undefined);
    const pPrChildren = pPr ? asXmlNodes(pPr['w:pPr']) : [];
    const pStyle = pPrChildren.find(c => c['w:pStyle'] !== undefined);
    const styleId = pStyle ? documentStyleId(pStyle) : '';
    // A style styles.xml doesn't have is the default, as Word reads it
    const isDefault = !styleId || styleId === layouts?.defaultParagraphStyle || !layouts?.styles.has(styleId);
    const own = paragraphLayout(pPrChildren);
    const layout: ParagraphLayout = {
      ...layouts?.defaults,
      ...(isDefault ? fromStyle(layouts?.defaultParagraphStyle) : {}),
      ...fromTable,
      ...(isDefault ? {} : fromStyle(styleId)),
      ...own,
    };
    const val = layout.jc ?? '';
    aligns.add(val === 'center' ? 'center' : layout.bidi ? undefined
      : val === 'right' || val === 'end' ? 'right' : (val === 'left' || val === 'start') && own.jc !== undefined ? 'left' : undefined);
  }
  return aligns.size === 1 ? [...aligns][0] : undefined;
}

/** Each column's alignment, where its cells with text share one, or its
 *  empty cells if it has none: a pipe or grid table aligns a column, not a
 *  cell */
function columnAlignments(rows: TableRow[], numCols: number): Array<TableAlign | undefined> {
  return Array.from({ length: numCols }, (_, ci) => {
    const cells = rows.map(row => row.cells[ci]).filter(cell => cell !== undefined);
    const filled = cells.filter(cell => cell.paragraphs.some(para => para.length > 0));
    const aligns = new Set((filled.length > 0 ? filled : cells).map(cell => cell.align));
    return aligns.size === 1 ? [...aligns][0] : undefined;
  });
}

export type CitationKeyFormat = 'authorYearTitle' | 'authorYear' | 'numeric';

export interface ZoteroDocPrefs {
  styleId: string;
  locale?: string;
  noteType?: number;
}

export interface ZoteroBiblData {
  uncited?: unknown[];
  omitted?: unknown[];
  custom?: unknown[];
}

export interface ConvertResult {
  markdown: string;
  bibtex: string;
  zoteroPrefs?: ZoteroDocPrefs;
  zoteroBiblData?: ZoteroBiblData;
  images?: Map<string, Uint8Array>;
}

// XML helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === undefined || value === null ? '' : String(value);
}

function parseCslAuthors(value: unknown): CitationMetadata['authors'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(author => {
    if (!isRecord(author)) return [];
    const parsed: CitationMetadata['authors'][number] = {};
    if (typeof author.family === 'string' && author.family.trim()) parsed.family = author.family;
    if (typeof author.given === 'string' && author.given.trim()) parsed.given = author.given;
    if (typeof author.literal === 'string' && author.literal.trim()) parsed.literal = author.literal;
    return Object.keys(parsed).length > 0 ? [parsed] : [];
  });
}

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  processEntities: {
    enabled: true,
    // fast-xml-parser counts every &quot;, &lt;, &gt; and &apos; toward
    // maxTotalExpansions, and a long manuscript passes any fixed count (Zotero
    // field codes are full of &quot;). Leaving it uncapped is safe because no
    // expansion can grow the text: standard entities replace 4+ characters with
    // one, and maxEntitySize holds DOCTYPE entities (which Word never writes) to
    // one character in place of a reference of at least three.
    maxTotalExpansions: Infinity,
    maxEntitySize: 1,
    maxExpandedLength: 1000000,
  },
};

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function parseRelationships(
  zip: JSZip,
  relsPath = 'word/_rels/document.xml.rels'
): Promise<Map<string, string>> {
  const relationships = new Map<string, string>();
  const parsed = await readZipXml(zip, relsPath);
  if (!parsed) { return relationships; }

  for (const node of findAllDeep(parsed, 'Relationship')) {
    const id = getAttr(node, 'Id');
    const type = getAttr(node, 'Type');
    const target = getAttr(node, 'Target');
    const targetMode = getAttr(node, 'TargetMode');

    if (type.endsWith('/hyperlink') && targetMode === 'External') {
      relationships.set(id, target);
    }
  }

  return relationships;
}

export async function parseDocumentRelationships(
  zip: JSZip,
  relsPath = 'word/_rels/document.xml.rels',
): Promise<{ hyperlinks: Map<string, string>; images: Map<string, string> }> {
  const hyperlinks = new Map<string, string>();
  const images = new Map<string, string>();
  const parsed = await readZipXml(zip, relsPath);
  if (!parsed) return { hyperlinks, images };
  for (const node of findAllDeep(parsed, 'Relationship')) {
    const id = getAttr(node, 'Id');
    const type = getAttr(node, 'Type');
    const target = getAttr(node, 'Target');
    const targetMode = getAttr(node, 'TargetMode');
    if (type.endsWith('/hyperlink') && targetMode === 'External') {
      hyperlinks.set(id, target);
    } else if (type.endsWith('/image')) {
      images.set(id, target);
    }
  }
  return { hyperlinks, images };
}

export async function extractImageFormatMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_IMAGE_FORMATS');
}

export async function extractNoteImageFormatMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_NOTE_IMAGE_FORMATS');
}

export interface NumberingLevelDef {
  type: 'bullet' | 'ordered';
  start?: number; // w:start, where the level's count begins
  restart?: number; // w:lvlRestart: the level, from 1, at or above which a paragraph starts this one over, or 0 for none
  style?: string; // w:pStyle: the paragraph style the level is linked to
}

export type NumberingDefs = Map<string, Map<string, NumberingLevelDef>>;
export type NumberingStartOverrides = Map<string, Map<string, number>>; // numId → ilvl → start
/** numId → its abstract numbering and all its start overrides, 1 included;
 *  restartsAfterBreak when the abstract numbering has
 *  w15:restartNumberingAfterBreak */
export type NumberingInstances = Map<string, { abstractNumId: string; overrides: Map<string, number>; restartsAfterBreak?: boolean }>;

export interface WordListCounter {
  /** The number Word shows for the next list paragraph, in document order,
   *  and whether its level's numbering starts over there */
  (numId: string, ilvl: number): { number: number; starts: boolean } | undefined;
  /** Starts over the lists Word restarts after a section break */
  sectionBreak(): void;
}

/**
 * Counts list paragraphs as Word numbers them. The instances of an abstract
 * numbering share one count, so a list goes on across the paragraphs between
 * its parts, even in two w:num elements, and an instance's start override
 * starts that count over for all of them: ECMA-376 Part 1 §17.9.26 numbers
 * numIds 5, 5, 6, 5, where 6 starts level 0 over at 1, as 1, 2, 1, 2. An
 * override applies once, at the instance's first paragraph at its level, as
 * [MS-DOC] 2.4.6.4 has it (step 10, which only paragraphs at the level
 * reach), and as docx4j and LibreOffice apply it; later paragraphs of the
 * instance at that level go on. A level starts
 * over after any higher level, or as its w:lvlRestart has it: after the
 * level it gives or a higher one, or never for 0 ([MS-OI29500] 2.1.282; one
 * that gives a lower level is ignored, ECMA-376 Part 1 §17.9.10). A
 * higher level with no count, as before a list's first paragraph at it,
 * counts from its start there, or the instance's override for it, as if a
 * paragraph had used it, so that its next paragraph is one more: Word
 * numbers a list of 1.1, 1.2 and a top-level item as 1.1, 1.2, 2, where the
 * instance starts both levels at 1 (tdf#153104).
 */
export function wordListCounter(defs: NumberingDefs, instances: NumberingInstances): WordListCounter {
  // abstractNumId → its count by level; numId:level where an instance has
  // had a paragraph at a level, which used its start override there
  const lists = new Map<string, { levels: number[]; restartsAfterBreak: boolean }>();
  const used = new Set<string>();
  const count = (numId: string, ilvl: number): { number: number; starts: boolean } | undefined => {
    const instance = instances.get(numId);
    if (!instance) return undefined;
    let list = lists.get(instance.abstractNumId);
    if (!list) lists.set(instance.abstractNumId, list = { levels: [], restartsAfterBreak: false });
    if (instance.restartsAfterBreak) list.restartsAfterBreak = true;
    const override = (level: number) => used.has(numId + ':' + level) ? undefined : instance.overrides.get(String(level));
    // A level with no w:start starts at 0, as Word numbers it (ECMA-376
    // 17.9.25)
    const start = (level: number) => override(level) ?? defs.get(numId)?.get(String(level))?.start ?? 0;
    const { levels } = list;
    for (let level = 0; level < ilvl; level++) {
      if (levels[level] !== undefined) continue;
      levels[level] = start(level);
      used.add(numId + ':' + level);
    }
    const starts = levels[ilvl] === undefined || override(ilvl) !== undefined;
    levels[ilvl] = starts ? start(ilvl) : levels[ilvl] + 1;
    used.add(numId + ':' + ilvl);
    for (let level = ilvl + 1; level < levels.length; level++) {
      const restart = defs.get(numId)?.get(String(level))?.restart;
      if (restart === undefined || restart > level || ilvl < restart) delete levels[level];
    }
    return { number: levels[ilvl], starts };
  };
  return Object.assign(count, {
    sectionBreak: () => {
      for (const [abstractNumId, list] of lists) if (list.restartsAfterBreak) lists.delete(abstractNumId);
    },
  });
}

/** The numbering instance and level a w:numPr gives, where it gives them */
interface NumberingReference { numId?: string; ilvl?: string }

/** A style's numbering: the numId and ilvl of its w:numPr, each its own or
 *  else its base's, as Word inherits them one by one, and the IDs of the
 *  style and its bases */
interface StyleNumberingEntry { reference: NumberingReference; lineage: string[] }

/** Each style's numbering, by style ID, and the default paragraph style */
export interface StyleNumbering { styles: Map<string, StyleNumberingEntry>; defaultStyle?: string }

function numberingReference(pPrChildren: XmlNode[]): NumberingReference | undefined {
  const numPr = pPrChildren.find(child => child['w:numPr'] !== undefined);
  if (!numPr) return undefined;
  const reference: NumberingReference = {};
  for (const child of asXmlNodes(numPr['w:numPr'])) {
    if (child['w:numId'] !== undefined) reference.numId = getAttr(child, 'val');
    if (child['w:ilvl'] !== undefined) reference.ilvl = getAttr(child, 'val');
  }
  return reference;
}

async function parseStyleNumbering(zip: JSZip): Promise<StyleNumbering> {
  const numbering: StyleNumbering = { styles: new Map() };
  const parsed = await readZipXml(zip, 'word/styles.xml');
  if (!parsed) return numbering;
  const own = new Map<string, { reference?: NumberingReference; basedOn: string }>();
  for (const node of findAllDeep(parsed, 'w:style')) {
    const children = asXmlNodes(node['w:style']);
    const id = getAttr(node, 'styleId');
    const pPr = children.find(c => c['w:pPr'] !== undefined);
    const basedOn = children.find(c => c['w:basedOn'] !== undefined);
    own.set(id, { reference: pPr ? numberingReference(asXmlNodes(pPr['w:pPr'])) : undefined, basedOn: basedOn ? getAttr(basedOn, 'val') : '' });
    if (getAttr(node, 'type') === 'paragraph' && ['1', 'true', 'on'].includes(getAttr(node, 'default'))) numbering.defaultStyle ??= id;
  }
  const resolve = (id: string, seen: Set<string>): StyleNumberingEntry => {
    const style = own.get(id);
    if (!style || seen.has(id)) return { reference: {}, lineage: [] };
    seen.add(id);
    const base = resolve(style.basedOn, seen);
    return { reference: { ...base.reference, ...style.reference }, lineage: [id, ...base.lineage] };
  };
  for (const id of own.keys()) numbering.styles.set(id, resolve(id, new Set()));
  return numbering;
}

export async function parseNumberingDefinitions(zip: JSZip): Promise<{ defs: NumberingDefs; startOverrides: NumberingStartOverrides; instances: NumberingInstances; styles: StyleNumbering }> {
  const numberingDefs: NumberingDefs = new Map();
  const startOverrides: NumberingStartOverrides = new Map();
  const instances: NumberingInstances = new Map();
  const parsed = await readZipXml(zip, 'word/numbering.xml');
  if (!parsed) { return { defs: numberingDefs, startOverrides, instances, styles: { styles: new Map() } }; }
  const styles = await parseStyleNumbering(zip);

  // Build abstractNumId → levels map
  const abstractNums = new Map<string, Map<string, NumberingLevelDef>>();
  const restartingAfterBreak = new Set<string>();
  // abstractNumId → the list style its w:numStyleLink names, and a list
  // style → the abstractNumId whose w:styleLink names it
  const numStyleLinks = new Map<string, string>();
  const styleLinks = new Map<string, string>();
  for (const node of findAllDeep(parsed, 'w:abstractNum')) {
    const abstractNum = asXmlNodes(node['w:abstractNum']);
    if (abstractNum.length === 0) continue;

    const abstractNumId = getAttr(node, 'abstractNumId');
    if (['1', 'true', 'on'].includes(String(node[':@']?.['@_w15:restartNumberingAfterBreak'] ?? ''))) restartingAfterBreak.add(abstractNumId);
    const numStyleLink = abstractNum.find(child => child['w:numStyleLink'] !== undefined);
    if (numStyleLink) numStyleLinks.set(abstractNumId, getAttr(numStyleLink, 'val'));
    const styleLink = abstractNum.find(child => child['w:styleLink'] !== undefined);
    if (styleLink && !styleLinks.has(getAttr(styleLink, 'val'))) styleLinks.set(getAttr(styleLink, 'val'), abstractNumId);
    const levels = new Map<string, NumberingLevelDef>();

    for (const lvlNode of findAllDeep(abstractNum, 'w:lvl')) {
      const lvl = asXmlNodes(lvlNode['w:lvl']);
      if (lvl.length === 0) continue;

      const ilvl = getAttr(lvlNode, 'ilvl');
      // A level with no w:numFmt is decimal (ECMA-376 17.9.17), as Word
      // numbers it
      const numFmtNodes = findAllDeep(lvl, 'w:numFmt');
      const val = numFmtNodes.length > 0 ? getAttr(numFmtNodes[0], 'val') : 'decimal';
      const startNodes = findAllDeep(lvl, 'w:start');
      const start = startNodes.length > 0 ? parseInt(getAttr(startNodes[0], 'val'), 10) : NaN;
      // Word ignores one in an instance's level override ([MS-OI29500]
      // 2.1.282 b), so only the abstract numbering's counts
      const restartNodes = findAllDeep(lvl, 'w:lvlRestart');
      const restart = restartNodes.length > 0 ? parseInt(getAttr(restartNodes[0], 'val'), 10) : NaN;
      // The level's own, not one in its w:pPr, which Word ignores
      const style = lvl.find(child => child['w:pStyle'] !== undefined);
      levels.set(ilvl, {
        type: val === 'bullet' ? 'bullet' : 'ordered', ...(isNaN(start) ? {} : { start }), ...(restart >= 0 ? { restart } : {}),
        ...(style ? { style: getAttr(style, 'val') } : {}),
      });
    }

    abstractNums.set(abstractNumId, levels);
  }

  const nums = findAllDeep(parsed, 'w:num').map(node => {
    const num = asXmlNodes(node['w:num']);
    const abstractNumIdNode = findAllDeep(num, 'w:abstractNumId')[0];
    return { numId: getAttr(node, 'numId'), num, abstractNumId: abstractNumIdNode ? getAttr(abstractNumIdNode, 'val') : undefined };
  });

  // An abstract numbering that links to a list style (w:numStyleLink), as
  // Word's built-in multilevel lists do, has the levels of the style's
  // definition: the abstract numbering of the instance the style's w:numPr
  // gives, or else the one whose w:styleLink names the style (ECMA-376
  // Part 1 §17.9.21, §17.9.27), as LibreOffice finds it. Its paragraphs
  // count apart from the definition's, as docx4j measured Word, and from
  // another's that links to the style
  const abstractNumIds = new Map(nums.map(({ numId, abstractNumId }) => [numId, abstractNumId]));
  for (const [abstractNumId, style] of numStyleLinks) {
    const styleNumId = styles.styles.get(style)?.reference.numId;
    const definition = [styleNumId === undefined ? undefined : abstractNumIds.get(styleNumId), styleLinks.get(style)]
      .find(id => id !== undefined && !numStyleLinks.has(id) && abstractNums.has(id));
    if (definition !== undefined) abstractNums.set(abstractNumId, abstractNums.get(definition)!);
  }

  // Resolve numId → abstractNumId, and read lvlOverride/startOverride
  for (const { numId, num, abstractNumId } of nums) {
    if (num.length === 0) continue;

    const instance = { abstractNumId: '', overrides: new Map<string, number>(), restartsAfterBreak: false };
    if (abstractNumId !== undefined) {
      instance.abstractNumId = abstractNumId;
      instance.restartsAfterBreak = restartingAfterBreak.has(abstractNumId);
      instances.set(numId, instance);
      const levels = abstractNums.get(abstractNumId);
      if (levels) {
        numberingDefs.set(numId, levels);
      }
    }

    // Read w:lvlOverride → w:startOverride. One with nothing in it starts
    // its level at 0, as Word numbers it (tdf#153104), and as export reads
    // a template's (see templateListLevels in md-to-docx.ts)
    for (const lvlOverrideNode of findAllDeep(num, 'w:lvlOverride')) {
      const ilvl = getAttr(lvlOverrideNode, 'ilvl');
      const lvlOverride = asXmlNodes(lvlOverrideNode['w:lvlOverride']);
      const starts = lvlOverride.every(node => '#text' in node) ? [0]
        : findAllDeep(lvlOverride, 'w:startOverride').map(startNode => parseInt(getAttr(startNode, 'val'), 10));
      for (const startVal of starts) {
        if (!isNaN(startVal)) instance.overrides.set(ilvl, startVal);
        if (!isNaN(startVal) && startVal !== 1) {
          if (!startOverrides.has(numId)) startOverrides.set(numId, new Map());
          startOverrides.get(numId)!.set(ilvl, startVal);
        }
      }
      // A w:lvl there formats the level for this instance alone (ECMA-376
      // Part 1 §17.9.5), as LibreOffice and docx4j read it. Word ignores its
      // w:start and w:lvlRestart ([MS-OI29500] 2.1.292 b, 2.1.282 b), so
      // its format and the paragraph style it links the level to, as docx4j
      // reads the link, are all that count here. Where it gives neither,
      // the level keeps the abstract numbering's, as LibreOffice merges it
      const lvl = lvlOverride.find(child => child['w:lvl'] !== undefined);
      const lvlChildren = lvl ? asXmlNodes(lvl['w:lvl']) : [];
      const numFmt = lvlChildren.find(child => child['w:numFmt'] !== undefined);
      const style = lvlChildren.find(child => child['w:pStyle'] !== undefined);
      const levels = numberingDefs.get(numId);
      const level = levels?.get(ilvl);
      const type = numFmt ? (getAttr(numFmt, 'val') === 'bullet' ? 'bullet' : 'ordered') : level?.type;
      if (levels && type && (numFmt || style)) {
        numberingDefs.set(numId, new Map(levels).set(ilvl, { ...level, type, ...(style ? { style: getAttr(style, 'val') } : {}) }));
      }
    }
  }

  return { defs: numberingDefs, startOverrides, instances, styles };
}

export function parseHeadingLevel(pPrChildren: XmlNode[]): number | undefined {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return undefined;

  const val = getAttr(pStyleElement, 'val').toLowerCase();
  const match = val.match(/^heading(\d)$/);
  if (match) {
    const level = parseInt(match[1], 10);
    return level >= 1 && level <= 6 ? level : undefined;
  }

  return undefined;
}

/** Detect a custom style (MsCustomXxx) and return the user-facing name, or undefined. */
export function parseCustomStyleName(pPrChildren: XmlNode[], knownStyles?: Record<string, CustomStyleDef>): string | undefined {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return undefined;
  const val = getAttr(pStyleElement, 'val');
  if (!val.startsWith('MsCustom')) return undefined;
  // Reverse-lookup: if we have the known styles map, find the name whose customStyleId matches
  if (knownStyles) {
    for (const name of Object.keys(knownStyles)) {
      if (customStyleId(name) === val) return name;
    }
  }
  // Fallback: derive name from PascalCase by lowering and inserting hyphens
  const suffix = val.slice('MsCustom'.length);
  return suffix.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export function parseTitleStyle(pPrChildren: XmlNode[]): boolean {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return false;
  return getAttr(pStyleElement, 'val').toLowerCase() === 'title';
}

/** An empty paragraph with only a bottom border and no style, as export
 *  writes a horizontal rule, or Word keeps one it moved a section break onto. */
function isRuleCarrier(pPrChildren: XmlNode[]): boolean {
  return hasOnlyBottomBorder(pPrChildren) && !pPrChildren.some(child => child['w:pStyle'] !== undefined || child['w:numPr'] !== undefined);
}

/** Whether a paragraph's only border is at its bottom, as export draws a
 *  thematic break */
function hasOnlyBottomBorder(pPrChildren: XmlNode[]): boolean {
  const pBdr = pPrChildren.find(child => child['w:pBdr'] !== undefined);
  if (!pBdr) return false;
  const drawn = asXmlNodes(pBdr['w:pBdr']).filter(border => !['none', 'nil'].includes(getAttr(border, 'val')));
  return drawn.length === 1 && drawn[0]['w:bottom'] !== undefined;
}

/** The 0-based level of a paragraph indented as export writes a bulleted
 *  task item: a left indent in steps of 720 twips with a 360 hanging indent. */
function parseTaskIndentLevel(pPrChildren: XmlNode[]): number | undefined {
  const indElement = pPrChildren.find(child => child['w:ind'] !== undefined);
  if (!indElement || getAttr(indElement, 'hanging') !== '360') return undefined;
  const left = parseInt(getAttr(indElement, 'left'), 10);
  return left > 0 && left % 720 === 0 ? left / 720 - 1 : undefined;
}

function parseParagraphLeftIndentTwips(pPrChildren: XmlNode[]): number | undefined {
  const indElement = pPrChildren.find(child => child['w:ind'] !== undefined);
  if (!indElement) return undefined;
  const left = parseInt(getAttr(indElement, 'left'), 10);
  return !isNaN(left) && left > 0 ? left : undefined;
}

function parseBlockquoteInfo(pPrChildren: XmlNode[]): { level?: number; indentUnitTwips?: 240 | 720; style?: BlockquoteStyle } {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return {};
  const val = getAttr(pStyleElement, 'val').toLowerCase();
  const isAlertStyle = ALERT_STYLE_TO_TYPE[val] !== undefined;
  const isGithubBlockquoteStyle = val === 'github' || val === 'githubblockquote';
  if (val !== 'quote' && val !== 'intensequote' && !isGithubBlockquoteStyle && !isAlertStyle) return {};
  // The blockquote-style export writes the quote in; an alert has its own
  const style: BlockquoteStyle | undefined = isAlertStyle ? undefined
    : isGithubBlockquoteStyle ? 'GitHub' : val === 'quote' ? 'Quote' : 'IntenseQuote';

  // Extract left indent to determine nesting level
  const indentUnitTwips: 240 | 720 = (isGithubBlockquoteStyle || isAlertStyle) ? 240 : 720;
  const left = parseParagraphLeftIndentTwips(pPrChildren);
  if (left !== undefined) {
    if (left > 0) {
      return { level: Math.max(1, Math.round(left / indentUnitTwips)), indentUnitTwips, style };
    }
  }
  return { level: 1, indentUnitTwips, style };
}

export function parseBlockquoteLevel(pPrChildren: XmlNode[]): number | undefined {
  const info = parseBlockquoteInfo(pPrChildren);
  if (info.level !== undefined) {
    return info.level;
  }
  return undefined;
}

export function parseAlertType(pPrChildren: XmlNode[]): GfmAlertType | undefined {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return undefined;
  const val = getAttr(pStyleElement, 'val').toLowerCase();
  return ALERT_STYLE_TO_TYPE[val];
}

export function parseCodeBlockStyle(pPrChildren: XmlNode[]): boolean {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return false;
  return getAttr(pStyleElement, 'val').toLowerCase() === 'codeblock';
}

function parseListContinuationStyle(pPrChildren: XmlNode[]): boolean {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  return pStyleElement !== undefined
    && getAttr(pStyleElement, 'val').toLowerCase() === 'manuscriptlistcontinuation';
}

/** A paragraph's list item, where its w:numPr or its style's numbers it */
export function parseListMeta(pPrChildren: XmlNode[], numberingDefs: NumberingDefs, numberingStartOverrides?: NumberingStartOverrides, countListItem?: WordListCounter, styleNumbering?: StyleNumbering): ListMeta | undefined {
  // The paragraph's style, or the default where it names none or one
  // styles.xml doesn't have, as Word reads it
  const pStyle = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  const style = (pStyle ? styleNumbering?.styles.get(documentStyleId(pStyle)) : undefined)
    ?? styleNumbering?.styles.get(styleNumbering.defaultStyle ?? '');
  // The paragraph's own numId and ilvl come before its style's, each by
  // itself, as a numId alone puts it in another list at its style's level,
  // as LibreOffice reads them. Word reads a style's ilvl, which ECMA-376
  // Part 1 §17.3.1.19 has it ignore ([MS-OI29500] 2.1.50)
  const own = numberingReference(pPrChildren);
  const reference = { ...style?.reference, ...own };
  const numId = reference.numId;
  // A numId of 0 takes away its style's numbering (ECMA-376 Part 1 §17.9.18)
  if (!numId || numId === '0') return undefined;

  const levels = numberingDefs.get(numId);
  if (!levels) return undefined;
  // One that gives no level numbers its paragraph at the level linked to its
  // style, or the nearest base of it that one is linked to, as ECMA-376 Part
  // 1 §17.9.23 has a style that gives a numId alone take its level, and
  // mammoth reads it. Else at level 0, as LibreOffice and docx4j read it,
  // where ECMA-376 gives no default
  const ilvl = reference.ilvl
    || style?.lineage.flatMap(id => [...levels].filter(([, def]) => def.style === id).map(([linked]) => linked))[0]
    || '0';

  const def = levels.get(ilvl);
  if (!def) return undefined;
  // Word neither numbers nor counts a paragraph its style puts at a level
  // linked to another style, one that isn't the paragraph's or a base of it,
  // as docx4j measured Word; its own numId always numbers it
  if (own?.numId === undefined && def.style !== undefined && !style?.lineage.includes(def.style)) return undefined;

  // Word won't open a file that defines a level above 8 ([MS-OI29500] on
  // Part 1 §17.9.6), so a paragraph at one has none it numbers by, and
  // counting the levels up to it would take as long as the level is high
  const level = parseInt(ilvl, 10);
  if (isNaN(level) || level < 0 || level > 8) return undefined;

  const startNumber = numberingStartOverrides?.get(numId)?.get(ilvl);
  const counted = countListItem?.(numId, level);
  return {
    type: def.type,
    level,
    ...(startNumber !== undefined ? { startNumber } : {}),
    ...(def.type === 'ordered' && counted ? { wordNumber: counted.number, wordStarts: counted.starts } : {}),
  };
}

async function loadZip(data: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(data);
}

/**
 * XML with its numeric character references written as the characters they
 * stand for, as an XML parser reads them, where fast-xml-parser leaves them
 * as text, as &#x25CF; for a bullet. Word writes characters as they are, but
 * other tools write references. One pass, so &#38;#x41; stays the text
 * &#x41;. A reference to a character markup reads, as &#60;, becomes its
 * entity, and one to a character XML can't hold stays as it is. One to a
 * carriage return becomes &#xD;, which the parser reads (see readZipXml),
 * as it would turn the character into a line feed with the line ends it
 * normalizes. A CDATA section or a comment holds none.
 */
function decodeCharacterReferences(xml: string): string {
  if (!xml.includes('&#')) return xml;
  return xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));/g, (match, hex?: string, dec?: string) => {
    if (hex === undefined && dec === undefined) return match;
    const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
    switch (code) {
      case 0x26: return '&amp;';
      case 0x3C: return '&lt;';
      case 0x3E: return '&gt;';
      case 0x22: return '&quot;';
      case 0x27: return '&apos;';
      case 0xD: return '&#xD;';
    }
    const xmlCharacter = code === 0x9 || code === 0xA || code >= 0x20 && code <= 0xD7FF
      || code >= 0xE000 && code <= 0xFFFD || code >= 0x10000 && code <= 0x10FFFF;
    return xmlCharacter ? String.fromCodePoint(code) : match;
  });
}

async function readZipXml(zip: JSZip, path: string): Promise<XmlNode[] | null> {
  const file = zip.file(path);
  if (!file) { return null; }
  const xml = decodeCharacterReferences(await file.async('string'));
  const parser = new XMLParser(parserOptions);
  parser.addEntity('#xD', '\r');
  const parsed: unknown = parser.parse(xml);
  return asXmlNodes(parsed);
}

function findAllDeep(nodes: XmlNode[], tagName: string, depth = 0, maxDepth = 50): XmlNode[] {
  if (depth >= maxDepth) { return []; }
  const results: XmlNode[] = [];
  for (const node of nodes) {
    if (node[tagName] !== undefined) { results.push(node); }
    for (const key of Object.keys(node)) {
      if (key !== ':@' && Array.isArray(node[key])) {
        results.push(...findAllDeep(node[key], tagName, depth + 1, maxDepth));
      }
    }
  }
  return results;
}

// The Symbol font's characters as Unicode, from its code 0x20 on, after
// Adobe's mapping, \0 where it has none
const SYMBOL_FONT = (
  ' !∀#∃%&∋()∗+,−./' +
  '0123456789:;<=>?' +
  '≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟ' +
  'ΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_' +
  '‾αβχδεφγηιϕκλμνο' +
  'πθρστυϖωξψζ{|}∼\0' +
  '\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0' +
  '\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0' +
  '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓' +
  '°±″≥×∝∂•÷≠≡≈…⏐⎯↵' +
  'ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉' +
  '∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓' +
  '◊⟨®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪' +
  '\0⟩∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭\0'
);

/** The character a w:sym shows, which Word writes for one picked from the
 *  Symbol font, as Unicode, or undefined for another font's, as Wingdings,
 *  which Unicode doesn't hold */
function symbolCharacter(node: XmlNode): string | undefined {
  if (getAttr(node, 'font').toLowerCase() !== 'symbol') return undefined;
  // In the font's private-use range, at 0xF020, or as the code alone
  const code = parseInt(getAttr(node, 'char'), 16) & 0xFF;
  const character = SYMBOL_FONT[code - 0x20];
  return character && character !== '\0' ? character : undefined;
}

// A run's elements that are characters, which export writes back as them
const RUN_CHARACTERS: Record<string, string> = {
  'w:tab': '\t', 'w:noBreakHyphen': '\u2011', 'w:softHyphen': '\u00AD',
};

/** A run's children with each w:tab, non-breaking hyphen, optional hyphen
 *  or Symbol font character as the text of its character, and a carriage
 *  return as the line
 *  break it is. A w:tab outside a run, in w:tabs, is a tab stop, not text. */
function withCharactersAsText(runChildren: XmlNode[]): XmlNode[] {
  const tag = (child: XmlNode) => Object.keys(child).find(key => key !== ':@') ?? '';
  return runChildren.some(child => tag(child) in RUN_CHARACTERS || tag(child) === 'w:cr' || tag(child) === 'w:sym')
    ? runChildren.map(child => {
      if (tag(child) === 'w:cr') return { 'w:br': [] };
      const character = tag(child) === 'w:sym' ? symbolCharacter(child) : RUN_CHARACTERS[tag(child)];
      return character !== undefined ? { 'w:t': [{ '#text': character }] } : child;
    })
    : runChildren;
}

function getAttr(node: XmlNode | undefined, attr: string): string {
  const value = node?.[':@']?.[`@_w:${attr}`] ?? node?.[':@']?.[`@_${attr}`];
  return value === undefined ? '' : String(value);
}

/** Extract text from a node's children (handles #text in preserveOrder mode) */
function nodeText(children: XmlNode[]): string {
  if (!Array.isArray(children)) { return ''; }
  const parts: string[] = [];
  for (const c of children) {
    if (c['#text'] !== undefined) { parts.push(String(c['#text'])); }
  }
  // Also recurse into w:t children
  for (const c of children) {
    if (c['w:t'] !== undefined && Array.isArray(c['w:t'])) {
      parts.push(nodeText(c['w:t']));
    }
  }
  return parts.join('');
}

/**
 * Walk the parsed XML tree and extract complete field instructions by
 * accumulating w:instrText fragments between w:fldChar begin and
 * separate/end markers.  Returns one concatenated instruction string
 * per complex field, in document order.
 */
function extractFieldInstructions(nodes: XmlNode[]): string[] {
  const results: string[] = [];
  let accumulating = false;
  let buffer = '';

  function walk(items: XmlNode[]): void {
    for (const node of items) {
      for (const key of Object.keys(node)) {
        if (key === ':@') { continue; }

        if (key === 'w:fldChar') {
          const fldType = getAttr(node, 'fldCharType');
          if (fldType === 'begin') {
            accumulating = true;
            buffer = '';
          } else if (fldType === 'separate' || fldType === 'end') {
            if (accumulating) {
              results.push(buffer);
              accumulating = false;
              buffer = '';
            }
          }
        } else if (key === 'w:instrText' && accumulating) {
          buffer += nodeText(asXmlNodes(node['w:instrText']));
        } else if (Array.isArray(node[key])) {
          walk(node[key]);
        }
      }
    }
  }

  walk(nodes);
  return results;
}

// Formatting helpers

/** Detect OOXML boolean toggle pattern */
export function isToggleOn(children: XmlNode[], tagName: string): boolean {
  const element = children.find(child => child[tagName] !== undefined);
  if (!element) return false;
  
  const val = getAttr(element, 'val');
  if (!val) return true; // present with no w:val attribute → true
  return val === 'true' || val === '1' || val === 'on';
}

/** Parse run properties and return RunFormatting */
export function parseRunProperties(
  rPrChildren: XmlNode[],
  baseFormatting: RunFormatting = DEFAULT_FORMATTING
): RunFormatting {
  const formatting: RunFormatting = { ...baseFormatting };
  
  // OOXML toggles: only override inherited value if property is explicitly present.
  const bElement = rPrChildren.find(child => child['w:b'] !== undefined);
  if (bElement) {
    const val = getAttr(bElement, 'val');
    formatting.bold = !val || val === 'true' || val === '1' || val === 'on';
  }

  const iElement = rPrChildren.find(child => child['w:i'] !== undefined);
  if (iElement) {
    const val = getAttr(iElement, 'val');
    formatting.italic = !val || val === 'true' || val === '1' || val === 'on';
  }

  // strikethrough: w:strike or w:dstrike (double strikethrough) — both map to ~~
  const strikeElement = rPrChildren.find(child => child['w:strike'] !== undefined);
  const dstrikeElement = rPrChildren.find(child => child['w:dstrike'] !== undefined);
  if (strikeElement) {
    const val = getAttr(strikeElement, 'val');
    formatting.strikethrough = !val || val === 'true' || val === '1' || val === 'on';
  } else if (dstrikeElement) {
    const val = getAttr(dstrikeElement, 'val');
    formatting.strikethrough = !val || val === 'true' || val === '1' || val === 'on';
  }
  
  // underline: w:u with w:val ≠ "none"
  const uElement = rPrChildren.find(child => child['w:u'] !== undefined);
  if (uElement) {
    const val = getAttr(uElement, 'val');
    // OOXML: bare <w:u/> defaults to single underline; only w:val="none" disables it.
    formatting.underline = val !== 'none';
  }
  
  // highlight: w:highlight with w:val ≠ "none", OR w:shd with w:fill ≠ "" and ≠ "auto"
  // w:highlight takes priority over w:shd per ECMA-376
  const highlightElement = rPrChildren.find(child => child['w:highlight'] !== undefined);
  if (highlightElement) {
    const val = getAttr(highlightElement, 'val');
    formatting.highlight = val !== 'none';
    if (formatting.highlight && val) {
      formatting.highlightColor = val;
    } else {
      formatting.highlightColor = undefined;
    }
  } else {
    const shdElement = rPrChildren.find(child => child['w:shd'] !== undefined);
    if (shdElement) {
      const fill = getAttr(shdElement, 'fill');
      formatting.highlight = fill !== '' && fill !== 'auto';
      if (formatting.highlight && fill) {
        formatting.highlightColor = fill;
      } else {
        formatting.highlightColor = undefined;
      }
    }
  }
  
  // superscript/subscript: w:vertAlign (explicit value overrides inherited pair)
  const vertAlignElement = rPrChildren.find(child => child['w:vertAlign'] !== undefined);
  if (vertAlignElement) {
    const val = getAttr(vertAlignElement, 'val');
    formatting.superscript = val === 'superscript';
    formatting.subscript = val === 'subscript';
  }

  // inline code: w:rStyle with val matching "CodeChar" (case-insensitive)
  const rStyleElement = rPrChildren.find(child => child['w:rStyle'] !== undefined);
  if (rStyleElement) {
    const val = getAttr(rStyleElement, 'val');
    formatting.code = !!(val && val.toLowerCase() === 'codechar');
  }

  return formatting;
}

/** `text` as the whitespace and line breaks (a backslash and a line's end)
 *  it starts with, the rest, and those it ends with. Read from each end, as
 *  a regex with a lazy middle took time in the square of a run of
 *  whitespace inside the text, and found none past some length. */
function edgeWhitespace(text: string): [string, string, string] {
  let start = 0;
  while (start < text.length) {
    if (text.startsWith('\\\n', start)) start += 2;
    else if (/\s/.test(text[start])) start++;
    else break;
  }
  let end = text.length;
  while (end > start) {
    if (end - 2 >= start && text.startsWith('\\\n', end - 2)) end -= 2;
    else if (/\s/.test(text[end - 1])) end--;
    else break;
  }
  return [text.slice(0, start), text.slice(start, end), text.slice(end)];
}

/** Apply formatting delimiters in nesting order, keeping edge whitespace
 *  outside markers, and line breaks, whose backslash before a closer would
 *  escape it */
function wrapMarkdownDelimited(text: string, open: string, close = open, suffix = ''): string {
  const [leading, core, trailing] = edgeWhitespace(text);
  if (!core) return text;
  return leading + open + core + close + suffix + trailing;
}

/** The Markdown name of a run's highlight color, if it has one. */
function markdownHighlightColor(fmt: RunFormatting): string | undefined {
  return fmt.highlightColor ? resolveMarkdownColor(fmt.highlightColor) : undefined;
}

/** `markdown` in a highlight of a Markdown color: ==a==, or ==a=={red}. The
 *  highlight holds the whitespace at its edges, which Word shows it on, as
 *  == reads as a highlight next to whitespace too, and line breaks, as in
 *  ==a\\\n==b, whose == after a line's start closes it, as emphasis's
 *  can't (see wrapMarkdownDelimited); alone on a paragraph's last line it
 *  would read as a heading's underline, so a line break before it there is
 *  <br> (see HARD_BREAK_BEFORE_HIGHLIGHT_CLOSE_AT_END). One that `joins`
 *  its neighbour's takes marks of its own (see joinHighlights). */
function wrapHighlight(markdown: string, color: string | undefined, joins = false): string {
  if (!markdown) return markdown;
  // A } it starts with is escaped, which would read with its == as
  // CriticMarkup's ==}, which ends a comment's range around it, as in
  // {====}a====}. A { it ends with, which would read with its == as {==,
  // the text's end escapes (see escapeMarkdownChars).
  return '==' + (joins ? HIGHLIGHT_JOIN_OPEN : HIGHLIGHT_OPEN) + (markdown[0] === '}' ? '\\' : '') + markdown
    + (joins ? HIGHLIGHT_JOIN_CLOSE : HIGHLIGHT_CLOSE) + '==' + (color && color !== 'yellow' ? '{' + color + '}' : '');
}

/** `text` as Markdown with Word's formatting. `lineStart` says the text
 *  starts a line, `blockStart` that it starts a block's text, where an HTML
 *  block can start, and `after` gives the text of the runs after it in its
 *  paragraph (see escapeMarkdownChars). */
export function wrapWithFormatting(text: string, fmt: RunFormatting, lineStart = false, after?: RunsAfter, blockStart = lineStart): string {
  return resolveEmphasis(markedFormatting(text, fmt, lineStart, after, blockStart));
}

/** A run's Markdown, as wrapWithFormatting writes it, with its outermost
 *  bold, italic or strikethrough marked for resolveEmphasis, and its
 *  highlight around the rest where `highlightOuter` (see joinsHighlight). */
function markedFormatting(text: string, fmt: RunFormatting, lineStart = false, after?: RunsAfter, blockStart = lineStart, highlightOuter = false): string {
  if (!readsMarkdown) return htmlCellRun(text, fmt, highlightOuter);
  let result = text;

  // Apply in reverse nesting order (innermost to outermost)
  // Code is innermost — applied first
  if (fmt.code) {
    // A line break, which a code span can't hold, goes between spans of the
    // text on each side of it, in the rest of the formatting around them,
    // which Word shows on it too, as a highlight's, ==`a`\\\n`b`==, or in
    // the highlight of the spans an == in the code splits it into (see
    // below), ==`a`\\\n`x =`=={yellow}==`=y`=={yellow}
    if (text.includes('\\\n') && !(fmt.highlight && text.includes('=='))) {
      const spans = text.split('\\\n').map(part => part && markedFormatting(part, { ...DEFAULT_FORMATTING, code: true })).join('\\\n');
      return wrapFormatting(spans, fmt, highlightOuter);
    }
    // Code keeps its formatting, which **`code`** and ==`code`== export.
    // An == in it would close the highlight, even in code, so it goes in
    // spans highlighted apart, split between the two =, inside the rest of
    // its formatting, each with its color named, yellow too, as in
    // ==`x =`=={yellow}==`=`=={yellow}: navigation, the grammar and the
    // editor's decorations read no highlight around code with an =, and
    // would pair a closing == before no color with the next ==. Export
    // writes a run for each span, formatted alike, which Word shows as
    // one: no Markdown holds the code in one highlight, but CriticMarkup's
    // {==...==}, which marks a comment's text and holds no color.
    if (fmt.highlight && text.includes('==')) {
      const color = markdownHighlightColor(fmt) ?? 'yellow';
      const code = { ...DEFAULT_FORMATTING, code: true, superscript: fmt.superscript, subscript: fmt.subscript };
      const spans = text.split(/(?<==)(?==)/)
        .map(part => wrapHighlight(markedFormatting(part, code), color) + (color === 'yellow' ? '{yellow}' : '')).join('');
      return wrapFormatting(spans, { ...fmt, superscript: false, subscript: false, highlight: false });
    }
    // Find the longest run of consecutive backticks in the text
    let maxRun = 0;
    const backtickRuns = result.match(/`+/g);
    if (backtickRuns) {
      for (const run of backtickRuns) {
        if (run.length > maxRun) maxRun = run.length;
      }
    }
    const fence = '`'.repeat(maxRun + 1);
    // Add padding space if content starts/ends with a backtick, or if
    // content has both leading and trailing spaces and isn't all spaces
    // (CommonMark §6.1 would strip one space from each end, losing the
    // original whitespace, as of ' \t ', and keeps spaces alone as they are).
    const hasLeadingTrailingSpaces = result.startsWith(' ') && result.endsWith(' ') && /[^ ]/.test(result);
    const needsPadding = result.startsWith('`') || result.endsWith('`') || hasLeadingTrailingSpaces;
    result = needsPadding ? `${fence} ${result} ${fence}` : `${fence}${result}${fence}`;
    return wrapFormatting(result, fmt, highlightOuter);
  }

  // Escape markdown-sensitive characters so they round-trip faithfully.
  // Only applies to non-code text (code is already fenced with backticks
  // above), and before the tags, whose &lt; it would take for Word's text.
  // Formatting's delimiters start the line in place of the text.
  const delimited = fmt.superscript || fmt.subscript || fmt.highlight || fmt.underline || fmt.strikethrough || fmt.italic || fmt.bold;
  // Markdown's delimiters go inside the text's edge whitespace (see
  // wrapMarkdownDelimited), so the text reads them next, not the
  // whitespace: a \ or { at its end would escape the closer or open with
  // it, as in **\** and =={==, which its end escapes, as nothing follows
  const edges = !fmt.superscript && !fmt.subscript && (fmt.highlight || !fmt.underline && (fmt.strikethrough || fmt.italic || fmt.bold))
    ? ['', ...edgeWhitespace(result)]
    : ['', '', result, ''];
  // Not a tag in a citation's keys, which export reads as they are
  const keys = new Set<number>();
  // An = that could join a highlight's closing ==, which no backslash
  // keeps from it, goes as a reference (below)
  const references = fmt.highlight && /==|=\s*$/.test(text);
  let core = escapeSensitiveHtmlLikeTags(escapeMarkdownChars(edges[2], lineStart && !delimited, after, keys, !delimited && !!after?.mathFirst, references), keys);
  // A ~ at the edge of struck text would join the ~~ around it, which
  // reads ~~~a~~ as ~ and struck a, where nothing comes between them, as a
  // highlight does inside them, but not one around them (`highlightOuter`)
  if (fmt.strikethrough && !fmt.superscript && !fmt.subscript && (!fmt.highlight || highlightOuter) && !fmt.underline) {
    core = core.replace(/^~/, '\\~').replace(/((?:^|[^\\])(?:\\\\)*)~$/, (_m, before: string) => before + '\\~');
  }
  const escaped = edges[1] + core + edges[3];
  // A paragraph that is an HTML block, as export writes one, reads as it is,
  // escapes and all, so it takes none, as in <div>https://e.com</div>,
  // unless a line break of Word's would read as a backslash in it. Up to
  // three spaces can come before it, which buildMarkdown writes as they are
  const htmlBlock = !delimited && blockStart && !result.includes('\\\n') && isHtmlBlock(result.replace(/^ {1,3}(?=<)/, '')) && after?.first === '';
  result = htmlBlock ? result : escaped;

  // An = as a reference, without the backslash of an escaped =, not one of
  // an escaped backslash's
  if (references) result = result.replace(/((?:\\\\)*)\\?=/g, (_m, pairs: string) => pairs + '&#61;');
  return wrapFormatting(result, fmt, highlightOuter);
}

/** A run's text and formatting as HTML, as renderHtmlCellParagraph writes
 *  them, for a cell's paragraph it can't write, whose escapes export would
 *  read as text, as it would a line break's backslash. Its tags go as
 *  wrapFormatting writes delimiters: bold's and italic's inside the
 *  whitespace at the edges of what they hold, and a highlight's ==, as
 *  text, which has no tag, around the rest where it joins its neighbours'
 *  (`joins`), with the whitespace inside, which joinHighlights,
 *  keepHtmlCellSpaces and citationSeparator read there. A brace, a ~, a backtick, and an = next
 *  to another or at the run's edge, or any in a highlight, which the
 *  grammar and navigation would read as CriticMarkup, strikethrough, code,
 *  or a highlight with the == around it, or no highlight, are references. */
function htmlCellRun(text: string, fmt: RunFormatting, joins = false): string {
  let html = text.split('\\\n').map((line, k, lines) => line.replace(/[^ ]/g, (c, i: number) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '\t' ? '&#9;' : c === '\u00a0' ? '&nbsp;'
      : c === '{' ? '&#123;' : c === '}' ? '&#125;' : c === '~' ? '&#126;' : c === '`' ? '&#96;'
        : c === '=' && (fmt.highlight || line[i - 1] === '=' || line[i + 1] === '=' || k === 0 && i === 0 || k === lines.length - 1 && i === line.length - 1) ? '&#61;' : c,
  )).join('<br>');
  // Around what's between the `edges` at each end, unless that's nothing,
  // read from the ends, as a regex with a lazy middle would scan the text
  // for each
  const wrap = (edges: string[], around: (core: string) => string) => {
    let start = 0;
    for (let edge; (edge = edges.find(e => html.startsWith(e, start)));) start += edge.length;
    let end = html.length;
    for (let edge; (edge = edges.find(e => end - e.length >= start && html.endsWith(e, end)));) end -= edge.length;
    if (start < end) html = html.slice(0, start) + around(html.slice(start, end)) + html.slice(end);
  };
  const breaks = ['<br>'];
  const blank = [' ', '&#9;', '&nbsp;', '<br>'];
  if (fmt.code) html = '<code>' + html + '</code>';
  if (fmt.superscript) html = '<sup>' + html + '</sup>';
  else if (fmt.subscript) html = '<sub>' + html + '</sub>';
  if (fmt.highlight && !joins) wrap(breaks, core => wrapHighlight(core, markdownHighlightColor(fmt)));
  if (fmt.underline) html = '<u>' + html + '</u>';
  // Around the whitespace, which Word shows struck, as Markdown can't
  if (fmt.strikethrough) html = '<s>' + html + '</s>';
  if (fmt.italic) wrap(blank, core => '<i>' + core + '</i>');
  if (fmt.bold) wrap(blank, core => '<b>' + core + '</b>');
  if (fmt.highlight && joins) wrap(breaks, core => wrapHighlight(core, markdownHighlightColor(fmt), true));
  return html;
}

/** A cell's paragraph's HTML with the spaces HTML would drop or run
 *  together, as export reads it, as references: those at the start of a
 *  line, a space after a space, and those at the paragraph's end, past the
 *  tags there. A comment, which export keeps as it is, stays as it is. */
function keepHtmlCellSpaces(html: string): string {
  let out = '';
  let lineStart = true;
  let afterSpace = false;
  // A tag, as a link's, with its attributes, whose values hold no < or >
  for (const [token] of html.matchAll(/<!--(?:(?!--!?>)[\s\S])*(?:--!?>|$)|<br>|<\/?[a-z]+(?: [^<>]*)?>| |[^ <]+|</gi)) {
    if (token === ' ') {
      out += lineStart || afterSpace ? '&#32;' : ' ';
      afterSpace = true;
    } else {
      out += token;
      if (token === '<br>') lineStart = true;
      if (token === '<br>' || !/^<(?:!--|\/?[a-z]+[ >])/i.test(token)) afterSpace = false;
      if (token !== '<br>' && !/^<(?:!--|\/?[a-z]+[ >])/i.test(token)) lineStart = false;
    }
  }
  // From the end, past the closing tags there, as a regex for the spaces
  // would scan each run of them before
  let tags = out.length;
  for (let close; (close = /<\/[a-z]+>$/i.exec(out.slice(Math.max(0, tags - 12), tags)));) tags -= close[0].length;
  let spaces = tags;
  while (out[spaces - 1] === ' ') spaces--;
  return out.slice(0, spaces) + '&#32;'.repeat(tags - spaces) + out.slice(tags);
}

/** `markdown`, a run's text, in the tags and delimiters of its formatting
 *  `fmt`, innermost first, but for code, whose backticks are its own */
function wrapFormatting(markdown: string, fmt: RunFormatting, highlightOuter = false): string {
  let result = markdown;
  // If both superscript and subscript are true, superscript takes precedence
  if (fmt.superscript) {
    result = `<sup>${result}</sup>`;
  } else if (fmt.subscript) {
    result = `<sub>${result}</sub>`;
  }
  if (fmt.highlight && !highlightOuter) result = wrapHighlight(result, markdownHighlightColor(fmt));
  if (fmt.underline) result = `<u>${result}</u>`;
  if (fmt.strikethrough) result = wrapStrikethrough(result, !fmt.italic && !fmt.bold);
  if (fmt.italic) result = wrapEmphasis(result, '*', !fmt.bold);
  if (fmt.bold) result = wrapEmphasis(result, '**');
  // A highlight that joins its neighbour's goes around the rest, so that
  // they join in one (see joinHighlights)
  if (fmt.highlight && highlightOuter) result = wrapHighlight(result, markdownHighlightColor(fmt), true);
  return result;
}

/** By segment, and range of it, whether the highlight of each item in it
 *  joins (see joinsHighlight) */
const highlightJoins = new WeakMap<ContentItem[], Map<string, boolean[]>>();

/** Whether the highlight of the text item at `i` joins its neighbours' in
 *  segment[start, end): it's one of two or more side by side highlighted
 *  alike, with nothing between them in Markdown, in the same comments and
 *  revision, outside a link, and not code, which navigation reads no
 *  highlight around. Their
 *  highlight goes around the rest of their formatting then; one alone
 *  keeps it inside, as **==a==** has it, as do they all next to a
 *  highlight of its own, as of another color, which one around the rest
 *  would run into, as in ==a====**b**c=={red}. For the range at once, so
 *  each run is read once. */
function joinsHighlight(segment: ContentItem[], i: number, start: number, end: number): boolean {
  let byRange = highlightJoins.get(segment);
  if (!byRange) highlightJoins.set(segment, byRange = new Map());
  const key = start + ':' + end + ':' + segment.length;
  let joins = byRange.get(key);
  if (!joins) {
    const joinable = (item: ContentItem | undefined): item is ContentItem & { type: 'text' } =>
      item?.type === 'text' && !!item.formatting.highlight && !item.href && !item.formatting.code
      // A } or =, which navigation and the grammar read no highlight
      // around, as they would then read none around its neighbours' text
      && !/[}=]/.test(item.text);
    const alike = (item: ContentItem & { type: 'text' }, other: ContentItem | undefined): boolean => joinable(other)
      && other.formatting.highlightColor === item.formatting.highlightColor
      && commentSetsEqual(other.commentIds, item.commentIds) && revisionsEqual(other.revision, item.revision);
    // Highlighted otherwise, with nothing between them, as a tracked
    // change's or a comment's delimiters or a link's brackets would be
    const abuts = (item: ContentItem & { type: 'text' }, other: ContentItem | undefined): boolean => !!other
      && 'formatting' in other && !!other.formatting?.highlight && !('href' in other && other.href)
      && commentSetsEqual(other.commentIds, item.commentIds) && revisionsEqual(other.revision, item.revision);
    joins = new Array<boolean>(end - start).fill(false);
    for (let k = start; k < end;) {
      const item = segment[k];
      let last = k;
      if (joinable(item)) {
        while (last + 1 < end && alike(item, segment[last + 1])) last++;
        if (last > k && !(k > start && abuts(item, segment[k - 1])) && !(last + 1 < end && abuts(item, segment[last + 1]))) {
          for (let m = k; m <= last; m++) joins[m - start] = true;
        }
      }
      k = last + 1;
    }
    byRange.set(key, joins);
  }
  return joins[i - start] ?? false;
}

/** `markdown` with each highlight of a run that joins its neighbour's (see
 *  joinsHighlight) that runs into the next of its color, as in
 *  ==a ====*b*==, joined with it, as in ==a *b*==, as Word's text of the
 *  runs is highlighted all along, as a Markdown highlight around emphasis
 *  exports it. Their highlights go around the rest of their formatting, so
 *  what they hold stays whole. Their marks are a highlight's then. */
function joinHighlights(markdown: string): string {
  if (!markdown.includes(HIGHLIGHT_JOIN_OPEN)) return markdown;
  // eslint-disable-next-line no-control-regex
  return markdown.replace(/\u000F==(\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\})?==\u000E(?=[^\u000F]*\u000F==(\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\})?)/g,
    (seam, color: string | undefined, nextColor: string | undefined) => color === nextColor ? '' : seam)
    // eslint-disable-next-line no-control-regex
    .replace(/\u000E/g, HIGHLIGHT_OPEN).replace(/\u000F/g, HIGHLIGHT_CLOSE);
}

/** The marks markedFormatting puts after a run's outermost opening delimiter
 *  of emphasis or strikethrough, by delimiter, and before its closing one. A
 *  Word document can't hold them, which XML excludes. */
const EMPHASIS_OPEN = { '**': '\u0001', '*': '\u0002', '~~': '\u0003' } as const;
const EMPHASIS_CLOSE = '\u0004';
/** The marks wrapHighlight puts after a highlight's opening == and before
 *  its closing one, so that resolveEmphasis can tell an = of the text
 *  before it, which would run into its ==, from another's closing ==,
 *  which gets its color there */
const HIGHLIGHT_OPEN = '\u0005';
const HIGHLIGHT_CLOSE = '\u0006';
/** The marks of a highlight that joins its neighbour's (see joinHighlights) */
const HIGHLIGHT_JOIN_OPEN = '\u000E';
const HIGHLIGHT_JOIN_CLOSE = '\u000F';
/** By opening mark, its delimiter and the HTML tag that can stand for it,
 *  as an HTML table's cells write it */
const EMPHASIS_BY_MARK: Record<string, { delimiter: string; tag: string }> = {
  '\u0001': { delimiter: '**', tag: 'b' }, '\u0002': { delimiter: '*', tag: 'i' }, '\u0003': { delimiter: '~~', tag: 's' },
};

/** Whether Word shows formatting `fmt` on a line break, as it does a
 *  highlight's, an underline's or a strikethrough's, which ==, <u> and <s>
 *  hold around one, but not bold's or italic's, which it doesn't show, nor
 *  code's, which a code span can't hold */
function showsOnBreak(fmt: RunFormatting): boolean {
  return fmt.highlight || fmt.underline || fmt.strikethrough;
}

/** `markdown` struck: in ~~ (see wrapEmphasis), or in <s> where it has
 *  whitespace or a line break at its edges, which Word shows struck, as ~~
 *  keeps them outside (see wrapMarkdownDelimited), or is whitespace alone */
function wrapStrikethrough(markdown: string, marked: boolean): string {
  if (!markdown || !/^\s|^\\\n|\s$/.test(markdown)) return wrapEmphasis(markdown, '~~', marked);
  return '<s>' + markdown + '</s>';
}

/** `markdown` in emphasis or strikethrough, its delimiters marked for
 *  resolveEmphasis unless `marked` is false, as for one inside another. */
function wrapEmphasis(markdown: string, delimiter: keyof typeof EMPHASIS_OPEN, marked = true): string {
  return marked
    ? wrapMarkdownDelimited(markdown, delimiter + EMPHASIS_OPEN[delimiter], EMPHASIS_CLOSE + delimiter)
    : wrapMarkdownDelimited(markdown, delimiter);
}

const FLANK_SPACE = 0;
const FLANK_PUNCT = 1;
const FLANK_OTHER = 2;

/** How markdown-it reads a character next to a delimiter of emphasis:
 *  whitespace, punctuation or other, by UTF-16 code unit, as it does. A
 *  text's edge reads as whitespace, as a line's does, and a mark as
 *  punctuation, as its delimiter or tag does. */
function flankClass(code: number): number {
  if (Number.isNaN(code) || isWhiteSpace(code)) return FLANK_SPACE;
  return code <= 6 || isMdAsciiPunct(code) || isPunctChar(String.fromCharCode(code)) ? FLANK_PUNCT : FLANK_OTHER;
}

/**
 * `markdown` with its marked delimiters (markedFormatting) written as
 * Markdown where they read as emphasis between the characters around them,
 * and as HTML tags where they don't: an opening delimiter after a letter
 * and before punctuation, as in a**.b**, a closing one after punctuation
 * and before a letter, or one that runs into a delimiter of its kind
 * outside it, as in *a***b**. Delimiters inside a run's outermost border it,
 * or once that's HTML, its tag, which are punctuation, so only the
 * outermost is marked. The text's start and end read as a line's, as a
 * range's Markdown starts and ends one. Where `track` asks, where each of
 * its positions in `markdown`, in order, goes in what this writes, but for
 * text with a highlight, whose marks this rewrites.
 */
function resolveEmphasis(markdown: string, track?: { positions: number[]; resolved: number[] }): string {
  // A highlight's close alone has its mark where a substitution's side
  // kept it (see resolveSide)
  if (!markdown.includes(EMPHASIS_CLOSE) && !markdown.includes(HIGHLIGHT_OPEN) && !markdown.includes(HIGHLIGHT_JOIN_OPEN)
    && !markdown.includes(HIGHLIGHT_CLOSE)) {
    if (track) track.resolved = [...track.positions];
    return markdown;
  }
  // eslint-disable-next-line no-control-regex
  if (track && /[\u0005\u0006\u000E\u000F]/.test(markdown)) track = undefined;
  // A highlight of the default color right before another's == gets its
  // color, whose } keeps their == apart, as in ==a =={yellow}==b=={red}.
  // Navigation and the grammar read ==a ====b=={red} as no highlight. The
  // text's = before one is a reference (below). A comment's {== or ==}
  // next to one needs neither, as they read the comment's range whole.
  // eslint-disable-next-line no-control-regex
  markdown = joinHighlights(markdown).replace(/\u0006==(?===\u0005)/g, '\u0006=={yellow}');
  const closeAt = new Map<number, number>();
  const opens: number[] = [];
  for (let i = 0; i < markdown.length; i++) {
    const code = markdown.charCodeAt(i);
    if (code >= 1 && code <= 3) opens.push(i);
    else if (code === 4 && opens.length > 0) closeAt.set(opens.pop()!, i);
  }
  // A closing mark's delimiter and what it's written as, and by where a
  // closing delimiter ends, the last character it's written with. Reading
  // the text as written, not the parts, keeps this linear.
  const closers = new Map<number, { delimiter: string; text: string }>();
  const writtenEnds = new Map<number, number>();
  const parts: string[] = [];
  // Each tracked position, as the part of the text written as it is that
  // takes it, and where in that part, or where it starts for one in what
  // isn't written as it is, before it
  const tracked: Array<[number, number]> = [];
  const pushText = (start: number, end: number) => {
    while (track && tracked.length < track.positions.length && track.positions[tracked.length] <= end) {
      tracked.push([parts.length, Math.max(0, track.positions[tracked.length] - start)]);
    }
    parts.push(markdown.slice(start, end));
  };
  let from = 0;
  for (let i = 0; i < markdown.length; i++) {
    const code = markdown.charCodeAt(i);
    if (code >= 1 && code <= 3) {
      const { delimiter, tag } = EMPHASIS_BY_MARK[markdown[i]];
      const marker = delimiter[0];
      const start = i - delimiter.length;
      pushText(from, start);
      from = i + 1;
      const close = closeAt.get(i);
      if (close === undefined) {
        parts.push(delimiter);
        continue;
      }
      // A delimiter inside of the same character is in the same run, which
      // reads by the characters past it: ***a*** after a letter opens
      let first = i + 1;
      while (markdown[first] === marker) first++;
      let last = close - 1;
      while (last > i && markdown[last] === marker) last--;
      const afterAt = close + 1 + delimiter.length;
      let afterRun = afterAt;
      while (markdown[afterRun] === marker) afterRun++;
      const beforeCode = writtenEnds.get(start) ?? markdown.charCodeAt(start - 1);
      const before = flankClass(beforeCode);
      const after = flankClass(markdown.charCodeAt(afterAt));
      const inner = [flankClass(markdown.charCodeAt(first)), flankClass(markdown.charCodeAt(last))];
      const canOpen = inner[0] !== FLANK_SPACE && !(inner[0] === FLANK_PUNCT && before === FLANK_OTHER);
      const canClose = inner[1] !== FLANK_SPACE && !(inner[1] === FLANK_PUNCT && after === FLANK_OTHER);
      // One of its kind before it, unless escaped, or after it, unless that
      // opens a marked run, which reads this one before it. A substitution's
      // sides read apart from its {~~, ~> and ~~}.
      let slashes = 0;
      if (!writtenEnds.has(start)) while (markdown[start - 2 - slashes] === '\\') slashes++;
      const runsInto = (beforeCode === marker.charCodeAt(0) && slashes % 2 === 0
          && !markdown.startsWith('{~~', start - 3) && !markdown.startsWith('~>', start - 2))
        || (afterRun > afterAt && !(markdown.charCodeAt(afterRun) >= 1 && markdown.charCodeAt(afterRun) <= 3)
          && !markdown.startsWith('~>', afterAt) && !markdown.startsWith('~~}', afterAt));
      const html = !canOpen || !canClose || runsInto;
      parts.push(html ? '<' + tag + '>' : delimiter);
      closers.set(close, { delimiter, text: html ? '</' + tag + '>' : delimiter });
    } else if (code === 4) {
      pushText(from, i);
      const closer = closers.get(i);
      if (closer) {
        parts.push(closer.text);
        writtenEnds.set(i + 1 + closer.delimiter.length, closer.text.charCodeAt(closer.text.length - 1));
      }
      from = i + 1 + (closer ? closer.delimiter.length : 0);
    } else if (code === 5) {
      // The text's = before a highlight's == would open it a character
      // early, as a===b== highlights =b. Escaped, as in a\===b==, it keeps
      // navigation and the grammar from reading the highlight, so it's a
      // reference, a&#61;==b==, with no backslash where escaped, as after
      // another highlight (see escapeAfterHighlight). A comment's {== stays,
      // as its range starts after it.
      const start = i - 2;
      let slashes = 0;
      while (markdown[start - 2 - slashes] === '\\') slashes++;
      const delimiter = markdown[start - 2] === '=' && markdown[start - 3] === '{';
      const before = markdown.slice(from, start);
      parts.push(before.endsWith('=') && !delimiter ? before.slice(0, -1 - slashes % 2) + '&#61;' : before);
      parts.push('==');
      from = i + 1;
    } else if (code === 6) {
      pushText(from, i);
      from = i + 1;
    }
  }
  pushText(from, markdown.length);
  if (track) {
    const offsets: number[] = [];
    let length = 0;
    for (const part of parts) {
      offsets.push(length);
      length += part.length;
    }
    track.resolved = tracked.map(([part, offset]) => offsets[part] + offset);
  }
  return parts.join('');
}

/** A link's or image's destination as Markdown reads it back as `href`: a \
 *  that would escape the character after it, as in a UNC path's \\server,
 *  or the ) or > that ends the destination, and an & that would start a
 *  character reference, as markdown-it's unescapeAll reads one, numbers of
 *  up to eight digits included, which Markdown decodes, are escaped. In <>, where
 *  spaces, parentheses or brackets, or a < at its start, put it, so are a <
 *  and a >, which would end it. */
function formatHrefForMarkdown(href: string): string {
  const escaped = href.replace(/\\(?=[!-\/:-@[-`{-~]|$)/g, '\\\\')
    .replace(/&(?=[A-Za-z#][A-Za-z\d]{1,31};)/g, '\\&');
  return /[()[\]\s]|^</.test(href) ? '<' + escaped.replace(/[<>]/g, c => '\\' + c) + '>' : escaped;
}

/** A link of Markdown `text` to `href`, with a @ that starts the text,
 *  after a - or not, escaped, as export reads [@ as a citation's, even
 *  before a link's ( (see citationEnd). Export ends a citation at the
 *  first ], escaped too, so it reads the text before an escaped ] in the
 *  text as one where a key's @ comes after a space, as in [see @a\]](u),
 *  whose @ is escaped then, as one escaped starts no key. A key in code
 *  stays as it is, where a backslash would be text. */
function markdownLink(text: string, href: string): string {
  // In an HTML table's cell, which export reads as HTML, its tag, as
  // renderHtmlCellParagraph writes it
  if (!readsMarkdown) return '<a href="' + escapeHtmlAttr(href) + '">' + text + '</a>';
  const url = formatHrefForMarkdown(href);
  const label = escapeTagLeftOpen(text.replace(/^(-?)@/, (_m, dash: string) => dash + '\\@'), url);
  const close = label.indexOf(']');
  if (close === -1 || citationEndInText('[' + label + '](' + url + ')', 0) === -1) return '[' + label + '](' + url + ')';
  // Each key before the ], at once, as the label is read once
  const code = computeCodeRegions('[' + label + '](' + url + ')');
  const keys = label.slice(0, close).replace(/(^|\s)(-?)@(?=[\p{L}\p{N}_])/gu, (key, space: string, dash: string, at: number) =>
    isInsideCodeRegion(1 + at + space.length + dash.length, code) ? key : space + dash + '\\@');
  return '[' + keys + label.slice(close) + '](' + url + ')';
}

// A tag's start, as far as an attribute's = and its value, unquoted or
// with no closing quote, at the text's end, which the text after can go on,
// its attributes as markdown-it reads them: not a highlight's ==, as in
// ==<A +==, which no tag holds
const TAG_ATTRIBUTE_NAME = '[A-Za-z_:][A-Za-z0-9_.:-]*';
const TAG_LEFT_OPEN_AT = new RegExp('<[A-Za-z][A-Za-z0-9-]*(?:\\s+' + TAG_ATTRIBUTE_NAME
  + '(?:\\s*=\\s*(?:[^"\'=<>`\\s]+|\'[^\']*\'|"[^"]*"))?)*\\s+' + TAG_ATTRIBUTE_NAME
  + '\\s*=\\s*(?:[^"\'=<>`\\s]*|"[^"]*|\'[^\']*)$', 'y');

/** A link's Markdown `text` with the < escaped of a tag it leaves open at
 *  its end, as bold <span a=" before a link of "> to one place, which would
 *  take the ](url) after it, and what follows to a >, as its attribute's.
 *  From the left, as Markdown reads tags, each whole one taking the < in
 *  it, but none in code or after a backslash. */
function escapeTagLeftOpen(text: string, url: string): string {
  let code: ReturnType<typeof computeCodeRegions> | undefined;
  for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i + 1)) {
    let slashes = 0;
    while (text[i - 1 - slashes] === '\\') slashes++;
    if (slashes % 2 === 1) continue;
    code ??= computeCodeRegions('[' + text + '](' + url + ')');
    if (isInsideCodeRegion(1 + i, code)) continue;
    HTML_TAG_AT.lastIndex = i;
    if (HTML_TAG_AT.test(text)) {
      i = HTML_TAG_AT.lastIndex - 1;
      continue;
    }
    TAG_LEFT_OPEN_AT.lastIndex = i;
    if (TAG_LEFT_OPEN_AT.test(text)) return text.slice(0, i) + '\\' + text.slice(i);
  }
  return text;
}

// Comment extraction

/** The text a comment's paragraph shows: its runs' text, with a line break
 *  as a line's end, without deleted runs or a paragraph inside it */
function commentParagraphText(nodes: XmlNode[]): string {
  let text = '';
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      if (key === 'w:t') {
        text += nodeText(asXmlNodes(node[key]));
      } else if (key in RUN_CHARACTERS) {
        text += RUN_CHARACTERS[key];
      } else if (key === 'w:sym') {
        text += symbolCharacter(node) ?? '';
      } else if (key === 'w:cr' || (key === 'w:br' && [undefined, '', 'textWrapping'].includes(node[':@']?.['@_w:type']))) {
        text += '\n';
      } else if (!['w:del', 'w:moveFrom', 'w:pPr', 'w:rPr', 'w:p'].includes(key) && key !== ':@' && Array.isArray(node[key])) {
        text += commentParagraphText(node[key]);
      }
    }
  }
  return text;
}

/** Whether a comment paragraph's mark is deleted, which joins its text to
 *  the next paragraph's, as accepting the deletion would */
function commentParagraphMarkDeleted(paragraph: XmlNode): boolean {
  const pPr = asXmlNodes(paragraph['w:p']).find(child => child['w:pPr'] !== undefined);
  const rPr = pPr && asXmlNodes(pPr['w:pPr']).find(child => child['w:rPr'] !== undefined);
  return !!rPr && asXmlNodes(rPr['w:rPr']).some(child => child['w:del'] !== undefined || child['w:moveFrom'] !== undefined);
}

export async function extractComments(data: Uint8Array | JSZip): Promise<Map<string, Comment>> {
  const comments = new Map<string, Comment>();
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/comments.xml');
  if (!parsed) { return comments; }

  for (const node of findAllDeep(parsed, 'w:comment')) {
    const id = getAttr(node, 'id');
    const author = getAttr(node, 'author');
    const date = getAttr(node, 'date') || '';
    // The comment's paragraphs, with a blank line between them, where
    // export splits them
    const paragraphs = findAllDeep(asXmlNodes(node['w:comment']), 'w:p');
    const text = paragraphs.map((p, k) => commentParagraphText(asXmlNodes(p['w:p']))
      + (k < paragraphs.length - 1 && !commentParagraphMarkDeleted(p) ? '\n\n' : '')).join('');
    // Extract w14:paraId from the last comment paragraph. md-to-docx emits
    // paraId on the last <w:p> (per commentsExtended linking expectations),
    // but keep a first-paragraph fallback for third-party documents.
    const pNodes = findAllDeep(asXmlNodes(node['w:comment']), 'w:p');
    let paraId: string | undefined;
    for (let i = pNodes.length - 1; i >= 0; i--) {
      const candidate = pNodes[i]?.[':@']?.['@_w14:paraId'];
      if (candidate) {
        paraId = candidate;
        break;
      }
    }
    if (!paraId) {
      paraId = pNodes[0]?.[':@']?.['@_w14:paraId'];
    }
    comments.set(id, { author, text, date, paraId });
  }
  return comments;
}

/** Parse word/commentsExtended.xml and return paraId→parentParaId map for reply comments. */
export async function extractCommentThreads(data: Uint8Array | JSZip): Promise<Map<string, string>> {
  const threads = new Map<string, string>();
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/commentsExtended.xml');
  if (!parsed) { return threads; }

  for (const node of findAllDeep(parsed, 'w15:commentEx')) {
    const paraId = node?.[':@']?.['@_w15:paraId'] ?? '';
    const parentParaId = node?.[':@']?.['@_w15:paraIdParent'] ?? '';
    if (paraId && parentParaId) {
      threads.set(paraId, parentParaId);
    }
  }
  return threads;
}

/**
 * Group reply comments under their parent as CommentReply entries.
 * Returns the set of reply comment IDs (to exclude from ranges).
 */
export function groupCommentThreads(
  comments: Map<string, Comment>,
  threads: Map<string, string>
): Set<string> {
  const replyIds = new Set<string>();
  if (threads.size === 0) return replyIds;

  // Build paraId→commentId lookup
  const paraIdToCommentId = new Map<string, string>();
  for (const [id, comment] of comments) {
    if (comment.paraId) {
      paraIdToCommentId.set(comment.paraId, id);
    }
  }

  // Attach replies to parents, flattening deeper chains to the root parent.
  // Word UI only produces flat reply lists, but third-party generators could
  // create deeper chains (reply-to-reply). We resolve these by walking up
  // the thread until we find the root (non-reply) comment.
  for (const [childParaId, parentParaId] of threads) {
    const childId = paraIdToCommentId.get(childParaId);
    if (!childId) continue;

    // Walk up to the root parent (with cycle detection for malformed DOCX)
    let resolvedParaId = parentParaId;
    const visited = new Set<string>();
    while (threads.has(resolvedParaId)) {
      if (visited.has(resolvedParaId)) break;
      visited.add(resolvedParaId);
      resolvedParaId = threads.get(resolvedParaId)!;
    }
    const parentId = paraIdToCommentId.get(resolvedParaId);
    if (!parentId) continue;

    const parent = comments.get(parentId);
    const child = comments.get(childId);
    if (!parent || !child) continue;

    if (!parent.replies) parent.replies = [];
    parent.replies.push({ author: child.author, text: child.text, date: child.date });
    replyIds.add(childId);
  }

  // Sort replies by date so ordering is deterministic regardless of
  // the element order in commentsExtended.xml.
  for (const comment of comments.values()) {
    if (comment.replies && comment.replies.length > 1) {
      comment.replies.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    }
  }

  return replyIds;
}

// Zotero document preferences extraction

export async function extractZoteroPrefs(data: Uint8Array | JSZip): Promise<ZoteroDocPrefs | undefined> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return undefined;

  // Find ZOTERO_PREF_* properties and concatenate in order
  const prefParts: Array<{ index: number; value: string }> = [];
  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (!name.startsWith('ZOTERO_PREF_')) continue;

    const idxStr = name.replace('ZOTERO_PREF_', '');
    const idx = parseInt(idxStr, 10);
    if (isNaN(idx)) continue;

    const children = propNode['property'];
    if (!Array.isArray(children)) continue;

    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const val = nodeText(asXmlNodes(child['vt:lpwstr']));
        prefParts.push({ index: idx, value: val });
      }
    }
  }

  if (prefParts.length === 0) return undefined;

  prefParts.sort((a, b) => a.index - b.index);
  const prefString = prefParts.map(p => p.value).join('');

  // Try JSON parse (dataVersion 4)
  try {
    const prefObj = JSON.parse(prefString);
    const styleId: string = prefObj?.style?.styleID ?? '';
    const locale: string = prefObj?.style?.locale ?? '';
    const noteType: number | undefined = prefObj?.prefs?.noteType;
    if (!styleId) return undefined;
    return {
      styleId,
      locale: locale || undefined,
      noteType: noteType !== undefined && noteType !== 0 ? noteType : undefined,
    };
  } catch {
    // Try XML parse (dataVersion 3)
    try {
      const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      const xmlData = xmlParser.parse(prefString);
      const styleId: string = xmlData?.data?.style?.['@_id'] ?? '';
      const locale: string = xmlData?.data?.style?.['@_locale'] ?? '';
      const noteType: number | undefined = xmlData?.data?.prefs?.['@_noteType'] != null
        ? parseInt(xmlData.data.prefs['@_noteType'], 10) : undefined;
      if (!styleId) return undefined;
      return {
        styleId,
        locale: locale || undefined,
        noteType: noteType !== undefined && !isNaN(noteType) && noteType !== 0 ? noteType : undefined,
      };
    } catch {
      return undefined;
    }
  }
}
/**
 * Read chunked custom property values from a DOCX ZIP and join them into a single string.
 * Handles two naming conventions:
 * - Strict: PREFIX_1, PREFIX_2, … (prefix ends with '_')
 * - Flexible: PREFIX (index 1), PREFIX_2, PREFIX_3, … (prefix without trailing '_')
 * Returns null if no matching properties are found.
 */
async function extractChunkedCustomProp(data: Uint8Array | JSZip, propPrefix: string): Promise<string | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const strict = propPrefix.endsWith('_');
  const parts: Array<{ index: number; value: string }> = [];
  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (!name.startsWith(propPrefix)) continue;

    let idx: number;
    if (strict) {
      const chunkMatch = name.slice(propPrefix.length).match(/^(\d+)$/);
      if (!chunkMatch) continue;
      idx = parseInt(chunkMatch[1], 10);
      if (isNaN(idx)) continue;
    } else {
      idx = 1;
      if (name !== propPrefix) {
        if (!name.startsWith(propPrefix + '_')) continue;
        const chunkMatch = name.slice(propPrefix.length + 1).match(/^(\d+)$/);
        if (!chunkMatch) continue;
        idx = parseInt(chunkMatch[1], 10);
        if (isNaN(idx)) continue;
      }
    }

    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const val = nodeText(asXmlNodes(child['vt:lpwstr']));
        parts.push({ index: idx, value: val });
      }
    }
  }

  if (parts.length === 0) return null;
  parts.sort((a, b) => a.index - b.index);
  return parts.map(p => p.value).join('');
}

export async function extractBlockquoteAlertStyleMapping(data: Uint8Array | JSZip): Promise<Map<number, boolean> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_BLOCKQUOTE_ALERT_STYLE');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, boolean>();
    for (const [key, isInline] of Object.entries(parsedJson)) {
      const groupIdx = parseInt(key, 10);
      if (isNaN(groupIdx) || typeof isInline !== 'number') continue;
      mapping.set(groupIdx, isInline === 1);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

async function extractIdMappingFromCustomXml(
  data: Uint8Array | JSZip,
  propPrefix: string,
): Promise<Map<string, string> | null> {
  const mappingJson = await extractChunkedCustomProp(data, propPrefix);
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<string, string>();
    for (const [numericId, originalId] of Object.entries(parsedJson)) {
      if (typeof originalId !== 'string' || !originalId) continue;
      mapping.set(String(numericId), originalId);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

export async function extractCommentIdMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_COMMENT_IDS');
}
// Footnote/endnote extraction

export async function extractFootnoteIdMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_FOOTNOTE_IDS');
}

/** Extract bookmark-name → "noteKind:noteId" mapping for footnote cross-references. */
export async function extractFootnoteCrossRefMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_FOOTNOTE_CROSSREFS');
}

export async function extractCodeBlockLanguageMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_CODE_BLOCK_LANGS');
}

export async function extractCodeBlockStyling(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_CODE_BLOCK_STYLING');
}

export async function extractTableFormatMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_FORMATS');
}

export async function extractPipeTableAlignedMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_PIPE_TABLE_ALIGNED');
}

export async function extractGridSourceColWidthsMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_GRID_SOURCE_COL_WIDTHS');
}

export async function extractTableFontSizeMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_FONT_SIZES');
}

export async function extractTableFontMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_FONTS');
}

export async function extractTableColWidthsMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_COL_WIDTHS');
}

export async function extractTableDigitsMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_DIGITS');
}

export async function extractTableDecimalMarkMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_DECIMAL_MARKS');
}

export async function extractTableDigitGroupingMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_DIGIT_GROUPINGS');
}

/** Each HTML table's HTML before and after it in its block, which Word
 *  doesn't show, and its first row's text and its contents when export
 *  wrote it (see tableFirstRow and tableContentsFingerprint), the count of
 *  tables alike before it, its scope, and the count of tables alike export
 *  wrote in all */
export async function extractTableHtmlAroundMapping(data: Uint8Array | JSZip): Promise<Map<string, [string, string, string, string, string, string, string]> | null> {
  const json = await extractChunkedCustomProp(data, 'MANUSCRIPT_TABLE_HTML_AROUND');
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const mapping = new Map<string, [string, string, string, string, string, string, string]>();
    for (const [index, around] of Object.entries(parsed)) {
      if (Array.isArray(around) && around.length === 7 && around.every(part => typeof part === 'string')
        && (around[0] || around[1])) mapping.set(index, [around[0], around[1], around[2], around[3], around[4], around[5], around[6]]);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

/** Each table's identity, by the index export wrote it at, which its
 *  settings, as its format and font, are by (see matchTables) */
export async function extractTableIdentities(data: Uint8Array | JSZip): Promise<TableIdentity[] | null> {
  const json = await extractChunkedCustomProp(data, 'MANUSCRIPT_TABLE_IDENTITIES');
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    // Or none, where one can't be read, and the settings go by index
    return Array.isArray(parsed) && parsed.every(id => Array.isArray(id) && id.length === 3 && id.every(part => typeof part === 'string'))
      ? parsed as TableIdentity[] : null;
  } catch {
    return null;
  }
}

export async function extractEmbedDirectiveMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_EMBED_DIRECTIVES');
}

export async function extractDefaultTableColWidths(data: Uint8Array | JSZip): Promise<string | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;
  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_DEFAULT_TABLE_COL_WIDTHS') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child?.['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        return raw || null;
      }
    }
  }
  return null;
}

export async function extractLandscapeTableMapping(data: Uint8Array | JSZip): Promise<Set<number> | null> {
  const mapping = await extractIdMappingFromCustomXml(data, 'MANUSCRIPT_LANDSCAPE_TABLES_');
  if (!mapping) return null;
  const result = new Set<number>();
  for (const [key, val] of mapping) {
    if (val === 'landscape') {
      const n = parseInt(key, 10);
      if (Number.isFinite(n)) result.add(n);
    }
  }
  return result.size > 0 ? result : null;
}

export async function extractPortraitTableMapping(data: Uint8Array | JSZip): Promise<Set<number> | null> {
  const mapping = await extractIdMappingFromCustomXml(data, 'MANUSCRIPT_PORTRAIT_TABLES_');
  if (!mapping) return null;
  const result = new Set<number>();
  for (const [key, val] of mapping) {
    if (val === 'portrait') {
      const n = parseInt(key, 10);
      if (Number.isFinite(n)) result.add(n);
    }
  }
  return result.size > 0 ? result : null;
}

export async function extractPortraitBreakOrdinals(data: Uint8Array | JSZip): Promise<Set<number> | null> {
  return extractBreakOrdinals(data, 'MANUSCRIPT_PORTRAIT_BREAKS_');
}

/** The section breaks' ordinals the custom property `prefix` lists */
async function extractBreakOrdinals(data: Uint8Array | JSZip, prefix: string): Promise<Set<number> | null> {
  const json = await extractChunkedCustomProp(data, prefix);
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    const result = new Set<number>();
    for (const v of arr) {
      if (typeof v === 'number' && Number.isFinite(v)) result.add(v);
    }
    return result.size > 0 ? result : null;
  } catch {
    return null;
  }
}

/** A count for each of some sections, by the ordinal of the break that
 *  ends each, from a custom property export writes as an object */
async function extractSectionCounts(data: Uint8Array | JSZip, prefix: string): Promise<Map<number, number> | null> {
  const json = await extractChunkedCustomProp(data, prefix);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result = new Map<number, number>();
    for (const [ordinal, count] of Object.entries(parsed)) {
      if (/^\d+$/.test(ordinal) && typeof count === 'number' && Number.isInteger(count) && count > 0) result.set(Number(ordinal), count);
    }
    return result.size > 0 ? result : null;
  } catch {
    return null;
  }
}

/** Extract custom style definitions from MANUSCRIPT_CUSTOM_STYLES_ custom property. */
export async function extractCustomStyles(data: Uint8Array | JSZip): Promise<Record<string, CustomStyleDef> | null> {
  const json = await extractChunkedCustomProp(data, 'MANUSCRIPT_CUSTOM_STYLES');
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // Validate structure
    const result: Record<string, CustomStyleDef> = {};
    for (const [name, def] of Object.entries(parsed)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const styleDef: CustomStyleDef = {};
      if (typeof d.font === 'string') styleDef.font = d.font;
      if (typeof d.fontSize === 'number') styleDef.fontSize = d.fontSize;
      if (typeof d.fontStyle === 'string') styleDef.fontStyle = d.fontStyle;
      if (typeof d.spacingBefore === 'number') styleDef.spacingBefore = d.spacingBefore;
      if (typeof d.spacingAfter === 'number') styleDef.spacingAfter = d.spacingAfter;
      if (d.paragraphIndent === 'none' || d.paragraphIndent === 0) styleDef.paragraphIndent = 'none';
      else if (typeof d.paragraphIndent === 'number' && d.paragraphIndent > 0) styleDef.paragraphIndent = d.paragraphIndent;
      result[name] = styleDef;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function extractListIndent(data: Uint8Array | JSZip): Promise<'tab' | 'spaces' | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_LIST_INDENT') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (raw === 'tab') return 'tab';
      }
    }
  }
  return null;
}

export async function extractConsecutiveReplyParaIds(data: Uint8Array | JSZip): Promise<Set<string> | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_CONSECUTIVE_REPLY_COMMENTS') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (raw) return new Set(raw.split(',').map(id => id.trim()).filter(Boolean));
      }
    }
  }
  return null;
}

export async function extractFrontmatterBlankLines(data: Uint8Array | JSZip): Promise<number | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_FRONTMATTER_BLANK_LINES') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n >= 0) return n;
      }
    }
  }
  return null;
}

export async function extractHtmlCommentAfterGapMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_HTML_COMMENT_AFTER_GAPS_');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const commentIdx = parseInt(key, 10);
      if (isNaN(commentIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < 0) continue;
      mapping.set(commentIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

export async function extractSentinelGapMapping(data: Uint8Array | JSZip): Promise<Record<string, number> | null> {
  const json = await extractChunkedCustomProp(data, 'MANUSCRIPT_SENTINEL_GAPS_');
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const result: Record<string, number> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'number' && Number.isInteger(val) && val >= 0) result[key] = val;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function extractFrontmatterFieldOrder(data: Uint8Array | JSZip): Promise<string[] | null> {
  const json = await extractChunkedCustomProp(data, 'MANUSCRIPT_FRONTMATTER_FIELD_ORDER_');
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    return arr.filter((s: unknown): s is string => typeof s === 'string');
  } catch {
    return null;
  }
}

export async function extractExplicitTableFontSize(data: Uint8Array | JSZip): Promise<boolean> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return false;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_EXPLICIT_TABLE_FONT_SIZE') continue;
    return true;
  }
  return false;
}

export async function extractTableBorders(data: Uint8Array | JSZip): Promise<'horizontal' | 'solid' | 'none' | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_TABLE_BORDERS') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) return null;
    for (const child of children) {
      if (child?.['vt:lpwstr'] !== undefined) {
        const val = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (val === 'horizontal' || val === 'solid' || val === 'none') return val;
        return null;
      }
    }
    return null;
  }
  return null;
}

/** Layer 2: read comma-separated bib key order from chunked MANUSCRIPT_BIB_KEY_ORDER_* custom props. */
export async function extractBibKeyOrder(data: Uint8Array | JSZip): Promise<string[] | null> {
  const csv = await extractChunkedCustomProp(data, 'MANUSCRIPT_BIB_KEY_ORDER_');
  if (!csv) return null;
  const keys = csv.split(',').map(k => k.trim()).filter(Boolean);
  return keys.length > 0 ? keys : null;
}

/** Layer 1: read full .bib text from chunked MANUSCRIPT_BIB_DATA_* custom props. */
export async function extractBibData(data: Uint8Array | JSZip): Promise<string | null> {
  const text = await extractChunkedCustomProp(data, 'MANUSCRIPT_BIB_DATA_');
  if (!text) return null;
  return text.trim().length > 0 ? text : null;
}

export async function extractBibliographyPath(data: Uint8Array | JSZip): Promise<string | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_BIBLIOGRAPHY_PATH') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr']));
        return raw.trim().length > 0 ? raw : null;
      }
    }
  }
  return null;
}

export async function extractPipeTableMaxLineWidth(data: Uint8Array | JSZip): Promise<number | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_PIPE_TABLE_MAX_LINE_WIDTH') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (!/^\d+$/.test(raw)) continue;
        return parseInt(raw, 10);
      }
    }
  }
  return null;
}

export async function extractGridTableMaxLineWidth(data: Uint8Array | JSZip): Promise<number | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_GRID_TABLE_MAX_LINE_WIDTH') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (!/^\d+$/.test(raw)) continue;
        return parseInt(raw, 10);
      }
    }
  }
  return null;
}

async function extractStringCustomProp(data: Uint8Array | JSZip, propName: string): Promise<string | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;
  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== propName) continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        return raw.length > 0 ? raw : null;
      }
    }
  }
  return null;
}

export async function extractLineSpacing(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_LINE_SPACING');
}

export async function extractParagraphIndent(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_PARAGRAPH_INDENT');
}

export async function extractBibliographyHangingIndent(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_BIBLIOGRAPHY_HANGING_INDENT');
}

/** The style export chose for frontmatter without one (see defaultCslProps) */
export async function extractDefaultCsl(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_DEFAULT_CSL');
}

/** The settings export stored as frontmatter text (see frontmatterSettingsProps) */
export async function extractFrontmatterSettings(data: Uint8Array | JSZip): Promise<Frontmatter | null> {
  const yaml = await extractChunkedCustomProp(data, 'MANUSCRIPT_FRONTMATTER_SETTINGS_');
  return yaml ? parseFrontmatter(yaml).metadata : null;
}

export async function extractCalloutLabels(data: Uint8Array | JSZip): Promise<boolean | null> {
  const raw = await extractStringCustomProp(data, 'MANUSCRIPT_CALLOUT_LABELS');
  if (raw === null) return null;
  const normalized = raw.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

export async function extractDefaultTableDigits(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_DEFAULT_TABLE_DIGITS');
}

export async function extractDefaultTableDecimalMark(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_DEFAULT_TABLE_DECIMAL_MARK');
}

export async function extractDefaultTableDigitGrouping(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_DEFAULT_TABLE_DIGIT_GROUPING');
}

export async function extractIndentOverrides(data: Uint8Array | JSZip): Promise<Map<number, string> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_INDENT_OVERRIDES');
  if (!mappingJson) return null;
  try {
    const obj = JSON.parse(mappingJson);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const map = new Map<number, string>();
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && (v === 'indent' || v === 'no-indent')) map.set(idx, v as string);
    }
    return map.size > 0 ? map : null;
  } catch { return null; }
}

export async function extractListIndentOverrides(data: Uint8Array | JSZip): Promise<Map<number, string> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_LIST_INDENT_OVERRIDES');
  if (!mappingJson) return null;
  try {
    const obj = JSON.parse(mappingJson);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const map = new Map<number, string>();
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && (v === 'indent' || v === 'no-indent')) map.set(idx, v as string);
    }
    return map.size > 0 ? map : null;
  } catch { return null; }
}

// Extract blockquote gap metadata from custom XML properties.
// Returns a Map<number, number> mapping group index → blank-line count between
// that group and the next.  Uses the same chunked-JSON pattern as code block
// language props, with key prefix MANUSCRIPT_BLOCKQUOTE_GAPS.
export async function extractBlockquoteGapMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_BLOCKQUOTE_GAPS');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const groupIdx = parseInt(key, 10);
      if (isNaN(groupIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < -1) continue;
      mapping.set(groupIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

// Extract HTML comment gap metadata from custom XML properties.
// Returns a Map<number, number> mapping HTML comment index → blank-line-before count.
export async function extractHtmlCommentGapMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_HTML_COMMENT_GAPS');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const commentIdx = parseInt(key, 10);
      if (isNaN(commentIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < 0) continue;
      mapping.set(commentIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

async function extractNotes(
  zip: JSZip,
  xmlPath: string,
  tagName: string,
  context?: NoteBodyContext,
): Promise<Map<string, FootnoteBody>> {
  const notes = new Map<string, FootnoteBody>();
  const parsed = await readZipXml(zip, xmlPath);
  if (!parsed) return notes;

  // The context's citations are this file's, in order (see convertDocx),
  // which one counter runs through across all its notes
  const citationCounter = { idx: 0 };

  for (const node of findAllDeep(parsed, tagName)) {
    const id = getAttr(node, 'id');
    if (!id || id === '-1' || id === '0') continue;

    // Skip separator and continuationSeparator types
    const noteType = getAttr(node, 'type');
    if (noteType === 'separator' || noteType === 'continuationSeparator') continue;

    const noteChildren = node[tagName];
    if (!Array.isArray(noteChildren)) continue;

    const noteContext = context?.referenced && !context.referenced.has(id) ? { ...context, images: undefined } : context;
    const content = parseNoteBody(noteChildren, tagName, noteContext, citationCounter);
    notes.set(id, { id, content });
  }
  return notes;
}

/**
 * Parse footnote/endnote body content from OOXML.
 *
 * When `context` is provided, handles hyperlinks, math, field codes (Zotero
 * citations), and tables using the same logic as the main document `walk()`.
 * Without context, only basic text formatting is parsed.
 */
/**
 * Reads a hidden (w:vanish) run into `target`, and returns the children the
 * walk still reads: all of a run that shows, and of a hidden one only its
 * field characters and code, since a field's code can be hidden while its
 * result shows. Export hides an HTML comment in such a run, its text
 * starting with \u200B, and Word may split it into many on save (the first
 * "<!--", the rest lines, breaks and "-->"), which join the html_comment
 * before them until it closes, or join it with others (see readHiddenText).
 * Other hidden text, such as legacy metadata or the pieces of a split
 * \u200B-prefixed sentinel, stays hidden.
 */
function readHiddenRun(runChildren: XmlNode[], rPrChildren: XmlNode[] | undefined, target: ContentItem[], activeComments: Set<string>, revision?: RevisionInfo): XmlNode[] {
  if (!rPrChildren || !isToggleOn(rPrChildren, 'w:vanish')) return runChildren;
  const fieldChildren = runChildren.filter((c) => c['w:fldChar'] !== undefined || c['w:instrText'] !== undefined);
  if (fieldChildren.length > 0) return fieldChildren;
  // Text from w:t/w:delText, with breaks, so multiline payloads survive
  let runText = '';
  for (const child of runChildren) {
    if (child['w:t'] !== undefined) {
      runText += nodeText(asXmlNodes(child['w:t']));
    } else if (child['w:delText'] !== undefined) {
      runText += nodeText(asXmlNodes(child['w:delText']));
    } else if (child['w:br'] !== undefined || child['w:cr'] !== undefined) {
      runText += '\n';
    }
  }
  readHiddenText(runText, target, activeComments, revision);
  return [];
}

/** A hidden comment as inline Markdown reads one: one with no end, which
 *  ran to the end of an HTML table's cell, with one, but not one before
 *  another (`beforeComment`), which Word split it from at an <!-- in it,
 *  and which ends it; and one the browser ended at a --!>, ended at a -->
 *  instead, as inline Markdown reads it on. In a table's cell (`cell`), as
 *  joinSplitComments joins one Word split, one the browser ended at a -->
 *  after a -, which inline Markdown reads as text, ends at one it reads, as
 *  does one that ends at a --!> before another, and one before another gets
 *  an end. */
function markdownComment(text: string, beforeComment = false, cell = false): string {
  const from = text.indexOf('<!--') + 4;
  if (/^-?>/.test(text.slice(from)) || cell && HTML_TAG_RE.exec(text.trimStart())?.[0] === text.trimStart()) return text;
  const end = /--!?>$/.exec(text);
  if (cell && end && end.index >= from) {
    const body = text.slice(from, end.index);
    return text.slice(0, from) + body + (body.endsWith('-') ? ' ' : '') + '-->';
  }
  if (text.includes('-->', from) || beforeComment && !cell) return text;
  return end?.[0] === '--!>' && end.index >= from ? text.slice(0, -4) + '-->' : text.trimEnd() + ' -->';
}

/** The items of a table's cell with each comment that has no end joined
 *  with the comments after it, which Word split it from at an <!-- in it,
 *  up to the one an end is in, as one comment, where they're in the same
 *  comments' ranges: its end as the browser reads it, a --!> too, in an
 *  HTML table's cell (`browser`), or else as inline Markdown does, as
 *  readHiddenText does. No range ends at an HTML comment (see
 *  collectCommentSpans), so none loses its end. A ZWSP after the end the
 *  browser read, which Word split from the comment after whose start it is,
 *  goes with it. */
function joinSplitComments(items: ContentItem[], browser: boolean): ContentItem[] {
  const ended = browser ? (text: string) => /^\s*<!--(?:-?>|[\s\S]*?--!?>)/.test(text)
    : (text: string) => text.includes('-->', text.lastIndexOf('<!--') + 4) || /^\s*<!---?>\s*$/.test(text);
  const end = browser ? /--!?>/ : /-->/;
  const out: ContentItem[] = [];
  let joined = false;
  // The texts of the comment at the end of `out` while it has no end, their
  // last three characters, which can start one, and its comments' IDs
  let open: { texts: string[]; tail: string; commentIds: Set<string> } | undefined;
  const close = () => {
    if (open && open.texts.length > 1) {
      out[out.length - 1] = { ...out[out.length - 1] as Extract<ContentItem, { type: 'html_comment' }>, text: open.texts.join('') };
      joined = true;
    }
    open = undefined;
  };
  for (const item of items) {
    const last = out[out.length - 1];
    if (browser && !open && last?.type === 'html_comment' && item.type === 'html_comment' && item.text.startsWith('<!--')
        && /^\s*<!--(?:-?>|(?:(?!--!?>)[\s\S])*--!?>)\u200B+$/.test(last.text)) {
      out[out.length - 1] = { ...last, text: last.text.replace(/\u200B+$/, '') };
      joined = true;
    }
    if (open && item.type === 'html_comment' && commentSetsEqual(item.commentIds, open.commentIds)) {
      open.texts.push(item.text);
      if (end.test(open.tail + item.text)) close();
      else open.tail = (open.tail + item.text).slice(-3);
      continue;
    }
    close();
    out.push(item);
    if (item.type === 'html_comment' && !ended(item.text)) {
      open = { texts: [item.text], tail: item.text.slice(-3), commentIds: item.commentIds };
    }
  }
  close();
  return joined ? out : items;
}

/**
 * The HTML comments and images export hid in a run's text, each after a
 * ZWSP: a comment up to its end, and an image export couldn't embed, as its
 * Markdown, up to a closing ZWSP, which the image keeps once it has it. Word
 * can split one between runs, or join several in one.
 */
function readHiddenText(runText: string, target: ContentItem[], activeComments: Set<string>, revision?: RevisionInfo): void {
  // The start of one Word split off before it showed which it is
  const pending = pendingHiddenText.get(target);
  pendingHiddenText.delete(target);
  if (pending && pending.at === target.length) runText = pending.text + runText;
  /** Where the hidden text after the comment whose <!-- ends at `from`
   *  starts, if anything does: after its first end, if a ZWSP follows it,
   *  its first -->, or the > or -> of an empty one, <!--> or <!--->. Not a
   *  --!>, which ends a comment in an HTML table's cell, as the browser
   *  reads it, but not one inline Markdown reads to its --> (see
   *  renderHtmlCellParagraph) */
  const afterComment = (text: string, from: number) => {
    const empty = /^-?>/.exec(text.slice(from));
    const close = text.indexOf('-->', from);
    const end = empty ? from + empty[0].length : close === -1 ? -1 : close + 3;
    return end !== -1 && text[end] === '\u200B' ? end : -1;
  };
  let rest = runText;
  const lastItem = target[target.length - 1];
  const continues = lastItem !== undefined && 'commentIds' in lastItem && !!lastItem.commentIds
    && commentSetsEqual(lastItem.commentIds, activeComments);
  /** Whether a comment's text has its end: a --> after its last <!--, or
   *  the > or -> of an empty one that is all of it, <!--> or <!--->, but not
   *  one in it, which may be in a comment Word split before it. Not a --!>,
   *  which ends a comment in an HTML table's cell, as the browser reads it,
   *  but not one inline Markdown reads to its --> (see
   *  renderHtmlCellParagraph) */
  const closed = (text: string) => text.includes('-->', text.lastIndexOf('<!--') + 4) || /^\s*<!---?>\s*$/.test(text);
  // But for a ZWSP and the start of a payload alone, which the next hidden
  // run shows the comment's or the next payload's (see pendingHiddenText).
  // In a Word comment's range or out of it too, where Word started or
  // ended the range in the comment, which is then in the range all of it,
  // as Markdown can't start or end one in a comment. With a <!-- that starts
  // the rest, as of <!-- x<!-- a -->, which Word split before the second,
  // whose comment goes on to the first -->, as export starts each payload
  // with a ZWSP, which the rest of one doesn't have, though Word may move
  // it to the end of the run before. Across a range's edge, only the rest
  // of the run, with no ZWSP, as the next payload there, a comment or an
  // image's ![...] or <img>, is one of its own, which the range is on.
  const newPayload = rest.startsWith('\u200B') || lastItem?.type === 'html_comment' && lastItem.text.endsWith('\u200B');
  if (lastItem?.type === 'html_comment'
      && (continues ? !(/^\u200B*\s*<!--/.test(rest) && newPayload) : !newPayload)
      && !/^\u200B+(?:!|<|<!|<!-|<i|<im)?$/i.test(rest) && !closed(lastItem.text)) {
    for (const id of activeComments) lastItem.commentIds.add(id);
    // With a ZWSP it starts with, which is the comment's own, before which
    // Word split its run
    lastItem.text += rest;
    const end = afterComment(lastItem.text, lastItem.text.lastIndexOf('<!--') + 4);
    rest = end === -1 ? '' : lastItem.text.slice(end);
    if (end !== -1) lastItem.text = lastItem.text.slice(0, end);
  } else if (continues && lastItem.type === 'image' && lastItem.markdown !== undefined && !lastItem.markdown.endsWith('\u200B')) {
    const end = rest.indexOf('\u200B');
    lastItem.markdown += end === -1 ? rest : rest.slice(0, end + 1);
    rest = end === -1 ? '' : rest.slice(end + 1);
  }
  while (rest) {
    const payload = rest.replace(/^\u200B+/, '');
    if (payload.trimStart().startsWith('<!--')) {
      const end = afterComment(payload, payload.indexOf('<!--') + 4);
      target.push({ type: 'html_comment', text: end === -1 ? payload : payload.slice(0, end), commentIds: new Set(activeComments) });
      rest = end === -1 ? '' : payload.slice(end);
    } else if (rest.startsWith('\u200B') && /^(?:!\[|<img\b)/i.test(rest.slice(1))) {
      const end = rest.indexOf('\u200B', 1);
      target.push({
        type: 'image', rId: '', src: '', alt: '', widthPx: 0, heightPx: 0, commentIds: new Set(activeComments),
        markdown: end === -1 ? rest.slice(1) : rest.slice(1, end + 1), ...(revision ? { revision } : {}),
      });
      rest = end === -1 ? '' : rest.slice(end + 1);
    } else {
      // A ZWSP and the start of <!--, ![ or <img, for the next hidden run
      if (rest.startsWith('\u200B') && /^(?:!|<|<!|<!-|<i|<im)?$/i.test(payload)) {
        pendingHiddenText.set(target, { text: rest, at: target.length });
      }
      break;
    }
  }
}

/** The start of hidden text whose run Word split before it showed what it
 *  is, as a ZWSP and !, which the next hidden run in the same place goes on */
const pendingHiddenText = new WeakMap<ContentItem[], { text: string; at: number }>();

/** The Markdown of an image export couldn't embed, without its closing ZWSP */
/** An image's Markdown: its own, as an embed wrote it, an <img> tag where
 *  it came from one, or else ![alt](src) with its size, as export reads it
 *  there (see syntaxText) */
function imageMarkdown(item: ContentItem & { type: 'image' }, imageFormatMapping?: Map<string, string>): string {
  if (item.markdown !== undefined) return syntaxText(unembeddedImageMarkdown(item.markdown));
  if (imageFormatMapping?.get(item.rId) === 'html') {
    return syntaxText('<img src="' + escapeHtmlAttr(item.src) + '" alt="' + escapeHtmlAttr(item.alt) + '"'
      + (item.widthPx > 0 ? ' width="' + item.widthPx + '"' : '')
      + (item.heightPx > 0 ? ' height="' + item.heightPx + '"' : '') + '>');
  }
  const safeAlt = item.alt.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
  const size = [...(item.widthPx > 0 ? ['width=' + item.widthPx] : []), ...(item.heightPx > 0 ? ['height=' + item.heightPx] : [])];
  return syntaxText('![' + safeAlt + '](' + formatHrefForMarkdown(item.src) + ')' + (size.length ? '{' + size.join(' ') + '}' : ''));
}

function unembeddedImageMarkdown(markdown: string): string {
  return markdown.endsWith('\u200B') ? markdown.slice(0, -1) : markdown;
}

const FIELD_RUN_KEYS = new Set([':@', 'w:rPr', 'w:fldChar', 'w:instrText', 'w:delInstrText', 'w:lastRenderedPageBreak']);

/**
 * Tracks whether a field shows, since readHiddenRun gives the walk the
 * field characters and code of a hidden run: a field hidden from its begin
 * shows only if a run in it shows something, and otherwise adds nothing.
 */
function fieldVisibility() {
  let runHidden = false;
  let fieldHidden = false;
  let fieldShown = false;
  return {
    /** Before the walk reads a run, with the children readHiddenRun gave it */
    run(runChildren: XmlNode[], walked: XmlNode[]) {
      runHidden = walked !== runChildren;
      if (!runHidden && runChildren.some((c) => Object.keys(c).some((k) => !FIELD_RUN_KEYS.has(k)))) fieldShown = true;
    },
    begin() {
      fieldHidden = runHidden;
      fieldShown = false;
    },
    shows: () => !fieldHidden || fieldShown,
  };
}

function parseNoteBody(
  noteChildren: XmlNode[],
  tagName: string,
  context?: NoteBodyContext,
  citationCounter?: { idx: number },
): ContentItem[] {
  const content: ContentItem[] = [];
  // Determine self-ref tag: w:footnoteRef or w:endnoteRef
  const selfRefTag = tagName === 'w:footnote' ? 'w:footnoteRef' : 'w:endnoteRef';
  let skippedSelfRef = false;
  // Where the text after the note's mark starts, where the mark starts the
  // note's text, as Word puts it, with a space or tab after it
  let afterMark: number | undefined;
  const passMark = (target: ContentItem[]) => {
    skippedSelfRef = true;
    if (target === content && content.every(item => item.type === 'text' && item.text === '')) afterMark = content.length;
  };

  // Field-tracking state (only used when context is provided)
  let inField = false;
  let inCitationField = false;
  let fieldInstrParts: string[] = [];
  let currentCitation: ZoteroCitation | undefined;
  let citationTextParts: string[] = [];
  let fieldFormatting: RunFormatting | undefined;
  // As in extractDocumentContent: the comments whose ranges end in a
  // citation's result, which end with the field
  const resultEnds: string[] = [];
  const fieldShows = fieldVisibility();
  const cCounter = citationCounter ?? { idx: 0 };
  let currentHref: string | undefined;
  // Each w:hyperlink's number, which its text keeps
  let currentLink = 0;
  let linkCount = 0;
  // As in extractDocumentContent: a tracked paragraph mark, for breakRevision
  let trackedParaMark: { revision: RevisionInfo; target: ContentItem[]; end: number } | undefined;
  // As in extractDocumentContent: the comments whose ranges are open, but
  // not replies or those without a body
  const activeComments = new Set<string>();
  const commentStartTargetIndex = new Map<string, { target: ContentItem[]; index: number }>();
  const hasRange = (id: string) => !context?.replyIds?.has(id) && (!context?.commentBodies || context.commentBodies.has(id));

  function endComment(id: string, target: ContentItem[]): void {
    const startInfo = commentStartTargetIndex.get(id);
    if (startInfo?.target === target && !rangeHolds(target, startInfo.index, id)) {
      // Zero-width comment range: emit a synthetic empty text item,
      // without formatting, which would write code's `` as text
      target.push({ type: 'text', text: '', formatting: DEFAULT_FORMATTING, commentIds: new Set(activeComments), href: undefined });
    }
    commentStartTargetIndex.delete(id);
    activeComments.delete(id);
  }

  function walkNoteBody(
    nodes: XmlNode[],
    currentFormatting: RunFormatting = DEFAULT_FORMATTING,
    target: ContentItem[] = content,
    inTableCell = false,
    currentRevision?: RevisionInfo
  ): void {
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key === ':@') continue;

        if (key === selfRefTag && !skippedSelfRef) {
          passMark(target);
          continue;
        } else if (key === 'w:commentRangeStart') {
          const id = getAttr(node, 'id');
          if (hasRange(id)) {
            activeComments.add(id);
            commentStartTargetIndex.set(id, { target, index: target.length });
          }
        } else if (key === 'w:commentRangeEnd') {
          const id = getAttr(node, 'id');
          if (hasRange(id)) {
            if (inCitationField && currentCitation) resultEnds.push(id);
            else endComment(id, target);
          }
        } else if (key in REVISION_ELEMENTS) {
          const author = getAttr(node, 'author');
          const date = getAttr(node, 'date');
          const rev = { type: REVISION_ELEMENTS[key], author, date };
          if (Array.isArray(node[key])) walkNoteBody(node[key], currentFormatting, target, inTableCell, rev);
        } else if (key === 'w:fldChar' && context) {
          const fldType = getAttr(node, 'fldCharType');
          if (fldType === 'begin') {
            for (const id of resultEnds.splice(0)) endComment(id, target);
            inField = true;
            fieldShows.begin();
            fieldInstrParts = [];
            fieldFormatting = undefined;
            inCitationField = false;
          } else if (fldType === 'separate') {
            if (inField) {
              const instrText = fieldInstrParts.join('');
              if (instrText.includes('ZOTERO_ITEM')) {
                inCitationField = true;
                currentCitation = context.zoteroCitations[cCounter.idx++];
                citationTextParts = [];
              }
            }
          } else if (fldType === 'end') {
            if (inCitationField && currentCitation && fieldShows.shows()) {
              const pandocKeys = citationPandocKeys(currentCitation, context.keyMap);
              target.push({
                type: 'citation',
                text: citationTextParts.join(''),
                commentIds: new Set(activeComments),
                pandocKeys,
                ...(currentRevision ? { revision: currentRevision } : {}),
                ...highlightOnly(fieldFormatting),
              });
            }
            for (const id of resultEnds.splice(0)) endComment(id, target);
            inField = false;
            inCitationField = false;
            currentCitation = undefined;
          }
        } else if (key === 'w:instrText' && inField && context) {
          fieldInstrParts.push(nodeText(asXmlNodes(node['w:instrText'])));

        // --- Hyperlinks ---
        } else if (key === 'w:hyperlink' && context) {
          const rId = node?.[':@']?.['@_r:id'] ?? getAttr(node, 'id');
          const prevHref = currentHref;
          const prevLink = currentLink;
          currentHref = context.relationshipMap.get(rId);
          currentLink = ++linkCount;
          if (Array.isArray(node[key])) { walkNoteBody(node[key], currentFormatting, target, inTableCell, currentRevision); }
          currentHref = prevHref;
          currentLink = prevLink;

        // --- Tables ---
        } else if (key === 'w:tbl' && context && !inTableCell) {
          const markBefore = trackedParaMark;
          const tblChildren = asXmlNodes(node[key]);
          const rawRows: Array<{ isHeader: boolean; cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue'; align?: TableAlign }> }> = [];
          const firstRowHeaderByLook = tableHasFirstRowHeader(tblChildren);
          // Where each cell is, for its table style's parts
          const look = tableLook(tblChildren);
          const rowCount = tblChildren.filter((c) => c['w:tr'] !== undefined).length;
          const columnCount = tableColumnCount(tblChildren);
          for (const tr of tblChildren.filter((c) => c['w:tr'] !== undefined)) {
            const trChildren = asXmlNodes(tr['w:tr']);
            const cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue'; align?: TableAlign }> = [];
            for (const tc of trChildren.filter((c) => c['w:tc'] !== undefined)) {
              const tcChildren = asXmlNodes(tc['w:tc']);
              let colspan = 1;
              let vMergeType: 'restart' | 'continue' | undefined;
              const tcPrNode = tcChildren.find((c) => c['w:tcPr'] !== undefined);
              if (tcPrNode) {
                const tcPrChildren = asXmlNodes(tcPrNode['w:tcPr']);
                const gridSpanNode = tcPrChildren.find((c) => c['w:gridSpan'] !== undefined);
                if (gridSpanNode) {
                  const val = parseInt(getAttr(gridSpanNode, 'val'), 10);
                  if (val > 1) colspan = val;
                }
                const vMergeNode = tcPrChildren.find((c) => c['w:vMerge'] !== undefined);
                if (vMergeNode) {
                  const val = getAttr(vMergeNode, 'val');
                  vMergeType = val === 'restart' ? 'restart' : 'continue';
                }
              }
              const cellItems: ContentItem[] = [];
              walkNoteBody(tcChildren, currentFormatting, cellItems, true, currentRevision);
              cells.push({ paragraphs: splitCellParagraphs(cellItems), colspan, vMergeType, align: cellAlignment(tcChildren, context.styleLayouts, tableStyleId(tblChildren, context.styleLayouts),
                { row: rawRows.length, rows: rowCount, col: cells.reduce((n, cell) => n + cell.colspan, 0), span: colspan, cols: columnCount, look }) });
            }
            rawRows.push({ isHeader: rowHasHeaderProp(trChildren), cells });
          }
          if (firstRowHeaderByLook && rawRows.length > 0) {
            rawRows[0].isHeader = true;
          }
          const rows = computeRowspans(rawRows);
          if (rows.length > 0) {
            // As in extractDocumentContent: a tracked mark before the table
            if (markBefore?.target === target && markBefore.end === target.length) target.push({ type: 'para', breakRevision: markBefore.revision });
            target.push({ type: 'table', rows });
          } else {
            trackedParaMark = markBefore;
          }

        // --- Math ---
        } else if (key === 'm:oMathPara' && context) {
          const mathParaChildren = asXmlNodes(node[key]);
          const oMathNodes = mathParaChildren.filter((c) => c['m:oMath'] !== undefined);
          for (const oMathNode of oMathNodes) {
            try {
              const latex = ommlToLatex(asXmlNodes(oMathNode['m:oMath']));
              if (latex) {
                target.push({ type: 'math', latex, display: true, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
              }
            } catch {
              target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: true, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
            }
          }
        } else if (key === 'm:oMath' && context) {
          const mathChildren = asXmlNodes(node[key]);
          try {
            const latex = ommlToLatex(mathChildren);
            if (latex) {
              target.push({ type: 'math', latex, display: false, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
            }
          } catch {
            target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: false, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
          }
        } else if (key === 'w:drawing' && context?.images) {
          // As in extractDocumentContent, from the notes' relationships
          const { relationships, folder, files } = context.images;
          target.push(...drawingImages(asXmlNodes(node[key]), relationships, folder, files,
            { commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) }));

        // --- Basic text elements (always handled) ---
        } else if (key === 'w:t' || key === 'w:delText') {
          const text = nodeText(asXmlNodes(node[key]));
          if (text) {
            if (inCitationField && context) {
              fieldFormatting ??= currentFormatting;
              citationTextParts.push(text);
            } else {
              const textItem: ContentItem = {
                type: 'text',
                text,
                commentIds: new Set(activeComments),
                formatting: currentFormatting,
                ...(currentRevision ? { revision: currentRevision } : {}),
              };
              if (currentHref) {
                textItem.href = currentHref;
                textItem.link = currentLink;
              }
              target.push(textItem);
            }
          }
        } else if (key === 'w:br') {
          const brType = getAttr(node, 'type');
          if (!brType || brType === 'textWrapping') {
            target.push({
              type: 'text',
              text: '\\\n',
              commentIds: new Set(activeComments),
              formatting: currentFormatting,
              ...(currentRevision ? { revision: currentRevision } : {}),
              ...(currentHref ? { href: currentHref, link: currentLink } : {}),
            });
          }
        } else if (key === 'w:p') {
          const precedingMark = trackedParaMark;
          trackedParaMark = undefined;
          const paraChildren = asXmlNodes(node[key]);
          let paraFormatting = currentFormatting;
          let paraMarkRevision: RevisionInfo | undefined;
          let isCodeBlock = false;
          for (const child of paraChildren) {
            if (child['w:pPr']) {
              const pPrChildren = asXmlNodes(child['w:pPr']);
              isCodeBlock = !inTableCell && parseCodeBlockStyle(pPrChildren);
              const pRPrElement = pPrChildren.find((c) => c['w:rPr'] !== undefined);
              if (pRPrElement) {
                const pRPrChildren = asXmlNodes(pRPrElement['w:rPr']);
                paraFormatting = parseRunProperties(pRPrChildren, currentFormatting);
                const revNode = pRPrChildren.find(c => Object.keys(c).some(k => k in REVISION_ELEMENTS));
                const revKey = revNode && Object.keys(revNode).find(k => k in REVISION_ELEMENTS);
                if (revNode && revKey) {
                  paraMarkRevision = { type: REVISION_ELEMENTS[revKey], author: getAttr(revNode, 'author'), date: getAttr(revNode, 'date') };
                }
              }
              break;
            }
          }
          // Push para separator for multi-paragraph notes (skip first). Each
          // line of a code block has one, as in the document, an empty one
          // too, and so does the paragraph after one.
          const last = target[target.length - 1];
          const needsPara = inTableCell || isCodeBlock
            || (last !== undefined && (last.type !== 'para' || !!last.isCodeBlock));
          // The tracked mark of the paragraph before, which this one's text
          // joins to it
          const trackedBreak = !inTableCell && precedingMark?.target === target && precedingMark.end === target.length;
          if (needsPara) {
            const paraItem: ContentItem = { type: 'para' };
            if (trackedBreak) paraItem.breakRevision = precedingMark.revision;
            if (isCodeBlock) paraItem.isCodeBlock = true;
            target.push(paraItem);
          }
          const lenBeforeContent = target.length;
          const markBefore = skippedSelfRef;
          walkNoteBody(paraChildren, paraFormatting, target, inTableCell, currentRevision);
          // Whether the paragraph held anything, after which comments that
          // start at its mark go (see startRangesAtMark), though it held only
          // the space or tab after the note's mark, which goes below
          const walkedContent = target.length > lenBeforeContent;
          // Word's space or tab after the note's mark, which export writes
          // before text that starts with whitespace, goes, but no other
          // whitespace the note's text starts with: not a paragraph's after
          // the mark's, where that left nothing, nor any where there's no
          // mark. One a change, a comment's range or formatting is written
          // around stays, as text's, but not where a Word user made the
          // mark's paragraph code, nor in the range of a comment that goes
          // on over the text after it, as one on the whole note does, which
          // then starts at that text, nor after a comment on the mark alone,
          // which then comes before it.
          if (isCodeBlock && !markBefore && skippedSelfRef) {
            const first = target.slice(lenBeforeContent).find(walked => walked.type !== 'text' || walked.text !== '');
            if (first?.type === 'text') first.text = first.text.replace(/^[ \t]/, '');
          } else if (!isCodeBlock && !markBefore && afterMark !== undefined) {
            let at = afterMark;
            const empty = (item: ContentItem | undefined) => item?.type === 'text' && item.text === '' && !item.revision;
            while (empty(target[at])) at++;
            const first = target[at];
            const next = first?.type === 'text' && first.text.length === 1 ? target[at + 1] : first;
            const goesOn = (item: Extract<ContentItem, { type: 'text' }>) => [...item.commentIds]
              .every(id => next !== undefined && 'commentIds' in next && !!next.commentIds?.has(id));
            if (first?.type === 'text' && /^[ \t]/.test(first.text) && isPlainText({ ...first, commentIds: new Set() }) && goesOn(first)) {
              // Empty, it holds the place of a tracked mark (see trackedParaMark)
              if (first.text.length === 1 && !paraMarkRevision) target.splice(at, 1);
              else target[at] = { ...first, text: first.text.slice(1) };
            }
          }
          if (!inTableCell && !isCodeBlock && walkedContent) {
            startRangesAtMark(target, lenBeforeContent, commentStartTargetIndex, activeComments);
          }
          // As in the document's body (see dropBlankParagraphText)
          if (!inTableCell && !isCodeBlock && !paraMarkRevision && !trackedBreak) dropBlankParagraphText(target, lenBeforeContent);
          // Display math in the paragraph goes on in it (see the document's)
          if (!inTableCell) {
            for (let k = lenBeforeContent; k < target.length; k++) {
              const walked = target[k];
              if (walked.type === 'math' && walked.display) walked.inParagraph = true;
            }
          }
          if (paraMarkRevision && !inTableCell && target.length > lenBeforeContent) {
            trackedParaMark = { revision: paraMarkRevision, target, end: target.length };
          }
        } else if (key === 'w:r') {
          let runFormatting = currentFormatting;
          const runChildren = withCharactersAsText(asXmlNodes(node[key]));
          let rPrChildren: XmlNode[] | undefined;
          for (const child of runChildren) {
            if (child['w:rPr']) {
              rPrChildren = asXmlNodes(child['w:rPr']);
              runFormatting = parseRunProperties(rPrChildren, currentFormatting);
              break;
            }
          }
          const walked = readHiddenRun(runChildren, rPrChildren, target, activeComments, currentRevision);
          // A hidden mark is still the note's, which Word's space or tab
          // after it follows
          if (walked !== runChildren && !skippedSelfRef && runChildren.some(child => child[selfRefTag] !== undefined)) passMark(target);
          fieldShows.run(runChildren, walked);
          walkNoteBody(walked, runFormatting, target, inTableCell, currentRevision);
        } else if (Array.isArray(node[key])) {
          walkNoteBody(node[key], currentFormatting, target, inTableCell, currentRevision);
        }
      }
    }
  }

  walkNoteBody(noteChildren);
  for (const id of resultEnds.splice(0)) endComment(id, content);
  // As in extractDocumentContent: the last paragraph's tracked mark
  if (trackedParaMark?.target === content && trackedParaMark.end === content.length) {
    content.push({ type: 'para', breakRevision: trackedParaMark.revision });
  }
  return content;
}

/** The note references in `items`, in table cells too, in order, after `refs` */
function noteReferences(
  items: ContentItem[], refs: { noteId: string; noteKind: 'footnote' | 'endnote' }[] = [],
): { noteId: string; noteKind: 'footnote' | 'endnote' }[] {
  for (const item of items) {
    if (item.type === 'footnote_ref') {
      refs.push({ noteId: item.noteId, noteKind: item.noteKind });
    } else if (item.type === 'table') {
      for (const row of item.rows) {
        for (const cell of row.cells) {
          for (const para of cell.paragraphs) noteReferences(para, refs);
        }
      }
    }
  }
  return refs;
}

/** The notes' image format mapping for the notes of `part`, by relationship
 *  ID, which is that part's own: its keys, part:rId, and those without a
 *  part, as export wrote before it gave them one */
function noteImageFormats(mapping: Map<string, string>, part: 'footnotes' | 'endnotes'): Map<string, string> {
  const formats = new Map<string, string>();
  for (const [key, syntax] of mapping) {
    const colon = key.indexOf(':');
    if (colon < 0) {
      if (!formats.has(key)) formats.set(key, syntax);
    } else if (key.slice(0, colon) === part) {
      formats.set(key.slice(colon + 1), syntax);
    }
  }
  return formats;
}

async function extractFootnotes(zip: JSZip, context?: NoteBodyContext): Promise<Map<string, FootnoteBody>> {
  return extractNotes(zip, 'word/footnotes.xml', 'w:footnote', context);
}

async function extractEndnotes(zip: JSZip, context?: NoteBodyContext): Promise<Map<string, FootnoteBody>> {
  return extractNotes(zip, 'word/endnotes.xml', 'w:endnote', context);
}

/** Strip the Zotero styles URL prefix and map canonical IDs to public aliases. */
export function zoteroStyleShortName(styleId: string): string {
  return publicStyleNameForZoteroId(styleId);
}

/** Build the canonical Zotero style URL from a public style name. */
export function zoteroStyleFullId(shortName: string): string {
  return zoteroStyleIdForName(shortName);
}

// Zotero metadata extraction

/** Extract Zotero citations from an already-parsed XML tree. */
function extractZoteroCitationsFromParsed(parsed: XmlNode[]): ZoteroCitation[] {
  return extractZoteroCitationsFromInstructions(extractFieldInstructions(parsed));
}

function extractZoteroCitationsFromInstructions(instructions: string[]): ZoteroCitation[] {
  const citations: ZoteroCitation[] = [];
  for (const instrText of instructions) {
    if (!instrText.includes('ZOTERO_ITEM')) { continue; }

    const jsonStart = instrText.indexOf('{');
    if (jsonStart < 0) {
      citations.push({ plainCitation: '', items: [] });
      continue;
    }

    try {
      const parsedData: unknown = JSON.parse(instrText.slice(jsonStart));
      if (!isRecord(parsedData)) throw new Error('Invalid Zotero citation payload');
      const properties = isRecord(parsedData.properties) ? parsedData.properties : {};
      const plainCitation = stringField(properties, 'plainCitation');
      const cslItems = Array.isArray(parsedData.citationItems)
        ? parsedData.citationItems.filter(isRecord)
        : [];

      const items: CitationMetadata[] = cslItems.map(item => {
        const d = isRecord(item.itemData) ? item.itemData : {};
        const issued = isRecord(d.issued) ? d.issued : {};
        const dateParts = Array.isArray(issued['date-parts']) ? issued['date-parts'] : [];
        const firstDatePart = Array.isArray(dateParts[0]) ? dateParts[0][0] : undefined;
        const year = firstDatePart ? String(firstDatePart) : '';

        const result: CitationMetadata = {
          authors: parseCslAuthors(d.author),
          title: stringField(d, 'title'),
          year,
          journal: stringField(d, 'container-title'),
          volume: stringField(d, 'volume'),
          pages: stringField(d, 'page'),
          doi: stringField(d, 'DOI'),
          type: stringField(d, 'type') || 'article-journal',
          fullItemData: d,
        };

        // Extract citation-key (CSL standard field) for round-trip preservation
        if (d['citation-key'] != null) {
          const ck = String(d['citation-key']).trim();
          if (ck) {
            result.citationKey = ck;
          }
        }

        // The item's ID, which Zotero finds it by where the field has no URI
        const itemId = item.id ?? d.id;
        if (typeof itemId === 'string' || typeof itemId === 'number') {
          result.itemId = String(itemId);
        }

        // Extract Zotero URI and key, and the item's other URIs
        const uris = item.uris ?? item.uri ?? [];
        const uriValues = (Array.isArray(uris) ? uris : [uris]).filter(value => value != null).map(String).filter(Boolean);
        const uri = uriValues[0];
        if (uri) {
          result.zoteroUri = uri;
          result.zoteroUris = uriValues;
          const zKey = extractZoteroKey(uri);
          if (zKey) {
            result.zoteroKey = zKey;
          }
        }

        // Extract locator (coerce to string for numeric locators)
        if (item.locator != null) {
          const loc = String(item.locator).trim();
          if (loc) {
            result.locator = loc;
          }
        }

        // Extract suppress-author flag (Pandoc [-@key] form)
        if (item['suppress-author']) {
          result.suppressAuthor = true;
        }

        // Extract prefix (Pandoc [e.g., @key] form)
        const prefix = stringField(item, 'prefix').trim();
        if (prefix) {
          result.prefix = prefix;
        }

        return result;
      });

      citations.push({ plainCitation, items });
    } catch {
      // Push a placeholder so positional indices stay aligned with ZOTERO_ITEM occurrences
      citations.push({ plainCitation: '', items: [] });
    }
  }
  return citations;
}

/** The Zotero citations of a part, the document's body unless `path` names
 *  another, as its footnotes. */
export async function extractZoteroCitations(data: Uint8Array | JSZip, path = 'word/document.xml'): Promise<ZoteroCitation[]> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, path);
  if (!parsed) { return []; }
  return extractZoteroCitationsFromParsed(parsed);
}

// Citation key generation

export function generateCitationKey(
  surname: string, year: string, title: string, format: CitationKeyFormat = 'authorYearTitle'
): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const cleanSurname = clean(surname);
  const cleanYear = year.replace(/[^0-9]/g, '');
  if (format === 'authorYear') { return `${cleanSurname}${cleanYear}`; }
  if (format === 'numeric') { return ''; }
  const words = title.toLowerCase().match(/\b[a-zA-Z]+\b/g) ?? [];
  const firstWord = words.find(w => !['the', 'a', 'an'].includes(w)) ?? 'unknown';
  return `${cleanSurname}${cleanYear}${firstWord}`;
}

/** Build a map from the identifier of each field's item (see itemIdentifier)
 *  to its item's citation key, one for each item (see citedItems). */
export function buildCitationKeyMap(
  allCitations: ZoteroCitation[],
  format: CitationKeyFormat = 'authorYearTitle',
): Map<string, string> {
  const keyMap = new Map<string, string>(); // itemId -> citationKey
  const seen = new Set<string>();
  let numericCounter = 1;

  for (const { meta, ids, citationKey } of citedItems(allCitations)) {
    let key: string;
    if (format === 'numeric') {
      key = String(numericCounter++);
    } else if (citationKey && !seen.has(citationKey)) {
      // Prefer stored citation-key from round-trip or Zotero
      key = citationKey;
    } else {
      const surname = getSurname(meta);
      const baseKey = generateCitationKey(surname, meta.year, meta.title, format);
      key = baseKey;
      let counter = 2;
      while (seen.has(key)) { key = `${baseKey}${counter++}`; }
    }
    seen.add(key);
    for (const id of ids) keyMap.set(id, key);
  }
  return keyMap;
}

/** The items the citations cite, each once, in the order they first come.
 *  Fields whose URIs overlap cite one item, as Zotero lists an item's
 *  earlier URIs, from before a sync or a merge, after its own, and so,
 *  without a URI, do fields whose identifiers match (see itemIdentifier).
 *  Each comes with its fields' identifiers, the first citation key one has,
 *  and the field whose data its key and .bib entry take: the one with the
 *  most, the first of those, as a field can have less, or none. */
function citedItems(citations: ZoteroCitation[]): Array<{ meta: CitationMetadata; ids: Set<string>; citationKey?: string }> {
  // A field's item's names: each of its URIs, else its identifier
  const names = (meta: CitationMetadata) => meta.zoteroUris?.length ? meta.zoteroUris.map(uri => 'uri:' + uri) : [itemIdentifier(meta)];
  // Union-find over the names, which the fields that list two join
  const parent = new Map<string, string>();
  const find = (name: string): string => {
    let root = name;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let next = name; next !== root;) { const up = parent.get(next)!; parent.set(next, root); next = up; }
    return root;
  };
  const fields = citations.flatMap(citation => citation.items);
  for (const meta of fields) {
    const [first, ...rest] = names(meta);
    for (const name of [first, ...rest]) if (!parent.has(name)) parent.set(name, name);
    for (const name of rest) parent.set(find(name), find(first));
  }
  const items = new Map<string, { meta: CitationMetadata; ids: Set<string>; citationKey?: string }>();
  for (const meta of fields) {
    const root = find(names(meta)[0]);
    const item = items.get(root);
    if (!item) {
      items.set(root, { meta, ids: new Set([itemIdentifier(meta)]), citationKey: meta.citationKey });
      continue;
    }
    item.ids.add(itemIdentifier(meta));
    item.citationKey ??= meta.citationKey;
    if (itemDataSize(meta) > itemDataSize(item.meta)) item.meta = meta;
  }
  return [...items.values()];
}

/** How much of its item's data a field holds: the fields of its itemData
 *  with a value, not an empty list of authors or a date with no parts */
function itemDataSize(meta: CitationMetadata): number {
  const holds = (value: unknown): boolean => Array.isArray(value) ? value.some(holds)
    : value !== null && typeof value === 'object' ? Object.values(value).some(holds)
    : value != null && value !== '';
  return Object.values(meta.fullItemData).filter(holds).length;
}

/** What tells one field's item from another's: its URI, which Zotero finds
 *  an item by, else its ID in the field, as Zotero falls back to. Without
 *  either, its DOI, else its title, year and authors, so that items alike in
 *  title and year don't share a key. Fields whose other URIs overlap cite
 *  one item too (see citedItems). */
export function itemIdentifier(meta: CitationMetadata): string {
  if (meta.zoteroUri) return 'uri:' + meta.zoteroUri;
  if (meta.itemId) return 'id:' + meta.itemId;
  if (meta.doi) { return `doi:${meta.doi}`; }
  return `${meta.title}::${meta.year}::` + JSON.stringify(meta.authors);
}

function getSurname(meta: CitationMetadata): string {
  if (meta.authors.length > 0) {
    const first = meta.authors[0];
    if (first.literal) return first.literal;
    if (first.family) return first.family;
  }
  const publisher = meta.fullItemData.publisher;
  return (typeof publisher === 'string' && publisher) || meta.journal || 'unknown';
}

/** Strip characters that are significant in Pandoc citation syntax. */
function sanitizeCitationText(text: string | number): string {
  return String(text).replace(/[\[\];@]/g, '');
}

/** Backslash-escape what would parse as Markdown formatting in a sanitized
 *  citation prefix (code, emphasis, math, CriticMarkup, highlights,
 *  strikethrough, HTML, escapes; entities can't form without `;`). The exporter
 *  only accepts plain-text prefixes and decodes the escapes, so the Zotero
 *  prefix comes back unchanged. Lone `=`, `~`, and `<` stay as written. */
function escapeCitationPrefix(prefix: string): string {
  return prefix.replace(/[\\`*_${]|==|~~|<(?=[A-Za-z\/!?])/g,
    match => match.split('').map(c => '\\' + c).join(''));
}

/** Get the Pandoc citation items for a citation, e.g. `@key`, `-@key, p. 5`
 *  (suppress-author), or `e.g., @key` (prefix). Join with '; ' inside brackets. */
export function citationPandocKeys(
  citation: ZoteroCitation,
  keyMap: Map<string, string>
): string[] {
  return citation.items
    .map(meta => {
      const k = keyMap.get(itemIdentifier(meta));
      if (!k) return undefined;
      const prefix = meta.prefix ? escapeCitationPrefix(sanitizeCitationText(meta.prefix).replace(/\s+/g, ' ').trim()) : '';
      let item = (prefix ? prefix + ' ' : '') + (meta.suppressAuthor ? '-@' : '@') + k;
      if (meta.locator) {
        const safe = sanitizeCitationText(meta.locator);
        if (safe) item += ', p. ' + safe;
      }
      return item;
    })
    .filter((k): k is string => k !== undefined);
}

// Document content extraction

export interface ImageExtractionEntry {
  rId: string;
  mediaPath: string;
  outputFilename: string;
}

/** The image files a conversion writes, and the media each file name holds */
interface ImageFiles {
  entries: ImageExtractionEntry[];
  filenames: Map<string, string>;
}

/** A relationship's media target as its path in the package */
function mediaZipPath(target: string): string {
  const resolved: string[] = [];
  for (const part of (target.startsWith('word/') ? target : 'word/' + target).split('/')) {
    if (part === '..') resolved.pop();
    else if (part !== '.') resolved.push(part);
  }
  return resolved.join('/');
}

/** The file name an image's media takes: its own, or where another
 *  media's has it, the first with -2, -3 and so on that none has */
function imageFilename(files: ImageFiles, filename: string, mediaPath: string): string {
  const media = mediaZipPath(mediaPath);
  const dot = filename.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ''];
  for (let n = 1, name = filename; ; name = stem + '-' + ++n + ext) {
    const holder = files.filenames.get(name);
    if (holder === undefined || holder === media) return name;
  }
}

/**
 * The images of a w:drawing, its <wp:inline>s and <wp:anchor>s, whose
 * pictures' relationships are in `relationships`, with `extra` on each
 * item. `files` collects the file each needs.
 */
function drawingImages(
  drawing: XmlNode[], relationships: Map<string, string>, imageFolder: string, files: ImageFiles,
  extra: { commentIds: Set<string>; revision?: RevisionInfo },
): ContentItem[] {
  const images: ContentItem[] = [];
  for (const child of drawing) {
    const inlineOrAnchor = child['wp:inline'] || child['wp:anchor'];
    if (!inlineOrAnchor) continue;
    const elements = asXmlNodes(inlineOrAnchor);
    // Extract extent, docPr, and blip from the inline/anchor element
    let cx = 0, cy = 0, alt = '', docPrName = '', blipRId = '';
    for (const el of elements) {
      if (el['wp:extent'] !== undefined) {
        cx = parseInt(getAttr(el, 'cx') || '0', 10);
        cy = parseInt(getAttr(el, 'cy') || '0', 10);
      } else if (el['wp:docPr'] !== undefined) {
        alt = getAttr(el, 'descr') || '';
        docPrName = getAttr(el, 'name') || '';
      } else if (el['a:graphic'] !== undefined) {
        // Dig into a:graphic > a:graphicData > pic:pic > pic:blipFill > a:blip
        const graphicData = findAllDeep([el], 'a:graphicData');
        for (const gd of graphicData) {
          const blips = findAllDeep([gd], 'a:blip');
          for (const blip of blips) {
            const embed = blip?.[':@']?.['@_r:embed'] ?? getAttr(blip, 'embed');
            if (embed) blipRId = embed;
          }
        }
      }
    }
    if (!blipRId) continue;
    const mediaPath = relationships.get(blipRId);
    if (!mediaPath) continue;
    // Check supported format
    const mediaFilename = mediaPath.split('/').pop() || '';
    const ext = mediaFilename.split('.').pop()?.toLowerCase() || '';
    if (!isSupportedImageFormat(ext)) continue;
    // A distinct image with the name of one in the document or a note takes
    // another name, which one file per name would have written over
    const outputFilename = imageFilename(files, resolveImageFilename(docPrName, mediaFilename), mediaPath);
    const src = imageFolder ? imageFolder.replace(/\/$/, '') + '/' + outputFilename : outputFilename;
    const widthPx = cx > 0 ? emuToPixels(cx) : 0;
    const heightPx = cy > 0 ? emuToPixels(cy) : 0;
    images.push({ type: 'image', rId: blipRId, src, alt, widthPx, heightPx, ...extra, commentIds: new Set(extra.commentIds) });
    if (!files.filenames.has(outputFilename)) {
      files.filenames.set(outputFilename, mediaZipPath(mediaPath));
      files.entries.push({ rId: blipRId, mediaPath, outputFilename });
    }
  }
  return images;
}

export interface DocumentContentResult {
  content: ContentItem[];
  /** Paragraphs of spaces and tabs alone before the content, which count
   *  among export's paragraphs (see dropBlankParagraphText) */
  leadingBlankParagraphs?: number;
  zoteroBiblData?: ZoteroBiblData;
  imageEntries?: ImageExtractionEntry[];
}
function splitCellParagraphs(cellContent: ContentItem[]): ContentItem[][] {
  const paragraphs: ContentItem[][] = [];
  let current: ContentItem[] = [];
  let sawPara = false;

  for (const item of cellContent) {
    if (item.type === 'para') {
      if (!sawPara) {
        sawPara = true;
      } else {
        paragraphs.push(current);
        current = [];
      }
      continue;
    }
    current.push(item);
  }

  if (sawPara) {
    paragraphs.push(current);
  } else if (current.length > 0) {
    paragraphs.push(current);
  }

  if (paragraphs.length === 0) {
    paragraphs.push([]);
  }

  return paragraphs;
}

function tableHasFirstRowHeader(tblChildren: XmlNode[]): boolean {
  const tblPrNode = tblChildren.find((c) => c['w:tblPr'] !== undefined);
  if (!tblPrNode) return false;
  const tblPrChildren = asXmlNodes(tblPrNode['w:tblPr']);
  const tblLookNode = tblPrChildren.find((c) => c['w:tblLook'] !== undefined);
  if (!tblLookNode) return false;
  const firstRow = getAttr(tblLookNode, 'firstRow');
  return firstRow === '1' || firstRow === 'true' || firstRow === 'on';
}

function rowHasHeaderProp(trChildren: XmlNode[]): boolean {
  const trPrNode = trChildren.find((c) => c['w:trPr'] !== undefined);
  if (!trPrNode) return false;
  const trPrChildren = asXmlNodes(trPrNode['w:trPr']);
  const tblHeaderNode = trPrChildren.find((c) => c['w:tblHeader'] !== undefined);
  if (!tblHeaderNode) return false;
  const val = getAttr(tblHeaderNode, 'val');
  if (!val) return true;
  return val === '1' || val === 'true' || val === 'on';
}

/**
 * Convert raw rows (with vMerge annotations) into clean TableRows with numeric rowspan.
 * Continuation cells (vMerge without val="restart") are removed and the originating
 * cell's rowspan is set to the total number of merged rows.
 */
export function computeRowspans(
  rawRows: Array<{ isHeader: boolean; cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue'; align?: TableAlign }> }>
): TableRow[] {
  // Build a 2D grid: grid[rowIdx][gridCol] = reference to the raw cell
  const numRows = rawRows.length;
  // Determine total grid columns
  let totalCols = 0;
  for (const row of rawRows) {
    let cols = 0;
    for (const cell of row.cells) cols += cell.colspan;
    if (cols > totalCols) totalCols = cols;
  }

  // Map (rowIdx, gridCol) -> cell reference
  type CellRef = { rowIdx: number; cellIdx: number; cell: typeof rawRows[0]['cells'][0] };
  const grid: (CellRef | undefined)[][] = [];
  for (let r = 0; r < numRows; r++) {
    const gridRow: (CellRef | undefined)[] = new Array(totalCols).fill(undefined);
    let col = 0;
    for (let ci = 0; ci < rawRows[r].cells.length; ci++) {
      const cell = rawRows[r].cells[ci];
      for (let s = 0; s < cell.colspan && col + s < totalCols; s++) {
        gridRow[col + s] = { rowIdx: r, cellIdx: ci, cell };
      }
      col += cell.colspan;
    }
    grid.push(gridRow);
  }

  // For each column, scan downward: when "restart" found, count consecutive "continue" below
  const rowspanMap = new Map<string, number>(); // "rowIdx,cellIdx" -> rowspan
  const continuationCells = new Set<string>(); // "rowIdx,cellIdx" to remove

  for (let col = 0; col < totalCols; col++) {
    for (let r = 0; r < numRows; r++) {
      const ref = grid[r][col];
      if (!ref) continue;
      if (ref.cell.vMergeType === 'restart') {
        let span = 1;
        for (let r2 = r + 1; r2 < numRows; r2++) {
          const ref2 = grid[r2][col];
          if (ref2 && ref2.cell.vMergeType === 'continue') {
            span++;
            continuationCells.add(r2 + ',' + ref2.cellIdx);
          } else {
            break;
          }
        }
        if (span > 1) {
          rowspanMap.set(r + ',' + ref.cellIdx, span);
        }
      }
    }
  }

  // Build cleaned rows
  const result: TableRow[] = [];
  for (let r = 0; r < numRows; r++) {
    const cells: TableCell[] = [];
    for (let ci = 0; ci < rawRows[r].cells.length; ci++) {
      if (continuationCells.has(r + ',' + ci)) continue;
      const raw = rawRows[r].cells[ci];
      const cell: TableCell = { paragraphs: raw.paragraphs };
      if (raw.colspan > 1) cell.colspan = raw.colspan;
      if (raw.align) cell.align = raw.align;
      const rs = rowspanMap.get(r + ',' + ci);
      if (rs && rs > 1) cell.rowspan = rs;
      cells.push(cell);
    }
    result.push({ isHeader: rawRows[r].isHeader, cells });
  }

  return result;
}

export async function extractDocumentContent(
  data: Uint8Array | JSZip,
  zoteroCitations: ZoteroCitation[],
  keyMap: Map<string, string>,
  options?: {
    numberingDefs?: NumberingDefs;
    numberingStartOverrides?: NumberingStartOverrides;
    numberingInstances?: NumberingInstances;
    numberingStyles?: StyleNumbering;
    relationshipMap?: Map<string, string>;
    replyIds?: Set<string>;
    /** The IDs of the comments comments.xml has a body for. Word shows
     *  nothing of another's range, which alone would read as a highlight,
     *  {==a==}, which export writes as one, and which whitespace decisions
     *  such as dropBlankParagraphText's would count as commented text. */
    commentBodies?: ReadonlySet<string>;
    imageRelationships?: Map<string, string>;
    imageFolder?: string;
    /** The image files the conversion writes, which the notes' images share */
    imageFiles?: ImageFiles;
    portraitBreakOrdinals?: Set<number>;
    /** The sections, by the ordinal of the break that ends each, a references marker before their opening fence starts */
    referencesBeforeSections?: Set<number>;
    /** The hidden paragraphs before a section's opening fence it starts with, by the ordinal of the break that ends it */
    hiddenBeforeSections?: Map<number, number>;
    /** The hidden paragraphs after a section's closing fence it ends with, by the ordinal of the break that ends it */
    hiddenAfterSections?: Map<number, number>;
    /** The last section, by the number of breaks before it, where its landscape page is the template's, which no fence set */
    templatePageSections?: Set<number>;
    customStyles?: Record<string, CustomStyleDef>;
    /** Bookmark name → "noteKind:noteId" for resolving NOTEREF cross-reference fields. */
    footnoteCrossRefMap?: Map<string, string>;
    styleLayouts?: StyleLayouts;
  }
): Promise<DocumentContentResult> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/document.xml');
  if (!parsed) { return { content: [] }; }

  // Parse relationships and numbering definitions
  const relationshipMap = options?.relationshipMap ?? await parseRelationships(zip);
  const numberingResult = options?.numberingDefs
    ? { defs: options.numberingDefs, startOverrides: options.numberingStartOverrides ?? new Map(), instances: options.numberingInstances ?? new Map(), styles: options.numberingStyles ?? { styles: new Map() } }
    : await parseNumberingDefinitions(zip);
  const numberingDefs = numberingResult.defs;
  const numberingStartOverrides = numberingResult.startOverrides;
  const countListItem = wordListCounter(numberingDefs, numberingResult.instances);
  const replyIds = options?.replyIds;
  const imageRelMap = options?.imageRelationships ?? new Map<string, string>();
  const imageFolder = options?.imageFolder ?? '';
  const styleLayouts = options?.styleLayouts ?? await parseStyleLayouts(zip);
  useBuiltInStyleIds(parsed, styleLayouts.builtInIds);
  const imageFiles: ImageFiles = options?.imageFiles ?? { entries: [], filenames: new Map() };

  // Build a lookup: instrText index -> ZoteroCitation (in order of appearance)
  let citationIdx = 0;

  const content: ContentItem[] = [];
  // The comments whose ranges are open, but not replies or those without a
  // body (see commentBodies)
  const activeComments = new Set<string>();
  const commentStartTargetIndex = new Map<string, { target: ContentItem[], index: number }>();
  const commentBodies = options?.commentBodies;
  const hasRange = (id: string) => !replyIds?.has(id) && (!commentBodies || commentBodies.has(id));
  let inField = false;
  let inCitationField = false;
  let inBibliographyField = false;
  let inNoterefField = false;
  let noterefInfo: { noteId: string; noteKind: 'footnote' | 'endnote' } | undefined;
  let fieldInstrParts: string[] = [];
  // The highlight on a citation's or cross-reference's result, which the
  // renderer keeps (see renderHighlightGroup)
  let fieldFormatting: RunFormatting | undefined;
  const fieldShows = fieldVisibility();
  // A deleted field's instruction, read only for NOTEREF: zoteroCitations
  // counts the w:instrText ones alone
  let deletedInstrParts: string[] = [];
  // The comments whose ranges end in a citation's or cross-reference's
  // result, which import writes no text of, so they end with the field, on
  // the citation or reference, rather than before it, on nothing
  const resultEnds: string[] = [];
  let currentCitation: ZoteroCitation | undefined;
  let citationTextParts: string[] = [];
  let currentHref: string | undefined;
  // Each w:hyperlink's number, which its text keeps
  let currentLink = 0;
  let linkCount = 0;
  let zoteroBiblData: ZoteroBiblData | undefined;
  // Set after a paragraph whose mark is tracked: where its content ended,
  // so the next paragraph's para item can record the revision as breakRevision.
  let trackedParaMark: { revision: RevisionInfo; target: ContentItem[]; end: number } | undefined;
  // Paragraphs of spaces and tabs alone before the content, which no para
  // item stands for (see blankParagraphs)
  let leadingBlankParagraphs = 0;
  const crossRefMap = options?.footnoteCrossRefMap;

  // Section detection state
  let sectionStartIndex = 0; // index into `content` where the current section started
  let sectionBreakOrdinal = 0; // counter for paragraph-level sectPr occurrences
  let afterSectionBreak = false; // the last paragraph ended a section
  const portraitBreakOrdinals = options?.portraitBreakOrdinals;
  const referencesBeforeSections = options?.referencesBeforeSections;
  const hiddenBeforeSections = options?.hiddenBeforeSections;
  const hiddenAfterSections = options?.hiddenAfterSections;
  const templatePageSections = options?.templatePageSections;
  // The tracked mark before the empty carrier that ended the section before,
  // which Markdown drops, unless this section's fence puts its opener there
  let markBeforeSection: RevisionInfo | undefined;
  // Ends the section at the end of `target`, fencing it if it's landscape or a
  // portrait fence. A plain first paragraph has no para item, which the
  // opener would leave it on the line of. Display math and HTML comments
  // write their own line breaks. The mark before the section goes before
  // the opener, as the break that ends the paragraph before (see
  // joinTrackedParagraphBreaks), on an empty paragraph. A references marker
  // export wrote at the start of the section, as it had nothing to list,
  // goes between that mark and the opener, where it came before the
  // opener, as a custom property says. So do the hidden paragraphs,
  // comments alone, export wrote there, as another says, and the closer
  // goes before those it wrote at the end, as a third says.
  const endSection = (target: ContentItem[], fence: 'landscape' | 'portrait' | undefined, ordinal = sectionBreakOrdinal - 1): void => {
    const markBefore = markBeforeSection;
    markBeforeSection = undefined;
    if (fence) {
      // Past the marker and the hidden paragraphs, each its para item, but
      // at the document's start, and its comments, which nothing in its
      // paragraph follows
      let at = sectionStartIndex;
      let references = !!referencesBeforeSections?.has(ordinal);
      let hidden = hiddenBeforeSections?.get(ordinal) ?? 0;
      for (;;) {
        const item = target[at]?.type === 'para' ? at + 1 : at;
        let next = item;
        while (hidden > 0 && target[next]?.type === 'html_comment') next++;
        if (references && target[item]?.type === 'bibliography_marker') {
          references = false;
          at = item + 1;
        } else if (next > item && (!target[next] || isStructuralBoundaryItem(target[next]))) {
          hidden--;
          at = next;
        } else {
          break;
        }
      }
      const first = target[at];
      const opener: ContentItem = { type: fence === 'landscape' ? 'landscape_open' : 'portrait_open' };
      target.splice(at, 0,
        ...(first && !isStructuralBoundaryItem(first) && !(first.type === 'math' && first.display) && first.type !== 'html_comment'
          ? [opener, { type: 'para' } as ContentItem] : [opener]));
      if (markBefore) target.splice(sectionStartIndex, 0, { type: 'para', breakRevision: markBefore });
      // Back past the hidden paragraphs at the end, each its para item and
      // its comments
      let end = target.length;
      for (let hiddenAfter = hiddenAfterSections?.get(ordinal) ?? 0; hiddenAfter > 0; hiddenAfter--) {
        let start = end;
        while (target[start - 1]?.type === 'html_comment') start--;
        if (start === end || target[start - 1]?.type !== 'para') break;
        end = start - 1;
      }
      const closer: ContentItem = { type: fence === 'landscape' ? 'landscape_close' : 'portrait_close' };
      // The first one's para item can hold the tracked mark of the paragraph
      // before it, which stays before the closer, on an empty paragraph, as
      // the break that ends that paragraph (see joinTrackedParagraphBreaks),
      // as it does where the section's break comes before the comments
      const firstHidden = target[end];
      if (end < target.length && firstHidden.type === 'para' && firstHidden.breakRevision) {
        const { breakRevision, ...rest } = firstHidden;
        target.splice(end, 1, { type: 'para', breakRevision }, closer, rest);
      } else {
        target.splice(end, 0, closer);
      }
    }
    sectionStartIndex = target.length;
  };
  // The fence of the section whose properties, `sectPrChildren`, are its
  // break's, the `ordinal`th, or the body's: landscape where its page is,
  // and portrait where export wrote a portrait fence's break
  const sectionFenceOf = (sectPrChildren: XmlNode[], ordinal: number): 'landscape' | 'portrait' | undefined => {
    const pgSzNode = sectPrChildren.find((c) => c['w:pgSz'] !== undefined);
    let isLandscapeSect = false;
    if (pgSzNode) {
      const orient = getAttr(pgSzNode, 'orient');
      const w = parseInt(getAttr(pgSzNode, 'w') || '0', 10);
      const h = parseInt(getAttr(pgSzNode, 'h') || '0', 10);
      isLandscapeSect = orient === 'landscape' || (w > 0 && h > 0 && w > h);
    }
    return isLandscapeSect ? 'landscape' : portraitBreakOrdinals?.has(ordinal) ? 'portrait' : undefined;
  };

  function endComment(id: string, target: ContentItem[]): void {
    // Check if any content item was created with this comment ID
    const startInfo = commentStartTargetIndex.get(id);
    if (startInfo && startInfo.target === target) {
      if (!rangeHolds(target, startInfo.index, id)) {
        // Zero-width comment range: emit a synthetic empty text item,
        // without formatting, which would write code's `` as text
        target.push({ type: 'text', text: '', formatting: DEFAULT_FORMATTING, commentIds: new Set(activeComments), href: undefined });
      }
    }
    commentStartTargetIndex.delete(id);
    activeComments.delete(id);
  }

  function walk(
    nodes: XmlNode[],
    currentFormatting: RunFormatting = DEFAULT_FORMATTING,
    target: ContentItem[] = content,
    inTableCell = false,
    currentRevision?: RevisionInfo
  ): void {
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key === ':@') { continue; }

        if (key === 'w:fldChar') {
          const fldType = getAttr(node, 'fldCharType');
          if (fldType === 'begin') {
            // A field with no end, whose result's comments end
            for (const id of resultEnds.splice(0)) endComment(id, target);
            inField = true;
            fieldShows.begin();
            fieldInstrParts = [];
            fieldFormatting = undefined;
            deletedInstrParts = [];
            inCitationField = false;
            inBibliographyField = false;
            inNoterefField = false;
            noterefInfo = undefined;
          } else if (fldType === 'separate') {
            if (inField) {
              const instrText = fieldInstrParts.join('');
              const deletedInstrText = deletedInstrParts.join('');
              if (instrText.includes('ZOTERO_ITEM')) {
                inCitationField = true;
                currentCitation = zoteroCitations[citationIdx++];
                citationTextParts = [];
              } else if (instrText.includes('ZOTERO_BIBL')) {
                inBibliographyField = true;
                // Extract bibliography JSON payload
                const jsonStart = instrText.indexOf('{');
                const jsonEnd = instrText.lastIndexOf('}');
                if (jsonStart >= 0 && jsonEnd > jsonStart) {
                  try {
                    const biblJson = JSON.parse(instrText.slice(jsonStart, jsonEnd + 1));
                    zoteroBiblData = {
                      uncited: biblJson?.uncited,
                      omitted: biblJson?.omitted,
                      custom: biblJson?.custom,
                    };
                  } catch { /* ignore parse errors */ }
                }
              } else if (instrText.includes('NOTEREF') || (!instrText && deletedInstrText.includes('NOTEREF'))) {
                // Cross-reference to a footnote/endnote bookmark.
                // Always suppress display text for NOTEREF fields (even when
                // the mapping is unavailable) to prevent stray "1" literals.
                inNoterefField = true;
                const noterefMatch = (instrText || deletedInstrText).match(/NOTEREF\s+(\S+)/);
                if (noterefMatch && crossRefMap) {
                  const bkmkName = noterefMatch[1];
                  const resolved = crossRefMap.get(bkmkName);
                  if (resolved) {
                    const colonIdx = resolved.indexOf(':');
                    const noteKind = resolved.slice(0, colonIdx);
                    const noteId = resolved.slice(colonIdx + 1);
                    if (colonIdx !== -1 && noteId && (noteKind === 'footnote' || noteKind === 'endnote')) {
                      noterefInfo = { noteId, noteKind };
                    }
                  }
                }
              }
            }
          } else if (fldType === 'end') {
            const shows = fieldShows.shows();
            if (inNoterefField && noterefInfo && shows) {
              target.push({
                type: 'footnote_ref',
                noteId: noterefInfo.noteId,
                noteKind: noterefInfo.noteKind,
                commentIds: new Set(activeComments),
                ...(currentRevision ? { revision: currentRevision } : {}),
                ...highlightOnly(fieldFormatting),
              });
            }
            if (inCitationField && currentCitation && shows) {
              const pandocKeys = citationPandocKeys(currentCitation, keyMap);
              target.push({
                type: 'citation',
                text: citationTextParts.join(''),
                commentIds: new Set(activeComments),
                pandocKeys,
                ...(currentRevision ? { revision: currentRevision } : {}),
                ...highlightOnly(fieldFormatting),
              });
            }
            if (inBibliographyField && shows) {
              target.push({ type: 'bibliography_marker' });
            }
            for (const id of resultEnds.splice(0)) endComment(id, target);
            inField = false;
            inCitationField = false;
            inBibliographyField = false;
            inNoterefField = false;
            noterefInfo = undefined;
            currentCitation = undefined;
          }
        } else if (key === 'w:instrText' && inField) {
          fieldInstrParts.push(nodeText(asXmlNodes(node['w:instrText'])));
        } else if (key === 'w:delInstrText' && inField) {
          deletedInstrParts.push(nodeText(asXmlNodes(node['w:delInstrText'])));
        } else if (key in REVISION_ELEMENTS) {
          const author = getAttr(node, 'author');
          const date = getAttr(node, 'date');
          const rev = { type: REVISION_ELEMENTS[key], author, date };
          if (Array.isArray(node[key])) walk(node[key], currentFormatting, target, inTableCell, rev);
        } else if (key === 'w:commentRangeStart') {
          const id = getAttr(node, 'id');
          if (hasRange(id)) {
            activeComments.add(id);
            commentStartTargetIndex.set(id, { target, index: target.length });
          }
        } else if (key === 'w:commentRangeEnd') {
          const id = getAttr(node, 'id');
          if (hasRange(id)) {
            if ((inCitationField && currentCitation) || (inNoterefField && noterefInfo)) resultEnds.push(id);
            else endComment(id, target);
          }
        } else if (key === 'w:footnoteReference') {
          const noteId = getAttr(node, 'id');
          if (noteId && noteId !== '0' && noteId !== '-1') {
            target.push({ type: 'footnote_ref', noteId, noteKind: 'footnote', commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}), ...highlightOnly(currentFormatting) });
          }
        } else if (key === 'w:endnoteReference') {
          const noteId = getAttr(node, 'id');
          if (noteId && noteId !== '0' && noteId !== '-1') {
            target.push({ type: 'footnote_ref', noteId, noteKind: 'endnote', commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}), ...highlightOnly(currentFormatting) });
          }
        } else if (key === 'w:hyperlink') {
          const rId = node?.[':@']?.['@_r:id'] ?? getAttr(node, 'id');
          const prevHref = currentHref;
          const prevLink = currentLink;
          currentHref = relationshipMap.get(rId);
          currentLink = ++linkCount;
          if (Array.isArray(node[key])) { walk(node[key], currentFormatting, target, inTableCell, currentRevision); }
          currentHref = prevHref;
          currentLink = prevLink;
        } else if (key === 'w:tbl' && !inTableCell) {
          const markBefore = trackedParaMark;
          const tblChildren = asXmlNodes(node[key]);
          const rawRows: Array<{ isHeader: boolean; cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue'; align?: TableAlign }> }> = [];
          const firstRowHeaderByLook = tableHasFirstRowHeader(tblChildren);
          // Where each cell is, for its table style's parts
          const look = tableLook(tblChildren);
          const rowCount = tblChildren.filter((c) => c['w:tr'] !== undefined).length;
          const columnCount = tableColumnCount(tblChildren);
          for (const tr of tblChildren.filter((c) => c['w:tr'] !== undefined)) {
            const trChildren = asXmlNodes(tr['w:tr']);
            const cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue'; align?: TableAlign }> = [];
            for (const tc of trChildren.filter((c) => c['w:tc'] !== undefined)) {
              const tcChildren = asXmlNodes(tc['w:tc']);
              // Parse cell properties
              let colspan = 1;
              let vMergeType: 'restart' | 'continue' | undefined;
              const tcPrNode = tcChildren.find((c) => c['w:tcPr'] !== undefined);
              if (tcPrNode) {
                const tcPrChildren = asXmlNodes(tcPrNode['w:tcPr']);
                const gridSpanNode = tcPrChildren.find((c) => c['w:gridSpan'] !== undefined);
                if (gridSpanNode) {
                  const val = parseInt(getAttr(gridSpanNode, 'val'), 10);
                  if (val > 1) colspan = val;
                }
                const vMergeNode = tcPrChildren.find((c) => c['w:vMerge'] !== undefined);
                if (vMergeNode) {
                  const val = getAttr(vMergeNode, 'val');
                  vMergeType = val === 'restart' ? 'restart' : 'continue';
                }
              }
              const cellItems: ContentItem[] = [];
              walk(tcChildren, currentFormatting, cellItems, true, currentRevision);
              cells.push({ paragraphs: splitCellParagraphs(cellItems), colspan, vMergeType, align: cellAlignment(tcChildren, styleLayouts, tableStyleId(tblChildren, styleLayouts),
                { row: rawRows.length, rows: rowCount, col: cells.reduce((n, cell) => n + cell.colspan, 0), span: colspan, cols: columnCount, look }) });
            }
            rawRows.push({ isHeader: rowHasHeaderProp(trChildren), cells });
          }
          if (firstRowHeaderByLook && rawRows.length > 0) {
            rawRows[0].isHeader = true;
          }
          const rows = computeRowspans(rawRows);
          if (rows.length > 0) {
            // A tracked mark before the table is the break that ends the
            // paragraph before it (see joinTrackedParagraphBreaks), which an
            // empty paragraph takes, as one before the table would
            if (markBefore?.target === target && markBefore.end === target.length) target.push({ type: 'para', breakRevision: markBefore.revision });
            target.push({ type: 'table', rows });
          } else {
            trackedParaMark = markBefore;
          }
        } else if (key === 'w:r') {
          // Process run - extract formatting from w:rPr
          let runFormatting = currentFormatting;
          const runChildren = withCharactersAsText(asXmlNodes(node[key]));
          let rPrChildren: XmlNode[] | undefined;
          for (const child of runChildren) {
            if (child['w:rPr']) {
              rPrChildren = asXmlNodes(child['w:rPr']);
              runFormatting = parseRunProperties(rPrChildren, currentFormatting);
              break;
            }
          }

          const walked = readHiddenRun(runChildren, rPrChildren, target, activeComments, currentRevision);
          fieldShows.run(runChildren, walked);
          walk(walked, runFormatting, target, inTableCell, currentRevision);
        } else if (key === 'w:br') {
          // Line break within a run (Shift+Enter in Word).
          // Only emit for default/textWrapping breaks; skip page/column breaks.
          const brType = getAttr(node, 'type');
          if (!brType || brType === 'textWrapping') {
            if (!inBibliographyField && !inCitationField) {
              target.push({
                type: 'text',
                text: '\\\n',
                commentIds: new Set(activeComments),
                formatting: currentFormatting,
                ...(currentRevision ? { revision: currentRevision } : {}),
                ...(currentHref ? { href: currentHref, link: currentLink } : {}),
              });
            }
          }
        } else if (key === 'w:t' || key === 'w:delText') {
          const text = nodeText(asXmlNodes(node[key]));
          if (text) {
            if (inCitationField || inNoterefField) fieldFormatting ??= currentFormatting;
            if (inBibliographyField || inNoterefField) {
              // Skip display text inside ZOTERO_BIBL / NOTEREF fields
            } else if (inCitationField) {
              citationTextParts.push(text);
            } else {
              const textItem: ContentItem = { 
                type: 'text', 
                text, 
                commentIds: new Set(activeComments),
                formatting: currentFormatting,
                ...(currentRevision ? { revision: currentRevision } : {}),
              };
              if (currentHref) {
                textItem.href = currentHref;
                textItem.link = currentLink;
              }
              target.push(textItem);
            }
          }
        } else if (key === 'w:p') {
          const precedingMark = trackedParaMark;
          trackedParaMark = undefined;
          if (afterSectionBreak) {
            countListItem.sectionBreak();
            afterSectionBreak = false;
          }
          // Process paragraph - extract heading level, list metadata, and title style
          let headingLevel: number | undefined;
          let listMeta: ListMeta | undefined;
          let isTitle = false;
          let blockquoteLevel: number | undefined;
          let blockquoteIndentUnitTwips: 240 | 720 | undefined;
          let blockquoteStyle: BlockquoteStyle | undefined;
          let alertType: GfmAlertType | undefined;
          let isCodeBlock = false;
          let generatedListContinuation = false;
          let customStyle: string | undefined;
          let paragraphLeftIndentTwips: number | undefined;
          let spacerShaped = false;
          let horizontalRule = false;
          let taskLevel: number | undefined;
          let paraFormatting = currentFormatting;
          let isSpacerParagraph = false;
          let isSectionBreakHandled = false;
          let sectionFence: 'landscape' | 'portrait' | 'none' | undefined; // this paragraph ends a section
          let paraMarkRevision: RevisionInfo | undefined;

          const paraChildren = asXmlNodes(node[key]);
          for (const child of paraChildren) {
            if (child['w:pPr']) {
              const pPrChildren = asXmlNodes(child['w:pPr']);

              // Detect and skip spacer paragraphs: exact-height empty <w:p>
              // with inline left border and no pStyle, generated by
              // alertFirst/alertLast in md→docx for visual padding.
              // Signature: no pStyle, w:spacing line="1" lineRule="exact",
              // w:pBdr with w:left border.
              const hasPStyle = pPrChildren.some((c) => c['w:pStyle'] !== undefined);
              if (!hasPStyle) {
                const spacingNode = pPrChildren.find((c) => c['w:spacing'] !== undefined);
                const pBdrNode = pPrChildren.find((c) => c['w:pBdr'] !== undefined);
                if (spacingNode && pBdrNode) {
                  const lineVal = getAttr(spacingNode, 'line');
                  const lineRule = getAttr(spacingNode, 'lineRule');
                  const pBdrChildren = asXmlNodes(pBdrNode['w:pBdr']);
                  const hasLeftBorder = pBdrChildren.some((c) => c['w:left'] !== undefined);
                  if (lineVal === '1' && lineRule === 'exact' && hasLeftBorder) {
                    isSpacerParagraph = true;
                    break;
                  }
                }
              }

              // Detect section break (w:sectPr inside w:pPr)
              const sectPrNode = pPrChildren.find((c) => c['w:sectPr'] !== undefined);
              if (sectPrNode && !inTableCell) {
                const currentOrdinal = sectionBreakOrdinal++;
                afterSectionBreak = true;
                const fence = sectionFenceOf(asXmlNodes(sectPrNode['w:sectPr']), currentOrdinal);
                if (paragraphCarriesContent(paraChildren)) {
                  // Word attaches the break to the section's last paragraph
                  // when nothing else carries it: read that paragraph as any
                  // other, then end the section
                  sectionFence = fence ?? 'none';
                } else {
                  // An empty section-break carrier, whose children can still
                  // hold comment ranges, and which can be a rule. A tracked
                  // mark before one Markdown keeps, as a rule or a section's
                  // fence, is the break that ends the paragraph before it
                  // (see joinTrackedParagraphBreaks), which the rule, or an
                  // empty paragraph, takes. Markdown keeps one that ends a
                  // section before a fenced one as the fence's opener (see
                  // endSection), and drops it, and the mark, otherwise, as
                  // the paragraph after would take it in its place
                  const rule = isRuleCarrier(pPrChildren);
                  const markBefore = precedingMark?.target === target && precedingMark.end === target.length ? precedingMark.revision : undefined;
                  const breakRevision = fence || rule ? markBefore : undefined;
                  if (rule || breakRevision) target.push({ type: 'para', ...(rule ? { horizontalRule: true } : {}), ...(breakRevision ? { breakRevision } : {}) });
                  if (fence || rule) walk(paraChildren, paraFormatting, target, inTableCell, currentRevision);
                  endSection(target, fence);
                  if (!fence && !rule) markBeforeSection = markBefore;
                  isSectionBreakHandled = true;
                  break;
                }
              }

              headingLevel = parseHeadingLevel(pPrChildren);
              listMeta = parseListMeta(pPrChildren, numberingDefs, numberingStartOverrides, countListItem, numberingResult.styles);
              isTitle = parseTitleStyle(pPrChildren);
              const blockquoteInfo = parseBlockquoteInfo(pPrChildren);
              blockquoteLevel = blockquoteInfo.level;
              blockquoteIndentUnitTwips = blockquoteInfo.indentUnitTwips;
              blockquoteStyle = blockquoteInfo.style;
              alertType = parseAlertType(pPrChildren);
              isCodeBlock = parseCodeBlockStyle(pPrChildren);
              generatedListContinuation = parseListContinuationStyle(pPrChildren);
              customStyle = parseCustomStyleName(pPrChildren, options?.customStyles ?? undefined);
              paragraphLeftIndentTwips = parseParagraphLeftIndentTwips(pPrChildren);
              spacerShaped = pPrChildren.length === 1 && pPrChildren[0]['w:spacing'] !== undefined
                && Object.keys(pPrChildren[0][':@'] ?? {}).join() === '@_w:after' && getAttr(pPrChildren[0], 'after') === '0';
              // Taken back below if the paragraph has content
              horizontalRule = !headingLevel && !listMeta && !isTitle && !blockquoteLevel && !isCodeBlock
                && !generatedListContinuation && !customStyle && hasOnlyBottomBorder(pPrChildren);
              if (!listMeta && !headingLevel && !blockquoteLevel && !isCodeBlock && !customStyle) taskLevel = parseTaskIndentLevel(pPrChildren);
              const pRPrElement = pPrChildren.find(pprChild => pprChild['w:rPr'] !== undefined);
              if (pRPrElement) {
                const pRPrChildren = asXmlNodes(pRPrElement['w:rPr']);
                paraFormatting = parseRunProperties(pRPrChildren, currentFormatting);
                // Paragraph-mark revision (w:ins/w:del inside pPr > rPr):
                // the whole paragraph was inserted/deleted as a unit.
                for (const rPrChild of pRPrChildren) {
                  const revKey = Object.keys(rPrChild).find(k => k in REVISION_ELEMENTS);
                  if (revKey) {
                    paraMarkRevision = {
                      type: REVISION_ELEMENTS[revKey],
                      author: getAttr(rPrChild, 'author'),
                      date: getAttr(rPrChild, 'date'),
                    };
                    break;
                  }
                }
              }
              break;
            }
          }
          // One with no w:pPr has the default style, which can number it
          if (!paraChildren.some(child => child['w:pPr'])) {
            listMeta = parseListMeta([], numberingDefs, numberingStartOverrides, countListItem, numberingResult.styles);
          }
          if (isSpacerParagraph) {
            // Keep a structural-only boundary so adjacent same-type alerts remain
            // separate even when generated labels are disabled. Table cells cannot
            // contain alert groups, and their nested content bypasses top-level cleanup.
            if (!inTableCell) {
              target.push({ type: 'para', isBlockquoteSpacer: true });
              // A tracked mark before it is the break before the paragraph
              // after it, as export pads a quote with it
              if (precedingMark?.target === target && precedingMark.end === target.length - 1) {
                trackedParaMark = { ...precedingMark, end: target.length };
              }
            }
            continue;
          }
          if (isSectionBreakHandled) {
            continue;
          }

          // Skip paragraphs inside bibliography field — text is already suppressed,
          // but we must also suppress the para markers to avoid trailing blank lines.
          if (inBibliographyField) {
            // Still need to walk children so field end markers are processed
            walk(paraChildren, paraFormatting, target, inTableCell, currentRevision);
            if (sectionFence) endSection(target, sectionFence === 'none' ? undefined : sectionFence);
            continue;
          }

          // Always push a new para when heading/list/title/blockquote/codeblock metadata is present (so metadata
          // isn't silently dropped after empty paragraphs).  For plain paragraphs,
          // push only when the previous item isn't already a plain para separator.
          // If the previous para is structural (heading/list/title/blockquote/codeblock),
          // we must push a new plain para to preserve paragraph boundaries.
          const prevItem = target.length > 0 ? target[target.length - 1] : undefined;
          const prevIsCodeBlockPara = prevItem?.type === 'para' && prevItem.isCodeBlock;
          const prevIsStructuralPara = prevItem?.type === 'para' && (
            prevItem.headingLevel !== undefined ||
            prevItem.listMeta !== undefined ||
            prevItem.isTitle === true ||
            prevItem.isBlockquoteSpacer === true ||
            prevItem.blockquoteLevel !== undefined ||
            prevItem.isCodeBlock === true ||
            prevItem.generatedListContinuation === true ||
            prevItem.customStyleName !== undefined ||
            prevItem.horizontalRule === true ||
            prevItem.taskLevel !== undefined
          );
          const needsPara = inTableCell || (headingLevel || listMeta || isTitle || blockquoteLevel || isCodeBlock || generatedListContinuation || customStyle || horizontalRule || taskLevel !== undefined)
            ? true
            : target.length > 0 && (prevItem!.type !== 'para' || prevIsCodeBlockPara || prevIsStructuralPara);

          const targetLenBeforePara = target.length;
          // Whether the tracked mark of the paragraph before is a break this
          // one's text joins to it
          let trackedBreak = false;
          // Paragraphs whose tracked mark can become a break inside a CriticMarkup
          // span (see joinTrackedParagraphBreaks); headings keep paraMarkRevision
          // too, for one whose text is all in the revision, {++# a++}. A
          // block takes the break before it even where it can't join the
          // text before, which the break then ends
          const takesTrackedBreak = !inTableCell && !isTitle;
          const canJoinTrackedBreak = takesTrackedBreak && !isCodeBlock;
          if (needsPara) {
            const paraItem: ContentItem = { type: 'para' };
            if (headingLevel) paraItem.headingLevel = headingLevel;
            if (listMeta) paraItem.listMeta = listMeta;
            if (isTitle) paraItem.isTitle = true;
            if (blockquoteLevel) paraItem.blockquoteLevel = blockquoteLevel;
            if (blockquoteIndentUnitTwips) paraItem.blockquoteIndentUnitTwips = blockquoteIndentUnitTwips;
            if (blockquoteStyle) paraItem.blockquoteStyle = blockquoteStyle;
            if (alertType) paraItem.alertType = alertType;
            if (isCodeBlock) paraItem.isCodeBlock = true;
            if (generatedListContinuation) paraItem.generatedListContinuation = true;
            if (customStyle) paraItem.customStyleName = customStyle;
            if (paragraphLeftIndentTwips !== undefined) paraItem.paragraphLeftIndentTwips = paragraphLeftIndentTwips;
            if (spacerShaped) paraItem.spacerShaped = true;
            if (horizontalRule) paraItem.horizontalRule = true;
            if (taskLevel !== undefined) paraItem.taskLevel = taskLevel;
            if (paraMarkRevision && headingLevel) paraItem.paraMarkRevision = paraMarkRevision;
            if (takesTrackedBreak && precedingMark?.target === target && precedingMark.end === targetLenBeforePara) {
              paraItem.breakRevision = precedingMark.revision;
              // A list item, a heading or code never joins it (see
              // breakContainer). Whether another's container is the one
              // before's, a later pass finds, with which paragraphs continue
              // a list.
              trackedBreak = breakContainer(paraItem, 'after') !== undefined;
            }
            target.push(paraItem);
          }
          walk(paraChildren, paraFormatting, target, inTableCell, currentRevision);
          const hasText = target.length > targetLenBeforePara + (needsPara ? 1 : 0);
          if (hasText && !inTableCell && !isCodeBlock && !inBibliographyField) {
            startRangesAtMark(target, targetLenBeforePara, commentStartTargetIndex, activeComments);
          }
          for (let k = targetLenBeforePara; k < target.length; k++) {
            const walked = target[k];
            if (walked.type === 'math' && walked.display) walked.inParagraph = true;
          }
          // A paragraph of spaces and tabs alone is an empty one, but not in
          // a table's cell, whose empty paragraph keeps its place, so the
          // whitespace keeps it too, nor in code, nor where its mark or the
          // one before it is tracked, which joins its text to the paragraph
          // before (see joinTrackedParagraphBreaks), or a comment's range
          // starts at its mark, which the item startRangesAtMark added holds,
          // as an empty paragraph would lose them
          const blank = !inTableCell && !isCodeBlock && !paraMarkRevision && !trackedBreak
            && dropBlankParagraphText(target, targetLenBeforePara + (needsPara ? 1 : 0));
          // If walking this paragraph's children entered a bibliography field
          // (i.e. the field-begin + separate markers were in this paragraph),
          // remove the para we just pushed — it would become a trailing blank line.
          if (inBibliographyField && needsPara && target.length > targetLenBeforePara) {
            target.splice(targetLenBeforePara, 1);
          } else if (needsPara) {
            const paraItem = target[targetLenBeforePara];
            // Which export numbered (see blankParagraphs)
            if (blank && paraItem?.type === 'para' && isNumberedParagraphKind(paraItem)) paraItem.blankParagraphs = 1;
            // A rule has nothing to show, though it can hold a zero-width comment
            if (paraItem?.type === 'para' && paraItem.horizontalRule
                && target.slice(targetLenBeforePara + 1).some(item => item.type !== 'text' || item.text !== '')) {
              delete paraItem.horizontalRule;
            }
            if (
              paraItem?.type === 'para' &&
              !paraItem.horizontalRule &&
              target.length === targetLenBeforePara + 1 &&
              !paraItem.headingLevel &&
              !paraItem.listMeta &&
              !paraItem.isTitle &&
              !paraItem.blockquoteLevel &&
              !paraItem.isCodeBlock &&
              !paraItem.generatedListContinuation &&
              !paraItem.customStyleName
            ) {
              paraItem.emptyParagraphCount = 1;
              const prevItem = targetLenBeforePara > 0 ? target[targetLenBeforePara - 1] : undefined;
              if (
                prevItem?.type === 'para' &&
                prevItem.emptyParagraphCount !== undefined &&
                !prevItem.headingLevel &&
                !prevItem.listMeta &&
                !prevItem.isTitle &&
                !prevItem.blockquoteLevel &&
                !prevItem.isCodeBlock &&
                !prevItem.generatedListContinuation &&
                !prevItem.customStyleName
              ) {
                prevItem.emptyParagraphCount += paraItem.emptyParagraphCount;
                if (paraItem.blankParagraphs) prevItem.blankParagraphs = (prevItem.blankParagraphs ?? 0) + paraItem.blankParagraphs;
                target.splice(targetLenBeforePara, 1);
              }
            }
          } else if (
            target.length === targetLenBeforePara &&
            !headingLevel &&
            !listMeta &&
            !isTitle &&
            !blockquoteLevel &&
            !isCodeBlock &&
            !generatedListContinuation &&
            !customStyle
          ) {
            const prevItem = target.length > 0 ? target[target.length - 1] : undefined;
            if (
              prevItem?.type === 'para' &&
              prevItem.emptyParagraphCount !== undefined &&
              !prevItem.headingLevel &&
              !prevItem.listMeta &&
              !prevItem.isTitle &&
              !prevItem.blockquoteLevel &&
              !prevItem.isCodeBlock &&
              !prevItem.generatedListContinuation &&
              !prevItem.customStyleName
            ) {
              prevItem.emptyParagraphCount += 1;
              if (blank) prevItem.blankParagraphs = (prevItem.blankParagraphs ?? 0) + 1;
            } else if (blank && !prevItem && target === content) {
              leadingBlankParagraphs++;
            }
          }
          if (paraMarkRevision && canJoinTrackedBreak && !inBibliographyField && target.length > targetLenBeforePara) {
            trackedParaMark = { revision: paraMarkRevision, target, end: target.length };
          }
          if (sectionFence) {
            // A fence's opener goes in before this paragraph's content
            if (sectionFence !== 'none') trackedParaMark = undefined;
            endSection(target, sectionFence === 'none' ? undefined : sectionFence);
          }
        } else if (key === 'm:oMathPara') {
          // Display equation — extract m:oMath children from within
          const mathParaChildren = asXmlNodes(node[key]);
          const oMathNodes = mathParaChildren.filter((c) => c['m:oMath'] !== undefined);
          for (const oMathNode of oMathNodes) {
            try {
              const latex = ommlToLatex(asXmlNodes(oMathNode['m:oMath']));
              if (latex) {
                target.push({ type: 'math', latex, display: true, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
              }
            } catch {
              target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: true, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
            }
          }
        } else if (key === 'm:oMath') {
          // Inline equation
          const mathChildren = asXmlNodes(node[key]);
          try {
            const latex = ommlToLatex(mathChildren);
            if (latex) {
              target.push({ type: 'math', latex, display: false, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
            }
          } catch {
            target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: false, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
          }
        } else if (key === 'w:drawing') {
          target.push(...drawingImages(asXmlNodes(node[key]), imageRelMap, imageFolder, imageFiles,
            { commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) }));
        } else if (Array.isArray(node[key])) {
          walk(node[key], currentFormatting, target, inTableCell, currentRevision);
        }
      }
    }
  }

  walk(parsed);
  for (const id of resultEnds.splice(0)) endComment(id, content);
  // The last paragraph's tracked mark, which no paragraph after it takes,
  // goes on an empty one, as an empty paragraph after it would take it
  if (trackedParaMark?.target === content && trackedParaMark.end === content.length) {
    content.push({ type: 'para', breakRevision: trackedParaMark.revision });
  }
  // The last section's properties are the body's own, after its paragraphs,
  // as Word writes a document that ends with a landscape section. Not a
  // document of one section, whose orientation is its page's, as a
  // template's, which no fence sets, nor a last section export gave a
  // template's landscape page, as a custom property says, by the number of
  // breaks before it, so one after a break Word adds is read as its page is.
  const documentNode = asXmlNodes(parsed).find(node => node['w:document'] !== undefined);
  const bodyNode = documentNode && asXmlNodes(documentNode['w:document']).find(node => node['w:body'] !== undefined);
  const bodySectPr = bodyNode && asXmlNodes(bodyNode['w:body']).find(node => node['w:sectPr'] !== undefined);
  if (bodySectPr && sectionBreakOrdinal > 0 && content.length > sectionStartIndex) {
    const fence = templatePageSections?.has(sectionBreakOrdinal) ? undefined : sectionFenceOf(asXmlNodes(bodySectPr['w:sectPr']), sectionBreakOrdinal);
    endSection(content, fence, sectionBreakOrdinal);
  }
  return { content, zoteroBiblData, imageEntries: imageFiles.entries.length > 0 ? imageFiles.entries : undefined, leadingBlankParagraphs };
}

// Markdown generation

function formattingEquals(a: RunFormatting, b: RunFormatting): boolean {
  return a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.highlight === b.highlight &&
    // A color without a highlight, which Markdown doesn't show
    (!a.highlight || a.highlightColor === b.highlightColor) &&
    a.superscript === b.superscript &&
    a.subscript === b.subscript &&
    a.code === b.code;
}

function revisionsEqual(a: RevisionInfo | undefined, b: RevisionInfo | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.author === b.author && a.date === b.date;
}

// Avoid literal '$$' — tool text-replacement corrupts '$' in replacement
// strings. See CLAUDE.md "Template literal corruption" rule.
const MATH_FENCE = '$'.repeat(2);
function canonicalizeDisplayMathLatex(latex: string): string {
  const trimmed = latex.trim();
  const envMatch = trimmed.match(/^\\begin\{([a-zA-Z*]+)\}\s*([\s\S]*?)\s*\\end\{\1\}$/);
  if (!envMatch) return trimmed;
  const envName = envMatch[1];
  const multilineEnvs = new Set(['aligned', 'align', 'align*', 'gathered', 'cases']);
  if (!multilineEnvs.has(envName)) return trimmed;
  const inner = envMatch[2].trim();
  if (!inner) return `\\begin{${envName}}\n\\end{${envName}}`;
  const rows = inner.split(/\\\\/).map(row => row.trim()).filter(row => row.length > 0);
  if (rows.length === 0) return `\\begin{${envName}}\n\\end{${envName}}`;
  return `\\begin{${envName}}\n${rows.join(' \\\\\n')}\n\\end{${envName}}`;
}

/** `text` in a span of `rev`. Text with the span's closer in it, as code,
 *  math or a URL can have where an escape is text, would end the span
 *  there, so it goes on one side of a substitution with nothing on the
 *  other, which export reads as a change of that side alone, unless it has
 *  a substitution's delimiters too, where code comes in pieces (see
 *  codePiecesInRevision), as written once its emphasis resolves, where a
 *  struck } or > reads as ~~} or ~~>. A bare link's choice holds the
 *  closer it's read before (see bareLinkChoice), which isn't text. */
function wrapWithRevision(text: string, rev?: RevisionInfo): string {
  if (!rev) return text;
  const holds = (closer: string) => text.includes(closer) && text.split(BARE_LINK + closer + BARE_LINK).join(BARE_LINK).includes(closer);
  if (rev.type === 'addition') return holds('++}') && substitutionHolds('', resolveEmphasis(text)) ? '{~~~>' + text + '~~}' : `{++${text}++}`;
  if (rev.type === 'deletion') return holds('--}') && substitutionHolds(resolveEmphasis(text), '') ? '{~~' + text + '~>~~}' : `{--${text}--}`;
  return text;
}

/** The text of code in a tracked change in pieces that spans of the change
 *  can hold. Code with the span's closer in it goes on one side of a
 *  substitution (see wrapWithRevision), which can't hold a ~> on the old
 *  side or a ~~} on either; with those too, it splits between the closer's
 *  first two characters, into code spans of their own, each in a span of
 *  its own, as in {--`a-`--}{--`-}b~>c`--}, which export reads as runs of
 *  the change side by side, and import joins again. */
function codePiecesInRevision(text: string, rev: RevisionInfo): string[] {
  if (revisionSpanHolds(text, rev)) return [text];
  const closer = rev.type === 'addition' ? '++}' : '--}';
  const pieces: string[] = [];
  let from = 0;
  for (let at = text.indexOf(closer); at !== -1; at = text.indexOf(closer, at + closer.length)) {
    pieces.push(text.slice(from, at + 1));
    from = at + 1;
  }
  pieces.push(text.slice(from));
  return pieces;
}

/** Whether the span of `rev` that wrapWithRevision writes around `text`,
 *  which holds no bare link's choice, holds it whole: a closer of the span
 *  in the text ends it there, and the substitution with nothing on its
 *  other side that holds one can't hold a ~> on its old side or a ~~},
 *  as written once the text's emphasis resolves */
function revisionSpanHolds(text: string, rev: RevisionInfo): boolean {
  if (!text.includes(rev.type === 'addition' ? '++}' : '--}')) return true;
  const resolved = resolveEmphasis(text);
  return rev.type === 'addition' ? substitutionHolds('', resolved) : substitutionHolds(resolved, '');
}

type InlineRevisionItem = Extract<ContentItem, { type: 'text' | 'citation' | 'math' | 'footnote_ref' | 'image' }>;

/** How a span may join its neighbours: at any safe seam, only across
 *  whitespace, or never. */
type SpanJoin = 'seam' | 'space' | 'never';

/** The span of one revision that rendered Markdown ends with: where it
 *  starts and ends, its last character, the kinds of delimiter it holds and
 *  that its text has of its own, how its last item joins (spanJoin), and
 *  the mark of the highlight it ends with, if it ends with one's ==. */
type RevisionSpan = {
  revision: RevisionInfo; start: number; end: number; lastChar: string;
  kinds: Set<string>; literal: Set<string>; join: SpanJoin; highlightEnd?: string;
};

/** Marks where appendRevised joined a span to the one before it, after that
 *  span's closer; joinRevisedSpans drops both once the range is rendered, so
 *  a join copies nothing. A Word document can't hold U+FFFF, which XML
 *  excludes. */
const SPAN_JOIN = '\uFFFF';

/** Marks, after its opener, a span appendRevised opened with a tracked
 *  paragraph break (see joinTrackedParagraphBreaks), which no span before
 *  it took, for joinSpansAtTrackedBreaks, which drops it. A Word document
 *  can't hold U+FFFE either. */
const SPAN_AT_BREAK = '\uFFFE';

/** The mark that starts the text of each tracked paragraph break of the
 *  Markdown buildMarkdown is building, if it has any, which no text in the
 *  document has (see trackedBreakMarks), for appendRevised */
let trackedBreakStart: string | undefined;

/** Rendered Markdown with the spans appendRevised joined run together. */
function joinRevisedSpans(markdown: string): string {
  return markdown.includes(SPAN_JOIN) ? markdown.replace(/(?:\+\+|--)\}\uFFFF/g, '') : markdown;
}

/** Around a link bareLinkChoice gave a choice: its Markdown as a link, its
 *  address alone, and the closer of the CriticMarkup span it's in, if any,
 *  for resolveBareLinks to pick between once the text around it is written.
 *  A Word document can't hold it, which XML excludes, as it does the marks
 *  of emphasis (EMPHASIS_OPEN). */
const BARE_LINK = '\u0007';

/**
 * `link`, the Markdown for `item`, or, where its text is its URL or email
 * address, without formatting, a choice between that and its address alone,
 * which linkify makes a link of, for resolveBareLinks. It reads the text as
 * written around the link, where formatting, another link or an equation
 * after it can be what linkify reads, not where it ends. `rangeCloser` ends
 * the comment's range it's in, if any, as ==} does, or else a tracked
 * change's span does, as ++}: Markdown reads a span apart from the text
 * after it.
 */
function bareLinkChoice(item: ContentItem, link: string, rangeCloser = ''): string {
  // Linkify reads no address in an HTML table's cell
  if (!readsMarkdown || item.type !== 'text' || !item.href || hasFormatting(item.formatting)
    || item.text !== item.href && item.href !== 'mailto:' + item.text) return link;
  const closer = item.revision ? (item.revision.type === 'addition' ? '++}' : '--}') : rangeCloser;
  return BARE_LINK + link + BARE_LINK + item.text + BARE_LINK + closer + BARE_LINK;
}

/** The most text resolveBareLinks reads on either side of a link without a
 *  space in it; past that, the link keeps its syntax. */
const BARE_LINK_CONTEXT = 1000;

/**
 * `markdown` with each link bareLinkChoice gave a choice as its address
 * alone where export reads that back as the link, and as a link elsewhere.
 * For an address, linkify, as export runs it, must find it in the text
 * around it, starting and ending where it does. A URL with // after its
 * scheme is one markdown-it's own rule finds at its colon, from the text
 * before it, which mustn't end in a letter, a digit or a +, or a
 * backslash, which escapes the scheme's first letter; it reads the
 * address whole, past syntax in it, and drops a * from its end. After a .
 * or -, as for an email address, linkify finds it in the text as Markdown
 * leaves it, which syntax splits, so its address must hold none. Export shows an address
 * with percent-encoding and punycode decoded, so it must have neither.
 *
 * From the last link, so the text after each is as written. One before it
 * counts as a link, as it is before one that's bare, which its address
 * would run into. A span a link is in ends the text after it, and its
 * opener the text before it. The pass reads up to a space on either side,
 * so it takes time in the length of the text. In a table's cell (`cell`),
 * a grid table's line is trimmed, so the spaces and tabs before a line
 * break are written as references (see gridLineBeforeBreak). Before an
 * equation in the paragraph (`beforeMath`), the spaces that end the text
 * are written as beforeParagraphMath writes them, as references, which
 * linkify reads on into after the last link's address and what ends it.
 */
function resolveBareLinks(markdown: string, cell = false, beforeMath = false): string {
  if (!markdown.includes(BARE_LINK)) return markdown;
  // Text, then each link's Markdown, address and closer, and the text after it
  const parts = markdown.split(BARE_LINK);
  const count = (parts.length - 1) / 4;
  const chosen: string[] = new Array(count);
  // The text after the link after this one, to its first space, if in reach
  let nextHead: string | undefined;
  for (let k = count - 1; k >= 0; k--) {
    const [before, link, address, closer, after] = parts.slice(4 * k, 4 * k + 5);
    // The text after it, to a space, or through the next link if there's none
    const space = after.search(/\s/);
    let head = space >= 0 ? after.slice(0, space + 1)
      : k + 1 < count && nextHead !== undefined ? after + chosen[k + 1] + nextHead
        : k + 1 < count ? undefined : after;
    if (head !== undefined && head.length > BARE_LINK_CONTEXT) head = undefined;
    nextHead = head;
    // A ! before it, escaped for the link's [, which keeps the address from
    // reading as one, is text before it bare
    const bang = /(?:^|[^\\])(?:\\\\)*\\!$/.test(before) ? before.slice(0, -2) + '!' : undefined;
    // Whitespace that may start a line, which keepParagraphWhitespace
    // writes as references, as joinSpansAtTrackedBreaks does after a
    // tracked break's end mark, a private-use character (see
    // trackedBreakMarks)
    const lineStart = (k === 0 ? /(?:^|[\n\uE000-\uF8FF])[ \t]+$/ : /[\n\uE000-\uF8FF][ \t]+$/).test(before);
    // Whitespace that is all the text before the first link or after the
    // last, which keepParagraphWhitespace writes as references where it
    // starts or ends a paragraph or a cell, so the address must read back
    // with them too: linkify reads a URL on into &nbsp; after it, and links
    // no address but a URL with // after one
    const edgeBefore = k === 0 && /^\s+$/.test(before);
    // And in a cell, the spaces and tabs before a line break, which a grid
    // table's line writes as references
    const lineEnd = cell ? /^[ \t]+(?=\\\n)/.exec(after)?.[0] : undefined;
    // The text after it as written, where that differs: whitespace alone
    // at the paragraph's end, and before an equation in the paragraph, text
    // with no space in it before the spaces that end it too
    const ending = k === count - 1 && (beforeMath ? /^\S*\s+$/ : /^\s+$/).test(after)
      ? keepParagraphEdgeWhitespace(address + after, false, true) : undefined;
    const written = ending !== undefined ? (beforeMath ? beforeParagraphMath(ending) : ending).slice(address.length)
      : lineEnd !== undefined ? gridLineBeforeBreak(address + lineEnd).slice(address.length) + '\n' : undefined;
    const readsBack = (lead: string) => head !== undefined && bareLinkReadsBack(lead, address, closer, head, lineStart)
      && (!edgeBefore && written === undefined || bareLinkReadsBack(
        edgeBefore ? keepParagraphEdgeWhitespace(lead + address, true, false).slice(0, -address.length) : lead, address, closer,
        written ?? head, lineStart));
    if (bang !== undefined && readsBack(bang)) {
      chosen[k] = address;
      parts[4 * k] = bang;
    } else {
      chosen[k] = readsBack(before) ? address : link;
    }
  }
  const out: string[] = [parts[0]];
  for (let k = 0; k < count; k++) out.push(chosen[k], parts[4 * k + 4]);
  return out.join('');
}

/** Whether `address`, written bare between `before` and `following`, reads
 *  back as a link of it alone (see resolveBareLinks), after whitespace that
 *  starts its line where `lineStart` */
function bareLinkReadsBack(before: string, address: string, closer: string, following: string, lineStart: boolean): boolean {
  const email = !/^[a-z][a-z0-9.+-]*:/i.test(address);
  if (linkifiedText(address, email) !== address) return false;
  // After a $, as of inline math, which a letter or digit after its
  // closing $ keeps from closing (see textNextToMath)
  if (/(?:^|[^\\])(?:\\\\)*\$$/.test(before) && /^\w/.test(address)) return false;
  // In a span, which ends the text it holds
  if (closer) {
    const at = following.indexOf(closer);
    if (at >= 0 && !following.slice(0, at).includes('{')) following = following.slice(0, at);
  }
  // The text before it to a space or the opener of the span it starts
  let lead = before.slice(-BARE_LINK_CONTEXT);
  if (/(?:^|[^\\])(?:\\\\)*(?:\{(?:\+\+|--|~~|==)|~>)$/.test(lead)) lead = '';
  lead = lead.slice(lead.search(/\S*$/));
  if (/^[a-z][a-z0-9.+-]*:\/\//i.test(address) && !/[.-]$/.test(lead)) {
    if (/[a-z0-9+]$/i.test(lead) || /(?:^|[^\\])(?:\\\\)*\\$/.test(lead) || address.endsWith('*')) return false;
    lead = '';
  } else if (/[$&=*`~\\<>[\]!]|(?:^|[^a-z0-9])_|_(?:[^a-z0-9]|$)/i.test(address)) {
    // Syntax, which splits the text linkify reads, as _ that can be emphasis
    return false;
  } else if (lineStart || /(?:^|[^\\])(?:\\\\)*(?:\\[!-/:-@[-`{-~]|&#?[a-z0-9]+;)$/i.test(lead)) {
    // An escape or a character reference, after which markdown-it links no
    // address but a URL with //, which it reads before them
    return false;
  }
  return linkifyMatches(lead + address + following).some(link => link.index === lead.length && link.lastIndex === lead.length + address.length);
}

/** `markdown`, the Markdown of the text at `index`, with a ! at its end
 *  escaped where a link comes next in its comments, which the ! would make
 *  an image of, as in ![text](url). A note's [^1] or a citation's [@key]
 *  isn't one, and stays one after a !. Spans of a tracked change keep apart
 *  at a ! before a link (canJoinSpans), so only text in none, or on a side
 *  of a substitution (`side`), which has none of its own, runs into one.
 *  From the text's Markdown, as reading the end of Markdown being built
 *  copies it, which took time in the square of a paragraph's length over
 *  its links. */
function escapeBangBeforeLink(markdown: string, segment: ContentItem[], index: number, end: number, side = false): string {
  const item = segment[index];
  let k = index + 1;
  while (k < end && segment[k].type === 'text' && (segment[k] as ContentItem & { type: 'text' }).text === '') k++;
  const next = segment[k];
  // A tracked change's delimiters come between them, but for one of part of
  // a link of several runs, which go inside its text, after its [. In an
  // HTML table's cell, a link is its tag, which a ! makes nothing of.
  if (!readsMarkdown || k >= end || item.type !== 'text' || next.type !== 'text' || next.href === undefined
    || !side && (item.revision || next.revision && !partlyRevisedLinkAt(segment, k, end, next.commentIds))
    || !commentSetsEqual(item.commentIds, next.commentIds)) return markdown;
  return /(?:^|[^\\])(?:\\\\)*!$/.test(markdown) ? markdown.slice(0, -1) + '\\!' : markdown;
}

/** `markdown`, the Markdown of an item, with a }, = or {color} it starts
 *  with escaped after a highlight's closing == at the end of the Markdown
 *  `before` it, which would read them as its own: ==a==} as CriticMarkup's
 *  ==}, which ends no highlight, ==a=={red} as its color, and ==a===b as
 *  no highlight, as navigation and the grammar read it, but not the ==
 *  that opens a highlight. After one with a color, as in ==a=={red}{blue},
 *  the escape keeps the text as it is too. From the end of `before`, which may be long, and is read only
 *  where the item's Markdown starts so, as reading it copies Markdown being
 *  built: without the closer of the span it ends with where the item
 *  joins that span (`inSpan`, see inSpanBefore). */
function escapeAfterHighlight(markdown: string, before: string, inSpan = false): string {
  // eslint-disable-next-line no-control-regex
  return /^(?:\}|=(?!=[\u0005\u000E])|\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\})/.test(markdown)
    && /==(?:\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\})?$/.test(inSpan ? before.slice(-67, -3) : before.slice(-64)) ? '\\' + markdown : markdown;
}

/** Whether `item` is of the revision of the span `out` ends with, which
 *  appendRevised joins it to where it can, after which the Markdown before
 *  the item's is `out` without the span's closer */
function inSpanBefore(out: string, item: InlineRevisionItem, last: RevisionSpan | undefined): boolean {
  return !!item.revision && !!last && last.end === out.length && revisionsEqual(last.revision, item.revision);
}

/** A letter, digit or _, next to an inline equation's $, after which it
 *  opens no math, or before which it closes none */
const WORD_NEXT_TO_MATH = /[A-Za-z0-9_]/;

/** `c` as a character reference, which markdown-it reads as the character,
 *  but math by the characters as written */
function characterReference(c: string): string {
  return '&#' + c.charCodeAt(0) + ';';
}

/**
 * `markdown`, the Markdown of the text at `index`, kept apart from inline
 * math right next to it, whose $ it would run into. After the equation,
 * where `afterMath` (its closing $ ends the Markdown written before), a $
 * it starts with is escaped, as with the closing $ it reads as no math,
 * and a letter or digit is written as a reference, after which the $
 * closes none. Before one, to `end`, a letter, digit or _ it ends with is
 * a reference, after which the $ opens none, and a $ it ends with is
 * escaped, as with the opening $ it reads as no math. A tracked change's
 * delimiters keep them apart but in a span of items (`span`), as a
 * comment's do, and so does an emphasis or highlight the Markdown starts
 * or ends with. Where the text goes is read by position, not from the
 * Markdown before it, which reading would copy.
 */
function textNextToMath(markdown: string, segment: ContentItem[], index: number, end: number, afterMath: boolean, span = false, before = ''): string {
  const item = segment[index];
  if (item.type !== 'text' || item.href || markdown === '') return markdown;
  if (afterMath && (span || !item.revision)) {
    if (markdown[0] === '$') markdown = '\\' + markdown;
    // A $ after the letter or digit, which kept it from opening math, does
    // after the reference's ;
    else if (WORD_NEXT_TO_MATH.test(markdown[0])) markdown = characterReference(markdown[0]) + (markdown[1] === '$' ? '\\' : '') + markdown.slice(1);
  }
  let k = index + 1;
  while (k < end && segment[k].type === 'text' && (segment[k] as ContentItem & { type: 'text' }).text === '') k++;
  const next = k < end ? segment[k] : undefined;
  if (next?.type !== 'math' || next.display || !commentSetsEqual(item.commentIds, next.commentIds ?? NO_COMMENTS)
      || (!span && (item.revision || next.revision))) return markdown;
  const last = markdown[markdown.length - 1];
  if (last !== '$' && !WORD_NEXT_TO_MATH.test(last)) return markdown;
  let slashes = 0;
  while (markdown[markdown.length - 2 - slashes] === '\\') slashes++;
  const own = slashes;
  // Those `before` ends with count too, as a citation's text can end with
  // one, which is read only then, as reading it would copy it
  if (slashes === markdown.length - 1 && endsWithBackslash(segment, index)) {
    for (let p = before.length - 1; p >= 0 && before.charCodeAt(p) === 92; p--) slashes++;
  }
  if (last === '$') return slashes % 2 === 0 ? markdown.slice(0, -1) + '\\$' : markdown;
  // An escaped _ goes with its backslash, and a backslash before a letter
  // or digit is doubled, as before the reference's & it would escape it
  if (slashes % 2 === 0) return markdown.slice(0, -1) + characterReference(last);
  return last === '_' && own > 0 ? markdown.slice(0, -2) + characterReference(last) : markdown.slice(0, -1) + '\\' + characterReference(last);
}

/** Whether the item before `index` in `segment`, past empty text, has text
 *  that ends with a backslash */
function endsWithBackslash(segment: ContentItem[], index: number): boolean {
  for (let k = index - 1; k >= 0; k--) {
    const item = segment[k];
    if (!('text' in item) || typeof item.text !== 'string') return false;
    if (item.text !== '') return item.text.endsWith('\\');
  }
  return false;
}

/**
 * `out` with `text`, the Markdown for `item`, appended as a span of the item's
 * revision, and the span it now ends with. The text joins `last` instead of
 * opening a span of its own when `last` ends `out`, records the same revision,
 * and both items and the seam between them allow it (spanJoin, canJoinSpans),
 * so a Word revision that runs across a citation, an equation or a formatting
 * change stays one span: {++in month $t$, conditional++}.
 */
function appendRevised(
  out: string, text: string, item: InlineRevisionItem, last: RevisionSpan | undefined, itemJoin = spanJoin(item),
): [string, RevisionSpan | undefined] {
  const revision = item.revision;
  if (!revision) return [out + text, undefined];
  const { join, literal } = itemJoin;
  const kinds = delimiterKinds(text);
  const disjoint = (a: Set<string>, b: Set<string>) => ![...a].some(kind => b.has(kind));
  const seamSafe = (before: RevisionSpan) =>
    text !== '' && join !== 'never' && before.join !== 'never'
    // A delimiter of the text's own could pair with one of its kind in the
    // other span, but for in an HTML table's cell, where text's is a
    // reference or text (see canJoinSpans)
    && (!readsMarkdown || disjoint(literal, before.kinds) && disjoint(before.literal, kinds))
    && (join === 'space' || before.join === 'space'
      ? /\s/.test(before.lastChar) || /^\s/.test(text)
      : canJoinSpans(before.lastChar, text) || canJoinAtHighlight(before, text));
  // eslint-disable-next-line no-control-regex
  const highlightEnd = /([\u0006\u000F])==(?:\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\})?$/.exec(text)?.[1];
  const span = wrapWithRevision(text, revision);
  // A substitution holds the text with its closer in it, and nothing joins it
  const own = span.startsWith('{~~');
  if (!own && last && last.end === out.length && revisionsEqual(last.revision, revision) && seamSafe(last)) {
    const joined = out + SPAN_JOIN + span.slice(3);
    return [joined, {
      revision, start: last.start, end: joined.length, lastChar: text.slice(-1),
      kinds: new Set([...last.kinds, ...kinds]), literal: new Set([...last.literal, ...literal]), join, highlightEnd,
    }];
  }
  const atBreak = !own && trackedBreakStart !== undefined && text.startsWith(trackedBreakStart + '\n');
  const wrapped = out + (atBreak ? span.slice(0, 3) + SPAN_AT_BREAK + span.slice(3) : span);
  return [wrapped, { revision, start: out.length, end: wrapped.length, lastChar: text.slice(-1), kinds, literal, join: own ? 'never' : join, highlightEnd }];
}

/** Delimiters that can pair with one of their kind in another span once
 *  spans join, even across a space, by kind: code, math, link and HTML
 *  brackets, emphasis and the extension marks, CriticMarkup braces. */
const DELIMITER_KINDS: Record<string, string> = {
  '`': '`', '$': '$', '[': '[', ']': '[', '<': '<', '>': '<', '*': '*', '_': '_', '~': '~', '=': '=', '^': '^', '{': '{', '}': '{',
};

/** The kinds of delimiter in `markdown`, past backslash escapes. */
function delimiterKinds(markdown: string): Set<string> {
  const kinds = new Set<string>();
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === '\\') i++;
    else if (DELIMITER_KINDS[markdown[i]]) kinds.add(DELIMITER_KINDS[markdown[i]]);
  }
  return kinds;
}

/**
 * How an item's span may join its neighbours: at any safe seam, only across
 * whitespace, or never; and the kinds of delimiter its text has of its own
 * (`literal`), which appendRevised keeps from meeting their kind in the other
 * span: in ` ` and `b` the backtick would pair with the code's and turn the
 * space into code. Text is read as import writes it, with * escaped, except
 * a bare URL's. Code keeps its text literal, and so does math, except for a
 * backtick, which Markdown reads before math. Text whose & would read with
 * the other span's text as an entity, as &am and p; would, keeps apart from
 * it (appendRevised). A bare URL or email joins only across whitespace,
 * since linkify finds one only between boundaries. Images and display math
 * keep their own spans.
 */
function spanJoin(item: InlineRevisionItem): { join: SpanJoin; literal: Set<string> } {
  switch (item.type) {
    case 'text': {
      const bare = !!item.href && (item.text === item.href || item.href === 'mailto:' + item.text) && !hasFormatting(item.formatting);
      if (item.formatting.code && !item.href) return { join: 'seam', literal: new Set() };
      return {
        join: bare ? 'space' : 'seam',
        literal: delimiterKinds(bare ? item.text : escapeMarkdownChars(item.text)),
      };
    }
    case 'citation':
      return { join: 'seam', literal: new Set() };
    case 'math':
      return { join: item.display ? 'never' : 'seam', literal: new Set(item.latex.includes('`') ? ['`'] : []) };
    case 'footnote_ref':
      return { join: 'seam', literal: new Set() };
    default:
      return { join: 'never', literal: new Set() };
  }
}

/**
 * Whether a span ending in `beforeEnd` and one starting with `after` can run
 * together without changing how the Markdown at the seam reads. Apart, each side borders a {++ or ++} marker;
 * joined, they border each other, which matters to emphasis, math, link and
 * citation delimiters: $ can't close before a letter, *a.* can't close before
 * one, ! turns a following [ into an image. Whitespace on either side, or
 * letters and digits on both, is safe. So is a citation, link, equation, code
 * span or emphasis that ends before sentence punctuation, or one that starts
 * after an opening parenthesis, a hyphen or a slash. A footnote reference
 * joins after a word, the end of a sentence, a closing quote, or a citation,
 * equation, code span, emphasis, strikethrough, highlight or HTML-like
 * formatting tag (</u>), and a closing bracket before a letter, a digit,
 * emphasis, strikethrough, a highlight or a tag, none of which can open a
 * link: before[^1]after, ==a==[^1]==b==, **==a==**[^1]**==b==**. A link
 * joins a word, emphasis or another link on either side: [a](u)b[c](u). A
 * line break's \ joins after anything, as it reads as one at any line's
 * end, and ends nothing before it: {++**a**\\\n++}, where Word's bold
 * stops before the break, as export writes it.
 */
function canJoinSpans(beforeEnd: string, after: string): boolean {
  const a = beforeEnd.slice(-1);
  const b = after.charAt(0);
  if (!a || !b) return false;
  // In an HTML table's cell that holds what HTML can't, the runs are HTML,
  // whose tags and references read as they do next to anything, and what
  // Markdown would read at the seam is text
  if (!readsMarkdown) return true;
  if (/\s/.test(a) || /\s/.test(b) || after.startsWith('\\\n')) return true;
  if (/[\p{L}\p{N}\]]/u.test(a) && /[\p{L}\p{N}]/u.test(b)) return true;
  if (a === ']' && /^(?:\*|==|~~|<)/.test(after)) return true;
  if (after.startsWith('[^') && /[\p{L}\p{N}.,;:?)\]$*`"'\u2019\u201D=}~>]/u.test(a)) return true;
  // A link's ) before a letter, a digit, emphasis or another link, and its
  // [ after one of those, a link's ), code or math, which make nothing more
  // of either, as a ! before [ makes an image and a ] a reference
  if (a === ')' && /[\p{L}\p{N}[*_]/u.test(b) || b === '[' && /[\p{L}\p{N})*_`$]/u.test(a)) return true;
  return (/[\])$*`]/.test(a) && /[.,;:!?)]/.test(b)) || (/[(\-/]/.test(a) && /[[$*`]/.test(b));
}

/** Whether a span that ends `before` and one starting with `after` can run
 *  together at a highlight's ==, which reads as it did next to ++} or {++:
 *  one that closes it before a letter, digit or escape, as of a {color}
 *  after it (see escapeAfterHighlight), or before the == that
 *  opens the next of the highlights it joins (see joinHighlights), which
 *  joins them then, or one that opens it after a letter or digit, as in
 *  ==a ==b and a== b==. Their marks are still in the Markdown. */
function canJoinAtHighlight(before: RevisionSpan, after: string): boolean {
  if (before.highlightEnd) {
    return /^[\p{L}\p{N}\\]/u.test(after) || (before.highlightEnd === HIGHLIGHT_JOIN_CLOSE && after.startsWith('==' + HIGHLIGHT_JOIN_OPEN));
  }
  return /[\p{L}\p{N}]/u.test(before.lastChar) && (after.startsWith('==' + HIGHLIGHT_OPEN) || after.startsWith('==' + HIGHLIGHT_JOIN_OPEN));
}

const CRITIC_OPENERS: Record<string, string> = { '++': '{++', '--': '{--', '~~': '{~~', '==': '{==', '<<': '{>>' };

/** Where the CriticMarkup that ends at `end` with `closer` opens, no earlier
 *  than `from`, past spans of the same kind nested in it, as a comment's
 *  replies are, and the closers of spans appendRevised joined; -1 if it
 *  doesn't. */
function criticSpanStart(text: string, opener: string, closer: string, from: number, end: number): number {
  let depth = 0;
  for (let i = end - closer.length; i >= from; i--) {
    if (text.startsWith(closer, i) && text[i + closer.length] !== SPAN_JOIN) depth++;
    else if (text.startsWith(opener, i) && --depth === 0) return i;
  }
  return -1;
}

/**
 * The last character of `markdown` between `from` and `to` with its tracked
 * changes accepted or rejected, skipping comments and the spans that view
 * drops. Only the CriticMarkup at the end of the range is read.
 */
function lastVisibleChar(markdown: string, accepted: boolean, from = 0, to = markdown.length): string {
  let end = to;
  while (end > from) {
    end = textEnd(markdown, from, end);
    if (end <= from) break;
    const closer = /(\+\+|--|~~|==|<<)\}$/.exec(markdown.slice(Math.max(from, end - 3), end));
    const start = closer ? criticSpanStart(markdown, CRITIC_OPENERS[closer[1]], closer[0], from, end) : -1;
    if (!closer || start < 0) return lastTextChar(markdown, from, end);
    const inner = start + 3;
    const innerEnd = end - 3;
    const separator = closer[1] === '~~' ? markdown.indexOf('~>', inner) : -1;
    const split = separator >= 0 && separator < innerEnd ? separator : -1;
    const [visibleFrom, visibleTo] =
      closer[1] === '++' ? [inner, accepted ? innerEnd : inner] :
      closer[1] === '--' ? [inner, accepted ? inner : innerEnd] :
      closer[1] === '~~' ? (split < 0 ? [inner, innerEnd] : accepted ? [split + 2, innerEnd] : [inner, split]) :
      closer[1] === '==' ? [inner, innerEnd] : [inner, inner];
    const last = lastVisibleChar(markdown, accepted, visibleFrom, visibleTo);
    if (last) return last;
    end = start;
  }
  return '';
}

/** A close of formatting at the end of Markdown, after the text it holds:
 *  a highlight's, whose marks tell it from text's, which can be unescaped,
 *  emphasis's, marked or not, as one inside another's isn't, nor any once
 *  resolveSide resolves them, as text's are escaped, as \* and \~~, or an
 *  underline's, a strikethrough's (see wrapStrikethrough), a script's tag,
 *  or one resolveEmphasis writes for emphasis, as text's are references */
// eslint-disable-next-line no-control-regex
const FORMATTING_CLOSE_AT_END = /(?:[\u0006\u000F]==(?:\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\})?|(?:\u0004|(?<!\\))(?:\*\*|\*|~~)|<\/(?:u|s|sup|sub|b|i)>)$/;

/** As FORMATTING_CLOSE_AT_END, in an HTML table's cell, where htmlCellRun
 *  writes each tag of formatting, and text's as references */
// eslint-disable-next-line no-control-regex
const HTML_CELL_CLOSE_AT_END = /(?:[\u0006\u000F]==(?:\{[a-z0-9-]+\})?|<\/(?:u|sup|sub|b|i|s|code|a)>)$/;

/** The character before `end` in `markdown`, a line break's as a line end,
 *  as a <br> in an HTML table's cell (see htmlCellRun) */
function charBefore(markdown: string, end: number): string {
  return !readsMarkdown && markdown.endsWith('<br>', end) ? '\n' : markdown[end - 1] ?? '';
}

/** The last character of the text of `markdown` from `from` to `end`: the
 *  one before `end` (see charBefore), or the last of the code a code span
 *  that ends there holds, inside its backticks and the spaces that pad
 *  them (see markedFormatting), as the space of `a `, which export writes
 *  as the code's */
function lastTextChar(markdown: string, from: number, end: number): string {
  if (!readsMarkdown || markdown[end - 1] !== '`') return charBefore(markdown, end);
  let fenceStart = end - 1;
  while (fenceStart > from && markdown[fenceStart - 1] === '`') fenceStart--;
  // Not an escaped backtick of text's
  let slashes = 0;
  while (fenceStart - 1 - slashes >= from && markdown[fenceStart - 1 - slashes] === '\\') slashes++;
  if (slashes % 2 === 1) return charBefore(markdown, end);
  // The span opens at the nearest run of as many backticks before, as the
  // code holds no run of them
  const fence = end - fenceStart;
  for (let k = fenceStart - 1; k >= from; k--) {
    if (markdown[k] !== '`') continue;
    let runStart = k;
    while (runStart > from && markdown[runStart - 1] === '`') runStart--;
    if (k + 1 - runStart === fence) {
      const code = markdown.slice(k + 1, fenceStart);
      const padded = code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code);
      return (padded ? code[code.length - 2] : code[code.length - 1]) ?? '';
    }
    k = runStart;
  }
  return charBefore(markdown, end);
}

/** Where the text of `markdown` before `end` ends, past the closes of the
 *  formatting around it, as a highlight's, which holds the whitespace at
 *  its edges: ==a == */
function textEnd(markdown: string, from: number, end: number): number {
  for (;;) {
    const close = (readsMarkdown ? FORMATTING_CLOSE_AT_END : HTML_CELL_CLOSE_AT_END).exec(markdown.slice(Math.max(from, end - 72), end));
    if (!close) return end;
    end -= close[0].length;
  }
}

/** The space import puts before a Pandoc citation: none when the text before
 *  it already ends with one in a view the citation shows in, so no view gets
 *  two, as in Seen {++a ++}[@key], or when there is none before it on its
 *  line, after a line break or a tracked paragraph break. A view
 *  without the space then keeps the citation against its text, as Word has it
 *  there. */
function citationSeparator(precedingMarkdown: string, citation: Extract<ContentItem, { type: 'citation' }>, last?: RevisionSpan): string {
  // Where Word starts a paragraph with it, as after a tracked break the
  // view drops, as in a{--\n\n--}{++[@key]++}, a space would be one at the
  // paragraph's start
  if (citation.lineStart) return '';
  const revision = citation.revision;
  const views = revision?.type === 'addition' ? [true] : revision?.type === 'deletion' ? [false] : [true, false];
  // The span the Markdown ends with gives its last character without a
  // scan, past the formatting its text ends in, before its ++} or --}
  const span = last && last.end === precedingMarkdown.length ? last : undefined;
  // Nor at the start of a block or a line, where there is no text to space
  // it from, and a space at a line's start would be lost
  return views.some(accepted => [' ', '', '\n'].includes(
    span?.revision.type === (accepted ? 'addition' : 'deletion')
      ? lastTextChar(precedingMarkdown, span.start, textEnd(precedingMarkdown, span.start, span.end - 3))
      : lastVisibleChar(precedingMarkdown, accepted, 0, span ? span.start : precedingMarkdown.length)
  )) ? '' : ' ';
}


function commentSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

type SubstitutionItem = ContentItem & { type: 'text' | 'citation' | 'math' | 'footnote_ref' };

function isSubstitutionItem(item: ContentItem | undefined): item is SubstitutionItem {
  return !!item && (item.type === 'text' || item.type === 'citation' || item.type === 'math' || item.type === 'footnote_ref');
}

/** A note reference as Markdown, under the label import assigned its note. */
function footnoteRefText(item: ContentItem & { type: 'footnote_ref' }, noteLabels?: Map<string, string>): string {
  return '[^' + (noteLabels?.get(item.noteKind + ':' + item.noteId) ?? item.noteId) + ']';
}

/** A citation as Markdown, its keys in brackets, as export reads it there
 *  (see syntaxText) */
function citationText(item: ContentItem & { type: 'citation' }): string {
  return syntaxText('[' + item.pandocKeys.join('; ') + ']');
}

/** A note reference's or citation's run formatting, kept when highlighted:
 *  its highlight is the formatting import writes back. */
function highlightOnly(formatting: RunFormatting | undefined): { formatting?: RunFormatting } {
  return formatting?.highlight ? { formatting } : {};
}

/** The color an item's highlight reads back as, if it has one. */
function highlightColorOf(item: ContentItem): string | undefined {
  const formatting = item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' ? item.formatting : undefined;
  if (!formatting?.highlight) return undefined;
  return markdownHighlightColor(formatting) ?? 'yellow';
}

/**
 * Where a highlight group that starts at `start` ends, or `start` when none
 * does. A group runs over items of one revision, or none, in the comments
 * `commentIds`: text without a link, note references and citations that
 * share a highlight color, and the inline equations between them, which
 * export doesn't highlight. It needs a reference, citation or equation:
 * highlighted text alone keeps its own markers. renderHighlightGroup writes
 * it in one highlight, ==a[^1] b==, rather than one per item, ==a==[^1]== b==.
 * It ends where the span of its revision holds it (see heldGroupEnd).
 */
function highlightGroupEnd(segment: ContentItem[], start: number, end: number, commentIds: Set<string>): number {
  const first = segment[start];
  const color = highlightColorOf(first);
  if (!color || first.type === 'math' || !isSubstitutionItem(first)) return start;
  // An == in an item would close the highlight, even in code or an equation
  const joins = (item: ContentItem) =>
    (item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || (item.type === 'math' && !item.display))
    && revisionsEqual(item.revision, first.revision) && commentSetsEqual(item.commentIds, commentIds)
    && !(item.type === 'text' && item.href) && !groupItemSource(item).includes('==');
  if (!joins(first)) return start;
  const groupless = grouplessRuns.get(segment);
  if (groupless && groupless.from < start && start < groupless.to) return start;
  const kept = heldGroups.get(segment);
  const held = kept?.length === segment.length ? kept.byEnd.get(end)?.get(start) : undefined;
  if (held !== undefined) return held;
  let groupEnd = start + 1;
  let j = start + 1;
  for (; j < end && joins(segment[j]); j++) {
    if (segment[j].type === 'math') continue;
    // Nor pieces of code whose backticks would run together in one span
    if (highlightColorOf(segment[j]) !== color || codeSpansMeet(segment[j - 1], segment[j])) break;
    groupEnd = j + 1;
  }
  if (segment.slice(start, groupEnd).some(item => item.type !== 'text')) {
    return first.revision ? heldGroupEnd(segment, start, groupEnd, end, first.revision) : groupEnd;
  }
  // The run ends at j, unless `end` cut it short, as it does before a piece
  // of code that meets the one before it
  const next = segment[j];
  if (!next || !joins(next) || (next.type !== 'math' && highlightColorOf(next) !== color) || codeSpansMeet(segment[j - 1], next)) {
    grouplessRuns.set(segment, { from: start, to: j });
  }
  return start;
}

/** Per segment, a run of items in which highlightGroupEnd found no group, so
 *  that none starts later in it either, which keeps import linear in a long
 *  highlight of text alone. */
const grouplessRuns = new WeakMap<ContentItem[], { from: number; to: number }>();

/** The text of an item of a highlight group that Markdown keeps as it is,
 *  in code, an equation or a citation's keys, and text's own */
function groupItemSource(item: SubstitutionItem): string {
  return item.type === 'text' ? item.text : item.type === 'math' ? item.latex
    : item.type === 'citation' ? item.pandocKeys.join('; ') : '';
}

/**
 * Where a highlight group from `start`, which nothing else ends before
 * `end` (highlightGroupEnd), ends in the range of runs ending at `rangeEnd`
 * so that the span of its `revision` holds it (see revisionSpanHolds), or
 * `start` where no group does: code, an equation or a citation with the
 * span's closer in its text puts the group on one side of a substitution,
 * which can't hold a ~~}, as a struck } can write, or a ~> on its old side.
 * A span that can't hold the items to `end` whole holds them in groups,
 * each as long as it can hold, found by doubling one and then halving the
 * difference, in time of the items' length times its log, and the text
 * alone of one as no group, whose items go in spans of their own. They're
 * kept, by item, for calls from the items after, so they stay as first
 * found. A struck } last in a group reads as ~~}, but before a letter as
 * <s>}</s>, so a span can hold a group that it can't hold some of: a group
 * after the first may end sooner than it could. An item the span can't
 * hold alone goes alone.
 */
function heldGroupEnd(segment: ContentItem[], start: number, end: number, rangeEnd: number, revision: RevisionInfo): number {
  const closer = revision.type === 'addition' ? '++}' : '--}';
  if (!segment.slice(start, end).some(item => groupItemSource(item as SubstitutionItem).includes(closer))) return end;
  // A group ends after an item that isn't an equation (highlightGroupEnd)
  const ends: number[] = [];
  for (let k = start + 1; k <= end; k++) if (segment[k - 1].type !== 'math') ends.push(k);
  const holds = (from: number, at: number) => revisionSpanHolds(renderHighlightGroup(segment, from, ends[at], rangeEnd, ''), revision);
  if (holds(start, ends.length - 1)) return end;
  let kept = heldGroups.get(segment);
  if (kept?.length !== segment.length) heldGroups.set(segment, kept = { length: segment.length, byEnd: new Map() });
  let groups = kept.byEnd.get(rangeEnd);
  if (!groups) kept.byEnd.set(rangeEnd, groups = new Map());
  const keep = (k: number, groupEnd: number) => { if (!groups.has(k)) groups.set(k, groupEnd); };
  for (let from = start, first = 0; from < end;) {
    while (ends[first] <= from) first++;
    // An equation starts no group
    if (segment[from].type === 'math') {
      keep(from, from++);
      continue;
    }
    let held = first - 1;
    let failed = -1;
    for (let step = 1; failed < 0; step *= 2) {
      const at = Math.min(held + step, ends.length - 1);
      if (!holds(from, at)) failed = at;
      else if (at === ends.length - 1) break;
      else held = at;
    }
    while (failed - held > 1) {
      const mid = (held + failed) >> 1;
      if (holds(from, mid)) held = mid;
      else failed = mid;
    }
    const groupEnd = failed < 0 ? end : ends[Math.max(held, first)];
    if (segment.slice(from, groupEnd).some(item => item.type !== 'text')) keep(from, groupEnd);
    else for (let k = from; k < groupEnd; k++) keep(k, k);
    from = groupEnd;
  }
  return groups.get(start)!;
}

/** Per segment, as long as it was, and range's end, by item, where
 *  heldGroupEnd ends a group from it in items its span can't hold whole */
const heldGroups = new WeakMap<ContentItem[], { length: number; byEnd: Map<number, Map<number, number>> }>();

/** The highlight group from `start` to `end` (highlightGroupEnd) as
 *  Markdown, after `precedingMarkdown`, which ends with the span `last`, in
 *  the range of runs ending at `rangeEnd`, which its text reads up to. */
function renderHighlightGroup(
  segment: ContentItem[], start: number, end: number, rangeEnd: number, precedingMarkdown: string, noteLabels?: Map<string, string>, last?: RevisionSpan,
): string {
  let inner = '';
  // The separator before a citation that opens the group, which goes
  // before the highlight, which would hold it
  let lead = '';
  let mathEnd = -1;
  for (let g = start; g < end; g++) {
    const item = segment[g];
    if (item.type === 'text') {
      inner += textNextToMath(markedFormatting(item.text, { ...item.formatting, highlight: false }, false, runsAfter(segment, g + 1, rangeEnd)), segment, g, end, inner.length === mathEnd, true, inner);
    } else if (item.type === 'footnote_ref') {
      inner += footnoteRefText(item, noteLabels);
    } else if (item.type === 'math') {
      inner += '$' + item.latex + '$';
      mathEnd = inner.length;
    } else if (item.type === 'citation') {
      if (g === start) lead = citationSeparator(precedingMarkdown, item, last);
      inner += (g === start ? '' : citationSeparator(inner, item)) + citationText(item);
    }
  }
  // An = that ends its text would run into the highlight's closing ==, as
  // in ==[^1]a===, which reads as ==[^1]a== and an = without the highlight,
  // so it's a reference, as in a highlight of text alone (see
  // markedFormatting), without the backslash of an escaped =: an odd one of
  // the backslashes before it. They're counted back from the end, as a
  // regex would try them from each backslash before it in turn.
  if (inner.endsWith('=')) {
    let backslashes = 0;
    while (inner[inner.length - 2 - backslashes] === '\\') backslashes++;
    inner = inner.slice(0, inner.length - 1 - backslashes % 2) + '&#61;';
  }
  return lead + wrapHighlight(inner, highlightColorOf(segment[start]));
}

/** `out` with the highlight group from `start` to `end` appended as one span
 *  of its revision, as appendRevised appends an item, and the span it ends
 *  with. A citation first in it is spaced from `precedingMarkdown`. */
function appendHighlightGroup(
  out: string, segment: ContentItem[], start: number, end: number, rangeEnd: number, last: RevisionSpan | undefined,
  noteLabels?: Map<string, string>, precedingMarkdown = out,
): [string, RevisionSpan | undefined] {
  const items = segment.slice(start, end) as InlineRevisionItem[];
  const text = renderHighlightGroup(segment, start, end, rangeEnd, precedingMarkdown, noteLabels, last);
  return appendRevised(out, text, items[0], last, combinedSpanJoin(items));
}

/** How a span of `items` together joins others (see spanJoin): as the most
 *  constrained of them, with the delimiters each has of its own */
function combinedSpanJoin(items: InlineRevisionItem[]): { join: SpanJoin; literal: Set<string> } {
  const joins = items.map(item => spanJoin(item));
  const join: SpanJoin = joins.some(j => j.join === 'never') ? 'never' : joins.some(j => j.join === 'space') ? 'space' : 'seam';
  return { join, literal: new Set(joins.flatMap(j => [...j.literal])) };
}

/** One item of a substitution's side as Markdown, after `precedingText`,
 *  before the rest of its side, `after` (see escapeMarkdownChars), with
 *  its highlight around the rest of its formatting where it joins its
 *  neighbours' (`joinsHighlight`, see joinHighlights), at the start of a
 *  line where an item of the side before it ends one (`lineStart`). */
function substitutionItemText(item: SubstitutionItem, precedingText: string, noteLabels?: Map<string, string>, after?: RunsAfter, joinsHighlight = false, lineStart = false): string {
  const color = highlightColorOf(item);
  if (color && (item.type === 'footnote_ref' || item.type === 'citation')) {
    const text = substitutionItemText({ ...item, formatting: undefined }, precedingText, noteLabels, after);
    // The separator before a citation goes before the highlight
    const lead = item.type === 'citation' && text.startsWith(' ') ? ' ' : '';
    return text.includes('==') ? text : lead + wrapHighlight(text.slice(lead.length), color);
  }
  if (item.type === 'footnote_ref') return footnoteRefText(item, noteLabels);
  if (item.type === 'text') {
    if (!item.href) return escapeAfterHighlight(markedFormatting(item.text, item.formatting, lineStart, after, false, joinsHighlight), precedingText);
    const text = markedFormatting(item.text, item.formatting, false, (after ?? RunsAfter.of('')).linkTo(item.href));
    return markdownLink(text, item.href);
  }
  if (item.type === 'citation') return citationSeparator(precedingText, item) + citationText(item);
  return item.display
    ? MATH_FENCE + '\n' + canonicalizeDisplayMathLatex(item.latex) + '\n' + MATH_FENCE
    : '$' + item.latex + '$';
}

/** A substitution's side, `markdown`, resolved apart (see resolveEmphasis),
 *  but for the mark of the closing == of a highlight it ends with, which
 *  lastVisibleChar reads past to the whitespace the highlight holds, as it
 *  does in the rest of a paragraph, whose resolveEmphasis drops it. Text's
 *  == has no mark. */
function resolveSide(markdown: string): string {
  const resolved = resolveEmphasis(markdown);
  // Its last, or the last before the closes of the formatting around it,
  // as in **==a ==**, which citationSeparator reads past (see textEnd)
  // eslint-disable-next-line no-control-regex
  const close = /[\u0006\u000F](==(?:\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\})?)$/.exec(markdown.slice(0, closesStart(markdown)))?.[1];
  if (!close) return resolved;
  const end = closesStart(resolved);
  return resolved.slice(0, end - close.length) + HIGHLIGHT_CLOSE + resolved.slice(end - close.length);
}

/** Where the closes of emphasis and the tags of formatting at the end of
 *  `markdown` start, marked or not, read back from its end, as a regex
 *  with * and ** in a repeat would try each way to split a run of * */
function closesStart(markdown: string): number {
  let end = markdown.length;
  for (;;) {
    if (markdown[end - 1] === '*' || markdown[end - 1] === EMPHASIS_CLOSE) end--;
    else if (markdown.startsWith('~~', end - 2)) end -= 2;
    else if (/^<\/[usbi]>$/.test(markdown.slice(Math.max(0, end - 4), end))) end -= 4;
    else return end;
  }
}

/** Whether `{~~old~>new~~}` reads back as these sides: CriticMarkup splits at
 *  the first ~> and ends at the first ~~}. */
function substitutionHolds(oldText: string, newText: string): boolean {
  return !oldText.includes('~>') && !(oldText + '~>' + newText).includes('~~}');
}

/** Whether a side's item writes the same Markdown wherever the side
 *  starts before it, after an item that changes none of it (see
 *  readsAlikeBefore), and ends with what resolving reads alike before the
 *  next: text that isn't a link's, highlighted, struck, empty or at a
 *  line's end. One whose closing ~~ may be written as </s> isn't. */
function writesAlike(item: ContentItem): boolean {
  return item.type === 'text' && item.text !== '' && !item.href && !item.formatting.highlight && !item.formatting.strikethrough
    && !endsLine(item.text);
}

/** Whether resolving reads the Markdown before the item at `i` of a side
 *  that starts at `start` alike from each start up to the item: the
 *  side's start, or the end of the item before, which is all of it that
 *  resolving reads, where that one writes alike (see writesAlike) after an
 *  item that leaves its end as it is. An equation, after which a letter is
 *  written as a reference, or a line's end, after which spaces are, would
 *  change all of an item of one letter or of spaces. Empty runs write
 *  nothing, so it looks past them for both. */
function readsAlikeBefore(segment: ContentItem[], start: number, i: number): boolean {
  const empty = (k: number) => segment[k].type === 'text' && (segment[k] as ContentItem & { type: 'text' }).text === '';
  let j = i - 1;
  while (j >= start && empty(j)) j--;
  if (j < start) return true;
  if (!writesAlike(segment[j])) return false;
  let k = j - 1;
  while (k >= start && empty(k)) k--;
  const earlier = k >= start ? segment[k] : undefined;
  return !(earlier?.type === 'math' && !earlier.display) && !(earlier?.type === 'text' && endsLine(earlier.text));
}

/** The item whose Markdown holds the start of the last ~> or ~~} of a
 *  side as resolving writes it (see resolveSide), where `starts` says
 *  where each item starts in `side` before resolving, or -1, as where a
 *  highlight's marks, which resolving rewrites, keep it from telling */
function resolvedCloserItem(side: string, starts: number[]): number {
  const items: number[] = [];
  const positions: number[] = [];
  for (let item = 0; item < starts.length; item++) {
    if (starts[item] === undefined) continue;
    items.push(item);
    positions.push(starts[item]);
  }
  const track = { positions, resolved: [] as number[] };
  const resolved = resolveEmphasis(side, track);
  const at = Math.max(resolved.lastIndexOf('~>'), resolved.lastIndexOf('~~}'));
  if (at === -1 || track.resolved.length !== positions.length) return -1;
  let k = items.length - 1;
  while (k > 0 && track.resolved[k] > at) k--;
  return items[k];
}

/** Render a CriticMarkup substitution `{~~old~>new~~}` when a deletion and
 *  an addition are adjacent with matching author/date. The two can differ in
 *  type, as when export writes a deleted citation as its [@key] text.
 *  Returns the substitution string, or `null` if the pair cannot be rendered
 *  as a substitution (e.g. display math paired with another type). */
function tryRenderSubstitution(
  deletion: SubstitutionItem,
  addition: SubstitutionItem,
  precedingText: string,
  noteLabels?: Map<string, string>,
): string | null {
  const display = (item: SubstitutionItem) => item.type === 'math' && item.display;
  if (deletion.type !== addition.type && (display(deletion) || display(addition))) return null;
  // Each side reads apart, so its emphasis resolves apart, and before the
  // check, as a mark hid the ~> of a struck >a: {~~~~>a~~~>b~~}
  const oldText = resolveSide(substitutionItemText(deletion, precedingText, noteLabels));
  const newText = resolveSide(substitutionItemText(addition, precedingText, noteLabels));
  if (oldText && newText && substitutionHolds(oldText, newText)) {
    return '{~~' + oldText + '~>' + newText + '~~}';
  }
  return null;
}

/** Whether the deletion at `index` and the addition after it are each alone
 *  on their side, with no neighbour from the same revision that a side can
 *  take (`eligible`, as for renderSubstitutionRun). A longer side is
 *  renderSubstitutionRun's; where it declines, as for two equations in a
 *  row, the items keep their own spans rather than pairing at the seam. A
 *  neighbour no side can take, as one in a comment's range, leaves the pair
 *  alone. */
function pairStandsAlone(segment: ContentItem[], index: number, eligible: (item: ContentItem) => boolean): boolean {
  const sameRevision = (item: ContentItem | undefined, neighbour: ContentItem) =>
    !!item && isInlineRevisionItem(item) && isInlineRevisionItem(neighbour) && !!item.revision && revisionsEqual(item.revision, neighbour.revision) && eligible(item);
  return !sameRevision(segment[index - 1], segment[index]) && !sameRevision(segment[index + 2], segment[index + 1]);
}

/**
 * A substitution whose sides span several items, as Word records replacing
 * formatted text or text across a paragraph break: deletions, then additions,
 * all by one author at one time and passing `eligible`. Rendering it as one
 * {~~old~>new~~} keeps a tracked break inside it (see
 * joinTrackedParagraphBreaks). Undefined unless both sides are there and one
 * has more than one item; tryRenderSubstitution renders a single pair.
 */
/** Per segment, a run of deletions from whose start renderSubstitutionRun
 *  found no insertion, which none later in it finds either, which keeps
 *  import linear in a long deletion of runs that don't merge, as links to
 *  one place */
const substitutionlessRuns = new WeakMap<ContentItem[], { from: number; to: number; end: number }>();

function renderSubstitutionRun(
  segment: ContentItem[],
  start: number,
  end: number,
  precedingText: string,
  eligible: (item: ContentItem) => boolean,
  noteLabels?: Map<string, string>,
): { text: string; nextIndex: number } | undefined {
  const first = segment[start];
  const revision = isSubstitutionItem(first) ? first.revision : undefined;
  if (!revision) return undefined;
  const known = substitutionlessRuns.get(segment);
  if (known && known.end === end && known.from < start && start < known.to) return undefined;
  const side = (item: ContentItem | undefined, type: RevisionInfo['type']): item is SubstitutionItem =>
    isSubstitutionItem(item)
    && item.revision?.type === type && item.revision.author === revision.author && item.revision.date === revision.date
    && eligible(item);
  // One side's items, with highlight groups in one highlight, and where
  // each item's or group's Markdown starts in it (`starts`)
  const sideText = (from: number, to: number, starts: number[] = []) => {
    let text = '';
    let mathEnd = -1;
    for (let j = from; j < to;) {
      const item = segment[j] as SubstitutionItem;
      starts[j - from] = text.length;
      // A link of several runs stays one link, as outside a substitution
      const link = item.type === 'text' ? linkGroup(segment, j, to, item.commentIds) : undefined;
      if (link) {
        text += link.text;
        j = link.end;
        continue;
      }
      const highlightEnd = highlightGroupEnd(segment, j, to, item.commentIds);
      if (highlightEnd > j) {
        text += renderHighlightGroup(segment, j, highlightEnd, to, precedingText + text, noteLabels);
        j = highlightEnd;
      } else {
        // After a line break in the side, as the span of one would have it
        const prev = segment[j - 1];
        const lineStart = j > from && prev.type === 'text' && endsLine(prev.text);
        text += textNextToMath(escapeBangBeforeLink(substitutionItemText(item, precedingText + text, noteLabels, runsAfter(segment, j + 1, to),
          joinsHighlight(segment, j, from, to), lineStart), segment, j, to, true), segment, j, to, text.length === mathEnd, true, text);
        if (item.type === 'math' && !item.display) mathEnd = text.length;
        j++;
      }
    }
    return text;
  };
  let k = start;
  while (k < end && side(segment[k], 'deletion')) k++;
  const deletions = k - start;
  // Where no insertion a side can take comes right after the deletions, as
  // where one in a comment's range does, no start in them finds one either
  if (k >= end || !side(segment[k], 'addition')) {
    substitutionlessRuns.set(segment, { from: start, to: k, end });
  }
  while (k < end && side(segment[k], 'addition')) k++;
  const additions = k - start - deletions;
  // Pieces of code a span can't hold whole (see codePiecesInRevision) side
  // by side on one side would run their backticks together, where spans of
  // their own keep them apart. So would they from each later start in the
  // deletions up to the first of the last two on the old side, or in all of
  // them where those are on the new side. Those go in spans too, rather
  // than build sides from each, which would take time in the square of the
  // deletions.
  for (let j = k - 1; additions > 0 && j > start; j--) {
    if (j === start + deletions || !codeSpansMeet(segment[j - 1], segment[j])) continue;
    substitutionlessRuns.set(segment, { from: start, to: Math.min(j, start + deletions), end });
    return undefined;
  }
  if (deletions === 0 || additions === 0 || deletions + additions <= 2) return undefined;
  const starts: number[] = [];
  const oldSide = sideText(start, start + deletions, starts);
  const newSide = sideText(start + deletions, k);
  // Where the sides can't be written, neither can those of a later start
  // in the deletions whose old side still holds what keeps them from it, or
  // of any where that's in the new side. Those starts go in spans too,
  // rather than build sides from each, which would take time in the square
  // of the deletions.
  const declineTo = (to: number) => {
    if (to > start + 1) substitutionlessRuns.set(segment, { from: start, to, end });
    return undefined;
  };
  // Resolved apart, before the check (see tryRenderSubstitution)
  const oldText = resolveSide(oldSide);
  const newText = resolveSide(newSide);
  if (!newText || newText.includes('~~}') || !oldText) return declineTo(start + deletions);
  if (!substitutionHolds(oldText, newText)) {
    // To the item the side's last ~> or ~~} starts in, as written before
    // resolving, which doesn't write one where there was none, or else as
    // resolving writes it, as where a mark it drops kept one apart, as in
    // struck text that starts with >: ~~\u0003>a. That one only where
    // resolving reads the Markdown before it alike from each start up to
    // it (see readsAlikeBefore), as it does the item's delimiters by it.
    const at = Math.max(oldSide.lastIndexOf('~>'), oldSide.lastIndexOf('~~}'));
    let item = starts.length - 1;
    while (item > 0 && (starts[item] === undefined || starts[item] > at)) item--;
    if (at === -1) {
      item = resolvedCloserItem(oldSide, starts);
      if (item !== -1 && !readsAlikeBefore(segment, start, start + item)) item = -1;
    }
    return declineTo(item === -1 ? start : start + item + 1);
  }
  // Two inline equations in a row on one side would run their dollar signs
  // together and read as one, where spans of their own keep them apart. To
  // the first of the last two on the old side.
  for (let j = k - 1; j > start; j--) {
    const [a, b] = [segment[j - 1], segment[j]];
    if (j !== start + deletions && a.type === 'math' && !a.display && b.type === 'math' && !b.display) return declineTo(j > start + deletions ? start + deletions : j);
  }
  return { text: '{~~' + oldText + '~>' + newText + '~~}', nextIndex: k };
}

/** Whether `a` and `b`, side by side, are code formatted alike, in no
 *  link or in one, as the pieces of code a span can't hold whole are (see
 *  codePiecesInRevision), whose backticks would run together with nothing
 *  between them. A line break, which a link keeps apart from a line after
 *  it that would start a block (see mergeConsecutiveRuns), has none. */
function codeSpansMeet(a: ContentItem, b: ContentItem): boolean {
  return a.type === 'text' && b.type === 'text' && a.formatting.code && a.href === b.href && a.link === b.link
    && a.text !== '\\\n' && b.text !== '\\\n' && formattingEquals(a.formatting, b.formatting);
}

/**
 * Whether code and line breaks beside it, one with `formatting` and `text`
 * and the other `next`, read as one run of code: Markdown can't hold code's
 * style on a line break, so export writes the break between the code spans
 * it splits the code at (see markedFormatting) in the rest of the code's
 * formatting, as a highlight, which it shows on the break.
 */
function breaksJoinCode(formatting: RunFormatting, text: string, next: Extract<ContentItem, { type: 'text' }>): boolean {
  const breaks = (t: string) => /^(?:\\\n)+$/.test(t);
  return (formatting.code ? !next.formatting.code && breaks(next.text) : next.formatting.code && breaks(text))
    && formattingEquals({ ...formatting, code: false }, { ...next.formatting, code: false });
}

/** A citation without keys as a run of its text, as export reads it back,
 *  highlighted as it is, which the runs beside it read and join */
function keylessCitationRun(item: ContentItem): ContentItem {
  if (item.type !== 'citation' || item.pandocKeys.length > 0) return item;
  const highlight = item.formatting?.highlight ? { highlight: true, highlightColor: item.formatting.highlightColor } : {};
  return {
    type: 'text',
    text: item.text,
    commentIds: item.commentIds,
    formatting: { ...DEFAULT_FORMATTING, ...highlight },
    ...(item.revision ? { revision: item.revision } : {}),
  };
}

/** Joins runs that read as one, formatted alike, and in Markdown
 *  (`markdown`), code and the line breaks beside it (see breaksJoinCode).
 *  Where export reads Markdown, code in a tracked change that no span of it
 *  can hold goes in runs of its pieces (see codePiecesInRevision), in a
 *  link too, whose text then holds a span of each (see linkGroup). */
function mergeConsecutiveRuns(items: ContentItem[], markdown = readsMarkdown): ContentItem[] {
  const content = items.map(keylessCitationRun);
  const merged: ContentItem[] = [];
  let i = 0;

  while (i < content.length) {
    const item = content[i];
    
    if (item.type !== 'text') {
      merged.push(item);
      i++;
      continue;
    }

    let mergedText = item.text;
    // Code's, where line breaks start the run (see breaksJoinCode)
    let formatting = item.formatting;
    // The merged text's last two characters, which reading from the text,
    // which each merge flattens, would take time in the square of the runs
    let tail = item.text.slice(-2);
    let j = i + 1;
    
    while (j < content.length) {
      const next = content[j];
      if (next.type !== 'text' ||
          !formattingEquals(formatting, next.formatting) && !(markdown && breaksJoinCode(formatting, mergedText, next)) ||
          item.href !== next.href ||
          item.link !== next.link ||
          // A link's line break before a line that would start a block
          // stays its own, where linkGroup splits the link
          (item.href !== undefined && (next.text === '\\\n' && startsBlock(content[j + 1])
            || tail === '\\\n' && startsBlock(next))) ||
          !commentSetsEqual(item.commentIds, next.commentIds) ||
          !revisionsEqual(item.revision, next.revision)) {
        break;
      }
      if (next.formatting.code && !formatting.code) formatting = next.formatting;
      mergedText += next.text;
      tail = next.text.length >= 2 ? next.text.slice(-2) : (tail + next.text).slice(-2);
      j++;
    }

    const pieces = readsMarkdown && item.revision && formatting.code
      ? codePiecesInRevision(mergedText, item.revision) : [mergedText];
    for (const text of pieces) {
      merged.push({
        type: 'text',
        text,
        commentIds: item.commentIds,
        formatting,
        href: item.href,
        ...(item.link !== undefined ? { link: item.link } : {}),
        ...(item.revision ? { revision: item.revision } : {}),
      });
    }
    i = j;
  }

  return merged;
}

function renderInlineSegment(
  segment: ContentItem[],
  comments: Map<string, Comment>,
  renderOpts?: RenderOpts,
  opts?: InlineRangeOpts,
  htmlCell = !!renderOpts?.htmlCells,
): { text: string; deferredComments: string[] } {
  const result = renderInlineRange(joinSplitComments(segment, htmlCell), 0, comments, opts, renderOpts);
  return {
    // A line break at a cell's end is <br>, which a pipe table holds, as a
    // grid table's blank line there pads the cell to its row's height
    text: result.text.replace(HARD_BREAKS_AT_END, (breaks, backslashes: string) =>
      backslashes + '<br>'.repeat((breaks.length - backslashes.length) / 2)),
    deferredComments: result.deferredComments,
  };
}

/** Check whether any position in the segment has more than one active comment. */
function hasOverlappingComments(segment: ContentItem[]): boolean {
  const allIds = new Set<string>();
  for (const item of segment) {
    if ((item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') && item.commentIds) {
      for (const id of item.commentIds) allIds.add(id);
    }
  }
  if (allIds.size <= 1) return false;

  // Two or more comment IDs exist — check if their ranges actually overlap
  // by seeing if any single run is covered by 2+ comments
  for (const item of segment) {
    if ((item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') && item.commentIds) {
      if (item.commentIds.size > 1) return true;
    }
  }

  // Even if no single run has 2+, overlapping can occur if comment ranges
  // interleave across runs. Check via boundary analysis.
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  let pos = 0;
  let prevIds = new Set<string>();
  for (const item of segment) {
    if (item.type !== 'text' && item.type !== 'citation' && item.type !== 'footnote_ref' && item.type !== 'math' && item.type !== 'html_comment' && item.type !== 'image') { pos++; continue; }
    if (!item.commentIds) { pos++; continue; }
    const ids = item.commentIds;
    for (const id of ids) {
      if (!prevIds.has(id)) starts.set(id, Math.min(starts.get(id) ?? pos, pos));
    }
    for (const id of prevIds) {
      if (!ids.has(id)) ends.set(id, Math.max(ends.get(id) ?? pos, pos));
    }
    prevIds = ids;
    pos++;
  }
  for (const id of prevIds) {
    if (!ends.has(id)) {
      ends.set(id, pos);
    }
  }

  // Check if any pair of comment ranges overlaps
  const ranges = [...allIds].map(id => ({ id, start: starts.get(id) ?? 0, end: ends.get(id) ?? 0 }));
  for (let a = 0; a < ranges.length; a++) {
    for (let b = a + 1; b < ranges.length; b++) {
      if (ranges[a].start < ranges[b].end && ranges[b].start < ranges[a].end) {
        return true;
      }
    }
  }
  return false;
}

function formatDateSuffix(date: string | undefined, timezone?: string): string {
  if (!date) return '';
  try {
    return ` (${formatLocalIsoMinute(date, timezone)})`;
  } catch { return ` (${date})`; }
}

function formatCommentAttribution(author: string | undefined, date: string | undefined, text: string, timezone?: string): string {
  const trimmedAuthor = (author || '').trim();
  if (!trimmedAuthor) return text;
  return '@' + trimmedAuthor + formatDateSuffix(date, timezone) + ' | ' + text;
}

function formatCommentBody(_cid: string, c: Comment, timezone?: string): string {
  if (c.consecutiveReplies && c.replies && c.replies.length > 0) {
    // Consecutive format: each reply is a separate {>>...<<} block
    let body = `{>>${formatCommentAttribution(c.author, c.date, c.text, timezone)}<<}`;
    for (const reply of c.replies) {
      body += `{>>${formatCommentAttribution(reply.author, reply.date, reply.text, timezone)}<<}`;
    }
    return body;
  }
  let body = `{>>${formatCommentAttribution(c.author, c.date, c.text, timezone)}`;
  if (c.replies && c.replies.length > 0) {
    for (const reply of c.replies) {
      body += `\n  {>>${formatCommentAttribution(reply.author, reply.date, reply.text, timezone)}<<}`;
    }
    body += '\n<<}';
  } else {
    body += '<<}';
  }
  return body;
}

function formatCommentBodyWithId(cid: string, c: Comment, timezone?: string): string {
  if (c.consecutiveReplies && c.replies && c.replies.length > 0) {
    // Consecutive format: each reply is a separate {>>...<<} block
    let body = `{#${cid}>>${formatCommentAttribution(c.author, c.date, c.text, timezone)}<<}`;
    for (const reply of c.replies) {
      body += `{>>${formatCommentAttribution(reply.author, reply.date, reply.text, timezone)}<<}`;
    }
    return body;
  }
  let body = `{#${cid}>>${formatCommentAttribution(c.author, c.date, c.text, timezone)}`;
  if (c.replies && c.replies.length > 0) {
    for (const reply of c.replies) {
      body += `\n  {>>${formatCommentAttribution(reply.author, reply.date, reply.text, timezone)}<<}`;
    }
    body += '\n<<}';
  } else {
    body += '<<}';
  }
  return body;
}

/** Where an inline range stops, whether its paragraph is in a quote or
 *  list, where export reads a revision's span starting with a heading's
 *  marker as text (see escapeMarkdownChars), as it doesn't at the top level,
 *  whether it's a heading, whose text is inline, and whether it's a pipe or
 *  grid table's cell, whose text is inline too */
type InlineRangeOpts = { stopBeforeDisplayMath?: boolean; nested?: boolean; heading?: boolean; cell?: boolean };

/** A segment's runs from the start of a paragraph to `end` as text, by
 *  `end`: their text, with anything else as a character that is no syntax,
 *  but an equation in its dollar signs, which can close math before it,
 *  with an == where its LaTeX has one (see indexedText). One
 *  serves each run's runsAfter, which would take time in the square of the
 *  runs each to build its own, and each starts at its paragraph, where one
 *  from the segment's start took time in the square of the paragraphs, or
 *  after a display equation the paragraph goes on in, where one from the
 *  paragraph's start took time in the square of its equations. */
const runsTextIndexes = new WeakMap<ContentItem[], Map<number, { length: number; first: number; offsets: number[]; index: TextIndex; items: ContentItem[] }>>();

/** The runs of a segment from `start` to `end`, as escapeMarkdownChars
 *  reads the runs after a run */
function runsAfter(segment: ContentItem[], start: number, end: number): RunsAfter {
  let byEnd = runsTextIndexes.get(segment);
  if (!byEnd) runsTextIndexes.set(segment, byEnd = new Map());
  let cached = byEnd.get(end);
  if (!cached || cached.length !== segment.length || start < cached.first) {
    // From the paragraph's start, or the display equation before, which
    // ends an inline range, where the runs before `start` in it can read
    // from too. An index reads the same from any run on, as no run of
    // dollar signs crosses one and the rest it reads from the right.
    let first = Math.min(start, end);
    while (first > 0 && !endsInlineRange(segment[first - 1]) && !isInParagraphMath(segment[first - 1])) first--;
    const offsets: number[] = [];
    const bracketed: number[] = [];
    // Where each comment's text starts and ends
    const comments: number[] = [];
    let text = '';
    for (let k = first; k < end; k++) {
      offsets.push(text.length);
      const item = segment[k];
      if (item.type === 'footnote_ref' || item.type === 'citation') bracketed.push(text.length);
      text += indexedText(item);
      if (item.type === 'html_comment') comments.push(offsets[offsets.length - 1], text.length);
    }
    offsets.push(text.length);
    const marks = laterEqualsAfter.get(segment);
    let laterEquals = -1;
    for (let k = first; k < end; k++) if (marks?.has(k)) laterEquals = offsets[k + 1 - first];
    byEnd.set(end, cached = { length: segment.length, first, offsets, index: indexText(text, new Set(offsets), bracketed, laterEquals, comments), items: segment.slice(first, end) });
  }
  return new RunsAfter(cached.index, cached.offsets[start - cached.first], '', false,
    { offsets: cached.offsets, items: cached.items, at: start - cached.first });
}

/** An item's text as an index of the runs reads it (see runsTextIndexes) */
function indexedText(item: ContentItem): string {
  if (item.type === 'math') {
    // An == in its LaTeX, which Markdown has as it is, and which an ==
    // before the equation pairs with, as export reads a highlight past math
    const latex = item.latex.includes('==') ? '==' : '\uFFFC';
    return item.display ? '$' + '$' + latex + '$' + '$' : '$' + latex + '$';
  }
  // An HTML comment's text, which export reads math, a highlight, code and
  // a citation's key across, as in $<!-- x$ -->, though not emphasis, nor
  // a link's text (see TextIndex.linkClosers)
  if (item.type === 'html_comment') return item.text;
  if (item.type !== 'text') return '\uFFFC';
  // A link's text in its brackets, whose ] closes a citation before it
  // and whose URL's $ closes math, even where it's written as its URL
  // alone, which resolveBareLinks decides from the Markdown after this;
  // its text's own brackets, which it escapes, close nothing
  const run = !item.href ? item.text
    : '[' + item.text.replace(/[[\]]/g, '\uFFFC') + '](' + formatHrefForMarkdown(item.href) + ')';
  // A highlight's ==, which an == before it can pair with
  return item.formatting.highlight ? '==' + run + '==' : run;
}

/** Per segment, the indexes of the items an == that isn't in the runs'
 *  text goes after in their Markdown block, which renderInlineRange marks
 *  before it writes their runs: export reads a highlight from an == to the
 *  next, which can be in a comment's body, as it reads the body's {>> as no
 *  syntax there, or past a display equation the paragraph goes on in */
const laterEqualsAfter = new WeakMap<ContentItem[], Set<number>>();

/** Marks item `k` of a segment as one an == goes after (see laterEqualsAfter) */
function markLaterEquals(segment: ContentItem[], k: number): void {
  let marks = laterEqualsAfter.get(segment);
  if (!marks) laterEqualsAfter.set(segment, marks = new Set());
  marks.add(k);
}

/** Per comment, whether its body has == in it, read once for all the
 *  paragraphs of its range, which keeps import linear in a long body over
 *  many */
const bodyHasEquals = new WeakMap<Comment, boolean>();

/** Whether comment `id`'s body has == in it, read once (see bodyHasEquals) */
function commentBodyHasEquals(id: string, comments: Map<string, Comment>): boolean {
  const comment = comments.get(id);
  if (!comment) return false;
  let has = bodyHasEquals.get(comment);
  if (has === undefined) bodyHasEquals.set(comment, has = formatCommentBody(id, comment).includes('=='));
  return has;
}

/** Marks the items of a segment from `start` to `end` that the bodies of
 *  their comments with == in them go after: the last of each range, or,
 *  where ID syntax puts the bodies after the text (`deferred`), the last of
 *  all, wherever the ranges end */
function markBodyEquals(segment: ContentItem[], start: number, end: number, comments: Map<string, Comment>, deferred: boolean): void {
  for (let k = start; k < end; k++) {
    const item = segment[k];
    const next = segment[k + 1];
    for (const id of 'commentIds' in item ? item.commentIds ?? [] : []) {
      if (k + 1 < end && 'commentIds' in next && next.commentIds?.has(id)) continue;
      if (commentBodyHasEquals(id, comments)) markLaterEquals(segment, deferred ? end - 1 : k);
    }
  }
}

/** Per segment, by each display equation its paragraph goes on in, whether
 *  an == comes from it to the paragraph's end, read once for all of a
 *  paragraph's equations, which keeps import linear in many */
const equalsFromMath = new WeakMap<ContentItem[], { length: number; byEquation: Map<number, boolean> }>();

/** Marks the last of a segment's runs from `start` to `end` where an ==
 *  comes after them in their paragraph from the display equation at `end`,
 *  which the paragraph goes on in: in its LaTeX or the runs after it, or in
 *  the body of a comment on any of them, which goes after the equation,
 *  wherever the range ends. Export reads the runs, the equation's lines and
 *  the runs after them as one paragraph, but for a heading's, whose line
 *  ends its text. */
function markEqualsPastMath(segment: ContentItem[], start: number, end: number, comments: Map<string, Comment>, heading: boolean): void {
  if (heading || end <= start || !isInParagraphMath(segment[end])) return;
  let cached = equalsFromMath.get(segment);
  if (!cached || cached.length !== segment.length) equalsFromMath.set(segment, cached = { length: segment.length, byEquation: new Map() });
  if (!cached.byEquation.has(end)) {
    let text = '';
    // The last item with a comment whose body has == in it
    let body = -1;
    const equations: Array<{ k: number; offset: number }> = [];
    for (let k = end; k < segment.length && !endsInlineRange(segment[k]); k++) {
      const item = segment[k];
      if (isInParagraphMath(item)) equations.push({ k, offset: text.length });
      text += indexedText(item);
      for (const id of 'commentIds' in item ? item.commentIds ?? [] : []) if (commentBodyHasEquals(id, comments)) body = k;
    }
    const last = text.lastIndexOf('==');
    for (const { k, offset } of equations) cached.byEquation.set(k, last >= offset || body >= k);
  }
  if (cached.byEquation.get(end)) markLaterEquals(segment, end - 1);
}

/** Whether an inline range stops before `item`, as at a paragraph's end */
function endsInlineRange(item: ContentItem): boolean {
  return item.type === 'para' || item.type === 'table' || item.type === 'landscape_open' || item.type === 'landscape_close' || item.type === 'portrait_open' || item.type === 'portrait_close' || item.type === 'bibliography_marker' || item.type === 'custom_style_open' || item.type === 'custom_style_close';
}

function computeSegmentEnd(
  segment: ContentItem[],
  startIndex: number,
  opts?: InlineRangeOpts
): number {
  let idx = startIndex;
  while (idx < segment.length) {
    const item = segment[idx];
    if (endsInlineRange(item)) break;
    if (opts?.stopBeforeDisplayMath && item.type === 'math' && item.display) break;
    idx++;
  }
  return idx;
}

const NO_COMMENTS: ReadonlySet<string> = new Set();

/**
 * Bold or italic text from `start` with inline equations in it, all in the
 * comments `commentIds`, as one run of emphasis around the lot, so that
 * **Ex. 1: $y = Y$ and $k = 1$** stays one bold run. Undefined where the run
 * has no equation.
 */
function emphasisGroup(
  segment: ContentItem[], start: number, end: number, commentIds: ReadonlySet<string>,
): { text: string; end: number } | undefined {
  const first = segment[start];
  if (first.type !== 'text' || !(first.formatting.bold || first.formatting.italic) || first.revision || first.href
      || first.text === '\\\n' || !commentSetsEqual(first.commentIds, commentIds)) return undefined;
  let groupEnd = start + 1;
  for (; groupEnd < end; groupEnd++) {
    const next = segment[groupEnd];
    const joins = next.type === 'math'
      ? !next.display && !next.revision && commentSetsEqual(next.commentIds ?? NO_COMMENTS, commentIds)
      : next.type === 'text' && !next.revision && !next.href && commentSetsEqual(next.commentIds, commentIds)
        && next.formatting.bold === first.formatting.bold && next.formatting.italic === first.formatting.italic
        && next.text !== '\\\n';
    if (!joins) break;
  }
  if (!segment.slice(start, groupEnd).some(item => item.type === 'math')) return undefined;
  let text = '';
  let mathEnd = -1;
  for (let g = start; g < groupEnd; g++) {
    const item = segment[g];
    if (item.type === 'math') {
      text += '$' + item.latex + '$';
      mathEnd = text.length;
    } else if (item.type === 'text') {
      // Inner formatting per item, all but the bold or italic around the group
      text += textNextToMath(markedFormatting(item.text, { ...item.formatting, bold: false, italic: false }, false, runsAfter(segment, g + 1, end)), segment, g, groupEnd, text.length === mathEnd, true, text);
    }
  }
  if (first.formatting.italic) text = wrapEmphasis(text, '*', !first.formatting.bold);
  if (first.formatting.bold) text = wrapEmphasis(text, '**');
  return { text, end: groupEnd };
}

/** The start of a line that would start a block within a paragraph: a
 *  heading, list item, quote, code fence, HTML, display math or a table's
 *  row. Not a note's definition, as the [ of [^1] is escaped, nor a tag of
 *  formatting, which starts no block, as <s>b </s> (see wrapStrikethrough). */
const BLOCK_START_RE = /^[ \t]{0,3}(?:#{1,6}(?:[ \t]|$)|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|```|~~~|<(?!\/?(?:u|s|sup|sub|b|i)>)|\$\$|\|)/;

/** Whether a line of Markdown would start a block within a paragraph
 *  (BLOCK_START_RE), or a LaTeX environment, which export reads as display
 *  math (see wrapBareLatexEnvironments). None does in an HTML table's cell,
 *  which export reads as HTML, whose tags start a run's. */
function startsBlockLine(markdown: string): boolean {
  if (!readsMarkdown) return false;
  const environment = /^ {0,3}\\begin\{([a-zA-Z*]+)\}/.exec(markdown);
  return BLOCK_START_RE.test(markdown) || !!environment && DISPLAY_MATH_ENVIRONMENTS.has(environment[1]);
}

const startsBlock = (item: ContentItem | undefined): boolean =>
  item?.type === 'text' && startsBlockLine(wrapWithFormatting(item.text, item.formatting));

/**
 * A Word hyperlink's runs from `start`, its text and line breaks, all in the
 * comments `commentIds`, as one Markdown link around them, but not the next
 * hyperlink's, though it goes to the same place, so [a **b** c](u)
 * and a link with a line break in it stay one link. A revision of the whole
 * link goes around it, from `item`'s, and one of part of it inside it, as
 * a deletion at its end does where its insertion comes after the link,
 * which Word keeps out of the hyperlink, and each run's of one of all of it
 * where no span around it holds its text.
 * Its emphasis is left marked, for the range's resolveEmphasis, which reads
 * the runs around the link too. Undefined where the link is one run.
 */
function linkGroup(
  segment: ContentItem[], start: number, end: number, commentIds: ReadonlySet<string>,
): { text: string; end: number; item: InlineRevisionItem; join: { join: SpanJoin; literal: Set<string> } } | undefined {
  const first = segment[start];
  if (first.type !== 'text' || !first.href || !commentSetsEqual(first.commentIds, commentIds)) return undefined;
  const inLink = (i: number): ContentItem & { type: 'text' } | undefined => {
    const item = segment[i];
    return i < end && item.type === 'text' && item.href === first.href && item.link === first.link
      && commentSetsEqual(item.commentIds, commentIds) ? item : undefined;
  };
  const items: Array<ContentItem & { type: 'text' }> = [];
  for (let next = first; next; next = inLink(start + items.length)!) {
    items.push(next);
    if (next.text === '\\\n') {
      // A line of the link that would start a block, which Markdown reads
      // before the link, starts a link of its own after the break, which
      // ends this one, so the line starts with its ](url)
      let line = '';
      for (let i = start + items.length, item = inLink(i); item && item.text !== '\\\n'; item = inLink(++i)) {
        line += wrapWithFormatting(item.text, item.formatting);
      }
      if (startsBlockLine(line)) break;
    }
    // A tag a run leaves open, which the runs after could close, as bold
    // <span a=" before ">, would read as HTML across the formatting's
    // delimiters between them in one link's text, so the link ends after
    // it, where its spans of a change, kept apart by the tag's delimiters
    // (see spanJoin), come between them
    if (OPEN_TAG_AT_END_RE.test(next.text)) break;
  }
  if (items.length < 2) return undefined;
  const href = first.href;
  // The item at k as Markdown in the link's text, which reads the runs
  // `after` it as the rest of the text before the link's ](url), as a link
  // of one run does. A line break goes in the formatting Word shows on it
  // (see showsOnBreak), as outside a link.
  const itemText = (k: number, after: RunsAfter): string => items[k].text === '\\\n' && !showsOnBreak(items[k].formatting) ? lineBreakText()
    : markedFormatting(items[k].text, items[k].formatting, false, after.linkTo(href));
  // A revision of the whole link goes around it, but where its span would
  // end at its closer in the link's code, and a substitution with nothing
  // on its other side can't hold the link either, as one whose old side
  // has a ~>, each run's goes inside the link, as for one of part of it.
  // So does it where pieces of code meet, whose backticks would run
  // together in one span.
  if (items.every((item, k) => revisionsEqual(item.revision, first.revision) && (k === 0 || !codeSpansMeet(items[k - 1], item)))) {
    let markdown = '';
    for (let k = 0; k < items.length; k++) markdown += itemText(k, runsAfter(segment, start + k + 1, end));
    const link = markdownLink(markdown, href);
    if (!first.revision || revisionSpanHolds(link, first.revision)) {
      // How a span of the whole link joins others, by each of its runs
      return { text: link, end: start + items.length, item: first, join: combinedSpanJoin(items) };
    }
  }
  let text = '';
  let span: RevisionSpan | undefined;
  // Where the deletions end that a substitution was tried from, which the
  // rest of them aren't tried from again, which would take time in the
  // square of them, but for the later starts that could hold where one
  // doesn't
  let triedUntil = 0;
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    // Deletions and then insertions of one author and time, a substitution
    // of its sides, each whole, as renderSubstitutionRun writes one
    const revision = item.revision;
    if (revision?.type === 'deletion' && k >= triedUntil) {
      const side = (j: number, type: RevisionInfo['type']) => j < items.length && items[j].revision?.type === type
        && items[j].revision!.author === revision.author && items[j].revision!.date === revision.date;
      let additions = k;
      while (side(additions, 'deletion')) additions++;
      let sideEnd = additions;
      while (side(sideEnd, 'addition')) sideEnd++;
      triedUntil = additions;
      // Pieces of code a span can't hold whole (see codePiecesInRevision)
      // side by side on one side would run their backticks together, as in
      // renderSubstitutionRun, so the starts up to the first of the last two
      // on the old side, or all of them where those are on the new side,
      // aren't tried, rather than build sides from each
      let meet = sideEnd > additions ? sideEnd - 1 : k;
      while (meet > k && (meet === additions || !codeSpansMeet(items[meet - 1], items[meet]))) meet--;
      if (meet > k) triedUntil = Math.min(meet, additions);
      // Each side reads apart, its runs after each of its runs alone, and
      // resolves apart (see tryRenderSubstitution), and where each of its
      // runs starts in it before resolving (`starts`)
      const sideMarkdown = (from: number, to: number, starts: number[] = []) => {
        const sideItems = items.slice(from, to);
        let markdown = '';
        for (let j = from; j < to; j++) {
          starts.push(markdown.length);
          markdown += itemText(j, runsAfter(sideItems, j - from + 1, sideItems.length));
        }
        return markdown;
      };
      const starts: number[] = [];
      const oldSide = sideEnd > additions && meet === k ? sideMarkdown(k, additions, starts) : '';
      const oldText = resolveEmphasis(oldSide);
      const newText = oldText ? resolveEmphasis(sideMarkdown(additions, sideEnd)) : '';
      if (oldText && newText && substitutionHolds(oldText, newText)) {
        text += '{~~' + oldText + '~>' + newText + '~~}';
        span = undefined;
        k = sideEnd - 1;
        continue;
      }
      // As renderSubstitutionRun's callers do, from a later start, where the
      // insertions' side has no ~~}: past the run the deletions' side's last
      // ~> or ~~} starts in, as written before resolving, which every start
      // before holds, as dropping a run leaves the rest of the side as it
      // was, as renderSubstitutionRun declines them, rather than build the
      // side again from each. Where resolving wrote it, as of a struck >a,
      // past the run it starts in as resolving writes it, where the run
      // before ends alike from each start, as all but struck text does,
      // whose closing ~~ may be written as </s>, as a link's runs are
      // written alike after any. Or else after a deletion of strikethrough
      // or a ~, as the ~> or ~~} of the side, as a struck }'s, starts with
      // a ~.
      if (oldText && newText && !newText.includes('~~}')) {
        const at = Math.max(oldSide.lastIndexOf('~>'), oldSide.lastIndexOf('~~}'));
        let retry = k + 1;
        const resolvedRun = at === -1 ? resolvedCloserItem(oldSide, starts) : -1;
        if (at !== -1) {
          let run = starts.length - 1;
          while (run > 0 && starts[run] > at) run--;
          retry = k + run + 1;
        } else if (resolvedRun !== -1 && (resolvedRun === 0
            || !items[k + resolvedRun - 1].formatting.strikethrough && items[k + resolvedRun - 1].text !== '')) {
          retry = k + resolvedRun + 1;
        } else {
          while (retry < additions && !items[retry - 1].formatting.strikethrough && !items[retry - 1].text.includes('~')) retry++;
        }
        triedUntil = retry;
      }
    }
    [text, span] = appendRevised(text, itemText(k, runsAfter(segment, start + k + 1, end)), item, span);
  }
  return {
    text: markdownLink(joinRevisedSpans(text), href),
    end: start + items.length,
    item: { ...first, revision: undefined },
    join: combinedSpanJoin(items),
  };
}

/** A tag that the text leaves open at its end, whose quoted values, the
 *  last's unclosed, can hold a < or > */
const OPEN_TAG_AT_END_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*(?:"[^"]*|'[^']*)?)?$/;

/** Whether a link of several runs starts at `start` with tracked changes in
 *  part of it, which linkGroup writes inside its text */
function partlyRevisedLinkAt(segment: ContentItem[], start: number, end: number, commentIds: ReadonlySet<string>): boolean {
  const link = linkGroup(segment, start, end, commentIds);
  return !!link && !link.item.revision;
}

function renderInlineRange(
  segment: ContentItem[],
  startIndex: number,
  comments: Map<string, Comment>,
  opts?: InlineRangeOpts,
  renderOpts?: RenderOpts
): { text: string; nextIndex: number; deferredComments: string[] } {
  let out = '';
  // Where the Markdown ends with an inline equation's closing $, which text
  // after it mustn't run into (textNextToMath)
  let mathEnd = -1;
  let i = startIndex;

  // Determine if we should use ID-based syntax for this inline segment only
  const segmentEnd = computeSegmentEnd(segment, startIndex, opts);
  const forceIdCommentIds = renderOpts?.forceIdCommentIds;
  const hasForcedIdCommentInSegment = !!forceIdCommentIds && [...segment.slice(startIndex, segmentEnd)].some(item => (
    (item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') &&
    item.commentIds && [...item.commentIds].some(id => forceIdCommentIds.has(id))
  ));
  const useIds = renderOpts?.alwaysUseCommentIds || hasForcedIdCommentInSegment || hasOverlappingComments(segment.slice(startIndex, segmentEnd));
  // Where the bodies go, whose == an == in the runs before them pairs with,
  // as it does with one past a display equation the paragraph goes on in
  markBodyEquals(segment, startIndex, segmentEnd, comments, !!useIds);
  markEqualsPastMath(segment, startIndex, segmentEnd, comments, !!opts?.heading);

  if (useIds) {
    return renderInlineRangeWithIds(segment, startIndex, comments, opts, renderOpts?.commentIdRemap, renderOpts?.emittedIdCommentBodies, renderOpts?.noteLabels, renderOpts?.imageFormatMapping, renderOpts?.timezone, renderOpts?.openIdComments, renderOpts?.lastCommentItem);
  }
  let lastSpan: RevisionSpan | undefined;

  while (i < segment.length) {
    const item = segment[i];
    if (i >= segmentEnd) break;

    // Detect substitution: a deletion followed immediately by an addition
    // with identical author and date. Skip if either item has comments to
    // avoid unbalancing comment markers, or starts a link with changes in
    // part of it, which keeps them.
    if (isSubstitutionItem(item) && item.revision?.type === 'deletion' && item.commentIds.size === 0
        && !partlyRevisedLinkAt(segment, i, segmentEnd, NO_COMMENTS)) {
      const eligible = (candidate: ContentItem) => candidate.type !== 'para' && 'commentIds' in candidate && candidate.commentIds.size === 0;
      const run = renderSubstitutionRun(segment, i, segmentEnd, out, eligible, renderOpts?.noteLabels);
      if (run) {
        out += run.text;
        i = run.nextIndex;
        continue;
      }
      const next = segment[i + 1];
      if (isSubstitutionItem(next) &&
          next.revision?.type === 'addition' &&
          next.revision.author === item.revision.author &&
          next.revision.date === item.revision.date &&
          next.commentIds.size === 0 &&
          pairStandsAlone(segment, i, eligible)) {

        const result = tryRenderSubstitution(item, next, out, renderOpts?.noteLabels);
        if (result !== null) {
          out += result;
          i += 2;
          continue;
        }
      }
    }

    const highlightEnd = highlightGroupEnd(segment, i, segmentEnd, new Set());
    if (highlightEnd > i) {
      [out, lastSpan] = appendHighlightGroup(out, segment, i, highlightEnd, segmentEnd, lastSpan, renderOpts?.noteLabels);
      i = highlightEnd;
      continue;
    }

    // A citation in a comment's range goes in its anchor, below
    if (item.type === 'citation' && item.commentIds.size === 0) {
      const citeText = citationSeparator(out, item, lastSpan) + citationText(item);
      [out, lastSpan] = appendRevised(out, citeText, item, lastSpan);
      i++;
      continue;
    }

    // Inline math in a comment's range goes in its anchor, below
    if (item.type === 'math' && (item.display || !item.commentIds?.size)) {
      // Check if this inline math is between bold/italic text items that share
      // formatting. If so, the caller (text rendering below) already handled it
      // as part of a formatting group. If not, emit standalone.
      const mathText = item.display ? MATH_FENCE + '\n' + item.latex + '\n' + MATH_FENCE : '$' + item.latex + '$';
      if (item.display) out += wrapWithRevision(mathText, item.revision);
      else {
        [out, lastSpan] = appendRevised(out, mathText, item, lastSpan);
        if (!item.revision) mathEnd = out.length;
      }
      i++;
      continue;
    }

    if (item.type === 'footnote_ref' && item.commentIds.size === 0) {
      [out, lastSpan] = appendRevised(out, footnoteRefText(item, renderOpts?.noteLabels), item, lastSpan);
      i++;
      continue;
    }

    // An image in a comment's range goes in its anchor, below
    if (item.type === 'image' && item.commentIds.size === 0) {
      [out, lastSpan] = appendRevised(out, imageMarkdown(item, renderOpts?.imageFormatMapping), item, lastSpan);
      i++;
      continue;
    }

    // html_comment: emit the raw <!-- ... --> syntax directly
    if (item.type === 'html_comment') {
      out += markdownComment(item.text, segment[i + 1]?.type === 'html_comment', opts?.cell);
      if (item.commentIds.size > 0) {
        for (const cid of [...item.commentIds].sort()) {
          const c = comments.get(cid);
          if (!c) { continue; }
          out += syntaxText(formatCommentBody(cid, c, renderOpts?.timezone));
        }
      }
      i++;
      continue;
    }

    if (item.type !== 'text' && item.type !== 'footnote_ref' && item.type !== 'citation' && item.type !== 'math' && item.type !== 'image') {
      i++;
      continue;
    }

    // A note reference, citation, equation or image gets here only in a
    // comment's range
    if (item.type !== 'text' || item.commentIds.size > 0) {
      const commentSet = item.commentIds;
      let anchorText = '';
      let anchorMathEnd = -1;
      let anchorSpan: RevisionSpan | undefined;
      let j = i;
      // The space import adds before a citation that opens the range goes
      // before the range, which Word's doesn't cover
      const lead = item.type === 'citation' ? citationSeparator(out, item, lastSpan) : '';

      while (j < segment.length) {
        const seg = segment[j];
        const highlightEnd = highlightGroupEnd(segment, j, segmentEnd, commentSet);
        if (highlightEnd > j) {
          [anchorText, anchorSpan] = appendHighlightGroup(anchorText, segment, j, highlightEnd, segmentEnd, anchorSpan, renderOpts?.noteLabels, anchorText || out + lead);
          j = highlightEnd;
          continue;
        }
        if ((seg.type !== 'text' && seg.type !== 'footnote_ref' && seg.type !== 'citation' && seg.type !== 'image'
            && !(seg.type === 'math' && !seg.display)) || !commentSetsEqual(seg.commentIds ?? new Set(), commentSet)) {
          break;
        }
        if (seg.type === 'image') {
          [anchorText, anchorSpan] = appendRevised(anchorText, imageMarkdown(seg, renderOpts?.imageFormatMapping), seg, anchorSpan);
          j++;
          continue;
        }
        if (seg.type === 'math') {
          [anchorText, anchorSpan] = appendRevised(anchorText, '$' + seg.latex + '$', seg, anchorSpan);
          if (!seg.revision) anchorMathEnd = anchorText.length;
          j++;
          continue;
        }
        const link = linkGroup(segment, j, segmentEnd, commentSet);
        if (link) {
          [anchorText, anchorSpan] = appendRevised(anchorText, link.text, link.item, anchorSpan, link.join);
          j = link.end;
          continue;
        }
        const group = emphasisGroup(segment, j, segmentEnd, commentSet);
        if (group) {
          [anchorText, anchorSpan] = appendRevised(anchorText, group.text, seg, anchorSpan);
          j = group.end;
          continue;
        }
        if (seg.type === 'citation') {
          const citeText = citationSeparator(anchorText || out + lead, seg, anchorSpan) + citationText(seg);
          [anchorText, anchorSpan] = appendRevised(anchorText, citeText, seg, anchorSpan);
          j++;
          continue;
        }
        if (seg.type === 'footnote_ref') {
          [anchorText, anchorSpan] = appendRevised(anchorText, footnoteRefText(seg, renderOpts?.noteLabels), seg, anchorSpan);
          j++;
          continue;
        }
        // IMPORTANT: Do NOT suppress highlights here. The outer {==...==} is CriticMarkup
        // comment syntax, while ==text== is color-highlight syntax. They are semantically
        // distinct: Word text that is both highlighted AND commented needs both layers,
        // producing {====text====} (highlight nested inside comment delimiters).
        const after = runsAfter(segment, j + 1, segmentEnd);
        let segText = textNextToMath(escapeBangBeforeLink(escapeAfterHighlight(markedFormatting(seg.text, seg.formatting, false, seg.href ? after.linkTo(seg.href) : after,
          false, joinsHighlight(segment, j, startIndex, segmentEnd)), anchorText, inSpanBefore(anchorText, seg, anchorSpan)), segment, j, segmentEnd), segment, j, segmentEnd, anchorText.length === anchorMathEnd, false, anchorText);
        if (seg.href) {
          segText = bareLinkChoice(seg, markdownLink(segText, seg.href), '==}');
        }
        [anchorText, anchorSpan] = appendRevised(anchorText, segText, seg, anchorSpan);
        j++;
      }

      if (anchorText) {
        out += lead + `{==${anchorText}==}`;
      }
      for (const cid of [...commentSet].sort()) {
        const c = comments.get(cid);
        if (!c) { continue; }
        out += syntaxText(formatCommentBody(cid, c, renderOpts?.timezone));
      }

      i = j;
      continue;
    }

    const link = linkGroup(segment, i, segmentEnd, NO_COMMENTS);
    if (link) {
      [out, lastSpan] = appendRevised(out, link.text, link.item, lastSpan, link.join);
      i = link.end;
      continue;
    }

    // Hard line breaks must not be wrapped in emphasis (e.g. **\\\n**),
    // whose closer after a line's start doesn't close it. A tracked change's
    // delimiters can, as {--\\\n--}, and the formatting Word shows on a
    // break, a highlight, an underline or a strikethrough, as ==\\\n==
    // (see showsOnBreak), and a link's brackets.
    if (item.text === '\\\n' && !showsOnBreak(item.formatting)) {
      [out, lastSpan] = appendRevised(out, lineBreakRun(item), item, lastSpan);
      i++;
      continue;
    }

    // Bold or italic text with equations in it keeps one run of emphasis
    const group = emphasisGroup(segment, i, segmentEnd, NO_COMMENTS);
    if (group) {
      out += group.text;
      i = group.end;
      continue;
    }

    if (item.href) {
      // Math can close past the link's text, in its URL or the runs after
      const formattedText = markedFormatting(item.text, item.formatting, false, runsAfter(segment, i + 1, segmentEnd).linkTo(item.href));
      [out, lastSpan] = appendRevised(out, bareLinkChoice(item, markdownLink(formattedText, item.href)), item, lastSpan);
    } else {
      // Markdown ends with a line break only after text that does, so it's
      // read only there, as reading it copies Markdown being built
      const prev = segment[i - 1];
      // Nor after the span it ends with, as of a tracked break alone, but
      // in it, after a line break or a tracked break, where the text goes
      // on in the same span
      const lineStart = (out === '' || prev?.type === 'text' && (lastSpan?.end !== out.length
        ? prev.text.endsWith('\n') && out.endsWith('\n')
        : !!item.revision && !!lastSpan && revisionsEqual(lastSpan.revision, item.revision) && endsLine(prev.text)))
        && !(item.revision && opts?.nested);
      // An HTML block starts only a block's text, not a heading's, a table
      // cell's or a tracked change's, after its {++
      const blockStart = lineStart && !opts?.heading && !opts?.cell && !item.revision;
      [out, lastSpan] = appendRevised(out, textNextToMath(escapeBangBeforeLink(escapeAfterHighlight(markedFormatting(item.text, item.formatting, lineStart, runsAfter(segment, i + 1, segmentEnd), blockStart, joinsHighlight(segment, i, startIndex, segmentEnd)), out, inSpanBefore(out, item, lastSpan)), segment, i, segmentEnd), segment, i, segmentEnd, out.length === mathEnd, false, out), item, lastSpan);
    }
    i++;
  }
  return { text: resolveBareLinks(resolveEmphasis(joinRevisedSpans(out)), opts?.cell, !opts?.heading && isInParagraphMath(segment[i])), nextIndex: i, deferredComments: [] };
}

/** Render inline content using ID-based comment syntax ({#id}...{/id}).
 *  Comment bodies are deferred (not emitted inline) and returned separately. */
function renderInlineRangeWithIds(
  segment: ContentItem[],
  startIndex: number,
  comments: Map<string, Comment>,
  opts?: InlineRangeOpts,
  commentIdRemap?: Map<string, string>,
  emittedIdCommentBodies?: Set<string>,
  noteLabels?: Map<string, string>,
  imageFormatMapping?: Map<string, string>,
  timezone?: string,
  openIdComments?: Set<string>,
  lastCommentItem?: Map<string, ContentItem>,
): { text: string; nextIndex: number; deferredComments: string[] } {
  let out = '';
  // Where the Markdown ends with an inline equation's closing $, which text
  // after it mustn't run into (textNextToMath)
  let mathEnd = -1;
  let i = startIndex;
  let lastSpan: RevisionSpan | undefined;
  // A comment that spans paragraphs stays open from the one before
  let prevCommentIds = new Set<string>(openIdComments);
  const collectedBodies = new Set<string>();
  const deferred: Array<{ remappedId: string; body: string }> = [];
  const segmentEnd = computeSegmentEnd(segment, startIndex, opts);

  const remap = (id: string) => commentIdRemap?.get(id) ?? id;

  function collectBody(cid: string): void {
    if (collectedBodies.has(cid)) return;
    if (emittedIdCommentBodies?.has(cid)) return;
    const c = comments.get(cid);
    if (!c) return;
    collectedBodies.add(cid);
    emittedIdCommentBodies?.add(cid);
    deferred.push({ remappedId: remap(cid), body: formatCommentBodyWithId(remap(cid), c, timezone) });
  }

  // Ends the comments open that aren't `currentIds` and starts those of
  // them that aren't open, as before each item. prevCommentIds keeps the
  // order they opened in, which those that end together end in: export
  // numbers comments in the order they open, and import reads ranges that
  // end together by number, so another order wouldn't come back
  function enterComments(currentIds: Set<string>): void {
    for (const cid of prevCommentIds) {
      if (!currentIds.has(cid)) {
        out += `{/${remap(cid)}}`;
        collectBody(cid);
      }
    }
    const opening = [...currentIds].sort().filter(cid => !prevCommentIds.has(cid));
    for (const cid of opening) out += `{#${remap(cid)}}`;
    prevCommentIds = new Set([...prevCommentIds].filter(cid => currentIds.has(cid)).concat(opening));
  }

  while (i < segment.length) {
    const item = segment[i];
    if (i >= segmentEnd) break;

    // Detect substitution: a deletion followed immediately by an addition
    // with identical author and date. Skip if comment context differs to
    // avoid unbalancing comment markers, or the item starts a link with
    // changes in part of it, which keeps them. The deletion's comments
    // start first, as they would for it alone, so one can start where a
    // comment's range ends.
    if (isSubstitutionItem(item) && item.revision?.type === 'deletion'
        && !(item.type === 'text' && partlyRevisedLinkAt(segment, i, segmentEnd, item.commentIds))) {
      enterComments(item.commentIds);
      const eligible = (candidate: ContentItem) => candidate.type !== 'para' && 'commentIds' in candidate && commentSetsEqual(candidate.commentIds, prevCommentIds);
      const run = renderSubstitutionRun(segment, i, segmentEnd, out, eligible, noteLabels);
      if (run) {
        out += run.text;
        i = run.nextIndex;
        continue;
      }
      const next = segment[i + 1];
      if (isSubstitutionItem(next) &&
          next.revision?.type === 'addition' &&
          next.revision.author === item.revision.author &&
          next.revision.date === item.revision.date &&
          commentSetsEqual(item.commentIds, prevCommentIds) &&
          commentSetsEqual(next.commentIds, prevCommentIds) &&
          pairStandsAlone(segment, i, eligible)) {

        const result = tryRenderSubstitution(item, next, out, noteLabels);
        if (result !== null) {
          out += result;
          i += 2;
          continue;
        }
      }
    }

    const highlightEnd = 'commentIds' in item ? highlightGroupEnd(segment, i, segmentEnd, item.commentIds) : i;
    if (highlightEnd > i && 'commentIds' in item) {
      const currentIds = item.commentIds;
      enterComments(currentIds);
      [out, lastSpan] = appendHighlightGroup(out, segment, i, highlightEnd, segmentEnd, lastSpan, noteLabels);
      i = highlightEnd;
      continue;
    }

    if (item.type === 'citation') {
      const currentIds = item.commentIds;
      enterComments(currentIds);

      const citeText = citationSeparator(out, item, lastSpan) + citationText(item);
      [out, lastSpan] = appendRevised(out, citeText, item, lastSpan);
      i++;
      continue;
    }

    if (item.type === 'math') {
      const currentIds = item.commentIds;
      enterComments(currentIds);

      const mathText = item.display ? MATH_FENCE + '\n' + item.latex + '\n' + MATH_FENCE : '$' + item.latex + '$';
      if (item.display) out += wrapWithRevision(mathText, item.revision);
      else {
        [out, lastSpan] = appendRevised(out, mathText, item, lastSpan);
        if (!item.revision) mathEnd = out.length;
      }
      i++;
      continue;
    }

    if (item.type === 'footnote_ref') {
      const currentIds = item.commentIds;
      enterComments(currentIds);
      [out, lastSpan] = appendRevised(out, footnoteRefText(item, noteLabels), item, lastSpan);
      i++;
      continue;
    }

    // image: emit with comment ID tracking
    if (item.type === 'image') {
      const currentIds = item.commentIds;
      enterComments(currentIds);
      const imgText = imageMarkdown(item, imageFormatMapping);
      [out, lastSpan] = appendRevised(out, imgText, item, lastSpan);
      i++;
      continue;
    }

    // html_comment: emit raw <!-- ... --> with comment ID tracking
    if (item.type === 'html_comment') {
      const currentIds = item.commentIds;
      enterComments(currentIds);
      // Without the indent export put in its hidden run, where ID syntax
      // starts the paragraph, which it makes one rather than an HTML block
      // whose indent that was, so the indent would be text Word shows
      const text = /^(?:\{#[^}\s]+\})+$/.test(out) ? item.text.replace(/^[ \t]+/, '') : item.text;
      out += markdownComment(text, segment[i + 1]?.type === 'html_comment', opts?.cell);
      i++;
      continue;
    }

    if (item.type !== 'text') {
      i++;
      continue;
    }

    const currentIds = item.commentIds;

    enterComments(currentIds);

    const link = linkGroup(segment, i, segmentEnd, currentIds);
    if (link) {
      [out, lastSpan] = appendRevised(out, link.text, link.item, lastSpan, link.join);
      i = link.end;
      continue;
    }

    // Hard line breaks must not be wrapped in emphasis (e.g. **\\\n**),
    // whose closer after a line's start doesn't close it. A tracked change's
    // delimiters can, as {--\\\n--}, and the formatting Word shows on a
    // break, a highlight, an underline or a strikethrough, as ==\\\n==
    // (see showsOnBreak), and a link's brackets.
    if (item.text === '\\\n' && !showsOnBreak(item.formatting)) {
      [out, lastSpan] = appendRevised(out, lineBreakRun(item), item, lastSpan);
      i++;
      continue;
    }

    // Bold or italic text with equations in it keeps one run of emphasis, in
    // the comments the text is in
    const group = emphasisGroup(segment, i, segmentEnd, currentIds);
    if (group) {
      out += group.text;
      i = group.end;
      continue;
    }

    if (item.href) {
      // Math can close past the link's text, in its URL or the runs after
      const formattedText = markedFormatting(item.text, item.formatting, false, runsAfter(segment, i + 1, segmentEnd).linkTo(item.href));
      [out, lastSpan] = appendRevised(out, bareLinkChoice(item, markdownLink(formattedText, item.href)), item, lastSpan);
    } else {
      // Markdown ends with a line break only after text that does, so it's
      // read only there, as reading it copies Markdown being built
      const prev = segment[i - 1];
      // Nor after the span it ends with, as of a tracked break alone, but
      // in it, after a line break or a tracked break, where the text goes
      // on in the same span
      const lineStart = (out === '' || prev?.type === 'text' && (lastSpan?.end !== out.length
        ? prev.text.endsWith('\n') && out.endsWith('\n')
        : !!item.revision && !!lastSpan && revisionsEqual(lastSpan.revision, item.revision) && endsLine(prev.text)))
        && !(item.revision && opts?.nested);
      // An HTML block starts only a block's text, not a heading's, a table
      // cell's or a tracked change's, after its {++
      const blockStart = lineStart && !opts?.heading && !opts?.cell && !item.revision;
      [out, lastSpan] = appendRevised(out, textNextToMath(escapeBangBeforeLink(escapeAfterHighlight(markedFormatting(item.text, item.formatting, lineStart, runsAfter(segment, i + 1, segmentEnd), blockStart, joinsHighlight(segment, i, startIndex, segmentEnd)), out, inSpanBefore(out, item, lastSpan)), segment, i, segmentEnd), segment, i, segmentEnd, out.length === mathEnd, false, out), item, lastSpan);
    }
    i++;
  }

  // Close any remaining open comments, but those whose range goes on into a
  // later paragraph
  openIdComments?.clear();
  const rendered = new Set(segment.slice(startIndex, i));
  for (const cid of prevCommentIds) {
    const last = lastCommentItem?.get(cid);
    if (last && !rendered.has(last)) {
      openIdComments?.add(cid);
      continue;
    }
    out += `{/${remap(cid)}}`;
    collectBody(cid);
  }

  // Sort deferred comments by remapped ID (numeric then lexicographic)
  deferred.sort((a, b) => {
    const na = parseInt(a.remappedId, 10);
    const nb = parseInt(b.remappedId, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.remappedId.localeCompare(b.remappedId);
  });

  return { text: resolveBareLinks(resolveEmphasis(joinRevisedSpans(out)), opts?.cell, !opts?.heading && isInParagraphMath(segment[i])), nextIndex: i, deferredComments: deferred.map(d => d.body) };
}

/**
 * A cell paragraph's text items as the HTML of a <p>, or undefined if it
 * holds what a cell can't: a cell takes HTML formatting only (see HTML
 * Tables in the specification), so a comment, a tracked change, a
 * highlight, a citation, a note, math or an image would export as literal
 * text. Whitespace HTML collapses or trims is written as references. An HTML
 * comment, which a cell hides, stays one.
 */
function renderHtmlCellParagraph(items: ContentItem[]): string | undefined {
  type TextItem = Extract<ContentItem, { type: 'text' }>;
  type TextPiece = { text: string; item: TextItem; html: string; raw?: boolean; br?: boolean };
  // The paragraph's text, with each line break as the item it's in, but
  // one in formatting Word shows on it, which goes in that as a piece of
  // its own (`br`, see showsOnBreak)
  const pieces: Array<TextPiece | { lineBreak: TextItem }> = [];
  // A comment Word split, as one; and comments the browser ended at a --!>,
  // which Word joined in one hidden run, as inline Markdown would read them
  // as one (see readHiddenText)
  const split = joinSplitComments(items, true).flatMap((item): ContentItem[] => item.type === 'html_comment'
    ? item.text.split(/(?<=--!>)\u200B+(?=<!--)/).map(text => ({ ...item, text }))
    : [item]);
  for (const [k, item] of split.entries()) {
    // Not one with a blank line, which would end the table's HTML block.
    // One with no end, which ran to the end of the cell, gets one.
    if (item.type === 'html_comment' && item.commentIds.size === 0 && /^<!--(?:-?>|(?!-?>)(?:(?!--!?>)[\s\S])*(?:--!?>)?)$/.test(item.text)
      && !/(?:\r\n?|\n)[ \t]*(?:\r\n?|\n)/.test(item.text)) {
      const html = item.text.endsWith('--!>') && item.text.length >= 8 ? item.text : markdownComment(item.text, split[k + 1]?.type === 'html_comment');
      pieces.push({ text: '', item: { type: 'text', text: '', commentIds: item.commentIds, formatting: DEFAULT_FORMATTING }, html, raw: true });
      continue;
    }
    if (item.type !== 'text' || item.revision || item.commentIds.size > 0 || item.formatting.highlight) return undefined;
    item.text.split('\\\n').forEach((text, k) => {
      if (k > 0) pieces.push(showsOnBreak(item.formatting) ? { text: '', item, html: '<br>', br: true } : { lineBreak: item });
      if (text) pieces.push({ text, item, html: '' });
    });
  }
  // Each piece's HTML, from the characters of its line, as the whitespace a
  // line keeps can straddle two pieces
  for (let k = 0; k < pieces.length; k++) {
    let end = k;
    while (end < pieces.length && !('lineBreak' in pieces[end]) && !(pieces[end] as TextPiece).br) end++;
    const line = pieces.slice(k, end) as TextPiece[];
    const characters = htmlLineCharacters(line.map(piece => piece.text).join(''));
    let at = 0;
    for (const piece of line) {
      const html = characters.slice(at, at += piece.text.length).join('');
      if (!piece.raw) piece.html = html;
    }
    k = end;
  }
  let html = '';
  // The tags open around the text, outermost first, which the next piece
  // keeps as far as its own match, so <b>a <i>b</i></b> stays nested
  let open: string[] = [];
  const closeTo = (depth: number) => {
    while (open.length > depth) html += '</' + /^<(\w+)/.exec(open.pop()!)![1] + '>';
  };
  const linkTag = (href: string) => '<a href="' + escapeHtmlAttr(href) + '">';
  // How many of the tags open a piece of `tags` keeps
  const kept = (tags: string[]) => {
    let depth = 0;
    while (depth < open.length && depth < tags.length && open[depth] === tags[depth]) depth++;
    return depth;
  };
  // The line breaks before a piece, which go after the tags it doesn't keep
  // close and before its own open, but in the link they're in, as Word's
  // hyperlink holds them, and out of any other
  let breaks: TextItem[] = [];
  const writeBreaks = (tags: string[]) => {
    for (const item of breaks) {
      const link = item.href !== undefined ? linkTag(item.href) : undefined;
      if (link !== undefined && open[0] === link) closeTo(Math.max(1, kept(tags)));
      else {
        closeTo(link === undefined && !open[0]?.startsWith('<a ') ? kept(tags) : 0);
        if (link !== undefined) {
          html += link;
          open = [link];
        }
      }
      html += '<br>';
    }
    breaks = [];
  };
  pieces.forEach(piece => {
    if ('lineBreak' in piece) {
      breaks.push(piece.lineBreak);
      return;
    }
    // A comment goes in the formatting around it
    if (piece.raw) {
      writeBreaks(open);
      html += piece.html;
      return;
    }
    const fmt = piece.item.formatting;
    const tags = [
      ...(piece.item.href ? [linkTag(piece.item.href)] : []),
      ...(fmt.bold ? ['<b>'] : []),
      ...(fmt.italic ? ['<i>'] : []),
      ...(fmt.strikethrough ? ['<s>'] : []),
      ...(fmt.underline ? ['<u>'] : []),
      ...(fmt.superscript ? ['<sup>'] : fmt.subscript ? ['<sub>'] : []),
      ...(fmt.code ? ['<code>'] : []),
    ];
    writeBreaks(tags);
    const depth = kept(tags);
    closeTo(depth);
    html += tags.slice(depth).join('') + piece.html;
    open = tags;
  });
  writeBreaks([]);
  closeTo(0);
  return html;
}

/** A line of a cell's text as HTML, a string for each of its characters.
 *  HTML collapses a run of spaces and drops those at a line's start, so a
 *  space after another, or at the start of a line, is a reference, as is a
 *  tab or no-break space. So a line of spaces alone is all references, as
 *  an empty one keeps its place in a cell too (see
 *  keepParagraphEdgeWhitespace). The > and < of the {>>, <<} and ~> of
 *  CriticMarkup, which export reads as text there, as no tag starts with
 *  them, stay as they are, so the editor and navigation read a comment or a
 *  substitution's sides there as they do the rest of its CriticMarkup. */
function htmlLineCharacters(line: string): string[] {
  const lead = /^[ \t\u00a0]*/.exec(line)![0].length;
  return line.split('').map((c, i) => c === '&' ? '&amp;'
    : c === '<' ? (line.startsWith('<}', i + 1) || line[i - 1] === '<' && line[i + 1] === '}' ? c : '&lt;')
      : c === '>' ? (line[i - 1] === '~' || line[i - 1] === '{' && line[i + 1] === '>' || line.startsWith('{>', i - 2) ? c : '&gt;')
        : c === '\t' ? '&#9;' : c === '\u00a0' ? '&nbsp;'
          : c === ' ' && (i < lead || line[i - 1] === ' ') ? '&#32;' : c);
}

/** An equation in an HTML table's cell as a run of its Markdown, which the
 *  cell exports as text, with its line ends as line breaks, as a newline
 *  there would read as a space, and a blank line would end the table */
function mathCellRun(item: ContentItem): ContentItem {
  if (item.type !== 'math') return item;
  const markdown = item.display ? MATH_FENCE + '\n' + item.latex + '\n' + MATH_FENCE : '$' + item.latex + '$';
  return {
    type: 'text',
    text: markdown.replace(/\r\n?|\n/g, '\\\n'),
    commentIds: item.commentIds ?? new Set(),
    formatting: DEFAULT_FORMATTING,
    ...(item.revision ? { revision: item.revision } : {}),
  };
}

/** Whether every cell of a table takes HTML (see renderHtmlCellParagraph) */
function htmlCellsHoldTable(table: { rows: TableRow[] }): boolean {
  return table.rows.every(row => row.cells.every(cell =>
    cell.paragraphs.every(para => renderHtmlCellParagraph(para) !== undefined)));
}

/** The start of an HTML block before a table that ends on the line its end
 *  marker is on, as a comment's or a <pre>'s, so the table goes on that line
 *  (see renderHtmlTable) */
const TABLE_BLOCK_ENDS_AT_MARKER_RE = /^[ \t]{0,3}(?:<(?:script|pre|style|textarea)(?=[\s>]|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[)/i;

function renderHtmlTable(table: { rows: TableRow[] }, comments: Map<string, Comment>, indent: string = '  ', renderOpts?: RenderOpts, extraAttrs: string = '', around?: readonly string[]): string {
  // A block that starts as a comment, <pre> or the like ends on the line its
  // end is on, as the --> before the table, so the table goes on that line
  let oneLine = TABLE_BLOCK_ENDS_AT_MARKER_RE.test(around?.[0] ?? '');
  const i1 = indent;  // tr level
  const i2 = indent + indent;  // td/th level
  const i3 = indent + indent + indent;  // content level
  // The HTML around the table in its block, as it was, on the table's lines
  const lines: string[] = [(around?.[0] ?? '') + '<table' + extraAttrs + '>'];
  const deferredAll: string[] = [];
  for (let rowIdx = 0; rowIdx < table.rows.length; rowIdx++) {
    const row = table.rows[rowIdx];
    lines.push(i1 + '<tr>');
    for (const cell of row.cells) {
      const tag = row.isHeader ? 'th' : 'td';
      let attrs = '';
      if (cell.colspan && cell.colspan > 1) attrs += ' colspan="' + cell.colspan + '"';
      if (cell.rowspan && cell.rowspan > 1) attrs += ' rowspan="' + cell.rowspan + '"';
      if (cell.align) attrs += ' align="' + cell.align + '"';
      lines.push(i2 + '<' + tag + attrs + '>');
      for (const para of cell.paragraphs) {
        // Export makes a header cell bold, as for a pipe table
        const items = mergeConsecutiveRuns(row.isHeader
          ? para.map(item => item.type === 'text' && item.formatting?.bold
            ? { ...item, formatting: { ...item.formatting, bold: false } }
            : item)
          : para, false);
        const html = renderHtmlCellParagraph(items);
        if (html !== undefined) {
          lines.push(i3 + '<p>' + html + '</p>');
          continue;
        }
        // In a table only HTML holds, such as one with merged cells, the
        // rest exports as literal text, and its runs as HTML, an equation's
        // too, whose < would read as a tag's
        const outerReadsMarkdown = readsMarkdown;
        readsMarkdown = false;
        let rendered: ReturnType<typeof renderInlineSegment>;
        try {
          rendered = renderInlineSegment(mergeConsecutiveRuns(items.map(mathCellRun)), comments, renderOpts, undefined, true);
        } finally {
          readsMarkdown = outerReadsMarkdown;
        }
        // But not a blank line, as in an HTML comment, which would end the
        // table's HTML block there, so the lines around it join
        const text = rendered.text.replace(/(?:\r\n?|\n)[ \t]*(?=\r|\n)/g, '');
        lines.push(i3 + '<p>' + keepParagraphWhitespace(keepHtmlCellSpaces(text), true, true) + '</p>');
        deferredAll.push(...rendered.deferredComments);
      }
      lines.push(i2 + '</' + tag + '>');
    }
    lines.push(i1 + '</tr>');
  }
  // But a line end in a cell, as in its comment, would end the block there,
  // where its end is before it or in the table, so the HTML before the
  // table goes as blocks of its own, as it does around a table in another
  // format, and the table starts one; and neither goes where that can't be
  // read as it was. A block whose end is after the table, as a <pre>'s
  // around it, goes on over the line end.
  let after = around?.[1] ?? '';
  const ends = oneLine ? htmlBlockEndMarker((around?.[0] ?? '').trimStart()) : undefined;
  if (ends && !ends.test(lines.join('') + after)) {
    // And where the block's end was in a cell, as a </pre> or ?> there,
    // which goes as the cell is written, the block would go on over the
    // text after the table, so the HTML around it goes, and the table is
    // written as one with none
    lines[0] = lines[0].slice((around?.[0] ?? '').length);
    after = '';
    oneLine = false;
  } else if (oneLine && lines.slice(1).some(line => /[\r\n]/.test(line))
    && (!ends || ends.test(around?.[0] ?? '') || lines.slice(1).some(line => ends.test(line)))) {
    const before = detachedTableHtml(around?.[0] ?? '');
    lines[0] = (before ? before + '\n\n' : '') + lines[0].slice((around?.[0] ?? '').length);
    if (before === null) after = '';
  }
  lines.push('</table>' + after);
  // Comment bodies go after the table, as in a pipe table: a blank line in
  // one would end the table's HTML
  return (oneLine ? lines.map((line, k) => k > 0 ? line.trimStart() : line).join('') : lines.join('\n'))
    + (deferredAll.length > 0 ? '\n\n' + deferredAll.join('\n') : '');
}

/** The keys of the HTML around tables export wrote, by the scope, first
 *  row and text of the table each was written with and the count of tables
 *  alike before it (`nth`), the count of tables alike export wrote
 *  (`written`), and those alike that export wrote all with the same HTML
 *  around them (`same`), which renderTable looks a table up by, once for
 *  each mapping, as reading them all for each table took time in the
 *  square of their number */
type TableHtmlAroundIndex = { nth: Map<string, string[]>; written: Map<string, number>; same: Set<string> };
const tableHtmlAroundIndexes = new WeakMap<Map<string, [string, string, string, string, string, string, string]>, TableHtmlAroundIndex>();
function tableHtmlAroundIndex(mapping: Map<string, [string, string, string, string, string, string, string]>): TableHtmlAroundIndex {
  let index = tableHtmlAroundIndexes.get(mapping);
  if (!index) {
    index = { nth: new Map(), written: new Map(), same: new Set() };
    // Each one's HTML, or null where they differ, and their count
    const around = new Map<string, string | null>();
    const counts = new Map<string, number>();
    for (const [key, entry] of mapping) {
      const id = entry[5] + '\n' + entry[2] + '\n' + entry[3];
      const known = index.nth.get(id + '\n' + entry[4]);
      if (known) known.push(key);
      else index.nth.set(id + '\n' + entry[4], [key]);
      index.written.set(id, Number(entry[6]));
      const html = JSON.stringify([entry[0], entry[1]]);
      const seen = around.get(id);
      around.set(id, seen === undefined || seen === html ? html : null);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // But for one written with none
    for (const [id, html] of around) if (html !== null && counts.get(id) === index.written.get(id)) index.same.add(id);
    tableHtmlAroundIndexes.set(mapping, index);
  }
  return index;
}

type RenderOpts = { alwaysUseCommentIds?: boolean; commentIdRemap?: Map<string, string>; forceIdCommentIds?: Set<string>; emittedIdCommentBodies?: Set<string>; noteLabels?: Map<string, string>; imageFormatMapping?: Map<string, string>; noteImageFormatMapping?: Map<string, string>; tableFormatMapping?: Map<string, string>; pipeTableAlignedMapping?: Map<string, string>; gridSourceColWidthsMapping?: Map<string, string>; tableFontSizeMapping?: Map<string, string>; tableFontMapping?: Map<string, string>; tableColWidthsMapping?: Map<string, string>; tableDigitsMapping?: Map<string, string>; tableDecimalMarkMapping?: Map<string, string>; tableDigitGroupingMapping?: Map<string, string>; tableHtmlAroundMapping?: Map<string, [string, string, string, string, string, string, string]>; tablesWrittenAt?: (number | undefined)[]; usedTableHtmlAround?: Set<string>; tablesAlike?: Map<string, number>; tablesAlikeRendered?: Map<string, number>; landscapeTableIndices?: Set<number>; portraitTableIndices?: Set<number>; embedDirectiveMapping?: Map<string, string>; timezone?: string; breaks?: boolean; openIdComments?: Set<string>; lastCommentItem?: Map<string, ContentItem>; htmlCells?: boolean };

/**
 * Try to render a table as a GFM pipe table. Returns null if the table is
 * ineligible (spans, multi-paragraph cells, newlines in content, or width
 * exceeding the limit). Rendering and eligibility checking are combined into
 * one pass so that renderInlineSegment side-effects (e.g. emittedIdCommentBodies)
 * are not duplicated.
 */
function tryRenderPipeTable(table: { rows: TableRow[] }, maxLineWidth: number, comments: Map<string, Comment>, renderOpts?: RenderOpts, aligned?: boolean): string | null {
  if (maxLineWidth <= 0) return null;
  const rows = table.rows;
  if (rows.length === 0) return null;

  // Structural checks first (no side effects)
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.colspan && cell.colspan > 1) return null;
      if (cell.rowspan && cell.rowspan > 1) return null;
      if (cell.paragraphs.length > 1) return null;
    }
  }

  const numCols = Math.max(...rows.map(r => r.cells.length));

  // GFM pipe tables have exactly one header row (the first), which export
  // makes the Word table's header, in bold. Bail out if the DOCX marks no
  // row as header, more than one, or a row but the first.
  const explicitHeaderRows = rows.reduce((n, r) => n + (r.isHeader ? 1 : 0), 0);
  if (explicitHeaderRows !== 1 || !rows[0].isHeader) return null;

  // Snapshot emittedIdCommentBodies so we can restore on fallback.
  // renderInlineSegment marks deferred comment bodies as emitted; if we
  // bail out after rendering (newline or width), the HTML path must be
  // able to re-render them.
  const emittedSnapshot = renderOpts?.emittedIdCommentBodies
    ? new Set(renderOpts.emittedIdCommentBodies) : undefined;
  const rollback = () => {
    if (emittedSnapshot && renderOpts?.emittedIdCommentBodies) {
      renderOpts.emittedIdCommentBodies.clear();
      for (const v of emittedSnapshot) renderOpts.emittedIdCommentBodies.add(v);
    }
  };

  // Render all cell contents (single pass — side effects happen here)
  const rendered: { text: string; deferred: string[] }[][] = [];
  for (const row of rows) {
    const rowCells: { text: string; deferred: string[] }[] = [];
    for (const cell of row.cells) {
      if (cell.paragraphs.length > 0) {
        // Strip auto-bold from header row cells — md-to-docx forces bold on
        // header cells, so we undo it here to avoid spurious **...** on round-trip.
        const items = row.isHeader
          ? cell.paragraphs[0].map(item =>
              item.type === 'text' && item.formatting?.bold
                ? { ...item, formatting: { ...item.formatting, bold: false } }
                : item)
          : cell.paragraphs[0];
        // Its line breaks at its end too, which renderInlineSegment drops
        // for a grid table's, as a cell of one line holds them as Word's
        const r = renderInlineRange(joinSplitComments(mergeConsecutiveRuns(items), !!renderOpts?.htmlCells), 0, comments, { cell: true }, renderOpts);
        // A line break, which a cell's one line can't hold, as <br>, which a
        // cell reads as one, but not a line end in code, an equation or a
        // comment, which isn't one
        let text = '';
        let from = 0;
        for (const start of lineStartsAfterBreaks(r.text)) {
          text += r.text.slice(from, start - 2) + '<br>';
          from = start;
        }
        text += r.text.slice(from);
        if (text.includes('\n')) { rollback(); return null; }
        // Escape pipes for GFM table cells, which take the backslash before
        // a pipe for the table's, and leave the rest to the cell's Markdown:
        // a backslash of Word's before it, which escapeMarkdownChars doubled,
        // or LaTeX's, as in $\|x\|$
        const escaped = keepParagraphWhitespace(text, true, true).replace(/\|/g, '\\|');
        rowCells.push({ text: escaped, deferred: r.deferredComments });
      } else {
        rowCells.push({ text: '', deferred: [] });
      }
    }
    while (rowCells.length < numCols) {
      rowCells.push({ text: '', deferred: [] });
    }
    rendered.push(rowCells);
  }

  // Check row widths (using display width to account for wide characters)
  for (const rowCells of rendered) {
    // | + (space + content + space + |) per cell
    let width = 1;
    for (const c of rowCells) {
      width += 1 + getDisplayWidth(c.text) + 1 + 1; // space + content + space + |
    }
    if (width > maxLineWidth) { rollback(); return null; }
  }

  // A column's alignment as colons at the ends of its dashes
  const aligns = columnAlignments(rows, numCols);
  const dashes = (ci: number, width: number) => {
    const align = aligns[ci];
    const left = align === 'left' || align === 'center' ? ':' : '';
    const right = align === 'right' || align === 'center' ? ':' : '';
    // At least three dashes, which formatTableNumbers looks for
    return left + '-'.repeat(Math.max(3, width - left.length - right.length)) + right;
  };

  // Separator row: | --- | :---: | ... | — each column its dashes and colons,
  // and 3 chars around them
  let separatorWidth = 1;
  for (let ci = 0; ci < numCols; ci++) separatorWidth += dashes(ci, 3).length + 3;
  if (separatorWidth > maxLineWidth) { rollback(); return null; }

  // Build pipe table lines
  const lines: string[] = [];
  const deferredAll: string[] = [];

  // Compute column widths for aligned mode
  let colWidths: number[] | undefined;
  if (aligned) {
    colWidths = new Array(numCols).fill(3); // minimum separator width
    for (const row of rendered) {
      for (let ci = 0; ci < row.length; ci++) {
        const w = getDisplayWidth(row[ci].text);
        if (w > colWidths[ci]) colWidths[ci] = w;
      }
    }
  }

  const formatPipeRow = (cells: { text: string; deferred: string[] }[]): string => {
    let line = '|';
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci];
      if (colWidths) {
        const pad = colWidths[ci] - getDisplayWidth(c.text);
        line += ' ' + c.text + ' '.repeat(pad) + ' |';
      } else if (c.text.length === 0) {
        line += ' |';
      } else {
        line += ' ' + c.text + ' |';
      }
    }
    return line;
  };

  // GFM pipe tables always require a header row. If the DOCX table has no
  // header signal, the first row is promoted — an accepted round-trip trade-off.
  const headerCells = rendered[0];
  lines.push(formatPipeRow(headerCells));
  for (const c of headerCells) deferredAll.push(...c.deferred);

  if (colWidths) {
    let sep = '|';
    for (let ci = 0; ci < numCols; ci++) {
      sep += dashes(ci, colWidths[ci] + 2) + '|';
    }
    lines.push(sep);
  } else {
    lines.push('| ' + Array.from({ length: numCols }, (_, ci) => dashes(ci, 3)).join(' | ') + ' |');
  }

  for (let i = 1; i < rendered.length; i++) {
    const rowCells = rendered[i];
    lines.push(formatPipeRow(rowCells));
    for (const c of rowCells) deferredAll.push(...c.deferred);
  }

  let result = lines.join('\n');
  if (deferredAll.length > 0) {
    // A line right after the table could read as part of it
    result += '\n\n' + deferredAll.join('\n');
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Hardened alert prefix stripping: matches the exact format emitted by
// generateParagraph (`GLYPH + ' ' + Title + <w:br/>`) as well as bold-wrapped,
// colon-suffixed, and bare-title variants.  The plain-glyph-title pattern
// is checked first (most common roundtrip case) so we don't rely on the
// more permissive regexes for the happy path. With `inline`, of an alert
// whose text export wrote on its marker's line, no space after the line
// break is export's, so the text keeps the whitespace it starts with.
function stripAlertLeadPrefix(text: string, alertType: GfmAlertType, inline = false): string {
  // 1. Standard [!TYPE] marker (e.g. from a re-imported markdown)
  const marker = parseGfmAlertMarker(text.trimStart());
  if (marker?.type === alertType) {
    // Up to the line break and the space export writes after it: the
    // body's own whitespace stays
    return text.replace(/^\s*\[![A-Za-z]+\](?:[ \t]+|\\?\n ?|$)/, '');
  }
  const title = gfmAlertTitle(alertType);
  const glyphAlternation = Object.keys(ALERT_GLYPH_TO_TYPE).map(escapeRegExp).join('|');

  // 2. Exact generateParagraph format: `GLYPH ' ' Title` followed by
  //    optional space or `\\\n` (line break from <w:br/>).  This is the
  //    most common roundtrip format — check it before the bold-wrapped
  //    and colon-suffixed variants.
  const exactPlain = new RegExp(
    '^\\s*(?:' + glyphAlternation + ') ' + escapeRegExp(title) + (inline ? '(?:\\\\?\\n| )' : '(?:\\\\?\\n ?| )')
  );
  if (exactPlain.test(text)) return text.replace(exactPlain, '');

  // 3. Bold-wrapped: **GLYPH Title** or __GLYPH Title__
  const titleCore = '(?:' + glyphAlternation + ')\\s*' + escapeRegExp(title);
  const boldWrapped = text.match(inline ? /^\s*(\*\*|__)(.+?)\1[ \t]?(?:\\?\n)?/ : /^\s*(\*\*|__)(.+?)\1[ \t]?(?:\\?\n ?)?/);
  if (boldWrapped) {
    const inner = boldWrapped[2].trim();
    if (new RegExp('^' + titleCore + '\\s*[:：-]?$').test(inner)) {
      return text.slice(boldWrapped[0].length);
    }
  }

  // 4. Glyph + title with optional colon/dash separator
  const withGlyph = new RegExp('^\\s*(?:' + glyphAlternation + ')\\s*' + escapeRegExp(title) + '(?:\\s*[:：-]\\s*|\\s+|\\\\?\\n\\s*|$)');
  if (withGlyph.test(text)) return text.replace(withGlyph, '');

  // 5. Bare title with required colon/dash (e.g. "Note:" without glyph)
  const titleOnly = new RegExp('^\\s*' + escapeRegExp(title) + '\\s*[:：-]\\s*(?:\\\\?\\n\\s*)?');
  if (titleOnly.test(text)) return text.replace(titleOnly, '');

  return text;
}


/** Render a table as a grid table if possible; returns null if not feasible. */
/** A grid table cell's line before a line break, with the spaces and tabs
 *  at its end, which export trims as the line's padding, as references,
 *  and a backslash before them, which would escape the &, escaped */
function gridLineBeforeBreak(line: string): string {
  const whitespace = /[ \t]+$/.exec(line);
  if (!whitespace) return line;
  const before = line.slice(0, whitespace.index);
  const backslashes = /\\*$/.exec(before)![0].length;
  return before + (backslashes % 2 === 1 ? '\\' : '') + whitespace[0].replace(/[ \t]/g, c => c === ' ' ? '&#32;' : '&#9;');
}

function tryRenderGridTable(
  table: { rows: TableRow[] },
  comments: Map<string, Comment>,
  renderOpts?: RenderOpts,
  maxLineWidth?: number,
  sourceColWidths?: number[],
): string | null {
  if (maxLineWidth !== undefined && maxLineWidth <= 0) return null;
  const rows = table.rows;
  if (rows.length === 0) return null;

  // Grid tables don't support colspan/rowspan, nor a cell of paragraphs,
  // whose lines export reads as one paragraph with line breaks
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.colspan && cell.colspan > 1) return null;
      if (cell.rowspan && cell.rowspan > 1) return null;
      if (cell.paragraphs.length > 1) return null;
    }
  }
  // A grid table's header is its leading rows: a header row after a body
  // row would lose its header, and the bold its header stripped
  const firstBody = rows.findIndex(r => !r.isHeader);
  if (firstBody !== -1 && rows.slice(firstBody).some(r => r.isHeader)) return null;

  const numCols = Math.max(...rows.map(r => r.cells.length));

  // Snapshot emittedIdCommentBodies for rollback
  const emittedSnapshot = renderOpts?.emittedIdCommentBodies
    ? new Set(renderOpts.emittedIdCommentBodies) : undefined;
  const rollback = () => {
    if (emittedSnapshot && renderOpts?.emittedIdCommentBodies) {
      renderOpts.emittedIdCommentBodies.clear();
      for (const v of emittedSnapshot) renderOpts.emittedIdCommentBodies.add(v);
    }
  };

  // Render all cells: a cell's line breaks → multiple lines
  const rendered: { lines: string[]; deferred: string[] }[][] = [];
  for (const row of rows) {
    const rowCells: { lines: string[]; deferred: string[] }[] = [];
    for (const cell of row.cells) {
      const cellLines: string[] = [];
      const cellDeferred: string[] = [];
      for (const para of cell.paragraphs) {
        // Strip auto-bold from header row cells — md-to-docx forces bold on
        // header cells, so we undo it here to avoid spurious **...** on round-trip.
        const items = row.isHeader
          ? para.map(item =>
              item.type === 'text' && item.formatting?.bold
                ? { ...item, formatting: { ...item.formatting, bold: false } }
                : item)
          : para;
        const r = renderInlineSegment(mergeConsecutiveRuns(items), comments, renderOpts, { cell: true });
        // Split on newlines within a paragraph (e.g. hard breaks).
        // Strip the backslash of the break that ends each line but the last —
        // grid table cells treat bare newlines as hard breaks, so the
        // backslash is redundant. A line of an equation or a comment, which
        // ends in no break's backslash, as an odd run of them, stays as it is.
        const paraLines = keepParagraphWhitespace(r.text, true, true).split('\n');
        cellLines.push(...paraLines.map((l, k) => k < paraLines.length - 1 && /(?<!\\)(?:\\\\)*\\$/.test(l) ? gridLineBeforeBreak(l.slice(0, -1)) : l));
        cellDeferred.push(...r.deferredComments);
      }
      // A line break at the cell's end is <br> there, as the blank line after
      // it would pad the cell to its row's height. One before spaces and tabs
      // alone is too, which Word shows none of, and the padding takes.
      let endBreaks = 0;
      while (cellLines.length > 1 && /^[ \t]*$/.test(cellLines[cellLines.length - 1])) {
        cellLines.pop();
        endBreaks++;
      }
      if (endBreaks > 0) cellLines[cellLines.length - 1] += '<br>'.repeat(endBreaks);
      if (cellLines.length === 0) cellLines.push('');
      rowCells.push({ lines: cellLines, deferred: cellDeferred });
    }
    // Pad to numCols
    while (rowCells.length < numCols) {
      rowCells.push({ lines: [''], deferred: [] });
    }
    rendered.push(rowCells);
  }

  // Find header boundary: a table of header rows alone ends its header at
  // its last row, under +===+, which export reads as a header's
  const headerEnd = firstBody === -1 ? rows.length : firstBody;
  const hasHeader = headerEnd > 0;
  const aligns = columnAlignments(rows, numCols);
  const deferredAll = rendered.flatMap(rowCells => rowCells.flatMap(cell => cell.deferred));

  // The table's lines, its cells padded to the widths `measure` counts: by
  // display columns, as Pandoc pads a table, or by characters
  const layOut = (measure: (text: string) => number): string[] | null => {
    // Compute column widths (minimum 3 for separator dashes, or source widths if available).
    // sourceColWidths are inner widths (between +...+), which include 2 padding spaces;
    // colWidths here are content widths (the renderer adds padding), so subtract 2.
    const colWidths: number[] = Array(numCols).fill(3);
    let validSourceWidths = false;
    if (sourceColWidths && sourceColWidths.length === numCols) {
      validSourceWidths = sourceColWidths.every(w => Number.isFinite(w) && w >= 0);
    }
    if (validSourceWidths) {
      for (let c = 0; c < numCols; c++) {
        const contentWidth = sourceColWidths![c] - 2;
        if (contentWidth > colWidths[c]) colWidths[c] = contentWidth;
      }
    }
    for (const rowCells of rendered) {
      for (let c = 0; c < numCols; c++) {
        for (const line of rowCells[c].lines) {
          const w = measure(line);
          if (w > colWidths[c]) colWidths[c] = w;
        }
      }
    }

    // Check width limit (separator line is always the widest)
    if (maxLineWidth !== undefined && Number.isFinite(maxLineWidth)) {
      const totalWidth = colWidths.reduce((s, w) => s + w + 3, 1);
      if (totalWidth > maxLineWidth) return null;
    }

    // Build separator line; each column's alignment goes as colons at the
    // ends of its line under the header, or the top line without one
    const makeSep = (ch: string, aligned = false) =>
      '+' + colWidths.map((w, c) => {
        const align = aligned ? aligns[c] : undefined;
        return (align === 'left' || align === 'center' ? ':' : ch) + ch.repeat(w)
          + (align === 'right' || align === 'center' ? ':' : ch);
      }).join('+') + '+';

    const normalSep = makeSep('-');
    const headerSep = makeSep('=', true);

    // Build output lines
    const lines: string[] = [];
    lines.push(hasHeader ? normalSep : makeSep('-', true));

    for (let ri = 0; ri < rendered.length; ri++) {
      const rowCells = rendered[ri];
      // Number of content lines in this row
      const rowHeight = Math.max(...rowCells.map(c => c.lines.length));

      for (let li = 0; li < rowHeight; li++) {
        let line = '|';
        for (let c = 0; c < numCols; c++) {
          const text = rowCells[c].lines[li] || '';
          const pad = colWidths[c] - measure(text);
          line += ' ' + text + ' '.repeat(pad + 1) + '|';
        }
        lines.push(line);
      }

      // Separator after row
      if (hasHeader && ri === headerEnd - 1) {
        lines.push(headerSep);
      } else {
        lines.push(normalSep);
      }
    }

    // If something went wrong with rendering, rollback
    return lines.length <= 2 ? null : lines;
  };

  // Whether the table reads back as written, as export reads it
  const cellText = (text: string) => text.split('\n').map(line => line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
  const readsBack = (lines: string[]) => {
    const read = readGridTableCells(lines);
    return !!read && read.length === rendered.length
      && rendered.every((rowCells, ri) => rowCells.every((cell, c) => cellText(read[ri][c] ?? '') === cellText(cell.lines.join('\n'))));
  };
  // A line padded by display columns can line up by characters too, where a
  // | in a cell's text is under a +, which export could take for the cell's
  // edge, moving text between cells, so a table that doesn't read back as
  // written is padded by characters, which does (see gridLineCells)
  let lines = layOut(getDisplayWidth);
  if (lines && !readsBack(lines)) lines = layOut(text => text.length);
  if (!lines || !readsBack(lines)) {
    rollback();
    return null;
  }

  let result = lines.join('\n');
  if (deferredAll.length > 0) {
    // A line right after the table could read as part of it
    result += '\n\n' + deferredAll.join('\n');
  }
  return result;
}

/**
 * A table as import writes one that leaves HTML, as a pipe table, unpadded,
 * or a grid table, of any width, or null where it can't. Expand Table and
 * Compact Table write an HTML table so, whose text is literal, as Word's
 * is, so it takes an escape wherever a pipe or grid cell would read it as
 * Markdown, and a citation's brackets are escaped too, as of a key export
 * doesn't know. A comment in a cell is one the browser reads, as in an
 * HTML table's cell.
 */
export function markdownTable(rows: TableRow[], kind: 'pipe' | 'grid'): string | null {
  const outerKeys = knownCitationKeys;
  const outerNoted = citationsNoted;
  knownCitationKeys = new Set();
  citationsNoted = true;
  try {
    const renderOpts: RenderOpts = { htmlCells: true };
    return kind === 'pipe' ? tryRenderPipeTable({ rows }, Infinity, new Map(), renderOpts) : tryRenderGridTable({ rows }, new Map(), renderOpts);
  } finally {
    knownCitationKeys = outerKeys;
    citationsNoted = outerNoted;
  }
}

/** Render a table as a grid table, GFM pipe table, or HTML fallback, depending on feasibility and stored format.
 *  Returns { directivePrefix, body } so callers can position directives before preceding HTML comments. */
/**
 * Build the comment-style directive prefix for a table (font-size, font, col-widths, orientation).
 * Returns the prefix string and a flag indicating whether a font value is comment-unsafe.
 */
function buildTableDirectivePrefix(
  renderOpts: RenderOpts | undefined,
  tableIndex: number | undefined,
): { fontPrefix: string; commentUnsafeFont: boolean } {
  let fontPrefix = '';
  let commentUnsafeFont = false;
  const isLandscapeTable = tableIndex !== undefined && renderOpts?.landscapeTableIndices?.has(tableIndex);
  const isPortraitTable = tableIndex !== undefined && renderOpts?.portraitTableIndices?.has(tableIndex);
  if (tableIndex !== undefined && renderOpts) {
    const fontSize = renderOpts.tableFontSizeMapping?.get(String(tableIndex));
    const font = renderOpts.tableFontMapping?.get(String(tableIndex));
    if (fontSize) fontPrefix += '<!-- table-font-size: ' + fontSize + ' -->\n';
    if (font) {
      if (font.includes('-->')) {
        commentUnsafeFont = true;
      } else {
        fontPrefix += '<!-- table-font: ' + font + ' -->\n';
      }
    }
    const colWidths = renderOpts.tableColWidthsMapping?.get(String(tableIndex));
    if (colWidths) {
      if (colWidths.includes('-->')) {
        commentUnsafeFont = true;
      } else {
        fontPrefix += '<!-- table-col-widths: ' + colWidths + ' -->\n';
      }
    }
    const digits = renderOpts.tableDigitsMapping?.get(String(tableIndex));
    const decimalMark = renderOpts.tableDecimalMarkMapping?.get(String(tableIndex));
    const digitGrouping = renderOpts.tableDigitGroupingMapping?.get(String(tableIndex));
    if (digits) fontPrefix += '<!-- table-digits: ' + digits + ' -->\n';
    if (decimalMark) fontPrefix += '<!-- table-decimal-mark: ' + decimalMark + ' -->\n';
    if (digitGrouping) fontPrefix += '<!-- table-digit-grouping: ' + digitGrouping + ' -->\n';
    if (isLandscapeTable) fontPrefix += '<!-- table-orientation: landscape -->\n';
    if (isPortraitTable) fontPrefix += '<!-- table-orientation: portrait -->\n';
  }
  return { fontPrefix, commentUnsafeFont };
}

const STRUCTURAL_SENTINEL_RE = /^<!--\s*(?:\/?(?:landscape|portrait|references|bibliography|style)\b.*?)\s*-->$/i;
const HTML_COMMENT_RE = /^<!--[\s\S]*?-->$/;

/**
 * Insert a directive prefix + body into the output array, hoisting the prefix
 * above any immediately-preceding HTML comment entries so that table directives
 * appear above user sentinel comments (preserving original document order).
 * The directives are a block of their own, after a blank line, and the
 * comments keep the gaps their metadata gave them: the first comment's, which
 * export measured from the directives above it, goes between them and it.
 * `startGap` is that gap for a comment first in the document.
 */
function pushWithHoistedPrefix(output: string[], directivePrefix: string, body: string, startGap?: number): void {
  if (!directivePrefix) {
    output.push(body);
    return;
  }
  let scanIdx = output.length;
  while (scanIdx > 0) {
    const prev = output[scanIdx - 1];
    const trimmedPrev = prev.trim();
    if (STRUCTURAL_SENTINEL_RE.test(trimmedPrev)) break;
    if (HTML_COMMENT_RE.test(trimmedPrev)) { scanIdx--; continue; }
    if (/^\s*$/.test(prev) && scanIdx >= 2 && HTML_COMMENT_RE.test(output[scanIdx - 2].trim())
        && !STRUCTURAL_SENTINEL_RE.test(output[scanIdx - 2].trim())) {
      scanIdx--; continue;
    }
    break;
  }
  const commentBlock = output.splice(scanIdx);
  const directives = directivePrefix.replace(/\n+$/, '');
  if (commentBlock.length === 0) {
    output.push(directives);
    output.push('\n' + body);
    return;
  }
  // The line ends before the first comment, as its gap set them
  let gap = 0;
  while (output.length > 0) {
    const last = output[output.length - 1];
    const text = last.replace(/\n+$/, '');
    gap += last.length - text.length;
    if (text) {
      output[output.length - 1] = text;
      break;
    }
    output.pop();
  }
  if (output.length > 0) output.push('\n\n');
  else if (startGap !== undefined) gap = startGap + 1;
  output.push(directives, '\n'.repeat(Math.max(gap, 1)), ...commentBlock);
  output.push((commentBlock[commentBlock.length - 1].endsWith('\n') ? '' : '\n') + body);
}

const tableCellText = (cell: TableRow['cells'][number]): string =>
  cell.paragraphs.flat().map(item => item.type === 'text' ? item.text : '').join('');

/** A table's first row's text, as export finds it (see tableFirstRowText) */
function tableFirstRow(rows: TableRow[]): string {
  return tableFirstRowText((rows[0]?.cells ?? []).map(tableCellText));
}

/** A table's text, as export finds it (see tableContentsFingerprint) */
function tableContents(rows: TableRow[]): string {
  return tableContentsFingerprint(rows.map(row => row.cells.map(tableCellText)));
}

/** A table's first row and text, which tables alike in both share */
function tableIdentity(rows: TableRow[]): string {
  return tableFirstRow(rows) + '\n' + tableContents(rows);
}

const CHARACTER_REFERENCE_AT = /&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/y;

/** Lines of the HTML around a table, one after another, as Markdown text
 *  that reads as it did in the table's block: their tags, comments and
 *  character references, as markdown-it reads them, which can go on across
 *  lines, as they are, and the rest escaped, with each line's $ or [ as the
 *  lines after can close it, with no indent, which HTML runs together with
 *  the line end before, nor whitespace at a line's end, which would make a
 *  line break, but in a tag or comment over lines, as in an attribute's
 *  value, which keeps it. A citation's [, as any with an @ before its ], is escaped
 *  too, and what it holds as text, which escapeMarkdownChars keeps as a
 *  citation, as export writes one whose key is missing as its text, but
 *  which the HTML held as text. It's a \0 while the rest is escaped, which
 *  no Markdown holds, as markdown-it replaces one. The lines go on one, with
 *  a space between, as HTML reads a line end, but those in a tag or comment:
 *  Word holds the paragraph's line ends as spaces, which the next import
 *  reads as none, and where a line end is a line break, as with breaks:
 *  true, export would make one a line break. */
function htmlLinesAsText(lines: string[]): string[] {
  const text = lines.join('\n');
  // Each of those as a character the lines don't hold while the rest is
  // escaped, so a $ or * pairs across them as Markdown reads it
  let code = 0xE000;
  while (text.includes(String.fromCharCode(code))) code++;
  const mark = String.fromCharCode(code);
  const raws: string[] = [];
  let plain = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const at = text[i] === '<' ? HTML_TAG_AT : text[i] === '&' ? CHARACTER_REFERENCE_AT : undefined;
    if (!at) continue;
    at.lastIndex = i;
    const raw = at.exec(text)?.[0];
    if (!raw) continue;
    plain += text.slice(from, i) + mark;
    raws.push(raw);
    from = i + raw.length;
    i = from - 1;
  }
  plain += text.slice(from);
  plain = plain.split('\n').map(line => line.replace(/^[ \t]+|[ \t]+$/g, '')).join(' ');
  // From the right, whether an @ comes before the next ], as looking on
  // from each [ took time in the square of their number
  const chars = plain.split('');
  for (let i = chars.length - 1, at = false; i >= 0; i--) {
    if (chars[i] === '[' && at) chars[i] = '\0';
    else if (chars[i] === ']') at = false;
    else if (chars[i] === '@') at = true;
  }
  const masked = chars.join('');
  // The lines after each, from the line end before them
  const index = indexText(masked);
  let end = -1;
  const escaped = masked.split('\n').map(line => {
    end += line.length + 1;
    return escapeMarkdownChars(line, true, new RunsAfter(index, Math.min(end, masked.length))).replace(/\0/g, '\\[');
  });
  // A \ before one of them, which escapeMarkdownChars leaves, as it escapes
  // no character it doesn't see, but which would escape its < or &. A line
  // that would read as the Sources heading of a bibliography Word holds as
  // text, which import drops with all after it, starts with a reference, and
  // one that would read as a grid table's border, with the lines between
  // as its rows, as one indented as code was, with a \.
  return escaped.join('\n').split(mark).map((part, k) => (k < raws.length && part.endsWith('\\') ? part + '\\' : part) + (raws[k] ?? ''))
    .join('').split('\n').map(line => SOURCES_HEADING_RE.test(line) ? line.replace('S', '&#83;') : GRID_TABLE_SEPARATOR_RE.test(line) ? '\\' + line : line);
}

/** A paragraph's Markdown as import writes the paragraph export makes of it
 *  in Word, as the next round trip would: a tag that formats its text, as
 *  <b>, as Markdown's emphasis, where that reads as it, a <br> as a line
 *  break, a character reference as its character, where it needs none, and
 *  a tag export shows as text that would read as one that formats, as
 *  <b class="x">, escaped. A citation's brackets stay escaped, as the HTML
 *  held them as text, though import writes Word's text of one whose key
 *  the document cites as a citation. As it is where it holds what this
 *  doesn't make, as a line end in a tag export shows as text, or one a
 *  reference, as &#13;, gives, which Markdown would read as a line end, or
 *  where export wouldn't read what this makes as it reads the paragraph, as
 *  a line break before a comment, which would start an HTML block. */
function asImportedParagraph(markdown: string): string {
  const tokens = parseMd(markdown);
  if (tokens.length !== 1 || tokens[0].type !== 'paragraph') return markdown;
  const items: ContentItem[] = [];
  let link = 0;
  for (const run of tokens[0].runs) {
    const formatting: RunFormatting = {
      ...DEFAULT_FORMATTING, bold: !!run.bold, italic: !!run.italic, underline: !!run.underline,
      strikethrough: !!run.strikethrough, superscript: !!run.superscript, subscript: !!run.subscript,
    };
    if (run.linkStart) link++;
    const href = run.href !== undefined ? { href: run.href, link } : {};
    // A line break as import reads Word's
    if (run.type === 'hardbreak') items.push({ type: 'text', text: '\\\n', commentIds: new Set(), formatting, ...href });
    else if (run.type === 'text' && !run.code && !run.highlight && !/[\r\n]/.test(run.text)) {
      items.push({ type: 'text', text: run.text, commentIds: new Set(), formatting, ...href });
    } else if (run.type === 'html_comment') items.push({ type: 'html_comment', text: run.text, commentIds: new Set() });
    // As import reads one export hid between zero-width spaces, which it
    // couldn't embed
    else if (run.type === 'image' && run.imageSource !== undefined) {
      items.push({ type: 'image', rId: '', src: '', alt: '', widthPx: 0, heightPx: 0, commentIds: new Set(), markdown: run.imageSource + '\u200B' });
    } else return markdown;
  }
  if (items.length === 0) return markdown;
  // As buildMarkdown writes a paragraph's text, with a line break at its
  // end as <br>, as Markdown, though around a table in an HTML cell, and
  // with no key known, so a citation's brackets are text's
  const [outerReadsMarkdown, outerKeys, outerNoted] = [readsMarkdown, knownCitationKeys, citationsNoted];
  readsMarkdown = true;
  knownCitationKeys = new Set();
  citationsNoted = true;
  try {
    const text = renderInlineRange(mergeConsecutiveRuns(items), 0, new Map(), { stopBeforeDisplayMath: true }).text;
    const imported = keepParagraphWhitespace(text.replace(HARD_BREAK_AT_END, (_m, backslashes: string) => backslashes + '<br>'), true, true);
    // Only where export reads it as it reads the paragraph: a comment on the
    // line after a line break starts an HTML block, which ends the paragraph
    return JSON.stringify(blocksAsRead(imported)) === JSON.stringify(blocksAsRead(markdown)) ? imported : markdown;
  } finally {
    readsMarkdown = outerReadsMarkdown;
    knownCitationKeys = outerKeys;
    citationsNoted = outerNoted;
  }
}

/** For each line of the HTML around a table, read as the browser read it
 *  in the table's block, whether it starts in a comment (`inComment`), and
 *  where on it an element whose text keeps its whitespace, as a <pre>'s,
 *  starts that goes on past it, or -1 (`preformatted`): on a line of text,
 *  its lines would be a paragraph's, with their indents gone. Such an
 *  element ends Markdown's HTML block at the first line with an end of one,
 *  as in a comment, which the browser read as none, or past the HTML, as
 *  for a <pre> around the table, which reads no more as it was
 *  (`unreadable`). */
function detachedHtmlLines(lines: string[]): { inComment: boolean[]; preformatted: number[]; unreadable: boolean } {
  const text = lines.join('\n');
  const starts: number[] = [];
  for (let k = 0, at = 0; k < lines.length; at += lines[k++].length + 1) starts.push(at);
  const lineOf = (at: number) => {
    let [low, high] = [0, starts.length - 1];
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= at) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const inComment = lines.map(() => false);
  const preformatted = lines.map(() => -1);
  // Each end of such an element as Markdown reads them, in its text
  const ends = [...text.matchAll(new RegExp(HTML_BLOCKS_WITH_END[0][1].source, 'gi'))].map(match => match.index);
  let nextEnd = 0;
  const start = new RegExp(HTML_BLOCKS_WITH_END[0][0].source.replace(/^\^/, ''), 'iy');
  let unreadable = false;
  // Where an open <pre> starts, which the browser ends at its end tag, as
  // it reads no other element's text as no HTML
  let pre = -1;
  // Whether Markdown ends such an element from `from`, which the browser
  // ends at `to`, or never, on the line the browser does
  const endsAlike = (from: number, to: number | undefined) => {
    while (nextEnd < ends.length && ends[nextEnd] < from) nextEnd++;
    return to !== undefined && nextEnd < ends.length && lineOf(ends[nextEnd]) === lineOf(to - 1);
  };
  // One that starts at `from` after text on its line and ends at `to` on
  // another starts a line of its own
  const ownLine = (from: number, to: number) => {
    const line = lineOf(from);
    if (preformatted[line] === -1 && lineOf(to - 1) > line && /\S/.test(text.slice(starts[line], from))) preformatted[line] = from - starts[line];
  };
  for (let i = 0; i < text.length;) {
    const piece = htmlPieceAt(text, i);
    start.lastIndex = i;
    if (piece.kind === 'comment') {
      for (let k = lineOf(i) + 1; k < starts.length && starts[k] < piece.end; k++) inComment[k] = true;
    } else if (pre >= 0) {
      if (piece.kind === 'tag' && /^<\/pre[\s>]/i.test(text.slice(i, piece.end))) {
        if (!endsAlike(pre, piece.end)) unreadable = true;
        ownLine(pre, piece.end);
        pre = -1;
      }
    } else if (start.test(text)) {
      if (/^<pre/i.test(text.slice(i, i + 4))) pre = i;
      else if (piece.rest || !endsAlike(i, piece.end)) unreadable = true;
      else ownLine(i, piece.end);
    }
    i = piece.end;
  }
  return { inComment, preformatted, unreadable: unreadable || pre >= 0 };
}

/** HTML from a table's block with each comment ending where the browser
 *  read its end, as Markdown does, which a block of its own or a line of
 *  text would read on past, over the table: one the browser ended at a --!>
 *  ends at a --> instead, one whose text ends in a -, as at a --->, which
 *  inline Markdown reads as none, gets a space before its end, and one with
 *  no end, which ran to the end of the block, gets one. An <!-- in an
 *  element whose text is no HTML, as a <textarea>'s, starts none. */
function withMarkdownCommentEnds(html: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < html.length;) {
    const piece = htmlPieceAt(html, i);
    if (piece.kind === 'comment' && piece.rest) return out + html.slice(from).replace(/\s*$/, ' -->');
    // But an empty one, <!--> or <!--->, which both read alike
    if (piece.kind === 'comment' && !html.startsWith('<!-->', i) && !html.startsWith('<!--->', i)) {
      const end = piece.end - (html.startsWith('--!>', piece.end - 4) ? 4 : 3);
      const dash = end > i + 4 && html[end - 1] === '-';
      if (dash || end === piece.end - 4) {
        out += html.slice(from, end) + (dash ? ' ' : '') + '-->';
        from = piece.end;
      }
    }
    i = piece.end;
  }
  return out + html.slice(from);
}

/** The end of the HTML block that `line` starts, where it ends at a marker,
 *  as a comment does at its --> */
function htmlBlockEndMarker(line: string): RegExp | undefined {
  return HTML_BLOCKS_WITH_END.find(([start]) => start.test(line))?.[1] ?? (HTML_BLOCK_IN_PARAGRAPH[1].test(line) ? /-->/ : undefined);
}

/** Where the HTML block that starts at `lines[k]` ends, after its last
 *  line, as markdown-it reads one, or -1 where none does: a line of one
 *  tag starts none after a line of a paragraph (`inParagraph`). A line
 *  indented as code starts one too, as the browser read its tag. */
function htmlBlockEnd(lines: string[], k: number, inParagraph: boolean): number {
  const text = lines[k].trimStart();
  const ends = htmlBlockEndMarker(text);
  if (ends) {
    for (let m = k; m < lines.length; m++) if (ends.test(lines[m])) return m + 1;
    return lines.length;
  }
  if (!HTML_BLOCK_IN_PARAGRAPH[5].test(text) && (inParagraph || !HTML_TAG_LINE.test(text))) return -1;
  let m = k + 1;
  while (m < lines.length && /\S/.test(lines[m])) m++;
  return m;
}

/** The HTML around a table as blocks of their own, as it goes around one in
 *  another format, which Markdown reads as it read none of the table's
 *  block: its HTML blocks as they are, and its other lines as text, as
 *  # Source would be a heading. A comment export would read as a directive,
 *  as <!-- table-font-size: 11 --> or a line of an embed's, which none of
 *  them was in the table's block, goes, but for the text a style's goes
 *  around on its line, and the end of a comment an embed's line is in.
 *  Each line reads as it does in what's written, in order, in which a line
 *  of text is a paragraph's, after which a line of one tag starts no block,
 *  and a paragraph's lines go on one (see htmlLinesAsText). A paragraph
 *  goes as the next round trip would write it (see asImportedParagraph),
 *  and a blank line between blocks, but next to a comment. Null where it reads no more as it was, as a block that ends
 *  at a marker without one, which would go on over the table (see
 *  detachedHtmlLines), or a paragraph of a Sources line. */
function detachedTableHtml(html: string): string | undefined | null {
  const lines = withMarkdownCommentEnds(html).split('\n');
  const { inComment, preformatted, unreadable } = detachedHtmlLines(lines);
  if (unreadable) return null;
  const out: string[] = [];
  // The lines of text since the last that isn't, which escape together
  let texts: string[] = [];
  // A paragraph that would read as the Sources heading of a bibliography
  // Word holds as text, which import drops with all after it, as Word's
  // paragraph does, whatever the Markdown wrote it as: its text, with its
  // character references read, its comments and tags gone, as an empty
  // one's would be on the next round trip, and its lines run together
  let sources = false;
  // Or of lines a comment or tag goes on over, which aren't escaped, where
  // one starts a block, as # Heading would, which ends the paragraph there
  // and shows what the comment hid
  let unread = false;
  // What `out` ends with: a paragraph of text, an HTML block or a comment.
  // The next round trip writes a blank line between each and the next, as
  // between Word's paragraphs, but next to a comment, whose lines before
  // and after export keeps.
  let last: 'text' | 'html' | 'comment' | undefined;
  const push = (lines: string[], kind: 'text' | 'html' | 'comment') => {
    if (lines.length === 0) return;
    if (kind !== 'comment' && last !== undefined && last !== 'comment' && out[out.length - 1] !== '') out.push('');
    out.push(...lines);
    last = kind;
  };
  const endTexts = () => {
    const shown = unescapeAll(texts.join('\n').replace(/<!--[\s\S]*?-->|<[^>]*>/g, '').replace(/\\/g, '\\\\'));
    if (SOURCES_HEADING_RE.test(shown.replace(/\s+/g, ' ').trim())) sources = true;
    const text = htmlLinesAsText(texts);
    if (texts.length > 1 && !readsAsParagraph(text.join('\n'))) unread = true;
    if (texts.length > 0) push(asImportedParagraph(text.join('\n')).split('\n'), 'text');
    texts = [];
  };
  let inParagraph = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    // A comment a line of text starts goes on in it, whatever its lines
    // start with
    const end = /\S/.test(line) && !(inComment[k] && texts.length > 0) ? htmlBlockEnd(lines, k, inParagraph) : -1;
    if (end === -1) {
      // An embed's line goes, as export would add its table, but for the end
      // of a comment it's in, which would go on over the table without it
      if (parseEmbedDirective(line)) {
        if (inComment[k]) texts.push(line.slice(line.indexOf('-->')));
        continue;
      }
      // Which starts a line of its own, an HTML block to its end
      if (preformatted[k] > 0) {
        texts.push(line.slice(0, preformatted[k]));
        lines[k] = line.slice(preformatted[k]);
        inComment[k] = false;
        preformatted[k--] = -1;
        inParagraph = true;
        continue;
      }
      if (/\S/.test(line)) texts.push(line);
      else {
        endTexts();
        // One blank line between blocks, but those in a block as they are
        if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      }
      inParagraph = /\S/.test(line);
      continue;
    }
    // A block that ends at a marker on its last line before a <pre> there
    // does, as a comment before one, goes there, and the <pre> starts one
    // of its own, as its lines would be text after the block, with their
    // indents gone
    const marker = htmlBlockEndMarker(line.trimStart());
    const split = !!marker && preformatted[end - 1] > 0;
    const block = lines.slice(k, end);
    if (split) block[block.length - 1] = block[block.length - 1].slice(0, preformatted[end - 1]);
    if (marker && !marker.test(block[block.length - 1])) return null;
    const rest = directiveRest(block.join('\n'));
    if (rest === undefined) {
      // A block ends the text before it, but a directive, which goes, as
      // the paragraph it was in in Word, so the text on either side, which
      // export read with it as the table's block's, goes on as one
      endTexts();
      // With its indent as code gone
      if (/^(?: {0,3}\t| {4})/.test(block[0])) block[0] = block[0].trimStart();
      const kept: string[] = [];
      for (let m = 0; m < block.length; m++) {
        if (!parseEmbedDirective(block[m])) kept.push(block[m]);
        else if (inComment[k + m]) kept.push(block[m].slice(block[m].indexOf('-->')));
      }
      push(kept, block[0].trimStart().startsWith('<!--') ? 'comment' : 'html');
      inParagraph = false;
    } else if (/\S/.test(rest)) {
      // Text, as the lines of text after it in its paragraph are
      texts.push(...rest.split('\n'));
      inParagraph = true;
    }
    k = end - 1;
    if (split) {
      lines[k] = lines[k].slice(preformatted[k]);
      inComment[k] = false;
      preformatted[k--] = -1;
    }
  }
  endTexts();
  if (sources || unread) return null;
  return out.join('\n').trim() || undefined;
}

function renderTableOrFallback(
  item: { rows: TableRow[] },
  comments: Map<string, Comment>,
  options?: { pipeTableMaxLineWidth?: number; gridTableMaxLineWidth?: number; tableIndent?: string },
  renderOpts?: RenderOpts,
  storedFormat?: string,
  tableIndex?: number,
  scope = '',
): { directivePrefix: string; body: string; before?: string; after?: string; join?: string } {
  const { fontPrefix, commentUnsafeFont: forceHtmlTable } = buildTableDirectivePrefix(renderOpts, tableIndex);
  let htmlFontAttrs = '';
  const isLandscapeTable = tableIndex !== undefined && renderOpts?.landscapeTableIndices?.has(tableIndex);
  const isPortraitTable = tableIndex !== undefined && renderOpts?.portraitTableIndices?.has(tableIndex);
  if (tableIndex !== undefined && renderOpts) {
    const fontSize = renderOpts.tableFontSizeMapping?.get(String(tableIndex));
    const font = renderOpts.tableFontMapping?.get(String(tableIndex));
    if (fontSize) htmlFontAttrs += ' data-font-size="' + escapeHtmlAttr(fontSize) + '"';
    if (font) htmlFontAttrs += ' data-font="' + escapeHtmlAttr(font) + '"';
    const colWidths = renderOpts.tableColWidthsMapping?.get(String(tableIndex));
    if (colWidths) htmlFontAttrs += ' data-col-widths="' + escapeHtmlAttr(colWidths) + '"';
    const digits = renderOpts.tableDigitsMapping?.get(String(tableIndex));
    const decimalMark = renderOpts.tableDecimalMarkMapping?.get(String(tableIndex));
    const digitGrouping = renderOpts.tableDigitGroupingMapping?.get(String(tableIndex));
    if (digits) htmlFontAttrs += ' data-digits="' + escapeHtmlAttr(digits) + '"';
    if (decimalMark) htmlFontAttrs += ' data-decimal-mark="' + escapeHtmlAttr(decimalMark) + '"';
    if (digitGrouping) htmlFontAttrs += ' data-digit-grouping="' + escapeHtmlAttr(digitGrouping) + '"';
    if (isLandscapeTable) htmlFontAttrs += ' data-orientation="landscape"';
    if (isPortraitTable) htmlFontAttrs += ' data-orientation="portrait"';
  }
  // The HTML around an HTML table in its block: the one export wrote with
  // the table, as the tables' indices shift where Word added or deleted one
  // before it, found by the table's first row and text and the count of
  // tables alike in both before it in the body or its note (`scope`), each
  // once; or else, where Word edited the table, the one at the index export
  // wrote it at (see matchTables), if its first row is the table's and the
  // table it was written with, alike in both, isn't still there. It goes
  // around a table in another format as blocks of their own, before its
  // directives.
  const firstRow = tableFirstRow(item.rows);
  const contents = tableContents(item.rows);
  const alikeBefore = renderOpts?.tablesAlikeRendered?.get(scope + '\n' + firstRow + '\n' + contents) ?? 0;
  renderOpts?.tablesAlikeRendered?.set(scope + '\n' + firstRow + '\n' + contents, alikeBefore + 1);
  const mapping = renderOpts?.tableHtmlAroundMapping;
  const unused = (key: string | undefined) => key !== undefined && !renderOpts?.usedTableHtmlAround?.has(key)
    && mapping?.get(key)?.[2] === firstRow && mapping.get(key)?.[5] === scope;
  const edited = (key: string) => (renderOpts?.tablesAlike?.get(scope + '\n' + mapping!.get(key)![2] + '\n' + mapping!.get(key)![3]) ?? 0)
    <= Number(mapping!.get(key)![4]);
  const writtenAt = tableIndex !== undefined && renderOpts?.tablesWrittenAt ? renderOpts.tablesWrittenAt[tableIndex] : tableIndex;
  const own = writtenAt !== undefined && unused(String(writtenAt)) && edited(String(writtenAt)) ? String(writtenAt) : undefined;
  // Where there are more tables alike than export wrote, as where Word
  // edited one to be alike another, which of them was written with the
  // HTML is unknown: one whose own isn't still there takes that, one at
  // the index of one written alike that, and the others none, as HTML
  // that goes with another table is worse than none. Where there are
  // fewer, as where Word deleted one, which went is unknown too: the
  // others take the HTML by their order only where export wrote the same
  // around all, and none otherwise.
  const index = mapping && tableHtmlAroundIndex(mapping);
  const identity = scope + '\n' + firstRow + '\n' + contents;
  const count = renderOpts?.tablesAlike?.get(identity) ?? 0;
  const extra = !!index && count > (index.written.get(identity) ?? 0);
  const fewer = !!index && count < (index.written.get(identity) ?? 0) && !index.same.has(identity);
  const at = writtenAt !== undefined ? mapping?.get(String(writtenAt)) : undefined;
  const atIndex = at && at[5] + '\n' + at[2] + '\n' + at[3] === identity && unused(String(writtenAt)) ? String(writtenAt) : undefined;
  const aroundKey = index && (extra ? own ?? atIndex : fewer ? undefined : index.nth.get(identity + '\n' + alikeBefore)?.find(unused) ?? own);
  const around = aroundKey !== undefined ? mapping?.get(aroundKey) : undefined;
  if (aroundKey !== undefined) renderOpts?.usedTableHtmlAround?.add(aroundKey);
  // The line end or spaces export kept at the end of the HTML after a table
  // that another followed in its block, which the next table goes on from,
  // in the block, where it's the next item (see buildMarkdown), and which
  // goes otherwise
  const join = around?.[1].match(/\s+$/)?.[0];
  const html = around && [around[0], join ? around[1].slice(0, -join.length) : around[1]];
  // A table that takes it was HTML, and stays HTML with the HTML on its
  // lines, though the format export wrote at its index, where Word added or
  // deleted a table before it, is another table's
  if (around) storedFormat = 'html';
  // A cell holds no range that goes on past it, and a range open around the
  // table, with no item in it, stays open for the text after. A cell's
  // comments are the browser's where the table was HTML.
  if (renderOpts?.openIdComments || storedFormat === 'html') renderOpts = { ...renderOpts, openIdComments: undefined, htmlCells: storedFormat === 'html' };
  const r = (body: string) => {
    // Neither, where one can't be read as it was, as a <pre> before the
    // table and its end after it
    let before = html && detachedTableHtml(html[0]);
    let after = html && detachedTableHtml(html[1]);
    if (before === null || after === null) before = after = undefined;
    return { directivePrefix: fontPrefix, body, ...(before ? { before } : {}), ...(after ? { after } : {}) };
  };
  // Which an HTML table passes on where the HTML after it ends what's
  // written, with no comment bodies after it, in a block that ends at a
  // blank line, not on the line of a marker, as a comment's, which the next
  // table's lines would go on past
  const rHtml = (body: string) => ({ directivePrefix: '', body,
    ...(join !== undefined && body.endsWith('</table>' + html![1]) && !TABLE_BLOCK_ENDS_AT_MARKER_RE.test(html![0]) ? { join } : {}) });
  // If the original format was HTML or font value is comment-unsafe, emit HTML
  // directly. A table that holds what HTML cells can't goes on as if it had
  // no stored format, to a format that can, unless it needs HTML.
  if ((storedFormat === 'html' && htmlCellsHoldTable(item)) || forceHtmlTable) {
    return rHtml(renderHtmlTable(item, comments, options?.tableIndent, renderOpts, htmlFontAttrs, html));
  }
  // Parse stored grid source column widths for this table
  const gridSrcWidthsStr = tableIndex !== undefined ? renderOpts?.gridSourceColWidthsMapping?.get(String(tableIndex)) : undefined;
  let gridSrcWidths = gridSrcWidthsStr ? gridSrcWidthsStr.split(',').map(Number) : undefined;
  if (gridSrcWidths) {
    const numCols = item.rows.length > 0 ? Math.max(...item.rows.map(r => r.cells.length)) : 0;
    if (gridSrcWidths.length !== numCols || !gridSrcWidths.every(w => Number.isFinite(w) && w >= 0)) {
      gridSrcWidths = undefined;
    }
  }
  // If original was grid, try grid then fall back to HTML (skip pipe, skip width check to preserve format)
  if (storedFormat === 'grid') {
    const gridResult = tryRenderGridTable(item, comments, renderOpts, undefined, gridSrcWidths);
    if (gridResult !== null) return r(gridResult);
    return rHtml(renderHtmlTable(item, comments, options?.tableIndent, renderOpts, htmlFontAttrs, html));
  }
  // When the original was a pipe table, skip the width check to preserve format
  const pipeMax = storedFormat === 'pipe' ? Infinity : (options?.pipeTableMaxLineWidth ?? 120);
  const pipeAligned = tableIndex !== undefined && renderOpts?.pipeTableAlignedMapping?.get(String(tableIndex)) === 'true';
  const pipeResult = tryRenderPipeTable(item, pipeMax, comments, renderOpts, pipeAligned);
  if (pipeResult !== null) {
    return r(pipeResult);
  }
  // For tables without a stored format, try grid before falling back to HTML
  if (storedFormat !== 'pipe') {
    const gridResult = tryRenderGridTable(item, comments, renderOpts, options?.gridTableMaxLineWidth, gridSrcWidths);
    if (gridResult !== null) return r(gridResult);
  }
  // A table HTML cells can't hold, as one with a line break and a comment,
  // is a grid table of any width, which holds it unless it merges cells, or
  // has a cell of paragraphs, which a grid table's cell holds as lines
  if (!htmlCellsHoldTable(item)) {
    const gridResult = tryRenderGridTable(item, comments, renderOpts, undefined, gridSrcWidths);
    if (gridResult !== null) return r(gridResult);
  }
  return rHtml(renderHtmlTable(item, comments, options?.tableIndent, renderOpts, htmlFontAttrs, html));
}

const PARAGRAPH_CONTENT_ELEMENTS = new Set([
  'w:drawing', 'w:pict', 'w:object', 'm:oMath', 'm:oMathPara', 'w:sym', 'w:tab', 'w:br',
  'w:footnoteReference', 'w:endnoteReference', 'w:fldChar', 'w:fldSimple',
]);
const PARAGRAPH_TEXT_ELEMENTS = new Set(['w:t', 'w:delText', 'w:instrText']);

/** Whether a paragraph holds anything besides its properties and markers */
function paragraphCarriesContent(children: XmlNode[]): boolean {
  return children.some(child => Object.keys(child).some(key => key !== 'w:pPr' && key !== ':@'
    && (PARAGRAPH_TEXT_ELEMENTS.has(key) ? nodeText(asXmlNodes(child[key])) !== ''
      : PARAGRAPH_CONTENT_ELEMENTS.has(key) || paragraphCarriesContent(asXmlNodes(child[key])))));
}

/**
 * Task list items: export writes a bulleted one as an indented paragraph
 * starting with ☐ or ☒, and a numbered one in its list, so import finds the
 * glyph, makes the paragraph a list item and takes the glyph off its text.
 * Word may split the glyph and the space after it over runs. A tracked
 * change to them, or a comment on them alone, stays in the text, of a plain
 * list item, since `[ ]` can hold neither.
 */
function markTaskListItems(content: ContentItem[]): void {
  type TextItem = Extract<ContentItem, { type: 'text' }>;
  for (let i = 0; i + 1 < content.length; i++) {
    const item = content[i];
    if (item.type !== 'para' || (!item.listMeta && item.taskLevel === undefined)) continue;
    const box: TextItem[] = [];
    let prefix = '';
    for (let j = i + 1; prefix.length < 2 && content[j]?.type === 'text'; j++) {
      box.push(content[j] as TextItem);
      prefix += (content[j] as TextItem).text;
    }
    const glyph = /^([☐☒]) /.exec(prefix);
    if (!glyph) continue;
    // The text after the box, which a comment on the box goes on over
    const after = prefix.length > 2 ? box[box.length - 1] : content[i + 1 + box.length];
    const afterIds = after && 'commentIds' in after ? after.commentIds : undefined;
    if (box.some(text => text.revision || (text.text !== '' && [...text.commentIds].some(id => !afterIds?.has(id))))) {
      item.listMeta ??= { type: 'bullet', level: item.taskLevel! };
      continue;
    }
    const taskChecked = glyph[1] === '☒';
    item.listMeta = item.listMeta ? { ...item.listMeta, taskChecked } : { type: 'bullet', level: item.taskLevel!, taskChecked };
    let remove = 2;
    box.forEach((text, k) => {
      const take = Math.min(remove, text.text.length);
      content[i + 1 + k] = { ...text, text: text.text.slice(take) };
      remove -= take;
    });
    // Spaces and tabs alone after the box leave the item empty, as they
    // would a paragraph (see dropBlankParagraphText), but not where its mark
    // is tracked, the break before the next paragraph, whose text accepting
    // it puts after them
    let end = i + 1;
    while (end < content.length && !isStructuralBoundaryItem(content[end])) end++;
    const next = content[end];
    if (next?.type === 'para' && next.breakRevision) continue;
    const rest = content.slice(i + 1, end);
    if (rest.every(isBlankText)) rest.forEach((text, k) => { content[i + 1 + k] = { ...text, text: '' }; });
  }
}

function isStructuralBoundaryItem(item: ContentItem): boolean {
  return item.type === 'para'
    || item.type === 'table'
    || item.type === 'landscape_open'
    || item.type === 'landscape_close'
    || item.type === 'portrait_open'
    || item.type === 'portrait_close'
    || item.type === 'bibliography_marker'
    || item.type === 'custom_style_open'
    || item.type === 'custom_style_close';
}

function paragraphHasContent(content: ContentItem[], paraIndex: number): boolean {
  for (let i = paraIndex + 1; i < content.length; i++) {
    if (isStructuralBoundaryItem(content[i])) return false;
    return true;
  }
  return false;
}

/**
 * Whether each of a note's code blocks, in order, goes as the note's
 * paragraphs, which this makes them, as before export wrote code blocks in
 * notes: one that holds what a code block can't, as a Word user may add, a
 * comment, a tracked change, a link, or an item that isn't text, as an
 * equation or image, or whose paragraph marks, or the one before it, are
 * tracked, which a tracked break joins to the paragraph before it. The
 * paragraphs read as text for comments' ranges and tracked breaks then.
 */
function demoteNoteCodeBlocks(body: ContentItem[]): boolean[] {
  const demoted: boolean[] = [];
  for (let i = 0; i < body.length; i++) {
    const item = body[i];
    if (item.type !== 'para' || !item.isCodeBlock) continue;
    let end = i + 1;
    // To a paragraph that isn't code, or a table, which ends one too
    while (end < body.length && body[end].type !== 'table' && !(body[end].type === 'para' && !(body[end] as ParaItem).isCodeBlock)) end++;
    const after = body[end];
    const held = body.slice(i, end).some(line => line.type === 'para'
      ? line.paraMarkRevision || line.breakRevision
      : line.type !== 'text' || line.revision || line.commentIds.size > 0 || line.href !== undefined)
      || after?.type === 'para' && !!after.breakRevision;
    if (held) for (const line of body.slice(i, end)) if (line.type === 'para') line.isCodeBlock = false;
    demoted.push(!!held);
    i = end - 1;
  }
  return demoted;
}

/**
 * The fenced block of the code-block paragraphs from content[start], in the
 * given language, and the index of the item after them. Each code line in
 * DOCX is a { type: 'para', isCodeBlock: true } with the line's text items
 * after it; a para that isn't code ends the block.
 */
function codeBlockFence(content: ContentItem[], start: number, lang: string): { block: string; end: number } {
  let i = start;
  const codeLines: string[] = [];
  let lineText = '';
  let firstLine = true;
  while (i < content.length) {
    const next = content[i];
    if (next.type === 'para' && next.isCodeBlock) {
      if (!firstLine) {
        codeLines.push(lineText);
        lineText = '';
      }
      firstLine = false;
      i++;
      continue;
    }
    if (next.type === 'para' && !next.isCodeBlock) {
      // Non-code-block para — separator between groups or end of block
      break;
    }
    if (next.type === 'text') {
      // A line break of Word's, which reads as Markdown's, \ and a line end,
      // ends a line of the code, which it is in Word, not a \ in it
      const [first, ...rest] = next.text.split('\\\n');
      lineText += first;
      for (const part of rest) {
        codeLines.push(lineText);
        lineText = part;
      }
    } else {
      // Non-para, non-text item (shouldn't typically occur inside a code block)
      break;
    }
    i++;
  }
  // Push the last collected line. Empty lines at the end are the
  // code's, as export writes no paragraph for the fence content's last
  // line end, and Word shows them.
  if (!firstLine) {
    codeLines.push(lineText);
  }

  // Compute fence length: must exceed any run of its character in the
  // content. Tildes where the language has a backtick, which a
  // backtick fence's info string can't hold, and a space before a
  // language that starts with the fence's character, which the fence
  // would take.
  const fenceChar = lang.includes('`') ? '~' : '`';
  let maxRun = 0;
  for (const line of codeLines) {
    const matches = line.match(fenceChar === '`' ? /`+/g : /~+/g);
    if (matches) {
      for (const m of matches) {
        if (m.length > maxRun) maxRun = m.length;
      }
    }
  }
  const fence = fenceChar.repeat(Math.max(3, maxRun + 1));
  return { block: fence + (lang.startsWith(fenceChar) ? ' ' : '') + lang + '\n' + codeLines.join('\n') + '\n' + fence, end: i };
}

/**
 * Export spaces a code block from what follows with an empty paragraph. A
 * plain paragraph after it fills that paragraph with its text; a heading,
 * list item or rule has a para item of its own, which the empty one would add blank
 * lines before, so the empty one goes. An empty paragraph of another shape,
 * as a Word user adds, stays, and buildMarkdown writes it as the blank line
 * before the block.
 */
function dropCodeBlockSeparators(content: ContentItem[]): void {
  let afterCodeBlock = false;
  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (item.type !== 'para') {
      // Only the code block's own text keeps it the last block
      if (item.type !== 'text') afterCodeBlock = false;
      continue;
    }
    const next = content[i + 1];
    if (afterCodeBlock && item.spacerShaped && isPlainEmptyParagraph(item) && item.emptyParagraphCount === 1
        && next?.type === 'para' && (next.headingLevel || next.listMeta || next.horizontalRule)) {
      // One of spaces and tabs alone, which export numbered, still counts
      if (item.blankParagraphs) next.blankParagraphs = (next.blankParagraphs ?? 0) + item.blankParagraphs;
      content.splice(i, 1);
      i--;
      afterCodeBlock = false;
      continue;
    }
    afterCodeBlock = !!item.isCodeBlock;
  }
}

/**
 * Export keeps tables apart with an empty paragraph, as Word joins tables
 * with nothing between them into one, which is nothing in Markdown: the
 * one alone between two tables goes, as a Word user's does, so the next
 * table goes on in the HTML block of the one before it, where it can. A
 * note's paragraph is plain (`plain`) but for code and a tracked break.
 * One of spaces and tabs alone, which export numbered, still counts, with
 * the next paragraph's (see blankParagraphs).
 */
function dropTableSeparators(content: ContentItem[], plain: (item: Extract<ContentItem, { type: 'para' }>) => boolean): void {
  for (let i = 1; i + 1 < content.length; i++) {
    const item = content[i];
    if (content[i - 1].type === 'table' && content[i + 1].type === 'table' && item.type === 'para' && plain(item)) {
      const next = item.blankParagraphs ? content.slice(i + 1).find(after => after.type === 'para') : undefined;
      if (next?.type === 'para') next.blankParagraphs = (next.blankParagraphs ?? 0) + item.blankParagraphs!;
      content.splice(i, 1);
    }
  }
}

/** Whether export numbers a paragraph of this kind among the body's, for
 *  indent overrides, where it has text (see blankParagraphs) */
function isNumberedParagraphKind(item: ParaItem): boolean {
  return !item.headingLevel && !item.isTitle && !item.isCodeBlock && !item.listMeta && !item.blockquoteLevel && !item.horizontalRule;
}

function isPlainEmptyParagraph(item: Extract<ContentItem, { type: 'para' }>): boolean {
  return !item.headingLevel
    && !item.listMeta
    && !item.isTitle
    && !item.blockquoteLevel
    && !item.isCodeBlock
    && !item.generatedListContinuation
    && !item.customStyleName
    && item.emptyParagraphCount !== undefined;
}

function clearListContextsFromLevel(contexts: Map<number, StructuralListContext>, minLevel: number): void {
  for (const level of [...contexts.keys()]) {
    if (level >= minLevel) contexts.delete(level);
  }
}

/**
 * The number import writes for an ordered list item, from the per-level
 * counters, which it moves on. A new list or sub-list starts at the number
 * Word shows. Where Word starts a top-level list over and Markdown would go
 * on with the one before, the item restarts, and needs a break before it.
 * (Markdown can't restart a nested list without one, so those go on.)
 * `listTypesByLevel` tracks the list type at each nesting level
 * independently, so returning from a nested sub-list (e.g. ordered → bullet
 * → back to ordered) correctly identifies the parent ordered list as a
 * continuation, where the type of the item before would reset the counter.
 */
function nextOrderedNumber(
  listMeta: ListMeta,
  orderedCounters: Map<number, number>,
  listTypesByLevel: Map<number, 'bullet' | 'ordered'>,
  lastListLevel: number | undefined,
): { number: number; isNew: boolean; restarts: boolean } {
  // The type at this item's own level: a deeper ordered list says nothing
  // about a bullet list here
  const isNewListContext = listTypesByLevel.get(listMeta.level) !== 'ordered';
  const isNewSubList = lastListLevel !== undefined && listMeta.level > lastListLevel;
  const isNew = isNewListContext || isNewSubList;
  // Word starts a list over where Markdown would carry it on
  const restarts = !isNew && listMeta.wordNumber !== undefined
    && (listMeta.wordStarts === true || listMeta.wordNumber !== (orderedCounters.get(listMeta.level) ?? 1));
  if (isNew || restarts) orderedCounters.set(listMeta.level, listMeta.wordNumber ?? listMeta.startNumber ?? 1);
  const number = orderedCounters.get(listMeta.level) ?? 1;
  orderedCounters.set(listMeta.level, number + 1);
  return { number, isNew, restarts };
}

function inferOrderedMarkerWidth(
  listMeta: ListMeta,
  orderedCounters: Map<number, number>,
  listTypesByLevel: Map<number, 'bullet' | 'ordered'>,
  lastListLevel: number | undefined,
): number | undefined {
  if (listMeta.type !== 'ordered') return undefined;
  const { number } = nextOrderedNumber(listMeta, orderedCounters, listTypesByLevel, lastListLevel);
  return String(number).length + 2;
}

/** A paragraph in the item at `context`'s level, which indents by that
 *  item's marker and the markers of the items it's in. A level Word skipped
 *  has no item to indent by, as buildMarkdown nests an item right under the
 *  open one above it. */
function continuationOf(context: StructuralListContext, listContexts: Map<number, StructuralListContext>): ListContinuation {
  let indent = 0;
  for (const item of listContexts.values()) {
    if (item.level <= context.level) indent += item.markerWidth ?? (item.type === 'bullet' ? 2 : 3);
  }
  return {
    type: context.type,
    level: context.level,
    ...(context.markerWidth !== undefined ? { markerWidth: context.markerWidth } : {}),
    indent,
  };
}

function inferListContinuationForBlockquote(
  item: Extract<ContentItem, { type: 'para' }>,
  listContexts: Map<number, StructuralListContext>,
): { blockquoteLevel: number; listContinuation?: ListContinuation } | undefined {
  if (!item.blockquoteLevel || item.paragraphLeftIndentTwips === undefined || item.blockquoteIndentUnitTwips === undefined) {
    return undefined;
  }
  const fallback = { blockquoteLevel: item.blockquoteLevel };
  if (listContexts.size === 0) return fallback;

  const rawIndent = item.paragraphLeftIndentTwips;
  const unit = item.blockquoteIndentUnitTwips;
  const candidates = [...listContexts.values()].sort((a, b) => b.level - a.level);
  for (const context of candidates) {
    const continuationIndent = 720 * (context.level + 1);
    const adjustedIndent = rawIndent - continuationIndent;
    if (adjustedIndent < unit || adjustedIndent % unit !== 0) continue;
    const inferredLevel = adjustedIndent / unit;
    if (!Number.isInteger(inferredLevel) || inferredLevel < 1) continue;
    return { blockquoteLevel: inferredLevel, listContinuation: continuationOf(context, listContexts) };
  }

  return fallback;
}

function alertGlyphForType(alertType: GfmAlertType): string | undefined {
  for (const [glyph, type] of Object.entries(ALERT_GLYPH_TO_TYPE)) {
    if (type === alertType) return glyph;
  }
  return undefined;
}

function paragraphStartsWithExportedAlertLead(
  content: ContentItem[],
  paraIndex: number,
  alertType: GfmAlertType,
): boolean {
  const glyph = alertGlyphForType(alertType);
  if (!glyph) return false;
  const expectedLead = glyph + ' ' + gfmAlertTitle(alertType) + ' ';
  let sawLead = false;

  for (let i = paraIndex + 1; i < content.length; i++) {
    const item = content[i];
    if (isStructuralBoundaryItem(item)) break;
    if (item.type !== 'text') return false;
    if (!sawLead) {
      if (!item.formatting.bold || item.text !== expectedLead) return false;
      sawLead = true;
      continue;
    }
    return item.text.startsWith('\\\n');
  }

  return false;
}

function isRenderableNonBlockquoteStructuralItem(
  content: ContentItem[],
  contentIndex: number,
  item: ContentItem,
): boolean {
  if (item.type === 'table') return true;
  if (item.type !== 'para') return false;
  if (item.blockquoteLevel) return false;
  return !isPlainEmptyParagraph(item) || paragraphHasContent(content, contentIndex);
}

function hasRenderableInlineContent(content: ContentItem[], startIndex: number, endIndex: number): boolean {
  for (let i = startIndex; i < endIndex; i++) {
    if (!isStructuralBoundaryItem(content[i])) return true;
  }
  return false;
}

function deriveBlockquoteSpacingFromStructure(content: ContentItem[]): {
  derivedBlockquoteGaps: Map<number, number>;
  derivedBlockquotePreContentBlankLines: Map<number, number>;
  derivedBlockquotePostContentBlankLines: Map<number, number>;
} {
  const structuralItems = content.flatMap((item, index) =>
    isStructuralBoundaryItem(item) && !(item.type === 'para' && item.isBlockquoteSpacer)
      ? [{ item, index }]
      : []
  );
  const groups: Array<{ groupIndex: number; startPos: number; endPos: number }> = [];

  for (let pos = 0; pos < structuralItems.length; pos++) {
    const entry = structuralItems[pos];
    if (entry.item.type !== 'para' || entry.item.blockquoteGroupIndex === undefined) continue;
    const currentGroupIndex = entry.item.blockquoteGroupIndex;
    const lastGroup = groups.length > 0 ? groups[groups.length - 1] : undefined;
    if (lastGroup && lastGroup.groupIndex === currentGroupIndex) {
      lastGroup.endPos = pos;
    } else {
      groups.push({ groupIndex: currentGroupIndex, startPos: pos, endPos: pos });
    }
  }

  const derivedBlockquoteGaps = new Map<number, number>();
  const derivedBlockquotePreContentBlankLines = new Map<number, number>();
  const derivedBlockquotePostContentBlankLines = new Map<number, number>();

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];

    let preBlankCount = 0;
    let prePos = group.startPos - 1;
    while (prePos >= 0) {
      const entry = structuralItems[prePos];
      if (entry.item.type === 'para' && isPlainEmptyParagraph(entry.item) && !paragraphHasContent(content, entry.index)) {
        preBlankCount += entry.item.emptyParagraphCount ?? 1;
        prePos--;
        continue;
      }
      break;
    }
    const preRangeStart = prePos >= 0 ? structuralItems[prePos].index + 1 : 0;
    const preRangeEnd = preBlankCount > 0
      ? structuralItems[prePos + 1].index
      : structuralItems[group.startPos].index;
    const hasPrecedingContent = (prePos >= 0
      && isRenderableNonBlockquoteStructuralItem(content, structuralItems[prePos].index, structuralItems[prePos].item))
      || hasRenderableInlineContent(content, preRangeStart, preRangeEnd);
    if (preBlankCount > 0 && hasPrecedingContent) {
      derivedBlockquotePreContentBlankLines.set(group.groupIndex, preBlankCount);
    }

    let postBlankCount = 0;
    let postPos = group.endPos + 1;
    while (postPos < structuralItems.length) {
      const entry = structuralItems[postPos];
      if (entry.item.type === 'para' && isPlainEmptyParagraph(entry.item) && !paragraphHasContent(content, entry.index)) {
        postBlankCount += entry.item.emptyParagraphCount ?? 1;
        postPos++;
        continue;
      }
      break;
    }
    const postRangeStart = postBlankCount > 0
      ? structuralItems[postPos - 1].index + 1
      : structuralItems[group.endPos].index + 1;
    const postRangeEnd = postPos < structuralItems.length ? structuralItems[postPos].index : content.length;
    const hasFollowingContent = (postPos < structuralItems.length
      && isRenderableNonBlockquoteStructuralItem(content, structuralItems[postPos].index, structuralItems[postPos].item))
      || hasRenderableInlineContent(content, postRangeStart, postRangeEnd);
    if (postBlankCount > 0 && hasFollowingContent) {
      derivedBlockquotePostContentBlankLines.set(group.groupIndex, postBlankCount);
    }

    const nextGroup = gi + 1 < groups.length ? groups[gi + 1] : undefined;
    if (!nextGroup) continue;

    let gapBlankCount = 0;
    let sawInterveningContent = false;
    for (let pos = group.endPos + 1; pos < nextGroup.startPos; pos++) {
      const entry = structuralItems[pos];
      if (entry.item.type === 'para' && isPlainEmptyParagraph(entry.item) && !paragraphHasContent(content, entry.index)) {
        gapBlankCount += entry.item.emptyParagraphCount ?? 1;
      } else if (isRenderableNonBlockquoteStructuralItem(content, entry.index, entry.item)) {
        sawInterveningContent = true;
      }
    }
    derivedBlockquoteGaps.set(group.groupIndex, sawInterveningContent ? -1 : gapBlankCount);
  }

  return {
    derivedBlockquoteGaps,
    derivedBlockquotePreContentBlankLines,
    derivedBlockquotePostContentBlankLines,
  };
}

function annotateStructuralParagraphMetadata(content: ContentItem[]): {
  derivedBlockquoteGaps: Map<number, number>;
  derivedBlockquotePreContentBlankLines: Map<number, number>;
  derivedBlockquotePostContentBlankLines: Map<number, number>;
} {
  const listContexts = new Map<number, StructuralListContext>();
  const listTypesByLevel = new Map<number, 'bullet' | 'ordered'>();
  const orderedCounters = new Map<number, number>();
  let lastListLevel: number | undefined;
  let nextBlockquoteGroupIndex = 0;
  let currentBlockquoteGroupIndex: number | undefined;
  let lastBlockquoteLevel: number | undefined;
  let lastBlockquoteType: GfmAlertType | 'plain' | undefined;
  let lastBlockquoteListLevel: number | undefined;

  for (let i = 0; i < content.length; i++) {
    const item = content[i];

    if (item.type === 'para') {
      if (item.isBlockquoteSpacer) {
        currentBlockquoteGroupIndex = undefined;
        lastBlockquoteLevel = undefined;
        lastBlockquoteType = undefined;
        continue;
      }
      // A numbered heading is a heading, which ends a list, as buildMarkdown
      // writes it
      if (item.listMeta && !item.headingLevel) {
        clearListContextsFromLevel(listContexts, item.listMeta.level + 1);
        for (const level of [...listTypesByLevel.keys()]) {
          if (level > item.listMeta.level) listTypesByLevel.delete(level);
        }
        for (const level of [...orderedCounters.keys()]) {
          if (level > item.listMeta.level) orderedCounters.delete(level);
        }
        const markerWidth = inferOrderedMarkerWidth(
          item.listMeta,
          orderedCounters,
          listTypesByLevel,
          lastListLevel,
        );
        listTypesByLevel.set(item.listMeta.level, item.listMeta.type);
        listContexts.set(item.listMeta.level, {
          type: item.listMeta.type,
          level: item.listMeta.level,
          ...(markerWidth !== undefined ? { markerWidth } : {}),
        });
        lastListLevel = item.listMeta.level;
        currentBlockquoteGroupIndex = undefined;
        lastBlockquoteLevel = undefined;
        lastBlockquoteType = undefined;
        continue;
      }

      if (item.blockquoteLevel) {
        const inferred = inferListContinuationForBlockquote(item, listContexts);
        if (inferred) {
          item.blockquoteLevel = inferred.blockquoteLevel;
          if (inferred.listContinuation) item.listContinuation = inferred.listContinuation;
        }
        // A quote out of the list ends it, as buildMarkdown writes it, and a
        // paragraph indented for an item after it is in no item
        if (!item.listContinuation) {
          listContexts.clear();
          listTypesByLevel.clear();
          orderedCounters.clear();
        }
        const currentType: GfmAlertType | 'plain' = item.alertType || 'plain';
        // A quote nested in a list and one outside it are separate groups, as
        // annotateBlockquoteBoundaries in md-to-docx.ts groups them on export
        const listLevel = item.listContinuation?.level;
        const startsNewGroup = currentBlockquoteGroupIndex === undefined
          || item.blockquoteLevel !== lastBlockquoteLevel
          || currentType !== lastBlockquoteType
          || listLevel !== lastBlockquoteListLevel
          || (item.alertType !== undefined && paragraphStartsWithExportedAlertLead(content, i, item.alertType));
        if (startsNewGroup) {
          currentBlockquoteGroupIndex = nextBlockquoteGroupIndex++;
        }
        item.blockquoteGroupIndex = currentBlockquoteGroupIndex;
        lastBlockquoteLevel = item.blockquoteLevel;
        lastBlockquoteType = currentType;
        lastBlockquoteListLevel = listLevel;
        lastListLevel = undefined;
        continue;
      }

      if (item.generatedListContinuation && item.paragraphLeftIndentTwips !== undefined) {
        const continuationLevel = item.paragraphLeftIndentTwips / 720 - 1;
        const context = listContexts.get(continuationLevel);
        if (context) item.listContinuation = continuationOf(context, listContexts);
      }

      if (item.listContinuation) {
        const context = listContexts.get(item.listContinuation.level);
        if (context?.markerWidth !== undefined && item.listContinuation.markerWidth === undefined) {
          item.listContinuation.markerWidth = context.markerWidth;
        }
        if (context && item.listContinuation.indent === undefined) {
          const { indent } = continuationOf(context, listContexts);
          if (indent !== undefined) item.listContinuation.indent = indent;
        }
        currentBlockquoteGroupIndex = undefined;
        lastBlockquoteLevel = undefined;
        lastBlockquoteType = undefined;
        continue;
      }

      if (!isPlainEmptyParagraph(item) || paragraphHasContent(content, i)) {
        listContexts.clear();
        listTypesByLevel.clear();
        orderedCounters.clear();
        lastListLevel = undefined;
      }
      currentBlockquoteGroupIndex = undefined;
      lastBlockquoteLevel = undefined;
      lastBlockquoteType = undefined;
      continue;
    }

    if (isStructuralBoundaryItem(item)) {
      listContexts.clear();
      listTypesByLevel.clear();
      orderedCounters.clear();
      lastListLevel = undefined;
      currentBlockquoteGroupIndex = undefined;
      lastBlockquoteLevel = undefined;
      lastBlockquoteType = undefined;
    }
  }

  return deriveBlockquoteSpacingFromStructure(content);
}

/** The inline content on each side of a tracked paragraph break: whether
 *  there is any; undefined where a table or other block intervenes. */
type TrackedBreakSide = { content: boolean } | undefined;

/**
 * The content on each side of each tracked break in `content`, by the
 * break's paragraph's index (see TrackedBreakSide). A side reads through any
 * further breaks tracked with the same type, since Word joins across those
 * too, and through a break that opens the new side of a substitution, as in
 * {~~a\n\nb~>\n\nc~~}, which the same CriticMarkup span holds. After the
 * break, a block after the paragraph's text, as the bibliography after the
 * last paragraph, ends it, and a custom style block's close does; one right
 * at the break intervenes. One pass each way, for both types at once:
 * reading each break's sides across a run of breaks took time in the
 * square of their number.
 */
function contentAroundTrackedBreaks(content: ContentItem[]): Map<number, { before: TrackedBreakSide; after: TrackedBreakSide }> {
  type Side = { content: boolean; end: 'open' | 'block' | 'none' };
  const types: RevisionInfo['type'][] = ['addition', 'deletion'];
  const fresh = (): Side => ({ content: false, end: 'none' });
  const read = (side: Side): TrackedBreakSide => side.end === 'none' ? { content: side.content } : undefined;
  const passes = (k: number, type: RevisionInfo['type']) => (content[k] as ParaItem).breakRevision?.type === type || opensNewSide(content, k);
  const sides = new Map<number, { before: TrackedBreakSide; after: TrackedBreakSide }>();
  // Before each break, from the start: a block before the content ends
  // the side with none, whatever comes between
  let state = { addition: fresh(), deletion: fresh() };
  for (let k = 0; k < content.length; k++) {
    const item = content[k];
    if (item.type === 'para') {
      if (item.breakRevision) sides.set(k, { before: read(state[item.breakRevision.type]), after: undefined });
      for (const type of types) if (!passes(k, type)) state[type] = fresh();
    } else if (isStructuralBoundaryItem(item) || (item.type === 'math' && item.display)) {
      for (const type of types) state[type] = { ...fresh(), end: 'block' };
    } else {
      for (const type of types) {
        if (state[type].end === 'none') state[type] = { content: true, end: 'none' };
      }
    }
  }
  // After each break, from the end: a block ends the side with what comes
  // before it, if anything does, but display math has none
  state = { addition: fresh(), deletion: fresh() };
  for (let k = content.length - 1; k >= 0; k--) {
    const item = content[k];
    if (item.type === 'para') {
      if (item.breakRevision) sides.get(k)!.after = read(state[item.breakRevision.type]);
      for (const type of types) if (!passes(k, type)) state[type] = fresh();
    } else if (item.type === 'custom_style_close') {
      state = { addition: fresh(), deletion: fresh() };
    } else if (isStructuralBoundaryItem(item)) {
      for (const type of types) state[type] = { ...fresh(), end: 'open' };
    } else if (item.type === 'math' && item.display) {
      for (const type of types) state[type] = { ...fresh(), end: 'block' };
    } else {
      for (const type of types) {
        if (state[type].end !== 'block') state[type] = { content: true, end: 'none' };
      }
    }
  }
  return sides;
}

type ParaItem = Extract<ContentItem, { type: 'para' }>;

/** Whether the paragraph at `index` starts with an inserted break that opens
 *  the new side of a substitution, right after its old side, as in
 *  {~~a~>\n\nb~~}. */
function opensNewSide(content: ContentItem[], index: number): boolean {
  const para = content[index];
  // Past a comment's reference, as of {~~a{>>c<<}~>\n\nb~~}
  let before = index - 1;
  while (before >= 0 && isCommentPoint(content[before])) before--;
  const prev = content[before];
  return para?.type === 'para' && para.breakRevision?.type === 'addition'
    && !!prev && isInlineRevisionItem(prev) && revisionsEqual(prev.revision, { ...para.breakRevision, type: 'deletion' });
}

/** Whether the heading at `index`, whose mark is tracked, has its text all
 *  in the mark's revision, beside comments, which buildMarkdown writes as
 *  {++# heading++}, the form export reads all of back as the revised heading */
function headingInMarkRevision(content: ContentItem[], index: number): boolean {
  const heading = content[index];
  if (heading?.type !== 'para' || !heading.paraMarkRevision) return false;
  for (let j = index + 1; j < content.length; j++) {
    const part = content[j];
    if (!isInlineRevisionItem(part) && part.type !== 'html_comment') break;
    if (isCommentPoint(part)) continue;
    if (part.type === 'html_comment' || part.revision?.type !== heading.paraMarkRevision.type) return false;
  }
  return true;
}

/** A comment's reference with no text of its own around it, as {>>c<<} */
function isCommentPoint(item: ContentItem | undefined): boolean {
  return item?.type === 'text' && item.text === '' && item.commentIds.size > 0 && !item.revision;
}

/** Inline content that can sit in a CriticMarkup span. */
function isInlineRevisionItem(item: ContentItem): item is Extract<ContentItem, { type: 'text' | 'citation' | 'math' | 'footnote_ref' | 'image' }> {
  return item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'image' || (item.type === 'math' && !item.display);
}

/** Whether buildMarkdown writes a quote's prefix on each line of the
 *  paragraph's text, after a line break or in a comment's body, and before
 *  the comment bodies after it */
function prefixesQuoteLines(para: ParaItem): boolean {
  return !!para.blockquoteLevel && !para.headingLevel && !para.listMeta && !para.isCodeBlock;
}

/** Where a paragraph sits, for joining it to a neighbour across a tracked
 *  break: the body, a list item, or a quote at a given level, in a custom
 *  style block or not. A heading before the break is in the body, as
 *  export makes the text after a break in a heading's line a body
 *  paragraph. Undefined for blocks that can't take part, and for a list
 *  item or heading after the break, which starts a new block rather than
 *  continuing one. */
function breakContainer(para: ParaItem | undefined, side: 'before' | 'after'): string | undefined {
  if (!para) return 'body';
  if (para.isTitle || para.isCodeBlock) return undefined;
  if (para.headingLevel) {
    return side === 'before' && !para.blockquoteLevel && !para.listMeta && !para.listContinuation && !para.customStyleName ? 'body' : undefined;
  }
  // Paragraphs in one custom style share a block (see custom_style_open)
  const style = para.customStyleName ? ' in style ' + para.customStyleName : '';
  const list = para.listContinuation ? 'list' + para.listContinuation.level : '';
  if (para.blockquoteLevel) return list + '>' + para.blockquoteLevel + (para.alertType ?? '') + style;
  if (para.listMeta) return side === 'before' ? 'list' + para.listMeta.level + style : undefined;
  return (list || 'body') + style;
}

/** Characters around the text of a tracked paragraph break, so
 *  joinSpansAtTrackedBreaks can find it in the rendered Markdown. */
interface TrackedBreakMarks {
  start: string;
  end: string;
  /** In place of `start` for a break in a span of its own, which has no
   *  `end` */
  alone: string;
  /** In place of the indent of a list item's text after a break that ends
   *  it, which buildMarkdown knows once it writes the item, at the level
   *  it can nest it at (see atOpenListDepth) */
  indent: string;
}

/** Four private-use characters that appear nowhere in `values`, which hold
 *  everything buildMarkdown renders, so no text in the document is taken
 *  for a mark. */
function trackedBreakMarks(values: unknown): TrackedBreakMarks {
  const text = JSON.stringify(values, (_key, value: unknown) => value instanceof Map || value instanceof Set ? [...value] : value);
  const unused: string[] = [];
  for (let code = 0xE000; unused.length < 4; code++) {
    const ch = String.fromCharCode(code);
    if (!text.includes(ch)) unused.push(ch);
  }
  return { start: unused[0], end: unused[1], alone: unused[2], indent: unused[3] };
}

/** A paragraph break tracked in Word goes inside the CriticMarkup span as a
 *  blank line, as in {--end.\n\nStart--}, even where nothing of the change
 *  is left on one side of it once accepted or rejected, as for a paragraph
 *  deleted with its mark, {--a\n\n--}b, which export writes back as it was.
 *  One whose mark Word doesn't track stays a span of its own, {--a--}.
 *  The break joins the span of the inline content before it in the same
 *  revision, or, opening the new side of a substitution, as in
 *  {~~a~>\n\nb~~}, its old side. After inline content in no revision or
 *  another, it is a span of its own, as in a{--\n\n--}b, which ends there:
 *  md-to-docx moves a break that opens a span with text in it outside it
 *  (see moveLeadingBreakOutsideCritic), but keeps a span of the break
 *  alone. Both paragraphs must sit in the same list item or
 *  quote, and `linePrefix` gives the line prefix (quote markers, list indent)
 *  to start the line after the break, from the second paragraph and the one
 *  whose text the break joins it to. Where the paragraph after can't take
 *  the text before the break, as a list item, a heading, a rule or a
 *  paragraph out of the quote, or there's no text after it, the break ends
 *  its own paragraph's text, as in a{--\n\n--} before - b, which export
 *  reads as that paragraph's tracked mark, with the line prefix of that
 *  paragraph. A heading's mark is a break after its text, # a{--\n\n--}b,
 *  but for a heading all in the mark's revision, {--# a--}. The break is plain text,
 *  so formatting, code and links close before it, and
 *  joinSpansAtTrackedBreaks then joins its span to the spans around it. */
function joinTrackedParagraphBreaks(content: ContentItem[], marks: () => TrackedBreakMarks, linePrefix: (para: ParaItem, opening: ParaItem | undefined) => string = () => ''): ContentItem[] {
  // The content up to `copied`, and the breaks' in place of their
  // paragraphs: inserting each into a copy of all of it moved what came
  // after, in time in the square of the breaks' number
  let joined: ContentItem[] | undefined;
  let copied = 0;
  // The citations that start a paragraph after a break, by index
  const lineStarts = new Set<number>();
  const copy = (to: number) => {
    for (; copied < to; copied++) {
      const item = content[copied];
      joined!.push(lineStarts.has(copied) && item.type === 'citation' ? { ...item, lineStart: true } : item);
    }
  };
  let sides: ReturnType<typeof contentAroundTrackedBreaks> | undefined;
  for (let k = 0; k < content.length; k++) {
    const para = content[k];
    if (para.type !== 'para' || !para.breakRevision) continue;
    const revision = para.breakRevision;
    // A comment's reference alone, as of {--a{>>c<<}\n\nb--}, goes after
    // a break that joins the span before it, as one can't go in the span,
    // and a span that starts with the break loses it
    let last = k - 1;
    while (last >= 0 && isCommentPoint(content[last])) last--;
    const prev = content[last];
    if (!prev || !isInlineRevisionItem(prev)) continue;
    let openingIndex = k - 1;
    while (openingIndex >= 0 && content[openingIndex].type !== 'para') openingIndex--;
    const opening = content[openingIndex] as ParaItem | undefined;
    // A heading all in its mark's revision holds the mark, as {++# a++}
    if (opening?.headingLevel && headingInMarkRevision(content, openingIndex)) continue;
    sides ??= contentAroundTrackedBreaks(content);
    const { before, after } = sides.get(k)!;
    if (!before) continue;
    const container = breakContainer(para, 'after');
    // Not to a paragraph with an indent override, or that is a thematic
    // break, which the break's text in its place can't hold
    const joins = !!container && breakContainer(opening, 'before') === container
      && !para.indentOverride && !para.horizontalRule && !!after?.content;
    // Else the break ends its paragraph, though not code's or a title's
    if (!joins && (opening?.isCodeBlock || opening?.isTitle)) continue;
    const alone = !(joins && opensNewSide(content, k)) && !revisionsEqual(prev.revision, revision);
    joined ??= [];
    copy(last + 1);
    // A list item's own indent, which buildMarkdown knows once it writes
    // the item, goes in for its mark after a break that ends its text
    const prefix = joins ? linePrefix(para, opening) : opening?.listMeta ? marks().indent : opening ? linePrefix(opening, opening) : '';
    // A break alone has no end mark, so it ends with the next line's start,
    // which what comes after reads, as a citation does to put no space there
    const text = (alone ? marks().alone : marks().start) + '\n' + (prefix === marks().indent ? '' : prefix.trimEnd()) + '\n' + prefix + (alone ? '' : marks().end);
    // A break in a span of its own is in a comment's range where the text
    // on both sides is, past empty paragraphs, or a range that starts at
    // the paragraph's mark, whose empty item (see startRangesAtMark) comes
    // before it
    let nextIndex = k + 1;
    while (content[nextIndex]?.type === 'para') nextIndex++;
    const next = content[nextIndex];
    const commentIds = alone
      ? new Set(content.slice(last, k).flatMap(item => 'commentIds' in item ? [...item.commentIds ?? []] : [])
        .filter(id => next && 'commentIds' in next && next.commentIds?.has(id)))
      : new Set(prev.commentIds);
    const item: ContentItem = { type: 'text', text, commentIds, formatting: DEFAULT_FORMATTING, revision };
    // and ends it: empty text in no revision keeps the text after from
    // running into it, from joining its span, and from pairing with it as
    // a substitution's new side
    const barrier: ContentItem[] = alone && joins ? [{ type: 'text', text: '', commentIds: new Set(commentIds), formatting: DEFAULT_FORMATTING }] : [];
    // A comment's reference before it stays there, outside its span
    const points = content.slice(last + 1, k);
    joined.push(...(alone ? [...points, item, ...barrier] : [item, ...points]));
    // The paragraph after a break that ends its own stays
    copied = joins ? k + 1 : k;
    if (!joins) continue;
    // Past a comment's range's start
    let first = k + 1;
    for (let item = content[first]; item?.type === 'text' && item.text === '' && !item.revision; item = content[++first]);
    if (content[first]?.type === 'citation') lineStarts.add(first);
  }
  if (!joined) return content;
  copy(content.length);
  return joined;
}

/** Whether `text` before `at` ends with the closer of a tracked break's
 *  span, as joinSpansAtTrackedBreaks finds one, after the break's end mark,
 *  or a break alone and the line prefixes after it, a list item's indent's
 *  mark too, which it takes for one */
function afterTrackedBreakSpan(text: string, at: number, marks: TrackedBreakMarks): boolean {
  const closer = text.slice(at - 3, at);
  if (closer !== '--}' && closer !== '++}') return false;
  let k = at - 3;
  if (text[k - 1] === marks.end) return true;
  const prefix = (ch: string | undefined) => ch === '>' || ch === ' ' || ch === '\t' || ch === marks.indent;
  for (let line = 0; line < 2; line++) {
    while (k > 0 && prefix(text[k - 1])) k--;
    if (text[k - 1] !== '\n') return false;
    k--;
  }
  return text[k - 1] === marks.alone;
}

/** A paragraph's text before an equation it goes on in, on the next line,
 *  without the space export wrote for the text's line end, and with the
 *  spaces before that, which Word shows before the equation, but Markdown
 *  would drop before the line end, one, or read as a line break, two, as
 *  references, and a backslash before them, which would escape the line
 *  end, escaped. The space alone, with no text before it, stays, which
 *  the math branch takes off, as it writes the equation on the line after,
 *  and so does the text of an HTML block, which would show references and
 *  a backslash's escape as text, as withoutEndSpaces leaves it. */
function beforeParagraphMath(text: string): string {
  if (!text.endsWith(' ') || /^ +$/.test(text)) return text;
  const end = text.length - 1;
  let space = end;
  while (space > 0 && text[space - 1] === ' ') space--;
  if (text.includes('<') && isInsideCodeRegion(Math.max(space - 1, 0), computeMarkdownRegions(text, { includeCode: false, html: 'all' }).htmlRegions)) return text;
  let slashes = 0;
  while (slashes < space && text[space - 1 - slashes] === '\\') slashes++;
  return text.slice(0, space) + (slashes % 2 === 1 ? '\\' : '') + '&#32;'.repeat(end - space);
}

/** Markdown with each tracked break from joinTrackedParagraphBreaks inside
 *  the spans before and after it, as in {++**a**\n\nmore++} rather than
 *  {++**a**++}{++\n\n++}{++more++}, and the spaces and tabs the span has at
 *  the ends of the lines around it, which export would drop there, as
 *  references, as in {--a\n\n&#32;b--}, and after a span the break ends,
 *  where they end the line, as a paragraph of them after a tracked mark
 *  does in a{--\n\n--}&#32;. */
function joinSpansAtTrackedBreaks(text: string, marks: TrackedBreakMarks): string {
  const markdown = text.replace(new RegExp('(' + marks.end + '|' + marks.alone + '\\n[> \\t]*\\n[> \\t]*)((?:--|\\+\\+)\\})([ \\t]+)(?=\\n|$)', 'g'),
    (_m, mark: string, closer: string, whitespace: string) => mark + closer + whitespace.replace(/[ \t]/g, c => c === ' ' ? '&#32;' : '&#9;'));
  const boundary = '(?:\\+\\+\\}\\{\\+\\+|--\\}\\{--)?';
  const marked = new RegExp('(' + boundary + ')(' + SPAN_AT_BREAK + '?)' + marks.start + '([^' + marks.end + ']*)' + marks.end + boundary + '([ \\t]*)', 'g');
  let out = '';
  let from = 0;
  for (const match of markdown.matchAll(marked)) {
    // The text before ends the paragraph: a line break as \ before a line
    // end, which Markdown drops there and keeps the \ as text, is <br>, as
    // at a paragraph's end, and a backslash, which the mark kept from
    // escaping anything, but which would make a line break of the line
    // end, is escaped
    let before = markdown.slice(from, match.index);
    // From the end, each with the next line's prefix, as a quote's, after it
    let end = before.length;
    let breaks = 0;
    for (;;) {
      let line = end;
      while (line > 0 && /[> \t]/.test(before[line - 1])) line--;
      let slashes = 0;
      if (before[line - 1] === '\n') while (before[line - 2 - slashes] === '\\') slashes++;
      if (slashes % 2 === 0) break;
      breaks++;
      end = line - 2;
    }
    if (breaks > 0) {
      before = before.slice(0, end) + '<br>'.repeat(breaks);
    } else {
      // Spaces and tabs at its end, which export would drop there, as
      // references, after the backslash before them, escaped, which would
      // escape the first
      let space = before.length;
      while (space > 0 && (before[space - 1] === ' ' || before[space - 1] === '\t')) space--;
      let slashes = 0;
      while (before[space - 1 - slashes] === '\\') slashes++;
      before = before.slice(0, space) + (slashes % 2 ? '\\' : '') + before.slice(space).replace(/[ \t]/g, c => c === ' ' ? '&#32;' : '&#9;');
    }
    // A break that opened its span, which the span before it, as one in a
    // link, didn't take, nor joins here, ends it, as it would be lost there:
    // md-to-docx moves a break that opens a span with text in it out of the
    // span (see moveLeadingBreakOutsideCritic). Its mark tells its opener
    // from text's.
    const opener = !match[1] && match[2] ? before.slice(-3) : '';
    const closer = opener.slice(1) + '}';
    const after = match.index + match[0].length;
    const split = opener && !markdown.startsWith(closer, after) ? closer + opener : '';
    out += before + match[3] + split + match[4].replace(/[ \t]/g, c => c === ' ' ? '&#32;' : '&#9;');
    from = after;
  }
  return (out + markdown.slice(from)).split(marks.alone).join('').split(marks.indent).join('').split(SPAN_AT_BREAK).join('');
}

/** Adds `value` to `heap`, a binary heap of numbers with the least on top */
function pushInOrder(heap: number[], value: number): void {
  let at = heap.push(value) - 1;
  for (let parent = (at - 1) >> 1; at > 0 && heap[parent] > value; at = parent, parent = (at - 1) >> 1) heap[at] = heap[parent];
  heap[at] = value;
}

/** Takes the least number off `heap`, a binary heap of them (see
 *  pushInOrder), which isn't empty */
function popLeast(heap: number[]): number {
  const least = heap[0];
  const last = heap.pop()!;
  if (heap.length === 0) return least;
  let at = 0;
  for (let child = 1; child < heap.length; at = child, child = 2 * at + 1) {
    if (child + 1 < heap.length && heap[child + 1] < heap[child]) child++;
    if (heap[child] >= last) break;
    heap[at] = heap[child];
  }
  heap[at] = last;
  return least;
}

export function buildMarkdown(
  content: ContentItem[],
  comments: Map<string, Comment>,
  options?: { tableIndent?: string; alwaysUseCommentIds?: boolean; pipeTableMaxLineWidth?: number; gridTableMaxLineWidth?: number; commentIdMapping?: Map<string, string> | null; notes?: { map: Map<string, { label: string; body: ContentItem[]; noteKind: 'footnote' | 'endnote' }>; assignedLabels: Map<string, string> }; codeBlockLangs?: Map<string, string> | null; blockquoteGaps?: Map<number, number> | null; blockquotePreContentBlankLines?: Map<number, number> | null; blockquotePostContentBlankLines?: Map<number, number> | null; blockquoteAlertInlineByGroup?: Map<number, boolean> | null; calloutLabels?: boolean | null; imageFormatMapping?: Map<string, string> | null; noteImageFormatMapping?: Map<string, string> | null; tableFormatMapping?: Map<string, string> | null; pipeTableAlignedMapping?: Map<string, string> | null; gridSourceColWidthsMapping?: Map<string, string> | null; tableFontSizeMapping?: Map<string, string> | null; tableFontMapping?: Map<string, string> | null; tableColWidthsMapping?: Map<string, string> | null; tableDigitsMapping?: Map<string, string> | null; tableDecimalMarkMapping?: Map<string, string> | null; tableDigitGroupingMapping?: Map<string, string> | null; tableHtmlAroundMapping?: Map<string, [string, string, string, string, string, string, string]> | null; tableIdentities?: TableIdentity[] | null; landscapeTableIndices?: Set<number> | null; portraitTableIndices?: Set<number> | null; listIndent?: 'tab' | 'spaces'; htmlCommentGaps?: Map<number, number> | null; htmlCommentAfterGaps?: Map<number, number> | null; sentinelGaps?: Record<string, number> | null; embedDirectiveMapping?: Map<string, string> | null; timezone?: string; breaks?: boolean; citationKeys?: ReadonlySet<string> },
): string {
  let breakMarks: TrackedBreakMarks | undefined;
  trackedBreakStart = undefined;
  citationsNoted = true;
  knownCitationKeys = new Set([
    ...options?.citationKeys ?? [], ...missingCitationKeys(content),
    ...deletedCitationKeys(content),
  ]);
  const marks = () => {
    if (!breakMarks) trackedBreakStart = (breakMarks = trackedBreakMarks([content, [...comments.values()], options])).start;
    return breakMarks;
  };
  // A paragraph's text without the spaces and tabs at its end, which Word
  // shows nothing for (see keepParagraphEdgeWhitespace) and Markdown drops,
  // and two of which before a line that goes on, as a comment's body in ID
  // syntax does, make a line break. A backslash before them, which was
  // text, is escaped, as it would make one too. Those after a tracked
  // break's span stay, as the text of the paragraph after it, which
  // joinSpansAtTrackedBreaks writes as references, and so do those of an
  // HTML block, which keeps them and its backslashes as they are, as one
  // the text starts with or one a line of it after a line break starts.
  const withoutEndSpaces = (text: string): string => {
    let space = text.length;
    while (space > 0 && (text[space - 1] === ' ' || text[space - 1] === '\t')) space--;
    if (space === text.length || (breakMarks && afterTrackedBreakSpan(text, space, breakMarks))
        || (text.includes('<') && isInsideCodeRegion(Math.max(space - 1, 0), computeMarkdownRegions(text, { includeCode: false, html: 'all' }).htmlRegions))) return text;
    let slashes = 0;
    while (slashes < space && text[space - 1 - slashes] === '\\') slashes++;
    return text.slice(0, space) + (slashes % 2 === 1 ? '\\' : '');
  };
  // The width of the marker of the open list item at each level, which the
  // items and paragraphs under it indent by
  let listMarkerWidths: number[] = [];
  // The level Word gives the open list item at each level, which rises from
  // each to the next, as Markdown can't skip one (see atOpenListDepth)
  let listWordLevels: number[] = [];
  // paragraphLinePrefix is declared further down
  // A quote paragraph's own lines take its prefix in the main loop below
  const mergedContent = mergeConsecutiveRuns(joinTrackedParagraphBreaks(content, marks, (para, opening) => (
    opening && prefixesQuoteLines(opening) ? '' : paragraphLinePrefix(para)
  )));

  // Build 1-indexed comment ID remap (order of first appearance in document)
  const commentIdRemap = new Map<string, string>();
  const usedRemapIds = new Set<string>();
  // Comments that overlap anywhere in the document should use ID syntax
  // consistently across all their occurrences (including non-overlapping
  // paragraphs), to avoid mixed-format duplicate comment body emission.
  const forceIdCommentIds = new Set<string>();
  const emittedIdCommentBodies = new Set<string>();
  let nextRemapId = 1;
  function nextAvailableNumericId(): string {
    while (usedRemapIds.has(String(nextRemapId))) {
      nextRemapId++;
    }
    const id = String(nextRemapId);
    usedRemapIds.add(id);
    nextRemapId++;
    return id;
  }
  function assignRemappedId(id: string): string {
    const mapped = options?.commentIdMapping?.get(id);
    if (mapped && !usedRemapIds.has(mapped)) {
      usedRemapIds.add(mapped);
      return mapped;
    }
    return nextAvailableNumericId();
  }
  // Comments over an HTML comment, which an anchor can't hold, and over
  // other content, which goes in one: only ID syntax keeps them whole
  const overUnanchored = new Set<string>();
  const overAnchored = new Set<string>();
  // Comments over an HTML comment outside a table, which ID syntax may
  // keep (see where they take it)
  const overHtmlComment = new Set<string>();
  function collectCommentMetadata(items: ContentItem[], inTable = false): void {
    // The end of the text each comment's anchor has so far, as ==} can
    // straddle two of the runs Word splits text into
    const anchorEnds = new Map<string, string>();
    for (const item of items) {
      for (const id of [...anchorEnds.keys()]) {
        if (!('commentIds' in item) || !item.commentIds?.has(id)) anchorEnds.delete(id);
      }
      if (item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') {
        if (item.commentIds) {
          const ids = [...item.commentIds];
          // Text with ==}, which would end a {==...==} anchor early, in an
          // equation or an image's alt text, path or Markdown too
          let holdsAnchorEnd = item.type === 'math' ? item.latex.includes('==}')
            : item.type === 'image' && (item.alt + '\n' + item.src + '\n' + (item.markdown ?? '')).includes('==}');
          for (const id of ids) {
            if (!commentIdRemap.has(id)) {
              commentIdRemap.set(id, assignRemappedId(id));
            }
            if (item.type === 'html_comment' && !inTable) overHtmlComment.add(id);
            (item.type === 'html_comment' ? overUnanchored : overAnchored).add(id);
            // A citation without keys goes as text (see keylessCitationRun),
            // though not yet in a note or a table's cell
            const text = item.type === 'text' || item.type === 'citation' && item.pandocKeys.length === 0
              ? (anchorEnds.get(id) ?? '') + item.text : '';
            if (text.includes('==}')) holdsAnchorEnd = true;
            anchorEnds.set(id, text.slice(-2));
          }
          // A display equation is a block of its own, which only ID
          // markers can go around
          const displayBlock = item.type === 'math' && item.display && !inTable;
          if (ids.length > 1 || holdsAnchorEnd || displayBlock) {
            for (const id of ids) {
              forceIdCommentIds.add(id);
            }
          }
        }
      } else if (item.type === 'table') {
        for (const row of item.rows) {
          for (const cell of row.cells) {
            for (const para of cell.paragraphs) {
              collectCommentMetadata(para, true);
            }
          }
        }
      }
    }
  }
  // Notes in the order they're written, after the body
  const noteEntries = [...(options?.notes?.map.values() ?? [])].sort((a, b) => compareNoteLabels(a.label, b.label));
  // Each note's content as it renders, which collectCommentSpans finds the
  // last item of a comment's range in
  // Whether each of a note's code blocks goes as its paragraphs, before
  // what reads code paragraphs apart from text
  const noteCodeDemoted = new Map(noteEntries.map(entry => [entry, demoteNoteCodeBlocks(entry.body)]));
  const noteBodies = new Map(noteEntries.map(entry => [entry, mergeConsecutiveRuns(joinTrackedParagraphBreaks(entry.body, marks))]));
  collectCommentMetadata(mergedContent);
  for (const entry of noteEntries) collectCommentMetadata(entry.body);
  // A comment in a table cell whose body has more than one line takes ID
  // syntax, which puts the body after the table, as a cell has one line
  const bodyHasLines = (c: Comment) => c.text.includes('\n') || (!!c.replies?.length
    && (!c.consecutiveReplies || c.replies.some(reply => reply.text.includes('\n'))));
  for (const items of [mergedContent, ...noteEntries.map(entry => entry.body)]) {
    for (const item of items) {
      if (item.type !== 'table') continue;
      for (const row of item.rows) for (const cell of row.cells) for (const para of cell.paragraphs) for (const part of para) {
        if (!('commentIds' in part) || !part.commentIds) continue;
        for (const id of part.commentIds) {
          const c = comments.get(id);
          if (c && bodyHasLines(c)) forceIdCommentIds.add(id);
        }
      }
    }
  }
  for (const id of overUnanchored) if (overAnchored.has(id)) forceIdCommentIds.add(id);
  // Text that starts with a line break right after a body's {>>, as without
  // an author, which export takes for an opener at a line's end and moves to
  // a paragraph of its own: the body takes ID syntax, which starts a line,
  // and replies go on lines of their own
  const opensWithBreak = (author: string | undefined, text: string) => !(author || '').trim() && /^[\r\n]/.test(text);
  for (const [id, c] of comments) {
    if (opensWithBreak(c.author, c.text)) forceIdCommentIds.add(id);
    if (c.consecutiveReplies && c.replies?.some(reply => opensWithBreak(reply.author, reply.text))) {
      comments.set(id, { ...c, consecutiveReplies: false });
    }
  }

  // A comment whose range spans paragraphs takes ID syntax, which keeps its
  // range open from one to the next, up to its last item. One that reaches
  // into a table, whose cells can't hold that, goes on in each paragraph.
  // Code blocks, display equations and HTML comments can't hold ID markers
  // either, so a range starts and ends in the text around them.
  const lastCommentItem = new Map<string, ContentItem>();
  function collectCommentSpans(items: ContentItem[]): void {
    const paragraphOf = new Map<string, number>();
    const spanning = new Set<string>();
    const inTable = new Set<string>();
    let paragraph = 0;
    let inCodeBlock = false;
    const visit = (list: ContentItem[], table: boolean) => {
      for (const item of list) {
        if (item.type === 'para') {
          paragraph++;
          inCodeBlock = !!item.isCodeBlock;
          continue;
        }
        if (item.type === 'table') {
          for (const row of item.rows) for (const cell of row.cells) for (const para of cell.paragraphs) {
            paragraph++;
            visit(para, true);
          }
          paragraph++;
          continue;
        }
        // A display equation outside a table is a block of its own, which
        // ID markers go around
        const displayBlock = item.type === 'math' && item.display && !table;
        const marked = item.type === 'text' ? !inCodeBlock
          : item.type === 'math' ? !item.display || displayBlock
            : item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'image';
        if (displayBlock) paragraph++;
        // A tracked break joinTrackedParagraphBreaks put in the text ends a
        // paragraph too, where text after it goes on in the next, as a
        // range of {++{#1}a\n\nb{/1}++} or {#1}a{++\n\n++}b{/1} does,
        // which {==...==} can't hold
        const pieces = item.type === 'text' && breakMarks && (item.text.includes(breakMarks.start) || item.text.includes(breakMarks.alone))
          ? item.text.split(new RegExp('[' + breakMarks.start + breakMarks.alone + ']'))
            .map((piece, k) => k === 0 ? piece : piece.slice(piece.indexOf(breakMarks!.end) + 1))
          : [''];
        for (let k = 0; k < pieces.length; k++) {
          if (k > 0) {
            paragraph++;
            if (!pieces[k]) continue;
          }
          for (const id of marked && 'commentIds' in item ? item.commentIds ?? [] : []) {
            const first = paragraphOf.get(id);
            if (first === undefined) paragraphOf.set(id, paragraph);
            else if (first !== paragraph) spanning.add(id);
            if (table) inTable.add(id);
            lastCommentItem.set(id, item);
          }
        }
        if (displayBlock) paragraph++;
      }
    };
    visit(items, false);
    for (const id of paragraphOf.keys()) {
      if (spanning.has(id) && !inTable.has(id)) forceIdCommentIds.add(id);
      else lastCommentItem.delete(id);
    }
  }
  collectCommentSpans(mergedContent);
  for (const body of noteBodies.values()) collectCommentSpans(body);

  // Global overlap detection: mark comments that overlap anywhere in the document
  function detectGlobalOverlaps(items: ContentItem[]): void {
    const starts = new Map<string, number>();
    const ends = new Map<string, number>();
    let pos = 0;
    let prevIds = new Set<string>();

    function scan(itemList: ContentItem[]): void {
      for (const item of itemList) {
        if ((item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') && item.commentIds) {
          const ids = item.commentIds;
          for (const id of ids) {
            if (!prevIds.has(id)) starts.set(id, Math.min(starts.get(id) ?? pos, pos));
          }
          for (const id of prevIds) {
            if (!ids.has(id)) ends.set(id, Math.max(ends.get(id) ?? pos, pos));
          }
          prevIds = ids;
          pos++;
        } else if (item.type === 'table') {
          for (const row of item.rows) {
            for (const cell of row.cells) {
              for (const para of cell.paragraphs) {
                scan(para);
              }
            }
          }
        }
      }
    }
    scan(items);
    for (const id of prevIds) {
      if (!ends.has(id)) ends.set(id, pos);
    }

    // Only the comments in these items, so that a scan of each note compares
    // its own and not every pair in the document
    const ranges = [...starts.keys()].map(id => ({ id, start: starts.get(id) ?? 0, end: ends.get(id) ?? 0 }));
    for (let a = 0; a < ranges.length; a++) {
      for (let b = a + 1; b < ranges.length; b++) {
        if (ranges[a].start < ranges[b].end && ranges[b].start < ranges[a].end) {
          forceIdCommentIds.add(ranges[a].id);
          forceIdCommentIds.add(ranges[b].id);
        }
      }
    }
  }
  detectGlobalOverlaps(mergedContent);
  for (const entry of noteEntries) detectGlobalOverlaps(entry.body);
  // Over an HTML comment, a range takes ID syntax, as {#1}<!-- a -->{/1},
  // where the paragraph that holds it, as written, reads back as one
  // paragraph with its comments inline, each as its hidden run holds it,
  // as export reads it (see readsCommentsInline): with no ID syntax, a
  // paragraph that starts with the comment and its body is an HTML block,
  // which shows them. Not in a table's cell, which starts no block, and in
  // an HTML table's shows ID syntax as text and loses the body after the
  // table. Nor a paragraph that starts with a comment no ID syntax starts
  // before, which is an HTML block to its line's end, nor one that holds a
  // comment a paragraph doesn't read whole, as one with a blank line, a
  // line of *** or ---, a line that starts with <!--, or an end of --->,
  // which only an HTML block holds as they are, so the range goes as it
  // did, after the block, as does the rest of it, unless another reason
  // puts it in ID syntax. Which changes how another paragraph it's in
  // reads, so until each does.
  const idOverComments = new Set(overHtmlComment);
  const rangeStarts = new Map<string, ContentItem>();
  const rangeEnds = new Map<string, ContentItem>();
  const commentParagraphs: ContentItem[][] = [];
  for (const items of [mergedContent, ...noteEntries.map(entry => entry.body)]) {
    let paragraph: ContentItem[] = [];
    for (const item of [...items, undefined]) {
      if (!item || item.type === 'para' || item.type === 'table') {
        if (paragraph.some(entry => entry.type === 'html_comment' && [...entry.commentIds ?? []].some(id => overHtmlComment.has(id)))) commentParagraphs.push(paragraph);
        paragraph = [];
        continue;
      }
      paragraph.push(item);
      for (const id of 'commentIds' in item ? item.commentIds ?? [] : []) {
        if (!rangeStarts.has(id)) rangeStarts.set(id, item);
        rangeEnds.set(id, item);
      }
    }
  }
  const inIdSyntax = (id: string) => !!options?.alwaysUseCommentIds || forceIdCommentIds.has(id) || idOverComments.has(id);
  // The paragraph as it's written, its comments as they are, with ID
  // syntax around ranges, and an x for each word of its text and anything
  // else, which a paragraph reads as text, as its text is escaped to be,
  // with its line ends, after which a comment would start a line. Not one
  // whose comments' hidden runs hold text outside them, which their HTML
  // block hid, but which a paragraph shows, as <!-- b -->c<!-- d -->.
  const readsBack = (paragraph: ContentItem[]): boolean => {
    let text = '';
    const payloads: string[] = [];
    // Whether the text is at a line's start, but for ID syntax's openers
    // after it, and whether one of those ends it, as each item adds to it
    let lineStart = true;
    let afterOpener = false;
    const add = (piece: string) => {
      if (!piece) return;
      text += piece;
      const end = piece.lastIndexOf('\n');
      lineStart = end !== -1 && end === piece.length - 1;
      afterOpener = false;
    };
    for (let k = 0; k < paragraph.length; k++) {
      const item = paragraph[k];
      const ids = 'commentIds' in item ? [...item.commentIds ?? []].filter(inIdSyntax) : [];
      for (const id of ids) {
        if (rangeStarts.get(id) !== item) continue;
        text += '{#' + id + '}';
        afterOpener = true;
      }
      if (item.type === 'html_comment') {
        const payload = markdownComment(item.text, paragraph[k + 1]?.type === 'html_comment');
        // Text outside its comments, which their HTML block hid, but which
        // a paragraph shows
        if (/\S/.test(outsideComments(payload))) return false;
        payloads.push(payload);
        // But for the indent export put in its run, which goes after ID
        // syntax at the line's start (see where it's dropped)
        add(afterOpener && lineStart ? payload.replace(/^[ \t]+/, '') : payload);
      } else if (item.type === 'text') {
        add(item.text.replace(/\S+/g, 'x').replace(lineStart ? /^[ \t]+/ : /(?!)/, 'x'));
      } else if (item.type === 'math' && item.display) {
        add('\n' + MATH_FENCE + '\nx\n' + MATH_FENCE);
      } else {
        add('x');
      }
      for (const id of ids) if (rangeEnds.get(id) === item) add('{/' + id + '}');
    }
    return readsCommentsInline(text, payloads);
  };
  // A paragraph that doesn't read back takes the ranges over its comments
  // out of ID syntax, which changes how the other paragraphs they're in
  // read, so the paragraphs are checked in rounds, each in their order,
  // until one changes nothing. A paragraph reads as it did while no ID in it
  // has changed since its last check, so a round checks only those an ID
  // changed in, where a check of all of them would: after the paragraph
  // that changed it in the same round, and before it in the next. A check
  // of all of them each round took time in the square of their number where
  // each one's change reached only the one before, as a comment's ranges,
  // one over each paragraph's last comment and one over the next one's
  // first, can link each paragraph to the next.
  const holders = new Map<string, number[]>();
  commentParagraphs.forEach((paragraph, k) => {
    for (const item of paragraph) {
      for (const id of 'commentIds' in item ? item.commentIds ?? [] : []) {
        const held = holders.get(id);
        if (!held) holders.set(id, [k]);
        else if (held[held.length - 1] !== k) held.push(k);
      }
    }
  });
  // This round's paragraphs to check, as a heap of their indices, and the
  // next round's
  let round = commentParagraphs.map((_, k) => k);
  while (round.length > 0) {
    const queued = new Set(round);
    const next = new Set<number>();
    while (round.length > 0) {
      const k = popLeast(round);
      const paragraph = commentParagraphs[k];
      const ids = paragraph.flatMap(item => item.type === 'html_comment' ? [...item.commentIds ?? []].filter(id => idOverComments.has(id)) : []);
      if (ids.length === 0 || readsBack(paragraph)) continue;
      for (const id of ids) {
        if (!idOverComments.delete(id)) continue;
        for (const j of holders.get(id) ?? []) {
          if (j < k) next.add(j);
          else if (j > k && !queued.has(j)) {
            queued.add(j);
            pushInOrder(round, j);
          }
        }
      }
    }
    round = [...next].sort((a, b) => a - b);
  }
  for (const id of idOverComments) forceIdCommentIds.add(id);

  const noteLabels = options?.notes?.assignedLabels;
  // The tables the body and then the notes render, by their indices, each
  // with its note's key, or the body's '', as export's are
  const noteScopes = new Map([...options?.notes?.map ?? []].map(([key, entry]) => [entry, key]));
  const tablesRead = [['', mergedContent] as const, ...noteEntries.map(entry => [noteScopes.get(entry) ?? '', entry.body] as const)]
    .flatMap(([scope, items]) => items.flatMap(item => item.type === 'table' ? [{ scope, rows: item.rows }] : []));
  // The settings export wrote for each table by the index it wrote it at,
  // as its format and font, by the index it's rendered at, which differs
  // where Word added or deleted a table before it: the settings of the one
  // export wrote that it is (see matchTables), or, where export wrote no
  // identities, of the one at its index
  const writtenAt = options?.tableIdentities
    ? matchTables(options.tableIdentities, tablesRead.map(table => tableIdentityOf(table.rows.map(row => row.cells.map(tableCellText)), table.scope)))
    : undefined;
  const settingsRead = <T>(settings: Map<string, T> | null | undefined): Map<string, T> | undefined => {
    if (!settings || !writtenAt) return settings ?? undefined;
    const read = new Map<string, T>();
    writtenAt.forEach((at, index) => { if (at !== undefined && settings.has(String(at))) read.set(String(index), settings.get(String(at))!); });
    return read;
  };
  const indicesRead = (tables: Set<number> | null | undefined): Set<number> | undefined => tables && writtenAt
    ? new Set(writtenAt.flatMap((at, index) => at !== undefined && tables.has(at) ? [index] : []))
    : tables ?? undefined;
  const embedDirectiveMapping = settingsRead(options?.embedDirectiveMapping);
  // How many tables the body and each note have with each first row and
  // text, which the HTML export wrote around one goes to no other while
  // it's there (see renderTableOrFallback), but one written as its embed
  // directive, which export doesn't count
  const tablesAlike = new Map<string, number>();
  if (options?.tableHtmlAroundMapping) {
    tablesRead.forEach((table, index) => {
      const key = table.scope + '\n' + tableIdentity(table.rows);
      if (!embedDirectiveMapping?.get(String(index))) tablesAlike.set(key, (tablesAlike.get(key) ?? 0) + 1);
    });
  }
  const renderOpts = {
    alwaysUseCommentIds: options?.alwaysUseCommentIds,
    timezone: options?.timezone,
    breaks: options?.breaks,
    commentIdRemap,
    forceIdCommentIds,
    emittedIdCommentBodies,
    openIdComments: new Set<string>(),
    lastCommentItem,
    noteLabels,
    imageFormatMapping: options?.imageFormatMapping ?? undefined,
    noteImageFormatMapping: options?.noteImageFormatMapping ?? undefined,
    tableFormatMapping: settingsRead(options?.tableFormatMapping),
    pipeTableAlignedMapping: settingsRead(options?.pipeTableAlignedMapping),
    gridSourceColWidthsMapping: settingsRead(options?.gridSourceColWidthsMapping),
    tableFontSizeMapping: settingsRead(options?.tableFontSizeMapping),
    tableFontMapping: settingsRead(options?.tableFontMapping),
    tableColWidthsMapping: settingsRead(options?.tableColWidthsMapping),
    tableDigitsMapping: settingsRead(options?.tableDigitsMapping),
    tableDecimalMarkMapping: settingsRead(options?.tableDecimalMarkMapping),
    tableDigitGroupingMapping: settingsRead(options?.tableDigitGroupingMapping),
    tableHtmlAroundMapping: options?.tableHtmlAroundMapping ?? undefined,
    tablesWrittenAt: writtenAt,
    usedTableHtmlAround: new Set<string>(),
    tablesAlike,
    tablesAlikeRendered: new Map<string, number>(),
    landscapeTableIndices: indicesRead(options?.landscapeTableIndices),
    portraitTableIndices: indicesRead(options?.portraitTableIndices),
    embedDirectiveMapping,
  };

  /** A display equation's block with the ID markers of the comments over
   *  it, which open before its fences, unless open from the text before,
   *  and close after them, unless the range goes on; and the bodies of
   *  those that close. */
  function displayMathWithComments(block: string, item: ContentItem): { block: string; bodies: string[] } {
    const over = [...('commentIds' in item ? item.commentIds ?? [] : [])];
    const open = renderOpts.openIdComments;
    // Those open from the text before in the order they opened, which those
    // that end together end in (see enterComments in renderInlineRangeWithIds)
    const ids = [...open].filter(id => over.includes(id)).concat(over.filter(id => !open.has(id)).sort());
    const remap = (id: string) => commentIdRemap.get(id) ?? id;
    let before = '';
    let after = '';
    const bodies: string[] = [];
    for (const id of ids) {
      if (!open.has(id)) before += '{#' + remap(id) + '}';
      const last = lastCommentItem.get(id);
      if (last && last !== item) {
        open.add(id);
        continue;
      }
      open.delete(id);
      after += '{/' + remap(id) + '}';
      const comment = comments.get(id);
      if (comment && !emittedIdCommentBodies.has(id)) {
        emittedIdCommentBodies.add(id);
        bodies.push(formatCommentBodyWithId(remap(id), comment, options?.timezone));
      }
    }
    return { block: before + block + after, bodies };
  }

  function listContinuationIndent(list: ListContinuation): string {
    const useTab = options?.listIndent === 'tab';
    if (useTab) {
      return '\t'.repeat(list.level + 1);
    }
    if (listMarkerWidths.length > list.level) return ' '.repeat(listItemIndent(list.level + 1));
    // Before the render loop reaches the item, as for a tracked break
    if (list.indent !== undefined) return ' '.repeat(list.indent);
    if (list.type === 'bullet') {
      return ' '.repeat(2 * (list.level + 1));
    }
    const markerWidth = list.markerWidth ?? 3;
    return ' '.repeat(3 * list.level + markerWidth);
  }

  /** Blank lines before a quote group that continues a list item, from the
   *  same spacing metadata top-level quotes use. A different group right
   *  after another needs at least one, or the two would merge on reparse. */
  function blankLinesBeforeListQuote(item: Extract<ContentItem, { type: 'para' }>): number {
    if (item.blockquoteGroupIndex === undefined) return 0;
    if (lastBlockquoteGroupIndex !== undefined && lastBlockquoteGroupIndex !== item.blockquoteGroupIndex) {
      const gap = blockquoteGaps?.get(lastBlockquoteGroupIndex);
      if (gap !== undefined && gap >= 0) return gap;
      if (gap === undefined) return 1;
    }
    return blockquotePreContentBlankLines?.get(item.blockquoteGroupIndex) ?? 0;
  }

  /** Blank lines before a plain list continuation paragraph: one, or after a
   *  quote in the list, the blank lines the source had there (export writes
   *  no empty paragraph after it). At least one, or the paragraph would
   *  continue the quote on reparse. */
  function blankLinesAfterListQuote(): number {
    if (!prevItemWasListQuote || pendingPostContentGroupIndex === undefined) return 1;
    return Math.max(1, blockquotePostContentBlankLines?.get(pendingPostContentGroupIndex) ?? 1);
  }

  // Before a quote group with no blank line before it, after another. Where
  // it's the shallower, in the same list item or none, the source had a
  // line that ended the deeper one's paragraph, as a bare >, without which
  // its text continues that one. Out of the item, its indent ends that. So
  // does one at the same level, unless an alert's marker starts it: a
  // nested one takes the bare > of the quote around it, and one at the top
  // a blank line, as Markdown has nothing between two quotes there.
  function adjoiningQuoteGroups(item: Extract<ContentItem, { type: 'para' }>): string {
    const level = item.blockquoteLevel;
    if (lastBlockquoteLevel === undefined || level === undefined || lastBlockquoteListLevel !== item.listContinuation?.level) return '';
    if (level < lastBlockquoteLevel) return blockquotePrefix(item).trimEnd() + '\n';
    if (level > lastBlockquoteLevel || item.alertType) return '';
    return level > 1 ? blockquotePrefix({ ...item, blockquoteLevel: level - 1 }).trimEnd() + '\n' : '\n';
  }

  // What a paragraph's lines after its first start with: its quote's >, or
  // its list item's indent
  function paragraphLinePrefix(item: Extract<ContentItem, { type: 'para' }>): string {
    if (item.listMeta) return listContinuationIndent({ type: item.listMeta.type, level: item.listMeta.level });
    if (item.blockquoteLevel) return blockquotePrefix(item);
    return item.listContinuation ? listContinuationIndent(item.listContinuation) : '';
  }

  function blockquotePrefix(item: Extract<ContentItem, { type: 'para' }>): string {
    const quotePrefix = '> '.repeat(item.blockquoteLevel || 1);
    return (item.listContinuation ? listContinuationIndent(item.listContinuation) : '') + quotePrefix;
  }

  const output: string[] = [];
  let i = 0;
  let tableIndex = 0;
  let lastListType: 'bullet' | 'ordered' | undefined;
  let lastListLevel: number | undefined;
  let lastListItemEmpty = false; // the last list item has no text of its own
  // A list item with no text, which a task item's box is
  const isEmptyListItem = (index: number) => {
    const item = mergedContent[index];
    return !(item.type === 'para' && item.listMeta?.taskChecked !== undefined) && !paragraphHasContent(mergedContent, index);
  };
  let prevItemWasListQuote = false; // the paragraph before is a quote in a list item
  const listTypeByLevel = new Map<number, 'bullet' | 'ordered'>(); // per-level list type tracking
  const orderedListCounters = new Map<number, number>(); // per-level counters for ordered list items
  // Where the content of the last list paragraph ended in the output, and the
  // number Markdown gives a top-level ordered item that carries on its list
  let listContentEnd: number | undefined;
  let topOrderedNext: number | undefined;
  // What follows starts a new list, with its own indent sentinel
  const endListContext = () => { lastListType = undefined; lastListLevel = undefined; listTypeByLevel.clear(); listMarkerWidths = []; listWordLevels = []; };
  /** The columns a list item at `level` indents by: its parents' markers */
  const listItemIndent = (level: number) => {
    let columns = 0;
    for (let k = 0; k < level; k++) columns += listMarkerWidths[k];
    return columns;
  };
  /** A list item at the level Markdown can nest it at: under the open item
   *  of the nearest level Word gives above its own, or at the top where no
   *  list is open, as Markdown has no way to skip a level. Indented for the
   *  level Word gives it, it would nest under another item, or read as
   *  code. A paragraph in an item goes at that item's level, and where no
   *  item is open, as after one with no text, in none. */
  const atOpenListDepth = (item: ContentItem): ContentItem => {
    if (item.type !== 'para' || item.headingLevel) return item;
    const { listMeta, listContinuation } = item;
    if (listMeta) {
      const level = listWordLevels.filter(open => open < listMeta.level).length;
      return level === listMeta.level ? item : { ...item, listMeta: { ...listMeta, level } };
    }
    if (listContinuation && listWordLevels.length === 0) return { ...item, listContinuation: undefined };
    if (listContinuation) {
      const level = Math.max(0, listWordLevels.filter(open => open <= listContinuation.level).length - 1);
      return level === listContinuation.level ? item : { ...item, listContinuation: { ...listContinuation, level } };
    }
    return item;
  };
  let codeBlockGroupIndex = 0;
  let lastAlertParagraphKey: string | undefined;
  let pendingAlertPrefixStrip: GfmAlertType | undefined;
  // The quote's prefix in a list item, after which an inline marker
  // (`> [!TYPE] `) becomes the marker-only form (`> [!TYPE]\n> ...`) where
  // the text after the label starts with a line break of its own, but not
  // where the line break is the label's, which stripAlertLeadPrefix takes:
  // export writes one after the label whether the text was on the marker's
  // line or not, which the alert-style metadata says.
  let pendingAlertInlinePrefixForHardBreak: string | undefined;
  let pendingDisplayMathContainer: { prefix: string; type: 'list' | 'blockquote' } | undefined;
  // Display math next in the paragraph just written, after its text or on
  // its list item's marker line, which goes on in the paragraph: a blank
  // line before it would end the paragraph, and a quote or list around it
  let mathInParagraph: { prefix: string; sameLine: boolean; quoted: boolean } | undefined;
  // The paragraph whose text is being written
  let currentPara: Extract<ContentItem, { type: 'para' }> | undefined;
  // Where the space or line end after an alert's marker is in output, which
  // goes where nothing follows the marker in its paragraph
  let alertMarkerLineEnd: number | undefined;
  // Comment bodies from a display equation that text follows in its Word
  // paragraph, which go after that text
  const pendingEquationBodies: string[] = [];
  // Heading whose paragraph mark is inserted/deleted (whole-paragraph track
  // change): the `### ` marker must be re-inserted inside the leading Critic
  // span ({++### heading++}) rather than emitted before it. revType is kept
  // so a heading with no inline content (empty inserted paragraph) can still
  // be serialized as its own {++### ++} / {--### --} span instead of leaking
  // the marker into the next paragraph.
  let pendingHeadingCriticMarker: { marker: string; revType: 'addition' | 'deletion'; whole: boolean } | undefined;
  const flushPendingHeadingCriticMarker = () => {
    if (pendingHeadingCriticMarker === undefined) return;
    const { marker, revType } = pendingHeadingCriticMarker;
    output.push(revType === 'addition' ? '{++' + marker + '++}' : '{--' + marker + '--}');
    pendingHeadingCriticMarker = undefined;
  };
  let lastBlockquoteGroupIndex: number | undefined;
  let pendingPostContentGroupIndex: number | undefined;
  // Track previous blockquote type to detect group boundaries when gap
  // metadata is absent (plain↔alert or alert↔different-alert transitions).
  let lastBlockquoteAlertType: GfmAlertType | 'plain' | undefined;
  let lastBlockquoteLevel: number | undefined;
  // The list level of the last quote's item, if it's in one
  let lastBlockquoteListLevel: number | undefined;
  // A quote paragraph's lines after its first, and its comment bodies, stay
  // in its quote, where a line without > after it would start a paragraph of
  // its own
  let quoteLinePrefix = '';
  // Whether the paragraph is in a quote or list (see InlineRangeOpts)
  let paragraphNested = false;
  let paragraphHeading = false;
  // A list item's or its continuation's lines after its first, where it's
  // an HTML block, which has no lazy continuation to keep them in the item
  let listLinePrefix = '';
  // Whether the last list item's text or continuation is an HTML block that
  // only a blank line ends, which takes in a sublist after it without one
  let listHtmlBlockOpen = false;
  // Whether the paragraph's text starts its own line, where an HTML block
  // keeps the spaces before it: not after a heading's # or an item's marker
  let ownLine = true;
  let deferredCommentQuote: { group?: number; level: number } | undefined;
  // The last comment bodies written into a quote
  let quotedBodies: { text: string; group?: number; level: number } | undefined;
  const codeBlockLangs = options?.codeBlockLangs;
  const blockquoteGaps = options?.blockquoteGaps;
  const blockquotePreContentBlankLines = options?.blockquotePreContentBlankLines;
  const blockquotePostContentBlankLines = options?.blockquotePostContentBlankLines;
  const htmlCommentGaps = options?.htmlCommentGaps;
  const htmlCommentAfterGaps = options?.htmlCommentAfterGaps;
  let htmlCommentIndex = 0;
  let lastRenderedHtmlCommentIndex: number | undefined;
  // Whether that comment went in ID syntax, a paragraph (see where it is set)
  let lastHtmlCommentIsParagraph = false;
  // The gap a comment first in the document had, which there's nothing to
  // put before, but which directives hoisted above it go before
  let documentStartCommentGap: number | undefined;
  // The line end or spaces an HTML table's HTML ended with before the next
  // table in its block, which that one goes on from as the next item (see
  // renderTableOrFallback)
  let lastTableJoin: string | undefined;
  let lastWasSectionSentinel = false; // true after landscape/portrait open/close rendering
  let lastSentinelAfterGapKey: string | undefined; // after-gap key of the last rendered sentinel
  let skipNextLandscapeClose = false;
  let skipNextPortraitClose = false;
  const sentinelGaps = options?.sentinelGaps;
  let sentinelLoIdx = 0, sentinelLcIdx = 0, sentinelPoIdx = 0, sentinelPcIdx = 0;
  let sentinelCsoIdx = 0, sentinelCscIdx = 0;
  // The line ends the output ends with, over its parts
  function trailingNewlines(): number {
    let existing = 0;
    for (let outputIndex = output.length - 1; outputIndex >= 0; outputIndex--) {
      const value = output[outputIndex];
      let charIndex = value.length - 1;
      while (charIndex >= 0 && value[charIndex] === '\n') {
        existing++;
        charIndex--;
      }
      if (charIndex >= 0) break;
    }
    return existing;
  }
  function ensureTrailingNewlines(desired: number): void {
    const existing = trailingNewlines();
    if (existing < desired) output.push('\n'.repeat(desired - existing));
  }

  // Emit separator before a sentinel using stored gap metadata.
  // Returns true if a gap-aware separator was emitted, false otherwise.
  function emitSentinelSep(gapKey: string): boolean {
    if (!sentinelGaps) return false;
    const gapCount = sentinelGaps[gapKey];
    if (gapCount === undefined) return false;
    // Nothing goes before the document's first line. Export counts the lines
    // of masked frontmatter as blank ones, and the frontmatter's own gap
    // metadata spaces the body from it.
    if (output.every(part => /^\n*$/.test(part))) return true;
    const desiredNewlines = gapCount + 1;
    let existingNewlines = 0;
    for (let oi = output.length - 1; oi >= 0; oi--) {
      const s = output[oi];
      let j = s.length - 1;
      while (j >= 0 && s[j] === '\n') { existingNewlines++; j--; }
      if (j >= 0) break;
    }
    const needed = desiredNewlines - existingNewlines;
    if (needed > 0) {
      output.push('\n'.repeat(needed));
    } else if (needed < 0) {
      let toRemove = -needed;
      while (toRemove > 0 && output.length > 0) {
        const last = output[output.length - 1];
        let trailingNL = 0;
        for (let j = last.length - 1; j >= 0 && last[j] === '\n'; j--) trailingNL++;
        if (trailingNL === 0) break;
        const removeFromThis = Math.min(toRemove, trailingNL);
        if (removeFromThis === last.length) {
          output.pop();
        } else {
          output[output.length - 1] = last.slice(0, last.length - removeFromThis);
        }
        toRemove -= removeFromThis;
      }
    }
    return true;
  }

  while (i < mergedContent.length) {
    const wordItem = mergedContent[i];
    const tableJoin = lastTableJoin;
    lastTableJoin = undefined;
    // An item with no text ends at a blank line, which goes before anything
    // after it but its sublist, or a quote in it right under its marker, and
    // nothing after nests in it
    if (lastListItemEmpty && wordItem.type === 'para' && (!wordItem.listMeta || wordItem.headingLevel)
      && !(wordItem.blockquoteLevel && wordItem.listContinuation && blankLinesBeforeListQuote(wordItem) === 0)) {
      listMarkerWidths = listMarkerWidths.slice(0, -1);
      listWordLevels = listWordLevels.slice(0, -1);
      lastListItemEmpty = false;
    }
    // The level Word gives a list item, and the item at the level Markdown
    // nests it at, which every line written for it takes
    const wordLevel = wordItem.type === 'para' ? wordItem.listMeta?.level : undefined;
    const item = mergedContent[i] = atOpenListDepth(wordItem);

    // Compute incoming separator from the previous item (consumed once per iteration).
    // null means "no special handling, use default \n\n".
    let incomingSep: string | null = null;
    if (lastRenderedHtmlCommentIndex !== undefined) {
      const gapCount = htmlCommentAfterGaps?.get(lastRenderedHtmlCommentIndex);
      if (gapCount !== undefined) {
        incomingSep = '\n' + '\n'.repeat(lastHtmlCommentIsParagraph ? Math.max(1, gapCount) : gapCount);
      }
      lastRenderedHtmlCommentIndex = undefined;
    } else if (lastWasSectionSentinel) {
      // Use after-gap metadata from the last sentinel if available
      const afterGap = lastSentinelAfterGapKey && sentinelGaps ? sentinelGaps[lastSentinelAfterGapKey] : undefined;
      if (afterGap !== undefined) {
        incomingSep = '\n' + '\n'.repeat(afterGap);
      } else {
        incomingSep = '\n';
      }
      lastWasSectionSentinel = false;
      lastSentinelAfterGapKey = undefined;
    }

    if (item.type === 'para') {
      if (lastListType !== undefined) listContentEnd = output.length;
      // A pending heading marker still unconsumed here means the revised
      // heading paragraph had no inline content — serialize it as its own
      // empty span before starting the next paragraph.
      flushPendingHeadingCriticMarker();
      if (item.isBlockquoteSpacer) {
        i++;
        continue;
      }
      if (
        isPlainEmptyParagraph(item) &&
        !paragraphHasContent(mergedContent, i)
      ) {
        let nextStructuralIdx = i + 1;
        while (nextStructuralIdx < mergedContent.length) {
          const nextItem = mergedContent[nextStructuralIdx];
          if (
            nextItem.type !== 'para'
            || !isPlainEmptyParagraph(nextItem)
            || paragraphHasContent(mergedContent, nextStructuralIdx)
          ) {
            break;
          }
          nextStructuralIdx++;
        }

        const nextCandidate = nextStructuralIdx < mergedContent.length ? mergedContent[nextStructuralIdx] : undefined;
        const nextPara = nextCandidate?.type === 'para'
          ? nextCandidate
          : undefined;

        if (
          nextPara?.blockquoteLevel &&
          nextPara.blockquoteGroupIndex !== undefined &&
          blockquotePreContentBlankLines?.has(nextPara.blockquoteGroupIndex)
        ) {
          i++;
          continue;
        }
        // Before a block that writes the blank line before it, as a list
        // item, a heading, a code block, a title or a rule, empty paragraphs
        // are that blank line, as before a paragraph, whose text goes on from
        // them: export reads more blank lines as one, so the next trip would
        // drop them. A tracked mark before one is in the text before it (see
        // joinTrackedParagraphBreaks)
        if (nextPara && (nextPara.listMeta || nextPara.headingLevel || nextPara.isCodeBlock || nextPara.isTitle || nextPara.horizontalRule)) {
          i = nextStructuralIdx;
          continue;
        }
      }

      // Code block grouping: collect consecutive code-block paragraphs into a fenced block
      if (item.isCodeBlock) {
        if (output.length > 0) {
          output.push('\n\n');
        }
        endListContext();
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
        lastBlockquoteAlertType = undefined;
        lastBlockquoteLevel = undefined;

        const lang = codeBlockLangs?.get(String(codeBlockGroupIndex)) || '';
        const code = codeBlockFence(mergedContent, i, lang);
        i = code.end;
        output.push(code.block);
        codeBlockGroupIndex++;
        // Skip a plain separator para that was inserted during export between
        // consecutive code-block groups or before a blockquote group.  Only
        // skip when the next item after the separator is either a code-block
        // para or a blockquote para (proving it's a separator, not real
        // content).
        const sep = i < mergedContent.length ? mergedContent[i] : undefined;
        const afterSep = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
        if (sep && sep.type === 'para' && !sep.isCodeBlock && !sep.horizontalRule && afterSep && afterSep.type === 'para' && (afterSep.isCodeBlock || afterSep.blockquoteLevel)) {
          i++;
        }
        continue;
      }

      // A numbered heading is a heading, which ends a list
      const isCurrentList = item.listMeta !== undefined && !item.headingLevel;

      if (output.length > 0) {
        const continuesBlockquoteGroup = item.blockquoteLevel !== undefined
          && item.blockquoteGroupIndex !== undefined
          && item.blockquoteGroupIndex === lastBlockquoteGroupIndex;
        if (continuesBlockquoteGroup) {
          // A quoted blank line keeps multi-paragraph content—including
          // display equations—inside one blockquote/alert on reparse.
          output.push('\n' + blockquotePrefix(item).trimEnd() + '\n');
        } else if (lastListType && isCurrentList && (item.listMeta!.type === lastListType
            // A sublist of the other kind, or the list of the item it's in
            || item.listMeta!.level > (lastListLevel ?? 0)
            || listTypeByLevel.get(item.listMeta!.level) === item.listMeta!.type)) {
          // After a quote in the item before, the blank lines the source had
          // (export writes no empty paragraph there, which would end the list)
          const afterQuote = prevItemWasListQuote && pendingPostContentGroupIndex !== undefined
            ? blockquotePostContentBlankLines?.get(pendingPostContentGroupIndex) ?? 0 : 0;
          const meta = item.listMeta!;
          const startsList = meta.level > (lastListLevel ?? 0) || listTypeByLevel.get(meta.level) !== meta.type;
          // A blank line ends an item with no text, before its sublist
          const underEmpty = meta.level > (lastListLevel ?? 0) && lastListItemEmpty;
          // Only a list whose first item has text, numbered from 1 if at all,
          // can interrupt the text before it
          const interrupts = startsList && !lastListItemEmpty && (isEmptyListItem(i)
            || (meta.type === 'ordered' && (meta.wordNumber ?? meta.startNumber ?? 1) !== 1));
          const afterHtmlBlock = listHtmlBlockOpen && meta.level > (lastListLevel ?? 0);
          output.push('\n' + '\n'.repeat(underEmpty ? 0 : Math.max(afterQuote, interrupts || afterHtmlBlock ? 1 : 0)));
        } else if (item.listContinuation) {
          // Plain continuation paragraphs are block children of the list item
          // and therefore require a blank line. An imported empty paragraph
          // may already own that gap, so ensure the boundary instead of
          // appending another one on every round trip. Blockquotes carry their
          // own visible prefix and need only the line transition, plus the
          // blank lines the source had before them.
          ensureTrailingNewlines(item.blockquoteLevel ? 1 + blankLinesBeforeListQuote(item) : 1 + blankLinesAfterListQuote());
          if (item.blockquoteLevel && lastBlockquoteGroupIndex !== undefined && item.blockquoteGroupIndex !== undefined
            && item.blockquoteGroupIndex !== lastBlockquoteGroupIndex && blockquoteGaps?.get(lastBlockquoteGroupIndex) === 0) {
            output.push(adjoiningQuoteGroups(item));
          }
        } else if (incomingSep !== null) {
          output.push(incomingSep);
        } else if (
          blockquoteGaps &&
          item.blockquoteLevel &&
          item.blockquoteGroupIndex !== undefined &&
          lastBlockquoteGroupIndex !== undefined &&
          item.blockquoteGroupIndex !== lastBlockquoteGroupIndex
        ) {
          // Transitioning between blockquote groups — use gap metadata to
          // emit the exact number of blank lines from the original source.
          const gapCount = blockquoteGaps.get(lastBlockquoteGroupIndex);
          if (gapCount === 0) {
            output.push('\n' + adjoiningQuoteGroups(item));
          } else if (gapCount !== undefined && gapCount >= 0) {
            // gapCount blank lines = gapCount+1 newline characters
            output.push('\n' + '\n'.repeat(gapCount));
          } else if (gapCount === -1) {
            // Non-blockquote content existed between the groups in source;
            // use pre-content spacing metadata for this group when available.
            const preBlankCount = blockquotePreContentBlankLines?.get(item.blockquoteGroupIndex);
            if (preBlankCount !== undefined && preBlankCount >= 0) {
              output.push('\n' + '\n'.repeat(preBlankCount));
            } else {
              output.push('\n');
            }
          } else {
            output.push('\n\n');
          }
        } else if (
          blockquotePreContentBlankLines &&
          item.blockquoteLevel &&
          item.blockquoteGroupIndex !== undefined
        ) {
          // Blockquote group following non-blockquote content: preserve the
          // authored blank-line count before this group exactly.
          const blankCount = blockquotePreContentBlankLines.get(item.blockquoteGroupIndex);
          if (blankCount !== undefined && blankCount >= 0) {
            output.push('\n' + '\n'.repeat(blankCount));
          } else {
            output.push('\n\n');
          }
        } else if (
          item.blockquoteLevel &&
          lastBlockquoteLevel !== undefined &&
          lastBlockquoteAlertType !== undefined
        ) {
          // Detect blockquote group boundary by type transition when gap
          // metadata is absent: plain↔alert or alert↔different-alert at
          // the same (or different) nesting level.
          const currentType: GfmAlertType | 'plain' = item.alertType || 'plain';
          if (currentType !== lastBlockquoteAlertType || item.blockquoteLevel !== lastBlockquoteLevel) {
            // Type or level changed — this is a group boundary.  Use gap
            // metadata if available, otherwise default double-newline.
            if (blockquoteGaps && lastBlockquoteGroupIndex !== undefined) {
              const gapCount = blockquoteGaps.get(lastBlockquoteGroupIndex);
              if (gapCount === 0) {
                output.push('\n' + adjoiningQuoteGroups(item));
              } else if (gapCount !== undefined && gapCount >= 0) {
                output.push('\n' + '\n'.repeat(gapCount));
              } else {
                output.push('\n\n');
              }
            } else {
              output.push('\n\n');
            }
          } else {
            output.push('\n\n');
          }
        } else if (
          blockquotePostContentBlankLines &&
          !item.blockquoteLevel &&
          pendingPostContentGroupIndex !== undefined &&
          !item.headingLevel &&
          !item.listMeta &&
          !item.isCodeBlock
        ) {
          // Non-blockquote paragraph after a blockquote group: restore the
          // authored blank-line count exactly (including zero-blank adjacency).
          // A rule is content of its own, not a separator before what's next
          const next = !item.horizontalRule && i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
          const nextIsBlockquotePara = next?.type === 'para' && !!next.blockquoteLevel;
          const nextIsStructuralPara = next?.type === 'para' && (
            !!next.headingLevel || !!next.listMeta || !!next.isCodeBlock || !!next.horizontalRule
          );
          if (nextIsBlockquotePara) {
            // Structural separator between blockquote groups — let the
            // blockquote gap logic handle spacing at the next group boundary.
          } else if (nextIsStructuralPara) {
            // Structural separator before heading/list/code-block content.
            // Keep pending metadata so spacing is emitted at the real content.
          } else {
            const blankCount = blockquotePostContentBlankLines.get(pendingPostContentGroupIndex)
              ?? item.emptyParagraphCount;
            if (blankCount !== undefined && blankCount >= 0) {
              output.push('\n' + '\n'.repeat(blankCount));
            } else {
              output.push('\n\n');
            }
            // Consume once: this metadata applies only to the first real
            // content paragraph after a blockquote group.
            pendingPostContentGroupIndex = undefined;
          }
        } else if (
          blockquoteGaps &&
          !item.blockquoteLevel &&
          lastBlockquoteGroupIndex !== undefined &&
          !item.headingLevel &&
          !item.listMeta &&
          !item.isCodeBlock
        ) {
          // Non-blockquote empty para between blockquote groups: check if
          // the gap metadata indicates a direct blockquote-to-blockquote gap
          // (>= 0). Suppress only when the *next* para is a blockquote, so
          // real content paragraphs are never swallowed by this optimization.
          const gapCount = blockquoteGaps.get(lastBlockquoteGroupIndex);
          const next = !item.horizontalRule && i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
          const nextIsBlockquotePara = next?.type === 'para' && !!next.blockquoteLevel;
          if (gapCount !== undefined && (gapCount >= 0 || gapCount === -1) && nextIsBlockquotePara) {
            // Suppress — gap handled at next blockquote para transition
          } else {
            output.push('\n\n');
          }
        } else {
          output.push('\n\n');
        }
      }
      // A paragraph or block in an item, which the list item below sets again
      lastListItemEmpty = false;
      const orderedItem = item.listMeta?.type === 'ordered' && !item.headingLevel
        ? nextOrderedNumber(item.listMeta, orderedListCounters, listTypeByLevel, lastListLevel)
        : undefined;
      // Markdown carries a top-level list on across blank lines, so where
      // Word starts one over, a comment keeps the two apart
      const carriesOn = item.listMeta?.level === 0 && topOrderedNext !== undefined && listContentEnd !== undefined
        && output.slice(listContentEnd).every(part => !part.trim());
      if (orderedItem && carriesOn && (orderedItem.restarts || (orderedItem.isNew && orderedItem.number !== topOrderedNext))) {
        while (output.length > 0 && !output[output.length - 1].trim()) output.pop();
        if (output.length > 0) output[output.length - 1] = output[output.length - 1].replace(/\n+$/, '');
        output.push('\n\n<!-- -->\n\n');
        endListContext();
      } else if (orderedItem?.restarts && item.listMeta!.level > 0 && listContentEnd !== undefined
          && output.slice(listContentEnd).every(part => !part.trim())) {
        // So does a sublist, which a comment in its parent item keeps apart
        while (output.length > 0 && !output[output.length - 1].trim()) output.pop();
        if (output.length > 0) output[output.length - 1] = output[output.length - 1].replace(/\n+$/, '');
        const level = item.listMeta!.level;
        output.push('\n\n' + (options?.listIndent === 'tab' ? '\t'.repeat(level) : ' '.repeat(listItemIndent(level))) + '<!-- -->\n\n');
      }
      // Comment bodies written into the quote before stand where lines
      // without > kept it apart from this one. Unless this one opens an
      // alert or is nested deeper, it needs a blank line, or it would go on
      // their paragraph.
      if (quotedBodies && output[output.length - 2] === quotedBodies.text && output[output.length - 1] === '\n'
          && item.blockquoteLevel && item.blockquoteGroupIndex !== quotedBodies.group
          && !item.alertType && item.blockquoteLevel <= quotedBodies.level) {
        output[output.length - 1] = '\n\n';
      }

      // Capture previous blockquote group index BEFORE updating, so the
      // alert-marker logic below can detect same-type group boundaries.
      const prevBlockquoteGroupIndex = lastBlockquoteGroupIndex;

      // Track blockquote group index for gap reconstruction.
      // Keep the index across non-blockquote paras so we can detect
      // group transitions even when structural separator paras intervene.
      if (item.blockquoteLevel && item.blockquoteGroupIndex !== undefined) {
        lastBlockquoteGroupIndex = item.blockquoteGroupIndex;
        pendingPostContentGroupIndex = item.blockquoteGroupIndex;
      } else if (item.headingLevel || item.listMeta || item.isCodeBlock) {
        // Real non-blockquote content resets the tracking
        lastBlockquoteGroupIndex = undefined;
        pendingPostContentGroupIndex = undefined;
      }

      // Track blockquote type for boundary detection (plain↔alert, alert↔alert).
      if (item.blockquoteLevel) {
        lastBlockquoteAlertType = item.alertType || 'plain';
        lastBlockquoteLevel = item.blockquoteLevel;
        lastBlockquoteListLevel = item.listContinuation?.level;
      } else if (item.headingLevel || item.listMeta || item.isCodeBlock) {
        lastBlockquoteAlertType = undefined;
        lastBlockquoteLevel = undefined;
      }

      // Emit per-paragraph/list indent sentinel
      if (item.indentOverride && !item.headingLevel && !item.blockquoteLevel && !item.isCodeBlock) {
        if (item.listMeta) {
          // Emit sentinel only before the first item of a list block
          if (item.listBlockStart) {
            // Indent the sentinel as the item so it doesn't break an
            // enclosing list as a top-level HTML block (CommonMark §4.6).
            const useTab = options?.listIndent === 'tab';
            const sentinelIndent = useTab
              ? '\t'.repeat(item.listMeta.level)
              : ' '.repeat(listItemIndent(item.listMeta.level));
            output.push(sentinelIndent + '<!-- ' + item.indentOverride + ' -->\n');
          }
        } else if (!item.listContinuation) {
          // Skip continuation paragraphs (list items with indented blockquotes) —
          // they're part of the enclosing list block, not standalone paragraphs.
          output.push('<!-- ' + item.indentOverride + ' -->\n');
        }
      }

      quoteLinePrefix = prefixesQuoteLines(item) ? blockquotePrefix(item) : '';
      currentPara = item;
      alertMarkerLineEnd = undefined;
      paragraphNested = !!(item.blockquoteLevel || item.listMeta || item.listContinuation);
      paragraphHeading = !!item.headingLevel;
      listLinePrefix = '';
      listHtmlBlockOpen = false;
      ownLine = !item.headingLevel && !item.listMeta && !item.isTitle;
      deferredCommentQuote = quoteLinePrefix ? { group: item.blockquoteGroupIndex, level: item.blockquoteLevel ?? 1 } : undefined;
      if (item.headingLevel) {
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
        if (item.paraMarkRevision) {
          // Whole-paragraph insertion/deletion (paragraph mark carries
          // w:ins/w:del): the heading marker belongs inside the Critic span
          // ({++### heading++}), so defer it to the rendered inline text.
          // Only where export reads all of it back as the revised heading:
          // text of the mark's revision alone, beside comments. Otherwise a
          // plain marker keeps the heading, and the mark is the tracked
          // break after its text (see joinTrackedParagraphBreaks).
          pendingHeadingCriticMarker = {
            marker: '#'.repeat(item.headingLevel) + ' ',
            revType: item.paraMarkRevision.type,
            whole: headingInMarkRevision(mergedContent, i),
          };
        } else {
          output.push('#'.repeat(item.headingLevel) + ' ');
        }
      } else if (item.listMeta) {
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
        const useTab = options?.listIndent === 'tab';
        // Under the content of its parent items, whatever their markers
        const indent = useTab
          ? '\t'.repeat(item.listMeta.level)
          : ' '.repeat(listItemIndent(item.listMeta.level));
        // Per-level counters handle nested lists (see nextOrderedNumber)
        listTypeByLevel.set(item.listMeta.level, item.listMeta.type);
        const orderedNum = orderedItem?.number ?? 1;
        const listMarker = item.listMeta.type === 'bullet'
          ? (useTab ? (item.listMeta.bulletMarker ?? '-') + '\t' : (item.listMeta.bulletMarker ?? '-') + ' ')
          : (useTab ? orderedNum + '.\t' : orderedNum + '. ');
        // A task item's box is its text, which its sublists indent past only the marker of
        const marker = listMarker + (item.listMeta.taskChecked === undefined ? '' : item.listMeta.taskChecked ? '[x] ' : '[ ] ');
        if (item.listMeta.level === 0) topOrderedNext = item.listMeta.type === 'ordered' ? orderedNum + 1 : undefined;
        listMarkerWidths = [...listMarkerWidths.slice(0, item.listMeta.level), listMarker.length];
        listWordLevels = [...listWordLevels.slice(0, item.listMeta.level), wordLevel ?? item.listMeta.level];
        lastListItemEmpty = isEmptyListItem(i);
        output.push(indent + marker);
        listLinePrefix = listContinuationIndent({ type: item.listMeta.type, level: item.listMeta.level });
        const first = mergedContent[i + 1];
        if (first?.type === 'math' && first.display && first.inParagraph) mathInParagraph = { prefix: paragraphLinePrefix(item), sameLine: true, quoted: false };
      } else if (item.blockquoteLevel) {
        const itemPrefix = blockquotePrefix(item);
        const next = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
        const nextIsDisplayMath = next?.type === 'math' && next.display;
        if (!nextIsDisplayMath) output.push(itemPrefix);
        if (item.alertType) {
          const alertKey = item.blockquoteLevel + ':' + item.alertType;
          // A new alert group starts when the key differs OR when the
          // blockquoteGroupIndex has changed (same-type alerts in
          // different groups must each get their own [!TYPE] marker).
          const groupChanged = item.blockquoteGroupIndex !== undefined
            && prevBlockquoteGroupIndex !== undefined
            && item.blockquoteGroupIndex !== prevBlockquoteGroupIndex;
          const isAlertStart = lastAlertParagraphKey !== alertKey || groupChanged;
          if (isAlertStart) {
            if (nextIsDisplayMath) output.push(itemPrefix);
            output.push(toGfmAlertMarker(item.alertType));
            const isInlineMarker = options?.blockquoteAlertInlineByGroup?.get(item.blockquoteGroupIndex ?? -1) === true;
            // Nothing goes after the marker in a paragraph with nothing in
            // it, as one of spaces alone with its label hidden (see
            // dropBlankParagraphText), and text that writes nothing, as
            // spaces alone after the label, takes out the space or line end
            // after it (see alertMarkerLineEnd)
            if (!next || isStructuralBoundaryItem(next)) {
              pendingAlertInlinePrefixForHardBreak = undefined;
            } else if (isInlineMarker) {
              if (!nextIsDisplayMath) alertMarkerLineEnd = output.length;
              output.push(nextIsDisplayMath ? '\n' : ' ');
              pendingAlertInlinePrefixForHardBreak = item.listContinuation ? itemPrefix : undefined;
            } else {
              if (!nextIsDisplayMath) alertMarkerLineEnd = output.length;
              output.push('\n' + (nextIsDisplayMath ? '' : itemPrefix));
              pendingAlertInlinePrefixForHardBreak = undefined;
            }
            pendingAlertPrefixStrip = (next && next.type !== 'para') ? item.alertType : undefined;
            if (!pendingAlertPrefixStrip) {
              pendingAlertInlinePrefixForHardBreak = undefined;
            }
          } else {
            pendingAlertPrefixStrip = undefined;
            pendingAlertInlinePrefixForHardBreak = undefined;
          }
          lastAlertParagraphKey = alertKey;
        } else {
          lastAlertParagraphKey = undefined;
          pendingAlertPrefixStrip = undefined;
          pendingAlertInlinePrefixForHardBreak = undefined;
        }
        if (nextIsDisplayMath) {
          pendingDisplayMathContainer = { prefix: itemPrefix, type: 'blockquote' };
        }
      } else if (item.listContinuation) {
        const continuationPrefix = listContinuationIndent(item.listContinuation);
        listLinePrefix = continuationPrefix;
        const next = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
        if (next?.type === 'math' && next.display) {
          pendingDisplayMathContainer = { prefix: continuationPrefix, type: 'list' };
        } else {
          output.push(continuationPrefix);
        }
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
      } else {
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
        if (item.horizontalRule) {
          // A comment on it goes on the line after, which keeps the line a rule
          const next = mergedContent[i + 1];
          output.push(next?.type === 'text' ? '---\n' : '---');
        }
      }

      prevItemWasListQuote = !!item.blockquoteLevel && !!item.listContinuation;
      lastListType = isCurrentList
        ? item.listMeta!.type
        : item.listContinuation?.type;
      lastListLevel = isCurrentList
        ? item.listMeta!.level
        : item.listContinuation?.level;
      // A paragraph in an item ends the items under it, which an item after
      // it can't nest in
      if (!isCurrentList && item.listContinuation) {
        listMarkerWidths = listMarkerWidths.slice(0, item.listContinuation.level + 1);
        listWordLevels = listWordLevels.slice(0, item.listContinuation.level + 1);
      }
      // Blank lines alone go on in the list, whose open items an item after
      // them nests in, numbered as Word shows it
      if (!isCurrentList && !item.listContinuation) {
        if (isPlainEmptyParagraph(item) && !paragraphHasContent(mergedContent, i)) listTypeByLevel.clear();
        else endListContext();
      }

      i++;
      continue;
    }

    if (item.type === 'landscape_open') {
      // Check if this is a single-table landscape section (table-only, no title/notes).
      // If the custom property says so, suppress the fences and let the table's
      // data-orientation attribute handle it instead. Export numbers only the
      // fences' gaps, so such a section takes no number.
      if (renderOpts?.landscapeTableIndices?.has(tableIndex)) {
        // Peek ahead: landscape_open → table → landscape_close
        const nextItem = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
        const afterTable = i + 2 < mergedContent.length ? mergedContent[i + 2] : undefined;
        if (nextItem?.type === 'table' && afterTable?.type === 'landscape_close') {
          // Skip the open fence; the table will be rendered next with data-orientation.
          // We also need to skip the close fence after the table. Set a flag.
          skipNextLandscapeClose = true;
          i++;
          continue;
        }
      }
      const gapKey = 'lo' + sentinelLoIdx;
      sentinelLoIdx++;
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- landscape -->');
      endListContext();
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('lo', 'loa');
      i++;
      continue;
    }
    if (item.type === 'landscape_close') {
      if (skipNextLandscapeClose) {
        skipNextLandscapeClose = false;
        i++;
        continue;
      }
      const gapKey = 'lc' + sentinelLcIdx;
      sentinelLcIdx++;
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- /landscape -->');
      endListContext();
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('lc', 'lca');
      i++;
      continue;
    }

    if (item.type === 'portrait_open') {
      if (renderOpts?.portraitTableIndices?.has(tableIndex)) {
        const nextItem = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
        const afterTable = i + 2 < mergedContent.length ? mergedContent[i + 2] : undefined;
        if (nextItem?.type === 'table' && afterTable?.type === 'portrait_close') {
          skipNextPortraitClose = true;
          i++;
          continue;
        }
      }
      const gapKey = 'po' + sentinelPoIdx;
      sentinelPoIdx++;
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- portrait -->');
      endListContext();
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('po', 'poa');
      i++;
      continue;
    }
    if (item.type === 'portrait_close') {
      if (skipNextPortraitClose) {
        skipNextPortraitClose = false;
        i++;
        continue;
      }
      const gapKey = 'pc' + sentinelPcIdx;
      sentinelPcIdx++;
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- /portrait -->');
      endListContext();
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('pc', 'pca');
      i++;
      continue;
    }

    if (item.type === 'bibliography_marker') {
      // After the line ends its empty paragraph wrote, as the after-gap of
      // a fence or a comment of its own before it, which export kept, as a
      // line end alone, or else a blank line
      if (output.length > 0 && trailingNewlines() === 0) output.push('\n\n');
      output.push('<!-- references -->');
      endListContext();
      lastAlertParagraphKey = undefined;
      pendingAlertPrefixStrip = undefined;
      pendingAlertInlinePrefixForHardBreak = undefined;
      lastBlockquoteAlertType = undefined;
      lastBlockquoteLevel = undefined;
      i++;
      continue;
    }

    if (item.type === 'custom_style_open') {
      const gapKey = 'cso' + sentinelCsoIdx;
      sentinelCsoIdx++;
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- style: ' + item.styleName + ' -->');
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('cso', 'csoa');
      i++;
      continue;
    }
    if (item.type === 'custom_style_close') {
      const gapKey = 'csc' + sentinelCscIdx;
      sentinelCscIdx++;
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- /style -->');
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('csc', 'csca');
      i++;
      continue;
    }

    if (item.type === 'math' && item.display) {
      const displayMathContainer = pendingDisplayMathContainer;
      const continued = mathInParagraph;
      mathInParagraph = undefined;
      const inBlockquote = displayMathContainer?.type === 'blockquote' || !!continued?.quoted;
      if (continued) {
        // On the line after the paragraph's text, whose line end is the
        // space before the equation export wrote for it
        if (!continued.sameLine) {
          const last = output.length - 1;
          if (output[last].endsWith('\n')) output.push(continued.prefix);
          else {
            output[last] = output[last].replace(/(?<!\\) $/, '');
            output.push('\n' + continued.prefix);
          }
        }
      } else if (!inBlockquote && output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        // Ensure blank line before display math
        output.push('\n\n');
      }
      const mathBlock = MATH_FENCE + '\n' + canonicalizeDisplayMathLatex(item.latex) + '\n' + MATH_FENCE;
      const commented = displayMathWithComments(item.revision ? wrapWithRevision(mathBlock, item.revision) : mathBlock, item);
      // Text after the equation in its paragraph goes on from the closing
      // fence, so a body there would come before it
      const next = mergedContent[i + 1];
      const textFollows = next !== undefined && (next.type === 'text' || next.type === 'citation'
        || next.type === 'footnote_ref' || next.type === 'image' || (next.type === 'math' && !next.display));
      if (textFollows) pendingEquationBodies.push(...commented.bodies);
      const revisedMathBlock = [commented.block, ...(textFollows ? [] : commented.bodies)].join('\n');
      if (displayMathContainer) {
        output.push(revisedMathBlock.split('\n').map(line => displayMathContainer.prefix + line).join('\n'));
        pendingDisplayMathContainer = undefined;
      } else if (continued) {
        output.push(revisedMathBlock.split('\n').map((line, k) => (k === 0 ? '' : continued.prefix) + line).join('\n'));
      } else {
        output.push(revisedMathBlock);
        // A top-level display math block breaks list flow. An indented list
        // continuation instead keeps the parent numbering context active.
        endListContext();
      }
      pendingAlertPrefixStrip = undefined;
      pendingAlertInlinePrefixForHardBreak = undefined;
      if (!inBlockquote) {
        lastAlertParagraphKey = undefined;
        lastBlockquoteAlertType = undefined;
        lastBlockquoteLevel = undefined;
      }
      // An equation right after it in its paragraph goes on in it too
      const following = mergedContent[i + 1];
      if (item.inParagraph && following?.type === 'math' && following.display && following.inParagraph) {
        mathInParagraph = continued
          ? { ...continued, sameLine: false }
          : { prefix: currentPara ? paragraphLinePrefix(currentPara) : '', sameLine: false, quoted: !!currentPara?.blockquoteLevel };
      }
      i++;
      continue;
    }

    if (item.type === 'table') {
      flushPendingHeadingCriticMarker();
      if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      // If this table was originally an embed directive, emit the directive instead of
      // rendering the table. Table directives (font-size, etc.) are emitted as a prefix
      // before the embed directive. Multi-table embeds (e.g. a .md file with 2 tables)
      // produce multiple consecutive tables sharing the same directive — emit it once
      // and skip the rest to avoid snowballing duplicates on round-trip.
      const rawEmbedValue = renderOpts?.embedDirectiveMapping?.get(String(tableIndex));
      if (rawEmbedValue) {
        // Stored value may be prefixed with embedIdx + tab to distinguish
        // separate embed occurrences that share the same directive text.
        const tabPos = rawEmbedValue.indexOf('\t');
        const embedDirective = tabPos >= 0 ? rawEmbedValue.substring(tabPos + 1) : rawEmbedValue;
        const { fontPrefix: embedPrefix } = buildTableDirectivePrefix(renderOpts, tableIndex);
        pushWithHoistedPrefix(output, embedPrefix, embedDirective, documentStartCommentGap);
        tableIndex++;
        i++;
        // Skip subsequent tables from the same embed occurrence (same raw stored value).
        // Tolerate intervening empty paragraphs that Word may insert between tables.
        while (i < mergedContent.length) {
          const cur = mergedContent[i];
          if (cur.type === 'table'
            && renderOpts?.embedDirectiveMapping?.get(String(tableIndex)) === rawEmbedValue) {
            tableIndex++;
            i++;
          } else if (cur.type === 'para' && isPlainEmptyParagraph(cur)
            && !paragraphHasContent(mergedContent, i)) {
            // Peek ahead: only skip the empty paragraph if a table from the
            // same embed follows (avoid swallowing trailing blank lines).
            let peek = i + 1;
            while (peek < mergedContent.length && mergedContent[peek].type === 'para'
              && isPlainEmptyParagraph(mergedContent[peek] as Extract<ContentItem, { type: 'para' }>)
              && !paragraphHasContent(mergedContent, peek)) {
              peek++;
            }
            if (peek < mergedContent.length && mergedContent[peek].type === 'table'
              && renderOpts?.embedDirectiveMapping?.get(String(tableIndex)) === rawEmbedValue) {
              // Skip empty paragraphs up to and including the next embed table
              i = peek;
              // The table itself will be consumed on the next loop iteration
            } else {
              break;
            }
          } else {
            break;
          }
        }
        endListContext();
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
        lastBlockquoteAlertType = undefined;
        lastBlockquoteLevel = undefined;
        continue;
      }
      const storedFormat = renderOpts?.tableFormatMapping?.get(String(tableIndex));
      const tableResult = renderTableOrFallback(item, comments, options, renderOpts, storedFormat, tableIndex);
      // One that goes on in the HTML block of the table before it, with
      // nothing between them in Word, and no HTML before it of its own
      if (tableJoin !== undefined && output[output.length - 1] === '\n\n' && tableResult.body.startsWith('<table')) output[output.length - 1] = tableJoin;
      if (tableResult.before) {
        output.push(tableResult.before + '\n\n' + tableResult.directivePrefix + tableResult.body);
      } else {
        pushWithHoistedPrefix(output, tableResult.directivePrefix, tableResult.body, documentStartCommentGap);
      }
      if (tableResult.after) output.push('\n\n' + tableResult.after);
      lastTableJoin = tableResult.join;
      tableIndex++;
      endListContext();
      lastAlertParagraphKey = undefined;
      pendingAlertPrefixStrip = undefined;
      pendingAlertInlinePrefixForHardBreak = undefined;
      lastBlockquoteAlertType = undefined;
      lastBlockquoteLevel = undefined;
      i++;
      continue;
    }

    const rendered = renderInlineRange(mergedContent, i, comments, { stopBeforeDisplayMath: true, nested: paragraphNested, heading: paragraphHeading }, renderOpts);
    if (rendered.nextIndex <= i) {
      throw new Error('Invariant violated: renderInlineRange did not advance index');
    }
    // A leading comment in an alert paragraph is inline content;
    // pendingAlertPrefixStrip means its blockquote prefix was already emitted.
    // So is one in a quote, list item or heading, after the line's prefix,
    // which export doesn't count among the comments of their own that take
    // an index for their blank lines (annotateHtmlCommentIndices).
    const amongOwnComments = !pendingAlertPrefixStrip && !paragraphNested && !paragraphHeading;
    // One no para item started, as one a comment starts that starts a
    // section, as the first paragraph has none, writes the separator the
    // fence before it left, a block of comments alone or not, and before its
    // indent's columns are counted on the line it's on
    if (output.length > 0 && incomingSep !== null) output.push(incomingSep);

    rendered.deferredComments.unshift(...pendingEquationBodies.splice(0));
    let textOut = rendered.text;
    // With the label hidden, export writes neither it nor the line end after
    // the marker, so all of the text is the alert's (see hidesAlertLabel)
    if (pendingAlertPrefixStrip && options?.calloutLabels !== false) {
      // Text on the marker's line has no space of export's before it
      const inlineMarker = options?.blockquoteAlertInlineByGroup?.get(currentPara?.blockquoteGroupIndex ?? -1) === true;
      textOut = stripAlertLeadPrefix(rendered.text, pendingAlertPrefixStrip, inlineMarker);
      // Spaces and tabs alone after the label leave the alert empty, as they
      // would a paragraph (see dropBlankParagraphText), unless an equation
      // goes on in it
      if (/^[ \t]+$/.test(textOut) && !isInParagraphMath(mergedContent[rendered.nextIndex])) textOut = '';
    }
    if (pendingAlertInlinePrefixForHardBreak !== undefined && (textOut.startsWith('\n') || textOut.startsWith('\\\n'))) {
      const markerIdx = output.length - 1;
      const continuationPrefix = '\n' + pendingAlertInlinePrefixForHardBreak;
      if (markerIdx >= 0 && output[markerIdx].endsWith(' ')) {
        output[markerIdx] = output[markerIdx].slice(0, -1) + continuationPrefix;
      } else {
        output.push(continuationPrefix);
      }
      if (textOut.startsWith('\\\n')) {
        textOut = textOut.slice(2);
      } else if (textOut.startsWith('\n')) {
        textOut = textOut.slice(1);
      }
    }
    pendingAlertPrefixStrip = undefined;
    pendingAlertInlinePrefixForHardBreak = undefined;
    const atStart = isMarkdownBlockEdge(mergedContent[i - 1]);
    const atEnd = isMarkdownBlockEdge(mergedContent[rendered.nextIndex]);
    const next = mergedContent[rendered.nextIndex];
    // Not after a heading's text, which a line can't go on
    const mathFollows = !paragraphHeading && next?.type === 'math' && next.display && !!next.inParagraph;
    // A line break as \ before a line end holds in a paragraph's text but
    // not at its end, where Markdown drops the line end and keeps the \ as
    // text, nor in a heading, which the line end ends, so there it's <br>,
    // which export reads as one, before comment bodies too. Spaces and tabs
    // after the last, which keepParagraphWhitespace writes as references
    // after a \ and a line end, are references after a <br> too, where
    // they'd end the heading, which Markdown drops. A comment's
    // body, which takes a <br> as text, keeps its \ and line end, which
    // export reads in it in a heading too.
    if (paragraphHeading) {
      const breaks = new Set(lineStartsAfterBreaks(textOut));
      textOut = textOut.replace(HARD_BREAK, (match: string, backslashes: string, whitespace: string | undefined, offset: number) =>
        !breaks.has(offset + backslashes.length + 2) ? match
          : backslashes + '<br>' + (whitespace ?? '').replace(/[ \t]/g, c => c === ' ' ? '&#32;' : '&#9;'));
    } else if (atEnd && !isInParagraphMath(mergedContent[rendered.nextIndex])) {
      // After comments alone, which start an HTML block, a \ and line end
      // are the block's text, so each line break is <br>, which export
      // reads there (see isLineBreakBlock)
      const comments = commentsBeforeBreaks(textOut);
      textOut = comments ? comments[0] + comments[1].replace(/\\\n/g, '<br>')
        : textOut.replace(HARD_BREAK_AT_END, (_m, backslashes: string) => backslashes + '<br>');
    }
    // A line break before the == of a highlight that ends the text is <br>
    // too, as == alone on the last line would read as a heading's
    // underline, before an equation in the paragraph as well
    textOut = textOut.replace(HARD_BREAK_BEFORE_HIGHLIGHT_CLOSE_AT_END, (_m, backslashes: string, close: string) => backslashes + '<br>' + close);
    // An HTML block's indent, of up to three columns, which markdown-it keeps
    // in its text, and a reference would make a paragraph's. A tab in it
    // goes on to the next stop, every four columns from the line's start,
    // past the prefix written on it, so after a quote's > and space a tab
    // is two, as export reads it, but at the margin four, which makes code.
    // Before line breaks, and comments a paragraph reads too, with whatever
    // follows them, it's references, as a space before a line break that
    // ends the paragraph is &#32;<br>, and a tab before a comment and text
    // &#9;<!-- c -->a, whose block would show them as text, and since export
    // puts a block of comments' indent in the first one's hidden run. Not
    // where that run held it, with the paragraph's comments' runs all it
    // holds, as export wrote them, but for spaces and tabs Word put after
    // them, which export trims, nor before a comment a paragraph would
    // read as text, as one with a blank line in it, which only the block
    // holds, or as more than it, as one that ends in ---> with the next.
    const indent = ownLine && atStart ? /^[ \t]+(?=<)/.exec(textOut)?.[0] ?? '' : '';
    let indentColumns = 0;
    if (indent) {
      let line = '';
      for (let k = output.length - 1; k >= 0; k--) {
        const end = output[k].lastIndexOf('\n');
        line = output[k].slice(end + 1) + line;
        if (end !== -1) break;
      }
      indentColumns = columnAfter(line + indent) - columnAfter(line);
    }
    const htmlIndent = indentColumns <= 3 ? indent : '';
    const referenced = keepParagraphWhitespace(textOut, atStart, atEnd);
    const items = mergedContent.slice(i, rendered.nextIndex);
    const payloads = items.flatMap((item, k) => item.type === 'html_comment' ? [markdownComment(item.text, items[k + 1]?.type === 'html_comment')] : []);
    // A block of comments and line breaks gives back runs that are each one
    // comment, as export splits it at each one's first -->, so a paragraph
    // mustn't merge those; others, as Word split, it may
    const blockKeepsRuns = isLineBreakBlock(textOut) && payloads.every(payload => payload.startsWith('<!--') && payload.indexOf('-->', 4) === payload.length - 3);
    // Text the runs hold outside their comments, read together as Word may
    // split one, which a paragraph would show, the block keeps hidden in
    // its run, with the rest of the paragraph, where that's spaces and tabs
    // and the block is the comments' (see annotateHtmlCommentIndices)
    const commentsAlone = items.every(item => item.type === 'html_comment' || item.type === 'text' && /^[ \t]*$/.test(item.text));
    const hidesText = /\S/.test(outsideComments(payloads.join(''))) && commentsAlone
      && /^<!--[\s\S]*?-->\s*$/.test(textOut.trim());
    const runHoldsIndent = commentsAlone && items[0]?.type === 'html_comment' && /^[ \t]/.test(items[0].text);
    const inline = () => !hidesText && (isLineBreakBlock(textOut) || /^[ \t]*<!--/.test(textOut) && !runHoldsIndent)
      && readsCommentsInline(referenced, payloads, !blockKeepsRuns);
    // Whitespace alone before an equation in the paragraph keeps the space
    // export wrote for its line end as it is, which the math branch takes
    // off, as it does after other text, or it would gain one each round trip
    textOut = mathFollows && /^[ \t]* $/.test(textOut) ? keepParagraphWhitespace(textOut.slice(0, -1), atStart, atEnd) + ' '
      : htmlIndent && startsHtmlBlock(' '.repeat(indentColumns) + textOut.slice(htmlIndent.length)) && !inline()
        ? htmlIndent + keepParagraphWhitespace(textOut.slice(htmlIndent.length), true, atEnd)
        : referenced;
    if (atEnd && !isInParagraphMath(next)) textOut = withoutEndSpaces(textOut);
    if (mathFollows) textOut = beforeParagraphMath(textOut);
    // Track standalone HTML comment paragraphs for gap metadata and keep the
    // blank lines a para item wrote before them, where export reads what
    // import wrote as one: a block that starts and ends with a comment, as
    // parseMd trims it, so with the spaces and tabs of a raw indent and of
    // its end, as Word puts after the run, but not a reference before it,
    // which makes a paragraph, nor line breaks or text after the comment.
    // Its items say which, not its Markdown, which a comment Word put on the
    // run adds to, in its comments' runs, which Word may split, before them
    // too in ID syntax, {#1}<!-- c -->{/1}, which export counts as well (see
    // isCommentsWithIds), but not with a space or tab between the syntax and
    // the comments, which its paragraph keeps as text. There, as markdown-it
    // reads a paragraph's, an empty one, <!--> or <!--->, is a comment too,
    // but not as a block, which export reads as text.
    const solid = items.filter(entry => entry.type !== 'text' || /[^ \t]/.test(entry.text));
    const ownComments = items.map((entry, k) => entry.type === 'text' ? entry.text
      : entry.type === 'html_comment' ? markdownComment(entry.text, items[k + 1]?.type === 'html_comment') : '').join('').trim();
    if (amongOwnComments && solid[0]?.type === 'html_comment' && solid[solid.length - 1].type === 'html_comment'
      && items.every(entry => entry.type !== 'text' || !entry.text.includes('\n'))
      && /^[ \t]*(?:\{#[^}\s]+\})*<!--/.test(textOut) && /-->(?:\{\/[^}\s]+\}|\{>>(?:(?!<<\})[\s\S])*<<\})*[ \t]*$/.test(textOut)
      && (/^<!--[\s\S]*?-->\s*$/.test(ownComments) || /^[ \t]*\{#/.test(textOut) && /^<!---?>$/.test(ownComments))) {
      // In ID syntax, {#1}<!-- c -->{/1}, the comments are a paragraph, not
      // an HTML block, which a line end alone joins to the paragraphs around
      // it, so a blank line at least goes on each side, where its block had
      // none, as in a\n<!-- c -->\nb, but for a comment's own line before
      // it, whose HTML block ends there, and one after it, which starts one
      const paragraph = /^[ \t]*\{#/.test(textOut);
      lastHtmlCommentIsParagraph = paragraph;
      // A blank line, where export stored none
      if (output.length === 0) documentStartCommentGap = htmlCommentGaps?.get(htmlCommentIndex) ?? 1;
      if (output.length > 0) {
        if (incomingSep === null) {
          // Use before-gap metadata for this html_comment.
          // The empty para marker that precedes the html_comment item may have
          // already contributed newlines to the output (via the para separator
          // chain).  Count existing trailing newlines and only add the delta so
          // the total matches the original source gap.
          const savedGap = htmlCommentGaps?.get(htmlCommentIndex);
          const gapCount = savedGap === 0 && paragraph && !afterCommentLine(output) ? 1 : savedGap;
          if (gapCount !== undefined) {
            const desiredNewlines = gapCount + 1; // gapCount blank lines = gapCount+1 \n
            // Count trailing newlines already in output
            let existingNewlines = 0;
            for (let oi = output.length - 1; oi >= 0; oi--) {
              const s = output[oi];
              let j = s.length - 1;
              while (j >= 0 && s[j] === '\n') { existingNewlines++; j--; }
              if (j >= 0) break; // hit non-newline content, stop
            }
            const needed = desiredNewlines - existingNewlines;
            if (needed > 0) {
              output.push('\n'.repeat(needed));
            } else if (needed < 0) {
              // Too many trailing newlines — trim excess from the output tail
              let toRemove = -needed;
              while (toRemove > 0 && output.length > 0) {
                const last = output[output.length - 1];
                let trailingNL = 0;
                for (let j = last.length - 1; j >= 0 && last[j] === '\n'; j--) trailingNL++;
                if (trailingNL === 0) break;
                const removeFromThis = Math.min(toRemove, trailingNL);
                if (removeFromThis === last.length) {
                  output.pop();
                } else {
                  output[output.length - 1] = last.slice(0, last.length - removeFromThis);
                }
                toRemove -= removeFromThis;
              }
            }
          } else if (!output[output.length - 1].endsWith('\n\n')) {
            output.push('\n\n');
          }
        }
      }
      lastRenderedHtmlCommentIndex = htmlCommentIndex;
      htmlCommentIndex++;
    }
    if (paragraphHeading) {
      // A run of # that ends a heading's text, after a space or tab or as
      // all of it, is its closing sequence to Markdown, which drops it
      textOut = textOut.replace(/(^|[ \t])(#+[ \t]*)$/, (_m, before: string, hashes: string) => before + '\\' + hashes);
    }
    if (pendingHeadingCriticMarker !== undefined) {
      // Re-insert the heading marker inside the leading Critic span so the
      // whole-paragraph form {++### heading++} round-trips. If the inline
      // content doesn't start with a Critic addition/deletion (unexpected),
      // fall back to a plain heading prefix.
      const openMatch = /^\{(\+\+|--)/.exec(textOut);
      const { marker, revType, whole } = pendingHeadingCriticMarker;
      // Comments, their anchors or range markers before the revision's text,
      // or as all of the heading's
      const afterComments = /^(?:\{==|\{#[^}\s]+\}|\{>>[\s\S]*?<<\})+(?:\{(\+\+|--)|$)/.exec(textOut);
      if (!whole) {
        textOut = marker + textOut;
      } else if (openMatch) {
        textOut = textOut.slice(0, openMatch[0].length) + marker + textOut.slice(openMatch[0].length);
      } else if (afterComments && (afterComments[1] ?? (revType === 'addition' ? '++' : '--')) === (revType === 'addition' ? '++' : '--')) {
        // After a comment's anchor or range marker, as in
        // {=={--Heading--}==}{>>c<<}, or before nothing, as in {>>c<<}, the
        // marker takes a span of its own, which export reads as the heading's
        textOut = (revType === 'addition' ? '{++' + marker + '++}' : '{--' + marker + '--}') + textOut;
      } else {
        textOut = marker + textOut;
      }
      pendingHeadingCriticMarker = undefined;
    }
    // The line after a tracked break that ends a list item's text takes
    // the item's indent (see joinTrackedParagraphBreaks)
    if (breakMarks && listLinePrefix) textOut = textOut.split(breakMarks.indent).join(listLinePrefix);
    // A quote's continuation lines, as of a comment's body, take its prefix,
    // without which a line break in the body reads as a paragraph break
    if (quoteLinePrefix) {
      textOut = textOut.replace(/\n(?=([\s\S]))/g, (_m, next: string) =>
        '\n' + (next === '\n' ? quoteLinePrefix.trimEnd() : quoteLinePrefix));
    } else if (listLinePrefix && /^ {0,3}</.test(textOut) && textOut.includes('\n') && startsHtmlBlock(textOut)) {
      // A paragraph's lines stay in it without, and a comment's body would
      // take the indent as its text. A blank line too, which a <pre> can
      // hold, and which ends the item's block at the margin
      textOut = textOut.replace(/\n(?=[\s\S])/g, '\n' + listLinePrefix);
    }
    listHtmlBlockOpen = !!listLinePrefix && startsHtmlBlock(textOut) && !HTML_BLOCK_ENDS_AT_MARKER.test(textOut.trimStart());
    if (rendered.deferredComments.length > 0) {
      // Before an equation, whose line end is the one after the bodies (see
      // the math branch), a line break is a \ before the bodies' line end,
      // which export keeps, and the space export wrote before it goes
      const text = mathFollows
        ? textOut.replace(HARD_BREAK_AT_END, (_m, backslashes: string) => backslashes + '\\').replace(/(?<!\\) $/, '')
        : textOut.replace(/(\\?\n)+$/, '');
      output.push(text);
      output.push('\n');
      const bodies = rendered.deferredComments.join('\n').split('\n')
        .map(line => (line ? quoteLinePrefix : quoteLinePrefix.trimEnd()) + line).join('\n');
      output.push(bodies);
      if (deferredCommentQuote) quotedBodies = { text: bodies, ...deferredCommentQuote };
    } else {
      output.push(textOut);
      // Nothing follows an alert's marker in its paragraph, which takes the
      // place of the marker's space or line end
      if (alertMarkerLineEnd !== undefined && textOut === '' && !mathFollows) output[alertMarkerLineEnd] = '';
    }
    // An equation in the paragraph goes on in it, after the comments' bodies
    // where they go after the text, and where there's no text before it, on
    // the line the text would start, as after an item's task box or an
    // alert's marker. The first paragraph has no para item before it.
    if (mathFollows) {
      mathInParagraph = {
        prefix: currentPara ? paragraphLinePrefix(currentPara) : '',
        sameLine: textOut === '' && rendered.deferredComments.length === 0,
        quoted: !!currentPara?.blockquoteLevel,
      };
    }
    alertMarkerLineEnd = undefined;
    i = rendered.nextIndex;
  }
  // Trailing empty revised heading: serialize its deferred marker.
  flushPendingHeadingCriticMarker();

  // Leave out a <!-- references --> marker the body ends with, where export
  // puts the bibliography without one, at the end of the document, which in
  // Markdown only the notes' definitions follow, so as not to add a marker
  // that wasn't in the original: a block of its own, after a blank line, as
  // import writes it, or on the line after a fence or a comment of its own,
  // as it writes it there, not one in the block of a line before it, as the
  // HTML around a table is, which a comment that the marker ends can go on
  // in past a blank line.
  const body = output.join('');
  const endingMarker = /(?:^|\n+)<!--\s*references\s*-->\s*$/.exec(body);
  if (endingMarker) {
    const line = body.slice(0, endingMarker.index + endingMarker[0].indexOf('<!--')).split('\n').length - 1;
    if (!htmlBlocksIn(body).some(block => block.start < line && line < block.end)) output.splice(0, output.length, body.slice(0, endingMarker.index));
  }

  // Append footnote definitions
  if (options?.notes) {
    // A note's images take the notes' image format mapping for its part, as
    // their relationship IDs are that part's, not the document's, but where
    // there is none, as before export wrote one, the document's held them
    const noteMapping = renderOpts.noteImageFormatMapping;
    const noteRenderOptsByKind = Object.fromEntries((['footnote', 'endnote'] as const).map(kind => [kind, noteMapping
      ? { ...renderOpts, imageFormatMapping: noteImageFormats(noteMapping, kind === 'endnote' ? 'endnotes' : 'footnotes') }
      : renderOpts])) as Record<'footnote' | 'endnote', RenderOpts>;
    citationsNoted = false;
    for (const entry of noteEntries) {
      const noteRenderOpts = noteRenderOptsByKind[entry.noteKind];
      output.push('\n\n');
      const bodyMerged = noteBodies.get(entry)!;
      // Render body, splitting on para/table markers for multi-paragraph footnotes
      const bodyParts: string[] = [];
      // The comment bodies that go after each part, as after their
      // paragraph in the body: those of a paragraph's comments go after the
      // part that ends it (see endParagraph)
      const partBodies: string[][] = [];
      let paragraphBodies: string[] = [];
      const endParagraph = () => {
        if (paragraphBodies.length === 0 || bodyParts.length === 0) return;
        (partBodies[bodyParts.length - 1] ??= []).push(...paragraphBodies);
        paragraphBodies = [];
      };
      let partStart = 0;
      // The text of a part, from partStart, which ends its paragraph. Word's
      // space or tab after the note's mark went on import (see
      // parseNoteBody), so whitespace at its start is the text's. A line
      // break at its end is <br>, as at a paragraph's end in the body, but
      // not before an equation in the paragraph (`beforeMath`), which the
      // paragraph goes on in after it, unless a highlight's == comes after
      // it (see HARD_BREAK_BEFORE_HIGHLIGHT_CLOSE_AT_END), and where
      // whitespace alone keeps the space export wrote for its line end as it
      // is, as in the body.
      const inlinePart = (text: string, beforeMath = false) => {
        const broken = (beforeMath ? text : text.replace(HARD_BREAK_AT_END, (_m, backslashes: string) => backslashes + '<br>'))
          .replace(HARD_BREAK_BEFORE_HIGHLIGHT_CLOSE_AT_END, (_m, backslashes: string, close: string) => backslashes + '<br>' + close);
        const atStart = partStart === 0 || isMarkdownBlockEdge(bodyMerged[partStart - 1]);
        return beforeMath && /^[ \t]* $/.test(broken) ? keepParagraphWhitespace(broken.slice(0, -1), atStart, true) + ' '
          : beforeMath ? beforeParagraphMath(keepParagraphWhitespace(broken, atStart, true))
            : withoutEndSpaces(keepParagraphWhitespace(broken, atStart, true));
      };
      // The part that holds the paragraph's text and display math so far,
      // which an equation in the paragraph goes on in, on the next line, and
      // text after one from its closing fence, as in the document
      let paragraphPart: number | undefined;
      const pushInline = (text: string) => {
        if (paragraphPart === undefined) {
          bodyParts.push(text);
          paragraphPart = bodyParts.length - 1;
        } else {
          bodyParts[paragraphPart] += text;
        }
      };
      // The note's code blocks, in order, each in the numbering export gave
      // it, one that goes as paragraphs too (see demoteNoteCodeBlocks)
      const demoted = noteCodeDemoted.get(entry)!;
      let codeBlock = 0;
      const skipDemoted = () => {
        while (demoted[codeBlock]) { codeBlockGroupIndex++; codeBlock++; }
      };
      // The line end or spaces an HTML table's HTML ended with before the
      // next table in its block, and the table's item, as in the body
      let noteTableJoin: { join: string; at: number } | undefined;
      for (let bi = 0; bi < bodyMerged.length; bi++) {
        const item = bodyMerged[bi];
        if (item.type === 'para' && item.isCodeBlock) {
          // A code block, as in the body, which ends the text before it, and
          // the language export stored for it, as it numbers code blocks on
          // from the body's. The empty paragraph export writes between two
          // goes.
          skipDemoted();
          codeBlock++;
          const code = codeBlockFence(bodyMerged, bi, codeBlockLangs?.get(String(codeBlockGroupIndex++)) || '');
          if (bi > partStart) {
            const part = renderInlineRange(bodyMerged, partStart, comments, { stopBeforeDisplayMath: true }, noteRenderOpts);
            pushInline(inlinePart(part.text));
            paragraphBodies.push(...part.deferredComments);
          }
          endParagraph();
          paragraphPart = undefined;
          bodyParts.push(code.block);
          const sep = bodyMerged[code.end];
          const afterSep = bodyMerged[code.end + 1];
          bi = sep?.type === 'para' && !sep.isCodeBlock && afterSep?.type === 'para' && afterSep.isCodeBlock ? code.end + 1 : code.end;
          partStart = bi;
          bi--;
          continue;
        }
        if (item.type === 'para') {
          if (bi > partStart) {
            const part = renderInlineRange(bodyMerged, partStart, comments, { stopBeforeDisplayMath: true }, noteRenderOpts);
            pushInline(inlinePart(part.text));
            paragraphBodies.push(...part.deferredComments);
          }
          endParagraph();
          partStart = bi + 1;
          paragraphPart = undefined;
        } else if (item.type === 'math' && item.display) {
          // Flush preceding inline content and keep display math as its own block part.
          if (bi > partStart) {
            const part = renderInlineRange(bodyMerged, partStart, comments, { stopBeforeDisplayMath: true }, noteRenderOpts);
            pushInline(inlinePart(part.text, !!item.inParagraph));
            paragraphBodies.push(...part.deferredComments);
          }
          const mathBlock = MATH_FENCE + '\n' + canonicalizeDisplayMathLatex(item.latex) + '\n' + MATH_FENCE;
          const commented = displayMathWithComments(item.revision ? wrapWithRevision(mathBlock, item.revision) : mathBlock, item);
          if (item.inParagraph && paragraphPart !== undefined) {
            // In place of the space export wrote for the line's end, or after
            // the line end of a line break that ends the text
            const text = bodyParts[paragraphPart].replace(/(?<!\\) $/, '');
            bodyParts[paragraphPart] = text + (text.endsWith('\n') ? '' : '\n') + commented.block;
          } else {
            if (!item.inParagraph) endParagraph();
            bodyParts.push(commented.block);
            paragraphPart = item.inParagraph ? bodyParts.length - 1 : undefined;
          }
          paragraphBodies.push(...commented.bodies);
          partStart = bi + 1;
        } else if (item.type === 'table') {
          // Flush preceding inline content
          if (bi > partStart) {
            const part = renderInlineRange(bodyMerged, partStart, comments, { stopBeforeDisplayMath: true }, noteRenderOpts);
            pushInline(inlinePart(part.text));
            paragraphBodies.push(...part.deferredComments);
          }
          endParagraph();
          paragraphPart = undefined;
          const noteRawEmbedValue = noteRenderOpts?.embedDirectiveMapping?.get(String(tableIndex));
          if (noteRawEmbedValue) {
            const noteTabPos = noteRawEmbedValue.indexOf('\t');
            const noteEmbedDirective = noteTabPos >= 0 ? noteRawEmbedValue.substring(noteTabPos + 1) : noteRawEmbedValue;
            const { fontPrefix: noteEmbedPrefix } = buildTableDirectivePrefix(noteRenderOpts, tableIndex);
            bodyParts.push(noteEmbedPrefix + noteEmbedDirective);
            tableIndex++;
            bi++;
            // Skip subsequent tables from the same embed occurrence,
            // including Word-inserted empty paragraphs between them
            while (bi < bodyMerged.length) {
              const next = bodyMerged[bi];
              if (next.type === 'table'
                && noteRenderOpts?.embedDirectiveMapping?.get(String(tableIndex)) === noteRawEmbedValue) {
                tableIndex++;
                bi++;
              } else if (next.type === 'para' && isPlainEmptyParagraph(next)
                && !paragraphHasContent(bodyMerged, bi)) {
                // Only skip plain empty spacer paragraphs when they sit
                // between tables from the same embed occurrence.
                let peek = bi + 1;
                while (peek < bodyMerged.length && bodyMerged[peek].type === 'para'
                  && isPlainEmptyParagraph(bodyMerged[peek] as Extract<ContentItem, { type: 'para' }>)
                  && !paragraphHasContent(bodyMerged, peek)) {
                  peek++;
                }
                if (peek < bodyMerged.length && bodyMerged[peek].type === 'table'
                  && noteRenderOpts?.embedDirectiveMapping?.get(String(tableIndex)) === noteRawEmbedValue) {
                  bi = peek;
                } else {
                  break;
                }
              } else if (next.type === 'text' && !next.text?.trim()) {
                bi++;
              } else {
                break;
              }
            }
            partStart = bi;
            bi--; // compensate for the for-loop's bi++ on continue
            continue;
          } else {
            const noteStoredFormat = noteRenderOpts?.tableFormatMapping?.get(String(tableIndex));
            const noteTableResult = renderTableOrFallback(item, comments, options, noteRenderOpts, noteStoredFormat, tableIndex, noteScopes.get(entry));
            if (noteTableJoin?.at === bi - 1 && noteTableResult.body.startsWith('<table')) {
              bodyParts[bodyParts.length - 1] += noteTableJoin.join + noteTableResult.body;
            } else {
              if (noteTableResult.before) bodyParts.push(noteTableResult.before);
              if (noteTableResult.directivePrefix) {
                bodyParts.push(noteTableResult.directivePrefix.replace(/\n+$/, '') + '\n' + noteTableResult.body);
              } else {
                bodyParts.push(noteTableResult.body);
              }
              if (noteTableResult.after) bodyParts.push(noteTableResult.after);
            }
            noteTableJoin = noteTableResult.join !== undefined ? { join: noteTableResult.join, at: bi } : undefined;
          }
          tableIndex++;
          partStart = bi + 1;
        }
      }
      skipDemoted();
      if (partStart < bodyMerged.length) {
        const part = renderInlineRange(bodyMerged, partStart, comments, { stopBeforeDisplayMath: true }, noteRenderOpts);
        pushInline(inlinePart(part.text));
        paragraphBodies.push(...part.deferredComments);
      }
      if (bodyParts.length === 0) {
        bodyParts.push('');
      }
      endParagraph();
      const indent4 = (s: string) => s.split('\n').map(l => '    ' + l).join('\n');
      // On the lines after the part, as in the body (see deferredComments)
      const withBodies = (pi: number) => partBodies[pi] ? '\n' + partBodies[pi].map(l => indent4(l)).join('\n') : '';
      const first = bodyParts[0].replace(/^\s+/, '');
      if (first.includes('\n')) {
        // Block form: label on its own line, blank line, then indented body
        output.push(`[^${entry.label}]:\n\n` + indent4(first) + withBodies(0));
      } else {
        output.push(`[^${entry.label}]: ${first}` + withBodies(0));
      }
      for (let pi = 1; pi < bodyParts.length; pi++) {
        output.push('\n\n' + indent4(bodyParts[pi]) + withBodies(pi));
      }
    }
  }

  trackedBreakStart = undefined;
  knownCitationKeys = new Set();
  citationsNoted = true;
  return breakMarks ? joinSpansAtTrackedBreaks(output.join(''), breakMarks) : output.join('');
}

function formatOffsetString(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Format a timestamp to the minute, in the given UTC offset (such as -05:00) or else the system's timezone. */
export function formatLocalIsoMinute(ts: string, timezone?: string): string {
  const dt = new Date(ts);
  if (isNaN(dt.getTime())) {
    throw new Error(`Invalid timestamp: ${ts}`);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = timezone?.match(/^([+-])(\d{2}):(\d{2})$/);
  if (offset) {
    const minutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
    const at = new Date(dt.getTime() + minutes * 60000);
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  }
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function getLocalTimezoneOffset(): string {
  return formatOffsetString(-new Date().getTimezoneOffset());
}

// BibTeX generation

/** Escape normalized metadata directly using the shared BibTeX text policy. */
export function escapeBibtex(s: string): string {
  return escapeBibtexText(s);
}

/** Map CSL type back to the most appropriate BibTeX entry type. */
export function mapCSLTypeToBibtex(cslType: string, genre?: string): string {
  switch (cslType) {
    case 'article-journal':
    case 'article-magazine':
    case 'article-newspaper':
      return 'article';
    case 'book':
      return 'book';
    case 'chapter':
      return 'incollection';
    case 'paper-conference':
      return 'inproceedings';
    case 'thesis':
      return genre && /master/i.test(genre) ? 'mastersthesis' : 'phdthesis';
    case 'report':
      return 'techreport';
    default:
      return 'misc';
  }
}

/** Serialize a single CSL name entry to BibTeX author format. */
function serializeAuthor(a: { family?: string; given?: string; literal?: string }): string {
  if (a.literal) return `{${escapeBibtex(a.literal)}}`;
  return [a.family, a.given].filter((s): s is string => Boolean(s)).map(escapeBibtex).join(', ');
}

/** CSL fields whose values are verbatim identifiers — not LaTeX text.
 *  These must NOT be run through escapeBibtex because escaping `_`, `%`,
 *  `#`, `~` corrupts URLs, DOIs, and similar machine-readable strings. */
const VERBATIM_CSL_FIELDS: ReadonlySet<string> = new Set([
  'DOI', 'URL', 'ISBN', 'ISSN',
]);

/** CSL-JSON field → BibTeX field mapping (for fields stored in fullItemData). */
const CSL_TO_BIBTEX: Record<string, string> = {
  'editor': 'editor',
  'publisher': 'publisher',
  'publisher-place': 'address',
  'URL': 'url',
  'ISBN': 'isbn',
  'ISSN': 'issn',
  'issue': 'number',
  'edition': 'edition',
  'abstract': 'abstract',
  'note': 'note',
  'collection-title': 'series',
};

export function generateBibTeX(
  zoteroCitations: ZoteroCitation[],
  keyMap: Map<string, string>,
  originalKeyOrder?: string[] | null,
): string {
  const entries: string[] = [];
  const entryByKey = originalKeyOrder ? new Map<string, string>() : null;
  const emitted = new Set<string>();

  // Each item once, with the data of its field that has the most
  for (const { meta, ids } of citedItems(zoteroCitations)) {
    const key = [...ids].map(id => keyMap.get(id)).find(k => k !== undefined);
    if (!key || emitted.has(key)) { continue; }
    emitted.add(key);

    const authorStr = meta.authors.map(serializeAuthor).join(' and ');

    const genre = meta.fullItemData.genre;
    const entryType = mapCSLTypeToBibtex(meta.type, typeof genre === 'string' ? genre : undefined);
    const fields: string[] = [];
    const alreadyEmitted = new Set<string>();

    if (authorStr) { fields.push(`  author = {${authorStr}}`); alreadyEmitted.add('author'); }
    if (meta.title) { fields.push(`  title = {{${escapeBibtex(meta.title)}}}`); alreadyEmitted.add('title'); }

    // Emit container-title as journal or booktitle depending on entry type
    if (meta.journal) {
      if (entryType === 'incollection' || entryType === 'inproceedings') {
        fields.push(`  booktitle = {${escapeBibtex(meta.journal)}}`);
      } else {
        fields.push(`  journal = {${escapeBibtex(meta.journal)}}`);
      }
      alreadyEmitted.add('container-title');
    }

    if (meta.volume) { fields.push(`  volume = {${escapeBibtex(meta.volume)}}`); alreadyEmitted.add('volume'); }
    if (meta.pages) { fields.push(`  pages = {${escapeBibtex(meta.pages)}}`); alreadyEmitted.add('page'); }
    if (meta.year) { fields.push(`  year = {${escapeBibtex(meta.year)}}`); alreadyEmitted.add('issued'); }
    if (meta.doi) { fields.push(`  doi = {${meta.doi}}`); alreadyEmitted.add('DOI'); }

    // Editor from fullItemData
    const editorData = meta.fullItemData?.editor;
    if (Array.isArray(editorData) && editorData.length > 0) {
      const editorStr = editorData.map(serializeAuthor).join(' and ');
      if (editorStr) { fields.push(`  editor = {${editorStr}}`); }
      alreadyEmitted.add('editor');
    }

    // Institution for techreport entries: prefer explicit x-institution
    // (BibTeX roundtrip), then fall back to publisher (Zotero maps its
    // "Institution" field to CSL publisher for report types).
    if (entryType === 'techreport') {
      const xInstitution = meta.fullItemData?.['x-institution'];
      if (typeof xInstitution === 'string' && xInstitution) {
        fields.push(`  institution = {${escapeBibtex(xInstitution)}}`);
      } else {
        const pub = meta.fullItemData?.publisher;
        if (typeof pub === 'string' && pub) {
          fields.push(`  institution = {${escapeBibtex(pub)}}`);
          alreadyEmitted.add('publisher');
        }
      }
    }

    // Additional CSL→BibTeX fields from fullItemData
    for (const [cslField, bibtexField] of Object.entries(CSL_TO_BIBTEX)) {
      if (alreadyEmitted.has(cslField)) continue;
      if (cslField === 'editor') continue; // handled above
      const val = meta.fullItemData?.[cslField];
      if (val != null && (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')) {
        const strVal = String(val);
        fields.push(`  ${bibtexField} = {${VERBATIM_CSL_FIELDS.has(cslField) ? strVal : escapeBibtex(strVal)}}`);
        alreadyEmitted.add(cslField);
      }
    }

    if (meta.zoteroKey) { fields.push(`  zotero-key = {${meta.zoteroKey}}`); }
    if (meta.zoteroUri) { fields.push(`  zotero-uri = {${meta.zoteroUri}}`); }

    const entryStr = `@${entryType}{${key},\n${fields.join(',\n')},\n}`;
    entries.push(entryStr);
    if (entryByKey) entryByKey.set(key, entryStr);
  }

  // Reorder output to match original key order when provided (used by Layer 2 caller)
  if (originalKeyOrder && originalKeyOrder.length > 0 && entryByKey) {
    const ordered: string[] = [];
    const remaining = new Map(entryByKey);
    for (const key of originalKeyOrder) {
      const entry = remaining.get(key);
      if (entry) {
        ordered.push(entry);
        remaining.delete(key);
      }
    }
    // Append any entries not in the original order (new citations added in Word)
    for (const entry of remaining.values()) {
      ordered.push(entry);
    }
    return ordered.join('\n\n');
  }

  return entries.join('\n\n');
}

/**
 * Extract consecutive Title-styled paragraphs from the beginning of the document.
 * Returns the plain text of each title paragraph. Removes the extracted items
 * (para markers and their text runs) from the content array in place.
 */
export function extractTitleLines(content: ContentItem[]): string[] {
  const titles: string[] = [];
  let i = 0;

  while (i < content.length) {
    const item = content[i];
    // Skip leading plain para separators (no heading/list/title/rule) that precede the first title
    if (item.type === 'para' && !item.isTitle && !item.headingLevel && !item.listMeta && !item.horizontalRule && titles.length === 0) {
      i++;
      continue;
    }
    if (item.type !== 'para' || !item.isTitle) break;

    // Collect text runs following this title para marker
    const startIdx = i;
    i++;
    let text = '';
    while (i < content.length && content[i].type === 'text') {
      text += (content[i] as { type: 'text'; text: string }).text;
      i++;
    }
    titles.push(text);
    // Remove extracted items
    content.splice(startIdx, i - startIdx);
    i = startIdx;
  }

  return titles;
}

/** Extract dc:creator from docProps/core.xml (the document author). */
export async function extractAuthor(zip: JSZip): Promise<string | undefined> {
  const parsed = await readZipXml(zip, 'docProps/core.xml');
  if (!parsed) return undefined;
  for (const node of findAllDeep(parsed, 'dc:creator')) {
    const text = nodeText(asXmlNodes(node['dc:creator'])).trim();
    if (text) return text;
  }
  return undefined;
}

type AwaitedRecord<T extends Record<string, PromiseLike<unknown>>> = {
  [K in keyof T]: Awaited<T[K]>;
};

async function allNamed<T extends Record<string, PromiseLike<unknown>>>(promises: T): Promise<AwaitedRecord<T>> {
  const entries = await Promise.all(Object.entries(promises).map(
    async ([key, promise]) => [key, await promise] as const,
  ));
  return Object.fromEntries(entries) as AwaitedRecord<T>;
}

// Main conversion

/** Extract heading/title font properties from word/styles.xml for round-trip. */
function extractFontOverridesFromStyles(stylesXml: string, opts?: { explicitTableFontSize?: boolean; builtInIds?: Map<string, string> }): Partial<Frontmatter> {
  const result: Partial<Frontmatter> = {};
  // The document's ID of each built-in style it gives another, by the ID
  // this reads it by (see StyleLayouts.builtInIds)
  const documentIds = new Map<string, string>();
  for (const [id, builtInId] of opts?.builtInIds ?? []) if (!documentIds.has(builtInId)) documentIds.set(builtInId, id);

  /** Where the next w:style element starts from `from`, or -1, with any
   *  whitespace before its first attribute */
  function nextStyleStart(from: number): number {
    const start = /<w:style\s/g;
    start.lastIndex = from;
    return start.exec(stylesXml)?.index ?? -1;
  }

  // Helper: find a style block by styleId and extract rPr content
  function getStyleRPr(id: string): string | null {
    const styleId = documentIds.get(id) ?? id;
    let searchFrom = 0;
    while (true) {
      const idx = nextStyleStart(searchFrom);
      if (idx === -1) return null;
      const closeTag = stylesXml.indexOf('</w:style>', idx);
      if (closeTag === -1) return null;
      const block = stylesXml.substring(idx, closeTag + '</w:style>'.length);
      if (block.includes('w:styleId="' + styleId + '"')) {
        // Skip past pPr to find style-level rPr
        const pPrEnd = block.indexOf('</w:pPr>');
        const rPrStart = block.indexOf('<w:rPr>', pPrEnd !== -1 ? pPrEnd : 0);
        const rPrEnd = block.indexOf('</w:rPr>', rPrStart !== -1 ? rPrStart : 0);
        if (rPrStart !== -1 && rPrEnd !== -1) return block.substring(rPrStart, rPrEnd + '</w:rPr>'.length);
        return null;
      }
      searchFrom = closeTag + '</w:style>'.length;
    }
  }

  function extractAttr(rpr: string, prefix: string): string | null {
    const idx = rpr.indexOf(prefix);
    if (idx === -1) return null;
    const start = idx + prefix.length;
    const end = rpr.indexOf('"', start);
    return end !== -1 ? rpr.substring(start, end) : null;
  }

  function extractFont(rpr: string): string | undefined {
    // Export escapes a name such as "A & B"
    const v = extractAttr(rpr, 'w:ascii="')?.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (_, dec: string, hex: string, name: string) =>
      dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16))
        : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name]);
    return v || undefined;
  }

  function extractSizeHp(rpr: string): number | undefined {
    const v = /<w:sz\b[^>]*?\sw:val="(\d+)"/.exec(rpr)?.[1];
    return v ? Number(v) : undefined;
  }

  function isXmlToggleOn(rpr: string, tag: string): boolean {
    // Self-closing with no attributes: <w:b/>
    if (rpr.includes('<' + tag + '/>')) return true;
    // Tag with attributes: <w:b w:val="true"/>  or  <w:b w:val="1">
    const re = new RegExp('<' + tag + '\\s[^>]*?(?:/>|>)');
    const m = re.exec(rpr);
    if (!m) return false;
    const vm = /w:val="([^"]*)"/.exec(m[0]);
    if (!vm) return true; // present with no w:val → on
    const v = vm[1];
    return v === 'true' || v === '1' || v === 'on';
  }

  function extractStyle(rpr: string, ppr?: string | null): string {
    const parts: string[] = [];
    if (isXmlToggleOn(rpr, 'w:b')) parts.push('bold');
    if (isXmlToggleOn(rpr, 'w:i')) parts.push('italic');
    // Underline: bare <w:u/> or any w:val except "none"
    const underline = /<w:u\b[^>]*>/.exec(rpr)?.[0];
    if (underline && !/\sw:val="none"/.test(underline)) parts.push('underline');
    if (isXmlToggleOn(rpr, 'w:smallCaps')) parts.push('smallcaps');
    if (isXmlToggleOn(rpr, 'w:caps')) parts.push('allcaps');
    // Center alignment from pPr (paragraph-level property)
    if (ppr && /<w:jc\b[^>]*?\sw:val="center"/.test(ppr)) parts.push('center');
    return parts.length > 0 ? parts.join('-') : 'normal';
  }

  /** Extract pPr content from a style block. */
  function getStylePPr(id: string): string | null {
    const styleId = documentIds.get(id) ?? id;
    let searchFrom = 0;
    while (true) {
      const idx = nextStyleStart(searchFrom);
      if (idx === -1) return null;
      const closeTag = stylesXml.indexOf('</w:style>', idx);
      if (closeTag === -1) return null;
      const block = stylesXml.substring(idx, closeTag + '</w:style>'.length);
      if (block.includes('w:styleId="' + styleId + '"')) {
        const pPrStart = block.indexOf('<w:pPr');
        const pPrEnd = block.indexOf('</w:pPr>');
        if (pPrStart !== -1 && pPrEnd !== -1) return block.substring(pPrStart, pPrEnd + '</w:pPr>'.length);
        return null;
      }
      searchFrom = closeTag + '</w:style>'.length;
    }
  }

  // Extract Normal (body) font for comparison
  const normalRpr = getStyleRPr('Normal');
  const bodyFont = normalRpr ? extractFont(normalRpr) : undefined;
  const bodySizeHp = normalRpr ? extractSizeHp(normalRpr) : undefined;

  // Emit body font/fontSize when they differ from Word defaults
  if (bodyFont && bodyFont !== 'Calibri') result.font = bodyFont;
  if (bodySizeHp !== undefined && bodySizeHp !== 22) result.fontSize = bodySizeHp / 2;

  // Default heading sizes in half-points
  const defaultHp: Record<string, number> = {
    Heading1: 32, Heading2: 26, Heading3: 24, Heading4: 22, Heading5: 20, Heading6: 18,
  };
  const ids = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'];

  const fonts: (string | undefined)[] = [];
  const sizes: (number | undefined)[] = [];
  const styles: (string | undefined)[] = [];

  for (const id of ids) {
    const rpr = getStyleRPr(id);
    if (rpr) {
      fonts.push(extractFont(rpr));
      sizes.push(extractSizeHp(rpr));
      styles.push(extractStyle(rpr, getStylePPr(id)));
    } else {
      fonts.push(undefined);
      sizes.push(undefined);
      styles.push(undefined);
    }
  }

  // Trim trailing duplicates helper
  function trimTrailing<T>(arr: T[]): T[] {
    let end = arr.length;
    while (end > 1 && arr[end - 1] === arr[end - 2]) end--;
    return arr.slice(0, end);
  }

  // headerFont: emit if any heading font differs from body font
  const hFonts = fonts.map(f => f || bodyFont);
  if (hFonts.some(f => f && f !== bodyFont)) {
    const trimmed = trimTrailing(hFonts.filter((f): f is string => !!f));
    if (trimmed.length > 0) result.headerFont = trimmed;
  }

  // headerFontSize: emit if any heading size differs from default
  // Fill undefined entries with defaults to preserve positional alignment
  if (sizes.some((s, i) => s !== undefined && s !== defaultHp[ids[i]])) {
    const ptSizes = sizes.map((s, i) => (s !== undefined ? s : defaultHp[ids[i]]) / 2);
    result.headerFontSize = trimTrailing(ptSizes);
  }

  // headerFontStyle: emit if any heading style differs from default (bold)
  // Fill undefined entries with 'bold' (default heading style) to preserve positional alignment
  if (styles.some(s => s !== undefined && s !== 'bold')) {
    const filled = styles.map(s => s !== undefined ? s : 'bold');
    result.headerFontStyle = trimTrailing(filled);
  }

  // Title extraction
  const titleRpr = getStyleRPr('Title');
  if (titleRpr) {
    const tFont = extractFont(titleRpr);
    if (tFont && tFont !== bodyFont) result.titleFont = [tFont];
    const tSizeHp = extractSizeHp(titleRpr);
    if (tSizeHp !== undefined && tSizeHp !== 56) result.titleFontSize = [tSizeHp / 2];
    const tStyle = extractStyle(titleRpr, getStylePPr('Title'));
    if (tStyle !== 'normal') result.titleFontStyle = [tStyle];
  }

  // TableParagraph extraction
  const tableRpr = getStyleRPr('TableParagraph');
  if (tableRpr) {
    const tblFont = extractFont(tableRpr);
    if (tblFont && tblFont !== bodyFont) result.tableFont = tblFont;
    const tblSizeHp = extractSizeHp(tableRpr);
    if (tblSizeHp !== undefined) {
      const bsHp = bodySizeHp ?? 22;
      // Suppress table-font-size when it matches auto-shrink default (body - 4hp),
      // since auto-shrink always reproduces it on import — unless the original
      // frontmatter explicitly set table-font-size (explicitTableFontSize flag).
      const autoDefault = Math.max(1, bsHp - 4);
      if (opts?.explicitTableFontSize || tblSizeHp !== autoDefault) {
        result.tableFontSize = tblSizeHp / 2;
      }
    }
  }

  // CodeBlock extraction: export sets its size a point under a body size the
  // frontmatter sets, or else to 10pt
  const codeRpr = getStyleRPr('CodeBlock');
  if (codeRpr) {
    const codeFont = extractFont(codeRpr);
    if (codeFont && codeFont !== 'Consolas') result.codeFont = codeFont;
    const codeSizeHp = extractSizeHp(codeRpr);
    const inferredHp = bodySizeHp !== undefined && bodySizeHp !== 22 ? Math.max(1, bodySizeHp - 2) : 20;
    if (codeSizeHp !== undefined && codeSizeHp !== inferredHp) result.codeFontSize = codeSizeHp / 2;
  }

  // Custom named styles: detect "Custom: ..." styles for fallback extraction
  const extractedCustomStyles: Record<string, CustomStyleDef> = {};
  let csSearchPos = 0;
  while (true) {
    const idx = stylesXml.indexOf('w:customStyle="1"', csSearchPos);
    if (idx === -1) break;
    // Find enclosing <w:style> block
    const styleStart = [...stylesXml.slice(0, idx).matchAll(/<w:style\s/g)].pop()?.index ?? -1;
    const styleEnd = stylesXml.indexOf('</w:style>', idx);
    if (styleStart === -1 || styleEnd === -1) { csSearchPos = idx + 17; continue; }
    const block = stylesXml.substring(styleStart, styleEnd + '</w:style>'.length);
    const nameMatch = block.match(/w:name\s+w:val="Custom:\s*([^"]+)"/);
    if (!nameMatch) { csSearchPos = styleEnd + 10; continue; }
    const styleName = nameMatch[1].trim();
    const csStyleIdMatch = block.match(/w:styleId="([^"]+)"/);
    const csStyleId = csStyleIdMatch ? csStyleIdMatch[1] : '';
    const def: CustomStyleDef = {};
    const csRpr = getStyleRPr(csStyleId);
    if (csRpr) {
      const f = extractFont(csRpr);
      if (f && f !== bodyFont) def.font = f;
      const s = extractSizeHp(csRpr);
      if (s !== undefined) def.fontSize = s / 2;
      const st = extractStyle(csRpr, getStylePPr(csStyleId));
      if (st !== 'normal') def.fontStyle = st;
    }
    const csPpr = getStylePPr(csStyleId);
    if (csPpr) {
      const beforeMatch = csPpr.match(/w:before="(\d+)"/);
      if (beforeMatch) def.spacingBefore = parseInt(beforeMatch[1], 10) / 20;
      const afterMatch = csPpr.match(/w:after="(\d+)"/);
      if (afterMatch) def.spacingAfter = parseInt(afterMatch[1], 10) / 20;
      const firstLineMatch = csPpr.match(/w:firstLine="(\d+)"/);
      if (firstLineMatch) {
        const firstLineTwips = parseInt(firstLineMatch[1], 10);
        def.paragraphIndent = firstLineTwips === 0 ? 'none' : firstLineTwips / 1440;
      }
    }
    extractedCustomStyles[styleName] = def;
    csSearchPos = styleEnd + 10;
  }
  if (Object.keys(extractedCustomStyles).length > 0) result.styles = extractedCustomStyles;

  return result;
}

/** The style most of the body's quote paragraphs are in, the first's on a
 *  tie, which export writes them all in, so the fewest change, however
 *  they group in quotes; GitHub, its default, needs no setting. */
function inferredBlockquoteStyle(content: ContentItem[]): BlockquoteStyle | undefined {
  const counts = new Map<BlockquoteStyle, number>();
  for (const item of content) {
    if (item.type === 'para' && item.blockquoteStyle) counts.set(item.blockquoteStyle, (counts.get(item.blockquoteStyle) ?? 0) + 1);
  }
  // A Map keeps the order the styles first appear in
  let most: BlockquoteStyle | undefined;
  for (const [style, count] of counts) if (most === undefined || count > counts.get(most)!) most = style;
  return most === 'GitHub' ? undefined : most;
}

export async function convertDocx(
  data: Uint8Array,
  format: CitationKeyFormat = 'authorYearTitle',
  options?: { tableIndent?: string; alwaysUseCommentIds?: boolean; imageFolder?: string; pipeTableMaxLineWidth?: number; pipeTableMaxLineWidthDefault?: number; gridTableMaxLineWidth?: number; gridTableMaxLineWidthDefault?: number; existingBibtex?: string; preferredBibliographyPath?: string },
): Promise<ConvertResult> {
  const zip = await loadZip(data);
  const {
    comments,
    zoteroCitations,
    footnoteCitations,
    endnoteCitations,
    zoteroPrefs,
    author,
    commentIdMapping,
    footnoteIdMapping,
    footnoteCrossRefMapping,
    codeBlockLangMapping,
    threads,
    codeBlockStyling,
    blockquoteGapMapping,
    blockquotePreContentBlankLineMapping,
    blockquotePostContentBlankLineMapping,
    blockquoteAlertStyleMapping,
    imageFormatMapping,
    noteImageFormatMapping,
    tableFormatMapping,
    pipeTableAlignedMapping,
    gridSourceColWidthsMapping,
    tableFontSizeMapping,
    tableFontMapping,
    tableColWidthsMapping,
    tableDigitsMapping,
    tableDecimalMarkMapping,
    tableDigitGroupingMapping,
    tableHtmlAroundMapping,
    tableIdentities,
    storedPipeTableMaxLineWidth,
    storedGridTableMaxLineWidth,
    storedListIndent,
    consecutiveReplyParaIds,
    storedFrontmatterBlankLines,
    htmlCommentGapMapping,
    bibKeyOrder,
    storedBibData,
    storedBibliographyPath,
    landscapeTableMapping,
    portraitTableMapping,
    portraitBreaks,
    referencesBeforeSections,
    hiddenBeforeSections,
    hiddenAfterSections,
    templatePageSections,
    explicitTableFontSize,
    storedFieldOrder,
    htmlCommentAfterGapMapping,
    sentinelGapMapping,
    defaultTableColWidths,
    storedCustomStyles,
    storedTableBorders,
    storedLineSpacing,
    storedParagraphIndent,
    storedBibHangingIndent,
    storedCalloutLabels,
    storedSettings,
    storedDefaultCsl,
    storedIndentOverrides,
    storedListIndentOverrides,
    embedDirectiveMapping,
    defaultTableDigits,
    defaultTableDecimalMark,
    defaultTableDigitGrouping,
  } = await allNamed({
    comments: extractComments(zip),
    zoteroCitations: extractZoteroCitations(zip),
    footnoteCitations: extractZoteroCitations(zip, 'word/footnotes.xml'),
    endnoteCitations: extractZoteroCitations(zip, 'word/endnotes.xml'),
    zoteroPrefs: extractZoteroPrefs(zip),
    author: extractAuthor(zip),
    commentIdMapping: extractCommentIdMapping(zip),
    footnoteIdMapping: extractFootnoteIdMapping(zip),
    footnoteCrossRefMapping: extractFootnoteCrossRefMapping(zip),
    codeBlockLangMapping: extractCodeBlockLanguageMapping(zip),
    threads: extractCommentThreads(zip),
    codeBlockStyling: extractCodeBlockStyling(zip),
    blockquoteGapMapping: extractBlockquoteGapMapping(zip),
    blockquotePreContentBlankLineMapping: extractBlockquotePreContentBlankLineMapping(zip),
    blockquotePostContentBlankLineMapping: extractBlockquotePostContentBlankLineMapping(zip),
    blockquoteAlertStyleMapping: extractBlockquoteAlertStyleMapping(zip),
    imageFormatMapping: extractImageFormatMapping(zip),
    noteImageFormatMapping: extractNoteImageFormatMapping(zip),
    tableFormatMapping: extractTableFormatMapping(zip),
    pipeTableAlignedMapping: extractPipeTableAlignedMapping(zip),
    gridSourceColWidthsMapping: extractGridSourceColWidthsMapping(zip),
    tableFontSizeMapping: extractTableFontSizeMapping(zip),
    tableFontMapping: extractTableFontMapping(zip),
    tableColWidthsMapping: extractTableColWidthsMapping(zip),
    tableDigitsMapping: extractTableDigitsMapping(zip),
    tableDecimalMarkMapping: extractTableDecimalMarkMapping(zip),
    tableDigitGroupingMapping: extractTableDigitGroupingMapping(zip),
    tableHtmlAroundMapping: extractTableHtmlAroundMapping(zip),
    tableIdentities: extractTableIdentities(zip),
    storedPipeTableMaxLineWidth: extractPipeTableMaxLineWidth(zip),
    storedGridTableMaxLineWidth: extractGridTableMaxLineWidth(zip),
    storedListIndent: extractListIndent(zip),
    consecutiveReplyParaIds: extractConsecutiveReplyParaIds(zip),
    storedFrontmatterBlankLines: extractFrontmatterBlankLines(zip),
    htmlCommentGapMapping: extractHtmlCommentGapMapping(zip),
    bibKeyOrder: extractBibKeyOrder(zip),
    storedBibData: extractBibData(zip),
    storedBibliographyPath: extractBibliographyPath(zip),
    landscapeTableMapping: extractLandscapeTableMapping(zip),
    portraitTableMapping: extractPortraitTableMapping(zip),
    portraitBreaks: extractPortraitBreakOrdinals(zip),
    referencesBeforeSections: extractBreakOrdinals(zip, 'MANUSCRIPT_REFERENCES_BEFORE_SECTIONS_'),
    hiddenBeforeSections: extractSectionCounts(zip, 'MANUSCRIPT_HIDDEN_BEFORE_SECTIONS_'),
    hiddenAfterSections: extractSectionCounts(zip, 'MANUSCRIPT_HIDDEN_AFTER_SECTIONS_'),
    templatePageSections: extractBreakOrdinals(zip, 'MANUSCRIPT_TEMPLATE_PAGE_SECTIONS_'),
    explicitTableFontSize: extractExplicitTableFontSize(zip),
    storedFieldOrder: extractFrontmatterFieldOrder(zip),
    htmlCommentAfterGapMapping: extractHtmlCommentAfterGapMapping(zip),
    sentinelGapMapping: extractSentinelGapMapping(zip),
    defaultTableColWidths: extractDefaultTableColWidths(zip),
    storedCustomStyles: extractCustomStyles(zip),
    storedTableBorders: extractTableBorders(zip),
    storedLineSpacing: extractLineSpacing(zip),
    storedParagraphIndent: extractParagraphIndent(zip),
    storedBibHangingIndent: extractBibliographyHangingIndent(zip),
    storedCalloutLabels: extractCalloutLabels(zip),
    storedSettings: extractFrontmatterSettings(zip),
    storedDefaultCsl: extractDefaultCsl(zip),
    storedIndentOverrides: extractIndentOverrides(zip),
    storedListIndentOverrides: extractListIndentOverrides(zip),
    embedDirectiveMapping: extractEmbedDirectiveMapping(zip),
    defaultTableDigits: extractDefaultTableDigits(zip),
    defaultTableDecimalMark: extractDefaultTableDecimalMark(zip),
    defaultTableDigitGrouping: extractDefaultTableDigitGrouping(zip),
  });

  // Resolve pipeTableMaxLineWidth: explicit override > stored DOCX value > caller default > 120
  // Each tier is validated so NaN / negative / non-integer values are treated as "no value".
  const validWidth = (v: number | null | undefined): number | undefined =>
    v != null && Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : undefined;
  const resolvedPipeTableMaxLineWidth = validWidth(options?.pipeTableMaxLineWidth)
    ?? validWidth(storedPipeTableMaxLineWidth)
    ?? validWidth(options?.pipeTableMaxLineWidthDefault)
    ?? 120;

  const resolvedGridTableMaxLineWidth = validWidth(options?.gridTableMaxLineWidth)
    ?? validWidth(storedGridTableMaxLineWidth)
    ?? validWidth(options?.gridTableMaxLineWidthDefault)
    ?? 120;

  // Group reply comments under their parents and get IDs to exclude from ranges
  const replyIds = groupCommentThreads(comments, threads);
  const commentBodies = new Set(comments.keys());

  // Mark parent comments whose replies were originally in consecutive format
  if (consecutiveReplyParaIds && consecutiveReplyParaIds.size > 0) {
    for (const comment of comments.values()) {
      if (comment.paraId && consecutiveReplyParaIds.has(comment.paraId) && comment.replies && comment.replies.length > 0) {
        comment.consecutiveReplies = true;
      }
    }
  }

  // One key for each item, wherever it's cited, and a .bib entry for it: the
  // body's items take theirs first, then the footnotes', then the endnotes'
  const allCitations = [...zoteroCitations, ...footnoteCitations, ...endnoteCitations];
  const keyMap = buildCitationKeyMap(allCitations, format);

  // Parse note-specific rels and numbering for footnote/endnote body parsing
  const [numberingResult, docRelsParsed, fnRelsParsed, enRelsParsed] = await Promise.all([
    parseNumberingDefinitions(zip),
    parseDocumentRelationships(zip),
    parseDocumentRelationships(zip, 'word/_rels/footnotes.xml.rels'),
    parseDocumentRelationships(zip, 'word/_rels/endnotes.xml.rels'),
  ]);
  const styleLayouts = await parseStyleLayouts(zip);
  const numberingDefs = numberingResult.defs;
  const numberingStartOverrides = numberingResult.startOverrides;
  const numberingInstances = numberingResult.instances;
  const numberingStyles = numberingResult.styles;
  const docRels = docRelsParsed.hyperlinks;
  const imageRels = docRelsParsed.images;

  // Build note contexts with merged rels (note rels + document rels as fallback)
  const fnRelsMerged = new Map([...docRels, ...fnRelsParsed.hyperlinks]);
  const enRelsMerged = new Map([...docRels, ...enRelsParsed.hyperlinks]);
  // One set of image files for the document and its notes, whose images'
  // relationships are each part's own
  const imageFiles: ImageFiles = { entries: [], filenames: new Map() };
  const imageFolder = options?.imageFolder ?? '';
  const fnContext: NoteBodyContext = { relationshipMap: fnRelsMerged, images: { relationships: fnRelsParsed.images, folder: imageFolder, files: imageFiles }, zoteroCitations: footnoteCitations, keyMap, numberingDefs, numberingStartOverrides, format, replyIds, commentBodies, styleLayouts };
  const enContext: NoteBodyContext = { relationshipMap: enRelsMerged, images: { relationships: enRelsParsed.images, folder: imageFolder, files: imageFiles }, zoteroCitations: endnoteCitations, keyMap, numberingDefs, numberingStartOverrides, format, replyIds, commentBodies, styleLayouts };

  const { content: docContent, zoteroBiblData, leadingBlankParagraphs } = await extractDocumentContent(zip, zoteroCitations, keyMap, { numberingDefs, numberingStartOverrides, numberingInstances, numberingStyles, relationshipMap: docRels, replyIds, commentBodies, imageRelationships: imageRels, imageFolder: options?.imageFolder, imageFiles, portraitBreakOrdinals: portraitBreaks ?? undefined, referencesBeforeSections: referencesBeforeSections ?? undefined, hiddenBeforeSections: hiddenBeforeSections ?? undefined, hiddenAfterSections: hiddenAfterSections ?? undefined, templatePageSections: templatePageSections ?? undefined, customStyles: storedCustomStyles ?? undefined, footnoteCrossRefMap: footnoteCrossRefMapping ?? undefined, styleLayouts });
  // The notes the document references, in its order, which are the ones it
  // shows; their images take names after its own, footnotes' first
  const refOrder = noteReferences(docContent);
  const referenced = (kind: 'footnote' | 'endnote') => new Set(refOrder.filter(ref => ref.noteKind === kind).map(ref => ref.noteId));
  const footnotes = await extractFootnotes(zip, { ...fnContext, referenced: referenced('footnote') });
  const endnotes = await extractEndnotes(zip, { ...enContext, referenced: referenced('endnote') });

  // A task item is a list item, which the code block's spacer goes before
  markTaskListItems(docContent);
  dropCodeBlockSeparators(docContent);
  dropTableSeparators(docContent, item => isPlainEmptyParagraph(item) && item.emptyParagraphCount === 1 && !item.paraMarkRevision);
  for (const note of [...footnotes.values(), ...endnotes.values()]) dropTableSeparators(note.content, item => !item.isCodeBlock && !item.breakRevision);
  const {
    derivedBlockquoteGaps,
    derivedBlockquotePreContentBlankLines,
    derivedBlockquotePostContentBlankLines,
  } = annotateStructuralParagraphMetadata(docContent);
  // Spacer markers have served their sole purpose as grouping boundaries; remove
  // them before all later structural scans and Markdown rendering.
  for (let i = docContent.length - 1; i >= 0; i--) {
    const item = docContent[i];
    if (item.type === 'para' && item.isBlockquoteSpacer) docContent.splice(i, 1);
  }

  // Post-process: apply per-paragraph indent overrides from custom properties.
  // Uses the same body-paragraph counting as md-to-docx generation: count
  // non-heading, non-title, non-code, non-list, non-blockquote para items that
  // have inline content following them (i.e. not empty separator paragraphs).
  if (storedIndentOverrides) {
    // Whether the paragraph whose inline content starts at index from
    // counts, by the rule export's count used
    const counts = (from: number): boolean => countsForIndent((function* () {
      for (let j = from; j < docContent.length && !isStructuralBoundaryItem(docContent[j]); j++) yield docContent[j];
    })());
    // Paragraphs of spaces and tabs alone, which import made empty ones,
    // count as export counted them (see blankParagraphs)
    let bodyIdx = leadingBlankParagraphs ?? 0;
    let firstIdx = 0;
    // A plain first paragraph has no para item, since one only separates it
    // from what's before: its inline content starts docContent
    if (counts(0)) {
      const override = storedIndentOverrides.get(bodyIdx);
      if (override) {
        docContent.unshift({ type: 'para', indentOverride: override as 'indent' | 'no-indent' });
        firstIdx = 1;
      }
      bodyIdx++;
    }
    for (let ci = firstIdx; ci < docContent.length; ci++) {
      const item = docContent[ci];
      if (item.type !== 'para') continue;
      // Of any kind, as a heading holds those of a code block's spacer
      bodyIdx += item.blankParagraphs ?? 0;
      if (!isNumberedParagraphKind(item)) continue;
      // Skip empty separator paragraphs. One that empty paragraphs merged
      // into still counts when the paragraph's content follows.
      if (!counts(ci + 1)) { continue; }
      const override = storedIndentOverrides.get(bodyIdx);
      if (override) item.indentOverride = override as 'indent' | 'no-indent';
      bodyIdx++;
    }
  }

  // Post-process: apply per-list-block indent overrides from custom properties.
  // A list block is a maximal sequence of consecutive 'para' items with listMeta.
  if (storedListIndentOverrides) {
    let listBlockIdx = 0;
    let inList = false;
    // The type of the block's last top-level item: a new block starts where
    // a top-level item changes type, as Markdown starts a new list, or where
    // Word starts the numbering over
    let topType: 'bullet' | 'ordered' | undefined;
    for (const item of docContent) {
      if (item.type === 'para' && item.listMeta) {
        if (item.listMeta.level === 0) {
          if (inList && (item.listMeta.type !== topType || item.listMeta.wordStarts)) inList = false;
          topType = item.listMeta.type;
        }
        if (!inList) {
          item.listBlockStart = true;
          // Start of a new list block
          const override = storedListIndentOverrides.get(listBlockIdx);
          if (override) item.indentOverride = override as 'indent' | 'no-indent';
          inList = true;
          listBlockIdx++;
        }
        // Propagate the override from the first list item to all items in this block
        if (item.indentOverride === undefined) {
          // Look back to find the override from the first item of this block
          // (already set above for the first item)
        }
      } else if (item.type === 'para' ? !item.listContinuation : isStructuralBoundaryItem(item)) {
        inList = false;
        topType = undefined;
      }
    }
    // Second pass: propagate override to all items in each list block
    inList = false;
    let currentOverride: 'indent' | 'no-indent' | undefined;
    for (const item of docContent) {
      if (item.type === 'para' && item.listMeta) {
        if (!inList || item.listBlockStart) {
          currentOverride = item.indentOverride;
          inList = true;
        } else if (currentOverride) {
          item.indentOverride = currentOverride;
        }
      } else if (item.type === 'para' ? !item.listContinuation : isStructuralBoundaryItem(item)) {
        inList = false;
        currentOverride = undefined;
      }
    }
  }

  // Post-process: inject custom_style_open/custom_style_close sentinels around
  // runs of paragraphs that share a customStyleName.
  {
    let activeStyle: string | undefined;
    for (let i = 0; i < docContent.length; i++) {
      const item = docContent[i];
      // Only structural items (para, table, landscape/portrait sentinels,
      // bibliography_marker) should trigger style transitions. Inline items
      // (text, image, math, hardbreak, etc.) live inside a para and don't
      // carry customStyleName — skip them to avoid premature style close.
      const isStructural = item.type === 'para' || item.type === 'table'
        || item.type === 'landscape_open' || item.type === 'landscape_close'
        || item.type === 'portrait_open' || item.type === 'portrait_close'
        || item.type === 'bibliography_marker';
      if (!isStructural) continue;
      const styleName = (item.type === 'para' && item.customStyleName) ? item.customStyleName : undefined;
      // A tracked mark before a paragraph a style block starts or ends at is
      // the break that ends the paragraph before it, which the block keeps
      // from joining the text after (see joinTrackedParagraphBreaks): it
      // stays before the sentinels, on an empty paragraph, or on the one it
      // is on where that holds nothing else, which then doesn't end the style
      if (item.type === 'para' && item.breakRevision && (styleName ? styleName !== activeStyle : activeStyle)) {
        const { breakRevision, ...para } = item;
        if (Object.keys(para).length === 1 && !paragraphHasContent(docContent, i)) continue;
        docContent.splice(i, 1, { type: 'para', breakRevision }, para);
        i++;
      }
      if (styleName && styleName !== activeStyle) {
        // Close previous style if open
        if (activeStyle) {
          docContent.splice(i, 0, { type: 'custom_style_close' });
          i++; // skip past the close we just inserted
        }
        // Open new style
        docContent.splice(i, 0, { type: 'custom_style_open', styleName });
        i++; // skip past the open we just inserted
        activeStyle = styleName;
      } else if (!styleName && activeStyle) {
        // Style run ended
        docContent.splice(i, 0, { type: 'custom_style_close' });
        i++; // skip past the close we just inserted
        activeStyle = undefined;
      }
    }
    // Close any still-open style at end of document
    if (activeStyle) {
      docContent.push({ type: 'custom_style_close' });
    }
  }

  // Build unified notes map with renumbered labels
  const notesMap = new Map<string, { label: string; body: ContentItem[]; noteKind: 'footnote' | 'endnote' }>();
  let noteCounter = 1;

  const assignedLabels = new Map<string, string>(); // "kind:noteId" -> label
  const usedLabels = new Set<string>();
  for (const ref of refOrder) {
    const key = ref.noteKind + ':' + ref.noteId;
    if (assignedLabels.has(key)) continue;
    const source = ref.noteKind === 'footnote' ? footnotes : endnotes;
    const body = source.get(ref.noteId);
    if (!body) continue;
    const mappedLabel = footnoteIdMapping?.get(ref.noteId);
    let label: string;
    if (mappedLabel) {
      if (usedLabels.has(mappedLabel)) {
        while (usedLabels.has(String(noteCounter))) noteCounter++;
        label = String(noteCounter++);
      } else {
        label = mappedLabel;
      }
    } else {
      while (usedLabels.has(String(noteCounter))) noteCounter++;
      label = String(noteCounter++);
    }
    usedLabels.add(label);
    assignedLabels.set(key, label);
    notesMap.set(key, { label, body: body.content, noteKind: ref.noteKind });
  }

  // Detect which note kind is used for the frontmatter notes field.
  // Default (undefined) means footnotes. Only set 'endnotes' when endnotes are
  // present and footnotes are not — mixed documents omit the notes field.
  let detectedNotesMode: NotesMode | undefined;
  if (endnotes.size > 0 && footnotes.size === 0) {
    detectedNotesMode = 'endnotes';
  }

  // Extract consecutive Title-styled paragraphs from the beginning of the document
  const titleLines = extractTitleLines(docContent);

  let markdown = buildMarkdown(docContent, comments, {
    tableIndent: options?.tableIndent,
    // Comment dates in the offset the frontmatter will declare, which export reads them in
    timezone: storedSettings?.timezone,
    // Whether a line end is a line break, as in what the HTML around a
    // table is written as
    breaks: storedSettings?.breaks,
    // The keys export can cite, from the document's citations and the
    // bibliography it would read, which may be in Word's text of a citation
    // export couldn't write, as a deleted one
    citationKeys: new Set([
      ...keyMap.values(),
      ...storedBibData ? parseBibtex(storedBibData).keys() : [],
      ...options?.existingBibtex ? parseBibtex(options.existingBibtex).keys() : [],
    ]),
    alwaysUseCommentIds: options?.alwaysUseCommentIds,
    pipeTableMaxLineWidth: resolvedPipeTableMaxLineWidth,
    gridTableMaxLineWidth: resolvedGridTableMaxLineWidth,
    commentIdMapping,
    notes: notesMap.size > 0 ? { map: notesMap, assignedLabels } : undefined,
    codeBlockLangs: codeBlockLangMapping,
    blockquoteGaps: blockquoteGapMapping ?? derivedBlockquoteGaps,
    blockquotePreContentBlankLines: blockquotePreContentBlankLineMapping ?? derivedBlockquotePreContentBlankLines,
    blockquotePostContentBlankLines: blockquotePostContentBlankLineMapping ?? derivedBlockquotePostContentBlankLines,
    blockquoteAlertInlineByGroup: blockquoteAlertStyleMapping,
    calloutLabels: storedCalloutLabels,
    imageFormatMapping,
    noteImageFormatMapping,
    tableFormatMapping,
    pipeTableAlignedMapping,
    gridSourceColWidthsMapping,
    tableFontSizeMapping,
    tableFontMapping,
    tableColWidthsMapping,
    tableDigitsMapping,
    tableDecimalMarkMapping,
    tableDigitGroupingMapping,
    tableHtmlAroundMapping,
    tableIdentities,
    landscapeTableIndices: landscapeTableMapping,
    portraitTableIndices: portraitTableMapping,
    embedDirectiveMapping,
    listIndent: storedListIndent ?? 'spaces',
    htmlCommentGaps: htmlCommentGapMapping,
    htmlCommentAfterGaps: htmlCommentAfterGapMapping,
    sentinelGaps: sentinelGapMapping,
  });

  // Strip Sources section if present (fallback for docs without ZOTERO_BIBL field codes):
  // from a line not indented, as in a note, or in an HTML block, as the
  // HTML around a table is
  if (!zoteroBiblData) {
    const lines = markdown.split('\n');
    let inHtml: Set<number> | undefined;
    const sourcesIdx = lines.findIndex((l, k) => SOURCES_HEADING_RE.test(l) && !(inHtml ??= new Set(htmlBlocksIn(markdown)
      .flatMap(block => Array.from({ length: block.end - block.start }, (_, n) => block.start + n)))).has(k));
    if (sourcesIdx >= 0) {
      markdown = lines.slice(0, sourcesIdx).join('\n');
    }
  }

  // Prepend YAML frontmatter if title or Zotero prefs were found
  const fm: Frontmatter = {};
  if (titleLines.length > 0) {
    fm.title = titleLines;
  }
  if (author) {
    fm.author = author;
  }
  if (zoteroPrefs) {
    // Not the style export chose for frontmatter without one, unless Zotero's
    // preferences in Word have another
    const csl = zoteroStyleShortName(zoteroPrefs.styleId);
    if (csl !== storedDefaultCsl) fm.csl = csl;
    // Only emit locale when it differs from the default (en-US)
    if (zoteroPrefs.locale && zoteroPrefs.locale !== 'en-US') {
      fm.locale = zoteroPrefs.locale;
    }
    fm.zoteroNotes = zoteroPrefs.noteType !== undefined ? noteTypeFromNumber(zoteroPrefs.noteType) : undefined;
  }
  if (detectedNotesMode === 'endnotes') {
    fm.notes = 'endnotes';
  }
  if (storedBibliographyPath) {
    fm.bibliography = storedBibliographyPath;
  } else if (options?.preferredBibliographyPath) {
    fm.bibliography = options.preferredBibliographyPath;
  }
  // Note: timezone comes only from the stored settings, to avoid injecting
  // fields that weren't in the original. Without one, import writes comment
  // dates in the system timezone, and normalizeToUtcIso reads them back in it.
  // Extract heading/title font overrides from styles.xml for round-trip
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    const stylesStr = await stylesFile.async('string');
    const fontFields = extractFontOverridesFromStyles(stylesStr, { explicitTableFontSize, builtInIds: styleLayouts.builtInIds });
    Object.assign(fm, fontFields);
  }
  // Restore custom styles from custom property (primary source)
  if (storedCustomStyles) {
    fm.styles = storedCustomStyles;
  }
  if (codeBlockStyling) {
    const bg = codeBlockStyling.get('bg');
    if (bg) fm.codeBackgroundColor = bg;
    const fc = codeBlockStyling.get('fc');
    if (fc) fm.codeFontColor = fc;
    const insetStr = codeBlockStyling.get('inset');
    if (insetStr) { const n = parseInt(insetStr, 10); if (n > 0) fm.codeBlockInset = n; }
  }
  // Emit pipe-table-max-line-width when the resolved value differs from the
  // default, OR when the DOCX explicitly stored a value (even if it equals 120)
  // so that an intentional `pipe-table-max-line-width: 120` survives round-trip.
  if (resolvedPipeTableMaxLineWidth !== 120 || storedPipeTableMaxLineWidth != null || validWidth(options?.pipeTableMaxLineWidth) != null) {
    fm.pipeTableMaxLineWidth = resolvedPipeTableMaxLineWidth;
  }
  if (resolvedGridTableMaxLineWidth !== 120 || storedGridTableMaxLineWidth != null || validWidth(options?.gridTableMaxLineWidth) != null) {
    fm.gridTableMaxLineWidth = resolvedGridTableMaxLineWidth;
  }
  // Reconstruct table-col-widths from stored default custom property
  if (defaultTableColWidths) {
    const parsed = parseColWidths(defaultTableColWidths);
    if (parsed) fm.tableColWidths = parsed;
  }
  if (defaultTableDigits) {
    const parsed = parseTableDigits(defaultTableDigits);
    if (parsed !== undefined) fm.tableDigits = parsed;
  }
  if (defaultTableDecimalMark) {
    const parsed = parseTableDecimalMark(defaultTableDecimalMark);
    if (parsed) fm.tableDecimalMark = parsed;
  }
  if (defaultTableDigitGrouping) {
    const parsed = parseTableDigitGrouping(defaultTableDigitGrouping);
    if (parsed) fm.tableDigitGrouping = parsed;
  }
  // Reconstruct table-borders from stored custom property
  if (storedTableBorders) {
    fm.tableBorders = storedTableBorders;
  }
  // Reconstruct line-spacing, paragraph-indent, bibliography-hanging-indent.
  // Normalize to lowercase before comparing so values like 'Double' or 'NONE'
  // stored in docProps/custom.xml survive the round-trip (frontmatter.ts already
  // lowercases on the write path, but external tools might uppercase).
  if (storedLineSpacing) {
    const ls = storedLineSpacing.toLowerCase();
    const n = parseFloat(ls);
    if (ls === 'single' || ls === '1.5' || ls === 'double') {
      fm.lineSpacing = ls as 'single' | '1.5' | 'double';
    } else if (isFinite(n) && n > 0) {
      fm.lineSpacing = n;
    }
  }
  if (storedParagraphIndent) {
    const pi = storedParagraphIndent.toLowerCase();
    if (pi === 'none') {
      fm.paragraphIndent = 'none';
    } else {
      const n = parseFloat(pi);
      if (isFinite(n) && n >= 0) fm.paragraphIndent = n;
    }
  }
  if (storedBibHangingIndent) {
    const bhi = storedBibHangingIndent.toLowerCase();
    if (bhi === 'true') fm.bibliographyHangingIndent = true;
    else if (bhi === 'false') fm.bibliographyHangingIndent = false;
  }
  if (storedCalloutLabels !== null) {
    fm.calloutLabels = storedCalloutLabels;
  }
  if (storedSettings) {
    // Where the document shows a setting, it wins: Zotero's preferences, and
    // the kind of notes it has. Where Zotero's agree with the stored one, it
    // stays as written, as en-US or in-text, Zotero's defaults, which import
    // otherwise leaves out.
    if (!zoteroPrefs || storedSettings.locale === (zoteroPrefs.locale ?? 'en-US')) fm.locale = storedSettings.locale ?? fm.locale;
    if (!zoteroPrefs || storedSettings.zoteroNotes && noteTypeToNumber(storedSettings.zoteroNotes) === (zoteroPrefs.noteType ?? 0)) {
      fm.zoteroNotes = storedSettings.zoteroNotes ?? fm.zoteroNotes;
    }
    if (storedSettings.notes === 'endnotes' ? footnotes.size === 0 : endnotes.size === 0) fm.notes ??= storedSettings.notes;
    fm.timezone ??= storedSettings.timezone;
    fm.blockquoteStyle ??= storedSettings.blockquoteStyle;
    fm.colors ??= storedSettings.colors;
    fm.breaks ??= storedSettings.breaks;
  }
  // Without a stored setting, as in a document from Word, the style its
  // quotes are in, which export would otherwise write as GitHub's
  fm.blockquoteStyle ??= inferredBlockquoteStyle(docContent);
  const frontmatterStr = serializeFrontmatter(fm, storedFieldOrder ?? undefined);
  if (frontmatterStr) {
    // Restore the original number of blank lines after frontmatter.
    // Default to 1 blank line (conventional) when no stored value exists.
    const blankLines = storedFrontmatterBlankLines ?? 1;
    markdown = frontmatterStr + '\n'.repeat(blankLines) + markdown;
  } else if (FRONTMATTER_OPENING_RE.test(markdown)) {
    // A rule that starts the document, with a block right after it, would
    // open frontmatter that the next rule closes; a blank line keeps it a rule
    markdown = markdown.replace(/^---[ \t]*\n/, line => line + '\n');
  }

  // Layered .bib restoration:
  // Layer 1: full .bib stored in custom properties (survives Word editing)
  // Layer 2: key order in custom properties — regenerate with original order
  // Layer 3: regenerate from Zotero citations (backward compatible)
  let bibtex: string;
  if (storedBibData) {
    // Layer 1: stored .bib is authoritative — preserve verbatim.
    // Only append genuinely new Zotero entries (citations added in Word).
    const storedKeys = new Set(parseBibtex(storedBibData).keys());
    const generated = generateBibTeX(allCitations, keyMap);
    // Let the parser delimit the entries.  Splitting on blank lines would cut
    // an entry in half the moment a field value contains one — `abstract` and
    // `note` come through from Zotero verbatim and routinely do — and the
    // half without the header would then be dropped as keyless, appending
    // truncated BibTeX to the file.
    const newEntries = parseBibtexWithRaw(generated)
      .ranges.filter(range => !storedKeys.has(range.key))
      .map(range => generated.slice(range.start, range.end));
    bibtex = newEntries.length > 0
      ? storedBibData.trimEnd() + '\n\n' + newEntries.join('\n\n')
      : storedBibData;
  } else if (bibKeyOrder) {
    // Layer 2: regenerate but sort to match original key order
    bibtex = generateBibTeX(allCitations, keyMap, bibKeyOrder);
  } else {
    // Layer 3: backward compatible — generate from Zotero citations
    bibtex = generateBibTeX(allCitations, keyMap);
  }

  // Post-processing: merge with on-disk .bib — preserves all existing entries/fields.
  // Length check is a fast-path skip; mergeBibtex handles whitespace-only gracefully.
  if (options?.existingBibtex && options.existingBibtex.length > 0) {
    bibtex = mergeBibtex(options.existingBibtex, bibtex);
  }

  // Extract image binaries from the ZIP
  let images: Map<string, Uint8Array> | undefined;
  if (imageFiles.entries.length > 0) {
    images = new Map();
    for (const entry of imageFiles.entries) {
      const mediaPath = mediaZipPath(entry.mediaPath);
      const file = zip.file(mediaPath);
      if (file) {
        images.set(entry.outputFilename, await file.async('uint8array'));
      }
    }
    if (images.size === 0) images = undefined;
  }

  // Ensure the output ends with exactly one newline (POSIX convention)
  markdown = markdown.replace(/\n*$/, '\n');

  return { markdown, bibtex, zoteroPrefs, zoteroBiblData, images };
}
