/**
 * Pure budget/backoff config for the lazy-backfill worker (Track A4b, Task 2.1).
 *
 * ⚠ There is deliberately NO `withinHourlyCap`-style predicate here (R4): a pure
 * `pagesUsed < cap` check can only run after a separate SELECT, and that
 * read-then-check is exactly the race R4 fixes — two instances during a rolling
 * deploy both read 299 and both page. The hourly cap is enforced ONLY by the
 * single reserve-or-deny statement in backfill-worker.ts (`reservePage`).
 */
import { indexerConfig } from './config-instance'

export const cfg = {
  pollMs:           indexerConfig.backfill.pollMs,
  pageSleepMs:      indexerConfig.backfill.pageSleepMs,
  maxRowsPerEntity: indexerConfig.backfill.maxRowsPerEntity,  // doc target 10k; start low
  maxPagesPerHour:  indexerConfig.backfill.maxPagesPerHour,
  budgetHeadroom:   indexerConfig.backfill.budgetHeadroom,    // BNB shared-bucket check
  maxBackoffMs:     30 * 60 * 1000,
  // R2 — a 'running' row untouched for this long is a crashed worker, reclaimable.
  leaseSec:         indexerConfig.backfill.leaseSec,
  // R5 — write-time bounds. Backfill is immortal + retention-exempt, so it MUST stop
  // growing before the disk-emergency path would start sacrificing the live index.
  maxTotalGb:       indexerConfig.backfill.maxTotalGb,
  diskStopPct:      indexerConfig.backfill.diskStopPct,       // < the 85 emergency threshold
}

/** Exponential backoff for errored entities, capped. */
export function backoffMs(attempts: number): number {
  return Math.min(cfg.maxBackoffMs, 1000 * Math.pow(2, Math.max(0, attempts)))
}
