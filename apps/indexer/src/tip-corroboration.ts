import { readWithFailover, withTimeout } from './rpc-failover'
import { safeRpcError } from './provider'

/**
 * A MAX_LAG skip abandons every block up to `latest - 200` and moves the cursor and the
 * transfer watermark there, on the word of the one endpoint that answered the tip read.
 * One node reporting an inflated `eth_blockNumber` therefore abandoned real blocks and
 * pushed both past the chain. So before a skip, another endpoint must hold the block the
 * skip lands on, with the same hash as the reporting endpoint's.
 *
 * "Another endpoint" means another provider (registrable domain) when the list has one,
 * else another hostname. BNB's block endpoints are all Binance's today, and refusing
 * every skip there would bring back unbounded lag after an outage. Decided 2026-11-08.
 */

export type HeaderSource = { getBlock(height: number): Promise<{ hash: string | null } | null> }

/** The last two hostname labels. Two providers under one public suffix count as one: the safe side. */
export function providerDomain(url: string): string {
  const host = new URL(url).hostname.toLowerCase()
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host
  return host.split('.').slice(-2).join('.')
}

/** The endpoints whose answer counts as independent of `source`, and how independent they are. */
export function corroboratorsFor<P>(
  source: P,
  endpoints: readonly { provider: P; url: string }[],
): { providers: P[]; level: 'provider' | 'host' | 'none' } {
  const own = endpoints.find(e => e.provider === source)
  if (!own) return { providers: [], level: 'none' }
  const host = new URL(own.url).hostname.toLowerCase()
  const domain = providerDomain(own.url)
  const otherProvider = endpoints.filter(e => providerDomain(e.url) !== domain)
  if (otherProvider.length > 0) return { providers: otherProvider.map(e => e.provider), level: 'provider' }
  const otherHost = endpoints.filter(e => new URL(e.url).hostname.toLowerCase() !== host)
  if (otherHost.length > 0) return { providers: otherHost.map(e => e.provider), level: 'host' }
  return { providers: [], level: 'none' }
}

/** Null when `height` is corroborated; otherwise why the skip must not happen. Never throws. */
export async function corroborateTip<P extends HeaderSource>(
  source: P,
  height: number,
  corroborators: readonly P[],
  timeoutMs: number,
): Promise<string | null> {
  if (corroborators.length === 0) return 'no other block endpoint to ask'
  try {
    const [mine, theirs] = await Promise.all([
      withTimeout(source.getBlock(height), timeoutMs, `block ${height} header`),
      readWithFailover(corroborators, 0, p => p.getBlock(height), timeoutMs),
    ])
    if (!mine?.hash) return `the endpoint that reported the tip has no block ${height}`
    if (!theirs?.hash) return `no other endpoint has block ${height}`
    if (mine.hash.toLowerCase() !== theirs.hash.toLowerCase()) return `block ${height} differs between endpoints`
    return null
  } catch (err) {
    return `header read failed: ${safeRpcError(err)}`
  }
}
