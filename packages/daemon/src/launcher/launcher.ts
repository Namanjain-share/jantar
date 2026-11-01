/**
 * One launch, from queued to its final stage (spec 4.5.5, sessions.md 4-5).
 * Every stage change is saved (db.launches) and emitted as launch.progress.
 *
 * 1. queued    Wait while a ccw move is restarting (up to 2 min); check the
 *              folder once more right before typing (it may have been
 *              swapped for a symlink since the API checked it).
 * 2. opening   TerminalBackend.openWindow(command): a new window, never a
 *              live tab. Records tty and window id (the id when known).
 * 3. starting  Poll every 2 s: the tab's foreground, its screen, and the
 *              store for our --session-id (after 20 s of Claude in front, a
 *              session on the same tty, started after us, in the same
 *              realpath, also counts). A session on another account than
 *              asked is a warning, not a failure.
 * 4. dialog    dialogs.ts says what to do: answer it (Chrome intro, one
 *              Retry, Keep model), fail (login), or show a "needs you" card
 *              (trust, bypass, anything unknown; no auto-trust, U8). The
 *              ready clock pauses while a card waits; after
 *              launch.timeouts.dialogMin the launch is "stalled". A dialog
 *              answered at the Mac closes the card (two polls without it).
 * 5. ready     The session is idle, Claude holds the foreground, the input
 *              box shows and no dialog does, on two polls 2 s apart, 3 s
 *              or more after the last answer.
 * 6. prompting The first prompt (held in memory only) goes through
 *              Writer.submit with idempotency key "launch:<id>"; ccw moving
 *              the session is waited out for up to 5 min. stop() does not
 *              wait for the proof: the job stays "prompting" and the next
 *              start's recovery settles it.
 *
 * Final: done, done-no-prompt, ready-prompt-failed, failed, refused,
 * stalled. Failures keep a masked 6-line screen tail for launchGet.
 *
 * v0.4: a resume (`job.resumed`) types `--resume <id>`, so `job.sid` starts
 * as the conversation's own id. A running session with that id, started
 * after this launch, is the match (an earlier, ended run of the same
 * conversation is not); otherwise the tty fallback finds it and `job.sid`
 * takes the matched id. claude mode (single-account) types claude itself:
 * its steps and failures name claude, not cswap.
 */
import {
  LAUNCH_FINAL_STAGES,
  localSessions,
  type LaunchAnswerBody,
  type LaunchJob,
  type LaunchStage,
  type Pane,
  type PaneForeground,
  type Session,
} from '@jantar/protocol';
import { realpath } from 'node:fs/promises';
import type {
  Actor,
  CcwLegacySource,
  DaemonContext,
  FilePolicy,
  LaunchResult,
  Notifier,
  OpResult,
  TerminalBackend,
  TimerId,
  Writer,
} from '../contracts.js';
import { actorId } from '../core/actor.js';
import { cLocale } from '../core/exec.js';
import { parseLstart } from '../sources/lib/lstart.js';
import { acct, clip } from '../notify/format.js';
import { normalizeTty, ttyName } from '../terminal/tty.js';
import { ccwCheck } from '../writer/preconditions.js';
import { answerKeys, dialogAction, dialogQuestion, readStartupScreen, screenTail, type StartupDialog } from './dialogs.js';
import { fail, isRefusal } from './folders.js';
import { auditAnswer, auditLaunch, launchNotification, pushLaunch, type LaunchPushKind } from './report.js';

/** No window can open: the Mac's Terminal, or (v0.6, a Linux server) no usable tmux there. */
export const noWindows = (terminal: Pick<TerminalBackend, 'kind'>) =>
  terminal.kind === 'tmux' ? "This server has no tmux 3.2 or later, so Jantar can't open a new window there" : "This Mac's terminal can't open new windows";

export interface RunTimings {
  /** Screen, foreground and session checks while starting. */
  pollMs: number;
  /** Wait this long after a dialog first shows before answering it. */
  settleMs: number;
  /** A dialog just answered may stay painted: the same title is left alone this long. */
  sameTitleMs: number;
  /** Ready needs this long since the last answer. */
  quietMs: number;
  /** How long a launch waits for a ccw move that is restarting a session. */
  ccwRestartWaitMs: number;
  /** How long the first prompt waits while ccw moves the new session. */
  ccwMoveWaitMs: number;
  /** Claude in front this long without our session id: match the session by tty, start time and folder. */
  fallbackAfterMs: number;
  /** A shell in front this soon after opening is the window still starting up. */
  shellGraceMs: number;
  /** How long the first prompt's proof is waited for. */
  proofWaitMs: number;
  /** How long an answer waits for the pane's writer lock (a send may hold it until its proof). */
  lockWaitMs: number;
  /** Between checks while waiting on ccw. */
  waitStepMs: number;
}

