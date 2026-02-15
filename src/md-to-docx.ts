import MarkdownIt from 'markdown-it';
import { escapeXml, generateCitation, generateMathXml, createCiteprocEngineLocal, createCiteprocEngineAsync, generateBibliographyXml } from './md-to-docx-citations';
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

export interface MdTableRow {
  cells: MdRun[][];         // each cell has runs
  header: boolean;
}

export interface MdRun {
  type: 'text' | 'critic_add' | 'critic_del' | 'critic_sub' | 'critic_highlight' | 'critic_comment' | 'citation' | 'math' | 'softbreak';
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

// Custom inline rules
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
  
  const endPos = state.src.indexOf(endMarker, start + 3);
  if (endPos === -1) return false;
  
  if (!silent) {
    const content = state.src.slice(start + 3, endPos);
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
      const match = content.match(/^(.+?)\s+\(([^)]+)\):\s*(.*)$/);
      if (match) {
        token.author = match[1];
        token.date = match[2];
        token.commentText = match[3];
      } else if (content.trim()) {
        // If it contains a colon, treat as comment text
        // If it looks like a valid author name (alphanumeric, underscore, dash), treat as author
        // Otherwise, treat as comment text
        if (content.includes(':') || content.includes(' ') || /[^a-zA-Z0-9_-]/.test(content)) {
          token.commentText = content;
        } else {
          token.author = content;
          token.commentText = '';
        }
      } else {
        // Empty comment
        token.commentText = '';
      }
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
      if (/^[a-z0-9-]+$/.test(color)) {
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

function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({ html: true });
  
  md.inline.ruler.before('emphasis', 'colored_highlight', coloredHighlightRule);
  md.inline.ruler.before('emphasis', 'critic_markup', criticMarkupRule);
  md.inline.ruler.before('emphasis', 'citation', citationRule);
  md.inline.ruler.before('emphasis', 'math', mathRule);
  
  return md;
}

export function parseMd(markdown: string): MdToken[] {
  const md = createMarkdownIt();
  const tokens = md.parse(markdown, {});
  
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

function extractTableCells(tokens: any[]): MdRun[][] {
  const cells: MdRun[][] = [];
  let i = 0;
  
  while (i < tokens.length) {
    if (tokens[i].type === 'td_open' || tokens[i].type === 'th_open') {
      const closeType = tokens[i].type.replace('_open', '_close');
      const closePos = findClosingToken(tokens, i, closeType);
      cells.push(convertInlineTokens(tokens.slice(i + 1, closePos)));
      i = closePos + 1;
    } else {
      i++;
    }
  }
  
  return cells;
}

export function prettyPrintMd(tokens: MdToken[]): string {
  const lines: string[] = [];
  
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const nextToken = tokens[i + 1];
    
    switch (token.type) {
      case 'heading':
        const hashes = '#'.repeat(token.level || 1);
        lines.push(hashes + ' ' + formatRuns(token.runs));
        lines.push('');
        break;
        
      case 'paragraph':
        lines.push(formatRuns(token.runs));
        lines.push('');
        break;
        
      case 'list_item':
        const indent = '  '.repeat((token.level || 1) - 1);
        const marker = token.ordered ? '1. ' : '- ';
        lines.push(indent + marker + formatRuns(token.runs));
        // Add blank line if next token is not a list item
        if (nextToken && nextToken.type !== 'list_item') {
          lines.push('');
        }
        break;
        
      case 'blockquote':
        const prefix = '>'.repeat(token.level || 1) + ' ';
        lines.push(prefix + formatRuns(token.runs));
        // Add blank line if next token is not a blockquote
        if (nextToken && nextToken.type !== 'blockquote') {
          lines.push('');
        }
        break;
        
      case 'code_block':
        const lang = token.language || '';
        lines.push('```' + lang);
        const codeContent = token.runs[0]?.text || '';
        // Don't add extra newline if content already ends with one
        const trimmedContent = codeContent.endsWith('\n') ? codeContent.slice(0, -1) : codeContent;
        lines.push(trimmedContent);
        lines.push('```');
        lines.push('');
        break;
        
      case 'table':
        if (token.rows) {
          for (let j = 0; j < token.rows.length; j++) {
            const row = token.rows[j];
            const cellTexts = row.cells.map(cell => formatRuns(cell));
            lines.push('| ' + cellTexts.join(' | ') + ' |');
            
            if (j === 0 && row.header) {
              const separator = cellTexts.map(() => '---').join(' | ');
              lines.push('| ' + separator + ' |');
            }
          }
          lines.push('');
        }
        break;
        
      case 'hr':
        lines.push('---');
        lines.push('');
        break;
    }
  }
  
  return lines.join('\n').replace(/\n+$/, '\n');
}

function mergeAdjacentRuns(runs: MdRun[]): MdRun[] {
  const result: MdRun[] = [];
  for (const run of runs) {
    const prev = result[result.length - 1];
    if (prev && prev.type === 'text' && run.type === 'text' &&
        !!prev.bold === !!run.bold && !!prev.italic === !!run.italic &&
        !!prev.underline === !!run.underline && !!prev.strikethrough === !!run.strikethrough &&
        !!prev.code === !!run.code && !!prev.superscript === !!run.superscript &&
        !!prev.subscript === !!run.subscript && prev.href === run.href) {
      prev.text += run.text;
    } else {
      result.push({ ...run });
    }
  }
  return result;
}

function formatRuns(runs: MdRun[]): string {
  return mergeAdjacentRuns(runs).map(run => {
    let text = run.text;
    
    switch (run.type) {
      case 'critic_add':
        return '{++' + text + '++}';
      case 'critic_del':
        return '{--' + text + '--}';
      case 'critic_sub':
        return '{~~' + text + '~>' + (run.newText || '') + '~~}';
      case 'critic_highlight':
        if (run.highlightColor) {
          return '==' + text + '=={' + run.highlightColor + '}';
        }
        return '==' + text + '==';
      case 'critic_comment':
        if (run.author && run.date && run.commentText) {
          return '{>>' + run.author + ' (' + run.date + '): ' + run.commentText + '<<}';
        } else if (run.commentText) {
          return '{>>' + run.commentText + '<<}';
        } else if (run.author) {
          return '{>>' + run.author + '<<}';
        }
        return '{>><<}';  // Empty comment
      case 'citation':
        if (run.keys && run.locators && run.locators.size > 0) {
          const parts = run.keys.map(key => {
            const locator = run.locators!.get(key);
            return locator ? '@' + key + ', ' + locator : '@' + key;
          });
          return '[' + parts.join('; ') + ']';
        } else if (run.keys) {
          return '[' + run.keys.map(k => '@' + k).join('; ') + ']';
        }
        return '[@' + text + ']';
      case 'math':
        if (run.display) {
          return '$$' + text + '$$';
        }
        return '$' + text + '$';
      case 'softbreak':
        return '\n';
      default:
        // Apply formatting
        if (run.bold && run.italic) text = '***' + text + '***';
        else if (run.bold) text = '**' + text + '**';
        else if (run.italic) text = '*' + text + '*';
        
        if (run.strikethrough) text = '~~' + text + '~~';
        if (run.underline) text = '<u>' + text + '</u>';
        if (run.superscript) text = '<sup>' + text + '</sup>';
        if (run.subscript) text = '<sub>' + text + '</sub>';
        if (run.code) text = '`' + text + '`';
        
        if (run.href) {
          const needsAngles = /[()[\]\s]/.test(run.href);
          const url = needsAngles ? '<' + run.href + '>' : run.href;
          text = '[' + text + '](' + url + ')';
        }
        
        return text;
    }
  }).join('');
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
}

export interface MdToDocxResult {
  docx: Uint8Array;
  warnings: string[];
}

interface DocxGenState {
  commentId: number;
  comments: CommentEntry[];
  relationships: Map<string, string>; // URL -> rId
  nextRId: number;
  rIdOffset: number; // reserved rIds for fixed relationships (styles, numbering, comments, theme, settings)
  warnings: string[];
  hasList: boolean;
  hasComments: boolean;
}

interface CommentEntry {
  id: number;
  author: string;
  date: string;
  text: string;
}

function contentTypesXml(hasList: boolean, hasComments: boolean, hasTheme?: boolean, hasCustomProps?: boolean): string {
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

function corePropsXml(): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
    '<dc:creator>Manuscript Markup</dc:creator>\n' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>\n' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>\n' +
    '</cp:coreProperties>';
}

function appPropsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">\n' +
    '<Application>Manuscript Markup</Application>\n' +
    '</Properties>';
}

