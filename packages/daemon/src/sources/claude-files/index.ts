/**
 * sources/claude-files: live Claude Code sessions on every account.
 *
 * Ported from ccw's discovery (read_sessions / same_process / owner), with
 * these fixes:
 * - pid reuse is checked with `ps` run with LC_ALL=C and TZ=UTC, batched into
 *   one call per scan and cached per pid (ccw: one call per pid, locale-bound);
 * - the account of a session on ~/.claude (the default login) is fixed when
 *   the session is first seen, so a later `cswap switch` does not relabel it;
 * - a session file caught mid-write keeps its last good copy instead of
 *   blinking out;
 * - files are re-read only when their size, mtime or inode changed.
 *
 * With one Claude login (accountsMode "single", spec 4.11) every session is
 * account 0, whatever config dir it runs under, and nothing is pinned.
 *
 * Sessions are watched with FSEvents (fs.watch) plus a 2 s poll, which also
 * catches crashed processes (no file event when a pid dies).
 */
import { EVENT, folderOf, type AccountId, type Session, type SessionOptionalKey, type SessionPatch } from '@jantar/protocol';
import type { DaemonContext, Factories, SessionRecord, SessionSource, TimerId, Unsubscribe } from '../../contracts.js';
import { cLocale } from '../../core/exec.js';
import { initialStatus, mapRawStatus, mergeStatus, type StatusObservation } from '../../core/status.js';
import { SINGLE_ACCOUNT } from '../../rewrite/account.js';
import { SequenceReader, accountForProfileDir, classifyConfigDir, type SequenceInfo } from '../lib/cswap-files.js';
import { DirWatcher } from '../lib/dir-watch.js';
import { fileSig, fsx } from '../lib/fsx.js';
import { parsePsRows, sameProcessStart, type PsRow } from '../lib/lstart.js';
import { Serial } from '../lib/serial.js';
import { toIso } from '../lib/values.js';
import {
  isHeadless,
  listConfigDirs,
  listSessionFiles,
  parseSessionFile,
  watchDirsFor,
  type ConfigDirs,
  type ParsedSessionFile,
  type SessionFileRef,
} from './discover.js';

export interface ClaudeFilesOptions {
  /** Poll interval (default 2000 ms). */
  pollMs?: number;
  /** Also react to FS events (default true). */
  watch?: boolean;
  /** FS event debounce (default 150 ms). */
  debounceMs?: number;
  /** How long a pid's `ps` start time is trusted (default 60 s, as ccw). */
  psCacheMs?: number;
  /** A session file caught mid-write is read again this soon (default 250 ms), not at the next poll. */
  retryMs?: number;
  psTimeoutMs?: number;
  /**
   * A session-file "waiting" waits this long before `session.waiting` is
   * emitted, so a hook-driven card for the same moment wins (default 1500 ms).
   */
  waitingSettleMs?: number;
}

/** kv key: default-login sessions' fixed accounts, `<sid>|<pid>` -> account. */
export const PINNED_KV_KEY = 'sources.claude-files.pinned-accounts';
const PINNED_CAP = 1000;
const MAX_SESSION_FILE_BYTES = 1024 * 1024;

type DropReason = 'sdk-cli' | 'pid-gone' | 'pid-reused';

interface Candidate {
  ref: SessionFileRef;
  file: ParsedSessionFile;
  tty?: string;
}

interface CachedFile {
  sig: string;
  parsed: ParsedSessionFile | null;
}

interface PsCached {
  at: number;
  row: PsRow;
}

