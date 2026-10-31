/**
 * The controls service (work package C owns this file and the rest of
 * controls/ but index.ts): control keys behind gates (keys.ts), the
 * verified-step mode loop (modes.ts), slash commands through the writer with
 * proof (commands.ts) and screenshots with their cache and limits
 * (screenshot.ts). Shared gates and the lock live in common.ts. v0.4.2
 * adds the screen path's dialog answers (dialog.ts) and the keypad
 * (keypad.ts), lane L1's.
 *
 * Every key, step and command waits for the pane's writer lock, so nothing
 * here lands between a send's typing and its Enter. The routes are never
 * served on ctl.sock (a session must not press keys into itself), and the
 * API writes the audit rows: { sid, key, sent }, { sid, mode, steps },
 * { sid, name }, never screen or prompt text.
 */
import { DIALOG_GATES, type DialogGates } from '@jantar/protocol';
import type { ControlsService, DaemonContext } from '../contracts.js';
import { runCommand } from './commands.js';
import type { ControlsDeps } from './common.js';
import { answerDialog } from './dialog.js';
import { pressKeypad } from './keypad.js';
import { KeyControl } from './keys.js';
import { switchMode } from './modes.js';
import { Screenshots, sweepShots } from './screenshot.js';

export type { ControlsDeps } from './common.js';

/** `gates`: the shipped DIALOG_GATES for the screen path and the keypad; a test passes others. */
export function buildControlsService(ctx: DaemonContext, deps: ControlsDeps, gates: Readonly<DialogGates> = DIALOG_GATES): ControlsService {
  const keys = new KeyControl(ctx, deps);
  const shots = new Screenshots(ctx, deps);
  return {
    start: async () => {
      await sweepShots(ctx);
    },
    stop: async () => shots.clear(),
    key: (sid, key) => keys.press(sid, key),
    setMode: (sid, target) => switchMode(ctx, deps, sid, target),
    command: (sid, cmd, actor) => runCommand(ctx, deps, sid, cmd, actor),
    screenshot: (sid, opts, actor) => shots.take(sid, opts, actor),
    // v0.4.2: the screen path (dialog.ts) and the keypad (keypad.ts).
    answerDialog: (sid, body, actor) => answerDialog(ctx, deps, sid, body, actor, gates),
    keypad: (sid, body, actor) => pressKeypad(ctx, deps, sid, body, actor, gates),
  };
}
