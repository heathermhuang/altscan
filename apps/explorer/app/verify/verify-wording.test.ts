import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// POST /api/v1/verify takes an address and nothing else: it asks Sourcify whether the contract is verified
// there (lib/verifier.ts triggerSourcifyVerification: "Just check if already verified"). The form must say
// that. The risk signal knows only the local `contracts` table, so it says what is recorded HERE and points at
// Sourcify: a contract can be verified there and never have been checked through this explorer.

const h = vi.hoisted(() => ({ contract: null as Record<string, unknown> | null }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const q = { where: () => q, limit: () => q, then: (ok: (v: unknown[]) => unknown) => Promise.resolve(h.contract ? [h.contract] : []).then(ok) }
  return { schema, db: { select: () => ({ from: () => q }) } }
})
vi.mock('@/lib/rpc', () => ({ getWebProvider: async () => { throw new Error('no rpc in this test') } }))

import { VerifyForm, CHECK_FAILED_MESSAGE } from './VerifyForm'
import VerifyPage from './page'
import { metadata } from './layout'
import { analyzeTokenRisk } from '@/lib/token-risk'

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf((node as { props?: { children?: ReactNode } }).props?.children)
}

describe('/verify wording matches what the form does', () => {
  it('the button says it checks Sourcify, and never promises to publish', () => {
    const html = renderToStaticMarkup(createElement(VerifyForm))
    expect(html).toContain('>Check Sourcify</button>')
    expect(html).not.toMatch(/publish/i)
  })

  it('the page says it looks for a verified match on Sourcify, and does not offer to take source code', () => {
    const copy = textOf(VerifyPage())
    expect(copy).toMatch(/Look up a contract on Sourcify/)
    expect(copy).toMatch(/takes an address, not source code/)
    expect(copy).not.toMatch(/publish/i)
    const description = String(metadata.description)
    expect(description).toMatch(/Sourcify/)
    expect(description).not.toMatch(/publish|match deployed bytecode/i)
  })
})

describe('/verify: the rest of the wording says "check" too', () => {
  it('the tab title names the Sourcify check, not a verification the page cannot perform', () => {
    expect(String(metadata.title)).toMatch(/Sourcify/)
    expect(String(metadata.title)).not.toMatch(/^Verify/)
  })

  it('the error fallback says the check failed, not that verification failed', () => {
    expect(CHECK_FAILED_MESSAGE).toMatch(/check failed/i)
    expect(CHECK_FAILED_MESSAGE).not.toMatch(/verification failed/i)
  })
})

describe('token risk: Source Verified', () => {
  it('a contract with no local record says so and points at Sourcify; it does not claim Sourcify has no match', async () => {
    h.contract = null
    const signal = (await analyzeTokenRisk('0x' + '1'.repeat(40))).find(s => s.label === 'Source Verified')
    expect(signal).toMatchObject({ ok: false, description: 'No verified source recorded here — check Sourcify', severity: 'danger' })
    expect(signal?.description).not.toMatch(/not verified on sourcify|cannot audit/i)
  })

  it('a verified contract keeps its signal', async () => {
    h.contract = { verifiedAt: new Date('2026-10-01T00:00:00Z'), abi: null }
    const signal = (await analyzeTokenRisk('0x' + '1'.repeat(40))).find(s => s.label === 'Source Verified')
    expect(signal).toMatchObject({ ok: true, description: 'Source code is verified and public', severity: 'info' })
  })
})
