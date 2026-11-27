/**
 * The coalescing writer for addresses.tx_count / last_seen. Block workers call
 * enqueueAddressActivity and never wait; one flush at a time upserts the merged batch.
 * Moved verbatim out of block-processor.ts, which only ever called the enqueue.
 */
import { sql } from 'drizzle-orm'
import { getDb, dbErrorMessage, isDeadlock, SQL_BATCH_CHUNK } from './db'

// ── Async addresses coalescer ───────────────────────────────────────
/**
 * Accumulates address activity (tx_count delta + last_seen) across blocks
 * and flushes in coalesced batches. Previously the upsert ran synchronously
 * per block and was the dominant lock-contention source under 8-worker
 * concurrency — hot rows (WBNB, PancakeSwap router, stablecoins) serialized
 * on row locks, and deadlock retries added 50-150ms stalls to random blocks.
 *
 * Coalescing properties:
 *   - Larger batches → fewer lock acquisition cycles overall
 *   - Single in-flight flush → bounded memory and DB pool pressure
 *   - Deduplicated addresses → one row lock per distinct address per flush
 *   - Fire-and-forget from block loop → block processing never waits on
 *     addresses-table contention
 *
 * The addresses table is metadata (tx_count, last_seen). Eventual consistency
 * across a few seconds is acceptable; firstSeen still populates correctly
 * via the INSERT clause of ON CONFLICT.
 */
type AddressPending = { count: number; ts: Date }
let addressPending = new Map<string, AddressPending>()
let addressFlushInflight: Promise<void> | null = null

export function enqueueAddressActivity(
  txs: Array<{ fromAddress: string; toAddress: string | null }>,
  timestamp: Date,
): void {
  const bump = (addr: string) => {
    const prev = addressPending.get(addr)
    if (prev) {
      prev.count += 1
      if (timestamp > prev.ts) prev.ts = timestamp
    } else {
      addressPending.set(addr, { count: 1, ts: timestamp })
    }
  }
  for (const tx of txs) {
    bump(tx.fromAddress)
    if (tx.toAddress) bump(tx.toAddress)
  }
  kickAddressFlush()
}

function kickAddressFlush(): void {
  if (addressFlushInflight) return
  if (addressPending.size === 0) return
  const snapshot = addressPending
  addressPending = new Map()
  addressFlushInflight = flushAddresses(snapshot)
    .catch(err => console.warn('[addresses] flush failed:', dbErrorMessage(err)))
    .finally(() => {
      addressFlushInflight = null
      if (addressPending.size > 0) kickAddressFlush()
    })
}

async function flushAddresses(pending: Map<string, AddressPending>): Promise<void> {
  const db = getDb()
  // Sort by address → consistent lock order, minimizes deadlocks across flushes.
  const entries = Array.from(pending.entries()).sort((a, b) => a[0].localeCompare(b[0]))

  for (let i = 0; i < entries.length; i += SQL_BATCH_CHUNK) {
    const chunk = entries.slice(i, i + SQL_BATCH_CHUNK)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await db.execute(sql`
          INSERT INTO addresses (address, tx_count, first_seen, last_seen)
          VALUES ${sql.join(
            chunk.map(([addr, d]) =>
              sql`(${addr}, ${d.count}, ${d.ts.toISOString()}::timestamptz, ${d.ts.toISOString()}::timestamptz)`,
            ),
            sql`, `,
          )}
          ON CONFLICT (address) DO UPDATE SET
            tx_count  = addresses.tx_count + EXCLUDED.tx_count,
            last_seen = GREATEST(addresses.last_seen, EXCLUDED.last_seen)
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
