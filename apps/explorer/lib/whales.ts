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
import { createPageCache } from '@/lib/page-cache'
import { dbErrorMessage } from '@altscan/db'
import { db } from '@/lib/db'
import { chainConfig } from '@/lib/chain'
import { formatUnits } from 'ethers'
import type { WhaleConfig } from '@altscan/chain-config'
import { safeBigInt } from '@/lib/format'
import { fetchNativeUsd, NATIVE_PRICE_BUDGET_MS } from '@/lib/native-price'

export type WhalePeriod = '1h' | '24h' | '7d' | 'all'

export type TokenFilter = {
  address: string
  minValue: string
  /** The token's whale partial-index floor (chain-config `indexFloor`): the whale arm's `value >` literal. */
  indexFloor: string
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
  /** The token's contract address (lowercase), on token rows. What a row is priced by: never its symbol. */
  tokenAddress?: string
}

/** null = the query failed; [] = it succeeded and found nothing. The page
 *  renders those two differently, so they must not collapse into one value. */
export type WhaleResult = {
  native: WhaleTx[] | null
  token: WhaleTx[] | null
}

const QUERY_TIMEOUT_MS = 15_000

/** Native transfers fetched as ranking candidates: the largest by value. */
export const WHALE_NATIVE_CANDIDATES = 50
/** Per tracked token and per arm, the transfers fetched as ranking candidates: its largest whale-size ones and its latest qualifying ones. */
export const WHALE_TOKEN_CANDIDATES = 25
/** Rows the page shows, after every candidate has been priced and ranked. */
export const WHALES_SHOWN = 50

function cutoffFor(period: WhalePeriod): SQL {
  switch (period) {
    case '1h': return sql`NOW() - INTERVAL '1 hour'`
    case '7d': return sql`NOW() - INTERVAL '7 days'`
    case 'all': return sql`NOW() - INTERVAL '30 days'`   // "all" capped to 30d
    default: return sql`NOW() - INTERVAL '24 hours'`
  }
}

/**
 * The `WHALE_NATIVE_CANDIDATES` (50) largest native transfers in the window: the ranking candidates.
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

/**
 * A tracked token's address as a quoted SQL literal, for the same reason `rawWeiLiteral` exists: `tt_whale_idx` is
 * predicated on `(token_address = '<address>' AND value > <floor>)` per token, and a partial index is only used when
 * the query spells that out. Lower case, because `token_transfers.token_address` is stored lower case: a mixed-case
 * literal would be valid, match nothing, and fall back to the latest arm alone without a single error.
 */
