export type NoteType = 'in-text' | 'footnotes' | 'endnotes';

const NOTE_TYPE_NAMES: Record<string, NoteType> = {
  'in-text': 'in-text',
  'footnotes': 'footnotes',
  'endnotes': 'endnotes',
  '0': 'in-text',
  '1': 'footnotes',
  '2': 'endnotes',
};

const NOTE_TYPE_TO_NUMBER: Record<NoteType, number> = {
  'in-text': 0,
  'footnotes': 1,
  'endnotes': 2,
};

export function noteTypeFromNumber(n: number): NoteType {
  if (n === 1) return 'footnotes';
  if (n === 2) return 'endnotes';
  return 'in-text';
}

export function noteTypeToNumber(nt: NoteType): number {
  return NOTE_TYPE_TO_NUMBER[nt];
}

export interface Frontmatter {
  title?: string[];
  author?: string;
  csl?: string;
  locale?: string;
  noteType?: NoteType;
  timezone?: string;
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
      case 'title':
        if (!metadata.title) metadata.title = [];
        metadata.title.push(value);
        break;
      case 'author':
        if (value) metadata.author = value;
        break;
      case 'csl':
        metadata.csl = value;
        break;
      case 'locale':
        metadata.locale = value;
        break;
      case 'note-type': {
        const nt = NOTE_TYPE_NAMES[value];
        if (nt) metadata.noteType = nt;
        break;
      }
      case 'timezone':
        if (value && /^[+-]\d{2}:\d{2}$/.test(value)) metadata.timezone = value;
        break;
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
  if (metadata.title && metadata.title.length > 0) {
    for (const t of metadata.title) {
      lines.push(`title: ${t}`);
    }
  }
  if (metadata.author) lines.push(`author: ${metadata.author}`);
  if (metadata.csl) lines.push(`csl: ${metadata.csl}`);
  if (metadata.locale) lines.push(`locale: ${metadata.locale}`);
  if (metadata.noteType) lines.push(`note-type: ${metadata.noteType}`);
  if (metadata.timezone) lines.push(`timezone: ${metadata.timezone}`);
  if (lines.length === 0) return '';
  return '---\n' + lines.join('\n') + '\n---\n';
}
