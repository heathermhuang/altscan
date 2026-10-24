import { describe, expect, it } from 'vitest'
import { resolveEventTypes } from '@/lib/webhook-event-types'

describe('resolveEventTypes', () => {
  it('defaults to tx when nothing was asked', () => {
    expect(resolveEventTypes(undefined)).toEqual({ ok: true, eventTypes: ['tx'], ignoredEventTypes: [] })
    expect(resolveEventTypes(null)).toEqual({ ok: true, eventTypes: ['tx'], ignoredEventTypes: [] })
  })

  it('keeps tx and reports every other name as ignored, unknown ones included', () => {
    expect(resolveEventTypes(['token_transfer', 'tx', 'bogus', 'new_block']))
      .toEqual({ ok: true, eventTypes: ['tx'], ignoredEventTypes: ['token_transfer', 'bogus', 'new_block'] })
  })

  it('collapses duplicates', () => {
    expect(resolveEventTypes(['tx', 'tx', 'token_transfer', 'token_transfer']))
      .toEqual({ ok: true, eventTypes: ['tx'], ignoredEventTypes: ['token_transfer'] })
  })

  it('refuses a list that does not include tx', () => {
    for (const bad of [[], ['token_transfer'], ['new_block', 'bogus']]) {
      const r = resolveEventTypes(bad)
      expect(r.ok).toBe(false)
    }
  })

  it('refuses a non-array', () => {
    expect(resolveEventTypes('tx').ok).toBe(false)
    expect(resolveEventTypes({ 0: 'tx' }).ok).toBe(false)
  })
})
