// Array edits over as many items as a document has, of runs, tokens, lines,
// comments, rows and the like. A spread into a call, as push(...items),
// Math.max(...values) or splice(i, n, ...items), passes each item as an
// argument, which Node, the extension's runtime, holds on its stack: past
// about 120,000 it throws RangeError: Maximum call stack size exceeded.
// These take the items one at a time instead.

/** Appends `items` to `target`, as target.push(...items) would */
export function pushAll<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item);
}

/** The largest of `values` and `floor`, as Math.max(floor, ...values) */
export function maxOf(values: Iterable<number>, floor = -Infinity): number {
  let max = floor;
  for (const value of values) max = Math.max(max, value);
  return max;
}

// As many arguments as a call takes in any engine, with room to spare
const ARGUMENTS_AT_ONCE = 4096;

/** Replaces `deleteCount` items of `target` from `start` with `items`, as
 *  target.splice(start, deleteCount, ...items) would, and returns those it
 *  removed. A few items go to splice itself, which moves the items after
 *  them fastest, as callers that replace a few tokens of a document's do
 *  for each of many; more move those items one at a time. */
export function spliceAll<T>(target: T[], start: number, deleteCount: number, items: readonly T[]): T[] {
  if (items.length <= ARGUMENTS_AT_ONCE) return target.splice(start, deleteCount, ...items);
  // Where splice puts them, from the end for a negative start
  const at = start < 0 ? Math.max(target.length + start, 0) : Math.min(start, target.length);
  const removed = target.splice(at, deleteCount);
  // The items after them move toward the end by as many as there are new
  // ones, from the last, into room the new ones make there
  const length = target.length;
  for (const item of items) target.push(item);
  for (let k = length - 1; k >= at; k--) target[k + items.length] = target[k];
  for (let k = 0; k < items.length; k++) target[at + k] = items[k];
  return removed;
}
