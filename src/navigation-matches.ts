import { codeOverlapTest } from './code-regions';
import { criticCloserSearch, type CriticCloserSearch } from './critic-markup';
import { isEscapedAt } from './math-delimiters';
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
 * With `blocks` (see editorBlocks in editor-blocks.ts), no CriticMarkup
 * span's or format highlight's match starts in code, an HTML block or a
 * link's definition, as export reads none there, nor an HTML comment's in
 * code. A span wholly in code is passed whole, as before, and the ~~} of a
 * {~~ in code whose span ends past it starts nothing, as that span's match
 * took it before. A bare ~~'s match still starts in code, but at a {~~'s
 * ~~, as before: one took the next ~~ after the code, which a bare ~~ after
 * it would take, as one before a {~~, whose ~~ the pattern reads as its
 * closer. And a format highlight's match that runs past its paragraph's
 * text (see limitAt there), as past a blank line, is none: the scan goes on
 * at the character after its opener's first, as where the pattern doesn't
 * match. A match from an opener before code still reads the code's text for
 * its closer, as export's search does.
 */
export function navigationMatches(pattern: RegExp, text: string, blocks?: Pick<EditorBlocks, 'inCode' | 'inert' | 'inertEnd' | 'limitAt'>): Array<{ start: number; end: number }> {
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
  // Whether the ~ at `at` is one of a {~~'s, whose { no backslash escapes
  const isSubstitutionMarker = (at: number): boolean => {
    const open = text.charCodeAt(at - 1) === 0x7B ? at - 1 : text.charCodeAt(at - 1) === 0x7E && text.charCodeAt(at - 2) === 0x7B ? at - 2 : -1;
    return open !== -1 && text.charCodeAt(open + 1) === 0x7E && text.charCodeAt(open + 2) === 0x7E && !isEscapedAt(text, open);
  };
  // Each closer's offsets, for spans in code
  let closers: CriticCloserSearch | undefined;
  // The end of the pattern's match from the { at `at`: a span's, from its
  // opener to the first closer of its kind after it, or a comment range's
  // marker's, as {#id}, or -1 for none
  const matchEnd = (at: number): number => {
    const marker = text.charCodeAt(at + 1);
    let closer: string | undefined;
    let from = at + 3;
    if (marker === text.charCodeAt(at + 2)) {
      closer = marker === 0x2B ? '++}' : marker === 0x2D ? '--}' : marker === 0x7E ? '~~}' : marker === 0x3D ? '==}' : marker === 0x3E ? '<<}' : undefined;
    } else if (marker === 0x23 || marker === 0x2F) { // {#id>>, {#id} or {/id}
      let end = at + 2;
      while (isIdChar(text.charCodeAt(end))) end++;
      if (end === at + 2) return -1;
      if (text.charCodeAt(end) === 0x7D) return end + 1;
      if (marker !== 0x23 || text.charCodeAt(end) !== 0x3E || text.charCodeAt(end + 1) !== 0x3E) return -1;
      closer = '<<}';
      from = end + 2;
    }
    if (!closer) return -1;
    closers ??= criticCloserSearch(text);
    const closeAt = closers.next(closer, from);
    return closeAt === -1 ? -1 : closeAt + 3;
  };
  // The ~~} of each {~~ in code whose span ends past the code, whose ~~
  // the {~~'s match took, so starts no bare ~~'s, as before
  const passedClosers = new Set<number>();
  const matches: Array<{ start: number; end: number }> = [];
  for (let at = 0; at < text.length; at++) {
    const ch = text.charCodeAt(at);
    if (ch !== 0x7B && ch !== 0x3D && ch !== 0x7E && ch !== 0x3C) continue; // { = ~ <
    if ((ch === 0x7B || ch === 0x3C) && unclosed(at)) continue;
    if (ch === 0x7E && (passedClosers.has(at) || passedClosers.has(at - 1))) continue;
    // Nothing opens in code, an HTML block or a link's definition (see
    // blocks), nor a {~~'s ~~ there, nor an HTML comment in code. A span
    // wholly in code is passed whole, as before, so that no bare ~~ in it
    // opens. Another bare ~~ there still does, as before
    if (blocks && (ch === 0x7E ? isSubstitutionMarker(at) && blocks.inert(at)
      : ch === 0x3C ? blocks.inCode(at) : blocks.inert(at))) {
      if (ch !== 0x7B || isEscapedAt(text, at)) continue;
      const end = matchEnd(at);
      if (end === -1) continue;
      if (end > blocks.inertEnd(at)) {
        if (text.charCodeAt(at + 1) === 0x7E && text.charCodeAt(at + 2) === 0x7E) passedClosers.add(end - 3);
        continue;
      }
      sticky.lastIndex = at;
      const span = sticky.exec(text);
      if (span !== null) at += span[0].length - 1;
      continue;
    }
    sticky.lastIndex = at;
    const match = sticky.exec(text);
    if (match === null) continue;
    // A format highlight's match, the only one that starts with an =
    if (ch === 0x3D && blocks && at + match[0].length > blocks.limitAt(at)) continue;
    matches.push({ start: at, end: at + match[0].length });
    // Each alternative matches at least its opener and closer
    at += match[0].length - 1;
  }
  return matches;
}

/**
 * The ranges navigation stops at in `text`, as getAllMatches in changes.ts
 * finds them with `pattern`, its combinedPattern: navigationMatches's with
 * no match starting in code and each format highlight held to its
 * paragraph's text (see editorBlocks), without those that hold code, nor
 * one in the last kept.
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
