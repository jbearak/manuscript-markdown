// --- Implementation notes ---
// - Verbatim fields bypass whitespace collapsing, brace stripping, TeX decoding, NFC normalization, and serialization escaping.
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

/** Remove every brace pair that wraps the whole value, tolerating whitespace
 *  between layers (`{ {x} }`), in linear time.
 *
 *  `stripOuterBraces` rescans from the start for each pair it removes, so
 *  calling it in a loop is quadratic — a value wrapped in tens of thousands of
 *  pairs would block a command for seconds.  Instead every brace is paired
 *  with its partner once, up front, and layers are peeled by moving a window
 *  inward.
 *
 *  The pairing is explicit — each opener matched to its own closer — because
 *  every shortcut tried here has credited a leading brace with a closer that
 *  belonged to a different brace, turning `{10.1/a}{b}` into a manufactured
 *  value.  On unbalanced input nothing is stripped, since pairing is
 *  meaningless there.  A differential test in bibtex-parser.test.ts holds this
 *  function to `stripOuterBraces` looped to a fixed point. */
export function stripWrappingBraces(value: string): string {
  // closerOf[i] = index of the closer paired with the opener at index i.
  const closerOf = new Map<number, number>();
  const openers: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '{') openers.push(i);
    else if (value[i] === '}') {
      const opener = openers.pop();
      if (opener === undefined) return value;
      closerOf.set(opener, i);
    }
  }
  if (openers.length > 0) return value;

  let lo = 0;
  let hi = value.length;
  for (;;) {
    while (lo < hi && /\s/.test(value[lo])) lo++;
    while (hi > lo && /\s/.test(value[hi - 1])) hi--;
    // The window is wrapped exactly when its first character is an opener
    // whose own closer is its last character.
    if (value[lo] !== '{' || closerOf.get(lo) !== hi - 1) break;
    lo++;
    hi--;
  }
  return value.slice(lo, hi);
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

/** A field's whitespace as BibTeX reads it: each run of spaces, tabs and
 *  line ends one space, and none at either end, so a value wrapped across
 *  lines reads as one line, not with its indentation. A no-break space
 *  written as itself stays. A note keeps its line ends, though not the
 *  spaces around them: Zotero keeps its Extra field there, which citeproc
 *  reads a line at a time, as `original-date: 1850`. */
function collapseBibtexWhitespace(fieldName: string, value: string): string {
  if (fieldName === 'note') {
    // Without its blank lines at its edges, which go from the lines rather
    // than by a regex for the line ends there, which read the rest of a run
    // of them again from each one in it
    const lines = value.split(/\r\n?|\n/).map(line => line.replace(/[ \t\f]+/g, ' ').replace(/^ | $/g, ''));
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start] === '') start++;
    while (end > start && lines[end - 1] === '') end--;
    return lines.slice(start, end).join('\n');
  }
  return value.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ | $/g, '');
}

function decodeBibtexFieldValue(
  fieldName: string,
  value: string,
  braceDelimited: boolean,
): string {
  if (VERBATIM_BIBTEX_FIELDS.has(fieldName)) return value;

  // Before the braces around the value come off, and again after, as their
  // text has its own edges, as in {{ Title }}
  const collapsed = collapseBibtexWhitespace(fieldName, value);
  const semanticValue = braceDelimited && !AUTHOR_FIELDS.has(fieldName)
    ? collapseBibtexWhitespace(fieldName, stripOuterBraces(collapsed))
    : collapsed;
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

/** Whether a backslash escapes the character at `index`: an odd run of
 *  them right before it */
function isEscapedAt(text: string, index: number): boolean {
  let k = index - 1;
  while (k >= 0 && text[k] === '\\') k--;
  return (index - 1 - k) % 2 === 1;
}

/** For each " in `text`, the index of the " that ends a quoted field value
 *  opened there, or -1 where none does, as BibTeX reads it: the next " outside
 *  the value's groups, as a group keeps a " in it, as in "a {"} b", that no
 *  odd run of backslashes escapes, as in "a \" b". Every brace counts, an
 *  escaped one too, as BibTeX counts them, but a } with no { open in the value
 *  takes none off. readEntryEnds, detectEntryEol and readBibtexFields all end a
 *  quoted value here, so they read an entry's body the same way.
 *
 *  Every " is read as one that opens a value, in one pass from the left, as
 *  readBibtexFields tries one at each it comes to where a value it tried
 *  doesn't end, and reading on from each would read the rest of the text again
 *  each time. With the brace height the count of {s less }s before a point, a
 *  value's depth is its height less the lowest height since it opened, as a }
 *  at depth 0 takes none off. So a " ends every value still open that opened
 *  after the last point lower than it, and those are the last opened. -1
 *  where no " is. */
export function quotedValueEnds(text: string): Int32Array {
  const ends = new Int32Array(text.length).fill(-1);
  // The points before this one each lower than all after it, from the left,
  // and their heights: the last is the last point lower than this one, once
  // those no lower than it are gone
  const lower: number[] = [];
  const lowerHeights: number[] = [];
  // The "s whose values haven't ended, from the left
  const open: number[] = [];
  let height = 0;
  let backslashes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') height++;
    else if (c === '}') height--;
    while (lowerHeights.length > 0 && lowerHeights[lowerHeights.length - 1] >= height) {
      lower.pop();
      lowerHeights.pop();
    }
    if (c === '"') {
      if (backslashes % 2 === 0) {
        const below = lower.length > 0 ? lower[lower.length - 1] : -1;
        while (open.length > 0 && open[open.length - 1] > below) ends[open.pop()!] = i;
      }
      open.push(i);
    }
    lower.push(i);
    lowerHeights.push(height);
    backslashes = c === '\\' ? backslashes + 1 : 0;
  }
  return ends;
}

