import { criticCloserSearch } from './critic-markup';

/** Whether `ch` is a character of a comment's ID, [a-zA-Z0-9_-] */
function isIdChar(ch: number): boolean {
  return (ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) || ch === 0x5F || ch === 0x2D;
}

/** Where the text of the comment whose {>> or {#id>> starts at `at`
 *  starts, or -1 where none does */
function commentContentStart(text: string, at: number): number {
  if (text.charCodeAt(at) !== 0x7B) return -1; // {
  let end = at + 1;
  if (text.charCodeAt(end) === 0x23) { // #
    end++;
    while (isIdChar(text.charCodeAt(end))) end++;
    if (end === at + 2) return -1;
  }
  return text.charCodeAt(end) === 0x3E && text.charCodeAt(end + 1) === 0x3E ? end + 2 : -1;
}

/**
 * The matches of `pattern`, the navigation pattern combinedPattern in
 * changes.ts or a test's copy of it, in `text`, as its global exec finds
 * them one after another, in linear time.
 *
 * Each CriticMarkup alternative of the pattern, as \+\+([\s\S]*?)\+\+\},
 * and its HTML comment's, runs from an opener to the first closer after
 * it. An opener with no closer after it searched the rest of the text for
 * one, so a text of many such openers took time in their number times its
 * length. Here the last of each closer in the text is found once. An opener
 * whose text ends past the start of the last of its closers has none after
 * it, and no match starts at its first character: no other alternative
 * starts with a < or with a { and the opener's marker, but {#id}'s, whose }
 * can't come where a {#id>>'s > does. The scan steps past it. At each
 * other character a match can start at, a {, an =, a ~ or a <, the pattern
 * is tried there, sticky. A match goes on to its closer, and the scan on
 * from its end, as the global exec's does. A bare ~~ with no ~~ after it
 * still searches the rest of the text, but only the last two ~~ of the text
 * can have none.
 *
 * A comment's alternative runs to the first <<} after it, but a comment can
 * hold its replies, as {>>note {>>reply<<}<<}, so a match of a {>> or a
 * {#id>> goes on to the <<} that export pairs with it (findMatchingClose),
 * and one export pairs with none starts no match, as the preview and
 * export read none there: the scan goes on into its text, to the replies.
 */
export function navigationMatches(pattern: RegExp, text: string): Array<{ start: number; end: number }> {
  const sticky = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'y');
  const lastAddition = text.lastIndexOf('++}');
  const lastDeletion = text.lastIndexOf('--}');
  const lastSubstitution = text.lastIndexOf('~~}');
  const lastHighlight = text.lastIndexOf('==}');
  const lastComment = text.lastIndexOf('<<}');
  const lastHtmlComment = text.lastIndexOf('-->');
  const closers = criticCloserSearch(text);
  // Whether the { or < at `at` starts an opener with no closer after it
  const unclosed = (at: number): boolean => {
    if (text.charCodeAt(at) === 0x3C) return lastHtmlComment < at + 4 && text.startsWith('!--', at + 1); // <!--
    const marker = text.charCodeAt(at + 1);
    if (marker === text.charCodeAt(at + 2)) {
      if (marker === 0x2B) return lastAddition < at + 3; // {++
      if (marker === 0x2D) return lastDeletion < at + 3; // {--
      if (marker === 0x7E) return lastSubstitution < at + 3; // {~~
      if (marker === 0x3D) return lastHighlight < at + 3; // {==
      if (marker === 0x3E) return lastComment < at + 3; // {>>
      return false;
    }
    if (marker !== 0x23) return false;
    // {#id>>, whose ID is the whole run of its characters, as no shorter
    // run of them is followed by >>
    let end = at + 2;
    while (isIdChar(text.charCodeAt(end))) end++;
    return end > at + 2 && text.charCodeAt(end) === 0x3E && text.charCodeAt(end + 1) === 0x3E && lastComment < end + 2;
  };
  const matches: Array<{ start: number; end: number }> = [];
  for (let at = 0; at < text.length; at++) {
    const ch = text.charCodeAt(at);
    if (ch !== 0x7B && ch !== 0x3D && ch !== 0x7E && ch !== 0x3C) continue; // { = ~ <
    if ((ch === 0x7B || ch === 0x3C) && unclosed(at)) continue;
    // A comment export pairs with no <<} is skipped before the pattern's
    // tried, which would search on to the next <<} from each such opener
    const comment = commentContentStart(text, at);
    const close = comment === -1 ? -1 : closers.matching(comment);
    if (comment !== -1 && close === -1) continue;
    sticky.lastIndex = at;
    const match = sticky.exec(text);
    if (match === null) continue;
    const end = close === -1 ? at + match[0].length : close + 3;
    matches.push({ start: at, end });
    // Each alternative matches at least its opener and closer
    at = end - 1;
  }
  return matches;
}
