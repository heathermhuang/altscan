/**
 * What each /gas tier's price is built from, in words.
 *
 * The page prices Slow at max(gas price, network minimum), then adds 10% and 30%, where "gas
 * price" is the RPC's `eth_gasPrice` — which already includes the priority tip, so it is NOT the
 * base fee on an EIP-1559 chain. So the label says "gas price" while that reading is what is
 * being priced; once a chain's minimum binds (reading below it, or no reading at all), the
 * number is the minimum's. `floor` is 0n on a chain with no minimum.
 */
export function gasTierBasis(gasPrice: bigint, floor: bigint): { slow: string; standard: string; fast: string } {
  const floored = floor > 0n && gasPrice < floor
  const base = floored ? 'network minimum' : 'gas price'
  const short = floored ? 'minimum' : 'gas price'
  return { slow: base, standard: `${short} + 10%`, fast: `${short} + 30%` }
}

/**
 * Which number the /gas headline card shows, and what it is honestly called.
 *
 * It is "Base Fee" only when the latest block carries a positive `baseFeePerGas`. BNB's is 0 and
 * a pre-1559 or unreadable block has none, so those fall back to the RPC gas price — labelled
 * "Gas Price", never "Base Fee", because `eth_gasPrice` includes the tip.
 */
export function feeCard(
  baseFeePerGas: bigint | null | undefined,
  gasPrice: bigint,
): { label: 'Base Fee' | 'Gas Price'; value: bigint } {
  return baseFeePerGas != null && baseFeePerGas > 0n
    ? { label: 'Base Fee', value: baseFeePerGas }
    : { label: 'Gas Price', value: gasPrice }
}
