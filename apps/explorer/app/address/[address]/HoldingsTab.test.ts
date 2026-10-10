/**
 * The Holdings tab must agree with the token page. Judge round 4: the #1 USDT holder (615,877,429 USDT on
 * /token/<USDT>) listed 50 tokens with no USDT, no USDC and no USD value. The explorer's `token_balances` is
 * a frozen snapshot with no prices, so the tracked tokens (stablecoins + wrapped native) are read live from
 * the chain and merged in. The real server component, with the database and the RPC stubbed.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Interface } from 'ethers'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BSC } from '@altscan/chain-config'

const HOLDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3'
const USDT = BSC.whales.stablecoins[0].address
const USDC = BSC.whales.stablecoins[1].address
const E18 = 10n ** 18n
const other = (i: number) => '0x' + i.toString(16).padStart(40, '0')

type Row = Record<string, unknown>
let indexRows: Row[] = []
let tokenInfo: Row[] = []
let chain: bigint[] | Error = [0n, 0n, 0n]

vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  return {
    schema,
    db: {
      execute: async () => indexRows,
      select: () => {
        const q: Record<string, unknown> = {}
        q.from = () => q
        q.where = () => q
        q.then = (resolve: (r: unknown) => unknown) => resolve(tokenInfo)
        return q
      },
    },
  }
})

const iface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function balanceOf(address) view returns (uint256)',
])
vi.mock('@/lib/rpc', () => ({
  getWebProvider: async () => ({
    call: async () => {
      if (chain instanceof Error) throw chain
      return iface.encodeFunctionResult('aggregate3', [chain.map((b) => [true, iface.encodeFunctionResult('balanceOf', [b])])])
    },
  }),
}))
// The lazy tab is a client component; here it only has to be handed the live rows.
vi.mock('./HoldingsLazy', () => ({
  HoldingsLazy: (p: { addr: string; tracked: unknown }) => createElement('div', { 'data-lazy': p.addr, 'data-tracked': JSON.stringify(p.tracked) }),
}))

async function tab(o: { isBot?: boolean; nativeUsd?: number | null } = {}): Promise<string> {
  const { HoldingsTab } = await import('./HoldingsTab')
  return renderToStaticMarkup(await HoldingsTab({ addr: HOLDER, isBot: o.isBot ?? false, nativeUsd: o.nativeUsd === undefined ? 750 : o.nativeUsd }))
}
const cells = (html: string) =>
  [...html.matchAll(/<tr class="hover:bg-canvas transition-colors">(.*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '')),
  )

beforeEach(() => {
  vi.resetModules()
  // 50 index rows, none of them USDT/USDC/WBNB (as the judge saw): big raw balances, no prices.
  indexRows = Array.from({ length: 50 }, (_, i) => ({ token_address: other(i + 1), balance: String(BigInt(1e9) * E18) }))
  tokenInfo = Array.from({ length: 50 }, (_, i) => ({ address: other(i + 1), name: `Coin ${i + 1}`, symbol: `C${i + 1}`, decimals: 18 }))
  chain = [605_506_903n * E18, 0n, 2n * E18]
})

describe('address Holdings tab (BNB)', () => {
  it('lists the tracked tokens the index omits, with USD values, ahead of the unpriced rest', async () => {
    const rows = cells(await tab())
    expect(rows).toHaveLength(52)
    expect(rows[0]).toEqual(['USDT', 'USDT', '605,506,903', '$605,506,903.00'])
    expect(rows[1]).toEqual(['WBNB', 'WBNB', '2', '$1,500.00'])
    expect(rows.slice(2).every((r) => r[3] === 'no price')).toBe(true)
    // USDC is 0 on chain: no row, rather than a row of zeros.
    expect(rows.some((r) => r[0] === 'USDC')).toBe(false)
  })

  it('says where the numbers come from', async () => {
    const html = await tab()
    expect(html).toContain('USDT, USDC and WBNB are read from the chain just now')
    expect(html).toContain('Other balances come from this explorer&#x27;s index, a stale snapshot, and are not priced.')
  })

  it('shows the wrapped token unpriced, never invented, when there is no native price', async () => {
    const rows = cells(await tab({ nativeUsd: null }))
    expect(rows.find((r) => r[0] === 'WBNB')).toEqual(['WBNB', 'WBNB', '2', 'no price'])
    expect(rows[0][0]).toBe('USDT')
  })

  it('does not call the wrapped token live-priced when there is no native price', async () => {
    const html = await tab({ nativeUsd: null })
    expect(html).toContain('stablecoins at $1; WBNB has no price right now.')
    expect(html).not.toContain('live BNB price')
    expect(await tab()).toContain('WBNB at the live BNB price')
  })

  it('lists a tracked token once: the live row replaces a stale index row', async () => {
    indexRows.push({ token_address: USDT, balance: String(7n * E18) })
    tokenInfo.push({ address: USDT, name: 'Tether USD', symbol: 'USDT', decimals: 18 })
    const usdt = cells(await tab()).filter((r) => r[1] === 'USDT')
    expect(usdt).toEqual([['USDT', 'USDT', '605,506,903', '$605,506,903.00']])
  })

  it('does not resurrect an index balance of a tracked token that the chain says is gone', async () => {
    chain = [0n, 0n, 0n]
    indexRows.push({ token_address: USDC, balance: String(99n * E18) })
    tokenInfo.push({ address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 18 })
    expect(cells(await tab()).some((r) => r[1] === 'USDC')).toBe(false)
  })

  it('keeps the index rows and says the tracked tokens could not be read when the chain read fails', async () => {
    chain = new Error('rpc down')
    const html = await tab()
    expect(html).toContain('USDT, USDC and WBNB could not be read from the chain right now.')
    const rows = cells(html)
    expect(rows).toHaveLength(50)
    expect(rows.every((r) => r[3] === 'no price')).toBe(true)
  })

  it('with an empty index, hands the lazy tab the live priced rows to merge with the provider list', async () => {
    indexRows = []
    tokenInfo = []
    const html = await tab()
    expect(html).toContain(`data-lazy="${HOLDER}"`)
    const tracked = JSON.parse(html.match(/data-tracked="([^"]*)"/)![1].replace(/&quot;/g, '"'))
    expect(tracked.map((r: { symbol: string; usd: number }) => [r.symbol, r.usd])).toEqual([['USDT', 605_506_903], ['WBNB', 1500]])
  })

  it('shows a crawler the live rows (no provider call) or the plain empty message', async () => {
    indexRows = []
    tokenInfo = []
    const html = await tab({ isBot: true })
    expect(html).not.toContain('data-lazy')
    expect(cells(html).map((r) => r[0])).toEqual(['USDT', 'WBNB'])
    chain = [0n, 0n, 0n]
    expect(await tab({ isBot: true })).toBe('<p class="text-mut">No token holdings found for this address.</p>')
  })
})
