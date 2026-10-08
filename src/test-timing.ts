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
