/**
 * The meeting library (spec 4.8): what the phone and the CLI read and edit.
 *
 * - list: newest first by (start, id) with the store's cursor, a project
 *   ('none' is no project) and a search over name, people, summary and
 *   lines; `running` is the newest open meeting whatever the filter. Each
 *   row carries its line and screenshot counts, its summary's state and
 *   `gist` (the summary's first 160 characters).
 * - get: the meeting, its summary block, every line (its stored revision,
 *   in transcript order: common.ts linesInOrder) and every screenshot, by
 *   time, with times as ISO.
 * - shotFile: the bytes of a screenshot row of that meeting (files.ts reads
 *   them without following a link); another meeting's shot id is 404.
 * - update: name, project (null clears; an unknown one is 404), people
 *   (null clears); the todos switch only while no summary runs or is done
 *   (a failed one added nothing, and Try again reads the new value).
 * - remove: the rows (lines and screenshot rows go with the meeting; an
 *   open one simply stops existing, so no summary is queued; a summary
 *   running for it is stopped), then the folder. A folder that will not go is logged by code; the sweep removes
 *   it later. The extension's next line or screenshot for that call is 404.
 * - sweep: sweep.ts. Quiet time counts from the later of a meeting's
 *   last_at and the first sweep of this meetings.db (the shell's, as it
 *   opens): nothing is heard while Jantar is down or Meetings are off, and
 *   a tab still in the call keeps its lines and retries every 2 s, so an
 *   open meeting is never ended before it could be heard again. A sweep
 *   more than two periods after the last one (the Mac slept) counts again
 *   from then, as a new open does.
 *
 * Every edit ticks (`life.changed {}`); reads never do. `projectName` is
 * there only while Todos are on and the project still exists.
 */
import { MEETING_STALE_MS, type MeetingDetail, type MeetingPatch, type MeetingsList, type MeetingsQuery } from '@jantar/protocol';
import type { Actor, Logger, MeetingLibrary, MeetingRecord, MeetingRow, MeetingsCore, MeetingsResult, MeetingsStore } from '../contracts.js';
import { CLOSED, MEETING_REASONS, iso, knownProject, linesInOrder, meetingOf, projectsById, refuse } from './common.js';
import { errorKind, readShot, removeMeetingDir } from './files.js';
import { MEETINGS_SWEEP_EVERY_MS, endStale, removeOrphans } from './sweep.js';

const OK: MeetingsResult = { ok: true, value: true };

/** The phone's edit over a record: a null clears people. */
function edited(r: MeetingRecord, patch: MeetingPatch): MeetingRecord {
  const next: MeetingRecord = { ...r };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.people === null) delete next.people;
  else if (patch.people !== undefined) next.people = patch.people;
  if (patch.autoTodos !== undefined) next.autoTodos = patch.autoTodos;
  return next;
}

class Library implements MeetingLibrary {
  private readonly log: Logger;
  /**
   * The store the sweep last saw, when it began listening to it (a new store
   * is meetings.db opened again) and when it last swept it.
   */
  private listening: { store: MeetingsStore; since: number; last: number } | null = null;

  constructor(private readonly core: MeetingsCore) {
    this.log = core.ctx.log.child({ part: 'meetings' });
  }

  private counts(store: MeetingsStore, row: MeetingRow): { lines: number; shots: number } {
    return { lines: store.lineCount(row.id), shots: store.shotCount(row.id) };
  }

  list(q: MeetingsQuery): MeetingsResult<MeetingsList> {
    const store = this.core.store();
    if (!store) return CLOSED;
    const page = store.list(q);
    const projects = projectsById(this.core);
    const view = (row: MeetingRow) => meetingOf(row, this.counts(store, row), projects, { gist: true });
    const running = store.newestOpen();
    return { ok: true, value: { meetings: page.rows.map(view), next: page.next, running: running ? view(running) : null } };
  }

