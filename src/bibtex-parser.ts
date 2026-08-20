// --- Implementation notes ---
// - Verbatim fields bypass brace stripping, TeX decoding, NFC normalization, and serialization escaping.
// - TeX decoding is intentionally limited to standard text accents; unknown commands remain literal.
// - Non-command braces remain intact; braces owned by recognized accent expressions are consumed.
// - Entry scanning: count consecutive preceding backslashes before `"` to detect quote-state correctly.
// - Scanner literals: compare input[k] against '\\' (one char), not '\\\\' (two-char runtime string).

export interface BibtexEntry {
  type: string;
  key: string;
  fields: Map<string, string>;
  zoteroKey?: string;
  zoteroUri?: string;
}

/** BibTeX fields whose payloads are opaque identifiers or paths. */
const VERBATIM_BIBTEX_FIELDS: ReadonlySet<string> = new Set([
  'doi', 'url', 'isbn', 'issn', 'file', 'zotero-key', 'zotero-uri',
]);

const AUTHOR_FIELDS: ReadonlySet<string> = new Set(['author', 'editor']);

/** Strip a single outer brace pair if it wraps the entire string.
 *  Scans left-to-right with a depth counter starting at 1 (after the opening '{').
 *  If depth first reaches 0 at the last character, the outer pair wraps the whole
 *  string and is stripped. Otherwise the string is returned unchanged.
 *  Examples:
 *    '{My Title}'        → 'My Title'   (single wrapping pair — strip)
 *    '{The {RNA} Paradox}' → 'The {RNA} Paradox' (single wrapping pair — strip, inner group preserved)
 *    '{a}{b}'            → '{a}{b}'     (two separate groups — keep)
 *    '{}'                → ''           (empty pair — strip)
 */
export function stripOuterBraces(s: string): string {
  if (s.length < 2 || s[0] !== '{' || s[s.length - 1] !== '}') {
    return s;
  }
  let depth = 1;
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] === '{') {
      depth++;
    } else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        // Outer '{' closed before the last character — not a single wrapping pair
        return s;
      }
    }
  }
  // depth === 1 here; the last '}' closes it → single wrapping pair
  return s.slice(1, -1);
}

interface DecodedCommand {
  value: string;
  nextIndex: number;
}

interface AccentBase {
  value: string;
  nextIndex: number;
}

const BIBTEX_ACCENT_MARKS: Readonly<Record<string, string>> = Object.freeze({
  '`': '̀',
  "'": '́',
  '^': '̂',
  '~': '̃',
  '=': '̄',
  'u': '̆',
  '.': '̇',
  '"': '̈',
  'r': '̊',
  'H': '̋',
  'v': '̌',
  'd': '̣',
  'c': '̧',
  'k': '̨',
  'b': '̱',
});

const BIBTEX_LITERAL_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['\\textasciitilde{}', '~'],
  ['\\textasciicircum{}', '^'],
];

const BIBTEX_SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&',
  '%': '%',
  '$': '$',
  '#': '#',
  '_': '_',
  '{': '{',
  '}': '}',
  '\\': '\\',
});

function isAsciiLetter(char: string): boolean {
  return /^[A-Za-z]$/.test(char);
}

function readUnicodeLetter(input: string, index: number): AccentBase | undefined {
  if (index >= input.length) return undefined;
  const codePoint = input.codePointAt(index);
  if (codePoint === undefined) return undefined;
  const value = String.fromCodePoint(codePoint);
  if (!/^\p{L}$/u.test(value)) return undefined;
  return { value, nextIndex: index + value.length };
}

function readAccentBase(input: string, index: number): AccentBase | undefined {
  if (input[index] === '\\' && (input[index + 1] === 'i' || input[index + 1] === 'j')) {
    const commandEnd = index + 2;
    if (!isAsciiLetter(input[commandEnd] ?? '')) {
      return { value: input[index + 1], nextIndex: commandEnd };
    }
  }
  return readUnicodeLetter(input, index);
}

function readAccentTarget(input: string, index: number): AccentBase | undefined {
  if (input[index] !== '{') return readAccentBase(input, index);

  const base = readAccentBase(input, index + 1);
  if (!base || input[base.nextIndex] !== '}') return undefined;
  return { value: base.value, nextIndex: base.nextIndex + 1 };
}

function tryDecodeLiteralCommandAt(input: string, slashIndex: number): DecodedCommand | undefined {
  for (const [source, value] of BIBTEX_LITERAL_COMMANDS) {
    if (input.startsWith(source, slashIndex)) {
      return { value, nextIndex: slashIndex + source.length };
    }
  }
  return undefined;
}

function tryDecodeTieAccent(input: string, targetIndex: number): DecodedCommand | undefined {
  if (input[targetIndex] !== '{') return undefined;
  const first = readUnicodeLetter(input, targetIndex + 1);
  if (!first) return undefined;
  const second = readUnicodeLetter(input, first.nextIndex);
  if (!second || input[second.nextIndex] !== '}') return undefined;
  return {
    value: (first.value + '͡' + second.value).normalize('NFC'),
    nextIndex: second.nextIndex + 1,
  };
}

/** Decode one supported accent command beginning at slashIndex.  Recognition is
 *  transactional: malformed or unsupported commands consume nothing. */
function tryDecodeAccentAt(input: string, slashIndex: number): DecodedCommand | undefined {
  if (input[slashIndex] !== '\\' || slashIndex + 1 >= input.length) return undefined;

  const commandStart = slashIndex + 1;
  let commandEnd = commandStart + 1;
  if (isAsciiLetter(input[commandStart])) {
    while (commandEnd < input.length && isAsciiLetter(input[commandEnd])) commandEnd++;
  }

  const command = input.slice(commandStart, commandEnd);
  let targetIndex = commandEnd;
  if (isAsciiLetter(input[commandStart])) {
    while (targetIndex < input.length && /\s/.test(input[targetIndex])) targetIndex++;
  }

  if (command === 't') return tryDecodeTieAccent(input, targetIndex);

  if (!Object.prototype.hasOwnProperty.call(BIBTEX_ACCENT_MARKS, command)) {
    return undefined;
  }
  const combiningMark = BIBTEX_ACCENT_MARKS[command];

  const target = readAccentTarget(input, targetIndex);
  if (!target) return undefined;
  return {
    value: (target.value + combiningMark).normalize('NFC'),
    nextIndex: target.nextIndex,
  };
}

