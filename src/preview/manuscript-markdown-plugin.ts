import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import { VALID_COLOR_IDS, getDefaultHighlightColor } from '../highlight-colors';

/**
 * Defines a Manuscript Markdown pattern configuration
 */
interface manuscriptMarkdownPattern {
  name: string;           // Pattern identifier (e.g., 'addition', 'deletion')
  regex: RegExp;          // Regular expression to match the pattern
  cssClass: string;       // CSS class to apply to rendered HTML
  htmlTag: string;        // HTML tag to use for wrapping content
}

/**
 * Pattern configurations for all five Manuscript Markdown types
 * Note: Using .*? instead of .+? to allow empty patterns
 */
const patterns: manuscriptMarkdownPattern[] = [
  { 
    name: 'addition', 
    regex: /\{\+\+(.*?)\+\+\}/gs, 
    cssClass: 'manuscript-markdown-addition', 
    htmlTag: 'ins' 
  },
  { 
    name: 'deletion', 
    regex: /\{--(.*?)--\}/gs, 
    cssClass: 'manuscript-markdown-deletion', 
    htmlTag: 'del' 
  },
  { 
    name: 'substitution', 
    regex: /\{~~(.*?)~>(.*?)~~\}/gs, 
    cssClass: 'manuscript-markdown-substitution', 
    htmlTag: 'span' 
  },
  { 
    name: 'comment', 
    regex: /\{>>(.*?)<<\}/gs, 
    cssClass: 'manuscript-markdown-comment', 
    htmlTag: 'span' 
  },
  { 
    name: 'highlight', 
    regex: /\{==(.*?)==\}/gs, 
    cssClass: 'manuscript-markdown-highlight', 
    htmlTag: 'mark' 
  }
];

/**
 * Helper function to add parsed inline content tokens to the state
 * @param state - The inline parsing state
 * @param content - The content to parse
 */
function addInlineContent(state: StateInline, content: string): void {
  // Handle empty content - no tokens to add
  if (content.length === 0) {
    return;
  }
  
  // Parse the content to get child tokens
  const childTokens: any[] = [];
  state.md.inline.parse(content, state.md, state.env, childTokens);
  
  // Add each child token to the state
  for (const childToken of childTokens) {
    const token = state.push(childToken.type, childToken.tag, childToken.nesting);
    token.content = childToken.content;
    token.markup = childToken.markup;
    if (childToken.attrs) {
      for (const [key, value] of childToken.attrs) {
        token.attrSet(key, value);
      }
    }
    if (childToken.children) {
      token.children = childToken.children;
    }
  }
}

/**
 * Block-level rule that identifies Manuscript Markdown patterns before paragraph parsing
 * This prevents markdown-it from splitting patterns at empty lines
 * 
 * LIMITATION: Only detects patterns that start at the beginning of a line.
 * Patterns that start mid-line with multi-line content will not be handled by this rule
 * and will be split by markdown-it's paragraph parser.
 * 
 * @param state - The block parsing state
 * @param startLine - Starting line number
 * @param endLine - Ending line number
 * @param silent - Whether to only check without creating tokens
 * @returns true if a Manuscript Markdown block was found and processed
 */
function manuscriptMarkdownBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  
  // Quick check: does this line start with a potential Manuscript Markdown pattern?
  if (pos + 3 > max) return false;
  
  const src = state.src;
  const lineStart = src.slice(pos, Math.min(pos + 3, max));
  
  // Check if this line starts with a Manuscript Markdown opening marker
  const patterns = ['{++', '{--', '{~~', '{>>', '{=='];
  if (!patterns.includes(lineStart)) {
    return false;
  }
  
  // Determine the closing marker
  let closeMarker: string;
  if (lineStart === '{++') closeMarker = '++}';
  else if (lineStart === '{--') closeMarker = '--}';
  else if (lineStart === '{~~') closeMarker = '~~}';
  else if (lineStart === '{>>') closeMarker = '<<}';
  else if (lineStart === '{==') closeMarker = '==}';
  else return false;
  
  // Search for the closing marker starting from current position
  const searchStart = pos + 3;
  let closePos = src.indexOf(closeMarker, searchStart);
  if (closePos === -1) {
    return false;
  }
  
  // Check if the pattern contains any newlines (making it multi-line)
  const patternContent = src.slice(pos, closePos + closeMarker.length);
  const hasNewline = patternContent.includes('\n');
  
  if (!hasNewline) {
    // Single-line pattern, let the inline parser handle it
    return false;
  }
  
  // Find which line the closing marker is on
  const patternEnd = closePos + closeMarker.length;
  let nextLine = startLine;
  
  // Scan through lines to find where the pattern ends
  while (nextLine < endLine) {
    const lineEnd = state.eMarks[nextLine];
    if (lineEnd >= patternEnd) {
      // The pattern ends on or before this line
      nextLine++;
      break;
    }
    nextLine++;
  }
  
  if (silent) return true;
  
  // Create a paragraph token that contains the entire Manuscript Markdown pattern
  const token = state.push('paragraph_open', 'p', 1);
  token.map = [startLine, nextLine];
  
  const contentToken = state.push('inline', '', 0);
  contentToken.content = patternContent;
  contentToken.map = [startLine, nextLine];
  contentToken.children = [];
  
  state.push('paragraph_close', 'p', -1);
  
  // Advance state.line to skip all lines we've consumed
  state.line = nextLine;
  return true;
}

