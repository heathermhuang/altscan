import { sql, type SQL } from 'drizzle-orm'

/**
 * "Blocks (24h)" for the validators page, which replaces the uptime column the
 * indexer used to fabricate (a constant 0.99 on every row).
 *
 * The window is the 24 hours BEFORE THE NEWEST BLOCK's timestamp (not before now(), so an indexer that is
 * behind still shows a full day, and not a block count derived from the chain's block time constant, which
 * is only an average). The lower bound is resolved by timestamp, as the first block at or after it through
 * blocks_timestamp_idx (a single index probe), and the one GROUP BY miner query then runs over the
 * primary-key range from that block up, so it stays an index range scan (84 ms on BNB at 192k blocks).
 */
export function validatorBlocksQuery(): SQL {
  return sql`
    WITH first_block AS (
      SELECT number FROM blocks
      WHERE timestamp >= (SELECT timestamp FROM blocks ORDER BY number DESC LIMIT 1) - INTERVAL '24 hours'
      ORDER BY timestamp ASC, number ASC LIMIT 1
    )
    SELECT miner, count(*)::int AS n FROM blocks
    WHERE number >= (SELECT number FROM first_block)
    GROUP BY miner`
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
