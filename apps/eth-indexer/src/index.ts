/**
 * Ethereum block indexer — live polling loop.
 *
 * Indexes blocks → transactions → token transfers → DEX trades.
 * Writes to the ethscan PostgreSQL database (ETH_DATABASE_URL).
 *
 * Env vars:
 *   ETH_RPC_URL        — Ethereum JSON-RPC endpoint (default: https://eth.llamarpc.com)
 *   ETH_DATABASE_URL   — PostgreSQL connection string (default: postgresql://localhost:5432/ethscan)
 *   START_BLOCK        — Block to start from if DB is empty (default: 0 = chain tip - 100)
 *   LOG_EVERY          — Log progress every N blocks (default: 10)
 */
import { JsonRpcProvider } from 'ethers'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { processLogs } from './log-processor'
import { startRetentionCleanup } from './retention-cleanup'

const RPC_URL      = process.env.ETH_RPC_URL      ?? 'https://eth.llamarpc.com'
const DATABASE_URL = process.env.ETH_DATABASE_URL  ?? 'postgresql://localhost:5432/ethscan'
const POLL_MS      = 12_000   // Ethereum ~12s slot time
const BATCH_SIZE   = 3        // ETH blocks are heavier — keep batches small
const LOG_EVERY    = parseInt(process.env.LOG_EVERY ?? '10', 10)

let running = true
process.on('SIGINT',  () => { running = false })
process.on('SIGTERM', () => { running = false })

async function main() {
  console.log('[eth-indexer] Starting Ethereum indexer...')
  console.log(`[eth-indexer] RPC: ${RPC_URL.replace(/\/\/.*@/, '//***@')}`)

  const pgClient = postgres(DATABASE_URL, { max: 8 })
  const db = drizzle(pgClient)
  const provider = new JsonRpcProvider(RPC_URL)

  await ensureSchema(db)

  // 90-day retention cleanup — await first run so DB is clean before we read lastIndexedBlock
  await startRetentionCleanup(db)

  let lastIndexed = await getLastIndexedBlock(db)
  const tip = await provider.getBlockNumber()
  // If DB is empty, start from tip - 1000 (avoid syncing full history on first run)
  if (lastIndexed === 0) {
    const startBlock = parseInt(process.env.START_BLOCK ?? '0', 10)
    lastIndexed = startBlock > 0 ? startBlock - 1 : Math.max(0, tip - 1000)
    console.log(`[eth-indexer] Empty DB — starting from block ${lastIndexed + 1} (tip: ${tip})`)
  } else {
    console.log(`[eth-indexer] Resuming from block ${lastIndexed + 1} (tip: ${tip})`)
  }

  while (running) {
    try {
      const latest = await provider.getBlockNumber()

      if (latest <= lastIndexed) {
        await sleep(POLL_MS)
        continue
      }

      const from = lastIndexed + 1
      const to   = Math.min(from + BATCH_SIZE - 1, latest)

      for (let num = from; num <= to && running; num++) {
        await indexBlock(db, provider, num)
        lastIndexed = num
        if (lastIndexed % LOG_EVERY === 0) {
          console.log(`[eth-indexer] Indexed block ${lastIndexed} (chain head: ${latest}, lag: ${latest - lastIndexed})`)
        }
      }

      // Caught up — pause for next slot
      if (lastIndexed >= latest) {
        await sleep(POLL_MS)
      }
    } catch (err) {
      console.error('[eth-indexer] Error:', err instanceof Error ? err.message : err)
      await sleep(5000)
    }
  }

  await pgClient.end()
  console.log('[eth-indexer] Stopped.')
}

