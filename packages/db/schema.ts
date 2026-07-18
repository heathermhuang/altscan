import { pgTable, bigint, varchar, boolean, timestamp, integer, numeric, text, pgEnum, serial, jsonb, index, unique, primaryKey } from 'drizzle-orm/pg-core'

export const tokenTypeEnum = pgEnum('token_type', ['BEP20', 'BEP721', 'BEP1155'])
export const validatorStatusEnum = pgEnum('validator_status', ['active', 'inactive', 'jailed'])
export const verifySourceEnum = pgEnum('verify_source', ['own', 'sourcify'])

export const blocks = pgTable('blocks', {
  number:       bigint('number', { mode: 'number' }).primaryKey(),
  hash:         varchar('hash', { length: 66 }).notNull().unique(),
  parentHash:   varchar('parent_hash', { length: 66 }).notNull(),
  timestamp:    timestamp('timestamp', { withTimezone: true }).notNull(),
  miner:        varchar('miner', { length: 42 }).notNull(),
  gasUsed:      bigint('gas_used', { mode: 'bigint' }).notNull(),
  gasLimit:     bigint('gas_limit', { mode: 'bigint' }).notNull(),
  baseFeePerGas: numeric('base_fee_per_gas', { precision: 36, scale: 0 }),
  txCount:      integer('tx_count').notNull().default(0),
  size:         integer('size').notNull().default(0),
}, (t) => ({
  minerIdx: index('blocks_miner_idx').on(t.miner),
  timestampIdx: index('blocks_timestamp_idx').on(t.timestamp),
}))

export const transactions = pgTable('transactions', {
  hash:         varchar('hash', { length: 66 }).primaryKey(),
  blockNumber:  bigint('block_number', { mode: 'number' }).notNull().references(() => blocks.number),
  fromAddress:  varchar('from_address', { length: 42 }).notNull(),
  toAddress:    varchar('to_address', { length: 42 }),
  value:        numeric('value', { precision: 78, scale: 18 }).notNull().default('0'),
  gas:          bigint('gas', { mode: 'bigint' }).notNull(),
  gasPrice:     numeric('gas_price', { precision: 36, scale: 0 }).notNull(),
  gasUsed:      bigint('gas_used', { mode: 'bigint' }).notNull().default(0n),
  input:        text('input').notNull().default('0x'),
  status:       boolean('status').notNull().default(true),
  methodId:     varchar('method_id', { length: 10 }),
  txIndex:      integer('tx_index').notNull(),
  nonce:        integer('nonce'),
  txType:       integer('tx_type'),
  timestamp:    timestamp('timestamp', { withTimezone: true }).notNull(),
  // Set true by retention when the heavy `input` calldata is pruned in place
  // (the compact row is kept forever). The tx page reads this to refetch the
  // body (input + logs) on demand. Default false = body present.
  bodyPruned:   boolean('body_pruned').notNull().default(false),
}, (t) => ({
  // Composite indexes on (address, timestamp) also cover single-address lookups,
  // so we don't need separate single-column indexes on fromAddress/toAddress.
  fromTsIdx:    index('tx_from_ts_idx').on(t.fromAddress, t.timestamp),
  toTsIdx:      index('tx_to_ts_idx').on(t.toAddress, t.timestamp),
  blockIdx:     index('tx_block_idx').on(t.blockNumber),
  timestampIdx: index('tx_timestamp_idx').on(t.timestamp),
}))

export const addresses = pgTable('addresses', {
  address:      varchar('address', { length: 42 }).primaryKey(),
  balance:      numeric('balance', { precision: 36, scale: 18 }).notNull().default('0'),
  txCount:      integer('tx_count').notNull().default(0),
  isContract:   boolean('is_contract').notNull().default(false),
  label:        varchar('label', { length: 255 }),
  firstSeen:    timestamp('first_seen', { withTimezone: true }),
  lastSeen:     timestamp('last_seen', { withTimezone: true }),
})

