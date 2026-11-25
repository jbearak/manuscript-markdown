/** The plan for "Push Bibliography to Zotero".
 *
 *  The pull command (`zotero-sync.ts`) makes a .bib say what Zotero says;
 *  this module plans the reverse, for a .bib that people edit by hand: every
 *  entry ends up in one chosen collection, and in update mode each matched
 *  item's fields say what the entry says.
 *
 *  - Identity comes from the link planner (`zotero-link.ts`), run against the
 *    whole library, so an entry whose item is elsewhere in the library is
 *    added to the collection rather than created a second time.  Only strong
 *    evidence lets push touch an existing item: a stored identity, the
 *    citation key, a DOI, an ISBN or PMID.  A URL or metadata match only
 *    links a citation in Word; here it could overwrite the wrong record in a
 *    synced library, which git cannot revert, so it is reported for review.
 *  - Values are compared against the item's own JSON, field by field, only
 *    for fields the entry has.  A field only Zotero has is left alone: the
 *    .bib may be an export that omits it.  Text is compared after TeX is
 *    read away, with quotes, dashes and spaces folded; titles and other
 *    title-like fields ignore case, because BibTeX exports title-case them
 *    (`{{Empirical}} Data` for Zotero's "Empirical data").  A date is equal
 *    when the entry's parts agree with Zotero's as far as the entry goes, so
 *    `year = 2014` keeps Zotero's 2014-06-01.
 *  - A value that still holds a TeX command after decoding is never written:
 *    Zotero would store `Flat{\o}` literally.
 *  - Each touched item gets one keyed write, with its collections, changed
 *    fields and creators together, under the item's version, so nothing
 *    changed in Zotero after the plan was made is overwritten.
 *
 *  Pure: no vscode import, no IO.  Same inputs, same plan. */

import {
  bibtexFieldAsPlainText,
  bibtexNamePartAsPlainText,
  parseBibtexWithRaw,
  type BibtexEntry,
} from './bibtex-parser';
import { pushAll } from './arrays';
import { parseAuthors } from './md-to-docx-citations';
import { normalizeDoi, type ZoteroLinkDecision } from './zotero-link';

/** An item as the Local API returns its `data`, with `meta.parsedDate`. */
export interface ZoteroItemJson {
  readonly key: string;
  readonly version: number;
  readonly itemType: string;
  /** `meta.parsedDate`: Zotero's reading of `date` as YYYY[-MM[-DD]]. */
  readonly parsedDate?: string;
  readonly [field: string]: unknown;
}

/** The parts of `/api/schema` push reads. */
export interface ZoteroItemSchema {
  readonly itemTypes: ReadonlyArray<{
    readonly itemType: string;
    readonly fields: ReadonlyArray<{ readonly field: string; readonly baseField?: string }>;
    readonly creatorTypes: ReadonlyArray<{ readonly creatorType: string }>;
  }>;
}

export type ZoteroPushMode = 'add' | 'update';

export interface ZoteroCreator {
  readonly creatorType: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly name?: string;
}

/** Why an entry's field was left out of the write. */
export type ZoteroFieldNotPushedReason =
  /** Zotero has no field for it in this item type. */
  | 'no-zotero-field'
  /** A TeX command was left after decoding. */
  | 'tex'
  /** The entry's date is not a year, month and day push can read. */
  | 'date-unreadable'
  /** Zotero's own date is free text, so "the same date" cannot be decided. */
  | 'zotero-date-unparsed'
  /** Another of the entry's fields already gives this Zotero field. */
  | 'duplicate-zotero-field'
  /** This item type has no such creator role. */
  | 'no-creator-role';

export interface ZoteroFieldNotPushed {
  readonly field: string;
  readonly reason: ZoteroFieldNotPushedReason;
}

