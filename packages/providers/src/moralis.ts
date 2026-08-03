/**
 * Moralis implementation of ProviderAdapter — the ONLY file that talks to
 * deep-index.moralis.io (guardrail-tested). All original protections are
 * unchanged from apps/explorer/lib/providers/moralis.ts: Redis/kv response
 * cache (off-heap, shared across instances), per-bucket fleet-wide rate
 * limiter (moralis:rl:v7 keys), MORALIS_DISABLED kill switch. Bot policy
 * stays in the explorer shim.
 *
 * A4b-0: lifted into @altscan/providers so the indexer can import it. Three
 * deltas vs the explorer copy, all mechanical:
 *   - `currency` (native ticker, summaries only) is passed in by the host
 *     instead of read from the explorer's chain singleton.
 *   - `sanitizeSymbol` comes from @altscan/explorer-core.
 *   - the cache-registry side effect moved to the explorer shim: this module
 *     must stay side-effect-free because the indexer has no cache registry.
 *     The explorer still registers `getKvFallbackSize` for its memory monitor.
 *
 * CU BUDGET — the account is on a plan with a MONTHLY Compute Unit allowance.
 * (This header said "Free tier: 40,000 CU/day" until 2026-08-01. That was stale
 * and it mattered: every control below was sized against a DAILY figure that no
 * longer described the bill.)
 * Strategy:
 *   - A hard MONTHLY CU ceiling (see monthlyCuMax) — the only control that can
 *     actually bound a monthly bill. Added 2026-08-01 after A4b backfill stayed
 *     inside its per-hour cap for 5 days and still ran the account to 100%.
 *   - Strict per-bucket rate limits (history/holders/assets, env-overridable)
 *   - Long cache TTLs (2hr per address) to avoid re-fetches
 *   - Small page sizes (limit=10-25) — enough to show useful data, minimizes CU
 *   - exclude_spam=true on token endpoints to skip noise
 *   - Only fetch for the active tab, never prefetch other tabs
 *   - Bot detection (explorer shim) skips the provider entirely for crawlers
 */
import { kvGet, kvSet, getRedis, isRedisUnavailable, sanitizeSymbol } from '@altscan/explorer-core'
import type { DataProviderConfig } from '@altscan/chain-config'
import type {
  AddressHistoryPage,
  ProviderAdapter,
  ProviderFailReason,
  ProviderNft,
  ProviderResult,
  ProviderTokenBalance,
  TokenHoldersPage,
  TokenTransfersPage,
} from './types'

const BASE = 'https://deep-index.moralis.io/api/v2.2'

// Cache strategy: responses live in Redis (shared across instances, OFF the Node heap),
// with a small bounded in-memory fallback when Redis is absent (see @altscan/explorer-core
// kv-cache). Moving this cache off the heap is what lets Moralis stay enabled without the
// OOM crash-loop that the old in-process Map caused on BNBScan.
// NULL_SENTINEL: negative results are cached for NULL_TTL to stop repeated Moralis calls
// for addresses that don't exist (a common abuse pattern).
const NULL_SENTINEL = '__null__'
const NULL_TTL = 5 * 60_000          // 5 minutes for negative results
const CACHE_TTL = 2 * 60 * 60_000    // 2 hours for positive results. Idle wallets (the only ones
                                     // that hit Moralis — active ones are in the local index) are
                                     // static, so longer caching is safe and cuts repeat calls ~4x.
                                     // Capped at 2h (not 24h) because bnbscan-redis is a starter
                                     // instance with noeviction — an over-full cache would fail the
                                     // rate-limiter INCR too.

/**
 * Read a cached JSON value.
 * Returns: undefined = cache miss, null = cached negative result, T = cached hit.
 */
