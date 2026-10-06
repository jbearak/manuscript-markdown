import { extractHtmlTables, type HtmlTableCell } from './html-table-parser';
import { DEFAULT_FORMATTING, markdownTable, type ContentItem, type TableCell } from './converter';
import MarkdownIt from 'markdown-it';
import { HTML_TAG_RE } from 'markdown-it/lib/common/html_re.mjs';
import { separatorAlign, type TableAlign } from './grid-table-preprocess';
import { LINE_PLACEHOLDER, PARA_PLACEHOLDER, preprocessCriticMarkup } from './critic-markup';

export interface TextTransformation {
  newText: string;
  cursorOffset?: number; // Optional cursor position relative to start
}

export function wrapColoredHighlight(text: string, color: string): TextTransformation {
  return { newText: '==' + text + '=={' + color + '}' };
}

function buildCommentAuthorPrefix(authorName?: string | null): string {
  const trimmed = authorName?.trim();
  return trimmed ? '@' + trimmed + ' | ' : '';
}

/**
 * Wraps selected text with prefix and suffix delimiters
 * @param text - The text to wrap
 * @param prefix - The prefix delimiter
 * @param suffix - The suffix delimiter
 * @param cursorOffset - Optional cursor position relative to start of newText
 * @param authorName - Optional author name to include in comments
 * @returns TextTransformation with wrapped text and optional cursor offset
 */
export function wrapSelection(
  text: string,
  prefix: string,
  suffix: string,
  cursorOffset?: number,
  authorName?: string | null
): TextTransformation {
  let newText = prefix + text + suffix;
  let adjustedCursorOffset = cursorOffset;
  
  // If this is a comment (prefix is '{>>') and we have an author name, insert it
  if (prefix === '{>>' && authorName) {
    const authorPrefix = buildCommentAuthorPrefix(authorName);
    newText = prefix + authorPrefix + text + suffix;
    // Adjust cursor offset to account for author prefix length
    if (adjustedCursorOffset !== undefined) {
      adjustedCursorOffset = adjustedCursorOffset + authorPrefix.length;
    }
  }
  
  return {
    newText,
    cursorOffset: adjustedCursorOffset
  };
}

/**
 * Prepends a prefix to each line in the text
 * @param text - The text to process
 * @param linePrefix - The prefix to add to each line
 * @param skipIfPresent - If true, skip lines that already start with the prefix
 * @returns TextTransformation with prefixed lines
 */
export function wrapLines(
  text: string,
  linePrefix: string,
  skipIfPresent?: boolean
): TextTransformation {
  const lines = text.split('\n');
  const processedLines = lines.map(line => {
    // Skip empty lines
    if (line.trim() === '') {
      return line;
    }
    
    // Skip if line already has the prefix and skipIfPresent is true
    if (skipIfPresent && line.trimStart().startsWith(linePrefix.trim())) {
      return line;
    }
    
    return linePrefix + line;
  });
  
  return {
    newText: processedLines.join('\n')
  };
}

/**
 * Prepends sequential numbers to each line
 * @param text - The text to process
 * @returns TextTransformation with numbered lines
 */
export function wrapLinesNumbered(text: string): TextTransformation {
  const lines = text.split('\n');
  let counter = 1;
  
  const processedLines = lines.map(line => {
    // Skip empty lines
    if (line.trim() === '') {
      return line;
    }
    
    return `${counter++}. ${line}`;
  });
  
  return {
    newText: processedLines.join('\n')
  };
}

/**
 * Formats text as a heading with the specified level
 * Removes any existing heading indicators before adding new ones
 * Works on each line independently for multi-line text
 * @param text - The text to format (can be multi-line)
 * @param level - The heading level (1-6)
 * @returns TextTransformation with heading prefix
 */
