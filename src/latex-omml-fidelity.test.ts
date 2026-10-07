// src/latex-omml-fidelity.test.ts — Word fidelity of function scripts, symbols,
// math alphabets, unknown-command warnings, normal-text runs, n-ary bodies,
// function arguments, script braces, and primes, in both conversion
// directions.

import { describe, test, expect } from 'bun:test';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { latexToOmml, trackedLatexToOmml, CRITIC_INSERTION_COMMAND, CRITIC_DELETION_COMMAND } from './latex-to-omml';
import { ommlToLatex } from './omml';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
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
    ['\\log_2(n)', '\\log_2(n)'],
    ['\\sin^2(x)', '\\sin^2(x)'],
    ['\\lim_{n\\to\\infty} f', '\\lim_{n\\to\\infty}{f}'],
    ['\\lim_a^b f', '\\lim_a^b{f}'],
    ['\\max_i x_i', '\\max_i{x_i}'],
    ['\\operatorname{argmax}_x f', '\\operatorname{argmax}_x{f}'],
    ['\\operatorname*{argmax}_x f', '\\operatorname*{argmax}_x{f}'],
    ['\\liminf_n a', '\\liminf_n{a}'],
    ['\\Pr(A)', '\\Pr(A)'],
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

  test('a body whose leading bracket never closes is braced', () => {
    const latex = importOmml(nary(run('(') + run('x')));
    expect(latex).toBe('\\prod{(x}');
    expect(latexToOmml(latex)).toEndWith(run('(') + run('x') + '</m:e></m:nary>');
  });

  test('other bodies stay unbraced', () => {
    expect(importOmml(nary(run('(') + run('1') + run('-') + run('x') + run(')')))).toBe('\\prod(1-x)');
    expect(importOmml(nary(run('x')))).toBe('\\prod x');
  });
});

describe('Word-authored function arguments', () => {
  const delimited = (begChr: string, endChr: string, body: string) =>
    '<m:d><m:dPr><m:begChr m:val="' + begChr + '"/><m:endChr m:val="' + endChr + '"/></m:dPr><m:e>' + body + '</m:e></m:d>';

  test.each([
    ['(x)', run('(') + run('x') + run(')'), '\\sin(x)'],
    ['[x]', run('[') + run('x') + run(']'), '\\sin[x]'],
    ['⟨x⟩', delimited('⟨', '⟩', run('x')), '\\sin\\left\\langle{}x\\right\\rangle'],
  ])('an argument that is one bracket group, %s, is not braced', (_, arg, latex) => {
    const omml = func(styled('sin'), arg);
    expect(importOmml(omml)).toBe(latex);
    expect(latexToOmml(latex)).toBe(omml);
  });

  test.each([
    ['continues past its bracket group', run('(') + run('x') + run(')') + run('y'), '\\sin{(x)y}'],
    ['never closes its bracket', run('(') + run('x'), '\\sin{(x}'],
    ['has a ( after \\left, which export does not count', run('(') + delimited('(', '⟩', run('a')) + run(')') + run(')'),
      '\\sin{(\\left(a\\right\\rangle))}'],
  ])('an argument that %s is braced', (_, arg, latex) => {
    const omml = func(styled('sin'), arg);
    expect(importOmml(omml)).toBe(latex);
    expect(latexToOmml(latex)).toBe(omml);
  });

  test('a bracket in a comment does not close the argument', () => {
    expect(roundTrip('\\sin{(x %c)\n)}')).toBe('\\sin(x %c)\n)');
    expectStableExport('\\sin(x %c)\n)');
  });
});

