import { createRemoteJWKSet, jwtVerify } from 'jose'

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/** Verify a Cloudflare Access JWT and return its email claim, or null on any failure. */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<string | null> {
  try {
    const issuer = `https://${teamDomain}.cloudflareaccess.com`
    let jwks = jwksCache.get(issuer)
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
      jwksCache.set(issuer, jwks)
    }
    const { payload } = await jwtVerify(token, jwks, { issuer, audience })
    return typeof payload.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}
