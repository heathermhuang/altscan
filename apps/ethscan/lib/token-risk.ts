import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { Contract } from 'ethers'
import { getProvider } from '@/lib/rpc'

export type RiskSignal = {
  label: string
  ok: boolean
  description: string
  severity: 'info' | 'warn' | 'danger'
}

// Standard ERC20 ABI minimal for owner() check
const OWNER_ABI = ['function owner() view returns (address)']

export async function analyzeTokenRisk(tokenAddress: string): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = []

  // 1. Source code verified?
  let contractData: typeof schema.contracts.$inferSelect | null = null
  try {
    const [c] = await db.select().from(schema.contracts)
      .where(eq(schema.contracts.address, tokenAddress.toLowerCase()))
    contractData = c ?? null
  } catch { /* DB error */ }

  signals.push({
    label: 'Source Verified',
    ok: !!contractData?.verifiedAt,
    description: contractData?.verifiedAt
      ? 'Source code is verified and public'
      : 'Source code is not verified — cannot audit',
    severity: contractData?.verifiedAt ? 'info' : 'danger',
  })

  // 2. Has mint function? Has blacklist? Is proxy?
  let hasMint = false
  let hasBlacklist = false
  let isProxy = false
  if (contractData?.abi) {
    try {
      const abi = contractData.abi as { name?: string; type?: string }[]
      const fnNames = abi.filter(f => f.type === 'function').map(f => (f.name ?? '').toLowerCase())
      hasMint = fnNames.some(n => n === 'mint' || n === 'minttokens')
      hasBlacklist = fnNames.some(n => n.includes('blacklist') || n.includes('blocklist') || n === 'addtolist')
      isProxy = fnNames.some(n => n === 'upgradeto' || n === 'implementation' || n === 'upgradetoandcall')
    } catch { /* ABI parse error */ }
  }

  signals.push({
    label: 'Mint Function',
    ok: !hasMint,
    description: hasMint
      ? 'Contract has a mint function — owner can create new tokens'
      : 'No mint function detected',
    severity: hasMint ? 'warn' : 'info',
  })

  signals.push({
    label: 'Blacklist',
    ok: !hasBlacklist,
    description: hasBlacklist
      ? 'Contract can blacklist addresses from transferring'
      : 'No blacklist function detected',
    severity: hasBlacklist ? 'warn' : 'info',
  })

  signals.push({
    label: 'Proxy/Upgradeable',
    ok: !isProxy,
    description: isProxy
      ? 'Contract is upgradeable — logic can be changed after deployment'
      : 'Not a proxy contract',
    severity: isProxy ? 'warn' : 'info',
  })

  // 3. Ownership renounced?
  try {
    const c = new Contract(tokenAddress, OWNER_ABI, getProvider())
    const owner = await (c.owner as () => Promise<string>)()
    const renounced =
      owner === '0x0000000000000000000000000000000000000000' ||
      owner === '0x000000000000000000000000000000000000dEaD'
    signals.push({
      label: 'Ownership Renounced',
      ok: renounced,
      description: renounced
        ? `Ownership renounced (owner = ${owner.slice(0, 12)}...)`
        : `Owner: ${owner.slice(0, 12)}... — ownership not renounced`,
      severity: renounced ? 'info' : 'warn',
    })
  } catch {
    signals.push({
      label: 'Ownership',
      ok: true,
      description: 'No ownable pattern detected (or RPC unavailable)',
      severity: 'info',
    })
  }

  return signals
}
