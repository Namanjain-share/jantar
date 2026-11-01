/**
 * v0.6 Fleet: the tmux backend, for Linux nodes (lane L2). STUB from wave 0:
 * `available()` is false and every write is unsupported until L2 replaces
 * this file, keeping `createTmuxBackend(ctx, opts)`, TmuxBackendOptions,
 * tmuxWrite, tmuxGate, GLOB_SPECIALS and JANTAR_CHANGED.
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
import type { Pane, PaneForeground } from '@jantar/protocol';
import type { DaemonContext, OpResult, TerminalBackend } from '../../contracts.js';

export interface TmuxBackendOptions {
  /** A private server's socket (`-S <path>` in every argv): tests only. Production uses the default server. */
  socket?: string;
}

/** What the gated command's else branch prints: the screen changed (or the pane is no longer the session's), nothing was typed. */
export const JANTAR_CHANGED = 'JANTAR-CHANGED';

/** Characters a `#{C:}` pattern treats specially (and `#`, which starts a format): each becomes `?` in the gate. */
export const GLOB_SPECIALS = '#,{}*?[]\\';

/** One gated write's parts: text through the buffer, key bytes, one Return, and the lines that must still show. */
export interface TmuxWrite {
  text?: string;
  /** Key bytes (as Terminal.app's KEY_BYTES give them). */
  keys?: string;
  enter: boolean;
  expect?: string | readonly string[];
}

const NOT_BUILT = 'The tmux backend is not built yet';

/** The `if-shell -F` gate for a pane on `tty`, with the expected lines when given. */
export function tmuxGate(_expect: string | readonly string[] | undefined, _tty: string): string {
  throw new Error(NOT_BUILT);
}

/** The one write primitive (load-buffer on stdin, then one gated if-shell). */
export async function tmuxWrite(_ctx: DaemonContext, _opts: TmuxBackendOptions, _pane: Pane, _write: TmuxWrite): Promise<OpResult> {
  return { ok: false, code: 'unsupported', reason: NOT_BUILT };
}

const unsupported = async (): Promise<OpResult> => ({ ok: false, code: 'unsupported', reason: NOT_BUILT });

export function createTmuxBackend(_ctx: DaemonContext, _opts: TmuxBackendOptions = {}): TerminalBackend {
  return {
    kind: 'tmux',
    available: async () => false,
    findPane: async () => null,
    readScreen: async () => ({ ok: false, code: 'unsupported', reason: NOT_BUILT }),
    readInputBox: async () => ({ ok: false, code: 'unsupported', reason: NOT_BUILT }),
    type: unsupported,
    pressEnter: unsupported,
    clearInput: unsupported,
    focus: unsupported,
    foregroundOf: async (): Promise<PaneForeground> => 'gone',
    openWindow: async () => ({ ok: false, code: 'unsupported', reason: NOT_BUILT }),
    pressKey: unsupported,
  };
}
