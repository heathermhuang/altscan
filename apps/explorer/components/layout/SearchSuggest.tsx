'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  hintFor, nextActive, suggestTokensFor, tokenQuery, type Hint, type TokenSuggestion,
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
  const [active, setActive] = useState(-1)
  const [dismissed, setDismissed] = useState(false)
  const tq = tokenQuery(query)

  // A new query reopens the list and clears the highlight.
  useEffect(() => { setDismissed(false); setActive(-1) }, [query])

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
  const activeId = open && active >= 0 && active < options.length ? `${id}-${active}` : undefined

  // Before paint, so the input's aria-expanded / aria-activedescendant never lag the list on screen.
  useLayoutEffect(() => { onCombo({ open, active: activeId }) }, [open, activeId, onCombo])

  const go = (href: string) => { setDismissed(true); router.push(href) }

  // Keys and focus belong to the field, which is SearchBar's: listen on its form. The handlers read the
  // latest options through a ref, so they are attached once; the highlight is written to it as well as to
  // state, so keys repeating faster than a render still step one option each.
  const latest = useRef({ options, open, active, go })
  latest.current = { options, open, active, go }
  useEffect(() => {
    const form = list.current?.closest('form')
    if (!form) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target !== form.elements.namedItem('q') || e.isComposing) return
      const { options: opts, open: isOpen, active: act, go: pick } = latest.current
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (opts.length === 0) return
        e.preventDefault()
        if (!isOpen) return setDismissed(false)
        latest.current.active = nextActive(act, opts.length, e.key)
        setActive(latest.current.active)
      } else if (e.key === 'Enter' && isOpen && act >= 0) {
        e.preventDefault() // a pick, not a form submit
        pick(opts[act].href)
      } else if (e.key === 'Escape' && isOpen) {
        e.preventDefault() // Header's Escape (closing the mobile menu) leaves this one to the list
        setDismissed(true)
        setActive(-1)
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
            onMouseMove={() => { if (i !== active) setActive(i) }}
            onClick={() => go(o.href)}
          >
            {'hint' in o ? (
              <span className="flex gap-2">
                <span className="text-mut">{o.hint.label}</span>
                <span className="font-mono text-ink truncate">{o.hint.value}</span>
              </span>
            ) : (
              <>
                <span className="flex items-baseline gap-2">
                  <span className="font-mono font-semibold text-ink">{o.token.symbol}</span>
                  {o.token.lookalike && <span className="badge badge-bad">lookalike</span>}
                  <span className="ml-auto text-mut">{o.token.holders.toLocaleString('en-US')} holders</span>
                </span>
                <span className="block truncate text-mut">{o.token.name}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      <div role="status" className="sr-only">{open ? `${options.length} suggestion${options.length === 1 ? '' : 's'}` : ''}</div>
    </>
  )
}
