/**
 * The food tables (life.db migration 1): `food` (one row per entry; `day`
 * and `at` are columns, the entry itself is `json`), `foods_saved` (one row
 * per saved food, keyed by its lowercased, trimmed name; `uses` and
 * `last_used` order the one-tap list) and the targets in `meta`
 * (`kcal_target`, `goal_kg10` in kg x 10).
 *
 * Every json is checked with its protocol schema on the way out; a row that
 * fails is left out and logged by table and id only. `core.db` is read on
 * every call (a restore swaps it).
 *
 * v0.11 People: a repo works in one space (`''` the owner's), and every
 * query on `food` and `foods_saved` names it (T6), so the owner's food log
 * never lists a row of another space. A person's targets are her own meta
 * keys (`kcal_target:<pid>`, `goal_kg10:<pid>`; forget deletes them).
 */
import { FoodEntrySchema, KCAL_TARGET_DEFAULT, SavedFoodSchema, type FoodEntry, type SavedFood } from '@jantar/protocol';
import type { LifeCore, Logger } from '../../contracts.js';

/** meta keys. */
export const KCAL_TARGET_KEY = 'kcal_target';
export const GOAL_KG10_KEY = 'goal_kg10';

/** v0.11: a space's calorie target key (the owner's is the plain key, a person's carries her id). */
export function kcalTargetKey(space: string): string {
  return space === '' ? KCAL_TARGET_KEY : `${KCAL_TARGET_KEY}:${space}`;
}

/** v0.11: a space's goal weight key. */
export function goalKey(space: string): string {
  return space === '' ? GOAL_KG10_KEY : `${GOAL_KG10_KEY}:${space}`;
}

/** The key a saved food is found by: "Roti", " roti " and "ROTI" are one saved food. */
export function savedKey(name: string): string {
  return name.trim().toLowerCase();
}

interface SavedRow {
  id: string;
  uses: number;
  json: string;
}

export class FoodRepo {
  constructor(
    private readonly core: LifeCore,
    private readonly log: Logger,
    /** v0.11: the space this repo reads and writes. */
    readonly space = '',
  ) {}

  /** A day's entries, oldest first (by `at`, then in the order they were added). */
  entriesOn(day: string): FoodEntry[] {
    const rows = this.core.db.prepare('SELECT id, json FROM food WHERE space = ? AND day = ? ORDER BY at, rowid').all(this.space, day) as { id: string; json: string }[];
    return rows.flatMap((r) => this.entryOf(r));
  }

  entry(id: string): FoodEntry | null {
    const row = this.core.db.prepare('SELECT id, json FROM food WHERE space = ? AND id = ?').get(this.space, id) as { id: string; json: string } | undefined;
    return row ? (this.entryOf(row)[0] ?? null) : null;
  }

  countOn(day: string): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM food WHERE space = ? AND day = ?').get(this.space, day) as { n: number }).n;
  }

  /** v0.11: entries a day on each day from `from` to `to` (inclusive) that has any. */
  countsBetween(from: string, to: string): Map<string, number> {
    const rows = this.core.db.prepare('SELECT day, COUNT(*) AS n FROM food WHERE space = ? AND day >= ? AND day <= ? GROUP BY day').all(this.space, from, to) as { day: string; n: number }[];
    return new Map(rows.map((r) => [r.day, Number(r.n)]));
  }

  /** v0.11: every entry in the space (her food module's switch refuses to go off while there are any). */
  count(): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM food WHERE space = ?').get(this.space) as { n: number }).n;
  }

  /** The day's calories, from the entries that pass their check. */
  kcalOn(day: string): number {
    return this.entriesOn(day).reduce((sum, e) => sum + e.kcal, 0);
  }

  putEntry(e: FoodEntry): void {
    this.core.db
      .prepare(
        `INSERT INTO food (id, day, at, json, space) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET day = excluded.day, at = excluded.at, json = excluded.json WHERE food.space = excluded.space`,
      )
      .run(e.id, e.day, e.at, JSON.stringify(FoodEntrySchema.parse(e)), this.space);
  }

  /** True when there was one to delete. */
  deleteEntry(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM food WHERE space = ? AND id = ?').run(this.space, id).changes) > 0;
  }

  /** The most used saved foods, then the most recently used, then by name. */
  topSaved(limit: number): SavedFood[] {
    const rows = this.core.db
      .prepare('SELECT id, uses, json FROM foods_saved WHERE space = ? ORDER BY uses DESC, last_used DESC, name_key LIMIT ?')
      .all(this.space, limit) as unknown as SavedRow[];
    return rows.flatMap((r) => this.savedOf(r));
  }

  saved(id: string): SavedFood | null {
    const row = this.core.db.prepare('SELECT id, uses, json FROM foods_saved WHERE space = ? AND id = ?').get(this.space, id) as SavedRow | undefined;
    return row ? (this.savedOf(row)[0] ?? null) : null;
  }

  savedByName(name: string): SavedFood | null {
    const row = this.core.db.prepare('SELECT id, uses, json FROM foods_saved WHERE space = ? AND name_key = ?').get(this.space, savedKey(name)) as SavedRow | undefined;
    return row ? (this.savedOf(row)[0] ?? null) : null;
  }

  savedCount(): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM foods_saved WHERE space = ?').get(this.space) as { n: number }).n;
  }

  /** A new saved food, used once at `at`. */
  insertSaved(s: Omit<SavedFood, 'uses'>, at: string): void {
    const json = JSON.stringify({ id: s.id, name: s.name, kcal: s.kcal });
    SavedFoodSchema.parse({ ...s, uses: 1 });
    this.core.db.prepare('INSERT INTO foods_saved (id, space, name_key, uses, last_used, json) VALUES (?, ?, ?, 1, ?, ?)').run(s.id, this.space, savedKey(s.name), at, json);
  }

  /** One more use at `at`; with `value`, its name and kcal change too (a re-save). */
  useSaved(id: string, at: string, value?: { name: string; kcal: number }): void {
    if (value) {
      SavedFoodSchema.parse({ id, ...value, uses: 1 });
      this.core.db
        .prepare('UPDATE foods_saved SET uses = uses + 1, last_used = ?, name_key = ?, json = ? WHERE space = ? AND id = ?')
        .run(at, savedKey(value.name), JSON.stringify({ id, name: value.name, kcal: value.kcal }), this.space, id);
      return;
    }
    this.core.db.prepare('UPDATE foods_saved SET uses = uses + 1, last_used = ? WHERE space = ? AND id = ?').run(at, this.space, id);
  }

  deleteSaved(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM foods_saved WHERE space = ? AND id = ?').run(this.space, id).changes) > 0;
  }

  /** The daily calorie target (KCAL_TARGET_DEFAULT until one is set). */
  kcalTarget(): number {
    const v = Number(this.core.db.meta(kcalTargetKey(this.space)));
    return Number.isInteger(v) && v > 0 ? v : KCAL_TARGET_DEFAULT;
  }

  private entryOf(r: { id: string; json: string }): FoodEntry[] {
    const parsed = FoodEntrySchema.safeParse(parseJson(r.json));
    if (parsed.success) return [parsed.data];
    this.log.warn('life: a row failed its check and is left out', { table: 'food', id: r.id });
    return [];
  }

  private savedOf(r: SavedRow): SavedFood[] {
    const json = parseJson(r.json);
    const parsed = SavedFoodSchema.safeParse(typeof json === 'object' && json !== null ? { ...json, uses: r.uses } : json);
    if (parsed.success) return [parsed.data];
    this.log.warn('life: a row failed its check and is left out', { table: 'foods_saved', id: r.id });
    return [];
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
