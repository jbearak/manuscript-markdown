// A citation item's locator, its label and its suffix, as Pandoc reads
// them in the text after the item's key (its Text.Pandoc.Citeproc.Locator):
// an optional locator term, as p., chap. or §, then the locator, which ends
// where Pandoc's parser stops, and the rest, the suffix. Export reads them
// into the item of a Zotero field (locator, label, suffix), which Zotero's
// dialog shows and citeproc renders; import writes them back
// (citationLocatorText), in a form export reads as the same.
//
// The terms are those of CSL's en-US locale, which Pandoc reads in an
// English document, and which citeproc renders with here (only English
// locales are bundled; see loadLocale). Pandoc reads a locale's own terms
// in another language, as S. in German.
//
// Where it differs from Pandoc: Pandoc writes each space as one; here a
// locator and a suffix keep the whitespace written in them, as a line end,
// which export kept in a locator before. The text is read as text: Pandoc
// reads Markdown's formatting in a suffix, which export takes as written,
// as it does a locator.
//
// Every scan here is linear in the text: a term is at most
// MAX_TERM_LENGTH characters, so the search for the longest term looks no
// further than that, and each word of the locator is read once.

import { maxOf } from './arrays';

/** CSL's locator labels, as Zotero writes them, each with its terms in
 *  CSL's en-US locale (src/csl-locales), which Pandoc's parser reads: the
 *  short form's singular and plural first, which import writes, then the
 *  long form's and the symbol's. Pandoc reads number-of-pages's too, which
 *  are page's. */
const LOCATOR_TERMS: ReadonlyArray<readonly [label: string, single: string, plural: string, ...others: string[]]> = [
  ['book', 'bk.', 'bks.', 'book', 'books'],
  ['chapter', 'chap.', 'chaps.', 'chapter', 'chapters', 'c.', 'cc.'],
  ['column', 'col.', 'cols.', 'column', 'columns'],
  ['figure', 'fig.', 'figs.', 'figure', 'figures'],
  ['folio', 'fol.', 'fols.', 'folio', 'folios'],
  ['issue', 'no.', 'nos.', 'issue', 'issues'],
  ['line', 'l.', 'll.', 'line', 'lines'],
  ['note', 'n.', 'nn.', 'note', 'notes'],
  ['opus', 'op.', 'opp.', 'opus', 'opera'],
  ['page', 'p.', 'pp.', 'page', 'pages'],
  ['paragraph', 'para.', 'paras.', 'paragraph', 'paragraphs', '¶', '¶¶'],
  ['part', 'pt.', 'pts.', 'part', 'parts'],
  ['section', 'sec.', 'secs.', 'section', 'sections', '§', '§§'],
  // CSL 1.0.2's sub-verbo, which citeproc reads either way
  ['sub verbo', 's.v.', 's.vv.', 'sub verbo', 'sub verbis'],
  ['verse', 'v.', 'vv.', 'verse', 'verses'],
  ['volume', 'vol.', 'vols.', 'volume', 'volumes'],
];

/** The label of each term, its case folded, as Pandoc looks a term up */
const TERM_LABELS: ReadonlyMap<string, string> = new Map(LOCATOR_TERMS.flatMap(([label, ...terms]) => terms.map(term => [term, label] as const)));

/** The terms of each label */
const LABEL_TERMS: ReadonlyMap<string, readonly string[]> = new Map(LOCATOR_TERMS.map(([label, ...terms]) => [label, terms]));

/** The longest term's length */
const MAX_TERM_LENGTH = maxOf([...TERM_LABELS.keys()].map(term => term.length));

/** A citation item's locator, its label and its suffix, as Zotero's field
 *  holds them */
export interface CitationLocator {
  locator?: string;
  /** CSL's label, as Zotero writes it, as chapter or sub verbo; none for a
   *  locator in braces without a term, which Pandoc reads with none */
  label?: string;
  suffix?: string;
}

/** A token as Pandoc's parser reads one: a run of whitespace, a
 *  punctuation character but :, or a run of other characters */
interface Token {
  text: string;
  space: boolean;
}

