// Shared test helpers for OMML round-trip tests.
// Centralises XMLParser config so changes (e.g. parseTagValue) are made once,
// built as every parser is (see xmlParser).

import { xmlParser } from './xml-parser';
import { latexToOmml } from './latex-to-omml';
import { ommlToLatex } from './omml';

export const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
};

/** Parse OMML XML string back to node structure and convert to LaTeX. */
export function roundTrip(latex: string): string {
  const omml = latexToOmml(latex);
  const parser = xmlParser(parserOptions);
  const parsed = parser.parse('<m:oMath>' + omml + '</m:oMath>');
  if (!Array.isArray(parsed) || !parsed[0]?.['m:oMath']) {
    throw new Error('roundTrip: XMLParser returned unexpected shape for OMML: ' + omml);
  }
  return ommlToLatex(parsed[0]['m:oMath']);
}

/** Each of LaTeX's Greek letters, as its command, and the character Word
 *  shows for it, which export writes for the command and import writes as
 *  the command again. \epsilon and \phi are the characters LaTeX draws for
 *  them, ϵ and ϕ, and the plain ε and φ are \varepsilon and \varphi. */
export const GREEK_LETTERS: readonly (readonly [string, string])[] = [
  ['\\alpha', 'α'], ['\\beta', 'β'], ['\\gamma', 'γ'], ['\\delta', 'δ'],
  ['\\epsilon', 'ϵ'], ['\\varepsilon', 'ε'], ['\\zeta', 'ζ'], ['\\eta', 'η'],
  ['\\theta', 'θ'], ['\\vartheta', 'ϑ'], ['\\iota', 'ι'], ['\\kappa', 'κ'],
  ['\\lambda', 'λ'], ['\\mu', 'μ'], ['\\nu', 'ν'], ['\\xi', 'ξ'],
  ['\\pi', 'π'], ['\\varpi', 'ϖ'], ['\\rho', 'ρ'], ['\\varrho', 'ϱ'],
  ['\\sigma', 'σ'], ['\\varsigma', 'ς'], ['\\tau', 'τ'], ['\\upsilon', 'υ'],
  ['\\phi', 'ϕ'], ['\\varphi', 'φ'], ['\\chi', 'χ'], ['\\psi', 'ψ'], ['\\omega', 'ω'],
  ['\\Gamma', 'Γ'], ['\\Delta', 'Δ'], ['\\Theta', 'Θ'], ['\\Lambda', 'Λ'],
  ['\\Xi', 'Ξ'], ['\\Pi', 'Π'], ['\\Sigma', 'Σ'], ['\\Upsilon', 'Υ'],
  ['\\Phi', 'Φ'], ['\\Psi', 'Ψ'], ['\\Omega', 'Ω'],
];