/** Find the closing `}` of a BibTeX entry body, handling nested braces and
 *  quoted strings.  `startPos` is the position just after the `@type{key,`
 *  header (i.e. the first character of the field area).
 *  Returns the index of the closing `}`, or -1 if unmatched.  `quoteEnds`
 *  gives where each quoted value in `input` ends (see quotedValueEnds), read
 *  once for all the input's entries.
 *
 *  It counts `\{`/`\}` escapes as real braces, as BibTeX does, and as
 *  the field reader (readBibtexFields) and extractRawField, which follows
 *  it, do.  scanBibtexEntryBody reads them as escapes, and finds an entry
 *  whose fields that reading reads otherwise unbalanced. */
function findEntryEnd(
  input: string,
  startPos: number,
  closer: '}' | ')',
  quoteEnds: () => Int32Array,
): number {
  // Field values are always brace-delimited, whatever encloses the entry, so
  // brace depth is tracked on its own.  For a paren entry the two are genuinely
  // independent: a `(` or `)` inside `title = {Analysis (Part I}` is ordinary
  // text with no obligation to balance, and folding it into one counter both
  // swallows valid entries and truncates others at the wrong place.
  let braceDepth = 0;
  // Only meaningful for a paren entry; a brace entry closes on braceDepth.
  let parenDepth = 1;
  const atTopLevel = () => (closer === ')' ? parenDepth === 1 && braceDepth === 0 : braceDepth === 0);

  for (let j = startPos; j < input.length; j++) {
    const char = input[j];

    if (char === '"' && atTopLevel() && !isEscapedAt(input, j)) {
      // A quoted value, only at the entry's top level (field values live
      // there).  Inside {…}-delimited values, " is a literal character.  Its
      // braces do not change the entry's own nesting — `title = "a }
      // brace"` must not close the entry (see quotedValueEnds).
      j = quoteEnds()[j];
      if (j === -1) return -1;
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

/** For each `open` in `text`, the index of the `close` that pairs with it,
 *  or -1, every one counted, an escaped one too, as BibTeX counts braces */
function delimiterCloses(text: string, open: '{' | '(', close: '}' | ')'): Int32Array {
  const closes = new Int32Array(text.length).fill(-1);
  const opens: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === open) opens.push(i);
    else if (text[i] === close && opens.length > 0) closes[opens.pop()!] = i;
  }
  return closes;
}

/** Where the entries of `input` end, read once for all of them: what
 *  readEntryEnds returns */
export interface BibtexEntryEnds {
  /** The closing `}` or `)` of an entry body that starts at `startPos`, just
   *  after the `@type{key,` header, or -1 if unmatched */
  body(startPos: number, closer: '}' | ')'): number;
  /** The closing delimiter of an `@comment` whose opening one is at `at`,
   *  counting delimiters only, or -1 if unmatched.  A comment is arbitrary
   *  prose, so an apostrophe or a lone `"` in it is ordinary text — applying
   *  field-value quote semantics here would swallow the closing delimiter and
   *  make a balanced comment look unterminated. */
  comment(at: number, closer: '}' | ')'): number;
}

/** Where the entries of `input` end, as findEntryEnd and findCommentEnd
 *  find it, from wherever they start. Each is scanned from its start, which
 *  reads each entry that ends once; but one that doesn't end is read to the
 *  input's end, and recovery then tries the next at each line start, so many
 *  such entries took time in the square of the input's length. After the
 *  first that doesn't end, each end is looked up in tables read for every
 *  index at once (`scanFirst` false: from the start), which take memory in
 *  the input's length, so they're read only then.
 *
 *  A body's end in a table: at the body's own level, a group goes to the
 *  `}` that pairs with its `{`, every brace counted, as findEntryEnd counts
 *  them; a quoted value to the `"` that ends it (see quotedValueEnds); and in
 *  a paren entry, a `(` to the `)` that pairs with it at its level, past
 *  groups, where `"` is text, and a `}` with no `{` open is nothing. Where
 *  any of them doesn't end, the body doesn't, and otherwise it ends where the
 *  body from past it ends, so the table is read from the right. A comment's
 *  end is the delimiter that pairs with its opening one. */
export function readEntryEnds(input: string, scanFirst = true): BibtexEntryEnds {
  let quoteEnds: Int32Array | undefined;
  const inputQuoteEnds = () => (quoteEnds ??= quotedValueEnds(input));
  let tables = !scanFirst;
  let braceCloses: Int32Array | undefined;
  let parenCloses: Int32Array | undefined;
  let braceBodyEnds: Int32Array | undefined;
  let parenBodyEnds: Int32Array | undefined;
  const bodyEnds = (parens: boolean): Int32Array => {
    const closes = (braceCloses ??= delimiterCloses(input, '{', '}'));
    const quotes = inputQuoteEnds();
    const n = input.length;
    const ends = new Int32Array(n + 1).fill(-1);
    // In a paren entry, the first ) from each index at its level, where " is
    // text, as in a pair of parens in the body
    const firstClose = parens ? new Int32Array(n + 1).fill(-1) : undefined;
    for (let i = n - 1; i >= 0; i--) {
      const c = input[i];
      if (c === (parens ? ')' : '}')) {
        ends[i] = i;
        if (firstClose) firstClose[i] = i;
        continue;
      }
      // Past what starts here: a group, or a pair of parens, whole, or 0
      // where it doesn't end
      let past = i + 1;
      if (c === '{') past = closes[i] + 1;
      else if (firstClose && c === '(') past = firstClose[i + 1] + 1;
      if (firstClose) firstClose[i] = past > i ? firstClose[past] : -1;
      if (c === '"' && !isEscapedAt(input, i)) past = quotes[i] + 1;
      ends[i] = past > i ? ends[past] : -1;
    }
    return ends;
  };
  return {
    body: (startPos, closer) => {
      if (!tables) {
        const end = findEntryEnd(input, startPos, closer, inputQuoteEnds);
        tables = end < 0;
        return end;
      }
      return closer === '}'
        ? (braceBodyEnds ??= bodyEnds(false))[startPos]
        : (parenBodyEnds ??= bodyEnds(true))[startPos];
    },
    comment: (at, closer) => {
      if (!tables) {
        const end = findCommentEnd(input, at + 1, closer);
        tables = end < 0;
        return end;
      }
      return closer === '}'
        ? (braceCloses ??= delimiterCloses(input, '{', '}'))[at]
        : (parenCloses ??= delimiterCloses(input, '(', ')'))[at];
    },
  };
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
    else if (!inComment && ch === '@') {
      // A construct header complete before the line's end (see
      // readEntryHeader). A bare @ is none: it turns up in e-mail addresses
      // and prose, and treating it as a boundary cuts the walk short in text
      // BibTeX ignores. The scanner reads a header across a line end, as
      // `@book\n{k, …}` is one entry, but this walk mustn't, as it would pass
      // the very line end it's for; where they differ it stops at that line
      // end, the answer it wants anyway. What the header's reading passed
      // holds no line end or %, so the walk goes on after it.
      const header = readEntryHeader(text, i, true);
      if ('type' in header) return null;
      i = header.resume - 1;
    }
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
  let quoteEnds: Int32Array | undefined;

  for (let i = 0; i < entryText.length; i++) {
    const ch = entryText[i];

    if (!started) {
      // The header is at the entry's level too: `@article\n{k, ...}` counts.
      if (ch === '\n') return entryText[i - 1] === '\r' ? '\r\n' : '\n';
      if (ch === '{' || ch === '(') started = true;
      continue;
    }

    if (ch === '"' && braceDepth === 0 && !isEscapedAt(entryText, i)) {
      // A quoted value, whose line ends are its payload (see quotedValueEnds)
      quoteEnds ??= quotedValueEnds(entryText);
      const close = quoteEnds[i];
      if (close === -1) return null;
      i = close;
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
  /** The names of the fields the entry gives more than once, in lower case,
   *  in the order of each one's second, or undefined where it gives none
   *  twice. The parser reads the last value of each, as biber reads it:
   *  Text::BibTeX stores each value under its name in turn (btxs_support.c),
   *  and biber's bibtex.pm reads the one stored. BibTeX reads the first and
   *  warns of the rest ("I'm ignoring k's extra "title" field", bibtex.web), so
   *  the two read such an entry otherwise. */
  repeatedFields?: string[];
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
  /** Where each @string declaration is, in source order, of those read
   *  while the scan is in sync, so none is text in another construct */
  strings: Array<{ start: number; end: number }>;
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

const WHITE_SPACE = /\s/;
const SAME_LINE_WHITE_SPACE = /[ \t]/;

/** The header of the entry, or the command, as `@comment`, whose @ is at
 *  `at` in `text`, as bibtex.web reads one (get_bib_command_or_entry_and_process):
 *  white space after the @, its type, an identifier (see
 *  BIBTEX_IDENTIFIER_CHAR), white space, and its { or (, so `@my-type{` and
 *  `@ article (` are headers, and `@2article{` none. With `sameLine`, white
 *  space is a space or a tab. Where there's no header, `resume` is where
 *  the next could start: past the type read, as BibTeX reads on from there,
 *  so each character is read once. An @ in the type, which BibTeX reads in
 *  an identifier, would start a header only where this one does, with the
 *  same type's end, unless this one's starts with a digit, where it reads
 *  none, and the next is looked for right after the @. */
export function readEntryHeader(text: string, at: number, sameLine = false):
  { type: string; typeStart: number; opener: '{' | '('; end: number } | { resume: number } {
  const white = sameLine ? SAME_LINE_WHITE_SPACE : WHITE_SPACE;
  let i = at + 1;
  while (i < text.length && white.test(text[i])) i++;
  ENTRY_TYPE_AT.lastIndex = i;
  const type = ENTRY_TYPE_AT.exec(text)?.[0];
  if (!type) return { resume: at + 1 };
  let j = i + type.length;
  while (j < text.length && white.test(text[j])) j++;
  const opener = text[j];
  return opener === '{' || opener === '(' ? { type, typeStart: i, opener, end: j + 1 } : { resume: i + type.length };
}

/** A citation key, as BibTeX and biber both read one: after the white
 *  space after the entry's opener, a run of characters to white space, a
 *  comma or the entry's closer, with no @ in it. BibTeX reads a key to white
 *  space, a comma or, in a brace entry, the } (bibtex.web's
 *  scan2_white(comma, right_brace); in a paren entry, scan1_white(comma)),
 *  so it reads an @ in one; biber (btparse's NAME token, which a key is)
 *  reads none, so `@article{` with no key and `@book{b,` on the next line
 *  are an entry b, not an entry keyed `@book{b`. In a paren entry the )
 *  ends a key, as in btparse, where BibTeX reads it in the key. After the
 *  key and any white space, a comma starts the entry's fields, or the
 *  closer ends it with none, as BibTeX reads `@article{k}`. The parser
 *  reads keys so (see scanBibtex), and with it where an entry's body
 *  starts, which the tables of where entries end read from (see
 *  readEntryEnds), and so does the walk Zotero link edits by (see
 *  scanBibtexEntryBody). A Markdown citation can cite any such key with no
 *  ;, ] or backtick in it (see isCitableKey). */
const ENTRY_KEY_AT = { '}': /\s*([^\s,@}]+)\s*([,}])/y, ')': /\s*([^\s,@)]+)\s*([,)])/y };

