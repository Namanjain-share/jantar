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
 *
 * v0.8 (Add post): the Mac reads links saved to the shelf (read/). Every
 * write to captures.jsonl goes through one store (read/store.ts) with one
 * lock: 0.7's captures, a read's lines, tombstones and compactions. A save
 * (`read`) writes the item at once (findable by its link within seconds)
 * and queues its read (read/queue.ts: one job at a time daemon-wide); the
 * job (read/pipeline.ts) writes the item's last line. At start every item
 * left `queued` is written failed ("Stopped before it finished."), never
 * re-queued; reading off, Intel off and the daemon stopping fail the jobs
 * going. Under --read-only a link is saved failed with the readOnly reason.
 * One `intel.read` audit row per job, counts only.
 */
import { dirname, isAbsolute, join } from 'node:path';
import {
  INTEL_DEPTH_DEFAULT,
  INTEL_READ_LIMITS,
  INTEL_READ_REASONS,
  type ExtReadJob,
  type ExtReadResultBody,
  type IntelCaptureBody,
  type IntelDepth,
  type IntelItem,
  type IntelJobsResponse,
  type IntelListQuery,
  type IntelListResponse,
  type IntelReadBody,
  type IntelReadReply,
  type IntelReadStatus,
  type IntelSourcesResponse,
  type Settings,
} from '@jantar/protocol';
import type { DaemonContext, Factories, IntelService, IntelVia, LifeResult, TimerId, Unsubscribe } from '../contracts.js';
import { SYSTEM_ACTOR, actorId } from '../core/actor.js';
import { newId } from '../core/ids.js';
import type { IntelOptions } from './index.js';
import { DirWatcher } from '../sources/lib/dir-watch.js';
import { Serial } from '../sources/lib/serial.js';
import { captureRecord, type CaptureFrom } from './capture.js';
import { JsonlFollower } from './follow.js';
import { READ_MODEL, READ_PROMPT_VERSION } from './read/claude.js';
import { clearJobs, dropJobDir, freshJobDir, readThumb, removeThumbs, ridOk, sweepThumbs } from './read/files.js';
import { Guard, checkUrl, ownHosts } from './read/guard.js';
import { MediaHelper } from './read/media.js';
import { runRead, type PipelineDeps, type ReadAudit } from './read/pipeline.js';
import { ReadQueue, type Job } from './read/queue.js';
import { CapturesStore, type CaptureLine } from './read/store.js';
import { BrowserTier } from './read/tiers/browser.js';
import { ChromeLeases } from './read/tiers/chrome.js';
import { acceptText, canonical, kindOf, pendingTitle } from './read/url.js';
import { YtDlp } from './read/ytdlp.js';
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
  /** v0.8: the daemon's mode and the tests' seams (intel/index.ts IntelOptions). */
  read?: IntelOptions;
}

const EMPTY_LIST: IntelListResponse = { items: [], next: null, total: 0, types: [], tags: [] };
export const SHELF_OFF = 'The Intel shelf is off.';
export const CAPTURE_FAILED = "Couldn't save it on the Mac. Try again.";

/** v0.8: the phone's and the CLI's sentences for a save (IntelReadReply.message). */
export const READ_SENTENCES = {
  saved: 'Saved. Reading it on your Mac.',
  duplicate: 'Already saved.',
  /** A plain capture: reading is off (the capture door's case). */
  savedOff: `Saved as a link. ${INTEL_READ_REASONS.off}`,
  noSuchItem: 'That item is no longer on the shelf.',
  notCaptures: 'Only items saved on this Mac can be read again or deleted.',
  busy: 'It is being read now.',
  gone: 'That read is no longer waiting.',
} as const;

