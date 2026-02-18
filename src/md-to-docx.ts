import MarkdownIt from 'markdown-it';
import { escapeXml, generateCitation, generateMathXml, createCiteprocEngineLocal, createCiteprocEngineAsync, generateBibliographyXml, generateMissingKeysXml } from './md-to-docx-citations';
import { downloadStyle } from './csl-loader';
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import { parseBibtex, BibtexEntry } from './bibtex-parser';
import { parseFrontmatter, Frontmatter, noteTypeToNumber } from './frontmatter';
import { ZoteroBiblData, zoteroStyleFullId } from './converter';

// Types for the parsed token stream
export interface MdToken {
  type: 'paragraph' | 'heading' | 'list_item' | 'blockquote' | 'code_block' | 'table' | 'hr';
  level?: number;           // heading level 1-6, blockquote nesting, list nesting
  ordered?: boolean;        // for list items
  runs: MdRun[];            // inline content
  rows?: MdTableRow[];      // for tables
  language?: string;        // for code blocks
}

export interface MdTableCell {
  runs: MdRun[];
  colspan?: number;
  rowspan?: number;
}
export interface MdTableRow {
  cells: MdTableCell[];     // each cell has runs + optional span info
  header: boolean;
}

export interface MdRun {
  type: 'text' | 'critic_add' | 'critic_del' | 'critic_sub' | 'critic_highlight' | 'critic_comment' | 'citation' | 'math' | 'softbreak' | 'comment_range_start' | 'comment_range_end' | 'comment_body_with_id';
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
  // CriticMarkup specific
  newText?: string;         // for substitutions: {~~old~>new~~}
  author?: string;          // for comments/revisions
  date?: string;            // for comments/revisions
  commentText?: string;     // for critic_comment: the comment body
  commentId?: string;       // for comment_range_start/end/body_with_id
  replies?: Array<{author?: string; date?: string; text: string}>; // nested replies for comment_body_with_id
  // Citation specific
  keys?: string[];          // citation keys for [@key1; @key2]
  locators?: Map<string, string>; // key -> locator for [@key, p. 20]
  // Math specific
  display?: boolean;        // display math ($$...$$) vs inline ($...$)
}

// Map Manuscript Markdown color names to OOXML ST_HighlightColor values
const COLOR_TO_OOXML: Record<string, string> = {
  'yellow': 'yellow', 'green': 'green', 'blue': 'blue', 'red': 'red', 'black': 'black',
  'turquoise': 'cyan', 'pink': 'magenta', 'dark-blue': 'darkBlue',
  'teal': 'darkCyan', 'violet': 'darkMagenta', 'dark-red': 'darkRed',
  'dark-yellow': 'darkYellow', 'gray-50': 'darkGray', 'gray-25': 'lightGray',
};

import { PARA_PLACEHOLDER, preprocessCriticMarkup, findMatchingClose } from './critic-markup';
export { PARA_PLACEHOLDER, preprocessCriticMarkup };

// Custom inline rules

/** Parse author/date/text from comment content string. */
function parseCommentContent(content: string): { author?: string; date?: string; text: string } {
  const match = content.match(/^([\s\S]+?)\s+\(([^)]+)\):\s*([\s\S]*)$/);
  if (match) {
    return { author: match[1], date: match[2], text: match[3] };
  }
  const authorMatch = content.match(/^([^:]+):\s*([\s\S]*)$/);
  if (authorMatch) {
    return { author: authorMatch[1].trim(), text: authorMatch[2] };
  }
  if (content.trim()) {
    if (content.includes(':') || content.includes(' ') || /[^a-zA-Z0-9_-]/.test(content)) {
      return { text: content };
    }
    return { author: content, text: '' };
  }
  return { text: '' };
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
    const replyContent = content.slice(innerStart, closeIdx).replaceAll(PARA_PLACEHOLDER, '\n\n');
    const parsed = parseCommentContent(replyContent);
    replies.push(parsed);
    pos = closeIdx + 3;
  }

  return { parentText, replies };
}

/** Parse {#id}, {/id}, and {#id>>...<<} comment range markers */
function commentRangeRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  const src = state.src;

  if (start >= max || src.charAt(start) !== '{') return false;

  const next = src.charAt(start + 1);
  if (next === '#') {
    // Could be {#id} range start or {#id>>...<<} comment body
    const idStart = start + 2;
    // Find end of ID: [a-zA-Z0-9_-]+
    let idEnd = idStart;
    while (idEnd < max && /[a-zA-Z0-9_-]/.test(src.charAt(idEnd))) idEnd++;
    if (idEnd === idStart) return false; // empty ID

    const id = src.slice(idStart, idEnd);

    // Check for {#id>>...<<} comment body
    if (idEnd + 1 < max && src.charAt(idEnd) === '>' && src.charAt(idEnd + 1) === '>') {
      // Find matching <<} accounting for nested {>>...<<} replies
      const endPos = findMatchingClose(src, idEnd + 2);
      if (endPos === -1) return false;

      if (!silent) {
        const rawContent = src.slice(idEnd + 2, endPos).replaceAll(PARA_PLACEHOLDER, '\n\n');
        const token = state.push('comment_body_with_id', '', 0);
        token.commentId = id;

        // Check for nested replies
        const { parentText, replies } = extractReplies(rawContent);
        const parsed = parseCommentContent(parentText);
        token.author = parsed.author;
        token.date = parsed.date;
        token.commentText = parsed.text;
        if (replies.length > 0) {
          token.replies = replies;
        }
      }
      state.pos = endPos + 3;
      return true;
    }

    // Check for {#id} range start
    if (idEnd < max && src.charAt(idEnd) === '}') {
      if (!silent) {
        const token = state.push('comment_range_start', '', 0);
        token.commentId = id;
      }
      state.pos = idEnd + 1;
      return true;
    }

    return false;
  }

  if (next === '/') {
    // {/id} range end
    const idStart = start + 2;
    let idEnd = idStart;
    while (idEnd < max && /[a-zA-Z0-9_-]/.test(src.charAt(idEnd))) idEnd++;
    if (idEnd === idStart) return false;

    if (idEnd < max && src.charAt(idEnd) === '}') {
      if (!silent) {
        const token = state.push('comment_range_end', '', 0);
        token.commentId = src.slice(idStart, idEnd);
      }
      state.pos = idEnd + 1;
      return true;
    }

    return false;
  }

  return false;
}

function criticMarkupRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;

  if (start + 3 >= max || state.src.charAt(start) !== '{') return false;

  const marker = state.src.slice(start, start + 3);
  let endMarker: string;
  let type: string;

  switch (marker) {
    case '{++': endMarker = '++}'; type = 'critic_add'; break;
    case '{--': endMarker = '--}'; type = 'critic_del'; break;
    case '{~~': endMarker = '~~}'; type = 'critic_sub'; break;
    case '{==': endMarker = '==}'; type = 'critic_highlight'; break;
    case '{>>': endMarker = '<<}'; type = 'critic_comment'; break;
    default: return false;
  }

  let endPos: number;
  if (type === 'critic_comment') {
    // Use depth-aware matching for {>>...<<} which may contain nested replies
    endPos = findMatchingClose(state.src, start + 3);
  } else {
    endPos = state.src.indexOf(endMarker, start + 3);
  }
  if (endPos === -1) return false;

  if (!silent) {
    // Replace any paragraph placeholders back to real newlines
    const content = state.src.slice(start + 3, endPos).replaceAll(PARA_PLACEHOLDER, '\n\n');
    const token = state.push('critic_markup', '', 0);
    token.markup = marker;
    token.content = content;
    token.criticType = type;

    if (type === 'critic_sub') {
      const sepPos = content.indexOf('~>');
      if (sepPos !== -1) {
        token.oldText = content.slice(0, sepPos);
        token.newText = content.slice(sepPos + 2);
      }
    }

    if (type === 'critic_comment') {
      const parsed = parseCommentContent(content);
      token.author = parsed.author;
      token.date = parsed.date;
      token.commentText = parsed.text;
    }
  }

  state.pos = endPos + endMarker.length;
  return true;
}

function coloredHighlightRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  
  if (start + 2 >= max || state.src.slice(start, start + 2) !== '==') return false;
  
  const endPos = state.src.indexOf('==', start + 2);
  if (endPos === -1) return false;
  
  const afterEnd = endPos + 2;
  if (afterEnd < max && state.src.charAt(afterEnd) === '{') {
    const colorEnd = state.src.indexOf('}', afterEnd + 1);
    if (colorEnd !== -1) {
      const color = state.src.slice(afterEnd + 1, colorEnd);
      // Require identifier-like colors that do not start or end with '-'
      // so adjacent CriticMarkup like {--deleted--} is not misparsed as a color suffix.
      if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(color)) {
        if (!silent) {
          const content = state.src.slice(start + 2, endPos);
          const token = state.push('colored_highlight', '', 0);
          token.content = content;
          token.color = color;
        }
        state.pos = colorEnd + 1;
        return true;
      }
    }
  }
  
  // Plain highlight
  if (!silent) {
    const content = state.src.slice(start + 2, endPos);
    const token = state.push('plain_highlight', '', 0);
    token.content = content;
  }
  state.pos = endPos + 2;
  return true;
}

function citationRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  
  if (start + 2 >= max || state.src.slice(start, start + 2) !== '[@') return false;
  
  const endPos = state.src.indexOf(']', start + 2);
  if (endPos === -1) return false;
  
  if (!silent) {
    const content = state.src.slice(start + 2, endPos);
    const token = state.push('citation', '', 0);
    token.content = content;
    
    const keys: string[] = [];
    const locators = new Map<string, string>();
    
    const parts = content.split(';').map((p: string) => p.trim().replace(/^@/, ''));
    for (const part of parts) {
      const commaPos = part.indexOf(',');
      if (commaPos !== -1) {
        const key = part.slice(0, commaPos).trim();
        const locator = part.slice(commaPos + 1).trim();
        keys.push(key);
        locators.set(key, locator);
      } else {
        keys.push(part);
      }
    }
    
    token.keys = keys;
    token.locators = locators;
  }
  
  state.pos = endPos + 1;
  return true;
}

function mathRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  
  if (start >= max || state.src.charAt(start) !== '$') return false;
  
  // Check for display math
  if (start + 1 < max && state.src.charAt(start + 1) === '$') {
    const endPos = state.src.indexOf('$$', start + 2);
    if (endPos === -1) return false;
    
    if (!silent) {
      const content = state.src.slice(start + 2, endPos);
      const token = state.push('math', '', 0);
      token.content = content;
      token.display = true;
    }
    state.pos = endPos + 2;
    return true;
  }
  
  // Inline math - don't match $ in middle of words
  if (start > 0 && /\w/.test(state.src.charAt(start - 1))) return false;

  // Don't match currency patterns like $100 (digit(s) followed by whitespace/punctuation/end)
  if (start + 1 < max && /\d/.test(state.src.charAt(start + 1))) {
    const afterDollar = state.src.slice(start + 1);
    if (/^\d[\d,.]*(?:\s|$)/.test(afterDollar)) return false;
  }

  const endPos = state.src.indexOf('$', start + 1);
  if (endPos === -1) return false;

  // Don't match $ at end if followed by word character
  if (endPos + 1 < max && /\w/.test(state.src.charAt(endPos + 1))) return false;
  
  if (!silent) {
    const content = state.src.slice(start + 1, endPos);
    const token = state.push('math', '', 0);
    token.content = content;
    // Don't set display for inline math - leave it undefined
  }
  state.pos = endPos + 1;
  return true;
}

/** Inline rule that converts the paragraph placeholder back into softbreak tokens. */
function paraPlaceholderRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0xE000) return false; // \uE000
  if (!state.src.startsWith(PARA_PLACEHOLDER, start)) return false;

  if (!silent) {
    // Emit two softbreaks to represent the paragraph break
    state.push('softbreak', 'br', 0);
    state.push('softbreak', 'br', 0);
  }
  state.pos = start + PARA_PLACEHOLDER.length;
  return true;
}

function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({ html: true });

  md.inline.ruler.before('emphasis', 'para_placeholder', paraPlaceholderRule);
  md.inline.ruler.before('emphasis', 'comment_range', commentRangeRule);
  md.inline.ruler.before('emphasis', 'colored_highlight', coloredHighlightRule);
  md.inline.ruler.before('emphasis', 'critic_markup', criticMarkupRule);
  md.inline.ruler.before('emphasis', 'citation', citationRule);
  md.inline.ruler.before('emphasis', 'math', mathRule);

  return md;
}

export function parseMd(markdown: string): MdToken[] {
  const md = createMarkdownIt();
  const processed = preprocessCriticMarkup(markdown);
  const tokens = md.parse(processed, {});

  return convertTokens(tokens);
}

