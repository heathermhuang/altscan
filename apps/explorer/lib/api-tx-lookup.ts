/**
 * Chain lookup for the public transaction API, for hashes outside the index (retention keeps only
 * a few days of transactions). Every unknown hash costs RPC calls, and anyone can send random
 * hashes, so the work is bounded here rather than per request:
 *
 * - at most MAX_CONCURRENT lookups per process; past that, answer `unavailable` (the route sends
 *   503) instead of queueing, which would hold requests open on a 2GB instance
 * - one in-flight lookup per hash, shared by every caller until it settles (even after a
 *   caller's deadline), each caller with its own deadline
 * - a deadline per lookup; the RPC call cannot be cancelled, so its slot is freed only when it
 *   settles, which keeps the concurrency cap honest under a slow node. Every call does settle:
 *   the provider times each request out (RPC_TIMEOUT_MS, default 8s per endpoint, lib/rpc.ts)
 * - a small positive cache, only for transactions too old to be reorged out
 * - repeated misses are negative-cached by fetchTxFactsFromRpc
 */
import { fetchTxFactsFromRpc, type RpcTxFacts } from './rpc-fallback'

export type ChainLookup =
  | { kind: 'found'; tx: RpcTxFacts }
  | { kind: 'missing' }
  | { kind: 'unavailable' }

const MAX_CONCURRENT = 8
const DEADLINE_MS = 8_000
const HIT_TTL_MS = 10 * 60_000
const HIT_CACHE_MAX = 500
// Far past either chain's reorg window (BNB ~15 blocks x 0.45s, ETH ~3 x 12s).
const SETTLED_AGE_MS = 10 * 60_000

const inFlight = new Map<string, Promise<ChainLookup>>()
const hits = new Map<string, { tx: RpcTxFacts; expires: number }>()
let running = 0

function remember(key: string, tx: RpcTxFacts) {
  if (tx.pending || !tx.timestamp || Date.now() - tx.timestamp.getTime() < SETTLED_AGE_MS) return
  if (hits.size >= HIT_CACHE_MAX) hits.delete(hits.keys().next().value!)
  hits.set(key, { tx, expires: Date.now() + HIT_TTL_MS })
}

export function lookupTxOnChain(hash: string): Promise<ChainLookup> {
  const key = hash.toLowerCase()
  const hit = hits.get(key)
  if (hit) {
    if (Date.now() < hit.expires) return Promise.resolve({ kind: 'found', tx: hit.tx })
    hits.delete(key)
  }
  // The node call stays registered until it settles, past any caller's deadline: a retry for a
  // slow hash shares it instead of starting a duplicate that takes another slot.
  let work = inFlight.get(key)
  if (!work) {
    if (running >= MAX_CONCURRENT) return Promise.resolve({ kind: 'unavailable' })
    running++
    work = fetchTxFactsFromRpc(key)
      .then((tx): ChainLookup => {
        if (!tx) return { kind: 'missing' }
        remember(key, tx)
        return { kind: 'found', tx }
      }, (): ChainLookup => ({ kind: 'unavailable' }))
      .finally(() => {
        running--
        inFlight.delete(key)
      })
    inFlight.set(key, work)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<ChainLookup>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unavailable' }), DEADLINE_MS)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** Test hook: forget cached hits (the slot counter and in-flight map drain on their own). */
export function __resetTxLookupForTests() {
  hits.clear()
}
