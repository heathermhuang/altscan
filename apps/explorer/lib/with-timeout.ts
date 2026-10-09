/** How long a page may wait on a database read before giving up (the charts queries, the block tape). */
export const DB_TIMEOUT_MS = 8000

/**
 * Reject if `promise` has not settled within `ms`. The timer is cleared as soon as it does, so a
 * fast query leaves nothing pending. This bounds the WAIT only: the query itself keeps running on
 * the server, so a read that can be slow should also be cached (lib/page-cache.ts).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number = DB_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('query timeout')), ms)
    promise.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}
