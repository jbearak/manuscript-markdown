// src/latex-omml-fidelity.test.ts — Word fidelity of function scripts, symbols,
// math alphabets, unknown-command warnings, normal-text runs, n-ary bodies,
// function arguments, script braces, and primes, in both conversion
// directions.

import { describe, test, expect } from 'bun:test';
import * as fc from 'fast-check';
import { xmlParser } from './xml-parser';
import JSZip from 'jszip';
import { latexToOmml, trackedLatexToOmml, CRITIC_INSERTION_COMMAND, CRITIC_DELETION_COMMAND } from './latex-to-omml';
import { ommlToLatex, unicodeToLatex } from './omml';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { parserOptions, roundTrip } from './test-omml-helpers';
import { fastestRun } from './test-timing';

const run = (t: string) => '<m:r><m:t>' + t + '</m:t></m:r>';
const styled = (t: string) => '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>' + t + '</m:t></m:r>';
const func = (fName: string, arg: string) => '<m:func><m:fName>' + fName + '</m:fName><m:e>' + arg + '</m:e></m:func>';

/** Translate Word-authored OMML (the children of an m:oMath) to LaTeX. */
function importOmml(omml: string): string {
  const parsed = xmlParser(parserOptions).parse('<m:oMath>' + omml + '</m:oMath>');
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

// Word's Normal Text, a run with m:nor, is text, as one with m:sty p is.
// Import read it as math, so its words came back as variables
describe('Word\'s Normal Text on import', () => {
  const normal = (t: string, rPr = '<m:nor/>') => '<m:r><m:rPr>' + rPr + '</m:rPr><m:t xml:space="preserve">' + t + '</m:t></m:r>';

  test.each([
    ['with spaces at its edges', run('x') + normal(' for all ') + run('y'), 'x\\text{ for all }y'],
    ['with a symbol', normal('a × b'), '\\text{a }\\mathrm{\\times}\\text{ b}'],
    ['of one word', run('x') + normal('if') + run('y'), 'x\\mathrm{if}y'],
    ['with a %', normal('50% of x'), '\\text{50\\% of x}'],
    ['that\'s on', run('x') + normal(' if ', '<m:nor m:val="1"/>') + run('y'), 'x\\text{ if }y'],
  ])('is text, as m:sty p\'s is, %s', (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
    expect(importOmml(omml.replace(/<m:nor[^>]*>/, '<m:sty m:val="p"/>'))).toBe(latex);
    expectStableExport(latex);
  });

  test.each([
    ['that\'s off', run('x') + normal('ab', '<m:nor m:val="0"/>') + run('y'), 'xaby'],
    ['in bold', run('x') + normal(' for all ', '<m:nor/><m:sty m:val="b"/>') + run('y'), 'x\\mathbf{\\text{ }for all\\text{ }}y'],
    ['in bold italic', run('x') + normal(' for all ', '<m:nor/><m:sty m:val="bi"/>') + run('y'), 'x\\boldsymbol{\\text{ }for all\\text{ }}y'],
    ['without it, upright', run('x') + normal(' for all ', '<m:sty m:val="p"/>') + run('y'), 'x\\text{ for all }y'],
  ])('a run %s is as before', (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
  });

  /** A document from Word of `md`, with its one equation's runs `omml` */
  async function wordDocx(md: string, omml: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md + '\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** Each run of the equation in `docx`, as its text, after p: where
   *  upright, but for the whitespace export writes between math, which Word
   *  drops */
  async function mathRuns(docx: Uint8Array): Promise<string[]> {
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    return [...xml.matchAll(/<m:r>([\s\S]*?)<\/m:r>/g)].map(r =>
      (r[1].includes('<m:sty m:val="p"/>') ? 'p:' : '') + [...r[1].matchAll(/<m:t\b[^>]*>([^<]*)<\/m:t>/g)].map(t => t[1]).join(''))
      .filter(text => text.trim() !== '');
  }

  test.each([
    ['inline', 'A $x$ B.', run('x') + normal(' for all ') + run('y'), 'A $x\\text{ for all }y$ B.', ['x', 'p: for all ', 'y']],
    ['display', '$$\nx\n$$', run('f(x)=0') + normal(' otherwise'), '$$\nf(x)=0\\text{ otherwise}\n$$', ['f', '(', 'x', ')', '=', '0', 'p: otherwise']],
  ])('in %s math comes back as \\text{}, which Word gets as upright text', async (_name, md, omml, back, runs) => {
    const markdown = (await convertDocx(await wordDocx(md, omml))).markdown;
    expect(markdown).toBe(back + '\n');
    const exported = (await convertMdToDocx(markdown)).docx;
    expect(await mathRuns(exported)).toEqual(runs);
    expect((await convertDocx(exported)).markdown).toBe(markdown);
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

  // Export takes one piece and its scripts as the body, so more stays inside
  // only in braces
  test.each([
    ['two runs', run('a') + run('b'), '\\prod{ab}'],
    ['a run of two digits', run('12'), '\\prod{12}'],
    ['a run of two symbols', run('αβ'), '\\prod{\\alpha\\beta}'],
    ['a run with a prime', run('x′'), "\\prod{x'}"],
    ['a structure and a run', latexToOmml('x_i') + run('y'), '\\prod{x_iy}'],
    ['a run and a structure', run('d') + latexToOmml('x_i'), '\\prod{dx_i}'],
    ['a fraction and a run', latexToOmml('\\frac{a}{b}') + run('y'), '\\prod{\\frac{a}{b}y}'],
    ['a function and a run', latexToOmml('\\sin x') + run('y'), '\\prod{\\sin{x}y}'],
    ['bars', run('|') + run('x') + run('|'), '\\prod{|x|}'],
  ])('a body of more than one piece is braced: %s', (_name, body, latex) => {
    expect(importOmml(nary(body))).toBe(latex);
    const omml = latexToOmml(latex);
    expect(omml.startsWith('<m:nary>') && omml.endsWith('</m:e></m:nary>')).toBe(true);
  });

  test.each([
    'x_i', 'x_i^2', '{ab}^2', '\\frac{a}{b}', '\\sqrt[3]{x}', '\\sum_j y', '\\hat{x}', '\\sin x', '\\sin(x)',
    '\\operatorname{f}x', '\\lim_{x\\to0}x', '\\boxed{x}', '\\overline{x}', '\\underbrace{x}_{y}', '\\binom{a}{b}',
    '\\mathrm{ab}', '\\text{if}', '\\mathbf{x}', '\\underset{a}{b}', '(1-x)', '\\left\\langle{}x\\right\\rangle',
  ])('a body of %s alone or with more after it keeps all of it in Word', body => {
    expectStableExport('\\prod{' + body + '}');
    expectStableExport('\\prod{' + body + '+y}');
  });

  // Export would take the bracket and what follows the operator as its body
  test.each([
    ['(', ')', '\\prod{(}x)'],
    ['[', ']', '\\prod{[}x]'],
  ])('a body of only %s is braced', (open, close, latex) => {
    expect(importOmml(nary(run(open)) + run('x') + run(close))).toBe(latex);
    expect(latexToOmml(latex)).toEndWith(run(open) + '</m:e></m:nary>' + run('x') + run(close));
  });

  test('a body of one piece, or one bracket group, stays unbraced', () => {
    expect(importOmml(nary(run('(') + run('1') + run('-') + run('x') + run(')')))).toBe('\\prod(1-x)');
    expect(importOmml(nary(run('x')))).toBe('\\prod x');
    expect(importOmml(nary(run('α')))).toBe('\\prod\\alpha');
    expect(importOmml(nary(styled('ab')))).toBe('\\prod\\mathrm{ab}');
    expect(importOmml(nary(latexToOmml('x_i^2')))).toBe('\\prod x_i^2');
    expect(importOmml(nary(latexToOmml('\\frac{a}{b}')))).toBe('\\prod\\frac{a}{b}');
    expect(importOmml(nary(latexToOmml('\\sum_j a_{ij}')))).toBe('\\prod\\sum_ja_{ij}');
    expect(importOmml(latexToOmml('\\sum_i a'))).toBe('\\sum_ia');
    // A change of only a space, which Word shows as none, is no piece
    expect(importOmml(nary(run('x') + '<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">' + run(' ') + '</w:ins>'))).toBe('\\prod x');
  });

  // An n-ary operator takes a body, where a command such as \mathcal takes
  // an argument, so the base of a script keeps its braces, whose script
  // export would put on the body
  test.each([
    '{\\prod\\|}^2', '{\\prod{ab}}^2', '{\\prod{ab}}_i', '{\\prod{ab}}_i^2', '{\\prod{(1-x)y}}^2',
  ])('an n-ary base of a script comes back with its braces in %s', latex => {
    expect(roundTrip(latex)).toBe(latex);
    expectStableExport(latex);
  });

  // Each change was read again for each operator around it
  test('a chain of changes in n-ary bodies imports in time linear in its depth', () => {
    const chain = (depth: number) => {
      let omml = run('x');
      for (let k = 0; k < depth; k++) omml = nary('<w:ins w:id="' + k + '" w:author="A" w:date="2026-01-01T00:00:00Z">' + omml + '</w:ins>');
      return xmlParser(parserOptions).parse('<m:oMath>' + omml + '</m:oMath>')[0]['m:oMath'];
    };
    const time = (depth: number) => {
      const nodes = chain(depth);
      return fastestRun(() => {
        for (let k = 0; k < 20; k++) expect(ommlToLatex(nodes)).toStartWith('\\prod{++\\prod');
      });
    };
    time(3);
    expect(time(12) / time(3)).toBeLessThan(8);
  }, 60000);

  // Word's pieces, as export writes them, which a Word user may put side by
  // side in a body in any order
  const piece = fc.constantFrom(
    run('a'), run('12'), run('αβ'), run('x′'), run('+'), run('('), run(')'), run('|'), styled('ab'),
    latexToOmml('x_i'), latexToOmml('\\frac{a}{b}'), latexToOmml('\\sin x'), latexToOmml('\\sum_j y'), latexToOmml('\\hat{x}'),
  );
  // What Word shows of runs' text, which drops a run's whitespace without
  // xml:space="preserve", as export writes math's
  const text = (omml: string) => [...omml.matchAll(/<m:t( xml:space="preserve")?>([^<]*)<\/m:t>/g)]
    .map(match => match[1] ? match[2] : match[2].trim()).join('');

  test('a body of any pieces from Word stays all under the operator, and comes back the same', () => {
    fc.assert(fc.property(fc.array(piece, { minLength: 1, maxLength: 4 }), pieces => {
      const body = pieces.join('');
      const latex = importOmml(nary(body));
      const omml = latexToOmml(latex);
      expect(omml.startsWith('<m:nary>') && omml.endsWith('</m:e></m:nary>')).toBe(true);
      // Its limits are empty, so all its text is the body's
      expect(text(omml)).toBe(text(body));
      expect(importOmml(omml)).toBe(latex);
    }), { numRuns: 500 });
  });

  // A body of more than one piece came back without its braces, and the
  // next export put only its first piece under the operator
  test.each([
    ['$\\prod{ab}$', '$\\prod{ab}$'],
    ['$\\sum_i{x_iy_i}$', '$\\sum_i{x_iy_i}$'],
    ['$\\int_0^1{f(x)dx}$', '$\\int_0^1{f(x)dx}$'],
    ['$\\prod{12}$', '$\\prod{12}$'],
    // A tracked change is one piece where its content is
    ['$\\sum_i{a{++b++}}$', '$\\sum_i{a{++b++}}$'],
    ['$\\sum_i{{++ab++}}$', '$\\sum_i{{++ab++}}$'],
    ['$\\sum_i{{--ab--}}$', '$\\sum_i{{--ab--}}$'],
    // As on main
    ['$\\sum_i a$', '$\\sum_ia$'],
    ['$\\prod(1-x)$', '$\\prod(1-x)$'],
    ['$\\sum_i x_i y$', '$\\sum_ix_i y$'],
    ['$\\sum_i{++a++}$', '$\\sum_i{++a++}$'],
    ['$\\sum_i{++x_i++}$', '$\\sum_i{++x_i++}$'],
    ['$\\sum_i{++(1-x)++}$', '$\\sum_i{++(1-x)++}$'],
    ['$\\sum_i{--a--}$', '$\\sum_i{--a--}$'],
  ])('comes back from Word, and again, in %s', async (math, back) => {
    const throughWord = async (markdown: string) => (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    const markdown = await throughWord('A ' + math + ' B.\n');
    expect(markdown).toBe('A ' + back + ' B.\n');
    expect(await throughWord(markdown)).toBe(markdown);
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

describe('Word delimiters with separators', () => {
  /** A delimiter of `elements`, each in an m:e of its own, with `sep` between them, or Word's default | without it */
  const separated = (beg: string, end: string, sep: string | undefined, ...elements: string[]) =>
    '<m:d><m:dPr><m:begChr m:val="' + beg + '"/>' + (sep === undefined ? '' : '<m:sepChr m:val="' + sep + '"/>') + '<m:endChr m:val="' + end + '"/></m:dPr>'
    + elements.map(element => '<m:e>' + element + '</m:e>').join('') + '</m:d>';

  // Word's separator grows with the delimiter, as \middle does, which
  // showed as text in Word, and needs \left and \right, which parentheses
  // and brackets otherwise come back without
  test.each([
    ['\\left(a\\middle|b\\right)', separated('(', ')', '|', run('a'), run('b'))],
    ['\\left\\{x\\middle|x>0\\right\\}', separated('{', '}', '|', run('x'), run('x') + run('&gt;') + run('0'))],
    ['\\left\\langle{}a\\middle|b\\middle|c\\right\\rangle', separated('⟨', '⟩', '|', run('a'), run('b'), run('c'))],
    ['\\left(a\\middle\\|b\\right)', separated('(', ')', '‖', run('a'), run('b'))],
    ['\\left[a\\middle/b\\right]', separated('[', ']', '/', run('a'), run('b'))],
    ['\\left(a\\middle.b\\right)', separated('(', ')', '', run('a'), run('b'))],
    ['\\left(a\\middle\\langle{}b\\right)', separated('(', ')', '⟨', run('a'), run('b'))],
    ['\\left(a\\middle|b\\right.', separated('(', '', '|', run('a'), run('b'))],
    ['\\left(\\frac{a}{b}\\middle|c\\right)', separated('(', ')', '|', latexToOmml('\\frac{a}{b}'), run('c'))],
  ])('comes back as \\middle, and as the separator, in %s', (latex, omml) => {
    expect(importOmml(omml)).toBe(latex);
    expect(latexToOmml(latex)).toBe(omml);
  });

  test('of Word\'s default comes back as \\middle|', () => {
    expect(importOmml(separated('(', ')', undefined, run('a'), run('b')))).toBe('\\left(a\\middle|b\\right)');
  });

  // Which \middle can't take, as a comma, or U+2223, which LaTeX has as the
  // relation \mid, or a '.' typed as itself, since \middle. is none, or in
  // a bracket \left or \right can't take, or with neither bracket, where
  // \middle can't go, or with one part, comes back as before, between the parts
  test.each([
    [separated('(', ')', ',', run('a'), run('b')), '(a,b)'],
    [separated('(', ')', '∣', run('a'), run('b')), '(a∣b)'],
    [separated('(', ')', '.', run('a'), run('b')), '(a.b)'],
    [separated(',', ',', '|', run('a'), run('b')), ',a|b,'],
    [separated('(', ',', '|', run('a'), run('b')), '(a|b,'],
    [separated('.', ')', '|', run('a'), run('b')), '.a|b)'],
    [separated('⟨', '⟩', ',', run('a'), run('b')), '\\left\\langle{}a,b\\right\\rangle'],
    [separated('', '', '|', run('a'), run('b')), 'a|b'],
    [separated('(', ')', '|', run('a')), '(a)'],
  ])('that \\middle can\'t take comes back as before, in %s', (omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
  });

  test('of different characters exports as them in one part, as Word\'s delimiter has one separator', () => {
    expect(latexToOmml('\\left(a\\middle|b\\middle/c\\right)')).toBe(
      '<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e>' + run('a') + run('|') + run('b') + run('/') + run('c') + '</m:e></m:d>');
  });

  // As a \right without a \left, rather than as the text of a command
  test.each([
    ['a\\middle|b', run('a') + run('|') + run('b')],
    ['\\left(a\\middle|b', run('(') + run('a') + run('|') + run('b')],
  ])('without \\left and \\right around it exports as its character, in %s', (latex, omml) => {
    const unknown: string[] = [];
    expect(latexToOmml(latex, command => unknown.push(command))).toBe(omml);
    expect(unknown).toEqual([]);
  });

  // \left, \middle and \right read their delimiters one way: after any
  // spaces, which TeX skips after a command word, and as a character or a
  // command, opening or closing
  test.each([
    ['\\left(a\\middle |b\\right)', separated('(', ')', '|', run('a'), run('b'))],
    ['\\left(a\\middle\\vert{}b\\right)', separated('(', ')', '|', run('a'), run('b'))],
    ['\\left(a\\middle \\vert{}b\\right)', separated('(', ')', '|', run('a'), run('b'))],
    ['\\left (a\\middle|b\\right )', separated('(', ')', '|', run('a'), run('b'))],
    ['\\left(a\\middle\\{b\\right)', separated('(', ')', '{', run('a'), run('b'))],
    ['\\left(a\\middle\\lbrace{}b\\right)', separated('(', ')', '{', run('a'), run('b'))],
    ['\\left(a\\middle\\rbrace{}b\\right)', separated('(', ')', '}', run('a'), run('b'))],
    ['\\left(a\\middle\\langle{}b\\right)', separated('(', ')', '⟨', run('a'), run('b'))],
    ['\\left(a\\middle(b\\right)', separated('(', ')', '(', run('a'), run('b'))],
    ['\\left(a\\middle[b\\right)', separated('(', ')', '[', run('a'), run('b'))],
    ['\\left (a\\right )', separated('(', ')', undefined, run('a'))],
    ['\\left\\rbrace{}a\\right\\lbrace', separated('}', '{', undefined, run('a'))],
    ['\\left\\}a\\right\\{', separated('}', '{', undefined, run('a'))],
  ])('\\left, \\middle and \\right read a delimiter one way, in %s', (latex, omml) => {
    const unknown: string[] = [];
    expect(latexToOmml(latex, command => unknown.push(command))).toBe(omml);
    expect(unknown).toEqual([]);
  });

  // A function's argument or an n-ary body in brackets ends at the \middle
  // of the \left around it, as at its \right, so the \middle still splits
  // the delimiter, and the bracket comes back as text, as an argument whose
  // bracket closes after \right does. A | in the brackets stays a character.
  test.each([
    ['\\left(\\Pr(A\\middle|B)\\right)', separated('(', ')', '|', latexToOmml('\\Pr(A'), latexToOmml('B)')), '\\left(\\Pr{(}A\\middle|B)\\right)'],
    ['\\left(\\sum(a\\middle|b)\\right)', separated('(', ')', '|', latexToOmml('\\sum(a'), latexToOmml('b)')), '\\left(\\sum{(}a\\middle|b)\\right)'],
    ['\\left(\\sum_i a_i \\middle| b\\right)', separated('(', ')', '|', latexToOmml('\\sum_i a_i '), latexToOmml(' b')), '\\left(\\sum_ia_i\\middle|b\\right)'],
    ['\\left(\\Pr(A|B)\\middle|C\\right)', separated('(', ')', '|', latexToOmml('\\Pr(A|B)'), run('C')), '\\left(\\Pr(A|B)\\middle|C\\right)'],
  ])('splits a delimiter around a function or n-ary operator, in %s', (latex, omml, back) => {
    expect(latexToOmml(latex)).toBe(omml);
    expect(importOmml(omml)).toBe(back);
    expect(importOmml(latexToOmml(back))).toBe(back);
  });

  test('a \\right delimiter after spaces doesn\'t close the bracket around it', () => {
    expect(latexToOmml('\\sqrt[\\left[a\\right ]]{x}')).toBe(latexToOmml('\\sqrt[\\left[a\\right]]{x}'));
  });

  test.each([
    '$\\left\\{x\\middle|x>0\\right\\}$', '$\\left(a\\middle|b\\middle|c\\right)$', '$\\sin\\left(a\\middle|b\\right)x$',
    '$\\left(\\Pr{(}A\\middle|B)\\right)$',
    // A change in a part is tracked in place, as the separator is in neither
    '$\\left(a\\middle|{++b++}\\right)$', '${++\\left(a\\middle|b\\right)++}$',
  ])('goes through Word and back, in %s', async (math) => {
    const md = math + '\n';
    const docx = (await convertMdToDocx(md)).docx;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<m:sepChr m:val="|"/>');
    expect(xml).not.toContain('middle');
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  // Any separator \middle takes, with two or three parts, in any brackets
  const bracket = fc.constantFrom('(', ')', '[', ']', '|', '‖', '{', '}', '⟨', '⟩', '');
  const part = fc.constantFrom(run('x'), run('0') + run(',') + run('1'), latexToOmml('\\frac{a}{b}'), latexToOmml('x^2') + run('+') + run('y'));
  test('any separated delimiter from Word comes back as it was', () => {
    fc.assert(fc.property(bracket, bracket, fc.constantFrom('|', '‖', '/', '', '⟨', '↑', '{', '}', '(', ']'), fc.array(part, { minLength: 2, maxLength: 3 }), (beg, end, sep, parts) => {
      fc.pre(beg !== '' || end !== '');
      const omml = separated(beg, end, sep, ...parts);
      const latex = importOmml(omml);
      expect(latexToOmml(latex)).toBe(omml);
      expect(importOmml(latexToOmml(latex))).toBe(latex);
    }), { numRuns: 500 });
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

  // Without the change, the \text{} is an empty run, which Word shows as nothing
  test.each([
    ['a space', '$\\text{{++ ++}}$', '<w:ins w:id="0" w:author="Unknown">' + '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve"> </m:t></m:r>' + '</w:ins>', '${++\\text{ }++}$'],
    ['a space before more of the equation', '$\\text{{++ ++}} + 1$', '<w:ins w:id="0" w:author="Unknown">' + '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve"> </m:t></m:r>' + '</w:ins>', '${++\\text{ }++} + 1$'],
    ['a letter before more of the equation', '$\\text{{++x++}} + 1$', '<w:ins w:id="0" w:author="Unknown">' + '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>x</m:t></m:r>' + '</w:ins>', '${++\\mathrm{x}++} + 1$'],
  ])('a change that is all of a \\text{} is tracked in place: %s', async (_name, md, expected, readBack) => {
    const docx = (await convertMdToDocx(md + '\n')).docx;
    const xml = await equationXml(docx);
    expect(xml).toContain(expected);
    expect(xml).not.toContain('<w:del');
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(readBack + '\n');
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

describe('an empty script, base, or fraction part', () => {
  const throughWord = async (markdown: string) => (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
  const ctrlPr = '<m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr></m:ctrlPr>';

  // Which import took for a missing one, and wrote as unsupported, with the
  // rest of the equation as text. The other elements already read an empty
  // part as {}, or, for a hidden limit or degree, as none.
  test.each([
    ['$x^{}$', '$x^{}$'],
    ['$x_{}$', '$x_{}$'],
    ['${}^{14}C$', '${}^{14}C$'],
    ['${}_a^b X$', '${}_a^b X$'],
    ['${}_{}$', '${}_{}$'],
    ['${}^{}$', '${}^{}$'],
    ['$x_{}^{}$', '$x_{}^{}$'],
    ['$x^{}_{}$', '$x_{}^{}$'],
    ['${}^{14}_{6}C$', '${}_6^{14}C$'],
    ['$\\frac{}{}$', '$\\frac{}{}$'],
    // A script of a space, which Word drops
    ['$x^{ }$', '$x^{}$'],
    // As on main
    ['$\\frac{x}{}$', '$\\frac{x}{}$'],
    ['$\\frac{}{y}$', '$\\frac{}{y}$'],
    ['$\\sqrt{}$', '$\\sqrt{}$'],
    ['$\\sqrt[n]{}$', '$\\sqrt[n]{}$'],
    ['$\\sqrt[]{x}$', '$\\sqrt{x}$'],
    ['$\\sum_{}^{}x$', '$\\sum x$'],
    ['$\\sum_i^n{}$', '$\\sum_i^n$'],
    ['$\\underset{}{x}$', '$\\underset{}{x}$'],
    ['$\\underset{a}{}$', '$\\underset{a}{}$'],
    ['$\\overset{}{x}$', '$\\overset{}{x}$'],
    ['$\\overset{a}{}$', '$\\overset{a}{}$'],
    ['$\\hat{}$', '$\\hat{}$'],
    ['$\\overline{}$', '$\\overline{}$'],
    ['$\\underline{}$', '$\\underline{}$'],
  ])('comes back from Word, and again, in %s', async (math, back) => {
    const markdown = await throughWord('A ' + math + ' B.\n');
    expect(markdown).toBe('A ' + back + ' B.\n');
    expect(await throughWord(markdown)).toBe(markdown);
  });

  test.each([
    ['<m:sSup><m:e>' + run('x') + '</m:e><m:sup/></m:sSup>', 'x^{}'],
    ['<m:sSup><m:e>' + run('x') + '</m:e><m:sup>' + ctrlPr + '</m:sup></m:sSup>', 'x^{}'],
    ['<m:sSub><m:e/><m:sub>' + run('a') + '</m:sub></m:sSub>', '{}_a'],
    ['<m:sSubSup><m:e/><m:sub>' + run('a') + '</m:sub><m:sup/></m:sSubSup>', '{}_a^{}'],
    ['<m:f><m:num/><m:den/></m:f>', '\\frac{}{}'],
    // As on main
    ['<m:f><m:num>' + run('x') + '</m:num></m:f>', '\\frac{x}{}'],
    ['<m:f><m:den>' + run('y') + '</m:den></m:f>', '\\frac{}{y}'],
    ['<m:rad><m:deg/><m:e/></m:rad>', '\\sqrt{}'],
    ['<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub/><m:sup/><m:e/></m:nary>', '\\sum'],
    ['<m:limLow><m:e/><m:lim/></m:limLow>', '\\underset{}{}'],
    ['<m:limUpp><m:e/><m:lim/></m:limUpp>', '\\overset{}{}'],
    ['<m:acc><m:accPr><m:chr m:val="̂"/></m:accPr><m:e/></m:acc>', '\\hat{}'],
    ['<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e/></m:bar>', '\\overline{}'],
  ])('from Word is a group, in %s', (omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
  });

  test.each([
    ['<m:sSup><m:e>' + run('x') + '</m:e></m:sSup>', 'sSup'],
    ['<m:sSub><m:sub>' + run('a') + '</m:sub></m:sSub>', 'sSub'],
    ['<m:sSubSup><m:e>' + run('x') + '</m:e><m:sub>' + run('a') + '</m:sub></m:sSubSup>', 'sSubSup'],
    ['<m:f></m:f>', 'f'],
  ])('that\'s missing is still unsupported, in %s', (omml, element) => {
    expect(importOmml(omml)).toContain('[UNSUPPORTED: ' + element + ']');
  });
});

// Import wrote Word's pre-scripts, boxes and phantoms as [UNSUPPORTED: …]
// text, which Word then showed
describe('Word\'s pre-scripts, boxes and phantoms', () => {
  const sPre = (sub: string, sup: string, base: string) =>
    '<m:sPre><m:sPrePr>' + '</m:sPrePr><m:sub>' + sub + '</m:sub><m:sup>' + sup + '</m:sup><m:e>' + base + '</m:e></m:sPre>';
  const box = (boxPr: string, content: string) => '<m:box><m:boxPr>' + boxPr + '</m:boxPr><m:e>' + content + '</m:e></m:box>';
  const phant = (phantPr: string, content: string) => '<m:phant><m:phantPr>' + phantPr + '</m:phantPr><m:e>' + content + '</m:e></m:phant>';
  const hidden = '<m:show m:val="0"/>';
  const nary = (body: string) => '<m:nary><m:naryPr><m:chr m:val="∫"/><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr><m:sub/><m:sup/><m:e>' + body + '</m:e></m:nary>';

  test.each([
    ['pre-scripts', sPre(run('a'), run('b'), run('X')), '{}_a^bX'],
    ['pre-scripts of more than one character', sPre(run('6'), run('14'), run('C')), '{}_6^{14}C'],
    ['pre-scripts, a command before a letter', sPre(run('a'), run('α'), run('X')), '{}_a^\\alpha X'],
    ['an empty pre-script', sPre('', run('b'), run('X')), '{}_{}^bX'],
    ['an operator emulator\'s box', run('a') + box('<m:opEmu m:val="1"/>', run('≝')) + run('b'), 'a≝b'],
    ['a differential\'s box', run('f') + box('<m:diff m:val="1"/>', run('d') + run('x')), 'fdx'],
    ['a box after a command', run('α') + box('', run('x')), '\\alpha x'],
    ['a box as an n-ary body', nary(box('<m:diff m:val="1"/>', run('d') + run('x'))), '\\int{dx}'],
    ['a phantom', run('a') + phant(hidden, run('x')) + run('b'), 'a\\phantom{x}b'],
    ['a phantom of no height', phant(hidden + '<m:zeroAsc m:val="1"/><m:zeroDesc m:val="1"/>', run('x')), '\\hphantom{x}'],
    ['a phantom of no width', phant(hidden + '<m:zeroWid m:val="1"/>', run('x')), '\\vphantom{x}'],
    ['a phantom Word shows', run('a') + phant('', run('x')) + run('b'), 'axb'],
    ['a phantom Word shows, after a command', run('α') + phant('<m:show m:val="1"/>', run('x')), '\\alpha x'],
  ])('from Word, %s, is its LaTeX', (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
    expect(roundTrip(latex)).toBe(latex);
  });

  test.each([
    ['\\phantom{x}', ''],
    ['\\hphantom{x}', '<m:zeroAsc m:val="1"/><m:zeroDesc m:val="1"/>'],
    ['\\vphantom{x}', '<m:zeroWid m:val="1"/>'],
  ])('%s exports as a phantom Word hides', (latex, flags) => {
    const seen: string[] = [];
    expect(latexToOmml('a' + latex + 'b', cmd => seen.push(cmd))).toBe(run('a') + phant(hidden + flags, run('x')) + run('b'));
    expect(seen).toEqual([]);
  });

  /** A document from Word with an inline equation of `omml` */
  async function wordDocx(omml: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx('A $x$ B.\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  test.each([
    ['pre-scripts', sPre(run('a'), run('b'), run('X')), '{}_a^bX', '<m:sSubSup><m:e></m:e><m:sub>' + run('a') + '</m:sub><m:sup>' + run('b') + '</m:sup></m:sSubSup>' + run('X')],
    ['a box', box('<m:diff m:val="1"/>', run('d') + run('x')), 'dx', run('d') + run('x')],
    ['a phantom', run('a') + phant(hidden, run('x')) + run('b'), 'a\\phantom{x}b', run('a') + phant(hidden, run('x')) + run('b')],
  ])('%s from Word comes back, and again, with no label in Word', async (_name, omml, latex, exported) => {
    const markdown = (await convertDocx(await wordDocx(omml))).markdown;
    expect(markdown).toBe('A $' + latex + '$ B.\n');
    const docx = (await convertMdToDocx(markdown)).docx;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(/<m:oMath>([\s\S]*?)<\/m:oMath>/.exec(xml)![1]).toBe(exported);
    expect((await convertDocx(docx)).markdown).toBe(markdown);
  });

  // The line end of a comment at the end of a phantom's content, which
  // the brace after it, and what follows, went into
  test('a phantom whose content ends in a comment comes back, and again', async () => {
    const latex = '\\phantom{x% note\n}y';
    expect(roundTrip(latex)).toBe(latex);
    const markdown = '$$\n' + latex + '\n$$\n';
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe(markdown);
    expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
  });

  test('a pre-script that ends in a comment keeps the base out of it', () => {
    expect(importOmml(sPre(latexToOmml('a% c\n'), run('b'), run('X')) + run('y'))).toBe('{}_{a% c\n}^bXy');
  });

  // Word keeps the spaces at the edges of a box's content, beside what
  // follows it, and import trimmed them
  const preserved = (t: string) => '<m:r><m:t xml:space="preserve">' + t + '</m:t></m:r>';
  test.each([
    ['a box', box('<m:diff m:val="1"/>', preserved('dx ')) + run('g'), 'dx g'],
    ['a phantom Word shows', run('a') + phant('', preserved(' x ')) + run('g'), 'a x g'],
    ['pre-scripts\' base', sPre(run('a'), run('b'), preserved('X ')) + run('g'), '{}_a^bX g'],
  ])('%s keeps the spaces at its content\'s edges, and again', async (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
    expect(roundTrip(latex)).toBe(latex);
    const markdown = (await convertDocx(await wordDocx(omml))).markdown;
    expect(markdown).toBe('A $' + latex + '$ B.\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  // Word shows nothing a phantom it hides holds, so a row whose other text
  // is all inserted is a row Word inserts, which rejecting removes
  test('a hidden phantom outside a row\'s insertion leaves it a row Word inserts, and again', async () => {
    const rowChanges = async (docx: Uint8Array) => [...(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string'))
      .matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)].map(([, tr]) => /^<w:trPr>(?:(?!<\/w:trPr>)[\s\S])*?<w:(ins|del) /.exec(tr)?.[1] ?? '');
    const docx = (await convertMdToDocx('| a | b |\n|---|---|\n| {++c++} $\\phantom{x}$ | {++d++} |\n')).docx;
    expect(await rowChanges(docx)).toEqual(['', 'ins']);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe('| a | b |\n| --- | --- |\n| {++c $\\phantom{x}$++} | {++d++} |\n');
    const again = (await convertMdToDocx(markdown)).docx;
    expect(await rowChanges(again)).toEqual(['', 'ins']);
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  // A space after a number that starts an inline equation, in a box, made
  // $2 dx$, which the next export read as currency
  test.each([
    ['in a box after it', run('2') + box('<m:diff m:val="1"/>', preserved(' dx'))],
    ['in a box with it', box('', preserved('2 ')) + run('x')],
    ['in a phantom Word shows', run('2') + phant('', preserved(' x'))],
  ])('a space after a number that starts an equation, %s, keeps it an equation, and again', async (_name, omml) => {
    const markdown = (await convertDocx(await wordDocx(omml))).markdown;
    expect(markdown).toMatch(/^A \$2\\ /);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  // Spacing a phantom holds alone was trimmed away
  test.each([
    ['\\hphantom{\\qquad}'],
    ['\\phantom{\\quad}'],
    ['\\vphantom{\\,}'],
  ])('a%s comes back as written, and again', async latex => {
    expect(roundTrip('a' + latex + 'b')).toBe('a' + latex + 'b');
    const markdown = 'A $a' + latex + 'b$ B.\n';
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe(markdown);
    expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
  });

  // A tracked change's command at the end of a box's content ended before a
  // letter after the box only in Word, so accepting it in Markdown gave \alphax
  test.each([
    ['an insertion', (omml: string) => '<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">' + omml + '</w:ins>', '{++\\alpha++}{}x'],
    ['a deletion', (omml: string) => '<w:del w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">' + omml + '</w:del>', '{--\\alpha--}{}x'],
  ])('%s of a command at the end of a box ends before a letter after it, and again', async (_name, change, latex) => {
    expect(importOmml(box('', change(run('α'))) + run('x'))).toBe(latex);
    const markdown = (await convertDocx(await wordDocx(box('', change(run('α'))) + run('x')))).markdown;
    expect(markdown).toBe('A $' + latex + '$ B.\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  test('an insertion of a command at the end of pre-scripts\' base ends before a letter after it, and again', async () => {
    const omml = sPre(run('a'), run('b'), '<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">' + run('α') + '</w:ins>') + run('x');
    expect(importOmml(omml)).toBe('{}_a^b{++\\alpha++}{}x');
    const markdown = (await convertDocx(await wordDocx(omml))).markdown;
    expect(markdown).toBe('A ${}_a^b{++\\alpha++}{}x$ B.\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  // No brace is beside a box's content, so it needs no break in ++
  test('a box in an insertion comes back as its content would, and again', async () => {
    const ins = (omml: string) => '<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">' + omml + '</w:ins>';
    const markdown = (await convertDocx(await wordDocx(ins(box('', run('a++'))) + run('y')))).markdown;
    expect(markdown).toBe((await convertDocx(await wordDocx(ins(run('a++')) + run('y')))).markdown);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  // As on main
  test.each([
    ['scripts on an empty base', '<m:sSubSup><m:e/><m:sub>' + run('a') + '</m:sub><m:sup>' + run('b') + '</m:sup></m:sSubSup>' + run('X'), '{}_a^bX'],
    ['a border box', '<m:borderBox><m:e>' + run('x') + '</m:e></m:borderBox>', '\\boxed{x}'],
    ['an element import doesn\'t know', '<m:foo><m:e>' + run('x') + '</m:e></m:foo>', '\\text{[UNSUPPORTED: foo] x}'],
  ])('%s is as before', (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
  });
});

describe('Word math text that reads as CriticMarkup beside braces', () => {
  const sSub = (base: string, sub: string) => '<m:sSub><m:e>' + base + '</m:e><m:sub>' + sub + '</m:sub></m:sSub>';
  const sSup = (base: string, sup: string) => '<m:sSup><m:e>' + base + '</m:e><m:sup>' + sup + '</m:sup></m:sSup>';
  const ins = (omml: string) => '<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">' + omml + '</w:ins>';
  const del = (omml: string) => '<w:del w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z">' + omml + '</w:del>';
  const plus = run('+') + run('+');

  /** A document from Word with an inline equation of each of `equations`,
   *  each in a paragraph of its own */
  async function wordDocx(...equations: string[]): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(equations.map(() => '$x$').join('\n\n') + '\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    let i = 0;
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g, () => '<m:oMath>' + equations[i++] + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  // \relax between the two characters keeps a group's braces from making
  // them CriticMarkup's {++ or ++}; LaTeX sets them the same, and export
  // writes the same runs
  test.each([
    ['a subscript\'s base of ++, twice', [sSub(plus, run('i')) + run('+') + sSub(plus, run('j'))], ['{+\\relax+}_i+{+\\relax+}_j']],
    ['a superscript of ++, twice', [sSup(styled('Ca'), plus) + run('+') + sSup(styled('Mg'), plus)], ['\\mathrm{Ca}^{+\\relax+}+\\mathrm{Mg}^{+\\relax+}']],
    ['a superscript of ++ in each of two paragraphs', [sSup(run('x'), plus), sSup(run('y'), plus)], ['x^{+\\relax+}', 'y^{+\\relax+}']],
    ['a fraction of -- over x--', ['<m:f><m:num>' + run('-') + run('-') + '</m:num><m:den>' + run('x') + run('-') + run('-') + '</m:den></m:f>' + run('+') + sSup(run('y'), run('--'))], ['\\frac{-\\relax-}{x-\\relax-}+y^{-\\relax-}']],
    ['a group ending in ++ in an insertion', [ins(sSup(run('x'), run('a++'))) + run('y')], ['{++x^{a+\\relax+}++}y']],
    ['upright text ending in ++ in an insertion', [ins(styled('C++')) + run('y')], ['{++\\mathrm{C+\\relax+}++}y']],
    ['a superscript of == and one of >>', [sSup(run('x'), run('==')) + run('+') + sSup(run('y'), run('>>')) + run('&lt;') + sSup(run('z'), run('&lt;&lt;'))], ['x^{=\\relax=}+y^{>\\relax>}<z^{<\\relax<}']],
    // Export ends a substitution's old text at its first ~>
    ['a substitution of a superscript of ~>', [run('x') + del(sSup(run('a'), run('~&gt;'))) + ins(run('c'))], ['x{~~a^{~\\relax>}~>c~~}']],
    ['a substitution of a~>b', [run('x') + del(run('a~&gt;b')) + ins(run('c'))], ['x{~~a~\\relax>b~>c~~}']],
  ])('%s comes back as it was', async (_name, equations, latex) => {
    const docx = await wordDocx(...equations);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(latex.map(equation => '$' + equation + '$').join('\n\n') + '\n');
    const exported = (await convertMdToDocx(markdown)).docx;
    expect((await convertDocx(exported)).markdown).toBe(markdown);
    // Word shows the same text, in the same changes
    const changes = async (file: Uint8Array) => [...(await (await JSZip.loadAsync(file)).file('word/document.xml')!.async('string'))
      .matchAll(/<m:oMath>[\s\S]*?<\/m:oMath>/g)].map(math => [...math[0].matchAll(/<w:(ins|del)\b[^>]*>|<\/w:(?:ins|del)>|<m:t( xml:space="preserve")?>([^<]*)<\/m:t>/g)]
      .map(t => t[1] ? '[' + t[1] + ' ' : t[0].startsWith('</w:') ? ']' : t[2] ? t[3] : t[3].trim()).join('')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    expect(await changes(exported)).toEqual(await changes(docx));
  });

  // {} is an ordinary atom, which at full size puts space beside a relation
  // or binary operator: \mathrm{>{}>} is wider than >>. \relax makes no atom,
  // so TeX sets the characters as without it, and export ignores it.
  const pairs = ['++', '--', '==', '>>', '<<', '~~'].map(pair => pair.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const unescape = (xml: string) => xml.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  test.each(pairs.flatMap(pair => [
    ['upright, as \\mathrm', run('a') + styled(pair) + run('b'), 'a\\mathrm{' + unescape(pair) + '}b'],
    ['in \\sqrt', '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>' + run(pair) + '</m:e></m:rad>', '\\sqrt{' + unescape(pair) + '}'],
    ['over b', '<m:f><m:num>' + run('a') + run(pair) + '</m:num><m:den>' + run('b') + '</m:den></m:f>', '\\frac{a' + unescape(pair) + '}{b}'],
    ['as a base', sSub(run(pair), run('i')), '{' + unescape(pair) + '}_i'],
    ['in a superscript', sSup(run('x'), run('a') + run(pair)), 'x^{a' + unescape(pair) + '}'],
  ].filter(([name]) => !(name.startsWith('upright') && pair === '~~')).map(([name, omml, bare]) => [unescape(pair) + ' ' + name, omml, bare])))(
    '%s is set and exported as the characters alone', (_name, omml, bare) => {
      const latex = importOmml(omml);
      expect(latex).not.toMatch(/\{(?:\+\+|--|~~|==|>>)|(?:\+\+|--|~~|==|<<)\}/);
      expect(latex).not.toContain('{}');
      expect(latex.replace(/\\relax/g, '')).toBe(bare);
      expect(latexToOmml(latex)).toBe(latexToOmml(bare));
    });

  // Word's structure of an equation: its parts and their text, in however
  // many runs, but for whitespace export writes between math, which Word drops
  const parts = (omml: string) => omml.replace(/<m:rPr>[\s\S]*?<\/m:rPr>/g, '')
    .match(/<\/?m:(?:f|num|den|nary|sub|sup|e|sSup|sSub|m|mr|d|eqArr|borderBox|func|fName)>|<m:t>[^<]*<\/m:t>/g)!
    .map(part => part.replace(/^<m:t>([^<]*)<\/m:t>$/, (_, text: string) => text.trim())).join('');
  const sum = (sub: string, sup: string, body: string) => '<m:nary><m:naryPr><m:chr m:val="∑"/>' +
    (sub ? '' : '<m:subHide m:val="1"/>') + (sup ? '' : '<m:supHide m:val="1"/>') +
    '</m:naryPr><m:sub>' + sub + '</m:sub><m:sup>' + sup + '</m:sup><m:e>' + run(body) + '</m:e></m:nary>';
  const overX = (num: string) => '<m:f><m:num>' + num + '</m:num><m:den>' + run('x') + '</m:den></m:f>';
  const cell = (omml: string) => '<m:m><m:mr><m:e>' + omml + '</m:e></m:mr></m:m>';
  const rows = (omml: string) => '<m:eqArr><m:e>' + omml + '</m:e><m:e>' + run('y') + '</m:e></m:eqArr>';

  // \relax is nothing where export reads an operand, as everywhere else: an
  // operator's body is the character after it, where {} would be an empty
  // body, even in a script. \boxed's content is at full size in a script
  // too, where {} would add space. A matrix's cells and cases' and gathered
  // rows are beside no brace, and need no break.
  test.each([
    ['a sum with an upper limit of + and a body of +, over x', overX(sum('', run('+'), '+')), '\\frac{\\sum^+\\relax+}{x}'],
    ['a sum with a lower limit of + and a body of +, over x', overX(sum(run('+'), '', '+')), '\\frac{\\sum_+\\relax+}{x}'],
    ['a sum with an upper limit of = and a body of =, in a superscript', sSup(run('x'), sum('', run('='), '=')), 'x^{\\sum^=\\relax=}'],
    ['a matrix of >> in a superscript', sSup(run('x'), cell(run('&gt;&gt;'))), 'x^{\\begin{matrix} >> \\end{matrix}}'],
    ['cases of ++ in a superscript', sSup(run('x'), '<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr><m:e>' + rows(run('++')) + '</m:e></m:d>'),
      'x^{\\begin{cases} ++ \\\\ y \\end{cases}}'],
    ['gathered rows of == in a superscript', sSup(run('x'), rows(run('=='))), 'x^{\\begin{gathered} == \\\\ y \\end{gathered}}'],
    ['a box of -- in a superscript', sSup(run('x'), '<m:borderBox><m:e>' + run('--') + '</m:e></m:borderBox>'), 'x^{\\boxed{-\\relax-}}'],
  ])('%s comes back with the same parts', (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
    expect(parts(latexToOmml(latex))).toBe(parts(omml));
  });

  // A part beside no brace, as a delimiter's content, a matrix's cell, a row,
  // a root's degree or an n-ary operator's body of one operand, needs no
  // break, and comes back as Word has it, as on main
  test.each([
    ['$\\left(a++\\right)$', '$(a++)$'],
    ['$\\left\\{--a\\right\\}$', '$\\left\\{--a\\right\\}$'],
    ['$\\left[==\\right]$', '$[==]$'],
    ['$\\begin{pmatrix} a++ \\\\ ==b \\end{pmatrix}$', '$\\begin{pmatrix} a++ \\\\ ==b \\end{pmatrix}$'],
    ['$\\begin{cases} ++ \\\\ y \\end{cases}$', '$\\begin{cases} ++ \\\\ y \\end{cases}$'],
    ['$\\begin{aligned} x &= 1 \\\\ ~~~ &= 2 \\end{aligned}$', '$\\begin{aligned} x &= 1 \\\\ ~~~ &= 2 \\end{aligned}$'],
    ['$\\sqrt[++]{x}$', '$\\sqrt[++]{x}$'],
    ['$\\sum\\sum^++$', '$\\sum\\sum^++$'],
    // Beside one
    ['$x^{\\sum\\sum^++}$', '$x^{\\sum\\sum^+\\relax+}$'],
  ])('%s comes back from Word as %s', async (markdown, back) => {
    expect((await convertDocx((await convertMdToDocx(markdown + '\n')).docx)).markdown).toBe(back + '\n');
  });

  // TeX reads a script past \relax, and an n-ary operator's or function's
  // operand is only the atom after it
  test.each([
    ['\\frac{\\sum^+\\relax+}{x}', '\\frac{\\sum^{+}{+}}{x}'],
    ['\\frac{\\sum_+\\relax+}{x}', '\\frac{\\sum_{+}{+}}{x}'],
    ['\\frac{\\sin^+\\relax+}{x}', '\\frac{\\sin^{+}{+}}{x}'],
    ['\\sin\\relax x', '\\sin x'],
    ['\\sum\\relax (a)', '\\sum (a)'],
    ['x^\\relax 2', 'x^2'],
    ['x\\relax^2', 'x^2'],
    ['a+\\relax+_i', 'a++_i'],
  ])('%s is exported as %s', (latex, bare) => {
    expect(latexToOmml(latex)).toBe(latexToOmml(bare));
  });

  // An element import doesn't read comes back as text, whose end is a group's
  test('an unsupported element ending in ++ in an insertion comes back as it was', async () => {
    const markdown = (await convertDocx(await wordDocx(ins('<m:sSup><m:e>' + run('a++') + '</m:e></m:sSup>') + run('y')))).markdown;
    expect(markdown).toBe('${++\\text{[UNSUPPORTED: sSup] a+{}+}++}y$\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  // Runs of CriticMarkup's characters, and a letter, in parts of structures
  // and between them, as a Word user may type them
  const marks = fc.array(fc.constantFrom('+', '-', '=', '~', '>', '<', 'a'), { minLength: 1, maxLength: 3 })
    .map(chars => run(chars.join('').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
  const runs = fc.array(marks, { minLength: 1, maxLength: 2 }).map(pieces => pieces.join(''));
  const piece = fc.oneof(runs, runs.map(sup => sSup(run('x'), sup)), fc.tuple(runs, runs).map(([base, sub]) => sSub(base, sub)),
    fc.tuple(runs, runs).map(([num, den]) => '<m:f><m:num>' + num + '</m:num><m:den>' + den + '</m:den></m:f>'));
  const equation = fc.array(piece, { minLength: 1, maxLength: 3 }).map(pieces => pieces.join(''));
  // What Word shows of an equation: its runs' text, but for whitespace
  // export writes between math, which Word drops
  const shown = (xml: string) => [...xml.matchAll(/<m:oMath>[\s\S]*?<\/m:oMath>/g)]
    .map(math => [...math[0].matchAll(/<m:t( xml:space="preserve")?>([^<]*)<\/m:t>/g)].map(t => t[1] ? t[2] : t[2].trim()).join(''));

  test('any of it in equations in paragraphs of their own comes back as it was, with no change in Word', async () => {
    await fc.assert(fc.asyncProperty(fc.array(equation, { minLength: 1, maxLength: 2 }), async equations => {
      const docx = await wordDocx(...equations);
      const markdown = (await convertDocx(docx)).markdown;
      const exported = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
      const xml = await exported.file('word/document.xml')!.async('string');
      expect(xml).not.toMatch(/<w:(?:ins|del)\b/);
      const original = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(shown(xml)).toEqual(shown(original));
      expect((await convertDocx(await exported.generateAsync({ type: 'uint8array' }))).markdown).toBe(markdown);
    }), { numRuns: 100 });
  });

  // The same runs nested in parts, as limits and bodies of n-ary operators,
  // cells of a matrix and boxes too, whose parts a break between two parts'
  // characters could move
  const nested: fc.Arbitrary<string> = fc.letrec<{ piece: string }>(tie => ({
    piece: fc.oneof({ depthSize: 'small', withCrossShrink: true }, runs,
      fc.tuple(runs, tie('piece')).map(([base, sup]) => sSup(base, sup)),
      fc.tuple(runs, tie('piece')).map(([base, sub]) => sSub(base, sub)),
      fc.tuple(tie('piece'), tie('piece')).map(([num, den]) => '<m:f><m:num>' + num + '</m:num><m:den>' + den + '</m:den></m:f>'),
      fc.tuple(fc.option(runs, { nil: '' }), fc.option(runs, { nil: '' }), runs).map(([sub, sup, body]) =>
        '<m:nary><m:naryPr><m:chr m:val="∑"/>' + (sub ? '' : '<m:subHide m:val="1"/>') + (sup ? '' : '<m:supHide m:val="1"/>') +
        '</m:naryPr><m:sub>' + sub + '</m:sub><m:sup>' + sup + '</m:sup><m:e>' + body + '</m:e></m:nary>'),
      tie('piece').map(content => cell(content)),
      tie('piece').map(content => '<m:borderBox><m:e>' + content + '</m:e></m:borderBox>')),
  })).piece;

  test('any of it nested in parts comes back with the same parts', () => {
    fc.assert(fc.property(fc.array(nested, { minLength: 1, maxLength: 3 }), pieces => {
      const omml = pieces.join('');
      const latex = importOmml(omml);
      expect(parts(latexToOmml(latex))).toBe(parts(omml));
      expect(importOmml(latexToOmml(latex))).toBe(latex);
    }), { numRuns: 2000 });
  });
});

// Word numbers an equation with a # at the end of a row of an equation array,
// then the number, which it builds up from (1) into a delimiter. Import wrote
// the # into the LaTeX, which doesn't parse, and export dropped a \tag
describe('equation numbers', () => {
  const fence = '$'.repeat(2);
  const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const trip = async (md: string) => strip((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  const equations = async (md: string) => {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    return xml.match(/<m:oMath>[\s\S]*?<\/m:oMath>/g) ?? [];
  };
  /** A document from Word with display math of `omml` alone */
  async function wordDisplay(omml: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(fence + '\nx\n' + fence + '\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }
  const array = (...rows: string[]) => '<m:eqArr><m:eqArrPr><m:ctrlPr/></m:eqArrPr>' + rows.map(row => '<m:e>' + row + '</m:e>').join('') + '</m:eqArr>';
  const parens = (omml: string) => '<m:d><m:dPr><m:ctrlPr/></m:dPr><m:e>' + omml + '</m:e></m:d>';
  const squared = '<m:sSup><m:e>' + run('c') + '</m:e><m:sup>' + run('2') + '</m:sup></m:sSup>';
  const number = (text: string) => '<m:r><m:t>#</m:t></m:r><m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e><m:r><m:t>' + text + '</m:t></m:r></m:e></m:d>';

  test.each([
    ['a row with #(1)', array(run('E=m') + squared + run('#') + parens(run('1'))), fence + '\nE=mc^2 \\tag{1}\n' + fence, ['1']],
    ['two rows, each with its own number', array(run('a&amp;=b#') + parens(run('1')), run('c&amp;=d#') + parens(run('2'))),
      fence + '\n\\begin{align*}\na&=b \\tag{1} \\\\\nc&=d \\tag{2}\n\\end{align*}\n' + fence, ['1', '2']],
    ['#(1) in the run of the equation', array(run('x=1#(1)')), fence + '\nx=1 \\tag{1}\n' + fence, ['1']],
    ['#(1) after x in its run', array(run('x#(1)')), fence + '\nx \\tag{1}\n' + fence, ['1']],
    // An escaped # is no other #, in its run or after a \ that ends the one before
    ['#(1) after an escaped #', array(run('a\\#b#') + parens(run('1'))), fence + '\na\\#b \\tag{1}\n' + fence, ['1']],
    ['#(1) after a # the run before escapes', array(run('a\\') + run('#b#(1)')), fence + '\na\\#b \\tag{1}\n' + fence, ['1']],
    ['a number without parentheses', array(run('x=1#A.1')), fence + '\nx=1 \\tag*{A.1}\n' + fence, []],
    // Apart from the tag's braces, as text is, so that they make no {++ or
    // ++}, which the next export read as an insertion
    ['a number of ++A++', array(run('x#') + parens(run('++A++'))), fence + '\nx \\tag{+{}+A+{}+}\n' + fence, ['++A++']],
    ['a number of --A--', array(run('x#') + parens(run('--A--'))), fence + '\nx \\tag{-{}-A-{}-}\n' + fence, ['--A--']],
    ['a number of ++A++ without parentheses', array(run('x#++A++')), fence + '\nx \\tag*{+{}+A+{}+}\n' + fence, []],
    // An on/off property that is off leaves a run of math
    ['a # and number with normal text off', array(run('x') + '<m:r><m:rPr><m:nor m:val="0"/></m:rPr><m:t>#</m:t></m:r>' + parens('<m:r><m:rPr><m:nor m:val="0"/></m:rPr><m:t>1</m:t></m:r>')), fence + '\nx \\tag{1}\n' + fence, ['1']],
    ['a # with literal off', array('<m:r><m:rPr><m:lit m:val="0"/></m:rPr><m:t>x#</m:t></m:r>' + parens(run('1'))), fence + '\nx \\tag{1}\n' + fence, ['1']],
    ['a # with hidden off', array('<m:r><w:rPr><w:vanish w:val="0"/></w:rPr><m:t>x#</m:t></m:r>' + parens(run('1'))), fence + '\nx \\tag{1}\n' + fence, ['1']],
    // A structure is something to number, though it has no text
    ['a sum alone', array('<m:nary><m:naryPr><m:chr m:val="∑"/><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr><m:sub/><m:sup/><m:e/></m:nary>' + run('#') + parens(run('1'))), fence + '\n\\sum \\tag{1}\n' + fence, ['1']],
    // TeX's special characters in Word's number, escaped as in \text{}
    ['a number with _', array(run('x#(a_b)')), fence + '\nx \\tag{a\\_b}\n' + fence, ['a_b']],
    ['a number with %', array(run('x#(50%)')), fence + '\nx \\tag{50\\%}\n' + fence, ['50%']],
    ['a number with &, which aligns nothing', array(run('x#(a&amp;b)')), fence + '\nx \\tag{a\\&b}\n' + fence, ['a&amp;b']],
    ['a number with & on one of two rows', array(run('a#(b&amp;c)'), run('d')), fence + '\n\\begin{gather*}\na \\tag{b\\&c} \\\\\nd\n\\end{gather*}\n' + fence, ['b&amp;c']],
    ['a number with braces', array(run('x#({1})')), fence + '\nx \\tag{\\{1\\}}\n' + fence, ['{1}']],
    ['a number with $', array(run('x#($1)')), fence + '\nx \\tag{\\$1}\n' + fence, ['$1']],
    ['a number with \\', array(run('x#(a\\b)')), fence + '\nx \\tag{a\\textbackslash{}b}\n' + fence, ['a\\b']],
    ['a number with ~', array(run('x#(a~b)')), fence + '\nx \\tag{a\\textasciitilde{}b}\n' + fence, ['a~b']],
    ['a number with ^ and no parentheses', array(run('x#x^2')), fence + '\nx \\tag*{x\\textasciicircum{}2}\n' + fence, []],
    // The # in a delimiter is no other #, so the row has one
    ['a number with # in its delimiter', array(run('x#') + parens(run('A#B'))), fence + '\nx \\tag{A\\#B}\n' + fence, ['A#B']],
  ])('reads %s from Word as \\tag', async (_name, omml, expected, numbers) => {
    const back = strip((await convertDocx(await wordDisplay(omml))).markdown);
    expect(back).toBe(expected);
    const [math] = await equations(back);
    expect(math).not.toMatch(/<w:(?:ins|del)\b/);
    for (const text of numbers) expect(math).toContain(number(text));
    expect(await trip(back)).toBe(back);
    expect(await equations(await trip(back))).toEqual(await equations(back));
  });

  // A # that isn't a row's number stays as before
  test.each([
    ['in a fraction in a row', array('<m:f><m:num>' + run('a#') + '</m:num><m:den>' + run('b') + '</m:den></m:f>'), fence + '\n\\begin{gathered}\n\\frac{a#}{b}\n\\end{gathered}\n' + fence],
    ['before a superscript', array(run('a#') + squared), fence + '\n\\begin{gathered}\na#c^2\n\\end{gathered}\n' + fence],
    ['outside an equation array', run('a#') + parens(run('1')), fence + '\na#(1)\n' + fence],
    ['with nothing before it to number', array(run('#') + parens(run('1'))), fence + '\n\\begin{gathered}\n#(1)\n\\end{gathered}\n' + fence],
    // Escaped by a \ that ends the run of math before it, as Word may split
    // x\#(1), which import joins as \#
    ['escaped by the run before', array(run('x\\') + run('#(1)')), fence + '\n\\begin{gathered}\nx\\#(1)\n\\end{gathered}\n' + fence],
    ['escaped by the run before, before (1)', array(run('x\\') + run('#') + parens(run('1'))), fence + '\n\\begin{gathered}\nx\\#(1)\n\\end{gathered}\n' + fence],
    ['escaped by the run before an empty one', array(run('x\\') + run('') + run('#(1)')), fence + '\n\\begin{gathered}\nx\\#(1)\n\\end{gathered}\n' + fence],
    // More than one # in a row's math leaves which starts the number
    // unclear, so none does
    ['with another # in its number', array(run('x#(A#B)')), fence + '\n\\begin{gathered}\nx#(A#B)\n\\end{gathered}\n' + fence],
    ['with another # in the next run', array(run('x#(A') + run('#B)')), fence + '\n\\begin{gathered}\nx#(A#B)\n\\end{gathered}\n' + fence],
    ['with another # in a number without parentheses', array(run('x#A#B')), fence + '\n\\begin{gathered}\nx#A#B\n\\end{gathered}\n' + fence],
    ['with another # before it', array(run('a#b#(1)')), fence + '\n\\begin{gathered}\na#b#(1)\n\\end{gathered}\n' + fence],
  ])('reads a # %s as before', async (_name, omml, expected) => {
    const back = strip((await convertDocx(await wordDisplay(omml))).markdown);
    expect(back).toBe(expected);
    expect(await trip(back)).toBe(back);
  });

  // In inline math, whose \tag export drops, Word's number stays as before
  test('reads a numbered row of an inline equation as before', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('A $x$ B.\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + array(run('x#') + parens(run('1'))) + '</m:oMath>'));
    const back = strip((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(back).toBe('A $\\begin{gathered} x#(1) \\end{gathered}$ B.');
    expect(await trip(back)).toBe(back);
  });

  // A # in a row that export writes as text, escaped or in a comment is no
  // number, as before
  test.each([
    ['in \\text{}', fence + '\n\\begin{gathered}\n\\text{item \\#3}\n\\end{gathered}\n' + fence, fence + '\n\\begin{gathered}\n\\text{item \\#3}\n\\end{gathered}\n' + fence],
    ['escaped before (1)', fence + '\n\\begin{gathered}\na \\#(1)\n\\end{gathered}\n' + fence, fence + '\n\\begin{gathered}\na \\#(1)\n\\end{gathered}\n' + fence],
    ['in a comment', fence + '\n\\begin{gathered}\na % see #3\n\\end{gathered}\n' + fence, fence + '\n\\begin{gathered}\na % see #3\n\\end{gathered}\n' + fence],
    ['in \\mathrm{} before (1)', fence + '\n\\begin{gathered}\n\\mathrm{a\\#}(1)\n\\end{gathered}\n' + fence, fence + '\n\\begin{gathered}\n\\text{a\\#}(1)\n\\end{gathered}\n' + fence],
  ])('keeps a # %s as before', async (_name, md, expected) => {
    const back = await trip(md);
    expect(back).toBe(expected);
    expect(await trip(back)).toBe(back);
  });

  test.each([
    ['\\tag{1}', fence + '\nE=mc^2 \\tag{1}\n' + fence, ['1']],
    ['a \\tag on each of two rows', fence + '\n\\begin{align*}\na &= b \\tag{1} \\\\\nc &= d \\tag{2}\n\\end{align*}\n' + fence, ['1', '2']],
    ['\\tag{A.1}', fence + '\nE \\tag{A.1}\n' + fence, ['A.1']],
    ['\\tag*{A}', fence + '\nE \\tag*{A}\n' + fence, []],
    ['a \\tag on one row of gather*', fence + '\n\\begin{gather*}\na \\tag{1} \\\\\nc\n\\end{gather*}\n' + fence, ['1']],
    ['a \\tag after a comment', fence + '\nE % note\n\\tag{1}\n' + fence, ['1']],
    ['a \\tag after a substitution', fence + '\n{~~E~>F~~} \\tag{1}\n' + fence, ['1']],
    ['a \\tag with a space', fence + '\nE \\tag{1 a}\n' + fence, ['1 a']],
    ['a \\tag on a sum alone', fence + '\n\\sum \\tag{1}\n' + fence, ['1']],
    // An & in text or escaped aligns nothing, so the rows stay gathered
    ['a \\tag on a row of gather* with an & in \\text{}', fence + '\n\\begin{gather*}\n\\text{A\\&B} \\tag{1} \\\\\nc\n\\end{gather*}\n' + fence, ['1']],
    ['a \\tag on a row of gather* with \\&', fence + '\n\\begin{gather*}\na \\& b \\tag{1} \\\\\nc\n\\end{gather*}\n' + fence, ['1']],
  ])('writes %s as Word\'s number, which comes back', async (_name, md, numbers) => {
    const [math] = await equations(md);
    expect(math).toContain('<m:eqArr>');
    for (const text of numbers) expect(math).toContain(number(text));
    if (md.includes('\\tag*')) expect(math).toContain('<m:r><m:t>#</m:t></m:r><m:r><m:t>A</m:t></m:r>');
    const back = await trip(md);
    expect(back).toBe(md);
    expect(await equations(back)).toEqual(await equations(md));
    expect(await trip(back)).toBe(back);
  });

  // A \tag in an environment that doesn't number its rows, or in none, is
  // the equation's, at its end
  test.each([
    ['in equation', fence + '\n\\begin{equation}\nE \\tag{2}\n\\end{equation}\n' + fence, fence + '\nE \\tag{2}\n' + fence],
    ['in aligned', fence + '\n\\begin{aligned}\na &= b \\tag{3} \\\\\nc &= d\n\\end{aligned}\n' + fence, fence + '\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned} \\tag{3}\n' + fence],
    ['in cases', fence + '\nx = \\begin{cases} a & b \\tag{1} \\end{cases}\n' + fence, fence + '\nx = \\begin{cases} a & b \\end{cases} \\tag{1}\n' + fence],
    // Word's delimiter comes back as characters, as on main
    ['on an empty delimiter', fence + '\n\\left(\\right) \\tag{1}\n' + fence, fence + '\n() \\tag{1}\n' + fence],
    // In an operand in brackets, as in a group; its brackets come back as
    // they do without one
    ['in a function\'s operand in parentheses', fence + '\n\\sin(x \\tag{1})\n' + fence, fence + '\n\\sin(x ) \\tag{1}\n' + fence],
    ['in a root\'s degree', fence + '\n\\sqrt[n \\tag{2}]{y}\n' + fence, fence + '\n\\sqrt[n]{y} \\tag{2}\n' + fence],
  ])('writes a \\tag %s as the equation\'s number', async (_name, md, expected) => {
    const back = await trip(md);
    expect(back).toBe(expected);
    expect(await trip(back)).toBe(back);
    expect(await equations(await trip(back))).toEqual(await equations(back));
  });

  // TeX's special characters in a \tag, which export writes in Word's
  // number as LaTeX shows them, come back escaped, as in \text{}
  test.each([
    ['\\_', fence + '\nx \\tag{a\\_b}\n' + fence, 'a_b'],
    ['\\%', fence + '\nx \\tag{50\\%}\n' + fence, '50%'],
    ['\\&', fence + '\nx \\tag{a\\&b}\n' + fence, 'a&amp;b'],
    ['\\& on a row of gather*', fence + '\n\\begin{gather*}\na \\tag{a\\&b} \\\\\nc\n\\end{gather*}\n' + fence, 'a&amp;b'],
    ['\\& on a row of align*', fence + '\n\\begin{align*}\na &= b \\tag{a\\&b} \\\\\nc &= d\n\\end{align*}\n' + fence, 'a&amp;b'],
    ['\\{ and \\}', fence + '\nx \\tag{\\{1\\}}\n' + fence, '{1}'],
    ['\\$', fence + '\nx \\tag{\\$1}\n' + fence, '$1'],
    ['\\#', fence + '\nx \\tag{A\\#B}\n' + fence, 'A#B'],
    ['\\textbackslash{}', fence + '\nx \\tag{a\\textbackslash{}b}\n' + fence, 'a\\b'],
    ['\\textasciitilde{}', fence + '\nx \\tag{a\\textasciitilde{}b}\n' + fence, 'a~b'],
    ['\\textasciicircum{}, starred', fence + '\nx \\tag*{x\\textasciicircum{}2}\n' + fence, 'x^2'],
    ['\\_, starred', fence + '\nx \\tag*{a\\_b}\n' + fence, 'a_b'],
  ])('writes a \\tag with %s as Word\'s number, which comes back', async (_name, md, shown) => {
    const [math] = await equations(md);
    expect(math).toContain('<m:r><m:t>#</m:t></m:r>');
    expect(math).toContain('<m:t>' + shown + '</m:t>');
    const back = await trip(md);
    expect(back).toBe(md);
    expect(await equations(back)).toEqual(await equations(md));
    expect(await trip(back)).toBe(back);
  });

  // A text accent or tie, which export writes as typed, comes back as the
  // characters Word shows, as \text{}'s does
  test.each([
    ['\\^', fence + '\nx \\tag*{x\\^2}\n' + fence, fence + '\nx \\tag*{x\\textbackslash{}\\textasciicircum{}2}\n' + fence],
    ['a tie', fence + '\nx \\tag{a~b}\n' + fence, fence + '\nx \\tag{a\\textasciitilde{}b}\n' + fence],
  ])('writes a \\tag with %s as Word shows it', async (_name, md, expected) => {
    const back = await trip(md);
    expect(back).toBe(expected);
    expect(await trip(back)).toBe(back);
  });

  // As before
  test.each([
    ['\\label and \\notag', fence + '\n\\begin{align}\na &= b \\label{x} \\\\\nc &= d \\notag\n\\end{align}\n' + fence, fence + '\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n' + fence],
    ['a \\label alone', fence + '\nE \\label{eq:1}\n' + fence, fence + '\nE\n' + fence],
    ['a \\tag in inline math', 'A $x \\tag{1}$ B.', 'A $x$ B.'],
    ['a \\tag in an insertion', fence + '\nE {++\\tag{1}++}\n' + fence, fence + '\nE\n' + fence],
    ['a \\tag on a row of its own', fence + '\n\\begin{align*}\na \\\\\n\\tag{2}\n\\end{align*}\n' + fence, fence + '\n\\begin{gathered}\na \\\\\n\\end{gathered}\n' + fence],
    ['an equation of a \\tag alone', fence + '\n\\tag{1}\n' + fence, ''],
    // Its number, a # and its text, would hold another #
    ['a \\tag* with a # in it', fence + '\nx \\tag*{A\\#B}\n' + fence, fence + '\nx\n' + fence],
    ['a \\tag with an insertion in it', fence + '\nx \\tag{++A++}\n' + fence, fence + '\n{~~x ~>x A~~}\n' + fence],
  ])('drops %s, as before', async (_name, md, expected) => {
    expect((await equations(md)).join('')).not.toContain('#');
    const back = await trip(md);
    expect(back).toBe(expected);
    expect(await trip(back)).toBe(back);
  });

  // A tracked change that was all of a row before its \tag left that row of
  // one view, accepted or rejected, showing nothing, so export recorded the
  // equation as replaced, with its number in the deleted one. Import wrote
  // the \tag in the deletion, as {--\alpha \tag{1.2}--}, and the next export
  // dropped it. Word now holds the number in the row, out of the change, as
  // for x {--E--} \tag{1}, and import writes it back after the change
  test.each([
    ['a deletion before a \\tag', fence + '\n{--\\alpha--} \\tag{1.2}\n' + fence, ['1.2']],
    ['an insertion before a \\tag', fence + '\n{++E++} \\tag{1}\n' + fence, ['1']],
    ['a deletion before a \\tag*', fence + '\n{--E--} \\tag*{A}\n' + fence, []],
    ['a deletion before a \\tag in a paragraph', 'A\n' + fence + '\n{--\\alpha--} \\tag{1.2}\n' + fence + '&#32;B.', ['1.2']],
    ['a deletion before a \\tag on a row of gather*', fence + '\n\\begin{gather*}\n{--a--} \\tag{1} \\\\\nc \\tag{2}\n\\end{gather*}\n' + fence, ['1', '2']],
    ['a deletion before a \\tag on a row of align*', fence + '\n\\begin{align*}\n{--a--} \\tag{1} \\\\\nc &= d \\tag{2}\n\\end{align*}\n' + fence, ['1', '2']],
    ['an insertion before a \\tag on a row of align*', fence + '\n\\begin{align*}\na &= b \\tag{1} \\\\\n{++c++} \\tag{2}\n\\end{align*}\n' + fence, ['1', '2']],
    // As before
    ['math and a deletion before a \\tag', fence + '\nx {--E--} \\tag{1}\n' + fence, ['1']],
    ['a deletion and math before a \\tag', fence + '\n{--E--} x \\tag{1}\n' + fence, ['1']],
    ['a substitution before a \\tag', fence + '\n{~~E~>F~~} \\tag{1}\n' + fence, ['1']],
  ])('keeps Word\'s number out of the change for %s', async (_name, md, numbers) => {
    const [math] = await equations(md);
    // The equation array is the equation's, not in a change
    expect(math).toMatch(/^<m:oMath><m:eqArr>/);
    expect(math).not.toMatch(/<w:(?:ins|del) [^>]*><m:eqArr>/);
    for (const text of numbers) expect(math).toContain(number(text));
    if (md.includes('\\tag*')) expect(math).toContain('<m:r><m:t>#</m:t></m:r><m:r><m:t>A</m:t></m:r>');
    const back = await trip(md);
    expect(back).toBe(md);
    expect(await equations(back)).toEqual(await equations(md));
    expect(await trip(back)).toBe(back);
  });

  test('keeps the number after an insertion right before its \\tag, which comes back with a space before it', async () => {
    // As E\tag{1} comes back as E \tag{1}
    const md = fence + '\n{++E++}\\tag{1}\n' + fence;
    const [math] = await equations(md);
    expect(math).toMatch(/^<m:oMath><m:eqArr><m:e><w:ins [^>]*><m:r><m:t>E<\/m:t><\/m:r><\/w:ins>/);
    expect(math).toContain(number('1'));
    const back = await trip(md);
    expect(back).toBe(fence + '\n{++E++} \\tag{1}\n' + fence);
    expect((await equations(back))[0]).toContain(number('1'));
    expect(await trip(back)).toBe(back);
  });
});

// Word's cancel, a border box with its sides hidden and a strike, came
// back as \boxed, and its linear and skewed fractions as \frac, which Word
// then showed as a box, where the term was struck, and stacked
describe('Word\'s cancel and linear fractions', () => {
  const hideAll = '<m:hideTop m:val="1"/><m:hideBot m:val="1"/><m:hideLeft m:val="1"/><m:hideRight m:val="1"/>';
  const borderBox = (pr: string, content = run('x')) => '<m:borderBox><m:borderBoxPr>' + pr + '</m:borderBoxPr><m:e>' + content + '</m:e></m:borderBox>';
  const fraction = (type: string, num = run('a'), den = run('b')) => '<m:f><m:fPr><m:type m:val="' + type + '"/></m:fPr><m:num>' + num + '</m:num><m:den>' + den + '</m:den></m:f>';
  const cancels: [string, string, string][] = [
    ['\\cancel', 'from bottom left to top right', '<m:strikeBLTR m:val="1"/>'],
    ['\\bcancel', 'from top left to bottom right', '<m:strikeTLBR m:val="1"/>'],
    ['\\xcancel', 'on both diagonals', '<m:strikeBLTR m:val="1"/><m:strikeTLBR m:val="1"/>'],
    ['\\sout', 'across', '<m:strikeH m:val="1"/>'],
  ];

  test.each(cancels)('%s is a border box with its sides hidden, struck %s, on import and export', (command, _how, strike) => {
    expect(importOmml(borderBox(hideAll + strike))).toBe(command + '{x}');
    expect(latexToOmml(command + '{x}')).toBe(borderBox(hideAll + strike));
    expect(importOmml(borderBox(hideAll.replace(/"1"/g, '"on"') + strike.replace(/"1"/g, '"on"'), run('a') + run('+') + run('b')))).toBe(command + '{a+b}');
  });

  test('a linear fraction is {a}/{b}, both ways', () => {
    expect(importOmml(fraction('lin'))).toBe('{a}/{b}');
    expect(importOmml(fraction('lin', run('a') + run('+') + run('1'), latexToOmml('x^2')))).toBe('{a+1}/{x^2}');
    expect(latexToOmml('{a}/{b}')).toBe(fraction('lin'));
    expect(latexToOmml('{a+1}/{x^2}')).toBe(fraction('lin', run('a') + run('+') + run('1'), latexToOmml('x^2')));
  });

  test('a skewed fraction is a linear one', () => {
    expect(importOmml(fraction('skw'))).toBe('{a}/{b}');
  });

  test.each([
    ['as a base', '<m:sSup><m:e>' + fraction('lin') + '</m:e><m:sup>' + run('2') + '</m:sup></m:sSup>', '{{a}/{b}}^2'],
    ['as an n-ary body', '<m:nary><m:naryPr><m:chr m:val="∑"/><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr><m:sub></m:sub><m:sup></m:sup><m:e>' + fraction('lin') + '</m:e></m:nary>', '\\sum{{a}/{b}}'],
  ])('a linear fraction %s keeps its parts', (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
    expect(latexToOmml(latex)).toBe(omml);
  });

  // A script after a group takes the group alone
  test.each([
    ['{a}/{b}^2', run('a') + run('/') + '<m:sSup><m:e>' + run('b') + '</m:e><m:sup>' + run('2') + '</m:sup></m:sSup>'],
    ['{a}/{b}_i', run('a') + run('/') + '<m:sSub><m:e>' + run('b') + '</m:e><m:sub>' + run('i') + '</m:sub></m:sSub>'],
    ['{a} / {b}', run('a') + run(' ') + run('/') + run(' ') + run('b')],
    ['a/b', run('a') + run('/') + run('b')],
  ])('%s exports as before', (latex, omml) => {
    expect(latexToOmml(latex)).toBe(omml);
  });

  // In text or a style's group, as for units, the / and both parts are text
  test.each([
    ['\\mathrm{{m}/{s}}', '\\mathrm{m/s}'],
    ['\\mathbf{{m}/{s}}', '\\mathbf{m/s}'],
    ['\\text{{m}/{s}}', '\\text{m/s}'],
  ])('%s exports as %s did, and again', async (latex, plain) => {
    expect(latexToOmml(latex)).toBe(latexToOmml(plain));
    const markdown = 'A $x' + latex + '$ B.\n';
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe((await convertDocx((await convertMdToDocx('A $x' + plain + '$ B.\n')).docx)).markdown);
    expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
  });

  // A script after a comment's line end takes the {b} alone too, with the
  // comment, which import writes in the script's base, before its line end
  test.each([
    ['{a}/{b}%\n^2', 'a/{b%\n}^2'],
    ['{a}/{b}% note\n^2', 'a/{b% note\n}^2'],
    ['{a}/{b} % note\n_i', 'a/{b % note\n}_i'],
  ])('%j exports with its script on the {b}, and comes back, and again', async (latex, back) => {
    const omml = latexToOmml(latex);
    expect(omml).not.toContain('<m:type m:val="lin"/>');
    expect(omml).toBe(latexToOmml(back));
    const markdown = (await convertDocx((await convertMdToDocx('$$\n' + latex + '\n$$\n')).docx)).markdown;
    expect(markdown).toBe('$$\n' + back + '\n$$\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  /** A document from Word with an inline equation of `omml` */
  async function wordDocx(omml: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx('A $x$ B.\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  test.each([
    ...cancels.map(([command, , strike]): [string, string, string, string] => [command, borderBox(hideAll + strike), command + '{x}', borderBox(hideAll + strike)]),
    ['a linear fraction', fraction('lin'), '{a}/{b}', fraction('lin')],
    ['a skewed fraction', fraction('skw'), '{a}/{b}', fraction('lin')],
    // As on main
    ['a border box with sides hidden and no strike', borderBox('<m:hideTop m:val="1"/><m:hideBot m:val="1"/>'), '\\boxed{x}', '<m:borderBox><m:e>' + run('x') + '</m:e></m:borderBox>'],
    ['a border box with a strike and its sides shown', borderBox('<m:strikeBLTR m:val="1"/>'), '\\boxed{x}', '<m:borderBox><m:e>' + run('x') + '</m:e></m:borderBox>'],
    ['a fraction', fraction('bar'), '\\frac{a}{b}', '<m:f><m:num>' + run('a') + '</m:num><m:den>' + run('b') + '</m:den></m:f>'],
  ])('%s from Word comes back, and again, and Word gets it as it was', async (_name, omml, latex, exported) => {
    const markdown = (await convertDocx(await wordDocx(omml))).markdown;
    expect(markdown).toBe('A $' + latex + '$ B.\n');
    const docx = (await convertMdToDocx(markdown)).docx;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(/<m:oMath>([\s\S]*?)<\/m:oMath>/.exec(xml)![1]).toBe(exported);
    expect((await convertDocx(docx)).markdown).toBe(markdown);
  });
});

// Word's group character, where it leaves out its character or position,
// is ECMA-376's U+23DF (⏟) at the bottom, which came back as \overbrace, and
// an arrow came back as a brace
describe('Word\'s group characters', () => {
  const groupChr = (pr: string) => '<m:groupChr>' + (pr ? '<m:groupChrPr>' + pr + '</m:groupChrPr>' : '') + '<m:e>' + run('x') + '</m:e></m:groupChr>';
  const chr = (c: string) => '<m:chr m:val="' + c + '"/>';
  const pos = (p: string) => '<m:pos m:val="' + p + '"/>';
  const limit = (kind: string, base: string) => '<m:' + kind + '><m:e>' + base + '</m:e><m:lim>' + run('n') + '</m:lim></m:' + kind + '>';

  /** A document from Word with an inline equation of `omml` */
  async function wordDocx(omml: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx('A $x$ B.\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  test.each([
    ['with no character or position', groupChr('<m:vertJc m:val="bot"/>'), '\\underbrace{x}'],
    ['with no properties', groupChr(''), '\\underbrace{x}'],
    ['with a position alone, at the top', groupChr(pos('top')), '\\underbrace{x}'],
    ['with a position alone, at the bottom', groupChr(pos('bot')), '\\underbrace{x}'],
    ['of ⏞ at the top', groupChr(chr('⏞') + pos('top')), '\\overbrace{x}'],
    ['of ⏟ at the bottom', groupChr(chr('⏟') + pos('bot')), '\\underbrace{x}'],
    ['of → at the top', groupChr(chr('→') + pos('top')), '\\overset{\\to}{x}'],
    ['of → at the bottom', groupChr(chr('→') + pos('bot')), '\\underset{\\to}{x}'],
    ['of ← at the top', groupChr(chr('←') + pos('top')), '\\overset{\\leftarrow}{x}'],
    ['of ← at the bottom', groupChr(chr('←') + pos('bot')), '\\underset{\\leftarrow}{x}'],
    ['of → with no position', groupChr(chr('→')), '\\underset{\\to}{x}'],
    ['with no character or position, in a lower limit\'s base', limit('limLow', groupChr('')), '\\underbrace{x}_{n}'],
    ['with no character or position, in an upper limit\'s base', limit('limUpp', groupChr('')), '\\overset{n}{\\underbrace{x}}'],
    ['of ⏞ at the top, in an upper limit\'s base', limit('limUpp', groupChr(chr('⏞') + pos('top'))), '\\overbrace{x}^{n}'],
    ['of → with no position, in a lower limit\'s base', limit('limLow', groupChr(chr('→'))), '\\underset{n}{\\underset{\\to}{x}}'],
  ])('from Word, one %s comes back as its LaTeX, and again', async (_name, omml, latex) => {
    expect(importOmml(omml)).toBe(latex);
    const markdown = (await convertDocx(await wordDocx(omml))).markdown;
    expect(markdown).toBe('A $' + latex + '$ B.\n');
    const again = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(again).toBe(markdown);
    expect((await convertDocx((await convertMdToDocx(again)).docx)).markdown).toBe(markdown);
  });

  // As before
  test('export writes each brace\'s character and position', () => {
    expect(latexToOmml('\\overbrace{x}')).toBe(groupChr(chr('⏞') + pos('top')));
    expect(latexToOmml('\\underbrace{x}')).toBe(groupChr(chr('⏟') + pos('bot')));
  });

  // A character LaTeX reserves went in with a backslash before it, or none,
  // so \ escaped the brace that closes it, which took the base into the
  // annotation, and & kept its backslash in Word. It goes as text, as an
  // upright run's does
  const reserved: [string, string][] = [
    ['\\', '\\textbackslash{}'], ['&', '\\&'], ['%', '\\%'], ['#', '\\#'], ['_', '\\_'],
    ['{', '\\{'], ['}', '\\}'], ['~', '\\textasciitilde{}'], ['^', '\\textasciicircum{}'], ['$', '\\$'],
  ];
  test.each(reserved.flatMap(([character, text]) => [
    [character, 'top', '\\overset', 'm:limUpp', text],
    [character, 'bot', '\\underset', 'm:limLow', text],
  ]))('from Word, one of %s at the %s comes back as %s of it as text, and again', async (character, position, command, limit, text) => {
    const omml = '<m:groupChr><m:groupChrPr>' + chr(character.replace(/&/g, '&amp;')) + pos(position) + '</m:groupChrPr><m:e>' + run('x') + '</m:e></m:groupChr>' + run('+y');
    const latex = command + '{\\text{' + text + '}}{x}+y';
    expect(importOmml(omml)).toBe(latex);
    const markdown = (await convertDocx(await wordDocx(omml))).markdown;
    expect(markdown).toBe('A $' + latex + '$ B.\n');
    // Word gets the character alone over or under the base, and +y after it
    const exported = async (md: string) => /<m:oMath>([\s\S]*?)<\/m:oMath>/.exec(await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string'))![1];
    const once = await exported(markdown);
    expect(once).toStartWith('<' + limit + '><m:e>' + run('x') + '</m:e><m:lim>');
    expect([...once.matchAll(/<m:t(?: [^>]*)?>([^<]*)<\/m:t>/g)].map(m => m[1].replace(/&amp;/g, '&')).join('')).toBe('x' + character + '+y');
    const again = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(again).toBe(markdown);
    expect(await exported(again)).toBe(once);
    expect((await convertDocx((await convertMdToDocx(again)).docx)).markdown).toBe(markdown);
  });

  // Any character Word's group character may be: each printable ASCII one,
  // each one import writes as a command (see unicodeToLatex), primes,
  // arrows, the braces, accents' characters and a private-use one. An
  // apostrophe went in as math, which export reads as a prime, and a prime
  // as ', which LaTeX raises as a superscript's
  const symbols = Array.from({ length: 0x20000 - 0xA0 }, (_, k) => String.fromCodePoint(0xA0 + k))
    .filter(character => !/^[\uD800-\uDFFF]$/.test(character) && unicodeToLatex(character) !== character);
  const characters = [...new Set([
    ...Array.from({ length: 0x7E - 0x20 }, (_, k) => String.fromCharCode(0x21 + k)),
    ...symbols, '′', '″', '‴', '⁗', '‵',
    '→', '←', '↔', '⇒', '⏞', '⏟', '¯', '˜', '^', '\uE000',
  ])];
  const xmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const plainText = (xml: string) => [...xml.matchAll(/<m:t(?: [^>]*)?>([^<]*)<\/m:t>/g)].map(m => m[1]).join('')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  test.each(characters.flatMap(character => [[character, 'top'], [character, 'bot']]))('from Word, one of %s at the %s keeps its character over its base', async (character, position) => {
    const omml = '<m:groupChr><m:groupChrPr>' + chr(xmlText(character)) + pos(position) + '</m:groupChrPr><m:e>' + run('x') + '</m:e></m:groupChr>' + run('+y');
    const markdown = (await convertDocx(await wordDocx(omml))).markdown;
    const xml = /<m:oMath>([\s\S]*?)<\/m:oMath>/.exec(await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string'))![1];
    // A group character of it, or a limit whose text is it, over or under x
    const group = /^<m:groupChr><m:groupChrPr><m:chr m:val="([^"]*)"\/>(?:<m:pos m:val="\w+"\/>)?<\/m:groupChrPr><m:e>(.*?)<\/m:e><\/m:groupChr>(.*)$/.exec(xml);
    const limit = /^<m:lim(?:Upp|Low)><m:e>(.*?)<\/m:e><m:lim>(.*?)<\/m:lim><\/m:lim(?:Upp|Low)>(.*)$/.exec(xml);
    const [shown, base, after] = group ? [plainText('<m:t>' + group[1] + '</m:t>'), group[2], group[3]] : limit ? [plainText(limit[2]), limit[1], limit[3]] : [];
    expect(shown).toBe(character);
    expect(base === undefined ? undefined : plainText(base)).toBe('x');
    expect(after === undefined ? undefined : plainText(after)).toBe('+y');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });
});

// A script on Word's brace, as a superscript on an overbrace, came back as
// \overbrace{y}^b, whose script LaTeX reads as a limit and export as the
// brace's label, so Word got it over the brace, not as a script. The brace
// goes in braces, as a script's base
describe('a script on Word\'s brace', () => {
  const brace = (character: string, position: string) => '<m:groupChr><m:groupChrPr><m:chr m:val="' + character + '"/><m:pos m:val="' + position + '"/></m:groupChrPr><m:e>' + run('y') + '</m:e></m:groupChr>';
  const over = brace('⏞', 'top');
  const under = brace('⏟', 'bot');
  const sup = (base: string) => '<m:sSup><m:e>' + base + '</m:e><m:sup>' + run('b') + '</m:sup></m:sSup>';
  const sub = (base: string) => '<m:sSub><m:e>' + base + '</m:e><m:sub>' + run('a') + '</m:sub></m:sSub>';
  const subSup = (base: string) => '<m:sSubSup><m:e>' + base + '</m:e><m:sub>' + run('a') + '</m:sub><m:sup>' + run('b') + '</m:sup></m:sSubSup>';
  const limit = (kind: string, base: string, label: string) => '<m:' + kind + '><m:e>' + base + '</m:e><m:lim>' + run(label) + '</m:lim></m:' + kind + '>';
  // An arrow over or under y, which comes back as \overset or \underset of
  // it, and which export writes as a limit
  const arrowOver = brace('→', 'top');
  const arrowUnder = brace('→', 'bot');
  const overLimit = limit('limUpp', run('y'), '→');
  const underLimit = limit('limLow', run('y'), '→');

  /** A document from Word with an inline equation of `omml` */
  async function wordDocx(omml: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx('A $x$ B.\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }
  /** The OMML of the equation export writes for `markdown` */
  const exported = async (markdown: string) =>
    /<m:oMath>([\s\S]*?)<\/m:oMath>/.exec(await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string'))![1];
  /** `omml` from Word comes back as `latex`, which export writes as `word`, over two trips */
  const comesBack = async (omml: string, latex: string, word: string) => {
    expect(importOmml(omml)).toBe(latex);
    const markdown = (await convertDocx(await wordDocx(omml))).markdown;
    expect(markdown).toBe('A $' + latex + '$ B.\n');
    expect(await exported(markdown)).toBe(word);
    const again = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(again).toBe(markdown);
    expect(await exported(again)).toBe(word);
    expect((await convertDocx((await convertMdToDocx(again)).docx)).markdown).toBe(markdown);
  };

  test.each([
    ['an overbrace with a superscript', sup(over), '{\\overbrace{y}}^b'],
    ['an overbrace with a subscript', sub(over), '{\\overbrace{y}}_a'],
    ['an overbrace with both scripts', subSup(over), '{\\overbrace{y}}_a^b'],
    ['an underbrace with a superscript', sup(under), '{\\underbrace{y}}^b'],
    ['an underbrace with a subscript', sub(under), '{\\underbrace{y}}_a'],
    ['an underbrace with both scripts', subSup(under), '{\\underbrace{y}}_a^b'],
  ])('from Word, %s comes back with the brace as the base of its scripts, and Word gets it as it was', async (_name, omml, latex) => {
    await comesBack(omml, latex, omml);
  });

  // As before: a brace's label, as Word writes one, and a script on an
  // arrow over or under its base, whose \overset or \underset a script's
  // base already braced
  test.each([
    ['an overbrace with a label', limit('limUpp', over, 'b'), '\\overbrace{y}^{b}', limit('limUpp', over, 'b')],
    ['an underbrace with a label', limit('limLow', under, 'a'), '\\underbrace{y}_{a}', limit('limLow', under, 'a')],
    ['an arrow over its base with a superscript', sup(arrowOver), '{\\overset{\\to}{y}}^b', sup(overLimit)],
    ['an arrow over its base with a subscript', sub(arrowOver), '{\\overset{\\to}{y}}_a', sub(overLimit)],
    ['an arrow over its base with both scripts', subSup(arrowOver), '{\\overset{\\to}{y}}_a^b', subSup(overLimit)],
    ['an arrow under its base with a superscript', sup(arrowUnder), '{\\underset{\\to}{y}}^b', sup(underLimit)],
    ['an arrow under its base with a subscript', sub(arrowUnder), '{\\underset{\\to}{y}}_a', sub(underLimit)],
    ['an arrow under its base with both scripts', subSup(arrowUnder), '{\\underset{\\to}{y}}_a^b', subSup(underLimit)],
  ])('from Word, %s comes back as before', async (_name, omml, latex, word) => {
    await comesBack(omml, latex, word);
  });
});

// A comment at the end of a braced part of an equation lost its line end on
// import, so the brace that closes the part, and what follows, went into the
// comment, which the next export hid
describe('a comment at the end of a braced part', () => {
  // Each with C where the comment goes, before its line end, and how
  // import writes it, where that differs
  const parts: [string, string, string?][] = [
    ['a superscript', 'x^{aC\n}y'],
    ['a subscript', 'x_{aC\n}y'],
    ['both scripts', 'x_{aC\n}^{bC\n}y'],
    ['a fraction', '\\frac{aC\n}{bC\n}y'],
    ['a linear fraction', '{aC\n}/{bC\n}y'],
    ['a binomial', '\\binom{aC\n}{bC\n}y'],
    ['a root', '\\sqrt{xC\n}y'],
    ['a root\'s degree', '\\sqrt[nC\n]{x}y'],
    ['an accent', '\\hat{xC\n}y'],
    ['an overline', '\\overline{xC\n}y'],
    ['an underline', '\\underline{xC\n}y'],
    ['a box', '\\boxed{xC\n}y'],
    ['a cancel', '\\cancel{xC\n}y'],
    ['an overbrace', '\\overbrace{xC\n}y'],
    ['an underbrace and its label', '\\underbrace{xC\n}_{aC\n}y'],
    ['\\overset', '\\overset{aC\n}{bC\n}y'],
    ['\\underset', '\\underset{aC\n}{bC\n}y'],
    ['a function\'s argument', '\\sin{xC\n}y'],
    ['an operator name\'s argument', '\\operatorname{f}{xC\n}y'],
    ['an n-ary operator\'s limits and body', '\\sum_{iC\n}^{nC\n}{a bC\n}y'],
    ['a delimiter', '\\left\\langle{}xC\n\\right\\rangle y'],
    ['parentheses', '\\left(xC\n\\right)y', '(xC\n)y'],
    ['a delimiter\'s parts', '\\left(xC\n\\middle|yC\n\\right)z'],
    ['a phantom', '\\phantom{xC\n}y'],
    ['scripts on an empty base', '{}_{aC\n}^{bC\n}Xy'],
  ];
  const inline = (latex: string) => 'A $' + latex + '$ B.\n';
  const display = (latex: string) => '$$\n' + latex + '\n$$\n';
  const rows = parts.flatMap(([name, latex, back = latex]) => [['%', ''], ['% note', ' note']].flatMap(([comment, label]) =>
    ([['inline', inline], ['in display math', display]] as const).map(([where, math]) =>
      [name + ', with %' + label + ', ' + where, math(latex.replace(/C/g, comment)), math(back.replace(/C/g, comment))])));
  test.each(rows)('in %s comes back, and again', async (_name, markdown, back) => {
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe(back);
    expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
  });
});

// A comment in \text{} was lost: export wrote the group's text as one run,
// without the comment's hidden run. It now splits the group around the
// comment, as a comment in \mathrm{}, \mathbf{} or another style's group does
describe('a comment in a text or styled group', () => {
  // Each with C where the comment goes, before its line end, and how import
  // writes it
  const groups: [string, string, string][] = [
    ['\\text{} mid-group', '\\text{a bC\nc d}y', '\\text{a b}C\n\\text{c d}y'],
    ['\\text{} at its end', '\\text{a bC\n}y', '\\text{a b}C\ny'],
    ['\\text{} of a word each side, which comes back as \\mathrm{}, as \\text{ab} does', '\\text{aC\nb}y', '\\mathrm{a}C\n\\mathrm{b}y'],
    ['\\mathrm{} mid-group', '\\mathrm{aC\nb}y', '\\mathrm{a}C\n\\mathrm{b}y'],
    ['\\mathrm{} at its end', '\\mathrm{abC\n}y', '\\mathrm{ab}C\ny'],
    ['\\mathbf{} mid-group', '\\mathbf{aC\nb}y', '\\mathbf{a}C\n\\mathbf{b}y'],
    ['\\mathbf{} at its end', '\\mathbf{abC\n}y', '\\mathbf{ab}C\ny'],
  ];
  const inline = (latex: string) => 'A $' + latex + '$ B.\n';
  const display = (latex: string) => '$$\n' + latex + '\n$$\n';
  const rows = groups.flatMap(([name, latex, back]) => [['%', ''], [' % note', ' note']].flatMap(([comment, label]) =>
    ([['inline', inline], ['in display math', display]] as const).map(([where, math]) =>
      [name + ', with %' + label + ', ' + where, math(latex.replace(/C/g, comment)), math(back.replace(/C/g, comment))])));
  test.each(rows)('in %s comes back, and again', async (_name, markdown, back) => {
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe(back);
    expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
  });

  test('Word gets \\text{}\'s comment as a hidden run between its text\'s runs', () => {
    expect(latexToOmml('\\text{a b % note\nc d}')).toBe(latexToOmml('\\text{a b}') + latexToOmml(' % note\n') + latexToOmml('\\text{c d}'));
    expect(latexToOmml('\\text{a b%\n}')).toBe(latexToOmml('\\text{a b}') + latexToOmml('%\n'));
  });

  // As on main
  test.each([
    ['\\text{}', '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t></m:t></m:r>'],
    ['\\text{ }', '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve"> </m:t></m:r>'],
    ['\\text{a b}', '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>a b</m:t></m:r>'],
  ])('%s exports as before', (latex, omml) => {
    expect(latexToOmml(latex)).toBe(omml);
  });
});

// Word writes a character from an old document's Symbol font as a w:sym in a
// math run, with the font's own code for it, and import read no text from
// it, which left an equation of that character alone empty, and dropped. A
// zero-width space in a math run, which import kept, export writes in a run
// of its own, or in a style's group drops, as text that starts with one marks
// a hidden comment; import then read that run as a comment and dropped it
describe('Word\'s symbol characters and zero-width spaces in an equation', () => {
  const sym = (char: string, font = 'Symbol', rPr = '') => '<m:r>' + rPr + '<w:rPr><w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '"/></w:rPr><w:sym w:font="' + font + '" w:char="' + char + '"/></m:r>';
  const hiddenRun = (text: string) => '<m:r><m:rPr><m:nor/></m:rPr><w:rPr><w:vanish/></w:rPr><m:t xml:space="preserve">\u200B' + text + '</m:t></m:r>';

  /** A document from Word with an equation of `omml`, inline or on its own line */
  async function wordDocx(omml: string, display: boolean): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(display ? '$$\nx\n$$\n' : 'A $x$ B.\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** `markdown` comes back as it is from Word, and again */
  async function expectStable(markdown: string): Promise<void> {
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe(markdown);
    expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(markdown);
  }

  test.each([
    ['a Greek letter, α', run('a') + sym('F061') + run('b'), false, 'a\\alpha b'],
    ['a Greek letter alone', sym('F061'), false, '\\alpha'],
    ['an operator, ×', run('a') + sym('F0B4') + run('b'), true, 'a\\times b'],
    ['a code without its F0', sym('70', 'symbol'), false, '\\pi'],
    ['an upright one', sym('F070', 'Symbol', '<m:rPr><m:sty m:val="p"/></m:rPr>'), false, '\\mathrm{\\pi}'],
    ['a code the Symbol font has no character for, as it is', run('a') + sym('F080') + run('b'), false, 'a\uF080b'],
    ['another font\'s, as it is', run('a') + sym('F04A', 'Wingdings') + run('b'), true, 'a\uF04Ab'],
    ['one with no code, which leaves the rest', run('a') + '<m:r><w:sym w:font="Symbol"/></m:r>' + run('b'), false, 'ab'],
    ['a zero-width space', run('a\u200Bb'), false, 'a\u200Bb'],
    ['a zero-width space first', run('\u200Ba'), false, '\u200Ba'],
    ['a zero-width space alone', run('\u200B'), false, '\u200B'],
    ['an upright zero-width space', styled('a\u200Bb'), true, '\\mathrm{a\u200Bb}'],
  ])('%s from Word comes back, and again', async (_name, omml, display, latex) => {
    const markdown = display ? '$$\n' + latex + '\n$$\n' : 'A $' + latex + '$ B.\n';
    expect((await convertDocx(await wordDocx(omml, display))).markdown).toBe(markdown);
    await expectStable(markdown);
  });

  // A character LaTeX reserves, as the Symbol font's % or _, is text, as one
  // typed in an upright run is, not a comment or a script, and Word gets it
  // as text it shows
  test.each([
    ['F025', 'Symbol', '\\text{\\%}', '%'],
    ['F05F', 'Symbol', '\\text{\\_}', '_'],
    ['F026', 'Symbol', '\\text{\\&}', '&amp;'],
    ['F023', 'Symbol', '\\text{\\#}', '#'],
    ['F07B', 'Symbol', '\\text{\\{}', '{'],
    ['F07D', 'Symbol', '\\text{\\}}', '}'],
    ['5C', 'Wingdings', '\\text{\\textbackslash{}}', '\\'],
  ].flatMap(([char, font, latex, shown]) => ['inline', 'in display math'].map(where => [char, font, where, latex, shown])))('%s of %s, %s, comes back as text, and again, and Word shows it', async (char, font, where, latex, shown) => {
    const display = where !== 'inline';
    const markdown = display ? '$$\na' + latex + 'b\n$$\n' : 'A $a' + latex + 'b$ B.\n';
    expect((await convertDocx(await wordDocx(run('a') + sym(char, font) + run('b'), display))).markdown).toBe(markdown);
    const docx = (await convertMdToDocx(markdown)).docx;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain(run('a') + styled(shown) + run('b'));
    expect(xml).not.toContain('\u200B');
    await expectStable(markdown);
  });

  test('a reserved character in a style\'s run, or among a run\'s text, is text, and a # or & is never an equation number or alignment', () => {
    expect(importOmml('<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>a</m:t><w:sym w:font="Symbol" w:char="F025"/></m:r>')).toBe('\\mathbf{a\\%}');
    expect(importOmml('<m:r><m:t>a</m:t><w:sym w:font="Symbol" w:char="F025"/><m:t>b</m:t></m:r>')).toBe('a\\text{\\%}b');
    expect(importOmml('<m:r><m:rPr><m:sty m:val="x"/><m:scr m:val="x"/></m:rPr><w:sym w:font="Symbol" w:char="F025"/></m:r>')).toBe('\\text{\\%}');
    expect(importOmml('<m:eqArr><m:e>' + run('a') + sym('F023') + run('(1)') + '</m:e></m:eqArr>')).toBe('\\begin{gathered} a\\text{\\#}(1) \\end{gathered}');
    expect(importOmml('<m:eqArr><m:e>' + run('a') + sym('F026') + run('b') + '</m:e><m:e>' + run('c') + '</m:e></m:eqArr>')).toBe('\\begin{gathered} a\\text{\\&}b \\\\ c \\end{gathered}');
  });

  // In a run with Word's equation number, a w:sym keeps its place among the
  // run's text, before the #, or in the number after it
  const alpha = '<w:sym w:font="Symbol" w:char="F061"/>';
  test.each([
    ['before the text', alpha + '<m:t>2+#(1)</m:t>', '\\alpha2+ \\tag{1}'],
    ['between the text', '<m:t>2</m:t>' + alpha + '<m:t>+x#(1)</m:t>', '2\\alpha+x \\tag{1}'],
    ['after the text, before the #', '<m:t>2+</m:t>' + alpha + '<m:t>#(1)</m:t>', '2+\\alpha \\tag{1}'],
    ['before text that shares its m:t with the #', '<m:t>2+</m:t>' + alpha + '<m:t>x#(1)</m:t>', '2+\\alpha x \\tag{1}'],
    ['alone before the #', alpha + '<m:t>#(1)</m:t>', '\\alpha \\tag{1}'],
    ['in the number', '<m:t>2+#(1</m:t>' + alpha + '<m:t>)</m:t>', '2+ \\tag{1α}'],
  ].flatMap(([name, children, latex]) => [
    [name, 'in a display equation', '<m:eqArr><m:e><m:r>' + children + '</m:r></m:e></m:eqArr>', '$$\n' + latex + '\n$$\n'],
    [name, 'in a row of two', '<m:eqArr><m:e><m:r>' + children + '</m:r></m:e><m:e>' + run('c') + '</m:e></m:eqArr>', '$$\n\\begin{gather*}\n' + latex + ' \\\\\nc\n\\end{gather*}\n$$\n'],
  ]))('a w:sym %s in a numbered run, %s, keeps its place, and again', async (_name, _where, omml, markdown) => {
    expect((await convertDocx(await wordDocx(omml, true))).markdown).toBe(markdown);
    await expectStable(markdown);
  });

  // A zero-width space before a \%, in one run in a style's group, is text
  test.each([
    'A $a\u200Bb$ B.\n',
    '$$\n\\text{a\u200Bb c} + \\mathbf{d\u200Be}\n$$\n',
    'A $\u200B\\%$ B.\n',
    'A $\\mathbf{\u200B\\%}$ B.\n',
    'A $\\text{\u200B\\% c}$ B.\n',
  ])('%j keeps its zero-width spaces, and again', expectStable);

  // Guards: the comments in an equation stay comments, hidden in Word
  test.each([
    '$$\na % note\nb\n$$\n',
    '$$\na%\nb\n$$\n',
    '$$\n\\mathrm{a} % note\n\\mathrm{b}\n$$\n',
    '$$\na\u200B % note\n\u200Bb\n$$\n',
  ])('the comment in %j stays one, and again', async markdown => {
    await expectStable(markdown);
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    expect(xml).toMatch(/<w:vanish\/><\/w:rPr><m:t xml:space="preserve">\u200B ?%/);
  });

  test('a hidden run is a comment, or nothing, as a shown Normal Text one with a % is, as older exports wrote it, and an upright one is text', () => {
    expect(importOmml(run('a') + hiddenRun(' % note\n') + run('b'))).toBe('a % note\nb');
    expect(importOmml(run('a') + '<m:r><m:rPr><m:nor/></m:rPr><m:t xml:space="preserve">\u200B % note\n</m:t></m:r>' + run('b'))).toBe('a % note\nb');
    expect(importOmml(run('a') + hiddenRun('hidden') + run('b'))).toBe('ab');
    expect(importOmml(run('a') + styled('\u200B%') + run('b'))).toBe('a\\text{\u200B\\%}b');
    expect(importOmml(run('a') + '<m:r><w:rPr><w:vanish w:val="1"/></w:rPr><m:t>\u200B</m:t></m:r>' + run('b'))).toBe('ab');
  });
});

// Two edges of Word's equation numbers. Text after the # and before Word's
// delimiter of the number, as x#a(1), was no number on import, and the next
// trip read all of it as one, \tag*{a(1)}, as Word shows it. And a run of
// math that ends in a lone \, which import keeps as it is, before a symbol
// that import writes as a command, as α, made \\, LaTeX's line break, as
// x\\alpha, which the next export wrote as \\ and letters
describe('equation number edges', () => {
  const fence = '$'.repeat(2);
  const parens = (omml: string) => '<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e>' + omml + '</m:e></m:d>';
  const array = (...rows: string[]) => '<m:eqArr>' + rows.map(row => '<m:e>' + row + '</m:e>').join('') + '</m:eqArr>';
  const display = (latex: string) => fence + '\n' + latex + '\n' + fence + '\n';

  /** A document from Word with display math of `omml` alone */
  async function wordDisplay(omml: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(display('x'))).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** `omml` from Word comes back as `markdown`, and the next two trips give it again */
  async function expectFromWord(omml: string, markdown: string): Promise<void> {
    const once = (await convertDocx(await wordDisplay(omml))).markdown;
    expect(once).toBe(markdown);
    const twice = (await convertDocx((await convertMdToDocx(once)).docx)).markdown;
    expect(twice).toBe(markdown);
    expect((await convertDocx((await convertMdToDocx(twice)).docx)).markdown).toBe(markdown);
  }

  // Word's number is all of the row after its #
  test.each([
    ['a letter, then the number\'s delimiter', run('x#a') + parens(run('1')), 'x \\tag*{a(1)}'],
    ['α, then the number\'s delimiter', run('x#α') + parens(run('1')), 'x \\tag*{α(1)}'],
    ['a letter in a run of its own, then the delimiter', run('x#') + run('a') + parens(run('1')), 'x \\tag*{a(1)}'],
    ['the delimiter, then a letter', run('x#') + parens(run('1')) + run('a'), 'x \\tag*{(1)a}'],
  ])('a number of %s comes back as \\tag*, and again', async (_name, row, latex) => {
    await expectFromWord(array(row), display(latex));
    await expectFromWord(array(row, run('c')), display('\\begin{gather*}\n' + latex + ' \\\\\nc\n\\end{gather*}'));
  });

  // As on main
  test.each([
    ['a number after α', array(run('2+α#(1)')), '2+\\alpha \\tag{1}'],
    ['a number in a delimiter', array(run('x#') + parens(run('1'))), 'x \\tag{1}'],
    ['a number without parentheses', array(run('x#a')), 'x \\tag*{a}'],
    ['a # a \\ escapes', array(run('x\\') + run('#(1)')), '\\begin{gathered}\nx\\#(1)\n\\end{gathered}'],
    // A \tag* with a # in it, which export would drop (see wordNumbersTag)
    ['a number of a letter, then a delimiter with a # in it', array(run('x#a') + parens(run('A#B'))), '\\begin{gathered}\nx#a(A#B)\n\\end{gathered}'],
    ['the same in the first of two rows', array(run('x#a') + parens(run('A#B')), run('c')), '\\begin{gathered}\nx#a(A#B) \\\\\nc\n\\end{gathered}'],
    ['a # in the number\'s run', array(run('x#a#b') + parens(run('1'))), '\\begin{gathered}\nx#a#b(1)\n\\end{gathered}'],
    ['a number of a delimiter with a # in it alone', array(run('x#') + parens(run('A#B'))), 'x \\tag{A\\#B}'],
  ])('%s comes back as before, and again', (_name, omml, latex) => expectFromWord(omml, display(latex)));
});

// A highlight inside an inline equation split it in three: export wrote the
// math before it, the highlight's and the math after it as equations of
// their own, so one inside a structure, as \frac{a}{{==b==}}, left the
// structure empty. Import read no highlight on part of an equation. Export
// now writes one equation, its highlighted part's runs highlighted, as Word
// does, and import writes them in {==...==}, as a change inside an equation.
// Display math is as on main
describe('a highlight inside an equation', () => {
  const marked = (t: string) => '<m:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><m:t>' + t + '</m:t></m:r>';
  const inline = (latex: string) => 'A $' + latex + '$ B.\n';
  const display = (latex: string) => '$$\n' + latex + '\n$$\n';

  /** The document Word gets for `markdown` */
  async function documentXml(markdown: string): Promise<string> {
    return (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
  }

  /** The equations Word gets for `markdown` */
  async function equations(markdown: string): Promise<string[]> {
    return [...(await documentXml(markdown)).matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].map(m => m[1]);
  }

  /** A document from Word with an equation of `omml`, inline or on its own line */
  async function wordDocx(omml: string, isDisplay: boolean): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(isDisplay ? '$$\nx\n$$\n' : 'A $x$ B.\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** `markdown` comes back as `back`, then as `again`, and again */
  async function expectTrips(markdown: string, back = markdown, again = back): Promise<void> {
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe(back);
    const twice = (await convertDocx((await convertMdToDocx(once)).docx)).markdown;
    expect(twice).toBe(again);
    if (again !== back) expect((await convertDocx((await convertMdToDocx(twice)).docx)).markdown).toBe(again);
  }

  // Each with how import writes it, inline and in display math. At an inline
  // equation's top level, import writes it in {==...==}. In a structure,
  // which the preview, splitting the equation at CriticMarkup, would render
  // in pieces that aren't equations, as \frac{a}{, and in display math,
  // which the preview leaves to VS Code's KaTeX, it reads none, as before
  const shapes: [string, string, string, string, string][] = [
    ['a run', 'a{==b==}c', run('a') + marked('b') + run('c'), 'a{==b==}c', 'abc'],
    ['runs', 'a{==b+c==}d', run('a') + marked('b') + marked('+') + marked('c') + run('d'), 'a{==b+c==}d', 'ab+cd'],
    ['a fraction', 'a{==\\frac{b}{c}==}d', run('a') + '<m:f><m:num>' + marked('b') + '</m:num><m:den>' + marked('c') + '</m:den></m:f>' + run('d'), 'a{==\\frac{b}{c}==}d', 'a\\frac{b}{c}d'],
    ['an operator', 'a{===b==}c', run('a') + marked('=') + marked('b') + run('c'), 'a{===b==}c', 'a=bc'],
    ['a fraction\'s denominator', '\\frac{a}{{==b==}}', '<m:f><m:num>' + run('a') + '</m:num><m:den>' + marked('b') + '</m:den></m:f>', '\\frac{a}{b}', '\\frac{a}{b}'],
    ['a superscript', 'x^{{==2==}}', '<m:sSup><m:e>' + run('x') + '</m:e><m:sup>' + marked('2') + '</m:sup></m:sSup>', 'x^2', 'x^2'],
  ];
  test.each(shapes.map(([name, latex, omml, back]) => [name, inline(latex), omml, inline(back)]))(
    'on %s, inline, is one equation with its runs highlighted, and comes back as import writes it, and again', async (_name, markdown, omml, back) => {
      expect(await equations(markdown)).toEqual([omml]);
      await expectTrips(markdown, back);
    });

  test('beside a change, inline, comes back, and again', async () => {
    const markdown = inline('a{==b==}{++c++}d');
    expect(await equations(markdown)).toHaveLength(1);
    await expectTrips(markdown);
  });

  // As on main: in display math, which import reads no highlight in, a
  // highlight is LaTeX, whose == Word shows
  test.each([
    ['a{==b==}c', 'a==b==c'],
    ['a{==b+c==}d', 'a==b+c==d'],
    ['a{==\\frac{b}{c}==}d', 'a==\\frac{b}{c}==d'],
    ['a{===b==}c', 'a===b==c'],
    ['\\frac{a}{{==b==}}', '\\frac{a}{=\\relax=b=\\relax=}'],
    ['x^{{==2==}}', 'x^{=\\relax=2=\\relax=}'],
    ['a{==b==}{++c++}d', 'a==b==++c++d'],
    ['{==abc==}', '==abc=='],
  ])('in display math, %s is LaTeX, as on main, and comes back, and again', async (latex, back) => {
    const omml = await equations(display(latex));
    expect(omml).toHaveLength(1);
    expect(omml[0]).not.toContain('w:highlight');
    expect(omml[0]).toContain('<m:t>=</m:t>');
    await expectTrips(display(latex), display(back));
  });

  test('in display math in a green highlight, is LaTeX, as on main, the equation green, and comes back, and again', async () => {
    const omml = await equations('==$$a{==b==}c$$=={green}\n');
    expect(omml).toEqual([['a', '=', '=', 'b', '=', '=', 'c'].map(t => marked(t).replace('yellow', 'green')).join('')]);
    await expectTrips('==$$a{==b==}c$$=={green}\n', display('a==b==c'));
  });

  test.each(shapes.flatMap(([name, , omml, back, displayBack]) => [[name, 'inline', omml, inline(back)], [name, 'in display math', omml, display(displayBack)]]))(
    'from Word, on %s, %s, comes back as import writes it, and again', async (_name, _where, omml, markdown) => {
      expect((await convertDocx(await wordDocx(omml, markdown.startsWith('$$')))).markdown).toBe(markdown);
      await expectTrips(markdown);
    });

  // In a highlight, which an equation with a highlight inside doesn't take,
  // it's split at its CriticMarkup, as on main, and each piece takes the
  // highlight around it. The pieces come back side by side, as $a$$b$,
  // which export reads as one equation, a$$b, as on main, whose dollar
  // signs come back as \$
  test.each([
    ['a green highlight', 'A ==$a{==b==}c$=={green} B.\n', ['a', 'b', 'c'].map(t => marked(t).replace('yellow', 'green')), 'A ==$a$$b$$c$=={green} B.\n', 'A ==$a\\$\\$b\\$\\$c$=={green} B.\n'],
    ['a highlight', 'A ==$a{==b==}c$== B.\n', ['a', 'b', 'c'].map(marked), 'A ==$a$$b$$c$== B.\n', 'A ==$a\\$\\$b\\$\\$c$== B.\n'],
    ['a highlight, beside an insertion', 'A ==$a{==b==}{++c++}d$== B.\n', [marked('a'), marked('b'), run('c'), marked('d')], 'A ==$a$$b$=={++$c$++}==$d$== B.\n', 'A ==$a\\$\\$b$=={++$c$++}==$d$== B.\n'],
  ])('in %s, is split at its CriticMarkup, as on main, and comes back, and again', async (_name, markdown, omml, back, again) => {
    expect(await equations(markdown)).toEqual(omml);
    await expectTrips(markdown, back, again);
  });

  // With a % comment in it, whose hidden run export doesn't highlight, so
  // import wouldn't read the highlight back, it's split at its CriticMarkup,
  // as on main; a comment outside it doesn't matter. Pieces side by side
  // come back as one equation, as above
  test.each([
    ['in a fraction', 'A $a{==\\frac{b % c\n}{c}==}d$ B.\n', 'A $a$$\\frac{b % c\n}{c}$$d$ B.\n', 'A $a\\$\\$\\frac{b % c\n}{c}\\$\\$d$ B.\n'],
    ['in a radical', 'A $a{==\\sqrt{b % c\n}==}d$ B.\n', 'A $a$$\\sqrt{b % c\n}$$d$ B.\n', 'A $a\\$\\$\\sqrt{b % c\n}\\$\\$d$ B.\n'],
    ['after a run', 'A $a{==b % c\n==}d$ B.\n', 'A $a$==$b % c$==$d$ B.\n', undefined],
  ])('with a comment in it, %s, is split at its CriticMarkup, as on main, and comes back, and again', async (_name, markdown, back, again) => {
    const omml = await equations(markdown);
    expect(omml).toHaveLength(3);
    expect([omml[0], omml[2]]).toEqual([run('a'), run('d')]);
    expect(omml[1]).toContain('<w:vanish/><w:highlight w:val="yellow"/>');
    await expectTrips(markdown, back, again);
  });

  test.each([
    ['before it', 'A $a % c\n{==b==}d$ B.\n'],
    ['after it', 'A $a{==b==}c % n\n$ B.\n', 'A $a{==b==}c % n$ B.\n'],
  ])('beside a comment %s, is one equation, and comes back, and again', async (_name, markdown, back = markdown) => {
    const omml = await equations(markdown);
    expect(omml).toHaveLength(1);
    expect(omml[0]).toContain(marked('b'));
    await expectTrips(markdown, back);
  });

  // In other formatting, its one equation takes what an equation did on
  // main: no bold, and all of a link or an insertion
  test.each([
    ['bold', 'A **$a{==b==}c$** B.\n', '<m:oMath>', 'A $a{==b==}c$ B.\n'],
    ['a link', 'A [$a{==b==}c$](u) B.\n', '"><m:oMath>', 'A [$a{==b==}c$](u) B.\n'],
    ['an insertion', 'A {++$a{==b==}c$++} B.\n', '"><m:oMath>', 'A {++$a{==b==}c$++} B.\n'],
  ])('in %s, is one equation with its runs highlighted, and comes back, and again', async (_name, markdown, before, back) => {
    const xml = await documentXml(markdown);
    expect([...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].map(m => m[1])).toEqual([run('a') + marked('b') + run('c')]);
    expect(xml).toContain(before + run('a') + marked('b') + run('c') + '</m:oMath>' + (before === '<m:oMath>' ? '' : '</w:'));
    await expectTrips(markdown, back);
  });

  // An equation array's rows can hold Word's numbers, which export doesn't
  // write for a highlight that holds them, so import reads none around one
  const array = (...rows: string[]) => '<m:eqArr>' + rows.map(row => '<m:e>' + row + '</m:e>').join('') + '</m:eqArr>';
  test.each([
    ['in display math, numbered, of one row', run('a+') + array(marked('x#(1)')), true, '$$\na+x \\tag{1}\n$$\n'],
    ['in display math, numbered, of two rows', run('a+') + array(marked('x#(1)'), marked('y#(2)')), true, '$$\na+\\begin{gather*} x \\tag{1} \\\\ y \\tag{2} \\end{gather*}\n$$\n'],
    ['inline', run('a+') + array(marked('x'), marked('y')), false, 'A $a+\\begin{gathered} x \\\\ y \\end{gathered}$ B.\n'],
    ['inline, after a highlighted run', run('a') + marked('b') + array(marked('x'), marked('y')), false, 'A $a{==b==}\\begin{gathered} x \\\\ y \\end{gathered}$ B.\n'],
  ])('from Word, on an equation array beside text, %s, comes back without the highlight around the array, and again', async (_name, omml, isDisplay, markdown) => {
    expect((await convertDocx(await wordDocx(omml, isDisplay))).markdown).toBe(markdown);
    await expectTrips(markdown);
  });

  // As on main: a highlight on the whole equation is around it, one in a
  // change or of another color isn't read
  test.each([
    ['on the whole inline equation', run('a').replace('<m:r>', '<m:r><w:rPr><w:highlight w:val="yellow"/></w:rPr>') + marked('b'), false, 'A ==$ab$== B.\n'],
    ['on the whole display equation', marked('a') + marked('b'), true, '{==$$\nab\n$$==}\n'],
    ['in an insertion', run('a') + '<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">' + marked('b') + '</w:ins>' + run('c'), false, 'A $a{++b++}c$ B.\n'],
    ['of another color', run('a') + marked('b').replace('yellow', 'red') + run('c'), false, 'A $abc$ B.\n'],
  ])('from Word, %s, comes back as before, and again', async (_name, omml, isDisplay, markdown) => {
    expect((await convertDocx(await wordDocx(omml, isDisplay))).markdown).toBe(markdown);
    await expectTrips(markdown);
  });

  // On all of an equation's content, it's on the equation, as Word holds one;
  // on syntax rather than math, the equation stays whole without it
  test.each([
    ['all of an inline equation\'s content', inline('{==abc==}'), 'A ==$abc$== B.\n'],
    ['a superscript\'s ^', inline('x{==^2==}'), inline('x^2')],
  ])('on %s comes back as Word holds it, and again', (_name, markdown, back) => expectTrips(markdown, back));

  test.each([
    'A ==$abc$== B.\n',
    'A $a{++b++}c$ B.\n',
    'A $a{--b--}c$ B.\n',
    'A $a{~~b~>d~~}c$ B.\n',
    '$$\na{++b++}c\n$$\n',
  ])('%j comes back as before, and again', markdown => expectTrips(markdown));
});

// Word's fraction without a bar (m:type noBar) came back as \frac, a bar
// and all, outside parentheses, where it's \binom. It's \genfrac{}{}{0pt}{}
// now, which KaTeX draws without a bar and export writes back as noBar
describe('a fraction without a bar', () => {
  const noBar = (num: string, den: string) => '<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>' + run(num) + '</m:num><m:den>' + run(den) + '</m:den></m:f>';
  const frac = (num: string, den: string) => '<m:f><m:num>' + run(num) + '</m:num><m:den>' + run(den) + '</m:den></m:f>';
  const parens = (omml: string) => '<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e>' + omml + '</m:e></m:d>';
  const display = (latex: string) => '$'.repeat(2) + '\n' + latex + '\n' + '$'.repeat(2) + '\n';
  const inline = (latex: string) => 'A $' + latex + '$ B.\n';
  const barless = '\\genfrac{}{}{0pt}{}{a}{b}';

  /** The document Word gets for `markdown` */
  async function documentXml(markdown: string): Promise<string> {
    return (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
  }

  /** A document from Word with an equation of `omml`, inline or on its own line */
  async function wordDocx(omml: string, isDisplay: boolean): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(isDisplay ? display('x') : inline('x'))).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** `markdown` comes back as `back`, and again */
  async function expectTrips(markdown: string, back = markdown): Promise<void> {
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe(back);
    expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(back);
  }

  test.each([
    ['inline', noBar('a', 'b'), false, inline(barless)],
    ['in display math', noBar('a', 'b'), true, display(barless)],
    ['in a superscript', '<m:sSup><m:e>' + run('x') + '</m:e><m:sup>' + noBar('a', 'b') + '</m:sup></m:sSup>', true, display('x^{' + barless + '}')],
    ['in a matrix cell', '<m:m><m:mr><m:e>' + noBar('a', 'b') + '</m:e><m:e>' + run('c') + '</m:e></m:mr></m:m>', true, display('\\begin{matrix} ' + barless + ' & c \\end{matrix}')],
    ['beside a fraction', noBar('a', 'b') + frac('c', 'd'), true, display(barless + '\\frac{c}{d}')],
  ])('from Word, %s, comes back as \\genfrac, which export writes as noBar, and again', async (_name, omml, isDisplay, markdown) => {
    expect((await convertDocx(await wordDocx(omml, isDisplay))).markdown).toBe(markdown);
    const xml = await documentXml(markdown);
    expect(xml).toContain(noBar('a', 'b'));
    expect(xml).not.toContain('genfrac');
    await expectTrips(markdown);
  });

  test('in parentheses alone, from Word, comes back as \\binom, as on main, and again', async () => {
    expect((await convertDocx(await wordDocx(parens(noBar('a', 'b')), true))).markdown).toBe(display('\\binom{a}{b}'));
    await expectTrips(display('\\binom{a}{b}'));
  });

  test('in \\left( and \\right), exports as Word\'s binomial, and comes back as \\binom, and again', async () => {
    expect(await documentXml(inline('\\left(' + barless + '\\right)'))).toContain(parens(noBar('a', 'b')));
    await expectTrips(inline('\\left(' + barless + '\\right)'), inline('\\binom{a}{b}'));
  });

  // As on main
  test.each([
    ['\\binom{a}{b}', inline('\\binom{a}{b}')],
    ['\\frac{a}{b}', inline('\\frac{a}{b}')],
    ['{a}/{b}', inline('{a}/{b}')],
  ])('%s comes back as before, and again', (_latex, markdown) => expectTrips(markdown));

  test('a skewed fraction from Word comes back as a linear one, as on main, and again', async () => {
    expect((await convertDocx(await wordDocx('<m:f><m:fPr><m:type m:val="skw"/></m:fPr><m:num>' + run('a') + '</m:num><m:den>' + run('b') + '</m:den></m:f>', false))).markdown).toBe(inline('{a}/{b}'));
    await expectTrips(inline('{a}/{b}'));
  });

  // Any other \genfrac, with delimiters, a rule or a style, is an unknown
  // command, as on main
  test.each([
    ['\\genfrac{(}{)}{0pt}{}{a}{b}', '\\genfrac()0ptab'],
    ['\\genfrac{}{}{1pt}{}{a}{b}', '\\genfrac1ptab'],
    ['\\genfrac{}{}{0pt}{0}{a}{b}', '\\genfrac0pt0ab'],
    ['{a \\atop b}', 'a \\atop b'],
  ])('%s comes back as before, and again', async (latex, back) => {
    const warnings: string[] = [];
    expect(latexToOmml(latex, command => warnings.push(command))).not.toContain('noBar');
    expect(warnings.length).toBe(1);
    await expectTrips(inline(latex), inline(back));
  });
});


// A space Word holds after a number that starts an inline equation, other
// than a space or tab, which import writes as \ , or one a spacing command
// exports as, as a no-break space, made $2 x$ with the character, which
// export read as currency, so Word got the text $2 x$ and lost the equation
describe('a number and a space of another kind at the start of an inline equation', () => {
  const preserved = (t: string) => '<m:r><m:t xml:space="preserve">' + t + '</m:t></m:r>';
  const inline = (latex: string) => 'A $' + latex + '$ B.\n';
  const table = (cell: string) => '| h |\n| --- |\n| ' + cell + ' |\n';

  /** A document from Word with `markdown`'s first equation as `omml` */
  async function wordDocx(omml: string, markdown: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** The equations Word gets for `markdown` */
  async function equations(markdown: string): Promise<string[]> {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    return [...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].map(m => m[1]);
  }

  /** The text of an equation's runs */
  const shown = (omml: string) => [...omml.matchAll(/<m:t(?: [^>]*)?>([^<]*)<\/m:t>/g)].map(m => m[1]).join('');

  /** `omml` from Word comes back as `markdown`, whose equation Word gets
   *  as `text`, and the next trip gives both again */
  async function expectFromWord(omml: string, base: string, markdown: string, text: string): Promise<void> {
    expect((await convertDocx(await wordDocx(omml, base))).markdown).toBe(markdown);
    const once = await equations(markdown);
    expect(once.map(shown)).toEqual([text]);
    const twice = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(twice).toBe(markdown);
    expect(await equations(twice)).toEqual(once);
  }

  test.each([
    ['a no-break space', '\u00a0', 'x'],
    ['an en space', '\u2002', 'x'],
    ['a narrow no-break space', '\u202f', 'x'],
    ['an ideographic space', '\u3000', 'x'],
    ['a no-break space before +', '\u00a0', '+x'],
    ['a no-break space before α', '\u00a0', 'α'],
    ['a no-break space before (', '\u00a0', '(x)'],
  ])('%s after the number, from Word, keeps it an equation, and again', (_name, space, rest) => {
    const latex = '2{}' + space + rest.replace('α', '\\alpha');
    return expectFromWord(preserved('2' + space + rest), inline('x'), inline(latex), '2' + space + rest);
  });

  test('a no-break space after the number, in a table cell, from Word, keeps it an equation, and again', () =>
    expectFromWord(preserved('2\u00a0x'), table('A $x$ B.'), table('A $2{}\u00a0x$ B.'), '2\u00a0x'));

  // As on main
  test.each([
    ['a space', preserved('2 x'), inline('2\\ x'), '2 x'],
    ['two spaces', preserved('2  x'), inline('2\\ \\ x'), '2  x'],
    ['a tab', preserved('2\tx'), inline('2\\ x'), '2 x'],
    ['an em space', preserved('2\u2003x'), inline('2\\quad x'), '2\u2003 x'],
    ['nothing', run('2'), inline('2'), '2'],
  ])('%s after the number, from Word, comes back as before, and again', (_name, omml, markdown, text) =>
    expectFromWord(omml, inline('x'), markdown, text));

  test('a no-break space after the number, in display math, from Word, comes back as before, and again', async () => {
    const display = (latex: string) => '$'.repeat(2) + '\n' + latex + '\n' + '$'.repeat(2) + '\n';
    expect((await convertDocx(await wordDocx(preserved('2\u00a0x'), display('x')))).markdown).toBe(display('2\u00a0x'));
    expect((await convertDocx((await convertMdToDocx(display('2\u00a0x'))).docx)).markdown).toBe(display('2\u00a0x'));
  });

  test.each([
    ['A $2 and $3 B.\n', 0],
    ['It costs $5.\n', 0],
    ['A $2+3$ B.\n', 1],
    ['A $2\\ x$ B.\n', 1],
    ['A $2$ B.\n', 1],
  ])('%j comes back as before, and again', async (markdown, count) => {
    expect(await equations(markdown)).toHaveLength(count);
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe(markdown);
    expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(markdown);
  });
});

// Word's $ in a run of math came back as it is, which can't stand in $...$:
// at the equation's start or end it closed the equation, as $ $x$ for $x,
// and in the middle, as $x$y$, it left no equation. Import writes it as \$
// now, as a style's group does, and export writes \$ in math as Word's $
describe('a dollar sign in an equation', () => {
  const inline = (latex: string) => 'c $' + latex + '$ b.\n';
  const display = (latex: string) => '$'.repeat(2) + '\n' + latex + '\n' + '$'.repeat(2) + '\n';
  const table = (cell: string) => '| h |\n| --- |\n| ' + cell + ' |\n';

  /** A document from Word with `markdown`'s first equation as `omml` */
  async function wordDocx(omml: string, markdown: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** The equations Word gets for `markdown` */
  async function equations(markdown: string): Promise<string[]> {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    return [...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].map(m => m[1]);
  }

  /** The text of an equation's runs */
  const shown = (omml: string) => [...omml.matchAll(/<m:t(?: [^>]*)?>([^<]*)<\/m:t>/g)].map(m => m[1]).join('');

  /** `markdown`'s equation is `text` in Word, and the next trip gives the
   *  same Markdown and the same equation */
  async function expectTrips(markdown: string, text: string): Promise<void> {
    const once = await equations(markdown);
    expect(once.map(shown)).toEqual([text]);
    const twice = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(twice).toBe(markdown);
    expect(await equations(twice)).toEqual(once);
  }

  test.each([
    ['at the start', run('$x'), inline('\\$x')],
    ['at the end', run('x$'), inline('x\\$')],
    ['at both ends', run('$x') + run('$'), inline('\\$x\\$')],
    ['alone', run('$'), inline('\\$')],
    ['twice at the start', run('$'.repeat(2) + 'x'), inline('\\$\\$x')],
    ['in the middle', run('x$y'), inline('x\\$y')],
    ['twice in the middle', run('x' + '$'.repeat(2) + 'y'), inline('x\\$\\$y')],
    ['in a run of its own at the start', run('$') + run('x'), inline('\\$x')],
    // Not a dollar amount, which a number and a space after $ read as
    ['before a number', run('$5'), inline('\\$5')],
    ['after a number', run('5$'), inline('5\\$')],
    ['before a number and a space', run('$2 x'), inline('\\$2 x')],
    // Its space written as \ , or after {}, as before
    ['after a number and a space', run('2 $'), inline('2\\ \\$')],
    ['after a number and a no-break space', run('2\u00A0$'), inline('2{}\u00A0\\$')],
    ['in a fraction', '<m:f><m:num>' + run('$') + '</m:num><m:den>' + run('2') + '</m:den></m:f>', inline('\\frac{\\$}{2}')],
    ['in a superscript', '<m:sSup><m:e>' + run('x') + '</m:e><m:sup>' + run('$') + '</m:sup></m:sSup>', inline('x^\\$')],
    ['in an accent', '<m:acc><m:e>' + run('$') + '</m:e></m:acc>', inline('\\hat{\\$}')],
  ])('%s of an inline equation, from Word, is \\$, which export writes as $, and again', async (_name, omml, markdown) => {
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    await expectTrips(markdown, shown(omml));
  });

  test('in a matrix\'s cells, from Word, is \\$, which export writes as $, and again', async () => {
    const omml = '<m:m><m:mr><m:e>' + run('$') + '</m:e><m:e>' + run('x$') + '</m:e></m:mr></m:m>';
    const markdown = inline('\\begin{matrix} \\$ & x\\$ \\end{matrix}');
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    // With the spaces around & that export writes, as on main
    await expectTrips(markdown, ' $  x$ ');
  });

  test.each([
    ['twice in the middle', 'x' + '$'.repeat(2) + 'y', 'x\\$\\$y'],
    ['twice, alone', '$'.repeat(2), '\\$\\$'],
  ])('%s of display math, from Word, is \\$, which export writes as $, and again', async (_name, text, latex) => {
    expect((await convertDocx(await wordDocx(run(text), display('y')))).markdown).toBe(display(latex));
    await expectTrips(display(latex), text);
  });

  test('at the start of an equation in a table cell, from Word, is \\$, and again', async () => {
    expect((await convertDocx(await wordDocx(run('$x'), table('c $y$ b.')))).markdown).toBe(table('c $\\$x$ b.'));
    await expectTrips(table('c $\\$x$ b.'), '$x');
  });

  test('at the start of an equation in a footnote, from Word, is \\$, and again', async () => {
    const note = (latex: string) => 'a[^1]\n\n[^1]: c $' + latex + '$ b.\n';
    const docx = (await convertMdToDocx(note('y'))).docx;
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/footnotes.xml')!.async('string');
    zip.file('word/footnotes.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + run('$x') + '</m:oMath>'));
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(markdown).toBe(note('\\$x'));
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  test.each([
    ['at the start', '\\$x', '$x'],
    ['in the middle', 'x\\$y', 'x$y'],
    ['at the end', 'x\\$', 'x$'],
  ])('\\$ %s of an equation in Markdown exports as $, and comes back, and again', async (_name, latex, text) => {
    expect(latexToOmml(latex)).toContain('<m:t>$</m:t>');
    await expectTrips(inline(latex), text);
  });

  // A backslash before it in Word's text, as export wrote for \$ before, or
  // in the run before, comes back as \$, as on main, which export now
  // writes as Word's $
  test.each([
    ['in its run', run('\\$x'), inline('\\$x'), '$x'],
    ['in the run before', run('x\\') + run('$y'), inline('x\\$y'), 'x$y'],
  ])('after a backslash %s, from Word, is \\$, as on main, which export writes as $, and again', async (_name, omml, markdown, text) => {
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    await expectTrips(markdown, text);
  });

  // As on main
  test.each([
    ['upright', '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>$x</m:t></m:r>', inline('\\text{\\$x}')],
    ['in a bold group', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>$x</m:t></m:r>', inline('\\mathbf{\\$x}')],
  ])('%s, from Word, comes back as before, and again', async (_name, omml, markdown) => {
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    await expectTrips(markdown, '$x');
  });

  test.each([
    ['It costs $5 and $x$ more.\n', 1],
    ['It costs $5 and $6.\n', 0],
    ['A $\\text{\\$5}$ B.\n', 1],
  ])('%j comes back as before, and again', async (markdown, count) => {
    expect(await equations(markdown)).toHaveLength(count);
    const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(once).toBe(markdown);
    expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(markdown);
  });
});

describe('a brace in an equation', () => {
  const inline = (latex: string) => 'c $' + latex + '$ b.\n';
  const display = (latex: string) => '$'.repeat(2) + '\n' + latex + '\n' + '$'.repeat(2) + '\n';

  /** A document from Word with `markdown`'s first equation as `omml` */
  async function wordDocx(omml: string, markdown: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/, () => '<m:oMath>' + omml + '</m:oMath>'));
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** The equations Word gets for `markdown` */
  async function equations(markdown: string): Promise<string[]> {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
    return [...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].map(m => m[1]);
  }

  /** The text of an equation's runs */
  const shown = (omml: string) => [...omml.matchAll(/<m:t(?: [^>]*)?>([^<]*)<\/m:t>/g)].map(m => m[1]).join('');

  /** `markdown`'s equations are `text` in Word, and the next trip gives the
   *  same Markdown and the same equations */
  async function expectTrips(markdown: string, text: string): Promise<void> {
    const once = await equations(markdown);
    expect(once.map(shown).join('')).toBe(text);
    const twice = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(twice).toBe(markdown);
    expect(await equations(twice)).toEqual(once);
  }

  // Export dropped these, as LaTeX's error recovery does
  test.each([
    ['an opening brace in display math', display('x { y'), display('x \\{ y'), 'x { y'],
    ['a closing brace in display math', display('x } y'), display('x \\} y'), 'x } y'],
    ['an opening brace in inline math', inline('x { y'), inline('x \\{ y'), 'x { y'],
    ['a closing brace in inline math', inline('x } y'), inline('x \\} y'), 'x } y'],
    ['an opening brace at the start', inline('{x'), inline('\\{x'), '{x'],
    ['a closing brace before an opening one', inline('x}{y'), inline('x\\}\\{y'), 'x}{y'],
    // Not CriticMarkup, which needs its ++}
    ['{++ in display math', display('x {++ y'), display('x \\{++ y'), 'x {++ y'],
    ['an opening brace after \\$', inline('\\$ { x'), inline('\\$ \\{ x'), '$ { x'],
    // An aligned with no & comes back as gathered, as on main
    ['an opening brace in an environment', inline('\\begin{aligned} x { y \\end{aligned}'), inline('\\begin{gathered} x \\{ y \\end{gathered}'), ' x { y '],
    ['a closing brace in a matrix', inline('\\begin{matrix} a } b \\end{matrix}'), inline('\\begin{matrix} a \\} b \\end{matrix}'), ' a } b '],
  ])('%s that nothing matches exports as the character, which comes back as \\{ or \\}, and again', async (_name, markdown, back, text) => {
    expect((await equations(markdown)).map(shown).join('')).toBe(text);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(back);
    await expectTrips(back, text);
  });

  // Export wrote them with their backslash, which Word showed
  test.each([
    ['inline math', inline('\\{x\\}'), '{x}'],
    ['display math', display('\\{x\\}'), '{x}'],
    ['inline math, with spaces', inline('x \\{ y \\} z'), 'x { y } z'],
  ])('\\{ and \\} in %s export as the brace, and come back, and again', async (_name, markdown, text) => {
    await expectTrips(markdown, text);
  });

  test.each([
    ['in runs of their own', run('{') + run('x') + run('}'), inline('\\{x\\}')],
    ['in a run', run('{x}'), inline('\\{x\\}')],
    ['an opening one in the middle', run('x{y'), inline('x\\{y')],
    ['a closing one in the middle', run('x}y'), inline('x\\}y')],
    // Not CriticMarkup, which export read it as
    ['around ++', run('x {++ y ++} z'), inline('x \\{++ y ++\\} z')],
    ['after a dollar sign', run('$') + run('{'), inline('\\$\\{')],
    ['in a subscript', '<m:sSub><m:e>' + run('x') + '</m:e><m:sub>' + run('{') + '</m:sub></m:sSub>', inline('x_{\\{}')],
    ['in a fraction', '<m:f><m:num>' + run('{a') + '</m:num><m:den>' + run('b}') + '</m:den></m:f>', inline('\\frac{\\{a}{b\\}}')],
  ])('%s of an inline equation, from Word, is \\{ or \\}, which export writes as the brace, and again', async (_name, omml, markdown) => {
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    await expectTrips(markdown, shown(omml));
  });

  test('in a display equation, from Word, is \\{, which export writes as the brace, and again', async () => {
    expect((await convertDocx(await wordDocx(run('{x'), display('y')))).markdown).toBe(display('\\{x'));
    await expectTrips(display('\\{x'), '{x');
  });

  test('in a matrix\'s cells, from Word, is \\{ or \\}, which export writes as the brace, and again', async () => {
    const omml = '<m:m><m:mr><m:e>' + run('{') + '</m:e><m:e>' + run('x}') + '</m:e></m:mr></m:m>';
    const markdown = inline('\\begin{matrix} \\{ & x\\} \\end{matrix}');
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    // With the spaces around & that export writes, as on main
    await expectTrips(markdown, ' {  x} ');
  });

  // As on main
  test.each([
    ['a group', inline('{x}'), inline('x'), 'x'],
    ['a script\'s group', inline('x^{2}'), inline('x^2'), 'x2'],
    ['a fraction', inline('\\frac{a}{b}'), inline('\\frac{a}{b}'), 'ab'],
    ['\\left\\{ and \\right\\}', inline('\\left\\{x\\right\\}'), inline('\\left\\{x\\right\\}'), 'x'],
    ['\\{ and \\} in a bold group', inline('\\mathbf{\\{x\\}}'), inline('\\mathbf{\\{x\\}}'), '{x}'],
    ['\\{ and \\} in text', inline('\\text{a \\{b\\} c}'), inline('\\text{a \\{b\\} c}'), 'a {b} c'],
    // Word shows these as their LaTeX, braces and all
    ['an environment\'s column spec', inline('\\begin{array}{cc} a & b \\end{array}'), inline('\\begin{array}{cc} a & b \\end{array}'), '\\begin{array}{cc} a &amp; b \\end{array}'],
    ['an unknown environment', inline('\\begin{foo} x \\end{foo}'), inline('\\begin{foo} x \\end{foo}'), '\\begin{foo} x \\end{foo}'],
    // A command's or a script's group with no closing brace closes at the
    // equation's end, as LaTeX's error recovery does
    ['a fraction\'s unclosed group', inline('\\frac{a}{b'), inline('\\frac{a}{b}'), 'ab'],
    ['a script\'s unclosed group', inline('x^{2'), inline('x^2'), 'x2'],
    // Its script has no base, as where it's closed
    ['an unclosed group a superscript starts', inline('{^2'), inline('^2'), '^2'],
    ['an unclosed group a subscript starts, after a space', inline('{ _i'), inline('_i'), '_i'],
    ['an unclosed group in one a superscript starts', inline('{{^2'), inline('^2'), '^2'],
    ['an unclosed group in one a subscript starts', inline('{{_i'), inline('_i'), '_i'],
    ['an unclosed group before a closed one a script starts', inline('{{^2} x'), inline('^2 x'), '^2 x'],
    // Word gets the comment as hidden text, after a zero-width space
    ['a brace in a comment', display('x % {\ny'), display('x % {\ny'), 'x\u200B % {\ny'],
  ])('%s comes back as on main, and again', async (_name, markdown, back, text) => {
    expect((await equations(markdown)).map(shown).join('')).toBe(text);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(back);
    await expectTrips(back, text);
  });

  // Word gets the space too, which the next export drops, as on main
  test('an unclosed group with a space before one a script starts comes back as on main', async () => {
    expect((await convertDocx((await convertMdToDocx(inline('{ {^2'))).docx)).markdown).toBe(inline('^2'));
  });

  // A group's own closing brace, read past while the group is open, as
  // where \sum_i^2 takes the environment's \end for its body, is dropped,
  // and the group is read as closed, as on main
  test.each([
    ['\\boxed{\\begin{matrix}\\sum_i^2\\end{matrix}}', '\\boxed{\\begin{matrix} \\sum_i^2 \\end{matrix}}'],
    ['\\boxed{\\begin{matrix}\\sum_i^2{}\\end{matrix}}', '\\boxed{\\begin{matrix} \\sum_i^2 \\end{matrix}}'],
    ['{\\left( x } \\right)}', '(x)'],
    ['{\\begin{matrix}\\sum_i^2\\end{matrix}}', '\\begin{matrix} \\sum_i^2 \\end{matrix}'],
    ['{ {\\begin{matrix}\\sum_i^2\\end{matrix}}', '\\begin{matrix} \\sum_i^2 \\end{matrix}'],
  ])('a closing brace read past in an open group, in %s, shows no brace, as on main', async (latex, back) => {
    expect((await equations(inline(latex))).map(shown).join('')).not.toMatch(/[{}]/);
    expect((await convertDocx((await convertMdToDocx(inline(latex))).docx)).markdown).toBe(inline(back));
    expect((await equations(inline(back))).map(shown).join('')).not.toMatch(/[{}]/);
  });

  // A backslash before it in Word's text, as export wrote for \{ before, or
  // in the run before, comes back as \{, as on main, which export now writes
  // as Word's {
  test.each([
    ['in its run', run('\\{x\\}'), inline('\\{x\\}'), '{x}'],
    ['in the run before', run('x\\') + run('{y'), inline('x\\{y'), 'x{y'],
  ])('after a backslash %s, from Word, is \\{, as on main, which export writes as the brace, and again', async (_name, omml, markdown, text) => {
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    await expectTrips(markdown, text);
  });

  test.each([
    // The rest of a command's argument, which export wrote as text
    ['in a command split across runs', run('\\begin{') + run('foo}'), inline('\\begin{foo}'), '\\begin{foo}'],
    ['upright', '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>{x}</m:t></m:r>', inline('\\text{\\{x\\}}'), '{x}'],
    ['in a bold group', '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>{x}</m:t></m:r>', inline('\\mathbf{\\{x\\}}'), '{x}'],
    ['as delimiters', '<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val="}"/></m:dPr><m:e>' + run('x') + '</m:e></m:d>', inline('\\left\\{x\\right\\}'), 'x'],
  ])('%s, from Word, comes back as on main, and again', async (_name, omml, markdown, text) => {
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    await expectTrips(markdown, text);
  });

  test('after a % in Word\'s text, comes back raw, as on main, and again', async () => {
    const markdown = inline('50%{x}');
    expect((await convertDocx(await wordDocx(run('50%{x}'), inline('y')))).markdown).toBe(markdown);
    const once = await equations(markdown);
    const twice = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(twice).toBe(markdown);
    expect(await equations(twice)).toEqual(once);
  });

  // An equation whose Word text holds LaTeX, a \ or a %, keeps its braces
  // as they are, as on main, as which are LaTeX's is LaTeX's reading of the
  // text, as where Word splits export's \begin{array}{cc} into the runs
  // \begin and {array}{cc}, where it's edited
  test.each([
    ['before an environment\'s name', 'array', '\\begin{array}{cc}', 6],
    ['in its name', 'array', '\\begin{array}{cc}', 7],
    ['before its columns', 'array', '\\begin{array}{cc}', 13],
    ['in its columns', 'array', '\\begin{array}{cc}', 14],
    ['before its \\end\'s name', 'array', '\\end{array}', 4],
    ['before an unknown environment\'s name', 'foo', '\\begin{foo}', 6],
    ['before its \\end\'s name', 'foo', '\\end{foo}', 4],
  ])('a run split %s, %s, from Word, comes back as on main, and again', async (_name, environment, text, at) => {
    const latex = environment === 'array' ? '\\begin{array}{cc} a & b \\end{array}' : '\\begin{foo} x \\end{foo}';
    const zip = await JSZip.loadAsync((await convertMdToDocx(inline(latex))).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const whole = '<m:r><m:t>' + text + '</m:t></m:r>';
    expect(xml).toContain(whole);
    zip.file('word/document.xml', xml.replace(whole, () => run(text.slice(0, at)) + run(text.slice(at))));
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe(inline(latex));
    await expectTrips(inline(latex), latex.replace('&', '&amp;'));
  });

  test.each([
    ['\\frac{\\alpha}{b}', run('\\frac{\\alpha}{b}'), inline('\\frac{\\alpha}{b}'), '\u03B1b'],
    ['\\sqrt[3]{x}', run('\\sqrt[3]{x}'), inline('\\sqrt[3]{x}'), '3x'],
    ['\\genfrac{}{}{0pt}{}{a}{b}', run('\\genfrac{}{}{0pt}{}{a}{b}'), inline('\\genfrac{}{}{0pt}{}{a}{b}'), 'ab'],
    ['\\begin, a bookmark and {array}{cc}', run('\\begin') + '<w:bookmarkStart w:id="0" w:name="b"/>' + run('{array}{cc}') + run(' a ') + run('\\end{array}'),
      inline('\\begin{array}{cc} a \\end{array}'), '\\begin{array}{cc} a \\end{array}'],
  ])('%s as Word\'s text comes back as on main, and again', async (_name, omml, markdown, text) => {
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    await expectTrips(markdown, text);
  });

  // Typed in Word: LaTeX, as on main
  test.each([
    ['\\mathrm and {x}', run('\\mathrm') + run('{x}'), inline('\\mathrm{x}'), 'x'],
    ['\\begin and {foo}, with a space between', run('\\begin ') + run('{foo}') + run(' x ') + run('\\end{foo}'), inline('\\begin {foo} x \\end{foo}'), '\\begin{foo} x \\end{foo}'],
  ])('%s, in runs of their own, from Word, are a command and its argument, as on main', async (_name, omml, markdown, text) => {
    expect((await convertDocx(await wordDocx(omml, inline('y')))).markdown).toBe(markdown);
    expect((await equations(markdown)).map(shown).join('')).toBe(text);
  });

  // In an equation whose Word text holds LaTeX, \{ and \} export as written,
  // as on main, since import keeps its braces as they are
  test.each([
    ['after a command export writes as text', inline('\\foo\\{x\\}'), '\\foo\\{x\\}'],
    ['in an environment export writes as text', inline('\\begin{array}{cc} \\{a\\} & b \\end{array}'), '\\begin{array}{cc} \\{a\\} &amp; b \\end{array}'],
    ['after \\%', inline('\\% \\{x\\}'), '\\% \\{x\\}'],
    // Alike in the equation and each view, so the change is tracked in place
    ['beside an insertion of a command export writes as text', inline('\\{x\\} {++\\foo++}'), '\\{x\\} \\foo'],
    ['beside a deletion of a command export writes as text', inline('\\{x\\} {--\\foo--}'), '\\{x\\} \\foo'],
  ])('\\{ and \\} %s come back as on main, and again', async (_name, markdown, text) => {
    await expectTrips(markdown, text);
  });

  // The number Word holds for a \tag counts: its \% is a bare %
  test.each([
    ['display math', display('\\{x\\} \\tag{50\\%}')],
    ['a row of gather*', display('\\begin{gather*}\n\\{x\\} \\tag{50\\%} \\\\\ny\n\\end{gather*}')],
    ['a tracked change', display('{++a++} \\{x\\} \\tag{50\\%}')],
  ])('\\{ and \\} before an equation number holding \\%% in %s come back as on main, and again', async (_name, markdown) => {
    const once = await equations(markdown);
    const twice = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
    expect(twice).toBe(markdown);
    expect(await equations(twice)).toEqual(once);
  });

  // Word gets no number for a \tag in a change, so its \% doesn't count
  test.each([
    ['an insertion', display('\\{x\\} {++\\tag{50\\%}++}'), '{x} '],
    ['a deletion', display('\\{x\\} {--\\tag{50\\%}--}'), '{x} '],
  ])('\\{ and \\} before a \\tag holding \\%% in %s export as the brace', async (_name, markdown, text) => {
    expect((await equations(markdown)).map(shown).join('')).toBe(text);
  });

  test('\\{ and \\} beside an insertion of a command export writes as text are tracked in place, as on main', async () => {
    const [omml] = await equations(inline('\\{x\\} {++\\foo++}'));
    expect(omml).toMatch(/^(?:(?!<w:ins)[\s\S])*\\\{(?:(?!<w:ins)[\s\S])*<w:ins /);
    expect(omml).not.toContain('<w:del ');
  });

  // An unmatched brace there exports as the character, which comes back as
  // it is, unmatched again. Export dropped it
  test.each([
    ['an opening brace', inline('\\foo { x'), '\\foo { x'],
    ['a closing brace', inline('\\foo } x'), '\\foo } x'],
  ])('%s that nothing matches, in an equation whose Word text holds LaTeX, exports as the character, and comes back, and again', async (_name, markdown, text) => {
    await expectTrips(markdown, text);
  });
});
