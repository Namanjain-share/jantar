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
 * day, `startTime`: the Life-zone HH:MM it was added on `startedOn`, and
 * `stopTime`: the Life-zone HH:MM of a Stop on `stoppedOn`. None comes
 * from a client body, and all are stripped from every reply: `timesHistory`
 * is here so that changing 08:00 to 09:00, or adding a second time,
 * re-judges no past day; `startTime` so that a dose time already gone by
 * when it was added is never a miss; `stopTime` so that the doses after a
 * Stop were never due.
 *
 * v0.11 People: a repo works in one space (`''` the owner's, `<pid>` hers),
 * and every query names it, so the owner's medicines never list a row of
 * hers and the reverse (T6). A dose carries its medicine's space, written
 * with it. `by_person` is the medicine's author (set on insert, never
 * changed); `by` and `space` never go into the json. In her space a
 * medicine also keeps "Edited by" (`editedBy`, `editedAt`), set when the
 * owner changes one she added. Only the ping handler reads across spaces
 * (`medAnySpace`, `allMedsAnySpace`), to ring each dose on its own
 * person's devices.
 *
 * Every call reads `core.db` afresh: a restore swaps the handle.
 */
import { DayKeySchema, HhMmSchema, IsoDateSchema, MedicineSchema, type DoseStatus, type Medicine } from '@jantar/protocol';
import { z } from 'zod';
import type { LifeCore, PingKind } from '../../contracts.js';

/** At most this many entries in `history` and `timesHistory`; the oldest go first. */
export const HISTORY_MAX = 100;

export const StoredMedicineSchema = MedicineSchema.extend({
  timesHistory: z
    .array(z.object({ from: DayKeySchema, times: z.array(HhMmSchema).min(1).max(8) }))
    .min(1)
    .max(HISTORY_MAX),
  /** When on `startedOn` it was added; absent on a medicine added before it was kept (its whole first day stays). */
  startTime: HhMmSchema.optional(),
  /** When on `stoppedOn` it was stopped; absent on a medicine stopped before it was kept (its whole last day stays). */
  stopTime: HhMmSchema.optional(),
  /** v0.11 People: "Edited by" on a medicine of hers the owner changed ('' the owner); cleared by nobody. */
  editedBy: z.string().max(40).optional(),
  editedAt: IsoDateSchema.optional(),
});
/** A stored medicine; `by` (its author) comes from the column in a person space. */
export type StoredMedicine = z.infer<typeof StoredMedicineSchema> & { by?: string };

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

interface RawMed {
  json: string;
  by_person?: string;
  space?: string;
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

export class MedsRepo {
  constructor(
    private readonly core: Pick<LifeCore, 'db'>,
    /** v0.11: the space this repo reads and writes. */
    readonly space = '',
  ) {}

  /** This repo, in another space. */
  inSpace(space: string): MedsRepo {
    return space === this.space ? this : new MedsRepo(this.core, space);
  }

  /** A row as read: the json, and in a person space its author from the column. */
  private medOf(r: RawMed): StoredMedicine | null {
    const m = parseMed(r.json);
    if (!m) return null;
    return this.space !== '' && r.by_person !== undefined ? { ...m, by: r.by_person } : m;
  }

  all(): StoredMedicine[] {
    const rows = this.core.db.prepare('SELECT json, by_person FROM medicines WHERE space = ?').all(this.space) as unknown as RawMed[];
    return rows.map((r) => this.medOf(r)).filter((m): m is StoredMedicine => m !== null);
  }

  get(id: string): StoredMedicine | null {
    const row = this.core.db.prepare('SELECT json, by_person FROM medicines WHERE space = ? AND id = ?').get(this.space, id) as RawMed | undefined;
    return row ? this.medOf(row) : null;
  }

  count(): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM medicines WHERE space = ?').get(this.space) as { n: number }).n;
  }

  /**
   * Insert or replace in this space; the JSON is validated before it is
   * written. `by` (the author) is written on insert only; a row of another
   * space with the same id is never touched.
   */
  put(med: StoredMedicine, by = ''): void {
    const { by: _by, ...rest } = med;
    const valid = StoredMedicineSchema.parse(rest);
    this.core.db
      .prepare(
        `INSERT INTO medicines (id, stopped_on, updated_at, json, space, by_person) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET stopped_on = excluded.stopped_on, updated_at = excluded.updated_at, json = excluded.json
         WHERE medicines.space = excluded.space`,
      )
      .run(valid.id, valid.stoppedOn ?? null, valid.updatedAt, JSON.stringify(valid), this.space, by);
  }

  /** The medicine and every dose it had. */
  delete(id: string): void {
    this.core.db.prepare('DELETE FROM doses WHERE space = ? AND med_id = ?').run(this.space, id);
    this.core.db.prepare('DELETE FROM medicines WHERE space = ? AND id = ?').run(this.space, id);
  }

  dosesOn(day: string): DoseRow[] {
    return (this.core.db.prepare('SELECT * FROM doses WHERE space = ? AND day = ?').all(this.space, day) as unknown as RawDose[]).map(doseOf);
  }

