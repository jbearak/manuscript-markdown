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
 *    Strong evidence must also be unopposed: an entry whose citation key,
 *    DOI, PMID or whole-work ISBN another item also answers to is left
 *    alone, and so is a create that would copy an item the library has.
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
import { createHash } from 'crypto';
import { pushAll } from './arrays';
import { parseAuthorName, splitAuthorString } from './md-to-docx-citations';
import { normalizeDoi, normalizeIsbns, normalizePmid, type ZoteroLinkDecision } from './zotero-link';

/** An item as the Local API returns its `data`, with `meta.parsedDate`. */
export interface ZoteroItemJson {
  readonly key: string;
  readonly version: number;
  readonly itemType: string;
  /** `meta.parsedDate`: Zotero's reading of `date` as YYYY[-MM[-DD]]. */
  readonly parsedDate?: string;
  /** The item's identity URI, as the link planner's catalog gives it. */
  readonly uri?: string;
  readonly [field: string]: unknown;
}

/** The parts of `/api/schema` push reads. */
export interface ZoteroItemSchema {
  readonly itemTypes: ReadonlyArray<{
    readonly itemType: string;
    readonly fields: ReadonlyArray<{ readonly field: string; readonly baseField?: string }>;
    readonly creatorTypes: ReadonlyArray<{ readonly creatorType: string }>;
  }>;
  /** Zotero's CSL mappings, which it also reads Extra's lines by. */
  readonly csl?: {
    readonly types?: Readonly<Record<string, readonly string[]>>;
    /** Zotero creator role → CSL name variable. */
    readonly names?: Readonly<Record<string, string>>;
    readonly fields?: {
      readonly text?: Readonly<Record<string, readonly string[]>>;
      readonly date?: Readonly<Record<string, string>>;
    };
  };
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
  /** Another of the entry's fields already gives this Zotero field. */
  | 'duplicate-zotero-field'
  /** This item type has no such creator role. */
  | 'no-creator-role'
  /** The value is a @string macro's name, not its text. */
  | 'macro'
  /** The name list ends `and others`, so it is not the whole list, and
   *  the names it gives are not the start of Zotero's. */
  | 'incomplete-names'
  /** The DOI is not DOI-shaped. */
  | 'unreadable-doi'
  /** A name in the list is not one BibTeX reads: empty, a stray `and`, or
   *  with more than two commas. */
  | 'unreadable-names'
  /** A lone `journal`, where Zotero has both a full title and an
   *  abbreviation and the value is neither, could be either. */
  | 'ambiguous-journal'
  /** Zotero has series editors, which its export lists in `editor` with
   *  the editors, so the entry's editors can't say which are which. */
  | 'series-editors'
  /** The value holds TeX math, whose grouping Zotero's text can't keep. */
  | 'math'
  /** The PMID is not a PubMed id the matcher reads, as `pending`. */
  | 'unreadable-pmid'
  /** The entry gives the field more than once: BibTeX reads the first,
   *  biber and this parser the last. */
  | 'repeated-field';

export interface ZoteroFieldNotPushed {
  readonly field: string;
  readonly reason: ZoteroFieldNotPushedReason;
}

export interface ZoteroFieldChange {
  /** The Zotero field, `creators:<role>`, or `creators` for the whole
   *  list where creators of other roles move. */
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
  /** Another entry would give the same DOI to another item. */
  | 'duplicate-doi'
  /** Another item in the library has the entry's DOI. */
  | 'doi-owned-elsewhere'
  /** The entry's PMID is its matched item's no more: the item has another,
   *  or another item has it. */
  | 'pmid-disagreement'
  /** Another item claims the entry's citation key, in its Citation Key
   *  field or a `Citation Key:` line of Extra, which Zotero's BibTeX export
   *  prefers: two items answer to the key, so it names neither for sure. */
  | 'citation-key-conflict'
  /** No item has the entry's citation key stored, but Zotero's export makes
   *  it for one that has none (see generatedCitationKey), so it may be in
   *  the library already. */
  | 'generated-key'
  /** Only one item's Extra line gives the entry's key, which push doesn't
   *  take as that item's (see `decisions`). */
  | 'extra-key-only'
  /** An item with no citation key stored has the entry's title and names,
   *  so it may be the entry's (see sameWorkWithoutKey). */
  | 'possible-existing'
  /** Matched by citation key, DOI, PMID or ISBN to one item, while another
   *  with no citation key stored has the entry's title and names (see
   *  sameWorkWithoutKey). */
  | 'plain-match-elsewhere'
  /** Another whole work in the library, as a book, has the entry's ISBN. */
  | 'isbn-owned-elsewhere'
  /** Zotero's answer left out the item's collections or creators, or gave
   *  one push can't read, and a write would replace the whole list. */
  | 'incomplete-item'
  /** Another entry would give the same PMID or whole-work ISBN to an item. */
  | 'duplicate-identifier'
  /** The item type has no Citation Key field, so the next push couldn't
   *  find the item it creates, and would create it again. */
  | 'no-citation-key-field'
  /** The library already holds the key push would create this entry's
   *  item under (see pushItemKey), or another entry's item would get it. */
  | 'key-taken'
  /** The item push would have created for this citation key is in the
   *  library, but another item has the citation key now: which one the
   *  entry means is unclear. */
  | 'citation-key-moved'
  /** Push has no Zotero item type for this entry type. */
  | 'unsupported-type'
  /** An identifier is written with TeX the matcher doesn't read. */
  | 'unreadable-identifier'
  /** Saving the item through the Local API would make Zotero move lines of
   *  its Extra field into fields, or change its type by a `Type:` line, so
   *  even adding it to the collection would change it. */
  | 'extra-would-migrate';

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
  /** Names the library, for the keys push creates items under (see
   *  pushItemKey): the Zotero's server id and the library's scope. */
  readonly keySalt: string;
  /** Every key the library holds, trash, notes and attachments included. */
  readonly takenKeys: ReadonlySet<string>;
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
  ['fjournal', ['publicationTitle']],
  ['journaltitle', ['publicationTitle']],
  ['booktitle', ['publicationTitle']],
  ['volume', ['volume']],
  // A book's number is its series number, and its pages its page count,
  // as Zotero's BibTeX import reads them.
  ['number', ['issue', 'number', 'seriesNumber']],
  ['pages', ['pages', 'numPages']],
  ['pagetotal', ['numPages']],
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
  'title', 'publicationTitle', 'journalAbbreviation', 'shortTitle', 'series', 'seriesTitle', 'type',
]);

const CREATOR_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['author', 'author'],
  ['editor', 'editor'],
];

const MONTHS: ReadonlyArray<string> = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

const MONTH_NAMES: ReadonlyArray<string> = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
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

/** Whether the entry writes the field as a bare word, a @string macro's
 *  name: neither braced, quoted, nor a number. */
