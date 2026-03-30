/**
 * ERC-20/ERC-721/ERC-1155 token transfer decoder for Ethereum.
 * Extracts token metadata on first encounter and persists to the DB.
 * Maintains token_balances and tokens.holder_count on each transfer.
 */
import { Log, AbiCoder, Contract } from 'ethers'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'

const provider = new JsonRpcProvider(process.env.ETH_RPC_URL ?? 'https://eth.llamarpc.com')
const abi = AbiCoder.defaultAbiCoder()

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// Local cache to avoid redundant DB lookups — capped at 50k entries
const tokenCache = new Set<string>()
const TOKEN_CACHE_MAX = 50_000

export async function decodeTokenTransfer(
  db: ReturnType<typeof drizzle>,
  log: Log,
  type: 'BEP20' | 'BEP721' | 'BEP1155',
  blockNumber: number,
  timestamp: Date,
  txHash: string
) {
  try {
    let from: string, to: string, value: bigint, tokenId: bigint | null = null

    if (type === 'BEP20') {
      from = '0x' + log.topics[1].slice(26)
      to = '0x' + log.topics[2].slice(26)
      value = abi.decode(['uint256'], log.data)[0] as bigint
    } else if (type === 'BEP721') {
      from = '0x' + log.topics[1].slice(26)
      to = '0x' + log.topics[2].slice(26)
      tokenId = BigInt(log.topics[3])
      value = 1n
    } else {
      // ERC-1155 TransferSingle
      from = '0x' + log.topics[2].slice(26)
      to = '0x' + log.topics[3].slice(26)
      const decoded = abi.decode(['uint256', 'uint256'], log.data)
      tokenId = decoded[0] as bigint
      value = decoded[1] as bigint
    }

    const tokenAddress = log.address.toLowerCase()
    from = from.toLowerCase()
    to = to.toLowerCase()

    await ensureToken(db, tokenAddress, type)

    // Use log_index 0 as fallback — token_transfers table has (tx_hash, log_index) unique
    const logIndex = log.index ?? 0

    const inserted = await db.execute(sql`
      INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, value, token_id, block_number, timestamp)
      VALUES (
        ${txHash}, ${logIndex}, ${tokenAddress},
        ${from}, ${to},
        ${value.toString()},
        ${tokenId?.toString() ?? null},
        ${blockNumber},
        ${timestamp.toISOString()}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `)

    // Only update holder tracking for new inserts, not replays
    if (Array.from(inserted).length > 0) {
      await updateHolderCount(db, tokenAddress, from, to, value)
    }
  } catch {
    // Silent — malformed log or unsupported token, skip
  }
}

/**
 * Maintain token_balances and adjust tokens.holder_count when an address
 * crosses the zero-balance threshold (entering or exiting holder status).
 */
async function updateHolderCount(
  db: ReturnType<typeof drizzle>,
  tokenAddress: string,
  from: string,
  to: string,
  value: bigint,
): Promise<void> {
  const valueStr = value.toString()
  let delta = 0

  // Recipient: upsert balance, detect 0 → positive crossing
  if (to !== ZERO_ADDRESS) {
    const result = await db.execute(sql`
      INSERT INTO token_balances (token_address, holder_address, balance)
      VALUES (${tokenAddress}, ${to}, ${valueStr}::numeric)
      ON CONFLICT (token_address, holder_address)
      DO UPDATE SET balance = token_balances.balance + EXCLUDED.balance
      RETURNING balance, balance - ${valueStr}::numeric AS old_balance
    `)
    const row = Array.from(result)[0] as { balance: string; old_balance: string } | undefined
    if (row && BigInt(row.old_balance) === 0n && BigInt(row.balance) > 0n) {
      delta += 1
    }
  }

  // Sender: decrement balance, detect positive → 0 crossing (skip on mints)
  if (from !== ZERO_ADDRESS) {
    const result = await db.execute(sql`
      UPDATE token_balances
      SET balance = balance - ${valueStr}::numeric
      WHERE token_address = ${tokenAddress} AND holder_address = ${from}
      RETURNING balance AS new_balance, (balance + ${valueStr}::numeric) AS old_balance
    `)
    const row = Array.from(result)[0] as { new_balance: string; old_balance: string } | undefined
    if (row && BigInt(row.old_balance) > 0n && BigInt(row.new_balance) <= 0n) {
      delta -= 1
    }
  }

  if (delta !== 0) {
    await db.execute(sql`
      UPDATE tokens
      SET holder_count = GREATEST(0, holder_count + ${delta})
      WHERE address = ${tokenAddress}
    `)
  }
}

async function ensureToken(
  db: ReturnType<typeof drizzle>,
  address: string,
  type: 'BEP20' | 'BEP721' | 'BEP1155'
) {
  if (tokenCache.has(address)) return

  // Check DB first (cheaper than RPC)
  try {
    const rows = await db.execute(sql`SELECT address FROM tokens WHERE address = ${address} LIMIT 1`)
    if (Array.from(rows).length > 0) {
      if (tokenCache.size >= TOKEN_CACHE_MAX) {
        tokenCache.delete(tokenCache.values().next().value!)
      }
      tokenCache.add(address)
      return
    }
  } catch { return }

  // Fetch metadata via RPC
  try {
    const contract = new Contract(address, ERC20_ABI, provider)
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      contract.name().catch(() => 'Unknown'),
      contract.symbol().catch(() => '???'),
      contract.decimals().catch(() => 18),
      contract.totalSupply().catch(() => 0n),
    ])

    await db.execute(sql`
      INSERT INTO tokens (address, name, symbol, decimals, type, total_supply, holder_count)
      VALUES (
        ${address},
        ${String(name).slice(0, 255)},
        ${String(symbol).slice(0, 50)},
        ${Number(decimals)},
        ${type},
        ${BigInt(totalSupply as bigint).toString()},
        0
      )
      ON CONFLICT (address) DO NOTHING
    `)

    if (tokenCache.size >= TOKEN_CACHE_MAX) {
      tokenCache.delete(tokenCache.values().next().value!)
    }
    tokenCache.add(address)
  } catch {
    // Skip unknown or non-standard tokens
  }
}
