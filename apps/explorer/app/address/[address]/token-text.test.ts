import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { shortenAddress } from '@/lib/address-display'
import { TransferRow } from './TransferRow'
import { NftRow } from './NftRow'
import { ProviderTransferRow } from './TransfersLazy'
import { NftCard } from './NftsLazy'

// A token's symbol and name are whatever its deployer typed; "Visit claim-bnb.xyz" is an advert (lib/link-in-name).
// Wherever the address page prints one, an amount names the token by its short address, a name cell keeps the text
// with the neutral "link in name" badge, and nothing is ever made a link to it. Four renderers draw token text on
// this page: the Transfers tab (server rows, and the provider's rows in TransfersLazy), and the NFTs tab (server
// rows, and NftsLazy's cards). Each is rendered as the real component, with no fetch or database.
const ME = '0x' + '1'.repeat(40)
const TOKEN = '0x' + 'a'.repeat(40)
const SHORT = shortenAddress(TOKEN)
const TX = '0x' + 'b'.repeat(64)
const inTable = (el: Parameters<typeof createElement>[0] | ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement('table', null, createElement('tbody', null, el as never)))
const cells = (html: string) => [...html.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1])
const text = (html: string) => html.replace(/<[^>]+>/g, '')
const badges = (html: string) => (html.match(/>link in name<\/span>/g) ?? []).length
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
const onlyOwnLinks = (html: string) =>
  expect(hrefs(html).filter((h) => !/^\/(tx|token|address)\/0x[0-9a-fA-F]+$/.test(h))).toEqual([])

// A link beside the badge sits in a line of text, so it must differ from the text by more than colour (axe link-in-text-block,
// which failed in dark mode at 1.21:1). Unflagged rows keep the bare link.
const linkClass = (html: string, href: string) => html.match(new RegExp(`<a class="([^"]*)" href="${href}"`))?.[1] ?? ''

describe('Transfers tab (server row)', () => {
  const t = { txHash: TX, blockNumber: 100, fromAddress: ME, toAddress: '0x' + '2'.repeat(40), tokenAddress: TOKEN, value: '1500000000000000000' }
  const row = (symbol: string, name = 'Some Token') =>
    inTable(createElement(TransferRow, { t, addr: ME, info: { symbol, name, decimals: 18 } }))

  it('an ordinary token reads as before: its symbol in the cell and after the amount, no badge', () => {
    const c = cells(row('USDT', 'Tether USD'))
    expect(text(c[4])).toBe('USDT')
    expect(text(c[5])).toBe('1.5 USDT')
    expect(badges(row('USDT'))).toBe(0)
  })

  it('a URL symbol: the cell keeps the text with the badge, the amount names the token by its short address', () => {
    const html = row('claim-bnb.xyz')
    const c = cells(html)
    expect(text(c[4])).toBe('claim-bnb.xyz' + 'link in name')
    expect(badges(c[4])).toBe(1)
    expect(text(c[5])).toBe(`1.5 ${SHORT}`)
    expect(c[5]).not.toContain('claim-bnb.xyz')
    onlyOwnLinks(html)
  })

  it('a handle symbol is the same', () => {
    const c = cells(row('@airdrop_bot'))
    expect(badges(c[4])).toBe(1)
    expect(text(c[5])).toBe(`1.5 ${SHORT}`)
  })

  it('a URL only in the NAME badges the cell, and the amount still prints the (innocent) symbol', () => {
    const c = cells(row('CLAIM', 'Visit t.me/freebnb'))
    expect(text(c[4])).toBe('CLAIM' + 'link in name')
    expect(text(c[5])).toBe('1.5 CLAIM')
  })

  it('a placeholder symbol with a URL name: the cell shows the name and the badge, the amount prints no unit', () => {
    const c = cells(row('???', 'Visit claim-bnb.xyz'))
    expect(text(c[4])).toBe('Visit claim-bnb.xyz' + 'link in name')
    expect(text(c[5])).toBe('1.5')
  })

  it('a ticker with a dot is not an address', () => {
    expect(badges(row('USDT.z', 'Tether USD Bridged'))).toBe(0)
  })

  it('the token link beside a badge is medium weight; an unflagged one is as it was', () => {
    expect(linkClass(row('claim-bnb.xyz'), `/token/${TOKEN}`)).toBe('text-acc-ink hover:underline font-medium')
    expect(linkClass(row('USDT'), `/token/${TOKEN}`)).toBe('text-acc-ink hover:underline')
  })
})