export class ClaudeFilesSource implements SessionSource {
  private records: SessionRecord[] = [];
  private readonly ttys = new Map<string, string>();
  private readonly fileCache = new Map<string, CachedFile>();
  /** Signature of each file's last unparseable content (retried once per new content, not forever). */
  private readonly badSigs = new Map<string, string>();
  private readonly psCache = new Map<number, PsCached>();
  /** What we last told the store, per sid. */
  private readonly emitted = new Map<string, SessionRecord>();
  private readonly sequence: SequenceReader;
  private pinned = new Map<string, AccountId>();
  private dirs: ConfigDirs | null = null;
  private started = false;
  private timer: TimerId | undefined;
  private watcher: DirWatcher | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private readonly waitTimers = new Map<string, TimerId>();
  /** Bumped on every session.waiting / pending.opened per sid (someone else spoke first). */
  private readonly waitMarks = new Map<string, number>();
  private psWarnedAt = 0;
  private retryWanted = false;
  private retryTimer: TimerId | undefined;
  private readonly serial: Serial<SessionRecord[]>;
  private readonly opts: Required<ClaudeFilesOptions>;

  constructor(
    private readonly ctx: DaemonContext,
    opts: ClaudeFilesOptions = {},
  ) {
    this.opts = {
      pollMs: opts.pollMs ?? 2000,
      watch: opts.watch ?? true,
      debounceMs: opts.debounceMs ?? 150,
      psCacheMs: opts.psCacheMs ?? 60_000,
      retryMs: opts.retryMs ?? 250,
      psTimeoutMs: opts.psTimeoutMs ?? 5000,
      waitingSettleMs: opts.waitingSettleMs ?? 1500,
    };
    this.sequence = new SequenceReader(ctx.paths.cswapSequence);
    this.serial = new Serial(() => this.runScan());
    this.loadPinned();
  }

