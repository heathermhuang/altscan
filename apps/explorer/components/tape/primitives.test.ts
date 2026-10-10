import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddressLedger, AddressLedgerShell } from './AddressLedger'
import { BlockStrip } from './BlockStrip'
import { BlockTape } from '@/components/home/BlockTape'
import { encodeTape } from '@/lib/tape'

// The block tape, the block / tx strip and the address ledger are drawn from ONE set of .tp-*
// primitives (app/globals.css, "Tape primitives"). These pin that: every class the three render
// exists in the stylesheet, the per-component duplicates that were folded in stay gone, and nothing
// in the tape CSS fades (a fade belongs to placeholder cells, and the tape has none).
const css = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8')
const tapeCss = css.slice(css.indexOf('/* Tape primitives'), css.indexOf('/* Block strip ('))   // primitives + the block tape's own rules

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
].join('')
const classes = new Set([...markup.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)))

describe('shared tape primitives', () => {
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

  it('clamps the ringed block\'s label by its own width, so no px or viewport maths can leave the track', () => {
    expect(tapeCss).toMatch(/\.bt-chip\s*{[^}]*left:\s*calc\(var\(--p\) \* 100%\)[^}]*transform:\s*translateX\(calc\(var\(--p\) \* -100%\)\)/)
  })
})