describe('Transfers tab (provider rows in TransfersLazy)', () => {
  const t = (tokenSymbol: string) => ({
    txHash: TX, logIndex: '1', blockNumber: '100', blockTimestamp: '2026-10-10T00:00:00.000Z', fromAddress: ME,
    toAddress: '0x' + '2'.repeat(40), tokenAddress: TOKEN, tokenSymbol, tokenDecimals: '18', value: '1', valueFormatted: '1000.5',
  })
  const row = (symbol: string) => inTable(createElement(ProviderTransferRow, { t: t(symbol), addr: ME }))

  it('an ordinary token reads as before', () => {
    const c = cells(row('CAKE'))
    expect(text(c[4])).toBe('CAKE')
    expect(text(c[5])).toBe('1,000.5 CAKE')
    expect(badges(row('CAKE'))).toBe(0)
  })

  it('a URL symbol: badge in the cell, short address in the amount, no URL text in the amount', () => {
    const html = row('claim-bnb.xyz')
    const c = cells(html)
    expect(text(c[4])).toBe('claim-bnb.xyz' + 'link in name')
    expect(text(c[5])).toBe(`1,000.5 ${SHORT}`)
    onlyOwnLinks(html)
  })

  it('the token link beside a badge is medium weight; an unflagged one is as it was', () => {
    expect(linkClass(row('claim-bnb.xyz'), `/token/${TOKEN}`)).toBe('text-acc-ink hover:underline font-medium')
    expect(linkClass(row('CAKE'), `/token/${TOKEN}`)).toBe('text-acc-ink hover:underline')
  })

  it('the amount is sanitised like the server tab\'s: no bidi override reaches the page', () => {
    const c = cells(row('U‮SDT'))
    expect(c[5]).not.toContain('‮')
    expect(text(c[5])).toBe('1,000.5 USDT')
  })

  it('a placeholder symbol reads "Unknown token" in the cell and prints no "???" after the amount', () => {
    const c = cells(row('???'))
    expect(text(c[4])).toBe('Unknown token')
    expect(text(c[5])).toBe('1,000.5')
  })
})

describe('NFTs tab (server row)', () => {
  const t = { txHash: TX, tokenAddress: TOKEN, tokenId: '7', fromAddress: ME, toAddress: '0x' + '2'.repeat(40), blockNumber: 100 }
  const row = (name: string, symbol: string) => inTable(createElement(NftRow, { t: { ...t, name, symbol }, addr: ME }))

  it('an ordinary collection reads as before, no badge', () => {
    const html = row('Cool Apes', 'APE')
    expect(text(cells(html)[0])).toBe('Cool Apes(APE)')
    expect(badges(html)).toBe(0)
  })

  it('a URL in the name keeps the text and gets the badge; the only links are the explorer\'s own', () => {
    const html = row('Visit claim-bnb.xyz to claim', 'APE')
    expect(text(cells(html)[0])).toContain('Visit claim-bnb.xyz to claim')
    expect(badges(cells(html)[0])).toBe(1)
    onlyOwnLinks(html)
  })

  it('a handle in the symbol is flagged too', () => {
    expect(badges(row('Apes', '@airdrop_bot'))).toBe(1)
  })

  it('the collection link beside a badge is medium weight; an unflagged one is as it was', () => {
    expect(linkClass(row('Visit claim-bnb.xyz', 'APE'), `/token/${TOKEN}`)).toBe('text-acc-ink hover:underline font-medium')
    expect(linkClass(row('Cool Apes', 'APE'), `/token/${TOKEN}`)).toBe('text-acc-ink hover:underline')
  })
})

describe('NFTs tab (cards in NftsLazy)', () => {
  const nft = (name: string, symbol: string, imageUrl: string | null = null) =>
    ({ tokenAddress: TOKEN, tokenId: '7', name, symbol, metadata: null, imageUrl })
  const card = (...a: Parameters<typeof nft>) => renderToStaticMarkup(createElement(NftCard, { nft: nft(...a) }))

  it('an ordinary card reads as before, no badge', () => {
    const html = card('Cool Apes', 'APE')
    expect(text(html)).toBe('Cool Apes #7APE')
    expect(badges(html)).toBe(0)
  })

  it('a URL in the name or the symbol gets the badge; the text stays text, and the card holds no link at all', () => {
    for (const html of [card('Visit claim-bnb.xyz', 'APE'), card('Apes', 't.me/freebnb')]) {
      expect(badges(html)).toBe(1)
      expect(html).not.toContain('<a ')
    }
    expect(text(card('Visit claim-bnb.xyz', 'APE'))).toContain('Visit claim-bnb.xyz #7')
  })

  it('the image\'s alt text, shown if the picture fails and read by a screen reader, does not repeat the URL', () => {
    const html = card('Visit claim-bnb.xyz', 'APE', 'https://img.example/ape.png')
    const alt = html.match(/alt="([^"]*)"/)?.[1] ?? ''
    expect(alt).not.toContain('claim-bnb.xyz')
    expect(card('Cool Apes', 'APE', 'https://img.example/ape.png')).toContain('alt="Cool Apes"')
  })
})
