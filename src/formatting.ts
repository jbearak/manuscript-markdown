export interface TextTransformation {
  newText: string;
  cursorOffset?: number; // Optional cursor position relative to start
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
