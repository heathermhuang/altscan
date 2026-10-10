import { describe, expect, it } from 'vitest'
import { legendLines } from './legend-lines'

// The legend gates (gas, validators, dex, holders, home) are only worth anything if the model can SAY three.
describe('legendLines', () => {
  it('counts the lines a legend takes in a 39-column phone slot, breaking at spaces', () => {
    expect(legendLines('short')).toBe(1)
    expect(legendLines('width = transactions · fill = gas used · newest on the right')).toBe(2)
  })

  it('sees the 3-line legends that would make the band jump when the readout swaps in (the gate can fail)', () => {
    expect(legendLines('width = transactions · fill = gas used · ringed = this block · newest on the right')).toBe(3)
    expect(legendLines('width = USD size (stablecoins $1, BNB at market) · ▨ not priced · newest at right')).toBe(3)
    expect(legendLines('width = blocks produced, last 24h · fill = voting power, % of the largest here')).toBe(3)
  })

  it('moves a word that does not fit to the next line, and an unbreakable run is one line however long', () => {
    expect(legendLines('a'.repeat(39))).toBe(1)
    expect(legendLines(`${'a'.repeat(39)} b`)).toBe(2)
    expect(legendLines('x'.repeat(100))).toBe(1)
  })
})