function zoteroCustomPropsXml(fm: Frontmatter): string {
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
  const chunks: string[] = [];
  for (let i = 0; i < prefData.length; i += CHUNK_SIZE) {
    chunks.push(prefData.slice(i, i + CHUNK_SIZE));
  }

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\n';
  for (let i = 0; i < chunks.length; i++) {
    const pid = i + 2; // fmtid starts at pid=2 per OOXML convention
    xml += '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="' + pid + '" name="ZOTERO_PREF_' + (i + 1) + '">';
    xml += '<vt:lpwstr>' + escapeXml(chunks[i]) + '</vt:lpwstr>';
    xml += '</property>\n';
  }
  xml += '</Properties>';
  return xml;
}

function documentRelsXml(relationships: Map<string, string>, hasList: boolean, hasComments: boolean, hasTheme?: boolean): string {
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
  
  let runs = '';
  for (let ri = 0; ri < token.runs.length; ri++) {
    const run = token.runs[ri];
    const nextRun = token.runs[ri + 1];
    if (run.type === 'text') {
      const rPr = generateRPr(run);
      if (run.href) {
        let rId = state.relationships.get(run.href);
        if (!rId) {
          rId = 'rId' + (state.nextRId + state.rIdOffset);
          state.relationships.set(run.href, rId);
          state.nextRId++;
        }
        runs += '<w:hyperlink r:id="' + rId + '">' + generateRun(run.text, rPr) + '</w:hyperlink>';
      } else {
        runs += generateRun(run.text, rPr);
      }
    } else if (run.type === 'softbreak') {
      runs += '<w:r><w:br/></w:r>';
    } else if (run.type === 'critic_add') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = run.date || new Date().toISOString();
      const rPr = generateRPr(run);
      runs += '<w:ins w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '" w:date="' + escapeXml(date) + '">' + generateRun(run.text, rPr) + '</w:ins>';
    } else if (run.type === 'critic_del') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = run.date || new Date().toISOString();
      const rPr = generateRPr(run);
      runs += '<w:del w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '" w:date="' + escapeXml(date) + '"><w:r>' + (rPr ? rPr : '') + '<w:delText xml:space="preserve">' + escapeXml(run.text) + '</w:delText></w:r></w:del>';
    } else if (run.type === 'critic_sub') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = run.date || new Date().toISOString();
      const rPr = generateRPr(run);
      runs += '<w:del w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '" w:date="' + escapeXml(date) + '"><w:r>' + (rPr ? rPr : '') + '<w:delText xml:space="preserve">' + escapeXml(run.text) + '</w:delText></w:r></w:del>';
      runs += '<w:ins w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '" w:date="' + escapeXml(date) + '">' + generateRun(run.newText || '', rPr) + '</w:ins>';
    } else if (run.type === 'critic_highlight') {
      // Check if next run is a comment anchored to this highlight
      if (nextRun?.type === 'critic_comment') {
        const commentId = state.commentId++;
        const author = nextRun.author || options?.authorName || 'Unknown';
        const date = nextRun.date || new Date().toISOString();
        const commentBody = nextRun.commentText || '';
        state.comments.push({ id: commentId, author, date, text: commentBody });
        state.hasComments = true;
        runs += '<w:commentRangeStart w:id="' + commentId + '"/>';
        const highlightRun = { ...run, type: 'text' as const, highlight: true };
        runs += generateRun(run.text, generateRPr(highlightRun));
        runs += '<w:commentRangeEnd w:id="' + commentId + '"/>';
        runs += '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + commentId + '"/></w:r>';
        ri++; // skip the comment run
      } else {
        const highlightRun = { ...run, type: 'text' as const, highlight: true };
        runs += generateRun(run.text, generateRPr(highlightRun));
      }
    } else if (run.type === 'critic_comment') {
      const commentId = state.commentId++;
      const author = run.author || options?.authorName || 'Unknown';
      const date = run.date || new Date().toISOString();
      const commentBody = run.commentText || '';
      
      state.comments.push({ id: commentId, author, date, text: commentBody });
      state.hasComments = true;
      
      if (run.text) {
        runs += '<w:commentRangeStart w:id="' + commentId + '"/>';
        const highlightRun = { ...run, type: 'text' as const, highlight: true };
        runs += generateRun(run.text, generateRPr(highlightRun));
        runs += '<w:commentRangeEnd w:id="' + commentId + '"/>';
      }
      runs += '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + commentId + '"/></w:r>';
    } else if (run.type === 'citation') {
      const result = generateCitation(run, bibEntries || new Map(), citeprocEngine);
      runs += result.xml;
      if (result.warning) state.warnings.push(result.warning);
    } else if (run.type === 'math') {
      runs += generateMathXml(run.text, !!run.display);
    }
    // Skip other run types
  }
  
  return '<w:p>' + pPr + runs + '</w:p>';
}