async function indexBlock(
  db: ReturnType<typeof drizzle>,
  provider: JsonRpcProvider,
  blockNumber: number
) {
  const block = await provider.getBlock(blockNumber, true)
  if (!block) {
    console.warn(`[eth-indexer] Block ${blockNumber} not found — skipping`)
    return
  }

  const timestamp = new Date(Number(block.timestamp) * 1000)
  const baseFeePerGas = block.baseFeePerGas ?? 0n

  // Insert block row
  await db.execute(sql`
    INSERT INTO blocks (number, hash, parent_hash, timestamp, miner, gas_used, gas_limit, base_fee_per_gas, tx_count, size)
    VALUES (
      ${blockNumber},
      ${block.hash ?? ''},
      ${block.parentHash},
      ${timestamp.toISOString()},
      ${block.miner.toLowerCase()},
      ${block.gasUsed.toString()},
      ${block.gasLimit.toString()},
      ${baseFeePerGas.toString()},
      ${block.transactions.length},
      ${(block as unknown as { size?: number }).size ?? 0}
    )
    ON CONFLICT (number) DO UPDATE SET
      hash             = EXCLUDED.hash,
      tx_count         = EXCLUDED.tx_count,
      base_fee_per_gas = EXCLUDED.base_fee_per_gas
  `)

  // Snapshot gas_history for this block
  await db.execute(sql`
    INSERT INTO gas_history (timestamp, block_number, avg_gas_price, base_fee, txn_count)
    VALUES (
      ${timestamp.toISOString()},
      ${blockNumber},
      ${baseFeePerGas.toString()},
      ${baseFeePerGas.toString()},
      ${block.transactions.length}
    )
    ON CONFLICT DO NOTHING
  `)

  // Insert transactions (prefetched with block)
  const txs = block.prefetchedTransactions
  for (const tx of txs) {
    const effectiveGasPrice = tx.gasPrice ?? (baseFeePerGas + (tx.maxPriorityFeePerGas ?? 0n))

    await db.execute(sql`
      INSERT INTO transactions (hash, block_number, from_address, to_address, value, gas, gas_price, gas_used, input, status, method_id, tx_index, timestamp)
      VALUES (
        ${tx.hash},
        ${blockNumber},
        ${tx.from.toLowerCase()},
        ${tx.to?.toLowerCase() ?? null},
        ${tx.value.toString()},
        ${tx.gasLimit.toString()},
        ${effectiveGasPrice.toString()},
        0,
        ${tx.data.length > 10000 ? tx.data.slice(0, 10000) : tx.data},
        true,
        ${tx.data.length >= 10 ? tx.data.slice(0, 10) : null},
        ${tx.index ?? 0},
        ${timestamp.toISOString()}
      )
      ON CONFLICT (hash) DO NOTHING
    `)
  }

  // Process logs for each tx: update status/gasUsed, decode tokens + DEX trades
  for (const tx of txs) {
    try {
      await processLogs(db, tx.hash, blockNumber, timestamp)
    } catch (err) {
      console.warn(`[eth-indexer] Log processing failed for ${tx.hash}:`, err instanceof Error ? err.message : err)
    }
  }
}

