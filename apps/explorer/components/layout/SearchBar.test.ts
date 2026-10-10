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

  // Before the typeahead loads (first focus), with no JS, or after a failed chunk load there is no popup, so the field
  // must not announce itself as a combobox. SearchSuggest's load adds the combobox attributes (verified in a browser).
  it('is a plain search field: no combobox role or popup attributes until the typeahead has loaded', () => {
    expect(html).toMatch(/<input [^>]*type="text"/)
    expect(html).not.toContain('role="combobox"')
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('aria-autocomplete')
    expect(html).not.toContain('aria-controls')
    expect(html).not.toContain('aria-activedescendant')
    expect(html).not.toContain('role="listbox"')
  })

  it('still turns the browser autofill popup off, which would overlap the list', () => {
    expect(html).toMatch(/<input [^>]*autoComplete="off"|<input [^>]*autocomplete="off"/)
  })
})
