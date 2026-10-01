import {
  spreadSeconds, ratePerMin, mergeBlocks, classify, retarget, playheadAt, indexRate, lagLabel,
  sinceOpened, POLL_S, type Playhead, type TapeBlock, type ChainStatus,
} from '../lib/tape';
import type { BlockTuple, ChainState, LatestBlock } from '../lib/chains';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (n: number) => n.toLocaleString('en-US');
const wallNow = () => performance.now() / 1000;
const unixNow = () => Date.now() / 1000;
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const short = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);

interface Chain {
  id: string;
  el: HTMLElement;
  track: HTMLElement;
  url: string;
  domain: string;
  cap: number;
  tuples: BlockTuple[];
  blocks: TapeBlock[];
  online: boolean | null;
  latest?: LatestBlock;
  ph: Playhead | null;
  prev: { newestT: number; wall: number } | null;
  idx: number | null;
  tiles: Map<number, HTMLAnchorElement>;
  pend: HTMLElement;
  lastSeen?: { n: number; unix: number };
  frozenP: number | null;
  hl: number | null;
}

const section = $('[data-tapes]');
const readout = $('[data-readout]');
const legend = readout?.innerHTML ?? '';
const sinceEl = $('[data-since]');
const cursor = $('[data-cursor]');

const chains: Chain[] = [...document.querySelectorAll<HTMLElement>('[data-chain]')].map((el) => {
  const track = $('[data-track]', el)!;
  const pend = document.createElement('div');
  pend.className = 'pd';
  pend.setAttribute('aria-hidden', 'true');
  pend.hidden = true;
  track.appendChild(pend);
  return {
    id: el.dataset.chain!, el, track, url: track.dataset.url!, domain: track.dataset.domain!,
    cap: el.dataset.chain === 'bnb' ? 400 : 64,
    tuples: [], blocks: [], online: null, ph: null, prev: null, idx: null,
    tiles: new Map(), pend, frozenP: null, hl: null,
  };
});

let S = innerWidth < 760 ? 24 : 34; // px per chain-second, equal on both tapes
let widths = chains.map((c) => c.track.clientWidth);
const firstSeen: Record<string, number> = {};
let anatomyDone = false;

/* ── Rendering ─────────────────────────────────────────────────── */

function tile(c: Chain, b: TapeBlock): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'tl';
  a.href = `${c.url}/blocks/${b.n}`;
  a.tabIndex = -1;
  a.dataset.n = String(b.n);
  a.setAttribute('aria-label', `Block ${fmt(b.n)}, ${b.tx} transactions, gas ${b.g}%`);
  const w = Math.max(1, (b.t1 - b.t0) * S - 2);
  a.style.width = `${w}px`;
  a.innerHTML = `<i style="height:${b.g}%"></i>` +
    (w > 230 ? `<span class="lb">#${fmt(b.n)} · ${b.tx} txs · ${b.g}% gas</span>` : '');
  return a;
}

function draw(c: Chain, i: number, wall: number, live: boolean) {
  if (!c.ph) return;
  const W = widths[i];
  const P = c.frozenP ?? playheadAt(c.ph, wall);
  const keep = new Set<number>();
  let lastT1: number | null = null;
  for (let k = c.blocks.length - 1; k >= 0; k--) {
    const b = c.blocks[k];
    if (b.t1 > P) continue;
    if (W - (P - b.t1) * S < 0) break;
    lastT1 ??= b.t1;
    keep.add(b.n);
    let el = c.tiles.get(b.n);
    if (!el) {
      el = tile(c, b);
      c.tiles.set(b.n, el);
      c.track.insertBefore(el, c.pend);
      if (live && c.id === 'bnb' && !reduce && cursor) {
        cursor.animate([{ opacity: 1 }, { opacity: 0.35 }], { duration: 350, easing: 'ease-out' });
      }
    }
    el.style.transform = `translate3d(${(W - (P - b.t0) * S).toFixed(1)}px,0,0)`;
  }
  for (const [n, el] of c.tiles) if (!keep.has(n)) { el.remove(); c.tiles.delete(n); }

  const gap = lastT1 === null ? 0 : (P - lastT1) * S;
  c.pend.hidden = c.online !== true || gap < 24;
  if (!c.pend.hidden) {
    c.pend.style.transform = `translate3d(${(W - gap + 1).toFixed(1)}px,0,0)`;
    c.pend.style.width = `${Math.max(0, gap - 3)}px`;
    c.pend.innerHTML = gap > 110 && c.el.dataset.state === 'live' ? '<span class="lb">next block…</span>' : '';
  }
}