async function cacheGetJson<T>(key: string): Promise<T | null | undefined> {
  const raw = await kvGet(key)
  if (raw === null) return undefined          // miss
  if (raw === NULL_SENTINEL) return null      // cached negative result
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

async function cacheSetJson(key: string, data: unknown): Promise<void> {
  await kvSet(key, JSON.stringify(data), CACHE_TTL)
}

async function cacheSetNull(key: string): Promise<void> {
  await kvSet(key, NULL_SENTINEL, NULL_TTL)
}

/**
 * Build a clean, human-readable summary for a Moralis history item.
 * Moralis's own `summary` field is garbled for swaps — e.g. it returns
 * "Swapped 0.134 WBNB and 0.134 BNB for 0.134 WBNB and 0.134 BNB" (same tokens
 * and amounts on both sides). We rebuild swaps from the structured
 * erc20_transfers and only fall back to Moralis's prose for simple cases.
 *
 * `currency` is the host chain's native ticker, supplied by the caller (the
 * package has no chain singleton). Empty string simply omits the ticker.
 */
function summarizeMoralisHistory(t: {
  category: string
  summary: string
  value: string
  erc20_transfers?: Array<{
    token_symbol: string
    contract_address: string
    value_formatted: string
    direction: string
  }>
}, currency: string): string {
  const transfers = t.erc20_transfers ?? []
  const fmtAmt = (v: string): string => {
    const n = Number(v)
    if (!isFinite(n) || n === 0) return '0'
    if (n < 0.0001) return n.toExponential(2)
    return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  }
  const symOf = (s: string): string => sanitizeSymbol(s || '').slice(0, 12) || 'tokens'
  const largest = <T extends { value_formatted: string }>(arr: T[]): T | undefined =>
    arr.slice().sort((a, b) => Number(b.value_formatted) - Number(a.value_formatted))[0]
  const humanizeCategory = (c: string): string =>
    c ? c.replace(/[_-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()) : 'Transaction'
  const isDegenerate = (s: string): boolean => {
    const i = s.toLowerCase().indexOf(' for ')
    if (i === -1) return false
    const before = s.slice(0, i).replace(/^\s*swapped\s+/i, '').trim()
    const after = s.slice(i + 5).trim()
    return before === after
  }

  const sent = transfers.filter((e) => e.direction === 'send')
  const received = transfers.filter((e) => e.direction === 'receive')

  // Swap: tokens both leaving and entering the wallet — the exact case Moralis garbles.
  if (sent.length > 0 && received.length > 0) {
    const out = largest(sent)
    const inc = largest(received)
    if (out && inc && out.contract_address?.toLowerCase() !== inc.contract_address?.toLowerCase()) {
      return `Swapped ${fmtAmt(out.value_formatted)} ${symOf(out.token_symbol)} for ${fmtAmt(inc.value_formatted)} ${symOf(inc.token_symbol)}`
    }
    return 'Token swap'
  }

  // Non-swap: trust Moralis prose unless it's empty, the uninformative
  // "Signed a transaction", or the degenerate "X for X" form.
  const prose = t.summary?.trim()
  if (prose && prose !== 'Signed a transaction' && !isDegenerate(prose)) {
    return prose
  }

  // Structured single-sided transfer.
  if (sent.length > 0) {
    const out = largest(sent)
    if (out) return `Sent ${fmtAmt(out.value_formatted)} ${symOf(out.token_symbol)}`
  }
  if (received.length > 0) {
    const inc = largest(received)
    if (inc) return `Received ${fmtAmt(inc.value_formatted)} ${symOf(inc.token_symbol)}`
  }

  // Native-value transfer with no token legs, else humanized category.
  const nativeVal = Number(t.value) / 1e18
  if (nativeVal > 0) {
    const amount = nativeVal.toLocaleString('en-US', { maximumFractionDigits: 6 })
    return currency ? `${amount} ${currency} transfer` : `${amount} transfer`
  }
  return humanizeCategory(t.category)
}

/**
 * Normalize an upstream `log_index` into a stable primary-key component.
 *
 * A4b (R3) keys backfilled token transfers on (scope_address, tx_hash,
 * log_index). Returning a sentinel string here would be unsafe: `''` satisfies
 * the `string` type, so two absent values within one tx would type-check and
 * then collide on the PK. `null` makes absence unrepresentable as a key and
 * forces every consumer to decide.
 *
 * Accepts only a non-negative integer (as number or decimal string) and
 * canonicalizes it, so `7`, `'7'` and `'007'` all map to `'7'`. Rejects
 * absent, empty, whitespace, negative, fractional, and non-numeric input.
 */
export function normalizeLogIndex(raw: string | number | null | undefined): string | null {
  if (raw == null) return null
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? String(raw) : null
  }
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isSafeInteger(n) ? String(n) : null
}

/**
 * Rate limiter — PER-FEATURE budgets so a spike/abuse in one feature can't starve the others.
 * Buckets:
 *   - history : getAddressHistory                                        (~25 CU/call)
 *   - holders : getTokenHolders + getTokenHolderCount                    (~50 CU/call, 2 calls/token)
 *   - assets  : getAddressTokenBalances + getAddressNfts + getAddressTokenTransfers (~25 CU/call)
 * Caps are env-overridable; defaults sum to 1500/hr + 10000/day — the prior single-bucket total —
 * so total Moralis exposure is UNCHANGED (this only partitions it). A saturated bucket fails with
 * reason 'rate_limited' → the caller falls back to its local view, and the OTHER buckets keep serving.
 * Keyed in Redis so caps apply fleet-wide (in-memory fallback when Redis is down).
 */
type MoralisBucket = 'history' | 'holders' | 'assets'

const HOURLY_WINDOW = 3600_000
const DAILY_WINDOW = 86400_000

function envInt(name: string, fallback: number): number {
  return parseInt(process.env[name] ?? String(fallback), 10) || fallback
}

/**
 * Strict positive-integer env read for values that BOUND SPEND.
 *
 * `envInt` above uses `parseInt`, which is wrong for anything a budget depends
 * on, in two directions that both bite:
 *   - `parseInt` takes a NUMERIC PREFIX, so "999999999999999999999garbage"
 *     yields ~1e30 — a ceiling that can never be reached, i.e. no ceiling.
 *   - `"1_000"` yields 1, because parsing stops at the underscore. A config
 *     typo meant as "raise the limit" becomes an outage instead.
 * `|| fallback` also silently accepts negatives, and a negative CU cost makes
 * every call DECREMENT the meter, so usage runs backwards forever.
 *
 * Requiring the whole string to be digits rejects all of it: "1_000", "1e9",
 * "0x10", "+5", "-1", "Infinity", "12garbage", "" and "  ". The upper bound
 * closes the last gap — an absurd but well-formed number is still no ceiling.
 *
 * `envInt` is deliberately left alone for the hourly/daily CALL caps: those
 * predate this incident, are not the billing unit, and changing their parsing
 * is not this PR's job.
 */
export function strictPositiveInt(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  if (raw == null) return fallback
  const t = raw.trim()
  if (!/^[0-9]+$/.test(t)) return fallback
  const n = Number(t)
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) return fallback
  return n
}

