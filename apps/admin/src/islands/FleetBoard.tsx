import { useEffect, useState } from 'react'
import type { FleetPayload } from '../lib/fleet'
import { safeExternalUrl } from '../lib/safe-url'

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
  if (!data)
    return (
      <>
        <p className="muted">contacting explorers…</p>
        <div className="grid">
          {[0, 1].map((i) => (
            <div className="card skeleton" key={i} aria-hidden="true">
              <div className="sk w40" />
              <div className="sk w70" />
              <div className="sk w55" />
              <div className="sk w70" />
            </div>
          ))}
        </div>
      </>
    )

  return (
    <div className="grid">
      {data.explorers.map((x) => (
        // Whole card is a click target (stretched-link pattern below); the
        // external site link opts back out with its own stacking context.
        <div className="card fleet-card" key={x.id}>
          <h3>
            <a className="card-link" href={`/x/${x.id}`}>
              {x.brand}
            </a>{' '}
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
              <a className="ext" href={safeExternalUrl(x.publicUrl)} target="_blank" rel="noopener noreferrer">
                {x.publicUrl.replace('https://', '')} ↗
              </a>
            </dd>
          </dl>
          <p className="card-cta">Manage settings →</p>
        </div>
      ))}
    </div>
  )
}
