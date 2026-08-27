/**
 * Whale Tracker data access — the queries behind /whales, extracted from the
 * page so they can be tested.
 *
 * They were extracted because the page was DEAD in production on both chains,
 * for every time period, and nothing noticed. `AND tt.token_address =
 * ANY(${tokenAddresses})` renders through drizzle as `ANY(($1, $2))` — a row
 * constructor, not an array — which Postgres rejects with "op ANY/ALL (array)
 * requires array on right side". The page caught that, logged it, and rendered
 * the empty state, so an outage was indistinguishable from a quiet market.
 *
 * Two conventions here are load-bearing:
 *   - `WhaleTx[] | null`: null means that half FAILED, [] means it succeeded
 *     and found nothing. The page renders those differently, so they must not
 *     collapse. `mergeWhaleRows` erases the distinction via `?? []`, which is
 *     why `fetchWhales` computes `degraded` from the settle result and never
 *     from the merged rows.
 *   - Each half settles independently. A shared Promise.all previously let the
 *     token query's rejection discard a native result that had already
 *     succeeded.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chainConfig } from '@/lib/chain'
import { safeBigInt } from '@/lib/format'

export type WhalePeriod = '1h' | '24h' | '7d' | 'all'

export type TokenFilter = {
  address: string
  minValue: string
  symbol?: string
  decimals?: number
}

export type WhaleTx = {
  hash: string
  fromAddress: string
  toAddress: string | null
  value: string
  blockNumber: number
  timestamp: Date
  transferType: 'native' | 'token'
  tokenSymbol?: string
}

/** null = the query failed; [] = it succeeded and found nothing. The page
 *  renders those two differently, so they must not collapse into one value. */
export type WhaleResult = {
  native: WhaleTx[] | null
  token: WhaleTx[] | null
}

const QUERY_TIMEOUT_MS = 15_000

function cutoffFor(period: WhalePeriod): SQL {
  switch (period) {
    case '1h': return sql`NOW() - INTERVAL '1 hour'`
    case '7d': return sql`NOW() - INTERVAL '7 days'`
    case 'all': return sql`NOW() - INTERVAL '30 days'`   // "all" capped to 30d
    default: return sql`NOW() - INTERVAL '24 hours'`
  }
}

/**
 * The 25 largest native transfers in the window.
 *
 * The `value > <floor>` literal is NOT redundant, however much it looks it.
 * It is what lets the planner match the partial index
 * `tx_whale_value_idx ON transactions(value DESC, timestamp DESC)
 *  WHERE value > <floor>`, which turns this from "read every candidate row from
 * the heap, sort, discard all but 25" into an index walk that stops at 25.
 *
 * drizzle binds `minNativeWei` as a parameter and postgres-js prepares
 * statements, so Postgres may plan this generically — and a generic plan cannot
 * prove `$1 >= floor`, so it cannot use a partial index predicated on it.
 * Verified on PG16 against a fixture built to prod selectivity, under
 * `plan_cache_mode = force_generic_plan`:
 *
 *   parameter only     Parallel Seq Scan   52,744 buffers
 *   parameter + literal Index Scan              27 buffers
 *
 * Deleting the literal does not fail a test or change a single row. It silently
 * restores the outage. `nativeIndexFloorWei` must stay equal to the index
 * predicate in ensure-schema.ts, and `nativeMinWei` must stay at or above it.
 */
export function rawWeiLiteral(wei: string): SQL {
  // sql.raw is unavoidable here (a bound parameter defeats the partial index),
  // so prove the value is a bare integer before splicing it into the statement.
  if (!/^[0-9]+$/.test(wei)) {
    throw new Error(`whales: index floor must be digits, got ${JSON.stringify(wei)}`)
  }
  return sql.raw(wei)
}

export function buildNativeWhaleQuery(period: WhalePeriod, minNativeWei: string): SQL {
  return sql`
      SELECT hash, from_address as "fromAddress", to_address as "toAddress",
             value, block_number as "blockNumber", timestamp,
             'native' as "transferType", ${chainConfig.currency} as "tokenSymbol"
      FROM transactions
      WHERE timestamp >= ${cutoffFor(period)}
        AND value > ${rawWeiLiteral(chainConfig.whales.nativeIndexFloorWei)}
        AND value > ${minNativeWei}
      ORDER BY value DESC
      LIMIT 25
  `
}

/**
 * The 25 most recent tracked-token transfers above each token's threshold.
 *
 * One arm per token, `UNION ALL`ed, rather than a single scan with
 * `token_address IN (…) AND (per-token OR arms)`. The OR form cannot use
 * `tt_token_ts_idx (token_address, timestamp DESC)` to stop early: Postgres has
 * to gather every tracked-token transfer in the window and sort it. Each arm
 * here is instead an index walk that stops at 25 rows.
 *
 * Measured on prod ETH, 2026-08-27 (EXPLAIN ANALYZE, cold):
 *   24h   6,110 ms  ->    6.7 ms
 *    7d  28,916 ms  ->    0.3 ms
 *
 * A per-token `LIMIT 25` is enough for a global top-25: the global result can
 * contain at most 25 rows from any one token, so each arm's own top 25 is a
 * superset of that token's contribution.
 *
 * The `LEFT JOIN tokens` is applied AFTER the limit — joining before it made the
 * lookup run against every candidate row instead of the 25 that survive.
 *
 * `(timestamp, tx_hash, log_index)` is the sort key, not `timestamp` alone. A
 * timestamp is a block, and a hot token moves many times per block, so ordering
 * by timestamp alone leaves the cut inside a tie group and the page reshuffles
 * between ISR regenerations. The inner and outer ORDER BYs must stay identical
 * or the merge argument above stops holding.
 */
