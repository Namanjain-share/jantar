/**
 * Medicines and doses in life.db.
 *
 * `medicines` keeps each medicine as JSON (validated with zod on the way in
 * and out) with `stopped_on` as a column; `doses` keeps one row per
 * (medicine, day, slot), so a double tap is one row. A scheduled slot with
 * no row is a miss: misses are never stored.
 *
 * Besides the protocol's `history` (the schedule in force from each day),
 * the stored JSON keeps `timesHistory`: the dose times in force from each
 * day, and `stopTime`: the Life-zone HH:MM of a Stop on `stoppedOn`.
 * Neither comes from a client body, and both are stripped from every
 * reply: `timesHistory` is here so that changing 08:00 to 09:00, or adding
 * a second time, re-judges no past day; `stopTime` so that the doses after
 * a Stop were never due.
 *
 * Every call reads `core.db` afresh: a restore swaps the handle.
 */
import { DayKeySchema, HhMmSchema, MedicineSchema, type DoseStatus, type Medicine } from '@jantar/protocol';
import { z } from 'zod';
import type { LifeCore, PingKind } from '../../contracts.js';

/** At most this many entries in `history` and `timesHistory`; the oldest go first. */
export const HISTORY_MAX = 100;

export const StoredMedicineSchema = MedicineSchema.extend({
  timesHistory: z
    .array(z.object({ from: DayKeySchema, times: z.array(HhMmSchema).min(1).max(8) }))
    .min(1)
    .max(HISTORY_MAX),
  /** When on `stoppedOn` it was stopped; absent on a medicine stopped before it was kept (its whole last day stays). */
  stopTime: HhMmSchema.optional(),
});
export type StoredMedicine = z.infer<typeof StoredMedicineSchema>;

/** One `doses` row. */
export interface DoseRow {
  id: string;
  medId: string;
  day: string;
  slot: string;
  status: DoseStatus;
  at: string;
}

interface RawDose {
  id: string;
  med_id: string;
  day: string;
  slot: string;
  status: DoseStatus;
  at: string;
}

const doseOf = (r: RawDose): DoseRow => ({ id: r.id, medId: r.med_id, day: r.day, slot: r.slot, status: r.status, at: r.at });

/** A stored row that no longer parses is left out rather than breaking every read. */
function parseMed(json: string): StoredMedicine | null {
  try {
    const r = StoredMedicineSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function allMeds(core: LifeCore): StoredMedicine[] {
  const rows = core.db.prepare('SELECT json FROM medicines').all() as { json: string }[];
  return rows.map((r) => parseMed(r.json)).filter((m): m is StoredMedicine => m !== null);
}

export function getMed(core: LifeCore, id: string): StoredMedicine | null {
  const row = core.db.prepare('SELECT json FROM medicines WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? parseMed(row.json) : null;
}

export function countMeds(core: LifeCore): number {
  return (core.db.prepare('SELECT COUNT(*) AS n FROM medicines').get() as { n: number }).n;
}

/** Insert or replace; the JSON is validated before it is written. */
export function putMed(core: LifeCore, med: StoredMedicine): void {
  const valid = StoredMedicineSchema.parse(med);
  core.db
    .prepare('INSERT INTO medicines (id, stopped_on, updated_at, json) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET stopped_on = excluded.stopped_on, updated_at = excluded.updated_at, json = excluded.json')
    .run(valid.id, valid.stoppedOn ?? null, valid.updatedAt, JSON.stringify(valid));
}

/** The medicine and every dose it had. */
export function deleteMed(core: LifeCore, id: string): void {
  core.db.prepare('DELETE FROM doses WHERE med_id = ?').run(id);
  core.db.prepare('DELETE FROM medicines WHERE id = ?').run(id);
}

/** What a reply carries: the stored medicine without `timesHistory` and `stopTime`. */
export function publicMed(m: StoredMedicine): Medicine {
  const { timesHistory: _times, stopTime: _stop, ...med } = m;
  return med;
}

export function dosesOn(core: LifeCore, day: string): DoseRow[] {
  return (core.db.prepare('SELECT * FROM doses WHERE day = ?').all(day) as unknown as RawDose[]).map(doseOf);
}

/** Doses from `from` to `to`, both included. */
export function dosesBetween(core: LifeCore, from: string, to: string): DoseRow[] {
  return (core.db.prepare('SELECT * FROM doses WHERE day >= ? AND day <= ?').all(from, to) as unknown as RawDose[]).map(doseOf);
}

/** One medicine's doses on `day`. */
export function medDosesOn(core: LifeCore, medId: string, day: string): DoseRow[] {
  return (core.db.prepare('SELECT * FROM doses WHERE med_id = ? AND day = ?').all(medId, day) as unknown as RawDose[]).map(doseOf);
}

export function doseAt(core: LifeCore, medId: string, day: string, slot: string): DoseRow | null {
  const r = core.db.prepare('SELECT * FROM doses WHERE med_id = ? AND day = ? AND slot = ?').get(medId, day, slot) as RawDose | undefined;
  return r ? doseOf(r) : null;
}

export function doseById(core: LifeCore, medId: string, id: string): DoseRow | null {
  const r = core.db.prepare('SELECT * FROM doses WHERE id = ? AND med_id = ?').get(id, medId) as RawDose | undefined;
  return r ? doseOf(r) : null;
}

/** One row per (medicine, day, slot): a second log of the same slot changes the first, keeping its id. */
export function upsertDose(core: LifeCore, d: DoseRow): void {
  core.db
    .prepare('INSERT INTO doses (id, med_id, day, slot, status, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (med_id, day, slot) DO UPDATE SET status = excluded.status, at = excluded.at')
    .run(d.id, d.medId, d.day, d.slot, d.status, d.at);
}

export function deleteDose(core: LifeCore, id: string): void {
  core.db.prepare('DELETE FROM doses WHERE id = ?').run(id);
}

/**
 * The scheduler's rows of one kind, as (ref, sub) pairs: what a resync
 * compares against to drop rows whose medicine or time has gone. The
 * scheduler is the only writer of `pings`; this and `hasPing` only read it.
 */
export function pingKeys(core: LifeCore, kind: PingKind): { ref: string; sub: string }[] {
  return core.db.prepare('SELECT ref, sub FROM pings WHERE kind = ?').all(kind) as { ref: string; sub: string }[];
}

/** The stored next_at of each of a medicine's `med` rows, by its dose time (null: parked). */
export function medPingTimes(core: LifeCore, ref: string): Map<string, string | null> {
  const rows = core.db.prepare("SELECT sub, next_at FROM pings WHERE kind = 'med' AND ref = ?").all(ref) as { sub: string; next_at: string | null }[];
  return new Map(rows.map((r) => [r.sub, r.next_at]));
}

/**
 * Whether a row of `kind` for `ref` is still armed or has rung: how the
 * refill producer knows it already rang for this box. A row parked without
 * a send (its catch-up too late to send, or its sends given up) is neither,
 * so the producer arms it again.
 */
export function hasPing(core: LifeCore, kind: PingKind, ref: string): boolean {
  return (
    core.db.prepare('SELECT 1 AS one FROM pings WHERE kind = ? AND ref = ? AND (next_at IS NOT NULL OR last_sent_at IS NOT NULL)').get(kind, ref) !== undefined
  );
}
