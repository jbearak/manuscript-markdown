// Markdown as export reads it: the markdown-it parsers and rules it reads
// with, the preprocessing before them, and the tokens of blocks and runs,
// MdToken and MdRun, that md-to-docx.ts writes WordprocessingML from. What
// the parsers read is decided with the preview, in inline-syntax.ts, so the
// preview shows what export writes. Split out of md-to-docx.ts.
import { type ContainerOptions, DISPLAY_MATH_ENVIRONMENTS, wrapBareLatexEnvironments } from './latex-env-preprocess';
import { type CriticMathPart, splitCriticMarkupInMath } from './critic-math';
import { type CrossRefSource, citationEnd, citationPrefixText, readCitationItems } from './citation-syntax';
import { DOCX_DOLLAR_MATH_OPTIONS, findDollarMathAt } from './math-delimiters';
import { type FigureAttributes, attributeValue, tableCaptionSource } from './captions';
import { GRID_TABLE_PLACEHOLDER_PREFIX, type GridTableData, type TableAlign, getDisplayWidth, gridColumnAlign } from './grid-table-preprocess';
import { type GfmAlertType, isGfmDisallowedRawHtml, parseGfmAlertMarker, parseTaskListMarker } from './gfm';
import { type HtmlTableRow, type HtmlTableRun, cellParagraphMarkAt, extractHtmlTables } from './html-table-parser';
import { LINE_PLACEHOLDER, PARA_PLACEHOLDER, criticBreaksEndLinks, criticBreaksInRawHtml, criticBreaksLeftOver, criticCloserSearch, findMatchingClose, matchCriticHeadingPrefix, preprocessCriticMarkup, preprocessCriticMarkupWithLines, restoreCriticLineBreaks } from './critic-markup';
import { type LineMap, throughLines, withEnd } from './line-map';
import MarkdownIt from 'markdown-it';
import StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { type TableDecimalMark, type TableDigitGrouping, type TableDigits, parseTableDecimalMark, parseTableDigitGrouping, parseTableDigits } from './table-number-format';
import Token from 'markdown-it/lib/token.mjs';
import { citationSpanAt, criticSpanAt, crossRefSpanAt, formatHighlightAt } from './inline-syntax';
import { codeSpansOfSpaces } from './code-spans';
import { commentsEnd, htmlBlockKind, listItemHtmlBlock } from './html-blocks';
import { countsForIndent, isCommentsWithIds } from './md-to-docx-custom-props';
import { decodeHtmlAttribute } from './html-entities';
import { holdsLatexComment, trackedEquationLatex } from './md-to-docx-citations';
import { holdsRawHtmlLineEnd } from './md-to-docx-styles';
import { imageAltMarkdown } from './converter';
import { imagePathsWithSpaces } from './image-paths';
import { linearInlineComments } from './inline-html-comments';
import { normalizeNewlines } from './newlines';
import { parseColWidths } from './frontmatter';
import { parseImageDimension } from './image-utils';
import { preprocessBlocks } from './block-preprocess';
import { pushAll } from './arrays';
import { scanOrientationDirectives } from './orientation-scan';
import { styleFence } from './style-fence';
import { withoutNonXmlCharacters } from './xml-parser';

// --- Orientation sentinel regexes (hoisted for cache-friendliness in the token loop) ---
const ORIENTATION_OPEN_RE = /^<!--\s*(landscape|portrait)\s*-->$/i;
const ORIENTATION_CLOSE_RE = /^<!--\s*\/(landscape|portrait)\s*-->$/i;
// The other directives a comment alone in a paragraph is (see directiveRest)
const TABLE_FONT_SIZE_RE = /^<!--\s*table-font-size:\s*(\d+(?:\.\d+)?)\s*-->$/;
const TABLE_FONT_RE = /^<!--\s*table-font:\s*(.+?)\s*-->$/;
const TABLE_ORIENTATION_RE = /^<!--\s*table-orientation:\s*(landscape|portrait)\s*-->$/i;
const TABLE_COL_WIDTHS_RE = /^<!--\s*table-col-widths:\s*(.+?)\s*-->$/;
const TABLE_NUMBER_FORMAT_RE = /^<!--\s*table-(digits|decimal-mark|digit-grouping):\s*(.+?)\s*-->$/i;
const REFERENCES_RE = /^<!--\s*(?:references|bibliography)\s*-->$/i;
const INDENT_RE = /^<!--\s*(no-indent|indent)\s*-->$/i;
const IMAGE_DIMENSION_ATTR_RE = '(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(px|in|cm|mm|pt|pc)?';
// Types for the parsed token stream
export type TableFormat = 'pipe' | 'html' | 'grid';

export interface ListContinuation {
  type: 'bullet' | 'ordered';
  level: number; // 1-based parent list nesting level
  markerWidth?: number; // ordered-list marker width (e.g. "10. " => 4)
}

export interface MdToken {
  type: 'paragraph' | 'heading' | 'list_item' | 'blockquote' | 'code_block' | 'table' | 'hr';
  level?: number;           // heading level 1-6, blockquote nesting, list nesting
  ordered?: boolean;        // for list items
  bulletMarker?: '-' | '*' | '+'; // authored unordered-list marker for round-trip
  listContinuation?: ListContinuation; // parent list context for continuation paragraphs/blocks
  sourceRange?: [number, number]; // lines [start, end) of the text parseMd parses that the token came from
  splitPart?: true;         // one of the blocks parseMd split a block of the Markdown into, which share its lines (see criticBlockSegment)
  droppedRange?: [number, number]; // lines of the blocks next to it its quote dropped (see blockquote_open)
  itemDropped?: Array<[number, number]>; // for list items: the lines of each block the item dropped (see extractListItems)
  blockquoteSpacing?: BlockquoteSpacing; // on a quote group's first token (see annotateBlockquoteSpacing)
  startNumber?: number;     // for ordered lists: first item's start number (when ≠ 1)
  listStart?: boolean;      // for list items: the first item of its list
  blankLineBefore?: boolean; // for list items: a blank line before the item's marker in the source (see listBlankLineProps)
  taskChecked?: boolean;    // for GFM task list items
  alertType?: GfmAlertType; // for GFM alerts in blockquotes
  alertLead?: boolean;      // first blockquote paragraph carrying alert header
  alertHasBodyParagraph?: boolean; // another same-level alert paragraph carries block content
  blankAlertLead?: true;    // alert lead of spaces or tabs alone that import drops (see annotateBlankAlertLeads)
  alertFirst?: boolean;     // first paragraph in an alert block (for spacing)
  alertLast?: boolean;      // last paragraph in an alert block (for spacing)
  blockquoteGroupIndex?: number; // sequential index of the blockquote group this token belongs to
  quoteStart?: boolean;     // for quote paragraphs: the first of its quote at its level, which starts a group (see annotateBlockquoteBoundaries)
  trailingBlankLine?: boolean;   // for code blocks: blank line follows in source markdown
  blankLinesBefore?: number;     // for HTML comments: blank lines before this token in source
  blankLinesAfter?: number;      // for HTML comments: blank lines after this token in source
  htmlCommentIndex?: number;     // sequential index of HTML comment paragraphs
  runs: MdRun[];            // inline content
  rows?: MdTableRow[];      // for tables
  language?: string;        // for code blocks
  sourceFormat?: TableFormat; // original table format for round-trip
  pipeAligned?: boolean;      // pipe table was column-aligned (padded) in source
  tableFontSize?: number;   // per-table font size override (pt)
  tableFont?: string;       // per-table font name override
  landscapeOpen?: true;     // sentinel: start of landscape section
  landscapeClose?: true;    // sentinel: end of landscape section
  portraitOpen?: true;      // sentinel: start of portrait section
  portraitClose?: true;     // sentinel: end of portrait section
  tableOrientation?: 'landscape' | 'portrait'; // table-only orientation from data-orientation
  tableColWidths?: number[] | 'equal' | 'auto'; // per-table column width ratios
  tableDigits?: TableDigits;
  tableDecimalMark?: TableDecimalMark;
  tableDigitGrouping?: TableDigitGrouping;
  tableHtmlAround?: [string, string]; // the HTML before and after an HTML table in its block, which Word doesn't show, and the line end or spaces before the next table in it
  gridSourceColWidths?: number[]; // column char-widths inferred from +---+---+ source; persisted for round-trip fidelity and Word Online layout
  criticParaMark?: 'addition' | 'deletion'; // paragraph mark revision: a heading promoted from a full-paragraph {++### ...++} / {--### ...--} span, or a block split at a paragraph break inside a revision
  criticParaMarkRun?: MdRun; // the revision whose paragraph break ends this block; supplies author and date (default: the first run)
  bibliographyMarker?: true;  // sentinel: <!-- references --> / <!-- bibliography --> placement marker
  customStyleOpen?: string;   // sentinel: start of custom style block (style name)
  customStyleClose?: true;    // sentinel: end of custom style block
  itemCustomStyle?: string;   // a paragraph in a list item in a style block in that item (see extractListItems)
  itemStyleOpen?: string;     // a style block opens in a list item here, which closes one open at the top level (see applyCustomStyleSentinels)
  closesItemStyle?: string;   // the style of a block open in the item where itemStyleOpen's opens, which it closes
  itemFence?: string;         // the text of a style block's fence in a list item here, which has no comment's token; with no itemStyleOpen, a closing one, which applyCustomStyleSentinels drops
  closesImplicitly?: true;    // sentinel: end of a custom style block where one opens in a list item, with no fence of its own
  indentOverride?: 'indent' | 'no-indent'; // per-paragraph indent override from <!-- indent --> / <!-- no-indent -->
  listDirective?: 'indent' | 'no-indent'; // a list item right after a directive that comes right after an item, which ends that item's list (see listItemIndentOverrideProps)
  embedIdx?: number;          // index into embed directives array, for round-trip recovery
  captionOfTable?: TableCaption; // a paragraph at the top level that reads as a table's caption, as `: Caption {#tbl-x}`, which the table right before it takes (see attachTableCaptions)
  tableCaption?: TableCaption; // a table's caption, which Word gets above or below it (see captionXml)
}

/** A table's caption, as a paragraph after it writes one (see tableCaptionOf) */
export interface TableCaption {
  label: string;
  runs: MdRun[];
}

export interface MdTableCell {
  runs: MdRun[];
  colspan?: number;
  rowspan?: number;
  align?: TableAlign;
}
export interface MdTableRow {
  cells: MdTableCell[];     // each cell has runs + optional span info
  header: boolean;
}

export interface MdRun {
  criticParagraphBreak?: true; // first of two softbreaks representing a blank line inside a Critic payload
  linkStart?: true; // first run of a link, where a hyperlink starts though the run before goes to the same place
  cellParagraphBreak?: true; // hardbreak between two of an HTML table cell's paragraphs, which generateTable splits on
  cellParagraphMark?: 'addition' | 'deletion'; // for a cellParagraphBreak: the revision that tracks the mark of the paragraph it ends (see htmlCellRuns)
  newline?: true; // hardbreak a newline made, in breaks mode or a grid table's cell, which a line of comment bodies drops as a softbreak
  htmlBreak?: true; // hardbreak an HTML <br> made, which ends no line of the source, so no alert's marker starts a line after it
  type: 'text' | 'critic_add' | 'critic_del' | 'critic_sub' | 'critic_highlight' | 'critic_comment' | 'citation' | 'math' | 'softbreak' | 'hardbreak' | 'comment_range_start' | 'comment_range_end' | 'comment_body_with_id' | 'footnote_ref' | 'html_comment' | 'image';
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  highlight?: boolean;
  highlightColor?: string;  // for ==text=={color}
  superscript?: boolean;
  subscript?: boolean;
  code?: boolean;           // inline code
  href?: string;            // hyperlink URL
  escapedBracket?: true;    // text that starts with \[, whose [ is text and not a task's box or an alert's marker
  taskBoxLength?: number;   // of the task's box that starts the text and the whitespace after it the source holds as it is (see task_box_whitespace)
  alertMarkerLength?: number; // of the alert's marker that starts the text and the whitespace after it the source holds as it is (see alert_marker_whitespace)
  rawHtml?: true;           // raw HTML Markdown keeps as it is, an HTML block or tag, whose line ends export writes as Word's line breaks (see RAW_HTML_STYLE_ID)
  // CriticMarkup specific
  newText?: string;         // for substitutions: {~~old~>new~~}
  innerRuns?: MdRun[];      // parsed inner formatting for critic_add/del/highlight
  oldRuns?: MdRun[];        // parsed old-side formatting for critic_sub
  newRuns?: MdRun[];        // parsed new-side formatting for critic_sub
  mathParts?: CriticMathPart[]; // inline equation with CriticMarkup inside; text holds every part's LaTeX
  author?: string;          // for comments/revisions
  date?: string;            // for comments/revisions
  commentText?: string;     // for critic_comment: the comment body
  commentId?: string;       // for comment_range_start/end/body_with_id
  innerRangeMarker?: true;  // for comment_range_start/end: inside the one range Word gets for its ID's ranges (see prescanCommentIds)
  unwrittenRangeMarker?: true; // for comment_range_start/end: of no range Word gets, as one of an ID with no body, which writes nothing (see prescanCommentIds)
  reservedCommentId?: number; // for critic_highlight: its comment's ID, if prescanCommentIds gave it one
  footnoteLabel?: string;   // for footnote_ref: the [^label] label
  replies?: Array<{author?: string; date?: string; text: string; parentReply?: number}>; // nested replies for comment_body_with_id; parentReply: the index of the reply this one replies to
  consecutiveReplies?: true; // comment_body_with_id: its replies follow it, as in {#1>>a<<}{>>b<<}
  // Citation specific
  keys?: string[];          // citation keys for [@key1; @key2]
  locators?: Map<string, string>; // key -> locator for [@key, p. 20]
  suppressAuthorKeys?: Set<string>; // per-key suppress-author: Set of keys with [-@key] form
  prefixes?: string[];      // Pandoc prefix per item for [e.g., @key], aligned with keys ('' = none)
  // Cross-reference specific: text of a cross-reference's Markdown, as @fig-map, which a caption's REF field shows (see crossRefXml)
  crossRef?: { key: string; form: CrossRefSource['form'] };
  // Math specific
  display?: boolean;        // display math ($$...$$) vs inline ($...$)
  // Image specific
  imageSrc?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageSyntax?: 'md' | 'html';
  imageSource?: string;     // the image as written, which export hides in the text when it can't embed the image
  linkRId?: string;         // for an image in a link: the relationship of the link, which its drawing clicks to too, as Word writes a linked picture
  figure?: {                // for an image with a figure's label after it, as ![Caption](map.png){#fig-map} (see captions.ts)
    attributes: FigureAttributes;
    captionRuns: MdRun[];   // its text, which is the caption of a figure the image is alone in its paragraph
  };
}

/** An image's Markdown: as written, or for a reference, inline, with its
 *  destination as markdown-it encoded it, and its alt text as import
 *  writes Word's, which reads back as it; and its attributes, `attrs`, as
 *  written (see writtenImageAttributes) */
function imageMarkdownSource(token: ManuscriptToken, alt: string, attrs: string | undefined): string {
  const src = token.attrGet?.('src') || '';
  const title = token.attrGet?.('title');
  // With the line breaks of CriticMarkup in it, which the source slice
  // has as the placeholders preprocessCriticMarkup wrote
  const source: string = token.meta?.source !== undefined ? restoreCriticLineBreaks(token.meta.source) : '![' + imageAltMarkdown(alt) + ']('
    + (/[\s()<>]/.test(src) ? '<' + src + '>' : src)
    + (title ? ' "' + title.replace(/["\\]/g, c => '\\' + c) + '"' : '') + ')';
  return source + (attrs !== undefined ? '{' + attrs + '}' : '');
}

/**
 * The attributes after an image, `matched`, as {width=100 height=100}
 * reads, inside its braces, as the source writes them, from the pieces of
 * the text after the image (see image_text_source): a reference as
 * written, as &#10;, which markdown-it reads as a line end, so that they
 * read back as the image's. Undefined where the pieces don't read as
 * `matched`, or where a reference or an escape spans a brace's edge.
 */
function writtenImageAttributes(pieces: Array<[string, string]> | undefined, matched: string): string | undefined {
  if (!pieces || !pieces.map(([read]) => read).join('').startsWith(matched)) return undefined;
  const from = 1, to = matched.length - 1;
  let written = '';
  let at = 0;
  for (const [read, source] of pieces) {
    const start = at;
    at += read.length;
    if (at <= from) continue;
    if (start >= to) break;
    // Text as it reads, or a reference or an escape wholly inside the braces
    if (read === source) written += source.slice(Math.max(from - start, 0), Math.min(to, at) - start);
    else if (start >= from && at <= to) written += source;
    else return undefined;
  }
  return written;
}

function mapHtmlTableRunToMdRun(run: HtmlTableRun): MdRun {
  if (run.type === 'paragraph') {
    return { type: 'hardbreak', text: '\n', cellParagraphBreak: true };
  }
  if (run.type === 'html_comment') {
    return { type: 'html_comment', text: run.text };
  }
  return {
    // A line break in the formatting around it, as text
    ...(run.type === 'softbreak' ? { type: 'hardbreak' as const, text: '\n' } : { type: 'text' as const, text: run.text }),
    ...(run.bold ? { bold: true } : {}),
    ...(run.italic ? { italic: true } : {}),
    ...(run.underline ? { underline: true } : {}),
    ...(run.strikethrough ? { strikethrough: true } : {}),
    ...(run.code ? { code: true } : {}),
    ...(run.superscript ? { superscript: true } : {}),
    ...(run.subscript ? { subscript: true } : {}),
    ...(run.href ? { href: run.href } : {}),
    ...(run.linkStart ? { linkStart: true } : {}),
  };
}

/**
 * An HTML cell's runs, with each break between its paragraphs that a span
 * of CriticMarkup holds alone, its opener ending the paragraph's text and
 * its closer starting the next's, as import writes a tracked paragraph mark
 * in a cell, `<p>a{++</p><p>++}b</p>`, as a break whose paragraph's mark the
 * span's kind tracks, where the HTML writes them as they are. Other
 * CriticMarkup in a cell is text, and so are delimiters with a character
 * reference in them, as `&#123;++`, which import writes for text.
 */
function htmlCellRuns(runs: HtmlTableRun[]): MdRun[] {
  const mapped = runs.map(mapHtmlTableRunToMdRun);
  // The text the span's delimiters were all of
  const emptied = new Set<MdRun>();
  for (let i = 1; i + 1 < mapped.length; i++) {
    const mark = cellParagraphMarkAt(runs, i);
    if (!mark) continue;
    mapped[i - 1] = { ...mapped[i - 1], text: mapped[i - 1].text.slice(0, -mark.opener.length) };
    mapped[i + 1] = { ...mapped[i + 1], text: mapped[i + 1].text.slice(mark.closer.length) };
    mapped[i] = { ...mapped[i], cellParagraphMark: mark.type };
    for (const run of [mapped[i - 1], mapped[i + 1]]) if (run.text === '') emptied.add(run);
  }
  return mapped.filter(run => !emptied.has(run));
}

function mapHtmlTableRowsToMdTableRows(rows: HtmlTableRow[]): MdTableRow[] {
  return rows.map(row => ({
    header: row.header,
    cells: row.cells.map(cell => ({
      runs: htmlCellRuns(cell.runs),
      ...(cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {}),
      ...(cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
      ...(cell.align ? { align: cell.align } : {}),
    })),
  }));
}

// Custom inline rules

type CriticTokenType = 'critic_add' | 'critic_del' | 'critic_sub' | 'critic_highlight' | 'critic_comment';

interface ManuscriptToken extends Token {
  criticType?: CriticTokenType;
  oldText?: string;
  newText?: string;
  author?: string;
  date?: string;
  commentText?: string;
  replies?: Array<{ author?: string; date?: string; text: string }>;
  commentId?: string;
  color?: string;
  keys?: string[];
  locators?: Map<string, string>;
  suppressAuthorKeys?: Set<string>;
  prefixes?: string[];
  display?: boolean;
  footnoteLabel?: string;
  criticMathParts?: CriticMathPart[];
  crossRef?: CrossRefSource;
}

function pushManuscriptToken(state: StateInline, type: string, tag: string, nesting: 1 | 0 | -1): ManuscriptToken {
  return state.push(type, tag, nesting) as ManuscriptToken;
}

/** Parse author/date/text from comment content string.
 *
 * Uses `@Author (Date) | text` / `@Author | text` syntax.
 * If content does not start with `@`, the entire string is plain comment text.
 *
 * Whitespace around `(`, `)`, and `|` is flexible: zero or more spaces are
 * accepted so that hand-edited markdown still round-trips correctly.
 */
function parseCommentContent(content: string): { author?: string; date?: string; text: string } {
  if (content.startsWith('@')) {
    // Try @Author (Date) | text  — \s* allows missing/extra whitespace. One
    // space after | is the separator's; more whitespace, or a line's end, is
    // the text's, whose first paragraph can be empty
    const match = content.match(/^@(.+?)\s*\(([^)]+)\)\s*\| ?([\s\S]*)$/);
    if (match) {
      const author = match[1].trim();
      const date = match[2].trim();
      if (author) return { author, ...(date ? { date } : {}), text: match[3] };
    }
    // Try @Author | text
    const simpleMatch = content.match(/^@([^|]+?)\s*\| ?([\s\S]*)$/);
    if (simpleMatch) {
      const author = simpleMatch[1].trim();
      if (author) return { author, text: simpleMatch[2] };
    }
  }
  // No @ prefix → entire content is comment text
  if (!content.trim()) return { text: '' };
  return { text: content };
}

/**
 * Extract nested reply blocks from comment content.
 * Splits content into the parent text and an array of reply entries.
 */
function extractReplies(content: string): { parentText: string; replies: Array<{author?: string; date?: string; text: string}> } {
  const replies: Array<{author?: string; date?: string; text: string}> = [];

  // Find the first nested {>> to determine where parent text ends
  const firstReplyIdx = content.indexOf('{>>');
  if (firstReplyIdx === -1) {
    return { parentText: content, replies };
  }

  const parentText = content.slice(0, firstReplyIdx).trimEnd();

  // Extract each {>>...<<} reply block using depth-aware matching
  let pos = firstReplyIdx;
  while (pos < content.length) {
    const openIdx = content.indexOf('{>>', pos);
    if (openIdx === -1) break;
    const innerStart = openIdx + 3;
    const closeIdx = findMatchingClose(content, innerStart);
    if (closeIdx === -1) break;
    const replyContent = content.slice(innerStart, closeIdx);
    const parsed = parseCommentContent(replyContent);
    replies.push(parsed);
    pos = closeIdx + 3;
  }

  return { parentText, replies };
}

/** Parse {#id}, {/id}, and {#id>>...<<} comment range markers (see criticSpanAt) */
function commentRangeRule(state: StateInline, silent: boolean): boolean {
  const span = criticSpanAt(state, state.pos);
  if (!span || span.kind !== 'range_start' && span.kind !== 'range_end' && span.kind !== 'comment') return false;
  // A comment's body with no ID is criticMarkupRule's
  if (span.kind === 'comment' && span.id === undefined) return false;
  if (!silent) {
    if (span.kind === 'comment') {
      const rawContent = restoreCriticLineBreaks(state.src.slice(span.contentStart, span.contentEnd));
      const token = pushManuscriptToken(state, 'comment_body_with_id', '', 0);
      token.commentId = span.id;
      // Check for nested replies
      const { parentText, replies } = extractReplies(rawContent);
      const parsed = parseCommentContent(parentText);
      token.author = parsed.author;
      token.date = parsed.date;
      token.commentText = parsed.text;
      if (replies.length > 0) {
        token.replies = replies;
      }
    } else {
      // A caption's label marks no range (see criticSpanAt): its ID is one
      // no comment's body has, which writes nothing, as a range start of an
      // ID with no body does, and gets a warning
      const token = pushManuscriptToken(state, span.kind === 'range_start' ? 'comment_range_start' : 'comment_range_end', '', 0);
      token.commentId = span.id;
    }
  }
  state.pos = span.end;
  return true;
}

const CRITIC_TOKEN_TYPES = {
  addition: 'critic_add',
  deletion: 'critic_del',
  substitution: 'critic_sub',
  highlight: 'critic_highlight',
  comment: 'critic_comment',
} as const;

function criticMarkupRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const span = criticSpanAt(state, start);
  if (!span || span.kind === 'range_start' || span.kind === 'range_end') return false;
  // A comment's body with an ID is commentRangeRule's
  if (span.kind === 'comment' && span.id !== undefined) return false;

  if (!silent) {
    const type = CRITIC_TOKEN_TYPES[span.kind];
    // Replace any paragraph placeholders back to real newlines
    const content = restoreCriticLineBreaks(state.src.slice(span.contentStart, span.contentEnd));
    const token = pushManuscriptToken(state, 'critic_markup', '', 0);
    token.markup = state.src.slice(start, span.contentStart);
    token.content = content;
    token.criticType = type;

    if (span.kind === 'substitution') {
      const sepPos = content.indexOf('~>');
      if (sepPos !== -1) {
        token.oldText = content.slice(0, sepPos);
        token.newText = content.slice(sepPos + 2);
      }
      // One side alone, as import writes a change whose text has its span's
      // closer, is a change of that side
      if (!token.oldText !== !token.newText) {
        token.criticType = token.oldText ? 'critic_del' : 'critic_add';
        token.markup = token.oldText ? '{--' : '{++';
        token.content = token.oldText || token.newText || '';
      }
    }

    if (span.kind === 'comment') {
      const { parentText, replies } = extractReplies(content);
      const parsed = parseCommentContent(parentText);
      token.author = parsed.author;
      token.date = parsed.date;
      token.commentText = parsed.text;
      if (replies.length > 0) {
        token.replies = replies;
      }
    }
  }

  state.pos = span.end;
  return true;
}

function coloredHighlightRule(state: StateInline, silent: boolean): boolean {
  const span = formatHighlightAt(state, state.pos);
  if (!span) return false;

  if (!silent) {
    // The content is Markdown, as the preview reads it, parsed with the
    // document's parser and link definitions, as md.inline.parse would, but
    // in a link around the highlight, where a URL is the link's text
    const open = pushManuscriptToken(state, 'highlight_open', 'mark', 1);
    open.color = span.color;
    const children: Token[] = [];
    const inner = new state.md.inline.State(state.src.slice(span.contentStart, span.contentEnd), state.md, state.env, children);
    // markdown-it's types leave out linkLevel, which linkify reads
    type LinkState = StateInline & { linkLevel: number };
    (inner as LinkState).linkLevel = (state as LinkState).linkLevel;
    state.md.inline.tokenize(inner);
    for (const rule of state.md.inline.ruler2.getRules('')) rule(inner);
    pushAll(state.tokens, children);
    pushManuscriptToken(state, 'highlight_close', 'mark', -1);
  }
  state.pos = span.end;
  return true;
}

function footnoteRefRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  const src = state.src;

  if (start + 2 >= max || src.charAt(start) !== '[' || src.charAt(start + 1) !== '^') return false;

  // Find closing ]
  let end = start + 2;
  while (end < max && src.charAt(end) !== ']') {
    if (src.charAt(end) === '\n') return false; // no newlines in label
    end++;
  }
  if (end >= max) return false;

  const label = src.slice(start + 2, end);
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) return false;

  // No colon check needed here — start-of-line definitions are already
  // stripped by extractFootnoteDefinitions() before parseMd() is called.

  // In silent mode, where markdown-it scans a link's label, its [ alone, as
  // text's: a token there that starts with a [ and goes on past it reads as
  // a link in the link, which makes the link none, so [a[^1] b](u) was
  // text, though Pandoc reads a link with a note in it. Its ] then closes
  // that [, as its label holds no bracket, so the label ends where it
  // would. The [ is still this rule's, so the link rule reads no link from
  // it there, as of [^1](x), which tokenizing reads as the note and text.
  if (silent) {
    state.pos = start + 1;
    return true;
  }
  const token = pushManuscriptToken(state, 'footnote_ref', '', 0);
  token.footnoteLabel = label;
  // An image's alt text, which joins its tokens' content, keeps it as written
  token.content = src.slice(start, end + 1);
  state.pos = end + 1;
  return true;
}

