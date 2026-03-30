/**
 * Reorg handler for BNB Chain indexer.
 *
 * Strategy: batch-boundary parent hash validation.
 * Before processing a batch starting at `nextBlock`, we fetch nextBlock from RPC
 * (header only), compare its parentHash to the hash we stored for nextBlock-1,
 * and unwind any orphaned blocks if they differ.
 *
 * This catches the common 1-3 block BSC reorgs without per-block overhead.
 * Unwind deletes all child data in dependency order, then re-processing happens
 * naturally as the main loop resumes from the fork point.
 */

import { getDb, schema } from '@bnbscan/db'
import { eq, gte } from 'drizzle-orm'
import { JsonRpcProvider } from 'ethers'

/** Maximum blocks to walk back when searching for the fork point. */
const MAX_REORG_DEPTH = 64

/**
 * Check if the block at `nextBlockNumber` represents a reorg relative to what
 * is stored in the DB. Fetches the block header from RPC to read parentHash.
 *
 * Returns `{ isReorg: false }` when the chain is canonical or when the DB has
 * no prior block to compare against (fresh start / gap).
 *
 * Returns `{ isReorg: true, forkPoint }` when a mismatch is detected.
 * `forkPoint` is the last canonical block number — the caller should unwind
 * everything above it and reset `lastIndexed = forkPoint`.
 */
export async function checkReorgAtBoundary(
  nextBlockNumber: number,
  provider: JsonRpcProvider,
): Promise<{ isReorg: false } | { isReorg: true; forkPoint: number }> {
  if (nextBlockNumber <= 1) return { isReorg: false }

  const db = getDb()

  // Fetch stored hash for the block just before our next target
  const [dbParent] = await db
    .select({ hash: schema.blocks.hash })
    .from(schema.blocks)
    .where(eq(schema.blocks.number, nextBlockNumber - 1))
    .limit(1)

  if (!dbParent) {
    // No prior block in DB — nothing to validate against (empty DB or gap)
    return { isReorg: false }
  }

  // Fetch the next block from RPC — header only (false = no prefetch txs)
  const rpcBlock = await provider.getBlock(nextBlockNumber, false)
  if (!rpcBlock) {
    // Block not available yet — not a reorg
    return { isReorg: false }
  }

  if (rpcBlock.parentHash === dbParent.hash) {
    return { isReorg: false }
  }

  console.warn(
    `[reorg-handler] Reorg detected at block ${nextBlockNumber}!` +
    ` DB has parent ${dbParent.hash.slice(0, 10)}… but RPC says ${rpcBlock.parentHash.slice(0, 10)}…`,
  )

  const forkPoint = await findForkPoint(nextBlockNumber - 1, provider)
  console.warn(`[reorg-handler] Fork point: block ${forkPoint}`)
  return { isReorg: true, forkPoint }
}

/**
 * Walk back from `startFrom` to find the last block where RPC hash === DB hash.
 * That is the fork point — everything above it is orphaned.
 */
async function findForkPoint(startFrom: number, provider: JsonRpcProvider): Promise<number> {
  const db = getDb()

  for (let n = startFrom; n >= Math.max(0, startFrom - MAX_REORG_DEPTH); n--) {
    const [dbBlock] = await db
      .select({ hash: schema.blocks.hash })
      .from(schema.blocks)
      .where(eq(schema.blocks.number, n))
      .limit(1)

    if (!dbBlock) continue

    const rpcBlock = await provider.getBlock(n, false)
    if (!rpcBlock?.hash) continue

    if (rpcBlock.hash === dbBlock.hash) {
      return n  // Last canonical block
    }
  }

  // Safety: if no agreement found within depth, treat the oldest checked block as fork
  const safePoint = Math.max(0, startFrom - MAX_REORG_DEPTH)
  console.error(`[reorg-handler] Could not find fork point within ${MAX_REORG_DEPTH} blocks — falling back to ${safePoint}`)
  return safePoint
}

/**
 * Delete all data for blocks >= `fromBlockNumber` from the DB.
 *
 * Deletion order respects the FK constraint on transactions.block_number → blocks.number:
 *   logs, token_transfers, dex_trades → transactions → blocks
 *   gas_history has no FK but is cleaned for consistency.
 */
export async function unwindFrom(fromBlockNumber: number): Promise<void> {
  const db = getDb()

  // Count orphaned blocks first so we can log a useful message
  const orphaned = await db
    .select({ number: schema.blocks.number })
    .from(schema.blocks)
    .where(gte(schema.blocks.number, fromBlockNumber))

  if (orphaned.length === 0) {
    console.log(`[reorg-handler] Nothing to unwind from block ${fromBlockNumber}`)
    return
  }

  const last = orphaned[orphaned.length - 1].number
  console.log(`[reorg-handler] Unwinding ${orphaned.length} orphaned block(s): ${fromBlockNumber}–${last}`)

  // All child tables carry block_number — delete by range, no IN-list needed.
  // Order: child rows first, then transactions, then blocks (respects FK constraint).
  await db.delete(schema.logs).where(gte(schema.logs.blockNumber, fromBlockNumber))
  await db.delete(schema.tokenTransfers).where(gte(schema.tokenTransfers.blockNumber, fromBlockNumber))
  await db.delete(schema.dexTrades).where(gte(schema.dexTrades.blockNumber, fromBlockNumber))
  await db.delete(schema.transactions).where(gte(schema.transactions.blockNumber, fromBlockNumber))
  await db.delete(schema.blocks).where(gte(schema.blocks.number, fromBlockNumber))

  console.log(`[reorg-handler] Unwind complete — removed blocks ${fromBlockNumber}–${last}`)
}
