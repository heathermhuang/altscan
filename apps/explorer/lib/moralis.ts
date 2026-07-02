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
import { sanitizeSymbol } from './format'
import { registerCache } from './cache-registry'
import { kvGet, kvSet, getKvFallbackSize, getRedis, isRedisUnavailable } from '@altscan/explorer-core'

const BASE = 'https://deep-index.moralis.io/api/v2.2'
const CHAIN = chainConfig.moralisChain

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
 * Build a clean, human-readable summary for a Moralis history item.
 * Moralis's own `summary` field is garbled for swaps — e.g. it returns
 * "Swapped 0.134 WBNB and 0.134 BNB for 0.134 WBNB and 0.134 BNB" (same tokens
 * and amounts on both sides). We rebuild swaps from the structured
 * erc20_transfers and only fall back to Moralis's prose for simple cases.
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
}): string {
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
    return `${nativeVal.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${chainConfig.currency} transfer`
  }
  return humanizeCategory(t.category)
}

/**
 * Rate limiter — PER-FEATURE budgets so a spike/abuse in one feature can't starve the others.
 * Buckets:
 *   - history : getWalletHistory                                  (~25 CU/call)
 *   - holders : getTokenOwners + getTokenHolderCount              (~50 CU/call, 2 calls/token)
 *   - assets  : getTokenBalances + getNfts + getTokenTransfers    (~25 CU/call)
 * Caps are env-overridable; defaults sum to 1500/hr + 10000/day — the prior single-bucket total —
 * so total Moralis exposure is UNCHANGED (this only partitions it). A saturated bucket returns
 * null → the caller falls back to its local view, and the OTHER buckets keep serving.
 * Keyed in Redis so caps apply fleet-wide (in-memory fallback when Redis is down).
 */
export type MoralisBucket = 'history' | 'holders' | 'assets'

const HOURLY_WINDOW = 3600_000
const DAILY_WINDOW = 86400_000

function envInt(name: string, fallback: number): number {
  return parseInt(process.env[name] ?? String(fallback), 10) || fallback
}

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

// In-memory fallback — per bucket, used only when Redis is unavailable (e.g. EthScan has no Redis,
// or a Redis blip). Per-instance, so with numInstances > 1 the effective cap is N×; acceptable.
type MemCounter = { hourly: number; hourlyStart: number; daily: number; dailyStart: number }
const memCounters: Record<MoralisBucket, MemCounter> = {
  history: { hourly: 0, hourlyStart: Date.now(), daily: 0, dailyStart: Date.now() },
  holders: { hourly: 0, hourlyStart: Date.now(), daily: 0, dailyStart: Date.now() },
  assets:  { hourly: 0, hourlyStart: Date.now(), daily: 0, dailyStart: Date.now() },
}

function isRateLimitedMemory(bucket: MoralisBucket): boolean {
  const now = Date.now()
  const c = memCounters[bucket]
  const { hourlyMax, dailyMax } = BUCKET_CAPS[bucket]
  if (now - c.hourlyStart > HOURLY_WINDOW) { c.hourly = 0; c.hourlyStart = now }
  if (now - c.dailyStart > DAILY_WINDOW) { c.daily = 0; c.dailyStart = now }
  if (c.daily >= dailyMax) return true
  if (c.hourly >= hourlyMax) return true
  c.hourly++; c.daily++
  return false
}

/**
 * Redis-backed per-bucket limiter. INCR then, if over cap, DECR back so blocked retries don't keep
 * inflating the counter (the old code's INCR-before-check let a blocked feature climb to 3× its cap
 * and made the health readout lie). Always guarantees a TTL: set on first INCR, re-arm if PTTL<0.
 */
