import { describe, expect, it } from 'vitest'
import {
  buildCreativeKey,
  ownsEveryCreativeKey,
  sha256Hex,
  sniffImageType,
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