async function ensureSchema(db: ReturnType<typeof drizzle>) {
  console.log('[eth-indexer] Ensuring schema...')

  // Enums (idempotent via DO NOTHING pattern)
  await db.execute(sql`DO $$ BEGIN CREATE TYPE token_type AS ENUM ('BEP20','BEP721','BEP1155'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
  await db.execute(sql`DO $$ BEGIN CREATE TYPE verify_source AS ENUM ('own','sourcify'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS blocks (
      number          BIGINT PRIMARY KEY,
      hash            VARCHAR(66) UNIQUE NOT NULL,
      parent_hash     VARCHAR(66) NOT NULL,
      timestamp       TIMESTAMPTZ NOT NULL,
      miner           VARCHAR(42) NOT NULL,
      gas_used        BIGINT NOT NULL DEFAULT 0,
      gas_limit       BIGINT NOT NULL DEFAULT 0,
      base_fee_per_gas NUMERIC(36,0),
      tx_count        INTEGER NOT NULL DEFAULT 0,
      size            INTEGER NOT NULL DEFAULT 0
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS transactions (
      hash            VARCHAR(66) PRIMARY KEY,
      block_number    BIGINT NOT NULL REFERENCES blocks(number),
      from_address    VARCHAR(42) NOT NULL,
      to_address      VARCHAR(42),
      value           NUMERIC(78,18) NOT NULL DEFAULT 0,
      gas             BIGINT NOT NULL DEFAULT 0,
      gas_price       NUMERIC(36,0) NOT NULL DEFAULT 0,
      gas_used        BIGINT NOT NULL DEFAULT 0,
      input           TEXT NOT NULL DEFAULT '0x',
      status          BOOLEAN NOT NULL DEFAULT true,
      method_id       VARCHAR(10),
      tx_index        INTEGER NOT NULL DEFAULT 0,
      timestamp       TIMESTAMPTZ NOT NULL
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS token_transfers (
      id              SERIAL PRIMARY KEY,
      tx_hash         VARCHAR(66) NOT NULL,
      log_index       INTEGER NOT NULL DEFAULT 0,
      token_address   VARCHAR(42) NOT NULL,
      from_address    VARCHAR(42) NOT NULL,
      to_address      VARCHAR(42) NOT NULL,
      value           NUMERIC(78,0) NOT NULL DEFAULT 0,
      token_id        NUMERIC(78,0),
      block_number    BIGINT NOT NULL,
      timestamp       TIMESTAMPTZ NOT NULL,
      UNIQUE (tx_hash, log_index)
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tokens (
      address         VARCHAR(42) PRIMARY KEY,
      name            VARCHAR(255) NOT NULL,
      symbol          VARCHAR(50) NOT NULL,
      decimals        INTEGER NOT NULL DEFAULT 18,
      type            token_type NOT NULL DEFAULT 'BEP20',
      total_supply    NUMERIC(78,0) NOT NULL DEFAULT 0,
      holder_count    INTEGER NOT NULL DEFAULT 0
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS logs (
      tx_hash         VARCHAR(66) NOT NULL,
      log_index       INTEGER NOT NULL,
      address         VARCHAR(42) NOT NULL,
      topic0          VARCHAR(66),
      topic1          VARCHAR(66),
      topic2          VARCHAR(66),
      topic3          VARCHAR(66),
      data            TEXT NOT NULL DEFAULT '0x',
      block_number    BIGINT NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS contracts (
      address         VARCHAR(42) PRIMARY KEY,
      bytecode        TEXT NOT NULL DEFAULT '0x',
      abi             JSONB,
      name            VARCHAR(255),
      compiler_version VARCHAR(50),
      verify_source   verify_source,
      verified_at     TIMESTAMPTZ,
      license         VARCHAR(100)
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS dex_trades (
      id              SERIAL PRIMARY KEY,
      tx_hash         VARCHAR(66) NOT NULL,
      dex             VARCHAR(50) NOT NULL,
      pair_address    VARCHAR(42) NOT NULL,
      token_in        VARCHAR(42),
      token_out       VARCHAR(42),
      amount_in       NUMERIC(78,0),
      amount_out      NUMERIC(78,0),
      maker           VARCHAR(42) NOT NULL,
      block_number    BIGINT NOT NULL,
      timestamp       TIMESTAMPTZ NOT NULL
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gas_history (
      id              SERIAL PRIMARY KEY,
      timestamp       TIMESTAMPTZ NOT NULL,
      block_number    BIGINT,
      avg_gas_price   NUMERIC(36,0),
      base_fee        NUMERIC(36,0),
      txn_count       INTEGER
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS addresses (
      address         VARCHAR(42) PRIMARY KEY,
      balance         NUMERIC(36,18) NOT NULL DEFAULT 0,
      tx_count        INTEGER NOT NULL DEFAULT 0,
      is_contract     BOOLEAN NOT NULL DEFAULT false,
      label           VARCHAR(255),
      first_seen      TIMESTAMPTZ,
      last_seen       TIMESTAMPTZ
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS webhooks (
      id              SERIAL PRIMARY KEY,
      owner_address   VARCHAR(42) NOT NULL,
      url             TEXT NOT NULL,
      watch_address   VARCHAR(42),
      event_types     TEXT[] NOT NULL DEFAULT '{tx}',
      secret          VARCHAR(64) NOT NULL,
      active          BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_triggered_at TIMESTAMPTZ,
      fail_count      INTEGER NOT NULL DEFAULT 0
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id              SERIAL PRIMARY KEY,
      key_hash        VARCHAR(64) UNIQUE NOT NULL,
      key_prefix      VARCHAR(20) NOT NULL,
      label           VARCHAR(100),
      owner_address   VARCHAR(42) NOT NULL,
      requests_per_minute INTEGER NOT NULL DEFAULT 100,
      total_requests  BIGINT NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at    TIMESTAMPTZ,
      active          BOOLEAN NOT NULL DEFAULT true
    )
  `)

  // Indexes (all idempotent)
  const indexes = [
    'CREATE INDEX IF NOT EXISTS eth_blocks_miner_idx    ON blocks(miner)',
    'CREATE INDEX IF NOT EXISTS eth_blocks_ts_idx       ON blocks(timestamp)',
    'CREATE INDEX IF NOT EXISTS eth_tx_from_idx         ON transactions(from_address)',
    'CREATE INDEX IF NOT EXISTS eth_tx_to_idx           ON transactions(to_address)',
    'CREATE INDEX IF NOT EXISTS eth_tx_block_idx        ON transactions(block_number)',
    'CREATE INDEX IF NOT EXISTS eth_tx_ts_idx           ON transactions(timestamp)',
    'CREATE INDEX IF NOT EXISTS eth_tt_token_idx        ON token_transfers(token_address)',
    'CREATE INDEX IF NOT EXISTS eth_tt_from_idx         ON token_transfers(from_address)',
    'CREATE INDEX IF NOT EXISTS eth_tt_to_idx           ON token_transfers(to_address)',
    'CREATE INDEX IF NOT EXISTS eth_tt_tx_idx           ON token_transfers(tx_hash)',
    'CREATE INDEX IF NOT EXISTS eth_tt_block_idx        ON token_transfers(block_number)',
    'CREATE INDEX IF NOT EXISTS eth_logs_addr_idx       ON logs(address)',
    'CREATE INDEX IF NOT EXISTS eth_logs_topic0_idx     ON logs(topic0)',
    'CREATE INDEX IF NOT EXISTS eth_dex_pair_idx        ON dex_trades(pair_address)',
    'CREATE INDEX IF NOT EXISTS eth_dex_maker_idx       ON dex_trades(maker)',
    'CREATE INDEX IF NOT EXISTS eth_dex_block_idx       ON dex_trades(block_number)',
    'CREATE INDEX IF NOT EXISTS eth_gas_ts_idx          ON gas_history(timestamp)',
    'CREATE INDEX IF NOT EXISTS eth_gas_block_idx       ON gas_history(block_number)',
    'CREATE INDEX IF NOT EXISTS eth_webhooks_owner_idx  ON webhooks(owner_address)',
    'CREATE INDEX IF NOT EXISTS eth_apikeys_owner_idx   ON api_keys(owner_address)',
  ]
  for (const idx of indexes) {
    await db.execute(sql.raw(idx))
  }

  console.log('[eth-indexer] Schema ready.')
}

async function getLastIndexedBlock(db: ReturnType<typeof drizzle>): Promise<number> {
  try {
    const result = await db.execute(sql`SELECT MAX(number) as max FROM blocks`)
    const rows = Array.from(result)
    const max = (rows[0] as Record<string, unknown>)?.max
    return max ? Number(max) : 0
  } catch {
    return 0
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => {
  console.error('[eth-indexer] Fatal:', err)
  process.exit(1)
})
