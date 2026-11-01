/**
 * v0.6 Fleet: the tmux backend, for Linux nodes (spec 4.2). It copies
 * Terminal.app's contract, so `controls/`, the dialog code, the keypad, the
 * writer and the launcher work unchanged:
 *
 * - findPane binds the session to a pane by tty (or pid ancestry), never by
 *   a pane id alone (panes.ts). `Pane.id` is `tmux:%3`, `handle` `%3`.
 * - readScreen is `display-message` of the pane's tty and height, then
 *   `capture-pane -p -N` (the visible screen, trailing spaces kept), in one
 *   tmux call: a pane that is no longer the session's tty is not read.
 * - Every write is the one gated primitive (write.ts tmuxWrite), and every
 *   key write ends with one Enter, as Terminal's `do script` ends with one
 *   Return: pressKey (through Terminal.app's own keys.ts, so the key bytes,
 *   the gates and the text rules are the Mac's, byte for byte), clearInput
 *   (CLEAR_ONE_ROW and its Return), pressEnter (one Enter).
 * - type() pastes the text, then ENTER_AFTER_TEXT_MS later presses one gated
 *   Enter in its own call: Claude collects input for about 100 ms and an
 *   Enter inside that window becomes a newline. The writer keeps pressing
 *   Enter until the transcript proves the prompt, as on the Mac.
 * - compare-and-type: under the writer's pane lock, a capture checked with
 *   typeifFinds (the exact check the Terminal fakes use), then the gated
 *   write whose `#{C:}` lines re-check inside tmux.
 * - foregroundOf reads `ps -t <tty> -o pid=,stat=,comm=` like Terminal.app
 *   (foreground.ts): with the session's pid the answer is exact, which
 *   `#{pane_current_command}` (a name) could not be.
 * - openWindow makes a detached 200x50 session with the user's shell and
 *   types the launch line into it (the shell outlives Claude, as the
 *   launcher requires). focus has nothing to show; no screenshots.
 * - The pane tick: every TICK_MS (and when a session appears) one
 *   `list-panes -a` ties this machine's own live sessions to panes and sets
 *   `session.paneId` (what the phone's canType reads), or unsets it when the
 *   pane is gone. Writes never use the stored paneId.
 *
 * The default tmux server only; tests pass a private socket. Real tmux runs
 * only in Docker or Linux CI, never on the build Mac.
 */
import { EVENT, localSession, localSessions, type ControlKey, type Pane, type PaneForeground } from '@jantar/protocol';
import type { DaemonContext, OpResult, PaneTarget, PressKeyOptions, TerminalBackend, TerminalErrorCode, TimerId, Unsubscribe } from '../../contracts.js';
import { cLocale } from '../../core/exec.js';
import { newId } from '../../core/ids.js';
import { classifyForeground, foregroundPsArgs, parsePsRows } from '../foreground.js';
import { findInputBox, lastLines, screenLines } from '../screen.js';
import type { TerminalAppHost } from '../terminal-app/host.js';
import { CLEAR_ONE_ROW, pressKeyImpl } from '../terminal-app/keys.js';
import { OPEN_COMMAND_MAX } from '../terminal-app/open-window.js';
import { typeifFinds } from '../terminal-app/script.js';
import { normalizeTty, ttyName } from '../tty.js';
import type { TmuxBackendOptions } from './index.js';
import { bindPane, listPanes, type TmuxPaneRow } from './panes.js';
import { CHANGED_REASON, FIELD_SEP, NOT_THIS_PANE, PANE_ID_RE, PTS_RE, TMUX_TIMEOUT_MS, fail, runTmux, tmuxFailure, tmuxWrite, type TmuxWrite } from './write.js';

/** The pause between a prompt's text and its Enter: past Claude's ~100 ms paste window. */
export const ENTER_AFTER_TEXT_MS = 250;
/** How often live sessions are tied to panes (`session.paneId`). */
export const TICK_MS = 10_000;
/** The size of a session Jantar starts: big enough for Claude's dialogs. */
export const OPEN_COLS = 200;
export const OPEN_ROWS = 50;
/** tmux 3.2 is the oldest the write primitive is proved on (compat.sh). */
export const TMUX_MIN_MAJOR = 3;
export const TMUX_MIN_MINOR = 2;

