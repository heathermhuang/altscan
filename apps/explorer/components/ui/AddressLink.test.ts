import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddressLink } from './AddressLink'

const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const html = (props: { title?: boolean } = {}) =>
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
