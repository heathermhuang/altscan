import { describe, expect, it } from 'vitest'
import { gaMeasurementId } from './analytics'

const env = (v: string | undefined) => ({ GA_MEASUREMENT_ID: v }) as unknown as NodeJS.ProcessEnv

describe('gaMeasurementId', () => {
  it('returns the configured ID, trimmed', () => {
    expect(gaMeasurementId(env('G-BCLL9EVN8Z'))).toBe('G-BCLL9EVN8Z')
    expect(gaMeasurementId(env('  G-DRSRLLSRMC\n'))).toBe('G-DRSRLLSRMC')
  })

  it('has no built-in ID: unset or blank means no analytics', () => {
    expect(gaMeasurementId({} as NodeJS.ProcessEnv)).toBeNull()
    expect(gaMeasurementId(env(''))).toBeNull()
    expect(gaMeasurementId(env('   '))).toBeNull()
  })

  it('refuses anything that could break out of the inline script', () => {
    for (const v of ["G-ABC');alert(1);('", 'G-ABC</script>', 'UA-12345-1', 'g-lowercase', 'G-', 'G-ABC DEF']) {
      expect(gaMeasurementId(env(v)), v).toBeNull()
    }
  })
})
