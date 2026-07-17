import type MarkdownIt from 'markdown-it';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import { VALID_COLOR_IDS, getDefaultHighlightColor } from '../highlight-colors';
import { PARA_PLACEHOLDER, findMatchingClose } from '../critic-markup';
import { GRID_TABLE_PLACEHOLDER_PREFIX } from '../grid-table-preprocess';
import { preprocessGridTablesWithMap, wrapBareLatexEnvironmentsWithMap, preprocessCriticMarkupWithMap } from './preprocess-with-map';
import { LineMap } from './line-map';
import { preprocessEmbedsWithMap, type EmbedResolver, type EmbedOptions } from '../embed-preprocess';
import { isGfmDisallowedRawHtml, escapeHtmlText, parseTaskListMarker, parseGfmAlertMarker, gfmAlertTitle, type GfmAlertType } from '../gfm';
import { parseFrontmatter, type ColorScheme } from '../frontmatter';
import { formatTableNumbers } from '../table-number-format';
import { getDefaultColorScheme } from '../alert-colors';

export interface ManuscriptMarkdownIt extends MarkdownIt {
  manuscriptColors?: ColorScheme;
  manuscriptEmbedResolver?: EmbedResolver;
  manuscriptEmbedOptions?: EmbedOptions;
  manuscriptDocumentPath?: string;
  manuscriptGetDocumentPath?: (src: string) => string | undefined;
}

interface PreviewEnvironment {
  colorScheme?: ColorScheme;
  currentDocument?: string | { fsPath?: unknown };
  lineMap?: LineMap;
}

function getPreviewEnvironment(state: StateCore): PreviewEnvironment {
  return state.env as PreviewEnvironment;
}

/** Escape HTML special characters for use in attribute values */
function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function alertOcticonSvg(type: GfmAlertType): string {
  const common = 'class="octicon markdown-alert-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"';
  switch (type) {
    case 'note':
      return '<svg ' + common + '><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>';
    case 'tip':
      return '<svg ' + common + '><path d="M8 1.5a4.5 4.5 0 0 0-2.106 8.478.75.75 0 0 1 .356.643v.629h3.5v-.63a.75.75 0 0 1 .356-.642A4.5 4.5 0 0 0 8 1.5ZM2 6a6 6 0 1 1 11.693 1.897 6.5 6.5 0 0 1-2.044 2.213c-.015.01-.024.024-.024.04v.85A1.5 1.5 0 0 1 10.125 12h-4.25a1.5 1.5 0 0 1-1.5-1.5v-.85c0-.015-.009-.03-.024-.04A6.501 6.501 0 0 1 2 6Zm3.75 7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Z"/></svg>';
    case 'important':
      return '<svg ' + common + '><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>';
    case 'warning':
      return '<svg ' + common + '><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>';
    case 'caution':
      return '<svg ' + common + '><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>';
    default: {
      return '';
    }
  }
}

interface AlertHit { inlineIdx: number; paraOpenIdx: number; type: GfmAlertType; rest: string }

