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
      let fieldMatch;
      
      while ((fieldMatch = fieldRegex.exec(fieldsStr)) !== null) {
        const [, fieldName, braceValue, quoteValue, bareValue] = fieldMatch;
        const value = braceValue || quoteValue || bareValue || '';
        fields.set(fieldName.toLowerCase(), unescapeBibtex(value));
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
