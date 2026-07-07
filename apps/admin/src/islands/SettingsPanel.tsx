import { useEffect, useState } from 'react'

type SettingRow = { value: unknown; version: number; updatedAt: string; updatedBy: string | null }
type SettingsPayload = {
  chain: string
  keys: string[]
  adPlacements: string[]
  settings: Record<string, SettingRow>
  defaults: Record<string, unknown>
  role: 'owner' | 'admin' | 'viewer'
  warning?: string
}
type AuditEntry = { id: number; version: number; value: unknown; updatedAt: string; updatedBy: string | null }

type QuickLink = { label: string; href: string }
type LinksValue = { quickLinks: QuickLink[] }
type FooterValue = { tagline?: string; notAffiliatedWith?: string }
type AdsValue = { binanceRefCode?: string; placements?: Record<string, { enabled: boolean }> }

function currentValue<T>(p: SettingsPayload, key: string): T | null {
  return (p.settings[key]?.value as T | undefined) ?? null
}

export function SettingsPanel({ explorerId }: { explorerId: string }) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [links, setLinks] = useState<LinksValue>({ quickLinks: [] })
  const [footer, setFooter] = useState<FooterValue>({})
  const [ads, setAds] = useState<AdsValue>({})
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [auditKey, setAuditKey] = useState<string | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [busy, setBusy] = useState(false)

  const load = () =>
    fetch(`/api/x/${explorerId}/settings.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((p: SettingsPayload) => {
        setPayload(p)
        setLinks(currentValue<LinksValue>(p, 'links') ?? { quickLinks: [] })
        setFooter(currentValue<FooterValue>(p, 'footer') ?? {})
        setAds(currentValue<AdsValue>(p, 'ads') ?? {})
      })
      .catch((e) => setMessage({ kind: 'err', text: String(e) }))

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorerId])

  const drafts: Record<string, unknown> = { links, footer, ads }

  // "No saved row" compares against the empty draft shape, so a pristine
  // panel is not dirty and Save stays disabled until something changes.
  const emptyDraft = (key: string): unknown => (key === 'links' ? { quickLinks: [] } : {})
  const isDirty = (key: string): boolean => {
    if (!payload) return false
    const saved = payload.settings[key]?.value ?? emptyDraft(key)
    return JSON.stringify(drafts[key]) !== JSON.stringify(saved)
  }

  if (!payload) return message ? <p className="msg err">{message.text}</p> : <p>loading settings…</p>
  const readOnly = payload.role === 'viewer'

  async function save(key: string) {
    if (!payload) return
    setBusy(true)
    setMessage(null)
    const res = await fetch(`/api/x/${explorerId}/settings/${key}.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: drafts[key], expectedVersion: payload.settings[key]?.version }),
    })
    const body = await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok) {
      setMessage({ kind: 'ok', text: `${key} saved (v${body.version}) — live within ~60s` })
      void load()
    } else {
      setMessage({ kind: 'err', text: `${key}: ${body.error ?? `HTTP ${res.status}`}` })
    }
  }

  async function showAudit(key: string) {
    setAuditKey(key)
    const res = await fetch(`/api/x/${explorerId}/settings/${key}/audit.json`)
    const body = await res.json().catch(() => ({ entries: [] }))
    setAuditEntries(Array.isArray(body.entries) ? body.entries : [])
  }

  function restore(entry: AuditEntry) {
    if (auditKey === 'links') setLinks(entry.value as LinksValue)
    if (auditKey === 'footer') setFooter(entry.value as FooterValue)
    if (auditKey === 'ads') setAds(entry.value as AdsValue)
    setMessage({ kind: 'ok', text: `v${entry.version} loaded into the draft — review the diff, then Save` })
  }

  const placementEnabled = (p: string) => ads.placements?.[p]?.enabled !== false

  return (
    <div>
      {payload.warning && <p className="msg err">{payload.warning}</p>}
      {message && <p className={`msg ${message.kind}`}>{message.text}</p>}
      {readOnly && <p className="msg err">viewer role — read-only</p>}

      <div className="card">
        <h3>Footer links (namespace: links)</h3>
        <table>
          <thead>
            <tr>
              <th>label</th>
              <th>href (/path or https://…)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {links.quickLinks.map((l, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={l.label}
                    onChange={(e) =>
                      setLinks({
                        quickLinks: links.quickLinks.map((q, j) => (j === i ? { ...q, label: e.target.value } : q)),
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={l.href}
                    onChange={(e) =>
                      setLinks({
                        quickLinks: links.quickLinks.map((q, j) => (j === i ? { ...q, href: e.target.value } : q)),
                      })
                    }
                  />
                </td>
                <td>
                  <button
                    disabled={readOnly}
                    onClick={() => setLinks({ quickLinks: links.quickLinks.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="row">
          <button
            disabled={readOnly}
            onClick={() => setLinks({ quickLinks: [...links.quickLinks, { label: '', href: '/' }] })}
          >
            + add link
          </button>
          <span>empty list = built-in defaults</span>
        </p>
        <SaveRow k="links" />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Footer text (namespace: footer)</h3>
        <dl className="kv">
          <dt>tagline</dt>
          <dd>
            <input
              type="text"
              disabled={readOnly}
              value={footer.tagline ?? ''}
              placeholder="(default from chain-config)"
              onChange={(e) => setFooter({ ...footer, tagline: e.target.value || undefined })}
            />
          </dd>
          <dt>not affiliated with</dt>
          <dd>
            <input
              type="text"
              disabled={readOnly}
              value={footer.notAffiliatedWith ?? ''}
              placeholder="(default from chain-config)"
              onChange={(e) => setFooter({ ...footer, notAffiliatedWith: e.target.value || undefined })}
            />
          </dd>
        </dl>
        <SaveRow k="footer" />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Ads (namespace: ads)</h3>
        <dl className="kv">
          <dt>binance ref code</dt>
          <dd>
            <input
              type="text"
              disabled={readOnly}
              value={ads.binanceRefCode ?? ''}
              placeholder="(default BNBSCAN/ETHSCAN)"
              onChange={(e) => setAds({ ...ads, binanceRefCode: e.target.value || undefined })}
            />
          </dd>
        </dl>
        <p>placements (unchecked = hidden):</p>
        <div className="toggle-grid">
          {payload.adPlacements.map((p) => (
            <label className="toggle" key={p}>
              <input
                type="checkbox"
                disabled={readOnly}
                checked={placementEnabled(p)}
                onChange={(e) =>
                  setAds({ ...ads, placements: { ...(ads.placements ?? {}), [p]: { enabled: e.target.checked } } })
                }
              />
              {p}
            </label>
          ))}
        </div>
        <SaveRow k="ads" />
      </div>

      {auditKey && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>History — {auditKey}</h3>
          {auditEntries.length === 0 && <p>no writes yet</p>}
          <table>
            <tbody>
              {auditEntries.map((a) => (
                <tr key={a.id}>
                  <td>v{a.version}</td>
                  <td>{a.updatedAt}</td>
                  <td>{a.updatedBy ?? '—'}</td>
                  <td>
                    <pre className="diff">{JSON.stringify(a.value, null, 1)}</pre>
                  </td>
                  <td>
                    <button disabled={readOnly} onClick={() => restore(a)}>
                      load into draft
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  function SaveRow({ k }: { k: string }) {
    const saved = payload!.settings[k]?.value
    const dirty = isDirty(k)
    return (
      <div>
        {dirty && (
          <pre className="diff">
            {`current: ${JSON.stringify(saved ?? '(defaults)', null, 1)}\n→ draft: ${JSON.stringify(drafts[k], null, 1)}`}
          </pre>
        )}
        <p className="row">
          <button className="primary" disabled={readOnly || busy || !dirty} onClick={() => save(k)}>
            Save {k}{' '}
            {payload!.settings[k] ? `(v${payload!.settings[k].version} → v${payload!.settings[k].version + 1})` : '(v1)'}
          </button>
          <button onClick={() => showAudit(k)}>history</button>
        </p>
      </div>
    )
  }
}