/** No single endpoint plausibly costs more than this; a larger configured value
 *  is a typo, and honouring it would let one call exhaust the month. */
const MAX_CU_COST = 100_000
const cuCostEnv = (name: string, fallback: number): number =>
  strictPositiveInt(process.env[name], fallback, MAX_CU_COST)

type BucketCaps = { hourlyMax: number; dailyMax: number }
const BUCKET_CAPS: Record<MoralisBucket, BucketCaps> = {
  history: { hourlyMax: envInt('MORALIS_HISTORY_HOURLY_MAX', 700), dailyMax: envInt('MORALIS_HISTORY_DAILY_MAX', 5000) },
  holders: { hourlyMax: envInt('MORALIS_HOLDERS_HOURLY_MAX', 400), dailyMax: envInt('MORALIS_HOLDERS_DAILY_MAX', 2500) },
  assets:  { hourlyMax: envInt('MORALIS_ASSETS_HOURLY_MAX', 400),  dailyMax: envInt('MORALIS_ASSETS_DAILY_MAX', 2500) },
}

// v7 keys: per-bucket. Bumped from v6 (single shared counter) so the new buckets start clean and
// the poisoned/over-inflated v6 counter is abandoned (same trick as every prior limiter fix).
const RL_PREFIX = 'moralis:rl:v7'
function bucketKeys(bucket: MoralisBucket): { hourly: string; daily: string } {
  return { hourly: `${RL_PREFIX}:${bucket}:hourly`, daily: `${RL_PREFIX}:${bucket}:daily` }
}

/**
 * ⚠ UNVERIFIED CU COSTS — read this before trusting any number below.
 *
 * These were prose comments ("Cost: ~25 CU") that had never been checked against
 * Moralis's published rate table. They are now DATA, debited from a real budget,
 * so a wrong number produces a wrong ceiling rather than a wrong sentence. Two
 * things are still unknown and BOTH need Moralis console access to settle:
 *   1. the true per-endpoint CU rate, and
 *   2. whether these endpoints bill per REQUEST or per RESULT. If per result,
 *      `limit` does not reduce spend for a fixed volume of data, and the small
 *      page sizes below buy nothing — they just split the same bill into more
 *      requests. A4b backfill pulled 290,067 rows in 6 days; under per-result
 *      billing that row count, not the 16,077 request count, is the bill.
 *
 * Every entry is env-overridable so the real rates can be applied WITHOUT a
 * deploy, the same no-deploy property that let the backfill flag flip.
 */
export const CU_COST = {
  addressHistory:   cuCostEnv('MORALIS_CU_ADDRESS_HISTORY', 25),
  addressBalances:  cuCostEnv('MORALIS_CU_ADDRESS_BALANCES', 25),
  addressTransfers: cuCostEnv('MORALIS_CU_ADDRESS_TRANSFERS', 25),
  addressNfts:      cuCostEnv('MORALIS_CU_ADDRESS_NFTS', 25),
  tokenHolders:     cuCostEnv('MORALIS_CU_TOKEN_HOLDERS', 50),
  tokenHolderCount: cuCostEnv('MORALIS_CU_TOKEN_HOLDER_COUNT', 50),
} as const

/**
 * Monthly CU ceiling — PER LEDGER, not per Moralis account. Read the scope
 * note below before sizing it; an earlier revision of this comment called it
 * "account-wide", which it is not and cannot be with the current infrastructure.
 *
 * ⚠ SCOPE. There is one ledger per Redis, plus one per process that has no
 * Redis. BNB web + indexer share a Redis ⇒ one ledger. ETH has no Redis ⇒ each
 * ETH process counts alone. So this value is enforced up to ~4 times over
 * against ONE Moralis account. Provisioning Redis for ETH (Track C1) is the
 * only thing that makes a single ceiling mean what its name suggests.
 *
 * This is the control that did not exist before 2026-08-01, and its absence is
 * why the account hit 100% of plan.
 *
 * Hourly and daily CALL caps cannot bound a MONTHLY CU bill. Backfill never
 * once exceeded its 300-pages/hour reserve; it simply ran at that reserve for
 * five days. Every per-request control was green the entire time.
 *
 * Default is ~4x the measured pre-incident fleet baseline (~450k CU/month at
 * the estimated rates), which leaves real traffic untouched while hard-stopping
 * a runaway in days rather than never. Raise it once the true plan allowance is
 * known — that is a one-line env change.
 */
const DEFAULT_MONTHLY_CU_MAX = 2_000_000
const MONTHLY_TTL = 35 * 86400_000  // key is month-stamped; TTL only reaps old months

/**
 * FAIL-CLOSED config read. Unset, blank, whitespace, zero, negative, or
 * unparseable all fall back to the default ceiling. There is deliberately NO
 * value that DISABLES the ceiling.
 *
 * This is the direct lesson of the CREATIVES_KEY_PREFIX finding: a check that
 * reads config and treats "unset" as "skip" ships the hole it was written to
 * close. If you want more headroom, raise the number; you cannot switch the
 * meter off.
 */
/** Upper bound on a configurable ceiling. A well-formed but absurd number is
 *  still "no ceiling" in practice; at $11.25 per million CU this cap keeps the
 *  worst configurable monthly overage around four figures rather than
 *  unbounded. Anything larger is a typo, not an intent. */
const MAX_MONTHLY_CU = 100_000_000

export function monthlyCuMax(env: Record<string, string | undefined> = process.env): number {
  return strictPositiveInt(env.MORALIS_MONTHLY_CU_MAX, DEFAULT_MONTHLY_CU_MAX, MAX_MONTHLY_CU)
}

