'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { holdersChip } from '@/lib/holder-labels'
import { looksLikeUrlOrHandle } from '@/lib/link-in-name'
import { LinkInName } from '@/components/ui/LinkInName'
import {
  hintFor, indexOfKey, nextActive, suggestTokensFor, tokenQuery, type Hint, type TokenSuggestion,
} from '@/lib/search-suggest'

/**
 * The listbox under the search field, loaded by SearchBar on the field's first focus so none of it is in a
 * page's first load. SearchBar keeps the input (its value, and the combobox attributes it must have before
 * and without this code); this owns everything a visitor sees and presses while the field is open: the
 * detected-format hint (no request), the top token suggestions (GET /api/search/suggest, debounced and
 * abortable), arrows / Enter / Escape and the mouse. It overlays the page, so opening it shifts nothing.
 */

const DEBOUNCE_MS = 150

/** What SearchBar's input reports as its combobox state. */
export type Combo = { open: boolean; active: string | undefined }

export type SuggestProps = {
  /** Prefix of the ids this renders (`${id}-list`, `${id}-0`, …); the input's aria-controls names the list. */
  id: string
  query: string
  onCombo: (combo: Combo) => void
}

type Option = { href: string; hint: Hint } | { href: string; token: TokenSuggestion }

export function SearchSuggest({ id, query, onCombo }: SuggestProps) {
  const router = useRouter()
  const list = useRef<HTMLUListElement>(null)
  const [earlier, setEarlier] = useState<TokenSuggestion[]>([])
  // The highlighted option, by its href: an index would drift to another token when a fetch answer re-orders the list.
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const tq = tokenQuery(query)

  // A new query reopens the list and clears the highlight.
  useEffect(() => { setDismissed(false); setActiveKey(null) }, [query])

  // Token suggestions: wait for typing to pause, drop the answer to a query that has since changed.
  useEffect(() => {
    if (tq === null) return
    const ctl = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/search/suggest?q=${encodeURIComponent(tq)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { tokens: [] }))
        .then((body: { tokens?: TokenSuggestion[] }) => setEarlier(body.tokens ?? []))
        .catch(() => { /* aborted, offline, rate-limited: no suggestions, Enter still searches */ })
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); ctl.abort() }
  }, [tq])

  const hint = hintFor(query)
  const options: Option[] = [
    ...(hint ? [{ href: hint.href, hint }] : []),
    ...suggestTokensFor(tq, earlier).map((token) => ({ href: `/token/${token.address}`, token })),
  ]
  const open = !dismissed && options.length > 0
  const active = indexOfKey(options.map((o) => o.href), activeKey)
  const activeId = open && active >= 0 ? `${id}-${active}` : undefined

  // Before paint, so the input's aria-expanded / aria-activedescendant never lag the list on screen.
  useLayoutEffect(() => { onCombo({ open, active: activeId }) }, [open, activeId, onCombo])

  const go = (href: string) => { setDismissed(true); router.push(href) }

  // Keys and focus belong to the field, which is SearchBar's: listen on its form. The handlers read the latest
  // options through a ref (set after each render), so they are attached once; the highlight is also written to it
  // as it changes, so keys repeating faster than a render still step one option each.
  const latest = useRef({ options, open, activeKey, go })
  useLayoutEffect(() => { latest.current = { options, open, activeKey, go } })
  useEffect(() => {
    const form = list.current?.closest('form')
    if (!form) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target !== form.elements.namedItem('q') || e.isComposing) return
      const { options: opts, open: isOpen, activeKey: key, go: pick } = latest.current
      const keys = opts.map((o) => o.href)
      const at = indexOfKey(keys, key)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (opts.length === 0) return
        e.preventDefault()
        if (!isOpen) return setDismissed(false)
        latest.current.activeKey = keys[nextActive(at, keys.length, e.key)]
        setActiveKey(latest.current.activeKey)
      } else if (e.key === 'Enter' && isOpen && at >= 0) {
        e.preventDefault() // a pick, not a form submit
        pick(opts[at].href)
      } else if (e.key === 'Escape' && isOpen) {
        e.preventDefault() // Header's Escape (closing the mobile menu) leaves this one to the list
        setDismissed(true)
        setActiveKey(null)
      }
    }
    const onFocusOut = (e: FocusEvent) => { if (e.target === form.elements.namedItem('q')) setDismissed(true) }
    const onFocusIn = (e: FocusEvent) => { if (e.target === form.elements.namedItem('q')) setDismissed(false) }
    form.addEventListener('keydown', onKeyDown)
    form.addEventListener('focusout', onFocusOut)
    form.addEventListener('focusin', onFocusIn)
    return () => {
      form.removeEventListener('keydown', onKeyDown)
      form.removeEventListener('focusout', onFocusOut)
      form.removeEventListener('focusin', onFocusIn)
    }
  }, [])

  return (
    <>
      <ul ref={list} id={`${id}-list`} role="listbox" aria-label="Suggestions" className="sb-list" hidden={!open}>
        {options.map((o, i) => (
          <li
            key={o.href}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            // Keeps focus in the field, so a click is a pick and not a blur that closes the list first.
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => { if (o.href !== activeKey) setActiveKey(o.href) }}
            onClick={() => go(o.href)}
          >
            {'hint' in o ? (
              <span className="flex gap-2">
                <span className="text-mut">{o.hint.label}</span>
                <span className="font-mono text-ink truncate">{o.hint.value}</span>
              </span>
            ) : (
              <TokenOption token={o.token} />
            )}
          </li>
        ))}
      </ul>
      <div role="status" className="sr-only">{open ? `${options.length} suggestion${options.length === 1 ? '' : 's'}` : ''}</div>
    </>
  )
}

/** A token suggestion's two lines. The holder count is the explorer's frozen index count, so its visible text says "indexed". */
export function TokenOption({ token }: { token: TokenSuggestion }) {
  const holders = holdersChip(token.holders)
  return (
    <>
      <span className="flex items-baseline gap-2">
        <span className="font-mono font-semibold text-ink">{token.symbol}</span>
        {token.lookalikeOf && (
          <span className="badge badge-bad">lookalike<span className="sr-only"> of {token.lookalikeOf}</span></span>
        )}
        {(looksLikeUrlOrHandle(token.symbol) || looksLikeUrlOrHandle(token.name)) && <LinkInName />}
        <span className="ml-auto text-mut" title={holders.title}>{holders.text}</span>
      </span>
      <span className="block truncate text-mut">{token.name}</span>
    </>
  )
}
