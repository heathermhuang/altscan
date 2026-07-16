/**
 * Reorg tail-check + rollback (Track A3).
 *
 * Detection (both via detectReorg, bounded by per-chain K = chainConfig.reorgDepth):
 *  - BOUNDARY mode: before processing a batch starting at lastIndexed+1, compare that
 *    block's RPC parentHash to our stored hash of lastIndexed.
 *  - TIP mode: when the RPC doesn't have lastIndexed+1 yet (we're at the tip), compare
 *    the RPC hash of lastIndexed itself — catches an in-place tail replacement while idle.
 * On mismatch, walk back ≤ K blocks to the last stored-hash == RPC-hash agreement (the
 * fork point). Per spec invariant 4 only the last K blocks are mutable, so the walk and
 * the rollback are hard-bounded at K even if no agreement is found (loud error — that
 * means K is too small for the chain, or the RPC is serving a different canonical chain).
 *
 * Rollback deletes every block-scoped index row above the fork point (UNWIND_ORDER,
 * children before parents; guardrail-tested against the schema so a future block-scoped
 * table can't be forgotten). The poll loop then reindexes from the fork point naturally.
 * addresses.tx_count is deliberately NOT decremented (reindex re-increments; small,
 * reorg-scoped inflation accepted). The async tt-writer is rolled back FIRST via
 * rollbackTransferWriterTo(fork): quiesce the in-flight drain, purge queued decodes
 * above the fork, and rewind + persist the durable watermark W — min(blocks-cursor, W)
 * resume alone only covers a crash BEFORE reprocessing, not mid-reprocess (codex
 * P1+P2 on PR #67; full rationale on rollbackTransferWriterTo).
 */

import { getDb, schema } from './db'
import { eq, gte } from 'drizzle-orm'
import type { JsonRpcProvider } from 'ethers'

/** Injectable chain views so detection logic is unit-testable without DB/RPC. */
export type ReorgDeps = {
  /** Our stored hash for block n (null = not in local index). */
  storedHash(n: number): Promise<string | null>
  /** Canonical chain view for block n (null = RPC doesn't have it). */
  rpcBlock(n: number): Promise<{ hash: string; parentHash: string } | null>
}

export type ReorgCheck = { isReorg: false } | { isReorg: true; forkPoint: number }

/** REORG_DEPTH env override (>0) wins over the chain default. */
export function resolveReorgDepth(chainDefault: number, env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.REORG_DEPTH ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : chainDefault
}

/**
 * Detect a reorg relative to `lastIndexed` (our highest indexed block).
 * Boundary mode when the RPC has lastIndexed+1, tip mode otherwise.
 * One header call on the canonical path; the K-bounded walk only runs on mismatch.
 */
export async function detectReorg(deps: ReorgDeps, lastIndexed: number, maxDepth: number): Promise<ReorgCheck> {
  if (lastIndexed <= 1) return { isReorg: false }
  const stored = await deps.storedHash(lastIndexed)
  if (!stored) return { isReorg: false }              // gap / fresh DB — nothing to validate

  const next = await deps.rpcBlock(lastIndexed + 1)
  if (next) {
    if (next.parentHash === stored) return { isReorg: false }
  } else {
    const tip = await deps.rpcBlock(lastIndexed)
    if (!tip || tip.hash === stored) return { isReorg: false }
  }

  console.warn(`[reorg-handler] reorg suspected at block ${lastIndexed} (${next ? 'boundary' : 'tip'} mode) — walking back ≤ ${maxDepth} blocks for the fork point`)
  const forkPoint = await findForkPoint(deps, lastIndexed, maxDepth)
  console.warn(`[reorg-handler] fork point: block ${forkPoint}`)
  return { isReorg: true, forkPoint }
}

/**
 * Walk back from `startFrom` to the last block where stored hash === RPC hash.
 * Missing local rows are skipped (can't agree or disagree). Hard-bounded at
 * startFrom - maxDepth per spec invariant 4 (only the last K blocks are mutable).
 */
async function findForkPoint(deps: ReorgDeps, startFrom: number, maxDepth: number): Promise<number> {
  const floor = Math.max(0, startFrom - maxDepth)
  for (let n = startFrom; n >= floor; n--) {
    const stored = await deps.storedHash(n)
    if (!stored) continue
    const rpc = await deps.rpcBlock(n)
    if (!rpc?.hash) continue
    if (rpc.hash === stored) return n
  }
  console.error(`[reorg-handler] no stored/RPC agreement within K=${maxDepth} of block ${startFrom} — bounding rollback at ${floor}. If this recurs, K is too small for this chain (or the RPC is on a different canonical chain).`)
  return floor
}

/**
 * Production ReorgDeps backed by the chain-aware indexer DB + an ethers provider.
 * (getDb from './db' — NOT '@altscan/db' — so ETH resolves ETH_DATABASE_URL.)
 */
export function makeReorgDeps(provider: JsonRpcProvider): ReorgDeps {
  return {
    async storedHash(n) {
      const db = getDb()
      const [row] = await db.select({ hash: schema.blocks.hash }).from(schema.blocks)
        .where(eq(schema.blocks.number, n)).limit(1)
      return row?.hash ?? null
    },
    async rpcBlock(n) {
      const b = await provider.getBlock(n, false)   // header only
      return b ? { hash: b.hash ?? '', parentHash: b.parentHash } : null
    },
  }
}

/**
 * Ordered unwind manifest — children before parents; blocks last (FK:
 * transactions.block_number → blocks.number). Guardrail-tested against the schema:
 * every table with a block-number column must appear here exactly once.
 */
export const UNWIND_ORDER = [
  'logs', 'tokenTransfers', 'dexTrades', 'gasHistory', 'transactions', 'blocks',
] as const

/** Delete every block-scoped index row for blocks >= fromBlockNumber, in UNWIND_ORDER. */
export async function unwindFrom(fromBlockNumber: number): Promise<void> {
  const db = getDb()
  console.warn(`[reorg-handler] unwinding all index rows for blocks >= ${fromBlockNumber}`)
  for (const t of UNWIND_ORDER) {
    switch (t) {
      case 'logs':           await db.delete(schema.logs).where(gte(schema.logs.blockNumber, fromBlockNumber)); break
      case 'tokenTransfers': await db.delete(schema.tokenTransfers).where(gte(schema.tokenTransfers.blockNumber, fromBlockNumber)); break
      case 'dexTrades':      await db.delete(schema.dexTrades).where(gte(schema.dexTrades.blockNumber, fromBlockNumber)); break
      case 'gasHistory':     await db.delete(schema.gasHistory).where(gte(schema.gasHistory.blockNumber, fromBlockNumber)); break
      case 'transactions':   await db.delete(schema.transactions).where(gte(schema.transactions.blockNumber, fromBlockNumber)); break
      case 'blocks':         await db.delete(schema.blocks).where(gte(schema.blocks.number, fromBlockNumber)); break
    }
  }
  console.warn(`[reorg-handler] unwind complete from block ${fromBlockNumber}`)
}
