// src/latex-omml-fidelity.test.ts — Word fidelity of function scripts, symbols,
// math alphabets, unknown-command warnings, normal-text runs, n-ary bodies,
// and primes, in both conversion directions.

import { describe, test, expect } from 'bun:test';
import { XMLParser } from 'fast-xml-parser';
import { latexToOmml } from './latex-to-omml';
import { ommlToLatex } from './omml';
import { convertMdToDocx } from './md-to-docx';
import { parserOptions, roundTrip } from './test-omml-helpers';

const run = (t: string) => '<m:r><m:t>' + t + '</m:t></m:r>';
const styled = (t: string) => '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>' + t + '</m:t></m:r>';
const func = (fName: string, arg: string) => '<m:func><m:fName>' + fName + '</m:fName><m:e>' + arg + '</m:e></m:func>';

/** Translate Word-authored OMML (the children of an m:oMath) to LaTeX. */
function importOmml(omml: string): string {
  const parsed = new XMLParser(parserOptions).parse('<m:oMath>' + omml + '</m:oMath>');
  return ommlToLatex(parsed[0]['m:oMath']);
}

/** Exporting a round-tripped equation gives the same OMML as the original. */
function expectStableExport(latex: string): void {
  expect(latexToOmml(roundTrip(latex))).toBe(latexToOmml(latex));
}

describe('function names with scripts', () => {
  test('\\log_2(n) puts the subscript in m:fName', () => {
    expect(latexToOmml('\\log_2(n)')).toBe(func(
      '<m:sSub><m:e>' + styled('log') + '</m:e><m:sub>' + run('2') + '</m:sub></m:sSub>',
      run('(') + run('n') + run(')'),
    ));
  });

  test('\\sin^2(x) puts the superscript in m:fName', () => {
    expect(latexToOmml('\\sin^2(x)')).toBe(func(
      '<m:sSup><m:e>' + styled('sin') + '</m:e><m:sup>' + run('2') + '</m:sup></m:sSup>',
      run('(') + run('x') + run(')'),
    ));
  });

  test('\\lim_{n\\to\\infty} puts the limit under the name', () => {
    expect(latexToOmml('\\lim_{n\\to\\infty} f')).toBe(func(
      '<m:limLow><m:e>' + styled('lim') + '</m:e><m:lim>' + run('n') + run('→') + run('∞') + '</m:lim></m:limLow>',
      run('f'),
    ));
  });

  test('\\max_i x_i keeps the argument subscript inside the argument', () => {
    expect(latexToOmml('\\max_i x_i')).toBe(func(
      '<m:limLow><m:e>' + styled('max') + '</m:e><m:lim>' + run('i') + '</m:lim></m:limLow>',
      '<m:sSub><m:e>' + run('x') + '</m:e><m:sub>' + run('i') + '</m:sub></m:sSub>',
    ));
  });

  test('\\sin x_i is sin of x_i', () => {
    expect(latexToOmml('\\sin x_i')).toBe(func(
      styled('sin'),
      '<m:sSub><m:e>' + run('x') + '</m:e><m:sub>' + run('i') + '</m:sub></m:sSub>',
    ));
  });

  test('\\operatorname scripts sit beside the name, \\operatorname* scripts under it', () => {
    expect(latexToOmml('\\operatorname{argmax}_x f')).toBe(func(
      '<m:sSub><m:e>' + styled('argmax') + '</m:e><m:sub>' + run('x') + '</m:sub></m:sSub>',
      run('f'),
    ));
    expect(latexToOmml('\\operatorname*{argmax}_x f')).toBe(func(
      '<m:limLow><m:e>' + styled('argmax') + '</m:e><m:lim>' + run('x') + '</m:lim></m:limLow>',
      run('f'),
    ));
  });

  test('\\Pr, \\liminf, and \\limsup are functions', () => {
    expect(latexToOmml('\\Pr(A)')).toBe(func(styled('Pr'), run('(') + run('A') + run(')')));
    expect(latexToOmml('\\liminf_n a')).toBe(func(
      '<m:limLow><m:e>' + styled('lim inf') + '</m:e><m:lim>' + run('n') + '</m:lim></m:limLow>',
      run('a'),
    ));
    expect(latexToOmml('\\limsup a')).toBe(func(styled('lim sup'), run('a')));
  });

  test.each([
    ['\\log_2(n)', '\\log_2{(n)}'],
    ['\\sin^2(x)', '\\sin^2{(x)}'],
    ['\\lim_{n\\to\\infty} f', '\\lim_{n\\to\\infty}{f}'],
    ['\\lim_a^b f', '\\lim_a^b{f}'],
    ['\\max_i x_i', '\\max_i{x_i}'],
    ['\\operatorname{argmax}_x f', '\\operatorname{argmax}_x{f}'],
    ['\\operatorname*{argmax}_x f', '\\operatorname*{argmax}_x{f}'],
    ['\\liminf_n a', '\\liminf_n{a}'],
    ['\\Pr(A)', '\\Pr{(A)}'],
  ])('%s round-trips as %s', (latex, expected) => {
    expect(roundTrip(latex)).toBe(expected);
    expectStableExport(latex);
  });

  test('Word-authored lim imports as \\lim with its limit', () => {
    const omml = func(
      '<m:limLow><m:limLowPr><m:ctrlPr/></m:limLowPr><m:e>' + styled('lim') + '</m:e>' +
      '<m:lim>' + run('n→∞') + '</m:lim></m:limLow>',
      run('f'),
    );
    expect(importOmml(omml)).toBe('\\lim_{n\\to\\infty}{f}');
  });
});

