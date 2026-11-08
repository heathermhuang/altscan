import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hasDirectionalControls, stripDirectionalControls } from './directional-controls'
import { tokenTextOr, tokenUnit } from './format'
import { TokenOption } from '@/components/layout/SearchSuggest'
import { NftRow } from '@/app/address/[address]/NftRow'
import { NftCard } from '@/app/address/[address]/NftsLazy'

// A deployer types Unicode direction controls into a name or symbol to make it DRAW as other text: U+202E + "TDSU" +
// U+202C renders as "USDT". Every place that prints that text as given strips them.
const CONTROLS = ['\u061C', '\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']
const ANY_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/
const RLO_TDSU = '\u202ETDSU\u202C'
const ADDR = '0x' + '5'.repeat(40)

describe('directional controls', () => {
  it.each(CONTROLS.map((c) => [`U+${c.codePointAt(0)!.toString(16).toUpperCase()}`, c]))('strips %s and detects it', (_label, c) => {
    expect(stripDirectionalControls(`A${c}B`)).toBe('AB')
    expect(hasDirectionalControls(`A${c}B`)).toBe(true)
  })

  // Only the reordering controls: real scripts need the rest.
  it.each([
    ['a zero-width joiner', 'a\u200Db'],
    ['a zero-width non-joiner', 'می\u200Cخواهم'],
    ['a variation selector', '❤\uFE0F'],
    ['a combining mark', 'Cafe\u0301'],
    ['Arabic mixed with Latin and digits', 'عملة USD 2'],
    ['Hebrew', 'מטבע'],
  ])('keeps %s', (_label, text) => {
    expect(stripDirectionalControls(text)).toBe(text)
    expect(hasDirectionalControls(text)).toBe(false)
  })

  it('is false for no text', () => {
    expect(hasDirectionalControls(null)).toBe(false)
    expect(hasDirectionalControls('')).toBe(false)
  })
})

describe('the verbatim token text helpers', () => {
  it('print U+202E + "TDSU" + U+202C as TDSU, the stored order', () => {
    expect(tokenTextOr(RLO_TDSU, '—')).toBe('TDSU')
    expect(tokenUnit(RLO_TDSU, ADDR)).toBe('TDSU')
  })

  it('read text made only of controls as missing', () => {
    expect(tokenTextOr('\u202E\u202C', '—')).toBe('—')
  })
})

// Client components print token text without lib/format: the search dropdown and the NFT tab's rows and cards.
describe('client print sites', () => {
  const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

  it('the search dropdown', () => {
    const out = html(createElement(TokenOption, { token: { address: ADDR, symbol: RLO_TDSU, name: '\u202Erehte\u202C', holders: 1, lookalikeOf: null } }))
    expect(out).toContain('<bdi>TDSU</bdi>')
    expect(out).toContain('<bdi>rehte</bdi>')
    expect(out).not.toMatch(ANY_CONTROL)
  })

  it('an NFT transfer row', () => {
    const t = { txHash: '0x' + 'a'.repeat(64), tokenAddress: ADDR, tokenId: '7', fromAddress: ADDR, toAddress: ADDR, blockNumber: 1, name: '\u202Eseipa\u202C', symbol: RLO_TDSU }
    const out = html(createElement('table', null, createElement('tbody', null, createElement(NftRow, { t, addr: ADDR }))))
    expect(out).toContain('<bdi>seipa</bdi>')
    expect(out).toContain('<bdi>TDSU</bdi>')
    expect(out).not.toMatch(ANY_CONTROL)
  })

  it('an NFT card, its alt text included', () => {
    const nft = { tokenAddress: ADDR, tokenId: '7', name: '\u202Eseipa\u202C', symbol: RLO_TDSU, imageUrl: 'https://x/a.png' }
    const out = html(createElement(NftCard, { nft: nft as never }))
    expect(out).toContain('alt="seipa"')
    expect(out).toContain('<bdi>seipa</bdi>')
    expect(out).toContain('<bdi>TDSU</bdi>')
    expect(out).not.toMatch(ANY_CONTROL)
  })
})
