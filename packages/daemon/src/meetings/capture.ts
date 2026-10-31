/**
 * The extension's capture routes' logic (spec 4.7): info, open (an upsert on
 * the client id), lines (an empty list is the keep-alive), a screenshot,
 * end.
 *
 * - A meeting is "this tab's call": one row per (extension, client id). A
 *   404 on lines, a screenshot or end means one thing: no open meeting with
 *   this client id (unknown, ended, or deleted on the phone).
 * - Nothing is read before Start: a meeting a screenshot made (`captions:
 *   false`) refuses lines until an open with `captions: true` turns notes on,
 *   and notes never turn off again.
 * - Every write touches last_at (the stale sweep reads it). An open, a
 *   screenshot and an end tick; lines and the keep-alive never do.
 * - The extension's times are clamped: a start to now ± 5 minutes, a line or
 *   a screenshot to [start − 15 minutes, now + 5 minutes], an end to [start,
 *   now] (a start ahead of now ends at the start).
 * - A screenshot whose key is stored answers its id, even once its meeting
 *   has ended (a retry whose answer was lost). A new one is checked (an
 *   open meeting, a JPEG by its first bytes, at most 4 MB, 500 a meeting,
 *   core.shotsTotalMax in all) before files.ts writes it. A write that fails
 *   (a folder that is not a real directory, a full or unwritable disk) is
 *   409 with its sentence, never a 5xx: the extension reads a 5xx as Jantar
 *   not running. The store is read
 *   again after the write (Meetings may have turned off, the meeting been
 *   deleted, or another upload taken the room or the key), and a file whose
 *   row was not added is removed. A meeting that ended meanwhile (an End,
 *   the stale sweep) still takes it: the click came before the end.
 * - Logs carry codes only: never a name, a line or a path.
 */
import { MEETING_LIMITS, MEETING_SHOT_MAX_BYTES, type ExtEndBody, type ExtInfo, type ExtLinesBody, type ExtOpenBody, type ExtShotBody } from '@jantar/protocol';
import type { Logger, MeetingCapture, MeetingRecord, MeetingRow, MeetingsCore, MeetingsResult, MeetingsStore, StoredLine } from '../contracts.js';
import { CLOSED, MEETING_REASONS, clamp, emptySummary, iso, knownProject, projectsById, refuse, summaryAfterEnd } from './common.js';
import { dropShot, errorKind, shotDir, writeShot } from './files.js';

const MINUTE_MS = 60_000;
/** How far ahead of the Mac the extension's clock may say a start, a line or a screenshot happened. */
const AHEAD_MS = 5 * MINUTE_MS;
/** How long before the meeting's start a line or a screenshot may be (Start pressed mid-sentence). */
const BEFORE_START_MS = 15 * MINUTE_MS;
/** ExtInfoSchema caps the assign sheet's projects here. */
const INFO_PROJECTS_MAX = 200;
/** A caption line whose speaker the site did not name. */
export const UNKNOWN_SPEAKER = 'Unknown';
/** What every screenshot's data URL starts with (ExtShotBodySchema checks it). */
export const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

const OK: MeetingsResult = { ok: true, value: true };

/** Control characters become spaces, runs of white space one space, trimmed. */
export function cleanText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** The assign sheet's choices over a record (name, people, the todos switch); Start turns notes on for good. */
function assigned(r: MeetingRecord, body: ExtOpenBody): MeetingRecord {
  const next: MeetingRecord = { ...r, name: body.name, autoTodos: body.autoTodos, notes: r.notes || body.captions };
  if (body.people !== undefined) next.people = body.people;
  else delete next.people;
  return next;
}

class Capture implements MeetingCapture {
  private readonly log: Logger;

  constructor(private readonly core: MeetingsCore) {
    this.log = core.ctx.log.child({ part: 'meetings' });
  }

  private now(): number {
    return this.core.ctx.clock.now();
  }

  /** This tab's meeting while it is open. */
  private openRow(store: MeetingsStore, extId: string, clientId: string): MeetingRow | null {
    const m = store.byClient(extId, clientId);
    return m && m.endedAt === null ? m : null;
  }

