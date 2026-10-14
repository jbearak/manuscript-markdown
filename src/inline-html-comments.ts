import type MarkdownIt from 'markdown-it';
import html_inline from 'markdown-it/lib/rules_inline/html_inline.mjs';

/**
 * Read a comment in a paragraph's text, `<!-- ... -->`, as markdown-it's
 * html_inline does, in time linear in the text. Its regex reads the text
 * after each `<!--` to the end where no comment ends, and to read a comment
 * that ends in a paragraph of many that don't, as `a <!-- --->` many times,
 * which markdown-it reads as text, took time past the square of their
 * number. Preview and Word export must install the same rule.
 */
export function linearInlineComments(md: MarkdownIt): void {
  md.inline.ruler.at('html_inline', (state, silent) => {
    const pos = state.pos;
    // markdown-it's own rule reads anything else, and a comment that ends,
    // in time linear in it
    if (!state.md.options.html || pos + 2 >= state.posMax || !state.src.startsWith('<!--', pos)
      || state.src.startsWith('<!-->', pos) || state.src.startsWith('<!--->', pos)) return html_inline(state, silent);
    // Where no comment ends, html_inline reads none, as its regex matches
    // nothing else at a <!--
    if (commentEndsOf(state)[pos + 4] === -1) return false;
    return html_inline(state, silent);
  });
}

const statesEnds = new WeakMap<object, { src: string; ends: Int32Array }>();

/** commentEnds of an inline state's text, all of it, which html_inline
 *  reads past the state's end, found once for the state */
function commentEndsOf(state: { src: string }): Int32Array {
  let found = statesEnds.get(state);
  if (!found || found.src !== state.src) statesEnds.set(state, found = { src: state.src, ends: commentEnds(state.src) });
  return found.ends;
}

/**
 * For each offset of `src`, the offset of the `-->` that ends a comment
 * whose text starts there, as markdown-it's comment regex reads it, or -1
 * for none. The regex, `<!--(?:[^-]|-[^-]|--[^>])*-->`, takes a character
 * that isn't a -, a - and one that isn't, or two and one that isn't a >,
 * and which it takes from an offset is the only one it can, so the steps
 * from each offset are one path, which ends at the first --> it starts a
 * step at, as none of the three takes a --> there, or at a - it can't take,
 * at the text's end. So each offset's end is its next step's, found from
 * the text's end back.
 */
export function commentEnds(src: string): Int32Array {
  const length = src.length;
  const ends = new Int32Array(length + 1);
  ends[length] = -1;
  for (let at = length - 1; at >= 0; at--) {
    if (src.charCodeAt(at) !== 0x2D) ends[at] = ends[at + 1];
    else if (at + 1 >= length) ends[at] = -1;
    else if (src.charCodeAt(at + 1) !== 0x2D) ends[at] = ends[at + 2];
    else if (at + 2 >= length) ends[at] = -1;
    else if (src.charCodeAt(at + 2) === 0x3E) ends[at] = at;
    else ends[at] = ends[at + 3];
  }
  return ends;
}