type Fail = Extract<LifeResult, { ok: false }>;
const refuse = (code: Fail['code'], reason: string): Fail => ({ ok: false, code, reason });
const PREFIX = `${CAPTURES_SOURCE}:`;

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
  private readonly opts: Required<Omit<IntelServiceOptions, 'maxItems' | 'read'>>;
  // v0.8
  /** The one writer of captures.jsonl. */
  readonly store: CapturesStore;
  private readonly readOnly: boolean;
  private readonly guard: Guard;
  private readonly chrome: ChromeLeases;
  private readonly browser: BrowserTier;
  private readonly ytdlp: YtDlp;
  readonly helper: MediaHelper;
  readonly queue: ReadQueue;
  private readonly learned = new Set<string>();
  /** The store's start pass (a save waits for it). */
  private storeReady: Promise<void> = Promise.resolve();
  private localesCache: { id: string; onDevice: boolean }[] | null = null;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: IntelDeps,
    opts: IntelServiceOptions = {},
  ) {
    this.opts = { pollMs: opts.pollMs ?? 5000, watch: opts.watch ?? true, emitEveryMs: opts.emitEveryMs ?? 2000 };
    this.shelf = new Shelf(opts.maxItems);
    this.passes = new Serial(() => this.pass());
    const read = opts.read ?? {};
    this.readOnly = read.readOnly ?? false;
    this.store = new CapturesStore(ctx.paths.intelDir, ctx.log);
    this.guard = new Guard({ own: () => ownHosts(ctx.settings.get().remote), ...(read.net ? { net: read.net } : {}) });
    this.chrome = new ChromeLeases(ctx.clock);
    this.browser = new BrowserTier({ env: ctx.env, ...(read.browser ? { executablePath: read.browser.executablePath } : {}), ...(read.browser?.load ? { load: read.browser.load } : {}) });
    this.ytdlp = new YtDlp(ctx);
    this.helper = new MediaHelper(ctx);
    const pipeline: PipelineDeps = {
      ctx,
      guard: this.guard,
      chrome: this.chrome,
      browser: this.browser,
      ytdlp: this.ytdlp,
      helper: this.helper,
      usage: deps.usage,
      ccwLegacy: deps.ccwLegacy,
      log: ctx.log,
      learned: this.learned,
    };
    this.queue = new ReadQueue({
      clock: ctx.clock,
      log: ctx.log,
      run: async (job, update) => {
        const { line, audit } = await runRead(job, pipeline, update);
        if (job.why !== 'deleted') this.audit(job, audit);
        return line;
      },
      write: async (line) => {
        await this.store.append([line]);
        this.kick();
      },
      failedLine: (job, reason) => failedLineOf(job, reason, ctx.clock.iso()),
      changed: () => this.changed(),
    });
  }

  // ---------------------------------------------------------------- Service

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.ctx.settings.subscribe((next, prev) => {
      if (next.intel !== prev.intel || next.folders !== prev.folders) this.kick();
      const wasOn = prev.intel.enabled && prev.intel.read;
      const isOn = next.intel.enabled && next.intel.read;
      if (wasOn && !isOn) void this.stopReads();
      // `jantar intel read on` starts the helper's one-time build at once (never a read).
      if (!wasOn && isOn && !this.readOnly) void this.helper.ensure().catch(() => false);
    });
    // v0.8: nothing resumes after a restart; leftover job dirs go.
    this.storeReady = this.startStore();
    await this.storeReady;
    // The first read, before the API opens; a failure here never stops the daemon.
    await this.refresh().catch((e: unknown) => this.ctx.log.error('intel pass failed', { error: e instanceof Error ? e.name : 'error' }));
    await this.sweep();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.stopReads();
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
    return this.oneAtATime(() => this.captureNow(body, from));
  }

  /** Captures and saves one at a time, so a second one sees the first one's url. */
  private oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.captures.catch(() => undefined).then(fn);
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

  // ---------------------------------------------------------------- v0.8 reads

  read(body: IntelReadBody, from: { via: IntelVia; keyId?: string }): Promise<LifeResult<IntelReadReply>> {
    return this.oneAtATime(() => this.readNow(body, from));
  }

  reread(id: string, depth: IntelDepth | undefined): LifeResult<{ id: string }> {
    if (!this.enabled || !this.started) return refuse('unavailable', SHELF_OFF);
    if (!id.startsWith(PREFIX)) return refuse('forbidden', READ_SENTENCES.notCaptures);
    const item = this.shelf.get(id);
    if (!item) return refuse('not_found', READ_SENTENCES.noSuchItem);
    if (this.readOnly) return refuse('forbidden', INTEL_READ_REASONS.readOnly);
    if (!this.readingOn()) return refuse('forbidden', INTEL_READ_REASONS.off);
    const rid = id.slice(PREFIX.length);
    if (!ridOk(rid)) return refuse('forbidden', READ_SENTENCES.notCaptures);
    if (this.queue.busy(rid)) return refuse('conflict', READ_SENTENCES.busy);
    const d = depth ?? item.depth ?? item.read?.depth ?? INTEL_DEPTH_DEFAULT;
    const refusal = this.queue.refusal(d);
    if (refusal === 'daily') return refuse('rate_limited', INTEL_READ_REASONS.daily);
    if (refusal === 'queueFull') return refuse('conflict', INTEL_READ_REASONS.queueFull);
    let link: string | null = null;
    if (item.url) {
      const checked = checkUrl(item.url, ownHosts(this.ctx.settings.get().remote), { upgrade: true });
      if (!checked.ok) return refuse('invalid_request', INTEL_READ_REASONS.badLink);
      link = canonical(checked.url.href);
    }
    const kind = kindOf(link);
    const base = recordOf(rid, item, this.ctx.clock.iso());
    const note = item.note ?? (!item.read && item.summary ? item.summary : null);
    const queued: CaptureLine = { ...base, ...(note ? { note } : {}), depth: d, read: { state: 'queued', depth: d } };
    // A saved item, or a plain capture the user titled (0.7's: no platform), keeps its title when this read fails.
    const keepTitle = item.read?.state === 'saved' || (!item.read && item.platform === undefined);
    this.queue.push({ rid, link, kind, depth: d, title: item.title, note, base: queued, userTags: item.read ? [] : item.tags, keepTitle });
    // Written through the store's lock, so it lands before the job's own last line.
    void this.store
      .append([queued])
      .then(() => this.kick())
      .catch((e: unknown) => this.ctx.log.warn('intel read not queued on disk', { code: (e as NodeJS.ErrnoException).code ?? 'error' }));
    return { ok: true, value: { id } };
  }

  jobs(): IntelJobsResponse {
    const on = this.readingOn();
    const why = !on ? INTEL_READ_REASONS.off : this.readOnly ? INTEL_READ_REASONS.readOnly : undefined;
    return { jobs: this.queue.list(), reading: { on, canRun: on && !this.readOnly, ...(why ? { why } : {}) } };
  }

  async remove(id: string): Promise<LifeResult> {
    if (!this.enabled || !this.started) return refuse('unavailable', SHELF_OFF);
    if (!id.startsWith(PREFIX)) return refuse('forbidden', READ_SENTENCES.notCaptures);
    const rid = id.slice(PREFIX.length);
    this.queue.cancel(rid);
    await this.storeReady;
    let gone: boolean;
    try {
      gone = await this.store.remove(rid);
    } catch (e) {
      this.ctx.log.warn('intel item not deleted', { code: (e as NodeJS.ErrnoException).code ?? 'error' });
      return refuse('unavailable', CAPTURE_FAILED);
    }
    if (!gone) return refuse('not_found', READ_SENTENCES.noSuchItem);
    await removeThumbs(this.ctx.paths.intelDir, rid);
    await this.refresh();
    return { ok: true, value: true };
  }

  async frame(id: string, n: number): Promise<Buffer | null> {
    if (!this.enabled || !id.startsWith(PREFIX)) return null;
    const item = this.shelf.get(id);
    if (!item || n >= (item.frames ?? 0)) return null;
    return readThumb(this.ctx.paths.intelDir, id.slice(PREFIX.length), n);
  }

  async readStatus(): Promise<IntelReadStatus> {
    const s = this.ctx.settings.get();
    const on = this.readingOn();
    const why = !s.intel.enabled ? SHELF_OFF : !s.intel.read ? INTEL_READ_REASONS.off : this.readOnly ? INTEL_READ_REASONS.readOnly : undefined;
    const built = await this.helper.built();
    const locales = built && this.helper.gap() === null ? await this.locales() : null;
    const keys = this.ctx.db.captureKeys.activeCount();
    const paired = this.ctx.db.extensions.list().some((e) => e.revokedAt === null);
    const today = this.queue.today();
    return {
      on,
      canRun: on && !this.readOnly,
      ...(why ? { why } : {}),
      chrome: { paired, lastPollAt: this.chrome.lastPollAt === null ? null : this.ctx.clock.iso(this.chrome.lastPollAt) },
      browser: { found: this.browser.available() },
      ytdlp: { found: this.ytdlp.found, version: await this.ytdlp.version() },
      clt: { found: await this.helper.toolsFound() },
      helper: { built },
      sandbox: { found: this.ctx.bins.sandboxExec !== null },
      speech: { locale: s.intel.speechLocale, onDevice: locales === null ? null : locales.some((l) => l.id === s.intel.speechLocale && l.onDevice) },
      today: { reads: today.reads, full: today.full, perDay: INTEL_READ_LIMITS.perDay, fullPerDay: INTEL_READ_LIMITS.fullPerDay },
      queue: this.queue.counts(),
      captureKeys: keys,
      door: doorOf(s, keys),
    };
  }

  extNext(extensionId: string): ExtReadJob | null {
    return this.chrome.next(extensionId);
  }

  extResult(leaseId: string, extensionId: string, body: ExtReadResultBody): LifeResult {
    return this.chrome.result(leaseId, extensionId, body) ? { ok: true, value: true } : refuse('not_found', READ_SENTENCES.gone);
  }

  /** The on-device speech locales (status), read once by the helper. */
  async speechLocales(): Promise<{ id: string; onDevice: boolean }[] | null> {
    return this.locales();
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
    await this.storeReady;
    // The shelf as it is now, so a url captured or appended a moment ago counts.
    await this.refresh();
    if (!this.enabled || !this.started) return { ok: false, code: 'unavailable', reason: SHELF_OFF };
    if (body.url) {
      const known = this.shelf.findUrl(body.url);
      if (known) return { ok: true, value: { id: known, duplicate: true } };
    }
    const rid = newId();
    try {
      const wrote = await this.store.append([captureRecord(rid, this.ctx.clock.iso(), body, from) as CaptureLine], { fresh: true });
      if (wrote === 'full') return { ok: false, code: 'unavailable', reason: INTEL_READ_REASONS.shelfFull };
    } catch (e) {
      this.ctx.log.warn('intel capture not saved', { code: (e as NodeJS.ErrnoException).code ?? 'error' });
      return { ok: false, code: 'unavailable', reason: CAPTURE_FAILED };
    }
    await this.refresh();
    return { ok: true, value: { id: `${CAPTURES_SOURCE}:${rid}`, duplicate: false } };
  }

  /** v0.8: save at once, then queue the read (or say why it can't start). */
  private async readNow(body: IntelReadBody, from: { via: IntelVia; keyId?: string }): Promise<LifeResult<IntelReadReply>> {
    await this.storeReady;
    await this.refresh();
    if (!this.enabled || !this.started) return refuse('unavailable', SHELF_OFF);
    const accepted = acceptText(body.text, ownHosts(this.ctx.settings.get().remote));
    if (!accepted.ok) return refuse('invalid_request', INTEL_READ_REASONS.badLink);
    const { link, note } = accepted;
    const depth = body.depth ?? INTEL_DEPTH_DEFAULT;
    if (link) {
      const known = this.shelf.findUrl(link);
      if (known) return { ok: true, value: { id: known, duplicate: true, queued: false, message: READ_SENTENCES.duplicate } };
    }
    const kind = kindOf(link);
    const rid = newId();
    const at = this.ctx.clock.iso();
    const title = pendingTitle(link, kind, note);
    const rec: CaptureLine = { id: rid, captured_at: at, title, ...(link ? { url: link } : {}), platform: kind.platform, type: kind.type, via: from.via, ...(note ? { note } : {}) };
    // Reading off (the capture door's case): the link is kept as a plain capture.
    const plain = !this.readingOn();
    const why = plain ? null : this.readOnly ? INTEL_READ_REASONS.readOnly : refusalSentence(this.queue.refusal(depth));
    if (!plain) {
      rec.depth = depth;
      rec.read = why ? { state: 'failed', depth, reason: why, at } : { state: 'queued', depth };
    }
    let wrote;
    try {
      wrote = await this.store.append([rec], { fresh: true });
    } catch (e) {
      this.ctx.log.warn('intel save not written', { code: (e as NodeJS.ErrnoException).code ?? 'error' });
      return refuse('unavailable', CAPTURE_FAILED);
    }
    if (wrote === 'full') return refuse('unavailable', INTEL_READ_REASONS.shelfFull);
    const queued = !plain && !why;
    if (queued) this.queue.push({ rid, link, kind, depth, title, note, base: rec, userTags: [] });
    await this.refresh();
    const message = plain ? READ_SENTENCES.savedOff : why ? `Saved. ${why}` : READ_SENTENCES.saved;
    return { ok: true, value: { id: `${PREFIX}${rid}`, duplicate: false, queued, message } };
  }

  private readingOn(): boolean {
    const s = this.ctx.settings.get();
    return s.intel.enabled && s.intel.read;
  }

  /** The start: the store's pass, every item left queued written failed, leftover job dirs removed. */
  private async startStore(): Promise<void> {
    try {
      const n = await this.store.failQueued(INTEL_READ_REASONS.stopped, this.ctx.clock.iso());
      if (n > 0) {
        this.ctx.log.info('intel reads stopped before they finished', { count: n });
        this.changed();
      }
      await clearJobs(this.ctx.paths.intelDir);
    } catch (e) {
      this.ctx.log.error('intel store pass failed', { code: (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.name : 'error') });
    }
  }

  /** Thumbnail folders of ids no longer live: only right after a successful pass, and only while Intel is on. */
  private async sweep(): Promise<void> {
    if (!this.started || !this.ctx.settings.get().intel.enabled) return;
    try {
      await this.store.load();
      if (!this.store.passed || !this.ctx.settings.get().intel.enabled) return;
      const n = await sweepThumbs(this.ctx.paths.intelDir, this.store.liveIds(), this.ctx.clock.now());
      if (n > 0) this.ctx.log.info('intel thumbnails swept', { count: n });
    } catch (e) {
      this.ctx.log.warn('intel sweep failed', { code: (e as NodeJS.ErrnoException).code ?? 'error' });
    }
  }

  /** Reading off, Intel off or the daemon stopping: the job going and every waiting one end failed. */
  private async stopReads(): Promise<void> {
    this.chrome.clear();
    await this.queue.stopAll();
  }

  private async locales(): Promise<{ id: string; onDevice: boolean }[] | null> {
    if (this.localesCache) return this.localesCache;
    const dir = await freshJobDir(this.ctx.paths.intelDir, newId());
    if (!dir) return null;
    try {
      const r = await this.helper.locales(dir);
      if (r.ok) this.localesCache = r.value.locales;
      return this.localesCache;
    } finally {
      await dropJobDir(dir);
    }
  }

  /** One `intel.read` row per job: counts only. */
  private audit(job: Job, a: ReadAudit): void {
    try {
      this.ctx.db.audit.append({
        ts: this.ctx.clock.iso(),
        actor: actorId(SYSTEM_ACTOR),
        action: 'intel.read',
        target: job.id,
        params: {
          depth: a.depth,
          done: a.done,
          tier: a.tier,
          frames: a.frames,
          transcriptChars: a.transcriptChars,
          ms: a.ms,
          account: a.account,
          model: READ_MODEL,
          promptVersion: READ_PROMPT_VERSION,
          outcome: a.outcome,
        },
        result: a.outcome === 'ok' ? 'ok' : 'failed',
      });
    } catch {
      this.ctx.log.error('intel audit write failed');
    }
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
    // v0.8: Intel turned on: the thumbnail sweep after the store's own pass.
    if (this.started) void this.sweep();
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

function refusalSentence(r: 'queueFull' | 'daily' | null): string | null {
  return r === null ? null : INTEL_READ_REASONS[r];
}

/** A queued job's failed line: its item as it was, with the reason. */
export function failedLineOf(job: Job, reason: string, at: string): CaptureLine {
  return { ...job.base, read: { state: 'failed', depth: job.depth, reason, at } };
}

/** An item on the shelf as a captures line again (Retry and Read again start from it). */
export function recordOf(rid: string, item: IntelItem, now: string): CaptureLine {
  const rec: CaptureLine = { id: rid, captured_at: item.at ?? now, title: item.title };
  if (item.url) rec.url = item.url;
  if (item.type) rec.type = item.type;
  if (item.tags.length) rec.tags = item.tags;
  if (item.summary) rec.what_it_is = item.summary;
  if (item.why) rec.why_it_matters = item.why;
  for (const f of item.fields) if (!(f.key in rec)) rec[f.key] = f.value;
  if (item.platform) rec.platform = item.platform;
  if (item.creator) rec.creator = item.creator;
  if (item.postedAt) rec.posted_at = item.postedAt;
  if (item.caption) rec.caption = item.caption;
  if (item.transcript) rec.transcript = item.transcript;
  if (item.onScreen) rec.on_screen = item.onScreen;
  if (item.points) rec.points = item.points;
  if (item.background) rec.background = item.background;
  if (item.note) rec.note = item.note;
  if (item.frames !== undefined) rec.frames = item.frames;
  return rec;
}

/** The capture door: open only in tailscale or cloudflare mode, with Intel on and a key. */
export function doorOf(s: Settings, keys: number): IntelReadStatus['door'] {
  const mode = s.remote.mode;
  let url: string | null = null;
  try {
    if (s.remote.publicUrl) url = new URL('/v1/capture/save', s.remote.publicUrl).href;
  } catch {
    url = null;
  }
  if (mode !== 'tailscale' && mode !== 'cloudflare') return { open: false, url: null, why: `The door is closed: remote mode is ${mode} (it needs tailscale or cloudflare).` };
  if (!s.intel.enabled) return { open: false, url, why: SHELF_OFF };
  if (keys === 0) return { open: false, url, why: 'No Shortcut key yet: jantar intel shortcut add' };
  return { open: true, url };
}
