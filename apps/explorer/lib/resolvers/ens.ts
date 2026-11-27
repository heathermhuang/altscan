/**
 * ENS name resolution for EthScan.
 * Resolves Ethereum addresses to ENS names (.eth) and vice-versa.
 * Uses the ETH RPC provider — no separate API key needed.
 * Results are cached for 5 minutes to avoid hammering the provider.
 */
import { getWebProvider } from '../rpc'
import { createTtlCache } from '../ttl-cache'

// 5 min, 1,000 names: both were cut (from 10 min, 5,000) to limit memory.
const cache = createTtlCache<string | null>({ name: 'ens', max: 1000, ttlMs: 5 * 60 * 1000 })

export async function resolveEns(address: string): Promise<string | null> {
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  try {
    // Acquisition inside the race — it awaits a (bounded) settings lookup, and
    // outside the race that latency would add to the 5s budget rather than
    // count against it.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
    const name = await Promise.race([
      (async () => (await getWebProvider()).lookupAddress(address))(),
      timeout,
    ])
    cache.set(key, name)
    return name
  } catch {
    cache.set(key, null)
    return null
  }
}

