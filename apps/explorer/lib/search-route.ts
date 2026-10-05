/**
 * Where a search-box query goes: a block, a tx, an address, or the token search page.
 * Pure so the box (components/layout/SearchBar.tsx) and its tests share one definition.
 */
export function routeForQuery(raw: string): string | null {
  const q = raw.trim()
  if (!q) return null
  // Pasted block numbers arrive as "#125761128", "125,761,128" or "125 761 128".
  const body = q.startsWith('#') ? q.slice(1) : q
  if (/^\d+(?:[,_ ]+\d+)*$/.test(body)) return `/blocks/${body.replace(/[,_ ]/g, '')}`
  // Hex keeps its case; a missing 0x is added, an 0X is lowercased.
  const hex = /^(?:0[xX])?([0-9a-fA-F]+)$/.exec(body)?.[1]
  if (hex?.length === 64) return `/tx/0x${hex}`
  if (hex?.length === 40) return `/address/0x${hex}`
  return `/search?q=${encodeURIComponent(q)}`
}
