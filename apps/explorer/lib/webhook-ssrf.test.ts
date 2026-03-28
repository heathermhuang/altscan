/**
 * Critical security tests: SSRF protection on webhook URL registration.
 *
 * These tests directly exercise the URL validation logic extracted from
 * apps/web/app/api/v1/webhooks/route.ts.
 *
 * If any of these fail, an attacker can register a webhook with a private/localhost
 * URL and use BNBScan's delivery system to probe the internal Render network.
 */
import { describe, it, expect } from 'vitest'

// Extract validation logic — mirrors the exact regex in webhooks/route.ts
const blockedHosts = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.|::1|fc00:|fe80:)/

function isWebhookUrlAllowed(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false
  const hostname = parsed.hostname.toLowerCase()
  return !blockedHosts.test(hostname)
}

describe('Webhook SSRF protection', () => {
  describe('blocked URLs (private/internal)', () => {
    it('blocks localhost', () => {
      expect(isWebhookUrlAllowed('http://localhost:3000/hook')).toBe(false)
    })

    it('blocks 127.0.0.1', () => {
      expect(isWebhookUrlAllowed('http://127.0.0.1/hook')).toBe(false)
    })

    it('blocks 127.x.x.x range', () => {
      expect(isWebhookUrlAllowed('http://127.0.0.2/hook')).toBe(false)
    })

    it('blocks 10.x.x.x (AWS/GCP internal)', () => {
      expect(isWebhookUrlAllowed('http://10.0.0.1/hook')).toBe(false)
    })

    it('blocks 192.168.x.x (LAN)', () => {
      expect(isWebhookUrlAllowed('http://192.168.1.1/hook')).toBe(false)
    })

    it('blocks 172.16.x.x - 172.31.x.x (Docker bridge etc)', () => {
      expect(isWebhookUrlAllowed('http://172.16.0.1/hook')).toBe(false)
      expect(isWebhookUrlAllowed('http://172.31.255.255/hook')).toBe(false)
    })

    it('does NOT block 172.15 (not in private range)', () => {
      expect(isWebhookUrlAllowed('http://172.15.0.1/hook')).toBe(true)
    })

    it('does NOT block 172.32 (not in private range)', () => {
      expect(isWebhookUrlAllowed('http://172.32.0.1/hook')).toBe(true)
    })

    it('blocks 169.254.x.x (link-local / AWS metadata)', () => {
      expect(isWebhookUrlAllowed('http://169.254.169.254/latest/meta-data/')).toBe(false)
    })

    it('blocks 0.0.0.0', () => {
      expect(isWebhookUrlAllowed('http://0.0.0.0/hook')).toBe(false)
    })

    it('blocks non-http protocols', () => {
      expect(isWebhookUrlAllowed('ftp://example.com/hook')).toBe(false)
      expect(isWebhookUrlAllowed('file:///etc/passwd')).toBe(false)
      expect(isWebhookUrlAllowed('javascript:alert(1)')).toBe(false)
    })

    it('blocks malformed URLs', () => {
      expect(isWebhookUrlAllowed('not-a-url')).toBe(false)
      expect(isWebhookUrlAllowed('')).toBe(false)
    })
  })

  describe('allowed URLs (public endpoints)', () => {
    it('allows https://webhook.site/...', () => {
      expect(isWebhookUrlAllowed('https://webhook.site/abc123')).toBe(true)
    })

    it('allows http://example.com/hook', () => {
      expect(isWebhookUrlAllowed('http://example.com/hook')).toBe(true)
    })

    it('allows a real developer endpoint', () => {
      expect(isWebhookUrlAllowed('https://api.myapp.com/bnbscan/events')).toBe(true)
    })
  })
})
