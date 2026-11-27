/**
 * Per-block token_balances tracking: one worker draining a queue of balance UPSERTs.
 *
 * Hard-disabled: indexerConfig.holderBalanceTrackingEnabled is a constant false (config.ts;
 * AGENTS.md "Known issues"), so enqueueHolderBalanceUpdate returns at once. It lives in its
 * own module so retiring it, or reviving it, is a change to one file. Both writers call it:
 * the inline path in block-processor.ts and the async writer in transfer-writer.ts.
 */
import { sql } from 'drizzle-orm'
import { indexerConfig } from './config-instance'
import { getDb, dbErrorMessage, isDeadlock, SQL_BATCH_CHUNK } from './db'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** The fields of a token transfer that move a balance. A TokenTransferRow is one. */
type BalanceMove = {
  tokenAddress: string
  fromAddress: string
  toAddress: string
  value: string
  tokenType: 'BEP20' | 'BEP721' | 'BEP1155'
}

// ── Batched holder balance update ───────────────────────────────────
/**
 * Aggregate per-(token, holder) deltas across all transfers in the block,
 * then apply a single batched upsert to token_balances.
 *
 * Previously this also maintained tokens.holder_count inline via a
 * two-phase CTE (old_state → upsert → aggregate). Under production load
 * on ETH (1000+ deltas per block) that CTE became the dominant bottleneck,
 * scaling negatively with concurrency because of row-lock contention and
 * deadlocks. holder_count is now recomputed periodically by the retention
 * job instead — see recomputeHolderCounts().
 */
// ── Holder balance async queue ──────────────────────────────────────
// Single-worker drainer for balance UPSERTs. Blocks previously awaited
// this inline, which was the dominant per-block cost (~38% / ~2.5s).
// Serializing through one worker removes cross-worker row-lock contention.
const HOLDER_QUEUE_WARN_DEPTH = indexerConfig.holders.queueWarnDepth
const SKIP_HOLDER_BALANCES = !indexerConfig.holderBalanceTrackingEnabled
// The flag itself moved to config.ts. retention-cleanup.ts reads it, and it was
// importing this 1,833-line module — and running its module side effects,
// including the console.warn below — to get one boolean.
console.warn('[holder-queue] HARDCODED SKIP — token_balances writes DISABLED to save DB from write storm')
const holderQueue: BalanceMove[][] = []
let holderWorkerRunning = false
let holderQueueLogCounter = 0

export function enqueueHolderBalanceUpdate(rows: BalanceMove[]): void {
  if (SKIP_HOLDER_BALANCES) return
  holderQueue.push(rows)
  if (++holderQueueLogCounter >= 100) {
    holderQueueLogCounter = 0
    if (holderQueue.length >= HOLDER_QUEUE_WARN_DEPTH) {
      console.warn(`[holder-queue] depth=${holderQueue.length} batches (warn threshold ${HOLDER_QUEUE_WARN_DEPTH})`)
    } else {
      console.log(`[holder-queue] depth=${holderQueue.length} batches`)
    }
  }
  runHolderWorker()
}

function runHolderWorker(): void {
  if (holderWorkerRunning) return
  holderWorkerRunning = true
  // Fire-and-forget; errors logged per-drain, loop continues.
  // Each drain coalesces the ENTIRE current queue into one merged UPSERT:
  // delta aggregation is commutative, so N batches of deltas can be summed
  // per (token, holder) and applied as a single SQL round-trip. This
  // amortizes per-statement overhead — a queue of 500 batches drains in
  // roughly the same time as 1, bounded only by the merged row count.
  ;(async () => {
    try {
      while (holderQueue.length > 0) {
        const drained = holderQueue.splice(0, holderQueue.length)
        const merged: BalanceMove[] = []
        for (const batch of drained) {
          for (const r of batch) merged.push(r)
        }
        try {
          await batchUpdateHolderBalances(merged)
        } catch (err) {
          console.warn(`[holder-queue] merged batch of ${drained.length} failed:`, dbErrorMessage(err))
        }
      }
    } finally {
      holderWorkerRunning = false
    }
  })()
}

async function batchUpdateHolderBalances(rows: BalanceMove[]): Promise<void> {
  const db = getDb()

  // Aggregate net deltas: (token, holder) → bigint
  const deltas = new Map<string, bigint>()
  const key = (token: string, holder: string) => `${token}|${holder}`

  for (const r of rows) {
    // Skip NFT holder tracking — BEP721/1155 balances aren't aggregated the same way
    if (r.tokenType !== 'BEP20') continue

    const v = BigInt(r.value)
    if (r.toAddress !== ZERO_ADDRESS) {
      const k = key(r.tokenAddress, r.toAddress)
      deltas.set(k, (deltas.get(k) ?? 0n) + v)
    }
    if (r.fromAddress !== ZERO_ADDRESS) {
      const k = key(r.tokenAddress, r.fromAddress)
      deltas.set(k, (deltas.get(k) ?? 0n) - v)
    }
  }

  if (deltas.size === 0) return

  // Sort by (token, holder) so row locks are acquired in a consistent order,
  // reducing (but not eliminating) deadlocks under concurrent block processors.
  const entries = Array.from(deltas.entries())
    .map(([k, delta]) => {
      const [token, holder] = k.split('|')
      return { token, holder, delta }
    })
    .sort((a, b) => (a.token + a.holder).localeCompare(b.token + b.holder))

  // Simple upsert, with deadlock retry. No CTE, no holder_count tracking.
  // Chunked to avoid V8 call stack overflow in Drizzle's sql.join() recursion.
  for (let i = 0; i < entries.length; i += SQL_BATCH_CHUNK) {
    const chunk = entries.slice(i, i + SQL_BATCH_CHUNK)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await db.execute(sql`
          INSERT INTO token_balances (token_address, holder_address, balance)
          VALUES ${sql.join(
            chunk.map(e => sql`(${e.token}::varchar(42), ${e.holder}::varchar(42), ${e.delta.toString()}::numeric)`),
            sql`, `
          )}
          ON CONFLICT (token_address, holder_address) DO UPDATE
            SET balance = token_balances.balance + EXCLUDED.balance
        `)
        break
      } catch (err) {
        if (isDeadlock(err) && attempt < 3) {
          await new Promise(r => setTimeout(r, 50 * attempt))
          continue
        }
        throw err
      }
    }
  }
}