export function formatHeading(text: string, level: number): TextTransformation {
  const lines = text.split('\n');
  const prefix = '#'.repeat(level) + ' ';
  
  const processedLines = lines.map(line => {
    // Remove any existing heading indicators (one or more # followed by a space)
    const lineWithoutHeading = line.replace(/^#+\s/, '');
    return prefix + lineWithoutHeading;
  });
  
  return {
    newText: processedLines.join('\n')
  };
}


/**
 * Wraps text with highlight and appends a comment placeholder
 * @param text - The text to highlight
 * @param authorName - Optional author name to include in comment
 * @returns TextTransformation with highlight and comment, cursor positioned in comment
 */
export function highlightAndComment(text: string, authorName?: string | null): TextTransformation {
  const highlighted = `{==${text}==}`;
  const authorPrefix = buildCommentAuthorPrefix(authorName);
  const withComment = highlighted + `{>>${authorPrefix}<<}`;
  const cursorOffset = highlighted.length + 3 + authorPrefix.length; // Position after author prefix
  
  return {
    newText: withComment,
    cursorOffset
  };
}


/**
 * Wraps text with ID-based comment syntax: {#id}text{/id}{#id>>@author | <<}
 * Used when alwaysUseCommentIds is enabled.
 * @param text - The text to comment on
 * @param authorName - Optional author name to include in comment
 * @returns TextTransformation with ID-based comment syntax, cursor positioned in comment
 */
export function highlightAndCommentWithId(text: string, authorName?: string | null): TextTransformation {
  // Generate a unique ID based on timestamp
  const id = Date.now().toString(36);
  const rangeStart = `{#${id}}`;
  const rangeEnd = `{/${id}}`;
  const authorPrefix = buildCommentAuthorPrefix(authorName);
  const commentBody = `{#${id}>>${authorPrefix}<<}`;
  const withComment = rangeStart + text + rangeEnd + commentBody;
  const cursorOffset = rangeStart.length + text.length + rangeEnd.length + `{#${id}>>`.length + authorPrefix.length;

  return {
    newText: withComment,
    cursorOffset
  };
}

/**
 * Wraps text in a code block with triple backticks
 * @param text - The text to wrap
 * @returns TextTransformation with code block formatting
 */
export function wrapCodeBlock(text: string): TextTransformation {
  const newText = '```\n' + text + '\n```';
  return { newText };
}

/**
 * Wraps text with both bold and italic formatting
 * @param text - The text to format
 * @returns TextTransformation with bold italic formatting
 */
export function formatBoldItalic(text: string): TextTransformation {
  return wrapSelection(text, '***', '***');
}

/**
 * Wraps text with substitution markup and appends a comment placeholder
 * @param text - The text to substitute
 * @param authorName - Optional author name to include in comment
 * @returns TextTransformation with substitution and comment, cursor positioned in comment
 */
export function substituteAndComment(text: string, authorName?: string | null): TextTransformation {
  const substitution = `{~~${text}~>~~}`;
  const authorPrefix = buildCommentAuthorPrefix(authorName);
  const withComment = substitution + `{>>${authorPrefix}<<}`;
  const cursorOffset = substitution.length + 3 + authorPrefix.length; // Position after author prefix
  
  return {
    newText: withComment,
    cursorOffset
  };
}

/**
 * Wraps text with addition markup and appends a comment placeholder
 * @param text - The text to mark as addition
 * @param authorName - Optional author name to include in comment
 * @returns TextTransformation with addition and comment, cursor positioned in comment
 */
export function additionAndComment(text: string, authorName?: string | null): TextTransformation {
  const addition = `{++${text}++}`;
  const authorPrefix = buildCommentAuthorPrefix(authorName);
  const withComment = addition + `{>>${authorPrefix}<<}`;
  const cursorOffset = addition.length + 3 + authorPrefix.length; // Position after author prefix
  
  return {
    newText: withComment,
    cursorOffset
  };
}

/**
 * Wraps text with deletion markup and appends a comment placeholder
 * @param text - The text to mark as deletion
 * @param authorName - Optional author name to include in comment
 * @returns TextTransformation with deletion and comment, cursor positioned in comment
 */
export function deletionAndComment(text: string, authorName?: string | null): TextTransformation {
  const deletion = `{--${text}--}`;
  const authorPrefix = buildCommentAuthorPrefix(authorName);
  const withComment = deletion + `{>>${authorPrefix}<<}`;
  const cursorOffset = deletion.length + 3 + authorPrefix.length; // Position after author prefix
  
  return {
    newText: withComment,
    cursorOffset
  };
}

/**
 * Formats text as a markdown link
 * @param text - The text to use as link text (or URL if empty selection)
 * @returns TextTransformation with link formatting, cursor positioned for URL
 */
export function formatLink(text: string): TextTransformation {
  if (text.trim() === '') {
    // Empty selection: insert link template with cursor in link text position
    return {
      newText: '[]()',
      cursorOffset: 1
    };
  }
  
  // Check if text looks like a URL
  const urlPattern = /^https?:\/\//i;
  if (urlPattern.test(text.trim())) {
    // Text is a URL: use it as the href, cursor in link text position
    return {
      newText: `[](${text})`,
      cursorOffset: 1
    };
  }
  
  // Text is link text: cursor in URL position
  return {
    newText: `[${text}]()`,
    cursorOffset: text.length + 3
  };
}

/**
 * Prepends task list checkbox to each line
 * @param text - The text to process
 * @returns TextTransformation with task list formatting
 */
export function formatTaskList(text: string): TextTransformation {
  return wrapLines(text, '- [ ] ');
}

/**
 * Type representing the alignment of a table column
 */
export type ColumnAlignment = 'left' | 'right' | 'center' | 'default';

/**
 * Interface representing a single row in a markdown table
 */
export interface TableRow {
  cells: string[];
  isSeparator: boolean;
  alignments?: ColumnAlignment[]; // Only present for separator rows
}

/**
 * Interface representing a parsed markdown table
 */
export interface ParsedTable {
  rows: TableRow[];
  columnWidths: number[];
  alignments: ColumnAlignment[]; // Alignment for each column
}

type GridBorderStyle = 'dash' | 'equal';

interface ParsedGridTable {
  rows: string[][];
  columnWidths: number[];
  borderStyles: GridBorderStyle[]; // One style per border line (rows + 1)
  borderAligns: Array<Array<TableAlign | null>>; // Each border line's columns' alignment colons
}

/**
 * Split a string on unescaped `|` characters.
 * `\|` (escaped pipe) is kept as part of the cell; `\\|` (escaped backslash
 * then unescaped pipe) splits normally.
 */
function splitOnPipes(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\\' && i + 1 < line.length) {
      // Consume the escape pair as literal content
      current += line[i] + line[i + 1];
      i += 2;
    } else if (line[i] === '|') {
      parts.push(current);
      current = '';
      i++;
    } else {
      current += line[i];
      i++;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Checks if a line is a valid markdown table row
 * A valid table row starts and ends with | and contains at least one | separator
 * @param line - The line to check
 * @returns true if the line is a valid table row
 */
export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }

  // Must start with | and end with | (the trailing | may be an escaped pipe
  // treated as content by the parser — this is intentional; see tests).
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return false;
  }
  // Must contain at least 2 unescaped pipes (opening + closing)
  const pipeCount = splitOnPipes(trimmed).length - 1;
  return pipeCount >= 2;
}

