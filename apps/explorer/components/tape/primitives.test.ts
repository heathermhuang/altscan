import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddressLedger, AddressLedgerShell } from './AddressLedger'
import { BlockStrip } from './BlockStrip'
import { TileStrip } from './TileStrip'
import { BlockTape } from '@/components/home/BlockTape'
import { encodeTape } from '@/lib/tape'

// The block tape, the block / tx strip and the address ledger are drawn from ONE set of .tp-*
// primitives (app/globals.css, "Tape primitives"). These pin that: every class the three render
// exists in the stylesheet, the per-component duplicates that were folded in stay gone, and nothing
// in the tape CSS fades (a fade belongs to placeholder cells, and the tape has none).
const css = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8')
// The slice is between two comment markers; if either is renamed, indexOf is -1 and the assertions below would
// pass on an empty or wrong string. So a missing or misordered marker throws, and a test checks what was sliced.
function between(from: string, to: string): string {
  const i = css.indexOf(from)
  const j = css.indexOf(to)
  if (i < 0 || j <= i) throw new Error(`primitives.test.ts: CSS markers moved ("${from}" at ${i}, "${to}" at ${j})`)
  return css.slice(i, j)
}
const tapeCss = between('/* Tape primitives', '/* Block strip (')   // primitives + the block tape's own rules

const markup = [
  renderToStaticMarkup(createElement(BlockTape, { tape: encodeTape([[10, 1000, 2, 10], [11, 1001, 3, 20], [12, 1002, 4, 30]]), chainName: 'BNB Chain', current: 11 })),
  renderToStaticMarkup(createElement(BlockStrip, {
    txs: [{ i: 0, gas: 21_000, price: 5e7, ok: true }, { i: 1, gas: 50_000, price: 1e9, ok: false }],
    blockNumber: 7, gasLimit: 1_000_000, chainName: 'BNB Chain', current: 1,
  })),
  renderToStaticMarkup(createElement(AddressLedger, {
    rows: [{ t: 100, dir: 'in', native: true, spam: false }, { t: 103, dir: 'out', native: false, spam: true }],
    currency: 'BNB',
  })),
  renderToStaticMarkup(createElement(AddressLedgerShell, { currency: 'BNB' })),
  renderToStaticMarkup(createElement(TileStrip, {
    tiles: [{ id: 'a', href: '/a', w: 1, f: 50, name: 'A', read: 'A' }, { id: 'b', w: 1, f: 0, name: 'B', read: 'B', rest: true }],
    title: 'T', label: 'L', legend: 'G', summary: 'S',
  })),
].join('')
const classes = new Set([...markup.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)))

describe('shared tape primitives', () => {
  it('slices the whole tape section: the primitives and the block tape\'s own rules, none of the strip or ledger', () => {
    expect(tapeCss.length).toBeGreaterThan(2000)
    for (const rule of ['.tp-box {', '.tp-row {', '.tp-chip {', '.tp-gap > li {', '.bt-chip {']) expect(tapeCss, rule).toContain(rule)
    for (const rule of ['.bs-row', '.ldg-row']) expect(tapeCss, rule).not.toContain(rule)
  })

  it('has a rule for every tape class the three components render', () => {
    const tape = [...classes].filter(c => /^(tp|bt|bs|ldg)-/.test(c))
    expect(tape.length).toBeGreaterThan(10)
    for (const c of tape) expect(css, `.${c}`).toMatch(new RegExp(`\\.${c}(?![\\w-])`))
  })

  it('draws the band, header, track, row, label and legend of all three from .tp-*', () => {
    for (const c of ['tp-box', 'tp-head', 'tp-dot', 'tp-rate', 'tp-track', 'tp-row', 'tp-chip', 'tp-leg']) expect(classes, c).toContain(c)
    // the ledger has no track, row or label of its own to share, but its band chrome is shared
    const ledger = renderToStaticMarkup(createElement(AddressLedger, {
      rows: [{ t: 100, dir: 'in', native: true, spam: false }, { t: 103, dir: 'out', native: false, spam: true }], currency: 'BNB',
    }))
    for (const c of ['tp-head', 'tp-dot', 'tp-rate', 'tp-leg']) expect(ledger, c).toContain(c)
  })

  it('no longer carries the per-component copies that were folded into the primitives', () => {
    const retired = ['bt-box', 'bt-head', 'bt-dot', 'bt-stats', 'bt-rate', 'bt-leg', 'bt-track', 'bt-row', 'bt-has-cur', 'bs-track', 'bs-has-cur', 'ldg-leg', 'bt-ghost', 'bt-cur']
    for (const c of retired) {
      expect(css, `.${c}`).not.toMatch(new RegExp(`\\.${c}(?![\\w-])`))
      expect(classes, c).not.toContain(c)
    }
  })

  it('fades nothing: no mask in the tape CSS, and no placeholder cells to put one on', () => {
    expect(tapeCss).not.toMatch(/mask/)
    expect(tapeCss).not.toMatch(/opacity:\s*0?\.\d+/)
    expect(css).not.toMatch(/\.bt-fade/)
  })

  it('keeps a floor under every tile (2px) and the ringed one (3px), so a block with few transactions never vanishes', () => {
    expect(tapeCss).toMatch(/\.tp-gap > li\s*{[^}]*min-width:\s*2px/)
    expect(tapeCss).toMatch(/\.tp-row > \.c\s*{[^}]*min-width:\s*3px/)
  })

  it('clamps the ringed block\'s label by its own width, so no px or viewport maths can leave the track', () => {
    expect(tapeCss).toMatch(/\.bt-chip\s*{[^}]*left:\s*calc\(var\(--q\) \* 100%\)[^}]*transform:\s*translateX\(calc\(var\(--q\) \* -100%\)\)/)
  })

  it('picks the label\'s fraction (--q) from the phone reference (--p-sm), and the desktop one (--p) from the sm breakpoint up', () => {
    expect(tapeCss).toMatch(/\.bt-chip\s*{[^}]*--q:\s*var\(--p-sm(?:,\s*var\(--p\))?\)/)
    expect(tapeCss).toMatch(/@media \(min-width: 640px\)\s*{\s*\.bt-chip\s*{\s*--q:\s*var\(--p\);?\s*}/)
    expect(tapeCss).toMatch(/\.bt-chip::after\s*{[^}]*left:\s*clamp\(4px,\s*calc\(var\(--q\) \* 100%\),\s*calc\(100% - 4px\)\)/)
  })
})

