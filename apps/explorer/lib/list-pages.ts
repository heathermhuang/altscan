/**
 * Cached data access for `/txs` and `/blocks`.
 *
 * Extracted from the pages for the reason `lib/whales.ts` was: a query that
 * lives inside a component cannot be tested, and both of these sat behind a
 * bare `catch {}` that rendered the empty state on failure — the same shape
 * that hid the Whale Tracker outage for months.
 */
import { desc, sql } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { createPageCache } from '@/lib/page-cache'

export const PER_PAGE = 25
export const TXS_REVALIDATE_SECONDS = 45
export const BLOCKS_REVALIDATE_SECONDS = 60

/**
 * Rows as they survive the cache.
 *
 * `unstable_cache` round-trips its value through the incremental cache, so a
 * `Date` comes back as a string and a `bigint` would not come back at all.
 * Timestamps are therefore carried as ISO strings and rehydrated by the
 * `parse*` helpers below — TxTable and BlockTable both require a real `Date`.
 */
export type CachedTx = Omit<typeof schema.transactions.$inferSelect, 'timestamp'> & { timestamp: string }
export type CachedBlock = Omit<typeof schema.blocks.$inferSelect, 'timestamp'> & { timestamp: string }

export type ListPage<T> = { rows: T[]; total: number }

/** `reltuples` is an estimate and is -1 on a table that has never been
 *  analysed, which would render as a negative page count. */
export function estimateFrom(result: unknown): number {
  const n = Number((Array.from(result as Iterable<unknown>)[0] as Record<string, unknown>)?.estimate ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/** Created once at module scope; `page` is an ARGUMENT so Next keys on it. */
export const fetchTxPage = createPageCache(
  'txs',
  TXS_REVALIDATE_SECONDS,
  async (page: number): Promise<ListPage<CachedTx>> => {
    const [rows, totalResult] = await Promise.all([
      db.select().from(schema.transactions)
        .orderBy(desc(schema.transactions.timestamp))
        .limit(PER_PAGE)
        .offset((page - 1) * PER_PAGE),
      db.execute(sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'transactions'`),
    ])
    return {
      rows: rows.map(r => ({ ...r, timestamp: toIso(r.timestamp) })),
      total: estimateFrom(totalResult),
    }
  },
)

export const fetchBlockPage = createPageCache(
  'blocks',
  BLOCKS_REVALIDATE_SECONDS,
  async (page: number): Promise<ListPage<CachedBlock>> => {
    const [rows, totalResult] = await Promise.all([
      db.select().from(schema.blocks)
        .orderBy(desc(schema.blocks.number))
        .limit(PER_PAGE)
        .offset((page - 1) * PER_PAGE),
      db.execute(sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'blocks'`),
    ])
    return {
      rows: rows.map(r => ({ ...r, timestamp: toIso(r.timestamp) })),
      total: estimateFrom(totalResult),
    }
  },
)

export function parseTx(row: CachedTx): typeof schema.transactions.$inferSelect {
  return { ...row, timestamp: new Date(row.timestamp) }
}

export function parseBlock(row: CachedBlock): typeof schema.blocks.$inferSelect {
  return { ...row, timestamp: new Date(row.timestamp) }
}

/** Page numbers come straight off the query string. */
export function parsePageParam(raw: string | undefined): number {
  const n = Number(raw ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}
