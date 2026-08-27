import { describe, expect, it, vi, afterEach } from 'vitest'
import { readIndexerConfig, formatResolvedConfig, redact, type ConfigDefaults } from './config'

const DEFAULTS: ConfigDefaults = {
  startBlock: 38_000_000,
  concurrency: 8,
}

const read = (env: NodeJS.ProcessEnv = {}) => readIndexerConfig(env, DEFAULTS)

afterEach(() => { vi.restoreAllMocks() })

describe('defaults match the values they replaced', () => {
  // Transcribed from the call sites this module absorbed. Four of these were
  // wrong on the first pass — GAP_HEAL_BATCH is 25, not 500 — and nothing but a
  // table like this catches that, because a wrong default still typechecks and
  // still boots.
  const { config } = read()
  it.each([
    ['indexing.batchSize', config.indexing.batchSize, 40],
    ['indexing.logEvery', config.indexing.logEvery, 50],
    ['indexing.resumeGapScanBlocks', config.indexing.resumeGapScanBlocks, 20_000],
    ['indexing.maxLagBlocks', config.indexing.maxLagBlocks, 1000],
    ['indexing.profileBlocks', config.indexing.profileBlocks, 0],
    ['rpc.readTimeoutMs', config.rpc.readTimeoutMs, 10_000],
    ['rpc.fetchTimeoutMs', config.rpc.fetchTimeoutMs, 8_000],
    ['rpc.reorgTimeoutMs', config.rpc.reorgTimeoutMs, 45_000],
    ['rpc.storedHashTimeoutMs', config.rpc.storedHashTimeoutMs, 10_000],
    ['reorg.idleCheckMs', config.reorg.idleCheckMs, 30_000],
    ['reorg.quarantineAfter', config.reorg.quarantineAfter, 5],
    ['gapHeal.batch', config.gapHeal.batch, 25],
    ['gapHeal.maxLag', config.gapHeal.maxLag, 50],
    ['gapHeal.intervalMs', config.gapHeal.intervalMs, 30_000],
    ['gapHeal.flushTimeoutMs', config.gapHeal.flushTimeoutMs, 60_000],
    ['transferWriter.queueHighWaterRows', config.transferWriter.queueHighWaterRows, 50_000],
    ['transferWriter.queueHighWaterBlocks', config.transferWriter.queueHighWaterBlocks, 2_000],
    ['transferWriter.failureAlertThreshold', config.transferWriter.failureAlertThreshold, 5],
    ['transferWriter.profileWindowMs', config.transferWriter.profileWindowMs, 30_000],
    ['transferWriter.poolSize', config.transferWriter.poolSize, 2],
    ['holders.queueWarnDepth', config.holders.queueWarnDepth, 500],
    ['holders.countIntervalMin', config.holders.countIntervalMin, 15],
    ['holders.countLagThreshold', config.holders.countLagThreshold, 1000],
    ['holders.recomputeChunk', config.holders.recomputeChunk, 2000],
    ['holders.recomputeSleepMs', config.holders.recomputeSleepMs, 100],
    ['retention.days', config.retention.days, 7],
    ['retention.deleteBatch', config.retention.deleteBatch, 50_000],
    ['retention.batchSleepMs', config.retention.batchSleepMs, 250],
    ['retention.lagThreshold', config.retention.lagThreshold, 500],
    ['retention.maxYieldMin', config.retention.maxYieldMin, 30],
    ['retention.dbDiskGb', config.retention.dbDiskGb, 0],
    ['partitions.blocks', config.partitions.blocks, 192_000],
    ['partitions.ahead', config.partitions.ahead, 7],
    ['backfill.pollMs', config.backfill.pollMs, 15_000],
    ['backfill.pageSleepMs', config.backfill.pageSleepMs, 2_000],
    ['backfill.maxRowsPerEntity', config.backfill.maxRowsPerEntity, 3_000],
    ['backfill.maxPagesPerHour', config.backfill.maxPagesPerHour, 300],
    ['backfill.budgetHeadroom', config.backfill.budgetHeadroom, 0.4],
    ['backfill.leaseSec', config.backfill.leaseSec, 300],
    ['backfill.maxTotalGb', config.backfill.maxTotalGb, 5],
    ['backfill.diskStopPct', config.backfill.diskStopPct, 70],
  ])('%s', (_name, actual, expected) => expect(actual).toBe(expected))

  it('takes the chain-dependent defaults from the caller', () => {
    // INDEX_CONCURRENCY defaulted to 8 on BNB and 4 on ETH. Hardcoding either
    // here would silently halve or double ETH's worker count.
    expect(readIndexerConfig({}, { ...DEFAULTS, concurrency: 4 }).config.indexing.concurrency).toBe(4)
    expect(read().config.indexing.startBlock).toBe(38_000_000)
  })
})

