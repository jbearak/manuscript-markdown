import { isInsideCodeRegion, type CodeRegion } from './code-regions';

export type DollarDelimiterLength = 1 | 2;

export interface DollarMathOptions {
  excludedRegions?: readonly CodeRegion[];
  /** DOCX compatibility accepts display delimiters whose dollar run exceeds two. */
  displayRun?: 'exact' | 'at-least';
}

export type DollarMathMatch =
  | {
    kind: 'math';
    start: number;
    end: number;
    contentStart: number;
    contentEnd: number;
    delimiterLength: DollarDelimiterLength;
  }
  | { kind: 'currency' };

export function isEscapedAt(content: string, offset: number): boolean {
  let backslashes = 0;
  for (let i = offset - 1; i >= 0 && content.charCodeAt(i) === 0x5C; i--) backslashes++;
  return backslashes % 2 === 1;
}

function dollarRunLength(content: string, offset: number): number {
  let length = 0;
  while (offset + length < content.length && content.charCodeAt(offset + length) === 0x24) length++;
  return length;
}

function isExcluded(offset: number, regions?: readonly CodeRegion[]): boolean {
  return regions !== undefined && regions.length > 0 && isInsideCodeRegion(offset, regions);
}

function findDollarMathClose(
  content: string,
  start: number,
  delimiterLength: DollarDelimiterLength,
  options?: DollarMathOptions,
): number {
  const exactRun = delimiterLength === 1 || options?.displayRun !== 'at-least';
  for (let i = start; i < content.length; i++) {
    if (content.charCodeAt(i) !== 0x24 || isEscapedAt(content, i) ||
        isExcluded(i, options?.excludedRegions)) continue;
    const runLength = dollarRunLength(content, i);
    if ((exactRun && runLength === delimiterLength) || (!exactRun && runLength >= delimiterLength)) return i;
    i += runLength - 1;
  }
  return -1;
}

/** Classify a dollar-delimited math span beginning at `start`. */
export function findDollarMathAt(
  content: string,
  start: number,
  options?: DollarMathOptions,
): DollarMathMatch | undefined {
  if (content.charCodeAt(start) !== 0x24 || isEscapedAt(content, start) ||
      isExcluded(start, options?.excludedRegions)) return undefined;

  const openingRunLength = dollarRunLength(content, start);
  let delimiterLength: DollarDelimiterLength;
  if (openingRunLength === 1) delimiterLength = 1;
  else if (openingRunLength === 2 || (openingRunLength > 2 && options?.displayRun === 'at-least')) delimiterLength = 2;
  else return undefined;

  if (delimiterLength === 1) {
    const before = content.charAt(start - 1);
    if ((before === '$' && !isEscapedAt(content, start - 1)) || /\w/.test(before)) return undefined;
    const next = content.charCodeAt(start + 1);
    if (next >= 0x30 && next <= 0x39 &&
        /^\d[\d,.]*(?:\s|$)/.test(content.slice(start + 1))) return { kind: 'currency' };
  }

  const close = findDollarMathClose(content, start + delimiterLength, delimiterLength, options);
  if (close === -1) return undefined;
  if (delimiterLength === 1 && /\w/.test(content.charAt(close + 1))) return undefined;

  return {
    kind: 'math',
    start,
    end: close + delimiterLength,
    contentStart: start + delimiterLength,
    contentEnd: close,
    delimiterLength,
  };
}

/** Find all recognized dollar-math spans outside excluded Markdown regions. */
export function computeDollarMathRegions(content: string, excludedRegions?: readonly CodeRegion[]): CodeRegion[] {
  const regions: CodeRegion[] = [];
  const options = excludedRegions?.length ? { excludedRegions } : undefined;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) !== 0x24) continue;
    const runLength = dollarRunLength(content, i);
    if (runLength > 2) {
      i += runLength - 1;
      continue;
    }
    const match = findDollarMathAt(content, i, options);
    if (!match || match.kind !== 'math') continue;
    regions.push({ start: match.start, end: match.end });
    i = match.end - 1;
  }
  return regions;
}
