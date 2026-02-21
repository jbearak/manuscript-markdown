// Shared test helpers for OMML round-trip tests.
// Centralises XMLParser config so changes (e.g. parseTagValue) are made once.

import { XMLParser } from 'fast-xml-parser';
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
  const parser = new XMLParser(parserOptions);
  const parsed = parser.parse('<m:oMath>' + omml + '</m:oMath>');
  if (!Array.isArray(parsed) || !parsed[0]?.['m:oMath']) {
    throw new Error('roundTrip: XMLParser returned unexpected shape for OMML: ' + omml);
  }
  return ommlToLatex(parsed[0]['m:oMath']);
}
