import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BlockTable } from './BlockTable'

const MINER = '0x1111111111111111111111111111111111111111'
const blocks = [
  { number: 100, timestamp: new Date(), miner: MINER, txCount: 3, gasUsed: '42000000', gasLimit: '100000000' },
  { number: 99, timestamp: new Date(), miner: MINER, txCount: 0, gasUsed: null, gasLimit: '100000000' },
  // parseBlock hands the page a bigint, so an empty block is 0n: falsy, and React prints a bigint child.
  { number: 98, timestamp: new Date(), miner: MINER, txCount: 0, gasUsed: 0n, gasLimit: 100000000n },
]
const html = (props: { compact?: boolean; gasBar?: boolean } = {}) =>
  renderToStaticMarkup(createElement(BlockTable, { blocks, ...props }))

describe('BlockTable gas bar', () => {
  it('is off by default, so the homepage and other callers carry no extra markup', () => {
    expect(html()).not.toContain('gbar')
    expect(html({ compact: true })).not.toContain('gbar')
  })

  it("draws one empty span per row from one custom property, and says the percentage in text", () => {
    const h = html({ gasBar: true })
    expect(h.match(/<span class="gbar"[^>]*><\/span>/g)).toEqual(['<span class="gbar" style="--g:42%"></span>'])
    expect(h).toContain('42,000,000 (42%)')
  })

  it('draws no bar for a block with no gas figure, and an empty block reads "—" rather than leaking a 0', () => {
    const h = html({ gasBar: true })
    expect(h.match(/gbar/g)).toHaveLength(1)
    const gasCells = [...h.matchAll(/<td class="text-mut hidden sm:table-cell">(.*?)<\/td>/g)].map(m => m[1])
    expect(gasCells[1]).toBe('—')
    expect(gasCells[2]).toBe('—')
  })
})