export const RUN_TIMINGS: RunTimings = {
  pollMs: 2_000,
  settleMs: 1_000,
  sameTitleMs: 20_000,
  quietMs: 3_000,
  ccwRestartWaitMs: 2 * 60_000,
  ccwMoveWaitMs: 5 * 60_000,
  fallbackAfterMs: 20_000,
  shellGraceMs: 8_000,
  proofWaitMs: 5 * 60_000,
  lockWaitMs: 8_000,
  waitStepMs: 5_000,
};

export const STEPS_MAX = 20;
export const RESTART_REASON = 'The daemon restarted during the launch. Check the Terminal window.';
export const PERMISSION_SENTENCE =
  "macOS hasn't let Jantar control Terminal: allow it under System Settings > Privacy & Security > Automation";
/** osascript timed out, possibly after `do script` already ran: a window may be starting the session. */
export const OPEN_TIMEOUT_SENTENCE =
  "Terminal did not answer in time, and a window may have opened anyway. Check Terminal on the Mac before starting again.";
export const LOCK_BUSY_REASON = 'a prompt is still being sent to this window';
export const WINDOW_CLOSED = 'The window was closed';
export const SWITCHED_OFF_REASON = 'Starting sessions from the phone was turned off. Check the window on the Mac.';
/**
 * After a restart, the tab on the stored tty is the launch's own window only
 * if its oldest process started by the time that window opened, plus this.
 */
export const REUSED_TTY_GRACE_MS = 60_000;
/** The opening's upper bound when its step was trimmed: a ccw restart wait plus osascript's timeout. */
const OPEN_BOUND_MS = 2 * 60_000 + 15_000;
const PRE_READY: ReadonlySet<LaunchStage> = new Set(['queued', 'opening', 'starting', 'dialog']);
const FAILED: ReadonlySet<LaunchStage> = new Set(['failed', 'stalled', 'refused']);
/** zsh's and bash's words for a command that does not exist, and zsh's spelling correction. */
const COMMAND_MISSING_RE = /command not found: \S+|\S+: command not found|zsh: correct '/u;

export function isPreReady(stage: LaunchStage): boolean {
  return PRE_READY.has(stage);
}

export function isFinal(stage: LaunchStage): boolean {
  return LAUNCH_FINAL_STAGES.includes(stage);
}

export interface RunDeps {
  ctx: DaemonContext;
  terminal: TerminalBackend;
  writer: Writer;
  ccwLegacy: CcwLegacySource;
  policy: () => FilePolicy;
  notifiers: readonly Notifier[];
  timings: RunTimings;
  /** Keep a background promise (pushes) so stop() can wait for it. */
  track(p: Promise<unknown>): void;
}

export type RunMode =
  /** A fresh launch: open the window with `command`. */
  | { kind: 'new'; command: string; rel: string; prompt: string | null; actor: Actor }
  /** After a daemon restart: the window (or the session) exists; check for ready, send nothing. */
  | { kind: 'resume' };

type Verdict = 'wait' | 'ready' | 'over';
/** findPane's miss: the tab is gone, Terminal could not be asked this time, or the tty is now another window's. */
type PaneMiss = 'gone' | 'busy' | 'other';
type Press = { ok: true; label: string } | { ok: false; changed: boolean; reason: string };

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

