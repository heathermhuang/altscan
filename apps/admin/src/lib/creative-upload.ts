import { isValidCreativeKey } from '@altscan/settings-schema'

/** 256 KB. An ad creative that needs more than this is the wrong asset. */
export const MAX_CREATIVE_BYTES = 256 * 1024

/**
 * Ceiling on stored objects per explorer.
 *
 * Uploads are permanent (no delete — audit revert must keep working) and land
 * on a public bucket, so the endpoint is an unbounded-growth primitive for any
 * authenticated writer. Content addressing dedupes identical bytes but not
 * distinct ones, and the schema's 12-creative cap only bounds what is
 * REFERENCED, not what is STORED. 200 leaves room for years of legitimate
 * churn (each version of a replaced creative keeps its own key) while turning
 * a runaway loop into a 429 instead of an unbounded bill.
 */
export const MAX_CREATIVE_OBJECTS_PER_EXPLORER = 200

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

/**
 * Bounds on the DECODED image.
 *
 * MAX_CREATIVE_BYTES caps the compressed upload, which is not the same thing:
 * every one of these formats compresses uniform pixels to almost nothing, so a
 * 30000x30000 PNG fits in a few KB and still asks each visitor's browser to
 * allocate ~3.6 GB. 4096px and 16 MP are far above any legitimate ad creative
 * and far below a bomb.
 */
export const MAX_CREATIVE_DIMENSION = 4096
export const MAX_CREATIVE_PIXELS = 16_000_000

/** Smallest byte length that can hold each format's header. A signature match
 *  alone proved nothing about the rest of the file — an 8-byte buffer that is
 *  only the PNG magic number passed sniffImageType, was stored permanently on
 *  a public bucket, and then rendered as a broken <img>. */
const MIN_BYTES: Record<CreativeContentType, number> = {
  'image/png': 24,
  'image/jpeg': 4,
  'image/gif': 10,
  'image/webp': 30,
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u32be = (b: Uint8Array, o: number) =>
  ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]

/**
 * Decode just enough header to learn the pixel dimensions.
 *
 * Returns null when the dimensions cannot be established — a truncated file, a
 * header that does not parse, or a WebP variant we do not read. Callers MUST
 * treat null as a rejection: "cannot determine size" is exactly the case a
 * crafted upload would aim for, so it fails closed rather than skipping the
 * bounds check.
 */
export function readImageDimensions(
  bytes: Uint8Array,
  type: CreativeContentType,
): { width: number; height: number } | null {
  if (bytes.length < MIN_BYTES[type]) return null

  if (type === 'image/png') {
    // IHDR must be the FIRST chunk; its absence means this is not a real PNG
    // however convincing the 8-byte signature was.
    if (!startsWithBytes(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return null
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) }
  }

  if (type === 'image/gif') {
    return { width: u16le(bytes, 6), height: u16le(bytes, 8) }
  }

  if (type === 'image/webp') {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (chunk === 'VP8X') {
      // 24-bit little-endian canvas size, stored minus one.
      const w = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1
      const h = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1
      return { width: w, height: h }
    }
    if (chunk === 'VP8 ') {
      if (bytes.length < 30) return null
      // Keyframe start code 0x9d 0x01 0x2a at offset 23.
      if (!startsWithBytes(bytes, [0x9d, 0x01, 0x2a], 23)) return null
      return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
    }
    if (chunk === 'VP8L') {
      if (bytes.length < 25) return null
      if (bytes[20] !== 0x2f) return null
      const b = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
    return null
  }

  // JPEG: walk the marker chain to the frame header. Dimensions live in SOFn,
  // which is not at a fixed offset because APPn/COM segments precede it.
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = u16be(bytes, i + 2)
    if (len < 2) return null
    // SOF0..SOF15 carry the size; DHT (c4), JPG (c8) and DAC (cc) do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) }
    }
    i += 2 + len
  }
  return null
}

/** Structural gate applied AFTER sniffImageType. Returns null when the upload
 *  is acceptable, or a human-readable reason to reject it. */
export function rejectImageReason(bytes: Uint8Array, type: CreativeContentType): string | null {
  const dims = readImageDimensions(bytes, type)
  if (!dims) return 'file is truncated or its header is not a valid image'
  const { width, height } = dims
  if (width < 1 || height < 1) return 'image reports a zero dimension'
  if (width > MAX_CREATIVE_DIMENSION || height > MAX_CREATIVE_DIMENSION) {
    return `image is ${width}x${height}; max ${MAX_CREATIVE_DIMENSION}px per side`
  }
  if (width * height > MAX_CREATIVE_PIXELS) {
    return `image is ${width * height} pixels; max ${MAX_CREATIVE_PIXELS}`
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
/** Every imageKey referenced by an `ads` value, deduped. Shape-tolerant: a
 *  malformed value yields no keys rather than throwing (callers pair this with
 *  ownsEveryCreativeKey, which rejects malformed shapes outright). */
export function referencedCreativeKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const creatives = (value as { creatives?: unknown }).creatives
  if (!Array.isArray(creatives)) return []
  const keys = new Set<string>()
  for (const c of creatives) {
    if (c === null || typeof c !== 'object') continue
    const key = (c as { imageKey?: unknown }).imageKey
    if (typeof key === 'string' && isValidCreativeKey(key)) keys.add(key)
  }
  return [...keys]
}

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
