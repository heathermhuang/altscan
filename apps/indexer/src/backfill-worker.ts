/**
 * Lazy provider-backfill worker (Track A4b, Phase A4b-2).
 *
 * A DB-polled loop that drains `backfill_watermarks` one provider page at a
 * time, writing immortal history rows the explorer's cached-tail serve path
 * (apps/explorer/lib/backfill-serve.ts) reads. Crash-safety model (R2): every
 * page commits its rows AND its watermark advance in ONE transaction, and a
 * claimed row's lease (`last_attempt_at`) makes crashed claims reclaimable.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '@altscan/db'
import { cfg } from './backfill-budget'

/** A `backfill_watermarks` row as RETURNING * hands it back (snake_case; BIGINT
 *  columns arrive as strings from postgres-js). */
export type ClaimedEntity = {
  id: number
  entity_type: 'address_txs' | 'token_transfers'
  entity_id: string
  status: string
  backfilled_through_block: string | number | null
  oldest_cursor: string | null
  rows_written: number
  attempts: number
  last_attempt_at: Date | null
  last_error: string | null
}

/**
 * The single-flight claim (Task 2.2). Exported as a pure string builder so the
 * CI suite pins the exact predicates byte-for-byte (same pattern as
 * retention-cleanup's `sizeReportSql`). `cfg.leaseSec` is an env-parsed
 * positive integer, safe to inline.
 *
 * - R2: a 'running' row untouched for a full lease is a crashed worker —
 *   reclaimable. Claiming sets last_attempt_at = now(), which renews the lease.
 * - R6: drain in-flight 'partial' work before starting new 'pending' work,
 *   whose NULL last_attempt_at would otherwise sort first and preempt
 *   everything. A reclaimed 'running' row keeps its stale clock, so it sorts
 *   ahead of recently-touched rows but behind fresh 'pending' NULLs — R6
 *   deliberately lifts only 'partial'.
 * - Errored rows re-enter after an exponential cooldown capped at 1800s,
 *   mirroring backoffMs().
 */
export function buildClaimSql(): string {
  return `
    UPDATE backfill_watermarks SET status = 'running', last_attempt_at = now(), updated_at = now()
    WHERE id = (
      SELECT id FROM backfill_watermarks
      WHERE status IN ('pending','partial')
         OR (status = 'running' AND last_attempt_at < now() - (${cfg.leaseSec} * INTERVAL '1 second'))
         OR (status = 'error' AND (last_attempt_at IS NULL OR last_attempt_at < now() - (LEAST(pow(2, attempts), 1800) * INTERVAL '1 second')))
      ORDER BY (status = 'partial') DESC, last_attempt_at ASC NULLS FIRST, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`
}

export async function claimNextEntity(db: Db): Promise<ClaimedEntity | null> {
  const res = await db.execute(sql.raw(buildClaimSql()))
  return (Array.from(res)[0] as ClaimedEntity | undefined) ?? null
}
