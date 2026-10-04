/// <reference types="astro/client" />

// Bindings and vars, read with `import { env } from 'cloudflare:workers'` (Astro 6+ removed
// Astro.locals.runtime). Declaring them on Cloudflare.Env types that import.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    /** House-ad creative images; public reads go via creatives.altscan.io. */
    CREATIVES: R2Bucket
    RENDER_API_KEY: string
    ADMIN_SECRET_BNB: string
    ADMIN_SECRET_ETH: string
    CF_ACCESS_TEAM_DOMAIN?: string
    CF_ACCESS_AUD?: string
    /** Dev-only auth bypass (astro dev / wrangler dev with .dev.vars). */
    DEV_FAKE_EMAIL?: string
  }
}

type Env = Cloudflare.Env

declare namespace App {
  interface Locals {
    member: {
      email: string
      role: import('./lib/rbac').Role
      tenantId: string
    }
  }
}