function rawAddressLiteral(address: string): SQL {
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    throw new Error(`whales: token address must be 0x + 40 lowercase hex, got ${JSON.stringify(address)}`)
  }
  return sql.raw(`'${address}'`)
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
      LIMIT ${sql.raw(String(WHALE_NATIVE_CANDIDATES))}
  `
}

/**
 * The ranking candidates for each tracked token: TWO arms, `WHALE_TOKEN_CANDIDATES` (25) rows each. The page prices
 * and ranks all of them (rankWhalesByUsd) and shows the top 50.
 *
 *   1. The WHALE arm: the token's 25 largest transfers above its `indexFloor`, by value, in the period. This is what
 *      lets a $1M stablecoin transfer from hours ago compete at all: the latest arm below only ever sees the newest 25.
 *      It is served by `tt_whale_idx ON token_transfers (token_address, value DESC)`, whose predicate is, per tracked
 *      token, `(token_address = '<address>' AND value > <indexFloor>)`. Postgres uses a partial index only when it can
 *      PROVE the query implies that predicate, so the token and the floor are LITERALS here (`rawAddressLiteral`,
 *      `rawWeiLiteral`), never bound parameters: the same arm with them bound and planned generically does not use the
 *      index (whales.pg.test.ts shows both). Equality on the leading column hands the `value DESC` order to the index
 *      (a Merge Append across BNB's partitions); the `tx_hash`/`log_index` tie-break is an Incremental Sort on top, over
 *      at most a handful of rows. Without the index this read took 10-39 s per token on ETH and 2-6 min on BNB.
 *      `timestamp` is not an index column, so the period is a filter on the walk. That is bounded by the whale-size rows
 *      the token has in the retained history, which is why the floor is 100x the display threshold.
 *   2. The LATEST arm: the token's 25 newest transfers above its display threshold (`minValue`), unchanged. It walks
 *      `tt_token_ts_idx (token_address, timestamp DESC)` and stops at its limit: at most ~2 s on prod (BNB WBNB, whose
 *      transfers over 1 WBNB are sparse in the index, is the slow one at 1.1-2.0 s). The limit is NOT raised past 25
 *      because that walk's cost scales with it: 100 would be about 4x, ~8 s, on a BNB cache miss. It is what shows a
 *      busy hour's ordinary-sized transfers, which the whale arm cannot see below its floor.
 *
 * What is NOT a candidate: a transfer between the display threshold and the whale floor that is also older than the
 * token's newest 25 qualifying ones. The list is the largest of the candidates, not a proven top 50 of the whole
 * window, and the page's ranking note says so (`rankingNote`).
 *
 * The arms are joined with `UNION`, not `UNION ALL`: a recent whale-size transfer is in both arms, and the page must
 * list it once. Every selected column of a row is a function of the row, so two copies of the same
 * `(tx_hash, log_index)` are identical in every column and the set operator collapses exactly those.
 *
 * One pair of arms per token, rather than a single scan with `token_address IN (…) AND (per-token OR arms)`. The OR
 * form cannot use an index to stop early: Postgres has to gather every tracked-token transfer in the window and sort
 * it. Each arm here is instead an index walk that stops at its limit.
 *
 * Measured on prod ETH, 2026-08-27 (EXPLAIN ANALYZE, cold), for the latest arm:
 *   24h   6,110 ms  ->    6.7 ms
 *    7d  28,916 ms  ->    0.3 ms
 *
 * There is no cap across tokens: each arm contributes its own candidates and the ranking decides which survive. A
 * "newest 25 across all tokens" cut here would be a recency sample taken before any price is seen, and could drop an
 * older $1M transfer in favour of recent $1K ones.
 *
 * The `LEFT JOIN tokens` is applied AFTER the limits — joining before them made the lookup run against every
 * candidate row instead of the (at most 50 per token) that survive.
 *
 * Every arm and the final select sort by a total key — `(value | timestamp, tx_hash, log_index)` — not by one column.
 * A timestamp is a block, a hot token moves many times per block, and round-number transfers tie on value, so a single
 * column leaves each arm's cut inside a tie group and the page reshuffles between ISR regenerations.
 */
export function buildTokenWhaleQuery(period: WhalePeriod, filters: readonly TokenFilter[]): SQL {
  if (filters.length === 0) {
    // sql.join([]) yields an empty fragment, i.e. a `UNION` with no arms —
    // invalid SQL that would only fail at the database. fetchWhales skips the
    // token half entirely in this case; anything else calling in is a bug.
    throw new Error('buildTokenWhaleQuery: at least one token filter is required')
  }

  const arms = filters.flatMap(f => [
    sql`(
        SELECT tx_hash, from_address, to_address, value, block_number, timestamp,
               log_index, token_address
        FROM token_transfers
        WHERE token_address = ${rawAddressLiteral(f.address)}
          AND value > ${rawWeiLiteral(f.indexFloor)}
          AND timestamp >= ${cutoffFor(period)}
        ORDER BY value DESC, tx_hash DESC, log_index DESC
        LIMIT ${sql.raw(String(WHALE_TOKEN_CANDIDATES))}
      )`,
    sql`(
        SELECT tx_hash, from_address, to_address, value, block_number, timestamp,
               log_index, token_address
        FROM token_transfers
        WHERE token_address = ${f.address}
          AND timestamp >= ${cutoffFor(period)}
          AND value > ${f.minValue}
        ORDER BY timestamp DESC, tx_hash DESC, log_index DESC
        LIMIT ${sql.raw(String(WHALE_TOKEN_CANDIDATES))}
      )`,
  ])

  return sql`
      SELECT u.tx_hash as hash, u.from_address as "fromAddress", u.to_address as "toAddress",
             u.value, u.block_number as "blockNumber", u.timestamp,
             'token' as "transferType",
             COALESCE(tk.symbol, 'TOKEN') as "tokenSymbol",
             u.token_address as "tokenAddress"
      FROM (${sql.join(arms, sql` UNION `)}) u
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
    tokenAddress: r.tokenAddress ? String(r.tokenAddress).toLowerCase() : undefined,
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
      const msg = dbErrorMessage(r.reason)
      console.error(`[whales] ${half} query failed: ${msg}`)
      return null
    }
    return Array.from(r.value as Iterable<unknown>).map(parseWhaleRow)
  }

  return { native: unwrap(native, 'native'), token: unwrap(token, 'token') }
}

/** A transfer with what the page needs to show and rank it: its token's decimals and its USD value. */
export type RankedWhale = WhaleTx & {
  decimals: number
  /** value x price, a plain number, or null when this row has no price: shown as "no price", ranked last. */
  usd: number | null
}

export type WhaleFetch = {
  rows: RankedWhale[]
  /** The native price the rows were ranked with, or null when none could be had. The page says which. */
  nativeUsd: number | null
  /** true when at least one half failed — the page must say so rather than
   *  rendering the empty state and implying the market was quiet. */
  degraded: boolean
}