/**
 * Checks if a line is a markdown table separator row (header separator)
 * A separator row contains only pipes, hyphens, colons, and spaces
 * @param line - The line to check
 * @returns true if the line is a separator row
 */
export function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  
  // Must be a valid table row first
  if (!isTableRow(trimmed)) {
    return false;
  }
  
  // Check if content between pipes contains only hyphens, colons, and spaces
  // Pattern: starts with |, then groups of [spaces, optional colon, hyphens, optional colon, spaces] separated by |, ends with |
  const separatorPattern = /^\|[\s:|-]+\|$/;
  if (!separatorPattern.test(trimmed)) {
    return false;
  }
  
  // Each cell (between pipes) must contain at least 3 characters that are hyphens or colons
  // and at least one must be a hyphen (standard markdown requirement)
  const cells = splitOnPipes(trimmed.slice(1, -1));
  return cells.every(cell => {
    const trimmedCell = cell.trim();
    const hyphensAndColons = trimmedCell.match(/[-:]/g);
    const hyphens = trimmedCell.match(/-/g);
    return hyphensAndColons && hyphensAndColons.length >= 3 && hyphens && hyphens.length >= 1;
  });
}

/**
 * Extracts alignment from a separator cell
 * @param cell - The separator cell content (e.g., ":---", "---:", ":---:", "---")
 * @returns The column alignment type
 */