/** Decode standard BibTeX/TeX text accents while retaining every brace that is
 *  not proven to belong solely to a recognized accent expression. */
function decodeBibtexText(input: string): string {
  let output = '';
  let index = 0;

  while (index < input.length) {
    if (input[index] === '{') {
      const grouped = tryDecodeAccentAt(input, index + 1);
      if (grouped && input[grouped.nextIndex] === '}') {
        output += grouped.value;
        index = grouped.nextIndex + 1;
        continue;
      }
    }

    if (input[index] === '\\') {
      const literal = tryDecodeLiteralCommandAt(input, index);
      if (literal) {
        output += literal.value;
        index = literal.nextIndex;
        continue;
      }

      const accent = tryDecodeAccentAt(input, index);
      if (accent) {
        output += accent.value;
        index = accent.nextIndex;
        continue;
      }

      const escaped = BIBTEX_SIMPLE_ESCAPES[input[index + 1]];
      if (escaped !== undefined) {
        output += escaped;
        index += 2;
        continue;
      }
    }

    output += input[index];
    index++;
  }

  return output.normalize('NFC');
}

function decodeBibtexFieldValue(
  fieldName: string,
  value: string,
  braceDelimited: boolean,
): string {
  if (VERBATIM_BIBTEX_FIELDS.has(fieldName)) return value;

  const semanticValue = braceDelimited && !AUTHOR_FIELDS.has(fieldName)
    ? stripOuterBraces(value)
    : value;
  return decodeBibtexText(semanticValue);
}

/** Undo the punctuation escapes BibTeX requires — `\&`, `\%`, `\$`, `\#`,
 *  `\_`, `\{`, `\}`, `\\`.  Exported for callers comparing a verbatim field's
 *  stored bytes (`doi`, `isbn`) against a plain identifier. */
