import { authorizationServerMetadata, metadataResponse, preflight } from '@altscan/oauth'
import { oauthRoute } from '@/lib/oauth'

// RFC 8414 metadata for this explorer's OAuth server (lib/oauth.ts). A 404 while OAuth is off.
export const dynamic = 'force-dynamic'

export const GET = oauthRoute((_req, cfg) => metadataResponse(authorizationServerMetadata(cfg)))
export const OPTIONS = oauthRoute(() => preflight())
