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
  detectEntryEol,
  detectBibtexEol,
  stripOuterBraces,
  unescapeBibtexPunctuation,
  type BibtexEntry,
  type BibtexSourceRange,
  type BibtexEol,
} from './bibtex-parser';

// ---------------------------------------------------------------------------
// Zotero identity
// ---------------------------------------------------------------------------

/** Matches the 8-character Zotero item key at the end of a URI. */
export const ZOTERO_KEY_RE = /\/items\/([A-Z0-9]{8})$/;

/** A Zotero item key on its own: 8 characters of uppercase base-32-ish. */
export const ZOTERO_ITEM_KEY_RE = /^[A-Z0-9]{8}$/;

/** A full Zotero identity URI, as Word stores it in `ADDIN ZOTERO_ITEM` field
 *  codes.  Group URIs name a server-assigned group id and resolve for every
 *  member; personal URIs name one user's numeric id, or `local/<slug>` for a
 *  library that has never synced, and resolve only for that user. */
const ZOTERO_URI_RE =
  /^https?:\/\/zotero\.org\/(?:users\/(?:\d+|local\/[A-Za-z0-9]+)|groups\/\d+)\/items\/([A-Z0-9]{8})$/;

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
  return m ? m[1] : undefined;
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
  | 'entry-not-editable';

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

/** A field value as the user typed it, reduced to comparable form: outer
 *  braces removed (`doi = {{10.1/x}}` keeps a brace pair on verbatim fields)
 *  and BibTeX punctuation escapes undone (`10.1/a\_b`). */
function plainFieldValue(value: string | undefined): string {
  if (value === undefined) return '';
  return unescapeBibtexPunctuation(stripOuterBraces(value.trim())).trim();
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
  for (const part of raw.split(/[,;\s]+/)) {
    const compact = part.replace(/-/g, '').toUpperCase();
    if (/^\d{9}[\dX]$/.test(compact) || /^\d{13}$/.test(compact)) isbns.push(compact);
  }
  return isbns;
}

/** A PubMed id reduced to bare digits, or undefined. */
export function normalizePmid(value: string | undefined): string | undefined {
  const raw = plainFieldValue(value).replace(/^pmid:\s*/i, '').trim();
  return /^\d{1,9}$/.test(raw) ? raw : undefined;
}

// Zotero's `Extra` field is the documented home for identifiers the item type
// has no field for.  Each is a whole line of the form `Name: value`; matching
// only whole lines keeps a number mentioned in a note from being read as an
// identifier.  Non-global regexes: `exec` on a global one is stateful.
const EXTRA_DOI_RE = /^[ \t]*doi[ \t]*:[ \t]*(\S.*?)[ \t]*$/im;
const EXTRA_PMID_RE = /^[ \t]*pmid[ \t]*:[ \t]*(\d+)[ \t]*$/im;
const EXTRA_CITATION_KEY_RE = /^[ \t]*citation key[ \t]*:[ \t]*(\S+)[ \t]*$/im;

function matchExtraLine(extra: string | undefined, re: RegExp): string | undefined {
  if (!extra) return undefined;
  const m = re.exec(extra);
  return m ? m[1] : undefined;
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

export function buildZoteroCatalogIndex(items: readonly ZoteroCatalogItem[]): ZoteroCatalogIndex {
  const index: ZoteroCatalogIndex = {
    byItemKey: new Map(),
    byCitationKey: new Map(),
    byDoi: new Map(),
    byIsbn: new Map(),
    byPmid: new Map(),
  };
  for (const item of items) {
    addToIndex(index.byItemKey, item.key, item);
    addToIndex(
      index.byCitationKey,
      item.citationKey ?? matchExtraLine(item.extra, EXTRA_CITATION_KEY_RE),
      item,
    );
    addToIndex(
      index.byDoi,
      normalizeDoi(item.doi) ?? normalizeDoi(matchExtraLine(item.extra, EXTRA_DOI_RE)),
      item,
    );
    for (const isbn of normalizeIsbns(item.isbn)) addToIndex(index.byIsbn, isbn, item);
    addToIndex(index.byPmid, normalizePmid(matchExtraLine(item.extra, EXTRA_PMID_RE)), item);
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
  fields: ReadonlyMap<string, string>,
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

  for (const isbn of normalizeIsbns(fields.get('isbn'))) {
    collect(index.byIsbn.get(isbn) ?? [], 'isbn');
  }
  const pmid = normalizePmid(fields.get('pmid'));
  if (pmid) collect(index.byPmid.get(pmid) ?? [], 'pmid');

  return { candidates: [...found.values()], evidence: [...evidence] };
}

function decideEntry(
  range: BibtexSourceRange,
  entry: BibtexEntry | undefined,
  index: ZoteroCatalogIndex,
  duplicateKeys: ReadonlySet<string>,
): ZoteroLinkDecision {
  // Sync loss is currently monotonic, so a document that reaches here at all
  // has no untrusted ranges.  The check stays because the cost is a boolean
  // and the cost of being wrong is an edit written into someone's field value.
  if (!range.trusted) return conflict(range, 'entry-not-editable');
  if (duplicateKeys.has(range.key)) return conflict(range, 'duplicate-bibtex-key', range.key);
  if (!entry) return conflict(range, 'entry-not-editable');

  const fields = entry.fields;
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
    const { candidates, evidence } = findIdentifierCandidates(fields, index);
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

/** Indentation of the entry's existing fields, so inserted lines sit with
 *  them.  Two spaces matches this codebase's generated BibTeX, and is the
 *  fallback for an entry written on one line. */
const FIELD_LINE_RE = /\n([ \t]+)[A-Za-z][\w-]*[ \t]*=/;

function detectFieldIndent(rawEntry: string): string {
  const m = FIELD_LINE_RE.exec(rawEntry);
  return m ? m[1] : '  ';
}

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
    const indent = detectFieldIndent(rawEntry);
    const lines = additions.map(a => indent + a.name + ' = {' + a.value + '},');
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
    decideEntry(range, parsed.get(range.key), index, duplicateKeys),
  );
  const updatedText = applyUpdates(bibliographyText, decisions);

  return {
    decisions,
    summary: summarize(decisions),
    updatedText,
    changed: updatedText !== bibliographyText,
  };
}
