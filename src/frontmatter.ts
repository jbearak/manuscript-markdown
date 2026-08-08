export type NoteType = 'in-text' | 'footnotes' | 'endnotes';

import {
  parseTableDigits,
  parseTableDecimalMark,
  parseTableDigitGrouping,
  type TableDigits,
  type TableDecimalMark,
  type TableDigitGrouping,
} from './table-number-format';
import {
  isCitekey,
  isNociteContinuationLine,
  isTopLevelFrontmatterMappingLine,
  nociteValueMode,
  parseNociteRaw,
  type NociteValue,
} from './citekey';

export type { TableDigits, TableDecimalMark, TableDigitGrouping } from './table-number-format';
export type { NociteValue } from './citekey';

// Quote strings that YAML 1.1 or 1.2 schemas can implicitly resolve as non-strings.
// Pandoc and other frontmatter consumers do not all use the same schema.
const YAML_PLAIN_RESERVED_RE = /^(?:~|null|true|false|yes|no|on|off|y|n|[-+]?(?:\.inf|\.nan|0b[01_]+|0o[0-7_]+|0x[\da-f_]+|(?:\d[\d_]*)(?::[0-5]?\d)+(?:\.\d*)?|(?:\d[\d_]*)?(?:\.\d[\d_]*|\.(?:[\d_]+)?)(?:e[-+]?\d+)?|\d[\d_]*(?:e[-+]?\d+)?|\d[\d_]*)|\d{4}-\d{1,2}-\d{1,2}(?:(?:[Tt]|[ \t]+).*)?)$/i;

function replaceInvalidXmlCharacters(value: string): string {
  return [...value].map(char => {
    const code = char.codePointAt(0)!;
    const valid = code === 0x09 || code === 0x0A || code === 0x0D
      || (code >= 0x20 && code <= 0xD7FF)
      || (code >= 0xE000 && code <= 0xFFFD)
      || (code >= 0x10000 && code <= 0x10FFFF);
    return valid ? char : '�';
  }).join('');
}

/** Decode the quoted scalar forms emitted by serializeYamlStringScalar(). */
export function parseYamlStringScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return replaceInvalidXmlCharacters(parsed);
    } catch {
      return replaceInvalidXmlCharacters(value.slice(1, -1));
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return replaceInvalidXmlCharacters(value.slice(1, -1).replace(/''/g, "'"));
  }
  return replaceInvalidXmlCharacters(value);
}