export interface ZoteroFieldChange {
  /** The Zotero field, or `creators:<role>`. */
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

/** Why an entry was left out of the push altogether. */
export type ZoteroPushSkipReason =
  /** The link planner found the entry unsafe to read (see its reasons). */
  | 'conflict'
  /** Several items qualify. */
  | 'ambiguous'
  /** Matched only by URL or metadata. */
  | 'weak-match'
  /** The entry is linked to an item the selected library does not have. */
  | 'other-library'
  /** The entry's DOI and its matched item's DOI differ. */
  | 'identity-disagreement'
  /** Another entry matched the same item. */
  | 'duplicate-target'
  /** Another entry to be created has the same DOI. */
  | 'duplicate-doi'
  /** Push has no Zotero item type for this entry type. */
  | 'unsupported-type';

export type ZoteroPushAction =
  | {
      readonly kind: 'create';
      readonly entryKey: string;
      readonly itemType: string;
      readonly data: Readonly<Record<string, unknown>>;
      readonly notPushed: readonly ZoteroFieldNotPushed[];
    }
  | {
      readonly kind: 'update';
      readonly entryKey: string;
      readonly itemKey: string;
      readonly addToCollection: boolean;
      readonly changes: readonly ZoteroFieldChange[];
      /** The keyed object to send: key, version and what changes. */
      readonly patch: Readonly<Record<string, unknown>>;
      readonly notPushed: readonly ZoteroFieldNotPushed[];
    }
  | {
      readonly kind: 'unchanged';
      readonly entryKey: string;
      readonly itemKey: string;
      readonly notPushed: readonly ZoteroFieldNotPushed[];
    }
  | {
      readonly kind: 'skip';
      readonly entryKey: string;
      readonly reason: ZoteroPushSkipReason;
      readonly detail: string;
    };

export interface ZoteroPushSummary {
  readonly entries: number;
  readonly created: number;
  /** Existing items added to the collection. */
  readonly added: number;
  /** Existing items whose fields change. */
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
}

export interface ZoteroPushPlan {
  readonly mode: ZoteroPushMode;
  readonly collectionKey: string;
  /** One action per entry occurrence, in source order. */
  readonly actions: readonly ZoteroPushAction[];
  readonly summary: ZoteroPushSummary;
  /** Whether anything would be written. */
  readonly changed: boolean;
}

export interface ZoteroPushInput {
  readonly bibText: string;
  readonly decisions: readonly ZoteroLinkDecision[];
  /** Every top-level item in the selected library, by key. */
  readonly items: ReadonlyMap<string, ZoteroItemJson>;
  readonly schema: ZoteroItemSchema;
  readonly collectionKey: string;
  readonly mode: ZoteroPushMode;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** BibTeX entry types and the Zotero item types Zotero's BibTeX import
 *  gives them. */
const ITEM_TYPE_BY_ENTRY_TYPE: Readonly<Record<string, string>> = {
  article: 'journalArticle',
  book: 'book',
  booklet: 'book',
  manual: 'book',
  proceedings: 'book',
  inbook: 'bookSection',
  incollection: 'bookSection',
  inproceedings: 'conferencePaper',
  conference: 'conferencePaper',
  techreport: 'report',
  report: 'report',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  thesis: 'thesis',
  misc: 'document',
  unpublished: 'manuscript',
  online: 'webpage',
  electronic: 'webpage',
  www: 'webpage',
};

/** Each BibTeX field and the Zotero base fields it may fill, the first one
 *  the item type has.  Order matters twice: where two entry fields fill one
 *  Zotero field (institution and publisher on a report), the first wins. */
const FIELD_MAP: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['title', ['title']],
  ['journal', ['publicationTitle']],
  ['journaltitle', ['publicationTitle']],
  ['booktitle', ['publicationTitle']],
  ['volume', ['volume']],
  ['number', ['issue', 'number']],
  ['pages', ['pages']],
  ['chapter', ['section']],
  ['doi', ['DOI']],
  ['url', ['url']],
  ['isbn', ['ISBN']],
  ['issn', ['ISSN']],
  ['institution', ['publisher']],
  ['school', ['publisher']],
  ['publisher', ['publisher']],
  ['address', ['place']],
  ['location', ['place']],
  ['edition', ['edition']],
  ['series', ['series', 'seriesTitle']],
  ['type', ['type']],
  ['abstract', ['abstractNote']],
  ['language', ['language']],
  ['shorttitle', ['shortTitle']],
  ['urldate', ['accessDate']],
  ['pmid', ['PMID']],
  ['pmcid', ['PMCID']],
];

const MAPPED_FIELDS: ReadonlySet<string> = new Set(FIELD_MAP.map(([name]) => name));

/** Entry fields push reads elsewhere (dates, names) or never writes: `file`
 *  holds paths on someone's disk, `keywords` are Zotero's tags, and the
 *  identity fields belong to the link planner. */
const HANDLED_OR_IGNORED: ReadonlySet<string> = new Set([
  'year', 'month', 'date', 'author', 'editor',
  'file', 'keywords', 'zotero-key', 'zotero-uri',
]);

/** Base fields compared without case: BibTeX exports title-case them. */
const CASELESS_BASES: ReadonlySet<string> = new Set([
  'title', 'publicationTitle', 'shortTitle', 'series', 'seriesTitle', 'type',
]);

const CREATOR_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['author', 'author'],
  ['editor', 'editor'],
];