/** Calendar-month key, UTC. Month-stamped so rollover needs no scheduled reset
 *  and a stale key cannot silently carry last month's spend into this month. */
export function monthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}
const cuKey = (now?: Date): string => `moralis:cu:v1:${monthKey(now)}`

// In-memory fallback — per bucket, used only when Redis is unavailable (e.g. EthScan has no Redis,
// or a Redis blip). Per-instance, so with numInstances > 1 the effective cap is N×; acceptable.
type MemCounter = { hourly: number; hourlyStart: number; daily: number; dailyStart: number }
const memCounters: Record<MoralisBucket, MemCounter> = {
  history: { hourly: 0, hourlyStart: Date.now(), daily: 0, dailyStart: Date.now() },
  holders: { hourly: 0, hourlyStart: Date.now(), daily: 0, dailyStart: Date.now() },
  assets:  { hourly: 0, hourlyStart: Date.now(), daily: 0, dailyStart: Date.now() },
}

/** Per-process monthly CU tally, used when Redis is absent (EthScan). */
let memCu: { month: string; used: number } = { month: monthKey(), used: 0 }

/** Roll expired windows for one bucket. Split out so the health readout can
 *  report in-memory counters without also mutating spend. */
function rollMemWindows(bucket: MoralisBucket): MemCounter {
  const now = Date.now()
  const c = memCounters[bucket]
  if (now - c.hourlyStart > HOURLY_WINDOW) { c.hourly = 0; c.hourlyStart = now }
  if (now - c.dailyStart > DAILY_WINDOW) { c.daily = 0; c.dailyStart = now }
  const mk = monthKey()
  if (memCu.month !== mk) memCu = { month: mk, used: 0 }
  return c
}

/** Check ALL ceilings BEFORE mutating any of them, so a denial can never leave
 *  a partial debit behind (the Redis path has to refund for the same reason). */
function isRateLimitedMemory(bucket: MoralisBucket, cuCost: number): boolean {
  const c = rollMemWindows(bucket)
  const { hourlyMax, dailyMax } = BUCKET_CAPS[bucket]
  if (memCu.used + cuCost > monthlyCuMax()) return true
  if (c.daily >= dailyMax) return true
  if (c.hourly >= hourlyMax) return true
  memCu.used += cuCost
  c.hourly++; c.daily++
  return false
}

/**
 * Redis-backed per-bucket limiter. INCR then, if over cap, DECR back so blocked retries don't keep
 * inflating the counter (the old code's INCR-before-check let a blocked feature climb to 3× its cap
 * and made the health readout lie). Always guarantees a TTL: set on first INCR, re-arm if PTTL<0.
 */
/**
 * Admission control as ONE atomic Redis operation.
 *
 * The previous shape was INCR-then-DECR-on-denial, and it could not be made
 * correct by adding more refunds. Every early return and every thrown
 * connection error left the ledger holding spend for a call that was never
 * sent, and the JS `catch` then fell through to a SEPARATE in-memory ledger
 * with no idea which Redis commands had committed. Result: leaked budget in one
 * direction, under-counting in the other, and no way to tell which had happened.
 *
 * Inside EVAL the whole decision is one step: read all three counters, decide,
 * and only then commit. There is no intermediate state, so there is nothing to
 * refund and no interleaving with the other processes sharing this Redis.
 *
 * It also removes a race the sequential version could not avoid: an hourly key
 * that expired between INCR and PTTL got recreated by the compensating DECR as
 * `-1` with NO TTL, so the next window silently started 701 calls in credit.
 * Nothing here ever decrements.
 *
 * Returns 0 admitted, 1 monthly-denied, 2 hourly-denied, 3 daily-denied.
 */
const ADMIT_LUA = `
local cuCost    = tonumber(ARGV[1])
local cuMax     = tonumber(ARGV[2])
local hourlyMax = tonumber(ARGV[3])
local dailyMax  = tonumber(ARGV[4])

local cu     = tonumber(redis.call('GET', KEYS[1])) or 0
local hourly = tonumber(redis.call('GET', KEYS[2])) or 0
local daily  = tonumber(redis.call('GET', KEYS[3])) or 0

if cu + cuCost > cuMax then return 1 end
if hourly + 1 > hourlyMax then return 2 end
if daily + 1 > dailyMax then return 3 end

redis.call('INCRBY', KEYS[1], cuCost)
redis.call('INCR', KEYS[2])
redis.call('INCR', KEYS[3])

-- PTTL < 0 covers both "exists, no TTL" (-1) and "missing" (-2). The INCRs
-- above guarantee existence, so a negative here means the TTL needs arming.
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[5]) end
if redis.call('PTTL', KEYS[2]) < 0 then redis.call('PEXPIRE', KEYS[2], ARGV[6]) end
if redis.call('PTTL', KEYS[3]) < 0 then redis.call('PEXPIRE', KEYS[3], ARGV[7]) end

return 0
`

