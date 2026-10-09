import { describe, expect, it } from 'vitest'
import { formatSpan, ledgerWeight, toLedgerRows } from '@/lib/ledger'
import { groupDigits } from '@/lib/format'

const A = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3'
const other = '0x1111111111111111111111111111111111111111'

describe('toLedgerRows', () => {
  it('sorts oldest first and takes direction from a provider category first', () => {
    const rows = toLedgerRows(A, [
      { time: '2026-10-09T06:39:53Z', fromAddress: A, toAddress: other, value: '0', category: 'token send' },
      { time: '2026-10-09T06:39:05Z', fromAddress: other, toAddress: other, value: '0', category: 'token receive' },
    ])
    expect(rows.map(r => r.dir)).toEqual(['in', 'out'])
    expect(rows[0].t).toBeLessThan(rows[1].t)
  })
  it('falls back to from/to (local rows), with a self-send counted as sent', () => {
    const rows = toLedgerRows(A.toUpperCase().replace('0X', '0x'), [
      { time: new Date(1000_000), fromAddress: other, toAddress: A, value: '1500000000000000000.000000000000000000' },
      { time: new Date(2000_000), fromAddress: A, toAddress: A, value: '0' },
      { time: new Date(3000_000), fromAddress: A, toAddress: null, value: '0' },
    ])
    expect(rows.map(r => r.dir)).toEqual(['in', 'out', 'out'])
  })
  it('marks native value (decimal-tailed numeric strings included) and spam', () => {
    const [r] = toLedgerRows(A, [{ time: new Date(0), fromAddress: other, toAddress: A, value: '1.000000000000000000', possibleSpam: true }])
    expect(r.native).toBe(true)
    expect(r.spam).toBe(true)
  })
  it('does not call zero or missing value native', () => {
    const rows = toLedgerRows(A, [
      { time: new Date(1000), fromAddress: A, toAddress: other, value: '0' },
      { time: new Date(2000), fromAddress: A, toAddress: other, value: '0.000000000000000000' },
      { time: new Date(3000), fromAddress: A, toAddress: other, value: null },
    ])
    expect(rows.map(r => r.native)).toEqual([false, false, false])
    expect(rows.map(r => r.spam)).toEqual([false, false, false])
  })
  it('keeps chain order for rows that share a second: newest-first input, newest on the right', () => {
    const rows = toLedgerRows(A, [
      { time: '2026-10-09T06:39:53Z', fromAddress: A, toAddress: other, value: '0', category: 'token send' },      // newest
      { time: '2026-10-09T06:39:53Z', fromAddress: other, toAddress: other, value: '0', category: 'token receive' },
      { time: '2026-10-09T06:39:53Z', fromAddress: A, toAddress: other, value: '5', category: 'send' },            // oldest
    ])
    expect(rows.map(r => [r.dir, r.native])).toEqual([['out', true], ['in', false], ['out', false]])
    // and a later second still sorts after, whatever the input order
    const mixed = toLedgerRows(A, [
      { time: '2026-10-09T06:39:54Z', fromAddress: other, toAddress: A, value: '0' },
      { time: '2026-10-09T06:39:53Z', fromAddress: A, toAddress: other, value: '0' },
    ])
    expect(mixed.map(r => r.dir)).toEqual(['out', 'in'])
  })
  it('draws no ledger when any row has no usable time', () => {
    const ok = { time: '2026-10-09T06:39:53Z', fromAddress: A, toAddress: other, value: '0' }
    expect(toLedgerRows(A, [ok, { ...ok, time: 'not a date' }])).toEqual([])
    expect(toLedgerRows(A, [ok, { ...ok, time: new Date(NaN) }])).toEqual([])
    expect(toLedgerRows(A, [ok, ok])).toHaveLength(2)
  })
})

describe('ledgerWeight', () => {
  it('is 1 + log2(1 + gap), to 2 dp, never below 1', () => {
    expect(ledgerWeight(0)).toBe(1)
    expect(ledgerWeight(1)).toBe(2)
    expect(ledgerWeight(3)).toBe(3)
    expect(ledgerWeight(-5)).toBe(1)
    expect(ledgerWeight(86_400)).toBeCloseTo(17.4, 1)
  })
})

describe('formatSpan', () => {
  it('reads in the largest sensible unit', () => {
    expect(formatSpan(0)).toBe('0 seconds')
    expect(formatSpan(1)).toBe('1 second')
    expect(formatSpan(15)).toBe('15 seconds')
    expect(formatSpan(150)).toBe('3 minutes')
    expect(formatSpan(7_200)).toBe('2 hours')
    expect(formatSpan(3 * 86_400)).toBe('3 days')
  })
  it('rolls each unit over into the next cleanly at its upper edge', () => {
    expect(formatSpan(119)).toBe('119 seconds')
    expect(formatSpan(120)).toBe('2 minutes')
    expect(formatSpan(7_199)).toBe('2 hours')        // not "120 minutes"
    expect(formatSpan(7_200)).toBe('2 hours')
    expect(formatSpan(172_799)).toBe('2 days')       // not "48 hours"
    expect(formatSpan(172_800)).toBe('2 days')
    expect(formatSpan(7_139)).toBe('119 minutes')
  })
})

describe('groupDigits', () => {
  it('groups the integer part only', () => {
    expect(groupDigits('200154.69934993')).toBe('200,154.69934993')
    expect(groupDigits('999')).toBe('999')
    expect(groupDigits('<0.0001')).toBe('<0.0001')
    expect(groupDigits('1234567')).toBe('1,234,567')
  })
})
