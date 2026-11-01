/**
 * TranscriptWatcher: follows the transcripts of live sessions.
 *
 * Per session, once a second (one stat when nothing changed):
 * - publishes what the tail says (`now`, `lastReply`, `mode`, `away`,
 *   `errorLast`, `transcriptPath`) as session.updated;
 * - finds alerts (blocked / rejected / limit / API error) in the bytes the
 *   transcript grew by, and in its subagents' transcripts. The first read
 *   backfills at most ALERT_BACKFILL_BYTES (256 KB, not ccw's 4 MB) and
 *   only the last hour. Alert ids are stable and remembered across restarts,
 *   so a restart does not repeat the feed;
 * - v0.3: publishes Write / Edit / MultiEdit / NotebookEdit calls in the same
 *   bytes as files.changed while Files is on (file-changes.ts);
 * - reports Done for sessions without hooks (docs/hook-protocol.md, section 7):
 *   the session file says idle, that idle was recorded after the newest
 *   prompt, an assistant reply exists after that prompt, and both the idle
 *   and the transcript have been quiet for 1 s. A reply older than the newest
 *   prompt is never reported (ccw hazard 3.2). A turn shorter than the poll
 *   (never seen working) is still caught, because the turn is identified by
 *   its prompt, not by a busy -> idle edge. Sessions whose status comes from
 *   hooks are left to the hooks bridge (Stop hook), and a session.done from
 *   anyone else for the same turn cancels ours;
 * - v0.6.1: publishes the work Claude still runs in the background
 *   (`background`: workflows, agents, shells, monitors) from the same bytes
 *   of the main transcript (background.ts), checked on every poll so a
 *   monitor's expiry or a relaunch clears it with no new bytes. Cleared by
 *   a patch to {}, never unset (a 0.6.0 hub would refuse the unset).
 */
import { basename, dirname, join } from 'node:path';
import {
  ALERT_BACKFILL_BYTES,
  EVENT,
  localSession,
  type Alert,
  type AlertKind,
  type Session,
  type SessionOptionalKey,
  type SessionPatch,
} from '@jantar/protocol';
import type {
  DaemonContext,
  Factories,
  SessionRecord,
  SessionSource,
  TimerId,
  TranscriptReader,
  TranscriptTail,
  TranscriptWatcher,
  Unsubscribe,
} from '../../contracts.js';
import { sha256Hex } from '../../core/hash.js';
import { fileSig, fsx, listDir, readRange } from '../lib/fsx.js';
import { Serial } from '../lib/serial.js';
import { stableJson } from '../lib/values.js';
import { AlertScanner, type FoundAlert } from './alerts.js';
import { BackgroundScanner } from './background.js';
import { FileChangeScanner, publishFileOps } from './file-changes.js';

export interface TranscriptWatcherOptions {
  /** Poll interval (default 1000 ms). */
  pollMs?: number;
  /** Done waits until the idle and the transcript have both been quiet this long (default 1000 ms). */
  quietMs?: number;
  /** First-read alert backfill (default ALERT_BACKFILL_BYTES = 256 KB). */
  backfillBytes?: number;
  /** Alerts older than this are not reported (default 1 h, as ccw). */
  alertWindowMs?: number;
  /** How often each session's subagent folder is listed (default 20 s). */
  subagentWalkMs?: number;
  /** How often known subagent transcripts are checked for growth (default 5 s). */
  subagentPollMs?: number;
  /** The same API error for one session is reported once per this long (default 10 min). */
  errorDedupeMs?: number;
}

/** kv key: ids of alerts already published (so a restart's backfill doesn't repeat them). */
export const ALERT_IDS_KV_KEY = 'sources.transcripts.alert-ids';
const ALERT_IDS_CAP = 2000;
const READ_CHUNK = 4 * 1024 * 1024;
const MAX_READS_PER_POLL = 8;
const SUBAGENT_FILES_MAX = 50;

const ALERT_EVENT: Record<AlertKind, 'alert.blocked' | 'alert.rejected' | 'alert.limit' | 'alert.error'> = {
  blocked: EVENT.ALERT_BLOCKED,
  rejected: EVENT.ALERT_REJECTED,
  limit: EVENT.ALERT_LIMIT,
  error: EVENT.ALERT_ERROR,
};

const ALERT_WORD: Record<AlertKind, string> = {
  blocked: 'Blocked',
  rejected: 'Rejected',
  limit: 'Limit hit',
  error: 'API error',
};

