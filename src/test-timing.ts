/**
 * Timing for the tests that check that work takes linear time. A test
 * compares the fastest of several runs, as one run alone can take a pause
 * for garbage collection, which in a large test file, or on a slower CI
 * runner, can decide the test by chance.
 */

/** The fastest of `samples` runs of `work`, in milliseconds */
export function fastestRun(work: () => unknown, samples = 3): number {
  let fastest = Infinity;
  for (let k = 0; k < samples; k++) {
    const start = performance.now();
    work();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

/** The fastest of `samples` runs of `work`, which is async, in milliseconds */
export async function fastestRunAsync(work: () => Promise<unknown>, samples = 3): Promise<number> {
  let fastest = Infinity;
  for (let k = 0; k < samples; k++) {
    const start = performance.now();
    await work();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

/**
 * How many times as long `time` takes on sixteen times `size` as on `size`,
 * where `time` gives how long some work takes on an input of a size, as the
 * fastest of a few runs. Work that takes linear time takes about 16 times as
 * long, or less where a fixed cost counts at the smaller size, and work that
 * takes time in the square of the size about 256 times. Tests want under
 * GROWTH_LIMIT, which is four times either way: a busy machine can slow
 * the larger runs some, but not four times over, as it did to tests that
 * timed four times the size and wanted under 8, the geometric middle of 4
 * and 16, or twice the size and wanted under 3. The first call warms up
 */
export function growthOverSixteenfold(time: (size: number) => number, size: number): number {
  time(size);
  const small = time(size);
  return logGrowth(time(16 * size) / small);
}

/** As growthOverSixteenfold, for `time` that is async */
export async function growthOverSixteenfoldAsync(time: (size: number) => Promise<number>, size: number): Promise<number> {
  await time(size);
  const small = await time(size);
  return logGrowth(await time(16 * size) / small);
}

/** The limit on growthOverSixteenfold of work that takes linear time */
export const GROWTH_LIMIT = 64;

function logGrowth(growth: number): number {
  if (process.env.LOG_TIMING_GROWTH) console.error('growth over sixteenfold: ' + growth.toFixed(1));
  return growth;
}