let raf = 0;
let onScreen = true;
function frame() {
  const wall = wallNow();
  chains.forEach((c, i) => draw(c, i, wall, true));
  raf = requestAnimationFrame(frame);
}
function startLoop() { if (!reduce && !raf && onScreen && !document.hidden) raf = requestAnimationFrame(frame); }
function stopLoop() { cancelAnimationFrame(raf); raf = 0; }

/* ── Status, header, panels ────────────────────────────────────── */

function header(c: Chain, status: ChainStatus) {
  const latest = $('[data-latest]', c.el)!, st = $('[data-status]', c.el)!, rate = $('[data-rate]', c.el)!;
  const newest = c.tuples[0];
  if (status === 'offline') {
    latest.textContent = '';
    st.textContent = c.lastSeen
      ? `offline · last seen #${fmt(c.lastSeen.n)} · ${lagLabel(unixNow() - c.lastSeen.unix)} ago`
      : 'offline';
    rate.textContent = '';
    return;
  }
  if (!newest) return;
  latest.textContent = `#${fmt(newest[0])}`;
  if (status === 'stalled') {
    const speed = c.idx === null ? '' : c.idx === 0 ? ' · no new blocks' : c.idx > 1.5 ? ` · ${Math.round(c.idx)}× speed` : '';
    st.textContent = `catching up · ${lagLabel(unixNow() - newest[1])} behind${speed}`;
    rate.textContent = '';
  } else {
    st.textContent = '';
    const r = ratePerMin(c.tuples);
    rate.textContent = r === null ? '' : `${Math.round(r)} blocks/min`;
  }
}

function panel(c: Chain, status: ChainStatus) {
  const p = $(`[data-panel="${c.id}"]`);
  if (!p) return;
  const win = Number(p.dataset.window);
  const newest = c.tuples[0];
  $('[data-p-status]', p)!.textContent =
    status === 'live' ? '● live' : status === 'stalled' ? 'catching up' : status === 'offline' ? 'offline' : '—';
  if (!newest) return;
  $('[data-p-latest]', p)!.textContent = `#${fmt(newest[0])}`;
  const recent = c.tuples.filter((b) => b[1] >= newest[1] - win);
  const blocks = spreadSeconds(recent);
  $('[data-p-count]', p)!.textContent = `${fmt(blocks.length)} blocks`;
  const mini = $('[data-mini]', p)!;
  const W = mini.clientWidth;
  const span = blocks.length ? blocks[blocks.length - 1].t1 - blocks[0].t0 : 0;
  mini.innerHTML = span > 0
    ? blocks.map((b) => `<span style="width:${Math.max(1, ((b.t1 - b.t0) / span) * W - 2).toFixed(1)}px"><i style="height:${b.g}%"></i></span>`).join('')
    : '';
}

