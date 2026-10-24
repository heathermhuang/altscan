import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { GET as skillsIndex } from '@/app/.well-known/agent-skills/index.json/route'
import { GET as skillMd } from '@/app/.well-known/agent-skills/api-usage/SKILL.md/route'
import { GET as aiCatalog } from '@/app/.well-known/ai-catalog.json/route'
import { GET as authMd } from '@/app/auth.md/route'
import { GET as serverCard } from '@/app/.well-known/mcp/server-card.json/route'
import { chainConfig } from '@/lib/chain'

// The Agent Skills Discovery RFC v0.2.0
// (https://github.com/cloudflare/agent-skills-discovery-rfc): clients SHOULD NOT
// process an index whose $schema they don't recognise, and MUST reject a skill
// whose bytes don't match its digest. The index once used a made-up $schema and
// v0.1-style field names, so a conformant agent would have skipped it entirely.
describe('agent skills discovery index', () => {
  it('uses the v0.2.0 schema URI and entry fields', async () => {
    const index = await (await skillsIndex()).json()
    expect(index.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json')
    expect(index.skills).toHaveLength(1)
    const [skill] = index.skills
    expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(skill.type).toBe('skill-md')
    expect(skill.url).toMatch(/\/\.well-known\/agent-skills\/api-usage\/SKILL\.md$/)
    expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('digests the exact bytes the SKILL.md route serves', async () => {
    const [skill] = (await (await skillsIndex()).json()).skills
    const served = Buffer.from(await (await skillMd()).arrayBuffer())
    expect(skill.digest).toBe(`sha256:${createHash('sha256').update(served).digest('hex')}`)
  })

  it('serves SKILL.md with the frontmatter the index repeats', async () => {
    const [skill] = (await (await skillsIndex()).json()).skills
    const body = await (await skillMd()).text()
    const fm = body.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/)
    expect(fm).not.toBeNull()
    expect(fm![1]).toBe(skill.name)
    expect(JSON.parse(fm![2])).toBe(skill.description)
  })

  // The Auth section once said every /api/v1/* endpoint needs no authentication and that
  // OAuth is "intentionally absent". Neither is true: four endpoints take X-API-Key and the
  // OAuth server exists whenever OAUTH_SECRET is set (a static page can't know which).
  it('does not claim the API is keyless or that OAuth is absent; points at /auth.md for keys', async () => {
    const body = await (await skillMd()).text()
    expect(body).not.toMatch(/require no authentication/i)
    expect(body).not.toMatch(/intentionally absent/i)
    expect(body).not.toMatch(/no OAuth authorization server/i)
    expect(body).toContain('X-API-Key')
    expect(body).toContain('/auth.md')
    for (const path of ['/api/v1/query', '/api/v1/keys', '/api/v1/webhooks', '/api/v1/contracts/{address}/call']) {
      expect(body).toContain(path)
    }
  })
})

describe('ARD ai-catalog.json', () => {
  it('lists the published skill as a well-formed AI Catalog entry', async () => {
    const res = await aiCatalog()
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('content-type')).toBe('application/ai-catalog+json')
    const catalog = await res.json()
    expect(catalog.specVersion).toBe('1.0')
    expect(catalog.host.displayName).toBeTruthy()
    const [skill] = (await (await skillsIndex()).json()).skills
    expect(catalog.entries).toHaveLength(1)
    for (const entry of catalog.entries) {
      expect(entry.identifier.startsWith(`urn:air:${catalog.host.identifier}:`)).toBe(true)
      expect(entry.displayName).toBeTruthy()
      // Exactly one of url / data (ai-catalog §Catalog Entry).
      expect(('url' in entry) !== ('data' in entry)).toBe(true)
    }
    expect(catalog.entries[0].type).toBe('application/agent-skills+md')
    expect(catalog.entries[0].url).toBe(skill.url)
  })
})

describe('auth.md', () => {
  it('is Markdown under the H1 scanners look for', async () => {
    const res = await authMd()
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const body = await res.text()
    expect(body.split('\n')[0]).toMatch(/^# .*auth\.md$/)
  })

  it('names this origin\'s provisioning endpoint and the header the API reads', async () => {
    const body = await (await authMd()).text()
    expect(body).toContain(`POST /api/v1/keys HTTP/1.1\nHost: ${chainConfig.domain}`)
    // lib/api-auth.ts reads X-API-Key only; an agent sending Bearer would be keyless.
    expect(body).toContain('X-API-Key: bnbs_')
    // The exact message app/api/v1/keys/route.ts verifies.
    expect(body).toContain('BNBScan API Key Request\nAddress: 0xyouraddress\nTimestamp: 1760000000000')
  })
})

describe('MCP server card', () => {
  it('is the card altscan.io publishes for the same server', async () => {
    const res = await serverCard()
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const altscan = JSON.parse(
      readFileSync(new URL('../../altscan-site/public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'),
    )
    expect(await res.json()).toEqual(altscan)
  })
})
