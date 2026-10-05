/**
 * "Blocks (24h)" for the validators page, which replaces the uptime column the
 * indexer used to fabricate (a constant 0.99 on every row).
 *
 * The window is a primary-key range — the newest 24h worth of block numbers at the
 * chain's block time — rather than a timestamp range, so the one GROUP BY miner
 * query stays an index range scan (84 ms on BNB at 192k blocks).
 */

/** How many of the newest blocks make up 24h. */
export function blocksIn24h(blockTime: number): number {
  return Math.round(86_400 / blockTime)
}

/** One row of the miner GROUP BY. */
export type MinerCount = { miner: string; n: number | string }

/** Blocks per miner, keyed by lowercase address. */
export function minerCounts(rows: readonly MinerCount[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const key = r.miner.toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + Number(r.n))
  }
  return counts
}

/**
 * Blocks one validator produced in the window. 0 is a real answer (it produced none),
 * so it is distinct from null, which means the query failed and the count is unknown.
 */
export function blocksProduced(counts: ReadonlyMap<string, number> | null, address: string): number | null {
  if (counts === null) return null
  return counts.get(address.toLowerCase()) ?? 0
}