export const tokenTransfers = pgTable('token_transfers', {
  // No surrogate `id`: token_transfers is RANGE-partitioned by block_number (see
  // migrate-partition-tt.ts) and nothing reads or orders by a row id — all reads key
  // on token_address / from/to_address / tx_hash / block_number. The old int4 `serial`
  // id was dropped 2026-06-20 after its sequence overflowed 2^31 on BNB and OOM-crash-
  // looped the indexer; writers count inserted rows via `.length`, never the id value.
  txHash:       varchar('tx_hash', { length: 66 }).notNull(),
  logIndex:     integer('log_index').notNull(),
  tokenAddress: varchar('token_address', { length: 42 }).notNull(),
  fromAddress:  varchar('from_address', { length: 42 }).notNull(),
  toAddress:    varchar('to_address', { length: 42 }).notNull(),
  value:        numeric('value', { precision: 78, scale: 0 }).notNull().default('0'),
  tokenId:      numeric('token_id', { precision: 78, scale: 0 }),
  blockNumber:  bigint('block_number', { mode: 'number' }).notNull(),
  timestamp:    timestamp('timestamp', { withTimezone: true }).notNull(),
}, (t) => ({
  tokenIdx:     index('tt_token_idx').on(t.tokenAddress),
  // Composite indexes on (address, timestamp) also cover single-address lookups
  fromTsIdx:    index('tt_from_ts_idx').on(t.fromAddress, t.timestamp),
  toTsIdx:      index('tt_to_ts_idx').on(t.toAddress, t.timestamp),
  blockIdx:     index('tt_block_idx').on(t.blockNumber),
  // Non-unique index on tx_hash for the tx-detail page lookup. Replaces the old
  // tt_tx_log_unique(tx_hash, log_index): idempotent writes no longer rely on a
  // unique constraint (the async transfer-writer rewrites each block-range with
  // DELETE+INSERT — see block-processor.ts), and a partitioned table can't carry a
  // unique that omits the partition key. ensure-schema.ts is the runtime DDL authority.
  txIdx:        index('tt_tx_idx').on(t.txHash),
}))

export const tokens = pgTable('tokens', {
  address:      varchar('address', { length: 42 }).primaryKey(),
  name:         varchar('name', { length: 255 }).notNull(),
  symbol:       varchar('symbol', { length: 50 }).notNull(),
  decimals:     integer('decimals').notNull().default(18),
  type:         tokenTypeEnum('type').notNull().default('BEP20'),
  totalSupply:  numeric('total_supply', { precision: 78, scale: 0 }).notNull().default('0'),
  holderCount:  integer('holder_count').notNull().default(0),
  logoUrl:      text('logo_url'),
}, (t) => ({
  // Top-N by holders (sitemap top-5000, token directory ranking).
  // ensure-schema.ts is the runtime DDL authority (declared holder_count DESC there).
  holderCountIdx: index('tokens_holder_count_idx').on(t.holderCount),
}))

export const logs = pgTable('logs', {
  id:           serial('id').primaryKey(),
  txHash:       varchar('tx_hash', { length: 66 }).notNull(),
  logIndex:     integer('log_index').notNull(),
  address:      varchar('address', { length: 42 }).notNull(),
  topic0:       varchar('topic0', { length: 66 }),
  topic1:       varchar('topic1', { length: 66 }),
  topic2:       varchar('topic2', { length: 66 }),
  topic3:       varchar('topic3', { length: 66 }),
  data:         text('data').notNull().default('0x'),
  blockNumber:  bigint('block_number', { mode: 'number' }).notNull(),
}, (t) => ({
  addressTopic0Idx: index('logs_address_topic0_idx').on(t.address, t.topic0),
  txIdx:            index('logs_tx_idx').on(t.txHash),
  // Unique constraint enables ON CONFLICT DO NOTHING for idempotent replay
  txLogUnique:      unique('logs_tx_log_unique').on(t.txHash, t.logIndex),
}))

export const tokenBalances = pgTable('token_balances', {
  tokenAddress:   varchar('token_address', { length: 42 }).notNull(),
  holderAddress:  varchar('holder_address', { length: 42 }).notNull(),
  balance:        numeric('balance', { precision: 78, scale: 0 }).notNull().default('0'),
}, (t) => ({
  holderUnique:   unique('tb_token_holder_unique').on(t.tokenAddress, t.holderAddress),
  holderIdx:      index('tb_holder_idx').on(t.holderAddress),
}))

export const contracts = pgTable('contracts', {
  address:        varchar('address', { length: 42 }).primaryKey(),
  bytecode:       text('bytecode').notNull(),
  abi:            jsonb('abi'),
  sourceCode:     text('source_code'),
  compilerVersion: varchar('compiler_version', { length: 50 }),
  verifiedAt:     timestamp('verified_at', { withTimezone: true }),
  verifySource:   verifySourceEnum('verify_source'),
  license:        varchar('license', { length: 100 }),
})

