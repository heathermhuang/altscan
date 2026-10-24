// WebCrypto only, so the same code runs in Node (the explorers) and in Workers (altscan.io).

const enc = new TextEncoder()

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

// <ArrayBuffer>, not the default ArrayBufferLike: WebCrypto refuses views of a SharedArrayBuffer.
export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(enc.encode(s))
}

/** Unpredictable, URL-safe. */
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256b64url(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s))))
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// One HMAC key per purpose, derived from the deployment's secret, so a value signed for one purpose
// (a client_id) can never pass as another (an access token).
const keys = new Map<string, Promise<CryptoKey>>()

function keyFor(secret: string, purpose: string): Promise<CryptoKey> {
  const id = `${purpose}\u0000${secret}`
  let k = keys.get(id)
  if (!k) {
    k = (async () => {
      const root = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const derived = await crypto.subtle.sign('HMAC', root, utf8(`altscan-oauth/v1/${purpose}`))
      return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    })()
    keys.set(id, k)
  }
  return k
}

export async function hmacSign(secret: string, purpose: string, data: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await keyFor(secret, purpose), utf8(data))))
}

export async function hmacVerify(secret: string, purpose: string, data: string, signature: string): Promise<boolean> {
  const sig = b64urlDecode(signature)
  if (!sig || sig.length !== 32) return false
  // atob ignores the unused trailing bits, so several spellings decode to one signature. Accept only
  // the canonical one: a token then has exactly one string form.
  if (b64url(sig) !== signature) return false
  return crypto.subtle.verify('HMAC', await keyFor(secret, purpose), sig, utf8(data))
}
