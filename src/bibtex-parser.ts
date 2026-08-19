// --- Implementation notes ---
// - Verbatim fields: DOI, URL, ISBN, ISSN must not be LaTeX-escaped (see VERBATIM_BIBTEX_FIELDS)
// - Entry scanning: count consecutive preceding backslashes before `"` to detect quote-state correctly
// - Scanner literals: compare input[k] against '\\' (one char), not '\\\\' (two-char runtime string)

export interface BibtexEntry {
  type: string;
  key: string;
  fields: Map<string, string>;
  zoteroKey?: string;
  zoteroUri?: string;
}

/** BibTeX fields whose values are verbatim identifiers (URLs, DOIs, etc.)
 *  that must not be LaTeX-escaped. */
const VERBATIM_BIBTEX_FIELDS: ReadonlySet<string> = new Set([
  'doi', 'url', 'isbn', 'issn', 'file',
]);

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

function escapeBibtex(s: string): string {
  // Unescape first to avoid double-escaping on round-trips (idempotent)
  return unescapeBibtex(s).replace(/([&%$#_{}~^\\])/g, '\\$1');
}

function unescapeBibtex(s: string): string {
  return s.replace(/\\([&%$#_{}~^\\])/g, '$1');
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

/** True if a construct header — `@type{` or `@type(` — starts at `pos`.
 *  A bare `@` is not one: it turns up in email addresses and prose, and
 *  treating it as a boundary cuts a scan short in text BibTeX ignores. */
function isConstructHeaderAt(text: string, pos: number): boolean {
  if (text[pos] !== '@') return false;
  let i = pos + 1;
  while (i < text.length && /\w/.test(text[i])) i++;
  if (i === pos + 1) return false;
  while (i < text.length && /\s/.test(text[i])) i++;
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
  const crlfCount = text.split('\r\n').length - 1;
  const bareLfCount = (text.split('\n').length - 1) - crlfCount;
  if (crlfCount !== bareLfCount) return crlfCount > bareLfCount ? '\r\n' : '\n';
  if (crlfCount === 0) return '\n';

  // Tie: find a newline that is provably *between* top-level constructs
  // rather than inside one.  Entry boundaries have to come from the scanner,
  // not a bare regex — a regex happily matches `@book{fake,` sitting inside an
  // `@comment` body and would then read that comment's line ending as the
  // document's.  Only reached on a tie, so the extra scan is rare.
  const { ranges } = parseBibtexWithRaw(text);
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range.trusted) continue;
    // Walk only the ignored text touching the boundary.  Jumping to the next
    // newline *anywhere* after the entry would happily land inside the
    // following construct and report its interior line ending as the file's.
    const after = scanForwardForNewline(text, range.end);
    if (after !== null) return after;
    // Scanning backwards is only sound before the first construct: further in,
    // the preceding construct's interior is in the way, and its gap was already
    // covered by that construct's own forward scan.
    if (i > 0) continue;
    const before = scanBackwardForNewline(text, range.start - 1);
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
  // Ranges found after sync is lost are still reported — navigation wants
  // them — but marked untrusted, because a recovered `@book{...}` may really
  // be sitting inside another entry's field value.
  let synced = true;

  // author/editor use inner {Name} braces as a semantic signal for
  // institutional/literal names (Req 2.3), so do NOT strip outer braces
  // for those fields — only strip for non-name fields (title, journal, etc.)
  const AUTHOR_FIELDS = new Set(['author', 'editor']);

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
        const value = (braceValue !== undefined
          ? unescapeBibtex(AUTHOR_FIELDS.has(lowerField) ? braceValue : stripOuterBraces(braceValue))
          : unescapeBibtex(quoteValue ?? bareValue ?? ''));
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

  return { parsed, raw, ranges, rangesTrusted: synced };
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

      // Don't escape verbatim identifier fields or zotero-key
      if (fieldName !== 'zotero-key' && !VERBATIM_BIBTEX_FIELDS.has(fieldName)) {
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
  eol: BibtexEol = detectEntryEol(producedRaw) ?? '\n',
): string {
  if (fieldTexts.length === 0) return producedRaw;

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
  // an entry that does have one is authoritative about its own layout.
  const producedEol = detectBibtexEol(produced);
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
        const escapedValue = VERBATIM_BIBTEX_FIELDS.has(fName) || fName === 'zotero-key'
          ? value
          : escapeBibtex(value);
        fieldTexts.push('  ' + fName + ' = {' + escapedValue + '},');
      }

      // Keep each entry internally consistent: a mixed-ending file must not
      // have its minority-convention entries rewritten to the majority one.
      // Only a newline at the entry's own level counts — one buried in a field
      // value is payload and says nothing about the entry's layout.
      const entryEol = detectEntryEol(producedText) ?? producedEol;
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
