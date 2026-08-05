import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { extractCriticMarkupPatterns } from './test-helpers';

const repoRoot = join(__dirname, '..');

/**
 * Walk lines of markdown, calling `onClose` when a fenced code block pair
 * closes and `onOutside` for each line outside any code block. Handles both
 * fenced code blocks (CommonMark §4.5) and indented code blocks (§4.4).
 * Fenced: closing fence must use the same character, be at least as long,
 * and have no info string. Indented: 4+ leading spaces after a blank line.
 */
function iterateFences(
  md: string,
  onClose: () => void,
  onOutside: (line: string) => void,
): void {
  const lines = md.split('\n');
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let inIndentedBlock = false;
  let prevBlank = true; // start of document counts as blank
  for (const line of lines) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)/);
    if (match) {
      const char = match[1][0];
      const len = match[1].length;
      const trailing = match[2];
      if (fenceChar === null && !(char === '`' && trailing.includes('`'))) {
        // Per CommonMark §4.5, backtick fences must not have backticks in info string
        fenceChar = char;
        fenceLen = len;
        if (inIndentedBlock) {
          inIndentedBlock = false;
          onClose();
        }
        continue;
      }
      // Closing fence: same char, at least as long, no info string
      if (char === fenceChar && len >= fenceLen && /^\s*$/.test(trailing)) {
        fenceChar = null;
        prevBlank = false; // closing fence is not a blank line
        onClose();
        continue;
      }
    }
    if (fenceChar === null) {
      const isBlank = /^\s*$/.test(line);
      const isIndented = !isBlank && /^ {4,}/.test(line);
      if (inIndentedBlock) {
        if (!isIndented && !isBlank) {
          inIndentedBlock = false;
          onClose();
          onOutside(line);
        }
        // else: still in indented code block, skip
      } else if (prevBlank && isIndented) {
        inIndentedBlock = true;
        // skip — indented code block line
      } else {
        onOutside(line);
      }
      prevBlank = isBlank;
    }
  }
  if (inIndentedBlock) {
    onClose();
  }
}

/** Extract text outside fenced code blocks. */
function stripFencedCodeBlocks(md: string): string {
  const result: string[] = [];
  iterateFences(md, () => {}, line => result.push(line));
  return result.join('\n');
}

