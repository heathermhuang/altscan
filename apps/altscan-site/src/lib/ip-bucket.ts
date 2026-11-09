/**
 * The Worker's per-IP rate-limit key, the same rule as explorer-core's ipBucketKey (which needs Node's `net`, so it
 * cannot run here): an IPv6 client buckets by its /64, since one subscriber is handed 2^64 addresses and can rotate
 * through them for free; an IPv4-mapped IPv6 address is that IPv4 address; every spelling of one address is one key.
 * Anything that is not an address is returned unchanged.
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!IPV4.test(dotted[2])) return null;
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    s = dotted[1] + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

export function ipBucket(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (IPV4.test(raw)) return raw;
  if (!raw.includes(':')) return ip;
  const g = ipv6Groups(raw);
  if (!g) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * The id the explorers bucket an MCP client by: HMAC-SHA256 of the caller's key (its IP bucket, or `sub:<address>`)
 * under the service token, 32 hex characters. Stable per client, and neither an IP nor an address reaches the explorers.
 */
export async function serviceClientId(token: string, callerKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(callerKey)));
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
