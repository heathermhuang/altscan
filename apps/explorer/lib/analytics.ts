/**
 * The deployment's Google Analytics measurement ID, from GA_MEASUREMENT_ID; null
 * when unset or malformed, and then no analytics script loads. There is
 * deliberately no built-in ID: a fork that never sets one must not report its
 * visitors to someone else's property. The value is interpolated into an inline
 * script, so anything that isn't a plain `G-XXXX` ID is refused.
 */
export function gaMeasurementId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.GA_MEASUREMENT_ID?.trim()
  return id && /^G-[A-Z0-9]{4,20}$/.test(id) ? id : null
}
