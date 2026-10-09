import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TxnsLazy } from './TxnsLazy'

// TxnsLazy starts in its loading state (effects do not run in a static render). The ledger shell is
// reserved there only when the page says a ledger can draw: a ledger needs >= 2 rows, so an address
// known to have exactly one transaction gets the plain skeleton (a shell would collapse on arrival).
const render = (reserveLedger: boolean) => renderToStaticMarkup(createElement(TxnsLazy, { addr: '0xabc', reserveLedger }))

describe('TxnsLazy loading state', () => {
  it('reserves the ledger card when a ledger can draw', () => {
    const h = render(true)
    expect(h).toContain('class="ldg animate-pulse"')
    expect(h.match(/h-9 bg-hair2/g)).toHaveLength(5)
  })
  it('keeps just the skeleton rows when it cannot', () => {
    const h = render(false)
    expect(h).not.toContain('ldg')
    expect(h.match(/h-9 bg-hair2/g)).toHaveLength(5)
  })
})
