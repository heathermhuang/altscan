'use client'

import { useEffect, useState } from 'react'

type Sample = {
  t: number                      // client-wall time of sample
  latestIndexedBlock: number
  latestIndexedTimestamp: number // chain time (ms) of the indexed block
  chainTip: number
}

type StatusPayload = {
  serverNow: number
  latestIndexedBlock: number | null
  latestIndexedTimestamp: number | null
  chainTip: number | null
}

const POLL_MS = 3_000
// Rolling window used to average rates. Long enough to smooth out per-block
// jitter, short enough to reflect the indexer's current state.
const WINDOW_MS = 60_000

export function StatusDashboard() {
  const [samples, setSamples] = useState<Sample[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' })
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data = (await res.json()) as StatusPayload
        if (cancelled) return
        if (
          data.latestIndexedBlock === null ||
          data.latestIndexedTimestamp === null ||
          data.chainTip === null
        ) {
          setError('Indexer not responding')
          return
        }
        const now = Date.now()
        const cutoff = now - WINDOW_MS - POLL_MS
        const next: Sample = {
          t: now,
          latestIndexedBlock: data.latestIndexedBlock,
          latestIndexedTimestamp: data.latestIndexedTimestamp,
          chainTip: data.chainTip,
        }
        setSamples(prev => [...prev.filter(s => s.t >= cutoff), next])
        setError(null)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'poll failed')
      }
    }

    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const latest = samples[samples.length - 1]
  const oldest = samples[0]
  const windowSec = latest && oldest ? (latest.t - oldest.t) / 1000 : 0

  const indexerRate = latest && oldest && windowSec > 0
    ? (latest.latestIndexedBlock - oldest.latestIndexedBlock) / windowSec
    : null

  const chainRate = latest && oldest && windowSec > 0
    ? (latest.chainTip - oldest.chainTip) / windowSec
    : null

  const blockLag = latest ? latest.chainTip - latest.latestIndexedBlock : null
  const timeLag = latest ? Math.max(0, Date.now() - latest.latestIndexedTimestamp) : null

  // Catch-up ETA: only meaningful when the indexer is outpacing the chain.
  let etaSeconds: number | null = null
  let trend: 'catching-up' | 'falling-behind' | 'at-tip' | 'warming' = 'warming'
  if (indexerRate !== null && chainRate !== null && blockLag !== null) {
    const closingRate = indexerRate - chainRate
    if (blockLag <= 5) trend = 'at-tip'
    else if (closingRate > 0.01) {
      trend = 'catching-up'
      etaSeconds = blockLag / closingRate
    } else {
      trend = 'falling-behind'
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Stat
          label="Current block lag"
          value={blockLag === null ? '—' : fmtNumber(blockLag) + ' blocks'}
          sub={timeLag === null ? null : fmtDuration(timeLag / 1000) + ' behind chain time'}
          tone={blockLag === null ? 'neutral' : blockLag > 1000 ? 'bad' : blockLag > 100 ? 'warn' : 'good'}
        />
        <Stat
          label="Status"
          value={trendLabel(trend)}
          sub={
            trend === 'catching-up' && etaSeconds !== null
              ? `Caught up in ~${fmtDuration(etaSeconds)}`
              : trend === 'falling-behind'
              ? 'Indexer is slower than chain'
              : trend === 'at-tip'
              ? 'Tracking the tip'
              : 'Gathering samples…'
          }
          tone={
            trend === 'falling-behind' ? 'bad' :
            trend === 'warming' ? 'neutral' :
            trend === 'catching-up' ? 'warn' : 'good'
          }
        />
        <Stat
          label="Indexer speed"
          value={indexerRate === null ? '—' : indexerRate.toFixed(2) + ' blk/s'}
          sub={windowSec > 0 ? `Rolling ${Math.round(windowSec)}s window` : 'Waiting for samples'}
          tone="neutral"
        />
        <Stat
          label="Chain rate"
          value={chainRate === null ? '—' : chainRate.toFixed(2) + ' blk/s'}
          sub={chainRate === null ? null : `${(1 / chainRate).toFixed(2)}s per block`}
          tone="neutral"
        />
      </div>

      {latest && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 space-y-1">
          <Row k="Latest indexed block" v={fmtNumber(latest.latestIndexedBlock)} />
          <Row k="Chain tip" v={fmtNumber(latest.chainTip)} />
          <Row k="Samples in window" v={`${samples.length} (every ${POLL_MS / 1000}s)`} />
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string | null
  tone: 'good' | 'warn' | 'bad' | 'neutral'
}) {
  const toneCls =
    tone === 'good' ? 'text-green-700' :
    tone === 'warn' ? 'text-yellow-700' :
    tone === 'bad'  ? 'text-red-700'    :
                      'text-gray-900'
  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {sub && <div className="text-sm text-gray-600 mt-0.5">{sub}</div>}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-gray-600">{k}</span>
      <span className="font-mono tabular-nums">{v}</span>
    </div>
  )
}

function trendLabel(t: 'catching-up' | 'falling-behind' | 'at-tip' | 'warming'): string {
  if (t === 'at-tip') return 'At tip'
  if (t === 'catching-up') return 'Catching up'
  if (t === 'falling-behind') return 'Falling behind'
  return '…'
}

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.round((seconds % 86400) / 3600)}h`
}
