/**
 * Per-block RPC failover.
 *
 * `RPC_URLS` may list several endpoints. Before this module the worker pool
 * pinned each worker to one endpoint for the life of the process
 * (`providers[workerId % providers.length]`) and a single block failure aborted
 * the entire batch — so one sick endpoint permanently removed a fixed share of
 * capacity and stalled every batch it touched.
 *
 * That is exactly how BNB indexing collapsed on 2026-08-11: bsc.publicnode.com
 * serves recent blocks but 403s archive requests ("Archive requests require a
 * personal token"). The indexer only requests old blocks when it is BEHIND, so
 * the failure mode was self-reinforcing — drift a little, start failing every
 * fetch on that endpoint, abort batches, drift further, and finally trip
 * MAX_LAG_BLOCKS and skip ~5,100 blocks. Permanently, ~once an hour.
 *
 * A block now tries the remaining endpoints before it is allowed to fail. One
 * broken endpoint costs a single wasted round trip, not the batch.
 */

/** Notified on each failed attempt, so a sick endpoint is visible in logs. */
export type FailoverReporter<P> = (block: number, provider: P, err: unknown) => void

/**
 * Run `work(block, provider)` against `providers`, starting at `startIdx` and
 * wrapping around, until one succeeds.
 *
 * Every provider is tried at most once. If all of them fail, the LAST error is
 * thrown — callers treat a throw exactly as before, so the batch-level failure
 * path is unchanged for the genuinely-unrecoverable case.
 */
export async function processWithFailover<P>(
  block: number,
  providers: readonly P[],
  startIdx: number,
  work: (block: number, provider: P) => Promise<void>,
  onFailover?: FailoverReporter<P>,
): Promise<void> {
  if (providers.length === 0) {
    throw new Error(`[rpc-failover] no RPC providers configured — cannot process block ${block}`)
  }

  // Normalize: workerId can exceed the list length, and a negative would index
  // off the front. `% length` alone still yields a negative for negative input.
  const start = ((startIdx % providers.length) + providers.length) % providers.length

  let lastErr: unknown
  for (let attempt = 0; attempt < providers.length; attempt++) {
    const provider = providers[(start + attempt) % providers.length]
    try {
      await work(block, provider)
      return
    } catch (err) {
      lastErr = err
      onFailover?.(block, provider, err)
    }
  }
  throw lastErr
}
