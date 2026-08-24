import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM script, no type declarations (CI runs Node 20,
// which has no type stripping, so the runnable half cannot be TypeScript).
import {
  planDiskGbSync,
  parseTargets,
  readServiceEnv,
  classifyDeployStatus,
  isSyncableService,
  redactIds,
  planFailureRecovery,
  assessUtilisation,
  parseCriticalPct,
  shouldFailRun,
} from './sync-db-disk-size.mjs'

const GIB = 1024 ** 3

describe('planDiskGbSync', () => {
  it('floors the capacity so the safety trigger fires EARLY, never late', () => {
    // The real bnbscan-db reading: 158,404,660,000 bytes = 147.5 GiB.
    // Rounding to 148 would inflate the denominator and make the emergency
    // path fire LATER than the disk actually warrants.
    expect(planDiskGbSync({ capacityBytes: 158_404_660_000, currentGb: 150 })).toMatchObject({
      action: 'update',
      targetGb: 147,
    })
  })

  it('no-ops when the env var already matches, so no needless deploy fires', () => {
    // Every update restarts the indexer and kills any retention run in flight,
    // so "already correct" must never trigger a write.
    expect(planDiskGbSync({ capacityBytes: 147 * GIB, currentGb: 147 })).toMatchObject({
      action: 'noop',
      targetGb: 147,
    })
  })

  it('updates in BOTH directions — the first sync must be allowed to shrink', () => {
    // DB_DISK_GB=150 currently OVERSTATES a 147 GiB disk, so an "only ever
    // raise" rule would permanently block the correction that matters most.
    expect(planDiskGbSync({ capacityBytes: 147 * GIB, currentGb: 150 }).action).toBe('update')
    expect(planDiskGbSync({ capacityBytes: 300 * GIB, currentGb: 147 })).toMatchObject({
      action: 'update',
      targetGb: 300,
    })
  })

  it('refuses a missing or nonsensical capacity instead of writing a denominator', () => {
    // A bogus denominator is worse than a stale one: a huge value silently
    // disables the emergency trigger entirely.
    for (const bad of [undefined, null, NaN, 0, -1, '147', Infinity]) {
      expect(planDiskGbSync({ capacityBytes: bad as never, currentGb: 150 }).action).toBe('refuse')
    }
    expect(planDiskGbSync({ capacityBytes: 1e18, currentGb: 150 }).action).toBe('refuse')
    // Sub-GiB capacity floors to 0, which would divide-by-zero downstream.
    expect(planDiskGbSync({ capacityBytes: 1024, currentGb: 150 }).action).toBe('refuse')
  })

  it('treats an unset or unparseable DB_DISK_GB as something to fix, not to refuse', () => {
    // DB_DISK_GB unset means retention reports 0% and the switch is blind —
    // exactly the state worth correcting.
    expect(planDiskGbSync({ capacityBytes: 147 * GIB, currentGb: NaN })).toMatchObject({
      action: 'update',
      targetGb: 147,
    })
    expect(planDiskGbSync({ capacityBytes: 147 * GIB, currentGb: 0 }).action).toBe('update')
  })
})

describe('parseTargets', () => {
  it('parses service:postgres pairs and tolerates whitespace', () => {
    expect(parseTargets('srv-aaa:dpg-bbb, srv-ccc:dpg-ddd')).toEqual([
      { serviceId: 'srv-aaa', postgresId: 'dpg-bbb' },
      { serviceId: 'srv-ccc', postgresId: 'dpg-ddd' },
    ])
  })

  it('throws on a malformed or reversed pair rather than skipping a database', () => {
    // Silently skipping one target would leave that indexer on a stale
    // denominator with nothing in the log to say so.
    expect(() => parseTargets('dpg-bbb:srv-aaa')).toThrow()
    expect(() => parseTargets('srv-aaa')).toThrow()
    expect(() => parseTargets('srv-aaa:dpg-bbb,garbage')).toThrow()
    expect(() => parseTargets('')).toThrow()
    expect(() => parseTargets(undefined)).toThrow()
  })
})

describe('readServiceEnv — the fail-closed service/database binding check', () => {
  const PG = 'dpg-d7e4b83bc2fs73ec3l9g-a'
  const url = (host: string) => `postgres://u:p@${host}.oregon-postgres.render.com/db`
  const wrap = (pairs: Record<string, string>) =>
    Object.entries(pairs).map(([key, value]) => ({ envVar: { key, value } }))

  it('binds when a DATABASE_URL points at the measured database', () => {
    const { diskGb, bound } = readServiceEnv(
      wrap({ DB_DISK_GB: '150', DATABASE_URL: url('dpg-d7e4b83bc2fs73ec3l9g') }),
      PG,
    )
    expect(bound).toBe(true)
    expect(diskGb).toBe(150)
  })

  it('binds on a chain-prefixed key too — ETH uses ETH_DATABASE_URL, not DATABASE_URL', () => {
    expect(
      readServiceEnv(wrap({ ETH_DATABASE_URL: url('dpg-d7e4b83bc2fs73ec3l9g') }), PG).bound,
    ).toBe(true)
  })

  it('REFUSES to bind a service wired to a different database', () => {
    // The swapped-pair case: measuring one database and writing the result to
    // an unrelated service. If the measured one is bigger, DB_DISK_GB inflates
    // and the emergency disk trigger silently stops firing.
    expect(readServiceEnv(wrap({ DATABASE_URL: url('dpg-someotherdatabase') }), PG).bound).toBe(false)
  })

  it('fails CLOSED on missing, empty, or malformed input rather than assuming a match', () => {
    expect(readServiceEnv(wrap({ DB_DISK_GB: '150' }), PG).bound).toBe(false)
    expect(readServiceEnv([], PG).bound).toBe(false)
    expect(readServiceEnv(undefined as never, PG).bound).toBe(false)
    // An empty/garbage postgres id must NOT make `.includes('')` true for every
    // URL — that would turn this check into a no-op that always passes.
    expect(readServiceEnv(wrap({ DATABASE_URL: url('dpg-anything') }), '').bound).toBe(false)
    expect(readServiceEnv(wrap({ DATABASE_URL: url('dpg-anything') }), '-a').bound).toBe(false)
  })

  it('reports DB_DISK_GB as NaN when absent, which the planner treats as fixable', () => {
    expect(readServiceEnv(wrap({ DATABASE_URL: url('dpg-d7e4b83bc2fs73ec3l9g') }), PG).diskGb).toBeNaN()
  })
})

describe('classifyDeployStatus', () => {
  it('counts a superseded deploy as SUCCESS, not failure', () => {
    // `deactivated` is what a deploy that went live becomes once a newer one
    // replaces it. Calling that a failure would roll back a change that is
    // actually running -- and every observed historical deploy sits in this
    // state, so getting it wrong would misread the common case.
    expect(classifyDeployStatus('live')).toBe('success')
    expect(classifyDeployStatus('deactivated')).toBe('success')
  })

  it('keeps polling through every in-flight state', () => {
    for (const s of [
      'created', 'queued', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress',
    ]) {
      expect(classifyDeployStatus(s)).toBe('pending')
    }
  })

  it('treats real failures AND unknown statuses as failure', () => {
    // Fail-closed on unknown: a wrong "success" wedges the job permanently
    // (stored value matches, so every later run no-ops while the process keeps
    // its old snapshot), whereas a wrong "failure" costs one extra deploy.
    for (const s of [
      'build_failed', 'update_failed', 'pre_deploy_failed', 'canceled',
      'something_render_added_later', undefined, null, '',
    ]) {
      expect(classifyDeployStatus(s as never)).toBe('failure')
    }
  })
})

describe('isSyncableService', () => {
  it('accepts a background worker and rejects the web service on the SAME database', () => {
    // The binding check alone cannot separate these: render.yaml gives the web
    // service and the indexer the same DATABASE_URL, so a web-service id would
    // otherwise be updated and deployed while the real indexer stayed stale.
    expect(isSyncableService({ type: 'background_worker' })).toBe(true)
    expect(isSyncableService({ type: 'web_service' })).toBe(false)
    expect(isSyncableService({ type: 'static_site' })).toBe(false)
    expect(isSyncableService({})).toBe(false)
    expect(isSyncableService(undefined)).toBe(false)
  })
})

describe('redactIds', () => {
  it('scrubs service, database and deploy ids from public log output', () => {
    expect(redactIds('PUT /services/srv-abc123/env-vars/DB_DISK_GB')).toBe(
      'PUT /services/<srv-id>/env-vars/DB_DISK_GB',
    )
    expect(redactIds('dpg-d7e4b83bc2fs73ec3l9g-a and dep-xyz789')).toBe('<dpg-id> and <dep-id>')
  })

  it('leaves ordinary text alone', () => {
    expect(redactIds('real capacity 147GiB != DB_DISK_GB 150GiB')).toBe(
      'real capacity 147GiB != DB_DISK_GB 150GiB',
    )
  })
})

describe('parseTargets — strict field count', () => {
  it('rejects a missing comma instead of silently dropping the later targets', () => {
    // "srv-a:dpg-b:srv-c:dpg-d" destructures to a valid-looking first pair.
    // Accepting it would finish green with one indexer never synced.
    expect(() => parseTargets('srv-aaa:dpg-bbb:srv-ccc:dpg-ddd')).toThrow()
    expect(() => parseTargets('srv-aaa:dpg-bbb:')).toThrow()
  })

  it('does not leak ids into the thrown message', () => {
    expect(() => parseTargets('srv-secret1:dpg-secret2:extra')).toThrow(/<srv-id>:<dpg-id>/)
  })
})

describe('readServiceEnv — parse semantics must mirror the shipped indexer', () => {
  const PG = 'dpg-abc-a'
  const wrap = (pairs: Record<string, string>) =>
    Object.entries(pairs).map(([key, value]) => ({ envVar: { key, value } }))
  const withDb = (extra: Record<string, string>) =>
    wrap({ DATABASE_URL: 'postgres://u:p@dpg-abc.oregon-postgres.render.com/d', ...extra })

  it('uses parseInt like retention-cleanup.ts:31, NOT Number', () => {
    // retention-cleanup does parseInt(env ?? '0', 10). Number('150GB') is NaN
    // but parseInt reads 150 -- so a strict parse would call a present, WORKING
    // denominator "absent" and delete it during a rollback.
    expect(readServiceEnv(withDb({ DB_DISK_GB: '150GB' }), PG).diskGb).toBe(150)
    expect(readServiceEnv(withDb({ DB_DISK_GB: '147' }), PG).diskGb).toBe(147)
  })

  it('distinguishes ABSENT from present-but-unparseable, because rollback differs', () => {
    // Absent -> rollback must DELETE. Present -> rollback must restore the raw
    // string verbatim, even if it is junk, so the process view is reproduced.
    expect(readServiceEnv(withDb({}), PG).rawDiskGb).toBeNull()
    expect(readServiceEnv(withDb({ DB_DISK_GB: 'junk' }), PG).rawDiskGb).toBe('junk')
    expect(readServiceEnv(withDb({ DB_DISK_GB: 'junk' }), PG).diskGb).toBeNaN()
    expect(readServiceEnv(withDb({ DB_DISK_GB: '' }), PG).rawDiskGb).toBe('')
  })

  it('surfaces the interrupted-run marker', () => {
    // Without this, a run killed between the env write and a finished deploy
    // leaves stored == target while the process keeps the old value, and every
    // later run reads "noop" forever.
    expect(readServiceEnv(withDb({}), PG).pendingTarget).toBeNull()
    expect(readServiceEnv(withDb({ DB_DISK_GB_SYNC_PENDING: '147' }), PG).pendingTarget).toBe('147')
  })
})

describe('planFailureRecovery — the marker must outlive a failed reconciliation', () => {
  it('rolls back and clears the marker on a normal failed update', () => {
    // We overwrote a known previous value, so restoring it makes config and the
    // running process agree again -- at which point the marker is meaningless.
    expect(planFailureRecovery({ interrupted: false })).toEqual({
      rollback: true,
      clearMarker: true,
    })
  })

  it('does NEITHER when reconciling, or it rebuilds the wedge it exists to prevent', () => {
    // Reconcile means an earlier run already wrote the target and died before
    // deploying, so rawDiskGb IS the target, not the running value. "Rolling
    // back" would rewrite the same number and change nothing, and clearing the
    // marker would make every later run see a clean no-op while the process
    // keeps its old denominator -- permanently.
    expect(planFailureRecovery({ interrupted: true })).toEqual({
      rollback: false,
      clearMarker: false,
    })
  })
})

describe('assessUtilisation — the only honest disk figure in the system', () => {
  const GIB = 1024 ** 3

  it('reports TRUE volume use, which pg_database_size structurally cannot see', () => {
    // Real BNB reading 2026-08-24: 130.50 GiB used of 147.53 GiB, where
    // pg_database_size saw only 126.40 GiB. The 4.10 GiB it misses is WAL,
    // temp files and logs sharing the volume -- and pg_ls_waldir() is
    // permission-denied for the app role, so SQL cannot close the gap at all.
    const r = assessUtilisation({
      usageBytes: 130.50 * GIB,
      capacityBytes: 147.53 * GIB,
      criticalPct: 93,
    })
    expect(r.ok).toBe(true)
    expect(r.pct).toBeCloseTo(88.5, 1)
    // The indexer would report 126.40/147 = 86.0% for this same moment.
    expect(r.critical).toBe(false)
  })

  it('flags critical only at or above the threshold', () => {
    const at = (u: number) =>
      assessUtilisation({ usageBytes: u * GIB, capacityBytes: 100 * GIB, criticalPct: 93 })
    expect(at(92.9).critical).toBe(false)
    expect(at(93).critical).toBe(true)
    expect(at(99).critical).toBe(true)
  })

  it('does NOT fail the run for the 85-90% band BNB legitimately lives in', () => {
    // A monitor pinned red is one people stop reading. BNB sawtooths through
    // the high 80s every cycle; only genuine near-full should break the build.
    for (const pct of [85, 86, 88.5, 90, 92]) {
      expect(
        assessUtilisation({ usageBytes: pct * GIB, capacityBytes: 100 * GIB, criticalPct: 93 })
          .critical,
      ).toBe(false)
    }
  })

  it('reports unusable metrics instead of inventing a percentage', () => {
    for (const bad of [undefined, null, NaN, -1, '90']) {
      expect(
        assessUtilisation({ usageBytes: bad as never, capacityBytes: 100 * GIB, criticalPct: 93 }).ok,
      ).toBe(false)
    }
    // A zero or missing capacity would divide by zero into Infinity and fire.
    expect(assessUtilisation({ usageBytes: 1, capacityBytes: 0, criticalPct: 93 }).ok).toBe(false)
    expect(assessUtilisation({ usageBytes: 1, capacityBytes: NaN, criticalPct: 93 }).ok).toBe(false)
  })
})

describe('parseCriticalPct', () => {
  it('defaults to the indexer own action threshold so both speak the same language', () => {
    expect(parseCriticalPct(undefined)).toBe(93)
    expect(parseCriticalPct('')).toBe(93)
    expect(parseCriticalPct(null)).toBe(93)
  })

  it('accepts a valid override and rejects nonsense back to the default', () => {
    expect(parseCriticalPct('88')).toBe(88)
    expect(parseCriticalPct('95.5')).toBe(95.5)
    for (const bad of ['0', '-5', '101', 'abc', '  ']) expect(parseCriticalPct(bad)).toBe(93)
  })
})

describe('shouldFailRun', () => {
  it('passes only when nothing is wrong', () => {
    expect(shouldFailRun({ failed: 0, critical: 0, blind: 0 })).toBe(false)
    expect(shouldFailRun()).toBe(false)
  })

  it('fails on an UNMEASURED disk, not just a full or unsynced one', () => {
    // The regression this pins: an unusable disk-usage metric previously only
    // warned, so the job exited 0 and summarised "0 at/over" while measuring
    // nothing at all. The disk could then cross the line for days behind a
    // green workflow. Blindness is a failure, not a footnote.
    expect(shouldFailRun({ blind: 1 })).toBe(true)
  })

  it('fails independently for each reason', () => {
    expect(shouldFailRun({ failed: 1 })).toBe(true)
    expect(shouldFailRun({ critical: 1 })).toBe(true)
    expect(shouldFailRun({ failed: 1, critical: 2, blind: 3 })).toBe(true)
  })
})