let citationTextMd: MarkdownIt | undefined;
/** Markdown as export reads it, but with a URL as written, not a link
 *  whose text linkify rewrites, as of a %5D, for a note's key */
let noteKeyMd: MarkdownIt | undefined;

/** The parser export reads Markdown with, made once, for text outside a
 *  document's own parse, as a citation's or a note's */
export function citationTextParser(): MarkdownIt {
  return citationTextMd ??= createMarkdownIt();
}

/** The parser of a note's key (see noteKeyMd), made once */
export function noteKeyParser(): MarkdownIt {
  return noteKeyMd ??= createMarkdownIt().disable('linkify');
}
/** The ] that ends the citation the [ at `start` in Markdown `text` opens,
 *  as export reads one, but without the document's link definitions, or -1 */
export function citationEndInText(text: string, start: number): number {
  citationTextMd ??= createMarkdownIt();
  // One state for the text each search of it in turn reads, whose scans
  // the next search keeps (see opensLinkPast)
  if (citationTextState?.src !== text || citationTextState.md !== citationTextMd) citationTextState = { src: text, md: citationTextMd, env: {} };
  return citationEnd(citationTextState, start);
}
let citationTextState: { src: string; md: MarkdownIt; env: object } | undefined;

/** The ] that ends the label of the image Markdown `markdown` starts with,
 *  at its ![, as export reads one, past brackets it nests and a ] in its
 *  code, or -1 */
export function imageLabelEnd(markdown: string): number {
  const md = citationTextMd ??= createMarkdownIt();
  return md.helpers.parseLinkLabel(new md.inline.State(markdown, md, {}, []), 1, false);
}

// linkify-it searches what's left of a text after each link it finds from
// its start, for a scheme and for an email address, and each search can run
// to the end, so text of many links took time quadratic in its length, as a
// paragraph of email addresses on export, or a highlight's URLs before an
// address on import. No link or address holds a space or a control
// character, linkify's \p{Z} and \p{Cc}, and linkify reads one beside a link
// as it reads the start or end of its text. So text goes to it in pieces of
// about LINKIFY_PIECE characters, each cut before one of those, which find
// the same links. That holds while fuzzyLink is off, as createMarkdownIt
// sets it: its check for a host reads on past the link it finds.
const LINKIFY_PIECE = 256;
let linkifySeparatorRe: RegExp | undefined;
type Linkify = MarkdownIt['linkify'];
type LinkifyMatch = NonNullable<ReturnType<Linkify['match']>>[number];

/** The links `linkify` finds in text, as its own match finds them, from
 *  pieces of it about `pieceLength` long */
function linkifyInPieces(linkify: Linkify, text: string, pieceLength: number): LinkifyMatch[] | null {
  // Its own, which createMarkdownIt puts this in place of
  const matchWhole: Linkify['match'] = Object.getPrototypeOf(linkify).match;
  if (text.length <= pieceLength) return matchWhole.call(linkify, text);
  // The separators linkify's own patterns use, which its typing leaves out
  linkifySeparatorRe ??= new RegExp('(?:' + (linkify.re as unknown as Record<string, string>).src_ZCc + ')', 'g');
  const links: LinkifyMatch[] = [];
  for (let start = 0; start < text.length;) {
    linkifySeparatorRe.lastIndex = start + pieceLength;
    const end = linkifySeparatorRe.exec(text)?.index ?? text.length;
    for (const link of matchWhole.call(linkify, text.slice(start, end)) ?? []) {
      link.index += start;
      link.lastIndex += start;
      links.push(link);
    }
    start = end;
  }
  return links.length > 0 ? links : null;
}

/** The URLs and email addresses linkify finds in text, as export reads it,
 *  from pieces of it about `pieceLength` long */
export function linkifyMatches(text: string, pieceLength = LINKIFY_PIECE): LinkifyMatch[] {
  citationTextMd ??= createMarkdownIt();
  return linkifyInPieces(citationTextMd.linkify, text, pieceLength) ?? [];
}

// Where a URL's host ends at the latest, after the // after its colon: its
// user and host hold no / or space
const AUTHORITY_END_RE = /[\s/]/g;

/** The colons of the URLs with // that markdown-it's own linkify rule links
 *  in Markdown `markdown`, as export reads it, which linkifyMatches can
 *  miss: that rule runs before linkify's search, and reads the scheme from
 *  the text before the colon, which needs no space or punctuation before
 *  it but only no ASCII letter, digit, ., + or -, so it links the URL in
 *  a_https://e.com and éhttps://e.com. A backslash ends that text, and
 *  takes the character after it, a letter too, so x\hhttps://e.com links
 *  https://e.com. */
export function linkifiedColons(markdown: string): number[] {
  citationTextMd ??= createMarkdownIt();
  const colons: number[] = [];
  for (let at = markdown.indexOf('://'); at !== -1; at = markdown.indexOf('://', at + 1)) {
    let start = at;
    while (start > 0 && /[a-z0-9.+-]/i.test(markdown[start - 1])) start--;
    let backslashes = 0;
    while (markdown[start - 1 - backslashes] === '\\') backslashes++;
    if (backslashes % 2 === 1) start++;
    if (!/^[a-z]/i.test(markdown.slice(start, at))) continue;
    // To the end of its host, which settles whether it's linked, not the
    // whole URL, whose path each check would scan again
    AUTHORITY_END_RE.lastIndex = at + 3;
    const end = AUTHORITY_END_RE.exec(markdown)?.index ?? markdown.length;
    const link = citationTextMd.linkify.matchAtStart(markdown.slice(start, end));
    if (link && link.url.length > at - start) colons.push(at);
  }
  return colons;
}

/** The text of the link linkify makes of a URL, or an email address
 *  (`email`), as export reads it: with percent-encoding and punycode
 *  decoded, as https://e.com/a%20b shows https://e.com/a b */
export function linkifiedText(address: string, email: boolean): string {
  citationTextMd ??= createMarkdownIt();
  return email ? citationTextMd.normalizeLinkText('mailto:' + address).replace(/^mailto:/, '') : citationTextMd.normalizeLinkText(address);
}

/** Whether Markdown `text` starts with an HTML block, as export reads one */
export function startsHtmlBlock(text: string): boolean {
  citationTextMd ??= createMarkdownIt();
  return citationTextMd.parse(text, {})[0]?.type === 'html_block';
}

/** Whether Markdown `line`, after a paragraph's line and before `next`,
 *  ends the paragraph as export reads it: starts a block of its own, as a
 *  list's first item, a quote or a code fence, or a table whose delimiter
 *  row `next` is, or makes the paragraph a heading, as its underline */
export function endsParagraph(line: string, next: string): boolean {
  citationTextMd ??= createMarkdownIt();
  const first = citationTextMd.parse('a\n' + line + '\n' + next, {})[0];
  return first?.type !== 'paragraph_open' || (first.map?.[1] ?? 0) < 2;
}

/** What of a comment, a block of its own, export doesn't read as a
 *  directive, where it reads it as one: the text a style's goes around on
 *  its line, as in <!-- style: Title -->Text<!-- /style -->, or else none.
 *  Undefined where it reads it as none, as a table's with a value it
 *  doesn't read (see parseMd). */
export function directiveRest(comment: string): string | undefined {
  const text = comment.trim();
  const fence = styleFence(text);
  if (fence) return fence.kind === 'inline' ? fence.content : '';
  const fontSize = TABLE_FONT_SIZE_RE.exec(text);
  const font = TABLE_FONT_RE.exec(text);
  const colWidths = TABLE_COL_WIDTHS_RE.exec(text);
  const format = TABLE_NUMBER_FORMAT_RE.exec(text);
  const reads = fontSize ? parseFloat(fontSize[1]) > 0 && isFinite(parseFloat(fontSize[1]))
    : font ? !!font[1].trim()
    : colWidths ? parseColWidths(colWidths[1]) !== undefined
    : format ? (format[1].toLowerCase() === 'digits' ? parseTableDigits(format[2])
      : format[1].toLowerCase() === 'decimal-mark' ? parseTableDecimalMark(format[2]) : parseTableDigitGrouping(format[2])) !== undefined
    : [ORIENTATION_OPEN_RE, ORIENTATION_CLOSE_RE, TABLE_ORIENTATION_RE, REFERENCES_RE, INDENT_RE].some(re => re.test(text));
  return reads ? '' : undefined;
}

// The start of each comment export or a preprocessor of its may read as a
// directive, valid or not: a section's (see ORIENTATION_OPEN_RE and
// orientation-scan.ts), a style block's fence (style-fence.ts), a table's,
// an embed (EMBED_RE in embed-preprocess.ts), references or an indent
const DIRECTIVE_START_RE = /<!--\s*(?:\/?(?:landscape|portrait|style)|table-|embed:|references|bibliography|indent|no-indent)/i;

/** Whether Markdown `text` holds, anywhere, a comment that starts as a
 *  directive does, which export may read as one where the comment is a
 *  block of its own, as it reads any of them (see directiveRest) */
export function holdsDirective(text: string): boolean {
  return DIRECTIVE_START_RE.test(text);
}

/** Whether export reads Markdown `text` as one paragraph over all its lines */
export function readsAsParagraph(text: string): boolean {
  citationTextMd ??= createMarkdownIt();
  const tokens = citationTextMd.parse(text, {});
  return tokens.length === 3 && tokens[0].type === 'paragraph_open' && tokens[0].map?.[1] === text.split('\n').length;
}

/** `text` without each of `parts`, which it holds in order, each found
 *  after the one before, in one pass, as taking each out of all the text
 *  in turn took time in the square of their number */
function withoutEach(text: string, parts: string[]): string {
  let rest = '';
  let at = 0;
  for (const part of parts) {
    const found = text.indexOf(part, at);
    if (found === -1) continue;
    rest += text.slice(at, found);
    at = found + part.length;
  }
  return rest + text.slice(at);
}

/** What of `text`, a comment's hidden run, inline Markdown doesn't read
 *  as HTML comments, which a paragraph would show, as the x of
 *  <!-- a -->x<!-- b --> */
export function outsideComments(text: string): string {
  const md = citationTextMd ??= createMarkdownIt();
  return withoutEach(text, (md.parseInline(text, {})[0]?.children ?? [])
    .filter(child => child.type === 'html_inline' && child.content.startsWith('<!--')).map(child => child.content));
}

/** `text`, a comment's hidden run, without the whitespace inline Markdown
 *  reads outside its HTML comments, which Word hides with them, but which a
 *  paragraph would show, as the space of <!-- a --> <!-- b --> */
export function withoutSpaceOutsideComments(text: string): string {
  const md = citationTextMd ??= createMarkdownIt();
  let kept = '';
  let at = 0;
  for (const child of md.parseInline(text, {})[0]?.children ?? []) {
    if (child.type !== 'html_inline' || !child.content.startsWith('<!--')) continue;
    const found = text.indexOf(child.content, at);
    if (found === -1) continue;
    kept += text.slice(at, found).replace(/^\s+$/, '') + child.content;
    at = found + child.content.length;
  }
  return kept + text.slice(at).replace(/^\s+$/, '');
}

/** Whether export reads Markdown `text` as one paragraph, or with `heading`
 *  one heading, whose HTML
 *  comments are those inline Markdown reads in each of `payloads`, the
 *  comments' hidden runs, read alone, as in &#32;<!-- a --><!-- b -->c with
 *  one run of both, or, where runs may merge (`merge`), whose comments hold
 *  the runs' text and no more, as one that ends in ---> does the run after
 *  it that Word split from it. Not as text, as a comment with a blank line
 *  in it, nor where a comment takes in text between runs, as one that ends
 *  in ---> does a space before the next run */
export function readsCommentsInline(text: string, payloads: string[], merge = false, heading = false): boolean {
  const md = citationTextMd ??= createMarkdownIt();
  const tokens = md.parse(text, {});
  if (tokens.length !== 3 || tokens[0].type !== (heading ? 'heading_open' : 'paragraph_open') || tokens[0].map?.[1] !== text.split('\n').length) return false;
  const comments = (children: Token[] | null) => (children ?? [])
    .filter(child => child.type === 'html_inline' && child.content.startsWith('<!--')).map(child => child.content);
  const read = comments(tokens[1].children);
  const alone = payloads.map(payload => comments(md.parseInline(payload, {})[0]?.children ?? null));
  // Each run's comments hold every <!-- in it, as one that ends in --->
  // with nothing after it doesn't, which would be text
  const whole = alone.every((found, k) => !withoutEach(payloads[k], found).includes('<!--'));
  const expected = alone.flat();
  return whole && read.length === expected.length && read.every((comment, k) => comment === expected[k])
    || merge && read.join('') === payloads.join('');
}

/** What export reads of Markdown `markdown`, a paragraph's as import may
 *  write it: the text of its HTML comments, which Word hides, and the text
 *  Word shows, both without whitespace, with each line break in it as a
 *  NUL, which no text holds, so where each is goes with the text, or null
 *  where it reads anything but paragraphs of text, line breaks and
 *  comments, as a heading, a list, code, raw HTML, an equation or a
 *  tracked change. A line end in a paragraph, which Word shows as a space,
 *  is whitespace. Read before a paragraph of its own, a z, to which a
 *  directive before it applies, which export then takes out, so its
 *  comment is in neither */
export function exportReads(markdown: string): { hidden: string; shown: string } | null {
  let hidden = '';
  let shown = '';
  for (const token of parseMd(markdown + '\n\nz\n', [])) {
    if (token.type !== 'paragraph') return null;
    for (const run of token.runs) {
      if (run.type === 'html_comment') hidden += run.text;
      else if (run.type === 'text' && !run.rawHtml) shown += run.text;
      else if (run.type === 'hardbreak') shown += '\0';
      else if (run.type !== 'softbreak') return null;
    }
  }
  return { hidden: hidden.replace(/\s+/g, ''), shown: shown.replace(/\s+/g, '') };
}

/** The blocks export reads in Markdown `markdown`, each with its kind and
 *  its runs, those of text next to each other formatted alike joined, as
 *  Word shows them: what the Markdown gives Word, to compare Markdown by */
export function blocksAsRead(markdown: string): Array<Pick<MdToken, 'type' | 'level' | 'taskChecked' | 'alertType' | 'runs'>> {
  const format = (run: MdRun) => JSON.stringify({ ...run, text: '' }, (_key, value: unknown) => value instanceof Map || value instanceof Set ? [...value] : value);
  return parseMd(markdown).map(({ type, level, taskChecked, alertType, runs }) => ({
    type, level, taskChecked, alertType,
    // Raw HTML shows in Word as other text does, but for a line end in it
    // (see holdsRawHtmlLineEnd)
    runs: runs.map(run => run.rawHtml && !holdsRawHtmlLineEnd(run) ? { ...run, rawHtml: undefined } : run).reduce<MdRun[]>((joined, run) => {
      const last = joined[joined.length - 1];
      if (last?.type === 'text' && run.type === 'text' && format(last) === format(run)) joined[joined.length - 1] = { ...last, text: last.text + run.text };
      // A break as Word has it, from a <br> or a \ alike
      else joined.push(run.htmlBreak ? { ...run, htmlBreak: undefined } : run);
      return joined;
    }, []),
  }));
}

/** Whether export reads Markdown `markdown` as one block of `text` alone,
 *  unformatted, as it does an HTML block that is no comment alone,
 *  directive, image, line break or table, as it is, or after its line's
 *  prefix, as a list item's marker */
export function showsAsText(markdown: string, text = markdown): boolean {
  const blocks = blocksAsRead(markdown);
  const run = blocks.length === 1 && blocks[0].runs.length === 1 ? blocks[0].runs[0] : undefined;
  return run?.type === 'text' && run.text === text && !run.bold && !run.italic && !run.underline && !run.strikethrough
    && !run.superscript && !run.subscript && !run.highlight && !run.code && run.href === undefined;
}

/** The HTML blocks export reads in Markdown `text`, not in a quote or list:
 *  each one's lines, from `start` to before `end`, and its text */
export function htmlBlocksIn(text: string): Array<{ start: number; end: number; content: string }> {
  citationTextMd ??= createMarkdownIt();
  return citationTextMd.parse(text, {}).flatMap(token => token.type === 'html_block' && token.level === 0 && token.map
    ? [{ start: token.map[0], end: token.map[1], content: token.content }] : []);
}

function citationRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  // One in a link's label too, which keeps its field (see citationSpanAt)
  const endPos = citationSpanAt(state, start, silent, true);
  if (endPos === -1) return false;
  // With the line breaks of CriticMarkup in it, as in a comment's body
  const rawContent = restoreCriticLineBreaks(state.src.slice(start + 1, endPos));

  if (!silent) {
    const token = pushManuscriptToken(state, 'citation', '', 0);
    // Preserve original content (everything between the brackets) for fallback rendering
    token.content = rawContent;

    const keys: string[] = [];
    const locators = new Map<string, string>();
    const suppressAuthorKeys = new Set<string>();
    const prefixes: string[] = [];

    for (const { key, locator, suppressed, prefix } of readCitationItems(rawContent)) {
      keys.push(key);
      if (locator !== undefined) locators.set(key, locator);
      if (suppressed) suppressAuthorKeys.add(key);
      prefixes.push(prefix ? citationPrefixText(state, prefix).trim() : '');
    }

    token.keys = keys;
    token.locators = locators;
    token.suppressAuthorKeys = suppressAuthorKeys.size > 0 ? suppressAuthorKeys : undefined;
    token.prefixes = prefixes.some(Boolean) ? prefixes : undefined;
  }

  state.pos = endPos + 1;
  return true;
}

/** A cross-reference to a figure or a table (see crossRefAt), as its
 *  Markdown, which Word gets as a REF field to the caption, or a
 *  citation's brackets with one in them, which Word gets as text */
function crossRefRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const ref = crossRefSpanAt(state, start, silent);
  if (!ref) return false;
  if (!silent) {
    const token = pushManuscriptToken(state, 'cross_reference', '', 0);
    const source = restoreCriticLineBreaks(state.src.slice(start, ref.end));
    // The text as Word shows it where it's text, as a reference to a label
    // no caption has: its escapes read, as in [@fig-a\_b], and a literal
    // one's line ends as spaces, as a softbreak's
    token.content = ref.form === 'literal' ? state.md.utils.unescapeAll(source).replace(/\r\n?|\n/g, ' ') : state.md.utils.unescapeAll(source);
    token.crossRef = ref;
  }
  state.pos = ref.end;
  return true;
}

function pushMathToken(state: StateInline, content: string, display = false): void {
  const token = pushManuscriptToken(state, 'math', '', 0);
  token.content = content;
  if (display) token.display = true;
}

function mathRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (start >= state.posMax || state.src.charAt(start) !== '$') return false;

  const match = findDollarMathAt(state.src, start, DOCX_DOLLAR_MATH_OPTIONS);
  if (!match || match.kind !== 'math') return false;

  state.pos = match.end;
  if (silent) return true;

  const content = state.src.slice(match.contentStart, match.contentEnd);
  const isDisplay = match.delimiterLength === 2;
  const criticParts = splitCriticMarkupInMath(content);
  // A highlight inside display math is LaTeX, as before: import reads none
  // there, which the preview leaves to VS Code's KaTeX (see
  // ommlChildrenToLatex in omml.ts)
  const highlighted = criticParts?.some(part => part.type === 'highlight');
  if (criticParts && criticParts.every(isTrackedMathPart)
    && (!highlighted || !isDisplay && trackedEquationLatex(criticParts) !== undefined)) {
    pushTrackedMathToken(state, criticParts, isDisplay);
    return true;
  }
  // A comment, or a highlight that one equation can't hold, splits an inline
  // equation; a display equation can't be split into inline ones and keeps
  // it as LaTeX
  if (criticParts && !isDisplay) {
    pushCriticMathTokens(state, criticParts);
    return true;
  }

  pushMathToken(state, content, isDisplay);
  return true;
}

/** Whether Word can record a part inside an equation: a change, or a
 *  highlight, which Word holds on its runs, without CriticMarkup in it,
 *  which no span inside an equation can hold, or a % comment, whose hidden
 *  run takes no highlight, so import wouldn't read the highlight back. An
 *  equation with any other highlight splits, as before. */
function isTrackedMathPart(part: CriticMathPart): boolean {
  return part.type === 'math' || part.type === 'addition' || part.type === 'deletion' || part.type === 'substitution'
    || part.type === 'highlight' && splitCriticMarkupInMath(part.content) === undefined && !holdsLatexComment(part.content);
}

/** An equation with insertions, deletions, substitutions and highlights
 *  inside, which become tracked or highlighted runs in one equation (see
 *  generateTrackedMathXml). */
function pushTrackedMathToken(state: StateInline, parts: CriticMathPart[], display: boolean): void {
  const token = pushManuscriptToken(state, 'math', '', 0);
  // For rendering without a tracker, as inside a deleted span: every part
  // where it belongs
  token.content = trackedEquationLatex(parts, true)
    ?? parts.map(part => part.type === 'substitution' ? part.oldContent + ' ' + part.newContent : part.content).join(' ');
  token.criticMathParts = parts;
  if (display) token.display = true;
}

function wrapInlineMathFragment(content: string): string {
  return content.length > 0 ? '$' + content + '$' : '';
}

/** Whether `run` is an inline equation with a highlight inside, which
 *  generateRuns writes without a highlight around it, as one with a change
 *  inside, so that in a highlight it's split at its CriticMarkup, as before
 *  (see splitAtCriticMarkup) */
export function splitsInHighlight(run: MdRun): boolean {
  return run.type === 'math' && !run.display && !!run.mathParts?.some(part => part.type === 'highlight');
}

/** The runs of an inline equation split at its CriticMarkup, as the tokens
 *  pushCriticMathTokens writes give them, each with the equation's
 *  formatting */
export function splitAtCriticMarkup(run: MdRun): MdRun[] {
  const { mathParts, ...equation } = run;
  const runs: MdRun[] = [];
  for (const part of mathParts ?? []) {
    if (part.type === 'math') {
      if (part.content) runs.push({ ...equation, type: 'math', text: part.content });
    } else if (part.type === 'substitution') {
      const oldText = wrapInlineMathFragment(part.oldContent);
      const newText = wrapInlineMathFragment(part.newContent);
      runs.push({ ...equation, type: 'critic_sub', text: oldText, newText, oldRuns: parseCriticInnerRuns(oldText), newRuns: parseCriticInnerRuns(newText) });
    } else {
      const text = wrapInlineMathFragment(part.content);
      const type = part.type === 'addition' ? 'critic_add' : part.type === 'deletion' ? 'critic_del' : 'critic_highlight';
      runs.push({ ...equation, type, text, innerRuns: parseCriticInnerRuns(text) });
    }
  }
  return runs;
}

/** An inline equation split at its highlights and comments, which can't sit inside an equation. */
function pushCriticMathTokens(state: StateInline, parts: CriticMathPart[]): void {
  const pushMath = (content: string) => {
    if (content) pushMathToken(state, content);
  };

  for (const part of parts) {
    if (part.type === 'math') {
      pushMath(part.content);
      continue;
    }

    const token = pushManuscriptToken(state, 'critic_markup', '', 0);
    if (part.type === 'substitution') {
      token.markup = '{~~';
      token.criticType = 'critic_sub';
      token.oldText = wrapInlineMathFragment(part.oldContent);
      token.newText = wrapInlineMathFragment(part.newContent);
      token.content = (token.oldText || '') + '~>' + (token.newText || '');
      continue;
    }

    if (part.type === 'comment') {
      token.markup = '{>>';
      token.criticType = 'critic_comment';
      token.content = part.content;
      const { parentText, replies } = extractReplies(part.content);
      const parsed = parseCommentContent(parentText);
      token.author = parsed.author;
      token.date = parsed.date;
      token.commentText = parsed.text;
      if (replies.length > 0) token.replies = replies;
      continue;
    }

    token.markup = part.type === 'addition' ? '{++' : part.type === 'deletion' ? '{--' : '{==';
    token.criticType = part.type === 'addition'
      ? 'critic_add'
      : part.type === 'deletion'
        ? 'critic_del'
        : 'critic_highlight';
    token.content = wrapInlineMathFragment(part.content);
  }
}

/** Inline rule that converts the paragraph placeholder back into softbreak tokens. */
function paraPlaceholderRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0xE000) return false; // \uE000
  if (!state.src.startsWith(PARA_PLACEHOLDER, start)) return false;

  if (!silent) {
    // Emit two softbreaks to represent the paragraph break
    pushManuscriptToken(state, 'softbreak', 'br', 0);
    pushManuscriptToken(state, 'softbreak', 'br', 0);
  }
  state.pos = start + PARA_PLACEHOLDER.length;
  return true;
}

/** markdown-it as export reads Markdown with it, which a test of the
 *  equations latex-env-preprocess.ts reads parses with too */
export function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true });
  // Match the VS Code preview, which links only URLs with a scheme. Fuzzy
  // matching would turn sd.ky or README.md into links to a country's TLD, and
  // Word can't open a protocol-relative //example.com.
  md.linkify.set({ fuzzyLink: false });
  md.linkify.add('//', null);
  // Its linkify rule's search, in pieces (see LINKIFY_PIECE)
  md.linkify.match = text => linkifyInPieces(md.linkify, text, LINKIFY_PIECE);
  md.use(imagePathsWithSpaces);
  md.use(codeSpansOfSpaces);
  md.use(linearInlineComments);
  md.use(criticBreaksEndLinks);
  md.use(criticBreaksInRawHtml);

  md.inline.ruler.before('emphasis', 'para_placeholder', paraPlaceholderRule);
  md.inline.ruler.before('emphasis', 'comment_range', commentRangeRule);
  md.inline.ruler.before('emphasis', 'colored_highlight', coloredHighlightRule);
  md.inline.ruler.before('emphasis', 'critic_markup', criticMarkupRule);
  md.inline.ruler.before('emphasis', 'footnote_ref', footnoteRefRule);
  md.inline.ruler.before('emphasis', 'cross_reference', crossRefRule);
  md.inline.ruler.before('emphasis', 'citation', citationRule);
  md.inline.ruler.before('emphasis', 'math', mathRule);
  // A note body parsed on its own resolves reference links with the
  // document's definitions too, after its own (see parseMd)
  // A text token that starts with an escaped [, or one written as an
  // entity, as &#91;, as import writes Word's
  // text that reads as a task's box or an alert's marker, keeps that in its
  // meta, which text_join leaves on the last token of the run it joins, and
  // so does one that starts with an escaped {, which is no image's size
  md.core.ruler.before('text_join', 'escaped_bracket', state => {
    for (const block of state.tokens) {
      const children = block.type === 'inline' ? block.children ?? [] : [];
      const isText = (token: Token | undefined) => token?.type === 'text' || token?.type === 'text_special';
      for (let i = 0; i < children.length; i++) {
        const escaped = children[i].content === '[' ? 'escapedBracket' : children[i].content === '{' ? 'escapedBrace' : undefined;
        if (children[i].type !== 'text_special' || !escaped || isText(children[i - 1])) continue;
        let last = i;
        while (isText(children[last + 1])) last++;
        children[last].meta = { ...children[last].meta, [escaped]: true };
        i = last;
      }
    }
  });
  // The text right after an image, before text_join joins it, piece by
  // piece, each as markdown-it reads it and as the source writes it, a
  // reference or an escape as written, up to the first } it reads, which
  // ends the image's attributes, so that export hides them as written (see
  // writtenImageAttributes)
  md.core.ruler.before('text_join', 'image_text_source', state => {
    for (const block of state.tokens) {
      const children = block.type === 'inline' ? block.children ?? [] : [];
      for (let i = 0; i < children.length; i++) {
        if (children[i].type !== 'image') continue;
        const pieces: Array<[string, string]> = [];
        for (let j = i + 1; children[j]?.type === 'text' || children[j]?.type === 'text_special'; j++) {
          pieces.push([children[j].content, children[j].type === 'text_special' ? children[j].markup : children[j].content]);
          if (children[j].content.includes('}')) break;
        }
        if (pieces.length > 0) children[i].meta = { ...children[i].meta, textAfter: pieces };
      }
    }
  });
  // A task's box takes the whitespace after it in the source, as
  // parseTaskListMarker reads it, a no-break space too, but not a reference
  // after that, as &#32;, as import writes the whitespace an item's text
  // starts with, which text_join joins to it. The length of the box and its
  // whitespace goes in the meta of the last token of the run text_join
  // joins, as above.
  md.core.ruler.before('text_join', 'task_box_whitespace', state => {
    for (const block of state.tokens) {
      const children = block.type === 'inline' ? block.children ?? [] : [];
      const box = children[0]?.type === 'text' ? /^\[[ xX]\]\s+/.exec(children[0].content) : null;
      if (!box || children[1]?.type !== 'text_special') continue;
      let last = 0;
      while (children[last + 1]?.type === 'text' || children[last + 1]?.type === 'text_special') last++;
      children[last].meta = { ...children[last].meta, taskBoxLength: box[0].length };
    }
  });
  // An alert's marker takes the whitespace after it in the source, but not
  // a reference after that, as &#32;, as import writes the whitespace the
  // alert's text starts with, which text_join joins to it. The length of the
  // marker and its whitespace goes in the meta of the last token of the run
  // text_join joins, as above.
  md.core.ruler.before('text_join', 'alert_marker_whitespace', state => {
    for (const block of state.tokens) {
      const children = block.type === 'inline' ? block.children ?? [] : [];
      const isText = (token: Token | undefined) => token?.type === 'text' || token?.type === 'text_special';
      for (let i = 0; i < children.length; i++) {
        // A marker starts the paragraph or a line (see holdsMarker)
        if (i > 0 && children[i - 1].type !== 'softbreak' && children[i - 1].type !== 'hardbreak') continue;
        const marker = children[i].type === 'text' ? /^\[![A-Za-z]+\][ \t]+/.exec(children[i].content) : null;
        if (!marker || children[i + 1]?.type !== 'text_special') continue;
        let last = i;
        while (isText(children[last + 1])) last++;
        children[last].meta = { ...children[last].meta, alertMarkerLength: marker[0].length };
        i = last;
      }
    }
  });
  md.core.ruler.after('block', 'document_link_definitions', state => {
    const definitions: Record<string, unknown> | undefined = state.env.documentLinkDefinitions;
    if (!definitions) return;
    const references: Record<string, unknown> = state.env.references ??= {};
    for (const [label, definition] of Object.entries(definitions)) {
      if (!(label in references)) references[label] = definition;
    }
  });

  md.use(criticBreaksLeftOver);
  return md;
}

