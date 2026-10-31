/**
 * Terminal.app backend factory (work package D).
 *
 * `createTerminalAppBackend` is the `Factories['terminal']` entry wired in
 * main.ts. Tests and tools can build one with options through
 * `new TerminalAppBackend(ctx, opts)`.
 */
import type { Factories } from '../../contracts.js';
import { TerminalAppBackend } from './backend.js';

export const createTerminalAppBackend: Factories['terminal'] = (ctx) => new TerminalAppBackend(ctx);

export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  ENTER,
  TerminalAppBackend,
  classifyOsascriptError,
  terminalAppPaneId,
  type TerminalAppError,
  type TerminalAppOptions,
  type TypingStyle,
} from './backend.js';
export { TERMINAL_APP_SCRIPT, type ScriptMode } from './script.js';
export type { TerminalAppHost } from './host.js';
export { CLEAR_MAX_ROWS, CLEAR_ONE_ROW, KEY_BYTES, clearInputBytes } from './keys.js';
