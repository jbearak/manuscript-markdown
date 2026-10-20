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
// Also read, where Pandoc reads text: the abbreviations of
// COMPATIBLE_TERMS, as ch., which citeproc reads as a label at the start of
// a page's locator, with any word after one as the locator, as sec. A.
// Export wrote all of such a text as a page's locator before, which Word
// showed as that label, so a document written so keeps its label. Import
// writes what Pandoc reads the same where it can (citationLocatorText).
//
// Where it differs from Pandoc: Pandoc writes each space as one; here a
// locator and a suffix keep the whitespace written in them, as a line end,
// which export kept in a locator before. The text is read as text, but
// for an escaped brace or backslash (see ESCAPED_RE), the escapes of a
// citation's own characters, as \; (see CITATION_ESCAPE_RE), and a tag
// citeproc reads, which is part of a word (see TAG_RE): Pandoc reads Markdown's
// formatting in a suffix, which export takes as written, as it does a
// locator, and Word shows a suffix as written (see AFFIX_MARKUP in
// md-to-docx-citations.ts).
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

/** Abbreviations citeproc reads as a label at the start of a page's
 *  locator (its LOCATOR_LABELS_REGEXP and LOCATOR_LABELS_MAP), each with
 *  its label: those of a label with a term in the en-US locale, which
 *  export wrote as a page's locator before (with p. and pp., which it read
 *  as a page's with any text after them), and which Word then showed as
 *  that label. Read as citeproc reads them, in lower case, before
 *  whitespace, with any word after one as the locator's first, where
 *  Pandoc's terms read no locator: ch. 2 and sec. A, but not sec. 2,
 *  which Pandoc reads. Not art., which citeproc shows as Preprint, nor an
 *  abbreviation of a label with no term in the locale, as subpara., which
 *  it shows as Page subpara. Import writes the label's own term where it
 *  has one in LOCATOR_TERMS, as chap., and these where it has none. */
const COMPATIBLE_TERMS: ReadonlyArray<readonly [term: string, label: string]> = [
  ['app.', 'appendix'],
  ['bk.', 'book'],
  ['ch.', 'chapter'],
  ['col.', 'column'],
  ['fig.', 'figure'],
  ['fol.', 'folio'],
  ['l.', 'line'],
  ['n.', 'note'],
  ['no.', 'issue'],
  ['op.', 'opus'],
  ['p.', 'page'],
  ['pp.', 'page'],
  ['para.', 'paragraph'],
  ['pt.', 'part'],
  ['r.', 'rule'],
  ['sec.', 'section'],
  ['supp.', 'supplement'],
  ['sv.', 'sub verbo'],
  ['tbl.', 'table'],
  ['vol.', 'volume'],
  ['vrs.', 'verse'],
];

/** The label of each of COMPATIBLE_TERMS, by its word without the period */
const COMPATIBLE_LABELS: ReadonlyMap<string, string> = new Map(COMPATIBLE_TERMS.map(([term, label]) => [term.slice(0, -1), label] as const));

/** The label of each term, its case folded, as Pandoc looks a term up */
const TERM_LABELS: ReadonlyMap<string, string> = new Map(LOCATOR_TERMS.flatMap(([label, ...terms]) => terms.map(term => [term, label] as const)));

/** The terms of each label, and for a label of COMPATIBLE_TERMS alone, its
 *  term there, singular and plural */
const LABEL_TERMS: ReadonlyMap<string, readonly string[]> = (() => {
  const terms = new Map<string, readonly string[]>(LOCATOR_TERMS.map(([label, ...forms]) => [label, forms]));
  for (const [term, label] of COMPATIBLE_TERMS) if (!terms.has(label)) terms.set(label, [term, term]);
  return terms;
})();

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
 *  punctuation character but :, or a run of other characters, with an
 *  escaped brace or backslash among them (see ESCAPED_RE), and a tag (see
 *  TAG_RE) */