/** Not tied to a pane: no pane on this machine's tmux server has the session's tty. */
export const NO_PANE = "Jantar can't tie this session to a tmux pane on this server";
const NOTHING_TO_SHOW = 'There is no window to show: this session runs in tmux on a server';

// C0 controls except tab and line feed, DEL, and C1 controls.
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const SESSION_NAME_RE = /^jantar-[0-9a-z]{10}$/u;

/** `tmux -V` at least 3.2 (`tmux 3.2a`, `tmux 3.4`, `tmux next-3.6`; a build from git says `master`). */
export function tmuxVersionOk(out: string): boolean {
  const v = out.trim();
  if (/^tmux master\b/u.test(v)) return true;
  const m = /(\d+)\.(\d+)/u.exec(v);
  if (!m) return false;
  const major = Number(m[1]);
  return major > TMUX_MIN_MAJOR || (major === TMUX_MIN_MAJOR && Number(m[2]) >= TMUX_MIN_MINOR);
}

export class TmuxBackend implements TerminalBackend {
  readonly kind = 'tmux' as const;
  /** Why the last findPane() returned null (for the writer's refusal message). */
  lastError: { code: TerminalErrorCode; reason: string } | null = null;

  private versionOk = false;
  private readonly procRoot: string;
  private timer: TimerId | undefined;
  private unsubscribe: Unsubscribe | null = null;
  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  private started = false;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly opts: TmuxBackendOptions = {},
  ) {
    this.procRoot = opts.procRoot ?? '/proc';
  }

  async available(): Promise<boolean> {
    if (!this.ctx.bins.tmux) return false;
    if (this.versionOk) return true;
    const r = await runTmux(this.ctx, this.opts, ['-V']);
    this.versionOk = Boolean(r && r.code === 0 && tmuxVersionOk(r.stdout));
    return this.versionOk;
  }

  async findPane(target: PaneTarget): Promise<Pane | null> {
    this.lastError = null;
    let tty = normalizeTty(target.tty);
    let pid = target.pid;
    if (target.sid && (!tty || pid === undefined)) {
      const s = localSession(this.ctx.store.getState(), target.sid);
      if (s) {
        tty ??= normalizeTty(s.tty);
        pid ??= s.pid;
      }
    }
    if (!tty && pid === undefined) {
      this.lastError = { code: 'not_found', reason: 'the session is not attached to a terminal' };
      return null;
    }
    if (!(await this.available())) {
      this.lastError = { code: 'unsupported', reason: 'tmux 3.2 or later was not found on this server' };
      return null;
    }
    const list = await listPanes(this.ctx, this.opts);
    if (!list.ok) {
      this.lastError = { code: list.code, reason: list.reason };
      return null;
    }
    const row = await bindPane(list.rows, { tty: tty ?? undefined, pid }, this.procRoot);
    if (!row) {
      this.lastError = { code: 'not_found', reason: NO_PANE };
      return null;
    }
    const pane: Pane = { id: `tmux:${row.id}`, backend: 'tmux', handle: row.id, tty: row.tty, foreground: 'gone' };
    if (pid !== undefined && Number.isInteger(pid) && pid > 0) pane.pid = pid;
    pane.foreground = await this.foregroundOf(pane);
    return pane;
  }

  async readScreen(pane: Pane, opts: { lines?: number } = {}): Promise<OpResult<{ text: string; at: string; tabRows?: number; raw: string }>> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    const n = Math.max(1, Math.min(400, Math.floor(opts.lines ?? 80)));
    const t = pane.handle;
    // One call, one server step: the tty and height, then the screen of that same pane.
    const r = await runTmux(this.ctx, this.opts, ['display-message', '-p', '-t', t, `#{pane_tty}${FIELD_SEP}#{pane_height}`, ';', 'capture-pane', '-p', '-N', '-t', t]);
    if (!r || r.spawnError || r.timedOut || r.code !== 0) {
      const why = tmuxFailure(r);
      return why.code === 'failed' ? fail('unreadable', why.reason) : why;
    }
    const nl = r.stdout.indexOf('\n');
    const [tty, height] = (nl < 0 ? r.stdout : r.stdout.slice(0, nl)).split(FIELD_SEP);
    if (tty !== pane.tty) return fail('not_found', NOT_THIS_PANE);
    // capture-pane ends every row with a line feed: the last one is not part of the screen.
    const raw = nl < 0 ? '' : r.stdout.slice(nl + 1).replace(/\n$/u, '');
    const text = lastLines(raw, n).join('\n');
    const rows = Number(height);
    return { ok: true, text, at: this.ctx.clock.iso(), ...(Number.isInteger(rows) && rows > 0 ? { tabRows: rows } : {}), raw };
  }

  async readInputBox(pane: Pane): Promise<OpResult<{ text: string; styled: boolean }>> {
    const screen = await this.readScreen(pane, { lines: 60 });
    if (!screen.ok) return screen;
    const box = findInputBox(screenLines(screen.text));
    if (!box) return fail('unreadable', "Claude's input box isn't on screen");
    // capture-pane -p carries no colours: a dim suggestion reads like typed text.
    return { ok: true, text: box.text, styled: false };
  }

  async type(pane: Pane, text: string): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    if (FORBIDDEN_TEXT.test(text)) return fail('unsupported', 'the text contains control characters');
    const typed = await this.write(pane, { text, enter: false });
    if (!typed.ok) return typed;
    // Terminal's `do script` ends the text with a Return; here it comes in its own call, past the paste window.
    await this.ctx.clock.sleep(ENTER_AFTER_TEXT_MS);
    const entered = await this.write(pane, { enter: true });
    // The text is in: the writer's own Enters (and their refusals) take it from here.
    if (!entered.ok) this.ctx.log.warn('tmux Enter after text failed', { code: entered.code });
    return { ok: true };
  }

  async pressEnter(pane: Pane): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    return this.write(pane, { enter: true });
  }

  async clearInput(pane: Pane): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    // Terminal's clearInput: the one-row clear, and the Return its `do script` adds (an empty box: nothing).
    return this.write(pane, { keys: CLEAR_ONE_ROW, enter: true });
  }

  async focus(pane: Pane): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    return fail('unsupported', NOTHING_TO_SHOW);
  }

  async pressKey(pane: Pane, key: ControlKey, opts?: PressKeyOptions): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    // keys.ts builds the Mac's bytes (arrows, then a dialog row's text) and applies every key rule; the
    // text goes through the buffer and the keys as hex, so it is split off the end again here.
    const text = opts?.text;
    const split = (payload: string): Pick<TmuxWrite, 'keys' | 'text'> | null => {
      if (text === undefined) return { keys: payload };
      return payload.endsWith(text) ? { keys: payload.slice(0, payload.length - text.length), text } : null;
    };
    const host: TerminalAppHost = {
      ctx: this.ctx,
      osascriptTimeoutMs: TMUX_TIMEOUT_MS,
      typeBytes: (p, payload) => {
        const parts = split(payload);
        return parts ? this.write(p, { ...parts, enter: true }) : Promise.resolve(fail('unsupported', 'unexpected key bytes'));
      },
      typeBytesIf: (p, payload, expect) => {
        const parts = split(payload);
        return parts ? this.writeIf(p, parts, expect) : Promise.resolve(fail('unsupported', 'unexpected key bytes'));
      },
      // No AppleScript on a server: keys.ts never asks for one.
      runScript: async () => fail('unsupported', 'there is no AppleScript here'),
      checkPane: (p) => this.checkPane(p),
    };
    return pressKeyImpl(host, pane, key, opts);
  }

  async openWindow(command: string): Promise<OpResult<{ tty: string; windowId: string }>> {
    if (command.trim() === '') return fail('failed', 'there is nothing to run');
    if (CONTROL_RE.test(command)) return fail('unsupported', 'the command contains control characters');
    if (command.length > OPEN_COMMAND_MAX) return fail('unsupported', 'the command is too long');
    if (!(await this.available())) return fail('unsupported', 'tmux 3.2 or later was not found on this server');
    const name = `jantar-${newId().slice(-10).toLowerCase()}`;
    if (!SESSION_NAME_RE.test(name)) return fail('failed', 'could not name a tmux session');
    const r = await runTmux(this.ctx, this.opts, [
      'new-session', '-d', '-s', name, '-x', String(OPEN_COLS), '-y', String(OPEN_ROWS), '-P', '-F', `#{pane_id}${FIELD_SEP}#{pane_tty}`,
    ]);
    if (!r || r.spawnError || r.timedOut || r.code !== 0) {
      const why = tmuxFailure(r);
      this.ctx.log.warn('tmux new-session failed', { code: why.code });
      return why;
    }
    const [id = '', tty = ''] = r.stdout.trim().split(FIELD_SEP);
    if (!PANE_ID_RE.test(id) || !PTS_RE.test(tty)) return fail('failed', "tmux didn't report the new session's pane");
    const pane: Pane = { id: `tmux:${id}`, backend: 'tmux', handle: id, tty, foreground: 'shell' };
    // A shell, then the line typed into it with its Return (no paste window in a shell).
    const typed = await this.write(pane, { text: command, enter: true });
    if (!typed.ok) return typed;
    return { ok: true, tty, windowId: id };
  }

  async foregroundOf(pane: Pane): Promise<PaneForeground> {
    if (pane.backend !== 'tmux' || !PTS_RE.test(pane.tty)) return 'other';
    const r = await this.ctx.exec(this.ctx.bins.ps, foregroundPsArgs(ttyName(pane.tty)), {
      env: cLocale(this.ctx.env),
      timeoutMs: TMUX_TIMEOUT_MS,
    });
    if (r.spawnError || r.timedOut) return 'other';
    return classifyForeground(parsePsRows(r.stdout), pane.pid);
  }

  // ---------------------------------------------------------------- the pane tick

  async start(): Promise<void> {
    if (this.started || !this.ctx.bins.tmux) return;
    this.started = true;
    this.unsubscribe = this.ctx.store.subscribe((ev) => {
      // A new session of this machine's own: tie it to its pane now, not at the next tick.
      if (ev.type === EVENT.SESSION_ADDED && ev.data.session.node === undefined) void this.tick();
    });
    await this.tick();
    if (!this.started) return;
    this.timer = this.ctx.clock.setInterval(() => void this.tick(), TICK_MS);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ctx.clock.clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.ticking;
  }

  /** One pass (one at a time; a request while one runs runs once more after it). */
  tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    const run = async (): Promise<void> => {
      do {
        this.tickAgain = false;
        await this.tickOnce().catch((e: unknown) => this.ctx.log.warn('tmux pane tick failed', { error: String(e) }));
      } while (this.tickAgain && this.started);
    };
    this.ticking = run().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    if (!this.started || !(await this.available())) return;
    const list = await listPanes(this.ctx, this.opts);
    // tmux could not be asked: leave every paneId as it is until it can.
    if (!list.ok) return;
    for (const s of Object.values(localSessions(this.ctx.store.getState()))) {
      const row: TmuxPaneRow | null = await bindPane(list.rows, { tty: s.tty, pid: s.pid }, this.procRoot);
      // Read again: the session may have gone or changed while the panes were matched.
      const cur = localSession(this.ctx.store.getState(), s.sid);
      if (!cur || !this.started) continue;
      const account = cur.account !== null ? { account: cur.account } : {};
      if (row && cur.paneId !== row.id) {
        this.ctx.store.emit({ type: EVENT.SESSION_UPDATED, sid: cur.sid, ...account, data: { patch: { paneId: row.id } } });
      } else if (!row && cur.paneId !== undefined) {
        this.ctx.store.emit({ type: EVENT.SESSION_UPDATED, sid: cur.sid, ...account, data: { patch: {}, unset: ['paneId'] } });
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  private checkPane(pane: Pane): { ok: false; code: TerminalErrorCode; reason: string } | null {
    if (pane.backend !== 'tmux' || !PANE_ID_RE.test(pane.handle)) return fail('unsupported', `not a tmux pane (${pane.backend})`);
    if (!PTS_RE.test(pane.tty)) return fail('not_found', 'the pane has no tty');
    return null;
  }

  private write(pane: Pane, write: TmuxWrite): Promise<OpResult> {
    return tmuxWrite(this.ctx, this.opts, pane, write);
  }

  /** Compare-and-type: the exact check on a capture, then the gated write that re-checks inside tmux. */
  private async writeIf(pane: Pane, parts: Pick<TmuxWrite, 'keys' | 'text'>, expect: readonly string[]): Promise<OpResult> {
    const screen = await this.readScreen(pane, { lines: 400 });
    if (!screen.ok) return screen;
    if (!typeifFinds(screen.raw, expect)) return fail('changed', CHANGED_REASON);
    return this.write(pane, { ...parts, enter: true, expect });
  }
}
