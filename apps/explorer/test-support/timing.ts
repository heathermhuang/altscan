/**
 * The fastest of `runs` timings of `fn`, in milliseconds. For tests that bound how long a call
 * takes (the quadratic-regex regressions on /search): one wall-clock sample measures the
 * scheduler as much as the code, and single samples failed at 28 ms and 187 ms in loaded
 * full-suite runs. The minimum is what the code costs.
 */
export async function bestOfMs(fn: () => unknown, runs = 5): Promise<number> {
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    await fn()
    best = Math.min(best, performance.now() - t)
  }
  return best
}
