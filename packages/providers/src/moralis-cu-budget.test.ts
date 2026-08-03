/**
 * Regression tests for the 2026-08-01 Moralis CU incident.
 *
 * The account hit 100% of a MONTHLY Compute Unit allowance while every control
 * in this package reported green, because the controls counted CALLS in hourly
 * and daily windows and the bill counted CUs in a monthly one. A4b backfill
 * never exceeded its 300-pages/hour reserve; it just ran at that reserve for
 * five days. These tests pin the three defects that made that possible.
 *
 * Each test re-imports the module because CU_COST and BUCKET_CAPS are read from
 * env at module load, and because the in-memory counters are module state that
 * would otherwise leak between cases.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const CFG = { kind: 'moralis' as const, moralisChain: '0x38' }

/** Stub env BEFORE calling this — module-level consts snapshot process.env. */
async function freshModule() {
  vi.resetModules()
  return await import('./moralis')
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const emptyHistory = () => okJson({ result: [], cursor: null })

/**
 * Always build a FRESH Response per call. `mockResolvedValue(new Response(...))`
 * hands back one instance whose body can only be read once, so the second call
 * fails with upstream_error and masks whatever the budget actually did.
 */
const fetchReturning = (make: () => Response) => vi.fn().mockImplementation(async () => make())

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('monthlyCuMax — fail-closed config', () => {
  it('falls back to the default ceiling for every unusable value, and never to unlimited', async () => {
    const { monthlyCuMax } = await freshModule()
    const fallback = monthlyCuMax({})
    expect(Number.isFinite(fallback)).toBe(true)
    expect(fallback).toBeGreaterThan(0)

    // The whole point: none of these may mean "no ceiling". `''` in particular
    // is the shape that made CREATIVES_KEY_PREFIX fail open twice.
    for (const bad of [undefined, '', '   ', '0', '-1', '-999', 'abc', 'Infinity', 'null', 'true']) {
      expect(monthlyCuMax({ MORALIS_MONTHLY_CU_MAX: bad }), `input: ${JSON.stringify(bad)}`)
        .toBe(fallback)
    }
  })

  it('honors an explicit positive ceiling so the real plan allowance can be applied without a deploy', async () => {
    const { monthlyCuMax } = await freshModule()
    expect(monthlyCuMax({ MORALIS_MONTHLY_CU_MAX: '25000000' })).toBe(25_000_000)
    expect(monthlyCuMax({ MORALIS_MONTHLY_CU_MAX: ' 900 ' })).toBe(900)
  })

  it('rejects the parseInt-prefix class that the first version of this fix let through', async () => {
    const { monthlyCuMax } = await freshModule()
    const fallback = monthlyCuMax({})
    // Codex round 1 on this PR: parseInt() takes a NUMERIC PREFIX and has no
    // upper bound, so the original "fail-closed" implementation still had
    // inputs that disabled the ceiling entirely, and one that caused an outage.
    const disablesTheCeiling = '999999999999999999999999999999garbage' // → ~1e30
    const causesAnOutage = '1_000' // → 1
    for (const bad of [
      disablesTheCeiling,
      causesAnOutage,
      '1e9',
      '0x10',
      '+5',
      '12garbage',
      '9007199254740993', // beyond Number.MAX_SAFE_INTEGER
      '1.5',
      '١٢٣', // non-ASCII digits
    ]) {
      expect(monthlyCuMax({ MORALIS_MONTHLY_CU_MAX: bad }), `input: ${bad}`).toBe(fallback)
    }
  })
})

describe('strictPositiveInt', () => {
  it('accepts only a complete, safe, positive decimal integer', async () => {
    const { strictPositiveInt } = await freshModule()
    expect(strictPositiveInt('42', 7, 1000)).toBe(42)
    expect(strictPositiveInt(' 42 ', 7, 1000)).toBe(42)
    for (const bad of ['', '  ', '0', '-1', '1.5', '1e3', '0x2a', '+42', '42x', 'x42', undefined]) {
      expect(strictPositiveInt(bad, 7, 1000), `input: ${bad}`).toBe(7)
    }
  })

  it('falls back rather than honouring a value above the cap', async () => {
    const { strictPositiveInt } = await freshModule()
    expect(strictPositiveInt('1001', 7, 1000)).toBe(7)
    expect(strictPositiveInt('1000', 7, 1000)).toBe(1000)
  })
})

describe('monthKey — calendar-month stamping', () => {
  it('uses UTC and rolls over exactly at the month boundary', async () => {
    const { monthKey } = await freshModule()
    expect(monthKey(new Date('2026-08-01T00:00:00Z'))).toBe('2026-08')
    expect(monthKey(new Date('2026-07-31T23:59:59Z'))).toBe('2026-07')
    expect(monthKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12')
    expect(monthKey(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01')
  })
})

describe('CU cost table', () => {
  it('declares a positive integer cost for every endpoint — a zero would make the meter inert', async () => {
    const { CU_COST } = await freshModule()
    const entries = Object.entries(CU_COST)
    expect(entries.length).toBeGreaterThan(0)
    for (const [name, cost] of entries) {
      expect(Number.isInteger(cost), name).toBe(true)
      expect(cost, name).toBeGreaterThan(0)
    }
  })
})

describe('CU cost overrides are validated, not merely parsed', () => {
  it('ignores a negative cost, which would otherwise run the meter BACKWARDS', async () => {
    // envInt's `parseInt(...) || fallback` accepted -25, and the debit is an
    // INCRBY: every history call would then DECREMENT monthly usage, so the
    // ceiling could never be reached no matter how much was spent. The old
    // test only asserted the DEFAULTS were positive, never the overrides —
    // it would have passed with this bug present.
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '-25')
    const { CU_COST } = await freshModule()
    expect(CU_COST.addressHistory).toBe(25)
  })

  it('ignores zero, non-numeric, and absurdly large costs', async () => {
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '0')
    vi.stubEnv('MORALIS_CU_TOKEN_HOLDERS', 'free')
    vi.stubEnv('MORALIS_CU_ADDRESS_NFTS', '99999999')
    const { CU_COST } = await freshModule()
    expect(CU_COST.addressHistory).toBe(25)
    expect(CU_COST.tokenHolders).toBe(50)
    expect(CU_COST.addressNfts).toBe(25)
  })

  it('honours a plausible override', async () => {
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '40')
    const { CU_COST } = await freshModule()
    expect(CU_COST.addressHistory).toBe(40)
  })
})

describe('monthly CU ceiling — the control that did not exist', () => {
  it('stops provider calls once the ceiling is reached, and the blocked call never reaches Moralis', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '60')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    const { createMoralisAdapter } = await freshModule()
    const fetchMock = fetchReturning(emptyHistory)
    vi.stubGlobal('fetch', fetchMock)

    const a = createMoralisAdapter(CFG)
    expect((await a.getAddressHistory('0xcu-a')).ok).toBe(true)   // 25
    expect((await a.getAddressHistory('0xcu-b')).ok).toBe(true)   // 50
    expect(await a.getAddressHistory('0xcu-c')).toEqual({ ok: false, reason: 'rate_limited' })

    // Spend is prevented, not merely reported: the third call made no request.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a denied call debits nothing, so a cheaper call that still fits is allowed', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '60')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '50')
    vi.stubEnv('MORALIS_CU_ADDRESS_NFTS', '10')
    const { createMoralisAdapter } = await freshModule()
    vi.stubGlobal('fetch', fetchReturning(() => okJson({ result: [], cursor: null })))

    const a = createMoralisAdapter(CFG)
    expect((await a.getAddressHistory('0xrefund-a')).ok).toBe(true)          // used 50
    expect(await a.getAddressHistory('0xrefund-b'))                          // 50+50 > 60 → denied
      .toEqual({ ok: false, reason: 'rate_limited' })

    // If the denial had left its 50 CU on the tally, used would be 100 and this
    // would fail. 50 + 10 == 60 is exactly at the ceiling and must be allowed.
    expect((await a.getAddressNfts('0xrefund-c')).ok).toBe(true)
  })

  it('charges each endpoint its own cost rather than a flat per-call rate', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '50')
    vi.stubEnv('MORALIS_CU_TOKEN_HOLDERS', '50')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    const { createMoralisAdapter, getMoralisHealthState } = await freshModule()
    vi.stubGlobal('fetch', fetchReturning(
      () => okJson({ total_supply: '1', result: [{ owner_address: '0xdead', balance: '1' }] }),
    ))

    const a = createMoralisAdapter(CFG)
    expect((await a.getTokenHolders('0xtok-1')).ok).toBe(true)
    const health = await getMoralisHealthState()
    // One holders call consumed the whole 50-CU ceiling; a 25-CU history call
    // would have consumed half. Cost is per endpoint, not per call.
    expect((health.monthlyCu as Record<string, unknown>).used).toBe(50)
    expect((health.monthlyCu as Record<string, unknown>).limited).toBe(true)
  })
})