async function isRateLimited(bucket: MoralisBucket, cuCost: number): Promise<boolean> {
  const r = getRedis()
  if (r && !isRedisUnavailable()) {
    try {
      const { hourly: hKey, daily: dKey } = bucketKeys(bucket)
      const { hourlyMax, dailyMax } = BUCKET_CAPS[bucket]
      // cuKey() is evaluated HERE, immediately before the call, not at function
      // entry — so a request that arrives after UTC midnight debits the new
      // month. Requests ADMITTED just before the boundary and SENT just after
      // are still charged to the old month; that overshoot is bounded by
      // in-flight concurrency and is inherent to charging at admission.
      const res = await r.eval(
        ADMIT_LUA,
        3,
        cuKey(),
        hKey,
        dKey,
        String(cuCost),
        String(monthlyCuMax()),
        String(hourlyMax),
        String(dailyMax),
        String(MONTHLY_TTL),
        String(HOURLY_WINDOW),
        String(DAILY_WINDOW),
      )
      return Number(res) !== 0
    } catch {
      // Redis genuinely unreachable. Safe to fall through now: EVAL is
      // all-or-nothing, so there is no half-applied debit to reconcile.
    }
  }
  return isRateLimitedMemory(bucket, cuCost)
}

/** Pure assembler for one bucket's health row. Exported for the standalone logic test. */
export function buildBucketState(
  hourly: number | null,
  daily: number | null,
  caps: { hourlyMax: number; dailyMax: number },
): Record<string, unknown> {
  return {
    hourly, hourlyMax: caps.hourlyMax,
    daily, dailyMax: caps.dailyMax,
    limited: (hourly !== null && hourly >= caps.hourlyMax) || (daily !== null && daily >= caps.dailyMax),
  }
}

/**
 * Per-bucket snapshot for the admin /api/health endpoint (exposed to routes via
 * getDataProviderHealth in ./index). Read-only (plain GETs, no INCR) so it
 * never consumes budget. Shows WHICH feature saturated — the visibility that turned every prior
 * limiter incident from a multi-hour guess into a one-line diagnosis.
 */
export async function getMoralisHealthState(): Promise<Record<string, unknown>> {
  const buckets: Record<string, unknown> = {}
  let anyLimited = false
  const r = getRedis()
  const redisLive = !!r && !isRedisUnavailable()

  for (const bucket of ['history', 'holders', 'assets'] as MoralisBucket[]) {
    let hourly: number | null = null
    let daily: number | null = null
    // Source is tracked PER READING, not once for the whole response. A single
    // global flag lied in both directions: one failed bucket read relabelled
    // every other bucket 'memory' even though they came from Redis, and — worse
    // — a failed monthly GET fell back to memCu.used (usually 0) while the label
    // still said 'redis', so a Redis ledger sitting at its ceiling could be
    // reported as used:0, limited:false, source:'redis'. Exactly the reading an
    // operator would trust to conclude nothing was wrong.
    let bucketSource: 'redis' | 'memory' = 'memory'
    if (redisLive) {
      try {
        const { hourly: hKey, daily: dKey } = bucketKeys(bucket)
        const [h, d] = await Promise.all([r!.get(hKey), r!.get(dKey)])
        hourly = h ? Number(h) : 0
        daily = d ? Number(d) : 0
        bucketSource = 'redis'
      } catch { /* Redis blip — fall through to the in-memory tally below */ }
    }
    // No Redis (EthScan) or a blip: report THIS PROCESS's in-memory counters
    // instead of null. Reporting null was not merely a gap — buildBucketState
    // computes `limited` as `hourly !== null && hourly >= max`, so a null made
    // `limited` UNCONDITIONALLY false. EthScan therefore reported "not limited"
    // no matter how much it had spent, and the same null made the worker's
    // sharedBucketOverHeadroom() politeness check return false, removing its
    // only brake. One missing value silently disabled both the alarm and the
    // governor. Per-process (not fleet-wide) numbers, hence `source`.
    if (hourly === null) {
      const c = rollMemWindows(bucket)
      hourly = c.hourly
      daily = c.daily
      bucketSource = 'memory'
    }
    const state = buildBucketState(hourly, daily, BUCKET_CAPS[bucket])
    if (state.limited) anyLimited = true
    buckets[bucket] = { ...state, source: bucketSource }
  }

  // Monthly CU ledger — the number that actually maps to the invoice.
  const cuMax = monthlyCuMax()
  let cuUsed = memCu.used
  let cuSource: 'redis' | 'memory' = 'memory'
  if (redisLive) {
    try {
      const v = await r!.get(cuKey())
      cuUsed = v ? Number(v) : 0
      cuSource = 'redis'
    } catch { /* keep the in-memory figure AND the honest 'memory' label */ }
  }
  const cuLimited = cuUsed >= cuMax
  if (cuLimited) anyLimited = true

  return {
    disabled: process.env.MORALIS_DISABLED === 'true',
    keyPresent: !!process.env.MORALIS_API_KEY,
    buckets,
    /**
     * Rolled up from the per-reading sources, and it distinguishes three
     * states rather than two. 'mixed' is the one that matters: it means some
     * readings are fleet-wide and some are this process only, so the numbers
     * in this response cannot be compared with each other. Collapsing that
     * into 'memory' would understate it, and into 'redis' would be a lie of
     * exactly the kind this field exists to prevent.
     */
    source: ((): 'redis' | 'memory' | 'mixed' => {
      const all = [cuSource, ...Object.values(buckets).map((b) => (b as { source: string }).source)]
      if (all.every((s) => s === 'redis')) return 'redis'
      if (all.every((s) => s === 'memory')) return 'memory'
      return 'mixed'
    })(),
    monthlyCu: {
      month: monthKey(),
      used: cuUsed,
      max: cuMax,
      pctUsed: cuMax > 0 ? Math.round((cuUsed / cuMax) * 1000) / 10 : null,
      limited: cuLimited,
      source: cuSource,
      /**
       * ⚠ SCOPE: this ceiling is PER LEDGER, not per Moralis account.
       *
       * BNB's web + indexer share one Redis and therefore one ledger. ETH has
       * no Redis at all, so each ETH process counts in its own memory. Four
       * processes across two chains ⇒ a 2,000,000 ceiling permits up to ~6M CU
       * against a single Moralis account, because nothing joins the ledgers.
       *
       * This is a real limit of the fix, not an oversight: a true account-wide
       * ceiling needs shared state that ETH does not have. Provisioning Redis
       * for ETH (Track C1) is what closes it, and would also fix the same blind
       * spot in the rate limiter and the KV cache. Until then, size the ceiling
       * with the multiplier in mind.
       */
      scope: 'per-ledger',
      /** Costs are estimates until confirmed in the Moralis console. */
      estimated: true,
    },
    limited: anyLimited,
  }
}

