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
 * `unstable_cache` stores its value with `JSON.stringify(result)`, so nothing
 * JSON cannot express may appear in a cached payload.
 *
 * A `Date` merely degrades to a string. A `bigint` is far worse: `JSON.stringify`
 * THROWS on it, inside Next's fire-and-forget `cacheNewResult`. The page still
 * renders from the value already in hand, nothing reaches the user, and the
 * cache entry is simply never written — so the query runs again on every single
 * request, forever, with no failing symptom anywhere. That is exactly what
 * `/blocks` and `/txs` did in production until 2026-08-28.
 *
 * `blocks.gas_used`, `blocks.gas_limit`, `transactions.gas` and
 * `transactions.gas_used` are the schema's only `mode: 'bigint'` columns and
 * both queries `select()` every column, so all four cross as decimal strings
 * and are rehydrated by the `parse*` helpers below. Adding another `bigint`
 * column to either table means adding it here too — `list-pages-serde.test.ts`
 * fails if you do not.
 */
export type CachedTx =
  Omit<typeof schema.transactions.$inferSelect, 'timestamp' | 'gas' | 'gasUsed'>
  & { timestamp: string; gas: string; gasUsed: string }
export type CachedBlock =
  Omit<typeof schema.blocks.$inferSelect, 'timestamp' | 'gasUsed' | 'gasLimit'>
  & { timestamp: string; gasUsed: string; gasLimit: string }

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

export function toCachedTx(r: typeof schema.transactions.$inferSelect): CachedTx {
  return { ...r, timestamp: toIso(r.timestamp), gas: r.gas.toString(), gasUsed: r.gasUsed.toString() }
}

export function toCachedBlock(r: typeof schema.blocks.$inferSelect): CachedBlock {
  return { ...r, timestamp: toIso(r.timestamp), gasUsed: r.gasUsed.toString(), gasLimit: r.gasLimit.toString() }
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
      rows: rows.map(toCachedTx),
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
      rows: rows.map(toCachedBlock),
      total: estimateFrom(totalResult),
    }
  },
)

export function parseTx(row: CachedTx): typeof schema.transactions.$inferSelect {
  return { ...row, timestamp: new Date(row.timestamp), gas: BigInt(row.gas), gasUsed: BigInt(row.gasUsed) }
}

export function parseBlock(row: CachedBlock): typeof schema.blocks.$inferSelect {
  return { ...row, timestamp: new Date(row.timestamp), gasUsed: BigInt(row.gasUsed), gasLimit: BigInt(row.gasLimit) }
}

/** Page numbers come straight off the query string. */
export function parsePageParam(raw: string | undefined): number {
  const n = Number(raw ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}