/**
 * Inline rule for ==highlight== patterns (not CriticMarkup)
 * @param state - The inline parsing state
 * @param silent - Whether to only check without creating tokens
 * @returns true if a pattern was found and processed
 */
function parseFormatHighlight(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  const src = state.src;
  const resolveDefaultColor = (): string => {
    const color = getDefaultHighlightColor();
    return VALID_COLOR_IDS.includes(color) ? color : 'yellow';
  };

  // Check if we're at ==
  if (src.charCodeAt(start) !== 0x3D /* = */ || src.charCodeAt(start + 1) !== 0x3D /* = */) {
    return false;
  }

  // Check if preceded by { (to avoid matching CriticMarkup {==...==})
  if (start > 0 && src.charCodeAt(start - 1) === 0x7B /* { */) {
    return false;
  }

  // Find closing ==
  let pos = start + 2;
  while (pos < max) {
    if (src.charCodeAt(pos) === 0x3D /* = */ && pos + 1 < max && src.charCodeAt(pos + 1) === 0x3D /* = */) {
      // Check if followed by } (to avoid matching CriticMarkup {==...==})
      if (pos + 2 < max && src.charCodeAt(pos + 2) === 0x7D /* } */) {
        pos += 2;
        continue;
      }
      
      // Found closing ==
      if (!silent) {
        const content = src.slice(start + 2, pos);
        const tokenOpen = state.push('manuscript_markdown_format_highlight_open', 'mark', 1);
        
        // Check for optional {color} suffix after closing ==
        let cssClass = 'manuscript-markdown-format-highlight';
        let endPos = pos + 2;
        let hasColorSuffix = false;
        if (pos + 2 < max && src.charCodeAt(pos + 2) === 0x7B /* { */) {
          const closeBrace = src.indexOf('}', pos + 3);
          if (closeBrace !== -1 && closeBrace < max) {
            const colorId = src.slice(pos + 3, closeBrace);
            if (/^[a-z0-9-]+$/.test(colorId)) {
              hasColorSuffix = true;
              if (VALID_COLOR_IDS.includes(colorId)) {
                cssClass = 'manuscript-markdown-format-highlight manuscript-markdown-highlight-' + colorId;
              } else {
                const defaultColor = resolveDefaultColor();
                if (defaultColor !== 'yellow') {
                  cssClass = 'manuscript-markdown-format-highlight manuscript-markdown-highlight-' + defaultColor;
                }
              }
              endPos = closeBrace + 1;
            }
          }
        }
        if (!hasColorSuffix && cssClass === 'manuscript-markdown-format-highlight') {
          // Apply configurable default color only for ==text== without color suffix
          const defaultColor = resolveDefaultColor();
          if (defaultColor !== 'yellow') {
            cssClass = 'manuscript-markdown-format-highlight manuscript-markdown-highlight-' + defaultColor;
          }
        }
        tokenOpen.attrSet('class', cssClass);
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);
        
        state.push('manuscript_markdown_format_highlight_close', 'mark', -1);
        state.pos = endPos;
      } else {
        // In silent mode, still need to advance past {color} suffix
        let endPos = pos + 2;
        if (pos + 2 < max && src.charCodeAt(pos + 2) === 0x7B /* { */) {
          const closeBrace = src.indexOf('}', pos + 3);
          if (closeBrace !== -1 && closeBrace <= max) {
            const colorId = src.slice(pos + 3, closeBrace);
            if (/^[a-z0-9-]+$/.test(colorId)) {
              endPos = closeBrace + 1;
            }
          }
        }
        state.pos = endPos;
      }
      return true;
    }
    pos++;
  }

  return false;
}

/**
 * Inline rule function that scans for Manuscript Markdown patterns and creates tokens
 * @param state - The inline parsing state
 * @param silent - Whether to only check without creating tokens
 * @returns true if a pattern was found and processed
 */