/** Create a markdown-it instance for parsing inner formatting within CriticMarkup payloads. */
function createCriticInnerMarkdownIt(): MarkdownIt {
  const md = createMarkdownIt();
  md.inline.ruler.before('newline', 'critic_paragraph_break', criticParagraphBreakRule);
  // Inner parsing recurses into regular inline formatting and the custom
  // syntaxes. Citations: inserted/new-side citations become Zotero fields,
  // deleted/old-side ones render as literal deleted text (see
  // generateDeletedCriticContent). Footnote references become tracked note
  // references (see noteReferenceXml). Comment range markers and bodies
  // ({#id}, {/id}, {#id>>...<<}) count in a payload too, as in the preview.
  // They were disabled here, so they became literal text and their comment
  // was lost. In deleted text they go between w:dels (see
  // deletionWithComments).
  return md;
}

let _cachedCriticInnerMd: MarkdownIt | undefined;
function getCriticInnerMarkdownIt(): MarkdownIt {
  if (!_cachedCriticInnerMd) {
    _cachedCriticInnerMd = createCriticInnerMarkdownIt();
  }
  return _cachedCriticInnerMd;
}

export function toTextRunFromInner(run: MdRun, overrides?: Partial<MdRun>): MdRun {
  return {
    type: 'text',
    text: run.text,
    bold: run.bold,
    italic: run.italic,
    underline: run.underline,
    strikethrough: run.strikethrough,
    highlight: run.highlight,
    highlightColor: run.highlightColor,
    superscript: run.superscript,
    subscript: run.subscript,
    code: run.code,
    href: run.href,
    // Where a link starts, though the one before goes to the same place
    ...(run.linkStart ? { linkStart: true } : {}),
    ...(run.rawHtml ? { rawHtml: true } : {}),
    // A cross-reference, which Word gets a field for in the change too
    ...(run.crossRef ? { crossRef: run.crossRef } : {}),
    ...overrides,
  };
}

/** An {#id} or {/id} comment range marker, or an {#id>>...<<} comment body */
export function isCommentMarkerRun(run: MdRun): boolean {
  return run.type === 'comment_range_start' || run.type === 'comment_range_end' || run.type === 'comment_body_with_id';
}

/** Preserve break metadata and flatten nested highlights into formatted Word runs. */
function normalizeCriticInnerRuns(runs: MdRun[]): MdRun[] {
  const normalized: MdRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.type === 'softbreak' || run.type === 'hardbreak') {
      normalized.push({ ...run, text: '\n' });
      continue;
    }

    if (run.type === 'text') {
      normalized.push(toTextRunFromInner(run));
      continue;
    }

    // A {==...==} before its comment is the comment's range, which generateRuns
    // anchors; flattened, the comment would cover nothing
    if (run.type === 'critic_highlight' && runs[i + 1]?.type === 'critic_comment') {
      normalized.push(run);
      continue;
    }

    // A {==...==} without a comment inside a Critic payload is preserved as
    // text runs with highlight flags, as it exports at the top level.
    if (run.type === 'critic_highlight') {
      // A link that starts at the highlight starts at its first run only
      const inners = run.innerRuns ?? (run.text ? [toTextRunFromInner(run)] : []);
      inners.forEach((inner, k) => {
        normalized.push({
          ...toTextRunFromInner(run, { linkStart: undefined }),
          ...inner,
          ...(k === 0 && run.linkStart ? { linkStart: true } : {}),
          highlight: true,
          highlightColor: run.highlightColor ?? inner.highlightColor,
        });
      });
      continue;
    }

    if (run.type === 'math' || run.type === 'citation' || run.type === 'image' || run.type === 'footnote_ref') {
      normalized.push(run);
      continue;
    }

    // Nested critic markup (e.g. {--...--} inside {==...==}) — pass through
    // so generateRuns can emit proper <w:ins>/<w:del> wrappers.
    if (run.type === 'critic_add' || run.type === 'critic_del' || run.type === 'critic_sub' || run.type === 'critic_comment') {
      normalized.push(run);
      continue;
    }

    // Comment range markers and bodies have no text, so the fallback below
    // dropped them
    if (isCommentMarkerRun(run)) {
      normalized.push(run);
      continue;
    }

    // Fallback: if any unsupported run type appears, preserve its textual
    // content so we do not silently drop user text.
    if (run.text) {
      normalized.push(toTextRunFromInner(run));
    }
  }
  return normalized;
}

/** Recognize blank lines while parsing a payload, without touching code or math tokens. */
function criticParagraphBreakRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const escaped = state.src[start] === '\\';
  const newlineStart = start + (escaped ? 1 : 0);
  if (state.src[newlineStart] !== '\n') return false;
  const match = /^\n[ \t]*\n/.exec(state.src.slice(newlineStart, state.posMax));
  if (!match) return false;
  if (!silent) {
    state.pending = state.pending.replace(/ +$/, '');
    const first = pushManuscriptToken(state, 'softbreak', 'br', 0);
    first.meta = { criticParagraphBreak: true };
    pushManuscriptToken(state, 'softbreak', 'br', 0);
  }
  state.pos = newlineStart + match[0].length;
  while (state.pos < state.posMax && /[ \t]/.test(state.src[state.pos])) state.pos++;
  return true;
}

/** Parse an entire revision payload so formatting delimiters can span protected paragraph breaks. */
function parseCriticInnerRuns(content: string): MdRun[] {
  if (!content) return [];
  const md = getCriticInnerMarkdownIt();
  const tokens = md.parseInline(content, {});
  return normalizeCriticInnerRuns(convertInlineTokens(tokens));
}

/** The order import writes notes in, by label: numbers by value, then the
 *  rest by text, in one locale, not the machine's. Export makes notes'
 *  bodies in this order, so that the tables and code blocks in them take the
 *  indices import reads them back at. Labels of one number, as 1a and 1b,
 *  tie, and keep the order of their first references, which import reads
 *  them in, as it read the notes of documents that older versions wrote in
 *  that order, and which export breaks the tie with. */
export function compareNoteLabels(a: string, b: string): number {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b, 'en');
}

/** Extract footnote definitions from the markdown source and return cleaned
 *  markdown, and for each of its lines, and one past the last, the line of
 *  the source it comes from (see line-map.ts) */
