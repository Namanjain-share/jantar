/**
 * The changed-files index (v0.3 spec 4.4.8; decision U9: no git, no diffs):
 * which files each live session created or changed, from the Write, Edit,
 * MultiEdit and NotebookEdit calls in its transcripts (main and subagents).
 * Work package FC owns this file, sources/transcripts/file-changes.ts and the
 * scanner hook lines in sources/transcripts/watcher.ts.
 *
 * - Only while files.enabled is on. Turning it on indexes every live
 *   session in the background; turning it off drops the indexes and unsets
 *   `filesChanged`.
 * - Each session's index reads its transcripts with its own scanners: first
 *   a backfill of at most 256 MiB (newest bytes first), 8 MiB per tick, then
 *   whatever they grew by whenever the watcher publishes `files.changed` for
 *   the session or a client asks. The event is only a nudge: counts and
 *   statuses come from the index's own read.
 * - A call still waiting for its result shows as a `pending` op until the
 *   result lands (or a new prompt says it never will). Pending ops sit beside
 *   a row's sums, never in them, so one that goes away leaves the row as it was.
 * - Ops are deduped by opId and grouped per file: its realpath, or the
 *   lexical path when the file is gone, so /tmp/x and /private/tmp/x are one
 *   row (the other spelling's changeId, as an event names it, is an alias).
 *   A protected path, and a path outside every root (FilePolicy.underRoot),
 *   is never resolved: it is keyed by name, its /var, /tmp or /etc spelling
 *   as /private/... on macOS. Nothing outside the roots is touched on disk,
 *   so a file the session wrote under ~/Documents or ~/Desktop never brings
 *   up a macOS privacy prompt. A path keeps the key it got first: a root
 *   that appears later changes the row's view, not its key or changeId.
 * - A row opens in the viewer at the file's current content through
 *   FilePolicy.locate (rootId + rel), asked only for a path under a root. A
 *   protected path keeps its name, tool, time and counts only: no rootId, no
 *   rel, and its realpath is never looked up.
 * - Caps: 2,000 files and 20,000 ops per session, and an estimated 2 MiB
 *   (rows, op details, the opIds kept for dedupe, path spellings); the
 *   oldest op details go first. 64 sessions; subagent transcripts read to
 *   their end and no longer among the newest 50 are let go.
 * - A read that fails (EIO, say) is tried again after 1 s, doubling up to a
 *   minute; the other sessions go on meanwhile.
 * - `session.updated {filesChanged}` (files with at least one ok op), at
 *   most once per 2 s per session, once its backfill is done.
 */
import { posix } from 'node:path';
import { EVENT, localSession, localSessions, type FileChange, type FileOp, type FileTool, type Session } from '@jantar/protocol';
import type { ChangeDetail, ChangesService, DaemonContext, Factories, FileRefusalCode, SessionChanges, TimerId, Unsubscribe } from '../contracts.js';
import { fileSig, fsx, listDir } from '../sources/lib/fsx.js';
import { privateSpelling } from './policy.js';
import {
  FileChangeScanner,
  LARGE_LINE_BYTES,
  changeIdFor,
  lineStartAtOrAfter,
  type ScannedOp,
} from '../sources/transcripts/file-changes.js';

export { privateSpelling };

export type ChangesDeps = Parameters<Factories['changes']>[1];

export interface ChangesOptions {
  /** Transcript bytes one tick reads (default 8 MiB), in whole 1 MiB reads. */
  tickBytes?: number;
  /** Backfill per session, newest bytes first (default 256 MiB). */
  totalBytes?: number;
  /** Pause between background ticks (default 200 ms). */
  tickMs?: number;
  /** `filesChanged` goes out at most this often per session (default 2 s). */
  debounceMs?: number;
  /** How long a row's viewer link (FilePolicy.locate) is reused (default 10 s). */
  viewTtlMs?: number;
  maxPaths?: number;
  maxOps?: number;
  /** Estimated size of one session's index (default 2 MiB). */
  maxIndexBytes?: number;
  maxSessions?: number;
}

