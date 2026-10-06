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

// Cyrillic, Greek and Lisu letters that render like a Latin one: code point to the uppercase Latin
// letter. Explicit \u escapes, because these glyphs are visually identical to ASCII and a literal
// character here would be unreadable in review. GENERATED, not hand-written: from Unicode's
// confusables.txt (UTS #39 Version 18.0.0, dated 2026-08-06,
// https://www.unicode.org/Public/security/latest/confusables.txt), taking every entry whose source is in
// U+0370..03FF, U+0400..04FF or U+A4D0..A4FF and whose prototype is a single Latin letter, uppercased
// (the table spells a capital I as `l`, and the fold reads l as I). To refresh, redo that selection and
// replace this block; there is no runtime fetch.
export const HOMOGLYPHS: Record<string, string> = {
  // Greek and Coptic, U+0370..03FF (32)
  '\u037F': 'J', '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
  '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P',
  '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X', '\u03B1': 'A', '\u03B3': 'Y', '\u03B9': 'I',
  '\u03BD': 'V', '\u03BF': 'O', '\u03C1': 'P', '\u03C3': 'O', '\u03C5': 'U', '\u03D2': 'Y',
  '\u03DC': 'F', '\u03ED': 'O', '\u03F1': 'P', '\u03F2': 'C', '\u03F3': 'J', '\u03F8': 'P',
  '\u03F9': 'C', '\u03FA': 'M',
  // Cyrillic, U+0400..04FF (38)
  '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u0410': 'A', '\u0412': 'B', '\u0415': 'E',
  '\u041A': 'K', '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C',
  '\u0422': 'T', '\u0423': 'Y', '\u0425': 'X', '\u042C': 'B', '\u0430': 'A', '\u0433': 'R',
  '\u0435': 'E', '\u043E': 'O', '\u0440': 'P', '\u0441': 'C', '\u0443': 'Y', '\u0445': 'X',
  '\u0448': 'W', '\u0455': 'S', '\u0456': 'I', '\u0458': 'J', '\u0461': 'W', '\u0474': 'V',
  '\u0475': 'V', '\u04AE': 'Y', '\u04AF': 'Y', '\u04BA': 'H', '\u04BB': 'H', '\u04BD': 'E',
  '\u04C0': 'I', '\u04CF': 'I',
  // Lisu, U+A4D0..A4FF (26)
  '\uA4D0': 'B', '\uA4D1': 'P', '\uA4D2': 'D', '\uA4D3': 'D', '\uA4D4': 'T', '\uA4D6': 'G',
  '\uA4D7': 'K', '\uA4D9': 'J', '\uA4DA': 'C', '\uA4DC': 'Z', '\uA4DD': 'F', '\uA4DF': 'M',
  '\uA4E0': 'N', '\uA4E1': 'L', '\uA4E2': 'S', '\uA4E3': 'R', '\uA4E6': 'V', '\uA4E7': 'H',
  '\uA4EA': 'W', '\uA4EB': 'X', '\uA4EC': 'Y', '\uA4EE': 'A', '\uA4F0': 'E', '\uA4F2': 'I',
  '\uA4F3': 'O', '\uA4F4': 'U',
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
 * The glyph table first, on the raw text: NFKD would turn the lunate sigmas (U+03F2 and U+03F9, which read as C)
 * into ordinary sigmas before the table saw them. Then NFKD (fullwidth to ASCII, accented letters
 * split into base + combining mark), then drop everything invisible, then the table again for what
 * NFKD exposed, then the digit/letter swaps that read alike in a sans font: l | 1 to I, 0 to O,
 * 5 to S. The table runs a last time after toUpperCase: a lowercase letter that is not in the
 * table but whose UPPERCASE is (Cyrillic te, Greek tau) only becomes one there, and would
 * otherwise slip through as a non-ASCII T.
 */
export function foldConfusables(s: string): string {
  const visible = mapGlyphs(mapGlyphs(s).normalize('NFKD').replace(INVISIBLE, ''))
  return mapGlyphs(visible.replace(/[l|1]/g, 'I').replace(/0/g, 'O').replace(/5/g, 'S').toUpperCase())
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
