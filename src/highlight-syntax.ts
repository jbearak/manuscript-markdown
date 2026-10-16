// A format highlight, ==text== or ==text=={color}, as export reads one (see
// coloredHighlightRule in md-to-docx.ts). The wrapper of bare environments
// reads one the same way (see latex-env-preprocess.ts), as export reads a
// highlight's text on its own, apart from the equations around it
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

/** Whether the == at `at` is a {=='s, whose { no backslash escapes, as
 *  import writes Word's { before a highlight's closing == */
function opensCriticHighlight(src: string, at: number): boolean {
  if (at === 0 || src[at - 1] !== '{') return false;
  let slashes = 0;
  while (src[at - 2 - slashes] === '\\') slashes++;
  return slashes % 2 === 0;
}

/**
 * Where the critic highlight that the {== at `at` (its ==) opens in a
 * format highlight ends: just past the ==} that closes it, once each {== in
 * it is closed in turn, or -1 if none does before `max`. Each {=='s end is
 * kept in `ends`, for the text and `max`, so a search from each == before
 * a {== that never closes doesn't read the rest of the text again.
 */
function criticHighlightEnd(src: string, at: number, max: number, ends: Map<number, number>): number {
  const known = ends.get(at);
  if (known !== undefined) return known;
  // The {=='s still open, innermost last
  const open = [at];
  let pos = at + 2;
  while (open.length > 0) {
    if (pos >= max - 1) {
      // None closes, nor any that holds it
      for (const opener of open) ends.set(opener, -1);
      return -1;
    }
    if (src[pos] === '=' && src[pos + 1] === '=') {
      if (opensCriticHighlight(src, pos)) {
        const end = ends.get(pos);
        if (end === undefined) {
          open.push(pos);
          pos += 2;
        } else {
          pos = end === -1 ? max : end;
        }
        continue;
      }
      // Its closing ==}
      if (pos + 2 < max && src[pos + 2] === '}') {
        ends.set(open.pop()!, pos + 3);
        pos += 3;
        continue;
      }
    }
    pos++;
  }
  return ends.get(at)!;
}

/** The offsets of the ==s in `src` that a format highlight's search for its
 *  closing == stops at (see findClosingHighlightMarker): each but one with a
 *  } right after it, though one that opens a critic highlight stops it */
function unbracedEquals(src: string): number[] {
  const at: number[] = [];
  for (let k = src.indexOf('=='); k !== -1; k = src.indexOf('==', k + 1)) {
    if (src[k + 2] !== '}' || opensCriticHighlight(src, k)) at.push(k);
  }
  return at;
}

/** The first == at or after `from` that a format highlight's search for its
 *  closing == stops at, of `unbraced` (see unbracedEquals), or one right
 *  before `max`, whose } is past it, or `max` if none is */
function nextUnbracedEquals(src: string, from: number, max: number, unbraced: number[]): number {
  let lo = 0;
  let hi = unbraced.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (unbraced[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  let next = lo < unbraced.length && unbraced[lo] + 1 < max ? unbraced[lo] : max;
  const last = max - 2;
  if (last >= from && last < next && src[last] === '=' && src[last + 1] === '=') next = last;
  return next;
}

/** The closing == of a format highlight whose text starts at `from`: the
 *  first == outside the critic highlights in it, each {== opening one that
 *  its ==} closes (see criticHighlightEnd), or -1 if none is before `max`.
 *  An == right before a } closes none, as the preview and the editor read
 *  it, so \{==x==} is text, its { escaped: the search goes on to the next
 *  == (see nextUnbracedEquals), which `unbraced` gives, found once for the
 *  text, as reading on past each ==} read the rest of the text again for
 *  each == before it, as in ==} repeated. Import writes a } right after a
 *  highlight's closing == as \}. */
export function findClosingHighlightMarker(src: string, from: number, max: number, ends = new Map<number, number>(), unbraced?: () => number[]): number {
  let pos = from;
  while (pos < max - 1) {
    if (src[pos] === '=' && src[pos + 1] === '=') {
      if (!opensCriticHighlight(src, pos)) {
        if (pos + 2 >= max || src[pos + 2] !== '}') return pos;
        pos = nextUnbracedEquals(src, pos + 2, max, unbraced ? unbraced() : unbracedEquals(src));
        continue;
      }
      pos = criticHighlightEnd(src, pos, max, ends);
      if (pos === -1) return -1;
      continue;
    }
    pos++;
  }
  return -1;
}

const criticHighlightEnds = new WeakMap<StateInline, { src: string; byMax: Map<number, Map<number, number>> }>();
const unbracedEqualsMemo = new WeakMap<StateInline, { src: string; at: number[] }>();

/** The ==s of a state's text that a format highlight's search for its
 *  closing == stops at (see unbracedEquals), found once for the text */
function unbracedEqualsOf(state: StateInline): number[] {
  let memo = unbracedEqualsMemo.get(state);
  if (!memo || memo.src !== state.src) unbracedEqualsMemo.set(state, memo = { src: state.src, at: unbracedEquals(state.src) });
  return memo.at;
}

/** The ends of the critic highlights in a state's text found so far, for
 *  its posMax (see criticHighlightEnd), kept for each == the rule meets */
function criticHighlightEndsOf(state: StateInline): Map<number, number> {
  let memo = criticHighlightEnds.get(state);
  if (!memo || memo.src !== state.src) criticHighlightEnds.set(state, memo = { src: state.src, byMax: new Map() });
  let ends = memo.byMax.get(state.posMax);
  if (!ends) memo.byMax.set(state.posMax, ends = new Map());
  return ends;
}

/** Where the closing == is of the format highlight the == at `start` in
 *  `state`'s text opens, before its posMax, or -1 where it opens none */
export function highlightCloseAt(state: StateInline, start: number): number {
  if (start + 2 >= state.posMax || state.src.slice(start, start + 2) !== '==') return -1;
  return findClosingHighlightMarker(state.src, start + 2, state.posMax, criticHighlightEndsOf(state), () => unbracedEqualsOf(state));
}
