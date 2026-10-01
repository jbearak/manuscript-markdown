// src/latex-to-omml.ts — LaTeX-to-OMML translation module
//
// --- Implementation notes ---
// - Script binding: ^/_ applies to nearest preceding atom, not the whole expression;
//   attach body scripts inside n-ary <m:e> for \sum/\int
// - Delimiter parsing (\left...\right): if right-delimiter token is combined text like
//   )+c, re-insert trailing text into token stream after consuming the delimiter
// - Delimiter inner parsing: script operators inside \left...\right must use
//   script-binding logic, not literal text runs

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
  // One-way entries: omml.ts maps these characters back to the canonical
  // spelling above, except ′, which it keeps (f\prime renders a full-size prime)
  ['\\prime', '′'],
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
  'arg', 'hom', 'ker',
]);

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

function makeStyledRun(text: string): string {
  return '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>' + escapeXmlChars(text) + '</m:t></m:r>';
}

function makeHiddenCommentRun(text: string): string {
  return '<m:r><m:rPr><m:nor/></m:rPr><w:rPr><w:vanish/></w:rPr><m:t xml:space="preserve">\u200B' + escapeXmlChars(text) + '</m:t></m:r>';
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
  
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
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
        return makeRun(first);
      }
      return this.parseToken(next);
    }
  }

  private parseToken(token: Token): string {
      switch (token.type) {
        case 'command':
          return this.parseCommand(token.value);
        case 'text':
          return makeRun(token.value);
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
      return '<m:acc><m:accPr><m:chr m:val="' + escapeXmlChars(accent) + '"/></m:accPr><m:e>' + base + '</m:e></m:acc>';
    }

    // Functions
    if (KNOWN_FUNCTIONS.has(cmd.slice(1))) {
      const arg = this.parseBracketedOperand() ?? this.parseGroup();
      return '<m:func><m:fName>' + makeStyledRun(cmd.slice(1)) + '</m:fName><m:e>' + arg + '</m:e></m:func>';
    }

    switch (cmd) {
      case '\\frac': {
        const num = this.parseGroup();
        const den = this.parseGroup();
        return '<m:f><m:num>' + num + '</m:num><m:den>' + den + '</m:den></m:f>';
      }

      case '\\sqrt': {
        // Check for optional argument [n]
        if (this.peek()?.type === 'text' && this.peek()?.value.startsWith('[')) {
          const token = this.consume()!;
          const match = token.value.match(/^\[([^\]]*)\](.*)$/);
          if (match) {
            const deg = match[1];
            const remaining = match[2];
            if (remaining) {
              // Put back remaining text
              this.tokens.splice(this.pos, 0, { type: 'text', value: remaining, pos: token.pos });
            }
            const radicand = this.parseGroup();
            return '<m:rad><m:deg>' + makeRun(deg) + '</m:deg><m:e>' + radicand + '</m:e></m:rad>';
          }
        }
        const radicand = this.parseGroup();
        return '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>' + radicand + '</m:e></m:rad>';
      }

      case '\\left':
        return this.parseDelimiter();

      case '\\begin':
        return this.parseEnvironment();

      case '\\mathrm': {
        const text = this.parseGroup();
        return makeStyledRun(this.extractText(text));
      }

      case '\\mathcal': {
        const calText = this.parseGroup();
        return makeCalligraphicRun(this.extractText(calText));
      }

      case '\\operatorname': {
        // Intentionally consumes a following group as the function argument,
        // mirroring KNOWN_FUNCTIONS (e.g. \sin{x}) for round-trip fidelity
        // with the OMML→LaTeX direction which emits \operatorname{name}{arg}.
        const name = this.parseGroup();
        const funcArg = this.parseBracketedOperand() ?? this.parseGroup();
        return '<m:func><m:fName>' + makeStyledRun(this.extractText(name)) + '</m:fName><m:e>' + funcArg + '</m:e></m:func>';
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
      case '\\text': {
        const textContent = this.parseGroup();
        return makeStyledRun(this.extractText(textContent));
      }

      // \boxed{}
      case '\\boxed': {
        const boxContent = this.parseGroup();
        return '<m:borderBox><m:e>' + boxContent + '</m:e></m:borderBox>';
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

      // Tags and labels (silently consumed)
      case '\\tag': {
        this.consumeStarVariant();
        this.parseGroup();
        return '';
      }

      case '\\label': {
        this.parseGroup();
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
      case '\\shortintertext': {
        const itContent = this.parseGroup();
        return makeStyledRun(this.extractText(itContent));
      }

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
        // Unsupported command - fallback
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
    return '<m:nary><m:naryPr><m:chr m:val="' + escapeXmlChars(naryChar) + '"/>' + limits + hide + '</m:naryPr>' +
      '<m:sub>' + sub + '</m:sub><m:sup>' + sup + '</m:sup><m:e>' + body + '</m:e></m:nary>';
  }

  /**
   * Parse a `(…)` or `[…]` group that directly follows an n-ary operator or a
   * function name as that construct's whole operand, so the m:e holds the
   * group instead of just its opening bracket. Returns undefined, leaving the
   * token stream untouched, unless the bracket closes within the current
   * brace group, \left…\right pair, row, and cell.
   */
  private parseBracketedOperand(): string | undefined {
    let start = this.pos;
    while (this.tokens[start]?.type === 'text' && this.tokens[start].value.trim() === '') start++;
    const first = this.tokens[start];
    if (first?.type !== 'text') return undefined;
    const lead = first.value.length - first.value.trimStart().length;
    const open = first.value.charAt(lead);
    const close = open === '(' ? ')' : open === '[' ? ']' : '';
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
      if (token.type === 'ampersand' || (token.type === 'command' && token.value === '\\\\')) {
        return undefined;
      }
      if (token.type !== 'text') continue;

      // The character right after \right is that command's delimiter.
      const prev = this.tokens[i - 1];
      const skipDelimiter = prev?.type === 'command' && prev.value === '\\right';
      for (let j = i === start ? lead : skipDelimiter ? 1 : 0; j < token.value.length; j++) {
        const ch = token.value.charAt(j);
        if (ch === open) {
          depth++;
        } else if (ch === close && --depth === 0) {
          const operand = this.tokens.slice(start, i + 1).map(t => ({ ...t }));
          operand[operand.length - 1].value = operand[operand.length - 1].value.slice(0, j + 1);
          operand[0].value = operand[0].value.slice(lead);
          const rest = token.value.slice(j + 1);
          this.tokens.splice(this.pos, i + 1 - this.pos, ...(rest ? [{ type: 'text' as const, value: rest, pos: token.pos + j + 1 }] : []));
          return new Parser(operand).parseExpression(false);
        }
      }
    }
    return undefined;
  }

  private parseDelimiter(): string {
    const leftToken = this.consume();
    if (!leftToken) return '';

    let begChr = '(';
    let content = '';

    if (leftToken.type === 'text') {
      // The delimiter and content might be combined in one token like "(x"
      begChr = leftToken.value.charAt(0);
      if (begChr === '.') begChr = ''; // \left. → invisible delimiter
      const remaining = leftToken.value.slice(1);
      if (remaining) {
        this.tokens.splice(this.pos, 0, { type: 'text', value: remaining, pos: leftToken.pos });
      }
    } else if (leftToken.type === 'command') {
      switch (leftToken.value) {
        case '\\{': begChr = '{'; break;
        case '\\|': begChr = '\u2016'; break;
        case '\\[': begChr = '['; break;
        default: begChr = leftToken.value.slice(1); break;
      }
    }

    // Parse any additional content until \\right
    content += this.parseUntilRight();

    const rightCmd = this.peek();
    if (!(rightCmd?.type === 'command' && rightCmd.value === '\\right')) {
      // Malformed input (missing \right): fall back to emitting the open delimiter + content.
      return makeRun(begChr) + content;
    }

    this.consume(); // consume \\right

    const delimToken = this.consume();
    if (!delimToken) {
      // Malformed input (missing \right delimiter): fall back to emitting the open delimiter + content.
      return makeRun(begChr) + content;
    }

    let endChr = ')';
    if (delimToken.type === 'text') {
      endChr = delimToken.value.charAt(0);
      if (endChr === '.') endChr = ''; // \right. → invisible delimiter
      const remaining = delimToken.value.slice(1);
      if (remaining) {
        this.tokens.splice(this.pos, 0, { type: 'text', value: remaining, pos: delimToken.pos });
      }
    } else if (delimToken.type === 'command') {
      switch (delimToken.value) {
        case '\\}': endChr = '}'; break;
        case '\\|': endChr = '\u2016'; break;
        case '\\]': endChr = ']'; break;
        default: endChr = delimToken.value.slice(1); break;
      }
    }

    return '<m:d><m:dPr><m:begChr m:val="' + escapeXmlChars(begChr) + '"/><m:endChr m:val="' + escapeXmlChars(endChr) + '"/></m:dPr><m:e>' + content + '</m:e></m:d>';
  }

  /** Consume a `*` prefix from the next text token (for `\tag*` variants). */
  private consumeStarVariant(): void {
    if (this.peek()?.type === 'text' && this.peek()?.value.startsWith('*')) {
      const starToken = this.consume()!;
      const rest = starToken.value.slice(1);
      if (rest) {
        this.tokens.splice(this.pos, 0, { type: 'text', value: rest, pos: starToken.pos });
      }
    }
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
        atoms.push(this.parseGroup());
      } else {
        const consumed = this.consume()!;
        if (consumed.type === 'text') {
          // TeX ignores source whitespace before a script, so the script binds
          // to the atom before the space. Spacing commands such as \quad are
          // not text tokens and keep their runs.
          const next = this.peek();
          const beforeScript = next?.type === 'caret' || next?.type === 'underscore';
          for (const ch of beforeScript ? consumed.value.replace(/[ \t\r\n]+$/, '') : consumed.value) {
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

  private parseUntilRight(): string {
    return this.parseAtoms(
      (t) => t.type === 'command' && t.value === '\\right',
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

      case 'align':
      case 'align*':
      case 'aligned':
      case 'gather':
      case 'gather*':
      case 'gathered':
      case 'split':
      case 'multline':
      case 'multline*':
      case 'flalign':
      case 'flalign*': {
        const content = this.parseEqArrayContent();
        this.consumeEnd(envName);
        return '<m:eqArr>' + content + '</m:eqArr>';
      }

      case 'alignat':
      case 'alignat*': {
        // Consume {n} column count argument
        if (this.peek()?.type === 'lbrace') {
          this.parseGroup();
        }
        const content = this.parseEqArrayContent();
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

      default:
        return makeRun('\\begin{' + envName + '}');
    }
  }

  private parseDelimitedMatrix(envName: string, begChr: string, endChr: string): string {
    const content = this.parseMatrixContent();
    this.consumeEnd(envName);
    return '<m:d><m:dPr><m:begChr m:val="' + escapeXmlChars(begChr) + '"/><m:endChr m:val="' + escapeXmlChars(endChr) + '"/></m:dPr><m:e><m:m>' + content + '</m:m></m:e></m:d>';
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

  private parseEqArrayContent(): string {
    const rows: string[] = [];

    const remaining = this.parseAtoms(
      (t) => t.type === 'command' && t.value === '\\end',
      (token, atoms) => {
        if (token.type === 'command' && token.value === '\\\\') {
          this.consume();
          rows.push('<m:e>' + atoms.join('') + '</m:e>');
          atoms.length = 0;
          return true;
        }
        if (token.type === 'command' && (token.value === '\\tag' || token.value === '\\label')) {
          this.consume();
          if (token.value === '\\tag') this.consumeStarVariant();
          this.parseGroup(); // consume argument, emit nothing
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

    if (remaining.length > 0) {
      rows.push('<m:e>' + remaining.join('') + '</m:e>');
    }

    return rows.join('');
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

  private extractText(omml: string): string {
    // Simple extraction - just get text between <m:t> tags.
    // NOTE: <m:t> content has already been escaped via escapeXmlChars().
    const matches = omml.match(/<m:t>([^<]*)<\/m:t>/g);
    if (matches) {
      const escaped = matches.map(m => m.replace(/<\/?m:t>/g, '')).join('');
      return unescapeXmlChars(escaped);
    }
    return '';
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

/** Convert a LaTeX math string to OMML XML string. */
export function latexToOmml(latex: string): string {
  if (!latex.trim()) {
    return '';
  }

  const tokens = tokenize(latex);
  const parser = new Parser(tokens);
  return parser.parseExpression(false);
}
