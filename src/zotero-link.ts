/** Pure link planner for "Sync Bibliography from Zotero".
 *
 *  Takes the text of a .bib file plus a catalog of Zotero items from one
 *  library, and returns a plan: what each entry would become, and the whole
 *  bibliography rewritten with `zotero-key` / `zotero-uri` added to the
 *  entries that matched.
 *
 *  Invariants this module exists to hold:
 *
 *  1. Stable identifiers match first.  When none resolves an item, a metadata
 *     fallback requires at least three of title, first-author family or
 *     organization, container title and year to agree by normalized first
 *     word, and it links only one qualifying item.  This tolerates one changed
 *     or unavailable field without silently
 *     choosing among plausible records.
 *  2. Ambiguity is never resolved.  Two Zotero items sharing an identifier
 *     means the entry is left alone and reported, and no lower tier is tried
 *     — a second identifier agreeing with neither candidate would be a guess
 *     dressed up as evidence.
 *  3. Nothing is overwritten.  Fields are only ever added.  An entry that
 *     already carries Zotero identity keeps the bytes it has, even when they
 *     are malformed; that is the user's data to fix.
 *  4. Edits are byte-surgical.  Untouched entries — and every byte of a
 *     touched entry other than the inserted lines — come through unchanged.
 *     Rerunning the command on its own output is a no-op.
 *
 *  No I/O, no `vscode`, no clock, no global state: the whole module is a
 *  function of its two arguments.
 */

import {
  parseBibtexWithRaw,
  findDuplicateBibtexKeys,
  spliceFieldsIntoEntry,
  scanBibtexEntryBody,
  detectBibtexFieldIndent,
  formatBibtexFieldLine,
  detectEntryEol,
  detectBibtexEol,
  unescapeBibtexPunctuation,
  stripWrappingBraces,
  type BibtexSourceRange,
  type BibtexEntryFieldOccurrence,
  type BibtexEol,
} from './bibtex-parser';

// ---------------------------------------------------------------------------
// Zotero identity
// ---------------------------------------------------------------------------

/** The shape of a Zotero item key: 8 uppercase alphanumerics.  Written once
 *  and composed into the regexes below, so the three cannot drift apart. */
const ITEM_KEY_PATTERN = '[A-Z0-9]{8}';

/** Matches the 8-character Zotero item key at the end of a URI. */
export const ZOTERO_KEY_RE = new RegExp('/items/(' + ITEM_KEY_PATTERN + ')$');

/** A Zotero item key on its own. */
export const ZOTERO_ITEM_KEY_RE = new RegExp('^' + ITEM_KEY_PATTERN + '$');

/** A full Zotero identity URI, as Word stores it in `ADDIN ZOTERO_ITEM` field
 *  codes.  Group URIs name a server-assigned group id and resolve for every
 *  member; personal URIs name one user's numeric id, or `local/<slug>` for a
 *  library that has never synced, and resolve only for that user.
 *
 *  Library ids are `[1-9]\d*`: `users/0` is the Local API's "whoever is logged
 *  in" placeholder, not an identity, and a URI carrying it names no library at
 *  all. */
const ZOTERO_URI_RE = new RegExp(
  '^https?://zotero\\.org/(?:users/(?:[1-9]\\d*|local/[A-Za-z0-9]+)|groups/[1-9]\\d*)/items/(' +
    ITEM_KEY_PATTERN +
    ')$',
);

/** The local-library slug this extension writes when a BibTeX entry has no
 *  Zotero identity at all, so that Word's citation field still carries a
 *  syntactically valid `uris` array (see `md-to-docx-citations.ts`).  It is a
 *  placeholder meaning "use the embedded metadata", so reading one back as
 *  identity would launder our own generated filler into a Zotero link. */
const EMBEDDED_LOCAL_SLUG = 'embedded';

const LOCAL_SLUG_RE = /^https?:\/\/zotero\.org\/users\/local\/([A-Za-z0-9]+)\//;

/** Extract the 8-character Zotero item key from a Zotero URI, or undefined if
 *  it doesn't match.  Deliberately lenient — it accepts any URI ending in
 *  `/items/<KEY>`, including the `zotero://select/...` form — because its
 *  callers are reading keys out of documents Zotero itself wrote.  Use
 *  `parseZoteroUri` before writing anything derived from a URI. */
export function extractZoteroKey(uri: string): string | undefined {
  const m = uri.match(ZOTERO_KEY_RE);
  return m ? m[1] : undefined;
}

/** The item key of a canonical Zotero identity URI, or undefined if the URI is
 *  not one.  Stricter than `extractZoteroKey`: this is the gate for treating a
 *  stored `zotero-uri` as authoritative. */
function parseZoteroUri(uri: string): string | undefined {
  const m = ZOTERO_URI_RE.exec(uri);
  if (!m) return undefined;
  const local = LOCAL_SLUG_RE.exec(uri);
  if (local && local[1] === EMBEDDED_LOCAL_SLUG) return undefined;
  return m[1];
}

/** Build the canonical identity URI for one item.  Everything this function
 *  emits must satisfy `ZOTERO_URI_RE` above — it lives beside the grammar so
 *  the two cannot drift.  The library id must be real (>= 1); the caller owns
 *  that guarantee. */
