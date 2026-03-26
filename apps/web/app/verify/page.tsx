'use client'
import { useState } from 'react'

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
    loading: 'bg-yellow-50 text-yellow-700 border border-yellow-200',
    success: 'bg-green-50  text-green-700  border border-green-200',
    error:   'bg-red-50    text-red-700    border border-red-200',
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-2">Verify Contract Source Code</h1>
      <p className="text-gray-500 mb-8">
        Verify and publish your contract source code. We check{' '}
        <a href="https://sourcify.dev" className="text-yellow-600 hover:underline" target="_blank" rel="noreferrer">
          Sourcify
        </a>{' '}
        for existing verifications on BNB Chain (chain ID 56).
      </p>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border shadow-sm p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium mb-1">
            Contract Address <span className="text-red-500">*</span>
          </label>
          <input
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="0x..."
            className="w-full border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Compiler Version</label>
          <input
            value={compiler}
            onChange={e => setCompiler(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
          />
          <p className="text-xs text-gray-400 mt-1">e.g. v0.8.19+commit.7dd6d404</p>
        </div>

        {status !== 'idle' && (
          <div className={`p-3 rounded-lg text-sm ${statusStyles[status]}`}>
            {status === 'loading' ? 'Checking Sourcify…' : message}
          </div>
        )}

        <button
          type="submit"
          disabled={status === 'loading'}
          className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-black font-semibold py-2.5 px-4 rounded-lg transition-colors"
        >
          {status === 'loading' ? 'Verifying…' : 'Verify & Publish'}
        </button>
      </form>
    </div>
  )
}
