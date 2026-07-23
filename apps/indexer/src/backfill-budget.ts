/**
 * Pure budget/backoff config for the lazy-backfill worker (Track A4b, Task 2.1).
 *
 * ⚠ There is deliberately NO `withinHourlyCap`-style predicate here (R4): a pure
 * `pagesUsed < cap` check can only run after a separate SELECT, and that
 * read-then-check is exactly the race R4 fixes — two instances during a rolling
 * deploy both read 299 and both page. The hourly cap is enforced ONLY by the
 * single reserve-or-deny statement in backfill-worker.ts (`reservePage`).
 */
const int = (v: string | undefined, d: number) => {
  const n = parseInt(v ?? '', 10); return Number.isFinite(n) && n > 0 ? n : d
}
const float = (v: string | undefined, d: number) => {
  const n = parseFloat(v ?? ''); return Number.isFinite(n) && n > 0 && n <= 1 ? n : d
}

export const cfg = {
  pollMs:          int(process.env.BACKFILL_POLL_MS, 15_000),
  pageSleepMs:     int(process.env.BACKFILL_PAGE_SLEEP_MS, 2_000),
  maxRowsPerEntity: int(process.env.BACKFILL_MAX_ROWS_PER_ENTITY, 3_000),  // doc target 10k; start low
  maxPagesPerHour: int(process.env.BACKFILL_MAX_PAGES_PER_HOUR, 300),
  budgetHeadroom:  float(process.env.BACKFILL_BUDGET_HEADROOM, 0.4),        // BNB shared-bucket check
  maxBackoffMs:    30 * 60 * 1000,
  // R2 — a 'running' row untouched for this long is a crashed worker, reclaimable.
  leaseSec:        int(process.env.BACKFILL_LEASE_SEC, 300),
  // R5 — write-time bounds. Backfill is immortal + retention-exempt, so it MUST stop
  // growing before the disk-emergency path would start sacrificing the live index.
  maxTotalGb:      int(process.env.BACKFILL_MAX_TOTAL_GB, 5),
  diskStopPct:     int(process.env.BACKFILL_DISK_STOP_PCT, 70),   // < the 85 emergency threshold
}

/** Exponential backoff for errored entities, capped. */
export function backoffMs(attempts: number): number {
  return Math.min(cfg.maxBackoffMs, 1000 * Math.pow(2, Math.max(0, attempts)))
}