export function formatZoteroItemUri(
  libraryType: 'user' | 'group',
  libraryId: number,
  key: string,
): string {
  return (
    'http://zotero.org/' +
    (libraryType === 'user' ? 'users/' : 'groups/') +
    libraryId +
    '/items/' +
    key
  );
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** One Zotero item, reduced to what matching and reporting need.
 *
 *  The transport adapter builds these directly from each API row and drops
 *  the rest of the payload: a full-library scan is tens of thousands of items,
 *  so only the first creator and small match fields survive. */
export interface ZoteroCatalogItem {
  /** 8-character item key, unique within the library. */
  readonly key: string;
  /** Canonical identity URI, built by the adapter from the library's real
   *  numeric id — never `/users/0/`. */
  readonly uri: string;
  /** Also used by the metadata fallback; retained for summary display. */
  readonly title?: string;
  /** First author's family name, or a single-field corporate name. */
  readonly author?: string;
  /** Journal/publication title or book title, depending on item type. */
  readonly containerTitle?: string;
  /** Zotero date or parsed date; the matcher extracts its four-digit year. */
  readonly year?: string;
  readonly citationKey?: string;
  readonly doi?: string;
  /** Zotero stores one string, which may list several ISBNs. */
  readonly isbn?: string;
  readonly url?: string;
  /** Zotero's free-text `Extra` field, which by convention carries the
   *  identifiers item types have no dedicated field for. */
  readonly extra?: string;
}

/** Which rule produced a match.  Ordered by confidence: a tier only runs when
 *  every tier above it found nothing at all. */
export type ZoteroMatchTier =
  | 'existing'
  | 'citation-key'
  | 'doi'
  | 'isbn-pmid'
  | 'url'
  | 'metadata';

/** The specific value that agreed.  A single match can rest on more than one
 *  metadata field or exact identifier. */
export type ZoteroMatchEvidence =
  | 'zotero-key'
  | 'zotero-uri'
  | 'citation-key'
  | 'doi'
  | 'isbn'
  | 'pmid'
  | 'url'
  | 'title'
  | 'author'
  | 'container-title'
  | 'year'
  /** Used when ambiguous candidates qualified through different metadata
   *  field combinations. */
  | 'metadata';

/** The Zotero item an entry was, or would be, linked to. */
export interface ZoteroLinkTarget {
  readonly key: string;
  readonly uri: string;
  readonly title?: string;
}

export interface ZoteroFieldAddition {
  readonly name: 'zotero-key' | 'zotero-uri';
  readonly value: string;
}

export type ZoteroLinkConflictReason =
  /** The same citation key appears more than once, so an offset-based edit
   *  cannot say which occurrence was meant. */
  | 'duplicate-bibtex-key'
  /** `zotero-key` is present but is not an 8-character item key. */
  | 'invalid-zotero-key'
  /** `zotero-uri` is present but is not a Zotero identity URI. */
  | 'invalid-zotero-uri'
  /** Both fields are present and name different items. */
  | 'zotero-key-uri-mismatch'
  /** `zotero-key` is well-formed but no item in the selected library has it —
   *  most often the entry belongs to a different library. */
  | 'unknown-zotero-key'
  /** The scanner could not vouch for this entry's boundaries. */
  | 'entry-not-editable'
  /** A `%` sits outside every field value, so where the entry's live text ends
   *  depends on which BibTeX implementation reads it. */
  | 'ambiguous-comment'
  /** A field value is a `#` concatenation, which the field parser reads only
   *  the first atom of. */
  | 'concatenated-field'
  /** An identifier field appears more than once with different values. */
  | 'duplicate-field'
  /** An identifier field's value is a `@string` macro reference, so the token
   *  as written is a name, not the identifier it stands for. */
  | 'symbolic-field';

export type ZoteroLinkUnmatchedReason =
  /** No item matched a stable identifier or the metadata fallback. */
  'no-match';

export type ZoteroLinkDecision =
  | {
      readonly outcome: 'update';
      readonly entry: BibtexSourceRange;
      readonly tier: ZoteroMatchTier;
      readonly evidence: readonly ZoteroMatchEvidence[];
      readonly target: ZoteroLinkTarget;
      readonly additions: readonly ZoteroFieldAddition[];
    }
  | {
      /** Already linked, and consistently so.  Nothing is written, and the
       *  item is not looked up: an entry pointing into a library the user did
       *  not select is still correctly linked. */
      readonly outcome: 'preserve';
      readonly entry: BibtexSourceRange;
      readonly target: ZoteroLinkTarget;
    }
  | {
      readonly outcome: 'ambiguous';
      readonly entry: BibtexSourceRange;
      readonly tier: ZoteroMatchTier;
      readonly evidence: readonly ZoteroMatchEvidence[];
      readonly candidates: readonly ZoteroLinkTarget[];
    }
  | {
      readonly outcome: 'conflict';
      readonly entry: BibtexSourceRange;
      readonly reason: ZoteroLinkConflictReason;
      /** The offending value, for the details view.  Empty when the reason is
       *  about the entry as a whole rather than one field. */
      readonly detail: string;
    }
  | {
      readonly outcome: 'unmatched';
      readonly entry: BibtexSourceRange;
      readonly reason: ZoteroLinkUnmatchedReason;
    };

export interface ZoteroLinkSummary {
  readonly totalEntries: number;
  readonly updates: number;
  readonly preserved: number;
  readonly ambiguous: number;
  readonly conflicts: number;
  readonly unmatched: number;
  readonly updatesByTier: Readonly<Record<ZoteroMatchTier, number>>;
}

/** Why no plan could be made for this file at all. */
export type ZoteroLinkBlockReason = 'unparsable-bibliography';

export interface ZoteroLinkPlan {
  /** One decision per entry occurrence, in source order. */
  readonly decisions: readonly ZoteroLinkDecision[];
  readonly summary: ZoteroLinkSummary;
  /** The whole file with the planned additions spliced in.  Identical to the
   *  input when `changed` is false. */
  readonly updatedText: string;
  readonly changed: boolean;
  /** Set when the bibliography could not be scanned safely; `decisions` is
   *  then empty and nothing may be written. */
  readonly blocked?: ZoteroLinkBlockReason;
}

// ---------------------------------------------------------------------------
// Identifier normalization
// ---------------------------------------------------------------------------

/** DOI URL prefixes Zotero, CrossRef and publishers all emit. */
const DOI_URL_PREFIX_RE = /^https?:\/\/(?:dx\.)?doi\.org\//i;
const DOI_SCHEME_PREFIX_RE = /^doi:\s*/i;

/** A field value as the user typed it, reduced to comparable form: wrapping
 *  braces removed and BibTeX punctuation escapes undone (`10.1/a\_b`).
 *
 *  Values reach this from the lexical walk with their delimiters stripped but
 *  nothing else done to them, so any number of brace pairs may remain:
 *  `pmid = {{{12345678}}}` arrives as `{{12345678}}`, and a single strip would
 *  leave a brace on each side of an otherwise exact identifier.
 *
 *  The order is: strip wrappers, unescape exactly once, then strip any
 *  wrapper the unescaping newly exposed (`{\{12345678\}}`).  Unescaping never
 *  runs twice: it would read the output of the first pass as more input —
 *  `\\\_` is a literal backslash followed by an escaped underscore, and a
 *  second pass over the resulting `\_` would eat the backslash that belongs
 *  to the value. */
function plainFieldValue(value: string | undefined): string {
  if (value === undefined) return '';
  const plain = stripWrappingBraces(value.trim());
  return stripWrappingBraces(unescapeBibtexPunctuation(plain).trim());
}

/** A DOI reduced to its bare lowercase form, or undefined if the value is not
 *  DOI-shaped.
 *
 *  DOIs are case-insensitive by specification and are stored in both cases in
 *  practice — in a sample of one real library, 13 of 72 were uppercase — so
 *  comparing them literally would lose matches for no reason.  Nothing else is
 *  normalized away: trailing punctuation is not stripped, because `10.1/x.` is
 *  a legal DOI and guessing which final period is prose would trade exactness
 *  for recall. */
export function normalizeDoi(value: string | undefined): string | undefined {
  let doi = plainFieldValue(value);
  if (!doi) return undefined;
  doi = doi.replace(DOI_SCHEME_PREFIX_RE, '').replace(DOI_URL_PREFIX_RE, '');
  doi = doi.trim().toLowerCase();
  // Every DOI is `10.<registrant>/<suffix>`.  Requiring that shape keeps a
  // stray note or URL in the field from becoming a match key.
  if (!doi.startsWith('10.') || !doi.includes('/') || /\s/.test(doi)) return undefined;
  return doi;
}

/** True if `compact` has the length and alphabet of an ISBN, check digit
 *  unexamined. */
function isIsbnShaped(compact: string): boolean {
  return /^\d{9}[\dX]$/.test(compact) || /^\d{13}$/.test(compact);
}

/** True if `compact` is an ISBN-10 or ISBN-13 whose check digit agrees with the
 *  rest of it.
 *
 *  The check digit matters here beyond rejecting typos: a field listing several
 *  ISBNs separated by spaces can be divided into correctly-shaped runs in more
 *  than one way, and the check digit is what says which division is the real
 *  one. */
function isValidIsbn(compact: string): boolean {
  if (!isIsbnShaped(compact)) return false;
  if (compact.length === 10) {
    // ISBN-10: sum of digit × (10 … 1) is divisible by 11, with X as ten.
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const ch = compact[i];
      sum += (ch === 'X' ? 10 : ch.charCodeAt(0) - 48) * (10 - i);
    }
    return sum % 11 === 0;
  }
  // ISBN-13: alternating weights 1 and 3, sum divisible by 10.
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += (compact.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

/** Every well-formed ISBN in a field value.  Zotero keeps multiple ISBNs for
 *  one item in a single string, and BibTeX files list them the same way.
 *
 *  ISBN-10 and ISBN-13 forms of one book do not compare equal; converting
 *  between them is left undone deliberately, since both sides of a match
 *  normally come from the same Zotero item. */
export function normalizeIsbns(value: string | undefined): string[] {
  const raw = plainFieldValue(value);
  if (!raw) return [];
  const isbns: string[] = [];
  // A space between ISBN digits is ambiguous: it separates the registration
  // groups *within* one ISBN (`978 0 306 40615 7`) as often as it separates
  // two of them (`9780306406157 0306406152`), and one field can mix both
  // (`978 0 306 40615 7 0306406152`).
  //
  // Shape alone cannot settle it: `9780 306406 157 0306406 152` divides into
  // 10- and 13-digit runs in several ways, most of which straddle the real
  // boundary and produce numbers present in neither ISBN.  The check digit is
  // what distinguishes them — that is what it is for — so a *split* is taken
  // only when every piece of it validates, and only when it is the sole split
  // that does.  About 1 in 800 realistically formatted ISBN pairs admits two
  // fully-validating splits; picking either silently risks a wrong
  // `zotero-key`, which makes Word cite the wrong source, so such a run is
  // refused whole — the same answer every other ambiguity here gets.
  //
  // A value needing no split is accepted on shape alone.  Both sides of a
  // match come from the same catalogue of human-entered data, and a mistyped
  // ISBN recorded the same way in Zotero and in the .bib still identifies the
  // same work; refusing to match it would lose a real link to enforce a
  // checksum neither side claimed to satisfy.
  const compactOf = (tokens: readonly string[]) =>
    tokens.join('').replace(/-/g, '').toUpperCase();

  for (const part of raw.split(/[,;\n]+/)) {
    const tokens = part.split(/\s+/).filter(t => t.length > 0);

    // Nothing to disambiguate: the part is one ISBN-shaped value, so take it
    // as written whether or not its check digit agrees.
    const asWritten = compactOf(tokens);
    if (isIsbnShaped(asWritten)) {
      isbns.push(asWritten);
      continue;
    }

    // Each remaining token compacted once, and tokens that compact to nothing
    // (a lone `-` used as a separator) dropped.  Left in, they let two token
    // splits normalize to the same ISBNs — the boundary can sit on either
    // side of the empty token — and the ambiguity counts below would refuse a
    // run whose every reading agrees.  With them gone, token boundaries and
    // compacted-text boundaries coincide, so what gets counted is genuinely
    // distinct readings.  Both `segment` and `salvage` read these.
    const compacts = tokens.map(t => compactOf([t])).filter(c => c.length > 0);

    const whole = segment(compacts);
    if (whole.count >= 2) continue; // ambiguous: refuse the run whole
    if (whole.count === 1) {
      for (let node = whole.split; node !== null; node = node.next) isbns.push(node.value);
      continue;
    }
    // No split covers the whole run: it holds a label, a stray word, or an
    // ISBN whose check digit does not agree.  Fall back to selecting within
    // the run: check-valid joined runs, plus each leftover token that is
    // ISBN-shaped on its own.
    //
    // A single token that is ISBN-shaped is taken even when its check digit
    // disagrees, for the same reason a lone value is: one mistyped ISBN in a
    // field must not cost the others their match, nor cost itself one against
    // the same typo in Zotero.  A *joined* run still needs its check digit,
    // since joining is where a boundary gets invented.
    //
    // The selection is over the whole run at once, not greedy: a left-to-right
    // first-match scan commits to a boundary before seeing what it costs, and
    // it has fabricated an ISBN by joining the tail of one value to the head
    // of the next.  If the tokens admit more than one best reading, the run
    // is refused — the same answer an ambiguous whole-run split gets, for the
    // same reason.
    const best = salvage(compacts);
    if (best) isbns.push(...best);
  }
  return isbns;
}

/** One full split of a run into valid ISBNs, as a shared-tail list: suffixes
 *  are common to every split that reaches them, so sharing keeps the table
 *  linear where copied arrays were quadratic. */
interface SegmentSplit {
  value: string;
  next: SegmentSplit | null;
}

/** How many ways a run of compacted tokens splits *entirely* into check-valid
 *  ISBNs — capped at 2, since past that only "more than one" matters — and
 *  one such split when any exists.
 *
 *  Filled right to left, one cell per suffix: recursing instead re-explores
 *  the same suffix for every way of reaching it, which is exponential — a run
 *  of a few hundred single-digit tokens once hung the command. */
function segment(compacts: readonly string[]): { count: number; split: SegmentSplit | null } {
  const table = new Array<{ count: number; split: SegmentSplit | null }>(compacts.length + 1);
  table[compacts.length] = { count: 1, split: null };
  for (let from = compacts.length - 1; from >= 0; from--) {
    const cell: { count: number; split: SegmentSplit | null } = { count: 0, split: null };
    let compact = '';
    for (let take = 1; from + take <= compacts.length; take++) {
      compact += compacts[from + take - 1];
      // A valid ISBN is at most 13 characters, and `compact` only grows with
      // `take` — every token contributes at least one character — so once it
      // is longer nothing further can validate.  The whole length is what
      // must be measured: counting only the digits would let a run of
      // non-numeric tokens extend the scan forever.
      if (compact.length > 13) break;
      if (!isValidIsbn(compact)) continue;
      const rest = table[from + take];
      cell.count = Math.min(2, cell.count + rest.count);
      if (cell.split === null && rest.count > 0) {
        cell.split = { value: compact, next: rest.split };
      }
      if (cell.count >= 2) break;
    }
    table[from] = cell;
  }
  return table[0];
}

/** The unique best reading of a token run that resisted whole-run splitting,
 *  or undefined when the tokens admit more than one.
 *
 *  Check-valid runs anchor the reading: a selection of disjoint token runs,
 *  each of whose joined text is a check-valid ISBN, maximizing how many such
 *  runs are recovered.  Leftover tokens then contribute only passively — each
 *  leftover that is ISBN-shaped on its own is kept as a mistyped standalone
 *  value.  Shaped-but-invalid tokens deliberately carry no weight in choosing
 *  between readings: scoring them once let a check-invalid prefix of a real
 *  ISBN, plus a value fabricated from that ISBN's tail, outrank the ISBN
 *  itself.
 *
 *  What is compared for ambiguity is each selection's *emission* — its runs
 *  and shaped leftovers in text order — not the selection itself.  Distinct
 *  selections can read identically: in `1 1 1 1 1 1 1 1 1 1 1 1` the valid
 *  ten-digit window starts at three different offsets, but every choice
 *  emits the same lone ISBN, because the leftover `1`s emit nothing.  That
 *  is one reading, not an ambiguity.  Counting selections here once refused
 *  it.
 *
 *  Emissions are compared as hash-consed lists — one node per distinct
 *  (value, tail) pair — so equality is reference equality, a suffix's
 *  emissions dedupe as they are built, and memory stays linear where
 *  materialized arrays once copied every suffix and exhausted the heap. */
function salvage(compacts: readonly string[]): string[] | undefined {
  interface Node {
    id: number;
    value: string;
    next: Node | null;
  }
  const interned = new Map<string, Node>();
  const cons = (value: string, next: Node | null): Node => {
    const key = value + '\0' + (next?.id ?? 0); // null is id 0
    let node = interned.get(key);
    if (node === undefined) {
      node = { id: interned.size + 1, value, next };
      interned.set(key, node);
    }
    return node;
  };

  interface Best {
    valid: number; // check-valid runs in the best selections of this suffix
    emits: (Node | null)[]; // up to two distinct emissions achieving it
  }
  /** Merge an emission into `best.emits`, relying on interning for equality. */
  const admit = (best: Best, emit: Node | null) => {
    if (best.emits.length < 2 && !best.emits.includes(emit)) best.emits.push(emit);
  };

  // Filled right to left: every position depends only on positions after it.
  // (Recursing instead — even just the skip-one-token chain — is a stack
  // frame per token, and a long field value overflows the stack.)
  const table = new Array<Best>(compacts.length + 1);
  table[compacts.length] = { valid: 0, emits: [null] };
  for (let from = compacts.length - 1; from >= 0; from--) {
    // Either no run starts at this token — it is a leftover, emitting itself
    // when ISBN-shaped and nothing otherwise — or a run of some length does.
    const single = compacts[from];
    const skipped = table[from + 1];
    const best: Best = { valid: skipped.valid, emits: [] };
    for (const emit of skipped.emits) {
      admit(best, isIsbnShaped(single) ? cons(single, emit) : emit);
    }
    let compact = '';
    for (let take = 1; from + take <= compacts.length; take++) {
      compact += compacts[from + take - 1];
      // A valid ISBN is at most 13 characters and `compact` only grows, so
      // nothing longer can ever be admissible.
      if (compact.length > 13) break;
      if (!isValidIsbn(compact)) continue;
      const rest = table[from + take];
      const valid = rest.valid + 1;
      if (valid < best.valid) continue;
      if (valid > best.valid) {
        best.valid = valid;
        best.emits = [];
      }
      for (const emit of rest.emits) admit(best, cons(compact, emit));
    }
    table[from] = best;
  }

  const top = table[0];
  if (top.emits.length !== 1) return undefined;
  const out: string[] = [];
  for (let node = top.emits[0]; node !== null; node = node.next) out.push(node.value);
  return out;
}

/** A PubMed id reduced to bare digits, or undefined. */
export function normalizePmid(value: string | undefined): string | undefined {
  const raw = plainFieldValue(value).replace(/^pmid:\s*/i, '').trim();
  return /^\d{1,9}$/.test(raw) ? raw : undefined;
}

/** A web URL in the canonical form produced by the platform URL parser. */
export function normalizeUrl(value: string | undefined): string | undefined {
  const raw = plainFieldValue(value).trim();
  if (!raw || /\s/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** One comparison token per descriptive field.  The fallback deliberately
 *  compares first words rather than whole values so later metadata edits do
 *  not prevent a match. */
interface ZoteroMetadataSignature {
  readonly title?: string;
  readonly author?: string;
  readonly containerTitle?: string;
  readonly year?: string;
}

/** TeX commands whose names produce text rather than format an argument. */
const TEX_TEXT_COMMANDS: Readonly<Record<string, string>> = {
  LaTeX: 'LaTeX',
  TeX: 'TeX',
  BibTeX: 'BibTeX',
  textasciitilde: '~',
  textasciicircum: '^',
  textbackslash: '\\',
  AA: 'A',
  aa: 'a',
  AE: 'AE',
  ae: 'ae',
  DH: 'D',
  dh: 'd',
  L: 'L',
  l: 'l',
  NG: 'N',
  ng: 'n',
  O: 'O',
  o: 'o',
  OE: 'OE',
  oe: 'oe',
  ss: 'ss',
  TH: 'TH',
  th: 'th',
  i: 'i',
  j: 'j',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ϵ',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'ϕ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

/** Commands that change presentation while leaving their argument visible. */
const TEX_TRANSPARENT_COMMANDS: ReadonlySet<string> = new Set([
  'textit', 'textbf', 'textrm', 'textsf', 'texttt', 'textsc', 'textsl',
  'textup', 'textmd', 'textnormal', 'textsuperscript', 'textsubscript',
  'emph', 'underline', 'mbox', 'ensuremath', 'mathit', 'mathbf', 'mathrm',
  'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathfrak', 'operatorname',
  'em', 'it', 'bf', 'rm', 'sf', 'tt', 'sc', 'sl', 'up', 'md', 'normalfont',
  'u', 'v', 'H', 't', 'c', 'd', 'b', 'r', 'k',
]);

/** Sentinel meaning that discarding a command could change the first word. */
const UNKNOWN_TEX_COMMAND = '\u0000';

/** Decode control words without reinterpreting an escaped backslash as their
 *  introducer.  `\\alpha` is a line-break/literal-slash command followed by
 *  visible `alpha`, while `\alpha` is the Greek letter. */
function decodeTexCommands(value: string): string {
  let decoded = '';
  for (let i = 0; i < value.length;) {
    if (value[i] !== '\\') {
      decoded += value[i];
      i++;
      continue;
    }

    const next = value[i + 1];
    if (next === undefined) break;
    if (next === '\\') {
      i += 2;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      decoded += next;
      i += 2;
      continue;
    }

    let end = i + 2;
    while (end < value.length && /[A-Za-z]/.test(value[end])) end++;
    const command = value.slice(i + 1, end);
    if (value[end] === '*') end++;
    if (Object.prototype.hasOwnProperty.call(TEX_TEXT_COMMANDS, command)) {
      decoded += TEX_TEXT_COMMANDS[command];
    } else {
      decoded += TEX_TRANSPARENT_COMMANDS.has(command) ? '' : UNKNOWN_TEX_COMMAND;
    }
    i = end;
  }
  return decoded;
}

/** Comparable metadata text with punctuation escapes undone but escaped
 *  backslashes still distinguishable by `decodeTexCommands`. */
function plainMetadataValue(value: string | undefined): string {
  if (value === undefined) return '';
  const plain = stripWrappingBraces(value.trim());
  const unescaped = plain.replace(/\\([&%$#_{}])/g, '$1');
  return stripWrappingBraces(unescaped.trim());
}

const NONDECOMPOSING_LETTER_FOLDS: Readonly<Record<string, string>> = {
  æ: 'ae',
  ð: 'd',
  ł: 'l',
  ŋ: 'n',
  ø: 'o',
  œ: 'oe',
  ß: 'ss',
  þ: 'th',
  ı: 'i',
  ȷ: 'j',
};

/** First whitespace-delimited word after removing Zotero rich-text tags,
 *  BibTeX/TeX syntax, case, accents and punctuation.  Punctuation is removed
 *  within the word, so a corporate author such as `U.S.` compares as `us` on
 *  both sides. */
function firstMetadataWord(value: string | undefined): string | undefined {
  const text = decodeTexCommands(plainMetadataValue(value).replace(/<[^>]*>/g, ''))
    .replace(/[\\{}]/g, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[æðłŋøœßþıȷ]/g, letter => NONDECOMPOSING_LETTER_FOLDS[letter]);
  for (const part of text.trim().split(/\s+/)) {
    // Advancing past an unknown leading command could manufacture a match on
    // a later word.  Withhold this field instead.
    if (part.includes(UNKNOWN_TEX_COMMAND)) return undefined;
    const word = part.replace(/[^\p{L}\p{N}]/gu, '');
    if (word) return word;
  }
  return undefined;
}

/** A four-digit year from Zotero's free-form date or parsed date. */
function metadataYear(value: string | undefined): string | undefined {
  return plainFieldValue(value).match(/\b([12]\d{3})\b/)?.[1];
}

function metadataSignature(values: {
  readonly title?: string;
  readonly author?: string;
  readonly containerTitle?: string;
  readonly year?: string;
}): ZoteroMetadataSignature {
  return {
    title: firstMetadataWord(values.title),
    author: firstMetadataWord(values.author),
    containerTitle: firstMetadataWord(values.containerTitle),
    year: metadataYear(values.year),
  };
}

function beginsWithLowercaseBibtexLetter(word: string): boolean {
  const visible = decodeTexCommands(word).replace(/[\\{}]/g, '');
  if (visible.includes(UNKNOWN_TEX_COMMAND)) return false;
  const firstLetter = visible.match(/\p{L}/u)?.[0];
  return firstLetter !== undefined && /\p{Ll}/u.test(firstLetter);
}

function topLevelComma(value: string): number {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '{') depth++;
    else if (value[i] === '}') depth = Math.max(0, depth - 1);
    else if (value[i] === ',' && depth === 0) return i;
  }
  return -1;
}

/** The first BibTeX author's family name, or the full literal organization.
 *  Top-level `and` is whitespace-delimited and case-insensitive in BibTeX.
 *  In `Given von Family` form the first lowercase name part begins the family
 *  name, while `Family, Given` states it directly. */
function firstBibtexAuthor(value: string): string | undefined {
  let depth = 0;
  let end = value.length;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '{') depth++;
    else if (value[i] === '}') depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      value.slice(i, i + 3).toLowerCase() === 'and' &&
      (i === 0 || /\s/.test(value[i - 1])) &&
      (i + 3 === value.length || /\s/.test(value[i + 3]))
    ) {
      end = i;
      break;
    }
  }

  const first = value.slice(0, end).trim();
  if (!first) return undefined;
  // A literal organization's first word remains usable when an unknown command
  // occurs later, and comma form states the family name before any given-name
  // commands.  Require one brace pair to enclose the whole literal, and ignore
  // commas nested inside command arguments; otherwise either shortcut could
  // bypass the unknown-command guard used for uncommaed name parsing.
  const literal = stripWrappingBraces(first);
  if (literal !== first) return literal;
  const comma = topLevelComma(first);
  if (comma !== -1) return first.slice(0, comma).trim() || undefined;
  if (decodeTexCommands(first).includes(UNKNOWN_TEX_COMMAND)) return undefined;
  const words = first.split(/\s+/).filter(Boolean);
  const particle = words.slice(0, -1).findIndex(beginsWithLowercaseBibtexLetter);
  return (particle === -1 ? words.slice(-1) : words.slice(particle)).join(' ');
}

/** One unambiguous literal field occurrence.  Bare nonnumeric values name
 *  `@string` macros, and repeated descriptive fields have no single value, so
 *  neither may contribute evidence to a metadata-only link. */
function metadataFieldToken(
  fields: readonly BibtexEntryFieldOccurrence[],
  names: readonly string[],
  normalize: (value: string) => string | undefined,
): string | undefined {
  const occurrences = fields.filter(field => names.includes(field.name));
  if (occurrences.length !== 1) return undefined;
  const field = occurrences[0];
  if (field.delimiter === 'bare' && !/^\d+$/.test(field.value)) {
    return undefined;
  }
  return normalize(field.value);
}

function bibtexMetadataSignature(
  fields: readonly BibtexEntryFieldOccurrence[],
): ZoteroMetadataSignature {
  return {
    title: metadataFieldToken(fields, ['title'], firstMetadataWord),
    author: metadataFieldToken(
      fields,
      ['author'],
      value => firstMetadataWord(firstBibtexAuthor(value)),
    ),
    containerTitle: metadataFieldToken(
      fields,
      ['journal', 'booktitle'],
      firstMetadataWord,
    ),
    year: metadataFieldToken(fields, ['year'], metadataYear),
  };
}

/** The identifiers Zotero's free-text `Extra` field can carry. */
interface ZoteroExtraFields {
  readonly citationKey?: string;
  readonly doi?: string;
  readonly pmid?: string;
}

/** `Extra` is the documented home for identifiers an item type has no field
 *  for.  Each is a whole line of the form `Name: value`, so the whole field is
 *  read line by line: a number mentioned mid-sentence in a note is prose, and
 *  reading it as a PMID would invent an identifier the user never entered. */
function parseZoteroExtra(extra: string | undefined): ZoteroExtraFields {
  if (!extra || !extra.includes(':')) return {};
  const fields: { citationKey?: string; doi?: string; pmid?: string } = {};
  for (const line of extra.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value) continue;
    // First occurrence wins, matching how Zotero reads its own Extra lines.
    if (name === 'citation key') fields.citationKey ??= value;
    else if (name === 'doi') fields.doi ??= value;
    else if (name === 'pmid') fields.pmid ??= value;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Catalog index
// ---------------------------------------------------------------------------

/** Every lookup a tier needs, built once per command.
 *
 *  Each map keeps *all* items that share a value rather than the first, so
 *  ambiguity is detectable.  Silently taking the first would turn the one case
 *  that most needs the user's judgement into the one case they never hear
 *  about. */
interface ZoteroCatalogIndex {
  readonly byItemKey: Map<string, ZoteroCatalogItem[]>;
  readonly byCitationKey: Map<string, ZoteroCatalogItem[]>;
  readonly byDoi: Map<string, ZoteroCatalogItem[]>;
  readonly byIsbn: Map<string, ZoteroCatalogItem[]>;
  readonly byPmid: Map<string, ZoteroCatalogItem[]>;
  readonly byUrl: Map<string, ZoteroCatalogItem[]>;
  readonly metadata: Array<{
    readonly item: ZoteroCatalogItem;
    readonly signature: ZoteroMetadataSignature;
  }>;
}

function addToIndex(
  map: Map<string, ZoteroCatalogItem[]>,
  key: string | undefined,
  item: ZoteroCatalogItem,
): void {
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) bucket.push(item);
  else map.set(key, [item]);
}

function buildZoteroCatalogIndex(items: readonly ZoteroCatalogItem[]): ZoteroCatalogIndex {
  const index: ZoteroCatalogIndex = {
    byItemKey: new Map(),
    byCitationKey: new Map(),
    byDoi: new Map(),
    byIsbn: new Map(),
    byPmid: new Map(),
    byUrl: new Map(),
    metadata: [],
  };
  for (const item of items) {
    const extra = parseZoteroExtra(item.extra);
    addToIndex(index.byItemKey, item.key, item);
    addToIndex(index.byCitationKey, item.citationKey ?? extra.citationKey, item);
    addToIndex(index.byDoi, normalizeDoi(item.doi) ?? normalizeDoi(extra.doi), item);
    for (const isbn of normalizeIsbns(item.isbn)) addToIndex(index.byIsbn, isbn, item);
    addToIndex(index.byPmid, normalizePmid(extra.pmid), item);
    addToIndex(index.byUrl, normalizeUrl(item.url), item);
    index.metadata.push({ item, signature: metadataSignature(item) });
  }
  return index;
}

function toTarget(item: ZoteroCatalogItem): ZoteroLinkTarget {
  return { key: item.key, uri: item.uri, title: item.title };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function conflict(
  entry: BibtexSourceRange,
  reason: ZoteroLinkConflictReason,
  detail = '',
): ZoteroLinkDecision {
  return { outcome: 'conflict', entry, reason, detail };
}

/** Turn a tier's candidate list into a decision: one candidate links, several
 *  are reported, none falls through to the next tier. */
function resolveCandidates(
  entry: BibtexSourceRange,
  tier: ZoteroMatchTier,
  evidence: readonly ZoteroMatchEvidence[],
  candidates: readonly ZoteroCatalogItem[],
  additions: (item: ZoteroCatalogItem) => readonly ZoteroFieldAddition[],
): ZoteroLinkDecision | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length > 1) {
    return { outcome: 'ambiguous', entry, tier, evidence, candidates: candidates.map(toTarget) };
  }
  const item = candidates[0];
  return {
    outcome: 'update',
    entry,
    tier,
    evidence,
    target: toTarget(item),
    additions: additions(item),
  };
}

function bothFields(item: ZoteroCatalogItem): readonly ZoteroFieldAddition[] {
  return [
    { name: 'zotero-key', value: item.key },
    { name: 'zotero-uri', value: item.uri },
  ];
}

/** Tier 1 — identity the entry already carries.
 *
 *  Returns undefined only when the entry carries neither field, which is the
 *  one case where a lower tier may run.  Anything already written down is
 *  either completed, preserved, or reported: an exact DOI match must never
 *  quietly overrule a Zotero link the user put there. */
function decideExistingIdentity(
  range: BibtexSourceRange,
  fields: ReadonlyMap<string, string>,
  index: ZoteroCatalogIndex,
): ZoteroLinkDecision | undefined {
  // Presence, not truthiness: `zotero-uri = {}` is a broken link to report,
  // not an absent one to fill in.
  const hasUri = fields.has('zotero-uri');
  const hasKey = fields.has('zotero-key');
  if (!hasUri && !hasKey) return undefined;

  const storedUri = (fields.get('zotero-uri') ?? '').trim();
  const storedKey = (fields.get('zotero-key') ?? '').trim();

  if (hasUri) {
    const uriKey = parseZoteroUri(storedUri);
    if (!uriKey) return conflict(range, 'invalid-zotero-uri', storedUri);
    if (!hasKey) {
      return {
        outcome: 'update',
        entry: range,
        tier: 'existing',
        evidence: ['zotero-uri'],
        // The URI is authoritative and stays byte-for-byte as written; only
        // the key it already contains is added.
        target: { key: uriKey, uri: storedUri },
        additions: [{ name: 'zotero-key', value: uriKey }],
      };
    }
    if (!ZOTERO_ITEM_KEY_RE.test(storedKey)) return conflict(range, 'invalid-zotero-key', storedKey);
    if (storedKey !== uriKey) {
      return conflict(range, 'zotero-key-uri-mismatch', storedKey + ' vs ' + uriKey);
    }
    return { outcome: 'preserve', entry: range, target: { key: storedKey, uri: storedUri } };
  }

  if (!ZOTERO_ITEM_KEY_RE.test(storedKey)) return conflict(range, 'invalid-zotero-key', storedKey);
  const candidates = index.byItemKey.get(storedKey) ?? [];
  return (
    resolveCandidates(range, 'existing', ['zotero-key'], candidates, item => [
      { name: 'zotero-uri', value: item.uri },
    ]) ?? conflict(range, 'unknown-zotero-key', storedKey)
  );
}

/** Tier 4 — ISBN and PMID together.
 *
 *  One tier rather than two: they are equally exact, and an item that answers
 *  to both is one match with two pieces of evidence, not a match that shadows
 *  a second. */
function findIdentifierCandidates(
  isbns: readonly string[],
  pmid: string | undefined,
  index: ZoteroCatalogIndex,
): { candidates: ZoteroCatalogItem[]; evidence: ZoteroMatchEvidence[] } {
  const found = new Map<string, ZoteroCatalogItem>();
  const evidence = new Set<ZoteroMatchEvidence>();

  const collect = (items: readonly ZoteroCatalogItem[], label: ZoteroMatchEvidence) => {
    for (const item of items) {
      found.set(item.key, item);
      evidence.add(label);
    }
  };

  for (const isbn of isbns) collect(index.byIsbn.get(isbn) ?? [], 'isbn');
  if (pmid) collect(index.byPmid.get(pmid) ?? [], 'pmid');

  return { candidates: [...found.values()], evidence: [...evidence] };
}

const METADATA_COMPARISONS = [
  ['title', 'title'],
  ['author', 'author'],
  ['containerTitle', 'container-title'],
  ['year', 'year'],
] as const satisfies ReadonlyArray<
  readonly [keyof ZoteroMetadataSignature, ZoteroMatchEvidence]
>;

/** Match when at least three of the four descriptive signals agree.  Missing
 *  values and disagreements both consume the one allowed non-match. */
function decideMetadataFallback(
  entry: BibtexSourceRange,
  fields: readonly BibtexEntryFieldOccurrence[],
  index: ZoteroCatalogIndex,
): ZoteroLinkDecision | undefined {
  const signature = bibtexMetadataSignature(fields);
  const matches: Array<{
    item: ZoteroCatalogItem;
    evidence: ZoteroMatchEvidence[];
  }> = [];

  for (const candidate of index.metadata) {
    const evidence: ZoteroMatchEvidence[] = [];
    for (const [field, label] of METADATA_COMPARISONS) {
      const value = signature[field];
      if (value !== undefined && value === candidate.signature[field]) evidence.push(label);
    }
    if (evidence.length >= 3) matches.push({ item: candidate.item, evidence });
  }

  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    return {
      outcome: 'ambiguous',
      entry,
      tier: 'metadata',
      evidence: ['metadata'],
      candidates: matches.map(match => toTarget(match.item)),
    };
  }
  const match = matches[0];
  return {
    outcome: 'update',
    entry,
    tier: 'metadata',
    evidence: match.evidence,
    target: toTarget(match.item),
    additions: bothFields(match.item),
  };
}

/** Identifier fields whose value decides a match, so a repeat with a different
 *  value is a contradiction rather than clutter. */
const IDENTIFIER_FIELDS = ['doi', 'isbn', 'pmid', 'url', 'zotero-key', 'zotero-uri'] as const;

/** The first identifier field written twice with values that disagree.
 *
 *  `parseBibtex` keeps the last occurrence, so without this check the entry
 *  would link on whichever value happened to come last — a coin flip the user
 *  never sees.  A repeat with the *same* value is harmless and stays quiet.
 *
 *  The occurrences come from the body walk rather than a second search of the
 *  raw text: only the walk knows which `doi =` was at the entry's own level
 *  and which was prose inside a multi-line note. */
function findContradictingField(
  fields: readonly BibtexEntryFieldOccurrence[],
): string | undefined {
  for (const name of IDENTIFIER_FIELDS) {
    const values = new Set<string>();
    for (const field of fields) {
      if (field.name === name) {
        const value = name === 'url'
          ? normalizeUrl(field.value) ?? plainFieldValue(field.value)
          : plainFieldValue(field.value);
        values.add(value);
      }
    }
    if (values.size > 1) return name;
  }
  return undefined;
}

/** An identifier field whose value is a `@string` macro reference rather than
 *  a literal.  Its spelling is not its value — `zotero-key = ABCD1234` names a
 *  macro defined elsewhere in the file — so matching on the token as written
 *  would link the entry to whatever item happens to share that name.  A bare
 *  number (`pmid = 12345678`) is a literal and passes. */
function findSymbolicIdentifier(
  fields: readonly BibtexEntryFieldOccurrence[],
): string | undefined {
  for (const field of fields) {
    if (field.delimiter !== 'bare') continue;
    if (/^\d+$/.test(field.value)) continue;
    if ((IDENTIFIER_FIELDS as readonly string[]).includes(field.name)) return field.name;
  }
  return undefined;
}

function decideEntry(
  range: BibtexSourceRange,
  rawEntry: string | undefined,
  index: ZoteroCatalogIndex,
  duplicateKeys: ReadonlySet<string>,
): ZoteroLinkDecision {
  // Sync loss is currently monotonic, so a document that reaches here at all
  // has no untrusted ranges.  The check stays because the cost is a boolean
  // and the cost of being wrong is an edit written into someone's field value.
  if (!range.trusted) return conflict(range, 'entry-not-editable');
  if (duplicateKeys.has(range.key)) return conflict(range, 'duplicate-bibtex-key', range.key);
  // The scanner records raw text for every range it reports, so this is
  // another cannot-happen guard bought for a lookup already paid for.  (It is
  // also why the duplicate check comes first: with a duplicated key, the raw
  // map holds only the last entry's text.)
  if (rawEntry === undefined) return conflict(range, 'entry-not-editable');

  // What the field parser reports is only trustworthy when the entry's own
  // lexical level holds no surprises.  Each of these makes the parsed value a
  // guess about text that different BibTeX tools read differently, and this
  // command writes bytes into that text.
  const body = scanBibtexEntryBody(rawEntry);
  if (body.unbalanced) return conflict(range, 'entry-not-editable');
  if (body.hasTopLevelComment) return conflict(range, 'ambiguous-comment');
  if (body.hasConcatenation) return conflict(range, 'concatenated-field');
  const contradicting = findContradictingField(body.fields);
  if (contradicting) return conflict(range, 'duplicate-field', contradicting);
  const symbolic = findSymbolicIdentifier(body.fields);
  if (symbolic) return conflict(range, 'symbolic-field', symbolic);

  // Match on the values the lexical walk read, not the ones the field regex
  // recovered.  The regex is a recognizer: it finds `name = {value}` anywhere,
  // including inside another value it did not realize it was in, so it can
  // report an identifier the entry does not actually carry at its own level.
  // Only the walk knows which is which, and only its reading is the one this
  // command's edits are measured against.
  const fields = new Map(body.fields.map(f => [f.name, f.value]));
  const existing = decideExistingIdentity(range, fields, index);
  if (existing) return existing;

  // Tier 2 — the citation key Zotero itself would generate for the item.
  // Compared case-sensitively and without trimming: a citation key is an
  // identifier, and `Smith2020` and `smith2020` are different entries
  // everywhere else in this codebase.
  const byCitationKey = resolveCandidates(
    range,
    'citation-key',
    ['citation-key'],
    index.byCitationKey.get(range.key) ?? [],
    bothFields,
  );
  if (byCitationKey) return byCitationKey;

  // Tier 3 — DOI, the identifier most bibliographies actually carry.
  const doi = normalizeDoi(fields.get('doi'));
  if (doi) {
    const byDoi = resolveCandidates(range, 'doi', ['doi'], index.byDoi.get(doi) ?? [], bothFields);
    if (byDoi) return byDoi;
  }

  const isbns = normalizeIsbns(fields.get('isbn'));
  const pmid = normalizePmid(fields.get('pmid'));
  if (isbns.length > 0 || pmid) {
    const { candidates, evidence } = findIdentifierCandidates(isbns, pmid, index);
    const byIdentifier = resolveCandidates(range, 'isbn-pmid', evidence, candidates, bothFields);
    if (byIdentifier) return byIdentifier;
  }

  // A normalized URL is a stable identifier too, but sits below the
  // publication identifiers because duplicate imports commonly share one.
  const url = normalizeUrl(fields.get('url'));
  if (url) {
    const byUrl = resolveCandidates(range, 'url', ['url'], index.byUrl.get(url) ?? [], bothFields);
    if (byUrl) return byUrl;
  }

  const byMetadata = decideMetadataFallback(range, body.fields, index);
  if (byMetadata) return byMetadata;

  return { outcome: 'unmatched', entry: range, reason: 'no-match' };
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** Splice each update's fields into its entry.
 *
 *  Built as one pass over the file in source order — the untouched span before
 *  each updated entry, then its rewritten text — joined once at the end.
 *  Splicing into a growing copy of the whole file instead recopies the
 *  bibliography per updated entry, which is quadratic in how much of it
 *  matched.  The scanner reports entry ranges in document order and they never
 *  overlap, so the spans tile the file. */
function applyUpdates(text: string, decisions: readonly ZoteroLinkDecision[]): string {
  const updates = decisions.filter(
    (d): d is Extract<ZoteroLinkDecision, { outcome: 'update' }> => d.outcome === 'update',
  );
  if (updates.length === 0) return text;

  // Only entries too short to carry a newline of their own need the document's
  // convention, so pay for detecting it at most once and only on demand.
  let documentEolCache: BibtexEol | null = null;
  const documentEol = () => (documentEolCache ??= detectBibtexEol(text));

  const chunks: string[] = [];
  let pos = 0;
  for (const { entry, additions } of updates) {
    const rawEntry = text.slice(entry.start, entry.end);
    const indent = detectBibtexFieldIndent(rawEntry);
    const lines = additions.map(a => formatBibtexFieldLine(a.name, a.value, indent));
    chunks.push(
      text.slice(pos, entry.start),
      spliceFieldsIntoEntry(rawEntry, lines, detectEntryEol(rawEntry) ?? documentEol()),
    );
    pos = entry.end;
  }
  chunks.push(text.slice(pos));
  return chunks.join('');
}

/** Fold link decisions into their summary counts.  Exported so the sync
 *  planner reports the same numbers for the same decisions without keeping a
 *  second copy of this fold in step. */
export function summarizeZoteroLinkDecisions(
  decisions: readonly ZoteroLinkDecision[],
): ZoteroLinkSummary {
  const updatesByTier: Record<ZoteroMatchTier, number> = {
    'existing': 0,
    'citation-key': 0,
    'doi': 0,
    'isbn-pmid': 0,
    'url': 0,
    'metadata': 0,
  };
  let updates = 0;
  let preserved = 0;
  let ambiguous = 0;
  let conflicts = 0;
  let unmatched = 0;
  for (const decision of decisions) {
    switch (decision.outcome) {
      case 'update':
        updates++;
        updatesByTier[decision.tier]++;
        break;
      case 'preserve': preserved++; break;
      case 'ambiguous': ambiguous++; break;
      case 'conflict': conflicts++; break;
      case 'unmatched': unmatched++; break;
    }
  }
  return {
    totalEntries: decisions.length,
    updates,
    preserved,
    ambiguous,
    conflicts,
    unmatched,
    updatesByTier,
  };
}

/** Plan the Zotero links for one bibliography against one library's items.
 *
 *  Pure: same arguments, same plan.  The caller decides whether to write
 *  `updatedText`; nothing here touches a file. */
export function createZoteroLinkPlan(
  bibliographyText: string,
  items: readonly ZoteroCatalogItem[],
): ZoteroLinkPlan {
  const { raw, ranges, rangesTrusted } = parseBibtexWithRaw(bibliographyText);

  // Something in the file defeated the scanner.  Past that point an entry's
  // citation key no longer identifies one place in the file, so even the part
  // scanned before it cannot be edited by offset with confidence.  Refuse the
  // document rather than trusting its prefix.
  if (!rangesTrusted) {
    return {
      decisions: [],
      summary: summarizeZoteroLinkDecisions([]),
      updatedText: bibliographyText,
      changed: false,
      blocked: 'unparsable-bibliography',
    };
  }

  const index = buildZoteroCatalogIndex(items);
  const duplicateKeys = findDuplicateBibtexKeys(ranges);
  // The scanner already materialized each entry's raw text; re-slicing it
  // here would allocate a second bibliography's worth of strings.  With a
  // duplicated key the map holds only the last duplicate's text, but that is
  // fine: decideEntry refuses duplicates before reading it.
  const decisions = ranges.map(range =>
    decideEntry(range, raw.get(range.key), index, duplicateKeys),
  );
  const updatedText = applyUpdates(bibliographyText, decisions);

  return {
    decisions,
    summary: summarizeZoteroLinkDecisions(decisions),
    updatedText,
    changed: updatedText !== bibliographyText,
  };
}
