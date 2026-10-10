/**
 * The `@media <query> { ... }` block that starts at or after `from` in `css`, braces balanced (a rule
 * block or a nested at-rule inside it does not end it early). For tests that pin which selectors live
 * inside a media query. Throws if there is no such block.
 */
export function mediaBlock(css: string, query: string, from = 0): string {
  const open = css.indexOf(`@media ${query}`, from)
  if (open < 0) throw new Error(`no @media ${query} after ${from}`)
  let depth = 0
  for (let i = css.indexOf('{', open); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open, i + 1)
  }
  throw new Error(`unbalanced @media ${query}`)
}
