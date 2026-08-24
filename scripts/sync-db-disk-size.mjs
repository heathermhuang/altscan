/**
 * Keep each indexer's `DB_DISK_GB` equal to its database's REAL provisioned disk.
 *
 * WHY THIS EXISTS. retention-cleanup's `diskPctNow()` is
 * `pg_database_size() / DB_DISK_GB`, and `DB_DISK_GB` is a static env var. That
 * was merely imprecise while disk size was hand-managed. Once disk autoscaling
 * is on (enabled on bnbscan-db 2026-08-24) it becomes actively dangerous: Render
 * grows the volume, the indexer keeps dividing by the old number, and the
 * emergency path fires `runCleanup({compactDays:1})` — permanently deleting the
 * A1 compact history — against a ceiling that no longer exists. Past the stale
 * ceiling it computes >100% and fires on EVERY run.
 *
 * It cannot be defused from the other side either: `parsePercentEnv` rejects any
 * threshold above 100 and silently falls back to 93.
 *
 * WHY A SCHEDULED JOB AND NOT AN API CALL IN THE INDEXER. Reading the real size
 * means calling the Render API, and Render has no scoped or read-only keys — a
 * key can delete every service and database in the account. The indexer parses
 * untrusted chain data and third-party provider responses, so it is the worst
 * place in the system to hold that credential. Here the key lives in CI instead,
 * and the indexer keeps reading a plain number from its own env.
 *
 * THE INVARIANT THAT DRIVES THE ERROR HANDLING. Stored env value and RUNNING
 * process value must never silently disagree, because the next run compares
 * against the STORED value: if a write lands but the deploy does not, every
 * later run sees `noop` while the process keeps its old snapshot forever — a
 * permanent wedge behind a green job. So a write is only allowed to stand once
 * a deploy has been observed reaching a terminal SUCCESS; anything else is
 * rolled back so the next run re-detects the mismatch.
 *
 * Usage (local; CI never passes --dry-run):
 *   RENDER_API_KEY=...  DISK_SYNC_TARGETS="srv-aaa:dpg-bbb,srv-ccc:dpg-ddd" \
 *     node scripts/sync-db-disk-size.mjs [--dry-run]
 *
 * Render IDs come from the environment on purpose: CLAUDE.md forbids hardcoding
 * service/database IDs in the repo.
 */

const GIB = 1024 ** 3
const API = 'https://api.render.com/v1'

/** Upper sanity bound on a plausible disk, in GiB. Guards against a malformed
 *  metric turning into an absurd denominator that disables the safety trigger. */
const MAX_PLAUSIBLE_GB = 100_000

/** Deploys here take ~1.5 min; budget well past that. On timeout we roll back
 *  and let the next run retry, which costs at most one extra deploy and can
 *  never wedge — whereas trusting an unfinished deploy can. */
const DEPLOY_POLL_MS = 10_000
const DEPLOY_TIMEOUT_MS = 10 * 60_000

/**
 * Durable "a write is in flight" marker, written BEFORE DB_DISK_GB changes.
 *
 * Everything else here assumes the script gets to run its own error handling,
 * and a hard kill breaks that assumption: cancel the workflow (or lose the PUT
 * response) between the env write and a completed deploy, and stored config now
 * equals the target while the RUNNING process still has the old value. Every
 * later run would then read `noop` and never reconcile — a permanent, silent
 * wedge behind a green job, which is the exact failure this whole script
 * exists to prevent.
 *
 * The marker survives the process, so a later run can tell "already correct"
 * apart from "looks correct but was never deployed". It is cleared only once
 * stored config and the running process are known to agree.
 */
const PENDING_KEY = 'DB_DISK_GB_SYNC_PENDING'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Render ids live in a secret precisely so they stay out of the repo, and this
 *  job's output is a PUBLIC Actions log. GitHub masks the whole `DISK_SYNC_TARGETS`
 *  string, NOT the individual ids parsed out of it, so anything derived from
 *  them must be scrubbed before it is printed. */
export function redactIds(text) {
  // The optional `-a` tail matters: Render database ids are `dpg-<hash>-a`, so
  // without it the scrubbed output still ends in a dangling "-a".
  return String(text ?? '').replace(/\b(srv|dpg|dep)-[A-Za-z0-9]+(?:-a)?\b/g, '<$1-id>')
}

