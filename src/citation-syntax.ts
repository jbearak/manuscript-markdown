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
  return key.length > 0 && [...key].every(isCitationKeyChar);
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

/** Whether a bracket's first item is plain text up to a real key, as in
 *  [e.g., @key] or [for n = 10, see @key]. Formatting before or around the key
 *  (code, emphasis, CriticMarkup, math, HTML) leaves the brackets ordinary
 *  Markdown: a Zotero prefix is plain text, and an `@` inside a code span is not
 *  a key. Escaped characters count as text but never start a key. citation_list
 *  in the grammar approximates this with a regex; hasCitations() in md-to-docx.ts
 *  asks the parse. */
function isPlainPrefixedCitationItem(state: Pick<StateInline, 'md' | 'env'>, item: string): boolean {
  const key = CITATION_KEY_RE.exec(item);
  if (!key) return false;
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
    else if (!isLinkifyToken(token)) return false;
    if (CITATION_KEY_START_RE.test(text)) return true;
  }
  return false;
}

/** A citation prefix as the plain text Zotero stores: backslash escapes
 *  (converter.ts adds them on import) decoded, line breaks as spaces. This works
 *  on the source text rather than parsed tokens, because linkify rewrites URLs
 *  (it decodes %20, for one) and keeps escapes inside them. */
export function citationPrefixText(state: Pick<StateInline, 'md'>, prefix: string): string {
  return state.md.utils.unescapeAll(prefix).replace(/\s+/g, ' ');
}

/** The ] that ends the citation the [ at `start` opens, or -1 */
export function citationEnd(state: Pick<StateInline, 'src' | 'md' | 'env'>, start: number): number {
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
    if (!isPlainPrefixedCitationItem(state, rawContent.split(';')[0])) return -1;
  }
  return endPos;
}
