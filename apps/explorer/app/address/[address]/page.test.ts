import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToReadableStream } from 'react-dom/server'
import { shortenAddress } from '@/lib/address-display'

// The address page's Transfers and NFTs tabs read token text through TransferRow / NftRow (their own tests render the
// rows). This renders the real page for each tab, with the database stubbed, so the wiring from the page's queries to
// the rows is pinned too: a row that lost its token info would read "Unknown token" with no unit, and nothing else
// would notice.
const ME = '0x' + '7'.repeat(40)
const OTHER = '0x' + '2'.repeat(40)
const CAKE = '0x' + '5'.repeat(40)
const URLTOK = '0x' + '6'.repeat(40)
const NFT = '0x' + '4'.repeat(40)
const SHORT_URLTOK = shortenAddress(URLTOK)
type Row = Record<string, unknown>
const h = vi.hoisted(() => ({ tables: new Map<unknown, Row[]>(), exec: [] as Row[] }))

vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const builder = () => {
    let table: unknown
    const q: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy', 'limit', 'offset', 'groupBy', 'leftJoin', 'innerJoin']) q[m] = () => q
    q.from = (t: unknown) => { table = t; return q }
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(h.tables.get(table) ?? []).then(resolve, reject)
    return q
  }
  return { schema, db: { select: () => builder(), execute: async () => h.exec } }
})
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537.36' }) }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))
vi.mock('@/lib/rpc', () => ({ getWebProvider: async () => ({ getBalance: async () => 0n, getTransactionCount: async () => 0, getCode: async () => '0x' }) }))
vi.mock('@/lib/name-resolver', () => ({ resolveName: async () => null }))
vi.mock('@/lib/goplus', () => ({ getAddressRisk: async () => null }))
vi.mock('@/lib/native-price', () => ({ fetchNativeUsd: async () => null }))
vi.mock('@/lib/providers', () => ({ isBotRequest: () => false }))
vi.mock('@/lib/retention', () => ({ getRetentionFloor: async () => null, isLocalHistoryIncomplete: () => false }))
vi.mock('./HoldingsTab', () => ({ HoldingsTab: () => null, getTrackedBalances: async () => null }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

const render = async (tab: string) => {
  vi.resetModules()
  const { schema } = await import('@/lib/db')   // the stub's own schema: table identity is the key
  h.tables.set(schema.tokens, [
    { address: CAKE, name: 'PancakeSwap Token', symbol: 'CAKE', decimals: 18 },
    { address: URLTOK, name: 'Visit claim-bnb.xyz', symbol: 'claim-bnb.xyz', decimals: 18 },
  ])
  h.tables.set(schema.tokenTransfers, [CAKE, URLTOK].map((tokenAddress, i) => ({
    txHash: '0x' + (i + 1).toString(16).padStart(64, '0'), logIndex: i, blockNumber: 100 - i, fromAddress: OTHER, toAddress: ME,
    tokenAddress, value: '1500000000000000000',
  })))
  const page = await import('./page')
  // The tabs are async server components, which the string renderer cannot wait for; the stream renderer can.
  const stream = await renderToReadableStream(await page.default({ params: Promise.resolve({ address: ME }), searchParams: Promise.resolve({ tab }) }))
  await stream.allReady
  return new Response(stream).text()
}
const rows = (html: string) =>
  [...html.matchAll(/<tr class="hover:bg-canvas transition-colors">(.*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '')))

beforeEach(() => { h.tables.clear(); h.exec = [] })

describe('address page, Transfers tab', () => {
  it('prints each row\'s token from the token lookup: its label in the cell and its symbol after the amount', async () => {
    const r = rows(await render('transfers'))
    expect(r).toHaveLength(2)
    expect(r[0].slice(4)).toEqual(['CAKE', '1.5 CAKE'])
  })

  it('a URL-like token keeps its text in the cell with the badge and is named by its short address after the amount', async () => {
    const html = await render('transfers')
    const r = rows(html)
    expect(r[1].slice(4)).toEqual(['claim-bnb.xyzlink in name', `1.5 ${SHORT_URLTOK}`])
    expect(html.match(/>link in name<\/span>/g)).toHaveLength(1)
  })
})

describe('address page, NFTs tab', () => {
  it('prints each transfer\'s collection, badging a URL-like one', async () => {
    h.exec = [
      { txHash: '0x' + 'a'.repeat(64), tokenAddress: NFT, tokenId: '7', fromAddress: OTHER, toAddress: ME, blockNumber: 100, name: 'Visit claim-bnb.xyz', symbol: 'NFT' },
      { txHash: '0x' + 'b'.repeat(64), tokenAddress: NFT, tokenId: '8', fromAddress: ME, toAddress: OTHER, blockNumber: 99, name: 'Cool Apes', symbol: 'APE' },
    ]
    const html = await render('nfts')
    const r = rows(html)
    expect(r.map((c) => c[0])).toEqual(['Visit claim-bnb.xyz(NFT)link in name', 'Cool Apes(APE)'])
    expect(r.map((c) => c[2])).toEqual(['Received', 'Sent'])
  })
})
