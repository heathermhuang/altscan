import { afterEach, describe, expect, it } from 'vitest'
import { checkIpRateLimit, isAltscanService, SERVICE_TOKEN_HEADER } from './api-rate-limit'

// altscan.io's MCP Worker reaches the explorers from Cloudflare's shared cross-zone Worker address,
// so it identifies itself with a token instead. The token must never become an exemption.
const TOKEN = 't'.repeat(40)
const WORKER_IP = '2a06:98c0:3600::103'
const headers = (init: Record<string, string>) => new Headers({ 'x-forwarded-for': WORKER_IP, ...init })

afterEach(() => { delete process.env.ALTSCAN_SERVICE_TOKEN })

describe('isAltscanService', () => {
  it('accepts only the exact configured token', () => {
    process.env.ALTSCAN_SERVICE_TOKEN = TOKEN
    expect(isAltscanService(headers({ [SERVICE_TOKEN_HEADER]: TOKEN }))).toBe(true)
    expect(isAltscanService(headers({ [SERVICE_TOKEN_HEADER]: TOKEN.slice(1) + 'x' }))).toBe(false)
    expect(isAltscanService(headers({}))).toBe(false)
  })

  it('fails closed when the token is unset or too short to be a secret', () => {
    expect(isAltscanService(headers({ [SERVICE_TOKEN_HEADER]: '' }))).toBe(false)
    process.env.ALTSCAN_SERVICE_TOKEN = 'short'
    expect(isAltscanService(headers({ [SERVICE_TOKEN_HEADER]: 'short' }))).toBe(false)
  })
})

describe('checkIpRateLimit for the altscan service', () => {
  it('gives the service its own bucket, larger than one IP gets', async () => {
    process.env.ALTSCAN_SERVICE_TOKEN = TOKEN
    const svc = headers({ [SERVICE_TOKEN_HEADER]: TOKEN })
    for (let i = 0; i < 150; i++) expect(await checkIpRateLimit(svc)).toBe(true)
  })

  it('still caps the service bucket', async () => {
    process.env.ALTSCAN_SERVICE_TOKEN = 'u'.repeat(40)
    const svc = headers({ [SERVICE_TOKEN_HEADER]: 'u'.repeat(40) })
    let allowed = 0
    for (let i = 0; i < 700; i++) if (await checkIpRateLimit(svc)) allowed++
    expect(allowed).toBeLessThanOrEqual(600)
  })

  it('limits a request with a wrong token by IP, like any other', async () => {
    process.env.ALTSCAN_SERVICE_TOKEN = TOKEN
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}`
    const wrong = new Headers({ 'x-forwarded-for': ip, [SERVICE_TOKEN_HEADER]: 'nope' })
    let allowed = 0
    for (let i = 0; i < 150; i++) if (await checkIpRateLimit(wrong)) allowed++
    expect(allowed).toBe(100)
  })
})
