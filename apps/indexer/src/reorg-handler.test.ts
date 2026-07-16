import { describe, expect, it } from 'vitest'
import {
  detectReorg, resolveReorgDepth, UNWIND_ORDER, type ReorgDeps,
} from './reorg-handler'
import { schema } from '@altscan/db'
import { getTableColumns } from 'drizzle-orm'

/** Fake chain state: stored = what our DB has, rpc = canonical chain. */
function deps(stored: Record<number, string>, rpc: Record<number, { hash: string; parentHash: string }>): ReorgDeps {
  return {
    storedHash: async (n) => stored[n] ?? null,
    rpcBlock: async (n) => rpc[n] ?? null,
  }
}

describe('detectReorg', () => {
  const K = 5
  it('no stored parent (fresh DB / gap) → not a reorg', async () => {
    const d = deps({}, { 11: { hash: 'b11', parentHash: 'b10' } })
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: false })
  })
  it('boundary parent matches → not a reorg', async () => {
    const d = deps({ 10: 'b10' }, { 11: { hash: 'b11', parentHash: 'b10' } })
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: false })
  })
  it('boundary parent mismatch → walks back to the last agreeing block', async () => {
    const d = deps(
      { 8: 'b8', 9: 'x9', 10: 'x10' },
      { 8: { hash: 'b8', parentHash: 'b7' }, 9: { hash: 'b9', parentHash: 'b8' }, 10: { hash: 'b10', parentHash: 'b9' }, 11: { hash: 'b11', parentHash: 'b10' } },
    )
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: true, forkPoint: 8 })
  })
  it('tip mode: next block absent on RPC, tip hash mismatch → reorg', async () => {
    const d = deps(
      { 9: 'b9', 10: 'x10' },
      { 9: { hash: 'b9', parentHash: 'b8' }, 10: { hash: 'b10', parentHash: 'b9' } },
    )
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: true, forkPoint: 9 })
  })
  it('tip mode: next block absent, tip hash matches → not a reorg', async () => {
    const d = deps({ 10: 'b10' }, { 10: { hash: 'b10', parentHash: 'b9' } })
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: false })
  })
  it('no agreement within K → bounded fork point at lastIndexed - K', async () => {
    const stored: Record<number, string> = {}
    const rpc: Record<number, { hash: string; parentHash: string }> = {}
    for (let n = 0; n <= 10; n++) { stored[n] = `x${n}`; rpc[n] = { hash: `b${n}`, parentHash: `b${n - 1}` } }
    rpc[11] = { hash: 'b11', parentHash: 'b10' }
    expect(await detectReorg(deps(stored, rpc), 10, K)).toEqual({ isReorg: true, forkPoint: 5 })
  })
  it('missing stored rows inside the walk are skipped, not treated as agreement', async () => {
    const d = deps(
      { 7: 'b7', 9: 'x9', 10: 'x10' },  // 8 missing locally
      { 7: { hash: 'b7', parentHash: 'b6' }, 8: { hash: 'b8', parentHash: 'b7' }, 9: { hash: 'b9', parentHash: 'b8' }, 10: { hash: 'b10', parentHash: 'b9' }, 11: { hash: 'b11', parentHash: 'b10' } },
    )
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: true, forkPoint: 7 })
  })
})

describe('resolveReorgDepth', () => {
  it('uses the env override when valid, else the chain default', () => {
    expect(resolveReorgDepth(15, { REORG_DEPTH: '25' })).toBe(25)
    expect(resolveReorgDepth(15, {})).toBe(15)
    for (const v of ['0', '-3', 'abc', '']) expect(resolveReorgDepth(15, { REORG_DEPTH: v })).toBe(15)
  })
})

describe('UNWIND_ORDER guardrail — every block-scoped table is unwound, children first', () => {
  it('covers exactly the schema tables carrying a block-number column', () => {
    const tables = {
      logs: schema.logs, tokenTransfers: schema.tokenTransfers, dexTrades: schema.dexTrades,
      gasHistory: schema.gasHistory, transactions: schema.transactions, blocks: schema.blocks,
      tokens: schema.tokens, tokenBalances: schema.tokenBalances, addresses: schema.addresses,
    } as const
    const blockScoped = new Set<string>()
    for (const [name, t] of Object.entries(tables)) {
      const cols = Object.keys(getTableColumns(t as never))
      if (cols.includes('blockNumber') || name === 'blocks') blockScoped.add(name)
    }
    expect(new Set(UNWIND_ORDER)).toEqual(blockScoped)
  })
  it('deletes transactions before blocks, and blocks last (FK order)', () => {
    expect(UNWIND_ORDER.indexOf('transactions')).toBeLessThan(UNWIND_ORDER.indexOf('blocks'))
    expect(UNWIND_ORDER[UNWIND_ORDER.length - 1]).toBe('blocks')
    expect(UNWIND_ORDER).toContain('gasHistory')  // the delete the old dead code forgot
  })
})