const TOKEN_RE = /\s+|(?:[^\s\p{P}]|:)+|\p{P}/gu;
const PUNCTUATION_RE = /^\p{P}/u;
const DIGIT_RE = /[0-9]/;
// A Roman numeral as Pandoc reads one, its case aside: each part greedy,
// as no part after a run of a numeral starts with that numeral
const ROMAN_RE = /^M*(?:CM)?D?(?:CD)?C*(?:XC)?L?(?:XL)?X*(?:IX)?V?(?:IV)?I*$/;

/** The text after a citation item's key and its comma, its whitespace at
 *  both ends trimmed, as readCitationItem reads it, as Pandoc reads it:
 *  its locator, the locator's label and the suffix after it, or the whole
 *  of it as the suffix where it starts with no locator, as in
 *  [@doe, emphasis added], with its comma. */
export function readCitationLocator(text: string): CitationLocator {
  // As Pandoc gets it: the suffix after the key, from its comma
  const tokens: Token[] = [];
  for (const match of (', ' + text).matchAll(TOKEN_RE)) tokens.push({ text: match[0], space: /^\s/.test(match[0]) });
  const n = tokens.length;
  type Parsed<T> = { value: T; next: number } | undefined;
  // The character of a token of one, as Pandoc's pMatchChar takes
  const single = (at: number): string | undefined => {
    const token = tokens[at];
    if (!token || token.space) return undefined;
    const first = token.text.codePointAt(0)!;
    return String.fromCodePoint(first).length === token.text.length ? token.text : undefined;
  };
  const isLocatorPunctuation = (c: string | undefined) => c !== undefined && c !== '-' && c !== '\u2013' && c !== ':' && PUNCTUATION_RE.test(c);
  const textFrom = (from: number, to = n) => tokens.slice(from, to).map(token => token.text).join('');

  // A page's unit: a Roman numeral, or a run of tokens to a space or
  // punctuation but a range's dash or :, with whether it has digits
  const pageUnit = (at: number): Parsed<[boolean, string]> => {
    const token = tokens[at];
    if (token && !token.space && ROMAN_RE.test(token.text.toUpperCase())) return { value: [true, token.text], next: at + 1 };
    let end = at;
    while (end < n && !tokens[end].space && !isLocatorPunctuation(single(end))) end++;
    if (end === at) return undefined;
    const unit = textFrom(at, end);
    return { value: [DIGIT_RE.test(unit), unit], next: end };
  };
  // .2, a unit after a period
  const withPeriod = (at: number): Parsed<[boolean, string]> => {
    if (single(at) !== '.') return undefined;
    const unit = pageUnit(at + 1);
    return unit && { value: [unit.value[0], '.' + unit.value[1]], next: unit.next };
  };
  // 1, 1.2, 1.2.3, but not the period after them
  const pageSequence = (at: number): Parsed<[boolean, string]> => {
    const first = pageUnit(at);
    if (!first) return withPeriod(at);
    let [digits, sequence] = first.value;
    let next = first.next;
    for (let more = withPeriod(next); more; more = withPeriod(next)) {
      digits ||= more.value[0];
      sequence += more.value[1];
      next = more.next;
    }
    return { value: [digits, sequence], next };
  };
  // One or more of what `read` reads, each alone or in a pair of `pairs`
  // around it, as (1)(a)
  const balanced = ({ pairs, braces }: Braces, read: (at: number) => Parsed<[boolean, string]>, at: number): Parsed<[boolean, string]> => {
    const outside = (from: number) => braces.has(single(from) ?? '') ? undefined : read(from);
    const surround = (from: number): Parsed<[boolean, string]> => {
      const open = single(from);
      const close = open !== undefined ? pairs.get(open) : undefined;
      if (close !== undefined) {
        const inner = outside(from + 1);
        const after = inner ? inner.next : from + 1;
        if (single(after) === close) return { value: [inner?.value[0] ?? false, open + (inner?.value[1] ?? '') + close], next: after + 1 };
      }
      return outside(from);
    };
    let digits = false;
    let text = '';
    let next = at;
    for (let one = surround(next); one; one = surround(next)) {
      digits ||= one.value[0];
      text += one.value[1];
      next = one.next;
    }
    return next === at ? undefined : { value: [digits, text], next };
  };
  // A word of the locator, after its separator where it isn't the first,
  // and a space, as ", 35" or "(1)(a)"
  const locatorWord = (first: boolean, at: number): Parsed<[boolean, string]> => {
    let next = at;
    let lead = '';
    const separator = first ? undefined : single(next);
    if (separator === ',' || separator === ';') {
      lead += separator;
      next++;
    }
    if (tokens[next]?.space) lead += tokens[next++].text;
    const word = balanced(PAGE_PAIRS, pageSequence, next);
    return word && { value: [word.value[0], lead + word.value[1]], next: word.next };
  };
  const romansOrDigitsAt = (at: number) => locatorWord(true, at)?.value[0] === true;
  const digitsAt = (at: number) => DIGIT_RE.test(locatorWord(true, at)?.value[1] ?? '');
  // The longest term from `start` that ends where `ends` says one may: the
  // tokens to each such place in turn, looked up, as long as a term could be
  const term = (start: number, ends: (at: number) => boolean): { label: string; next: number } | undefined => {
    let found: { label: string; next: number } | undefined;
    let text = '';
    let at = start;
    while (at < n) {
      text += tokens[at++].text;
      for (;;) {
        if (foldTerm(text).length > MAX_TERM_LENGTH) return found;
        if (ends(at)) break;
        if (at >= n) return found;
        text += tokens[at++].text;
      }
      const label = TERM_LABELS.get(foldTerm(text));
      if (label !== undefined) found = { label, next: at };
    }
    return found;
  };
  // A locator in braces, with or without a term, as {pp. iv, vi}
  const delimited = (at: number): { label: string; locator: string; next: number } | undefined => {
    if (single(at) !== '{') return undefined;
    let next = at + 1;
    while (tokens[next]?.space) next++;
    const found = term(next, k => k < n);
    // A digit alone is a page's, as Pandoc reads one; anything else a
    // locator without a label
    const label = found?.label ?? (/^[0-9]$/.test(single(next) ?? '') ? 'page' : '');
    if (found) next = found.next;
    const inside = balanced(DELIMITED_PAIRS, k => k < n ? { value: [true, tokens[k].text], next: k + 1 } : undefined, next);
    if (inside) next = inside.next;
    if (single(next) !== '}') return undefined;
    // Without the whitespace before the }, which citeproc doesn't show
    return { label, locator: (inside?.value[1] ?? '').trimEnd(), next: next + 1 };
  };
  // A locator with a term or a number first, as p. 33-35, 38 or 33
  const integrated = (at: number): { label: string; locator: string; next: number } | undefined => {
    const found = term(at, romansOrDigitsAt);
    const implicit = !found;
    if (implicit && !digitsAt(at)) return undefined;
    const accepts = (word: [boolean, string]) => implicit ? DIGIT_RE.test(word[1]) : word[0];
    const first = locatorWord(!implicit, found ? found.next : at);
    if (!first || !accepts(first.value)) return undefined;
    let locator = first.value[1];
    let next = first.next;
    for (let word = locatorWord(false, next); word && accepts(word.value); word = locatorWord(false, next)) {
      locator += word.value[1];
      next = word.next;
    }
    return { label: found?.label ?? 'page', locator, next };
  };
  // A suffix as Pandoc writes one where no locator is before it: with a
  // comma and a space before it, but where it starts with either or other
  // punctuation
  const withComma = (from: number) => {
    const rest = textFrom(from);
    return !rest || tokens[from].space || PUNCTUATION_RE.test(tokens[from].text) ? rest : ', ' + rest;
  };

  let at = 0;
  if (single(at) === ',') at++;
  if (tokens[at]?.space) at++;
  const read = delimited(at) ?? integrated(at);
  if (!read) return { suffix: withComma(0) };
  const suffix = read.label || read.locator ? textFrom(read.next) : withComma(read.next);
  return {
    ...(read.locator ? { locator: read.locator, ...(read.label ? { label: read.label } : {}) } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

/** Pairs of braces, each opener's closer, and all of them */
interface Braces {
  pairs: ReadonlyMap<string, string>;
  braces: ReadonlySet<string>;
}
const bracesOf = (pairs: Array<[string, string]>): Braces => ({ pairs: new Map(pairs), braces: new Set(pairs.flat()) });
// Around a locator's word, as (1)(a), and in a locator in braces
const PAGE_PAIRS = bracesOf([['{', '}'], ['[', ']'], ['(', ')']]);
const DELIMITED_PAIRS = bracesOf([['{', '}'], ['[', ']']]);

/** A term's text as Pandoc looks it up: its whitespace trimmed, a run of
 *  it inside as a space, its case folded */
function foldTerm(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

// What citeproc puts a space before in a suffix (its
// STARTSWITH_ROMANESQUE_REGEXP, and ( and [), so a suffix with a space
// before it shows the same
const SPACED_SUFFIX_RE = /^(?:[&a-zA-Z\u0e01-\u0e5b\u00c0-\u017f\u0370-\u03ff\u0400-\u052f\u0590-\u05d4\u05d6-\u05ff\u1f00-\u1fff\u0600-\u06ff\u0218-\u021b\u202a-\u202e([]|\u200c|\u200d|\u200e)/;

/** Whether citeproc shows a locator's term plural, as pp. 3-5: where its
 *  parts, apart at a range's dash, a comma, & or and, are more than one,
 *  and the first is a number or a Roman numeral (its processNumber), but
 *  for a page's subsections, as 12a-c */
function pluralLocator(locator: string): boolean {
  const parts = locator.trim().split(/\s*&\s*|,?\s+and\s+|[;,]\s+|\s*\\*[-\u2013]+\s*/);
  if (parts.length < 2) return false;
  if (parts.length === 2 && /^\d+[,a-z]+$/i.test(parts[0]) && /^[,a-z]+$/i.test(parts[1])) return false;
  return /^\d/.test(parts[0]) || /^[ivxlcm]+$/i.test(parts[0]);
}

/** Zotero's label as LOCATOR_TERMS has it, as CSL 1.0.2's sub-verbo as
 *  sub verbo, or page where it has no terms there or none is given, as
 *  citeproc takes a locator without one */
function knownLabel(label: string | undefined): string {
  const name = (label ?? '').trim().toLowerCase().replace(/-/g, ' ');
  return LABEL_TERMS.has(name) ? name : 'page';
}

/** The text after a citation item's key and its comma that export reads
 *  (readCitationLocator) as `locator`, with Zotero's `label` (page where
 *  none is given, or where Pandoc has no term for it), and `suffix`, or
 *  where none does, as what citeproc shows the same: with a space before a
 *  suffix it puts one before anyway, as emphasis added. The first of: the
 *  label's term, singular or plural as citeproc shows it, the locator and
 *  the suffix, as p. 33, emphasis added; with a space before the suffix;
 *  then the term and the locator in braces, as {chap. A to B}, where the
 *  locator's words wouldn't read as one or the suffix would read as more
 *  of it. Without a locator, the suffix after its comma and space, then
 *  after {}, which reads as no locator, where it would read as one or
 *  starts with neither. Failing all, the last of them, which reads the
 *  locator, or none, as given. Empty where there's neither. `locator` and
 *  `suffix` hold no ; or ], which would end the item or the citation. */
export function citationLocatorText(locator: string | undefined, label: string | undefined, suffix: string | undefined): string {
  const loc = (locator ?? '').trim();
  // Its end as readCitationItem trims it
  const after = (suffix ?? '').trimEnd();
  if (!loc && !after) return '';
  const wanted = loc ? knownLabel(label) : undefined;
  const reads = (text: string) => {
    // As readCitationItem gives it, trimmed
    if (text !== text.trim()) return false;
    const read = readCitationLocator(text);
    const readSuffix = read.suffix ?? '';
    return (read.locator ?? '') === loc && read.label === wanted
      && (readSuffix === after || SPACED_SUFFIX_RE.test(after) && readSuffix === ' ' + after);
  };
  let candidates: string[];
  if (loc) {
    const terms = LABEL_TERMS.get(wanted!)!;
    const plain = terms[pluralLocator(loc) ? 1 : 0] + ' ' + loc;
    const braced = '{' + plain + '}';
    candidates = after ? [plain + after, plain + ' ' + after, braced + after, braced + ' ' + after] : [plain, braced];
  } else {
    candidates = after.startsWith(', ') ? [after.slice(2), '{}' + after.slice(2)] : [];
    candidates.push('{}' + after, '{} ' + after);
  }
  return candidates.find(reads) ?? candidates[candidates.length - 1];
}