/** The key of the entry whose opener is just before `at` in `text`, and
 *  where it starts, and where the entry's body does: just past the comma
 *  after the key, or at the closer, for an entry with no fields; or
 *  undefined where the entry has no key (see ENTRY_KEY_AT) */
export function readEntryKey(text: string, at: number, closer: '}' | ')'): { key: string; keyStart: number; bodyStart: number } | undefined {
  const keyAt = ENTRY_KEY_AT[closer];
  keyAt.lastIndex = at;
  const match = keyAt.exec(text);
  if (!match) return undefined;
  const keyStart = at + match[0].indexOf(match[1]);
  const end = at + match[0].length;
  return { key: match[1], keyStart, bodyStart: match[2] === ',' ? end : end - 1 };
}

/** Parse BibTeX input, returning both the structured entries and raw entry
 *  texts in a single pass over the entry boundaries.  parseBibtex delegates
 *  here; mergeBibtex uses both the parsed and raw maps directly. */
/** A character BibTeX reads in an identifier, as an entry's type, a field's
 *  name or a macro's, as bibtex.web's id_class has it: any but the ASCII
 *  control characters, the space, ", #, %, ', (, ), the comma, =, { and },
 *  so a letter of any language, a digit, and :, +, ., /, @, \ and the like
 *  too. An identifier doesn't start with a digit (scan_identifier). Every
 *  reader of a .bib file's fields reads names and bare values so: the
 *  parser, the body walk Zotero link edits by (see scanBibtexEntryBody),
 *  extractRawField and mergeBibtex, which copy what the parser reads, and
 *  the indentation an added field takes (see detectBibtexFieldIndent);
 *  and every reader of an entry's header reads its type so (see
 *  readEntryHeader). A space other than ASCII's, as a no-break space, which BibTeX reads in
 *  an identifier, is a space to the parser, as \s is to its patterns, so
 *  it ends one; the body walk refuses an entry that has one between its
 *  fields, which BibTeX reads otherwise. */
