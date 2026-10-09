import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_TIMEOUT_MS, withTimeout } from './with-timeout'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('withTimeout', () => {
  it('resolves with the value and leaves no timer pending', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes the original rejection through and leaves no timer pending', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects with "query timeout" once the wait is over', async () => {
    const never = new Promise<number>(() => {})
    const p = withTimeout(never, 1000)
    const settled = expect(p).rejects.toThrow('query timeout')
    await vi.advanceTimersByTimeAsync(999)
    expect(vi.getTimerCount()).toBe(1)   // still waiting a millisecond before the deadline
    await vi.advanceTimersByTimeAsync(1)
    await settled
  })

  it('a rejection arriving after the deadline is swallowed, not unhandled', async () => {
    let fail!: (e: Error) => void
    const late = new Promise<number>((_, rej) => { fail = rej })
    const p = withTimeout(late, 10)
    const settled = expect(p).rejects.toThrow('query timeout')
    await vi.advanceTimersByTimeAsync(10)
    await settled
    fail(new Error('too late'))           // would surface as an unhandled rejection if nothing were attached
    await vi.advanceTimersByTimeAsync(0)
  })

  it('defaults to the database bound', async () => {
    const p = withTimeout(new Promise<number>(() => {}))
    const settled = expect(p).rejects.toThrow('query timeout')
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS)
    await settled
    expect(DB_TIMEOUT_MS).toBe(8000)
  })
})
