/**
 * v0.5.3: Claude's 2-minute auto-block countdown as one urgent push (spec 1.3).
 *
 * Claude Code draws `⚠ Claude Code will automatically block this request in
 * 1:33 …` in an unattended agent's ask (a workflow's or a subagent's). Hooks
 * can't answer that ask: its card is subagent info, never pushed. The router
 * calls `check(sid, since)` when such an ask may be on screen:
 *
 * - a subagent-info card opens (since: its createdAt); a read that failed is
 *   tried once more while the card is open;
 * - a session Claude says is waiting, with no card, after the settle delay
 *   (since: its statusSince); its plain waiting push waits for the answer.
 *
 * Both may fire for the same ask; they share one probe.
 *
 * The probe (`createCountdownProbe`) only reads: the session's tab through
 * the shared PaneFinder (the API's PaneLookup: its cache and its time
 * limit), one 60-line screen read, and the dialog parser's `blocksIn`. It
 * never types and takes no writer lock (a read like GET /screen), and the
 * screen text never leaves it: not logged, kept or sent. Its `at` is taken
 * before the read, so a slow read errs early on the deadline.
 *
 * Rules (CountdownWatch):
 * - A probe runs no earlier than URGENT_DRAW_MS after `since` (Claude has
 *   drawn the dialog), and at most once per session per
 *   URGENT_PROBE_GAP_MS: a trigger inside that window takes the last
 *   probe's answer, awaiting it while it runs, if that probe started once
 *   this ask was drawn. One that started earlier can't show this ask: the
 *   trigger waits for the next probe the gap allows.
 * - One episode per ask: `<sid>:<ask>`, the ask's key (`askKey`): its kind
 *   and words, without the pointer, the boxes, the line breaks or the
 *   ticking time, so it holds while the ask is open, whatever the arrow
 *   keys or the window's width do. (Not the dialog's fingerprint: that one
 *   changes with the pointer and the wrapping.) A countdown with at least
 *   URGENT_MIN_S left and no episode for it starts one: deadline = read
 *   time + (left - 1) s (the dock's margin), one urgent push and, with more
 *   than URGENT_REPEAT_AT_S + 15 s left, one repeat timer at
 *   URGENT_REPEAT_AT_S left. Under URGENT_MIN_S nothing: it could not be
 *   answered in time.
 * - The repeat probes again, and the probe is the truth: the same ask still
 *   showing with at least URGENT_MIN_S left pushes once more; anything else
 *   (answered, another ask, no countdown, nothing read, the session gone)
 *   nothing. Never a third push.
 * - `then(open)` (the waiting push's check): true only when this check's
 *   read showed an ask whose episode is open. A read that failed, or one
 *   still running after URGENT_ANSWER_MS, answers false: the waiting push
 *   goes (two pushes rather than none, or a late one).
 * - `open(sid)`: an episode of the session whose deadline is ahead and whose
 *   ask the last screen read still showed. A read showing another ask, or
 *   no countdown, closes it, so an answered ask never hides the next one's
 *   waiting push; its key stays until the deadline, so the same ask is
 *   never pushed as new twice.
 * - Episodes end at their deadline, on session.removed (`drop`, with the
 *   session's waiting checks) and on `stop()`. They live in memory only: an
 *   ask still counting down when the daemon restarts may be pushed again.
 */
import { DIALOG_GATES, URGENT_MIN_S, URGENT_REPEAT_AT_S, countdownSeconds } from '@jantar/protocol';
import type { Clock, DaemonContext, PaneFinder, TerminalBackend, TimerId } from '../contracts.js';
import { canonicalJson, sha256Hex } from '../core/hash.js';
import { readDialog, type DialogModel } from '../terminal/dialog.js';

/** Two triggers this close together share one probe (and one screen read). */
export const URGENT_PROBE_GAP_MS = 10_000;
/** A probe waits until this long after the ask began, so Claude has drawn its dialog. */
export const URGENT_DRAW_MS = 1_500;
/** The repeat is set only with more than this many seconds left past URGENT_REPEAT_AT_S. */
export const URGENT_REPEAT_ROOM_S = 15;
/** The waiting push waits at most this long for a running probe's answer. */
export const URGENT_ANSWER_MS = 3_000;
/** Lines a probe reads: the dialog parser's 60, as GET /screen reads. */
export const PROBE_LINES = 60;

