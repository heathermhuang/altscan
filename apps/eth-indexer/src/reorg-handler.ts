/**
 * Reorg handler for Ethereum indexer.
 *
 * Same strategy as the BNB handler: batch-boundary parent hash validation.
 * Before processing a batch starting at `nextBlock`, fetch its header from RPC,
 * compare parentHash to what we stored for nextBlock-1, and unwind if different.
 *
 * Uses raw SQL (drizzle sql template) to match the eth-indexer's db style.
 */

import { JsonRpcProvider } from 'ethers'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'

type Db = ReturnType<typeof drizzle>

/** Maximum blocks to walk back when searching for the fork point. */
const MAX_REORG_DEPTH = 64

/**
 * Check if the block at `nextBlockNumber` represents a reorg.
 * Fetches the block header from RPC to read parentHash.
 *
 * Returns `{ isReorg: false }` when chain is canonical or DB has no prior block.
 * Returns `{ isReorg: true, forkPoint }` on mismatch — caller should unwind
 * everything above forkPoint and reset `lastIndexed = forkPoint`.
 */
export async function checkReorgAtBoundary(
  nextBlockNumber: number,
  provider: JsonRpcProvider,
  db: Db,
): Promise<{ isReorg: false } | { isReorg: true; forkPoint: number }> {
  if (nextBlockNumber <= 1) return { isReorg: false }

  // Fetch stored hash for the block just before our next target
  const result = await db.execute(sql`
    SELECT hash FROM blocks WHERE number = ${nextBlockNumber - 1} LIMIT 1
  `)
  const rows = Array.from(result)
  const dbParentHash = (rows[0] as Record<string, unknown>)?.hash as string | undefined

  if (!dbParentHash) {
    // No prior block in DB — nothing to validate against
    return { isReorg: false }
  }

  // Fetch block header from RPC (false = no prefetch txs)
  const rpcBlock = await provider.getBlock(nextBlockNumber, false)
  if (!rpcBlock) return { isReorg: false }

  if (rpcBlock.parentHash === dbParentHash) {
    return { isReorg: false }
  }

  console.warn(
    `[reorg-handler] Reorg detected at block ${nextBlockNumber}!` +
    ` DB has parent ${dbParentHash.slice(0, 10)}… but RPC says ${rpcBlock.parentHash.slice(0, 10)}…`,
  )

  const forkPoint = await findForkPoint(nextBlockNumber - 1, provider, db)
  console.warn(`[reorg-handler] Fork point: block ${forkPoint}`)
  return { isReorg: true, forkPoint }
}

/**
 * Walk back from `startFrom` to find the last block where RPC hash === DB hash.
 */
async function findForkPoint(startFrom: number, provider: JsonRpcProvider, db: Db): Promise<number> {
  for (let n = startFrom; n >= Math.max(0, startFrom - MAX_REORG_DEPTH); n--) {
    const result = await db.execute(sql`SELECT hash FROM blocks WHERE number = ${n} LIMIT 1`)
    const rows = Array.from(result)
    const dbHash = (rows[0] as Record<string, unknown>)?.hash as string | undefined

    if (!dbHash) continue

    const rpcBlock = await provider.getBlock(n, false)
    if (!rpcBlock?.hash) continue

    if (rpcBlock.hash === dbHash) {
      return n
    }
  }

  const safePoint = Math.max(0, startFrom - MAX_REORG_DEPTH)
  console.error(`[reorg-handler] Could not find fork point within ${MAX_REORG_DEPTH} blocks — falling back to ${safePoint}`)
  return safePoint
}

/**
 * Delete all data for blocks >= `fromBlockNumber`.
 *
 * Deletion order: logs, token_transfers, dex_trades, gas_history → transactions → blocks
 * (respects the FK on transactions.block_number → blocks.number)
 */
export async function unwindFrom(fromBlockNumber: number, db: Db): Promise<void> {
  // Check if there's anything to unwind
  const check = await db.execute(sql`
    SELECT COUNT(*)::int as cnt FROM blocks WHERE number >= ${fromBlockNumber}
  `)
  const cnt = (Array.from(check)[0] as Record<string, unknown>)?.cnt as number
  if (!cnt || cnt === 0) {
    console.log(`[reorg-handler] Nothing to unwind from block ${fromBlockNumber}`)
    return
  }

  console.log(`[reorg-handler] Unwinding ${cnt} orphaned block(s) from ${fromBlockNumber}+`)

  await db.execute(sql`DELETE FROM logs            WHERE block_number >= ${fromBlockNumber}`)
  await db.execute(sql`DELETE FROM token_transfers WHERE block_number >= ${fromBlockNumber}`)
  await db.execute(sql`DELETE FROM dex_trades      WHERE block_number >= ${fromBlockNumber}`)
  await db.execute(sql`DELETE FROM gas_history     WHERE block_number >= ${fromBlockNumber}`)
  await db.execute(sql`DELETE FROM transactions    WHERE block_number >= ${fromBlockNumber}`)
  await db.execute(sql`DELETE FROM blocks          WHERE number       >= ${fromBlockNumber}`)

  console.log(`[reorg-handler] Unwind complete from block ${fromBlockNumber}`)
}