/** Serialize a string as a safe YAML plain or JSON-compatible quoted scalar. */
export function serializeYamlStringScalar(value: string): string {
  value = replaceInvalidXmlCharacters(value);
  const hasControlOrYamlLineBreak = [...value].some(char => {
    const code = char.codePointAt(0)!;
    return code <= 0x1F || (code >= 0x7F && code <= 0x9F) || code === 0x2028 || code === 0x2029;
  });
  const safePlain = value.length > 0
    && value === value.trim()
    && !hasControlOrYamlLineBreak
    && !/^[\-?:,\[\]{}#&*!|>'"%@`]/.test(value)
    && !/:(?:\s|$)|[ \t]#/.test(value)
    && !YAML_PLAIN_RESERVED_RE.test(value);
  if (safePlain) return value;
  const yamlControlOrLineBreak = new RegExp('[\\u007f-\\u009f\\u2028\\u2029]', 'g');
  return JSON.stringify(value).replace(yamlControlOrLineBreak, char =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

function serializeYamlFlowStringScalar(value: string): string {
  const sanitized = replaceInvalidXmlCharacters(value);
  const scalar = serializeYamlStringScalar(sanitized);
  return scalar === sanitized && /[:,\[\]{}]/.test(sanitized) ? JSON.stringify(sanitized) : scalar;
}

function serializeYamlMappingKey(value: string): string {
  const sanitized = replaceInvalidXmlCharacters(value);
  const scalar = serializeYamlStringScalar(sanitized);
  return scalar === sanitized && (sanitized.includes(':') || sanitized === '<<')
    ? JSON.stringify(sanitized)
    : scalar;
}

function findYamlMappingColon(line: string): number {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === '"') {
      if (char === '\\') {
        i++;
      } else if (char === '"') {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'" && line[i + 1] === "'") {
        i++;
      } else if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if ((char === '"' || char === "'") && line.slice(0, i).trim().length === 0) quote = char;
    else if (char === ':') return i;
  }
  return -1;
}

const NOTE_TYPE_NAMES: Record<string, NoteType> = {
  'in-text': 'in-text',
  'footnotes': 'footnotes',
  'endnotes': 'endnotes',
  '0': 'in-text',
  '1': 'footnotes',
  '2': 'endnotes',
};

const NOTE_TYPE_TO_NUMBER: Record<NoteType, number> = {
  'in-text': 0,
  'footnotes': 1,
  'endnotes': 2,
};

export function noteTypeFromNumber(n: number): NoteType {
  if (n === 1) return 'footnotes';
  if (n === 2) return 'endnotes';
  return 'in-text';
}

export function noteTypeToNumber(nt: NoteType): number {
  return NOTE_TYPE_TO_NUMBER[nt];
}

export type NotesMode = 'footnotes' | 'endnotes';

/** A user-defined custom paragraph style declared in the `styles:` frontmatter block. */
export interface CustomStyleDef {
  font?: string;
  fontSize?: number;       // points
  fontStyle?: string;      // normalized: bold-italic-...-center
  spacingBefore?: number;  // points
  spacingAfter?: number;   // points
  paragraphIndent?: number | 'none'; // inches; 'none' = explicit zero first-line indent
}

/** Parse a value that may be a YAML inline array `[v1, v2, ...]` or bare comma-separated values. */
export function parseInlineArray(value: string): string[] {
  let inner = value.trim();
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1);

  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (quote === '"') {
      if (char === '\\') {
        i++;
      } else if (char === '"') {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'" && inner[i + 1] === "'") {
        i++;
      } else if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if ((char === '"' || char === "'") && inner.slice(start, i).trim().length === 0) quote = char;
    else if (char === ',') {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map(parseYamlStringScalar).filter(s => s.length > 0);
}

// Design rationale: A single combined header-font-style field was chosen over
// separate CSS-style fields (font-style, font-weight, font-decoration) because:
// 1. One field is simpler for authors than three separate fields.
// 2. Manuscript authors are not web developers — CSS distinctions between
//    font-style, font-weight, and text-decoration are unfamiliar.
// 3. Word only supports bold on/off (no numeric weights 100–900), so a
//    separate font-weight field accepting numbers would be misleading.
const VALID_STYLE_PARTS = new Set(['bold', 'italic', 'underline', 'smallcaps', 'allcaps', 'center']);
const CANONICAL_ORDER = ['bold', 'italic', 'underline', 'smallcaps', 'allcaps', 'center'];

/** Validate and normalize a Font_Style value to canonical order (bold-italic-underline-smallcaps-allcaps-center). */
export function normalizeFontStyle(raw: string): string | undefined {
  const lower = raw.toLowerCase().trim();
  if (!lower) return undefined;
  if (lower === 'normal') return 'normal';
  const parts = lower.split('-');
  const unique = [...new Set(parts)];
  if (unique.length !== parts.length) return undefined;
  if (!unique.every(p => VALID_STYLE_PARTS.has(p))) return undefined;
  // smallcaps and allcaps are mutually exclusive (Word only supports one at a time)
  if (unique.includes('smallcaps') && unique.includes('allcaps')) return undefined;
  return unique.sort((a, b) => CANONICAL_ORDER.indexOf(a) - CANONICAL_ORDER.indexOf(b)).join('-');
}

export type BlockquoteStyle = 'Quote' | 'IntenseQuote' | 'GitHub';

const BLOCKQUOTE_STYLE_NAMES: Record<string, BlockquoteStyle> = {
  'quote': 'Quote',
  'intensequote': 'IntenseQuote',
  'github': 'GitHub',
};

/** Normalize a raw blockquote-style value (case-insensitive). */
export function normalizeBlockquoteStyle(raw: string): BlockquoteStyle | undefined {
  return BLOCKQUOTE_STYLE_NAMES[raw.toLowerCase().trim()];
}

export type ColorScheme = 'github' | 'guttmacher';

const COLOR_SCHEME_NAMES: Record<string, ColorScheme> = {
  'github': 'github',
  'guttmacher': 'guttmacher',
};

/** Normalize a raw colors value (case-insensitive). */
export function normalizeColorScheme(raw: string): ColorScheme | undefined {
  return COLOR_SCHEME_NAMES[raw.toLowerCase().trim()];
}

export interface Frontmatter {
  title?: string[];
  author?: string;
  csl?: string;
  locale?: string;
  zoteroNotes?: NoteType;
  notes?: NotesMode;
  timezone?: string;
  bibliography?: string;
  nocite?: NociteValue;
  font?: string;
  codeFont?: string;
  fontSize?: number;
  codeFontSize?: number;
  headerFont?: string[];
  headerFontSize?: number[];
  headerFontStyle?: string[];
  titleFont?: string[];
  titleFontSize?: number[];
  titleFontStyle?: string[];
  codeBackgroundColor?: string;
  codeFontColor?: string;
  codeBlockInset?: number;
  pipeTableMaxLineWidth?: number;
  gridTableMaxLineWidth?: number;
  tableFont?: string;
  tableFontSize?: number;
  tableColWidths?: number[] | 'equal' | 'auto';
  tableBorders?: 'horizontal' | 'solid' | 'none';
  tableDigits?: TableDigits;
  tableDecimalMark?: TableDecimalMark;
  tableDigitGrouping?: TableDigitGrouping;
  blockquoteStyle?: BlockquoteStyle;
  calloutLabels?: boolean;
  colors?: ColorScheme;
  styles?: Record<string, CustomStyleDef>;
  breaks?: boolean;
  lineSpacing?: string | number;
  paragraphIndent?: number | 'none';
  bibliographyHangingIndent?: boolean;
}

export interface FrontmatterOpeningBounds {
  /** Start of the opening delimiter, after any accepted leading whitespace/BOM. */
  start: number;
  /** Offset immediately after the three opening hyphens. */
  contentStart: number;
  /** First offset after the opening delimiter line. */
  bodyStart: number;
}

export interface FrontmatterBounds {
  /** Start of the opening delimiter, after any accepted leading whitespace/BOM. */
  start: number;
  /** Offset immediately after the three opening hyphens. */
  contentStart: number;
  /** Offset of the newline immediately before the closing delimiter. */
  contentEnd: number;
  /** Offset immediately after the closing delimiter line and its newline, if present. */
  bodyStart: number;
}

/** Locate an opening delimiter using parseFrontmatter's accepted leading trivia. */
export function findFrontmatterOpeningBounds(markdown: string): FrontmatterOpeningBounds | undefined {
  const start = markdown.length - markdown.trimStart().length;
  const opener = /^---[ \t]*(?:\r?\n|$)/.exec(markdown.slice(start));
  if (!opener) return undefined;
  return {
    start,
    contentStart: start + 3,
    bodyStart: start + opener[0].length,
  };
}

/** Locate the same permissive frontmatter block accepted by parseFrontmatter(). */
export function findFrontmatterBounds(markdown: string): FrontmatterBounds | undefined {
  const opening = findFrontmatterOpeningBounds(markdown);
  if (!opening) return undefined;
  const trimmed = markdown.slice(opening.start);

  const endMatch = trimmed.substring(3).match(/\n---(?:\r?\n|$)/);
  if (!endMatch) return undefined;
  const endIdx = endMatch.index! + 3;
  const afterDelimiter = trimmed.slice(endIdx + 4);
  const consumedLeadingNewline = afterDelimiter.match(/^\r?\n/)?.[0].length ?? 0;
  return {
    start: opening.start,
    contentStart: opening.contentStart,
    contentEnd: opening.start + endIdx,
    bodyStart: opening.start + endIdx + 4 + consumedLeadingNewline,
  };
}

/**
 * Locate a provisional unclosed frontmatter prefix for cursor-local editing
 * features. These bounds are inherently ambiguous and must never be used to
 * suppress whole-document scanning or diagnostics; only a closed block from
 * findFrontmatterBounds() is globally authoritative.
 */
export function findCitationFrontmatterBounds(markdown: string): FrontmatterBounds | undefined {
  const closed = findFrontmatterBounds(markdown);
  if (closed) return closed;

  const opening = findFrontmatterOpeningBounds(markdown);
  if (!opening || opening.bodyStart === opening.contentStart) return undefined;
  const contentStart = opening.contentStart;
  let hasTopLevelMapping = false;
  let lineStart = opening.bodyStart;
  while (lineStart < markdown.length) {
    const newline = markdown.indexOf('\n', lineStart);
    const rawEnd = newline === -1 ? markdown.length : newline;
    const lineEnd = rawEnd > lineStart && markdown[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
    const line = markdown.slice(lineStart, lineEnd);
    if (line.trim().length === 0) {
      if (!hasTopLevelMapping) return undefined;
      return {
        start: opening.start,
        contentStart,
        contentEnd: lineStart,
        bodyStart: newline === -1 ? markdown.length : newline + 1,
      };
    }
    if (isTopLevelFrontmatterMappingLine(line)) hasTopLevelMapping = true;
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (!hasTopLevelMapping) return undefined;
  return {
    start: opening.start,
    contentStart,
    contentEnd: markdown.length,
    bodyStart: markdown.length,
  };
}

/** Replace YAML frontmatter characters with spaces while preserving length and newlines. */
export function maskFrontmatter(markdown: string): string {
  const bounds = findFrontmatterBounds(markdown);
  if (!bounds) return markdown;
  return markdown.slice(0, bounds.bodyStart).replace(/[^\r\n]/g, ' ') + markdown.slice(bounds.bodyStart);
}

/** Parse a col-widths value: "2 1 1", "2,1,1", "[2, 1, 1]", "equal", "auto". */
export function parseColWidths(raw: string): number[] | 'equal' | 'auto' | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'equal') return 'equal';
  if (trimmed === 'auto') return 'auto';
  let inner = trimmed;
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1);
  const parts = inner.split(/[\s,]+/).filter(s => s.length > 0);
  if (parts.length === 0) return undefined;
  const nums = parts.map(s => Number(s));
  if (nums.some(n => !Number.isFinite(n) || n <= 0)) return undefined;
  return nums;
}

export function normalizeNociteRawForYaml(raw: string, value: NociteValue): string | undefined {
  let normalized = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 0x0D) {
      if (raw.charCodeAt(i + 1) === 0x0A) i++;
      normalized += '\n';
    } else if (code === 0x85 || code === 0x2028 || code === 0x2029) {
      normalized += '\n';
    } else {
      normalized += raw[i];
    }
  }

  const rawLines = normalized.split('\n');
  const mode = nociteValueMode(rawLines[0]);
  const unsafeContinuation = rawLines.slice(1).some(line =>
    /^(?:---|\.\.\.)(?:[ \t]*(?:#.*)?)?$/.test(line)
    || !isNociteContinuationLine(mode, line));
  if (unsafeContinuation) return undefined;

  const semantic = parseNociteRaw(normalized);
  const keys = value.keys.filter(isCitekey);
  if (semantic.wildcard !== value.wildcard || semantic.keys.join('\n') !== keys.join('\n')) {
    return undefined;
  }
  return normalized;
}

function readRawNociteValue(
  lines: string[],
  startIndex: number,
  colonIndex: number,
): { value: NociteValue; lastLineIndex: number } {
  const firstLine = lines[startIndex].replace(/\r$/, '').slice(colonIndex + 1).trimStart();
  const parts = [firstLine];
  let lastLineIndex = startIndex;
  const mode = nociteValueMode(firstLine);
  while (lastLineIndex + 1 < lines.length) {
    const next = lines[lastLineIndex + 1].replace(/\r$/, '');
    if (!isNociteContinuationLine(mode, next)) break;
    parts.push(next);
    lastLineIndex++;
  }

  const raw = parts.join('\n');
  return { value: { ...parseNociteRaw(raw), raw }, lastLineIndex };
}

/** Expand ratios to match numCols by repeating the last value. */
export function expandColWidths(ratios: number[] | 'equal', numCols: number): number[] {
  if (ratios === 'equal') return Array(numCols).fill(1);
  if (ratios.length >= numCols) return ratios.slice(0, numCols);
  const result = [...ratios];
  const last = ratios[ratios.length - 1];
  while (result.length < numCols) result.push(last);
  return result;
}

/** Convert ratios to OOXML fiftieths-of-percent (sum = 5000). */
export function colWidthsToPct(ratios: number[]): number[] {
  const total = ratios.reduce((a, b) => a + b, 0);
  if (total === 0) return ratios.map(() => Math.floor(5000 / ratios.length));
  const raw = ratios.map(r => r / total * 5000);
  // Largest-remainder rounding to ensure exact sum of 5000
  const widths = raw.map(v => Math.floor(v));
  const remaining = 5000 - widths.reduce((a, b) => a + b, 0);
  const byRemainder = raw
    .map((v, i) => ({ i, frac: v - widths[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remaining; k++) widths[byRemainder[k].i] += 1;
  return widths;
}

/**
 * Split YAML frontmatter (delimited by `---`) from the markdown body.
 * Returns the parsed metadata and the remaining body text.
 */
export function parseFrontmatter(markdown: string): { metadata: Frontmatter; body: string; fieldOrder: string[] } {
  const bounds = findFrontmatterBounds(markdown);
  if (!bounds) {
    return { metadata: {}, body: markdown, fieldOrder: [] };
  }

  const yamlBlock = markdown.slice(bounds.contentStart, bounds.contentEnd).trimStart();
  const body = markdown.slice(bounds.bodyStart);

  const metadata: Frontmatter = {};
  const fieldOrder: string[] = [];
  const seenFields = new Set<string>();
  const rawTitleValues: string[] = [];
  const yamlLines = yamlBlock.split('\n');
  for (let lineIdx = 0; lineIdx < yamlLines.length; lineIdx++) {
    const line = yamlLines[lineIdx];
    const colonIdx = findYamlMappingColon(line);
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1);
    const value = parseYamlStringScalar(rawValue);
    if (!seenFields.has(key)) {
      seenFields.add(key);
      fieldOrder.push(key);
    }

    if (key === 'nocite' && line.length === line.trimStart().length) {
      const parsed = readRawNociteValue(yamlLines, lineIdx, colonIdx);
      metadata.nocite = parsed.value;
      lineIdx = parsed.lastLineIndex;
      continue;
    }

    // Handle nested `styles:` block specially
    if (key === 'styles') {
      const styles = new Map<string, CustomStyleDef>();
      let currentName: string | undefined;
      let nameIndent = -1; // indent of the first style-name line (auto-detected)
      // Scan subsequent indented lines
      while (lineIdx + 1 < yamlLines.length) {
        const nextLine = yamlLines[lineIdx + 1];
        // Stop at non-indented lines (next top-level key or blank)
        if (nextLine.length > 0 && !nextLine.startsWith(' ') && !nextLine.startsWith('\t')) break;
        lineIdx++;
        const trimmed = nextLine.trimStart();
        if (!trimmed) continue; // skip blank lines within the block
        const indent = nextLine.length - trimmed.length;
        const innerColon = findYamlMappingColon(trimmed);
        if (innerColon < 0) continue;
        const innerKey = parseYamlStringScalar(trimmed.slice(0, innerColon));
        const innerVal = parseYamlStringScalar(trimmed.slice(innerColon + 1));
        // Auto-detect the style-name indent level from the first indented line
        if (nameIndent < 0) nameIndent = indent;
        if (indent <= nameIndent) {
          // Style name level
          currentName = innerKey;
          if (!styles.has(currentName)) styles.set(currentName, {});
        } else if (currentName) {
          // Property level (4-space indent)
          const def = styles.get(currentName)!;
          switch (innerKey) {
            case 'font':
              if (innerVal) def.font = innerVal;
              break;
            case 'font-size': {
              const n = parseFloat(innerVal);
              if (isFinite(n) && n > 0) def.fontSize = n;
              break;
            }
            case 'font-style': {
              const norm = normalizeFontStyle(innerVal);
              if (norm) def.fontStyle = norm;
              break;
            }
            case 'spacing-before': {
              const n = parseFloat(innerVal);
              if (isFinite(n) && n >= 0) def.spacingBefore = n;
              break;
            }
            case 'spacing-after': {
              const n = parseFloat(innerVal);
              if (isFinite(n) && n >= 0) def.spacingAfter = n;
              break;
            }
            case 'paragraph-indent': {
              const lower = innerVal.toLowerCase();
              if (lower === 'none') {
                def.paragraphIndent = 'none';
              } else {
                const n = parseFloat(innerVal);
                if (isFinite(n) && n >= 0) def.paragraphIndent = n;
              }
              break;
            }
          }
        }
      }
      if (styles.size > 0) metadata.styles = Object.fromEntries(styles);
      continue;
    }

    switch (key) {
      case 'title':
        if (!metadata.title) metadata.title = [];
        metadata.title.push(value);
        rawTitleValues.push(rawValue.trim());
        break;
      case 'author':
        if (value) metadata.author = value;
        break;
      case 'csl':
        metadata.csl = value;
        break;
      case 'locale':
        metadata.locale = value;
        break;
      case 'zotero-notes':
      case 'note-type': {
        const nt = NOTE_TYPE_NAMES[value];
        if (nt) metadata.zoteroNotes = nt;
        break;
      }
      case 'notes': {
        if (value === 'footnotes' || value === 'endnotes') {
          metadata.notes = value;
        }
        break;
      }
      case 'timezone':
        if (value && /^[+-]\d{2}:\d{2}$/.test(value)) metadata.timezone = value;
        break;
      // Implementation note: accepts bibliography / bib / bibtex (first match wins).
      // Normalize with normalizeBibPath(); resolution order: relative to .md dir →
      // workspace root → fallback {basename}.bib. CLI --bib takes precedence.
      case 'bibliography':
      case 'bib':
      case 'bibtex':
        if (value && !metadata.bibliography) metadata.bibliography = value;
        break;
      case 'font':
        if (value) metadata.font = value;
        break;
      case 'code-font':
        if (value) metadata.codeFont = value;
        break;
      case 'font-size': {
        const n = parseFloat(value);
        if (isFinite(n) && n > 0) metadata.fontSize = n;
        break;
      }
      case 'code-font-size': {
        const n = parseFloat(value);
        if (isFinite(n) && n > 0) metadata.codeFontSize = n;
        break;
      }
      case 'header-font':
        if (value) metadata.headerFont = parseInlineArray(rawValue);
        break;
      case 'header-font-size': {
        const arr = parseInlineArray(rawValue).map(s => parseFloat(s)).filter(n => isFinite(n) && n > 0);
        if (arr.length > 0) metadata.headerFontSize = arr;
        break;
      }
      case 'header-font-style': {
        const arr = parseInlineArray(rawValue).map(s => normalizeFontStyle(s)).filter((s): s is string => s !== undefined);
        if (arr.length > 0) metadata.headerFontStyle = arr;
        break;
      }
      case 'title-font':
        if (value) metadata.titleFont = parseInlineArray(rawValue);
        break;
      case 'title-font-size': {
        const arr = parseInlineArray(rawValue).map(s => parseFloat(s)).filter(n => isFinite(n) && n > 0);
        if (arr.length > 0) metadata.titleFontSize = arr;
        break;
      }
      case 'title-font-style': {
        const arr = parseInlineArray(rawValue).map(s => normalizeFontStyle(s)).filter((s): s is string => s !== undefined);
        if (arr.length > 0) metadata.titleFontStyle = arr;
        break;
      }
      case 'code-background-color':
      case 'code-background': {
        if (/^[0-9A-Fa-f]{6}$/.test(value) || value === 'none' || value === 'transparent') {
          metadata.codeBackgroundColor = value;
        }
        break;
      }
      case 'code-font-color':
      case 'code-color': {
        if (/^[0-9A-Fa-f]{6}$/.test(value)) {
          metadata.codeFontColor = value;
        }
        break;
      }
      case 'code-block-inset': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n > 0 && value.trim() === String(n)) {
          metadata.codeBlockInset = n;
        }
        break;
      }
      case 'table-font':
        if (value) metadata.tableFont = value;
        break;
      case 'table-font-size': {
        const n = parseFloat(value);
        if (isFinite(n) && n > 0) metadata.tableFontSize = n;
        break;
      }
      // 0 = disable pipe tables (always HTML); positive = max line width
      case 'pipe-table-max-line-width': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n >= 0 && value.trim() === String(n)) {
          metadata.pipeTableMaxLineWidth = n;
        }
        break;
      }
      case 'grid-table-max-line-width': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n >= 0 && value.trim() === String(n)) {
          metadata.gridTableMaxLineWidth = n;
        }
        break;
      }
      case 'table-col-widths': {
        const parsed = parseColWidths(value);
        if (parsed) metadata.tableColWidths = parsed;
        break;
      }
      case 'table-borders': {
        const v = value.toLowerCase();
        if (v === 'horizontal' || v === 'solid' || v === 'none') metadata.tableBorders = v;
        break;
      }
      case 'table-digits': {
        const parsed = parseTableDigits(value);
        if (parsed !== undefined) metadata.tableDigits = parsed;
        break;
      }
      case 'table-decimal-mark': {
        const parsed = parseTableDecimalMark(value);
        if (parsed !== undefined) metadata.tableDecimalMark = parsed;
        break;
      }
      case 'table-digit-grouping': {
        const parsed = parseTableDigitGrouping(value);
        if (parsed !== undefined) metadata.tableDigitGrouping = parsed;
        break;
      }
      case 'blockquote-style': {
        const style = normalizeBlockquoteStyle(value);
        if (style) metadata.blockquoteStyle = style;
        break;
      }
      case 'callout-labels':
        if (value === 'true') metadata.calloutLabels = true;
        else if (value === 'false') metadata.calloutLabels = false;
        break;
      case 'colors': {
        const scheme = normalizeColorScheme(value);
        if (scheme) metadata.colors = scheme;
        break;
      }
      case 'breaks':
        if (value === 'true') metadata.breaks = true;
        else if (value === 'false') metadata.breaks = false;
        break;
      case 'line-spacing': {
        const lower = value.toLowerCase();
        if (lower === 'single' || lower === '1.5' || lower === 'double') {
          metadata.lineSpacing = lower;
        } else {
          const n = parseFloat(value);
          if (isFinite(n) && n > 0) metadata.lineSpacing = n;
        }
        break;
      }
      case 'paragraph-indent': {
        const lower = value.toLowerCase();
        if (lower === 'none') {
          metadata.paragraphIndent = 'none';
        } else {
          const n = parseFloat(value);
          if (isFinite(n) && n >= 0) metadata.paragraphIndent = n;
        }
        break;
      }
      case 'bibliography-hanging-indent':
        if (value === 'true') metadata.bibliographyHangingIndent = true;
        else if (value === 'false') metadata.bibliographyHangingIndent = false;
        break;
    }
  }

  // Title inline array: expand only when the authored YAML syntax was an array.
  // A quoted scalar may decode to bracket-delimited text and must remain one title.
  if (metadata.title && metadata.title.length === 1) {
    const rawTitle = rawTitleValues[0];
    if (rawTitle.startsWith('[') && rawTitle.endsWith(']')) {
      metadata.title = parseInlineArray(rawTitle);
    }
  }

  return { metadata, body, fieldOrder };
}