export function buildTokenWhaleQuery(period: WhalePeriod, filters: readonly TokenFilter[]): SQL {
  if (filters.length === 0) {
    // sql.join([]) yields an empty fragment, i.e. `UNION ALL` with no arms —
    // invalid SQL that would only fail at the database. fetchWhales skips the
    // token half entirely in this case; anything else calling in is a bug.
    throw new Error('buildTokenWhaleQuery: at least one token filter is required')
  }

  const arms = filters.map(f => sql`(
        SELECT tx_hash, from_address, to_address, value, block_number, timestamp,
               log_index, token_address
        FROM token_transfers
        WHERE token_address = ${f.address}
          AND timestamp >= ${cutoffFor(period)}
          AND value > ${f.minValue}
        ORDER BY timestamp DESC, tx_hash DESC, log_index DESC
        LIMIT 25
      )`)

  return sql`
      SELECT u.tx_hash as hash, u.from_address as "fromAddress", u.to_address as "toAddress",
             u.value, u.block_number as "blockNumber", u.timestamp,
             'token' as "transferType",
             COALESCE(tk.symbol, 'TOKEN') as "tokenSymbol"
      FROM (
        SELECT * FROM (${sql.join(arms, sql` UNION ALL `)}) m
        ORDER BY m.timestamp DESC, m.tx_hash DESC, m.log_index DESC
        LIMIT 25
      ) u
      LEFT JOIN tokens tk ON tk.address = u.token_address
      ORDER BY u.timestamp DESC, u.tx_hash DESC, u.log_index DESC
  `
}

function parseWhaleRow(row: unknown): WhaleTx {
  const r = row as Record<string, unknown>
  return {
    hash: String(r.hash),
    fromAddress: String(r.fromAddress),
    toAddress: r.toAddress ? String(r.toAddress) : null,
    value: String(r.value),
    blockNumber: Number(r.blockNumber),
    timestamp: new Date(r.timestamp as string),
    transferType: r.transferType === 'token' ? 'token' : 'native',
    tokenSymbol: r.tokenSymbol ? String(r.tokenSymbol) : undefined,
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/**
 * Settle both halves independently. The previous Promise.all meant the token
 * query's rejection also threw away a native result that had already succeeded,
 * so one broken query emptied the whole page. Each half now times out and fails
 * on its own; `null` records "this half failed" so the caller can say so.
 */
export async function settleWhaleQueries(
  nativePromise: Promise<unknown>,
  tokenPromise: Promise<unknown>,
): Promise<WhaleResult> {
  const [native, token] = await Promise.allSettled([
    withTimeout(nativePromise, QUERY_TIMEOUT_MS, 'whales native'),
    withTimeout(tokenPromise, QUERY_TIMEOUT_MS, 'whales token'),
  ])

  const unwrap = (r: PromiseSettledResult<unknown>, half: string): WhaleTx[] | null => {
    if (r.status === 'rejected') {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      console.error(`[whales] ${half} query failed: ${msg}`)
      return null
    }
    return Array.from(r.value as Iterable<unknown>).map(parseWhaleRow)
  }

  return { native: unwrap(native, 'native'), token: unwrap(token, 'token') }
}

export type WhaleFetch = {
  rows: WhaleTx[]
  /** true when at least one half failed — the page must say so rather than
   *  rendering the empty state and implying the market was quiet. */
  degraded: boolean
}

/**
 * Merge both halves, rank by value descending, cap the list.
 *
 * Pure and exported so tests exercise the REAL comparator. A test that
 * re-implements this sort inline passes identically whether the comparator is
 * correct or not, which is exactly how the numeric(78,18) crash slipped through.
 */
export function mergeWhaleRows(
  native: WhaleTx[] | null,
  token: WhaleTx[] | null,
): WhaleTx[] {
  return [...(native ?? []), ...(token ?? [])]
    .sort((a, b) => {
      // safeBigInt, NOT BigInt. `transactions.value` is numeric(78,18) and
      // postgres-js returns the full scale — "5000…000.000000000000000000".
      // Raw BigInt() throws SyntaxError on that, which would escape fetchWhales
      // and 500 the page: strictly worse than the bug being fixed.
      const av = safeBigInt(a.value)
      const bv = safeBigInt(b.value)
      return bv > av ? 1 : bv < av ? -1 : 0
    })
    .slice(0, 50)
}

export async function fetchWhales(
  period: WhalePeriod,
  minNativeWei: string,
  filters: readonly TokenFilter[],
): Promise<WhaleFetch> {
  const result = await settleWhaleQueries(
    db.execute(buildNativeWhaleQuery(period, minNativeWei)),
    filters.length > 0
      ? db.execute(buildTokenWhaleQuery(period, filters))
      : Promise.resolve([]),
  )

  const rows = mergeWhaleRows(result.native, result.token)
  return { rows, degraded: result.native === null || result.token === null }
}
