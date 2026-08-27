/**
 * Every environment variable the indexer reads, in one typed place.
 *
 * There were 66 of them across nine files, 51 documented nowhere, in four
 * different parsing styles — `parseInt(x ?? 'D', 10)`, `positiveIntEnv`,
 * backfill's local `int`/`float`, and retention's `parsePercentEnv` — and two
 * variables were read by two files with two different parsers each. Nothing
 * printed what any of it resolved to, which is how a metered feature ran live
 * for nine days while the code and the docs both said it was dark.
 *
 * Three rules hold here:
 *
 *   1. A variable is declared ONCE. `PARTITION_BLOCKS` and `PARTITION_AHEAD`
 *      were computed independently in ensure-schema.ts and
 *      migrate-partition-tt.ts; two copies of a partition width is a corruption
 *      bug waiting for one of them to be edited.
 *   2. Parsing is pure and takes `env` as an argument, so tests exercise the
 *      SAME function the process boots with rather than a re-implementation.
 *   3. Every resolution is recorded, so `formatResolvedConfig()` can print what
 *      the process is ACTUALLY running with. Read the boot log, not the source.
 */

/**
 * Defaults that used to live in gap-healer.ts and poison-block.ts.
 *
 * They moved HERE, and those modules re-export them, rather than this module
 * importing them — because config-instance.ts is imported by nearly everything,
 * so anything it imports becomes a cycle risk. Importing gap-healer from it
 * crashed the process at boot with "Cannot access 'config_instance_1' before
 * initialization", which typecheck and 858 tests both passed. config.ts now
 * imports nothing at all, which makes that class of failure unreachable.
 */
export const DEFAULT_HEAL_BATCH = 25
export const DEFAULT_HEAL_MAX_LAG = 50
export const DEFAULT_QUARANTINE_AFTER = 5

/** What one variable resolved to, and why. Drives the boot log. */
export type Resolution = {
  name: string
  /** Rendered value — never the raw secret for URL-ish vars. */
  value: string
  source: 'env' | 'default'
  /** Present when a value WAS supplied and was rejected as invalid. */
  ignored?: string
}

/**
 * Records how each variable resolved as it is read.
 *
 * The log is generated from what the parsers actually did rather than from a
 * second hand-maintained list, because a list beside the code is a list that
 * drifts from it.
 */
class EnvReader {
  readonly resolutions: Resolution[] = []

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  private record(name: string, value: string, raw: string | undefined, valid: boolean): void {
    const supplied = raw !== undefined && raw.trim() !== ''
    this.resolutions.push({
      name,
      value,
      source: supplied && valid ? 'env' : 'default',
      ...(supplied && !valid ? { ignored: raw } : {}),
    })
  }

  /**
   * Non-negative integer, falling back on anything unparseable.
   *
   * Two DELIBERATE behaviour changes from the `parseInt(x ?? 'D', 10)` sites
   * this replaces:
   *
   *   - they returned NaN for an empty or malformed value, and NaN propagates
   *     silently — `x <= NaN` is always false, the stall codex caught in the
   *     transfer-queue bound before #47 shipped;
   *   - they accepted a prefix, so '5x' read as 5 and '93.9' as 93. A typo that
   *     silently shrinks a threshold is worse than one that is rejected.
   *
   * Both now fall back to the documented default AND say so in the boot log, so
   * a typo surfaces as an ignored value rather than as a dead comparison or a
   * quietly lowered bound.
   */
  int(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
    const raw = this.env[name]
    const min = opts.min ?? 0
    // Whole value or nothing — deliberately NOT parseInt, which reads '5x' as 5
    // and '93.9' as 93. DB_DISK_GB is the denominator of the destructive disk
    // trigger, so a typo that silently shrinks it is the failure to design out.
    const trimmed = (raw ?? '').trim()
    const n = /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
    const ok = Number.isFinite(n) && n >= min && (opts.max === undefined || n <= opts.max)
    const value = ok ? n : fallback
    this.record(name, String(value), raw, ok)
    return value
  }

