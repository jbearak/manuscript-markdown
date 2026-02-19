// src/omml.ts — OMML-to-LaTeX translation module
// Implementation note: fast-xml-parser (with processEntities: true, the default)
// automatically unescapes XML entities in <m:t> text content, so parsed strings
// already contain literal characters (e.g. &amp; → &).

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

const UNICODE_LATEX_MAP: Map<string, string> = new Map([
  // Greek lowercase
  ['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'],
  ['ε', '\\epsilon'], ['ζ', '\\zeta'], ['η', '\\eta'], ['θ', '\\theta'],
  ['ι', '\\iota'], ['κ', '\\kappa'], ['λ', '\\lambda'], ['μ', '\\mu'],
  ['ν', '\\nu'], ['ξ', '\\xi'], ['π', '\\pi'], ['ρ', '\\rho'],
  ['σ', '\\sigma'], ['τ', '\\tau'], ['υ', '\\upsilon'], ['φ', '\\phi'],
  ['χ', '\\chi'], ['ψ', '\\psi'], ['ω', '\\omega'],
  // Greek uppercase
  ['Γ', '\\Gamma'], ['Δ', '\\Delta'], ['Θ', '\\Theta'], ['Λ', '\\Lambda'],
  ['Ξ', '\\Xi'], ['Π', '\\Pi'], ['Σ', '\\Sigma'], ['Φ', '\\Phi'],
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
  ['·', '\\cdot'], ['…', '\\ldots'], ['⋯', '\\cdots'],
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
  'arg', 'hom', 'ker',
]);

/** Property/control tags that should be silently skipped during translation. */
const SKIP_TAGS = new Set([
  'm:rPr', 'm:ctrlPr', 'm:fPr', 'm:sSupPr', 'm:sSubPr',
  'm:sSubSupPr', 'm:radPr', 'm:naryPr', 'm:dPr', 'm:accPr',
  'm:mPr', 'm:funcPr', 'w:rPr', 'w:bookmarkStart',
  'w:bookmarkEnd', 'w:proofErr',
]);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Extract an attribute from an m:* namespace node.
 * OMML attributes use @_m:val (not @_w:val like WordprocessingML).
 */
