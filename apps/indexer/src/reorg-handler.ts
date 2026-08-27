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

import { indexerConfig } from './config-instance'
import { getDb, schema } from './db'
import { eq, gte, sql } from 'drizzle-orm'
import { readWithFailover, markNotEndpointFault, withTimeout } from './rpc-failover'

/**
 * Bound on the reorg check's DB reads. Must stay comfortably BELOW the outer RPC
 * read timeout (default 45s for a full check) so a hung database rejects — and is
 * tagged — before the outer timer can fire and misattribute it to the endpoint.
 *
 * Validated rather than parsed: `parseInt` yields NaN for a typo and 0 for "0",
 * and either would make the timer fire immediately or never — defeating the whole
 * point. Capped too, because a value above the outer timeout is silently useless.
 * (codex P2, round 5.)
 */
const STORED_HASH_TIMEOUT_MS = (() => {
  const requested = Math.min(indexerConfig.rpc.storedHashTimeoutMs, 30_000)
  // RPC_REORG_TIMEOUT_MS is set independently, so it can legitimately be tuned
  // BELOW this one — at which point the outer timer fires first with an untagged
  // error and the whole point (tagging a DB hang so it is not blamed on, and
  // retried against, every endpoint) is silently lost. Stay strictly under it.
  // (codex P2, round 6.)
  const outer = indexerConfig.rpc.reorgTimeoutMs
  return Math.max(1_000, Math.min(requested, Math.floor(outer / 2)))
})()
import type { EndpointHealth } from './endpoint-health'

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
 * Production ReorgDeps: the chain-aware indexer DB, plus an injected chain view.
 * (getDb from './db' — NOT '@altscan/db' — so ETH resolves ETH_DATABASE_URL.)
 *
 * This deliberately takes a FETCHER, not a JsonRpcProvider. The previous
 * `makeReorgDeps(provider)` bound the reorg check to ONE endpoint with no
 * failover and no timeout, which is how a throttled bsc-dataseed1 stalled the
 * whole poll loop for ~85s per batch — the reorg check gates every batch, so a
 * hang there halts indexing outright. It was removed rather than kept alongside,
 * so the single-provider shape cannot be reintroduced by accident. index.ts
 * passes a failover-and-timeout-wrapped fetcher. Header reads are pure, so
 * retrying one across endpoints is always safe.
 */
export function makeReorgDepsFrom(rpcBlock: ReorgDeps['rpcBlock']): ReorgDeps {
  return {
    async storedHash(n) {
      // Tagged so a Postgres outage is not recorded against the RPC endpoint this
      // check happens to be pinned to. The check still fails over — only the
      // health attribution is suppressed. (codex P2.)
      //
      // The inner timeout is what makes the tag reliable. Tagging can only ever
      // decorate a REJECTION, so a DB that HANGS rather than errors would sail
      // past this and be killed by the outer read timer instead — producing a
      // fresh, untagged timeout that is then charged to the endpoint. A DB outage
      // expressed as hung queries could therefore demote the entire read pool.
      // Failing here first keeps the attribution correct. (codex P2, round 4.)
      try {
        const db = getDb()
        return await withTimeout(
          (async () => {
            const [row] = await db.select({ hash: schema.blocks.hash }).from(schema.blocks)
              .where(eq(schema.blocks.number, n)).limit(1)
            return row?.hash ?? null
          })(),
          STORED_HASH_TIMEOUT_MS,
          `storedHash(${n})`,
        )
      } catch (err) {
        throw markNotEndpointFault(err)
      }
    },
    rpcBlock,
  }
}

/**
 * Run a COMPLETE reorg check against one endpoint, failing over as a unit.
 *
 * The pinning is a correctness requirement, not an optimization. Per-read
 * failover mixes chain views: a current endpoint can flag a mismatch at L+1,
 * then a STALE endpoint can return the orphaned stored hash at L, so
 * findForkPoint() "agrees" at L and the unwind becomes a no-op. A later stale
 * boundary read then passes, and because processBlock() does not validate parent
 * continuity against the stored chain, workers can persist blocks from two
 * different forks. (codex P1.)
 *
 * So: every read in one check — boundary, tip and the whole K-bounded walk —
 * comes from a single provider. If any of them fails or the check exceeds
 * `timeoutMs`, the entire check is abandoned and restarted on the next provider
 * rather than resumed, because a half-walked result is exactly the mixed view we
 * are avoiding.
 */
export async function detectReorgPinned<P>(
  providers: readonly P[],
  startIdx: number,
  depsFor: (provider: P) => ReorgDeps,
  lastIndexed: number,
  maxDepth: number,
  timeoutMs: number,
  onFailover?: (provider: P, err: unknown) => void,
  health?: EndpointHealth<P>,
): Promise<ReorgCheck> {
  return readWithFailover(
    providers,
    startIdx,
    provider => detectReorg(depsFor(provider), lastIndexed, maxDepth),
    timeoutMs,
    onFailover,
    // Reorg checks gate every batch, so they must respect the same demotion the
    // block fetches do — otherwise a sick endpoint keeps taxing the one call
    // that runs before any block work can start.
    health,
  )
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

  // Poison decisions are block-scoped index state too, and above a fork the height
  // refers to a DIFFERENT block — a surviving row would keep excluding that height
  // from the resume gap scan forever, silently suppressing a genuine hole.
  //
  // FIRST, before any other delete, and that ordering is the whole point. Running it
  // last looked equivalent — a throw propagates, the caller has not advanced
  // lastIndexed, so the reorg is re-detected and retried. It is not equivalent: by
  // then the ordinary deletes have already committed, so the stored tip row is GONE,
  // and detectReorg treats a missing stored hash as "nothing to validate" and reports
  // no reorg. The deleted canonical tail would go unreprocessed until a restart.
  // Failing here instead leaves the index untouched, so the next check still sees the
  // mismatch. (codex P1, round 5.)
  //
  // The reverse failure is benign: poison rows dropped while the unwind then fails
  // only means those heights lose an exclusion, and they are still present in
  // `blocks`, which the resume scan skips anyway. The retry re-runs the whole unwind.
  //
  // Deliberately NOT in UNWIND_ORDER: that manifest is guardrail-tested to cover
  // exactly the drizzle schema tables carrying a block number, and poison_blocks is
  // created in ensure-schema.ts rather than declared in the schema.
  await db.execute(sql`DELETE FROM poison_blocks WHERE block_number >= ${fromBlockNumber}`)

  // Rewind any heal_cursor that sits above the fork, for the same reason: it is a
  // height-keyed claim ("everything up to here was re-indexed, drained and verified")
  // about blocks this unwind is deleting.
  //
  // Without it the healer can loop forever making no progress. Its work window starts
  // at heal_cursor + 1, so damage the unwind creates BELOW a high cursor is
  // unreachable: the later window verifies clean, the strict density proof refuses on
  // the block nothing re-indexed, and the range is re-selected on every tick. Rewinding
  // here — where the damage is created — keeps the healer's own selection honest about
  // what a tick can actually reach. (codex P2, follow-up round 2.)
  await db.execute(sql`
    UPDATE index_gaps SET heal_cursor = ${fromBlockNumber} - 1
     WHERE heal_cursor >= ${fromBlockNumber}
  `)

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
