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

function unescapeBibtexPunctuation(s: string): string {
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
function findEntryEnd(input: string, startPos: number): number {
  let braceCount = 1;
  let inQuotes = false;

  for (let j = startPos; j < input.length && braceCount > 0; j++) {
    const char = input[j];

    // Only toggle quote state at brace depth 1 (top-level field values).
    // Inside {…}-delimited values, " is a literal character in BibTeX.
    if (char === '"' && braceCount === 1) {
      let backslashCount = 0;
      const backslash = '\\';
      for (let k = j - 1; k >= 0 && input[k] === backslash; k--) {
        backslashCount++;
      }
      if (backslashCount % 2 === 0) {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          return j;
        }
      }
    }
  }

  return -1;
}

/** Parse BibTeX input, returning both the structured entries and raw entry
 *  texts in a single pass over the entry boundaries.  parseBibtex delegates
 *  here; mergeBibtex uses both the parsed and raw maps directly. */
function parseBibtexWithRaw(input: string): { parsed: Map<string, BibtexEntry>; raw: Map<string, string> } {
  const parsed = new Map<string, BibtexEntry>();
  const raw = new Map<string, string>();

  // Find entry boundaries more carefully
  const entryMatches = [...input.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)];

  // Track the end of the last successfully parsed entry so we can skip
  // spurious @type{key, matches inside field values (e.g. note fields
  // that reference other entries).
  let lastEntryEnd = 0;

  // NOTE: This regex handles nested braces only up to a small fixed depth
  // and backslash escapes within quoted strings (e.g. \").
  // If we need arbitrary nesting, replace with a balanced-brace field parser.
  const fieldRegex = /(\w+(?:-\w+)*)\s*=\s*(?:\{((?:[^{}]|\{(?:[^{}]|\{[^}]*\})*\})*)\}|"((?:\\.|[^"\\])*)"|(\w+))/g;

  for (const match of entryMatches) {
    if (match.index! < lastEntryEnd) continue;

    const [, type, key] = match;
    const entryStart = match.index!;
    const startPos = entryStart + match[0].length;

    const endPos = findEntryEnd(input, startPos);
    lastEntryEnd = (endPos === -1 ? startPos : endPos) + 1;
    if (endPos === -1) continue;

    // Raw entry text (preserves original formatting)
    raw.set(key, input.slice(entryStart, endPos + 1));

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

  return { parsed, raw };
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

/** Splice additional raw field lines into a produced entry's raw text,
 *  inserting them before the closing `}`. Ensures a trailing comma on the
 *  last existing field so the result remains valid BibTeX. */
export function spliceFieldsIntoEntry(producedRaw: string, fieldTexts: string[]): string {
  if (fieldTexts.length === 0) return producedRaw;

  const closingPos = producedRaw.lastIndexOf('}');
  if (closingPos === -1) return producedRaw;

  let before = producedRaw.slice(0, closingPos);
  const trimmed = before.trimEnd();

  // Ensure trailing comma on last produced field
  if (trimmed.length > 0 && !trimmed.endsWith(',') && !trimmed.endsWith('{')) {
    before = trimmed + ',\n';
  } else if (!before.endsWith('\n')) {
    before += '\n';
  }

  // Strip trailing comma from last spliced field for consistency with serializeBibtex
  const lastIdx = fieldTexts.length - 1;
  const cleaned = fieldTexts.map((ft, i) => {
    const t = ft.trimEnd();
    return i === lastIdx ? t.replace(/,$/, '') : t;
  });

  return before + cleaned.join('\n') + '\n}';
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
        fieldTexts.push('  ' + fName + ' = {' + escapedValue + '},');
      }

      result.push(spliceFieldsIntoEntry(producedText, fieldTexts));
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
