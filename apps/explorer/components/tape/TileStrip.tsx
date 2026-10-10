'use client'
import { useEffect, useId, useState, type CSSProperties, type SyntheticEvent } from 'react'
import type { StripTile } from '@/lib/tape'
import { onArrowKeys } from './roving'

/**
 * A strip of tiles on the shared tape primitives (app/globals.css, "Tape primitives"), for /gas,
 * /validators, /dex and a token's top holders. The page decides what a tile is and how wide (`w`),
 * how full (`f`) and what it says (`read`); this draws them and makes the strip usable:
 *
 *  - ONE tab stop with the arrow keys (roving tabindex, components/tape/roving.ts), like the home tape.
 *    `entry` picks the tile the Tab lands on: the first (a ranking) or the last (the newest).
 *  - hovering or focusing a tile rings it and swaps its `read` line in for the legend (a polite live
 *    region), so the legend always states the exact measure and the readout the exact value.
 *  - `rowsId` pairs the strip with a table: a tile and a row are the same thing when the row's first
 *    link goes where the tile does (their lowercase hrefs match), and then hovering or focusing either
 *    rings both. The table stays whatever it was (server-rendered or not); this only listens to it.
 *
 * Tiles are bare `<li><a/></li>` with `--w` / `--f` variables, so the layout is pure CSS and nothing
 * here measures anything. A tile with no `href` (`rest`) is not a link and not a tab stop.
 * A tile is announced AND read out as `name · read`: that one string is its accessible name and its readout.
 */
/** A tile's identity within its strip: its id, else its lowercase href (what a table row's link is matched against), else its name. */
const keyOf = (t: StripTile) => t.id ?? t.href?.toLowerCase() ?? t.name
/** What a screen reader announces for the tile and what the legend line reads out while it is hovered or focused. */
const say = (t: StripTile) => `${t.name} · ${t.read}`

export function TileStrip({
  tiles, title, stats, label, legend, summary, entry = 'first', rowsId, bare,
}: {
  tiles: StripTile[]
  title: string
  stats?: { main: string; side?: string }
  /** The list's accessible name: what it is, and what width and fill mean. */
  label: string
  /** The exact measure, in at most two lines on a phone (test-support/legend-lines.ts). */
  legend: string
  /** The strip's text alternative, read with the list (aria-describedby). */
  summary: string
  entry?: 'first' | 'last'
  /** The id of the element holding the paired table. */
  rowsId?: string
  /** Inside a card that already has a frame: no band of its own, just a rule under it. */
  bare?: boolean
}) {
  const summaryId = useId()
  const [hover, setHover] = useState<string | null>(null)    // a tile the pointer or focus is on
  const [rowHot, setRowHot] = useState<string | null>(null)  // the row the pointer or focus is on
  const [rove, setRove] = useState<string | null>(null)      // the tab stop, once the user has moved it
  const hot = hover ?? rowHot

  // Pair with the table: its rows report the link they carry; the row that is `hot` is marked for the CSS.
  useEffect(() => {
    const root = rowsId ? document.getElementById(rowsId) : null
    if (!root) return
    const linkOf = (t: EventTarget | null) =>
      (t as Element | null)?.closest?.('tbody tr')?.querySelector('a')?.getAttribute('href')?.toLowerCase() ?? null
    const on = (e: Event) => setRowHot(linkOf(e.target))
    const off = () => setRowHot(null)
    root.addEventListener('mouseover', on)
    root.addEventListener('focusin', on)
    root.addEventListener('mouseleave', off)
    root.addEventListener('focusout', off)
    return () => {
      for (const [ev, fn] of [['mouseover', on], ['focusin', on], ['mouseleave', off], ['focusout', off]] as const) root.removeEventListener(ev, fn)
    }
  }, [rowsId])
  useEffect(() => {
    const root = rowsId ? document.getElementById(rowsId) : null
    if (!root) return
    for (const tr of root.querySelectorAll('tbody tr')) {
      const mine = hot !== null && tr.querySelector('a')?.getAttribute('href')?.toLowerCase() === hot
      if (mine) tr.setAttribute('data-hot', '')
      else tr.removeAttribute('data-hot')
    }
  }, [rowsId, hot])

  if (tiles.length === 0) return null

  const linked = tiles.filter(t => t.href)
  const entryTile = entry === 'last' ? linked[linked.length - 1] : linked[0]
  const entryId = entryTile && keyOf(entryTile)
  const stop = rove !== null && linked.some(t => keyOf(t) === rove) ? rove : entryId
  const active = tiles.find(t => keyOf(t) === hot)
  const idOf = (e: SyntheticEvent) => {
    const li = (e.target as HTMLElement).closest('li')
    const i = li?.parentElement ? Array.prototype.indexOf.call(li.parentElement.children, li) : -1
    return tiles[i] ? keyOf(tiles[i]) : null
  }

  return (
    <div className={bare ? 'border-b border-hair' : 'tp-box'}>
      <div className="tp-head">
        <span className="flex items-center min-w-0">
          <span className="tp-dot" aria-hidden="true" />
          <span className="text-ink truncate">{title}</span>
        </span>
        {stats && (
          <span className="tp-stats">
            <span>{stats.main}</span>
            {stats.side && <span className="tp-rate">{stats.side}</span>}
          </span>
        )}
      </div>
      <div className="tp-track max-w-7xl mx-auto px-4">
        <ul
          data-tape
          role="list"
          aria-label={label}
          aria-describedby={summaryId}
          className="tp-row tp-gap"
          onKeyDown={onArrowKeys}
          onMouseOver={e => setHover(idOf(e))}
          onMouseLeave={() => setHover(null)}
          onFocus={e => { const id = idOf(e); setRove(id); setHover(id) }}
          onBlur={() => setHover(null)}
        >
          {tiles.map(t => {
            const key = keyOf(t)
            const on = key === hot ? '' : undefined
            return (
              <li
                key={key}
                className={t.hatch ? 'h' : t.rest ? 'r' : undefined}
                style={{ '--w': t.w, '--f': `${t.f}%` } as CSSProperties}
              >
                {t.href ? (
                  <a href={t.href} tabIndex={key === stop ? 0 : -1} aria-label={say(t)} data-hot={on} />
                ) : (
                  <i role="img" aria-label={say(t)} data-hot={on} />
                )}
              </li>
            )
          })}
        </ul>
      </div>
      <p id={summaryId} className="sr-only">{summary}</p>
      <div className="tp-leg">
        <p data-readout aria-live="polite" className={active ? 'text-ink' : undefined}>
          {active ? say(active) : legend}
        </p>
      </div>
    </div>
  )
}
