import { describe, it, expect, afterEach, vi } from 'vitest'
import { backoffMs, cfg } from './backfill-budget'

describe('backfill budget', () => {
  it('error backoff grows with attempts and is bounded', () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(3))
    expect(backoffMs(20)).toBeLessThanOrEqual(cfg.maxBackoffMs)
  })

  it('reads conservative defaults', () => {
    expect(cfg.maxRowsPerEntity).toBe(3000)
    expect(cfg.budgetHeadroom).toBe(0.4)
    expect(cfg.pageSleepMs).toBe(2000)
    expect(cfg.maxPagesPerHour).toBe(300)
  })

  it('reads the R2 lease and R5 ceiling defaults', () => {
    expect(cfg.leaseSec).toBe(300)
    expect(cfg.maxTotalGb).toBe(5)
    expect(cfg.diskStopPct).toBe(70)
  })
})

describe('backfill budget — env parsing edges', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function freshCfg() {
    vi.resetModules()
    return (await import('./backfill-budget')).cfg
  }

  it('garbage and non-positive env values fall back to defaults', async () => {
    vi.stubEnv('BACKFILL_MAX_PAGES_PER_HOUR', 'lots')
    vi.stubEnv('BACKFILL_LEASE_SEC', '-5')
    vi.stubEnv('BACKFILL_MAX_TOTAL_GB', '0')
    const c = await freshCfg()
    expect(c.maxPagesPerHour).toBe(300)
    expect(c.leaseSec).toBe(300)
    expect(c.maxTotalGb).toBe(5)
  })

  it('rejects a headroom fraction outside (0, 1]', async () => {
    vi.stubEnv('BACKFILL_BUDGET_HEADROOM', '1.5')
    expect((await freshCfg()).budgetHeadroom).toBe(0.4)
    vi.stubEnv('BACKFILL_BUDGET_HEADROOM', '0.6')
    expect((await freshCfg()).budgetHeadroom).toBe(0.6)
  })

  // The BACKFILL_ENABLED gate now lives in @altscan/chain-config's
  // isBackfillEnabled (read by both the explorer serve gate and the worker),
  // tested there — the worker config no longer carries an enabledEnvOff field.
})
