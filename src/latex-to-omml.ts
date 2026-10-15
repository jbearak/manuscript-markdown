// src/latex-to-omml.ts — LaTeX-to-OMML translation module
//
// --- Implementation notes ---
// - Script binding: ^/_ applies to nearest preceding atom, not the whole expression;
//   attach body scripts inside n-ary <m:e> for \sum/\int
// - Delimiter parsing (\left...\right): if right-delimiter token is combined text like
//   )+c, re-insert trailing text into token stream after consuming the delimiter
// - Delimiter inner parsing: script operators inside \left...\right must use
//   script-binding logic, not literal text runs

import { escapeXmlAttribute } from './xml-parser';

// ---------------------------------------------------------------------------
// Reverse mapping tables from omml.ts
// ---------------------------------------------------------------------------

const LATEX_UNICODE_MAP: Map<string, string> = new Map([
  // Greek lowercase
  ['\\alpha', 'α'], ['\\beta', 'β'], ['\\gamma', 'γ'], ['\\delta', 'δ'],
  ['\\epsilon', 'ϵ'], ['\\varepsilon', 'ε'], ['\\zeta', 'ζ'], ['\\eta', 'η'], ['\\theta', 'θ'], ['\\vartheta', 'ϑ'],
  ['\\iota', 'ι'], ['\\kappa', 'κ'], ['\\lambda', 'λ'], ['\\mu', 'μ'],
  ['\\nu', 'ν'], ['\\xi', 'ξ'], ['\\pi', 'π'], ['\\varpi', 'ϖ'], ['\\rho', 'ρ'], ['\\varrho', 'ϱ'],
  ['\\sigma', 'σ'], ['\\varsigma', 'ς'], ['\\tau', 'τ'], ['\\upsilon', 'υ'], ['\\phi', 'ϕ'], ['\\varphi', 'φ'],
  ['\\chi', 'χ'], ['\\psi', 'ψ'], ['\\omega', 'ω'],
  // Greek uppercase
  ['\\Gamma', 'Γ'], ['\\Delta', 'Δ'], ['\\Theta', 'Θ'], ['\\Lambda', 'Λ'],
  ['\\Xi', 'Ξ'], ['\\Pi', 'Π'], ['\\Sigma', 'Σ'], ['\\Upsilon', 'Υ'], ['\\Phi', 'Φ'],
  ['\\Psi', 'Ψ'], ['\\Omega', 'Ω'],
  // Operators and symbols
  ['\\times', '×'], ['\\div', '÷'], ['\\pm', '±'], ['\\mp', '∓'],
  ['\\leq', '≤'], ['\\geq', '≥'], ['\\neq', '≠'], ['\\approx', '≈'],
  ['\\infty', '∞'], ['\\partial', '∂'], ['\\nabla', '∇'],
  ['\\in', '∈'], ['\\notin', '∉'], ['\\subset', '⊂'], ['\\supset', '⊃'],
  ['\\cup', '∪'], ['\\cap', '∩'], ['\\to', '→'], ['\\leftarrow', '←'],
  ['\\Rightarrow', '⇒'], ['\\Leftarrow', '⇐'], ['\\leftrightarrow', '↔'],
  ['\\forall', '∀'], ['\\exists', '∃'], ['\\neg', '¬'],
  ['\\land', '∧'], ['\\lor', '∨'], ['\\oplus', '⊕'], ['\\otimes', '⊗'],
  ['\\mid', '∣'],
  ['\\cdot', '·'], ['\\ldots', '…'], ['\\cdots', '⋯'],
  ['\\dots', '…'], ['\\dotsc', '…'], ['\\dotsb', '…'], ['\\dotsm', '…'], ['\\dotsi', '…'],
  ['\\ddots', '⋱'], ['\\vdots', '⋮'],
  ['\\sim', '∼'], ['\\simeq', '≃'], ['\\equiv', '≡'], ['\\cong', '≅'],
  ['\\propto', '∝'], ['\\ll', '≪'], ['\\gg', '≫'],
  ['\\subseteq', '⊆'], ['\\supseteq', '⊇'], ['\\setminus', '∖'],
  ['\\perp', '⊥'], ['\\circ', '∘'], ['\\ast', '∗'],
  ['\\emptyset', '∅'], ['\\ell', 'ℓ'],
  ['\\Leftrightarrow', '⇔'], ['\\mapsto', '↦'],
  ['\\langle', '⟨'], ['\\rangle', '⟩'], ['\\|', '‖'], ['\\top', '⊤'],
  // ⟹ and ⟺ map back to these, not to \implies and \iff, which add spacing
  ['\\Longrightarrow', '⟹'], ['\\Longleftarrow', '⟸'], ['\\Longleftrightarrow', '⟺'], ['\\longrightarrow', '⟶'],
  ['\\leqslant', '⩽'], ['\\geqslant', '⩾'],
  ['\\star', '⋆'], ['\\dagger', '†'], ['\\ddagger', '‡'], ['\\hbar', 'ℏ'],
  ['\\nexists', '∄'], ['\\ni', '∋'], ['\\uparrow', '↑'], ['\\downarrow', '↓'],
  ['\\aleph', 'ℵ'], ['\\angle', '∠'],
  ['\\lfloor', '⌊'], ['\\rfloor', '⌋'], ['\\lceil', '⌈'], ['\\rceil', '⌉'],
  // One-way entries: omml.ts maps these characters back to the canonical
  // spelling above, except ′, which it keeps (f\prime renders a full-size prime)
  ['\\prime', '′'],
  ['\\lvert', '|'], ['\\rvert', '|'], ['\\vert', '|'], ['\\Vert', '‖'], ['\\lVert', '‖'], ['\\rVert', '‖'],
  ['\\bot', '⊥'], ['\\varnothing', '∅'], ['\\implies', '⟹'], ['\\iff', '⟺'],
  ['\\le', '≤'], ['\\ge', '≥'], ['\\ne', '≠'],
  ['\\rightarrow', '→'], ['\\gets', '←'],
  ['\\lnot', '¬'], ['\\wedge', '∧'], ['\\vee', '∨'],
]);

const LATEX_ACCENT_MAP: Map<string, string> = new Map([
  // m:acc has no wide form; the wide variants reuse the \hat and \tilde characters
  ['\\widehat', 'ˆ'],
  ['\\widetilde', '~'],
  ['\\hat', 'ˆ'],
  ['\\bar', '¯'],
  ['\\dot', '˙'],
  ['\\ddot', '\u0308'],
  ['\\check', '\u030C'],
  ['\\tilde', '~'],
  ['\\vec', '\u20D7'],
]);

const LATEX_NARY_MAP: Map<string, string> = new Map([
  ['\\sum', '∑'],
  ['\\prod', '∏'],
  ['\\int', '∫'],
  ['\\iint', '∬'],
  ['\\iiint', '∭'],
  ['\\oint', '∮'],
  ['\\bigcup', '⋃'],
  ['\\bigcap', '⋂'],
]);

const KNOWN_FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth',
  'log', 'ln', 'exp', 'lim', 'max', 'min',
  'sup', 'inf', 'det', 'dim', 'gcd', 'deg',
  'arg', 'hom', 'ker', 'Pr', 'liminf', 'limsup',
]);

