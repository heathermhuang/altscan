import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const { getBlockStrip, createPageCache, fetchTxPage } = vi.hoisted(() => ({
  getBlockStrip: vi.fn(),
  createPageCache: vi.fn((_name: string, _ttl: number, query: unknown) => query),
  fetchTxPage: vi.fn(),
}))
vi.mock('@/lib/page-cache', () => ({ createPageCache }))
vi.mock('@/lib/block-strip', () => ({ getBlockStrip }))
vi.mock('@/lib/list-pages', async (orig) => ({ ...(await orig<typeof import('@/lib/list-pages')>()), fetchTxPage }))

import TransactionsPage from './page'
import { BlockStrip } from '@/components/tape/BlockStrip'

function find(node: ReactNode, type: unknown): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const f = find(n, type); if (f) return f } return null }
  const el = node as { type?: unknown; props?: { children?: ReactNode } }
  if (el.type === type) return el as { props: Record<string, unknown> }
  return find(el.props?.children, type)
}
const render = (page?: string) => TransactionsPage({ searchParams: Promise.resolve(page ? { page } : {}) })

// One cached row, as `fetchTxPage` returns it (parseTx rehydrates the BigInts and the date).
const row = (blockNumber: number) => ({
  hash: '0x' + 'ab'.repeat(32), blockNumber, timestamp: '2026-10-06T00:00:00.000Z', gas: '21000', gasUsed: '21000',
  fromAddress: '0x' + '11'.repeat(20), toAddress: '0x' + '22'.repeat(20), value: '0', status: true, txIndex: 0,
})
const STRIP = { txs: [{ i: 0, gas: 21_000, price: 5, ok: true }], gasLimit: 1_000_000 }

beforeEach(() => {
  getBlockStrip.mockReset(); fetchTxPage.mockReset()
  fetchTxPage.mockResolvedValue({ rows: [row(777), row(776)], total: 100 })
  getBlockStrip.mockResolvedValue(STRIP)
})

describe('/txs strip', () => {
  it('reads through the page cache: module scope, the table\'s TTL, the block number is an argument', () => {
    expect(createPageCache).toHaveBeenCalledWith('txs-strip', 45, getBlockStrip)
    expect(createPageCache.mock.calls.filter(c => c[0] === 'txs-strip')).toHaveLength(1)   // once at import, never per request
  })

  it('page 1 draws the strip of the first row\'s block', async () => {
    const strip = find(await render(), BlockStrip)
    expect(getBlockStrip).toHaveBeenCalledWith(777)
    expect(strip?.props).toMatchObject({ blockNumber: 777, gasLimit: 1_000_000, txs: STRIP.txs })
    expect(strip?.props.current).toBeUndefined()
  })

  it('page 2 draws none and does not query one', async () => {
    expect(find(await render('2'), BlockStrip)).toBeNull()
    expect(getBlockStrip).not.toHaveBeenCalled()
  })

  it('a block that cannot be drawn (null) renders no band', async () => {
    getBlockStrip.mockResolvedValue(null)
    expect(find(await render(), BlockStrip)).toBeNull()
  })

  it('an empty page (failed table query) renders no band', async () => {
    fetchTxPage.mockRejectedValue(new Error('db down'))
    expect(find(await render(), BlockStrip)).toBeNull()
    expect(getBlockStrip).not.toHaveBeenCalled()
  })
})