export function unescapeBibtexPunctuation(s: string): string {
  return s.replace(/\\([&%$#_{}\\])/g, '$1');
}

/** Escape semantic text for BibTeX while keeping literal tilde and circumflex
 *  distinct from their accent-command spellings. */
export function escapeBibtexText(s: string): string {
  return s.replace(/([&%$#_{}~^\\])/g, char => {
    if (char === '~') return '\\textasciitilde{}';
    if (char === '^') return '\\textasciicircum{}';
    return '\\' + char;
  });
}

function escapeBibtex(s: string): string {
  // Unescape punctuation first to avoid double-escaping on semantic round-trips.
  return escapeBibtexText(unescapeBibtexPunctuation(s));
}

/** Find the closing `}` of a BibTeX entry body, handling nested braces and
 *  quoted strings.  `startPos` is the position just after the `@type{key,`
 *  header (i.e. the first character of the field area).
 *  Returns the index of the closing `}`, or -1 if unmatched.
 *
 *  Note: unlike extractRawField's brace scanner, this does NOT skip `\{`/`\}`
 *  escapes — it counts them as real braces.  This is intentional: at the
 *  entry-boundary level, `\{` inside a field value is always nested inside a
 *  brace-delimited value, so the net depth change is zero and the result is
 *  the same.  extractRawField needs escape-awareness because it scans a
 *  single field value where `\{` must not alter depth. */
function findEntryEnd(input: string, startPos: number, closer: '}' | ')' = '}'): number {
  // Field values are always brace-delimited, whatever encloses the entry, so
  // brace depth is tracked on its own.  For a paren entry the two are genuinely
  // independent: a `(` or `)` inside `title = {Analysis (Part I}` is ordinary
  // text with no obligation to balance, and folding it into one counter both
  // swallows valid entries and truncates others at the wrong place.
  let braceDepth = 0;
  // Only meaningful for a paren entry; a brace entry closes on braceDepth.
  let parenDepth = 1;
  let inQuotes = false;
  // Brace depth *within* the current quoted value.  BibTeX lets a `{`…`}` group
  // protect a literal `"` inside a quoted string, so a quote only ends the
  // string when it sits at depth 0 of that string.  This depth is kept apart
  // because braces inside a quoted value do not change the entry's own
  // nesting — `title = "a } brace"` must not close the entry.
  let quoteDepth = 0;
  const atTopLevel = () => (closer === ')' ? parenDepth === 1 && braceDepth === 0 : braceDepth === 0);

  for (let j = startPos; j < input.length; j++) {
    const char = input[j];

    if (char === '"' && (inQuotes ? quoteDepth === 0 : atTopLevel())) {
      // Only toggle quote state at the entry's top level (field values live
      // there).  Inside {…}-delimited values, " is a literal character.
      let backslashCount = 0;
      const backslash = '\\';
      for (let k = j - 1; k >= 0 && input[k] === backslash; k--) {
        backslashCount++;
      }
      if (backslashCount % 2 === 0) {
        inQuotes = !inQuotes;
        quoteDepth = 0;
      }
    } else if (inQuotes) {
      // Track protective groups, but never let an unbalanced `}` in a quoted
      // value drive the depth negative.
      if (char === '{') quoteDepth++;
      else if (char === '}' && quoteDepth > 0) quoteDepth--;
    } else if (char === '{') {
      braceDepth++;
    } else if (char === '}') {
      if (closer === '}' && braceDepth === 0) return j;
      if (braceDepth > 0) braceDepth--;
    } else if (closer === ')' && braceDepth === 0) {
      // Parens only count outside a braced value, where they really are the
      // entry's own delimiters.
      if (char === '(') parenDepth++;
      else if (char === ')' && --parenDepth === 0) return j;
    }
  }

  return -1;
}

/** Find the closing delimiter of an `@comment` body, counting delimiters only.
 *  A comment is arbitrary prose, so an apostrophe or a lone `"` in it is
 *  ordinary text — applying field-value quote semantics here would swallow the
 *  closing delimiter and make a balanced comment look unterminated.
 *  Returns the index of the closing delimiter, or -1 if unmatched. */
function findCommentEnd(input: string, startPos: number, closer: '}' | ')' = '}'): number {
  const opener = closer === ')' ? '(' : '{';
  let depth = 1;
  for (let j = startPos; j < input.length; j++) {
    if (input[j] === opener) depth++;
    else if (input[j] === closer && --depth === 0) return j;
  }
  return -1;
}

export type BibtexEol = '\n' | '\r\n';

/** True if `pos` sits after a `%` on its line, within the stretch of top-level
 *  ignored text starting at `gapStart`.  BibTeX ignores the rest of a line
 *  after `%`, so an entry-shaped run of characters there is prose.
 *
 *  The search stops at `gapStart` rather than at the previous newline: only the
 *  gap is known to be ignored text, and walking back past it would read a `%`
 *  out of a preceding entry's field value — `note = {50% off}` on the same line
 *  would then comment out a real entry that follows it.
 *
 *  `scanForwardForNewline` encodes this same rule from the other direction. */
function isInLineComment(input: string, gapStart: number, pos: number): boolean {
  for (let i = pos - 1; i >= gapStart; i--) {
    const ch = input[i];
    if (ch === '\n') return false;
    if (ch === '%') return true;
  }
  return false;
}

/** Hoisted so the type-name loop below does not re-dispatch a literal regex
 *  once per character.  Non-global: `test` on a global regex is stateful. */
const WORD_CHAR = /\w/;

/** True if a construct header — `@type{` or `@type(` — starts at `pos` and is
 *  complete before the end of the line.
 *
 *  A bare `@` is not one: it turns up in email addresses and prose, and
 *  treating it as a boundary cuts a scan short in text BibTeX ignores.
 *
 *  The scanner's own `/@(\w+)\s*([{(])/` accepts a newline between the type and
 *  the delimiter, and `@book\n{k, …}` really is one entry.  This predicate
 *  deliberately does not, because its only caller uses it to stop *before* a
 *  newline: looking across one to answer `true` would suppress the very
 *  newline the caller exists to find.  Where they disagree the caller stops one
 *  character later, at the newline, which is the answer it wanted anyway. */
function isConstructHeaderAt(text: string, pos: number): boolean {
  if (text[pos] !== '@') return false;
  let i = pos + 1;
  while (i < text.length && WORD_CHAR.test(text[i])) i++;
  if (i === pos + 1) return false;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return text[i] === '{' || text[i] === '(';
}

/** Line ending of the first newline after `from`, or null if the next
 *  construct starts first.
 *
 *  Everything between two top-level constructs is text BibTeX ignores — blank
 *  lines, prose, `%` comment lines — and a newline anywhere in it is the
 *  document's own.  So the walk runs through all of it: a `}` or `)` out here
 *  is a character in a comment, not a delimiter, and stopping on one hides the
 *  structural newline behind it.  Only a real construct header ends the scan,
 *  and not even that inside a `%` comment, where it is just more prose. */
function scanForwardForNewline(text: string, from: number): BibtexEol | null {
  let inComment = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') return text[i - 1] === '\r' ? '\r\n' : '\n';
    if (ch === '%') inComment = true;
    else if (!inComment && isConstructHeaderAt(text, i)) return null;
  }
  return null;
}

/** Line ending of the first newline before `from`, or null if the scan reaches
 *  non-ignored text first.
 *
 *  Only sound ahead of the *first* construct, so unlike the forward walk this
 *  one cannot know whether an `@` or a closing delimiter it meets is prose or
 *  the tail of a construct it has backed into — a `%` earlier on the line
 *  would decide it, and that is not knowable from here.  It stops at all of
 *  them and answers null. */
function scanBackwardForNewline(text: string, from: number): BibtexEol | null {
  for (let i = from; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n') return text[i - 1] === '\r' ? '\r\n' : '\n';
    if (ch === '@' || ch === '}' || ch === ')') return null;
  }
  return null;
}

/** Line ending of the first newline in `entryText` that sits at the entry's own
 *  lexical level — outside every brace-delimited and quoted field value — or
 *  null when the entry is structurally single-line.
 *
 *  A newline inside a field value is payload, not layout: `note = {a\nb}` says
 *  nothing about how the file separates its lines, and letting it speak for the
 *  entry drops LF structure into a CRLF document. */
export function detectEntryEol(entryText: string): BibtexEol | null {
  // Field-value brace depth; 0 is the entry's own level.
  let braceDepth = 0;
  let started = false;
  let inQuotes = false;
  let quoteDepth = 0;

  for (let i = 0; i < entryText.length; i++) {
    const ch = entryText[i];

    if (!started) {
      // The header is at the entry's level too: `@article\n{k, ...}` counts.
      if (ch === '\n') return entryText[i - 1] === '\r' ? '\r\n' : '\n';
      if (ch === '{' || ch === '(') started = true;
      continue;
    }

    if (ch === '"' && (inQuotes ? quoteDepth === 0 : braceDepth === 0)) {
      let backslashCount = 0;
      const backslash = '\\';
      for (let k = i - 1; k >= 0 && entryText[k] === backslash; k--) backslashCount++;
      if (backslashCount % 2 === 0) {
        inQuotes = !inQuotes;
        quoteDepth = 0;
      }
    } else if (inQuotes) {
      if (ch === '{') quoteDepth++;
      else if (ch === '}' && quoteDepth > 0) quoteDepth--;
    } else if (ch === '{') {
      braceDepth++;
    } else if (ch === '}') {
      // At depth 0 this is the entry's own closer, which ends the scan anyway.
      if (braceDepth > 0) braceDepth--;
    } else if (ch === '\n' && braceDepth === 0) {
      return entryText[i - 1] === '\r' ? '\r\n' : '\n';
    }
  }

  return null;
}

/** Dominant line ending of `text`, for callers that have no better source.
 *  Prefer passing the document's own convention (e.g. `TextDocument.eol`)
 *  when it is known: a single-line entry carries no newline of its own.
 *
 *  A majority vote alone cannot separate a structural newline from one inside
 *  a field value — `note = {a\r\nb}` in an LF entry and `note = {a\nb}` in a
 *  CRLF entry are mirror images that tie at one each.  So when the counts tie,
 *  a newline drawn from the whitespace gap beside a trusted entry breaks it:
 *  that one is structural by construction.  Text with no newline at all is LF,
 *  the only answer that cannot introduce a stray `\r` into a file that had
 *  none. */
export function detectBibtexEol(text: string): BibtexEol {
  // Counted in one pass rather than via `split`, which would allocate an array
  // of every line in the document just to take its length.
  let crlfCount = 0;
  let bareLfCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue;
    if (i > 0 && text[i - 1] === '\r') crlfCount++;
    else bareLfCount++;
  }
  if (crlfCount !== bareLfCount) return crlfCount > bareLfCount ? '\r\n' : '\n';
  if (crlfCount === 0) return '\n';

  // Tie: find a newline that is provably *between* top-level constructs
  // rather than inside one.  Entry boundaries have to come from the scanner,
  // not a bare regex — a regex happily matches `@book{fake,` sitting inside an
  // `@comment` body and would then read that comment's line ending as the
  // document's.  Only reached on a tie, so the extra scan is rare.
  const { ranges, constructEnds } = scanBibtex(text);
  // Every construct the scanner finished, entries and pseudo-entries alike —
  // a `@comment` never becomes a range, but the newline after it is just as
  // structural, and the forward scan stops at its header either way.
  for (const end of constructEnds) {
    // Walk only the ignored text touching the boundary.  Jumping to the next
    // newline *anywhere* after the construct would happily land inside the
    // following one and report its interior line ending as the file's.
    const after = scanForwardForNewline(text, end);
    if (after !== null) return after;
  }
  // Nothing after any construct, so try the gap before the first one.  Only
  // that gap: further in, the preceding construct's interior is in the way,
  // and every later gap was already covered by the forward pass above.
  const first = ranges.length > 0 ? ranges[0] : null;
  if (first !== null && first.trusted) {
    const before = scanBackwardForNewline(text, first.start - 1);
    if (before !== null) return before;
  }
  // No entry to anchor on — the first newline is the best signal left.
  const firstLf = text.indexOf('\n');
  return firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
}

/** Half-open `[start, end)` offsets of one entry occurrence within the input.
 *  Offsets are UTF-16 code units, matching `TextDocument.positionAt`.
 *  `keyStart`/`keyEnd` bracket the citation key itself, for callers that need
 *  to point at the declaration rather than the whole entry. */
export interface BibtexSourceRange {
  key: string;
  start: number;
  end: number;
  keyStart: number;
  keyEnd: number;
  /** True if the scanner reached this entry from the top level with sync
   *  intact.  A false range was recovered after the scanner lost its place, so
   *  it may actually sit inside another entry's field value — fine to navigate
   *  to, never safe to splice into. */
  trusted: boolean;
}

export interface ParsedBibtexWithRaw {
  parsed: Map<string, BibtexEntry>;
  raw: Map<string, string>;
  /** Every entry occurrence the scanner located, in source order, including
   *  repeated citation keys.  `parsed`/`raw` are keyed by citation key and so
   *  keep only the last occurrence; this array is the complete picture.
   *
   *  Navigation (go-to-definition, document symbols) should use all of these.
   *  Mutation must use only the ones with `trusted: true`, and only when
   *  `rangesTrusted` is also true — see those fields.
   *
   *  An entry whose closing delimiter is never found is omitted entirely:
   *  there is no end offset for it at all. */
  ranges: BibtexSourceRange[];
  /** False if anything in the document defeated the scanner — an undelimited
   *  entry, an unterminated declaration, an unparseable header.  After that
   *  point `parsed`/`raw` keep recovering entries heuristically, and a
   *  recovered occurrence can silently replace the `parsed`/`raw` value behind
   *  an earlier trusted range, so its key no longer identifies one place in
   *  the file.  Byte-level editing must refuse the whole document when this is
   *  false rather than trusting the prefix. */
  rangesTrusted: boolean;
}

/** `ParsedBibtexWithRaw` plus the scanner's internal construct boundaries.
 *
 *  `constructEnds` holds the end offset of every top-level construct the
 *  scanner consumed cleanly while in sync, in source order — pseudo-entries
 *  and keyless headers included, not just the ones that became `ranges`.
 *
 *  These are boundaries, not entries: they say where the scanner was last
 *  certain it stood outside every construct.  Only `detectBibtexEol` uses
 *  them, to find a newline in the ignored text after a construct.  A
 *  `@comment` is not something a caller may edit or navigate to, so it never
 *  appears in `ranges`; but the newline after it is as structural as any
 *  other, and without a boundary here the tie-break cannot see it.  They stay
 *  off the public result so no caller can mistake them for entries.
 *
 *  Nothing found after sync is lost appears here, even when it is perfectly
 *  balanced.  Balanced is not the same as top-level: a recovered
 *  `@book{...}` may be sitting inside the unclosed field value that lost sync
 *  in the first place, and then the newline after it is that field's payload,
 *  not the document's layout. */
interface ScannedBibtex extends ParsedBibtexWithRaw {
  constructEnds: number[];
}

/** Citation keys that occur more than once.  Entries with a duplicated key
 *  cannot be edited by offset unambiguously, so callers should leave them
 *  alone rather than guess which occurrence was meant. */
export function findDuplicateBibtexKeys(ranges: readonly BibtexSourceRange[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const range of ranges) {
    if (seen.has(range.key)) duplicates.add(range.key);
    else seen.add(range.key);
  }
  return duplicates;
}

/** `@string`, `@comment`, and `@preamble` are declarations, not bibliography
 *  entries.  Their bodies are skipped wholesale: BibTeX allows arbitrary text
 *  inside them, so an `@article{...}` quoted in a `@string` is data, not an
 *  entry, and reporting an editable range for it would let a caller splice
 *  fields into the middle of a string definition. */
const PSEUDO_ENTRY_TYPES: ReadonlySet<string> = new Set(['string', 'comment', 'preamble']);

/** True if only spaces/tabs separate `pos` from the start of its line. */
function isAtLineStart(input: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    const c = input[i];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return true;
}

/** Parse BibTeX input, returning both the structured entries and raw entry
 *  texts in a single pass over the entry boundaries.  parseBibtex delegates
 *  here; mergeBibtex uses both the parsed and raw maps directly. */
export function parseBibtexWithRaw(input: string): ParsedBibtexWithRaw {
  return scanBibtex(input);
}

/** The scan itself.  Separate from `parseBibtexWithRaw` only so the construct
 *  boundaries stay off the public result — see `ScannedBibtex`. */
function scanBibtex(input: string): ScannedBibtex {
  const parsed = new Map<string, BibtexEntry>();
  const raw = new Map<string, string>();
  const ranges: BibtexSourceRange[] = [];

  // Scan sequentially rather than pre-collecting every `@type{key,` match:
  // only a scan that has consumed everything before a given `@` knows whether
  // that `@` is at the top level or buried in someone's field value.
  // BibTeX accepts either delimiter around an entry body, and skipping the
  // paren form would leave a paren `@comment`'s contents exposed as entries.
  const headerRe = /@(\w+)\s*([{(])/g;
  const keyRe = /\s*([^,\s]+)\s*,/y;

  let pos = 0;
  // After a construct we could not delimit, we no longer know whether we are
  // at the top level or inside somebody's field value, so only an `@` that
  // opens a line is trusted to be the next entry.  That recovers `parsed`,
  // but it is a heuristic: an entry-shaped value indented on its own line is
  // lexically indistinguishable from a real entry at that point.
  let requireLineStart = false;
  // Boundaries for the EOL tie-break; see `ParsedBibtexWithRaw.constructEnds`.
  const constructEnds: number[] = [];
  // Ranges found after sync is lost are still reported — navigation wants
  // them — but marked untrusted, because a recovered `@book{...}` may really
  // be sitting inside another entry's field value.
  let synced = true;

  // NOTE: This regex handles nested braces only up to a small fixed depth
  // and backslash escapes within quoted strings (e.g. \").
  // If we need arbitrary nesting, replace with a balanced-brace field parser.
  const fieldRegex = /(\w+(?:-\w+)*)\s*=\s*(?:\{((?:[^{}]|\{(?:[^{}]|\{[^}]*\})*\})*)\}|"((?:\\.|[^"\\])*)"|(\w+))/g;

  while (pos < input.length) {
    headerRe.lastIndex = pos;
    const match = headerRe.exec(input);
    if (!match) break;

    const entryStart = match.index;
    const afterBrace = entryStart + match[0].length;
    const type = match[1];
    const closer: '}' | ')' = match[2] === '(' ? ')' : '}';

    // `% @article{fake, …}` is prose, not an entry.  Reporting it would offer
    // a range that splicing could write into, editing the user's commented-out
    // text — and since only the first line carries the `%`, a multi-line splice
    // would push part of it back out of the comment and into the document.
    if (isInLineComment(input, pos, entryStart)) {
      // Resume past the comment line rather than at the next `@`, which may
      // well be further along in the same comment.
      const lineEnd = input.indexOf('\n', entryStart);
      pos = lineEnd === -1 ? input.length : lineEnd + 1;
      continue;
    }

    if (requireLineStart && !isAtLineStart(input, entryStart)) {
      pos = afterBrace;
      continue;
    }

    const lowerType = type.toLowerCase();
    if (PSEUDO_ENTRY_TYPES.has(lowerType)) {
      // A comment's body is prose: a stray `"` in it is ordinary text, not the
      // start of a quoted value, so count delimiters only.
      const close = lowerType === 'comment'
        ? findCommentEnd(input, afterBrace, closer)
        : findEntryEnd(input, afterBrace, closer);
      if (close === -1) {
        // Unterminated declaration — fall back to line-start recovery.
        pos = afterBrace;
        requireLineStart = true;
        synced = false;
      } else {
        pos = close + 1;
        requireLineStart = false;
        if (synced) constructEnds.push(pos);
      }
      continue;
    }

    keyRe.lastIndex = afterBrace;
    const keyMatch = keyRe.exec(input);
    if (!keyMatch) {
      // `@type{` opened but the header has no citation key.  Consume its
      // balanced body rather than scanning into it — the `@book{...}` sitting
      // in a field of a malformed entry is that entry's data, not an entry.
      const close = findEntryEnd(input, afterBrace, closer);
      if (close === -1) {
        pos = afterBrace;
        requireLineStart = true;
        synced = false;
      } else {
        pos = close + 1;
        requireLineStart = false;
        if (synced) constructEnds.push(pos);
      }
      continue;
    }

    const key = keyMatch[1];
    const startPos = afterBrace + keyMatch[0].length;

    const endPos = findEntryEnd(input, startPos, closer);
    if (endPos === -1) {
      pos = startPos;
      requireLineStart = true;
      synced = false;
      continue;
    }
    pos = endPos + 1;
    requireLineStart = false;
    if (synced) constructEnds.push(pos);

    // Raw entry text (preserves original formatting)
    raw.set(key, input.slice(entryStart, endPos + 1));
    // Search for the key after the opening delimiter, so a key that also
    // spells the entry type (`@article{article,`) still points at the key.
    const keyStart = afterBrace + keyMatch[0].indexOf(key);
    ranges.push({
      key, start: entryStart, end: endPos + 1,
      keyStart, keyEnd: keyStart + key.length,
      trusted: synced,
    });

    // Parsed entry
    try {
      const fieldsStr = input.slice(startPos, endPos);
      const fields = new Map<string, string>();

      fieldRegex.lastIndex = 0;
      let fieldMatch;
      while ((fieldMatch = fieldRegex.exec(fieldsStr)) !== null) {
        const [, fieldName, braceValue, quoteValue, bareValue] = fieldMatch;
        const lowerField = fieldName.toLowerCase();
        const rawValue = braceValue ?? quoteValue ?? bareValue ?? '';
        const value = decodeBibtexFieldValue(lowerField, rawValue, braceValue !== undefined);
        fields.set(lowerField, value);
      }

      parsed.set(key, {
        type: type.toLowerCase(),
        key,
        fields,
        zoteroKey: fields.get('zotero-key'),
        zoteroUri: fields.get('zotero-uri'),
      });
    } catch {
      // Skip malformed entries — raw text is still preserved
    }
  }

  return { parsed, raw, ranges, rangesTrusted: synced, constructEnds };
}

export function parseBibtex(input: string): Map<string, BibtexEntry> {
  return parseBibtexWithRaw(input).parsed;
}

export function serializeBibtex(entries: Map<string, BibtexEntry>): string {
  const result: string[] = [];

  for (const entry of entries.values()) {
    const lines = [`@${entry.type}{${entry.key},`];

    for (const [fieldName, value] of entry.fields) {
      let escapedValue = value;

      if (!VERBATIM_BIBTEX_FIELDS.has(fieldName)) {
        escapedValue = escapeBibtex(value);
      }

      lines.push(`  ${fieldName} = {${escapedValue}},`);
    }

    // Remove trailing comma from last field
    if (lines.length > 1) {
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
    }

    lines.push('}');
    result.push(lines.join('\n'));
  }

  return result.join('\n\n');
}

// ---------------------------------------------------------------------------
// Amend-only .bib merging helpers
// ---------------------------------------------------------------------------

/** Extract a single field's raw text from an entry string.
 *  Returns the full line including indentation and trailing comma, e.g.
 *  `  title = {{My Title}},`  — or null if the field is not found. */
export function extractRawField(rawEntry: string, fieldName: string): string | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('(^|\\n)([ \\t]*' + escaped + '\\s*=\\s*)', 'i');
  const match = regex.exec(rawEntry);
  if (!match) return null;

  const lineStart = match.index + (match[1] === '\n' ? 1 : 0);
  const valueStart = match.index + match[0].length;
  const firstChar = rawEntry[valueStart];

  let valueEnd: number;
  if (firstChar === '{') {
    let depth = 1;
    let pos = valueStart + 1;
    while (pos < rawEntry.length && depth > 0) {
      if (rawEntry[pos] === '\\') { pos += 2; continue; }
      if (rawEntry[pos] === '{') depth++;
      else if (rawEntry[pos] === '}') depth--;
      pos++;
    }
    valueEnd = pos;
  } else if (firstChar === '"') {
    let pos = valueStart + 1;
    while (pos < rawEntry.length) {
      if (rawEntry[pos] === '\\') { pos += 2; continue; }
      if (rawEntry[pos] === '"') { pos++; break; }
      pos++;
    }
    valueEnd = pos;
  } else {
    const bareMatch = rawEntry.slice(valueStart).match(/^\w+/);
    valueEnd = valueStart + (bareMatch ? bareMatch[0].length : 0);
  }

  // Include trailing comma if present
  let end = valueEnd;
  if (end < rawEntry.length && rawEntry[end] === ',') end++;

  return rawEntry.slice(lineStart, end);
}