export const dexTrades = pgTable('dex_trades', {
  id:           serial('id').primaryKey(),
  txHash:       varchar('tx_hash', { length: 66 }).notNull(),
  dex:          varchar('dex', { length: 50 }).notNull(),
  pairAddress:  varchar('pair_address', { length: 42 }).notNull(),
  tokenIn:      varchar('token_in', { length: 42 }).notNull(),
  tokenOut:     varchar('token_out', { length: 42 }).notNull(),
  amountIn:     numeric('amount_in', { precision: 78, scale: 0 }).notNull(),
  amountOut:    numeric('amount_out', { precision: 78, scale: 0 }).notNull(),
  maker:        varchar('maker', { length: 42 }).notNull(),
  blockNumber:  bigint('block_number', { mode: 'number' }).notNull(),
  timestamp:    timestamp('timestamp', { withTimezone: true }).notNull(),
}, (t) => ({
  makerIdx:     index('dex_maker_idx').on(t.maker),
  pairIdx:      index('dex_pair_idx').on(t.pairAddress),
  blockIdx:     index('dex_block_idx').on(t.blockNumber),
}))

export const validators = pgTable('validators', {
  address:      varchar('address', { length: 42 }).primaryKey(),
  moniker:      varchar('moniker', { length: 255 }).notNull(),
  votingPower:  numeric('voting_power', { precision: 36, scale: 0 }).notNull().default('0'),
  commission:   numeric('commission', { precision: 5, scale: 4 }).notNull().default('0'),
  uptime:       numeric('uptime', { precision: 5, scale: 4 }).notNull().default('0'),
  status:       validatorStatusEnum('status').notNull().default('active'),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const gasHistory = pgTable('gas_history', {
  id:           serial('id').primaryKey(),
  slow:         numeric('slow', { precision: 36, scale: 0 }).notNull(),
  standard:     numeric('standard', { precision: 36, scale: 0 }).notNull(),
  fast:         numeric('fast', { precision: 36, scale: 0 }).notNull(),
  baseFee:      numeric('base_fee', { precision: 36, scale: 0 }).notNull(),
  blockNumber:  bigint('block_number', { mode: 'number' }).notNull(),
  timestamp:    timestamp('timestamp', { withTimezone: true }).notNull(),
})

export const webhooks = pgTable('webhooks', {
  id:               serial('id').primaryKey(),
  ownerAddress:     varchar('owner_address', { length: 42 }).notNull(),
  url:              text('url').notNull(),
  watchAddress:     varchar('watch_address', { length: 42 }),
  eventTypes:       text('event_types').array().notNull().default(['tx'] as string[]),
  secret:           varchar('secret', { length: 64 }),
  active:           boolean('active').notNull().default(true),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastTriggeredAt:  timestamp('last_triggered_at', { withTimezone: true }),
  failCount:        integer('fail_count').notNull().default(0),
}, (t) => ({
  ownerIdx: index('webhooks_owner_idx').on(t.ownerAddress),
  watchIdx:  index('webhooks_watch_idx').on(t.watchAddress),
}))

export const apiKeys = pgTable('api_keys', {
  id:                 serial('id').primaryKey(),
  keyHash:            varchar('key_hash', { length: 64 }).notNull().unique(),
  keyPrefix:          varchar('key_prefix', { length: 12 }).notNull(),
  label:              varchar('label', { length: 255 }),
  ownerAddress:       varchar('owner_address', { length: 42 }),
  requestsPerMinute:  integer('requests_per_minute').notNull().default(100),
  totalRequests:      bigint('total_requests', { mode: 'number' }).notNull().default(0),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt:         timestamp('last_used_at', { withTimezone: true }),
  active:             boolean('active').notNull().default(true),
}, (t) => ({
  ownerIdx: index('api_keys_owner_idx').on(t.ownerAddress),
}))

// Runtime-editable explorer settings (admin console) — one JSONB doc per
// namespace ('links' | 'footer' | 'ads'), validated by @altscan/settings-schema.
export const explorerSettings = pgTable('explorer_settings', {
  key:       text('key').primaryKey(),
  value:     jsonb('value').notNull(),
  version:   integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
})

export const explorerSettingsAudit = pgTable('explorer_settings_audit', {
  id:        serial('id').primaryKey(),
  key:       text('key').notNull(),
  value:     jsonb('value').notNull(),
  version:   integer('version').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
}, (t) => ({
  keyIdx: index('explorer_settings_audit_key_idx').on(t.key, t.id),
}))

// ── Track A4b: lazy provider backfill (immortal — retention NEVER lists these) ──
//
// These four tables are exempt from retention BY CONSTRUCTION, not by a
// conditional flag: they are simply never added to COMPACT_TABLES,
// BODY_PRUNE_OPS, COMPACT_PRUNE_TABLES, or retention-cleanup's ALLOWED_TABLES.
// See the invariant test in apps/indexer/src/retention-policy.test.ts.
//
// Immortal + retention-exempt means growth MUST be bounded at write time
// instead — the backfill worker stops on its own size/disk ceilings (R5), so
// the disk-emergency path is never forced to choose between the cache and the
// live index.

/** Provider-decoded address tx history, cached forever. Columns are the reduced
 *  projection served as `HistoryRow` — NOT a full `ProviderTx`; gas/erc20 fields
 *  are deliberately absent rather than fabricated. PK (address, tx_hash): a tx
 *  appears at most once in a given address's history. */
export const backfillAddressTxs = pgTable('backfill_address_txs', {
  address:        varchar('address', { length: 42 }).notNull(),
  txHash:         varchar('tx_hash', { length: 66 }).notNull(),
  blockNumber:    bigint('block_number', { mode: 'number' }).notNull(),
  blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),
  fromAddress:    varchar('from_address', { length: 42 }).notNull(),
  toAddress:      varchar('to_address', { length: 42 }),
  value:          numeric('value', { precision: 78, scale: 0 }).notNull().default('0'),
  category:       varchar('category', { length: 64 }),
  summary:        text('summary'),
  possibleSpam:   boolean('possible_spam').notNull().default(false),
}, (t) => ({
  pk:      primaryKey({ columns: [t.address, t.txHash] }),
  addrIdx: index('backfill_address_txs_addr_block_idx').on(t.address, t.blockNumber),
}))

/** Provider token transfers scoped to the entity whose view triggered the
 *  backfill (address OR token). Identity is the provider's own `log_index` —
 *  stable across re-pages regardless of page membership or order.
 *
 *  VERIFIED LIVE 2026-07-18: Moralis returns log_index as a NUMBER on 25/25
 *  rows on both bsc and eth, so this is an `integer` column — numeric keyset
 *  ordering, with no '9' > '10' string-comparison footgun. Rows the provider
 *  returns without a usable log_index (adapter maps them to null) are SKIPPED
 *  by the worker, never written, so they cannot collide on the PK. */
export const backfillTokenTransfers = pgTable('backfill_token_transfers', {
  scopeAddress:   varchar('scope_address', { length: 42 }).notNull(),
  txHash:         varchar('tx_hash', { length: 66 }).notNull(),
  logIndex:       integer('log_index').notNull(),
  tokenAddress:   varchar('token_address', { length: 42 }).notNull(),
  fromAddress:    varchar('from_address', { length: 42 }).notNull(),
  toAddress:      varchar('to_address', { length: 42 }).notNull(),
  value:          numeric('value', { precision: 78, scale: 0 }).notNull().default('0'),
  valueFormatted: text('value_formatted'),
  tokenSymbol:    varchar('token_symbol', { length: 64 }),
  tokenDecimals:  integer('token_decimals'),
  blockNumber:    bigint('block_number', { mode: 'number' }).notNull(),
  blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),
}, (t) => ({
  pk:       primaryKey({ columns: [t.scopeAddress, t.txHash, t.logIndex] }),
  scopeIdx: index('backfill_token_transfers_scope_block_idx').on(t.scopeAddress, t.blockNumber),
}))

