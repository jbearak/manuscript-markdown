// A citation as export reads one, which the preview reads the same way, so
// what it shows of one is what export makes of it
import type Token from 'markdown-it/lib/token.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

// Start of a citation item's key: `@` or `-@` at the start of the item or
// after whitespace. Text before it is the item's Pandoc prefix ("e.g.,").
export const CITATION_ITEM_START_RE = /(^|\s)(-?)@/;

/** A citation item, the text between two `;` of a citation or its
 *  brackets, as export reads it (see readCitationItem). Offsets are in the
 *  item's text. */
export interface CitationItem {
  /** The text before the `@` or `-@`, its spaces trimmed, as written */
  prefix: string;
  /** Whether a `-` before the `@` suppresses the author */
  suppressed: boolean;
  /** Where the `@` or `-@` is, or -1 for an item with none, which is all key */
  markStart: number;
  key: string;
  keyStart: number;
  /** The text after the key's comma, its spaces trimmed, or undefined
   *  where the key has none */
  locator: string | undefined;
}

/** A citation item as export reads it, which everything that reads a
 *  citation's keys reads it as: export, the LSP's diagnostics, lookups and
 *  completions, and import, where it checks that a citation it writes
 *  reads back. Its prefix is the text before an `@` or `-@` at its start or
 *  after a space; its key, the text after that, to the first comma, its
 *  spaces trimmed; and its locator, the rest. An item with no `@` is all
 *  key. Undefined where the item, or the text after its `@`, is all space. */
export function readCitationItem(item: string): CitationItem | undefined {
  const lead = item.length - item.trimStart().length;
  const text = item.trim();
  const start = CITATION_ITEM_START_RE.exec(text);
  const markStart = start ? lead + start.index + start[1].length : -1;
  const after = start ? lead + start.index + start[0].length : lead;
  const rest = item.slice(after, lead + text.length);
  const body = rest.trim();
  if (!body) return undefined;
  const comma = body.indexOf(',');
  return {
    prefix: start ? text.slice(0, start.index).trim() : '',
    suppressed: start?.[2] === '-',
    markStart,
    key: comma === -1 ? body : body.slice(0, comma).trim(),
    keyStart: after + rest.length - rest.trimStart().length,
    locator: comma === -1 ? undefined : body.slice(comma + 1).trim(),
  };
}

/** The items of a citation whose text between its brackets is `inner`, as
 *  export reads them, with where each item starts and ends in `inner` */
export function readCitationItems(inner: string): Array<CitationItem & { itemStart: number; itemEnd: number }> {
  const items: Array<CitationItem & { itemStart: number; itemEnd: number }> = [];
  let itemStart = 0;
  for (const part of inner.split(';')) {
    const item = readCitationItem(part);
    if (item) items.push({ ...item, itemStart, itemEnd: itemStart + part.length });
    itemStart += part.length + 1;
  }
  return items;
}

/** Whether a character can be in a key that a citation reads whole,
 *  wherever it is: any but a space or a comma, which end it (see
 *  readCitationItem), a `;` or a `]`, which end its item or its citation,
 *  an `@`, which starts it, and a backtick, which with another anywhere
 *  after it is code to the LSP, which reads no citation in code, where
 *  export, which reads the citation first, reads the key */
export function isCitationKeyChar(ch: string): boolean {
  return ch.length > 0 && !/[\s,;\]@`]/.test(ch);
}

/** Whether `[@key]` cites `key`, as export reads it, and the LSP: a key of
 *  characters isCitationKeyChar allows. A .bib key, which has no space,
 *  comma or `@` (see readEntryKey), can be cited unless it has a `;`, a
 *  `]` or a backtick. */
export function isCitableKey(key: string): boolean {
  return key.length > 0 && [...key].every(isCitationKeyChar) && !isCrossRefKey(key);
}

/** Whether `key`, a citation's or a bare `@`'s, is a cross-reference's, as
 *  Quarto reserves them: `fig-` or `tbl-` and more, or `Fig-` or `Tbl-` for
 *  one that shows its title capitalized. No citation cites one, which a
 *  .bib key of these can't be (see crossRefAt). */
export function isCrossRefKey(key: string): boolean {
  return key.length > 4 && /^(?:[Ff]ig|[Tt]bl)-/.test(key);
}

/** Whether `key`, a cross-reference's, is one a label can be, which a
 *  figure or a table can have: `fig-` or `tbl-`, or `Fig-` or `Tbl-`, and
 *  the characters of a comment's ID, `[A-Za-z0-9_-]`. One with another
 *  character, as Pandoc reads `@fig-a.b`, refers to none, and is text, as
 *  is a citation's brackets with it, so what Markdown reads in it, as a
 *  tag in `@fig-a<sup>2</sup>`, is read as it is in other text. */
export function isCrossRefLabelKey(key: string): boolean {
  return /^(?:[Ff]ig|[Tt]bl)-[A-Za-z0-9_-]+$/.test(key);
}

/** The label of the figure or table a cross-reference's key `key` refers
 *  to, as `fig-map` for `Fig-map` */
export function crossRefLabel(key: string): string {
  return key.charAt(0).toLowerCase() + key.slice(1);
}

/** A character a bare `@` comes after that keeps it text, as in an email
 *  address, a URL's path or an escape: a letter, a digit, or one of
 *  `_.-/@`, a backtick or a backslash. The grammar and the LSP read one
 *  alike. */
export const CROSS_REF_AFTER_RE = /[\p{L}\p{N}_.\-/@`\\]/u;