/** What a walk of an entry's body found at the entry's *own* lexical level —
 *  outside every braced or quoted field value.  See `scanBibtexEntryBody`. */
export interface BibtexEntryBodyScan {
  /** A `%` outside every field value.  Whether BibTeX treats it as a comment
   *  is genuinely ambiguous — classic bibtex ignores `%` inside an entry,
   *  biber and JabRef end the line at it — so the same bytes mean different
   *  things to different tools, and the text after it may or may not be live.
   *  A caller editing bytes must decline rather than pick a reading. */
  readonly hasTopLevelComment: boolean;
  /** A `#` outside every field value: BibTeX string concatenation, as in
   *  `doi = "10.1000/" # suffix`.  The field parser reads only the first atom,
   *  so the value it reports is a prefix of the real one. */
  readonly hasConcatenation: boolean;
  /** Field names in source order, lowercased, including repeats.  The parsed
   *  `fields` map keeps only the last of a repeated name; this says whether
   *  there was more than one. */
  readonly fieldNames: readonly string[];
  /** Every field occurrence in source order, with the value the walk itself
   *  read.  Callers comparing repeated fields must use these rather than
   *  searching the raw text again: a second search has none of this walk's
   *  lexical state, so it cannot tell a real second `doi =` from one sitting
   *  inside a multi-line note. */
  readonly fields: readonly BibtexEntryFieldOccurrence[];
  /** True if the walk did not end at the entry's own level — an escaped or
   *  stray delimiter left brace depth or a quote open.  The range's boundaries
   *  then do not mean what they appear to, and nothing may be spliced into it. */
  readonly unbalanced: boolean;
}