function alertBlockquoteRule(state: StateCore): void {
  const tokens = state.tokens;
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].type !== 'blockquote_open') { i++; continue; }
    let depth = 1;
    let closeIdx = i + 1;
    while (closeIdx < tokens.length) {
      if (tokens[closeIdx].type === 'blockquote_open') depth++;
      else if (tokens[closeIdx].type === 'blockquote_close') {
        depth--;
        if (depth === 0) break;
      }
      closeIdx++;
    }
    if (closeIdx >= tokens.length) { i++; continue; }

    // Pre-pass: when a single inline token contains multiple [!TYPE] markers
    // (merged blockquotes without blank lines), split it into separate
    // paragraph_open/inline/paragraph_close groups within the blockquote.
    for (let j = i + 1; j < closeIdx; j++) {
      const inlineToken = tokens[j];
      const children = inlineToken.children;
      if (inlineToken.type !== 'inline' || !children) continue;
      // Find all child indices that are alert markers
      const markerChildIndices: number[] = [];
      for (let c = 0; c < children.length; c++) {
        if (children[c].type === 'text' && parseGfmAlertMarker(children[c].content)) {
          markerChildIndices.push(c);
        }
      }
      if (markerChildIndices.length === 0) continue;
      // Single marker that IS the first text child — no split needed
      const firstTextChildIdx = children.findIndex(c => c.type === 'text' && c.content.length > 0);
      if (markerChildIndices.length === 1 && markerChildIndices[0] === firstTextChildIdx) continue;

      // Find the paragraph_open and paragraph_close around this inline
      let pOpenIdx = j - 1;
      while (pOpenIdx > i && tokens[pOpenIdx].type !== 'paragraph_open') pOpenIdx--;
      let pCloseIdx = j + 1;
      while (pCloseIdx < closeIdx && tokens[pCloseIdx].type !== 'paragraph_close') pCloseIdx++;

      // Build replacement tokens: one paragraph group per marker segment
      const replacement: Token[] = [];
      // Content before first marker (plain blockquote paragraph)
      if (markerChildIndices[0] > 0) {
        let preChildren = children.slice(0, markerChildIndices[0]);
        // Strip trailing softbreaks
        while (preChildren.length > 0 && preChildren[preChildren.length - 1].type === 'softbreak') preChildren = preChildren.slice(0, -1);
        if (preChildren.length > 0) {
          const pOpen = new state.Token('paragraph_open', 'p', 1);
          replacement.push(pOpen);
          const inlineTok = new state.Token('inline', '', 0);
          inlineTok.children = preChildren;
          inlineTok.content = preChildren.map(c => c.content || '').join('');
          replacement.push(inlineTok);
          replacement.push(new state.Token('paragraph_close', 'p', -1));
        }
      }
      for (let m = 0; m < markerChildIndices.length; m++) {
        const start = markerChildIndices[m];
        const end = m + 1 < markerChildIndices.length ? markerChildIndices[m + 1] : children.length;
        let segChildren = children.slice(start, end);
        // Strip leading/trailing softbreaks
        while (segChildren.length > 0 && segChildren[0].type === 'softbreak') segChildren = segChildren.slice(1);
        while (segChildren.length > 0 && segChildren[segChildren.length - 1].type === 'softbreak') segChildren = segChildren.slice(0, -1);
        if (segChildren.length > 0) {
          const pOpen = new state.Token('paragraph_open', 'p', 1);
          replacement.push(pOpen);
          const inlineTok = new state.Token('inline', '', 0);
          inlineTok.children = segChildren;
          inlineTok.content = segChildren.map(c => c.content || '').join('');
          replacement.push(inlineTok);
          replacement.push(new state.Token('paragraph_close', 'p', -1));
        }
      }
      // Replace paragraph_open/inline/paragraph_close with expanded groups
      const removeCount = pCloseIdx - pOpenIdx + 1;
      tokens.splice(pOpenIdx, removeCount, ...replacement);
      closeIdx += replacement.length - removeCount;
      // Re-scan from current position
      j = pOpenIdx - 1;
    }

    // Collect all top-level inline tokens that start with an alert marker.
    // Track the paragraph_open index preceding each hit for splitting.
    const hits: AlertHit[] = [];
    let nestedDepth = 0;
    for (let j = i + 1; j < closeIdx; j++) {
      const token = tokens[j];
      if (token.type === 'blockquote_open') { nestedDepth++; continue; }
      if (token.type === 'blockquote_close') { nestedDepth--; continue; }
      if (nestedDepth > 0) continue;
      if (token.type !== 'inline' || !token.children) continue;
      const firstText = token.children.find(child => child.type === 'text' && child.content.length > 0);
      if (!firstText) continue;
      const parsed = parseGfmAlertMarker(firstText.content);
      if (!parsed) continue;
      let paraOpenIdx = j - 1;
      while (paraOpenIdx > i && tokens[paraOpenIdx].type !== 'paragraph_open') paraOpenIdx--;
      hits.push({ inlineIdx: j, paraOpenIdx, type: parsed.type, rest: parsed.rest });
    }

    if (hits.length === 0) { i++; continue; }

    // Strip marker text from all hits
    for (const hit of hits) {
      const children = tokens[hit.inlineIdx].children;
      if (!children) continue;
      const firstText = children.find(child => child.type === 'text' && child.content.length > 0);
      if (firstText) firstText.content = hit.rest;
    }

    if (hits.length === 1) {
      // Single alert — just annotate the blockquote_open
      tokens[i].meta = {
        ...(tokens[i].meta || {}),
        gfmAlertType: hits[0].type,
        gfmAlertTitle: gfmAlertTitle(hits[0].type),
      };
      i = closeIdx + 1;
      continue;
    }

    // Multiple alert markers — rebuild the token segment.
    // Collect inner tokens (between blockquote_open and blockquote_close).
    const inner = tokens.slice(i + 1, closeIdx);
    // Map all hit paraOpenIdx to offsets within inner (subtract i+1)
    const allOffsets = hits.map(h => h.paraOpenIdx - (i + 1));

    const rebuilt: Token[] = [];

    // Content before the first alert marker becomes a plain blockquote
    if (allOffsets[0] > 0) {
      const bqOpen = new state.Token('blockquote_open', 'blockquote', 1);
      bqOpen.markup = '>';
      bqOpen.map = tokens[i].map;
      rebuilt.push(bqOpen);
      for (let k = 0; k < allOffsets[0]; k++) {
        rebuilt.push(inner[k]);
      }
      const bqClose = new state.Token('blockquote_close', 'blockquote', -1);
      bqClose.markup = '>';
      rebuilt.push(bqClose);
    }

    for (let h = 0; h < hits.length; h++) {
      const startOffset = allOffsets[h];
      const endOffset = h + 1 < hits.length ? allOffsets[h + 1] : inner.length;
      const bqOpen = new state.Token('blockquote_open', 'blockquote', 1);
      bqOpen.markup = '>';
      bqOpen.map = tokens[i].map;
      bqOpen.meta = { gfmAlertType: hits[h].type, gfmAlertTitle: gfmAlertTitle(hits[h].type) };
      rebuilt.push(bqOpen);
      for (let k = startOffset; k < endOffset; k++) {
        rebuilt.push(inner[k]);
      }
      const bqClose = new state.Token('blockquote_close', 'blockquote', -1);
      bqClose.markup = '>';
      rebuilt.push(bqClose);
    }

    // Replace original blockquote_open...blockquote_close with rebuilt
    tokens.splice(i, closeIdx - i + 1, ...rebuilt);
    // Don't increment i — re-process from same position since rebuilt tokens
    // are already annotated and won't match the hits scan again
    i += rebuilt.length;
  }
}

