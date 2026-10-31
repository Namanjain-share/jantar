/**
 * Meetings (v0.5): the Chrome extension's captions and screenshots, kept on
 * the Mac, with a summary per ended meeting.
 *
 * `createMeetingsService` is the part daemon.ts wires (Factories['meetings'],
 * plus `{ readOnly }`: under --read-only capture and edits work, summaries
 * never run). This file, db.ts and store.ts are the wiring and the storage;
 * capture.ts and library.ts take the extension's posts and the phone's reads
 * and edits; summary.ts and input.ts make the summary.
 *
 * The shell opens meetings.db when `meetings.enabled` turns on (at start, or
 * on a settings change) and closes it when it turns off, summaries stopped
 * first. A failed open makes `broken()` the fixed sentence (every meetings
 * route answers 503 with it) and logs the code only; turning Meetings off
 * and on again tries once more. While open it sweeps at once and every
 * 5 minutes (stale meetings ended, orphan folders removed).
 */
import { isValidTimeZone } from '@jantar/life-core';
import { EXTENSION_IDLE_MS, MEETING_SHOTS_TOTAL_MAX_BYTES, type MeetingsStatus, type Settings } from '@jantar/protocol';
import type {
  CcwLegacySource,
  DaemonContext,
  Factories,
  LifeService,
  Logger,
  MeetingCapture,
  MeetingLibrary,
  MeetingSummaries,
  MeetingsCore,
  MeetingsService,
  MeetingsStore,
  TimerId,
  Unsubscribe,
  UsageSource,
} from '../contracts.js';
import { newId } from '../core/ids.js';
import { buildCapture } from './capture.js';
import { openMeetingsDb, type MeetingsDb } from './db.js';
import { buildLibrary } from './library.js';
import { createMeetingsStore } from './store.js';
import { buildSummaries } from './summary.js';
import { MEETINGS_SWEEP_EVERY_MS } from './sweep.js';

export { MEETINGS_BROKEN_REASON, MEETINGS_MIGRATIONS, MEETINGS_SCHEMA_VERSION, openMeetingsDb, type MeetingsDb } from './db.js';
export { MeetingRecordSchema, createMeetingsStore } from './store.js';

export { MEETINGS_SWEEP_EVERY_MS } from './sweep.js';

export interface MeetingsDeps {
  life: LifeService;
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
}

export interface MeetingsOptions {
  /** jantard --read-only: told, not wrapped (summaries never run; capture and edits work). */
  readOnly?: boolean;
  /** Default MEETING_SHOTS_TOTAL_MAX_BYTES (tests lower it). */
  shotsTotalMax?: number;
}

/** The three wave-1 builders (tests pass their own). */
export interface MeetingsBuilders {
  capture: (core: MeetingsCore) => MeetingCapture;
  library: (core: MeetingsCore) => MeetingLibrary;
  summaries: (core: MeetingsCore) => MeetingSummaries;
}

export const MEETINGS_BUILDERS: MeetingsBuilders = { capture: buildCapture, library: buildLibrary, summaries: buildSummaries };

/** The zone this Mac runs in (as Life's service finds it). */
function macZoneOf(env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env.TZ;
  if (fromEnv && isValidTimeZone(fromEnv)) return fromEnv;
  const intl = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return intl && isValidTimeZone(intl) ? intl : 'UTC';
}

/** An error's code or class name for a log line: never its message (it can carry a path or text). */
function errorKind(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
}

class MeetingsShell implements MeetingsService {
  readonly core: MeetingsCore;
  readonly capture: MeetingCapture;
  readonly library: MeetingLibrary;
  readonly summaries: MeetingSummaries;
  private db: MeetingsDb | null = null;
  private current: MeetingsStore | null = null;
  private brokenReason: string | null = null;
  private timer: TimerId | undefined;
  private unsub: Unsubscribe | null = null;
  private readonly log: Logger;

  constructor(
    private readonly ctx: DaemonContext,
    deps: MeetingsDeps,
    opts: MeetingsOptions,
    builders: MeetingsBuilders,
  ) {
    this.log = ctx.log.child({ part: 'meetings' });
    const macZone = macZoneOf(ctx.env);
    this.core = {
      ctx,
      life: deps.life,
      usage: deps.usage,
      ccwLegacy: deps.ccwLegacy,
      readOnly: opts.readOnly === true,
      shotsTotalMax: opts.shotsTotalMax ?? MEETING_SHOTS_TOTAL_MAX_BYTES,
      store: () => this.current,
      tz: () => {
        const z = ctx.settings.get().life.timezone;
        return z && isValidTimeZone(z) ? z : macZone;
      },
      newId,
      changed: () => this.changed(),
      enqueueSummary: (id) => this.summaries.enqueue(id),
      cancelSummary: (id) => {
        try {
          this.summaries.cancel(id);
        } catch (e) {
          this.log.error('meetings: a summary was not stopped', { error: errorKind(e) });
        }
      },
    };
    this.capture = builders.capture(this.core);
    this.library = builders.library(this.core);
    this.summaries = builders.summaries(this.core);
  }