  /** Ratio in (0, 1]. Mirrors backfill-budget's `float`. */
  ratio(name: string, fallback: number): number {
    const raw = this.env[name]
    const n = Number.parseFloat(raw ?? '')
    const ok = Number.isFinite(n) && n > 0 && n <= 1
    const value = ok ? n : fallback
    this.record(name, String(value), raw, ok)
    return value
  }

  /**
   * Flag that is ON unless explicitly set to '0'.
   *
   * The name states the polarity because getting it backwards silently disables
   * a safety check — `REORG_CHECK` and the poison-block quarantine both use it.
   */
  enabledUnlessZero(name: string): boolean {
    const raw = this.env[name]
    const value = raw !== '0'
    this.record(name, String(value), raw, true)
    return value
  }

  /**
   * Flag that is OFF unless explicitly set to '1'.
   *
   * ⛔ `GAP_HEAL_ENABLED` uses this and must keep using exactly this. Off is not
   * a default to be relaxed — see the comment at index.ts's healer block: the
   * completion marker cannot distinguish a healed range from one stamped healed
   * with transfers, DEX trades and webhooks missing. Widening the accepted set
   * to 'true'/'yes' would make it enablable by accident.
   */
  enabledOnlyWhenOne(name: string): boolean {
    const raw = this.env[name]
    const value = raw === '1'
    this.record(name, String(value), raw, true)
    return value
  }

  /** Tri-state flag: '1'/'true' on, '0'/'false' off, anything else the default. */
  tristate(name: string, fallback: boolean): boolean {
    const raw = this.env[name]
    if (raw === '1' || raw === 'true') { this.record(name, 'true', raw, true); return true }
    if (raw === '0' || raw === 'false') { this.record(name, 'false', raw, true); return false }
    this.record(name, String(fallback), raw, raw === undefined || raw.trim() === '')
    return fallback
  }

  string(name: string, fallback: string, opts: { secret?: boolean } = {}): string {
    const raw = this.env[name]
    const ok = raw !== undefined && raw.trim() !== ''
    const value = ok ? raw : fallback
    this.record(name, opts.secret ? redact(value) : value, raw, true)
    return value
  }

  /**
   * Whole percent, 1-100, falling back with a warning on anything else.
   *
   * Moved from retention-cleanup.ts UNCHANGED, including the warnings, and now
   * under test for the first time.
   *
   * Deliberately NOT parseInt: `parseInt('93.9')` is 93 and `parseInt('8x')` is
   * 8, so a typo would silently LOWER a safety threshold instead of being
   * rejected — and an 8 here would clamp up to the alarm line and restore
   * destructive cleanup at the normal ~86% sawtooth peak. Equally, a value above
   * 100 is rejected rather than clamped, so `EMERGENCY_DISK_ACT_PCT=999` cannot
   * be used to mean "never fire". Whole value or nothing.
   */
  percent(name: string, fallback: number): number {
    const raw = this.env[name]
    if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) {
      if (raw !== undefined) {
        console.warn(`[retention] ignoring malformed disk-threshold value "${raw}" — using ${fallback}%`)
      }
      this.record(name, String(fallback), raw, false)
      return fallback
    }
    const n = Number(raw.trim())
    if (!Number.isInteger(n) || n <= 0 || n > 100) {
      console.warn(`[retention] disk-threshold ${n} out of range (1-100) — using ${fallback}%`)
      this.record(name, String(fallback), raw, false)
      return fallback
    }
    this.record(name, String(n), raw, true)
    return n
  }
}

/** Connection strings carry credentials; the boot log prints host/database only. */
export function redact(value: string): string {
  if (!value) return ''
  try {
    const u = new URL(value)
    return `${u.protocol}//***@${u.host}${u.pathname}`
  } catch {
    return value.includes('://') ? '***' : value
  }
}

export type IndexerConfig = ReturnType<typeof readIndexerConfig>['config']

