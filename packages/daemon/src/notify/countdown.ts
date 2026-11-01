/**
 * v0.5.3: Claude's 2-minute auto-block countdown as one urgent push (spec 1.3).
 *
 * Claude Code draws `⚠ Claude Code will automatically block this request in
 * 1:33 …` in an unattended agent's ask (a workflow's or a subagent's). Hooks
 * can't answer that ask: its card is subagent info, never pushed. The router
 * calls `check(sid, since)` when such an ask may be on screen:
 *
 * - a subagent-info card opens (since: its createdAt);
 * - a session Claude says is waiting, with no card, after the settle delay
 *   (since: its statusSince); its plain waiting push waits for the answer.
 *
 * Both may fire for the same ask; they share one probe.
 *
 * The probe (`createCountdownProbe`) only reads: the session's tab through
 * the shared PaneFinder (the API's PaneLookup: its cache and its time
 * limit), one 60-line screen read, and the dialog parser's `blocksIn` and
 * fingerprint. It never types and takes no writer lock (a read like GET
 * /screen), and the screen text never leaves it: not logged, kept or sent.
 *
 * Rules (CountdownWatch):
 * - A probe runs no earlier than URGENT_DRAW_MS after `since` (Claude has
 *   drawn the dialog), and at most once per session per
 *   URGENT_PROBE_GAP_MS: a trigger inside that window takes the last
 *   probe's answer, awaiting it while it runs.
 * - One episode per ask: `<sid>:<fingerprint>` (the fingerprint leaves the
 *   ticking time out, so it holds while the ask is open). A countdown with
 *   at least URGENT_MIN_S left and no episode for it starts one: deadline =
 *   read time + (left - 1) s (the dock's margin), one urgent push and, with
 *   more than URGENT_REPEAT_AT_S + 15 s left, one repeat timer at
 *   URGENT_REPEAT_AT_S left. Under URGENT_MIN_S nothing: it could not be
 *   answered in time.
 * - The repeat probes again, and the probe is the truth: the same
 *   fingerprint still showing with at least URGENT_MIN_S left pushes once
 *   more; anything else (answered, another ask, no countdown, the session
 *   gone) nothing. Never a third push.
 * - `open(sid)`: an episode of the session whose deadline is ahead and whose
 *   ask the last screen read still showed. The router then sends no waiting
 *   push: the urgent one covers the ask. A read showing another ask, or no
 *   countdown, closes it, so an answered ask never hides the next one's
 *   waiting push; its key stays until the deadline, so the same ask is
 *   never pushed as new twice.
 * - Episodes end at their deadline, on session.removed (`drop`) and on
 *   `stop()`.
 */
import { DIALOG_GATES, URGENT_MIN_S, URGENT_REPEAT_AT_S, countdownSeconds } from '@jantar/protocol';
import type { Clock, DaemonContext, PaneFinder, TerminalBackend, TimerId } from '../contracts.js';
import { dialogOfScreen } from '../terminal/dialog.js';

/** Two triggers this close together share one probe (and one screen read). */
export const URGENT_PROBE_GAP_MS = 10_000;
/** A probe waits until this long after the ask began, so Claude has drawn its dialog. */
export const URGENT_DRAW_MS = 1_500;
/** The repeat is set only with more than this many seconds left past URGENT_REPEAT_AT_S. */
export const URGENT_REPEAT_ROOM_S = 15;
/** Lines a probe reads: the dialog parser's 60, as GET /screen reads. */
export const PROBE_LINES = 60;

/** Seconds left on Claude's countdown at `at` (ms), and the ask's dialog fingerprint. */
export interface CountdownRead {
  left: number;
  at: number;
  fingerprint: string;
}

/** A countdown; 'none' when the screen was read and shows none; null when it could not be read. */
export type CountdownAnswer = CountdownRead | 'none' | null;

export type CountdownProbe = (sid: string) => Promise<CountdownAnswer>;

/** An error's name and code, never its message (it could quote the screen). */
function errorKind(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? `${e.name} ${code}` : e.name;
}

/** One read of a session's screen for Claude's countdown; never types, never logs what it read. */
export function createCountdownProbe(ctx: Pick<DaemonContext, 'store' | 'clock' | 'log'>, deps: { panes: PaneFinder; terminal: TerminalBackend }): CountdownProbe {
  return async (sid) => {
    try {
      const sessions = ctx.store.getState().sessions;
      const session = Object.hasOwn(sessions, sid) ? sessions[sid] : undefined;
      if (!session || session.status === 'ended') return null;
      const pane = await deps.panes.find(session);
      if (pane === null || pane === 'timeout') return null;
      const r = await deps.terminal.readScreen(pane, { lines: PROBE_LINES });
      if (!r.ok) return null;
      const dialog = dialogOfScreen(r.raw ?? r.text, DIALOG_GATES).dialog;
      const left = dialog?.blocksIn === undefined ? null : countdownSeconds(dialog.blocksIn);
      return dialog && left !== null ? { left, at: ctx.clock.now(), fingerprint: dialog.fingerprint } : 'none';
    } catch (e) {
      ctx.log.warn('countdown probe failed', { sid, error: errorKind(e) });
      return null;
    }
  };
}

