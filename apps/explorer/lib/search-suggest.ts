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
export type TokenSuggestion = {
  address: string; symbol: string; name: string; holders: number
  /** The well-known token this one imitates (its symbol), or null when it is not flagged. */
  lookalikeOf: string | null
}

export type Hint = { kind: 'block' | 'tx' | 'address'; label: string; value: string; href: string }

const LABEL = { block: 'Block', tx: 'Transaction', address: 'Address' } as const

/** 126779120 -> "126,779,120". Digits only, so it can't go through Number; a loop, not a lookahead regex (those backtrack). */
function groupDigits(digits: string): string {
  const head = digits.length % 3 || 3
  let out = digits.slice(0, head)
  for (let i = head; i < digits.length; i += 3) out += `,${digits.slice(i, i + 3)}`
  return out
}

/** What the box will open for this text, if it is a block number, a tx hash or an address; no request. */
export function hintFor(raw: string): Hint | null {
  const { kind, q } = classifyQuery(raw)
  const href = routeForQuery(raw)
  if (kind === 'text' || !href) return null
  const value = kind === 'block' ? `#${groupDigits(q)}` : `${q.slice(0, 8)}…${q.slice(-8)}`
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

/**
 * Where the highlighted option is now, -1 when there is none or it is gone. The highlight is kept as the option's
 * key, not its index: an answer that arrives while an option is arrowed puts new tokens ahead of it, and an index
 * would then point (and Enter would go) to a different token than the one shown.
 */
export function indexOfKey(keys: readonly string[], key: string | null): number {
  return key === null ? -1 : keys.indexOf(key)
}

/** The active option (-1: none) after an arrow key; both directions wrap. */
export function nextActive(active: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count === 0) return -1
  if (key === 'ArrowDown') return (active + 1) % count
  return active <= 0 ? count - 1 : active - 1
}
