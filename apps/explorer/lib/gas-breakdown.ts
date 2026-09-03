/**
 * EIP-1559 fee split: how much of a transaction fee was burnt, and how much
 * went to the validator.
 *
 * The tx page labels transactions "EIP-1559 (Dynamic Fee)" and then showed a
 * single gas price and nothing else — naming the mechanism while omitting its
 * entire content. Etherscan breaks this out under "More Details".
 *
 * No schema change is needed: blocks.base_fee_per_gas is already stored, and
 *   burnt = gasUsed x baseFeePerGas
 *   tip   = gasUsed x (effectiveGasPrice - baseFeePerGas)
 * sum exactly to the fee the page already displays.
 */
import { safeBigInt } from './format'

export type GasBreakdown = {
  /** gasUsed x effectiveGasPrice — the fee shown at the top of the page. */
  total: bigint
  /** Destroyed by the protocol. */
  burnt: bigint
  /** Paid to the block proposer. */
  priorityTip: bigint
  baseFeePerGas: bigint
  effectiveGasPrice: bigint
}

export function computeGasBreakdown(
  gasUsed: bigint | string,
  effectiveGasPrice: bigint | string,
  baseFeePerGas: bigint | string | null | undefined,
): GasBreakdown | null {
  // A null base fee means a pre-EIP-1559 chain/block, or a row we never
  // backfilled. Substituting 0 would report the whole fee as validator tip and
  // nothing burnt — a confident wrong answer. Show nothing instead.
  if (baseFeePerGas == null || baseFeePerGas === '') return null

  const gas = safeBigInt(gasUsed)
  const price = safeBigInt(effectiveGasPrice)
  const base = safeBigInt(baseFeePerGas)
  if (gas <= 0n) return null

  // Defensive: a malformed row must not render a negative tip.
  const effectiveBase = base > price ? price : base
  const burnt = gas * effectiveBase
  const total = gas * price

  return {
    total,
    burnt,
    priorityTip: total - burnt,
    baseFeePerGas: base,
    effectiveGasPrice: price,
  }
}