export function extractFootnoteDefinitions(markdown: string): { cleaned: string; definitions: Map<string, string>; lines: LineMap } {
  const definitions = new Map<string, string>();
  // Its line ends are \n alone (see normalizeNewlines), as convertMdToDocx
  // has them
  const source = markdown;
  const lines = source.split('\n');
  const cleanedLines: string[] = [];
  const keptLines: number[] = [];
  let currentLabel: string | undefined;
  let currentBody: string[] = [];
  // The lines of fenced code and HTML blocks, their fences' too, as
  // markdown-it reads them, which hold no definition, as in <pre> or a
  // comment. Not a line like a fence that isn't one, as ```a`b, whose info
  // can't hold a backtick, or one indented as code, and not past a closing
  // fence, which holds nothing after its marker. Nor a line in CriticMarkup,
  // as parseMd reads it, whose line ends its placeholders hold, so <pre> in
  // a comment starts no block; `starts` has the line each parsed one starts.
  const literal = new Set<number>();
  if (/^\[\^[a-zA-Z0-9_-]+\]:/m.test(source) && /^[ \t]*(?:`{3,}|~{3,}|<)/m.test(source)) {
    const parsed = preprocessCriticMarkup(source, false);
    const starts = [0];
    for (const line of parsed.split('\n')) {
      starts.push(starts[starts.length - 1] + line.split(LINE_PLACEHOLDER).length + 2 * (line.split(PARA_PLACEHOLDER).length - 1));
    }
    citationTextMd ??= createMarkdownIt();
    for (const token of citationTextMd.parse(parsed, {})) {
      if ((token.type === 'fence' || token.type === 'html_block') && token.map) {
        for (let k = starts[token.map[0]]; k < starts[token.map[1]]; k++) literal.add(k);
      }
    }
  }

  function finishDefinition() {
    if (currentLabel !== undefined) {
      definitions.set(currentLabel, currentBody.join('\n'));
      currentLabel = undefined;
      currentBody = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Inside a footnote definition, indented lines are continuation lines (even if they look like fences)
    if (currentLabel !== undefined && (line.startsWith('    ') || line.startsWith('\t'))) {
      currentBody.push(line.replace(/^(?: {4}|\t)/, ''));
      continue;
    }
    // Blank line within a multi-paragraph footnote, which goes on in it
    // though the lines around it read as a list's code, as after a list
    // item with no blank line before the definition
    if (currentLabel !== undefined && line.trim() === '') {
      // Peek ahead: if the next line with text is indented, this is a
      // paragraph break within the footnote, however many blank lines come
      // first, as markdown-it and Pandoc read a note. The run of blank
      // lines goes in at once, so it's read once, an indented one as the
      // lines above, as its spaces can be code's.
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === '') next++;
      if (next < lines.length && (lines[next].startsWith('    ') || lines[next].startsWith('\t'))) {
        for (; i < next; i++) currentBody.push(/^(?: {4}|\t)/.test(lines[i]) ? lines[i].replace(/^(?: {4}|\t)/, '') : '');
        i--;
        continue;
      }
    }
    if (literal.has(i)) {
      finishDefinition();
      cleanedLines.push(line);
      keptLines.push(i);
      continue;
    }
    const defMatch = line.match(/^\[\^([a-zA-Z0-9_-]+)\]:\s?(.*)/);
    if (defMatch) {
      finishDefinition();
      currentLabel = defMatch[1];
      currentBody = [defMatch[2]];
      continue;
    }
    finishDefinition();
    cleanedLines.push(line);
    keptLines.push(i);
  }
  finishDefinition();

  // A blank line comes from the line after the one kept before it, which a
  // definition taken out between them stood on, as a line of text, and with
  // none kept, the cleaned text's one empty line comes from the first, as
  // no line before it was kept (see line-map.ts)
  const from = keptLines.map((line, k) => /^[ \t]*$/.test(cleanedLines[k]) ? (k > 0 ? keptLines[k - 1] + 1 : 0) : line);
  return { cleaned: cleanedLines.join('\n'), definitions, lines: withEnd(from.length > 0 ? from : [0], lines.length) };
}

/** Mark first/last tokens in contiguous runs of blockquotes for spacing.
 *  Learning: when two same-type alerts are adjacent (zero-gap or merged by
 *  markdown-it), each alertLead token starts a new group — the inner loop
 *  must break on alertLead boundaries, not just alertType/level changes. */
function annotateBlockquoteBoundaries(tokens: MdToken[]): void {
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].type !== 'blockquote') {
      i++;
      continue;
    }
    const alertType = tokens[i].alertType;
    const level = tokens[i].level;
    const listLevel = tokens[i].listContinuation?.level;
    const start = i;
    i++;
    // Continue the group while the next token has the same alertType/level
    // and list depth AND is not an alertLead (which signals a new [!TYPE]
    // marker group), nor starts another quote, as after a blank line, which
    // Word otherwise couldn't tell from a paragraph of the same quote.
    while (i < tokens.length && tokens[i].type === 'blockquote' && tokens[i].alertType === alertType && tokens[i].level === level
      && tokens[i].listContinuation?.level === listLevel && !tokens[i].alertLead && !tokens[i].quoteStart) {
      i++;
    }
    tokens[start].alertFirst = true;
    tokens[start].alertHasBodyParagraph = i - start > 1;
    tokens[i - 1].alertLast = true;
  }
}

export function isNonRenderingAlertLeadRun(run: MdRun): boolean {
  return run.type === 'html_comment'
    || (run.type === 'text' && run.text.trim().length === 0);
}

export function moveHiddenAlertLeadComments(tokens: MdToken[]): void {
  for (let i = 0; i + 1 < tokens.length; i++) {
    const lead = tokens[i];
    if (
      !lead.alertLead
      || !lead.alertHasBodyParagraph
      || lead.runs.length === 0
      || !lead.runs.every(isNonRenderingAlertLeadRun)
    ) {
      continue;
    }
    const body = tokens[i + 1];
    // Spaces and tabs alone show nothing in the lead, but would at the
    // start of the body's text, where import keeps them
    if (!lead.blankAlertLead) body.runs = [...lead.runs, ...body.runs];
    lead.runs = [];
  }
}

// Blockquote gap metadata: compute blank-line counts between consecutive
// blockquote groups in the original markdown source.  A "blockquote group"
// is a maximal run of lines starting with '>'.  The gap between two groups
// is the number of blank lines separating them (0 means directly adjacent
// with no blank line).
//
// Learning: this function operates on the raw markdown *before* markdown-it
// parsing, because markdown-it merges adjacent blockquotes with zero blank
// lines into a single blockquote_open/close pair, losing the gap info.
// Learning: within a contiguous run of '>' lines, a line matching
// '> [!TYPE]' (where TYPE is a GFM alert keyword) starts a new group —
// this handles zero-gap same-type alerts that have no blank line between them.
/** Detect whether the markdown source uses tab-based list indentation. */
export function detectListIndent(markdown: string): 'tab' | 'spaces' {
  // Look for nested list items (lines starting with tab followed by - or *)
  const tabIndented = /^\t+[-*+] /m.test(markdown) || /^\t+\d+\. /m.test(markdown);
  // Also detect tab after marker at top-level: `-\t` or `1.\t`
  const tabAfterMarker = /^[-*+]\t/m.test(markdown) || /^\d+\.\t/m.test(markdown);
  return (tabIndented || tabAfterMarker) ? 'tab' : 'spaces';
}

function extractBulletMarkerFromSourceLine(line: string | undefined): '-' | '*' | '+' | undefined {
  if (!line) return undefined;
  const withoutBlockquote = line.replace(/^ {0,3}(?:>\s*)*/, '');
  const match = withoutBlockquote.match(/^[ \t]*([-*+])(?:[ \t]|$)/);
  if (!match) return undefined;
  const marker = match[1];
  return marker === '-' || marker === '*' || marker === '+' ? marker : undefined;
}

/** Blank lines around a quote group in the source (see annotateBlockquoteSpacing). */
interface BlockquoteSpacing {
  /** Blank lines to the next group, or -1 when other content sits between */
  gapAfter?: number;
  /** Blank lines before the group, after other content */
  before?: number;
  /** Blank lines after the group, before other content */
  after?: number;
  /** Whether an alert's marker line holds text, as in > [!NOTE] text */
  alertInline?: boolean;
  /** Whether an alert's marker is a paragraph of its own, with the alert's
   *  text in the paragraphs after it, as in > [!NOTE] then > and > text,
   *  which Word shows with the label's paragraph, and with the label hidden
   *  has no paragraph for (see omitEmptyAlertLead) */
  alertAlone?: boolean;
}

const BLOCKQUOTE_ALERT_MARKER_RE = /^(?:>\s*)+\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](.*)$/i;

/** Whether a run is spaces and tabs alone that Markdown writes as they are,
 *  as plain, bold or italic text, which import drops from a paragraph (see
 *  dropBlankParagraphText in converter.ts) */
function isBlankText(run: MdRun): boolean {
  return run.type === 'text' && /^[ \t]*$/.test(run.text) && !run.underline && !run.strikethrough && !run.highlight
    && !run.superscript && !run.subscript && !run.code && !run.href;
}

/**
 * Marks each alert's first paragraph that holds spaces or tabs alone, which
 * import drops (see dropBlankParagraphText in converter.ts), but for where
 * it keeps them (see keptBlankParagraphs), once parseMd has the blocks Word
 * gets, as a directive Word gets no paragraph for. Its marker's line holds
 * no text, as &#32;, which import wrote before nothing, and the next
 * paragraph's text after it where the label is hidden. With the label
 * hidden, export leaves the paragraph out (see moveHiddenAlertLeadComments),
 * so its marker is alone, as for an empty one (see annotateBlockquoteSpacing).
 */
function annotateBlankAlertLeads(tokens: MdToken[]): void {
  const kept = keptBlankParagraphs(tokens);
  for (const lead of tokens) {
    if (!lead.alertLead || kept.has(lead) || !lead.runs.every(isBlankText)) continue;
    lead.blankAlertLead = true;
    const spacing = lead.blockquoteSpacing;
    // Where the marker's line was found (see annotateBlockquoteSpacing)
    if (spacing?.alertInline === undefined) continue;
    spacing.alertInline = false;
    if (lead.alertHasBodyParagraph) spacing.alertAlone = true;
  }
}

/**
 * The tokens whose spaces and tabs alone import keeps as the paragraph's
 * text, as dropBlankParagraphText in converter.ts doesn't drop them: where
 * its mark or that of the paragraph Word gets before it is a tracked change,
 * or an ID comment's range from a token before it is open at its start. An
 * ID's range runs from its first {#id} to its last {/id}, as export gives
 * every one of them the ID's one Word comment (see prescanCommentIds), whose
 * range Word reads from its first start to its last end. The paragraph
 * Word gets before it is past those Word gets none for (see
 * paragraphsBefore).
 */
function keptBlankParagraphs(tokens: MdToken[]): Set<MdToken> {
  const ranges = new Map<string, { first: number; last: number }>();
  const walk = (runs: MdRun[] = [], at: number) => {
    for (const run of runs) {
      if (run.type === 'comment_range_start' || run.type === 'comment_range_end') {
        const id = run.commentId || '';
        const range = ranges.get(id) ?? { first: Infinity, last: -1 };
        if (run.type === 'comment_range_start') range.first = Math.min(range.first, at);
        else range.last = Math.max(range.last, at);
        ranges.set(id, range);
      }
      walk(run.innerRuns, at);
      walk(run.oldRuns, at);
      walk(run.newRuns, at);
    }
  };
  tokens.forEach((token, at) => {
    walk(token.runs, at);
    for (const row of token.rows ?? []) for (const cell of row.cells) walk(cell.runs, at);
  });
  // How many ranges are open at each token's start, from the token after
  // each one's first start to its last end
  const opens = new Array<number>(tokens.length + 1).fill(0);
  for (const { first, last } of ranges.values()) {
    if (first < last) {
      opens[first + 1]++;
      opens[last + 1]--;
    }
  }
  const before = paragraphsBefore(tokens);
  const kept = new Set<MdToken>();
  let open = 0;
  tokens.forEach((token, at) => {
    open += opens[at];
    if (open > 0 || token.criticParaMark || before[at]?.criticParaMark) kept.add(token);
  });
  return kept;
}

/**
 * For each token, the one whose paragraph Word gets last before it, as
 * generateDocumentXml writes them, found in one pass: past a paragraph of
 * comment bodies only, which it leaves out (see commentBodiesOmitted), and a
 * style's directive, for which it writes none (see isStyleDirective), and
 * past quote paragraphs of comment bodies only, which go into the paragraph
 * of their quote before them where it takes them (see
 * withQuoteCommentBodiesMerged), or else stay, as a blank alert's lead takes
 * none. Their quote is that paragraph's where it's a quote's paragraph that
 * ends no alert, as no other block is between (see
 * annotateBlockquoteGroupIndices, which runs later).
 */
function paragraphsBefore(tokens: MdToken[]): Array<MdToken | undefined> {
  const omitsCommentBodies = commentBodiesOmitted(tokens);
  const before: Array<MdToken | undefined> = [];
  // The last token Word gets a paragraph for, and the last block
  // generateDocumentXml reads, for whether it writes comment bodies between
  // two lists. It reads none after a directive, which is no list's, so a
  // directive gives the same answer, but for the close of a style block
  // Word gets nothing for, which it reads past (see isImplicitStyleClose)
  let last: MdToken | undefined;
  let prev: MdToken | undefined;
  tokens.forEach((token, at) => {
    before.push(last);
    if (omitsCommentBodies(at, prev) || isImplicitStyleClose(token)) return;
    prev = token;
    if (isStyleDirective(token)) return;
    if (isQuoteCommentBodies(token) && last?.type === 'blockquote' && !last.alertLast && takesQuoteCommentBodies(last)) return;
    last = token;
  });
  return before;
}

/** Markdown source without its complete ID comment bodies ({#id>>...<<}). */
function withoutCommentBodies(src: string): string {
  const closers = criticCloserSearch(src);
  let kept = '';
  let from = 0;
  for (let open = src.indexOf('{#'); open !== -1; open = src.indexOf('{#', open + 2)) {
    const id = /^[a-zA-Z0-9_-]+>>/.exec(src.slice(open + 2));
    const close = id ? closers.matching(open + 2 + id[0].length) : -1;
    if (close === -1) continue;
    kept += src.slice(from, open);
    from = close + 3;
    open = close + 1;
  }
  return kept + src.slice(from);
}
const LIST_MARKERS_RE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*/;
const BARE_QUOTE_LINE_RE = /^\s*(?:>\s*)+$/;

/**
 * Record on each quote group's first token the blank lines around the group
 * in the original source, which import restores (see the
 * MANUSCRIPT_BLOCKQUOTE_* custom properties). The groups are the tokens' own
 * (see annotateBlockquoteBoundaries), so spacing can't land on another
 * quote. Each group's lines in the text parseMd parses go to the source's,
 * `sourceLines`, through `toSource`, for each line of that text the line of
 * the source it comes from (see line-map.ts), and not by a search for their
 * text, which found the text of another block that held it first, as code
 * does. A group's lines go from the line of its first to the line of the
 * line after its last, which is past the line of the last character it
 * holds of the source's, as where a trim of the blank lines at the end
 * wrote its last line end. A group that holds none, whose lines
 * preprocessing wrote, gets no spacing. The source's lines say how the
 * group is laid out alone, its blank lines and markers: what an alert's
 * marker's line holds is read from `parsedLines`, the text markdown-it
 * parsed, where a comment body over lines is on one.
 */
/** The blocks list items of `tokens` dropped, which Word gets nothing of,
 *  in the source's lines through `source`: the first line of each by the
 *  line after its last, and that line by its first */
interface DroppedLines { before: Map<number, number>; after: Map<number, number> }
function droppedBlocksOf(tokens: MdToken[], source: (line: number) => number): DroppedLines {
  const before = new Map<number, number>();
  const after = new Map<number, number>();
  for (const token of tokens) {
    for (const [start, end] of token.itemDropped ?? []) {
      const from = source(start);
      const to = source(end);
      if (from >= to) continue;
      before.set(to, from);
      after.set(from, to);
    }
  }
  return { before, after };
}

/** Adds to `dropped` the lines of `tokens` at the top level Word gets
 *  nothing of where they are, which import writes nothing for there: the
 *  fences of each style block that Word has no paragraph of in its style,
 *  as one of only quotes, headings, code, tables or thematic breaks, which
 *  keep their own (see unstyledInStyleBlock), or of nothing, as import
 *  finds a block by its paragraphs, and each paragraph of comment bodies
 *  only that Word doesn't get, whose bodies import writes with their
 *  comments. So the blank lines on either side of one are those of the
 *  blocks beside it, as for a block a list item drops. Returns the places
 *  in `tokens` of those it adds */
function addLinesWordLacks(tokens: MdToken[], source: (line: number) => number, dropped: DroppedLines): Set<number> {
  const places = new Set<number>();
  const drop = (at: number) => {
    const [start, end] = tokens[at].sourceRange!;
    const from = source(start);
    const to = source(end);
    if (from >= to) return;
    dropped.before.set(to, from);
    dropped.after.set(from, to);
    places.add(at);
  };
  let open: { style: string; fences: number[]; shown: boolean } | undefined;
  const close = () => {
    if (open && !open.shown) open.fences.forEach(drop);
    open = undefined;
  };
  // A paragraph of comment bodies only that Word doesn't get is no
  // paragraph of the block's, as generateDocumentXml leaves it out (see
  // commentBodiesOmitted), which reads it after the last block it reads
  const omitsCommentBodies = commentBodiesOmitted(tokens);
  let prev: MdToken | undefined;
  for (const [at, token] of tokens.entries()) {
    if (omitsCommentBodies(at, prev)) {
      // Not one split from a block, whose lines are the block's (see
      // splitPart), which Word gets the rest of
      if (token.sourceRange && !token.splitPart) drop(at);
      continue;
    }
    prev = token;
    const run = token.type === 'paragraph' && !token.listContinuation && token.runs.length === 1 ? token.runs[0] : undefined;
    const fence = run?.type === 'html_comment' ? styleFence(run.text) : undefined;
    // A block that opens closes the one open, as a block on one line or
    // one in a list item does too (see applyCustomStyleSentinels), but one
    // of the same style goes on in it, as generateDocumentXml reads it
    // (see startsStyleBlock)
    if (fence?.kind === 'open') {
      if (startsStyleBlock(open?.style, fence.style)) {
        close();
        open = { style: fence.style, fences: [], shown: false };
      }
      if (token.sourceRange) open!.fences.push(at);
    } else if (fence?.kind === 'close') {
      if (open && token.sourceRange) open.fences.push(at);
      close();
    } else if (fence?.kind === 'inline') {
      // Its paragraph is the open block's, of the same style
      if (open && !startsStyleBlock(open.style, fence.style)) open.shown = true;
      close();
    } else if (token.itemStyleOpen !== undefined) close();
    else if (open && !unstyledInStyleBlock(token) && !marksSectionOrBibliography(token)) open.shown = true;
  }
  close();
  return places;
}

/** The most blank lines in a row from `from` of `lines`, by `step`, from
 *  `low` on, past the blocks list items dropped, `dropped`, which Word gets
 *  nothing of, so that those on either side of one are those of the block
 *  beside it: as many as on the side with more. Not those after the last
 *  before the end of `lines` */
function blankLinesPastDropped(lines: string[], dropped: DroppedLines, from: number, step: 1 | -1, low = 0): number {
  const blankRun = (start: number) => {
    let line = start;
    while (line >= low && line < lines.length && lines[line].trim() === '') line += step;
    return { count: Math.abs(line - start), line };
  };
  let run = blankRun(from);
  let count = run.count;
  for (let past = step < 0 ? dropped.before.get(run.line + 1) : dropped.after.get(run.line); past !== undefined;
    past = step < 0 ? dropped.before.get(run.line + 1) : dropped.after.get(run.line)) {
    run = blankRun(step < 0 ? past - 1 : past);
    if (run.line < lines.length) count = Math.max(count, run.count);
  }
  return count;
}

/** Whether `lines` from `from` on hold nothing but blank lines and the
 *  blocks Word gets nothing of, `dropped` */
function onlyDroppedFrom(lines: string[], dropped: DroppedLines, from: number): boolean {
  let line = from;
  for (let past: number | undefined = from; past !== undefined; past = dropped.after.get(line)) {
    line = past;
    while (line < lines.length && lines[line].trim() === '') line++;
  }
  return line >= lines.length;
}

/** The tokens in a style block at the top level of `tokens` that no
 *  fence of its own closes, after which import writes a closing fence
 *  where it writes the block (see addLinesWordLacks) */
function inStyleBlockNoFenceCloses(tokens: MdToken[]): Set<number> {
  const inside = new Set<number>();
  let open: { style: string; tokens: number[] } | undefined;
  const end = (fenced: boolean) => {
    if (open && !fenced) for (const at of open.tokens) inside.add(at);
    open = undefined;
  };
  for (const [at, token] of tokens.entries()) {
    const run = token.type === 'paragraph' && !token.listContinuation && token.runs.length === 1 ? token.runs[0] : undefined;
    const fence = run?.type === 'html_comment' ? styleFence(run.text) : undefined;
    if (fence?.kind === 'open') {
      if (startsStyleBlock(open?.style, fence.style)) {
        end(false);
        open = { style: fence.style, tokens: [] };
      }
    } else if (fence?.kind === 'close') end(true);
    else if (fence?.kind === 'inline' || token.itemStyleOpen !== undefined) end(false);
    else open?.tokens.push(at);
  }
  end(false);
  return inside;
}

function annotateBlockquoteSpacing(tokens: MdToken[], toSource: LineMap, sourceLines: string[], parsedLines: string[]): void {
  // Its lines, from start, past the lines of a block its quote dropped
  // before it
  interface Group { first: MdToken; start: number; end: number; markerLine: boolean; last: number }
  const groups: Array<Group | undefined> = [];
  const source = (line: number) => toSource[Math.min(line, toSource.length - 1)];
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t].type !== 'blockquote' || !tokens[t].alertFirst) continue;
    let start = Infinity;
    let end = -Infinity;
    let last = t;
    for (let k = t; k < tokens.length && tokens[k].type === 'blockquote'; k++) {
      last = k;
      for (const range of [tokens[k].sourceRange, tokens[k].droppedRange]) {
        if (range) {
          start = Math.min(start, range[0]);
          end = Math.max(end, range[1]);
        }
      }
      if (tokens[k].alertLast) break;
    }
    const from = start < end ? source(start) : 0;
    const to = start < end ? source(end) : 0;
    if (to <= from || from >= sourceLines.length) {
      groups.push(undefined);
      continue;
    }
    groups.push({
      first: tokens[t],
      start: from,
      end: Math.min(to, sourceLines.length) - 1,
      // As in - > q: blank lines before it belong before the list item
      markerLine: !sourceLines[from].trimStart().startsWith('>'),
      last,
    });
  }
  // A bare > line after a group's text stays in the group
  groups.forEach((group, g) => {
    if (!group) return;
    const limit = groups[g + 1]?.start ?? sourceLines.length;
    while (group.end + 1 < limit && BARE_QUOTE_LINE_RE.test(sourceLines[group.end + 1])) group.end++;
  });
  const blankRun = (from: number, step: 1 | -1) => {
    let line = from;
    while (line >= 0 && line < sourceLines.length && sourceLines[line].trim() === '') line += step;
    return { count: Math.abs(line - from), line };
  };
  // Past the blocks list items dropped, so that the blank lines on either
  // side of one are the quote's
  const dropped = droppedBlocksOf(tokens, source);
  const lacked = addLinesWordLacks(tokens, source, dropped);
  const blankRunPastDropped = (from: number, step: 1 | -1) => blankLinesPastDropped(sourceLines, dropped, from, step);
  const unfenced = inStyleBlockNoFenceCloses(tokens);
  // The place of the last block import writes where it is, past those
  // Word gets nothing of there (see addLinesWordLacks)
  let lastWritten = tokens.length - 1;
  while (lastWritten >= 0 && lacked.has(lastWritten)) lastWritten--;
  groups.forEach((group, g) => {
    if (!group) return;
    const previous = groups[g - 1];
    const next = groups[g + 1];
    const spacing: BlockquoteSpacing = {};
    // Groups that share a line have nothing between them
    const sharesPrevious = !!previous && group.start <= previous.end;
    const sharesNext = !!next && next.start <= group.end;
    const above = blankRun(group.start - 1, -1);
    if (group.markerLine) spacing.before = 0;
    else if (!sharesPrevious && above.line >= 0 && !(previous && above.line === previous.end)) spacing.before = blankRunPastDropped(group.start - 1, -1);
    const below = blankRun(group.end + 1, 1);
    if (sharesNext) spacing.gapAfter = 0;
    else {
      // Not before definitions, of notes or links, with none of the body
      // after them, after which import writes notes' after a blank line of
      // its own, nor before the end past what Word gets nothing of, as a
      // comment's body or a style block's fences, where the quote is last,
      // but in a block no fence closes, after which import writes one. Nor
      // before such blocks with only definitions after them, or between
      // them, which import writes after the body too, where the quote is
      // last of what import writes of the body, as at the end
      if (below.line < sourceLines.length && group.last + 1 < tokens.length
        && (unfenced.has(group.last) || group.last < lastWritten && !onlyDroppedFrom(sourceLines, dropped, below.line))
        && !(next && !next.markerLine && below.line === next.start)) spacing.after = blankRunPastDropped(group.end + 1, 1);
      if (next) spacing.gapAfter = !next.markerLine && below.line === next.start ? below.count : -1;
    }
    // The first's first line as parsed, which an alert's marker starts
    const firstLine = group.first.sourceRange ? parsedLines[group.first.sourceRange[0]] : undefined;
    const alertMarker = firstLine?.replace(LIST_MARKERS_RE, '').match(BLOCKQUOTE_ALERT_MARKER_RE);
    // A comment body on the marker line shows nothing, and import writes it
    // below. Nor does a paragraph of spaces alone, which import drops (see
    // annotateBlankAlertLeads)
    if (alertMarker) spacing.alertInline = withoutCommentBodies(alertMarker[2]).trim().length > 0;
    // A marker the alert's first paragraph is none of the text of, or one of
    // spaces alone (see annotateBlankAlertLeads)
    if (alertMarker && group.first.alertLead && group.first.alertHasBodyParagraph && group.first.runs.length === 0) spacing.alertAlone = true;
    group.first.blockquoteSpacing = spacing;
  });
}

/** The spacing maps export stores as custom properties, by group index, from
 *  the spacing annotateBlockquoteSpacing put on each group's first token. */
export function blockquoteSpacingMaps(tokens: MdToken[]) {
  const maps = {
    gaps: new Map<number, number>(),
    before: new Map<number, number>(),
    after: new Map<number, number>(),
    alertInline: new Map<number, boolean>(),
    alertAlone: new Map<number, boolean>(),
  };
  for (const token of tokens) {
    const spacing = token.blockquoteSpacing;
    const group = token.blockquoteGroupIndex;
    if (!spacing || group === undefined) continue;
    if (spacing.gapAfter !== undefined) maps.gaps.set(group, spacing.gapAfter);
    if (spacing.before !== undefined) maps.before.set(group, spacing.before);
    if (spacing.after !== undefined) maps.after.set(group, spacing.after);
    if (spacing.alertInline !== undefined) maps.alertInline.set(group, spacing.alertInline);
    if (spacing.alertAlone) maps.alertAlone.set(group, true);
  }
  return maps;
}

/**
 * The quote groups import would read in a deeper list item than they're in,
 * by group index, with the list level each is in (0 in none) and its quote
 * levels, which import places it by (see MANUSCRIPT_BLOCKQUOTE_LIST_LEVELS).
 * A quote's indent is its list item's and a step for each of its levels, so
 * one right after a sublist, in the item above it or in no list, has the
 * indent of one with fewer levels in the sublist, which import takes. A
 * quote style's step is a list level's, and GitHub's a third of one. Import
 * has a deeper item open where an item, or a paragraph or quote in one, was
 * last, and none after another block or a quote in no list (see
 * annotateStructuralParagraphMetadata in converter.ts).
 */
export function blockquoteListPlaces(tokens: MdToken[]): Map<number, BlockquotePlace> {
  const places = new Map<number, BlockquotePlace>();
  // The depth of the deepest item import has open
  let open = 0;
  for (const token of tokens) {
    if (isImplicitStyleClose(token)) continue;
    const listLevel = token.listContinuation?.level ?? 0;
    if (token.type === 'blockquote') {
      const group = token.blockquoteGroupIndex;
      // One of one level in no list has no indent to read
      if (group !== undefined && !places.has(group) && open > listLevel && ((token.level || 1) > 1 || listLevel > 0)) {
        places.set(group, [listLevel, token.level || 1]);
      }
      open = listLevel;
    } else if (token.type === 'list_item') {
      open = token.level || 1;
    } else if (token.listContinuation) {
      open = listLevel;
    } else if (!(token.type === 'paragraph' && token.runs.length > 0 && token.runs.every(run => run.type === 'html_comment'))) {
      // A comment's hidden paragraph may leave the items open
      open = 0;
    }
  }
  return places;
}

/** A quote group's list level and quote level */
export type BlockquotePlace = [listLevel: number, level: number];

/** What tells import a quote group is the one export wrote, not one Word
 *  added before it, which takes its index: the fingerprint of its first
 *  paragraph with text, past an alert's label, which tells nothing of
 *  which alert it is (see paragraphStartFingerprint), and the number of its
 *  paragraphs. Once its first paragraph is written. With its kind, the
 *  alert's type, or '' for a quote that's no alert, which tells it from a
 *  group of another kind with the same text (see blockquoteIdentityProps) */
export interface QuoteGroupIdentity {
  start?: string;
  paragraphs: number;
  kind: string;
  // Its paragraphs before its start, each with a cross-reference whose
  // field shows text once its caption is known, and the alert's label it
  // starts with, any of which may be its start then (see settleQuoteStarts)
  startsPending?: Array<{ xml: string; label: string }>;
}

/** Recursively promote all softbreak runs to hardbreak (for `breaks` mode and grid table cells). */
function promoteSoftbreaks(runs: MdRun[]): void {
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].type === 'softbreak') {
      runs[i] = { ...runs[i], type: 'hardbreak', newline: true };
    }
    if (runs[i].innerRuns) promoteSoftbreaks(runs[i].innerRuns!);
    if (runs[i].oldRuns) promoteSoftbreaks(runs[i].oldRuns!);
    if (runs[i].newRuns) promoteSoftbreaks(runs[i].newRuns!);
  }
}

interface CriticDisplaySegment {
  run: MdRun;
  displayMath: boolean;
}

interface CriticParagraphSplit {
  parts: MdRun[][];
  /** marks[k] is the revision containing the break after parts[k], if any. */
  marks: Array<MdRun | undefined>;
}

/** A substitution whose old or new text has a paragraph break, as the deletion
 *  and addition it exports to anyway, so each side can split at the break. */
function splitSubstitution(run: MdRun): MdRun[] | undefined {
  if (run.type !== 'critic_sub') return undefined;
  const hasBreak = (runs: MdRun[] | undefined) => !!runs && !!splitRunsAtCriticParagraphs(runs);
  if (!hasBreak(run.oldRuns) && !hasBreak(run.newRuns)) return undefined;
  const side = { oldRuns: undefined, newRuns: undefined, newText: undefined };
  const sides: MdRun[] = [{ ...run, ...side, type: 'critic_del', innerRuns: run.oldRuns }];
  if (run.newText) sides.push({ ...run, ...side, type: 'critic_add', text: run.newText, innerRuns: run.newRuns });
  return sides;
}

/** Split parsed runs so inline formatting and nested revisions survive each boundary. */
function splitRunsAtCriticParagraphs(runs: MdRun[]): CriticParagraphSplit | undefined {
  const parts: MdRun[][] = [[]];
  const marks: Array<MdRun | undefined> = [];
  let found = false;
  const queue = [...runs];
  for (let index = 0; index < queue.length; index++) {
    const run = queue[index];
    if (run.criticParagraphBreak) {
      found = true;
      parts.push([]);
      marks.push(undefined);
      index++; // the second softbreak belongs to the same blank line
      continue;
    }
    const sides = splitSubstitution(run);
    if (sides) {
      // eslint-disable-next-line no-restricted-syntax -- a substitution's two sides at most
      queue.splice(index, 1, ...sides);
      index--;
      continue;
    }
    let split: CriticParagraphSplit | undefined;
    if (run.innerRuns && (run.type === 'critic_add' || run.type === 'critic_del')) {
      const inner = splitRunsAtCriticParagraphs(run.innerRuns);
      if (inner) {
        split = {
          parts: inner.parts.map(part => {
            const innerRuns = trimBreakRuns(part, true);
            return innerRuns.length > 0
              ? [{ ...run, text: innerRuns.map(innerRun => innerRun.text).join(''), innerRuns }]
              : [];
          }),
          // A break directly inside this revision is tracked by it
          marks: inner.marks.map(mark => mark ?? run),
        };
      }
    }
    // A comment's anchor whose text ends in tracked breaks, as import writes
    // a comment that ends where one does, {=={--b\n\n--}==}{>>c<<}: the anchor
    // and its comment, with their replies, keep the text before them, and
    // its line breaks, which are Word's
    if (!split && run.type === 'critic_highlight' && run.innerRuns && queue[index + 1]?.type === 'critic_comment') {
      const inner = splitRunsAtCriticParagraphs(run.innerRuns);
      if (inner && inner.marks.every(mark => mark !== undefined) && inner.parts.slice(1).every(part => trimBreakRuns(part).length === 0)) {
        const comments: MdRun[] = [];
        while (queue[index + 1]?.type === 'critic_comment') comments.push(queue[++index]);
        const innerRuns = trimBreakRuns(inner.parts[0], true);
        split = {
          parts: [[...(innerRuns.length > 0 ? [{ ...run, text: innerRuns.map(innerRun => innerRun.text).join(''), innerRuns }] : []), ...comments],
            ...inner.parts.slice(1).map(() => [])],
          marks: inner.marks,
        };
      }
    }
    if (!split) {
      parts[parts.length - 1].push(run);
      continue;
    }
    found = true;
    pushAll(parts[parts.length - 1], split.parts[0]);
    pushAll(parts, split.parts.slice(1));
    pushAll(marks, split.marks);
  }
  return found ? { parts, marks } : undefined;
}

/** Keep list indentation while limiting heading styles and alert labels to the first segment. */
function criticBlockSegment(token: MdToken, runs: MdRun[], index: number): MdToken {
  if (token.type === 'list_item' && index > 0) {
    return {
      ...token, type: 'paragraph', runs,
      listContinuation: { type: token.ordered ? 'ordered' : 'bullet', level: token.level ?? 1 },
      ordered: undefined, startNumber: undefined, listStart: undefined, bulletMarker: undefined, taskChecked: undefined,
    };
  }
  if (token.type === 'heading' && index > 0) {
    return { ...token, type: 'paragraph', runs, level: undefined, criticParaMark: undefined };
  }
  return {
    ...token, runs,
    // Only the first paragraph in a split alert emits its title, and only
    // the first in a split quote starts it.
    ...(token.type === 'blockquote' && index > 0 ? { alertLead: undefined, quoteStart: undefined } : {}),
  };
}

/** Restore block boundaries inside additions and deletions, preserving wholly
 *  empty revisions. A break inside a revision tracks the paragraph mark of the
 *  block before it, so Word's Accept All and Reject All join the blocks again. */
function splitCriticParagraphs(tokens: MdToken[]): MdToken[] {
  return tokens.flatMap(token => {
    if (!['paragraph', 'heading', 'list_item', 'blockquote'].includes(token.type)) return [token];
    const split = splitRunsAtCriticParagraphs(token.runs);
    if (!split) return [token];
    const segments: MdToken[] = [];
    // Whether a revision holds paragraph breaks alone (see below), found
    // once for each, as it can hold many empty paragraphs
    const breaksAlone = new Map<MdRun, boolean>();
    const holdsBreaksAlone = (mark: MdRun) => {
      let alone = breaksAlone.get(mark);
      if (alone === undefined) {
        // Spaces, tabs and line ends in its Markdown, as Markdown's
        // whitespace, but not a no-break space, as of &nbsp;, nor a space
        // of code or of a reference, as ` ` or &#32;, which are text
        alone = /^[ \t\r\n]*$/.test(mark.text);
        breaksAlone.set(mark, alone);
      }
      return alone;
    };
    split.parts.forEach((runs, k) => {
      if (runs.length === 0) {
        // An empty paragraph between a deleted and an inserted mark, as in
        // {~~a\n\n~>\n\nc~~}, leaves one break whether the changes are
        // accepted or rejected, so the mark before it isn't tracked
        const previous = segments[segments.length - 1];
        const mark = split.marks[k];
        if (previous?.criticParaMark && mark && k < split.parts.length - 1
          && previous.criticParaMark !== (mark.type === 'critic_add' ? 'addition' : 'deletion')) {
          segments[segments.length - 1] = { ...previous, criticParaMark: undefined, criticParaMarkRun: undefined };
          return;
        }
        // Else an empty paragraph whose break a revision of breaks alone
        // tracks, as in a\n\n{++\n\n++}b, which import writes for one
        // whose mark is tracked, keeps it, but not a heading. One at the
        // edge of a revision with text, {++\n\nfirst++}, is none, nor one
        // with a line break, of <br> or of a \ at a line's end, as text.
        const segment = criticBlockSegment(token, runs, segments.length);
        if (mark && k < split.parts.length - 1 && segment.type !== 'heading' && holdsBreaksAlone(mark)) {
          segments.push({ ...segment, criticParaMark: mark.type === 'critic_add' ? 'addition' : 'deletion', criticParaMarkRun: mark });
        }
        return;
      }
      const segment = criticBlockSegment(token, runs, segments.length);
      // The last part ends where the block does, so it keeps the block's own
      // mark
      if (k === split.parts.length - 1) {
        segments.push(segment);
        return;
      }
      // A break in a revision tracks a heading's mark too, which import
      // writes as the break after its text, # a{++\n\n++}b, where the
      // text isn't all in the revision. One that is, {++# a++}, keeps its
      // own mark at a break in none (see promoteCriticHeadingParagraph)
      const mark = split.marks[k];
      if (!mark && segment.type === 'heading') {
        segments.push(segment);
        return;
      }
      segments.push({
        ...segment,
        criticParaMark: mark ? (mark.type === 'critic_add' ? 'addition' : 'deletion') : undefined,
        criticParaMarkRun: mark,
      });
    });
    return segments.length > 0 ? segments.map(segment => splitPart(segment, segments.length)) : [token];
  });
}

/** `segment`, one of `parts` blocks a block of the Markdown was split into,
 *  marked as a part where there's more than one. Each keeps the block's
 *  lines, which it shares with the others, so none of them is alone on its
 *  lines, as a comment's spacing reads one (see parseMd). A quote's group
 *  holds all the parts of its paragraph, whose lines are the group's (see
 *  annotateBlockquoteSpacing) */
function splitPart(segment: MdToken, parts: number): MdToken {
  return parts > 1 ? { ...segment, splitPart: true } : segment;
}

interface DisplayRunSegment {
  runs: MdRun[];
  displayMath: boolean;
}

/** Treat both explicit and soft line breaks as removable padding at a generated block boundary. */
export function isBreakRun(run: MdRun): boolean {
  return run.type === 'softbreak' || run.type === 'hardbreak';
}

/** Remove edge breaks where the surrounding Word paragraph already supplies
 *  separation: soft ones alone (`soft`), as at a paragraph break in a
 *  CriticMarkup span, where a hard one is Word's, as import writes a line
 *  break at a paragraph's start or end there. */
function trimBreakRuns(runs: MdRun[], soft = false): MdRun[] {
  const trimmed = (run: MdRun) => soft ? run.type === 'softbreak' : isBreakRun(run);
  let start = 0;
  let end = runs.length;
  while (start < end && trimmed(runs[start])) start++;
  while (end > start && trimmed(runs[end - 1])) end--;
  return runs.slice(start, end);
}

/** Separate display equations from adjacent prose and discard line breaks at the new block edges. */
function splitRunsAtDisplayMath(runs: MdRun[] | undefined): DisplayRunSegment[] | undefined {
  if (!runs?.some(run => run.type === 'math' && run.display)) return undefined;
  const segments: DisplayRunSegment[] = [];
  let start = 0;
  for (let i = 0; i < runs.length; i++) {
    const inner = runs[i];
    if (inner.type !== 'math' || !inner.display) continue;

    const before = trimBreakRuns(runs.slice(start, i));
    if (before.length > 0) {
      segments.push({ runs: before, displayMath: false });
    }
    segments.push({ runs: [inner], displayMath: true });
    start = i + 1;
  }

  const after = trimBreakRuns(runs.slice(start));
  if (after.length > 0) {
    segments.push({ runs: after, displayMath: false });
  }
  return segments;
}

/**
 * Split a visible CriticMarkup run around display equations. A display
 * equation cannot share a Word paragraph with prose on either side.
 */
function splitCriticRunAtDisplayMath(run: MdRun): CriticDisplaySegment[] | undefined {
  if (run.type === 'critic_add' || run.type === 'critic_del' || run.type === 'critic_highlight') {
    const segments = splitRunsAtDisplayMath(run.innerRuns);
    return segments?.map(segment => ({
      run: { ...run, innerRuns: segment.runs },
      displayMath: segment.displayMath,
    }));
  }

  if (run.type !== 'critic_sub') return undefined;
  const oldSegments = splitRunsAtDisplayMath(run.oldRuns);
  const newSegments = splitRunsAtDisplayMath(run.newRuns);
  if (!oldSegments && !newSegments) return undefined;

  const oldParts = oldSegments ?? [{ runs: run.oldRuns ?? [], displayMath: false }];
  const newParts = newSegments ?? [{ runs: run.newRuns ?? [], displayMath: false }];
  const shapesAlign = oldParts.length === newParts.length &&
    oldParts.every((part, index) => part.displayMath === newParts[index].displayMath);
  if (shapesAlign) {
    return oldParts.map((oldPart, index) => ({
      run: { ...run, text: '', newText: '', oldRuns: oldPart.runs, newRuns: newParts[index].runs },
      displayMath: oldPart.displayMath,
    }));
  }

  // When paragraph shapes differ, preserve the substitution's semantic order:
  // all deleted content precedes all inserted content. Pairing mismatched
  // display/prose segments can otherwise move new content ahead of old text.
  return [
    ...oldParts.map(part => ({
      run: { ...run, text: '', newText: '', oldRuns: part.runs, newRuns: [] },
      displayMath: part.displayMath,
    })),
    ...newParts.map(part => ({
      run: { ...run, text: '', newText: '', oldRuns: [], newRuns: part.runs },
      displayMath: part.displayMath,
    })),
  ];
}

/** Whether a CriticMarkup span's source holds a blank line, a paragraph break */
function holdsBlankLine(text: string | undefined): boolean {
  return !!text && /\n[ \t]*\n/.test(text);
}

/** Give revised display equations their own Word paragraphs while retaining
 *  block context, where their span holds text too or a paragraph break, or
 *  they're in a heading */
function splitCriticDisplayMathParagraphs(tokens: MdToken[]): MdToken[] {
  const output: MdToken[] = [];
  for (const token of tokens) {
    if (token.type !== 'paragraph' && token.type !== 'heading' && token.type !== 'list_item' && token.type !== 'blockquote') {
      output.push(token);
      continue;
    }

    const splitRuns: MdRun[][] = [];
    let currentRuns: MdRun[] = [];
    const flushCurrent = () => {
      if (currentRuns.length > 0) splitRuns.push(currentRuns);
      currentRuns = [];
    };

    let foundDisplayMath = false;
    for (let r = 0; r < token.runs.length; r++) {
      const run = token.runs[r];
      const segments = splitCriticRunAtDisplayMath(run);
      // A revision's or a highlight's span of display math alone stays in
      // its paragraph, list item or quote, with text around it, as an
      // equation in none does, as import writes it there. Not in a heading,
      // which can't go on past its line, so import writes it after it. Nor
      // where the span's source holds a blank line, a paragraph break
      // segments leave out, which the equations go on either side of
      if (!segments || token.type !== 'heading' && !holdsBlankLine(run.text) && !holdsBlankLine(run.newText)
        && segments.every(segment => segment.displayMath)) {
        currentRuns.push(run);
        continue;
      }

      foundDisplayMath = true;
      for (const segment of segments) {
        if (segment.displayMath) {
          flushCurrent();
          splitRuns.push([segment.run]);
        } else {
          currentRuns.push(segment.run);
        }
      }
      // A highlight's comment, and the replies after it, in the paragraph
      // of the equation the highlight ends with, so its range goes around
      // the equation, as Word puts one. In a paragraph of its own, its range
      // held nothing, and import wrote it after the equation, unattached
      if (run.type === 'critic_highlight' && segments[segments.length - 1].displayMath) {
        while (token.runs[r + 1]?.type === 'critic_comment') splitRuns[splitRuns.length - 1].push(token.runs[++r]);
      }
    }
    flushCurrent();

    if (!foundDisplayMath || splitRuns.length === 0) {
      output.push(token);
      continue;
    }
    for (let index = 0; index < splitRuns.length; index++) {
      output.push(splitPart(criticBlockSegment(token, splitRuns[index], index), splitRuns.length));
    }
  }
  return output;
}

/** Parse Markdown into Word blocks, restoring protected revision boundaries before formatting. */
/** The link definitions each parseMd result was parsed with, for a note body to share. */
export const linkDefinitionsOf = new WeakMap<MdToken[], Record<string, unknown>>();

/**
 * Whether a top-level list item starts a list of its own, as import reads
 * it: after one of the other kind, or as the first item of an ordered list.
 */
export function startsAdjacentList(item: MdToken, prevTopOrdered: boolean | undefined): boolean {
  return (item.level ?? 1) === 1 && prevTopOrdered !== undefined
    && (!!item.ordered !== prevTopOrdered || (!!item.ordered && !!item.listStart));
}

/** Marks each HTML block in `tokens` that a bare LaTeX environment in
 *  `text` was wrapped in as display math (`meta.wrappedLatex`), which the
 *  block's text can't tell from dollar signs the Markdown has: by the lines
 *  of `text` wrapped with a mark at the start of each, which are the parsed
 *  text's (`lineCount` of them), or else by any line that starts as one */
function markWrappedLatexBlocks(tokens: Token[], text: string, lineCount: number, containers: ContainerOptions): void {
  let code = 0xF8FF;
  while (text.includes(String.fromCharCode(code))) code--;
  const mark = String.fromCharCode(code);
  const lines = preprocessCriticMarkup(wrapBareLatexEnvironments(text, mark, containers)).split('\n');
  for (const token of tokens) {
    if (token.type !== 'html_block' || !token.map) continue;
    const wraps = lines.length === lineCount ? lines.slice(token.map[0], token.map[1]).some(line => line.includes(mark))
      : [...token.content.matchAll(/^[ ]{0,3}\$\$\\begin\{([a-zA-Z*]+)\}/gm)].some(match => DISPLAY_MATH_ENVIRONMENTS.has(match[1]));
    if (wraps) token.meta = { ...token.meta, wrappedLatex: true };
  }
}

/**
 * `source` is the Markdown `markdown` was made from, `text`, where it was,
 * and its `lines`, for each line of `markdown`, and one past its last, the
 * line of `text` it comes from, as markdown-it ends lines (see
 * line-map.ts), from which quote spacing reads the blank lines around each
 * quote (see annotateBlockquoteSpacing). Without it, `markdown` is its own.
 * Its `written` text, where export closed a section left open at its end
 * (see closingFenceAtEnd), is the one the warnings of directives read.
 * `linkDefinitions` are the document's, which a note body parsed on its own
 * resolves its reference links and images with, after its own definitions.
 */
export function parseMd(markdown: string, warnings?: string[], breaks = false, source?: { text: string; lines: LineMap; written?: string }, linkDefinitions?: Record<string, unknown>, unformatted?: string, inNote = false, bodyStartLine = 0): MdToken[] {
  // Each line end as markdown-it reads it, a \r alone too, so the steps
  // before it, and the lines quotes' and comments' spacing reads, split
  // lines where its token maps do (see newlines.ts): the source's, where
  // there is one, whose lines the map counts so (see line-map.ts)
  if (source) source = { ...source, text: normalizeNewlines(source.text) };
  else {
    markdown = normalizeNewlines(markdown);
    if (unformatted !== undefined) unformatted = normalizeNewlines(unformatted);
  }
  const md = createMarkdownIt();
  // Grid tables, quotes without lazy continuation, and bare LaTeX
  // environments, as the orientation scan reads them too
  const blocks = preprocessBlocks(markdown, inNote);
  const { deLazified, output: wrapped } = blocks;
  const critic = preprocessCriticMarkupWithLines(wrapped);
  const processed = critic.output;
  const env: { references?: Record<string, unknown>; documentLinkDefinitions?: Record<string, unknown> } =
    linkDefinitions ? { documentLinkDefinitions: linkDefinitions } : {};
  const tokens = md.parse(processed, env);
  if (wrapped !== deLazified) markWrappedLatexBlocks(tokens, deLazified, processed.split('\n').length, blocks.containers);

  const processedLines = processed.split('\n');
  // Number formatting can widen a table's cells past their padding, so
  // whether a table's columns line up reads its lines from before it,
  // `unformatted`, which differ from these in cell text alone
  const unformattedLines = unformatted === undefined ? undefined
    : preprocessCriticMarkup(preprocessBlocks(unformatted, inNote).output).split('\n');
  const sourceLines = unformattedLines?.length === processedLines.length ? unformattedLines : processedLines;
  const result = splitCriticParagraphs(splitCriticDisplayMathParagraphs(convertTokens(tokens, 0, 0, warnings, sourceLines)));
  annotateBlockquoteBoundaries(result);
  // For each line markdown-it read, the line of the source it comes from,
  // the source's where there is one, and the source's lines, which quotes'
  // and comments' spacing reads the blank lines around them in
  const markdownLines = throughLines(critic.lines, withEnd(blocks.lines, markdown.split('\n').length));
  const toSource = source ? throughLines(markdownLines, source.lines) : markdownLines;
  const spacingLines = (source?.text ?? markdown).split('\n');
  annotateBlockquoteSpacing(result, toSource, spacingLines, processedLines);

  // When breaks mode is enabled, treat all bare newlines as hard breaks
  if (breaks) {
    for (const tok of result) {
      promoteSoftbreaks(tok.runs);
      if (tok.rows) {
        for (const row of tok.rows) {
          for (const cell of row.cells) {
            promoteSoftbreaks(cell.runs);
          }
        }
      }
    }
  }

  // Post-process: recompute HTML comment blankLinesBefore/After from the
  // source's lines.  preprocessGridTables inserts blank lines around
  // grid-table placeholders which inflates the gaps computed from markdown-it
  // token maps.  Using the source gives correct values. Each comment's
  // lines there are where preprocessing says its lines in the parsed text
  // come from (see line-map.ts), and not where a search for its text found
  // it first, as in a code block that held the same line
  {
    const sourceLine = (line: number) => toSource[Math.min(line, toSource.length - 1)];
    const dropped = droppedBlocksOf(result, sourceLine);
    for (const tok of result) {
      const withIds = isCommentsWithIds(tok);
      if (!withIds && (tok.type !== 'paragraph' || tok.runs.length !== 1 || tok.runs[0].type !== 'html_comment')) continue;
      // Nor one split from a block, as from a revised equation on its line,
      // whose lines are the block's (see splitPart)
      if (!tok.sourceRange || tok.splitPart) continue;
      const commentLine = sourceLine(tok.sourceRange[0]);
      const commentEndLine = Math.min(sourceLine(tok.sourceRange[1]), spacingLines.length) - 1;
      // A comment that holds no character of the source's, whose lines
      // preprocessing wrote (see line-map.ts)
      if (commentEndLine < commentLine) continue;
      // Count blank lines before: scan backwards from commentLine, to the
      // body's start (see bodyStartLine), past the blocks list items
      // dropped, so that the blank lines on either side of one are the
      // comment's
      const beforeCount = blankLinesPastDropped(spacingLines, dropped, commentLine - 1, -1, bodyStartLine);
      // Count blank lines after: scan forward from end of comment
      let afterCount = 0;
      for (let li = commentEndLine + 1; li < spacingLines.length; li++) {
        if (spacingLines[li].trim() === '') afterCount++;
        else break;
      }
      // Ignore a single trailing empty-string element produced by splitting a
      // string that ends with '\n' — it is not a real blank line.
      if (afterCount > 0 && commentEndLine + afterCount === spacingLines.length - 1 && spacingLines[spacingLines.length - 1] === '') {
        afterCount--;
      }
      tok.blankLinesBefore = beforeCount;
      tok.blankLinesAfter = afterCount;
    }
  }

  // Post-process: transfer table-font directives from HTML comment tokens to table tokens
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].type !== 'paragraph' || result[i].runs.length !== 1) continue;
    const run = result[i].runs[0];
    if (run.type !== 'html_comment') continue;
    const text = run.text.trim();
    const fontSizeMatch = text.match(TABLE_FONT_SIZE_RE);
    const fontMatch = text.match(TABLE_FONT_RE);
    if (!fontSizeMatch && !fontMatch) continue;
    // Look for the next table token, skipping intervening HTML comment paragraphs.
    // Note: sentinel comments (landscape/portrait/references/bibliography) are still
    // plain HTML comment paragraphs at this point — sentinel post-processing runs later,
    // so the directive is safely consumed before sentinel conversion.
    let target = i + 1;
    while (target < result.length && result[target].type === 'paragraph'
        && result[target].runs.length === 1 && result[target].runs[0].type === 'html_comment') {
      target++;
    }
    if (target < result.length && result[target].type === 'table') {
      let consumed = false;
      if (fontSizeMatch) {
        const n = parseFloat(fontSizeMatch[1]);
        if (isFinite(n) && n > 0) {
          if (result[target].tableFontSize === undefined) result[target].tableFontSize = n;
          consumed = true;
        } else {
          if (warnings) warnings.push('Invalid <!-- table-font-size: ' + fontSizeMatch[1] + ' --> directive ignored.');
        }
      }
      if (fontMatch) {
        const fontVal = fontMatch[1].trim();
        if (fontVal) {
          if (result[target].tableFont === undefined) result[target].tableFont = fontVal;
          consumed = true;
        }
      }
      if (consumed) result.splice(i, 1);
    }
  }

  // Post-process: transfer table-orientation directive from HTML comments to table tokens
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].type !== 'paragraph' || result[i].runs.length !== 1) continue;
    const run = result[i].runs[0];
    if (run.type !== 'html_comment') continue;
    const text = run.text.trim();
    const orientMatch = text.match(TABLE_ORIENTATION_RE);
    if (!orientMatch) continue;
    // Forward scan: skip HTML comment paragraphs to find the table token.
    // Sentinel post-processing has not yet run, so sentinels are still plain
    // HTML comments and the directive is consumed before they are converted.
    let target = i + 1;
    while (target < result.length && result[target].type === 'paragraph'
        && result[target].runs.length === 1 && result[target].runs[0].type === 'html_comment') {
      target++;
    }
    if (target < result.length && result[target].type === 'table') {
      if (result[target].tableOrientation === undefined) {
        result[target].tableOrientation = orientMatch[1].toLowerCase() as 'landscape' | 'portrait';
      }
      result.splice(i, 1);
    }
  }

  // Post-process: transfer table-col-widths directive from HTML comments to table tokens
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].type !== 'paragraph' || result[i].runs.length !== 1) continue;
    const run = result[i].runs[0];
    if (run.type !== 'html_comment') continue;
    const text = run.text.trim();
    const cwMatch = text.match(TABLE_COL_WIDTHS_RE);
    if (!cwMatch) continue;
    // Forward scan: skip HTML comment paragraphs to find the table token.
    // Sentinel post-processing has not yet run, so sentinels are still plain
    // HTML comments and the directive is consumed before they are converted.
    let target = i + 1;
    while (target < result.length && result[target].type === 'paragraph'
        && result[target].runs.length === 1 && result[target].runs[0].type === 'html_comment') {
      target++;
    }
    if (target < result.length && result[target].type === 'table') {
      const parsed = parseColWidths(cwMatch[1]);
      if (parsed) {
        if (result[target].tableColWidths === undefined) result[target].tableColWidths = parsed;
        result.splice(i, 1);
      } else {
        if (warnings) warnings.push('Invalid <!-- table-col-widths: ' + cwMatch[1] + ' --> directive ignored.');
      }
    }
  }

  // Transfer numeric-format directives independently so explicit `source`
  // values can cancel document-level defaults and survive DOCX round trips.
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].type !== 'paragraph' || result[i].runs.length !== 1 || result[i].runs[0].type !== 'html_comment') continue;
    const text = result[i].runs[0].text.trim();
    const match = text.match(TABLE_NUMBER_FORMAT_RE);
    if (!match) continue;
    let target = i + 1;
    while (target < result.length && result[target].type === 'paragraph'
        && result[target].runs.length === 1 && result[target].runs[0].type === 'html_comment') target++;
    if (target >= result.length || result[target].type !== 'table') continue;
    const key = match[1].toLowerCase();
    const raw = match[2];
    let valid = false;
    if (key === 'digits') {
      const value = parseTableDigits(raw);
      if (value !== undefined) { if (result[target].tableDigits === undefined) result[target].tableDigits = value; valid = true; }
    } else if (key === 'decimal-mark') {
      const value = parseTableDecimalMark(raw);
      if (value !== undefined) { if (result[target].tableDecimalMark === undefined) result[target].tableDecimalMark = value; valid = true; }
    } else {
      const value = parseTableDigitGrouping(raw);
      if (value !== undefined) { if (result[target].tableDigitGrouping === undefined) result[target].tableDigitGrouping = value; valid = true; }
    }
    if (valid) result.splice(i, 1);
    else if (warnings) warnings.push('Invalid ' + text + ' directive ignored.');
  }

  // Pre-scan: warn on unclosed/orphaned/nested/crossed orientation directives with line numbers.
  // When the source is given (from convertMdToDocx), scan that so line numbers match the
  // user's file rather than the stripped body passed to parseMd. Not in a note's body, whose
  // directives the document's scan reads as the note's, which pair with none, and whose
  // lines it counted from the note's start.
  if (warnings && !inNote) {
    const scanText = source?.written ?? source?.text ?? markdown;
    const findings = scanOrientationDirectives(scanText);
    if (findings.length > 0) {
      let lineEnds: number[] | undefined;
      const lineNumAt = (offset: number): number => {
        if (!lineEnds) {
          lineEnds = [];
          for (let i = scanText.indexOf('\n'); i !== -1; i = scanText.indexOf('\n', i + 1)) lineEnds.push(i);
        }
        let lo = 0;
        let hi = lineEnds.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (lineEnds[mid] < offset) lo = mid + 1;
          else hi = mid;
        }
        return lo + 1; // 1-based
      };
      for (const f of findings) {
        const line = lineNumAt(f.start);
        switch (f.kind) {
          case 'nested':
            warnings.push('Nested <!-- ' + f.directiveName + ' --> near line ' + line + ' (<!-- ' + (f.relatedName ?? f.directiveName) + ' --> opened near line ' + lineNumAt(f.relatedStart!) + ' is still active).');
            break;
          case 'crossed':
            warnings.push('<!-- /' + f.directiveName + ' --> near line ' + line + ' does not match the active <!-- ' + f.relatedName + ' --> section (opened near line ' + lineNumAt(f.relatedStart!) + ').');
            break;
          case 'orphaned':
            warnings.push('Orphaned <!-- /' + f.directiveName + ' --> near line ' + line + ' \u2014 no preceding <!-- ' + f.directiveName + ' --> found.');
            break;
          case 'unclosed':
            warnings.push('Unclosed <!-- ' + f.directiveName + ' --> (opened near line ' + line + ') \u2014 no matching <!-- /' + f.directiveName + ' --> found.');
            break;
          // A list item's, which extractListItems drops, and a note's, which
          // the note's body ignores, each with a warning of its own
          case 'list-item':
          case 'note':
            break;
        }
      }
    }
  }

  // Post-process: convert <!-- landscape/portrait --> fences into sentinel tokens.
  // A single pass with shared state ensures cross-type nesting (e.g. portrait inside
  // an active landscape section) gracefully closes the previous orientation before
  // opening the new one, rather than emitting overlapping section breaks.
  //
  // NOTE: This pass handles graceful recovery independently from the diagnostic scanner
  // in orientation-scan.ts. The scanner keeps the original opener on its stack for
  // accurate diagnostics; this pass tracks activeOrientation for correct sentinel
  // generation. The two do not need to agree on stack state.
  {
    let activeOrientation: 'landscape' | 'portrait' | null = null;
    for (let i = 0; i < result.length; i++) {
      if (result[i].type !== 'paragraph' || result[i].runs.length !== 1) continue;
      const run = result[i].runs[0];
      if (run.type !== 'html_comment') continue;
      const text = run.text.trim();

      const openMatch = ORIENTATION_OPEN_RE.exec(text);
      if (openMatch) {
        const orientation = openMatch[1].toLowerCase() as 'landscape' | 'portrait';
        const src = result[i];
        if (activeOrientation) {
          // Any new open replaces the currently active orientation.
          const closeKey = activeOrientation === 'landscape' ? 'landscapeClose' : 'portraitClose';
          const openKey = orientation === 'landscape' ? 'landscapeOpen' : 'portraitOpen';
          const closeSentinel: MdToken = { type: 'paragraph', runs: [], [closeKey]: true };
          // Import writes a closing fence here, with the comment's blank
          // lines before it, then this opener, with the comment's blank lines
          // after each. The opener has none of its own before it, so import
          // writes the closing fence's there
          const openSentinel: MdToken = { type: 'paragraph', runs: [], [openKey]: true };
          closeSentinel.blankLinesBefore = src.blankLinesBefore;
          closeSentinel.blankLinesAfter = src.blankLinesAfter;
          openSentinel.blankLinesAfter = src.blankLinesAfter;
          result.splice(i, 1, closeSentinel, openSentinel);
          i++; // skip past both sentinels
          activeOrientation = orientation;
        } else {
          const openKey = orientation === 'landscape' ? 'landscapeOpen' : 'portraitOpen';
          const sentinel: MdToken = { type: 'paragraph', runs: [], [openKey]: true };
          sentinel.blankLinesBefore = src.blankLinesBefore;
          sentinel.blankLinesAfter = src.blankLinesAfter;
          result.splice(i, 1, sentinel);
          activeOrientation = orientation;
        }
        continue;
      }

      const closeMatch = ORIENTATION_CLOSE_RE.exec(text);
      if (closeMatch) {
        const orientation = closeMatch[1].toLowerCase() as 'landscape' | 'portrait';
        if (activeOrientation === orientation) {
          const closeKey = orientation === 'landscape' ? 'landscapeClose' : 'portraitClose';
          const sentinel: MdToken = { type: 'paragraph', runs: [], [closeKey]: true };
          sentinel.blankLinesBefore = result[i].blankLinesBefore;
          sentinel.blankLinesAfter = result[i].blankLinesAfter;
          result.splice(i, 1, sentinel);
          activeOrientation = null;
        } else if (activeOrientation) {
          // Cross-type close (e.g. /portrait while landscape active): close the active
          // orientation. The directive name doesn't match, but we close what's actually
          // open to avoid leaving a dangling section break in the DOCX output.
          const closeKey = activeOrientation === 'landscape' ? 'landscapeClose' : 'portraitClose';
          const sentinel: MdToken = { type: 'paragraph', runs: [], [closeKey]: true };
          sentinel.blankLinesBefore = result[i].blankLinesBefore;
          sentinel.blankLinesAfter = result[i].blankLinesAfter;
          result.splice(i, 1, sentinel);
          activeOrientation = null;
        }
        // If no active orientation, leave the comment as-is (user error, but harmless)
      }
    }
    // A section still open at the document's end ends there, so it has its
    // own page, not the template's, and import fences it. Export closes
    // one in the source where it can (see closingFenceAtEnd), so this is
    // one it couldn't, where the document ends in code or an HTML comment
    // with no end, which would hold that fence, or has a comment's start
    // with no end, which the fence would end: the section ends after its
    // last block. Not in a note, which has no sections
    if (activeOrientation && !inNote) {
      result.push({ type: 'paragraph', runs: [], [activeOrientation === 'landscape' ? 'landscapeClose' : 'portraitClose']: true, blankLinesBefore: 1 });
    }
  }

  // Post-process: convert <!-- references --> / <!-- bibliography --> into a bibliography marker sentinel
  {
    let markerCount = 0;
    for (let i = 0; i < result.length; i++) {
      if (result[i].type !== 'paragraph' || result[i].runs.length !== 1) continue;
      const run = result[i].runs[0];
      if (run.type !== 'html_comment') continue;
      if (!REFERENCES_RE.test(run.text.trim())) continue;
      if (markerCount === 0) {
        // With the blank lines around its comment, which the sentinel gaps
        // record, as a fence's
        const marker: MdToken = { type: 'paragraph', runs: [], bibliographyMarker: true };
        marker.blankLinesBefore = result[i].blankLinesBefore;
        marker.blankLinesAfter = result[i].blankLinesAfter;
        result.splice(i, 1, marker);
      } else {
        if (warnings) warnings.push('Multiple <!-- references --> markers found; only the first is used.');
        result.splice(i, 1);
        i--;
      }
      markerCount++;
    }
  }

  // Post-process: transfer <!-- indent --> / <!-- no-indent --> directives
  // to the next paragraph token. From the end, with what the scan for each
  // directive's paragraph would read again for each (`scan`), and the
  // directives that go (`dropped`), which go from the tokens at the end,
  // as a splice for each took time for each token after it
  const dropped = new Set<MdToken>();
  // The first token after the one at i that a directive's scan stops at,
  // and how many tokens before it stay, but for a style block's fences
  const scan = { stop: result.length, kept: 0 };
  // The items the last directive before a list item gave its override to,
  // from its item to the end of its list block, which a directive before
  // an item of that block gives none, as each already has one
  let given: { from: number; to: number } | undefined;
  const transfer = (i: number): void => {
    if (result[i].type !== 'paragraph' || result[i].runs.length !== 1) return;
    const run = result[i].runs[0];
    if (run.type !== 'html_comment') return;
    const text = run.text.trim();
    const indentMatch = text.match(INDENT_RE);
    if (!indentMatch) return;
    const override = indentMatch[1].toLowerCase() as 'indent' | 'no-indent';
    // The next paragraph Word shows, which is the one export keeps the
    // override of (see showsInWord), past comments and the like. A style
    // block on one line is its text's, which applyCustomStyleSentinels
    // gives the override to
    const target = scan.stop;
    if (target < result.length && result[target].type === 'paragraph' && result[target].runs.length > 0) {
      if (result[target].indentOverride === undefined) {
        result[target].indentOverride = override;
      }
      dropped.add(result[i]);
    } else if (target < result.length && result[target].type === 'list_item') {
      // Right after a list, which it ends in Markdown, where Word may have
      // one list, as two of bullets make. The blank line before it goes
      // before the item, as import writes it before the directive. Of
      // directives in a row, the last one, closest to the item, holds, which
      // this scan from the end gave the item first. A style block's fences,
      // which Word gets no paragraph for, can go between, on either side
      // (see `scan.kept`)
      let last = i - 1;
      while (last >= 0 && isStyleFenceToken(result[last])) last--;
      const before = result[last];
      if (scan.kept === 0 && before && (before.type === 'list_item' || before.listContinuation)) {
        result[target].listDirective = result[target].indentOverride ?? override;
        const line = result[i].splitPart ? undefined : result[i].sourceRange?.[0];
        if (line !== undefined && line > 0 && /^[ \t]*$/.test(sourceLines[line - 1] ?? 'x')) result[target].blankLineBefore = true;
      }
      // Apply to all consecutive list items in this list block, past the
      // directives that go from between them. The items another directive
      // gave its override to after this one's first item end the block
      // where it ended, as the last item at the top level before each is
      // the same, and each has one
      let prevTopOrdered: boolean | undefined;
      let j = target;
      for (; j < result.length && (result[j].type === 'list_item' || dropped.has(result[j])); j++) {
        if (dropped.has(result[j])) continue;
        if (startsAdjacentList(result[j], prevTopOrdered)) break;
        if (j === given?.from) {
          j = given.to;
          break;
        }
        if ((result[j].level ?? 1) === 1) prevTopOrdered = !!result[j].ordered;
        if (result[j].indentOverride === undefined) {
          result[j].indentOverride = override;
        }
      }
      given = { from: target, to: j };
      dropped.add(result[i]);
    }
  };
  const anyDirective = result.some(token => token.type === 'paragraph' && token.runs.length === 1
    && token.runs[0].type === 'html_comment' && INDENT_RE.test(token.runs[0].text.trim()));
  for (let i = anyDirective ? result.length - 1 : -1; i >= 0; i--) {
    transfer(i);
    if (!dropped.has(result[i])) {
      if (stopsDirectiveScan(result[i], env.references)) {
        scan.stop = i;
        scan.kept = 0;
      } else if (!isStyleFenceToken(result[i])) {
        scan.kept++;
      }
    }
  }
  if (dropped.size > 0) {
    const kept = result.filter(token => !dropped.has(token));
    result.length = kept.length;
    kept.forEach((token, k) => { result[k] = token; });
  }

  applyCustomStyleSentinels(result, warnings, env.references);
  if (!inNote) attachTableCaptions(result, processedLines);
  annotateBlankAlertLeads(result);

  if (env.references) linkDefinitionsOf.set(result, env.references);
  return result;
}

/** Whether `token` is the close applyCustomStyleSentinels puts in where a
 *  style block opens in a list item while one is open at the top level. It
 *  has no fence, and Word gets nothing for it, so each walk over the tokens
 *  that reads where lists and quotes are, as import reads Word's
 *  paragraphs, passes over it as if it weren't there */
export function isImplicitStyleClose(token: MdToken | undefined): boolean {
  return !!token?.closesImplicitly;
}

/** Whether an indent directive's scan for its paragraph stops at `token`:
 *  a paragraph Word shows, or a style block on one line of one, or any
 *  block but a paragraph */
function stopsDirectiveScan(token: MdToken, references?: unknown): boolean {
  if (token.type !== 'paragraph' || token.runs.length === 0) return true;
  const inline = inlineStyleBlock(token, references);
  return inline ? showsInWord(inline.content) : showsInWord(token);
}

// Each comment paragraph's style block on one line, or null, which the
// scan for indent directives' paragraphs and applyCustomStyleSentinels
// both read, parsed once
const inlineStyleBlocks = new WeakMap<MdToken, { style: string; content: MdToken } | null>();

/** Where `token` is a style block on one line, a comment alone in its
 *  paragraph, as <!-- style: X -->content<!-- /style -->: its style, and
 *  the paragraph of its content, parsed again to recover inline formatting
 *  (bold, italic, links, etc.), with the document's link definitions
 *  (`references`) for reference links */
function inlineStyleBlock(token: MdToken, references?: unknown): { style: string; content: MdToken } | undefined {
  if (token.type !== 'paragraph' || token.runs.length !== 1 || token.runs[0].type !== 'html_comment') return undefined;
  const known = inlineStyleBlocks.get(token);
  if (known !== undefined) return known ?? undefined;
  const fence = styleFence(token.runs[0].text);
  const match = fence?.kind === 'inline' ? fence : undefined;
  const runs = match ? convertInlineTokens(createMarkdownIt().parseInline(match.content, { references })) : [];
  const block = match ? { style: match.style, content: { type: 'paragraph' as const, runs: runs.length > 0 ? runs : [{ type: 'text' as const, text: match.content }] } } : undefined;
  inlineStyleBlocks.set(token, block ?? null);
  return block;
}

/** Whether Word shows anything of paragraph `token`, so it's among the body
 *  paragraphs whose indexes indent overrides keep (see countsForIndent), as
 *  generateDocumentXml counts them, and an indent directive before it is
 *  its (see parseMd): not one of comments, which are hidden, or of comment
 *  bodies only, which Word doesn't get. Export also leaves out one with no
 *  run in Word, as of an image it couldn't read, which it can only tell
 *  once it writes the paragraph */
export function showsInWord(token: MdToken): boolean {
  return token.type === 'paragraph' && countsForIndent(withoutCommentBodyLines(token.runs)) && !isCommentBodyParagraph(token);
}

/** Convert <!-- style: X --> / <!-- /style --> HTML comments into customStyleOpen/customStyleClose sentinel tokens. */
export function applyCustomStyleSentinels(tokens: MdToken[], warnings?: string[], references?: unknown): void {
  let activeStyle: string | undefined;
  // A block that opens in another, `outer`, closes it
  const closeOuter = (outer = activeStyle) => {
    if (outer && warnings) {
      warnings.push('Nested <!-- style: --> directives are not supported; outer style "' + outer + '" closed implicitly.');
    }
  };
  // The tokens, with sentinels for fences, which go back in `tokens` at
  // the end, as a splice for each fence took time for each token after it
  const out: MdToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    // The closing fence of a style block in a list item, which has done
    // its work in the item (see extractListItems)
    if (tokens[i].itemFence !== undefined && tokens[i].itemStyleOpen === undefined) continue;
    // A style block in a list item, whose paragraphs take its style (see
    // itemCustomStyle), closes one open here too, which has no fence of
    // its own there, as one at the top level would end the item, or one
    // open in the item, whose paragraphs after it take its own style
    if (tokens[i].itemStyleOpen !== undefined) {
      closeOuter(activeStyle ?? tokens[i].closesItemStyle);
      if (activeStyle) out.push({ type: 'paragraph', runs: [], customStyleClose: true, closesImplicitly: true });
      activeStyle = undefined;
      continue;
    }
    const run = tokens[i].type === 'paragraph' && tokens[i].runs.length === 1 ? tokens[i].runs[0] : undefined;
    const fence = run?.type === 'html_comment' ? styleFence(run.text) : undefined;

    // Single-line inline style: <!-- style: X -->content<!-- /style -->
    // Its content, parsed once for this and the scan for indent
    // directives' paragraphs (see inlineStyleBlock)
    const inline = fence?.kind === 'inline' ? inlineStyleBlock(tokens[i], references) : undefined;
    if (inline) {
      closeOuter();
      const styleName = inline.style;

      const openSentinel: MdToken = { type: 'paragraph', runs: [], customStyleOpen: styleName };
      openSentinel.blankLinesBefore = tokens[i].blankLinesBefore;
      openSentinel.blankLinesAfter = 0; // inline: no blank line between open sentinel and content

      const contentToken: MdToken = {
        ...inline.content,
        // An indent directive's before the block (see parseMd)
        ...(tokens[i].indentOverride ? { indentOverride: tokens[i].indentOverride } : {}),
      };

      const closeSentinel: MdToken = { type: 'paragraph', runs: [], customStyleClose: true };
      closeSentinel.blankLinesBefore = 0; // inline: no blank line between content and close sentinel
      closeSentinel.blankLinesAfter = tokens[i].blankLinesAfter;

      out.push(openSentinel, contentToken, closeSentinel);
      activeStyle = undefined; // self-contained block, not open
      continue;
    }

    if (fence?.kind === 'open') {
      closeOuter();
      const sentinel: MdToken = { type: 'paragraph', runs: [], customStyleOpen: fence.style };
      sentinel.blankLinesBefore = tokens[i].blankLinesBefore;
      sentinel.blankLinesAfter = tokens[i].blankLinesAfter;
      out.push(sentinel);
      activeStyle = fence.style;
    } else if (fence?.kind === 'close' && activeStyle) {
      const sentinel: MdToken = { type: 'paragraph', runs: [], customStyleClose: true };
      sentinel.blankLinesBefore = tokens[i].blankLinesBefore;
      sentinel.blankLinesAfter = tokens[i].blankLinesAfter;
      out.push(sentinel);
      activeStyle = undefined;
    } else {
      // A closing fence not in a style block stays a comment (user error,
      // but harmless)
      out.push(tokens[i]);
    }
  }
  tokens.length = out.length;
  out.forEach((token, k) => { tokens[k] = token; });
}

/** Whether `run` ends a line of the source, as a line end and a \ before
 *  one do, but not a <br> */
function endsLine(run: MdRun): boolean {
  return run.type === 'softbreak' || run.type === 'hardbreak' && !run.htmlBreak;
}

/**
 * Whether runs[r] can hold a task's box or an alert's marker, as GFM reads
 * one: text without code, formatting or a link, not after an escaped [, that
 * starts the paragraph, after any empty text, or with `afterBreak` a line.
 */
function holdsMarker(runs: MdRun[], r: number, afterBreak = false): boolean {
  const run = runs[r];
  if (run?.type !== 'text' || run.escapedBracket || run.code || run.href || run.bold || run.italic || run.underline
      || run.strikethrough || run.highlight || run.superscript || run.subscript) return false;
  for (let k = r - 1; k >= 0; k--) {
    if (afterBreak && endsLine(runs[k])) return true;
    if (runs[k].type !== 'text' || runs[k].text !== '') return false;
  }
  return true;
}

function stripLeadingAlertMarker(runs: MdRun[]): { alertType?: GfmAlertType; runs: MdRun[] } {
  const firstTextIdx = runs.findIndex(run => run.type === 'text' && run.text.length > 0);
  if (firstTextIdx === -1) return { runs };
  const firstText = runs[firstTextIdx];
  // The marker, with only the whitespace the source holds as it is after it
  const markerLength = firstText.alertMarkerLength ?? firstText.text.length;
  const parsed = holdsMarker(runs, firstTextIdx) ? parseGfmAlertMarker(firstText.text.slice(0, markerLength)) : undefined;
  if (!parsed) return { runs };
  const rest = parsed.rest + firstText.text.slice(markerLength);
  const nextRuns = [...runs];
  if (rest.length > 0) {
    nextRuns[firstTextIdx] = { ...firstText, text: rest, alertMarkerLength: undefined };
  } else {
    nextRuns.splice(firstTextIdx, 1);
  }
  return { alertType: parsed.type, runs: nextRuns };
}

/** Strip leading and trailing softbreak/hardbreak runs from an array. */
function trimSoftbreaks(runs: MdRun[]): MdRun[] {
  let start = 0, end = runs.length;
  while (start < end && (runs[start].type === 'softbreak' || runs[start].type === 'hardbreak')) start++;
  while (end > start && (runs[end - 1].type === 'softbreak' || runs[end - 1].type === 'hardbreak')) end--;
  return start === 0 && end === runs.length ? runs : runs.slice(start, end);
}

function annotateBlockquoteAlert(tokens: MdToken[], level: number): MdToken[] {
  // Pre-pass: split merged paragraphs that contain alert [!TYPE] markers
  // separated by softbreaks (markdown-it merges consecutive > lines without
  // blank lines into one paragraph).
  const expanded: MdToken[] = [];
  for (const token of tokens) {
    // A code block's lines are code, not markers
    if (token.type === 'blockquote' || token.type === 'code_block' || token.runs.length === 0) {
      expanded.push(token);
      continue;
    }
    const markerIndices: number[] = [];
    for (let r = 0; r < token.runs.length; r++) {
      if (holdsMarker(token.runs, r, true) && parseGfmAlertMarker(token.runs[r].text)) {
        markerIndices.push(r);
      }
    }
    // Skip splitting only where the sole marker starts the paragraph, as
    // stripLeadingAlertMarker reads one, not on a line after runs that
    // aren't text, as a highlight's or a comment's, which go before it
    if (markerIndices.length === 0 ||
        (markerIndices.length === 1 && holdsMarker(token.runs, markerIndices[0]))) {
      expanded.push(token);
      continue;
    }
    // Each segment's own lines, from the line breaks before its runs
    const range = token.sourceRange;
    const lineOf = (runIndex: number) => range![0] + token.runs.slice(0, runIndex).filter(endsLine).length;
    const segmentRange = (start: number, end: number) => range
      ? { sourceRange: [lineOf(start), end < token.runs.length ? lineOf(end) : range[1]] as [number, number] }
      : {};
    // Content before the first marker becomes a plain paragraph
    if (markerIndices[0] > 0) {
      const preRuns = trimSoftbreaks(token.runs.slice(0, markerIndices[0]));
      if (preRuns.length > 0) {
        expanded.push({ ...token, ...segmentRange(0, markerIndices[0]), runs: preRuns });
      }
    }
    // Each marker starts a new segment
    for (let m = 0; m < markerIndices.length; m++) {
      const start = markerIndices[m];
      const end = m + 1 < markerIndices.length ? markerIndices[m + 1] : token.runs.length;
      const segRuns = trimSoftbreaks(token.runs.slice(start, end));
      if (segRuns.length > 0) {
        expanded.push({ ...token, ...segmentRange(start, end), runs: segRuns });
      }
    }
  }

  // Find all tokens whose runs start with an alert marker
  interface Hit { idx: number; type: GfmAlertType; runs: MdRun[] }
  const hits: Hit[] = [];
  for (let idx = 0; idx < expanded.length; idx++) {
    if (expanded[idx].type === 'blockquote' || expanded[idx].type === 'code_block' || expanded[idx].runs.length === 0) continue;
    const parsed = stripLeadingAlertMarker(expanded[idx].runs);
    if (parsed.alertType) {
      hits.push({ idx, type: parsed.alertType, runs: parsed.runs });
    }
  }

  if (hits.length === 0) {
    return expanded.map(t => ({ ...t, type: 'blockquote' as const, level: t.type === 'blockquote' ? t.level : level }));
  }

  // Assign each group of tokens (from one marker to the next) its alert type.
  // Tokens before the first marker become a plain blockquote.
  const result: MdToken[] = [];
  for (let idx = 0; idx < expanded.length; idx++) {
    const t = expanded[idx];
    const hit = hits.find(h => h.idx === idx);
    let currentAlert: GfmAlertType | undefined;
    let isLead = false;
    if (hit) {
      currentAlert = hit.type;
      isLead = true;
    } else {
      for (let h = hits.length - 1; h >= 0; h--) {
        if (hits[h].idx < idx) { currentAlert = hits[h].type; break; }
      }
    }
    result.push({
      ...t,
      type: 'blockquote' as const,
      level: t.type === 'blockquote' ? t.level : level,
      ...(currentAlert && t.type !== 'blockquote' ? { alertType: currentAlert } : {}),
      ...(isLead ? { alertLead: true, runs: hit!.runs } : {}),
    });
  }
  return result;
}

/**
 * Promote a paragraph consisting solely of a full-paragraph {++### ...++} or
 * {--### ...--} span whose payload starts with an ATX heading marker into a
 * heading token. The heading carries criticParaMark so the generator emits a
 * paragraph-mark <w:ins>/<w:del> (Word's representation of a wholly
 * inserted/deleted heading paragraph); the converter uses that mark to
 * reconstruct the {++### ...++} form instead of ### {++...++}.
 * Substitutions ({~~...~>...~~}) are not promoted — old and new sides could
 * carry different heading levels, which one Word paragraph cannot express.
 */
function promoteCriticHeadingParagraph(runs: MdRun[]): MdToken | undefined {
  if (runs.length === 0) return undefined;
  const kind = runs[0].type;
  if (kind !== 'critic_add' && kind !== 'critic_del') return undefined;
  // Every run must be the same critic kind with matching author/date, so the
  // whole paragraph is one insertion/deletion (formatted payloads round-trip
  // from Word as several adjacent spans: {++### ++}{++**bold**++}...). A
  // comment, its range markers and body, and a comment's anchor around such
  // spans go between them, as import writes a comment in a revised heading:
  // {--### A --}{>>c<<} or {--### A --}{=={--b--}==}{>>c<<}.
  const inSpan = (r: MdRun): boolean => r.type === kind && r.author === runs[0].author && r.date === runs[0].date
    || r.type === 'critic_comment' || isCommentMarkerRun(r)
    || r.type === 'critic_highlight' && !!r.innerRuns?.length && r.innerRuns.every(inSpan);
  if (!runs.every(inSpan)) return undefined;
  const run = runs[0];
  // A link's text, as [{++# a++}{++ b++}](u), which a [ comes before
  if (!run.text || run.text.includes('\n') || run.href) return undefined;
  const headingPrefix = matchCriticHeadingPrefix(run.text);
  if (!headingPrefix) return undefined;
  const prefix = headingPrefix.prefix;
  const remainder = run.text.slice(prefix.length);
  if (!remainder.trim() && runs.length === 1) return undefined;
  let innerRuns = run.innerRuns;
  if (innerRuns && innerRuns.length > 0) {
    const first = innerRuns[0];
    // The literal marker must sit at the start of the first inner text run;
    // otherwise (unexpected inner structure) leave the paragraph untouched.
    if (first.type !== 'text' || !(first.text || '').startsWith(prefix)) return undefined;
    const strippedText = (first.text || '').slice(prefix.length);
    innerRuns = strippedText
      ? [{ ...first, text: strippedText }, ...innerRuns.slice(1)]
      : innerRuns.slice(1);
  }
  const promotedFirst: MdRun = { ...run, text: remainder, ...(innerRuns ? { innerRuns } : {}) };
  const promotedRuns = remainder || innerRuns === undefined || innerRuns.length > 0
    ? [promotedFirst, ...runs.slice(1)]
    : runs.slice(1);
  return {
    type: 'heading',
    level: headingPrefix.level,
    criticParaMark: kind === 'critic_add' ? 'addition' : 'deletion',
    // The mark's author and date are the revision's, though a comment may
    // come first once the marker's span goes
    criticParaMarkRun: run,
    runs: promotedRuns,
  };
}

// What export does with a block a quote can't hold
const QUOTE_BLOCK_WARNINGS: Partial<Record<MdToken['type'], string>> = {
  list_item: 'List inside blockquote exported as quote paragraphs',
  heading: 'Heading inside blockquote exported as a quote paragraph',
  code_block: 'Code block inside blockquote exported as a quote paragraph',
  table: 'Table inside blockquote dropped during conversion',
  hr: 'Horizontal rule inside blockquote dropped during conversion',
};
// A code block of blank lines alone, which would be an empty paragraph,
// which a quote can't hold in Markdown. A blank line holds spaces and tabs,
// and characters XML can't hold, which go (see removeCharactersXmlCantHold),
// but not other spaces, as U+3000, which are text.
const EMPTY_QUOTE_CODE_WARNING = 'Empty code block inside blockquote dropped during conversion';
// A note holds paragraphs, display math, tables and code blocks, which import
// reads back, so other blocks in one are its paragraphs, but for a rule and
// an empty code block, which would be empty paragraphs
export const NOTE_BLOCK_WARNINGS: Partial<Record<MdToken['type'], string>> = {
  list_item: 'List inside a note exported as note paragraphs',
  blockquote: 'Blockquote inside a note exported as note paragraphs',
  heading: 'Heading inside a note exported as a note paragraph',
  hr: 'Horizontal rule inside a note dropped during conversion',
};
export const EMPTY_NOTE_CODE_WARNING = 'Empty code block inside a note dropped during conversion';
// A note has no sections, so an orientation directive does nothing in one,
// and wrote an empty paragraph. A close with nothing open stays a comment,
// but does nothing either.
export const NOTE_ORIENTATION_WARNING = 'Orientation directive inside a note ignored';
export const isOrientationDirective = (token: MdToken): boolean => !!(token.landscapeOpen || token.landscapeClose || token.portraitOpen || token.portraitClose);
export const isOrphanedOrientationClose = (token: MdToken): boolean => token.type === 'paragraph' && token.runs.length === 1
  && token.runs[0].type === 'html_comment' && ORIENTATION_CLOSE_RE.test(token.runs[0].text.trim());
const isBlank = (text: string): boolean => !/[^ \t\n]/.test(withoutNonXmlCharacters(text).text);
export const isEmptyCodeBlock = (token: MdToken): boolean => token.type === 'code_block' && token.runs.every(run => isBlank(run.text));

/** A code block's text as a paragraph's, in a quote, which holds no code
 *  block: its lines, with line breaks between them, which a line end in
 *  Word's text isn't, but not before blank lines at its end, which a break
 *  can't end the paragraph with. Their characters XML can't hold stay, to go
 *  where they're counted. */
function codeBlockLines(run: MdRun): MdRun[] {
  const lines = run.text.split('\n');
  let end = lines.length;
  while (end > 1 && isBlank(lines[end - 1])) end--;
  const rest = lines.slice(end).join('').replace(/[ \t]/g, '');
  return [
    ...lines.slice(0, end).flatMap((line, k): MdRun[] => [...(k > 0 ? [{ type: 'hardbreak' as const, text: '\n' }] : []), ...(line ? [{ ...run, text: line }] : [])]),
    ...(rest ? [{ ...run, text: rest }] : []),
  ];
}

export const HTML_AROUND_TABLE_WARNING = 'HTML around a table in its HTML block not shown in Word (kept in the Markdown on round-trip).';
const LATEX_HTML_AROUND_TABLES_WARNING = 'HTML around a table in an HTML block with a LaTeX environment dropped during conversion (not supported). Move the environment out of the block for round-trip fidelity.';
const SHARED_HTML_AROUND_TABLES_WARNING = 'HTML around tables in one <pre> or similar HTML block dropped during conversion (not supported). Give each table a block of its own for round-trip fidelity.';

function convertTokens(tokens: ManuscriptToken[], listLevel = 0, blockquoteLevel = 0, warnings?: string[], sourceLines?: string[]): MdToken[] {
  const result: MdToken[] = [];
  let i = 0;
  
  while (i < tokens.length) {
    const token = tokens[i];
    const produced = result.length;
    
    switch (token.type) {
      case 'heading_open': {
        const headingClose = findClosingToken(tokens, i, 'heading_close');
        result.push({
          type: 'heading',
          level: parseInt(token.tag.slice(1)),
          runs: convertInlineTokens(tokens.slice(i + 1, headingClose))
        });
        i = headingClose + 1;
        break;
      }

      case 'paragraph_open': {
        const paragraphClose = findClosingToken(tokens, i, 'paragraph_close');
        const paraRuns = convertInlineTokens(tokens.slice(i + 1, paragraphClose));
        // Only promote at top level: nested contexts (blockquotes, lists) remap
        // token types and would clobber the heading level. Comment bodies on
        // lines of their own after the heading go with it, without the breaks.
        const promoted = listLevel === 0 && blockquoteLevel === 0
          ? promoteCriticHeadingParagraph(withoutCommentBodyLines(paraRuns))
          : undefined;
        // One that reads as a table's caption, which the table before it at
        // the top level, if any, takes (see attachTableCaptions)
        const source = !promoted && listLevel === 0 && blockquoteLevel === 0 ? tableCaptionSource(tokens[i + 1]?.content ?? '') : undefined;
        const captionOfTable = source ? tableCaptionOf(paraRuns, source) : undefined;
        result.push(promoted ?? { type: 'paragraph', runs: paraRuns, ...(captionOfTable ? { captionOfTable } : {}) });
        i = paragraphClose + 1;
        break;
      }

      case 'bullet_list_open':
      case 'ordered_list_open': {
        const listClose = findClosingToken(tokens, i, token.type.replace('_open', '_close'));
        const currentLevel = listLevel + 1;
        // A start of 0 too, which reads as false
        const startAttr = token.attrGet('start');
        const listStart = startAttr !== null ? parseInt(startAttr, 10) : undefined;
        const listItems = extractListItems(tokens.slice(i + 1, listClose), token.type === 'ordered_list_open', currentLevel, warnings, listStart, sourceLines);
        pushAll(result, listItems);
        i = listClose + 1;
        break;
      }

      case 'blockquote_open': {
        const blockquoteClose = findClosingToken(tokens, i, 'blockquote_close');
        const bqLevel = blockquoteLevel + 1;
        // Intentionally reset listLevel inside blockquotes.
        // In Markdown, `> - item` starts a new list context within the quote,
        // so numbering/indentation should not inherit from outer lists.
        const blockquoteTokens = convertTokens(tokens.slice(i + 1, blockquoteClose), 0, bqLevel, warnings, sourceLines);
        // Its blocks become its paragraphs, in its style, which keeps a list
        // item's, heading's or code block's text but not what it was, and
        // has nothing for a table or rule: warn of each, and drop a table or
        // rule, which left an empty paragraph. An item's continuation is the
        // quote's, not indented as under the item, and a quote in the item,
        // whose level counts from the item's, one in this
        // A style block's fence in a list item here, whose paragraphs are
        // the quote's, in its style, goes, as a comment there did before
        // list items held style blocks, so it closes no block open around
        // the quote (see applyCustomStyleSentinels)
        if (blockquoteTokens.some(t => t.itemFence !== undefined)) warnings?.push(droppedListBlockWarning('HTML block'));
        for (const warning of new Set(blockquoteTokens.map(t => isEmptyCodeBlock(t) ? EMPTY_QUOTE_CODE_WARNING : QUOTE_BLOCK_WARNINGS[t.type]))) {
          if (warning) warnings?.push(warning + ' (not supported). Move it outside the quote for round-trip fidelity.');
        }
        const quoted: MdToken[] = [];
        // A dropped block's lines stay in the quote, on the paragraph before
        // it, so the blank lines around it are the quote's (see
        // annotateBlockquoteSpacing)
        const span = (a: [number, number] | undefined, b: [number, number]): [number, number] => a ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : b;
        for (const t of blockquoteTokens) {
          if (t.itemFence !== undefined) continue;
          if (t.type === 'table' || t.type === 'hr' || isEmptyCodeBlock(t)) {
            const previous = quoted[quoted.length - 1];
            if (t.sourceRange && previous) previous.droppedRange = span(previous.droppedRange, t.sourceRange);
            continue;
          }
          const kept: MdToken = t.type === 'blockquote'
            ? t.listContinuation ? { ...t, listContinuation: undefined, level: bqLevel + (t.level ?? 1) } : { ...t }
            : {
              ...t,
              listContinuation: undefined,
              itemCustomStyle: undefined,
              trailingBlankLine: undefined,
              ...(t.type === 'code_block' ? { runs: t.runs.flatMap(codeBlockLines) } : {}),
            };
          quoted.push(kept);
        }
        const annotated = annotateBlockquoteAlert(quoted, bqLevel);
        // Its first paragraph at its own level starts a group of its own, as
        // a quote nested in it starts its own
        const own = annotated.find(t => t.level === bqLevel);
        if (own) own.quoteStart = true;
        // And its first and last lines, which a dropped block, or a nested
        // quote that held only one, can have been, not the blank lines its
        // range ends with
        if (token.map && annotated.length > 0) {
          let end = token.map[1];
          while (end > token.map[0] + 1 && sourceLines?.[end - 1]?.trim() === '') end--;
          annotated[0].droppedRange = span(annotated[0].droppedRange, [token.map[0], token.map[0] + 1]);
          const last = annotated[annotated.length - 1];
          last.droppedRange = span(last.droppedRange, [end - 1, end]);
        }
        pushAll(result, annotated);
        i = blockquoteClose + 1;
        break;
      }

      case 'fence': {
        // Detect trailing blank line by checking if the next token starts
        // more than one line after this fence ends.  Both map values must
        // be present; if either is missing we conservatively assume no gap.
        const fenceEnd = token.map?.[1];
        const nextStart = tokens[i + 1]?.map?.[0];
        result.push({
          type: 'code_block',
          language: token.info || undefined,
          trailingBlankLine: fenceEnd != null && nextStart != null && nextStart > fenceEnd,
          runs: [{ type: 'text', text: token.content }]
        });
        i++;
        break;
      }

      case 'code_block': {
        const cbEnd = token.map?.[1];
        const cbNextStart = tokens[i + 1]?.map?.[0];
        result.push({
          type: 'code_block',
          language: undefined,
          trailingBlankLine: cbEnd != null && cbNextStart != null && cbNextStart > cbEnd,
          runs: [{ type: 'text', text: token.content }]
        });
        i++;
        break;
      }

      case 'table_open': {
        const tableClose = findClosingToken(tokens, i, 'table_close');
        const tableData = extractTableData(tokens.slice(i + 1, tableClose));
        // Detect whether the pipe table was column-aligned (padded) in source.
        // The separator row is the second line of the table; if any column's
        // dash segment exceeds the minimum 3 characters, and each line's
        // cells are as wide as the separator's, the table is aligned.
        let pipeAligned: boolean | undefined;
        if (sourceLines && token.map) {
          const [startLine, endLine] = token.map;
          // The separator row is always the second line (index 1) of the table
          if (startLine + 1 < endLine) {
            const sepLine = sourceLines[startLine + 1];
            if (sepLine) {
              let segments = sepLine.split('|');
              if (segments[0].trim() === '') segments = segments.slice(1);
              if (segments.length > 0 && segments[segments.length - 1].trim() === '') segments = segments.slice(0, -1);
              // A line's cells' widths. Without a closing pipe, which a line
              // can have or not, the last cell's padding is whitespace at the
              // end of the line, which an editor can take off, so its width
              // counts only where the line and the separator both close.
              const widths = (line: string) => {
                const trimmed = line.trimEnd();
                const closed = /(?<!\\)\|$/.test(trimmed);
                return { closed, cells: (closed ? trimmed.slice(0, -1) : trimmed).split(/(?<!\\)\|/).map(getDisplayWidth) };
              };
              const separator = widths(sepLine);
              const lines = sourceLines.slice(startLine, endLine).filter(line => line.trim() !== '');
              const linesUp = lines.every(line => {
                const row = widths(line);
                const last = row.cells.length - 1;
                return row.cells.length === separator.cells.length
                  && row.cells.every((width, k) => width === separator.cells[k] || (k === last && !(row.closed && separator.closed)));
              });
              // A table whose cells have no space around them, as |aaaaa|
              // over |:---:|, lines up but is compact. A cell with more than
              // a space on a side, as only a padded table's are, counts where
              // an edit has put a line out of line.
              const cells = lines.filter((_line, li) => li !== 1).flatMap(line => line.trim().replace(/^\|/, '')
                .replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).filter(cell => cell.trim() !== ''));
              const cellPadded = cells.some(cell => /^\s{2}|\s{2}$/.test(cell));
              const spaced = cells.some(cell => /^\s|\s$/.test(cell));
              // A column is wider than the least, of 3 dashes, or with an
              // alignment's colons, its dashes and colons fill it, with no
              // space around them, as in :---:
              pipeAligned = (linesUp && spaced || cellPadded) && segments.some(s => s.replace(/[^-]/g, '').length > 3 || /^[-:]{5,}$/.test(s));
            }
          }
        }
        const mdToken: MdToken = {
          type: 'table',
          runs: [],
          rows: tableData,
          sourceFormat: 'pipe',
        };
        if (pipeAligned) mdToken.pipeAligned = true;
        result.push(mdToken);
        i = tableClose + 1;
        break;
      }
      
      case 'html_block': {
        const htmlContent = token.content || '';
        // What the block is, as the orientation scan reads it too
        const kind = htmlBlockKind(htmlContent);
        if (kind === 'grid') {
          const b64 = htmlContent.trim().slice(GRID_TABLE_PLACEHOLDER_PREFIX.length, -4); // strip prefix and ' -->'
          try {
            const jsonStr = Buffer.from(b64, 'base64').toString();
            const gridData: GridTableData = JSON.parse(jsonStr);
            const md = createMarkdownIt();
            const gridRows: MdTableRow[] = gridData.rows.map(row => ({
              cells: row.cells.map((cellText, ci) => ({
                // Grid table cells always treat bare newlines as hard breaks
                runs: cellText
                  ? (() => { const runs = convertInlineTokens(md.parseInline(cellText, {})); promoteSoftbreaks(runs); return runs; })()
                  : [],
                ...(gridColumnAlign(gridData, ci) ? { align: gridColumnAlign(gridData, ci)! } : {}),
              })),
              header: row.header,
            }));
            const gridToken: MdToken = {
              type: 'table',
              runs: [],
              rows: gridRows,
              sourceFormat: 'grid',
            };
            if (gridData.colWidths) gridToken.gridSourceColWidths = gridData.colWidths;
            result.push(gridToken);
          } catch {
            // Invalid JSON — emit as regular HTML comment
            result.push({
              type: 'paragraph',
              runs: [{ type: 'html_comment' as const, text: htmlContent.replace(/\n$/, '') }]
            });
          }
          i++;
          break;
        }
        // Not a block that starts and ends with a comment but holds a table
        // outside them, as import writes the HTML around a table on its lines
        if (kind === 'comment') {
          // Compute blank lines before this HTML comment using token.map
          const thisStart = token.map?.[0] ?? 0;
          // Find previous token's end line — scan backwards through markdown-it tokens
          let prevEnd = 0;
          for (let pi = i - 1; pi >= 0; pi--) {
            const previousMap = tokens[pi].map;
            if (previousMap) {
              prevEnd = previousMap[1];
              break;
            }
          }
          const blankLines = Math.max(0, thisStart - prevEnd);
          // Compute blank lines after this HTML comment
          const thisEnd = token.map?.[1] ?? 0;
          let nextStart = thisEnd;
          for (let ni = i + 1; ni < tokens.length; ni++) {
            const followingMap = tokens[ni].map;
            if (followingMap) {
              nextStart = followingMap[0];
              break;
            }
          }
          const blankLinesAfterVal = Math.max(0, nextStart - thisEnd);
          result.push({
            type: 'paragraph',
            blankLinesBefore: blankLines,
            blankLinesAfter: blankLinesAfterVal,
            runs: [{ type: 'html_comment' as const, text: htmlContent.replace(/\n$/, '') }]
          });
        } else if (kind === 'raw') {
          result.push({
            type: 'paragraph',
            runs: [{ type: 'text', text: htmlContent.replace(/\n$/, ''), rawHtml: true }]
          });
        } else if (kind === 'image') {
          const srcMatch = htmlContent.match(/src\s*=\s*["']([^"']+)["']/);
          const altMatch = htmlContent.match(/alt\s*=\s*["']([^"']*?)["']/);
          const width = parseHtmlImageDimension(htmlContent, 'width');
          const height = parseHtmlImageDimension(htmlContent, 'height');
          if (srcMatch) {
            result.push({
              type: 'paragraph',
              runs: [{
                type: 'image' as const,
                text: '',
                imageSrc: decodeHtmlAttribute(srcMatch[1]),
                imageAlt: altMatch ? decodeHtmlAttribute(altMatch[1]) : '',
                imageWidth: width,
                imageHeight: height,
                imageSyntax: 'html' as const,
                imageSource: htmlContent.trim(),
              }]
            });
          } else {
            // Preserve malformed <img> tags as literal text
            result.push({
              type: 'paragraph',
              runs: [{ type: 'text', text: htmlContent.replace(/\n$/, ''), rawHtml: true }]
            });
          }
        } else if (kind === 'breaks') {
          // Line breaks alone, as import writes a paragraph that is one,
          // which markdown-it reads as a block, not a paragraph's text, or
          // after comments, as import writes a paragraph of comments a line
          // break ends, which markdown-it reads as the comments' block. Its
          // indent, which markdown-it keeps in its text, is text, as in
          // another block, as import writes a paragraph's spaces before a
          // comment only a block holds. So are spaces and tabs after a
          // comment and between the line breaks after one, as import writes
          // a paragraph's there, as in <!-- c --> <br> <br>, but not between
          // line breaks alone.
          const indent = /^[ \t]*/.exec(htmlContent)![0];
          const text = htmlContent.trim();
          // Each comment, and the spaces and tabs after it, as commentsEnd
          // finds them, then the line breaks and those between them
          const end = commentsEnd(text);
          const parts: string[] = [];
          for (let at = 0; at < end;) {
            let next = at;
            if (text.startsWith('<!--', at)) next = text.indexOf('-->', at + 4) + 3;
            else while (text[next] === ' ' || text[next] === '\t') next++;
            parts.push(text.slice(at, next));
            at = next;
          }
          // One at a time, as a spread into push passes each as an
          // argument, which overflowed the stack past about 120,000 in Node
          for (const part of text.slice(end).match(end > 0 ? /<br\s*\/?>|[ \t]+/gi : /<br\s*\/?>/gi)!) parts.push(part);
          result.push({
            type: 'paragraph',
            runs: [
              ...(indent ? [{ type: 'text' as const, text: indent }] : []),
              ...parts.map(part => part.startsWith('<!--') ? { type: 'html_comment' as const, text: part }
                : part.startsWith('<') ? { type: 'hardbreak' as const, text: '\n' }
                : { type: 'text' as const, text: part }),
            ],
          });
        } else {
          // A table whose rows are all in comments, which nothing of shows,
          // is HTML around a table that shows, as the rest of the block is
          const allTables = extractHtmlTables(htmlContent);
          const htmlTables = allTables.filter(meta => meta.rows.length > 0);
          // A <pre> or the like before the first table, which only its end
          // ends, that goes on past it holds the tables after too, which
          // import can't keep it around where Word puts text between them or
          // one leaves HTML, as the start would go on over that: the HTML
          // around them goes
          const opener = /^[ \t]*<(?:(script|pre|style|textarea)(?=[\s>]|$)|(!--)|(\?)|(!\[CDATA\[)|![A-Za-z])/i.exec(htmlContent);
          const openerEnd = !opener ? undefined : opener[1] ? new RegExp('</' + opener[1] + '>', 'i') : opener[2] ? /-->/ : opener[3] ? /\?>/ : opener[4] ? /\]\]>/ : />/;
          const sharedOpener = htmlTables.length > 1 && !!openerEnd && !openerEnd.test(htmlContent.slice(0, htmlTables[0].start));
          if (sharedOpener) warnings?.push(SHARED_HTML_AROUND_TABLES_WARNING);
          // So does a LaTeX environment at a line's start, which parseMd
          // wrapped in two dollar signs each side as display math, with its
          // blank lines gone, before the block was read, which the Markdown
          // didn't hold (see markWrappedLatexBlocks)
          const wrappedLatex = !!token.meta?.wrappedLatex;
          if (wrappedLatex) warnings?.push(LATEX_HTML_AROUND_TABLES_WARNING);
          if (htmlTables.length > 0) {
            for (const [k, meta] of htmlTables.entries()) {
              // A comment between rows or cells hides them, as the preview
              // does, but Word's table can't hold it
              if (meta.comments) warnings?.push('Comment between an HTML table\'s rows or cells dropped during conversion (not supported). Move it outside the table for round-trip fidelity.');
              if (meta.rows.length > 0) {
                // Keep this mapping explicit so HtmlTableRun/MdRun shape changes
                // cannot silently alter assignability behavior.
                const mappedRows = mapHtmlTableRowsToMdTableRows(meta.rows);
                const tableToken: MdToken = {
                  type: 'table',
                  runs: [],
                  rows: mappedRows,
                  sourceFormat: 'html',
                };
                if (meta.fontSize) tableToken.tableFontSize = meta.fontSize;
                if (meta.font) tableToken.tableFont = meta.font;
                if (meta.orientation) tableToken.tableOrientation = meta.orientation;
                if (meta.colWidths) tableToken.tableColWidths = meta.colWidths;
                if (meta.digits !== undefined) tableToken.tableDigits = meta.digits;
                if (meta.decimalMark) tableToken.tableDecimalMark = meta.decimalMark;
                if (meta.digitGrouping) tableToken.tableDigitGrouping = meta.digitGrouping;
                if (meta.embedIdx !== undefined) tableToken.embedIdx = meta.embedIdx;
                // The rest of the block, as a caption in a <p> or a <div>
                // around the table, which Word doesn't show, goes with the
                // table it's next to, as an image's goes with it: the HTML
                // before the first table, but the indent of the table's
                // line, and after each to the next, but the indent of its
                // line, or to the block's end, but the line end that ends
                // it. Import writes it as it was, with the HTML on the
                // table's lines on them, as it may end a block, and the next
                // table on from the line end or spaces before it, in the
                // block, where nothing came between them in Word.
                const next = htmlTables[k + 1];
                const before = k === 0 ? htmlContent.slice(0, meta.start).replace(/(^|\n)[ \t]*$/, '$1') : '';
                const after = next ? htmlContent.slice(meta.end, next.start).replace(/(^|\n)[ \t]*$/, '$1') : htmlContent.slice(meta.end).replace(/\s+$/, '');
                if ((/\S/.test(before + after) || (next && after)) && !sharedOpener && !wrappedLatex) tableToken.tableHtmlAround = [/\S/.test(before) ? before : '', after];
                result.push(tableToken);
              }
            }
          } else {
            // Preserve non-table raw HTML blocks as literal text so user content
            // like <tag> is not silently dropped during MD→DOCX parsing. So is
            // a block whose tables have their rows all in comments, which the
            // preview shows nothing of, but Word's table can't hold, and
            // hidden, would lose the rest of the block, and make a comment
            // that reads as a directive one.
            if (allTables.length > 0) warnings?.push('HTML table whose rows are all in comments exported as text (not supported). Move the comments outside the table for round-trip fidelity.');
            result.push({
              type: 'paragraph',
              runs: [{ type: 'text', text: htmlContent.replace(/\n$/, ''), rawHtml: true }]
            });
          }
        }
        i++;
        break;
      }
        
      case 'hr':
        result.push({
          type: 'hr',
          runs: []
        });
        i++;
        break;
        
      default:
        i++;
        break;
    }
    // Tokens from a nested block keep the narrower range it gave them
    if (token.map) {
      for (let k = produced; k < result.length; k++) result[k].sourceRange ??= [token.map[0], token.map[1]];
    }
  }
  
  return result;
}

function convertInlineTokens(tokens: ManuscriptToken[]): MdRun[] {
  const runs: MdRun[] = [];
  
  for (const token of tokens) {
    if (token.type === 'inline' && token.children) {
      // Process the children of inline tokens
      pushAll(runs, processInlineChildren(token.children));
    } else {
      // Single token processing
      pushAll(runs, processInlineChildren([token]));
    }
  }
  
  return runs;
}

type HtmlFormat = 'bold' | 'italic' | 'strikethrough' | 'underline' | 'superscript' | 'subscript';

/** The formats an inline HTML tag without attributes sets, by tag name: the
 *  ones import writes, in HTML tables and where Markdown's delimiters
 *  wouldn't read as emphasis, and their synonyms. */
const HTML_FORMAT_TAGS: Record<string, HtmlFormat> = {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', s: 'strikethrough', del: 'strikethrough', strike: 'strikethrough',
  u: 'underline', sup: 'superscript', sub: 'subscript',
};
const HTML_FORMAT_TAG_RE = /^<(\/?)(b|strong|i|em|s|del|strike|u|sup|sub)\s*>$/i;
/** An opening tag of a name in HTML_FORMAT_TAGS, with attributes or without */
const HTML_FORMAT_OPENER_RE = /^<(b|strong|i|em|s|del|strike|u|sup|sub)(?=[\s/>])/i;

/** An image's text's tokens with an escape's or a reference's text as
 *  text, as text_join gives the tokens of a paragraph, which the image's
 *  own parse doesn't run */
function textJoined(tokens: ManuscriptToken[]): ManuscriptToken[] {
  return tokens.map(token => token.type === 'text_special' ? Object.assign(Object.create(Object.getPrototypeOf(token)), token, { type: 'text' }) : token);
}

/** Convert inline tokens to Word runs, carrying formatting and protected paragraph metadata. */
export function processInlineChildren(tokens: ManuscriptToken[]): MdRun[] {
  const runs: MdRun[] = [];
  const formatStack: Partial<Pick<MdRun, 'bold' | 'italic' | 'underline' | 'strikethrough' | 'superscript' | 'subscript' | 'highlight' | 'highlightColor'>> = {};
  const highlightStack: Pick<MdRun, 'highlight' | 'highlightColor'>[] = [];
  let currentHref: string | undefined;
  // How many delimiters, and how many tags, hold each format open, so that
  // one closing inside another, as </b> in **a <b>b</b> c**, leaves it on,
  // and a closing tag closes only what a tag opened
  const depth: Record<'delimiter' | 'tag', Partial<Record<HtmlFormat, number>>> = { delimiter: {}, tag: {} };
  const holds = (format: HtmlFormat) => !!depth.delimiter[format] || !!depth.tag[format];
  const openFormat = (format: HtmlFormat, by: 'delimiter' | 'tag' = 'delimiter') => {
    depth[by][format] = (depth[by][format] ?? 0) + 1;
    formatStack[format] = true;
  };
  // Whether a delimiter or tag held the format open
  const closeFormat = (format: HtmlFormat, by: 'delimiter' | 'tag' = 'delimiter'): boolean => {
    if (!depth[by][format]) return false;
    depth[by][format]!--;
    if (!holds(format)) delete formatStack[format];
    return true;
  };
  // By tag name, whether each tag of that name still open set its format or
  // is text, as one with attributes is, whose closing tag is text too, as
  // the inner </b> of <b>a <b class="x">b</b> c</b>
  const openTags: Record<string, boolean[]> = {};
  // Whether `html` is a formatting tag (HTML_FORMAT_TAGS), which this
  // applies, and not one closing a tag that is text, or none, which is text
  const applyFormatTag = (html: string): boolean => {
    const opener = HTML_FORMAT_OPENER_RE.exec(html);
    if (opener) {
      const name = opener[1].toLowerCase();
      const applies = HTML_FORMAT_TAG_RE.test(html);
      (openTags[name] ??= []).push(applies);
      if (applies) openFormat(HTML_FORMAT_TAGS[name], 'tag');
      return applies;
    }
    const match = HTML_FORMAT_TAG_RE.exec(html);
    if (!match) return false;
    const name = match[2].toLowerCase();
    return openTags[name]?.pop() === true && closeFormat(HTML_FORMAT_TAGS[name], 'tag');
  };
  let linkStartIndex = 0;
  
  for (let ti = 0; ti < tokens.length; ti++) {
    const token = tokens[ti];
    if (token.type === 'inline' && token.children) {
      // Process the children directly - they should already have custom tokens
      pushAll(runs, processInlineChildren(token.children));
      continue;
    }
    
    switch (token.type) {
      case 'text':
        if (token.content) {  // Only add non-empty text
          runs.push({
            type: 'text',
            text: token.content,
            ...formatStack,
            href: currentHref,
            ...(token.meta?.escapedBracket ? { escapedBracket: true as const } : {}),
            ...(token.meta?.taskBoxLength ? { taskBoxLength: token.meta.taskBoxLength as number } : {}),
            ...(token.meta?.alertMarkerLength ? { alertMarkerLength: token.meta.alertMarkerLength as number } : {}),
          });
        }
        break;
        
      case 'code_inline':
        runs.push({
          type: 'text',
          text: token.content,
          code: true,
          ...formatStack,
          href: currentHref
        });
        break;
        
      case 'softbreak':
        runs.push({ type: 'softbreak', text: '\n', ...formatStack, href: currentHref,
          ...(token.meta?.criticParagraphBreak ? { criticParagraphBreak: true as const } : {}) });
        break;

      case 'hardbreak':
        runs.push({ type: 'hardbreak', text: '\n', ...formatStack, href: currentHref });
        break;

      case 'strong_open':
        openFormat('bold');
        break;
      case 'strong_close':
        closeFormat('bold');
        break;
        
      case 'em_open':
        openFormat('italic');
        break;
      case 'em_close':
        closeFormat('italic');
        break;
        
      case 's_open':
        openFormat('strikethrough');
        break;
      case 's_close':
        closeFormat('strikethrough');
        break;
        
      case 'link_open':
        currentHref = token.attrGet('href') ?? undefined;
        linkStartIndex = runs.length;
        break;
      case 'link_close':
        currentHref = undefined;
        if (runs.length > linkStartIndex) runs[linkStartIndex] = { ...runs[linkStartIndex], linkStart: true };
        break;
        
      case 'html_inline': {
        const html = token.content;
        if (html.startsWith('<!--')) {
          runs.push({ type: 'html_comment', text: html });
        } else if (isGfmDisallowedRawHtml(html)) {
          runs.push({
            type: 'text',
            text: html,
            ...formatStack,
            href: currentHref,
            rawHtml: true,
          });
        } else if (/^<br\s*\/?>$/i.test(html)) {
          // A line break, as import writes one Markdown's \ can't hold: at
          // the end of a paragraph, or in a heading
          runs.push({ type: 'hardbreak', text: '\n', htmlBreak: true, ...formatStack, href: currentHref });
        } else if (/^<img\s/i.test(html)) {
          const srcMatch = html.match(/src\s*=\s*["']([^"']+)["']/);
          const altMatch = html.match(/alt\s*=\s*["']([^"']*?)["']/);
          const width = parseHtmlImageDimension(html, 'width');
          const height = parseHtmlImageDimension(html, 'height');
          if (srcMatch) {
            runs.push({
              type: 'image',
              text: '',
              imageSrc: decodeHtmlAttribute(srcMatch[1]),
              imageAlt: altMatch ? decodeHtmlAttribute(altMatch[1]) : '',
              imageWidth: width,
              imageHeight: height,
              imageSyntax: 'html',
              imageSource: html,
              href: currentHref,
            });
          } else {
            // Preserve malformed <img> tags as literal text
            runs.push({ type: 'text', text: html, ...formatStack, rawHtml: true });
          }
        } else if (!applyFormatTag(html)) {
          // Preserve unsupported inline HTML-like fragments as literal text
          // instead of dropping them.
          runs.push({
            type: 'text',
            text: html,
            ...formatStack,
            href: currentHref,
            rawHtml: true,
          });
        }
        break;
      }
        
      case 'critic_markup': {
        const criticType = token.criticType;
        if (!criticType) break;
        if (criticType === 'critic_sub') {
          const oldText = token.oldText || '';
          const newText = token.newText || '';
          runs.push({
            type: 'critic_sub',
            text: oldText,
            newText,
            oldRuns: parseCriticInnerRuns(oldText),
            newRuns: parseCriticInnerRuns(newText),
            ...formatStack,
            href: currentHref
          });
        } else if (criticType === 'critic_comment' && runs[runs.length - 1]?.type === 'comment_body_with_id') {
          // Right after an ID body, a reply to it, as after a {==...==} anchor's
          const body = runs[runs.length - 1];
          const parentReply = body.replies?.length ?? 0;
          body.replies = [...(body.replies ?? []), { author: token.author, date: token.date, text: token.commentText || '' },
            ...(token.replies ?? []).map(reply => ({ ...reply, parentReply }))];
          body.consecutiveReplies = true;
        } else if (criticType === 'critic_comment') {
          const commentAnchorText = '';
          runs.push({
            type: 'critic_comment',
            text: commentAnchorText,
            innerRuns: parseCriticInnerRuns(commentAnchorText),
            author: token.author,
            date: token.date,
            commentText: token.commentText,
            replies: token.replies,
            ...formatStack,
            href: currentHref
          });
        } else {
          let text = token.content;
          let innerHighlight: boolean | undefined;
          let innerColor: string | undefined;

          // Only strip inner ==...== from critic_highlight — not critic_add/critic_del
          // where literal == characters in added/deleted text would be misinterpreted.
          // Only one highlight around all of it, whose closing == is its
          // last, not highlights side by side, as in ==a=={red}==b==, which
          // the content's own parse reads, as the preview does, and which
          // stripped would read as one around a=={red}==b.
          if (criticType === 'critic_highlight' && text.startsWith('==')) {
            const highlight = formatHighlightAt({ src: text, posMax: text.length }, 0);
            if (highlight?.end === text.length) {
              text = text.slice(highlight.contentStart, highlight.contentEnd);
              innerHighlight = true;
              innerColor = highlight.color;
            }
          }

          runs.push({
            type: criticType,
            text,
            innerRuns: parseCriticInnerRuns(text),
            author: token.author,
            date: token.date,
            highlight: innerHighlight,
            highlightColor: innerColor,
            ...formatStack,
            href: currentHref
          });
        }
        break;
      }

      case 'highlight_open':
        highlightStack.push({ highlight: formatStack.highlight, highlightColor: formatStack.highlightColor });
        formatStack.highlight = true;
        if (token.color) formatStack.highlightColor = token.color;
        else delete formatStack.highlightColor;
        break;
      case 'highlight_close': {
        // An enclosing highlight's color comes back
        const outer = highlightStack.pop();
        delete formatStack.highlight;
        delete formatStack.highlightColor;
        if (outer?.highlight) formatStack.highlight = true;
        if (outer?.highlightColor) formatStack.highlightColor = outer.highlightColor;
        break;
      }

      case 'cross_reference':
        runs.push({
          type: 'text',
          text: token.content,
          ...formatStack,
          href: currentHref,
          crossRef: { key: token.crossRef!.key, form: token.crossRef!.form },
        });
        break;

      case 'citation':
        runs.push({
          type: 'citation',
          text: token.content,
          keys: token.keys,
          locators: token.locators,
          suppressAuthorKeys: token.suppressAuthorKeys || undefined,
          prefixes: token.prefixes,
          ...formatStack,
          href: currentHref
        });
        break;
        
      case 'math': {
        const run: MdRun = {
          type: 'math',
          text: token.content,
          display: token.display,
          ...(token.criticMathParts ? { mathParts: token.criticMathParts } : {}),
          ...formatStack,
          href: currentHref
        };
        if (formatStack.highlight && splitsInHighlight(run)) pushAll(runs, splitAtCriticMarkup(run));
        else runs.push(run);
        break;
      }

      case 'comment_range_start':
        runs.push({
          type: 'comment_range_start',
          text: '',
          commentId: token.commentId,
        });
        break;

      case 'comment_range_end':
        runs.push({
          type: 'comment_range_end',
          text: '',
          commentId: token.commentId,
        });
        break;

      case 'comment_body_with_id':
        runs.push({
          type: 'comment_body_with_id',
          text: '',
          commentId: token.commentId,
          author: token.author,
          date: token.date,
          commentText: token.commentText,
          replies: token.replies,
        });
        break;

      case 'footnote_ref':
        runs.push({
          type: 'footnote_ref',
          text: '',
          footnoteLabel: token.footnoteLabel,
          ...formatStack,
          href: currentHref,
        });
        break;

      case 'image': {
        // markdown-it URL-encodes destinations, including literal path spaces.
        const encodedSrc = token.attrGet?.('src') || '';
        let src = encodedSrc;
        try { src = decodeURIComponent(encodedSrc); } catch { /* Keep malformed escapes literal. */ }
        // Its text, a soft break a space as in a paragraph and a hard break
        // a line break
        const alt = token.children?.map(child => child.type === 'softbreak' ? ' '
          : child.type === 'hardbreak' ? '\n' : child.content || '').join('') || '';
        let width: number | undefined;
        let height: number | undefined;
        let attrs: string | undefined;
        let writtenAttrs: string | undefined;
        // A figure's attribute block, which the image took (see
        // imagePathsWithSpaces), as written, its width and height its
        // attributes', and its caption the image's text, as runs
        const figure: FigureAttributes | undefined = token.meta?.figure;
        const nextToken = tokens[ti + 1];
        if (figure) {
          writtenAttrs = figure.written;
          const dimension = (name: 'width' | 'height') => {
            const value = attributeValue(figure.block, name);
            return value === undefined ? undefined : parseMarkdownImageDimension(name + '=' + value, name);
          };
          width = dimension('width');
          height = dimension('height');
        // Look ahead for {width=N height=N} attribute syntax, but not an
        // escaped {, or one written as a reference, which is text
        } else if (nextToken?.type === 'text' && nextToken.content && !nextToken.meta?.escapedBrace) {
          const attrMatch = nextToken.content.match(/^\{([^}]+)\}/);
          if (attrMatch) {
            attrs = attrMatch[1];
            // As written, for the image's Markdown, as its own text is
            writtenAttrs = writtenImageAttributes(token.meta?.textAfter, attrMatch[0]) ?? attrs;
            width = parseMarkdownImageDimension(attrs, 'width');
            height = parseMarkdownImageDimension(attrs, 'height');
            // Consume the attribute text (or remainder after it)
            const remainder = nextToken.content.slice(attrMatch[0].length);
            if (remainder) {
              nextToken.content = remainder;
            } else {
              ti++; // skip the attribute token entirely
            }
          }
        }
        runs.push({
          type: 'image',
          text: '',
          imageSrc: src,
          // A figure's fig-alt, as Quarto's, where it has one
          imageAlt: (figure ? attributeValue(figure.block, 'fig-alt') : undefined) ?? alt,
          imageWidth: width,
          imageHeight: height,
          imageSyntax: 'md',
          imageSource: imageMarkdownSource(token, alt, writtenAttrs),
          href: currentHref,
          ...(figure ? { figure: { attributes: figure, captionRuns: processInlineChildren(textJoined(token.children ?? [])) } } : {}),
        });
        break;
      }
    }
  }

  return runs;
}

function findClosingToken(tokens: ManuscriptToken[], start: number, closeType: string): number {
  let depth = 1;
  for (let i = start + 1; i < tokens.length; i++) {
    if (tokens[i].type === tokens[start].type) depth++;
    else if (tokens[i].type === closeType) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length;
}

// Block token types that are silently dropped when they appear inside list
// continuation (e.g. a fenced code block indented under a list item).
// Unsupported list child blocks are reported rather than silently lost.
const DROPPED_LIST_BLOCK_TYPES = new Set([
  'fence', 'code_block', 'blockquote_open', 'table_open', 'hr',
]);

/** Whether `token`, as parseMd has it before applyCustomStyleSentinels, is
 *  a style block's fence on a line of its own: a comment at the top level,
 *  or the marker of one in a list item, whose comment has no token (see
 *  MdToken.itemFence) */
function isStyleFenceToken(token: MdToken): boolean {
  if (token.itemFence !== undefined) return true;
  if (token.type !== 'paragraph' || token.runs.length !== 1 || token.runs[0].type !== 'html_comment') return false;
  const kind = styleFence(token.runs[0].text)?.kind;
  return kind === 'open' || kind === 'close';
}

/** Whether a list item drops `text`, a comment alone in an HTML block in
 *  the item after its text, as a directive, which the item can't hold. A
 *  style block's fence on a line of its own reads as one too, but
 *  extractListItems reads it first, and keeps one that opens a block, or
 *  closes one open in the item. Import asks it only of a list's indent
 *  directive, before it writes one in an item (see writesListDirective
 *  there) */
export function itemDropsComment(text: string): boolean {
  return directiveRest(text) !== undefined;
}

/** A quote or list in a style block in a list item, whose paragraphs alone
 *  take the style (see itemCustomStyle) */
function styleInItemWarning(kind: string): string {
  return kind + ' inside a style block in a list item exported without the style (not supported). Move the style block outside the list for round-trip fidelity.';
}

function droppedListBlockWarning(kind: string): string {
  return kind + ' inside list item dropped during conversion (not supported). Move the content outside the list for round-trip fidelity.';
}

/** The style block open in a list item, which the item's paragraphs after
 *  its opening fence take, with the level of the item it opened in. A list
 *  and its sublists share one, as a block that opens in an item closes one
 *  open in an item above it, as it does one open in its own item, and as a
 *  block that opens in another does at the top level */
interface ItemStyleBlock { open?: { style: string; level: number } }

/** The first line of each block a list item dropped, by the line after its
 *  last, of the list and its sublists */
type DroppedBlocks = Map<number, number>;

/** Whether a blank line comes before `line` in `sourceLines`, or before or
 *  after a block a list item dropped right before it, which Word gets
 *  nothing of, so that the blank lines beside it are the next item's, as
 *  without the block. Blank as Markdown reads a line, of spaces and tabs
 *  alone (CommonMark §4.9), not of other whitespace, which trim() takes
 *  too: a line of a no-break space goes on in the item's paragraph, and
 *  the list is tight */
function blankLineBeforeItem(line: number, sourceLines: string[] | undefined, dropped: DroppedBlocks): boolean {
  for (let at = line - 1; at >= 0;) {
    if (/^[ \t]*$/.test(sourceLines?.[at] ?? 'x')) return true;
    const start = dropped.get(at + 1);
    if (start === undefined) return false;
    at = start - 1;
  }
  return false;
}

function extractListItems(tokens: ManuscriptToken[], ordered: boolean, level: number, warnings?: string[], startNumber?: number, sourceLines?: string[], styleBlock: ItemStyleBlock = {}, droppedBlocks: DroppedBlocks = new Map()): MdToken[] {
  const items: MdToken[] = [];
  let i = 0;
  let itemOrdinal = 0;

  while (i < tokens.length) {
    if (tokens[i].type === 'list_item_open') {
      const closePos = findClosingToken(tokens, i, 'list_item_close');
      const itemTokens = tokens.slice(i + 1, closePos);
      let runs: MdRun[] = [];
      const continuationType: 'bullet' | 'ordered' = ordered ? 'ordered' : 'bullet';
      const currentOrderedNumber = ordered ? ((startNumber ?? 1) + itemOrdinal) : undefined;
      const continuationMarkerWidth = currentOrderedNumber !== undefined
        ? (String(currentOrderedNumber).length + 2)
        : undefined;
      const childSegments: Array<{ startIndex: number; order: number; items: MdToken[] }> = [];
      let childSegmentOrder = 0;
      let foundFirstParagraph = false;
      // The style of a block in the item, which its paragraphs take, as a
      // block's do at the top level, between fences in the item, but not
      // one open in an item above it, whose sublist keeps no style
      const itemStyle = () => styleBlock.open?.level === level ? styleBlock.open.style : undefined;
      // The item's own lines: its first paragraph's, or else its marker line
      const itemMap = tokens[i].map;
      let itemRange: [number, number] | undefined = itemMap ? [itemMap[0], itemMap[0] + 1] : undefined;
      // The lines of the blocks the item drops, which Word gets nothing of,
      // so the blank lines around one are those of the blocks beside it
      // (see annotateBlockquoteSpacing). But not the item's marker line, as
      // of a block on it, as - *** or - ```, which Word gets the item's
      // paragraph for, so the blank lines before the item aren't the next
      // block's
      const dropped: Array<[number, number]> = [];
      const drop = (map: [number, number] | null) => {
        if (!map) return;
        const start = itemMap && map[0] === itemMap[0] ? map[0] + 1 : map[0];
        if (start >= map[1]) return;
        dropped.push([start, map[1]]);
        droppedBlocks.set(map[1], start);
      };
      for (let j = 0; j < itemTokens.length; j++) {
        if (itemTokens[j].type === 'paragraph_open' || itemTokens[j].type === 'heading_open') {
          // A heading's text goes as a paragraph's, which is all an item holds
          const heading = itemTokens[j].type === 'heading_open';
          if (heading) {
            warnings?.push('Heading inside list item exported as a paragraph (not supported). Move the heading outside the list for round-trip fidelity.');
          }
          const paragraphClose = findClosingToken(itemTokens, j, heading ? 'heading_close' : 'paragraph_close');
          const paragraphMap = itemTokens[j].map;
          // The item's own text only where nothing came before it, as a
          // quote or sublist does in - > a, whose text after went before it
          if (!foundFirstParagraph && childSegments.length === 0) {
            runs = processInlineChildren(itemTokens.slice(j + 1, paragraphClose));
            foundFirstParagraph = true;
            if (paragraphMap) itemRange = [paragraphMap[0], paragraphMap[1]];
          } else {
            childSegments.push({
              startIndex: itemTokens[j].map?.[0] ?? j,
              order: childSegmentOrder++,
              items: [{
                type: 'paragraph',
                ...(paragraphMap ? { sourceRange: [paragraphMap[0], paragraphMap[1]] as [number, number] } : {}),
                runs: processInlineChildren(itemTokens.slice(j + 1, paragraphClose)),
                listContinuation: {
                  type: continuationType,
                  level,
                  ...(continuationMarkerWidth !== undefined ? { markerWidth: continuationMarkerWidth } : {}),
                },
                ...(itemStyle() ? { itemCustomStyle: itemStyle() } : {}),
              }],
            });
          }
          j = paragraphClose;
        } else if (itemTokens[j].type === 'blockquote_open') {
          if (itemStyle()) warnings?.push(styleInItemWarning('Blockquote'));
          const blockquoteClose = findClosingToken(itemTokens, j, 'blockquote_close');
          const blockquoteTokens = convertTokens(itemTokens.slice(j, blockquoteClose + 1), 0, 0, warnings, sourceLines);
          childSegments.push({
            startIndex: itemTokens[j].map?.[0] ?? j,
            order: childSegmentOrder++,
            items: blockquoteTokens.map(t => ({
              ...t,
              listContinuation: {
                type: continuationType,
                level,
                ...(continuationMarkerWidth !== undefined ? { markerWidth: continuationMarkerWidth } : {}),
              },
            })),
          });
          j = blockquoteClose;
        } else if (itemTokens[j].type === 'bullet_list_open' || itemTokens[j].type === 'ordered_list_open') {
          if (itemStyle()) warnings?.push(styleInItemWarning('List'));
          const subClose = findClosingToken(itemTokens, j, itemTokens[j].type.replace('_open', '_close'));
          const subOrdered = itemTokens[j].type === 'ordered_list_open';
          const subStartAttr = itemTokens[j].attrGet('start');
          const subStart = subStartAttr !== null ? parseInt(subStartAttr, 10) : undefined;
          childSegments.push({
            startIndex: itemTokens[j].map?.[0] ?? j,
            order: childSegmentOrder++,
            items: extractListItems(itemTokens.slice(j + 1, subClose), subOrdered, level + 1, warnings, subStart, sourceLines, styleBlock, droppedBlocks),
          });
          j = subClose;
        } else if (itemTokens[j].type === 'inline' && !foundFirstParagraph) {
          runs = processInlineChildren([itemTokens[j]]);
          foundFirstParagraph = true;
        } else if (itemTokens[j].type === 'html_block') {
          // An HTML block, as at the top level, the item's first paragraph if
          // it comes first, as in - <div>a</div>, which kept nothing, and a
          // continuation after a quote or sublist before it otherwise. So is
          // a comment, hidden, and a block one starts, as
          // <!-- c --><div>a</div>, as text, which export dropped with the
          // rest of the block, but not a comment after the item's text that
          // reads as a directive, which the item can't hold. Not a block
          // listItemHtmlBlock drops, which the orientation scan reads the
          // same way, so a block after it can still be the item's text.
          let blocks: MdToken[] = [];
          const fate = listItemHtmlBlock(itemTokens, j, () => (blocks = convertTokens([itemTokens[j]], 0, 0, warnings, sourceLines)).some(block => block.type !== 'paragraph'));
          if (fate === 'skipped') continue;
          const first = !foundFirstParagraph && childSegments.length === 0 && blocks.length === 1;
          const directive = !first && blocks.length === 1 && blocks[0].runs.length === 1 && blocks[0].runs[0].type === 'html_comment'
            && itemDropsComment(blocks[0].runs[0].text);
          // A style block's fences in the item, which its paragraphs after
          // take the style of, up to the closing one or the item's end. Not
          // one on one line, which the item can't hold, as a directive
          const fenceText = fate !== 'dropped' && !first && blocks.length === 1 && blocks[0].runs.length === 1 && blocks[0].runs[0].type === 'html_comment'
            ? blocks[0].runs[0].text.trim() : '';
          const fence = styleFence(fenceText);
          // Its own line, or the list's would be the marker's, which
          // annotateBlockquoteSpacing would compare in full for each
          const fenceMap = itemTokens[j].map;
          const fenceRange = fenceMap ? { sourceRange: [fenceMap[0], fenceMap[1]] as [number, number] } : {};
          if (fence?.kind === 'open') {
            // Where it opens, for the blocks at the top level, of which it
            // closes one open there, as it does one open in the item or an
            // item above it
            const closes = styleBlock.open?.style;
            childSegments.push({ startIndex: itemTokens[j].map?.[0] ?? j, order: childSegmentOrder++, items: [{ type: 'paragraph', runs: [], itemStyleOpen: fence.style, ...(closes ? { closesItemStyle: closes } : {}), itemFence: fenceText, ...fenceRange }] });
            styleBlock.open = { style: fence.style, level };
            continue;
          }
          if (itemStyle() && fence?.kind === 'close') {
            childSegments.push({ startIndex: itemTokens[j].map?.[0] ?? j, order: childSegmentOrder++, items: [{ type: 'paragraph', runs: [], itemFence: fenceText, ...fenceRange }] });
            styleBlock.open = undefined;
            continue;
          }
          if (fate === 'dropped' || directive) {
            warnings?.push(droppedListBlockWarning('HTML block'));
            drop(itemTokens[j].map);
          } else if (first) {
            runs = blocks[0].runs;
            foundFirstParagraph = true;
            const htmlMap = itemTokens[j].map;
            if (htmlMap) itemRange = [htmlMap[0], htmlMap[1]];
          } else {
            childSegments.push({
              startIndex: itemTokens[j].map?.[0] ?? j,
              order: childSegmentOrder++,
              items: blocks.map(t => ({
                ...t,
                listContinuation: {
                  type: continuationType,
                  level,
                  ...(continuationMarkerWidth !== undefined ? { markerWidth: continuationMarkerWidth } : {}),
                },
                ...(itemStyle() ? { itemCustomStyle: itemStyle() } : {}),
              })),
            });
          }
        } else if (DROPPED_LIST_BLOCK_TYPES.has(itemTokens[j].type)) {
          const kind = itemTokens[j].type === 'fence' ? 'Code block'
            : itemTokens[j].type === 'code_block' ? 'Indented code block'
            : itemTokens[j].type === 'blockquote_open' ? 'Blockquote'
            : itemTokens[j].type === 'table_open' ? 'Table'
            : itemTokens[j].type === 'hr' ? 'Horizontal rule'
            : 'Block element';
          warnings?.push(droppedListBlockWarning(kind));
          drop(itemTokens[j].map);
          // Past its cells, whose text went for the item's
          if (itemTokens[j].type === 'table_open') j = findClosingToken(itemTokens, j, 'table_close');
        }
      }

      // A block open in the item ends with it
      if (itemStyle()) styleBlock.open = undefined;

      // As GFM, a box only at the start of the item's first block, a paragraph
      const taskInfo = itemTokens[0]?.type === 'paragraph_open' || itemTokens[0]?.type === 'inline' ? extractTaskListItem(runs) : undefined;
      const sourceLineIndex = tokens[i].map?.[0];
      const blankLineBefore = sourceLineIndex !== undefined && blankLineBeforeItem(sourceLineIndex, sourceLines, droppedBlocks);
      const authoredBulletMarker = !ordered && sourceLineIndex !== undefined
        ? extractBulletMarkerFromSourceLine(sourceLines?.[sourceLineIndex])
        : undefined;
      const listItem: MdToken = {
        type: 'list_item',
        ordered,
        level,
        ...(itemRange ? { sourceRange: itemRange } : {}),
        runs: taskInfo?.runs ?? runs,
        taskChecked: taskInfo?.checked,
        ...(authoredBulletMarker ? { bulletMarker: authoredBulletMarker } : {}),
        ...(blankLineBefore ? { blankLineBefore } : {}),
        ...(dropped.length > 0 ? { itemDropped: dropped } : {}),
      };
      // Attach startNumber only to the first item of an ordered list with start ≠ 1
      if (items.length === 0 && startNumber !== undefined && startNumber !== 1) {
        listItem.startNumber = startNumber;
      }
      if (items.length === 0) listItem.listStart = true;
      items.push(listItem);
      childSegments.sort((a, b) => (a.startIndex - b.startIndex) || (a.order - b.order));
      for (const segment of childSegments) {
        pushAll(items, segment.items);
      }

      itemOrdinal++;
      i = closePos + 1;
    } else {
      i++;
    }
  }

  return items;
}

