/** Pure core for "Link Bibliography to Zotero".
 *
 *  Takes the text of a .bib file plus a catalog of Zotero items from one
 *  library, and returns a plan: what each entry would become, and the whole
 *  bibliography rewritten with `zotero-key` / `zotero-uri` added to the
 *  entries that matched.
 *
 *  Invariants this module exists to hold:
 *
 *  1. Only exact identifiers match.  Titles, authors, years and journals are
 *     never consulted.  A wrong link is worse than no link: it makes Word
 *     refresh a citation into a different work, silently.
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
  type BibtexEntry,
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

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** One Zotero item, reduced to what matching and reporting need.
 *
 *  The transport adapter builds these directly from each API page and drops
 *  the rest of the payload: a full-library scan is tens of thousands of items,
 *  and retaining their creators, notes and tags to match on four fields would
 *  hold megabytes of JSON alive for the length of the command. */
export interface ZoteroCatalogItem {
  /** 8-character item key, unique within the library. */
  readonly key: string;
  /** Canonical identity URI, built by the adapter from the library's real
   *  numeric id — never `/users/0/`. */
  readonly uri: string;
  /** For display in the summary and details only. */
  readonly title?: string;
  readonly citationKey?: string;
  readonly doi?: string;
  /** Zotero stores one string, which may list several ISBNs. */
  readonly isbn?: string;
  /** Zotero's free-text `Extra` field, which by convention carries the
   *  identifiers item types have no dedicated field for. */
  readonly extra?: string;
}

/** Which rule produced a match.  Ordered by confidence: a tier only runs when
 *  every tier above it found nothing at all. */
export type ZoteroMatchTier = 'existing' | 'citation-key' | 'doi' | 'isbn-pmid';

/** The specific identifier that agreed.  A single match can rest on more than
 *  one — an entry whose ISBN and PMID both point at the same Zotero item. */
export type ZoteroMatchEvidence =
  | 'zotero-key'
  | 'zotero-uri'
  | 'citation-key'
  | 'doi'
  | 'isbn'
  | 'pmid';

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
  /** The entry carries a DOI, ISBN or PMID, and no Zotero item has it. */
  | 'no-exact-match'
  /** The entry carries nothing exact to match on. */
  | 'no-identifiers';

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
 *  Braces are therefore stripped repeatedly, but unescaping runs exactly once,
 *  at the end.  Alternating the two would read the output of one pass as more
 *  input for the next: `\\\_` is a literal backslash followed by an escaped
 *  underscore, and a second pass over the resulting `\_` would eat the
 *  backslash that belongs to the value. */
function plainFieldValue(value: string | undefined): string {
  if (value === undefined) return '';
  const plain = stripWrappingBraces(value.trim());
  // One brace pair can be hidden behind escapes (`{\{12345678\}}`); unescaping
  // exposes it, so strip once more afterwards — again without re-unescaping.
  return stripWrappingBraces(unescapeBibtexPunctuation(plain).trim());
}

/** Remove every brace pair that wraps the whole value, in one pass.
 *
 *  `stripOuterBraces` rescans from the start for each pair it removes, so
 *  calling it in a loop is quadratic — a value wrapped in tens of thousands of
 *  pairs would block the command for seconds.  Since only pairs that enclose
 *  everything are being removed, the depth profile answers it directly: the
 *  number of leading braces that are still open at the last character. */
