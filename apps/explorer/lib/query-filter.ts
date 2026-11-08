/**
 * POST /api/v1/query's body, checked before any database call: the filters each entity takes
 * and the combinations an index serves. Kept out of the route file, which Next.js allows to
 * export only its handlers.
 */
const ADDR = /^0x[0-9a-fA-F]{40}$/
// Deeper pages walk the index row by row up to the statement timeout, for any
// anonymous caller; narrow with blockFrom/blockTo instead.
const MAX_OFFSET = 10_000

const ENTITIES = ['transactions', 'blocks', 'tokens', 'token_transfers', 'dex_trades'] as const
export type Entity = typeof ENTITIES[number]

/**
 * The filters each entity takes. Every combination they allow is served by an index in the
 * order the page is read, so a request costs about offset + limit rows whatever its values:
 *
 *  - At most ONE of address / from / to / tokenAddress. Each leads its own
 *    (column, timestamp DESC) index; there is no composite, so two at once made the walk of
 *    one filter on the other, and two busy values that never meet read every row of one.
 *  - A block range (blockFrom / blockTo, and blockNumber on transactions) with it becomes a
 *    timestamp range too (blockTimeBounds), which those indexes can start and stop on.
 *  - A block range alone walks block_number.
 *  - dex_trades takes a block range only: its maker index has no block order, and nothing
 *    indexes `dex`, so either filter made a request read every retained row it did not match.
 *
 * Anything else is refused before the database is touched, and so is a field an entity does
 * not take: it used to be ignored, answering a narrower question than the one asked.
 */
const ENTITY_FILTERS: Record<Entity, readonly string[]> = {
  transactions: ['address', 'from', 'to', 'blockNumber', 'blockFrom', 'blockTo'],
  blocks: ['blockFrom', 'blockTo'],
  tokens: [],
  token_transfers: ['address', 'from', 'to', 'tokenAddress', 'blockFrom', 'blockTo'],
  dex_trades: ['blockFrom', 'blockTo'],
}
const KEY_FILTERS = ['address', 'from', 'to', 'tokenAddress'] as const
const BLOCK_FILTERS = ['blockNumber', 'blockFrom', 'blockTo'] as const

export type Filter = {
  address?: string
  from?: string
  to?: string
  tokenAddress?: string
  blockNumber?: number
  blockFrom?: number
  blockTo?: number
}
export type Query = { entity: Entity; filter: Filter; orderBy: 'asc' | 'desc'; limit: number; offset: number }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The body, checked before any database call. Pure. Block filters are checked as integers
 * because they reach Postgres as parameters: a string was rejected there as invalid bigint
 * syntax, and the error quoted it, line breaks included, into the log.
 */
export function parseQuery(body: unknown): { ok: true; query: Query } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: 'Body must be a JSON object' }
  const entity = body.entity
  if (typeof entity !== 'string' || !(ENTITIES as readonly string[]).includes(entity)) {
    return { ok: false, error: `Invalid entity. Use: ${ENTITIES.join(', ')}` }
  }
  const allowed = ENTITY_FILTERS[entity as Entity]
  const rawFilter = body.filter === undefined ? {} : body.filter
  if (!isObject(rawFilter)) return { ok: false, error: 'filter must be an object' }

  const filter: Filter = {}
  for (const [key, value] of Object.entries(rawFilter)) {
    if (value === undefined) continue
    if (!allowed.includes(key)) {
      return { ok: false, error: `${entity} takes ${allowed.length ? `only filter.${allowed.join(', filter.')}` : 'no filters'}; not filter.${key}` }
    }
    if ((KEY_FILTERS as readonly string[]).includes(key)) {
      if (typeof value !== 'string' || !ADDR.test(value)) return { ok: false, error: `Invalid filter.${key}` }
      filter[key as typeof KEY_FILTERS[number]] = value.toLowerCase()
    } else {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        return { ok: false, error: `filter.${key} must be a non-negative integer` }
      }
      filter[key as typeof BLOCK_FILTERS[number]] = value
    }
  }
  const keys = KEY_FILTERS.filter(k => filter[k] !== undefined)
  if (keys.length > 1) {
    return { ok: false, error: `Use one of filter.${KEY_FILTERS.filter(k => allowed.includes(k)).join(', filter.')} at a time, not ${keys.map(k => `filter.${k}`).join(' and ')}` }
  }
  if (filter.blockFrom !== undefined && filter.blockTo !== undefined && filter.blockFrom > filter.blockTo) {
    return { ok: false, error: 'filter.blockFrom must not be greater than filter.blockTo' }
  }

  const orderBy = body.orderBy ?? 'desc'
  if (orderBy !== 'asc' && orderBy !== 'desc') return { ok: false, error: "orderBy must be 'asc' or 'desc'" }
  const limit = Math.min(Math.max(1, Number(body.limit) || 25), 100)
  const offset = Math.max(0, Number(body.offset) || 0)
  if (offset > MAX_OFFSET) {
    return { ok: false, error: `offset must be at most ${MAX_OFFSET}; narrow the range with filter.blockFrom/blockTo` }
  }
  return { ok: true, query: { entity: entity as Entity, filter, orderBy, limit, offset } }
}
