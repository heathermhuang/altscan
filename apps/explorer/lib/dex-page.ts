/**
 * Cached data access for `/dex`.
 *
 * This is the page the data cache matters most for: alongside the paginated
 * select it runs a `GROUP BY pair_address, dex` for the top-pairs panel, and it
 * ran that on every request because reading `searchParams` made the route
 * dynamic and its `revalidate = 300` never applied.
 */
import { desc, sql } from 'drizzle-orm'
import { dbErrorMessage } from '@altscan/db'
import { db, schema } from '@/lib/db'
import { createPageCache } from '@/lib/page-cache'
import { fetchNativeUsd } from '@/lib/native-price'
import { withTimeout } from '@/lib/with-timeout'

export const DEX_PAGE_SIZE = 25
export const DEX_REVALIDATE_SECONDS = 300
/**
 * Top pairs are ranked over this many most-recent trades, not the whole table.
 * BNB records ~2.3M V2 swaps a day, so two days of retention is ~4.6M rows, and
 * a GROUP BY over all of them reads the entire heap (191k pages, ~1.5 GB, on a
 * 4.6M-row local copy) on every revalidation. The window reads ~6k pages,
 * newest first, off dex_block_idx.
 */
export const TOP_PAIRS_WINDOW = 50_000

export type TopPair = { pair_address: string; dex: string; trade_count: number }

/** Token metadata as a plain array — a Map does not survive the cache. */
export type TokenMeta = { address: string; decimals: number; symbol: string }

export type CachedDexTrade =
  Omit<typeof schema.dexTrades.$inferSelect, 'timestamp'> & { timestamp: string }

export type DexPageData = {
  trades: CachedDexTrade[]
  totalTrades: number
  topPairs: TopPair[]
  tokens: TokenMeta[]
  /**
   * The native coin's USD price when the page was cached, or null (no source answered in time). It sizes
   * the recent-swaps strip's wrapped-native legs (lib/dex-size.ts); null leaves those swaps unpriced, and
   * the strip's legend says so. A plain number, so it is safe in the cache.
   */
  nativeUsd: number | null
}

/**
 * How long the cached read waits for the native price. Binance is 3 s a host and a miss falls through to
 * slower sources; the strip degrades visibly without a price, the table does not need it, so a hung
 * provider must not hold the cache fill (and the page behind it) for the helper's full 11 s.
 */
export const DEX_PRICE_WAIT_MS = 4000

function estimate(result: unknown, key: string): number {
  const n = Number((Array.from(result as Iterable<unknown>)[0] as Record<string, unknown>)?.[key] ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// 'dex-priced', not 'dex': the cached value gained `nativeUsd`, and an entry written by the previous
// build under the old name would hand this code the old shape (lib/page-cache.ts).
export const fetchDexPage = createPageCache(
  'dex-priced',
  DEX_REVALIDATE_SECONDS,
  async (page: number): Promise<DexPageData> => {
    // The price is network, not database: it runs beside the reads below without adding to their load.
    const nativeUsd = withTimeout(fetchNativeUsd(), DEX_PRICE_WAIT_MS).catch(() => null)
    // Sequential on purpose — these were concurrent full-table scans and OOMed
    // the 2GB web service.
    const trades = await db.select().from(schema.dexTrades)
    .orderBy(desc(schema.dexTrades.blockNumber))
    .limit(DEX_PAGE_SIZE)
    .offset((page - 1) * DEX_PAGE_SIZE)

    const tradeCount = await db.execute(
    sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'dex_trades'`)
    // The window size is inlined, not bound: a generic plan cannot see a bound
    // LIMIT and would cost the scan as if it read a tenth of the table.
    const topPairsResult = await db.execute(sql`
    SELECT pair_address, dex, COUNT(*)::int as trade_count
    FROM (
      SELECT pair_address, dex FROM dex_trades
      ORDER BY block_number DESC
      LIMIT ${sql.raw(String(TOP_PAIRS_WINDOW))}
    ) recent
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
        dbErrorMessage(err))
    }
    }

    return {
    trades: trades.map(t => ({
      ...t,
      timestamp: t.timestamp instanceof Date ? t.timestamp.toISOString() : String(t.timestamp),
    })),
    totalTrades: estimate(tradeCount, 'estimate'),
    topPairs: (Array.from(topPairsResult) as Record<string, unknown>[]).map(r => ({
      pair_address: String(r.pair_address),
      dex: String(r.dex),
      trade_count: Number(r.trade_count),
    })),
    tokens,
    nativeUsd: await nativeUsd,
    }
  },
)

export function parseDexTrade(t: CachedDexTrade): typeof schema.dexTrades.$inferSelect {
  return { ...t, timestamp: new Date(t.timestamp) }
}