/**
 * Union of both halves, every candidate kept. No cap here: a cap before ranking could only cut
 * rows by recency or raw amount. The list is cut to `WHALES_SHOWN` in `queryWhales`, after the
 * USD sort.
 *
 * Deliberately NOT ordered by `value`. That used to rank by the raw base-unit number, which
 * compares an 18-decimal BNB amount with an 18-decimal USDT amount and a 6-decimal one as if
 * they were one unit: 32,800 USDT (~$33k) outranked 15,000 BNB (~$11M). Order needs a price,
 * so it lives in `rankWhalesByUsd`.
 *
 * Pure and exported so tests exercise the real function.
 */
export function mergeWhaleRows(
  native: WhaleTx[] | null,
  token: WhaleTx[] | null,
): WhaleTx[] {
  return [...(native ?? []), ...(token ?? [])]
}

const NATIVE_DECIMALS = 18

/** The price if it is a real one (finite and > 0), else null: "no native price", not a price of nothing. */
function usablePrice(price: number | null): number | null {
  return price != null && Number.isFinite(price) && price > 0 ? price : null
}

/**
 * The sentence under the page intro that says how the list is ranked, and from what. The list is the
 * largest of a candidate set, not a proven top of the whole window (see buildTokenWhaleQuery), so the
 * set is named from the same constants the queries use: the largest native transfers, and per tracked token
 * both its largest whale-size transfers and its latest qualifying ones. It names the live native price only
 * when one was used: the ranking (and this text) is cached for the window, so a price that failed to load is
 * a fact about the window, not something to paper over with "live".
 */
export function rankingNote(currency: string, wrappedSymbol: string, nativePriced: boolean): string {
  const basis = `the ${WHALE_NATIVE_CANDIDATES} largest ${currency} transfers, the ${WHALE_TOKEN_CANDIDATES} largest whale-size transfers of each tracked token, and the latest ${WHALE_TOKEN_CANDIDATES} qualifying transfers of each tracked token, all in this period`
  return nativePriced
    ? `Showing the top ${WHALES_SHOWN} by estimated USD value among ${basis}. Stablecoins are priced at $1, ${currency} and ${wrappedSymbol} at the live ${currency} price; a transfer with no price is listed last.`
    : `The ${currency} price is unavailable right now, so ${currency} and ${wrappedSymbol} transfers are unranked: they follow the stablecoin transfers, newest first, and may not fit in the ${WHALES_SHOWN} shown. Showing the top ${WHALES_SHOWN} among ${basis}; stablecoins are ranked by estimated USD value at $1.`
}

/**
 * Price each row and order the list by USD value, largest first.
 *
 * What a price is, in order:
 *   - native transfers and the wrapped native token (WBNB / WETH): `nativeUsd`, the live market price;
 *   - a stablecoin the chain config tracks: $1. That is a PEG ASSUMPTION, which is why the page calls
 *     every figure an estimate. The config's `stablecoins` is the allow-list: it is keyed by contract
 *     address per chain, and a coin belongs there only if it is meant to trade at $1;
 *   - anything else: no price (`usd: null`).
 * A row is matched by `tokenAddress`, never by `tokenSymbol`: symbols are chosen by whoever deploys the
 * token, so a scam token called "USDT" would otherwise be pegged at $1 and ranked by its fake balance.
 * An absent, zero or non-finite `nativeUsd` is "no native price", not a price of nothing.
 *
 * Rows with no price follow every priced row, newest first; equal values break the same way (newest,
 * then hash descending), so two renders of the same rows are never reshuffled. The result is plain
 * JSON: strings and numbers only, safe to hand to the page cache.
 *
 * Pure and exported so tests exercise the real comparator.
 */
export function rankWhalesByUsd(
  rows: readonly WhaleTx[],
  nativeUsd: number | null,
  cfg: Pick<WhaleConfig, 'wrapped' | 'stablecoins'> = chainConfig.whales,
): RankedWhale[] {
  const native = usablePrice(nativeUsd)
  const wrapped = cfg.wrapped.address.toLowerCase()
  const pegged = new Map(cfg.stablecoins.map(s => [s.address.toLowerCase(), s.decimals]))

  const priced = rows.map((r): RankedWhale => {
    let decimals = NATIVE_DECIMALS
    let price: number | null = null
    if (r.transferType === 'native') {
      price = native
    } else {
      const addr = r.tokenAddress?.toLowerCase()
      if (addr === wrapped) {
        decimals = cfg.wrapped.decimals
        price = native
      } else if (addr !== undefined && pegged.has(addr)) {
        decimals = pegged.get(addr)!
        price = 1
      }
    }
    // Number() is for ordering and display only; safeBigInt keeps numeric(78,18) tails from throwing.
    const amount = price === null ? NaN : Number(formatUnits(safeBigInt(r.value), decimals))
    const usd = Number.isFinite(amount) ? amount * price! : null
    return { ...r, decimals, usd }
  })

  return priced.sort((a, b) => {
    if (a.usd !== null && b.usd !== null && a.usd !== b.usd) return b.usd - a.usd
    if ((a.usd === null) !== (b.usd === null)) return a.usd === null ? 1 : -1
    const byTime = b.timestamp.getTime() - a.timestamp.getTime()
    if (byTime !== 0) return byTime
    return a.hash === b.hash ? 0 : a.hash < b.hash ? 1 : -1
  })
}

