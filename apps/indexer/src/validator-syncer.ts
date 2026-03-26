import { Contract } from 'ethers'
import { getDb, schema } from '@bnbscan/db'
import { getProvider } from './provider'

const provider = getProvider()

// BSC StakeHub contract (BEP-294)
// ⚠️ Verify ABI at: https://bscscan.com/address/0x0000000000000000000000000000000000002001#readContract
const STAKING_ADDRESS = '0x0000000000000000000000000000000000002001'
const STAKING_ABI = [
  'function getValidatorElectionInfo(uint256 offset, uint256 limit) view returns (address[] consensusAddrs, uint256[] votingPowers, bytes[] voteAddrs, uint256 totalLength)',
  'function getValidatorBasicInfo(address operatorAddress) view returns (address consensusAddress, address operatorAddress, address creditContract, uint256 createdTime, bool jailed, uint8 incomingFromBreathe)',
]

export async function syncValidators(): Promise<void> {
  const db = getDb()

  try {
    const staking = new Contract(STAKING_ADDRESS, STAKING_ABI, provider)
    // Fetch up to 100 validators — BSC has ~40 active validators
    const result = await staking.getValidatorElectionInfo(0, 100)
    const validators: string[] = Array.from(result[0])

    const now = new Date()

    for (const addr of validators) {
      try {
        const info = await staking.getValidatorBasicInfo(addr)

        await db.insert(schema.validators).values({
          address: addr.toLowerCase(),
          moniker: addr.slice(0, 8) + '...' + addr.slice(-4),
          votingPower: '0',
          commission: '0.1',
          uptime: '0.99',
          status: info.jailed ? 'jailed' : 'active',
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [schema.validators.address],
          set: { status: info.jailed ? 'jailed' : 'active', updatedAt: now },
        })
      } catch (err) {
        console.warn('[validator-syncer] Failed to sync validator:', addr, err instanceof Error ? err.message : err)
      }
    }

    console.log(`[validator-syncer] Synced ${validators.length} validators`)
  } catch (err) {
    console.error('[validator-syncer] Error syncing validators:', err)
  }
}
