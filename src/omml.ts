// src/omml.ts — OMML-to-LaTeX translation module
// Implementation note: fast-xml-parser (with processEntities: true, the default)
// automatically unescapes XML entities in <m:t> text content, so parsed strings
// already contain literal characters (e.g. &amp; → &).

// ---------------------------------------------------------------------------
// fast-xml-parser preserve-order structures
// ---------------------------------------------------------------------------

export type XmlScalar = string;
export type XmlAttributes = Record<string, XmlScalar | undefined>;
export type XmlValue = XmlScalar | XmlAttributes | XmlNode[];

/** Recursive shape produced by fast-xml-parser with preserveOrder enabled. */
export interface XmlNode {
  ':@'?: XmlAttributes;
  [key: string]: XmlValue | undefined;
}

function isXmlNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize a preserve-order element value to its child-node array. */
export function asXmlNodes(value: unknown): XmlNode[] {
  if (Array.isArray(value)) {
    // Fast path: preserve-order parser output is arrays of element nodes, so
    // the near-universal case is "already all nodes" — return the original
    // reference and skip allocating a filtered copy. Fall back to filter() only
    // when a non-node element (primitive/text-only) is actually present.
    return value.every(isXmlNode) ? (value as XmlNode[]) : value.filter(isXmlNode);
  }
  return isXmlNode(value) ? [value] : [];
}

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

const UNICODE_LATEX_MAP: Map<string, string> = new Map([
  // Greek lowercase
  ['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'],
  ['ϵ', '\\epsilon'], ['ε', '\\varepsilon'], ['ζ', '\\zeta'], ['η', '\\eta'], ['θ', '\\theta'], ['ϑ', '\\vartheta'],
  ['ι', '\\iota'], ['κ', '\\kappa'], ['λ', '\\lambda'], ['μ', '\\mu'],
  ['ν', '\\nu'], ['ξ', '\\xi'], ['π', '\\pi'], ['ϖ', '\\varpi'], ['ρ', '\\rho'], ['ϱ', '\\varrho'],
  ['σ', '\\sigma'], ['ς', '\\varsigma'], ['τ', '\\tau'], ['υ', '\\upsilon'], ['ϕ', '\\phi'], ['φ', '\\varphi'],
  ['χ', '\\chi'], ['ψ', '\\psi'], ['ω', '\\omega'],
  // Greek uppercase
  ['Γ', '\\Gamma'], ['Δ', '\\Delta'], ['Θ', '\\Theta'], ['Λ', '\\Lambda'],
  ['Ξ', '\\Xi'], ['Π', '\\Pi'], ['Σ', '\\Sigma'], ['Υ', '\\Upsilon'], ['Φ', '\\Phi'],
  ['Ψ', '\\Psi'], ['Ω', '\\Omega'],
  // Operators and symbols
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
  ['⋱', '\\ddots'], ['⋮', '\\vdots'],
  ['∼', '\\sim'], ['≃', '\\simeq'], ['≡', '\\equiv'], ['≅', '\\cong'],
  ['∝', '\\propto'], ['≪', '\\ll'], ['≫', '\\gg'],
  ['⊆', '\\subseteq'], ['⊇', '\\supseteq'], ['∖', '\\setminus'],
  ['⊥', '\\perp'], ['∘', '\\circ'], ['∗', '\\ast'],
  ['∅', '\\emptyset'], ['ℓ', '\\ell'],
  ['⇔', '\\Leftrightarrow'], ['↦', '\\mapsto'],
  ['⟨', '\\langle'], ['⟩', '\\rangle'], ['‖', '\\|'], ['⊤', '\\top'],
  ['⟹', '\\Longrightarrow'], ['⟸', '\\Longleftarrow'], ['⟺', '\\Longleftrightarrow'], ['⟶', '\\longrightarrow'],
  ['⩽', '\\leqslant'], ['⩾', '\\geqslant'],
  ['⋆', '\\star'], ['†', '\\dagger'], ['‡', '\\ddagger'], ['ℏ', '\\hbar'],
  ['∄', '\\nexists'], ['∋', '\\ni'], ['↑', '\\uparrow'], ['↓', '\\downarrow'],
  ['ℵ', '\\aleph'], ['∠', '\\angle'],
  ['⌊', '\\lfloor'], ['⌋', '\\rfloor'], ['⌈', '\\lceil'], ['⌉', '\\rceil'],
]);

const ACCENT_MAP: Map<string, string> = new Map([
  ['\u0302', '\\hat'],     // combining circumflex
  ['\u0305', '\\bar'],     // combining overline
  ['\u0307', '\\dot'],     // combining dot above
  ['\u0308', '\\ddot'],    // combining diaeresis
  ['\u030C', '\\check'],   // combining caron
  ['\u0303', '\\tilde'],   // combining tilde
  ['\u20D7', '\\vec'],     // combining right arrow above
  ['ˆ', '\\hat'],
  ['¯', '\\bar'],
  ['˙', '\\dot'],
  ['~', '\\tilde'],
  ['→', '\\vec'],
]);

const NARY_MAP: Map<string, string> = new Map([
  ['∑', '\\sum'],
  ['∏', '\\prod'],
  ['∫', '\\int'],
  ['∬', '\\iint'],
  ['∭', '\\iiint'],
  ['∮', '\\oint'],
  ['⋃', '\\bigcup'],
  ['⋂', '\\bigcap'],
]);

const KNOWN_FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth',
  'log', 'ln', 'exp', 'lim', 'max', 'min',
  'sup', 'inf', 'det', 'dim', 'gcd', 'deg',
  'arg', 'hom', 'ker', 'Pr', 'liminf', 'limsup',
]);

