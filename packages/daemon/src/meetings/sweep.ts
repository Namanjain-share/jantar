/**
 * The sweep (spec 4.8), run by the shell when meetings.db opens and every
 * 5 minutes while it is open (`library.sweep(now)`):
 *
 * - An open meeting nothing was heard from for MEETING_STALE_MS (no line,
 *   keep-alive, screenshot or open) is ended 'stale' at the last time it was
 *   heard from, its summary queued as an end would. The extension's
 *   keep-alive (an empty lines post a minute while the tab is in the call)
 *   keeps a quiet meeting open; Chrome quitting, a crash or a navigation
 *   away stops it. The library runs endStale only once meetings.db has been
 *   open for MEETING_STALE_MS, so time Jantar was down or Meetings off does
 *   not count as quiet; nor does a Mac asleep (a gap between two sweeps of
 *   more than two periods starts the count again).
 * - A folder in <meetingsDir> named by a ulid that no meeting owns (a
 *   delete whose folder would not go, a screenshot written for a meeting
 *   deleted meanwhile) is removed. Nothing else there is ever touched, and
 *   nothing inside a live meeting's folder.
 */
import { MEETING_STALE_MS } from '@jantar/protocol';
import type { Logger, MeetingsCore } from '../contracts.js';
import { iso, summaryAfterEnd } from './common.js';
import { errorKind, meetingDirNames, removeMeetingDir } from './files.js';

/** How often the shell sweeps while meetings.db is open. */
export const MEETINGS_SWEEP_EVERY_MS = 5 * 60_000;

/** End the stale open meetings; answers how many. One tick for the lot. */
export function endStale(core: MeetingsCore, now: number): number {
  const store = core.store();
  if (!store) return 0;
  // Quiet for the whole limit or longer (staleOpen reads last_at < before).
  const stale = store.staleOpen(iso(now - MEETING_STALE_MS + 1));
  let ended = 0;
  for (const m of stale) {
    const at = m.lastAt > m.startedAt ? m.lastAt : m.startedAt;
    if (!store.end(m.id, at, 'stale')) continue;
    summaryAfterEnd(core, store, m);
    ended += 1;
  }
  if (ended > 0) core.changed();
  return ended;
}

/** Remove the orphan folders; answers how many. Stops when Meetings close meanwhile. */
export async function removeOrphans(core: MeetingsCore, log: Logger): Promise<number> {
  const dir = core.ctx.paths.meetingsDir;
  let removed = 0;
  for (const name of await meetingDirNames(dir)) {
    // Read again after every removal's await: null means Meetings closed.
    const store = core.store();
    if (!store) break;
    // A row whose record fails its check still owns its screenshots.
    if (store.get(name) || store.shotCount(name) > 0) continue;
    try {
      if (await removeMeetingDir(dir, name)) removed += 1;
    } catch (e) {
      log.warn('meetings: an orphan folder was not removed', { error: errorKind(e) });
    }
  }
  if (removed > 0) log.info('meetings: orphan folders removed', { count: removed });
  return removed;
}
