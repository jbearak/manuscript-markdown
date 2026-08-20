import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  BIBTEX_ENTRY_TEMPLATES,
  bibtexEntryCommand,
  bibtexEntrySnippet,
  bibtexInsertionPrefix,
} from './bibtex-entry-templates';
import { parseBibtexWithRaw, scanBibtexEntryBody } from './bibtex-parser';

/** Resolve a snippet to the literal text VS Code would insert with empty tabstops. */
function resolveSnippet(snippet: string): string {
  return snippet.replace(/\$\{1:key\}/g, 'key').replace(/\$\d+/g, '');
}

describe('bibtexEntrySnippet', () => {
  it('produces a parseable entry of the right type for every template', () => {
    for (const template of BIBTEX_ENTRY_TEMPLATES) {
      const text = resolveSnippet(bibtexEntrySnippet(template, '\n'));
      const parsed = parseBibtexWithRaw(text);
      expect([...parsed.parsed.keys()]).toEqual(['key']);
      // scanBibtexEntryBody takes exactly one entry with nothing after it,
      // so drop the snippet's trailing newline (which file insertion wants).
      const body = scanBibtexEntryBody(text.trimEnd());
      expect(body.unbalanced).toBe(false);
      expect(body.entryType?.raw).toBe(template.type);
      expect(body.fieldNames).toEqual([...template.fields]);
    }
  });

  it('numbers tabstops so the key comes first and each field follows in order', () => {
    const article = BIBTEX_ENTRY_TEMPLATES.find(t => t.type === 'article')!;
    const snippet = bibtexEntrySnippet(article, '\n');
    expect(snippet.startsWith('@article{${1:key},')).toBe(true);
    for (let i = 0; i < article.fields.length; i++) {
      expect(snippet).toContain('= {$' + String(i + 2) + '},');
    }
  });

  it('aligns the = signs by padding field names', () => {
    const article = BIBTEX_ENTRY_TEMPLATES.find(t => t.type === 'article')!;
    const lines = bibtexEntrySnippet(article, '\n').split('\n').slice(1, -2);
    const columns = new Set(lines.map(line => line.indexOf('=')));
    expect(columns.size).toBe(1);
  });

  it('uses the requested end-of-line sequence throughout', () => {
    const book = BIBTEX_ENTRY_TEMPLATES.find(t => t.type === 'book')!;
    const snippet = bibtexEntrySnippet(book, '\r\n');
    expect(snippet).toContain('\r\n');
    expect(snippet.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('bibtexInsertionPrefix', () => {
  it('adds nothing to an empty or whitespace-only file', () => {
    expect(bibtexInsertionPrefix('', '\n')).toBe('');
    expect(bibtexInsertionPrefix('  \n\n', '\n')).toBe('');
  });

  it('separates the new entry from existing text with one blank line', () => {
    expect(bibtexInsertionPrefix('@book{b,\n}', '\n')).toBe('\n\n');
    expect(bibtexInsertionPrefix('@book{b,\n}\n', '\n')).toBe('\n');
    expect(bibtexInsertionPrefix('@book{b,\n}\n\n', '\n')).toBe('');
    expect(bibtexInsertionPrefix('@book{b,\r\n}\r\n', '\r\n')).toBe('\r\n');
  });
});

describe('.bib toolbar contributions in package.json', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
  );

  it('declares one command per template, titled with its label and type', () => {
    const byId = new Map<string, any>(
      pkg.contributes.commands.map((c: any) => [c.command, c])
    );
    for (const template of BIBTEX_ENTRY_TEMPLATES) {
      const command = byId.get(bibtexEntryCommand(template.type));
      expect(command).toBeDefined();
      expect(command.title).toBe('Add ' + template.label + ' (@' + template.type + ')');
    }
  });

  it('reuses the Export to Word icon on the bibtex.actions submenu', () => {
    const submenu = pkg.contributes.submenus.find((s: any) => s.id === 'bibtex.actions');
    const exportSubmenu = pkg.contributes.submenus.find(
      (s: any) => s.id === 'markdown.exportDocx'
    );
    expect(submenu.icon).toBe(exportSubmenu.icon);
  });

  it('shows the toolbar button only on .bib files outside diff editors', () => {
    const entry = pkg.contributes.menus['editor/title'].find(
      (m: any) => m.submenu === 'bibtex.actions'
    );
    expect(entry.when).toBe('resourceExtname == .bib && !isInDiffEditor');
  });

  it('groups the sync command apart from the add-entry commands', () => {
    const entries = pkg.contributes.menus['bibtex.actions'];
    const sync = entries.find(
      (m: any) => m.command === 'manuscript-markdown.syncBibliographyFromZotero'
    );
    expect(sync.group).toBe('1_zotero@1');
    const addGroups = BIBTEX_ENTRY_TEMPLATES.map((template, i) => {
      const entry = entries.find((m: any) => m.command === bibtexEntryCommand(template.type));
      expect(entry).toBeDefined();
      return entry.group === '2_add@' + String(i + 1);
    });
    expect(addGroups.every(Boolean)).toBe(true);
  });
});
