/**
 * The `places` table (life.db migration 1): one row per café, its dishes
 * inside `json`, and `best` (the highest rated dish) as a column too.
 * v0.10: `place_visits` (migration 3), one row per visit with its café and
 * day as columns. Every json is checked with its zod shape on the way out;
 * a row that fails is left out and logged by id only. `core.db` is read on
 * every call.
 *
 * A café's `visits` summary (count, newest day, mean spend) is read from
 * place_visits with one grouped query per list, never stored in its json
 * (a row whose json is not valid counts, but adds no spend: json_extract
 * on it would fail the whole query).
 */
import { PlaceSchema, PlaceVisitSchema, type Place, type PlaceVisit, type PlaceVisitsSummary } from '@jantar/protocol';
import type { LifeCore, Logger } from '../../contracts.js';

type Row = { id: string; json: string };
type SummaryRow = { place_id: string; n: number; last: string | null; avg: number | null };

const NO_VISITS: PlaceVisitsSummary = { count: 0, last: null, avgSpend: null };

function summaryOf(r: SummaryRow | undefined): PlaceVisitsSummary {
  if (!r) return { ...NO_VISITS };
  return { count: r.n, last: r.last, avgSpend: r.avg === null ? null : Math.round(r.avg) };
}

export class PlacesRepo {
  constructor(
    private readonly core: LifeCore,
    private readonly log: Logger,
  ) {}

  all(): Place[] {
    const rows = this.core.db.prepare('SELECT id, json FROM places').all() as Row[];
    const sums = this.core.db
      .prepare("SELECT place_id, COUNT(*) AS n, MAX(day) AS last, AVG(CASE WHEN json_valid(json) THEN json_extract(json, '$.spend') END) AS avg FROM place_visits GROUP BY place_id")
      .all() as SummaryRow[];
    const byPlace = new Map(sums.map((s) => [s.place_id, s]));
    return rows.flatMap((r) => this.placeOf(r, byPlace.get(r.id)));
  }

  get(id: string): Place | null {
    const row = this.core.db.prepare('SELECT id, json FROM places WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const sum = this.core.db
      .prepare("SELECT place_id, COUNT(*) AS n, MAX(day) AS last, AVG(CASE WHEN json_valid(json) THEN json_extract(json, '$.spend') END) AS avg FROM place_visits WHERE place_id = ? GROUP BY place_id")
      .get(id) as SummaryRow | undefined;
    return this.placeOf(row, sum)[0] ?? null;
  }

  count(): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM places').get() as { n: number }).n;
  }

  put(p: Place): void {
    // v0.10: the visits summary is derived when read, never stored.
    const { visits: _derived, ...stored } = PlaceSchema.parse(p);
    this.core.db
      .prepare('INSERT INTO places (id, best, updated_at, json) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET best = excluded.best, updated_at = excluded.updated_at, json = excluded.json')
      .run(p.id, p.best, p.updatedAt, JSON.stringify(stored));
  }

  /** The café and every visit to it, in one transaction. True when there was a café to delete. */
  deletePlaceAndVisits(id: string): boolean {
    return this.core.db.tx(() => {
      this.core.db.prepare('DELETE FROM place_visits WHERE place_id = ?').run(id);
      return Number(this.core.db.prepare('DELETE FROM places WHERE id = ?').run(id).changes) > 0;
    });
  }

  // ---- visits ----------------------------------------------------------------

  /**
   * One page of a café's visits, newest first (day, then id), after the
   * visit `before` when given; `more` when older ones are left. Null when
   * `before` names no visit of this café.
   */
  visits(placeId: string, before: string | undefined, limit: number): { visits: PlaceVisit[]; more: boolean } | null {
    let rows: Row[];
    if (before === undefined) {
      rows = this.core.db.prepare('SELECT id, json FROM place_visits WHERE place_id = ? ORDER BY day DESC, id DESC LIMIT ?').all(placeId, limit + 1) as Row[];
    } else {
      const at = this.core.db.prepare('SELECT day FROM place_visits WHERE id = ? AND place_id = ?').get(before, placeId) as { day: string } | undefined;
      if (!at) return null;
      rows = this.core.db
        .prepare('SELECT id, json FROM place_visits WHERE place_id = ? AND (day < ? OR (day = ? AND id < ?)) ORDER BY day DESC, id DESC LIMIT ?')
        .all(placeId, at.day, at.day, before, limit + 1) as Row[];
    }
    const more = rows.length > limit;
    return { visits: rows.slice(0, limit).flatMap((r) => this.visitOf(r)), more };
  }

  visitGet(placeId: string, visitId: string): PlaceVisit | null {
    const row = this.core.db.prepare('SELECT id, json FROM place_visits WHERE id = ? AND place_id = ?').get(visitId, placeId) as Row | undefined;
    return row ? (this.visitOf(row)[0] ?? null) : null;
  }

  visitPut(v: PlaceVisit): void {
    this.core.db
      .prepare(
        'INSERT INTO place_visits (id, place_id, day, updated_at, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET place_id = excluded.place_id, day = excluded.day, updated_at = excluded.updated_at, json = excluded.json',
      )
      .run(v.id, v.placeId, v.day, v.updatedAt, JSON.stringify(PlaceVisitSchema.parse(v)));
  }

  /** True when there was one to delete. */
  visitDelete(placeId: string, visitId: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM place_visits WHERE id = ? AND place_id = ?').run(visitId, placeId).changes) > 0;
  }

  /** Every visit, across every café (the cap). */
  visitCount(): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM place_visits').get() as { n: number }).n;
  }

  private placeOf(r: Row, sum: SummaryRow | undefined): Place[] {
    const parsed = PlaceSchema.safeParse(parse(r.json));
    if (parsed.success) return [{ ...parsed.data, visits: summaryOf(sum) }];
    this.log.warn('life: a row failed its check and is left out', { table: 'places', id: r.id });
    return [];
  }

  private visitOf(r: Row): PlaceVisit[] {
    const parsed = PlaceVisitSchema.safeParse(parse(r.json));
    if (parsed.success) return [parsed.data];
    this.log.warn('life: a row failed its check and is left out', { table: 'place_visits', id: r.id });
    return [];
  }
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
