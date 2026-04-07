/**
 * ENS name resolution for EthScan.
 * Resolves Ethereum addresses to ENS names (.eth) and vice-versa.
 * Uses the ETH RPC provider — no separate API key needed.
 * Results are cached for 10 minutes to avoid hammering the provider.
 */
import { getProvider } from '../rpc'
import { registerCache } from '../cache-registry'

const cache = new Map<string, { name: string | null; ts: number }>()
const TTL_MS = 5 * 60 * 1000     // reduced from 10 min to 5 min
const MAX_CACHE = 1000            // reduced from 5000 to limit memory

// Background cleanup — evict expired entries every 30s
const _ensCleanup = setInterval(() => {
  const now = Date.now()
  for (const [k, v] of cache) {
    if (now - v.ts > TTL_MS) cache.delete(k)
  }
}, 30_000)
if (_ensCleanup.unref) _ensCleanup.unref()
registerCache('ens', () => cache.size)

function setCacheEntry(key: string, name: string | null): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(key, { name, ts: Date.now() })
}

export async function resolveEns(address: string): Promise<string | null> {
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.name

  try {
    const provider = getProvider()
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
    const name = await Promise.race([provider.lookupAddress(address), timeout])
    setCacheEntry(key, name)
    return name
  } catch {
    setCacheEntry(key, null)
    return null
  }
}

export async function resolveEnsToAddress(name: string): Promise<string | null> {
  try {
    const provider = getProvider()
    return await provider.resolveName(name)
  } catch {
    return null
  }
}