  info(): MeetingsResult<ExtInfo> {
    const projects = projectsById(this.core);
    if (!projects) return { ok: true, value: { projects: null } };
    const active = [...projects.values()]
      .filter((p) => p.status === 'active')
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id))
      .slice(0, INFO_PROJECTS_MAX)
      .map((p) => ({ id: p.id, name: p.name, ...(p.emoji ? { emoji: p.emoji } : {}) }));
    return { ok: true, value: { projects: active } };
  }

  open(extId: string, clientId: string, body: ExtOpenBody): MeetingsResult<{ id: string }> {
    const store = this.core.store();
    if (!store) return CLOSED;
    const now = this.now();
    const found = store.byClient(extId, clientId);
    if (found) {
      if (found.endedAt !== null) return refuse('conflict', MEETING_REASONS.ended);
      // A screenshot's open (captions false) changes nothing a Start chose.
      if (body.captions) {
        store.update(found.id, (r) => assigned(r, body));
        store.setProject(found.id, knownProject(this.core, body.projectId));
      }
      store.touch(found.id, iso(now));
      this.core.changed();
      return { ok: true, value: { id: found.id } };
    }
    if (store.count() >= MEETING_LIMITS.meetings) return refuse('conflict', MEETING_REASONS.meetingsFull);
    const id = this.core.newId();
    store.create({
      id,
      extId,
      clientId,
      startedAt: iso(clamp(body.at, now - AHEAD_MS, now + AHEAD_MS)),
      endedAt: null,
      lastAt: iso(now),
      projectId: knownProject(this.core, body.projectId),
      record: assigned({ name: body.name, site: body.site, autoTodos: body.autoTodos, notes: false, summary: emptySummary() }, body),
    });
    this.core.changed();
    return { ok: true, value: { id } };
  }

  lines(extId: string, clientId: string, body: ExtLinesBody): MeetingsResult {
    const store = this.core.store();
    if (!store) return CLOSED;
    const m = this.openRow(store, extId, clientId);
    if (!m) return refuse('not_found', MEETING_REASONS.notOpen);
    const now = this.now();
    if (body.lines.length === 0) {
      // The keep-alive: the call is still on. No tick.
      store.touch(m.id, iso(now));
      return OK;
    }
    if (!m.record.notes) return refuse('conflict', MEETING_REASONS.notesOff);
    const start = Date.parse(m.startedAt);
    const lines: StoredLine[] = [];
    for (const l of body.lines) {
      const text = cleanText(l.text);
      // Nothing but white space: a later revision says more. It takes no room under the cap.
      if (!text) continue;
      const speaker = cleanText(l.speaker) || UNKNOWN_SPEAKER;
      lines.push({ lineId: l.lineId, rev: l.rev, at: clamp(l.at, start - BEFORE_START_MS, now + AHEAD_MS), speaker, text });
    }
    const { keep, full } = this.withinCap(store, m.id, lines);
    if (keep.length > 0) store.upsertLines(m.id, keep);
    store.touch(m.id, iso(now));
    return full ? refuse('conflict', MEETING_REASONS.linesFull) : OK;
  }

  /**
   * The lines a post may store: all of them below the cap; near it, new
   * revisions of stored lines and new lines while they fit (`full` once one
   * did not). Only near the cap are the stored ids read.
   */
  private withinCap(store: MeetingsStore, id: string, lines: readonly StoredLine[]): { keep: readonly StoredLine[]; full: boolean } {
    const stored = store.lineCount(id);
    if (stored + lines.length <= MEETING_LIMITS.linesPerMeeting) return { keep: lines, full: false };
    const known = store.knownLineIds(id, lines.map((l) => l.lineId));
    let room = MEETING_LIMITS.linesPerMeeting - stored;
    let full = false;
    const keep = lines.filter((l) => {
      if (known.has(l.lineId)) return true;
      if (room <= 0) {
        full = true;
        return false;
      }
      room -= 1;
      known.add(l.lineId);
      return true;
    });
    return { keep, full };
  }

  /** Room for one more screenshot of `size` bytes in this meeting and in Jantar. */
  private room(store: MeetingsStore, id: string, size: number): MeetingsResult {
    if (store.shotCount(id) >= MEETING_LIMITS.shotsPerMeeting) return refuse('conflict', MEETING_REASONS.shotsFull);
    if (store.shotBytesTotal() + size > this.core.shotsTotalMax) return refuse('conflict', MEETING_REASONS.shotsDiskFull);
    return OK;
  }

  async shot(extId: string, clientId: string, body: ExtShotBody): Promise<MeetingsResult<{ id: string }>> {
    const store = this.core.store();
    if (!store) return CLOSED;
    const m = store.byClient(extId, clientId);
    if (!m) return refuse('not_found', MEETING_REASONS.notOpen);
    // A retry, its meeting ended since included: the stored id, nothing written.
    const known = store.shotByKey(m.id, body.key);
    if (known) return { ok: true, value: { id: known.id } };
    if (m.endedAt !== null) return refuse('not_found', MEETING_REASONS.notOpen);
    const bytes = Buffer.from(body.image.slice(JPEG_DATA_URL_PREFIX.length), 'base64');
    if (!isJpeg(bytes)) return refuse('invalid_request', MEETING_REASONS.notJpeg);
    if (bytes.length > MEETING_SHOT_MAX_BYTES) return refuse('invalid_request', MEETING_REASONS.shotTooLarge);
    const room = this.room(store, m.id, bytes.length);
    if (!room.ok) return room;

    const at = clamp(body.at, Date.parse(m.startedAt) - BEFORE_START_MS, this.now() + AHEAD_MS);
    const shotId = this.core.newId();
    let path: string;
    try {
      const dir = await shotDir(this.core.ctx.paths.meetingsDir, m.id);
      if (!dir) {
        this.log.error('meetings: a screenshot folder is not a real directory; nothing written', { event: 'meetings.shot_refused' });
        return refuse('conflict', MEETING_REASONS.shotNotSaved);
      }
      path = await writeShot(dir, shotId, bytes);
    } catch (e) {
      this.log.warn('meetings: a screenshot was not written', { error: errorKind(e) });
      return refuse('conflict', MEETING_REASONS.shotNotSaved);
    }

    // The write awaited: everything above may have changed.
    const after = this.core.store();
    const kept = after ? this.keep(after, m.id, { id: shotId, key: body.key, at, bytes: bytes.length }) : CLOSED;
    if (!kept.ok || kept.value.id !== shotId) await dropShot(path);
    return kept;
  }

  /**
   * Add the written screenshot's row (synchronous: nothing can come between
   * the checks and the insert). The meeting must still exist; it need not
   * still be open, since the click came before an end that landed meanwhile.
   */
  private keep(store: MeetingsStore, id: string, shot: { id: string; key: string; at: number; bytes: number }): MeetingsResult<{ id: string }> {
    if (!store.get(id)) return refuse('not_found', MEETING_REASONS.notOpen);
    const known = store.shotByKey(id, shot.key);
    if (known) return { ok: true, value: { id: known.id } };
    const room = this.room(store, id, shot.bytes);
    if (!room.ok) return room;
    const added = store.addShot(id, shot);
    if (added.duplicate) return { ok: true, value: { id: added.id } };
    store.touch(id, iso(this.now()));
    this.core.changed();
    return { ok: true, value: { id: added.id } };
  }

  end(extId: string, clientId: string, body: ExtEndBody): MeetingsResult<{ id: string; lines: number; shots: number }> {
    const store = this.core.store();
    if (!store) return CLOSED;
    const m = store.byClient(extId, clientId);
    if (!m) return refuse('not_found', MEETING_REASONS.notOpen);
    const value = { id: m.id, lines: store.lineCount(m.id), shots: store.shotCount(m.id) };
    // Ended already (the tab's close after End, a retry): the same answer, nothing changes.
    if (m.endedAt !== null) return { ok: true, value };
    const start = Date.parse(m.startedAt);
    // Never after now: an end ahead of the Mac's clock would make the call look longer.
    store.end(m.id, iso(clamp(body.at, start, Math.max(start, this.now()))), body.reason);
    summaryAfterEnd(this.core, store, m);
    this.core.changed();
    return { ok: true, value };
  }
}

export function buildCapture(core: MeetingsCore): MeetingCapture {
  return new Capture(core);
}
