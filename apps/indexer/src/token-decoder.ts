import { Log, AbiCoder, Contract } from 'ethers'
import { eq, sql } from 'drizzle-orm'
import { getDb, schema } from './db'
import { getProvider } from './provider'

const provider = getProvider()
const abi = AbiCoder.defaultAbiCoder()

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export async function decodeTokenTransfer(
  log: Log,
  type: 'BEP20' | 'BEP721' | 'BEP1155',
  blockNumber: number,
  timestamp: Date,
  txHash: string
) {
  const db = getDb()

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
      // BEP1155 TransferSingle
      from = '0x' + log.topics[2].slice(26)
      to = '0x' + log.topics[3].slice(26)
      const decoded = abi.decode(['uint256', 'uint256'], log.data)
      tokenId = decoded[0] as bigint
      value = decoded[1] as bigint
    }

    const tokenAddress = log.address.toLowerCase()
    from = from.toLowerCase()
    to = to.toLowerCase()

    await ensureToken(tokenAddress, type)

    // Only update holder tracking if this is a new transfer (not a replay)
    const inserted = await db.insert(schema.tokenTransfers).values({
      txHash,
      logIndex: log.index,
      tokenAddress,
      fromAddress: from,
      toAddress: to,
      value: value.toString(),
      tokenId: tokenId?.toString() ?? null,
      blockNumber,
      timestamp,
    }).onConflictDoNothing().returning({ id: schema.tokenTransfers.id })

    if (inserted.length > 0) {
      await updateHolderCount(tokenAddress, from, to, value)
    }

  } catch (err) {
    console.warn('[token-decoder] Error decoding transfer:', txHash, err instanceof Error ? err.message : err)
  }
}

/**
 * Maintain token_balances and adjust tokens.holder_count when an address
 * crosses the zero-balance threshold (entering or exiting holder status).
 */
async function updateHolderCount(
  tokenAddress: string,
  from: string,
  to: string,
  value: bigint,
): Promise<void> {
  const db = getDb()
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

const tokenCache = new Set<string>()
const TOKEN_CACHE_MAX = 50_000

async function ensureToken(address: string, type: 'BEP20' | 'BEP721' | 'BEP1155') {
  if (tokenCache.has(address)) return
  // Evict when cache grows too large (BSC has 100k+ tokens)
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear()
  const db = getDb()

  const existing = await db.select().from(schema.tokens)
    .where(eq(schema.tokens.address, address))
    .limit(1)

  if (existing.length > 0) {
    tokenCache.add(address)
    return
  }

  try {
    const contract = new Contract(address, ERC20_ABI, provider)
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      contract.name().catch(() => 'Unknown'),
      contract.symbol().catch(() => '???'),
      contract.decimals().catch(() => 18),
      contract.totalSupply().catch(() => 0n),
    ])

    await db.insert(schema.tokens).values({
      address,
      name: String(name),
      symbol: String(symbol),
      decimals: Number(decimals),
      type,
      totalSupply: BigInt(totalSupply).toString(),
      holderCount: 0,
    }).onConflictDoNothing()

    tokenCache.add(address)
  } catch {
    // Skip unknown tokens
  }
}
