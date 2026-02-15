export interface BibtexEntry {
  type: string;
  key: string;
  fields: Map<string, string>;
  zoteroKey?: string;
  zoteroUri?: string;
}

function escapeBibtex(s: string): string {
  return s.replace(/([&%$#_{}~^\\])/g, '\\$1');
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
        const prevChar = j > 0 ? input[j - 1] : '';
        
        if (char === '"' && prevChar !== '\\') {
          inQuotes = !inQuotes;
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
      
      // Don't escape zotero-key values (alphanumeric identifiers)
      if (fieldName !== 'zotero-key') {
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
