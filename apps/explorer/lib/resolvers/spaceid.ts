/**
 * Space ID name resolution for BNBScan.
 * Resolves BNB Chain addresses to .bnb names via the Space ID public API.
 * https://docs.space.id/developer-guide/web3-name-sdk/rest-api
 */

import { registerCache } from '../cache-registry'

const SPACE_ID_API = 'https://api.prd.space.id/v1'
const cache = new Map<string, { name: string | null; ts: number }>()
const TTL_MS = 5 * 60 * 1000     // reduced from 10 min to 5 min
const MAX_CACHE = 1000            // reduced from 5000 to limit memory

// Background cleanup — evict expired entries every 30s
const _spaceIdCleanup = setInterval(() => {
  const now = Date.now()
  for (const [k, v] of cache) {
    if (now - v.ts > TTL_MS) cache.delete(k)
  }
}, 30_000)
if (_spaceIdCleanup.unref) _spaceIdCleanup.unref()
registerCache('spaceid', () => cache.size)

export async function resolveSpaceId(address: string): Promise<string | null> {
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.name

  try {
    const res = await fetch(
      `${SPACE_ID_API}/getName?tld=bnb&address=${address}`,
      { signal: AbortSignal.timeout(5000), cache: 'no-store' },
    )
    if (!res.ok) {
      setCacheEntry(key, null)
      return null
    }
    const data = (await res.json()) as { code: number; name?: string }
    const name = data.code === 0 && data.name ? data.name : null
    setCacheEntry(key, name)
    return name
  } catch {
    setCacheEntry(key, null)
    return null
  }
}

function setCacheEntry(key: string, name: string | null): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(key, { name, ts: Date.now() })
}
