import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { unicodeToLatex, escapeLatex, isMultiLetter, ommlToLatex } from './omml';

// ---------------------------------------------------------------------------
// Helpers: build OMML node structures matching fast-xml-parser preserveOrder
// ---------------------------------------------------------------------------

/** Build an m:r node with plain text in m:t */
function makeRun(text: string, style?: string): Record<string, any> {
  const children: any[] = [];
  if (style) {
    children.push({
      'm:rPr': [{ 'm:sty': [{}], ':@': { '@_m:val': style } }],
    });
  }
  children.push({ 'm:t': [{ '#text': text }] });
  return { 'm:r': children };
}

// ---------------------------------------------------------------------------
// Known mapping table (duplicated for test assertions)
// ---------------------------------------------------------------------------

const KNOWN_UNICODE_LATEX: [string, string][] = [
  ['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'],
  ['ε', '\\epsilon'], ['ζ', '\\zeta'], ['η', '\\eta'], ['θ', '\\theta'],
  ['ι', '\\iota'], ['κ', '\\kappa'], ['λ', '\\lambda'], ['μ', '\\mu'],
  ['ν', '\\nu'], ['ξ', '\\xi'], ['π', '\\pi'], ['ρ', '\\rho'],
  ['σ', '\\sigma'], ['τ', '\\tau'], ['υ', '\\upsilon'], ['φ', '\\phi'],
  ['χ', '\\chi'], ['ψ', '\\psi'], ['ω', '\\omega'],
  ['Γ', '\\Gamma'], ['Δ', '\\Delta'], ['Θ', '\\Theta'], ['Λ', '\\Lambda'],
  ['Ξ', '\\Xi'], ['Π', '\\Pi'], ['Σ', '\\Sigma'], ['Φ', '\\Phi'],
  ['Ψ', '\\Psi'], ['Ω', '\\Omega'],
  ['×', '\\times'], ['÷', '\\div'], ['±', '\\pm'], ['∓', '\\mp'],
  ['≤', '\\leq'], ['≥', '\\geq'], ['≠', '\\neq'], ['≈', '\\approx'],
  ['∞', '\\infty'], ['∂', '\\partial'], ['∇', '\\nabla'],
  ['∈', '\\in'], ['∉', '\\notin'], ['⊂', '\\subset'], ['⊃', '\\supset'],
  ['∪', '\\cup'], ['∩', '\\cap'], ['→', '\\to'], ['←', '\\leftarrow'],
  ['⇒', '\\Rightarrow'], ['⇐', '\\Leftarrow'], ['↔', '\\leftrightarrow'],
  ['∀', '\\forall'], ['∃', '\\exists'], ['¬', '\\neg'],
  ['∧', '\\land'], ['∨', '\\lor'], ['⊕', '\\oplus'], ['⊗', '\\otimes'],
  ['∣', '\\mid'],
  ['·', '\\cdot'], ['…', '\\ldots'], ['⋯', '\\cdots'],
];

const MAPPED_CHARS = new Set(KNOWN_UNICODE_LATEX.map(([ch]) => ch));

const LATEX_RESERVED_CHARS = ['#', '$', '%', '&', '_', '{', '}', '~', '^', '\\'];

// Generator: single ASCII printable non-whitespace character (code 33-126)
const asciiPrintable = fc.integer({ min: 33, max: 126 }).map(c => String.fromCharCode(c));

// Generator: single ASCII letter
const asciiLetter = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
);

/**
 * Strip known LaTeX escape sequences from a string, returning only
 * the "bare" characters. Used to verify no unescaped reserved chars remain.
 */
