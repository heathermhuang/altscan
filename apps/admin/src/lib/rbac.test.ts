import { describe, expect, it } from 'vitest'
import { canWrite } from './rbac'

describe('rbac', () => {
  it('owner and admin can write; viewer cannot', () => {
    expect(canWrite('owner')).toBe(true)
    expect(canWrite('admin')).toBe(true)
    expect(canWrite('viewer')).toBe(false)
  })
})
