import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import type { HoldingRow } from '@/lib/holdings'
import { HoldingsTable } from './HoldingsTable'

const row = (over: Partial<HoldingRow>): HoldingRow => ({
  tokenAddress: '0x' + '1'.repeat(40), name: null, symbol: null, decimals: 18, balance: '1', amount: '1', usd: null, basis: null, tracked: false, ...over,
})
const tokenCells = (rows: HoldingRow[]) =>
  [...renderToStaticMarkup(createElement(HoldingsTable, { rows, caption: 'x', nativeSymbol: 'BNB' })).matchAll(/<td class="px-3 sm:px-4 py-2"><a [^>]*>(.*?)<\/a>/g)].map((m) => m[1])

// tokenLabel(symbol, name, address) is "sanitised symbol, else sanitised name". The table passed (name, symbol).
describe('HoldingsTable token column', () => {
  it('shows the symbol, as the Token column of every other table does', () => {
    expect(tokenCells([row({ name: 'Chi Gastoken by 1inch', symbol: 'CHI' })])).toEqual(['CHI'])
  })

  it('falls back to the name when the symbol is a placeholder, and reads "Unknown token" when neither is real', () => {
    expect(tokenCells([row({ name: 'Real Name', symbol: '???' })])).toEqual(['Real Name'])
    expect(tokenCells([row({ name: 'Unknown', symbol: '???' })])).toEqual(['Unknown token'])
  })
})