export function parseAlignment(cell: string): ColumnAlignment {
  const trimmed = cell.trim();
  
  const hasLeadingColon = trimmed.startsWith(':');
  const hasTrailingColon = trimmed.endsWith(':');
  
  if (hasLeadingColon && hasTrailingColon) {
    return 'center';
  } else if (hasLeadingColon) {
    return 'left';
  } else if (hasTrailingColon) {
    return 'right';
  } else {
    return 'default';
  }
}

/** Reads where a document's tables are, as the preview and export do, with
 * no inline parsing, which tables' places don't need */
const tableBlockParser = new MarkdownIt({ html: true }).disable('inline');

/** A table's lines in a document: its first, its separator's, and the one
 * after its last */
export interface TableLines {
  start: number;
  separator: number;
  end: number;
}

/**
 * Where a document's `lines` hold tables, as markdown-it reads them after
 * CriticMarkup's preprocessing, as the preview and export do. Its
 * placeholders hold a span's line ends, so a table's sample in a comment
 * starts no table; `starts` has the source's line each parsed one starts.
 */
export function documentTables(lines: string[]): TableLines[] {
  const parsed = preprocessCriticMarkup(lines.join('\n'), false);
  const starts = [0];
  for (const line of parsed.split('\n')) {
    starts.push(starts[starts.length - 1] + line.split(LINE_PLACEHOLDER).length + 2 * (line.split(PARA_PLACEHOLDER).length - 1));
  }
  const tables: TableLines[] = [];
  for (const token of tableBlockParser.parse(parsed, {})) {
    // The delimiter row comes right after the header
    if (token.type === 'table_open' && token.map) {
      tables.push({ start: starts[token.map[0]], separator: starts[token.map[0] + 1], end: starts[token.map[1]] });
    }
  }
  return tables;
}

/**
 * Which of the lines from `start` to `end` of a document's `lines`, counting
 * those that aren't blank, is the separator of the table of its `tables`
 * they're in, or -1 where it's outside them; undefined where they're in no
 * table, for parseTable to find the separator in their text. So a
 * selection that starts at the separator, or below it, isn't read as a
 * table of its own, whose second row, of dashes and colons too, would be
 * taken for it, and lines before the table, as a paragraph's or an indented
 * code block's, aren't taken for its header.
 */
export function tableSeparatorIndex(tables: TableLines[], lines: string[], start: number, end: number): number | undefined {
  const table = tables.find(table => end >= table.start && start < table.end);
  if (!table) return undefined;
  if (table.separator < start || table.separator > end) return -1;
  let index = 0;
  for (let i = start; i < table.separator; i++) if (lines[i].trim().length > 0) index++;
  return index;
}

/**
 * Parses markdown table text into structured data
 * @param text - The table text to parse
 * @param separatorIndex - Which of its rows is the separator, or -1 for none,
 *   where the caller knows from the table around the text
 * @returns ParsedTable object with rows and column widths, or null if not a valid table
 */
