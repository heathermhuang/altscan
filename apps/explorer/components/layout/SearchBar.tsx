'use client'
import { useId, useState, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { routeForQuery } from '@/lib/search-route'
import type { Combo, SuggestProps } from './SearchSuggest'

const PLACEHOLDER = 'Search by address, tx hash, block number, or token name...'
const PLACEHOLDER_SHORT = 'Address, tx, block or token'

export function SearchBar({ size = 'md', label }: { size?: 'lg' | 'md'; label?: string }) {
  const [query, setQuery] = useState('')
  const [Suggest, setSuggest] = useState<ComponentType<SuggestProps> | null>(null)
  const [combo, setCombo] = useState<Combo>({ open: false, active: undefined })
  const id = useId()
  const router = useRouter()
  const lg = size === 'lg'

  // The suggestions are code and a request the page can do without until someone uses the field. A chunk
  // that fails to load (offline) leaves the plain field, and the next focus tries again.
  const load = () => {
    if (!Suggest) import('./SearchSuggest').then((m) => setSuggest(() => m.SearchSuggest), () => {})
  }

  // The combobox attributes describe a popup, so they arrive with it (the first focus). With no JS, or a chunk that
  // failed to load, this is a plain search field: assistive tech must not hear "combobox, collapsed" on it.
  const comboboxProps = Suggest
    ? { role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': combo.open, 'aria-controls': `${id}-list`, 'aria-activedescendant': combo.active } as const
    : {}

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const href = routeForQuery(query)
    if (href) router.push(href)
  }

  return (
    // Without JS this is a plain GET to /search?q=, which routes a block, hash or address itself.
    <form onSubmit={handleSearch} role="search" action="/search" method="get" aria-label={label} className={lg ? 'sb sb-lg' : 'sb'}>
      <input
        type="text"
        name="q"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={load}
        placeholder={lg ? PLACEHOLDER : PLACEHOLDER_SHORT}
        aria-label="Search by address, tx hash, block number, or token name"
        aria-keyshortcuts="/"
        {...comboboxProps}
        autoComplete="off"
        suppressHydrationWarning
      />
      <button type="submit">Search</button>
      {Suggest && <Suggest id={id} query={query} onCombo={setCombo} />}
    </form>
  )
}
