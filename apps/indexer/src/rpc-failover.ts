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

import type { EndpointHealth } from './endpoint-health'

/** Notified on each failed attempt, so a sick endpoint is visible in logs. */
export type FailoverReporter<P> = (block: number, provider: P, err: unknown) => void

/**
 * The unit of work. `onSideEffect` MUST be called the instant before the first
 * durable write, so failover knows the attempt can no longer be safely replayed.
 */
export type FailoverWork<P> = (
  block: number,
  provider: P,
  onSideEffect: () => void,
) => Promise<void>

/**
 * Run `work(block, provider)` against `providers`, starting at `startIdx` and
 * wrapping around, until one succeeds.
 *
 * Failover is only attempted while the work is known to have produced NO side
 * effects. `processBlock` is not a pure fetch: it commits blocks, transactions
 * and dex_trades incrementally and only enqueues transfers at the end, and
 * `dex_trades` carries `id serial PRIMARY KEY` with no unique constraint — so
 * `onConflictDoNothing()` cannot deduplicate a replayed insert. Retrying a block
 * that already wrote would duplicate rows and could splice provider A's block
 * with provider B's transactions. Once `onSideEffect` fires we therefore rethrow
 * immediately and let the batch-level path handle it, exactly as before this
 * module existed. (codex P1 on PR #91.)
 *
 * Every provider is tried at most once. If all of them fail, the LAST error is
 * thrown — callers treat a throw exactly as before, so the batch-level failure
 * path is unchanged for the genuinely-unrecoverable case.
 */
export async function processWithFailover<P>(
  block: number,
  providers: readonly P[],
  startIdx: number,
  work: FailoverWork<P>,
  onFailover?: FailoverReporter<P>,
  health?: EndpointHealth<P>,
): Promise<void> {
  if (providers.length === 0) {
    throw new Error(`[rpc-failover] no RPC providers configured — cannot process block ${block}`)
  }

  // Health-aware order when a tracker is supplied: an endpoint that keeps
  // failing goes LAST, so the common path stops paying its timeout on ~1/N of
  // blocks. The order is always a full permutation — a demoted endpoint is a
  // last resort, never dropped.
  //
  // Normalize: workerId can exceed the list length, and a negative would index
  // off the front. `% length` alone still yields a negative for negative input.
  const start = ((startIdx % providers.length) + providers.length) % providers.length
  const ordered = health
    ? health.order(providers, start)
    : providers.map((_, i) => providers[(start + i) % providers.length])

  let lastErr: unknown
  for (const provider of ordered) {
    let wrote = false
    try {
      await work(block, provider, () => { wrote = true })
      health?.recordSuccess(provider)
      return
    } catch (err) {
      lastErr = err
      // Partially persisted — replaying elsewhere would corrupt, not heal.
      // Not counted as a failover: the endpoint served us fine, the write did
      // not, so it must NOT count against the endpoint's health either.
      if (wrote) throw err
      health?.recordFailure(provider)
      onFailover?.(block, provider, err)
    }
  }
  throw lastErr
}

/**
 * Reject if `promise` has not settled within `timeoutMs`.
 *
 * Used to bound RPC acquisition. A throttled or archive-refusing endpoint does
 * not fail fast: bsc.publicnode.com took ~85-90s to finally reject an archive
 * request (ethers retries and backs off internally), and because a FAILED
 * processBlock attempt never reaches recordTimings, that wait was invisible to
 * the profiler — it showed as "unaccounted" wall time with all 30 block timings
 * looking normal.
 *
 * The abandoned promise is not cancelled (ethers exposes no abort handle); it
 * settles later and is ignored. Callers must therefore only apply this where
 * abandoning the work is SAFE — i.e. strictly before any durable write.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[rpc-failover] ${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Failover for a READ that returns a value, with a hard timeout.
 *
 * Companion to processWithFailover, for the per-batch `getBlockNumber()` and
 * reorg header calls. Those were pinned to providers[0] with neither failover
 * nor a timeout, and a throttled endpoint does not error — it HANGS. Measured on
 * BNB after PR #91: ~85s of every stalled window was spent here while in-block
 * time stayed normal and the transfer queue sat empty.
 *
 * The timeout is the load-bearing part. Failover alone cannot rescue a call that
 * never settles.
 *
 * Unlike processWithFailover there is NO side-effect boundary: these reads write
 * nothing, so retrying them is unconditionally safe.
 *
 * Note: a timed-out request is abandoned, not cancelled — ethers gives us no
 * abort handle here. It settles later and is ignored. Harmless, but it does mean
 * a throttled endpoint keeps receiving the request that timed out.
 */
