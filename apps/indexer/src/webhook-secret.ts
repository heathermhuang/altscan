/**
 * Webhook signing keys at rest.
 *
 * Delivery HMACs each payload with sha256(raw secret) in hex: the value
 * POST /api/v1/webhooks stores in webhooks.secret. Stored as is, a read of that
 * column is enough to forge any webhook's signatures. With WEBHOOK_SECRET_KEY set
 * on the indexer, sealPlaintextWebhookSecrets() (webhook-notifier.ts) moves each one
 * into webhooks.secret_enc, sealed with AES-256-GCM under that key, and clears the
 * plaintext. The signing key itself is unchanged, so consumers see byte-identical
 * signatures. Losing WEBHOOK_SECRET_KEY makes sealed webhooks undeliverable; their
 * owners must register them again.
 *
 * secret_enc is created by ensure-schema.ts and written only by the indexer. The
 * explorer's registration insert names its columns (apps/explorer/lib/webhook-insert.ts):
 * drizzle's insert lists every declared column, so an explorer deployed ahead of
 * this DDL would otherwise fail every webhook creation.
 */
import crypto from 'crypto'

const VERSION = 'v1'
const TAG_BYTES = 16

/** null when unset (sealing is opt-in); throws on anything but 64 hex characters. */
export function parseWebhookSecretKey(raw: string): Buffer | null {
  const value = raw.trim()
  if (value === '') return null
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('WEBHOOK_SECRET_KEY must be 64 hex characters (32 bytes), e.g. from `openssl rand -hex 32`')
  }
  return Buffer.from(value, 'hex')
}

/** Binds a sealed key to its row, so it cannot be copied onto another webhook. */
const aad = (webhookId: number) => Buffer.from(`webhook:${webhookId}`)

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
export function sealSigningKey(signingKey: string, key: Buffer, webhookId: number): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad(webhookId))
  const ct = Buffer.concat([cipher.update(signingKey, 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

/** Throws on the wrong key, another webhook's id, any alteration, or an unknown version. */
export function openSigningKey(sealed: string, key: Buffer, webhookId: number): string {
  const [version, iv, tag, ct] = sealed.split('.')
  if (version !== VERSION || !iv || !tag || !ct) {
    throw new Error(`unrecognized sealed webhook secret (version "${version}")`)
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: TAG_BYTES })
  decipher.setAAD(aad(webhookId))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}
