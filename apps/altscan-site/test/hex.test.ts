import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ADDRESS_PATTERN, HASH_PATTERN, isHexAddress, isHexHash } from '../src/lib/hex.ts';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('ok -', name); }

await t('hex: any-case shapes, non-strings rejected', () => {
  assert.equal(isHexAddress('0x' + 'aB'.repeat(20)), true);
  assert.equal(isHexAddress('0x' + 'ab'.repeat(19)), false);
  assert.equal(isHexAddress(42), false);
  assert.equal(isHexHash('0x' + 'cd'.repeat(32)), true);
  assert.equal(isHexHash('0x' + 'cd'.repeat(20)), false);
  assert.equal(new RegExp(ADDRESS_PATTERN).test('0x' + 'ab'.repeat(20)), true);
  assert.equal(new RegExp(HASH_PATTERN).test('0x' + 'ab'.repeat(32)), true);
});

// The shapes live in src/lib/hex.ts only. /mcp and the WebMCP tools spelled them six times,
// one of them a regex built from a template literal, so names are banned as well as literals.
await t('hex: no other source spells the shapes or declares its own checker', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|astro)$/.test(n) ? [p] : [];
  });
  const shape = /0x\[0-9a-fA-F\]\{(?:40|64|\$\{)/;
  const ownChecker = /\b(?:function|const)\s+(?:hexOf|isHexAddress|isHexHash)\b/;
  const offenders = walk(src).filter((f) => !f.endsWith(join('lib', 'hex.ts')))
    .filter((f) => { const s = readFileSync(f, 'utf8'); return shape.test(s) || ownChecker.test(s); });
  assert.deepEqual(offenders, []);
  assert.ok(shape.test(readFileSync(join(src, 'lib', 'hex.ts'), 'utf8')), 'the scan sees the canonical module');
});

console.log(`\n${passed} passed`);
