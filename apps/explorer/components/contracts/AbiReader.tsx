'use client'
import { useState } from 'react'

type AbiFunction = {
  name: string
  type: string
  stateMutability: string
  inputs: { name: string; type: string }[]
  outputs: { name: string; type: string }[]
}

export function AbiReader({ address, abi }: { address: string; abi: unknown[] }) {
  const functions = (abi as AbiFunction[]).filter(
    f => f.type === 'function' && (f.stateMutability === 'view' || f.stateMutability === 'pure')
  )

  if (functions.length === 0) {
    return <p className="text-gray-500 text-sm">No readable functions found in ABI.</p>
  }

  return (
    <div className="space-y-2">
      {functions.map((fn, i) => (
        <FunctionCard key={i} address={address} fn={fn} />
      ))}
    </div>
  )
}

function FunctionCard({ address, fn }: { address: string; fn: AbiFunction }) {
  const [expanded, setExpanded] = useState(false)
  const [args, setArgs] = useState<string[]>(fn.inputs.map(() => ''))
  const [result, setResult] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const call = async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(`/api/v1/contracts/${address}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ functionName: fn.name, args }),
      })
      const data = await res.json() as { result?: unknown; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Call failed')
      setResult(JSON.stringify(data.result, null, 2))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 hover:bg-gray-100 text-left text-sm font-mono"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-blue-700">{fn.name}</span>
        <span className="text-gray-400 text-xs">{fn.outputs.map(o => o.type).join(', ')}</span>
      </button>
      {expanded && (
        <div className="p-4 space-y-3 text-sm">
          {fn.inputs.map((inp, i) => (
            <div key={i}>
              <label className="block text-gray-500 text-xs mb-1">{inp.name || `param${i}`} ({inp.type})</label>
              <input
                className="w-full border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-yellow-400"
                placeholder={inp.type}
                value={args[i]}
                onChange={e => {
                  const next = [...args]
                  next[i] = e.target.value
                  setArgs(next)
                }}
              />
            </div>
          ))}
          <button
            onClick={call}
            disabled={loading}
            className="px-4 py-1.5 bg-yellow-400 hover:bg-yellow-500 rounded text-sm font-medium disabled:opacity-50"
          >
            {loading ? 'Querying...' : 'Query'}
          </button>
          {error && <p className="text-red-600 text-xs">{error}</p>}
          {result && (
            <pre className="bg-gray-900 text-green-400 rounded p-3 text-xs overflow-auto max-h-40">{result}</pre>
          )}
        </div>
      )}
    </div>
  )
}
