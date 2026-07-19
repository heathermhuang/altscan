import { describe, it, expect } from 'vitest'
import { buildClaimSql } from './backfill-worker'
import { cfg } from './backfill-budget'

/**
 * String-level pins for the claim statement (Task 2.2). These are the
 * CI-runnable half: they pin the exact predicates and ordering the design
 * requires (R2 lease, R6 fairness), byte-for-byte from the shipped builder —
 * not a reimplementation. The behavioral half (one winner under concurrency,
 * lease reclaim against a real clock) runs in backfill-worker.pg.test.ts,
 * gated on a local Postgres.
 */
describe('buildClaimSql — the shipped claim statement', () => {
  const text = buildClaimSql()

  it('is single-flight: FOR UPDATE SKIP LOCKED on a LIMIT 1 subquery', () => {
    expect(text).toContain('FOR UPDATE SKIP LOCKED')
    expect(text).toContain('LIMIT 1')
    expect(text).toContain('SELECT id FROM backfill_watermarks')
  })

  it('claims pending and partial work', () => {
    expect(text).toContain(`status IN ('pending','partial')`)
  })

  it('R2: reclaims a running row only after a full lease has elapsed', () => {
    expect(text).toContain(
      `(status = 'running' AND last_attempt_at < now() - (${cfg.leaseSec} * INTERVAL '1 second'))`,
    )
  })

  it('errored rows wait out an exponential cooldown capped at 1800s', () => {
    expect(text).toContain(
      `(status = 'error' AND (last_attempt_at IS NULL OR last_attempt_at < now() - (LEAST(pow(2, attempts), 1800) * INTERVAL '1 second')))`,
    )
  })

  it('R6: drains partial work before pending, whose NULL last_attempt_at would otherwise preempt', () => {
    expect(text).toContain(
      `ORDER BY (status = 'partial') DESC, last_attempt_at ASC NULLS FIRST, created_at ASC`,
    )
  })

  it('claiming renews the lease and returns the full row', () => {
    expect(text).toMatch(
      /UPDATE backfill_watermarks SET status = 'running', last_attempt_at = now\(\), updated_at = now\(\)/,
    )
    expect(text).toContain('RETURNING *')
  })
})
