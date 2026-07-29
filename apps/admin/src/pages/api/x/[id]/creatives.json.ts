import type { APIRoute } from 'astro'
import { getDb, getExplorer } from '../../../../lib/db'
import { audit } from '../../../../lib/schema'
import { canWrite } from '../../../../lib/rbac'
import { json } from '../../../../lib/http'
import {
  MAX_CREATIVE_BYTES,
  buildCreativeKey,
  sha256Hex,
  sniffImageType,
} from '../../../../lib/creative-upload'

export const prerender = false

/** Public base for the bucket's custom domain. Only used to hand a preview URL
 *  back to the console; the explorer builds its own URL from the key. */
const PUBLIC_BASE = 'https://creatives.altscan.io'

/**
 * POST <raw image bytes> → store in R2, return the content-addressed key.
 *
 * Gated on canWrite: an upload is a write, and it is an authenticated primitive
 * for putting bytes on a public domain. Also guarded by the CF Access
 * middleware and a tenant-scoped explorer lookup (cross-tenant = 404).
 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const env = locals.runtime.env
  if (!canWrite(locals.member.role)) return json({ error: 'forbidden: read-only role' }, 403)

  const explorer = await getExplorer(env, params.id!, locals.member.tenantId)
  if (!explorer) return json({ error: 'unknown explorer' }, 404)

  // Cheap rejection first — but the header is a claim, not a fact, so the real
  // byte count is re-checked below.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_CREATIVE_BYTES) {
    return json({ error: `image exceeds ${MAX_CREATIVE_BYTES} bytes` }, 413)
  }

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await request.arrayBuffer())
  } catch {
    return json({ error: 'could not read request body' }, 400)
  }
  if (bytes.byteLength === 0) return json({ error: 'empty body' }, 400)
  if (bytes.byteLength > MAX_CREATIVE_BYTES) {
    return json({ error: `image exceeds ${MAX_CREATIVE_BYTES} bytes` }, 413)
  }

  const contentType = sniffImageType(bytes)
  if (!contentType) {
    return json({ error: 'unsupported image type — allowed: PNG, JPEG, WebP, GIF' }, 415)
  }

  const key = buildCreativeKey(
    locals.member.tenantId,
    explorer.id,
    await sha256Hex(bytes),
    contentType,
  )
  if (!key) return json({ error: 'could not build a valid object key' }, 500)

  await env.CREATIVES.put(key, bytes, {
    httpMetadata: {
      // Sniffed, never the client's claim.
      contentType,
      // Content-addressed, so the bytes at this key can never change.
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  await getDb(env)
    .insert(audit)
    .values({
      actorEmail: locals.member.email,
      tenantId: explorer.tenantId,
      explorerId: explorer.id,
      action: 'creative.upload',
      payload: JSON.stringify({ key, bytes: bytes.byteLength, contentType }).slice(0, 4000),
      at: Math.floor(Date.now() / 1000),
    })

  return json({ key, url: `${PUBLIC_BASE}/${key}`, bytes: bytes.byteLength, contentType })
}
