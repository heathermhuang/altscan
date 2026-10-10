import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { TokenOption } from './SearchSuggest'

// The typeahead row is the only place a visitor sees the indexed holder count without a heading, so the visible text
// says what it is ("835,871 indexed"); the full sentence (a frozen snapshot) is the tooltip, which touch screens never show.
describe('typeahead token row', () => {
  const html = renderToStaticMarkup(createElement(TokenOption, { token: { address: '0x' + '1'.repeat(40), symbol: 'USDT', name: 'Tether USD', holders: 835871, lookalikeOf: null } }))

  it('carries the qualifier in the visible text', () => {
    expect(html).toContain('>835,871 indexed</span>')
    expect(html).not.toContain('>835,871 holders<')
    expect(html).not.toMatch(/>835,871<\/span>/)
  })

  it('holds the full sentence in the title', () => {
    expect(html).toMatch(/title="A snapshot from this explorer&#x27;s index\. Per-block holder tracking is off/)
  })

  it('still shows the symbol, the name and the lookalike badge', () => {
    const bad = renderToStaticMarkup(createElement(TokenOption, { token: { address: '0x' + '2'.repeat(40), symbol: 'USDT', name: 'Fake', holders: 3, lookalikeOf: 'USDT' } }))
    expect(html).toContain('>USDT</span>')
    expect(html).toContain('Tether USD')
    expect(bad).toContain('lookalike')
  })
})
