import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';
import { type CommentRange, type ContentItem, globallyOverlappingComments, hasOverlappingComments, overlappingCommentRanges } from './converter';
import { fastestRun } from './test-timing';

// Import writes a comment in ID syntax where its range overlaps another's,
// in a paragraph or anywhere in the document (see hasOverlappingComments
// and globallyOverlappingComments in converter.ts). Both compared each pair
// of comments, which took time in the square of their number. They sweep
// the ranges by their starts now, which these check gives the same as each
// pair's comparison did.

/** The ids of the ranges that overlap another, by each pair, as import
 *  compared them */
function overlappingByPairs(ranges: readonly CommentRange[]): Set<string> {
  const overlapping = new Set<string>();
  for (let a = 0; a < ranges.length; a++) {
    for (let b = a + 1; b < ranges.length; b++) {
      if (ranges[a].start < ranges[b].end && ranges[b].start < ranges[a].end) {
        overlapping.add(ranges[a].id);
        overlapping.add(ranges[b].id);
      }
    }
  }
  return overlapping;
}

/** Whether an item is a run that can carry comments */
const isRun = (item: ContentItem) => item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref'
  || item.type === 'math' || item.type === 'html_comment' || item.type === 'image';

/** Whether a paragraph's comments overlap, as import found by each pair */
function segmentOverlapsByPairs(segment: ContentItem[]): boolean {
  const allIds = new Set<string>();
  for (const item of segment) if (isRun(item) && 'commentIds' in item && item.commentIds) for (const id of item.commentIds) allIds.add(id);
  if (allIds.size <= 1) return false;
  for (const item of segment) if (isRun(item) && 'commentIds' in item && item.commentIds && item.commentIds.size > 1) return true;
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  let pos = 0;
  let prevIds = new Set<string>();
  for (const item of segment) {
    if (!isRun(item) || !('commentIds' in item) || !item.commentIds) { pos++; continue; }
    const ids = item.commentIds;
    for (const id of ids) if (!prevIds.has(id)) starts.set(id, Math.min(starts.get(id) ?? pos, pos));
    for (const id of prevIds) if (!ids.has(id)) ends.set(id, Math.max(ends.get(id) ?? pos, pos));
    prevIds = ids;
    pos++;
  }
  for (const id of prevIds) if (!ends.has(id)) ends.set(id, pos);
  return overlappingByPairs([...allIds].map(id => ({ id, start: starts.get(id) ?? 0, end: ends.get(id) ?? 0 }))).size > 0;
}

/** The comments that overlap anywhere in `items`, as import found by each
 *  pair */
function globalOverlapsByPairs(items: ContentItem[]): Set<string> {
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  let pos = 0;
  let prevIds = new Set<string>();
  const scan = (list: ContentItem[]) => {
    for (const item of list) {
      if (isRun(item) && 'commentIds' in item && item.commentIds) {
        const ids = item.commentIds;
        for (const id of ids) if (!prevIds.has(id)) starts.set(id, Math.min(starts.get(id) ?? pos, pos));
        for (const id of prevIds) if (!ids.has(id)) ends.set(id, Math.max(ends.get(id) ?? pos, pos));
        prevIds = ids;
        pos++;
      } else if (item.type === 'table') {
        for (const row of item.rows) for (const cell of row.cells) for (const para of cell.paragraphs) scan(para);
      }
    }
  };
  scan(items);
  for (const id of prevIds) if (!ends.has(id)) ends.set(id, pos);
  return overlappingByPairs([...starts.keys()].map(id => ({ id, start: starts.get(id) ?? 0, end: ends.get(id) ?? 0 })));
}

/** A run of text with the comments `ids` on it */
const run = (ids: string[]): ContentItem => ({ type: 'text', text: 'x', commentIds: new Set(ids), formatting: {} as never });

// Runs with up to three of five comments, so that ranges tie, nest, are
// the same, or stop and start again, and paragraphs and tables between
const idsArb = fc.subarray(['a', 'b', 'c', 'd', 'e'], { maxLength: 3 });
const itemArb = (depth: number): fc.Arbitrary<ContentItem> => fc.oneof(
  { weight: 6, arbitrary: idsArb.map(run) },
  { weight: 1, arbitrary: fc.constant<ContentItem>({ type: 'para' }) },
  { weight: 1, arbitrary: idsArb.map((ids): ContentItem => ({ type: 'html_comment', text: '<!-- c -->', commentIds: new Set(ids) })) },
  ...(depth > 1 ? [{ weight: 1, arbitrary: fc.array(fc.array(itemArb(depth - 1), { maxLength: 4 }), { minLength: 1, maxLength: 2 })
    .map((paragraphs): ContentItem => ({ type: 'table', rows: [{ isHeader: false, cells: [{ paragraphs }] }] })) }] : []),
);

describe('Comments whose ranges overlap', () => {
  it('are those each pair\'s comparison finds, with ranges that tie, nest, are the same or empty, or end before they start', () => {
    const rangeArb = fc.record({ start: fc.integer({ min: 0, max: 8 }), end: fc.integer({ min: 0, max: 8 }) });
    fc.assert(fc.property(fc.array(rangeArb, { maxLength: 10 }), spans => {
      const ranges = spans.map((span, k) => ({ id: 'c' + k, ...span }));
      expect([...overlappingCommentRanges(ranges)].sort()).toEqual([...overlappingByPairs(ranges)].sort());
    }), { numRuns: 20000 });
  });

  it('in a paragraph are found as each pair\'s comparison found them', () => {
    fc.assert(fc.property(fc.array(itemArb(1), { maxLength: 12 }), segment => {
      expect(hasOverlappingComments(segment)).toBe(segmentOverlapsByPairs(segment));
    }), { numRuns: 20000 });
  });

  it('anywhere, and in tables\' cells, are found as each pair\'s comparison found them', () => {
    fc.assert(fc.property(fc.array(itemArb(2), { maxLength: 12 }), items => {
      expect([...globallyOverlappingComments(items)].sort()).toEqual([...globalOverlapsByPairs(items)].sort());
    }), { numRuns: 20000 });
  });

  // `n` runs, each with a comment of its own, of which no two overlap, so
  // the search for a pair that does reads them all
  const runs = (n: number) => Array.from({ length: n }, (_, k) => run(['c' + k]));
  // Four times as many take about four times as long, not sixteen
  const growth = (work: (items: ContentItem[]) => unknown) => {
    const time = (items: ContentItem[]) => fastestRun(() => {
      for (let k = 0; k < 5; k++) work(items);
    });
    const small = runs(4000);
    const large = runs(16000);
    time(small);
    return time(large) / time(small);
  };

  it('in a paragraph of many comments are found in time n log n', () => {
    expect(hasOverlappingComments(runs(3))).toBe(false);
    expect(growth(hasOverlappingComments)).toBeLessThan(8);
  }, 30000);

  it('in a document of many comments are found in time n log n', () => {
    expect(globallyOverlappingComments(runs(3)).size).toBe(0);
    expect(growth(globallyOverlappingComments)).toBeLessThan(8);
  }, 30000);
});
