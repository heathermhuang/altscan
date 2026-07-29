/**
 * An RPC endpoint URL frequently carries its API key in the path or query
 * (Chainstack, Alchemy, Infura, QuickNode all do this). The stored `rpc`
 * override is therefore credential-bearing, and the console's settings GET —
 * including its audit history — is readable by every member, viewers included.
 *
 * Redact the value down to its host for anyone who cannot write it. The
 * explorer's own admin API can't do this: it authenticates by ADMIN_SECRET and
 * has no idea which console member is behind the call. The BFF knows the role,
 * so the redaction belongs here.
 */
export function redactRpcValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const v = value as Record<string, unknown>
  if (typeof v.webRpcUrl !== 'string') return value
  let host: string
  try {
    host = new URL(v.webRpcUrl).host
  } catch {
    host = 'invalid'
  }
  // Deliberately a NON-URL shape so it can never be mistaken for the real value
  // and round-tripped back into a save by a client that echoes what it read.
  return { ...v, webRpcUrl: `[redacted — host ${host}]` }
}

/** Redact `settings.rpc.value` in a settings payload for a non-writing member. */
export function redactSettingsPayload(body: Record<string, unknown>): Record<string, unknown> {
  const settings = body.settings
  if (typeof settings !== 'object' || settings === null) return body
  const s = settings as Record<string, { value?: unknown } | undefined>
  if (!s.rpc) return body
  return { ...body, settings: { ...s, rpc: { ...s.rpc, value: redactRpcValue(s.rpc.value) } } }
}

/** Redact every historical `value` in an rpc audit payload. */
export function redactAuditPayload(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.entries)) return body
  return {
    ...body,
    entries: body.entries.map((e) =>
      typeof e === 'object' && e !== null
        ? { ...(e as Record<string, unknown>), value: redactRpcValue((e as { value?: unknown }).value) }
        : e,
    ),
  }
}