/** Functions whose limits go under the name, as in latex-to-omml.ts. */
const LIMIT_FUNCTIONS = new Set(['lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'Pr']);

/** Function names that LaTeX sets with a space, keyed by how Word shows them. */
const SPACED_FUNCTION_NAMES: Map<string, string> = new Map([['lim inf', 'liminf'], ['lim sup', 'limsup']]);

/** m:scr values and the math alphabet commands that produce them. */
const SCRIPT_ALPHABETS: Map<string, string> = new Map([
  ['script', '\\mathcal'], ['double-struck', '\\mathbb'], ['fraktur', '\\mathfrak'],
  ['sans-serif', '\\mathsf'], ['monospace', '\\mathtt'],
]);

/** m:sty values other than p (plain), with the math alphabet commands that produce them. */
const STYLE_ALPHABETS: Map<string, string> = new Map([
  ['b', '\\mathbf'], ['bi', '\\boldsymbol'], ['i', '\\mathit'],
]);

/** Property/control tags that should be silently skipped during translation. */
const SKIP_TAGS = new Set([
  'm:rPr', 'm:ctrlPr', 'm:fPr', 'm:sSupPr', 'm:sSubPr',
  'm:sSubSupPr', 'm:radPr', 'm:naryPr', 'm:dPr', 'm:accPr',
  'm:mPr', 'm:funcPr', 'm:borderBoxPr', 'm:barPr', 'm:groupChrPr',
  'm:limLowPr', 'm:limUppPr', 'm:eqArrPr', 'm:sPrePr', 'm:phantPr',
  'w:rPr', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:proofErr',
]);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Extract an attribute from an m:* namespace node.
 * OMML attributes use @_m:val (not @_w:val like WordprocessingML).
 */
export function getOmmlAttr(node: XmlNode | undefined, attr: string): string {
  const value = node?.[':@']?.[`@_m:${attr}`] ?? node?.[':@']?.[`@_${attr}`];
  return value === undefined ? '' : String(value);
}

/** Reserved LaTeX characters that need escaping in plain text context. */
const LATEX_RESERVED = /([#$%&_{}~^\\])/g;

/**
 * Escape reserved LaTeX characters in a plain text string.
 * This is used when emitting literal text into a LaTeX context.
 */
export function escapeLatex(text: string): string {
  return text.replace(LATEX_RESERVED, (_, ch) => {
    switch (ch) {
      case '\\': return '\\textbackslash{}';
      case '~':  return '\\textasciitilde{}';
      case '^':  return '\\textasciicircum{}';
      default:   return `\\${ch}`;
    }
  });
}

/**
 * Map a single character to its LaTeX command if one exists.
 * Characters not in the mapping table are returned unchanged.
 * Multi-character strings are processed character-by-character.
 * With `primeAsCommand`, ′ maps to \prime (for script math). `separator`
 * ends a command before a letter; inside a group such as \mathbf{…} it is
 * `{}`, since a space there exports as a space.
 */
export function unicodeToLatex(text: string, primeAsCommand = false, separator = ' '): string {
  let result = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const mapped = primeAsCommand && ch === '′' ? '\\prime' : UNICODE_LATEX_MAP.get(ch);
    if (mapped) {
      result += mapped;
      // Prevent command-name capture when the next source character is an ASCII
      // letter (e.g. αx -> \alpha x, not \alphax). A control symbol such as \|
      // needs no separator.
      const next = chars[i + 1];
      if (next && /[A-Za-z]/.test(next) && /[A-Za-z]$/.test(mapped)) {
        result += separator;
      }
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Detect whether a text string is a multi-letter run (needs \mathrm{} wrapping).
 * Single ASCII letters, single Unicode-mapped characters, and LaTeX commands
 * are NOT considered multi-letter.
 */
export function isMultiLetter(text: string): boolean {
  // Strip leading/trailing whitespace for the check
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // If it starts with a backslash, it's a LaTeX command — not multi-letter
  if (trimmed.startsWith('\\')) return false;
  // Count actual letter characters (ignoring spaces from unicodeToLatex mapping)
  const letters = trimmed.replace(/\s+/g, '');
  if (letters.length <= 1) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from m:t children.
 * m:t nodes contain #text children with the actual text.
 */
function extractText(children: XmlNode[]): string {
  if (!Array.isArray(children)) return '';
  let text = '';
  for (const child of children) {
    if (child['#text'] !== undefined) {
      text += String(child['#text']);
    } else if (child['m:t']) {
      text += extractText(asXmlNodes(child['m:t']));
    }
  }
  return text;
}

/**
 * Recursively extract all text content from an OMML subtree.
 * Used by fallbackPlaceholder to provide context in error output.
 */
function extractAllText(children: XmlNode[]): string {
  if (!Array.isArray(children)) return '';
  let text = '';
  for (const child of children) {
    if (child['#text'] !== undefined) {
      text += String(child['#text']);
    }
    for (const key of Object.keys(child)) {
      if (key === ':@' || key === '#text') continue;
      const val = child[key];
      if (Array.isArray(val)) {
        text += extractAllText(val);
      }
    }
  }
  return text;
}

/**
 * Find the first child element with the given tag name.
 * Returns the child's children array, or an empty array if not found.
 */
function findChild(children: XmlNode[], tag: string): XmlNode[] {
  if (!Array.isArray(children)) return [];
  for (const child of children) {
    if (child[tag] !== undefined) {
      return asXmlNodes(child[tag]);
    }
  }
  return [];
}

/**
 * Find the first child node (the full object including :@ attributes) with the given tag.
 * Unlike findChild which returns the tag's children array, this returns the node itself
 * so that getOmmlAttr can read its attributes.
 */
function findChildNode(children: XmlNode[], tag: string): XmlNode | undefined {
  if (!Array.isArray(children)) return undefined;
  for (const child of children) {
    if (child[tag] !== undefined) return child;
  }
  return undefined;
}

/**
 * Find ALL child elements with the given tag name.
 * Returns an array of children arrays — one per matching node.
 * Used by translateDelimiter to collect multiple m:e elements.
 */
function findAllChildren(children: XmlNode[], tag: string): XmlNode[][] {
  if (!Array.isArray(children)) return [];
  const results: XmlNode[][] = [];
  for (const child of children) {
    if (child[tag] !== undefined) {
      results.push(asXmlNodes(child[tag]));
    }
  }
  return results;
}

/**
 * Check if the children array contains only the given tag as meaningful content.
 * Ignores :@ attributes and SKIP_TAGS entries.
 */
function isSoleContent(children: XmlNode[], tag: string): boolean {
  if (!Array.isArray(children)) return false;
  let tagFound = false;
  for (const child of children) {
    for (const key of Object.keys(child)) {
      if (key === ':@') continue;
      if (key === tag) { tagFound = true; continue; }
      if (SKIP_TAGS.has(key)) continue;
      return false;
    }
  }
  return tagFound;
}

/**
 * Determine matrix environment name from delimiter characters.
 * Returns null if the delimiter pair doesn't match a known matrix variant.
 */
function getMatrixEnvName(begChr: string, endChr: string): string | null {
  if (begChr === '(' && endChr === ')') return 'pmatrix';
  if (begChr === '[' && endChr === ']') return 'bmatrix';
  if (begChr === '{' && endChr === '}') return 'Bmatrix';
  if (begChr === '|' && endChr === '|') return 'vmatrix';
  if ((begChr === '‖' || begChr === '||') && (endChr === '‖' || endChr === '||')) return 'Vmatrix';
  return null;
}

/**
 * Check if a fraction's children indicate a noBar type (used for binomial).
 */
function isNoBarFraction(fracChildren: XmlNode[]): boolean {
  const pr = findChild(fracChildren, 'm:fPr');
  const typeNode = findChildNode(pr, 'm:type');
  return typeNode !== undefined && getOmmlAttr(typeNode, 'val') === 'noBar';
}

/**
 * Translate matrix content with a specific environment name.
 */
function translateMatrixAsEnv(matrixChildren: XmlNode[], envName: string): string {
  const rows = findAllChildren(matrixChildren, 'm:mr');
  const rowStrings: string[] = [];
  for (const rowChildren of rows) {
    const cells = findAllChildren(rowChildren, 'm:e');
    const cellStrings = cells.map(cell => ommlToLatex(cell));
    rowStrings.push(cellStrings.join(' & '));
  }
  return `\\begin{${envName}} ${rowStrings.join(' \\\\ ')} \\end{${envName}}`;
}

// ---------------------------------------------------------------------------
// Fallback placeholder
// ---------------------------------------------------------------------------

/**
 * Emit a visible fallback placeholder for unsupported or malformed elements.
 * Includes escaped text content for context when available.
 */
function fallbackPlaceholder(tag: string, children: XmlNode[]): string {
  const name = tag.replace('m:', '');
  const textContent = extractAllText(children);
  const escaped = escapeLatex(textContent);
  return `\\text{[UNSUPPORTED: ${name}]${escaped ? ' ' + escaped : ''}}`;
}

// ---------------------------------------------------------------------------
// Math run translator
// ---------------------------------------------------------------------------

/**
 * Translate an m:r (math run) element to LaTeX.
 * Checks m:rPr for m:sty val="p" (plain text → \mathrm{}).
 * Extracts text from m:t children, applies unicodeToLatex mapping.
 * Multi-letter runs are wrapped in \mathrm{} unless already a LaTeX command.
 */
function translateRun(children: XmlNode[]): string {
  if (!Array.isArray(children)) return '';

  // Check m:rPr for m:sty style and m:scr script
  let style = '';
  let script = '';
  for (const child of children) {
    if (child['m:rPr']) {
      const rPr = child['m:rPr'];
      if (Array.isArray(rPr)) {
        for (const prop of rPr) {
          if (prop['m:sty']) {
            style = getOmmlAttr(prop, 'val');
          }
          if (prop['m:scr']) {
            script = getOmmlAttr(prop, 'val');
          }
        }
      }
    }
  }

  // Extract text from m:t nodes
  const text = extractText(children);
  if (!text) return '';
  const preserved = children.some(child => child['m:t'] !== undefined && (child[':@'] as Record<string, string> | undefined)?.['@_xml:space'] === 'preserve');
  return runTextLatex(text, style, script, 'math', preserved);
}

/** Where a run's text goes: into the equation, or into an \operatorname name. */
type RunContext = 'math' | 'name';

/**
 * LaTeX for the text of a math run. The mode, escaping, command separators,
 * and primes for every kind of run are decided here, and latex-to-omml.ts
 * reads each form back in the matching parse mode:
 *
 * - A hidden comment run comes back as its % comment.
 * - A function name is text with its symbols inline, as \operatorname{} allows.
 * - A bare run is math: symbols become commands, and ′ is ' at the base level
 *   and \prime in a script or limit (a raw ′ breaks pdflatex). Reserved
 *   characters stay as they are, since the export keeps math escapes such as
 *   \% and unknown commands as literal text.
 * - An upright run with spaces, apostrophes, or reserved characters is text
 *   (see textModeLatex): \mathrm{} drops spaces and reads ' as a prime.
 * - Any other styled run is math in a group, \mathrm{} or an alphabet such
 *   as \mathbf{}. # $ % & _ { } take a backslash. ~ ^ \ have no math escape,
 *   so a run with one goes in \text{} inside the group. A space at an edge
 *   that xml:space="preserve" keeps goes in \text{} of its own, which keeps
 *   it too, and one without it, which Word drops, stays out of \text{}.
 *
 * In a group, a command ends with {} before a letter, since a space there
 * would export as a space; bare math keeps the readable space.
 */
function runTextLatex(text: string, style: string, script: string, context: RunContext = 'math', preserved = false): string {
  if (text.charAt(0) === '\u200B') return hiddenCommentLatex(text);
  if (context === 'name') return unicodeToLatex(escapeLatex(text), false, '{}');

  const mathLatex = (source: string, separator: string) =>
    unicodeToLatex(source, scriptDepth > 0, separator).replace(/′/g, "'");
  const alphabet = SCRIPT_ALPHABETS.get(script) ?? STYLE_ALPHABETS.get(style);
  const group = alphabet ?? (style === 'p' ? '\\mathrm' : '');
  if (!group) return mathLatex(text, ' ');
  if (!alphabet && /[\s'#$%&_{}~^\\]/.test(text)) return textModeLatex(text);
  // Word drops a space at an edge without xml:space="preserve", and keeps one
  // with it, which goes in \text{}, as \text{} keeps it, beside the math
  const [, lead, core, trail] = /^([ \t\r\n]*)([\s\S]*?)([ \t\r\n]*)$/.exec(text)!;
  if (/[~^\\]/.test(text)) return group + '{\\text{' + escapeLatex(preserved ? text : core) + '}}';
  const math = (source: string) => source ? mathLatex(source.replace(/[#$%&_{}]/g, ch => '\\' + ch), '{}') : '';
  if (!preserved || !(lead || trail)) return group + '{' + math(text) + '}';
  const kept = (space: string) => space ? '\\text{' + space + '}' : '';
  return group + '{' + kept(lead) + math(core) + kept(trail) + '}';
}

/** A hidden comment run (text after a \u200B marker) as its LaTeX comment. */
function hiddenCommentLatex(text: string): string {
  const payload = text.slice(1); // remove \u200B prefix
  const pctIdx = payload.indexOf('%');
  if (pctIdx !== -1) {
    const whitespace = payload.slice(0, pctIdx);
    const afterPct = payload.slice(pctIdx + 1);
    // Line-continuation: nothing between % and \n (or just \n)
    if (afterPct === '\n') {
      return whitespace + '%\n';
    }
    // Regular comment: restore {whitespace}%{comment_text} (includes \n if original had one)
    return whitespace + '%' + afterPct;
  }
  // Fallback: suppress malformed hidden runs (no % found)
  return '';
}

/**
 * LaTeX for normal text in an equation. Math commands are invalid inside
 * \text{}, so characters that map to one sit between the text segments as
 * \mathrm{…}, and reserved characters are escaped. All of it re-exports as
 * plain-style runs.
 */
function textModeLatex(text: string): string {
  let latex = '';
  let prose = '';
  let symbols = '';
  const flush = () => {
    if (prose) latex += '\\text{' + escapeLatex(prose) + '}';
    if (symbols) latex += '\\mathrm{' + unicodeToLatex(symbols) + '}';
    prose = '';
    symbols = '';
  };
  for (const ch of text) {
    if (UNICODE_LATEX_MAP.has(ch)) {
      if (prose) flush();
      symbols += ch;
    } else {
      if (symbols) flush();
      prose += ch;
    }
  }
  flush();
  return latex;
}


// ---------------------------------------------------------------------------
// Construct translator stubs (to be fully implemented in Tasks 2.1-2.3)
// ---------------------------------------------------------------------------

/**
 * Translate an m:f (fraction) element to LaTeX.
 * Extracts m:num and m:den children, emits \frac{numerator}{denominator}.
 * Falls back to placeholder if required children are missing.
 */
function translateFraction(children: XmlNode[]): string {
  const num = findChild(children, 'm:num');
  const den = findChild(children, 'm:den');
  if (num.length === 0 && den.length === 0) {
    return fallbackPlaceholder('m:f', children);
  }
  const numerator = ommlToLatex(num);
  const denominator = ommlToLatex(den);
  return `\\frac{${numerator}}{${denominator}}`;
}

/**
 * Wrap a script's base in braces only when needed.
 * Single ASCII characters and single-character LaTeX commands pass through bare;
 * multi-char or complex bases get braces.
 */
function scriptBase(latex: string): string {
  if (latex.length === 1) return latex;
  // Single LaTeX command like \alpha
  if (/^\\[a-zA-Z]+$/.test(latex)) return latex;
  // Single LaTeX command with one braced argument like \mathcal{A}. A function
  // such as \sin{x} takes no argument, so it needs the braces: {\sin{x}}^2.
  const command = /^\\([a-zA-Z]+)\{[^{}]*\}$/.exec(latex);
  if (command && !KNOWN_FUNCTIONS.has(command[1])) return latex;
  return '{' + latex + '}';
}

/**
 * Wrap a sub- or superscript in braces unless it is one character or one
 * LaTeX command, as in x^2 or x_\alpha. A command with an argument keeps its
 * braces, \tau_{\mathrm{age}} rather than \tau_\mathrm{age}, as LaTeX is
 * usually written.
 */
function scriptArg(latex: string): string {
  return latex.length === 1 || /^\\[a-zA-Z]+$/.test(latex) ? latex : '{' + latex + '}';
}

/**
 * Translate an m:sSup (superscript) element to LaTeX.
 * Extracts m:e (base) and m:sup, emits {base}^{sup}.
 * Falls back to placeholder if required children are missing.
 */
function translateSuperscript(children: XmlNode[]): string {
  const base = findChild(children, 'm:e');
  const sup = findChild(children, 'm:sup');
  if (base.length === 0 || sup.length === 0) {
    return fallbackPlaceholder('m:sSup', children);
  }
  const baseLatex = ommlToLatex(base);
  const supLatex = scriptToLatex(sup);
  return scriptBase(baseLatex) + '^' + scriptArg(supLatex);
}

/** Nesting depth of scripts and limits being translated; translateRun reads it. */
let scriptDepth = 0;

/**
 * Translate a script or limit (sub, sup, n-ary limit, or the label above or
 * below a base), with its math-run primes as \prime (see translateRun).
 */
function scriptToLatex(script: XmlNode[]): string {
  scriptDepth++;
  try {
    return ommlToLatex(script);
  } finally {
    scriptDepth--;
  }
}

/**
 * Translate an m:sSub (subscript) element to LaTeX.
 * Extracts m:e (base) and m:sub, emits {base}_{sub}.
 * Falls back to placeholder if required children are missing.
 */
function translateSubscript(children: XmlNode[]): string {
  const base = findChild(children, 'm:e');
  const sub = findChild(children, 'm:sub');
  if (base.length === 0 || sub.length === 0) {
    return fallbackPlaceholder('m:sSub', children);
  }
  const baseLatex = ommlToLatex(base);
  const subLatex = scriptToLatex(sub);
  return scriptBase(baseLatex) + '_' + scriptArg(subLatex);
}

/**
 * Translate an m:sSubSup (sub-superscript) element to LaTeX.
 * Extracts m:e (base), m:sub, and m:sup, emits {base}_{sub}^{sup}.
 * Falls back to placeholder if required children are missing.
 */
function translateSubSup(children: XmlNode[]): string {
  const base = findChild(children, 'm:e');
  const sub = findChild(children, 'm:sub');
  const sup = findChild(children, 'm:sup');
  if (base.length === 0 || sub.length === 0 || sup.length === 0) {
    return fallbackPlaceholder('m:sSubSup', children);
  }
  const baseLatex = ommlToLatex(base);
  const subLatex = scriptToLatex(sub);
  const supLatex = scriptToLatex(sup);
  return scriptBase(baseLatex) + '_' + scriptArg(subLatex) + '^' + scriptArg(supLatex);
}

/**
 * Translate an m:rad (radical) element to LaTeX.
 * Reads m:radPr for m:degHide. If degree is hidden or empty, emits \sqrt{radicand}.
 * Otherwise emits \sqrt[degree]{radicand}.
 */
function translateRadical(children: XmlNode[]): string {
  const pr = findChild(children, 'm:radPr');
  const degHideNode = findChildNode(pr, 'm:degHide');
  const degHide = getOmmlAttr(degHideNode, 'val') === '1';

  const radicand = ommlToLatex(findChild(children, 'm:e'));

  if (degHide) {
    return `\\sqrt{${radicand}}`;
  }

  const degree = ommlToLatex(findChild(children, 'm:deg'));
  if (!degree) {
    return `\\sqrt{${radicand}}`;
  }
  return `\\sqrt[${degree}]{${radicand}}`;
}


/**
 * Translate an m:nary (n-ary operator) element to LaTeX.
 * Reads m:naryPr for m:chr (default ∫), m:limLoc (default subSup),
 * m:subHide, m:supHide. Emits operator with limits and body.
 */
function translateNary(children: XmlNode[]): string {
  const pr = findChild(children, 'm:naryPr');

  // Read operator character (default ∫ per ECMA-376)
  const chrNode = findChildNode(pr, 'm:chr');
  const chr = getOmmlAttr(chrNode, 'val') || '∫';

  // Read limit location (default subSup)
  const limLocNode = findChildNode(pr, 'm:limLoc');
  const limLoc = getOmmlAttr(limLocNode, 'val') || 'subSup';

  // Read hide flags
  const subHideNode = findChildNode(pr, 'm:subHide');
  const subHide = getOmmlAttr(subHideNode, 'val') === '1';
  const supHideNode = findChildNode(pr, 'm:supHide');
  const supHide = getOmmlAttr(supHideNode, 'val') === '1';

  // Map operator character to LaTeX command
  const op = NARY_MAP.get(chr) || chr;
  const limits = limLoc === 'undOvr' ? '\\limits' : '';

  const subLatex = scriptToLatex(findChild(children, 'm:sub'));
  const supLatex = scriptToLatex(findChild(children, 'm:sup'));
  const sub = (subHide || !subLatex) ? '' : '_' + scriptArg(subLatex);
  const sup = (supHide || !supLatex) ? '' : '^' + scriptArg(supLatex);
  const body = ommlToLatex(findChild(children, 'm:e'));
  // Export takes a leading bracket group as the whole body, so brace a body
  // that is more than that group (Word's ∏ over (1-x)y) to keep the rest inside.
  const bracketed = /^(?:[([]|\\left(?![A-Za-z]))/.test(body);
  return appendLatex(op + limits + sub + sup, bracketed && !isBracketGroup(body) ? '{' + body + '}' : body);
}

/**
 * Whether `latex` is one ( or [ group, or one \left…\right pair, which export
 * reads back whole after a function name or an n-ary operator. It reads the
 * group as export's parseBracketedOperand does: braces, environments and
 * \left…\right pairs inside it are opaque, an & or \\ outside them leaves
 * it unclosed, and comments don't count.
 */
function isBracketGroup(latex: string): boolean {
  if (/^\\left(?![A-Za-z])/.test(latex)) return leftRightGroupEnd(latex) === latex.length;
  const open = latex.charAt(0);
  const close = open === '(' ? ')' : open === '[' ? ']' : '';
  if (!close) return false;
  let depth = 0;
  let nesting = 0;
  for (let i = 0; i < latex.length; i++) {
    const ch = latex.charAt(i);
    if (ch === '\\') {
      const command = /^\\(?:[A-Za-z]+|[\s\S]?)/.exec(latex.slice(i))![0];
      i += command.length - 1;
      if (command === '\\begin' || command === '\\left') {
        nesting++;
      } else if (command === '\\end' || command === '\\right') {
        if (nesting === 0) return false;
        nesting--;
        // The character after \right is its delimiter, not a bracket.
        if (command === '\\right' && !/^[\\{}^_&%]/.test(latex.slice(i + 1))) i++;
      } else if (command === '\\\\' && nesting === 0) {
        return false;
      }
    } else if (ch === '%') {
      i = latex.indexOf('\n', i);
      if (i < 0) return false;
    } else if (ch === '{') {
      nesting++;
    } else if (ch === '}') {
      if (nesting === 0) return false;
      nesting--;
    } else if (nesting === 0) {
      if (ch === '&') return false;
      if (ch === open) {
        depth++;
      } else if (ch === close && --depth === 0) {
        return i === latex.length - 1;
      }
    }
  }
  return false;
}

/** The index just past the \left…\right pair that opens `latex`, or undefined if it never closes. */
function leftRightGroupEnd(latex: string): number | undefined {
  let depth = 0;
  for (let i = 0; i < latex.length; i++) {
    if (latex.charAt(i) === '%') {
      i = latex.indexOf('\n', i);
      if (i < 0) return undefined;
      continue;
    }
    if (latex.charAt(i) !== '\\') continue;
    const command = /^\\(?:[A-Za-z]+|[\s\S]?)/.exec(latex.slice(i))![0];
    i += command.length;
    if (command === '\\left') {
      depth++;
    } else if (command === '\\right' && --depth === 0) {
      // Skip the closing delimiter: a command such as \rangle, or one character.
      const delimiter = /^(?:\\(?:[A-Za-z]+|.)|.)?/.exec(latex.slice(i))![0];
      return i + delimiter.length;
    }
    i--;
  }
  return undefined;
}


/**
 * Translate an m:d (delimiter) element to LaTeX.
 * Reads m:dPr for m:begChr (default '('), m:endChr (default ')'),
 * m:sepChr (default '|'). Collects all m:e children and joins with separator.
 */
function translateDelimiter(children: XmlNode[]): string {
  const pr = findChild(children, 'm:dPr');

  const begChrNode = findChildNode(pr, 'm:begChr');
  const begChr = begChrNode !== undefined ? getOmmlAttr(begChrNode, 'val') : '(';
  const endChrNode = findChildNode(pr, 'm:endChr');
  const endChr = endChrNode !== undefined ? getOmmlAttr(endChrNode, 'val') : ')';
  const sepChrNode = findChildNode(pr, 'm:sepChr');
  const sepChr = sepChrNode !== undefined ? getOmmlAttr(sepChrNode, 'val') : '|';

  const elements = findAllChildren(children, 'm:e');

  // Check for special patterns when single m:e element
  if (elements.length === 1) {
    const eChildren = elements[0];

    // Cases: { + empty end + single eqArr
    if (begChr === '{' && endChr === '') {
      const eqArrChildren = findChild(eChildren, 'm:eqArr');
      if (eqArrChildren.length > 0 && isSoleContent(eChildren, 'm:eqArr')) {
        const rows = findAllChildren(eqArrChildren, 'm:e');
        const rowStrings = rows.map(rowChildren => ommlToLatex(rowChildren));
        return `\\begin{cases} ${rowStrings.join(' \\\\ ')} \\end{cases}`;
      }
    }

    // Matrix variants: delimiter wrapping single m:m
    const matrixChildren = findChild(eChildren, 'm:m');
    if (matrixChildren.length > 0 && isSoleContent(eChildren, 'm:m')) {
      const envName = getMatrixEnvName(begChr, endChr);
      if (envName) {
        return translateMatrixAsEnv(matrixChildren, envName);
      }
    }

    // Binom: parens wrapping single noBar fraction
    if (begChr === '(' && endChr === ')') {
      const fracChildren = findChild(eChildren, 'm:f');
      if (fracChildren.length > 0 && isSoleContent(eChildren, 'm:f') && isNoBarFraction(fracChildren)) {
        const num = findChild(fracChildren, 'm:num');
        const den = findChild(fracChildren, 'm:den');
        return `\\binom{${ommlToLatex(num)}}{${ommlToLatex(den)}}`;
      }

      // Pmod: parens wrapping \mathrm{mod} + space + argument
      const innerLatex = ommlToLatex(eChildren);
      const pmodMatch = /^\\mathrm\{mod\}\s*(.+)$/.exec(innerLatex);
      if (pmodMatch) {
        return `\\pmod{${pmodMatch[1].trim()}}`;
      }

      // Reuse already-computed innerLatex for default path
      return delimitedLatex(begChr, innerLatex, endChr);
    }
  }

  // Default behavior
  const inner = elements.map(e => ommlToLatex(e)).join(sepChr);
  return delimitedLatex(begChr, inner, endChr);
}

/** The command for a delimiter character that needs one, such as ⟨ or {. */
function delimiterCommand(chr: string): string | undefined {
  return chr === '{' || chr === '}' ? '\\' + chr : UNICODE_LATEX_MAP.get(chr);
}

/**
 * LaTeX for a Word delimiter. Brackets typed as characters import bare, as
 * (x). One that needs a command, such as ⟨, gets \left and \right, since a
 * bare \langle re-exports as text instead of a delimiter.
 */
function delimitedLatex(begChr: string, inner: string, endChr: string): string {
  if (!delimiterCommand(begChr) && !delimiterCommand(endChr)) {
    return begChr + inner + endChr;
  }
  const side = (chr: string) => delimiterCommand(chr) ?? (chr || '.');
  return appendLatex('\\left' + side(begChr), inner) + '\\right' + side(endChr);
}


function translateAccent(children: XmlNode[]): string {
  // Read m:accPr for the accent character
  const pr = findChild(children, 'm:accPr');
  const chrNode = findChildNode(pr, 'm:chr');
  const chr = (chrNode ? getOmmlAttr(chrNode, 'val') : '') || '\u0302'; // default combining circumflex

  const accentCmd = ACCENT_MAP.get(chr);
  if (!accentCmd) {
    // Unknown accent — fallback per Req 3.11
    return fallbackPlaceholder('m:acc', children);
  }

  // Translate the base element
  const base = ommlToLatex(findChild(children, 'm:e'));
  return `${accentCmd}{${base}}`;
}


function translateMatrix(children: XmlNode[]): string {
  // Find all m:mr (matrix row) children
  const rows = findAllChildren(children, 'm:mr');
  const rowStrings: string[] = [];
  for (const rowChildren of rows) {
    // Each row contains m:e cells
    const cells = findAllChildren(rowChildren, 'm:e');
    const cellStrings = cells.map(cell => ommlToLatex(cell));
    rowStrings.push(cellStrings.join(' & '));
  }
  return `\\begin{matrix} ${rowStrings.join(' \\\\ ')} \\end{matrix}`;
}


function translateFunction(children: XmlNode[]): string {
  // Extract function name from m:fName
  const { nameNodes, scripts, limitsUnder } = splitFunctionName(findChild(children, 'm:fName'));
  const nameText = runsText(nameNodes);
  let name: string;
  if (nameText !== undefined) {
    name = SPACED_FUNCTION_NAMES.get(nameText) ?? runTextLatex(nameText, '', '', 'name');
  } else {
    name = ommlToLatex(nameNodes);
    // Strip a single \mathrm{} / \text{} wrapping that translateRun may have added
    const mathrm = /^\\(?:mathrm|text)\{([^{}]*)\}$/.exec(name);
    if (mathrm) {
      name = mathrm[1];
    }
  }

  // Determine the LaTeX command for the function name
  let funcCmd: string;
  if (KNOWN_FUNCTIONS.has(name)) {
    // Scripts placed against the function's default need \limits or \nolimits.
    const placement = scripts && limitsUnder !== LIMIT_FUNCTIONS.has(name)
      ? (limitsUnder ? '\\limits' : '\\nolimits')
      : '';
    funcCmd = `\\${name}${placement}`;
  } else {
    funcCmd = `\\operatorname${limitsUnder ? '*' : ''}{${name}}`;
  }

  // Translate the argument. Export takes a bracket group right after the name
  // as the whole argument, so one that is the whole argument, as in \sin(x),
  // needs no braces.
  const arg = ommlToLatex(findChild(children, 'm:e'));
  return funcCmd + scripts + (isBracketGroup(arg) ? arg : '{' + arg + '}');
}

/** The text of nodes that are all math runs, skipping hidden comment runs; otherwise undefined. */
function runsText(nodes: XmlNode[]): string | undefined {
  let text = '';
  for (const node of nodes) {
    if (Object.keys(node).some(key => SKIP_TAGS.has(key))) continue;
    if (node['m:r'] === undefined) return undefined;
    const runText = extractText(asXmlNodes(node['m:r']));
    if (runText.charAt(0) !== '\u200B') text += runText;
  }
  return text;
}

/**
 * Word keeps a function's scripts in m:fName: m:limLow and m:limUpp put a
 * limit under or over the name (lim, max), m:sSub, m:sSup, and m:sSubSup put
 * scripts beside it (log₂, sin²). Peel them off so the name can be matched.
 */
function splitFunctionName(fName: XmlNode[]): { nameNodes: XmlNode[]; scripts: string; limitsUnder: boolean } {
  const content = fName.filter(node => !Object.keys(node).some(key => SKIP_TAGS.has(key)));
  const node = content.length === 1 ? content[0] : undefined;
  const parts = (key: string) => asXmlNodes(node?.[key]);
  const script = (latex: string) => scriptArg(latex);

  if (node?.['m:limLow'] !== undefined || node?.['m:limUpp'] !== undefined) {
    const key = node['m:limLow'] !== undefined ? 'm:limLow' : 'm:limUpp';
    const inner = splitFunctionName(findChild(parts(key), 'm:e'));
    const lim = scriptToLatex(findChild(parts(key), 'm:lim'));
    const op = key === 'm:limLow' ? '_' : '^';
    return { nameNodes: inner.nameNodes, scripts: inner.scripts + op + script(lim), limitsUnder: true };
  }
  if (node?.['m:sSub'] !== undefined) {
    const sub = scriptToLatex(findChild(parts('m:sSub'), 'm:sub'));
    return { nameNodes: findChild(parts('m:sSub'), 'm:e'), scripts: '_' + script(sub), limitsUnder: false };
  }
  if (node?.['m:sSup'] !== undefined) {
    const sup = scriptToLatex(findChild(parts('m:sSup'), 'm:sup'));
    return { nameNodes: findChild(parts('m:sSup'), 'm:e'), scripts: '^' + script(sup), limitsUnder: false };
  }
  if (node?.['m:sSubSup'] !== undefined) {
    const sub = scriptToLatex(findChild(parts('m:sSubSup'), 'm:sub'));
    const sup = scriptToLatex(findChild(parts('m:sSubSup'), 'm:sup'));
    return {
      nameNodes: findChild(parts('m:sSubSup'), 'm:e'),
      scripts: '_' + script(sub) + '^' + script(sup),
      limitsUnder: false,
    };
  }
  return { nameNodes: fName, scripts: '', limitsUnder: false };
}


/**
 * Translate an m:eqArr (equation array) element to LaTeX.
 * Detects & alignment markers to choose between aligned and gathered.
 */
function translateEqArray(children: XmlNode[]): string {
  const rows = findAllChildren(children, 'm:e');
  const rowStrings: string[] = [];
  let hasAlignment = false;

  for (const rowChildren of rows) {
    const rowLatex = ommlToLatex(rowChildren);
    rowStrings.push(rowLatex);
    if (/(?<!\\)&/.test(rowLatex)) hasAlignment = true;
  }

  const envName = hasAlignment ? 'aligned' : 'gathered';
  return `\\begin{${envName}} ${rowStrings.join(' \\\\ ')} \\end{${envName}}`;
}


/**
 * Translate an m:borderBox element to LaTeX.
 * Emits \boxed{content}.
 */
function translateBorderBox(children: XmlNode[]): string {
  const content = ommlToLatex(findChild(children, 'm:e'));
  return `\\boxed{${content}}`;
}


/**
 * If the element children consist solely of an m:groupChr with the given
 * brace character/position, return its inner content's LaTeX; otherwise null.
 * Used to reconstruct \underbrace{x}_{label} / \overbrace{x}^{label} from
 * the m:limLow/m:limUpp wrapping that latexToOmml emits for labeled braces.
 */
function braceGroupContent(eChildren: XmlNode[], chr: string, pos: string): string | null {
  const groupChildren = findChild(eChildren, 'm:groupChr');
  if (groupChildren.length === 0 || !isSoleContent(eChildren, 'm:groupChr')) return null;
  const pr = findChild(groupChildren, 'm:groupChrPr');
  const chrNode = findChildNode(pr, 'm:chr');
  const actualChr = chrNode ? getOmmlAttr(chrNode, 'val') : '⏞';
  const posNode = findChildNode(pr, 'm:pos');
  const actualPos = getOmmlAttr(posNode, 'val') || 'top';
  if (actualChr !== chr || actualPos !== pos) return null;
  return ommlToLatex(findChild(groupChildren, 'm:e'));
}

/**
 * Translate an m:limLow (lower limit) element to LaTeX.
 * Emits \underbrace{base}_{lim} when the base is an underbrace group,
 * otherwise \underset{lim}{base}.
 */
function translateLimLow(children: XmlNode[]): string {
  const eChildren = findChild(children, 'm:e');
  const lim = scriptToLatex(findChild(children, 'm:lim'));
  const braceContent = braceGroupContent(eChildren, '⏟', 'bot');
  if (braceContent !== null) {
    return `\\underbrace{${braceContent}}_{${lim}}`;
  }
  const base = ommlToLatex(eChildren);
  return `\\underset{${lim}}{${base}}`;
}


/**
 * Translate an m:limUpp (upper limit) element to LaTeX.
 * Emits \overbrace{base}^{lim} when the base is an overbrace group,
 * otherwise \overset{lim}{base}.
 */
function translateLimUpp(children: XmlNode[]): string {
  const eChildren = findChild(children, 'm:e');
  const lim = scriptToLatex(findChild(children, 'm:lim'));
  const braceContent = braceGroupContent(eChildren, '⏞', 'top');
  if (braceContent !== null) {
    return `\\overbrace{${braceContent}}^{${lim}}`;
  }
  const base = ommlToLatex(eChildren);
  return `\\overset{${lim}}{${base}}`;
}


/**
 * Translate an m:bar element to LaTeX.
 * Checks m:barPr/m:pos for position: bot → \underline, default → \overline.
 */
function translateBar(children: XmlNode[]): string {
  const pr = findChild(children, 'm:barPr');
  const posNode = findChildNode(pr, 'm:pos');
  const pos = getOmmlAttr(posNode, 'val');
  const content = ommlToLatex(findChild(children, 'm:e'));
  if (pos === 'bot') {
    return `\\underline{${content}}`;
  }
  return `\\overline{${content}}`;
}


/**
 * Translate an m:groupChr element to LaTeX.
 * Checks chr and pos to determine overbrace vs underbrace.
 */
function translateGroupChr(children: XmlNode[]): string {
  const pr = findChild(children, 'm:groupChrPr');
  const chrNode = findChildNode(pr, 'm:chr');
  const chr = chrNode ? getOmmlAttr(chrNode, 'val') : '\u23DE';
  const posNode = findChildNode(pr, 'm:pos');
  const pos = getOmmlAttr(posNode, 'val');
  const content = ommlToLatex(findChild(children, 'm:e'));

  if (chr === '\u23DF' || pos === 'bot') {
    return `\\underbrace{${content}}`;
  }
  return `\\overbrace{${content}}`;
}


// ---------------------------------------------------------------------------
// Node dispatch
// ---------------------------------------------------------------------------

/**
 * Append a LaTeX chunk to accumulated output, inserting a separator space when
 * the boundary would merge an alphabetic command with a following letter
 * (e.g. run "∣" + run "m" must become "\mid m", not "\midm"). This is the
 * cross-run counterpart of the guard inside unicodeToLatex(), which can only
 * see letters within a single run.
 */
function appendLatex(acc: string, chunk: string): string {
  if (chunk && /\\[A-Za-z]+$/.test(acc) && /^[A-Za-z]/.test(chunk)) {
    // A \left or \right delimiter such as \rangle ends with {} instead, since
    // the space would export as a space. Other commands keep the space, as
    // Markdown already written with them does.
    return acc + (/\\(?:left|right)\\[A-Za-z]+$/.test(acc) ? '{}' : ' ') + chunk;
  }
  return acc + chunk;
}

/** Dispatch a single parsed node to the appropriate translator. */
function translateNode(node: XmlNode): string {
  let result = '';
  for (const key of Object.keys(node)) {
    if (key === ':@') continue;

    const children = asXmlNodes(node[key]);

    switch (key) {
      case 'm:f':         result += translateFraction(children); break;
      case 'm:sSup':      result += translateSuperscript(children); break;
      case 'm:sSub':      result += translateSubscript(children); break;
      case 'm:sSubSup':   result += translateSubSup(children); break;
      case 'm:rad':       result += translateRadical(children); break;
      case 'm:nary':      result += translateNary(children); break;
      case 'm:d':         result += translateDelimiter(children); break;
      case 'm:acc':       result += translateAccent(children); break;
      case 'm:m':         result += translateMatrix(children); break;
      case 'm:func':      result += translateFunction(children); break;
      case 'm:eqArr':     result += translateEqArray(children); break;
      case 'm:borderBox': result += translateBorderBox(children); break;
      case 'm:limLow':    result += translateLimLow(children); break;
      case 'm:limUpp':    result += translateLimUpp(children); break;
      case 'm:bar':       result += translateBar(children); break;
      case 'm:groupChr':  result += translateGroupChr(children); break;
      case 'm:r':         result = appendLatex(result, translateRun(children)); break;
      case 'm:t':         result = appendLatex(result, extractText(children)); break;
      default:
        if (SKIP_TAGS.has(key)) {
          // Silently skip property/control tags
        } else if (key.startsWith('m:')) {
          result += fallbackPlaceholder(key, children);
        }
        // Unknown non-m: tags are silently ignored
        break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Convert an OMML element's children to a LaTeX string.
 * This is the main entry point called from converter.ts.
 *
 * @param children - The child nodes of an m:oMath or m:oMathPara element
 * @returns LaTeX string (without delimiters)
 */
export function ommlToLatex(children: XmlNode[]): string {
  return ommlChildrenToLatex(children).trim();
}

/** ommlToLatex without the trim, for the content of a tracked change, which
 *  may be only a space such as \quad's em space. */
function ommlChildrenToLatex(children: XmlNode[]): string {
  if (!Array.isArray(children)) return '';
  let result = '';
  // Whether the last markup's content ends with a command
  let markupEndsInCommand = false;
  for (let i = 0; i < children.length; i++) {
    const change = trackedChange(children[i]);
    if (!change) {
      let latex = translateNode(children[i]);
      if (markupEndsInCommand && /^[A-Za-z]/.test(latex)) latex = '{}' + latex;
      if (latex) markupEndsInCommand = false;
      result = appendLatex(result, latex);
      continue;
    }
    let contents: string[];
    const next = trackedChange(children[i + 1]);
    // A substitution needs one author and time, as tryRenderSubstitution in converter.ts requires
    if (change.type === 'w:del' && next?.type === 'w:ins' && next.author === change.author && next.date === change.date) {
      contents = [trackedChangeLatex(change.children), trackedChangeLatex(next.children)];
      i++;
    } else {
      contents = change.type === 'w:ins' ? ['', trackedChangeLatex(change.children)] : [trackedChangeLatex(change.children), ''];
    }
    const [oldLatex, newLatex] = contents;
    const markup = oldLatex && newLatex ? '{~~' + oldLatex + '~>' + newLatex + '~~}'
      : oldLatex ? '{--' + oldLatex + '--}'
        : newLatex ? '{++' + newLatex + '++}' : '';
    if (!markup) continue;
    // Accepting or rejecting the change joins what's on either side of the
    // markup to its content, so {} keeps a command from running into a letter
    // there, as in \alpha{}{++x++}. A space would export as a space in both.
    if (/\\[A-Za-z]+$/.test(result) || (markupEndsInCommand && contents.some(latex => /^[A-Za-z]/.test(latex)))) {
      result += '{}';
    }
    result += markup;
    markupEndsInCommand = contents.some(latex => /\\[A-Za-z]+$/.test(latex));
  }
  return result;
}

/** The LaTeX of a tracked change's content, or '' where it is only runs of
 *  whitespace without xml:space="preserve", which Word drops and so shows as no
 *  change. Export writes one so for the padding of a change such as
 *  {++ \! ++}, whose command Word has no form for (see keepWhitespaceChanges
 *  in latex-to-omml.ts). */
function trackedChangeLatex(children: XmlNode[]): string {
  const runs = children.filter(child => child['#text'] === undefined || String(child['#text']).trim());
  const dropped = runs.length > 0 && runs.every(run => run['m:r'] !== undefined && asXmlNodes(run['m:r']).every(part => {
    if (part['m:t'] === undefined) return part['m:rPr'] !== undefined || part['w:rPr'] !== undefined || (part['#text'] !== undefined && !String(part['#text']).trim());
    const attrs = (part[':@'] ?? {}) as Record<string, string | undefined>;
    return attrs['@_xml:space'] !== 'preserve' && /^[ \t\r\n]*$/.test(extractText(asXmlNodes(part['m:t'])));
  }));
  return dropped ? '' : ommlChildrenToLatex(children);
}

/** A w:ins or w:del inside an equation: Word's record of an edit to it, which
 *  becomes CriticMarkup inside $...$ (see splitCriticMarkupInMath). */
function trackedChange(node: XmlNode | undefined): { type: 'w:ins' | 'w:del'; children: XmlNode[]; author: string; date: string } | undefined {
  if (!node) return undefined;
  const type = node['w:ins'] !== undefined ? 'w:ins' : node['w:del'] !== undefined ? 'w:del' : undefined;
  if (!type) return undefined;
  const attrs = (node[':@'] ?? {}) as Record<string, string | undefined>;
  return { type, children: asXmlNodes(node[type]), author: attrs['@_w:author'] ?? '', date: attrs['@_w:date'] ?? '' };
}
