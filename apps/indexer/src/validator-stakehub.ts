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
