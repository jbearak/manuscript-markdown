// Where Manuscript Markdown's inline syntax starts and ends, as the preview
// and Word export both read it. Each reader takes the inline state and an
// offset and gives the span there, or undefined for none; each side's rule
// makes its own tokens of it (see manuscript-markdown-plugin.ts and
// md-to-docx.ts). A span that one side read and the other didn't showed
// one thing in the preview and wrote another to Word, so neither side reads
// these spans any other way (see syntax-parity.test.ts).
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { isCaptionLabelId } from './captions';
import { citationEnd, crossRefAt, type CrossRefSource } from './citation-syntax';
import { criticCloserSearchOf } from './critic-markup';

type InlineState = Pick<StateInline, 'src' | 'posMax'>;

/** A CriticMarkup span, a comment range's marker or a comment's body with
 *  an ID. Offsets are in the state's text; `contentStart` to `contentEnd`
 *  is the text between the span's opener and closer, and `end` is just
 *  past its closer. */
export type CriticSpan =
  | { kind: 'addition' | 'deletion' | 'highlight'; contentStart: number; contentEnd: number; end: number }
  /** `separator` is where the first ~> is, which splits the old text from the new */
  | { kind: 'substitution'; contentStart: number; separator: number; contentEnd: number; end: number }
  /** `id` for {#id>>...<<}, the body of the comment whose range {#id} and {/id} mark */
  | { kind: 'comment'; id?: string; contentStart: number; contentEnd: number; end: number }
  /** `id` as the comment's: a caption's label, as {#fig-map}, which no
   *  comment's range has (see captions.ts), gets a # before it, so it marks
   *  no range */
  | { kind: 'range_start'; id: string; end: number }
  | { kind: 'range_end'; id: string; end: number };

const ID_CHAR_RE = /[a-zA-Z0-9_-]/;

function idEnd(src: string, from: number, max: number): number {
  let end = from;
  while (end < max && ID_CHAR_RE.test(src.charAt(end))) end++;
  return end;
}

/** The CriticMarkup span, range marker or comment body with an ID at
 *  `start`, which ends by the state's posMax. A comment's closer is the
 *  <<} that matches its opener, past those of its replies. */
export function criticSpanAt(state: InlineState, start: number): CriticSpan | undefined {
  const { src, posMax: max } = state;
  if (src.charCodeAt(start) !== 0x7B /* { */) return undefined;
  const closers = criticCloserSearchOf(state);
  const marker = src.slice(start + 1, start + 3);
  const closed = (closerAt: number) => closerAt !== -1 && closerAt + 3 <= max;
  if (marker === '++' || marker === '--' || marker === '==') {
    const contentEnd = closers.next(marker + '}', start + 3);
    if (!closed(contentEnd)) return undefined;
    const kind = marker === '++' ? 'addition' : marker === '--' ? 'deletion' : 'highlight';
    return { kind, contentStart: start + 3, contentEnd, end: contentEnd + 3 };
  }
  if (marker === '~~') {
    const contentEnd = closers.next('~~}', start + 3);
    if (!closed(contentEnd)) return undefined;
    // Only CriticMarkup with a ~> in it, before its closer
    const separator = closers.next('~>', start + 3);
    if (separator === -1 || separator >= contentEnd) return undefined;
    return { kind: 'substitution', contentStart: start + 3, separator, contentEnd, end: contentEnd + 3 };
  }
  if (marker === '>>') {
    const contentEnd = closers.matching(start + 3);
    if (!closed(contentEnd)) return undefined;
    return { kind: 'comment', contentStart: start + 3, contentEnd, end: contentEnd + 3 };
  }
  const sign = src.charAt(start + 1);
  if (sign !== '#' && sign !== '/') return undefined;
  const end = idEnd(src, start + 2, max);
  if (end === start + 2) return undefined;
  const id = src.slice(start + 2, end);
  if (sign === '#' && end + 1 < max && src.charAt(end) === '>' && src.charAt(end + 1) === '>') {
    const contentEnd = closers.matching(end + 2);
    if (!closed(contentEnd)) return undefined;
    return { kind: 'comment', id, contentStart: end + 2, contentEnd, end: contentEnd + 3 };
  }
  if (end >= max || src.charAt(end) !== '}') return undefined;
  if (sign === '/') return { kind: 'range_end', id, end: end + 1 };
  return { kind: 'range_start', id: isCaptionLabelId(id) ? '#' + id : id, end: end + 1 };
}

/** A format highlight, ==text==, with the color its {color} after it
 *  names, if any: an identifier that doesn't start or end with a -, so the
 *  { of CriticMarkup after the highlight, as {--x--}, isn't one. */
export interface FormatHighlightSpan {
  contentStart: number;
  contentEnd: number;
  color?: string;
  end: number;
}