type Acquired = { ok: true; headers: Record<string, string> } | { ok: false; reason: ProviderFailReason }

/**
 * Same gate as the old getAuthHeaders, but the caller learns WHY it failed:
 * 1. Set MORALIS_DISABLED=true to kill all calls instantly (emergency off)
 * 2. Redis-backed response cache (off-heap, shared across instances)
 * 3. Redis-backed PER-BUCKET rate limiter (history / holders / assets, fleet-wide)
 */
async function acquire(bucket: MoralisBucket, cuCost: number): Promise<Acquired> {
  if (process.env.MORALIS_DISABLED === 'true') return { ok: false, reason: 'disabled' }
  const key = process.env.MORALIS_API_KEY
  if (!key) return { ok: false, reason: 'not_configured' }
  // A monthly-ceiling stop reports 'rate_limited' deliberately: every caller
  // already degrades that to the local-index view, which is exactly the right
  // behavior when the budget is gone. A new reason would need an exhaustive
  // sweep of four Lazy components for no user-visible difference.
  if (await isRateLimited(bucket, cuCost)) return { ok: false, reason: 'rate_limited' }
  return { ok: true, headers: { 'X-API-Key': key, 'Accept': 'application/json' } }
}

const fail = (reason: ProviderFailReason): { ok: false; reason: ProviderFailReason } => ({ ok: false, reason })

type RawOwner = {
  owner_address: string
  balance: string | null
  balance_formatted?: string | null
  usd_value?: string | null
  is_contract?: boolean
  percentage_relative_to_total_supply?: number | string | null
  owner_address_label?: string | null
}

/** Map Moralis /erc20/{addr}/owners rows → ProviderHolder[]. Pure — keep body identical to the .mjs. */
export function mapMoralisOwners(items: RawOwner[]): TokenHoldersPage['holders'] {
  return items
    .filter((r) => r.owner_address && r.balance && r.balance !== '0')
    .map((r) => ({
      address: r.owner_address.toLowerCase(),
      balance: String(r.balance),
      balanceFormatted: r.balance_formatted ?? null,
      usdValue: r.usd_value ?? null,
      isContract: !!r.is_contract,
      percentage: r.percentage_relative_to_total_supply != null
        ? String(r.percentage_relative_to_total_supply)
        : null,
      label: r.owner_address_label ?? null,
    }))
}