function anatomy(c: Chain) {
  const l = c.latest;
  const root = $('[data-anatomy]');
  if (!l || !root || anatomyDone) return;
  anatomyDone = true;
  const set = (k: string, v: string) => { const el = $(`[data-a-${k}]`, root); if (el) el.textContent = v; };
  const g = Number((BigInt(l.gasUsed) * 100n) / (BigInt(l.gasLimit) || 1n));
  const d = new Date(l.timestamp * 1000);
  const time = `${d.toISOString().slice(11, 19)} UTC · ${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
  set('chain', c.id === 'eth' ? 'ethereum' : 'bnb chain');
  set('number', `#${fmt(l.number)}`);
  set('hash', short(l.hash));
  set('miner', short(l.miner));
  set('time', time);
  set('tx', fmt(l.txCount));
  set('gas', `${g}%`);
  set('txh', `${fmt(l.txCount)} transaction${l.txCount === 1 ? '' : 's'}`);
  const fee = l.baseFeePerGas && l.baseFeePerGas !== '0'
    ? `, at a base fee of ${(Number(l.baseFeePerGas) / 1e9).toLocaleString('en-US', { maximumSignificantDigits: 3 })} gwei` : '';
  set('gasp', `How full the block ran: ${g}% of its gas limit${fee}.`);
  const bar = $('[data-a-gasbar]', root);
  if (bar) bar.style.width = `${g}%`;
  for (const a of root.querySelectorAll<HTMLAnchorElement>('[data-a-link]')) {
    const path = a.dataset.aLink === '/blocks/' ? `/blocks/${l.number}` : a.dataset.aLink!;
    a.href = `${c.url}${path}`;
    if (a.classList.contains('lnk')) a.textContent = `${c.domain}${path} ↗`;
  }
}

/** Offline with nothing to show: say so in the track instead of leaving a blank strip. */
function message(c: Chain, status: ChainStatus) {
  let m = $('.tape-msg', c.track);
  if (status === 'offline' && c.tuples.length === 0) {
    if (!m) { m = document.createElement('span'); m.className = 'tape-msg'; c.track.appendChild(m); }
    m.innerHTML = `${c.domain} isn't answering · retrying every ${POLL_S}s · <a href="${c.url}">open ${c.domain} ↗</a>`;
  } else m?.remove();
}

/* ── Data ──────────────────────────────────────────────────────── */

function apply(payload: Record<string, ChainState> | null) {
  const wall = wallNow(), unix = unixNow();
  const current: Record<string, number> = {};
  chains.forEach((c, i) => {
    const s = payload?.[c.id];
    if (s?.online && s.blocks?.length) {
      c.online = true;
      c.tuples = mergeBlocks(c.tuples, s.blocks, c.cap);
      c.latest = s.latest;
      const [newestN, newestT] = c.tuples[0];
      c.idx = indexRate(c.prev, newestT, wall);
      c.prev = { newestT, wall };
      c.ph = retarget(c.ph, newestT, c.idx, wall);
      c.blocks = spreadSeconds(c.tuples);
      c.lastSeen = { n: newestN, unix };
      firstSeen[c.id] ??= newestN;
      current[c.id] = newestN;
    } else {
      c.online = false;
      // Freeze where it stood; the grey tiles keep showing the last blocks seen.
      if (c.ph) c.ph = { p0: playheadAt(c.ph, wall), wall0: wall, rate: 0 };
    }
    const status = classify(c.online, c.tuples[0]?.[1] ?? null, unix);
    c.el.dataset.state = status;
    message(c, status);
    header(c, status);
    panel(c, status);
    if (reduce || !raf) draw(c, i, wall, false);
  });
  if (Object.keys(firstSeen).length && sinceEl) sinceEl.textContent = fmt(sinceOpened(firstSeen, current));
  anatomy(chains.find((c) => c.id === 'eth' && c.online) ?? chains.find((c) => c.online) ?? chains[0]);
}

let timer = 0;
let polled = false;
async function poll() {
  clearTimeout(timer);
  // The first fetch runs even in a background tab, so the page is ready when it's brought forward.
  if (document.hidden && polled) return;
  polled = true;
  let payload: Record<string, ChainState> | null = null;
  try {
    const res = await fetch('/api/chains.json', { cache: 'no-store' });
    if (res.ok) payload = await res.json();
  } catch { /* offline state below */ }
  apply(payload);
  timer = window.setTimeout(poll, POLL_S * 1000);
}

/* ── Interaction ───────────────────────────────────────────────── */

