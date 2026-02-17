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
 * Extract highlight ranges from document text, grouped by color key.
 * Returns a Map where keys are color identifiers (or 'critic') and values are offset ranges.
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
  // Negative lookbehind excludes CriticMarkup opening {==
  const hlRe = /(?<!\{)==([^}=]+)==(?:\{([a-z0-9-]+)\})?/g;
  while ((m = hlRe.exec(text)) !== null) {
    // Skip if this match is inside a CriticMarkup range
    const mEnd = m.index + m[0].length;
    // Content ranges are offset +3/-3 from full match; expand back to full delimiters for overlap check
    const insideCritic = (result.get('critic') || []).some(r => (r.start - 3) <= m!.index && mEnd <= (r.end + 3));
    if (insideCritic) { continue; }

    const colorId = m[2];
    if (colorId && VALID_COLOR_IDS.includes(colorId)) {
      push(colorId, m.index, mEnd);
    } else if (colorId) {
      // Unrecognized color → configured default if valid, else yellow
      push(resolvedDefaultColor, m.index, mEnd);
    } else {
      push(resolvedDefaultColor, m.index, mEnd);
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
    // Preserve TextMate delimiter coloring for comment delimiters ({>> ... <<}),
    // including comment-with-ID closers in {#id>>...<<}.
    if (m[0] === '{>>' || m[0] === '<<}') {
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