function stripEscapeSequences(s: string): string {
  return s
    .replace(/\\textbackslash\{\}/g, '')
    .replace(/\\textasciitilde\{\}/g, '')
    .replace(/\\textasciicircum\{\}/g, '')
    .replace(/\\#/g, '')
    .replace(/\\\$/g, '')
    .replace(/\\%/g, '')
    .replace(/\\&/g, '')
    .replace(/\\_/g, '')
    .replace(/\\\{/g, '')
    .replace(/\\\}/g, '');
}

// ---------------------------------------------------------------------------
// Property 5: Unicode-to-LaTeX mapping correctness
// Feature: docx-equation-conversion, Property 5: Unicode-to-LaTeX mapping correctness
// **Validates: Requirements 4.1, 4.2, 4.3**
// ---------------------------------------------------------------------------

describe('Feature: docx-equation-conversion, Property 5: Unicode-to-LaTeX mapping correctness', () => {
  it('mapped characters produce the expected LaTeX command', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_UNICODE_LATEX),
        ([char, expectedCmd]) => {
          const result = unicodeToLatex(char);
          return result.includes(expectedCmd);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('preserves Unicode math spaces', () => {
    expect(unicodeToLatex('\u2009')).toBe('\u2009');  // thin space (\,)
    expect(unicodeToLatex('\u205F')).toBe('\u205F');  // medium space (\:)
    expect(unicodeToLatex('\u2004')).toBe('\u2004');  // 3-per-em (\;)
    expect(unicodeToLatex('\u2003')).toBe('\u2003');  // em space (\quad)
    expect(unicodeToLatex('\u2005')).toBe('\u2005');  // 4-per-em (\pmod)
  });

  it('unmapped characters pass through unchanged', () => {
    // Use non-whitespace ASCII chars that are NOT in the mapping table
    const unmappedChar = asciiPrintable.filter(ch => !MAPPED_CHARS.has(ch));
    fc.assert(
      fc.property(unmappedChar, (ch) => {
        const result = unicodeToLatex(ch);
        return result === ch;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: LaTeX escaping of reserved characters
// Feature: docx-equation-conversion, Property 6: LaTeX escaping of reserved characters
// **Validates: Requirements 4A.1, 4A.2**
// ---------------------------------------------------------------------------

describe('Feature: docx-equation-conversion, Property 6: LaTeX escaping of reserved characters', () => {
  it('no raw reserved characters remain after stripping escape sequences', () => {
    const mixedChars = 'abc123' + LATEX_RESERVED_CHARS.join('');
    const strWithReserved = fc.array(
      fc.constantFrom(...mixedChars.split('')),
      { minLength: 1, maxLength: 10 },
    ).map(arr => arr.join(''));

    fc.assert(
      fc.property(strWithReserved, (text) => {
        const result = escapeLatex(text);
        const stripped = stripEscapeSequences(result);
        // After stripping all known escape sequences, no reserved chars should remain
        for (const ch of LATEX_RESERVED_CHARS) {
          if (stripped.includes(ch)) return false;
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('non-reserved characters pass through unchanged', () => {
    const safeChar = asciiPrintable.filter(
      ch => !LATEX_RESERVED_CHARS.includes(ch),
    );
    const safeStr = fc.array(safeChar, { minLength: 1, maxLength: 10 })
      .map(arr => arr.join(''));

    fc.assert(
      fc.property(safeStr, (text) => {
        return escapeLatex(text) === text;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Math run text handling
// Feature: docx-equation-conversion, Property 11: Math run text handling
// **Validates: Requirements 3.14, 3A.2**
// ---------------------------------------------------------------------------

describe('Feature: docx-equation-conversion, Property 11: Math run text handling', () => {
  it('single-letter variables are emitted without \\mathrm wrapping', () => {
    fc.assert(
      fc.property(asciiLetter, (letter) => {
        const node = makeRun(letter);
        const result = ommlToLatex([node]);
        return !result.includes('\\mathrm') && result.includes(letter);
      }),
      { numRuns: 100 },
    );
  });

  it('multi-letter text is preserved without implicit \\mathrm{} wrapping', () => {
    const multiLetter = fc.array(asciiLetter, { minLength: 2, maxLength: 6 })
      .map(arr => arr.join(''));

    fc.assert(
      fc.property(multiLetter, (text) => {
        const node = makeRun(text);
        const result = ommlToLatex([node]);
        return !result.includes('\\mathrm{') && result === text;
      }),
      { numRuns: 100 },
    );
  });

  it('alphabetic command at a run boundary gets a separator space before a letter', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_UNICODE_LATEX.filter(([, cmd]) => /[A-Za-z]$/.test(cmd))),
        asciiLetter,
        ([ch, cmd], letter) => {
          const result = ommlToLatex([makeRun(ch), makeRun(letter)]);
          return result === cmd + ' ' + letter;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('m:sty val="p" forces \\mathrm{} wrapping regardless of length', () => {
    const anyLetters = fc.array(asciiLetter, { minLength: 1, maxLength: 6 })
      .map(arr => arr.join(''));

    fc.assert(
      fc.property(anyLetters, (text) => {
        const node = makeRun(text, 'p');
        const result = ommlToLatex([node]);
        return result.includes('\\mathrm{');
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// OMML tree generator for property tests (Properties 3, 7, 9, 10)
// ---------------------------------------------------------------------------

/** Simple alphanumeric text for m:r nodes */
const alphaNum = fc.array(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 1, maxLength: 5 },
).map(arr => arr.join(''));

type Tie = (key: string) => fc.Arbitrary<Record<string, any>>;

/** Build an m:r math run node */
function genMathRun(): fc.Arbitrary<Record<string, any>> {
  return alphaNum.map(text => ({
    'm:r': [{ 'm:t': [{ '#text': text }] }],
  }));
}

/** Build an m:f (fraction) node */
function genFraction(tie: Tie): fc.Arbitrary<Record<string, any>> {
  return fc.tuple(tie('tree'), tie('tree')).map(([num, den]) => ({
    'm:f': [{ 'm:num': [num] }, { 'm:den': [den] }],
  }));
}

/** Build an m:sSup (superscript) node */
function genSuperscript(tie: Tie): fc.Arbitrary<Record<string, any>> {
  return fc.tuple(tie('tree'), tie('tree')).map(([base, sup]) => ({
    'm:sSup': [{ 'm:e': [base] }, { 'm:sup': [sup] }],
  }));
}

/** Build an m:sSub (subscript) node */
function genSubscript(tie: Tie): fc.Arbitrary<Record<string, any>> {
  return fc.tuple(tie('tree'), tie('tree')).map(([base, sub]) => ({
    'm:sSub': [{ 'm:e': [base] }, { 'm:sub': [sub] }],
  }));
}

/** Build an m:rad (radical) node */
function genRadical(tie: Tie): fc.Arbitrary<Record<string, any>> {
  return fc.tuple(tie('tree'), fc.boolean()).map(([body, hideDeg]) => {
    const children: any[] = [];
    if (hideDeg) {
      children.push({ 'm:radPr': [{ 'm:degHide': [], ':@': { '@_m:val': '1' } }] });
    }
    children.push({ 'm:e': [body] });
    return { 'm:rad': children };
  });
}

/** Build an m:nary (n-ary operator) node */
function genNary(tie: Tie): fc.Arbitrary<Record<string, any>> {
  return fc.tuple(
    tie('tree'),
    tie('tree'),
    tie('tree'),
    fc.constantFrom('∑', '∏', '∫'),
  ).map(([sub, sup, body, chr]) => ({
    'm:nary': [
      { 'm:naryPr': [{ 'm:chr': [], ':@': { '@_m:val': chr } }] },
      { 'm:sub': [sub] },
      { 'm:sup': [sup] },
      { 'm:e': [body] },
    ],
  }));
}

/** Build an m:d (delimiter) node */
function genDelimiter(tie: Tie): fc.Arbitrary<Record<string, any>> {
  return fc.array(tie('tree'), { minLength: 1, maxLength: 3 }).map(elements => ({
    'm:d': [
      ...elements.map((e: any) => ({ 'm:e': [e] })),
    ],
  }));
}

/** Build an m:acc (accent) node */
function genAccent(tie: Tie): fc.Arbitrary<Record<string, any>> {
  return fc.tuple(
    tie('tree'),
    fc.constantFrom('\u0302', '\u0305', '\u0307', '\u0303'),
  ).map(([base, chr]) => ({
    'm:acc': [
      { 'm:accPr': [{ 'm:chr': [], ':@': { '@_m:val': chr } }] },
      { 'm:e': [base] },
    ],
  }));
}

/** Build an m:m (matrix) node with 1-2 rows of 1-3 cells each */
function genMatrix(tie: Tie): fc.Arbitrary<Record<string, any>> {
  const genCell = tie('tree').map((e: any) => ({ 'm:e': [e] }));
  const genRow = fc.array(genCell, { minLength: 1, maxLength: 3 }).map(cells => ({
    'm:mr': cells,
  }));
  return fc.array(genRow, { minLength: 1, maxLength: 2 }).map(rows => ({
    'm:m': rows,
  }));
}

/** Build an m:func (function) node with a known function name and argument */
function genFunction(tie: Tie): fc.Arbitrary<Record<string, any>> {
  return fc.tuple(
    fc.constantFrom('sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim'),
    tie('tree'),
  ).map(([name, arg]) => ({
    'm:func': [
      { 'm:fName': [{ 'm:r': [{ 'm:t': [{ '#text': name }] }] }] },
      { 'm:e': [arg] },
    ],
  }));
}


/** Bounded OMML tree generator using fc.letrec */
function ommlTree(): fc.Arbitrary<Record<string, any>[]> {
  return fc.letrec((tie: Tie) => ({
    tree: fc.oneof(
      { depthSize: 'small' },
      genMathRun(),
      genFraction(tie),
      genSuperscript(tie),
      genSubscript(tie),
      genRadical(tie),
      genNary(tie),
      genDelimiter(tie),
      genAccent(tie),
      genMatrix(tie),
      genFunction(tie),
    ),
  })).tree.map(node => [node]);
}

// ---------------------------------------------------------------------------
// Property 3: Balanced braces invariant
// Feature: docx-equation-conversion, Property 3: Balanced braces invariant
// **Validates: Requirements 5.2, 3.9**
// ---------------------------------------------------------------------------

describe('Feature: docx-equation-conversion, Property 3: Balanced braces invariant', () => {
  it('curly braces are balanced in generated LaTeX', () => {
    fc.assert(
      fc.property(ommlTree(), (tree) => {
        const latex = ommlToLatex(tree);
        let depth = 0;
        for (const ch of latex) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
          if (depth < 0) return false; // closing brace without matching open
        }
        return depth === 0;
      }),
      { numRuns: 100 },
    );
  });

  it('\\left and \\right are balanced in generated LaTeX', () => {
    fc.assert(
      fc.property(ommlTree(), (tree) => {
        const latex = ommlToLatex(tree);
        const leftCount = (latex.match(/\\left/g) || []).length;
        const rightCount = (latex.match(/\\right/g) || []).length;
        return leftCount === rightCount;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Deterministic output
// Feature: docx-equation-conversion, Property 7: Deterministic output
// **Validates: Requirements 4A.4**
// ---------------------------------------------------------------------------

describe('Feature: docx-equation-conversion, Property 7: Deterministic output', () => {
  it('calling ommlToLatex twice on identical input produces identical output', () => {
    fc.assert(
      fc.property(ommlTree(), (tree) => {
        const result1 = ommlToLatex(tree);
        const result2 = ommlToLatex(tree);
        return result1 === result2;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Formatting and control node invariance
// Feature: docx-equation-conversion, Property 9: Formatting and control node invariance
// **Validates: Requirements 3A.3, 3A.4**
// ---------------------------------------------------------------------------

/** Insert formatting/control nodes into an OMML tree (non-destructive copy) */
function insertControlNodes(tree: Record<string, any>[]): Record<string, any>[] {
  const controlNodes = [
    { 'w:rPr': [{ 'w:b': [] }] },
    { 'w:bookmarkStart': [], ':@': { '@_w:id': '0', '@_w:name': '_Ref' } },
    { 'w:bookmarkEnd': [], ':@': { '@_w:id': '0' } },
    { 'w:proofErr': [], ':@': { '@_w:type': 'spellStart' } },
  ];

  return tree.map(node => {
    const copy: Record<string, any> = {};
    for (const key of Object.keys(node)) {
      if (key === ':@') {
        copy[key] = node[key];
      } else if (Array.isArray(node[key])) {
        // Insert control nodes at the beginning of children arrays
        copy[key] = [...controlNodes, ...node[key]];
      } else {
        copy[key] = node[key];
      }
    }
    return copy;
  });
}

describe('Feature: docx-equation-conversion, Property 9: Formatting and control node invariance', () => {
  it('adding w:rPr and control nodes does not change LaTeX output', () => {
    fc.assert(
      fc.property(ommlTree(), (tree) => {
        const baseline = ommlToLatex(tree);
        const withControls = insertControlNodes(tree);
        const result = ommlToLatex(withControls);
        return baseline === result;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Fallback and continuation
// Feature: docx-equation-conversion, Property 10: Fallback and continuation
// **Validates: Requirements 6.1, 6.4, 3B.2**
// ---------------------------------------------------------------------------

describe('Feature: docx-equation-conversion, Property 10: Fallback and continuation', () => {
  it('unrecognized m: element emits fallback and valid content still converts', () => {
    fc.assert(
      fc.property(ommlTree(), (tree) => {
        // Get baseline output for the valid tree
        const validLatex = ommlToLatex(tree);

        // Prepend an unknown m: element
        const unknownNode = { 'm:unknownXyz': [{ '#text': 'test' }] };
        const combined = [unknownNode, ...tree];
        const result = ommlToLatex(combined);

        // Must contain the fallback placeholder
        if (!result.includes('[UNSUPPORTED: unknownXyz]')) return false;

        // Must still contain the valid content's LaTeX
        if (validLatex && !result.includes(validLatex)) return false;

        return true;
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 4: Structural fidelity round-trip
// Feature: docx-equation-conversion, Property 4: Structural fidelity round-trip
// **Validates: Requirements 5.1, 3.1–3.15**
// ---------------------------------------------------------------------------

/** N-ary operator characters used by the generator, mapped to their LaTeX commands */
const NARY_OPERATORS: Map<string, string> = new Map([
  ['∑', '\\sum'],
  ['∏', '\\prod'],
  ['∫', '\\int'],
]);

/** Accent characters used by the generator, mapped to their LaTeX commands */
const ACCENT_COMMANDS: Map<string, string> = new Map([
  ['\u0302', '\\hat'],
  ['\u0305', '\\bar'],
  ['\u0307', '\\dot'],
  ['\u0303', '\\tilde'],
]);

/** Known function names used by the generator */
const GEN_FUNCTION_NAMES = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim']);

/**
 * Walk an OMML tree and collect the set of construct types present.
 * Returns a set of type strings like 'fraction', 'superscript', etc.
 */
function getConstructTypes(tree: any[]): Set<string> {
  const types = new Set<string>();

  function walk(nodes: any[]): void {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      for (const key of Object.keys(node)) {
        if (key === ':@' || key === '#text') continue;
        switch (key) {
          case 'm:f':       types.add('fraction'); break;
          case 'm:sSup':    types.add('superscript'); break;
          case 'm:sSub':    types.add('subscript'); break;
          case 'm:sSubSup': types.add('subsup'); break;
          case 'm:rad':     types.add('radical'); break;
          case 'm:nary':    types.add('nary'); break;
          case 'm:d':       types.add('delimiter'); break;
          case 'm:acc':     types.add('accent'); break;
          case 'm:m':       types.add('matrix'); break;
          case 'm:func':    types.add('function'); break;
          case 'm:r':       types.add('run'); break;
        }
        // Recurse into children
        if (Array.isArray(node[key])) {
          walk(node[key]);
        }
      }
    }
  }

  walk(tree);
  return types;
}

/**
 * Collect the specific n-ary operator characters present in the tree.
 */
function getNaryChars(tree: any[]): Set<string> {
  const chars = new Set<string>();

  function walk(nodes: any[]): void {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      for (const key of Object.keys(node)) {
        if (key === 'm:nary' && Array.isArray(node[key])) {
          // Look for m:naryPr -> m:chr
          for (const child of node[key]) {
            if (child['m:naryPr'] && Array.isArray(child['m:naryPr'])) {
              for (const prChild of child['m:naryPr']) {
                if (prChild['m:chr'] !== undefined && prChild[':@']) {
                  const val = prChild[':@']['@_m:val'];
                  if (val) chars.add(val);
                }
              }
            }
          }
        }
        if (Array.isArray(node[key])) {
          walk(node[key]);
        }
      }
    }
  }

  walk(tree);
  return chars;
}

/**
 * Collect the specific accent characters present in the tree.
 */
function getAccentChars(tree: any[]): Set<string> {
  const chars = new Set<string>();

  function walk(nodes: any[]): void {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      for (const key of Object.keys(node)) {
        if (key === 'm:acc' && Array.isArray(node[key])) {
          for (const child of node[key]) {
            if (child['m:accPr'] && Array.isArray(child['m:accPr'])) {
              for (const prChild of child['m:accPr']) {
                if (prChild['m:chr'] !== undefined && prChild[':@']) {
                  const val = prChild[':@']['@_m:val'];
                  if (val) chars.add(val);
                }
              }
            }
          }
        }
        if (Array.isArray(node[key])) {
          walk(node[key]);
        }
      }
    }
  }

  walk(tree);
  return chars;
}

/**
 * Collect function names present in m:func nodes.
 */
function getFunctionNames(tree: any[]): Set<string> {
  const names = new Set<string>();

  function walk(nodes: any[]): void {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      for (const key of Object.keys(node)) {
        if (key === 'm:func' && Array.isArray(node[key])) {
          // Look for m:fName -> m:r -> m:t -> #text
          for (const child of node[key]) {
            if (child['m:fName'] && Array.isArray(child['m:fName'])) {
              for (const fnChild of child['m:fName']) {
                if (fnChild['m:r'] && Array.isArray(fnChild['m:r'])) {
                  for (const rChild of fnChild['m:r']) {
                    if (rChild['m:t'] && Array.isArray(rChild['m:t'])) {
                      for (const tChild of rChild['m:t']) {
                        if (tChild['#text']) names.add(String(tChild['#text']));
                      }
                    }
                  }
                }
              }
            }
          }
        }
        if (Array.isArray(node[key])) {
          walk(node[key]);
        }
      }
    }
  }

  walk(tree);
  return names;
}

/**
 * Verify structural fidelity: check that the LaTeX output contains
 * the expected structural markers for each construct type in the input tree.
 */
function verifyStructuralFidelity(tree: any[], latex: string): true | string {
  const types = getConstructTypes(tree);

  if (types.has('fraction') && !latex.includes('\\frac{')) {
    return 'fraction: expected \\frac{ in output';
  }
  if (types.has('superscript') && !latex.includes('^')) {
    return 'superscript: expected ^ in output';
  }
  if (types.has('subscript') && !latex.includes('_')) {
    return 'subscript: expected _ in output';
  }
  if (types.has('radical') && !latex.includes('\\sqrt')) {
    return 'radical: expected \\sqrt in output';
  }
  if (types.has('matrix') && !/\\begin\{(p|b|B|v|V)?matrix\}/.test(latex)) {
    return 'matrix: expected \\begin{*matrix} in output';
  }

  // N-ary: check that each operator character maps to its LaTeX command
  if (types.has('nary')) {
    for (const chr of getNaryChars(tree)) {
      const cmd = NARY_OPERATORS.get(chr);
      if (cmd && !latex.includes(cmd)) {
        return 'nary: expected ' + cmd + ' in output for operator ' + chr;
      }
    }
  }

  // Accents: check that each accent character maps to its LaTeX command
  if (types.has('accent')) {
    for (const chr of getAccentChars(tree)) {
      const cmd = ACCENT_COMMANDS.get(chr);
      if (cmd && !latex.includes(cmd + '{')) {
        return 'accent: expected ' + cmd + '{ in output for accent char';
      }
    }
  }

  // Functions: check for \sin, \cos etc. or \operatorname{name}
  if (types.has('function')) {
    for (const name of getFunctionNames(tree)) {
      if (GEN_FUNCTION_NAMES.has(name)) {
        if (!latex.includes('\\' + name)) {
          return 'function: expected \\' + name + ' in output';
        }
      } else {
        if (!latex.includes('\\operatorname{' + name + '}')) {
          return 'function: expected \\operatorname{' + name + '} in output';
        }
      }
    }
  }

  // Delimiters: the default is ( and ), check for at least one paren pair
  if (types.has('delimiter') && !types.has('fraction') && !types.has('superscript')
      && !types.has('subscript') && !types.has('radical') && !types.has('nary')
      && !types.has('accent') && !types.has('matrix') && !types.has('function')) {
    // Only check when delimiter is the primary construct to avoid false positives
    // from nested constructs that don't produce parens
    if (!latex.includes('(') && !latex.includes('[') && !latex.includes('{')) {
      return 'delimiter: expected delimiter character in output';
    }
  }

  return true;
}

describe('Feature: docx-equation-conversion, Property 4: Structural fidelity round-trip', () => {
  it('non-empty trees produce non-empty LaTeX', () => {
    fc.assert(
      fc.property(ommlTree(), (tree) => {
        const latex = ommlToLatex(tree);
        return latex.length > 0;
      }),
      { numRuns: 100 },
    );
  });

  it('LaTeX output contains structural markers matching input tree constructs', () => {
    fc.assert(
      fc.property(ommlTree(), (tree) => {
        const latex = ommlToLatex(tree);
        const result = verifyStructuralFidelity(tree, latex);
        if (result !== true) {
          return false; // fast-check will report the counter-example
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('balanced braces hold for extended tree generator (with matrix and function)', () => {
    fc.assert(
      fc.property(ommlTree(), (tree) => {
        const latex = ommlToLatex(tree);
        let depth = 0;
        for (const ch of latex) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
          if (depth < 0) return false;
        }
        return depth === 0;
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Unit tests: OMML construct translation
// **Validates: Requirements 3.1–3.14, 6.1, 6.2, 6.3**
// ---------------------------------------------------------------------------

describe('Unit tests: OMML construct translation', () => {

  // --- Fraction (m:f → \frac{num}{den}) --- Req 3.1
  describe('Fraction (m:f)', () => {
    it('translates m:f with m:num and m:den to \\frac{}{}', () => {
      const node = {
        'm:f': [
          { 'm:num': [makeRun('a')] },
          { 'm:den': [makeRun('b')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\frac{a}{b}');
    });
  });

  // --- Superscript (m:sSup → base^sup) --- Req 3.2
  describe('Superscript (m:sSup)', () => {
    it('translates m:sSup to base^sup', () => {
      const node = {
        'm:sSup': [
          { 'm:e': [makeRun('x')] },
          { 'm:sup': [makeRun('2')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('x^2');
    });
    it('emits fallback when m:sSup is missing exponent child', () => {
      const node = {
        'm:sSup': [
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toContain('[UNSUPPORTED: sSup]');
    });
  });

  // --- Subscript (m:sSub → base_sub) --- Req 3.3
  describe('Subscript (m:sSub)', () => {
    it('translates m:sSub to base_sub', () => {
      const node = {
        'm:sSub': [
          { 'm:e': [makeRun('x')] },
          { 'm:sub': [makeRun('i')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('x_i');
    });
    it('emits fallback when m:sSub is missing subscript child', () => {
      const node = {
        'm:sSub': [
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toContain('[UNSUPPORTED: sSub]');
    });
  });

  // --- Sub-superscript (m:sSubSup → base_sub^sup) --- Req 3.4
  describe('Sub-superscript (m:sSubSup)', () => {
    it('translates m:sSubSup to base_sub^sup', () => {
      const node = {
        'm:sSubSup': [
          { 'm:e': [makeRun('x')] },
          { 'm:sub': [makeRun('i')] },
          { 'm:sup': [makeRun('2')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('x_i^2');
    });
    it('emits fallback when m:sSubSup is missing required children', () => {
      const node = {
        'm:sSubSup': [
          { 'm:e': [makeRun('x')] },
          { 'm:sup': [makeRun('2')] },
        ],
      };
      expect(ommlToLatex([node])).toContain('[UNSUPPORTED: sSubSup]');
    });
  });

  // --- Radical (m:rad) --- Req 3.5, 3.6
  describe('Radical (m:rad)', () => {
    it('translates m:rad with degHide=1 to \\sqrt{}', () => {
      const node = {
        'm:rad': [
          { 'm:radPr': [{ 'm:degHide': [], ':@': { '@_m:val': '1' } }] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\sqrt{x}');
    });

    it('translates m:rad with explicit degree to \\sqrt[deg]{}', () => {
      const node = {
        'm:rad': [
          { 'm:deg': [makeRun('3')] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\sqrt[3]{x}');
    });
  });

  // --- N-ary (m:nary) --- Req 3.7
  describe('N-ary (m:nary)', () => {
    it('translates m:nary with ∑ to \\sum_{sub}^{sup}body', () => {
      const node = {
        'm:nary': [
          { 'm:naryPr': [{ 'm:chr': [], ':@': { '@_m:val': '∑' } }] },
          { 'm:sub': [makeRun('i=0')] },
          { 'm:sup': [makeRun('n')] },
          { 'm:e': [makeRun('i')] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toContain('\\sum');
      expect(result).toContain('_{i=0}');
      expect(result).toContain('^n');
      expect(result).toContain('i');
    });

    it('omits empty superscript when m:sup is absent or empty', () => {
      const node = {
        'm:nary': [
          { 'm:naryPr': [
            { 'm:chr': [], ':@': { '@_m:val': '∑' } },
            { 'm:limLoc': [], ':@': { '@_m:val': 'undOvr' } },
          ]},
          { 'm:sub': [makeRun('w')] },
          { 'm:sup': [] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toBe('\\sum\\limits_wx');
      expect(result).not.toContain('^');
    });

    it('omits empty subscript when m:sub is absent or empty', () => {
      const node = {
        'm:nary': [
          { 'm:naryPr': [{ 'm:chr': [], ':@': { '@_m:val': '∑' } }] },
          { 'm:sub': [] },
          { 'm:sup': [makeRun('n')] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toBe('\\sum^nx');
      expect(result).not.toContain('_');
    });

    it('inserts space between operator and alpha body when sub/sup are both empty', () => {
      const node = {
        'm:nary': [
          { 'm:naryPr': [{ 'm:chr': [], ':@': { '@_m:val': '∑' } }] },
          { 'm:sub': [] },
          { 'm:sup': [] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toBe('\\sum x');
    });
  });

  // --- Delimiter (m:d) --- Req 3.8
  describe('Delimiter (m:d)', () => {
    it('translates m:d with default delimiters to (content)', () => {
      const node = {
        'm:d': [
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('(x)');
    });

    it('translates m:d with custom delimiters [content]', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '[' } },
            { 'm:endChr': [], ':@': { '@_m:val': ']' } },
          ]},
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('[x]');
    });

    it('translates m:d with multiple m:e elements joined by separator', () => {
      const node = {
        'm:d': [
          { 'm:e': [makeRun('a')] },
          { 'm:e': [makeRun('b')] },
        ],
      };
      // Default separator is '|'
      expect(ommlToLatex([node])).toBe('(a|b)');
    });
  });

  // --- Accent (m:acc) --- Req 3.10, 3.11
  describe('Accent (m:acc)', () => {
    it('translates m:acc with chr=\\u0302 to \\hat{}', () => {
      const node = {
        'm:acc': [
          { 'm:accPr': [{ 'm:chr': [], ':@': { '@_m:val': '\u0302' } }] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\hat{x}');
    });

    it('translates m:acc with unknown chr to fallback placeholder', () => {
      const node = {
        'm:acc': [
          { 'm:accPr': [{ 'm:chr': [], ':@': { '@_m:val': '?' } }] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toContain('[UNSUPPORTED: acc]');
    });
  });

  // --- Matrix (m:m) --- Req 3.12
  describe('Matrix (m:m)', () => {
    it('translates 2x2 matrix to \\begin{matrix}...\\end{matrix}', () => {
      const node = {
        'm:m': [
          { 'm:mr': [{ 'm:e': [makeRun('a')] }, { 'm:e': [makeRun('b')] }] },
          { 'm:mr': [{ 'm:e': [makeRun('c')] }, { 'm:e': [makeRun('d')] }] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\begin{matrix} a & b \\\\ c & d \\end{matrix}');
    });
  });

  // --- Function (m:func) --- Req 3.13
  describe('Function (m:func)', () => {
    it('translates known function "sin" to \\sin{}', () => {
      const node = {
        'm:func': [
          { 'm:fName': [makeRun('sin')] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\sin{x}');
    });

    it('translates unknown function to \\operatorname{}{}', () => {
      const node = {
        'm:func': [
          { 'm:fName': [makeRun('myFunc')] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\operatorname{myFunc}{x}');
    });
  });

  // --- Calligraphic (m:scr="script" → \mathcal{}) ---
  describe('Calligraphic (m:scr="script")', () => {
    it('translates m:r with m:scr="script" to \\mathcal{}', () => {
      const node = {
        'm:r': [
          { 'm:rPr': [
            { 'm:scr': [{}], ':@': { '@_m:val': 'script' } },
            { 'm:sty': [{}], ':@': { '@_m:val': 'p' } },
          ]},
          { 'm:t': [{ '#text': 'A' }] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\mathcal{A}');
    });
  });

  // --- Error handling --- Req 6.1, 6.2, 6.3
  describe('Error handling', () => {
    it('empty m:oMath produces empty string (Req 6.3)', () => {
      expect(ommlToLatex([])).toBe('');
    });

    it('m:f with no children produces fallback placeholder (Req 6.2)', () => {
      const node = { 'm:f': [] };
      const result = ommlToLatex([node]);
      expect(result).toContain('[UNSUPPORTED: f]');
    });

    it('unknown m:xyz element produces fallback placeholder (Req 6.1)', () => {
      const node = { 'm:xyz': [{ '#text': 'hello' }] };
      const result = ommlToLatex([node]);
      expect(result).toContain('[UNSUPPORTED: xyz]');
    });
  });

  // --- Equation array (m:eqArr) ---
  describe('Equation array (m:eqArr)', () => {
    it('translates m:eqArr with & alignment to \\begin{aligned}', () => {
      const node = {
        'm:eqArr': [
          { 'm:e': [makeRun('a'), makeRun('&'), makeRun('='), makeRun('b')] },
          { 'm:e': [makeRun('c'), makeRun('&'), makeRun('='), makeRun('d')] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toContain('\\begin{aligned}');
      expect(result).toContain('\\end{aligned}');
      expect(result).toContain('&');
      expect(result).toContain('\\\\');
    });

    it('translates m:eqArr without & to \\begin{gathered}', () => {
      const node = {
        'm:eqArr': [
          { 'm:e': [makeRun('a'), makeRun('+'), makeRun('b')] },
          { 'm:e': [makeRun('c'), makeRun('+'), makeRun('d')] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toContain('\\begin{gathered}');
      expect(result).toContain('\\end{gathered}');
    });
  });

  // --- Delimiter-wrapped matrix variants ---
  describe('Delimiter-wrapped matrix variants', () => {
    it('parens + m:m → \\begin{pmatrix}', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '(' } },
            { 'm:endChr': [], ':@': { '@_m:val': ')' } },
          ]},
          { 'm:e': [{
            'm:m': [
              { 'm:mr': [{ 'm:e': [makeRun('a')] }, { 'm:e': [makeRun('b')] }] },
              { 'm:mr': [{ 'm:e': [makeRun('c')] }, { 'm:e': [makeRun('d')] }] },
            ],
          }] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
    });

    it('brackets + m:m → \\begin{bmatrix}', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '[' } },
            { 'm:endChr': [], ':@': { '@_m:val': ']' } },
          ]},
          { 'm:e': [{
            'm:m': [
              { 'm:mr': [{ 'm:e': [makeRun('1')] }, { 'm:e': [makeRun('0')] }] },
            ],
          }] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\begin{bmatrix} 1 & 0 \\end{bmatrix}');
    });

    it('braces + m:m → \\begin{Bmatrix}', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '{' } },
            { 'm:endChr': [], ':@': { '@_m:val': '}' } },
          ]},
          { 'm:e': [{
            'm:m': [
              { 'm:mr': [{ 'm:e': [makeRun('x')] }] },
            ],
          }] },
        ],
      };
      expect(ommlToLatex([node])).toContain('\\begin{Bmatrix}');
    });

    it('pipes + m:m → \\begin{vmatrix}', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '|' } },
            { 'm:endChr': [], ':@': { '@_m:val': '|' } },
          ]},
          { 'm:e': [{
            'm:m': [
              { 'm:mr': [{ 'm:e': [makeRun('a')] }, { 'm:e': [makeRun('b')] }] },
            ],
          }] },
        ],
      };
      expect(ommlToLatex([node])).toContain('\\begin{vmatrix}');
    });

    it('double-bar + m:m → \\begin{Vmatrix}', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '\u2016' } },
            { 'm:endChr': [], ':@': { '@_m:val': '\u2016' } },
          ]},
          { 'm:e': [{
            'm:m': [
              { 'm:mr': [{ 'm:e': [makeRun('a')] }] },
            ],
          }] },
        ],
      };
      expect(ommlToLatex([node])).toContain('\\begin{Vmatrix}');
    });
  });

  // --- Cases pattern detection ---
  describe('Cases pattern detection', () => {
    it('lbrace + empty end + eqArr → \\begin{cases}', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '{' } },
            { 'm:endChr': [], ':@': { '@_m:val': '' } },
          ]},
          { 'm:e': [{
            'm:eqArr': [
              { 'm:e': [makeRun('x+1'), makeRun('&'), makeRun('x>0')] },
              { 'm:e': [makeRun('0'), makeRun('&'), makeRun('otherwise')] },
            ],
          }] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toContain('\\begin{cases}');
      expect(result).toContain('\\end{cases}');
      expect(result).toContain('\\\\');
    });
  });

  // --- Binom (noBar fraction in parens) ---
  describe('Binom pattern detection', () => {
    it('parens + noBar fraction → \\binom{}{}', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '(' } },
            { 'm:endChr': [], ':@': { '@_m:val': ')' } },
          ]},
          { 'm:e': [{
            'm:f': [
              { 'm:fPr': [{ 'm:type': [], ':@': { '@_m:val': 'noBar' } }] },
              { 'm:num': [makeRun('n')] },
              { 'm:den': [makeRun('k')] },
            ],
          }] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\binom{n}{k}');
    });
  });

  // --- borderBox (m:borderBox → \boxed{}) ---
  describe('BorderBox (m:borderBox)', () => {
    it('translates m:borderBox to \\boxed{}', () => {
      const node = {
        'm:borderBox': [
          { 'm:e': [makeRun('E'), makeRun('='), makeRun('m'), {
            'm:sSup': [
              { 'm:e': [makeRun('c')] },
              { 'm:sup': [makeRun('2')] },
            ],
          }] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toContain('\\boxed{');
      expect(result).toContain('E');
    });
  });

  // --- limLow (m:limLow → \underset{}{}) ---
  describe('LimLow (m:limLow)', () => {
    it('translates m:limLow to \\underset{}{}', () => {
      const node = {
        'm:limLow': [
          { 'm:e': [makeRun('A')] },
          { 'm:lim': [makeRun('n')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\underset{n}{A}');
    });
  });

  // --- limUpp (m:limUpp → \overset{}{}) ---
  describe('LimUpp (m:limUpp)', () => {
    it('translates m:limUpp to \\overset{}{}', () => {
      const node = {
        'm:limUpp': [
          { 'm:e': [makeRun('=')] },
          { 'm:lim': [makeRun('?')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\overset{?}{=}');
    });
  });

  // --- bar (m:bar → \overline{} / \underline{}) ---
  describe('Bar (m:bar)', () => {
    it('translates m:bar with default pos to \\overline{}', () => {
      const node = {
        'm:bar': [
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\overline{x}');
    });

    it('translates m:bar with pos=bot to \\underline{}', () => {
      const node = {
        'm:bar': [
          { 'm:barPr': [{ 'm:pos': [], ':@': { '@_m:val': 'bot' } }] },
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\underline{x}');
    });
  });

  // --- groupChr (m:groupChr → \overbrace{} / \underbrace{}) ---
  describe('GroupChr (m:groupChr)', () => {
    it('translates m:groupChr with ⏞ to \\overbrace{}', () => {
      const node = {
        'm:groupChr': [
          { 'm:groupChrPr': [
            { 'm:chr': [], ':@': { '@_m:val': '\u23DE' } },
            { 'm:pos': [], ':@': { '@_m:val': 'top' } },
          ]},
          { 'm:e': [makeRun('x'), makeRun('+'), makeRun('y')] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toContain('\\overbrace{');
    });

    it('translates m:groupChr with ⏟ to \\underbrace{}', () => {
      const node = {
        'm:groupChr': [
          { 'm:groupChrPr': [
            { 'm:chr': [], ':@': { '@_m:val': '\u23DF' } },
            { 'm:pos': [], ':@': { '@_m:val': 'bot' } },
          ]},
          { 'm:e': [makeRun('a'), makeRun('+'), makeRun('b')] },
        ],
      };
      const result = ommlToLatex([node]);
      expect(result).toContain('\\underbrace{');
    });
  });

  // --- Null delimiter handling ---
  describe('Null delimiter (empty begChr/endChr)', () => {
    it('empty begChr with | endChr emits content with just endChr', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '' } },
            { 'm:endChr': [], ':@': { '@_m:val': '|' } },
          ]},
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('x|');
    });

    it('( begChr with empty endChr emits content with just begChr', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '(' } },
            { 'm:endChr': [], ':@': { '@_m:val': '' } },
          ]},
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('(x');
    });

    it('both delimiters empty emits bare content', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '' } },
            { 'm:endChr': [], ':@': { '@_m:val': '' } },
          ]},
          { 'm:e': [makeRun('x')] },
        ],
      };
      expect(ommlToLatex([node])).toBe('x');
    });
  });

  // --- Pmod round-trip detection ---
  describe('Pmod pattern detection', () => {
    it('parens wrapping \\mathrm{mod} + space + arg → \\pmod{}', () => {
      const node = {
        'm:d': [
          { 'm:dPr': [
            { 'm:begChr': [], ':@': { '@_m:val': '(' } },
            { 'm:endChr': [], ':@': { '@_m:val': ')' } },
          ]},
          { 'm:e': [
            makeRun('mod', 'p'),
            makeRun('\u2005'),
            makeRun('p'),
          ] },
        ],
      };
      expect(ommlToLatex([node])).toBe('\\pmod{p}');
    });
  });
});
