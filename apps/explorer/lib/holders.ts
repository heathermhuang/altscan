/**
 * Token holders — accurate top-holder list + real holder count from GoldRush (Covalent)
 * token_holders_v2, with graceful fallback to a clearly-labeled local net-flow estimate.
 *
 * WHY EXTERNAL: token_balances writes are hardcoded-disabled in the indexer
 * (block-processor.ts SKIP_HOLDER_BALANCES) to prevent a write-storm, so there is NO
 * maintained local holder table and tokens.holderCount is frozen. The local fallback
 * aggregates token_transfers, which under ~1-day retention is only a ~24h NET-FLOW window —
 * steady holders (exchanges) are MISSING — so it is surfaced as source:'local' and the page
 * labels it an estimate, not real balances.
 *
 * NOT MORALIS: the Moralis limiter is 10/hr fleet-wide, reserved for address-page history.
 *
 * Protections mirror moralis.ts: env key gate, kill switch (GOLDRUSH_DISABLED), Redis-backed
 * fleet-wide rate limiter (in-memory fallback), off-heap KV cache with negative caching,
 * hard timeout. All under the page's ISR(300s) + withTimeout.
 *
 * mapGoldrushHolders is kept byte-for-byte identical to verify-token-market-holders.mjs
 * section 4 — that case table is its contract.
 */
import { chainConfig } from './chain'
import { db } from './db'
import { sql } from 'drizzle-orm'
import { kvGet, kvSet, getRedis, isRedisUnavailable } from '@bnbscan/explorer-core'

const BASE = 'https://api.covalenthq.com/v1'
const HOLDER_PAGE_SIZE = 25

const NULL_SENTINEL = '__null__'
const CACHE_TTL = 30 * 60_000   // 30 min — holder sets change slowly; conserves credits.
const NULL_TTL = 10 * 60_000    // 10 min "GoldRush unavailable" backoff.

export type TokenHolder = { addr: string; balance: string }
export type HoldersResult = {
  holders: TokenHolder[]
  holderCount: number | null      // real total from GoldRush; null when unknown
  source: 'goldrush' | 'local'    // 'local' = net-flow estimate, NOT real balances
}

export const EMPTY_HOLDERS: HoldersResult = { holders: [], holderCount: null, source: 'local' }

// ── Fleet-wide rate limiter (Redis INCR/PEXPIRE; in-memory fallback). GoldRush free tier is
//    credit-based; cap conservatively. Mirrors moralis.ts. ──
const HOURLY_WINDOW = 3600_000
const HOURLY_MAX = 100
const DAILY_WINDOW = 86400_000
const DAILY_MAX = 1000
const RL_HOURLY_KEY = 'goldrush:rl:v1:hourly'
const RL_DAILY_KEY = 'goldrush:rl:v1:daily'
let hourlyCounter = 0, hourlyWindowStart = Date.now()
let dailyCounter = 0, dailyWindowStart = Date.now()

function isRateLimitedMemory(): boolean {
  const now = Date.now()
  if (now - hourlyWindowStart > HOURLY_WINDOW) { hourlyCounter = 0; hourlyWindowStart = now }
  if (now - dailyWindowStart > DAILY_WINDOW) { dailyCounter = 0; dailyWindowStart = now }
  if (dailyCounter >= DAILY_MAX) return true
  if (hourlyCounter >= HOURLY_MAX) return true
  hourlyCounter++; dailyCounter++
  return false
}

async function isRateLimited(): Promise<boolean> {
  const r = getRedis()
  if (r && !isRedisUnavailable()) {
    try {
      const hourly = await r.incr(RL_HOURLY_KEY)
      if (hourly === 1) await r.pexpire(RL_HOURLY_KEY, HOURLY_WINDOW)
      else if ((await r.pttl(RL_HOURLY_KEY)) < 0) await r.pexpire(RL_HOURLY_KEY, HOURLY_WINDOW)
      if (hourly > HOURLY_MAX) return true
      const daily = await r.incr(RL_DAILY_KEY)
      if (daily === 1) await r.pexpire(RL_DAILY_KEY, DAILY_WINDOW)
      else if ((await r.pttl(RL_DAILY_KEY)) < 0) await r.pexpire(RL_DAILY_KEY, DAILY_WINDOW)
      if (daily > DAILY_MAX) return true
      return false
    } catch { /* Redis blip — fall through */ }
  }
  return isRateLimitedMemory()
}