/** Seconds left on Claude's countdown at `at` (ms), and the ask's key (askKey). */
export interface CountdownRead {
  left: number;
  at: number;
  ask: string;
}

/** A countdown; 'none' when the screen was read and shows none; null when it could not be read. */
export type CountdownAnswer = CountdownRead | 'none' | null;

export type CountdownProbe = (sid: string) => Promise<CountdownAnswer>;

/** Spaces and box lines: where Claude breaks and frames a line depends on the window's width. */
const DRAWN = /[\s─-╿]+/gu;

/**
 * What an ask is, not how it is drawn: its kind, title and body, question
 * and each row's label and detail, with every space and box line left out
 * (the model before the gates, nothing clipped). The pointer, a box's tick,
 * a narrower window's line breaks and the ticking countdown (never in the
 * model's body) don't change it.
 */
export function askKey(d: DialogModel): string {
  const words = (parts: readonly string[]) => parts.join('').replace(DRAWN, '');
  return sha256Hex(
    canonicalJson({
      kind: d.kind,
      text: words([d.title, ...d.body]),
      question: words([d.question]),
      options: d.options.map((o) => words([o.label, o.detail ?? ''])),
    }),
  );
}

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
      const at = ctx.clock.now();
      const r = await deps.terminal.readScreen(pane, { lines: PROBE_LINES });
      if (!r.ok) return null;
      const d = readDialog(r.raw ?? r.text, DIALOG_GATES);
      const left = d.dialog?.blocksIn === undefined ? null : countdownSeconds(d.dialog.blocksIn);
      return d.dialog && d.open && left !== null ? { left, at, ask: askKey(d.open) } : 'none';
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
  /** notify.urgent (with permission in notify.kinds, no mute and a channel on), asked before every probe. */
  enabled: () => boolean;
  push: (u: UrgentPush) => void;
  /** Async work in flight (the router's whenIdle and stop wait for it). */
  track: (p: Promise<unknown>) => void;
}

export interface CheckOptions {
  /** Told once whether an ask with Claude's countdown is open (see the rules above); false with notify.urgent off. */
  then?: (open: boolean) => void;
  /** A read that failed is tried once more URGENT_PROBE_GAP_MS later while this holds (its card still open). */
  retry?: () => boolean;
}

interface Episode {
  sid: string;
  ask: string;
  deadline: number;
  /** The last read of the session showed this ask. */
  live: boolean;
  timers: TimerId[];
}

/** A probe: when it started, its answer, and whether that answer is in. */
interface Read {
  at: number;
  answer: Promise<CountdownAnswer>;
  settled: boolean;
}

/** Seconds left now on a countdown read at `read.at`. */
function leftAt(read: CountdownRead, now: number): number {
  return Math.floor(read.left - Math.max(0, now - read.at) / 1000);
}

export class CountdownWatch {
  private readonly reads = new Map<string, Read>();
  private readonly episodes = new Map<string, Episode>();
  /** Every timer set, with its session (drop clears them). */
  private readonly timers = new Map<TimerId, string>();
  private stopped = false;

  constructor(private readonly deps: CountdownWatchDeps) {}

  /**
   * Look for Claude's countdown on `sid`'s screen once the ask that began at
   * `since` is drawn (and the gap allows a read it can take); then
   * `opts.then(open)`. With notify.urgent off nothing is read and
   * `then(false)`.
   */
  check(sid: string, since: string, opts: CheckOptions = {}): void {
    if (this.stopped) return;
    const now = this.deps.clock.now();
    const drawn = Date.parse(since) + URGENT_DRAW_MS;
    const last = this.reads.get(sid);
    // A probe that started before this ask was drawn can't show it: the next one the gap allows.
    const from = last && last.at < drawn ? Math.max(drawn, last.at + URGENT_PROBE_GAP_MS) : drawn;
    if (from > now) {
      this.later(sid, from - now, () => this.check(sid, since, opts));
      return;
    }
    if (!this.deps.enabled()) {
      opts.then?.(false);
      return;
    }
    const read = this.read(sid);
    let told = false;
    const tell = (open: boolean) => {
      if (told) return;
      told = true;
      opts.then?.(open);
    };
    const slow = opts.then && !read.settled ? this.later(sid, URGENT_ANSWER_MS, () => tell(false)) : null;
    this.deps.track(
      (async () => {
        const answer = await read.answer;
        if (slow !== null) this.cancel(slow);
        if (this.stopped || !this.reads.has(sid)) return; // stopped, or the session dropped meanwhile
        this.consider(sid, answer);
        tell(answer !== null && this.open(sid));
        const retry = opts.retry;
        if (answer === null && retry) {
          this.later(sid, URGENT_PROBE_GAP_MS, () => {
            if (retry()) this.check(sid, since);
          });
        }
      })(),
    );
  }

