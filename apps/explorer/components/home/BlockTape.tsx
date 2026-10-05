'use client'
import { useState, type CSSProperties, type KeyboardEvent, type SyntheticEvent } from 'react'
import { decodeTape, meanSeconds, ratePerMin, spreadSeconds } from '@/lib/tape'

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
 * Blocks as tiles: width = how long the block took, fill = gas used, newest at the right.
 * `tape` is the page's blocks query in `encodeTape` form (any order works).
 * `current` outlines one block and makes it the first tab stop (the block's own page); `heading`
 * replaces the header's "latest #N" (e.g. "around #N", or "as of 21:04 UTC" on a cached page).
 * Widths are pure CSS (app/globals.css, "Block tape"), so nothing here measures layout.
 */
export function BlockTape({ tape, chainName, current, heading }: { tape: string; chainName: string; current?: number; heading?: string }) {
  const tuples = decodeTape(tape)
  const blocks = spreadSeconds(tuples) // oldest first, which is also left to right
  const rate = ratePerMin(tuples)
  const newest = blocks.length ? blocks[blocks.length - 1].n : null
  const avg = meanSeconds(blocks)
  const [focusN, setFocusN] = useState<number | null>(null)
  const [activeN, setActiveN] = useState<number | null>(null)
  // `current` can be absent from the drawn tiles (a block that only anchors the oldest second).
  const currentN = current !== undefined && blocks.some(b => b.n === current) ? current : null
  // Roving tabindex, kept by block number so a refresh that adds blocks cannot move it.
  const roving = focusN !== null && blocks.some(b => b.n === focusN) ? focusN : currentN ?? newest
  const active = blocks.find(b => b.n === activeN)

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!dir) return
    e.preventDefault()
    const li = (e.target as HTMLElement).closest('li')
    // The decorative lead-in <li> has no <a>, so ArrowLeft stops at the oldest real tile.
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
          {heading ? (
            <span className="text-ink">{heading}</span>
          ) : (
            newest !== null && <span>latest <span className="text-ink">#{fmt(newest)}</span></span>
          )}
          {rate !== null && <span className="hidden min-[480px]:inline">{rate.toFixed(1)} blocks/min</span>}
        </span>
      </div>

      {blocks.length === 0 ? (
        <div className="bt-track">
          <p className="max-w-7xl mx-auto px-4 h-full flex items-center font-mono text-xs text-mut">No indexed blocks yet</p>
        </div>
      ) : (
        <div className={`bt-track bt-fade max-w-7xl mx-auto px-4${currentN !== null ? ' bt-has-cur' : ''}`}>
          <ul
            data-tape
            role="list"
            aria-label={`${chainName} ${current !== undefined ? 'indexed blocks around this one' : heading ? 'recent indexed blocks' : 'latest indexed blocks'}`}
            className="bt-row"
            style={{ '--avg': +avg.toFixed(3) } as CSSProperties}
            onKeyDown={onKeyDown}
            onMouseOver={e => setActiveN(blockOf(e))}
            onMouseLeave={() => setActiveN(null)}
            onFocus={e => { const n = blockOf(e); setFocusN(n); setActiveN(n) }}
            onBlur={() => setActiveN(null)}
          >
            {/* Ghost tiles fill the track left of the oldest block, so a short tape has no hole. */}
            <li aria-hidden="true" className="bt-ghost" />
            {blocks.map(b => {
              const isCurrent = b.n === currentN
              return (
                <li
                  key={b.n}
                  className={isCurrent ? 'bt-cur' : undefined}
                  style={{ '--s': +b.seconds.toFixed(3), '--g': `${b.gas}%` } as CSSProperties}
                >
                  <a
                    href={`/blocks/${b.n}`}
                    tabIndex={b.n === roving ? 0 : -1}
                    aria-current={isCurrent ? 'true' : undefined}
                    // Just the number: the live readout below announces txns, gas and time on focus.
                    aria-label={`Block ${fmt(b.n)}`}
                  >
                    {!isCurrent && b.seconds >= LABEL_MIN_SECONDS && <span>#{fmt(b.n)}</span>}
                  </a>
                  {/* The current tile's label sits above it, outside the tile's clip, so it shows at any width. */}
                  {isCurrent && <span className="bt-chip" aria-hidden="true">#{fmt(b.n)}</span>}
                </li>
              )
            })}
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