/**
 * Pure decision core — no I/O, so the interesting cases are unit-testable.
 *
 * FLOOR, not round: a smaller denominator makes the computed disk-% HIGHER, so
 * the safety trigger fires EARLIER. When in doubt about a safety threshold,
 * err toward firing early, never toward firing late.
 */
export function planDiskGbSync({ capacityBytes, currentGb }) {
  if (typeof capacityBytes !== 'number' || !Number.isFinite(capacityBytes) || capacityBytes <= 0) {
    return { action: 'refuse', reason: `capacity metric unusable (${capacityBytes})` }
  }
  const targetGb = Math.floor(capacityBytes / GIB)
  if (targetGb < 1 || targetGb > MAX_PLAUSIBLE_GB) {
    return { action: 'refuse', reason: `implausible capacity ${targetGb}GiB` }
  }
  if (typeof currentGb !== 'number' || !Number.isFinite(currentGb) || currentGb <= 0) {
    return { action: 'update', targetGb, reason: `DB_DISK_GB unset or unusable (${currentGb})` }
  }
  if (targetGb === currentGb) {
    return { action: 'noop', targetGb, reason: `already ${targetGb}GiB` }
  }
  return {
    action: 'update',
    targetGb,
    reason: `real capacity ${targetGb}GiB != DB_DISK_GB ${currentGb}GiB`,
  }
}

/**
 * `"srv-a:dpg-b, srv-c:dpg-d"` -> `[{serviceId,postgresId}]`.
 *
 * Requires EXACTLY two fields per entry. Destructuring alone would accept a
 * missing comma (`srv-a:dpg-b:srv-c:dpg-d`) as a single valid target and
 * silently drop the rest, finishing green with an indexer never synced.
 */
export function parseTargets(raw) {
  const out = []
  for (const part of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const fields = part.split(':').map((s) => s.trim())
    const [serviceId, postgresId] = fields
    if (
      fields.length !== 2 ||
      !serviceId?.startsWith('srv-') ||
      !postgresId?.startsWith('dpg-')
    ) {
      throw new Error(`malformed DISK_SYNC_TARGETS entry "${redactIds(part)}" (want srv-xxx:dpg-yyy)`)
    }
    out.push({ serviceId, postgresId })
  }
  if (out.length === 0) throw new Error('DISK_SYNC_TARGETS is empty')
  return out
}

/**
 * Classify a Render deploy status.
 *
 * `deactivated` counts as SUCCESS: it is what a deploy that went live becomes
 * once a newer one supersedes it. Seeing it while polling means our env value
 * is live — either via our deploy or the one that replaced it, since a later
 * deploy reads the same updated env.
 *
 * Unknown statuses are treated as FAILURE on purpose. A wrong "success" wedges
 * the job permanently; a wrong "failure" costs one extra deploy next run.
 */
export function classifyDeployStatus(status) {
  if (status === 'live' || status === 'deactivated') return 'success'
  if (
    status === 'created' ||
    status === 'queued' ||
    status === 'build_in_progress' ||
    status === 'update_in_progress' ||
    status === 'pre_deploy_in_progress'
  ) {
    return 'pending'
  }
  return 'failure'
}

/**
 * Extract the current denominator and confirm this service is actually WIRED to
 * the database we measured.
 *
 * A swapped or duplicated (but syntactically valid) target would otherwise read
 * one database's capacity and write it to an unrelated service. If the measured
 * database is the larger one, that INFLATES DB_DISK_GB and silently holds the
 * emergency trigger below its threshold — this job causing the very failure it
 * exists to prevent.
 *
 * Render embeds the database id in the connection host (minus the trailing
 * `-a`), and the var is chain-named (`DATABASE_URL` on BNB, `ETH_DATABASE_URL`
 * on ETH), so any *DATABASE_URL* key is scanned. Values are only ever tested
 * with `.includes` — never logged, since they carry credentials.
 */