// The key after a bare @, as Pandoc reads one: letters, digits and _, with
// punctuation of :.#$%&-+?<>~/ inside it, each before another of those
const BARE_KEY_RE = /[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~/](?=[\p{L}\p{N}_]))*/uy;

/** The character before `at` in `src`, a whole one where a surrogate pair
 *  ends there */
function charBefore(src: string, at: number): string {
  if (at <= 0) return '';
  const low = src.charCodeAt(at - 1);
  return low >= 0xDC00 && low <= 0xDFFF && at >= 2 ? src.slice(at - 2, at) : src.charAt(at - 1);
}

/** A cross-reference in Markdown (see crossRefAt) */
export interface CrossRefSource {
  /** Past its end */
  end: number;
  /** Its key, as `fig-map` or `Fig-map`, or '' for a citation's brackets
   *  with one in them, which are text */
  key: string;
  form: 'bare' | 'bracket' | 'literal';
}

/**
 * The cross-reference at `start` in `state`'s text, as Quarto writes one,
 * as export and the preview read it: a bare `@` with a key after it, as
 * Pandoc reads one, that a figure's or a table's label can be (see
 * isCrossRefLabelKey), at
 * the start or after a character CROSS_REF_AFTER_RE doesn't match, so
 * that an email address stays text, or a citation's brackets with that
 * key alone in them, as `[@fig-map]`, which reads as `@fig-map`; none in a
 * link's text. Any other citation with one of these keys in it, as
 * `[-@fig-map]`, `[see @fig-map]` or `[@fig-a; @fig-b]`, which Word's
 * cross-references can't show, is its text, as written (`literal`).
 * Undefined for none.
 */
export function crossRefAt(state: Pick<StateInline, 'src' | 'md' | 'env'> & { posMax?: number; linkLevel?: number }, start: number): CrossRefSource | undefined {
  const { src } = state;
  const max = state.posMax ?? src.length;
  const ch = src.charAt(start);
  // A link's text is the link's, which goes to its own place
  if (state.linkLevel) return undefined;
  if (ch === '@') {
    if (CROSS_REF_AFTER_RE.test(charBefore(src, start))) return undefined;
    BARE_KEY_RE.lastIndex = start + 1;
    const key = BARE_KEY_RE.exec(src)?.[0];
    if (!key || !isCrossRefLabelKey(key) || start + 1 + key.length > max) return undefined;
    return { end: start + 1 + key.length, key, form: 'bare' };
  }
  if (ch !== '[') return undefined;
  if (src.charAt(start + 1) === '@') {
    // To the first character no key has, or a [, which a search from each
    // [ in a run of them would read past again
    let at = start + 2;
    while (at < max && src.charAt(at) !== '[' && isCitationKeyChar(src.charAt(at))) at++;
    const key = src.slice(start + 2, at);
    if (at < max && src.charAt(at) === ']' && isCrossRefLabelKey(key)) return { end: at + 1, key, form: 'bracket' };
  }
  const end = bracketEnd(state, start);
  return end !== -1 && end < max && holdsCrossRefKey(state, start, end) ? { end: end + 1, key: '', form: 'literal' } : undefined;
}

// A cross-reference's key where a citation reads a key: at the start of
// an item, after a space or after its [, with the @ or -@ before it
const CROSS_REF_MARK_RE = /(?<![^\s;[])-?@(?:[Ff]ig|[Tt]bl)-[^\s,;\]]/g;
// Where each is in a state's text, found once for it
const crossRefMarks = new WeakMap<object, { src: string; at: number[] }>();

