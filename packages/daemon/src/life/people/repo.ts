/**
 * v0.11 People in life.db: the `people` rows, the shared spaces and her
 * Activity (`person_activity`, append-only in the app; spec 8.3, D8).
 *
 * Every call reads `core.db` afresh (a restore swaps the handle). A row
 * that no longer parses is left out (never repaired, never deleted) and
 * counted in the log by table.
 *
 * Activity holds codes, a title snapshot of a todo or a medicine, old and
 * new values of the fields he changed, and device names: never journal,
 * comment, chat, sleep or review text (O15). No method here updates or
 * deletes an Activity row except the prune and forget.
 */
import { PERSON_ACTIVITY_KEEP, PersonActivitySchema, PersonSchema, type Person, type PersonActivity } from '@jantar/protocol/people';
import type { LifeCore, Logger } from '../../contracts.js';

const DAY_MS = 24 * 60 * 60_000;

export type ActivityInput = Omit<PersonActivity, 'seq' | 'at'> & { at?: string };

export class PeopleRepo {
  constructor(
    private readonly core: () => Pick<LifeCore, 'db'>,
    private readonly log: Logger,
  ) {}

  private parsePerson(json: string): Person | null {
    try {
      const p = PersonSchema.safeParse(JSON.parse(json));
      if (p.success) return p.data;
    } catch {
      /* counted below */
    }
    this.log.warn('life rows left out: they no longer parse', { table: 'people', rows: 1 });
    return null;
  }

  get(id: string): Person | null {
    const r = this.core().db.prepare('SELECT json FROM people WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? this.parsePerson(r.json) : null;
  }

  list(): Person[] {
    const rows = this.core().db.prepare('SELECT json FROM people ORDER BY id').all() as { json: string }[];
    return rows.flatMap((r) => this.parsePerson(r.json) ?? []);
  }

  save(p: Person): void {
    const json = JSON.stringify(PersonSchema.parse(p));
    this.core()
      .db.prepare(
        `INSERT INTO people (id, state, updated_at, json) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(p.id, p.state, p.updatedAt, json);
  }

  delete(id: string): void {
    this.core().db.prepare('DELETE FROM people WHERE id = ?').run(id);
  }

  saveSharedSpace(id: string, members: readonly string[], name: string, at: string): void {
    this.core()
      .db.prepare(
        `INSERT INTO shared_spaces (id, updated_at, json) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(id, at, JSON.stringify({ id, members, name }));
  }

  // --- Activity ----------------------------------------------------------------

  append(person: string, row: ActivityInput, at: string): PersonActivity {
    const full = { ...row, at: row.at ?? at };
    const { actor, action, ref, ...rest } = full;
    const json = JSON.stringify(rest);
    const r = this.core()
      .db.prepare('INSERT INTO person_activity (person, at, actor, action, ref, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(person, full.at, actor, action, ref ?? null, json);
    return PersonActivitySchema.parse({ ...full, seq: Number(r.lastInsertRowid) });
  }

  /** Newest first, `limit` rows older than `before` (a seq). */
  activity(person: string, before: number | undefined, limit: number): PersonActivity[] {
    const db = this.core().db;
    const rows = (
      before === undefined
        ? db.prepare('SELECT * FROM person_activity WHERE person = ? ORDER BY seq DESC LIMIT ?').all(person, limit)
        : db.prepare('SELECT * FROM person_activity WHERE person = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(person, before, limit)
    ) as { seq: number; at: string; actor: string; action: string; ref: string | null; json: string }[];
    const out: PersonActivity[] = [];
    let bad = 0;
    for (const r of rows) {
      try {
        const p = PersonActivitySchema.safeParse({ ...JSON.parse(r.json), seq: Number(r.seq), at: r.at, actor: r.actor, action: r.action, ...(r.ref !== null ? { ref: r.ref } : {}) });
        if (p.success) out.push(p.data);
        else bad += 1;
      } catch {
        bad += 1;
      }
    }
    if (bad > 0) this.log.warn('life rows left out: they no longer parse', { table: 'person_activity', rows: bad });
    return out;
  }

  /** A view mark for `area` in the hour of `at` already exists (one per area per hour, spec 8.3). */
  viewMarked(person: string, area: string, hourStart: string): boolean {
    const r = this.core()
      .db.prepare("SELECT 1 FROM person_activity WHERE person = ? AND action = 'view' AND ref = ? AND at >= ? LIMIT 1")
      .get(person, area, hourStart);
    return r !== undefined;
  }

  /** Keep 365 days and 5,000 rows per person (PERSON_ACTIVITY_KEEP). */
  prune(person: string, nowMs: number): number {
    const db = this.core().db;
    const cutoff = new Date(nowMs - PERSON_ACTIVITY_KEEP.days * DAY_MS).toISOString();
    let n = Number(db.prepare('DELETE FROM person_activity WHERE person = ? AND at < ?').run(person, cutoff).changes);
    n += Number(
      db
        .prepare(
          `DELETE FROM person_activity WHERE person = ? AND seq < (
             SELECT MIN(seq) FROM (SELECT seq FROM person_activity WHERE person = ? ORDER BY seq DESC LIMIT ?))`,
        )
        .run(person, person, PERSON_ACTIVITY_KEEP.rows).changes,
    );
    return n;
  }

  /** Forget: her Activity goes with her space. */
  forgetActivity(person: string): number {
    return Number(this.core().db.prepare('DELETE FROM person_activity WHERE person = ?').run(person).changes);
  }
}
