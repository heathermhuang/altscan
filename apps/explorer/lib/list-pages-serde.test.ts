import { describe, it, expect } from 'vitest'
import { toCachedTx, toCachedBlock, parseTx, parseBlock } from './list-pages'
import { schema } from '@/lib/db'

/**
 * `unstable_cache` stores its value with `JSON.stringify(result)` and JSON has
 * no BigInt. A `bigint` anywhere in the payload therefore does not degrade —
 * it THROWS inside Next's `cacheNewResult`, which is fire-and-forget, so the
 * page still renders, nothing surfaces to the user, and the cache entry is
 * never written. Measured in production 2026-08-28: `/blocks` returned 16
 * distinct top blocks across 16 requests over 82 s against a 60 s TTL, while
 * both web services logged `unhandledRejection: TypeError: Do not know how to
 * serialize a BigInt` continuously.
 *
 * `blocks.gas_used`, `blocks.gas_limit`, `transactions.gas` and
 * `transactions.gas_used` are the schema's only `mode: 'bigint'` columns, and
 * both cached list queries `select()` every column.
 */

const BIG = 9_007_199_254_740_993n // 2^53 + 1 — Number() cannot hold this exactly

const blockRow: typeof schema.blocks.$inferSelect = {
  number: 118535882,
  hash: '0x' + 'a'.repeat(64),
  parentHash: '0x' + 'b'.repeat(64),
  timestamp: new Date('2026-08-28T07:30:00.000Z'),
  miner: '0x' + 'c'.repeat(40),
  gasUsed: BIG,
  gasLimit: 140_000_000n,
  baseFeePerGas: '0',
  txCount: 142,
  size: 51_234,
}

const txRow: typeof schema.transactions.$inferSelect = {
  hash: '0x' + 'd'.repeat(64),
  blockNumber: 118535882,
  fromAddress: '0x' + 'e'.repeat(40),
  toAddress: '0x' + 'f'.repeat(40),
  value: '5000000000000000000.000000000000000000',
  gas: BIG,
  gasPrice: '1000000000',
  gasUsed: 21_000n,
  input: '0x',
  status: true,
  methodId: null,
  txIndex: 3,
  nonce: 7,
  txType: 2,
  timestamp: new Date('2026-08-28T07:30:00.000Z'),
  bodyPruned: false,
}

describe('cached list-page payloads are JSON-serializable', () => {
  // The real invariant. This is what Next actually does to the value.
  it('a mapped block survives JSON.stringify', () => {
    expect(() => JSON.stringify(toCachedBlock(blockRow))).not.toThrow()
  })

  it('a mapped transaction survives JSON.stringify', () => {
    expect(() => JSON.stringify(toCachedTx(txRow))).not.toThrow()
  })

  // Catches a NEW bigint column added to either table later, which the
  // stringify assertions above would also catch but this names the field.
  it('no mapped field is left as a bigint', () => {
    for (const [k, v] of Object.entries(toCachedBlock(blockRow))) {
      expect(typeof v, `blocks.${k}`).not.toBe('bigint')
    }
    for (const [k, v] of Object.entries(toCachedTx(txRow))) {
      expect(typeof v, `transactions.${k}`).not.toBe('bigint')
    }
  })

  // A `Number()` fix would pass the two tests above and silently corrupt any
  // gas value past 2^53. Round-tripping through JSON is the only check that
  // proves the cache returns the row the database gave us.
  it('a full JSON round-trip preserves bigint values exactly', () => {
    const block = parseBlock(JSON.parse(JSON.stringify(toCachedBlock(blockRow))))
    expect(block.gasUsed).toBe(BIG)
    expect(block.gasLimit).toBe(140_000_000n)
    expect(block.timestamp.toISOString()).toBe('2026-08-28T07:30:00.000Z')

    const tx = parseTx(JSON.parse(JSON.stringify(toCachedTx(txRow))))
    expect(tx.gas).toBe(BIG)
    expect(tx.gasUsed).toBe(21_000n)
    expect(tx.value).toBe('5000000000000000000.000000000000000000')
    expect(tx.timestamp.toISOString()).toBe('2026-08-28T07:30:00.000Z')
  })
})
