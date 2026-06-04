/**
 * Moralis API client — chain-aware.
 * Provides historical wallet transaction data beyond what the local indexer has.
 *
 * CU BUDGET — Free tier: 40,000 CU/day
 * Strategy:
 *   - Strict rate limits: 10 calls/hour, 200 calls/day (~5K CU/day, 12.5% of budget)
 *   - Long cache TTLs (4hr per address) to avoid re-fetches
 *   - Small page sizes (limit=10-25) — enough to show useful data, minimizes CU
 *   - No separate getWalletStats call — derive tx count from history response
 *   - exclude_spam=true on token endpoints to skip noise
 *   - Only fetch for the active tab, never prefetch other tabs
 *   - Bot detection skips Moralis entirely for crawlers
 */
import { chainConfig } from './chain'
import { registerCache } from './cache-registry'
import { kvGet, kvSet, getKvFallbackSize, getRedis, isRedisUnavailable } from '@bnbscan/explorer-core'

const BASE = 'https://deep-index.moralis.io/api/v2.2'
const CHAIN = chainConfig.moralisChain

// Cache strategy: responses live in Redis (shared across instances, OFF the Node heap),
// with a small bounded in-memory fallback when Redis is absent (see @bnbscan/explorer-core
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

// Report the in-memory fallback size to the health endpoint / memory monitor. This is 0
// whenever Redis is serving the cache (BNBScan), and bounded otherwise (EthScan).
registerCache('moralis', getKvFallbackSize)

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

export type MoralisTx = {
  hash: string
  blockNumber: string
  blockTimestamp: string
  fromAddress: string
  toAddress: string | null
  value: string          // in wei
  gasPrice: string
  gasUsed: string
  category: string       // e.g. 'token transfer', 'contract interaction', 'send'
  summary: string        // human-readable e.g. "Swapped 1.5 BNB for 250 CAKE"
  possibleSpam: boolean
  erc20Transfers: MoralisErc20Transfer[]
}

export type MoralisToken = {
  tokenAddress: string
  symbol: string
  name: string
  logo: string | null
  decimals: number
  balance: string
  balanceFormatted: string | null
  usdValue: string | null
}

export type MoralisErc20Transfer = {
  fromAddress: string
  toAddress: string
  tokenAddress: string
  tokenName: string
  tokenSymbol: string
  tokenDecimals: string
  value: string
  valueFormatted: string
  direction: string
}

export type MoralisNft = {
  tokenAddress: string
  tokenId: string
  name: string
  symbol: string
  metadata: Record<string, unknown> | null
  imageUrl: string | null
}

/**
 * Rate limiter — hard cap on Moralis calls per hour AND per day.
 * Free tier: 40,000 CU/day. Each call costs ~25 CU.
 * Daily budget: 40,000 CU / 25 CU = 1,600 calls/day max.
 * We cap conservatively: 10 calls/hour, 200 calls/day (~5,000 CU/day).
 * Leaves 87% of the daily budget as headroom.
 */
const HOURLY_WINDOW = 3600_000
const HOURLY_MAX = 200             // fleet-wide burst guard. 10 (orig) and 120 (v2) both got
                                   // re-exhausted by real traffic — each idle-address view burns
                                   // 1–2 calls. The daily cap below is the real budget guard.
const DAILY_WINDOW = 86400_000
const DAILY_MAX = 1200             // ~30,000 CU/day at ~25 CU/call = ~75% of the 40K free budget,
                                   // leaving headroom for pricier calls. This is a hard ceiling: if
                                   // real demand exceeds it, idle-wallet pages dead-end until the
                                   // daily window rolls — the durable fix is paid Moralis or longer
                                   // local retention (see getMoralisLimiterState in /api/health).
// v6 keys: bumped together with lazy-loading transfers/holdings/nfts tabs. All three tabs now
// defer Moralis fetches to the client (HTML scrapers / bots with no JS never trigger them).
// v5 was exhausted by the residential botnet hitting ?tab=transfers/holdings/nfts SSR paths.
const RL_HOURLY_KEY = 'moralis:rl:v6:hourly'
const RL_DAILY_KEY = 'moralis:rl:v6:daily'
let hourlyCounter = 0
let hourlyWindowStart = Date.now()
let dailyCounter = 0
let dailyWindowStart = Date.now()

