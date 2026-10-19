// Single-use authorization codes for altscan.io's OAuth server (src/lib/oauth.ts). One instance holds
// them all. A Durable Object delivers no other event while one of its storage calls is pending (input
// gates), so `take`'s read-then-delete is atomic: a code can be exchanged once.
import { DurableObject } from 'cloudflare:workers';
import type { CodeGrant } from '@altscan/oauth';

type Entry = { grant: CodeGrant; exp: number };

/** Codes nobody exchanged are swept this often; each one is useless after its 60 s TTL anyway. */
const SWEEP_MS = 10 * 60_000;
const DELETE_BATCH = 128; // storage.delete's per-call key limit

export class OAuthCodes extends DurableObject {
  async put(code: string, grant: CodeGrant, ttlSeconds: number): Promise<void> {
    const entry: Entry = { grant, exp: Date.now() + ttlSeconds * 1000 };
    await this.ctx.storage.put(code, entry);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async take(code: string): Promise<CodeGrant | null> {
    const entry = await this.ctx.storage.get<Entry>(code);
    if (!entry) return null;
    await this.ctx.storage.delete(code);
    return entry.exp > Date.now() ? entry.grant : null;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const all = await this.ctx.storage.list<Entry>();
    const expired = [...all].filter(([, e]) => e.exp <= now).map(([k]) => k);
    for (let i = 0; i < expired.length; i += DELETE_BATCH) await this.ctx.storage.delete(expired.slice(i, i + DELETE_BATCH));
    if (all.size > expired.length) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }
}
