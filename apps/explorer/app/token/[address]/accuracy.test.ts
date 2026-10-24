import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// What the token page tells a reader must be what is known. The real page, with the database, the node and the ad slot
// stubbed (the same harness as token-text.test.ts).
const OTHER = '0x' + '2'.repeat(40)
const BNB_USDT = '0x55d398326f99059ff775485246999027b3197955'
type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  addr: '',
  row: {} as Record<string, unknown>,
  indexed: true,
  adContext: '' as string,
  // What the node answers for a token the index has not seen: a value, or 'fail' for a read that throws (a throttled node).
  rpc: { decimals: 6n, totalSupply: 100_000_000_000_000_000n } as { decimals: bigint | 'fail'; totalSupply: bigint | 'fail' },
  // The indexed token's transfers: rows, 'fail' (the query throws) or 'hang' (it never answers: the page's own timeout).
  transfers: [] as Row[] | 'fail' | 'hang',
  count: 0 as number | 'fail',
}))
const tokenRow = (address: string, symbol: string, name: string) => ({
  address, name, symbol, type: 'BEP20', decimals: 18,
  totalSupply: '1000000000000000000000', holderCount: 1234, logoUrl: null,
})

vi.mock('@/lib/db', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'limit']) query[m] = () => query
  query.then = (resolve: (r: unknown) => unknown) => resolve(h.indexed ? [h.row] : [])
  return { db: { select: () => query }, schema: { tokens: {}, tokenTransfers: {} } }
})
vi.mock('@/lib/token-transfers-query', () => ({
  TOKEN_TRANSFERS_MAX_ROWS: 10_000,
  selectTokenTransfers: async () => {
    if (h.transfers === 'hang') return new Promise<Row[]>(() => {})
    if (h.transfers === 'fail') throw new Error('canceling statement due to statement timeout')
    return h.transfers
  },
  countTokenTransfers: async () => {
    if (h.count === 'fail') throw new Error('canceling statement due to statement timeout')
    return [{ value: h.count }]
  },
}))
vi.mock('@/lib/market-data', () => ({ getTokenMarketData: async () => null }))
vi.mock('@/lib/holders', () => ({ getTokenHolders: async () => ({ holders: [], holderCount: null, source: 'local' }), EMPTY_HOLDERS: { holders: [] } }))
vi.mock('@/lib/token-risk', () => ({ analyzeTokenRisk: async () => [] }))
vi.mock('@/lib/rpc', () => ({ getWebProvider: () => ({}) }))
vi.mock('ethers', async (orig) => {
  const real = await orig<typeof import('ethers')>()
  const read = <T>(v: T | 'fail') => async () => { if (v === 'fail') throw new Error('missing response'); return v }
  return {
    ...real,
    Contract: class {
      name = async () => 'Tether USD'
      symbol = async () => 'USDT'
      decimals = read(h.rpc.decimals)
      totalSupply = read(h.rpc.totalSupply)
    },
  }
})
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: (p: { context: string }) => { h.adContext = p.context; return null } }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

const render = async (address = h.addr) => {
  const page = await import('./page')
  return renderToStaticMarkup(await page.default({ params: Promise.resolve({ address }), searchParams: Promise.resolve({}) }))
}

beforeEach(() => {
  vi.resetModules()
  h.indexed = true
  h.adContext = ''
  h.rpc = { decimals: 6n, totalSupply: 100_000_000_000_000_000n }
  h.transfers = []
  h.count = 0
})

// The stablecoin CTA used to match "usdt", "dai", ... anywhere in a token's symbol or name, so anyone could earn it by
// naming a token "BabyUSDT" or "Daisy". It is now the chain's configured stablecoin contracts only.
describe('token page: the stablecoin referral context', () => {
  const contextFor = async (address: string, symbol: string, name: string) => {
    h.row = tokenRow(address, symbol, name)
    await render(address)
    return h.adContext
  }

  it('is "stablecoin" for the real USDT contract', async () => {
    expect(await contextFor(BNB_USDT, 'USDT', 'Tether USD')).toBe('stablecoin')
  })

  it('is "token_research" for a token that only has a stablecoin\'s word in its name', async () => {
    expect(await contextFor(OTHER, 'BabyUSDT', 'Baby Tether')).toBe('token_research')
    expect(await contextFor(OTHER, 'USDT2', 'USDT 2.0')).toBe('token_research')
    expect(await contextFor(OTHER, 'DAISY', 'Daisy')).toBe('token_research')
  })

  it('is "token_research" for a lookalike USDT', async () => {
    expect(await contextFor(OTHER, 'USDT', 'Tether USD')).toBe('token_research')
  })
})

