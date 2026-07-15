/**
 * On-demand body cache for point lookups. When retention prunes a transaction's
 * heavy body (input calldata + event logs; body_pruned=true), the tx page refetches
 * it here on first view and caches it via the shared kv-cache (Redis on BNB, bounded
 * in-memory fallback where Redis is absent). Immutable data → long TTL.
 *
 * Graceful degradation (design §5.3): every failure returns null; the page renders
 * the compact tx + a note. Already-local data is never affected.
 */
import { getProvider } from './rpc'
import { kvGet, kvSet } from '@altscan/explorer-core'
import { bodyCacheKey, serializeTxBody, parseTxBody, type TxBody, type CachedLog } from './body-cache-serde'

export type { TxBody, CachedLog } from './body-cache-serde'

const BODY_CACHE_TTL_MS = parseInt(process.env.BODY_CACHE_TTL_MS ?? String(7 * 24 * 60 * 60 * 1000), 10)

/** Fetch input calldata + receipt logs from the node. Null on any failure. */
export async function fetchTxBodyFromRpc(hash: string): Promise<TxBody | null> {
  try {
    const provider = getProvider()
    const [tx, receipt] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash),
    ])
    if (!tx && !receipt) return null
    const logs: CachedLog[] = (receipt?.logs ?? []).map((l) => ({
      address: l.address.toLowerCase(),
      topic0: l.topics[0] ?? null,
      topic1: l.topics[1] ?? null,
      topic2: l.topics[2] ?? null,
      topic3: l.topics[3] ?? null,
      data: l.data,
      logIndex: l.index,
    }))
    return { input: tx?.data ?? '0x', logs }
  } catch {
    return null
  }
}

/** Cache-first body fetch. Returns null if RPC is unreachable (caller degrades). */
export async function getTxBody(hash: string): Promise<TxBody | null> {
  const key = bodyCacheKey(hash)
  const cached = parseTxBody(await kvGet(key).catch(() => null))
  if (cached) return cached
  const body = await fetchTxBodyFromRpc(hash)
  if (body) await kvSet(key, serializeTxBody(body), BODY_CACHE_TTL_MS).catch(() => {})
  return body
}
