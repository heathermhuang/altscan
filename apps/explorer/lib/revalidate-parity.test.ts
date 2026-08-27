import { describe, it, expect } from 'vitest'
import { TXS_REVALIDATE_SECONDS, BLOCKS_REVALIDATE_SECONDS } from '@/lib/list-pages'
import { DEX_REVALIDATE_SECONDS } from '@/lib/dex-page'
import { revalidate as txsRevalidate } from '@/app/txs/page'
import { revalidate as blocksRevalidate } from '@/app/blocks/page'
import { revalidate as dexRevalidate } from '@/app/dex/page'
import { revalidate as whalesRevalidate } from '@/app/whales/page'
import { WHALES_REVALIDATE_SECONDS } from '@/lib/whales'

describe('page revalidate matches the data-cache TTL', () => {
  // These have to be duplicated: Next statically analyses route segment config
  // and rejects an imported identifier — `export const revalidate = X` fails the
  // BUILD with "Unknown identifier at revalidate". That failure is invisible to
  // typecheck AND to the test suite, because CI never builds the explorer; it
  // only shows up on Render, after merge. So the duplication is pinned here.
  it.each([
    ['/txs', txsRevalidate, TXS_REVALIDATE_SECONDS],
    ['/blocks', blocksRevalidate, BLOCKS_REVALIDATE_SECONDS],
    ['/dex', dexRevalidate, DEX_REVALIDATE_SECONDS],
    ['/whales', whalesRevalidate, WHALES_REVALIDATE_SECONDS],
  ])('%s', (_route, pageValue, cacheValue) => {
    expect(pageValue).toBe(cacheValue)
  })

  it.each([
    ['/txs', txsRevalidate],
    ['/blocks', blocksRevalidate],
    ['/dex', dexRevalidate],
    ['/whales', whalesRevalidate],
  ])('%s exports a plain number, which is what Next requires', (_route, value) => {
    expect(typeof value).toBe('number')
    expect(Number.isFinite(value)).toBe(true)
  })
})
