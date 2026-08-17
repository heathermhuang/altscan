import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Wiring guard for the produce/drain diagnostic.
 *
 * The profile answers a question a SAMPLED metric already got wrong once: the
 * BNB lag was misattributed to a broken RPC because queue depth was read from a
 * log line that fires on a block-number condition, which is a lower bound on the
 * value at stall onset. The replacement only helps if it is actually wired, and
 * this repo has shipped a defined-but-unwired fix before (#92 went inert), so
 * the wiring is asserted rather than assumed.
 *
 * Deliberately a source assertion, not a behavioural test: exercising the real
 * writer would open a Postgres connection — apps/indexer/.env supplies
 * DATABASE_URL, so a "unit" test here writes to a live database.
 */
const src = (f: string) => readFileSync(join(__dirname, f), 'utf8')

describe('tt-writer produce/drain profile wiring', () => {
  it('index.ts reports park AND unpark around the backpressure wait', () => {
    const s = src('index.ts')
    expect(s).toMatch(/import\s*{[^}]*noteWorkerParked/s)
    expect(s).toContain('noteWorkerParked(1)')
    expect(s).toContain('noteWorkerParked(-1)')
  })

  it('the unpark is in a finally, so an abort cannot strand the count high', () => {
    const s = src('index.ts')
    // A stuck-high count would label every later drain pass "blocked" — which is
    // precisely the phase attribution the experiment turns on.
    const finallyBlock = s.slice(s.indexOf('noteWorkerParked(1)'))
    expect(finallyBlock).toMatch(/}\s*finally\s*{[^}]*noteWorkerParked\(-1\)/s)
  })

  it('writeTransferBlocks records a drain pass', () => {
    const s = src('block-processor.ts')
    expect(s).toContain('recordDrainPass(')
    // Phase must be snapshotted BEFORE the transaction: a long drain is what
    // parks the workers, so sampling at completion labels everything "blocked".
    const fn = s.slice(s.indexOf('async function writeTransferBlocks'))
    const wasBlockedIdx = fn.indexOf('const wasBlocked')
    const txIdx = fn.indexOf('await db.transaction')
    expect(wasBlockedIdx).toBeGreaterThan(-1)
    expect(wasBlockedIdx).toBeLessThan(txIdx)
  })

  it('boot states the RESOLVED profile setting, both ways', () => {
    const s = src('block-processor.ts')
    expect(s).toContain('produce/drain PROFILE ON')
    expect(s).toContain('produce/drain profile OFF')
  })
})
