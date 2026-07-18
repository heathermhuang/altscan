import { describe, expect, it } from 'vitest'
import { shouldEnqueueBackfill } from './backfill-trigger'

/**
 * The trigger's job under the R1 serve model is to WARM THE CACHE FOR
 * PAGINATION — enqueue on a first human view so that by the time the user pages
 * past the live head, the deep tail is already local. It is deliberately not
 * "enqueue when the view is unservable": under R1 page 1 always comes live from
 * the provider, so no view is ever unservable in that sense.
 */
describe('shouldEnqueueBackfill', () => {
  const base = { backfillEnabled: true, isBot: false, watermarkExists: false }

  it('enqueues when enabled, human, and not already queued', () => {
    expect(shouldEnqueueBackfill(base)).toBe(true)
  })

  it('never enqueues when the flag is off — this is what makes A4b-1 ship dark', () => {
    expect(shouldEnqueueBackfill({ ...base, backfillEnabled: false })).toBe(false)
  })

  it('never enqueues for bots — crawlers must not trigger provider spend', () => {
    expect(shouldEnqueueBackfill({ ...base, isBot: true })).toBe(false)
  })

  it('does not re-enqueue when a watermark already exists', () => {
    expect(shouldEnqueueBackfill({ ...base, watermarkExists: true })).toBe(false)
  })

  it('every negative condition independently vetoes', () => {
    // Guards against someone refactoring `&&` into `||`.
    const combos = [
      { backfillEnabled: false, isBot: false, watermarkExists: false },
      { backfillEnabled: true, isBot: true, watermarkExists: false },
      { backfillEnabled: true, isBot: false, watermarkExists: true },
      { backfillEnabled: false, isBot: true, watermarkExists: true },
    ]
    for (const c of combos) expect(shouldEnqueueBackfill(c)).toBe(false)
  })
})