function convertTokens(tokens: any[], listLevel = 0, blockquoteLevel = 0): MdToken[] {
  const result: MdToken[] = [];
  let i = 0;
  
  while (i < tokens.length) {
    const token = tokens[i];
    
    switch (token.type) {
      case 'heading_open':
        const headingClose = findClosingToken(tokens, i, 'heading_close');
        result.push({
          type: 'heading',
          level: parseInt(token.tag.slice(1)),
          runs: convertInlineTokens(tokens.slice(i + 1, headingClose))
        });
        i = headingClose + 1;
        break;
        
      case 'paragraph_open':
        const paragraphClose = findClosingToken(tokens, i, 'paragraph_close');
        result.push({
          type: 'paragraph',
          runs: convertInlineTokens(tokens.slice(i + 1, paragraphClose))
        });
        i = paragraphClose + 1;
        break;
        
      case 'bullet_list_open':
      case 'ordered_list_open':
        const listClose = findClosingToken(tokens, i, token.type.replace('_open', '_close'));
        const currentLevel = listLevel + 1;
        const listItems = extractListItems(tokens.slice(i + 1, listClose), token.type === 'ordered_list_open', currentLevel);
        result.push(...listItems);
        i = listClose + 1;
        break;
        
      case 'blockquote_open':
        const blockquoteClose = findClosingToken(tokens, i, 'blockquote_close');
        const bqLevel = blockquoteLevel + 1;
        const blockquoteTokens = convertTokens(tokens.slice(i + 1, blockquoteClose), 0, bqLevel);
        result.push(...blockquoteTokens.map(t => ({
          ...t,
          type: 'blockquote' as const,
          level: t.type === 'blockquote' ? t.level : bqLevel
        })));
        i = blockquoteClose + 1;
        break;
        
      case 'fence':
        result.push({
          type: 'code_block',
          language: token.info || undefined,
          runs: [{ type: 'text', text: token.content }]
        });
        i++;
        break;
        
      case 'table_open':
        const tableClose = findClosingToken(tokens, i, 'table_close');
        const tableData = extractTableData(tokens.slice(i + 1, tableClose));
        result.push({
          type: 'table',
          runs: [],
          rows: tableData
        });
        i = tableClose + 1;
        break;
      
      case 'html_block': {
        const htmlTables = extractHtmlTables(token.content || '');
        for (const rows of htmlTables) {
          if (rows.length > 0) {
            result.push({
              type: 'table',
              runs: [],
              rows
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
  }
  
  return result;
}

function convertInlineTokens(tokens: any[]): MdRun[] {
  const runs: MdRun[] = [];
  
  for (const token of tokens) {
    if (token.type === 'inline' && token.children) {
      // Process the children of inline tokens
      runs.push(...processInlineChildren(token.children));
    } else {
      // Single token processing
      const tokenRuns = processInlineChildren([token]);
      runs.push(...tokenRuns);
    }
  }
  
  return runs;
}

function processInlineChildren(tokens: any[]): MdRun[] {
  const runs: MdRun[] = [];
  const formatStack: any = {};
  let currentHref: string | undefined;
  
  for (const token of tokens) {
    if (token.type === 'inline' && token.children) {
      // Process the children directly - they should already have custom tokens
      runs.push(...processInlineChildren(token.children));
      continue;
    }
    
    switch (token.type) {
      case 'text':
        if (token.content) {  // Only add non-empty text
          runs.push({
            type: 'text',
            text: token.content,
            ...formatStack,
            href: currentHref
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
        runs.push({ type: 'softbreak', text: '\n' });
        break;
        
      case 'strong_open':
        formatStack.bold = true;
        break;
      case 'strong_close':
        delete formatStack.bold;
        break;
        
      case 'em_open':
        formatStack.italic = true;
        break;
      case 'em_close':
        delete formatStack.italic;
        break;
        
      case 's_open':
        formatStack.strikethrough = true;
        break;
      case 's_close':
        delete formatStack.strikethrough;
        break;
        
      case 'link_open':
        currentHref = token.attrGet('href');
        break;
      case 'link_close':
        currentHref = undefined;
        break;
        
      case 'html_inline':
        const html = token.content;
        if (html === '<u>') formatStack.underline = true;
        else if (html === '</u>') delete formatStack.underline;
        else if (html === '<sup>') formatStack.superscript = true;
        else if (html === '</sup>') delete formatStack.superscript;
        else if (html === '<sub>') formatStack.subscript = true;
        else if (html === '</sub>') delete formatStack.subscript;
        break;
        
      case 'critic_markup':
        if (token.criticType === 'critic_sub') {
          runs.push({
            type: 'critic_sub',
            text: token.oldText || '',
            newText: token.newText || '',
            ...formatStack,
            href: currentHref
          });
        } else if (token.criticType === 'critic_comment') {
          runs.push({
            type: 'critic_comment',
            text: '',
            author: token.author,
            date: token.date,
            commentText: token.commentText,
            ...formatStack,
            href: currentHref
          });
        } else {
          runs.push({
            type: token.criticType,
            text: token.content,
            author: token.author,
            date: token.date,
            ...formatStack,
            href: currentHref
          });
        }
        break;
        
      case 'colored_highlight':
        runs.push({
          type: 'critic_highlight',
          text: token.content,
          highlight: true,
          highlightColor: token.color,
          ...formatStack,
          href: currentHref
        });
        break;
        
      case 'plain_highlight':
        runs.push({
          type: 'critic_highlight',
          text: token.content,
          highlight: true,
          ...formatStack,
          href: currentHref
        });
        break;
        
      case 'citation':
        runs.push({
          type: 'citation',
          text: token.content,
          keys: token.keys,
          locators: token.locators,
          ...formatStack,
          href: currentHref
        });
        break;
        
      case 'math':
        runs.push({
          type: 'math',
          text: token.content,
          display: token.display,
          ...formatStack,
          href: currentHref
        });
        break;

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
    }
  }

  return runs;
}

function findClosingToken(tokens: any[], start: number, closeType: string): number {
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

function extractListItems(tokens: any[], ordered: boolean, level: number): MdToken[] {
  const items: MdToken[] = [];
  let i = 0;
  
  while (i < tokens.length) {
    if (tokens[i].type === 'list_item_open') {
      const closePos = findClosingToken(tokens, i, 'list_item_close');
      const itemTokens = tokens.slice(i + 1, closePos);
      let runs: MdRun[] = [];
      
      for (let j = 0; j < itemTokens.length; j++) {
        if (itemTokens[j].type === 'paragraph_open') {
          const paragraphClose = findClosingToken(itemTokens, j, 'paragraph_close');
          runs = processInlineChildren(itemTokens.slice(j + 1, paragraphClose));
          break;
        } else if (itemTokens[j].type === 'inline') {
          runs = processInlineChildren([itemTokens[j]]);
          break;
        }
      }
      
      items.push({ type: 'list_item', ordered, level, runs });
      
      // Extract nested sublists
      for (let j = 0; j < itemTokens.length; j++) {
        if (itemTokens[j].type === 'bullet_list_open' || itemTokens[j].type === 'ordered_list_open') {
          const subClose = findClosingToken(itemTokens, j, itemTokens[j].type.replace('_open', '_close'));
          const subOrdered = itemTokens[j].type === 'ordered_list_open';
          items.push(...extractListItems(itemTokens.slice(j + 1, subClose), subOrdered, level + 1));
          j = subClose;
        }
      }
      
      i = closePos + 1;
    } else {
      i++;
    }
  }
  
  return items;
}

function extractTableData(tokens: any[]): MdTableRow[] {
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

function extractTableCells(tokens: any[]): MdTableCell[] {
  const cells: MdTableCell[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].type === 'td_open' || tokens[i].type === 'th_open') {
      const closeType = tokens[i].type.replace('_open', '_close');
      const closePos = findClosingToken(tokens, i, closeType);
      cells.push({ runs: convertInlineTokens(tokens.slice(i + 1, closePos)) });
      i = closePos + 1;
    } else {
      i++;
    }
  }

  return cells;
}

function extractHtmlTables(html: string): MdTableRow[][] {
  const tables: MdTableRow[][] = [];
  // Regex-based extraction intentionally does not support nested <table> blocks.
  // This converter targets simple manuscript tables (<table>/<tr>/<th>/<td>).
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const rows = extractHtmlTableRows(tableMatch[1]);
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

function extractHtmlTableRows(tableHtml: string): MdTableRow[] {
  const rows: MdTableRow[] = [];
  // Similarly, nested <tr> structures are out of scope for this lightweight parser.
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells = extractHtmlTableCells(rowMatch[1]);
    if (cells.length > 0) {
      rows.push({
        cells: cells.map(cell => ({
          runs: cell.runs,
          ...(cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {}),
          ...(cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
        })),
        header: cells.some(c => c.isHeader)
      });
    }
  }
  return rows;
}

function extractHtmlTableCells(rowHtml: string): Array<{ runs: MdRun[]; isHeader: boolean; colspan?: number; rowspan?: number }> {
  const cells: Array<{ runs: MdRun[]; isHeader: boolean; colspan?: number; rowspan?: number }> = [];
  // Nested table-cell tags are not supported; this matches flat <th>/<td> content only.
  const cellRegex = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let cellMatch: RegExpExecArray | null;
  while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
    const isHeader = cellMatch[1].toLowerCase() === 'th';
    const attrs = cellMatch[2];
    const runs = parseHtmlCellRuns(cellMatch[3]);
    const colspanMatch = attrs.match(/colspan\s*=\s*["']?(\d+)/i);
    const rowspanMatch = attrs.match(/rowspan\s*=\s*["']?(\d+)/i);
    const colspan = colspanMatch ? parseInt(colspanMatch[1], 10) : undefined;
    const rowspan = rowspanMatch ? parseInt(rowspanMatch[1], 10) : undefined;
    cells.push({
      runs,
      isHeader,
      ...(colspan && colspan > 1 ? { colspan } : {}),
      ...(rowspan && rowspan > 1 ? { rowspan } : {}),
    });
  }
  return cells;
}

function parseHtmlCellRuns(cellHtml: string): MdRun[] {
  const runs: MdRun[] = [];
  let bold = false;
  let italic = false;
  let underline = false;
  let strikethrough = false;
  let code = false;
  let superscript = false;
  let subscript = false;
  let href: string | undefined;

  // Tokenize the HTML into tags and text segments
  const tagRegex = /<(\/?)(\w+)\b([^>]*)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(cellHtml)) !== null) {
    // Emit any text before this tag
    if (match.index > lastIndex) {
      const rawText = cellHtml.slice(lastIndex, match.index);
      const text = decodeHtmlEntities(rawText).replace(/\s+/g, ' ');
      if (text) {
        runs.push({
          type: 'text', text,
          ...(bold ? { bold } : {}),
          ...(italic ? { italic } : {}),
          ...(underline ? { underline } : {}),
          ...(strikethrough ? { strikethrough } : {}),
          ...(code ? { code } : {}),
          ...(superscript ? { superscript } : {}),
          ...(subscript ? { subscript } : {}),
          ...(href ? { href } : {}),
        });
      }
    }
    lastIndex = match.index + match[0].length;

    const isClose = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attrs = match[3];

    if (tag === 'br') {
      runs.push({ type: 'softbreak', text: '\n' });
    } else if (tag === 'b' || tag === 'strong') {
      bold = !isClose;
    } else if (tag === 'i' || tag === 'em') {
      italic = !isClose;
    } else if (tag === 'u') {
      underline = !isClose;
    } else if (tag === 's' || tag === 'del' || tag === 'strike') {
      strikethrough = !isClose;
    } else if (tag === 'code') {
      code = !isClose;
    } else if (tag === 'sup') {
      superscript = !isClose;
    } else if (tag === 'sub') {
      subscript = !isClose;
    } else if (tag === 'a') {
      if (!isClose) {
        const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
        href = hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : undefined;
      } else {
        href = undefined;
      }
    } else if (tag === 'p' && isClose) {
      // Treat </p> as a soft break to separate paragraphs within a cell
      runs.push({ type: 'softbreak', text: '\n' });
    }
  }

  // Emit any trailing text
  if (lastIndex < cellHtml.length) {
    const rawText = cellHtml.slice(lastIndex);
    const text = decodeHtmlEntities(rawText).replace(/\s+/g, ' ');
    if (text) {
      runs.push({
        type: 'text', text,
        ...(bold ? { bold } : {}),
        ...(italic ? { italic } : {}),
        ...(underline ? { underline } : {}),
        ...(strikethrough ? { strikethrough } : {}),
        ...(code ? { code } : {}),
        ...(superscript ? { superscript } : {}),
        ...(subscript ? { subscript } : {}),
        ...(href ? { href } : {}),
      });
    }
  }

  // Trim leading/trailing whitespace from the run sequence
  if (runs.length > 0) {
    const first = runs[0];
    if (first.type === 'text') {
      first.text = first.text.replace(/^\s+/, '');
      if (!first.text) runs.shift();
    }
  }
  if (runs.length > 0) {
    const last = runs[runs.length - 1];
    if (last.type === 'softbreak') runs.pop();
    else if (last.type === 'text') {
      last.text = last.text.replace(/\s+$/, '');
      if (!last.text) runs.pop();
    }
  }

  // If we ended up with no runs, return a single empty text run
  if (runs.length === 0) {
    runs.push({ type: 'text', text: '' });
  }

  return runs;
}

function decodeHtmlEntities(text: string): string {
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

// OOXML Generation Layer

async function extractTemplateParts(templateDocx: Uint8Array): Promise<Map<string, Uint8Array>> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(templateDocx);
  const parts = new Map<string, Uint8Array>();
  
  for (const path of ['word/styles.xml', 'word/theme/theme1.xml', 'word/numbering.xml', 'word/settings.xml']) {
    const file = zip.file(path);
    if (file) {
      parts.set(path, await file.async('uint8array'));
    }
  }
  return parts;
}

export interface MdToDocxOptions {
  bibtex?: string;
  authorName?: string;
  templateDocx?: Uint8Array;
  zoteroBiblData?: ZoteroBiblData;
  /** Directory for caching downloaded CSL styles (e.g. VS Code global storage). */
  cslCacheDir?: string;
  /** Directory of the source markdown file, used to resolve relative CSL paths. */
  sourceDir?: string;
  /** Called when a CSL style is not bundled or found locally.
   *  Return true to attempt downloading from the CSL repository. */
  onStyleNotFound?: (styleName: string) => Promise<boolean>;
  /** How to render mixed Zotero/non-Zotero grouped citations. */
  mixedCitationStyle?: 'separate' | 'unified';
}

export interface MdToDocxResult {
  docx: Uint8Array;
  warnings: string[];
}

export interface DocxGenState {
  commentId: number;
  comments: CommentEntry[];
  commentIdMap: Map<string, number>; // markdown ID -> OOXML numeric ID
  relationships: Map<string, string>; // URL -> rId
  nextRId: number;
  rIdOffset: number; // reserved rIds for fixed relationships (styles, numbering, comments, theme, settings)
  warnings: string[];
  hasList: boolean;
  hasComments: boolean;
  missingKeys: Set<string>;
  timezone?: string; // UTC offset from frontmatter (e.g. "-05:00")
  replyRanges: Array<{replyId: number; parentId: number}>;
}

interface CommentEntry {
  id: number;
  author: string;
  date: string;
  text: string;
  paraId: string;            // generated 8-hex-char ID
  parentParaId?: string;     // set for replies
}

/**
 * Normalize a date string to UTC ISO format for Word XML.
 * Handles:
 * - ISO with offset: "2024-01-15T10:30-05:00" → "2024-01-15T15:30:00Z"
 * - ISO with Z: "2024-01-15T15:30:00Z" → passed through
 * - Local format without offset: "2024-01-15 10:30" → uses fallbackTz to build UTC
 * - Already UTC ISO: returned as-is
 */
export function normalizeToUtcIso(dateStr: string, fallbackTz?: string): string {
  if (!dateStr) return stripMillis(new Date().toISOString());

  // If the string already has a timezone offset (+ or - after time, or trailing Z), parse directly
  const hasOffset = /T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/.test(dateStr);
  if (hasOffset) {
    const dt = new Date(dateStr);
    if (!isNaN(dt.getTime())) return stripMillis(dt.toISOString());
  }

  // Local date format like "2024-01-15T10:30" or "2024-01-15 10:30"
  // Append fallback timezone to interpret correctly
  const normalized = dateStr.replace(' ', 'T');
  if (fallbackTz) {
    const dt = new Date(normalized + fallbackTz);
    if (!isNaN(dt.getTime())) return stripMillis(dt.toISOString());
  }

  // Last resort: parse as-is (system local time interpretation)
  const dt = new Date(normalized);
  if (!isNaN(dt.getTime())) return stripMillis(dt.toISOString());

  // If nothing works, return the original string
  return dateStr;
}

function stripMillis(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

function contentTypesXml(hasList: boolean, hasComments: boolean, hasTheme?: boolean, hasCustomProps?: boolean, hasCommentsExtended?: boolean): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n';
  xml += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n';
  xml += '<Default Extension="xml" ContentType="application/xml"/>\n';
  xml += '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n';
  xml += '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>\n';
  xml += '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>\n';
  xml += '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>\n';
  if (hasList) {
    xml += '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>\n';
  }
  if (hasComments) {
    xml += '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>\n';
  }
  if (hasCommentsExtended) {
    xml += '<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>\n';
  }
  if (hasTheme) {
    xml += '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>\n';
  }
  xml += '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\n';
  xml += '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>\n';
  if (hasCustomProps) {
    xml += '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>\n';
  }
  xml += '</Types>';
  return xml;
}

function relsXml(hasCustomProps?: boolean): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>\n' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>\n';
  if (hasCustomProps) {
    xml += '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>\n';
  }
  xml += '</Relationships>';
  return xml;
}

function stylesXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">\n' +
    '<w:name w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:after="200" w:line="276" w:lineRule="auto"/></w:pPr>\n' +
    '<w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading1">\n' +
    '<w:name w:val="heading 1"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="240" w:after="0"/></w:pPr>\n' +
    '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading2">\n' +
    '<w:name w:val="heading 2"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="200" w:after="0"/></w:pPr>\n' +
    '<w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading3">\n' +
    '<w:name w:val="heading 3"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="200" w:after="0"/></w:pPr>\n' +
    '<w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading4">\n' +
    '<w:name w:val="heading 4"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading5">\n' +
    '<w:name w:val="heading 5"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:rPr><w:b/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading6">\n' +
    '<w:name w:val="heading 6"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:rPr><w:b/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="character" w:styleId="Hyperlink">\n' +
    '<w:name w:val="Hyperlink"/>\n' +
    '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Quote">\n' +
    '<w:name w:val="Quote"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:ind w:left="720"/></w:pPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="character" w:styleId="CodeChar">\n' +
    '<w:name w:val="Code Char"/>\n' +
    '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="CodeBlock">\n' +
    '<w:name w:val="Code Block"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="E8E8E8"/></w:pPr>\n' +
    '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Title">\n' +
    '<w:name w:val="Title"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="0" w:after="300"/></w:pPr>\n' +
    '<w:rPr><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr>\n' +
    '</w:style>\n' +
    '</w:styles>';
}

function numberingXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n' +
    '<w:abstractNum w:abstractNumId="0">\n' +
    '<w:multiLevelType w:val="hybridMultilevel"/>\n' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2160" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="3"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2880" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="4"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="3600" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="5"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="4320" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="6"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="5040" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="7"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="5760" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="8"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="6480" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '</w:abstractNum>\n' +
    '<w:abstractNum w:abstractNumId="1">\n' +
    '<w:multiLevelType w:val="hybridMultilevel"/>\n' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%2."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%3."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2160" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="3"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%4."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2880" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="4"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%5."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="3600" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="5"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%6."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="4320" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="6"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%7."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="5040" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="7"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%8."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="5760" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="8"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%9."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="6480" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '</w:abstractNum>\n' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>\n' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>\n' +
    '</w:numbering>';
}

function settingsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15">\n' +
    '<w:compat>\n' +
    '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>\n' +
    '</w:compat>\n' +
    '<w:defaultTabStop w:val="720"/>\n' +
    '<w:characterSpacingControl w:val="doNotCompress"/>\n' +
    '</w:settings>';
}

function fontTableXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n' +
    '<w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>\n' +
    '<w:font w:name="Times New Roman"><w:panose1 w:val="02020603050405020304"/><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>\n' +
    '<w:font w:name="Courier New"><w:panose1 w:val="02070309020205020404"/><w:charset w:val="00"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font>\n' +
    '</w:fonts>';
}

function corePropsXml(author?: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n';
  if (author && author.trim()) {
    xml += '<dc:creator>' + escapeXml(author) + '</dc:creator>\n';
  }
  xml += '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>\n' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>\n' +
    '</cp:coreProperties>';
  return xml;
}

function appPropsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">\n' +
    '<Application>Manuscript Markup</Application>\n' +
    '</Properties>';
}
interface CustomPropEntry {
  name: string;
  value: string;
}

function customPropsXml(properties: CustomPropEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\n';
  for (let i = 0; i < properties.length; i++) {
    const pid = i + 2; // fmtid starts at pid=2 per OOXML convention
    xml += '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="' + pid + '" name="' + escapeXml(properties[i].name) + '">';
    xml += '<vt:lpwstr>' + escapeXml(properties[i].value) + '</vt:lpwstr>';
    xml += '</property>\n';
  }
  xml += '</Properties>';
  return xml;
}

function zoteroCustomProps(fm: Frontmatter): CustomPropEntry[] {
  const styleId = zoteroStyleFullId(fm.csl || '');
  const prefData = JSON.stringify({
    dataVersion: 4,
    zoteroVersion: '6.0',
    style: {
      styleID: styleId,
      locale: fm.locale || 'en-US',
      hasBibliography: true,
      bibliographyStyleHasBeenSet: true,
    },
    prefs: {
      fieldType: 'Field',
      noteType: fm.noteType ? noteTypeToNumber(fm.noteType) : 0,
    },
  });

  // Chunk the pref string into ZOTERO_PREF_1, ZOTERO_PREF_2, etc. (max 240 chars each)
  const CHUNK_SIZE = 240;
  const props: CustomPropEntry[] = [];
  for (let i = 0; i < prefData.length; i += CHUNK_SIZE) {
    props.push({
      name: 'ZOTERO_PREF_' + (props.length + 1),
      value: prefData.slice(i, i + CHUNK_SIZE),
    });
  }
  return props;
}

function commentIdMappingProps(commentIdMap: Map<string, number>): CustomPropEntry[] {
  if (commentIdMap.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [mdId, numericId] of commentIdMap) {
    mapping[String(numericId)] = mdId;
  }
  const mappingJson = JSON.stringify(mapping);
  const CHUNK_SIZE = 240;
  const props: CustomPropEntry[] = [];
  for (let i = 0; i < mappingJson.length; i += CHUNK_SIZE) {
    props.push({
      name: 'MANUSCRIPT_COMMENT_IDS_' + (props.length + 1),
      value: mappingJson.slice(i, i + CHUNK_SIZE),
    });
  }
  return props;
}

function documentRelsXml(relationships: Map<string, string>, hasList: boolean, hasComments: boolean, hasTheme?: boolean, hasCommentsExtended?: boolean): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
  xml += '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n';

  if (hasList) {
    xml += '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>\n';
  }

  if (hasComments) {
    xml += '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>\n';
  }

  let nextFixed = 4;
  if (hasCommentsExtended) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>\n';
    nextFixed++;
  }
  if (hasTheme) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>\n';
    nextFixed++;
  }
  xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>\n';
  nextFixed++;
  xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>\n';

  for (const [url, relId] of relationships) {
    xml += '<Relationship Id="' + relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + escapeXml(url) + '" TargetMode="External"/>\n';
  }

  xml += '</Relationships>';
  return xml;
}

export function generateRPr(run: MdRun): string {
  const parts: string[] = [];
  
  if (run.code) parts.push('<w:rStyle w:val="CodeChar"/>');
  if (run.bold) parts.push('<w:b/>');
  if (run.italic) parts.push('<w:i/>');
  if (run.strikethrough) parts.push('<w:strike/>');
  if (run.underline) parts.push('<w:u w:val="single"/>');
  if (run.highlight) {
    const color = COLOR_TO_OOXML[run.highlightColor || 'yellow'] || 'yellow';
    parts.push('<w:highlight w:val="' + color + '"/>');
  }
  if (run.superscript) parts.push('<w:vertAlign w:val="superscript"/>');
  else if (run.subscript) parts.push('<w:vertAlign w:val="subscript"/>');
  
  return parts.length > 0 ? '<w:rPr>' + parts.join('') + '</w:rPr>' : '';
}

export function generateRun(text: string, rPr: string): string {
  return '<w:r>' + rPr + '<w:t xml:space="preserve">' + escapeXml(text) + '</w:t></w:r>';
}

export function generateRuns(inputRuns: MdRun[], state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: any): string {
  let xml = '';
  for (let ri = 0; ri < inputRuns.length; ri++) {
    const run = inputRuns[ri];
    const nextRun = inputRuns[ri + 1];
    if (run.type === 'text') {
      const rPr = generateRPr(run);
      if (run.href) {
        let rId = state.relationships.get(run.href);
        if (!rId) {
          rId = 'rId' + (state.nextRId + state.rIdOffset);
          state.relationships.set(run.href, rId);
          state.nextRId++;
        }
        xml += '<w:hyperlink r:id="' + rId + '">' + generateRun(run.text, rPr) + '</w:hyperlink>';
      } else {
        xml += generateRun(run.text, rPr);
      }
    } else if (run.type === 'softbreak') {
      xml += '<w:r><w:br/></w:r>';
    } else if (run.type === 'critic_add') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const rPr = generateRPr(run);
      xml += '<w:ins w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '" w:date="' + escapeXml(date) + '">' + generateRun(run.text, rPr) + '</w:ins>';
    } else if (run.type === 'critic_del') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const rPr = generateRPr(run);
      xml += '<w:del w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '" w:date="' + escapeXml(date) + '"><w:r>' + (rPr ? rPr : '') + '<w:delText xml:space="preserve">' + escapeXml(run.text) + '</w:delText></w:r></w:del>';
    } else if (run.type === 'critic_sub') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const rPr = generateRPr(run);
      xml += '<w:del w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '" w:date="' + escapeXml(date) + '"><w:r>' + (rPr ? rPr : '') + '<w:delText xml:space="preserve">' + escapeXml(run.text) + '</w:delText></w:r></w:del>';
      xml += '<w:ins w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '" w:date="' + escapeXml(date) + '">' + generateRun(run.newText || '', rPr) + '</w:ins>';
    } else if (run.type === 'critic_highlight') {
      if (nextRun?.type === 'critic_comment') {
        const commentId = state.commentId++;
        const author = nextRun.author || options?.authorName || 'Unknown';
        const date = normalizeToUtcIso(nextRun.date || '', state.timezone);
        const commentBody = nextRun.commentText || '';
        state.comments.push({ id: commentId, author, date, text: commentBody, paraId: generateParaId() });
        state.hasComments = true;
        xml += '<w:commentRangeStart w:id="' + commentId + '"/>';
        const highlightRun = { ...run, type: 'text' as const, highlight: true };
        xml += generateRun(run.text, generateRPr(highlightRun));
        xml += '<w:commentRangeEnd w:id="' + commentId + '"/>';
        xml += '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + commentId + '"/></w:r>';
        ri++; // skip the comment run
      } else {
        const highlightRun = { ...run, type: 'text' as const, highlight: true };
        xml += generateRun(run.text, generateRPr(highlightRun));
      }
    } else if (run.type === 'critic_comment') {
      const commentId = state.commentId++;
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const commentBody = run.commentText || '';

      state.comments.push({ id: commentId, author, date, text: commentBody, paraId: generateParaId() });
      state.hasComments = true;

      if (run.text) {
        xml += '<w:commentRangeStart w:id="' + commentId + '"/>';
        const highlightRun = { ...run, type: 'text' as const, highlight: true };
        xml += generateRun(run.text, generateRPr(highlightRun));
        xml += '<w:commentRangeEnd w:id="' + commentId + '"/>';
      }
      xml += '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + commentId + '"/></w:r>';
    } else if (run.type === 'citation') {
      const result = generateCitation(run, bibEntries || new Map(), citeprocEngine);
      xml += result.xml;
      if (result.warning) state.warnings.push(result.warning);
      if (result.missingKeys) {
        for (const k of result.missingKeys) state.missingKeys.add(k);
      }
    } else if (run.type === 'math') {
      xml += generateMathXml(run.text, !!run.display);
    } else if (run.type === 'comment_range_start') {
      const mdId = run.commentId || '';
      let numericId = state.commentIdMap.get(mdId);
      if (numericId === undefined) {
        numericId = state.commentId++;
        state.commentIdMap.set(mdId, numericId);
      }
      xml += '<w:commentRangeStart w:id="' + numericId + '"/>';
      // Also emit range starts for replies associated with this parent
      for (const rr of state.replyRanges) {
        if (rr.parentId === numericId) {
          xml += '<w:commentRangeStart w:id="' + rr.replyId + '"/>';
        }
      }
      state.hasComments = true;
    } else if (run.type === 'comment_range_end') {
      const mdId = run.commentId || '';
      const numericId = state.commentIdMap.get(mdId);
      if (numericId === undefined) {
        state.warnings.push(`Unmatched comment range end marker: {/${mdId}}`);
        continue;
      }
      // Emit reply range ends before parent's
      for (const rr of state.replyRanges) {
        if (rr.parentId === numericId) {
          xml += '<w:commentRangeEnd w:id="' + rr.replyId + '"/>';
          xml += '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + rr.replyId + '"/></w:r>';
        }
      }
      xml += '<w:commentRangeEnd w:id="' + numericId + '"/>';
      xml += '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + numericId + '"/></w:r>';
    } else if (run.type === 'comment_body_with_id') {
      const mdId = run.commentId || '';
      const numericId = state.commentIdMap.get(mdId);
      if (numericId === undefined) {
        state.warnings.push(`Comment body {#${mdId}>>...<<} has no matching range markers {#${mdId}}...{/${mdId}}`);
        continue;
      }
      // Only emit the comment entry once per ID (multi-paragraph comments
      // may produce duplicate body markers in the markdown).
      if (!state.comments.some(c => c.id === numericId)) {
        const author = run.author || options?.authorName || 'Unknown';
        const date = normalizeToUtcIso(run.date || '', state.timezone);
        const commentBody = run.commentText || '';
        const parentParaId = generateParaId();
        state.comments.push({ id: numericId, author, date, text: commentBody, paraId: parentParaId });

        // Generate reply comment entries
        if (run.replies && run.replies.length > 0) {
          for (const reply of run.replies) {
            const replyId = state.commentId++;
            const replyParaId = generateParaId();
            const replyAuthor = reply.author || options?.authorName || 'Unknown';
            const replyDate = normalizeToUtcIso(reply.date || '', state.timezone);
            state.comments.push({ id: replyId, author: replyAuthor, date: replyDate, text: reply.text, paraId: replyParaId, parentParaId });
            state.replyRanges.push({ replyId, parentId: numericId });
          }
        }
      }
      state.hasComments = true;
    }
  }
  return xml;
}

