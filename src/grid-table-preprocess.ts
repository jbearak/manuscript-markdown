// Shared grid table preprocessing — used by both md-to-docx and the preview plugin.

const GRID_TABLE_SEPARATOR_RE = /^\+[-=]+(\+[-=]+)*\+$/;
export const GRID_TABLE_PLACEHOLDER_PREFIX = '<!-- MANUSCRIPT_GRID_TABLE:';

export interface GridTableData {
  rows: Array<{ cells: string[]; header: boolean }>;
  colWidths?: number[]; // inner character widths of each column, derived from +---+---+ separators
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
        const cells: string[] = [];
        for (let col = 0; col < numCols; col++) {
          const left = colBoundaries[col] + 1 + indent;
          const right = colBoundaries[col + 1] + indent;
          const cellLines: string[] = [];
          for (const contentLine of currentContent) {
            const raw = contentLine.length >= right
              ? contentLine.slice(left, right)
              : contentLine.slice(left);
            cellLines.push(raw.replace(/^\s*\|?\s*/, '').replace(/\s*$/, ''));
          }

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
  return rows.length > 0 ? { rows, colWidths } : null;
}
