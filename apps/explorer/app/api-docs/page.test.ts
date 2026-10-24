import { describe, expect, it } from 'vitest'
import { apiListPage } from '@/lib/list-depth'
import ApiDocsPage from '@/app/api-docs/page'

// The human API docs are a hand-written table; the limits it prints once said "default 25, max 100"
// while the code answered 20 and 50 (lib/list-depth.ts), and the webhook example listed an event type
// that is accepted but never delivered. The page is a sync server component, so it is called for its
// element tree (nothing is rendered) and the EndpointCards are read off that.
type Param = { name: string; description: string }
type Endpoint = { method: string; path: string; description: string; params?: Param[]; exampleResponse: string }
type El = { type?: { name?: string }; props?: { children?: unknown; endpoint?: Endpoint } }

function endpoints(node: unknown, out: Endpoint[] = []): Endpoint[] {
  if (Array.isArray(node)) node.forEach((n) => endpoints(n, out))
  else if (node && typeof node === 'object') {
    const el = node as El
    if (el.type?.name === 'EndpointCard' && el.props?.endpoint) out.push(el.props.endpoint)
    endpoints(el.props?.children, out)
  }
  return out
}

const docs = endpoints(ApiDocsPage())
const doc = (method: string, path: string) => {
  const ep = docs.find((e) => e.method === method && e.path === path)
  if (!ep) throw new Error(`${method} ${path} is not documented`)
  return ep
}

describe('/api-docs', () => {
  it('reads the endpoints off the page', () => {
    expect(docs.length).toBeGreaterThan(10)
  })

  // Derived by running the real parser, so a changed default or cap fails here.
  const defaultLimit = apiListPage(new URLSearchParams()) as { limit: number }
  const maxLimit = apiListPage(new URLSearchParams('limit=1000000')) as { limit: number }

  it.each(['/api/v1/blocks', '/api/v1/transactions', '/api/v1/tokens'])(
    'documents the limit %s actually applies',
    (path) => {
      const limit = doc('GET', path).params?.find((p) => p.name === 'limit')
      expect(limit?.description).toContain(`default: ${defaultLimit.limit}, max: ${maxLimit.limit}`)
    },
  )

  it('qualifies the token list the way the OpenAPI spec does', () => {
    const tokens = doc('GET', '/api/v1/tokens')
    expect(tokens.description).toMatch(/ordered by indexed holder count/)
    expect(tokens.description).toMatch(/frozen snapshot/)
    expect(tokens.description).toMatch(/total is a planner estimate .* ignores the type filter/)
    expect(tokens.params?.map((p) => p.name)).toContain('type')
  })

  it('shows only the event type the webhook notifier delivers in the GET /webhooks example', () => {
    const example = JSON.parse(doc('GET', '/api/v1/webhooks').exampleResponse) as {
      webhooks: { eventTypes: string[] }[]
    }
    for (const hook of example.webhooks) expect(hook.eventTypes).toEqual(['tx'])
  })
})