export function generateParagraph(token: MdToken, state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: any): string {
  let pPr = '';
  
  switch (token.type) {
    case 'heading':
      pPr = '<w:pPr><w:pStyle w:val="Heading' + (token.level || 1) + '"/></w:pPr>';
      break;
    case 'list_item':
      const numId = token.ordered ? '2' : '1';
      const ilvl = (token.level || 1) - 1;
      pPr = '<w:pPr><w:numPr><w:ilvl w:val="' + ilvl + '"/><w:numId w:val="' + numId + '"/></w:numPr></w:pPr>';
      state.hasList = true;
      break;
    case 'blockquote':
      const leftIndent = 720 * (token.level || 1);
      pPr = '<w:pPr><w:pStyle w:val="Quote"/><w:ind w:left="' + leftIndent + '"/></w:pPr>';
      break;
    case 'code_block':
      pPr = '<w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>';
      break;
    case 'hr':
      pPr = '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr>';
      break;
  }
  
  if (token.type === 'code_block') {
    const lines = (token.runs[0]?.text || '').split('\n');
    return lines.map(line => '<w:p>' + pPr + generateRun(line, '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr>') + '</w:p>').join('');
  }
  
  if (token.type === 'hr') {
    return '<w:p>' + pPr + '</w:p>';
  }
  
  const runs = generateRuns(token.runs, state, options, bibEntries, citeprocEngine);

  return '<w:p>' + pPr + runs + '</w:p>';
}

