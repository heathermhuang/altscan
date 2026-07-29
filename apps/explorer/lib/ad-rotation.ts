/**
 * Pick one candidate in proportion to its weight.
 *
 * `roll` is injected rather than read from Math.random() so the distribution is
 * provable in tests. The component passes Math.random() once per mount — the
 * roll deliberately does NOT happen server-side, because the ad-config response
 * is cached for 5 minutes per client, which would pin a visitor to one creative
 * for that whole window instead of rotating.
 */
export function pickWeighted<T extends { weight: number }>(candidates: T[], roll: number): T | null {
  if (candidates.length === 0) return null

  const total = candidates.reduce((sum, c) => sum + c.weight, 0)
  if (total <= 0) return candidates[0]

  // A NaN or out-of-range roll must still produce an ad, not a blank slot.
  const safeRoll = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999999) : 0
  let cursor = safeRoll * total

  for (const candidate of candidates) {
    cursor -= candidate.weight
    if (cursor < 0) return candidate
  }
  // Unreachable for finite weights; float drift falls through to the last one.
  return candidates[candidates.length - 1]
}
