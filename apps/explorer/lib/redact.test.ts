import { describe, expect, it } from 'vitest'
import { makeError } from 'ethers'
import { redactSecrets } from './redact'

const ethersHttpError = (requestUrl: string) =>
  makeError('server response 429', 'SERVER_ERROR', {
    request: {} as never,
    response: {} as never,
    info: { requestUrl, responseBody: '', responseStatus: '429 Too Many Requests' },
  })

describe('redactSecrets', () => {
  it('masks the requestUrl ethers 6.17 embeds in an HTTP error message', () => {
    const out = redactSecrets(ethersHttpError('https://rpc.example/v2/SECRETKEY?apikey=SECRET2').message)
    expect(out).not.toMatch(/SECRET/)
    expect(out).toContain('server response 429')
    expect(out).toContain('"requestUrl": "[redacted]"')
  })

  it('masks requestUrl in util.inspect style too', () => {
    expect(redactSecrets(`{ info: { requestUrl: 'https://rpc.example/v2/SECRETKEY' } }`))
      .toBe(`{ info: { requestUrl: '[redacted]' } }`)
  })

  it('masks userinfo, path and query on any URL, keeping the host and port', () => {
    expect(redactSecrets('GET https://user:SECRET@host.example:8545/v1/SECRETKEY failed'))
      .toBe('GET https://***@host.example:8545/*** failed')
    expect(redactSecrets('retrying wss://host.example/?token=SECRET now')).toBe('retrying wss://host.example/*** now')
  })

  it('masks userinfo on a URL that does not parse', () => {
    expect(redactSecrets('bad //user:SECRET@host:notaport/x')).not.toContain('SECRET')
  })

  it('leaves text with no URL, and a bare public origin, unchanged', () => {
    expect(redactSecrets('execution reverted: "ERC20: insufficient allowance"')).toBe('execution reverted: "ERC20: insufficient allowance"')
    expect(redactSecrets('GET https://bsc-dataseed.binance.org/ failed')).toBe('GET https://bsc-dataseed.binance.org/ failed')
  })
})
