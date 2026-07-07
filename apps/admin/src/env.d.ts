/// <reference types="astro/client" />

type Env = {
  DB: D1Database
  RENDER_API_KEY: string
  ADMIN_SECRET_BNB: string
  ADMIN_SECRET_ETH: string
  CF_ACCESS_TEAM_DOMAIN?: string
  CF_ACCESS_AUD?: string
  /** Dev-only auth bypass (astro dev / wrangler dev with .dev.vars). */
  DEV_FAKE_EMAIL?: string
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>

declare namespace App {
  interface Locals extends Runtime {
    member: {
      email: string
      role: import('./lib/rbac').Role
      tenantId: string
    }
  }
}
