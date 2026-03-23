import { pgTable, bigint, varchar, boolean, timestamp, integer, numeric, text, pgEnum, serial, jsonb, index } from 'drizzle-orm/pg-core'

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
  timestamp:    timestamp('timestamp', { withTimezone: true }).notNull(),
}, (t) => ({
  fromIdx:      index('tx_from_idx').on(t.fromAddress),
  toIdx:        index('tx_to_idx').on(t.toAddress),
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
  id:           serial('id').primaryKey(),
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
  fromIdx:      index('tt_from_idx').on(t.fromAddress),
  toIdx:        index('tt_to_idx').on(t.toAddress),
  txIdx:        index('tt_tx_idx').on(t.txHash),
  blockIdx:     index('tt_block_idx').on(t.blockNumber),
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
})

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
