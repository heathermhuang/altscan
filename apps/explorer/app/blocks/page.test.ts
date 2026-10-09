import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

// Mocks are hoisted: the cache wrapper is replaced by a recorder that hands back the query itself,
// so what the page passes to createPageCache (name, TTL, the THROWING query) is observable.
const { queryRecentTape, createPageCache, swallow, fetchBlockPage } = vi.hoisted(() => ({
  queryRecentTape: vi.fn(),
  createPageCache: vi.fn((_name: string, _ttl: number, query: unknown) => query),
  swallow: vi.fn(),
  fetchBlockPage: vi.fn(async () => ({ rows: [], total: 0 })),
}))
vi.mock('@/lib/page-cache', () => ({ createPageCache }))
vi.mock('@/lib/recent-tape', () => ({ queryRecentTape }))
vi.mock('@/lib/observability', () => ({ swallow }))
vi.mock('@/lib/list-pages', async (orig) => ({ ...(await orig<typeof import('@/lib/list-pages')>()), fetchBlockPage }))

import BlocksPage from './page'
import { BlockTape } from '@/components/home/BlockTape'

// Find an element by component type anywhere in the returned tree (function components are not called).
function find(node: ReactNode, type: unknown): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const f = find(n, type); if (f) return f } return null }
  const el = node as { type?: unknown; props?: { children?: ReactNode } }
  if (el.type === type) return el as { props: Record<string, unknown> }
  return find(el.props?.children, type)
}
const render = (page?: string) => BlocksPage({ searchParams: Promise.resolve(page ? { page } : {}) })

beforeEach(() => { queryRecentTape.mockReset(); swallow.mockReset(); fetchBlockPage.mockClear() })

describe('/blocks tape', () => {
  it('reads through the page cache: module scope, the table\'s TTL, the throwing query', () => {
    expect(createPageCache).toHaveBeenCalledWith('blocks-tape', 60, queryRecentTape)
    // once at import, never per request (list-pages builds its own two caches the same way)
    expect(createPageCache.mock.calls.filter(c => c[0] === 'blocks-tape')).toHaveLength(1)
  })

  it('draws on page 1', async () => {
    queryRecentTape.mockResolvedValue('TAPE')
    const tape = find(await render(), BlockTape)
    expect(tape?.props.tape).toBe('TAPE')
    expect(queryRecentTape).toHaveBeenCalledTimes(1)
  })

  it('is not drawn, and not even queried, on a later page', async () => {
    queryRecentTape.mockResolvedValue('TAPE')
    const tree = await render('2')
    expect(find(tree, BlockTape)).toBeNull()
    expect(queryRecentTape).not.toHaveBeenCalled()
    expect(fetchBlockPage).toHaveBeenCalledWith(2)
  })

  it('a failed read is logged outside the cache and the page renders without the tape', async () => {
    queryRecentTape.mockRejectedValue(new Error('db down'))
    const tree = await render()
    expect(find(tree, BlockTape)).toBeNull()
    expect(swallow).toHaveBeenCalledWith('blocks/tape', expect.any(Error))
  })

  it('no tape to draw (null) renders no band', async () => {
    queryRecentTape.mockResolvedValue(null)
    expect(find(await render(), BlockTape)).toBeNull()
    expect(swallow).not.toHaveBeenCalled()
  })
})
