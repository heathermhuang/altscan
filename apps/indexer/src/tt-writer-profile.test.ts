import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// phaseFor is PURE — no getDb(), no queue mutation. Importing block-processor is
// safe here because its module scope only parses env; getDb() is called inside
// functions. Do NOT extend this file to call setDurableFloor/enqueueTransferWrite:
// apps/indexer/.env supplies DATABASE_URL, so those write to a live database.
import { phaseFor } from './block-processor'

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

  it('binds the worker count before any initTransferWriter call site', () => {
    const s = src('index.ts')
    expect(s).toContain('setProfileWorkerCount(CONCURRENCY)')
    // Module scope, ahead of every initTransferWriter call — there are three.
    expect(s.indexOf('setProfileWorkerCount(CONCURRENCY)')).toBeLessThan(s.indexOf('initTransferWriter('))
  })

  it('reports worker ACTIVE as well as PARKED around the batch loop', () => {
    const s = src('index.ts')
    expect(s).toContain('noteWorkerActive(1)')
    // finally, so the tail return / failure abort / shutdown paths all account.
    const body = s.slice(s.indexOf('noteWorkerActive(1)'))
    expect(body).toMatch(/}\s*finally\s*{\s*noteWorkerActive\(-1\)/s)
  })
})

/**
 * Behavioural test of the phase mapping. (codex P2, round 2.)
 *
 * The previous version only matched source literals, so returning the wrong
 * bucket — or leaving the branch dead — would still have passed, meaning the
 * regression it claimed to pin was not pinned at all. phaseFor is pure and
 * exported precisely so this can CALL it. No DB is touched.
 */
describe('phaseFor', () => {
  const N = 8
  it('NONE only when the pool is full and nobody is parked', () => {
    expect(phaseFor(0, N, N)).toBe('none')
  })

  /**
   * The bug this round fixed. A worker that reaches the batch tail returns via
   * claimNext() === -1 WITHOUT parking, so parked===0 also describes "7 workers
   * went home, 1 straggler" — a LOW-contention state. Scoring that as `none`
   * (full competition) drags the none-bucket's rate toward the all-bucket's and
   * hides connection starvation, which is what the experiment tests for.
   */
  it('is NOT none when workers have drained away, even with nobody parked', () => {
    expect(phaseFor(0, 1, N)).toBe('partial')
    expect(phaseFor(0, 0, N)).toBe('partial')
    expect(phaseFor(0, N - 1, N)).toBe('partial')
  })

  it('ALL only when every worker is parked', () => {
    expect(phaseFor(N, 0, N)).toBe('all')
    expect(phaseFor(N - 1, 1, N)).toBe('partial')
  })

  it('treats an over-reported park count as ALL, never inventing contention', () => {
    // Over-reporting must weaken a contention conclusion, not manufacture one.
    expect(phaseFor(N + 3, 0, N)).toBe('all')
  })

  it('refuses to classify without a known pool size', () => {
    expect(phaseFor(0, 8, 0)).toBe('partial')
    expect(phaseFor(8, 0, 0)).toBe('partial')
  })

  it('marks a window inconclusive rather than reporting a clean number', () => {
    const s = src('block-processor.ts')
    expect(s).toContain('pool size UNSET')
    expect(s).toContain('need both none+all passes to conclude')
  })

  /**
   * codex P1. `tEnter - tStart` includes callback SCHEDULING delay, not just
   * pool acquisition — so a saturated event loop (M2) inflates the very number
   * meant to identify pool starvation (M1). An independent loop-lag measurement
   * is what makes acq interpretable at all; without it the headline discriminator
   * is unsound.
   */
  it('measures event-loop lag independently of acquisition', () => {
    const s = src('block-processor.ts')
    expect(s).toContain('startLoopLagProbe')
    expect(s).toContain('loopLag')
    // Must not hold the process open at shutdown.
    expect(s).toMatch(/timer\.unref\?\.\(\)/)
  })

  /**
   * codex P2. A pool timeout throws BEFORE the callback runs, so it never reaches
   * the success path — the strongest evidence for M1 would vanish entirely,
   * leaving only fast successful acquisitions and a false "no starvation here".
   */
  it('counts acquisitions that fail before callback entry, and rethrows', () => {
    const s = src('block-processor.ts')
    const fn = s.slice(s.indexOf('async function writeTransferBlocks'))
    expect(fn).toMatch(/tEnter === 0\) ttProf\.acquireFailures\+\+/)
    // The writer's retry/alerting owns this error — the probe must not swallow it.
    const catchBlock = fn.slice(fn.indexOf('} catch (err) {'))
    expect(catchBlock).toMatch(/throw err/)
  })

  it('reports batch SHAPE, not just rate, so a rate gap is attributable', () => {
    // An `all` pass drains a high-water backlog; a `none` pass is small. Fixed
    // per-transaction overhead alone makes those rates differ at identical
    // resource availability. (codex P2.)
    const s = src('block-processor.ts')
    expect(s).toMatch(/r\+\$\{.*blocks\[p\].*\}blk\/pass/s)
  })

  it('routes the writer through getWriterDb and announces the A/B arm', () => {
    const s = src('block-processor.ts')
    const fn = s.slice(s.indexOf('async function writeTransferBlocks'))
    expect(fn).toMatch(/const db = getWriterDb\(\)/)
    // Both arms printed from the resolved env value, so a run can never be
    // attributed to the wrong arm after the fact.
    expect(s).toContain('dedicated writer pool ON')
    expect(s).toContain('dedicated writer pool OFF')
  })

  it('boot states the RESOLVED profile setting, both ways', () => {
    const s = src('block-processor.ts')
    expect(s).toContain('produce/drain PROFILE ON')
    expect(s).toContain('produce/drain profile OFF')
  })
})
