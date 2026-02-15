export interface Frontmatter {
  csl?: string;
  locale?: string;
  noteType?: number;
}

/**
 * Split YAML frontmatter (delimited by `---`) from the markdown body.
 * Returns the parsed metadata and the remaining body text.
 */
export function parseFrontmatter(markdown: string): { metadata: Frontmatter; body: string } {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return { metadata: {}, body: markdown };
  }

  const endMatch = trimmed.substring(3).match(/\n---(?:\r?\n|$)/);
  if (!endMatch) {
    return { metadata: {}, body: markdown };
  }
  const endIdx = endMatch.index! + 3;

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).replace(/^\r?\n/, '');

  const metadata: Frontmatter = {};
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    switch (key) {
      case 'csl':
        metadata.csl = value;
        break;
      case 'locale':
        metadata.locale = value;
        break;
      case 'note-type': {
        const n = parseInt(value, 10);
        if (!isNaN(n)) metadata.noteType = n;
        break;
      }
    }
  }

  return { metadata, body };
}

/**
 * Serialize a Frontmatter object to a YAML frontmatter string.
 * Returns empty string if metadata has no fields.
 */
export function serializeFrontmatter(metadata: Frontmatter): string {
  const lines: string[] = [];
  if (metadata.csl) lines.push(`csl: ${metadata.csl}`);
  if (metadata.locale) lines.push(`locale: ${metadata.locale}`);
  if (metadata.noteType !== undefined) lines.push(`note-type: ${metadata.noteType}`);
  if (lines.length === 0) return '';
  return '---\n' + lines.join('\n') + '\n---\n';
}
