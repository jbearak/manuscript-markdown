import { describe, it, expect } from 'bun:test';
import { LineMap } from './line-map';

describe('LineMap', () => {
  describe('identity', () => {
    it('returns input unchanged', () => {
      const map = LineMap.identity();
      expect(map.isIdentity).toBe(true);
      expect(map.remap(0)).toBe(0);
      expect(map.remap(5)).toBe(5);
      expect(map.remap(100)).toBe(100);
    });
  });

  describe('remap', () => {
    it('preserves explicit provenance across collapsed and repeated boundaries', () => {
      const map = LineMap.fromLineMappings([0, 0, 2, 3]);
      expect(map.remap(0)).toBe(0);
      expect(map.remap(1)).toBe(0);
      expect(map.remap(2)).toBe(2);
      expect(map.remap(3)).toBe(3);
    });

    it('maps 1:1 within a segment', () => {
      const map = LineMap.fromSegments([
        { preprocessedStart: 0, originalStart: 0, length: 5 },
        { preprocessedStart: 7, originalStart: 15, length: 4 },
      ]);
      expect(map.remap(0)).toBe(0);
      expect(map.remap(4)).toBe(4);
      expect(map.remap(7)).toBe(15);
      expect(map.remap(9)).toBe(17);
    });

    it('clamps gap lines to end of preceding segment', () => {
      const map = LineMap.fromSegments([
        { preprocessedStart: 0, originalStart: 0, length: 5 },
        { preprocessedStart: 8, originalStart: 15, length: 4 },
      ]);
      expect(map.remap(5)).toBe(5);
      expect(map.remap(6)).toBe(5);
      expect(map.remap(7)).toBe(5);
    });

    it('clamps lines before first segment to start of first segment', () => {
      const map = LineMap.fromSegments([
        { preprocessedStart: 3, originalStart: 10, length: 5 },
      ]);
      expect(map.remap(0)).toBe(10);
      expect(map.remap(2)).toBe(10);
    });

    it('clamps lines after last segment to end of last segment', () => {
      const map = LineMap.fromSegments([
        { preprocessedStart: 0, originalStart: 0, length: 5 },
      ]);
      expect(map.remap(5)).toBe(5);
      expect(map.remap(10)).toBe(5);
    });

    it('handles single-line segments', () => {
      const map = LineMap.fromSegments([
        { preprocessedStart: 0, originalStart: 0, length: 3 },
        { preprocessedStart: 4, originalStart: 10, length: 1 },
        { preprocessedStart: 6, originalStart: 20, length: 2 },
      ]);
      expect(map.remap(4)).toBe(10);
      expect(map.remap(5)).toBe(11); // gap clamp
    });
  });

  describe('chain', () => {
    it('chains identity with any map', () => {
      const map = LineMap.fromSegments([
        { preprocessedStart: 0, originalStart: 0, length: 5 },
        { preprocessedStart: 6, originalStart: 10, length: 3 },
      ]);
      const c1 = LineMap.chain(LineMap.identity(), map);
      const c2 = LineMap.chain(map, LineMap.identity());
      expect(c1.remap(0)).toBe(0);
      expect(c1.remap(6)).toBe(10);
      expect(c2.remap(0)).toBe(0);
      expect(c2.remap(6)).toBe(10);
    });

    it('chains two non-trivial maps', () => {
      // Step 1: grid table at original lines 5-14 collapsed to 2 output lines
      // step1-preprocessed 0-4 → original 0-4
      // step1-preprocessed 7+ → original 15+
      const map1 = LineMap.fromSegments([
        { preprocessedStart: 0, originalStart: 0, length: 5 },
        { preprocessedStart: 7, originalStart: 15, length: 10 },
      ]);

      // Step 2: collapse at step1 line 9 removes a line
      // step2-preprocessed 0-7 → step1 0-7
      // step2-preprocessed 8+ → step1 9+
      const map2 = LineMap.fromSegments([
        { preprocessedStart: 0, originalStart: 0, length: 8 },
        { preprocessedStart: 8, originalStart: 9, length: 8 },
      ]);

      const chained = LineMap.chain(map1, map2);
      // Final line 0 → step1 line 0 → original line 0
      expect(chained.remap(0)).toBe(0);
      // Final line 4 → step1 line 4 → original line 4
      expect(chained.remap(4)).toBe(4);
      // Final line 7 → step1 line 7 → original line 15
      expect(chained.remap(7)).toBe(15);
      // Final line 8 → step1 line 9 → original line 17
      expect(chained.remap(8)).toBe(17);
    });
  });
});
