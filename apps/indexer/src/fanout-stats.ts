/**
 * Counts for the post-write metadata fan-out (audit lead B14), summarised in one line every FANOUT_SUMMARY_MS.
 *
 * After a block's writes begin, processBlock reads metadata for every token it has not seen (4 calls each) and
 * resolves every DEX pair it does not know (3 to 4 calls each), all at once, with no limit per block. A deployer
 * chooses how many new tokens and pairs a block holds, so both need a budget, and the plan sizes each one "above the
 * measured peak": this is that measurement. It changes nothing about what is fetched or written.
 *
 * Per block (with receipts): new tokens fetched, unknown pairs resolved, and swaps dropped because their pair could not
 * be read (a failed read is not cached, and the swap's dex_trades row is skipped, silently until now). The summary
 * gives the max and p99 per block, so a cold pair cache after a deploy shows up as a peak and not only as a total.
 */
export const FANOUT_SUMMARY_MS = 10 * 60 * 1000
/** Flush early past this many blocks, so a long catch-up cannot grow the sample without bound. */
export const FANOUT_MAX_SAMPLES = 20_000

export type FanoutSample = { tokens: number; pairs: number; pairDrops: number }

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}

export function summariseFanout(samples: readonly FanoutSample[], elapsedMs: number): string {
  const col = (k: keyof FanoutSample) => {
    const v = samples.map((s) => s[k]).sort((a, b) => a - b)
    return { max: v.length ? v[v.length - 1] : 0, p99: quantile(v, 0.99), total: v.reduce((a, b) => a + b, 0) }
  }
  const t = col('tokens')
  const p = col('pairs')
  const d = col('pairDrops')
  return `[fanout] ${Math.round(elapsedMs / 1000)}s: ${samples.length} blocks`
    + ` | new tokens per block max ${t.max} p99 ${t.p99} total ${t.total}`
    + ` | unknown pairs per block max ${p.max} p99 ${p.p99} total ${p.total}`
    + ` | swaps dropped (pair unreadable) max ${d.max} total ${d.total}`
}

export function createFanoutStats(now: () => number = Date.now, log: (line: string) => void = console.log) {
  let samples: FanoutSample[] = []
  let since = now()
  return {
    record(sample: FanoutSample): void {
      samples.push(sample)
      const elapsed = now() - since
      if (elapsed >= FANOUT_SUMMARY_MS || samples.length >= FANOUT_MAX_SAMPLES) {
        log(summariseFanout(samples, elapsed))
        samples = []
        since = now()
      }
    },
  }
}