/** Functions whose limits go under the name (m:limLow), as in Word's lim. */
const LIMIT_FUNCTIONS = new Set(['lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'Pr']);

/** How omml.ts escapes reserved characters in text and styled groups, read back outside math mode. */
const TEXT_ESCAPES: Map<string, string> = new Map([
  ['\\#', '#'], ['\\$', '$'], ['\\%', '%'], ['\\&', '&'], ['\\_', '_'], ['\\{', '{'], ['\\}', '}'],
  ['\\textbackslash', '\\'], ['\\textasciitilde', '~'], ['\\textasciicircum', '^'],
]);

/** The environments parseEnvironment gives an OMML form; keep in step with its cases. */
const SUPPORTED_ENVIRONMENTS: ReadonlySet<string> = new Set([
  'matrix', 'smallmatrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'cases',
  'align', 'align*', 'aligned', 'gather', 'gather*', 'gathered', 'split', 'multline', 'multline*',
  'flalign', 'flalign*', 'alignat', 'alignat*', 'equation', 'equation*', 'subequations',
]);

/** Environments without an OMML form whose first group is an argument, as array's column spec is, kept as text with the \begin. */
const ENVIRONMENT_ARGUMENTS: ReadonlySet<string> = new Set(['array', 'darray', 'subarray', 'alignedat']);

/** Function names that LaTeX sets with a space. */
const FUNCTION_NAMES: Map<string, string> = new Map([['liminf', 'lim inf'], ['limsup', 'lim sup']]);

/** Math alphabet commands and the m:rPr that gives the same letters in Word. */
const MATH_ALPHABETS: Map<string, string> = new Map([
  ['\\mathbf', '<m:sty m:val="b"/>'],
  ['\\boldsymbol', '<m:sty m:val="bi"/>'],
  ['\\mathit', '<m:sty m:val="i"/>'],
  ['\\mathbb', '<m:scr m:val="double-struck"/><m:sty m:val="p"/>'],
  ['\\mathfrak', '<m:scr m:val="fraktur"/><m:sty m:val="p"/>'],
  ['\\mathsf', '<m:scr m:val="sans-serif"/><m:sty m:val="p"/>'],
  ['\\mathtt', '<m:scr m:val="monospace"/><m:sty m:val="p"/>'],
]);

/** Commands whose group is styled text: the math alphabets, \mathrm and \mathcal. */
const STYLE_GROUP_COMMANDS = new Set([...MATH_ALPHABETS.keys(), '\\mathrm', '\\mathcal']);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function escapeXmlChars(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}

function unescapeXmlChars(text: string): string {
  // Keep in sync with escapeXmlChars()
  // Order matters: unescape &amp; last so we don't accidentally unescape parts of other entities.
  return text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function makeRun(text: string): string {
  return '<m:r><m:t>' + escapeXmlChars(text) + '</m:t></m:r>';
}

/**
 * A plain-style (upright, normal text) run. Text-mode content passes
 * `preserveSpace` so Word keeps its leading and trailing spaces; math-mode
 * commands such as \mathrm ignore spaces, as LaTeX does.
 */
function makeStyledRun(text: string, preserveSpace = false): string {
  const t = preserveSpace && /^\s|\s$/.test(text) ? '<m:t xml:space="preserve">' : '<m:t>';
  return '<m:r><m:rPr><m:sty m:val="p"/></m:rPr>' + t + escapeXmlChars(text) + '</m:t></m:r>';
}

function makeAlphabetRun(text: string, rPr: string): string {
  return '<m:r><m:rPr>' + rPr + '</m:rPr><m:t>' + escapeXmlChars(text) + '</m:t></m:r>';
}

function makeHiddenCommentRun(text: string): string {
  return '<m:r><m:rPr><m:nor/></m:rPr><w:rPr><w:vanish/></w:rPr><m:t xml:space="preserve">\u200B' + escapeXmlChars(text) + '</m:t></m:r>';
}

/** A whole hidden comment run (see makeHiddenCommentRun), as a split separator. */
const HIDDEN_RUN_RE = /(<m:r><m:rPr><m:nor\/><\/m:rPr><w:rPr><w:vanish\/><\/w:rPr><m:t xml:space="preserve">\u200B[^<]*<\/m:t><\/m:r>)/;

/**
 * `omml` with `restyle` applied to the runs outside each tracked change and to
 * those inside it, keeping the w:ins or w:del around the restyled runs.
 */
function restyleAroundRevisions(omml: string, restyle: (omml: string) => string): string {
  const revisions = [...omml.matchAll(/(<w:(ins|del)\b[^>]*>)([\s\S]*?)<\/w:\2>/g)];
  if (revisions.length === 0) return restyle(omml);
  const restyled = (part: string) => part ? restyle(part) : '';
  let result = '';
  let last = 0;
  for (const revision of revisions) {
    const inner = restyled(revision[3]);
    result += restyled(omml.slice(last, revision.index)) + (inner ? revision[1] + inner + '</w:' + revision[2] + '>' : '');
    last = revision.index + revision[0].length;
  }
  return result + restyled(omml.slice(last));
}

/**
 * The text of `omml`'s runs, `text`, as one run shows it in Word, to style
 * again (see styleGroup), and whether it needs xml:space="preserve". Where a
 * run that has it, as \text{ } writes, leaves a space at an edge, Word keeps
 * that space, so the one run keeps it too, without the source's spaces at
 * either edge, up to the text, which Word drops. Otherwise it's `text`, the
 * source's spaces, which a math style ignores, and Word drops, as they are.
 */
function styledText(omml: string, text: string): { text: string; preserve: boolean } {
  const runs = [...omml.matchAll(/<m:t( xml:space="preserve")?>(?!\u200B)([^<]*)<\/m:t>/g)].map(m => ({ kept: m[1] !== undefined, text: unescapeXmlChars(m[2]) }));
  for (const [list, edge] of [[runs, /^[ \t\r\n]+/], [[...runs].reverse(), /[ \t\r\n]+$/]] as const) {
    // Up to the first text, past a kept space too
    for (const run of list) {
      if (!run.kept) run.text = run.text.replace(edge, '');
      if (/[^ \t\r\n]/.test(run.text)) break;
    }
  }
  const shown = runs.map(run => run.text).join('');
  return /^[ \t\r\n]|[ \t\r\n]$/.test(shown) ? { text: shown, preserve: true } : { text, preserve: false };
}

function makeCalligraphicRun(text: string): string {
  return '<m:r><m:rPr><m:scr m:val="script"/><m:sty m:val="p"/></m:rPr><m:t>' + escapeXmlChars(text) + '</m:t></m:r>';
}


// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export interface Token {
  type: 'command' | 'lbrace' | 'rbrace' | 'caret' | 'underscore' | 'ampersand' | 'backslash' | 'text' | 'comment' | 'line_continuation';
  value: string;
  pos: number;
}

export function tokenize(latex: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  
  while (i < latex.length) {
    const ch = latex[i];
    
    if (ch === '\\') {
      // Command or escaped character
      if (i + 1 < latex.length) {
        const next = latex[i + 1];
        if (/[a-zA-Z]/.test(next)) {
          // Multi-letter command
          let j = i + 1;
          while (j < latex.length && /[a-zA-Z]/.test(latex[j])) {
            j++;
          }
          tokens.push({ type: 'command', value: latex.slice(i, j), pos: i });
          i = j;
        } else {
          // Single character command
          tokens.push({ type: 'command', value: latex.slice(i, i + 2), pos: i });
          i += 2;
        }
      } else {
        tokens.push({ type: 'backslash', value: '\\', pos: i });
        i++;
      }
    } else if (ch === '{') {
      tokens.push({ type: 'lbrace', value: '{', pos: i });
      i++;
    } else if (ch === '}') {
      tokens.push({ type: 'rbrace', value: '}', pos: i });
      i++;
    } else if (ch === '^') {
      tokens.push({ type: 'caret', value: '^', pos: i });
      i++;
    } else if (ch === '_') {
      tokens.push({ type: 'underscore', value: '_', pos: i });
      i++;
    } else if (ch === '&') {
      tokens.push({ type: 'ampersand', value: '&', pos: i });
      i++;
    } else if (ch === '%') {
      // LaTeX line comment: % starts a comment to end-of-line
      // Capture preceding whitespace from the last text token
      let precedingWs = '';
      if (tokens.length > 0 && tokens[tokens.length - 1].type === 'text') {
        const lastText = tokens[tokens.length - 1].value;
        const trimmed = lastText.replace(/[ \t]+$/, '');
        if (trimmed.length < lastText.length) {
          precedingWs = lastText.slice(trimmed.length);
          if (trimmed.length === 0) {
            tokens.pop();
          } else {
            tokens[tokens.length - 1] = { type: 'text', value: trimmed, pos: tokens[tokens.length - 1].pos };
          }
        }
      }
      // Find end-of-line or end-of-string
      let j = i + 1;
      while (j < latex.length && latex[j] !== '\n') {
        j++;
      }
      const commentText = latex.slice(i + 1, j); // text after %
      if (commentText.trim().length === 0 && j < latex.length && latex[j] === '\n') {
        // Line continuation: % at end-of-line with no meaningful comment text
        tokens.push({ type: 'line_continuation', value: precedingWs + '%' + commentText, pos: i });
        j++; // consume the newline
      } else {
        // Regular comment: % followed by comment text
        const hasNewline = j < latex.length && latex[j] === '\n';
        tokens.push({ type: 'comment', value: precedingWs + '%' + commentText + (hasNewline ? '\n' : ''), pos: i });
        if (hasNewline) {
          j++; // consume the newline after comment
        }
      }
      i = j;
    } else {
      // Regular text
      let j = i;
      while (j < latex.length && !/[\\{}^_&%]/.test(latex[j])) {
        j++;
      }
      tokens.push({ type: 'text', value: latex.slice(i, j), pos: i });
      i = j;
    }
  }

  return withoutRelax(tokens);
}

/**
 * `tokens` without \relax, which does nothing, and the spaces after it,
 * which TeX skips after a command word, with the text on either side as one
 * token, so that nothing reads it as an operand, as a script's, an n-ary
 * operator's or a function's: x+\relax+ is x++. Import writes it between
 * two characters that would read as CriticMarkup beside a brace, as in
 * \frac{\sum^+\relax+}{x} (see apartFromMarkup in omml.ts).
 */
function withoutRelax(tokens: Token[]): Token[] {
  if (!tokens.some(token => token.type === 'command' && token.value === '\\relax')) return tokens;
  const kept: Token[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type !== 'command' || token.value !== '\\relax') {
      kept.push(token);
      continue;
    }
    const next = tokens[k + 1];
    if (next?.type !== 'text') continue;
    k++;
    const rest = next.value.replace(/^[ \t\r\n]+/, '');
    const last = kept[kept.length - 1];
    if (last?.type === 'text') kept[kept.length - 1] = { ...last, value: last.value + rest };
    else if (rest) kept.push({ type: 'text', value: rest, pos: next.pos + next.value.length - rest.length });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * What the parser is reading. In 'math', ' is a prime and an escape such as
 * \% stays literal, as it always has. In 'styled', the argument of \mathbf
 * or \mathrm, ' is still a prime but escapes give their character. In
 * 'text', \text{} and \operatorname names, ' is an apostrophe too. Each mode
 * mirrors how omml.ts writes that context (see runTextLatex there).
 */
type ParseMode = 'math' | 'styled' | 'text';

/**
 * Private commands for CriticMarkup inside an equation. md-to-docx rewrites
 * each tracked span as one of these (see trackedEquationLatex in
 * md-to-docx-citations.ts), so a change inside a fraction or script stays
 * inside it in Word. Only trackedLatexToOmml reads them; elsewhere they're
 * unsupported commands, as anything a user writes by these names is.
 */
export const CRITIC_INSERTION_COMMAND = '\\mmCriticIns';
export const CRITIC_DELETION_COMMAND = '\\mmCriticDel';

/** Wraps a tracked part's OMML in w:ins or w:del. */
export type TrackChange = (element: 'w:ins' | 'w:del', omml: string) => string;

/** A \tag's text, and whether it is \tag*, which LaTeX shows without parentheses. */
interface EquationTag { text: string; star: boolean }

/**
 * Whether `omml` shows anything, which a row of spaces alone or a hidden
 * comment doesn't: text, or a structure, as \sum's or \left(\right)'s.
 */
function shows(omml: string): boolean {
  return /<m:t(?: [^>]*)?>(?!\u200B)[^<]*[^\s<]/.test(omml) || /<m:/.test(omml.replace(/<m:r>[\s\S]*?<\/m:r>/g, ''));
}

/**
 * Word's equation number for a \tag, at the end of a row of an equation
 * array: a # and then the number, (x) as a delimiter for \tag, as Word
 * builds up #(x), and x alone for \tag*. omml.ts reads it back as the tag
 * (see rowNumber there).
 */
function equationNumberOmml(tag: EquationTag): string {
  const number = makeRun(tag.text);
  return makeRun('#') + (tag.star ? number : '<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e>' + number + '</m:e></m:d>');
}

class Parser {
  private tokens: Token[];
  private pos: number;
  private onUnknownCommand?: (command: string) => void;
  private mode: ParseMode;
  private track?: TrackChange;
  /** Whether a \tag becomes Word's equation number, as in display math */
  numbered = false;
  /** The last \tag read and not yet written as a row's number */
  private tag?: EquationTag;

  constructor(tokens: Token[], onUnknownCommand?: (command: string) => void, mode: ParseMode = 'math', track?: TrackChange) {
    this.tokens = tokens;
    this.pos = 0;
    this.onUnknownCommand = onUnknownCommand;
    this.mode = mode;
    this.track = track;
  }

  /** Text as Word shows it: outside text mode, ' is a prime, as Word's own autocorrect makes it. */
  private mathText(text: string): string {
    return this.mode === 'text' ? text : text.replace(/'/g, '′');
  }

  /** Parse a group in the given mode. */
  private parseGroupIn(mode: ParseMode): string {
    const outer = this.mode;
    this.mode = mode;
    try {
      return this.parseGroup();
    } finally {
      this.mode = outer;
    }
  }

  /** Parse a group whose content is text, as `style` writes that text, keeping tracked changes in it. */
  private parseTextGroup(style: (text: string) => string): string {
    return restyleAroundRevisions(this.parseGroupIn('text'), omml => style(this.extractText(omml)));
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private parseGroup(): string {
    // Skip whitespace-only text tokens so arguments split across lines
    // (e.g. \frac{num}\n{den}) still bind to the command.
    while (this.peek()?.type === 'text' && this.peek()!.value.trim() === '') {
      this.consume();
    }
    const token = this.peek();
    if (token?.type === 'lbrace') {
      this.consume(); // consume '{'
      const content = this.parseExpression();
      const close = this.peek();
      if (close?.type === 'rbrace') {
        this.consume(); // consume '}'
      }
      return content;
    } else if (token?.type === 'rbrace') {
      // Don't consume — closing brace belongs to the enclosing group
      return '';
    } else {
      // No braces: LaTeX binds scripts to exactly one character.
      // Strip leading whitespace, take the first character, splice remainder back.
      const next = this.consume();
      if (!next) return '';
      if (next.type === 'text') {
        const trimmed = next.value.replace(/^\s+/, '');
        if (trimmed.length === 0) return '';
        const first = trimmed[0];
        const rest = trimmed.slice(1);
        if (rest) {
          this.tokens.splice(this.pos, 0, { type: 'text', value: rest, pos: next.pos });
        }
        return makeRun(this.mathText(first));
      }
      return this.parseToken(next);
    }
  }

  private parseToken(token: Token): string {
      switch (token.type) {
        case 'command':
          return this.parseCommand(token.value);
        case 'text':
          return makeRun(this.mathText(token.value));
        case 'caret':
        case 'underscore':
        case 'ampersand':
        case 'backslash':
          return makeRun(token.value);
        case 'comment':
          return makeHiddenCommentRun(token.value);
        case 'line_continuation':
          return makeHiddenCommentRun(token.value + '\n');
        default:
          return '';
      }
    }

  /**
   * If the upcoming tokens are (optional whitespace-only text) followed by a
   * token that satisfies `match`, consume through that token and return it.
   * Leaves the token stream untouched otherwise.
   */
  private consumeAfterWhitespace(match: (token: Token) => boolean): Token | undefined {
    let lookahead = this.pos;
    while (this.tokens[lookahead]?.type === 'text' && this.tokens[lookahead].value.trim() === '') {
      lookahead++;
    }
    const token = this.tokens[lookahead];
    if (!token || !match(token)) return undefined;
    this.pos = lookahead + 1;
    return token;
  }

  private consumeScriptOperator(type: 'caret' | 'underscore'): boolean {
    return this.consumeAfterWhitespace(t => t.type === type) !== undefined;
  }

  private parseScriptsForBase(base: string): string {
    let current = base;

    // TeX ignores whitespace before a script operator
    let firstOp: Token | undefined;
    while ((firstOp = this.consumeAfterWhitespace(t => t.type === 'caret' || t.type === 'underscore'))) {
      const firstScript = this.parseGroup();

      if (this.consumeScriptOperator(firstOp.type === 'caret' ? 'underscore' : 'caret')) {
        const secondScript = this.parseGroup();

        if (firstOp.type === 'caret') {
          current = '<m:sSubSup><m:e>' + current + '</m:e><m:sub>' + secondScript + '</m:sub><m:sup>' + firstScript + '</m:sup></m:sSubSup>';
        } else {
          current = '<m:sSubSup><m:e>' + current + '</m:e><m:sub>' + firstScript + '</m:sub><m:sup>' + secondScript + '</m:sup></m:sSubSup>';
        }
      } else {
        if (firstOp.type === 'caret') {
          current = '<m:sSup><m:e>' + current + '</m:e><m:sup>' + firstScript + '</m:sup></m:sSup>';
        } else {
          current = '<m:sSub><m:e>' + current + '</m:e><m:sub>' + firstScript + '</m:sub></m:sSub>';
        }
      }
    }

    return current;
  }

  private parseCommand(cmd: string): string {
    if (this.track && (cmd === CRITIC_INSERTION_COMMAND || cmd === CRITIC_DELETION_COMMAND)) {
      const start = this.pos;
      const omml = this.parseGroup();
      const change = omml && this.track(cmd === CRITIC_INSERTION_COMMAND ? 'w:ins' : 'w:del', omml);
      // Marked for keepWhitespaceChanges where the source is only whitespace,
      // in groups or styled ones such as \mathbf{ }, or a control space,
      // which the OMML alone can't tell from padding around a command that
      // gives none, as \! does
      const source = this.tokens.slice(start, this.pos);
      const onlyWhitespace = source.some(token => token.type === 'text' || token.value === '\\ ') && source.every(token =>
        token.type === 'lbrace' || token.type === 'rbrace' || (token.type === 'text' && /^[ \t\r\n]*$/.test(token.value)) ||
        (token.type === 'command' && (STYLE_GROUP_COMMANDS.has(token.value) || token.value === '\\ ')));
      return onlyWhitespace ? change.replace(/^<w:(?:ins|del)\b/, open => open + WHITESPACE_CHANGE_MARK) : change;
    }

    const escaped = this.mode === 'math' ? undefined : TEXT_ESCAPES.get(cmd);
    if (escaped !== undefined) {
      return makeRun(escaped);
    }

    // Greek letters and symbols
    const unicode = LATEX_UNICODE_MAP.get(cmd);
    if (unicode) {
      return makeRun(unicode);
    }

    // N-ary operators
    const nary = LATEX_NARY_MAP.get(cmd);
    if (nary) {
      return this.parseNary(nary);
    }

    // Accents
    const accent = LATEX_ACCENT_MAP.get(cmd);
    if (accent) {
      const base = this.parseGroup();
      return '<m:acc><m:accPr><m:chr m:val="' + escapeXmlAttribute(accent) + '"/></m:accPr><m:e>' + base + '</m:e></m:acc>';
    }

    // Functions
    const funcName = cmd.slice(1);
    if (KNOWN_FUNCTIONS.has(funcName)) {
      return this.parseFunction(makeStyledRun(FUNCTION_NAMES.get(funcName) ?? funcName), LIMIT_FUNCTIONS.has(funcName));
    }

    // Math alphabets
    const alphabet = MATH_ALPHABETS.get(cmd);
    if (alphabet) {
      return this.styleGroup(text => makeAlphabetRun(text, alphabet));
    }

    switch (cmd) {
      case '\\frac': {
        const num = this.parseGroup();
        const den = this.parseGroup();
        return '<m:f><m:num>' + num + '</m:num><m:den>' + den + '</m:den></m:f>';
      }

      case '\\sqrt': {
        // An optional [n] argument is the degree
        const degree = this.parseBracketedOperand('[', true);
        const radicand = this.parseGroup();
        if (degree) return '<m:rad><m:deg>' + degree + '</m:deg><m:e>' + radicand + '</m:e></m:rad>';
        return '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>' + radicand + '</m:e></m:rad>';
      }

      case '\\left':
        return this.parseDelimiter();

      // A \right with no \left, as when only the \left is tracked: just its
      // delimiter, as a \left with no \right is, and so a \middle
      case '\\middle':
      case '\\right': {
        const endChr = this.delimiterChr(')');
        return endChr ? makeRun(endChr) : '';
      }

      case '\\begin':
        return this.parseEnvironment();

      // An \end with no \begin, as when only the \begin is tracked: nothing
      // for an environment with an OMML form, as a \begin with no \end shows
      // only its environment, and its source for one parseEnvironment shows
      // as text, as it shows that \end, where sourceGroup can keep it
      case '\\end': {
        const source = this.sourceGroup();
        if (source !== undefined && !SUPPORTED_ENVIRONMENTS.has(source.trim().slice(1, -1).trim())) return makeRun('\\end' + source);
        if (source === undefined) this.parseGroup();
        return '';
      }

      case '\\mathrm':
        return this.styleGroup(text => makeStyledRun(text));

      case '\\mathcal':
        return this.styleGroup(makeCalligraphicRun);

      case '\\operatorname': {
        // Intentionally consumes a following group as the function argument,
        // mirroring KNOWN_FUNCTIONS (e.g. \sin{x}) for round-trip fidelity
        // with the OMML→LaTeX direction which emits \operatorname{name}{arg}.
        // \operatorname* puts limits under the name, like \lim.
        const limitsUnder = this.consumeStarVariant();
        return this.parseFunction(this.parseTextGroup(text => makeStyledRun(text)), limitsUnder);
      }

      case '\\limits':
      case '\\nolimits':
        // This should be handled by nary parsing, but if encountered alone, ignore
        return '';

      // Fraction variants (same output as \frac)
      case '\\dfrac':
      case '\\tfrac':
      case '\\cfrac': {
        const fnum = this.parseGroup();
        const fden = this.parseGroup();
        return '<m:f><m:num>' + fnum + '</m:num><m:den>' + fden + '</m:den></m:f>';
      }

      // Binomial coefficients
      case '\\binom':
      case '\\dbinom':
      case '\\tbinom': {
        const bnum = this.parseGroup();
        const bden = this.parseGroup();
        return '<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e>' +
          '<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>' + bnum + '</m:num><m:den>' + bden + '</m:den></m:f>' +
          '</m:e></m:d>';
      }

      // \text{} — same as \mathrm
      case '\\text':
        return this.parseTextGroup(text => makeStyledRun(text, true));

      // \boxed{}
      case '\\boxed': {
        const boxContent = this.parseGroup();
        return '<m:borderBox><m:e>' + boxContent + '</m:e></m:borderBox>';
      }

      // \phantom{}, as Word's phantom it hides, of no height for \hphantom{}
      // and no width for \vphantom{}
      case '\\phantom':
      case '\\hphantom':
      case '\\vphantom': {
        const zero = cmd === '\\hphantom' ? '<m:zeroAsc m:val="1"/><m:zeroDesc m:val="1"/>' : cmd === '\\vphantom' ? '<m:zeroWid m:val="1"/>' : '';
        const phantomContent = this.parseGroup();
        return '<m:phant><m:phantPr><m:show m:val="0"/>' + zero + '</m:phantPr><m:e>' + phantomContent + '</m:e></m:phant>';
      }

      // \overset{top}{base}
      case '\\overset': {
        const overTop = this.parseGroup();
        const overBase = this.parseGroup();
        return '<m:limUpp><m:e>' + overBase + '</m:e><m:lim>' + overTop + '</m:lim></m:limUpp>';
      }

      // \underset{bottom}{base}
      case '\\underset': {
        const underBottom = this.parseGroup();
        const underBase = this.parseGroup();
        return '<m:limLow><m:e>' + underBase + '</m:e><m:lim>' + underBottom + '</m:lim></m:limLow>';
      }

      // \overline{} and \underline{}
      case '\\overline': {
        const olContent = this.parseGroup();
        return '<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>' + olContent + '</m:e></m:bar>';
      }

      case '\\underline': {
        const ulContent = this.parseGroup();
        return '<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>' + ulContent + '</m:e></m:bar>';
      }

      // Word's cancel: a border box with its sides hidden, struck through
      // from bottom left to top right, the other way, both, or across
      case '\\cancel':
      case '\\bcancel':
      case '\\xcancel':
      case '\\sout': {
        const strike = cmd === '\\cancel' ? '<m:strikeBLTR m:val="1"/>' : cmd === '\\bcancel' ? '<m:strikeTLBR m:val="1"/>'
          : cmd === '\\xcancel' ? '<m:strikeBLTR m:val="1"/><m:strikeTLBR m:val="1"/>' : '<m:strikeH m:val="1"/>';
        const cancelContent = this.parseGroup();
        return '<m:borderBox><m:borderBoxPr><m:hideTop m:val="1"/><m:hideBot m:val="1"/><m:hideLeft m:val="1"/><m:hideRight m:val="1"/>' +
          strike + '</m:borderBoxPr><m:e>' + cancelContent + '</m:e></m:borderBox>';
      }

      // \overbrace{} and \underbrace{}
      // A directly following script (^ for overbrace, _ for underbrace) is the
      // brace label: emit m:limUpp/m:limLow so Word renders it above/below the
      // brace instead of as an inline super/subscript.
      case '\\overbrace': {
        const obContent = this.parseGroup();
        const groupChr = '<m:groupChr><m:groupChrPr><m:chr m:val="\u23DE"/><m:pos m:val="top"/></m:groupChrPr><m:e>' + obContent + '</m:e></m:groupChr>';
        if (this.consumeScriptOperator('caret')) {
          const label = this.parseGroup();
          return '<m:limUpp><m:e>' + groupChr + '</m:e><m:lim>' + label + '</m:lim></m:limUpp>';
        }
        return groupChr;
      }

      case '\\underbrace': {
        const ubContent = this.parseGroup();
        const groupChr = '<m:groupChr><m:groupChrPr><m:chr m:val="\u23DF"/><m:pos m:val="bot"/></m:groupChrPr><m:e>' + ubContent + '</m:e></m:groupChr>';
        if (this.consumeScriptOperator('underscore')) {
          const label = this.parseGroup();
          return '<m:limLow><m:e>' + groupChr + '</m:e><m:lim>' + label + '</m:lim></m:limLow>';
        }
        return groupChr;
      }

      // A tag is written as its row's number, or the equation's (see
      // rowNumber and numberedEquation); labels are consumed
      case '\\tag':
        this.readTag();
        return '';

      case '\\label': {
        this.discardGroup();
        return '';
      }

      case '\\notag':
      case '\\nonumber':
        return '';

      // Style commands (silently consumed)
      case '\\displaystyle':
      case '\\textstyle':
        return '';

      // Intertext
      case '\\intertext':
      case '\\shortintertext':
        return this.parseTextGroup(text => makeStyledRun(text, true));

      // Shove commands — emit inner content
      case '\\shoveleft':
      case '\\shoveright':
        return this.parseGroup();

      // Spacing
      case '\\,':
        return makeRun('\u2009');
      case '\\:':
        return makeRun('\u205F');
      case '\\;':
        return makeRun('\u2004');
      case '\\!':
        return '';
      case '\\ ':
        return makeRun(' ');
      case '\\quad':
        return makeRun('\u2003');
      case '\\qquad':
        return makeRun('\u2003\u2003');

      // Mod commands
      case '\\pmod': {
        const modArg = this.parseGroup();
        return '<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e>' +
          makeStyledRun('mod') + makeRun('\u2005') + modArg + '</m:e></m:d>';
      }

      case '\\bmod':
        return makeStyledRun('mod');

      default:
        // Unsupported command - fallback. An escaped reserved character in
        // math (\%, \_) stays literal so it reads back unchanged; it is valid
        // LaTeX, so it is not reported.
        if (!(cmd.length === 2 && TEXT_ESCAPES.has(cmd))) this.onUnknownCommand?.(cmd);
        return makeRun(cmd);
    }
  }

  private parseNary(naryChar: string): string {
    let limits = '';
    let sub = '';
    let sup = '';

    // Check for \limits
    // TeX ignores whitespace before \limits and before each limit
    const limitsCmd = this.consumeAfterWhitespace(
      t => t.type === 'command' && (t.value === '\\limits' || t.value === '\\nolimits'),
    );
    if (limitsCmd) {
      limits = '<m:limLoc m:val="' + (limitsCmd.value === '\\limits' ? 'undOvr' : 'subSup') + '"/>';
    }

    // Parse subscript and superscript
    let script: Token | undefined;
    while ((script = this.consumeAfterWhitespace(t => t.type === 'underscore' || t.type === 'caret'))) {
      if (script.type === 'underscore') {
        sub = this.parseGroup();
      } else {
        sup = this.parseGroup();
      }
    }

    const bodyAtom = this.parseBracketedOperand() ?? this.parseGroup();
    const body = this.parseScriptsForBase(bodyAtom);

    // m:sub and m:sup are required; without the hide flags Word shows an
    // absent limit as an empty placeholder box.
    const hide = (sub ? '' : '<m:subHide m:val="1"/>') + (sup ? '' : '<m:supHide m:val="1"/>');
    return '<m:nary><m:naryPr><m:chr m:val="' + escapeXmlAttribute(naryChar) + '"/>' + limits + hide + '</m:naryPr>' +
      '<m:sub>' + sub + '</m:sub><m:sup>' + sup + '</m:sup><m:e>' + body + '</m:e></m:nary>';
  }

  /**
   * Parse a `(…)` or `[…]` group that directly follows an n-ary operator or a
   * function name as that construct's whole operand, so the m:e holds the
   * group instead of just its opening bracket. `opens` limits the brackets,
   * and `inner` parses only what's between them, as for \sqrt's [n]. Returns
   * undefined, leaving the token stream untouched, unless the bracket closes
   * within the current brace group, \left…\right pair (before its \middle),
   * row, and cell.
   */
  private parseBracketedOperand(opens = '([', inner = false): string | undefined {
    let start = this.pos;
    while (this.tokens[start]?.type === 'text' && this.tokens[start].value.trim() === '') start++;
    const first = this.tokens[start];
    if (first?.type !== 'text') return undefined;
    const lead = first.value.length - first.value.trimStart().length;
    const open = first.value.charAt(lead);
    const close = !opens.includes(open) ? '' : open === '(' ? ')' : open === '[' ? ']' : '';
    if (!close) return undefined;

    let depth = 0;
    // Braces, environments, and \left…\right pairs are opaque: nothing inside
    // them can close the bracket, and an unmatched closer ends the enclosing group.
    let nesting = 0;
    for (let i = start; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.type === 'lbrace' || (token.type === 'command' && (token.value === '\\begin' || token.value === '\\left'))) {
        nesting++;
        continue;
      }
      if (token.type === 'rbrace' || (token.type === 'command' && (token.value === '\\end' || token.value === '\\right'))) {
        if (nesting === 0) return undefined;
        nesting--;
        continue;
      }
      if (nesting > 0) continue;
      // A \middle here is the enclosing \left's, which splits it, as its \right ends it
      if (token.type === 'ampersand' || (token.type === 'command' && (token.value === '\\\\' || token.value === '\\middle'))) {
        return undefined;
      }
      if (token.type !== 'text') continue;

      // The character right after \right, and the spaces before it, is that
      // command's delimiter (see delimiterChr).
      const prev = this.tokens[i - 1];
      const skipDelimiter = prev?.type === 'command' && prev.value === '\\right';
      for (let j = i === start ? lead : skipDelimiter ? token.value.length - token.value.trimStart().length + 1 : 0; j < token.value.length; j++) {
        const ch = token.value.charAt(j);
        if (ch === open) {
          depth++;
        } else if (ch === close && --depth === 0) {
          const operand = this.tokens.slice(start, i + 1).map(t => ({ ...t }));
          operand[operand.length - 1].value = operand[operand.length - 1].value.slice(0, inner ? j : j + 1);
          operand[0].value = operand[0].value.slice(inner ? lead + 1 : lead);
          const rest = token.value.slice(j + 1);
          // eslint-disable-next-line no-restricted-syntax -- one token at most
          this.tokens.splice(this.pos, i + 1 - this.pos, ...(rest ? [{ type: 'text' as const, value: rest, pos: token.pos + j + 1 }] : []));
          // A \tag in it numbers the equation, as in a group
          const parser = new Parser(operand, this.onUnknownCommand, this.mode, this.track);
          const omml = parser.parseExpression(false);
          this.tag = parser.tag ?? this.tag;
          return omml;
        }
      }
    }
    return undefined;
  }

  private parseDelimiter(): string {
    const begChr = this.delimiterChr('(');
    if (begChr === undefined) return '';

    // Parse any additional content until \\right, in parts between the
    // delimiters of \middle, which Word's delimiter has as its separator
    const parts = [this.parseUntilRight()];
    const separators: string[] = [];
    while (this.peek()?.type === 'command' && this.peek()!.value === '\\middle') {
      this.consume();
      separators.push(this.delimiterChr(')') ?? '');
      parts.push(this.parseUntilRight());
    }
    // A delimiter in Word has one separator, so parts between different
    // ones go in one, with their characters between them, as Word shows them
    const separator = separators.length > 0 && separators.every(sep => sep === separators[0]) ? separators[0] : undefined;
    const content = parts.map((part, k) => (k === 0 ? '' : makeRun(separators[k - 1])) + part).join('');

    const rightCmd = this.peek();
    if (!(rightCmd?.type === 'command' && rightCmd.value === '\\right')) {
      // Malformed input (missing \right): fall back to emitting the open delimiter + content.
      return makeRun(begChr) + content;
    }

    this.consume(); // consume \\right

    const endChr = this.delimiterChr(')');
    if (endChr === undefined) {
      // Malformed input (missing \right delimiter): fall back to emitting the open delimiter + content.
      return makeRun(begChr) + content;
    }

    return '<m:d><m:dPr><m:begChr m:val="' + escapeXmlAttribute(begChr) + '"/>'
      + (separator === undefined ? '' : '<m:sepChr m:val="' + escapeXmlAttribute(separator) + '"/>')
      + '<m:endChr m:val="' + escapeXmlAttribute(endChr) + '"/></m:dPr>'
      + (separator === undefined ? '<m:e>' + content + '</m:e>' : parts.map(part => '<m:e>' + part + '</m:e>').join('')) + '</m:d>';
  }

  /**
   * Consume the delimiter after \left, \middle or \right and return its
   * character, '' for '.', which is none, or undefined if there is none. The
   * spaces before it go, as TeX skips them after a command word, and a
   * command can be any of the delimiters, opening or closing, as \lbrace in
   * \middle or \right. A token that's no delimiter is taken as `fallback`.
   */
  private delimiterChr(fallback: string): string | undefined {
    let token = this.consume();
    while (token?.type === 'text' && !token.value.trim()) token = this.consume();
    if (!token) return undefined;
    if (token.type === 'text') {
      // The delimiter and content might be combined in one token like "(x"
      const value = token.value.trimStart();
      const remaining = value.slice(1);
      if (remaining) {
        this.tokens.splice(this.pos, 0, { type: 'text', value: remaining, pos: token.pos });
      }
      return value.charAt(0) === '.' ? '' : value.charAt(0);
    }
    if (token.type !== 'command') return fallback;
    switch (token.value) {
      case '\\{': case '\\lbrace': return '{';
      case '\\}': case '\\rbrace': return '}';
      case '\\|': return '\u2016';
      case '\\[': return '[';
      case '\\]': return ']';
      default: return this.delimiterCommandChr(token.value);
    }
  }

  /** Consume a `*` prefix from the next text token (for `\tag*` variants); report whether there was one. */
  private consumeStarVariant(): boolean {
    if (this.peek()?.type === 'text' && this.peek()?.value.startsWith('*')) {
      const starToken = this.consume()!;
      const rest = starToken.value.slice(1);
      if (rest) {
        this.tokens.splice(this.pos, 0, { type: 'text', value: rest, pos: starToken.pos });
      }
      return true;
    }
    return false;
  }

  /**
   * Parse a function's scripts and argument after its name. Word keeps the
   * scripts in m:fName: under the name (m:limLow, m:limUpp) for limit-style
   * functions such as \lim and \max, beside it (\log_2, \sin^2) otherwise.
   */
  private parseFunction(name: string, limitsUnder: boolean): string {
    const placement = this.consumeAfterWhitespace(
      t => t.type === 'command' && (t.value === '\\limits' || t.value === '\\nolimits'),
    );
    if (placement) limitsUnder = placement.value === '\\limits';
    let fName = name;
    if (limitsUnder) {
      let script: Token | undefined;
      while ((script = this.consumeAfterWhitespace(t => t.type === 'underscore' || t.type === 'caret'))) {
        const tag = script.type === 'underscore' ? 'm:limLow' : 'm:limUpp';
        fName = '<' + tag + '><m:e>' + fName + '</m:e><m:lim>' + this.parseGroup() + '</m:lim></' + tag + '>';
      }
    } else {
      fName = this.parseScriptsForBase(fName);
    }
    const arg = this.parseScriptsForBase(this.parseBracketedOperand() ?? this.parseGroup());
    return '<m:func><m:fName>' + fName + '</m:fName><m:e>' + arg + '</m:e></m:func>';
  }

  /**
   * Core atom-parsing loop: accumulate OMML atoms with script-binding
   * and multi-char text splitting. Shared by all expression/content parsers.
   *
   * Returns the **live** `atoms` array (not a copy). Callers that use
   * `onSpecialToken` to drain atoms mid-parse (via `atoms.length = 0`)
   * rely on this aliasing — do not copy on return.
   *
   * @param shouldStop - Receives the current token; return true to exit.
   * @param onSpecialToken - Optional callback for domain-specific tokens
   *   (ampersand, \\, \tag, etc.). Return true if handled, false for
   *   default processing. The callback receives the live `atoms` array
   *   and may read or mutate it (e.g. `atoms.length = 0` to flush).
   *   **Must consume the triggering token before returning true**;
   *   failing to do so causes an infinite loop.
   */
  private parseAtoms(
    shouldStop: (token: Token) => boolean,
    onSpecialToken?: (token: Token, atoms: string[]) => boolean,
  ): string[] {
    const atoms: string[] = [];
    let token: Token | undefined;
    while ((token = this.peek()) && !shouldStop(token)) {
      if (onSpecialToken && onSpecialToken(token, atoms)) continue;
      if (token.type === 'caret' || token.type === 'underscore') {
        if (atoms.length === 0) {
          atoms.push(this.parseToken(this.consume()!));
        } else {
          const base = atoms.pop()!;
          atoms.push(this.parseScriptsForBase(base));
        }
      } else if (token.type === 'lbrace') {
        // Parse {…} as a single atom so scripts (^ / _) bind to the group
        // content, not to an empty atom from the closing brace.
        // {a}/{b} is Word's linear fraction, as import writes it, in math,
        // but where a script follows, which takes the {b} alone. In text or
        // a style's group, as \mathrm{{m}/{s}}, it's the characters
        const group = this.parseGroup();
        const slash = this.peek();
        if (this.mode === 'math' && slash?.type === 'text' && slash.value === '/' && this.tokens[this.pos + 1]?.type === 'lbrace') {
          this.consume(); // consume '/'
          const den = this.parseGroup();
          if (this.scriptFollows()) atoms.push(group, makeRun('/'), den);
          else atoms.push('<m:f><m:fPr><m:type m:val="lin"/></m:fPr><m:num>' + group + '</m:num><m:den>' + den + '</m:den></m:f>');
        } else {
          atoms.push(group);
        }
      } else {
        const consumed = this.consume()!;
        if (consumed.type === 'text') {
          // TeX ignores source whitespace before a script, so the script binds
          // to the atom before the space. Spacing commands such as \quad are
          // not text tokens and keep their runs.
          const next = this.peek();
          const beforeScript = next?.type === 'caret' || next?.type === 'underscore';
          for (const ch of this.mathText(beforeScript ? consumed.value.replace(/[ \t\r\n]+$/, '') : consumed.value)) {
            atoms.push(makeRun(ch));
          }
        } else if (consumed.type === 'comment' || consumed.type === 'line_continuation') {
          // Append to the preceding atom so comment runs are never selected
          // as bases for script binding (^ / _).
          const commentXml = this.parseToken(consumed);
          if (atoms.length > 0) {
            atoms[atoms.length - 1] += commentXml;
          } else {
            atoms.push(commentXml);
          }
        } else {
          atoms.push(this.parseToken(consumed));
        }
      }
    }
    return atoms;
  }

  /** Whether a script operator comes next, after any whitespace, which TeX
   *  ignores before one, and comments, which go on the atom before it */
  private scriptFollows(): boolean {
    let next = this.pos;
    for (let token = this.tokens[next]; token && (token.type === 'comment' || token.type === 'line_continuation'
      || (token.type === 'text' && token.value.trim() === '')); token = this.tokens[++next]);
    return this.tokens[next]?.type === 'caret' || this.tokens[next]?.type === 'underscore';
  }

  private parseUntilRight(): string {
    return this.parseAtoms(
      (t) => t.type === 'command' && (t.value === '\\right' || t.value === '\\middle'),
    ).join('');
  }

  private parseEnvironment(): string {
    const envToken = this.parseGroup();
    const envName = this.extractText(envToken);

    switch (envName) {
      case 'matrix':
      case 'smallmatrix': {
        const content = this.parseMatrixContent();
        this.consumeEnd(envName);
        return '<m:m>' + content + '</m:m>';
      }

      case 'pmatrix':
        return this.parseDelimitedMatrix(envName, '(', ')');
      case 'bmatrix':
        return this.parseDelimitedMatrix(envName, '[', ']');
      case 'Bmatrix':
        return this.parseDelimitedMatrix(envName, '{', '}');
      case 'vmatrix':
        return this.parseDelimitedMatrix(envName, '|', '|');
      case 'Vmatrix':
        return this.parseDelimitedMatrix(envName, '\u2016', '\u2016');

      case 'cases': {
        const content = this.parseEqArrayContent();
        this.consumeEnd(envName);
        return '<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr><m:e><m:eqArr>' + content + '</m:eqArr></m:e></m:d>';
      }

      case 'aligned':
      case 'gathered':
      case 'split': {
        const content = this.parseEqArrayContent();
        this.consumeEnd(envName);
        return '<m:eqArr>' + content + '</m:eqArr>';
      }

      case 'align':
      case 'align*':
      case 'gather':
      case 'gather*':
      case 'multline':
      case 'multline*':
      case 'flalign':
      case 'flalign*': {
        const content = this.parseEqArrayContent(true);
        this.consumeEnd(envName);
        return '<m:eqArr>' + content + '</m:eqArr>';
      }

      case 'alignat':
      case 'alignat*': {
        // Consume {n} column count argument
        if (this.peek()?.type === 'lbrace') {
          this.parseGroup();
        }
        const content = this.parseEqArrayContent(true);
        this.consumeEnd(envName);
        return '<m:eqArr>' + content + '</m:eqArr>';
      }

      case 'equation':
      case 'equation*':
      case 'subequations': {
        const content = this.parseUntilEnd();
        this.consumeEnd(envName);
        return content;
      }

      default: {
        // An environment with no OMML form, such as array or dcases, is
        // shown as written: its \begin and argument and its \end as text,
        // and its body as math, so all of it reads back. Its own \end is
        // taken here, or one in a known environment would end that. An
        // argument or \end sourceGroup can't keep is read as before: the
        // argument as math, and the \end as nothing. With no \end of its
        // own (see hasOwnEnd), all of it is read as before, so that it takes
        // no row or \end of an environment around it.
        this.onUnknownCommand?.('\\begin{' + envName + '}');
        if (!this.hasOwnEnd(envName)) return makeRun('\\begin{' + envName + '}');
        const begin = '\\begin{' + envName + '}' + (ENVIRONMENT_ARGUMENTS.has(envName) ? this.sourceGroup() ?? '' : '');
        const body = this.parseAtoms(
          (t) => t.type === 'rbrace' || (t.type === 'command' && t.value === '\\end'),
          (token, atoms) => {
            if (token.type !== 'command' || token.value !== '\\\\') return false;
            this.consume();
            atoms.push(makeRun('\\\\'));
            return true;
          },
        ).join('');
        if (this.peek()?.type !== 'command' || this.peek()?.value !== '\\end') return makeRun(begin) + body;
        this.consume();
        const end = this.sourceGroup();
        if (end === undefined) this.parseGroup();
        return makeRun(begin) + body + (end === undefined ? '' : makeRun('\\end' + end));
      }
    }
  }

  /**
   * Whether the environment `name`, begun just before here, has its \end in
   * the same group: \end{name} before the group closes, past environments
   * begun and ended in it, each name for name. Any other \end, as of an
   * environment around it, or a group's close comes first otherwise.
   */
  private hasOwnEnd(name: string): boolean {
    const open: string[] = [];
    let depth = 0;
    for (let k = this.pos; k < this.tokens.length; k++) {
      const token = this.tokens[k];
      if (token.type === 'lbrace') depth++;
      else if (token.type === 'rbrace' && --depth < 0) return false;
      else if (depth === 0 && token.type === 'command' && token.value === '\\begin') open.push(this.environmentNameAt(k + 1));
      else if (depth === 0 && token.type === 'command' && token.value === '\\end') {
        const ended = this.environmentNameAt(k + 1);
        if (!open.length) return ended === name;
        if (open.pop() !== ended) return false;
      }
    }
    return false;
  }

  /** The environment name in the group at token `k`, past spaces, or '' where there's none. */
  private environmentNameAt(k: number): string {
    while (this.tokens[k]?.type === 'text' && /^[ \t\r\n]*$/.test(this.tokens[k].value)) k++;
    if (this.tokens[k]?.type !== 'lbrace') return '';
    let name = '';
    for (k++; this.tokens[k] && this.tokens[k].type !== 'rbrace'; k++) name += this.tokens[k].value;
    return name.trim();
  }

  /**
   * The source of the brace group next, with any spaces before it, where
   * its tokens give that source exactly: text and braces alone, each token
   * starting where the last ended, so that tokenize dropped nothing, as it
   * drops the \relax of +\relax+, with no comment, which would show, and
   * no line end, which a run doesn't keep. Otherwise undefined, with
   * nothing taken, as where no group is next.
   */
  private sourceGroup(): string | undefined {
    let end = this.pos;
    while (this.tokens[end]?.type === 'text' && /^[ \t]*$/.test(this.tokens[end].value)) end++;
    if (this.tokens[end]?.type !== 'lbrace') return undefined;
    for (let depth = 0; ; end++) {
      const token = this.tokens[end];
      if (!token || (token.type !== 'lbrace' && token.type !== 'rbrace' && (token.type !== 'text' || /[\r\n]/.test(token.value)))) return undefined;
      if (token.type === 'lbrace') depth++;
      else if (token.type === 'rbrace' && --depth === 0) break;
    }
    const tokens = this.tokens.slice(this.pos, end + 1);
    if (tokens.some((token, k) => k > 0 && tokens[k - 1].pos + tokens[k - 1].value.length !== token.pos)) return undefined;
    this.pos = end + 1;
    return tokens.map(token => token.value).join('');
  }

  private parseDelimitedMatrix(envName: string, begChr: string, endChr: string): string {
    const content = this.parseMatrixContent();
    this.consumeEnd(envName);
    return '<m:d><m:dPr><m:begChr m:val="' + escapeXmlAttribute(begChr) + '"/><m:endChr m:val="' + escapeXmlAttribute(endChr) + '"/></m:dPr><m:e><m:m>' + content + '</m:m></m:e></m:d>';
  }

  private parseMatrixContent(): string {
    let rows = '';
    let currentRowCells = '';

    const remaining = this.parseAtoms(
      (t) => t.type === 'command' && t.value === '\\end',
      (token, atoms) => {
        if (token.type === 'ampersand') {
          this.consume();
          currentRowCells += '<m:e>' + atoms.join('') + '</m:e>';
          atoms.length = 0;
          return true;
        }
        if (token.type === 'command' && token.value === '\\\\') {
          this.consume();
          currentRowCells += '<m:e>' + atoms.join('') + '</m:e>';
          atoms.length = 0;
          rows += '<m:mr>' + currentRowCells + '</m:mr>';
          currentRowCells = '';
          return true;
        }
        return false;
      },
    );

    if (remaining.length > 0 || currentRowCells) {
      currentRowCells += '<m:e>' + remaining.join('') + '</m:e>';
      rows += '<m:mr>' + currentRowCells + '</m:mr>';
    }

    return rows;
  }

  /**
   * The rows of an equation array. With `numberRows`, for the environments
   * that number their rows in LaTeX, a row's \tag is its number in Word;
   * otherwise, as in aligned or cases, it stays the equation's.
   */
  private parseEqArrayContent(numberRows = false): string {
    const rows: string[] = [];

    const remaining = this.parseAtoms(
      (t) => t.type === 'command' && t.value === '\\end',
      (token, atoms) => {
        if (token.type === 'command' && token.value === '\\\\') {
          this.consume();
          const row = atoms.join('');
          rows.push('<m:e>' + row + this.rowNumber(numberRows, row) + '</m:e>');
          atoms.length = 0;
          return true;
        }
        if (token.type === 'command' && token.value === '\\tag') {
          this.consume();
          this.readTag();
          return true;
        }
        if (token.type === 'command' && token.value === '\\label') {
          this.consume();
          this.discardGroup();
          return true;
        }
        if (token.type === 'command' && (token.value === '\\notag' || token.value === '\\nonumber')) {
          this.consume();
          return true;
        }
        if (token.type === 'ampersand') {
          this.consume();
          atoms.push(makeRun('&'));
          return true;
        }
        return false;
      },
    );

    const row = remaining.join('');
    const number = this.rowNumber(numberRows, row);
    if (remaining.length > 0) {
      rows.push('<m:e>' + row + number + '</m:e>');
    }

    return rows.join('');
  }

  /** Read a \tag's star and group, after the \tag, as the tag to write. */
  private readTag(): void {
    const star = this.consumeStarVariant();
    const onUnknownCommand = this.onUnknownCommand;
    this.onUnknownCommand = undefined;
    try {
      const text = this.extractText(this.parseGroupIn('text')).trim();
      // A \tag* with a # in it is dropped, as before: Word's number of it, a
      // # and its text, would hold another #, which import can't tell from
      // the number's (see rowNumber in omml.ts)
      this.tag = star && text.includes('#') ? undefined : { text, star };
    } finally {
      this.onUnknownCommand = onUnknownCommand;
    }
  }

  /**
   * Word's number for a row ending here, `row`, from the tag read in it, if
   * rows are numbered. A row with nothing to number drops it, as before, as
   * import reads a # with nothing before it as no number.
   */
  private rowNumber(numberRows: boolean, row: string): string {
    if (!numberRows || !this.numbered || !this.tag) return '';
    const tag = this.tag;
    this.tag = undefined;
    return shows(row) ? equationNumberOmml(tag) : '';
  }

  /**
   * `omml`, a whole equation, as a row of an equation array with its number
   * when a \tag in it is no row's, as Word numbers an equation; dropped
   * where it isn't numbered, as in inline math.
   */
  numberedEquation(omml: string): string {
    const tag = this.tag;
    this.tag = undefined;
    if (!this.numbered || !tag || !shows(omml)) return omml;
    return '<m:eqArr><m:e>' + omml + equationNumberOmml(tag) + '</m:e></m:eqArr>';
  }

  private parseUntilEnd(): string {
    return this.parseAtoms(
      (t) => t.type === 'command' && t.value === '\\end',
    ).join('');
  }

  private consumeEnd(_envName: string): void {
    // Consume \end
    if (this.peek()?.type === 'command' && this.peek()?.value === '\\end') {
      this.consume();
      // Consume {envName}
      this.parseGroup();
    }
  }

  /** The character for a \\left or \\right delimiter command, reporting one it doesn't know. */
  private delimiterCommandChr(cmd: string): string {
    const chr = LATEX_UNICODE_MAP.get(cmd);
    if (chr !== undefined) return chr;
    this.onUnknownCommand?.(cmd);
    return cmd.slice(1);
  }

  /** Parse a group whose content is dropped, such as a \\label, without reporting its commands. */
  private discardGroup(): void {
    const onUnknownCommand = this.onUnknownCommand;
    this.onUnknownCommand = undefined;
    try {
      this.parseGroup();
    } finally {
      this.onUnknownCommand = onUnknownCommand;
    }
  }

  /**
   * Parse a group as styled text, such as the argument of \mathbf. Its
   * comments stay as hidden runs between the styled runs.
   */
  private styleGroup(style: (text: string) => string): string {
    return restyleAroundRevisions(this.parseGroupIn('styled'), omml => omml.split(HIDDEN_RUN_RE).map((part, i) => {
      if (i % 2 === 1) return part;
      const { text, preserve } = styledText(part, this.extractText(part));
      if (!text) return '';
      return preserve ? style(text).replace(/<m:t>/g, '<m:t xml:space="preserve">') : style(text);
    }).join(''));
  }

  private extractText(omml: string): string {
    // Simple extraction - just get text between <m:t> tags, skipping hidden
    // comment runs (which start with \u200B).
    // NOTE: <m:t> content has already been escaped via escapeXmlChars().
    const matches = [...omml.matchAll(/<m:t(?: xml:space="preserve")?>(?!\u200B)([^<]*)<\/m:t>/g)];
    return unescapeXmlChars(matches.map(m => m[1]).join(''));
  }

  /** Parse tokens until the stop condition triggers.
   *  When called from parseGroup(), stop at rbrace (matching the opening lbrace).
   *  When called at the top level from latexToOmml(), parse until EOF. */
  parseExpression(stopAtRbrace = true): string {
    const shouldStop = stopAtRbrace ? (t: Token) => t.type === 'rbrace' : () => false;
    return this.parseAtoms(shouldStop).join('');
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Convert a LaTeX math string to OMML XML string. `onUnknownCommand` hears
 * each command or environment that has no OMML form and is exported as
 * literal text. In `display` math a \tag is Word's equation number.
 */
export function latexToOmml(latex: string, onUnknownCommand?: (command: string) => void, display = false): string {
  if (!latex.trim()) {
    return '';
  }

  const tokens = tokenize(latex);
  const parser = new Parser(tokens, onUnknownCommand, 'math');
  parser.numbered = display;
  return parser.numberedEquation(parser.parseExpression(false));
}

/**
 * As latexToOmml, with each CRITIC_INSERTION_COMMAND or CRITIC_DELETION_COMMAND
 * span's OMML passed through `track`.
 */
export function trackedLatexToOmml(latex: string, track: TrackChange, onUnknownCommand?: (command: string) => void, display = false): string {
  if (!latex.trim()) {
    return '';
  }
  const parser = new Parser(tokenize(latex), onUnknownCommand, 'math', track);
  parser.numbered = display;
  return keepWhitespaceChanges(parser.numberedEquation(parser.parseExpression(false)));
}

/** The mark on the w:ins or w:del of a tracked change whose source is only
 *  whitespace, as {++ ++} is (see keepWhitespaceChanges) */
const WHITESPACE_CHANGE_MARK = ' mm:whitespace=""';

/** A marked tracked change (see WHITESPACE_CHANGE_MARK), its runs styled or
 *  not, and preserved already where \text{} writes them */
const WHITESPACE_CHANGE_RE = /(<w:(ins|del)) mm:whitespace=""([^>]*>)((?:<m:r>(?:<m:rPr>(?:<m:\w+(?: [^>]*)?\/>)*<\/m:rPr>)?<m:t(?: xml:space="preserve")?>[ \t\r\n]+<\/m:t><\/m:r>)*)(?=<\/w:\2>)/g;

/** `omml` with the runs of each tracked change whose source is only
 *  whitespace given xml:space="preserve", which Word otherwise drops: the
 *  whitespace is what it changes, so Word keeps it rather than leave the
 *  change empty. The whitespace around a command, as in {++ \quad ++} or
 *  {++ \! ++}, is the source's padding, which Word drops, as it does where the
 *  change is accepted. This follows the parse, which can restyle the runs of
 *  a change, as \mathbf{} does. A mark this leaves, on a change it doesn't
 *  match, goes too, so that the change stays one Word can track in place. */
function keepWhitespaceChanges(omml: string): string {
  return omml.replace(WHITESPACE_CHANGE_RE, (_change, open: string, _element: string, rest: string, runs: string) =>
    open + rest + runs.replace(/<m:t>/g, '<m:t xml:space="preserve">')).split(WHITESPACE_CHANGE_MARK).join('');
}
