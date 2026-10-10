/**
 * `s` cut to at most `n` characters, with an ellipsis. For the names and symbols in a tile's readout, which anyone
 * can choose, so a readout can fit its two-line slot (the legend's, 60px on a phone). Cuts on characters, not UTF-16
 * units: a symbol ending in an emoji must not be left with half of it.
 */
export function clipText(s: string, n: number): string {
  const chars = Array.from(s)
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s
}
