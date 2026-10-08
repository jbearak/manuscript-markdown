import { describe, expect, it } from 'bun:test';
import * as fc from 'fast-check';
import { spliceAll } from './arrays';

describe('spliceAll', () => {
  it('edits an array as splice does, with few items or more than a call takes at once', () => {
    const items = fc.oneof(fc.array(fc.integer(), { maxLength: 10 }), fc.integer({ min: 4097, max: 6000 }).map(n => Array.from({ length: n }, (_, k) => -k)));
    fc.assert(fc.property(fc.array(fc.integer(), { maxLength: 30 }), fc.integer({ min: -40, max: 40 }), fc.nat(40), items, (array, start, deleteCount, added) => {
      const expected = [...array];
      const expectedRemoved = expected.splice(start, deleteCount, ...added);
      const actual = [...array];
      expect(spliceAll(actual, start, deleteCount, added)).toEqual(expectedRemoved);
      expect(actual).toEqual(expected);
    }), { numRuns: 500 });
  });
});