export const WHALES_REVALIDATE_SECONDS = 300

/**
 * Uncached query for both halves.
 *
 * Kept separate from `fetchWhales` so the cache wrapper has something to call
 * and tests have something to call without one.
 */
export async function queryWhales(
  period: WhalePeriod,
  minNativeWei: string,
  filters: readonly TokenFilter[],
): Promise<WhaleFetch> {
  const [result, nativeUsd] = await Promise.all([
    settleWhaleQueries(
      db.execute(buildNativeWhaleQuery(period, minNativeWei)),
      filters.length > 0
        ? db.execute(buildTokenWhaleQuery(period, filters))
        : Promise.resolve([]),
    ),
    // Bounded by what the helper's own chain needs to reach a non-Binance fallback (11 s). It runs beside the
    // two 15 s database timeouts, so it cannot make the page wait longer than they already can. A price
    // that still has not arrived reads as null, which the page says out loud (rankingNote).
    withTimeout(fetchNativeUsd(), NATIVE_PRICE_BUDGET_MS, 'whales price').then(usablePrice, () => null),
  ])

  // Rank every candidate, THEN keep the top WHALES_SHOWN: the cached value stays ~50 rows.
  const rows = rankWhalesByUsd(mergeWhaleRows(result.native, result.token), nativeUsd).slice(0, WHALES_SHOWN)
  return { rows, nativeUsd, degraded: result.native === null || result.token === null }
}

/**
 * Cached by period.
 *
 * `degraded` is part of the cached value on purpose. Both halves already settle
 * independently and resolve rather than reject, so a failure would otherwise be
 * cached as an ordinary empty result and the page would say "no large transfers"
 * for the whole revalidate window — which is the exact failure #110 fixed. The
 * flag rides along so the page keeps saying so.
 *
 * Timestamps are ISO strings across the boundary: `Date` does not survive the
 * incremental cache, and the table needs a real `Date` back.
 */
/** Cached by period. Constructed once; `period` is the argument Next keys on.
 *
 *  The threshold and token list come from chainConfig and are constant for the
 *  process, so they are read inside rather than passed — keeping the cache id
 *  small and stable.
 *
 *  `degraded` rides through the cache on purpose. Both halves settle rather than
 *  reject, so without it a failure would be stored as an ordinary empty result
 *  and the page would spend the whole window claiming the market was quiet —
 *  the exact failure #110 fixed.
 *
 *  Timestamps cross as ISO strings: `Date` does not survive the incremental
 *  cache, and the table needs a real `Date` back.
 *
 *  The rows are priced and ranked INSIDE the cached read (`queryWhales`), so the order, the USD
 *  figures and the price they came from are one snapshot for the whole window. A price that
 *  failed is part of that snapshot (`nativeUsd: null`, cached like the rest), which is why the
 *  page words its ranking note from it (`rankingNote`) instead of always claiming a live price.
 *  Every field is a string, a number or null: no BigInt, which would make Next's cache write throw. */
const fetchWhalesCached = createPageCache(
  // 'whales-usd-v2', not 'whales-usd': the value keeps its shape (rows with `decimals` and `usd`, `nativeUsd`,
  // `degraded`) but the candidate set changed, because each token now also contributes its largest whale-size
  // transfers. Next keys an entry by this name alone and the incremental cache outlives a deploy, so under the old
  // name the first visitors after this one would be served the old, newest-25-only ranking for up to a revalidate window.
  'whales-usd-v2',
  WHALES_REVALIDATE_SECONDS,
  async (period: WhalePeriod, minNativeWei: string, filters: readonly TokenFilter[]) => {
    const { rows, nativeUsd, degraded } = await queryWhales(period, minNativeWei, filters)
    return { rows: rows.map(r => ({ ...r, timestamp: r.timestamp.toISOString() })), nativeUsd, degraded }
  },
)

export async function fetchWhales(
  period: WhalePeriod,
  minNativeWei: string,
  filters: readonly TokenFilter[],
): Promise<WhaleFetch> {
  const cached = await fetchWhalesCached(period, minNativeWei, filters)
  return {
    rows: cached.rows.map((r) => ({ ...r, timestamp: new Date(r.timestamp) })),
    nativeUsd: cached.nativeUsd,
    degraded: cached.degraded,
  }
}
