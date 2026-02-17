export interface TextTransformation {
  newText: string;
  cursorOffset?: number; // Optional cursor position relative to start
}

export function wrapColoredHighlight(text: string, color: string): TextTransformation {
  return { newText: '==' + text + '=={' + color + '}' };
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
    const authorPrefix = `${authorName}: `;
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
  const authorPrefix = authorName ? `${authorName}: ` : '';
  const withComment = highlighted + `{>>${authorPrefix}<<}`;
  const cursorOffset = highlighted.length + 3 + authorPrefix.length; // Position after author prefix
  
  return {
    newText: withComment,
    cursorOffset
  };
}


/**
 * Wraps text with ID-based comment syntax: {#id}text{/id}{#id>>author: <<}
 * Used when alwaysUseCommentIds is enabled.
 * @param text - The text to comment on
 * @param authorName - Optional author name to include in comment
 * @returns TextTransformation with ID-based comment syntax, cursor positioned in comment
 */
export function highlightAndCommentWithId(text: string, authorName?: string | null): TextTransformation {
  // Generate a simple numeric ID (the user can rename it)
  const id = '1';
  const rangeStart = `{#${id}}`;
  const rangeEnd = `{/${id}}`;
  const authorPrefix = authorName ? `${authorName}: ` : '';
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
  const authorPrefix = authorName ? `${authorName}: ` : '';
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
  const authorPrefix = authorName ? `${authorName}: ` : '';
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
  const authorPrefix = authorName ? `${authorName}: ` : '';
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
  
  // Must start and end with |
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return false;
  }
  
  // Must contain at least one | separator (meaning at least 2 | total)
  const pipeCount = (trimmed.match(/\|/g) || []).length;
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
  const cells = trimmed.slice(1, -1).split('|');
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
    
    // Extract cells by splitting on | and removing first/last empty elements
    const parts = line.split('|');
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

/**
 * Reflows a markdown table to ensure proper alignment and consistent spacing
 * @param text - The table text to reflow
 * @returns TextTransformation with the reflowed table
 */
export function reflowTable(text: string): TextTransformation {
  const parsed = parseTable(text);
  
  if (!parsed) {
    // Not a valid table, return original text
    return { newText: text };
  }
  
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
