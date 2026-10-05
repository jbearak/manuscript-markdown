// Shared grid table preprocessing — used by both md-to-docx and the preview plugin.

// A colon at either end of a column's dashes sets its alignment, as in +:==+==:+
export const GRID_TABLE_SEPARATOR_RE = /^\+:?[-=]+:?(\+:?[-=]+:?)*\+$/;
export const GRID_TABLE_PLACEHOLDER_PREFIX = '<!-- MANUSCRIPT_GRID_TABLE:';

export type TableAlign = 'left' | 'center' | 'right';

export interface GridTableData {
  rows: Array<{ cells: string[]; header: boolean }>;
  colWidths?: number[]; // inner character widths of each column, derived from +---+---+ separators
  aligns?: Array<TableAlign | null>; // each column's alignment, from the colons of the header's separator, or the top one
}

// East Asian Wide / Fullwidth code-point ranges (UAX #11).  Characters in
// these ranges occupy two terminal columns, as do emoji (see getDisplayWidth).
function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||  // CJK Radicals, Kangxi, Symbols
    (cp >= 0x3040 && cp <= 0x33bf) ||  // Hiragana, Katakana, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||  // CJK Extension A
    (cp >= 0x4e00 && cp <= 0xa4cf) ||  // CJK Unified, Yi
    (cp >= 0xac00 && cp <= 0xd7af) ||  // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe6f) ||  // Vertical forms, CJK compat forms
    (cp >= 0xff01 && cp <= 0xff60) ||  // Fullwidth Latin/Symbols
    (cp >= 0xffe0 && cp <= 0xffe6) ||  // Fullwidth Signs
    (cp >= 0x1f200 && cp <= 0x1f2ff) || // Enclosed Ideographic Supplement
    (cp >= 0x20000 && cp <= 0x2ffff) || // CJK Extension B–F
    (cp >= 0x30000 && cp <= 0x3ffff)    // CJK Extension G+
  );
}

const ZERO_WIDTH_RE = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u;
const PICTOGRAPHIC_RE = /^\p{Extended_Pictographic}$/u;

/**
 * A string's width in the columns of a monospace editor, as Pandoc counts
 * them in a grid table: two for a wide character, as a CJK one, or an emoji,
 * and none for a combining mark or a format character, as a joiner or a soft
 * hyphen. An emoji's sequence counts as the emoji: an emoji a joiner joins
 * to it counts none, and a variation selector-16 after it, or a skin tone,
 * makes it wide, as ☝🏽, where it's narrow, and else counts none. A regional
 * indicator counts one, so a flag, two of them, counts two.
 */
export function getDisplayWidth(str: string): number {
  let width = 0;
  for (const w of characterWidths(str)) width += w;
  return width;
}

/** The width of each character of `str`, by code point, as getDisplayWidth
 *  counts it in its sequence, as a skin tone counts none after an emoji */
function characterWidths(str: string): number[] {
  const widths: number[] = [];
  // The last character that isn't a mark, and what it counted
  let base = '';
  let baseWidth = 0;
  let joined = false;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    let w: number;
    if (cp < 0x7f) {
      // ASCII, which is most text, without the tests of its properties
      w = 1;
      base = ch;
      baseWidth = 1;
      joined = false;
    } else if (cp === 0xfe0f || cp >= 0x1f3fb && cp <= 0x1f3ff && PICTOGRAPHIC_RE.test(base)) {
      // A variation selector-16, or a skin tone after an emoji, makes it
      // wide, which stays the sequence's base, as a joiner after joins to it
      w = baseWidth === 1 ? 1 : 0;
      baseWidth += w;
    } else if (ZERO_WIDTH_RE.test(ch)) {
      w = 0;
      if (cp === 0x200d) joined = PICTOGRAPHIC_RE.test(base);
    } else {
      w = joined && PICTOGRAPHIC_RE.test(ch) ? 0
        : cp >= 0x1f1e6 && cp <= 0x1f1ff ? 1
          : isFullWidth(cp) || EMOJI_PRESENTATION_RE.test(ch) ? 2 : 1;
      base = ch;
      baseWidth = w;
      joined = false;
    }
    widths.push(w);
  }
  return widths;
}

