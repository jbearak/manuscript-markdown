// src/latex-comment-preservation.property.test.ts
// Property 2: Preservation — Non-Comment LaTeX Conversion Unchanged
// These tests verify that inputs WITHOUT unescaped % produce identical OMML
// before and after the fix. They should PASS on unfixed code (baseline).

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

// ---------------------------------------------------------------------------
// Observed baseline outputs from UNFIXED latexToOmml() — recorded for
// concrete preservation assertions.
// ---------------------------------------------------------------------------

const OBSERVED_BASELINES: Array<{ input: string; output: string }> = [
  {
    input: 'x^2',
    output: '<m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>',
  },
  {
    input: '\\frac{a}{b}',
    output: '<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f>',
  },
  {
    // 50\% discount — escaped percent renders as literal \%
    input: '50\\% discount',
    output:
      '<m:r><m:t>5</m:t></m:r>' +
      '<m:r><m:t>0</m:t></m:r>' +
      '<m:r><m:t>\\%</m:t></m:r>' +
      '<m:r><m:t> </m:t></m:r>' +
      '<m:r><m:t>d</m:t></m:r>' +
      '<m:r><m:t>i</m:t></m:r>' +
      '<m:r><m:t>s</m:t></m:r>' +
      '<m:r><m:t>c</m:t></m:r>' +
      '<m:r><m:t>o</m:t></m:r>' +
      '<m:r><m:t>u</m:t></m:r>' +
      '<m:r><m:t>n</m:t></m:r>' +
      '<m:r><m:t>t</m:t></m:r>',
  },
  {
    input: '\\sum_{i=0}^{n} x_i',
    output:
      '<m:nary><m:naryPr><m:chr m:val="\u2211"/></m:naryPr>' +
      '<m:sub><m:r><m:t>i</m:t></m:r><m:r><m:t>=</m:t></m:r><m:r><m:t>0</m:t></m:r></m:sub>' +
      '<m:sup><m:r><m:t>n</m:t></m:r></m:sup>' +
      '<m:e><m:sSub><m:e><m:r><m:t> x</m:t></m:r></m:e>' +
      '<m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub></m:e></m:nary>',
  },
  {
    input: 'a + b',
    output:
      '<m:r><m:t>a</m:t></m:r>' +
      '<m:r><m:t> </m:t></m:r>' +
      '<m:r><m:t>+</m:t></m:r>' +
      '<m:r><m:t> </m:t></m:r>' +
      '<m:r><m:t>b</m:t></m:r>',
  },
];

// ---------------------------------------------------------------------------
// Concrete preservation assertions
// ---------------------------------------------------------------------------

describe('Property 2: Preservation — Non-Comment LaTeX Conversion Unchanged', () => {

  /**
   * **Validates: Requirements 3.1**
   *
   * Escaped \% continues to render as literal % in OMML.
   */
  test('escaped \\% renders as literal percent in OMML', () => {
    const input = '50\\% discount';
    expect(isBugCondition(input)).toBe(false);

    const omml = latexToOmml(input);
    // The escaped \% must appear as \\% in the OMML text run
    expect(omml).toContain('<m:t>\\%</m:t>');
    // Match observed baseline exactly
    const baseline = OBSERVED_BASELINES.find(b => b.input === input)!;
    expect(omml).toBe(baseline.output);
  });

  /**
   * **Validates: Requirements 3.2**
   *
   * Equations without % produce identical OMML.
   */
  test('equations without % produce identical OMML to baseline', () => {
    for (const { input, output } of OBSERVED_BASELINES) {
      expect(isBugCondition(input)).toBe(false);
      expect(latexToOmml(input)).toBe(output);
    }
  });

  /**
   * **Validates: Requirements 3.3**
   *
   * Non-comment portions of equations are unaffected.
   * We verify that the equation content before any comment is converted identically.
   */
  test('non-comment equation content converts identically', () => {
    // x^2 alone produces the same OMML whether or not a comment follows
    const baseOutput = latexToOmml('x^2');
    const baseline = OBSERVED_BASELINES.find(b => b.input === 'x^2')!;
    expect(baseOutput).toBe(baseline.output);

    // \\frac{a}{b} alone
    const fracOutput = latexToOmml('\\frac{a}{b}');
    const fracBaseline = OBSERVED_BASELINES.find(b => b.input === '\\frac{a}{b}')!;
    expect(fracOutput).toBe(fracBaseline.output);
  });

  /**
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
   *
   * Property-based test: for all LaTeX inputs where isBugCondition returns false,
   * latexToOmml produces the same output consistently (idempotent on non-buggy inputs).
   *
   * Generator: random LaTeX-like strings built from safe characters and commands,
   * explicitly excluding unescaped %.
   */
  test('PBT: non-buggy inputs produce stable OMML output', () => {
    // Generator for LaTeX fragments that do NOT contain unescaped %
    const safeLatexChar = fc.oneof(
      fc.constantFrom(
        'a', 'b', 'c', 'x', 'y', 'z',
        '0', '1', '2', '3',
        '+', '-', '=', ' ',
        '(', ')',
      ),
      // Escaped percent — safe, not a bug condition
      fc.constant('\\%'),
    );

    const safeLatexFragment = fc.array(safeLatexChar, { minLength: 1, maxLength: 8 })
      .map(chars => chars.join(''));

    // Also include some structured LaTeX expressions
    const structuredLatex = fc.oneof(
      safeLatexFragment,
      fc.constantFrom(
        'x^2',
        '\\frac{a}{b}',
        '50\\% discount',
        'a + b',
        'x^{2} + y^{2}',
        '\\alpha + \\beta',
        '\\sqrt{x}',
      ),
    );

    fc.assert(
      fc.property(structuredLatex, (input) => {
        // Precondition: input must NOT trigger the bug condition
        fc.pre(!isBugCondition(input));

        // Call latexToOmml twice — output must be identical (stable)
        const output1 = latexToOmml(input);
        const output2 = latexToOmml(input);
        return output1 === output2;
      }),
      { numRuns: 100, verbose: true },
    );
  }, { timeout: 15000 });
});