export const BIBTEX_IDENTIFIER_CHAR = '[^\\s\\x00-\\x1f"#%\'(),={}]';
// A run of them, read whole, a field's name where it doesn't start with a
// digit, and the = after it; and a bare value, a number, its digits, as
// BibTeX scans one, or a macro's name
const IDENTIFIER_RUN_AT = new RegExp(BIBTEX_IDENTIFIER_CHAR + '+', 'y');
const FIELD_EQUALS_AT = /\s*=\s*/y;
const BARE_VALUE_AT = new RegExp('[0-9]+|' + BIBTEX_IDENTIFIER_CHAR + '+', 'y');
// An entry's type, as readEntryHeader reads it: an identifier, not
// starting with a digit
const ENTRY_TYPE_AT = new RegExp('(?![0-9])' + BIBTEX_IDENTIFIER_CHAR + '+', 'y');

/**
 * An entry body's fields, as `name = {value}`, `name = "value"` or
 * `name = value`, from the left, each where the last ends, past what's
 * between them, as commas, and anything else that isn't one. A braced value
 * goes to the } that pairs with its {, however deep its groups nest, every
 * brace counted, an escaped one too, as BibTeX counts them, and as
 * readEntryEnds does, so the two read a body the same way. A quoted one goes
 * to the " that ends it as readEntryEnds reads it (see quotedValueEnds), the
 * next one outside its groups. Where a value doesn't end, there's no field at its name, and
 * the search goes on after the name, into the value, as the regex this
 * replaced searched. In one pass, with each { paired once: the regex read
 * braces only three deep, with the field's, and a value long enough it gave
 * up on, so the entry lost the rest of the field, or all its fields.
 */
export function readBibtexFields(body: string): Array<{ name: string; value: string; braced: boolean }> {
  return readBibtexFieldRanges(body).map(({ name, value, braced }) => ({ name, value, braced }));
}

/** A field readBibtexFields reads, with where its name starts in the body
 *  (`nameStart`) and the index of its value's last character (`end`), its }
 *  or ", or a bare value's last; and its value as BibTeX reads it, each part
 *  of a concatenation, as "a" # b, as written (`parts`), its braces or
 *  quotes too, of which the parser's value is the first */
interface BibtexFieldRange {
  name: string;
  value: string;
  braced: boolean;
  nameStart: number;
  end: number;
  parts: string[];
}

// The # between the parts of a concatenation, with the whitespace around it
const CONCATENATION_AT = /\s*#\s*/y;

