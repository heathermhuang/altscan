import { describe, expect, it } from 'vitest'
import { classifyQuery, normaliseSearchQuery, routeForQuery } from '@/lib/search-route'

const TX = 'aB'.repeat(32) // 64 hex, mixed case
const ADDR = 'Cd'.repeat(20) // 40 hex, mixed case

describe('routeForQuery', () => {
  it('sends a plain block number to /blocks', () => {
    expect(routeForQuery('125761128')).toBe('/blocks/125761128')
  })

  it('trims whitespace, strips one leading #, and drops , _ and space separators', () => {
    expect(routeForQuery(' 125761128 ')).toBe('/blocks/125761128')
    expect(routeForQuery('#125761128')).toBe('/blocks/125761128')
    expect(routeForQuery('125,761,128')).toBe('/blocks/125761128')
    expect(routeForQuery('125_761_128')).toBe('/blocks/125761128')
    expect(routeForQuery('125 761 128')).toBe('/blocks/125761128')
    expect(routeForQuery('#125,761,128')).toBe('/blocks/125761128')
  })

  it('leaves a bare number byte-identical, leading zeros included', () => {
    expect(routeForQuery('007')).toBe('/blocks/007')
  })

  it('sends 0x + 64 hex to /tx unchanged', () => {
    expect(routeForQuery(`0x${TX}`)).toBe(`/tx/0x${TX}`)
  })

  it('adds the missing 0x to a bare 64-hex hash, keeping case', () => {
    expect(routeForQuery(TX)).toBe(`/tx/0x${TX}`)
    expect(routeForQuery(TX.toLowerCase())).toBe(`/tx/0x${TX.toLowerCase()}`)
    expect(routeForQuery(TX.toUpperCase())).toBe(`/tx/0x${TX.toUpperCase()}`)
  })

  it('sends 0x + 40 hex to /address unchanged, and adds a missing 0x', () => {
    expect(routeForQuery(`0x${ADDR}`)).toBe(`/address/0x${ADDR}`)
    expect(routeForQuery(ADDR)).toBe(`/address/0x${ADDR}`)
  })

  it('does not mistake a 40- or 64-digit number for a hash: digits win', () => {
    expect(routeForQuery('1'.repeat(40))).toBe(`/blocks/${'1'.repeat(40)}`)
  })

  it('sends anything else to the search page, encoding the trimmed original', () => {
    expect(routeForQuery('CAKE')).toBe('/search?q=CAKE')
    expect(routeForQuery('  cake coin ')).toBe('/search?q=cake%20coin')
    // A leading # is stripped from a token query too: "#USDT" is a search for USDT.
    expect(routeForQuery('#abc')).toBe('/search?q=abc')
    expect(routeForQuery(`0x${TX}00`)).toBe(`/search?q=0x${TX}00`)
    expect(routeForQuery('0x123')).toBe('/search?q=0x123')
  })

  it('returns null for an empty or blank query', () => {
    expect(routeForQuery('')).toBeNull()
    expect(routeForQuery('   ')).toBeNull()
  })
})

describe('normaliseSearchQuery', () => {
  it('trims, and strips exactly one leading #', () => {
    expect(normaliseSearchQuery('  cake  ')).toBe('cake')
    expect(normaliseSearchQuery('#cake')).toBe('cake')
    expect(normaliseSearchQuery('# cake')).toBe('cake')
    expect(normaliseSearchQuery('##cake')).toBe('#cake')
    expect(normaliseSearchQuery('#')).toBe('')
  })

  it('strips commas, spaces and underscores inside an all-digit query', () => {
    expect(normaliseSearchQuery('#126779120')).toBe('126779120')
    expect(normaliseSearchQuery('126,779,120')).toBe('126779120')
    expect(normaliseSearchQuery('126 779 120')).toBe('126779120')
    expect(normaliseSearchQuery('126_779_120')).toBe('126779120')
    expect(normaliseSearchQuery('#126,779,120 ')).toBe('126779120')
    expect(normaliseSearchQuery('126,779,120,')).toBe('126779120')
  })

  it('leaves separators alone when the query is not all digits', () => {
    expect(normaliseSearchQuery('1inch, v2')).toBe('1inch, v2')
    expect(normaliseSearchQuery('cake coin')).toBe('cake coin')
    expect(normaliseSearchQuery(',,,')).toBe(',,,')
  })

  it('leaves leading zeros alone', () => {
    expect(normaliseSearchQuery('007')).toBe('007')
  })

  it('lowercases a 0X prefix and nothing else of the hex', () => {
    expect(normaliseSearchQuery(`0X${ADDR}`)).toBe(`0x${ADDR}`)
    expect(normaliseSearchQuery(`0X${TX}`)).toBe(`0x${TX}`)
    expect(normaliseSearchQuery('0Xabc')).toBe('0xabc')
  })

  it('prepends 0x to a bare 40- or 64-hex string, keeping its case', () => {
    expect(normaliseSearchQuery(ADDR)).toBe(`0x${ADDR}`)
    expect(normaliseSearchQuery(TX)).toBe(`0x${TX}`)
    expect(normaliseSearchQuery(` #${TX} `)).toBe(`0x${TX}`)
  })

  it('does not touch hex of any other length, or an all-digit string that is 40 or 64 long', () => {
    expect(normaliseSearchQuery('abcdef')).toBe('abcdef')
    expect(normaliseSearchQuery(`${ADDR}0`)).toBe(`${ADDR}0`)
    expect(normaliseSearchQuery('1'.repeat(40))).toBe('1'.repeat(40))
  })

  it('returns the empty string for blank input', () => {
    expect(normaliseSearchQuery('')).toBe('')
    expect(normaliseSearchQuery('   ')).toBe('')
  })
})

describe('classifyQuery', () => {
  it('names what a query will open, from the same normalisation as routeForQuery', () => {
    expect(classifyQuery('#126,779,120')).toEqual({ kind: 'block', q: '126779120' })
    expect(classifyQuery(ADDR)).toEqual({ kind: 'address', q: `0x${ADDR}` })
    expect(classifyQuery(`0X${TX}`)).toEqual({ kind: 'tx', q: `0x${TX}` })
    expect(classifyQuery('usdt')).toEqual({ kind: 'text', q: 'usdt' })
    expect(classifyQuery('   ')).toEqual({ kind: 'text', q: '' })
  })
})
