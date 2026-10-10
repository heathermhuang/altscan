/**
 * A token has two holder counts, from two sources that disagree by orders of magnitude (USDT on BNB
 * Chain: 835,871 against 79,823,380), so neither is ever shown bare. One label per source, used
 * everywhere a count appears: /token, the token page, the page descriptions, the search typeahead.
 *  - indexed: tokens.holder_count, the explorer's own index. Per-block holder tracking is off, so it
 *    is the last count the index made and can lag the chain.
 *  - provider: Moralis's holder total, cached for up to two hours.
 * No imports: the search typeahead ships this in a chunk loaded on first focus.
 */
export type HolderSource = 'indexed' | 'provider'

export const HOLDER_LABELS: Record<HolderSource, { phrase: string; heading: string; title: string }> = {
  indexed: {
    phrase: 'indexed holders',
    heading: 'Indexed holders',
    title: "Holders counted by this explorer's own index. It can lag the chain and differ from a data provider's total.",
  },
  provider: {
    phrase: 'holders (Moralis)',
    heading: 'Holders (Moralis)',
    title: "Holder total reported by Moralis, cached for up to two hours. It differs from this explorer's indexed count.",
  },
}

/** "835,871 indexed holders" / "79,823,380 holders (Moralis)". */
export function holdersPhrase(n: number, source: HolderSource): string {
  return `${n.toLocaleString('en-US')} ${HOLDER_LABELS[source].phrase}`
}
