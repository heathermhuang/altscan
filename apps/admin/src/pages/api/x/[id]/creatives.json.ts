import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { getDb, getExplorer } from '../../../../lib/db'
import { audit } from '../../../../lib/schema'
import { canWrite } from '../../../../lib/rbac'
import { json } from '../../../../lib/http'
import { releaseCreativeSlot, reserveCreativeSlot } from '../../../../lib/creative-quota'
import {
  MAX_CREATIVE_BYTES,
  MAX_CREATIVE_OBJECTS_PER_EXPLORER,
  buildCreativeKey,
  rejectImageReason,
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

  // The magic bytes prove the FORMAT, not that a decodable image follows them.
  // Uploads are permanent and public, so a corrupt file accepted here is an
  // orphan that outlives the mistake. Must run before sha256/put — once the
  // object lands there is no delete path to undo it.
  const reason = rejectImageReason(bytes, contentType)
  if (reason) return json({ error: `rejected image: ${reason}` }, 422)

  const key = buildCreativeKey(
    locals.member.tenantId,
    explorer.id,
    await sha256Hex(bytes),
    contentType,
  )
  if (!key) return json({ error: 'could not build a valid object key' }, 500)

  // Quota. Uploads are permanent (deleting would break audit revert) and land on
  // a public bucket, so without a ceiling any authenticated writer — or a stolen
  // session — can loop this endpoint into an unbounded bill. Checked AFTER the
  // key is computed so a re-upload of existing bytes is free: content addressing
  // means it targets a key that already exists and cannot grow the count.
  const prefix = `${locals.member.tenantId}/${explorer.id}/`
  const payload = JSON.stringify({ key, bytes: bytes.byteLength, contentType }).slice(0, 4000)
  const existing = await env.CREATIVES.head(key)
  // A new key's audit row doubles as its quota reservation (lib/creative-quota.ts): the
  // listing below is only a pre-check, and concurrent uploads all list the same count.
  let reserved: number | null = null
  if (!existing) {
    const listed = await env.CREATIVES.list({
      prefix,
      limit: MAX_CREATIVE_OBJECTS_PER_EXPLORER,
    })
    if (listed.truncated || listed.objects.length >= MAX_CREATIVE_OBJECTS_PER_EXPLORER) {
      return json(
        {
          error: `storage quota reached (${MAX_CREATIVE_OBJECTS_PER_EXPLORER} images for this explorer) — images are never deleted so that audit revert keeps working`,
        },
        429,
      )
    }
    reserved = await reserveCreativeSlot(env.DB, {
      actorEmail: locals.member.email,
      tenantId: explorer.tenantId,
      explorerId: explorer.id,
      key,
      payload,
      at: Math.floor(Date.now() / 1000),
    })
    if (reserved === null) {
      return json({ error: `storage quota reached (${MAX_CREATIVE_OBJECTS_PER_EXPLORER} images for this explorer)` }, 429)
    }
  }

  try {
    await env.CREATIVES.put(key, bytes, {
      httpMetadata: {
        // Sniffed, never the client's claim.
        contentType,
        // Content-addressed, so the bytes at this key can never change.
        cacheControl: 'public, max-age=31536000, immutable',
      },
    })
  } catch (err) {
    // Nothing was stored, so the reservation must not keep the slot (or claim an upload).
    if (reserved !== null) await releaseCreativeSlot(env.DB, reserved)
    throw err
  }

  // A new key's audit row was written as its reservation; a re-upload of stored bytes
  // is logged here, as before.
  if (reserved === null) {
    await getDb(env)
      .insert(audit)
      .values({
        actorEmail: locals.member.email,
        tenantId: explorer.tenantId,
        explorerId: explorer.id,
        action: 'creative.upload',
        payload,
        at: Math.floor(Date.now() / 1000),
      })
  }

  return json({ key, url: `${PUBLIC_BASE}/${key}`, bytes: bytes.byteLength, contentType })
}