/** readBibtexFields' fields, with where each is in the body */
function readBibtexFieldRanges(body: string): BibtexFieldRange[] {
  const fields: BibtexFieldRange[] = [];
  // The } that pairs with each {, or -1
  const closes = delimiterCloses(body, '{', '}');
  let quoteEnds: Int32Array | undefined;
  // The index of the last character of the value that starts at `start`,
  // its } or ", or a bare value's last, or -1 where none does
  const valueEnd = (start: number): number => {
    if (body[start] === '{') return closes[start];
    if (body[start] === '"') {
      quoteEnds ??= quotedValueEnds(body);
      return quoteEnds[start];
    }
    BARE_VALUE_AT.lastIndex = start;
    const bare = BARE_VALUE_AT.exec(body);
    return bare ? start + bare[0].length - 1 : -1;
  };
  let i = 0;
  while (i < body.length) {
    // Each run of an identifier's characters read whole, from its start, as
    // BibTeX reads a name, so :doi is a name, not doi
    IDENTIFIER_RUN_AT.lastIndex = i;
    const name = IDENTIFIER_RUN_AT.exec(body)?.[0];
    if (!name) {
      i++;
      continue;
    }
    const nameEnd = i + name.length;
    FIELD_EQUALS_AT.lastIndex = nameEnd;
    const equals = FIELD_EQUALS_AT.exec(body);
    const start = nameEnd + (equals?.[0].length ?? 0);
    const end = equals ? valueEnd(start) : -1;
    if (end < 0) {
      i = nameEnd;
      continue;
    }
    const delimited = body[start] === '{' || body[start] === '"';
    const value = delimited ? body.slice(start + 1, end) : body.slice(start, end + 1);
    // The parts after the first, which BibTeX reads as the value's, so the
    // parser goes on after them, and takes nothing in them for a field, as
    // the doi in note = 2020 # {doi = a}
    const parts = [body.slice(start, end + 1)];
    let last = end;
    for (;;) {
      CONCATENATION_AT.lastIndex = last + 1;
      const hash = CONCATENATION_AT.exec(body);
      const next = hash ? last + 1 + hash[0].length : -1;
      const nextEnd = hash && next < body.length ? valueEnd(next) : -1;
      if (nextEnd < 0) break;
      parts.push(body.slice(next, nextEnd + 1));
      last = nextEnd;
    }
    // A run that starts with a digit is no name, as BibTeX reads none, but
    // its value is read past all the same, so nothing in it reads as a field
    if (!/[0-9]/.test(name[0])) fields.push({ name, value, braced: body[start] === '{', nameStart: i, end, parts });
    i = last + 1;
    // The rest of the run a number starts, as title in 2020title=x, or .1/a
    // in 10.1/a, which BibTeX reads as an error, and no name in, as no
    // reader that reads a run whole does
    IDENTIFIER_RUN_AT.lastIndex = i;
    if (/[0-9]/.test(body[last])) i += IDENTIFIER_RUN_AT.exec(body)?.[0].length ?? 0;
  }
  return fields;
}

export function parseBibtexWithRaw(input: string): ParsedBibtexWithRaw {
  return scanBibtex(input);
}

/** The scan itself.  Separate from `parseBibtexWithRaw` only so the construct
 *  boundaries stay off the public result — see `ScannedBibtex`. */