function extractTaskListItem(runs: MdRun[]): { checked: boolean; runs: MdRun[] } | undefined {
  const firstTextIdx = runs.findIndex(run => run.type === 'text' && run.text.length > 0);
  if (firstTextIdx === -1) return undefined;
  const firstTextRun = runs[firstTextIdx];
  // The box, with only the whitespace the source holds as it is after it
  const boxLength = firstTextRun.taskBoxLength ?? firstTextRun.text.length;
  const parsed = holdsMarker(runs, firstTextIdx) ? parseTaskListMarker(firstTextRun.text.slice(0, boxLength)) : undefined;
  if (!parsed) return undefined;
  const rest = parsed.rest + firstTextRun.text.slice(boxLength);
  const updatedRuns = [...runs];
  if (rest.length === 0) {
    updatedRuns.splice(firstTextIdx, 1);
  } else {
    updatedRuns[firstTextIdx] = { ...firstTextRun, text: rest, taskBoxLength: undefined };
  }
  return { checked: parsed.checked, runs: updatedRuns };
}

function extractTableData(tokens: ManuscriptToken[]): MdTableRow[] {
  const rows: MdTableRow[] = [];
  let i = 0;
  let isHeader = true;
  
  while (i < tokens.length) {
    if (tokens[i].type === 'tr_open') {
      const closePos = findClosingToken(tokens, i, 'tr_close');
      const cells = extractTableCells(tokens.slice(i + 1, closePos));
      rows.push({ cells, header: isHeader });
      isHeader = false;
      i = closePos + 1;
    } else {
      i++;
    }
  }
  
  return rows;
}

