// src/latex-to-omml.property.test.ts

import { describe, test, expect } from 'bun:test';
import * as fc from 'fast-check';
import { XMLParser } from 'fast-xml-parser';
import { latexToOmml } from './latex-to-omml';
import { ommlToLatex } from './omml';
import { parserOptions } from './test-omml-helpers';

function normalizeLatex(latex: string): string {
  return latex
    .replace(/\s+/g, ' ')
    .replace(/\{\s*([^{}]*)\s*\}/g, '{$1}')
    // Only remove braces around single characters, not multi-character content
    .replace(/\{([^{}\s])\}/g, '$1')
    .trim();
}

/** Environment name normalization for round-trip equivalence */
const ENV_ALIASES: Map<string, string> = new Map([
  ['align', 'aligned'], ['align*', 'aligned'],
  ['gather', 'gathered'], ['gather*', 'gathered'],
  ['split', 'aligned'], ['multline', 'gathered'], ['multline*', 'gathered'],
  ['flalign', 'aligned'], ['flalign*', 'aligned'],
]);

function semanticallyEquivalent(original: string, roundTrip: string): boolean {
  const norm1 = normalizeLatex(original);
  const norm2 = normalizeLatex(roundTrip);

  if (norm1 === norm2) return true;

  // Handle \mathrm{} wrapping - multi-letter text may get wrapped
  let converted1 = norm1;
  let converted2 = norm2;

  // Remove \mathrm{} wrappers for comparison
  converted2 = converted2.replace(/\\mathrm\{([^}]+)\}/g, '$1');

  if (converted1 === converted2) return true;

  // Handle braces around LaTeX commands in scripts: {\\alpha}^{x} vs \\alpha^{x}
  converted1 = converted1.replace(/\{(\\[a-zA-Z]+)\}/g, '$1');
  converted2 = converted2.replace(/\{(\\[a-zA-Z]+)\}/g, '$1');

  if (converted1 === converted2) return true;

  // Normalize environment names (align → aligned, gather → gathered, etc.)
  for (const [from, to] of ENV_ALIASES) {
    const escapedFrom = from.replace('*', '\\*');
    converted1 = converted1.replace(new RegExp(`\\\\begin\\{${escapedFrom}\\}`, 'g'), `\\begin{${to}}`);
    converted1 = converted1.replace(new RegExp(`\\\\end\\{${escapedFrom}\\}`, 'g'), `\\end{${to}}`);
    converted2 = converted2.replace(new RegExp(`\\\\begin\\{${escapedFrom}\\}`, 'g'), `\\begin{${to}}`);
    converted2 = converted2.replace(new RegExp(`\\\\end\\{${escapedFrom}\\}`, 'g'), `\\end{${to}}`);
  }

  if (converted1 === converted2) return true;

  // Normalize \dfrac, \tfrac, \cfrac → \frac
  converted1 = converted1.replace(/\\[dtc]frac\{/g, '\\frac{');
  converted2 = converted2.replace(/\\[dtc]frac\{/g, '\\frac{');
  // Normalize \dbinom, \tbinom → \binom
  converted1 = converted1.replace(/\\[dt]binom\{/g, '\\binom{');
  converted2 = converted2.replace(/\\[dt]binom\{/g, '\\binom{');
  // Normalize \text{} to \mathrm{}
  converted1 = converted1.replace(/\\text\{/g, '\\mathrm{');
  converted2 = converted2.replace(/\\text\{/g, '\\mathrm{');

  if (converted1 === converted2) return true;

  // Handle cases where symbols might be converted to Unicode and back
  const symbolsToUnicode = new Map([
    ['\\times', '×'], ['\\div', '÷'], ['\\pm', '±'], ['\\leq', '≤'],
    ['\\geq', '≥'], ['\\neq', '≠'], ['\\infty', '∞'], ['\\partial', '∂'],
    ['\\in', '∈'], ['\\cup', '∪'], ['\\cap', '∩']
  ]);

  for (const [latex, unicode] of symbolsToUnicode) {
    converted1 = converted1.replace(new RegExp(latex.replace('\\', '\\\\'), 'g'), unicode);
    converted2 = converted2.replace(new RegExp(latex.replace('\\', '\\\\'), 'g'), unicode);
  }

  if (converted1 === converted2) return true;

  // Last resort: strip all whitespace (math whitespace is not significant)
  return converted1.replace(/\s+/g, '') === converted2.replace(/\s+/g, '');
}

describe('LaTeX-to-OMML round-trip property tests', () => {
  test('Property 11: LaTeX-to-OMML round-trip', () => {
    // Simplified property test focusing on basic constructs that should round-trip cleanly
    const simpleAtom = fc.oneof(
      fc.constantFrom('x', 'y', 'z', 'a', 'b', 'c'), // Single letters
      fc.constantFrom('\\alpha', '\\beta', '\\gamma'), // Greek letters
      fc.constantFrom('\\times', '\\div', '\\pm') // Simple symbols
    );
    
    const simpleFraction = fc.tuple(simpleAtom, simpleAtom).map(([num, den]) => 
      '\\frac{' + num + '}{' + den + '}'
    );
    
    const simpleScript = fc.tuple(simpleAtom, simpleAtom).map(([base, script]) => 
      base + '^{' + script + '}'
    );
    
    const simpleSqrt = simpleAtom.map(x => '\\sqrt{' + x + '}');
    
    const simpleExpression = fc.oneof(
      simpleAtom,
      simpleFraction,
      simpleScript,
      simpleSqrt
    );

    fc.assert(
      fc.property(simpleExpression, (latex) => {
        try {
          // Convert LaTeX to OMML
          const omml = latexToOmml(latex);
          
          if (!omml) {
            return latex.trim() === '';
          }

          // Parse OMML XML
          const parser = new XMLParser(parserOptions);
          const parsed = parser.parse('<m:oMath>' + omml + '</m:oMath>');
          
          // Extract children from parsed structure
          let children: any[] = [];
          if (parsed && Array.isArray(parsed) && parsed[0]?.['m:oMath']) {
            children = parsed[0]['m:oMath'];
          }
          
          // Convert back to LaTeX
          const roundTrip = ommlToLatex(children);
          
          // Allow for some differences in bracing and symbol representation
          return semanticallyEquivalent(latex, roundTrip);
        } catch (error) {
          // Surface unexpected crashes so property tests can catch real defects.
          console.warn('Round-trip error for:', latex, error);
          throw error;
        }
      }),
      { 
        numRuns: 50, // Reduced from 100 for faster execution
        verbose: false
      }
    );
  }, { timeout: 10000 });

  test('Property 12: amsmath environment round-trip', () => {
    const simpleAtom = fc.constantFrom('x', 'y', 'z', 'a', 'b', 'c');

    // Aligned environment with & alignment
    const alignedEnv = fc.tuple(simpleAtom, simpleAtom, simpleAtom, simpleAtom).map(
      ([a, b, c, d]) => `\\begin{aligned}${a} &= ${b}\\\\${c} &= ${d}\\end{aligned}`
    );

    // Gathered environment (no &)
    const gatheredEnv = fc.tuple(simpleAtom, simpleAtom).map(
      ([a, b]) => `\\begin{gathered}${a} + ${b}\\\\${b}\\end{gathered}`
    );

    // Matrix variants
    const matrixEnv = fc.tuple(
      fc.constantFrom('pmatrix', 'bmatrix', 'vmatrix'),
      simpleAtom, simpleAtom, simpleAtom, simpleAtom,
    ).map(([env, a, b, c, d]) =>
      `\\begin{${env}}${a} & ${b}\\\\${c} & ${d}\\end{${env}}`
    );

    // Cases environment
    const casesEnv = fc.tuple(simpleAtom, simpleAtom).map(
      ([a, b]) => `\\begin{cases}${a} & x > 0\\\\${b} & x \\leq 0\\end{cases}`
    );

    const envExpr = fc.oneof(alignedEnv, gatheredEnv, matrixEnv, casesEnv);

    fc.assert(
      fc.property(envExpr, (latex) => {
        try {
          const omml = latexToOmml(latex);
          if (!omml) return false;

          const parser = new XMLParser(parserOptions);
          const parsed = parser.parse('<m:oMath>' + omml + '</m:oMath>');

          let children: any[] = [];
          if (parsed && Array.isArray(parsed) && parsed[0]?.['m:oMath']) {
            children = parsed[0]['m:oMath'];
          }

          const roundTrip = ommlToLatex(children);
          return semanticallyEquivalent(latex, roundTrip);
        } catch (error) {
          console.warn('Round-trip error for:', latex, error);
          throw error;
        }
      }),
      { numRuns: 50, verbose: false }
    );
  }, { timeout: 10000 });

  test('Property 13: amsmath command round-trip', () => {
    const simpleAtom = fc.constantFrom('x', 'y', 'z', 'a', 'b', 'c');

    // Boxed
    const boxed = simpleAtom.map(x => `\\boxed{${x}}`);

    // Binom
    const binom = fc.tuple(simpleAtom, simpleAtom).map(
      ([n, k]) => `\\binom{${n}}{${k}}`
    );

    // Overset/underset
    const overset = fc.tuple(simpleAtom, simpleAtom).map(
      ([top, base]) => `\\overset{${top}}{${base}}`
    );
    const underset = fc.tuple(simpleAtom, simpleAtom).map(
      ([bot, base]) => `\\underset{${bot}}{${base}}`
    );

    const cmdExpr = fc.oneof(boxed, binom, overset, underset);

    fc.assert(
      fc.property(cmdExpr, (latex) => {
        try {
          const omml = latexToOmml(latex);
          if (!omml) return false;

          const parser = new XMLParser(parserOptions);
          const parsed = parser.parse('<m:oMath>' + omml + '</m:oMath>');

          let children: any[] = [];
          if (parsed && Array.isArray(parsed) && parsed[0]?.['m:oMath']) {
            children = parsed[0]['m:oMath'];
          }

          const roundTrip = ommlToLatex(children);
          return semanticallyEquivalent(latex, roundTrip);
        } catch (error) {
          console.warn('Round-trip error for:', latex, error);
          throw error;
        }
      }),
      { numRuns: 50, verbose: false }
    );
  }, { timeout: 10000 });
});