// src/latex-comment-roundtrip.property.test.ts
// Property 3: Roundtrip — Comment Restoration on Re-Import
// Tests that LaTeX % comments survive the latexToOmml → parse → ommlToLatex roundtrip.

import { describe, test, expect } from 'bun:test';
import * as fc from 'fast-check';
import { XMLParser } from 'fast-xml-parser';
import { latexToOmml } from './latex-to-omml';
import { ommlToLatex } from './omml';

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
};

/**
 * Performs the full roundtrip: LaTeX → OMML XML → parse → LaTeX.
 */
function roundtrip(latex: string): string {
  const omml = latexToOmml(latex);
  if (!omml) return '';
  const parser = new XMLParser(parserOptions);
  const parsed = parser.parse('<m:oMath>' + omml + '</m:oMath>');
  let children: any[] = [];
  if (parsed && Array.isArray(parsed) && parsed[0]?.['m:oMath']) {
    children = parsed[0]['m:oMath'];
  }
  return ommlToLatex(children);
}

/**
 * Extracts comment portions from a LaTeX string.
 * Returns an array of { whitespace, commentText } for each unescaped % found.
 */
function extractComments(latex: string): Array<{ whitespace: string; commentText: string }> {
  const comments: Array<{ whitespace: string; commentText: string }> = [];
  for (const line of latex.split('\n')) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
        // Walk backwards to find preceding whitespace (spaces/tabs)
        let wsStart = i;
        while (wsStart > 0 && (line[wsStart - 1] === ' ' || line[wsStart - 1] === '\t')) {
          wsStart--;
        }
        const whitespace = line.slice(wsStart, i);
        const commentText = line.slice(i + 1); // text after %
        comments.push({ whitespace, commentText });
        break; // only first unescaped % per line
      }
    }
  }
  return comments;
}

// ---------------------------------------------------------------------------
// Concrete roundtrip test cases
// ---------------------------------------------------------------------------

describe('Property 3: Roundtrip — Comment Restoration on Re-Import', () => {

  /**
   * **Validates: Requirements 2.4, 3.5**
   *
   * Single-line comment roundtrip: x^2 % superscript
   */
  test('single-line comment roundtrips correctly', () => {
    const input = 'x^2 % superscript';
    const result = roundtrip(input);

    // The comment portion must be restored
    expect(result).toContain('% superscript');
    // The preceding whitespace (single space) before % must be preserved
    expect(result).toMatch(/ % superscript/);
  });

  /**
   * **Validates: Requirements 2.4, 3.6**
   *
   * Multi-line with aligned comments preserves whitespace alignment.
   */
  test('multi-line aligned comments preserve whitespace after roundtrip', () => {
    const input = 'x^2          % superscript\nx_i          % subscript';
    const result = roundtrip(input);

    // Both comments must be restored
    expect(result).toContain('% superscript');
    expect(result).toContain('% subscript');

    // The preceding whitespace before each % must be preserved exactly
    expect(result).toContain('          % superscript');
    expect(result).toContain('          % subscript');
  });

  /**
   * **Validates: Requirements 2.4, 3.5**
   *
   * Line-continuation % roundtrips correctly.
   */
  test('line-continuation % roundtrips correctly', () => {
    const input = 'x + y' + '%' + '\n+ z';
    const result = roundtrip(input);

    // The line-continuation % must be restored
    expect(result).toContain('%' + '\n');
  });

  // ---------------------------------------------------------------------------
  // Property-based roundtrip tests
  // ---------------------------------------------------------------------------

  /**
   * **Validates: Requirements 2.4, 3.5, 3.6**
   *
   * PBT: For any LaTeX input with % comments, the roundtrip restores
   * % comments with their original preceding whitespace.
   */
  test('PBT: roundtrip preserves % comments and preceding whitespace', () => {
    // Generator for simple equation content (no unescaped %)
    const eqContent = fc.constantFrom(
      'x', 'y', 'z', 'a + b', 'x^2',
      '\\frac{a}{b}', '\\alpha'
    );

    // Generator for whitespace before %
    const wsBeforeComment = fc.oneof(
      fc.constant(' '),
      fc.constant('  '),
      fc.constant('          '),
      fc.constant('\t'),
    );

    // Generator for comment text (simple ASCII, no special chars)
    const commentTextGen = fc.constantFrom(
      'comment', 'superscript', 'subscript',
      'note', 'aligned', 'trailing'
    );

    // Single-line with comment: eq + ws + '% ' + commentText
    const singleLineWithComment = fc.tuple(eqContent, wsBeforeComment, commentTextGen)
      .map(([eq, ws, ct]) => ({ input: eq + ws + '% ' + ct, ws, ct }));

    fc.assert(
      fc.property(singleLineWithComment, ({ input, ws, ct }) => {
        const result = roundtrip(input);

        // The comment text after % must be present in the result
        if (!result.includes('% ' + ct)) {
          return false;
        }
        // The preceding whitespace before % must be preserved
        if (!result.includes(ws + '% ' + ct)) {
          return false;
        }
        return true;
      }),
      { numRuns: 30, verbose: true },
    );
  }, { timeout: 15000 });

  /**
   * **Validates: Requirements 2.4, 3.6**
   *
   * PBT: Multi-line aligned comments maintain vertical alignment after roundtrip.
   */
  test('PBT: multi-line aligned comments maintain vertical alignment', () => {
    const eqContent = fc.constantFrom('x^2', 'x_i', 'a + b', 'y');
    const commentText = fc.constantFrom(
      'superscript', 'subscript', 'note', 'term'
    );

    // Generate two lines with the same alignment whitespace
    const alignedTwoLines = fc.tuple(
      eqContent, eqContent,
      fc.constantFrom('    ', '        ', '          '),
      commentText, commentText,
    ).map(([eq1, eq2, ws, ct1, ct2]) =>
      eq1 + ws + '% ' + ct1 + '\n' + eq2 + ws + '% ' + ct2
    );

    fc.assert(
      fc.property(alignedTwoLines, (input) => {
        const result = roundtrip(input);
        const inputComments = extractComments(input);
        const resultComments = extractComments(result);

        // Must have same number of comments
        if (inputComments.length !== resultComments.length) return false;

        // Each comment's whitespace must match
        for (let i = 0; i < inputComments.length; i++) {
          if (resultComments[i].whitespace !== inputComments[i].whitespace) return false;
          if (resultComments[i].commentText.trim() !== inputComments[i].commentText.trim()) return false;
        }
        return true;
      }),
      { numRuns: 30, verbose: true },
    );
  }, { timeout: 15000 });

  /**
   * **Validates: Requirements 2.4, 3.5**
   *
   * PBT: Line-continuation % roundtrips correctly — lines joined on export,
   * %\n restored on import.
   */
  test('PBT: line-continuation % roundtrips correctly', () => {
    const eqPart = fc.constantFrom('x', 'y', 'a + b', 'z');

    const lineContinuation = fc.tuple(eqPart, eqPart)
      .map(([before, after]) => before + '%' + '\n' + after);

    fc.assert(
      fc.property(lineContinuation, (input) => {
        const result = roundtrip(input);
        // The line-continuation marker %\n must be present in the output
        return result.includes('%' + '\n');
      }),
      { numRuns: 20, verbose: true },
    );
  }, { timeout: 15000 });
});