/** Count fenced and indented code blocks. */
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
    // Strip display math blocks (content is LaTeX, not prose)
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    // Strip inline math (content is LaTeX, not prose)
    .replace(/\$[^$]+\$/g, ' ')
    // Strip table separator lines and pipe delimiters
    .replace(/^\|[-| :]+\|$/gm, '')
    .replace(/\|/g, ' ')
    // Strip entire CriticMarkup comments (content is metadata, not prose)
    .replace(/\{>>[\s\S]*?<<\}/g, ' ')
    // Strip CriticMarkup deletions entirely (deleted text doesn't survive round-trip)
    .replace(/\{--[\s\S]*?--\}/g, ' ')
    // Strip CriticMarkup substitutions, keeping only the new text
    .replace(/\{~~[\s\S]*?~>([\s\S]*?)~~\}/g, '$1')
    // Strip CriticMarkup markers (keep highlighted/inserted text)
    .replace(/\{==/g, ' ').replace(/==\}/g, ' ')
    .replace(/\{\+\+/g, ' ').replace(/\+\+\}/g, ' ')
    .replace(/\{~~/g, ' ').replace(/~~\}/g, ' ')
    // Strip highlight color suffixes like {yellow}, {red}, etc.
    .replace(/\{[a-z]+\}/g, ' ')
    // Strip ID-based comment/range markers (IDs may contain hyphens)
    .replace(/\{#[\w-]+>>[\s\S]*?<<\}/g, ' ')
    .replace(/\{#[\w-]+\}|\{\/[\w-]+\}/g, ' ')
    // Strip markdown structure markers
    .replace(/^#+\s*/gm, '')
    .replace(/^(> )+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    // Strip inline formatting (longest delimiter first so *** matches before **)
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // Strip images entirely (alt text is visual metadata, not prose)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    // Strip links, HTML, citations (both [@key] and [-@key] forms), footnotes
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[-?@[^\]]*\]/g, ' ')
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
}

const sampleBib = readFileSync(join(repoRoot, 'sample.bib'), 'utf-8');

const fixtures: Fixture[] = [
  // docs/
  { path: 'docs/cli.md' },
  { path: 'docs/configuration.md' },
  { path: 'docs/converter.md' },
  { path: 'docs/criticmarkup.md' },
  { path: 'docs/development.md' },
  { path: 'docs/embedded-tables.md' },
  { path: 'docs/intro.md' },
  { path: 'docs/language-server.md' },
  { path: 'docs/latex-equations.md' },
  { path: 'docs/specification.md' },
  { path: 'docs/ui.md' },
  { path: 'docs/zotero-roundtrip.md' },
  // root files
  { path: 'sample.md', bibtex: sampleBib },
  { path: 'README.md' },
  { path: 'AGENTS.md' },
  // test fixtures
  { path: 'test/fixtures/tables.md' },
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

      // No unexpected warnings for well-formed docs (list item block content
      // and remote-image warnings are expected — see Known Limitations in
      // specification.md and image-roundtrip requirements)
      const unexpectedWarnings = docxResult.warnings.filter(
        (w: string) => !w.includes('inside list item dropped during conversion') &&
                       !w.includes('Continuation paragraph inside list item dropped') &&
                       !w.includes('is a URL or data URI; only local file paths are supported'),
      );
      expect(unexpectedWarnings).toEqual([]);

      // docx -> md
      const mdResult = await convertDocx(docxResult.docx);
      const roundTrippedMd = mdResult.markdown;

      // --- Bibtex preservation ---
      if (fixture.bibtex) {
        // Layer 1 stores full .bib in custom properties — exact equality.
        expect(mdResult.bibtex).toBe(fixture.bibtex);
      }

      // --- Word preservation ---
      const originalWords = uniqueWords(extractPlainText(originalMd));
      const roundTrippedWords = uniqueWords(extractPlainText(roundTrippedMd));

      const missingWords: string[] = [];
      for (const word of originalWords) {
        if (!roundTrippedWords.has(word)) {
          missingWords.push(word);
        }
      }
      expect(missingWords).toEqual([]);

      // --- Structural preservation ---
      expect(countHeadings(roundTrippedMd)).toBe(countHeadings(originalMd));

      expect(countCodeBlocks(roundTrippedMd)).toBe(countCodeBlocks(originalMd));

      // List nesting and continuation lines may merge during round-trip,
      // so we allow up to 50% loss rather than requiring an exact count.
      const originalListCount = countListItems(originalMd);
      if (originalListCount > 0) {
        expect(countListItems(roundTrippedMd)).toBeGreaterThanOrEqual(
          Math.ceil(originalListCount * 0.5),
        );
      }

      // --- CriticMarkup revision preservation ---
      // Verify that revision CriticMarkup (addition, deletion, substitution)
      // survives the round-trip. Only check that some revisions exist if the
      // original had any — exact count may differ because adjacent
      // deletion+addition can be merged into a substitution.
      // Strip code blocks and inline code so documentation examples are excluded.
      const stripCode = (s: string) =>
        stripFencedCodeBlocks(s).replace(/`[^`]+`/g, '');
      const revisionTypes = new Set(['addition', 'deletion', 'substitution']);
      const originalRevisions = extractCriticMarkupPatterns(stripCode(originalMd))
        .filter(p => revisionTypes.has(p.type));
      if (originalRevisions.length > 0) {
        const roundTrippedRevisions = extractCriticMarkupPatterns(stripCode(roundTrippedMd))
          .filter(p => revisionTypes.has(p.type));
        expect(roundTrippedRevisions.length).toBeGreaterThan(0);
      }
    }, 30_000);
  }
});

describe('tables.md exact fidelity: pipe and grid tables round-trip byte-for-byte', () => {
  const tablesMd = readFileSync(join(repoRoot, 'test/fixtures/tables.md'), 'utf-8');

  // Extract sections by heading
  const sections = tablesMd.split(/^(?=## )/m);
  const pipeSection = sections.find(s => s.startsWith('## Pipe Table'));
  const gridSection = sections.find(s => s.startsWith('## Grid Table'));
  expect(pipeSection).toBeDefined();
  expect(gridSection).toBeDefined();

  it('pipe table separator and column widths survive round-trip exactly', async () => {
    const docx = await convertMdToDocx(tablesMd);
    expect(docx.warnings).toEqual([]);
    const rt = await convertDocx(docx.docx);

    const rtSections = rt.markdown.split(/^(?=## )/m);
    const rtPipeSection = rtSections.find(s => s.startsWith('## Pipe Table'));
    expect(rtPipeSection).toBeDefined();
    expect(rtPipeSection).toBe(pipeSection);
  }, 30_000);

  it('grid table column widths survive round-trip exactly', async () => {
    const docx = await convertMdToDocx(tablesMd);
    expect(docx.warnings).toEqual([]);
    const rt = await convertDocx(docx.docx);

    const rtSections = rt.markdown.split(/^(?=## )/m);
    const rtGridSection = rtSections.find(s => s.startsWith('## Grid Table'));
    expect(rtGridSection).toBeDefined();
    expect(rtGridSection).toBe(gridSection);
  }, 30_000);
});

describe('CriticMarkup round-trip: md -> docx -> md', () => {
  // Only addition, deletion, and substitution faithfully round-trip as CriticMarkup.
  // Highlights lose curly braces ({==...==} → ==...==) and standalone comments
  // are transformed into Word comments with author/timestamp metadata.
  const revisionCases = [
    { name: 'addition', md: 'Before {++inserted text++} after.' },
    { name: 'deletion', md: 'Before {--removed text--} after.' },
    { name: 'substitution', md: 'Before {~~old phrase~>new phrase~~} after.' },
    { name: 'mixed revisions', md: '{++added++} and {--deleted--} and {~~was~>now~~}.' },
  ];

  for (const tc of revisionCases) {
    it('preserves ' + tc.name + ' CriticMarkup through round-trip', async () => {
      const { docx, warnings } = await convertMdToDocx(tc.md);
      expect(warnings).toEqual([]);
      const rt = await convertDocx(docx);

      const original = extractCriticMarkupPatterns(tc.md);
      const roundTripped = extractCriticMarkupPatterns(rt.markdown);

      expect(roundTripped.length).toBe(original.length);
      expect(roundTripped.map(p => p.type)).toEqual(original.map(p => p.type));
      for (let i = 0; i < original.length; i++) {
        expect(roundTripped[i].content).toBe(original[i].content);
      }
    }, 30_000);
  }
});

const draftBib = readFileSync(join(repoRoot, 'test/fixtures/draft.bib'), 'utf-8');

describe('double round-trip: md -> docx -> md -> docx -> md', () => {
  it('sample.md reaches a fixpoint after one round-trip', async () => {
    const originalMd = readFileSync(join(repoRoot, 'sample.md'), 'utf-8');

    // RT1: md -> docx -> md
    const r1 = await convertMdToDocx(originalMd, { bibtex: sampleBib });
    expect(r1.warnings).toEqual([]);
    const m1 = await convertDocx(r1.docx);

    // RT1 output .bib should be identical to original (Layer 1: stored in custom props)
    expect(m1.bibtex).toBe(sampleBib);

    // RT2: md -> docx -> md (using RT1 output)
    const r2 = await convertMdToDocx(m1.markdown, { bibtex: m1.bibtex });
    expect(r2.warnings).toEqual([]);
    const m2 = await convertDocx(r2.docx);

    // Fixpoint: RT1 and RT2 should produce identical markdown
    expect(m2.markdown.trimEnd()).toBe(m1.markdown.trimEnd());

    // Bib entries preserved through both round-trips
    const rt1Entries = (m1.bibtex.match(/^@\w+\{/gm) || []).length;
    const rt2Entries = (m2.bibtex.match(/^@\w+\{/gm) || []).length;
    expect(rt1Entries).toBe(3);
    expect(rt2Entries).toBe(3);
    expect(m2.bibtex).toBe(m1.bibtex);

    // Key structural elements survived both round-trips
    expect(countHeadings(m2.markdown)).toBe(countHeadings(originalMd));
    expect(countCodeBlocks(m2.markdown)).toBe(countCodeBlocks(originalMd));
  }, 60_000);

  it('draft.md reaches a fixpoint after one round-trip (with bib)', async () => {
    const draftMd = readFileSync(join(repoRoot, 'test/fixtures/draft.md'), 'utf-8');

    // RT1: md -> docx -> md
    const r1 = await convertMdToDocx(draftMd, { bibtex: draftBib });
    expect(r1.warnings).toEqual([]);
    const m1 = await convertDocx(r1.docx);

    // RT1 output .bib should be identical to original (Layer 1: stored in custom props)
    expect(m1.bibtex).toBe(draftBib);

    // RT2: md -> docx -> md (using RT1 output)
    const r2 = await convertMdToDocx(m1.markdown, { bibtex: m1.bibtex });
    expect(r2.warnings).toEqual([]);
    const m2 = await convertDocx(r2.docx);

    // Fixpoint: RT1 and RT2 should produce identical markdown
    expect(m2.markdown.trimEnd()).toBe(m1.markdown.trimEnd());

    // Bib entries preserved through both round-trips
    expect(m2.bibtex).toBe(m1.bibtex);

    // Key structural elements survived both round-trips
    expect(countHeadings(m2.markdown)).toBe(countHeadings(draftMd));
  }, 60_000);

  it('draft.md reaches a fixpoint after one round-trip (without bib)', async () => {
    const draftMd = readFileSync(join(repoRoot, 'test/fixtures/draft.md'), 'utf-8');

    // RT1: md -> docx -> md (no bib file)
    const r1 = await convertMdToDocx(draftMd);
    // Without a .bib file, citation-key-not-found warnings are expected
    expect(r1.warnings.length).toBeGreaterThan(0);
    expect(r1.warnings.every((w: string) => w.includes('Citation key not found'))).toBe(true);
    const m1 = await convertDocx(r1.docx);

    // RT2: md -> docx -> md (using RT1 output, still no bib)
    const r2 = await convertMdToDocx(m1.markdown);
    expect(r2.warnings.length).toBeGreaterThan(0);
    expect(r2.warnings.every((w: string) => w.includes('Citation key not found'))).toBe(true);
    const m2 = await convertDocx(r2.docx);

    // Fixpoint: RT1 and RT2 should produce identical markdown
    expect(m2.markdown.trimEnd()).toBe(m1.markdown.trimEnd());

    // Key structural elements survived both round-trips
    expect(countHeadings(m2.markdown)).toBe(countHeadings(draftMd));
  }, 60_000);
});

describe('iterateFences / stripFencedCodeBlocks', () => {
  // Alphanumeric generator avoids markdown-special characters and newlines.
  const alnum = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => /^[a-z0-9]+$/.test(s));

  it('does not swallow indented text after a fenced code block', () => {
    fc.assert(
      fc.property(alnum, alnum, (code, afterText) => {
        const md = [
          'Some text',
          '',
          '```python',
          'FENCED_' + code,
          '```',
          '    AFTER_' + afterText,
          'more text',
        ].join('\n');
        const stripped = stripFencedCodeBlocks(md);
        expect(stripped).toContain('AFTER_' + afterText);
        expect(stripped).toContain('more text');
        expect(stripped).not.toContain('FENCED_' + code);
      }),
      { numRuns: 10 },
    );
  });

  it('still detects real indented code blocks', () => {
    fc.assert(
      fc.property(alnum, alnum, (codeLine, afterText) => {
        const md = [
          'Paragraph',
          '',
          '    BLOCK_' + codeLine,
          '',
          'TEXT_' + afterText,
        ].join('\n');
        const stripped = stripFencedCodeBlocks(md);
        expect(stripped).not.toContain('BLOCK_' + codeLine);
        expect(stripped).toContain('TEXT_' + afterText);
      }),
      { numRuns: 10 },
    );
  });
});