function parseManuscriptMarkdown(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  const src = state.src;

  // Check if we're at a potential Manuscript Markdown start
  if (src.charCodeAt(start) !== 0x7B /* { */) {
    return false;
  }

  // Check for addition {++text++}
  if (src.charCodeAt(start + 1) === 0x2B /* + */ && src.charCodeAt(start + 2) === 0x2B /* + */) {
    const endMarker = '++}';
    const endPos = src.indexOf(endMarker, start + 3);
    if (endPos !== -1) {
      if (!silent) {
        const content = src.slice(start + 3, endPos);
        const tokenOpen = state.push('manuscript_markdown_addition_open', 'ins', 1);
        tokenOpen.attrSet('class', 'manuscript-markdown-addition');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);
        
        state.push('manuscript_markdown_addition_close', 'ins', -1);
      }
      state.pos = endPos + endMarker.length;
      return true;
    }
  }

  // Check for deletion {--text--}
  if (src.charCodeAt(start + 1) === 0x2D /* - */ && src.charCodeAt(start + 2) === 0x2D /* - */) {
    const endMarker = '--}';
    const endPos = src.indexOf(endMarker, start + 3);
    if (endPos !== -1) {
      if (!silent) {
        const content = src.slice(start + 3, endPos);
        const tokenOpen = state.push('manuscript_markdown_deletion_open', 'del', 1);
        tokenOpen.attrSet('class', 'manuscript-markdown-deletion');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);
        
        state.push('manuscript_markdown_deletion_close', 'del', -1);
      }
      state.pos = endPos + endMarker.length;
      return true;
    }
  }

  // Check for substitution {~~old~>new~~}
  if (src.charCodeAt(start + 1) === 0x7E /* ~ */ && src.charCodeAt(start + 2) === 0x7E /* ~ */) {
    const endMarker = '~~}';
    const endPos = src.indexOf(endMarker, start + 3);
    if (endPos !== -1) {
      const fullContent = src.slice(start + 3, endPos);
      const separatorPos = fullContent.indexOf('~>');
      if (separatorPos !== -1) {
        if (!silent) {
          const oldText = fullContent.slice(0, separatorPos);
          const newText = fullContent.slice(separatorPos + 2);
          
          const tokenOpen = state.push('manuscript_markdown_substitution_open', 'span', 1);
          tokenOpen.attrSet('class', 'manuscript-markdown-substitution');
          
          // Old text with deletion styling
          const tokenOldOpen = state.push('manuscript_markdown_substitution_old_open', 'del', 1);
          tokenOldOpen.attrSet('class', 'manuscript-markdown-deletion');
          
          // Add parsed inline content to allow nested Markdown processing
          addInlineContent(state, oldText);
          
          state.push('manuscript_markdown_substitution_old_close', 'del', -1);
          
          // New text with addition styling
          const tokenNewOpen = state.push('manuscript_markdown_substitution_new_open', 'ins', 1);
          tokenNewOpen.attrSet('class', 'manuscript-markdown-addition');
          
          // Add parsed inline content to allow nested Markdown processing
          addInlineContent(state, newText);
          
          state.push('manuscript_markdown_substitution_new_close', 'ins', -1);
          
          state.push('manuscript_markdown_substitution_close', 'span', -1);
        }
        state.pos = endPos + endMarker.length;
        return true;
      }
    }
  }

  // Check for comment {>>text<<}
  if (src.charCodeAt(start + 1) === 0x3E /* > */ && src.charCodeAt(start + 2) === 0x3E /* > */) {
    const endMarker = '<<}';
    const endPos = src.indexOf(endMarker, start + 3);
    if (endPos !== -1) {
      if (!silent) {
        const content = src.slice(start + 3, endPos);
        const tokenOpen = state.push('manuscript_markdown_comment_open', 'span', 1);
        tokenOpen.attrSet('class', 'manuscript-markdown-comment');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);
        
        state.push('manuscript_markdown_comment_close', 'span', -1);
      }
      state.pos = endPos + endMarker.length;
      return true;
    }
  }

  // Check for highlight {==text==}
  if (src.charCodeAt(start + 1) === 0x3D /* = */ && src.charCodeAt(start + 2) === 0x3D /* = */) {
    const endMarker = '==}';
    const endPos = src.indexOf(endMarker, start + 3);
    if (endPos !== -1) {
      if (!silent) {
        const content = src.slice(start + 3, endPos);
        const tokenOpen = state.push('manuscript_markdown_highlight_open', 'mark', 1);
        tokenOpen.attrSet('class', 'manuscript-markdown-highlight');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);
        
        state.push('manuscript_markdown_highlight_close', 'mark', -1);
      }
      state.pos = endPos + endMarker.length;
      return true;
    }
  }

  return false;
}

// Placeholder used to preserve paragraph breaks inside CriticMarkup spans
const PARA_PLACEHOLDER = '\u0000PARA\u0000';