/** One urgent push to send: seconds left now, the ask's deadline (ISO), and whether it is the repeat. */
export interface UrgentPush {
  sid: string;
  left: number;
  deadline: string;
  repeat: boolean;
}

export interface CountdownWatchDeps {
  clock: Clock;
  probe: CountdownProbe;
  /** notify.urgent, asked before every probe. */
  enabled: () => boolean;
  push: (u: UrgentPush) => void;
  /** Async work in flight (the router's whenIdle and stop wait for it). */
  track: (p: Promise<unknown>) => void;
}

interface Episode {
  sid: string;
  fingerprint: string;
  deadline: number;
  /** The last read of the session showed this ask. */
  live: boolean;
  timers: TimerId[];
}

/** Seconds left now on a countdown read at `read.at`. */
function leftAt(read: CountdownRead, now: number): number {
  return Math.floor(read.left - Math.max(0, now - read.at) / 1000);
}

export class CountdownWatch {
  private readonly reads = new Map<string, { at: number; answer: Promise<CountdownAnswer> }>();
  private readonly episodes = new Map<string, Episode>();
  private readonly timers = new Set<TimerId>();
  private stopped = false;

  constructor(private readonly deps: CountdownWatchDeps) {}

  /**
   * Look for Claude's countdown on `sid`'s screen once the ask that began at
   * `since` is drawn; then `then(open(sid))`. With notify.urgent off nothing
   * is read and `then(false)`.
   */
  check(sid: string, since: string, then?: (open: boolean) => void): void {
    if (this.stopped) return;
    const wait = Date.parse(since) + URGENT_DRAW_MS - this.deps.clock.now();
    if (wait > 0) {
      this.later(wait, () => this.check(sid, since, then));
      return;
    }
    if (!this.deps.enabled()) {
      then?.(false);
      return;
    }
    this.deps.track(
      (async () => {
        const read = await this.read(sid);
        if (this.stopped) return;
        this.consider(sid, read);
        then?.(this.open(sid));
      })(),
    );
  }

  /** Whether `sid` has an ask with Claude's countdown running that its last screen read still showed. */
  open(sid: string): boolean {
    const now = this.deps.clock.now();
    for (const ep of this.episodes.values()) if (ep.sid === sid && ep.live && ep.deadline > now) return true;
    return false;
  }

  /** session.removed: its episodes, their timers and its last read go. */
  drop(sid: string): void {
    for (const [key, ep] of [...this.episodes]) if (ep.sid === sid) this.end(key);
    this.reads.delete(sid);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) this.deps.clock.clearTimeout(t);
    this.timers.clear();
    this.episodes.clear();
    this.reads.clear();
  }

  /** The last probe's answer when it started under URGENT_PROBE_GAP_MS ago (running or not); else a new probe. */
  private read(sid: string): Promise<CountdownAnswer> {
    const now = this.deps.clock.now();
    const last = this.reads.get(sid);
    if (last && now - last.at < URGENT_PROBE_GAP_MS) return last.answer;
    const answer = this.deps.probe(sid);
    this.reads.set(sid, { at: now, answer });
    return answer;
  }

  /** What a read means for `sid`'s episodes; a new ask with time to answer starts one and pushes. */
  private consider(sid: string, read: CountdownAnswer): void {
    if (read === null) return; // nothing was read: nothing changes
    const shown = read === 'none' ? null : read.fingerprint;
    for (const ep of this.episodes.values()) if (ep.sid === sid) ep.live = ep.fingerprint === shown;
    if (read === 'none') return;
    const key = `${sid}:${read.fingerprint}`;
    const now = this.deps.clock.now();
    const left = leftAt(read, now);
    if (this.episodes.has(key) || left < URGENT_MIN_S) return;
    const deadline = read.at + (read.left - 1) * 1000;
    const ep: Episode = { sid, fingerprint: read.fingerprint, deadline, live: true, timers: [] };
    this.episodes.set(key, ep);
    ep.timers.push(this.later(deadline - now, () => this.end(key)));
    if (left > URGENT_REPEAT_AT_S + URGENT_REPEAT_ROOM_S) ep.timers.push(this.later(deadline - URGENT_REPEAT_AT_S * 1000 - now, () => this.repeat(key)));
    this.deps.push({ sid, left, deadline: new Date(deadline).toISOString(), repeat: false });
  }

  /** The one repeat: only while the same ask still shows with time to answer it. */
  private repeat(key: string): void {
    const ep = this.episodes.get(key);
    if (!ep || this.stopped || !this.deps.enabled()) return;
    this.deps.track(
      (async () => {
        const read = await this.read(ep.sid);
        if (this.stopped || this.episodes.get(key) !== ep) return;
        this.consider(ep.sid, read);
        if (read === null || read === 'none' || read.fingerprint !== ep.fingerprint) return;
        const left = leftAt(read, this.deps.clock.now());
        if (left >= URGENT_MIN_S) this.deps.push({ sid: ep.sid, left, deadline: new Date(ep.deadline).toISOString(), repeat: true });
      })(),
    );
  }

  private end(key: string): void {
    const ep = this.episodes.get(key);
    if (!ep) return;
    for (const t of ep.timers) {
      this.deps.clock.clearTimeout(t);
      this.timers.delete(t);
    }
    this.episodes.delete(key);
  }

  private later(ms: number, fn: () => void): TimerId {
    const t = this.deps.clock.setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }
}