  // ---------------------------------------------------------------- Service

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.ctx.store.subscribe((ev) => {
      if ((ev.type === EVENT.SESSION_WAITING || ev.type === EVENT.PENDING_OPENED) && ev.sid) {
        this.waitMarks.set(ev.sid, (this.waitMarks.get(ev.sid) ?? 0) + 1);
      }
    });
    await this.scan();
    if (!this.started) return;
    if (this.opts.watch) {
      this.watcher = new DirWatcher(() => void this.scan().catch(() => undefined), {
        clock: this.ctx.clock,
        log: this.ctx.log,
        debounceMs: this.opts.debounceMs,
      });
      this.updateWatches();
    }
    this.timer = this.ctx.clock.setInterval(() => {
      this.scan().catch((e) => this.ctx.log.error('session scan failed', { error: String(e) }));
    }, this.opts.pollMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ctx.clock.clearInterval(this.timer);
    this.timer = undefined;
    this.ctx.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.waitTimers.values()) this.ctx.clock.clearTimeout(t);
    this.waitTimers.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.serial.idle();
  }

  // ---------------------------------------------------------------- SessionSource

  scan(): Promise<SessionRecord[]> {
    return this.serial.run();
  }

  current(): readonly SessionRecord[] {
    return this.records;
  }

  accountForConfigDir(configDir: string): AccountId | null {
    if (!configDir) return null;
    if (this.ctx.accountsMode() === 'single') return SINGLE_ACCOUNT;
    const seq = this.sequence.last;
    const c = classifyConfigDir(configDir, this.ctx.paths);
    if (c.kind === 'default-login') return seq?.active ?? null;
    if (c.kind === 'profile') return accountForProfileDir(c.name, seq);
    return null;
  }

  /** The tty `ps` reported for a session's process (for the terminal backend). */
  ttyFor(sid: string): string | undefined {
    return this.ttys.get(sid);
  }

  // ---------------------------------------------------------------- scanning

  private async runScan(): Promise<SessionRecord[]> {
    this.retryWanted = false;
    const { records, reasons } = await this.discover();
    this.records = records;
    if (this.started) {
      this.sync(records, reasons);
      this.updateWatches();
      if (this.retryWanted && this.retryTimer === undefined) {
        // a file was caught mid-write and its last FS event may already be spent
        this.retryTimer = this.ctx.clock.setTimeout(() => {
          this.retryTimer = undefined;
          if (this.started) void this.scan().catch(() => undefined);
        }, this.opts.retryMs);
      }
    }
    return records;
  }

  private async discover(): Promise<{ records: SessionRecord[]; reasons: Map<string, DropReason> }> {
    const seq = await this.sequence.read();
    const dirs = await listConfigDirs(this.ctx.paths);
    this.dirs = dirs;
    const refs = await listSessionFiles(dirs.configDirs);

    const present = new Set<string>();
    const parsed: Candidate[] = [];
    for (const ref of refs) {
      present.add(ref.file);
      const file = await this.readSessionFile(ref.file);
      if (file) parsed.push({ ref, file });
    }
    for (const f of [...this.fileCache.keys()]) if (!present.has(f)) this.fileCache.delete(f);
    for (const f of [...this.badSigs.keys()]) if (!present.has(f)) this.badSigs.delete(f);

    const reasons = new Map<string, DropReason>();
    const alive: Candidate[] = [];
    for (const c of parsed) {
      if (isHeadless(c.file.entrypoint)) {
        reasons.set(c.file.sid, 'sdk-cli');
      } else if (!this.ctx.proc.isAlive(c.file.pid)) {
        this.psCache.delete(c.file.pid);
        reasons.set(c.file.sid, 'pid-gone');
      } else {
        alive.push(c);
      }
    }

    const ps = await this.processInfo(alive.map((c) => c.file.pid));
    const live: Candidate[] = [];
    for (const c of alive) {
      const info = ps.get(c.file.pid);
      if (info === null) {
        reasons.set(c.file.sid, 'pid-gone'); // exited between the kill(0) check and ps
        continue;
      }
      if (info && info.startMs !== null && !sameProcessStart(c.file.procStart, info.startMs)) {
        reasons.set(c.file.sid, 'pid-reused');
        continue;
      }
      live.push(info?.tty ? { ...c, tty: info.tty } : c);
    }

    // one record per sid: the most recently updated file wins (a stale copy can linger after a move)
    const bySid = new Map<string, Candidate>();
    for (const c of live) {
      const prev = bySid.get(c.file.sid);
      if (!prev || freshness(c) > freshness(prev) || (freshness(c) === freshness(prev) && c.ref.file < prev.ref.file)) {
        bySid.set(c.file.sid, c);
      }
    }

    const records: SessionRecord[] = [];
    for (const c of bySid.values()) {
      records.push(this.toRecord(c, seq));
      if (c.tty) this.ttys.set(c.file.sid, c.tty);
      reasons.delete(c.file.sid);
    }
    records.sort((a, b) => a.sid.localeCompare(b.sid));
    return { records, reasons };
  }

  private async readSessionFile(path: string): Promise<ParsedSessionFile | null> {
    const sig = await fileSig(path);
    const cached = this.fileCache.get(path);
    if (!sig) return cached?.parsed ?? null;
    if (cached && cached.sig === sig.sig) return cached.parsed;
    if (sig.size > MAX_SESSION_FILE_BYTES) {
      this.fileCache.set(path, { sig: sig.sig, parsed: null });
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await fsx.readText(path));
    } catch {
      // half-written (Claude rewrites these in place) or vanished: keep the last good copy, retry soon
      if (this.badSigs.get(path) !== sig.sig) {
        this.badSigs.set(path, sig.sig);
        this.retryWanted = true;
      }
      return cached?.parsed ?? null;
    }
    this.badSigs.delete(path);
    const parsed = parseSessionFile(raw);
    this.fileCache.set(path, { sig: sig.sig, parsed });
    return parsed;
  }

  /**
   * `ps` facts per pid: a row, null (ps ran and the pid is gone) or
   * undefined (ps could not run: liveness then rests on kill(0) alone).
   */
  private async processInfo(pids: readonly number[]): Promise<Map<number, PsRow | null | undefined>> {
    const out = new Map<number, PsRow | null | undefined>();
    const now = this.ctx.clock.now();
    const ask: number[] = [];
    const wanted = new Set(pids);
    for (const pid of [...this.psCache.keys()]) if (!wanted.has(pid)) this.psCache.delete(pid);
    for (const pid of wanted) {
      const hit = this.psCache.get(pid);
      if (hit && now - hit.at < this.opts.psCacheMs) out.set(pid, hit.row);
      else ask.push(pid);
    }
    if (!ask.length) return out;
    const res = await this.ctx.exec(this.ctx.bins.ps, ['-o', 'pid=,tty=,lstart=', '-p', ask.join(',')], {
      env: { ...cLocale(this.ctx.env), TZ: 'UTC' },
      timeoutMs: this.opts.psTimeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const ran = !res.spawnError && !res.timedOut && (res.code === 0 || res.code === 1);
    if (!ran) {
      if (now - this.psWarnedAt > 60_000) {
        this.psWarnedAt = now;
        this.ctx.log.warn('ps failed; pid reuse is not checked this pass', {
          code: res.code,
          timedOut: res.timedOut,
          spawnError: res.spawnError,
        });
      }
      for (const pid of ask) out.set(pid, undefined);
      return out;
    }
    const rows = new Map(parsePsRows(res.stdout).map((r) => [r.pid, r]));
    for (const pid of ask) {
      const row = rows.get(pid);
      if (row) {
        this.psCache.set(pid, { at: now, row });
        out.set(pid, row);
      } else {
        this.psCache.delete(pid);
        out.set(pid, null);
      }
    }
    return out;
  }

  private toRecord(c: Candidate, seq: SequenceInfo | null): SessionRecord {
    const f = c.file;
    const rec: SessionRecord = {
      sid: f.sid,
      pid: f.pid,
      procStart: f.procStart,
      configDir: c.ref.configDir,
      account: this.accountOf(c.ref.configDir, f.sid, f.pid, seq),
      cwd: f.cwd,
      entrypoint: f.entrypoint,
      rawStatus: f.rawStatus,
      file: c.ref.file,
    };
    if (f.version) rec.version = f.version;
    if (f.name) rec.name = f.name;
    if (f.kind) rec.kind = f.kind;
    if (f.waitingFor) rec.waitingFor = f.waitingFor;
    if (f.statusUpdatedAt !== undefined) rec.statusUpdatedAt = f.statusUpdatedAt;
    if (f.updatedAt !== undefined) rec.updatedAt = f.updatedAt;
    if (f.startedAt !== undefined) rec.startedAt = f.startedAt;
    return rec;
  }

  /**
   * Profiles map by directory name; the default login is pinned to the account active when first seen.
   * One Claude login: every session is account 0.
   */
  private accountOf(configDir: string, sid: string, pid: number, seq: SequenceInfo | null): AccountId | null {
    if (this.ctx.accountsMode() === 'single') return SINGLE_ACCOUNT;
    const c = classifyConfigDir(configDir, this.ctx.paths);
    if (c.kind === 'profile') return accountForProfileDir(c.name, seq);
    if (c.kind !== 'default-login') return null;
    const key = `${sid}|${pid}`;
    const pinned = this.pinned.get(key);
    if (pinned !== undefined) return pinned;
    const active = seq?.active ?? null;
    if (active !== null) {
      this.pinned.set(key, active);
      this.savePinned();
    }
    return active;
  }

  // ---------------------------------------------------------------- events

  private sync(records: readonly SessionRecord[], reasons: ReadonlyMap<string, DropReason>): void {
    const seen = new Set<string>();
    for (const r of records) {
      seen.add(r.sid);
      try {
        const cur = this.ctx.store.getState().sessions[r.sid];
        if (cur) this.emitUpdated(cur, r, this.emitted.get(r.sid));
        else this.emitAdded(r);
        this.emitted.set(r.sid, r);
      } catch (e) {
        this.ctx.log.error('could not publish session', { sid: r.sid, error: String(e) });
      }
    }
    for (const [sid, prev] of [...this.emitted]) {
      if (seen.has(sid)) continue;
      this.emitted.delete(sid);
      this.ttys.delete(sid);
      this.clearWaiting(sid);
      this.unpin(sid, prev.pid);
      if (!this.ctx.store.getState().sessions[sid]) continue;
      try {
        this.ctx.store.emit({
          type: EVENT.SESSION_REMOVED,
          sid,
          ...(prev.account !== null ? { account: prev.account } : {}),
          data: { reason: reasons.get(sid) ?? 'file-removed' },
        });
      } catch (e) {
        this.ctx.log.error('could not publish session removal', { sid, error: String(e) });
      }
    }
  }

  private observation(r: SessionRecord, prev: SessionRecord | undefined): StatusObservation | null {
    const changed =
      !prev ||
      prev.rawStatus !== r.rawStatus ||
      prev.waitingFor !== r.waitingFor ||
      prev.statusUpdatedAt !== r.statusUpdatedAt;
    if (!changed) return null;
    const now = this.ctx.clock.now();
    const at = r.statusUpdatedAt ?? (prev ? now : (r.updatedAt ?? r.startedAt ?? now));
    const obs: StatusObservation = { status: mapRawStatus(r.rawStatus), source: 'session-file', at };
    if (r.waitingFor) obs.waitingFor = r.waitingFor;
    return obs;
  }

  private emitAdded(r: SessionRecord): void {
    const obs = this.observation(r, undefined) as StatusObservation;
    const session: Session = {
      sid: r.sid,
      pid: r.pid,
      procStart: r.procStart,
      account: r.account,
      configDir: r.configDir,
      cwd: r.cwd,
      folder: folderOf(r.cwd),
      entrypoint: r.entrypoint,
      ...initialStatus(obs),
      subagentsRunning: 0,
    };
    if (r.version) session.version = r.version;
    if (r.name) session.name = r.name;
    if (r.kind) session.kind = r.kind;
    const tty = this.ttys.get(r.sid);
    if (tty) session.tty = tty;
    const startedAt = toIso(r.startedAt);
    if (startedAt) session.startedAt = startedAt;
    // a ccw move published before the session was (ccw-legacy starts first)
    const move = this.ctx.store.getState().moves[r.sid];
    if (move) session.move = move;
    this.ctx.store.emit({
      type: EVENT.SESSION_ADDED,
      sid: r.sid,
      ...(r.account !== null ? { account: r.account } : {}),
      data: { session },
    });
  }

  private emitUpdated(cur: Session, r: SessionRecord, prev: SessionRecord | undefined): void {
    const patch: SessionPatch = {};
    const unset: SessionOptionalKey[] = [];
    if (cur.pid !== r.pid) patch.pid = r.pid;
    if (cur.procStart !== r.procStart) patch.procStart = r.procStart;
    if (cur.configDir !== r.configDir) patch.configDir = r.configDir;
    if (cur.account !== r.account) patch.account = r.account;
    if (cur.cwd !== r.cwd) {
      patch.cwd = r.cwd;
      patch.folder = folderOf(r.cwd);
    }
    if (cur.entrypoint !== r.entrypoint) patch.entrypoint = r.entrypoint;
    for (const key of ['version', 'name', 'kind'] as const) {
      const next = r[key];
      if (next !== undefined) {
        if (cur[key] !== next) patch[key] = next;
      } else if (cur[key] !== undefined && prev?.[key] !== undefined) {
        unset.push(key);
      }
    }
    const startedAt = toIso(r.startedAt);
    if (startedAt && cur.startedAt !== startedAt) patch.startedAt = startedAt;
    const tty = this.ttys.get(r.sid);
    if (tty && cur.tty !== tty) patch.tty = tty;

    const obs = this.observation(r, prev);
    const change = obs ? mergeStatus(cur, obs) : null;
    if (change) {
      Object.assign(patch, change.patch);
      unset.push(...change.unset);
    }
    if (!Object.keys(patch).length && !unset.length) return;
    this.ctx.store.emit({
      type: EVENT.SESSION_UPDATED,
      sid: r.sid,
      ...(r.account !== null ? { account: r.account } : {}),
      data: unset.length ? { patch, unset } : { patch },
    });
    if (patch.status === 'waiting' && patch.statusSource === 'session-file') this.scheduleWaiting(r.sid);
    else if (patch.status && patch.status !== 'waiting') this.clearWaiting(r.sid);
  }

  /**
   * Without hooks, a session-file "waiting" is the only sign a session needs
   * the user. Emit `session.waiting` after a short settle, unless a hook card
   * (or anyone else's session.waiting) came first or it stopped waiting.
   */
  private scheduleWaiting(sid: string): void {
    this.clearWaiting(sid);
    const mark = this.waitMarks.get(sid) ?? 0;
    const t = this.ctx.clock.setTimeout(() => {
      this.waitTimers.delete(sid);
      if (!this.started) return;
      const state = this.ctx.store.getState();
      const s = state.sessions[sid];
      if (!s || s.status !== 'waiting' || s.statusSource === 'hook') return;
      if ((this.waitMarks.get(sid) ?? 0) !== mark) return;
      if (Object.values(state.pending).some((p) => p.sid === sid && p.state === 'open')) return;
      try {
        this.ctx.store.emit({
          type: EVENT.SESSION_WAITING,
          sid,
          ...(s.account !== null ? { account: s.account } : {}),
          data: s.waitingFor ? { waitingFor: s.waitingFor } : {},
        });
      } catch (e) {
        this.ctx.log.error('could not publish session.waiting', { sid, error: String(e) });
      }
    }, this.opts.waitingSettleMs);
    this.waitTimers.set(sid, t);
  }

  private clearWaiting(sid: string): void {
    const t = this.waitTimers.get(sid);
    if (t !== undefined) this.ctx.clock.clearTimeout(t);
    this.waitTimers.delete(sid);
  }

  // ---------------------------------------------------------------- helpers

  private updateWatches(): void {
    if (this.watcher && this.dirs) this.watcher.setDirs(watchDirsFor(this.ctx.paths, this.dirs).filter((d) => fsx.existsSync(d)));
  }

  private loadPinned(): void {
    try {
      const raw = this.ctx.db.kv.get<Record<string, unknown>>(PINNED_KV_KEY);
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) if (Number.isInteger(v) && (v as number) >= 0) this.pinned.set(k, v as number);
      }
    } catch (e) {
      this.ctx.log.warn('could not load pinned accounts', { error: String(e) });
    }
  }

  private savePinned(): void {
    if (this.pinned.size > PINNED_CAP) {
      const keep = [...this.pinned].slice(-PINNED_CAP);
      this.pinned = new Map(keep);
    }
    try {
      this.ctx.db.kv.set(PINNED_KV_KEY, Object.fromEntries(this.pinned));
    } catch (e) {
      this.ctx.log.warn('could not save pinned accounts', { error: String(e) });
    }
  }

  private unpin(sid: string, pid: number): void {
    if (this.pinned.delete(`${sid}|${pid}`)) this.savePinned();
  }
}

function freshness(c: Candidate): number {
  return c.file.statusUpdatedAt ?? c.file.updatedAt ?? c.file.startedAt ?? 0;
}

/** Factories['sessions']: the SessionSource. */
export const createSessionSource: Factories['sessions'] = (ctx) => new ClaudeFilesSource(ctx);

/** Same, with options (tests, tuning). */
export function createClaudeFilesSource(ctx: DaemonContext, opts: ClaudeFilesOptions = {}): ClaudeFilesSource {
  return new ClaudeFilesSource(ctx, opts);
}

export { listConfigDirs, listSessionFiles, parseSessionFile, isHeadless } from './discover.js';
