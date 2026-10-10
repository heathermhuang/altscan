import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { TOKEN_HOLDERS_PAGE_SIZE } from '@altscan/providers'
import { buildLocalNetFlowQuery, holdersFromProvider, LOCAL_HOLDERS_LIMIT, LOCAL_HOLDERS_WINDOW } from './holders'
import type { ProviderResult, TokenHoldersPage } from './providers'

const page = (holders: TokenHoldersPage['holders']): ProviderResult<TokenHoldersPage> =>
  ({ ok: true, data: { holders, totalSupply: '100' } })
const H = { address: '0xa', balance: '5', balanceFormatted: '5', usdValue: '10', isContract: false, percentage: '5', label: null }

describe('holdersFromProvider', () => {
  it('maps an ok result with holders + ok count', () => {
    const r = holdersFromProvider(page([H]), { ok: true, data: 42 })
    expect(r).toEqual({
      holders: [{ addr: '0xa', balance: '5', usdValue: '10', isContract: false, label: null }],
      holderCount: 42,
      source: 'moralis',
      totalSupply: '100',
    })
  })
  it('carries the provider\'s own total supply (a string, JSON-safe on the wire) beside the balances it was read with', () => {
    const r = holdersFromProvider({ ok: true, data: { holders: [H], totalSupply: '2500000000000000000000' } }, null)!
    expect(r.totalSupply).toBe('2500000000000000000000')
    expect(JSON.parse(JSON.stringify(r)).totalSupply).toBe('2500000000000000000000')
  })
  it('a missing provider supply stays null (the page then falls back to the token row\'s), never a made-up number', () => {
    expect(holdersFromProvider({ ok: true, data: { holders: [H], totalSupply: null } }, null)!.totalSupply).toBeNull()
  })
  it('returns null on provider failure → caller falls back to the local estimate', () => {
    expect(holdersFromProvider({ ok: false, reason: 'rate_limited' }, null)).toBeNull()
  })
  it('returns null on ok-but-empty holders', () => {
    expect(holdersFromProvider(page([]), null)).toBeNull()
  })
  it('failed count degrades to holderCount:null, not a failure', () => {
    const r = holdersFromProvider(page([H]), { ok: false, reason: 'upstream_error' })
    expect(r?.holderCount).toBeNull()
  })
})

describe('buildLocalNetFlowQuery', () => {
  const TOKEN = '0x55d398326f99059ff775485246999027b3197955'
  const { sql: text, params } = new PgDialect().sqlToQuery(buildLocalNetFlowQuery(TOKEN))
  const flat = text.replace(/\s+/g, ' ')

  it('windows the token to its latest 10,000 transfers, not every retained row', () => {
    expect(LOCAL_HOLDERS_WINDOW).toBe(10_000)
    // The LIMIT sits inside the `recent` CTE, so the GROUP BY never sees more than the window.
    expect(flat).toMatch(/WITH recent AS \(.*LIMIT 10000 \), flows AS/)
    expect(flat.match(/FROM token_transfers/g)).toHaveLength(1)
  })

  it("orders the window like the transfer list, so (token_address, timestamp DESC) serves it", () => {
    expect(flat).toContain('WHERE token_address = $1 ORDER BY timestamp DESC, block_number DESC LIMIT 10000')
  })

  it('binds only the token; the window is a literal the planner always sees', () => {
    expect(params).toEqual([TOKEN])
  })

  it('nets inflows against outflows and ranks numerically, top 25 with a positive balance', () => {
    expect(flat).toContain('SELECT to_address AS addr, v FROM recent UNION ALL SELECT from_address AS addr, -v FROM recent')
    expect(flat).toContain('GROUP BY addr HAVING SUM(v) > 0 ORDER BY SUM(v) DESC LIMIT 25')
  })

  it("returns as many rows as the provider's page, so the estimate -> live swap does not change the table's height", () => {
    // HoldersLazy swaps this estimate for the provider's holders after mount; LIMIT 10 against 25
    // rows was a 15-row layout shift (CLS 0.19 on USDT). Both read TOKEN_HOLDERS_PAGE_SIZE.
    expect(LOCAL_HOLDERS_LIMIT).toBe(TOKEN_HOLDERS_PAGE_SIZE)
    expect(TOKEN_HOLDERS_PAGE_SIZE).toBe(25)
  })
})
