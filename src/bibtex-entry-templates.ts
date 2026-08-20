// Pure templates for the "Add <entry type>" commands on the .bib toolbar.
// Each template lists the standard fields for its BibTeX entry type; the
// snippet places the cursor on the citation key first, then tabs through
// the empty field values. Keep this module free of vscode imports so the
// snippet text stays unit-testable.

export interface BibtexEntryTemplate {
  /** BibTeX entry type, lowercase, without the leading `@`. */
  readonly type: string;
  /** Plain-language name shown in menu labels ("Journal Article"). */
  readonly label: string;
  /** Standard fields, in the order they are scaffolded. */
  readonly fields: readonly string[];
}

export const BIBTEX_ENTRY_TEMPLATES: readonly BibtexEntryTemplate[] = [
  {
    type: 'article',
    label: 'Journal Article',
    fields: ['author', 'title', 'journal', 'year', 'volume', 'number', 'pages', 'doi'],
  },
  {
    type: 'book',
    label: 'Book',
    fields: ['author', 'title', 'publisher', 'address', 'year', 'isbn'],
  },
  {
    type: 'incollection',
    label: 'Book Chapter',
    fields: ['author', 'title', 'booktitle', 'editor', 'publisher', 'address', 'pages', 'year'],
  },
  {
    type: 'inproceedings',
    label: 'Conference Paper',
    fields: ['author', 'title', 'booktitle', 'year', 'pages', 'doi'],
  },
  {
    type: 'techreport',
    label: 'Report',
    fields: ['author', 'title', 'institution', 'number', 'year', 'url'],
  },
  {
    type: 'misc',
    label: 'Miscellaneous Entry',
    fields: ['author', 'title', 'year', 'url'],
  },
];

/** Command id for a template's insert command (must match package.json). */
export function bibtexEntryCommand(type: string): string {
  return 'manuscript-markdown.addBibtexEntry.' + type;
}

/**
 * VS Code snippet text for one entry: tabstop 1 selects the placeholder
 * citation key, then one tabstop per empty field value. Field names are
 * padded so the `=` signs align, matching hand-written .bib style.
 */
export function bibtexEntrySnippet(template: BibtexEntryTemplate, eol: string): string {
  const width = Math.max(...template.fields.map(f => f.length));
  const lines = template.fields.map(
    (field, i) => '  ' + field.padEnd(width) + ' = {' + '$' + String(i + 2) + '},'
  );
  return '@' + template.type + '{' + '${1:key},' + eol + lines.join(eol) + eol + '}' + eol;
}

/**
 * Text to emit before a new entry appended at the end of a .bib file so the
 * entry starts on its own line with one blank line separating it from the
 * previous entry.
 */
export function bibtexInsertionPrefix(text: string, eol: string): string {
  if (text.trim() === '') return '';
  const trailing = text.match(/(?:\r?\n)*$/)![0];
  const newlines = trailing.split(/\r?\n/).length - 1;
  return eol.repeat(Math.max(0, 2 - newlines));
}
