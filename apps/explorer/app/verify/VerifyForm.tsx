'use client'
import { useState } from 'react'

type Status = 'idle' | 'loading' | 'success' | 'error'

/** Shown when the route gives no reason of its own. */
export const CHECK_FAILED_MESSAGE = 'The Sourcify check failed. The contract may not be verified there yet.'

export function VerifyForm() {
  const [address,  setAddress]  = useState('')
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
        body: JSON.stringify({ address: trimmed }),
      })
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      if (data.success) {
        setStatus('success')
        setMessage('Verified on Sourcify.')
      } else {
        setStatus('error')
        setMessage(data.error ?? CHECK_FAILED_MESSAGE)
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
        {status === 'loading' ? 'Checking…' : 'Check Sourcify'}
      </button>
    </form>
  )
}