export function parseTable(text: string, separatorIndex?: number): ParsedTable | null {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  if (lines.length === 0) {
    return null;
  }
  
  // Check if all lines are valid table rows
  if (!lines.every(line => isTableRow(line))) {
    return null;
  }
  
  // The separator is the second row, as GFM reads a table, or the first,
  // where the text starts at it, as a selection from it down does, unless
  // the caller found it in the table around the text (see
  // tableSeparatorIndex). Another row of dashes and colons is text, as the
  // preview and export read it, which reflowing must keep, not rewrite as
  // the separator, as | -:- | as | --- |, nor take the table's alignments from.
  separatorIndex ??= lines.length > 1 && isSeparatorRow(lines[1]) ? 1 : isSeparatorRow(lines[0]) ? 0 : -1;

  // Parse each line into a TableRow
  const rows: TableRow[] = lines.map((line, index) => {
    const isSep = index === separatorIndex;
    
    // Extract cells by splitting on unescaped | and removing first/last empty elements
    const parts = splitOnPipes(line);
    // Trim all cells to get the actual content without padding
    // This means cell content is defined as the trimmed text between pipes
    const cells = parts.slice(1, -1).map(cell => cell.trim());
    
    // If this is a separator row, parse alignments
    let alignments: ColumnAlignment[] | undefined;
    if (isSep) {
      alignments = cells.map(cell => parseAlignment(cell));
    }
    
    return {
      cells,
      isSeparator: isSep,
      alignments
    };
  });
  
  // Calculate column widths (maximum content length for each column)
  const columnCount = Math.max(...rows.map(row => row.cells.length));
  const columnWidths: number[] = new Array(columnCount).fill(0);
  
  for (const row of rows) {
    for (let i = 0; i < row.cells.length; i++) {
      // For separator rows, we don't count the content length
      // For content rows, use the actual cell content length
      if (!row.isSeparator) {
        columnWidths[i] = Math.max(columnWidths[i], row.cells[i].length);
      }
    }
  }
  
  // Extract alignments from the separator row (if present)
  const separatorRow = rows.find(row => row.isSeparator);
  const alignments: ColumnAlignment[] = separatorRow?.alignments || 
    new Array(columnCount).fill('default');
  
  return {
    rows,
    columnWidths,
    alignments
  };
}

/**
 * Formats a content row with proper padding
 * @param cells - Array of cell contents
 * @param columnWidths - Array of column widths for padding
 * @returns Formatted row string
 */
export function formatContentRow(cells: string[], columnWidths: number[]): string {
  const formattedCells = cells.map((cell, i) => {
    const width = columnWidths[i] || 0;
    // Pad the cell to the column width
    // The cell content should be left-aligned within the column width
    return cell.padEnd(width, ' ');
  });
  return '| ' + formattedCells.join(' | ') + ' |';
}

/**
 * Formats a separator row with hyphens and alignment indicators
 * @param columnWidths - Array of column widths
 * @param alignments - Array of column alignments (optional, defaults to 'default' for all columns)
 * @returns Formatted separator row string
 */
export function formatSeparatorRow(columnWidths: number[], alignments?: ColumnAlignment[]): string {
  // Each separator cell should have at least 3 hyphens (standard markdown)
  // or match the column width, whichever is greater
  const cells = columnWidths.map((width, i) => {
    const minWidth = Math.max(width, 3);
    const alignment = alignments?.[i] || 'default';
    
    switch (alignment) {
      case 'left':
        // :--- (colon + hyphens)
        return ':' + '-'.repeat(minWidth - 1);
      case 'right':
        // ---: (hyphens + colon)
        return '-'.repeat(minWidth - 1) + ':';
      case 'center':
        // :---: (colon + hyphens + colon)
        return ':' + '-'.repeat(Math.max(minWidth - 2, 1)) + ':';
      case 'default':
      default:
        // --- (just hyphens)
        return '-'.repeat(minWidth);
    }
  });
  return '| ' + cells.join(' | ') + ' |';
}