const MONTHS: ReadonlyArray<string> = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

const STRONG_TIERS: ReadonlySet<string> = new Set(['existing', 'citation-key', 'doi', 'isbn-pmid']);

type SchemaType = ZoteroItemSchema['itemTypes'][number];

function schemaType(schema: ZoteroItemSchema, itemType: string): SchemaType | undefined {
  return schema.itemTypes.find(t => t.itemType === itemType);
}

/** The item type's own field for a base field, as `institution` for a
 *  report's `publisher`, or the base field itself where the type has it. */
function resolveField(type: SchemaType, base: string): string | undefined {
  if (type.fields.some(f => f.field === base)) return base;
  return type.fields.find(f => f.baseField === base)?.field;
}

/** The base field a type's field stands for: itself, unless it maps to one. */
function baseOf(type: SchemaType, field: string): string {
  return type.fields.find(f => f.field === field)?.baseField ?? field;
}

// ---------------------------------------------------------------------------
// Reading the entry
// ---------------------------------------------------------------------------

type Read = { readonly value: string } | { readonly problem: ZoteroFieldNotPushedReason };

const TEX_COMMAND = /\\[A-Za-z@]|\\./;

function readText(entry: BibtexEntry, name: string): Read | undefined {
  const raw = entry.fields.get(name);
  if (raw === undefined) return undefined;
  if (name === 'url' || name === 'isbn' || name === 'issn') {
    const value = raw.trim();
    return value === '' ? undefined : { value };
  }
  if (name === 'doi') {
    const value = raw.trim().replace(/\\([_&%#$])/g, '$1');
    return value === '' ? undefined : { value };
  }
  const plain = (bibtexFieldAsPlainText(entry, name) ?? '').replace(/\s+/g, ' ').trim();
  if (plain === '') return undefined;
  if (TEX_COMMAND.test(plain)) return { problem: 'tex' };
  return { value: plain };
}

/** The entry's date as [year, month?, day?], from biblatex's `date` or from
 *  `year` and `month`. */
function readDate(entry: BibtexEntry): { parts: number[] } | { problem: ZoteroFieldNotPushedReason } | undefined {
  const date = entry.fields.get('date')?.trim();
  if (date) {
    const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(date);
    if (!m) return { problem: 'date-unreadable' };
    return { parts: [m[1], m[2], m[3]].filter((p): p is string => p !== undefined).map(Number) };
  }
  const year = entry.fields.get('year')?.trim();
  if (!year) return undefined;
  if (!/^\d{4}$/.test(year)) return { problem: 'date-unreadable' };
  const parts = [Number(year)];
  const month = entry.fields.get('month')?.trim().toLowerCase();
  if (month) {
    const n = /^\d{1,2}$/.test(month) ? Number(month) : MONTHS.indexOf(month.slice(0, 3)) + 1;
    if (!(n >= 1 && n <= 12)) return { problem: 'date-unreadable' };
    parts.push(n);
  }
  return { parts };
}

function formatDate(parts: readonly number[]): string {
  return parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, '0'))).join('-');
}