interface Token {
  text: string;
  space: boolean;
}

// A tag citeproc reads as markup (its FlipFlopper), whole: part of a word,
// as <sup>2</sup>, which export wrote as a page's locator before, and Word
// showed as a superscript 2, not split at its / or its punctuation. Pandoc
// reads a tag in a word as part of it too.
const TAG = '<(?:/?(?:i|b|sc|sup|sub)|span class="no(?:case|decor)"|span style="font-variant: ?small-caps;"|/span)>';
const TAG_RE = new RegExp(TAG, 'g');
const TOKEN_RE = new RegExp('\\s+|(?:' + TAG + '|\\\\[\\\\{}]|[^\\s\\p{P}]|:)+|\\p{P}', 'gu');
// A brace or a backslash after a backslash, as \{, which is that
// character as text, not a brace or an escape: the Markdown escapes read
// here, so a locator can hold a brace no other brace closes, as A\{B, and
// a backslash before one, which import writes so (citationLocatorText).
// Pandoc shows each as that character too, but reads an escaped brace as
// a brace here. Other text is read as written, a backslash before another
// character too.
const ESCAPED_RE = /\\([\\{}])/g;
const unescaped = (text: string) => text.replace(ESCAPED_RE, (_escape, character: string) => character);
// A ;, [, ] or @ after a backslash, which is that character as text, as
// Pandoc reads it, so that it ends no item or citation and starts no key
// (see citationItemEnd and citationClose in citation-syntax.ts). Read as
// the character, which the locator's parser reads as punctuation, as Pandoc
// does, so p. 2\; 5 is the locator 2; 5, before ESCAPED_RE's escapes, which
// stay escapes, so \\; is a backslash and a ;
const CITATION_ESCAPE_RE = /\\([\\{}[\];@])/g;
const withCitationEscapesRead = (text: string) => text.replace(CITATION_ESCAPE_RE, (escape, character: string) => '\\{}'.includes(character) ? escape : character);
// What import writes escaped always, as \;, with each backslash right
// before one escaped too, as \\\;, so it reads back as the text
// (from the start of a run of backslashes only, so a long run is read once,
// not again from each backslash in it)
const CITATION_CHARACTERS_RE = /(?<!\\)\\*[;[\]@]/g;
// An odd run of backslashes at the end
const TRAILING_ESCAPE_RE = /(?:^|[^\\])(?:\\\\)*\\$/;
// A ;, a [, a ] or an @ with an even run of backslashes before it, or none,
// which ends an item or a citation, or starts a key, as an escape no
// longer escapes where a locator's backslash at its end comes right before
// a suffix's, as 2\ and \] x make 2\\] x
const UNESCAPED_CHARACTER_RE = /(?:^|[^\\])(?:\\\\)*[;[\]@]/;
/** Whether this text after a key would end its item, or the citation, or
 *  start a key, before its end: at a ;, a [, a ] or an @ no backslash
 *  escapes, or at the ; or the ] after it, where a backslash at its end
 *  that no other escapes would escape that */
const endsEarly = (text: string) => TRAILING_ESCAPE_RE.test(text) || UNESCAPED_CHARACTER_RE.test(text);
const withCitationCharactersEscaped = (text: string) => text.replace(CITATION_CHARACTERS_RE, run => run.slice(0, -1).replace(/\\/g, '\\\\') + '\\' + run.slice(-1));
const untagged = (text: string) => text.replace(TAG_RE, '');
const PUNCTUATION_RE = /^\p{P}/u;
const DIGIT_RE = /[0-9]/;
// A Roman numeral as Pandoc reads one, its case aside: each part greedy,
// as no part after a run of a numeral starts with that numeral
const ROMAN_RE = /^M*(?:CM)?D?(?:CD)?C*(?:XC)?L?(?:XL)?X*(?:IX)?V?(?:IV)?I*$/;