// A token the index has not seen is read live from the node. A decimals() or totalSupply() read that fails is UNKNOWN: it
// used to become 18 and 0, which printed ETH USDT (6 decimals) as "18" decimals with a supply of "0".
describe('token page: a live token whose reads failed', () => {
  const fact = (html: string, label: string) => html.match(new RegExp(`<dt class="k">${label}</dt><dd[^>]*>(.*?)</dd>`))?.[1]
  const live = async () => {
    h.indexed = false
    return render(OTHER)
  }

  it('reads the decimals and the supply the node answered', async () => {
    const html = await live()
    expect(fact(html, 'Decimals')).toBe('6')
    expect(fact(html, 'Total Supply')).toBe((100_000_000_000n).toLocaleString())
  })

  it('shows unknown decimals as "—" and the supply as labelled raw units, not 18 and not 0', async () => {
    h.rpc = { decimals: 'fail', totalSupply: 100_000_000_000_000_000n }
    const html = await live()
    expect(fact(html, 'Decimals')).toBe('—')
    expect(fact(html, 'Total Supply')).toBe('100,000,000,000,000,000 raw units')
  })

  it('shows an unread supply as "—"', async () => {
    h.rpc = { decimals: 6n, totalSupply: 'fail' }
    const html = await live()
    expect(fact(html, 'Decimals')).toBe('6')
    expect(fact(html, 'Total Supply')).toBe('—')
  })

  it('shows both as unknown when both reads failed', async () => {
    h.rpc = { decimals: 'fail', totalSupply: 'fail' }
    const html = await live()
    expect([fact(html, 'Decimals'), fact(html, 'Total Supply')]).toEqual(['—', '—'])
  })
})

// The transfers query is time-boxed and its failure is swallowed so the rest of the page still renders. That fallback was an
// empty list, so a failed or timed-out query printed "No transfers yet." for a token that has millions.
describe('token page: the transfers table when the query did not answer', () => {
  const UNAVAILABLE = 'Transfers are temporarily unavailable. Try again shortly.'
  const tbody = (html: string) => html.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? ''
  const transfer = { txHash: '0x' + 'b'.repeat(64), logIndex: 1, blockNumber: 100, fromAddress: OTHER, toAddress: OTHER, tokenAddress: OTHER, value: '1500000000000000000' }
  beforeEach(() => { h.row = tokenRow(OTHER, 'CAKE', 'PancakeSwap Token') })

  it('says "No transfers yet." only when the query succeeded and found nothing', async () => {
    const body = tbody(await render(OTHER))
    expect(body).toContain('No transfers yet.')
    expect(body).not.toContain('temporarily unavailable')
  })

  it('says it is unavailable when the query failed', async () => {
    h.transfers = 'fail'
    h.count = 'fail'
    const body = tbody(await render(OTHER))
    expect(body).toContain(UNAVAILABLE)
    expect(body).not.toContain('No transfers yet.')
  })

  it('says it is unavailable when the query timed out', async () => {
    vi.useFakeTimers()
    try {
      h.transfers = 'hang'
      const html = render(OTHER)
      await vi.advanceTimersByTimeAsync(6_500)
      const body = tbody(await html)
      expect(body).toContain(UNAVAILABLE)
      expect(body).not.toContain('No transfers yet.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says it is unavailable when the count found transfers but the page came back empty', async () => {
    h.transfers = []
    h.count = 7
    const body = tbody(await render(OTHER))
    expect(body).toContain(UNAVAILABLE)
    expect(body).not.toContain('No transfers yet.')
  })

  it('lists the rows, with no message, when the query answered', async () => {
    h.transfers = [transfer]
    h.count = 1
    const body = tbody(await render(OTHER))
    expect(body).toContain('/tx/' + transfer.txHash)
    expect(body).not.toContain('No transfers yet.')
    expect(body).not.toContain('temporarily unavailable')
  })
})