/** Zotero's parsed date as parts, with Zotero's 00 for "no month" dropped. */
function zoteroDateParts(item: ZoteroItemJson): number[] | undefined {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(item.parsedDate ?? '');
  if (!m) return undefined;
  const parts = [Number(m[1])];
  for (const p of [m[2], m[3]]) {
    if (p === undefined || p === '00') break;
    parts.push(Number(p));
  }
  return parts;
}

/** The entry's names in one role as Zotero creators, or why they can't be. */
function readCreators(entry: BibtexEntry, field: string, creatorType: string): ZoteroCreator[] | 'tex' | undefined {
  const raw = entry.fields.get(field);
  if (raw === undefined || raw.trim() === '') return undefined;
  const creators: ZoteroCreator[] = [];
  for (const name of parseAuthors(raw)) {
    if (name.literal !== undefined) {
      const literal = bibtexNamePartAsPlainText(name.literal).trim();
      if (TEX_COMMAND.test(literal)) return 'tex';
      creators.push({ creatorType, name: literal });
      continue;
    }
    const part = (s: string | undefined) => (s === undefined ? '' : bibtexNamePartAsPlainText(s).replace(/\s+/g, ' ').trim());
    const lastName = [part(name['dropping-particle']), part(name.family)].filter(Boolean).join(' ');
    const given = part(name.given);
    const suffix = part(name.suffix);
    const firstName = suffix ? (given ? given + ', ' + suffix : suffix) : given;
    if (TEX_COMMAND.test(lastName) || TEX_COMMAND.test(firstName)) return 'tex';
    creators.push(firstName ? { creatorType, lastName, firstName } : { creatorType, lastName, firstName: '' });
  }
  return creators;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

function foldText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameValue(base: string, a: string, b: string): boolean {
  switch (base) {
    case 'DOI':
      return (normalizeDoi(a) ?? a) === (normalizeDoi(b) ?? b);
    case 'ISBN':
    case 'ISSN':
      return a.replace(/[\s-]/g, '').toUpperCase() === b.replace(/[\s-]/g, '').toUpperCase();
    case 'url':
      return a.trim() === b.trim();
    case 'pages':
      return foldText(a).replace(/[‐-―-]+/g, '-') === foldText(b).replace(/[‐-―-]+/g, '-');
    default:
      return CASELESS_BASES.has(base)
        ? foldText(a).toLowerCase() === foldText(b).toLowerCase()
        : foldText(a) === foldText(b);
  }
}

function creatorText(c: ZoteroCreator): string {
  return c.name !== undefined && c.name !== '' ? c.name : [c.lastName, c.firstName].filter(Boolean).join(', ');
}

function sameCreators(a: readonly ZoteroCreator[], b: readonly ZoteroCreator[]): boolean {
  const fold = (c: ZoteroCreator) => foldText(creatorText(c)).toLowerCase();
  return a.length === b.length && a.every((c, i) => fold(c) === fold(b[i]));
}

const fold = (label: string): string => label.toLowerCase().replace(/[\s_-]/g, '');

/** The `Label: value` lines of Extra, by folded label, as Zotero and Better
 *  BibTeX read them for fields an item type lacks. */
function extraFields(item: ZoteroItemJson): Map<string, string> {
  const out = new Map<string, string>();
  const extra = typeof item.extra === 'string' ? item.extra : '';
  for (const line of extra.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w -]*):\s*(.+)$/.exec(line.trim());
    if (m && !out.has(fold(m[1]))) out.set(fold(m[1]), m[2].trim());
  }
  return out;
}

function asCreators(value: unknown): ZoteroCreator[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is ZoteroCreator => typeof c === 'object' && c !== null && typeof (c as ZoteroCreator).creatorType === 'string');
}

