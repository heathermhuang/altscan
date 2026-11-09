import assert from 'node:assert';
import { ipBucket, serviceClientId } from '../src/lib/ip-bucket.ts';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('ok -', name); }

// The same rule as explorer-core's ipBucketKey: an IPv6 client is its /64, one address is one key however spelled.
await t('ipBucket: every spelling of one /64 is one key', () => {
  for (const ip of ['2001:db8:1:2:3:4:5:6', '2001:0DB8:0001:0002:0003:0004:0005:0006', '2001:db8:1:2::abcd', '[2001:db8:1:2::1]', '2001:db8:1:2::1%eth0']) {
    assert.equal(ipBucket(ip), '2001:db8:1:2::/64', ip);
  }
  assert.equal(ipBucket('2001:db8:1:3::1'), '2001:db8:1:3::/64');
  assert.equal(ipBucket('2a06:98c0:3600::103'), '2a06:98c0:3600:0::/64');
});

await t('ipBucket: IPv4-mapped is IPv4; IPv4 and non-addresses pass through', () => {
  for (const ip of ['::ffff:1.2.3.4', '::FFFF:0102:0304', '0:0:0:0:0:ffff:1.2.3.4']) assert.equal(ipBucket(ip), '1.2.3.4', ip);
  assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
  assert.equal(ipBucket('unknown'), 'unknown');
  assert.equal(ipBucket('1:2:3'), '1:2:3');
  assert.equal(ipBucket('999.1.1.1'), '999.1.1.1');
});

await t('serviceClientId: 32 hex, stable, distinct per caller and per token, and never the input', async () => {
  const tok = 't'.repeat(40);
  const a = await serviceClientId(tok, '2001:db8:1:2::/64');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(await serviceClientId(tok, '2001:db8:1:2::/64'), a);
  assert.notEqual(await serviceClientId(tok, 'sub:0xabc'), a);
  assert.notEqual(await serviceClientId('u'.repeat(40), '2001:db8:1:2::/64'), a);
  assert.ok(!a.includes('2001'));
});

// worker.ts's mcp() has no unit harness; pin the wiring it owns.
await t("worker.ts: limits key on the IP bucket and forward the HMAC'd client id", async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('const bucket = ipBucket(client);'));
  assert.ok(src.includes('mcpWithinLimits(caller.key, bucket,'));
  assert.ok(src.includes("headers['x-altscan-service-client-id'] = await serviceClientId(env.ALTSCAN_SERVICE_TOKEN, caller.key);"));
  assert.ok(src.includes("const ip = ipBucket(request.headers.get('cf-connecting-ip') ?? 'unknown');"));
});

console.log(`\n${passed} passed`);