/** Whether the citation the [ at `start` opens, to the ] at `end`, has a
 *  cross-reference's key in it, as a citation reads one (see
 *  CROSS_REF_MARK_RE), which makes it none */
function holdsCrossRefKey(state: Pick<StateInline, 'src'>, start: number, end: number): boolean {
  let marks = crossRefMarks.get(state);
  if (!marks || marks.src !== state.src) {
    marks = { src: state.src, at: [...state.src.matchAll(CROSS_REF_MARK_RE)].map(match => match.index) };
    crossRefMarks.set(state, marks);
  }
  // The first after the [
  const { at } = marks;
  let low = 0;
  let high = at.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (at[mid] <= start) low = mid + 1;
    else high = mid;
  }
  return low < at.length && at[low] < end;
}
// The ] the last search found, for each state searched. It's the first ]
// for any [ from where that search started up to it, so a run of [ with no
// ] after them, or one far after, is searched once, not again from each [
const closes = new WeakMap<object, { from: number; close: number }>();

/** The first ] after `start` in `state`'s text, or -1 */
function closeAfter(state: Pick<StateInline, 'src'>, start: number): number {
  const known = closes.get(state);
  if (known && known.from <= start && (known.close === -1 || start < known.close)) return known.close;
  const close = state.src.indexOf(']', start + 1);
  closes.set(state, { from: start, close });
  return close;
}

// A key start in plain text. Whitespace before `@` and a letter, digit, or `_`
// after it keep [write to me@example.com] plain text.
const CITATION_KEY_START_RE = /(^|\s)-?@[\p{L}\p{N}_]/u;
// The first key with its extent, per Pandoc: letters, digits, and `_`, plus
// punctuation from :.#$%&-+?<>~/ when another key character follows.
const CITATION_KEY_RE = /((?:^|\s)-?@)([\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~\/](?=[\p{L}\p{N}_]))*)/u;

/** Links linkify makes from bare URLs are plain text in the source. */
function isLinkifyToken(token: Token): boolean {
  return (token.type === 'link_open' || token.type === 'link_close') && token.markup === 'linkify';
}

/** Where the key of a bracket's first item starts in it, where the item is
 *  plain text up to a real key, as in [e.g., @key] or [for n = 10, see @key],
 *  or -1. Formatting before or around the key
 *  (code, emphasis, CriticMarkup, math, HTML) leaves the brackets ordinary
 *  Markdown: a Zotero prefix is plain text, and an `@` inside a code span is not
 *  a key. Escaped characters count as text but never start a key. citation_list
 *  in the grammar approximates this with a regex; hasCitations() in md-to-docx.ts
 *  asks the parse. */
function plainPrefixedKeyStart(state: Pick<StateInline, 'md' | 'env'>, item: string): number {
  const key = CITATION_KEY_RE.exec(item);
  if (!key) return -1;
  // Parse with the key replaced by a plain word. The key is opaque, so the
  // underscores in @_smith2020_ are not emphasis, but a code span or emphasis
  // wrapped around the key still shows up.
  const keyStart = key.index + key[1].length;
  const masked = item.slice(0, keyStart) + 'k' + item.slice(keyStart + key[2].length);
  const tokens: Token[] = [];
  state.md.inline.parse(masked, state.md, state.env, tokens);
  let text = '';
  for (const token of tokens) {
    if (token.type === 'text') text += token.content;
    else if (token.type === 'text_special') text += '�';
    else if (token.type === 'softbreak') text += '\n';
    else if (!isLinkifyToken(token)) return -1;
    if (CITATION_KEY_START_RE.test(text)) return keyStart;
  }
  return -1;
}

/** Whether the [ at `start` opens a link's text past the ] at `close`,
 *  as markdown-it reads it, as in [$a @key]$](url). An equation or code
 *  that starts in the first item's prefix, before its key at `keyStart`,
 *  and runs past the ] takes that ] for its own, though
 *  plainPrefixedKeyStart, whose parse ends at the ], reads the prefix as
 *  plain text. Where a link follows the next ] after it, the link rule
 *  reads one there, as Pandoc does (see linkAfter).
 *
 *  It reads only those two, with escapes and plain text, so that each
 *  citation's scan reads its own part of the text (see lookaheadStep). It
 *  leaves the citation as it is, as before, where the prefix has another
 *  token's start first, as a tag's or CriticMarkup's, and where the text
 *  after the equation or code holds anything but plain text and escapes
 *  before that ]. So does an equation or code that starts in a key or a
 *  locator, which are read as written, and one with no ( or [ after that
 *  ], as in [see $x @key] y$. */
