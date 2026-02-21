// src/latex-to-omml.test.ts

import { describe, test, expect } from 'bun:test';
import { XMLParser } from 'fast-xml-parser';
import { latexToOmml } from './latex-to-omml';
import { ommlToLatex } from './omml';

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
};

/** Parse OMML XML string back to node structure and convert to LaTeX. */
function roundTrip(latex: string): string {
  const omml = latexToOmml(latex);
  const parser = new XMLParser(parserOptions);
  const parsed = parser.parse('<m:oMath>' + omml + '</m:oMath>');
  let children: any[] = [];
  if (parsed && Array.isArray(parsed) && parsed[0]?.['m:oMath']) {
    children = parsed[0]['m:oMath'];
  }
  return ommlToLatex(children);
}

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

  test('scripts skip comment atoms and bind to the preceding real atom', () => {
    // % comment followed by a superscript — ^ should bind to x, not the comment
    const result = latexToOmml('x % note\n^2');
    expect(result).toContain('<m:sSup><m:e><m:r><m:t>x</m:t></m:r>');
    expect(result).toContain('<m:sup><m:r><m:t>2</m:t></m:r></m:sup>');
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

  test('matrix cells support scripts', () => {
    const result = latexToOmml('\\begin{matrix}x^2 & y_i\\end{matrix}');
    expect(result).toContain('<m:sSup>');
    expect(result).toContain('<m:sSub>');
    expect(result).not.toContain('<m:t>^</m:t>');
    expect(result).not.toContain('<m:t>_</m:t>');
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

  // --- amsmath environments ---

  test('pmatrix', () => {
    const result = latexToOmml('\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}');
    expect(result).toContain('<m:d>');
    expect(result).toContain('<m:begChr m:val="("/>');
    expect(result).toContain('<m:endChr m:val=")"/>');
    expect(result).toContain('<m:m>');
    expect(result).toContain('<m:mr>');
  });

  test('bmatrix', () => {
    const result = latexToOmml('\\begin{bmatrix}a & b\\\\c & d\\end{bmatrix}');
    expect(result).toContain('<m:begChr m:val="["/>');
    expect(result).toContain('<m:endChr m:val="]"/>');
    expect(result).toContain('<m:m>');
  });

  test('Bmatrix', () => {
    const result = latexToOmml('\\begin{Bmatrix}a & b\\\\c & d\\end{Bmatrix}');
    expect(result).toContain('<m:begChr m:val="{"/>');
    expect(result).toContain('<m:endChr m:val="}"/>');
    expect(result).toContain('<m:m>');
  });

  test('vmatrix', () => {
    const result = latexToOmml('\\begin{vmatrix}a & b\\\\c & d\\end{vmatrix}');
    expect(result).toContain('<m:begChr m:val="|"/>');
    expect(result).toContain('<m:endChr m:val="|"/>');
    expect(result).toContain('<m:m>');
  });

  test('Vmatrix', () => {
    const result = latexToOmml('\\begin{Vmatrix}a & b\\\\c & d\\end{Vmatrix}');
    expect(result).toContain('<m:begChr m:val="\u2016"/>');
    expect(result).toContain('<m:endChr m:val="\u2016"/>');
    expect(result).toContain('<m:m>');
  });

  test('cases', () => {
    const result = latexToOmml('\\begin{cases}x+1 & x > 0\\\\0 & x \\leq 0\\end{cases}');
    expect(result).toContain('<m:d>');
    expect(result).toContain('<m:begChr m:val="{"/>');
    expect(result).toContain('<m:endChr m:val=""/>');
    expect(result).toContain('<m:eqArr>');
    expect(result).toContain('<m:e>');
  });

  test('aligned', () => {
    const result = latexToOmml('\\begin{aligned}a &= b\\\\c &= d\\end{aligned}');
    expect(result).toContain('<m:eqArr>');
    expect(result).toContain('<m:e>');
    // Should have two rows (two <m:e> elements)
    const eCount = (result.match(/<m:e>/g) || []).length;
    expect(eCount).toBe(2);
  });

  test('gathered', () => {
    const result = latexToOmml('\\begin{gathered}a + b\\\\c + d\\end{gathered}');
    expect(result).toContain('<m:eqArr>');
  });

  test('align maps to eqArr', () => {
    const result = latexToOmml('\\begin{align}a &= b\\end{align}');
    expect(result).toContain('<m:eqArr>');
  });

  test('equation strips wrapper', () => {
    const result = latexToOmml('\\begin{equation}E=mc^2\\end{equation}');
    expect(result).not.toContain('equation');
    expect(result).toContain('<m:r>');
  });

  test('alignat consumes column count', () => {
    const result = latexToOmml('\\begin{alignat}{2}a &= b & c &= d\\end{alignat}');
    expect(result).toContain('<m:eqArr>');
    // Column count {2} should be consumed, not in output
    expect(result).not.toContain('{2}');
  });

  test('equation array with \\tag and \\label', () => {
    const result = latexToOmml('\\begin{align}a &= b \\tag{1} \\label{eq1}\\end{align}');
    expect(result).toContain('<m:eqArr>');
    // Tags and labels should be silently consumed
    expect(result).not.toContain('tag');
    expect(result).not.toContain('label');
    expect(result).not.toContain('eq1');
  });

  // --- amsmath commands ---

  test('\\text{} produces styled run', () => {
    const result = latexToOmml('\\text{hello}');
    expect(result).toContain('<m:sty m:val="p"/>');
    expect(result).toContain('hello');
  });

  test('\\boxed{}', () => {
    const result = latexToOmml('\\boxed{x}');
    expect(result).toContain('<m:borderBox>');
    expect(result).toContain('<m:e>');
    expect(result).toContain('x');
  });

  test('\\dfrac is same as \\frac', () => {
    const frac = latexToOmml('\\frac{a}{b}');
    const dfrac = latexToOmml('\\dfrac{a}{b}');
    expect(dfrac).toBe(frac);
  });

  test('\\binom produces noBar fraction in parens', () => {
    const result = latexToOmml('\\binom{n}{k}');
    expect(result).toContain('<m:d>');
    expect(result).toContain('<m:f>');
    expect(result).toContain('<m:type m:val="noBar"/>');
    expect(result).toContain('<m:num>');
    expect(result).toContain('<m:den>');
  });

  test('\\overset{top}{base}', () => {
    const result = latexToOmml('\\overset{\\sim}{=}');
    expect(result).toContain('<m:limUpp>');
    expect(result).toContain('<m:lim>');
    expect(result).toContain('<m:e>');
  });

  test('\\underset{bot}{base}', () => {
    const result = latexToOmml('\\underset{n}{\\max}');
    expect(result).toContain('<m:limLow>');
    expect(result).toContain('<m:lim>');
    expect(result).toContain('<m:e><m:func>');
  });

  test('\\tag is silently consumed', () => {
    const result = latexToOmml('x \\tag{1}');
    expect(result).not.toContain('tag');
    expect(result).not.toContain('1');
    expect(result).toContain('x');
  });

  test('\\label is silently consumed', () => {
    const result = latexToOmml('x \\label{eq1}');
    expect(result).not.toContain('label');
    expect(result).toContain('x');
  });

  test('\\displaystyle is silently consumed', () => {
    const result = latexToOmml('\\displaystyle x');
    expect(result).not.toContain('displaystyle');
    expect(result).toContain('x');
  });

  test('spacing commands', () => {
    expect(latexToOmml('a\\,b')).toContain('\u2009');
    expect(latexToOmml('a\\:b')).toContain('\u205F');
    expect(latexToOmml('a\\;b')).toContain('\u2004');
    expect(latexToOmml('a\\quad b')).toContain('\u2003');
    expect(latexToOmml('a\\qquad b')).toContain('\u2003\u2003');
  });

  test('\\dots and variants map to ellipsis', () => {
    expect(latexToOmml('\\dots')).toContain('…');
    expect(latexToOmml('\\dotsc')).toContain('…');
    expect(latexToOmml('\\dotsb')).toContain('…');
    expect(latexToOmml('\\ddots')).toContain('⋱');
    expect(latexToOmml('\\vdots')).toContain('⋮');
  });

  test('\\overline and \\underline', () => {
    const ol = latexToOmml('\\overline{x}');
    expect(ol).toContain('<m:bar>');
    expect(ol).toContain('<m:pos m:val="top"/>');

    const ul = latexToOmml('\\underline{x}');
    expect(ul).toContain('<m:bar>');
    expect(ul).toContain('<m:pos m:val="bot"/>');
  });

  test('\\overbrace and \\underbrace', () => {
    const ob = latexToOmml('\\overbrace{x+y}');
    expect(ob).toContain('<m:groupChr>');
    expect(ob).toContain('\u23DE');

    const ub = latexToOmml('\\underbrace{x+y}');
    expect(ub).toContain('<m:groupChr>');
    expect(ub).toContain('\u23DF');
  });

  test('\\pmod', () => {
    const result = latexToOmml('\\pmod{p}');
    expect(result).toContain('<m:d>');
    expect(result).toContain('mod');
    expect(result).toContain('p');
  });

  test('\\bmod', () => {
    const result = latexToOmml('a \\bmod b');
    expect(result).toContain('mod');
    expect(result).toContain('<m:sty m:val="p"/>');
  });

  test('\\shoveleft emits inner content', () => {
    const result = latexToOmml('\\shoveleft{x}');
    expect(result).toContain('x');
    expect(result).not.toContain('shoveleft');
  });

  test('smallmatrix treated as matrix', () => {
    const result = latexToOmml('\\begin{smallmatrix}a & b\\\\c & d\\end{smallmatrix}');
    expect(result).toContain('<m:m>');
    expect(result).toContain('<m:mr>');
  });

  test('\\left\\| produces double-bar delimiter', () => {
    const result = latexToOmml('\\left\\|x\\right\\|');
    expect(result).toContain('<m:begChr m:val="\u2016"/>');
    expect(result).toContain('<m:endChr m:val="\u2016"/>');
  });

  // --- null delimiter tests ---

  test('\\left. produces empty begChr', () => {
    const result = latexToOmml('\\left.\\frac{df}{dx}\\right|_{x=0}');
    expect(result).toContain('<m:begChr m:val=""/>');
    expect(result).toContain('<m:endChr m:val="|"/>');
    expect(result).toContain('<m:d>');
  });

  test('\\right. produces empty endChr', () => {
    const result = latexToOmml('\\left(\\frac{1}{x}\\right.');
    expect(result).toContain('<m:begChr m:val="("/>');
    expect(result).toContain('<m:endChr m:val=""/>');
    expect(result).toContain('<m:d>');
  });

  // --- operatorname edge cases ---

  test('\\operatorname{foo}x works like \\sin x', () => {
    const opResult = latexToOmml('\\operatorname{foo}{x}');
    const sinResult = latexToOmml('\\sin{x}');
    // Both should produce m:func with m:fName and m:e
    expect(opResult).toContain('<m:func>');
    expect(opResult).toContain('<m:fName>');
    expect(opResult).toContain('foo');
    expect(sinResult).toContain('<m:func>');
    expect(sinResult).toContain('<m:fName>');
  });

  test('\\operatorname{foo} at end of input produces empty m:e', () => {
    const result = latexToOmml('\\operatorname{foo}');
    expect(result).toContain('<m:func>');
    expect(result).toContain('foo');
    expect(result).toContain('<m:e></m:e>');
  });

  // --- Equation alignment round-trip tests ---

  describe('alignment round-trip', () => {
    test('aligned with & markers round-trips to aligned (not gathered)', () => {
      const result = roundTrip('\\begin{aligned}a + b &= c\\\\x &= y + z\\end{aligned}');
      expect(result).toContain('\\begin{aligned}');
      expect(result).toContain('\\end{aligned}');
      expect(result).toContain('&');
    });

    test('& alignment markers survive round-trip in each row', () => {
      const result = roundTrip('\\begin{aligned}a &= b\\\\c &= d\\end{aligned}');
      const rows = result.replace(/.*\\begin\{aligned\}\s*/, '').replace(/\s*\\end\{aligned\}.*/, '').split('\\\\');
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row).toContain('&');
      }
    });

    test('multi-column alignment preserves all & markers', () => {
      const result = roundTrip('\\begin{aligned}a &= b & c &= d\\\\e &= f & g &= h\\end{aligned}');
      expect(result).toContain('\\begin{aligned}');
      // Each row should have multiple & markers
      const rows = result.replace(/.*\\begin\{aligned\}\s*/, '').replace(/\s*\\end\{aligned\}.*/, '').split('\\\\');
      expect(rows.length).toBe(2);
      for (const row of rows) {
        const ampCount = (row.match(/&/g) || []).length;
        expect(ampCount).toBeGreaterThanOrEqual(2);
      }
    });

    test('cases environment round-trips with & markers', () => {
      const result = roundTrip('\\begin{cases}x+1 & x > 0\\\\0 & x \\leq 0\\end{cases}');
      expect(result).toContain('\\begin{cases}');
      expect(result).toContain('\\end{cases}');
      expect(result).toContain('&');
    });

    test('gathered (no &) stays as gathered', () => {
      const result = roundTrip('\\begin{gathered}a + b = c\\\\x = y + z\\end{gathered}');
      expect(result).toContain('\\begin{gathered}');
      expect(result).toContain('\\end{gathered}');
      expect(result).not.toContain('&');
    });

    test('align environment round-trips as aligned', () => {
      const result = roundTrip('\\begin{align}a &= b\\\\c &= d\\end{align}');
      expect(result).toContain('\\begin{aligned}');
      expect(result).toContain('&');
    });
  });
});