/**
 * What each /gas tier's price is built from, in words.
 *
 * The page prices Slow at max(base fee, network minimum), then adds 10% and 30%. So the label
 * says "base fee" only while the base fee is what is being priced; once a chain's minimum
 * gas price binds (base fee below it, or no reading at all), the number is the minimum's, and
 * calling it the base fee would put a label on the page that its own "Current Base Fee" card
 * contradicts. `floor` is 0n on a chain with no minimum.
 */
export function gasTierBasis(baseFee: bigint, floor: bigint): { slow: string; standard: string; fast: string } {
  const floored = floor > 0n && baseFee < floor
  const base = floored ? 'network minimum' : 'base fee'
  const short = floored ? 'minimum' : 'base fee'
  return { slow: base, standard: `${short} + 10%`, fast: `${short} + 30%` }
}