const WALK_MS = 20_000;
/** A subagent's files.changed may name a transcript the index hasn't listed yet. */
const WALK_SOON_MS = 5000;
const SUBAGENT_FILES_MAX = 50;
const RETRY_MS = 1000;
const RETRY_MAX_MS = 60_000;
/** Estimated bytes: a row (plus its path), an op's details, a kept opId, a path spelling (plus both paths), an alias. */
const ROW_BYTES = 256;
const OP_BYTES = 96;
const ID_BYTES = 64;
const KEY_BYTES = 64;
const ALIAS_BYTES = 160;

type Viewable = FileChange['viewable'];
interface View {
  viewable: Viewable;
  rootId?: string;
  rel?: string;
}

interface Op {
  op: FileOp;
  atMs: number;
  created: boolean | null;
}

/** One file's finished ops, summed up as they come, and its calls still pending. */
interface Row {
  changeId: string;
  /** realpath, or the lexical path (gone, protected, or the policy can't say). */
  path: string;
  /** Times of the finished ops (Infinity and -Infinity before the first). */
  firstAt: number;
  lastAt: number;
  /** Finished ops ever seen (details of the oldest may be trimmed). */
  count: number;
  ops: Op[];
  /** Calls still waiting for their result: shown with the row, never in its sums. */
  pending: Op[];
  tools: FileTool[];
  added: number;
  removed: number;
  okOps: number;
  firstOk: { at: number; created: boolean } | null;
  /** The newest finished op (the first op placed, until one finishes). */
  last: Op;
  view: View;
  viewAt: number;
}

interface Track {
  path: string;
  byAgent: boolean;
  scanner: FileChangeScanner;
  /** Next byte to read. */
  offset: number;
  /** The backfill's part of this file: [start, end) of the bytes there when it was listed. */
  start: number;
  end: number;
}

interface Index {
  sid: string;
  tracks: Map<string, Track>;
  lastWalk: number | null;
  walkSoon: boolean;
  /** Backfill bytes left to plan. */
  budget: number;
  /** The backfill has read every planned byte. */
  done: boolean;
  /** The transcripts may hold ops not read yet. */
  dirty: boolean;
  truncated: boolean;
  /** By path key. */
  rows: Map<string, Row>;
  byId: Map<string, Row>;
  /** changeId of another spelling of a path -> the row's changeId. */
  aliases: Map<string, string>;
  /** Lexical path -> path key. */
  keys: Map<string, string>;
  /** Ids of finished ops (pending ones are not here). */
  opIds: Set<string>;
  /** Calls still waiting for their result, shown as `pending` ops. */
  pending: Map<string, { row: Row; op: Op }>;
  /** Op details in arrival order, for trimming the oldest. */
  log: Array<[Row, Op]>;
  logHead: number;
  bytes: number;
  /** Files with an ok op, as last counted. */
  counted: number;
  /** Reads that failed in a row (the retry backs off). */
  failures: number;
}

export function buildChangesService(ctx: DaemonContext, deps: ChangesDeps, opts: ChangesOptions = {}): ChangesIndex {
  return new ChangesIndex(ctx, deps, opts);
}

