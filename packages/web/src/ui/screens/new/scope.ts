/**
 * The missing-`launch`-scope refusal, in words: how a 403 is recognised and
 * what to run on the Mac. Shared by New session (re-exported from data.ts)
 * and Files' New folder (0.10.1); kept apart from data.ts so the Files
 * chunk takes only these few lines.
 */
import { CLI_NAME } from '@jantar/protocol';
import { isApiError } from '../../../lib/api.js';
import { deviceNoun, readLocalDevice, userAgent } from '../devices/local.js';

/**
 * A 403 for a missing scope ("this device does not have the launch scope").
 * Scopes stored at pairing go stale after `devices grant` on the Mac, so the
 * screen learns it this way, never from what it stored.
 */
export function isNoScope(e: unknown): boolean {
  return isApiError(e, 'forbidden') && /\bscope\b/i.test(e.message);
}

/** A device name as one shell word ("iPhone", 'Sam'\''s iPhone'). */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9._@%+=:,/-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/** What to run on the Mac to let this device start sessions. There is no grant button: the daemon refuses it over the network. */
export function grantCommand(): string {
  const me = readLocalDevice();
  return `${CLI_NAME} devices grant ${me ? shellWord(me.name) : '<device>'} launch`;
}

/** "This phone can't start sessions." (or tablet, browser) */
export function noScopeLead(): string {
  return `This ${deviceNoun(userAgent())} can't start sessions.`;
}
