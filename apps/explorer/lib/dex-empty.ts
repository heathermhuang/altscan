/**
 * What the /dex trades table says when it has no rows. A failed query and a chain with no indexed swaps look
 * identical to the table (zero rows) but are opposite claims, so the page tracks the failure and this picks the
 * words: "No DEX trades found" is only true when the read succeeded.
 */
export function dexEmptyState(failed: boolean, primaryDex: string): { title: string; detail: string } {
  if (failed) {
    return {
      title: 'DEX data is temporarily unavailable',
      detail: 'The trades could not be loaded just now. Try again in a minute.',
    }
  }
  return {
    title: 'No DEX trades found',
    detail: `Swaps from ${primaryDex} and compatible AMM pairs will appear here as they are indexed.`,
  }
}
