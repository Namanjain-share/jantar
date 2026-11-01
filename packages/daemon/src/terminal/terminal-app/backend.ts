// Portions adapted from Shed (c) 2026 Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
/**
 * Terminal.app backend (v0.1's only TerminalBackend).
 *
 * - Every call runs the constant AppleScript in script.ts through `ctx.exec`
 *   with the script on stdin and the tty / text in argv (Shed's osascript
 *   pattern). Prompt text is never interpolated into a script.
 * - Tabs are found by tty plus a live process count on every call, so a tab
 *   that moved or closed is never written to by a stale index.
 * - Screen reads use the tab's visible `contents`, never the full scrollback,
 *   and carry the tab's `number of rows` (Clear draft needs the height).
 * - Foreground: `ps -t <tty> -o pid=,stat=,comm=` (LC_ALL=C); see foreground.ts.
 *   The Claude pid a pane was looked up for travels on the Pane itself
 *   (`pane.pid`), not in backend state keyed by tty: two sessions can share a
 *   tty (one suspended with Ctrl-Z), and a lookup for one must never change
 *   the answer an in-flight job for the other gets (W8).
 *
 * Typing. Terminal's `do script` always appends a line feed, so "type with no
 * implicit newline" cannot be had exactly. What we do (S4 spike decides the
 * default for good):
 * - plain: `do script <text>`, the sequence the legacy ccw tool measured on
 *   this setup. Claude takes the trailing line feed as Enter for short text;
 *   a longer burst arrives as a paste and the line feed becomes a newline.
 * - paste: `do script ESC[200~<text>ESC[201~`, a bracketed paste (Shed). The
 *   text, newlines and tabs included, lands as one paste.
 * - auto (default): plain for single-line text, paste when the text holds a
 *   newline or a tab (typed plainly, a newline would submit the first line
 *   on its own and a tab would trigger completion).
 * The writer never relies on that line feed: it presses Enter until the
 * transcript proves the prompt arrived.
 *
 * Enter is `do script "\r"` (a carriage return, plus Terminal's line feed,
 * which lands in an empty box and does nothing). clearInput is Clear draft's
 * write for one row (keys.ts CLEAR_ONE_ROW): End, then Ctrl-U.
 *
 * v0.3: pressKey, getScreenshot and openWindow are thin: they check the pane
 * and hand a TerminalAppHost (host.ts) to keys.ts, shot.ts and
 * open-window.ts, which their work packages own.
 *
 * v0.4.2: readScreen also returns `raw`, the tab's text exactly as Terminal
 * gave it (its line ends and trailing spaces), and the host lends keys.ts
 * `typeBytesIf`, the script's `typeif` mode: the write happens only while
 * the tab still shows the text the caller cut from `raw`, else `changed`.
 * v0.5.2: that text may come in two parts (around the time in Claude's
 * countdown), each its own argv item after the bytes.
 */
import { localSession } from '@jantar/protocol';
import type { ControlKey, Pane, PaneForeground } from '@jantar/protocol';
import type {
  DaemonContext,
  OpResult,
  PaneTarget,
  PressKeyOptions,
  ScreenshotRequest,
  TerminalBackend,
  TerminalErrorCode,
  TerminalShot,
} from '../../contracts.js';
import { cLocale } from '../../core/exec.js';
import { classifyForeground, foregroundPsArgs, parsePsRows } from '../foreground.js';
import { findInputBox, lastLines, screenLines } from '../screen.js';
import { normalizeTty, ttyName } from '../tty.js';
import type { TerminalAppHost } from './host.js';
import { CLEAR_ONE_ROW, pressKeyImpl } from './keys.js';
import { openWindowImpl } from './open-window.js';
import { BAD_MODE, CHANGED, MISSING, NOT_RUNNING, TERMINAL_APP_SCRIPT, type ScriptMode } from './script.js';
import { screenshotImpl } from './shot.js';
import { KeyedQueue } from '../../writer/queue.js';

