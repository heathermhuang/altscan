import { describe, it, expect } from 'vitest'
import { BLOCK_TXS_PER_PAGE, blockTxsHref, pageExists, parseTxsPage, txsLabel, txsPageCount } from '@/lib/block-txs'

describe('parseTxsPage', () => {
  it.each([['2', 2], ['3', 3], ['10', 10], ['2000', 2000]])('%s is page %i', (raw, page) => {
    expect(parseTxsPage(raw)).toBe(page)
  })

  // 1 is /blocks/<n> itself; the rest are second spellings or not numbers at all.
  it.each(['1', '0', '-2', '02', '2.5', '1e1', '0x2', ' 2', '2 ', '', 'two', '99999999999999999999'])('%j is not a page', (raw) => {
    expect(parseTxsPage(raw)).toBeNull()
  })
})

describe('txsPageCount', () => {
  it.each([[0, 1], [1, 1], [50, 1], [51, 2], [100, 2], [141, 3], [150, 3], [151, 4]])('%i txs -> %i pages', (n, pages) => {
    expect(txsPageCount(n)).toBe(pages)
  })

  it('pins the page size the route and the query share', () => {
    expect(BLOCK_TXS_PER_PAGE).toBe(50)
  })
})

describe('pageExists', () => {
  it('page 1 is the block page itself, whatever the block is made of', () => {
    expect(pageExists(1, true, 0)).toBe(true)
    expect(pageExists(1, false, 141)).toBe(true)
  })
  it('later pages need the block in the DB and enough transactions', () => {
    expect(pageExists(2, true, 141)).toBe(true)
    expect(pageExists(3, true, 141)).toBe(true)
    expect(pageExists(4, true, 141)).toBe(false)
    expect(pageExists(2, true, 51)).toBe(true)
    expect(pageExists(2, true, 50)).toBe(false)
    expect(pageExists(2, true, 0)).toBe(false)
  })
  it('an RPC-only block has no rows to page', () => {
    expect(pageExists(2, false, 141)).toBe(false)
  })
})

describe('blockTxsHref', () => {
  it('keeps page 1 on the canonical block URL', () => {
    expect(blockTxsHref(125850491, 1)).toBe('/blocks/125850491')
  })
  it('puts later pages in a path segment', () => {
    expect(blockTxsHref(125850491, 2)).toBe('/blocks/125850491/txs/2')
    expect(blockTxsHref(0, 12)).toBe('/blocks/0/txs/12')
  })
})

describe('txsLabel', () => {
  it('page 1: the plain count when nothing is capped', () => {
    expect(txsLabel(1, 0, 0)).toBe('0')
    expect(txsLabel(1, 12, 12)).toBe('12')
    expect(txsLabel(1, 50, 50)).toBe('50')
  })
  it('page 1: "50 of N" when the block has more', () => {
    expect(txsLabel(1, 50, 141)).toBe('50 of 141')
    expect(txsLabel(1, 50, 1234)).toBe('50 of 1,234')
  })
  it('page 1: a short page is a plain count even if the block claims more (rows not indexed yet)', () => {
    expect(txsLabel(1, 40, 141)).toBe('40')
  })
  it('later pages: the range of rows shown', () => {
    expect(txsLabel(2, 50, 141)).toBe('51–100 of 141')
    expect(txsLabel(3, 41, 141)).toBe('101–141 of 141')
    expect(txsLabel(21, 50, 1234)).toBe('1,001–1,050 of 1,234')
  })
  it('later pages: no rows at all does not print an inverted range', () => {
    expect(txsLabel(3, 0, 141)).toBe('0 of 141')
  })
})
