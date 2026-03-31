/**
 * Space ID name resolution for BNBScan.
 * Resolves BNB Chain addresses to .bnb names via the Space ID public API.
 * https://docs.space.id/developer-guide/web3-name-sdk/rest-api
 */

const SPACE_ID_API = 'https://api.prd.space.id/v1'
const cache = new Map<string, { name: string | null; ts: number }>()
const TTL_MS = 10 * 60 * 1000

export async function resolveSpaceId(address: string): Promise<string | null> {
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.name

  try {
    const res = await fetch(
      `${SPACE_ID_API}/getName?tld=bnb&address=${address}`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 600 } },
    )
    if (!res.ok) {
      cache.set(key, { name: null, ts: Date.now() })
      return null
    }
    const data = (await res.json()) as { code: number; name?: string }
    const name = data.code === 0 && data.name ? data.name : null
    cache.set(key, { name, ts: Date.now() })
    return name
  } catch {
    cache.set(key, { name: null, ts: Date.now() })
    return null
  }
}