/** The alignment a column's dashes in a separator set: :-- left, :-: center, --: right */
export function separatorAlign(dashes: string): TableAlign | null {
  const left = dashes.startsWith(':');
  const right = dashes.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/** A decoded table's alignment of a column, if it's one a separator gives:
 *  the placeholder is an HTML comment, which the Markdown can also hold, so
 *  its JSON can hold anything */
export function gridColumnAlign(data: { aligns?: unknown }, ci: number): TableAlign | null {
  const align: unknown = Array.isArray(data.aligns) ? data.aligns[ci] : undefined;
  return align === 'left' || align === 'center' || align === 'right' ? align : null;
}

export interface GridTableSourceMapEntry {
  outputStart: number;
  outputEnd: number;
  sourceStart: number;
  sourceEnd: number;
}

export interface GridTablePreprocessResult {
  output: string;
  sourceMap: GridTableSourceMapEntry[];
}

/**
 * Detect Pandoc-style grid tables in markdown and replace them with
 * HTML-comment placeholders carrying JSON-encoded table data.
 * This runs before markdown-it tokenization so the grid table blocks
 * don't confuse the parser.
 */
export function preprocessGridTables(markdown: string): string {
  return preprocessGridTablesWithSourceMap(markdown).output;
}

/** Preprocess grid tables and retain placeholder-to-source ranges for diagnostics. */
export function preprocessGridTablesWithSourceMap(markdown: string): GridTablePreprocessResult {
  const lines = markdown.split('\n');
  const lineOffsets: number[] = [];
  let inputOffset = 0;
  for (const line of lines) { lineOffsets.push(inputOffset); inputOffset += line.length + 1; }
  const result: string[] = [];
  const replacements: Array<{ resultIndex: number; sourceStart: number; sourceEnd: number }> = [];
  let i = 0;
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;

  while (i < lines.length) {
    // Track fenced code blocks to avoid false grid table detection inside them
    const fenceMatch = lines[i].match(/^ {0,3}([`~]{3,})/);
    if (fenceMatch) {
      const run = fenceMatch[1];
      const runChar = run[0] as '`' | '~';
      if (!fenceChar) {
        fenceChar = runChar;
        fenceLen = run.length;
      } else if (runChar === fenceChar && run.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      result.push(lines[i]);
      i++;
      continue;
    }
    if (fenceChar) {
      result.push(lines[i]);
      i++;
      continue;
    }
    if (GRID_TABLE_SEPARATOR_RE.test(lines[i].trim()) && !/^(?: {4}|\t)/.test(lines[i])) {
      // Potential grid table start — collect all lines until we leave the table
      const tableLines: string[] = [];
      const start = i;
      while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (GRID_TABLE_SEPARATOR_RE.test(trimmed) || (trimmed.startsWith('|') && trimmed.endsWith('|'))) {
          tableLines.push(lines[i]);
          i++;
        } else {
          break;
        }
      }

      // Validate: must start and end with separator, have at least 3 lines
      if (tableLines.length >= 3 && GRID_TABLE_SEPARATOR_RE.test(tableLines[tableLines.length - 1].trim())) {
        const parsed = parseGridTable(tableLines);
        if (parsed && parsed.rows.length > 0) {
          const json = JSON.stringify(parsed);
          // Base64-encode to prevent cell content containing '-->' from
          // breaking the HTML comment wrapper.
          const encoded = Buffer.from(json).toString('base64');
          // Ensure blank lines around the placeholder so markdown-it treats
          // it as an html_block (Type 2: HTML comment).
          if (result.length > 0 && result[result.length - 1].trim() !== '') {
            result.push('');
          }
          const placeholder = GRID_TABLE_PLACEHOLDER_PREFIX + encoded + ' -->';
          const resultIndex = result.length;
          result.push(placeholder);
          replacements.push({
            resultIndex,
            sourceStart: lineOffsets[start],
            sourceEnd: lineOffsets[start] + tableLines.join('\n').length,
          });
          result.push('');
          continue;
        }
      }

      // Not a valid grid table — emit lines as-is
      for (let j = start; j < i; j++) {
        result.push(lines[j]);
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  const output = result.join('\n');
  const sourceMap: GridTableSourceMapEntry[] = [];
  const outputLineOffsets: number[] = [];
  let outputOffset = 0;
  for (const line of result) { outputLineOffsets.push(outputOffset); outputOffset += line.length + 1; }
  for (const replacement of replacements) {
    const outputStart = outputLineOffsets[replacement.resultIndex];
    const outputEnd = outputStart + result[replacement.resultIndex].length;
    sourceMap.push({ outputStart, outputEnd, sourceStart: replacement.sourceStart, sourceEnd: replacement.sourceEnd });
  }
  return { output, sourceMap };
}

/** A grid table's line by characters, with each one's display column and
 *  its | signs, and the indices of those under the separator's + signs, by
 *  display columns and by characters, -1 where none is */
interface GridLine {
  chars: string[];
  columns: number[];
  pipes: Array<{ k: number; column: number }>;
  display: number[];
  index: number[];
}

function gridLine(line: string, boundaries: number[]): GridLine {
  const chars: string[] = [];
  const columns: number[] = [];
  const display = new Map<number, number>();
  const index = new Map<number, number>();
  const pipes: Array<{ k: number; column: number }> = [];
  // Each character's width in its sequence, as the padding counts it
  const widths = characterWidths(line);
  let width = 0;
  let offset = 0;
  for (const ch of line) {
    const k = chars.length;
    chars.push(ch);
    columns.push(width);
    if (ch === '|') {
      display.set(width, k);
      index.set(offset, k);
      pipes.push({ k, column: width });
    }
    width += widths[k];
    offset += ch.length;
  }
  const at = (columns: Map<number, number>) => boundaries.map(b => columns.get(b) ?? -1);
  return { chars, columns, pipes, display: at(display), index: at(index) };
}

/** Whether a line's cuts are all under + signs and end at its last |, its
 *  edge, and not at a | in its last cell's text */
function fitsLine(line: GridLine, cuts: number[]): boolean {
  return !cuts.includes(-1) && cuts[cuts.length - 1] === line.pipes[line.pipes.length - 1].k;
}

/**
 * The text of each column of a grid table's line, between its | signs under
 * the separator's + signs: by display columns, a wide character taking two,
 * as Pandoc reads a table and import pads one. Expand Table pads a table by
 * characters, so a line whose | signs are under the + signs by their
 * indices, and not by display columns, is read by indices. A line neither
 * lines up, as with a character whose width an editor counts otherwise, is
 * cut at its edges and at the | nearest each + between by display columns,
 * or with too few, as a cell spanning columns, at the + signs' display
 * columns.
 *
 * A line can line up both ways, as with narrow characters outside the BMP
 * and wide ones in it, where a | in a cell's text is under a +. The way that
 * fits it (see fitsLine) wins, and where both do, the table's `layout`, the
 * way its lines that fit one way alone are padded, and without one, the way
 * whose edges have a space or the line's end on each side, as import and
 * Expand Table write them, where a | in a cell's text can have text, and
 * else characters, as a table was read before display columns were. Import
 * checks that a table it writes reads back so (see readGridTableCells).
 */
function gridLineCells(line: GridLine, boundaries: number[], layout?: 'display' | 'characters'): string[] {
  const { chars, columns, pipes } = line;
  const padded = (cuts: number[]) => cuts.filter(k => (k === 0 || /[ \t]/.test(chars[k - 1]))
    && (k === chars.length - 1 || /[ \t]/.test(chars[k + 1]))).length;
  let cuts = line.display;
  const byIndex = line.index;
  const indexFits = fitsLine(line, byIndex) && (!fitsLine(line, cuts)
    || (layout ? layout === 'characters' : padded(byIndex) >= padded(cuts)));
  if (indexFits || cuts.includes(-1) && !byIndex.includes(-1)) {
    cuts = byIndex;
  } else if (cuts.includes(-1) && pipes.length >= boundaries.length) {
    const last = boundaries.length - 1;
    let next = 1;
    cuts = boundaries.map((b, c) => {
      // The line's first and last | are its edges, and between them, the
      // nearest | that leaves one for each + after
      if (c === 0) return pipes[0].k;
      if (c === last) return pipes[pipes.length - 1].k;
      let best = next;
      for (let p = next; p < pipes.length - (last - c); p++) {
        if (Math.abs(pipes[p].column - b) < Math.abs(pipes[best].column - b)) best = p;
      }
      next = best + 1;
      return pipes[best].k;
    });
  }
  if (cuts.includes(-1)) {
    return boundaries.slice(0, -1).map((b, c) => chars.filter((_ch, k) => columns[k] > b && columns[k] < boundaries[c + 1]).join(''));
  }
  return boundaries.slice(0, -1).map((_b, c) => chars.slice(cuts[c] + 1, cuts[c + 1]).join(''));
}

/** The text of each cell of each row of the grid table `lines`, as export
 *  reads them, or null where they don't form one */
export function readGridTableCells(lines: string[]): string[][] | null {
  return parseGridTable(lines)?.rows.map(row => row.cells) ?? null;
}

/**
 * Parse a block of grid table lines into structured data.
 * Returns null if the lines don't form a valid grid table.
 */
function parseGridTable(lines: string[]): GridTableData | null {
  // Find column boundaries from the first separator line.
  // Compute leading indent so we offset boundary indices when slicing
  // content from untrimmed lines.
  const indent = lines[0].length - lines[0].trimStart().length;
  const firstSep = lines[0].trim();
  const colBoundaries: number[] = [];
  for (let c = 0; c < firstSep.length; c++) {
    if (firstSep[c] === '+') {
      colBoundaries.push(c);
    }
  }
  if (colBoundaries.length < 2) return null;
  const numCols = colBoundaries.length - 1;

  const boundaries = colBoundaries.map(b => b + indent);
  const gridLines = lines.map((line, li) => li > 0 && !GRID_TABLE_SEPARATOR_RE.test(line.trim()) ? gridLine(line, boundaries) : undefined);
  // A table is padded one way: by display columns, as Pandoc and import pad
  // one, or by characters, as Expand Table does, which its lines that fit
  // one way alone show
  let byDisplay = 0;
  let byCharacters = 0;
  for (const line of gridLines) {
    if (!line) continue;
    const display = fitsLine(line, line.display);
    const index = fitsLine(line, line.index);
    if (display && !index) byDisplay++;
    if (index && !display) byCharacters++;
  }

  // Collect rows: content lines between separator lines form a logical row.
  // The '=' separator marks all rows above it as header rows.
  const rows: Array<{ cells: string[]; header: boolean }> = [];
  let currentContent: GridLine[] = [];

  for (let li = 1; li < lines.length; li++) {
    const trimmed = lines[li].trim();
    if (GRID_TABLE_SEPARATOR_RE.test(trimmed)) {
      // This separator ends the current row
      if (currentContent.length > 0) {
        const layout = byCharacters > byDisplay ? 'characters' : byDisplay > byCharacters ? 'display' : undefined;
        const lineCells = currentContent.map(line => gridLineCells(line, boundaries, layout));
        const cells: string[] = [];
        for (let col = 0; col < numCols; col++) {
          const cellLines = lineCells.map(cells => cells[col].replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));

          cells.push(cellLines.join('\n'));
        }
        // header=false initially; we'll retroactively mark header rows below
        rows.push({ cells, header: false });
      }
      // If this separator uses '=', all rows above it are header rows
      if (/=/.test(trimmed)) {
        for (const row of rows) {
          row.header = true;
        }
      }
      currentContent = [];
    } else if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      currentContent.push(gridLines[li]!);
    } else {
      return null;
    }
  }

  const colWidths: number[] = [];
  for (let c = 0; c < numCols; c++) {
    colWidths.push(colBoundaries[c + 1] - colBoundaries[c] - 1);
  }
  // Alignment, as Pandoc reads it: from the separator under the header, or
  // for a table without one, from the top line
  const headerSep = lines.slice(1).find(line => GRID_TABLE_SEPARATOR_RE.test(line.trim()) && line.includes('='));
  const aligns = (headerSep ?? lines[0]).trim().slice(1, -1).split('+').map(separatorAlign);
  if (rows.length === 0) return null;
  return aligns.length === numCols && aligns.some(Boolean) ? { rows, colWidths, aligns } : { rows, colWidths };
}
