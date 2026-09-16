/**
 * On-demand body cache for point lookups. When retention prunes a transaction's
 * heavy body (input calldata + event logs; body_pruned=true), the tx page refetches
 * it here on first view and caches it via the shared kv-cache (Redis on BNB, bounded
 * in-memory fallback where Redis is absent). Immutable data → long TTL.
 *
 * Graceful degradation (design §5.3): every failure returns null; the page renders
 * the compact tx + a note. Already-local data is never affected.
 */
import { getWebProvider } from './rpc'
import { kvGet, kvSet } from '@altscan/explorer-core'
import { bodyCacheKey, serializeTxBody, parseTxBody, type TxBody, type CachedLog } from './body-cache-serde'

export type { TxBody, CachedLog } from './body-cache-serde'

/**
 * ⚠ SIZED TO FIT THE REDIS, NOT TO MAXIMISE HIT RATE. Was 7 days.
 *
 * There is no bound on how MANY bodies this caches, so the TTL alone sets the
 * steady-state population. At 7 days it reached 172,133 keys (~435MB of demand)
 * on a 256MB ethscan-redis and 87,704 on bnbscan-redis — in both cases ~100% of
 * the keyspace. Those instances are maxmemory-policy=noeviction, so a full one
 * REFUSES writes rather than evicting, which silently took down two things that
 * share it: the Moralis response cache, and the Moralis monthly CU ledger — the
 * only control that can bound a metered bill. See the ledgerUnwritable note in
 * packages/providers/src/moralis.ts.
 *
 * A miss costs one getTransaction + getTransactionReceipt on the next view of a
 * retention-pruned tx, and the page refetches transparently. That is the cheap
 * side of this trade; starving the spend ceiling is the expensive side.
 * BODY_CACHE_TTL_MS still overrides — but raise it only after the instance has
 * the headroom to absorb it.
 */
const BODY_CACHE_TTL_MS = parseInt(process.env.BODY_CACHE_TTL_MS ?? String(24 * 60 * 60 * 1000), 10)

/** Fetch input calldata + receipt logs from the node. Null on any failure. */
export async function fetchTxBodyFromRpc(hash: string): Promise<TxBody | null> {
  try {
    const provider = await getWebProvider()
    const [tx, receipt] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash),
    ])
    // A pruned tx was mined, so the node must have BOTH the tx (input) and the
    // receipt (logs). A null for either is a transient RPC miss — fail the whole
    // fetch rather than cache a partial body (e.g. logs:[]) for the full TTL.
    if (!tx || !receipt) return null
    const logs: CachedLog[] = receipt.logs.map((l) => ({
      address: l.address.toLowerCase(),
      topic0: l.topics[0] ?? null,
      topic1: l.topics[1] ?? null,
      topic2: l.topics[2] ?? null,
      topic3: l.topics[3] ?? null,
      data: l.data,
      logIndex: l.index,
    }))
    return { input: tx.data, logs }
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
