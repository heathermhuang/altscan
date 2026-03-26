/**
 * Moralis API client for BNBScan.
 * Provides historical wallet transaction data beyond what the local indexer has.
 * Chain: BSC (chain = '0x38')
 *
 * CU BUDGET — Free tier: 40,000 CU/day
 * Strategy:
 *   - Long cache TTLs (1hr history, 4hr holdings/NFTs) to avoid re-fetches
 *   - Small page sizes (limit=10) — enough to show useful data, minimizes CU
 *   - No separate getWalletStats call — derive tx count from history response
 *   - exclude_spam=true on token endpoints to skip noise
 *   - Only fetch for the active tab, never prefetch other tabs
 */

const BASE = 'https://deep-index.moralis.io/api/v2.2'
const CHAIN = '0x38' // BSC mainnet

// Cache strategy: in-memory LRU cache (survives across requests, NOT invalidated by deploys).
// Each unique address costs CU exactly ONCE until the server process restarts.
// No background re-fetches. No bot calls. Pure on-demand.
const memCache = new Map<string, { data: unknown; ts: number }>()
const MEM_CACHE_TTL = 4 * 3600_000 // 4 hours — then re-fetch if a real user visits
const MEM_CACHE_MAX = 500          // max cached addresses — LRU eviction

function getCached<T>(key: string): T | undefined {
  const entry = memCache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.ts > MEM_CACHE_TTL) {
    memCache.delete(key)
    return undefined
  }
  return entry.data as T
}

function setCache(key: string, data: unknown): void {
  // Simple LRU: if at capacity, delete oldest entry
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value
    if (oldest) memCache.delete(oldest)
  }
  memCache.set(key, { data, ts: Date.now() })
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
 * Rate limiter — hard cap on Moralis calls per hour.
 * Prevents bot traffic from draining the monthly CU budget.
 * 2M CU/month ÷ 30 days ÷ 24 hours = ~2,778 CU/hour budget.
 * At ~25 CU per call, that's ~111 calls/hour.
 * We cap at 100/hour to leave headroom.
 */
const RATE_LIMIT_WINDOW = 3600_000 // 1 hour in ms
const RATE_LIMIT_MAX = 30          // max 30 Moralis API calls per hour (~750 CU/hr = 540K CU/month)
let rateLimitCounter = 0
let rateLimitWindowStart = Date.now()

function isRateLimited(): boolean {
  const now = Date.now()
  if (now - rateLimitWindowStart > RATE_LIMIT_WINDOW) {
    // Reset window
    rateLimitCounter = 0
    rateLimitWindowStart = now
  }
  if (rateLimitCounter >= RATE_LIMIT_MAX) {
    return true
  }
  rateLimitCounter++
  return false
}

/** Known bot user agents — skip Moralis entirely for these */
const BOT_PATTERNS = /bot|crawl|spider|slurp|baiduspider|yandex|sogou|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot/i

function headers(): Record<string, string> | null {
  // Moralis is enabled with strict protections:
  // 1. In-memory cache (4hr per address)
  // 2. Rate limiter (100 calls/hr hard cap)
  // 3. Bot detection (address page skips Moralis for bots)
  // Set MORALIS_DISABLED=true to kill all calls instantly
  if (process.env.MORALIS_DISABLED === 'true') return null

  const key = process.env.MORALIS_API_KEY
  if (!key) return null
  if (isRateLimited()) return null
  return { 'X-API-Key': key, 'Accept': 'application/json' }
}

// ⚠️  TEMPORARY: Set MORALIS_DISABLED=true in Render dashboard to stop CU drain immediately.
// The in-memory cache + bot blocking above will prevent future drain once this deploy lands.

/**
 * Check if the current request is from a bot. Call from address page
 * before triggering any Moralis calls.
 */
export function isBotRequest(userAgent: string | null): boolean {
  if (!userAgent) return true  // no UA = likely bot
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
  const cached = getCached<{ txs: MoralisTx[]; cursor: string | null; totalTxs: number }>(cacheKey)
  if (cached) return cached

  const h = headers()
  if (!h) return null

  try {
    const url = new URL(`${BASE}/wallets/${address}/history`)
    url.searchParams.set('chain', CHAIN)
    url.searchParams.set('limit', '10')  // 10 is enough for display, saves CU vs 25
    url.searchParams.set('include_internal_transactions', '0')
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString(), {
      headers: h,
      cache: 'no-store',
    })
    if (!res.ok) return null

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
      totalTxs: data.total ?? data.result.length,
    }
    setCache(cacheKey, histResult)
    return histResult
  } catch {
    return null
  }
}

export async function getTokenBalances(address: string): Promise<MoralisToken[]> {
  const cacheKey = `balances:${address}`
  const cached = getCached<MoralisToken[]>(cacheKey)
  if (cached) return cached
  const h = headers()
  if (!h) return []

  try {
    const res = await fetch(
      `${BASE}/${address}/erc20?chain=${CHAIN}&limit=20&exclude_spam=true`,
      { headers: h, cache: 'no-store' },
    )
    if (!res.ok) return []
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
    setCache(cacheKey, balResult)
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
  const cached = getCached<{ transfers: MoralisTokenTransfer[]; cursor: string | null }>(cacheKey)
  if (cached) return cached

  const h = headers()
  if (!h) return null

  try {
    const url = new URL(`${BASE}/wallets/${address}/erc20-transfers`)
    url.searchParams.set('chain', CHAIN)
    url.searchParams.set('limit', '10')  // 10 instead of 25
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString(), {
      headers: h,
      cache: 'no-store',
    })
    if (!res.ok) return null

    const data = (await res.json()) as {
      result: Array<{
        transaction_hash: string
        block_number: string
        block_timestamp: string
        from_address: string
        to_address: string
        contract_address: string
        token_name: string
        token_symbol: string
        token_decimals: string
        value: string
        value_formatted: string
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
        tokenAddress: t.contract_address,
        tokenName: t.token_name,
        tokenSymbol: t.token_symbol,
        tokenDecimals: t.token_decimals,
        value: t.value,
        valueFormatted: t.value_formatted,
      })),
      cursor: data.cursor ?? null,
    }
    setCache(cacheKey, txResult)
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
  const cached = getCached<MoralisNft[]>(cacheKey)
  if (cached) return cached

  const h = headers()
  if (!h) return []

  try {
    const res = await fetch(
      `${BASE}/${address}/nft?chain=${CHAIN}&limit=10&media_items=false&exclude_spam=true`,
      { headers: h, cache: 'no-store' },
    )
    if (!res.ok) return []
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
    setCache(cacheKey, result)
    return result
  } catch {
    return []
  }
}
