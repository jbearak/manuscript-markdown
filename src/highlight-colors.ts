import { criticCloserSearch, type CriticCloserSearch } from './critic-markup';
import { codeOverlapTest, editorBlocks, type CodeRegion, type EditorBlocks } from './code-regions';
import { isEscapedAt } from './math-delimiters';

// --- Implementation notes ---
// - ==text=={color} is unambiguous with CriticMarkup {==text==} (brace is before ==, not after)
// - Config access: module-level get/set passes VS Code settings to markdown-it plugin
//   without importing vscode
// - Fallback hierarchy: configured default → yellow/amber; keep preview/editor aligned
// - Deletion styling: explicit foreground via gitDecoration.deletedResourceForeground + strikethrough
// - Comment styling: no explicit foreground; background + italic only
// - TextMate inline highlight regex: exclude = inside ==...== captures ([^}=]+) for
//   multi-span tokenization
// - An == after an odd run of backslashes opens no format highlight, as export and
//   the preview read it; a closing == has no such check. An == right after a { that
//   no odd run of backslashes escapes, a {=='s, neither opens nor closes one, whether
//   or not a ==} closes that {==, so P ==a {==c==} Q is a critic highlight on c. One
//   after an escaped {, as in \{==x==\}, which is a {, the highlighted x and a } to
//   export and the preview, can do both. Keep hlRe, isBlockedPredecessor and
//   opensCriticHighlight in step with combinedPattern in changes.ts and the grammar
// - A { after an odd run of backslashes, whose last escapes it, opens no CriticMarkup,
//   as export and the preview read it. Keep criticSpans, criticIn and
//   extractAllDecorationRanges in step with combinedPattern in changes.ts and the
//   grammar's escaped_brace
// - extractCriticDelimiterRanges(): skip comment/highlight delimiters so decoration
//   doesn't override TextMate scopes
// - Typed delimiter arrays (additionDelimiters, deletionDelimiters, substitutionDelimiters)
//   enable per-type coloring: green for additions, red for deletions, modified for substitutions
// - extractAllDecorationRanges(): preserve extractHighlightRanges() behavior for ==...==
//   inside any CriticMarkup span, and for {==...==} inside an addition, a deletion or
//   one side of a substitution, where export and the preview show it
// - Comment token scope: use meta.comment* not comment.block* — comment.block suppresses
//   editor features (bracket matching, auto-complete, snippets)
// - editorDecorationRanges(): nothing opens in code, and a format highlight stays in its
//   paragraph's text (see editorBlocks in code-regions.ts), as export and the preview
//   read them. Keep it in step with navigationRanges in navigation-matches.ts. The
//   grammar reads one line at a time, and no code span or fenced block

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
 * Detect `{#id>>` comment-with-ID opener starting at position i (where text[i] == '{').
 * Returns the content start index (position after `>>`) if matched, or -1 otherwise.
 * The ID must be [a-zA-Z0-9_-]+.
 */
function detectCommentIdOpener(text: string, i: number, len: number): number {
  if (i + 3 >= len || text.charCodeAt(i + 1) !== 0x23) return -1; // not {#
  let j = i + 2;
  while (j < len) {
    const ch = text.charCodeAt(j);
    if ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) ||
        (ch >= 0x61 && ch <= 0x7A) || ch === 0x5F || ch === 0x2D) {
      j++;
    } else break;
  }
  if (j === i + 2) return -1; // no ID chars
  if (j + 1 < len && text.charCodeAt(j) === 0x3E && text.charCodeAt(j + 1) === 0x3E) {
    return j + 2; // content starts here
  }
  return -1;
}

/** A CriticMarkup span: its opener at `start`, its text
 *  [contentStart, contentEnd), and its 3-character closer at contentEnd.
 *  `marker` is the opener's second character's code. */
interface CriticSpan { start: number; contentStart: number; contentEnd: number; marker: number }

/**
 * The CriticMarkup spans of `text` in no other span, in order. Each opener
 * is paired as extractAllDecorationRanges pairs it, and the next is looked
 * for after its closer; an opener without a closer, or whose { is escaped,
 * is text:
 *   {== ==}, {++ ++}, {-- --}, {~~ ~~}  with the first closer after it
 *   {>> <<}, {#id>> <<}                  with findMatchingClose (depth-aware)
 * Each closer comes from `closers`, the text's (see criticCloserSearch), as
 * a search of the rest of the text from each opener with no closer took
 * time in their number times the text's length.
 */
