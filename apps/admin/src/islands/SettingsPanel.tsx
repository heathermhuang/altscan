import { useEffect, useState } from 'react'
import { canWrite, type Role } from '../lib/rbac'
// type-only: erased at build, so zod never reaches the client bundle.
import type { RpcProbeResult as RpcProbe } from '../lib/rpc-probe'

type SettingRow = { value: unknown; version: number; updatedAt: string; updatedBy: string | null }
type SettingsPayload = {
  chain: string
  keys: string[]
  adPlacements: string[]
  settings: Record<string, SettingRow>
  defaults: Record<string, unknown>
  role: Role
  warning?: string
}
type AuditEntry = { id: number; version: number; value: unknown; updatedAt: string; updatedBy: string | null }

type QuickLink = { label: string; href: string }
type LinksValue = { quickLinks: QuickLink[] }
type FooterValue = { tagline?: string; notAffiliatedWith?: string }
type HouseCreativeValue = {
  id: string
  headline: string
  body?: string
  ctaText: string
  ctaUrl: string
  imageKey?: string
  imageAlt?: string
}
type AdSlotValue = { provider: 'binance' | 'house'; creativeId?: string; weight: number }
type AdsValue = {
  binanceRefCode?: string
  creatives?: HouseCreativeValue[]
  placements?: Record<string, { enabled?: boolean; mix?: AdSlotValue[] }>
}
type RpcValue = { webRpcUrl?: string; rpcTimeoutMs?: number }

function currentValue<T>(p: SettingsPayload, key: string): T | null {
  return (p.settings[key]?.value as T | undefined) ?? null
}

/** Module-level (NOT nested in SettingsPanel) so React keeps a stable
 *  component identity across parent re-renders — a nested definition would
 *  remount this subtree on every keystroke. */
function SaveRow({
  k,
  saved,
  draft,
  dirty,
  readOnly,
  busy,
  version,
  onSave,
  onHistory,
}: {
  k: string
  saved: unknown
  draft: unknown
  dirty: boolean
  readOnly: boolean
  busy: boolean
  version: number | undefined
  onSave: () => void
  onHistory: () => void
}) {
  return (
    <div>
      {dirty && (
        <pre className="diff">
          {`current: ${JSON.stringify(saved ?? '(defaults)', null, 1)}\n→ draft: ${JSON.stringify(draft, null, 1)}`}
        </pre>
      )}
      <p className="row">
        <button className="primary" disabled={readOnly || busy || !dirty} onClick={onSave}>
          Save {k} {version !== undefined ? `(v${version} → v${version + 1})` : '(v1)'}
        </button>
        <button onClick={onHistory}>history</button>
      </p>
    </div>
  )
}

