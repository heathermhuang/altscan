import { describe, expect, it } from 'vitest'
import { classifyHealth, STALE_LAG_SECONDS } from './classify.js'

describe('classifyHealth', () => {
  it('is operational for ok with a fresh head', () => {
    expect(classifyHealth({ status: 'ok', latestBlock: 100, lagSeconds: 3 })).toEqual({
      status: 'operational',
      latestBlock: 100,
      lagSeconds: 3,
    })
  })

  it('treats a head at exactly the stale threshold as operational, one past it as degraded', () => {
    expect(classifyHealth({ status: 'ok', latestBlock: 1, lagSeconds: STALE_LAG_SECONDS }).status).toBe('operational')
    expect(classifyHealth({ status: 'ok', latestBlock: 1, lagSeconds: STALE_LAG_SECONDS + 1 }).status).toBe('degraded')
  })

  it('is degraded when the explorer reports ok but has no head', () => {
    expect(classifyHealth({ status: 'ok', latestBlock: null, lagSeconds: null }).status).toBe('degraded')
  })

  it('is degraded when only one of head and lag is present', () => {
    expect(classifyHealth({ status: 'ok', latestBlock: 100, lagSeconds: null }).status).toBe('degraded')
    expect(classifyHealth({ status: 'ok', latestBlock: null, lagSeconds: 3 }).status).toBe('degraded')
  })

  it('is degraded when fields are absent or the wrong type', () => {
    expect(classifyHealth({ status: 'ok' }).status).toBe('degraded')
    expect(classifyHealth({ status: 'ok', latestBlock: '100', lagSeconds: '3' }).status).toBe('degraded')
  })

  it('stays degraded when the explorer says degraded, and keeps the numbers it sent', () => {
    expect(classifyHealth({ status: 'degraded', latestBlock: 100, lagSeconds: 3 })).toEqual({
      status: 'degraded',
      latestBlock: 100,
      lagSeconds: 3,
    })
  })

  it('is degraded with no stale numbers for an unrecognised payload', () => {
    expect(classifyHealth({ status: 'error', latestBlock: 100, lagSeconds: 3 })).toEqual({
      status: 'degraded',
      latestBlock: null,
      lagSeconds: null,
    })
  })
})
