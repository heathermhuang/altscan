// Reads CHANGELOG.md for /changelog. Text becomes typed tokens, never an HTML string, so the page
// renders everything through Astro's escaping.
import { GITHUB } from '../data/site';

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'pr'; number: number; href: string };

export interface Bullet { tokens: Inline[]; lead: Inline[] | null }
export interface Section { title: string; bullets: Bullet[] }
export interface Release {
  version: string;
  date: string | null;
  anchor: string;
  summary: Inline[];
  sections: Section[];
  compareUrl: string | null;
}
export interface Changelog { unreleased: Release | null; releases: Release[] }
export interface TapeBlock { label: string; anchor: string; count: number; fill: number; pending: boolean }

const UNRELEASED = 'Unreleased';
const RELEASE = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const SECTION = /^### (.+)$/;
const BULLET = /^- (.+)$/;
const REF = /^\[([^\]]+)\]: (https:\S+)$/;
const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w/#&])#(\d+)\b/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of src.matchAll(INLINE)) {
    if (m.index > at) out.push({ kind: 'text', text: src.slice(at, m.index) });
    at = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ kind: 'bold', children: parseInline(m[1]) });
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
    else if (m[3] !== undefined) out.push(m[4].startsWith('https://') ? { kind: 'link', text: m[3], href: m[4] } : { kind: 'text', text: m[3] });
    else out.push({ kind: 'pr', number: Number(m[5]), href: `${GITHUB}/pull/${m[5]}` });
  }
  if (at < src.length) out.push({ kind: 'text', text: src.slice(at) });
  return out;
}

function toBullet(src: string): Bullet {
  const tokens = parseInline(src);
  const first = tokens[0];
  return { tokens, lead: first?.kind === 'bold' ? first.children : null };
}

const anchorFor = (version: string) => (version === UNRELEASED ? 'live' : `v${version.replaceAll('.', '-')}`);

export function parseChangelog(md: string): Changelog {
  const found: { release: Release; summary: string[] }[] = [];
  const refs = new Map<string, string>();
  for (const line of md.split('\n')) {
    const ref = REF.exec(line);
    if (ref) { refs.set(ref[1], ref[2]); continue; }
    const head = RELEASE.exec(line);
    if (head) {
      const release: Release = { version: head[1], date: head[2] ?? null, anchor: anchorFor(head[1]), summary: [], sections: [], compareUrl: null };
      found.push({ release, summary: [] });
      continue;
    }
    const current = found.at(-1);
    if (!current) continue;
    const section = SECTION.exec(line);
    if (section) { current.release.sections.push({ title: section[1].trim(), bullets: [] }); continue; }
    const open = current.release.sections.at(-1);
    const bullet = BULLET.exec(line);
    if (bullet && open) open.bullets.push(toBullet(bullet[1]));
    else if (!open && line.trim()) current.summary.push(line.trim());
  }
  const releases = found.map(({ release, summary }) => {
    const ref = refs.get(release.version);
    return { ...release, summary: parseInline(summary.join(' ')), compareUrl: ref?.includes('/compare/') ? ref : null };
  });
  return {
    unreleased: releases.find((r) => r.version === UNRELEASED) ?? null,
    releases: releases.filter((r) => r.version !== UNRELEASED),
  };
}

export const countChanges = (r: Release) => r.sections.reduce((n, s) => n + s.bullets.length, 0);

/** The bold leads of a release, which is what a bold-led bullet marks. */
export function highlights(r: Release, max = 5): Inline[][] {
  return r.sections.flatMap((s) => s.bullets).flatMap((b) => (b.lead ? [b.lead] : [])).slice(0, max);
}

/** Oldest to newest, with Unreleased last: width = changes, fill = share that were additions. */
export function releaseTape(cl: Changelog): TapeBlock[] {
  const ordered = [...cl.releases].reverse();
  if (cl.unreleased) ordered.push(cl.unreleased);
  return ordered.map((r) => {
    const count = countChanges(r);
    const added = r.sections.find((s) => s.title === 'Added')?.bullets.length ?? 0;
    return {
      label: r.date ? r.version.replace(/(\.0)+$/, '') : 'Live',
      anchor: r.anchor,
      count,
      fill: count ? Math.round((added / count) * 100) : 0,
      pending: !r.date,
    };
  });
}

export function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Empty when the page can trust this file. CI runs it on the real one. */
export function changelogProblems(cl: Changelog): string[] {
  if (cl.releases.length === 0) return ['no releases'];
  return cl.releases.flatMap((r) => [
    ...(r.date ? [] : [`${r.version}: no date`]),
    ...(r.summary.length ? [] : [`${r.version}: no summary`]),
    ...(countChanges(r) ? [] : [`${r.version}: no changes`]),
  ]);
}

// publish-changelog.yml keeps this branch equal to CHANGELOG.md plus changelog.d/.
const SOURCE_URL = 'https://raw.githubusercontent.com/heathermhuang/altscan/changelog-published/CHANGELOG.md';
const CACHE_PATH = '/__changelog.md';
const TTL_S = 3600;
const TIMEOUT_MS = 2000;

type CacheLike = Pick<Cache, 'match' | 'put'>;
export interface LoadDeps { fetchImpl?: typeof fetch; cache?: CacheLike }
export type ChangelogSource = 'hit' | 'miss' | 'bundled';

const usable = (text: string): Changelog | null => {
  const changelog = parseChangelog(text);
  return changelogProblems(changelog).length ? null : changelog;
};

async function fetchSource(fetchImpl: typeof fetch): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(SOURCE_URL, { signal: ctrl.signal, headers: { 'user-agent': 'altscan-site' } });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads main through the edge cache, so a merge reaches the page without a deploy. A failed or
 *  unusable read serves the copy bundled at build time and is not cached. */
export async function loadChangelog(
  origin: string,
  bundled: string,
  deps: LoadDeps = { cache: (globalThis as { caches?: { default?: Cache } }).caches?.default },
): Promise<{ changelog: Changelog; source: ChangelogSource }> {
  const { fetchImpl = fetch, cache } = deps;
  const key = new Request(new URL(CACHE_PATH, origin).toString());
  const hit = await cache?.match(key);
  const cached = hit ? usable(await hit.text()) : null;
  if (cached) return { changelog: cached, source: 'hit' };

  const text = await fetchSource(fetchImpl);
  const fresh = text === null ? null : usable(text);
  if (!fresh) return { changelog: parseChangelog(bundled), source: 'bundled' };
  await cache?.put(key, new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${TTL_S}` } }));
  return { changelog: fresh, source: 'miss' };
}