function opensLinkPast(state: Pick<StateInline, 'src' | 'md' | 'env'>, start: number, keyStart: number, close: number): boolean {
  const ahead = lookaheadOf(state);
  let pos = start + 1;
  while (pos < keyStart) {
    pos = lookaheadStep(ahead, pos);
    if (pos === -1) return false;
  }
  if (pos <= close) return false;
  const { src, posMax } = ahead.state;
  while (pos < posMax) {
    const ch = src.charAt(pos);
    if (ch === ']') return linkAfter(ahead.state, start + 1, pos);
    // Where another token may start, whose search for its end the next
    // citation's scan would read again
    if (ch === '[' || ch === '$' || ch === '`') return false;
    pos = lookaheadStep(ahead, pos);
    if (pos === -1) return false;
  }
  return false;
}

/** A [, or what may start a token in a reference's label: code, a tag or
 *  an autolink, an equation, CriticMarkup, a highlight or a URL */
const LABEL_TOKEN_START_RE = /[[`<$={:]/;

/** Whether a link follows the ] at `close` that ends the text from
 *  `labelStart`, as markdown-it's link rule reads one: a destination in
 *  ( ), or a reference defined in the document, named in [ ] or by the
 *  text. Where it reads none, the brackets stay a citation, as before. A
 *  label longer than a label may be is read as no link, which no
 *  definition could name, and so is one holding a [ or what may start a
 *  token that the link rule's label would skip whole, ] and all (see
 *  LABEL_TOKEN_START_RE), as before. */
function linkAfter(state: StateInline, labelStart: number, close: number): boolean {
  const { src, posMax: max, md, env } = state;
  const skipSpaces = (at: number) => {
    while (at < max && (md.utils.isSpace(src.charCodeAt(at)) || src.charCodeAt(at) === 0x0A)) at++;
    return at;
  };
  let pos = close + 1;
  if (src.charAt(pos) === '(') {
    pos = skipSpaces(pos + 1);
    if (pos >= max) return false;
    const destination = md.helpers.parseLinkDestination(src, pos, max);
    if (destination.ok) {
      if (md.validateLink(md.normalizeLink(destination.str))) pos = destination.pos;
      const start = pos;
      pos = skipSpaces(pos);
      const title = md.helpers.parseLinkTitle(src, pos, max);
      if (pos < max && start !== pos && title.ok) pos = skipSpaces(title.pos);
    }
    if (pos < max && src.charAt(pos) === ')') return true;
    pos = close + 1;
  } else if (src.charAt(pos) !== '[') {
    return false;
  }
  const references = env?.references as Record<string, unknown> | undefined;
  if (!references) return false;
  let label = '';
  if (src.charAt(pos) === '[') {
    let end = pos + 1;
    while (end < max && end - pos <= 1000 && src.charAt(end) !== ']') {
      if (LABEL_TOKEN_START_RE.test(src.charAt(end))) return false;
      end += src.charAt(end) === '\\' ? 2 : 1;
    }
    if (end >= max || src.charAt(end) !== ']') return false;
    label = src.slice(pos + 1, end);
  }
  return Boolean(references[md.utils.normalizeReference(label || src.slice(labelStart, close))]);
}

// What opensLinkPast reads each state's text with: a state of its own,
// apart from the state markdown-it is reading, which no scan ahead may
// change, as its backtick rule's cache assumes it reads its text once, in
// order, and the backtick runs of the text, found once
interface Lookahead {
  state: StateInline;
  runs?: Map<number, number[]>;
}
const lookaheads = new WeakMap<object, Lookahead>();

/** opensLinkPast's reading of `state`'s text, to where it ends, at its
 *  nesting and link level */
function lookaheadOf(state: Pick<StateInline, 'src' | 'md' | 'env'>): Lookahead {
  const live = state instanceof state.md.inline.State ? state as StateInline & { linkLevel: number } : undefined;
  const posMax = live?.posMax ?? state.src.length;
  const level = live?.level ?? 0;
  const linkLevel = live?.linkLevel ?? 0;
  let ahead = lookaheads.get(state);
  if (!ahead || ahead.state.src !== state.src || ahead.state.md !== state.md) lookaheads.set(state, ahead = { state: new state.md.inline.State(state.src, state.md, state.env, []) });
  const scan = ahead.state as StateInline & { linkLevel: number };
  // Where each token ends depends on these
  if (scan.posMax !== posMax || scan.level !== level || scan.linkLevel !== linkLevel) {
    scan.posMax = posMax;
    scan.level = level;
    scan.linkLevel = linkLevel;
    scan.cache = {};
  }
  return ahead;
}

/** Where what starts at `pos` ends, as the parse reads it, in plain text,
 *  an escape, an equation or code, or -1 where another token may start
 *  there: a tag or an autolink, CriticMarkup, a highlight's == or a URL's
 *  :, which these scans don't read. An equation is the reader's own, its
 *  rule run once for each $, whose search ends at the next $. Code ends
 *  at the next run of as many backticks, from an index of the runs. */
function lookaheadStep(ahead: Lookahead, pos: number): number {
  const { src, posMax } = ahead.state;
  const ch = src.charAt(pos);
  if (ch === '\\') return pos + 2;
  if (ch === '$') {
    ahead.state.pos = pos;
    ahead.state.md.inline.skipToken(ahead.state);
    return ahead.state.pos;
  }
  if (ch === '`') {
    let end = pos;
    while (end < posMax && src.charCodeAt(end) === 0x60) end++;
    const length = end - pos;
    const close = nextRun(ahead, length, end);
    // A run with no other as long after it is text, as markdown-it reads it
    return close !== -1 && close + length <= posMax ? close + length : end;
  }
  if (ch === '{' || ch === ':' || ch === '<' && /[A-Za-z/!?]/.test(src.charAt(pos + 1)) || ch === '=' && src.charAt(pos + 1) === '=') return -1;
  return pos + 1;
}