const COLOR_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Whether the == at `at` is a {=='s, whose { no backslash escapes, so
 *  that \{==x==\} is a {, the highlighted x and a }, as import writes
 *  Word's literal braces around a highlight */
export function opensCriticHighlight(src: string, at: number): boolean {
  if (src.charCodeAt(at - 1) !== 0x7B /* { */) return false;
  let slashes = 0;
  while (src.charCodeAt(at - 2 - slashes) === 0x5C /* \ */) slashes++;
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
    if (src.charCodeAt(pos) === 0x3D /* = */ && src.charCodeAt(pos + 1) === 0x3D /* = */) {
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
      if (pos + 2 < max && src.charCodeAt(pos + 2) === 0x7D /* } */) {
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
 *  closing == stops at: each but one with a } right after it, though one
 *  that opens a critic highlight stops it */
function unbracedEquals(src: string): number[] {
  const at: number[] = [];
  for (let k = src.indexOf('=='); k !== -1; k = src.indexOf('==', k + 1)) {
    if (src.charCodeAt(k + 2) !== 0x7D /* } */ || opensCriticHighlight(src, k)) at.push(k);
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
  if (last >= from && last < next && src.charCodeAt(last) === 0x3D /* = */ && src.charCodeAt(last + 1) === 0x3D /* = */) next = last;
  return next;
}

/** The closing == of a format highlight whose text starts at `from`: the
 *  first == outside the critic highlights in it, each {== opening one that
 *  its ==} closes (see criticHighlightEnd), or -1 if none is before `max`.
 *  An == right before a } closes none, so \{==x==} is text, its { escaped:
 *  the search goes on to the next == (see nextUnbracedEquals), which
 *  `unbraced` gives, found once for the text, as reading on past each ==}
 *  read the rest of the text again for each == before it, as in ==}
 *  repeated. Import writes a } right after a highlight's closing == as \}. */
function closingHighlightMarker(src: string, from: number, max: number, ends: Map<number, number>, unbraced: () => number[]): number {
  let pos = from;
  while (pos < max - 1) {
    if (src.charCodeAt(pos) === 0x3D /* = */ && src.charCodeAt(pos + 1) === 0x3D /* = */) {
      if (!opensCriticHighlight(src, pos)) {
        if (pos + 2 >= max || src.charCodeAt(pos + 2) !== 0x7D /* } */) return pos;
        pos = nextUnbracedEquals(src, pos + 2, max, unbraced());
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

// What a format highlight's search finds in a state's text, found once for
// it: the ends of its critic highlights, for each posMax, and its ==s
const highlightSearches = new WeakMap<object, { src: string; endsByMax: Map<number, Map<number, number>>; unbraced?: number[] }>();

/** The format highlight at `start`, which ends by the state's posMax. The
 *  == of a {== is CriticMarkup's, which opens none, and in a highlight
 *  opens a critic highlight, read past to the ==} that closes it. */
export function formatHighlightAt(state: InlineState, start: number): FormatHighlightSpan | undefined {
  const { src, posMax: max } = state;
  if (start + 2 >= max || src.charCodeAt(start) !== 0x3D /* = */ || src.charCodeAt(start + 1) !== 0x3D /* = */) return undefined;
  if (opensCriticHighlight(src, start)) return undefined;
  let memo = highlightSearches.get(state);
  if (!memo || memo.src !== src) highlightSearches.set(state, memo = { src, endsByMax: new Map() });
  let ends = memo.endsByMax.get(max);
  if (!ends) memo.endsByMax.set(max, ends = new Map());
  const search = memo;
  const contentEnd = closingHighlightMarker(src, start + 2, max, ends, () => search.unbraced ??= unbracedEquals(src));
  if (contentEnd === -1) return undefined;
  let end = contentEnd + 2;
  let color: string | undefined;
  if (end < max && src.charCodeAt(end) === 0x7B /* { */) {
    const closeBrace = src.indexOf('}', end + 1);
    if (closeBrace !== -1 && closeBrace < max && COLOR_RE.test(src.slice(end + 1, closeBrace))) {
      color = src.slice(end + 1, closeBrace);
      end = closeBrace + 1;
    }
  }
  return { contentStart: start + 2, contentEnd, color, end };
}

/** Where the citation at `start` ends: the offset of its ], or -1 for
 *  none (see citationEnd), which ends by the state's posMax.
 *
 *  `inLinkLabel` is whether one is read where markdown-it scans a link's
 *  label, which it alone does silently. A token that takes a [ in the label
 *  ends it, so the link around the citation is lost, as in [see [@a]](u).
 *  The preview doesn't read one there, so the link stays and shows the
 *  citation as its text. Export does: Word keeps a citation's field, and its
 *  entry in the bibliography, but not in a link, whose hyperlink import
 *  would take it out of, so the link's brackets are text. The one place the
 *  two read differently (see syntax-parity.test.ts). */
export function citationSpanAt(state: StateInline, start: number, silent: boolean, inLinkLabel: boolean): number {
  if (silent && !inLinkLabel || start + 2 >= state.posMax) return -1;
  const end = citationEnd(state, start);
  return end !== -1 && end < state.posMax ? end : -1;
}

/** The cross-reference at `start` (see crossRefAt). As a citation, none
 *  with brackets where markdown-it scans a link's label. */
export function crossRefSpanAt(state: StateInline, start: number, silent: boolean): CrossRefSource | undefined {
  if (silent && state.src.charCodeAt(start) === 0x5B /* [ */) return undefined;
  return crossRefAt(state, start);
}
