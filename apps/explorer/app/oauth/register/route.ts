import { handleRegister } from '@altscan/oauth'
import { oauthRoute } from '@/lib/oauth'

// RFC 7591 dynamic client registration, public clients only (packages/oauth).
export const dynamic = 'force-dynamic'

export const POST = oauthRoute(handleRegister, { limited: true })
export const OPTIONS = oauthRoute(handleRegister)
