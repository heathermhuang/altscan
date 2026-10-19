import { handleAuthorize } from '@altscan/oauth'
import { oauthRoute } from '@/lib/oauth'

// The wallet sign-in page (GET) and its form, which issues the authorization code (POST).
export const dynamic = 'force-dynamic'

export const GET = oauthRoute(handleAuthorize)
export const POST = oauthRoute(handleAuthorize, { limited: true })
