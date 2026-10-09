import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BlockStrip } from './BlockStrip'
import type { StripTx } from '@/lib/tape'

const txs: StripTx[] = [
  { i: 0, gas: 50_000, price: 0, ok: true },        // system tx: no fill
  { i: 1, gas: 21_000, price: 5e7, ok: true },
  { i: 2, gas: 140_000, price: 1e9, ok: false },    // failed
  { i: 3, gas: 300_000, price: 5e7, ok: true },
]
const html = (current?: number) =>
  renderToStaticMarkup(createElement(BlockStrip, { txs, blockNumber: 1234567, gasLimit: 1_000_000, chainName: 'BNB Chain', current }))

describe('BlockStrip', () => {
  it('draws one tile per tx in order, weighted by gas, filled by price', () => {
    const h = html()
    expect(h.match(/<i /g)).toHaveLength(4)
    expect(h).toContain('--w:50;--f:0%')
    expect(h).toContain('--w:21;--f:30%')
    expect(h).toContain('--w:300;--f:30%')
  })
  it('marks a failed tx and states the totals', () => {
    const h = html()
    expect(h).toContain('class="x"')
    expect(h).toContain('4 txns · 1 failed')
    expect(h).toContain('gas 51% of limit')
    expect(h).toContain('Block #1,234,567')
  })
  it('is one labelled image, its tiles presentational', () => {
    const h = html()
    expect(h).toContain('role="img"')
    expect(h).toContain('aria-label="BNB Chain block 1,234,567: 4 transactions, 1 failed"')
  })
  it('rings the current tx and names it, by tx_index', () => {
    const h = html(3)
    expect(h).toContain('class="c"')
    expect(h).toContain('this tx · 300,000 gas')
    expect(h).toContain('this one is the 4th and used 58.7% of the block')  // 300,000 / 511,000
    expect(h).toContain('bs-has-cur')
  })
  it('says <0.1% for a tiny tx in a dense block, never 0.0%', () => {
    const dense: StripTx[] = [{ i: 0, gas: 21_000, price: 5e7, ok: true }, { i: 1, gas: 30_000_000, price: 5e7, ok: true }]
    const h = renderToStaticMarkup(createElement(BlockStrip, { txs: dense, blockNumber: 7, gasLimit: 30_000_000, chainName: 'Ethereum', current: 0 }))
    expect(h).toContain('&lt;0.1% of the block')
    expect(h).not.toContain('0.0%')
  })
  it('keeps the fail mark on a ringed failed tx', () => {
    expect(html(2)).toContain('class="c x"')
  })
  it('has no "null%" in the label when the block\'s gas sums to zero', () => {
    const zero: StripTx[] = [{ i: 0, gas: 0, price: 0, ok: true }, { i: 1, gas: 0, price: 0, ok: true }]
    const h = renderToStaticMarkup(createElement(BlockStrip, { txs: zero, blockNumber: 7, gasLimit: 1_000_000, chainName: 'BNB Chain', current: 1 }))
    expect(h).toContain('this one is the 2nd')
    expect(h).not.toContain('null')
  })
  it('anchors the chip by where the tile sits, not by its tx_index', () => {
    const mk = (gas: number[]): StripTx[] => gas.map((g, i) => ({ i, gas: g, price: 5e7, ok: true }))
    const chip = (t: StripTx[], current: number) =>
      renderToStaticMarkup(createElement(BlockStrip, { txs: t, blockNumber: 1, gasLimit: 0, chainName: 'BNB Chain', current }))
        .match(/class="bs-chip( l)?"/)![0]
    const small = Array(6).fill(21_000)
    expect(chip(mk([900_000, 21_000, ...small]), 1)).toBe('class="bs-chip"')      // 2nd of 8, but 90% of the gas is before it: right edge
    expect(chip(mk([...small, 21_000, 900_000]), 4)).toBe('class="bs-chip l"')    // 5th of 8, but 90% of the gas is after it: left edge
  })
  it('appends a className to the band (the block page joins it to the tape above)', () => {
    const h = renderToStaticMarkup(createElement(BlockStrip, { txs, blockNumber: 1, gasLimit: 0, chainName: 'X', className: 'border-t-0' }))
    expect(h).toContain('class="bt-box border-t-0"')
    expect(h).not.toContain('of limit')   // gasLimit 0: no percentage claimed
  })
})
