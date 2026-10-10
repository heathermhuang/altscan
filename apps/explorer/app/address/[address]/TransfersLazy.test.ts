import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TokenTransferRow } from '@/lib/providers'
import { TransfersView } from './TransfersLazy'

// The transfers tab's Amount cell reads the provider's decimal string through formatDecimalAmount. This pins the
// wiring in the rendered table: a revert to parseFloat(..).toLocaleString(..) prints a dust transfer as "0".
const ME = '0x' + 'a'.repeat(40)
const row = (i: number, valueFormatted: string): TokenTransferRow => ({
  txHash: '0x' + i.toString(16).padStart(64, '0'), logIndex: String(i), blockNumber: '1', blockTimestamp: '2026-10-10T00:00:00.000Z',
  fromAddress: '0x' + '1'.repeat(40), toAddress: ME, tokenAddress: '0x' + '2'.repeat(40), tokenSymbol: 'USDT',
  tokenDecimals: '18', value: '1', valueFormatted,
})
const amounts = (transfers: TokenTransferRow[]) => {
  const html = renderToStaticMarkup(createElement(TransfersView, { data: { transfers, cursor: null }, addr: ME, cursor: null, activeCursor: null, onCursor: () => {} }))
  return [...html.matchAll(/<tr class="hover:bg-canvas transition-colors">(.*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '')).at(-1))
}

describe('TransfersView amounts', () => {
  it('renders a dust transfer as a floor with its unit, never as "0"', () => {
    // renderToStaticMarkup escapes the '<'
    expect(amounts([row(1, '0.000000000000000001'), row(2, '0.0000004'), row(3, '1e-7')])).toEqual(['&lt;0.000001 USDT', '&lt;0.000001 USDT', '&lt;0.000001 USDT'])
  })

  it('keeps zero as "0" and prints other amounts as before', () => {
    expect(amounts([row(1, '0'), row(2, '0.00001'), row(3, '1234.5678901'), row(4, '25')])).toEqual(['0 USDT', '0.00001 USDT', '1,234.56789 USDT', '25 USDT'])
  })
})
