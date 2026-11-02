import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  changelogProblems, countChanges, formatDate, highlights, loadChangelog, parseChangelog, parseInline, releaseTape,
} from '../src/lib/changelog.ts';
import { SECURITY_HEADERS } from '../src/lib/security-headers.ts';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('ok -', name); }

const PR = (n: number) => ({ kind: 'pr', number: n, href: `https://github.com/heathermhuang/altscan/pull/${n}` });

const FIXTURE = `# Changelog

Preamble that is not a release.

## [Unreleased]

### Fixed
- Plain unreleased fix (#300).

## [0.2.0.0] - 2026-06-09

Second release
in two lines.

### Added
- **Big thing.** It does more (#12).
- Small thing.

### Fixed
- **Bug.** Gone.

## [0.1.0.0] - 2026-03-23

First release.

### Added
- First thing.

[Unreleased]: https://github.com/heathermhuang/altscan/compare/v0.2.0.0...HEAD
[0.2.0.0]: https://github.com/heathermhuang/altscan/compare/v0.1.0.0...v0.2.0.0
[0.1.0.0]: https://github.com/heathermhuang/altscan/releases/tag/v0.1.0.0
`;

// parseInline
await t('parseInline: plain text stays one token', () => {
  assert.deepEqual(parseInline('hello'), [{ kind: 'text', text: 'hello' }]);
});
await t('parseInline: bold, code, link and PR refs become tokens', () => {
  assert.deepEqual(parseInline('**a** `b` [c](https://d.example) (#7)'), [
    { kind: 'bold', children: [{ kind: 'text', text: 'a' }] },
    { kind: 'text', text: ' ' },
    { kind: 'code', text: 'b' },
    { kind: 'text', text: ' ' },
    { kind: 'link', text: 'c', href: 'https://d.example' },
    { kind: 'text', text: ' (' },
    PR(7),
    { kind: 'text', text: ')' },
  ]);
});
await t('parseInline: bold can hold code', () => {
  assert.deepEqual(parseInline('**at `x`**'), [
    { kind: 'bold', children: [{ kind: 'text', text: 'at ' }, { kind: 'code', text: 'x' }] },
  ]);
});
await t('parseInline: a range links both ends', () => {
  assert.deepEqual(parseInline('#283–#290').filter((x) => x.kind === 'pr'), [PR(283), PR(290)]);
});
await t('parseInline: non-https links keep only their label', () => {
  assert.deepEqual(parseInline('[a](http://b.example)'), [{ kind: 'text', text: 'a' }]);
  assert.equal(parseInline('[a](javascript:alert(1))').some((x) => x.kind === 'link'), false);
  assert.deepEqual(parseInline('[a](CONTRIBUTING.md)'), [{ kind: 'text', text: 'a' }]);
});
await t('parseInline: a hash inside code, a word or a URL is not a PR', () => {
  assert.deepEqual(parseInline('`#1,234`'), [{ kind: 'code', text: '#1,234' }]);
  assert.equal(parseInline('foo#12').some((x) => x.kind === 'pr'), false);
  assert.equal(parseInline('https://a.example/#12').some((x) => x.kind === 'pr'), false);
});
await t('parseInline: HTML stays literal text', () => {
  assert.deepEqual(parseInline('<script>x</script>'), [{ kind: 'text', text: '<script>x</script>' }]);
});

// parseChangelog
await t('parseChangelog: splits Unreleased from dated releases, newest first', () => {
  const cl = parseChangelog(FIXTURE);
  assert.equal(cl.unreleased?.date, null);
  assert.equal(cl.unreleased?.anchor, 'live');
  assert.deepEqual(cl.releases.map((r) => [r.version, r.date, r.anchor]), [
    ['0.2.0.0', '2026-06-09', 'v0-2-0-0'],
    ['0.1.0.0', '2026-03-23', 'v0-1-0-0'],
  ]);
});
await t('parseChangelog: joins summary lines and ignores the preamble', () => {
  const [second] = parseChangelog(FIXTURE).releases;
  assert.deepEqual(second.summary, [{ kind: 'text', text: 'Second release in two lines.' }]);
});
await t('parseChangelog: groups bullets by section', () => {
  const [second] = parseChangelog(FIXTURE).releases;
  assert.deepEqual(second.sections.map((s) => [s.title, s.bullets.length]), [['Added', 2], ['Fixed', 1]]);
});
await t('parseChangelog: keeps compare links, and only compare links', () => {
  const cl = parseChangelog(FIXTURE);
  assert.equal(cl.unreleased?.compareUrl, 'https://github.com/heathermhuang/altscan/compare/v0.2.0.0...HEAD');
  assert.equal(cl.releases[0].compareUrl, 'https://github.com/heathermhuang/altscan/compare/v0.1.0.0...v0.2.0.0');
  assert.equal(cl.releases[1].compareUrl, null);
});

// Derived values
await t('countChanges: counts bullets across sections', () => {
  assert.equal(countChanges(parseChangelog(FIXTURE).releases[0]), 3);
});
await t('highlights: only bold-led bullets, in file order, capped', () => {
  const [second] = parseChangelog(FIXTURE).releases;
  assert.deepEqual(highlights(second), [
    [{ kind: 'text', text: 'Big thing.' }],
    [{ kind: 'text', text: 'Bug.' }],
  ]);
  assert.equal(highlights(second, 1).length, 1);
});
await t('releaseTape: oldest to newest, then Live; fill is the share added', () => {
  assert.deepEqual(releaseTape(parseChangelog(FIXTURE)), [
    { label: '0.1', anchor: 'v0-1-0-0', count: 1, fill: 100, pending: false },
    { label: '0.2', anchor: 'v0-2-0-0', count: 3, fill: 67, pending: false },
    { label: 'Live', anchor: 'live', count: 1, fill: 0, pending: true },
  ]);
});
await t('releaseTape: keeps a meaningful third version part', () => {
  const md = '## [0.1.1.0] - 2026-03-23\n\nS.\n\n### Added\n- A.\n';
  assert.equal(releaseTape(parseChangelog(md))[0].label, '0.1.1');
});
await t('formatDate: reads in UTC', () => {
  assert.equal(formatDate('2026-10-12'), '12 Oct 2026');
});

