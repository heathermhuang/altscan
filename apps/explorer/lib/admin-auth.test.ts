import { afterEach, describe, expect, it, vi } from 'vitest'

// ADMIN_SECRET is read when the module loads, so each case imports it fresh.
async function load(secret: string | undefined) {
  vi.resetModules()
  if (secret === undefined) delete process.env.ADMIN_SECRET
  else process.env.ADMIN_SECRET = secret
  return (await import('./admin-auth')).isAdminRequest
}
const req = (authorization?: string) =>
  new Request('https://x.test/api/admin/db-prune', authorization ? { headers: { authorization } } : {})

describe('isAdminRequest', () => {
  const saved = process.env.ADMIN_SECRET
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_SECRET
    else process.env.ADMIN_SECRET = saved
  })

  it('refuses everything when ADMIN_SECRET is unset or empty — including a bare "Bearer "', async () => {
    for (const secret of [undefined, '']) {
      const isAdmin = await load(secret)
      expect(isAdmin(req())).toBe(false)
      expect(isAdmin(req('Bearer '))).toBe(false)
      expect(isAdmin(req('Bearer undefined'))).toBe(false)
    }
  })

  it('accepts only the exact bearer token', async () => {
    const isAdmin = await load('s3cret-value')
    expect(isAdmin(req('Bearer s3cret-value'))).toBe(true)
    expect(isAdmin(req('Bearer s3cret-valu'))).toBe(false)
    expect(isAdmin(req('bearer s3cret-value'))).toBe(false)
    expect(isAdmin(req('s3cret-value'))).toBe(false)
    expect(isAdmin(req())).toBe(false)
  })
})