// The tile strip (/gas, /validators, /dex, a token's holders) is drawn from the same primitives, plus a
// few rules of its own for the two tiles that are not a plain measurement.
const stripCss = between('/* Tile strip (', '/* Loading skeleton (')

describe('tile strip on the primitives', () => {
  it('draws its band, track, row and legend from .tp-*', () => {
    const strip = renderToStaticMarkup(createElement(TileStrip, {
      tiles: [{ id: 'a', href: '/a', w: 1, f: 50, name: 'A', read: 'A' }], title: 'T', label: 'L', legend: 'G', summary: 'S',
    }))
    for (const c of ['tp-box', 'tp-head', 'tp-dot', 'tp-track', 'tp-row tp-gap', 'tp-leg']) expect(strip, c).toContain(c)
  })

  it('draws the hatched tile at a fixed floor (8px) and the remainder neutral, neither with the accent fill', () => {
    expect(stripCss).toMatch(/\.tp-gap > li\.h\s*{[^}]*min-width:\s*8px/)
    expect(stripCss).toMatch(/\.tp-gap > li\.h :is\(a, i\)\s*{[^}]*repeating-linear-gradient/)
    expect(stripCss).toMatch(/\.tp-gap > li\.r i\s*{[^}]*background:\s*var\(--hair3\)/)
    expect(stripCss).toMatch(/\.tp-gap > li:is\(\.h, \.r\) :is\(a, i\)::before\s*{[^}]*display:\s*none/)
  })

  it('rings a paired tile by [data-hot] with the same ring a hovered one gets, and shades its table row', () => {
    expect(tapeCss).toMatch(/\.tp-gap :is\(a, i\)\[data-hot\]\s*{[^}]*outline:\s*2px solid var\(--ink\)/)
    expect(tapeCss).toMatch(/\.tp-row a:hover,[^{]*\.tp-gap :is\(a, i\)\[data-hot\]/)
    expect(stripCss).toMatch(/\.dt tbody tr\[data-hot\]\s*{[^}]*background:\s*var\(--bg\)/)
  })

  it('redraws the hatch in system colours under forced colours, where the backgrounds are dropped', () => {
    expect(stripCss).toMatch(/forced-colors: active\)\s*{\s*\.tp-gap > li\.h :is\(a, i\)\s*{[^}]*CanvasText[^}]*Canvas /)
  })

  it('keeps the remainder (an <i>) as round and clipped as a linked tile', () => {
    expect(tapeCss).toMatch(/\.tp-gap :is\(a, i\)\s*{[^}]*overflow:\s*hidden;[^}]*border-radius:\s*3px/)
  })
})

