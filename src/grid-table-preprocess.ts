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
// these ranges occupy two terminal columns; everything else is treated as
// single-width.  This is intentionally conservative — zero-width joiners,
// combining marks, etc. are counted as width-1 which is acceptable for the
// "does the pipe table fit?" heuristic.
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
    (cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji & symbols
    (cp >= 0x20000 && cp <= 0x2ffff) || // CJK Extension B–F
    (cp >= 0x30000 && cp <= 0x3ffff)    // CJK Extension G+
  );
}

export function getDisplayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    width += isFullWidth(cp) ? 2 : 1;
  }
  return width;
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

/**
 * The text of each column of a grid table's line, between the display
 * columns of the separator's + signs, a wide character taking two, as Pandoc
 * reads a table and import pads one. Expand Table pads a table by
 * characters, so a line whose | signs are under the + signs by their
 * indices, and not by display columns, is read by indices.
 */
function gridLineCells(line: string, boundaries: number[]): string[] {
  const chars: string[] = [];
  const display: number[] = [];
  const index: number[] = [];
  let width = 0;
  let offset = 0;
  for (const ch of line) {
    chars.push(ch);
    display.push(width);
    index.push(offset);
    width += getDisplayWidth(ch);
    offset += ch.length;
  }
  const aligned = (columns: number[]) => boundaries.every(b => chars[columns.indexOf(b)] === '|');
  const columns = aligned(display) || !aligned(index) ? display : index;
  return boundaries.slice(0, -1).map((b, c) => chars.filter((_ch, k) => columns[k] > b && columns[k] < boundaries[c + 1]).join(''));
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

  // Collect rows: content lines between separator lines form a logical row.
  // The '=' separator marks all rows above it as header rows.
  const rows: Array<{ cells: string[]; header: boolean }> = [];
  let currentContent: string[] = [];

  for (let li = 1; li < lines.length; li++) {
    const trimmed = lines[li].trim();
    if (GRID_TABLE_SEPARATOR_RE.test(trimmed)) {
      // This separator ends the current row
      if (currentContent.length > 0) {
        const lineCells = currentContent.map(line => gridLineCells(line, colBoundaries.map(b => b + indent)));
        const cells: string[] = [];
        for (let col = 0; col < numCols; col++) {
          const cellLines = lineCells.map(cells => cells[col].replace(/^\s*/, '').replace(/\s*$/, ''));

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
      currentContent.push(lines[li]);
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
