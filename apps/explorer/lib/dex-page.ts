/**
 * Cached data access for `/dex`.
 *
 * This is the page the data cache matters most for: alongside the paginated
 * select it runs a `GROUP BY pair_address, dex` over the whole of `dex_trades`
 * for the top-pairs panel, and it ran that on every request because reading
 * `searchParams` made the route dynamic and its `revalidate = 300` never applied.
 */
import { desc, sql } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { cachedPageQuery } from '@/lib/page-cache'

export const DEX_PAGE_SIZE = 25
export const DEX_REVALIDATE_SECONDS = 300

export type TopPair = { pair_address: string; dex: string; trade_count: number }

/** Token metadata as a plain array — a Map does not survive the cache. */
export type TokenMeta = { address: string; decimals: number; symbol: string }

export type CachedDexTrade =
  Omit<typeof schema.dexTrades.$inferSelect, 'timestamp'> & { timestamp: string }

export type DexPageData = {
  trades: CachedDexTrade[]
  totalTrades: number
  uniqueMakers: number
  topPairs: TopPair[]
  tokens: TokenMeta[]
}

function estimate(result: unknown, key: string): number {
  const n = Number((Array.from(result as Iterable<unknown>)[0] as Record<string, unknown>)?.[key] ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export async function fetchDexPage(page: number): Promise<DexPageData> {
  return cachedPageQuery('dex', [page], DEX_REVALIDATE_SECONDS, async () => {
    // Sequential on purpose — these were concurrent full-table scans and OOMed
    // the 2GB web service.
    const trades = await db.select().from(schema.dexTrades)
      .orderBy(desc(schema.dexTrades.blockNumber))
      .limit(DEX_PAGE_SIZE)
      .offset((page - 1) * DEX_PAGE_SIZE)

    const tradeCount = await db.execute(
      sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'dex_trades'`)
    // reltuples/10 stands in for COUNT(DISTINCT maker), which is too expensive.
    const makerCount = await db.execute(
      sql`SELECT GREATEST(1, (reltuples / 10)::bigint) AS value FROM pg_class WHERE relname = 'dex_trades'`)
    const topPairsResult = await db.execute(sql`
      SELECT pair_address, dex, COUNT(*)::int as trade_count
      FROM dex_trades
      GROUP BY pair_address, dex
      ORDER BY trade_count DESC
      LIMIT 5
    `)

    const tokenAddrs = new Set<string>()
    for (const t of trades) {
      if (t.tokenIn) tokenAddrs.add(t.tokenIn.toLowerCase())
      if (t.tokenOut) tokenAddrs.add(t.tokenOut.toLowerCase())
    }

    let tokens: TokenMeta[] = []
    if (tokenAddrs.size > 0) {
      // Symbols are cosmetic — the table falls back to a truncated address — so
      // this one lookup may fail without failing the page. It is logged rather
      // than swallowed so the fallback is not mistaken for missing metadata.
      try {
        const rows = await db.select({
          address: schema.tokens.address,
          decimals: schema.tokens.decimals,
          symbol: schema.tokens.symbol,
        })
          .from(schema.tokens)
          .where(sql`${schema.tokens.address} IN (${sql.join([...tokenAddrs].map(a => sql`${a}`), sql`, `)})`)
        tokens = rows.map(t => ({ ...t, address: t.address.toLowerCase() }))
      } catch (err) {
        console.error('[dex] token metadata lookup failed:',
          err instanceof Error ? err.message : err)
      }
    }

    return {
      trades: trades.map(t => ({
        ...t,
        timestamp: t.timestamp instanceof Date ? t.timestamp.toISOString() : String(t.timestamp),
      })),
      totalTrades: estimate(tradeCount, 'estimate'),
      uniqueMakers: estimate(makerCount, 'value'),
      topPairs: (Array.from(topPairsResult) as Record<string, unknown>[]).map(r => ({
        pair_address: String(r.pair_address),
        dex: String(r.dex),
        trade_count: Number(r.trade_count),
      })),
      tokens,
    }
  })
}

export function parseDexTrade(t: CachedDexTrade): typeof schema.dexTrades.$inferSelect {
  return { ...t, timestamp: new Date(t.timestamp) }
}
