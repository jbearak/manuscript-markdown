// src/latex-to-omml.ts — LaTeX-to-OMML translation module

// ---------------------------------------------------------------------------
// Reverse mapping tables from omml.ts
// ---------------------------------------------------------------------------

const LATEX_UNICODE_MAP: Map<string, string> = new Map([
  // Greek lowercase
  ['\\alpha', 'α'], ['\\beta', 'β'], ['\\gamma', 'γ'], ['\\delta', 'δ'],
  ['\\epsilon', 'ε'], ['\\zeta', 'ζ'], ['\\eta', 'η'], ['\\theta', 'θ'],
  ['\\iota', 'ι'], ['\\kappa', 'κ'], ['\\lambda', 'λ'], ['\\mu', 'μ'],
  ['\\nu', 'ν'], ['\\xi', 'ξ'], ['\\pi', 'π'], ['\\rho', 'ρ'],
  ['\\sigma', 'σ'], ['\\tau', 'τ'], ['\\upsilon', 'υ'], ['\\phi', 'φ'],
  ['\\chi', 'χ'], ['\\psi', 'ψ'], ['\\omega', 'ω'],
  // Greek uppercase
  ['\\Gamma', 'Γ'], ['\\Delta', 'Δ'], ['\\Theta', 'Θ'], ['\\Lambda', 'Λ'],
  ['\\Xi', 'Ξ'], ['\\Pi', 'Π'], ['\\Sigma', 'Σ'], ['\\Phi', 'Φ'],
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
  ['\\cdot', '·'], ['\\ldots', '…'], ['\\cdots', '⋯'],
]);