/** One row per backfilled entity — the queue + crash-resume state.
 *
 *  `lastAttemptAt` doubles as the LEASE CLOCK: a 'running' row whose
 *  lastAttemptAt is older than BACKFILL_LEASE_SEC (default 300) is treated as a
 *  crashed worker and becomes reclaimable. Claiming sets lastAttemptAt = now(),
 *  which both renews the lease and feeds the fair claim ordering. */
export const backfillWatermarks = pgTable('backfill_watermarks', {
  id:                     serial('id').primaryKey(),
  entityType:             varchar('entity_type', { length: 24 }).notNull(), // 'address_txs' | 'token_transfers'
  entityId:               varchar('entity_id', { length: 42 }).notNull(),
  status:                 varchar('status', { length: 12 }).notNull().default('pending'), // pending|running|partial|complete|capped|error
  backfilledThroughBlock: bigint('backfilled_through_block', { mode: 'number' }),
  oldestCursor:           text('oldest_cursor'),
  rowsWritten:            integer('rows_written').notNull().default(0),
  attempts:               integer('attempts').notNull().default(0),
  lastAttemptAt:          timestamp('last_attempt_at', { withTimezone: true }),
  lastError:              text('last_error'),
  createdAt:              timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:              timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  entityUnique: unique('backfill_watermarks_entity_unique').on(t.entityType, t.entityId),
  claimIdx:     index('backfill_watermarks_claim_idx').on(t.status, t.lastAttemptAt),
}))

/** Crash-safe hourly page budget for the worker. Enforced by a single
 *  reserve-or-deny INSERT … ON CONFLICT … WHERE pages_used < cap RETURNING —
 *  never a SELECT-then-bump, which races across the rolling-deploy overlap. */
export const backfillBudget = pgTable('backfill_budget', {
  bucketHour: timestamp('bucket_hour', { withTimezone: true }).primaryKey(),
  pagesUsed:  integer('pages_used').notNull().default(0),
})
