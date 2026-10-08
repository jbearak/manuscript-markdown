// How export reads markdown-it's HTML blocks, which the orientation scan
// reads the same way, so the language server flags what export does.

import type Token from 'markdown-it/lib/token.mjs';
import { isGfmDisallowedRawHtml } from './gfm';
import { GRID_TABLE_PLACEHOLDER_PREFIX } from './grid-table-preprocess';
import { extractHtmlTables } from './html-table-parser';

/**
 * Where the HTML comments that start at `start` in `text` end, each to its
 * first --> after its <!--, with the spaces and tabs after it, or `start`
 * where none does. Found by indexOf, as a regex's repeat of a comment's
 * characters, as (?:(?!-->)[\s\S])*, keeps a place to go back to for each,
 * and past some tens of thousands ran many times slower.
 */
export function commentsEnd(text: string, start = 0): number {
  let end = start;
  while (text.startsWith('<!--', end)) {
    const close = text.indexOf('-->', end + 4);
    if (close === -1) break;
    end = close + 3;
    while (text[end] === ' ' || text[end] === '\t') end++;
  }
  return end;
}

// A <br>, and the whitespace between two, read one at a time: a regex of all
// of them, as /^(?:<br\s*\/?>\s*)+$/i, failed in Bun 1.3.9, which builds the
// CLI, past some 700,000 breaks, and so read them as text
const BREAK_AT = /<br\s*\/?>/iy;
const WHITESPACE_AT = /\s*/y;
const SPACES_AT = /[ \t]*/y;

/** Whether `text` from `from` to its end is line breaks, with what `gap`
 *  matches between them and after the last */
function breaksToEnd(text: string, from: number, gap: RegExp): boolean {
  let at = from;
  do {
    BREAK_AT.lastIndex = at;
    if (!BREAK_AT.test(text)) return false;
    gap.lastIndex = BREAK_AT.lastIndex;
    gap.test(text);
    at = gap.lastIndex;
  } while (at < text.length);
  return true;
}

/** Whether export reads an HTML block's text as line breaks, alone or after
 *  comments, with the spaces and tabs after each comment and between the
 *  breaks after them, not as text, with the spaces before them as text */
export function isLineBreakBlock(content: string): boolean {
  const text = content.trim();
  if (breaksToEnd(text, 0, WHITESPACE_AT)) return true;
  const end = commentsEnd(text);
  return end > 0 && breaksToEnd(text, end, SPACES_AT);
}

export type HtmlBlockKind = 'grid' | 'comment' | 'raw' | 'image' | 'breaks' | 'tables' | 'text';

/**
 * What export makes of an HTML block, `content` (see convertTokens in
 * md-to-docx.ts): a grid table, from its placeholder; comments alone, which
 * hold no table; HTML that GFM disallows, kept as text; an image; line
 * breaks, alone or after comments; one or more tables, with rows outside
 * comments; or else text.
 */
export function htmlBlockKind(content: string): HtmlBlockKind {
  const trimmed = content.trim();
  if (trimmed.startsWith(GRID_TABLE_PLACEHOLDER_PREFIX)) return 'grid';
  const tables = () => extractHtmlTables(content).some(meta => meta.rows.length > 0);
  if (/^<!--[\s\S]*?-->\s*$/.test(trimmed) && !tables()) return 'comment';
  if (isGfmDisallowedRawHtml(content)) return 'raw';
  if (/^<img\s/i.test(trimmed)) return 'image';
  if (isLineBreakBlock(content)) return 'breaks';
  return tables() ? 'tables' : 'text';
}

/**
 * What a list item makes of its HTML block `tokens[j]`, among the item's
 * tokens, where export reads it as one or more tables, `holdsTables` (see
 * extractListItems in md-to-docx.ts):
 * - skipped: an empty comment between two numbered sublists, as import
 *   writes it where Word starts the second over, which their numbering keeps;
 * - dropped: a table, which an item can't hold, or a block that only its end
 *   ends, as a <pre> its </pre>, a comment its --> or a processing
 *   instruction its ?>, without its end and with more of the item after it,
 *   which markdown-it ended at a blank line in the item;
 * - kept: the item's text if it comes first, or a continuation otherwise.
 * A comment after the item's text that reads as a directive, which the item
 * can't hold, goes too, as extractListItems reads it.
 */
export function listItemHtmlBlock(tokens: Token[], j: number, holdsTables: () => boolean): 'skipped' | 'dropped' | 'kept' {
  const content = tokens[j].content;
  if (/^\s*<!--\s*-->\s*$/.test(content) && tokens[j - 1]?.type === 'ordered_list_close' && tokens[j + 1]?.type === 'ordered_list_open') return 'skipped';
  const tables = holdsTables();
  const more = !!tokens[j + 1] && tokens[j + 1].type !== 'list_item_close';
  // A comment's end can take the dashes of its start, as in <!-->
  const raw = /^\s*<(?:(script|pre|style|textarea)(?=[\s>]|$)|(\?)|(!\[CDATA\[)|(!(?=--))|![A-Za-z])/i.exec(content);
  const end = raw?.[1] ? new RegExp('</' + raw[1] + '>', 'i') : raw?.[2] ? /\?>/ : raw?.[3] ? /\]\]>/ : raw?.[4] ? /-->/ : />/;
  return (raw && more && !end.test(content.slice(raw[0].length))) || tables ? 'dropped' : 'kept';
}