export class ChangesIndex implements ChangesService {
  private readonly sessions = new Map<string, Index>();
  private readonly queue: string[] = [];
  private readonly timers = new Map<string, TimerId>();
  /** A session whose read failed comes back to the queue when its timer fires. */
  private readonly retries = new Map<string, TimerId>();
  private readonly unsubs: Unsubscribe[] = [];
  private readonly opts: Required<ChangesOptions>;
  private chain: Promise<unknown> = Promise.resolve();
  private pumpTimer: TimerId | undefined;
  private refreshingRecent = false;
  private enabled = false;
  private started = false;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: ChangesDeps,
    opts: ChangesOptions = {},
  ) {
    this.opts = {
      tickBytes: opts.tickBytes ?? 8 * 1024 * 1024,
      totalBytes: opts.totalBytes ?? 256 * 1024 * 1024,
      tickMs: opts.tickMs ?? 200,
      debounceMs: opts.debounceMs ?? 2000,
      viewTtlMs: opts.viewTtlMs ?? 10_000,
      maxPaths: opts.maxPaths ?? 2000,
      maxOps: opts.maxOps ?? 20_000,
      maxIndexBytes: opts.maxIndexBytes ?? 2 * 1024 * 1024,
      maxSessions: opts.maxSessions ?? 64,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubs.push(
      this.ctx.settings.subscribe((next, prev) => {
        if (next.files.enabled === prev.files.enabled) return;
        if (next.files.enabled) this.enable();
        else this.disable();
      }),
      this.ctx.store.subscribe((ev) => {
        if (!ev.sid) return;
        if (ev.type === EVENT.SESSION_REMOVED) this.drop(ev.sid);
        if (!this.enabled) return;
        // v0.6: a paired server's session is never scanned on the Mac.
        if (ev.type === EVENT.SESSION_ADDED && ev.data.session.node === undefined) this.queueSession(ev.sid);
        if (ev.type === EVENT.FILES_CHANGED) this.nudge(ev.sid, ev.data.byAgent);
      }),
    );
    if (this.ctx.settings.get().files.enabled) this.enable();
  }

  async stop(): Promise<void> {
    // no timer is set once this is false, so a read still running can't leave one behind
    this.started = false;
    for (const u of this.unsubs.splice(0)) u();
    this.clearTimers();
    await this.idle();
  }

  /** Resolves when no read is running or queued behind one (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const c = this.chain;
      await c;
      if (c === this.chain) return;
    }
  }

  // ---------------------------------------------------------------- ChangesService

  async forSession(sid: string): Promise<SessionChanges | null> {
    if (!this.live(sid)) return null;
    if (!this.enabled) return { changes: [], scan: { done: true, bytes: 0, total: 0 }, truncated: false };
    const idx = this.ensure(sid);
    // one tick now: a small transcript comes back complete on the first call
    await this.exclusive(() => this.advance(idx, this.opts.tickBytes));
    if (!idx.done || idx.dirty) this.queueSession(sid, true);
    await this.refreshViews([...idx.rows.values()]);
    const changes = [...idx.rows.values()].sort((a, b) => latest(b).atMs - latest(a).atMs).map((r) => this.toChange(sid, r));
    return { changes, scan: scanOf(idx), truncated: idx.truncated };
  }

  async change(sid: string, changeId: string): Promise<ChangeDetail | null> {
    if (!this.live(sid) || !this.enabled) return null;
    const idx = this.ensure(sid);
    await this.exclusive(() => this.advance(idx, this.opts.tickBytes));
    if (!idx.done || idx.dirty) this.queueSession(sid, true);
    const row = idx.byId.get(idx.aliases.get(changeId) ?? changeId);
    if (!row) return null;
    await this.refreshViews([row]);
    const ops = [...row.ops, ...row.pending].sort((a, b) => a.atMs - b.atMs).map((o) => ({ ...o.op }));
    return { change: this.toChange(sid, row), ops };
  }

  recent(opts: { since?: string; limit: number }): FileChange[] {
    if (!this.enabled) return [];
    const since = opts.since ? Date.parse(opts.since) : Number.NEGATIVE_INFINITY;
    const found: Array<[string, Row, number]> = [];
    for (const idx of this.sessions.values()) {
      if (!this.live(idx.sid)) continue;
      for (const r of idx.rows.values()) {
        const at = latest(r).atMs;
        if (at >= since) found.push([idx.sid, r, at]);
      }
    }
    found.sort((a, b) => b[2] - a[2]);
    const shown = found.slice(0, Math.max(0, opts.limit));
    // links are checked again in the background; the next call has them fresh
    const stale = shown.map(([, r]) => r).filter((r) => this.stale(r));
    if (stale.length && !this.refreshingRecent) {
      this.refreshingRecent = true;
      this.refreshViews(stale)
        .catch((e) => this.ctx.log.warn('could not check changed files', { error: String(e) }))
        .finally(() => {
          this.refreshingRecent = false;
        });
    }
    return shown.map(([sid, r]) => this.toChange(sid, r));
  }

  changedPathsFor(sid: string): string[] {
    const idx = this.enabled ? this.sessions.get(sid) : undefined;
    if (!idx) return [];
    // judged again now (by name, no disk): a view can be 10 s old, and a path the policy can't judge is left out
    return [...idx.rows.values()]
      .filter((r) => r.okOps > 0 && r.view.viewable !== 'protected' && this.isProtected(r.path) === false)
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((r) => r.path);
  }

  // ---------------------------------------------------------------- switch and queue

  private enable(): void {
    this.enabled = true;
    for (const sid of Object.keys(localSessions(this.ctx.store.getState()))) this.queueSession(sid);
  }

  private disable(): void {
    this.enabled = false;
    this.clearTimers();
    this.sessions.clear();
    for (const s of Object.values(localSessions(this.ctx.store.getState()))) {
      if (s.filesChanged === undefined) continue;
      this.emitSafe(s.sid, s.account, { patch: {}, unset: ['filesChanged'] });
    }
  }

  private clearTimers(): void {
    this.ctx.clock.clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.queue.length = 0;
    for (const t of [...this.timers.values(), ...this.retries.values()]) this.ctx.clock.clearTimeout(t);
    this.timers.clear();
    this.retries.clear();
  }

  /** A live session (an own key: the sessions map is a plain object, and "constructor" names Object.prototype's). v0.6: the Mac's own only. */
  private live(sid: string): Session | undefined {
    return localSession(this.ctx.store.getState(), sid);
  }

  private ensure(sid: string): Index {
    let idx = this.sessions.get(sid);
    if (idx) {
      this.sessions.delete(sid); // most recently used last
      this.sessions.set(sid, idx);
      return idx;
    }
    idx = {
      sid,
      tracks: new Map(),
      lastWalk: null,
      walkSoon: false,
      budget: this.opts.totalBytes,
      done: false,
      dirty: true,
      truncated: false,
      rows: new Map(),
      byId: new Map(),
      aliases: new Map(),
      keys: new Map(),
      opIds: new Set(),
      pending: new Map(),
      log: [],
      logHead: 0,
      bytes: 0,
      counted: 0,
      failures: 0,
    };
    this.sessions.set(sid, idx);
    for (const old of this.sessions.keys()) {
      if (this.sessions.size <= this.opts.maxSessions) break;
      if (old !== sid) this.drop(old);
    }
    return idx;
  }

  private drop(sid: string): void {
    this.sessions.delete(sid);
    const i = this.queue.indexOf(sid);
    if (i >= 0) this.queue.splice(i, 1);
    this.ctx.clock.clearTimeout(this.timers.get(sid));
    this.timers.delete(sid);
    this.ctx.clock.clearTimeout(this.retries.get(sid));
    this.retries.delete(sid);
  }

  private queueSession(sid: string, front = false): void {
    if (!this.enabled || !this.live(sid)) return;
    this.ensure(sid);
    const i = this.queue.indexOf(sid);
    if (i >= 0 && !front) return;
    if (i >= 0) this.queue.splice(i, 1);
    if (front) this.queue.unshift(sid);
    else this.queue.push(sid);
    this.schedulePump();
  }

  private nudge(sid: string, byAgent: boolean): void {
    if (!this.live(sid)) return;
    const idx = this.ensure(sid);
    idx.dirty = true;
    if (byAgent) idx.walkSoon = true;
    this.queueSession(sid);
  }

  private schedulePump(): void {
    if (this.pumpTimer !== undefined || !this.started || !this.queue.length) return;
    this.pumpTimer = this.ctx.clock.setTimeout(() => {
      this.pumpTimer = undefined;
      void this.exclusive(async () => {
        try {
          await this.pumpOnce();
        } finally {
          this.schedulePump();
        }
      });
    }, this.opts.tickMs);
  }

  /**
   * One tick for the session at the head of the queue; it goes to the back
   * while it has more to read. One whose read fails comes back after a pause.
   */
  private async pumpOnce(): Promise<void> {
    const sid = this.queue.shift();
    if (sid === undefined || !this.enabled) return;
    const idx = this.sessions.get(sid);
    if (!idx) return;
    try {
      await this.advance(idx, this.opts.tickBytes);
      idx.failures = 0;
    } catch (e) {
      idx.failures++;
      this.ctx.log.warn('changed files: read failed', { sid, error: String(e) });
      this.retryLater(sid, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** Math.min(idx.failures - 1, 16)));
      return;
    }
    if ((!idx.done || idx.dirty) && this.sessions.get(sid) === idx && !this.queue.includes(sid)) this.queue.push(sid);
  }

  private retryLater(sid: string, ms: number): void {
    if (!this.started || this.retries.has(sid)) return;
    this.retries.set(
      sid,
      this.ctx.clock.setTimeout(() => {
        this.retries.delete(sid);
        this.queueSession(sid);
      }, ms),
    );
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch((e: unknown) => this.ctx.log.warn('changed files: read failed', { error: String(e) }));
    return run;
  }

  // ---------------------------------------------------------------- reading

  /** Read up to `budget` new transcript bytes of one session (backfill first, then growth). */
  private async advance(idx: Index, budget: number): Promise<void> {
    if (!this.live(idx.sid)) return;
    await this.listTracks(idx);
    const now = this.ctx.clock.now();
    let left = budget;
    for (const t of idx.tracks.values()) {
      if (left <= 0) break;
      const sig = await fileSig(t.path);
      if (!sig) {
        if (t.byAgent) idx.tracks.delete(t.path); // a subagent transcript that is gone
        continue;
      }
      if (sig.size < t.offset) {
        // replaced or truncated: read it again (dedupe by opId keeps rows right)
        Object.assign(t, { offset: 0, start: 0, end: 0, scanner: new FileChangeScanner({ byAgent: t.byAgent }) });
      }
      while (left > 0 && t.offset < sig.size) {
        const from = t.offset;
        // 1 MiB reads: a longer line comes back skipped and the scanner reads its two ends
        const read = await this.deps.transcripts.readFrom(t.path, from, { maxBytes: LARGE_LINE_BYTES });
        if (read.next <= from) {
          t.end = Math.min(t.end, from); // an unfinished last line: the backfill ends before it
          break;
        }
        const ops = await t.scanner.scanRead(t.path, from, read.entries, read.next, now);
        t.offset = read.next;
        left -= read.next - from;
        await this.apply(idx, ops);
      }
    }
    if (left > 0) {
      idx.done = true;
      idx.dirty = false;
      await this.syncPending(idx);
    } else {
      idx.dirty = true;
    }
  }

  /** The session's transcripts: its main one, and (every 20 s, or 5 s after a subagent's event) its subagents'. */
  private async listTracks(idx: Index): Promise<void> {
    const s = this.live(idx.sid);
    if (!s) return;
    const hint: { cwd?: string; configDir?: string; transcriptPath?: string } = { cwd: s.cwd };
    if (s.configDir) hint.configDir = s.configDir;
    if (s.transcriptPath) hint.transcriptPath = s.transcriptPath;
    const main = await this.deps.transcripts.pathFor(idx.sid, hint);
    if (!main) return;
    const found: Array<{ path: string; byAgent: boolean }> = [{ path: main, byAgent: false }];
    const now = this.ctx.clock.now();
    if (idx.lastWalk === null || now - idx.lastWalk >= (idx.walkSoon ? WALK_SOON_MS : WALK_MS)) {
      idx.lastWalk = now;
      idx.walkSoon = false;
      // <projects>/<encoded cwd>/<sid>/subagents/agent-x.jsonl, workflows/...
      const newest = await jsonlUnder(posix.join(posix.dirname(main), idx.sid));
      await this.pruneTracks(idx, new Set(newest));
      for (const f of newest) found.push({ path: f, byAgent: true });
    }
    for (const f of found) {
      if (idx.tracks.has(f.path)) continue;
      const size = (await fileSig(f.path))?.size;
      if (size === undefined) continue;
      // what a file holds when first found is read within the session's budget, newest bytes first
      let start = 0;
      if (size > idx.budget) {
        start = await lineStartAtOrAfter(f.path, size - idx.budget, size);
        idx.truncated = true;
      }
      idx.budget -= size - start;
      // the backfill's progress counts the files found before it was done
      const end = idx.done ? start : size;
      idx.tracks.set(f.path, { path: f.path, byAgent: f.byAgent, scanner: new FileChangeScanner({ byAgent: f.byAgent }), offset: start, start, end });
    }
  }

  /**
   * Let go of subagent transcripts no longer among the newest SUBAGENT_FILES_MAX
   * once they are read to their end (or gone), as the watcher does: each one
   * costs a stat per read and a scanner.
   */
  private async pruneTracks(idx: Index, newest: ReadonlySet<string>): Promise<void> {
    for (const t of [...idx.tracks.values()]) {
      if (!t.byAgent || newest.has(t.path)) continue;
      const size = (await fileSig(t.path))?.size;
      if (size === undefined || (t.offset >= size && t.offset >= t.end)) idx.tracks.delete(t.path);
    }
  }

  // ---------------------------------------------------------------- the index

  private async apply(idx: Index, ops: readonly ScannedOp[]): Promise<void> {
    let added = false;
    for (const s of ops) {
      this.unpend(idx, s.opId);
      if (idx.opIds.has(s.opId)) continue;
      const op = toOp(s);
      const row = await this.place(idx, s.path, op, false);
      if (!row) continue;
      const kept = idx.opIds.size;
      remember(idx.opIds, s.opId, this.opts.maxOps);
      idx.bytes += (idx.opIds.size - kept) * ID_BYTES;
      idx.log.push([row, op]);
      idx.bytes += OP_BYTES;
      this.trim(idx);
      added = true;
    }
    if (!added) return;
    const n = [...idx.rows.values()].filter((r) => r.okOps > 0).length;
    if (n !== idx.counted) {
      idx.counted = n;
      this.scheduleCount(idx.sid);
    }
  }

  /**
   * Put an op in its file's row, made when new (within the caps): a finished
   * one into the row's sums, a pending one beside them. Null when the caps
   * say no. A new row is in the index only once it holds the op.
   */
  private async place(idx: Index, path: string, op: Op, pending: boolean): Promise<Row | null> {
    const key = await this.keyFor(idx, path);
    let row = idx.rows.get(key);
    if (!row) {
      const size = rowBytes(key);
      if (idx.rows.size < this.opts.maxPaths) this.trim(idx, size); // a new file is worth more than the oldest op details
      if (idx.rows.size >= this.opts.maxPaths || idx.bytes + size > this.opts.maxIndexBytes) {
        idx.truncated = true;
        return null;
      }
      const fresh: Row = {
        changeId: changeIdFor(idx.sid, key),
        path: key,
        firstAt: Number.POSITIVE_INFINITY,
        lastAt: Number.NEGATIVE_INFINITY,
        count: 0,
        ops: [],
        pending: [],
        tools: [],
        added: 0,
        removed: 0,
        okOps: 0,
        firstOk: null,
        last: op,
        view: { viewable: 'outside' },
        viewAt: Number.NEGATIVE_INFINITY,
      };
      await this.refreshView(fresh);
      row = idx.rows.get(key);
      if (!row) {
        row = fresh;
        idx.rows.set(key, row);
        idx.byId.set(row.changeId, row);
        idx.bytes += size;
      }
    }
    if (pending) row.pending.push(op);
    else addOp(row, op);
    const spelled = changeIdFor(idx.sid, path);
    if (spelled !== row.changeId && !idx.aliases.has(spelled) && idx.aliases.size < this.opts.maxPaths) {
      idx.aliases.set(spelled, row.changeId);
      idx.bytes += ALIAS_BYTES;
    }
    return row;
  }

  /**
   * Calls still waiting for their result become `pending` ops (a Write the
   * user hasn't approved yet); one that got its result, or never will (a new
   * prompt came), goes away. Only after a read that caught up.
   */
  private async syncPending(idx: Index): Promise<void> {
    const waiting = new Map<string, ScannedOp>();
    for (const t of idx.tracks.values()) for (const p of t.scanner.pendingOps()) waiting.set(p.opId, p);
    for (const id of [...idx.pending.keys()]) if (!waiting.has(id)) this.unpend(idx, id);
    for (const [id, p] of waiting) {
      if (idx.pending.has(id) || idx.opIds.has(id)) continue;
      const op = toOp(p);
      const row = await this.place(idx, p.path, op, true);
      if (row) idx.pending.set(id, { row, op });
    }
  }

  /** A pending op goes; a row that only ever had pending ops goes with it. */
  private unpend(idx: Index, opId: string): void {
    const ref = idx.pending.get(opId);
    if (!ref) return;
    idx.pending.delete(opId);
    const { row, op } = ref;
    const i = row.pending.indexOf(op);
    if (i >= 0) row.pending.splice(i, 1);
    if (row.count > 0 || row.pending.length > 0 || idx.rows.get(row.path) !== row) return;
    idx.rows.delete(row.path);
    idx.byId.delete(row.changeId);
    idx.bytes -= rowBytes(row.path);
  }

  /**
   * Drop the oldest op details past the caps (with room for `reserve` more
   * bytes). Rows keep their sums (a row's `ops` can then exceed the details
   * `change()` lists).
   */
  private trim(idx: Index, reserve = 0): void {
    while (idx.log.length - idx.logHead > this.opts.maxOps || idx.bytes + reserve > this.opts.maxIndexBytes) {
      const oldest = idx.log[idx.logHead];
      if (!oldest) break;
      idx.logHead++;
      const [row, op] = oldest;
      const i = row.ops.indexOf(op);
      if (i >= 0) row.ops.splice(i, 1);
      idx.bytes -= OP_BYTES;
    }
    if (idx.logHead > 4096) {
      idx.log.splice(0, idx.logHead);
      idx.logHead = 0;
    }
  }

  /**
   * The row key of a path: its realpath (or its dir's, when the file is
   * gone). A protected path, one outside every root, or one the policy can't
   * judge is never resolved: its key is its name, with macOS's /var, /tmp or
   * /etc spelled /private/..., so both spellings still make one row.
   */
  private async keyFor(idx: Index, lexical: string): Promise<string> {
    const hit = idx.keys.get(lexical);
    if (hit !== undefined) return hit;
    let key = privateSpelling(lexical);
    if (this.isProtected(lexical) === false && (await this.underRoot(lexical))) {
      try {
        key = await fsx.realpath(lexical);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          const named = key;
          key = await fsx.realpath(posix.dirname(lexical)).then(
            (dir) => posix.join(dir, posix.basename(lexical)),
            () => named,
          );
        }
      }
    }
    if (idx.keys.size < this.opts.maxPaths) {
      idx.keys.set(lexical, key);
      idx.bytes += KEY_BYTES + (lexical.length + key.length) * 2;
    }
    return key;
  }

  /** The policy's verdict; null when it can't say (then nothing is resolved or linked). */
  private isProtected(path: string): boolean | null {
    try {
      return this.deps.files.policy.isProtected(path);
    } catch {
      return null;
    }
  }

  /** Under a root by name (no disk access); false when the policy can't say (then nothing is resolved or linked). */
  private async underRoot(path: string): Promise<boolean> {
    try {
      return await this.deps.files.policy.underRoot(path);
    } catch {
      return false;
    }
  }

  private stale(row: Row): boolean {
    return this.ctx.clock.now() - row.viewAt >= this.opts.viewTtlMs;
  }

  private async refreshViews(rows: readonly Row[]): Promise<void> {
    for (const r of rows) if (this.stale(r)) await this.refreshView(r);
  }

  /** Where the viewer opens a row: protected, gone, outside every root, or rootId + rel. */
  private async refreshView(row: Row): Promise<void> {
    row.viewAt = this.ctx.clock.now();
    const prot = this.isProtected(row.path);
    if (prot !== false) {
      row.view = { viewable: prot ? 'protected' : 'outside' };
      return;
    }
    // Asked again each time: a session that starts in that folder later makes it viewable.
    if (!(await this.underRoot(row.path))) {
      row.view = { viewable: 'outside' };
      return;
    }
    try {
      const r = await this.deps.files.policy.locate(row.path);
      row.view = 'refused' in r ? { viewable: viewableFor(r.refused) } : { viewable: 'yes', rootId: r.rootId, rel: r.rel };
    } catch {
      row.view = { viewable: 'outside' };
    }
  }

  /** A row as the phone sees it: its finished ops' sums, and its pending calls by name, tool and time. */
  private toChange(sid: string, row: Row): FileChange {
    const last = latest(row);
    const tools = [...row.tools];
    for (const o of row.pending) if (!tools.includes(o.op.tool)) tools.push(o.op.tool);
    const c: FileChange = {
      changeId: row.changeId,
      sid,
      path: row.path,
      viewable: row.view.viewable,
      firstAt: new Date(Math.min(row.firstAt, last.atMs, ...row.pending.map((o) => o.atMs))).toISOString(),
      lastAt: new Date(last.atMs).toISOString(),
      ops: row.count + row.pending.length,
      tools,
      created: row.firstOk?.created ?? false,
      added: row.added,
      removed: row.removed,
      last: { status: last.op.status, tool: last.op.tool, at: last.op.at },
    };
    if (row.view.viewable === 'yes' && row.view.rootId !== undefined && row.view.rel !== undefined) {
      c.rootId = row.view.rootId;
      c.rel = row.view.rel;
    }
    return c;
  }

  // ---------------------------------------------------------------- filesChanged

  private scheduleCount(sid: string): void {
    if (!this.started || !this.enabled || this.timers.has(sid)) return;
    this.timers.set(
      sid,
      this.ctx.clock.setTimeout(() => {
        this.timers.delete(sid);
        this.publishCount(sid);
      }, this.opts.debounceMs),
    );
  }

  private publishCount(sid: string): void {
    const s = this.live(sid);
    const idx = this.sessions.get(sid);
    if (!this.enabled || !s || !idx) return;
    if (!idx.done) {
      this.scheduleCount(sid); // a part-read transcript would show too few files
      return;
    }
    const n = idx.counted;
    if (s.filesChanged === n || (n === 0 && s.filesChanged === undefined)) return;
    this.emitSafe(sid, s.account, { patch: { filesChanged: n } });
  }

  private emitSafe(sid: string, account: number | null, data: { patch: { filesChanged?: number }; unset?: ['filesChanged'] }): void {
    try {
      this.ctx.store.emit({ type: EVENT.SESSION_UPDATED, sid, ...(account !== null ? { account } : {}), data });
    } catch (e) {
      this.ctx.log.error('could not publish filesChanged', { sid, error: String(e) });
    }
  }
}

