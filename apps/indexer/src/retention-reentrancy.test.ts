import { describe, expect, it } from 'vitest'
import { makeSingleFlight } from './retention-cleanup'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

describe('makeSingleFlight (retention re-entrancy guard)', () => {
  it('skips a tick that fires while a run is in flight, and reports the skip', async () => {
    const gate = deferred()
    let skips = 0
    const guarded = makeSingleFlight(() => gate.promise, () => { skips++ })
    const first = guarded()
    const second = await guarded()      // interval tick firing mid-run
    expect(second).toBe('skipped')
    expect(skips).toBe(1)
    gate.resolve()
    expect(await first).toBe('ran')
  })

  it('runs again once the previous run completes', async () => {
    let runs = 0
    const guarded = makeSingleFlight(async () => { runs++ }, () => {})
    expect(await guarded()).toBe('ran')
    expect(await guarded()).toBe('ran')
    expect(runs).toBe(2)
  })

  it('releases the guard when the run throws, so the next tick still runs', async () => {
    let calls = 0
    const guarded = makeSingleFlight(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
    }, () => {})
    await expect(guarded()).rejects.toThrow('boom')
    expect(await guarded()).toBe('ran')
    expect(calls).toBe(2)
  })
})
