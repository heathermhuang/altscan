'use client'
import { useState, type CSSProperties, type KeyboardEvent, type SyntheticEvent } from 'react'
import { chipFraction, decodeTape, ratePerMin, tapeBlocks, tapeWeight, type TapeBlock } from '@/lib/tape'

const LEGEND = 'width = transactions · fill = gas used · newest on the right'
// Kept to two lines at 320px (.tp-leg is two lines tall there): a third line would make the band jump when the
// hover / focus readout swaps in. "at right", not "on the right", is what keeps the ring in.
const LEGEND_CUR = 'width = transactions · fill = gas used · ringed = this block · newest at right'

// Fixed locale: the same string on server and client, so hydration cannot mismatch.
const fmt = (n: number) => n.toLocaleString('en-US')

/**
 * What hovering or focusing a tile announces. No per-block time: BNB blocks share whole-second
 * timestamps, so a block's own duration would be an interpolation, and a number is real or labelled.
 */
export const readout = (b: TapeBlock) => `#${fmt(b.n)} · ${b.txs} txns · gas ${b.gas}%`

// Tiles carry no data attributes (the HTML ships ~40 of them): the block number is the href's tail.
const blockOf = (e: SyntheticEvent) => {
  const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
  return href ? Number(href.slice('/blocks/'.length)) : null
}

/**
 * Blocks as tiles: width = transactions, fill = gas used (% of the limit), newest at the right.
 * `tape` is the page's blocks query in `encodeTape` form (any order works); the page decides how
 * many blocks (lib/tape.ts: TAPE_LATEST, TAPE_BEFORE, TAPE_AFTER) and the tiles share the track,
 * so the tape fills it at any width and nothing scrolls or clips.
 * `current` rings one block and makes it the first tab stop (the block's own page); `heading`
 * replaces the header's "latest #N" (e.g. "around #N", or "as of 21:04 UTC" on a cached page).
 * Widths are pure CSS (app/globals.css, "Tape primitives"): each tile's flex-grow is `--w`, so
 * nothing here measures layout. Every cell is a real block; there are no placeholder cells.
 */
export function BlockTape({ tape, chainName, current, heading }: { tape: string; chainName: string; current?: number; heading?: string }) {
  const tuples = decodeTape(tape)
  const blocks = tapeBlocks(tuples) // oldest first, which is also left to right
  const rate = ratePerMin(tuples)
  const newest = blocks.length ? blocks[blocks.length - 1].n : null
  const [focusN, setFocusN] = useState<number | null>(null)
  const [activeN, setActiveN] = useState<number | null>(null)
  // `current` can be absent from the drawn tiles (outside the window the page asked for).
  const currentN = current !== undefined && blocks.some(b => b.n === current) ? current : null
  const weights = blocks.map(b => tapeWeight(b.txs))
  // Roving tabindex, kept by block number so a refresh that adds blocks cannot move it.
  const roving = focusN !== null && blocks.some(b => b.n === focusN) ? focusN : currentN ?? newest
  const active = blocks.find(b => b.n === activeN)

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!dir) return
    e.preventDefault()
    const li = (e.target as HTMLElement).closest('li')
    // No neighbour at the oldest and newest tile, so focus stops there.
    const a = (dir < 0 ? li?.previousElementSibling : li?.nextElementSibling)?.querySelector('a')
    a?.focus()
  }

  return (
    <div className="tp-box">
      <div className="tp-head">
        <span className="flex items-center min-w-0">
          <span className="tp-dot" aria-hidden="true" />
          <span className="text-ink truncate">{chainName}</span>
        </span>
        <span className="tp-stats">
          {heading ? (
            <span className="text-ink">{heading}</span>
          ) : (
            newest !== null && <span>latest <span className="text-ink">#{fmt(newest)}</span></span>
          )}
          {rate !== null && <span className="tp-rate">{rate.toFixed(1)} blocks/min</span>}
        </span>
      </div>

      {blocks.length === 0 ? (
        <div className="tp-track">
          <p className="max-w-7xl mx-auto px-4 h-full flex items-center font-mono text-xs text-mut">No indexed blocks yet</p>
        </div>
      ) : (
        <div className={`tp-track max-w-7xl mx-auto px-4${currentN !== null ? ' tp-cur' : ''}`}>
          <ul
            data-tape
            role="list"
            aria-label={`${chainName} ${current !== undefined ? 'indexed blocks around this one' : heading ? 'recent indexed blocks' : 'latest indexed blocks'}, width is transactions, fill is gas used`}
            className="tp-row tp-gap"
            onKeyDown={onKeyDown}
            onMouseOver={e => setActiveN(blockOf(e))}
            onMouseLeave={() => setActiveN(null)}
            onFocus={e => { const n = blockOf(e); setFocusN(n); setActiveN(n) }}
            onBlur={() => setActiveN(null)}
          >
            {blocks.map((b, k) => {
              const isCurrent = b.n === currentN
              return (
                <li
                  key={b.n}
                  className={isCurrent ? 'c' : undefined}
                  style={{ '--w': weights[k], '--f': `${b.gas}%` } as CSSProperties}
                >
                  <a
                    href={`/blocks/${b.n}`}
                    tabIndex={b.n === roving ? 0 : -1}
                    aria-current={isCurrent ? 'true' : undefined}
                    // Just the number: the live readout below announces txns and gas on focus.
                    aria-label={`Block ${fmt(b.n)}`}
                  />
                  {/* The ringed tile's label floats above the row, placed by --p so it never leaves the track. */}
                  {isCurrent && (
                    <span className="tp-chip bt-chip" style={{ '--p': +chipFraction(weights, k).toFixed(3) } as CSSProperties} aria-hidden="true">
                      #{fmt(b.n)}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className="tp-leg">
        <p data-readout aria-live="polite" className={active ? 'text-ink' : undefined}>
          {active ? readout(active) : currentN !== null ? LEGEND_CUR : LEGEND}
        </p>
      </div>
    </div>
  )
}
