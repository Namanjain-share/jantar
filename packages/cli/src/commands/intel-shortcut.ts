/**
 * jantar intel shortcut (v0.8): the iOS Shortcut's capture keys, at the Mac
 * only (ctl.sock, `localOnly` routes):
 *
 *   intel shortcut add [--name iphone]   a new key, printed once, with the
 *                                        door's URL and the Shortcut's steps
 *                                        (or why the door is closed: loopback
 *                                        and lan modes have none)
 *   intel shortcut list                  the active keys (never a key)
 *   intel shortcut revoke <id|--all>
 *
 * `jantar intel` hands everything after `shortcut` here unparsed, so this
 * file owns its flags. Wave 0's shell until lane C builds it: a run says
 * "Not built yet."
 */
import { EXIT, type CliContext } from '../command.js';

/** v0.8 wave 0: still a shell; lane C sets it false when it builds the keys (test/sentences.test.ts skips the sentences until then). */
export const SHORTCUT_SHELL: boolean = true;

/** The help lines `jantar intel --help` shows for it. */
export const SHORTCUT_HELP =
  '  intel shortcut add [--name <n>] a key for the iOS Shortcut "Save to Jantar", shown once, with its steps\n' +
  '  intel shortcut list | revoke <id|--all>\n' +
  '                                 the Shortcut keys (never a key), or stop one or all of them\n';

export async function runShortcut(_argv: readonly string[], ctx: CliContext): Promise<number> {
  ctx.io.err('Not built yet.\n');
  return EXIT.usage;
}
