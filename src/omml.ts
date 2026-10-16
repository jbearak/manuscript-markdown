// src/omml.ts — OMML-to-LaTeX translation module
// Implementation note: fast-xml-parser (with processEntities: true, the default)
// automatically unescapes XML entities in <m:t> text content, so parsed strings
// already contain literal characters (e.g. &amp; → &).

import { xmlOn } from './xml-elements';
import { wordNumbersTag } from './latex-to-omml';

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

/** The commands of NARY_MAP's operators, which take a body rather than an argument */
const NARY_COMMANDS = new Set(NARY_MAP.values());

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

/** Whether an on/off property of an equation, as a radical's m:degHide, is
 *  on: where it's there, with no m:val, as a CT_OnOff's is on without one,
 *  or one that's on (see xmlOn), as Word reads it */
function ommlOn(node: XmlNode | undefined): boolean {
  if (!node) return false;
  const value = getOmmlAttr(node, 'val');
  return value === '' || xmlOn(value);
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
 * The text of a math run's children, with each w:sym's character (see
 * symText), in pieces: the run's own text, and each such character that's
 * reserved in LaTeX, as the Symbol font's % or _, which is a character,
 * not LaTeX syntax. Only translateRun reads a w:sym, so a # or & one
 * shows is never Word's equation number or alignment, as one typed is.
 */
function runPieces(children: XmlNode[]): { text: string; reserved: boolean }[] {
  const pieces: { text: string; reserved: boolean }[] = [];
  for (const child of children) {
    const sym = child['w:sym'] !== undefined;
    const text = sym ? symText(child) : extractText([child]);
    if (!text) continue;
    const reserved = sym && escapeLatex(text) !== text;
    const last = pieces[pieces.length - 1];
    if (last && !last.reserved && !reserved) last.text += text;
    else pieces.push({ text, reserved });
  }
  return pieces;
}

// The Symbol font's characters as Unicode, from its code 0x20 on, after
// Adobe's mapping, \0 where it has none
const SYMBOL_FONT = (
  ' !∀#∃%&∋()∗+,−./' +
  '0123456789:;<=>?' +
  '≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟ' +
  'ΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_' +
  '‾αβχδεφγηιϕκλμνο' +
  'πθρστυϖωξψζ{|}∼\0' +
  '\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0' +
  '\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0' +
  '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓' +
  '°±″≥×∝∂•÷≠≡≈…⏐⎯↵' +
  'ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉' +
  '∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓' +
  '◊⟨®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪' +
  '\0⟩∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭\0'
);

/** The character a w:sym shows, which Word writes for one picked from the
 *  Symbol font, as Unicode, from the font's code, `char`, or undefined for
 *  another font's, as Wingdings, which Unicode doesn't hold */
export function symbolFontCharacter(font: string, char: string): string | undefined {
  if (font.toLowerCase() !== 'symbol') return undefined;
  // In the font's private-use range, at 0xF020, or as the code alone
  const code = parseInt(char, 16) & 0xFF;
  const character = SYMBOL_FONT[code - 0x20];
  return character && character !== '\0' ? character : undefined;
}

/** A w:sym's character in a math run: the Symbol font's as Unicode, or
 *  another's code as it is, which keeps its place in the equation, or
 *  nothing for a code that isn't a character XML can hold */
function symText(node: XmlNode): string {
  const attribute = (name: string) => String(node[':@']?.['@_w:' + name] ?? '');
  const known = symbolFontCharacter(attribute('font'), attribute('char'));
  if (known !== undefined) return known;
  const code = parseInt(attribute('char'), 16);
  const character = code >= 0x20 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
  return /^(?:[\x20-\uD7FF\uE000-\uFFFD]|[\u{10000}-\u{10FFFF}])$/u.test(character) ? character : '';
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
    rowStrings.push(joinLatexParts(cells.map(cell => unbracedToLatex(cell)), ' & '));
  }
  return latexEnvironment(envName, rowStrings);
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
  const escaped = apartFromMarkup(escapeLatex(textContent), true);
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

  // Check m:rPr for m:sty style, m:scr script and m:nor, Word's Normal Text
  let style = '';
  let script = '';
  let normal = false;
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
          if (prop['m:nor']) {
            normal = ommlOn(prop);
          }
        }
      }
    }
  }

  // Extract text from m:t nodes, and w:sym's characters
  const pieces = runPieces(children);
  const text = pieces.map(piece => piece.text).join('');
  if (!text) return '';
  if (isCommentRun(children, text)) return hiddenCommentLatex(text);
  const preserved = children.some(child => child['m:t'] !== undefined && (child[':@'] as Record<string, string> | undefined)?.['@_xml:space'] === 'preserve');
  // Normal Text is text, as an upright run's is, but in the style or
  // alphabet a run gives with it, as before
  const runStyle = normal && !style && !script ? 'p' : style;
  // A reserved character a w:sym shows goes in \text{}, as one typed in an
  // upright run does, where a bare run, of no style or alphabet that
  // runTextLatex writes a group for, would write it as LaTeX syntax. A
  // group escapes it already
  const bare = runStyle !== 'p' && !SCRIPT_ALPHABETS.has(script) && !STYLE_ALPHABETS.has(runStyle);
  if (bare && pieces.some(piece => piece.reserved)) {
    return pieces.map(piece => runTextLatex(piece.text, piece.reserved ? 'p' : runStyle, script, 'math', preserved)).join('');
  }
  return runTextLatex(text, runStyle, script, 'math', preserved);
}

/** Where a run's text goes: into the equation, or into an \operatorname name. */
type RunContext = 'math' | 'name';

/**
 * LaTeX for the text of a math run. The mode, escaping, command separators,
 * and primes for every kind of run are decided here, and latex-to-omml.ts
 * reads each form back in the matching parse mode:
 *
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
/** What math can't hold as it is, which an upright run writes as text (see
 *  textModeLatex): whitespace, ', which math reads as a prime, and the
 *  characters LaTeX reserves */
