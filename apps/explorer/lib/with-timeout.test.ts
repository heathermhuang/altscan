import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

describe('withTimeout label', () => {
  it('names what was slow', async () => {
    const p = withTimeout(new Promise<number>(() => {}), 10, 'whales native')
    const settled = expect(p).rejects.toThrow(/^whales native timeout$/)
    await vi.advanceTimersByTimeAsync(10)
    await settled
  })
})

// One wait-bound helper in the explorer. Two private copies had drifted from it: one resolved
// a fallback and never cleared its timer, one put the bound in its message.
const ROOT = join(__dirname, '..')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) return []
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('one withTimeout in apps/explorer', () => {
  it('no other module declares its own', () => {
    const declares = /\b(?:function|const|let)\s+withTimeout\b/
    const hits = sources(ROOT).filter((f) => declares.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length + 1))
    expect(hits).toEqual([join('lib', 'with-timeout.ts')])
  })
})
