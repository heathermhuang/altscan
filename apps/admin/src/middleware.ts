import { defineMiddleware } from 'astro:middleware'
import { eq } from 'drizzle-orm'
import { verifyAccessJwt } from './lib/access'
import { getDb } from './lib/db'
import { members } from './lib/schema'
import type { Role } from './lib/rbac'

export const onRequest = defineMiddleware(async (context, next) => {
  const env = context.locals.runtime.env

  let email: string | null = null
  if (import.meta.env.DEV && env.DEV_FAKE_EMAIL) {
    email = env.DEV_FAKE_EMAIL
  } else {
    // Fail CLOSED: no Access config in prod means no access at all.
    if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
      return new Response('Access is not configured for this deployment', { status: 503 })
    }
    const token = context.request.headers.get('cf-access-jwt-assertion')
    if (!token) return new Response('Unauthorized', { status: 401 })
    email = await verifyAccessJwt(token, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD)
    if (!email) return new Response('Unauthorized', { status: 401 })
  }

  const rows = await getDb(env).select().from(members).where(eq(members.email, email)).limit(1)
  const member = rows[0]
  if (!member) return new Response(`Forbidden: ${email} is not a member`, { status: 403 })

  context.locals.member = { email: member.email, role: member.role as Role, tenantId: member.tenantId }
  return next()
})