/**
 * Preprocess markdown source: replace \n\n inside CriticMarkup spans with a
 * placeholder so markdown-it's block parser doesn't split them into separate
 * paragraphs.
 */
function preprocessCriticMarkup(markdown: string): string {
  if (!markdown.includes('{++') && !markdown.includes('{--') &&
      !markdown.includes('{~~') && !markdown.includes('{>>') &&
      !markdown.includes('{==')) {
    return markdown;
  }

  const markers: Array<{ open: string; close: string }> = [
    { open: '{++', close: '++}' },
    { open: '{--', close: '--}' },
    { open: '{~~', close: '~~}' },
    { open: '{>>', close: '<<}' },
    { open: '{==', close: '==}' },
  ];

  let result = markdown;
  for (const { open, close } of markers) {
    let searchFrom = 0;
    while (true) {
      const openIdx = result.indexOf(open, searchFrom);
      if (openIdx === -1) break;
      const contentStart = openIdx + open.length;
      const closeIdx = result.indexOf(close, contentStart);
      if (closeIdx === -1) {
        searchFrom = contentStart;
        continue;
      }
      const content = result.slice(contentStart, closeIdx);
      if (content.includes('\n\n')) {
        const replaced = content.replace(/\n\n/g, PARA_PLACEHOLDER);
        result = result.slice(0, contentStart) + replaced + result.slice(closeIdx);
        searchFrom = contentStart + replaced.length + close.length;
      } else {
        searchFrom = closeIdx + close.length;
      }
    }
  }
  return result;
}

/** Inline rule that converts the paragraph placeholder back into line breaks in the token stream. */
function paraPlaceholderRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0) return false; // \u0000
  if (!state.src.startsWith(PARA_PLACEHOLDER, start)) return false;

  if (!silent) {
    state.push('softbreak', 'br', 0);
    state.push('softbreak', 'br', 0);
  }
  state.pos = start + PARA_PLACEHOLDER.length;
  return true;
}

/**
 * Main plugin function that registers Manuscript Markdown parsing with markdown-it
 * @param md - The MarkdownIt instance to extend
 */
export function manuscriptMarkdownPlugin(md: MarkdownIt): void {
  // Preprocess source before block parsing to handle multi-paragraph CriticMarkup
  md.core.ruler.before('normalize', 'manuscript_markdown_preprocess', (state: any) => {
    state.src = preprocessCriticMarkup(state.src);
  });

  // Register the block-level rule to handle multi-line patterns with empty lines
  // This must run very early, before heading and paragraph parsing
  md.block.ruler.before('heading', 'manuscript_markdown_block', manuscriptMarkdownBlock);

  // Register inline rule for paragraph placeholder (before other inline rules)
  md.inline.ruler.before('emphasis', 'para_placeholder', paraPlaceholderRule);

  // Register the inline rule for Manuscript Markdown parsing
  // Run before emphasis and other inline rules to handle Manuscript Markdown first
  md.inline.ruler.before('emphasis', 'manuscript_markdown', parseManuscriptMarkdown);
  
  // Register the inline rule for ==highlight== patterns
  // Run after Manuscript Markdown to avoid conflicts with {==...==}
  md.inline.ruler.after('manuscript_markdown', 'manuscript_markdown_format_highlight', parseFormatHighlight);
  
  // Register renderers for each Manuscript Markdown token type
  for (const pattern of patterns) {
    md.renderer.rules[`manuscript_markdown_${pattern.name}_open`] = (tokens, idx) => {
      const token = tokens[idx];
      const className = token.attrGet('class') || pattern.cssClass;
      return `<${pattern.htmlTag} class="${className}">`;
    };
    
    md.renderer.rules[`manuscript_markdown_${pattern.name}_close`] = (tokens, idx) => {
      const token = tokens[idx];
      return `</${token.tag}>`;
    };
  }
  
  // Special renderers for substitution sub-parts
  md.renderer.rules['manuscript_markdown_substitution_old_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || '';
    return `<del class="${className}">`;
  };
  
  md.renderer.rules['manuscript_markdown_substitution_old_close'] = () => {
    return '</del>';
  };
  
  md.renderer.rules['manuscript_markdown_substitution_new_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || '';
    return `<ins class="${className}">`;
  };
  
  md.renderer.rules['manuscript_markdown_substitution_new_close'] = () => {
    return '</ins>';
  };
  
  // Renderer for ==highlight== patterns
  md.renderer.rules['manuscript_markdown_format_highlight_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || 'manuscript-markdown-format-highlight';
    return `<mark class="${className}">`;
  };
  
  md.renderer.rules['manuscript_markdown_format_highlight_close'] = () => {
    return '</mark>';
  };
}
