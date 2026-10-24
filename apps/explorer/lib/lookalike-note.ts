/**
 * The part of lib/lookalike a browser may hold: the shape of a flag and the sentence that explains it. The glyph table
 * and the matching stay in lib/lookalike.ts, which no 'use client' component may reach (client-chain-config.test.ts), so a
 * client component draws a flag the SERVER computed (a `Lookalike` is plain JSON) through this module and nothing else.
 */
export type Lookalike = {
  /** The well-known symbol it reads as, e.g. 'USDT'. */
  symbol: string
  /** That token's primary contract on this chain, or null when it is the chain's native coin. */
  canonical: string | null
}

/** One sentence saying what a flagged token imitates, for the token page and the list badge's tooltip. */
export function lookalikeNote({ symbol, canonical }: Lookalike): string {
  if (!canonical) {
    return `Its symbol or name reads as ${symbol}, which is the chain's native coin and has no token contract. Likely impersonation.`
  }
  return `Its symbol or name reads as ${symbol}, but this is not the ${symbol} contract (${canonical.slice(0, 6)}…${canonical.slice(-4)}). Likely impersonation.`
}
