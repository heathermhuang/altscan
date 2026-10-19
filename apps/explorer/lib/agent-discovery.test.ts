import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { GET as skillsIndex } from '@/app/.well-known/agent-skills/index.json/route'
import { GET as skillMd } from '@/app/.well-known/agent-skills/api-usage/SKILL.md/route'
import { GET as aiCatalog } from '@/app/.well-known/ai-catalog.json/route'

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
})

describe('ARD ai-catalog.json', () => {
  it('lists the published skill as a well-formed AI Catalog entry', async () => {
    const res = await aiCatalog()
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const catalog = await res.json()
    expect(catalog.specVersion).toBe('1.0')
    expect(catalog.host.displayName).toBeTruthy()
    const [skill] = (await (await skillsIndex()).json()).skills
    expect(catalog.entries).toHaveLength(1)
    for (const entry of catalog.entries) {
      expect(entry.identifier).toMatch(new RegExp(`^urn:air:${catalog.host.identifier.replace(/\./g, '\\.')}:`))
      expect(entry.displayName).toBeTruthy()
      // Exactly one of url / data (ai-catalog §Catalog Entry).
      expect(('url' in entry) !== ('data' in entry)).toBe(true)
    }
    expect(catalog.entries[0].type).toBe('application/agent-skills+md')
    expect(catalog.entries[0].url).toBe(skill.url)
  })
})