describe('symbols', () => {
  test.each([
    ['\\langle', '⟨'], ['\\rangle', '⟩'], ['\\|', '‖'], ['\\top', '⊤'],
    ['\\Longrightarrow', '⟹'], ['\\Longleftarrow', '⟸'], ['\\Longleftrightarrow', '⟺'], ['\\longrightarrow', '⟶'],
    ['\\leqslant', '⩽'], ['\\geqslant', '⩾'],
    ['\\star', '⋆'], ['\\dagger', '†'], ['\\ddagger', '‡'], ['\\hbar', 'ℏ'],
    ['\\nexists', '∄'], ['\\ni', '∋'], ['\\uparrow', '↑'], ['\\downarrow', '↓'],
    ['\\aleph', 'ℵ'], ['\\angle', '∠'],
    ['\\lfloor', '⌊'], ['\\rfloor', '⌋'], ['\\lceil', '⌈'], ['\\rceil', '⌉'],
    ['\\lvert', '|'], ['\\rvert', '|'], ['\\lVert', '‖'], ['\\rVert', '‖'],
    ['\\bot', '⊥'], ['\\varnothing', '∅'], ['\\implies', '⟹'], ['\\iff', '⟺'],
  ])('%s becomes %s', (cmd, ch) => {
    expect(latexToOmml(cmd)).toBe(run(ch));
  });

  test.each([
    ['\\langle', '\\langle'], ['\\top', '\\top'], ['\\leqslant', '\\leqslant'], ['\\lfloor', '\\lfloor'],
    ['\\|', '\\|'], ['\\lVert', '\\|'], ['\\bot', '\\perp'], ['\\varnothing', '\\emptyset'],
    ['\\implies', '\\Longrightarrow'], ['\\iff', '\\Longleftrightarrow'],
  ])('%s round-trips as %s', (cmd, expected) => {
    expect(roundTrip('a' + cmd + ' b')).toBe('a' + expected + ' b');
  });
});

