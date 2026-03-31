/**
 * ENS name resolution for EthScan.
 * Resolves Ethereum addresses to ENS names (.eth) and vice-versa.
 * Uses the ETH RPC provider — no separate API key needed.
 * Results are cached for 10 minutes to avoid hammering the provider.
 */
import { getProvider } from '../rpc'

const cache = new Map<string, { name: string | null; ts: number }>()
const TTL_MS = 10 * 60 * 1000

export async function resolveEns(address: string): Promise<string | null> {
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.name

  try {
    const provider = getProvider()
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
    const name = await Promise.race([provider.lookupAddress(address), timeout])
    cache.set(key, { name, ts: Date.now() })
    return name
  } catch {
    cache.set(key, { name: null, ts: Date.now() })
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
