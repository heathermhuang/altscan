// Pure classification of one explorer /api/health payload, kept free of fetch/state so it can be tested.

/** Chain head older than this (seconds) is a stale head, not an operational one. */
export const STALE_LAG_SECONDS = 120

export interface Classified {
  status: 'operational' | 'degraded'
  latestBlock: number | null
  lagSeconds: number | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * `operational` needs a recognised `ok` payload that actually carries a chain head AND its lag. A
 * missing head means the explorer could not read its blocks table (it says `degraded` itself, but an
 * older deploy reported `ok` with nulls) — nulls must never read as healthy. Anything unrecognised
 * (e.g. the `error` body behind a 503) is degraded with NO block/lag: keeping the previous poll's
 * numbers would present a stale head as current.
 */
export function classifyHealth(data: Record<string, unknown>): Classified {
  if (data.status !== 'ok' && data.status !== 'degraded') {
    return { status: 'degraded', latestBlock: null, lagSeconds: null }
  }
  const latestBlock = num(data.latestBlock)
  const lagSeconds = num(data.lagSeconds)
  const healthy =
    data.status === 'ok' && latestBlock !== null && lagSeconds !== null && lagSeconds <= STALE_LAG_SECONDS
  return { status: healthy ? 'operational' : 'degraded', latestBlock, lagSeconds }
}
