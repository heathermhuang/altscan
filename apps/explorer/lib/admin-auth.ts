import { timingSafeEqual } from 'node:crypto'

const ADMIN_SECRET = process.env.ADMIN_SECRET || ''

/** Constant-time Bearer ADMIN_SECRET check (same auth model as the existing
 *  admin endpoints; extracted for the settings routes). */
export function isAdminRequest(request: Request): boolean {
  if (!ADMIN_SECRET) return false
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${ADMIN_SECRET}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
