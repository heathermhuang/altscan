import type { APIRoute } from 'astro'
import { getDb, getExplorer } from '../../../../../lib/db'
import { audit } from '../../../../../lib/schema'
import { canWrite } from '../../../../../lib/rbac'
import { json } from '../../../../../lib/http'
import { redactRpcValue } from '../../../../../lib/redact'
import { explorerAdminFetch } from '../../../../../lib/upstream'
import { ownsEveryCreativeKey, referencedCreativeKeys } from '../../../../../lib/creative-upload'

export const prerender = false

/** PUT proxy — RBAC-gated; injects the authenticated actor as updatedBy and
 *  records a console-side audit row on success. */
export const PUT: APIRoute = async ({ params, locals, request }) => {
  const env = locals.runtime.env
  if (!canWrite(locals.member.role)) return json({ error: 'forbidden: read-only role' }, 403)

  const explorer = await getExplorer(env, params.id!, locals.member.tenantId)
  if (!explorer) return json({ error: 'unknown explorer' }, 404)

  let body: { value?: unknown; expectedVersion?: number }
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return json({ error: 'body must be a JSON object' }, 400)
    }
    body = parsed as typeof body
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  // The upload route namespaces every key it mints, but this PUT takes an
  // arbitrary JSON body from a browser — so re-bind the value to this caller's
  // tenant and explorer here too. Hardening the writer alone would leave the
  // store wide open (the Task-1 lesson).
  if (params.key === 'ads') {
    if (!ownsEveryCreativeKey(body.value, explorer.tenantId, explorer.id)) {
      return json({ error: 'imageKey must reference an image uploaded to this explorer' }, 400)
    }
    // Prefix ownership proves the key is addressed to us; it does NOT prove the
    // object exists. A hand-typed or fabricated same-prefix hash would save
    // cleanly and then render a permanently broken image on the live site, with
    // nothing in the pipeline to catch it. Confirm each referenced object is
    // really in the bucket. Bounded by the schema's 12-creative cap.
    const keys = referencedCreativeKeys(body.value)
    const heads = await Promise.all(keys.map((k) => env.CREATIVES.head(k).catch(() => null)))
    const missing = keys.filter((_, i) => !heads[i])
    if (missing.length > 0) {
      return json({ error: `no uploaded image for key(s): ${missing.join(', ')}` }, 400)
    }
  }

  const upstream = await explorerAdminFetch(env, explorer, `/api/admin/settings/${params.key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, updatedBy: locals.member.email }),
  })

  if (upstream.ok) {
    // An rpc.webRpcUrl can carry an API key in its path/query. This console-side
    // audit row is a SECOND copy of the value, in D1, read by a different code
    // path than the redacted settings GET — store the host-only form so the
    // credential does not come to rest here. The explorer's own versioned
    // history remains the full-fidelity record for operators who can write.
    const auditValue = params.key === 'rpc' ? redactRpcValue(body.value ?? null) : (body.value ?? null)
    await getDb(env)
      .insert(audit)
      .values({
        actorEmail: locals.member.email,
        tenantId: explorer.tenantId,
        explorerId: explorer.id,
        action: `settings.put:${params.key}`,
        payload: JSON.stringify(auditValue).slice(0, 4000),
        at: Math.floor(Date.now() / 1000),
      })
  }
  return json(upstream.body ?? { error: upstream.error ?? 'upstream error' }, upstream.status || 502)
}
