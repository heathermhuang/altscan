import { authorizeScript } from '@altscan/oauth'
import { oauthRoute } from '@/lib/oauth'

// The sign-in page's script, served from this origin so the page's CSP can be script-src 'self'.
export const dynamic = 'force-dynamic'

export const GET = oauthRoute(() => authorizeScript())