function parseGridBorderSegments(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('+') || !trimmed.endsWith('+')) {
    return null;
  }
  const segments = trimmed.slice(1, -1).split('+');
  if (segments.length === 0) {
    return null;
  }
  for (const segment of segments) {
    if (segment.length === 0 || !/^:?[=-]+:?$/.test(segment)) {
      return null;
    }
  }
  return segments;
}

function parseGridRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return null;
  }
  return trimmed.slice(1, -1).split('|').map(cell => cell.trim());
}

// Simplified grid-table parser for Expand/Compact Table (single-line cells only).
// The full multi-line grid-table parser lives in md-to-docx.ts.
function parseGridTable(text: string): ParsedGridTable | null {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length < 3 || lines.length % 2 === 0) {
    return null;
  }

  const firstBorder = parseGridBorderSegments(lines[0]);
  if (!firstBorder) {
    return null;
  }
  const columnCount = firstBorder.length;

  const rows: string[][] = [];
  const borderStyles: GridBorderStyle[] = [];
  const borderAligns: Array<Array<TableAlign | null>> = [];

  for (let i = 0; i < lines.length; i++) {
    if (i % 2 === 0) {
      const borderSegments = parseGridBorderSegments(lines[i]);
      if (!borderSegments || borderSegments.length !== columnCount) {
        return null;
      }
      borderStyles.push(borderSegments.some(segment => segment.includes('=')) ? 'equal' : 'dash');
      borderAligns.push(borderSegments.map(separatorAlign));
    } else {
      const cells = parseGridRow(lines[i]);
      if (!cells || cells.length !== columnCount) {
        return null;
      }
      rows.push(cells);
    }
  }

  const columnWidths: number[] = new Array(columnCount).fill(1);
  for (const row of rows) {
    for (let i = 0; i < columnCount; i++) {
      columnWidths[i] = Math.max(columnWidths[i], row[i].length);
    }
  }

  return { rows, columnWidths, borderStyles, borderAligns };
}

function formatGridBorderRow(columnWidths: number[], style: GridBorderStyle, aligns: Array<TableAlign | null> = []): string {
  const borderChar = style === 'equal' ? '=' : '-';
  const segments = columnWidths.map((width, i) => {
    // An alignment's colons take the place of the border's ends
    const left = aligns[i] === 'left' || aligns[i] === 'center' ? ':' : '';
    const right = aligns[i] === 'right' || aligns[i] === 'center' ? ':' : '';
    return left + borderChar.repeat(Math.max(width + 2, 3) - left.length - right.length) + right;
  });
  return '+' + segments.join('+') + '+';
}

function formatGridContentRow(cells: string[], columnWidths: number[], pad: boolean): string {
  const rendered = cells.map((cell, i) => {
    if (!pad) {
      return cell;
    }
    return cell.padEnd(columnWidths[i], ' ');
  });
  return '| ' + rendered.join(' | ') + ' |';
}

/** A character XML 1.0 can't hold: a control character other than a tab
 *  or line end, or U+FFFE or U+FFFF. Word's text can't hold one, so export
 *  drops it, import's writers take some for marks of their own, as U+0007
 *  for a bare link's, and Markdown reads one written as a reference, as
 *  &#7;, as U+FFFD, so a cell with one can't be written as it is. */
const NOT_XML_CHARACTER = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

/** An HTML table's cell as Word's, as export reads it: its runs, with
 *  each <a> a link of its own, numbered from `links`, and each <br> a line
 *  break, in the link of the <a> it's in, or undefined where a run is one a
 *  Word cell can't hold as it is, as code's line end, which shows as a
 *  space, or one with a character XML can't hold, in its text, its link's
 *  URL or a comment */
