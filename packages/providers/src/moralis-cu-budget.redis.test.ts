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
 * Uses a dedicated DB index and flushes it, so point it at a THROWAWAY server.
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

  beforeEach(async () => {
    client = new Redis(URL_!)
    await client.flushall()
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

  it('never leaves a counter negative when a key expires mid-flight', async () => {
    // The pre-Lua sequence could DECR a key that had just expired, recreating it
    // at -1 with no TTL — the next window then started 701 calls in credit.
    vi.stubEnv('MORALIS_HISTORY_HOURLY_MAX', '1')
    const { createMoralisAdapter } = await load()
    vi.stubGlobal('fetch', fetchOk())
    const a = createMoralisAdapter(CFG)

    await a.getAddressHistory('0xr-e1')
    await client.del('moralis:rl:v7:history:hourly') // simulate expiry
    await a.getAddressHistory('0xr-e2')

    const v = Number(await client.get('moralis:rl:v7:history:hourly'))
    expect(v).toBeGreaterThanOrEqual(0)
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

  it('rolls to a fresh ledger at the month boundary without a scheduled reset', async () => {
    const { createMoralisAdapter, monthKey } = await load()
    vi.stubGlobal('fetch', fetchOk())
    await createMoralisAdapter(CFG).getAddressHistory('0xr-m1')

    const thisMonth = `moralis:cu:v1:${monthKey()}`
    expect(await client.get(thisMonth)).not.toBeNull()

    // A different month is a different key: last month's spend cannot leak in.
    const other = `moralis:cu:v1:${monthKey(new Date('2019-03-15T00:00:00Z'))}`
    expect(other).not.toBe(thisMonth)
    expect(await client.get(other)).toBeNull()
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
})
