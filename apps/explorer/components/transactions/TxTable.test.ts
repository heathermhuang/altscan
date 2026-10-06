import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TxTable } from './TxTable'

// app/globals.css (.dt-tx) lays each row out under 640px by cell POSITION - hash, age, from, to,
// value, status - and colours the status dot from tx-ok / tx-bad. These pin that contract.
const HASH = (n: number) => `0x${String(n).repeat(64)}`
const ADDR = '0x1111111111111111111111111111111111111111'
const row = (n: number, status: boolean | null) => ({
  hash: HASH(n), fromAddress: ADDR, toAddress: n === 2 ? null : ADDR, value: '1500000000000000000', status, timestamp: new Date(),
})
const txs = [row(1, true), row(2, false), row(3, null)]

const html = (props: Partial<Parameters<typeof TxTable>[0]> = {}) =>
  renderToStaticMarkup(createElement(TxTable, { txs, ...props }))
const bodyRows = (h: string) => [...h.matchAll(/<tbody>(.*)<\/tbody>/gs)][0][1].split('<tr>').slice(1)
const cells = (r: string) => [...r.matchAll(/<td\b([^>]*)>(.*?)<\/td>/gs)].map(m => ({ attrs: m[1], inner: m[2] }))

describe('TxTable cell contract', () => {
  it('renders every column at every width, in the order the phone layout expects', () => {
    const h = html()
    expect([...h.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map(m => m[1])).toEqual(['Tx Hash', 'Age', 'From', 'To', 'Value', 'Status'])
    for (const r of bodyRows(h)) expect(cells(r)).toHaveLength(6)
    const first = cells(bodyRows(h)[0])
    expect(first[0].inner).toContain(`/tx/${HASH(1)}`)
    expect(first[4].inner).toContain('1.5')
  })

  it('labels the status for assistive tech and colours the dot by class: ok, failed, and none when unknown', () => {
    const [ok, bad, unknown] = bodyRows(html()).map(r => cells(r)[5])
    expect(ok.attrs).toContain('tx-ok')
    expect(ok.inner).toContain('Success')
    expect(bad.attrs).toContain('tx-bad')
    expect(bad.inner).toContain('Failed')
    expect(unknown.attrs).not.toMatch(/tx-ok|tx-bad/)
  })

  it('puts no full-address title on the row links: the homepage is held to one TCP window', () => {
    expect(html({ compact: true })).not.toContain('title=')
    expect(html()).not.toContain('title=')
  })

  it('colours its links from the table (dt-a), not per link: the class lists are per-row bytes', () => {
    const h = html({ compact: true })
    expect(h).toContain('dt-a')
    expect(h).not.toMatch(/text-acc-ink|hover:underline|font-mono/)
    expect(h).toContain('href="/address/')
  })

  it('keeps a To cell for a contract creation', () => {
    expect(cells(bodyRows(html())[1])[3].inner).toContain('Contract Creation')
  })

  it('compact marks the table so desktop can drop To, without removing the cell', () => {
    const h = html({ compact: true })
    expect(h).toContain('dt dt-tx dt-tx-c')
    expect(html()).not.toContain('dt-tx-c')
    for (const r of bodyRows(h)) expect(cells(r)).toHaveLength(6)
  })

  it('showStatus={false} drops the status column and its dot', () => {
    const h = html({ showStatus: false })
    expect(h).not.toMatch(/tx-ok|tx-bad|Status/)
    for (const r of bodyRows(h)) expect(cells(r)).toHaveLength(5)
  })
})
