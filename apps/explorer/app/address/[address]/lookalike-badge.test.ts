import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import type { HoldingRow } from '@/lib/holdings'
import type { TokenTransferRow } from '@/lib/providers'
import { TransferRow } from './TransferRow'
import { ProviderTransferRow } from './TransfersLazy'
import { HoldingsTable } from './HoldingsTable'

// The address tabs print a token's SANITISED symbol, so a spam token whose symbol reads as USDT once printed passes for
// it at a glance. Each tab now carries the lookalike chip the token pages and lists already draw. The two client
// tabs (TransfersLazy, HoldingsTable) cannot judge it themselves (lib/lookalike stays out of the browser, see
// client-chain-config.test.ts), so they draw the verdict the server put on the row.
const ME = '0x' + '1'.repeat(40)
const SPAM = '0x' + 'a'.repeat(40)
const TX = '0x' + 'b'.repeat(64)
const BNB_USDT = '0x55d398326f99059fF775485246999027B3197955'
const USDT_FLAG = { symbol: 'USDT', canonical: BNB_USDT }
const CHIP = /<span class="badge badge-bad ml-2" title="[^"]*">lookalike<span class="sr-only"> of USDT<\/span><\/span>/g
const chips = (html: string) => html.match(CHIP)?.length ?? 0
const inTable = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement('table', null, createElement('tbody', null, el as never)))
const linkClass = (html: string) => html.match(/<a class="([^"]*)" href="\/token\//)?.[1] ?? ''

describe('Transfers tab, server row', () => {
  const t = { txHash: TX, blockNumber: 100, fromAddress: ME, toAddress: '0x' + '2'.repeat(40), value: '1500000000000000000' }
  const row = (tokenAddress: string, symbol: string, name = 'Tether USD') =>
    inTable(createElement(TransferRow, { t: { ...t, tokenAddress }, addr: ME, info: { symbol, name, decimals: 18 } }))

  it('badges a non-canonical "USDT", and weights its link like any link beside a badge', () => {
    const html = row(SPAM, 'USDT')
    expect(chips(html)).toBe(1)
    expect(linkClass(html)).toBe('text-acc-ink hover:underline font-medium')
  })

  it('badges a symbol that only reads as USDT once sanitised', () => {
    expect(chips(row(SPAM, 'US€DT', 'Some Token'))).toBe(1)
  })

  it('does not badge the real USDT contract, nor an ordinary token', () => {
    expect(chips(row(BNB_USDT, 'USDT'))).toBe(0)
    const plain = row(SPAM, 'CAKE', 'PancakeSwap Token')
    expect(chips(plain)).toBe(0)
    expect(linkClass(plain)).toBe('text-acc-ink hover:underline')
  })
})

describe('Transfers tab, provider row (TransfersLazy)', () => {
  const t: TokenTransferRow = {
    txHash: TX, logIndex: '1', blockNumber: '1', blockTimestamp: '2026-10-10T00:00:00.000Z',
    fromAddress: ME, toAddress: '0x' + '2'.repeat(40), tokenAddress: SPAM, tokenSymbol: 'USDT',
    tokenDecimals: '18', value: '1', valueFormatted: '1.5',
  }
  const row = (extra: object) => inTable(createElement(ProviderTransferRow, { t: { ...t, ...extra }, addr: ME }))

  it('draws the lookalike chip the server put on the row', () => {
    const html = row({ lookalike: USDT_FLAG })
    expect(chips(html)).toBe(1)
    expect(linkClass(html)).toBe('text-acc-ink hover:underline font-medium')
  })

  it('draws none on a row the server did not flag', () => {
    expect(chips(row({ lookalike: null }))).toBe(0)
    expect(chips(row({}))).toBe(0)
  })
})

describe('Holdings table', () => {
  const holding = (over: Partial<HoldingRow>): HoldingRow => ({
    tokenAddress: SPAM, name: 'Tether USD', symbol: 'USDT', decimals: 18, balance: '1', amount: '1', usd: null, basis: null, tracked: false, ...over,
  })
  const table = (rows: HoldingRow[]) => renderToStaticMarkup(createElement(HoldingsTable, { rows, caption: 'x', nativeSymbol: 'BNB' }))

  it('draws the lookalike chip the server put on the row, in the Token cell', () => {
    const html = table([holding({ lookalike: USDT_FLAG })])
    expect(chips(html)).toBe(1)
    expect(html.indexOf('lookalike')).toBeLessThan(html.indexOf('font-mono text-[13px] text-ink2'))
  })

  it('draws none on a row that is not flagged', () => {
    expect(chips(table([holding({ lookalike: null }), holding({})]))).toBe(0)
  })
})