describe('math alphabets', () => {
  test.each([
    ['\\mathbf{x}', '<m:sty m:val="b"/>'],
    ['\\boldsymbol{\\beta}', '<m:sty m:val="bi"/>'],
    ['\\mathit{x}', '<m:sty m:val="i"/>'],
    ['\\mathbb{R}', '<m:scr m:val="double-struck"/><m:sty m:val="p"/>'],
    ['\\mathfrak{g}', '<m:scr m:val="fraktur"/><m:sty m:val="p"/>'],
    ['\\mathsf{A}', '<m:scr m:val="sans-serif"/><m:sty m:val="p"/>'],
    ['\\mathtt{v}', '<m:scr m:val="monospace"/><m:sty m:val="p"/>'],
  ])('%s exports with %s and round-trips', (latex, rPr) => {
    const text = latex === '\\boldsymbol{\\beta}' ? 'β' : latex.slice(-2, -1);
    expect(latexToOmml(latex)).toBe('<m:r><m:rPr>' + rPr + '</m:rPr><m:t>' + text + '</m:t></m:r>');
    expect(roundTrip(latex)).toBe(latex);
  });

  test('scripts bind to the styled letter', () => {
    expect(roundTrip('\\boldsymbol{\\beta}_c')).toBe('\\boldsymbol{\\beta}_c');
  });
});

describe('unsupported command warnings', () => {
  test('latexToOmml reports commands it spells out', () => {
    const seen: string[] = [];
    latexToOmml('\\foo x + \\frac{\\bar{y}}{\\baz}', cmd => seen.push(cmd));
    expect(seen).toEqual(['\\foo', '\\baz']);
  });

  test('export warns once per distinct command, including deleted and inserted math', async () => {
    const md = '$\\foo x$ and $\\foo y$ and {--$\\qux$--} and {++$\\baz$++} and $\\alpha$\n';
    const result = await convertMdToDocx(md);
    const math = result.warnings.filter(w => w.includes('LaTeX'));
    expect(math).toHaveLength(3);
    for (const cmd of ['\\foo', '\\qux', '\\baz']) {
      expect(math.some(w => w.includes('"' + cmd + '"'))).toBe(true);
    }
  });
});

describe('normal-text runs on import', () => {
  test('symbols in a normal-text run stay out of \\text{}', () => {
    expect(importOmml(styled('a × b'))).toBe('\\text{a }\\mathrm{\\times}\\text{ b}');
  });

  test('that LaTeX re-exports as normal-text runs with their spaces', () => {
    expect(latexToOmml('\\text{a }\\mathrm{\\times}\\text{ b}')).toBe(
      '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve">a </m:t></m:r>' +
      styled('×') +
      '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve"> b</m:t></m:r>',
    );
  });

  test('\\text keeps leading and trailing spaces in Word', () => {
    expect(latexToOmml('x\\text{ if }y')).toBe(
      run('x') + '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve"> if </m:t></m:r>' + run('y'),
    );
  });
});

describe('Word-authored n-ary bodies', () => {
  const nary = (body: string) =>
    '<m:nary><m:naryPr><m:chr m:val="∏"/><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr>' +
    '<m:sub/><m:sup/><m:e>' + body + '</m:e></m:nary>';

  test('a body that continues past its leading bracket group is braced', () => {
    const latex = importOmml(nary(run('(') + run('1') + run('-') + run('x') + run(')') + run('y')));
    expect(latex).toBe('\\prod{(1-x)y}');
    expect(latexToOmml(latex)).toEndWith(run(')') + run('y') + '</m:e></m:nary>');
  });

  test('other bodies stay unbraced', () => {
    expect(importOmml(nary(run('(') + run('1') + run('-') + run('x') + run(')')))).toBe('\\prod(1-x)');
    expect(importOmml(nary(run('x')))).toBe('\\prod x');
  });
});

describe('primes', () => {
  test("' in math exports as a prime", () => {
    expect(latexToOmml("f'(x)")).toBe(run('f') + run('′') + run('(') + run('x') + run(')'));
  });

  test("' in \\text and \\operatorname names stays an apostrophe", () => {
    expect(latexToOmml("\\text{it's}")).toBe(styled("it's"));
    expect(latexToOmml("\\operatorname{f'}{x}")).toBe(func(styled("f'"), run('x')));
  });

  test.each([
    ["f'(x)", "f'(x)"],
    ["f''", "f''"],
    ["\\text{it's}", "\\text{it's}"],
    ['f^\\prime', 'f^\\prime'],
    ["\\mathrm{d'}", "\\mathrm{d'}"],
  ])('%s round-trips as %s', (latex, expected) => {
    expect(roundTrip(latex)).toBe(expected);
  });

  test('a Word-typed prime imports as an apostrophe', () => {
    expect(importOmml(run('f′'))).toBe("f'");
  });
});