export function generateTable(token: MdToken, state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: any): string {
  if (!token.rows) return '';

  // Compute total grid columns by simulating grid occupancy (accounts for
  // columns implicitly occupied by rowspan cells from previous rows).
  let totalCols = 0;
  {
    const simMerge = new Map<number, { remaining: number; colspan: number }>();
    for (const row of token.rows) {
      let gridCol = 0;
      let ci = 0;
      // Walk the grid for this row, skipping columns occupied by rowspan continuations
      while (ci < row.cells.length) {
        // Skip columns occupied by pending vertical merges
        let pending = simMerge.get(gridCol);
        while (pending && pending.remaining > 0) {
          pending.remaining--;
          if (pending.remaining === 0) simMerge.delete(gridCol);
          gridCol += pending.colspan;
          pending = simMerge.get(gridCol);
        }
        const cell = row.cells[ci++];
        const cs = cell.colspan || 1;
        const rs = cell.rowspan || 1;
        if (rs > 1) {
          simMerge.set(gridCol, { remaining: rs - 1, colspan: cs });
        }
        gridCol += cs;
      }
      // Skip any trailing columns still occupied by merges
      let pending = simMerge.get(gridCol);
      while (pending && pending.remaining > 0) {
        pending.remaining--;
        if (pending.remaining === 0) simMerge.delete(gridCol);
        gridCol += pending.colspan;
        pending = simMerge.get(gridCol);
      }
      if (gridCol > totalCols) totalCols = gridCol;
    }
  }
  if (totalCols === 0) totalCols = 1;

  // Check if any cell uses colspan or rowspan
  const hasSpans = token.rows.some(row =>
    row.cells.some(cell => (cell.colspan && cell.colspan > 1) || (cell.rowspan && cell.rowspan > 1))
  );

  const hasHeaderRow = token.rows.some(row => row.header);

  let xml = '<w:tbl>';
  xml += '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar><w:tblW w:w="0" w:type="auto"/>' + (hasHeaderRow ? '<w:tblLook w:firstRow="1"/>' : '') + '</w:tblPr>';

  // Emit tblGrid if spans are present
  if (hasSpans) {
    xml += '<w:tblGrid>';
    for (let c = 0; c < totalCols; c++) {
      xml += '<w:gridCol/>';
    }
    xml += '</w:tblGrid>';
  }

  // Track pending vertical merges: gridCol -> { remaining: number; colspan: number }
  const mergeMap = new Map<number, { remaining: number; colspan: number }>();

  for (const row of token.rows) {
    xml += '<w:tr>';
    if (row.header) {
      xml += '<w:trPr><w:tblHeader/></w:trPr>';
    }
    let cellIdx = 0;
    let gridCol = 0;

    while (gridCol < totalCols) {
      // Check for pending vertical merge continuation at this column
      const pending = mergeMap.get(gridCol);
      if (pending && pending.remaining > 0) {
        let tcPr = '<w:tcPr>';
        if (pending.colspan > 1) {
          tcPr += '<w:gridSpan w:val="' + pending.colspan + '"/>';
        }
        tcPr += '<w:vMerge/></w:tcPr>';
        xml += '<w:tc>' + tcPr + '<w:p/></w:tc>';
        pending.remaining--;
        if (pending.remaining === 0) mergeMap.delete(gridCol);
        gridCol += pending.colspan;
        continue;
      }

      // Emit real cell
      if (cellIdx >= row.cells.length) {
        // Pad with empty cells if row is short
        xml += '<w:tc><w:p/></w:tc>';
        gridCol++;
        continue;
      }

      const cell = row.cells[cellIdx++];
      const cs = cell.colspan || 1;
      const rs = cell.rowspan || 1;

      let tcPr = '';
      if (cs > 1 || rs > 1) {
        // ECMA-376 §17.4.66: tcPr children order is gridSpan then vMerge
        const parts: string[] = [];
        if (cs > 1) parts.push('<w:gridSpan w:val="' + cs + '"/>');
        if (rs > 1) parts.push('<w:vMerge w:val="restart"/>');
        tcPr = '<w:tcPr>' + parts.join('') + '</w:tcPr>';
      }

      // Register vertical merge for subsequent rows
      if (rs > 1) {
        mergeMap.set(gridCol, { remaining: rs - 1, colspan: cs });
      }

      xml += '<w:tc>' + tcPr + '<w:p>';
      // Apply header bold by augmenting runs before rendering
      const cellRuns = row.header
        ? cell.runs.map(r => r.type === 'text' && !r.bold ? { ...r, bold: true } : r)
        : cell.runs;
      xml += generateRuns(cellRuns, state, options, bibEntries, citeprocEngine);
      xml += '</w:p></w:tc>';
      gridCol += cs;
    }
    xml += '</w:tr>';
  }

  xml += '</w:tbl>';
  return xml;
}