export type TypingStyle = 'auto' | 'plain' | 'paste';

export interface TerminalAppOptions {
  /** How text is typed (see the file comment). Default 'auto'. */
  typing?: TypingStyle;
  /** Default process.platform; the backend is only available on darwin. */
  platform?: NodeJS.Platform;
  /** Per osascript call. Default 15 000 ms. */
  osascriptTimeoutMs?: number;
  /** Per ps call. Default 5 000 ms. */
  psTimeoutMs?: number;
  /** Default and maximum lines for readScreen. Defaults 80 and 400. */
  defaultLines?: number;
  maxLines?: number;
}

export interface TerminalAppError {
  code: TerminalErrorCode;
  reason: string;
}

/** Stable id for the Terminal.app pane on a tty. */
export function terminalAppPaneId(tty: string): string {
  return `terminal-app:${ttyName(tty)}`;
}

export const BRACKETED_PASTE_START = '\u001b[200~';
export const BRACKETED_PASTE_END = '\u001b[201~';
export const ENTER = '\r';

/** A tab's `number of rows`, as the contents mode writes it. */
const TAB_ROWS_RE = /^[1-9]\d{0,3}$/u;

// C0 controls except tab and line feed, DEL, and C1 controls.
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

const PERMISSION_REASON =
  'macOS has not allowed Jantar to control Terminal: approve it under System Settings > Privacy & Security > Automation';

type Failure = { ok: false; code: TerminalErrorCode; reason: string };

function fail(code: TerminalErrorCode, reason: string): Failure {
  return { ok: false, code, reason };
}

/** Map osascript's stderr to an error code. Only the AppleScript error number is kept: stderr can echo argv text. */
export function classifyOsascriptError(stderr: string): TerminalAppError {
  const num = /\((-?\d+)\)\s*$/u.exec(stderr.trim())?.[1];
  if (num === '-1743' || /not authori[sz]ed|not allowed to send/iu.test(stderr)) {
    return { code: 'permission', reason: PERMISSION_REASON };
  }
  if (num === '-1728' || num === '-1719') {
    return { code: 'not_found', reason: 'the Terminal tab changed while it was being used' };
  }
  if (num === '-600' || num === '-609' || num === '-1712') {
    return { code: 'failed', reason: `Terminal is not responding (${num})` };
  }
  return { code: 'failed', reason: num ? `osascript failed (${num})` : 'osascript failed' };
}

export class TerminalAppBackend implements TerminalBackend {
  readonly kind = 'terminal-app' as const;
  /** Why the last findPane() returned null (for the writer's refusal message). */
  lastError: TerminalAppError | null = null;

  private readonly typing: TypingStyle;
  private readonly platform: NodeJS.Platform;
  private readonly osaTimeout: number;
  private readonly psTimeout: number;
  private readonly defaultLines: number;
  private readonly maxLines: number;
  private readonly host: TerminalAppHost;
  /** Window opens, one at a time (openWindow). */
  private readonly opens = new KeyedQueue();

  constructor(
    private readonly ctx: DaemonContext,
    opts: TerminalAppOptions = {},
  ) {
    this.typing = opts.typing ?? 'auto';
    this.platform = opts.platform ?? process.platform;
    this.osaTimeout = opts.osascriptTimeoutMs ?? 15_000;
    this.psTimeout = opts.psTimeoutMs ?? 5_000;
    this.defaultLines = opts.defaultLines ?? 80;
    this.maxLines = opts.maxLines ?? 400;
    this.host = {
      ctx,
      osascriptTimeoutMs: this.osaTimeout,
      typeBytes: (pane, payload) => this.keys(pane, payload),
      typeBytesIf: (pane, payload, expect) => this.keysIf(pane, payload, expect),
      runScript: (script, args, o) => this.runScript(script, args, o),
      checkPane: (pane) => this.checkPane(pane),
    };
  }