export function getOmmlAttr(node: any, attr: string): string {
  return node?.[':@']?.[`@_m:${attr}`] ?? node?.[':@']?.[`@_${attr}`] ?? '';
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
 */
export function unicodeToLatex(text: string): string {
  let result = '';
  for (const ch of text) {
    const mapped = UNICODE_LATEX_MAP.get(ch);
    if (mapped) {
      // Add a space before the command if the previous char is a letter,
      // and add a trailing space so the command doesn't merge with following text.
      if (result.length > 0 && !result.endsWith(' ') && !result.endsWith('{')) {
        result += ' ';
      }
      result += mapped + ' ';
    } else {
      result += ch;
    }
  }
  return result.trimEnd();
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
function extractText(children: any[]): string {
  if (!Array.isArray(children)) return '';
  let text = '';
  for (const child of children) {
    if (child['#text'] !== undefined) {
      text += String(child['#text']);
    } else if (child['m:t']) {
      text += extractText(child['m:t']);
    }
  }
  return text;
}

/**
 * Recursively extract all text content from an OMML subtree.
 * Used by fallbackPlaceholder to provide context in error output.
 */
function extractAllText(children: any[]): string {
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
function findChild(children: any[], tag: string): any[] {
  if (!Array.isArray(children)) return [];
  for (const child of children) {
    if (child[tag] !== undefined) {
      return Array.isArray(child[tag]) ? child[tag] : [child[tag]];
    }
  }
  return [];
}

/**
 * Find the first child node (the full object including :@ attributes) with the given tag.
 * Unlike findChild which returns the tag's children array, this returns the node itself
 * so that getOmmlAttr can read its attributes.
 */
function findChildNode(children: any[], tag: string): any | undefined {
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
function findAllChildren(children: any[], tag: string): any[][] {
  if (!Array.isArray(children)) return [];
  const results: any[][] = [];
  for (const child of children) {
    if (child[tag] !== undefined) {
      results.push(Array.isArray(child[tag]) ? child[tag] : [child[tag]]);
    }
  }
  return results;
}



// ---------------------------------------------------------------------------
// Fallback placeholder
// ---------------------------------------------------------------------------

/**
 * Emit a visible fallback placeholder for unsupported or malformed elements.
 * Includes escaped text content for context when available.
 */
function fallbackPlaceholder(tag: string, children: any[]): string {
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
function translateRun(children: any[]): string {
  if (!Array.isArray(children)) return '';

  // Check m:rPr for m:sty style
  let style = '';
  for (const child of children) {
    if (child['m:rPr']) {
      const rPr = child['m:rPr'];
      if (Array.isArray(rPr)) {
        for (const prop of rPr) {
          if (prop['m:sty']) {
            style = getOmmlAttr(prop, 'val');
          }
        }
      }
    }
  }

  // Extract text from m:t nodes
  const text = extractText(children);
  if (!text) return '';

  const mapped = unicodeToLatex(text);
  if (style === 'p' || isMultiLetter(mapped)) {
    return `\\mathrm{${mapped}}`;
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Construct translator stubs (to be fully implemented in Tasks 2.1-2.3)
// ---------------------------------------------------------------------------

/**
 * Translate an m:f (fraction) element to LaTeX.
 * Extracts m:num and m:den children, emits \frac{numerator}{denominator}.
 * Falls back to placeholder if required children are missing.
 */
function translateFraction(children: any[]): string {
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
 * Translate an m:sSup (superscript) element to LaTeX.
 * Extracts m:e (base) and m:sup, emits {base}^{sup}.
 * Falls back to placeholder if required children are missing.
 */
function translateSuperscript(children: any[]): string {
  const base = findChild(children, 'm:e');
  const sup = findChild(children, 'm:sup');
  if (base.length === 0 || sup.length === 0) {
    return fallbackPlaceholder('m:sSup', children);
  }
  const baseLatex = ommlToLatex(base);
  const supLatex = ommlToLatex(sup);
  return `{${baseLatex}}^{${supLatex}}`;
}

/**
 * Translate an m:sSub (subscript) element to LaTeX.
 * Extracts m:e (base) and m:sub, emits {base}_{sub}.
 * Falls back to placeholder if required children are missing.
 */
function translateSubscript(children: any[]): string {
  const base = findChild(children, 'm:e');
  const sub = findChild(children, 'm:sub');
  if (base.length === 0 || sub.length === 0) {
    return fallbackPlaceholder('m:sSub', children);
  }
  const baseLatex = ommlToLatex(base);
  const subLatex = ommlToLatex(sub);
  return `{${baseLatex}}_{${subLatex}}`;
}

/**
 * Translate an m:sSubSup (sub-superscript) element to LaTeX.
 * Extracts m:e (base), m:sub, and m:sup, emits {base}_{sub}^{sup}.
 * Falls back to placeholder if required children are missing.
 */
function translateSubSup(children: any[]): string {
  const base = findChild(children, 'm:e');
  const sub = findChild(children, 'm:sub');
  const sup = findChild(children, 'm:sup');
  if (base.length === 0 || sub.length === 0 || sup.length === 0) {
    return fallbackPlaceholder('m:sSubSup', children);
  }
  const baseLatex = ommlToLatex(base);
  const subLatex = ommlToLatex(sub);
  const supLatex = ommlToLatex(sup);
  return `{${baseLatex}}_{${subLatex}}^{${supLatex}}`;
}

/**
 * Translate an m:rad (radical) element to LaTeX.
 * Reads m:radPr for m:degHide. If degree is hidden or empty, emits \sqrt{radicand}.
 * Otherwise emits \sqrt[degree]{radicand}.
 */
function translateRadical(children: any[]): string {
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
function translateNary(children: any[]): string {
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

  const sub = subHide ? '' : `_{${ommlToLatex(findChild(children, 'm:sub'))}}`;
  const sup = supHide ? '' : `^{${ommlToLatex(findChild(children, 'm:sup'))}}`;
  const body = ommlToLatex(findChild(children, 'm:e'));

  return `${op}${limits}${sub}${sup}{${body}}`;
}


/**
 * Translate an m:d (delimiter) element to LaTeX.
 * Reads m:dPr for m:begChr (default '('), m:endChr (default ')'),
 * m:sepChr (default '|'). Collects all m:e children and joins with separator.
 */
function translateDelimiter(children: any[]): string {
  const pr = findChild(children, 'm:dPr');

  const begChrNode = findChildNode(pr, 'm:begChr');
  const begChr = begChrNode !== undefined ? getOmmlAttr(begChrNode, 'val') : '(';
  const endChrNode = findChildNode(pr, 'm:endChr');
  const endChr = endChrNode !== undefined ? getOmmlAttr(endChrNode, 'val') : ')';
  const sepChrNode = findChildNode(pr, 'm:sepChr');
  const sepChr = sepChrNode !== undefined ? getOmmlAttr(sepChrNode, 'val') : '|';

  const elements = findAllChildren(children, 'm:e');
  const inner = elements.map(e => ommlToLatex(e)).join(sepChr);
  return `${begChr}${inner}${endChr}`;
}


function translateAccent(children: any[]): string {
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


function translateMatrix(children: any[]): string {
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


function translateFunction(children: any[]): string {
  // Extract function name from m:fName
  const fNameChildren = findChild(children, 'm:fName');
  let name = ommlToLatex(fNameChildren);

  // Strip \mathrm{} wrapping that translateRun may have added
  const mathrm = /^\\mathrm\{(.+)\}$/.exec(name);
  if (mathrm) {
    name = mathrm[1];
  }

  // Determine the LaTeX command for the function name
  let funcCmd: string;
  if (KNOWN_FUNCTIONS.has(name)) {
    funcCmd = `\\${name}`;
  } else {
    funcCmd = `\\operatorname{${name}}`;
  }

  // Translate the argument
  const arg = ommlToLatex(findChild(children, 'm:e'));
  return `${funcCmd}{${arg}}`;
}


// ---------------------------------------------------------------------------
// Node dispatch
// ---------------------------------------------------------------------------

/** Dispatch a single parsed node to the appropriate translator. */
function translateNode(node: any): string {
  let result = '';
  for (const key of Object.keys(node)) {
    if (key === ':@') continue;

    const children = node[key];

    switch (key) {
      case 'm:f':       result += translateFraction(children); break;
      case 'm:sSup':    result += translateSuperscript(children); break;
      case 'm:sSub':    result += translateSubscript(children); break;
      case 'm:sSubSup': result += translateSubSup(children); break;
      case 'm:rad':     result += translateRadical(children); break;
      case 'm:nary':    result += translateNary(children); break;
      case 'm:d':       result += translateDelimiter(children); break;
      case 'm:acc':     result += translateAccent(children); break;
      case 'm:m':       result += translateMatrix(children); break;
      case 'm:func':    result += translateFunction(children); break;
      case 'm:r':       result += translateRun(children); break;
      case 'm:t':       result += extractText(children); break;
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
export function ommlToLatex(children: any[]): string {
  if (!Array.isArray(children)) return '';
  let result = '';
  for (const child of children) {
    result += translateNode(child);
  }
  return result.trim();
}