  /** Whether `sid` has an ask with Claude's countdown running that its last screen read still showed. */
  open(sid: string): boolean {
    const now = this.deps.clock.now();
    for (const ep of this.episodes.values()) if (ep.sid === sid && ep.live && ep.deadline > now) return true;
    return false;
  }

  /** session.removed: its episodes, its waiting checks, every timer of it and its last read go. */
  drop(sid: string): void {
    for (const [key, ep] of [...this.episodes]) if (ep.sid === sid) this.end(key);
    for (const [t, of] of [...this.timers]) if (of === sid) this.cancel(t);
    this.reads.delete(sid);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.keys()) this.deps.clock.clearTimeout(t);
    this.timers.clear();
    this.episodes.clear();
    this.reads.clear();
  }

  /** The last probe when it started under URGENT_PROBE_GAP_MS ago (running or not); else a new probe. */
  private read(sid: string): Read {
    const now = this.deps.clock.now();
    const last = this.reads.get(sid);
    if (last && now - last.at < URGENT_PROBE_GAP_MS) return last;
    const read: Read = { at: now, answer: this.deps.probe(sid), settled: false };
    const settle = () => {
      read.settled = true;
    };
    void read.answer.then(settle, settle);
    this.reads.set(sid, read);
    return read;
  }

  /** What a read means for `sid`'s episodes; a new ask with time to answer starts one and pushes. */
  private consider(sid: string, read: CountdownAnswer): void {
    if (read === null) return; // nothing was read: nothing changes
    const shown = read === 'none' ? null : read.ask;
    for (const ep of this.episodes.values()) if (ep.sid === sid) ep.live = ep.ask === shown;
    if (read === 'none') return;
    const key = `${sid}:${read.ask}`;
    const now = this.deps.clock.now();
    const left = leftAt(read, now);
    if (this.episodes.has(key) || left < URGENT_MIN_S) return;
    const deadline = read.at + (read.left - 1) * 1000;
    const ep: Episode = { sid, ask: read.ask, deadline, live: true, timers: [] };
    this.episodes.set(key, ep);
    ep.timers.push(this.later(sid, deadline - now, () => this.end(key)));
    if (left > URGENT_REPEAT_AT_S + URGENT_REPEAT_ROOM_S) ep.timers.push(this.later(sid, deadline - URGENT_REPEAT_AT_S * 1000 - now, () => this.repeat(key)));
    this.deps.push({ sid, left, deadline: new Date(deadline).toISOString(), repeat: false });
  }

  /** The one repeat: only while the same ask still shows with time to answer it. */
  private repeat(key: string): void {
    const ep = this.episodes.get(key);
    if (!ep || this.stopped || !this.deps.enabled()) return;
    const read = this.read(ep.sid);
    this.deps.track(
      (async () => {
        const answer = await read.answer;
        if (this.stopped || this.episodes.get(key) !== ep) return;
        this.consider(ep.sid, answer);
        if (answer === null || answer === 'none' || answer.ask !== ep.ask) return;
        const left = leftAt(answer, this.deps.clock.now());
        if (left >= URGENT_MIN_S) this.deps.push({ sid: ep.sid, left, deadline: new Date(ep.deadline).toISOString(), repeat: true });
      })(),
    );
  }

  private end(key: string): void {
    const ep = this.episodes.get(key);
    if (!ep) return;
    for (const t of ep.timers) this.cancel(t);
    this.episodes.delete(key);
  }

  private later(sid: string, ms: number, fn: () => void): TimerId {
    const t = this.deps.clock.setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.set(t, sid);
    return t;
  }

  private cancel(t: TimerId): void {
    this.deps.clock.clearTimeout(t);
    this.timers.delete(t);
  }
}
