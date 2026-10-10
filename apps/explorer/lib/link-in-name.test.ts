import { describe, expect, it } from 'vitest'
import { LINK_IN_NAME_NOTE, looksLikeUrlOrHandle } from './link-in-name'

// A token's symbol and name are whatever its deployer typed. Airdrop spam puts a URL or a handle there
// ("Visit claim-bnb.xyz to claim"), hoping the explorer's page becomes the advert. This decides which
// texts the explorer treats as unsafe; the callers decide how (a short address in a headline, a badge in a table).
describe('looksLikeUrlOrHandle', () => {
  it.each([
    'https://claim-bnb.xyz', 'http://x', 'HTTPS://EVIL.COM', 'ftp://files.example',
    'www.airdrop.com', 'WWW.CLAIM', 'visit www.claim',
    'claim-usdt.com', 'UNISWAP.IO', 'visit uniswap.io now', 'free.xyz', 'a.org', 'x.net', 'my.app', 'free.top',
    'v.vip', 'x.cc', 'claim.me', 'x.co', 'pancake.site', 'x.online', 'lido.finance', 'swap.exchange',
    'example.com/path', 'example.com.au', 'Visit claim.xyz to claim 1000 USDT',
    't.me/airdrop', 'T.ME/x', 'join t.me/scam',
    '币安链能飞.vip', 'ЦАРЬ.com',
    'discord.gg/claim', 'pump.fun', 'claim.link', 'bit.ly/x', 'knewit.fun', 'TOPS.FUN',
    'claim。xyz', 'claim｡xyz', 'ｃｌａｉｍ。ｘｙｚ', '币安。com', 'visit claim。io now',
    '@airdrop_bot', 'Claim @elonmusk', '(@handle)', '@ab',
  ])('flags %j', (text) => {
    expect(looksLikeUrlOrHandle(text)).toBe(true)
  })

  it.each([
    'USDT', 'USDT.z', 'BTC.b', 'WETH.e', 'USDC.e', 'stETH', 'Tether USD', 'Wrapped BNB', 'PancakeSwap Token',
    'BTC.c', 'ETH.x', 'CAKE-LP', 'Wrapped Ether (Wormhole)', 'ETH.commit', '币安支付.burn', 'Startup Mr. Miyagi', 'Ondo U.S. Dollar Token',
    'WBNB', 'U.S.', 'e.g.', 'e.g. Tether', 'LINK', 'ChainLink Token', 'FUN', 'Funfair', '你好。世界', 'USDT。z',
  ])('does not flag the ticker or name %j', (text) => {
    expect(looksLikeUrlOrHandle(text)).toBe(false)
  })

  it.each(['1.5', '0.001', '$1.23', '1,000.50', '3.14159', '1.5 USDT', '10.0%', 'v1.2', '2.5x'])('does not flag the number %j', (text) => {
    expect(looksLikeUrlOrHandle(text)).toBe(false)
  })

  it.each(['@', 'Rate @ 5%', 'USDT@BSC', 'a@', '@1', '@_'])('does not flag a lone or mid-word @: %j', (text) => {
    expect(looksLikeUrlOrHandle(text)).toBe(false)
  })

  it('has nothing to flag in nothing', () => {
    expect(looksLikeUrlOrHandle('')).toBe(false)
    expect(looksLikeUrlOrHandle(null)).toBe(false)
    expect(looksLikeUrlOrHandle(undefined)).toBe(false)
  })

  // The page shows what survives sanitizing, but a deployer controls the raw characters.
  it('sees through fullwidth letters and invisible characters', () => {
    expect(looksLikeUrlOrHandle('ｗｗｗ．ｓｃａｍ．ｃｏｍ')).toBe(true)
    expect(looksLikeUrlOrHandle('exam​ple.com')).toBe(true)
    expect(looksLikeUrlOrHandle('t‍.me/x')).toBe(true)
    expect(looksLikeUrlOrHandle('ｈｔｔｐｓ：／／ｘ')).toBe(true)
  })

  it('is linear on a long label with no dot (a 255-char name must not stall a page render)', () => {
    const t0 = performance.now()
    expect(looksLikeUrlOrHandle('a'.repeat(50_000))).toBe(false)
    expect(looksLikeUrlOrHandle('a-'.repeat(25_000) + '.')).toBe(false)
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe('LINK_IN_NAME_NOTE', () => {
  it('says what the badge means, without repeating the text it flags', () => {
    expect(LINK_IN_NAME_NOTE).toMatch(/web address|handle/i)
  })
})
