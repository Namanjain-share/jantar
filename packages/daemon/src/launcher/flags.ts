/**
 * Where the start sheet's pickers begin (U7): the picks the phone already
 * changed, then this actor's last start, then launch.defaultFlags. The
 * daemon remembers each actor's flags on every start (db.launchFlags, keyed
 * by "device:<id>" or "cli"). Flags only ever become argv through
 * `launchFlagArgs`.
 */
import { LaunchFlagsSchema, type LaunchFlags, type LaunchPreviewQuery } from '@jantar/protocol';

export type FlagPicks = Partial<Pick<LaunchPreviewQuery, 'permission' | 'chrome' | 'effort' | 'model'>>;

export function startingFlags(picks: FlagPicks, last: LaunchFlags | null, defaults: LaunchFlags): LaunchFlags {
  // A stored row from an older schema falls back to the defaults rather than failing the preview.
  const base = last && LaunchFlagsSchema.safeParse(last).success ? last : defaults;
  return {
    permission: picks.permission ?? base.permission,
    chrome: picks.chrome ?? base.chrome,
    effort: picks.effort ?? base.effort,
    model: picks.model ?? base.model,
  };
}
