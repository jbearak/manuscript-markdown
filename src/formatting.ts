import {
  extractHtmlTableRanges,
  extractStandaloneHtmlTable,
  type HtmlTableRun,
} from './html-table-parser';
import {
  computeCodeRegions,
  type CodeRegion,
} from './code-regions';

export interface TextTransformation {
  newText: string;
  cursorOffset?: number; // Optional cursor position relative to start
}

export function findTableRangeAtOffset(
  text: string,
  offset: number,
): CodeRegion | undefined {
  const lines: Array<CodeRegion & { contentEnd: number; text: string }> = [];
  for (let start = 0; start <= text.length;) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    const contentEnd = newline < 0
      ? text.length
      : newline > start && text[newline - 1] === '\r'
        ? newline - 1
        : newline;
    lines.push({ start, end, contentEnd, text: text.slice(start, contentEnd) });
    if (newline < 0) break;
    start = newline + 1;
  }
  const cursorLine = lines.findIndex(line => (
    line.start <= offset
    && (offset < line.end || (line.end === text.length && offset === text.length))
  ));
  if (cursorLine < 0) return undefined;
  const containsOffset = (range: CodeRegion): boolean => (
    range.start <= offset
    && (
      offset < range.end
      || (
        offset === range.end
        && (
          range.end === text.length
          || text[range.end] === '\r'
          || text[range.end] === '\n'
        )
      )
    )
  );

  const candidates: CodeRegion[] = [];
  if (isTableRow(lines[cursorLine].text)) {
    let startLine = cursorLine;
    let endLine = cursorLine;
    while (startLine > 0 && isTableRow(lines[startLine - 1].text)) startLine--;
    while (endLine + 1 < lines.length && isTableRow(lines[endLine + 1].text)) endLine++;
    const range = { start: lines[startLine].start, end: lines[endLine].contentEnd };
    const table = parseTable(text.slice(range.start, range.end));
    if (table?.rows.some(row => row.isSeparator)) candidates.push(range);
  }

  const gridLine = (line: string): boolean => {
    const trimmed = line.trim();
    return !trimmed || !!parseGridBorderSegments(trimmed) || /^\|.*\|$/.test(trimmed);
  };
  if (gridLine(lines[cursorLine].text)) {
    let regionStart = cursorLine;
    let regionEnd = cursorLine;
    while (regionStart > 0 && gridLine(lines[regionStart - 1].text)) regionStart--;
    while (regionEnd + 1 < lines.length && gridLine(lines[regionEnd + 1].text)) regionEnd++;

    let startLine: number | undefined;
    let columnCount = 0;
    let expectsRow = true;
    const gridCandidates: CodeRegion[] = [];
    for (let line = regionStart; line <= regionEnd; line++) {
      const trimmed = lines[line].text.trim();
      if (!trimmed) continue;

      const border = parseGridBorderSegments(trimmed);
      if (border) {
        if (
          startLine === undefined
          || expectsRow
          || border.length !== columnCount
        ) {
          startLine = line;
          columnCount = border.length;
          expectsRow = true;
        } else {
          gridCandidates.push({
            start: lines[startLine].start,
            end: lines[line].contentEnd,
          });
          expectsRow = true;
        }
        continue;
      }

      const row = parseGridRow(trimmed);
      if (
        startLine !== undefined
        && expectsRow
        && row?.length === columnCount
      ) {
        expectsRow = false;
      } else {
        startLine = undefined;
        columnCount = 0;
        expectsRow = true;
      }
    }
    gridCandidates.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const gridRange = gridCandidates.find(range => (
      containsOffset(range)
    ));
    if (gridRange) candidates.push(gridRange);
  }

  const codeRegions = computeCodeRegions(text);
  candidates.push(...extractHtmlTableRanges(text));
  return candidates
    .filter(range => (
      containsOffset(range)
      && !codeRegions.some(code => (
        code.start <= range.start && range.end <= code.end
      ))
    ))
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
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

/**
 * Parses markdown table text into structured data
 * @param text - The table text to parse
 * @returns ParsedTable object with rows and column widths, or null if not a valid table
 */