function isMacro(entry: BibtexEntry, name: string): boolean {
  const written = entry.writtenFields?.get(name)?.trim();
  return written !== undefined && written !== '' && !/^[{"]/.test(written) && !/^\d+$/.test(written);
}

/** A DOI in its bare lowercase form, if it has a DOI's shape: 10., a
 *  numeric registrant, a slash and a suffix. */
function validDoi(value: string | undefined): string | undefined {
  const doi = normalizeDoi(value);
  return doi !== undefined && /^10\.\d+(?:\.\d+)*\/\S+$/.test(doi) ? doi : undefined;
}

/** An identifier or URL as written, with TeX's escaped punctuation read
 *  (and a \url{} around it, though an entry whose matched identifiers
 *  hold TeX is left alone before this is reached; see MATCHED_IDENTIFIERS). */
function readVerbatim(raw: string): string {
  const unwrapped = /^\\url\{(.*)\}$/s.exec(raw.trim())?.[1] ?? raw.trim();
  return unwrapped.replace(/\\([_&%#$~])/g, '$1').trim();
}

function readText(entry: BibtexEntry, name: string): Read | undefined {
  const raw = entry.fields.get(name);
  if (raw === undefined) return undefined;
  if (isMacro(entry, name)) return { problem: 'macro' };
  if (name === 'urldate') {
    // Zotero drops an access date it can't read, and with it the one it had.
    const value = raw.trim();
    // A day, or Zotero's own form, an ISO time in UTC.
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ)?$/.exec(value);
    const day = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
    const real = day !== undefined && day.getUTCMonth() === Number(m![2]) - 1 && day.getUTCDate() === Number(m![3]);
    return real ? { value } : { problem: 'date-unreadable' };
  }
  if (name === 'pmid') {
    // Read as the matcher reads it, so `PMID: 222` is 222, and one it can't
    // read, as `pending`, is never written over a real one.
    if (readVerbatim(raw) === '') return undefined;
    const pmid = normalizePmid(raw);
    return pmid === undefined ? { problem: 'unreadable-pmid' } : { value: pmid };
  }
  if (name === 'url' || name === 'isbn' || name === 'issn' || name === 'doi') {
    const value = readVerbatim(raw);
    if (value === '') return undefined;
    if (/[\\{}]/.test(value)) return { problem: 'tex' };
    if (name === 'doi' && validDoi(value) === undefined) return { problem: 'unreadable-doi' };
    return { value };
  }
  // Zotero's export writes a tilde and a circumflex as \textasciitilde
  // and \textasciicircum, which are those characters.
  const plain = (bibtexFieldAsPlainText(entry, name) ?? '')
    .replace(/\\textasciitilde(?![A-Za-z])/g, '~')
    .replace(/\\textasciicircum(?![A-Za-z])/g, '^')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return undefined;
  // Math, as $x^{12}$, whose groups the text loses: $x^12$ is another
  // formula.  It takes two dollar signs; an escaped one, \$, is text, and
  // so, here, is one alone, as in a title's $100.
  const unescapedDollars = (entry.texFields?.get(name) ?? entry.fields.get(name) ?? '').match(/(?<!\\)\$/g) ?? [];
  if (unescapedDollars.length >= 2) return { problem: 'math' };
  if (TEX_COMMAND.test(plain)) return { problem: 'tex' };
  return { value: plain };
}

/** A month as BibTeX writes one: its standard macro (`sep`), its English
 *  name, or its number. */
function readMonth(entry: BibtexEntry): number | 'macro' | undefined {
  const month = entry.fields.get('month')?.trim().toLowerCase();
  if (!month) return undefined;
  if (/^\d{1,2}$/.test(month)) return Number(month);
  const macro = MONTHS.indexOf(month) + 1;
  if (macro > 0) return macro;
  if (isMacro(entry, 'month')) return 'macro';
  const named = MONTH_NAMES.indexOf(month) + 1;
  return named > 0 ? named : undefined;
}

/** The entry's date as [year, month?, day?], from biblatex's `date` or,
 *  without one, from `year` and `month`. */
function readDate(entry: BibtexEntry): { parts: number[] } | { problem: ZoteroFieldNotPushedReason } | undefined {
  // A month 1 to 12, and a day the month has, as 29 February only in a
  // leap year.
  const valid = ([year, month, day]: number[]): boolean =>
    (month === undefined || (month >= 1 && month <= 12)) &&
    (day === undefined || (day >= 1 && day <= new Date(Date.UTC(year, month!, 0)).getUTCDate()));
  const date = entry.fields.get('date')?.trim();
  if (date) {
    if (isMacro(entry, 'date')) return { problem: 'macro' };
    const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(date);
    const parts = m ? [m[1], m[2], m[3]].filter((p): p is string => p !== undefined).map(Number) : [];
    return m && valid(parts) ? { parts } : { problem: 'date-unreadable' };
  }
  const year = entry.fields.get('year')?.trim();
  if (!year) return undefined;
  if (isMacro(entry, 'year')) return { problem: 'macro' };
  if (!/^\d{4}$/.test(year)) return { problem: 'date-unreadable' };
  const parts = [Number(year)];
  const month = readMonth(entry);
  if (month === 'macro') return { problem: 'macro' };
  if (entry.fields.get('month')?.trim() && month === undefined) return { problem: 'date-unreadable' };
  if (month !== undefined) parts.push(month);
  return valid(parts) ? { parts } : { problem: 'date-unreadable' };
}

function formatDate(parts: readonly number[]): string {
  // The year as the entry gives it, four digits: 0044, not 44.
  return parts.map((p, i) => String(p).padStart(i === 0 ? 4 : 2, '0')).join('-');
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
interface ReadCreators {
  readonly creators: ZoteroCreator[];
  /** Each name's text, its ties read, for a name not in one group, as
   *  Zotero's export writes a two-field name with no first name (see
   *  sameAsExported). */
  readonly texts: ReadonlyArray<string | undefined>;
  /** The list ended `and others`: these are its first names, not all. */
  readonly incomplete: boolean;
}

/** `value` with each `~` outside its groups a space, as BibTeX splits a
 *  name's words at a tie (bibtex.web, sep_char), but not an escaped one. */
function tiesAsSpaces(value: string): string {
  let depth = 0;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') {
      out += c + (value[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    out += c === '~' && depth === 0 ? ' ' : c;
  }
  return out;
}

/** Whether `value` has an escaped brace, \{ or \}, outside the groups its
 *  unescaped braces make. */
function escapedBraceOutsideGroups(value: string): boolean {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') {
      if ((value[i + 1] === '{' || value[i + 1] === '}') && depth === 0) return true;
      i++;
    } else if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return false;
}

/** Whether BibTeX reads `name`, one of a list's names, as a name: not empty
 *  or a stray `and`, and with at most two commas outside its groups (a
 *  third is "too many commas", which BibTeX drops the rest after). */
function readableName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === '' || /^and$|^and\s|\sand$/i.test(trimmed)) return false;
  let depth = 0;
  let commas = 0;
  for (const c of trimmed) {
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) commas++;
  }
  return commas <= 2;
}

function readCreators(entry: BibtexEntry, field: string, creatorType: string): ReadCreators | 'tex' | 'macro' | 'unreadable' | undefined {
  const parsed = entry.fields.get(field);
  if (parsed === undefined || parsed.trim() === '') return undefined;
  if (isMacro(entry, field)) return 'macro';
  // The parsed value reads an escaped brace as a brace, which splitting a
  // name then drops as a group's, and a literal tilde (\~{} or
  // \textasciitilde) as a tilde, which is a tie; where the entry has
  // either, its names are read as written, its spaces run together as the
  // parser runs them.  (An accent, as \~n, the parser reads already.)
  const written = entry.writtenFields?.get(field)?.trim();
  const asWritten = written !== undefined && /^\{.*\}$|^".*"$/s.test(written) ? written.slice(1, -1).replace(/\s+/g, ' ').trim() : undefined;
  const raw = asWritten !== undefined && /\\(?:[{}]|~\{\}|textasciitilde)/.test(asWritten) ? asWritten : parsed;
  // Names part at an `and` between spaces, in any case, as BibTeX parts
  // them, before a tie reads as a space: Doe~and~Smith is one name.
  // An escaped brace outside every group, as in Doe, Jane\{ AND Smith,
  // John\}, is one BibTeX counts as a group's and this list's reader as a
  // character, so where its names part is unclear.
  if (escapedBraceOutsideGroups(raw)) return 'unreadable';
  const list = splitAuthorString(raw, true);
  if (list.length === 0 || !list.every(readableName)) return 'unreadable';
  // Math, as in a title (see readText), loses its groups as a name's part;
  // counted as written, where an escaped dollar sign is text.
  if (((written ?? raw).match(/(?<!\\)\$/g) ?? []).length >= 2) return 'tex';
  const creators: ZoteroCreator[] = [];
  const texts: Array<string | undefined> = [];
  const read = list.map(name => tiesAsSpaces(name));
  const names = read.map(parseAuthorName);
  const last = names[names.length - 1];
  const incomplete = last !== undefined && last.family === 'others' && last.given === undefined && last.literal === undefined;
  if (incomplete) names.pop();
  for (const [i, name] of names.entries()) {
    if (name.literal !== undefined) {
      const literal = bibtexNamePartAsPlainText(name.literal).trim();
      if (literal === '') return 'unreadable';
      if (TEX_COMMAND.test(literal)) return 'tex';
      creators.push({ creatorType, name: literal });
      texts.push(undefined);
      continue;
    }
    texts.push(bibtexNamePartAsPlainText(read[i]).replace(/\s+/g, ' ').trim());
    const part = (s: string | undefined) => (s === undefined ? '' : bibtexNamePartAsPlainText(s).replace(/\s+/g, ' ').trim());
    const lastName = [part(name['dropping-particle']), part(name.family)].filter(Boolean).join(' ');
    const given = part(name.given);
    const suffix = part(name.suffix);
    const firstName = suffix ? (given ? given + ', ' + suffix : suffix) : given;
    if (TEX_COMMAND.test(lastName) || TEX_COMMAND.test(firstName)) return 'tex';
    if (lastName === '') return 'unreadable';
    creators.push(firstName ? { creatorType, lastName, firstName } : { creatorType, lastName, firstName: '' });
  }
  return { creators, texts, incomplete };
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

// The rich text Zotero keeps in titles and other fields
// (Zotero.Utilities.Internal's formatting tags, and the small-caps form
// Zotero's BibTeX import writes), and the entities of the characters that
// would read as tags.
const ZOTERO_MARKUP = /<\/?(?:i|b|sub|sup|sc)>|<span (?:style="font-variant: ?small-caps;?"|style="small-caps"|class="nocase")>|<\/span>/g;
const ZOTERO_ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

/** A Zotero value's text, its markup set aside. */
function withoutMarkup(value: string): string {
  return value.replace(ZOTERO_MARKUP, '').replace(/&(?:amp|lt|gt|quot);/g, e => ZOTERO_ENTITIES[e]);
}

/** Text with TeX's formatting set aside, as \textit{x}, for telling
 *  whether a value push won't write is Zotero's own: the commands of
 *  formatting Zotero keeps as markup, and the groups around text.  Math,
 *  between dollar signs, is kept as written, groups and case too, since
 *  $\frac{a}{bc}$ and $\frac{ab}{c}$, or $P$ and $p$, differ; only the
 *  spellings of one formula are read as one, as Zotero's <sub>2</sub>, its
 *  export's $_{\textrm{2}}$ and $_2$.  Math is marked (MATH_OPEN,
 *  MATH_CLOSE) so looseFold leaves its case alone. */
function looseText(value: string): string {
  const FORMAT = 'textit|textbf|textsc|textrm|textup|textnormal|emph|mathrm|mathit|mathbf';
  const command = new RegExp('\\\\(?:' + FORMAT + ')\\s*\\{([^{}]*)\\}', 'g');
  const bare = new RegExp('\\\\(?:' + FORMAT + ')(?![A-Za-z])\\s*', 'g');
  const unwrap = (s: string) => {
    for (let before = ''; before !== s; ) {
      before = s;
      s = s.replace(command, (_m, x: string) => '{' + x + '}');
    }
    return s.replace(bare, '');
  };
  let text = value
    // Zotero's export spells < and > as commands, as in a nocase span.
    .replace(/\{\\textless\}|\\textless(?:\{\})?/g, '<')
    .replace(/\{\\textgreater\}|\\textgreater(?:\{\})?/g, '>')
    // Zotero's sub- and superscripts, as math writes them.
    .replace(/<sub>(.*?)<\/sub>/g, (_m, x: string) => '$_{' + x + '}$')
    .replace(/<sup>(.*?)<\/sup>/g, (_m, x: string) => '$^{' + x + '}$')
    .replace(/\\textsubscript\s*\{([^{}]*)\}/g, (_m, x: string) => '$_{' + x + '}$')
    .replace(/\\textsuperscript\s*\{([^{}]*)\}/g, (_m, x: string) => '$^{' + x + '}$');
  text = withoutMarkup(text);
  // Text and math, split at each dollar sign that isn't escaped.
  const parts = text.split(/(?<!\\)\$/);
  return parts
    .map((part, i) => {
      if (i % 2 === 0) return unwrap(part).replace(/\\([{}$&%#_])/g, (_m, c: string) => '' + c).replace(/[{}]/g, '').replace(//g, '');
      // As written, spaces and font commands too ($\sin x$ is not $\sinx$,
      // \mathbf{x} not \mathit{x}): only the \textrm Zotero's export puts
      // around a sub- or superscript is read away.
      let math = part;
      for (let before = ''; before !== math; ) {
        before = math;
        math = math.replace(/\\textrm\s*\{([^{}]*)\}/g, (_m, x: string) => '{' + x + '}');
      }
      for (let before = ''; before !== math; ) {
        before = math;
        math = math.replace(/\{\{([^{}]*)\}\}/g, (_m, x: string) => '{' + x + '}');
      }
      math = math.replace(/([_^])([^{\\])/g, (_m, s: string, x: string) => s + '{' + x + '}');
      return MATH_OPEN + math + MATH_CLOSE;
    })
    .join('');
}

const MATH_OPEN = '';
const MATH_CLOSE = '';

/** looseText's text folded as foldText does, without case where `caseless`,
 *  but its math as it is. */
function looseFold(value: string, caseless: boolean): string {
  return value
    .split(/([^]*)/)
    .map(part => (part.startsWith(MATH_OPEN) ? part : caseless ? foldText(part).toLowerCase() : foldText(part)))
    .join('');
}

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
    case 'PMID':
      return (normalizePmid(a) ?? a.trim()) === (normalizePmid(b) ?? b.trim());
    case 'url':
      return a.trim() === b.trim();
    case 'accessDate':
      // Zotero keeps a timestamp, as 2020-01-01T14:32:02Z.  A .bib that
      // gives a day means that day, so the same day is the same date; one
      // that gives a time means that time.
      return b.trim().length === 10 ? a.trim().slice(0, 10) === b.trim() : a.trim() === b.trim();
    case 'pages':
      // Dashes, and the swung dash (U+2053) Zotero's export writes as --.
      return foldText(a).replace(/[‐-―\u2053-]+/g, '-') === foldText(b).replace(/[‐-―\u2053-]+/g, '-');
    default:
      // Zotero's rich text, as <i>…</i>, is markup on the same text.
      // (Read on both sides: Zotero's export writes its &amp; as \&amp;.)
      return textForm(base, a) === textForm(base, b);
  }
}

/** The form sameValue compares a text field in (its default case), so two
 *  values are the same exactly when their forms are equal. */
function textForm(base: string, value: string): string {
  const text = foldText(withoutMarkup(value));
  return CASELESS_BASES.has(base) ? text.toLowerCase() : text;
}

function creatorText(c: ZoteroCreator): string {
  return c.name !== undefined && c.name !== '' ? c.name : [c.lastName, c.firstName].filter(Boolean).join(', ');
}

/** The entry's names, read, are Zotero's creators: the same part by part,
 *  or, for a name not in one group, its text what Zotero's export writes
 *  for the creator, as `Garcia Lopez` for a last name Garcia Lopez and no
 *  first name, which reads back otherwise. */
function sameAsExported(current: readonly ZoteroCreator[], next: readonly ZoteroCreator[], texts: ReadonlyArray<string | undefined>): boolean {
  // As written, case and all: a stored creator is kept only when the entry
  // gives it unchanged, so Mcdonald corrected to McDonald is written.
  const exact = (a: string | undefined, b: string | undefined) => foldText(a ?? '') === foldText(b ?? '');
  return (
    current.length === next.length &&
    current.every((c, i) => {
      const n = next[i];
      const oneField = (x: ZoteroCreator) => x.name !== undefined && x.name !== '';
      if (oneField(c) && oneField(n) && exact(c.name, n.name)) return true;
      if (!oneField(c) && !oneField(n) && exact(c.lastName, n.lastName) && exact(c.firstName, n.firstName)) return true;
      const text = texts[i];
      if (text === undefined || oneField(c)) return false;
      const exported = c.firstName ? (c.lastName ?? '') + ', ' + c.firstName : (c.lastName ?? '');
      return exact(exported, text);
    })
  );
}

/** Names compared part by part: a one-field name, as an organization's,
 *  is not the same as a two-field name that prints the same. */
function sameCreators(a: readonly ZoteroCreator[], b: readonly ZoteroCreator[]): boolean {
  const fold = (s: string | undefined) => foldText(s ?? '').toLowerCase();
  const key = (c: ZoteroCreator) =>
    c.name !== undefined && c.name !== '' ? 'name:' + fold(c.name) : 'person:' + fold(c.lastName) + '|' + fold(c.firstName);
  return a.length === b.length && a.every((c, i) => key(c) === key(b[i]));
}

const fold = (label: string): string => label.toLowerCase().replace(/[\s_-]/g, '');

/** The `Label: value` lines of Extra, by folded label, as Zotero and Better
 *  BibTeX read them for fields an item type lacks. */
function extraFields(item: ZoteroItemJson): Map<string, string> {
  const out = new Map<string, string>();
  const extra = typeof item.extra === 'string' ? item.extra : '';
  for (const line of extra.split(/\r?\n/)) {
    // `Label: value`, or citeproc's old `{:label:value}`, which Zotero reads
    // too (see extraMigrations).
    const m = /^([A-Za-z][\w -]*):\s*(.+)$/.exec(line.trim()) ?? /^\{:([A-Za-z][\w -]*):\s*(.+)\}$/.exec(line.trim());
    if (m && !out.has(fold(m[1]))) out.set(fold(m[1]), m[2].trim());
  }
  return out;
}

/** `value` as a list, if it is one and push reads every element of it. */
function wholeList<T>(value: unknown, readable: (v: unknown) => v is T): T[] | undefined {
  return Array.isArray(value) && value.every(readable) ? (value as T[]) : undefined;
}

function isCreator(value: unknown): value is ZoteroCreator {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  const text = (v: unknown) => v === undefined || typeof v === 'string';
  return typeof c.creatorType === 'string' && text(c.name) && text(c.firstName) && text(c.lastName) &&
    (typeof c.name === 'string' || typeof c.lastName === 'string');
}

function asCreators(value: unknown): ZoteroCreator[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is ZoteroCreator => typeof c === 'object' && c !== null && typeof (c as ZoteroCreator).creatorType === 'string');
}

/** The creators with one role's run replaced by `next`, where that role
 *  first appeared, and every other creator kept in its place. */
function replaceRole(existing: readonly ZoteroCreator[], role: string, next: readonly ZoteroCreator[]): ZoteroCreator[] {
  // As many names as before: each takes the place of the one it replaces,
  // so a translator between two authors stays between them.
  if (existing.filter(c => c.creatorType === role).length === next.length) {
    let i = 0;
    return existing.map(c => (c.creatorType === role ? next[i++] : c));
  }
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
  /** Zotero field → a value left out for its TeX or math, as looseText
   *  reads it, with its line in `notPushed`, which an update drops where
   *  Zotero's value is the same text. */
  readonly kept: Map<string, { readonly loose: string; readonly base: string; readonly line: ZoteroFieldNotPushed }>;
  readonly date?: readonly number[];
  readonly creators: Map<string, ReadCreators>;
  readonly notPushed: ZoteroFieldNotPushed[];
}

/** Whether the entry gives a full journal title, beside which `journal` is
 *  the abbreviation.  Any fjournal but an empty one says so, even one push
 *  can't write, as one in TeX: it still says what journal means. */
function hasFullJournal(entry: BibtexEntry): boolean {
  return (entry.fields.get('fjournal') ?? '').trim() !== '';
}

/** `repeated`: the fields the entry gives more than once, which are never
 *  written, since BibTeX and biber read different ones of them. */
function entryFields(entry: BibtexEntry, type: SchemaType, repeated: ReadonlySet<string>): EntryFields {
  const fields: EntryFields['fields'] = new Map();
  const kept: EntryFields['kept'] = new Map();
  const creators = new Map<string, ReadCreators>();
  const notPushed: ZoteroFieldNotPushed[] = [];
  for (const [name, mapped] of FIELD_MAP) {
    const read = readText(entry, name);
    if (read === undefined) continue;
    if (repeated.has(name)) {
      notPushed.push({ field: name, reason: 'repeated-field' });
      continue;
    }
    // With fjournal beside it, journal is the abbreviation, as Zotero's
    // BibTeX import reads the pair.
    const bases = name === 'journal' && hasFullJournal(entry) ? ['journalAbbreviation'] : mapped;
    let target: string | undefined;
    let base = '';
    for (const b of bases) {
      target = resolveField(type, b);
      if (target !== undefined) {
        base = b;
        break;
      }
    }
    if ('problem' in read) {
      const line = { field: name, reason: read.problem };
      notPushed.push(line);
      if ((read.problem === 'tex' || read.problem === 'math') && target !== undefined && !kept.has(target)) {
        // As TeX, where a command's group is still around its argument.
        // As TeX, escapes and all, where a command's group is still around
        // its argument and an escaped dollar sign is text.
        const tex = entry.texFields?.get(name) ?? bibtexFieldAsPlainText(entry, name) ?? '';
        kept.set(target, { loose: looseText(tex), base, line });
      }
      continue;
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
  const repeatedDate = ['date', 'year', 'month'].find(name => repeated.has(name));
  if (readDateResult !== undefined) {
    if (repeatedDate !== undefined) notPushed.push({ field: repeatedDate, reason: 'repeated-field' });
    else if ('problem' in readDateResult) notPushed.push({ field: 'year', reason: readDateResult.problem });
    else if (resolveField(type, 'date') === undefined) notPushed.push({ field: 'year', reason: 'no-zotero-field' });
    else date = readDateResult.parts;
  }
  for (const [field, role] of CREATOR_ROLES) {
    const read = readCreators(entry, field, role);
    if (read === undefined) continue;
    if (repeated.has(field)) notPushed.push({ field, reason: 'repeated-field' });
    else if (read === 'tex' || read === 'macro') notPushed.push({ field, reason: read });
    else if (read === 'unreadable') notPushed.push({ field, reason: 'unreadable-names' });
    else if (!type.creatorTypes.some(c => c.creatorType === role)) notPushed.push({ field, reason: 'no-creator-role' });
    else creators.set(role, read);
  }
  return { fields, kept, date, creators, notPushed };
}

// The characters of a Zotero object key (Zotero.Utilities.isValidObjectKey).
const ITEM_KEY_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';

/** The key push creates an entry's item under: the same for the same
 *  citation key in the same library on every run, so a retry names the item
 *  the first try may still be saving, and a different one in another
 *  library, so a bare key copied between libraries names nothing.  Zotero
 *  creates an item under a key it doesn't have; under a key it has, it
 *  refuses a create (version 0) unless that item is at version 0 too, and
 *  then updates it, so push creates only under a key the library doesn't
 *  hold at all (see takenKeys). */
export function pushItemKey(keySalt: string, citationKey: string): string {
  const digest = createHash('sha256').update('manuscript-markdown push\n' + keySalt + '\n' + citationKey).digest();
  let key = '';
  for (let i = 0; i < 8; i++) key += ITEM_KEY_ALPHABET[digest[i] % ITEM_KEY_ALPHABET.length];
  return key;
}

function createData(
  entry: BibtexEntry,
  itemType: string,
  type: SchemaType,
  collectionKey: string,
  repeated: ReadonlySet<string>,
  itemKey: string,
): { data: Record<string, unknown>; notPushed: ZoteroFieldNotPushed[] } {
  const read = entryFields(entry, type, repeated);
  const data: Record<string, unknown> = { itemType };
  for (const [field, { value }] of read.fields) data[field] = value;
  if (read.date !== undefined) data[resolveField(type, 'date')!] = formatDate(read.date);
  const lowerType = entry.type.toLowerCase();
  const thesisType = resolveField(type, 'type');
  if (thesisType !== undefined && data[thesisType] === undefined) {
    if (lowerType === 'phdthesis') data[thesisType] = 'PhD Thesis';
    else if (lowerType === 'mastersthesis') data[thesisType] = "Master's Thesis";
  }
  // `and others` stands for names nobody wrote down; the item gets the
  // ones given.
  data.creators = [...(read.creators.get('author')?.creators ?? []), ...(read.creators.get('editor')?.creators ?? [])];
  data.citationKey = entry.key;
  data.collections = [collectionKey];
  data.key = itemKey;
  data.version = 0;
  return { data, notPushed: read.notPushed };
}

function updateChanges(
  entry: BibtexEntry,
  item: ZoteroItemJson,
  type: SchemaType,
  repeated: ReadonlySet<string>,
): { changes: ZoteroFieldChange[]; patch: Record<string, unknown>; notPushed: ZoteroFieldNotPushed[] } {
  const read = entryFields(entry, type, repeated);
  const changes: ZoteroFieldChange[] = [];
  const patch: Record<string, unknown> = {};
  // A value left out for its TeX that is Zotero's own text, its markup and
  // math set aside, is no difference to report.
  const same = new Set<ZoteroFieldNotPushed>();
  for (const [field, { loose, base, line }] of read.kept) {
    const current = typeof item[field] === 'string' ? (item[field] as string) : '';
    const caseless = CASELESS_BASES.has(baseOf(type, field) || base);
    if (current !== '' && looseFold(looseText(current), caseless) === looseFold(loose, caseless)) same.add(line);
  }
  const notPushed = read.notPushed.filter(line => !same.has(line));
  const extra = extraFields(item);
  for (const [field, { value, base, from }] of read.fields) {
    const current = typeof item[field] === 'string' ? (item[field] as string) : '';
    // A value Zotero keeps as a line of Extra, as `Series: …`, is the one
    // its exports read for the field, so the entry already says it.
    const inExtra = current === '' ? [field, base, from].map(label => extra.get(fold(label))).find(v => v !== undefined) : undefined;
    const compared = current !== '' ? current : inExtra;
    if (compared !== undefined && sameValue(baseOf(type, field) || base, compared, value)) continue;
    // Zotero's export can give the abbreviation as `journal`
    // (useJournalAbbreviation in BibTeX.js), so a lone journal that is
    // Zotero's abbreviation says nothing new about the full title.
    const abbreviation = item.journalAbbreviation;
    if (from === 'journal' && typeof abbreviation === 'string' && abbreviation !== '' && sameValue('journalAbbreviation', abbreviation, value)) continue;
    // …and a different one may be either, where Zotero has both.
    if (from === 'journal' && !hasFullJournal(entry) && typeof abbreviation === 'string' && abbreviation !== '' && current !== '') {
      notPushed.push({ field: from, reason: 'ambiguous-journal' });
      continue;
    }
    changes.push({ field, from: current, to: value });
    patch[field] = value;
  }
  if (read.date !== undefined) {
    const field = resolveField(type, 'date')!;
    const current = typeof item[field] === 'string' ? (item[field] as string) : '';
    const zParts = zoteroDateParts(item);
    // Equal when the entry's parts agree with Zotero's as far as the entry
    // goes.  A free-text date Zotero can't read has no parts, so a readable
    // date from the entry replaces it.
    if (zParts === undefined || !read.date.every((p, i) => zParts[i] === p)) {
      const to = formatDate(read.date);
      changes.push({ field, from: current, to });
      patch[field] = to;
    }
  }
  const existing = asCreators(item.creators);
  let creators = existing;
  let regrouped = false;
  for (const [role, { creators: next, texts, incomplete }] of read.creators) {
    const current = existing.filter(c => c.creatorType === role);
    if (incomplete) {
      // `and others` gives only the start of the list: it agrees when the
      // names given are Zotero's first ones, and otherwise can't say what
      // the whole list should be.
      if (!sameCreators(current.slice(0, next.length), next)) notPushed.push({ field: role, reason: 'incomplete-names' });
      continue;
    }
    // Zotero's export lists series editors in `editor` with the editors, in
    // their order, so an editor list can't say which are which.
    if (role === 'editor' && existing.some(c => c.creatorType === 'seriesEditor')) {
      const exported = existing.filter(c => c.creatorType === 'editor' || c.creatorType === 'seriesEditor');
      if (!sameAsExported(exported, next, texts)) notPushed.push({ field: role, reason: 'series-editors' });
      continue;
    }
    // Each stored creator whose name the entry gives as Zotero's export
    // writes it stays as stored, so correcting one coauthor rewrites no
    // other.
    // A list the entry gives name for name as Zotero's export writes the
    // stored one is no change, even where two creators export alike.
    if (sameAsExported(current, next, texts)) continue;
    // Not where two of the role's creators export the same text, as a
    // surname-only "Reed, Ann" and Ann Reed: which one the entry kept is
    // then unclear, so it gives its own reading, as before.
    const exportedText = (c: ZoteroCreator) =>
      c.name !== undefined && c.name !== '' ? '{' + c.name + '}' : c.firstName ? (c.lastName ?? '') + ', ' + c.firstName : (c.lastName ?? '');
    const twins = new Set(current.map(exportedText).filter((t, i, all) => all.indexOf(t) !== i));
    const byIndex = next.map((n, i) =>
      i < current.length && !twins.has(exportedText(current[i])) && sameAsExported([current[i]], [n], [texts[i]]) ? current[i] : n,
    );
    if (sameCreators(current, byIndex)) continue;
    const merged = keptWhereMoved(current, next, texts, byIndex, exportedText, twins);
    changes.push({
      field: 'creators:' + role,
      from: current.map(creatorText).join('; '),
      to: merged.map(creatorText).join('; '),
    });
    // A role whose number of names changes is written as one run where it
    // first appeared (replaceRole), so a creator of another role between
    // two of its names moves after them.
    const at = creators.flatMap((c, i) => (c.creatorType === role ? [i] : []));
    if (at.length !== merged.length && at.length > 0 && at[at.length - 1] - at[0] + 1 !== at.length) regrouped = true;
    creators = replaceRole(creators, role, merged);
  }
  if (creators !== existing) patch.creators = creators;
  // The role lines don't show that move, so a line for the whole list does.
  if (regrouped) {
    const listed = (list: readonly ZoteroCreator[]) => list.map(c => c.creatorType + ' ' + creatorText(c)).join('; ');
    changes.push({ field: 'creators', from: listed(existing), to: listed(creators) });
  }
  return { changes, patch, notPushed };
}

/** The role's names as written: `byIndex`, where a stored creator the entry
 *  gives at its own place stays as stored, and besides, a stored creator
 *  the entry moves stays as stored too, so moving `Garcia Lopez` (a last
 *  name with no first name) keeps it one last name.  A stored creator is
 *  kept where the entry gives its exported text once and no other creator
 *  of the role exports that text.  Where two do (twins, as a surname-only
 *  `Reed, Ann` and Ann Reed), only a list with every stored creator in
 *  some order keeps them, each twin in its stored order; otherwise, as
 *  for a deletion among twins, which can't be told apart, the entry's own
 *  reading is written. */
function keptWhereMoved(
  current: readonly ZoteroCreator[],
  next: readonly ZoteroCreator[],
  texts: ReadonlyArray<string | undefined>,
  byIndex: readonly ZoteroCreator[],
  exportedText: (c: ZoteroCreator) => string,
  twins: ReadonlySet<string>,
): ZoteroCreator[] {
  // Stored creators by exported text, so each name looks only at the
  // creators it could be (sameAsExported needs the same text, part by
  // part or as exported).
  const key = (text: string) => foldText(text);
  const byText = new Map<string, number[]>();
  current.forEach((c, j) => {
    const k = key(exportedText(c));
    byText.set(k, [...(byText.get(k) ?? []), j]);
  });
  const candidates = next.map((n, i) => {
    const out = new Set<number>([...(byText.get(key(exportedText(n))) ?? []), ...(texts[i] === undefined ? [] : (byText.get(key(texts[i] ?? '')) ?? []))]);
    return [...out].sort((a, b) => a - b).filter(j => sameAsExported([current[j]], [n], [texts[i]]));
  });
  // Every stored creator, in some order: a name kept at its own place
  // keeps it, and each other name takes the first unused creator it could
  // be, so twins keep their stored order.
  if (next.length === current.length) {
    const used = new Set<number>(byIndex.flatMap((c, i) => (c === next[i] ? [] : [i])));
    const assigned: ZoteroCreator[] = [];
    for (let i = 0; i < next.length; i++) {
      const j = byIndex[i] !== next[i] ? i : candidates[i].find(c => !used.has(c));
      if (j === undefined) break;
      used.add(j);
      assigned.push(current[j]);
    }
    if (assigned.length === next.length) return assigned;
  }
  const uses = new Map<number, number>();
  for (const list of candidates) for (const j of list) uses.set(j, (uses.get(j) ?? 0) + 1);
  return byIndex.map((c, i) => {
    if (c !== next[i]) return c;
    const only = candidates[i].filter(j => !twins.has(exportedText(current[j])));
    return only.length === 1 && candidates[i].length === 1 && uses.get(only[0]) === 1 ? current[only[0]] : c;
  });
}

/** The item's PMID, as the matcher reads one: its PMID field, or a `PMID:`
 *  line of Extra. */
function effectivePmid(item: ZoteroItemJson): string | undefined {
  return normalizePmid(typeof item.PMID === 'string' ? item.PMID : undefined) ?? normalizePmid(extraFields(item).get('pmid'));
}

/** An ISBN as its ISBN-13, so an ISBN-10 and the ISBN-13 of the same
 *  edition compare equal.  (The matcher compares them as written; see
 *  normalizeIsbns.) */
function isbn13(compact: string): string {
  // Only a real ISBN-10, its check digit right: one with a wrong digit
  // names no ISBN-13 for sure.
  if (compact.length !== 10 || !validIsbn10(compact)) return compact;
  const body = '978' + compact.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

function validIsbn10(compact: string): boolean {
  if (!/^\d{9}[\dX]$/.test(compact)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (compact[i] === 'X' ? 10 : Number(compact[i])) * (10 - i);
  return sum % 11 === 0;
}

function isbnsOf(value: unknown): string[] {
  return typeof value === 'string' ? normalizeIsbns(value).map(isbn13) : [];
}

/** Every value of Extra's lines with this folded label, in either form
 *  Zotero reads, where extraFields gives only the first. */
function extraValues(item: ZoteroItemJson, label: string): string[] {
  const extra = typeof item.extra === 'string' ? item.extra : '';
  const out: string[] = [];
  for (const line of extra.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w -]*):\s*(.+)$/.exec(line.trim()) ?? /^\{:([A-Za-z][\w -]*):\s*(.+)\}$/.exec(line.trim());
    if (m && fold(m[1]) === label) out.push(m[2].trim());
  }
  return out;
}

/** The key Zotero's BibTeX export gives an item from Extra: the first line
 *  labelled exactly `Citation Key`, in any case (buildCiteKey and
 *  parseExtraFields in BibTeX.js), so not `CitationKey:`. */
function extraCitationKey(item: ZoteroItemJson): string | undefined {
  const extra = typeof item.extra === 'string' ? item.extra : '';
  for (const raw of extra.split(/[\r\n]+/)) {
    const line = raw.trim();
    const at = line.indexOf(':');
    if (at > 1 && line.slice(0, at).trim().toLowerCase() === 'citation key') {
      const value = line.slice(at + 1).trim();
      if (value !== '') return value;
    }
  }
  return undefined;
}

// The words Zotero's export leaves out of a title's first word for a key
// (citeKeyTitleBannedRe in BibTeX.js).
const KEY_TITLE_BANNED =
  /\b(a|an|the|some|from|on|in|to|of|do|with|der|die|das|ein|eine|einer|eines|einem|einen|un|une|la|le|l'|les|el|las|los|al|uno|una|unos|unas|de|des|del|d')(\s+|\b)|(<\/?(i|b|sup|sub|sc|span style="small-caps"|span)>)/g;

/** The key Zotero's BibTeX export makes for an item with none stored, as
 *  its default format, %a_%t_%y, does (buildCiteKey in BibTeX.js): the
 *  first creator's last name, the title's first word that isn't an
 *  article or preposition, and the year.  Followed closely, not exactly
 *  (Zotero's diacritics and date reading are its own), so push uses it only
 *  to hold back, never to write. */
// Letters Zotero's export reduces (its removeDiacritics) that Unicode
// decomposition leaves as they are.
const KEY_LETTERS: Readonly<Record<string, string>> = { ø: 'o', œ: 'oe', æ: 'ae', ß: 's', ł: 'l', đ: 'd', ı: 'i' };

/** The year in the key, as Zotero reads it from the date (strToDate): a
 *  year alone keeps its era and loses its leading zeros (0044 is 44, 200
 *  BCE is 200 BCE); otherwise the parsed date's year. */
function keyYear(item: ZoteroItemJson): string {
  const date = typeof item.date === 'string' ? item.date.trim() : '';
  const alone = /^0*(\d{1,4})\s*((?:B\.?\s?C\.?(?:\s?E\.?)?|C\.?\s?E\.?|A\.?\s?D\.?))?$/i.exec(date);
  if (alone) return String(Number(alone[1])) + (alone[2] ? ' ' + alone[2] : '');
  const parsed = /^(\d{4})/.exec(item.parsedDate ?? '')?.[1] ?? /\b(\d{4})\b/.exec(date)?.[1];
  return parsed === undefined || parsed === '0000' ? 'nodate' : String(Number(parsed));
}

function generatedCitationKey(item: ZoteroItemJson): string {
  const first = asCreators(item.creators)[0];
  const last = first?.lastName || first?.name;
  const author = last ? last.toLowerCase().replace(/ /g, '_').replace(/,/g, '') : 'noauthor';
  const title = typeof item.title === 'string' && item.title !== '' ? item.title.toLowerCase().replace(KEY_TITLE_BANNED, '').split(/\s+/g)[0] : 'notitle';
  const base = (author + '_' + title + '_' + keyYear(item))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øœæßłđı]/g, c => KEY_LETTERS[c]);
  const added = typeof item.dateAdded === 'string' ? Number(item.dateAdded.slice(0, 4)) : NaN;
  return base.replace(added >= 2020 ? /[^a-z0-9_-]/g : /[^a-z0-9!$&*+\-./:;<>?[\]^_`|]+/g, '');
}

type KeyClaim = { readonly item: string; readonly source: 'field' | 'extra' | 'generated' };

/** The library's items with no citation key stored (field or Extra) and a
 *  title, grouped by each form sameWorkWithoutKey compares a title in, in
 *  library order.  Built once a plan: a group holds exactly the items whose
 *  title compares equal in that form, so looking one up finds every item
 *  the comparison would accept, and the plan stays linear in the library. */
type KeylessTitles = {
  readonly byForm: ReadonlyMap<string, readonly ZoteroItemJson[]>;
  readonly byLoose: ReadonlyMap<string, readonly ZoteroItemJson[]>;
};

function keylessTitles(items: Iterable<ZoteroItemJson>): KeylessTitles {
  const byForm = new Map<string, ZoteroItemJson[]>();
  const byLoose = new Map<string, ZoteroItemJson[]>();
  const add = (map: Map<string, ZoteroItemJson[]>, key: string, item: ZoteroItemJson) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [item]);
    else list.push(item);
  };
  for (const item of items) {
    if ((typeof item.citationKey === 'string' && item.citationKey.trim() !== '') || extraCitationKey(item) !== undefined) continue;
    if (typeof item.title !== 'string') continue;
    add(byForm, textForm('title', item.title), item);
    add(byLoose, looseFold(looseText(item.title), true), item);
  }
  return { byForm, byLoose };
}

/** An item with no citation key stored, Zotero's export of which would
 *  make a key from its metadata, whose title and creators are the entry's
 *  and whose year, where both give one, is too.  Never the item `except`. */
function sameWorkWithoutKey(entry: BibtexEntry, keyless: KeylessTitles, except?: string): string | undefined {
  const title = readText(entry, 'title');
  if (title === undefined) return undefined;
  // A title push can't write is compared as its text with formatting set
  // aside, so it can only hold an entry back.  (sameValue('title', …) is
  // equality of textForm, so the group is the items it would accept.)
  const items =
    ('value' in title
      ? keyless.byForm.get(textForm('title', title.value))
      : keyless.byLoose.get(looseFold(looseText(entry.texFields?.get('title') ?? entry.fields.get('title') ?? ''), true))) ?? [];
  // Each role's names as the entry writes them, against the creators
  // Zotero's export writes in that field: its primary creators in author,
  // its editors and series editors in editor.  A list push can't read
  // counts as the same, so it holds the entry back rather than let it by.
  const roles = (['author', 'editor'] as const).map(role => ({ role, read: readCreators(entry, role, role) }));
  const sameNames = (item: ZoteroItemJson) =>
    roles.every(({ role, read }) => {
      const stored = asCreators(item.creators).filter(c =>
        role === 'author' ? c.creatorType === 'author' : c.creatorType === 'editor' || c.creatorType === 'seriesEditor',
      );
      if (read === undefined) return stored.length === 0;
      if (typeof read !== 'object') return true;
      const given = read.incomplete ? stored.slice(0, read.creators.length) : stored;
      return given.length === read.creators.length && given.every((c, i) => sameAsExported([c], [read.creators[i]], [read.texts[i]]) || sameCreators([c], [read.creators[i]]));
    });
  const allNames = roles.flatMap(({ read }) => (typeof read === 'object' ? read.creators : []));
  const date = readDate(entry);
  const year = date !== undefined && 'parts' in date ? date.parts[0] : undefined;
  for (const item of items) {
    if (item.key === except) continue;
    // (Or all its names in one list as the entry's, as before.)
    if (!sameNames(item) && !sameCreators(asCreators(item.creators), allNames)) continue;
    const itemYear = zoteroDateParts(item)?.[0];
    if (year !== undefined && itemYear !== undefined && itemYear !== 0 && year !== itemYear) continue;
    return item.key;
  }
  return undefined;
}

/** Who answers to each citation key: an item by its Citation Key field,
 *  by Extra's `Citation Key:` line (which Zotero's export prefers), and,
 *  with neither, by the key Zotero's export makes for it, where items that
 *  make the same one each answer to it and its numbered forms. */
function citationKeyClaims(items: Iterable<ZoteroItemJson>): Map<string, KeyClaim[]> {
  const claims = new Map<string, KeyClaim[]>();
  const add = (key: string, claim: KeyClaim) => {
    const list = claims.get(key) ?? [];
    if (!list.some(c => c.item === claim.item)) claims.set(key, [...list, claim]);
  };
  const generated = new Map<string, string[]>();
  for (const item of items) {
    const field = typeof item.citationKey === 'string' ? item.citationKey.trim() : '';
    const extra = extraCitationKey(item);
    if (field !== '') add(field, { item: item.key, source: 'field' });
    if (extra !== undefined) add(extra, { item: item.key, source: 'extra' });
    if (field === '' && extra === undefined) {
      const base = generatedCitationKey(item);
      generated.set(base, [...(generated.get(base) ?? []), item.key]);
    }
  }
  // The export numbers repeats (base, base-1, …) in an order push can't
  // know, so each such item answers to all of them.
  // One list for the group, shared by its keys, not one each.
  for (const [base, keys] of generated) {
    const group: KeyClaim[] = keys.map(item => ({ item, source: 'generated' }));
    for (let i = 0; i < keys.length; i++) {
      const key = i === 0 ? base : base + '-' + i;
      const stored = claims.get(key);
      claims.set(key, stored === undefined ? group : [...stored, ...group.filter(g => !stored.some(c => c.item === g.item))]);
    }
  }
  return claims;
}

/** The item's DOI as the link planner reads it: its DOI field, or a
 *  `DOI:` line of Extra. */
function effectiveDoi(item: ZoteroItemJson): string | undefined {
  return validDoi(typeof item.DOI === 'string' ? item.DOI : undefined) ?? validDoi(extraFields(item).get('doi'));
}

/** The labels of the Extra lines Zotero would act on when the item is next
 *  saved through the Local API, which reads items non-strictly
 *  (`Item.fromJSON`, `extractExtraFields`): a line naming one of the type's
 *  fields, or a CSL variable for one, moves into it when the item leaves it
 *  empty; a line reaching a field through a base field is flagged whatever
 *  the field holds (see `migrates`); and a `Type:` line naming a type
 *  changes the item's type or is dropped.  Read conservatively: a line this flags that Zotero would
 *  leave only costs a skipped item. */
function extraMigrations(item: ZoteroItemJson, type: SchemaType, schema: ZoteroItemSchema): string[] {
  const extra = typeof item.extra === 'string' ? item.extra : '';
  if (extra === '') return [];
  const candidates = new Map<string, string[]>();
  const add = (label: string, fields: readonly string[]) =>
    candidates.set(fold(label), [...(candidates.get(fold(label)) ?? []), ...fields]);
  for (const t of schema.itemTypes) for (const f of t.fields) add(f.field, [f.field]);
  for (const [variable, mapped] of Object.entries(schema.csl?.fields?.text ?? {})) add(variable, mapped);
  for (const [variable, mapped] of Object.entries(schema.csl?.fields?.date ?? {})) add(variable, [mapped]);
  // (Creator lines stay: Zotero's save excludes them from the move.)
  // A label that names one of the type's fields, itself or as a CSL
  // variable (`Issued:` for date), moves into it only when it's empty; one
  // that reaches a type's field through a base field, as `Publisher:` a
  // report's institution, is matched by Zotero against a name the item
  // doesn't list, so it counts whatever the item holds.
  const migrates = (label: string, field: string) =>
    type.fields.some(tf =>
      tf.field === field ? typeof item[tf.field] !== 'string' || item[tf.field] === '' : tf.baseField === field,
    );
  // Zotero looks type names up as written.
  const typeNames = new Set([...schema.itemTypes.map(t => t.itemType), ...Object.keys(schema.csl?.types ?? {})]);
  const labels: string[] = [];
  for (const line of extra.split(/\n/)) {
    // Zotero reads both `Label: value` and citeproc's old `{:label:value}`.
    const m = /^([a-z][a-z -_]+):(.+)/i.exec(line) ?? /^{:([a-z -_]+):(.+)}/i.exec(line);
    if (!m || m[2].trim() === '') continue;
    const key = fold(m[1]);
    const value = m[2].trim();
    if (key === 'type') {
      // Zotero acts on any line naming a type, its own included: it
      // changes the item to it, or drops the line.
      if (typeNames.has(value) && !['note', 'attachment', 'annotation', 'article'].includes(value)) labels.push(m[1]);
      continue;
    }
    if ((candidates.get(key) ?? []).some(field => migrates(key, field))) labels.push(m[1]);
  }
  return labels;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

type Candidate =
  | {
      readonly kind: 'match';
      readonly entryKey: string;
      readonly entry: BibtexEntry;
      readonly item: ZoteroItemJson;
      readonly repeated: ReadonlySet<string>;
      /** For a match by DOI, PMID or ISBN: the keyless item that has the
       *  entry's title and names too, if one does (see plain-match-elsewhere). */
      readonly plainElsewhere?: string;
    }
  | { readonly kind: 'create'; readonly entryKey: string; readonly entry: BibtexEntry; readonly repeated: ReadonlySet<string> }
  | Extract<ZoteroPushAction, { kind: 'skip' }>;

/** Entry types for a whole work, which an ISBN can identify, and Zotero
 *  item types for a part of one, which shares the work's ISBN. */
const WHOLE_WORK_TYPES: ReadonlySet<string> = new Set([
  'book', 'booklet', 'manual', 'proceedings', 'mvbook', 'collection', 'mvcollection',
  'techreport', 'report', 'phdthesis', 'mastersthesis', 'thesis', 'reference', 'mvreference', 'periodical',
]);
const COMPONENT_ITEM_TYPES: ReadonlySet<string> = new Set(['bookSection', 'conferencePaper', 'encyclopediaArticle', 'dictionaryEntry']);

/** Identifier fields the link planner matches on.  Written with TeX it
 *  doesn't read, as \url{…}, the planner and push would read different
 *  values, so the entry is left alone. */
const MATCHED_IDENTIFIERS: ReadonlyArray<string> = ['doi', 'isbn', 'pmid', 'url'];

/** The Zotero item type an entry type stands for, where an ISBN is
 *  compared: a book's for the whole-work types push has no type of its own
 *  for, as @mvbook. */
function isbnItemType(entryType: string): string {
  return ITEM_TYPE_BY_ENTRY_TYPE[entryType.toLowerCase()] ?? 'book';
}

export function createZoteroPushPlan(input: ZoteroPushInput): ZoteroPushPlan {
  const { parsed, ranges } = parseBibtexWithRaw(input.bibText);
  // The fields each entry gives more than once.  (A key given twice is the
  // link planner's conflict, so the last range for a key is the entry's.)
  const repeatedByKey = new Map(ranges.map(r => [r.key, new Set(r.repeatedFields ?? [])]));
  const skip = (entryKey: string, reason: ZoteroPushSkipReason, detail = ''): Candidate =>
    ({ kind: 'skip', entryKey, reason, detail });

  // Which items hold each DOI, so no write gives one to a second item.
  const doiOwners = new Map<string, string[]>();
  const pmidOwners = new Map<string, string[]>();
  // …and each whole work's ISBN (a chapter shares its book's), and each
  // citation key, from either place an item keeps one.
  const isbnOwners = new Map<string, string[]>();
  const keyClaims = citationKeyClaims(input.items.values());
  // Built on first use, once a plan (see KeylessTitles).
  let keylessCache: KeylessTitles | undefined;
  const keyless = () => (keylessCache ??= keylessTitles(input.items.values()));

  const own = (owners: Map<string, string[]>, value: string, key: string) => {
    const list = owners.get(value) ?? [];
    if (!list.includes(key)) owners.set(value, [...list, key]);
  };
  for (const item of input.items.values()) {
    // Every DOI and PMID it holds, in its field and in Extra, though the
    // field is the one compared.
    // (Every line of Extra: a second DOI line is the item's as much as the
    // first.)
    for (const doi of [typeof item.DOI === 'string' ? item.DOI : undefined, ...extraValues(item, 'doi')].map(validDoi)) {
      if (doi !== undefined) own(doiOwners, doi, item.key);
    }
    for (const pmid of [typeof item.PMID === 'string' ? item.PMID : undefined, ...extraValues(item, 'pmid')].map(normalizePmid)) {
      if (pmid !== undefined) own(pmidOwners, pmid, item.key);
    }
    if (!COMPONENT_ITEM_TYPES.has(item.itemType)) {
      for (const isbn of [item.ISBN, ...extraValues(item, 'isbn')].flatMap(isbnsOf)) own(isbnOwners, isbn, item.key);
    }
  }
  // The whole-work ISBNs the entry gives, as ISBN-13s.
  const entryIsbns = (entry: BibtexEntry, anyType = false): string[] =>
    (anyType || WHOLE_WORK_TYPES.has(entry.type.toLowerCase())) && readText(entry, 'isbn') !== undefined ? isbnsOf(entry.fields.get('isbn')) : [];
  // Whose an entry's ISBN is, besides the item it matched.  An ISBN that
  // item holds too is no evidence against it, as a set's ISBN on each of
  // its volumes; and a chapter's ISBN counts against a whole work it
  // matched, since writing it would give that book another's ISBN.
  const isbnElsewhere = (entry: BibtexEntry, item?: ZoteroItemJson): string[] => {
    const held = item === undefined ? [] : [item.ISBN, ...extraValues(item, 'isbn')].flatMap(isbnsOf);
    const anyType = item !== undefined && !COMPONENT_ITEM_TYPES.has(item.itemType);
    return [
      ...new Set(
        entryIsbns(entry, anyType)
          .filter(isbn => !held.includes(isbn))
          .flatMap(isbn => (isbnOwners.get(isbn) ?? []).filter(k => k !== item?.key)),
      ),
    ];
  };
  // The DOI the entry would write, read as its field is.
  const entryDoi = (entry: BibtexEntry): string | undefined => {
    const read = readText(entry, 'doi');
    return read !== undefined && 'value' in read ? validDoi(read.value) : undefined;
  };

  // An entry whose key only one item's Extra line gives is never taken for
  // that item: the key Zotero's export makes for an item with none stored
  // (generatedCitationKey) is followed closely, not exactly, so another
  // item may answer to it unseen.  It is reported instead (see the
  // unmatched case below).
  const decisions = input.decisions;

  // First pass: what each entry is, on its own.
  const candidates: Candidate[] = decisions.map((decision): Candidate => {
    const entryKey = decision.entry.key;
    const entry = parsed.get(entryKey);
    // As written: the parser reads some TeX away, as \url{} around a PMID,
    // which the matcher doesn't.
    const texIdentifier = MATCHED_IDENTIFIERS.find(name =>
      [entry?.writtenFields?.get(name), entry?.fields.get(name)].some(v => /\\[A-Za-z]/.test(v ?? '')),
    );
    if (texIdentifier !== undefined && decision.outcome !== 'conflict') {
      return skip(entryKey, 'unreadable-identifier', texIdentifier);
    }
    switch (decision.outcome) {
      case 'conflict':
        return skip(entryKey, 'conflict', decision.reason);
      case 'ambiguous':
        return skip(entryKey, 'ambiguous', decision.candidates.map(c => c.key).join(', '));
      case 'unmatched': {
        if (entry === undefined) return skip(entryKey, 'conflict', 'entry-not-editable');
        const doi = entryDoi(entry);
        const owners = doi === undefined ? [] : (doiOwners.get(doi) ?? []);
        if (owners.length > 0) return skip(entryKey, 'doi-owned-elsewhere', owners.join(', '));
        // An identifier the matcher doesn't find, as a `Citation Key:` line
        // of Extra behind another key, or the ISBN-10 of an ISBN-13, still
        // names an item the library has, so creating one would copy it.
        const claims = keyClaims.get(entryKey) ?? [];
        if (claims.length > 1) return skip(entryKey, 'citation-key-conflict', claims.map(c => c.item).join(', '));
        // A key the export makes for an item with none stored only
        // suggests it: Zotero's own reading may differ.
        if (claims.length === 1 && claims[0].source === 'generated') return skip(entryKey, 'generated-key', claims[0].item);
        if (claims.length === 1 && claims[0].source === 'extra') return skip(entryKey, 'extra-key-only', claims[0].item);
        if (claims.length === 1) return skip(entryKey, 'citation-key-conflict', claims[0].item);
        // Nor does a create depend on that key being Zotero's exactly: an
        // item with no key stored and the entry's title and names, and no
        // year against it, may be this entry's.
        const lookalike = sameWorkWithoutKey(entry, keyless());
        if (lookalike !== undefined) return skip(entryKey, 'possible-existing', lookalike);
        const isbnClaims = isbnElsewhere(entry);
        if (isbnClaims.length > 0) return skip(entryKey, 'isbn-owned-elsewhere', isbnClaims.join(', '));
        const pmidRead = readText(entry, 'pmid');
        const pmidClaims = pmidRead !== undefined && 'value' in pmidRead ? (pmidOwners.get(pmidRead.value) ?? []) : [];
        if (pmidClaims.length > 0) return skip(entryKey, 'pmid-disagreement', pmidClaims.join(', '));
        return { kind: 'create', entryKey, entry, repeated: repeatedByKey.get(entryKey) ?? new Set() };
      }
      case 'update':
      case 'preserve': {
        if (decision.outcome === 'update' && !STRONG_TIERS.has(decision.tier)) {
          return skip(entryKey, 'weak-match', decision.target.key);
        }
        // A stored link names its library as well as its key, and keys are
        // unique only within a library: the item must be this library's.
        const item = input.items.get(decision.target.key);
        const sameUri = (a: string, b: string) => a.replace(/^https?:\/\//, '') === b.replace(/^https?:\/\//, '');
        if (item === undefined || (item.uri !== undefined && !sameUri(item.uri, decision.target.uri))) {
          return skip(entryKey, 'other-library', decision.target.uri || decision.target.key);
        }
        if (entry === undefined) return skip(entryKey, 'conflict', 'entry-not-editable');
        // An ISBN names a book, and a chapter or paper in it shares it, so
        // it identifies only a whole work, on both sides.
        // And it names one kind of work: a book's ISBN on an audio
        // recording is the recording's, not the book's.
        if (
          decision.outcome === 'update' &&
          decision.tier === 'isbn-pmid' &&
          !decision.evidence.includes('pmid') &&
          (!WHOLE_WORK_TYPES.has(entry.type.toLowerCase()) ||
            COMPONENT_ITEM_TYPES.has(item.itemType) ||
            item.itemType !== isbnItemType(entry.type))
        ) {
          return skip(entryKey, 'weak-match', decision.target.key + ', by ISBN only');
        }
        // A citation key that another item claims too, as Zotero's export
        // gives an item the key in its Extra over its own field, names
        // neither for sure.  (A stored identity names its item outright.)
        if (decision.outcome === 'update' && decision.tier !== 'existing') {
          const others = (keyClaims.get(entryKey) ?? []).map(c => c.item).filter(k => k !== item.key);
          if (others.length > 0) return skip(entryKey, 'citation-key-conflict', [item.key, ...others].join(', '));
        }
        // A citation-key match on one item, where another item with no key
        // stored has the entry's title and names: that one may be the
        // entry's, as Zotero's export of it would make this key, which push
        // can't always tell (generatedCitationKey).  Both are named.
        if (decision.outcome === 'update' && decision.tier === 'citation-key') {
          const plain = sameWorkWithoutKey(entry, keyless(), item.key);
          if (plain !== undefined) return skip(entryKey, 'plain-match-elsewhere', item.key + ' and ' + plain);
        }
        if (decision.outcome === 'update' && decision.tier !== 'existing') {
          // The library holds the key push would have created this entry's
          // item under, and not on this item: push made that one for the
          // citation key, which has since moved to this one.
          const pushed = pushItemKey(input.keySalt, entryKey);
          if (pushed !== item.key && input.takenKeys.has(pushed)) {
            return skip(entryKey, 'citation-key-moved', pushed + ' and ' + item.key);
          }
        }
        // A DOI match is only as good as the DOI: the matcher compares
        // values, shaped like DOIs or not.
        if (decision.outcome === 'update' && decision.tier === 'doi' && entryDoi(entry) === undefined) {
          return skip(entryKey, 'weak-match', decision.target.key + ', by a value that is not a DOI');
        }
        const doi = entryDoi(entry);
        const itemDoi = effectiveDoi(item);
        if (doi !== undefined && itemDoi !== undefined && doi !== itemDoi) {
          return skip(entryKey, 'identity-disagreement', item.key);
        }
        const elsewhere = doi === undefined ? [] : (doiOwners.get(doi) ?? []).filter(k => k !== item.key);
        if (elsewhere.length > 0) return skip(entryKey, 'doi-owned-elsewhere', elsewhere.join(', '));
        // The same for a PMID, which the matcher reads after a citation key.
        const pmidRead = readText(entry, 'pmid');
        const pmid = pmidRead !== undefined && 'value' in pmidRead ? pmidRead.value : undefined;
        const itemPmid = effectivePmid(item);
        const pmidElsewhere = pmid === undefined ? [] : (pmidOwners.get(pmid) ?? []).filter(k => k !== item.key);
        if (pmid !== undefined && ((itemPmid !== undefined && itemPmid !== pmid) || pmidElsewhere.length > 0)) {
          return skip(entryKey, 'pmid-disagreement', [item.key, ...pmidElsewhere].join(', '));
        }
        // …and for a whole work's ISBN.
        const isbnClaims = isbnElsewhere(entry, item);
        if (isbnClaims.length > 0) return skip(entryKey, 'isbn-owned-elsewhere', isbnClaims.join(', '));
        // The same for a match by DOI, PMID or ISBN: an edited DOI can name
        // another work with the same title, while the entry's own item has
        // no key stored.  Skipped last (see below), so the other skips keep
        // their reasons.
        const plainElsewhere =
          decision.outcome === 'update' && (decision.tier === 'doi' || decision.tier === 'isbn-pmid')
            ? sameWorkWithoutKey(entry, keyless(), item.key)
            : undefined;
        return { kind: 'match', entryKey, entry, item, repeated: repeatedByKey.get(entryKey) ?? new Set(), plainElsewhere };
      }
    }
  });

  // Second pass: entries that would collide with each other.  Every entry
  // claims the identifiers it gives, DOI, PMID and a whole work's ISBN, as
  // written, and the item it names, whether or not it is written or skipped
  // for another reason: a skipped entry still names that work, so another
  // entry can't take its identifier or its item.  (An identifier the named
  // item has already gives it nothing, as a set's ISBN on each volume.)
  const claimsOf = (decision: ZoteroLinkDecision): string[] => {
    const entry = parsed.get(decision.entry.key);
    if (entry === undefined) return [];
    const target = decision.outcome === 'update' || decision.outcome === 'preserve' ? input.items.get(decision.target.key) : undefined;
    const holds = (owners: ReadonlyMap<string, string[]>, id: string) => target !== undefined && (owners.get(id) ?? []).includes(target.key);
    const ids: string[] = [];
    const doi = entryDoi(entry);
    if (doi !== undefined && !holds(doiOwners, doi)) ids.push('DOI ' + doi);
    const pmid = readText(entry, 'pmid');
    if (pmid !== undefined && 'value' in pmid && !holds(pmidOwners, pmid.value)) ids.push('PMID ' + pmid.value);
    // A whole work's ISBN, as a chapter's entry would give its book's; a
    // part shares its book's.
    const held = target === undefined ? [] : [target.ISBN, ...extraValues(target, 'isbn')].flatMap(isbnsOf);
    const anyType = target !== undefined && !COMPONENT_ITEM_TYPES.has(target.itemType);
    for (const isbn of entryIsbns(entry, anyType)) if (!held.includes(isbn)) ids.push('ISBN ' + isbn);
    return [...new Set(ids)];
  };
  const claims = decisions.map(claimsOf);
  const named = decisions.map(d => (d.outcome === 'update' || d.outcome === 'preserve' ? d.target.key : undefined));
  const given = new Map<string, number>();
  for (const ids of claims) for (const id of ids) given.set(id, (given.get(id) ?? 0) + 1);
  const targets = new Map<string, number>();
  for (const key of named) if (key !== undefined) targets.set(key, (targets.get(key) ?? 0) + 1);

  // The key each create would take, and what holds a key already, for the
  // report.
  const createKeys = new Map<string, string[]>();
  for (const c of candidates) {
    if (c.kind !== 'create') continue;
    const key = pushItemKey(input.keySalt, c.entryKey);
    createKeys.set(key, [...(createKeys.get(key) ?? []), c.entryKey]);
  }
  const describeKey = (itemKey: string, sharer?: string): string => {
    if (sharer !== undefined) return itemKey + ', which entry ' + sharer + ' would get too';
    const holder = input.items.get(itemKey);
    if (holder === undefined) return itemKey + ", held by an item in Zotero's trash, or a note or attachment";
    return typeof holder.citationKey === 'string' && holder.citationKey !== ''
      ? itemKey + ', held by the item with citation key ' + holder.citationKey
      : itemKey + ', held by an item with no citation key';
  };

  const actions: ZoteroPushAction[] = candidates.map((c, i): ZoteroPushAction => {
    if (c.kind === 'skip') return c;
    const shared = claims[i].find(id => (given.get(id) ?? 0) > 1);
    if (shared !== undefined) {
      return shared.startsWith('DOI ')
        ? { kind: 'skip', entryKey: c.entryKey, reason: 'duplicate-doi', detail: shared.slice(4) }
        : { kind: 'skip', entryKey: c.entryKey, reason: 'duplicate-identifier', detail: shared };
    }
    if (c.kind === 'create') {
      const itemType = ITEM_TYPE_BY_ENTRY_TYPE[c.entry.type.toLowerCase()];
      const type = itemType === undefined ? undefined : schemaType(input.schema, itemType);
      if (itemType === undefined || type === undefined) {
        return { kind: 'skip', entryKey: c.entryKey, reason: 'unsupported-type', detail: c.entry.type };
      }
      // The next push finds the item by its citation key: without a field
      // for one, every push would create it again.
      if (!type.fields.some(f => f.field === 'citationKey')) {
        return { kind: 'skip', entryKey: c.entryKey, reason: 'no-citation-key-field', detail: itemType };
      }
      // A retry after a lost answer, while Zotero may still be saving the
      // first request, must not create the item twice: the item's key comes
      // from the citation key, so both requests name the same item, and
      // version 0 makes Zotero refuse the second rather than merge it.  A
      // key the library holds already, or another entry's, is never used.
      const itemKey = pushItemKey(input.keySalt, c.entryKey);
      const sharer = createKeys.get(itemKey)?.find(k => k !== c.entryKey);
      if (input.takenKeys.has(itemKey) || sharer !== undefined) {
        return { kind: 'skip', entryKey: c.entryKey, reason: 'key-taken', detail: describeKey(itemKey, sharer) };
      }
      const { data, notPushed } = createData(c.entry, itemType, type, input.collectionKey, c.repeated, itemKey);
      return { kind: 'create', entryKey: c.entryKey, itemType, data, notPushed };
    }
    if ((targets.get(c.item.key) ?? 0) > 1) {
      return { kind: 'skip', entryKey: c.entryKey, reason: 'duplicate-target', detail: c.item.key };
    }
    // A write replaces the item's collections and creators whole, so each is
    // sent only from a list read whole: a response that left it out, or
    // has an element push can't read, would drop what it didn't say.
    const collections = wholeList(c.item.collections, (k): k is string => typeof k === 'string');
    if (collections === undefined) return { kind: 'skip', entryKey: c.entryKey, reason: 'incomplete-item', detail: 'collections' };
    if (
      input.mode === 'update' &&
      (c.entry.fields.has('author') || c.entry.fields.has('editor')) &&
      wholeList(c.item.creators, isCreator) === undefined
    ) {
      return { kind: 'skip', entryKey: c.entryKey, reason: 'incomplete-item', detail: 'creators' };
    }
    const addToCollection = !collections.includes(input.collectionKey);
    const type = schemaType(input.schema, c.item.itemType);
    let changes: ZoteroFieldChange[] = [];
    let patch: Record<string, unknown> = {};
    let notPushed: ZoteroFieldNotPushed[] = [];
    if (input.mode === 'update' && type !== undefined) {
      ({ changes, patch, notPushed } = updateChanges(c.entry, c.item, type, c.repeated));
    }
    const unchanged = !addToCollection && changes.length === 0;
    // Any write to the item would let Zotero rewrite it from its Extra.
    const migrations = unchanged || type === undefined ? [] : extraMigrations(c.item, type, input.schema);
    if (migrations.length > 0) {
      return { kind: 'skip', entryKey: c.entryKey, reason: 'extra-would-migrate', detail: migrations.join(', ') };
    }
    // Matched by an identifier while a keyless item is the plain match:
    // either may be the entry's, so neither is written or reported as it.
    if (c.plainElsewhere !== undefined) {
      return { kind: 'skip', entryKey: c.entryKey, reason: 'plain-match-elsewhere', detail: c.item.key + ' and ' + c.plainElsewhere };
    }
    if (unchanged) return { kind: 'unchanged', entryKey: c.entryKey, itemKey: c.item.key, notPushed };
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