export function createMoralisAdapter(
  cfg: DataProviderConfig,
  ctx?: { currency?: string },
): ProviderAdapter {
  const CHAIN = cfg.moralisChain
  const CURRENCY = ctx?.currency ?? ''
  /**
   * Cache-key namespace. Every provider cache key MUST carry this prefix.
   *
   * Without it, keys were bare (`history:0xabc:`) while `kvGet`/`kvSet` pass the
   * key straight to Redis. Two hosts sharing one Redis would then collide: from
   * A4b-2 the indexer resolves its own adapter against the SAME `REDIS_URL` as
   * the web (`apps/indexer/src/queue.ts`), and it passes no `currency` ctx —
   * so whichever host wrote first would decide the other's rendered summary
   * (`"1.5 BNB transfer"` vs `"1.5 transfer"`, see summarize* below).
   *
   * `v2` also retires pre-`logIndex` cached transfer pages, whose JSON
   * deserializes with `logIndex === undefined` and would otherwise be trusted
   * as a well-formed TokenTransfersPage for the whole TTL.
   */
  const NS = `moralis:v2:${CHAIN}:${CURRENCY}`
  return {
    kind: 'moralis',

    /**
     * Wallet transaction history. Also returns total tx count from the response
     * so no separate stats call is needed. Cost: ~25 CU.
     */
    async getAddressHistory(address: string, cursor?: string): Promise<ProviderResult<AddressHistoryPage>> {
      const cacheKey = `${NS}:history:${address}:${cursor ?? ''}`
      const cached = await cacheGetJson<AddressHistoryPage>(cacheKey)
      if (cached !== undefined) {
        // null = cached negative (a recent failed upstream attempt)
        return cached === null ? fail('upstream_error') : { ok: true, data: cached }
      }
      const auth = await acquire('history', CU_COST.addressHistory)
      if (!auth.ok) return auth
      try {
        const url = new URL(`${BASE}/wallets/${address}/history`)
        url.searchParams.set('chain', CHAIN)
        url.searchParams.set('limit', '25')  // match PAGE_SIZE for full page of results
        url.searchParams.set('include_internal_transactions', '0')
        if (cursor) url.searchParams.set('cursor', cursor)

        const res = await fetch(url.toString(), {
          headers: auth.headers,
          next: { revalidate: 300 },
          signal: AbortSignal.timeout(10000),
        } as RequestInit)
        if (!res.ok) { await cacheSetNull(cacheKey); return fail('upstream_error') }

        const data = (await res.json()) as {
          result: Array<{
            hash: string
            block_number: string
            block_timestamp: string
            from_address: string
            to_address: string | null
            value: string
            gas_price: string
            receipt_gas_used: string
            category: string
            summary: string
            possible_spam: boolean
            erc20_transfers?: Array<{
              from_address: string
              to_address: string
              contract_address: string
              token_name: string
              token_symbol: string
              token_decimals: string
              value: string
              value_formatted: string
              direction: string
            }>
          }>
          cursor: string | null
          total?: number  // Moralis returns total count in history response
        }

        const histResult: AddressHistoryPage = {
          txs: data.result.map(t => ({
            hash: t.hash,
            blockNumber: t.block_number,
            blockTimestamp: t.block_timestamp,
            fromAddress: t.from_address,
            toAddress: t.to_address,
            value: t.value,
            gasPrice: t.gas_price,
            gasUsed: t.receipt_gas_used,
            category: t.category,
            summary: summarizeMoralisHistory(t, CURRENCY),
            possibleSpam: t.possible_spam,
            erc20Transfers: (t.erc20_transfers ?? []).map(e => ({
              fromAddress: e.from_address,
              toAddress: e.to_address,
              tokenAddress: e.contract_address,
              tokenName: e.token_name,
              tokenSymbol: e.token_symbol,
              tokenDecimals: e.token_decimals,
              value: e.value,
              valueFormatted: e.value_formatted,
              direction: e.direction,
            })),
          })),
          cursor: data.cursor ?? null,
          // /wallets/{addr}/history is cursor-paginated and returns no `total`; don't pass off the
          // current page size as the grand total (that showed "25" for wallets with hundreds of txs).
          totalTxs: data.total ?? 0,
        }
        await cacheSetJson(cacheKey, histResult)
        return { ok: true, data: histResult }
      } catch {
        return fail('upstream_error')
      }
    },

    async getAddressTokenBalances(address: string): Promise<ProviderResult<ProviderTokenBalance[]>> {
      const cacheKey = `${NS}:balances:${address}`
      const cached = await cacheGetJson<ProviderTokenBalance[]>(cacheKey)
      if (cached !== undefined) {
        return cached === null ? fail('upstream_error') : { ok: true, data: cached }
      }
      const auth = await acquire('assets', CU_COST.addressBalances)
      if (!auth.ok) return auth
      try {
        const res = await fetch(
          `${BASE}/${address}/erc20?chain=${CHAIN}&limit=20&exclude_spam=true`,
          { headers: auth.headers, next: { revalidate: 300 }, signal: AbortSignal.timeout(10000) } as RequestInit,
        )
        if (!res.ok) { await cacheSetNull(cacheKey); return fail('upstream_error') }
        const data = (await res.json()) as Array<{
          token_address: string
          symbol: string
          name: string
          logo: string | null
          decimals: number
          balance: string
          balance_formatted: string | null
          usd_value: string | null
        }>
        const balResult = data.map(t => ({
          tokenAddress: t.token_address,
          symbol: t.symbol,
          name: t.name,
          logo: t.logo,
          decimals: t.decimals,
          balance: t.balance ?? '0',
          balanceFormatted: t.balance_formatted ?? null,
          usdValue: t.usd_value,
        }))
        await cacheSetJson(cacheKey, balResult)
        return { ok: true, data: balResult }
      } catch {
        return fail('upstream_error')
      }
    },

    /**
     * ERC-20 token transfer history for an address. Cost: ~25 CU.
     */
    async getAddressTokenTransfers(address: string, cursor?: string): Promise<ProviderResult<TokenTransfersPage>> {
      const cacheKey = `${NS}:transfers:${address}:${cursor ?? ''}`
      const cached = await cacheGetJson<TokenTransfersPage>(cacheKey)
      if (cached !== undefined) {
        return cached === null ? fail('upstream_error') : { ok: true, data: cached }
      }
      const auth = await acquire('assets', CU_COST.addressTransfers)
      if (!auth.ok) return auth
      try {
        const url = new URL(`${BASE}/${address}/erc20/transfers`)
        url.searchParams.set('chain', CHAIN)
        url.searchParams.set('limit', '10')  // 10 instead of 25
        if (cursor) url.searchParams.set('cursor', cursor)

        const res = await fetch(url.toString(), {
          headers: auth.headers,
          next: { revalidate: 300 },
          signal: AbortSignal.timeout(10000),
        } as RequestInit)
        if (!res.ok) { await cacheSetNull(cacheKey); return fail('upstream_error') }

        const data = (await res.json()) as {
          result: Array<{
            transaction_hash: string
            log_index?: string | number    // A4b R3: stable per-tx identity for backfill upserts
            block_number: string
            block_timestamp: string
            from_address: string
            to_address: string
            address: string                 // contract address — v2.2 /erc20/transfers names it `address`
            token_name: string
            token_symbol: string
            token_decimals: string
            value: string
            value_decimal: string | null    // human-readable amount; there is no `value_formatted` here
          }>
          cursor: string | null
        }

        const txResult: TokenTransfersPage = {
          transfers: data.result.map(t => ({
            txHash: t.transaction_hash,
            // null unless upstream gives a genuine non-negative integer. A4b keys
            // backfilled transfers on (scope, tx_hash, log_index), so anything
            // else — absent, '', whitespace, negative, '1.5', 'abc' — MUST NOT
            // reach the PK; the worker skips null rows instead of colliding.
            // Normalized through Number so '007' and 7 agree on one key.
            logIndex: normalizeLogIndex(t.log_index),
            blockNumber: t.block_number,
            blockTimestamp: t.block_timestamp,
            fromAddress: t.from_address,
            toAddress: t.to_address,
            tokenAddress: t.address,
            tokenName: t.token_name,
            tokenSymbol: t.token_symbol,
            tokenDecimals: t.token_decimals,
            value: t.value,
            valueFormatted: t.value_decimal ?? '0',
          })),
          cursor: data.cursor ?? null,
        }
        await cacheSetJson(cacheKey, txResult)
        return { ok: true, data: txResult }
      } catch {
        return fail('upstream_error')
      }
    },

    async getAddressNfts(address: string): Promise<ProviderResult<ProviderNft[]>> {
      const cacheKey = `${NS}:nfts:${address}`
      const cached = await cacheGetJson<ProviderNft[]>(cacheKey)
      if (cached !== undefined) {
        return cached === null ? fail('upstream_error') : { ok: true, data: cached }
      }
      const auth = await acquire('assets', CU_COST.addressNfts)
      if (!auth.ok) return auth
      try {
        const res = await fetch(
          `${BASE}/${address}/nft?chain=${CHAIN}&limit=25&media_items=false`,
          { headers: auth.headers, next: { revalidate: 300 }, signal: AbortSignal.timeout(10000) } as RequestInit,
        )
        if (!res.ok) { await cacheSetNull(cacheKey); return fail('upstream_error') }
        const data = (await res.json()) as {
          result: Array<{
            token_address: string
            token_id: string
            name: string
            symbol: string
            metadata: string | null
            media?: { original_media_url?: string }
          }>
        }
        const result = data.result.map(n => {
          let metadata: Record<string, unknown> | null = null
          try { metadata = n.metadata ? JSON.parse(n.metadata) : null } catch { /* ignore */ }
          return {
            tokenAddress: n.token_address,
            tokenId: n.token_id,
            name: n.name,
            symbol: n.symbol,
            metadata,
            imageUrl: (metadata?.image as string) ?? n.media?.original_media_url ?? null,
          }
        })
        await cacheSetJson(cacheKey, result)
        return { ok: true, data: result }
      } catch {
        return fail('upstream_error')
      }
    },

    /**
     * Top holders of an ERC20 token, highest balance first (Moralis pre-sorts).
     * Cost: ~50 CU. Zero-holder results keep the old behavior byte-for-byte:
     * cached as a negative + reported as a failure, so callers fall back to
     * their local estimate exactly as they did under the null contract.
     */
    async getTokenHolders(tokenAddress: string): Promise<ProviderResult<TokenHoldersPage>> {
      const cacheKey = `${NS}:owners:${tokenAddress}`
      const cached = await cacheGetJson<TokenHoldersPage>(cacheKey)
      if (cached !== undefined) {
        return cached === null ? fail('upstream_error') : { ok: true, data: cached }
      }
      const auth = await acquire('holders', CU_COST.tokenHolders)
      if (!auth.ok) return auth
      try {
        const url = new URL(`${BASE}/erc20/${tokenAddress}/owners`)
        url.searchParams.set('chain', CHAIN)
        url.searchParams.set('limit', '25')
        const res = await fetch(url.toString(), {
          headers: auth.headers, next: { revalidate: 300 }, signal: AbortSignal.timeout(10000),
        } as RequestInit)
        if (!res.ok) { await cacheSetNull(cacheKey); return fail('upstream_error') }
        const data = (await res.json()) as { total_supply?: string | null; result?: RawOwner[] }
        const result: TokenHoldersPage = {
          holders: mapMoralisOwners(data.result ?? []),
          totalSupply: data.total_supply ?? null,
        }
        if (result.holders.length === 0) { await cacheSetNull(cacheKey); return fail('upstream_error') }
        await cacheSetJson(cacheKey, result)
        return { ok: true, data: result }
      } catch {
        return fail('upstream_error')
      }
    },

    /**
     * Total holder count of an ERC20 token (Moralis holder-stats). Cost: ~50 CU.
     */
    async getTokenHolderCount(tokenAddress: string): Promise<ProviderResult<number>> {
      const cacheKey = `${NS}:holdercount:${tokenAddress}`
      const cached = await cacheGetJson<number>(cacheKey)
      if (cached !== undefined) {
        return cached === null ? fail('upstream_error') : { ok: true, data: cached }
      }
      const auth = await acquire('holders', CU_COST.tokenHolderCount)
      if (!auth.ok) return auth
      try {
        const res = await fetch(`${BASE}/erc20/${tokenAddress}/holders?chain=${CHAIN}`, {
          headers: auth.headers, next: { revalidate: 300 }, signal: AbortSignal.timeout(10000),
        } as RequestInit)
        if (!res.ok) { await cacheSetNull(cacheKey); return fail('upstream_error') }
        const data = (await res.json()) as { totalHolders?: number }
        if (typeof data.totalHolders !== 'number') { await cacheSetNull(cacheKey); return fail('upstream_error') }
        await cacheSetJson(cacheKey, data.totalHolders)
        return { ok: true, data: data.totalHolders }
      } catch {
        return fail('upstream_error')
      }
    },
  }
}
