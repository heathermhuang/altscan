import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { shortenAddress } from '@/lib/address-display'

// A token's own page prints its symbol in five more places than the header: the transfer rows, the circulating-supply
// line, the table captions, the holders table, and the metadata and breadcrumb JSON-LD that crawlers and link previews
// read. A symbol or name that reads as a URL or handle (lib/link-in-name) is an advert: the header keeps the text with
// the badge (link-in-name.test.ts); everywhere else the token is named by its short address, and nothing is a link to it.
const ADDR = '0x5a110fc00474038f6c02e89c707d638602ea44b5'
const SHORT = shortenAddress(ADDR)
const OTHER = '0x' + '2'.repeat(40)
type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  indexed: true,
  rpc: { name: 'Claim', symbol: 'claim-bnb.xyz' } as { name: string | null; symbol: string | null },
  transfers: [] as Row[],
  market: null as Row | null,
  holders: { holders: [], holderCount: null, source: 'local' } as Row,
}))
const tokenRow = (symbol: string, name: string) => ({
  address: ADDR, name, symbol, type: 'BEP20', decimals: 18,
  totalSupply: '1000000000000000000000', holderCount: 1234, logoUrl: null,
})
const transfer = { txHash: '0x' + 'b'.repeat(64), logIndex: 1, blockNumber: 100, fromAddress: OTHER, toAddress: ADDR, tokenAddress: ADDR, value: '1500000000000000000' }

vi.mock('@/lib/db', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'limit']) query[m] = () => query
  query.then = (resolve: (r: unknown) => unknown) => resolve(h.indexed ? [h.row] : [])
  return { db: { select: () => query }, schema: { tokens: {}, tokenTransfers: {} } }
})
vi.mock('@/lib/token-transfers-query', () => ({
  TOKEN_TRANSFERS_MAX_ROWS: 10_000,
  selectTokenTransfers: async () => h.transfers,
  countTokenTransfers: async () => [{ value: h.transfers.length }],
}))
vi.mock('@/lib/market-data', () => ({ getTokenMarketData: async () => h.market }))
vi.mock('@/lib/holders', () => ({ getTokenHolders: async () => h.holders, EMPTY_HOLDERS: { holders: [] } }))
vi.mock('@/lib/token-risk', () => ({ analyzeTokenRisk: async () => [] }))
vi.mock('@/lib/rpc', () => ({ getWebProvider: () => ({}) }))
// A token the index has not seen is read live from the node: name(), symbol(), decimals(), totalSupply().
vi.mock('ethers', async (orig) => {
  const real = await orig<typeof import('ethers')>()
  return { ...real, Contract: class { name = async () => h.rpc.name; symbol = async () => h.rpc.symbol; decimals = async () => 18; totalSupply = async () => 0n } }
})
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

const params = Promise.resolve({ address: ADDR })
const render = async () => {
  const page = await import('./page')
  return renderToStaticMarkup(await page.default({ params, searchParams: Promise.resolve({}) }))
}
const meta = async () => {
  const page = await import('./page')
  return JSON.stringify(await page.generateMetadata({ params }))
}
const text = (html: string) => html.replace(/<[^>]+>/g, '')
const market = {
  priceUsd: 1, priceChange24h: null, volume24h: null, liquidityUsd: null, fdv: null, marketCap: null, circulatingSupply: 2_500_000,
  dexUrl: null, pairLabel: null, source: 'dexscreener',
}
const holders = { holders: [{ addr: OTHER, balance: '5000000000000000000' }], holderCount: null, source: 'local' }

beforeEach(() => {
  vi.resetModules()
  h.indexed = true
  h.rpc = { name: 'Claim', symbol: 'claim-bnb.xyz' }
  h.transfers = [transfer]
  h.market = market
  h.holders = holders
})