function htmlCellAsWord(cell: HtmlTableCell, links: { count: number }): TableCell | undefined {
  const paragraphs: ContentItem[][] = [[]];
  let link = 0;
  for (const run of cell.runs) {
    const para = paragraphs[paragraphs.length - 1];
    if (NOT_XML_CHARACTER.test(run.text) || run.href && NOT_XML_CHARACTER.test(run.href)) return undefined;
    if (run.linkStart) link = ++links.count;
    const linked = run.href ? { href: run.href, link } : {};
    // A line break's the formatting around it, as text's, which Word shows
    // on it, as an underline
    const formatting = { ...DEFAULT_FORMATTING, bold: !!run.bold, italic: !!run.italic, underline: !!run.underline, strikethrough: !!run.strikethrough, code: !!run.code, superscript: !!run.superscript, subscript: !!run.subscript };
    if (run.type === 'paragraph') paragraphs.push([]);
    else if (run.type === 'softbreak' || run.type === 'hardbreak') {
      para.push({ type: 'text', text: '\\\n', commentIds: new Set(), formatting, ...linked });
    } else if (run.type === 'html_comment') {
      para.push({ type: 'html_comment', text: run.text, commentIds: new Set() });
    } else if (run.type === 'text' && !/[\r\n]/.test(run.text)) {
      para.push({ type: 'text', text: run.text, commentIds: new Set(), formatting, ...linked });
    } else return undefined;
  }
  return { paragraphs };
}

function convertHtmlTable(text: string, pad: boolean): string | null {
  const trimmed = text.trim();
  if (!/^<table\b[\s\S]*<\/table>$/i.test(trimmed)) return null;
  const tables = extractHtmlTables(trimmed);
  // Subtle bug guard: mixed text/table selections must remain unchanged, as
  // one with a comment after the table that a </table> in it ends. So must
  // a table with a comment between its rows or cells, which a pipe
  // or grid table can't hold, so that it isn't lost, or one in a cell with
  // a line end, which would make a line of the cell, or a |, which would end
  // it or take a backslash, or one inline Markdown doesn't read whole, as
  // one with no end, whose text it would show.
  if (tables.length !== 1 || tables[0].start !== 0 || tables[0].end !== trimmed.length || tables[0].comments || tables[0].rows.some(row => row.cells.some(cell =>
    cell.runs.some(run => run.type === 'html_comment' && (/[\r\n|]/.test(run.text) || HTML_TAG_RE.exec(run.text)?.[0] !== run.text))))) return null;

  // The table as Word's, as export reads the HTML, which import writes as
  // a pipe or grid table, as it reads back the same, so a cell's text,
  // which is literal in HTML, takes an escape wherever it would read as
  // Markdown, as *a* or [@key]. A table neither holds as it is, as one
  // with merged cells or a cell of paragraphs, stays HTML.
  const links = { count: 0 };
  const cells: TableCell[][] = [];
  for (const row of tables[0].rows) {
    const rowCells = row.cells.map(cell => cell.colspan && cell.colspan > 1 || cell.rowspan && cell.rowspan > 1 ? undefined : htmlCellAsWord(cell, links));
    if (rowCells.some(cell => cell === undefined)) return null;
    cells.push(rowCells as TableCell[]);
  }
  // Its leading header rows are a grid table's header, and a pipe table's
  // is its first row, header row or not, so one of more header rows is a
  // grid table, as is one with a line break before a cell's last text,
  // which a line of its own holds, and else a pipe table, which holds a
  // break as <br>
  let headerEnd = 0;
  while (headerEnd < cells.length && tables[0].rows[headerEnd].header) headerEnd++;
  const isBreak = (item: ContentItem) => item.type === 'text' && item.text === '\\\n';
  const lined = cells.some(row => row.some(cell => {
    const items = cell.paragraphs[0];
    let end = items.length;
    while (end > 0 && isBreak(items[end - 1])) end--;
    return items.slice(0, end).some(isBreak);
  }));
  const pipe = () => headerEnd > 1 ? null : markdownTable(cells.map((row, ri) => ({ isHeader: ri === 0, cells: row })), 'pipe');
  const grid = () => markdownTable(cells.map((row, ri) => ({ isHeader: ri < headerEnd, cells: row })), 'grid');
  const markdown = lined ? grid() ?? pipe() : pipe() ?? grid();
  if (markdown === null) return null;
  // Padded as Expand Table pads a pipe table, as a grid table is
  return pad && markdown.startsWith('|') ? reflowTable(markdown).newText : markdown;
}