function autolinkLiteralsRule(state: StateCore): void {
  const urlPattern = /https?:\/\/[^\s<]+/g;
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;
    const nextChildren: Token[] = [];
    let insideLink = false;
    for (const child of blockToken.children) {
      if (child.type === 'link_open') {
        insideLink = true;
        nextChildren.push(child);
        continue;
      }
      if (child.type === 'link_close') {
        insideLink = false;
        nextChildren.push(child);
        continue;
      }
      if (insideLink || child.type !== 'text' || !urlPattern.test(child.content)) {
        urlPattern.lastIndex = 0;
        nextChildren.push(child);
        continue;
      }
      urlPattern.lastIndex = 0;
      let cursor = 0;
      let match: RegExpExecArray | null;
      while ((match = urlPattern.exec(child.content)) !== null) {
        const start = match.index;
        let url = match[0];
        while (/[).,!?;:]$/.test(url)) {
          url = url.slice(0, -1);
        }
        const end = start + url.length;
        if (start > cursor) {
          const textBefore = new state.Token('text', '', 0);
          textBefore.content = child.content.slice(cursor, start);
          nextChildren.push(textBefore);
        }
        const open = new state.Token('link_open', 'a', 1);
        open.attrSet('href', url);
        nextChildren.push(open);
        const text = new state.Token('text', '', 0);
        text.content = url;
        nextChildren.push(text);
        nextChildren.push(new state.Token('link_close', 'a', -1));
        cursor = end;
      }
      if (cursor < child.content.length) {
        const textAfter = new state.Token('text', '', 0);
        textAfter.content = child.content.slice(cursor);
        nextChildren.push(textAfter);
      }
    }
    blockToken.children = nextChildren;
  }
}

