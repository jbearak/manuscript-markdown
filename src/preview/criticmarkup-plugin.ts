import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';

/**
 * Defines a CriticMarkup pattern configuration
 */
interface CriticMarkupPattern {
  name: string;           // Pattern identifier (e.g., 'addition', 'deletion')
  regex: RegExp;          // Regular expression to match the pattern
  cssClass: string;       // CSS class to apply to rendered HTML
  htmlTag: string;        // HTML tag to use for wrapping content
}

/**
 * Pattern configurations for all five CriticMarkup types
 * Note: Using .*? instead of .+? to allow empty patterns
 */
const patterns: CriticMarkupPattern[] = [
  { 
    name: 'addition', 
    regex: /\{\+\+(.*?)\+\+\}/gs, 
    cssClass: 'criticmarkup-addition', 
    htmlTag: 'ins' 
  },
  { 
    name: 'deletion', 
    regex: /\{--(.*?)--\}/gs, 
    cssClass: 'criticmarkup-deletion', 
    htmlTag: 'del' 
  },
  { 
    name: 'substitution', 
    regex: /\{~~(.*?)~>(.*?)~~\}/gs, 
    cssClass: 'criticmarkup-substitution', 
    htmlTag: 'span' 
  },
  { 
    name: 'comment', 
    regex: /\{>>(.*?)<<\}/gs, 
    cssClass: 'criticmarkup-comment', 
    htmlTag: 'span' 
  },
  { 
    name: 'highlight', 
    regex: /\{==(.*?)==\}/gs, 
    cssClass: 'criticmarkup-highlight', 
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
 * Block-level rule that identifies CriticMarkup patterns before paragraph parsing
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
 * @returns true if a CriticMarkup block was found and processed
 */
function criticmarkupBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  
  // Quick check: does this line start with a potential CriticMarkup pattern?
  if (pos + 3 > max) return false;
  
  const src = state.src;
  const lineStart = src.slice(pos, Math.min(pos + 3, max));
  
  // Check if this line starts with a CriticMarkup opening marker
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
  
  // Create a paragraph token that contains the entire CriticMarkup pattern
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
 * Inline rule function that scans for CriticMarkup patterns and creates tokens
 * @param state - The inline parsing state
 * @param silent - Whether to only check without creating tokens
 * @returns true if a pattern was found and processed
 */
function parseCriticMarkup(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  const src = state.src;

  // Check if we're at a potential CriticMarkup start
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
        const tokenOpen = state.push('criticmarkup_addition_open', 'ins', 1);
        tokenOpen.attrSet('class', 'criticmarkup-addition');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);
        
        state.push('criticmarkup_addition_close', 'ins', -1);
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
        const tokenOpen = state.push('criticmarkup_deletion_open', 'del', 1);
        tokenOpen.attrSet('class', 'criticmarkup-deletion');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);
        
        state.push('criticmarkup_deletion_close', 'del', -1);
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
          
          const tokenOpen = state.push('criticmarkup_substitution_open', 'span', 1);
          tokenOpen.attrSet('class', 'criticmarkup-substitution');
          
          // Old text with deletion styling
          const tokenOldOpen = state.push('criticmarkup_substitution_old_open', 'del', 1);
          tokenOldOpen.attrSet('class', 'criticmarkup-deletion');
          
          // Add parsed inline content to allow nested Markdown processing
          addInlineContent(state, oldText);
          
          state.push('criticmarkup_substitution_old_close', 'del', -1);
          
          // New text with addition styling
          const tokenNewOpen = state.push('criticmarkup_substitution_new_open', 'ins', 1);
          tokenNewOpen.attrSet('class', 'criticmarkup-addition');
          
          // Add parsed inline content to allow nested Markdown processing
          addInlineContent(state, newText);
          
          state.push('criticmarkup_substitution_new_close', 'ins', -1);
          
          state.push('criticmarkup_substitution_close', 'span', -1);
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
        const tokenOpen = state.push('criticmarkup_comment_open', 'span', 1);
        tokenOpen.attrSet('class', 'criticmarkup-comment');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);
        
        state.push('criticmarkup_comment_close', 'span', -1);
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
        const tokenOpen = state.push('criticmarkup_highlight_open', 'mark', 1);
        tokenOpen.attrSet('class', 'criticmarkup-highlight');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);
        
        state.push('criticmarkup_highlight_close', 'mark', -1);
      }
      state.pos = endPos + endMarker.length;
      return true;
    }
  }

  return false;
}

/**
 * Main plugin function that registers CriticMarkup parsing with markdown-it
 * @param md - The MarkdownIt instance to extend
 */
export function criticmarkupPlugin(md: MarkdownIt): void {
  // Register the block-level rule to handle multi-line patterns with empty lines
  // This must run very early, before heading and paragraph parsing
  md.block.ruler.before('heading', 'criticmarkup_block', criticmarkupBlock);
  
  // Register the inline rule for CriticMarkup parsing
  // Run before emphasis and other inline rules to handle CriticMarkup first
  md.inline.ruler.before('emphasis', 'criticmarkup', parseCriticMarkup);
  
  // Register renderers for each CriticMarkup token type
  for (const pattern of patterns) {
    md.renderer.rules[`criticmarkup_${pattern.name}_open`] = (tokens, idx) => {
      const token = tokens[idx];
      const className = token.attrGet('class') || pattern.cssClass;
      return `<${pattern.htmlTag} class="${className}">`;
    };
    
    md.renderer.rules[`criticmarkup_${pattern.name}_close`] = (tokens, idx) => {
      const token = tokens[idx];
      return `</${token.tag}>`;
    };
  }
  
  // Special renderers for substitution sub-parts
  md.renderer.rules['criticmarkup_substitution_old_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || '';
    return `<del class="${className}">`;
  };
  
  md.renderer.rules['criticmarkup_substitution_old_close'] = () => {
    return '</del>';
  };
  
  md.renderer.rules['criticmarkup_substitution_new_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || '';
    return `<ins class="${className}">`;
  };
  
  md.renderer.rules['criticmarkup_substitution_new_close'] = () => {
    return '</ins>';
  };
}