describe('review follow-ups', () => {
  test('\\limits and \\nolimits after a function name set where its limits go', () => {
    expect(latexToOmml('\\lim\\nolimits_i x')).toBe(func(
      '<m:sSub><m:e>' + styled('lim') + '</m:e><m:sub>' + run('i') + '</m:sub></m:sSub>',
      run('x'),
    ));
    expect(latexToOmml('\\operatorname{foo}\\limits_i x')).toBe(func(
      '<m:limLow><m:e>' + styled('foo') + '</m:e><m:lim>' + run('i') + '</m:lim></m:limLow>',
      run('x'),
    ));
    expect(roundTrip('\\lim\\nolimits_i x')).toBe('\\lim\\nolimits_i{x}');
    expect(roundTrip('\\operatorname{foo}\\limits_i x')).toBe('\\operatorname*{foo}_i{x}');
  });

  test('an apostrophe in an operator name inside a superscript stays an apostrophe', () => {
    expect(roundTrip("x^{\\operatorname{f'}{y}}")).toBe("x^{\\operatorname{f'}{y}}");
  });

  test.each([
    ["O'Brien_1", "\\text{O'Brien\\_1}"],
    ['50 % off', '\\text{50 \\% off}'],
    ['a {b} c', '\\text{a \\{b\\} c}'],
    ['x ~ y', '\\text{x \\textasciitilde{} y}'],
  ])('normal text %s imports escaped as %s and re-exports unchanged', (text, latex) => {
    expect(importOmml(styled(text))).toBe(latex);
    expect(latexToOmml(latex)).toBe(styled(text));
  });
});

describe('review follow-ups, round 2', () => {
  test.each([
    ['\\left\\langle x\\right\\rangle', '⟨', '⟩'],
    ['\\left\\lfloor x\\right\\rfloor', '⌊', '⌋'],
    ['\\left\\lceil x\\right\\rceil', '⌈', '⌉'],
    ['\\left\\lvert x\\right\\rvert', '|', '|'],
    ['\\left\\lVert x\\right\\rVert', '‖', '‖'],
  ])('%s uses the delimiter characters', (latex, beg, end) => {
    expect(latexToOmml(latex)).toStartWith(
      '<m:d><m:dPr><m:begChr m:val="' + beg + '"/><m:endChr m:val="' + end + '"/></m:dPr><m:e>',
    );
  });

  test('a Word function name with spaces and symbols stays one name', () => {
    const latex = importOmml(func(styled('foo × bar'), run('x')));
    expect(latex).toBe('\\operatorname{foo \\times bar}{x}');
    expect(latexToOmml(latex)).toBe(func(styled('foo × bar'), run('x')));
  });

  test('reserved characters in a Word function name are escaped', () => {
    const latex = importOmml(func(styled('a_b'), run('x')));
    expect(latex).toBe('\\operatorname{a\\_b}{x}');
    expect(latexToOmml(latex)).toBe(func(styled('a_b'), run('x')));
  });
});

describe('review follow-ups, round 3', () => {
  test.each([
    ['50%', '\\text{50\\%}'],
    ['a_b', '\\text{a\\_b}'],
    ['x#1', '\\text{x\\#1}'],
  ])('normal text %s without spaces imports escaped as %s and re-exports unchanged', (text, latex) => {
    expect(importOmml(styled(text))).toBe(latex);
    expect(latexToOmml(latex)).toBe(styled(text));
  });

  test('plain upright runs without reserved characters still import as \\mathrm', () => {
    expect(importOmml(styled('max'))).toBe('\\mathrm{max}');
  });
});