// ---------------------------------------------------------------------------

function toOp(s: ScannedOp): Op {
  return {
    op: {
      opId: s.opId,
      tool: s.tool,
      at: new Date(s.at).toISOString(),
      status: s.status,
      added: s.added,
      removed: s.removed,
      approx: s.approx,
      byAgent: s.byAgent,
      large: s.large,
    },
    atMs: s.at,
    created: s.created,
  };
}

function addOp(row: Row, o: Op): void {
  row.ops.push(o);
  row.count++;
  if (!row.tools.includes(o.op.tool)) row.tools.push(o.op.tool);
  row.firstAt = Math.min(row.firstAt, o.atMs);
  if (o.atMs >= row.lastAt) {
    row.lastAt = o.atMs;
    row.last = o;
  }
  if (o.op.status !== 'ok') return;
  row.okOps++;
  row.added += o.op.added ?? 0;
  row.removed += o.op.removed ?? 0;
  if (!row.firstOk || o.atMs < row.firstOk.at) row.firstOk = { at: o.atMs, created: o.op.tool === 'Write' && o.created === true };
}

/** The op a row shows as its latest: the newest finished or pending one. */
function latest(row: Row): Op {
  let last = row.count > 0 ? row.last : null;
  for (const o of row.pending) if (!last || o.atMs >= last.atMs) last = o;
  return last ?? row.last;
}

