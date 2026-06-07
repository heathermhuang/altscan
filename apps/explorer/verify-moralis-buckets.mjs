// apps/explorer/verify-moralis-buckets.mjs
// Standalone logic test for the per-feature Moralis limiter.
// Local tsc/vitest are broken (esbuild/drizzle skew, see CLAUDE.md), so this mirrors the pure
// algorithm from lib/moralis.ts and asserts its properties. Run: node apps/explorer/verify-moralis-buckets.mjs
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL:', msg) } }
function eq(a, b, msg) { assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`) }

// ---- fake Redis (incr/decr/get/pexpire/pttl) ----
function makeRedis() {
  const v = new Map(), ttl = new Map()
  return {
    async incr(k) { const n = (Number(v.get(k)) || 0) + 1; v.set(k, n); return n },
    async decr(k) { const n = (Number(v.get(k)) || 0) - 1; v.set(k, n); return n },
    async get(k) { return v.has(k) ? String(v.get(k)) : null },
    async pexpire(k, ms) { ttl.set(k, ms); return 1 },
    async pttl(k) { return ttl.has(k) ? ttl.get(k) : -1 }, // -1 = no expiry
    _v: v, _ttl: ttl,
  }
}

// ===== BEGIN algorithm mirror — MUST MATCH apps/explorer/lib/moralis.ts =====
const HOURLY_WINDOW = 3600_000, DAILY_WINDOW = 86400_000
const BUCKET_CAPS = {
  history: { hourlyMax: 700, dailyMax: 5000 },
  holders: { hourlyMax: 400, dailyMax: 2500 },
  assets:  { hourlyMax: 400, dailyMax: 2500 },
}
const RL_PREFIX = 'moralis:rl:v7'
function bucketKeys(bucket) { return { hourly: `${RL_PREFIX}:${bucket}:hourly`, daily: `${RL_PREFIX}:${bucket}:daily` } }
async function isRateLimited(r, bucket) {
  const { hourly: hKey, daily: dKey } = bucketKeys(bucket)
  const { hourlyMax, dailyMax } = BUCKET_CAPS[bucket]
  const hourly = await r.incr(hKey)
  if (hourly === 1) await r.pexpire(hKey, HOURLY_WINDOW)
  else if ((await r.pttl(hKey)) < 0) await r.pexpire(hKey, HOURLY_WINDOW)
  if (hourly > hourlyMax) { await r.decr(hKey); return true }
  const daily = await r.incr(dKey)
  if (daily === 1) await r.pexpire(dKey, DAILY_WINDOW)
  else if ((await r.pttl(dKey)) < 0) await r.pexpire(dKey, DAILY_WINDOW)
  if (daily > dailyMax) { await r.decr(dKey); await r.decr(hKey); return true }
  return false
}
function buildBucketState(hourly, daily, caps) {
  return { hourly, hourlyMax: caps.hourlyMax, daily, dailyMax: caps.dailyMax,
    limited: (hourly !== null && hourly >= caps.hourlyMax) || (daily !== null && daily >= caps.dailyMax) }
}
const memCounters = {
  history: { hourly: 0, hourlyStart: 0, daily: 0, dailyStart: 0 },
  holders: { hourly: 0, hourlyStart: 0, daily: 0, dailyStart: 0 },
  assets:  { hourly: 0, hourlyStart: 0, daily: 0, dailyStart: 0 },
}
function isRateLimitedMemory(bucket, now) { // real code uses Date.now(); param here for determinism
  const c = memCounters[bucket]; const { hourlyMax, dailyMax } = BUCKET_CAPS[bucket]
  if (now - c.hourlyStart > HOURLY_WINDOW) { c.hourly = 0; c.hourlyStart = now }
  if (now - c.dailyStart > DAILY_WINDOW) { c.daily = 0; c.dailyStart = now }
  if (c.daily >= dailyMax) return true
  if (c.hourly >= hourlyMax) return true
  c.hourly++; c.daily++; return false
}
// ===== END algorithm mirror =====

async function main() {
  // T1: key mapping is per-bucket
  eq(bucketKeys('holders').daily, 'moralis:rl:v7:holders:daily', 'bucketKeys holders daily')
  eq(bucketKeys('history').hourly, 'moralis:rl:v7:history:hourly', 'bucketKeys history hourly')

  // T2: isolation — saturating holders must NOT limit history/assets
  {
    const r = makeRedis()
    for (let i = 0; i < BUCKET_CAPS.holders.hourlyMax; i++) await isRateLimited(r, 'holders')
    eq(await isRateLimited(r, 'holders'), true, 'holders blocked after its hourly cap')
    eq(await isRateLimited(r, 'history'), false, 'history NOT limited by holders saturation')
    eq(await isRateLimited(r, 'assets'), false, 'assets NOT limited by holders saturation')
    eq(Number(r._v.get('moralis:rl:v7:holders:hourly')), 400, 'holders hourly rolled back to cap')
  }

  // T3: rollback — repeated blocked calls keep the counter at the cap, not inflating
  {
    const r = makeRedis()
    for (let i = 0; i < BUCKET_CAPS.assets.hourlyMax; i++) await isRateLimited(r, 'assets')
    for (let i = 0; i < 10; i++) await isRateLimited(r, 'assets') // all blocked
    eq(Number(r._v.get('moralis:rl:v7:assets:hourly')), 400, 'assets hourly stays at cap under repeated blocks')
  }

  // T4: daily cap trips and rolls back BOTH counters
  {
    const r = makeRedis()
    r._v.set('moralis:rl:v7:history:daily', 5000) // at daily cap, hourly fresh
    eq(await isRateLimited(r, 'history'), true, 'history blocked at daily cap')
    eq(Number(r._v.get('moralis:rl:v7:history:daily')), 5000, 'history daily rolled back to cap')
    eq(Number(r._v.get('moralis:rl:v7:history:hourly')), 0, 'history hourly rolled back when daily trips')
  }

  // T5: TTL re-arm when a counter exists without an expiry
  {
    const r = makeRedis()
    r._v.set('moralis:rl:v7:assets:hourly', 5) // existing counter, pttl -1
    await isRateLimited(r, 'assets')
    eq(r._ttl.get('moralis:rl:v7:assets:hourly'), HOURLY_WINDOW, 'assets hourly TTL re-armed when missing')
  }

  // T6: buildBucketState.limited
  eq(buildBucketState(400, 100, BUCKET_CAPS.holders).limited, true, 'state limited when hourly>=cap')
  eq(buildBucketState(10, 10, BUCKET_CAPS.history).limited, false, 'state not limited under caps')
  eq(buildBucketState(null, null, BUCKET_CAPS.history).limited, false, 'state null counters -> not limited')

  // T7: in-memory fallback is also per-bucket isolated
  {
    const now = 1_000_000_000
    for (let i = 0; i < BUCKET_CAPS.assets.hourlyMax; i++) isRateLimitedMemory('assets', now)
    eq(isRateLimitedMemory('assets', now), true, 'memory: assets limited at hourly cap')
    eq(isRateLimitedMemory('history', now), false, 'memory: history isolated from assets')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main()