export function readServiceEnv(vars, postgresId) {
  const host = String(postgresId ?? '').replace(/-a$/, '')
  let rawDiskGb = null // exact stored string, or null when the key is absent
  let pendingTarget = null
  let bound = false
  // An empty host would make `.includes('')` true for every URL, turning the
  // fail-closed check into a fail-open one.
  const usableHost = host.startsWith('dpg-')
  for (const item of Array.isArray(vars) ? vars : []) {
    const ev = item?.envVar ?? item
    if (!ev?.key) continue
    if (ev.key === 'DB_DISK_GB') rawDiskGb = String(ev.value ?? '')
    if (ev.key === PENDING_KEY) pendingTarget = String(ev.value ?? '')
    if (usableHost && ev.key.includes('DATABASE_URL') && String(ev.value ?? '').includes(host)) {
      bound = true
    }
  }
  // Mirror retention-cleanup.ts:31 EXACTLY — `parseInt(x ?? '0', 10)`, not
  // Number(). They disagree on real values: Number('150GB') is NaN, while the
  // indexer's parseInt reads 150. Using Number here would classify a present,
  // working denominator as "absent" and delete it during a rollback.
  const diskGb = rawDiskGb === null ? NaN : parseInt(rawDiskGb || '0', 10)
  return { diskGb, rawDiskGb, pendingTarget, bound }
}

/**
 * Only a background worker runs the retention loop that reads DB_DISK_GB.
 *
 * The database binding alone is NOT sufficient identity: render.yaml wires each
 * web service to the same DATABASE_URL as its indexer, so a web-service id in
 * DISK_SYNC_TARGETS would pass the binding check, get updated and deployed, and
 * leave the real indexer stale behind a green run.
 */
export function isSyncableService(service) {
  return (service?.type ?? service?.service?.type) === 'background_worker'
}

/**
 * Report TRUE volume utilisation, which the indexer structurally cannot.
 *
 * `diskPctNow()` divides `pg_database_size()` by the disk size, and
 * `pg_database_size()` counts database pages only — WAL, temp files and logs
 * share the volume and are invisible to it. Measured on BNB 2026-08-24 that
 * overhead was 4.10 GiB: real utilisation 88.5% against a reported 86.0%, so
 * the 93% destructive trigger actually fires at ~95.4% of the real volume.
 * `pg_ls_waldir()` is permission-denied for the app role and it is not in
 * `pg_monitor`, so this gap cannot be closed from inside SQL at all.
 *
 * WHY THIS IS A REPORT AND NOT A CORRECTION. The obvious fix — shrink
 * DB_DISK_GB by the overhead so the indexer's percentage matches reality — ties
 * a DATA-DESTROYING trigger to WAL volume, which spikes on writes and collapses
 * at checkpoints. A spike would shrink the denominator, inflate the reported
 * percentage and fire `runCleanup({compactDays:1})`, permanently deleting A1
 * compact history. That trades "fires ~2.4 points late" for "may fire early and
 * destroy data", which is the wrong direction for a last-resort trigger. So the
 * job reports the honest number and leaves the indexer's threshold alone.
 *
 * Only CRITICAL fails the run. A monitor pinned red gets ignored, and BNB
 * legitimately sits in the 85-90% band through its sawtooth.
 */
export function assessUtilisation({ usageBytes, capacityBytes, criticalPct }) {
  if (
    typeof usageBytes !== 'number' || !Number.isFinite(usageBytes) || usageBytes < 0 ||
    typeof capacityBytes !== 'number' || !Number.isFinite(capacityBytes) || capacityBytes <= 0
  ) {
    return { ok: false, critical: false, reason: 'usage/capacity metrics unusable' }
  }
  const pct = (usageBytes / capacityBytes) * 100
  return { ok: true, pct, critical: pct >= criticalPct }
}

/** Percent of the REAL volume at which this job starts failing. Defaults to the
 *  indexer's own action threshold so the two speak the same language, but
 *  measured honestly. */
/**
 * Whether the run should fail, kept pure so each reason is pinned.
 *
 * `blind` is the subtle one and the reason this is a function at all: an
 * unusable disk-usage metric used to emit only a warning, so the job exited 0
 * and summarised "0 at/over" while measuring nothing. A monitor that silently
 * stops measuring is worth as little as one pinned red — the disk could cross
 * the line for days with the workflow green.
 */
export function shouldFailRun({ failed = 0, critical = 0, blind = 0 } = {}) {
  return failed > 0 || critical > 0 || blind > 0
}

export function parseCriticalPct(raw, fallback = 93) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n) || n <= 0 || n > 100) return fallback
  return n
}

