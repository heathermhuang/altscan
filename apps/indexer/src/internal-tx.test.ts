import { describe, it, expect, vi } from 'vitest'
import type { JsonRpcProvider } from 'ethers'
import { decodeCallTracerBlock, fetchBlockTraces, prepareInternalTxRows, type RawTraceTx } from './internal-tx'

/**
 * Real ETH mainnet `debug_traceBlockByNumber` (callTracer) output for block
 * 25922443, one transaction, captured 2026-09-07 with `input`/`output` stripped
 * (the decoder never reads them). The shape it pins:
 *
 *   top      CALL         0x719a → 0x97cc  value V   ← the outer tx, NOT internal
 *   0        CALL         0x97cc → 0x5c7b  value V   ← internal transfer
 *   0.0      DELEGATECALL 0x5c7b → 0x456a  value V   ← inherited context, NOT a transfer
 *   0.0.0    CALL         0x5c7b → 0xc02a  value V   ← internal transfer (WETH deposit)
 *
 * The DELEGATECALL carries the parent's `value` field — that is the trap. It moves
 * nothing, and counting it would double the amount shown for this transaction.
 */
const V = '0x2a4e72992dc740000' // 48.776 ETH
const FIXTURE: RawTraceTx = {
  txHash: '0x98971f4d995d33c731153366d2d5c2c9de8d869de038abab658abf967e7ac177',
  result: {
    from: '0x719a90e5b09d993937e6d6e7d6b85aca078c3ba7',
    to: '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4',
    value: V,
    type: 'CALL',
    calls: [{
      from: '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4',
      to: '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5',
      value: V,
      type: 'CALL',
      calls: [{
        from: '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5',
        to: '0x456ac26e5ec083ee9889eba0d1a0a582502b8e84',
        value: V,
        type: 'DELEGATECALL',
        calls: [{
          from: '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5',
          to: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          value: V,
          type: 'CALL',
        }],
      }],
    }],
  },
}

const BLOCK = 25922443
const TS = new Date('2026-09-07T00:00:00Z')

describe('decodeCallTracerBlock — real mainnet fixture', () => {
  it('yields exactly the two value-moving CALL frames, in trace order', () => {
    const rows = decodeCallTracerBlock([FIXTURE], BLOCK, TS)
    expect(rows.map(r => r.traceAddress)).toEqual(['0', '0.0.0'])
    expect(rows.map(r => r.callType)).toEqual(['call', 'call'])
    expect(rows[0]).toMatchObject({
      txHash: FIXTURE.txHash,
      fromAddress: '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4',
      toAddress: '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5',
      value: '48776000000000000000',
      blockNumber: BLOCK,
      timestamp: TS,
    })
    expect(rows[1].toAddress).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  })

  it('never emits the top-level frame (that is the transaction itself)', () => {
    const rows = decodeCallTracerBlock([FIXTURE], BLOCK, TS)
    expect(rows.some(r => r.traceAddress === '')).toBe(false)
    expect(rows.some(r => r.fromAddress === FIXTURE.result!.from)).toBe(false)
  })

  it('does not count a DELEGATECALL even though callTracer stamps it with a value', () => {
    const rows = decodeCallTracerBlock([FIXTURE], BLOCK, TS)
    expect(rows.some(r => r.traceAddress === '0.0')).toBe(false)
  })
})

