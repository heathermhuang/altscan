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
    const phaseIdx = fn.indexOf('const phase =')
    const txIdx = fn.indexOf('await db.transaction')
    expect(phaseIdx).toBeGreaterThan(-1)
    expect(phaseIdx).toBeLessThan(txIdx)
  })

  /**
   * codex P2. A binary parked>0 test labels a drain "blocked" when only 1 of 8
   * workers has parked and the other 7 still hold pool slots — the highest-
   * contention moment. Folding those into the blocked bucket drags its rate
   * toward the running rate, making connection starvation look like inherent
   * oscillation: the exact confusion this experiment exists to resolve.
   */
  it('classifies drains in three phases, not two', () => {
    const s = src('block-processor.ts')
    expect(s).toMatch(/'none'\s*\|\s*'partial'\s*\|\s*'all'/)
    expect(s).toContain('function phaseFor(')
    // ALL must require the whole pool, so a partially-parked window can never be
    // read as "the writer had the pool to itself".
    expect(s).toMatch(/parked >= profWorkerCount/)
  })

  it('binds the worker count before any initTransferWriter call site', () => {
    const s = src('index.ts')
    expect(s).toContain('setProfileWorkerCount(CONCURRENCY)')
    // Module scope, ahead of every initTransferWriter call — there are three.
    expect(s.indexOf('setProfileWorkerCount(CONCURRENCY)')).toBeLessThan(s.indexOf('initTransferWriter('))
  })

  it('marks a window inconclusive rather than reporting a clean number', () => {
    const s = src('block-processor.ts')
    expect(s).toContain('pool size UNSET')
    expect(s).toContain('need both none+all passes to conclude')
  })

  it('boot states the RESOLVED profile setting, both ways', () => {
    const s = src('block-processor.ts')
    expect(s).toContain('produce/drain PROFILE ON')
    expect(s).toContain('produce/drain profile OFF')
  })
})
