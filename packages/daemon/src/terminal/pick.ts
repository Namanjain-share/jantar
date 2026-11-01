/**
 * v0.6 Fleet: which terminal backend a daemon runs with. The hub is a Mac
 * and keeps Terminal.app, as before. A node picks by platform: macOS
 * Terminal.app, Linux tmux, Windows none (watch and cards only: Windows
 * Terminal cannot be typed into from outside, so the node's Controls and
 * starting sessions are off there).
 */
import type { NodeBackend } from '@jantar/protocol';
import type { DaemonContext, DaemonRole, TerminalBackend } from '../contracts.js';
import { NullTerminalBackend, type DaemonMode, type TerminalMode } from '../modes.js';
import { createTerminalAppBackend } from './terminal-app/index.js';
import { createTmuxBackend } from './tmux/index.js';

export interface PickedTerminal {
  backend: TerminalBackend;
  mode: TerminalMode;
}

export function pickTerminal(ctx: DaemonContext, role: DaemonRole, platform: NodeJS.Platform = process.platform): PickedTerminal {
  if (role === 'hub' || platform === 'darwin') return { backend: createTerminalAppBackend(ctx, {}), mode: 'terminal-app' };
  if (platform === 'linux') return { backend: createTmuxBackend(ctx, {}), mode: 'tmux' };
  return { backend: new NullTerminalBackend(), mode: 'none' };
}

/** What a node reports as its backend (its `auth` frame, the phone's machine line). */
export function nodeBackendOf(mode: Pick<DaemonMode, 'terminal'>, terminal: Pick<TerminalBackend, 'kind'>): NodeBackend {
  if (mode.terminal === 'none' || mode.terminal === 'off') return 'none';
  return terminal.kind === 'tmux' ? 'tmux' : 'terminal-app';
}
