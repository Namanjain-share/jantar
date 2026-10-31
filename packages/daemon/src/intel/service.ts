/**
 * The Intel shelf (v0.4 spec 4.9): JSONL files named on the Mac plus
 * <intelDir>/captures.jsonl, read into memory, deduped by id and followed
 * for appends, only while `intel.enabled` is on.
 *
 * Every source is polled on a watch event in its folder (FSEvents, a hint
 * only) and every 5 s, one pass at a time: a settings change, a capture and
 * the timer all ask for a pass and share the next one. A pass re-checks
 * each source (the denylist, the size), so a source refused or missing now
 * is picked up as soon as it is fine. While items change the shelf emits
 * the text-free `life.changed {}`, at most every 2 s. Items dropped for the
 * cap are logged as a count. No path, line or title is ever logged,
 * emitted or audited.
 */
import { dirname, isAbsolute, join } from 'node:path';
import type { IntelCaptureBody, IntelItem, IntelListQuery, IntelListResponse, IntelSourcesResponse, Settings } from '@jantar/protocol';
import type { DaemonContext, Factories, IntelService, LifeResult, TimerId, Unsubscribe } from '../contracts.js';
import { newId } from '../core/ids.js';
import { DirWatcher } from '../sources/lib/dir-watch.js';
import { Serial } from '../sources/lib/serial.js';
import { appendCapture, captureRecord, type CaptureFrom } from './capture.js';
import { JsonlFollower } from './follow.js';
import { Shelf } from './shelf.js';
import { CAPTURES_FILE, CAPTURES_SOURCE, sourceRefs } from './sources.js';

export type IntelDeps = Parameters<Factories['intel']>[1];

export interface IntelServiceOptions {
  /** The stat fallback (default 5 s). */
  pollMs?: number;
  /** Watch the sources' folders too (default true). */
  watch?: boolean;
  /** `life.changed` at most this often while items change (default 2 s). */
  emitEveryMs?: number;
  /** Items kept across every source (default INTEL_MAX_ITEMS). */
  maxItems?: number;
}

const EMPTY_LIST: IntelListResponse = { items: [], next: null, total: 0, types: [], tags: [] };
export const SHELF_OFF = 'The Intel shelf is off.';
export const CAPTURE_FAILED = "Couldn't save it on the Mac. Try again.";

