import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BlockTape } from './BlockTape'
import { encodeTape, type TapeTuple } from '@/lib/tape'

const tuples: TapeTuple[] = [[10, 1000, 2, 10], [11, 1001, 3, 20], [12, 1002, 4, 30]]
const tape = encodeTape(tuples)
const html = (props: { current?: number; heading?: string } = {}) =>
  renderToStaticMarkup(createElement(BlockTape, { tape, chainName: 'BNB Chain', ...props }))

describe('BlockTape labels', () => {
  it('says "latest" with no heading (the homepage)', () => {
    const h = html()
    expect(h).toContain('aria-label="BNB Chain latest indexed blocks"')
    expect(h).toContain('latest')
  })

  it('a heading alone (a cached page) replaces "latest #N" and does not claim "around this one"', () => {
    const h = html({ heading: 'as of 21:04 UTC' })
    expect(h).toContain('as of 21:04 UTC')
    expect(h).toContain('aria-label="BNB Chain recent indexed blocks"')
    expect(h).not.toContain('latest')
  })

  it('a current block (the block page) keeps "around this one"', () => {
    expect(html({ current: 11, heading: 'around #11' })).toContain('aria-label="BNB Chain indexed blocks around this one"')
  })
})