async function isRateLimited(bucket: MoralisBucket): Promise<boolean> {
  const r = getRedis()
  if (r && !isRedisUnavailable()) {
    try {
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
    } catch {
      // Redis blip — fall through to in-memory
    }
  }
  return isRateLimitedMemory(bucket)
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
 * Per-bucket snapshot for the admin /api/health endpoint. Read-only (plain GETs, no INCR) so it
 * never consumes budget. Shows WHICH feature saturated — the visibility that turned every prior
 * limiter incident from a multi-hour guess into a one-line diagnosis.
 */
export async function getMoralisLimiterState(): Promise<Record<string, unknown>> {
  const buckets: Record<string, unknown> = {}
  let anyLimited = false
  const r = getRedis()
  for (const bucket of ['history', 'holders', 'assets'] as MoralisBucket[]) {
    let hourly: number | null = null
    let daily: number | null = null
    if (r && !isRedisUnavailable()) {
      try {
        const { hourly: hKey, daily: dKey } = bucketKeys(bucket)
        const [h, d] = await Promise.all([r.get(hKey), r.get(dKey)])
        hourly = h ? Number(h) : 0
        daily = d ? Number(d) : 0
      } catch { /* Redis blip — report unknown */ }
    }
    const state = buildBucketState(hourly, daily, BUCKET_CAPS[bucket])
    if (state.limited) anyLimited = true
    buckets[bucket] = state
  }
  return {
    disabled: process.env.MORALIS_DISABLED === 'true',
    keyPresent: !!process.env.MORALIS_API_KEY,
    buckets,
    limited: anyLimited,
  }
}

/** Known bot user agents — skip Moralis entirely for these. Includes the
 *  user-triggered AI fetchers (ChatGPT-User/Perplexity-User/Claude-User) that
 *  robots.txt now welcomes but whose UAs lack a "bot" substring: they get the
 *  local-index view like every other bot and never spend Moralis CU. */
const BOT_PATTERNS = /bot|crawl|spider|slurp|baiduspider|yandex|sogou|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|chatgpt-user|perplexity-user|claude-user/i

async function getAuthHeaders(bucket: MoralisBucket): Promise<Record<string, string> | null> {
  // Moralis is enabled with strict protections:
  // 1. Redis-backed response cache (off-heap, shared across instances)
  // 2. Redis-backed PER-BUCKET rate limiter (history / holders / assets, fleet-wide)
  // 3. Bot detection (address + token pages skip Moralis for bots)
  // Set MORALIS_DISABLED=true to kill all calls instantly
  if (process.env.MORALIS_DISABLED === 'true') return null

  const key = process.env.MORALIS_API_KEY
  if (!key) return null
  if (await isRateLimited(bucket)) return null
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

  const h = await getAuthHeaders('history')
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
        summary: summarizeMoralisHistory(t),
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
  const h = await getAuthHeaders('assets')
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

  const h = await getAuthHeaders('assets')
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

  const h = await getAuthHeaders('assets')
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

export type MoralisHolder = {
  address: string
  balance: string
  balanceFormatted: string | null
  usdValue: string | null
  isContract: boolean
  percentage: string | null   // percentage_relative_to_total_supply
  label: string | null
}

type RawOwner = {
  owner_address: string
  balance: string | null
  balance_formatted?: string | null
  usd_value?: string | null
  is_contract?: boolean
  percentage_relative_to_total_supply?: number | string | null
  owner_address_label?: string | null
}

/** Map Moralis /erc20/{addr}/owners rows → MoralisHolder[]. Pure — keep body identical to the .mjs. */
export function mapMoralisOwners(items: RawOwner[]): MoralisHolder[] {
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

/**
 * Get the top holders of an ERC20 token, highest balance first (Moralis pre-sorts).
 * Cost: ~50 CU. Cached + rate-limited + kill-switchable via the shared infra above.
 */
export async function getTokenOwners(
  address: string,
): Promise<{ holders: MoralisHolder[]; totalSupply: string | null } | null> {
  const cacheKey = `owners:${address}`
  const cached = await cacheGetJson<{ holders: MoralisHolder[]; totalSupply: string | null }>(cacheKey)
  if (cached !== undefined) return cached
  const h = await getAuthHeaders('holders')
  if (!h) return null
  try {
    const url = new URL(`${BASE}/erc20/${address}/owners`)
    url.searchParams.set('chain', CHAIN)
    url.searchParams.set('limit', '25')
    const res = await fetch(url.toString(), {
      headers: h, next: { revalidate: 300 }, signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) { await cacheSetNull(cacheKey); return null }
    const data = (await res.json()) as { total_supply?: string | null; result?: RawOwner[] }
    const result = {
      holders: mapMoralisOwners(data.result ?? []),
      totalSupply: data.total_supply ?? null,
    }
    if (result.holders.length === 0) { await cacheSetNull(cacheKey); return null }
    await cacheSetJson(cacheKey, result)
    return result
  } catch {
    return null
  }
}

/**
 * Get the total holder count of an ERC20 token (Moralis holder-stats).
 * Cost: ~50 CU. Cached. Best-effort — null when unavailable.
 */
export async function getTokenHolderCount(address: string): Promise<number | null> {
  const cacheKey = `holdercount:${address}`
  const cached = await cacheGetJson<number>(cacheKey)
  if (cached !== undefined) return cached
  const h = await getAuthHeaders('holders')
  if (!h) return null
  try {
    const res = await fetch(`${BASE}/erc20/${address}/holders?chain=${CHAIN}`, {
      headers: h, next: { revalidate: 300 }, signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) { await cacheSetNull(cacheKey); return null }
    const data = (await res.json()) as { totalHolders?: number }
    if (typeof data.totalHolders !== 'number') { await cacheSetNull(cacheKey); return null }
    await cacheSetJson(cacheKey, data.totalHolders)
    return data.totalHolders
  } catch {
    return null
  }
}
