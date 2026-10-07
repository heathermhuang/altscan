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
  /**
   * Every contract that IS this token on the chain, the primary one first; empty for the chain's
   * native coin (it has no contract). More than one when the issuer runs several real deployments.
   */
  addresses: readonly string[]
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
// `addresses` takes every real deployment of a token, and each entry below has the one that was
// verified. Add a second only after reading it on chain AND finding it in the issuer's own docs or
// on the explorer's token page: an unlisted real deployment is flagged as a lookalike of itself.
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
      symbol: 'USDT', name: 'Tether USD', addresses: ['0x55d398326f99059fF775485246999027B3197955'],
      symbols: ['BSC-USD'], names: ['Binance-Peg BSC-USD', 'Binance-Peg Tether USD'],
    },
    { symbol: 'USDC', name: 'USD Coin', addresses: ['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'], names: ['Binance-Peg USD Coin'] },
    { symbol: 'BUSD', name: 'BUSD Token', addresses: ['0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'], names: ['Binance-Peg BUSD Token'] },
    { symbol: 'DAI', name: 'Dai Token', addresses: ['0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3'], names: ['Binance-Peg Dai Token'] },
    { symbol: 'WBNB', name: 'Wrapped BNB', addresses: ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'], names: ['Binance-Peg Wrapped BNB'] },
    { symbol: 'ETH', name: 'Ethereum Token', addresses: ['0x2170Ed0880ac9A755fd29B2688956BD959F933F8'], names: ['Binance-Peg Ethereum Token'] },
    { symbol: 'BTCB', name: 'BTCB Token', addresses: ['0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c'], names: ['Binance-Peg BTCB Token'] },
    { symbol: 'BNB', name: 'BNB', addresses: [] },
  ],
  eth: [
    { symbol: 'USDT', name: 'Tether USD', addresses: ['0xdAC17F958D2ee523a2206206994597C13D831ec7'] },
    { symbol: 'USDC', name: 'USD Coin', addresses: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'] },
    { symbol: 'DAI', name: 'Dai Stablecoin', addresses: ['0x6B175474E89094C44Da98b954EedeAC495271d0F'] },
    { symbol: 'WETH', name: 'Wrapped Ether', addresses: ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'] },
    { symbol: 'WBTC', name: 'Wrapped BTC', addresses: ['0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'] },
    { symbol: 'BUSD', name: 'BUSD', addresses: ['0x4Fabb145d64652a948d72533023f6E7A623C7C53'] },
    { symbol: 'BNB', name: 'BNB', addresses: ['0xB8c77482e45F1F44dE1745F52C74426C631bDD52'] },
    { symbol: 'ETH', name: 'Ether', addresses: [] },
  ],
}

// Characters that render like a Latin letter: code point to the uppercase Latin letter. Explicit \u escapes,
// because these glyphs are visually identical to ASCII and a literal character here would be unreadable
// in review (supplementary-plane keys are \u{...}). GENERATED once, not hand-written, from Unicode's
// confusables.txt (UTS #39 Version 18.0.0, dated 2026-08-06,
// https://www.unicode.org/Public/security/latest/confusables.txt): every entry whose source is ONE non-ASCII
// code point and whose prototype is ONE Latin letter (A-Z or a-z, uppercased; the table spells a capital I as
// `l`, and the fold reads l as I). Nothing is left out because NFKD would also fold it (fullwidth and
// mathematical letters, roman numerals, outlined letters): the explorer runs on whatever Node the host provides
// and the repo pins none, and a runtime with older Unicode data does not know the newest of those (the
// outlined Latin letters U+1CCD6.., Unicode 16, are plain letters to NFKD only on a newer Node). The fold
// reads this table on the RAW text, before NFKD, so every entry works with a normalize() that knows
// nothing. Two exclusions: ASCII sources (0 1 I |), which are the fold's own digit and letter swaps, and
// U+017F long s, which NFKD reads as S and UTS #39 as f: the entry would stop a long-s USDT clone from being
// flagged. Grouped by script, with the counts pinned in lookalike.test.ts. To refresh, redo that selection and
// replace this block; there is no runtime fetch.
export const HOMOGLYPHS: Record<string, string> = {
  // Warang Citi, U+118A0..118FF (27)
  '\u{118A0}': 'V', '\u{118A2}': 'F', '\u{118A3}': 'L', '\u{118A4}': 'Y', '\u{118A6}': 'E', '\u{118A9}': 'Z',
  '\u{118AE}': 'E', '\u{118B2}': 'L', '\u{118B5}': 'O', '\u{118B8}': 'U', '\u{118BC}': 'T', '\u{118C0}': 'V',
  '\u{118C1}': 'S', '\u{118C2}': 'F', '\u{118C3}': 'I', '\u{118C4}': 'Y', '\u{118C8}': 'O', '\u{118D7}': 'O',
  '\u{118D8}': 'U', '\u{118DC}': 'Y', '\u{118E0}': 'O', '\u{118E5}': 'Z', '\u{118E6}': 'W', '\u{118E9}': 'C',
  '\u{118EC}': 'X', '\u{118EF}': 'W', '\u{118F2}': 'C',
  // Canadian Syllabics (22): U+1400..167F, U+11AB0..11ABF
  '\u142F': 'V', '\u144C': 'U', '\u146D': 'P', '\u146F': 'D', '\u1472': 'B', '\u148D': 'J',
  '\u14AA': 'L', '\u1541': 'X', '\u157C': 'H', '\u157D': 'X', '\u1587': 'R', '\u15AF': 'B',
  '\u15B4': 'F', '\u15C5': 'A', '\u15DE': 'D', '\u15EA': 'D', '\u15F0': 'M', '\u15F7': 'B',
  '\u166D': 'X', '\u166E': 'X', '\u{11ABC}': 'Z', '\u{11ABE}': 'N',
  // Latin and IPA (61): U+0080..02AF, U+1D00..1EFF, U+2C60..2C7F, U+A720..A7FF, U+AB30..AB6F, U+1DF00..1DFFF
  '\u00A1': 'I', '\u00D7': 'X', '\u00FE': 'P', '\u0131': 'I', '\u0184': 'B', '\u018D': 'G',
  '\u0192': 'F', '\u0196': 'I', '\u01A6': 'R', '\u01BD': 'S', '\u01BF': 'P', '\u01C0': 'I',
  '\u0237': 'J', '\u024C': 'R', '\u0251': 'A', '\u0261': 'G', '\u0263': 'Y', '\u0269': 'I',
  '\u026A': 'I', '\u026F': 'W', '\u0284': 'F', '\u028B': 'U', '\u028F': 'Y', '\u1D04': 'C',
  '\u1D0F': 'O', '\u1D11': 'O', '\u1D1C': 'U', '\u1D20': 'V', '\u1D21': 'W', '\u1D22': 'Z',
  '\u1D26': 'R', '\u1D83': 'G', '\u1D8C': 'Y', '\u1E9D': 'F', '\u1EFF': 'Y', '\u2C6B': 'Z',
  '\u2C6C': 'Z', '\uA731': 'S', '\uA781': 'I', '\uA798': 'F', '\uA799': 'F', '\uA79F': 'U',
  '\uA7AE': 'I', '\uA7B2': 'J', '\uA7B3': 'X', '\uA7B4': 'B', '\uA7FA': 'W', '\uA7FE': 'I',
  '\uAB32': 'E', '\uAB35': 'F', '\uAB3D': 'O', '\uAB47': 'R', '\uAB48': 'R', '\uAB4E': 'U',
  '\uAB52': 'U', '\uAB5A': 'Y', '\uAB64': 'A', '\u{1DF5A}': 'A', '\u{1DF6A}': 'A', '\u{1DF7D}': 'W',
  '\u{1DF81}': 'E',
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
  // Cyrillic Supplement and Extended (9): U+0500..052F, U+1C80..1C8F, U+A640..A69F
  '\u0501': 'D', '\u050C': 'G', '\u051A': 'Q', '\u051B': 'Q', '\u051C': 'W', '\u051D': 'W',
  '\u1C82': 'O', '\u1C83': 'C', '\uA647': 'I',
  // Armenian, U+0530..058F (15)
  '\u054D': 'U', '\u054F': 'S', '\u0555': 'O', '\u0561': 'W', '\u0563': 'Q', '\u0566': 'Q',
  '\u0570': 'H', '\u0575': 'J', '\u0578': 'N', '\u057C': 'N', '\u057D': 'U', '\u0581': 'G',
  '\u0582': 'I', '\u0584': 'F', '\u0585': 'O',
  // Hebrew, Arabic, NKo and Mandaic (42): U+0590..08FF, U+FB50..FDFF, U+FE70..FEFF, U+1EE00..1EEFF
  '\u05C0': 'I', '\u05D5': 'I', '\u05D8': 'V', '\u05DF': 'I', '\u05E1': 'O', '\u0627': 'I',
  '\u0647': 'O', '\u0661': 'I', '\u0665': 'O', '\u0667': 'V', '\u06BE': 'O', '\u06C1': 'O',
  '\u06D5': 'O', '\u06F1': 'I', '\u06F5': 'O', '\u06F7': 'V', '\u07C0': 'O', '\u07CA': 'I',
  '\u07CB': 'O', '\u07CC': 'Y', '\u07D3': 'F', '\u07D5': 'B', '\u07E0': 'T', '\u0840': 'O',
  '\uFBA6': 'O', '\uFBA7': 'O', '\uFBA8': 'O', '\uFBA9': 'O', '\uFBAA': 'O', '\uFBAB': 'O',
  '\uFBAC': 'O', '\uFBAD': 'O', '\uFE8D': 'I', '\uFE8E': 'I', '\uFEE9': 'O', '\uFEEA': 'O',
  '\uFEEB': 'O', '\uFEEC': 'O', '\u{1EE00}': 'I', '\u{1EE24}': 'O', '\u{1EE80}': 'I', '\u{1EE84}': 'O',
  // Indic scripts (39): U+0900..0DFF, U+1CD0..1CFF, U+A830..A8DF, U+11000..11FFF
  '\u0964': 'I', '\u0966': 'O', '\u09E6': 'O', '\u0A66': 'O', '\u0AE6': 'O', '\u0B20': 'O',
  '\u0B66': 'O', '\u0BE6': 'O', '\u0C02': 'O', '\u0C66': 'O', '\u0C82': 'O', '\u0CE6': 'O',
  '\u0D02': 'O', '\u0D1F': 'S', '\u0D20': 'O', '\u0D66': 'O', '\u0D82': 'O', '\u1CF5': 'X',
  '\uA830': 'I', '\uA8CE': 'I', '\u{11047}': 'I', '\u{110C0}': 'I', '\u{11124}': 'O', '\u{11141}': 'I',
  '\u{111C5}': 'I', '\u{11302}': 'O', '\u{113D4}': 'I', '\u{1144B}': 'I', '\u{114D0}': 'O', '\u{115C5}': 'I',
  '\u{11641}': 'I', '\u{11706}': 'V', '\u{1170A}': 'W', '\u{1170E}': 'W', '\u{1170F}': 'W', '\u{11C41}': 'I',
  '\u{11DDA}': 'I', '\u{11DE0}': 'O', '\u{11DE1}': 'I',
  // Southeast Asian scripts (15): U+0E00..109F, U+1700..1BFF, U+AA00..AA5F
  '\u0E50': 'O', '\u0ED0': 'O', '\u1004': 'C', '\u101D': 'O', '\u1040': 'O', '\u104A': 'I',
  '\u105A': 'C', '\u1763': 'X', '\u17E0': 'O', '\u1A45': 'O', '\u1A80': 'O', '\u1A90': 'O',
  '\u1BEA': 'O', '\u1BEC': 'X', '\uAA5D': 'I',
  // Georgian (9): U+10A0..10FF, U+1C90..1CBF, U+2D00..2D2F
  '\u10B9': 'H', '\u10BD': 'S', '\u10CD': 'Z', '\u10E7': 'Y', '\u10FD': 'S', '\u10FF': 'O',
  '\u1CBD': 'S', '\u1CBF': 'O', '\u2D2D': 'Z',
  // Hangul Jamo and Ethiopic, U+1100..137F (4)
  '\u110B': 'O', '\u11BC': 'O', '\u1200': 'U', '\u12D0': 'O',
  // Cherokee (36): U+13A0..13FF, U+AB70..ABBF
  '\u13A0': 'D', '\u13A1': 'R', '\u13A2': 'T', '\u13A5': 'I', '\u13A9': 'Y', '\u13AA': 'A',
  '\u13AB': 'J', '\u13AC': 'E', '\u13B3': 'W', '\u13B7': 'M', '\u13BB': 'H', '\u13BD': 'Y',
  '\u13C0': 'G', '\u13C2': 'H', '\u13C3': 'Z', '\u13CF': 'B', '\u13D2': 'R', '\u13D4': 'W',
  '\u13D5': 'S', '\u13D9': 'V', '\u13DA': 'S', '\u13DE': 'L', '\u13DF': 'C', '\u13E2': 'P',
  '\u13E6': 'K', '\u13E7': 'D', '\u13F3': 'G', '\u13F4': 'B', '\uAB75': 'I', '\uAB81': 'R',
  '\uAB83': 'W', '\uAB93': 'Z', '\uABA4': 'W', '\uABA9': 'V', '\uABAA': 'S', '\uABAF': 'C',
  // Runic, U+16A0..16FF (5)
  '\u16B7': 'X', '\u16C1': 'I', '\u16D0': 'I', '\u16D5': 'K', '\u16D6': 'M',
  // Coptic, U+2C80..2CFF (24)
  '\u2C82': 'B', '\u2C85': 'R', '\u2C8C': 'Z', '\u2C8D': 'Z', '\u2C8E': 'H', '\u2C92': 'I',
  '\u2C93': 'I', '\u2C94': 'K', '\u2C98': 'M', '\u2C9A': 'N', '\u2C9E': 'O', '\u2C9F': 'O',
  '\u2CA2': 'P', '\u2CA3': 'P', '\u2CA4': 'C', '\u2CA5': 'C', '\u2CA6': 'T', '\u2CA8': 'Y',
  '\u2CA9': 'Y', '\u2CAC': 'X', '\u2CBD': 'W', '\u2CCE': 'P', '\u2CCF': 'P', '\u2CD0': 'L',
  // Tifinagh, U+2D30..2D7F (7)
  '\u2D38': 'V', '\u2D39': 'E', '\u2D4A': 'I', '\u2D4F': 'I', '\u2D54': 'O', '\u2D55': 'Q',
  '\u2D5D': 'X',
  // Lisu, U+A4D0..A4FF (26)
  '\uA4D0': 'B', '\uA4D1': 'P', '\uA4D2': 'D', '\uA4D3': 'D', '\uA4D4': 'T', '\uA4D6': 'G',
  '\uA4D7': 'K', '\uA4D9': 'J', '\uA4DA': 'C', '\uA4DC': 'Z', '\uA4DD': 'F', '\uA4DF': 'M',
  '\uA4E0': 'N', '\uA4E1': 'L', '\uA4E2': 'S', '\uA4E3': 'R', '\uA4E6': 'V', '\uA4E7': 'H',
  '\uA4EA': 'W', '\uA4EB': 'X', '\uA4EC': 'Y', '\uA4EE': 'A', '\uA4F0': 'E', '\uA4F2': 'I',
  '\uA4F3': 'O', '\uA4F4': 'U',
  // Vai and Bamum (8): U+A500..A63F, U+A6A0..A6FF, U+16800..16A3F
  '\uA50B': 'T', '\uA557': 'B', '\uA56F': 'I', '\uA576': 'S', '\uA5CB': 'E', '\uA6C9': 'Z',
  '\uA6DF': 'V', '\u{16A19}': 'R',
  // CJK, Bopomofo and Hangul compatibility, U+3100..9FFF (5)
  '\u3112': 'T', '\u311A': 'Y', '\u3147': 'O', '\u4E05': 'T', '\u4E2B': 'Y',
  // Letterlike symbols and number forms, U+2100..218F (46)
  '\u2102': 'C', '\u210A': 'G', '\u210B': 'H', '\u210C': 'H', '\u210D': 'H', '\u210E': 'H',
  '\u2110': 'I', '\u2111': 'I', '\u2112': 'L', '\u2113': 'I', '\u2115': 'N', '\u2119': 'P',
  '\u211A': 'Q', '\u211B': 'R', '\u211C': 'R', '\u211D': 'R', '\u2124': 'Z', '\u2128': 'Z',
  '\u212C': 'B', '\u212D': 'C', '\u212E': 'E', '\u212F': 'E', '\u2130': 'E', '\u2131': 'F',
  '\u2133': 'M', '\u2134': 'O', '\u2139': 'I', '\u213D': 'Y', '\u2145': 'D', '\u2146': 'D',
  '\u2147': 'E', '\u2148': 'I', '\u2149': 'J', '\u2160': 'I', '\u2164': 'V', '\u2169': 'X',
  '\u216C': 'L', '\u216D': 'C', '\u216E': 'D', '\u216F': 'M', '\u2170': 'I', '\u2174': 'V',
  '\u2179': 'X', '\u217C': 'I', '\u217D': 'C', '\u217E': 'D',
  // Fullwidth and halfwidth forms, U+FF00..FFEF (56)
  '\uFF10': 'O', '\uFF11': 'I', '\uFF21': 'A', '\uFF22': 'B', '\uFF23': 'C', '\uFF24': 'D',
  '\uFF25': 'E', '\uFF26': 'F', '\uFF27': 'G', '\uFF28': 'H', '\uFF29': 'I', '\uFF2A': 'J',
  '\uFF2B': 'K', '\uFF2C': 'L', '\uFF2D': 'M', '\uFF2E': 'N', '\uFF2F': 'O', '\uFF30': 'P',
  '\uFF31': 'Q', '\uFF32': 'R', '\uFF33': 'S', '\uFF34': 'T', '\uFF35': 'U', '\uFF36': 'V',
  '\uFF37': 'W', '\uFF38': 'X', '\uFF39': 'Y', '\uFF3A': 'Z', '\uFF41': 'A', '\uFF42': 'B',
  '\uFF43': 'C', '\uFF44': 'D', '\uFF45': 'E', '\uFF46': 'F', '\uFF47': 'G', '\uFF48': 'H',
  '\uFF49': 'I', '\uFF4A': 'J', '\uFF4B': 'K', '\uFF4C': 'I', '\uFF4E': 'N', '\uFF4F': 'O',
  '\uFF50': 'P', '\uFF51': 'Q', '\uFF52': 'R', '\uFF53': 'S', '\uFF54': 'T', '\uFF55': 'U',
  '\uFF56': 'V', '\uFF57': 'W', '\uFF58': 'X', '\uFF59': 'Y', '\uFF5A': 'Z', '\uFF5C': 'I',
  '\uFFB7': 'O', '\uFFE8': 'I',
  // Outlined and segmented letters and digits (30): U+1CC00..1CEBF, U+1FB00..1FBFF
  '\u{1CCD6}': 'A', '\u{1CCD7}': 'B', '\u{1CCD8}': 'C', '\u{1CCD9}': 'D', '\u{1CCDA}': 'E', '\u{1CCDB}': 'F',
  '\u{1CCDC}': 'G', '\u{1CCDD}': 'H', '\u{1CCDE}': 'I', '\u{1CCDF}': 'J', '\u{1CCE0}': 'K', '\u{1CCE1}': 'L',
  '\u{1CCE2}': 'M', '\u{1CCE3}': 'N', '\u{1CCE4}': 'O', '\u{1CCE5}': 'P', '\u{1CCE6}': 'Q', '\u{1CCE7}': 'R',
  '\u{1CCE8}': 'S', '\u{1CCE9}': 'T', '\u{1CCEA}': 'U', '\u{1CCEB}': 'V', '\u{1CCEC}': 'W', '\u{1CCED}': 'X',
  '\u{1CCEE}': 'Y', '\u{1CCEF}': 'Z', '\u{1CCF0}': 'O', '\u{1CCF1}': 'I', '\u{1FBF0}': 'O', '\u{1FBF1}': 'I',
  // Symbols, punctuation and numerals (39): U+2190..2BFF, U+3000..303F, U+FE30..FE4F, U+10140..1018F,
  //   U+102E0..102FF, U+1CEC0..1CEFF, U+1D100..1D3FF, U+1ED00..1ED4F, U+1F700..1F7FF
  '\u21BF': 'I', '\u2223': 'I', '\u2228': 'V', '\u222A': 'U', '\u22A4': 'T', '\u22C1': 'V',
  '\u22C3': 'U', '\u22FF': 'E', '\u2373': 'I', '\u2374': 'P', '\u237A': 'A', '\u23FD': 'I',
  '\u2502': 'I', '\u2503': 'I', '\u2573': 'X', '\u27D9': 'T', '\u292B': 'X', '\u292C': 'X',
  '\u29E2': 'W', '\u2A2F': 'X', '\u3007': 'O', '\uFE31': 'I', '\u{1017E}': 'F', '\u{1018B}': 'D',
  '\u{102F5}': 'Z', '\u{1CEFC}': 'V', '\u{1D100}': 'I', '\u{1D134}': 'C', '\u{1D207}': 'B', '\u{1D20C}': 'W',
  '\u{1D20D}': 'V', '\u{1D213}': 'F', '\u{1D216}': 'R', '\u{1D22A}': 'L', '\u{1D373}': 'T', '\u{1D377}': 'I',
  '\u{1ED01}': 'I', '\u{1F74C}': 'C', '\u{1F768}': 'T',
  // Historic scripts, U+10000..10FFF (65)
  '\u{10282}': 'B', '\u{10286}': 'E', '\u{10287}': 'F', '\u{1028A}': 'I', '\u{10290}': 'X', '\u{10292}': 'O',
  '\u{10295}': 'P', '\u{10296}': 'S', '\u{10297}': 'T', '\u{102A0}': 'A', '\u{102A1}': 'B', '\u{102A2}': 'C',
  '\u{102A5}': 'F', '\u{102AB}': 'O', '\u{102B0}': 'M', '\u{102B1}': 'T', '\u{102B2}': 'Y', '\u{102B4}': 'X',
  '\u{102CF}': 'H', '\u{10301}': 'B', '\u{10302}': 'C', '\u{10309}': 'I', '\u{1030F}': 'O', '\u{10311}': 'M',
  '\u{10315}': 'T', '\u{10317}': 'X', '\u{1031C}': 'B', '\u{10320}': 'I', '\u{10322}': 'X', '\u{10404}': 'O',
  '\u{10415}': 'C', '\u{1041B}': 'L', '\u{10420}': 'S', '\u{1042C}': 'O', '\u{1043D}': 'C', '\u{10448}': 'S',
  '\u{104B4}': 'R', '\u{104C2}': 'O', '\u{104CE}': 'U', '\u{104EA}': 'O', '\u{104F6}': 'U', '\u{10507}': 'Z',
  '\u{1050E}': 'I', '\u{10513}': 'N', '\u{10516}': 'O', '\u{10518}': 'K', '\u{1051B}': 'C', '\u{1051D}': 'V',
  '\u{10525}': 'F', '\u{10526}': 'L', '\u{10527}': 'X', '\u{10926}': 'I', '\u{1092C}': 'O', '\u{10C13}': 'X',
  '\u{10C17}': 'O', '\u{10C1F}': 'V', '\u{10C20}': 'Y', '\u{10C21}': 'M', '\u{10C3E}': 'I', '\u{10C82}': 'X',
  '\u{10CA5}': 'I', '\u{10CC2}': 'X', '\u{10CFA}': 'I', '\u{10CFC}': 'X', '\u{10D07}': 'O',
  // Mathematical alphanumerics, U+1D400..1D7FF (767)
  '\u{1D400}': 'A', '\u{1D401}': 'B', '\u{1D402}': 'C', '\u{1D403}': 'D', '\u{1D404}': 'E', '\u{1D405}': 'F',
  '\u{1D406}': 'G', '\u{1D407}': 'H', '\u{1D408}': 'I', '\u{1D409}': 'J', '\u{1D40A}': 'K', '\u{1D40B}': 'L',
  '\u{1D40C}': 'M', '\u{1D40D}': 'N', '\u{1D40E}': 'O', '\u{1D40F}': 'P', '\u{1D410}': 'Q', '\u{1D411}': 'R',
  '\u{1D412}': 'S', '\u{1D413}': 'T', '\u{1D414}': 'U', '\u{1D415}': 'V', '\u{1D416}': 'W', '\u{1D417}': 'X',
  '\u{1D418}': 'Y', '\u{1D419}': 'Z', '\u{1D41A}': 'A', '\u{1D41B}': 'B', '\u{1D41C}': 'C', '\u{1D41D}': 'D',
  '\u{1D41E}': 'E', '\u{1D41F}': 'F', '\u{1D420}': 'G', '\u{1D421}': 'H', '\u{1D422}': 'I', '\u{1D423}': 'J',
  '\u{1D424}': 'K', '\u{1D425}': 'I', '\u{1D427}': 'N', '\u{1D428}': 'O', '\u{1D429}': 'P', '\u{1D42A}': 'Q',
  '\u{1D42B}': 'R', '\u{1D42C}': 'S', '\u{1D42D}': 'T', '\u{1D42E}': 'U', '\u{1D42F}': 'V', '\u{1D430}': 'W',
  '\u{1D431}': 'X', '\u{1D432}': 'Y', '\u{1D433}': 'Z', '\u{1D434}': 'A', '\u{1D435}': 'B', '\u{1D436}': 'C',
  '\u{1D437}': 'D', '\u{1D438}': 'E', '\u{1D439}': 'F', '\u{1D43A}': 'G', '\u{1D43B}': 'H', '\u{1D43C}': 'I',
  '\u{1D43D}': 'J', '\u{1D43E}': 'K', '\u{1D43F}': 'L', '\u{1D440}': 'M', '\u{1D441}': 'N', '\u{1D442}': 'O',
  '\u{1D443}': 'P', '\u{1D444}': 'Q', '\u{1D445}': 'R', '\u{1D446}': 'S', '\u{1D447}': 'T', '\u{1D448}': 'U',
  '\u{1D449}': 'V', '\u{1D44A}': 'W', '\u{1D44B}': 'X', '\u{1D44C}': 'Y', '\u{1D44D}': 'Z', '\u{1D44E}': 'A',
  '\u{1D44F}': 'B', '\u{1D450}': 'C', '\u{1D451}': 'D', '\u{1D452}': 'E', '\u{1D453}': 'F', '\u{1D454}': 'G',
  '\u{1D456}': 'I', '\u{1D457}': 'J', '\u{1D458}': 'K', '\u{1D459}': 'I', '\u{1D45B}': 'N', '\u{1D45C}': 'O',
  '\u{1D45D}': 'P', '\u{1D45E}': 'Q', '\u{1D45F}': 'R', '\u{1D460}': 'S', '\u{1D461}': 'T', '\u{1D462}': 'U',
  '\u{1D463}': 'V', '\u{1D464}': 'W', '\u{1D465}': 'X', '\u{1D466}': 'Y', '\u{1D467}': 'Z', '\u{1D468}': 'A',
  '\u{1D469}': 'B', '\u{1D46A}': 'C', '\u{1D46B}': 'D', '\u{1D46C}': 'E', '\u{1D46D}': 'F', '\u{1D46E}': 'G',
  '\u{1D46F}': 'H', '\u{1D470}': 'I', '\u{1D471}': 'J', '\u{1D472}': 'K', '\u{1D473}': 'L', '\u{1D474}': 'M',
  '\u{1D475}': 'N', '\u{1D476}': 'O', '\u{1D477}': 'P', '\u{1D478}': 'Q', '\u{1D479}': 'R', '\u{1D47A}': 'S',
  '\u{1D47B}': 'T', '\u{1D47C}': 'U', '\u{1D47D}': 'V', '\u{1D47E}': 'W', '\u{1D47F}': 'X', '\u{1D480}': 'Y',
  '\u{1D481}': 'Z', '\u{1D482}': 'A', '\u{1D483}': 'B', '\u{1D484}': 'C', '\u{1D485}': 'D', '\u{1D486}': 'E',
  '\u{1D487}': 'F', '\u{1D488}': 'G', '\u{1D489}': 'H', '\u{1D48A}': 'I', '\u{1D48B}': 'J', '\u{1D48C}': 'K',
  '\u{1D48D}': 'I', '\u{1D48F}': 'N', '\u{1D490}': 'O', '\u{1D491}': 'P', '\u{1D492}': 'Q', '\u{1D493}': 'R',
  '\u{1D494}': 'S', '\u{1D495}': 'T', '\u{1D496}': 'U', '\u{1D497}': 'V', '\u{1D498}': 'W', '\u{1D499}': 'X',
  '\u{1D49A}': 'Y', '\u{1D49B}': 'Z', '\u{1D49C}': 'A', '\u{1D49E}': 'C', '\u{1D49F}': 'D', '\u{1D4A2}': 'G',
  '\u{1D4A5}': 'J', '\u{1D4A6}': 'K', '\u{1D4A9}': 'N', '\u{1D4AA}': 'O', '\u{1D4AB}': 'P', '\u{1D4AC}': 'Q',
  '\u{1D4AE}': 'S', '\u{1D4AF}': 'T', '\u{1D4B0}': 'U', '\u{1D4B1}': 'V', '\u{1D4B2}': 'W', '\u{1D4B3}': 'X',
  '\u{1D4B4}': 'Y', '\u{1D4B5}': 'Z', '\u{1D4B6}': 'A', '\u{1D4B7}': 'B', '\u{1D4B8}': 'C', '\u{1D4B9}': 'D',
  '\u{1D4BB}': 'F', '\u{1D4BD}': 'H', '\u{1D4BE}': 'I', '\u{1D4BF}': 'J', '\u{1D4C0}': 'K', '\u{1D4C1}': 'I',
  '\u{1D4C3}': 'N', '\u{1D4C5}': 'P', '\u{1D4C6}': 'Q', '\u{1D4C7}': 'R', '\u{1D4C8}': 'S', '\u{1D4C9}': 'T',
  '\u{1D4CA}': 'U', '\u{1D4CB}': 'V', '\u{1D4CC}': 'W', '\u{1D4CD}': 'X', '\u{1D4CE}': 'Y', '\u{1D4CF}': 'Z',
  '\u{1D4D0}': 'A', '\u{1D4D1}': 'B', '\u{1D4D2}': 'C', '\u{1D4D3}': 'D', '\u{1D4D4}': 'E', '\u{1D4D5}': 'F',
  '\u{1D4D6}': 'G', '\u{1D4D7}': 'H', '\u{1D4D8}': 'I', '\u{1D4D9}': 'J', '\u{1D4DA}': 'K', '\u{1D4DB}': 'L',
  '\u{1D4DC}': 'M', '\u{1D4DD}': 'N', '\u{1D4DE}': 'O', '\u{1D4DF}': 'P', '\u{1D4E0}': 'Q', '\u{1D4E1}': 'R',
  '\u{1D4E2}': 'S', '\u{1D4E3}': 'T', '\u{1D4E4}': 'U', '\u{1D4E5}': 'V', '\u{1D4E6}': 'W', '\u{1D4E7}': 'X',
  '\u{1D4E8}': 'Y', '\u{1D4E9}': 'Z', '\u{1D4EA}': 'A', '\u{1D4EB}': 'B', '\u{1D4EC}': 'C', '\u{1D4ED}': 'D',
  '\u{1D4EE}': 'E', '\u{1D4EF}': 'F', '\u{1D4F0}': 'G', '\u{1D4F1}': 'H', '\u{1D4F2}': 'I', '\u{1D4F3}': 'J',
  '\u{1D4F4}': 'K', '\u{1D4F5}': 'I', '\u{1D4F7}': 'N', '\u{1D4F8}': 'O', '\u{1D4F9}': 'P', '\u{1D4FA}': 'Q',
  '\u{1D4FB}': 'R', '\u{1D4FC}': 'S', '\u{1D4FD}': 'T', '\u{1D4FE}': 'U', '\u{1D4FF}': 'V', '\u{1D500}': 'W',
  '\u{1D501}': 'X', '\u{1D502}': 'Y', '\u{1D503}': 'Z', '\u{1D504}': 'A', '\u{1D505}': 'B', '\u{1D507}': 'D',
  '\u{1D508}': 'E', '\u{1D509}': 'F', '\u{1D50A}': 'G', '\u{1D50D}': 'J', '\u{1D50E}': 'K', '\u{1D50F}': 'L',
  '\u{1D510}': 'M', '\u{1D511}': 'N', '\u{1D512}': 'O', '\u{1D513}': 'P', '\u{1D514}': 'Q', '\u{1D516}': 'S',
  '\u{1D517}': 'T', '\u{1D518}': 'U', '\u{1D519}': 'V', '\u{1D51A}': 'W', '\u{1D51B}': 'X', '\u{1D51C}': 'Y',
  '\u{1D51E}': 'A', '\u{1D51F}': 'B', '\u{1D520}': 'C', '\u{1D521}': 'D', '\u{1D522}': 'E', '\u{1D523}': 'F',
  '\u{1D524}': 'G', '\u{1D525}': 'H', '\u{1D526}': 'I', '\u{1D527}': 'J', '\u{1D528}': 'K', '\u{1D529}': 'I',
  '\u{1D52B}': 'N', '\u{1D52C}': 'O', '\u{1D52D}': 'P', '\u{1D52E}': 'Q', '\u{1D52F}': 'R', '\u{1D530}': 'S',
  '\u{1D531}': 'T', '\u{1D532}': 'U', '\u{1D533}': 'V', '\u{1D534}': 'W', '\u{1D535}': 'X', '\u{1D536}': 'Y',
  '\u{1D537}': 'Z', '\u{1D538}': 'A', '\u{1D539}': 'B', '\u{1D53B}': 'D', '\u{1D53C}': 'E', '\u{1D53D}': 'F',
  '\u{1D53E}': 'G', '\u{1D540}': 'I', '\u{1D541}': 'J', '\u{1D542}': 'K', '\u{1D543}': 'L', '\u{1D544}': 'M',
  '\u{1D546}': 'O', '\u{1D54A}': 'S', '\u{1D54B}': 'T', '\u{1D54C}': 'U', '\u{1D54D}': 'V', '\u{1D54E}': 'W',
  '\u{1D54F}': 'X', '\u{1D550}': 'Y', '\u{1D552}': 'A', '\u{1D553}': 'B', '\u{1D554}': 'C', '\u{1D555}': 'D',
  '\u{1D556}': 'E', '\u{1D557}': 'F', '\u{1D558}': 'G', '\u{1D559}': 'H', '\u{1D55A}': 'I', '\u{1D55B}': 'J',
  '\u{1D55C}': 'K', '\u{1D55D}': 'I', '\u{1D55F}': 'N', '\u{1D560}': 'O', '\u{1D561}': 'P', '\u{1D562}': 'Q',
  '\u{1D563}': 'R', '\u{1D564}': 'S', '\u{1D565}': 'T', '\u{1D566}': 'U', '\u{1D567}': 'V', '\u{1D568}': 'W',
  '\u{1D569}': 'X', '\u{1D56A}': 'Y', '\u{1D56B}': 'Z', '\u{1D56C}': 'A', '\u{1D56D}': 'B', '\u{1D56E}': 'C',
  '\u{1D56F}': 'D', '\u{1D570}': 'E', '\u{1D571}': 'F', '\u{1D572}': 'G', '\u{1D573}': 'H', '\u{1D574}': 'I',
  '\u{1D575}': 'J', '\u{1D576}': 'K', '\u{1D577}': 'L', '\u{1D578}': 'M', '\u{1D579}': 'N', '\u{1D57A}': 'O',
  '\u{1D57B}': 'P', '\u{1D57C}': 'Q', '\u{1D57D}': 'R', '\u{1D57E}': 'S', '\u{1D57F}': 'T', '\u{1D580}': 'U',
  '\u{1D581}': 'V', '\u{1D582}': 'W', '\u{1D583}': 'X', '\u{1D584}': 'Y', '\u{1D585}': 'Z', '\u{1D586}': 'A',
  '\u{1D587}': 'B', '\u{1D588}': 'C', '\u{1D589}': 'D', '\u{1D58A}': 'E', '\u{1D58B}': 'F', '\u{1D58C}': 'G',
  '\u{1D58D}': 'H', '\u{1D58E}': 'I', '\u{1D58F}': 'J', '\u{1D590}': 'K', '\u{1D591}': 'I', '\u{1D593}': 'N',
  '\u{1D594}': 'O', '\u{1D595}': 'P', '\u{1D596}': 'Q', '\u{1D597}': 'R', '\u{1D598}': 'S', '\u{1D599}': 'T',
  '\u{1D59A}': 'U', '\u{1D59B}': 'V', '\u{1D59C}': 'W', '\u{1D59D}': 'X', '\u{1D59E}': 'Y', '\u{1D59F}': 'Z',
  '\u{1D5A0}': 'A', '\u{1D5A1}': 'B', '\u{1D5A2}': 'C', '\u{1D5A3}': 'D', '\u{1D5A4}': 'E', '\u{1D5A5}': 'F',
  '\u{1D5A6}': 'G', '\u{1D5A7}': 'H', '\u{1D5A8}': 'I', '\u{1D5A9}': 'J', '\u{1D5AA}': 'K', '\u{1D5AB}': 'L',
  '\u{1D5AC}': 'M', '\u{1D5AD}': 'N', '\u{1D5AE}': 'O', '\u{1D5AF}': 'P', '\u{1D5B0}': 'Q', '\u{1D5B1}': 'R',
  '\u{1D5B2}': 'S', '\u{1D5B3}': 'T', '\u{1D5B4}': 'U', '\u{1D5B5}': 'V', '\u{1D5B6}': 'W', '\u{1D5B7}': 'X',
  '\u{1D5B8}': 'Y', '\u{1D5B9}': 'Z', '\u{1D5BA}': 'A', '\u{1D5BB}': 'B', '\u{1D5BC}': 'C', '\u{1D5BD}': 'D',
  '\u{1D5BE}': 'E', '\u{1D5BF}': 'F', '\u{1D5C0}': 'G', '\u{1D5C1}': 'H', '\u{1D5C2}': 'I', '\u{1D5C3}': 'J',
  '\u{1D5C4}': 'K', '\u{1D5C5}': 'I', '\u{1D5C7}': 'N', '\u{1D5C8}': 'O', '\u{1D5C9}': 'P', '\u{1D5CA}': 'Q',
  '\u{1D5CB}': 'R', '\u{1D5CC}': 'S', '\u{1D5CD}': 'T', '\u{1D5CE}': 'U', '\u{1D5CF}': 'V', '\u{1D5D0}': 'W',
  '\u{1D5D1}': 'X', '\u{1D5D2}': 'Y', '\u{1D5D3}': 'Z', '\u{1D5D4}': 'A', '\u{1D5D5}': 'B', '\u{1D5D6}': 'C',
  '\u{1D5D7}': 'D', '\u{1D5D8}': 'E', '\u{1D5D9}': 'F', '\u{1D5DA}': 'G', '\u{1D5DB}': 'H', '\u{1D5DC}': 'I',
  '\u{1D5DD}': 'J', '\u{1D5DE}': 'K', '\u{1D5DF}': 'L', '\u{1D5E0}': 'M', '\u{1D5E1}': 'N', '\u{1D5E2}': 'O',
  '\u{1D5E3}': 'P', '\u{1D5E4}': 'Q', '\u{1D5E5}': 'R', '\u{1D5E6}': 'S', '\u{1D5E7}': 'T', '\u{1D5E8}': 'U',
  '\u{1D5E9}': 'V', '\u{1D5EA}': 'W', '\u{1D5EB}': 'X', '\u{1D5EC}': 'Y', '\u{1D5ED}': 'Z', '\u{1D5EE}': 'A',
  '\u{1D5EF}': 'B', '\u{1D5F0}': 'C', '\u{1D5F1}': 'D', '\u{1D5F2}': 'E', '\u{1D5F3}': 'F', '\u{1D5F4}': 'G',
  '\u{1D5F5}': 'H', '\u{1D5F6}': 'I', '\u{1D5F7}': 'J', '\u{1D5F8}': 'K', '\u{1D5F9}': 'I', '\u{1D5FB}': 'N',
  '\u{1D5FC}': 'O', '\u{1D5FD}': 'P', '\u{1D5FE}': 'Q', '\u{1D5FF}': 'R', '\u{1D600}': 'S', '\u{1D601}': 'T',
  '\u{1D602}': 'U', '\u{1D603}': 'V', '\u{1D604}': 'W', '\u{1D605}': 'X', '\u{1D606}': 'Y', '\u{1D607}': 'Z',
  '\u{1D608}': 'A', '\u{1D609}': 'B', '\u{1D60A}': 'C', '\u{1D60B}': 'D', '\u{1D60C}': 'E', '\u{1D60D}': 'F',
  '\u{1D60E}': 'G', '\u{1D60F}': 'H', '\u{1D610}': 'I', '\u{1D611}': 'J', '\u{1D612}': 'K', '\u{1D613}': 'L',
  '\u{1D614}': 'M', '\u{1D615}': 'N', '\u{1D616}': 'O', '\u{1D617}': 'P', '\u{1D618}': 'Q', '\u{1D619}': 'R',
  '\u{1D61A}': 'S', '\u{1D61B}': 'T', '\u{1D61C}': 'U', '\u{1D61D}': 'V', '\u{1D61E}': 'W', '\u{1D61F}': 'X',
  '\u{1D620}': 'Y', '\u{1D621}': 'Z', '\u{1D622}': 'A', '\u{1D623}': 'B', '\u{1D624}': 'C', '\u{1D625}': 'D',
  '\u{1D626}': 'E', '\u{1D627}': 'F', '\u{1D628}': 'G', '\u{1D629}': 'H', '\u{1D62A}': 'I', '\u{1D62B}': 'J',
  '\u{1D62C}': 'K', '\u{1D62D}': 'I', '\u{1D62F}': 'N', '\u{1D630}': 'O', '\u{1D631}': 'P', '\u{1D632}': 'Q',
  '\u{1D633}': 'R', '\u{1D634}': 'S', '\u{1D635}': 'T', '\u{1D636}': 'U', '\u{1D637}': 'V', '\u{1D638}': 'W',
  '\u{1D639}': 'X', '\u{1D63A}': 'Y', '\u{1D63B}': 'Z', '\u{1D63C}': 'A', '\u{1D63D}': 'B', '\u{1D63E}': 'C',
  '\u{1D63F}': 'D', '\u{1D640}': 'E', '\u{1D641}': 'F', '\u{1D642}': 'G', '\u{1D643}': 'H', '\u{1D644}': 'I',
  '\u{1D645}': 'J', '\u{1D646}': 'K', '\u{1D647}': 'L', '\u{1D648}': 'M', '\u{1D649}': 'N', '\u{1D64A}': 'O',
  '\u{1D64B}': 'P', '\u{1D64C}': 'Q', '\u{1D64D}': 'R', '\u{1D64E}': 'S', '\u{1D64F}': 'T', '\u{1D650}': 'U',
  '\u{1D651}': 'V', '\u{1D652}': 'W', '\u{1D653}': 'X', '\u{1D654}': 'Y', '\u{1D655}': 'Z', '\u{1D656}': 'A',
  '\u{1D657}': 'B', '\u{1D658}': 'C', '\u{1D659}': 'D', '\u{1D65A}': 'E', '\u{1D65B}': 'F', '\u{1D65C}': 'G',
  '\u{1D65D}': 'H', '\u{1D65E}': 'I', '\u{1D65F}': 'J', '\u{1D660}': 'K', '\u{1D661}': 'I', '\u{1D663}': 'N',
  '\u{1D664}': 'O', '\u{1D665}': 'P', '\u{1D666}': 'Q', '\u{1D667}': 'R', '\u{1D668}': 'S', '\u{1D669}': 'T',
  '\u{1D66A}': 'U', '\u{1D66B}': 'V', '\u{1D66C}': 'W', '\u{1D66D}': 'X', '\u{1D66E}': 'Y', '\u{1D66F}': 'Z',
  '\u{1D670}': 'A', '\u{1D671}': 'B', '\u{1D672}': 'C', '\u{1D673}': 'D', '\u{1D674}': 'E', '\u{1D675}': 'F',
  '\u{1D676}': 'G', '\u{1D677}': 'H', '\u{1D678}': 'I', '\u{1D679}': 'J', '\u{1D67A}': 'K', '\u{1D67B}': 'L',
  '\u{1D67C}': 'M', '\u{1D67D}': 'N', '\u{1D67E}': 'O', '\u{1D67F}': 'P', '\u{1D680}': 'Q', '\u{1D681}': 'R',
  '\u{1D682}': 'S', '\u{1D683}': 'T', '\u{1D684}': 'U', '\u{1D685}': 'V', '\u{1D686}': 'W', '\u{1D687}': 'X',
  '\u{1D688}': 'Y', '\u{1D689}': 'Z', '\u{1D68A}': 'A', '\u{1D68B}': 'B', '\u{1D68C}': 'C', '\u{1D68D}': 'D',
  '\u{1D68E}': 'E', '\u{1D68F}': 'F', '\u{1D690}': 'G', '\u{1D691}': 'H', '\u{1D692}': 'I', '\u{1D693}': 'J',
  '\u{1D694}': 'K', '\u{1D695}': 'I', '\u{1D697}': 'N', '\u{1D698}': 'O', '\u{1D699}': 'P', '\u{1D69A}': 'Q',
  '\u{1D69B}': 'R', '\u{1D69C}': 'S', '\u{1D69D}': 'T', '\u{1D69E}': 'U', '\u{1D69F}': 'V', '\u{1D6A0}': 'W',
  '\u{1D6A1}': 'X', '\u{1D6A2}': 'Y', '\u{1D6A3}': 'Z', '\u{1D6A4}': 'I', '\u{1D6A5}': 'J', '\u{1D6A8}': 'A',
  '\u{1D6A9}': 'B', '\u{1D6AC}': 'E', '\u{1D6AD}': 'Z', '\u{1D6AE}': 'H', '\u{1D6B0}': 'I', '\u{1D6B1}': 'K',
  '\u{1D6B3}': 'M', '\u{1D6B4}': 'N', '\u{1D6B6}': 'O', '\u{1D6B8}': 'P', '\u{1D6BB}': 'T', '\u{1D6BC}': 'Y',
  '\u{1D6BE}': 'X', '\u{1D6C2}': 'A', '\u{1D6C4}': 'Y', '\u{1D6CA}': 'I', '\u{1D6CE}': 'V', '\u{1D6D0}': 'O',
  '\u{1D6D2}': 'P', '\u{1D6D4}': 'O', '\u{1D6D6}': 'U', '\u{1D6E0}': 'P', '\u{1D6E2}': 'A', '\u{1D6E3}': 'B',
  '\u{1D6E6}': 'E', '\u{1D6E7}': 'Z', '\u{1D6E8}': 'H', '\u{1D6EA}': 'I', '\u{1D6EB}': 'K', '\u{1D6ED}': 'M',
  '\u{1D6EE}': 'N', '\u{1D6F0}': 'O', '\u{1D6F2}': 'P', '\u{1D6F5}': 'T', '\u{1D6F6}': 'Y', '\u{1D6F8}': 'X',
  '\u{1D6FC}': 'A', '\u{1D6FE}': 'Y', '\u{1D704}': 'I', '\u{1D708}': 'V', '\u{1D70A}': 'O', '\u{1D70C}': 'P',
  '\u{1D70E}': 'O', '\u{1D710}': 'U', '\u{1D71A}': 'P', '\u{1D71C}': 'A', '\u{1D71D}': 'B', '\u{1D720}': 'E',
  '\u{1D721}': 'Z', '\u{1D722}': 'H', '\u{1D724}': 'I', '\u{1D725}': 'K', '\u{1D727}': 'M', '\u{1D728}': 'N',
  '\u{1D72A}': 'O', '\u{1D72C}': 'P', '\u{1D72F}': 'T', '\u{1D730}': 'Y', '\u{1D732}': 'X', '\u{1D736}': 'A',
  '\u{1D738}': 'Y', '\u{1D73E}': 'I', '\u{1D742}': 'V', '\u{1D744}': 'O', '\u{1D746}': 'P', '\u{1D748}': 'O',
  '\u{1D74A}': 'U', '\u{1D754}': 'P', '\u{1D756}': 'A', '\u{1D757}': 'B', '\u{1D75A}': 'E', '\u{1D75B}': 'Z',
  '\u{1D75C}': 'H', '\u{1D75E}': 'I', '\u{1D75F}': 'K', '\u{1D761}': 'M', '\u{1D762}': 'N', '\u{1D764}': 'O',
  '\u{1D766}': 'P', '\u{1D769}': 'T', '\u{1D76A}': 'Y', '\u{1D76C}': 'X', '\u{1D770}': 'A', '\u{1D772}': 'Y',
  '\u{1D778}': 'I', '\u{1D77C}': 'V', '\u{1D77E}': 'O', '\u{1D780}': 'P', '\u{1D782}': 'O', '\u{1D784}': 'U',
  '\u{1D78E}': 'P', '\u{1D790}': 'A', '\u{1D791}': 'B', '\u{1D794}': 'E', '\u{1D795}': 'Z', '\u{1D796}': 'H',
  '\u{1D798}': 'I', '\u{1D799}': 'K', '\u{1D79B}': 'M', '\u{1D79C}': 'N', '\u{1D79E}': 'O', '\u{1D7A0}': 'P',
  '\u{1D7A3}': 'T', '\u{1D7A4}': 'Y', '\u{1D7A6}': 'X', '\u{1D7AA}': 'A', '\u{1D7AC}': 'Y', '\u{1D7B2}': 'I',
  '\u{1D7B6}': 'V', '\u{1D7B8}': 'O', '\u{1D7BA}': 'P', '\u{1D7BC}': 'O', '\u{1D7BE}': 'U', '\u{1D7C8}': 'P',
  '\u{1D7CA}': 'F', '\u{1D7CE}': 'O', '\u{1D7CF}': 'I', '\u{1D7D8}': 'O', '\u{1D7D9}': 'I', '\u{1D7E2}': 'O',
  '\u{1D7E3}': 'I', '\u{1D7EC}': 'O', '\u{1D7ED}': 'I', '\u{1D7F6}': 'O', '\u{1D7F7}': 'I',
  // Other supplementary-plane scripts, U+10000..1FFFF (19)
  '\u{16AD6}': 'S', '\u{16AE9}': 'O', '\u{16D63}': 'I', '\u{16EAA}': 'I', '\u{16EB6}': 'B', '\u{16F08}': 'V',
  '\u{16F0A}': 'T', '\u{16F16}': 'L', '\u{16F28}': 'I', '\u{16F35}': 'R', '\u{16F3A}': 'S', '\u{16F40}': 'A',
  '\u{16F42}': 'U', '\u{16F43}': 'Y', '\u{1E140}': 'O', '\u{1E141}': 'I', '\u{1E145}': 'V', '\u{1E2F0}': 'O',
  '\u{1E8C7}': 'I',
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
 * into ordinary sigmas before the table saw them, and a runtime whose Unicode data predates a character
 * (Node 18 and the Unicode 16 outlined letters) would leave it untouched. Then NFKD (fullwidth to ASCII, accented letters
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
  /** That token's primary contract on this chain, or null when it is the chain's native coin. */
  canonical: string | null
}

/**
 * The well-known token this one impersonates, else null. A token matches when its folded
 * symbol equals a well-known symbol, or its folded name equals that token's canonical name
 * or one of its symbols (either also counting the token's aliases: a token NAMED "USDT" is
 * shown as "USDT"), AND it is not one of that token's contracts. Address compare ignores case.
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
    if (!(w.foldedSymbols.includes(symbol) || w.foldedNames.includes(name) || w.foldedSymbols.includes(name))) continue
    if (w.addresses.some((a) => a.toLowerCase() === address)) return null
    return { symbol: w.symbol, canonical: w.addresses[0] ?? null }
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
