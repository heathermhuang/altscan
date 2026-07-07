export type Role = 'owner' | 'admin' | 'viewer'

export function canWrite(role: Role): boolean {
  return role === 'owner' || role === 'admin'
}
