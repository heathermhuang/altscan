import { describe, expect, it } from 'vitest'
import { canWrite, type Role } from './rbac'

describe('rbac', () => {
  it('owner and admin can write; viewer cannot', () => {
    expect(canWrite('owner')).toBe(true)
    expect(canWrite('admin')).toBe(true)
    expect(canWrite('viewer')).toBe(false)
  })

  // The console derives its read-only UI from !canWrite, so an unrecognised
  // role must be non-writable: a future role added to the DB before the code
  // knows about it renders read-only instead of Save-then-403.
  it('fails closed on a role the code does not recognise', () => {
    expect(canWrite('editor' as Role)).toBe(false)
    expect(canWrite('' as Role)).toBe(false)
  })
})
