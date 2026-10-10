import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chainConfig } from '@/lib/chain'

// The homepage's price path: its Price and Market Cap cards read the quote lib/native-price returns, and it
// has no price chain of its own. The page is an async server component, so it is awaited for its element
// tree (nothing is rendered) and the StatCards are read off that.
const { fetchNativeQuote } = vi.hoisted(() => ({ fetchNativeQuote: vi.fn() }))
vi.mock('@/lib/native-price', () => ({ fetchNativeQuote }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  // db.select().from().orderBy().limit().catch(): every query answers with no rows.
  const query: Record<string, unknown> = {}
  for (const m of ['from', 'orderBy', 'limit']) query[m] = () => query
  query.catch = () => Promise.resolve([])
  return { db: { select: () => query, execute: async () => [] }, schema }
})

import HomePage from '@/app/page'

type El = { type?: { name?: string }; props?: { children?: unknown; [k: string]: unknown } }
function cards(node: unknown, out: Record<string, Record<string, unknown>> = {}) {
  if (Array.isArray(node)) node.forEach((n) => cards(n, out))
  else if (node && typeof node === 'object') {
    const el = node as El
    if (el.type?.name === 'StatCard' && typeof el.props?.label === 'string') out[el.props.label] = el.props
    cards(el.props?.children, out)
  }
  return out
}
const home = async () => cards(await HomePage())

beforeEach(() => {
  fetchNativeQuote.mockReset()
  // The page's separate best-effort market-cap read goes to the network; none of it answers here.
  vi.stubGlobal('fetch', async () => ({ ok: false }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('HomePage price path', () => {
  const PRICE = `${chainConfig.currency} Price`
  const CAP = `${chainConfig.currency} Market Cap`

  it('shows the price and 24h change from lib/native-price', async () => {
    fetchNativeQuote.mockResolvedValue({ usd: 612.5, change24h: -1.234 })
    const c = await home()
    expect(fetchNativeQuote).toHaveBeenCalledTimes(1)
    expect(c[PRICE]).toMatchObject({ value: '$612.50', subtext: '-1.23%', subtextPositive: false })
  })

  it('writes a rise with a plus sign', async () => {
    fetchNativeQuote.mockResolvedValue({ usd: 1234.5, change24h: 2 })
    expect((await home())[PRICE]).toMatchObject({ value: '$1,234.50', subtext: '+2.00%', subtextPositive: true })
  })

  it('derives the market cap from that price and carries its 24h change', async () => {
    fetchNativeQuote.mockResolvedValue({ usd: 600, change24h: 4 })
    expect((await home())[CAP]).toMatchObject({ value: expect.stringMatching(/^\$[\d.]+[KMBT]$/), subtext: '+4.00%', subtextPositive: true })
  })

  it('labels a price it does not have: "—" and no change, never a made-up number', async () => {
    fetchNativeQuote.mockResolvedValue(null)
    const c = await home()
    expect(c[PRICE]).toMatchObject({ value: '—', subtext: null, subtextPositive: null })
    expect(c[CAP]).toMatchObject({ value: '—', subtext: null })
  })
})