function stripWrappingBraces(value: string): string {
  let leading = 0;
  while (leading < value.length && value[leading] === '{') leading++;
  if (leading === 0) return value;

  let trailing = 0;
  while (trailing < value.length - leading && value[value.length - 1 - trailing] === '}') trailing++;
  if (trailing === 0) return value;

  // A leading brace wraps the whole value only if nothing inside closes back
  // down to its level before the trailing run begins.  One walk over the
  // interior gives the shallowest depth reached there, which is the most pairs
  // that can be wrapping.
  let depth = leading;
  let shallowest = leading;
  for (let i = leading; i < value.length - trailing; i++) {
    if (value[i] === '{') depth++;
    else if (value[i] === '}' && --depth < shallowest) shallowest = depth;
  }

  const strip = Math.min(leading, trailing, shallowest);
  return strip <= 0 ? value : value.slice(strip, value.length - strip).trim();
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
export function isValidIsbn(compact: string): boolean {
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
  // only when every piece of it validates.
  //
  // A value needing no split is accepted on shape alone.  Both sides of a
  // match come from the same catalogue of human-entered data, and a mistyped
  // ISBN recorded the same way in Zotero and in the .bib still identifies the
  // same work; refusing to match it would lose a real link to enforce a
  // checksum neither side claimed to satisfy.
  const compactOf = (tokens: readonly string[]) =>
    tokens.join('').replace(/-/g, '').toUpperCase();

  /** Split `tokens` entirely into valid ISBNs, or undefined if no split does.
   *
   *  Memoized by start offset: without it the same suffix is re-explored for
   *  every way of reaching it, which is exponential — a run of a few hundred
   *  single-digit tokens would hang the command. */
  const solved = new Map<number, string[] | undefined>();
  const segment = (tokens: readonly string[], from: number): string[] | undefined => {
    if (from === tokens.length) return [];
    const cached = solved.get(from);
    if (cached !== undefined || solved.has(from)) return cached;
    solved.set(from, undefined); // guard against revisiting while in progress
    let answer: string[] | undefined;
    for (let take = 1; from + take <= tokens.length; take++) {
      const compact = compactOf(tokens.slice(from, from + take));
      // Longer runs can only get longer, so stop once even the digits alone
      // exceed the longest ISBN.
      if (compact.replace(/[^0-9X]/gi, '').length > 13) break;
      if (!isValidIsbn(compact)) continue;
      const rest = segment(tokens, from + take);
      if (rest) {
        answer = [compact, ...rest];
        break;
      }
    }
    solved.set(from, answer);
    return answer;
  };

  for (const part of raw.split(/[,;\n]+/)) {
    const tokens = part.split(/\s+/).filter(t => t.length > 0);

    // Nothing to disambiguate: the part is one ISBN-shaped value, so take it
    // as written whether or not its check digit agrees.
    const asWritten = compactOf(tokens);
    if (isIsbnShaped(asWritten)) {
      isbns.push(asWritten);
      continue;
    }

    solved.clear();
    const whole = segment(tokens, 0);
    if (whole) {
      isbns.push(...whole);
      continue;
    }
    // The run holds something that is not part of any ISBN — a label, a stray
    // word.  Take the ISBNs that do stand on their own and skip the rest.
    for (let start = 0; start < tokens.length; ) {
      let matched = 0;
      for (let take = 1; start + take <= tokens.length; take++) {
        const compact = compactOf(tokens.slice(start, start + take));
        if (compact.replace(/[^0-9X]/gi, '').length > 13) break;
        if (isValidIsbn(compact)) {
          isbns.push(compact);
          matched = take;
          break;
        }
      }
      start += matched || 1;
    }
  }
  return isbns;
}

/** A PubMed id reduced to bare digits, or undefined. */
export function normalizePmid(value: string | undefined): string | undefined {
  const raw = plainFieldValue(value).replace(/^pmid:\s*/i, '').trim();
  return /^\d{1,9}$/.test(raw) ? raw : undefined;
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
  };
  for (const item of items) {
    const extra = parseZoteroExtra(item.extra);
    addToIndex(index.byItemKey, item.key, item);
    addToIndex(index.byCitationKey, item.citationKey ?? extra.citationKey, item);
    addToIndex(index.byDoi, normalizeDoi(item.doi) ?? normalizeDoi(extra.doi), item);
    for (const isbn of normalizeIsbns(item.isbn)) addToIndex(index.byIsbn, isbn, item);
    addToIndex(index.byPmid, normalizePmid(extra.pmid), item);
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

/** Identifier fields whose value decides a match, so a repeat with a different
 *  value is a contradiction rather than clutter. */
const IDENTIFIER_FIELDS = ['doi', 'isbn', 'pmid', 'zotero-key', 'zotero-uri'] as const;

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
      if (field.name === name) values.add(plainFieldValue(field.value));
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
  entry: BibtexEntry | undefined,
  rawEntry: string,
  index: ZoteroCatalogIndex,
  duplicateKeys: ReadonlySet<string>,
): ZoteroLinkDecision {
  // Sync loss is currently monotonic, so a document that reaches here at all
  // has no untrusted ranges.  The check stays because the cost is a boolean
  // and the cost of being wrong is an edit written into someone's field value.
  if (!range.trusted) return conflict(range, 'entry-not-editable');
  if (duplicateKeys.has(range.key)) return conflict(range, 'duplicate-bibtex-key', range.key);
  if (!entry) return conflict(range, 'entry-not-editable');

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

  // Nothing matched.  The two reasons read differently to a user: one asks
  // them to add an identifier, the other to add the work to Zotero.
  const hadIdentifier = doi !== undefined || isbns.length > 0 || pmid !== undefined;
  return {
    outcome: 'unmatched',
    entry: range,
    reason: hadIdentifier ? 'no-exact-match' : 'no-identifiers',
  };
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** Splice each update's fields into its entry.
 *
 *  Applied last-first so that every range still describes the text it was
 *  measured against: an edit near the end of the file cannot move the bytes of
 *  one earlier in it. */
function applyUpdates(text: string, decisions: readonly ZoteroLinkDecision[]): string {
  const updates = decisions.filter(
    (d): d is Extract<ZoteroLinkDecision, { outcome: 'update' }> => d.outcome === 'update',
  );
  if (updates.length === 0) return text;

  // Only entries too short to carry a newline of their own need the document's
  // convention, so pay for detecting it at most once and only on demand.
  let documentEolCache: BibtexEol | null = null;
  const documentEol = () => (documentEolCache ??= detectBibtexEol(text));

  let result = text;
  for (let i = updates.length - 1; i >= 0; i--) {
    const { entry, additions } = updates[i];
    const rawEntry = text.slice(entry.start, entry.end);
    const indent = detectBibtexFieldIndent(rawEntry);
    const lines = additions.map(a => formatBibtexFieldLine(a.name, a.value, indent));
    const spliced = spliceFieldsIntoEntry(
      rawEntry,
      lines,
      detectEntryEol(rawEntry) ?? documentEol(),
    );
    result = result.slice(0, entry.start) + spliced + result.slice(entry.end);
  }
  return result;
}

function summarize(decisions: readonly ZoteroLinkDecision[]): ZoteroLinkSummary {
  const updatesByTier: Record<ZoteroMatchTier, number> = {
    'existing': 0,
    'citation-key': 0,
    'doi': 0,
    'isbn-pmid': 0,
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
  const { parsed, ranges, rangesTrusted } = parseBibtexWithRaw(bibliographyText);

  // Something in the file defeated the scanner.  Past that point an entry's
  // citation key no longer identifies one place in the file, so even the part
  // scanned before it cannot be edited by offset with confidence.  Refuse the
  // document rather than trusting its prefix.
  if (!rangesTrusted) {
    return {
      decisions: [],
      summary: summarize([]),
      updatedText: bibliographyText,
      changed: false,
      blocked: 'unparsable-bibliography',
    };
  }

  const index = buildZoteroCatalogIndex(items);
  const duplicateKeys = findDuplicateBibtexKeys(ranges);
  const decisions = ranges.map(range =>
    decideEntry(
      range,
      parsed.get(range.key),
      bibliographyText.slice(range.start, range.end),
      index,
      duplicateKeys,
    ),
  );
  const updatedText = applyUpdates(bibliographyText, decisions);

  return {
    decisions,
    summary: summarize(decisions),
    updatedText,
    changed: updatedText !== bibliographyText,
  };
}
