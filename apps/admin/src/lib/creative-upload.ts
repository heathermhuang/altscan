import { isValidCreativeKey } from '@altscan/settings-schema'

/** 256 KB. An ad creative that needs more than this is the wrong asset. */
export const MAX_CREATIVE_BYTES = 256 * 1024

export type CreativeContentType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

const EXTENSION: Record<CreativeContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function startsWithBytes(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false
  return sig.every((b, i) => bytes[offset + i] === b)
}

/**
 * Identify an upload by its MAGIC BYTES, never by the client's Content-Type.
 *
 * The allowlist is raster-only. SVG is rejected on purpose: it is a script
 * container, and these objects are served from a public custom domain, so an
 * accepted SVG would be stored XSS against creatives.altscan.io.
 */
export function sniffImageType(bytes: Uint8Array): CreativeContentType | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return 'image/gif' // GIF87a
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif' // GIF89a
  // WebP is a RIFF container: "RIFF" <4-byte size> "WEBP". Both halves must match,
  // or a WAV/AVI would sail through on the RIFF prefix alone.
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp'
  }
  return null
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** `<tenant>/<explorer>/<sha256>.<ext>`, or null if the result would not satisfy
 *  the shared schema's key grammar. Validated against the same predicate the
 *  settings PUT and the explorer's render path use — one rule, every door. */
export function buildCreativeKey(
  tenantId: string,
  explorerId: string,
  sha256: string,
  contentType: CreativeContentType,
): string | null {
  const key = `${tenantId}/${explorerId}/${sha256}.${EXTENSION[contentType]}`
  return isValidCreativeKey(key) ? key : null
}

/**
 * Every imageKey in an `ads` settings value must live under this caller's
 * tenant + explorer prefix.
 *
 * The upload route already namespaces the keys it mints — but the settings PUT
 * accepts an arbitrary JSON body from a browser, so without this check a member
 * of tenant A could reference tenant B's object by typing its key. Same value,
 * different door.
 */
export function ownsEveryCreativeKey(
  value: unknown,
  tenantId: string,
  explorerId: string,
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true
  const creatives = (value as { creatives?: unknown }).creatives
  if (creatives === undefined) return true
  if (!Array.isArray(creatives)) return false

  const prefix = `${tenantId}/${explorerId}/`
  return creatives.every((c) => {
    if (c === null || typeof c !== 'object') return false
    const key = (c as { imageKey?: unknown }).imageKey
    if (key === undefined) return true
    if (typeof key !== 'string') return false
    return isValidCreativeKey(key) && key.startsWith(prefix)
  })
}
