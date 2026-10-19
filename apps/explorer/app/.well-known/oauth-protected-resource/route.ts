import { metadataResponse, preflight, protectedResourceMetadata } from '@altscan/oauth'
import { oauthRoute } from '@/lib/oauth'

// RFC 9728 metadata: this API accepts bearer tokens from this explorer's own OAuth server.
export const dynamic = 'force-dynamic'

export const GET = oauthRoute((_req, cfg) => metadataResponse(protectedResourceMetadata(cfg)))
export const OPTIONS = oauthRoute(() => preflight())
