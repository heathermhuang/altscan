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
 * across requests — including a revert, which is the contract's answer rather
 * than a failure to get one. Transport failures are never cached: a transient
 * RPC outage must not pin "unknown" for the whole TTL.
 */
import { Contract } from 'ethers'
import { swallow } from './observability'
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
 * A call that REVERTED is settled: the contract reverts the same way every time.
 * ethers reports that as CALL_EXCEPTION; a timeout, rate limit or 5xx carries
 * another code and must be asked again.
 */
function isRevert(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'CALL_EXCEPTION'
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
    if (!hit) misses.push(raw)
    // A cached "reverts on both" stays absent, like any token this cannot
    // resolve; it is just not asked again.
    else if (hit.symbol != null || hit.decimals != null) out.set(raw, hit)
  }
  if (misses.length === 0) return out

  let provider
  try {
    provider = await getWebProvider()
  } catch (e) {
    swallow('token/metadata', e)
    return out
  }

  await Promise.all(misses.map(async (addr) => {
    // Keep the first error. Both calls are caught individually so one missing
    // method still yields the other, but that also discarded the reason a token
    // failed to resolve — leaving a placeholder symbol on the page with nothing
    // in the logs to explain it.
    let firstErr: unknown = null
    // Any failure that is not a revert leaves this attempt unsettled, so nothing
    // from it is cached — not even the half that did answer.
    let transportFailed = false
    const failed = (e: unknown) => {
      firstErr ??= e
      if (!isRevert(e)) transportFailed = true
      return null
    }
    try {
      const c = new Contract(addr, ERC20_ABI, provider)
      const [symbol, decimals] = await Promise.all([
        c.symbol().catch(failed),
        c.decimals().catch(failed),
      ])
      if (symbol == null && decimals == null) {
        swallow('token/metadata', firstErr ?? new Error(`${addr}: no symbol() or decimals()`))
        // Both reverted: this contract has no metadata to give, on this visit or
        // any later one. Cache that, or every visit re-asks and re-logs it.
        if (!transportFailed) writeCache(addr, { symbol: null, decimals: null })
        return
      }
      const meta: TokenMeta = {
        symbol: typeof symbol === 'string' && symbol.length > 0 && symbol.length <= 32 ? symbol : null,
        decimals: decimals == null ? null : Number(decimals),
      }
      if (meta.decimals != null && (!Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 36)) {
        meta.decimals = null
      }
      if (!transportFailed) writeCache(addr, meta)
      out.set(addr, meta)
    } catch (e) { swallow('token/metadata', e) }  // caller degrades to the raw amount
  }))

  return out
}

/**
 * What the indexer persists when ITS OWN metadata fetch failed, rather than
 * leaving the row out — see the identical guard on the token detail page.
 */
export const PLACEHOLDER_SYMBOL = '???'

/**
 * Addresses that still need an on-chain metadata lookup.
 *
 * A row carrying the placeholder is a MISS, not an answer. Treating mere
 * presence as "named" meant a transfer whose token the indexer had failed to
 * identify rendered as `???` forever, with the default 18 decimals applied to
 * the amount — the on-chain resolution that exists to fix exactly that was
 * never reached, because the address looked already-resolved.
 */
export function addrsNeedingMetadata(
  addrs: readonly string[],
  known: ReadonlyMap<string, { symbol: string }>,
): string[] {
  return addrs.filter((a) => {
    const tok = known.get(a)
    return !tok || tok.symbol === PLACEHOLDER_SYMBOL
  })
}