/**
 * Defaults this module cannot derive on its own.
 *
 * Only the two that genuinely come from elsewhere: chain-config's start block
 * and the chain-dependent worker count. Everything else is declared above, so
 * this module imports nothing.
 */
export type ConfigDefaults = {
  /** chain-config's `defaultStartBlock`. */
  startBlock: number
  /** BNB produces a block every 3s and needs more workers than ETH at 12s. */
  concurrency: number
}

/** @param env process.env, or a fixture. Pure with respect to it. */
export function readIndexerConfig(
  env: NodeJS.ProcessEnv,
  defaults: ConfigDefaults,
) {
  const r = new EnvReader(env)

  const indexing = {
    /** Blocks fetched per batch. */
    batchSize: r.int('INDEX_BATCH_SIZE', 40, { min: 1 }),
    concurrency: r.int('INDEX_CONCURRENCY', defaults.concurrency, { min: 1 }),
    logEvery: r.int('LOG_EVERY', 50, { min: 1 }),
    resumeGapScanBlocks: r.int('RESUME_GAP_SCAN_BLOCKS', 20_000, { min: 0 }),
    /** Non-zero forces a start height, ignoring the stored cursor. */
    forceStartBlock: r.int('FORCE_START_BLOCK', 0, { min: 0 }),
    startBlock: r.int('START_BLOCK', defaults.startBlock, { min: 0 }),
    /** Beyond this lag the indexer abandons the gap and jumps to the tip. */
    maxLagBlocks: r.int('MAX_LAG_BLOCKS', 1000, { min: 1 }),
    /** Per-block phase breakdown every N blocks; 0 disables. */
    profileBlocks: r.int('PROFILE_BLOCKS', 0, { min: 0 }),
  }

  const rpc = {
    readTimeoutMs: r.int('RPC_READ_TIMEOUT_MS', 10_000, { min: 1 }),
    /** Ceiling on pure RPC acquisition per block. */
    fetchTimeoutMs: r.int('RPC_FETCH_TIMEOUT_MS', 8_000, { min: 1 }),
    /**
     * Outer bound on a reorg check.
     *
     * Read in two places before this, with two parsers: index.ts used
     * `parseInt(x ?? '45000')` (NaN on garbage) and reorg-handler.ts used
     * `positiveIntEnv` (default on garbage). One variable cannot have two
     * meanings; it now has the safe one.
     */
    reorgTimeoutMs: r.int('RPC_REORG_TIMEOUT_MS', 45_000, { min: 1 }),
    storedHashTimeoutMs: r.int('STORED_HASH_TIMEOUT_MS', 10_000, { min: 1 }),
  }

  const reorg = {
    /** ON unless explicitly '0'. */
    checkEnabled: r.enabledUnlessZero('REORG_CHECK'),
    idleCheckMs: r.int('IDLE_REORG_CHECK_MS', 30_000, { min: 1 }),
    quarantineEnabled: r.enabledUnlessZero('POISON_BLOCK_QUARANTINE'),
    quarantineAfter: r.int('POISON_BLOCK_QUARANTINE_AFTER', DEFAULT_QUARANTINE_AFTER, { min: 1 }),
  }

  const gapHeal = {
    /**
     * ⛔ OFF by design. See the long comment at apps/indexer/src/index.ts:285 —
     * with the current completion marker a range can be stamped healed while its
     * transfers, DEX trades and webhooks are missing, which is "strictly worse
     * than having no healer". It also heals at ~1.7 blocks/min.
     */
    enabled: r.enabledOnlyWhenOne('GAP_HEAL_ENABLED'),
    intervalMs: r.int('GAP_HEAL_INTERVAL_MS', 30_000, { min: 1 }),
    batch: r.int('GAP_HEAL_BATCH', DEFAULT_HEAL_BATCH, { min: 1 }),
    maxLag: r.int('GAP_HEAL_MAX_LAG', DEFAULT_HEAL_MAX_LAG, { min: 1 }),
    flushTimeoutMs: r.int('GAP_HEAL_FLUSH_TIMEOUT_MS', 60_000, { min: 1 }),
  }

  const transferWriter = {
    /** Default ON for BNB (0.45s blocks need it), OFF for ETH. */
    async: r.tristate('ASYNC_TT_WRITER', (env.CHAIN ?? 'bnb') === 'bnb'),
    /**
     * Backpressure bound on pending rows. Must never be NaN: the dual-bound
     * loops break on `rows <= bound` and `x <= NaN` is always false, so a NaN
     * bound throttles forever even on an empty queue (codex P2, pre-#47).
     */
    queueHighWaterRows: r.int('TT_QUEUE_HIGH_WATER_ROWS', 50_000, { min: 1 }),
    /**
     * Parallel bound on pending BLOCK COUNT. The rows bound never engages for a
     * transfer-less range with a stalled writer — rows stays ~0 while the
     * pending Map grows unbounded.
     */
    queueHighWaterBlocks: r.int('TT_QUEUE_HIGH_WATER_BLOCKS', 2_000, { min: 1 }),
    /** Raw alert threshold; floored at the backpressure bound below. */
    queueAlertRowsRaw: r.int('TT_QUEUE_ALERT_ROWS', 0, { min: 1 }),
    failureAlertThreshold: r.int('TT_WRITER_FAILURE_ALERT_THRESHOLD', 5, { min: 1 }),
    profile: r.enabledOnlyWhenOne('TT_WRITER_PROFILE'),
    profileWindowMs: r.int('TT_PROFILE_WINDOW_MS', 30_000, { min: 1 }),
    dedicatedPool: r.enabledOnlyWhenOne('TT_WRITER_DEDICATED_POOL'),
    poolSize: r.int('TT_WRITER_POOL_SIZE', 2, { min: 1 }),
  }

  const holders = {
    queueWarnDepth: r.int('HOLDER_QUEUE_WARN_DEPTH', 500, { min: 1 }),
    countIntervalMin: r.int('HOLDER_COUNT_INTERVAL_MIN', 15, { min: 1 }),
    countLagThreshold: r.int('HOLDER_COUNT_LAG_THRESHOLD', 1000, { min: 0 }),
    recomputeChunk: r.int('HOLDER_RECOMPUTE_CHUNK', 2000, { min: 1 }),
    recomputeSleepMs: r.int('HOLDER_RECOMPUTE_SLEEP_MS', 100, { min: 0 }),
  }

  const retention = {
    days: r.int('RETENTION_DAYS', 7, { min: 1 }),
    deleteBatch: r.int('RETENTION_DELETE_BATCH', 50_000, { min: 1 }),
    batchSleepMs: r.int('RETENTION_BATCH_SLEEP_MS', 250, { min: 0 }),
    /** Lag above which retention pauses between batches. 0 disables. */
    lagThreshold: r.int('RETENTION_LAG_THRESHOLD', 500, { min: 0 }),
    /** HARD safety valve — past this budget the prune proceeds regardless of lag. */
    maxYieldMin: r.int('RETENTION_MAX_YIELD_MIN', 30, { min: 0 }),
    /** 0 means unknown: size is still reported, percentage is not. */
    dbDiskGb: r.int('DB_DISK_GB', 0, { min: 0 }),
    /** Warns only. An alarm line is NOT the emergency path firing. */
    emergencyDiskAlarmPct: r.percent('EMERGENCY_DISK_ALARM_PCT', 85),
    /** The DESTRUCTIVE path. Floored at the alarm value below. */
    emergencyDiskActPctRaw: r.percent('EMERGENCY_DISK_ACT_PCT', 93),
    vacuumFull: r.enabledOnlyWhenOne('VACUUM_FULL'),
  }

  const partitions = {
    /**
     * Single source of truth. ensure-schema.ts and migrate-partition-tt.ts each
     * computed this independently from the same env var; two partition widths
     * that can drift apart is a data-placement bug, not a style problem.
     */
    blocks: Math.max(1, r.int('PARTITION_BLOCKS', 192_000, { min: 1 })),
    ahead: Math.max(1, r.int('PARTITION_AHEAD', 7, { min: 1 })),
    confirmMigration: r.enabledOnlyWhenOne('CONFIRM_PARTITION_MIGRATION'),
  }

  const backfill = {
    pollMs: r.int('BACKFILL_POLL_MS', 15_000, { min: 1 }),
    pageSleepMs: r.int('BACKFILL_PAGE_SLEEP_MS', 2_000, { min: 1 }),
    maxRowsPerEntity: r.int('BACKFILL_MAX_ROWS_PER_ENTITY', 3_000, { min: 1 }),
    maxPagesPerHour: r.int('BACKFILL_MAX_PAGES_PER_HOUR', 300, { min: 1 }),
    budgetHeadroom: r.ratio('BACKFILL_BUDGET_HEADROOM', 0.4),
    leaseSec: r.int('BACKFILL_LEASE_SEC', 300, { min: 1 }),
    maxTotalGb: r.int('BACKFILL_MAX_TOTAL_GB', 5, { min: 1 }),
    /** Deliberately below the 85% emergency alarm. */
    diskStopPct: r.int('BACKFILL_DISK_STOP_PCT', 70, { min: 1 }),
  }

  const verifier = {
    sourcifyApi: r.string('SOURCIFY_API', 'https://sourcify.dev/server'),
  }

  const runtime = {
    /** Identifies the healer's lease owner; 'local' outside Render. */
    instanceId: r.string('RENDER_INSTANCE_ID', 'local'),
    nodeEnv: r.string('NODE_ENV', 'development'),
  }

  const config = {
    indexing, rpc, reorg, gapHeal, transferWriter, holders,
    retention, partitions, backfill, verifier, runtime,

    /**
     * Per-block holder-balance tracking.
     *
     * Hardcoded off, and NOT env-tunable — it lives here rather than in
     * block-processor.ts so retention-cleanup.ts can read it without importing
     * a 1,833-line module (and executing its module side effects, including a
     * console.warn) for one boolean.
     *
     * While OFF, token_balances receives no per-block writes, so the periodic
     * holder_count recompute has no new input and is skipped — it would
     * otherwise full-scan a frozen token_balances for minutes and stall block
     * ingestion via disk-I/O contention while updating zero rows.
     */
    holderBalanceTrackingEnabled: false,

    /**
     * Floored AT the backpressure bound, so a misconfigured override can never
     * make the alert noisier than PR #43 was. Default is 2x the bound.
     */
    get ttQueueAlertRows(): number {
      return Math.max(
        transferWriter.queueHighWaterRows,
        transferWriter.queueAlertRowsRaw > 0
          ? transferWriter.queueAlertRowsRaw
          : transferWriter.queueHighWaterRows * 2,
      )
    },

    /**
     * Clamped UP to the alarm value. Acting below the alarm line would make the
     * alarm band unreachable and restore the hair-trigger.
     */
    get emergencyDiskActPct(): number {
      return Math.max(retention.emergencyDiskActPctRaw, retention.emergencyDiskAlarmPct)
    },
  }

  return { config, resolutions: r.resolutions }
}

/**
 * One line per variable, for the boot log.
 *
 * This exists because "read the deployed env var or grep the boot log" is the
 * only reliable way to know what a service is running: a config literal in the
 * repo proves nothing when env overrides it per Render service.
 */
export function formatResolvedConfig(resolutions: readonly Resolution[]): string[] {
  const overridden = resolutions.filter(x => x.source === 'env')
  const ignored = resolutions.filter(x => x.ignored !== undefined)
  const lines = [
    `[config] ${resolutions.length} variables resolved, ${overridden.length} from env`,
    ...overridden.map(x => `[config]   ${x.name}=${x.value}`),
  ]
  for (const x of ignored) {
    lines.push(`[config]   ⚠ ${x.name}: ignored invalid ${JSON.stringify(x.ignored)}, using ${x.value}`)
  }
  return lines
}
