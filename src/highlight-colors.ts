import { findMatchingClose } from './critic-markup';

// --- Implementation notes ---
// - ==text=={color} is unambiguous with CriticMarkup {==text==} (brace is before ==, not after)
// - Config access: module-level get/set passes VS Code settings to markdown-it plugin
//   without importing vscode
// - Fallback hierarchy: configured default → yellow/amber; keep preview/editor aligned
// - Deletion styling: no explicit foreground; strikethrough only, let theme drive foreground
// - Comment styling: no explicit foreground; background + italic only
// - TextMate inline highlight regex: exclude = inside ==...== captures ([^}=]+) for
//   multi-span tokenization
// - extractCriticDelimiterRanges(): skip comment/highlight delimiters so decoration
//   doesn't override TextMate scopes
// - extractAllDecorationRanges(): preserve extractHighlightRanges() behavior for ==...==
//   inside any CriticMarkup span
// - Comment token scope: use meta.comment* not comment.block* — comment.block suppresses
//   editor features (bracket matching, auto-complete, snippets)

/** Canonical color name → hex value mapping for Word highlight colors */
export const HIGHLIGHT_COLORS: Record<string, string> = {
  'yellow':      '#FFFF00',
  'green':       '#00FF00',
  'turquoise':   '#00FFFF',
  'pink':        '#FF00FF',
  'blue':        '#0000FF',
  'red':         '#FF0000',
  'dark-blue':   '#000080',
  'teal':        '#008080',
  'violet':      '#800080',
  'dark-red':    '#800000',
  'dark-yellow': '#808000',
  'gray-50':     '#808080',
  'gray-25':     '#C0C0C0',
  'black':       '#000000',
};

/**
 * Reverse mapping: OOXML ST_HighlightColor values → Manuscript Markdown color names.
 * This is the inverse of COLOR_TO_OOXML in md-to-docx.ts.
 */
export const OOXML_TO_MARKDOWN: Record<string, string> = {
  'yellow': 'yellow', 'green': 'green', 'blue': 'blue', 'red': 'red', 'black': 'black',
  'cyan': 'turquoise', 'magenta': 'pink', 'darkBlue': 'dark-blue',
  'darkCyan': 'teal', 'darkMagenta': 'violet', 'darkRed': 'dark-red',
  'darkYellow': 'dark-yellow', 'darkGray': 'gray-50', 'lightGray': 'gray-25',
};

/** Build a reverse lookup from hex (without #) → markdown color name */
const HEX_TO_MARKDOWN: Record<string, string> = {};
for (const [name, hex] of Object.entries(HIGHLIGHT_COLORS)) {
  HEX_TO_MARKDOWN[hex.slice(1).toUpperCase()] = name;
}

/**
 * Resolve a DOCX highlight color value to a Manuscript Markdown color name.
 * Accepts OOXML ST_HighlightColor names (e.g. "cyan", "darkBlue") or
 * hex RGB values from w:shd (e.g. "00FF00", "#00FF00").
 * Returns undefined if the value cannot be mapped.
 */