// In-memory fallback — used only when Redis is unavailable. Per-instance, so with
// numInstances > 1 the effective cap is N×; acceptable as a degraded fallback.
function isRateLimitedMemory(): boolean {
  const now = Date.now()
  // Reset hourly window
  if (now - hourlyWindowStart > HOURLY_WINDOW) {
    hourlyCounter = 0
    hourlyWindowStart = now
  }
  // Reset daily window
  if (now - dailyWindowStart > DAILY_WINDOW) {
    dailyCounter = 0
    dailyWindowStart = now
  }
  if (dailyCounter >= DAILY_MAX) {
    return true
  }
  if (hourlyCounter >= HOURLY_MAX) {
    return true
  }
  hourlyCounter++
  dailyCounter++
  return false
}

/**
 * Redis-backed limiter: counters are shared across instances via INCR/PEXPIRE, so the
 * hourly/daily CU caps apply FLEET-WIDE. The previous in-process counters allowed N× the
 * intended Moralis spend with numInstances > 1, and reset on every deploy. Falls back to
 * the in-memory limiter when Redis is unavailable.
 */
async function isRateLimited(): Promise<boolean> {
  const r = getRedis()
  if (r && !isRedisUnavailable()) {
    try {
      const hourly = await r.incr(RL_HOURLY_KEY)
      // Always guarantee a TTL: set it on the first INCR, and re-arm if the key ever lost its
      // expiry (PTTL < 0 means -1 no-expiry / -2 no-key). Without this a counter could stick
      // above the cap forever and silently disable Moralis for everyone.
      if (hourly === 1) await r.pexpire(RL_HOURLY_KEY, HOURLY_WINDOW)
      else if ((await r.pttl(RL_HOURLY_KEY)) < 0) await r.pexpire(RL_HOURLY_KEY, HOURLY_WINDOW)
      if (hourly > HOURLY_MAX) return true
      const daily = await r.incr(RL_DAILY_KEY)
      if (daily === 1) await r.pexpire(RL_DAILY_KEY, DAILY_WINDOW)
      else if ((await r.pttl(RL_DAILY_KEY)) < 0) await r.pexpire(RL_DAILY_KEY, DAILY_WINDOW)
      if (daily > DAILY_MAX) return true
      return false
    } catch {
      // Redis blip — fall through to in-memory
    }
  }
  return isRateLimitedMemory()
}

/**
 * Snapshot of the Moralis limiter for the admin /api/health endpoint. Read-only (plain GETs,
 * no INCR) so calling it never consumes budget. This is the visibility that was missing when the
 * limiter silently disabled Moralis fleet-wide: now `limited: true` plus the counter vs. cap makes
 * the cause obvious instead of guessable.
 */
export async function getMoralisLimiterState(): Promise<Record<string, unknown>> {
  let hourly: number | null = null
  let daily: number | null = null
  const r = getRedis()
  if (r && !isRedisUnavailable()) {
    try {
      const [h, d] = await Promise.all([r.get(RL_HOURLY_KEY), r.get(RL_DAILY_KEY)])
      hourly = h ? Number(h) : 0
      daily = d ? Number(d) : 0
    } catch { /* Redis blip — report unknown */ }
  }
  return {
    disabled: process.env.MORALIS_DISABLED === 'true',
    keyPresent: !!process.env.MORALIS_API_KEY,
    hourly, hourlyMax: HOURLY_MAX,
    daily, dailyMax: DAILY_MAX,
    limited: (hourly !== null && hourly >= HOURLY_MAX) || (daily !== null && daily >= DAILY_MAX),
  }
}

/** Known bot user agents — skip Moralis entirely for these */
const BOT_PATTERNS = /bot|crawl|spider|slurp|baiduspider|yandex|sogou|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot/i

async function getAuthHeaders(): Promise<Record<string, string> | null> {
  // Moralis is enabled with strict protections:
  // 1. Redis-backed response cache (off-heap, shared across instances)
  // 2. Redis-backed rate limiter (10 calls/hr + 200 calls/day, fleet-wide)
  // 3. Bot detection (address page skips Moralis for bots)
  // Set MORALIS_DISABLED=true to kill all calls instantly
  if (process.env.MORALIS_DISABLED === 'true') return null

  const key = process.env.MORALIS_API_KEY
  if (!key) return null
  if (await isRateLimited()) return null
  return { 'X-API-Key': key, 'Accept': 'application/json' }
}

// KILL SWITCH: Set MORALIS_DISABLED=true in the Render dashboard to stop all Moralis calls
// instantly (e.g. CU drain or an upstream incident). With the Redis-backed cache + fleet-wide
// rate limiter above, leaving Moralis enabled is the normal state — this is the emergency off.

