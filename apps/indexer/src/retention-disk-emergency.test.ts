import { describe, expect, it } from 'vitest'
import { emergencyRetentionDecision } from './retention-cleanup'

/**
 * BNB disk is a SAWTOOTH and the peak is created BY the run: the
 * transactions.input UPDATE inflates the table (MVCC dead tuples), then a
 * token_transfers partition DROP returns ~12GB to the OS in one step.
 *
 * Measured on prod 2026-08-21 across one cycle: 77.1% at start -> 86.2% mid-run
 * after the UPDATE -> ~77% after the DROP. Against an 85% threshold, ONLY the
 * middle sample crosses. Sampling just the two ends reads 77/77 and stays silent,
 * which is exactly how this switch was quiet while the volume was over the line.
 */
const base = {
  alarmPct: 85,
  actPct: 93,
  isOverride: false,
  compactDays: 2,
  bodyDays: 1,
  minDays: 1,
}

describe('emergencyRetentionDecision (disk dead-man switch)', () => {
  it('does NOT delete retained history at this database\'s NORMAL peak', () => {
    // THE REGRESSION THIS SPLIT EXISTS FOR. Measured 2026-08-21: the healthy
    // sawtooth peak is ~86% (high phase + in-flight body prune). A single 85%
    // trigger fired a compact re-run at the floor on every normal cycle, silently
    // destroying the compact/body_pruned rows Track A1 tx pages serve — and
    // deleted history does not come back when the policy relaxes.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [79.5, 86.2, 77.1], compactDays: 2, bodyDays: 1 })
    expect(d.fire).toBe(false)
    expect(d).toMatchObject({ reason: 'alarm-only' })
    // ...but it is NOT silent: the operator still gets told, with the live lever.
    expect(d).toMatchObject({ remainingLever: 'compact' })
  })

  it('DOES act once the peak reaches the action line', () => {
    const d = emergencyRetentionDecision({ ...base, samplesPct: [93.1], compactDays: 2, bodyDays: 1 })
    expect(d).toMatchObject({ fire: true, kind: 'compact', days: 1 })
  })

  it('never lets the action line sit below the alarm line', () => {
    // A misconfigured actPct under alarmPct would make alarm-only unreachable and
    // restore the exact hair-trigger this split removes.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [86], alarmPct: 85, actPct: 85 })
    expect(d.fire).toBe(true)   // collapsed thresholds == old behaviour, by choice
    const split = emergencyRetentionDecision({ ...base, samplesPct: [86], alarmPct: 85, actPct: 93 })
    expect(split.fire).toBe(false)
  })

  it('FIRES on the mid-run peak that both end samples miss', () => {
    // The exact 2026-08-21 shape.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [77.1, 96.2, 77.1] })
    expect(d.fire).toBe(true)
    expect(d.peakPct).toBeCloseTo(96.2)
    if (d.fire) expect(d.kind).toBe('compact')
  })

  it('stays silent on the same cycle WITHOUT the mid-run sample — the regression this fixes', () => {
    const d = emergencyRetentionDecision({ ...base, samplesPct: [77.1, 77.1] })
    expect(d.fire).toBe(false)
    expect(d).toMatchObject({ reason: 'below-threshold' })
  })

  it('still fires when only the FINAL sample is high (peak sampling must not lose cases)', () => {
    const d = emergencyRetentionDecision({ ...base, samplesPct: [70, 72, 98] })
    expect(d.fire).toBe(true)
    expect(d.peakPct).toBeCloseTo(98)
  })

  it('fires exactly AT the threshold, not just above', () => {
    expect(emergencyRetentionDecision({ ...base, samplesPct: [93] }).fire).toBe(true)
    expect(emergencyRetentionDecision({ ...base, samplesPct: [92.9] }).fire).toBe(false)
  })

  it('NEVER fires on the emergency re-run itself — no unbounded recursion', () => {
    const d = emergencyRetentionDecision({ ...base, samplesPct: [99, 99], isOverride: true })
    expect(d).toMatchObject({ fire: false, reason: 'is-override' })
  })

  it('does NOT cry wolf when a re-run peaked high but ENDED below the line', () => {
    // A rerun that starts at 90%, drops a partition and ends at 70% SUCCEEDED.
    // Judging it on peakPct would report failure on exactly the path that worked.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [90, 70], isOverride: true })
    expect(d).toMatchObject({ fire: false, reason: 'below-threshold' })
  })

  it('advises the lever the system would ACTUALLY use next when both are available', () => {
    // remainingLeverFor must mirror the firing preference (compact before body).
    // If they diverge, the operator is told to tighten RETENTION_DAYS while the
    // next automatic run would tighten COMPACT_RETENTION_DAYS instead.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [91], isOverride: true, compactDays: 2, bodyDays: 3 })
    expect(d).toMatchObject({ reason: 'is-override', remainingLever: 'compact' })
    // ...and that IS the kind a non-override run at those settings fires.
    const fired = emergencyRetentionDecision({ ...base, samplesPct: [95], compactDays: 2, bodyDays: 3 })
    expect(fired).toMatchObject({ fire: true, kind: 'compact' })
  })

  it('names the lever that is actually left, so advice is never "grow the disk" prematurely', () => {
    // compact rerun still high, but the BODY window is untouched at 3d.
    expect(emergencyRetentionDecision({ ...base, samplesPct: [91], isOverride: true, compactDays: 1, bodyDays: 3 }))
      .toMatchObject({ reason: 'is-override', remainingLever: 'body' })
    // body rerun still high, compact immortal -> setting compact is the remedy.
    expect(emergencyRetentionDecision({ ...base, samplesPct: [91], isOverride: true, compactDays: Infinity, bodyDays: 1 }))
      .toMatchObject({ reason: 'is-override', remainingLever: 'set-compact' })
    // genuinely exhausted -> and only here is "grow the disk" the honest answer.
    expect(emergencyRetentionDecision({ ...base, samplesPct: [91], isOverride: true, compactDays: 1, bodyDays: 1 }))
      .toMatchObject({ reason: 'is-override', remainingLever: 'none' })
  })

  it('still DIAGNOSES an emergency re-run that finishes above the line', () => {
    // The override guard exists to stop recursion, not to stop reporting. A rerun
    // that ends still-high is the worst state the system can be in and must not
    // classify as anything quieter than is-override (which the caller logs at
    // error level). Previously it fell through to silence.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [91], isOverride: true, compactDays: Infinity, bodyDays: 1 })
    expect(d).toMatchObject({ fire: false, reason: 'is-override' })
    expect(d.peakPct).toBeCloseTo(91)
  })

  it('an override run BELOW the line is just below-threshold, not is-override', () => {
    // is-override must mean "above the line but must not recurse", so it stays a
    // meaningful alarm rather than the catch-all for every emergency rerun.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [40], isOverride: true })
    expect(d).toMatchObject({ fire: false, reason: 'below-threshold' })
  })

  it('does not let a FAILED final size report masquerade as a cleared re-run', () => {
    // reportSizes() returns 0 from its catch. Admitting that as the final usable
    // sample would read as "0% full, pressure cleared" on the one path where we
    // most need the alarm.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [90, 0], isOverride: true })
    expect(d).toMatchObject({ fire: false, reason: 'is-override' })
    expect(d.peakPct).toBeCloseTo(90)
  })

  it('drops FAILED probes rather than letting null drag the peak down', () => {
    // A lost probe must not read as 0% and mask a real peak in the other samples.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [null, 96, null] })
    expect(d.fire).toBe(true)
    expect(d.peakPct).toBeCloseTo(96)
  })

  it('treats an all-failed run as UNKNOWN and refuses to act destructively', () => {
    const d = emergencyRetentionDecision({ ...base, samplesPct: [null, null] })
    expect(d).toMatchObject({ fire: false, reason: 'unknown-disk' })
  })

  it('tightens COMPACT first when compact retention is above the floor', () => {
    const d = emergencyRetentionDecision({ ...base, samplesPct: [95], compactDays: 2, bodyDays: 3 })
    expect(d).toMatchObject({ fire: true, kind: 'compact', days: 1 })
  })

  it('falls back to the BODY window once compact is already at the floor', () => {
    const d = emergencyRetentionDecision({ ...base, samplesPct: [95], compactDays: 1, bodyDays: 3 })
    expect(d).toMatchObject({ fire: true, kind: 'body', days: 1 })
  })

  it('tightens the body window when compact retention is infinite (immortal)', () => {
    const d = emergencyRetentionDecision({ ...base, samplesPct: [95], compactDays: Infinity, bodyDays: 7 })
    expect(d).toMatchObject({ fire: true, kind: 'body', days: 1 })
  })

  it('reports compact-immortal SEPARATELY from at-floor — the remedies differ', () => {
    // Body at the floor + immortal compact is NOT "nothing left to tighten":
    // setting COMPACT_RETENTION_DAYS is still a lever. Reporting this as at-floor
    // would tell the operator to buy disk when a config change would do.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [95], compactDays: Infinity, bodyDays: 1 })
    expect(d).toMatchObject({ fire: false, reason: 'compact-immortal' })
  })

  it('reports at-floor when both windows are genuinely floored — only disk helps', () => {
    // This is BNB today: RETENTION_DAYS=1 == EMERGENCY_RETENTION_MIN_DAYS.
    const d = emergencyRetentionDecision({ ...base, samplesPct: [95], compactDays: 1, bodyDays: 1 })
    expect(d).toMatchObject({ fire: false, reason: 'at-floor' })
    expect(d.peakPct).toBeCloseTo(95)
  })

  it('treats an unknown disk size (0%) as no signal, never as an emergency', () => {
    // DB_DISK_GB unset makes diskPctNow return 0 — "unknown", not "0% full".
    expect(emergencyRetentionDecision({ ...base, samplesPct: [0, 0] }))
      .toMatchObject({ fire: false, reason: 'unknown-disk' })
  })

  it('holds "0 means unknown" even when the threshold itself is 0', () => {
    // Only here is that guard load-bearing: a bare `peak < threshold` test would
    // let an UNKNOWN disk satisfy `0 >= 0` and fire a destructive re-run on a
    // database whose size we cannot see. Unknown must fail CLOSED.
    expect(emergencyRetentionDecision({ ...base, samplesPct: [0], alarmPct: 0, actPct: 0 }).fire).toBe(false)
    // ...while a real, known reading at the same threshold still fires.
    expect(emergencyRetentionDecision({ ...base, samplesPct: [0.1], alarmPct: 0, actPct: 0 }).fire).toBe(true)
  })

  it('ignores NaN/Infinity samples instead of poisoning the max', () => {
    const d = emergencyRetentionDecision({ ...base, samplesPct: [NaN, Infinity, 96] })
    expect(d.fire).toBe(true)
    expect(d.peakPct).toBeCloseTo(96)
  })
})