function criticSpans(text: string, closers: CriticCloserSearch): CriticSpan[] {
  const spans: CriticSpan[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    if (text.charCodeAt(i) === 0x7B && i + 2 < len && !isEscapedAt(text, i)) { // '{'
      const c2 = text.charCodeAt(i + 1);
      const c3 = text.charCodeAt(i + 2);
      let contentStart = -1;
      let ci = -1;
      if (c2 === 0x3E && c3 === 0x3E) { // {>>
        contentStart = i + 3;
        ci = closers.matching(contentStart);
      } else if (c2 === 0x23) { // {# — possible {#id>>
        contentStart = detectCommentIdOpener(text, i, len);
        if (contentStart !== -1) ci = closers.matching(contentStart);
      } else if (c2 === c3 && (c2 === 0x3D || c2 === 0x2B || c2 === 0x2D || c2 === 0x7E)) { // {== {++ {-- {~~
        contentStart = i + 3;
        ci = closers.next(String.fromCharCode(c2, c2) + '}', contentStart);
      }
      if (ci !== -1) {
        spans.push({ start: i, contentStart, contentEnd: ci, marker: c2 });
        i = ci + 3; continue;
      }
    }
    i++;
  }
  return spans;
}

/**
 * Extract highlight ranges from document text, grouped by color key.
 * Returns a Map where keys are color identifiers (or 'critic') and values are offset ranges.
 *
 * The reference for extractAllDecorationRanges's highlights, found another
 * way: with regexes over the text of each CriticMarkup span (see
 * {@link criticSpans}) and over the text outside them, in which each span
 * reads as one run of text, as the editor reads past one whole.
 *   Phase 1 — CriticMarkup highlights `{==...==}`: each span of them, and
 *     those in an addition's or deletion's text or in one side of a
 *     substitution, where export and the preview show them. One in a
 *     comment, or one that runs out of its span or past a substitution's
 *     `~>`, is text to them.
 *   Phase 2 — Format highlights `==...==` with optional `{color}` suffix,
 *     outside the spans and in each span's text by itself. One that would
 *     close in a span it starts outside of, or outside the span it starts
 *     in, is none.
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
  const closers = criticCloserSearch(text);
  const spans = criticSpans(text, closers);

  // CriticMarkup highlights {==text==} — content only (skip delimiters)
  const criticIn = (from: number, to: number) => {
    const part = text.slice(from, to);
    // None in text that holds another opener (see extractAllDecorationRanges)
    if (/\{(?<!(?<!\\)(?:\\\\)*\\\{)(?:\+\+|--|~~|>>|#[0-9A-Za-z_-]+>>)/.test(part)) return;
    // Each {== after no escaping backslash, which the part's start, after an
    // opener, never has, to the first ==} after it in the part, as a lazy
    // regex over the part matches. One with none has none after any later
    // {== either.
    for (let at = part.indexOf('{=='); at !== -1; at = part.indexOf('{==', at + 1)) {
      if (isEscapedAt(text, from + at)) continue;
      const ci = closers.next('==}', from + at + 3);
      if (ci === -1 || ci + 3 > to) return;
      push('critic', from + at + 3, ci);
      at = ci + 2 - from;
    }
  };
  for (const span of spans) {
    if (span.marker === 0x3D) { // {==
      push('critic', span.contentStart, span.contentEnd);
    } else if (span.marker === 0x2B || span.marker === 0x2D) { // {++ {--
      criticIn(span.contentStart, span.contentEnd);
    } else if (span.marker === 0x7E) { // {~~
      const arrow = text.slice(span.contentStart, span.contentEnd).indexOf('~>');
      if (arrow === -1) {
        criticIn(span.contentStart, span.contentEnd);
      } else {
        criticIn(span.contentStart, span.contentStart + arrow);
        criticIn(span.contentStart + arrow + 2, span.contentEnd);
      }
    }
  }

  // Colored highlights ==text=={color} and default highlights ==text==, none
  // whose opening == an odd run of backslashes escapes or that comes right
  // after a { no odd run escapes, nor any whose closing == does (see
  // combinedPattern in changes.ts)
  const hlRe = /(?<!=)==(?<!(?<!\\)(?:\\\\)*\\==)(?<!(?<!\\)(?:\\\\)*\{==)([^}=]+)==(?<!(?<!\\)(?:\\\\)*\{==)(?![}=])(?:\{([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\})?/g;
  const formatIn = (part: string, offset: number) => {
    hlRe.lastIndex = 0;
    let m;
    while ((m = hlRe.exec(part)) !== null) {
      const colorId = m[2];
      const key = colorId && VALID_COLOR_IDS.includes(colorId) ? colorId : resolvedDefaultColor;
      push(key, offset + m.index, offset + m.index + m[0].length);
    }
  };
  // Outside the spans, each a space for each of its characters, which keeps
  // the offsets and passes [^}=]+, as a span does in the editor's scan, but
  // is no color's, as a span's { is none
  let outside = '';
  let pos = 0;
  for (const span of spans) {
    outside += text.slice(pos, span.start) + ' '.repeat(span.contentEnd + 3 - span.start);
    pos = span.contentEnd + 3;
  }
  formatIn(outside + text.slice(pos), 0);
  for (const span of spans) formatIn(text.slice(span.contentStart, span.contentEnd), span.contentStart);

  return result;
}

/**
 * Extract CriticMarkup comment ranges {>>text<<} from document text.
 * Returns an array of offset ranges.
 */