export function resolveMarkdownColor(docxColor: string): string | undefined {
  // Check OOXML named colors first
  const named = OOXML_TO_MARKDOWN[docxColor];
  if (named) return named;

  // Try as hex value (strip optional # prefix)
  const hex = docxColor.replace(/^#/, '').toUpperCase();
  return HEX_TO_MARKDOWN[hex];
}

/** Theme-aware background colors for editor decorations */
export const HIGHLIGHT_DECORATION_COLORS: Record<string, { light: string; dark: string }> = {
  'yellow':      { light: 'rgba(255, 255, 0, 0.40)',   dark: 'rgba(255, 255, 0, 0.25)' },
  'green':       { light: 'rgba(0, 255, 0, 0.30)',     dark: 'rgba(0, 255, 0, 0.20)' },
  'turquoise':   { light: 'rgba(0, 255, 255, 0.35)',   dark: 'rgba(0, 255, 255, 0.20)' },
  'pink':        { light: 'rgba(255, 0, 255, 0.25)',   dark: 'rgba(255, 0, 255, 0.20)' },
  'blue':        { light: 'rgba(0, 0, 255, 0.20)',     dark: 'rgba(0, 0, 255, 0.30)' },
  'red':         { light: 'rgba(255, 0, 0, 0.25)',     dark: 'rgba(255, 0, 0, 0.25)' },
  'dark-blue':   { light: 'rgba(0, 0, 128, 0.25)',     dark: 'rgba(0, 0, 128, 0.40)' },
  'teal':        { light: 'rgba(0, 128, 128, 0.25)',   dark: 'rgba(0, 128, 128, 0.35)' },
  'violet':      { light: 'rgba(128, 0, 128, 0.25)',   dark: 'rgba(128, 0, 128, 0.35)' },
  'dark-red':    { light: 'rgba(128, 0, 0, 0.25)',     dark: 'rgba(128, 0, 0, 0.40)' },
  'dark-yellow': { light: 'rgba(128, 128, 0, 0.30)',   dark: 'rgba(128, 128, 0, 0.35)' },
  'gray-50':     { light: 'rgba(128, 128, 128, 0.30)', dark: 'rgba(128, 128, 128, 0.35)' },
  'gray-25':     { light: 'rgba(192, 192, 192, 0.40)', dark: 'rgba(192, 192, 192, 0.25)' },
  'black':       { light: 'rgba(0, 0, 0, 0.15)',       dark: 'rgba(0, 0, 0, 0.40)' },
};

/** Theme-aware background for CriticMarkup highlights and comments */
export const CRITIC_COMMENT_DECORATION = {
  light: 'rgba(200, 200, 200, 0.35)',
  dark: 'rgba(200, 200, 200, 0.20)',
};

/** All valid color identifiers */
export const VALID_COLOR_IDS = Object.keys(HIGHLIGHT_COLORS);

/** Module-level default highlight color, updated from VS Code settings */
let _defaultHighlightColor = 'yellow';
export function setDefaultHighlightColor(color: string): void {
  _defaultHighlightColor = VALID_COLOR_IDS.includes(color) ? color : 'yellow';
}
export function getDefaultHighlightColor(): string {
  return _defaultHighlightColor;
}

/**
 * Replace all paired CriticMarkup delimiters with spaces, preserving string length.
 * This allows the format-highlight regex (`==...==`) to match across CriticMarkup
 * blocks without being blocked by `=` or `}` characters in the delimiters.
 *
 * Handles all five CriticMarkup delimiter pairs:
 *   {== ==}  (highlight)   — indexOf pairing
 *   {>> <<}  (comment)     — findMatchingClose (depth-aware, supports nesting)
 *   {++ ++}  (addition)    — indexOf pairing
 *   {-- --}  (deletion)    — indexOf pairing
 *   {~~ ~~}  (substitution) — indexOf pairing
 *
 * Only the 3-char open/close markers are replaced; content is left intact.
 * This preserves string length so character offsets map 1:1 back to the original.
 *
 * Example — format highlight inside critic:
 *   input:  "{==sentence with ==highlighted== word==}{>>comment<<}"
 *   masked: "   sentence with ==highlighted== word      comment   "
 *   → the regex finds ==highlighted== at the correct offset
 *
 * Example — critic inside format highlight:
 *   input:  "==text with {==commented==}{>>comment<<} more=="
 *   masked: "==text with    commented      comment    more=="
 *   → the regex finds the outer ==...== spanning the whole string
 */
export function maskCriticDelimiters(text: string): string {
  const chars = text.split('');
  const mask = (start: number, len: number) => {
    for (let j = start; j < start + len; j++) chars[j] = ' ';
  };
  const len = text.length;
  let i = 0;
  while (i < len) {
    if (text.charCodeAt(i) === 0x7B && i + 2 < len) { // '{'
      const c2 = text.charCodeAt(i + 1);
      const c3 = text.charCodeAt(i + 2);

      if (c2 === 0x3D && c3 === 0x3D) { // {==
        const ci = text.indexOf('==}', i + 3);
        if (ci !== -1) {
          mask(i, 3);
          mask(ci, 3);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x3E && c3 === 0x3E) { // {>>
        const ci = findMatchingClose(text, i + 3);
        if (ci !== -1) {
          mask(i, 3);
          mask(ci, 3);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x2B && c3 === 0x2B) { // {++
        const ci = text.indexOf('++}', i + 3);
        if (ci !== -1) {
          mask(i, 3);
          mask(ci, 3);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x2D && c3 === 0x2D) { // {--
        const ci = text.indexOf('--}', i + 3);
        if (ci !== -1) {
          mask(i, 3);
          mask(ci, 3);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x7E && c3 === 0x7E) { // {~~
        const ci = text.indexOf('~~}', i + 3);
        if (ci !== -1) {
          mask(i, 3);
          mask(ci, 3);
          i = ci + 3; continue;
        }
      }
    }
    i++;
  }
  return chars.join('');
}

/**
 * Extract highlight ranges from document text, grouped by color key.
 * Returns a Map where keys are color identifiers (or 'critic') and values are offset ranges.
 *
 * Two-phase extraction:
 *   Phase 1 — CriticMarkup highlights `{==...==}`: matched on the original text.
 *   Phase 2 — Format highlights `==...==` with optional `{color}` suffix: matched
 *     on the masked text (see {@link maskCriticDelimiters}) so `=` and `}` in
 *     CriticMarkup delimiters don't block the `[^}=]+` character class.
 *
 * This supports nesting in both directions:
 *   • `{==sentence with ==highlighted== word==}` — format highlight inside critic
 *   • `==text with {==commented==}{>>note<<} more==` — critic inside format highlight
 */
export function extractHighlightRanges(text: string, defaultColor: string): Map<string, Array<{ start: number; end: number }>> {
  const result = new Map<string, Array<{ start: number; end: number }>>();
  const resolvedDefaultColor = VALID_COLOR_IDS.includes(defaultColor) ? defaultColor : 'yellow';
  const push = (key: string, start: number, end: number) => {
    if (!result.has(key)) { result.set(key, []); }
    result.get(key)!.push({ start, end });
  };

  // CriticMarkup highlights {==text==} — content only (skip delimiters)
  const criticRe = /\{==([\s\S]*?)==\}/g;
  let m;
  while ((m = criticRe.exec(text)) !== null) {
    push('critic', m.index + 3, m.index + m[0].length - 3);
  }

  // Colored highlights ==text=={color} and default highlights ==text==
  // Run on masked text so `=` and `}` in CriticMarkup delimiters don't block matches
  const masked = maskCriticDelimiters(text);
  const hlRe = /(?<!\{)==([^}=]+)==(?:\{([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\})?/g;
  while ((m = hlRe.exec(masked)) !== null) {
    const mStart = m.index;
    const mEnd = mStart + m[0].length;

    const colorId = m[2];
    if (colorId && VALID_COLOR_IDS.includes(colorId)) {
      push(colorId, mStart, mEnd);
    } else {
      push(resolvedDefaultColor, mStart, mEnd);
    }
  }

  return result;
}

/**
 * Extract CriticMarkup comment ranges {>>text<<} from document text.
 * Returns an array of offset ranges.
 */
export function extractCommentRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /\{>>([\s\S]*?)<<\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ranges.push({ start: m.index + 3, end: m.index + m[0].length - 3 });
  }
  return ranges;
}

/**
 * Extract CriticMarkup addition content ranges {++text++} (content only, excluding delimiters).
 */
export function extractAdditionRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /\{\+\+([\s\S]*?)\+\+\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + 3;
    const end = m.index + m[0].length - 3;
    if (end > start) { ranges.push({ start, end }); }
  }
  return ranges;
}

/**
 * Extract CriticMarkup deletion content ranges {--text--} (content only, excluding delimiters).
 */
export function extractDeletionRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /\{--([\s\S]*?)--\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + 3;
    const end = m.index + m[0].length - 3;
    if (end > start) { ranges.push({ start, end }); }
  }
  return ranges;
}

/**
 * Extract offset ranges for all CriticMarkup delimiters.
 * Returns ranges for: {== ==} {>> <<} {++ ++} {-- --} {~~ ~~} ~>
 */
export function extractCriticDelimiterRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let m;

  // 3-char opening/closing delimiters
  const threeCharRe = /\{==|==\}|\{>>|<<\}|\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}/g;
  while ((m = threeCharRe.exec(text)) !== null) {
    // Preserve TextMate delimiter coloring for comment and highlight delimiters,
    // including comment-with-ID closers in {#id>>...<<}.
    if (m[0] === '{>>' || m[0] === '<<}' || m[0] === '{==' || m[0] === '==}') {
      continue;
    }
    ranges.push({ start: m.index, end: m.index + 3 });
  }

  // 2-char separator ~> inside substitutions (but not standalone)
  const subRe = /\{~~([\s\S]*?)~~\}/g;
  while ((m = subRe.exec(text)) !== null) {
    const arrowIdx = m[0].indexOf('~>');
    if (arrowIdx !== -1) {
      // Make sure it's not part of the closing ~~}
      const absIdx = m.index + arrowIdx;
      // Verify this ~> is not the ~~ of the closing delimiter
      if (arrowIdx < m[0].length - 3) {
        ranges.push({ start: absIdx, end: absIdx + 2 });
      }
    }
  }

  return ranges;
}

/**
 * For each {~~old~>new~~}, extract the range of the "new" portion (between ~> and ~~}).
 */
export function extractSubstitutionNewRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // m[1] = old text, m[2] = new text
    // Position of ~> is m.index + 3 + m[1].length
    const newStart = m.index + 3 + m[1].length + 2; // skip {~~ + old + ~>
    const newEnd = m.index + m[0].length - 3; // before ~~}
    if (newEnd > newStart) {
      ranges.push({ start: newStart, end: newEnd });
    }
  }
  return ranges;
}