export async function readWithFailover<T, P>(
  providers: readonly P[],
  startIdx: number,
  work: (provider: P) => Promise<T>,
  timeoutMs: number,
  onFailover?: (provider: P, err: unknown) => void,
  health?: EndpointHealth<P>,
): Promise<T> {
  if (providers.length === 0) {
    throw new Error('[rpc-failover] no RPC providers configured — cannot read')
  }
  const start = ((startIdx % providers.length) + providers.length) % providers.length
  // These are the tip and reorg reads that gate EVERY batch, so they are the
  // calls that most need to stop starting on a known-bad endpoint.
  const ordered = health
    ? health.order(providers, start)
    : providers.map((_, i) => providers[(start + i) % providers.length])

  let lastErr: unknown
  for (const provider of ordered) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        work(provider),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`[rpc-failover] read timed out after ${timeoutMs}ms`)),
            timeoutMs,
          )
        }),
      ])
      health?.recordSuccess(provider)
      return value
    } catch (err) {
      lastErr = err
      health?.recordFailure(provider)
      onFailover?.(provider, err)
    } finally {
      // Always clear: on the success path this stops a pending timer from
      // holding the event loop open for the full timeout.
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  throw lastErr
}

/**
 * Mask anything credential-shaped in an RPC URL before it reaches a log.
 *
 * Endpoints are frequently keyed — render.yaml records the BNB endpoint having
 * been a Chainstack URL — and providers carry the secret as basic-auth userinfo,
 * a path segment, or a query parameter depending on vendor. Public endpoints
 * stay fully readable so the logs remain useful.
 */
export function redactRpcUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '<unparseable-rpc-url>'
  }

  // Every rule is evaluated in ONE pass. An earlier version returned as soon as
  // it had masked userinfo, so a URL carrying both basic-auth and a path or
  // query token leaked the latter. (codex P1 round 2.)
  const hasUserInfo = parsed.username !== '' || parsed.password !== ''
  const pathCarriesSecret = parsed.pathname !== '' && parsed.pathname !== '/'
  const hasQuery = parsed.search !== ''

  // Nothing credential-shaped: keep the operator's exact spelling (trailing
  // slash and all) so logs stay greppable against the configured value.
  if (!hasUserInfo && !pathCarriesSecret && !hasQuery) return url

  const userPart = hasUserInfo ? '***@' : ''
  // A non-empty path or any query is assumed to carry the key — the two are
  // indistinguishable from a routing path without vendor-specific knowledge.
  const tail = pathCarriesSecret || hasQuery ? '/***' : ''
  // `parsed.host` keeps any non-default port.
  return `${parsed.protocol}//${userPart}${parsed.host}${tail}`
}

/**
 * Scrub credentials out of arbitrary error text before logging it.
 *
 * Redacting the endpoint label is not sufficient: ethers 6.16 embeds the
 * complete `requestUrl` — userinfo, path and query included — in the message of
 * HTTP failure errors, which is how the raw endpoint reached production logs in
 * the first place. Configured endpoints are replaced with their redacted form;
 * anything else that merely looks credential-bearing gets its userinfo masked.
 */
export function redactRpcSecrets(message: string, rawUrls: readonly string[]): string {
  let out = message
  // LONGEST-FIRST is load-bearing. In configuration order, a shorter
  // credential-bearing URL that prefixes a longer one destroys the longer exact
  // match and leaves its suffix exposed — e.g. replacing
  // `https://host/v1/token` inside `https://host/v1/token?apikey=SECOND` yields
  // `https://host/***?apikey=SECOND`. (codex P1 round 3.)
  const ordered = [...rawUrls].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const raw of ordered) {
    const safe = redactRpcUrl(raw)
    // A public endpoint redacts to itself — leave it readable.
    if (safe === raw) continue
    // split/join is a literal replace-all: no regex escaping, so a `+`, `?` or
    // `.` inside the configured URL cannot corrupt the match.
    out = out.split(raw).join(safe)
  }
  // Catch-all for endpoints that were never configured (redirects, proxies).
  return out.replace(/\/\/[^/\s@"']+@/g, '//***@')
}

/**
 * Format ANY thrown value for logging with RPC credentials stripped.
 *
 * Handing `console.error` a raw ethers Error also prints its `info` property,
 * which is where ethers parks `requestUrl` — so every RPC-reachable sink must
 * format through here rather than passing the object. The stack is preserved for
 * debuggability; `info` is deliberately dropped, since its only unique content
 * is the endpoint we must not log.
 */
export function formatRedactedError(err: unknown, rawUrls: readonly string[]): string {
  const raw = err instanceof Error ? err.stack ?? err.message : String(err)
  return redactRpcSecrets(raw, rawUrls)
}
