import { verifyMessage } from 'ethers'
import { constantTimeEqual, sha256b64url } from './crypto'

// ── PKCE (RFC 7636), S256 only ────────────────────────────────────────────────

export const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!CODE_VERIFIER.test(verifier) || !CODE_CHALLENGE.test(challenge)) return false
  return constantTimeEqual(await sha256b64url(verifier), challenge)
}

// ── Redirect URIs ─────────────────────────────────────────────────────────────
// https anywhere; plain http only to loopback (RFC 8252 §7.3); private-use schemes for native apps
// (RFC 8252 §7.1, e.g. cursor:), minus the schemes a browser would execute or read locally.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:'])
export const MAX_REDIRECT_URIS = 4
const MAX_REDIRECT_URI_LENGTH = 512

export function redirectUriAllowed(uri: string): boolean {
  if (uri.length > MAX_REDIRECT_URI_LENGTH || uri.includes('#')) return false
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.username || u.password) return false
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname)
  if (BLOCKED_SCHEMES.has(u.protocol)) return false
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol)
}

/** Where the browser goes after sign-in, as a person should read it, and as a CSP source. */
export function redirectTarget(uri: string): string {
  const u = new URL(uri)
  return u.origin !== 'null' ? u.origin : u.protocol
}

/** A self-declared client name, made safe to show in a message a person signs: printable ASCII, one line. */
export function cleanClientName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const s = name.replace(/\s+/g, ' ').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 60)
  return s || null
}

// ── Wallet sign-in ────────────────────────────────────────────────────────────
// EIP-4361-shaped text, so wallets that understand Sign-In with Ethereum can check the domain.
// The address goes between `before` and `after`; the page and an agent build the same string.

export interface SignIn {
  host: string
  issuer: string
  scopeLabel: string
  chainId: number
  clientName: string | null
  redirectUri: string
  nonce: string
  issuedAt: string
  requestId: string
}

export function signInMessage(s: SignIn): { before: string; after: string } {
  const who = s.clientName ? `"${s.clientName}" (a name the app chose itself)` : 'An app that gave no name'
  return {
    before: `${s.host} wants you to sign in with your Ethereum account:\n`,
    after:
      `\n\n${who} may use ${s.scopeLabel} as this address. You return to ${redirectTarget(s.redirectUri)}.` +
      `\n\nURI: ${s.issuer}/oauth/authorize\nVersion: 1\nChain ID: ${s.chainId}\nNonce: ${s.nonce}` +
      `\nIssued At: ${s.issuedAt}\nRequest ID: ${s.requestId}`,
  }
}

/** Binds a signature to one authorization request: client, redirect, PKCE challenge and scope. */
export function requestIdFor(clientId: string, redirectUri: string, codeChallenge: string, scope: string): Promise<string> {
  return sha256b64url(JSON.stringify([clientId, redirectUri, codeChallenge, scope]))
}

/** The lowercase address that produced an EIP-191 personal_sign signature over `message`, or null. */
export function signerOf(message: string, signature: string): string | null {
  try {
    return verifyMessage(message, signature).toLowerCase()
  } catch {
    return null
  }
}