describe('alerts integration: md -> docx -> md', () => {
  it('restores explicit callout-labels frontmatter values', async () => {
    for (const calloutLabels of [true, false]) {
      const md = [
        '---',
        'callout-labels: ' + calloutLabels,
        '---',
        '',
        '> [!NOTE]',
        '> Useful information.',
      ].join('\n');
      const { docx } = await convertMdToDocx(md);
      const rt = await convertDocx(docx);
      expect(rt.markdown).toContain('callout-labels: ' + calloutLabels);
      expect(rt.markdown).toContain('> [!NOTE]\n> Useful information.');
    }
  });

  it('preserves label-like body text when generated labels are disabled', async () => {
    const cases = [
      ['NOTE', 'Note: retain this text'],
      ['TIP', 'Tip: retain this text'],
      ['IMPORTANT', 'Important: retain this text'],
      ['WARNING', 'Warning: retain this text'],
      ['CAUTION', 'Caution: retain this text'],
      ['NOTE', '※ Note: retain this text'],
      ['TIP', '**Tip:** retain this text'],
    ] as const;

    for (const [type, body] of cases) {
      const md = [
        '---',
        'callout-labels: false',
        '---',
        '',
        '> [!' + type + ']',
        '> ' + body,
      ].join('\n');
      const { docx } = await convertMdToDocx(md);
      const rt = await convertDocx(docx);
      expect(rt.markdown).toContain('> [!' + type + ']\n> ' + body);
    }
  });

  it('round-trips mixed alert blocks with canonical markers', async () => {
    const md = [
      '# Alerts',
      '',
      '> [!NOTE]',
      '> Useful information.',
      '',
      '> [!TIP]',
      '> Helpful advice.',
      '',
      '> [!IMPORTANT]',
      '> Key info.',
      '',
      '> [!WARNING]',
      '> Urgent attention needed.',
      '',
      '> [!CAUTION]',
      '> Risks ahead.',
      '',
      'After alerts.',
    ].join('\n');

    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const rt = await convertDocx(docx);
    expect(rt.markdown).toContain('> [!NOTE]\n> Useful information.');
    expect(rt.markdown).toContain('> [!TIP]\n> Helpful advice.');
    expect(rt.markdown).toContain('> [!IMPORTANT]\n> Key info.');
    expect(rt.markdown).toContain('> [!WARNING]\n> Urgent attention needed.');
    expect(rt.markdown).toContain('> [!CAUTION]\n> Risks ahead.');
    expect(rt.markdown).toContain('After alerts.');
    expect(rt.markdown).not.toContain('※ Note');
    expect(rt.markdown).not.toContain('◈ Tip');
    expect(rt.markdown).not.toContain('‼ Important');
    expect(rt.markdown).not.toContain('▲ Warning');
    expect(rt.markdown).not.toContain('⛒ Caution');
  });
  it('preserves two-line authored alert marker style', async () => {
    const md = [
      '> [!WARNING]',
      '> two-line warning body',
    ].join('\n');

    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);
    expect(rt.markdown).toBe(md + '\n');
  });

  it('preserves inline alert marker form on round-trip', async () => {
    const md = '> [!NOTE] inline note body';
    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);
    expect(rt.markdown).toBe('> [!NOTE] inline note body\n');
  });

  it('preserves separate-line alert marker form on round-trip', async () => {
    const md = '> [!NOTE]\n> separate note body';
    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);
    expect(rt.markdown).toBe('> [!NOTE]\n> separate note body\n');
  });

  it('round-trips multi-paragraph alert blocks and preserves only one marker per alert block', async () => {
    const md = [
      '> [!WARNING]',
      '> First paragraph.',
      '>',
      '> Second paragraph.',
      '',
      '> [!NOTE]',
      '> Single paragraph.',
    ].join('\n');

    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);

    const warningMarkerCount = (rt.markdown.match(/> \[!WARNING\]/g) || []).length;
    const noteMarkerCount = (rt.markdown.match(/> \[!NOTE\]/g) || []).length;
    expect(warningMarkerCount).toBe(1);
    expect(noteMarkerCount).toBe(1);
    expect(rt.markdown).toContain('First paragraph.');
    expect(rt.markdown).toContain('Second paragraph.');
  });
  it('does not merge alert body with immediately following non-blockquote paragraph', async () => {
    const md = [
      '> [!NOTE]',
      '> alpha alpha',
      'alpha alpha',
    ].join('\n');

    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);

    expect(rt.markdown).toBe([
      '> [!NOTE]',
      '> alpha alpha',
      'alpha alpha',
      '',
    ].join('\n'));
  });

  it('round-trips blockquotes.md fixture', async () => {
    const md = readFileSync(join(repoRoot, 'test/fixtures/blockquotes.md'), 'utf-8');
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);
    const rt = await convertDocx(docx);

    // All five alert types survived
    for (const type of ['NOTE', 'WARNING', 'IMPORTANT', 'TIP', 'CAUTION']) {
      expect(rt.markdown).toContain('[!' + type + ']');
    }
    // Plain blockquote preserved
    expect(rt.markdown).toContain('This is a blockquote.');
    // Content preserved
    expect(rt.markdown).toContain('This is a note.');
    expect(rt.markdown).toContain('This is a warning.');
    // Glyphs stripped on roundtrip
    for (const glyph of ['\u203B', '\u25C8', '\u203C', '\u25B2', '\u26D2']) {
      expect(rt.markdown).not.toContain(glyph);
    }
    // Headings preserved
    expect(rt.markdown).toContain('# Examples');
  });
});
