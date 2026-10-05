import { describe, expect, it } from 'vitest'
import { routeForQuery } from '@/lib/search-route'

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
    expect(routeForQuery('#abc')).toBe('/search?q=%23abc')
    expect(routeForQuery(`0x${TX}00`)).toBe(`/search?q=0x${TX}00`)
    expect(routeForQuery('0x123')).toBe('/search?q=0x123')
  })

  it('returns null for an empty or blank query', () => {
    expect(routeForQuery('')).toBeNull()
    expect(routeForQuery('   ')).toBeNull()
  })
})