describe('EMERGENCY_DISK_* — the destructive trigger', () => {
  // This parser had no test at all, despite being the only thing standing
  // between a typo and COMPACT_RETENTION_DAYS being dropped to the floor.
  it.each([
    ['93.9', 'parseInt would read 93 and silently lower the threshold'],
    ['8x', 'parseInt would read 8, which clamps to the alarm line'],
    ['0', 'out of range'],
    ['101', 'above 100'],
    ['-1', 'negative'],
    ['', 'empty'],
    ['ninety', 'not a number'],
    ['9e1', 'exponent notation'],
  ])('rejects %j (%s) and keeps the default', (raw) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(read({ EMERGENCY_DISK_ACT_PCT: raw }).config.retention.emergencyDiskActPctRaw).toBe(93)
  })

  it.each([['85', 85], [' 90 ', 90], ['100', 100], ['1', 1]])(
    'accepts %j', (raw, expected) => {
      expect(read({ EMERGENCY_DISK_ALARM_PCT: raw }).config.retention.emergencyDiskAlarmPct).toBe(expected)
    })

  it('cannot be disarmed by a value above 100', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Rejected, not clamped — 999 must not become "never fires".
    expect(read({ EMERGENCY_DISK_ACT_PCT: '999' }).config.emergencyDiskActPct).toBe(93)
  })

  it('clamps ACT up to ALARM so the alarm band stays reachable', () => {
    // Acting below the alarm line restores the hair-trigger that destroyed
    // compact history on 2026-08-22.
    const { config } = read({ EMERGENCY_DISK_ACT_PCT: '70', EMERGENCY_DISK_ALARM_PCT: '85' })
    expect(config.emergencyDiskActPct).toBe(85)
  })

  it('leaves ACT alone when it is already above ALARM', () => {
    expect(read({ EMERGENCY_DISK_ACT_PCT: '95', EMERGENCY_DISK_ALARM_PCT: '85' })
      .config.emergencyDiskActPct).toBe(95)
  })
})

describe('flag polarity', () => {
  it('REORG_CHECK and the quarantine are ON unless exactly "0"', () => {
    expect(read({}).config.reorg.checkEnabled).toBe(true)
    expect(read({ REORG_CHECK: '0' }).config.reorg.checkEnabled).toBe(false)
    expect(read({ REORG_CHECK: 'false' }).config.reorg.checkEnabled).toBe(true)
    expect(read({ POISON_BLOCK_QUARANTINE: '0' }).config.reorg.quarantineEnabled).toBe(false)
  })

  it.each(['true', 'yes', 'on', 'TRUE', ' 1', '1 ', '2'])(
    'GAP_HEAL_ENABLED stays OFF for %j', (raw) => {
      // ⛔ Off by design — index.ts:285 calls enabling it "strictly worse than
      // having no healer". Only the exact string '1' may turn it on, so it
      // cannot be enabled by a plausible-looking value.
      expect(read({ GAP_HEAL_ENABLED: raw }).config.gapHeal.enabled).toBe(false)
    })

  it('GAP_HEAL_ENABLED turns on only for exactly "1"', () => {
    expect(read({ GAP_HEAL_ENABLED: '1' }).config.gapHeal.enabled).toBe(true)
  })

  it('ASYNC_TT_WRITER defaults per chain and accepts an explicit override', () => {
    expect(read({ CHAIN: 'bnb' }).config.transferWriter.async).toBe(true)
    expect(read({ CHAIN: 'eth' }).config.transferWriter.async).toBe(false)
    expect(read({ CHAIN: 'eth', ASYNC_TT_WRITER: '1' }).config.transferWriter.async).toBe(true)
    expect(read({ CHAIN: 'bnb', ASYNC_TT_WRITER: 'false' }).config.transferWriter.async).toBe(false)
  })
})

describe('integer parsing falls back instead of yielding NaN', () => {
  it.each(['', '   ', 'forty', '4x', 'NaN'])(
    'ignores %j and uses the default', (raw) => {
      // The sites this replaced returned NaN here, and `x <= NaN` is always
      // false — the transfer-queue bound that stalled forever before #47.
      const { config } = read({ INDEX_BATCH_SIZE: raw })
      expect(Number.isFinite(config.indexing.batchSize)).toBe(true)
      expect(config.indexing.batchSize).toBe(40)
    })

  it('accepts a valid override', () => {
    expect(read({ INDEX_BATCH_SIZE: '120' }).config.indexing.batchSize).toBe(120)
  })

  it('rejects a value below the declared minimum', () => {
    expect(read({ INDEX_BATCH_SIZE: '0' }).config.indexing.batchSize).toBe(40)
    expect(read({ INDEX_CONCURRENCY: '-3' }).config.indexing.concurrency).toBe(8)
  })

  it('allows zero where zero is meaningful', () => {
    // 0 disables retention's yield and the block profiler; it is not garbage.
    expect(read({ RETENTION_LAG_THRESHOLD: '0' }).config.retention.lagThreshold).toBe(0)
    expect(read({ PROFILE_BLOCKS: '0' }).config.indexing.profileBlocks).toBe(0)
  })

  it('keeps BACKFILL_BUDGET_HEADROOM inside (0, 1]', () => {
    expect(read({ BACKFILL_BUDGET_HEADROOM: '0.75' }).config.backfill.budgetHeadroom).toBe(0.75)
    expect(read({ BACKFILL_BUDGET_HEADROOM: '1.5' }).config.backfill.budgetHeadroom).toBe(0.4)
    expect(read({ BACKFILL_BUDGET_HEADROOM: '0' }).config.backfill.budgetHeadroom).toBe(0.4)
  })
})

