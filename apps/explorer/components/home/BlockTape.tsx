'use client'
import { useState, type CSSProperties, type KeyboardEvent, type SyntheticEvent } from 'react'
import { ratePerMin, spreadSeconds, type TapeTuple } from '@/lib/tape'

const LEGEND = 'width = block time · fill = gas used · newest on the right'

// Fixed locale: the same string on server and client, so hydration cannot mismatch.
const fmt = (n: number) => n.toLocaleString('en-US')
const fmtSeconds = (s: number) => (s < 1 ? s.toFixed(2) : s.toFixed(1))

// Tiles carry no data attributes (the HTML ships ~130 of them): the block number is the href's tail.
const blockOf = (e: SyntheticEvent) => {
  const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
  return href ? Number(href.slice('/blocks/'.length)) : null
}

// A label fits only on tiles at least ~120px wide (3.5s at 34px/s): ETH, never BNB.
const LABEL_MIN_SECONDS = 3.5

/**
 * Latest blocks as tiles: width = how long the block took, fill = gas used, newest at the right.
 * `tuples` is what the page's latest-blocks query returns, newest first (any order works).
 * Widths are pure CSS (app/globals.css, "Block tape"), so nothing here measures layout.
 */
export function BlockTape({ tuples, chainName }: { tuples: TapeTuple[]; chainName: string }) {
  const blocks = spreadSeconds(tuples) // oldest first, which is also left to right
  const rate = ratePerMin(tuples)
  const newest = blocks.length ? blocks[blocks.length - 1].n : null
  const [focusN, setFocusN] = useState<number | null>(null)
  const [activeN, setActiveN] = useState<number | null>(null)
  // Roving tabindex, kept by block number so a refresh that adds blocks cannot move it.
  const roving = focusN !== null && blocks.some(b => b.n === focusN) ? focusN : newest
  const active = blocks.find(b => b.n === activeN)

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!dir) return
    e.preventDefault()
    const li = (e.target as HTMLElement).closest('li')
    const a = (dir < 0 ? li?.previousElementSibling : li?.nextElementSibling)?.querySelector('a')
    // Older tiles run off the left edge; don't send focus to one nobody can see.
    if (a && a.getBoundingClientRect().right > 0) a.focus()
  }

  return (
    <div className="bg-card border-y border-hair">
      <div className="max-w-7xl mx-auto px-4 pt-3 flex items-center justify-between gap-4 min-h-[38px] font-mono text-xs text-mut">
        <span className="flex items-center min-w-0">
          <span className="mr-2 w-[9px] h-[9px] shrink-0 rounded-[2px] bg-acc" aria-hidden="true" />
          <span className="text-ink truncate">{chainName}</span>
        </span>
        <span className="flex gap-3 whitespace-nowrap">
          {newest !== null && <span>latest <span className="text-ink">#{fmt(newest)}</span></span>}
          {rate !== null && <span className="hidden min-[480px]:inline">{rate.toFixed(1)} blocks/min</span>}
        </span>
      </div>

      {blocks.length === 0 ? (
        <div className="bt-track">
          <p className="max-w-7xl mx-auto px-4 h-full flex items-center font-mono text-xs text-mut">No indexed blocks yet</p>
        </div>
      ) : (
        <div className="bt-track bt-fade max-w-7xl mx-auto px-4">
          <ul
            data-tape
            role="list"
            aria-label={`${chainName} latest indexed blocks`}
            className="bt-row"
            onKeyDown={onKeyDown}
            onMouseOver={e => setActiveN(blockOf(e))}
            onMouseLeave={() => setActiveN(null)}
            onFocus={e => { const n = blockOf(e); setFocusN(n); setActiveN(n) }}
            onBlur={() => setActiveN(null)}
          >
            {blocks.map(b => (
              <li key={b.n} style={{ '--s': +b.seconds.toFixed(3), '--g': `${b.gas}%` } as CSSProperties}>
                <a
                  href={`/blocks/${b.n}`}
                  tabIndex={b.n === roving ? 0 : -1}
                  aria-label={`Block ${fmt(b.n)}, ${b.txs} ${b.txs === 1 ? 'transaction' : 'transactions'}, gas ${b.gas}%`}
                >
                  {b.seconds >= LABEL_MIN_SECONDS && <span>#{fmt(b.n)}</span>}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-3 min-h-[60px] sm:min-h-[44px] font-mono text-xs leading-[18px] text-mut">
        <p data-readout aria-live="polite" className={active ? 'text-ink' : undefined}>
          {active ? `#${fmt(active.n)} · ${active.txs} txns · gas ${active.gas}% · ${fmtSeconds(active.seconds)} s` : LEGEND}
        </p>
      </div>
    </div>
  )
}