  get(id: string): MeetingsResult<MeetingDetail> {
    const store = this.core.store();
    if (!store) return CLOSED;
    const row = store.get(id);
    if (!row) return refuse('not_found', MEETING_REASONS.noMeeting);
    const lines = linesInOrder(store, id).map((l) => ({ id: l.lineId, at: iso(l.at), speaker: l.speaker, text: l.text }));
    const shots = store.shots(id).map((s) => ({ id: s.id, at: iso(s.at), bytes: s.bytes }));
    return {
      ok: true,
      value: {
        meeting: meetingOf(row, { lines: lines.length, shots: shots.length }, projectsById(this.core)),
        summary: row.record.summary,
        lines,
        shots,
      },
    };
  }

  shotSize(id: string, shotId: string): MeetingsResult<{ bytes: number }> {
    const store = this.core.store();
    if (!store) return CLOSED;
    const shot = store.shot(id, shotId);
    return shot ? { ok: true, value: { bytes: shot.bytes } } : refuse('not_found', MEETING_REASONS.noShot);
  }

  async shotFile(id: string, shotId: string): Promise<MeetingsResult<{ body: Buffer }>> {
    const store = this.core.store();
    if (!store) return CLOSED;
    if (!store.shot(id, shotId)) return refuse('not_found', MEETING_REASONS.noShot);
    let body: Buffer | null;
    try {
      body = await readShot(this.core.ctx.paths.meetingsDir, id, shotId);
    } catch (e) {
      this.log.warn('meetings: a screenshot was not read', { error: errorKind(e) });
      return refuse('unavailable', MEETING_REASONS.shotNotRead);
    }
    // The read awaited: Meetings may have closed or the meeting been deleted.
    const after = this.core.store();
    if (!after) return CLOSED;
    if (!body || !after.shot(id, shotId)) return refuse('not_found', MEETING_REASONS.noShot);
    return { ok: true, value: { body } };
  }

  update(id: string, patch: MeetingPatch, _actor: Actor): MeetingsResult {
    const store = this.core.store();
    if (!store) return CLOSED;
    const row = store.get(id);
    if (!row) return refuse('not_found', MEETING_REASONS.noMeeting);
    // The switch can change until a summary has added items: not while one runs or once it is done (a failed one added none).
    const state = row.record.summary.state;
    if (patch.autoTodos !== undefined && patch.autoTodos !== row.record.autoTodos && (state === 'running' || state === 'done')) {
      return refuse('conflict', MEETING_REASONS.summaryRan);
    }
    if (patch.projectId && !knownProject(this.core, patch.projectId)) return refuse('not_found', MEETING_REASONS.projectGone);
    store.update(id, (r) => edited(r, patch));
    if (patch.projectId !== undefined) store.setProject(id, patch.projectId);
    this.core.changed();
    return OK;
  }

  async remove(id: string, _actor: Actor): Promise<MeetingsResult> {
    const store = this.core.store();
    if (!store) return CLOSED;
    if (!store.remove(id)) return refuse('not_found', MEETING_REASONS.noMeeting);
    this.core.cancelSummary(id);
    this.core.changed();
    try {
      if (!(await removeMeetingDir(this.core.ctx.paths.meetingsDir, id))) {
        this.log.error('meetings: the meetings folder is not a real directory; a meeting folder was left', { event: 'meetings.folder_left' });
      }
    } catch (e) {
      this.log.warn('meetings: a meeting folder was not removed', { error: errorKind(e) });
    }
    return OK;
  }

  async sweep(now: number): Promise<void> {
    const store = this.core.store();
    if (!store) return;
    if (this.listening?.store !== store) this.listening = { store, since: now, last: now };
    // A sweep far later than the timer's period: the Mac slept, and a tab's keep-alive could not land meanwhile.
    if (now - this.listening.last > 2 * MEETINGS_SWEEP_EVERY_MS) this.listening.since = now;
    this.listening.last = now;
    // Listening for less than the limit: no meeting can have been quiet that long while Jantar could hear it.
    if (now - this.listening.since >= MEETING_STALE_MS) endStale(this.core, now);
    await removeOrphans(this.core, this.log);
  }
}

export function buildLibrary(core: MeetingsCore): MeetingLibrary {
  return new Library(core);
}