export class IntelShelfService implements IntelService {
  private readonly shelf: Shelf;
  private followers: JsonlFollower[] = [];
  private enabled = false;
  private started = false;
  private watcher: DirWatcher | null = null;
  private timer: TimerId | undefined;
  private unsubscribe: Unsubscribe | null = null;
  private readonly passes: Serial<void>;
  /** Captures one at a time, so a second one sees the first one's url. */
  private captures: Promise<unknown> = Promise.resolve();
  private emitTimer: TimerId | undefined;
  private lastEmit = -Infinity;
  private readonly opts: Required<Omit<IntelServiceOptions, 'maxItems'>>;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: IntelDeps,
    opts: IntelServiceOptions = {},
  ) {
    this.opts = { pollMs: opts.pollMs ?? 5000, watch: opts.watch ?? true, emitEveryMs: opts.emitEveryMs ?? 2000 };
    this.shelf = new Shelf(opts.maxItems);
    this.passes = new Serial(() => this.pass());
  }

  // ---------------------------------------------------------------- Service

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.ctx.settings.subscribe((next, prev) => {
      if (next.intel !== prev.intel || next.folders !== prev.folders) this.kick();
    });
    // The first read, before the API opens; a failure here never stops the daemon.
    await this.refresh().catch((e: unknown) => this.ctx.log.error('intel pass failed', { error: e instanceof Error ? e.name : 'error' }));
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.passes.idle();
    await this.captures.catch(() => undefined);
    this.close(false);
    this.ctx.clock.clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
  }

  // ---------------------------------------------------------------- IntelService

  list(q: IntelListQuery): IntelListResponse {
    return this.enabled ? this.shelf.list(q) : EMPTY_LIST;
  }

  get(id: string): IntelItem | null {
    return this.enabled ? this.shelf.get(id) : null;
  }

  capture(body: IntelCaptureBody, from: CaptureFrom): Promise<LifeResult<{ id: string; duplicate: boolean }>> {
    const run = this.captures.catch(() => undefined).then(() => this.captureNow(body, from));
    this.captures = run;
    return run;
  }

  sources(): IntelSourcesResponse['sources'] {
    if (!this.enabled) return [];
    return this.followers.map((f) => ({
      id: f.id,
      label: f.id,
      items: this.shelf.count(f.id),
      skipped: f.skipped,
      ...(f.error !== undefined ? { error: f.error } : {}),
      updatedAt: f.updatedAt,
    }));
  }

  // ---------------------------------------------------------------- tests

  /** Every source read as it is now (a pass that started after this call). */
  refresh(): Promise<void> {
    return this.passes.run();
  }

  /** How many whole reads each source has had, the items dropped for the cap, and the folders watched. */
  stats(): { reads: Record<string, number>; dropped: number; watching: string[] } {
    return {
      reads: Object.fromEntries(this.followers.map((f) => [f.id, f.reads])),
      dropped: this.shelf.dropped,
      watching: this.watcher?.watched() ?? [],
    };
  }

  // ---------------------------------------------------------------- internals

  private async captureNow(body: IntelCaptureBody, from: CaptureFrom): Promise<LifeResult<{ id: string; duplicate: boolean }>> {
    // The shelf as it is now, so a url captured or appended a moment ago counts.
    await this.refresh();
    if (!this.enabled || !this.started) return { ok: false, code: 'unavailable', reason: SHELF_OFF };
    if (body.url) {
      const known = this.shelf.findUrl(body.url);
      if (known) return { ok: true, value: { id: known, duplicate: true } };
    }
    const rid = newId();
    try {
      await appendCapture(this.ctx.paths.intelDir, captureRecord(rid, this.ctx.clock.iso(), body, from));
    } catch (e) {
      this.ctx.log.warn('intel capture not saved', { code: (e as NodeJS.ErrnoException).code ?? 'error' });
      return { ok: false, code: 'unavailable', reason: CAPTURE_FAILED };
    }
    await this.refresh();
    return { ok: true, value: { id: `${CAPTURES_SOURCE}:${rid}`, duplicate: false } };
  }

  /** A pass nobody waits for (a timer, a watch event, a settings change): a failure is logged, never thrown. */
  private kick(): void {
    this.refresh().catch((e: unknown) => this.ctx.log.error('intel pass failed', { error: e instanceof Error ? e.name : 'error' }));
  }

  /** Follow what the settings name now, then poll every source once. */
  private async pass(): Promise<void> {
    const settings = this.ctx.settings.get();
    if (!this.started || !settings.intel.enabled) {
      if (this.enabled) this.close(this.started);
      return;
    }
    if (!this.enabled) this.open();
    this.reconcile(settings);
    const dropped = this.shelf.dropped;
    let changed = false;
    for (const f of this.followers) {
      let read;
      try {
        read = await f.poll();
      } catch (e) {
        // A bug, not a bad line: lines are counted, never thrown.
        this.ctx.log.error('intel source poll failed', { error: e instanceof Error ? e.name : 'error' });
        continue;
      }
      if (!read) continue;
      changed = true;
      if (read.reset) this.shelf.replace(f.id, read.records);
      else if (read.records.length) this.shelf.add(f.id, read.records);
    }
    // Only the folders of sources being read: never a refused one's (a secrets folder, say).
    this.watcher?.setDirs(this.followers.filter((f) => f.error === undefined && isAbsolute(f.path)).map((f) => dirname(f.path)));
    if (this.shelf.dropped > dropped) this.ctx.log.info('intel items dropped', { count: this.shelf.dropped - dropped });
    if (changed) this.changed();
  }

  private open(): void {
    this.enabled = true;
    if (this.opts.watch) {
      this.watcher = new DirWatcher(() => this.kick(), { clock: this.ctx.clock, log: this.ctx.log });
    }
    this.timer = this.ctx.clock.setInterval(() => this.kick(), this.opts.pollMs);
  }

  /** Intel turned off (or the daemon stopping): nothing followed, nothing kept. */
  private close(tell: boolean): void {
    this.enabled = false;
    this.ctx.clock.clearInterval(this.timer);
    this.timer = undefined;
    this.watcher?.close();
    this.watcher = null;
    this.followers = [];
    this.shelf.clear();
    if (tell) this.changed();
  }

  /** Followers for the captures file and each configured path, in settings order; a source whose id or path changed starts over. */
  private reconcile(settings: Settings): void {
    const want = [
      { id: CAPTURES_SOURCE, path: join(this.ctx.paths.intelDir, CAPTURES_FILE), own: true },
      ...sourceRefs(settings.intel.sources).map((r) => ({ ...r, own: false })),
    ];
    const have = new Map(this.followers.map((f) => [`${f.id}\n${f.path}`, f]));
    const next: JsonlFollower[] = [];
    for (const w of want) {
      const kept = have.get(`${w.id}\n${w.path}`);
      have.delete(`${w.id}\n${w.path}`);
      next.push(kept ?? new JsonlFollower({ ...w, isProtected: (p) => this.deps.files.policy.isProtected(p) }));
    }
    // A new follower under an old id reads its file from the start on this pass.
    for (const gone of have.values()) this.shelf.remove(gone.id);
    this.followers = next;
  }

  /** `life.changed {}` now, or once the 2 s since the last one have passed. */
  private changed(): void {
    if (this.emitTimer !== undefined) return;
    const wait = this.lastEmit + this.opts.emitEveryMs - this.ctx.clock.now();
    if (wait <= 0) {
      this.emit();
      return;
    }
    this.emitTimer = this.ctx.clock.setTimeout(() => {
      this.emitTimer = undefined;
      this.emit();
    }, wait);
  }

  private emit(): void {
    this.lastEmit = this.ctx.clock.now();
    this.ctx.store.emit({ type: 'life.changed', data: {} });
  }
}

export function buildIntelService(ctx: DaemonContext, deps: IntelDeps, opts: IntelServiceOptions = {}): IntelService {
  return new IntelShelfService(ctx, deps, opts);
}
