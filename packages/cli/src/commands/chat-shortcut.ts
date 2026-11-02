/**
 * jantar chat shortcut (v0.10): the Siri door's chat keys. Built with the
 * door's own commit; until then the action says so.
 */
import type { Settings } from '@jantar/protocol';
import { UsageError } from '../args.js';
import type { CliContext } from '../command.js';

export const CHAT_SHORTCUT_HELP = '';

/** v0.10: still a shell until the Siri door is built (test/sentences.test.ts skips the sentences that name it). */
export const CHAT_SHORTCUT_SHELL: boolean = true;

/** The Siri door's line in `jantar chat status` (none yet). */
export async function doorLine(_ctx: CliContext, _s: Settings): Promise<string> {
  return '';
}

export async function runChatShortcut(_argv: readonly string[], _ctx: CliContext): Promise<number> {
  throw new UsageError('chat shortcut is not built yet');
}
