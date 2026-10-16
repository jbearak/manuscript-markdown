import { codeOverlapTest } from './code-regions';
import { editorBlocks, type EditorBlocks } from './editor-blocks';

/** Whether `ch` is a character of a comment's ID, [a-zA-Z0-9_-] */
function isIdChar(ch: number): boolean {
  return (ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) || ch === 0x5F || ch === 0x2D;
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
 * With `blocks` (see editorBlocks in editor-blocks.ts), a format
 * highlight's match that runs past its paragraph's text (see limitAt
 * there), as past a blank line, is none: the scan goes on at the character
 * after its opener's first, as where the pattern doesn't match. Where that
 * text holds an == that export may read as text (see inertMarks there), a
 * highlight's match is one the scan read before, as a match from an opener
 * that export may read as text is (see inertOpener there): a highlight's
 * match that the scan read before may have taken it. And where a
 * highlight's opener or closer is in what export may read in other blocks
 * (see unsure there), its match is one the scan read before, wherever it
 * ends.
 */
export function navigationMatches(pattern: RegExp, text: string, blocks?: Pick<EditorBlocks, 'limitAt' | 'unsure' | 'inertMarks' | 'inertOpener'>): Array<{ start: number; end: number }> {
  const sticky = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'y');
  const lastAddition = text.lastIndexOf('++}');
  const lastDeletion = text.lastIndexOf('--}');
  const lastSubstitution = text.lastIndexOf('~~}');
  const lastHighlight = text.lastIndexOf('==}');
  const lastComment = text.lastIndexOf('<<}');
  const lastHtmlComment = text.lastIndexOf('-->');
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
  // The end of each match the scan read before, by its start, found once
  // where the scan first reads as before
  let before: Map<number, number> | undefined;
  // Whether the scan read the match from `at` to `end` before
  const readBefore = (at: number, end: number): boolean => {
    if (!before) {
      before = new Map();
      for (const match of navigationMatches(pattern, text)) before.set(match.start, match.end);
    }
    return before.get(at) === end;
  };
  const matches: Array<{ start: number; end: number }> = [];
  for (let at = 0; at < text.length; at++) {
    const ch = text.charCodeAt(at);
    if (ch !== 0x7B && ch !== 0x3D && ch !== 0x7E && ch !== 0x3C) continue; // { = ~ <
    if ((ch === 0x7B || ch === 0x3C) && unclosed(at)) continue;
    sticky.lastIndex = at;
    const match = sticky.exec(text);
    if (match === null) continue;
    const end = at + match[0].length;
    // A format highlight's match, the only one that starts with an =, runs
    // in its paragraph's text, and is one the scan read before where that
    // holds an == that export may read as text, as a match from an opener
    // that export may read as text is (see blocks)
    if (blocks) {
      if (ch === 0x3D && (blocks.unsure(at, at + 1) || blocks.unsure(end - 1, end))) {
        if (!readBefore(at, end)) continue;
      } else if (ch === 0x3D ? end > blocks.limitAt(at) || (blocks.inertMarks(at) && !readBefore(at, end)) : blocks.inertOpener(at) && !readBefore(at, end)) continue;
    }
    matches.push({ start: at, end });
    // Each alternative matches at least its opener and closer
    at = end - 1;
  }
  return matches;
}

/**
 * The ranges navigation stops at in `text`, as getAllMatches in changes.ts
 * finds them with `pattern`, its combinedPattern: navigationMatches's with
 * each format highlight held to its paragraph's text (see editorBlocks),
 * without those that hold code, nor one in the last kept.
 */
export function navigationRanges(pattern: RegExp, text: string): Array<{ start: number; end: number }> {
  const blocks = editorBlocks(text);
  const holdsCode = codeOverlapTest(blocks.codeRegions);
  const ranges: Array<{ start: number; end: number }> = [];
  let lastKept: { start: number; end: number } | undefined;
  for (const range of navigationMatches(pattern, text, blocks)) {
    if (holdsCode(range.start, range.end)) continue;
    if (lastKept && lastKept.start <= range.start && range.end <= lastKept.end) continue;
    ranges.push(range);
    lastKept = range;
  }
  return ranges;
}
