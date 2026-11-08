/**
 * Unicode's directional controls: the Arabic letter mark, LRM/RLM, the embeddings and overrides (LRE, RLE, PDF, LRO,
 * RLO) and the isolates (LRI, RLI, FSI, PDI). A deployer types them into a token's name or symbol to make it DRAW as
 * other text: U+202E + "TDSU" + U+202C renders as "USDT". Every place that prints that text as given strips them, so it
 * draws in the order it is stored, and wraps it in <bdi> so a right-to-left name cannot reorder the text around it.
 *
 * Only these are stripped. Other invisible characters do not reorder anything, and some (joiners, variation
 * selectors) are needed by real scripts. No imports: client chunks that print token text (the search dropdown, the
 * NFT cards) use this without pulling in lib/format's ethers dependency.
 */
const DIRECTIONAL_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

export function hasDirectionalControls(text: string | null | undefined): boolean {
  return !!text && text.replace(DIRECTIONAL_CONTROLS, '') !== text
}

export function stripDirectionalControls(text: string): string {
  return text.replace(DIRECTIONAL_CONTROLS, '')
}
