/**
 * "~a-b seconds" copy for the 1-3 block confirmation window.
 *
 * BNB's block time is sub-second (0.45), so a raw `${blockTime}-${blockTime * 3}`
 * renders "~0.45-1.35". Round values under 10s to the nearest 0.5 and the rest
 * to an integer: BNB reads "~0.5-1.5 seconds", ETH "~12-36 seconds".
 */
const roundSeconds = (s: number) => (s < 10 ? Math.round(s * 2) / 2 : Math.round(s))

export function confirmationWindow(blockTime: number): string {
  return `~${roundSeconds(blockTime)}-${roundSeconds(blockTime * 3)} seconds`
}
