/**
 * Make swallowed failures visible.
 *
 * The explorer had 120 bare `catch {}` blocks and 6 logging sites, so roughly
 * every failure path was invisible. That is not theoretical: the Whale Tracker
 * broke on both chains and the page simply rendered an empty table — there was
 * nothing in the Render logs to grep for, so an empty state was read as "no
 * whales" rather than "the query is failing".
 *
 * Graceful degradation is still the right behaviour for a page. What was wrong
 * was degrading *silently*. These helpers keep the degradation and add signal.
 *
 * Tags follow the convention already used in a handful of places — a bracketed
 * lowercase path like `[tx/logs]` or `[addr/holdings]` — so a failing page can
 * be found with a single `?text=` query against the Render logs.
 */

/**
 * First occurrence per tag is always emitted; repeats are suppressed for this
 * long. A DB outage fails every request on every page, and an unthrottled log
 * buries the first occurrence — the one that says when it started.
 */
const THROTTLE_MS = 60_000
const lastLoggedAt = new Map<string, number>()

/** Test seam. Not for production use. */
export function resetSwallowThrottle(): void {
  lastLoggedAt.clear()
}

/** Log a swallowed error under `[tag]`. Never throws. */
export function swallow(tag: string, err: unknown): void {
  try {
    const now = Date.now()
    const last = lastLoggedAt.get(tag)
    if (last !== undefined && now - last < THROTTLE_MS) return
    lastLoggedAt.set(tag, now)
    // Bound the map: tags are static strings in source, so this cannot grow
    // unbounded in practice, but a defensive cap costs nothing.
    if (lastLoggedAt.size > 500) lastLoggedAt.clear()
    console.error(`[${tag}]`, err instanceof Error ? err.stack ?? err.message : err)
  } catch {
    // Logging must never be able to break the page it is reporting on.
  }
}

/**
 * Drop-in for `.catch(() => fallback)` that logs first.
 *
 *   db.select()...            .catch(() => [])
 *   db.select()...            .catch(swallowed('tx/logs', []))
 *
 * Same degradation, same value, now greppable.
 */
export function swallowed<T>(tag: string, fallback: T): (err: unknown) => T {
  return (err: unknown) => {
    swallow(tag, err)
    return fallback
  }
}