function generateParaId(): string {
  return Math.floor(Math.random() * 0xFFFFFFFF).toString(16).toUpperCase().padStart(8, '0');
}

function commentsXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">';
  for (const c of comments) {
    xml += '<w:comment w:id="' + c.id + '" w:author="' + escapeXml(c.author) + '" w:date="' + escapeXml(c.date) + '">';
    // Split on \n\n for paragraph breaks within the comment
    const paragraphs = c.text.split('\n\n');
    for (let pi = 0; pi < paragraphs.length; pi++) {
      // Add w14:paraId to the first paragraph
      const paraIdAttr = pi === 0 ? ' w14:paraId="' + c.paraId + '"' : '';
      xml += '<w:p' + paraIdAttr + '><w:r><w:t xml:space="preserve">' + escapeXml(paragraphs[pi]) + '</w:t></w:r></w:p>';
    }
    xml += '</w:comment>';
  }
  xml += '</w:comments>';
  return xml;
}

function commentsExtendedXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w15">';
  for (const c of comments) {
    if (c.parentParaId) {
      xml += '<w15:commentEx w15:paraId="' + c.paraId + '" w15:paraIdParent="' + c.parentParaId + '" w15:done="0"/>';
    } else {
      xml += '<w15:commentEx w15:paraId="' + c.paraId + '" w15:done="0"/>';
    }
  }
  xml += '</w15:commentsEx>';
  return xml;
}