describe('script braces on import', () => {
  test.each(['\\tau_{\\mathrm{age}}', 'x^{\\mathbf{v}}', 'x_{\\mathcal{A}}'])('%s keeps the braces around its script', latex => {
    expect(roundTrip(latex)).toBe(latex);
  });

  test('a script of one character or one command needs no braces', () => {
    expect(roundTrip('N^{+}')).toBe('N^+');
    expect(roundTrip('x_{\\alpha}')).toBe('x_\\alpha');
  });

  test('a base that is one command with an argument stays bare', () => {
    expect(roundTrip('\\mathcal{A}^2')).toBe('\\mathcal{A}^2');
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

describe('tracked changes inside an equation', () => {
  const track = (element: 'w:ins' | 'w:del', omml: string) => '<' + element + '>' + omml + '</' + element + '>';

  test('a tracked part stays inside the structure that contains it', () => {
    expect(trackedLatexToOmml('x^{' + CRITIC_INSERTION_COMMAND + '{2}}', track)).toBe(
      '<m:sSup><m:e>' + run('x') + '</m:e><m:sup><w:ins>' + run('2') + '</w:ins></m:sup></m:sSup>',
    );
    expect(trackedLatexToOmml('\\frac{a}{' + CRITIC_DELETION_COMMAND + '{b}c}', track)).toBe(
      '<m:f><m:num>' + run('a') + '</m:num><m:den><w:del>' + run('b') + '</w:del>' + run('c') + '</m:den></m:f>',
    );
  });

  test('a tracked part in a function operand or styled text keeps its revision', () => {
    const upright = (t: string, preserve = false) => '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t' + (preserve ? ' xml:space="preserve"' : '') + '>' + t + '</m:t></m:r>';
    expect(trackedLatexToOmml('\\sin(' + CRITIC_INSERTION_COMMAND + '{x})', track)).toContain(
      '<m:e>' + run('(') + '<w:ins>' + run('x') + '</w:ins>' + run(')') + '</m:e>',
    );
    expect(trackedLatexToOmml('\\text{a ' + CRITIC_INSERTION_COMMAND + '{b} c}', track)).toBe(
      upright('a ', true) + '<w:ins>' + upright('b') + '</w:ins>' + upright(' c', true),
    );
    expect(trackedLatexToOmml('\\mathbf{a' + CRITIC_DELETION_COMMAND + '{b}}', track)).toBe(
      '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>a</m:t></m:r><w:del><m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>b</m:t></m:r></w:del>',
    );
    expect(trackedLatexToOmml('\\operatorname{mar' + CRITIC_INSERTION_COMMAND + '{gin}}x', track)).toContain(
      '<m:fName>' + upright('mar') + '<w:ins>' + upright('gin') + '</w:ins></m:fName>',
    );
  });

  test('a root degree with a tracked part or a command stays the degree', () => {
    const root = (degree: string, radicand: string) => '<m:rad><m:deg>' + degree + '</m:deg><m:e>' + radicand + '</m:e></m:rad>';
    expect(trackedLatexToOmml('\\sqrt[' + CRITIC_INSERTION_COMMAND + '{3}]{a}', track)).toBe(root('<w:ins>' + run('3') + '</w:ins>', run('a')));
    expect(latexToOmml('\\sqrt[\\alpha]{x}')).toBe(root(run('\u03B1'), run('x')));
    expect(latexToOmml('\\sqrt[n+1]{x}')).toBe(root(run('n') + run('+') + run('1'), run('x')));
    expect(latexToOmml('\\sqrt[]{x}')).toBe('<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>' + run('x') + '</m:e></m:rad>');
  });

  test('a \\right with no \\left is its delimiter', () => {
    const seen: string[] = [];
    expect(latexToOmml('x\\right)', cmd => seen.push(cmd))).toBe(run('x') + run(')'));
    expect(latexToOmml('x\\right.')).toBe(run('x'));
    expect(seen).toEqual([]);
  });

  test('an \\end with no \\begin is nothing', () => {
    const seen: string[] = [];
    expect(latexToOmml(' a \\end{matrix}', cmd => seen.push(cmd))).toBe(run(' ') + run('a') + run(' '));
    expect(seen).toEqual([]);
  });

  test('without a tracker the commands are unsupported, as a user writing them would expect', () => {
    const seen: string[] = [];
    expect(latexToOmml('a' + CRITIC_INSERTION_COMMAND + '{b}', cmd => seen.push(cmd))).toContain('mmCriticIns');
    expect(seen).toEqual([CRITIC_INSERTION_COMMAND]);
  });
});

describe('spaces Word keeps in an equation', () => {
  const kept = (t: string) => '<m:r><m:t xml:space="preserve">' + t + '</m:t></m:r>';

  test('source whitespace, which LaTeX ignores, goes without, so Word drops it too', () => {
    expect(latexToOmml('a + b')).toBe(run('a') + run(' ') + run('+') + run(' ') + run('b'));
  });

  // A \left( alone, which Word can't track in place, reads back as its delimiter
  test.each([
    ['an insertion', '$a{++ ++}b$', '<w:ins w:id="0" w:author="Unknown">' + kept(' ') + '</w:ins>', '$a{++ ++}b$'],
    ['a deletion', '$a{-- --}b$', '<w:del w:id="0" w:author="Unknown">' + kept(' ') + '</w:del>', '$a{-- --}b$'],
    ['a substitution', '$a{~~ ~>x~~}b$', '<w:del w:id="0" w:author="Unknown">' + kept(' ') + '</w:del>', '$a{~~ ~>x~~}b$'],
    ['an equation replaced by whitespace', '${~~\\left(~> ~~}$', '<w:ins w:id="1" w:author="Unknown">' + kept(' ') + '</w:ins>', '${~~(~> ~~}$'],
    ['a control space', '$a{++\\ ++}b$', '<w:ins w:id="0" w:author="Unknown">' + kept(' ') + '</w:ins>', '$a{++ ++}b$'],
  ])('a change of only whitespace keeps it in Word: %s', async (_name, md, expected, readBack) => {
    const docx = (await convertMdToDocx(md + '\n')).docx;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain(expected);
    expect(xml).not.toMatch(/<m:t>(?:\s[^<]*|[^<]*\s)<\/m:t>/);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toContain(readBack + '\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  const equationXml = async (docx: Uint8Array) => {
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    return xml.slice(xml.indexOf('<m:oMath>'), xml.indexOf('</m:oMath>'));
  };

  // Without its marks, a change is the equation where it's accepted, or for a
  // deletion rejected
  test.each([
    ['an insertion', '$a{++ \\quad ++}b$'],
    ['a deletion', '$a{-- \\quad --}b$'],
    ['a thin space', '$a{++ \\, ++}b$'],
    ['a spacing command alone', '$1{++\\quad++}2$'],
  ])('the whitespace around a spacing command in a change is the source\'s, which Word drops: %s', async (_name, md) => {
    const docx = (await convertMdToDocx(md + '\n')).docx;
    const xml = await equationXml(docx);
    const unmarked = md.replace(/\{(\+\+|--)(.*?)\1\}/, (_change, _mark, content: string) => content);
    expect(xml.replace(/<\/?w:(?:ins|del)\b[^>]*>/g, '')).toBe(await equationXml((await convertMdToDocx(unmarked + '\n')).docx));
    expect(xml).not.toContain('xml:space');
    const markdown = (await convertDocx(docx)).markdown;
    const again = (await convertMdToDocx(markdown)).docx;
    expect(await equationXml(again)).toBe(xml);
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  // Word has no form for these, so the change is only its padding, which
  // Word drops, and comes back as none, as Word shows it
  test.each([
    ['a negative thin space', '$a{++ \\! ++}b$', '$ab$'],
    ['a command Word ignores', '$a{-- \\displaystyle --}b$', '$ab$'],
    ['the deletion of a substitution', '$a{~~ \\! ~>x~~}b$', '$a{++x++}b$'],
  ])('the whitespace around a command that gives nothing in a change is the source\'s, which Word drops: %s', async (_name, md, back) => {
    const docx = (await convertMdToDocx(md + '\n')).docx;
    const xml = await equationXml(docx);
    const unmarked = md.replace(/\{(\+\+|--)(.*?)\1\}/, (_change, _mark, content: string) => content);
    if (unmarked !== md) expect(xml.replace(/<\/?w:(?:ins|del)\b[^>]*>/g, '')).toBe(await equationXml((await convertMdToDocx(unmarked + '\n')).docx));
    expect(xml).not.toContain('xml:space');
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(back + '\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  const ins = (runs: string) => '<w:ins w:id="0" w:author="A" w:date="2026-01-01T00:00:00Z">' + runs + '</w:ins>';
  const del = (runs: string) => '<w:del w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">' + runs + '</w:del>';
  test.each([
    ['an insertion of a space', run('a') + ins(run(' ')) + run('b'), 'ab'],
    ['a deletion of spaces in runs of their own', run('a') + del(run(' ') + run('  ')) + run('b'), 'ab'],
    ['a styled space', run('a') + ins(styled(' ')) + run('b'), 'ab'],
    ['the deletion of a substitution', run('a') + del(run(' ')) + ins(run('x')) + run('b'), 'a{++x++}b'],
    ['the insertion of a substitution', run('a') + del(run('x')) + ins(run(' ')) + run('b'), 'a{--x--}b'],
  ])('a change in Word of only whitespace without xml:space="preserve", which Word drops, reads as none: %s', (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
  });

  test.each([
    ['a space Word keeps', run('a') + ins(kept(' ')) + run('b'), 'a{++ ++}b'],
    ['a space beside a character', run('a') + ins(run(' ') + run('x')) + run('b'), 'a{++ x++}b'],
    ['a space that isn\'t whitespace to Word, an em space', run('a') + ins(run('\u2003')) + run('b'), 'a{++\u2003++}b'],
  ])('a change in Word with more than whitespace it drops reads back: %s', (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
  });

  test('an equation replaced by only a space that Word keeps, such as an em space, goes without xml:space="preserve"', async () => {
    const xml = await equationXml((await convertMdToDocx('${~~\\left(~>\u2003~~}$\n')).docx);
    expect(xml).toContain('<w:ins w:id="1" w:author="Unknown"><m:r><m:t>\u2003</m:t></m:r></w:ins>');
  });

  const styledSpace = (rPr: string) => '<m:r><m:rPr>' + rPr + '</m:rPr><m:t xml:space="preserve"> </m:t></m:r>';
  test.each([
    ['\\mathbf{}', '$\\mathbf{a{++ ++}b}$', '<w:ins w:id="0" w:author="Unknown">' + styledSpace('<m:sty m:val="b"/>') + '</w:ins>'],
    ['\\mathcal{}', '$\\mathcal{A{-- --}B}$', '<w:del w:id="0" w:author="Unknown">' + styledSpace('<m:scr m:val="script"/><m:sty m:val="p"/>') + '</w:del>'],
    ['\\mathbb{}', '$\\mathbb{R{~~ ~>x~~}R}$', '<w:del w:id="0" w:author="Unknown">' + styledSpace('<m:scr m:val="double-struck"/><m:sty m:val="p"/>') + '</w:del>'],
    ['a \\mathbf{} of its own, as import writes the first', '$a{++\\mathbf{ }++}b$', '<w:ins w:id="0" w:author="Unknown">' + styledSpace('<m:sty m:val="b"/>') + '</w:ins>'],
    // \text{} preserves its spaces itself
    ['\\text{}', '$\\text{a{++ ++}b}$', '<m:t>a</m:t></m:r><w:ins w:id="0" w:author="Unknown">' + styledSpace('<m:sty m:val="p"/>') + '</w:ins><m:r>'],
    ['\\mathbf{}, of a control space', '$\\mathbf{a{++\\ ++}b}$', '<w:ins w:id="0" w:author="Unknown">' + styledSpace('<m:sty m:val="b"/>') + '</w:ins>'],
    ['\\mathbf{}, of a \\text{ }', '$\\mathbf{a{++\\text{ }++}b}$', '<w:ins w:id="0" w:author="Unknown">' + styledSpace('<m:sty m:val="b"/>') + '</w:ins>'],
    ['\\text{}, a deletion', '$\\text{a{-- --}b}$', '<m:t>a</m:t></m:r><w:del w:id="0" w:author="Unknown">' + styledSpace('<m:sty m:val="p"/>') + '</w:del><m:r>'],
    ['\\text{}, beside another change', '$\\text{a{++ ++}b} + c{++x++}$',
      '<w:ins w:id="0" w:author="Unknown">' + styledSpace('<m:sty m:val="p"/>') + '</w:ins>' + '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>b</m:t></m:r>' +
      '<m:r><m:t> </m:t></m:r><m:r><m:t>+</m:t></m:r><m:r><m:t> </m:t></m:r><m:r><m:t>c</m:t></m:r><w:ins w:id="1" w:author="Unknown"><m:r><m:t>x</m:t></m:r></w:ins>'],
  ])('a change of only whitespace keeps it in Word in %s', async (_name, md, expected) => {
    const docx = (await convertMdToDocx(md + '\n')).docx;
    const xml = await equationXml(docx);
    expect(xml).toContain(expected);
    expect(xml).not.toContain('mm:whitespace');
    const markdown = (await convertDocx(docx)).markdown;
    const again = (await convertMdToDocx(markdown)).docx;
    expect(await equationXml(again)).toBe(xml);
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  // A style around \text{} writes its text again, as one run, which keeps
  // the space \text{} keeps at an edge, and not the source's spaces
  test.each([
    ['\\mathbf{\\text{ }}', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t xml:space="preserve"> </m:t></m:r>'],
    ['\\mathrm{\\text{ x}}', '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve"> x</m:t></m:r>'],
    ['\\mathbf{ a }', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t> a </m:t></m:r>'],
    ['\\mathbf{a\\text{ }b}', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>a b</m:t></m:r>'],
    // The source's space at the other edge, which Word drops, goes
    ['\\mathbf{\\text{ x} }', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t xml:space="preserve"> x</m:t></m:r>'],
    ['\\mathbf{ \\text{x }}', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t xml:space="preserve">x </m:t></m:r>'],
    ['\\mathbf{\\text{ } }', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t xml:space="preserve"> </m:t></m:r>'],
    // and past a kept space, up to the text
    ['\\mathbf{\\text{ } x}', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t xml:space="preserve"> x</m:t></m:r>'],
    ['\\mathbf{x \\text{ }}', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t xml:space="preserve">x </m:t></m:r>'],
  ])('a style around \\text{} keeps the space at an edge that \\text{} keeps: %s', (latex, omml) => {
    expect(latexToOmml(latex)).toBe(omml);
  });

  // A space Word drops stays one it drops through a second trip
  test('a styled run with a tilde and a space Word drops keeps it dropped through Word', async () => {
    const docx = (await convertMdToDocx('$\\mathbf{ \\text{\\textasciitilde{}}}$\n')).docx;
    const markdown = (await convertDocx(docx)).markdown;
    expect(await equationXml((await convertMdToDocx(markdown)).docx)).not.toContain('xml:space');
  });

  // Import gives such a run's space in \text{}, which keeps it again
  // Only the space goes in \text{}, so the rest stays math in the style
  test.each([
    ['$\\mathbf{\\text{ x}}$', '$\\mathbf{\\text{ }x}$'],
    ['$\\mathbb{\\text{x }}$', '$\\mathbb{x\\text{ }}$'],
    ['$\\mathbb{R\\text{ }}$', '$\\mathbb{R\\text{ }}$'],
    ['$\\mathbf{\\text{ }\\alpha}$', '$\\mathbf{\\text{ }\\alpha}$'],
    ['$\\mathbf{\\text{ }}$', '$\\mathbf{\\text{ }}$'],
    ['$a{++\\mathbf{\\text{ x}}++}b$', '$a{++\\mathbf{\\text{ }x}++}b$'],
    ['$\\mathbf{a{++\\text{ x}++}b}$', '$\\mathbf{a}{++\\mathbf{\\text{ }x}++}\\mathbf{b}$'],
    // The source's spaces, which Word drops, come back as they went
    ['$\\mathbf{ x }$', '$\\mathbf{ x }$'],
  ])('a styled run with a space Word keeps at an edge reads back with it: %s', async (md, readBack) => {
    const docx = (await convertMdToDocx(md + '\n')).docx;
    const xml = await equationXml(docx);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(readBack + '\n');
    const again = (await convertMdToDocx(markdown)).docx;
    expect(await equationXml(again)).toBe(xml);
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  test.each([
    ['bold', '<m:sty m:val="b"/>', ' x', true, '\\mathbf{\\text{ }x}'],
    ['double-struck', '<m:scr m:val="double-struck"/><m:sty m:val="p"/>', 'R ', true, '\\mathbb{R\\text{ }}'],
    ['bold, beside a Greek letter', '<m:sty m:val="b"/>', ' \u03B1 ', true, '\\mathbf{\\text{ }\\alpha\\text{ }}'],
    ['bold, only a space', '<m:sty m:val="b"/>', ' ', true, '\\mathbf{\\text{ }}'],
    ['bold, with a tilde, which goes in \\text{} with the space', '<m:sty m:val="b"/>', ' ~', true, '\\mathbf{\\text{ \\textasciitilde{}}}'],
    // Word drops a space at an edge without xml:space="preserve"
    ['bold, with a tilde, without xml:space="preserve"', '<m:sty m:val="b"/>', ' ~', false, '\\mathbf{\\text{\\textasciitilde{}}}'],
    ['bold, without xml:space="preserve"', '<m:sty m:val="b"/>', ' x', false, '\\mathbf{ x}'],
    ['bold, a space inside', '<m:sty m:val="b"/>', 'x y', true, '\\mathbf{x y}'],
  ])('a run in a style with a space Word keeps at an edge reads as \\text{} in it: %s', (_name, rPr, text, kept, latex) => {
    expect(importOmml('<m:r><m:rPr>' + rPr + '</m:rPr><m:t' + (kept ? ' xml:space="preserve"' : '') + '>' + text + '</m:t></m:r>')).toBe(latex);
  });
});
