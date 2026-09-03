/**
 * Symbol + decimals for a token contract, for pages that cannot read the local
 * `tokens` table.
 *
 * A transaction outside the retention window is served from RPC, so its token
 * transfers are decoded from receipt logs and there may be no `tokens` row for
 * the contracts involved. Without metadata the amount column can only show a
 * raw base-unit integer — "4280000000" where the answer is "4,280 USDC".
 *
 * Token symbol and decimals are immutable in practice, so verdicts are cached
 * across requests. Failures are never cached: a transient RPC outage must not
 * pin "unknown" for the whole TTL.
 */
import { Contract } from 'ethers'
import { getWebProvider } from './rpc'
import { registerCache } from './cache-registry'

export type TokenMeta = { symbol: string | null; decimals: number | null }

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]

const TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 5_000
const cache = new Map<string, { meta: TokenMeta; expires: number }>()
registerCache('token-meta', () => cache.size)

function readCache(addr: string): TokenMeta | null {
  const hit = cache.get(addr)
  if (!hit) return null
  if (Date.now() > hit.expires) { cache.delete(addr); return null }
  return hit.meta
}

function writeCache(addr: string, meta: TokenMeta): void {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!)
  cache.set(addr, { meta, expires: Date.now() + TTL_MS })
}

/**
 * Resolve metadata for several tokens at once. Never throws and never rejects:
 * a token it cannot resolve is simply absent from the returned map, and the
 * caller falls back to showing the raw amount.
 */
export async function fetchTokenMetadata(addresses: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>()
  const misses: string[] = []

  for (const raw of new Set(addresses.map((a) => a.toLowerCase()))) {
    const hit = readCache(raw)
    if (hit) out.set(raw, hit)
    else misses.push(raw)
  }
  if (misses.length === 0) return out

  let provider
  try {
    provider = await getWebProvider()
  } catch {
    return out
  }

  await Promise.all(misses.map(async (addr) => {
    try {
      const c = new Contract(addr, ERC20_ABI, provider)
      const [symbol, decimals] = await Promise.all([
        c.symbol().catch(() => null),
        c.decimals().catch(() => null),
      ])
      // A contract that answers neither call is not a token we can describe;
      // don't cache that as a settled answer.
      if (symbol == null && decimals == null) return
      const meta: TokenMeta = {
        symbol: typeof symbol === 'string' && symbol.length > 0 && symbol.length <= 32 ? symbol : null,
        decimals: decimals == null ? null : Number(decimals),
      }
      if (meta.decimals != null && (!Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 36)) {
        meta.decimals = null
      }
      writeCache(addr, meta)
      out.set(addr, meta)
    } catch { /* unresolvable — caller degrades to the raw amount */ }
  }))

  return out
}
