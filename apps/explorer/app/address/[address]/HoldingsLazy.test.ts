import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { BSC } from '@altscan/chain-config'
import { priceTracked, trackedTokens } from '@/lib/holdings'
import { HoldingsView } from './HoldingsLazy'

// The provider (Moralis) lists at most 20 tokens and can leave out USDT/USDC/WBNB. The tab merges the
// page's live, priced read of those three into its list, so a holder of 600M USDT shows it.
const E18 = 10n ** 18n
const USDT = BSC.whales.stablecoins[0].address
const tracked = priceTracked(trackedTokens(BSC.whales), { [USDT]: String(600_000_000n * E18) }, 750)
const prov = (symbol: string, usdValue: string | null, address: string, balance = String(3n * E18)) =>
  ({ tokenAddress: address, symbol, name: symbol, logo: null, decimals: 18, balance, balanceFormatted: null, usdValue })
const view = (data: Parameters<typeof HoldingsView>[0]['data'], t: Parameters<typeof HoldingsView>[0]['tracked'] = tracked) =>
  renderToStaticMarkup(createElement(HoldingsView, { data, tracked: t }))
const cells = (html: string) =>
  [...html.matchAll(/<tr class="hover:bg-canvas transition-colors">(.*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '')),
  )

describe('HoldingsView', () => {
  const data = {
    tokens: [
      prov('MEME', null, '0x' + '1'.repeat(40)),
      prov('CAKE', '12.5', '0x' + '2'.repeat(40)),
      prov('USDT', '1', USDT, '1'), // the provider's own (stale) USDT row loses to the live one
    ],
  }

  it('merges the live tracked rows into the provider list, sorted by USD with unpriced rows last', () => {
    expect(cells(view(data))).toEqual([
      ['USDT', 'USDT', '600,000,000', '$600,000,000.00'],
      ['CAKE', 'CAKE', '3', '$12.50'],
      ['MEME', 'MEME', '3', 'no price'],
    ])
  })

  it('names the sources', () => {
    const html = view(data)
    expect(html).toContain('read from the chain just now')
    expect(html).toContain('Other balances are from Moralis, priced only where it has a price.')
  })

  it('still shows the live rows when the provider is down, and says the rest is unavailable', () => {
    const html = view({ tokens: [], limited: true, reason: 'rate_limited' })
    expect(cells(html).map((r) => r[0])).toEqual(['USDT'])
    expect(html).toContain('Other token holdings are not available right now.')
  })

  it('keeps the old messages when there is nothing live to show', () => {
    expect(view({ tokens: [], limited: true, reason: 'rate_limited' }, [])).toContain('The data provider is busy right now')
    expect(view({ tokens: [], limited: true, reason: 'not_configured' }, null)).toContain('Token holdings are not available for this address.')
    expect(view({ tokens: [] }, [])).toContain('No token holdings found for this address.')
  })

  it('says so when the live read failed, and does not hide the provider list', () => {
    const html = view({ tokens: [prov('CAKE', '12.5', '0x' + '2'.repeat(40))] }, null)
    expect(html).toContain('could not be read from the chain right now')
    expect(cells(html)).toEqual([['CAKE', 'CAKE', '3', '$12.50']])
  })
})
