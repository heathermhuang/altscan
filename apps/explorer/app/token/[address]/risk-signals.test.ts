import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import type { RiskSignal } from '@/lib/token-risk'
import { RiskSignals } from './RiskSignals'

// A green check with "Pass: " says the explorer looked and found nothing. A signal it could not check (lib/token-risk)
// is drawn with the neutral info icon and read "Not checked: " to a screen reader.
const html = (signals: RiskSignal[]) => renderToStaticMarkup(createElement(RiskSignals, { signals }))
const pass: RiskSignal = { label: 'Mint Function', ok: true, description: 'No mint function detected', severity: 'info' }
const unchecked: RiskSignal = { label: 'Blacklist', ok: false, unknown: true, description: 'No verified ABI, so this was not checked', severity: 'info' }
const card = (out: string, label: string) => out.split('<div class="flex items-start').find((c) => c.includes(label)) ?? ''

describe('RiskSignals', () => {
  it('draws a checked pass with the check icon and "Pass: "', () => {
    const c = card(html([pass, unchecked]), 'Mint Function')
    expect(c).toContain('Pass: </span>Mint Function')
    expect(c).toContain('text-live')
  })

  it('draws a signal that was not checked neutral, read "Not checked: ", with no pass wording and no green', () => {
    const c = card(html([pass, unchecked]), 'Blacklist')
    expect(c).toContain('Not checked: </span>Blacklist')
    expect(c).toContain('No verified ABI, so this was not checked')
    expect(c).not.toContain('Pass:')
    expect(c).not.toContain('text-live')
    expect(c).not.toContain('text-warn')
    // the info glyph (a circle with an "i"), not the check mark
    expect(c).toContain('M12 16v-4M12 8h.01')
    expect(c).not.toContain('m8 12 3 3 5-6')
  })

  it('renders nothing for no signals', () => {
    expect(html([])).toBe('')
  })
})
