import { describe, expect, it } from 'vitest'
import { toWatchEvent, type WatchEvent, type WatchRow } from './watch-events'

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const USDT = '0x' + '5'.repeat(40)
const row = (over: Partial<WatchRow>): WatchRow => ({
  block_number: '12345678', block_hash: '0x' + 'f'.repeat(64), tx_hash: '0x' + 'e'.repeat(64),
  kind: 0, idx: 3, watched: A, from_address: A, to_address: B,
  value: '1500000000000000000.000000000000000000', token_address: null, symbol: null, decimals: null,
  timestamp: new Date('2026-11-15T03:00:00Z'),
  ...over,
})

const tokenOf = (r: WatchRow) => (toWatchEvent(r) as Extract<WatchEvent, { type: 'token' }>).token

describe('toWatchEvent', () => {
  it('maps a native transfer, converting the numeric(78,18) value to a wei integer string', () => {
    expect(toWatchEvent(row({}))).toEqual({
      type: 'native', direction: 'out', watched: A,
      blockNumber: 12345678, blockHash: '0x' + 'f'.repeat(64), timestamp: '2026-11-15T03:00:00.000Z',
      txHash: '0x' + 'e'.repeat(64), txIndex: 3, from: A, to: B, value: '1500000000000000000',
    })
  })

  it('maps a token transfer with its metadata', () => {
    const e = toWatchEvent(row({ kind: 1, idx: 7, watched: B, value: '42', token_address: USDT, symbol: 'USDT', decimals: 18 }))
    expect(e).toMatchObject({ type: 'token', direction: 'in', logIndex: 7, value: '42', token: { address: USDT, symbol: 'USDT', decimals: 18 } })
    expect(e).not.toHaveProperty('txIndex')
  })

  it('reports unknown token metadata as null, including the indexer\'s "???" placeholder', () => {
    expect(tokenOf(row({ kind: 1, token_address: USDT }))).toEqual({ address: USDT, symbol: null, decimals: null })
    expect(tokenOf(row({ kind: 1, token_address: USDT, symbol: '???', decimals: 18 }))).toEqual({ address: USDT, symbol: null, decimals: null })
  })

  it('marks a transfer to itself as self', () => {
    expect(toWatchEvent(row({ to_address: A })).direction).toBe('self')
  })
})