export function extractCommentRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  // Each comment's matching <<}, found for all at once, as each unclosed
  // one searched the rest of the text
  const closers = criticCloserSearch(text);
  const len = text.length;
  let i = 0;
  while (i < len - 2) {
    if (text.charCodeAt(i) === 0x7B) { // {
      const c2 = text.charCodeAt(i + 1);
      if (c2 === 0x3E && i + 2 < len && text.charCodeAt(i + 2) === 0x3E) { // {>>
        const contentStart = i + 3;
        const ci = closers.matching(contentStart);
        if (ci !== -1) {
          ranges.push({ start: contentStart, end: ci });
          i = ci + 3; continue;
        }
      } else if (c2 === 0x23) { // {# — possible {#id>>
        const contentStart = detectCommentIdOpener(text, i, len);
        if (contentStart !== -1) {
          const ci = closers.matching(contentStart);
          if (ci !== -1) {
            ranges.push({ start: contentStart, end: ci });
            i = ci + 3; continue;
          }
        }
      }
    }
    i++;
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

/**
 * For each {~~old~>new~~}, extract the range of the "old" portion (between {~~ and ~>).
 */
export function extractSubstitutionOldRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const oldStart = m.index + 3; // skip {~~
    const oldEnd = m.index + 3 + m[1].length; // before ~>
    if (oldEnd > oldStart) {
      ranges.push({ start: oldStart, end: oldEnd });
    }
  }
  return ranges;
}

export interface AllDecorationRanges {
  highlights: Map<string, Array<{ start: number; end: number }>>;
  comments: Array<{ start: number; end: number }>;
  additions: Array<{ start: number; end: number }>;
  deletions: Array<{ start: number; end: number }>;
  additionDelimiters: Array<{ start: number; end: number }>;
  deletionDelimiters: Array<{ start: number; end: number }>;
  substitutionDelimiters: Array<{ start: number; end: number }>;
  substitutionOld: Array<{ start: number; end: number }>;
  substitutionNew: Array<{ start: number; end: number }>;
  highlightDelimiters: Array<{ start: number; end: number }>;
  commentDelimiters: Array<{ start: number; end: number }>;
}

/**
 * The ranges to decorate in `text`. With `blocks` (see editorBlocks in
 * code-regions.ts), nothing opens in code: no CriticMarkup span, no format
 * highlight, and in a format highlight's text, no span but a critic
 * highlight, as export's search for its closing == reads a {== there and
 * no other opener. A format highlight outside CriticMarkup holds no text
 * past its paragraph's (see limitAt there), but for a span's, which reads
 * as one run of text, whose end goes on in the paragraph there, as export
 * and the preview read a span over a blank line. One in a span's text reads
 * past it, as they read one there. Without `blocks`, as for
 * extractHighlightRanges, an opener in code opens, and a format highlight
 * reads to its closing == wherever that is.
 */