/** One `name = value` occurrence found by the body walk. */
export interface BibtexEntryFieldOccurrence {
  /** Lowercased field name. */
  readonly name: string;
  /** The value's text with its delimiters removed, exactly as written — no
   *  unescaping, so callers can normalize as their own comparison requires. */
  readonly value: string;
  /** How the value was written.  A `bare` value that is not all digits is a
   *  `@string` macro reference: what it stands for is defined elsewhere in the
   *  file, so its spelling is not its value — `zotero-key = ABCD1234` names a
   *  macro, not the item key `ABCD1234`.  A bare number (`year = 2020`) is a
   *  literal and means itself. */
  readonly delimiter: 'brace' | 'quote' | 'bare';
}

const ENTRY_HEADER_RE = /^@\w+\s*[{(]/;
/** What may appear in a field name.  BibTeX names are far more permissive than
 *  the identifiers they usually are: everything up to the next separator is
 *  part of the name, so `:doi`, `+doi`, `.doi` and `@doi` are all names in
 *  their own right.
 *
 *  Defined by exclusion, and deliberately so.  A caller matches on these names
 *  to decide whether an entry carries an identifier, and every character
 *  wrongly left out of a name splits it — reading `:doi` as `doi` invents a
 *  DOI field the file does not have.  The excluded set is exactly what ends a
 *  name: whitespace, the `=` that follows it, the `,` between fields, the
 *  value delimiters, and the `#`/`%` the surrounding walk must still see. */
const NAME_CHAR_RE = /[^\s=,{}()"#%]/;
const NAME_START_RE = NAME_CHAR_RE;
const SPACE_RE = /\s/;

/** Walk one entry's body, reporting what sits at the entry's own lexical level.
 *
 *  `parseBibtex` answers "what are this entry's field values"; this answers
 *  "is this entry's text unambiguous enough to edit by offset".  They are
 *  different questions: a value can be read correctly out of an entry whose
 *  bytes still cannot be safely rewritten, because a `%` may or may not have
 *  commented out the rest of a line and the parser's field regex simply skips
 *  past whatever it does not recognize.
 *
 *  `rawEntry` must be an exact parsed entry range — `raw.get(key)`, or a slice
 *  taken from a `BibtexSourceRange`. */
export function scanBibtexEntryBody(rawEntry: string): BibtexEntryBodyScan {
  const fields: BibtexEntryFieldOccurrence[] = [];
  let hasTopLevelComment = false;
  let hasConcatenation = false;
  let unbalanced = false;

  const result = (): BibtexEntryBodyScan => ({
    hasTopLevelComment,
    hasConcatenation,
    fieldNames: fields.map(f => f.name),
    fields,
    unbalanced,
  });

  const header = ENTRY_HEADER_RE.exec(rawEntry);
  // The citation key runs to the first comma and cannot contain one.
  const bodyStart = header ? rawEntry.indexOf(',', header[0].length) : -1;
  if (bodyStart === -1) return result();

  // Stop before the closing delimiter, which is the last character of an exact
  // entry range.
  const end = rawEntry.length - 1;
  let i = bodyStart + 1;

  const isEscaped = (pos: number): boolean => {
    let backslashes = 0;
    for (let k = pos - 1; k >= 0 && rawEntry[k] === '\\'; k--) backslashes++;
    return backslashes % 2 === 1;
  };

  /** End of the `{…}` value at `at` under one reading of escapes, or -1 if it
   *  does not close within the body.  `honourEscapes` distinguishes the two
   *  readings in the wild: biber and JabRef treat `\{` and `\}` as literal
   *  text, classic bibtex counts every brace. */
  const braceEnd = (at: number, honourEscapes: boolean): number => {
    let depth = 0;
    for (let k = at; k < end; k++) {
      if (honourEscapes && rawEntry[k] === '\\') {
        k++;
        continue;
      }
      if (rawEntry[k] === '{') depth++;
      else if (rawEntry[k] === '}' && --depth === 0) return k + 1;
    }
    return -1;
  };

  /** Consume a `{…}` value from `at`, returning the offset just past its
   *  closing brace, or -1 if the two readings of it disagree.
   *
   *  Both are computed, because a value that ends in a different place
   *  depending on the reader is a value whose text cannot be edited by offset:
   *  `note = {x \} doi = {10.1/a}, \{ y}` is one note to biber and a note plus
   *  a DOI field to classic bibtex, and linking on that DOI would assert an
   *  identifier the file does not unambiguously carry. */
  const skipBraced = (at: number): number => {
    const escaped = braceEnd(at, true);
    return escaped === braceEnd(at, false) ? escaped : -1;
  };

  /** Consume a `"…"` value from `at`.  A `{…}` group inside protects a literal
   *  quote, so its braces belong to the value, not to the entry — but a `}`
   *  with no `{` open is unbalanced to every reader, and BibTeX itself reports
   *  it, so the value has no agreed end. */
  const skipQuoted = (at: number): number => {
    let depth = 0;
    for (let k = at + 1; k < end; k++) {
      if (rawEntry[k] === '\\') {
        k++;
        continue;
      }
      if (rawEntry[k] === '{') depth++;
      else if (rawEntry[k] === '}') {
        if (depth === 0) return -1;
        depth--;
      } else if (rawEntry[k] === '"' && depth === 0) return k + 1;
    }
    return -1;
  };

  /** Consume whatever value begins at `at`, recording it under `name`.
   *  Returns the offset just past it, or -1 if it never closes. */
  const readValue = (name: string, at: number): number => {
    const ch = rawEntry[at];
    if (ch === '{') {
      const close = skipBraced(at);
      if (close === -1) return -1;
      fields.push({ name, value: rawEntry.slice(at + 1, close - 1), delimiter: 'brace' });
      return close;
    }
    if (ch === '"') {
      const close = skipQuoted(at);
      if (close === -1) return -1;
      fields.push({ name, value: rawEntry.slice(at + 1, close - 1), delimiter: 'quote' });
      return close;
    }
    let bareEnd = at;
    while (bareEnd < end && NAME_CHAR_RE.test(rawEntry[bareEnd])) bareEnd++;
    if (bareEnd === at) return at;
    fields.push({ name, value: rawEntry.slice(at, bareEnd), delimiter: 'bare' });
    return bareEnd;
  };

  // Every value is consumed whole by `readValue`, so the loop itself only ever
  // stands at the entry's own lexical level.
  while (i < end) {
    const ch = rawEntry[i];

    if (ch === '%' && !isEscaped(i)) {
      hasTopLevelComment = true;
    } else if (ch === '#' && !isEscaped(i)) {
      hasConcatenation = true;
    } else if (ch === '{' || ch === '"') {
      // A delimited run with no `name =` before it: the second operand of a
      // concatenation, or a stray.  It still has to close.
      const close = ch === '{' ? skipBraced(i) : skipQuoted(i);
      if (close === -1) {
        unbalanced = true;
        break;
      }
      i = close;
      continue;
    } else if (ch === '}' || ch === ')') {
      // A closer at the entry's own level: the range ends somewhere other than
      // where it appears to.
      unbalanced = true;
      break;
    } else if (NAME_START_RE.test(ch)) {
      // A name is a field name only when an `=` follows it; a bare value such
      // as `month = jan` is a word here too.
      let nameEnd = i;
      while (nameEnd < end && NAME_CHAR_RE.test(rawEntry[nameEnd])) nameEnd++;
      let after = nameEnd;
      while (after < end && SPACE_RE.test(rawEntry[after])) after++;
      if (rawEntry[after] !== '=') {
        i = nameEnd;
        continue;
      }
      let valueStart = after + 1;
      while (valueStart < end && SPACE_RE.test(rawEntry[valueStart])) valueStart++;
      const next = readValue(rawEntry.slice(i, nameEnd).toLowerCase(), valueStart);
      if (next === -1) {
        unbalanced = true;
        break;
      }
      i = next;
      continue;
    }
    i++;
  }

  return result();
}

/** Indentation of an entry's existing field lines, so an inserted field sits
 *  with them rather than announcing itself.  Two spaces — this codebase's
 *  generated BibTeX — is the fallback for an entry written on one line. */
const FIELD_LINE_RE = /\n([ \t]+)[A-Za-z][\w-]*[ \t]*=/;

export function detectBibtexFieldIndent(rawEntry: string): string {
  const m = FIELD_LINE_RE.exec(rawEntry);
  return m ? m[1] : '  ';
}

/** One `  name = {value},` line, in the form `spliceFieldsIntoEntry` expects.
 *
 *  The value is written verbatim: every caller passes an identifier that must
 *  survive byte-for-byte (a DOI, a Zotero URI, a copied field value), and
 *  escaping one would corrupt it.  A value containing an unbalanced brace
 *  would produce invalid BibTeX, so callers must not pass free text. */
export function formatBibtexFieldLine(name: string, value: string, indent = '  '): string {
  return indent + name + ' = {' + value + '},';
}

/** Splice additional raw field lines into a produced entry's raw text,
 *  inserting them before the closing `}`. Ensures a trailing comma on the
 *  last existing field so the result remains valid BibTeX.
 *
 *  Line endings: inserted lines use `eol`, which defaults to whatever
 *  `producedRaw` itself uses.  Pass the enclosing document's convention when
 *  it is known — a single-line entry carries no newline to infer from.
 *  Emitting bare LF into a CRLF entry would leave mixed endings, which
 *  surfaces as whole-file diff noise on Windows checkouts. */
export function spliceFieldsIntoEntry(
  producedRaw: string,
  fieldTexts: string[],
  eolArg?: BibtexEol,
): string {
  // Resolved after the no-op guard: detecting an EOL costs a scan of the
  // entry, and a splice with nothing to add returns the input untouched.
  if (fieldTexts.length === 0) return producedRaw;
  const eol = eolArg ?? detectEntryEol(producedRaw) ?? '\n';

  // `producedRaw` is an exact parsed entry range, so its final character is the
  // authoritative closer — a paren-delimited entry must be closed with `)`.
  // Falling back to `lastIndexOf('}')` here would rewrite `@article(k, ...)`
  // into something that no longer parses.
  const closingPos = producedRaw.length - 1;
  const closer = producedRaw[closingPos];
  if (closer !== '}' && closer !== ')') return producedRaw;

  const head = producedRaw.slice(0, closingPos);
  const trimmed = head.trimEnd();

  // Ensure a trailing comma on the last existing field so the splice stays
  // valid.  The comma is *inserted* after the last field token rather than
  // appended after a trim: whitespace the author left before the closer is
  // unrelated to the edit, and deleting it turns adding a field into a
  // reformat.
  const opener = closer === ')' ? '(' : '{';
  const needsComma =
    trimmed.length > 0 && !trimmed.endsWith(',') && !trimmed.endsWith(opener);
  const body = needsComma ? trimmed + ',' + head.slice(trimmed.length) : head;
  const before = body + (body.endsWith('\n') ? '' : eol);

  // Strip trailing comma from last spliced field for consistency with serializeBibtex
  const lastIdx = fieldTexts.length - 1;
  const cleaned = fieldTexts.map((ft, i) => {
    const t = ft.trimEnd();
    return i === lastIdx ? t.replace(/,$/, '') : t;
  });

  return before + cleaned.join(eol) + eol + closer;
}

/** Merge an existing .bib (from disk) with a produced .bib (from conversion).
 *  - Existing-only entries are preserved verbatim.
 *  - Entries in both: produced text wins, but existing-only fields are spliced in.
 *  - Produced-only entries are appended at the end.
 *  Citation keys are case-sensitive: `Smith2020` and `smith2020` are treated as
 *  distinct entries, consistent with the case-preserving behavior of parseBibtex.
 *  This is a post-processing step that runs after any restoration layer. */
export function mergeBibtex(existing: string, produced: string): string {
  if (!existing || existing.trim().length === 0) return produced;
  if (!produced || produced.trim().length === 0) return existing;

  // Fallback only, for entries too short to carry a newline of their own —
  // an entry that does have one is authoritative about its own layout.  Most
  // merges never need it, and on a tie `detectBibtexEol` re-scans the whole
  // document, so resolve it at most once and only on demand.
  let producedEolCache: BibtexEol | null = null;
  const producedEol = () => (producedEolCache ??= detectBibtexEol(produced));
  const existingResult = parseBibtexWithRaw(existing);
  const producedResult = parseBibtexWithRaw(produced);
  const existingParsed = existingResult.parsed;
  const producedParsed = producedResult.parsed;
  const existingRaw = existingResult.raw;
  const producedRaw = producedResult.raw;

  const result: string[] = [];
  const emittedKeys = new Set<string>();

  // Iterate existing entries in their original order
  for (const [key, existingEntry] of existingParsed) {
    emittedKeys.add(key);

    const producedEntry = producedParsed.get(key);
    if (!producedEntry) {
      // Only in existing → emit raw text verbatim
      const raw = existingRaw.get(key);
      if (raw) result.push(raw);
      continue;
    }

    // In both — find fields in existing but not in produced
    const missingFields: string[] = [];
    for (const fieldName of existingEntry.fields.keys()) {
      if (!producedEntry.fields.has(fieldName)) {
        missingFields.push(fieldName);
      }
    }

    const producedText = producedRaw.get(key);
    if (!producedText) {
      // Defensive fallback: emit existing raw text
      const raw = existingRaw.get(key);
      if (raw) result.push(raw);
      continue;
    }

    if (missingFields.length === 0) {
      // No missing fields → emit produced raw text (fields may have been updated)
      result.push(producedText);
    } else {
      // Splice missing fields from existing into produced
      const existingText = existingRaw.get(key);
      const fieldTexts: string[] = [];

      for (const fName of missingFields) {
        if (existingText) {
          const rawField = extractRawField(existingText, fName);
          if (rawField) {
            fieldTexts.push(rawField);
            continue;
          }
        }
        // Fallback: re-serialize with escapeBibtex + single braces
        const value = existingEntry.fields.get(fName) ?? '';
        const escapedValue = VERBATIM_BIBTEX_FIELDS.has(fName)
          ? value
          : escapeBibtex(value);
        fieldTexts.push(formatBibtexFieldLine(fName, escapedValue));
      }

      // Keep each entry internally consistent: a mixed-ending file must not
      // have its minority-convention entries rewritten to the majority one.
      // Only a newline at the entry's own level counts — one buried in a field
      // value is payload and says nothing about the entry's layout.
      const entryEol = detectEntryEol(producedText) ?? producedEol();
      result.push(spliceFieldsIntoEntry(producedText, fieldTexts, entryEol));
    }
  }

  // Append entries only in produced
  for (const key of producedParsed.keys()) {
    if (!emittedKeys.has(key)) {
      const raw = producedRaw.get(key);
      if (raw) result.push(raw);
    }
  }

  return result.join('\n\n');
}
