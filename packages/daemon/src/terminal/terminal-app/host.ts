/**
 * What the Terminal.app backend lends to its v0.3 helpers (keys.ts, shot.ts,
 * open-window.ts), so they never reach into its private parts and the public
 * TerminalBackend never grows a "type any bytes" method.
 */
import type { Pane } from '@jantar/protocol';
import type { DaemonContext, OpResult, TerminalErrorCode } from '../../contracts.js';

export interface TerminalAppHost {
  readonly ctx: DaemonContext;
  /** osascript timeout per call, ms. */
  readonly osascriptTimeoutMs: number;
  /**
   * `do script <payload> in <the pane's tab>` through TERMINAL_APP_SCRIPT's
   * `type` mode, with NO text checks. Only keys.ts calls it, and only with
   * bytes from its own whitelist. Terminal appends one Return to every call
   * (the existing pressEnter and clearInput rely on that being harmless in an
   * empty box). Never focuses or selects the tab.
   */
  typeBytes(pane: Pane, payload: string): Promise<OpResult>;
  /**
   * v0.4.2: the same write through the script's `typeif` mode
   * (compare-and-type): typed only if the tab's text, read in that same
   * run, still contains `expect` exactly; otherwise nothing is typed and the
   * result is `{ok: false, code: 'changed'}`. Only keys.ts calls it, with
   * its own bytes. Optional: a host without it can't check, so keys.ts
   * refuses.
   */
  typeBytesIf?(pane: Pane, payload: string, expect: string): Promise<OpResult>;
  /**
   * Run another constant AppleScript: `osascript - <args...>` with `script`
   * on stdin and every value in argv (nothing interpolated, as script.ts).
   * Spawn failures, timeouts and non-zero exits come back classified like the
   * backend's own (classifyOsascriptError); `out` is stdout without its last
   * newline. `label` names the call in logs (never argv).
   */
  runScript(script: string, args: readonly string[], opts?: { timeoutMs?: number; label?: string }): Promise<OpResult<{ out: string }>>;
  /** The backend's own pane checks (a Terminal.app pane with a tty), or null when fine. */
  checkPane(pane: Pane): { ok: false; code: TerminalErrorCode; reason: string } | null;
}