describe('decodeCallTracerBlock — synthetic edge cases', () => {
  const tx = (result: RawTraceTx['result'], txHash = '0x' + 'ab'.repeat(32)): RawTraceTx => ({ txHash, result })
  const frame = (over: Partial<NonNullable<RawTraceTx['result']>>) => ({
    from: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    to: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    value: '0x1',
    type: 'CALL',
    ...over,
  })

  it('skips zero-value and value-less frames', () => {
    const rows = decodeCallTracerBlock([tx(frame({ calls: [
      frame({ value: '0x0' }),
      frame({ value: undefined }),
      frame({ value: '0x5' }),
    ] }))], BLOCK, TS)
    expect(rows.map(r => [r.traceAddress, r.value])).toEqual([['2', '5']])
  })

  it('skips STATICCALL and DELEGATECALL, keeps CALL/CALLCODE/CREATE/CREATE2/SELFDESTRUCT', () => {
    const types = ['STATICCALL', 'DELEGATECALL', 'CALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT']
    const rows = decodeCallTracerBlock([tx(frame({ calls: types.map(type => frame({ type })) }))], BLOCK, TS)
    expect(rows.map(r => r.callType)).toEqual(['call', 'callcode', 'create', 'create2', 'selfdestruct'])
    expect(rows.map(r => r.traceAddress)).toEqual(['2', '3', '4', '5', '6'])
  })

  it('drops a reverted frame AND everything beneath it — a reverted subtree moved no value', () => {
    const rows = decodeCallTracerBlock([tx(frame({ calls: [
      frame({ error: 'execution reverted', calls: [frame({}), frame({ calls: [frame({})] })] }),
      frame({}),
    ] }))], BLOCK, TS)
    expect(rows.map(r => r.traceAddress)).toEqual(['1'])
  })

  it('a reverted OUTER transaction yields nothing', () => {
    const rows = decodeCallTracerBlock([tx(frame({ error: 'out of gas', calls: [frame({})] }))], BLOCK, TS)
    expect(rows).toEqual([])
  })

  it('lowercases addresses and tolerates a missing `to` (failed-but-unreported create)', () => {
    const rows = decodeCallTracerBlock([tx(frame({ calls: [frame({ type: 'CREATE', to: undefined })] }))], BLOCK, TS)
    expect(rows).toHaveLength(1)
    expect(rows[0].fromAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(rows[0].toAddress).toBeNull()
  })

  it('skips a transaction entry with no result (node-level per-tx error) and keeps the rest', () => {
    const rows = decodeCallTracerBlock([
      { txHash: '0x' + '11'.repeat(32), error: 'tracing failed' },
      tx(frame({ calls: [frame({})] }), '0x' + '22'.repeat(32)),
    ], BLOCK, TS)
    expect(rows).toHaveLength(1)
    expect(rows[0].txHash).toBe('0x' + '22'.repeat(32))
  })

  it('lowercases the tx hash so it joins the transactions table exactly', () => {
    const rows = decodeCallTracerBlock([tx(frame({ calls: [frame({})] }), '0x' + 'AB'.repeat(32))], BLOCK, TS)
    expect(rows[0].txHash).toBe('0x' + 'ab'.repeat(32))
  })

  it('deep trace addresses are dotted indices, wide enough that string order is NOT numeric order', () => {
    const rows = decodeCallTracerBlock([tx(frame({ calls: Array.from({ length: 11 }, () => frame({})) }))], BLOCK, TS)
    expect(rows.map(r => r.traceAddress)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
  })
})

describe('fetchBlockTraces', () => {
  it('requests debug_traceBlockByNumber with callTracer for the hex block number', async () => {
    const send = vi.fn().mockResolvedValue([FIXTURE])
    const provider = { send } as unknown as JsonRpcProvider
    const raw = await fetchBlockTraces(provider, BLOCK)
    expect(send).toHaveBeenCalledWith('debug_traceBlockByNumber', ['0x18b8b8b', { tracer: 'callTracer' }])
    expect(raw).toEqual([FIXTURE])
  })

  // Same lesson as fetchBlockReceipts: "I don't have this block" must never be
  // read as "this block has no internal transactions". A null here would persist
  // an empty-but-complete-looking block and nothing would ever revisit it.
  it('throws on a null response instead of returning an empty block', async () => {
    const provider = { send: vi.fn().mockResolvedValue(null) } as unknown as JsonRpcProvider
    await expect(fetchBlockTraces(provider, BLOCK)).rejects.toThrow(/traces unavailable/)
  })
})

describe('prepareInternalTxRows — trust and never throw', () => {
  const ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const withValue = (txHash: string | undefined): RawTraceTx => ({
    txHash,
    result: { type: 'CALL', from: ADDR, to: ADDR, value: '0x1', calls: [{ type: 'CALL', from: ADDR, to: ADDR, value: '0x2' }] },
  } as RawTraceTx)

  it('keeps entries for the block\'s own transactions (case-insensitively) and drops foreign ones', () => {
    const own = '0x' + 'ab'.repeat(32)
    const out = prepareInternalTxRows([withValue(own.toUpperCase().replace('0X', '0x')), withValue('0x' + 'ee'.repeat(32))], BLOCK, TS, [own])
    expect(out.rows.map(r => r.txHash)).toEqual([own])
    expect(out.dropped).toBe(1)
    expect(out.problem).toBeNull()
  })

  it('a wholly foreign answer (another block\'s traces) decodes to nothing', () => {
    const out = prepareInternalTxRows([withValue('0x' + 'ee'.repeat(32))], BLOCK, TS, ['0x' + 'ab'.repeat(32)])
    expect(out).toEqual({ rows: [], dropped: 1, problem: null })
  })

  it('an entry with no txHash is dropped, not thrown on', () => {
    expect(() => prepareInternalTxRows([withValue(undefined)], BLOCK, TS, ['0x' + 'ab'.repeat(32)])).not.toThrow()
    expect(prepareInternalTxRows([withValue(undefined), null as unknown as RawTraceTx], BLOCK, TS, []).dropped).toBe(2)
  })

  it('a malformed frame yields no rows plus the error to report, never a throw', () => {
    const own = '0x' + 'ab'.repeat(32)
    const bad = withValue(own)
    bad.result!.calls![0].value = '0xzz'
    const out = prepareInternalTxRows([bad], BLOCK, TS, [own])
    expect(out.rows).toEqual([])
    expect(out.problem).toBeInstanceOf(Error)
  })
})