describe('review follow-ups, round 4', () => {
  test.each([
    ['<m:sty m:val="bi"/>', '\\boldsymbol{\\beta{}x}'],
    ['<m:sty m:val="p"/>', '\\mathrm{\\beta{}x}'],
    ['<m:scr m:val="double-struck"/><m:sty m:val="p"/>', '\\mathbb{\\beta{}x}'],
  ])('a styled run with a symbol before a letter imports without a separator space (%s)', (rPr, latex) => {
    const omml = '<m:r><m:rPr>' + rPr + '</m:rPr><m:t>βx</m:t></m:r>';
    expect(importOmml(omml)).toBe(latex);
    expect(latexToOmml(latex)).toBe(omml);
  });

  test('escaped reserved characters in math are not reported as unsupported', () => {
    const seen: string[] = [];
    latexToOmml('50\\% + \\#1 + \\$5 + a\\_b + a\\&b + \\{x\\}', cmd => seen.push(cmd));
    expect(seen).toEqual([]);
  });
});

describe('review follow-ups, round 5', () => {
  const sinX = func(styled('sin'), run('x'));

  test('a script on a whole Word function stays outside its argument', () => {
    const omml = '<m:sSup><m:e>' + sinX + '</m:e><m:sup>' + run('2') + '</m:sup></m:sSup>';
    expect(importOmml(omml)).toBe('{\\sin{x}}^2');
    expect(latexToOmml(importOmml(omml))).toBe(omml);
  });

  test('a Word function in a script is braced', () => {
    const omml = '<m:sSub><m:e>' + run('a') + '</m:e><m:sub>' + sinX + '</m:sub></m:sSub>';
    expect(importOmml(omml)).toBe('a_{\\sin{x}}');
  });

  test.each([
    ['\\left\\langle{}x\\right\\rangle', '⟨', '⟩'],
    ['\\left\\lfloor{}x\\right\\rfloor', '⌊', '⌋'],
    ['\\left\\lceil{}x\\right\\rceil', '⌈', '⌉'],
    ['\\left\\|x\\right\\|', '‖', '‖'],
    ['\\left\\langle{}x\\right|', '⟨', '|'],
    ['\\left\\langle{}x\\right.', '⟨', ''],
    ['\\left\\{x\\right\\}', '{', '}'],
  ])('%s imports as a \\left/\\right pair and re-exports as the same delimiter', (latex, beg, end) => {
    const omml = '<m:d><m:dPr><m:begChr m:val="' + beg + '"/><m:endChr m:val="' + end + '"/></m:dPr><m:e>' + run('x') + '</m:e></m:d>';
    expect(importOmml(omml)).toBe(latex);
    expect(latexToOmml(latex)).toBe(omml);
  });

  test('parentheses and brackets still import bare', () => {
    expect(importOmml('<m:d><m:e>' + run('x') + '</m:e></m:d>')).toBe('(x)');
  });
});

describe('review follow-ups, round 6', () => {
  const angle = (body: string) =>
    '<m:d><m:dPr><m:begChr m:val="⟨"/><m:endChr m:val="⟩"/></m:dPr><m:e>' + body + '</m:e></m:d>';

  test('a letter after a named closing delimiter does not gain a space', () => {
    const omml = angle(run('a')) + run('x');
    expect(importOmml(omml)).toBe('\\left\\langle{}a\\right\\rangle{}x');
    expect(latexToOmml(importOmml(omml))).toBe(omml);
  });

  test.each([
    ['side scripts on lim', '<m:sSub><m:e>' + styled('lim') + '</m:e><m:sub>' + run('i') + '</m:sub></m:sSub>', '\\lim\\nolimits_i{x}'],
    ['a limit under sin', '<m:limLow><m:e>' + styled('sin') + '</m:e><m:lim>' + run('i') + '</m:lim></m:limLow>', '\\sin\\limits_i{x}'],
  ])('%s keeps its placement through a round trip', (_, fName, latex) => {
    const omml = func(fName, run('x'));
    expect(importOmml(omml)).toBe(latex);
    expect(latexToOmml(latex)).toBe(omml);
  });

  test('an n-ary body that continues past a leading \\left…\\right group is braced', () => {
    const omml =
      '<m:nary><m:naryPr><m:chr m:val="∏"/><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr>' +
      '<m:sub></m:sub><m:sup></m:sup><m:e>' + angle(run('x')) + run('y') + '</m:e></m:nary>';
    expect(importOmml(omml)).toBe('\\prod{\\left\\langle{}x\\right\\rangle{}y}');
    expect(latexToOmml(importOmml(omml))).toBe(omml);
  });
});