export interface AllDecorationRanges {
  highlights: Map<string, Array<{ start: number; end: number }>>;
  comments: Array<{ start: number; end: number }>;
  additions: Array<{ start: number; end: number }>;
  deletions: Array<{ start: number; end: number }>;
  delimiters: Array<{ start: number; end: number }>;
  substitutionNew: Array<{ start: number; end: number }>;
}

export function extractAllDecorationRanges(text: string, defaultColor: string): AllDecorationRanges {
  const resolvedDefault = VALID_COLOR_IDS.includes(defaultColor) ? defaultColor : 'yellow';
  const highlights = new Map<string, Array<{ start: number; end: number }>>();
  const comments: Array<{ start: number; end: number }> = [];
  const additions: Array<{ start: number; end: number }> = [];
  const deletions: Array<{ start: number; end: number }> = [];
  const delimiters: Array<{ start: number; end: number }> = [];
  const substitutionNew: Array<{ start: number; end: number }> = [];

  const pushHighlight = (key: string, start: number, end: number) => {
    if (!highlights.has(key)) highlights.set(key, []);
    highlights.get(key)!.push({ start, end });
  };

  /**
   * Scan a region of text for format highlights ==...== and ==...=={color}.
   * This is called on CriticMarkup span content to detect nested format highlights.
   * The region is [regionStart, regionEnd) in the original text.
   */
  const scanFormatHighlights = (regionStart: number, regionEnd: number) => {
    let j = regionStart;
    while (j < regionEnd - 3) { // need at least ==X== (4 chars from j)
      // Look for == that is NOT preceded by { at j-1 in the original text
      if (text.charCodeAt(j) === 0x3D && j + 1 < regionEnd && text.charCodeAt(j + 1) === 0x3D) {
        // Check negative lookbehind: not preceded by {
        if (j > 0 && text.charCodeAt(j - 1) === 0x7B) {
          j++;
          continue;
        }
        // Scan forward for content matching [^}=]+ then closing ==
        const contentStart = j + 2;
        let k = contentStart;
        while (k < regionEnd) {
          const ch = text.charCodeAt(k);
          if (ch === 0x7D || ch === 0x3D) break; // } or =
          k++;
        }
        // k now points to first } or = or regionEnd
        // Need at least 1 char of content and closing ==
        if (k > contentStart && k + 1 < regionEnd &&
            text.charCodeAt(k) === 0x3D && text.charCodeAt(k + 1) === 0x3D) {
          // Found closing ==. Check for optional {color} suffix
          const closeEnd = k + 2;
          let matchEnd = closeEnd;
          let colorId: string | undefined;
          if (closeEnd < regionEnd && text.charCodeAt(closeEnd) === 0x7B) { // {
            // Try to parse color suffix {color}
            const braceStart = closeEnd + 1;
            let b = braceStart;
            while (b < regionEnd && text.charCodeAt(b) !== 0x7D) b++; // find }
            if (b < regionEnd) {
              const candidate = text.slice(braceStart, b);
              if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(candidate)) {
                colorId = candidate;
                matchEnd = b + 1;
              }
            }
          }
          if (colorId && VALID_COLOR_IDS.includes(colorId)) {
            pushHighlight(colorId, j, matchEnd);
          } else {
            pushHighlight(resolvedDefault, j, matchEnd);
          }
          j = matchEnd;
          continue;
        }
        // No valid closing == found, advance past the opening ==
        j = contentStart;
        continue;
      }
      j++;
    }
  };

  const len = text.length;
  let i = 0;
  while (i < len) {
    if (text.charCodeAt(i) === 0x7B && i + 2 < len) {
      const c2 = text.charCodeAt(i + 1);
      const c3 = text.charCodeAt(i + 2);

      if (c2 === 0x2B && c3 === 0x2B) { // {++
        const ci = text.indexOf('++}', i + 3);
        if (ci !== -1) {
          delimiters.push({ start: i, end: i + 3 });
          if (ci > i + 3) additions.push({ start: i + 3, end: ci });
          delimiters.push({ start: ci, end: ci + 3 });
          // Scan content for nested format highlights
          scanFormatHighlights(i + 3, ci);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x2D && c3 === 0x2D) { // {--
        const ci = text.indexOf('--}', i + 3);
        if (ci !== -1) {
          delimiters.push({ start: i, end: i + 3 });
          if (ci > i + 3) deletions.push({ start: i + 3, end: ci });
          delimiters.push({ start: ci, end: ci + 3 });
          // Scan content for nested format highlights
          scanFormatHighlights(i + 3, ci);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x7E && c3 === 0x7E) { // {~~
        const ci = text.indexOf('~~}', i + 3);
        if (ci !== -1) {
          delimiters.push({ start: i, end: i + 3 });
          const content = text.slice(i + 3, ci);
          const cai = content.indexOf('~>');
          if (cai !== -1) {
            delimiters.push({ start: i + 3 + cai, end: i + 3 + cai + 2 });
            const newStart = i + 3 + cai + 2;
            if (ci > newStart) substitutionNew.push({ start: newStart, end: ci });
          }
          delimiters.push({ start: ci, end: ci + 3 });
          // Scan content for nested format highlights
          scanFormatHighlights(i + 3, ci);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x3E && c3 === 0x3E) { // {>>
        const ci = findMatchingClose(text, i + 3);
        if (ci !== -1) {
          // Skip comment delimiters (preserves TextMate tag punctuation scopes)
          comments.push({ start: i + 3, end: ci });
          // Scan content for nested format highlights
          scanFormatHighlights(i + 3, ci);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x3D && c3 === 0x3D) { // {==
        const ci = text.indexOf('==}', i + 3);
        if (ci !== -1) {
          // Record critic highlight content range (skip delimiters for TextMate scopes)
          pushHighlight('critic', i + 3, ci);
          // Scan content for nested format highlights
          scanFormatHighlights(i + 3, ci);
          i = ci + 3; continue;
        }
      }
    }

    // Detect format highlights ==...== and ==...=={color} outside CriticMarkup.
    // Must replicate the masking approach: CriticMarkup delimiters ({== ==} {>> <<} etc.)
    // are treated as transparent (as if replaced with spaces), so format highlights can
    // span across CriticMarkup spans.
    if (text.charCodeAt(i) === 0x3D && i + 1 < len && text.charCodeAt(i + 1) === 0x3D) {
      // Check negative lookbehind: not preceded by {
      if (i === 0 || text.charCodeAt(i - 1) !== 0x7B) {
        // Scan forward for content, skipping CriticMarkup delimiters.
        // In the masked approach, delimiters become spaces (which pass [^}=]+).
        // Here we skip over them and check that non-delimiter chars match [^}=]+.
        // When we skip CriticMarkup spans, we also fully process them (record their
        // ranges, delimiters, and nested format highlights) since the main loop will
        // jump past the entire format highlight match.
        //
        // Snapshot array lengths so we can roll back any CriticMarkup ranges pushed
        // during the scan if no valid closing == is found.
        const snapComments = comments.length;
        const snapAdditions = additions.length;
        const snapDeletions = deletions.length;
        const snapDelimiters = delimiters.length;
        const snapSubNew = substitutionNew.length;
        const snapHighlightSizes = new Map<string, number>();
        for (const [key, arr] of highlights) snapHighlightSizes.set(key, arr.length);

        const contentStart = i + 2;
        let k = contentStart;
        let hasContent = false; // at least 1 non-delimiter char
        let found = false;
        while (k < len) {
          // Check for CriticMarkup opening delimiters — process and skip entire spans
          if (text.charCodeAt(k) === 0x7B && k + 2 < len) {
            const d2 = text.charCodeAt(k + 1);
            const d3 = text.charCodeAt(k + 2);
            if (d2 === 0x3D && d3 === 0x3D) { // {==
              const ci = text.indexOf('==}', k + 3);
              if (ci !== -1) {
                pushHighlight('critic', k + 3, ci);
                scanFormatHighlights(k + 3, ci);
                hasContent = true; k = ci + 3; continue;
              }
            } else if (d2 === 0x3E && d3 === 0x3E) { // {>>
              const ci = findMatchingClose(text, k + 3);
              if (ci !== -1) {
                comments.push({ start: k + 3, end: ci });
                scanFormatHighlights(k + 3, ci);
                hasContent = true; k = ci + 3; continue;
              }
            } else if (d2 === 0x2B && d3 === 0x2B) { // {++
              const ci = text.indexOf('++}', k + 3);
              if (ci !== -1) {
                delimiters.push({ start: k, end: k + 3 });
                if (ci > k + 3) additions.push({ start: k + 3, end: ci });
                delimiters.push({ start: ci, end: ci + 3 });
                scanFormatHighlights(k + 3, ci);
                hasContent = true; k = ci + 3; continue;
              }
            } else if (d2 === 0x2D && d3 === 0x2D) { // {--
              const ci = text.indexOf('--}', k + 3);
              if (ci !== -1) {
                delimiters.push({ start: k, end: k + 3 });
                if (ci > k + 3) deletions.push({ start: k + 3, end: ci });
                delimiters.push({ start: ci, end: ci + 3 });
                scanFormatHighlights(k + 3, ci);
                hasContent = true; k = ci + 3; continue;
              }
            } else if (d2 === 0x7E && d3 === 0x7E) { // {~~
              const ci = text.indexOf('~~}', k + 3);
              if (ci !== -1) {
                delimiters.push({ start: k, end: k + 3 });
                const subContent = text.slice(k + 3, ci);
                const cai = subContent.indexOf('~>');
                if (cai !== -1) {
                  delimiters.push({ start: k + 3 + cai, end: k + 3 + cai + 2 });
                  const newStart = k + 3 + cai + 2;
                  if (ci > newStart) substitutionNew.push({ start: newStart, end: ci });
                }
                delimiters.push({ start: ci, end: ci + 3 });
                scanFormatHighlights(k + 3, ci);
                hasContent = true; k = ci + 3; continue;
              }
            }
          }
          const ch = text.charCodeAt(k);
          if (ch === 0x3D) { // =
            // Check for closing ==
            if (k + 1 < len && text.charCodeAt(k + 1) === 0x3D) {
              if (hasContent) { found = true; }
              break;
            }
            // Lone = breaks the [^}=]+ pattern
            break;
          }
          if (ch === 0x7D) break; // } breaks the [^}=]+ pattern
          hasContent = true;
          k++;
        }
        if (found) {
          const closeEnd = k + 2;
          let matchEnd = closeEnd;
          let colorId: string | undefined;
          if (closeEnd < len && text.charCodeAt(closeEnd) === 0x7B) { // {
            const braceStart = closeEnd + 1;
            let b = braceStart;
            while (b < len && text.charCodeAt(b) !== 0x7D) b++; // find }
            if (b < len) {
              const candidate = text.slice(braceStart, b);
              if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(candidate)) {
                colorId = candidate;
                matchEnd = b + 1;
              }
            }
          }
          if (colorId && VALID_COLOR_IDS.includes(colorId)) {
            pushHighlight(colorId, i, matchEnd);
          } else {
            pushHighlight(resolvedDefault, i, matchEnd);
          }
          i = matchEnd;
          continue;
        }
        // No valid closing == found. Roll back any CriticMarkup ranges that were
        // pushed during this scan — the main loop will re-encounter and process
        // those spans normally when it reaches them.
        comments.length = snapComments;
        additions.length = snapAdditions;
        deletions.length = snapDeletions;
        delimiters.length = snapDelimiters;
        substitutionNew.length = snapSubNew;
        for (const [key, arr] of highlights) {
          const snap = snapHighlightSizes.get(key);
          if (snap !== undefined) arr.length = snap;
          // Keys added during the scan (not in snapshot) must be removed entirely
        }
        for (const key of [...highlights.keys()]) {
          if (!snapHighlightSizes.has(key)) highlights.delete(key);
        }
        i = contentStart;
        continue;
      }
    }

    i++;
  }

  return {
    highlights, comments, additions, deletions, substitutionNew, delimiters,
  };
}
