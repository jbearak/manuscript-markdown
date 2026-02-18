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
function findMatchingCommentClose(text: string, startPos: number): number {
  let depth = 1;
  let pos = startPos;
  while (pos < text.length && depth > 0) {
    const nextOpen = text.indexOf('{>>', pos);
    const nextClose = text.indexOf('<<}', pos);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 3;
    } else {
      depth--;
      if (depth === 0) return nextClose;
      pos = nextClose + 3;
    }
  }
  return -1;
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
  const criticRanges = result.get('critic') || [];
  let cPtr = 0;
  const hlRe = /(?<!\{)==([^}=]+)==(?:\{([a-z0-9-]+)\})?/g;
  while ((m = hlRe.exec(text)) !== null) {
    const mStart = m.index;
    const mEnd = mStart + m[0].length;
    // Advance critic pointer past ranges whose full span ends before this highlight starts
    while (cPtr < criticRanges.length && (criticRanges[cPtr].end + 3) < mStart) {
      cPtr++;
    }
    // Check if current critic range contains this highlight
    const insideCritic = cPtr < criticRanges.length &&
      (criticRanges[cPtr].start - 3) <= mStart && mEnd <= (criticRanges[cPtr].end + 3);
    if (insideCritic) { continue; }

    const colorId = m[2];
    if (colorId && VALID_COLOR_IDS.includes(colorId)) {
      push(colorId, mStart, mEnd);
    } else if (colorId) {
      // Unrecognized color → configured default if valid, else yellow
      push(resolvedDefaultColor, mStart, mEnd);
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
  const criticSpans: Array<{ start: number; end: number }> = [];

  const pushHl = (key: string, s: number, e: number) => {
    if (!highlights.has(key)) highlights.set(key, []);
    highlights.get(key)!.push({ start: s, end: e });
  };
  let criticIdx = 0;

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
          i = ci + 3; continue;
        }
      } else if (c2 === 0x2D && c3 === 0x2D) { // {--
        const ci = text.indexOf('--}', i + 3);
        if (ci !== -1) {
          delimiters.push({ start: i, end: i + 3 });
          if (ci > i + 3) deletions.push({ start: i + 3, end: ci });
          delimiters.push({ start: ci, end: ci + 3 });
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
          i = ci + 3; continue;
        }
      } else if (c2 === 0x3E && c3 === 0x3E) { // {>>
        const ci = findMatchingCommentClose(text, i + 3);
        if (ci !== -1) {
          // Skip comment delimiters (preserves TextMate tag punctuation scopes)
          comments.push({ start: i + 3, end: ci });
          i = ci + 3; continue;
        }
      } else if (c2 === 0x3D && c3 === 0x3D) { // {==
        const ci = text.indexOf('==}', i + 3);
        if (ci !== -1) {
          // Skip highlight delimiters (preserves TextMate tag punctuation scopes)
          pushHl('critic', i + 3, ci);
          criticSpans.push({ start: i, end: ci + 3 });
          i = ci + 3; continue;
        }
      }
    }

    if (text.charCodeAt(i) === 0x3D && i + 1 < len && text.charCodeAt(i + 1) === 0x3D) {
      if (i === 0 || text.charCodeAt(i - 1) !== 0x7B) {
        let j = i + 2;
        while (j < len && text.charCodeAt(j) !== 0x7D && text.charCodeAt(j) !== 0x3D) j++;
        if (j > i + 2 && j + 1 < len && text.charCodeAt(j) === 0x3D && text.charCodeAt(j + 1) === 0x3D) {
          let mEnd = j + 2;
          let colorId: string | undefined;
          if (mEnd < len && text.charCodeAt(mEnd) === 0x7B) {
            const cb = text.indexOf('}', mEnd + 1);
            if (cb !== -1) {
              const cand = text.slice(mEnd + 1, cb);
              if (/^[a-z0-9-]+$/.test(cand)) { colorId = cand; mEnd = cb + 1; }
            }
          }
          while (criticIdx < criticSpans.length && criticSpans[criticIdx].end <= i) {
            criticIdx++;
          }
          const inside = criticIdx < criticSpans.length &&
            criticSpans[criticIdx].start <= i && mEnd <= criticSpans[criticIdx].end;
          if (!inside) {
            pushHl(colorId && VALID_COLOR_IDS.includes(colorId) ? colorId : resolvedDefault, i, mEnd);
          }
          i = mEnd; continue;
        }
      }
    }
    i++;
  }

  return {
    highlights, comments, additions, deletions, substitutionNew, delimiters,
  };
}
