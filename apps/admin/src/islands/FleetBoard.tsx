import { useEffect, useState } from 'react'
import type { FleetPayload } from '../lib/fleet'

const HEALTH_CLASS: Record<string, string> = { ok: 'ok', degraded: 'warn', unreachable: 'bad' }

/** getMoralisLimiterState() shape is version-dependent — render defensively. */
function formatMoralis(m: unknown): string {
  if (!m || typeof m !== 'object') return '—'
  const rec = m as Record<string, unknown>
  if (rec.limited === true) return 'LIMITED'
  const buckets = (rec.buckets && typeof rec.buckets === 'object' ? rec.buckets : rec) as Record<
    string,
    unknown
  >
  const parts = Object.entries(buckets)
    .filter(([, v]) => v !== null && typeof v === 'object')
    .slice(0, 4)
    .map(([k, v]) => {
      const b = v as Record<string, unknown>
      const used = b.daily ?? b.used
      const max = b.dailyMax ?? b.max
      return typeof used === 'number' ? `${k} ${used}${typeof max === 'number' ? `/${max}` : ''}` : null
    })
    .filter(Boolean)
  return parts.length ? parts.join(' · ') : 'ok'
}

export function FleetBoard() {
  const [data, setData] = useState<FleetPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      fetch('/api/fleet.json')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: FleetPayload) => {
          if (alive) {
            setData(d)
            setError(null)
          }
        })
        .catch((e) => alive && setError(String(e)))
    load()
    const timer = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  if (error) return <p className="msg err">fleet load failed: {error}</p>
  if (!data) return <p>loading fleet…</p>

  return (
    <div className="grid">
      {data.explorers.map((x) => (
        <div className="card" key={x.id}>
          <h3>
            <a href={`/x/${x.id}`}>{x.brand}</a>{' '}
            <span className={`pill ${HEALTH_CLASS[x.health] ?? ''}`}>{x.health}</span>
          </h3>
          <dl className="kv">
            <dt>latest block</dt>
            <dd>{x.latestBlock ?? '—'}</dd>
            <dt>lag</dt>
            <dd>{x.lagSeconds != null ? `${x.lagSeconds}s` : '—'}</dd>
            <dt>db size</dt>
            <dd>{x.dbSizeMB != null ? `${x.dbSizeMB} MB` : '—'}</dd>
            <dt>memory</dt>
            <dd>{x.memoryStatus ?? '—'}</dd>
            <dt>moralis</dt>
            <dd>{formatMoralis(x.moralis)}</dd>
            <dt>web deploy</dt>
            <dd>{x.deploys.web ? `${x.deploys.web.status} @ ${x.deploys.web.commit ?? '?'}` : '—'}</dd>
            <dt>indexer deploy</dt>
            <dd>
              {x.deploys.indexer
                ? `${x.deploys.indexer.status} @ ${x.deploys.indexer.commit ?? '?'}`
                : '—'}
            </dd>
            <dt>site</dt>
            <dd>
              <a href={x.publicUrl} target="_blank" rel="noopener noreferrer">
                {x.publicUrl.replace('https://', '')} ↗
              </a>
            </dd>
          </dl>
        </div>
      ))}
    </div>
  )
}