function rowBytes(key: string): number {
  return ROW_BYTES + key.length * 2;
}

function remember(set: Set<string>, id: string, max: number): void {
  set.add(id);
  if (set.size <= max) return;
  let drop = set.size - max / 2;
  for (const old of set) {
    if (drop-- <= 0) break;
    set.delete(old);
  }
}

function viewableFor(code: FileRefusalCode): Viewable {
  if (code === 'protected') return 'protected';
  if (code === 'missing' || code === 'not_file') return 'missing';
  return 'outside';
}

function scanOf(idx: Index): SessionChanges['scan'] {
  let bytes = 0;
  let total = 0;
  for (const t of idx.tracks.values()) {
    total += t.end - t.start;
    bytes += Math.min(Math.max(t.offset, t.start), t.end) - t.start;
  }
  return { done: idx.done, bytes, total };
}

/** `.jsonl` files under `dir` (3 levels deep), newest first, at most SUBAGENT_FILES_MAX. */
async function jsonlUnder(dir: string): Promise<string[]> {
  const out: { path: string; mtime: number }[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 3 || out.length >= 200) return;
    for (const e of await listDir(d)) {
      const p = posix.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const sig = await fileSig(p);
        if (sig) out.push({ path: p, mtime: sig.mtimeMs });
      }
      if (out.length >= 200) return;
    }
  };
  await walk(dir, 0);
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SUBAGENT_FILES_MAX)
    .map((x) => x.path);
}
