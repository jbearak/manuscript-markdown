import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

const repoRoot = join(__dirname, '..');

/**
 * Extract text outside fenced code blocks. Content inside ``` or ~~~ fences
 * is excluded because code examples may contain syntax that doesn't
 * round-trip as prose. Implements CommonMark fence semantics: a closing fence
 * must use the same character and be at least as long as the opening fence.
 */
function stripFencedCodeBlocks(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of lines) {
    const match = line.match(/^(`{3,}|~{3,})/);
    if (match) {
      const char = match[1][0];
      const len = match[1].length;
      if (fenceChar === null) {
        // Opening fence
        fenceChar = char;
        fenceLen = len;
        continue;
      }
      if (char === fenceChar && len >= fenceLen) {
        // Closing fence (same char, at least as long)
        fenceChar = null;
        continue;
      }
    }
    if (fenceChar === null) {
      result.push(line);
    }
  }
  return result.join('\n');
}

/** Strip markdown/HTML formatting to extract plain text words. */
function extractPlainText(md: string): string {
  return stripFencedCodeBlocks(md)
    // Strip YAML frontmatter only at the very start of the file (no /m flag)
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
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
    // Strip ID-based comment/range markers
    .replace(/\{#\w+>>[\s\S]*?<<\}/g, ' ')
    .replace(/\{#\w+\}|\{\/\w+\}/g, ' ')
    // Strip markdown structure markers
    .replace(/^#+\s*/gm, '')
    .replace(/^(> )+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    // Strip inline formatting
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
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

/** Count fenced code blocks using fence-aware parsing. */
function countCodeBlocks(md: string): number {
  const lines = md.split('\n');
  let count = 0;
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of lines) {
    const match = line.match(/^(`{3,}|~{3,})/);
    if (match) {
      const char = match[1][0];
      const len = match[1].length;
      if (fenceChar === null) {
        fenceChar = char;
        fenceLen = len;
      } else if (char === fenceChar && len >= fenceLen) {
        fenceChar = null;
        count++;
      }
    }
  }
  return count;
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
    // Indented code blocks (4-space indent) are not recognized by the converter
    skipWords: new Set(['bun', 'install', 'setup', 'run', 'compile', 'watch', 'test', 'package', 'rebuild', 'bundle']),
    skipCodeBlockCount: true,
  },
];

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

      const listPattern = /^[-*]\s|^\d+\.\s/m;
      const originalHasLists = listPattern.test(stripFencedCodeBlocks(originalMd));
      if (originalHasLists) {
        expect(listPattern.test(stripFencedCodeBlocks(roundTrippedMd))).toBe(true);
      }
    }, 30_000);
  }
});
