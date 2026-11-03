/**
 * v0.13 Work: what Work's routes and the project hub share about meetings.
 * Work never reads meetings.db: a route reads the meeting here (Meetings'
 * off sentence while Meetings is off) and hands Work its id, project, start
 * and people; a log's meeting rows are named here from meetings.db, and a
 * row whose meeting is gone is left out.
 */
import type { WorkLogRow } from '@jantar/protocol/work';
import type { LifeResult, WorkMeetingRef } from '../contracts.js';
import { ApiError } from './errors.js';
import { lifeValue } from './route-kit.js';
import type { ApiServices } from './services.js';

/** Meetings' off sentence (app.ts FEATURE_OFF.meetings, which a test pins it to; this file can't import app.ts: a cycle). */
export const MEETINGS_OFF = 'Meetings are off. Turn them on at your Mac: jantar meetings on';

/** Meetings must be on and open for a meeting route: its off sentence (or its broken one) otherwise. */
function meetingsOn(s: ApiServices): void {
  if (!s.ctx.settings.get().meetings.enabled) throw new ApiError('forbidden', MEETINGS_OFF);
  const broken = s.deps.meetings.broken();
  if (broken) throw new ApiError('unavailable', broken);
}

/** The meeting a route names, as Work needs it (read from meetings.db here, never by Work). */
export function meetingOf(s: ApiServices, id: string): WorkMeetingRef & { name: string; people: string[] } {
  meetingsOn(s);
  return lifeValue(s.deps.meetings.library.brief(id) as LifeResult<WorkMeetingRef & { name: string; people: string[] }>);
}

/**
 * A log's meeting rows named from meetings.db (its name and start), while Meetings is on; a row whose
 * meeting is gone is left out. While Meetings is off or closed the rows stay as they are, unnamed.
 */
export function namedMeetings(s: ApiServices, rows: WorkLogRow[]): WorkLogRow[] {
  if (!rows.some((r) => r.meetingId) || !s.ctx.settings.get().meetings.enabled || s.deps.meetings.broken()) return rows;
  const out: WorkLogRow[] = [];
  for (const r of rows) {
    if (!r.meetingId) {
      out.push(r);
      continue;
    }
    const m = s.deps.meetings.library.brief(r.meetingId);
    if (m.ok) out.push({ ...r, meeting: { name: m.value.name, startedAt: m.value.startedAt } });
    else if (m.code !== 'not_found') out.push(r);
  }
  return out;
}