/** The creators with one role's run replaced by `next`, where that role
 *  first appeared, and every other creator kept in its place. */
function replaceRole(existing: readonly ZoteroCreator[], role: string, next: readonly ZoteroCreator[]): ZoteroCreator[] {
  const out: ZoteroCreator[] = [];
  let placed = false;
  for (const c of existing) {
    if (c.creatorType !== role) {
      out.push(c);
    } else if (!placed) {
      pushAll(out, next);
      placed = true;
    }
  }
  if (placed) return out;
  return role === 'author' ? [...next, ...out] : [...out, ...next];
}

// ---------------------------------------------------------------------------
// Entry → Zotero fields
// ---------------------------------------------------------------------------

interface EntryFields {
  /** Zotero field → value, for the given item type. */
  readonly fields: Map<string, { readonly value: string; readonly base: string; readonly from: string }>;
  readonly date?: readonly number[];
  readonly creators: Map<string, ZoteroCreator[]>;
  readonly notPushed: ZoteroFieldNotPushed[];
}

function entryFields(entry: BibtexEntry, type: SchemaType): EntryFields {
  const fields: EntryFields['fields'] = new Map();
  const creators = new Map<string, ZoteroCreator[]>();
  const notPushed: ZoteroFieldNotPushed[] = [];
  for (const [name, bases] of FIELD_MAP) {
    const read = readText(entry, name);
    if (read === undefined) continue;
    if ('problem' in read) {
      notPushed.push({ field: name, reason: read.problem });
      continue;
    }
    let target: string | undefined;
    let base = '';
    for (const b of bases) {
      target = resolveField(type, b);
      if (target !== undefined) {
        base = b;
        break;
      }
    }
    if (target === undefined) {
      notPushed.push({ field: name, reason: 'no-zotero-field' });
    } else if (fields.has(target)) {
      notPushed.push({ field: name, reason: 'duplicate-zotero-field' });
    } else {
      fields.set(target, { value: read.value, base, from: name });
    }
  }
  for (const name of entry.fields.keys()) {
    if (!MAPPED_FIELDS.has(name) && !HANDLED_OR_IGNORED.has(name)) {
      notPushed.push({ field: name, reason: 'no-zotero-field' });
    }
  }
  let date: number[] | undefined;
  const readDateResult = readDate(entry);
  if (readDateResult !== undefined) {
    if ('problem' in readDateResult) notPushed.push({ field: 'year', reason: readDateResult.problem });
    else if (resolveField(type, 'date') === undefined) notPushed.push({ field: 'year', reason: 'no-zotero-field' });
    else date = readDateResult.parts;
  }
  for (const [field, role] of CREATOR_ROLES) {
    const read = readCreators(entry, field, role);
    if (read === undefined) continue;
    if (read === 'tex') notPushed.push({ field, reason: 'tex' });
    else if (!type.creatorTypes.some(c => c.creatorType === role)) notPushed.push({ field, reason: 'no-creator-role' });
    else creators.set(role, read);
  }
  return { fields, date, creators, notPushed };
}

function createData(
  entry: BibtexEntry,
  itemType: string,
  type: SchemaType,
  collectionKey: string,
): { data: Record<string, unknown>; notPushed: ZoteroFieldNotPushed[] } {
  const read = entryFields(entry, type);
  const data: Record<string, unknown> = { itemType };
  for (const [field, { value }] of read.fields) data[field] = value;
  if (read.date !== undefined) data[resolveField(type, 'date')!] = formatDate(read.date);
  const lowerType = entry.type.toLowerCase();
  const thesisType = resolveField(type, 'type');
  if (thesisType !== undefined && data[thesisType] === undefined) {
    if (lowerType === 'phdthesis') data[thesisType] = 'PhD Thesis';
    else if (lowerType === 'mastersthesis') data[thesisType] = "Master's Thesis";
  }
  data.creators = [...(read.creators.get('author') ?? []), ...(read.creators.get('editor') ?? [])];
  if (type.fields.some(f => f.field === 'citationKey')) data.citationKey = entry.key;
  data.collections = [collectionKey];
  return { data, notPushed: read.notPushed };
}