const TAIL_FIELDS = ['now', 'lastReply', 'mode', 'away', 'errorLast'] as const;

interface Track {
  path: string;
  /** Next byte to read; null until the first (backfill) read. */
  offset: number | null;
  size: number;
  scanner: AlertScanner;
  /** v0.3: Write / Edit / MultiEdit / NotebookEdit calls -> files.changed. */
  files: FileChangeScanner;
  /** v0.6.1: background work; the main transcript's track only. */
  bg?: BackgroundScanner;
}

interface Watched {
  sid: string;
  path: string | null;
  main: Track | null;
  /** v0.6.1: the claude process's start (epoch ms, the session file's startedAt): its background work is newer. */
  procStart: number | null;
  sig: string | null;
  lastGrowAt: number;
  /** Latest tail computed (published or not). */
  tail: TranscriptTail | null;
  /** Tail as last published. */
  published: TranscriptTail | null;
  /** Turn already reported (or deliberately skipped); null = any turn counts; undefined = not looked at yet. */
  doneFor: string | null | undefined;
  idleSeenAt: number | null;
  idleKey: string | null;
  subs: Map<string, Track>;
  lastWalk: number | null;
  lastSubPoll: number | null;
}

export class TranscriptWatcherImpl implements TranscriptWatcher {
  private readonly watched = new Map<string, Watched>();
  private readonly alertIds: string[] = [];
  private readonly alertIdSet = new Set<string>();
  private readonly recentErrors = new Map<string, number>();
  /** sid -> when someone else (hooks) last emitted session.done. */
  private readonly externalDone = new Map<string, number>();
  private emittingDoneFor: string | null = null;
  private timer: TimerId | undefined;
  private unsubscribe: Unsubscribe | null = null;
  private started = false;
  /** When start() ran: a transcript's first read publishes file ops from then on only. */
  private startedAt = 0;
  private readonly serial: Serial<void>;
  private readonly opts: Required<TranscriptWatcherOptions>;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: { sessions: SessionSource; transcripts: TranscriptReader },
    opts: TranscriptWatcherOptions = {},
  ) {
    this.opts = {
      pollMs: opts.pollMs ?? 1000,
      quietMs: opts.quietMs ?? 1000,
      backfillBytes: opts.backfillBytes ?? ALERT_BACKFILL_BYTES,
      alertWindowMs: opts.alertWindowMs ?? 3_600_000,
      subagentWalkMs: opts.subagentWalkMs ?? 20_000,
      subagentPollMs: opts.subagentPollMs ?? 5000,
      errorDedupeMs: opts.errorDedupeMs ?? 600_000,
    };
    this.serial = new Serial(() => this.poll());
    this.loadAlertIds();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startedAt = this.ctx.clock.now();
    this.unsubscribe = this.ctx.store.subscribe((ev) => {
      if (ev.type === EVENT.SESSION_DONE && ev.sid && this.emittingDoneFor !== ev.sid) {
        this.externalDone.set(ev.sid, Date.parse(ev.ts));
      }
    });
    await this.pollOnce();
    if (!this.started) return;
    this.timer = this.ctx.clock.setInterval(() => {
      this.pollOnce().catch((e) => this.ctx.log.error('transcript poll failed', { error: String(e) }));
    }, this.opts.pollMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ctx.clock.clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.serial.idle();
  }

  /** One pass over every live session (the timer calls this; tests call it directly). */
  pollOnce(): Promise<void> {
    return this.serial.run();
  }

  // ----------------------------------------------------------------

  private async poll(): Promise<void> {
    const records = this.deps.sessions.current();
    const live = new Set(records.map((r) => r.sid));
    for (const sid of [...this.watched.keys()]) {
      if (!live.has(sid)) {
        this.watched.delete(sid);
        this.externalDone.delete(sid);
      }
    }
    for (const r of records) {
      try {
        await this.pollSession(r);
      } catch (e) {
        // one odd transcript must not stop the others
        this.ctx.log.warn('transcript read failed', { sid: r.sid, error: String(e) });
      }
    }
  }

  private async pollSession(r: SessionRecord): Promise<void> {
    const s = localSession(this.ctx.store.getState(), r.sid);
    if (!s) return; // not published yet
    let w = this.watched.get(r.sid);
    if (!w) {
      w = {
        sid: r.sid,
        path: null,
        main: null,
        procStart: null,
        sig: null,
        lastGrowAt: this.ctx.clock.now(),
        tail: null,
        published: null,
        doneFor: undefined,
        idleSeenAt: null,
        idleKey: null,
        subs: new Map(),
        lastWalk: null,
        lastSubPoll: null,
      };
      this.watched.set(r.sid, w);
    }
    w.procStart = r.startedAt ?? null;
    const hint: { cwd?: string; configDir?: string; transcriptPath?: string } = { cwd: r.cwd, configDir: r.configDir };
    if (s.transcriptPath) hint.transcriptPath = s.transcriptPath;
    const path = await this.deps.transcripts.pathFor(r.sid, hint);
    if (!path) return;
    if (w.path !== path) {
      w.path = path;
      w.main = { path, offset: null, size: 0, scanner: new AlertScanner(), files: new FileChangeScanner(), bg: new BackgroundScanner() };
      w.sig = null;
      w.published = null;
      w.subs.clear();
      w.lastWalk = null;
      w.lastSubPoll = null;
      if (s.transcriptPath !== path) this.update(s, { transcriptPath: path }, []);
    }
    const sig = await fileSig(path);
    if (!sig) return;
    const now = this.ctx.clock.now();
    if (sig.sig !== w.sig) {
      w.sig = sig.sig;
      w.lastGrowAt = now;
      w.tail = await this.deps.transcripts.tail(path);
      this.publishTail(w);
      if (w.main) await this.scanAlerts(r.sid, w.main, sig.size, w.procStart);
    }
    this.publishBackground(w);
    await this.pollSubagents(w);
    this.checkDone(w);
  }

  // ---------------------------------------------------------------- tail -> session

  private publishTail(w: Watched): void {
    const s = localSession(this.ctx.store.getState(), w.sid);
    const tail = w.tail;
    if (!s || !tail) return;
    const prev = w.published;
    const patch: SessionPatch = {};
    const unset: SessionOptionalKey[] = [];
    for (const key of TAIL_FIELDS) {
      const next = tail[key];
      // only what changed in the transcript since we last looked: a value
      // someone else set (e.g. the Stop hook's lastReply) is left alone
      if (prev && stableJson(next) === stableJson(prev[key])) continue;
      if (next === undefined) {
        if (prev && s[key] !== undefined) unset.push(key);
      } else if (stableJson(s[key]) !== stableJson(next)) {
        (patch as Record<string, unknown>)[key] = next;
      }
    }
    w.published = tail;
    this.update(s, patch, unset);
  }

  /** v0.6.1: what runs in the background now; one patch when it changes ({} once it all ends). */
  private publishBackground(w: Watched): void {
    const s = localSession(this.ctx.store.getState(), w.sid);
    if (!s || !w.main?.bg) return;
    const next = w.main.bg.snapshot(w.procStart, this.ctx.clock.now());
    if (stableJson(next) !== stableJson(s.background ?? {})) this.update(s, { background: next }, []);
  }

  private update(s: Session, patch: SessionPatch, unset: SessionOptionalKey[]): void {
    if (!Object.keys(patch).length && !unset.length) return;
    try {
      this.ctx.store.emit({
        type: EVENT.SESSION_UPDATED,
        sid: s.sid,
        ...(s.account !== null ? { account: s.account } : {}),
        data: unset.length ? { patch, unset } : { patch },
      });
    } catch (e) {
      this.ctx.log.error('could not publish transcript state', { sid: s.sid, error: String(e) });
    }
  }

  // ---------------------------------------------------------------- Done (no hooks)

  private checkDone(w: Watched): void {
    const s = localSession(this.ctx.store.getState(), w.sid);
    const tail = w.tail;
    if (!s || !tail) return;
    const key = tail.lastUserPromptAt ?? tail.lastReply?.at ?? null;
    const statusAt = Date.parse(s.statusAt ?? s.statusSince);
    const promptAt = tail.lastUserPromptAt ? Date.parse(tail.lastUserPromptAt) : null;
    const idleAfterPrompt = promptAt === null || statusAt >= promptAt;

    if (s.status !== 'idle') {
      w.idleSeenAt = null;
      w.idleKey = null;
      if (w.doneFor === undefined) w.doneFor = null; // first seen mid-turn: this turn's end counts
      return;
    }
    if (w.doneFor === undefined) {
      // first look at an idle session: what already happened is not news
      w.doneFor = idleAfterPrompt ? key : null;
      return;
    }
    const now = this.ctx.clock.now();
    if (w.idleKey !== (s.statusAt ?? s.statusSince)) {
      w.idleKey = s.statusAt ?? s.statusSince;
      w.idleSeenAt = now;
    }
    if (s.statusSource === 'hook') {
      w.doneFor = key; // the hooks bridge reports Done from the Stop hook
      return;
    }
    if (key === null || key === w.doneFor) return;
    if (!idleAfterPrompt) return; // this idle predates the newest prompt: that turn has not ended
    if (!tail.lastReply) return; // no reply after the prompt yet (still being written)
    if (now - Math.max(w.idleSeenAt ?? now, w.lastGrowAt) < this.opts.quietMs) return;

    w.doneFor = key;
    if (tail.errorLast) return; // stopped on an API error: that alert says so
    const move = s.move ?? this.ctx.store.getState().moves[w.sid];
    if (move && move.step !== 'stuck') return; // a ccw move is driving this session
    const ext = this.externalDone.get(w.sid);
    if (ext !== undefined && (promptAt === null || ext >= promptAt)) return; // reported already (hooks)

    const lastReply = tail.lastReply;
    if (stableJson(s.lastReply) !== stableJson(lastReply)) this.update(s, { lastReply }, []);
    try {
      this.emittingDoneFor = w.sid;
      this.ctx.store.emit({
        type: EVENT.SESSION_DONE,
        sid: w.sid,
        ...(s.account !== null ? { account: s.account } : {}),
        data: { lastReply },
      });
    } catch (e) {
      this.ctx.log.error('could not publish session.done', { sid: w.sid, error: String(e) });
    } finally {
      this.emittingDoneFor = null;
    }
  }

  // ---------------------------------------------------------------- alerts

  private async scanAlerts(sid: string, track: Track, size: number, procStart: number | null = null): Promise<void> {
    if (size < track.size) {
      // the file shrank: read it again from the start
      track.offset = null;
      track.scanner = new AlertScanner();
      track.files = new FileChangeScanner({ byAgent: track.files.byAgent });
      if (track.bg) track.bg = new BackgroundScanner();
    }
    track.size = size;
    // the first read is history: the changes index backfills it itself
    const quietBefore = track.offset === null ? this.startedAt : 0;
    if (track.offset === null) {
      const start = Math.max(0, size - this.opts.backfillBytes);
      track.offset = start === 0 ? 0 : await lineStartAtOrAfter(track.path, start, size);
    }
    const now = this.ctx.clock.now();
    for (let i = 0; i < MAX_READS_PER_POLL && track.offset < size; i++) {
      const from: number = track.offset;
      const { entries, next } = await this.deps.transcripts.readFrom(track.path, from, { maxBytes: READ_CHUNK });
      if (next === from) break;
      track.offset = next;
      for (const e of entries) {
        for (const found of track.scanner.scan(e.raw, e.offset, now)) {
          if (now - found.at > this.opts.alertWindowMs) continue;
          this.publishAlert(sid, track.path, found);
        }
        track.bg?.scan(e.raw, procStart);
      }
      publishFileOps(this.ctx, sid, await track.files.scanRead(track.path, from, entries, next, now), quietBefore);
    }
  }

  private async pollSubagents(w: Watched): Promise<void> {
    if (!w.path) return;
    const now = this.ctx.clock.now();
    const walk = w.lastWalk === null || now - w.lastWalk >= this.opts.subagentWalkMs;
    if (!walk && w.lastSubPoll !== null && now - w.lastSubPoll < this.opts.subagentPollMs) return;
    w.lastSubPoll = now;
    if (walk) {
      const since = w.lastWalk === null ? now - this.opts.alertWindowMs : w.lastWalk - 60_000;
      w.lastWalk = now;
      const dir = join(dirname(w.path), w.sid); // <projects>/<encoded cwd>/<sid>/subagents, workflows, ...
      for (const f of await recentJsonl(dir, since)) {
        if (!w.subs.has(f)) w.subs.set(f, { path: f, offset: null, size: 0, scanner: new AlertScanner(), files: new FileChangeScanner({ byAgent: true }) });
      }
      if (w.subs.size > SUBAGENT_FILES_MAX) {
        const keep = [...w.subs].slice(-SUBAGENT_FILES_MAX);
        w.subs.clear();
        for (const [k, v] of keep) w.subs.set(k, v);
      }
    }
    for (const track of w.subs.values()) {
      const sig = await fileSig(track.path);
      if (!sig) {
        w.subs.delete(track.path);
        continue;
      }
      if (track.offset === null || sig.size !== track.size) await this.scanAlerts(w.sid, track, sig.size);
    }
  }

  private publishAlert(sid: string, file: string, f: FoundAlert): void {
    const id = `al_${sha256Hex(`${sid}|${basename(file)}|${f.key}|${f.kind}`).slice(0, 24)}`;
    if (this.alertIdSet.has(id)) return;
    if (f.kind === 'limit' || f.kind === 'error') {
      // retries repeat the same API error: one per session per 10 minutes
      const k = `${sid}|${f.kind}|${f.why ?? ''}`;
      const last = this.recentErrors.get(k);
      this.recentErrors.set(k, f.at);
      if (this.recentErrors.size > 500) {
        const oldest = this.recentErrors.keys().next().value;
        if (oldest !== undefined) this.recentErrors.delete(oldest);
      }
      if (last !== undefined && Math.abs(f.at - last) < this.opts.errorDedupeMs) {
        this.rememberAlert(id);
        return;
      }
    }
    this.rememberAlert(id);
    const s = localSession(this.ctx.store.getState(), sid);
    const name = s?.name?.trim() || sid.slice(0, 8);
    const alert: Alert = {
      id,
      ts: new Date(f.at).toISOString(),
      kind: f.kind,
      sid,
      label: `${ALERT_WORD[f.kind]} · ${s?.folder ?? '?'} · ${name}`,
      what: f.what,
    };
    if (s && s.account !== null) alert.account = s.account;
    if (f.why) alert.why = f.why;
    if (f.full) alert.full = f.full;
    try {
      this.ctx.store.emit({
        type: ALERT_EVENT[f.kind],
        sid,
        ...(alert.account !== undefined ? { account: alert.account } : {}),
        data: { alert },
      });
    } catch (e) {
      this.ctx.log.error('could not publish alert', { sid, error: String(e) });
    }
  }

  private loadAlertIds(): void {
    try {
      const ids = this.ctx.db.kv.get<unknown>(ALERT_IDS_KV_KEY);
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string' && !this.alertIdSet.has(id)) {
            this.alertIds.push(id);
            this.alertIdSet.add(id);
          }
        }
      }
    } catch (e) {
      this.ctx.log.warn('could not load alert ids', { error: String(e) });
    }
  }

  private rememberAlert(id: string): void {
    this.alertIds.push(id);
    this.alertIdSet.add(id);
    while (this.alertIds.length > ALERT_IDS_CAP) {
      const old = this.alertIds.shift();
      if (old !== undefined) this.alertIdSet.delete(old);
    }
    try {
      this.ctx.db.kv.set(ALERT_IDS_KV_KEY, this.alertIds);
    } catch (e) {
      this.ctx.log.warn('could not save alert ids', { error: String(e) });
    }
  }
}

