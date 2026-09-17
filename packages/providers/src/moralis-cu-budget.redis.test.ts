/**
 * Redis-backed budget tests — the path that actually runs on BNBScan.
 *
 * Codex round 1 on this PR found that every other test in this package
 * exercises only isRateLimitedMemory(): with no REDIS_URL the adapter falls
 * back to the in-process ledger, so the entire Redis implementation — the
 * admission script, TTL arming, month rollover, concurrency — could be deleted
 * and the suite would stay green. This file closes that hole by running the
 * REAL Lua against a REAL Redis. A JS re-implementation of the script would
 * only have tested the re-implementation.
 *
 * GATED, like the PG suites: set MORALIS_TEST_REDIS_URL to run. Locally:
 *   redis-server --port 6399 --save '' --appendonly no --daemonize yes
 *   MORALIS_TEST_REDIS_URL=redis://127.0.0.1:6399 npx vitest run <this file>
 *
 * ⚠ This file deletes ONLY the keys it owns, by prefix. An earlier revision
 * called FLUSHALL while its header claimed "a dedicated DB index" — FLUSHALL
 * ignores database boundaries entirely, so even a URL ending in /15 would have
 * wiped databases 0-14. A mis-set MORALIS_TEST_REDIS_URL pointing at a real
 * instance would have destroyed the response cache, the rate ledgers and the
 * queues. Never reintroduce a FLUSH of any kind here.
 */
import Redis from 'ioredis'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const URL_ = process.env.MORALIS_TEST_REDIS_URL
const d = URL_ ? describe : describe.skip

const CFG = { kind: 'moralis' as const, moralisChain: '0x38' }
const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const fetchOk = () =>
  vi.fn().mockImplementation(async () => okJson({ result: [], cursor: null }))