  async available(): Promise<boolean> {
    return this.platform === 'darwin' && Boolean(this.ctx.bins.osascript);
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
    if (!tty && pid !== undefined) tty = await this.ttyOfPid(pid);
    if (!tty) {
      this.lastError = { code: 'not_found', reason: 'the session is not attached to a terminal' };
      return null;
    }
    if (!(await this.available())) {
      this.lastError = { code: 'unsupported', reason: 'Terminal.app scripting is not available here' };
      return null;
    }
    const r = await this.osa(tty, 'find');
    if (!r.ok) {
      this.lastError = { code: r.code, reason: r.reason };
      return null;
    }
    const [wid = '', idx = '', ...rest] = r.out.split('\n');
    const id = terminalAppPaneId(tty);
    const pane: Pane = { id, backend: 'terminal-app', handle: `${wid.trim()}:${idx.trim()}`, tty, foreground: 'gone' };
    const title = rest.join(' ').trim();
    if (title) pane.title = title.slice(0, 200);
    if (pid !== undefined && Number.isInteger(pid) && pid > 0) pane.pid = pid;
    pane.foreground = await this.foregroundOf(pane);
    return pane;
  }

  async readScreen(pane: Pane, opts: { lines?: number } = {}): Promise<OpResult<{ text: string; at: string; tabRows?: number; raw: string }>> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    const n = Math.max(1, Math.min(this.maxLines, Math.floor(opts.lines ?? this.defaultLines)));
    const r = await this.osa(pane.tty, 'contents');
    if (!r.ok) return r.code === 'failed' ? fail('unreadable', r.reason) : r;
    // The first line is the tab's height (empty when Terminal didn't say), the rest its text.
    const nl = r.out.indexOf('\n');
    const head = nl < 0 ? r.out : r.out.slice(0, nl);
    const raw = nl < 0 ? '' : r.out.slice(nl + 1);
    const text = lastLines(raw, n).join('\n');
    const tabRows = TAB_ROWS_RE.test(head) ? Number(head) : null;
    return { ok: true, text, at: this.ctx.clock.iso(), ...(tabRows ? { tabRows } : {}), raw };
  }

  async readInputBox(pane: Pane): Promise<OpResult<{ text: string; styled: boolean }>> {
    const screen = await this.readScreen(pane, { lines: 60 });
    if (!screen.ok) return screen;
    const box = findInputBox(screenLines(screen.text));
    if (!box) return fail('unreadable', "Claude's input box isn't on screen");
    // Terminal's `contents` carries no colours: a dim suggestion reads like typed text.
    return { ok: true, text: box.text, styled: false };
  }

  async type(pane: Pane, text: string): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    if (FORBIDDEN_TEXT.test(text)) return fail('unsupported', 'the text contains control characters');
    const multi = /[\n\t]/u.test(text);
    const style = this.typing === 'auto' ? (multi ? 'paste' : 'plain') : this.typing;
    if (style === 'plain' && multi) return fail('unsupported', 'text with newlines or tabs needs bracketed paste');
    const payload = style === 'paste' ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;
    return this.keys(pane, payload);
  }

  async pressEnter(pane: Pane): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    return this.keys(pane, ENTER);
  }

  async clearInput(pane: Pane): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    return this.keys(pane, CLEAR_ONE_ROW);
  }

  async focus(pane: Pane): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    const r = await this.osa(pane.tty, 'focus');
    return r.ok ? { ok: true } : r;
  }

  async pressKey(pane: Pane, key: ControlKey, opts?: PressKeyOptions): Promise<OpResult> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    return pressKeyImpl(this.host, pane, key, opts);
  }

  async getScreenshot(pane: Pane, opts?: ScreenshotRequest): Promise<OpResult<TerminalShot>> {
    const bad = this.checkPane(pane);
    if (bad) return bad;
    return screenshotImpl(this.host, pane, opts);
  }

  async openWindow(command: string): Promise<OpResult<{ tty: string; windowId: string }>> {
    if (!(await this.available())) return fail('unsupported', 'Terminal.app scripting is not available here');
    // One open script at a time, daemon-wide: each reads the front window before its `do script` and
    // raises it again after, so two interleaved would put a launch window over the user's own.
    return this.opens.run('open-window', () => openWindowImpl(this.host, command));
  }

  async foregroundOf(pane: Pane): Promise<PaneForeground> {
    if (pane.backend !== 'terminal-app') return 'other';
    const r = await this.ctx.exec(this.ctx.bins.ps, foregroundPsArgs(ttyName(pane.tty)), {
      env: cLocale(this.ctx.env),
      timeoutMs: this.psTimeout,
    });
    if (r.spawnError || r.timedOut) return 'other';
    return classifyForeground(parsePsRows(r.stdout), pane.pid);
  }

  // -------------------------------------------------------------------------

  private checkPane(pane: Pane): Failure | null {
    if (pane.backend !== 'terminal-app') return fail('unsupported', `not a Terminal.app pane (${pane.backend})`);
    if (!normalizeTty(pane.tty)) return fail('not_found', 'the pane has no tty');
    return null;
  }

  private async keys(pane: Pane, payload: string): Promise<OpResult> {
    const r = await this.osa(pane.tty, 'type', payload);
    return r.ok ? { ok: true } : r;
  }

  private async keysIf(pane: Pane, payload: string, expect: readonly string[]): Promise<OpResult> {
    const r = await this.osa(pane.tty, 'typeif', payload, ...expect);
    return r.ok ? { ok: true } : r;
  }

  private async ttyOfPid(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const r = await this.ctx.exec(this.ctx.bins.ps, ['-o', 'tty=', '-p', String(pid)], {
      env: cLocale(this.ctx.env),
      timeoutMs: this.psTimeout,
    });
    if (r.code !== 0) return null;
    return normalizeTty(r.stdout.trim().split('\n')[0]);
  }

  /** Run a constant AppleScript (on stdin) with argv; failures classified, stdout without its last newline. */
  private async runScript(
    script: string,
    args: readonly string[],
    opts: { timeoutMs?: number; label?: string } = {},
  ): Promise<OpResult<{ out: string }>> {
    const bin = this.ctx.bins.osascript;
    if (!bin) return fail('unsupported', 'osascript is not available');
    const mode = opts.label ?? 'script';
    const r = await this.ctx.exec(bin, ['-', ...args], { input: script, timeoutMs: opts.timeoutMs ?? this.osaTimeout });
    if (r.spawnError) {
      // The spawn error can quote argv (the text), so it is not passed on.
      this.ctx.log.warn('osascript could not start', { mode });
      return fail('failed', 'osascript could not be started');
    }
    if (r.timedOut) return fail('timeout', 'Terminal did not answer in time');
    if (r.code !== 0) {
      const e = classifyOsascriptError(r.stderr);
      this.ctx.log.warn('osascript failed', { mode, code: e.code, reason: e.reason });
      return fail(e.code, e.reason);
    }
    return { ok: true, out: r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout };
  }

  private async osa(tty: string, mode: ScriptMode, ...more: string[]): Promise<OpResult<{ out: string }>> {
    const r = await this.runScript(TERMINAL_APP_SCRIPT, [tty, mode, ...more], { label: mode });
    if (!r.ok) return r;
    const out = r.out;
    if (out === MISSING) return fail('not_found', 'that Terminal tab is no longer open');
    if (out === NOT_RUNNING) return fail('not_found', 'Terminal is not running');
    if (out === BAD_MODE) return fail('failed', `unknown terminal script mode ${mode}`);
    if (out === CHANGED) return fail('changed', 'the terminal changed before Jantar typed');
    if (out === 'ok') return { ok: true, out: '' };
    if (out.startsWith('ok\n')) return { ok: true, out: out.slice(3) };
    return fail('failed', 'Terminal gave an unexpected answer');
  }
}