function extractTableCells(tokens: ManuscriptToken[]): MdTableCell[] {
  const cells: MdTableCell[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].type === 'td_open' || tokens[i].type === 'th_open') {
      const closeType = tokens[i].type.replace('_open', '_close');
      const closePos = findClosingToken(tokens, i, closeType);
      // markdown-it writes a column's alignment, from its :-: , as a style
      const align = /text-align:(left|center|right)/.exec(tokens[i].attrGet?.('style') ?? '')?.[1] as TableAlign | undefined;
      cells.push({ runs: convertInlineTokens(tokens.slice(i + 1, closePos)), ...(align ? { align } : {}) });
      i = closePos + 1;
    } else {
      i++;
    }
  }

  return cells;
}

/** Word's XML text with its references read, as XML reads them */
export function decodeXmlText(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseHtmlImageDimension(html: string, attrName: 'width' | 'height'): number | undefined {
  const re = new RegExp('(?:^|\\s)' + attrName + '\\s*=\\s*["\\\']?' + IMAGE_DIMENSION_ATTR_RE + '["\\\']?(?=[\\s\\/>])', 'i');
  const match = html.match(re);
  if (!match) return undefined;
  return parseImageDimension(match[1] + (match[2] || ''));
}

function parseMarkdownImageDimension(attrs: string, attrName: 'width' | 'height'): number | undefined {
  const re = new RegExp('(?:^|\\s)' + attrName + '=' + IMAGE_DIMENSION_ATTR_RE + '(?=\\s|$)', 'i');
  const match = attrs.match(re);
  if (!match) return undefined;
  return parseImageDimension(match[1] + (match[2] || ''));
}

/**
 * A paragraph's runs without the spaces and line breaks around comment
 * bodies ({#id>>...<<}) at either end of a line, which Word would show: the
 * spaces between such bodies and the text beside them, and the line ends
 * around lines that hold only bodies, but not a line break written as a \
 * or a <br>. Import writes the bodies on the lines after their paragraph.
 * A block of body lines keeps one break, joining the lines on either side,
 * unless it ends the paragraph or is all of it.
 * The lines are those Word shows with changes marked, so a revision's or a
 * highlight's text, as in {++x\n{#1>>c<<}++}, is read in its place, both
 * sides of a substitution in turn, and a line can start in one revision and
 * end in the next.
 */
export function withoutCommentBodyLines(source: MdRun[]): MdRun[] {
  type Side = 'innerRuns' | 'oldRuns' | 'newRuns';
  const sidesOf = (run: MdRun): Side[] =>
    run.type === 'critic_add' || run.type === 'critic_del' || run.type === 'critic_sub' || run.type === 'critic_highlight'
      ? (['innerRuns', 'oldRuns', 'newRuns'] as const).filter(key => !!run[key]?.length)
      : [];
  const hasBody = (runs: MdRun[]): boolean => runs.some(run => run.type === 'comment_body_with_id'
    || sidesOf(run).some(key => hasBody(run[key]!)));
  if (!hasBody(source)) return source;
  // Whitespace that shows, as code, a link or a mark, isn't padding, nor is
  // text's in a revision or a highlight that shows it
  const showsOwn = (run: MdRun) => !!(run.code || run.href || run.highlight || run.underline || run.strikethrough);
  const shownRuns = new Set<MdRun>();
  const shows = (run: MdRun) => shownRuns.has(run) || showsOwn(run);
  // Each side of a revision or highlight goes between range markers of its
  // own, which take no room, as `opens` and `closes` hold them
  const opens = new Map<MdRun, { run: MdRun; key: Side; last: boolean }>();
  const closes = new Set<MdRun>();
  const runs: MdRun[] = [];
  const flatten = (from: MdRun[], shown: boolean) => from.forEach((run, i) => {
    const keys = sidesOf(run);
    if (keys.length === 0) {
      if (shown) shownRuns.add(run);
      runs.push(run);
      return;
    }
    // A highlight shows its whitespace, but not a comment's range
    const inner = shown || showsOwn(run) || run.type === 'critic_highlight' && from[i + 1]?.type !== 'critic_comment';
    keys.forEach((key, k) => {
      const open: MdRun = { type: 'comment_range_start', text: '' };
      const close: MdRun = { type: 'comment_range_end', text: '' };
      opens.set(open, { run, key, last: k === keys.length - 1 });
      closes.add(close);
      runs.push(open);
      flatten(run[key]!, inner);
      runs.push(close);
    });
  });
  flatten(source, false);
  const lines: MdRun[][] = [[]];
  const breaks: MdRun[] = [];
  for (const run of runs) {
    if (run.type === 'softbreak' || run.type === 'hardbreak') {
      breaks.push(run);
      lines.push([]);
    } else {
      lines[lines.length - 1].push(run);
    }
  }
  const blank = (run: MdRun) => run.type === 'text' && !run.text.trim() && !shows(run);
  // Range markers take no room, so they stay where they are
  const marker = (run: MdRun) => run.type === 'comment_range_start' || run.type === 'comment_range_end';
  const edge = (run: MdRun) => run.type === 'comment_body_with_id' || blank(run) || marker(run);
  const edgeBodies = (line: MdRun[]) => {
    // Bodies, markers and blank text from the start of the line, and from its end
    let head = 0;
    while (head < line.length && edge(line[head])) head++;
    let tail = line.length;
    while (tail > head && edge(line[tail - 1])) tail--;
    return { head, tail };
  };
  const trimmed = lines.map(line => {
    const { head, tail } = edgeBodies(line);
    const hasBody = (from: number, to: number) => line.slice(from, to).some(run => run.type === 'comment_body_with_id');
    const atHead = hasBody(0, head);
    const atTail = hasBody(tail, line.length);
    if (!atHead && !atTail) return line;
    // An edge without a body keeps its runs
    const middle = line.slice(atHead ? head : 0, atTail ? tail : line.length);
    // The text beside the bodies loses its space toward them
    const last = middle.length - 1;
    if (atHead && middle[0]?.type === 'text' && !shows(middle[0])) middle[0] = { ...middle[0], text: middle[0].text.trimStart() };
    if (atTail && middle[last]?.type === 'text' && !shows(middle[last])) middle[last] = { ...middle[last], text: middle[last].text.trimEnd() };
    const bodies = (start: number, end: number) => line.slice(start, end).filter(run => run.type === 'comment_body_with_id' || marker(run));
    return [...(atHead ? bodies(0, head) : []), ...middle, ...(atTail ? bodies(tail, line.length) : [])];
  });
  // A comment takes no room either, as an anchor's after its highlight
  const bodyLine = (line: MdRun[]) => line.some(run => run.type === 'comment_body_with_id')
    && line.every(run => run.type === 'comment_body_with_id' || marker(run) || run.type === 'critic_comment');
  // Break k sits between lines k and k + 1. A blank line in a revision's
  // text, two breaks, is a paragraph break that splitCriticParagraphs splits
  // at, so neither of them goes. Nor does a line break written as one, a \
  // or a <br>, which Word shows, as at the end of a range before its body,
  // in {#1}a<br>{/1}{#1>>c<<}, but a newline only, which import writes
  // before a body's line.
  const written = (k: number) => breaks[k]?.type === 'hardbreak' && !breaks[k].newline;
  const dropped = new Set<number>();
  const drop = (k: number) => {
    if (!written(k) && !breaks[k].criticParagraphBreak && !breaks[k - 1]?.criticParagraphBreak) dropped.add(k);
  };
  for (let first = 0; first < trimmed.length;) {
    if (!bodyLine(trimmed[first])) {
      first++;
      continue;
    }
    let last = first;
    while (last + 1 < trimmed.length && bodyLine(trimmed[last + 1])) last++;
    for (let k = first; k < last; k++) drop(k);
    if (last + 1 < trimmed.length) {
      drop(last);
      // The break that joins the lines on either side is a line break
      // written as one there, if any is
      if (first > 0 && breaks.slice(first, last + 1).some((_, i) => written(first + i))) drop(first - 1);
    } else if (first > 0) drop(first - 1);
    first = last + 1;
  }
  const kept: MdRun[] = [];
  trimmed.forEach((line, k) => {
    pushAll(kept, line);
    if (k < breaks.length && !dropped.has(k)) kept.push(breaks[k]);
  });
  // Each revision and highlight back around its text, or its text in its
  // place where that's only bodies and range markers, which Word gets
  // nothing of to revise or highlight
  const unseen = (side: MdRun[] | undefined) => !!side && side.every(isCommentMarkerRun);
  const noSides = { oldRuns: undefined, newRuns: undefined, newText: undefined };
  const rebuilt = (run: MdRun, done: Partial<Record<Side, MdRun[]>>): MdRun[] => {
    if (run.type !== 'critic_sub') return unseen(done.innerRuns) ? done.innerRuns! : [{ ...run, ...done }];
    if (!unseen(done.oldRuns) && !unseen(done.newRuns)) return [{ ...run, ...done }];
    const oldRuns = done.oldRuns ?? run.oldRuns;
    const newRuns = done.newRuns ?? run.newRuns;
    return [
      ...(unseen(done.oldRuns) ? done.oldRuns! : run.text || oldRuns?.length
        ? [{ ...run, ...noSides, type: 'critic_del' as const, innerRuns: oldRuns }] : []),
      // A part of one split at display math holds its new text in newRuns alone
      ...(unseen(done.newRuns) ? done.newRuns! : run.newText || newRuns?.length
        ? [{ ...run, ...noSides, type: 'critic_add' as const, text: run.newText || '', innerRuns: newRuns }] : []),
    ];
  };
  const frames: Array<{ children: MdRun[]; open?: { run: MdRun; key: Side; last: boolean } }> = [{ children: [] }];
  const done = new Map<MdRun, Partial<Record<Side, MdRun[]>>>();
  for (const run of kept) {
    const open = opens.get(run);
    if (open) {
      frames.push({ children: [], open });
    } else if (closes.has(run)) {
      const frame = frames.pop()!;
      const sides = { ...done.get(frame.open!.run), [frame.open!.key]: frame.children };
      done.set(frame.open!.run, sides);
      if (frame.open!.last) pushAll(frames[frames.length - 1].children, rebuilt(frame.open!.run, sides));
    } else {
      frames[frames.length - 1].children.push(run);
    }
  }
  return frames[0].children;
}

/** Whether a token's runs are only comment bodies, which Word would show as
 *  an empty paragraph. */
export function holdsOnlyCommentBodies(token: MdToken): boolean {
  return !token.criticParaMark && token.runs.length > 0
    && withoutCommentBodyLines(token.runs).every(run => run.type === 'comment_body_with_id');
}

/** Whether a quote's paragraph holds only comment bodies, which
 *  withQuoteCommentBodiesMerged moves into one by it */
export function isQuoteCommentBodies(token: MdToken): boolean {
  return token.type === 'blockquote' && !token.alertLead && holdsOnlyCommentBodies(token);
}

/** Whether a quote's paragraph takes the comment bodies of the paragraphs of
 *  its quote by it (see withQuoteCommentBodiesMerged): an alert's lead only
 *  where it shows text, as one that doesn't collapses */
export function takesQuoteCommentBodies(token: MdToken): boolean {
  return !token.alertLead || token.runs.some(run => run.type !== 'comment_body_with_id' && !isNonRenderingAlertLeadRun(run));
}

/** Whether a paragraph holds only comment bodies, which generateDocumentXml
 *  registers without writing the paragraph. */
export function isCommentBodyParagraph(token: MdToken): boolean {
  return token.type === 'paragraph' && holdsOnlyCommentBodies(token);
}

/**
 * Whether the token at an index of `tokens`, after block `prev`, is a
 * paragraph of comment bodies only that Word doesn't get, as
 * generateDocumentXml writes them. Alone between two lists, it's an empty
 * paragraph, which import reads as the end of the first.
 */
export function commentBodiesOmitted(tokens: MdToken[]): (ti: number, prev: MdToken | undefined) => boolean {
  // For each index, the first token from it on that isn't such a paragraph,
  // or the close of a style block Word gets nothing for (see
  // isImplicitStyleClose), found at once, so a run of them is read once
  const past = new Int32Array(tokens.length + 1);
  past[tokens.length] = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i--) past[i] = isCommentBodyParagraph(tokens[i]) || isImplicitStyleClose(tokens[i]) ? past[i + 1] : i;
  return (ti, prev) => isCommentBodyParagraph(tokens[ti]) && !(!tokens[ti].listContinuation
    && (prev?.type === 'list_item' || !!prev?.listContinuation)
    && tokens[past[ti + 1]]?.type === 'list_item');
}

