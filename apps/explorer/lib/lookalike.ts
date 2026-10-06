/**
 * Lookalike tokens: airdrop spam whose symbol or name reads as a well-known token
 * (`U5D` plus Cyrillic U+0422, `USD` plus Greek U+03A4, fullwidth Latin from U+FF21) but whose
 * contract is not that token's. They rank high on /token by holder count and pass for
 * USDT at a glance, so the explorer LABELS them. Nothing is hidden, deleted or re-ranked.
 *
 * Pure on purpose: no DB or RPC import (the only import is a type, erased at build), so it
 * is cheap to call once per row in a list. The chain is a PARAMETER, never read from env
 * here — pass `chainConfig.key` from the server-side '@/lib/chain'.
 */
import type { ChainKey } from '@altscan/chain-config'

type WellKnown = {
  symbol: string
  /** The on-chain name() of the canonical contract. */
  name: string
  /** Canonical contract, or null for the chain's native coin (it has no contract). */
  address: string | null
}

// Canonical contracts: on-chain symbol() and name() read via eth_call on 2026-10-06 against
// bsc-dataseed1.binance.org (BNB) and eth.drpc.org (Ethereum); every address returned the symbol
// and name below. Check any address on its explorer token page before changing it:
//   https://bscscan.com/token/<address>    https://etherscan.io/token/<address>
// The native coins (BNB on BNB Chain, ETH on Ethereum) have no contract, so ANY token claiming
// one is a lookalike. Do not add an entry from memory: an address nobody verified is a wrong label.
export const WELL_KNOWN: Record<ChainKey, readonly WellKnown[]> = {
  bnb: [
    { symbol: 'USDT', name: 'Tether USD', address: '0x55d398326f99059fF775485246999027B3197955' },
    { symbol: 'USDC', name: 'USD Coin', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
    { symbol: 'BUSD', name: 'BUSD Token', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' },
    { symbol: 'DAI', name: 'Dai Token', address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3' },
    { symbol: 'WBNB', name: 'Wrapped BNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' },
    { symbol: 'ETH', name: 'Ethereum Token', address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8' },
    { symbol: 'BTCB', name: 'BTCB Token', address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c' },
    { symbol: 'BNB', name: 'BNB', address: null },
  ],
  eth: [
    { symbol: 'USDT', name: 'Tether USD', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
    { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
    { symbol: 'WBTC', name: 'Wrapped BTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
    { symbol: 'BUSD', name: 'BUSD', address: '0x4Fabb145d64652a948d72533023f6E7A623C7C53' },
    { symbol: 'BNB', name: 'BNB', address: '0xB8c77482e45F1F44dE1745F52C74426C631bDD52' },
    { symbol: 'ETH', name: 'Ether', address: null },
  ],
}

// Cyrillic and Greek letters that render like a Latin one, keyed by code point. Explicit \u escapes:
// these glyphs are visually identical to ASCII, so a literal character here would be unreadable in
// review. Each comment lists the Latin letters its row stands in for.
const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic capitals, looking like: A B C E H I J K M O P S T X Y
  '\u0410': 'A', '\u0412': 'B', '\u0421': 'C', '\u0415': 'E', '\u041D': 'H', '\u0406': 'I',
  '\u0408': 'J', '\u041A': 'K', '\u041C': 'M', '\u041E': 'O', '\u0420': 'P', '\u0405': 'S',
  '\u0422': 'T', '\u0425': 'X', '\u0423': 'Y',
  // Cyrillic lowercase, looking like: a c e i j o p s x y
  '\u0430': 'a', '\u0441': 'c', '\u0435': 'e', '\u0456': 'i', '\u0458': 'j', '\u043E': 'o',
  '\u0440': 'p', '\u0455': 's', '\u0445': 'x', '\u0443': 'y',
  // Greek capitals, looking like: A B E Z H I K M N O P T Y X
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I',
  '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T',
  '\u03A5': 'Y', '\u03A7': 'X',
  // Greek lowercase, looking like: o v
  '\u03BF': 'o', '\u03BD': 'v',
}

/**
 * What a symbol or name LOOKS like, as plain uppercase ASCII, so lookalikes compare equal.
 * NFKC first (fullwidth to ASCII), then drop invisible format characters (zero-width joiners,
 * bidi marks) and whitespace, then fold Cyrillic/Greek homoglyphs, then the digit/letter swaps
 * that read alike in a sans font: l | 1 to I, 0 to O, 5 to S.
 */
export function foldConfusables(s: string): string {
  let out = ''
  for (const ch of s.normalize('NFKC').replace(/[\p{Cf}\s]/gu, '')) out += HOMOGLYPHS[ch] ?? ch
  return out.replace(/[l|1]/g, 'I').replace(/0/g, 'O').replace(/5/g, 'S').toUpperCase()
}

// Folded once at load: a list page calls lookalikeOf per row.
type Folded = WellKnown & { foldedSymbol: string; foldedName: string }
const FOLDED = Object.fromEntries(
  Object.entries(WELL_KNOWN).map(([chain, list]) => [
    chain,
    list.map((w) => ({ ...w, foldedSymbol: foldConfusables(w.symbol), foldedName: foldConfusables(w.name) })),
  ]),
) as Record<ChainKey, Folded[]>

export type Lookalike = {
  /** The well-known symbol it reads as, e.g. 'USDT'. */
  symbol: string
  /** That token's contract on this chain, or null when it is the chain's native coin. */
  canonical: string | null
}

/**
 * The well-known token this one impersonates, else null. A token matches when its folded
 * symbol equals a well-known symbol, or its folded name equals that token's canonical name,
 * AND it is not the canonical contract. Address compare ignores case.
 */
export function lookalikeOf(
  token: { address: string; symbol?: string | null; name?: string | null },
  chain: ChainKey,
): Lookalike | null {
  const symbol = token.symbol ? foldConfusables(token.symbol) : ''
  const name = token.name ? foldConfusables(token.name) : ''
  if (!symbol && !name) return null
  const address = token.address.toLowerCase()
  for (const w of FOLDED[chain]) {
    if (!(symbol === w.foldedSymbol || name === w.foldedName)) continue
    if (w.address && w.address.toLowerCase() === address) return null
    return { symbol: w.symbol, canonical: w.address }
  }
  return null
}

/** One sentence saying what a flagged token imitates, for the token page and the list badge's tooltip. */
export function lookalikeNote({ symbol, canonical }: Lookalike): string {
  if (!canonical) {
    return `Its symbol or name reads as ${symbol}, which is the chain's native coin and has no token contract. Likely impersonation.`
  }
  return `Its symbol or name reads as ${symbol}, but this is not the ${symbol} contract (${canonical.slice(0, 6)}…${canonical.slice(-4)}). Likely impersonation.`
}
