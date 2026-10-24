/** Signatures are accepted within 5 minutes of the server clock, in either direction, for clock skew. */
export const SIG_MAX_SKEW_MS = 5 * 60 * 1000

/**
 * Why a key-request timestamp is unacceptable, or null when it is fine.
 *
 * The body is untyped JSON, so the type is checked here: a string such as
 * "never" made `Date.now() - timestamp` NaN, and `NaN > limit` is false, so that
 * signature passed the age check forever. A future timestamp did the same until
 * its date arrived. Both directions are bounded now.
 */
export function keyRequestTimestampError(timestamp: unknown, now = Date.now()): string | null {
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) {
    return 'timestamp must be an integer number of milliseconds since the epoch'
  }
  if (now - timestamp > SIG_MAX_SKEW_MS) return 'Signature expired'
  if (timestamp - now > SIG_MAX_SKEW_MS) return 'Signature timestamp is ahead of the server clock'
  return null
}