export function parseTable(text: string): ParsedTable | null {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  if (lines.length === 0) {
    return null;
  }
  
  // Check if all lines are valid table rows
  if (!lines.every(line => isTableRow(line))) {
    return null;
  }
  
  // Parse each line into a TableRow
  const rows: TableRow[] = lines.map(line => {
    const isSep = isSeparatorRow(line);
    
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
    if (segment.length === 0 || !/^[=-]+$/.test(segment)) {
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

  for (let i = 0; i < lines.length; i++) {
    if (i % 2 === 0) {
      const borderSegments = parseGridBorderSegments(lines[i]);
      if (!borderSegments || borderSegments.length !== columnCount) {
        return null;
      }
      borderStyles.push(borderSegments.some(segment => segment.includes('=')) ? 'equal' : 'dash');
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

  return { rows, columnWidths, borderStyles };
}

function formatGridBorderRow(columnWidths: number[], style: GridBorderStyle): string {
  const borderChar = style === 'equal' ? '=' : '-';
  const segments = columnWidths.map(width => borderChar.repeat(Math.max(width + 2, 3)));
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

function runsToMarkdown(runs: HtmlTableRun[]): string {
  const literalText = (run: HtmlTableRun): string => {
    if (run.code || !run.literalCharacters?.length) return run.text;
    const literalByOffset = new Map(
      run.literalCharacters.map(item => [item.offset, item.value]),
    );
    let text = '';
    for (let offset = 0; offset < run.text.length;) {
      if (run.text[offset] === '\\') {
        let end = offset + 1;
        while (run.text[end] === '\\') end++;
        if (literalByOffset.get(end) === '@') {
          text += '\\'.repeat((end - offset) * 2 + 1) + '@';
          offset = end + 1;
          continue;
        }
      }
      const literal = literalByOffset.get(offset);
      if (literal === '@') text += '\\@';
      else if (literal === '<') text += '&lt;';
      else if (literal === '>') text += '&gt;';
      else text += run.text[offset];
      offset++;
    }
    return text;
  };
  const sourceText = (run: HtmlTableRun): string => {
    const text = literalText(run);
    return run.type === 'citation'
      ? run.narrative
        ? '@' + text
        : run.text.startsWith('-@')
          ? '[' + text + ']'
          : '[@' + text + ']'
      : text;
  };
  const sameFormatting = (a: HtmlTableRun, b: HtmlTableRun): boolean =>
    !!a.bold === !!b.bold
    && !!a.italic === !!b.italic
    && !!a.strikethrough === !!b.strikethrough
    && !!a.underline === !!b.underline
    && !!a.superscript === !!b.superscript
    && !!a.subscript === !!b.subscript
    && !!a.code === !!b.code
    && a.href === b.href;
  const wrap = (text: string, run: HtmlTableRun): string => {
    if (run.code) {
      // Subtle bug guard: a fixed `` fence breaks content like ``test``.
      const backtickRuns = text.match(/`+/g) ?? [];
      const maxBacktickRun = backtickRuns.reduce((max, runText) => Math.max(max, runText.length), 0);
      const fence = '`'.repeat(maxBacktickRun + 1);
      const needsPadding = text.startsWith('`') || text.endsWith('`');
      const codeSpan = needsPadding
        ? fence + ' ' + text + ' ' + fence
        : fence + text + fence;
      return run.href
        ? '[' + codeSpan + '](' + formatHrefForMarkdown(run.href) + ')'
        : codeSpan;
    }
    let wrapped = text;
    if (run.bold) wrapped = '**' + wrapped + '**';
    if (run.italic) wrapped = '*' + wrapped + '*';
    if (run.strikethrough) wrapped = '~~' + wrapped + '~~';
    if (run.underline) wrapped = '[' + wrapped + ']{.underline}';
    if (run.superscript) wrapped = '<sup>' + wrapped + '</sup>';
    if (run.subscript) wrapped = '<sub>' + wrapped + '</sub>';
    if (run.href) wrapped = '[' + wrapped + '](' + formatHrefForMarkdown(run.href) + ')';
    return wrapped;
  };

  let result = '';
  for (let index = 0; index < runs.length;) {
    const run = runs[index];
    if (run.type === 'softbreak' || run.type === 'hardbreak') {
      // Grid table cells treat bare newlines as hard breaks, so no backslash needed.
      result += '\n';
      index++;
      continue;
    }

    let text = sourceText(run);
    let next = index + 1;
    while (
      next < runs.length
      && (runs[next].type === 'text' || runs[next].type === 'citation')
      && sameFormatting(run, runs[next])
    ) {
      text += sourceText(runs[next]);
      next++;
    }
    result += wrap(text, run);
    index = next;
  }
  return result;
}

function formatHrefForMarkdown(href: string): string {
  return /[()\[\]\s]/.test(href) ? `<${href}>` : href;
}

function escapePipesForMarkdownTableCell(text: string): string {
  // Ensure each literal pipe has an odd number of preceding backslashes so
  // splitOnPipes treats it as cell content, not a delimiter.
  return text.replace(/(\\*)\|/g, (_m, slashes: string) => {
    return slashes.length % 2 === 0 ? slashes + '\\|' : slashes + '|';
  });
}

function convertHtmlTable(text: string, pad: boolean): string | null {
  const table = extractStandaloneHtmlTable(text);
  // Mixed text/table selections and structurally unclosed tables stay unchanged.
  if (!table) return null;
  const rows = table.rows;

  // Reject colspan/rowspan
  for (const row of rows) {
    for (const cell of row.cells) {
      if ((cell.colspan && cell.colspan > 1) || (cell.rowspan && cell.rowspan > 1)) return null;
    }
  }

  // Convert cells to markdown text
  const mdRows: { cells: string[]; header: boolean }[] = rows.map(row => ({
    cells: row.cells.map(cell => runsToMarkdown(cell.runs)),
    header: row.header,
  }));

  // Only a contiguous leading run of HTML header rows can be represented as a
  // table header. Later <th> rows retain their source position as body rows.
  let leadingHeaderRows = 0;
  while (
    leadingHeaderRows < mdRows.length
    && mdRows[leadingHeaderRows].header
  ) leadingHeaderRows++;
  const normalizedRows = mdRows.map((row, index) => ({
    ...row,
    header: index < leadingHeaderRows,
  }));

  // Pipe tables can represent only one header row immediately before their
  // delimiter. Use a grid table when the HTML has richer row structure.
  const hasMultiLine = normalizedRows.some(row => (
    row.cells.some(cell => cell.includes('\n'))
  ));
  if (hasMultiLine || leadingHeaderRows > 1) {
    return buildGridTable(normalizedRows, pad);
  }
  return buildPipeTable(normalizedRows, pad);
}

function buildPipeTable(mdRows: { cells: string[]; header: boolean }[], pad: boolean): string {
  if (mdRows.length === 0) return '';
  const colCount = Math.max(...mdRows.map(r => r.cells.length));
  if (colCount <= 0) return '';
  // Escape pipes in cell text
  const escaped = mdRows.map(row => ({
    ...row,
    cells: Array.from({ length: colCount }, (_, i) =>
      escapePipesForMarkdownTableCell(row.cells[i] ?? '')
    ),
  }));
  if (escaped.length === 0) return '';
  // Preserve source order: only leading header-flagged rows are header rows.
  let headerEnd = 0;
  while (headerEnd < escaped.length && escaped[headerEnd].header) headerEnd++;
  if (headerEnd === 0) headerEnd = 1;
  const finalHeader = escaped.slice(0, headerEnd);
  const finalBody = escaped.slice(headerEnd);

  const allRows = [...finalHeader, ...finalBody];

  if (pad) {
    const colWidths = new Array(colCount).fill(3);
    for (const row of allRows) {
      for (let i = 0; i < colCount; i++) {
        colWidths[i] = Math.max(colWidths[i], row.cells[i].length);
      }
    }
    const lines: string[] = [];
    for (const row of finalHeader) {
      lines.push(formatContentRow(row.cells, colWidths));
    }
    lines.push(formatSeparatorRow(colWidths));
    for (const row of finalBody) {
      lines.push(formatContentRow(row.cells, colWidths));
    }
    return lines.join('\n');
  } else {
    const fmtRow = (cells: string[]): string => {
      let line = '|';
      for (const cell of cells) {
        line += (cell.length === 0 ? ' |' : ' ' + cell + ' |');
      }
      return line;
    };
    const lines: string[] = [];
    for (const row of finalHeader) {
      lines.push(fmtRow(row.cells));
    }
    const sepCells = Array.from({ length: colCount }, () => '---');
    lines.push(fmtRow(sepCells));
    for (const row of finalBody) {
      lines.push(fmtRow(row.cells));
    }
    return lines.join('\n');
  }
}

function buildGridTable(mdRows: { cells: string[]; header: boolean }[], pad: boolean): string {
  if (mdRows.length === 0) return '';
  const colCount = Math.max(...mdRows.map(r => r.cells.length));
  if (colCount <= 0) return '';
  // Split each cell into lines
  const splitRows = mdRows.map(row => ({
    header: row.header,
    cellLines: Array.from({ length: colCount }, (_, i) =>
      escapePipesForMarkdownTableCell(row.cells[i] ?? '').split('\n')
    ),
  }));

  // Compute column widths
  const colWidths = new Array(colCount).fill(1);
  for (const row of splitRows) {
    for (let c = 0; c < colCount; c++) {
      for (const line of row.cellLines[c]) {
        colWidths[c] = Math.max(colWidths[c], line.length);
      }
    }
  }

  const borderRow = (style: GridBorderStyle): string => formatGridBorderRow(colWidths, style);

  const lines: string[] = [];
  for (let r = 0; r < splitRows.length; r++) {
    const row = splitRows[r];
    const prevIsHeader = r > 0 && splitRows[r - 1].header;
    // Border before this row
    if (r === 0) {
      lines.push(borderRow('dash'));
    } else {
      lines.push(borderRow(prevIsHeader && !row.header ? 'equal' : 'dash'));
    }
    // Content lines for this row
    const maxLines = Math.max(...row.cellLines.map(cl => cl.length));
    for (let l = 0; l < maxLines; l++) {
      const cells = row.cellLines.map((cl, c) => {
        const text = cl[l] ?? '';
        return pad ? text.padEnd(colWidths[c]) : text;
      });
      lines.push('| ' + cells.join(' | ') + ' |');
    }
  }
  // Final border
  const lastIsHeader = splitRows[splitRows.length - 1]?.header;
  lines.push(borderRow(lastIsHeader ? 'equal' : 'dash'));

  return lines.join('\n');
}

/**
 * Compacts a markdown table by removing padding whitespace.
 * Each cell is trimmed and separated by ` | ` with no extra padding.
 * Separator row uses minimal `---` (with alignment colons preserved).
 */
export function compactTable(text: string): TextTransformation {
  const parsed = parseTable(text);
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
      lines.push(formatGridBorderRow(grid.columnWidths, grid.borderStyles[i] || 'dash'));
      lines.push(formatGridContentRow(grid.rows[i], grid.columnWidths, true));
    }
    lines.push(formatGridBorderRow(grid.columnWidths, grid.borderStyles[grid.rows.length] || 'dash'));
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
export function reflowTable(text: string): TextTransformation {
  const parsed = parseTable(text);
  
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
      lines.push(formatGridBorderRow(grid.columnWidths, grid.borderStyles[i] || 'dash'));
      lines.push(formatGridContentRow(grid.rows[i], grid.columnWidths, true));
    }
    lines.push(formatGridBorderRow(grid.columnWidths, grid.borderStyles[grid.rows.length] || 'dash'));
    return { newText: lines.join('\n') };
  }

  const htmlReflow = convertHtmlTable(text, true);
  if (htmlReflow !== null) return { newText: htmlReflow };

  // Not a valid table, return original text
  return { newText: text };
}