describe('token page: a URL or handle as the symbol', () => {
  const cell = (out: string, re: RegExp) => text(out.match(re)?.[0] ?? '')
  const ROW = /<td>1\.5[^<]*(?:<!-- -->)?[^<]*<\/td>/
  const HOLDER = /<td>5 [^<]*(?:<!-- -->)?[^<]*<\/td>/

  it.each(['claim-bnb.xyz', '@airdrop_bot'])('%s: the transfer row, the supply line, both captions and the holders table name the token by its short address', async (symbol) => {
    h.row = tokenRow(symbol, 'Airdrop')
    const out = await render()
    expect(cell(out, /<caption[^>]*>Token transfers for.*?<\/caption>/)).toBe(`Token transfers for ${SHORT}`)
    expect(cell(out, /<caption[^>]*>Top holders of.*?<\/caption>/)).toBe(`Top holders of ${SHORT}`)
    expect(cell(out, ROW)).toBe(`1.5 ${SHORT}`)
    expect(cell(out, HOLDER)).toBe(`5 ${SHORT}`)
    expect(text(out)).toContain(`Circulating supply: 2,500,000 ${SHORT}`)
  })

  it('the text appears in the header\'s h1 and nowhere else on the page, and no link points at it', async () => {
    for (const symbol of ['claim-bnb.xyz', '@airdrop_bot']) {
      h.row = tokenRow(symbol, 'Airdrop')
      vi.resetModules()
      const out = await render()
      expect(out.split(symbol)).toHaveLength(2)
      expect(out.match(/<h1[^>]*>.*?<\/h1>/)?.[0]).toContain(symbol)
      expect(out).toContain('>link in name</span>')
      expect((out.match(/<a [^>]*>/g) ?? []).filter((a) => a.includes(symbol.replace('@', '')))).toEqual([])
    }
  })

  it('a URL only in the NAME is badged and renamed in metadata, but the rows print the symbol (the only text they show)', async () => {
    h.row = tokenRow('CLAIM', 'Visit claim-bnb.xyz')
    const out = await render()
    expect(out.match(/>link in name<\/span>/g)).toHaveLength(1)
    expect(cell(out, ROW)).toBe('1.5 CLAIM')
    expect(out.split('claim-bnb.xyz')).toHaveLength(2)   // the header's h1 only
  })

  it('an ordinary symbol is unchanged everywhere', async () => {
    h.row = tokenRow('CAKE', 'PancakeSwap Token')
    const out = await render()
    expect(text(out)).toContain('Circulating supply: 2,500,000 CAKE')
    expect(out).toContain('<caption class="sr-only">Token transfers for CAKE</caption>')
    expect(out).toContain('<caption class="sr-only">Top holders of CAKE</caption>')
    expect(text(out.match(/<td>1\.5[^<]*(?:<!-- -->)? ?[^<]*<\/td>/)?.[0] ?? '')).toBe('1.5 CAKE')
    expect(out).not.toContain('link in name')
  })

  it('a ticker with a dot is an ordinary symbol', async () => {
    h.row = tokenRow('USDT.z', 'Tether USD Bridged')
    expect(text(await render())).toContain('Circulating supply: 2,500,000 USDT.z')
  })

  it.each(['币安', 'BTCΞ', 'BAN人生'])('%s: a symbol with non-ASCII characters is printed exactly as the page always did (only the URL rule is new)', async (symbol) => {
    h.row = tokenRow(symbol, 'Some Token')
    const out = await render()
    expect(text(out)).toContain(`Circulating supply: 2,500,000 ${symbol}`)
    expect(cell(out, ROW)).toBe(`1.5 ${symbol}`)
    expect(out).not.toContain('link in name')
  })

  it('a placeholder symbol keeps printing as it always did', async () => {
    h.row = tokenRow('???', 'Unknown')
    h.rpc = { name: null, symbol: null }   // the live re-read finds nothing either, so the page keeps the indexer's '???'
    expect(text(await render())).toContain('Circulating supply: 2,500,000 ???')
  })
})

describe('token page: a name that only sanitises into a URL', () => {
  const NAME = 'ex\u0430mple.\u0441om'   // Cyrillic a and c: not a URL as typed, "example.com" once sanitised

  it('the header badges it, and the metadata and the breadcrumb JSON-LD name the token by its short address', async () => {
    h.row = tokenRow('CLAIM', NAME)
    const out = await render()
    expect(out.match(/>link in name<\/span>/g)).toHaveLength(1)
    const m = JSON.parse(await meta())
    expect(m.title).toBe(SHORT)
    expect(m.openGraph.title).toBe(SHORT)
    expect(JSON.stringify(m)).not.toContain(NAME)
    const ld = out.match(/<script type="application\/ld\+json">.*?<\/script>/)![0]
    expect(ld).toContain(SHORT)
    expect(ld).not.toContain(NAME)
  })
})

