/**
 * v0.11 People (P2): her sleep log (spec 3.12, O10). One row per night in
 * her space (`sleep_logs`), keyed by the evening it started.
 *
 * - Manual first: she adds, corrects and deletes any night. Quick buttons:
 *   "Going to sleep" opens a night (at most 12 h back, one open at a time,
 *   409 `open`); "Woke up" closes it with an optional quality and note
 *   (409 `none_open` with none open). Both are idempotent on a client id.
 * - No invented times: an open night closes 20 h after bedtime as "wake time
 *   not logged" (`wake_at` = '', `noWake`), by the scheduler (`sleep_close`).
 * - While a night is open (at most 14 h) and she holds alerts while she
 *   sleeps, his alerts and comment pushes are held and her plan rings
 *   dropped (life/alerts reads `openNight`); "Woke up" releases them.
 * - He reads it (see.sleep) and never writes it: no method here is his
 *   (D22). Sleep never creates an item, an alert, a score or a concern.
 * - Notes are her text: never in a push, the audit, a log or Activity.
 */
import { SLEEP_BACK_MAX_H, SLEEP_RANGE_MAX_NIGHTS, type SleepNight, type SleepPutBody, type SleepWakeBody, type SleepWeek } from '@jantar/protocol/people';
import {
  SLEEP_OPEN_MAX_H,
  SLEEP_SHORT_MIN,
  axisMinute,
  hhmmOf,
  minutesAsleep,
  mondayOf,
  nightOf,
  shiftDay,
  sleepWeek,
  type SleepNightLike,
} from '@jantar/life-core';
import type { LifeCore, LifeResult } from '../../contracts.js';
import { newId } from '../../core/ids.js';
import type { PeopleModule } from '../people/module.js';
import { CLOSED, HOUR_MS, OK, refuse } from '../people/kit.js';

export const SLEEP_REASONS = {
  open: 'A night is already open. Tap "Woke up" first.',
  noneOpen: 'No night is open.',
  future: "That time hasn't come yet.",
  tooFarBack: 'Going to sleep can be set at most 12 hours back.',
  order: 'Wake time must be after bedtime, and at most 20 hours later.',
  nightKey: "That bedtime belongs to another night: a bedtime before 12:00 counts for the day before.",
  exists: 'That night is already logged. Edit it instead.',
  noNight: 'No night is logged for that day.',
  range: 'Ask for at most 92 nights.',
} as const;

interface Row {
  id: string;
  night: string;
  bed_at: string;
  wake_at: string | null;
  json: string;
}

interface Stored {
  quality?: number;
  notes?: string;
  source: 'buttons' | 'manual';
  editedAt?: string;
  clientId?: string;
  wakeClientId?: string;
}

export interface SleepDeps {
  people: PeopleModule;
  core: () => LifeCore | null;
}

export class SleepModule {
  constructor(private readonly d: SleepDeps) {}

  private core(): LifeCore | null {
    return this.d.core();
  }

  private rowsOf(c: LifeCore, pid: string, from: string, to: string): Row[] {
    return c.db.prepare('SELECT id, night, bed_at, wake_at, json FROM sleep_logs WHERE space = ? AND night >= ? AND night <= ? ORDER BY night').all(pid, from, to) as unknown as Row[];
  }

  private dto(c: LifeCore, r: Row): SleepNight {
    let s: Stored = { source: 'manual' };
    try {
      s = JSON.parse(r.json) as Stored;
    } catch {
      /* the columns still say when */
    }
    const bed = new Date(r.bed_at);
    const wake = r.wake_at ? new Date(r.wake_at) : null;
    const minutes = minutesAsleep(bed, wake);
    const tz = c.tz();
    return {
      id: r.id,
      night: r.night,
      bedAt: r.bed_at,
      ...(r.wake_at ? { wakeAt: r.wake_at } : {}),
      ...(r.wake_at === '' ? { noWake: true } : {}),
      ...(s.quality ? { quality: s.quality } : {}),
      ...(s.notes ? { notes: s.notes } : {}),
      source: s.source === 'buttons' ? 'buttons' : 'manual',
      ...(s.editedAt ? { editedAt: s.editedAt } : {}),
      ...(minutes !== null ? { minutes, short: minutes < SLEEP_SHORT_MIN } : {}),
      bedHm: hhmmOf(bed, tz),
      ...(wake ? { wakeHm: hhmmOf(wake, tz) } : {}),
      axis: { from: axisMinute(r.night, bed, tz), to: wake ? axisMinute(r.night, wake, tz) : axisMinute(r.night, bed, tz) },
    };
  }

  /** The open night (no wake time yet), or null. */
  openNight(pid: string): { id: string; night: string; bedAt: string } | null {
    const c = this.core();
    if (!c) return null;
    const r = c.db.prepare('SELECT id, night, bed_at FROM sleep_logs WHERE space = ? AND wake_at IS NULL').get(pid) as { id: string; night: string; bed_at: string } | undefined;
    return r ? { id: r.id, night: r.night, bedAt: r.bed_at } : null;
  }

