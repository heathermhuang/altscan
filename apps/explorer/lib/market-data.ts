/**
 * Market-data client for the token page — DexScreener (price/volume/liquidity, no key)
 * enriched best-effort by CoinGecko (market cap + circulating supply, optional key).
 *
 * Both are external & best-effort: every failure path returns null so the market card
 * simply doesn't render (long-tail tokens with no market). Server-side only; off-heap KV
 * cache (shared via Redis) with negative caching, under the page's ISR(300s) + withTimeout.
 * Mirrors the keyless goplus.ts client; KV layer mirrors moralis.ts.
 *
 * The pure helpers (pickBestPair, buildMarketData) are kept byte-for-byte identical to
 * verify-token-market-holders.mjs section 3 — that case table is their contract.
 */
import { chainConfig } from './chain'
import { kvGet, kvSet } from '@altscan/explorer-core'

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex/tokens'
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3'

const NULL_SENTINEL = '__null__'
const CACHE_TTL = 5 * 60_000     // 5 min — matches page ISR; market data is volatile.
const NULL_TTL = 10 * 60_000     // 10 min for "no market" — cheap to re-confirm later.

export type TokenMarketData = {
  priceUsd: number | null
  priceChange24h: number | null   // percent, e.g. -3.2
  volume24h: number | null
  liquidityUsd: number | null
  fdv: number | null
  marketCap: number | null
  circulatingSupply: number | null
  dexUrl: string | null
  pairLabel: string | null        // e.g. "AAA/USDT · pancakeswap"
  source: 'dexscreener' | 'dexscreener+coingecko'
}

type DexPair = {
  chainId: string
  dexId: string
  url: string
  baseToken: { address: string; name?: string; symbol: string }
  quoteToken: { address?: string; name?: string; symbol: string }
  priceUsd?: string
  volume?: { h24?: number }
  priceChange?: { h24?: number }
  liquidity?: { usd?: number }
  fdv?: number
  marketCap?: number
}

type CoinGeckoMarket = { marketCap: number | null; circulatingSupply: number | null }

/**
 * From all DexScreener pairs for an address, keep only this-chain pairs where our token is
 * the BASE token (so priceUsd is OUR token's price), then pick the deepest-liquidity one.
 * Pure — keep body identical to verify-token-market-holders.mjs section 3.
 */
export function pickBestPair(pairs: DexPair[], tokenAddr: string, chainId: string): DexPair | null {
  const addr = tokenAddr.toLowerCase()
  const eligible = pairs.filter(
    (p) => p.chainId === chainId && p.baseToken?.address?.toLowerCase() === addr,
  )
  if (eligible.length === 0) return null
  return eligible.reduce((best, p) =>
    (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best,
  )
}

/**
 * Combine a DexScreener pair + optional CoinGecko enrichment into the card model.
 * Pure — keep body identical to the .mjs.
 */
export function buildMarketData(pair: DexPair, cg: CoinGeckoMarket | null): TokenMarketData {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
    return Number.isFinite(n) ? n : null
  }
  return {
    priceUsd: num(pair.priceUsd),
    priceChange24h: num(pair.priceChange?.h24),
    volume24h: num(pair.volume?.h24),
    liquidityUsd: num(pair.liquidity?.usd),
    fdv: num(pair.fdv),
    marketCap: cg?.marketCap ?? num(pair.marketCap),
    circulatingSupply: cg?.circulatingSupply ?? null,
    dexUrl: pair.url ?? null,
    pairLabel: `${pair.baseToken?.symbol}/${pair.quoteToken?.symbol} · ${pair.dexId}`,
    source: cg ? 'dexscreener+coingecko' : 'dexscreener',
  }
}

async function fetchDexScreener(addr: string): Promise<DexPair | null> {
  try {
    const res = await fetch(`${DEXSCREENER_BASE}/${addr}`, {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { pairs?: DexPair[] | null }
    return pickBestPair(data.pairs ?? [], addr, chainConfig.dexscreenerChain)
  } catch {
    return null
  }
}

async function fetchCoinGecko(addr: string): Promise<CoinGeckoMarket | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const key = process.env.COINGECKO_API_KEY
    if (key) headers['x-cg-demo-api-key'] = key
    const res = await fetch(
      `${COINGECKO_BASE}/coins/${chainConfig.coingeckoPlatform}/contract/${addr}`,
      { headers, signal: AbortSignal.timeout(5000), next: { revalidate: 300 } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      market_data?: { market_cap?: { usd?: number }; circulating_supply?: number }
    }
    const md = data.market_data
    if (!md) return null
    return {
      marketCap: md.market_cap?.usd ?? null,
      circulatingSupply: md.circulating_supply ?? null,
    }
  } catch {
    return null
  }
}

/** Top-level: cached, best-effort. null ⇒ the page hides the Market card. */
export async function getTokenMarketData(addr: string): Promise<TokenMarketData | null> {
  const cacheKey = `market:v1:${chainConfig.key}:${addr}`
  const cached = await kvGet(cacheKey)
  if (cached === NULL_SENTINEL) return null
  if (cached) {
    try { return JSON.parse(cached) as TokenMarketData } catch { /* fall through */ }
  }
  const pair = await fetchDexScreener(addr)
  if (!pair) {
    await kvSet(cacheKey, NULL_SENTINEL, NULL_TTL)
    return null
  }
  const cg = await fetchCoinGecko(addr) // best-effort enrichment; null is fine
  const result = buildMarketData(pair, cg)
  await kvSet(cacheKey, JSON.stringify(result), CACHE_TTL)
  return result
}
