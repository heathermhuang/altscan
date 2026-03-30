import { Contract, formatEther } from 'ethers'
import { getDb, schema } from './db'
import { getProvider } from './provider'

const provider = getProvider()

// BSC StakeHub contract (BEP-294)
const STAKING_ADDRESS = '0x0000000000000000000000000000000000002001'
const STAKING_ABI = [
  'function getValidatorElectionInfo(uint256 offset, uint256 limit) view returns (address[] consensusAddrs, uint256[] votingPowers, bytes[] voteAddrs, uint256 totalLength)',
  'function getValidatorBasicInfo(address operatorAddress) view returns (address consensusAddress, address operatorAddress, address creditContract, uint256 createdTime, bool jailed, uint8 incomingFromBreathe)',
  'function getValidatorDescription(address operatorAddress) view returns (string moniker, string identity, string website, string details)',
  'function getValidatorCommission(address operatorAddress) view returns (uint64 rate, uint64 maxRate, uint64 maxChangeRate)',
]

// Known validator names as fallback (top BSC validators)
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
}

export async function syncValidators(): Promise<void> {
  const db = getDb()

  try {
    const staking = new Contract(STAKING_ADDRESS, STAKING_ABI, provider)
    // Fetch up to 100 validators — BSC has ~40 active validators
    const result = await staking.getValidatorElectionInfo(0, 100)
    const validators: string[] = Array.from(result[0])
    const votingPowers: bigint[] = Array.from(result[1])

    // Calculate total voting power for percentage
    const totalPower = votingPowers.reduce((sum, vp) => sum + vp, 0n)

    const now = new Date()

    for (let i = 0; i < validators.length; i++) {
      const addr = validators[i]
      const vp = votingPowers[i] ?? 0n

      try {
        const info = await staking.getValidatorBasicInfo(addr)

        // Try to get on-chain moniker, fall back to known list, then truncated address
        let moniker = KNOWN_VALIDATORS[addr.toLowerCase()] ?? `${addr.slice(0, 8)}...${addr.slice(-4)}`
        let commission = '0.1' // default 10%
        try {
          const desc = await staking.getValidatorDescription(addr)
          if (desc.moniker && desc.moniker.length > 0) moniker = desc.moniker
        } catch { /* description not available for all validators */ }

        try {
          const comm = await staking.getValidatorCommission(addr)
          // Commission rate is in basis points (1e18 = 100%)
          commission = (Number(comm.rate) / 1e18).toFixed(4)
        } catch { /* commission not available */ }

        // Voting power as percentage of total
        const vpPct = totalPower > 0n ? Number((vp * 10000n) / totalPower) / 100 : 0

        await db.insert(schema.validators).values({
          address: addr.toLowerCase(),
          moniker,
          votingPower: vp.toString(),
          commission,
          uptime: '0.99', // BSC doesn't expose uptime on-chain — keep as estimate
          status: info.jailed ? 'jailed' : 'active',
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [schema.validators.address],
          set: {
            moniker,
            votingPower: vp.toString(),
            commission,
            status: info.jailed ? 'jailed' : 'active',
            updatedAt: now,
          },
        })
      } catch (err) {
        console.warn('[validator-syncer] Failed to sync validator:', addr, err instanceof Error ? err.message : err)
      }
    }

    console.log(`[validator-syncer] Synced ${validators.length} validators (total voting power: ${formatEther(totalPower)} BNB)`)
  } catch (err) {
    console.error('[validator-syncer] Error syncing validators:', err)
  }
}
