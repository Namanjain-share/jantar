/**
 * The `places` table (life.db migration 1): one row per café, its dishes
 * inside `json`, and `best` (the highest dish rating) as a column too.
 * Every json is checked with PlaceSchema on the way out; a row that fails is
 * left out and logged by id only. `core.db` is read on every call.
 */
import { PlaceSchema, type Place } from '@jantar/protocol';
import type { LifeCore, Logger } from '../../contracts.js';

export class PlacesRepo {
  constructor(
    private readonly core: LifeCore,
    private readonly log: Logger,
  ) {}

  all(): Place[] {
    const rows = this.core.db.prepare('SELECT id, json FROM places').all() as { id: string; json: string }[];
    return rows.flatMap((r) => this.placeOf(r));
  }

  get(id: string): Place | null {
    const row = this.core.db.prepare('SELECT id, json FROM places WHERE id = ?').get(id) as { id: string; json: string } | undefined;
    return row ? (this.placeOf(row)[0] ?? null) : null;
  }

  count(): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM places').get() as { n: number }).n;
  }

  put(p: Place): void {
    this.core.db
      .prepare('INSERT INTO places (id, best, updated_at, json) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET best = excluded.best, updated_at = excluded.updated_at, json = excluded.json')
      .run(p.id, p.best, p.updatedAt, JSON.stringify(PlaceSchema.parse(p)));
  }

  /** True when there was one to delete. */
  delete(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM places WHERE id = ?').run(id).changes) > 0;
  }

  private placeOf(r: { id: string; json: string }): Place[] {
    let json: unknown = null;
    try {
      json = JSON.parse(r.json);
    } catch {
      /* checked below */
    }
    const parsed = PlaceSchema.safeParse(json);
    if (parsed.success) return [parsed.data];
    this.log.warn('life: a row failed its check and is left out', { table: 'places', id: r.id });
    return [];
  }
}
