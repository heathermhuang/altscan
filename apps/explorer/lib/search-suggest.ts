/**
 * The typeahead under the search box, minus the DOM: what a query is detected as, what to look tokens up
 * with, and how the arrow keys move. Pure, so it is unit-tested; the component that uses it
 * (components/layout/SearchSuggest.tsx) is loaded on the first focus of the box.
 */
import { classifyQuery, routeForQuery } from '@/lib/search-route'

/** Fewer characters match too much to be a suggestion; symbol is varchar(50), so more can match nothing. */
export const SUGGEST_MIN_CHARS = 2
export const SUGGEST_MAX_CHARS = 50

/** One row of GET /api/search/suggest. */
export type TokenSuggestion = { address: string; symbol: string; name: string; holders: number; lookalike: boolean }

export type Hint = { kind: 'block' | 'tx' | 'address'; label: string; value: string; href: string }

const LABEL = { block: 'Block', tx: 'Transaction', address: 'Address' } as const

/** What the box will open for this text, if it is a block number, a tx hash or an address; no request. */
export function hintFor(raw: string): Hint | null {
  const { kind, q } = classifyQuery(raw)
  const href = routeForQuery(raw)
  if (kind === 'text' || !href) return null
  // Digits only, so grouping can't go through Number: a block number is short, but a pasted one need not be.
  const value = kind === 'block' ? `#${q.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}` : `${q.slice(0, 8)}…${q.slice(-8)}`
  return { kind, label: LABEL[kind], value, href }
}

/** The text to look token symbols up with, or null when this is not (yet) a token query. */
export function tokenQuery(raw: string): string | null {
  const { kind, q } = classifyQuery(raw)
  if (kind !== 'text' || q.length < SUGGEST_MIN_CHARS || q.length > SUGGEST_MAX_CHARS) return null
  return q.toLowerCase()
}

/**
 * Tokens from an earlier answer that still fit what is typed now. Anything starting with the current
 * text is a true match whatever prefix it was fetched for, so the list narrows as the visitor types
 * instead of blanking while the next answer is on its way.
 */
export function suggestTokensFor(q: string | null, earlier: readonly TokenSuggestion[]): TokenSuggestion[] {
  return q === null ? [] : earlier.filter((t) => t.symbol.toLowerCase().startsWith(q))
}

/** The active option (-1: none) after an arrow key; both directions wrap. */
export function nextActive(active: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count === 0) return -1
  if (key === 'ArrowDown') return (active + 1) % count
  return active <= 0 ? count - 1 : active - 1
}
