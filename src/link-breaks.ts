import type MarkdownIt from 'markdown-it';
import { LINE_PLACEHOLDER } from './critic-markup';

/** End a URL linkify finds at a backslash that ends its line, a hard break,
 * as CommonMark §6.7 reads it. markdown-it's linkify rule reads a URL with a
 * scheme from the source, before the backslash's escape is read, and its path
 * may hold a backslash, so https://e.com/a\ and a line end linked
 * https://e.com/a%5C and lost the break. An escaped backslash, as in
 * https://e.com/a\\, starts no break. A line end in CriticMarkup's text is
 * the placeholder preprocessCriticMarkup writes for it. Preview and Word
 * export must install the same rule. */
export function hardBreaksEndLinks(md: MarkdownIt): void {
  const linkify = md.linkify;
  const { matchAtStart } = linkify;
  linkify.matchAtStart = text => {
    const link = matchAtStart.call(linkify, text);
    if (!link || text[link.lastIndex] !== '\n' && !text.startsWith(LINE_PLACEHOLDER, link.lastIndex)) return link;
    let backslashes = 0;
    while (text[link.lastIndex - 1 - backslashes] === '\\') backslashes++;
    if (backslashes % 2 === 0) return link;
    // Found again without it, so what linkify trims from a URL's end, as a
    // period, it trims before the backslash too
    return matchAtStart.call(linkify, text.slice(0, link.lastIndex - 1));
  };
}
