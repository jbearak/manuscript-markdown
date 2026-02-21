import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import { VALID_COLOR_IDS, getDefaultHighlightColor } from '../highlight-colors';
import { PARA_PLACEHOLDER, preprocessCriticMarkup, findMatchingClose } from '../critic-markup';
import { wrapBareLatexEnvironments } from '../latex-env-preprocess';

/** Escape HTML special characters for use in attribute values */
function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
  
  // Quick check: first char must be {
  if (src.charCodeAt(pos) !== 0x7B /* { */) return false;
  
  const ch2 = src.charCodeAt(pos + 1);
  const ch3 = src.charCodeAt(pos + 2);
  
  let closeMarker: string;
  let isNested = false;
  if (ch2 === 0x2B /* + */ && ch3 === 0x2B /* + */) closeMarker = '++}';
  else if (ch2 === 0x2D /* - */ && ch3 === 0x2D /* - */) closeMarker = '--}';
  else if (ch2 === 0x7E /* ~ */ && ch3 === 0x7E /* ~ */) closeMarker = '~~}';
  else if (ch2 === 0x3E /* > */ && ch3 === 0x3E /* > */) { closeMarker = '<<}'; isNested = true; }
  else if (ch2 === 0x3D /* = */ && ch3 === 0x3D /* = */) closeMarker = '==}';
  else return false;
  
  // Search for the closing marker starting from current position
  const searchStart = pos + 3;
  let closePos: number;
  if (isNested) {
    // Use depth-aware matching so nested {>>...<<} replies don't close early
    closePos = findMatchingClose(src, searchStart);
  } else {
    closePos = src.indexOf(closeMarker, searchStart);
  }
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
        // Implementation note: Only treat {…} as a color suffix when the closing } is within
        // parse bounds and the identifier matches [a-z0-9](?:[a-z0-9-]*[a-z0-9])? (no
        // leading/trailing -); otherwise keep as literal text so adjacent CriticMarkup
        // (e.g. {--…--}) is not swallowed as a color suffix.
        let cssClass = 'manuscript-markdown-format-highlight';
        let endPos = pos + 2;
        let hasColorSuffix = false;
        if (pos + 2 < max && src.charCodeAt(pos + 2) === 0x7B /* { */) {
          const closeBrace = src.indexOf('}', pos + 3);
          if (closeBrace !== -1 && closeBrace < max) {
            const colorId = src.slice(pos + 3, closeBrace);
            if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(colorId)) {
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
          if (closeBrace !== -1 && closeBrace < max) {
            const colorId = src.slice(pos + 3, closeBrace);
            if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(colorId)) {
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
    if (endPos !== -1 && endPos + 3 <= max) {
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
    if (endPos !== -1 && endPos + 3 <= max) {
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
    if (endPos !== -1 && endPos + 3 <= max) {
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

  // Check for {#id>>...<<} comment body with ID, {#id} range start, or {/id} range end
  if (src.charCodeAt(start + 1) === 0x23 /* # */) {
    // Find end of ID: [a-zA-Z0-9_-]+
    let idEnd = start + 2;
    while (idEnd < max && /[a-zA-Z0-9_-]/.test(src.charAt(idEnd))) idEnd++;
    if (idEnd > start + 2) {
      // Check for {#id>>...<<} comment body with ID (depth-aware for nested replies)
      if (idEnd + 1 < max && src.charCodeAt(idEnd) === 0x3E /* > */ && src.charCodeAt(idEnd + 1) === 0x3E /* > */) {
        const endPos = findMatchingClose(src, idEnd + 2);
        if (endPos !== -1 && endPos + 3 <= max) {
          if (!silent) {
            const id = src.slice(start + 2, idEnd);
            const content = src.slice(idEnd + 2, endPos);
            const tokenOpen = state.push('manuscript_markdown_comment_open', 'span', 1);
            tokenOpen.attrSet('class', 'manuscript-markdown-comment');
            tokenOpen.meta = { id, commentText: content };
            addInlineContent(state, content);
            state.push('manuscript_markdown_comment_close', 'span', -1);
          }
          state.pos = endPos + 3;
          return true;
        }
      }
      // Check for {#id} range start marker
      if (idEnd < max && src.charCodeAt(idEnd) === 0x7D /* } */) {
        if (!silent) {
          const id = src.slice(start + 2, idEnd);
          const token = state.push('manuscript_markdown_range_marker', 'span', 0);
          token.attrSet('class', 'manuscript-markdown-range-marker');
          token.meta = { id, type: 'start' };
        }
        state.pos = idEnd + 1;
        return true;
      }
    }
  }

  // Check for {/id} range end marker
  if (src.charCodeAt(start + 1) === 0x2F /* / */) {
    let idEnd = start + 2;
    while (idEnd < max && /[a-zA-Z0-9_-]/.test(src.charAt(idEnd))) idEnd++;
    if (idEnd > start + 2 && idEnd < max && src.charCodeAt(idEnd) === 0x7D /* } */) {
      if (!silent) {
        const id = src.slice(start + 2, idEnd);
        const token = state.push('manuscript_markdown_range_marker', 'span', 0);
        token.attrSet('class', 'manuscript-markdown-range-marker');
        token.meta = { id, type: 'end' };
      }
      state.pos = idEnd + 1;
      return true;
    }
  }

  // Check for comment {>>text<<} (depth-aware for nested replies)
  if (src.charCodeAt(start + 1) === 0x3E /* > */ && src.charCodeAt(start + 2) === 0x3E /* > */) {
    const endPos = findMatchingClose(src, start + 3);
    if (endPos !== -1 && endPos + 3 <= max) {
      if (!silent) {
        const content = src.slice(start + 3, endPos);
        const tokenOpen = state.push('manuscript_markdown_comment_open', 'span', 1);
        tokenOpen.attrSet('class', 'manuscript-markdown-comment');
        tokenOpen.meta = { commentText: content };

        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content);

        state.push('manuscript_markdown_comment_close', 'span', -1);
      }
      state.pos = endPos + 3;
      return true;
    }
  }

  // Check for highlight {==text==}
  if (src.charCodeAt(start + 1) === 0x3D /* = */ && src.charCodeAt(start + 2) === 0x3D /* = */) {
    const endMarker = '==}';
    const endPos = src.indexOf(endMarker, start + 3);
    if (endPos !== -1 && endPos + 3 <= max) {
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

/** Check if a token type is a CriticMarkup or format highlight close token */
function isCriticMarkupClose(type: string): boolean {
  return type === 'manuscript_markdown_highlight_close' ||
    type === 'manuscript_markdown_addition_close' ||
    type === 'manuscript_markdown_deletion_close' ||
    type === 'manuscript_markdown_substitution_close' ||
    type === 'manuscript_markdown_format_highlight_close';
}

/** Find the index of the matching open token in an array, searching backwards from closeIdx */
function findMatchingOpenIdx(tokens: any[], closeIdx: number): number {
  const closeType = tokens[closeIdx].type;
  const openType = closeType.replace('_close', '_open');
  let depth = 1;
  for (let i = closeIdx - 1; i >= 0; i--) {
    if (tokens[i].type === closeType) depth++;
    if (tokens[i].type === openType) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Core rule that associates comment tokens with their annotated elements.
 * Runs after inline parsing to post-process the token stream.
 *
 * Pass 1: Build a map of comment ID → comment text
 * Pass 2: Transform range markers ({#id}/{/id}) into comment range open/close tokens
 * Pass 3: Process inline comments — associate with preceding CriticMarkup elements or create indicators
 */
function associateCommentsRule(state: any): void {
  // Pass 1: Build comment ID → text map from all inline tokens
  const commentIdMap = new Map<string, string>();
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;
    for (const child of blockToken.children) {
      if (child.type === 'manuscript_markdown_comment_open' && child.meta?.id && child.meta?.commentText) {
        commentIdMap.set(child.meta.id, child.meta.commentText);
      }
    }
  }

  // Pass 2: Transform range markers with matching comments into comment range open/close
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;
    for (const child of blockToken.children) {
      if (child.type === 'manuscript_markdown_range_marker' && child.meta?.id) {
        const commentText = commentIdMap.get(child.meta.id);
        if (commentText !== undefined) {
          if (child.meta.type === 'start') {
            child.type = 'manuscript_markdown_comment_range_open';
            child.tag = 'span';
            child.nesting = 1;
            child.attrSet('class', 'manuscript-markdown-comment-range');
            child.attrSet('data-comment', commentText);
          } else if (child.meta.type === 'end') {
            child.type = 'manuscript_markdown_comment_range_close';
            child.tag = 'span';
            child.nesting = -1;
          }
        }
      }
    }
  }

  // Pass 3: Process inline comments — associate with preceding elements or create indicators
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;

    const children = blockToken.children;
    const newChildren: any[] = [];
    let i = 0;

    while (i < children.length) {
      if (children[i].type === 'manuscript_markdown_comment_open') {
        const commentText: string = children[i].meta?.commentText || '';
        const commentId: string | undefined = children[i].meta?.id;

        // Find matching comment_close (tracking nesting for nested comments)
        let closeIdx = i + 1;
        let depth = 1;
        while (closeIdx < children.length) {
          if (children[closeIdx].type === 'manuscript_markdown_comment_open') depth++;
          if (children[closeIdx].type === 'manuscript_markdown_comment_close') {
            depth--;
            if (depth === 0) break;
          }
          closeIdx++;
        }

        // Empty comment — remove silently
        if (commentText.length === 0) {
          i = closeIdx + 1;
          continue;
        }

        // ID-based comment — already handled by Pass 2, just remove tokens
        if (commentId) {
          i = closeIdx + 1;
          continue;
        }

        // Check for adjacent CriticMarkup close token
        const prevToken = newChildren.length > 0 ? newChildren[newChildren.length - 1] : null;
        if (prevToken && isCriticMarkupClose(prevToken.type)) {
          const openIdx = findMatchingOpenIdx(newChildren, newChildren.length - 1);
          if (openIdx !== -1) {
            const openToken = newChildren[openIdx];
            const existing = openToken.attrGet('data-comment');
            openToken.attrSet('data-comment', existing ? existing + '\n' + commentText : commentText);
            i = closeIdx + 1;
            continue;
          }
        }

        // Standalone comment — create indicator token
        const indicator = new state.Token('manuscript_markdown_comment_indicator', 'span', 0);
        indicator.attrSet('data-comment', commentText);
        newChildren.push(indicator);
        i = closeIdx + 1;
        continue;
      }

      newChildren.push(children[i]);
      i++;
    }

    blockToken.children = newChildren;
  }
}

/** Inline rule that converts the paragraph placeholder back into line breaks in the token stream. */
function paraPlaceholderRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0xE000) return false; // \uE000
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
    state.src = preprocessCriticMarkup(wrapBareLatexEnvironments(state.src));
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

  // Register core rule to associate comments with annotated elements
  // Runs after inline parsing to post-process the token stream
  md.core.ruler.after('inline', 'manuscript_markdown_associate_comments', associateCommentsRule);

  // Register renderers for each Manuscript Markdown token type
  for (const pattern of patterns) {
    md.renderer.rules[`manuscript_markdown_${pattern.name}_open`] = (tokens, idx) => {
      const token = tokens[idx];
      const className = token.attrGet('class') || pattern.cssClass;
      const dataComment = token.attrGet('data-comment');
      let attrs = `class="${className}"`;
      if (dataComment) {
        attrs += ` data-comment="${escapeHtmlAttr(dataComment)}"`;
      }
      return `<${pattern.htmlTag} ${attrs}>`;
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
    const dataComment = token.attrGet('data-comment');
    let attrs = `class="${className}"`;
    if (dataComment) {
      attrs += ` data-comment="${escapeHtmlAttr(dataComment)}"`;
    }
    return `<mark ${attrs}>`;
  };
  
  md.renderer.rules['manuscript_markdown_format_highlight_close'] = () => {
    return '</mark>';
  };

  // Renderer for range markers ({#id} and {/id}) without matching comments — render as empty string
  md.renderer.rules['manuscript_markdown_range_marker'] = () => {
    return '';
  };

  // Renderers for ID-based comment ranges (range markers with matching comments)
  md.renderer.rules['manuscript_markdown_comment_range_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || 'manuscript-markdown-comment-range';
    const dataComment = token.attrGet('data-comment');
    let attrs = `class="${className}"`;
    if (dataComment) {
      attrs += ` data-comment="${escapeHtmlAttr(dataComment)}"`;
    }
    return `<span ${attrs}>`;
  };

  md.renderer.rules['manuscript_markdown_comment_range_close'] = () => {
    return '</span>';
  };

  // Renderer for standalone comment indicators (comments not associated with annotated text)
  md.renderer.rules['manuscript_markdown_comment_indicator'] = (tokens, idx) => {
    const token = tokens[idx];
    const dataComment = token.attrGet('data-comment') || '';
    return `<span class="manuscript-markdown-comment-indicator" data-comment="${escapeHtmlAttr(dataComment)}"></span>`;
  };
}