/** The text after a citation item's key and its comma, its whitespace at
 *  both ends trimmed, as readCitationItem reads it, as Pandoc reads it:
 *  its locator, the locator's label and the suffix after it, or the whole
 *  of it as the suffix where it starts with no locator, as in
 *  [@doe, emphasis added], with its comma. With COMPATIBLE_TERMS too, as
 *  export reads it. */
export function readCitationLocator(text: string): CitationLocator {
  return readLocator(text, true);
}

/** The text after a key as readCitationLocator reads it, or as Pandoc
 *  alone does, without COMPATIBLE_TERMS */
function readLocator(text: string, withCompatible: boolean): CitationLocator {
  // As Pandoc gets it: the suffix after the key, from its comma
  const tokens: Token[] = [];
  for (const match of (', ' + withCitationEscapesRead(text)).matchAll(TOKEN_RE)) tokens.push({ text: match[0], space: /^\s/.test(match[0]) });
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
  // punctuation but a range's dash or :, with whether it has digits. Each
  // read without its tags, as <i>iv</i>, a Roman numeral.
  const pageUnit = (at: number): Parsed<[boolean, string]> => {
    const token = tokens[at];
    const roman = token && !token.space ? untagged(token.text).toUpperCase() : '';
    if (roman && ROMAN_RE.test(roman)) return { value: [true, token.text], next: at + 1 };
    let end = at;
    while (end < n && !tokens[end].space && !isLocatorPunctuation(single(end))) end++;
    if (end === at) return undefined;
    const unit = textFrom(at, end);
    return { value: [DIGIT_RE.test(untagged(unit)), unit], next: end };
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
  // One of COMPATIBLE_TERMS from `at`, before whitespace and a word, and
  // where the locator starts after it
  const compatible = (at: number): { label: string; next: number; compatible: true } | undefined => {
    if (!withCompatible) return undefined;
    const word = tokens[at];
    const label = word && !word.space ? COMPATIBLE_LABELS.get(word.text) : undefined;
    return label !== undefined && single(at + 1) === '.' && tokens[at + 2]?.space && at + 3 < n ? { label, next: at + 3, compatible: true } : undefined;
  };
  // A locator in braces, with or without a term, as {pp. iv, vi}
  const delimited = (at: number): { label: string; locator: string; next: number } | undefined => {
    if (single(at) !== '{') return undefined;
    let next = at + 1;
    while (tokens[next]?.space) next++;
    const found = term(next, k => k < n) ?? compatible(next);
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
    const found: { label: string; next: number; compatible?: true } | undefined = term(at, romansOrDigitsAt) ?? compatible(at);
    const implicit = !found;
    if (implicit && !digitsAt(at)) return undefined;
    const accepts = (word: [boolean, string]) => implicit ? DIGIT_RE.test(word[1]) : word[0];
    const first = locatorWord(!implicit, found ? found.next : at);
    // After one of COMPATIBLE_TERMS, any word, as sec. A, as citeproc reads one
    if (!first || !(found?.compatible || accepts(first.value))) return undefined;
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
  if (!read) return { suffix: unescaped(withComma(0)) };
  const suffix = unescaped(read.label || read.locator ? textFrom(read.next) : withComma(read.next));
  const locator = unescaped(read.locator);
  return {
    ...(locator ? { locator, ...(read.label ? { label: read.label } : {}) } : {}),
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
  // Each run of whitespace as one space, and each run of backslashes before
  // a dash left out, so no separator below reads a run more than once:
  // linear time
  const text = locator.trim().replace(/\s+/g, ' ')
    .replace(/\\+/g, (run: string, at: number, all: string) => /[-\u2013]/.test(all.charAt(at + run.length)) ? '' : run);
  const parts = text.split(/ ?& ?|,? and |[;,] | ?[-\u2013]+ ?/);
  if (parts.length < 2) return false;
  if (parts.length === 2 && /^\d+[,a-z]+$/i.test(parts[0]) && /^[,a-z]+$/i.test(parts[1])) return false;
  return /^\d/.test(parts[0]) || /^[ivxlcm]+$/i.test(parts[0]);
}

/** Zotero's label as LABEL_TERMS has it, as CSL 1.0.2's sub-verbo as
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
 *  starts with neither. A ;, a [, a ] or an @ in the locator or the suffix
 *  is escaped in each, as p. 2\; 5, as is a backslash right before one.
 *  With a brace or a backslash in the locator or the suffix, each of these
 *  with its braces and backslashes escaped too, as p. A\{B, for a brace
 *  no other closes.
 *  Of these, the first Pandoc reads the same too, else the first export
 *  reads so, as app. A, for a label Pandoc has no term for (see
 *  COMPATIBLE_TERMS). None of these ends the item or the citation before
 *  its end (see endsEarly). Failing all, of those that don't: with a
 *  locator, as one with a backslash before a brace, the first not in
 *  braces, the label's term and the locator, as main wrote it; without, as
 *  for a suffix that starts with a digit, the last, which reads as the
 *  suffix with a space before it. Empty where there's neither. */
export function citationLocatorText(locator: string | undefined, label: string | undefined, suffix: string | undefined): string {
  const loc = (locator ?? '').trim();
  // Its end as readCitationItem trims it
  const after = (suffix ?? '').trimEnd();
  if (!loc && !after) return '';
  const wanted = loc ? knownLabel(label) : undefined;
  const reads = (text: string, withCompatible: boolean) => {
    // As readCitationItem gives it, trimmed, and as all of the item, to the
    // ; or the ] after it
    if (text !== text.trim() || endsEarly(text)) return false;
    const read = readLocator(text, withCompatible);
    const readSuffix = read.suffix ?? '';
    return (read.locator ?? '') === loc && read.label === wanted
      && (readSuffix === after || SPACED_SUFFIX_RE.test(after) && readSuffix === ' ' + after);
  };
  // The text as written, but with a ;, a [, a ] or an @ escaped always
  // (see CITATION_CHARACTERS_RE), then with its braces and backslashes
  // escaped too, where it has any, which reads as the text (see ESCAPED_RE)
  const escapes = (text: string) => /[\\{}]/.test(text)
    ? [withCitationCharactersEscaped(text), text.replace(/[\\{};[\]@]/g, character => '\\' + character)]
    : [withCitationCharactersEscaped(text)];
  let candidates: string[];
  if (loc) {
    const term = LABEL_TERMS.get(wanted!)![pluralLocator(loc) ? 1 : 0];
    const forms = escapes(loc).flatMap(written => [term + ' ' + written, '{' + term + ' ' + written + '}']);
    candidates = after ? forms.flatMap(form => escapes(after).flatMap(written => [form + written, form + ' ' + written])) : forms;
  } else {
    candidates = escapes(after).flatMap(written => [...(written.startsWith(', ') ? [written.slice(2), '{}' + written.slice(2)] : []), '{}' + written, '{} ' + written]);
  }
  // As export reads it, and as Pandoc does too where one reads so, as
  // {p. A}, not p. A, which Pandoc reads as text
  const found = candidates.find(text => reads(text, true) && reads(text, false)) ?? candidates.find(text => reads(text, true));
  if (found !== undefined) return found;
  // Of those that would end the item or the citation no earlier (see
  // endsEarly), as A]\ is written p. A\]\\, not p. A\]\, whose last
  // backslash would escape the ; after it, so the next item would read as
  // more of this one, the form with its backslashes escaped too having
  // none; with a locator, the first not in braces, not {p. A\]\}, whose
  // last brace is escaped
  const safe = candidates.filter(text => !endsEarly(text));
  return (loc ? safe.find(text => !text.startsWith('{')) ?? safe[0] : safe[safe.length - 1]) ?? candidates[0];
}
