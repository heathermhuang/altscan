import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

// Mocks are hoisted. The db is a recorder: it hands back canned rows per table and remembers which
// tables were read, so "the base-fee lookup ran" is observable. Nothing here touches a network or a database.
const state = vi.hoisted(() => ({
  dbTx: null as Record<string, unknown> | null,
  blockRow: null as { baseFee: string | null } | null,
  tablesRead: [] as unknown[],
  fetchTxFromRpc: vi.fn(),
  fetchBlockFromRpc: vi.fn(),
}))

vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const rowsOf = (table: unknown) => {
    if (table === schema.transactions) return state.dbTx ? [state.dbTx] : []
    if (table === schema.blocks) return state.blockRow ? [state.blockRow] : []
    return []
  }
  // A drizzle query builder is a thenable with .catch; this one is the same shape.
  const query = (rows: unknown[]) => {
    const q = {
      where: () => q, orderBy: () => q, limit: () => q,
      then: (ok: (v: unknown[]) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, bad),
      catch: (bad: (e: unknown) => unknown) => Promise.resolve(rows).catch(bad),
    }
    return q
  }
  return {
    schema,
    db: { select: () => ({ from: (table: unknown) => { state.tablesRead.push(table); return query(rowsOf(table)) } }) },
  }
})
vi.mock('@/lib/rpc-fallback', () => ({ fetchTxFromRpc: state.fetchTxFromRpc, fetchBlockFromRpc: state.fetchBlockFromRpc }))
// Chain tip comes from the node, so the page never falls back to a MAX(blocks.number) read of its own.
vi.mock('@/lib/rpc', () => ({ getWebProvider: async () => ({ getBlockNumber: async () => 1_000_000 }) }))
vi.mock('@/lib/body-cache', () => ({ getTxBody: vi.fn(async () => null) }))
vi.mock('@/lib/block-strip', () => ({ getBlockStrip: vi.fn(async () => null) }))
vi.mock('@/lib/observability', async (orig) => ({
  ...(await orig<typeof import('@/lib/observability')>()),
  swallow: vi.fn(),
  swallowed: <T,>(_tag: string, fallback: T) => () => fallback,
}))

import { schema } from '@/lib/db'
import { Badge } from '@/components/ui/Badge'
import TxDetailPage from './page'

const HASH = '0x' + 'ab'.repeat(32)
const render = () => TxDetailPage({ params: Promise.resolve({ hash: HASH }) })

// Find an element by component type anywhere in the returned tree (function components are not called).
// The status Badge sits in a Fact's children, which this walks.
function find(node: ReactNode, type: unknown): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const f = find(n, type); if (f) return f } return null }
  const el = node as { type?: unknown; props?: { children?: ReactNode } }
  if (el.type === type) return el as { props: Record<string, unknown> }
  return find(el.props?.children, type)
}

const rpcTx = (over: Record<string, unknown>) => ({
  hash: HASH, blockNumber: 0, fromAddress: '0x' + '11'.repeat(20), toAddress: '0x' + '22'.repeat(20), value: '0',
  gas: 21_000n, gasPrice: '5000000000', gasUsed: 0n, input: '0x', status: true, pending: true,
  methodId: null, txIndex: 0, nonce: 1, txType: 2, timestamp: new Date('2026-10-10T00:00:00.000Z'), _fromRpc: true,
  ...over,
})
const indexedTx = () => ({
  hash: HASH, blockNumber: 777, fromAddress: '0x' + '11'.repeat(20), toAddress: '0x' + '22'.repeat(20), value: '0',
  gas: 21_000n, gasPrice: '5000000000', gasUsed: 21_000n, input: '0x', status: true, methodId: null, txIndex: 3,
  nonce: 1, txType: 2, timestamp: new Date('2026-10-10T00:00:00.000Z'), bodyPruned: false,
})

beforeEach(() => {
  state.dbTx = null; state.blockRow = null; state.tablesRead = []
  state.fetchTxFromRpc.mockReset(); state.fetchBlockFromRpc.mockReset()
  state.fetchBlockFromRpc.mockResolvedValue(null)
  vi.stubGlobal('fetch', async () => ({ ok: false }))   // native price: every source "down", the page renders without USD
})

describe('/tx/[hash] base-fee lookup', () => {
  it('a pending tx that is in no block runs neither the blocks select nor fetchBlockFromRpc', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 0, pending: true }))
    await render()
    expect(state.tablesRead).not.toContain(schema.blocks)
    expect(state.fetchBlockFromRpc).not.toHaveBeenCalled()
  })

  it('a tx in a block reads the block row first, and asks the node only when the row has no base fee', async () => {
    state.dbTx = indexedTx()
    state.blockRow = { baseFee: '3000000000' }
    await render()
    expect(state.tablesRead).toContain(schema.blocks)
    expect(state.fetchBlockFromRpc).not.toHaveBeenCalled()

    state.tablesRead = []
    state.blockRow = null
    await render()
    expect(state.tablesRead).toContain(schema.blocks)
    expect(state.fetchBlockFromRpc).toHaveBeenCalledTimes(1)
    expect(state.fetchBlockFromRpc).toHaveBeenCalledWith(777)
  })

  it('a tx the node has put in a block but not yet receipted is still looked up: its block is real', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 778, pending: true }))
    await render()
    expect(state.tablesRead).toContain(schema.blocks)
    expect(state.fetchBlockFromRpc).toHaveBeenCalledWith(778)
  })
})

describe('/tx/[hash] status badge', () => {
  it('a pending tx wears the pending badge, not the plain default one', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 0, pending: true }))
    const badge = find(await render(), Badge)
    expect(badge?.props.variant).toBe('pending')
    expect(badge?.props.children).toBe('Pending')
  })

  it('success and failed keep their own badges', async () => {
    state.dbTx = { ...indexedTx(), status: true }
    expect(find(await render(), Badge)?.props.variant).toBe('success')
    state.dbTx = { ...indexedTx(), status: false }
    expect(find(await render(), Badge)?.props.variant).toBe('fail')
  })
})
