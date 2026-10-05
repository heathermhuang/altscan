import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AdSlot } from './AdSlot'

// AdSlot's first render is null on purpose, and it is what the server renders too. The page's
// footer AdSlot hydrates first and fills a module cache; a page AdSlot that rendered a card from
// that cache did not match the server HTML (React #418) and React client-rendered the page
// segment. AdReserve's reserved box (and its collapse marker) relies on the same invariant: the
// reserve is the ONLY thing the server HTML holds for an ad.
describe('AdSlot first render', () => {
  const cases = [
    ['card', 'home', 'home_after_stats'],
    ['compact', 'dex', 'dex_after_stats'],
    ['footer', 'footer', 'footer_strip'],
  ] as const

  it.each(cases)('emits nothing for the %s variant', (variant, context, placement) => {
    expect(renderToStaticMarkup(createElement(AdSlot, { context, placement, variant }))).toBe('')
  })

  it('emits nothing for the default (card) variant either', () => {
    expect(
      renderToStaticMarkup(createElement(AdSlot, { context: 'gas', placement: 'gas_top' })),
    ).toBe('')
  })
})
