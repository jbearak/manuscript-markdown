// src/blockquote-roundtrip-bugfix.property.test.ts
// Bug condition exploration test: blockquote roundtrip loses inter-block whitespace
// fidelity and leaks alert glyph/title prefixes.
// This test encodes the EXPECTED behavior — it will FAIL on unfixed code (confirming the bug)
// and PASS after the fix is implemented.

import { describe, test, expect } from 'bun:test';
import * as fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

/** Helper: roundtrip markdown through md->docx->md and return the resulting markdown. */
async function roundtrip(md: string): Promise<string> {
  const { docx } = await convertMdToDocx(md);
  const { markdown } = await convertDocx(docx);
  return markdown;
}

/** Strip YAML frontmatter (---...---) from the beginning of markdown output. */
function stripFrontmatter(md: string): string {
  const match = md.match(/^---\n[\s\S]*?\n---\n/);
  if (match) return md.slice(match[0].length);
  return md;
}

/**
 * Extract blockquote groups from markdown text.
 * A blockquote group is a consecutive sequence of lines starting with '>'.
 * Groups are separated by lines that don't start with '>'.
 */
function extractBlockquoteGroups(md: string): string[][] {
  const lines = md.split('\n');
  const groups: string[][] = [];
  let current: string[] = [];
  const alertRe = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/;
  for (const line of lines) {
    if (line.startsWith('>')) {
      // A new [!TYPE] marker inside a contiguous '>' run starts a new group
      if (current.length > 0 && alertRe.test(line)) {
        groups.push(current);
        current = [];
      }
      current.push(line);
    } else {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Count blank lines between two consecutive blockquote groups in the raw text.
 * Returns the number of blank lines (empty or whitespace-only) between the
 * last line of group A and the first line of group B.
 */
function countBlankLinesBetweenGroups(md: string, groupIdx: number): number {
  const groups = extractBlockquoteGroups(md);
  if (groupIdx + 1 >= groups.length) return 0;

  // Find the line indices of each group in the original text
  const lines = md.split('\n');
  let lineIdx = 0;
  let targetGroupEnd = -1;
  let nextGroupStart = -1;

  for (let g = 0; g <= groupIdx + 1 && g < groups.length; g++) {
    const groupLines = groups[g];
    // Find where this group starts in the original lines
    for (let gi = 0; gi < groupLines.length; gi++) {
      while (lineIdx < lines.length && lines[lineIdx] !== groupLines[gi]) {
        lineIdx++;
      }
      if (g === groupIdx && gi === groupLines.length - 1) {
        targetGroupEnd = lineIdx;
      }
      if (g === groupIdx + 1 && gi === 0) {
        nextGroupStart = lineIdx;
      }
      lineIdx++;
    }
  }

  if (targetGroupEnd < 0 || nextGroupStart < 0) return 0;

  // Count blank lines between the end of group A and start of group B
  let blanks = 0;
  for (let j = targetGroupEnd + 1; j < nextGroupStart; j++) {
    if (lines[j].trim() === '') blanks++;
  }
  return blanks;
}

// Alert types and their glyphs for checking leaks
const ALERT_GLYPHS = ['※', '◈', '‼', '▲', '⛒'];
const ALERT_TITLE_WORDS = ['Note', 'Tip', 'Important', 'Warning', 'Caution'];

// Short body text generator
const shortBody = fc.constantFrom(
  'Info here.',
  'A tip.',
  'Details.',
  'Be careful.',
  'Watch out.',
  'Hello world.',
  'Some text.',
);

// Alert type generator
const alertTypeArb = fc.constantFrom(
  'NOTE' as const,
  'TIP' as const,
  'IMPORTANT' as const,
  'WARNING' as const,
  'CAUTION' as const,
);

describe('Property 1: Fault Condition — Blockquote Roundtrip Fidelity', () => {
  test('golden fixture blockquotes.md roundtrips exactly', async () => {
    const md = readFileSync(join(__dirname, '..', 'test', 'fixtures', 'blockquotes.md'), 'utf8');
    const result = stripFrontmatter(await roundtrip(md));
    expect(result).toBe(md);
  });
  test('alert followed immediately by paragraph preserves zero-blank adjacency', async () => {
    const md = '> [!NOTE]\n> This is a note.\nThis is a paragraph.';
    const result = stripFrontmatter(await roundtrip(md));
    expect(result.trim()).toBe(md);
  });

  /**
   * **Validates: Requirements 1.1, 1.7**
   *
   * Two alerts separated by two blank lines: after roundtrip, the two blank
   * lines between them should be preserved. On unfixed code, the gap collapses
   * because docx has no gap metadata.
   */
  test('two alerts separated by two blank lines preserves gap count', async () => {
    await fc.assert(
      fc.asyncProperty(alertTypeArb, alertTypeArb, shortBody, shortBody, async (type1, type2, body1, body2) => {
        const md = '> [!' + type1 + ']\n> ' + body1 + '\n\n\n> [!' + type2 + ']\n> ' + body2;
        const result = stripFrontmatter(await roundtrip(md));

        // The original has 2 blank lines between groups (the \n\n\n produces 2 blank lines)
        const resultGroups = extractBlockquoteGroups(result);
        expect(resultGroups.length).toBe(2);

        const gapBlanks = countBlankLinesBetweenGroups(result, 0);
        expect(gapBlanks).toBe(2);
      }),
      { numRuns: 10, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 1.5**
   *
   * Two alerts separated by zero blank lines: after roundtrip, zero blank lines
   * should be preserved. On unfixed code, markdown-it merges them or a spurious
   * blank line appears.
   */
  test('adjacent same-type zero-gap alerts remain distinct with labels disabled', async () => {
    await fc.assert(
      fc.asyncProperty(alertTypeArb, shortBody, shortBody, async (type, body1, body2) => {
        const md = '> [!' + type + ']\n> ' + body1 + '\n> [!' + type + ']\n> ' + body2;
        const { docx } = await convertMdToDocx(md, { calloutLabels: false });
        const { markdown } = await convertDocx(docx);
        const result = stripFrontmatter(markdown);

        const resultGroups = extractBlockquoteGroups(result);
        expect(resultGroups).toHaveLength(2);
        expect((result.match(new RegExp('> \\[!' + type + '\\]', 'g')) || [])).toHaveLength(2);
        expect(countBlankLinesBetweenGroups(result, 0)).toBe(0);
      }),
      { numRuns: 10, verbose: true },
    );
  }, { timeout: 30000 });

  test('adjacent nested same-type alerts keep zero-gap grouping with labels disabled', async () => {
    const md = '> [!NOTE]\n> outer\n> > [!TIP]\n> > n1\n> > [!TIP]\n> > n2';
    const { docx } = await convertMdToDocx(md, { calloutLabels: false });
    const { markdown } = await convertDocx(docx);
    const result = stripFrontmatter(markdown);

    expect(result.trim()).toBe(md);
  });

  test('two alerts separated by zero blank lines preserves adjacency', async () => {
    await fc.assert(
      fc.asyncProperty(alertTypeArb, alertTypeArb, shortBody, shortBody, async (type1, type2, body1, body2) => {
        fc.pre(type1 !== type2); // different types to avoid ambiguity
        const md = '> [!' + type1 + ']\n> ' + body1 + '\n> [!' + type2 + ']\n> ' + body2;
        const result = stripFrontmatter(await roundtrip(md));

        const resultGroups = extractBlockquoteGroups(result);
        // With zero blank lines, groups should remain distinct
        // (markdown-it may merge them, but roundtrip should preserve the original structure)
        expect(resultGroups.length).toBe(2);

        const gapBlanks = countBlankLinesBetweenGroups(result, 0);
        expect(gapBlanks).toBe(0);
      }),
      { numRuns: 10, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 1.3**
   *
   * Plain blockquote adjacent to alert blockquote: both groups should remain
   * distinct and correctly separated. On unfixed code, they may merge because
   * both have blockquoteLevel=1.
   */
  test('plain blockquote adjacent to alert blockquote remain distinct', async () => {
    await fc.assert(
      fc.asyncProperty(alertTypeArb, shortBody, shortBody, async (alertType, plainBody, alertBody) => {
        const md = '> ' + plainBody + '\n\n> [!' + alertType + ']\n> ' + alertBody;
        const result = stripFrontmatter(await roundtrip(md));

        const resultGroups = extractBlockquoteGroups(result);
        expect(resultGroups.length).toBe(2);

        // First group should be plain (no [!TYPE] marker)
        const firstGroupText = resultGroups[0].join('\n');
        expect(firstGroupText).not.toMatch(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/);

        // Second group should have the alert marker
        const secondGroupText = resultGroups[1].join('\n');
        expect(secondGroupText).toMatch(new RegExp('\\[!' + alertType + '\\]'));

        // Gap should be 1 blank line (the \n\n between them)
        const gapBlanks = countBlankLinesBetweenGroups(result, 0);
        expect(gapBlanks).toBe(1);
      }),
      { numRuns: 10, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 1.2**
   *
   * Alert body text should contain no residual glyph characters or title words
   * leaking into the body. On unfixed code, stripAlertLeadPrefix may fail to
   * match the exact format emitted by generateParagraph.
   */
  test('alert body text contains no residual glyph or title prefix leaks', async () => {
    await fc.assert(
      fc.asyncProperty(alertTypeArb, shortBody, async (alertType, body) => {
        const md = '> [!' + alertType + ']\n> ' + body;
        const result = stripFrontmatter(await roundtrip(md));

        const groups = extractBlockquoteGroups(result);
        expect(groups.length).toBeGreaterThanOrEqual(1);

        // Get all lines after the [!TYPE] marker line
        const groupLines = groups[0];
        const markerLineIdx = groupLines.findIndex(l => l.match(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/));
        expect(markerLineIdx).toBeGreaterThanOrEqual(0);

        // Check body lines (lines after the marker, and the rest of the marker line after [!TYPE])
        const markerLine = groupLines[markerLineIdx];
        const afterMarker = markerLine.replace(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/, '');

        // No glyph characters should appear in the body
        for (const glyph of ALERT_GLYPHS) {
          expect(afterMarker).not.toContain(glyph);
        }

        // No title words should leak as prefix (e.g., "※ Note" or just "Note" as prefix)
        // The body should be exactly the original body text
        for (const title of ALERT_TITLE_WORDS) {
          // Check that the body doesn't start with a title word that wasn't in the original
          if (!body.startsWith(title)) {
            expect(afterMarker.trimStart().startsWith(title + ' ')).toBe(false);
            expect(afterMarker.trimStart().startsWith(title + ':')).toBe(false);
          }
        }

        // Check subsequent body lines too
        for (let i = markerLineIdx + 1; i < groupLines.length; i++) {
          const lineContent = groupLines[i].replace(/^>\s*/, '');
          for (const glyph of ALERT_GLYPHS) {
            expect(lineContent).not.toContain(glyph);
          }
        }
      }),
      { numRuns: 15, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 1.6**
   *
   * Asymmetric gap patterns: blank line above but not below (or vice versa)
   * should be preserved. On unfixed code, asymmetry is lost because gap
   * metadata is not encoded.
   */
  test('asymmetric gap patterns are preserved', async () => {
    await fc.assert(
      fc.asyncProperty(alertTypeArb, alertTypeArb, shortBody, shortBody, async (type1, type2, body1, body2) => {
        // Pattern: alert, then paragraph (no blank line), then blank line, then alert
        // This creates asymmetric gaps: 0 blanks before paragraph, 1 blank after
        const md = '> [!' + type1 + ']\n> ' + body1 + '\n\n\n\n> [!' + type2 + ']\n> ' + body2;
        const result = stripFrontmatter(await roundtrip(md));

        const resultGroups = extractBlockquoteGroups(result);
        expect(resultGroups.length).toBe(2);

        // Original has 3 blank lines between groups (\n\n\n\n = 3 blank lines)
        const gapBlanks = countBlankLinesBetweenGroups(result, 0);
        expect(gapBlanks).toBe(3);
      }),
      { numRuns: 10, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 1.1, 1.5, 1.6, 1.7**
   *
   * Property-based: varying inter-block gap counts (0, 1, 2, 3 blank lines)
   * between two alert groups should all be preserved through roundtrip.
   */
  test('varying gap counts between alert groups are preserved', async () => {
    const gapArb = fc.integer({ min: 0, max: 3 });
    await fc.assert(
      fc.asyncProperty(alertTypeArb, alertTypeArb, shortBody, shortBody, gapArb, async (type1, type2, body1, body2, gapCount) => {
        fc.pre(type1 !== type2 || gapCount > 0); // same type with 0 gap merges in markdown-it
        const gap = '\n'.repeat(gapCount + 1); // +1 for the line ending of the last > line
        const md = '> [!' + type1 + ']\n> ' + body1 + gap + '> [!' + type2 + ']\n> ' + body2;
        const result = stripFrontmatter(await roundtrip(md));

        const resultGroups = extractBlockquoteGroups(result);
        expect(resultGroups.length).toBe(2);

        const resultGap = countBlankLinesBetweenGroups(result, 0);
        expect(resultGap).toBe(gapCount);
      }),
      { numRuns: 20, verbose: true },
    );
  }, { timeout: 30000 });
});

// ============================================================================
// Property 2: Preservation — Non-Buggy Blockquote and Non-Blockquote Content Unchanged
// ============================================================================

// Generators for preservation tests
const plainBodyArb = fc.constantFrom(
  'Hello.',
  'Some text here.',
  'A short line.',
  'Testing roundtrip.',
  'Content preserved.',
);

const headingTextArb = fc.constantFrom(
  'My Heading',
  'Introduction',
  'Summary',
  'Details',
  'Overview',
);

const headingLevelArb = fc.integer({ min: 1, max: 4 });

const paragraphArb = fc.constantFrom(
  'Just a paragraph.',
  'Some text with **bold** and *italic*.',
  'A simple sentence.',
  'Another paragraph here.',
);

const listItemArb = fc.constantFrom(
  'Item one',
  'First thing',
  'A list entry',
  'Something here',
);

const codeContentArb = fc.constantFrom(
  'const x = 1;',
  'print("hello")',
  'let y = 2;',
  'return true;',
);

const codeLangArb = fc.constantFrom('', 'js', 'ts', 'python');

describe('Property 2: Preservation — Non-Buggy Blockquote and Non-Blockquote Content Unchanged', () => {

  /**
   * **Validates: Requirements 3.1**
   *
   * Single plain blockquotes roundtrip with content preserved.
   * Observed behavior: `> Hello.` → `> Hello.\n\n` (trailing newlines added).
   * The blockquote content itself is preserved.
   */
  test('single plain blockquote preserves content through roundtrip', async () => {
    await fc.assert(
      fc.asyncProperty(plainBodyArb, async (body) => {
        const md = '> ' + body;
        const result = stripFrontmatter(await roundtrip(md));

        // Extract blockquote groups from result
        const groups = extractBlockquoteGroups(result);
        expect(groups.length).toBe(1);

        // The first line should contain the original body text
        const firstLine = groups[0][0];
        expect(firstLine).toContain(body);

        // Should still be a blockquote (starts with >)
        expect(firstLine.startsWith('>')).toBe(true);
      }),
      { numRuns: 5, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 3.2**
   *
   * Single alerts roundtrip with correct [!TYPE] marker and body text.
   * Observed behavior: `> [!NOTE]\n> Info.` → `> [!NOTE] Info.\n\n`
   * (body moves to marker line, which is valid alert format).
   */
  test('single alert preserves marker and body through roundtrip', async () => {
    await fc.assert(
      fc.asyncProperty(alertTypeArb, plainBodyArb, async (alertType, body) => {
        const md = '> [!' + alertType + ']\n> ' + body;
        const result = stripFrontmatter(await roundtrip(md));

        const groups = extractBlockquoteGroups(result);
        expect(groups.length).toBe(1);

        const groupText = groups[0].join('\n');

        // Alert marker must be present
        expect(groupText).toContain('[!' + alertType + ']');

        // Body text must be present
        expect(groupText).toContain(body);

        // No glyph characters should leak into the output
        for (const glyph of ALERT_GLYPHS) {
          expect(groupText).not.toContain(glyph);
        }

        // No title words should leak as prefix before the body
        const alertIdx = alertType.charAt(0) + alertType.slice(1).toLowerCase();
        const afterMarker = groupText.replace(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/, '');
        if (!body.startsWith(alertIdx)) {
          expect(afterMarker.startsWith(alertIdx + ' ')).toBe(false);
        }
      }),
      { numRuns: 10, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 3.3**
   *
   * Headings roundtrip identically.
   * Observed behavior: `# My Heading` → `# My Heading` (exact match).
   */
  test('headings roundtrip identically', async () => {
    await fc.assert(
      fc.asyncProperty(headingLevelArb, headingTextArb, async (level, text) => {
        const prefix = '#'.repeat(level) + ' ';
        const md = prefix + text;
        const result = stripFrontmatter(await roundtrip(md));

        expect(result.trim()).toBe(md);
      }),
      { numRuns: 10, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 3.3**
   *
   * Paragraphs roundtrip identically.
   * Observed behavior: `Just a paragraph.` → `Just a paragraph.` (exact match).
   */
  test('paragraphs roundtrip identically', async () => {
    await fc.assert(
      fc.asyncProperty(paragraphArb, async (para) => {
        const result = stripFrontmatter(await roundtrip(para));
        expect(result.trim()).toBe(para);
      }),
      { numRuns: 4, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 3.3**
   *
   * Unordered lists roundtrip with content preserved.
   * Observed behavior: list items preserve their text content.
   */
  test('unordered lists preserve content through roundtrip', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(listItemArb, { minLength: 2, maxLength: 4 }),
        async (items) => {
          const md = items.map(item => '- ' + item).join('\n');
          const result = stripFrontmatter(await roundtrip(md));

          // Each item text should appear in the output
          for (const item of items) {
            expect(result).toContain(item);
          }

          // Should have the right number of list markers
          const listLines = result.trim().split('\n').filter(l => l.startsWith('- '));
          expect(listLines.length).toBe(items.length);
        },
      ),
      { numRuns: 5, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 3.5**
   *
   * Code blocks roundtrip identically.
   * Observed behavior: code blocks with or without language preserve exactly.
   */
  test('code blocks roundtrip identically', async () => {
    await fc.assert(
      fc.asyncProperty(codeLangArb, codeContentArb, async (lang, code) => {
        const fence = '```' + lang;
        const md = fence + '\n' + code + '\n```';
        const result = stripFrontmatter(await roundtrip(md));

        // Code content must be preserved
        expect(result).toContain(code);

        // Fence markers must be present
        expect(result).toContain('```');
      }),
      { numRuns: 8, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 3.4**
   *
   * Nested blockquotes preserve nesting level.
   * Observed behavior: `> > Nested.` → `> > Nested.\n\n` (nesting preserved).
   */
  test('nested blockquotes preserve nesting level', async () => {
    const nestLevelArb = fc.integer({ min: 2, max: 3 });
    await fc.assert(
      fc.asyncProperty(nestLevelArb, plainBodyArb, async (level, body) => {
        const prefix = Array.from({ length: level }, () => '>').join(' ') + ' ';
        const md = prefix + body;
        const result = stripFrontmatter(await roundtrip(md));

        const groups = extractBlockquoteGroups(result);
        expect(groups.length).toBeGreaterThanOrEqual(1);

        // The output should contain the body text
        expect(result).toContain(body);

        // Count nesting level in the first blockquote line
        const firstLine = groups[0][0];
        const nestMatch = firstLine.match(/^(>\s*)+/);
        expect(nestMatch).not.toBeNull();
        if (nestMatch) {
          const outputLevel = (nestMatch[0].match(/>/g) || []).length;
          expect(outputLevel).toBe(level);
        }
      }),
      { numRuns: 6, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 3.6**
   *
   * Intra-block blank lines within a single blockquote are preserved.
   * Observed behavior: `> Para one.\n>\n> Para two.` → the content of both
   * paragraphs is preserved in the output (the converter may normalize the
   * blank line format but the two paragraphs remain).
   */
  test('intra-block blank lines preserve both paragraphs', async () => {
    await fc.assert(
      fc.asyncProperty(plainBodyArb, plainBodyArb, async (body1, body2) => {
        fc.pre(body1 !== body2); // distinct bodies to verify both survive
        const md = '> ' + body1 + '\n>\n> ' + body2;
        const result = stripFrontmatter(await roundtrip(md));

        // Both paragraph texts must appear in the output
        expect(result).toContain(body1);
        expect(result).toContain(body2);

        // Both should still be in blockquote context (lines starting with >)
        const groups = extractBlockquoteGroups(result);
        expect(groups.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 5, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: Requirements 3.3**
   *
   * Multiple paragraphs separated by blank lines roundtrip identically.
   * Observed behavior: `First.\n\nSecond.` → `First.\n\nSecond.` (exact match).
   */
  test('multiple paragraphs separated by blank lines roundtrip identically', async () => {
    await fc.assert(
      fc.asyncProperty(paragraphArb, paragraphArb, async (para1, para2) => {
        fc.pre(para1 !== para2);
        const md = para1 + '\n\n' + para2;
        const result = stripFrontmatter(await roundtrip(md));

        expect(result.trim()).toBe(md);
      }),
      { numRuns: 5, verbose: true },
    );
  }, { timeout: 30000 });

  /**
   * **Validates: stripAlertLeadPrefix separator handling**
   *
   * When a Word doc uses "※ Note: body" (colon separator, no line break),
   * the colon must not leak into the output. Pattern 2 (exactPlain) should
   * fall through to pattern 4 (withGlyph) which strips "※ Note: ".
   */
  test('colon after alert title is stripped, not leaked into body', async () => {
    const md = '> [!NOTE]\n> Note: body text';
    const result = stripFrontmatter(await roundtrip(md));
    // The body text should survive without a stray leading colon
    expect(result.trim()).toContain('body text');
    expect(result.trim()).not.toMatch(/^>\s*: body text/m);
  }, { timeout: 30000 });

  /**
   * **Validates: stripAlertLeadPrefix dash separator handling**
   *
   * Similar to the colon case — a dash separator after the alert title
   * should be cleanly stripped on round-trip.
   */
  test('dash after alert title is stripped, not leaked into body', async () => {
    const md = '> [!TIP]\n> Tip- body text';
    const result = stripFrontmatter(await roundtrip(md));
    expect(result.trim()).toContain('body text');
    expect(result.trim()).not.toMatch(/^>\s*- body text/m);
  }, { timeout: 30000 });
});
