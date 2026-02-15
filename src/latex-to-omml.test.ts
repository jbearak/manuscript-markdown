// src/latex-to-omml.test.ts

import { describe, test, expect } from 'bun:test';
import { latexToOmml } from './latex-to-omml';

describe('latexToOmml', () => {
  test('empty input', () => {
    expect(latexToOmml('')).toBe('');
    expect(latexToOmml('   ')).toBe('');
  });

  test('simple text', () => {
    const result = latexToOmml('x');
    expect(result).toBe('<m:r><m:t>x</m:t></m:r>');
  });

  test('Greek letters', () => {
    const result = latexToOmml('\\alpha');
    expect(result).toBe('<m:r><m:t>α</m:t></m:r>');
    
    const result2 = latexToOmml('\\beta');
    expect(result2).toBe('<m:r><m:t>β</m:t></m:r>');
    
    const result3 = latexToOmml('\\Gamma');
    expect(result3).toBe('<m:r><m:t>Γ</m:t></m:r>');
  });

  test('fractions', () => {
    const result = latexToOmml('\\frac{a}{b}');
    expect(result).toBe('<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f>');
  });

  test('superscripts', () => {
    const result = latexToOmml('x^{2}');
    expect(result).toBe('<m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>');
    
    const result2 = latexToOmml('x^2');
    expect(result2).toBe('<m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>');
  });

  test('scripts bind to the nearest preceding atom', () => {
    const result = latexToOmml('a+b^2');
    expect(result).toContain('<m:r><m:t>a</m:t></m:r><m:r><m:t>+</m:t></m:r><m:sSup><m:e><m:r><m:t>b</m:t></m:r></m:e>');
    expect(result).not.toContain('<m:sSup><m:e><m:r><m:t>a+b</m:t></m:r></m:e>');
  });

  test('subscripts', () => {
    const result = latexToOmml('x_{i}');
    expect(result).toBe('<m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub>');
    
    const result2 = latexToOmml('x_i');
    expect(result2).toBe('<m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub>');
  });

  test('combined sub/superscripts', () => {
    const result = latexToOmml('x_{i}^{n}');
    expect(result).toBe('<m:sSubSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup></m:sSubSup>');
    
    const result2 = latexToOmml('x^{n}_{i}');
    expect(result2).toBe('<m:sSubSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup></m:sSubSup>');
  });

  test('square roots', () => {
    const result = latexToOmml('\\sqrt{x}');
    expect(result).toBe('<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad>');
    
    const result2 = latexToOmml('\\sqrt[3]{x}');
    expect(result2).toBe('<m:rad><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad>');
  });

  test('n-ary operators', () => {
    const result = latexToOmml('\\sum_{i=0}^{n}x_i');
    expect(result).toContain('<m:nary>');
    expect(result).toContain('<m:chr m:val="∑"/>');
    expect(result).toContain('<m:sub>');
    expect(result).toContain('<m:sup>');
    expect(result).toContain('<m:naryPr>');
    expect(result).toContain('<m:e><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub></m:e>');
    expect(result).not.toContain('<m:sSub><m:e><m:nary>');
  });

  test('delimiters', () => {
    const result = latexToOmml('\\left(x\\right)');
    expect(result).toBe('<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:d>');
  });

  test('delimiter parsing does not corrupt output when \\right is missing', () => {
    const result = latexToOmml('\\left(x');
    expect(result).toBe('<m:r><m:t>(</m:t></m:r><m:r><m:t>x</m:t></m:r>');
    expect(result).not.toContain('<m:d>');
  });

  test('delimiter parsing preserves trailing text after \\right delimiter', () => {
    const result = latexToOmml('\\left(a\\right)+c');
    expect(result).toContain('<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr>');
    expect(result).toContain('</m:d><m:r><m:t>+</m:t></m:r><m:r><m:t>c</m:t></m:r>');
  });

  test('delimiter parsing handles scripts inside delimiters as math scripts', () => {
    const result = latexToOmml('\\left(x^2\\right)');
    expect(result).toContain('<m:d>');
    expect(result).toContain('<m:sSup>');
    expect(result).not.toContain('<m:t>^</m:t>');
  });

  test('accents', () => {
    const result = latexToOmml('\\hat{x}');
    expect(result).toBe('<m:acc><m:accPr><m:chr m:val="ˆ"/></m:accPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:acc>');
  });

  test('matrices', () => {
    const result = latexToOmml('\\begin{matrix}a & b\\\\c & d\\end{matrix}');
    expect(result).toContain('<m:m>');
    expect(result).toContain('<m:mr>');
    expect(result).toContain('<m:e>');
  });

  test('functions', () => {
    const result = latexToOmml('\\sin{x}');
    expect(result).toBe('<m:func><m:fName><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t></m:r></m:fName><m:e><m:r><m:t>x</m:t></m:r></m:e></m:func>');
    
    const result2 = latexToOmml('\\operatorname{custom}{x}');
    expect(result2).toBe('<m:func><m:fName><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>custom</m:t></m:r></m:fName><m:e><m:r><m:t>x</m:t></m:r></m:e></m:func>');
  });

  test('mathrm', () => {
    const result = latexToOmml('\\mathrm{text}');
    expect(result).toBe('<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>text</m:t></m:r>');
  });

  test('mathrm does not double-escape XML entities', () => {
    const result = latexToOmml('\\mathrm{A&B}');
    expect(result).toBe('<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>A&amp;B</m:t></m:r>');
  });

  test('operatorname does not double-escape XML entities', () => {
    const result = latexToOmml('\\operatorname{A&B}{x}');
    expect(result).toBe('<m:func><m:fName><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>A&amp;B</m:t></m:r></m:fName><m:e><m:r><m:t>x</m:t></m:r></m:e></m:func>');
  });

  test('fallback for unsupported', () => {
    const result = latexToOmml('\\unsupported{x}');
    expect(result).toBe('<m:r><m:t>\\unsupported</m:t></m:r><m:r><m:t>x</m:t></m:r>');
  });

  test('nested constructs', () => {
    const result = latexToOmml('\\frac{\\sqrt{x}}{y^{2}}');
    expect(result).toContain('<m:f>');
    expect(result).toContain('<m:rad>');
    expect(result).toContain('<m:sSup>');
  });
});