  /** Last night closed with no wake time (the morning card asks "When did you wake up?"). */
  askWake(pid: string): string | null {
    const c = this.core();
    if (!c) return null;
    const night = shiftDay(c.today(), -1);
    const r = c.db.prepare("SELECT night FROM sleep_logs WHERE space = ? AND night = ? AND wake_at = ''").get(pid, night) as { night: string } | undefined;
    return r ? r.night : null;
  }

  /** The week from a Monday (default this week), or a range of at most 92 nights; plus the open night. */
  week(pid: string, q: { week?: string | undefined; from?: string | undefined; to?: string | undefined }): LifeResult<SleepWeek> {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    let from: string;
    let to: string;
    if (q.from || q.to) {
      to = q.to ?? c.today();
      from = q.from ?? shiftDay(to, -6);
      if (from > to || shiftDay(from, SLEEP_RANGE_MAX_NIGHTS) <= to) return refuse('invalid_request', SLEEP_REASONS.range);
    } else {
      from = mondayOf(q.week ?? c.today());
      to = shiftDay(from, 6);
    }
    const rows = this.rowsOf(c, pid, shiftDay(from, -7), to);
    const like = (r: Row): SleepNightLike => ({ night: r.night, bedAt: new Date(r.bed_at), wakeAt: r.wake_at ? new Date(r.wake_at) : null, quality: this.dto(c, r).quality });
    const inRange = rows.filter((r) => r.night >= from);
    const summary = sleepWeek(from, inRange.map(like), rows.filter((r) => r.night < from).map(like), c.tz());
    const open = this.openNight(pid);
    return {
      ok: true,
      value: {
        from,
        to,
        nights: inRange.map((r) => this.dto(c, r)).slice(0, 92),
        avgMinutes: summary.avgMinutes,
        avgBed: summary.avgBed,
        avgWake: summary.avgWake,
        bedSpreadMin: summary.bedSpreadMin,
        trend: summary.trend,
        avgQuality: summary.avgQuality,
        open: open ? { since: open.bedAt, night: open.night } : null,
      },
    };
  }

  /** "Going to sleep": a night opens now (or up to 12 h back). A double tap with the same client id is harmless. */
  start(pid: string, at: string | undefined, clientId: string): LifeResult<{ id: string; night: string }> {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const now = c.now().getTime();
    const bed = at ? Date.parse(at) : now;
    if (bed > now + 60_000) return refuse('invalid_request', SLEEP_REASONS.future);
    if (bed < now - SLEEP_BACK_MAX_H * HOUR_MS) return refuse('invalid_request', SLEEP_REASONS.tooFarBack);
    const open = this.openNight(pid);
    if (open) {
      const r = c.db.prepare('SELECT json FROM sleep_logs WHERE space = ? AND id = ?').get(pid, open.id) as { json: string } | undefined;
      if (r && (JSON.parse(r.json) as Stored).clientId === clientId) return { ok: true, value: { id: open.id, night: open.night } };
      return refuse('conflict', SLEEP_REASONS.open);
    }
    const bedAt = new Date(Math.min(bed, now)).toISOString();
    const night = nightOf(new Date(bedAt), c.tz());
    if (c.db.prepare('SELECT 1 FROM sleep_logs WHERE space = ? AND night = ?').get(pid, night)) return refuse('conflict', SLEEP_REASONS.exists);
    const id = newId();
    const stored: Stored = { source: 'buttons', clientId };
    c.db.prepare('INSERT INTO sleep_logs (id, space, night, bed_at, wake_at, json) VALUES (?, ?, ?, ?, NULL, ?)').run(id, pid, night, bedAt, JSON.stringify(stored));
    c.scheduler.set('sleep_close', pid, '', new Date(Date.parse(bedAt) + SLEEP_OPEN_MAX_H * HOUR_MS), pid);
    c.scheduler.poke();
    this.wrote(pid);
    // His alerts now wait (she holds them while she sleeps); arm their release check.
    this.d.people.alerts?.armRelease(pid);
    return { ok: true, value: { id, night } };
  }

