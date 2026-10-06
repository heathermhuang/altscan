'use client'
import { useState } from 'react'
import { chainConfig } from '@/lib/chain-client'
import { AdSlot } from '@/components/ads/AdSlot'

type Status = 'idle' | 'loading' | 'success' | 'error'

export default function VerifyPage() {
  const [address,  setAddress]  = useState('')
  const [compiler, setCompiler] = useState('v0.8.19+commit.7dd6d404')
  const [status,   setStatus]   = useState<Status>('idle')
  const [message,  setMessage]  = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = address.trim()
    if (!trimmed) return
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      setStatus('error')
      setMessage('Invalid address format. Must be a 0x-prefixed 40-character hex string.')
      return
    }
    setStatus('loading')
    setMessage('')
    try {
      const res = await fetch('/api/v1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: trimmed, compilerVersion: compiler }),
      })
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      if (data.success) {
        setStatus('success')
        setMessage('Contract verified successfully via Sourcify!')
      } else {
        setStatus('error')
        setMessage(data.error ?? 'Verification failed — contract may not be on Sourcify yet.')
      }
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : 'Network error. Please try again.')
    }
  }

  const statusStyles: Record<Status, string> = {
    idle:    '',
    loading: 'border-l-acc',
    success: 'border-l-live bg-live-t',
    error:   'border-l-warn bg-warn-t',
  }

  const field = 'w-full rounded-[9px] border border-hair bg-card px-3 py-2 text-sm text-ink placeholder:text-mut hover:border-hair3'

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 *:max-w-3xl">
      <div className="mb-5">
        <p className="k">{'// '}verify</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Verify Contract Source Code</h1>
        <p className="mt-2 text-sm text-ink2">
          Verify and publish your contract source code. We check{' '}
          <a href="https://sourcify.dev" className="text-acc-ink underline hover:no-underline" target="_blank" rel="noreferrer">
            Sourcify
          </a>{' '}
          for existing verifications on {chainConfig.name} (chain ID {chainConfig.chainId}).
        </p>
      </div>

      <AdSlot
        context="verify"
        placement="verify_intro"
        variant="compact"
        className="mb-8"
      />

      <form onSubmit={handleSubmit} className="space-y-5 rounded-xl border border-hair bg-card p-6">
        <div>
          <label htmlFor="verify-address" className="mb-1 block text-sm font-medium text-ink">
            Contract Address <span className="text-warn">*</span>
          </label>
          <input
            id="verify-address"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="0x..."
            className={`${field} font-mono`}
            required
          />
        </div>

        <div>
          <label htmlFor="verify-compiler" className="mb-1 block text-sm font-medium text-ink">Compiler Version</label>
          <input
            id="verify-compiler"
            value={compiler}
            onChange={e => setCompiler(e.target.value)}
            className={field}
          />
          <p className="mt-1 text-xs text-mut">e.g. v0.8.19+commit.7dd6d404</p>
        </div>

        {status !== 'idle' && (
          <div className={`rounded-xl border border-hair border-l-[3px] px-4 py-3 text-sm text-ink2 ${statusStyles[status]}`}>
            {status === 'loading' ? 'Checking Sourcify…' : message}
          </div>
        )}

        <button
          type="submit"
          disabled={status === 'loading'}
          className="w-full rounded-[9px] bg-ink px-4 py-2.5 font-semibold text-card transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {status === 'loading' ? 'Verifying…' : 'Verify & Publish'}
        </button>
      </form>
    </div>
  )
}