async function realOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export class LaunchRun {
  done: Promise<void> = Promise.resolve();
  /** Masked screen tail for launchGet (dialogs and failures). */
  tail: string | undefined;

  private readonly ac = new AbortController();
  private prompt: string | null;
  private lock: Promise<unknown> = Promise.resolve();
  private pane: Pane | null = null;
  private lastScreen = '';
  private sessionSeen = false;
  private openedAt = 0;
  private lastPollAt = 0;
  /** Watching time outside card waits (the claude and ready timeouts run on it). */
  private active = 0;
  private claudeAt: number | null = null;
  private calm = 0;
  private gone = 0;
  private shell = 0;
  private retried = 0;
  private lastAnswerAt = 0;
  private lastAnswer: { title: string; at: number } | null = null;
  private dialogSeen: { title: string; at: number } | null = null;
  private card: StartupDialog | null = null;
  /** Polls in a row without the card's dialog on screen (it closes on the second). */
  private cardMisses = 0;
  /** A resumed run without its session: the pane found by tty must be in this window. */
  private ownWindow: string | null = null;

  constructor(
    private readonly d: RunDeps,
    private readonly job: LaunchJob,
    private readonly mode: RunMode,
  ) {
    this.prompt = mode.kind === 'new' ? mode.prompt : null;
  }

  private get ctx(): DaemonContext {
    return this.d.ctx;
  }

  private get t(): RunTimings {
    return this.d.timings;
  }

  /** A copy of the job as it stands (never the live object: emitted events must not change later). */
  snapshot(): LaunchJob {
    return structuredClone(this.job);
  }

  start(): void {
    this.done = this.run();
  }

  /** stop(): end the run where it stands; the job stays unfinished in the db for the next start's recovery. */
  abort(): void {
    this.ac.abort();
  }

  /** End a job without running it (recovery after a restart). */
  settle(stage: LaunchStage, reason?: string): void {
    this.finish(stage, reason);
  }

  /**
   * Launching was turned off at the Mac: stop and type nothing more. Waits
   * for a poll or an answer in hand (they never interleave), then ends the
   * job: failed before ready; past it, by whether the first prompt went.
   */
  switchedOff(): Promise<void> {
    this.ac.abort();
    return this.exclusive(async () => {
      if (isFinal(this.job.stage)) return;
      if (isPreReady(this.job.stage)) this.finish('failed', SWITCHED_OFF_REASON);
      else if (this.job.prompt?.sendJobId) this.finish('done-no-prompt', 'Starting from the phone was turned off before the first prompt was confirmed. Check the session.');
      else if (this.job.prompt) this.finish('ready-prompt-failed', "Starting from the phone was turned off: the first prompt wasn't sent");
      else this.finish('done');
    });
  }

  /** Persist and broadcast the job as it stands. */
  save(): void {
    this.job.updatedAt = this.ctx.clock.iso();
    const job = this.snapshot();
    this.ctx.db.launches.save(job);
    this.ctx.store.emit({ type: 'launch.progress', ...(this.sessionSeen ? { sid: job.sid } : {}), data: { job } });
  }

  /** A "needs you" card answered from a phone (launchAnswer). */
  answer(body: LaunchAnswerBody, actor: Actor): Promise<LaunchResult<{ job: LaunchJob }>> {
    return this.exclusive(async () => {
      const shown = this.job.dialog;
      const card = this.card;
      if (this.job.stage !== 'dialog' || !shown || !card) return fail('conflict', 'This start is not waiting on a dialog');
      if (body.title !== shown.title) return fail('conflict', 'The dialog on the Mac has changed; look at it again');
      if (body.option >= shown.options.length) return fail('invalid_request', 'There is no such option');
      const pane = this.pane;
      if (!pane) return fail('unavailable', "The new window's tab can't be found");
      let r: Press;
      try {
        r = await this.press(pane, card, body.option, Date.parse(shown.since));
      } catch (e) {
        if (this.signal.aborted) return fail('unavailable', 'The daemon is stopping; answer it on the Mac');
        throw e;
      }
      if (!r.ok) {
        if (r.changed) return fail('conflict', 'The dialog on the Mac has changed; look at it again');
        return fail('unavailable', `The answer could not be typed: ${r.reason}`);
      }
      auditAnswer(this.ctx, actorId(actor), this.job, shown.title, body.option, false);
      this.closeCard();
      this.setStage('starting', `Answered · ${r.label}`);
      return { ok: true, job: this.snapshot() };
    });
  }

  // -------------------------------------------------------------------------

  private get signal(): AbortSignal {
    return this.ac.signal;
  }

  private sleep(ms: number): Promise<void> {
    if (ms > 0 || this.signal.aborted) return this.ctx.clock.sleep(Math.max(0, ms), this.signal);
    return Promise.resolve();
  }

  /**
   * `p`, or an AbortError as soon as stop() aborts the run, for waits that
   * can take minutes (the first prompt's proof, the pane's writer lock).
   * run() then returns quietly and the job stays at its stage in the db for
   * the next start's recovery.
   */
  private abortable<T>(p: Promise<T>): Promise<T> {
    const signal = this.signal;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      void p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** Polls and answers never interleave: an answer from the phone waits for the poll in hand, and the other way round. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<void> {
    try {
      if (this.mode.kind === 'new') {
        // The API's reply (the queued job) goes out first.
        await this.ctx.clock.sleep(0, this.signal);
        if (!(await this.waitForCcw())) return;
        if (!(await this.recheckFolder(this.mode.rel))) return;
        if (!(await this.open(this.mode.command))) return;
      } else if (!(await this.resume())) {
        return;
      }
      if (!(await this.watch())) return;
      await this.firstPrompt();
    } catch (e) {
      if (this.signal.aborted) return;
      this.ctx.log.error('launch failed', { launchId: this.job.id, error: String(e) });
      this.finish('failed', 'Something went wrong while starting the session. Check Terminal on the Mac.');
    }
  }

  /** No launch while ccw restarts a session: both run cswap's adopt, which may not lock against itself. */
  private async waitForCcw(): Promise<boolean> {
    const until = this.ctx.clock.now() + this.t.ccwRestartWaitMs;
    let noted = false;
    for (;;) {
      const restarting = Object.values(this.ctx.store.getState().moves).some((m) => m.step === 'restarting');
      if (!restarting) return true;
      if (this.ctx.clock.now() >= until) {
        this.finish('refused', 'ccw is restarting a session; start this one again in a minute');
        return false;
      }
      if (!noted) {
        noted = true;
        this.step('queued', 'Waiting for ccw to finish restarting a session');
        this.save();
      }
      await this.sleep(this.t.waitStepMs);
    }
  }

  /** The folder must still be the one checked: the command types its realpath. */
  private async recheckFolder(rel: string): Promise<boolean> {
    const dir = await this.d.policy().resolveDir(this.job.rootId, rel);
    if (isRefusal(dir)) {
      this.finish('refused', dir.message);
      return false;
    }
    if (dir.real !== this.job.folder) {
      this.finish('refused', 'The folder changed after it was checked; pick it again');
      return false;
    }
    return true;
  }

  private async open(command: string): Promise<boolean> {
    this.setStage('opening', 'Opening a window');
    const open = this.d.terminal.openWindow?.bind(this.d.terminal);
    if (!open) {
      this.finish('failed', noWindows(this.d.terminal));
      return false;
    }
    const r = await open(command);
    // Turned off while Terminal opened it: the job has ended; the window is left to the Mac.
    if (this.signal.aborted) return false;
    if (!r.ok) {
      const reason = r.code === 'permission' ? PERMISSION_SENTENCE : r.code === 'timeout' ? OPEN_TIMEOUT_SENTENCE : r.reason;
      this.finish('failed', reason);
      return false;
    }
    this.job.tty = r.tty;
    // '' when Terminal ran the command but its window could not be found by tty: the tty is enough to watch it.
    if (r.windowId) this.job.windowId = r.windowId;
    this.openedAt = this.ctx.clock.now();
    this.lastPollAt = this.openedAt;
    this.step('opening', `Opened a window · ${ttyName(r.tty)}`);
    const s = this.ctx.settings.get().launch;
    const how =
      s.mode === 'claude' ? 'claude' : s.mode === 'cs-shell' ? `${s.csCommand} ${this.job.account}` : `cswap run ${this.job.account}`;
    // Fixed words for a resume: never the conversation's first line.
    if (this.job.resumed) this.setStage('starting', `Resuming a conversation · ${how}`);
    else this.setStage('starting', s.mode === 'claude' ? 'Starting · claude' : `Starting on ${acct(this.job.account)} · ${how}`);
    this.push('started', '');
    return true;
  }

  /**
   * After a restart: watch the window to ready, with no prompt (it was only
   * ever in memory). The session may not be there yet: Claude writes its
   * file only past the trust dialog. A card that was waiting shows again
   * (and is pushed again) when the next poll finds its dialog.
   *
   * A running session (our --session-id) names its own tty. Without one the
   * stored tty may now be another tab's (macOS reuses a closed tab's tty,
   * and numbers them from ttys000 again after a reboot), so the run goes on
   * only when the tab's oldest process started by the time this launch's
   * window opened and, on the first poll, the pane is in that window.
   */
  private async resume(): Promise<boolean> {
    const session = this.byId(localSessions(this.ctx.store.getState()));
    const tty = normalizeTty(session?.tty) ?? normalizeTty(this.job.tty);
    if (!tty) {
      this.finish('failed', RESTART_REASON);
      return false;
    }
    if (!session) {
      if (!this.job.windowId || !(await this.openedHere(tty))) {
        this.finish('failed', WINDOW_CLOSED);
        return false;
      }
      this.ownWindow = this.job.windowId;
    }
    const onCard = this.job.stage === 'dialog';
    this.job.tty = tty;
    this.job.dialog = undefined;
    this.openedAt = this.ctx.clock.now();
    this.lastPollAt = this.openedAt;
    // Claude was showing the card: a shell in the window now means it exited, not that it never started.
    if (onCard) this.claudeAt = this.openedAt;
    this.setStage('starting', 'Picked up after a daemon restart');
    return true;
  }

  /** Whether the tab on `tty` is still the one this launch opened: its oldest process is no younger than the window. */
  private async openedHere(tty: string): Promise<boolean> {
    const r = await this.ctx.exec(this.ctx.bins.ps, ['-t', ttyName(tty), '-o', 'lstart='], {
      env: { ...cLocale(this.ctx.env), TZ: 'UTC' },
      timeoutMs: 5_000,
    });
    if (r.spawnError || r.timedOut || r.code !== 0) return false;
    const starts = r.stdout
      .split('\n')
      .map((line) => parseLstart(line, 'utc'))
      .filter((ms): ms is number => ms !== null);
    if (starts.length === 0) return false;
    const opened = this.job.steps.findLast((st) => st.stage === 'opening')?.at;
    const openedBy = opened ? Date.parse(opened) : Date.parse(this.job.createdAt) + OPEN_BOUND_MS;
    return Math.min(...starts) <= openedBy + REUSED_TTY_GRACE_MS;
  }

  // ---- watching -------------------------------------------------------------

  private async watch(): Promise<boolean> {
    for (;;) {
      await this.sleep(this.t.pollMs);
      const v = await this.exclusive(() => this.poll());
      if (v === 'ready') return true;
      if (v === 'over') return false;
    }
  }

  private over(stage: LaunchStage, reason: string): Verdict {
    this.finish(stage, reason);
    return 'over';
  }

  private async poll(): Promise<Verdict> {
    if (isFinal(this.job.stage)) return 'over';
    const now = this.ctx.clock.now();
    const dt = Math.max(0, now - this.lastPollAt);
    this.lastPollAt = now;
    if (this.job.stage === 'dialog') return this.pollCard(now);
    this.active += dt;
    const timeouts = this.ctx.settings.get().launch.timeouts;

    const session = await this.detect(now);
    const pane = await this.paneFor(session);
    if (pane === 'other') return this.over('failed', WINDOW_CLOSED);
    if (pane === 'gone') return this.goneOr();
    // Terminal busy or slow to answer: not a closed window. The timeouts still run.
    if (pane === 'busy') return this.readyTimeout(session, timeouts.readyS);
    const fg: PaneForeground = await this.d.terminal.foregroundOf(pane);
    if (fg === 'gone') return this.goneOr();
    if (fg === 'claude' && this.claudeAt === null) this.claudeAt = now;
    const screen = await this.d.terminal.readScreen(pane, { lines: 60 });
    if (!screen.ok && screen.code === 'not_found') return this.goneOr();
    this.gone = 0;
    if (screen.ok) this.lastScreen = screen.text;

    if (fg === 'shell') {
      this.shell += 1;
      if (this.claudeAt === null && screen.ok && COMMAND_MISSING_RE.test(screen.text)) return this.over('failed', this.commandMissing());
      if (this.claudeAt !== null && this.shell >= 2) return this.over('failed', 'Claude exited before it was ready');
      if (this.claudeAt === null && this.shell >= 3 && now - this.openedAt >= this.t.shellGraceMs) {
        if (this.claudeMode()) return this.over('failed', "Claude didn't start. Check the window on the Mac.");
        return this.over('failed', `cswap couldn't start account ${acct(this.job.account)}. Check the window on the Mac.`);
      }
    } else {
      this.shell = 0;
    }
    if (this.claudeAt === null && this.active >= timeouts.claudeS * 1000) {
      return this.over('failed', `Claude didn't start within ${timeouts.claudeS} s. Check the window on the Mac.`);
    }
    if (!screen.ok) {
      this.calm = 0;
      return this.readyTimeout(session, timeouts.readyS);
    }

    const { state, dialog } = readStartupScreen(screen.text);
    if (dialog) {
      this.calm = 0;
      const v = await this.onDialog(dialog, pane, now, screen.text);
      // Only a card pauses the ready clock; a dialog still being answered (or still painted) does not.
      return v === 'wait' && this.card === null ? this.readyTimeout(session, timeouts.readyS) : v;
    }
    this.dialogSeen = null;
    const ready =
      session !== null && session.status === 'idle' && fg === 'claude' && state.inputBox !== null && now - this.lastAnswerAt >= this.t.quietMs;
    this.calm = ready ? this.calm + 1 : 0;
    if (this.calm >= 2) {
      this.setStage('ready', 'Ready');
      return 'ready';
    }
    return this.readyTimeout(session, timeouts.readyS);
  }

  private readyTimeout(session: Session | null, readyS: number): Verdict {
    if (this.active < readyS * 1000) return 'wait';
    if (this.claudeAt !== null && session === null) {
      return this.over('failed', "Claude started, but its session never showed up. Check the window on the Mac.");
    }
    return this.over('failed', `Didn't become ready within ${readyS} s. Check the window on the Mac.`);
  }

  /** Two misses in a row (no tab, no process on the tty) mean the window was closed. */
  private goneOr(): Verdict {
    this.gone += 1;
    if (this.gone >= 2) return this.over('failed', WINDOW_CLOSED);
    return 'wait';
  }

  private claudeMode(): boolean {
    return this.ctx.settings.get().launch.mode === 'claude';
  }

  private commandMissing(): string {
    const s = this.ctx.settings.get().launch;
    if (s.mode === 'claude') return "The new window's shell couldn't run claude. Check the window on the Mac.";
    if (s.mode === 'cs-shell') {
      return `The new window's shell doesn't know \`${s.csCommand}\`. Start through cswap instead, on the Mac: jantar launch mode cswap-run`;
    }
    return "The new window's shell couldn't find cswap or the pre-launch command. Check the window on the Mac.";
  }

  /**
   * The session under this launch's id, if it runs: for a resume, only one
   * started after this launch (the conversation's earlier run may still be
   * in the store, ended).
   */
  private byId(sessions: Readonly<Record<string, Session>>): Session | undefined {
    if (!Object.hasOwn(sessions, this.job.sid)) return undefined;
    const s = sessions[this.job.sid];
    if (!s || (this.job.resumed && (s.status === 'ended' || (s.startedAt && Date.parse(s.startedAt) < Date.parse(this.job.createdAt) - 5_000)))) return undefined;
    return s;
  }

  /** Our session in the store, by --session-id; after 20 s of Claude in front, by tty, start time and folder. */
  private async detect(now: number): Promise<Session | null> {
    // v0.6: this Mac's own sessions (a launch on a server runs on that server).
    const sessions = localSessions(this.ctx.store.getState());
    let found: Session | null = this.byId(sessions) ?? null;
    if (!found && this.job.tty && this.claudeAt !== null && now - this.claudeAt >= this.t.fallbackAfterMs) {
      const floor = Date.parse(this.job.createdAt) - 5_000;
      for (const s of Object.values(sessions)) {
        if (normalizeTty(s.tty) !== this.job.tty || !s.startedAt || Date.parse(s.startedAt) < floor) continue;
        if ((await realOr(s.cwd)) !== this.job.folder) continue;
        found = s;
        this.job.sid = s.sid;
        this.step('starting', 'Found the session by its window');
        break;
      }
    }
    if (found && !this.sessionSeen) {
      this.sessionSeen = true;
      if (found.account !== null && found.account !== this.job.account) {
        this.job.actualAccount = found.account;
        this.step('starting', `Started on ${acct(found.account)}, not ${acct(this.job.account)}`);
      }
      this.save();
    }
    return found;
  }

  private async paneFor(session: Session | null): Promise<Pane | PaneMiss> {
    if (!this.pane) {
      if (!this.job.tty) return 'gone';
      this.pane = await this.d.terminal.findPane({ tty: this.job.tty });
      if (!this.pane) {
        // Terminal.app's backend says why (writer/send.ts reads it the same way); only "not found" means the tab is gone.
        const why = (this.d.terminal as { lastError?: { code?: string } | null }).lastError?.code;
        return why === undefined || why === 'not_found' ? 'gone' : 'busy';
      }
      // Terminal.app's handle is "<window id>:<tab index>": a resumed run never watches, or presses into, another window.
      if (this.ownWindow !== null && this.pane.handle.split(':')[0] !== this.ownWindow) {
        this.pane = null;
        return 'other';
      }
    }
    // The pid makes the foreground check exact once the session is known.
    if (session && this.pane.pid !== session.pid && Number.isInteger(session.pid) && session.pid > 0) this.pane = { ...this.pane, pid: session.pid };
    return this.pane;
  }

  // ---- dialogs ---------------------------------------------------------------

  private async onDialog(dialog: StartupDialog, pane: Pane, now: number, text: string): Promise<Verdict> {
    const action = dialogAction(dialog, { retried: this.retried, account: this.job.account });
    if (action.act === 'fail') {
      // claude mode has no cswap to re-login with: the one login is Claude's own.
      if (dialog.kind === 'login' && this.claudeMode()) return this.over('failed', 'Claude needs a login on the Mac: run claude in Terminal and log in, then start again.');
      return this.over('failed', action.reason);
    }
    if (this.lastAnswer && this.lastAnswer.title === dialog.title && now - this.lastAnswer.at < this.t.sameTitleMs) return 'wait';
    if (!this.dialogSeen || this.dialogSeen.title !== dialog.title) this.dialogSeen = { title: dialog.title, at: now };
    if (action.act === 'auto' && action.option >= 0) {
      const r = await this.press(pane, dialog, action.option, this.dialogSeen.at);
      if (r.ok) {
        auditAnswer(this.ctx, 'system', this.job, dialog.title, action.option, true);
        if (dialog.kind === 'retry') this.retried += 1;
        this.lastAnswer = { title: dialog.title, at: this.ctx.clock.now() };
        this.dialogSeen = null;
        this.step('starting', `Answered for you · ${dialog.title}`);
        this.save();
        return 'wait';
      }
      if (r.changed) return 'wait';
      // Keys can't be typed here: leave it to the person, at the Mac or on the phone.
      this.ctx.log.warn('could not answer a startup dialog', { launchId: this.job.id, kind: dialog.kind, reason: r.reason });
    }
    this.openCard(dialog, text);
    return 'wait';
  }

  private openCard(dialog: StartupDialog, text: string): void {
    const since = this.dialogSeen?.at ?? this.ctx.clock.now();
    this.card = dialog;
    this.cardMisses = 0;
    this.tail = screenTail(text);
    this.job.dialog = { title: dialog.title, options: [...dialog.options], current: dialog.current, since: this.ctx.clock.iso(since) };
    this.setStage('dialog', `Claude asks · ${dialog.title}`);
    this.push('dialog', dialogQuestion(dialog));
  }

  private closeCard(): void {
    const title = this.job.dialog?.title;
    this.job.dialog = undefined;
    this.card = null;
    this.dialogSeen = null;
    if (title) this.lastAnswer = { title, at: this.ctx.clock.now() };
  }

  /** While a card waits: stalled after dialogMin; closed when the dialog leaves the screen (answered at the Mac). */
  private async pollCard(now: number): Promise<Verdict> {
    const shown = this.job.dialog;
    if (!shown) return 'wait';
    const dialogMin = this.ctx.settings.get().launch.timeouts.dialogMin;
    if (now - Date.parse(shown.since) >= dialogMin * 60_000) {
      return this.over('stalled', `Nobody answered "${clip(shown.title, 60)}" in ${dialogMin} min. Answer it on the Mac.`);
    }
    if (!this.pane) return 'wait';
    const screen = await this.d.terminal.readScreen(this.pane, { lines: 60 });
    if (!screen.ok) return screen.code === 'not_found' ? this.goneOr() : 'wait';
    this.gone = 0;
    this.lastScreen = screen.text;
    const { dialog } = readStartupScreen(screen.text);
    if (dialog && dialog.title === shown.title) {
      this.cardMisses = 0;
      this.tail = screenTail(screen.text);
      if (dialog.current !== shown.current || dialog.options.join('\n') !== shown.options.join('\n')) {
        // The pointer moved at the Mac: the card follows.
        this.card = dialog;
        this.job.dialog = { ...shown, options: [...dialog.options], current: dialog.current };
        this.save();
      }
      return 'wait';
    }
    // One read that does not parse (a repaint, a resize) must not close the card and reopen it with a second push.
    this.cardMisses += 1;
    if (this.cardMisses < 2) return 'wait';
    this.closeCard();
    this.lastAnswerAt = now;
    this.setStage('starting', 'Answered on the Mac');
    return 'wait';
  }

  /**
   * Choose `option`: wait until the dialog has shown for settleMs, re-read the
   * screen, check it is still the same dialog with the same option there,
   * then send the keys under the pane's writer lock. The lock is waited for
   * at most lockWaitMs (a send can hold it until its proof); a press that
   * gets the lock after that, or after stop(), types nothing.
   */
  private async press(pane: Pane, dialog: StartupDialog, option: number, firstSeen: number): Promise<Press> {
    await this.sleep(firstSeen + this.t.settleMs - this.ctx.clock.now());
    const screen = await this.d.terminal.readScreen(pane, { lines: 60 });
    if (!screen.ok) return { ok: false, changed: false, reason: screen.reason };
    const fresh = readStartupScreen(screen.text).dialog;
    if (!fresh || fresh.title !== dialog.title || option >= fresh.options.length || fresh.options[option] !== dialog.options[option]) {
      return { ok: false, changed: true, reason: 'the dialog changed' };
    }
    const pressKey = this.d.terminal.pressKey?.bind(this.d.terminal);
    if (!pressKey) return { ok: false, changed: false, reason: "this terminal can't press keys" };
    const keys = answerKeys(fresh, option);
    let gaveUp = false;
    let timer: TimerId | undefined;
    const late = new Promise<OpResult>((resolve) => {
      timer = this.ctx.clock.setTimeout(() => {
        gaveUp = true;
        resolve({ ok: false, code: 'timeout', reason: LOCK_BUSY_REASON });
      }, this.t.lockWaitMs);
    });
    const locked = this.d.writer.withPaneLock(pane, async (): Promise<OpResult> => {
      if (gaveUp || this.signal.aborted) return { ok: false, code: 'failed', reason: LOCK_BUSY_REASON };
      this.ctx.clock.clearTimeout(timer);
      // The arrows, or `enter` for the highlighted option; how many Returns that is waits on spike S1 (dialogs.ts).
      return keys.key === 'enter' ? pressKey(pane, 'enter') : pressKey(pane, keys.key, { repeat: keys.repeat });
    });
    let r: OpResult;
    try {
      r = await this.abortable(Promise.race([locked, late]));
    } finally {
      this.ctx.clock.clearTimeout(timer);
    }
    if (!r.ok) return { ok: false, changed: false, reason: r.reason };
    this.lastAnswerAt = this.ctx.clock.now();
    return { ok: true, label: clip(fresh.options[option] ?? '', 80) };
  }

  // ---- the first prompt --------------------------------------------------------

  private async firstPrompt(): Promise<void> {
    const text = this.prompt;
    if (text === null || this.mode.kind !== 'new') {
      if (this.job.prompt) this.finish('done-no-prompt', 'The daemon restarted before the first prompt was sent. Send it again.');
      else this.finish('done');
      return;
    }
    this.setStage('prompting', 'Sending the first prompt');
    const until = this.ctx.clock.now() + this.t.ccwMoveWaitMs;
    let noted = false;
    for (;;) {
      let blocker = (await ccwCheck(this.d.ccwLegacy, this.job.sid)).blocker;
      // Stopped (or turned off) meanwhile: the prompt is not typed.
      if (this.signal.aborted) return;
      if (!blocker) {
        const r = await this.d.writer.submit({
          sid: this.job.sid,
          text,
          onDraft: 'refuse',
          idempotencyKey: `launch:${this.job.id}`,
          actor: this.mode.actor,
        });
        if (r.ok) {
          if (this.job.prompt) this.job.prompt.sendJobId = r.job.id;
          this.save();
          // stop() must not wait out the proof (up to 5 min; launchd kills the daemon after 20 s).
          const final = await this.abortable(this.d.writer.wait(r.job.id, this.t.proofWaitMs));
          this.prompt = null;
          if (final && (final.stage === 'proven' || final.stage === 'proven-merged')) this.finish('done', undefined, 'First prompt delivered');
          else this.finish('ready-prompt-failed', `Started, but the first prompt wasn't confirmed${final?.reason ? `: ${final.reason}` : ''}`);
          return;
        }
        if (!/\bccw\b/u.test(r.reason)) {
          this.finish('ready-prompt-failed', `Started, but the first prompt wasn't sent: ${r.reason}`);
          return;
        }
        blocker = r.reason;
      }
      if (this.ctx.clock.now() >= until) {
        this.finish('ready-prompt-failed', `Started, but the first prompt wasn't sent: ${blocker}`);
        return;
      }
      if (!noted) {
        noted = true;
        this.step('prompting', `Waiting · ${blocker}`);
        this.save();
      }
      await this.sleep(this.t.waitStepMs);
    }
  }

  // ---- stages ----------------------------------------------------------------

  private step(stage: LaunchStage, detail: string): void {
    const steps = this.job.steps;
    steps.push({ at: this.ctx.clock.iso(), stage, detail: clip(detail, 120) });
    // Keep the first step (when it was queued) and the newest ones.
    if (steps.length > STEPS_MAX) steps.splice(1, steps.length - STEPS_MAX);
  }

  private setStage(stage: LaunchStage, detail: string): void {
    // A final stage is final: a step still in flight when the job ended changes nothing.
    if (isFinal(this.job.stage)) return;
    this.job.stage = stage;
    this.step(stage, detail);
    this.save();
  }

  private finish(stage: LaunchStage, reason?: string, detail?: string): void {
    if (isFinal(this.job.stage)) return;
    this.prompt = null;
    this.job.dialog = undefined;
    this.card = null;
    if (reason) this.job.reason = reason;
    if (FAILED.has(stage) && this.lastScreen) this.tail = screenTail(this.lastScreen);
    this.setStage(stage, detail ?? reason ?? 'Started');
    auditLaunch(this.ctx, this.job);
    if (FAILED.has(stage)) this.push('failed', reason ?? 'Start failed');
    // A prompt the writer never took: nobody else says so (a writer job that fails is pushed as send-failed).
    else if (stage === 'ready-prompt-failed' && !this.job.prompt?.sendJobId) this.push('prompt', reason ?? "the first prompt wasn't sent");
  }

  private push(kind: LaunchPushKind, detail: string): void {
    const n = launchNotification(this.ctx, this.snapshot(), kind, detail);
    this.d.track(pushLaunch(this.ctx, this.d.notifiers, n));
  }
}
