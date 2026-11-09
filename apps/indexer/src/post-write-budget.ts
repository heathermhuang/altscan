/**
 * Bounds for processBlock's post-write metadata reads (audit lead B14). After a block's writes begin it reads metadata
 * for every token it has not seen (4 calls each) and resolves every DEX pair it does not know (3 to 4 calls each).
 * Both were one unbounded Promise.all per block, times INDEX_CONCURRENCY blocks in flight, and a deployer chooses how
 * many new tokens and pairs a block holds.
 *
 * Sized from the [fanout] lines (fanout-stats.ts) on 2026-11-09, the first 10 minutes after a deploy, pair cache cold:
 * at most 4 new tokens and 33 unknown pairs in any block on either chain. The budgets sit well above that, so they
 * bind only on a block built to fan out.
 */
export const TOKEN_FETCH_PER_BLOCK = 32
export const PAIR_RESOLVE_PER_BLOCK = 64
/** Reads in flight at once, across every block, for each of the two kinds. */
export const POST_WRITE_CONCURRENCY = 8

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>

/** A FIFO semaphore: at most `max` of the functions it runs are in flight at once. */
export function createLimiter(max: number): Limiter {
  let active = 0
  const waiting: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/**
 * Run `fn` under `limit`, and stop WAITING for it after `timeoutMs`. The slot stays with `fn` until it settles: a
 * timeout only frees the block, not the read, which is still in flight on the node. Releasing the slot at the timeout
 * would let a slow endpoint pile up reads past the limit (Codex, round one: 24 in flight under a limit of 8). A read
 * that fails after its caller gave up is handled here, so it cannot surface as an unhandled rejection.
 */
export function boundedRead<T>(limit: Limiter, fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const read = limit(fn)
  read.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer))
}

/** The first `budget` items to read now, and the rest. */
export function withinBudget<T>(items: readonly T[], budget: number): { now: T[]; over: T[] } {
  return { now: items.slice(0, budget), over: items.slice(budget) }
}

export type WarmPairRow = { pair_address: string; token0: string; token1: string; dex: string }

/**
 * Pairs to seed the in-memory pair cache with at boot, from recent dex_trades. The cache is memory only, so after
 * every deploy each active pair read as unknown: on BNB the first 10 minutes dropped 562 swaps whose pair reads
 * failed in that burst, against 43 in the next 10. Every pair in dex_trades was verified against a listed factory
 * when its trade was written, and a V2 pair's token0/token1 are its two tokens in address order, which is what the
 * query's LEAST/GREATEST of (token_in, token_out) gives.
 */
export function warmPairs(rows: readonly WarmPairRow[]): Array<[string, { tokens: [string, string]; dex: string }]> {
  return rows
    .filter((r) => r.pair_address && r.token0 && r.token1 && r.token0 !== r.token1)
    .map((r) => [r.pair_address.toLowerCase(), { tokens: [r.token0.toLowerCase(), r.token1.toLowerCase()], dex: r.dex }])
}

/** Recent blocks the warm-up reads trades from: about 2.5 h on BNB, about 2.8 days on ETH. */
export const WARM_PAIR_BLOCKS = 20_000
export const WARM_PAIR_MAX = 10_000
