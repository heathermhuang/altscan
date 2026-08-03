import { describe, expect, it } from 'vitest'
import {
  referencedCreativeKeys,
  buildCreativeKey,
  ownsEveryCreativeKey,
  sha256Hex,
  sniffImageType,
  readImageDimensions,
  rejectImageReason,
  MAX_CREATIVE_DIMENSION,
} from './creative-upload'

const png = (extra = 0) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(extra).fill(0)])
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const gif = () => new Uint8Array([...new TextEncoder().encode('GIF89a'), 0, 0])
const webp = () =>
  new Uint8Array([
    ...new TextEncoder().encode('RIFF'),
    0,
    0,
    0,
    0,
    ...new TextEncoder().encode('WEBP'),
  ])

describe('sniffImageType', () => {
  it('recognises the four allowed raster formats by magic bytes', () => {
    expect(sniffImageType(png())).toBe('image/png')
    expect(sniffImageType(jpeg())).toBe('image/jpeg')
    expect(sniffImageType(gif())).toBe('image/gif')
    expect(sniffImageType(webp())).toBe('image/webp')
  })

  it('rejects SVG, HTML and anything else — a stored script is an XSS primitive', () => {
    const bytes = (s: string) => new TextEncoder().encode(s)
    expect(sniffImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(sniffImageType(bytes('<?xml version="1.0"?><svg/>'))).toBeNull()
    expect(sniffImageType(bytes('<!doctype html><script>alert(1)</script>'))).toBeNull()
    expect(sniffImageType(new Uint8Array([]))).toBeNull()
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull() // truncated PNG
    // A RIFF container that is not WEBP (e.g. a WAV) must not pass.
    expect(
      sniffImageType(
        new Uint8Array([
          ...new TextEncoder().encode('RIFF'),
          0,
          0,
          0,
          0,
          ...new TextEncoder().encode('WAVE'),
        ]),
      ),
    ).toBeNull()
  })
})

describe('buildCreativeKey', () => {
  it('namespaces by tenant and explorer and maps the content type to an extension', () => {
    const hash = 'd'.repeat(64)
    expect(buildCreativeKey('altscan', 'bnb', hash, 'image/png')).toBe(`altscan/bnb/${hash}.png`)
    expect(buildCreativeKey('altscan', 'bnb', hash, 'image/jpeg')).toBe(`altscan/bnb/${hash}.jpg`)
    expect(buildCreativeKey('altscan', 'bnb', hash, 'image/webp')).toBe(`altscan/bnb/${hash}.webp`)
    expect(buildCreativeKey('altscan', 'bnb', hash, 'image/gif')).toBe(`altscan/bnb/${hash}.gif`)
  })

  it('returns null when an id would break the key grammar', () => {
    const hash = 'd'.repeat(64)
    expect(buildCreativeKey('has/slash', 'bnb', hash, 'image/png')).toBeNull()
    expect(buildCreativeKey('altscan', 'has space', hash, 'image/png')).toBeNull()
    expect(buildCreativeKey('altscan', 'bnb', 'nothex', 'image/png')).toBeNull()
    expect(buildCreativeKey('', 'bnb', hash, 'image/png')).toBeNull()
  })
})

describe('sha256Hex', () => {
  it('hashes to the known digest of an empty input', async () => {
    expect(await sha256Hex(new Uint8Array([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('is stable for the same bytes (content addressing dedupes uploads)', async () => {
    expect(await sha256Hex(png())).toBe(await sha256Hex(png()))
  })
})

describe('ownsEveryCreativeKey', () => {
  const hash = 'e'.repeat(64)
  const creative = (imageKey?: string) => ({
    id: 'x',
    headline: 'h',
    ctaText: 'c',
    ctaUrl: '/x',
    ...(imageKey ? { imageKey, imageAlt: 'a' } : {}),
  })

  it('accepts values with no creatives or no images', () => {
    expect(ownsEveryCreativeKey({}, 'altscan', 'bnb')).toBe(true)
    expect(ownsEveryCreativeKey({ creatives: [creative()] }, 'altscan', 'bnb')).toBe(true)
  })

  it('accepts keys under the caller tenant + explorer prefix', () => {
    expect(
      ownsEveryCreativeKey({ creatives: [creative(`altscan/bnb/${hash}.png`)] }, 'altscan', 'bnb'),
    ).toBe(true)
  })

  it('rejects a key belonging to another tenant or explorer', () => {
    expect(
      ownsEveryCreativeKey({ creatives: [creative(`other/bnb/${hash}.png`)] }, 'altscan', 'bnb'),
    ).toBe(false)
    expect(
      ownsEveryCreativeKey({ creatives: [creative(`altscan/eth/${hash}.png`)] }, 'altscan', 'bnb'),
    ).toBe(false)
  })

  it('rejects a prefix-lookalike and a structurally invalid key', () => {
    expect(
      ownsEveryCreativeKey(
        { creatives: [creative(`altscan-evil/bnb/${hash}.png`)] },
        'altscan',
        'bnb',
      ),
    ).toBe(false)
    expect(
      ownsEveryCreativeKey({ creatives: [creative('altscan/bnb/../x.png')] }, 'altscan', 'bnb'),
    ).toBe(false)
  })

  it('rejects non-object and non-array shapes rather than passing them through', () => {
    expect(ownsEveryCreativeKey(null, 'altscan', 'bnb')).toBe(true) // nothing to own
    expect(ownsEveryCreativeKey({ creatives: 'nope' }, 'altscan', 'bnb')).toBe(false)
    expect(ownsEveryCreativeKey({ creatives: [{ imageKey: 42 }] }, 'altscan', 'bnb')).toBe(false)
  })
})

describe('referencedCreativeKeys', () => {
  const hash = (c: string) => c.repeat(64)
  const creative = (imageKey?: string) => ({
    id: 'x',
    headline: 'h',
    ctaText: 'c',
    ctaUrl: '/x',
    ...(imageKey ? { imageKey, imageAlt: 'a' } : {}),
  })

  it('collects valid keys and dedupes them', () => {
    const k = `altscan/bnb/${hash('a')}.png`
    expect(referencedCreativeKeys({ creatives: [creative(k), creative(k)] })).toEqual([k])
  })

  it('ignores creatives with no image', () => {
    expect(referencedCreativeKeys({ creatives: [creative()] })).toEqual([])
  })

  it('ignores malformed keys rather than passing them to a head() lookup', () => {
    expect(referencedCreativeKeys({ creatives: [creative('../evil.png')] })).toEqual([])
    expect(referencedCreativeKeys({ creatives: [{ imageKey: 42 }] })).toEqual([])
  })

  it('returns nothing for shapes that are not an ads value', () => {
    for (const v of [null, undefined, 'str', 42, [], {}, { creatives: 'nope' }]) {
      expect(referencedCreativeKeys(v)).toEqual([])
    }
  })
})


/* ── codex round 3: signature-only sniffing accepted corrupt files ────────── */

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const be16 = (n: number) => [(n >>> 8) & 255, n & 255]

/** Signature + a real IHDR chunk, which is what a decoder actually needs. */
const pngOf = (w: number, h: number) =>
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52,
    ...be32(w), ...be32(h),
    8, 6, 0, 0, 0,
  ])
const gifOf = (w: number, h: number) =>
  new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(w), ...le16(h)])
/** FFD8 then SOF0: length, precision, height, width. */
const jpegOf = (w: number, h: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0])
const webpVp8xOf = (w: number, h: number) =>
  new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, ...be32(10), 0, 0, 0, 0,
    (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255,
    (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255,
  ])

describe('readImageDimensions', () => {
  it('reads dimensions from each accepted format', () => {
    expect(readImageDimensions(pngOf(800, 200), 'image/png')).toEqual({ width: 800, height: 200 })
    expect(readImageDimensions(gifOf(320, 50), 'image/gif')).toEqual({ width: 320, height: 50 })
    expect(readImageDimensions(jpegOf(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 })
    expect(readImageDimensions(webpVp8xOf(300, 250), 'image/webp')).toEqual({
      width: 300,
      height: 250,
    })
  })

  it('returns null rather than guessing when the header is absent or truncated', () => {
    // The exact payload codex found: 8 bytes that are only the PNG signature.
    // sniffImageType says "image/png" and always will — that is its job.
    const bareSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(sniffImageType(bareSignature)).toBe('image/png')
    expect(readImageDimensions(bareSignature, 'image/png')).toBeNull()

    // Signature present, IHDR chunk missing → not a real PNG.
    const noIhdr = new Uint8Array([...bareSignature, ...be32(13), 0x6a, 0x75, 0x6e, 0x6b, ...Array(8).fill(0)])
    expect(readImageDimensions(noIhdr, 'image/png')).toBeNull()

    expect(readImageDimensions(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'image/gif')).toBeNull()
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull()
  })
})

describe('rejectImageReason', () => {
  it('accepts a normal ad creative', () => {
    expect(rejectImageReason(pngOf(728, 90), 'image/png')).toBeNull()
    expect(rejectImageReason(jpegOf(300, 250), 'image/jpeg')).toBeNull()
  })

  it('rejects a decompression bomb that fits well under the byte cap', () => {
    // 30000x30000 of uniform pixels compresses to a few KB and asks every
    // visitor's browser for ~3.6 GB. MAX_CREATIVE_BYTES cannot see this.
    const reason = rejectImageReason(pngOf(30000, 30000), 'image/png')
    expect(reason).toMatch(/max .* per side/)
  })

  it('rejects an image that is within per-side limits but exceeds total pixels', () => {
    const big = MAX_CREATIVE_DIMENSION
    expect(rejectImageReason(pngOf(big, big), 'image/png')).toMatch(/pixels/)
  })

  it('rejects zero dimensions and unparseable headers', () => {
    expect(rejectImageReason(pngOf(0, 100), 'image/png')).toMatch(/zero dimension/)
    expect(rejectImageReason(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'))
      .toMatch(/truncated|not a valid image/)
  })
})
