import { sql, type SQL } from 'drizzle-orm'
import type { Db } from '@altscan/db'
import { END_OF_BLOCK, encodeCursor, type WatchCursor } from '@/lib/watch-cursor'
import { safeBigInt } from '@/lib/format'

/** apps/indexer/src/token-metadata.ts stores this symbol when a token's metadata could not be read. */
const UNKNOWN_SYMBOL = '???'

/** One row of the feed query, as postgres.js returns it: bigints arrive as strings, numerics as strings. */
export type WatchRow = {
  block_number: string | number
  block_hash: string
  tx_hash: string
  kind: number | string
  idx: number | string
  watched: string
  from_address: string
  to_address: string | null
  value: string
  token_address: string | null
  symbol: string | null
  decimals: number | string | null
  timestamp: Date | string
}

type EventBase = {
  direction: 'in' | 'out' | 'self'
  watched: string
  blockNumber: number
  blockHash: string
  timestamp: string
  txHash: string
  from: string
  to: string | null
  value: string
}

export type WatchEvent =
  | ({ type: 'native'; txIndex: number } & EventBase)
  | ({ type: 'token'; logIndex: number; token: { address: string; symbol: string | null; decimals: number | null } } & EventBase)

export function toWatchEvent(r: WatchRow): WatchEvent {
  const base: EventBase = {
    direction: r.from_address === r.to_address ? 'self' : r.watched === r.from_address ? 'out' : 'in',
    watched: r.watched,
    blockNumber: Number(r.block_number),
    blockHash: r.block_hash,
    timestamp: new Date(r.timestamp).toISOString(),
    txHash: r.tx_hash,
    from: r.from_address,
    to: r.to_address,
    // transactions.value is numeric(78,18) and arrives as "…000.000000000000000000"; BigInt() throws on it.
    value: safeBigInt(r.value).toString(),
  }
  if (Number(r.kind) === 0) return { type: 'native', ...base, txIndex: Number(r.idx) }
  const known = r.symbol !== null && r.symbol !== UNKNOWN_SYMBOL
  return {
    type: 'token',
    ...base,
    logIndex: Number(r.idx),
    token: {
      address: r.token_address as string,
      symbol: known ? r.symbol : null,
      decimals: known && r.decimals !== null ? Number(r.decimals) : null,
    },
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
const rowsOf = <T>(res: unknown): T[] => Array.from(res as Iterable<T>)

/** Blocks scanned per call at most (~9 min on BNB): a lagging client catches up over several calls. */
export const WATCH_WINDOW_BLOCKS = 1200
/** How far back the feed restarts when the cursor's block was replaced by a reorg. */
export const WATCH_REWIND_BLOCKS = 12

/** A feed position. k = -1 sorts before every event of block b (only used after a rewind; never encoded). */
type Position = { b: number; k: number; i: number; w: string }
type BlockRef = { number: number; hash: string }

export type WatchFeed = { events: WatchEvent[]; cursor: string; tip: number; oldestAvailableBlock: number | null; rewound: boolean }
export type WatchPage =
  | { status: 'ok'; body: WatchFeed }
  | { status: 'gone'; oldestAvailableBlock: number }
  | { status: 'not_ready' }

/**
 * The newest block the feed may serve: at or below the async transfer writer's watermark
 * (indexer_cursor.transfers_durable_block = W: every block ≤ W has all its transfers committed).
 * Serving past W would let a cursor pass a block whose transfers land later, skipping them forever.
 */
async function servedTip(tx: Tx): Promise<BlockRef | null> {
  const [r] = rowsOf<{ number: string; hash: string }>(await tx.execute(sql`
    SELECT number, hash FROM blocks
     WHERE number <= (SELECT transfers_durable_block FROM indexer_cursor WHERE id = 1)
     ORDER BY number DESC LIMIT 1`))
  return r ? { number: Number(r.number), hash: r.hash } : null
}

/** The first retained block (the compact cutoff, as /api/v1/query uses), or null when none is published. */
async function retentionFloor(tx: Tx): Promise<number | null> {
  const [r] = rowsOf<{ number: string }>(await tx.execute(sql`
    SELECT number FROM blocks
     WHERE number >= (SELECT compact_cutoff_block FROM indexer_cursor WHERE id = 1)
     ORDER BY number LIMIT 1`))
  return r ? Number(r.number) : null
}

async function hashAt(tx: Tx, block: number): Promise<string | null> {
  const [r] = rowsOf<{ hash: string }>(await tx.execute(sql`SELECT hash FROM blocks WHERE number = ${block}`))
  return r?.hash ?? null
}

/** The last of the first WATCH_WINDOW_BLOCKS existing blocks from `from` to `tip`: always a real block, past gaps. */
async function windowEnd(tx: Tx, from: number, tip: number): Promise<BlockRef | null> {
  const [r] = rowsOf<{ number: string; hash: string }>(await tx.execute(sql`
    SELECT number, hash FROM (
      SELECT number, hash FROM blocks WHERE number >= ${from} AND number <= ${tip}
       ORDER BY number LIMIT ${WATCH_WINDOW_BLOCKS}
    ) w ORDER BY number DESC LIMIT 1`))
  return r ? { number: Number(r.number), hash: r.hash } : null
}

/**
 * The feed query: four arms (native and token, sender and receiver side). Each arm reads every row of the
 * watched addresses in the window (bounded by block range and timestamp, via an existing (address, timestamp)
 * index) and sorts them before its LIMIT; it is not an early-stopping walk, so per-call cost scales with the
 * watched addresses' activity in the window. The page is cut from the arms' union.
 * The receiver arms drop self-transfers, which the sender arm already serves with direction "self".
 */
function feedSql(watched: string[], from: Position, end: number, bounds: { lo: Date | null; hi: Date | null }, take: number): SQL {
  const list = sql.join(watched.map((a) => sql`${a}`), sql`, `)
  const pos = sql`(${from.b}::bigint, ${from.k}::int, ${from.i}::int, ${from.w}::varchar)`
  const time = (alias: string) => sql.join([
    ...(bounds.lo ? [sql`AND ${sql.raw(alias)}.timestamp >= ${bounds.lo}`] : []),
    ...(bounds.hi ? [sql`AND ${sql.raw(alias)}.timestamp <= ${bounds.hi}`] : []),
  ], sql` `)
  const native = (side: 'from' | 'to') => sql`(
    SELECT t.block_number, t.hash AS tx_hash, 0 AS kind, t.tx_index AS idx, t.${sql.raw(side)}_address AS watched,
           t.from_address, t.to_address, t.value::text AS value, NULL::varchar AS token_address
      FROM transactions t
     WHERE t.${sql.raw(side)}_address IN (${list})
       AND t.block_number BETWEEN ${from.b}::bigint AND ${end}::bigint ${time('t')}
       AND t.status AND t.value > 0
       ${side === 'to' ? sql`AND t.from_address <> t.to_address` : sql``}
       AND (t.block_number, 0, t.tx_index, t.${sql.raw(side)}_address) > ${pos}
     ORDER BY t.block_number, t.tx_index, watched LIMIT ${take})`
  const token = (side: 'from' | 'to') => sql`(
    SELECT tt.block_number, tt.tx_hash, 1 AS kind, tt.log_index AS idx, tt.${sql.raw(side)}_address AS watched,
           tt.from_address, tt.to_address, tt.value::text AS value, tt.token_address
      FROM token_transfers tt
     WHERE tt.${sql.raw(side)}_address IN (${list})
       AND tt.block_number BETWEEN ${from.b}::bigint AND ${end}::bigint ${time('tt')}
       ${side === 'to' ? sql`AND tt.from_address <> tt.to_address` : sql``}
       AND (tt.block_number, 1, tt.log_index, tt.${sql.raw(side)}_address) > ${pos}
     ORDER BY tt.block_number, tt.log_index, watched LIMIT ${take})`
  return sql`
    SELECT p.*, b.hash AS block_hash, b.timestamp, tk.symbol, tk.decimals
      FROM (
        SELECT * FROM (${native('from')} UNION ALL ${native('to')} UNION ALL ${token('from')} UNION ALL ${token('to')}) u
         ORDER BY block_number, kind, idx, watched LIMIT ${take}
      ) p
      JOIN blocks b ON b.number = p.block_number
      LEFT JOIN tokens tk ON tk.address = p.token_address
     ORDER BY p.block_number, p.kind, p.idx, p.watched`
}

/**
 * One page of an owner's wallet-watch feed. One read-only REPEATABLE READ transaction, so every statement
 * sees one snapshot (the tip, the window and the events agree even while the indexer commits), with its own
 * statement timeout.
 */
export async function readWatchEvents(db: Db, owner: string, cursor: WatchCursor | null, limit: number): Promise<WatchPage> {
  return db.transaction(async (tx): Promise<WatchPage> => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '5s'`))
    const tip = await servedTip(tx)
    if (!tip) return { status: 'not_ready' }
    const floor = await retentionFloor(tx)
    const page = (events: WatchEvent[], next: WatchCursor, rewound: boolean): WatchPage =>
      ({ status: 'ok', body: { events, cursor: encodeCursor(next), tip: tip.number, oldestAvailableBlock: floor, rewound } })
    const endOf = (ref: BlockRef): WatchCursor => ({ b: ref.number, h: ref.hash, k: END_OF_BLOCK, i: 0, w: '' })

    // First call: start at the tip. Only events after the client started watching, no backlog.
    if (cursor === null) return page([], endOf(tip), false)
    if (floor !== null && cursor.b < floor) return { status: 'gone', oldestAvailableBlock: floor }

    let from: Position = cursor
    let rewound = false
    if ((await hashAt(tx, cursor.b)) !== cursor.h) {
      rewound = true
      from = { b: Math.min(Math.max(cursor.b - WATCH_REWIND_BLOCKS, floor ?? 0), tip.number), k: -1, i: 0, w: '' }
    }

    const end = await windowEnd(tx, from.b, tip.number)
    if (!end) return page([], rewound ? endOf(tip) : cursor, rewound)

    const watched = rowsOf<{ address: string }>(await tx.execute(
      sql`SELECT address FROM watch_addresses WHERE owner_address = ${owner}`)).map((r) => r.address)
    if (watched.length === 0) return page([], endOf(end), rewound)

    // The timestamps around the window, so each arm can walk its (address, timestamp) index (as /api/v1/query's
    // blockTimeBounds): every row at or after block `from.b` is no older than the newest block at or before it.
    const [bounds] = rowsOf<{ lo: Date | null; hi: Date | null }>(await tx.execute(sql`
      SELECT (SELECT timestamp FROM blocks WHERE number <= ${from.b} ORDER BY number DESC LIMIT 1) AS lo,
             (SELECT timestamp FROM blocks WHERE number >= ${end.number} ORDER BY number LIMIT 1) AS hi`))

    const found = rowsOf<WatchRow>(await tx.execute(feedSql(watched, from, end.number, bounds ?? { lo: null, hi: null }, limit + 1)))
    const events = found.slice(0, limit).map(toWatchEvent)
    if (found.length <= limit) return page(events, endOf(end), rewound)
    const last = found[limit - 1]
    return page(events, {
      b: Number(last.block_number), h: last.block_hash, k: Number(last.kind) as 0 | 1, i: Number(last.idx), w: last.watched,
    }, rewound)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