export function extractAllDecorationRanges(text: string, defaultColor: string, blocks?: Pick<EditorBlocks, 'inCode' | 'limitAt'>): AllDecorationRanges {
  const resolvedDefault = VALID_COLOR_IDS.includes(defaultColor) ? defaultColor : 'yellow';
  // Each opener's closer, from one search of the text for each closer, as
  // each unclosed opener searched the rest of it
  const closers = criticCloserSearch(text);
  const highlights = new Map<string, Array<{ start: number; end: number }>>();
  const comments: Array<{ start: number; end: number }> = [];
  const additions: Array<{ start: number; end: number }> = [];
  const deletions: Array<{ start: number; end: number }> = [];
  const additionDelimiters: Array<{ start: number; end: number }> = [];
  const deletionDelimiters: Array<{ start: number; end: number }> = [];
  const substitutionDelimiters: Array<{ start: number; end: number }> = [];
  const substitutionOld: Array<{ start: number; end: number }> = [];
  const substitutionNew: Array<{ start: number; end: number }> = [];
  const highlightDelimiters: Array<{ start: number; end: number }> = [];
  const commentDelimiters: Array<{ start: number; end: number }> = [];

  const pushHighlight = (key: string, start: number, end: number) => {
    if (!highlights.has(key)) highlights.set(key, []);
    highlights.get(key)!.push({ start, end });
  };
  // Whether the == at `index` is a {=='s, whose { no odd run of backslashes
  // escapes, which neither opens nor closes a format highlight, as export
  // and the preview read it (opensCriticHighlight there; see hlRe)
  const opensCriticHighlight = (index: number): boolean =>
    text.charCodeAt(index - 1) === 0x7B && !isEscapedAt(text, index - 1);
  // An == after a { no odd run of backslashes escapes, or after =, or after
  // an odd run of backslashes, whose last escapes its first = (see hlRe),
  // opens no format highlight
  const isBlockedPredecessor = (index: number, boundEnd: number): boolean =>
    index > 0 &&
    index < boundEnd &&
    (opensCriticHighlight(index) || text.charCodeAt(index - 1) === 0x3D || isEscapedAt(text, index));
  // Whether code holds `index`, where nothing opens (see blocks)
  const inCode = (index: number): boolean => blocks !== undefined && blocks.inCode(index);
  const isBlockedSuccessor = (indexAfterClose: number, boundEnd: number): boolean => {
    if (indexAfterClose >= boundEnd) return false;
    const ch = text.charCodeAt(indexAfterClose);
    return ch === 0x3D || ch === 0x7D;
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
        // Check negative lookbehind: not preceded by { or = or an escaping
        // backslash, but for the = of the span's opener before the region,
        // as in {====a====}, which the preview reads as a highlight in the
        // span. Nor in code (see blocks).
        if ((j > regionStart && isBlockedPredecessor(j, regionEnd)) || inCode(j)) {
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
          // Trailing guard: closing == must not be followed by = or }, nor
          // be a {=='s
          const afterClose = k + 2;
          if (isBlockedSuccessor(afterClose, regionEnd) || opensCriticHighlight(k)) { j = k; continue; }
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

  /**
   * Record the critic highlights {==...==} in an addition's or deletion's
   * text, or in one side of a substitution, [regionStart, regionEnd), which
   * export and the preview show highlighted there. One that runs past the
   * region, as past a substitution's ~>, is its span's text to them, as one
   * in a comment is. A region that holds another CriticMarkup opener, as
   * {>> or {~~, records none, as before: a {== in a comment there, or one
   * across a substitution's ~>, is text to them. An opener in code is
   * neither (see blocks).
   */
  const scanCriticHighlights = (regionStart: number, regionEnd: number) => {
    for (let p = regionStart; p + 3 <= regionEnd; p++) {
      if (text.charCodeAt(p) !== 0x7B || isEscapedAt(text, p) || inCode(p)) continue;
      const c2 = text.charCodeAt(p + 1);
      if ((c2 === 0x2B || c2 === 0x2D || c2 === 0x7E || c2 === 0x3E) && text.charCodeAt(p + 2) === c2) return;
      if (c2 === 0x23 && detectCommentIdOpener(text, p, regionEnd) !== -1) return;
    }
    for (let p = regionStart; p + 3 <= regionEnd; p++) {
      if (text.charCodeAt(p) !== 0x7B || text.charCodeAt(p + 1) !== 0x3D || text.charCodeAt(p + 2) !== 0x3D || isEscapedAt(text, p) || inCode(p)) continue;
      // The first ==} after it, as for one outside a span
      const ci = closers.next('==}', p + 3);
      if (ci === -1 || ci + 3 > regionEnd) return;
      highlightDelimiters.push({ start: p, end: p + 3 });
      pushHighlight('critic', p + 3, ci);
      highlightDelimiters.push({ start: ci, end: ci + 3 });
      p = ci + 2;
    }
  };

  const len = text.length;
  let i = 0;
  while (i < len) {
    // Nothing opens in code (see blocks)
    if ((text.charCodeAt(i) === 0x7B || text.charCodeAt(i) === 0x3D) && inCode(i)) {
      i++;
      continue;
    }
    // A { an odd run of backslashes escapes opens nothing (see criticSpans)
    if (text.charCodeAt(i) === 0x7B && i + 2 < len && !isEscapedAt(text, i)) {
      const c2 = text.charCodeAt(i + 1);
      const c3 = text.charCodeAt(i + 2);

      if (c2 === 0x2B && c3 === 0x2B) { // {++
        const ci = closers.next('++}', i + 3);
        if (ci !== -1) {
          additionDelimiters.push({ start: i, end: i + 3 });
          if (ci > i + 3) additions.push({ start: i + 3, end: ci });
          additionDelimiters.push({ start: ci, end: ci + 3 });
          // Scan content for nested format and critic highlights
          scanFormatHighlights(i + 3, ci);
          scanCriticHighlights(i + 3, ci);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x2D && c3 === 0x2D) { // {--
        const ci = closers.next('--}', i + 3);
        if (ci !== -1) {
          deletionDelimiters.push({ start: i, end: i + 3 });
          if (ci > i + 3) deletions.push({ start: i + 3, end: ci });
          deletionDelimiters.push({ start: ci, end: ci + 3 });
          // Scan content for nested format and critic highlights
          scanFormatHighlights(i + 3, ci);
          scanCriticHighlights(i + 3, ci);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x7E && c3 === 0x7E) { // {~~
        const ci = closers.next('~~}', i + 3);
        if (ci !== -1) {
          substitutionDelimiters.push({ start: i, end: i + 3 });
          const content = text.slice(i + 3, ci);
          const cai = content.indexOf('~>');
          if (cai !== -1) {
            substitutionDelimiters.push({ start: i + 3 + cai, end: i + 3 + cai + 2 });
            const oldEnd = i + 3 + cai;
            if (oldEnd > i + 3) substitutionOld.push({ start: i + 3, end: oldEnd });
            const newStart = i + 3 + cai + 2;
            if (ci > newStart) substitutionNew.push({ start: newStart, end: ci });
          }
          substitutionDelimiters.push({ start: ci, end: ci + 3 });
          // Scan content for nested format and critic highlights
          scanFormatHighlights(i + 3, ci);
          if (cai === -1) scanCriticHighlights(i + 3, ci);
          else { scanCriticHighlights(i + 3, i + 3 + cai); scanCriticHighlights(i + 3 + cai + 2, ci); }
          i = ci + 3; continue;
        }
      } else if (c2 === 0x3E && c3 === 0x3E) { // {>>
        const ci = closers.matching(i + 3);
        if (ci !== -1) {
          commentDelimiters.push({ start: i, end: i + 3 });
          comments.push({ start: i + 3, end: ci });
          commentDelimiters.push({ start: ci, end: ci + 3 });
          // Scan content for nested format highlights
          scanFormatHighlights(i + 3, ci);
          i = ci + 3; continue;
        }
      } else if (c2 === 0x23) { // {# — possible {#id>>
        const contentStart = detectCommentIdOpener(text, i, len);
        if (contentStart !== -1) {
          const ci = closers.matching(contentStart);
          if (ci !== -1) {
            commentDelimiters.push({ start: i, end: contentStart });
            comments.push({ start: contentStart, end: ci });
            commentDelimiters.push({ start: ci, end: ci + 3 });
            scanFormatHighlights(contentStart, ci);
            i = ci + 3; continue;
          }
        }
      } else if (c2 === 0x3D && c3 === 0x3D) { // {==
        const ci = closers.next('==}', i + 3);
        if (ci !== -1) {
          highlightDelimiters.push({ start: i, end: i + 3 });
          // Record critic highlight content range (skip delimiters for TextMate scopes)
          pushHighlight('critic', i + 3, ci);
          highlightDelimiters.push({ start: ci, end: ci + 3 });
          // Scan content for nested format highlights
          scanFormatHighlights(i + 3, ci);
          i = ci + 3; continue;
        }
      }
    }

    // Detect format highlights ==...== and ==...=={color} outside CriticMarkup.
    // A CriticMarkup span reads as one run of text, so a format highlight can
    // hold whole spans but can't close in one.
    if (text.charCodeAt(i) === 0x3D && i + 1 < len && text.charCodeAt(i + 1) === 0x3D) {
      // Check negative lookbehind: not preceded by { or = or an escaping backslash
      if (!isBlockedPredecessor(i, len)) {
        // Scan forward for content, skipping CriticMarkup spans.
        // A span passes [^}=]+ whole, whatever its text; other chars must match it.
        // When we skip CriticMarkup spans, we also fully process them (record their
        // ranges, delimiters, and nested format highlights) since the main loop will
        // jump past the entire format highlight match.
        //
        // Snapshot array lengths so we can roll back any CriticMarkup ranges pushed
        // during the scan if no valid closing == is found.
        const snapComments = comments.length;
        const snapAdditions = additions.length;
        const snapDeletions = deletions.length;
        const snapAddDelim = additionDelimiters.length;
        const snapDelDelim = deletionDelimiters.length;
        const snapSubDelim = substitutionDelimiters.length;
        const snapSubOld = substitutionOld.length;
        const snapSubNew = substitutionNew.length;
        const snapHlDelim = highlightDelimiters.length;
        const snapCmDelim = commentDelimiters.length;
        const snapHighlightSizes = new Map<string, number>();
        for (const [key, arr] of highlights) snapHighlightSizes.set(key, arr.length);

        const contentStart = i + 2;
        let k = contentStart;
        let hasContent = false; // at least 1 non-delimiter char
        let found = false;
        // Where the text it may hold ends, which a span it holds moves to
        // where that text ends at the span's end
        let limit = blocks ? blocks.limitAt(i) : len;
        // Reads past a span it holds, which ends before `to`
        const skipSpan = (to: number) => {
          hasContent = true;
          k = to;
          if (blocks && k >= limit) limit = blocks.limitAt(k);
        };
        while (k < limit) {
          // Check for CriticMarkup opening delimiters — process and skip entire spans
          if (text.charCodeAt(k) === 0x7B && k + 2 < len && !isEscapedAt(text, k)) {
            const d2 = text.charCodeAt(k + 1);
            const d3 = text.charCodeAt(k + 2);
            if (d2 === 0x3D && d3 === 0x3D) { // {==
              const ci = closers.next('==}', k + 3);
              if (ci !== -1) {
                highlightDelimiters.push({ start: k, end: k + 3 });
                pushHighlight('critic', k + 3, ci);
                highlightDelimiters.push({ start: ci, end: ci + 3 });
                scanFormatHighlights(k + 3, ci);
                skipSpan(ci + 3); continue;
              }
              // One with no ==} after it is text, but its == closes no
              // highlight (see opensCriticHighlight), and its = ends [^}=]+
              break;
            } else if (inCode(k)) {
              // No other opens in code (see blocks)
            } else if (d2 === 0x3E && d3 === 0x3E) { // {>>
              const ci = closers.matching(k + 3);
              if (ci !== -1) {
                commentDelimiters.push({ start: k, end: k + 3 });
                comments.push({ start: k + 3, end: ci });
                commentDelimiters.push({ start: ci, end: ci + 3 });
                scanFormatHighlights(k + 3, ci);
                skipSpan(ci + 3); continue;
              }
            } else if (d2 === 0x23) { // {# — possible {#id>>
              const innerContentStart = detectCommentIdOpener(text, k, len);
              if (innerContentStart !== -1) {
                const ci = closers.matching(innerContentStart);
                if (ci !== -1) {
                  commentDelimiters.push({ start: k, end: innerContentStart });
                  comments.push({ start: innerContentStart, end: ci });
                  commentDelimiters.push({ start: ci, end: ci + 3 });
                  scanFormatHighlights(innerContentStart, ci);
                  skipSpan(ci + 3); continue;
                }
              }
            } else if (d2 === 0x2B && d3 === 0x2B) { // {++
              const ci = closers.next('++}', k + 3);
              if (ci !== -1) {
                additionDelimiters.push({ start: k, end: k + 3 });
                if (ci > k + 3) additions.push({ start: k + 3, end: ci });
                additionDelimiters.push({ start: ci, end: ci + 3 });
                scanFormatHighlights(k + 3, ci);
                scanCriticHighlights(k + 3, ci);
                skipSpan(ci + 3); continue;
              }
            } else if (d2 === 0x2D && d3 === 0x2D) { // {--
              const ci = closers.next('--}', k + 3);
              if (ci !== -1) {
                deletionDelimiters.push({ start: k, end: k + 3 });
                if (ci > k + 3) deletions.push({ start: k + 3, end: ci });
                deletionDelimiters.push({ start: ci, end: ci + 3 });
                scanFormatHighlights(k + 3, ci);
                scanCriticHighlights(k + 3, ci);
                skipSpan(ci + 3); continue;
              }
            } else if (d2 === 0x7E && d3 === 0x7E) { // {~~
              const ci = closers.next('~~}', k + 3);
              if (ci !== -1) {
                substitutionDelimiters.push({ start: k, end: k + 3 });
                const subContent = text.slice(k + 3, ci);
                const cai = subContent.indexOf('~>');
                if (cai !== -1) {
                  substitutionDelimiters.push({ start: k + 3 + cai, end: k + 3 + cai + 2 });
                  const subOldEnd = k + 3 + cai;
                  if (subOldEnd > k + 3) substitutionOld.push({ start: k + 3, end: subOldEnd });
                  const newStart = k + 3 + cai + 2;
                  if (ci > newStart) substitutionNew.push({ start: newStart, end: ci });
                }
                substitutionDelimiters.push({ start: ci, end: ci + 3 });
                scanFormatHighlights(k + 3, ci);
                if (cai === -1) scanCriticHighlights(k + 3, ci);
                else { scanCriticHighlights(k + 3, k + 3 + cai); scanCriticHighlights(k + 3 + cai + 2, ci); }
                skipSpan(ci + 3); continue;
              }
            }
          }
          const ch = text.charCodeAt(k);
          if (ch === 0x3D) { // =
            // Check for closing ==
            if (k + 1 < len && text.charCodeAt(k + 1) === 0x3D) {
              // Trailing guard: closing == must not be followed by = or }
              if (isBlockedSuccessor(k + 2, len)) break;
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
        additionDelimiters.length = snapAddDelim;
        deletionDelimiters.length = snapDelDelim;
        substitutionDelimiters.length = snapSubDelim;
        substitutionOld.length = snapSubOld;
        substitutionNew.length = snapSubNew;
        highlightDelimiters.length = snapHlDelim;
        commentDelimiters.length = snapCmDelim;
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
    highlights, comments, additions, deletions,
    additionDelimiters, deletionDelimiters, substitutionDelimiters,
    substitutionOld, substitutionNew,
    highlightDelimiters, commentDelimiters,
  };
}

/**
 * Drops the ranges of `all` that overlap `codeRegions`, inline code spans
 * and fenced code blocks, which show no decorations, as the editor does
 * before it decorates them. Each array keeps its identity, and items are
 * kept one at a time, not spread into splice(), as a document's comments
 * or revisions can number more than a call takes arguments. Each overlap is
 * found by binary search (see codeOverlapTest).
 */
export function dropRangesInCode(all: AllDecorationRanges, codeRegions: readonly CodeRegion[]): void {
  if (codeRegions.length === 0) return;
  const overlaps = codeOverlapTest(codeRegions);
  const keep = (r: { start: number; end: number }) => !overlaps(r.start, r.end);
  for (const [key, ranges] of all.highlights) {
    const filtered = ranges.filter(keep);
    if (filtered.length === 0) {
      all.highlights.delete(key);
    } else if (filtered.length !== ranges.length) {
      all.highlights.set(key, filtered);
    }
  }
  for (const ranges of [all.comments, all.additions, all.deletions, all.additionDelimiters, all.deletionDelimiters,
    all.substitutionDelimiters, all.substitutionOld, all.substitutionNew, all.highlightDelimiters, all.commentDelimiters]) {
    let kept = 0;
    for (const range of ranges) if (keep(range)) ranges[kept++] = range;
    ranges.length = kept;
  }
}

/**
 * The ranges the editor decorates in `text`, as extension.ts paints them:
 * extractAllDecorationRanges's with nothing opening in code and each format
 * highlight held to its paragraph's text (see editorBlocks), without those
 * that hold code (see dropRangesInCode).
 */
export function editorDecorationRanges(text: string, defaultColor: string): AllDecorationRanges {
  const blocks = editorBlocks(text);
  const all = extractAllDecorationRanges(text, defaultColor, blocks);
  dropRangesInCode(all, blocks.codeRegions);
  return all;
}
