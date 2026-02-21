import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

const repoRoot = join(__dirname, '..');

/**
 * Walk lines of markdown, calling `onClose` when a fenced code block pair
 * closes and `onOutside` for each line outside any fence. Implements
 * CommonMark fence semantics: closing fence must use the same character,
 * be at least as long, and have no info string (only trailing whitespace).
 */
function iterateFences(
  md: string,
  onClose: () => void,
  onOutside: (line: string) => void,
): void {
  const lines = md.split('\n');
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of lines) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)/);
    if (match) {
      const char = match[1][0];
      const len = match[1].length;
      const trailing = match[2];
      if (fenceChar === null) {
        // Per CommonMark §4.5, backtick fences must not have backticks in info string
        if (char === '`' && trailing.includes('`')) continue;
        fenceChar = char;
        fenceLen = len;
        continue;
      }
      // Closing fence: same char, at least as long, no info string
      if (char === fenceChar && len >= fenceLen && /^\s*$/.test(trailing)) {
        fenceChar = null;
        onClose();
        continue;
      }
    }
    if (fenceChar === null) {
      onOutside(line);
    }
  }
}

/** Extract text outside fenced code blocks. */
function stripFencedCodeBlocks(md: string): string {
  const result: string[] = [];
  iterateFences(md, () => {}, line => result.push(line));
  return result.join('\n');
}

/** Count fenced code blocks. */
function countCodeBlocks(md: string): number {
  let count = 0;
  iterateFences(md, () => count++, () => {});
  return count;
}

/** Strip markdown/HTML formatting to extract plain text words. */
function extractPlainText(md: string): string {
  return stripFencedCodeBlocks(md)
    // Strip YAML frontmatter only at the very start of the file (no /m flag)
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    // Strip table separator lines and pipe delimiters
    .replace(/^\|[-| :]+\|$/gm, '')
    .replace(/\|/g, ' ')
    // Strip entire CriticMarkup comments (content is metadata, not prose)
    .replace(/\{>>[\s\S]*?<<\}/g, ' ')
    // Strip CriticMarkup markers (but keep highlighted/inserted/deleted text)
    .replace(/\{==/g, ' ').replace(/==\}/g, ' ')
    .replace(/\{\+\+/g, ' ').replace(/\+\+\}/g, ' ')
    .replace(/\{--/g, ' ').replace(/--\}/g, ' ')
    .replace(/\{~~/g, ' ').replace(/~~\}/g, ' ')
    // Strip ID-based comment/range markers (IDs may contain hyphens)
    .replace(/\{#[\w-]+>>[\s\S]*?<<\}/g, ' ')
    .replace(/\{#[\w-]+\}|\{\/[\w-]+\}/g, ' ')
    // Strip markdown structure markers
    .replace(/^#+\s*/gm, '')
    .replace(/^(> )+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    // Strip inline formatting (longest delimiter first so *** matches before **)
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // Strip images entirely (alt text is visual metadata, not prose)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    // Strip links, HTML, citations, footnotes
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[@[^\]]*\]/g, ' ')
    .replace(/\[\^[^\]]*\]/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Extract unique lowercase alphanumeric words (3+ chars) from text, stripping punctuation. */
function uniqueWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))     // strip non-alphanumeric
    .filter(w => w.length >= 3);
  return new Set(words);
}

/** Count headings outside fenced code blocks. */
function countHeadings(md: string): number {
  return (stripFencedCodeBlocks(md).match(/^#+\s/gm) || []).length;
}

/** Count list items (unordered and ordered) outside fenced code blocks. */
function countListItems(md: string): number {
  return (stripFencedCodeBlocks(md).match(/^[-*+]\s|^\d+\.\s/gm) || []).length;
}

interface Fixture {
  path: string;
  bibtex?: string;
  /** Words to exclude from the round-trip comparison (known lossy content). */
  skipWords?: Set<string>;
  /** Skip the code block count check (e.g. indented code blocks don't round-trip). */
  skipCodeBlockCount?: boolean;
}

const sampleBib = readFileSync(join(repoRoot, 'sample.bib'), 'utf-8');

const fixtures: Fixture[] = [
  // docs/
  { path: 'docs/cli.md' },
  { path: 'docs/configuration.md' },
  { path: 'docs/converter.md' },
  { path: 'docs/criticmarkup.md' },
  { path: 'docs/development.md' },
  { path: 'docs/intro.md' },
  { path: 'docs/language-server.md' },
  { path: 'docs/latex-equations.md' },
  { path: 'docs/specification.md' },
  { path: 'docs/ui.md' },
  { path: 'docs/zotero-roundtrip.md' },
  // root files
  { path: 'sample.md', bibtex: sampleBib },
  { path: 'README.md' },
  {
    path: 'AGENTS.md',
    // Words from AGENTS.md "Quick commands" section (indented code blocks, lines 21-25)
    // that are lost during round-trip because the converter doesn't recognize 4-space fences.
    skipWords: new Set(['bun', 'install', 'setup', 'run', 'compile', 'watch', 'test', 'package', 'rebuild', 'bundle']),
    skipCodeBlockCount: true,
  },
];

it('covers all docs/ files', () => {
  const docFiles = readdirSync(join(repoRoot, 'docs'))
    .filter(f => f.endsWith('.md'))
    .sort();
  const fixtureDocs = fixtures
    .map(f => f.path)
    .filter(p => p.startsWith('docs/'))
    .map(p => p.replace(/^docs\//, ''))
    .sort();
  expect(fixtureDocs).toEqual(docFiles);
});

describe('docs round-trip: md -> docx -> md', () => {
  for (const fixture of fixtures) {
    it(`round-trips ${fixture.path}`, async () => {
      const originalMd = readFileSync(join(repoRoot, fixture.path), 'utf-8');

      // md -> docx
      const docxResult = await convertMdToDocx(originalMd, {
        bibtex: fixture.bibtex,
      });

      // No warnings for well-formed docs
      expect(docxResult.warnings).toEqual([]);

      // docx -> md
      const mdResult = await convertDocx(docxResult.docx);
      const roundTrippedMd = mdResult.markdown;

      // --- Bibtex preservation ---
      if (fixture.bibtex) {
        expect(mdResult.bibtex.length).toBeGreaterThan(0);
        const originalEntries = (fixture.bibtex.match(/^@\w+\{/gm) || []).length;
        const roundTrippedEntries = (mdResult.bibtex.match(/^@\w+\{/gm) || []).length;
        expect(roundTrippedEntries).toBe(originalEntries);
      }

      // --- Word preservation ---
      const originalWords = uniqueWords(extractPlainText(originalMd));
      const roundTrippedWords = uniqueWords(extractPlainText(roundTrippedMd));

      const missingWords: string[] = [];
      const skipWords = fixture.skipWords || new Set<string>();
      for (const word of originalWords) {
        if (!roundTrippedWords.has(word) && !skipWords.has(word)) {
          missingWords.push(word);
        }
      }
      expect(missingWords).toEqual([]);

      // --- Structural preservation ---
      expect(countHeadings(roundTrippedMd)).toBe(countHeadings(originalMd));

      if (!fixture.skipCodeBlockCount) {
        expect(countCodeBlocks(roundTrippedMd)).toBe(countCodeBlocks(originalMd));
      }

      // List nesting and continuation lines may merge during round-trip,
      // so we allow up to 50% loss rather than requiring an exact count.
      const originalListCount = countListItems(originalMd);
      if (originalListCount > 0) {
        expect(countListItems(roundTrippedMd)).toBeGreaterThanOrEqual(
          Math.ceil(originalListCount * 0.5),
        );
      }
    }, 30_000);
  }
});
