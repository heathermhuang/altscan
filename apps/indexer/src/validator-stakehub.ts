/**
 * BSC StakeHub (BEP-294 / Fusion) contract surface used by the validator syncer.
 *
 * Kept in its own module so the ABI and the commission conversion can be tested
 * directly. Importing `validator-syncer` would construct the RPC provider and the
 * DB handle at module load, and a test that re-declared these values instead of
 * importing them would drift from what actually ships.
 */

export const STAKE_HUB_ADDRESS = '0x0000000000000000000000000000000000002002'

export const STAKE_HUB_ABI = [
  'function getValidatorElectionInfo(uint256 offset, uint256 limit) view returns (address[] consensusAddrs, uint256[] votingPowers, bytes[] voteAddrs, uint256 totalLength)',
  // Description is a struct. Declaring it as four flat strings decodes as
  // BAD_DATA, because a dynamic struct sits behind an extra offset word.
  'function getValidatorDescription(address operatorAddress) view returns (tuple(string moniker, string identity, string website, string details))',
  // Commission is also a struct on chain, but every field is static, so a
  // flattened tuple is byte-identical. Left flat; `comm.rate` keeps working.
  'function getValidatorCommission(address operatorAddress) view returns (uint64 rate, uint64 maxRate, uint64 maxChangeRate)',
  'function getValidatorConsensusKeyByOperator(address operatorAddress) view returns (address consensusAddr)',
  // Public mapping. `getOperatorAddressByConsensusAddress` was never a real
  // selector — it reverts with no data for every validator.
  'function consensusToOperator(address consensusAddr) view returns (address operatorAddr)',
]

/**
 * StakeHub expresses commission in hundredths of a percent (10000 == 100%).
 * `validators.commission` is `numeric(5,4)` and the UI multiplies by 100, so the
 * stored value is a fraction: rate 900 -> "0.0900" -> "9.0%".
 */
export const COMMISSION_BASE = 10_000

export function toCommissionFraction(rate: bigint): string {
  return (Number(rate) / COMMISSION_BASE).toFixed(4)
}

/**
 * One validator's upsert, decided from what the chain actually answered.
 *
 * A read that failed is UNKNOWN, not a default: the syncer used to store commission
 * '0.1' (rendered "10.0%") for it and replace a good stored moniker with a generated
 * `Validator N`, both on every run where a single RPC call hiccuped. So an unread
 * commission is NULL, and `update` (the ON CONFLICT SET) omits any column whose read
 * failed, leaving the last good stored value alone. `values` still carries a moniker
 * for the first INSERT, where a placeholder beats a NOT NULL error.
 */
export type ValidatorWrite = {
  values: { address: string; moniker: string; votingPower: string; commission: string | null; status: 'active'; updatedAt: Date }
  update: { votingPower: string; status: 'active'; updatedAt: Date; moniker?: string; commission?: string }
}

export function buildValidatorWrite(input: {
  address: string
  /** What to insert when the chain gave no moniker: the known-validator name or `Validator N`. */
  fallbackMoniker: string
  /** The on-chain description's moniker, or null when the read failed or it was empty. */
  chainMoniker: string | null
  /** The on-chain commission rate, or null when the read failed. */
  commissionRate: bigint | null
  votingPower: bigint
  now: Date
}): ValidatorWrite {
  const moniker = input.chainMoniker && input.chainMoniker.length > 0 ? input.chainMoniker : null
  const commission = input.commissionRate === null ? null : toCommissionFraction(input.commissionRate)
  const votingPower = input.votingPower.toString()
  return {
    values: { address: input.address, moniker: moniker ?? input.fallbackMoniker, votingPower, commission, status: 'active', updatedAt: input.now },
    update: {
      votingPower,
      status: 'active',
      updatedAt: input.now,
      ...(moniker !== null ? { moniker } : {}),
      ...(commission !== null ? { commission } : {}),
    },
  }
}