/**
 * Check if the current request is from a bot. Call from address page
 * before triggering any Moralis calls.
 */
export function isBotRequest(userAgent: string | null): boolean {
  if (!userAgent) return false  // no UA in SSR context = allow (rate limiter still protects)
  return BOT_PATTERNS.test(userAgent)
}

/**
 * Get wallet transaction history. Also returns total tx count in the response
 * so we don't need a separate getWalletStats call (saves ~10 CU per address).
 * Cost: ~25 CU
 */
export async function getWalletHistory(
  address: string,
  cursor?: string,
): Promise<{ txs: MoralisTx[]; cursor: string | null; totalTxs: number } | null> {
  const cacheKey = `history:${address}:${cursor ?? ''}`
  const cached = await cacheGetJson<{ txs: MoralisTx[]; cursor: string | null; totalTxs: number }>(cacheKey)
  if (cached !== undefined) return cached

  const h = await getAuthHeaders()
  if (!h) return null

  try {
    const url = new URL(`${BASE}/wallets/${address}/history`)
    url.searchParams.set('chain', CHAIN)
    url.searchParams.set('limit', '25')  // match PAGE_SIZE for full page of results
    url.searchParams.set('include_internal_transactions', '0')
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString(), {
      headers: h,
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) { await cacheSetNull(cacheKey); return null }

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

    const histResult = {
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
        summary: t.summary,
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
    return histResult
  } catch {
    return null
  }
}

export async function getTokenBalances(address: string): Promise<MoralisToken[]> {
  const cacheKey = `balances:${address}`
  const cached = await cacheGetJson<MoralisToken[]>(cacheKey)
  if (cached !== undefined) return cached ?? []
  const h = await getAuthHeaders()
  if (!h) return []

  try {
    const res = await fetch(
      `${BASE}/${address}/erc20?chain=${CHAIN}&limit=20&exclude_spam=true`,
      { headers: h, next: { revalidate: 300 }, signal: AbortSignal.timeout(10000) },
    )
    if (!res.ok) { await cacheSetNull(cacheKey); return [] }
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
    return balResult
  } catch {
    return []
  }
}

/**
 * @deprecated Use getWalletHistory().totalTxs instead — saves a separate API call (~10 CU)
 */
export async function getWalletStats(address: string): Promise<{ txCount: number } | null> {
  // Eliminated — tx count is now derived from getWalletHistory response
  return null
}

export type MoralisTokenTransfer = {
  txHash: string
  blockNumber: string
  blockTimestamp: string
  fromAddress: string
  toAddress: string
  tokenAddress: string
  tokenName: string
  tokenSymbol: string
  tokenDecimals: string
  value: string
  valueFormatted: string
}

/**
 * Get ERC-20 token transfer history for an address.
 * Cost: ~25 CU. Cached for 1 hour.
 */
export async function getTokenTransfers(
  address: string,
  cursor?: string,
): Promise<{ transfers: MoralisTokenTransfer[]; cursor: string | null } | null> {
  const cacheKey = `transfers:${address}:${cursor ?? ''}`
  const cached = await cacheGetJson<{ transfers: MoralisTokenTransfer[]; cursor: string | null }>(cacheKey)
  if (cached !== undefined) return cached

  const h = await getAuthHeaders()
  if (!h) return null

  try {
    const url = new URL(`${BASE}/${address}/erc20/transfers`)
    url.searchParams.set('chain', CHAIN)
    url.searchParams.set('limit', '10')  // 10 instead of 25
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString(), {
      headers: h,
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) { await cacheSetNull(cacheKey); return null }

    const data = (await res.json()) as {
      result: Array<{
        transaction_hash: string
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

    const txResult = {
      transfers: data.result.map(t => ({
        txHash: t.transaction_hash,
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
    return txResult
  } catch {
    return null
  }
}

/**
 * Get NFTs owned by an address.
 */
export async function getNfts(address: string): Promise<MoralisNft[]> {
  const cacheKey = `nfts:${address}`
  const cached = await cacheGetJson<MoralisNft[]>(cacheKey)
  if (cached !== undefined) return cached ?? []

  const h = await getAuthHeaders()
  if (!h) return []

  try {
    const res = await fetch(
      `${BASE}/${address}/nft?chain=${CHAIN}&limit=25&media_items=false`,
      { headers: h, next: { revalidate: 300 }, signal: AbortSignal.timeout(10000) },
    )
    if (!res.ok) { await cacheSetNull(cacheKey); return [] }
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
    return result
  } catch {
    return []
  }
}