/**
 * Serialize a Frontmatter object to a YAML frontmatter string.
 * Returns empty string if metadata has no fields.
 */
export function serializeFrontmatter(metadata: Frontmatter, fieldOrder?: string[]): string {
  const lines: string[] = [];
  const emitString = (key: string, value: string | undefined) => {
    if (value) lines.push(key + ': ' + serializeYamlStringScalar(value));
  };
  const emitArr = (key: string, arr: (string | number)[] | undefined) => {
    if (!arr || arr.length === 0) return;
    if (arr.length === 1) {
      const value = arr[0];
      lines.push(key + ': ' + (typeof value === 'string' ? serializeYamlFlowStringScalar(value) : value));
      return;
    }
    const values = arr.map(value => typeof value === 'string' ? serializeYamlFlowStringScalar(value) : value);
    lines.push(key + ': [' + values.join(', ') + ']');
  };
  const emitNocite = () => {
    const nocite = metadata.nocite;
    if (!nocite) return;
    if (nocite.raw !== undefined) {
      const raw = normalizeNociteRawForYaml(nocite.raw, nocite);
      if (raw !== undefined) {
        const rawLines = raw.split('\n');
        lines.push('nocite:' + (rawLines[0] ? ' ' + rawLines[0] : ''));
        lines.push(...rawLines.slice(1));
        return;
      }
    }
    const values = nocite.keys.filter(isCitekey).map(key => '@' + key);
    if (nocite.wildcard) values.push('@*');
    if (values.length === 1) lines.push("nocite: '" + values[0] + "'");
    else if (values.length > 1) lines.push("nocite: '[" + values.join('; ') + "]'");
  };

  // Map from YAML key name to emission function
  const emitters: Record<string, () => void> = {
    'title': () => { if (metadata.title && metadata.title.length > 0) { for (const t of metadata.title) lines.push('title: ' + serializeYamlStringScalar(t)); } },
    'author': () => emitString('author', metadata.author),
    'csl': () => emitString('csl', metadata.csl),
    'locale': () => emitString('locale', metadata.locale),
    'zotero-notes': () => emitString('zotero-notes', metadata.zoteroNotes),
    'note-type': () => emitters['zotero-notes'](),
    'notes': () => emitString('notes', metadata.notes),
    'timezone': () => emitString('timezone', metadata.timezone),
    'bibliography': () => emitString('bibliography', metadata.bibliography),
    'bib': () => emitters['bibliography'](),
    'bibtex': () => emitters['bibliography'](),
    'nocite': emitNocite,
    'font': () => emitString('font', metadata.font),
    'code-font': () => emitString('code-font', metadata.codeFont),
    'font-size': () => { if (metadata.fontSize !== undefined) lines.push('font-size: ' + metadata.fontSize); },
    'code-font-size': () => { if (metadata.codeFontSize !== undefined) lines.push('code-font-size: ' + metadata.codeFontSize); },
    'header-font': () => emitArr('header-font', metadata.headerFont),
    'header-font-size': () => emitArr('header-font-size', metadata.headerFontSize),
    'header-font-style': () => emitArr('header-font-style', metadata.headerFontStyle),
    'title-font': () => emitArr('title-font', metadata.titleFont),
    'title-font-size': () => emitArr('title-font-size', metadata.titleFontSize),
    'title-font-style': () => emitArr('title-font-style', metadata.titleFontStyle),
    'table-font': () => emitString('table-font', metadata.tableFont),
    'table-font-size': () => { if (metadata.tableFontSize !== undefined) lines.push('table-font-size: ' + metadata.tableFontSize); },
    'table-col-widths': () => {
      if (typeof metadata.tableColWidths === 'string') emitString('table-col-widths', metadata.tableColWidths);
      else if (metadata.tableColWidths) lines.push('table-col-widths: ' + metadata.tableColWidths.join(' '));
    },
    'table-borders': () => emitString('table-borders', metadata.tableBorders),
    'table-digits': () => {
      if (typeof metadata.tableDigits === 'string') emitString('table-digits', metadata.tableDigits);
      else if (metadata.tableDigits !== undefined) lines.push('table-digits: ' + metadata.tableDigits);
    },
    'table-decimal-mark': () => emitString('table-decimal-mark', metadata.tableDecimalMark),
    'table-digit-grouping': () => emitString('table-digit-grouping', metadata.tableDigitGrouping),
    'code-background-color': () => emitString('code-background-color', metadata.codeBackgroundColor),
    'code-background': () => emitters['code-background-color'](),
    'code-font-color': () => emitString('code-font-color', metadata.codeFontColor),
    'code-color': () => emitters['code-font-color'](),
    'code-block-inset': () => { if (metadata.codeBlockInset !== undefined) lines.push('code-block-inset: ' + metadata.codeBlockInset); },
    'pipe-table-max-line-width': () => { if (metadata.pipeTableMaxLineWidth !== undefined) lines.push('pipe-table-max-line-width: ' + metadata.pipeTableMaxLineWidth); },
    'grid-table-max-line-width': () => { if (metadata.gridTableMaxLineWidth !== undefined) lines.push('grid-table-max-line-width: ' + metadata.gridTableMaxLineWidth); },
    'blockquote-style': () => emitString('blockquote-style', metadata.blockquoteStyle),
    'callout-labels': () => { if (metadata.calloutLabels !== undefined) lines.push('callout-labels: ' + metadata.calloutLabels); },
    'colors': () => emitString('colors', metadata.colors),
    'styles': () => {
      if (!metadata.styles || Object.keys(metadata.styles).length === 0) return;
      lines.push('styles:');
      for (const [name, def] of Object.entries(metadata.styles)) {
        lines.push('  ' + serializeYamlMappingKey(name) + ':');
        if (def.font) lines.push('    font: ' + serializeYamlStringScalar(def.font));
        if (def.fontSize !== undefined) lines.push('    font-size: ' + def.fontSize);
        if (def.fontStyle) lines.push('    font-style: ' + serializeYamlStringScalar(def.fontStyle));
        if (def.spacingBefore !== undefined) lines.push('    spacing-before: ' + def.spacingBefore);
        if (def.spacingAfter !== undefined) lines.push('    spacing-after: ' + def.spacingAfter);
        if (def.paragraphIndent !== undefined) lines.push('    paragraph-indent: ' + def.paragraphIndent);
      }
    },
    'breaks': () => { if (metadata.breaks !== undefined) lines.push('breaks: ' + metadata.breaks); },
    'line-spacing': () => {
      if (typeof metadata.lineSpacing === 'string') emitString('line-spacing', metadata.lineSpacing);
      else if (metadata.lineSpacing !== undefined) lines.push('line-spacing: ' + metadata.lineSpacing);
    },
    'paragraph-indent': () => {
      if (typeof metadata.paragraphIndent === 'string') emitString('paragraph-indent', metadata.paragraphIndent);
      else if (metadata.paragraphIndent !== undefined) lines.push('paragraph-indent: ' + metadata.paragraphIndent);
    },
    'bibliography-hanging-indent': () => { if (metadata.bibliographyHangingIndent !== undefined) lines.push('bibliography-hanging-indent: ' + metadata.bibliographyHangingIndent); },
  };

  // Default emission order (backward compatible)
  const defaultOrder = [
    'title', 'author', 'csl', 'locale', 'zotero-notes', 'notes', 'timezone',
    'bibliography', 'nocite', 'font', 'code-font', 'font-size', 'code-font-size',
    'header-font', 'header-font-size', 'header-font-style',
    'title-font', 'title-font-size', 'title-font-style',
    'table-font', 'table-font-size', 'table-col-widths', 'table-borders',
    'table-digits', 'table-decimal-mark', 'table-digit-grouping',
    'code-background-color', 'code-font-color', 'code-block-inset',
    'pipe-table-max-line-width', 'grid-table-max-line-width',
    'blockquote-style', 'callout-labels', 'colors', 'styles', 'breaks',
    'line-spacing', 'paragraph-indent', 'bibliography-hanging-indent',
  ];

  const aliasToCanonical: Record<string, string> = {
    'note-type': 'zotero-notes',
    'bib': 'bibliography',
    'bibtex': 'bibliography',
    'code-background': 'code-background-color',
    'code-color': 'code-font-color',
  };

  const canonicalToAliases: Record<string, string[]> = {};
  for (const [alias, canonical] of Object.entries(aliasToCanonical)) {
    if (!canonicalToAliases[canonical]) canonicalToAliases[canonical] = [];
    canonicalToAliases[canonical].push(alias);
  }

  const getOwn = <T>(record: Record<string, T>, key: string): T | undefined =>
    Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
  const order = fieldOrder && fieldOrder.length > 0 ? fieldOrder : defaultOrder;
  const emitted = new Set<string>();

  for (const key of order) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    const canonical = getOwn(aliasToCanonical, key);
    if (canonical) {
      emitted.add(canonical);
      const siblingAliases = getOwn(canonicalToAliases, canonical);
      if (siblingAliases) for (const a of siblingAliases) emitted.add(a);
    }
    const aliases = getOwn(canonicalToAliases, key);
    if (aliases) for (const a of aliases) emitted.add(a);
    const emitter = getOwn(emitters, key);
    if (emitter) emitter();
  }

  // Emit any remaining fields not in the provided order
  for (const key of defaultOrder) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    const emitter = getOwn(emitters, key);
    if (emitter) emitter();
  }

  if (lines.length === 0) return '';
  return '---\n' + lines.join('\n') + '\n---\n';
}

/** Ensure a bibliography path ends with .bib */
export function normalizeBibPath(p: string): string {
  if (!p) return p;
  return p.endsWith('.bib') ? p : p + '.bib';
}
