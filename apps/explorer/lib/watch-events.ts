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
