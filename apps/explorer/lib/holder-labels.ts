/**
 * A token has two holder counts, from two sources that disagree by orders of magnitude (USDT on BNB
 * Chain: 835,871 against 79,823,380), so neither is ever shown bare. One label per source, used
 * everywhere a count appears: /token, the token page, the page descriptions, the search typeahead.
 *  - indexed: tokens.holder_count, the explorer's own index. Per-block holder tracking is off, so it
 *    is a frozen snapshot (about 1% of the live count for USDT on BNB Chain), never published as current.
 *  - provider: Moralis's holder total, cached for up to two hours.
 * No imports: the search typeahead ships this in a chunk loaded on first focus.
 */
export type HolderSource = 'indexed' | 'provider'

export const HOLDER_LABELS: Record<HolderSource, { phrase: string; heading: string; title: string }> = {
  indexed: {
    phrase: 'indexed holders',
    heading: 'Indexed holders',
    title: "A snapshot from this explorer's index. Per-block holder tracking is off, so it is not updated and can be far below the live figure.",
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

/**
 * The indexed count as one visible chip: "835,871 indexed", with the full sentence as its title. The
 * qualifier is in the text because tooltips do not show on touch screens.
 */
export function holdersChip(n: number): { text: string; title: string } {
  return { text: `${n.toLocaleString('en-US')} indexed`, title: HOLDER_LABELS.indexed.title }
}
