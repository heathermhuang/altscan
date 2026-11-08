/**
 * On-demand body cache for point lookups. When retention prunes a transaction's
 * heavy body (input calldata + event logs; body_pruned=true), the tx page refetches
 * it here on first view and caches it via the shared kv-cache (Redis on BNB, bounded
 * in-memory fallback where Redis is absent). The data is immutable, but the TTL is
 * short anyway — it is bounded by the Redis it shares, not by staleness. See
 * BODY_CACHE_TTL_MS below.
 *
 * Graceful degradation (design §5.3): every failure returns null; the page renders
 * the compact tx + a note. Already-local data is never affected.
 */
import { getWebProvider } from './rpc'
import { getRedis, isRedisUnavailable, kvGet, kvSet } from '@altscan/explorer-core'
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
 * SIZED FROM MEASURED ARRIVAL, 2026-09-16. Purging both instances gave 2.5h of
 * unconstrained observation (Render's memory series, 30-min resolution): BNB
 * grew 31 -> 108MB and ETH 18 -> 53MB, i.e. ~38 and ~17 MB/h. Crucially the
 * rate is FLAT across those 2.5h, not decaying — so almost every request is for
 * a distinct tx (crawlers walking transaction lists) and 38 MB/h is the real
 * arrival rate, not a cold-cache artifact that warms away.
 *
 * ⚠ Do not re-derive this from a refill that STARTED near 256MB. The 09-08
 * figures (~8 MB/h) look reassuring and are wrong: the instance was already
 * refusing writes, so they measure the wall, not the traffic.
 *
 * Steady-state population is arrival x TTL, so on BNB:
 *     7d -> unbounded; hits the 256MB wall in well under a day
 *    24h -> ~900MB
 *     6h -> ~230MB, still nearly the whole instance
 *     2h -> ~76MB, leaving ~180MB for the response cache, the CU ledger and a
 *           2-3x traffic burst
 * Two hours it is — which is exactly what the Moralis response cache already
 * chose for this same instance and for this same reason; see CACHE_TTL in
 * packages/providers/src/moralis.ts.
 *
 * ⚠ A shorter default only bounds NEW writes. Redis fixes a key's TTL when it
 * is written, so entries already stored under the old 7-day TTL keep it and
 * must be deleted explicitly (scoped SCAN + UNLINK of `body:tx:*`) after this
 * deploys, or they hold the instance full for another week.
 *
 * A miss costs one getTransaction + getTransactionReceipt on the next view of a
 * retention-pruned tx, and the page refetches transparently. That is the cheap
 * side of this trade; starving the spend ceiling is the expensive side.
 * BODY_CACHE_TTL_MS still overrides — but re-measure arrival before raising it,
 * and raise the instance first if the product of the two exceeds ~100MB.
 */
const BODY_CACHE_TTL_MS = parseInt(process.env.BODY_CACHE_TTL_MS ?? String(2 * 60 * 60 * 1000), 10)

/**
 * The TTL bounds how LONG an entry lives, not how many bytes arrive: anyone can ask for pruned txs as fast as they
 * like, and a transaction's sender chooses its calldata and logs. So two more bounds, both in UTF-8 bytes:
 *
 *   - an entry over BODY_CACHE_MAX_ENTRY_BYTES is served but not cached (a typical body is ~2.5 KB);
 *   - at most BODY_CACHE_WINDOW_BYTES are admitted per window, one TTL long, counted in Redis (INCRBY + PEXPIRE on a
 *     key per window, so the count resets as the entries it admitted expire; a plain counter would only rise until
 *     caching stopped for good). An entry outlives its window by at most one TTL, so the cache holds under about 2x
 *     the budget: 96 MB by default, on a 256 MB instance shared with the CU ledger and the response cache.
 *
 * A counter Redis cannot write is no admission: this cache never gets to fill a Redis the ledger needs. With no Redis
 * at all, kvSet's in-memory fallback is 50 entries, so the entry cap bounds it.
 */
export const BODY_CACHE_MAX_ENTRY_BYTES = 64 * 1024
const BODY_CACHE_WINDOW_BYTES = parseInt(process.env.BODY_CACHE_WINDOW_BYTES ?? String(48 * 1024 * 1024), 10)

async function admitBody(bytes: number): Promise<boolean> {
  const r = getRedis()
  if (!r || isRedisUnavailable()) return true
  const key = `body:admit:${Math.floor(Date.now() / BODY_CACHE_TTL_MS)}`
  try {
    const res = await r.multi().incrby(key, bytes).pexpire(key, 2 * BODY_CACHE_TTL_MS).exec()
    const admitted = res?.[0]?.[1]   // [error, result] per command; a refused INCRBY (OOM) has no number
    return typeof admitted === 'number' && admitted <= BODY_CACHE_WINDOW_BYTES
  } catch {
    return false
  }
}

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

/**
 * The full input of ONE transaction from the node, for an indexed tx whose stored input is cut at
 * 500 characters. Null on any failure, or when the node answers for a different hash.
 *
 * Deliberately NOT cached through getTxBody: that writes input + logs to the shared noeviction Redis
 * (see BODY_CACHE_TTL_MS above), and an indexed tx with a long input is common, so caching these
 * would multiply the arrival rate that cache was sized against. The tx page is ISR (one render per
 * path per minute), which already bounds this to one getTransaction per tx per minute.
 */
export async function fetchTxInputFromRpc(hash: string): Promise<string | null> {
  try {
    const provider = await getWebProvider()
    const tx = await provider.getTransaction(hash)
    if (!tx || tx.hash.toLowerCase() !== hash.toLowerCase()) return null
    return tx.data
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
  if (!body) return null
  const value = serializeTxBody(body)
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes <= BODY_CACHE_MAX_ENTRY_BYTES && await admitBody(bytes)) {
    await kvSet(key, value, BODY_CACHE_TTL_MS).catch(() => {})
  }
  return body
}