  async start(): Promise<void> {
    this.unsub ??= this.ctx.settings.subscribe((next, prev) => this.onSettings(next, prev));
    if (this.ctx.settings.get().meetings.enabled) this.open();
  }

  async stop(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    this.close();
  }

  broken(): string | null {
    return this.brokenReason;
  }

  status(): MeetingsStatus {
    const s = this.current;
    const safe = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };
    return {
      on: this.ctx.settings.get().meetings.enabled,
      open: s !== null,
      ...(this.brokenReason ? { broken: this.brokenReason } : {}),
      meetings: s ? safe(() => s.count(), 0) : 0,
      running: s ? safe(() => s.openCount(), 0) : 0,
      shotsBytes: s ? safe(() => s.shotBytesTotal(), 0) : 0,
      summary: safe(() => this.summaries.status(), { available: false }),
      extensions: safe(() => {
        // A key idle too long is revoked only when next presented (auth/extensions.ts): it is not paired any more.
        const now = this.ctx.clock.now();
        return this.ctx.db.extensions
          .list()
          .filter((e) => !e.revokedAt && !(now - Date.parse(e.lastSeenAt ?? e.createdAt) > EXTENSION_IDLE_MS))
          .map((e) => ({ id: e.id, pairedAt: e.createdAt, lastSeenAt: e.lastSeenAt }));
      }, []),
    };
  }

  private changed(): void {
    try {
      this.ctx.store.emit({ type: 'life.changed', data: {} });
    } catch (e) {
      this.log.error('meetings: life.changed not emitted', { error: errorKind(e) });
    }
  }

  private open(): void {
    if (this.current) return;
    const r = openMeetingsDb(this.ctx.paths.meetingsDb);
    if (!r.ok) {
      this.brokenReason = r.reason;
      this.log.error('meetings is broken', { event: 'meetings.broken', code: r.code });
      return;
    }
    this.brokenReason = null;
    this.db = r.db;
    this.current = createMeetingsStore(r.db, this.log);
    try {
      this.summaries.start();
    } catch (e) {
      this.log.error('meetings: summaries did not start', { error: errorKind(e) });
    }
    this.sweep();
    this.timer = this.ctx.clock.setInterval(() => this.sweep(), MEETINGS_SWEEP_EVERY_MS);
  }

  private close(): void {
    this.ctx.clock.clearInterval(this.timer);
    this.timer = undefined;
    if (this.current) {
      try {
        this.summaries.stop();
      } catch (e) {
        this.log.error('meetings: summaries did not stop', { error: errorKind(e) });
      }
    }
    this.current = null;
    this.db?.close();
    this.db = null;
    this.brokenReason = null;
  }

  private sweep(): void {
    if (!this.current) return;
    // The time it fell due: the library tells a slept Mac by the gap between two sweeps.
    const now = this.ctx.clock.now();
    void Promise.resolve()
      .then(() => this.library.sweep(now))
      .catch((e: unknown) => this.log.warn('meetings: the sweep failed', { error: errorKind(e) }));
  }

  private onSettings(next: Settings, prev: Settings): void {
    if (next.meetings.enabled === prev.meetings.enabled) return;
    if (next.meetings.enabled) this.open();
    else this.close();
  }
}

/** The shell with the given builders (tests); daemon.ts uses createMeetingsService. */
export function buildMeetingsService(ctx: DaemonContext, deps: MeetingsDeps, opts: MeetingsOptions = {}, builders: MeetingsBuilders = MEETINGS_BUILDERS): MeetingsService {
  return new MeetingsShell(ctx, deps, opts, builders);
}

export function createMeetingsService(ctx: DaemonContext, deps: MeetingsDeps, opts: MeetingsOptions = {}): MeetingsService {
  return buildMeetingsService(ctx, deps, opts);
}

// The part fits its Factories entry (the third argument is optional).
const _factory: Factories['meetings'] = createMeetingsService;
void _factory;
