/**
 * Space ID name resolution for BNBScan.
 * Resolves BNB Chain addresses to .bnb names via the Space ID public API.
 * https://docs.space.id/developer-guide/web3-name-sdk/rest-api
 */

import { createTtlCache } from '../ttl-cache'

const SPACE_ID_API = 'https://api.prd.space.id/v1'
// 5 min, 1,000 names: both were cut (from 10 min, 5,000) to limit memory.
const cache = createTtlCache<string | null>({ name: 'spaceid', max: 1000, ttlMs: 5 * 60 * 1000 })

export async function resolveSpaceId(address: string): Promise<string | null> {
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  try {
    const res = await fetch(
      `${SPACE_ID_API}/getName?tld=bnb&address=${address}`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 3600 } },
    )
    if (!res.ok) {
      cache.set(key, null)
      return null
    }
    const data = (await res.json()) as { code: number; name?: string }
    const name = data.code === 0 && data.name ? data.name : null
    cache.set(key, name)
    return name
  } catch {
    cache.set(key, null)
    return null
  }
}

