import { describe, expect, test } from 'bun:test';
import {
  HTML_TABLE_CELL_SOURCE_KINDS,
  MAX_TABLE_DIGITS,
  matchTables,
  tableIdentity,
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

  describe('matchTables', () => {
    const id = (first: string, rest = 'x', scope = '') => tableIdentity([[first], [rest]], scope);
    const [a, b, c, d] = [id('a'), id('b'), id('c'), id('d')];

    test('matches each table to itself where Word changed none', () => {
      expect(matchTables([a, b, a, c], [a, b, a, c])).toEqual([0, 1, 2, 3]);
    });

    test('matches the tables after one Word deleted or added to those export wrote', () => {
      expect(matchTables([a, b, c], [b, c])).toEqual([1, 2]);
      expect(matchTables([a, b, c], [a, c])).toEqual([0, 2]);
      expect(matchTables([b, c], [d, b, c])).toEqual([undefined, 0, 1]);
    });

    test('matches a table whose cells Word edited by its first row', () => {
      expect(matchTables([a, b, c], [id('b', 'edited'), c])).toEqual([1, 2]);
      expect(matchTables([a, b, c], [d, a, id('b', 'edited'), c])).toEqual([undefined, 0, 1, 2]);
    });

    test('matches a table whose first row Word edited by its order, where as many are left', () => {
      expect(matchTables([a, b, c], [a, d, c])).toEqual([0, 1, 2]);
      expect(matchTables([a, b, c], [d, c])).toEqual([undefined, 2]);
    });

    test('matches the body\'s and the notes\' tables apart', () => {
      const n = id('n', 'x', 'footnote:1');
      expect(matchTables([a, n], [n])).toEqual([1]);
      expect(matchTables([a, n], [id('n', 'edited', 'footnote:2')])).toEqual([1]);
      expect(matchTables([n], [a])).toEqual([undefined]);
    });
  });
});