/** Core rule: detect GFM task list markers at list item starts and mark list_item_open tokens. */
function taskListRule(state: StateCore): void {
  const stack: number[] = [];
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type === 'list_item_open') {
      stack.push(i);
      continue;
    }
    if (token.type === 'list_item_close') {
      stack.pop();
      continue;
    }
    if (token.type !== 'inline' || !token.children || stack.length === 0) continue;

    const listItemOpen = state.tokens[stack[stack.length - 1]];
    if (listItemOpen.meta?.taskChecked !== undefined) continue;

    const firstText = token.children.find(child => child.type === 'text' && child.content.length > 0);
    if (!firstText) continue;
    const parsed = parseTaskListMarker(firstText.content);
    if (!parsed) continue;

    listItemOpen.meta = { ...(listItemOpen.meta || {}), taskChecked: parsed.checked };
    firstText.content = parsed.rest;
  }
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
  const childTokens: Token[] = [];
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
 * AGENTS.md invariant: multi-line patterns must start at the beginning of a line
 * to be handled here. Navigation tolerates mid-line starts, preview does not.
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
function findMatchingOpenIdx(tokens: Token[], closeIdx: number): number {
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
function associateCommentsRule(state: StateCore): void {
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
    const newChildren: Token[] = [];
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

        // Check for adjacent CriticMarkup close token, skipping whitespace-only text tokens
        let candidateIdx = newChildren.length - 1;
        while (candidateIdx >= 0 && newChildren[candidateIdx].type === 'text' && /^\s+$/.test(newChildren[candidateIdx].content)) {
          candidateIdx--;
        }
        const candidateToken = candidateIdx >= 0 ? newChildren[candidateIdx] : null;
        if (candidateToken && isCriticMarkupClose(candidateToken.type)) {
          const openIdx = findMatchingOpenIdx(newChildren, candidateIdx);
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
 * Block rule that detects grid table placeholder comments and emits
 * standard markdown-it table tokens. Runs before the built-in paragraph
 * rule so placeholders are consumed before they become paragraphs.
 */
function gridTableBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const lineText = state.src.slice(pos, max);

  if (!lineText.startsWith(GRID_TABLE_PLACEHOLDER_PREFIX)) return false;
  if (!lineText.endsWith(' -->')) return false;

  if (silent) return true;

  const b64 = lineText.slice(GRID_TABLE_PLACEHOLDER_PREFIX.length, -4);
  let gridData: { rows: Array<{ cells: string[]; header: boolean }> };
  try {
    const jsonStr = Buffer.from(b64, 'base64').toString();
    gridData = JSON.parse(jsonStr);
  } catch {
    return false;
  }

  // Split into header and body rows
  const headerRows = gridData.rows.filter(r => r.header);
  const bodyRows = gridData.rows.filter(r => !r.header);

  const tableOpen = state.push('table_open', 'table', 1);
  tableOpen.map = [startLine, startLine + 1];

  if (headerRows.length > 0) {
    state.push('thead_open', 'thead', 1);
    for (const row of headerRows) {
      state.push('tr_open', 'tr', 1);
      for (const cellText of row.cells) {
        state.push('th_open', 'th', 1);
        const inlineTok = state.push('inline', '', 0);
        inlineTok.content = cellText.replace(/\n/g, '  \n');
        inlineTok.children = [];
        state.push('th_close', 'th', -1);
      }
      state.push('tr_close', 'tr', -1);
    }
    state.push('thead_close', 'thead', -1);
  }

  if (bodyRows.length > 0) {
    state.push('tbody_open', 'tbody', 1);
    for (const row of bodyRows) {
      state.push('tr_open', 'tr', 1);
      for (const cellText of row.cells) {
        const tag = headerRows.length === 0 && bodyRows.indexOf(row) === 0 ? 'th' : 'td';
        state.push(tag + '_open', tag, 1);
        const inlineTok = state.push('inline', '', 0);
        inlineTok.content = cellText.replace(/\n/g, '  \n');
        inlineTok.children = [];
        state.push(tag + '_close', tag, -1);
      }
      state.push('tr_close', 'tr', -1);
    }
    state.push('tbody_close', 'tbody', -1);
  }

  state.push('table_close', 'table', -1);
  state.line = startLine + 1;
  return true;
}

function getEmbedDocumentPath(md: ManuscriptMarkdownIt, state: StateCore): string | undefined {
  const env = getPreviewEnvironment(state);
  const currentDocument = env?.currentDocument;
  if (currentDocument && typeof currentDocument === 'object' && typeof currentDocument.fsPath === 'string') {
    return currentDocument.fsPath;
  }
  if (typeof currentDocument === 'string' && currentDocument.length > 0) {
    return currentDocument;
  }

  // Once a preview instance has latched onto a document, keep using that base
  // path instead of re-scanning open editors by source text on every render.
  const fallbackPath = md.manuscriptDocumentPath;
  if (typeof fallbackPath === 'string' && fallbackPath.length > 0) {
    return fallbackPath;
  }

  const getDocPath = md.manuscriptGetDocumentPath;
  if (typeof getDocPath === 'function') {
    const resolved = getDocPath(state.src);
    if (typeof resolved === 'string' && resolved.length > 0) {
      return resolved;
    }
  }

  return undefined;
}

/**
 * Main plugin function that registers Manuscript Markdown parsing with markdown-it
 * @param md - The MarkdownIt instance to extend
 */
export function manuscriptMarkdownPlugin(md: ManuscriptMarkdownIt): void {
  // Preprocess source before block parsing to handle multi-paragraph CriticMarkup
  md.core.ruler.before('normalize', 'manuscript_markdown_preprocess', (state: StateCore) => {
    // Parse frontmatter to extract color scheme before preprocessing.
    // Priority: frontmatter > md.manuscriptColors (set by extension) > module-level default
    const { metadata } = parseFrontmatter(state.src);
    const defaultScheme = md.manuscriptColors ?? getDefaultColorScheme();
    const env = getPreviewEnvironment(state);
    env.colorScheme = metadata.colors || defaultScheme;
    md.set({ breaks: metadata.breaks ?? false });
    // Embed preprocessing runs first so embedded .md files with grid tables get
    // processed by the subsequent grid table preprocessor.
    const embedResolver = md.manuscriptEmbedResolver;
    const embedOptions = md.manuscriptEmbedOptions;
    const docPath = getEmbedDocumentPath(md, state);
    const r0 = (embedResolver && docPath)
      ? preprocessEmbedsWithMap(state.src, embedResolver, docPath, embedOptions)
      : { output: state.src, map: LineMap.identity() };
    const r1 = preprocessGridTablesWithMap(r0.output);
    const numberResult = formatTableNumbers(r1.output, {
      digits: metadata.tableDigits,
      decimalMark: metadata.tableDecimalMark,
      digitGrouping: metadata.tableDigitGrouping,
    });
    const rNumber = { output: numberResult.output, map: LineMap.identity() };
    const r2 = wrapBareLatexEnvironmentsWithMap(rNumber.output);
    const r3 = preprocessCriticMarkupWithMap(r2.output);
    state.src = r3.output;
    env.lineMap = LineMap.chain(LineMap.chain(LineMap.chain(LineMap.chain(r0.map, r1.map), rNumber.map), r2.map), r3.map);
  });

  // Inject <style> block for header-font-style and custom styles preview
  md.core.ruler.push('manuscript_header_font_style', (state: StateCore) => {
    const { metadata } = parseFrontmatter(state.src);
    let css = '';
    // Header font style CSS (gated on headerFontStyle being set)
    const styles = metadata.headerFontStyle;
    if (styles && styles.length > 0) {
      for (let i = 0; i < 6; i++) {
        const style = i < styles.length ? styles[i] : styles[styles.length - 1];
        const rules: string[] = [];
        if (style === 'normal') {
          rules.push('font-weight: normal', 'font-style: normal', 'text-decoration: none', 'font-variant: normal', 'text-transform: none', 'text-align: left');
        } else {
          rules.push(style.includes('bold') ? 'font-weight: bold' : 'font-weight: normal');
          rules.push(style.includes('italic') ? 'font-style: italic' : 'font-style: normal');
          rules.push(style.includes('underline') ? 'text-decoration: underline' : 'text-decoration: none');
          // smallcaps/allcaps: check smallcaps first since 'smallcaps' contains 'allcaps' as substring
          if (style.includes('smallcaps')) {
            rules.push('font-variant: small-caps', 'text-transform: none');
          } else if (style.includes('allcaps')) {
            rules.push('font-variant: normal', 'text-transform: uppercase');
          } else {
            rules.push('font-variant: normal', 'text-transform: none');
          }
          rules.push(style.includes('center') ? 'text-align: center' : 'text-align: left');
        }
        css += 'h' + (i + 1) + ' { ' + rules.join('; ') + '; }\n';
      }
    }
    // Custom named styles CSS (independent of headerFontStyle)
    if (metadata.styles) {
      for (const [name, def] of Object.entries(metadata.styles)) {
        const safeName = name.replace(/[^a-zA-Z0-9-]/g, '-');
        const csRules: string[] = [];
        if (def.font) csRules.push('font-family: "' + def.font + '"');
        if (def.fontSize !== undefined) csRules.push('font-size: ' + def.fontSize + 'pt');
        const fs = def.fontStyle ?? '';
        if (fs.includes('bold')) csRules.push('font-weight: bold');
        if (fs.includes('italic')) csRules.push('font-style: italic');
        if (fs.includes('underline')) csRules.push('text-decoration: underline');
        if (fs.includes('smallcaps')) csRules.push('font-variant: small-caps');
        else if (fs.includes('allcaps')) csRules.push('text-transform: uppercase');
        if (fs.includes('center')) csRules.push('text-align: center');
        if (def.spacingBefore !== undefined) csRules.push('margin-top: ' + def.spacingBefore + 'pt');
        if (def.spacingAfter !== undefined) csRules.push('margin-bottom: ' + def.spacingAfter + 'pt');
        if (def.paragraphIndent !== undefined) csRules.push('text-indent: ' + (def.paragraphIndent === 'none' ? '0' : def.paragraphIndent + 'in'));
        if (csRules.length > 0) {
          css += '.ms-custom-style-' + safeName + ' p { ' + csRules.join('; ') + '; }\n';
        }
      }
    }
    if (!css) return;
    const token = new state.Token('manuscript_style', '', 0);
    token.content = '<style>\n' + css + '</style>\n';
    state.tokens.unshift(token);
  });

  // Inject <style> block for table-borders preview
  md.core.ruler.push('manuscript_table_borders', (state: StateCore) => {
    const { metadata } = parseFrontmatter(state.src);
    const borders = metadata.tableBorders ?? 'horizontal';
    const css = borders === 'none'
      ? 'table { border-collapse: collapse; }\n'
        + 'table th, table td { border: none; }\n'
      : borders === 'solid'
        ? 'table { border-collapse: collapse; }\n'
          + 'table th, table td { border: 1px solid var(--vscode-editor-foreground, currentColor); }\n'
        // 'horizontal': light separators between body rows, stronger header underline, no vertical borders
        : 'table { border-collapse: collapse; }\n'
          + 'table th, table td { border: none; border-bottom: 1px solid color-mix(in srgb, var(--vscode-editor-foreground, currentColor) 25%, transparent); padding: 6px 8px; }\n'
          + 'table thead th { border-bottom: 1px solid var(--vscode-editor-foreground, currentColor); }\n';
    const token = new state.Token('manuscript_style', '', 0);
    token.content = '<style>\n' + css + '</style>\n';
    state.tokens.unshift(token);
  });

  // Inject <style> block for missing-value colorization in embedded .dta tables
  md.core.ruler.push('manuscript_missing_value_style', (state: StateCore) => {
    const token = new state.Token('manuscript_style', '', 0);
    token.content = '<style>\n.mm-missing-value { color: var(--vscode-editorError-foreground); }\n</style>\n';
    state.tokens.unshift(token);
  });

  // Register grid table block rule before html_block so the placeholder comment
  // is consumed before markdown-it's html_block rule can swallow it (VS Code's
  // preview enables html: true).
  md.block.ruler.before('html_block', 'manuscript_grid_table_block', gridTableBlockRule);

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
  md.core.ruler.after('inline', 'manuscript_markdown_autolink_literals', autolinkLiteralsRule);
  md.core.ruler.after('inline', 'manuscript_markdown_associate_comments', associateCommentsRule);
  md.core.ruler.after('manuscript_markdown_associate_comments', 'manuscript_markdown_task_list', taskListRule);
  md.core.ruler.after('manuscript_markdown_task_list', 'manuscript_markdown_alert_blockquote', alertBlockquoteRule);

  // Core rule: wrap <!-- style: X -->...<!-- /style --> blocks in <div class="ms-custom-style ms-custom-style-{name}">
  md.core.ruler.after('manuscript_markdown_alert_blockquote', 'manuscript_custom_style_wrap', (state: StateCore) => {
    const tokens = state.tokens;
    const OPEN_RE = /^<!--\s*style:\s*(.+?)\s*-->\s*$/i;
    const CLOSE_RE = /^<!--\s*\/style\s*-->\s*$/i;
    // First pass (reverse): find close directives and record their indices
    const closeIndices: number[] = [];
    for (let i = tokens.length - 1; i >= 0; i--) {
      const tok = tokens[i];
      if (tok.type !== 'html_block') continue;
      const content = (tok.content || '').trim();
      if (CLOSE_RE.test(content)) closeIndices.push(i);
    }
    // Second pass (reverse): match opens with closes (stack-based pairing)
    const pairedCloses = new Set<number>();
    for (let i = tokens.length - 1; i >= 0; i--) {
      const tok = tokens[i];
      if (tok.type !== 'html_block') continue;
      const content = (tok.content || '').trim();
      const openMatch = content.match(OPEN_RE);
      if (openMatch) {
        // Find the nearest unpaired close after this open
        const closeIdx = closeIndices.find(ci => ci > i && !pairedCloses.has(ci));
        if (closeIdx !== undefined) {
          pairedCloses.add(closeIdx);
          const safeName = openMatch[1].replace(/[^a-zA-Z0-9-]/g, '-');
          const divOpen = new state.Token('html_block', '', 0);
          divOpen.content = '<div class="ms-custom-style ms-custom-style-' + safeName + '">\n';
          tokens.splice(i, 1, divOpen);
        }
      }
    }
    // Replace paired closes with </div>; leave unpaired closes as-is
    for (const ci of pairedCloses) {
      const divClose = new state.Token('html_block', '', 0);
      divClose.content = '</div>\n';
      tokens.splice(ci, 1, divClose);
    }
  });

  // Inject a hidden marker element so the preview script can apply the color scheme
  // class to alert elements (needed because VS Code's built-in GFM alert renderer
  // overrides our blockquote_open renderer and doesn't include our color class).
  // Keep in sync with ColorScheme in frontmatter.ts and CSS in manuscript-markdown.css.
  const ALLOWED_PREVIEW_SCHEMES = new Set<ColorScheme>(['guttmacher']);
  md.core.ruler.push('manuscript_color_scheme_marker', (state: StateCore) => {
    const scheme = getPreviewEnvironment(state).colorScheme;
    if (scheme && ALLOWED_PREVIEW_SCHEMES.has(scheme)) {
      const token = new state.Token('html_block', '', 0);
      token.content = '<span data-manuscript-color-scheme="' + scheme + '" style="display:none"></span>\n';
      state.tokens.unshift(token);
    }
  });

  // Remap token .map values from preprocessed line numbers back to original
  // source line numbers so VS Code's data-line scroll sync attributes are correct.
  // Must run after all other core rules that create or modify tokens.
  md.core.ruler.push('manuscript_scroll_sync_remap', (state: StateCore) => {
    const lineMap = getPreviewEnvironment(state).lineMap;
    if (!lineMap || lineMap.isIdentity) return;
    for (const token of state.tokens) {
      if (token.map) {
        token.map = [lineMap.remap(token.map[0]), lineMap.remap(token.map[1])];
      }
    }
  });

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

  // GFM disallowed raw HTML tags must be rendered as escaped text, not live HTML.
  md.renderer.rules.html_inline = (tokens, idx) => {
    const content = tokens[idx].content || '';
    return isGfmDisallowedRawHtml(content) ? escapeHtmlText(content) : content;
  };
  md.renderer.rules.html_block = (tokens, idx) => {
    const token = tokens[idx];
    const content = token.content || '';
    if (isGfmDisallowedRawHtml(content)) {
      return '<p>' + escapeHtmlText(content) + '</p>\n';
    }
    if (token.map) {
      return '<div data-line="' + token.map[0] + '">' + content + '</div>\n';
    }
    return content;
  };

  // Trusted internal style blocks injected by manuscript rules — bypass GFM filtering.
  md.renderer.rules.manuscript_style = (tokens, idx) => tokens[idx].content || '';

  // GFM task list rendering.
  md.renderer.rules.list_item_open = (tokens, idx, options, env, self) => {
    const checked = tokens[idx].meta?.taskChecked;
    if (checked !== undefined) {
      tokens[idx].attrJoin('class', 'task-list-item');
    }
    const rendered = self.renderToken(tokens, idx, options);
    if (checked === undefined) return rendered;
    const checkbox = `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked' : ''}> `;
    return rendered + checkbox;
  };

  md.renderer.rules.blockquote_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const alertType: GfmAlertType | undefined = token.meta?.gfmAlertType;
    if (!alertType) {
      return self.renderToken(tokens, idx, options);
    }
    const dataLine = token.map ? ' data-line="' + token.map[0] + '"' : '';
    const title = token.meta?.gfmAlertTitle || gfmAlertTitle(alertType);
    const colorScheme = (env as PreviewEnvironment).colorScheme;
    const schemeClass = colorScheme && ALLOWED_PREVIEW_SCHEMES.has(colorScheme) ? ' color-scheme-' + colorScheme : '';
    return '<blockquote' + dataLine + ' class="markdown-alert markdown-alert-' + alertType + schemeClass + '"><p class="markdown-alert-title">' + alertOcticonSvg(alertType) + ' ' + escapeHtmlText(title) + '</p>\n';
  };

}