/**
 * Compacts a markdown table by removing padding whitespace.
 * Each cell is trimmed and separated by ` | ` with no extra padding.
 * Separator row uses minimal `---` (with alignment colons preserved).
 */
export function compactTable(text: string, separatorIndex?: number): TextTransformation {
  const parsed = parseTable(text, separatorIndex);
  if (parsed) {
    const { rows, columnWidths, alignments } = parsed;
    const columnCount = columnWidths.length;
    const formatCompactRow = (cells: string[]): string => {
      let line = '|';
      for (const cell of cells) {
        if (cell.length === 0) {
          line += ' |';
        } else {
          line += ' ' + cell + ' |';
        }
      }
      return line;
    };

    const formattedRows = rows.map(row => {
      if (row.isSeparator) {
        const cells = Array.from({ length: columnCount }, (_, i) => {
          const a = alignments[i] || 'default';
          switch (a) {
            case 'left': return ':---';
            case 'right': return '---:';
            case 'center': return ':---:';
            default: return '---';
          }
        });
        return formatCompactRow(cells);
      } else {
        const cells = Array.from({ length: columnCount }, (_, i) => row.cells[i] ?? '');
        return formatCompactRow(cells);
      }
    });

    return {
      newText: formattedRows.join('\n')
    };
  }

  const grid = parseGridTable(text);
  if (grid) {
    const lines: string[] = [];
    for (let i = 0; i < grid.rows.length; i++) {
      lines.push(formatGridBorderRow(grid.columnWidths, grid.borderStyles[i] || 'dash', grid.borderAligns[i]));
      lines.push(formatGridContentRow(grid.rows[i], grid.columnWidths, true));
    }
    lines.push(formatGridBorderRow(grid.columnWidths, grid.borderStyles[grid.rows.length] || 'dash', grid.borderAligns[grid.rows.length]));
    return { newText: lines.join('\n') };
  }

  const htmlCompact = convertHtmlTable(text, false);
  if (htmlCompact !== null) return { newText: htmlCompact };

  return { newText: text };
}

/**
 * Reflows a markdown table to ensure proper alignment and consistent spacing.
 * Implementation note: Preserve existing alignment/padding; only reflow when explicitly requested.
 * @param text - The table text to reflow
 * @returns TextTransformation with the reflowed table
 */
export function reflowTable(text: string, separatorIndex?: number): TextTransformation {
  const parsed = parseTable(text, separatorIndex);
  
  if (parsed) {
    const { rows, columnWidths, alignments } = parsed;
    
    // Format each row
    const formattedRows = rows.map(row => {
      if (row.isSeparator) {
        return formatSeparatorRow(columnWidths, alignments);
      } else {
        return formatContentRow(row.cells, columnWidths);
      }
    });
    
    return {
      newText: formattedRows.join('\n')
    };
  }

  const grid = parseGridTable(text);
  if (grid) {
    const lines: string[] = [];
    for (let i = 0; i < grid.rows.length; i++) {
      lines.push(formatGridBorderRow(grid.columnWidths, grid.borderStyles[i] || 'dash', grid.borderAligns[i]));
      lines.push(formatGridContentRow(grid.rows[i], grid.columnWidths, true));
    }
    lines.push(formatGridBorderRow(grid.columnWidths, grid.borderStyles[grid.rows.length] || 'dash', grid.borderAligns[grid.rows.length]));
    return { newText: lines.join('\n') };
  }

  const htmlReflow = convertHtmlTable(text, true);
  if (htmlReflow !== null) return { newText: htmlReflow };

  // Not a valid table, return original text
  return { newText: text };
}