describe('TT_QUEUE_ALERT_ROWS hysteresis', () => {
  it('defaults to twice the backpressure bound', () => {
    expect(read({}).config.ttQueueAlertRows).toBe(100_000)
  })

  it('is floored AT the backpressure bound', () => {
    // PR #43 reused one value for both and the WARN fired on every momentary
    // ride along the ceiling — 13 benign fires in a day. An override must not
    // be able to make the alert noisier than the bound.
    const { config } = read({ TT_QUEUE_HIGH_WATER_ROWS: '50000', TT_QUEUE_ALERT_ROWS: '10' })
    expect(config.ttQueueAlertRows).toBe(50_000)
  })

  it('honours a higher override', () => {
    expect(read({ TT_QUEUE_ALERT_ROWS: '250000' }).config.ttQueueAlertRows).toBe(250_000)
  })

  it('never resolves to NaN', () => {
    expect(Number.isFinite(read({ TT_QUEUE_HIGH_WATER_ROWS: 'lots' }).config.ttQueueAlertRows)).toBe(true)
  })
})

describe('one declaration per variable', () => {
  it('exposes a single partition width', () => {
    // ensure-schema.ts and migrate-partition-tt.ts each computed this from the
    // same env var. Two partition widths that can drift is a data-placement bug.
    const { config } = read({ PARTITION_BLOCKS: '96000', PARTITION_AHEAD: '3' })
    expect(config.partitions.blocks).toBe(96_000)
    expect(config.partitions.ahead).toBe(3)
  })

  it('exposes a single DB_DISK_GB', () => {
    // retention-cleanup used parseInt and backfill-worker used Number; they
    // disagree on '' (NaN vs 0) and on '5x' (5 vs NaN), for the variable that
    // gates the destructive disk threshold.
    expect(read({ DB_DISK_GB: '5x' }).config.retention.dbDiskGb).toBe(0)
    expect(read({ DB_DISK_GB: '' }).config.retention.dbDiskGb).toBe(0)
    expect(read({ DB_DISK_GB: '221' }).config.retention.dbDiskGb).toBe(221)
  })

  it('holder-balance tracking is off and not env-tunable', () => {
    expect(read({ HOLDER_BALANCE_TRACKING: '1' }).config.holderBalanceTrackingEnabled).toBe(false)
  })
})

describe('the boot log', () => {
  it('records every variable it read', () => {
    const { resolutions } = read()
    expect(resolutions.length).toBeGreaterThanOrEqual(40)
    expect(new Set(resolutions.map(r => r.name)).size).toBe(resolutions.length)
  })

  it('reports which values came from the environment', () => {
    const { resolutions } = read({ RETENTION_DAYS: '3' })
    const line = formatResolvedConfig(resolutions).find(l => l.includes('RETENTION_DAYS'))
    expect(line).toContain('RETENTION_DAYS=3')
  })

  it('says so when a supplied value was rejected', () => {
    // Silently using the default is how a typo survives for weeks.
    const lines = formatResolvedConfig(read({ MAX_LAG_BLOCKS: 'lots' }).resolutions)
    const warn = lines.find(l => l.includes('MAX_LAG_BLOCKS'))
    expect(warn).toMatch(/ignored invalid "lots", using 1000/)
  })

  it('does not print an unset variable as env-sourced', () => {
    const lines = formatResolvedConfig(read().resolutions)
    expect(lines.some(l => l.includes('RETENTION_DAYS='))).toBe(false)
  })
})

describe('redact', () => {
  it.each([
    ['postgres://user:hunter2@db.example.com:5432/altscan', 'postgres://***@db.example.com:5432/altscan'],
    ['https://eth.example.com/v2/SECRETKEY', 'https://***@eth.example.com/v2/SECRETKEY'],
  ])('masks credentials in %j', (raw, expected) => {
    expect(redact(raw)).toBe(expected)
  })

  it('never returns the raw value for something URL-shaped it cannot parse', () => {
    expect(redact('weird://:@@@')).toBe('***')
  })

  it('leaves a plain value alone', () => {
    expect(redact('production')).toBe('production')
  })
})