  /** Doses from `from` to `to`, both included. */
  dosesBetween(from: string, to: string): DoseRow[] {
    return (this.core.db.prepare('SELECT * FROM doses WHERE space = ? AND day >= ? AND day <= ?').all(this.space, from, to) as unknown as RawDose[]).map(doseOf);
  }

  /** One medicine's doses on `day`. */
  medDosesOn(medId: string, day: string): DoseRow[] {
    return (this.core.db.prepare('SELECT * FROM doses WHERE space = ? AND med_id = ? AND day = ?').all(this.space, medId, day) as unknown as RawDose[]).map(doseOf);
  }

  doseAt(medId: string, day: string, slot: string): DoseRow | null {
    const r = this.core.db.prepare('SELECT * FROM doses WHERE space = ? AND med_id = ? AND day = ? AND slot = ?').get(this.space, medId, day, slot) as RawDose | undefined;
    return r ? doseOf(r) : null;
  }

  doseById(medId: string, id: string): DoseRow | null {
    const r = this.core.db.prepare('SELECT * FROM doses WHERE space = ? AND id = ? AND med_id = ?').get(this.space, id, medId) as RawDose | undefined;
    return r ? doseOf(r) : null;
  }

  /** One row per (medicine, day, slot): a second log of the same slot changes the first, keeping its id. */
  upsertDose(d: DoseRow): void {
    this.core.db
      .prepare(
        `INSERT INTO doses (id, med_id, day, slot, status, at, space) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (med_id, day, slot) DO UPDATE SET status = excluded.status, at = excluded.at WHERE doses.space = excluded.space`,
      )
      .run(d.id, d.medId, d.day, d.slot, d.status, d.at, this.space);
  }

  deleteDose(id: string): void {
    this.core.db.prepare('DELETE FROM doses WHERE space = ? AND id = ?').run(this.space, id);
  }
}

/**
 * The ping handler's reads (the `system` sweep, C4): a medicine in any
 * space with the space it lives in, and every medicine of every space, so
 * her dose keeps ringing her devices after a restart.
 */
export function medAnySpace(core: Pick<LifeCore, 'db'>, id: string): { med: StoredMedicine; space: string } | null {
  const r = core.db.prepare('SELECT json, space FROM medicines WHERE id = ? AND space = space').get(id) as RawMed | undefined;
  const med = r ? parseMed(r.json) : null;
  return med && r ? { med, space: r.space ?? '' } : null;
}

export function allMedsAnySpace(core: Pick<LifeCore, 'db'>): { med: StoredMedicine; space: string }[] {
  const rows = core.db.prepare('SELECT json, space FROM medicines WHERE space = space').all() as unknown as RawMed[];
  return rows.flatMap((r) => {
    const med = parseMed(r.json);
    return med ? [{ med, space: r.space ?? '' }] : [];
  });
}

/** Rows in every space (the resync's count of unreadable ones). */
export function countMedsAnySpace(core: Pick<LifeCore, 'db'>): number {
  return (core.db.prepare('SELECT COUNT(*) AS n FROM medicines WHERE space = space').get() as { n: number }).n;
}

/** The owner's medicine (tests read stored fields with it). */
export function getMed(core: Pick<LifeCore, 'db'>, id: string): StoredMedicine | null {
  return new MedsRepo(core).get(id);
}

/** What a reply carries: the stored medicine without `timesHistory`, `startTime` and `stopTime`. */
export function publicMed(m: StoredMedicine): Medicine & { by?: string; editedBy?: string; editedAt?: string } {
  const { timesHistory: _times, startTime: _start, stopTime: _stop, ...med } = m;
  return med;
}

/**
 * The scheduler's rows of one kind, as (ref, sub) pairs: what a resync
 * compares against to drop rows whose medicine or time has gone. The
 * scheduler is the only writer of `pings`; this and `hasPing` only read it.
 */
export function pingKeys(core: Pick<LifeCore, 'db'>, kind: PingKind): { ref: string; sub: string }[] {
  return core.db.prepare('SELECT ref, sub FROM pings WHERE kind = ?').all(kind) as { ref: string; sub: string }[];
}

/** The stored next_at of each of a medicine's `med` rows, by its sub (null: parked). */
export function medPingTimes(core: Pick<LifeCore, 'db'>, ref: string): Map<string, string | null> {
  const rows = core.db.prepare("SELECT sub, next_at FROM pings WHERE kind = 'med' AND ref = ?").all(ref) as { sub: string; next_at: string | null }[];
  return new Map(rows.map((r) => [r.sub, r.next_at]));
}

/**
 * Whether a row of `kind` for `ref` is still armed or has rung: how the
 * refill producer knows it already rang for this box. A row parked without
 * a send (its catch-up too late to send, or its sends given up) is neither,
 * so the producer arms it again.
 */
export function hasPing(core: Pick<LifeCore, 'db'>, kind: PingKind, ref: string): boolean {
  return (
    core.db.prepare('SELECT 1 AS one FROM pings WHERE kind = ? AND ref = ? AND (next_at IS NOT NULL OR last_sent_at IS NOT NULL)').get(kind, ref) !== undefined
  );
}
