/**
 * The v0.3 switches and Mac-only settings groups the CLI changes (files,
 * folders, launch, rewrite, controls, screenshots). A phone can never change
 * them (`PATCH /v1/settings` over TCP is refused for these groups), so the
 * daemon's "turn it on at your Mac" sentences name these commands.
 *
 * Changes go through the daemon over ctl.sock, which re-emits the feature
 * switches to every client at once; with the daemon down they land in
 * config.json (lib/settings.ts).
 */
import type { Settings } from '@jantar/protocol';
import { UsageError } from '../args.js';
import type { CliContext } from '../command.js';
import { updateSettings, type SettingsUpdate } from './settings.js';

export const SAVED_TO_FILE = 'Saved to config.json; the daemon picks it up when it starts.\n';

/** C0 controls, DEL and C1 controls: never stored in a setting the daemon types or sends on. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

export function hasControlChars(s: string): boolean {
  return CONTROL_RE.test(s);
}

export function onOff(v: boolean): string {
  return v ? 'on' : 'off';
}

/** "on" or "off" as a boolean; anything else is a usage error naming `what`. */
export function parseOnOff(word: string | undefined, what: string): boolean {
  if (word === 'on') return true;
  if (word === 'off') return false;
  throw new UsageError(word === undefined ? `${what}: say on or off` : `${what}: "${word}" is not on or off`);
}

/**
 * Apply a settings patch, print `describe(settings)` for the result, and say
 * when it went to config.json because the daemon is not running.
 */
export async function changeSettings(
  ctx: CliContext,
  patch: Record<string, unknown>,
  describe: (s: Settings) => string,
): Promise<SettingsUpdate> {
  const r = await updateSettings(ctx, patch);
  ctx.io.out(describe(r.settings));
  if (r.via === 'file') ctx.io.out(SAVED_TO_FILE);
  return r;
}
