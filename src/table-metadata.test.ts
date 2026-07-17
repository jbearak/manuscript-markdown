import { describe, expect, test } from 'bun:test';
import {
  HTML_TABLE_CELL_SOURCE_KINDS,
  MAX_TABLE_DIGITS,
  parseHtmlTableCellSourceKind,
  parseTableDigits,
  parseTableDecimalMark,
  parseTableDigitGrouping,
} from './table-metadata';

describe('table metadata', () => {
  test('parses table digits with the canonical bound and normalization', () => {
    expect(parseTableDigits(' SOURCE ')).toBe('source');
    expect(parseTableDigits('001')).toBe(1);
    expect(parseTableDigits(String(MAX_TABLE_DIGITS))).toBe(MAX_TABLE_DIGITS);
    expect(parseTableDigits(String(MAX_TABLE_DIGITS + 1))).toBeUndefined();
    expect(parseTableDigits('-1')).toBeUndefined();
    expect(parseTableDigits('1.0')).toBeUndefined();
  });

  test('parses decimal marks and digit grouping with canonical values', () => {
    expect(parseTableDecimalMark(' MIDPOINT ')).toBe('midpoint');
    expect(parseTableDecimalMark('period')).toBeUndefined();
    expect(parseTableDigitGrouping(' THIN-SPACE ')).toBe('thin-space');
    expect(parseTableDigitGrouping('midpoint')).toBeUndefined();
  });

  test('accepts only exact cell source kinds', () => {
    for (const kind of HTML_TABLE_CELL_SOURCE_KINDS) {
      expect(parseHtmlTableCellSourceKind(kind)).toBe(kind);
    }
    expect(parseHtmlTableCellSourceKind('NUMBER')).toBeUndefined();
    expect(parseHtmlTableCellSourceKind(' number ')).toBeUndefined();
    expect(parseHtmlTableCellSourceKind('unknown')).toBeUndefined();
  });
});
