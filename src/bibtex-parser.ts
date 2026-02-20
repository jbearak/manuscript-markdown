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
  'doi', 'url', 'isbn', 'issn',
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

export function parseBibtex(input: string): Map<string, BibtexEntry> {
  const entries = new Map<string, BibtexEntry>();
  
  // Find entry boundaries more carefully
  const entryMatches = [...input.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)];
  
  for (let i = 0; i < entryMatches.length; i++) {
    try {
      const match = entryMatches[i];
      const [, type, key] = match;
      const startPos = match.index! + match[0].length;
      
      // Find the end of this entry by counting braces
      let braceCount = 1;
      let endPos = startPos;
      let inQuotes = false;
      
      for (let j = startPos; j < input.length && braceCount > 0; j++) {
        const char = input[j];
        
        if (char === '\"') {
          // Toggle quote state only when preceded by an even number of backslashes.
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
              endPos = j;
              break;
            }
          }
        }
      }
      
      // Skip if we couldn't find a proper closing brace
      if (braceCount > 0) {
        continue;
      }
      
      const fieldsStr = input.slice(startPos, endPos);
      const fields = new Map<string, string>();
      
      // Parse fields more carefully
      // NOTE: This regex handles nested braces only up to a small fixed depth.
      // If we need arbitrary nesting, replace with a balanced-brace field parser.
      const fieldRegex = /(\w+(?:-\w+)*)\s*=\s*(?:\{((?:[^{}]|\{(?:[^{}]|\{[^}]*\})*\})*)\}|"([^"]*)"|(\w+))/g;
      // author/editor use inner {Name} braces as a semantic signal for
      // institutional/literal names (Req 2.3), so do NOT strip outer braces
      // for those fields — only strip for non-name fields (title, journal, etc.)
      const AUTHOR_FIELDS = new Set(['author', 'editor']);
      let fieldMatch;
      
      while ((fieldMatch = fieldRegex.exec(fieldsStr)) !== null) {
        const [, fieldName, braceValue, quoteValue, bareValue] = fieldMatch;
        const lowerField = fieldName.toLowerCase();
        const value = (braceValue !== undefined
          ? unescapeBibtex(AUTHOR_FIELDS.has(lowerField) ? braceValue : stripOuterBraces(braceValue))
          : unescapeBibtex(quoteValue ?? bareValue ?? ''));
        fields.set(lowerField, value);
      }
      
      const entry: BibtexEntry = {
        type: type.toLowerCase(),
        key,
        fields,
        zoteroKey: fields.get('zotero-key'),
        zoteroUri: fields.get('zotero-uri')
      };
      
      entries.set(key, entry);
    } catch {
      // Skip malformed entries
    }
  }
  
  return entries;
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