/** Where the first run of exactly `length` backticks at or after `from`
 *  starts, or -1 */
function nextRun(ahead: Lookahead, length: number, from: number): number {
  if (!ahead.runs) {
    const runs = new Map<number, number[]>();
    const { src } = ahead.state;
    for (let at = src.indexOf('`'); at !== -1; at = src.indexOf('`', at)) {
      let end = at;
      while (src.charCodeAt(end) === 0x60) end++;
      let starts = runs.get(end - at);
      if (!starts) runs.set(end - at, starts = []);
      starts.push(at);
      at = end;
    }
    ahead.runs = runs;
  }
  const starts = ahead.runs.get(length);
  if (!starts) return -1;
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (starts[mid] < from) low = mid + 1;
    else high = mid;
  }
  return low < starts.length ? starts[low] : -1;
}

/** A citation prefix as the plain text Zotero stores: backslash escapes
 *  (converter.ts adds them on import) decoded, line breaks as spaces. This works
 *  on the source text rather than parsed tokens, because linkify rewrites URLs
 *  (it decodes %20, for one) and keeps escapes inside them. */
export function citationPrefixText(state: Pick<StateInline, 'md'>, prefix: string): string {
  return state.md.utils.unescapeAll(prefix).replace(/\s+/g, ' ');
}

/** The ] that ends the citation the [ at `start` opens, or -1: none where
 *  it has a cross-reference's key in it, which crossRefAt reads */
export function citationEnd(state: Pick<StateInline, 'src' | 'md' | 'env'>, start: number): number {
  const end = bracketEnd(state, start);
  return end !== -1 && holdsCrossRefKey(state, start, end) ? -1 : end;
}

/** The ] that ends the brackets the [ at `start` opens where they read as
 *  a citation, whatever its keys, or -1 */
function bracketEnd(state: Pick<StateInline, 'src' | 'md' | 'env'>, start: number): number {
  // Match [@key], [-@key] (Pandoc suppress-author form), or [prefix @key]
  if (state.src.charAt(start) !== '[') return -1;
  const endPos = closeAfter(state, start);
  if (endPos === -1) return -1;

  if (!/^-?@/.test(state.src.slice(start + 1, start + 3))) {
    // A nested `[` means any citation starts later; `](` or `][` makes this
    // link text that happens to mention someone (Pandoc parses these as links).
    // Before the text is taken, which for a run of [ before one ] would be
    // taken again for each.
    const open = state.src.indexOf('[', start + 1);
    if (open !== -1 && open < endPos) return -1;
    const rawContent = state.src.slice(start + 1, endPos);
    const after = state.src.charAt(endPos + 1);
    if (after === '(' || after === '[') return -1;
    // Likewise a shortcut reference link. markdown-it has already consumed its
    // `[label]: url` definition, so a citation here would drop the URL.
    const references = state.env?.references as Record<string, unknown> | undefined;
    if (references && references[state.md.utils.normalizeReference(rawContent)]) return -1;
    const keyStart = plainPrefixedKeyStart(state, rawContent.split(';')[0]);
    if (keyStart === -1) return -1;
    if (opensLinkPast(state, start, start + 1 + keyStart, endPos)) return -1;
  }
  return endPos;
}
