import { describe, it, expect, vi, afterEach } from 'vitest'
import { swallow, swallowed, resetSwallowThrottle } from './observability'

afterEach(() => {
  vi.restoreAllMocks()
  resetSwallowThrottle()
})

describe('swallow', () => {
  it('logs the failure under a greppable [tag], which is how these are found in Render logs', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    swallow('tx/logs', new Error('connection refused'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('[tx/logs]')
    expect(String(spy.mock.calls[0][1])).toContain('connection refused')
  })

  it('never throws, whatever it is handed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => swallow('t', undefined)).not.toThrow()
    expect(() => swallow('t', null)).not.toThrow()
    expect(() => swallow('t', 'a string')).not.toThrow()
    expect(() => swallow('t', { circular: {} })).not.toThrow()
  })

  // A DB outage fails every request on every page. Unthrottled, that turns a
  // useful signal into a log flood that costs money and buries the first
  // occurrence -- the one that says when it started.
  it('throttles repeats of the same tag but always emits the first', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 50; i++) swallow('addr/holdings', new Error('boom'))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('throttles per tag, so one noisy path cannot mask another', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    swallow('a', new Error('x'))
    swallow('a', new Error('x'))
    swallow('b', new Error('y'))
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['[a]', '[b]'])
  })
})

describe('swallowed', () => {
  it('returns the fallback so it drops into .catch() unchanged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const rows = await Promise.reject(new Error('db down')).catch(swallowed('tx/logs', []))
    expect(rows).toEqual([])
  })

  it('logs while returning the fallback — the whole point over `.catch(() => [])`', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await Promise.reject(new Error('db down')).catch(swallowed('tx/transfers', []))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('[tx/transfers]')
  })

  it('preserves the fallback value identity for non-array fallbacks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await Promise.reject(new Error('x')).catch(swallowed('t', null))).toBeNull()
    expect(await Promise.reject(new Error('x')).catch(swallowed('t', 0))).toBe(0)
  })
})
