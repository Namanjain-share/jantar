/**
 * Tier 1, the user's own Chrome through the paired extension (spec 3.4).
 *
 * Only for a post link the daemon rebuilt (url.ts chromeUrlOf): the job
 * carries that URL, never the user's link as typed. The tier is used only
 * while the extension asked for work in the last 90 s (Read saved links on,
 * Chrome running); otherwise it is skipped at once, with no wait.
 *
 * A read is a lease: `read()` queues it, the extension takes it with
 * `next()` (GET /v1/ext/reads/next) within 45 s, and answers with
 * `result()` (POST /v1/ext/reads/:id) within 45 s of taking it; otherwise
 * the read ends `timeout` and the next tier runs. Only the extension that
 * took a lease may answer it. Cookies never leave Chrome: the extension
 * sends back what it read of the post; any media URL in it is fetched by
 * the daemon, cookie-less, through the guard.
 */
import { randomBytes } from 'node:crypto';
import { INTEL_READ_LIMITS, type ExtReadJob, type ExtReadResultBody, type PageReadParsed } from '@jantar/protocol';
import type { ChromePlatform } from '@jantar/protocol/post-url';
import type { Clock, TimerId } from '../../../contracts.js';

export type ChromeRead = { ok: true; page: PageReadParsed } | { ok: false; why: 'unavailable' | 'timeout' | 'login' | 'not_found' | 'redirected' | 'blocked' | 'no_permission' | 'failed' };

interface Lease {
  job: ExtReadJob;
  /** The extension that took it, once taken. */
  by: string | null;
  timer: TimerId | undefined;
  done(r: ChromeRead): void;
}

export class ChromeLeases {
  /** When the extension last asked for work (epoch ms), and which. */
  lastPollAt: number | null = null;
  private readonly waiting: Lease[] = [];
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly clock: Clock) {}

  /** The extension asked within chromeFreshMs. */
  available(): boolean {
    return this.lastPollAt !== null && this.clock.now() - this.lastPollAt <= INTEL_READ_LIMITS.chromeFreshMs;
  }

  /** Queue a read of a rebuilt post URL and wait for its result (or why not). */
  read(url: string, platform: ChromePlatform, frames: number, signal?: AbortSignal): Promise<ChromeRead> {
    if (!this.available()) return Promise.resolve({ ok: false, why: 'unavailable' });
    return new Promise<ChromeRead>((resolve) => {
      const id = randomBytes(18).toString('base64url');
      const lease: Lease = {
        job: { id, url, platform, frames: Math.max(0, Math.min(frames, INTEL_READ_LIMITS.chromeFrames)) },
        by: null,
        timer: undefined,
        done: (r) => {
          this.clock.clearTimeout(lease.timer);
          this.leases.delete(id);
          const at = this.waiting.indexOf(lease);
          if (at >= 0) this.waiting.splice(at, 1);
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        },
      };
      const onAbort = () => lease.done({ ok: false, why: 'timeout' });
      signal?.addEventListener('abort', onAbort, { once: true });
      lease.timer = this.clock.setTimeout(() => lease.done({ ok: false, why: 'timeout' }), INTEL_READ_LIMITS.chromeClaimMs);
      this.leases.set(id, lease);
      this.waiting.push(lease);
      if (signal?.aborted) onAbort();
    });
  }

  /** The extension asks: the oldest waiting lease is now its own (null when none). Records the poll. */
  next(extensionId: string): ExtReadJob | null {
    this.lastPollAt = this.clock.now();
    const lease = this.waiting.shift();
    if (!lease) return null;
    lease.by = extensionId;
    this.clock.clearTimeout(lease.timer);
    lease.timer = this.clock.setTimeout(() => lease.done({ ok: false, why: 'timeout' }), INTEL_READ_LIMITS.chromeResultMs);
    return lease.job;
  }

  /** The extension's answer; false for a lease that is not its own (or gone). */
  result(leaseId: string, extensionId: string, body: ExtReadResultBody): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.by !== extensionId) return false;
    if (body.ok) lease.done({ ok: true, page: body.page });
    else lease.done({ ok: false, why: body.why });
    return true;
  }

  /** Every lease ends (the daemon stopping, reading off). */
  clear(): void {
    for (const l of [...this.leases.values()]) l.done({ ok: false, why: 'timeout' });
  }
}