const TEXT_MODE_CHARACTERS = /[\s'#$%&_{}~^\\]/;

function runTextLatex(text: string, style: string, script: string, context: RunContext = 'math', preserved = false): string {
  if (context === 'name') return unicodeToLatex(escapeLatex(text), false, '{}');

  const mathLatex = (source: string, separator: string) =>
    unicodeToLatex(source, scriptDepth > 0, separator).replace(/′/g, "'");
  const alphabet = SCRIPT_ALPHABETS.get(script) ?? STYLE_ALPHABETS.get(style);
  const group = alphabet ?? (style === 'p' ? '\\mathrm' : '');
  if (!group) return mathLatex(text, ' ');
  if (!alphabet && TEXT_MODE_CHARACTERS.test(text)) return textModeLatex(text);
  // Word drops a space at an edge without xml:space="preserve", and keeps one
  // with it, which goes in \text{}, as \text{} keeps it, beside the math
  const [, lead, core, trail] = /^([ \t\r\n]*)([\s\S]*?)([ \t\r\n]*)$/.exec(text)!;
  if (/[~^\\]/.test(text)) return group + '{\\text{' + apartFromMarkup(escapeLatex(preserved ? text : core), true) + '}}';
  const math = (source: string) => source ? mathLatex(source.replace(/[#$%&_{}]/g, ch => '\\' + ch), '{}') : '';
  if (!preserved || !(lead || trail)) return group + '{' + apartFromMarkup(math(text)) + '}';
  const kept = (space: string) => space ? '\\text{' + space + '}' : '';
  return group + '{' + apartFromMarkup(kept(lead) + math(core) + kept(trail)) + '}';
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
    if (prose) latex += '\\text{' + apartFromMarkup(escapeLatex(prose), true) + '}';
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
 * Extracts m:num and m:den children, emits \frac{numerator}{denominator},
 * or {numerator}/{denominator} for Word's linear or skewed fraction, which
 * export writes back as a linear one, or \genfrac{}{}{0pt}{}{numerator}{denominator}
 * for one without a bar, which KaTeX draws without one, and export writes
 * back as one (see barlessFraction in latex-to-omml.ts). In parentheses
 * alone, it's \binom (see translateDelimiter).
 * Falls back to placeholder if both are missing. An empty one, as Word keeps
 * for \frac{}{}, is {}.
 */
function translateFraction(children: XmlNode[]): string {
  const num = findChild(children, 'm:num');
  const den = findChild(children, 'm:den');
  if (!findChildNode(children, 'm:num') && !findChildNode(children, 'm:den')) {
    return fallbackPlaceholder('m:f', children);
  }
  const numerator = ommlToLatex(num);
  const denominator = ommlToLatex(den);
  const type = getOmmlAttr(findChildNode(findChild(children, 'm:fPr'), 'm:type'), 'val');
  if (type === 'lin' || type === 'skw') return '{' + numerator + '}/{' + denominator + '}';
  if (type === 'noBar') return '\\genfrac{}{}{0pt}{}{' + numerator + '}{' + denominator + '}';
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
  // such as \sin{x} takes no argument, so it needs the braces: {\sin{x}}^2,
  // and so does an n-ary operator's body: {\prod{ab}}^2. So does a brace,
  // as LaTeX reads a script on one as a limit, and export reads a
  // superscript on \overbrace, or a subscript on \underbrace, as its label:
  // {\overbrace{y}}^b is a superscript on the brace
  const command = /^\\([a-zA-Z]+)\{[^{}]*\}$/.exec(latex);
  if (command && !KNOWN_FUNCTIONS.has(command[1]) && !NARY_COMMANDS.has('\\' + command[1])
    && command[1] !== 'overbrace' && command[1] !== 'underbrace') return latex;
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
 * Falls back to placeholder if required children are missing. An empty one,
 * as Word keeps for x^{} or {}^{14}C, is {}.
 */
function translateSuperscript(children: XmlNode[]): string {
  const base = findChild(children, 'm:e');
  const sup = findChild(children, 'm:sup');
  if (!findChildNode(children, 'm:e') || !findChildNode(children, 'm:sup')) {
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
  return inScript(() => ommlToLatex(script));
}

/** `latex()` as a script's or a limit's, where ′ is \prime (see runTextLatex) */
function inScript(latex: () => string): string {
  scriptDepth++;
  try {
    return latex();
  } finally {
    scriptDepth--;
  }
}

/**
 * Translate an m:sSub (subscript) element to LaTeX.
 * Extracts m:e (base) and m:sub, emits {base}_{sub}.
 * Falls back to placeholder if required children are missing. An empty one,
 * as Word keeps for x_{}, is {}.
 */
function translateSubscript(children: XmlNode[]): string {
  const base = findChild(children, 'm:e');
  const sub = findChild(children, 'm:sub');
  if (!findChildNode(children, 'm:e') || !findChildNode(children, 'm:sub')) {
    return fallbackPlaceholder('m:sSub', children);
  }
  const baseLatex = ommlToLatex(base);
  const subLatex = scriptToLatex(sub);
  return scriptBase(baseLatex) + '_' + scriptArg(subLatex);
}

/**
 * Translate an m:sSubSup (sub-superscript) element to LaTeX.
 * Extracts m:e (base), m:sub, and m:sup, emits {base}_{sub}^{sup}.
 * Falls back to placeholder if required children are missing. An empty one,
 * as Word keeps for {}_a^b, is {}.
 */
function translateSubSup(children: XmlNode[]): string {
  const base = findChild(children, 'm:e');
  const sub = findChild(children, 'm:sub');
  const sup = findChild(children, 'm:sup');
  if (!findChildNode(children, 'm:e') || !findChildNode(children, 'm:sub') || !findChildNode(children, 'm:sup')) {
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
  const degHide = ommlOn(degHideNode);

  const radicand = ommlToLatex(findChild(children, 'm:e'));

  if (degHide) {
    return `\\sqrt{${radicand}}`;
  }

  const degree = unbracedToLatex(findChild(children, 'm:deg'));
  if (!degree) {
    return `\\sqrt{${radicand}}`;
  }
  return `\\sqrt[${beforeCloser(degree)}]{${radicand}}`;
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
  const subHide = ommlOn(subHideNode);
  const supHideNode = findChildNode(pr, 'm:supHide');
  const supHide = ommlOn(supHideNode);

  // Map operator character to LaTeX command
  const op = NARY_MAP.get(chr) || chr;
  const limits = limLoc === 'undOvr' ? '\\limits' : '';

  const subLatex = scriptToLatex(findChild(children, 'm:sub'));
  const supLatex = scriptToLatex(findChild(children, 'm:sup'));
  const sub = (subHide || !subLatex) ? '' : '_' + scriptArg(subLatex);
  const sup = (supHide || !supLatex) ? '' : '^' + scriptArg(supLatex);
  const bodyNodes = findChild(children, 'm:e');
  // In braces where it's more than one operand, and kept apart from
  // CriticMarkup there (see apartFromMarkup)
  const body = unbracedToLatex(bodyNodes);
  return appendLatex(op + limits + sub + sup, !body || isOperand(bodyNodes, body) ? body : '{' + beforeCloser(apartFromMarkup(body)) + '}');
}

/**
 * Whether export reads `latex`, the LaTeX of Word's n-ary body `nodes`, back
 * whole as the body: one bracket group, or one piece with its scripts. Word's
 * pieces are its runs and structures, and a body of more, as a and b, needs
 * braces to keep the rest inside. A run is one piece where its LaTeX is one
 * character or command, as \alpha or \|, or a styled group such as
 * \mathrm{ab}, but not two characters such as 12, of which export takes the
 * 1. A delimiter of
 * characters, as |x|, imports bare, and export takes its first | alone.
 * Word's tracked change is one piece where its content is.
 */
function isOperand(nodes: XmlNode[], latex: string): boolean {
  // Export takes a leading bracket group as the whole body, so a body that
  // starts with a bracket is one only if it's that group, not (1-x)y or (
  if (/^(?:[([]|\\left(?![A-Za-z]))/.test(latex)) return isBracketGroup(latex);
  const pieces = nodes.filter(node => Object.keys(node).some(key =>
    key === 'm:r' ? translateRun(asXmlNodes(node[key])) !== ''
      : key === 'w:ins' || key === 'w:del' ? !isDroppedChange(asXmlNodes(node[key]))
        : key === 'm:t' || key.startsWith('m:') && !SKIP_TAGS.has(key)));
  if (pieces.length !== 1) return false;
  const [piece] = pieces;
  // Export reads {}_a^bX as the scripts and then X, and a box's content as
  // that content
  if (piece['m:sPre'] !== undefined) return false;
  const shown = shownContent(piece);
  if (shown) return isOperand(shown, latex);
  if (piece['m:r'] !== undefined || piece['m:t'] !== undefined) return /^(?:[^\\{}]|\\[A-Za-z]+(?:\{[^{}]*\})?|\\[^A-Za-z])$/.test(latex);
  if (piece['m:d'] !== undefined) return latex.startsWith('\\');
  // A linear fraction, {a}/{b}, is three pieces to export
  if (piece['m:f'] !== undefined) return latex.startsWith('\\');
  // Export takes an insertion or deletion as the body where it would take its
  // content, which is the LaTeX in its markup. Translating the content again
  // would take time exponential in the depth of changes in n-ary bodies.
  const change = trackedChange(piece);
  if (!change) return true;
  const markup = /^\{(\+\+|--)([\s\S]*)\1\}$/.exec(latex);
  return markup !== null && isOperand(change.children, markup[2].trim());
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
        return latexEnvironment('cases', rows.map(rowChildren => unbracedToLatex(rowChildren)));
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
      const innerLatex = unbracedToLatex(eChildren);
      const pmodMatch = /^\\mathrm\{mod\}\s*(.+)$/.exec(innerLatex);
      if (pmodMatch) {
        return `\\pmod{${beforeCloser(apartFromMarkup(pmodMatch[1].trim()))}}`;
      }

      // Reuse already-computed innerLatex for default path
      return delimitedLatex(begChr, beforeCloser(bareBracketPart(innerLatex)), endChr);
    }
  }

  // Word's separator between the parts grows with the delimiter, as \middle
  // does, so it comes back as \middle, in \left and \right, which \middle
  // needs, though the brackets would come back bare without it. That takes
  // all three characters as delimiters LaTeX has (see sizedDelimiter). With
  // any other, as a comma, or U+2223, which LaTeX has as the relation \mid,
  // or with neither bracket, where \middle can't go, the separator goes
  // between the parts as it is
  const parts = elements.map(e => beforeCloser(unbracedToLatex(e)));
  const left = sizedDelimiter(begChr);
  const middle = sizedDelimiter(sepChr);
  const right = sizedDelimiter(endChr);
  if (parts.length > 1 && (begChr || endChr) && left && middle && right) {
    const inner = parts.reduce((latex, part) => appendLatex(appendLatex(latex, '\\middle' + middle), part));
    return appendLatex('\\left' + left, inner) + '\\right' + right;
  }
  const bare = !delimiterCommand(begChr) && !delimiterCommand(endChr);
  return delimitedLatex(begChr, (bare ? parts.map(bareBracketPart) : parts).join(sepChr), endChr);
}

/** A part of brackets that import writes bare, as (x), with spacing alone,
 *  which a part's trim writes as its commands (see trimPart), as its
 *  characters, as import writes them within an equation: export reads the
 *  brackets as text, so (\quad) came back as ( ) with an em space */
function bareBracketPart(latex: string): string {
  if (!/^(?:\\(?:qquad|quad|[,;:]))+$/.test(latex)) return latex;
  return latex.replace(/\\(qquad|quad|[,;:])/g, command => command === '\\qquad' ? '\u2003\u2003' : SPACE_CHARACTERS.get(command)!);
}

/** The delimiters \left, \middle and \right take, as delimiterCommand
 *  writes them, which export reads back as the same characters */
const SIZED_DELIMITERS = new Set([
  '(', ')', '[', ']', '|', '/', '\\{', '\\}', '\\|', '\\langle', '\\rangle', '\\lfloor', '\\rfloor', '\\lceil', '\\rceil',
  '\\uparrow', '\\downarrow',
]);

/**
 * A delimiter character as \left, \middle or \right takes it: '.' for none,
 * or undefined for one LaTeX has no delimiter for, as a comma. A '.' typed as
 * the character is one of those, since \left. is none.
 */
function sizedDelimiter(chr: string): string | undefined {
  if (!chr) return '.';
  const latex = delimiterCommand(chr) ?? chr;
  return SIZED_DELIMITERS.has(latex) ? latex : undefined;
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
    rowStrings.push(joinLatexParts(cells.map(cell => unbracedToLatex(cell)), ' & '));
  }
  return latexEnvironment('matrix', rowStrings);
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
    funcCmd = `\\operatorname${limitsUnder ? '*' : ''}{${apartFromMarkup(name)}}`;
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
    if (!isCommentRun(asXmlNodes(node['m:r']), runText)) text += runText;
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
  // Word's equation numbers, in an array that is the equation, not a part
  // of it, in display math
  const numbers = rows.map(row => partDepth === 1 && displayEquation ? rowNumber(row) : undefined);
  const rowStrings: string[] = [];
  let hasAlignment = false;

  rows.forEach((rowChildren, k) => {
    const number = numbers[k];
    let rowLatex = unbracedToLatex(number ? number.equation : rowChildren);
    if (number) rowLatex = rowLatex ? rowLatex + (endsInLatexComment(rowLatex) ? '\n' : ' ') + number.tag : number.tag;
    rowStrings.push(rowLatex);
    if (/(?<!\\)&/.test(rowLatex)) hasAlignment = true;
  });
  if (!numbers.some(Boolean)) return latexEnvironment(hasAlignment ? 'aligned' : 'gathered', rowStrings);

  // A numbered equation is its row and \tag, as LaTeX writes one; numbered
  // rows need an environment that numbers rows, as aligned and gathered
  // don't. Only the array's own &, unescaped in its rows' runs of math
  // before their numbers, aligns them; one in a structure, as in cases, is
  // that structure's, one in text, as \text{A\&B} writes, is text, and one
  // in a number, as of \tag{a\&b}, is the number's.
  const aligned = rows.some((row, k) => (numbers[k]?.equation ?? row).some(node => isMathRun(node) && /(?<!\\)&/.test(extractText(asXmlNodes(node['m:r'])))));
  if (rowStrings.length === 1 && !aligned) return rowStrings[0];
  return latexEnvironment(aligned ? 'align*' : 'gather*', rowStrings);
}

/**
 * Word's equation number at the end of a row of an equation array: a # in
 * a run of math, then (x), as Word builds it up into a delimiter or as
 * characters, which is \tag{x}, or any other text, with such delimiters in
 * it or not, as a(1), which is \tag*{x}, as
 * LaTeX shows it without parentheses (see equationNumberOmml in
 * latex-to-omml.ts), with TeX's special characters in it escaped, as in
 * \text{}, so Word's 50% is \tag{50\%}. The row's children before the #,
 * or undefined where the row has no number. A # in text, as \text{}
 * writes, or escaped, as export writes \#, is none, and so is one with
 * nothing before it to number. Nor is any in a row whose runs of math hold
 * more than one # that isn't escaped, as x#(A#B), where which one starts
 * the number is unclear, or a \tag* that would hold one, as of x#a(A#B)
 * with (A#B) built up, which export drops (see wordNumbersTag in
 * latex-to-omml.ts).
 */
function rowNumber(row: XmlNode[]): { equation: XmlNode[]; tag: string } | undefined {
  const content = row.filter(node => !Object.keys(node).every(key => key === ':@' || SKIP_TAGS.has(key)));
  // The runs of math side by side, as import joins them, so a \ that ends
  // one escapes a # that starts the next
  const mathText = content.map(node => isMathRun(node) ? extractText(asXmlNodes(node['m:r'])) : '\u0000').join('');
  if ((mathText.match(/(?<!\\)(?:\\\\)*#/g) ?? []).length > 1) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]['m:r'] === undefined) continue;
    const text = extractText(asXmlNodes(content[i]['m:r']));
    const at = text.lastIndexOf('#');
    if (at === -1) continue;
    // The run's children before the #, in their order, and its text after
    // it, each with the characters its w:syms show
    const split = splitRun(asXmlNodes(content[i]['m:r']), at);
    const before = shownText(split.before);
    // The text before the #, from the runs of math before it where it
    // starts its run, as Word may write x\#(1) with the \ in one run and
    // #(1) in the next, which import joins as \#
    let preceding = before;
    for (let j = i - 1; preceding === '' && j >= 0 && isMathRun(content[j]); j--) preceding = shownText(asXmlNodes(content[j]['m:r']));
    if (!isMathRun(content[i]) || preceding.endsWith('\\')) return undefined;
    const after = content.slice(i + 1);
    // All of the row after the #, as Word shows it: runs of math, and
    // delimiters of ( and ) around runs, as Word builds (1) up into, in any
    // order, as x#a(1)
    const pieces = after.map(node => isMathRun(node) ? shownText(asXmlNodes(node['m:r'])) : parenthesizedText(node));
    if (pieces.some(piece => piece === undefined)) return undefined;
    const number = split.after + pieces.join('');
    const parenthesized = /^\s*\((.*)\)\s*$/.exec(number);
    if (!wordNumbersTag(parenthesized ? { text: parenthesized[1].trim(), star: false } : { text: number.trim(), star: true })) return undefined;
    // The tag's text is escaped and apart from its braces, as \text{}'s
    // is, so that a number of ++A++ makes no {++ or ++} (see
    // apartFromMarkup)
    const tagText = (text: string) => apartFromMarkup(escapeLatex(text.trim()), true);
    const tag = parenthesized ? '\\tag{' + tagText(parenthesized[1]) + '}' : '\\tag*{' + tagText(number) + '}';
    const equation = content.slice(0, i);
    // Something to number: text, or a structure, as \sum or a delimiter
    if (!before.trim() && !equation.some(node => node['m:r'] === undefined || shownText(asXmlNodes(node['m:r'])).trim())) return undefined;
    if (before) equation.push({ 'm:r': split.before });
    return { equation, tag };
  }
  return undefined;
}

/** The text a math run's children, `run`, show: its own, and each w:sym's
 *  character (see symText), in their order */
function shownText(run: XmlNode[]): string {
  return runPieces(run).map(piece => piece.text).join('');
}

/**
 * A math run's children, `run`, split at the character at `at` in its own
 * text (see extractText), in their order: the children before it, with the
 * m:t it's in cut there, and its properties, and the text after it, with
 * each w:sym's character (see shownText)
 */
function splitRun(run: XmlNode[], at: number): { before: XmlNode[]; after: string } {
  const before: XmlNode[] = [];
  let after = '';
  let offset = 0;
  for (const child of run) {
    const shows = child['m:t'] !== undefined || child['#text'] !== undefined || child['w:sym'] !== undefined;
    if (!shows) {
      before.push(child);
    } else if (offset > at) {
      after += shownText([child]);
    } else if (child['w:sym'] !== undefined) {
      before.push(child);
    } else {
      const text = extractText([child]);
      if (offset + text.length > at) {
        if (at > offset) before.push({ 'm:t': [{ '#text': text.slice(0, at - offset) }] });
        after += text.slice(at - offset + 1);
      } else {
        before.push(child);
      }
      offset += text.length;
    }
  }
  return { before, after };
}

/** The text of a delimiter of ( and ) around runs alone, as (x), or undefined. */
function parenthesizedText(node: XmlNode): string | undefined {
  if (node['m:d'] === undefined) return undefined;
  const children = asXmlNodes(node['m:d']);
  const pr = findChild(children, 'm:dPr');
  const begChr = findChildNode(pr, 'm:begChr');
  const endChr = findChildNode(pr, 'm:endChr');
  if ((begChr ? getOmmlAttr(begChr, 'val') : '(') !== '(' || (endChr ? getOmmlAttr(endChr, 'val') : ')') !== ')') return undefined;
  const elements = findAllChildren(children, 'm:e');
  if (elements.length !== 1) return undefined;
  const runs = elements[0].filter(part => !Object.keys(part).every(key => key === ':@' || SKIP_TAGS.has(key)));
  if (!runs.every(isMathRun)) return undefined;
  return '(' + runs.map(run => shownText(asXmlNodes(run['m:r']))).join('') + ')';
}

/** Whether `node` is a run of math, as Word's # and number are: not normal text, upright, another alphabet or hidden, with an on/off property only where it's on. */
function isMathRun(node: XmlNode): boolean {
  if (node['m:r'] === undefined) return false;
  const run = asXmlNodes(node['m:r']);
  const props = findChild(run, 'm:rPr');
  if (['m:sty', 'm:scr'].some(tag => findChildNode(props, tag)) || ['m:nor', 'm:lit'].some(tag => ommlOn(findChildNode(props, tag)))) return false;
  return !isHiddenRun(run);
}

/**
 * Whether the children of an m:r, `run`, of text `text`, are a hidden
 * comment's run. Export writes one hidden, with a zero-width space first,
 * and older exports wrote it shown, as Normal Text with its %. Any other
 * shown run, as export writes for a zero-width space in the equation, or
 * one before a \% in a style's group, is text.
 */
function isCommentRun(run: XmlNode[], text: string): boolean {
  return text.charAt(0) === '\u200B'
    && (isHiddenRun(run) || ommlOn(findChildNode(findChild(run, 'm:rPr'), 'm:nor')) && text.includes('%'));
}

/** Whether the children of an m:r, `run`, are hidden, with a w:vanish that's on */
function isHiddenRun(run: XmlNode[]): boolean {
  const vanish = findChildNode(findChild(run, 'w:rPr'), 'w:vanish');
  const hidden = vanish?.[':@']?.['@_w:val'];
  return vanish !== undefined && (hidden === undefined || xmlOn(String(hidden)));
}


/** Word's cancels: a border box's strikes, with its sides hidden, and the
 *  LaTeX command for each */
const CANCELS: Map<string, string> = new Map([
  ['m:strikeBLTR', '\\cancel'], ['m:strikeTLBR', '\\bcancel'],
  ['m:strikeBLTR m:strikeTLBR', '\\xcancel'], ['m:strikeH', '\\sout'],
]);

/**
 * Translate an m:borderBox element to LaTeX.
 * Emits \boxed{content}, or Word's cancel, its sides hidden and struck
 * through (see CANCELS), as \cancel{content} and the like.
 */
function translateBorderBox(children: XmlNode[]): string {
  const content = ommlToLatex(findChild(children, 'm:e'));
  const pr = findChild(children, 'm:borderBoxPr');
  const on = (tag: string) => ommlOn(findChildNode(pr, tag));
  const hidden = ['m:hideTop', 'm:hideBot', 'm:hideLeft', 'm:hideRight'].every(on);
  const cancel = hidden ? CANCELS.get(['m:strikeH', 'm:strikeV', 'm:strikeBLTR', 'm:strikeTLBR'].filter(on).join(' ')) : undefined;
  return (cancel ?? '\\boxed') + '{' + content + '}';
}

/**
 * Translate an m:sPre (scripts before a base) element to LaTeX, as the
 * scripts on an empty base and then the base, {}_a^bX, which export reads
 * back as the same scripts before X. No brace is beside the base, which
 * goes on beside what follows, untrimmed, as a box's content does.
 */
function translatePreScripts(children: XmlNode[]): string {
  const sub = scriptToLatex(findChild(children, 'm:sub'));
  const sup = scriptToLatex(findChild(children, 'm:sup'));
  return appendLatex('{}_' + scriptArg(sub) + '^' + scriptArg(sup), ommlChildrenToLatex(findChild(children, 'm:e')));
}

/**
 * The content of an m:box, which Word puts around an operator emulator,
 * as ≝, or a differential, as dx, or of an m:phant Word shows, which LaTeX
 * sets the same without it, with no brace beside it, or undefined for any
 * other node. Import writes it as it writes a tracked change's content,
 * with the spaces at its edges, which Word keeps beside what follows.
 */
function shownContent(node: XmlNode): XmlNode[] | undefined {
  if (node['m:box'] !== undefined) return findChild(asXmlNodes(node['m:box']), 'm:e');
  if (node['m:phant'] === undefined) return undefined;
  const children = asXmlNodes(node['m:phant']);
  const show = findChildNode(findChild(children, 'm:phantPr'), 'm:show');
  return !show || ommlOn(show) ? findChild(children, 'm:e') : undefined;
}

/** `children` with each box or phantom Word shows (see shownContent) as
 *  its content in its place, and pre-scripts as the scripts alone and then
 *  their base (see translatePreScripts), so that what reads its parts in
 *  turn, as a number's spaces or a tracked change's command before a
 *  letter, reads them across its edges */
function unwrapped(children: XmlNode[]): XmlNode[] {
  if (!children.some(child => shownContent(child) !== undefined || child['m:sPre'] !== undefined)) return children;
  const nodes: XmlNode[] = [];
  for (const child of children) {
    const shown = shownContent(child);
    if (shown !== undefined) {
      for (const node of unwrapped(shown)) nodes.push(node);
    } else if (child['m:sPre'] !== undefined) {
      const parts = asXmlNodes(child['m:sPre']);
      nodes.push({ 'm:sPre': parts.filter(part => part['m:e'] === undefined) });
      for (const node of unwrapped(findChild(parts, 'm:e'))) nodes.push(node);
    } else {
      nodes.push(child);
    }
  }
  return nodes;
}

/**
 * Translate an m:phant Word hides to LaTeX: \hphantom{} where it has no
 * height, \vphantom{} where it has no width, and \phantom{} otherwise.
 */
function translatePhantom(children: XmlNode[]): string {
  const pr = findChild(children, 'm:phantPr');
  const zero = (tag: string) => ommlOn(findChildNode(pr, tag));
  const command = zero('m:zeroWid') ? '\\vphantom' : zero('m:zeroAsc') && zero('m:zeroDesc') ? '\\hphantom' : '\\phantom';
  // Spacing alone, which a part's trim drops, is its commands, as \qquad
  const content = ommlToLatex(findChild(children, 'm:e')) || spaceCommands(ommlChildrenToLatex(findChild(children, 'm:e')));
  return command + '{' + content + '}';
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
  const actual = groupChrProps(groupChildren);
  if (actual.chr !== chr || actual.pos !== pos) return null;
  return ommlToLatex(findChild(groupChildren, 'm:e'));
}

/** An m:groupChr's character and position, as ECMA-376 has them where it
 *  leaves them out: U+23DF (⏟) and bot */
function groupChrProps(children: XmlNode[]): { chr: string; pos: string } {
  const pr = findChild(children, 'm:groupChrPr');
  const chrNode = findChildNode(pr, 'm:chr');
  return {
    chr: (chrNode ? getOmmlAttr(chrNode, 'val') : '') || '\u23DF',
    pos: getOmmlAttr(findChildNode(pr, 'm:pos'), 'val') || 'bot',
  };
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
 * Translate an m:groupChr element to LaTeX: its character over or under its
 * content (see groupChrProps for what it has where it says neither). A curly
 * bracket is \overbrace or \underbrace by its character, as export writes
 * them. Any other, as Word's arrows, is \overset or \underset of it by its
 * position, as export has no form for \overrightarrow and the like.
 */
function translateGroupChr(children: XmlNode[]): string {
  const { chr, pos } = groupChrProps(children);
  const content = ommlToLatex(findChild(children, 'm:e'));
  if (chr === '\u23DE') return `\\overbrace{${content}}`;
  if (chr === '\u23DF') return `\\underbrace{${content}}`;
  // As a limit's run of it alone writes it, as \overset and \underset take
  // it as one: math, or text, as an upright run's, where math can't hold it
  // as it is, as \\, & or '
  const mark = inScript(() => runTextLatex(chr, TEXT_MODE_CHARACTERS.test(chr) ? 'p' : '', ''));
  return (pos === 'top' ? '\\overset{' : '\\underset{') + mark + '}{' + content + '}';
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
    // A \left, \middle or \right delimiter such as \rangle ends with {}
    // instead, since the space would export as a space. Other commands keep
    // the space, as Markdown already written with them does.
    return acc + (/\\(?:left|middle|right)\\[A-Za-z]+$/.test(acc) ? '{}' : ' ') + chunk;
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
      case 'm:sPre':      result += translatePreScripts(children); break;
      case 'm:box':
      case 'm:phant': {
        const shown = shownContent(node);
        result = appendLatex(result, shown ? ommlChildrenToLatex(shown) : translatePhantom(children));
        break;
      }
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

/** Nesting depth of ommlToLatex calls: 1 for an equation, more for a part
 *  of a structure in it, such as a script or a fraction's numerator. */
let partDepth = 0;

/** Whether the equation being read is display math, whose equation array
 *  can hold Word's equation numbers (see translateEqArray) */
let displayEquation = false;

/**
 * Convert an OMML element's children to a LaTeX string.
 * This is the main entry point called from converter.ts.
 *
 * A part of a structure is kept apart from CriticMarkup (see
 * apartFromMarkup), as most go in braces; an equation goes in $ and needs
 * nothing, and nor does a part beside no brace (see unbracedToLatex). Its
 * comment at its end keeps its line end (see beforeCloser).
 *
 * @param children - The child nodes of an m:oMath or m:oMathPara element
 * @param display - Whether the equation is display math, as in an
 *   m:oMathPara, where Word's equation numbers are read as \tag; an inline
 *   equation's \tag would be dropped on export
 * @returns LaTeX string (without delimiters)
 */
export function ommlToLatex(children: XmlNode[], display = false): string {
  const outerDisplay = displayEquation;
  // An equation highlighted whole is in a highlight, which converter.ts
  // writes around it (see mathHighlight there), not in {==...==} in it
  const whole = partDepth === 0 && highlightedWhole(children);
  if (partDepth === 0) displayEquation = display;
  if (whole) highlightDepth++;
  partDepth++;
  try {
    const latex = trimPart(ommlChildrenToLatex(children));
    return partDepth > 1 ? beforeCloser(apartFromMarkup(latex)) : latex;
  } finally {
    partDepth--;
    if (whole) highlightDepth--;
    displayEquation = outerDisplay;
  }
}

/**
 * ommlToLatex for a part that no brace is beside: a matrix's cell or a row
 * of cases or an equation array, between spaces and & or \\, a delimiter's
 * content, a root's degree, in [ ], or an n-ary operator's body of one
 * operand. It needs no break, and keeps Word's text as it is, as a row that
 * starts with ~~~, three nonbreaking spaces, does.
 */
function unbracedToLatex(children: XmlNode[]): string {
  partDepth++;
  try {
    return trimPart(ommlChildrenToLatex(children));
  } finally {
    partDepth--;
  }
}

/**
 * `latex` with a break between the two characters of a CriticMarkup
 * delimiter at its start, as ++ of {++, or its end, as ++ of ++}, so that
 * braces around it don't make one: Word's x with a superscript of ++ is
 * x^{+\relax+}, not x^{++}, whose {++ export reads as the start of an
 * insertion, which a ++} later in the document, even in another paragraph,
 * would end, and whose ++} would end one it's in.
 *
 * The break must change neither how TeX sets the characters nor Word's
 * parts. In math it's \relax, which makes no atom and which export skips
 * (see withoutRelax in latex-to-omml.ts). {} would be an empty ordinary atom,
 * which at full size puts space around a relation or binary operator beside
 * it, as in a+{}+b or \mathrm{>{}>}, and which export reads as an operand,
 * even in a script: in x^{\sum^={}=} the sum's body. In `text` mode, which
 * has neither, the break is {}.
 */
function apartFromMarkup(latex: string, text = false): string {
  const between = text ? '{}' : '\\relax';
  return latex
    .replace(/^([+=~>-])(?=\1)/, ch => ch + between)
    .replace(/([+=~<-])(?=\1$)/, ch => ch + between);
}

/** A part's LaTeX without the whitespace at its edges, as before, but with
 *  each space there that export writes for a spacing command written as
 *  that command, as \quad for an em space, since Word shows it. Its
 *  character would end an inline equation there: $2 and an em space reads
 *  as currency. Within the part, import writes the character. Spaces
 *  alone are their commands too, as \quad for an equation, a row or a
 *  script of an em space, which Word shows, and which came back as nothing:
 *  no equation, an empty row or x^{}. Nothing for other spaces alone, as
 *  before, which export reads as no equation. */
function trimPart(latex: string): string {
  const body = latex.trim();
  if (!body) return spaceCommands(latex);
  const before = spaceCommands(latex.slice(0, latex.length - latex.trimStart().length));
  let trailing = latex.slice(latex.trimEnd().length);
  // A comment's spaces, to its line end, are its text, trimmed as before
  const comment = endsInLatexComment(body);
  if (comment) trailing = trailing.slice(trailing.indexOf('\n') + 1 || trailing.length);
  const after = spaceCommands(trailing);
  return (before ? before + ' ' : '') + body + (after && comment ? '\n' : '') + after;
}

/** An inline equation's `latex` with the spaces after a number at its
 *  start that export writes for spacing commands written as those
 *  commands, as 2\quad x: export's math rule reads $, a number and a space
 *  as currency (see findDollarMathAt in math-delimiters.ts), so the
 *  equation with the space's character there was no equation on the next
 *  export. Display math has no currency, and elsewhere import writes the
 *  character. Only where each space is one of those or one LaTeX ignores,
 *  so none is lost, as an en space would be; otherwise as before.
 *
 *  A space or tab right after the number in the text of the equation's
 *  runs, `children`, is written as \ , which export writes as a space, as
 *  in 2\ x. Word shows it, in a run of its own, as export writes \ , or in
 *  the number's, as Word can write 2 x. Export writes a space LaTeX ignores
 *  as a run too, but in Markdown one follows a number there only after
 *  what exports as nothing, as in 2{} x, since $2 and a space read as
 *  currency; \ keeps it an equation. A space of another kind, as a
 *  no-break space, is written as the character after {}, as 2{} x, since
 *  \ would export as a space. */
export function apartFromCurrency(latex: string, children: XmlNode[]): string {
  const [, number, spaces] = /^(\d[\d,.]*)(\s+)/.exec(latex) ?? [];
  if (!spaces) return latex;
  const shown = Math.min(spacesInRunsAfter(number, children), /^[ \t]*/.exec(spaces)![0].length);
  const head = number + '\\ '.repeat(shown);
  const after = spaces.slice(shown);
  const rest = latex.slice(number.length + spaces.length);
  const commands = [...after].every(ch => SPACE_COMMANDS.has(ch) || /[ \t\r\n]/.test(ch)) ? spaceCommands(after) : '';
  if (!commands) return head + (shown ? '' : '{}') + after + rest;
  // A space LaTeX ignores is kept as one, and a command named with letters
  // ends before whatever follows, as a CriticMarkup span whose text would
  // run into it once accepted, as \quad{++x++} would, as \quadx
  const gap = rest && (/[ \t\r\n]/.test(after) || /[A-Za-z]$/.test(commands)) ? ' ' : '';
  return head + commands + gap + rest;
}

/** How many spaces and tabs follow `number` at the start of an equation in
 *  the text of the runs it starts with, in the number's run or in their
 *  own, as 2 x and 2\ x, a box's or a phantom's Word shows too. Runs of
 *  whitespace before the number, which ommlToLatex trims, are skipped. */
function spacesInRunsAfter(number: string, children: XmlNode[]): number {
  let text = '';
  for (const child of unwrapped(children)) {
    if (!('m:r' in child)) break;
    const latex = translateNode(child);
    if (!text && !latex.trim()) continue;
    text += latex;
    // Past the number and the spaces after it
    if (/[^ \t]/.test(text.slice(number.length))) break;
  }
  return text.startsWith(number) ? /^[ \t]*/.exec(text.slice(number.length))![0].length : 0;
}

/** The spaces export writes for \quad, \;, \: and \, (see latex-to-omml.ts) */
const SPACE_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['\u2003', '\\quad'], ['\u2004', '\\;'], ['\u205F', '\\:'], ['\u2009', '\\,'],
]);

/** Each of SPACE_COMMANDS' commands and its space */
const SPACE_CHARACTERS: ReadonlyMap<string, string> = new Map([...SPACE_COMMANDS].map(([space, command]) => [command, space]));

/** The spacing commands for `spaces`, two em spaces as \qquad, and nothing
 *  for a space that has none */
function spaceCommands(spaces: string): string {
  let commands = '';
  for (let i = 0; i < spaces.length; i++) {
    if (spaces.startsWith('\u2003\u2003', i)) {
      commands += '\\qquad';
      i++;
    } else {
      commands += SPACE_COMMANDS.get(spaces[i]) ?? '';
    }
  }
  return commands;
}

/** `latex`, a part of an equation that a closing brace, bracket or
 *  delimiter follows, with a line end after a comment at its end, which
 *  would otherwise hold the closer and what follows it, as x^{a% c}y does.
 *  A part's trim drops the line end Word keeps in the comment's run. */
function beforeCloser(latex: string): string {
  return endsInLatexComment(latex) ? latex + '\n' : latex;
}

/** Whether the last line of `latex` ends in a comment: has a % after no
 *  backslash or an even run of them, as \\% has, but not \% */
export function endsInLatexComment(latex: string): boolean {
  const lineStart = latex.lastIndexOf('\n') + 1;
  for (let at = latex.indexOf('%', lineStart); at !== -1; at = latex.indexOf('%', at + 1)) {
    let backslashes = 0;
    while (at - 1 - backslashes >= lineStart && latex.charCodeAt(at - 1 - backslashes) === 0x5C) backslashes++;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

/** `parts`, an environment's rows or a row's cells, joined by `separator`,
 *  with a line end after each that ends in a comment, which would hold the
 *  separator, as a row of a %c and a row of b, which came back as
 *  a %c \\ b, one row. Word keeps the comment's line end in a hidden run,
 *  but a row's LaTeX is trimmed (see ommlToLatex) */
function joinLatexParts(parts: string[], separator: string): string {
  return parts.map((part, i) => i < parts.length - 1 && endsInLatexComment(part) ? part + '\n' : part).join(separator);
}

/** The environment `name` of `rows` (see joinLatexParts), its \end on a
 *  line of its own after a comment */
function latexEnvironment(name: string, rows: string[]): string {
  const body = joinLatexParts(rows, ' \\\\ ');
  return '\\begin{' + name + '} ' + body + (endsInLatexComment(body) ? '\n' : ' ') + '\\end{' + name + '}';
}

/** ommlToLatex without the trim, for the content of a tracked change, which
 *  may be only a space such as \quad's em space. */
function ommlChildrenToLatex(nodes: XmlNode[]): string {
  if (!Array.isArray(nodes)) return '';
  const children = unwrapped(nodes);
  let result = '';
  // Whether the last markup's content ends with a command
  let markupEndsInCommand = false;
  for (let i = 0; i < children.length; i++) {
    // Word's highlight on part of an equation, on each of its runs, as
    // {==...==} around them, as export writes it (see CRITIC_HIGHLIGHT_COMMAND
    // in latex-to-omml.ts), only where the preview shows it: at an inline
    // equation's top level. The preview splits an inline equation at
    // CriticMarkup, and renders each piece as an equation of its own, which a
    // structure's piece isn't, as \frac{a}{ of \frac{a}{{==b==}}. It leaves
    // display math to VS Code's KaTeX, which would show the markers. Nor is
    // one read around an equation array, whose numbers a highlight would
    // hold, which export doesn't number (see generateTrackedMathXml in
    // md-to-docx-citations.ts). Those aren't read, as before
    if (partDepth === 1 && !displayEquation && highlightDepth === 0 && isHighlightedPart(children[i])) {
      let end = i + 1;
      while (end < children.length && isHighlightedPart(children[end])) end++;
      highlightDepth++;
      let latex: string;
      try {
        latex = ommlChildrenToLatex(children.slice(i, end));
      } finally {
        highlightDepth--;
      }
      i = end - 1;
      if (latex) {
        result += /\\tag\b/.test(latex) ? latex : '{==' + latex + '==}';
        markupEndsInCommand = false;
      }
      continue;
    }
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
    // Export ends a substitution's old text at its first ~>, so one in it is
    // ~\relax>, which TeX sets as ~> (see apartFromMarkup)
    const markup = oldLatex && newLatex ? '{~~' + oldLatex.replace(/~>/g, '~\\relax>') + '~>' + newLatex + '~~}'
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
 *  in latex-to-omml.ts). A highlight in it isn't read, as no span inside an
 *  equation can hold another. */
function trackedChangeLatex(children: XmlNode[]): string {
  if (isDroppedChange(children)) return '';
  highlightDepth++;
  try {
    return ommlChildrenToLatex(children);
  } finally {
    highlightDepth--;
  }
}

/**
 * How deep translation is in a highlight, a tracked change or an equation
 * highlighted whole, where import reads no highlight on part of it, as no
 * span inside an equation can hold another.
 */
let highlightDepth = 0;

/** The highlight colors of the runs of text in `nodes`: each run's w:val,
 *  'none' for a run without one, and 'change' where there's a tracked change */
function runHighlights(nodes: XmlNode[], colors = new Set<string>()): Set<string> {
  for (const node of nodes) for (const key of Object.keys(node)) {
    if (key === ':@' || key === '#text') continue;
    const children = asXmlNodes(node[key]);
    if (key === 'w:ins' || key === 'w:del') colors.add('change');
    if (key !== 'm:r') {
      runHighlights(children, colors);
    } else if (children.some(child => child['m:t'] !== undefined)) {
      const highlight = findChildNode(findChild(children, 'w:rPr'), 'w:highlight');
      colors.add(String(highlight?.[':@']?.['@_w:val'] ?? '') || 'none');
    }
  }
  return colors;
}

/** Whether every run of text in an equation's `children` has a highlight,
 *  of one color, as mathHighlight in converter.ts reads it */
function highlightedWhole(children: XmlNode[]): boolean {
  const colors = runHighlights(children);
  colors.delete('change');
  return colors.size === 1 && !colors.has('none');
}

/** Whether `node` shows only text highlighted in the color of {==...==}: a
 *  run, or a structure whose every run of text is, with no tracked change
 *  and no equation array, whose rows can hold Word's numbers */
function isHighlightedPart(node: XmlNode): boolean {
  const colors = runHighlights([node]);
  return colors.size === 1 && colors.has('yellow') && !holdsEquationArray([node]);
}

/** Whether `nodes` hold an m:eqArr, at any depth */
function holdsEquationArray(nodes: XmlNode[]): boolean {
  return nodes.some(node => Object.keys(node).some(key =>
    key === 'm:eqArr' || (key !== ':@' && key !== '#text' && holdsEquationArray(asXmlNodes(node[key])))));
}

/** Whether a tracked change's content is only runs of whitespace without
 *  xml:space="preserve", which Word drops (see trackedChangeLatex) */
function isDroppedChange(children: XmlNode[]): boolean {
  const runs = children.filter(child => child['#text'] === undefined || String(child['#text']).trim());
  return runs.length > 0 && runs.every(run => run['m:r'] !== undefined && asXmlNodes(run['m:r']).every(part => {
    if (part['m:t'] === undefined) return part['m:rPr'] !== undefined || part['w:rPr'] !== undefined || (part['#text'] !== undefined && !String(part['#text']).trim());
    const attrs = (part[':@'] ?? {}) as Record<string, string | undefined>;
    return attrs['@_xml:space'] !== 'preserve' && /^[ \t\r\n]*$/.test(extractText(asXmlNodes(part['m:t'])));
  }));
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
