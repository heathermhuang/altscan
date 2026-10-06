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
  /** Other symbols and names a copy passes under: the label the explorer itself shows for the real token. */
  symbols?: readonly string[]
  names?: readonly string[]
}

// Canonical contracts: on-chain symbol() and name() read via eth_call on 2026-10-06 against
// bsc-dataseed1.binance.org (BNB) and eth.drpc.org (Ethereum); every address returned the symbol
// and name below. Check any address on its explorer token page before changing it:
//   https://bscscan.com/token/<address>    https://etherscan.io/token/<address>
// The native coins (BNB on BNB Chain, ETH on Ethereum) have no contract, so ANY token claiming
// one is a lookalike. Do not add an entry from memory: an address nobody verified is a wrong label.
//
// BNB Chain aliases: BscScan shows a Binance-Peg token as "Binance-Peg <name>" and the real USDT as
// "Binance-Peg BSC-USD (BSC-USD)", and spam copies the label it sees there (a 22k-holder
// "Binance-Peg BSC-USD" / "BSC-USD" token did, in the 2026-10 tokens table). So every BNB Chain
// contract also answers to "Binance-Peg <its on-chain name>", and USDT to BSC-USD. The BSC-USD label
// is read off production data; the "Binance-Peg <name>" form is that convention applied to each
// token, and WBNB's is by the same rule rather than a label seen on BscScan.
export const WELL_KNOWN: Record<ChainKey, readonly WellKnown[]> = {
  bnb: [
    {
      symbol: 'USDT', name: 'Tether USD', address: '0x55d398326f99059fF775485246999027B3197955',
      symbols: ['BSC-USD'], names: ['Binance-Peg BSC-USD', 'Binance-Peg Tether USD'],
    },
    { symbol: 'USDC', name: 'USD Coin', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', names: ['Binance-Peg USD Coin'] },
    { symbol: 'BUSD', name: 'BUSD Token', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', names: ['Binance-Peg BUSD Token'] },
    { symbol: 'DAI', name: 'Dai Token', address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', names: ['Binance-Peg Dai Token'] },
    { symbol: 'WBNB', name: 'Wrapped BNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', names: ['Binance-Peg Wrapped BNB'] },
    { symbol: 'ETH', name: 'Ethereum Token', address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', names: ['Binance-Peg Ethereum Token'] },
    { symbol: 'BTCB', name: 'BTCB Token', address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', names: ['Binance-Peg BTCB Token'] },
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
  // Cyrillic capitals, looking like: A B C E H I J K M O P S T X Y (the last I is the palochka)
  '\u0410': 'A', '\u0412': 'B', '\u0421': 'C', '\u0415': 'E', '\u041D': 'H', '\u0406': 'I',
  '\u0408': 'J', '\u041A': 'K', '\u041C': 'M', '\u041E': 'O', '\u0420': 'P', '\u0405': 'S',
  '\u0422': 'T', '\u0425': 'X', '\u0423': 'Y', '\u04C0': 'I',
  // Cyrillic lowercase, looking like: a c e i j o p s x y (and I, the lowercase palochka)
  '\u0430': 'a', '\u0441': 'c', '\u0435': 'e', '\u0456': 'i', '\u0458': 'j', '\u043E': 'o',
  '\u0440': 'p', '\u0455': 's', '\u0445': 'x', '\u0443': 'y', '\u04CF': 'I',
  // Greek capitals, looking like: A B E Z H I K M N O P T Y X
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I',
  '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T',
  '\u03A5': 'Y', '\u03A7': 'X',
  // Greek lowercase, looking like: o v
  '\u03BF': 'o', '\u03BD': 'v',
}

// Combining marks, format characters (zero-width joiners, bidi marks), whitespace, and the blank
// "filler" letters that render as nothing: Hangul fillers U+115F U+1160 U+3164 U+FFA0, braille blank U+2800.
const INVISIBLE = /[\p{M}\p{Cf}\s\u115F\u1160\u3164\uFFA0\u2800]/gu

function mapGlyphs(s: string): string {
  let out = ''
  for (const ch of s) out += HOMOGLYPHS[ch] ?? ch
  return out
}

/**
 * What a symbol or name LOOKS like, as plain uppercase ASCII, so lookalikes compare equal.
 * NFKD first (fullwidth to ASCII, and accented letters split into base + combining mark), then
 * drop everything invisible, then fold Cyrillic/Greek homoglyphs, then the digit/letter swaps that
 * read alike in a sans font: l | 1 to I, 0 to O, 5 to S. The glyph fold runs again after
 * toUpperCase: a lowercase letter whose UPPERCASE is the mapped one (Cyrillic te, Greek iota) only
 * becomes one there, and would otherwise slip through as a non-ASCII T or I.
 */
export function foldConfusables(s: string): string {
  const visible = s.normalize('NFKD').replace(INVISIBLE, '')
  return mapGlyphs(mapGlyphs(visible).replace(/[l|1]/g, 'I').replace(/0/g, 'O').replace(/5/g, 'S').toUpperCase())
}

// Folded once at load: a list page calls lookalikeOf per row.
type Folded = WellKnown & { foldedSymbols: string[]; foldedNames: string[] }
const FOLDED = Object.fromEntries(
  Object.entries(WELL_KNOWN).map(([chain, list]) => [
    chain,
    list.map((w) => ({
      ...w,
      foldedSymbols: [w.symbol, ...(w.symbols ?? [])].map(foldConfusables),
      foldedNames: [w.name, ...(w.names ?? [])].map(foldConfusables),
    })),
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
 * symbol equals a well-known symbol, or its folded name equals that token's canonical name
 * (either also counting the token's aliases), AND it is not the canonical contract. Address
 * compare ignores case.
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
    if (!(w.foldedSymbols.includes(symbol) || w.foldedNames.includes(name))) continue
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
