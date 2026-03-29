import { Log, AbiCoder, Contract } from 'ethers'
import { eq } from 'drizzle-orm'
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
    await ensureToken(tokenAddress, type)

    await db.insert(schema.tokenTransfers).values({
      txHash,
      logIndex: log.index,
      tokenAddress,
      fromAddress: from.toLowerCase(),
      toAddress: to.toLowerCase(),
      value: value.toString(),
      tokenId: tokenId?.toString() ?? null,
      blockNumber,
      timestamp,
    }).onConflictDoNothing()

  } catch (err) {
    console.warn('[token-decoder] Error decoding transfer:', txHash, err instanceof Error ? err.message : err)
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
