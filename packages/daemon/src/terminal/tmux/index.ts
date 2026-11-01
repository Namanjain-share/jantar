/**
 * v0.6 Fleet: the tmux backend, for Linux nodes (spec 4.2; backend.ts says
 * what each operation does, write.ts the one write primitive, panes.ts how a
 * session is bound to its pane).
 *
 * It copies Terminal.app's one semantic: every key write ends with one
 * Return. One write primitive (`tmuxWrite`): text only ever enters tmux on
 * stdin (`load-buffer -b jantar-<ulid> -`), then one `if-shell -F -t %N
 * '<gate>' '<do>' '<else>'` whose gate checks the pane's tty, its modes
 * (copy mode, synchronized, input off, dead) and, for compare-and-type, the
 * expected lines (`#{C:}` with every character of GLOB_SPECIALS as `?`), and
 * whose command string holds only a validated `%N`, the buffer name, key
 * names and `send-keys -H` hex. No user, prompt or screen text is ever an
 * argv item or part of a tmux command string (tmux eats a trailing `;` and
 * parses an if-shell command again). A write is bound to the session's own
 * pane by tty (or pid ancestry), never by a pane id alone. The default tmux
 * server only; tests pass a private socket. Real tmux runs only in Docker or
 * Linux CI, never on the build Mac.
 */
import type { DaemonContext, TerminalBackend } from '../../contracts.js';
import { TmuxBackend } from './backend.js';

export interface TmuxBackendOptions {
  /** A private server's socket (`-S <path>` in every argv): tests only. Production uses the default server. */
  socket?: string;
  /** Where `<pid>/stat` is read for pid ancestry (default /proc): tests only. */
  procRoot?: string;
}

export function createTmuxBackend(ctx: DaemonContext, opts: TmuxBackendOptions = {}): TerminalBackend {
  return new TmuxBackend(ctx, opts);
}

export { ENTER_AFTER_TEXT_MS, NO_PANE, OPEN_COLS, OPEN_ROWS, TICK_MS, TmuxBackend, tmuxVersionOk } from './backend.js';
export { ANCESTRY_MAX, LIST_FORMAT, ancestorsOf, bindPane, parentFromStat, parsePaneRows, type TmuxPaneRow } from './panes.js';
export { FIELD_SEP, GATE_LINES_MAX, GLOB_SPECIALS, JANTAR_CHANGED, gateLines, hexTokens, tmuxGate, tmuxWrite, type TmuxWrite } from './write.js';