describe('review follow-ups, round 7', () => {
  test.each([
    ['\\mathbf{x% note\ny}', '\\mathbf{x}% note\n\\mathbf{y}'],
    ['\\mathrm{ab% note\ncd}', '\\mathrm{ab}% note\n\\mathrm{cd}'],
    ['\\mathcal{A% note\nB}', '\\mathcal{A}% note\n\\mathcal{B}'],
  ])('a comment inside %s survives the round trip', (latex, back) => {
    expect(latexToOmml(latex)).toContain('​% note');
    expect(roundTrip(latex)).toBe(back);
    expectStableExport(latex);
  });

  test.each([
    ['\\left\\Vert x\\right\\Vert', '‖', '‖'],
    ['\\left\\vert x\\right\\vert', '|', '|'],
    ['\\left\\lbrace x\\right\\rbrace', '{', '}'],
  ])('%s exports as a delimiter', (latex, beg, end) => {
    expect(latexToOmml(latex)).toStartWith('<m:d><m:dPr><m:begChr m:val="' + beg + '"/><m:endChr m:val="' + end + '"/>');
  });

  test('an unknown delimiter command is reported', () => {
    const seen: string[] = [];
    latexToOmml('\\left\\foo x\\right\\bar', cmd => seen.push(cmd));
    expect(seen).toEqual(['\\foo', '\\bar']);
  });

  test('commands inside discarded tags and labels are not reported', () => {
    const seen: string[] = [];
    latexToOmml('x \\tag{\\ref{a}} \\label{eq:\\foo}', cmd => seen.push(cmd));
    latexToOmml('\\begin{align} a &= b \\label{\\foo} \\\\ c &= d \\tag*{\\bar} \\end{align}', cmd => seen.push(cmd));
    expect(seen).toEqual([]);
  });
});

describe('review follow-ups, round 8', () => {
  const bold = (t: string) => '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>' + t + '</m:t></m:r>';

  test.each([
    ['50%', '\\mathbf{50\\%}'],
    ['A_B', '\\mathbf{A\\_B}'],
    ['{x}', '\\mathbf{\\{x\\}}'],
    ['a^b', '\\mathbf{\\text{a\\textasciicircum{}b}}'],
  ])('a bold run %s imports with its reserved characters escaped', (text, latex) => {
    expect(importOmml(bold(text))).toBe(latex);
    expect(latexToOmml(latex)).toBe(bold(text));
  });

  test('escapes in \\mathrm export as the plain character', () => {
    expect(latexToOmml('\\mathrm{50\\%}')).toBe(styled('50%'));
  });

  test.each([
    ['↑', '↓', '\\left\\uparrow{}x\\right\\downarrow'],
    ['⟨', '|', '\\left\\langle{}x\\right|'],
  ])('delimiters %s %s round-trip as delimiters', (beg, end, latex) => {
    const omml = '<m:d><m:dPr><m:begChr m:val="' + beg + '"/><m:endChr m:val="' + end + '"/></m:dPr><m:e>' + run('x') + '</m:e></m:d>';
    expect(importOmml(omml)).toBe(latex);
    expect(latexToOmml(latex)).toBe(omml);
  });

  test('a control symbol needs no separator before a letter', () => {
    expect(importOmml(run('‖x‖'))).toBe('\\|x\\|');
  });
});

describe('review follow-ups, round 9', () => {
  test('escapes in a bracketed operand inside a styled group give their character', () => {
    expect(latexToOmml('\\mathrm{\\sin(50\\%)}')).toBe(styled('sin(50%)'));
    expect(latexToOmml("\\text{\\operatorname{f}(it's)}")).toBe(styled("f(it's)"));
  });
});