/**
 * What to do when a deploy fails, which differs sharply by how we got here.
 *
 * NORMAL UPDATE: we wrote a new value over a known previous one, so restoring
 * that previous value makes config match the running process again — and once
 * they agree the marker has nothing left to say.
 *
 * RECONCILE (a marker was already present): the stored value was ALREADY the
 * target when this run started, written by an earlier run that died before
 * deploying. `rawDiskGb` is therefore the target, not the running value, so a
 * "rollback" would rewrite the same number and change nothing — config and the
 * process still disagree. Clearing the marker there would make every later run
 * see a clean no-op and rebuild the exact wedge the marker exists to prevent.
 * So: no rollback, and the marker STAYS until a deploy actually succeeds.
 */
export function planFailureRecovery({ interrupted }) {
  return interrupted
    ? { rollback: false, clearMarker: false }
    : { rollback: true, clearMarker: true }
}

async function api(path, { method = 'GET', body, key, timeoutMs } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    // Only the ADVISORY call passes a deadline. The sync calls deliberately do
    // not: aborting a deploy poll mid-flight is how you get a config/process
    // disagreement, which is the failure this whole script guards against.
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  })
  const text = await res.text()
  if (!res.ok) {
    // Redact BOTH the path and the body: each carries the service/database id,
    // and the key itself is never interpolated into an error at all.
    throw new Error(
      `${method} ${redactIds(path.split('?')[0])} -> HTTP ${res.status}: ${redactIds(text).slice(0, 300)}`,
    )
  }
  return text && res.status !== 204 ? JSON.parse(text) : null
}

/** Newest sample of the disk-capacity series, in bytes.
 *  NOTE the filter param is `resource`, not `postgresId` — the latter 400s. */
async function newestMetric(metric, postgresId, key, timeoutMs) {
  const series = await api(`/metrics/${metric}?resource=${encodeURIComponent(postgresId)}`, {
    key,
    timeoutMs,
  })
  const values = Array.isArray(series) && series.length ? series[0].values : null
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`no ${metric} samples returned for this database`)
  }
  return values[values.length - 1].value
}

export const fetchCapacityBytes = (postgresId, key) =>
  newestMetric('disk-capacity', postgresId, key)

/** Render's disk-usage counts the WHOLE volume — WAL, temp files and logs
 *  included — which is the number the indexer structurally cannot see.
 *
 *  DEADLINED, unlike every other call here. This request is advisory, and an
 *  endpoint that accepts the connection then stalls would otherwise hang until
 *  the transport gives up — delaying or blocking the corrective sync it is
 *  explicitly meant never to block. A timeout simply counts as `blind`. */
export const USAGE_TIMEOUT_MS = 20_000
export const fetchUsageBytes = (postgresId, key) =>
  newestMetric('disk-usage', postgresId, key, USAGE_TIMEOUT_MS)

/** Poll a deploy until it is terminally successful or not. Returns a verdict
 *  string rather than throwing, so the caller can roll back uniformly. */
async function awaitDeploy(serviceId, deployId, key) {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS
  let last = 'unknown'
  while (Date.now() < deadline) {
    const dep = await api(`/services/${serviceId}/deploys/${deployId}`, { key })
    last = dep?.status ?? dep?.deploy?.status ?? 'unknown'
    const verdict = classifyDeployStatus(last)
    if (verdict !== 'pending') return { ok: verdict === 'success', status: last }
    await sleep(DEPLOY_POLL_MS)
  }
  return { ok: false, status: `${last} (timed out)` }
}

/** Put DB_DISK_GB back exactly as it was.
 *
 *  Keyed on PRESENCE (`rawDiskGb === null`), not on whether the value parsed:
 *  a present-but-noncanonical value like `150GB` is NaN to a strict parse yet
 *  still means 150 to the indexer, so deleting it would hand the next fresh
 *  deploy no denominator at all — and diskPctNow() returns 0 for that, which
 *  disables the emergency trigger outright. The raw string is restored
 *  verbatim so the running process's view is reproduced, not reinterpreted. */
async function restoreDiskGb(serviceId, rawDiskGb, key) {
  if (rawDiskGb !== null) {
    await api(`/services/${serviceId}/env-vars/DB_DISK_GB`, {
      method: 'PUT',
      body: { value: rawDiskGb },
      key,
    })
    return `restored DB_DISK_GB=${rawDiskGb}`
  }
  await api(`/services/${serviceId}/env-vars/DB_DISK_GB`, { method: 'DELETE', key })
  return 'removed DB_DISK_GB (it was absent before)'
}