// changelogProblems
await t('changelogProblems: accepts a good file', () => {
  assert.deepEqual(changelogProblems(parseChangelog(FIXTURE)), []);
});
await t('changelogProblems: names what is wrong', () => {
  assert.deepEqual(changelogProblems(parseChangelog('nothing here')), ['no releases']);
  const bad = parseChangelog('## [0.3.0.0]\n\n### Added\n\n## [0.2.0.0] - 2026-06-09\n\n### Added\n- A.\n');
  assert.deepEqual(changelogProblems(bad), [
    '0.3.0.0: no date', '0.3.0.0: no summary', '0.3.0.0: no changes', '0.2.0.0: no summary',
  ]);
});
await t('the real CHANGELOG.md parses with no problems', () => {
  const real = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
  const cl = parseChangelog(real);
  assert.deepEqual(changelogProblems(cl), []);
  assert.ok(cl.unreleased);
  assert.ok(cl.releases.length >= 5);
});

// loadChangelog
function fakeCache(seed?: string) {
  const store = new Map<string, Response>();
  if (seed) store.set('https://altscan.io/__changelog.md', new Response(seed));
  return {
    store,
    match: async (r: Request) => store.get(r.url)?.clone(),
    put: async (r: Request, res: Response) => { store.set(r.url, res); },
  };
}
const fetchOf = (status: number, body: string) => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => { calls.push(url); return new Response(body, { status }); }) as typeof fetch;
  return { calls, fetchImpl };
};
const BUNDLED = '## [0.0.1.0] - 2026-01-01\n\nBundled.\n\n### Added\n- Bundled thing.\n';
const ORIGIN = 'https://altscan.io';

await t('loadChangelog: a cache hit makes no upstream call', async () => {
  const { calls, fetchImpl } = fetchOf(200, FIXTURE);
  const out = await loadChangelog(ORIGIN, BUNDLED, { fetchImpl, cache: fakeCache(FIXTURE) });
  assert.equal(out.source, 'hit');
  assert.equal(out.changelog.releases[0].version, '0.2.0.0');
  assert.equal(calls.length, 0);
});
await t('loadChangelog: a miss fetches main and stores it for an hour', async () => {
  const cache = fakeCache();
  const { calls, fetchImpl } = fetchOf(200, FIXTURE);
  const out = await loadChangelog(ORIGIN, BUNDLED, { fetchImpl, cache });
  assert.equal(out.source, 'miss');
  assert.deepEqual(calls, ['https://raw.githubusercontent.com/heathermhuang/altscan/changelog-published/CHANGELOG.md']);
  const stored = cache.store.get('https://altscan.io/__changelog.md');
  assert.equal(await stored?.text(), FIXTURE);
  assert.equal(stored?.headers.get('cache-control'), 'public, max-age=3600');
});
await t('loadChangelog: an upstream error serves the bundled copy and stores nothing', async () => {
  const cache = fakeCache();
  const out = await loadChangelog(ORIGIN, BUNDLED, { fetchImpl: fetchOf(503, 'down').fetchImpl, cache });
  assert.equal(out.source, 'bundled');
  assert.equal(out.changelog.releases[0].version, '0.0.1.0');
  assert.equal(cache.store.size, 0);
});
await t('loadChangelog: a thrown fetch serves the bundled copy', async () => {
  const fetchImpl = (async () => { throw new Error('timed out'); }) as typeof fetch;
  assert.equal((await loadChangelog(ORIGIN, BUNDLED, { fetchImpl, cache: fakeCache() })).source, 'bundled');
});
await t('loadChangelog: a file that will not parse serves the bundled copy and stores nothing', async () => {
  const cache = fakeCache();
  const out = await loadChangelog(ORIGIN, BUNDLED, { fetchImpl: fetchOf(200, '<html>nope</html>').fetchImpl, cache });
  assert.equal(out.source, 'bundled');
  assert.equal(cache.store.size, 0);
});
await t('loadChangelog: a bad cached file falls through to upstream', async () => {
  const { calls, fetchImpl } = fetchOf(200, FIXTURE);
  const out = await loadChangelog(ORIGIN, BUNDLED, { fetchImpl, cache: fakeCache('junk') });
  assert.equal(out.source, 'miss');
  assert.equal(calls.length, 1);
});
await t('loadChangelog: works with no cache at all', async () => {
  const out = await loadChangelog(ORIGIN, BUNDLED, { fetchImpl: fetchOf(200, FIXTURE).fetchImpl, cache: undefined });
  assert.equal(out.source, 'miss');
});

// SECURITY_HEADERS
await t('SECURITY_HEADERS equal the /* block of public/_headers', () => {
  const file = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const block = file.split(/\n\s*\n/)[0].split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  const parsed = Object.fromEntries(block.map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
  assert.deepEqual(SECURITY_HEADERS, parsed);
});

console.log(`\n${passed} passed`);
