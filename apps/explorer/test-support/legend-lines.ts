/**
 * TEST-ONLY (nothing in the app imports this). How many lines `text` takes in a monospace column `cols` wide,
 * breaking at spaces as the browser does. For tests of the tape legends and readouts: `.tp-leg` is two lines tall on a phone (60px), and hovering or focusing a
 * tile swaps a one-line readout in, so a legend that wraps to a third line makes the band, and everything
 * below it, jump by a line on that swap. At 320px the legend has 288px, which is 39 glyphs of 7.2px with a
 * sub-pixel of slack (40 would be exactly full).
 */
export function legendLines(text: string, cols = 39): number {
  let n = 1
  let used = 0
  for (const word of text.split(' ')) {
    if (used === 0) used = word.length
    else if (used + 1 + word.length <= cols) used += 1 + word.length
    else { n++; used = word.length }
  }
  return n
}