/** Best-effort marker clear — never let a failure here mask the real outcome. */
async function clearPending(serviceId, key) {
  try {
    await api(`/services/${serviceId}/env-vars/${PENDING_KEY}`, { method: 'DELETE', key })
  } catch {
    /* the next run re-reconciles; a stuck marker only costs an extra deploy */
  }
}

async function main() {
  const key = process.env.RENDER_API_KEY
  if (!key) throw new Error('RENDER_API_KEY is not set')
  const dryRun = process.argv.includes('--dry-run')
  const targets = parseTargets(process.env.DISK_SYNC_TARGETS)

  const criticalPct = parseCriticalPct(process.env.DISK_ALERT_PCT)

  let changed = 0
  let failed = 0
  let critical = 0
  let blind = 0
  for (const [i, { serviceId, postgresId }] of targets.entries()) {
    let label = `target ${i + 1}/${targets.length}`
    try {
      const service = await api(`/services/${serviceId}`, { key })
      const name = service?.name ?? service?.service?.name ?? 'unnamed service'
      label = `target ${i + 1}/${targets.length} (${name})`

      if (!isSyncableService(service)) {
        failed++
        console.error(`REFUSE ${label}: not a background worker — only the indexer reads DB_DISK_GB`)
        continue
      }

      const capacityBytes = await fetchCapacityBytes(postgresId, key)

      // Reported EVERY run, before and independently of any sync decision —
      // this is the only honest disk figure in the system, and it stays useful
      // on the no-op runs that make up almost all of them.
      //
      // ISOLATED IN ITS OWN try/catch ON PURPOSE. Reporting is a strictly
      // ADVISORY concern and must never be able to block the corrective one: a
      // transient disk-usage metric failure sharing the outer catch would
      // `continue` past the sync, so a monitoring blip could stop DB_DISK_GB
      // being fixed — the opposite of what this job is for.
      let usage = { ok: false, reason: 'not measured' }
      try {
        usage = assessUtilisation({
          usageBytes: await fetchUsageBytes(postgresId, key),
          capacityBytes,
          criticalPct,
        })
      } catch (metricErr) {
        usage = {
          ok: false,
          reason: redactIds(metricErr instanceof Error ? metricErr.message : metricErr),
        }
      }
      if (!usage.ok) {
        // BLIND, not merely quiet. A monitor that silently stops measuring is
        // worth nothing: without this counter an unusable metric would leave
        // the run green and the summary reading "0 at/over", so the disk could
        // cross the line for days with nobody looking. Counted separately from
        // `failed` because the sync itself is fine — the summary says which.
        blind++
        console.error(`WARN   ${label}: ${usage.reason} — real utilisation unknown this run`)
      } else {
        console.log(
          `disk   ${label}: ${usage.pct.toFixed(1)}% of the real volume` +
            (usage.critical ? `  ⚠ AT OR OVER ${criticalPct}%` : ''),
        )
        if (usage.critical) critical++
      }

      const vars = await api(`/services/${serviceId}/env-vars?limit=100`, { key })
      const { diskGb: currentGb, rawDiskGb, pendingTarget, bound } = readServiceEnv(vars, postgresId)

      if (!bound) {
        failed++
        console.error(`REFUSE ${label}: no *DATABASE_URL* on this service points at the measured database`)
        continue
      }

      const plan = planDiskGbSync({ capacityBytes, currentGb })
      if (plan.action === 'refuse') {
        failed++
        console.error(`REFUSE ${label}: ${plan.reason}`)
        continue
      }
      // A marker means an earlier run was interrupted between writing the env
      // and finishing a deploy, so "stored already matches" proves nothing about
      // the RUNNING process. Deploy anyway to make them agree.
      const interrupted = pendingTarget !== null
      if (plan.action === 'noop' && !interrupted) {
        console.log(`ok     ${label}: ${plan.reason}`)
        continue
      }

      console.log(
        interrupted && plan.action === 'noop'
          ? `RECONCILE ${label}: config says ${plan.targetGb}GiB but an interrupted run left it undeployed`
          : `UPDATE ${label}: ${plan.reason} -> DB_DISK_GB=${plan.targetGb}`,
      )
      if (dryRun) {
        console.log('       (--dry-run, no write)')
        continue
      }

      // Marker FIRST: if the process dies after this point, the next run can
      // still tell that a deploy is owed.
      await api(`/services/${serviceId}/env-vars/${PENDING_KEY}`, {
        method: 'PUT',
        body: { value: String(plan.targetGb) },
        key,
      })
      await api(`/services/${serviceId}/env-vars/DB_DISK_GB`, {
        method: 'PUT',
        body: { value: String(plan.targetGb) },
        key,
      })

      // An env write alone does NOT take effect: Render's /restart reuses the
      // previous deploy's env snapshot, so only a fresh deploy picks it up. And
      // POST /deploys merely QUEUES one — a build can still fail afterwards, so
      // the write may not stand until the deploy is observed terminal.
      let verdict
      try {
        const dep = await api(`/services/${serviceId}/deploys`, {
          method: 'POST',
          body: { clearCache: 'do_not_clear' },
          key,
        })
        const deployId = dep?.id ?? dep?.deploy?.id
        verdict = deployId
          ? await awaitDeploy(serviceId, deployId, key)
          : { ok: false, status: 'no deploy id returned' }
      } catch (deployErr) {
        verdict = { ok: false, status: redactIds(deployErr instanceof Error ? deployErr.message : deployErr) }
      }

      if (verdict.ok) {
        // Config and process now agree, so the marker has nothing left to say.
        await clearPending(serviceId, key)
        changed++
        console.log(`       deployed and live`)
        continue
      }

      // NOT fixed on purpose: if the deploy was accepted but polling timed out,
      // it may still land with targetGb after this rollback writes currentGb
      // back, leaving config and process briefly disagreeing the other way.
      // Cancelling an in-flight deploy to close that window would trade a
      // self-correcting state for a riskier one — the next run simply sees the
      // mismatch again and redeploys, costing one extra deploy. A permanent
      // wedge is the failure worth engineering against here; a transient
      // disagreement that converges on its own is not.
      failed++
      const recovery = planFailureRecovery({ interrupted })

      if (!recovery.rollback) {
        // Reconcile path: stored config was already the target, so there is
        // nothing to restore — only a deploy can close the gap. Keep the marker.
        console.error(
          `ERROR  ${label}: reconciliation deploy did not succeed (${verdict.status}) — ` +
            `${PENDING_KEY} left set so the next run retries`,
        )
        continue
      }

      console.error(`ERROR  ${label}: deploy did not succeed (${verdict.status}) — rolling back`)
      try {
        console.error(`       ${await restoreDiskGb(serviceId, rawDiskGb, key)} — next run will retry`)
        // Config now matches the running process again, so the marker is done.
        // It is deliberately LEFT in place when the rollback throws below: that
        // is the one remaining state where the two still disagree.
        if (recovery.clearMarker) await clearPending(serviceId, key)
      } catch (rollbackErr) {
        console.error(
          `       ⚠ ROLLBACK FAILED — DB_DISK_GB is ${plan.targetGb} in config but the running ` +
            `process still has ${rawDiskGb === null ? 'no value' : rawDiskGb}. ` +
            `${PENDING_KEY} is left set so the next run redeploys; deploy by hand to fix it sooner. ` +
            `${redactIds(rollbackErr instanceof Error ? rollbackErr.message : rollbackErr)}`,
        )
      }
    } catch (err) {
      failed++
      console.error(`ERROR  ${label}: ${redactIds(err instanceof Error ? err.message : err)}`)
    }
  }

  console.log(
    `\n${targets.length} target(s), ${changed} updated, ${failed} failed, ` +
      `${critical} at/over ${criticalPct}% real disk, ${blind} unmeasured`,
  )
  // All three fail the run, and the summary above says which — a sync that
  // could not complete, a volume genuinely close to full, and a monitor that
  // could not measure are different problems needing different responses. The
  // last one matters most for being easy to miss: staying green on an
  // unmeasured disk is how a monitor goes blind for days unnoticed.
  if (shouldFailRun({ failed, critical, blind })) process.exitCode = 1
}

// Only run when executed directly, so the test can import the pure helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(redactIds(err instanceof Error ? err.message : err))
    process.exitCode = 1
  })
}