// ---------------------------------------------------------------------------

/** The first line start at or after `pos` (just past a newline), or `size` if none. */
async function lineStartAtOrAfter(path: string, pos: number, size: number): Promise<number> {
  if (pos <= 0) return 0;
  const fh = await fsx.open(path).catch(() => null);
  if (!fh) return size;
  try {
    const chunk = 64 * 1024;
    for (let p = pos - 1; p < size; p += chunk) {
      const buf = await readRange(fh, p, Math.min(chunk, size - p));
      const i = buf.indexOf(0x0a);
      if (i >= 0) return p + i + 1;
    }
    return size;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** `.jsonl` files under `dir` (3 levels deep, at most 200) modified at or after `since`. */
async function recentJsonl(dir: string, since: number): Promise<string[]> {
  const out: { path: string; mtime: number }[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 3 || out.length >= 200) return;
    for (const e of await listDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const sig = await fileSig(p);
        if (sig && sig.mtimeMs >= since) out.push({ path: p, mtime: sig.mtimeMs });
      }
      if (out.length >= 200) return;
    }
  };
  await walk(dir, 0);
  return out.sort((a, b) => a.mtime - b.mtime).map((x) => x.path);
}

/** Factories['transcriptWatcher']. */
export const createTranscriptWatcher: Factories['transcriptWatcher'] = (ctx, deps) => new TranscriptWatcherImpl(ctx, deps);

export function createTranscriptWatcherWith(
  ctx: DaemonContext,
  deps: { sessions: SessionSource; transcripts: TranscriptReader },
  opts: TranscriptWatcherOptions = {},
): TranscriptWatcherImpl {
  return new TranscriptWatcherImpl(ctx, deps, opts);
}