function showReadout(c: Chain, n: number) {
  const b = c.blocks.find((x) => x.n === n);
  if (!b || !readout) return;
  readout.innerHTML = `<b class="rb ${c.id}">#${fmt(b.n)}</b> ${b.tx} txs · gas ${b.g}% · ` +
    `<a class="lnk" href="${c.url}/blocks/${b.n}">open on ${c.domain} ↗</a>`;
}
function restoreReadout() { if (readout && !chains.some((c) => c.hl !== null)) readout.innerHTML = legend; }

for (const c of chains) {
  c.track.addEventListener('pointerover', (e) => {
    const n = (e.target as HTMLElement).closest<HTMLElement>('.tl')?.dataset.n;
    if (n) showReadout(c, Number(n));
  });
  c.track.addEventListener('focus', () => {
    if (!c.ph) return;
    c.frozenP = playheadAt(c.ph, wallNow());
    const shown = [...c.tiles.keys()].sort((a, b) => b - a);
    highlight(c, shown[0] ?? null);
  });
  c.track.addEventListener('blur', () => {
    c.frozenP = null;
    highlight(c, null);
    restoreReadout();
  });
  c.track.addEventListener('keydown', (e) => {
    const shown = [...c.tiles.keys()].sort((a, b) => a - b);
    if (c.hl === null || !shown.length) return;
    const i = shown.indexOf(c.hl);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const j = Math.min(shown.length - 1, Math.max(0, i + (e.key === 'ArrowLeft' ? -1 : 1)));
      highlight(c, shown[j]);
    } else if (e.key === 'Enter') {
      c.tiles.get(c.hl)?.click();
    } else if (e.key === 'Escape') {
      c.track.blur();
    }
  });
}
section?.addEventListener('pointerleave', restoreReadout);

function highlight(c: Chain, n: number | null) {
  if (c.hl !== null) c.tiles.get(c.hl)?.classList.remove('hl');
  c.hl = n;
  if (n === null) return;
  c.tiles.get(n)?.classList.add('hl');
  showReadout(c, n);
  if (reduce) draw(c, chains.indexOf(c), wallNow(), false);
}

/* ── Lifecycle ─────────────────────────────────────────────────── */

addEventListener('resize', () => {
  const s = innerWidth < 760 ? 24 : 34;
  widths = chains.map((c) => c.track.clientWidth);
  if (s !== S) {
    S = s;
    for (const c of chains) { for (const el of c.tiles.values()) el.remove(); c.tiles.clear(); }
  }
  if (reduce) chains.forEach((c, i) => draw(c, i, wallNow(), false));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(timer); stopLoop(); } else { poll(); startLoop(); }
});
if (section && 'IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    if (onScreen) startLoop(); else stopLoop();
  }).observe(section);
}

// Anatomy: the step in view highlights, and so does its row on the block card.
const steps = document.querySelectorAll<HTMLElement>('[data-step]');
if (steps.length && 'IntersectionObserver' in window) {
  const rows = document.querySelectorAll<HTMLElement>('[data-row]');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const k = (e.target as HTMLElement).dataset.step;
      steps.forEach((s) => s.classList.toggle('on', s === e.target));
      rows.forEach((r) => r.classList.toggle('on', r.dataset.row === k));
    }
  }, { rootMargin: '-40% 0px -50% 0px' });
  steps.forEach((s) => io.observe(s));
}

// Terminal: types its lines once when it scrolls into view.
const term = $('[data-term]');
if (term && !reduce && 'IntersectionObserver' in window) {
  let delay = 0;
  for (const line of term.querySelectorAll<HTMLElement>('.ty')) {
    const n = line.textContent?.length ?? 0;
    line.style.setProperty('--n', String(n));
    line.style.setProperty('--d', `${delay}ms`);
    delay += n * 28 + 220;
  }
  term.classList.add('armed');
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    term.classList.add('go');
    io.disconnect();
  }, { threshold: 0.4 });
  io.observe(term);
}

poll();
startLoop();
