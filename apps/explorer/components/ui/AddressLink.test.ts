import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddressLink } from './AddressLink'

const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const html = (props: { title?: boolean; plain?: boolean; self?: boolean } = {}) =>
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

  it('plain + self still renders the self emphasis, over the container\'s accent', () => {
    const h = html({ plain: true, self: true })
    expect(h).toContain('class="text-ink font-semibold"')
    expect(h).not.toContain('font-mono')
    expect(h).not.toContain('hover:')
    expect(h).not.toContain('acc-ink')
  })

  it('self without plain is unchanged: emphasis, mono, no accent or hover', () => {
    const h = html({ self: true })
    expect(h).toContain('class="text-ink font-semibold font-mono ')
    expect(h).not.toContain('acc-ink')
    expect(h).not.toContain('hover:')
  })
})