export function generateDocumentXml(tokens: MdToken[], state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: any, frontmatter?: Frontmatter): string {
  let body = '';

  // Emit title paragraphs from frontmatter before body content
  if (frontmatter?.title) {
    for (const line of frontmatter.title) {
      body += '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>' + generateRun(line, '') + '</w:p>';
    }
  }

  for (const token of tokens) {
    if (token.type === 'table') {
      body += generateTable(token, state, options, bibEntries, citeprocEngine);
    } else {
      body += generateParagraph(token, state, options, bibEntries, citeprocEngine);
    }
  }

  // Append bibliography field if we have a citeproc engine
  if (citeprocEngine) {
    body += generateBibliographyXml(citeprocEngine, options?.zoteroBiblData);
  }

  // Append missing-key notes after bibliography
  if (state.missingKeys.size > 0) {
    body += generateMissingKeysXml([...state.missingKeys]);
  }

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 wp14">\n' +
    '<w:body>\n' + body + '\n</w:body>\n' +
    '</w:document>';
}

export async function convertMdToDocx(
  markdown: string,
  options?: MdToDocxOptions
): Promise<MdToDocxResult> {
  // Parse frontmatter for CSL style and other metadata
  const { metadata: frontmatter, body } = parseFrontmatter(markdown);
  const tokens = parseMd(body);

  // Parse BibTeX if provided
  let bibEntries: Map<string, BibtexEntry> | undefined;
  if (options?.bibtex) {
    bibEntries = parseBibtex(options.bibtex);
  }

  // Create citeproc engine if CSL style specified in frontmatter
  let citeprocEngine: any;
  const earlyWarnings: string[] = [];
  if (frontmatter.csl && bibEntries) {
    let styleName = frontmatter.csl;

    // 0. Resolve file-like CSL values (relative or absolute paths)
    const isFileLike = styleName.endsWith('.csl') || isAbsolute(styleName);
    if (isFileLike && !isAbsolute(styleName)) {
      if (options?.sourceDir) {
        const resolved = join(options.sourceDir, styleName);
        if (existsSync(resolved)) {
          styleName = resolved;
        } else {
          earlyWarnings.push(`CSL file "${styleName}" not found in source directory (${options.sourceDir}).`);
        }
      } else {
        earlyWarnings.push(`Relative CSL path "${styleName}" cannot be resolved without a source directory.`);
      }
    }

    // 1. Try bundled styles
    let result = createCiteprocEngineLocal(bibEntries, styleName, frontmatter.locale);

    // 2. Try CSL cache directory (e.g. VS Code global storage)
    if (result.styleNotFound && options?.cslCacheDir) {
      const cachedPath = join(options.cslCacheDir, styleName.endsWith('.csl') ? styleName : styleName + '.csl');
      if (existsSync(cachedPath)) {
        result = createCiteprocEngineLocal(bibEntries, cachedPath, frontmatter.locale);
      }
    }

    // 3. Ask user whether to download
    if (result.styleNotFound) {
      let shouldDownload = false;
      if (options?.onStyleNotFound) {
        shouldDownload = await options.onStyleNotFound(styleName);
      }
      if (shouldDownload && options?.cslCacheDir) {
        try {
          await downloadStyle(styleName, options.cslCacheDir);
          const downloadedPath = join(options.cslCacheDir, styleName.endsWith('.csl') ? styleName : styleName + '.csl');
          result = createCiteprocEngineLocal(bibEntries, downloadedPath, frontmatter.locale);
        } catch {
          earlyWarnings.push(`CSL style "${styleName}" could not be downloaded. Export completed without CSL citation formatting.`);
        }
      } else if (shouldDownload) {
        // No cslCacheDir — fall back to async download into bundled dir
        result = await createCiteprocEngineAsync(bibEntries, styleName, frontmatter.locale);
        if (result.styleNotFound) {
          earlyWarnings.push(`CSL style "${styleName}" could not be downloaded. Export completed without CSL citation formatting.`);
        }
      } else {
        earlyWarnings.push(`CSL style "${styleName}" is not bundled. Export completed without CSL citation formatting.`);
      }
    }

    citeprocEngine = result.engine;
  }

  // Extract template parts if provided
  let templateParts: Map<string, Uint8Array> | undefined;
  if (options?.templateDocx) {
    templateParts = await extractTemplateParts(options.templateDocx);
  }

  const hasTheme = !!templateParts?.has('word/theme/theme1.xml');

  // Reserve rId slots: 1=styles, 2=numbering, 3=comments, 4+=commentsExtended/theme/settings/fontTable
  // We don't know hasCommentsExtended yet (depends on state after generation), so reserve an extra slot
  const rIdOffset = 3 + 1 + (hasTheme ? 1 : 0) + 2; // +1 for commentsExtended, +2 for settings and fontTable

  const state: DocxGenState = {
    commentId: 0,
    comments: [],
    commentIdMap: new Map(),
    relationships: new Map(),
    nextRId: 1,
    rIdOffset,
    warnings: [...earlyWarnings],
    hasList: false,
    hasComments: false,
    missingKeys: new Set(),
    timezone: frontmatter.timezone,
    replyRanges: [],
  };

  const documentXml = generateDocumentXml(tokens, state, options, bibEntries, citeprocEngine, frontmatter);

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('word/document.xml', documentXml);

  // Use template styles if available, otherwise default
  if (templateParts?.has('word/styles.xml')) {
    zip.file('word/styles.xml', templateParts.get('word/styles.xml')!);
  } else {
    zip.file('word/styles.xml', stylesXml());
  }

  // Always use generated settings.xml to guarantee compatibilityMode >= 15
  // (template settings.xml may have compatibilityMode < 15, causing "unreadable content" errors)
  zip.file('word/settings.xml', settingsXml());

  // Always include fontTable.xml
  zip.file('word/fontTable.xml', fontTableXml());

  // Handle numbering - use template as base but ensure bullet/decimal definitions exist
  if (state.hasList) {
    if (templateParts?.has('word/numbering.xml')) {
      zip.file('word/numbering.xml', templateParts.get('word/numbering.xml')!);
    } else {
      zip.file('word/numbering.xml', numberingXml());
    }
  }

  // Include template theme if available
  if (hasTheme) {
    zip.file('word/theme/theme1.xml', templateParts!.get('word/theme/theme1.xml')!);
  }

  const hasCommentsExtended = state.hasComments && state.comments.some(c => c.parentParaId);
  if (state.hasComments) {
    zip.file('word/comments.xml', commentsXml(state.comments));
    if (hasCommentsExtended) {
      zip.file('word/commentsExtended.xml', commentsExtendedXml(state.comments));
    }
  }

  // Document properties
  zip.file('docProps/core.xml', corePropsXml(frontmatter.author));
  zip.file('docProps/app.xml', appPropsXml());

  const customProps: CustomPropEntry[] = [];
  if (frontmatter.csl) {
    customProps.push(...zoteroCustomProps(frontmatter));
  }
  customProps.push(...commentIdMappingProps(state.commentIdMap));
  const hasCustomProps = customProps.length > 0;
  if (hasCustomProps) {
    zip.file('docProps/custom.xml', customPropsXml(customProps));
  }

  zip.file('[Content_Types].xml', contentTypesXml(state.hasList, state.hasComments, hasTheme, hasCustomProps, hasCommentsExtended));
  zip.file('_rels/.rels', relsXml(hasCustomProps));
  zip.file('word/_rels/document.xml.rels', documentRelsXml(state.relationships, state.hasList, state.hasComments, hasTheme, hasCommentsExtended));

  // Check for comment range markers without corresponding bodies
  for (const [mdId, numericId] of state.commentIdMap) {
    if (!state.comments.some(c => c.id === numericId)) {
      state.warnings.push(`Comment range markers {#${mdId}}...{/${mdId}} exist without corresponding body {#${mdId}>>...<<}`);
    }
  }

  const docx = await zip.generateAsync({ type: 'uint8array' });
  return { docx, warnings: state.warnings };
}
