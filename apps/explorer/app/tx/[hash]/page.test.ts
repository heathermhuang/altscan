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
import { getBlockStrip } from '@/lib/block-strip'
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

// ---- position in block ---------------------------------------------------------------------------

// All the text under a node (function components are not called, so this is what the page itself wrote).
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf((node as { props?: { children?: ReactNode } }).props?.children)
}

function findAll(node: ReactNode, pred: (props: Record<string, unknown>) => boolean, out: Record<string, unknown>[] = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  const props = (node as { props?: Record<string, unknown> }).props
  if (props && pred(props)) out.push(props)
  findAll(props?.children as ReactNode, pred, out)
  return out
}

const stripOf = (indices: number[]) => ({ gasLimit: 30_000_000, txs: indices.map(i => ({ i, gas: 21_000, price: 5e9, ok: true })) })
const eyebrow = (tree: ReactNode) => textOf(findAll(tree, p => p.className === 'k')[0]?.children as ReactNode)
const positionRow = (tree: ReactNode) => findAll(tree, p => p.label === 'Position In Block')[0]?.value

describe('/tx/[hash] position in block', () => {
  it('says the same 1-based place in the eyebrow and the table, against one fixture', async () => {
    state.dbTx = { ...indexedTx(), txIndex: 25 }              // tx_index is 0-based: this is the 26th
    vi.mocked(getBlockStrip).mockResolvedValueOnce(stripOf(Array.from({ length: 75 }, (_, i) => i)))
    const tree = await render()
    expect(eyebrow(tree)).toContain('26th of 75 in block 777')
    expect(positionRow(tree)).toBe('26 of 75')
  })

  it('counts by the strip position, so both agree even where tx_index skips', async () => {
    state.dbTx = { ...indexedTx(), txIndex: 3 }                // indices 0,1,3,4: the 3rd of 4
    vi.mocked(getBlockStrip).mockResolvedValueOnce(stripOf([0, 1, 3, 4]))
    const tree = await render()
    expect(eyebrow(tree)).toContain('3rd of 4 in block 777')
    expect(positionRow(tree)).toBe('3 of 4')
  })

  it('without the block strip the table is still 1-based, with no total it cannot know', async () => {
    state.dbTx = { ...indexedTx(), txIndex: 3 }                // getBlockStrip is null by default
    const tree = await render()
    expect(eyebrow(tree)).not.toContain(' in block ')
    expect(positionRow(tree)).toBe('4')
  })

  it('a pending tx has no position', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 0, pending: true }))
    expect(positionRow(await render())).toBeUndefined()
  })
})