/** Whether a token is a custom style's directive, <!-- style: X --> or
 *  <!-- /style -->, which sets the style of the paragraphs after it, and
 *  for which generateDocumentXml writes no paragraph */
export function isStyleDirective(token: MdToken): boolean {
  return !!token.customStyleOpen || !!token.customStyleClose;
}

/** Whether `token` is a block Word can't give a style block's style, at
 *  the top level: a heading, a quote's paragraph, code, a table or a
 *  thematic break, which keep their own (see generateParagraph) */
export function unstyledInStyleBlock(token: MdToken): boolean {
  return !token.listContinuation && (token.type === 'heading' || token.type === 'blockquote'
    || token.type === 'code_block' || token.type === 'table' || token.type === 'hr');
}

/** Whether `token` marks a section's fence or the bibliography's place,
 *  which Word gets no paragraph of a style block's for */
export function marksSectionOrBibliography(token: MdToken): boolean {
  return !!(token.landscapeOpen || token.landscapeClose || token.portraitOpen || token.portraitClose || token.bibliographyMarker);
}

/** Whether an opening fence of `style` starts a style block of its own
 *  where one of `openStyle` is open, or none is: where it's of another
 *  style. One of the same style, which no fence closed, goes on in the
 *  block open, in Word too */
export function startsStyleBlock(openStyle: string | undefined, style: string): boolean {
  return openStyle !== style;
}

