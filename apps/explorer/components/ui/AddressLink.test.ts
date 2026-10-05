import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddressLink } from './AddressLink'

const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const html = (props: { title?: boolean; plain?: boolean } = {}) =>
  renderToStaticMarkup(createElement(AddressLink, { address: ADDR.toLowerCase(), ...props }))

describe('AddressLink title', () => {
  it('carries the full checksummed address in a title by default', () => {
    expect(html()).toContain(`title="${ADDR}"`)
  })

  it('title={false} drops it (list tables, where it is per-row bytes) but keeps the href', () => {
    const h = html({ title: false })
    expect(h).not.toContain('title=')
    expect(h).toContain(`href="/address/${ADDR.toLowerCase()}"`)
    expect(h).toContain('0x5aAeb6…BeAed')
  })
})

describe('AddressLink plain', () => {
  it('carries its own accent, hover and mono classes by default', () => {
    expect(html()).toContain('class="text-acc-ink hover:underline font-mono ')
  })

  it('plain leaves them to the container: no class attribute at all', () => {
    const h = html({ plain: true })
    expect(h).not.toContain('class=')
    expect(h).toContain(`href="/address/${ADDR.toLowerCase()}"`)
  })
})