/** Read-only limiter snapshot for /api/health (no INCR). Mirrors getMoralisLimiterState. */
export async function getGoldrushLimiterState(): Promise<Record<string, unknown>> {
  let hourly: number | null = null, daily: number | null = null
  const r = getRedis()
  if (r && !isRedisUnavailable()) {
    try {
      const [h, d] = await Promise.all([r.get(RL_HOURLY_KEY), r.get(RL_DAILY_KEY)])
      hourly = h ? Number(h) : 0
      daily = d ? Number(d) : 0
    } catch { /* unknown */ }
  }
  return {
    disabled: process.env.GOLDRUSH_DISABLED === 'true',
    keyPresent: !!process.env.GOLDRUSH_API_KEY,
    hourly, hourlyMax: HOURLY_MAX,
    daily, dailyMax: DAILY_MAX,
    limited: (hourly !== null && hourly >= HOURLY_MAX) || (daily !== null && daily >= DAILY_MAX),
  }
}

type GoldrushItem = { address: string; balance: string | null }

/** Map token_holders_v2 items → TokenHolder[]. Pure — keep body identical to the .mjs. */
export function mapGoldrushHolders(items: GoldrushItem[]): TokenHolder[] {
  return items
    .filter((it) => it.address && it.balance && it.balance !== '0')
    .map((it) => ({ addr: it.address.toLowerCase(), balance: String(it.balance) }))
}

async function fetchGoldrushHolders(addr: string): Promise<HoldersResult | null> {
  if (process.env.GOLDRUSH_DISABLED === 'true') return null
  const key = process.env.GOLDRUSH_API_KEY
  if (!key) return null
  if (await isRateLimited()) return null
  try {
    const url =
      `${BASE}/${chainConfig.goldrushChain}/tokens/${addr}/token_holders_v2/` +
      `?page-size=${HOLDER_PAGE_SIZE}&page-number=0`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      error?: boolean
      data?: {
        items?: GoldrushItem[]
        pagination?: { total_count?: number | null } | null
      } | null
    }
    const items = data.data?.items
    if (data.error || !items) return null
    const holders = mapGoldrushHolders(items)
    if (holders.length === 0) return null
    const total = data.data?.pagination?.total_count
    return {
      holders,
      holderCount: typeof total === 'number' && total > 0 ? total : null,
      source: 'goldrush',
    }
  } catch {
    return null
  }
}

/**
 * Local fallback: top net-receivers from token_transfers. Under ~1-day retention this is a
 * ~24h NET-FLOW window, NOT real balances — surfaced via source:'local' so the page labels
 * it an estimate. (Moved verbatim from the old in-page fetchTopHolders.)
 */
async function fetchLocalNetFlowHolders(tokenAddr: string): Promise<HoldersResult> {
  try {
    const result = await db.execute(sql`
      WITH inflows AS (
        SELECT to_address as addr, SUM(value::numeric) as total
        FROM token_transfers WHERE token_address = ${tokenAddr} GROUP BY 1
      ),
      outflows AS (
        SELECT from_address as addr, SUM(value::numeric) as total
        FROM token_transfers WHERE token_address = ${tokenAddr} GROUP BY 1
      )
      SELECT i.addr, (COALESCE(i.total, 0) - COALESCE(o.total, 0))::text as balance
      FROM inflows i
      LEFT JOIN outflows o ON i.addr = o.addr
      WHERE (COALESCE(i.total, 0) - COALESCE(o.total, 0)) > 0
      ORDER BY balance DESC
      LIMIT 10
    `)
    const holders = Array.from(result).map((row) => ({
      addr: String((row as Record<string, unknown>).addr),
      balance: String((row as Record<string, unknown>).balance),
    }))
    return { holders, holderCount: null, source: 'local' }
  } catch {
    return EMPTY_HOLDERS
  }
}

/** Orchestrator: accurate GoldRush holders when available, else the labeled local estimate. */
export async function getTokenHolders(addr: string): Promise<HoldersResult> {
  const cacheKey = `holders:v1:${chainConfig.key}:${addr}`
  const cached = await kvGet(cacheKey)
  if (cached && cached !== NULL_SENTINEL) {
    try { return JSON.parse(cached) as HoldersResult } catch { /* fall through */ }
  }
  if (cached !== NULL_SENTINEL) {
    const gr = await fetchGoldrushHolders(addr)
    if (gr) {
      await kvSet(cacheKey, JSON.stringify(gr), CACHE_TTL)
      return gr
    }
    // Back off GoldRush for NULL_TTL; the local fallback (DB) is cheap and recomputed fresh.
    await kvSet(cacheKey, NULL_SENTINEL, NULL_TTL)
  }
  return fetchLocalNetFlowHolders(addr)
}
