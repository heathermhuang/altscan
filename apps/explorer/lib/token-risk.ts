import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { Contract, isError } from 'ethers'
import { getWebProvider } from '@/lib/rpc'

export type RiskSignal = {
  label: string
  ok: boolean
  description: string
  severity: 'info' | 'warn' | 'danger'
  /** The check could not be made (no verified ABI, or the node did not answer): neither a pass nor a risk. */
  unknown?: true
}

const notChecked = (label: string, description: string): RiskSignal => ({ label, ok: false, unknown: true, description, severity: 'info' })

/**
 * Whether the node ANSWERED that the contract has no owner(): a revert, or an empty return that ethers cannot decode
 * (a contract whose fallback accepts the call). Anything else (a timeout, a dropped connection, a rate limit) says
 * nothing about the contract.
 */
function answeredNoOwner(e: unknown): boolean {
  return isError(e, 'CALL_EXCEPTION') || (isError(e, 'BAD_DATA') && e.value === '0x')
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
    description: contractData?.verifiedAt ? 'Source code is verified and public' : 'No verified source recorded here — check Sourcify',
    severity: contractData?.verifiedAt ? 'info' : 'danger',
  })

  // 2. Has mint function? (potential inflation risk)
  // `contracts` rows exist only after a Sourcify verify, so most tokens have no ABI. Without one the three
  // function checks below were never made: they are "not checked", not passes.
  let hasMint = false
  let hasBlacklist = false
  let isProxy = false
  let abiRead = false
  if (contractData?.abi) {
    try {
      const abi = contractData.abi as { name?: string; type?: string }[]
      const fnNames = abi.filter(f => f.type === 'function').map(f => (f.name ?? '').toLowerCase())
      abiRead = fnNames.length > 0
      hasMint = fnNames.some(n => n === 'mint' || n === 'minttokens')
      hasBlacklist = fnNames.some(n => n.includes('blacklist') || n.includes('blocklist') || n === 'addtolist')
      // Proxy detection: check for upgradeTo, implementation
      isProxy = fnNames.some(n => n === 'upgradeto' || n === 'implementation' || n === 'upgradetoandcall')
    } catch { /* ABI parse error */ }
  }

  const noAbi = 'No verified ABI, so this was not checked'

  signals.push(!abiRead ? notChecked('Mint Function', noAbi) : {
    label: 'Mint Function',
    ok: !hasMint,
    description: hasMint ? 'Contract has a mint function — owner can create new tokens' : 'No mint function detected',
    severity: hasMint ? 'warn' : 'info',
  })

  signals.push(!abiRead ? notChecked('Blacklist', noAbi) : {
    label: 'Blacklist',
    ok: !hasBlacklist,
    description: hasBlacklist ? 'Contract can blacklist addresses from transferring' : 'No blacklist function detected',
    severity: hasBlacklist ? 'warn' : 'info',
  })

  signals.push(!abiRead ? notChecked('Proxy/Upgradeable', noAbi) : {
    label: 'Proxy/Upgradeable',
    ok: !isProxy,
    description: isProxy ? 'Contract is upgradeable — logic can be changed after deployment' : 'Not a proxy contract',
    severity: isProxy ? 'warn' : 'info',
  })

  // 3. Ownership renounced? (call owner() — returns 0x000...000 if renounced)
  try {
    const c = new Contract(tokenAddress, OWNER_ABI, await getWebProvider())
    const owner = await (c.owner as () => Promise<string>)()
    const renounced = owner === '0x0000000000000000000000000000000000000000' || owner === '0x000000000000000000000000000000000000dEaD'
    signals.push({
      label: 'Ownership Renounced',
      ok: renounced,
      description: renounced ? `Ownership renounced (owner = ${owner.slice(0, 12)}...)` : `Owner: ${owner.slice(0, 12)}... — ownership not renounced`,
      severity: renounced ? 'info' : 'warn',
    })
  } catch (e) {
    signals.push(answeredNoOwner(e)
      ? { label: 'Ownership', ok: true, description: 'No ownable pattern detected', severity: 'info' }
      : notChecked('Ownership', 'The node did not answer, so this was not checked'))
  }

  return signals
}