/**
 * The caption of a table a paragraph's runs, `runs`, hold, whose text
 * tableCaptionSource read as one, `source`, as `: Caption {#tbl-x}`: the
 * runs between the colon, with the whitespace after it the text has as
 * written, and the label, which is the last run, with the whitespace and
 * line ends before the label left out, which Word wouldn't show at the
 * caption's end. Undefined where the label is no last run of its own.
 */
function tableCaptionOf(runs: MdRun[], source: { label: string; lead: number }): TableCaption | undefined {
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (runs.length < 2 || last.type !== 'comment_range_start' || last.commentId !== '#' + source.label
    || first.type !== 'text' || first.href || !first.text.startsWith(':') || first.text.length < source.lead) return undefined;
  const caption = runs.slice(0, -1);
  const rest = first.text.slice(source.lead);
  if (rest) caption[0] = { ...first, text: rest };
  else caption.shift();
  while (caption.length > 0) {
    const end = caption[caption.length - 1];
    if (end.type === 'softbreak' || end.type === 'hardbreak') {
      caption.pop();
    } else if (end.type === 'text' && !end.code && /\s$/.test(end.text)) {
      const text = end.text.trimEnd();
      if (text) {
        caption[caption.length - 1] = { ...end, text };
        break;
      }
      caption.pop();
    } else {
      break;
    }
  }
  return { label: source.label, runs: caption };
}

/**
 * Gives each table its caption, as Quarto reads one: the paragraph right
 * after it that is one (see tableCaptionOf), at the top level, as the
 * table is, in no list item, quote or style block, with nothing between
 * them in `lines`, the text markdown-it read, but blank lines, as a
 * directive the passes before took out, as `<!-- indent -->`, whose
 * override the paragraph keeps, as the preview does. The paragraph goes from
 * `tokens`, as Word gets its text with the table, in a caption above or
 * below it, which neither side counts among the body's paragraphs (see
 * readCaptions in converter.ts). A table an embed gave, whose directive
 * import writes in its place, takes none. A paragraph no table takes
 * stays one, with its label, which labels nothing, and a warning.
 */
function attachTableCaptions(tokens: MdToken[], lines: readonly string[]): void {
  // Whether only blank lines are between the table's and the paragraph's
  const adjoins = (table: MdToken, paragraph: MdToken): boolean => {
    if (!table.sourceRange || !paragraph.sourceRange || paragraph.splitPart) return false;
    for (let line = table.sourceRange[1]; line < paragraph.sourceRange[0]; line++) if (/\S/.test(lines[line] ?? '')) return false;
    return true;
  };
  let styled = false;
  let kept = 0;
  for (const token of tokens) {
    if (token.customStyleOpen) styled = true;
    else if (token.customStyleClose) styled = false;
    const table = tokens[kept - 1];
    // Its runs as they were read, where nothing split it, as at a paragraph
    // break in a tracked change
    const caption = token.captionOfTable;
    const whole = !!caption && !token.listContinuation && !token.criticParaMark && token.runs[token.runs.length - 1]?.commentId === '#' + caption.label
      && token.runs[0]?.type === 'text' && token.runs[0].text.startsWith(':');
    if (caption && whole && !styled && table?.type === 'table' && !table.listContinuation && table.embedIdx === undefined && !table.tableCaption && adjoins(table, token)) {
      table.tableCaption = caption;
      continue;
    }
    tokens[kept++] = token;
  }
  tokens.length = kept;
}