describe('token page: metadata and breadcrumb JSON-LD', () => {
  it.each([
    ['claim-bnb.xyz', 'Claim'],
    ['@airdrop_bot', 'Airdrop'],
    ['CLAIM', 'Visit claim-bnb.xyz'],
  ])('%s / %s: title, description and Open Graph carry the short address, not the text', async (symbol, name) => {
    h.row = tokenRow(symbol, name)
    const m = JSON.parse(await meta())
    expect(m.title).toBe(SHORT)
    expect(m.description).toMatch(new RegExp(`^${SHORT} BEP-20 token on [A-Za-z ]+\\.$`))
    expect(m.openGraph.title).toBe(SHORT)
    for (const advert of ['claim-bnb.xyz', 'airdrop_bot']) expect(JSON.stringify(m)).not.toContain(advert)
  })

  it('the breadcrumb JSON-LD names the token by its short address', async () => {
    h.row = tokenRow('claim-bnb.xyz', 'Visit claim-bnb.xyz')
    const out = await render()
    const ld = JSON.parse(out.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1].replace(/\\u003c/g, '<'))
    expect(ld.itemListElement.map((i: { name: string }) => i.name)).toEqual(['Home', 'Tokens', SHORT])
    expect(out.match(/<script type="application\/ld\+json">.*?<\/script>/)![0]).not.toContain('claim-bnb.xyz')
  })

  it('a token read live from the node (not indexed yet) is named the same way in the metadata and the page', async () => {
    h.indexed = false
    const m = JSON.parse(await meta())
    expect(m.title).toBe(SHORT)
    expect(m.description).toMatch(new RegExp(`^${SHORT} token on [A-Za-z ]+\\.$`))
    expect(JSON.stringify(m)).not.toContain('claim-bnb.xyz')
    vi.resetModules()
    const out = await render()
    expect(out.split('claim-bnb.xyz')).toHaveLength(2)   // the header's h1 only
    expect(text(out)).toContain(`Circulating supply: 2,500,000 ${SHORT}`)
    h.rpc = { name: 'PancakeSwap Token', symbol: 'CAKE' }
    vi.resetModules()
    expect(JSON.parse(await meta()).title).toBe('PancakeSwap Token (CAKE)')
  })

  it('an ordinary token keeps "Name (SYMBOL)"', async () => {
    h.row = tokenRow('CAKE', 'PancakeSwap Token')
    const m = JSON.parse(await meta())
    expect(m.title).toBe('PancakeSwap Token (CAKE)')
    expect(m.openGraph.title).toBe('PancakeSwap Token (CAKE)')
    const out = await render()
    const ld = JSON.parse(out.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1])
    expect(ld.itemListElement[2].name).toBe('PancakeSwap Token (CAKE)')
  })
})

describe('token page: the Market panel names the pair', () => {
  it('a pair label that reads as a URL is not printed (it is the text of an outbound link)', async () => {
    h.row = tokenRow('claim-bnb.xyz', 'Claim')
    h.market = { ...market, dexUrl: 'https://dexscreener.com/bsc/0xabc', pairLabel: 'claim-bnb.xyz/WBNB pair on PancakeSwap' }
    const out = await render()
    expect(out.split('claim-bnb.xyz')).toHaveLength(2)   // the header's h1 only
    expect(text(out)).toContain(`${SHORT} pair ↗`)
  })

  it('an ordinary pair label is unchanged', async () => {
    h.row = tokenRow('CAKE', 'PancakeSwap Token')
    h.market = { ...market, dexUrl: 'https://dexscreener.com/bsc/0xabc', pairLabel: 'CAKE/WBNB pair on PancakeSwap' }
    expect(await render()).toContain('CAKE/WBNB pair on PancakeSwap ↗')
  })
})
