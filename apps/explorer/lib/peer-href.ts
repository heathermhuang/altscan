// Where the network switcher sends a visitor on the other chain.
//
// A path with a dynamic segment (/token/<addr>, /address/<addr>, /tx/<hash>,
// /blocks/<n>) names a DIFFERENT object on the other chain, or nothing at all:
// the same 0x… address is a different account there, and carrying BSC USDT's
// address to Ethereum lands on an address nobody owns. So only the static
// routes that exist on both chains are carried across; everything else goes
// to the peer's home page. /validators (BNB only) and /staking (ETH only)
// are 404 on the other side, and /search needs its ?q= (the switcher only has
// the pathname), so they fall to home too.
const CHAIN_AGNOSTIC_ROUTES: ReadonlySet<string> = new Set([
  '/',
  '/txs',
  '/blocks',
  '/gas',
  '/dex',
  '/whales',
  '/charts',
  '/token',
  '/api-docs',
  '/developer',
  '/about',
  '/verify',
  '/watchlist',
])

export function peerHref(peerUrl: string, pathname: string | null | undefined): string {
  const base = peerUrl.replace(/\/+$/, '')
  const path = (pathname ?? '/').replace(/\/+$/, '') || '/'
  return CHAIN_AGNOSTIC_ROUTES.has(path) ? `${base}${path}` : `${base}/`
}