  /** "Woke up": the open night closes (now, or `at`), with an optional quality and note. Held alerts come back as one summary. */
  wake(pid: string, body: SleepWakeBody): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const open = this.openNight(pid);
    if (!open) {
      // A double tap: the night this client id woke is already closed.
      const last = c.db.prepare('SELECT json FROM sleep_logs WHERE space = ? ORDER BY bed_at DESC LIMIT 1').get(pid) as { json: string } | undefined;
      if (last && (JSON.parse(last.json) as Stored).wakeClientId === body.clientId) return OK;
      return refuse('conflict', SLEEP_REASONS.noneOpen);
    }
    const now = c.now().getTime();
    const wake = body.at ? Date.parse(body.at) : now;
    const bed = Date.parse(open.bedAt);
    if (wake > now + 60_000) return refuse('invalid_request', SLEEP_REASONS.future);
    if (wake <= bed || wake - bed > SLEEP_OPEN_MAX_H * HOUR_MS) return refuse('invalid_request', SLEEP_REASONS.order);
    const r = c.db.prepare('SELECT json FROM sleep_logs WHERE space = ? AND id = ?').get(pid, open.id) as { json: string };
    const stored: Stored = { ...(JSON.parse(r.json) as Stored), wakeClientId: body.clientId, ...(body.quality ? { quality: body.quality } : {}), ...(body.notes ? { notes: body.notes } : {}) };
    c.db.prepare('UPDATE sleep_logs SET wake_at = ?, json = ? WHERE space = ? AND id = ?').run(new Date(Math.min(wake, now)).toISOString(), JSON.stringify(stored), pid, open.id);
    c.scheduler.clear('sleep_close', pid);
    this.wrote(pid);
    this.d.people.alerts?.release(pid);
    return OK;
  }

  /** Add or correct a night by hand. The bedtime must belong to `night`; with no wake time the night stays open (one at a time). */
  put(pid: string, night: string, body: SleepPutBody): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const now = c.now().getTime();
    const bed = Date.parse(body.bedAt);
    if (bed > now + 60_000) return refuse('invalid_request', SLEEP_REASONS.future);
    if (nightOf(new Date(bed), c.tz()) !== night) return refuse('invalid_request', SLEEP_REASONS.nightKey);
    const wake = body.wakeAt ? Date.parse(body.wakeAt) : null;
    if (wake !== null && (wake <= bed || wake - bed > SLEEP_OPEN_MAX_H * HOUR_MS || wake > now + 60_000)) return refuse('invalid_request', SLEEP_REASONS.order);
    const ex = c.db.prepare('SELECT id, json, wake_at FROM sleep_logs WHERE space = ? AND night = ?').get(pid, night) as { id: string; json: string; wake_at: string | null } | undefined;
    const open = this.openNight(pid);
    if (wake === null && open && open.night !== night) return refuse('conflict', SLEEP_REASONS.open);
    const before: Stored = ex ? (JSON.parse(ex.json) as Stored) : { source: 'manual' };
    const stored: Stored = { ...before, editedAt: ex ? c.now().toISOString() : undefined };
    if (!ex) stored.source = 'manual';
    if (body.quality === null) delete stored.quality;
    else if (body.quality !== undefined) stored.quality = body.quality;
    if (body.notes === null || body.notes === '') delete stored.notes;
    else if (body.notes !== undefined) stored.notes = body.notes;
    if (stored.editedAt === undefined) delete stored.editedAt;
    const wakeAt = wake === null ? (body.wakeAt === undefined && ex ? ex.wake_at : null) : new Date(wake).toISOString();
    if (wakeAt === null && open && (!ex || open.id !== ex.id)) return refuse('conflict', SLEEP_REASONS.open);
    const bedAt = new Date(bed).toISOString();
    if (ex) c.db.prepare('UPDATE sleep_logs SET bed_at = ?, wake_at = ?, json = ? WHERE space = ? AND id = ?').run(bedAt, wakeAt, JSON.stringify(stored), pid, ex.id);
    else c.db.prepare('INSERT INTO sleep_logs (id, space, night, bed_at, wake_at, json) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), pid, night, bedAt, wakeAt, JSON.stringify(stored));
    if (wakeAt === null) c.scheduler.set('sleep_close', pid, '', new Date(bed + SLEEP_OPEN_MAX_H * HOUR_MS), pid);
    else if (ex && ex.wake_at === null) {
      c.scheduler.clear('sleep_close', pid);
      this.d.people.alerts?.release(pid);
    }
    c.scheduler.poke();
    this.wrote(pid);
    return OK;
  }

  remove(pid: string, night: string): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const ex = c.db.prepare('SELECT id, wake_at FROM sleep_logs WHERE space = ? AND night = ?').get(pid, night) as { id: string; wake_at: string | null } | undefined;
    if (!ex) return refuse('not_found', SLEEP_REASONS.noNight);
    c.db.prepare('DELETE FROM sleep_logs WHERE space = ? AND id = ?').run(pid, ex.id);
    if (ex.wake_at === null) {
      c.scheduler.clear('sleep_close', pid);
      this.d.people.alerts?.release(pid);
    }
    this.wrote(pid);
    return OK;
  }

  /** 20 h after bedtime (the scheduler, `system`): an open night closes with no wake time, and nothing is guessed. */
  closeOpen(pid: string): void {
    const c = this.core();
    if (!c) return;
    const open = this.openNight(pid);
    if (!open || c.now().getTime() - Date.parse(open.bedAt) < SLEEP_OPEN_MAX_H * HOUR_MS - 60_000) return;
    c.db.prepare("UPDATE sleep_logs SET wake_at = '' WHERE space = ? AND id = ?").run(pid, open.id);
    this.wrote(pid);
    this.d.people.alerts?.release(pid);
  }

  /** Every night of hers (her export), oldest first. */
  exportRows(pid: string): SleepNight[] {
    const c = this.core();
    if (!c) return [];
    return this.rowsOf(c, pid, '0000-01-01', '9999-12-31').map((r) => this.dto(c, r));
  }

  private wrote(pid: string): void {
    this.d.people.herWrote(pid, 'sleep', 'plan');
  }
}
