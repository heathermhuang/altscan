import { handleToken } from '@altscan/oauth'
import { oauthRoute } from '@/lib/oauth'

// authorization_code (PKCE) and client_credentials (an API key as the client secret).
export const dynamic = 'force-dynamic'

export const POST = oauthRoute(handleToken, { limited: true })
export const OPTIONS = oauthRoute(handleToken)