d('Moralis budget — real Redis', () => {
  let client: Redis

  /** Namespaces this suite writes. Deleted by prefix — never flushed. */
  const OWNED_PREFIXES = ['moralis:cu:v1:', 'moralis:rl:v7:', 'moralis:v2:']
  const clearOwnedKeys = async (c: Redis) => {
    for (const prefix of OWNED_PREFIXES) {
      const keys = await c.keys(`${prefix}*`)
      if (keys.length) await c.del(...keys)
    }
  }

  beforeEach(async () => {
    client = new Redis(URL_!)
    await clearOwnedKeys(client)
    vi.resetModules()
    vi.stubEnv('REDIS_URL', URL_!)
    vi.stubEnv('MORALIS_API_KEY', 'k')
    // The shared client is created with lazyConnect + enableOfflineQueue:false,
    // so the FIRST command throws "Stream isn't writeable" until the socket is
    // up. In production that just means the first call or two fall back to the
    // in-memory ledger, which is the intended best-effort behaviour. A test
    // cannot tolerate it: without this the adapter would silently exercise the
    // memory path and every assertion below would be measuring nothing — the
    // exact false-confidence this file exists to remove.
    const core = await import('@altscan/explorer-core')
    await core.getRedis()!.connect()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await client.quit()
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  /** Import fresh so module-level env reads (CU_COST) see the stubs. */
  const load = async () => await import('./moralis')

  it('debits the monthly ledger in Redis, not in process memory', async () => {
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    const { createMoralisAdapter, monthKey } = await load()
    vi.stubGlobal('fetch', fetchOk())

    await createMoralisAdapter(CFG).getAddressHistory('0xr-1')

    const raw = await client.get(`moralis:cu:v1:${monthKey()}`)
    expect(raw).toBe('25')
  })

  it('arms a TTL on every key it creates, so a ledger cannot outlive its window', async () => {
    const { createMoralisAdapter, monthKey } = await load()
    vi.stubGlobal('fetch', fetchOk())
    await createMoralisAdapter(CFG).getAddressHistory('0xr-ttl')

    for (const key of [
      `moralis:cu:v1:${monthKey()}`,
      'moralis:rl:v7:history:hourly',
      'moralis:rl:v7:history:daily',
    ]) {
      expect(await client.pttl(key), key).toBeGreaterThan(0)
    }
  })

  it('stops calls at the monthly ceiling and the blocked call never reaches Moralis', async () => {
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '60')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    const { createMoralisAdapter } = await load()
    const f = fetchOk()
    vi.stubGlobal('fetch', f)

    const a = createMoralisAdapter(CFG)
    expect((await a.getAddressHistory('0xr-a')).ok).toBe(true)
    expect((await a.getAddressHistory('0xr-b')).ok).toBe(true)
    expect(await a.getAddressHistory('0xr-c')).toEqual({ ok: false, reason: 'rate_limited' })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('a denied call commits NOTHING — the ledger is untouched, not incremented-then-refunded', async () => {
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '60')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '50')
    const { createMoralisAdapter, monthKey } = await load()
    vi.stubGlobal('fetch', fetchOk())
    const cuK = `moralis:cu:v1:${monthKey()}`

    const a = createMoralisAdapter(CFG)
    await a.getAddressHistory('0xr-x') // 50, admitted
    expect(await client.get(cuK)).toBe('50')

    await a.getAddressHistory('0xr-y') // 100 > 60, denied
    // The old INCRBY-then-DECRBY shape passed this only if every refund ran.
    // Here there is no intermediate state at all.
    expect(await client.get(cuK)).toBe('50')

    // The hourly counter must not have advanced for a call that never happened.
    expect(await client.get('moralis:rl:v7:history:hourly')).toBe('1')
  })

  it('an hourly denial does not consume monthly budget', async () => {
    vi.stubEnv('MORALIS_HISTORY_HOURLY_MAX', '1')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    const { createMoralisAdapter, monthKey } = await load()
    vi.stubGlobal('fetch', fetchOk())
    const cuK = `moralis:cu:v1:${monthKey()}`

    const a = createMoralisAdapter(CFG)
    await a.getAddressHistory('0xr-h1')
    expect(await client.get(cuK)).toBe('25')

    expect(await a.getAddressHistory('0xr-h2')).toEqual({ ok: false, reason: 'rate_limited' })
    expect(await client.get(cuK)).toBe('25') // not 50, and not refunded-back-to-25
  })

  it('self-heals a malformed counter instead of aborting mid-script', async () => {
    // A key holding a non-integer used to be coerced to 0 by `tonumber() or 0`;
    // the check passed and the NEXT INCRBY aborted the script — after earlier
    // writes had already committed, because Redis does not roll back partial
    // Lua writes. Result: a committed CU debit with no TTL, and every later
    // EVAL throwing. Reproduced by codex; this pins the fix.
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    const { createMoralisAdapter, monthKey } = await load()
    vi.stubGlobal('fetch', fetchOk())
    const cuK = `moralis:cu:v1:${monthKey()}`

    await client.set('moralis:rl:v7:history:hourly', 'broken')

    const r = await createMoralisAdapter(CFG).getAddressHistory('0xr-malformed')
    expect(r.ok).toBe(true)

    // The malformed key was reset and counted from zero...
    expect(await client.get('moralis:rl:v7:history:hourly')).toBe('1')
    // ...and the CU debit is correct rather than double-applied or stranded.
    expect(await client.get(cuK)).toBe('25')
    expect(await client.pttl(cuK)).toBeGreaterThan(0)
    expect(await client.pttl('moralis:rl:v7:history:hourly')).toBeGreaterThan(0)
  })

  it('leaves every counter untouched when a call is denied', async () => {
    // Replaces an earlier "never leaves a counter negative when a key expires
    // mid-flight" test, which deleted the key BETWEEN two completed calls and
    // so would have passed against the old broken INCR/DECR implementation too.
    // The property that actually distinguishes the designs is that a denial
    // writes nothing at all — no value change, no TTL re-arm.
    vi.stubEnv('MORALIS_HISTORY_HOURLY_MAX', '1')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    const { createMoralisAdapter, monthKey } = await load()
    vi.stubGlobal('fetch', fetchOk())
    const a = createMoralisAdapter(CFG)
    const cuK = `moralis:cu:v1:${monthKey()}`
    const hK = 'moralis:rl:v7:history:hourly'

    await a.getAddressHistory('0xr-u1')
    const before = { cu: await client.get(cuK), h: await client.get(hK), ttl: await client.pttl(hK) }

    expect(await a.getAddressHistory('0xr-u2')).toEqual({ ok: false, reason: 'rate_limited' })

    expect(await client.get(cuK)).toBe(before.cu)
    expect(await client.get(hK)).toBe(before.h)
    expect(await client.pttl(hK)).toBeLessThanOrEqual(before.ttl)
  })

  it('concurrent callers cannot collectively exceed the ceiling', async () => {
    // Two processes share this Redis in production. Fire many admissions at
    // once against a ceiling of 4 calls' worth of CU.
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '100')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    vi.stubEnv('MORALIS_HISTORY_HOURLY_MAX', '999')
    const { createMoralisAdapter, monthKey } = await load()
    const f = fetchOk()
    vi.stubGlobal('fetch', f)
    const a = createMoralisAdapter(CFG)

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => a.getAddressHistory(`0xr-conc-${i}`)),
    )
    const admitted = results.filter((r) => r.ok).length
    expect(admitted).toBe(4)
    expect(Number(await client.get(`moralis:cu:v1:${monthKey()}`))).toBe(100)
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('charges a post-midnight request to the NEW month, not the old ledger', async () => {
    // The earlier version of this test only asserted that an unused 2019 key
    // was absent — it never advanced the clock or performed an admission after
    // a boundary, so an implementation that captured the month key once at
    // module load would have passed while billing new-month traffic to the
    // previous ledger. Fake only Date so ioredis's own timers keep working.
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    const { createMoralisAdapter, monthKey } = await load()
    vi.stubGlobal('fetch', fetchOk())
    const a = createMoralisAdapter(CFG)

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-08-31T23:59:30Z'))
      const augKey = `moralis:cu:v1:${monthKey()}`
      expect(augKey).toBe('moralis:cu:v1:2026-08')
      await a.getAddressHistory('0xr-aug')
      expect(await client.get(augKey)).toBe('25')

      vi.setSystemTime(new Date('2026-09-01T00:00:30Z'))
      const sepKey = `moralis:cu:v1:${monthKey()}`
      expect(sepKey).toBe('moralis:cu:v1:2026-09')
      await a.getAddressHistory('0xr-sep')

      // The new month starts clean and the old ledger is not touched again.
      expect(await client.get(sepKey)).toBe('25')
      expect(await client.get(augKey)).toBe('25')
    } finally {
      vi.useRealTimers()
    }
  })

  it('health reports the Redis ledger and labels its source', async () => {
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '1000')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '25')
    const { createMoralisAdapter, getMoralisHealthState } = await load()
    vi.stubGlobal('fetch', fetchOk())
    await createMoralisAdapter(CFG).getAddressHistory('0xr-health')

    const h = await getMoralisHealthState()
    const cu = h.monthlyCu as Record<string, unknown>
    expect(cu.used).toBe(25)
    expect(cu.source).toBe('redis')
    expect(cu.scope).toBe('per-ledger')
    expect((h.buckets as Record<string, Record<string, unknown>>).history.source).toBe('redis')
    expect(h.source).toBe('redis')
  })

  /**
   * THE 2026-09-15 MORALIS OVERAGE. Both Render key-value instances are 256MB
   * `starter` plans with maxmemory-policy=noeviction, and the explorer's
   * `body:tx:*` cache (7-day TTL, unbounded key count) filled them: 172,133 of
   * 172,218 keys on ETH, 87,704 of 87,705 on BNB. `noeviction` does not evict —
   * it REFUSES every write — so ADMIT_LUA aborted at line 38, the INCRBY, with
   *   OOM command not allowed when used memory > 'maxmemory'
   * `isRateLimited`'s bare catch swallowed that and the fail-closed guard
   * returned "limited". Measured on the deployed eth-indexer with a warm,
   * `ready` client: getAddressHistory -> rate_limited in 3ms, ledger DELTA 0.
   *
   * Denying is the right call. Denying SILENTLY is not: /api/health went on
   * reporting `used: 262375, max: 1500000, limited: false, source: 'redis'` —
   * a comfortable 17% — while the ledger had been frozen since 2026-09-08
   * 18:00 UTC and every Moralis call on both chains was being refused. The
   * ceiling cannot bind when its counter cannot be written, and nothing said so.
   *
   * This pins the readout, not the denial: a ledger that cannot record spend
   * must not render as a healthy tally.
   */
  it('reports the ledger as UNWRITABLE when Redis refuses the debit, not as a healthy tally', async () => {
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '1000000')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '150')
    const { createMoralisAdapter, getMoralisHealthState, monthKey } = await load()
    vi.stubGlobal('fetch', fetchOk())
    const a = createMoralisAdapter(CFG)
    const cuK = `moralis:cu:v1:${monthKey()}`

    // A normal admission first, so the ledger holds a plausible-looking figure
    // — exactly the 262,375 an operator read and trusted.
    expect((await a.getAddressHistory('0xoom-warm')).ok).toBe(true)
    expect(await client.get(cuK)).toBe('150')
    expect(((await getMoralisHealthState()).monthlyCu as Record<string, unknown>).writable).toBe(true)

    // Reproduce production: full instance, noeviction. Reads still work, every
    // write is refused. Restored in `finally` — this is the one place the suite
    // touches server config, and leaking it would break every later test.
    const origMax = (await client.config('GET', 'maxmemory')) as [string, string]
    const origPolicy = (await client.config('GET', 'maxmemory-policy')) as [string, string]
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await client.config('SET', 'maxmemory-policy', 'noeviction')
      await client.config('SET', 'maxmemory', '1')

      expect(await a.getAddressHistory('0xoom-1')).toEqual({ ok: false, reason: 'rate_limited' })
      expect(await a.getAddressHistory('0xoom-2')).toEqual({ ok: false, reason: 'rate_limited' })

      // Nothing was committed — no partial debit for a call that never happened.
      expect(await client.get(cuK)).toBe('150')

      // The alarm fires, and it names the cause. Asserting the text matters:
      // the whole defect was that this failure produced no signal at all, and a
      // guardrail only ever seen passing may be unable to fire.
      const ledgerErrs = errs.mock.calls.map(String).filter((m) => m.includes('CU ledger write REFUSED'))
      expect(ledgerErrs).toHaveLength(1) // TRANSITION only — not once per call
      expect(ledgerErrs[0]).toMatch(/OOM command not allowed/)

      const cu = (await getMoralisHealthState()).monthlyCu as Record<string, unknown>
      expect(cu.writable).toBe(false)
      // `used` is a READ, so it still answers — and still says 150/1000000.
      // Without `limited`, that reads as "plenty of budget left" while every
      // call is in fact being refused.
      expect(cu.limited).toBe(true)
    } finally {
      await client.config('SET', 'maxmemory', origMax[1])
      await client.config('SET', 'maxmemory-policy', origPolicy[1])
      errs.mockRestore()
    }

    // And it recovers: once writes are accepted again the ledger resumes.
    expect((await a.getAddressHistory('0xoom-3')).ok).toBe(true)
    expect(await client.get(cuK)).toBe('300')
    expect(((await getMoralisHealthState()).monthlyCu as Record<string, unknown>).writable).toBe(true)
  })

  /**
   * The companion invariant to the test above, and the one a plausible
   * simplification gets wrong: clearing the unwritable flag on ANY reply from
   * the script rather than only on a COMMIT.
   *
   * The admission script checks all three caps BEFORE it writes anything, so a
   * cap denial (return 1/2/3) never reaches the INCRBY and therefore learns
   * NOTHING about whether the ledger can be written. A full Redis that also
   * happens to be over its hourly cap would then answer that denial cleanly,
   * clear the flag, and put /api/health back to `writable: true` over a ledger
   * that is still frozen — reinstating the exact lie this pins down.
   */
  it('a cap denial does not clear the unwritable flag — it never reaches the write', async () => {
    vi.stubEnv('MORALIS_MONTHLY_CU_MAX', '1000000')
    vi.stubEnv('MORALIS_CU_ADDRESS_HISTORY', '150')
    vi.stubEnv('MORALIS_HISTORY_HOURLY_MAX', '5')
    const { createMoralisAdapter, getMoralisHealthState } = await load()
    vi.stubGlobal('fetch', fetchOk())
    const a = createMoralisAdapter(CFG)
    const writable = async () =>
      ((await getMoralisHealthState()).monthlyCu as Record<string, unknown>).writable

    const origMax = (await client.config('GET', 'maxmemory')) as [string, string]
    const origPolicy = (await client.config('GET', 'maxmemory-policy')) as [string, string]
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await client.config('SET', 'maxmemory-policy', 'noeviction')

      // 1. Full instance: the call clears every cap, reaches INCRBY, and OOMs.
      await client.config('SET', 'maxmemory', '1')
      expect(await a.getAddressHistory('0xcap-1')).toEqual({ ok: false, reason: 'rate_limited' })
      expect(await writable()).toBe(false)

      // 2. Push the hourly counter over its cap (needs writes, so briefly
      //    restore headroom), then make the instance full again.
      await client.config('SET', 'maxmemory', origMax[1])
      await client.set('moralis:rl:v7:history:hourly', '99')
      await client.config('SET', 'maxmemory', '1')

      // 3. Now the script returns 2 at the hourly check — a clean reply that
      //    performed no write at all. The ledger is still unwritable.
      expect(await a.getAddressHistory('0xcap-2')).toEqual({ ok: false, reason: 'rate_limited' })
      expect(await writable()).toBe(false)
    } finally {
      await client.config('SET', 'maxmemory', origMax[1])
      await client.config('SET', 'maxmemory-policy', origPolicy[1])
      vi.restoreAllMocks()
    }
  })
})
