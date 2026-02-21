// src/latex-comment-stripping.property.test.ts
// Bug condition exploration test: LaTeX % comments appear as visible text in OMML
// This test encodes the EXPECTED behavior — it will FAIL on unfixed code (confirming the bug)
// and PASS after the fix is implemented.

import { describe, test, expect } from 'bun:test';
import * as fc from 'fast-check';
import { latexToOmml } from './latex-to-omml';

/**
 * Detects whether a LaTeX input contains an unescaped % character (bug condition).
 * An unescaped % is one not preceded by a backslash.
 */
function isBugCondition(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '%') {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && input[j] === '\\') {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extracts all visible text content from m:t elements in OMML XML.
 * Returns an array of text strings found in <m:t>...</m:t> elements.
 * Skips hidden comment runs whose text starts with \u200B (zero-width space).
 */
function extractVisibleMtTexts(omml: string): string[] {
  const texts: string[] = [];
  const regex = /<m:t[^>]*>([\s\S]*?)<\/m:t>/g;
  let match;
  while ((match = regex.exec(omml)) !== null) {
    const text = match[1];
    // Skip hidden comment runs (prefixed with zero-width space)
    if (text.startsWith('\u200B')) {
      continue;
    }
    texts.push(text);
  }
  return texts;
}

describe('Property 1: Fault Condition — LaTeX % Comments Appear as Visible Text in OMML', () => {

  /**
   * **Validates: Requirements 1.1, 2.1**
   *
   * Single-line comment: latexToOmml('x^2 % superscript')
   * Assert no visible m:t element contains '% superscript' or 'superscript' as comment text.
   */
  test('single-line comment text must not appear in visible OMML output', () => {
    const input = 'x^2 % superscript';
    expect(isBugCondition(input)).toBe(true);

    const omml = latexToOmml(input);
    const visibleTexts = extractVisibleMtTexts(omml);
    const allVisible = visibleTexts.join('');

    // The comment text '% superscript' and 'superscript' must NOT appear in visible output
    expect(allVisible).not.toContain('% superscript');
    expect(allVisible).not.toContain('superscript');
  });

  /**
   * **Validates: Requirements 1.2, 2.2**
   *
   * Multi-line comments: latexToOmml('x^2          % superscript\nx_i          % subscript')
   * Assert neither comment appears in any visible m:t element.
   */
  test('multi-line comment text must not appear in visible OMML output', () => {
    const input = 'x^2          % superscript\nx_i          % subscript';
    expect(isBugCondition(input)).toBe(true);

    const omml = latexToOmml(input);
    const visibleTexts = extractVisibleMtTexts(omml);
    const allVisible = visibleTexts.join('');

    // Neither comment should appear in visible output
    expect(allVisible).not.toContain('% superscript');
    expect(allVisible).not.toContain('superscript');
    expect(allVisible).not.toContain('% subscript');
    expect(allVisible).not.toContain('subscript');
  });

  /**
   * **Validates: Requirements 1.3, 2.3**
   *
   * Line-continuation: latexToOmml('x + y%\n+ z')
   * Assert % is not visible and lines are joined.
   */
  test('line-continuation % must not appear as visible text in OMML output', () => {
    const input = 'x + y' + '%' + '\n+ z';
    expect(isBugCondition(input)).toBe(true);

    const omml = latexToOmml(input);
    const visibleTexts = extractVisibleMtTexts(omml);
    const allVisible = visibleTexts.join('');

    // The % character must not appear as visible text
    expect(allVisible).not.toContain('%');
  });

  /**
   * **Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3**
   *
   * Property-based test: for all LaTeX inputs containing an unescaped %,
   * latexToOmml SHALL produce OMML where no comment text appears in any visible m:t element.
   *
   * Uses scoped concrete failing cases via fast-check constantFrom.
   */
  test('PBT: no comment text in visible m:t for inputs with unescaped %', () => {
    // Scoped PBT: use concrete failing cases as the input space
    const buggyInputs = fc.constantFrom(
      'x^2 % superscript',
      'x^2          % superscript\nx_i          % subscript',
      'x + y' + '%' + '\n+ z',
      'a + b % trailing comment',
      '\\frac{a}{b} % fraction comment'
    );

    fc.assert(
      fc.property(buggyInputs, (input) => {
        expect(isBugCondition(input)).toBe(true);

        const omml = latexToOmml(input);
        const visibleTexts = extractVisibleMtTexts(omml);

        // Extract comment text from the input: everything after unescaped % to end-of-line
        const commentTexts: string[] = [];
        for (const line of input.split('\n')) {
          for (let i = 0; i < line.length; i++) {
            if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
              // The comment is everything from % onward on this line
              const commentPart = line.slice(i);
              commentTexts.push(commentPart);
              // Also check just the text after % (without the % itself)
              const textAfterPercent = line.slice(i + 1).trim();
              if (textAfterPercent) {
                commentTexts.push(textAfterPercent);
              }
              break;
            }
          }
        }

        // No comment text should appear in any visible m:t element
        for (const visibleText of visibleTexts) {
          for (const comment of commentTexts) {
            if (visibleText.includes(comment)) {
              return false; // Bug: comment text leaked into visible output
            }
          }
        }
        return true;
      }),
      { numRuns: 20, verbose: true }
    );
  }, { timeout: 10000 });
});
