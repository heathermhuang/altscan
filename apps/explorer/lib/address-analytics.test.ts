import { describe, expect, it } from 'vitest'
import { FLOW_SAMPLE_CAP, flowLabel, flowValue, parseFlowRow } from './address-analytics'

describe('flowLabel', () => {
  it('says "last 1,000" once the sample hit the cap, so the figure is not read as a lifetime total', () => {
    expect(flowLabel('Sent', { totalWei: '1', count: FLOW_SAMPLE_CAP })).toBe('Sent (last 1,000 indexed transactions)')
    expect(flowLabel('Received', { totalWei: '1', count: FLOW_SAMPLE_CAP })).toBe('Received (last 1,000 indexed transactions)')
  })

  it('names the count it actually summed below the cap', () => {
    expect(flowLabel('Sent', { totalWei: '1', count: 37 })).toBe('Sent (37 indexed transactions)')
    expect(flowLabel('Sent', { totalWei: '0', count: 1 })).toBe('Sent (1 indexed transaction)')
    expect(flowLabel('Received', { totalWei: '0', count: 0 })).toBe('Received (0 indexed transactions)')
  })

  it('is the bare kind when the read failed', () => {
    expect(flowLabel('Sent', null)).toBe('Sent')
  })
})

describe('flowValue', () => {
  it('renders "—", not zero, when the read failed', () => {
    expect(flowValue(null, 'BNB')).toBe('—')
  })

  it('renders a real zero as zero and a sum with its unit', () => {
    expect(flowValue({ totalWei: '0', count: 0 }, 'BNB')).toBe('0 BNB')
    expect(flowValue({ totalWei: '1500000000000000000', count: 2 }, 'ETH')).toBe('1.5 ETH')
  })

  it('tolerates the decimal tail a numeric SUM can carry', () => {
    expect(flowValue({ totalWei: '1500000000000000000.000000', count: 2 }, 'BNB')).toBe('1.5 BNB')
  })
})

describe('parseFlowRow', () => {
  it('reads the postgres.js shape: numeric as a string, count(*) as a string', () => {
    expect(parseFlowRow({ total: '2500000000000000000', n: '1000' })).toEqual({ totalWei: '2500000000000000000', count: 1000 })
  })

  it('treats a missing or malformed row as a failed read rather than a zero', () => {
    for (const bad of [undefined, null, {}, { total: null, n: 3 }, { total: 'NaN', n: 3 }, { total: '5', n: 'x' }, { total: '5', n: -1 }]) {
      expect(parseFlowRow(bad)).toBeNull()
    }
  })
})