describe('health readout without Redis — the EthScan blind spot', () => {
  it('reports in-memory counters instead of null, so `limited` is actually reachable', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.stubEnv('MORALIS_HISTORY_HOURLY_MAX', '1')
    const { createMoralisAdapter, getMoralisHealthState } = await freshModule()
    vi.stubGlobal('fetch', fetchReturning(emptyHistory))

    const before = await getMoralisHealthState()
    expect(before.source).toBe('memory')
    const h0 = (before.buckets as Record<string, Record<string, unknown>>).history
    // Before the fix this was null, and buildBucketState computes `limited` as
    // `hourly !== null && hourly >= max`, so EthScan reported "not limited"
    // regardless of spend. A number here is the whole point.
    expect(h0.hourly).toBe(0)
    expect(h0.limited).toBe(false)

    await createMoralisAdapter(CFG).getAddressHistory('0xblind-1')

    const after = await getMoralisHealthState()
    const h1 = (after.buckets as Record<string, Record<string, unknown>>).history
    expect(h1.hourly).toBe(1)
    expect(h1.limited).toBe(true)
    expect(after.limited).toBe(true)
  })

  it('labels every reading as memory when there is no Redis', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    const { getMoralisHealthState } = await freshModule()
    const h = await getMoralisHealthState()
    const buckets = h.buckets as Record<string, Record<string, unknown>>
    for (const name of ['history', 'holders', 'assets']) {
      expect(buckets[name].source, name).toBe('memory')
    }
    expect((h.monthlyCu as Record<string, unknown>).source).toBe('memory')
    expect(h.source).toBe('memory')
  })

  it('never labels a reading redis when it came from memory (partial Redis failure)', async () => {
    // Finding 6, precisely: bucket GETs succeed but the monthly GET throws. The
    // old code fell back to memCu.used — usually 0 — while the response still
    // said source:'redis'. A ledger sitting at its ceiling could therefore be
    // reported as used:0, limited:false, source:'redis': the exact reading an
    // operator would trust to conclude nothing was wrong.
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.resetModules()
    vi.doMock('@altscan/explorer-core', async (orig) => {
      const actual = (await orig()) as Record<string, unknown>
      return {
        ...actual,
        isRedisUnavailable: () => false,
        getRedis: () => ({
          get: async (k: string) => {
            if (k.startsWith('moralis:cu:')) throw new Error('monthly read failed')
            return '5'
          },
        }),
      }
    })
    const { getMoralisHealthState } = await import('./moralis')
    const h = await getMoralisHealthState()
    const buckets = h.buckets as Record<string, Record<string, unknown>>

    expect(buckets.history.source).toBe('redis')
    expect(buckets.history.hourly).toBe(5)
    // The reading that FAILED must say so, and the rollup must not claim redis.
    expect((h.monthlyCu as Record<string, unknown>).source).toBe('memory')
    expect(h.source).toBe('mixed')
    vi.doUnmock('@altscan/explorer-core')
  })

  it('exposes a monthly CU ledger so the number that maps to the invoice is visible', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '1000')
    const { getMoralisHealthState, monthKey } = await freshModule()
    const health = await getMoralisHealthState()
    expect(health.monthlyCu).toMatchObject({
      month: monthKey(),
      used: 0,
      max: 1000,
      limited: false,
      estimated: true,
    })
  })
})
