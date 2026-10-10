import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const { SearchBar } = await import('./SearchBar')
const html = renderToStaticMarkup(createElement(SearchBar, { label: 'Search' }))

// What a visitor gets before any script runs (or with none): the server-rendered form.
describe('SearchBar server markup', () => {
  it('is a plain GET form to /search with a named field, so it works without JavaScript', () => {
    expect(html).toMatch(/<form [^>]*action="\/search"/)
    expect(html).toMatch(/<form [^>]*method="get"/)
    expect(html).toMatch(/<input [^>]*name="q"/)
    expect(html).toContain('<button type="submit">Search</button>')
  })

  it('is a closed combobox: the popup it will open is not in the page until the field is used', () => {
    expect(html).toMatch(/<input [^>]*role="combobox"/)
    expect(html).toMatch(/<input [^>]*aria-expanded="false"/)
    expect(html).toMatch(/<input [^>]*aria-autocomplete="list"/)
    expect(html).toMatch(/<input [^>]*autoComplete="off"|<input [^>]*autocomplete="off"/)
    expect(html).not.toContain('aria-controls')
    expect(html).not.toContain('role="listbox"')
  })
})