function updateChanges(
  entry: BibtexEntry,
  item: ZoteroItemJson,
  type: SchemaType,
): { changes: ZoteroFieldChange[]; patch: Record<string, unknown>; notPushed: ZoteroFieldNotPushed[] } {
  const read = entryFields(entry, type);
  const changes: ZoteroFieldChange[] = [];
  const patch: Record<string, unknown> = {};
  const notPushed = [...read.notPushed];
  const extra = extraFields(item);
  for (const [field, { value, base, from }] of read.fields) {
    const current = typeof item[field] === 'string' ? (item[field] as string) : '';
    // A value Zotero keeps as a line of Extra, as `Series: …`, is the one
    // its exports read for the field, so the entry already says it.
    const inExtra = current === '' ? [field, base, from].map(label => extra.get(fold(label))).find(v => v !== undefined) : undefined;
    const compared = current !== '' ? current : inExtra;
    if (compared !== undefined && sameValue(baseOf(type, field) || base, compared, value)) continue;
    changes.push({ field, from: current, to: value });
    patch[field] = value;
  }
  if (read.date !== undefined) {
    const field = resolveField(type, 'date')!;
    const current = typeof item[field] === 'string' ? (item[field] as string) : '';
    const zParts = zoteroDateParts(item);
    if (current !== '' && zParts === undefined) {
      notPushed.push({ field: 'year', reason: 'zotero-date-unparsed' });
    } else if (zParts === undefined || !read.date.every((p, i) => zParts[i] === p)) {
      const to = formatDate(read.date);
      changes.push({ field, from: current, to });
      patch[field] = to;
    }
  }
  const existing = asCreators(item.creators);
  let creators = existing;
  for (const [role, next] of read.creators) {
    const current = existing.filter(c => c.creatorType === role);
    if (sameCreators(current, next)) continue;
    changes.push({
      field: 'creators:' + role,
      from: current.map(creatorText).join('; '),
      to: next.map(creatorText).join('; '),
    });
    creators = replaceRole(creators, role, next);
  }
  if (creators !== existing) patch.creators = creators;
  return { changes, patch, notPushed };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

type Candidate =
  | { readonly kind: 'match'; readonly entryKey: string; readonly entry: BibtexEntry; readonly item: ZoteroItemJson }
  | { readonly kind: 'create'; readonly entryKey: string; readonly entry: BibtexEntry }
  | Extract<ZoteroPushAction, { kind: 'skip' }>;

export function createZoteroPushPlan(input: ZoteroPushInput): ZoteroPushPlan {
  const { parsed } = parseBibtexWithRaw(input.bibText);
  const skip = (entryKey: string, reason: ZoteroPushSkipReason, detail = ''): Candidate =>
    ({ kind: 'skip', entryKey, reason, detail });

  // First pass: what each entry is, on its own.
  const candidates: Candidate[] = input.decisions.map((decision): Candidate => {
    const entryKey = decision.entry.key;
    const entry = parsed.get(entryKey);
    switch (decision.outcome) {
      case 'conflict':
        return skip(entryKey, 'conflict', decision.reason);
      case 'ambiguous':
        return skip(entryKey, 'ambiguous', decision.candidates.map(c => c.key).join(', '));
      case 'unmatched':
        return entry === undefined ? skip(entryKey, 'conflict', 'entry-not-editable') : { kind: 'create', entryKey, entry };
      case 'update':
      case 'preserve': {
        if (decision.outcome === 'update' && !STRONG_TIERS.has(decision.tier)) {
          return skip(entryKey, 'weak-match', decision.target.key);
        }
        const item = input.items.get(decision.target.key);
        if (item === undefined) return skip(entryKey, 'other-library', decision.target.key);
        if (entry === undefined) return skip(entryKey, 'conflict', 'entry-not-editable');
        const entryDoi = normalizeDoi(entry.fields.get('doi'));
        const itemDoi = normalizeDoi(typeof item.DOI === 'string' ? item.DOI : undefined);
        if (entryDoi !== undefined && itemDoi !== undefined && entryDoi !== itemDoi) {
          return skip(entryKey, 'identity-disagreement', item.key);
        }
        return { kind: 'match', entryKey, entry, item };
      }
    }
  });

  // Second pass: entries that would collide with each other.
  const targets = new Map<string, number>();
  const createDois = new Map<string, number>();
  for (const c of candidates) {
    if (c.kind === 'match') targets.set(c.item.key, (targets.get(c.item.key) ?? 0) + 1);
    if (c.kind === 'create') {
      const doi = normalizeDoi(c.entry.fields.get('doi'));
      if (doi !== undefined) createDois.set(doi, (createDois.get(doi) ?? 0) + 1);
    }
  }

  const actions: ZoteroPushAction[] = candidates.map((c): ZoteroPushAction => {
    if (c.kind === 'skip') return c;
    if (c.kind === 'create') {
      const doi = normalizeDoi(c.entry.fields.get('doi'));
      if (doi !== undefined && (createDois.get(doi) ?? 0) > 1) {
        return { kind: 'skip', entryKey: c.entryKey, reason: 'duplicate-doi', detail: doi };
      }
      const itemType = ITEM_TYPE_BY_ENTRY_TYPE[c.entry.type.toLowerCase()];
      const type = itemType === undefined ? undefined : schemaType(input.schema, itemType);
      if (itemType === undefined || type === undefined) {
        return { kind: 'skip', entryKey: c.entryKey, reason: 'unsupported-type', detail: c.entry.type };
      }
      const { data, notPushed } = createData(c.entry, itemType, type, input.collectionKey);
      return { kind: 'create', entryKey: c.entryKey, itemType, data, notPushed };
    }
    if ((targets.get(c.item.key) ?? 0) > 1) {
      return { kind: 'skip', entryKey: c.entryKey, reason: 'duplicate-target', detail: c.item.key };
    }
    const collections = Array.isArray(c.item.collections)
      ? (c.item.collections as unknown[]).filter((k): k is string => typeof k === 'string')
      : [];
    const addToCollection = !collections.includes(input.collectionKey);
    const type = schemaType(input.schema, c.item.itemType);
    let changes: ZoteroFieldChange[] = [];
    let patch: Record<string, unknown> = {};
    let notPushed: ZoteroFieldNotPushed[] = [];
    if (input.mode === 'update' && type !== undefined) {
      ({ changes, patch, notPushed } = updateChanges(c.entry, c.item, type));
    }
    if (!addToCollection && changes.length === 0) {
      return { kind: 'unchanged', entryKey: c.entryKey, itemKey: c.item.key, notPushed };
    }
    if (addToCollection) patch.collections = [...collections, input.collectionKey];
    return {
      kind: 'update',
      entryKey: c.entryKey,
      itemKey: c.item.key,
      addToCollection,
      changes,
      patch: { key: c.item.key, version: c.item.version, ...patch },
      notPushed,
    };
  });

  const count = (pred: (a: ZoteroPushAction) => boolean) => actions.filter(pred).length;
  const summary: ZoteroPushSummary = {
    entries: actions.length,
    created: count(a => a.kind === 'create'),
    added: count(a => a.kind === 'update' && a.addToCollection),
    updated: count(a => a.kind === 'update' && a.changes.length > 0),
    unchanged: count(a => a.kind === 'unchanged'),
    skipped: count(a => a.kind === 'skip'),
  };
  return {
    mode: input.mode,
    collectionKey: input.collectionKey,
    actions,
    summary,
    changed: summary.created + summary.added + summary.updated > 0,
  };
}

/** The objects to send, in batches Zotero accepts (at most 50 a request). */
export function zoteroPushWrites(plan: ZoteroPushPlan): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const a of plan.actions) {
    if (a.kind === 'create') out.push({ ...a.data });
    else if (a.kind === 'update') out.push({ ...a.patch });
  }
  return out;
}
