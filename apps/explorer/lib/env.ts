/**
 * A positive whole number from the environment, or `fallback`.
 *
 * The explorer's tunables (rate ceilings, caps, cache sizes) are all this shape, and seven
 * sites parsed them by hand. Most did it this way; one used `parseInt(x ?? 'D', 10)`, which
 * reads "2h" as 2 and garbage as NaN, so a typo silently shrank a cache TTL to milliseconds
 * or turned a bound into a comparison that is always false. Anything that is not a positive
 * integer falls back.
 *
 * Read at call time, from the server's process.env. Not for NEXT_PUBLIC_* values, which
 * Next inlines at build time only when referenced literally.
 */
export function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}