export function SettingsPanel({ explorerId }: { explorerId: string }) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [links, setLinks] = useState<LinksValue>({ quickLinks: [] })
  const [footer, setFooter] = useState<FooterValue>({})
  const [ads, setAds] = useState<AdsValue>({})
  const [rpc, setRpc] = useState<RpcValue>({})
  // Probe result, plus the exact URL it was run against — so editing the field
  // after a successful test invalidates the "already verified" save path.
  const [probe, setProbe] = useState<{ forUrl: string; result: RpcProbe } | null>(null)
  const [probing, setProbing] = useState(false)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
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
        setRpc(currentValue<RpcValue>(p, 'rpc') ?? {})
        setProbe(null)
      })
      .catch((e) => setMessage({ kind: 'err', text: String(e) }))

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorerId])

  const drafts: Record<string, unknown> = { links, footer, ads, rpc }

  // "No saved row" compares against the empty draft shape, so a pristine
  // panel is not dirty and Save stays disabled until something changes.
  // JSON.stringify comparison can false-positive on key-order differences
  // (footer/ads drafts are rebuilt via spreads) — harmless: worst case is an
  // enabled Save for an identical value, and the diff shows the real values.
  const emptyDraft = (key: string): unknown => (key === 'links' ? { quickLinks: [] } : {})
  const isDirty = (key: string): boolean => {
    if (!payload) return false
    const saved = payload.settings[key]?.value ?? emptyDraft(key)
    return JSON.stringify(drafts[key]) !== JSON.stringify(saved)
  }

  if (!payload) return message ? <p className="msg err">{message.text}</p> : <p>loading settings…</p>
  // Derive from canWrite (the same predicate the BFF enforces) rather than
  // testing for 'viewer' — a role the UI doesn't recognise must render
  // read-only, not as an editable panel whose Save 403s.
  const readOnly = !canWrite(payload.role)

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
    if (auditKey === 'rpc') {
      setRpc(entry.value as RpcValue)
      setProbe(null) // a restored URL is unverified until it is tested again
    }
    setMessage({ kind: 'ok', text: `v${entry.version} loaded into the draft — review the diff, then Save` })
  }

  const placementEnabled = (p: string) => ads.placements?.[p]?.enabled !== false
  // Host + timeout actually in effect when the override is blank. The explorer
  // deliberately sends the HOST, not the full URL — the fallback can be a keyed
  // endpoint and this payload is readable by viewers too.
  const rpcDefaults = (payload.defaults.rpc ?? {}) as { webRpcHost?: string; rpcTimeoutMs?: number }

  async function testRpc() {
    const url = rpc.webRpcUrl?.trim()
    if (!url) return
    setProbing(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/x/${explorerId}/rpc/test.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const result = (await res.json().catch(() => ({}))) as RpcProbe
      setProbe({ forUrl: url, result })
    } catch (e) {
      setProbe({ forUrl: url, result: { ok: false, expectedChainId: null, error: String(e) } })
    } finally {
      setProbing(false)
    }
  }

  /** Public bucket domain — display and preview only. The explorer builds its
   *  own URL from the stored key, so nothing here is trusted downstream. */
  const PUBLIC_CREATIVE_BASE = 'https://creatives.altscan.io'

  function updateCreative(index: number, patch: Partial<HouseCreativeValue>) {
    setAds((prev) => {
      const creatives = [...(prev.creatives ?? [])]
      creatives[index] = { ...creatives[index], ...patch }
      return { ...prev, creatives }
    })
  }

  async function uploadCreativeImage(index: number, file: File) {
    const creative = ads.creatives?.[index]
    if (!creative) return
    setUploadingId(creative.id)
    setMessage(null)
    try {
      const res = await fetch(`/api/x/${explorerId}/creatives.json`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      })
      const body = (await res.json().catch(() => ({}))) as { key?: string; error?: string }
      if (!res.ok) {
        setMessage({ kind: 'err', text: `upload: ${body.error ?? `HTTP ${res.status}`}` })
        return
      }
      updateCreative(index, { imageKey: body.key })
      setMessage({ kind: 'ok', text: 'image uploaded — Save the ads namespace to apply it' })
    } catch (e) {
      setMessage({ kind: 'err', text: String(e) })
    } finally {
      setUploadingId(null)
    }
  }

  /** Writes a placement's mix while PRESERVING its `enabled` flag, and prunes
   *  the placement entry entirely once neither field is set — so a pristine
   *  panel stays non-dirty. */
  function setMix(placement: string, mix: AdSlotValue[] | undefined) {
    setAds((prev) => {
      const placements = { ...(prev.placements ?? {}) }
      const current = { ...(placements[placement] ?? {}) }
      if (mix && mix.length > 0) current.mix = mix
      else delete current.mix
      if (current.enabled === undefined && current.mix === undefined) delete placements[placement]
      else placements[placement] = current
      return { ...prev, placements }
    })
  }

  /**
   * Save guard (design §6): a URL that was never tested, failed its probe, or
   * answered with the WRONG chain id needs an explicit confirm — this is what
   * stops BNBScan (56) being pointed at an Ethereum (1) endpoint by accident.
   * Clearing the override is always safe: it just restores the env/default.
   */
  async function saveRpc() {
    const url = rpc.webRpcUrl?.trim()
    if (url) {
      const verified =
        probe?.forUrl === url && probe.result.ok && probe.result.chainIdMatches === true
      if (!verified) {
        const reason =
          probe?.forUrl !== url
            ? 'This URL has not been tested.'
            : !probe.result.ok
              ? `The test failed: ${probe.result.error ?? 'unknown error'}`
              : probe.result.chainIdMatches === null
                ? `Chain id ${probe.result.chainId} could not be checked against this explorer.`
                : `Chain id MISMATCH: endpoint reports ${probe.result.chainId}, this explorer expects ${probe.result.expectedChainId}.`
        if (!window.confirm(`${reason}\n\nSave it anyway?`)) return
      }
    }
    await save('rpc')
  }

  return (
    <div>
      {payload.warning && <p className="msg err">{payload.warning}</p>}
      {message && <p className={`msg ${message.kind}`}>{message.text}</p>}
      {readOnly && <p className="msg err">{payload.role} role — read-only</p>}

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
        <SaveRow
          k="links"
          saved={payload.settings.links?.value}
          draft={links}
          dirty={isDirty('links')}
          readOnly={readOnly}
          busy={busy}
          version={payload.settings.links?.version}
          onSave={() => save('links')}
          onHistory={() => showAudit('links')}
        />
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
        <SaveRow
          k="footer"
          saved={payload.settings.footer?.value}
          draft={footer}
          dirty={isDirty('footer')}
          readOnly={readOnly}
          busy={busy}
          version={payload.settings.footer?.version}
          onSave={() => save('footer')}
          onHistory={() => showAudit('footer')}
        />
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
        <h4 style={{ marginBottom: 4 }}>House creatives</h4>
        <p className="hint">
          Uploaded images are stored on a <strong>public</strong> bucket and are readable by anyone
          at {PUBLIC_CREATIVE_BASE}. Upload only artwork intended for the live site. Images are
          never deleted, so reverting to an older version always works — but an abandoned draft
          leaves the uploaded file behind.
        </p>
        {(ads.creatives ?? []).map((c, i) => (
          <div className="card" key={i} style={{ marginTop: 8 }}>
            <p className="row">
              <input
                placeholder="id (a-z0-9-_)"
                disabled={readOnly}
                value={c.id}
                onChange={(e) => updateCreative(i, { id: e.target.value })}
              />
              <input
                placeholder="headline"
                disabled={readOnly}
                value={c.headline}
                onChange={(e) => updateCreative(i, { headline: e.target.value })}
              />
            </p>
            <p className="row">
              <input
                placeholder="body (optional)"
                disabled={readOnly}
                value={c.body ?? ''}
                onChange={(e) => updateCreative(i, { body: e.target.value || undefined })}
              />
              <input
                placeholder="CTA text"
                disabled={readOnly}
                value={c.ctaText}
                onChange={(e) => updateCreative(i, { ctaText: e.target.value })}
              />
              <input
                placeholder="CTA url (/path or https://)"
                disabled={readOnly}
                value={c.ctaUrl}
                onChange={(e) => updateCreative(i, { ctaUrl: e.target.value })}
              />
            </p>
            <p className="row">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={readOnly || uploadingId === c.id}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void uploadCreativeImage(i, file)
                }}
              />
              {uploadingId === c.id && <span>uploading…</span>}
              {c.imageKey && (
                <>
                  <img
                    src={`${PUBLIC_CREATIVE_BASE}/${c.imageKey}`}
                    alt=""
                    width={36}
                    height={36}
                    style={{ objectFit: 'cover', borderRadius: 6 }}
                  />
                  <input
                    placeholder="image alt text (required)"
                    disabled={readOnly}
                    value={c.imageAlt ?? ''}
                    onChange={(e) => updateCreative(i, { imageAlt: e.target.value || undefined })}
                  />
                  <button
                    disabled={readOnly}
                    onClick={() => updateCreative(i, { imageKey: undefined, imageAlt: undefined })}
                  >
                    remove image
                  </button>
                </>
              )}
            </p>
            <p className="row">
              <button
                disabled={readOnly}
                onClick={() =>
                  setAds((prev) => ({
                    ...prev,
                    creatives: (prev.creatives ?? []).filter((_, j) => j !== i),
                  }))
                }
              >
                remove creative
              </button>
            </p>
          </div>
        ))}
        <p className="row">
          <button
            disabled={readOnly || (ads.creatives?.length ?? 0) >= 12}
            onClick={() =>
              setAds((prev) => ({
                ...prev,
                creatives: [
                  ...(prev.creatives ?? []),
                  {
                    id: `creative-${(prev.creatives?.length ?? 0) + 1}`,
                    headline: '',
                    ctaText: '',
                    ctaUrl: '/',
                  },
                ],
              }))
            }
          >
            + add creative
          </button>
          <span>max 12</span>
        </p>

        <p>placements (unchecked = hidden; no slots = Binance only):</p>
        <div>
          {payload.adPlacements.map((p) => (
            <div className="row" key={p} style={{ alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              <label className="toggle" style={{ minWidth: 210 }}>
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={placementEnabled(p)}
                  onChange={(e) =>
                    // Spread the existing entry: replacing it wholesale would
                    // silently drop this placement's mix.
                    setAds({
                      ...ads,
                      placements: {
                        ...(ads.placements ?? {}),
                        [p]: { ...(ads.placements?.[p] ?? {}), enabled: e.target.checked },
                      },
                    })
                  }
                />
                {p}
              </label>
              {(ads.placements?.[p]?.mix ?? []).map((slot, si) => (
                <span className="row" key={si} style={{ gap: 4 }}>
                  <select
                    disabled={readOnly}
                    value={slot.provider}
                    onChange={(e) => {
                      const provider = e.target.value as 'binance' | 'house'
                      const mix = [...(ads.placements?.[p]?.mix ?? [])]
                      mix[si] =
                        provider === 'binance'
                          ? { provider, weight: slot.weight }
                          : { provider, creativeId: ads.creatives?.[0]?.id ?? '', weight: slot.weight }
                      setMix(p, mix)
                    }}
                  >
                    <option value="binance">Binance</option>
                    <option value="house">House</option>
                  </select>
                  {slot.provider === 'house' && (
                    <select
                      disabled={readOnly}
                      value={slot.creativeId ?? ''}
                      onChange={(e) => {
                        const mix = [...(ads.placements?.[p]?.mix ?? [])]
                        mix[si] = { ...slot, creativeId: e.target.value }
                        setMix(p, mix)
                      }}
                    >
                      <option value="">— pick a creative —</option>
                      {(ads.creatives ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.id}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    type="number"
                    min={1}
                    max={100}
                    disabled={readOnly}
                    value={slot.weight}
                    style={{ width: 64 }}
                    onChange={(e) => {
                      const mix = [...(ads.placements?.[p]?.mix ?? [])]
                      mix[si] = { ...slot, weight: Number(e.target.value) }
                      setMix(p, mix)
                    }}
                  />
                  <button
                    disabled={readOnly}
                    onClick={() =>
                      setMix(
                        p,
                        (ads.placements?.[p]?.mix ?? []).filter((_, j) => j !== si),
                      )
                    }
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button
                disabled={readOnly || (ads.placements?.[p]?.mix?.length ?? 0) >= 6}
                onClick={() =>
                  setMix(p, [...(ads.placements?.[p]?.mix ?? []), { provider: 'binance', weight: 1 }])
                }
              >
                {ads.placements?.[p]?.mix?.length ? '+ slot' : 'customise (Binance only)'}
              </button>
            </div>
          ))}
        </div>
        <SaveRow
          k="ads"
          saved={payload.settings.ads?.value}
          draft={ads}
          dirty={isDirty('ads')}
          readOnly={readOnly}
          busy={busy}
          version={payload.settings.ads?.version}
          onSave={() => save('ads')}
          onHistory={() => showAudit('ads')}
        />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Web RPC (namespace: rpc)</h3>
        <p>
          Overrides the endpoint this explorer&apos;s <strong>web reads</strong> use. Blank = the
          service&apos;s env var, then the chain default. The indexer&apos;s RPC is separate and still
          env-based.
        </p>
        <dl className="kv">
          <dt>webRpcUrl</dt>
          <dd>
            <input
              type="text"
              disabled={readOnly}
              value={rpc.webRpcUrl ?? ''}
              placeholder={`(default — ${rpcDefaults.webRpcHost ?? 'chain built-in RPC'})`}
              onChange={(e) => setRpc({ ...rpc, webRpcUrl: e.target.value || undefined })}
            />
          </dd>
          <dt>rpcTimeoutMs</dt>
          <dd>
            <input
              type="number"
              min={1000}
              max={60000}
              disabled={readOnly}
              value={rpc.rpcTimeoutMs ?? ''}
              placeholder={String(rpcDefaults.rpcTimeoutMs ?? 8000)}
              onChange={(e) =>
                setRpc({ ...rpc, rpcTimeoutMs: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </dd>
        </dl>
        <p className="row">
          {/* readOnly too: the probe route is canWrite-gated, so a viewer would
              only ever get a 403 back from this button. */}
          <button onClick={testRpc} disabled={readOnly || probing || !rpc.webRpcUrl?.trim()}>
            {probing ? 'testing…' : 'Test RPC'}
          </button>
        </p>
        {probe && probe.forUrl !== rpc.webRpcUrl?.trim() && (
          <p className="msg err">URL changed since the last test — re-test before saving.</p>
        )}
        {probe && probe.forUrl === rpc.webRpcUrl?.trim() && (
          <p className={`msg ${probe.result.ok && probe.result.chainIdMatches === true ? 'ok' : 'err'}`}>
            {!probe.result.ok
              ? `test failed: ${probe.result.error ?? 'unknown error'}`
              : probe.result.chainIdMatches === false
                ? `⚠ CHAIN ID MISMATCH — endpoint reports ${probe.result.chainId}, this explorer expects ${probe.result.expectedChainId}. Do not save this unless you mean it.`
                : probe.result.chainIdMatches === null
                  ? `chainId ${probe.result.chainId} (no expected id known for this explorer) · block ${probe.result.blockNumber ?? '—'} · ${probe.result.latencyMs}ms`
                  : `chainId ${probe.result.chainId} ✓ · block ${probe.result.blockNumber ?? '—'} · ${probe.result.latencyMs}ms`}
          </p>
        )}
        <SaveRow
          k="rpc"
          saved={payload.settings.rpc?.value}
          draft={rpc}
          dirty={isDirty('rpc')}
          readOnly={readOnly}
          busy={busy}
          version={payload.settings.rpc?.version}
          onSave={saveRpc}
          onHistory={() => showAudit('rpc')}
        />
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
}