function scanBibtex(input: string): ScannedBibtex {
  const parsed = new Map<string, BibtexEntry>();
  const raw = new Map<string, string>();
  const ranges: BibtexSourceRange[] = [];
  const strings: ScannedBibtex['strings'] = [];

  // Scan sequentially rather than pre-collecting every `@type{key,` match:
  // only a scan that has consumed everything before a given `@` knows whether
  // that `@` is at the top level or buried in someone's field value.
  // BibTeX accepts either delimiter around an entry body, and skipping the
  // paren form would leave a paren `@comment`'s contents exposed as entries.
  // The next header from `from`, at an @ (see readEntryHeader)
  const nextHeader = (from: number) => {
    for (let at = input.indexOf('@', from); at !== -1;) {
      const header = readEntryHeader(input, at);
      if ('type' in header) return { at, ...header };
      at = input.indexOf('@', header.resume);
    }
    return undefined;
  };
  // Where each entry ends, read once for all of them
  const entryEnds = readEntryEnds(input);

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

  while (pos < input.length) {
    const header = nextHeader(pos);
    if (!header) break;

    const entryStart = header.at;
    const afterBrace = header.end;
    const type = header.type;
    const closer: '}' | ')' = header.opener === '(' ? ')' : '}';

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
        ? entryEnds.comment(afterBrace - 1, closer)
        : entryEnds.body(afterBrace, closer);
      if (close === -1) {
        // Unterminated declaration — fall back to line-start recovery.
        pos = afterBrace;
        requireLineStart = true;
        synced = false;
      } else {
        pos = close + 1;
        requireLineStart = false;
        if (synced) constructEnds.push(pos);
        if (synced && lowerType === 'string') strings.push({ start: entryStart, end: close + 1 });
      }
      continue;
    }

    const keyRead = readEntryKey(input, afterBrace, closer);
    if (!keyRead) {
      // `@type{` opened but the header has no citation key.  Consume its
      // balanced body rather than scanning into it — the `@book{...}` sitting
      // in a field of a malformed entry is that entry's data, not an entry.
      const close = entryEnds.body(afterBrace, closer);
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

    const { key, keyStart, bodyStart: startPos } = keyRead;

    const endPos = entryEnds.body(startPos, closer);
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
    const range: BibtexSourceRange = {
      key, start: entryStart, end: endPos + 1,
      keyStart, keyEnd: keyStart + key.length,
      trusted: synced,
    };
    ranges.push(range);

    // Parsed entry
    try {
      const fieldsStr = input.slice(startPos, endPos);
      const fields = new Map<string, string>();
      const repeated = new Set<string>();

      for (const field of readBibtexFields(fieldsStr)) {
        const lowerField = field.name.toLowerCase();
        // The last value of a field given more than once is the one read (see
        // BibtexSourceRange.repeatedFields)
        if (fields.has(lowerField)) repeated.add(lowerField);
        fields.set(lowerField, decodeBibtexFieldValue(lowerField, field.value, field.braced));
      }
      if (repeated.size > 0) range.repeatedFields = Array.from(repeated);

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

  return { parsed, raw, ranges, rangesTrusted: synced, constructEnds, strings };
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

/** Where the fields of the entry `rawEntry` starts with start, after its
 *  key and the comma after it, or at its closer where it has none, as the
 *  parser reads its header and key (see readEntryHeader and readEntryKey);
 *  or undefined where the parser reads none */
function entryBodyStart(rawEntry: string): number | undefined {
  const header = rawEntry[0] === '@' ? readEntryHeader(rawEntry, 0) : undefined;
  return header && 'type' in header ? readEntryKey(rawEntry, header.end, header.opener === '(' ? ')' : '}')?.bodyStart : undefined;
}

/** A single field of an entry as a line of its own, in the form
 *  `spliceFieldsIntoEntry` expects, e.g. `  title = {{My Title}},`, at
 *  `indent` — or null if the field is not found.
 *
 *  The field is the one the parser reads, the last of a repeated name, as
 *  the parser keeps the last, written again from the parser's reading of
 *  it, wherever it is in the entry, on a line of its own or not: its name as
 *  written, and its value as BibTeX reads it, in braces or quotes as it was,
 *  to the } or " the parser ends it at (see readBibtexFields), every brace
 *  counted, an escaped one too, and a " in a group kept, as BibTeX reads
 *  them; or a number or a macro, as `month = jan`, as it was, not braced,
 *  which would make the macro text; and each part of a concatenation, as
 *  `"a" # b`. So mergeBibtex, which copies the field into another entry,
 *  copies the value BibTeX read, which reads the same there. `rawEntry`
 *  must be an exact parsed entry range, as `raw.get(key)`. */
export function extractRawField(rawEntry: string, fieldName: string, indent = detectBibtexFieldIndent(rawEntry)): string | null {
  const field = readEntryFields(rawEntry)?.get(fieldName.toLowerCase());
  return field ? bibtexFieldLine(field, indent) : null;
}

/** An entry's fields as the parser reads them (see extractRawField), by
 *  name, lowercased, each the last of a repeated name, read once for all of
 *  them; or undefined where the parser reads no header */
function readEntryFields(rawEntry: string): Map<string, BibtexFieldRange> | undefined {
  const bodyStart = entryBodyStart(rawEntry);
  if (bodyStart === undefined) return undefined;
  const fields = new Map<string, BibtexFieldRange>();
  for (const read of readBibtexFieldRanges(rawEntry.slice(bodyStart, -1))) fields.set(read.name.toLowerCase(), read);
  return fields;
}

/** A field, as the parser read it, written again (see extractRawField) */
function bibtexFieldLine(field: BibtexFieldRange, indent: string): string {
  return indent + field.name + ' = ' + field.parts.join(' # ') + ',';
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
   *  stray delimiter left brace depth or a quote open — or if the parser, whose
   *  fields a citation shows, reads the entry's fields otherwise: a value that
   *  ends elsewhere, a name read in part, as `doi` of `:doi`, or a field in
   *  what the walk took for a stray value.  The range's boundaries then do not
   *  mean what they appear to, or an edit by offset changes another field than
   *  the one the parser reads, and nothing may be spliced into it. */
  readonly unbalanced: boolean;
  /** The entry-type token (`article` in `@article{...`), with its half-open
   *  offsets within the scanned text, so a caller rewriting the type replaces
   *  exactly the token the walk read rather than re-deriving the header
   *  grammar.  Undefined when the text does not start with an entry header. */
  readonly entryType?: { readonly raw: string; readonly start: number; readonly end: number };
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
  /** Half-open offsets of the value within the scanned entry text, delimiters
   *  included for brace/quote values.  Replacing exactly this slice rewrites
   *  the value while leaving the field name's own spelling and the
   *  surrounding layout untouched. */
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** What may appear in a field name.  BibTeX names are far more permissive than
 *  the identifiers they usually are: everything up to the next separator is
 *  part of the name, so `:doi`, `+doi`, `.doi` and `@doi` are all names in
 *  their own right.
 *
 *  Defined by exclusion, and deliberately so.  A caller matches on these names
 *  to decide whether an entry carries an identifier, and every character
 *  wrongly left out of a name splits it — reading `:doi` as `doi` invents a
 *  DOI field the file does not have.  The characters are BibTeX's, and the
 *  parser's (see BIBTEX_IDENTIFIER_CHAR), so the walk and the parser read
 *  the same names; what ends one includes whitespace, the `=` that follows
 *  it, the `,` between fields, the value delimiters, and the `#`/`%` the
 *  surrounding walk must still see. */
const NAME_CHAR_RE = new RegExp(BIBTEX_IDENTIFIER_CHAR);
const NAME_START_RE = NAME_CHAR_RE;
// The spaces BibTeX reads between the parts of an entry, and the line ends
// it reads as one; any other, as a no-break space, it reads in a name or a
// macro's, where the parser reads a space, so the walk refuses it
const SPACE_RE = /[\t\n\r ]/;

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

  // Its header as the parser reads it (see readEntryHeader)
  const read = rawEntry[0] === '@' ? readEntryHeader(rawEntry, 0) : undefined;
  const header = read && 'type' in read ? read : undefined;
  const entryType = header
    ? { raw: header.type, start: header.typeStart, end: header.typeStart + header.type.length }
    : undefined;

  const result = (): BibtexEntryBodyScan => ({
    hasTopLevelComment,
    hasConcatenation,
    fieldNames: fields.map(f => f.name),
    fields,
    unbalanced,
    ...(entryType !== undefined ? { entryType } : {}),
  });

  // The body starts after the key, as the parser reads it (see
  // readEntryKey): past its comma, or at the closer, for an entry with no
  // fields, as `@article{k}`.
  const key = header ? readEntryKey(rawEntry, header.end, header.opener === '(' ? ')' : '}') : undefined;
  if (!key) return result();

  // Stop before the closing delimiter, which is the last character of an exact
  // entry range.
  const end = rawEntry.length - 1;
  let i = key.bodyStart;

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

  /** End of the `"…"` value at `at` as a reader that lets a backslash escape
   *  any character reads it, or -1.  A `{…}` group inside protects a literal
   *  quote, so its braces belong to the value, not to the entry — but a `}`
   *  with no `{` open is unbalanced to every reader, and BibTeX itself reports
   *  it, so the value has no agreed end. */
  const quoteEnd = (at: number): number => {
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

  // Where each quoted value ends as BibTeX and the parser read it
  let bibtexQuoteEnds: Int32Array | undefined;

  /** Consume a `"…"` value from `at`, returning the offset just past its
   *  closing quote, or -1 if the readings of it disagree, as for a braced
   *  value: the one above, and BibTeX's (see quotedValueEnds), which counts
   *  an escaped brace as a brace, so `"a \{ b"` doesn't end at its last `"`,
   *  which is in the group `\{` opens. */
  const skipQuoted = (at: number): number => {
    const escaped = quoteEnd(at);
    bibtexQuoteEnds ??= quotedValueEnds(rawEntry);
    return escaped === bibtexQuoteEnds[at] + 1 ? escaped : -1;
  };

  /** Consume whatever value begins at `at`, recording it under `name`.
   *  Returns the offset just past it, or -1 if it never closes. */
  const readValue = (name: string, at: number): number => {
    const ch = rawEntry[at];
    if (ch === '{') {
      const close = skipBraced(at);
      if (close === -1) return -1;
      fields.push({
        name,
        value: rawEntry.slice(at + 1, close - 1),
        delimiter: 'brace',
        valueStart: at,
        valueEnd: close,
      });
      return close;
    }
    if (ch === '"') {
      const close = skipQuoted(at);
      if (close === -1) return -1;
      fields.push({
        name,
        value: rawEntry.slice(at + 1, close - 1),
        delimiter: 'quote',
        valueStart: at,
        valueEnd: close,
      });
      return close;
    }
    let bareEnd = at;
    while (bareEnd < end && NAME_CHAR_RE.test(rawEntry[bareEnd])) bareEnd++;
    if (bareEnd === at) return at;
    fields.push({
      name,
      value: rawEntry.slice(at, bareEnd),
      delimiter: 'bare',
      valueStart: at,
      valueEnd: bareEnd,
    });
    return bareEnd;
  };

  // Whether a value, or the operand of a concatenation, ended last, which
  // BibTeX reads only a `,`, a `#` or the entry's end after, and whether a
  // `#` came last, which an operand comes after; and after a comma, a field
  // or the entry's end: anything else, a `name =` with no value too, is text
  // BibTeX reads as an error, after which it reads none of the entry, where
  // the parser reads on, so the entry isn't edited. Once a `%` is read, the
  // entry is refused for it (see hasTopLevelComment), which other readers
  // read as a comment, so the text after it isn't held to this.
  let afterValue = false;
  let afterHash = false;
  const misread = (): boolean => !hasTopLevelComment;

  // Every value is consumed whole by `readValue`, so the loop itself only ever
  // stands at the entry's own lexical level.
  while (i < end) {
    const ch = rawEntry[i];
    if (misread() && (afterValue
      ? !SPACE_RE.test(ch) && ch !== ',' && ch !== '#' && ch !== '%'
      : ch === ',' || ch === '#')) {
      unbalanced = true;
      break;
    }
    if (ch === ',') afterValue = false;

    if (ch === '%' && !isEscaped(i)) {
      hasTopLevelComment = true;
    } else if (ch === '#' && !isEscaped(i)) {
      hasConcatenation = true;
      afterValue = false;
      afterHash = true;
    } else if (ch === '{' || ch === '"') {
      // A delimited run with no `name =` before it: the second operand of a
      // concatenation, or a stray.  It still has to close.
      const close = ch === '{' ? skipBraced(i) : skipQuoted(i);
      if (close === -1 || (!afterHash && misread())) {
        unbalanced = true;
        break;
      }
      i = close;
      afterValue = true;
      afterHash = false;
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
        // A bare operand of a concatenation, or a word that is no field's
        if (!afterHash && misread()) {
          unbalanced = true;
          break;
        }
        i = nameEnd;
        afterValue = true;
        afterHash = false;
        continue;
      }
      let valueStart = after + 1;
      while (valueStart < end && SPACE_RE.test(rawEntry[valueStart])) valueStart++;
      const next = readValue(rawEntry.slice(i, nameEnd).toLowerCase(), valueStart);
      if (next === -1 || (next === valueStart && misread())) {
        unbalanced = true;
        break;
      }
      i = next;
      afterValue = true;
      afterHash = false;
      continue;
    } else if (!SPACE_RE.test(ch) && ch !== ',' && misread()) {
      // A character that starts no field, value or name, as an = or a (
      unbalanced = true;
      break;
    }
    i++;
  }

  if (!unbalanced && afterHash && misread()) unbalanced = true;
  if (!unbalanced && !readsAsParserDoes(rawEntry, fields)) unbalanced = true;
  return result();
}

/** Whether the parser reads an entry's fields as the body walk read them
 *  (`fields`): the same names, as the walk lowercases them, and values, at
 *  the same offsets (see readBibtexFields) */
function readsAsParserDoes(rawEntry: string, fields: readonly BibtexEntryFieldOccurrence[]): boolean {
  const bodyStart = entryBodyStart(rawEntry);
  if (bodyStart === undefined) return fields.length === 0;
  const parsed = readBibtexFieldRanges(rawEntry.slice(bodyStart, -1));
  return parsed.length === fields.length && parsed.every((field, k) =>
    field.name.toLowerCase() === fields[k].name
    && field.value === fields[k].value
    && bodyStart + field.end + 1 === fields[k].valueEnd);
}

/** Indentation of an entry's existing field lines, so an inserted field sits
 *  with them rather than announcing itself.  Two spaces — this codebase's
 *  generated BibTeX — is the fallback for an entry written on one line. */
const FIELD_LINE_RE = new RegExp('\\n([ \\t]+)(?![0-9])' + BIBTEX_IDENTIFIER_CHAR + '+[ \\t]*=');

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
 *  last existing field, and a comma between the lines spliced, whether a
 *  line ends in one or not, so the result remains valid BibTeX.
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
  // The text before the closer ends in the opener's character where the
  // entry has no key and no fields, as `@article{}`, which takes no comma;
  // but also where it has no fields and its key ends in that character, as
  // `k(` in `@article(k()` (see readEntryKey), which a comma must follow.
  const opener = closer === ')' ? '(' : '{';
  const header = producedRaw[0] === '@' ? readEntryHeader(producedRaw, 0) : undefined;
  const key = header && 'type' in header && header.opener === opener ? readEntryKey(producedRaw, header.end, closer) : undefined;
  const endsInKey = key !== undefined && key.keyStart + key.key.length === trimmed.length;
  const needsComma =
    trimmed.length > 0 && !trimmed.endsWith(',') && (!trimmed.endsWith(opener) || endsInKey);
  const body = needsComma ? trimmed + ',' + head.slice(trimmed.length) : head;
  const before = body + (body.endsWith('\n') ? '' : eol);

  // Each line's own comma off, and one between each two, so the last has
  // none, for consistency with serializeBibtex
  const cleaned = fieldTexts.map(ft => ft.trimEnd().replace(/,$/, ''));

  return before + cleaned.join(',' + eol) + eol + closer;
}

/** Merge an existing .bib (from disk) with a produced .bib (from conversion).
 *  - Existing-only entries are preserved verbatim.
 *  - Entries in both: produced text wins, but existing-only fields are spliced in.
 *  - An entry whose key the existing file gives more than once goes where
 *    the last was, whose text and fields the parser keeps.
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
  const existingResult = scanBibtex(existing);
  const producedResult = parseBibtexWithRaw(produced);
  const existingParsed = existingResult.parsed;
  const producedParsed = producedResult.parsed;
  const existingRaw = existingResult.raw;
  const producedRaw = producedResult.raw;

  const result: string[] = [];
  const emittedKeys = new Set<string>();

  // The existing file's @string declarations, as written, each before the
  // first entry that came after it there, so BibTeX reads each macro an
  // entry uses, a field copied into a merged entry too, as the existing
  // file declared it where it read that entry. Without them, it warns that
  // the macro is undefined and drops the field's text.
  const declarations = existingResult.strings;
  // Where each key's last entry starts, whose text and fields the parser
  // keeps, so a key the file gives more than once goes where its kept text
  // was, after each declaration the file has before it, and the entries
  // between keep their places and the macros they read
  const entryStarts = new Map<string, number>();
  for (const range of existingResult.ranges) entryStarts.set(range.key, range.start);
  const existingKeys = existingResult.ranges.filter(range => entryStarts.get(range.key) === range.start && existingParsed.has(range.key)).map(range => range.key);
  let declared = 0;
  const declareBefore = (at: number) => {
    for (; declared < declarations.length && declarations[declared].start < at; declared++) {
      result.push(existing.slice(declarations[declared].start, declarations[declared].end));
    }
  };

  // Iterate existing entries in their original order, each at its last
  for (const key of existingKeys) {
    const existingEntry = existingParsed.get(key)!;
    emittedKeys.add(key);
    declareBefore(entryStarts.get(key) ?? existing.length);

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
      // Splice missing fields from existing into produced, each at the
      // produced entry's indentation
      const existingText = existingRaw.get(key);
      const fieldTexts: string[] = [];
      const indent = detectBibtexFieldIndent(producedText);
      const existingFields = existingText === undefined ? undefined : readEntryFields(existingText);

      for (const fName of missingFields) {
        const field = existingFields?.get(fName.toLowerCase());
        if (field) {
          fieldTexts.push(bibtexFieldLine(field, indent));
          continue;
        }
        // Fallback: re-serialize with escapeBibtex + single braces
        const value = existingEntry.fields.get(fName) ?? '';
        const escapedValue = VERBATIM_BIBTEX_FIELDS.has(fName)
          ? value
          : escapeBibtex(value);
        fieldTexts.push(formatBibtexFieldLine(fName, escapedValue, indent));
      }

      // Keep each entry internally consistent: a mixed-ending file must not
      // have its minority-convention entries rewritten to the majority one.
      // Only a newline at the entry's own level counts — one buried in a field
      // value is payload and says nothing about the entry's layout.
      const entryEol = detectEntryEol(producedText) ?? producedEol();
      result.push(spliceFieldsIntoEntry(producedText, fieldTexts, entryEol));
    }
  }

  declareBefore(existing.length);

  // Append entries only in produced
  for (const key of producedParsed.keys()) {
    if (!emittedKeys.has(key)) {
      const raw = producedRaw.get(key);
      if (raw) result.push(raw);
    }
  }

  return result.join('\n\n');
}