const LATEX_ACCENT_MAP: Map<string, string> = new Map([
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

function makeRun(text: string): string {
  return '<m:r><m:t>' + text + '</m:t></m:r>';
}

function makeStyledRun(text: string): string {
  return '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>' + text + '</m:t></m:r>';
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  type: 'command' | 'lbrace' | 'rbrace' | 'caret' | 'underscore' | 'ampersand' | 'backslash' | 'text';
  value: string;
  pos: number;
}

function tokenize(latex: string): Token[] {
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
    } else {
      // Regular text
      let j = i;
      while (j < latex.length && !/[\\{}^_&]/.test(latex[j])) {
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
    const token = this.peek();
    if (token?.type === 'lbrace') {
      this.consume(); // consume '{'
      const content = this.parseExpression();
      const close = this.peek();
      if (close?.type === 'rbrace') {
        this.consume(); // consume '}'
      }
      return content;
    } else {
      // Single token
      const next = this.consume();
      if (next) {
        return this.parseToken(next);
      }
      return '';
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
      default:
        return '';
    }
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
      return '<m:acc><m:accPr><m:chr m:val="' + accent + '"/></m:accPr><m:e>' + base + '</m:e></m:acc>';
    }

    // Functions
    if (KNOWN_FUNCTIONS.has(cmd.slice(1))) {
      const arg = this.parseGroup();
      return '<m:func><m:fName>' + makeStyledRun(cmd.slice(1)) + '</m:fName><m:e>' + arg + '</m:e></m:func>';
    }

    switch (cmd) {
      case '\\frac':
        const num = this.parseGroup();
        const den = this.parseGroup();
        return '<m:f><m:num>' + num + '</m:num><m:den>' + den + '</m:den></m:f>';

      case '\\sqrt':
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

      case '\\left':
        return this.parseDelimiter();

      case '\\begin':
        return this.parseEnvironment();

      case '\\mathrm':
        const text = this.parseGroup();
        return makeStyledRun(this.extractText(text));

      case '\\operatorname':
        const name = this.parseGroup();
        const funcArg = this.parseGroup();
        return '<m:func><m:fName>' + makeStyledRun(this.extractText(name)) + '</m:fName><m:e>' + funcArg + '</m:e></m:func>';

      case '\\limits':
        // This should be handled by nary parsing, but if encountered alone, ignore
        return '';

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
    if (this.peek()?.type === 'command' && this.peek()?.value === '\\limits') {
      this.consume();
      limits = '<m:limLoc m:val="undOvr"/>';
    }

    // Parse subscript and superscript
    while (this.peek() && (this.peek()?.type === 'underscore' || this.peek()?.type === 'caret')) {
      const token = this.consume()!;
      if (token.type === 'underscore') {
        sub = '<m:sub>' + this.parseGroup() + '</m:sub>';
      } else if (token.type === 'caret') {
        sup = '<m:sup>' + this.parseGroup() + '</m:sup>';
      }
    }

    const body = this.parseExpression();
    
    return '<m:nary><m:naryPr><m:chr m:val="' + naryChar + '"/>' + limits + '</m:naryPr>' + sub + sup + '<m:e>' + body + '</m:e></m:nary>';
  }

  private parseDelimiter(): string {
    const leftToken = this.consume();
    if (!leftToken) return '';

    let begChr = '(';
    let content = '';
    
    if (leftToken.type === 'text') {
      // The delimiter and content might be combined in one token like "(x"
      begChr = leftToken.value.charAt(0);
      const remaining = leftToken.value.slice(1);
      if (remaining) {
        content = makeRun(remaining);
      }
    } else if (leftToken.type === 'command') {
      switch (leftToken.value) {
        case '\\{': begChr = '{'; break;
        case '\\|': begChr = '|'; break;
        case '\\[': begChr = '['; break;
        default: begChr = leftToken.value.slice(1); break;
      }
    }

    // Parse any additional content until \right
    content += this.parseUntilRight();
    
    const rightToken = this.consume(); // consume \right
    const delimToken = this.consume();
    let endChr = ')';
    if (delimToken?.type === 'text') {
      endChr = delimToken.value.charAt(0);
    } else if (delimToken?.type === 'command') {
      switch (delimToken.value) {
        case '\\}': endChr = '}'; break;
        case '\\|': endChr = '|'; break;
        case '\\]': endChr = ']'; break;
        default: endChr = delimToken.value.slice(1); break;
      }
    }

    return '<m:d><m:dPr><m:begChr m:val="' + begChr + '"/><m:endChr m:val="' + endChr + '"/></m:dPr><m:e>' + content + '</m:e></m:d>';
  }

  private parseUntilRight(): string {
    let content = '';
    while (this.peek() && !(this.peek()?.type === 'command' && this.peek()?.value === '\\right')) {
      const token = this.consume()!;
      content += this.parseToken(token);
    }
    return content;
  }

  private parseEnvironment(): string {
    const envToken = this.parseGroup();
    const envName = this.extractText(envToken);

    if (envName === 'matrix') {
      const content = this.parseMatrixContent();
      // Consume \end{matrix}
      this.consumeEnd('matrix');
      return '<m:m>' + content + '</m:m>';
    }

    // Unsupported environment
    return makeRun('\\begin{' + envName + '}');
  }

  private parseMatrixContent(): string {
    let rows = '';
    let currentCell = '';
    let currentRowCells = '';

    while (this.peek() && !(this.peek()?.type === 'command' && this.peek()?.value === '\\end')) {
      const token = this.consume()!;
      
      if (token.type === 'ampersand') {
        currentRowCells += '<m:e>' + currentCell + '</m:e>';
        currentCell = '';
      } else if (token.type === 'command' && token.value === '\\\\') {
        currentRowCells += '<m:e>' + currentCell + '</m:e>';
        rows += '<m:mr>' + currentRowCells + '</m:mr>';
        currentCell = '';
        currentRowCells = '';
      } else {
        currentCell += this.parseToken(token);
      }
    }

    if (currentCell || currentRowCells) {
      currentRowCells += '<m:e>' + currentCell + '</m:e>';
      rows += '<m:mr>' + currentRowCells + '</m:mr>';
    }

    return rows;
  }

  private consumeEnd(envName: string): void {
    // Consume \end
    if (this.peek()?.type === 'command' && this.peek()?.value === '\\end') {
      this.consume();
      // Consume {envName}
      this.parseGroup();
    }
  }

  private extractText(omml: string): string {
    // Simple extraction - just get text between <m:t> tags
    const matches = omml.match(/<m:t>([^<]*)<\/m:t>/g);
    if (matches) {
      return matches.map(m => m.replace(/<\/?m:t>/g, '')).join('');
    }
    return '';
  }

  parseExpression(): string {
    let result = '';
    
    while (this.peek()) {
      const token = this.peek();
      
      if (token?.type === 'rbrace') {
        break;
      }

      if (token?.type === 'caret' || token?.type === 'underscore') {
        // Handle superscript/subscript - need a base first
        if (!result) {
          // No base, treat as regular text
          const consumed = this.consume()!;
          result += this.parseToken(consumed);
          continue;
        }

        const hasSuper = token.type === 'caret';
        const hasSuber = token.type === 'underscore';
        
        this.consume(); // consume ^ or _
        const firstScript = this.parseGroup();
        
        // Check for combined sub/superscript
        const nextToken = this.peek();
        if (nextToken && ((hasSuper && nextToken.type === 'underscore') || (hasSuber && nextToken.type === 'caret'))) {
          this.consume(); // consume the second script operator
          const secondScript = this.parseGroup();
          
          if (hasSuper) {
            // x^{a}_{b} -> sSubSup
            result = '<m:sSubSup><m:e>' + result + '</m:e><m:sub>' + secondScript + '</m:sub><m:sup>' + firstScript + '</m:sup></m:sSubSup>';
          } else {
            // x_{a}^{b} -> sSubSup  
            result = '<m:sSubSup><m:e>' + result + '</m:e><m:sub>' + firstScript + '</m:sub><m:sup>' + secondScript + '</m:sup></m:sSubSup>';
          }
        } else {
          // Single script
          if (hasSuper) {
            result = '<m:sSup><m:e>' + result + '</m:e><m:sup>' + firstScript + '</m:sup></m:sSup>';
          } else {
            result = '<m:sSub><m:e>' + result + '</m:e><m:sub>' + firstScript + '</m:sub></m:sSub>';
          }
        }
      } else {
        const consumed = this.consume()!;
        result += this.parseToken(consumed);
      }
    }
    
    return result;
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
  return parser.parseExpression();
}