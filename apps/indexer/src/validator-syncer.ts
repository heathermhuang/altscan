import { Contract, formatEther } from 'ethers'
import { getDb, schema } from './db'
import { getProvider } from './provider'

const provider = getProvider()

// BSC ValidatorSet contract — returns current active validators
const VALIDATOR_SET_ADDRESS = '0x0000000000000000000000000000000000001000'
const VALIDATOR_SET_ABI = [
  'function getValidators() view returns (address[])',
  'function currentValidatorSetMap(address) view returns (uint256)',
]

// BSC StakeHub contract (BEP-294 / Fusion)
const STAKE_HUB_ADDRESS = '0x0000000000000000000000000000000000002002'
const STAKE_HUB_ABI = [
  'function getValidatorElectionInfo(uint256 offset, uint256 limit) view returns (address[] consensusAddrs, uint256[] votingPowers, bytes[] voteAddrs, uint256 totalLength)',
  'function getValidatorDescription(address operatorAddress) view returns (string moniker, string identity, string website, string details)',
  'function getValidatorCommission(address operatorAddress) view returns (uint64 rate, uint64 maxRate, uint64 maxChangeRate)',
]

// Known validator names as fallback (top BSC validators by consensus address)
const KNOWN_VALIDATORS: Record<string, string> = {
  '0x2465176c461afb316ebc773c61faee85a6515daa': 'BNB48 Club',
  '0x295e26495cef6f69dfa69911d9d8e4f3bbadb89b': 'Legend',
  '0x72b61c6014342d914470ec7ac2975be345796c2b': 'Defibit',
  '0x9f8ccdafcc39f3c7d6ebf637c9151673cbc36b88': 'Ankr',
  '0x35ead5abe76b0c3a9b0e4d0ca82d27d2c2e2086d': 'NodeReal',
  '0x8b6c8fd93d6f4cea42bbb345dbc6f0dfdb5bec73': 'InfStones',
  '0x2d4c407bbe49438ed859fe965b140dcf1aab71a9': 'MathWallet',
  '0xe9ae3261a475a27bb1028f140bc2a7c843318afd': 'Certik',
  '0xee226379db83cffc681495730c11fdde79ba4c0c': 'Avenger',
  '0xef0274e31810c9df02f98fafde0f841f4e66a1cd': 'TW Staking',
  '0xbe807dddb074639cd9fa61b47676c064fc50d62c': 'Legend II',
  '0x3f349bbafec1551819b8be1efea2fc46ca749aa1': 'BNB48 Club II',
  '0x685b1ded8013785d6623cc18d214320b6bb64759': 'Seoraksan',
  '0x70f657164e5b75689b64b7fd1fa275f334f28e18': 'Fuji',
  '0x4396e28197653d0c244d95f8c1e57da902a72b4e': 'BSCLotto',
}

/**
 * Try StakeHub first (has voting power), fall back to ValidatorSet (active list only)
 */
export async function syncValidators(): Promise<void> {
  const db = getDb()

  // Attempt 1: StakeHub with election info (has voting power data)
  try {
    const stakeHub = new Contract(STAKE_HUB_ADDRESS, STAKE_HUB_ABI, provider)
    const result = await stakeHub.getValidatorElectionInfo(0, 100)
    const validators: string[] = Array.from(result[0])
    const votingPowers: bigint[] = Array.from(result[1])

    if (validators.length > 0) {
      await upsertValidators(db, stakeHub, validators, votingPowers)
      return
    }
    console.warn('[validator-syncer] StakeHub returned 0 validators, falling back to ValidatorSet')
  } catch (err) {
    console.warn('[validator-syncer] StakeHub failed, falling back to ValidatorSet:', err instanceof Error ? err.message : err)
  }

  // Attempt 2: ValidatorSet contract (simpler, always works)
  try {
    const validatorSet = new Contract(VALIDATOR_SET_ADDRESS, VALIDATOR_SET_ABI, provider)
    const validators: string[] = Array.from(await validatorSet.getValidators())

    if (validators.length === 0) {
      console.warn('[validator-syncer] ValidatorSet returned 0 validators')
      return
    }

    // No voting power from this contract — use equal weight
    const equalPower = Array(validators.length).fill(0n) as bigint[]
    await upsertValidators(db, null, validators, equalPower)
  } catch (err) {
    console.error('[validator-syncer] Both methods failed:', err instanceof Error ? err.message : err)
  }
}

async function upsertValidators(
  db: ReturnType<typeof getDb>,
  stakeHub: Contract | null,
  validators: string[],
  votingPowers: bigint[],
): Promise<void> {
  const totalPower = votingPowers.reduce((sum, vp) => sum + vp, 0n)
  const now = new Date()

  for (let i = 0; i < validators.length; i++) {
    const addr = validators[i].toLowerCase()
    const vp = votingPowers[i] ?? 0n

    // Try to get on-chain moniker, fall back to known list
    let moniker = KNOWN_VALIDATORS[addr] ?? `Validator ${i + 1}`
    let commission = '0.1' // default 10%

    if (stakeHub) {
      try {
        const desc = await stakeHub.getValidatorDescription(addr)
        if (desc.moniker && desc.moniker.length > 0) moniker = desc.moniker
      } catch { /* description not available */ }

      try {
        const comm = await stakeHub.getValidatorCommission(addr)
        commission = (Number(comm.rate) / 1e18).toFixed(4)
      } catch { /* commission not available */ }
    }

    const vpPct = totalPower > 0n ? Number((vp * 10000n) / totalPower) / 100 : 0

    try {
      await db.insert(schema.validators).values({
        address: addr,
        moniker,
        votingPower: vp.toString(),
        commission,
        uptime: '0.99',
        status: 'active',
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [schema.validators.address],
        set: {
          moniker,
          votingPower: vp.toString(),
          commission,
          status: 'active',
          updatedAt: now,
        },
      })
    } catch (err) {
      console.warn('[validator-syncer] Failed to upsert validator:', addr, err instanceof Error ? err.message : err)
    }
  }

  console.log(`[validator-syncer] Synced ${validators.length} validators${totalPower > 0n ? ` (total voting power: ${formatEther(totalPower)} BNB)` : ''}`)
}