export function generateTable(token: MdToken): string {
  if (!token.rows) return '';
  
  let xml = '<w:tbl>';
  xml += '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar><w:tblW w:w="0" w:type="auto"/></w:tblPr>';
  
  for (const row of token.rows) {
    xml += '<w:tr>';
    for (const cell of row.cells) {
      xml += '<w:tc><w:p>';
      for (const run of cell) {
        if (run.type === 'text') {
          let rPr = generateRPr(run);
          if (row.header && !run.bold) {
            rPr = rPr ? rPr.replace('</w:rPr>', '<w:b/></w:rPr>') : '<w:rPr><w:b/></w:rPr>';
          }
          xml += generateRun(run.text, rPr);
        }
      }
      xml += '</w:p></w:tc>';
    }
    xml += '</w:tr>';
  }
  
  xml += '</w:tbl>';
  return xml;
}

function commentsXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
  for (const c of comments) {
    xml += '<w:comment w:id="' + c.id + '" w:author="' + escapeXml(c.author) + '" w:date="' + escapeXml(c.date) + '">';
    xml += '<w:p><w:r><w:t>' + escapeXml(c.text) + '</w:t></w:r></w:p>';
    xml += '</w:comment>';
  }
  xml += '</w:comments>';
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
      body += generateTable(token);
    } else {
      body += generateParagraph(token, state, options, bibEntries, citeprocEngine);
    }
  }

  // Append bibliography field if we have a citeproc engine
  if (citeprocEngine) {
    body += generateBibliographyXml(citeprocEngine, options?.zoteroBiblData);
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
          earlyWarnings.push(`Relative CSL file not found: "${resolved}".`);
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

  // Reserve rId slots: 1=styles, 2=numbering, 3=comments, 4+=theme/settings/fontTable
  const rIdOffset = 3 + (hasTheme ? 1 : 0) + 2; // +2 for settings and fontTable (always present)

  const state: DocxGenState = {
    commentId: 0,
    comments: [],
    relationships: new Map(),
    nextRId: 1,
    rIdOffset,
    warnings: [...earlyWarnings],
    hasList: false,
    hasComments: false,
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

  if (state.hasComments) {
    zip.file('word/comments.xml', commentsXml(state.comments));
  }

  // Document properties
  zip.file('docProps/core.xml', corePropsXml());
  zip.file('docProps/app.xml', appPropsXml());

  // Write Zotero document preferences if CSL style specified
  const hasCustomProps = !!frontmatter.csl;
  if (frontmatter.csl) {
    zip.file('docProps/custom.xml', zoteroCustomPropsXml(frontmatter));
  }

  zip.file('[Content_Types].xml', contentTypesXml(state.hasList, state.hasComments, hasTheme, hasCustomProps));
  zip.file('_rels/.rels', relsXml(hasCustomProps));
  zip.file('word/_rels/document.xml.rels', documentRelsXml(state.relationships, state.hasList, state.hasComments, hasTheme));

  const docx = await zip.generateAsync({ type: 'uint8array' });
  return { docx, warnings: state.warnings };
}
