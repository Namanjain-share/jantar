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
 *
 * v0.11 People (P4): a repo reads the spaces its scope names (the owner:
 * his own `''` and every space he shares; a member: that one shared space)
 * and every query names them. `space` and `by_person` are columns, never in
 * the json, and are filled into a shared café's DTO on read (a café of the
 * owner's own keeps its 0.10 shape). A visit carries its café's space; moving
 * a café between spaces moves its visits in the same transaction (C5).
 */
import { PlaceVisitSchema, type Place, type PlaceVisit, type PlaceVisitsSummary } from '@jantar/protocol';
import { StoredPlaceSchema as PlaceSchema } from '@jantar/protocol/people';
import type { LifeCore, Logger } from '../../contracts.js';

type Row = { id: string; json: string; space?: string; by_person?: string };
type SummaryRow = { place_id: string; n: number; last: string | null; avg: number | null };

/** The spaces a repo reads, and the one it writes new rows to. */
export interface PlacesScope {
  read(): readonly string[];
}

const NO_VISITS: PlaceVisitsSummary = { count: 0, last: null, avgSpend: null };

function summaryOf(r: SummaryRow | undefined): PlaceVisitsSummary {
  if (!r) return { ...NO_VISITS };
  return { count: r.n, last: r.last, avgSpend: r.avg === null ? null : Math.round(r.avg) };
}

export class PlacesRepo {
  constructor(
    private readonly core: LifeCore,
    private readonly log: Logger,
    private readonly scope: PlacesScope = { read: () => [''] },
  ) {}

  /** `space IN (?, …)` and its values (never empty: a scope reads at least one space). */
  private spaces(col = 'space'): { sql: string; args: string[] } {
    const read = [...new Set(this.scope.read())];
    const list = read.length ? read : [''];
    return { sql: `${col} IN (${list.map(() => '?').join(', ')})`, args: list };
  }

  all(): Place[] {
    const sp = this.spaces();
    const rows = this.core.db.prepare(`SELECT id, json, space, by_person FROM places WHERE ${sp.sql}`).all(...sp.args) as Row[];
    const sums = this.core.db
      .prepare(`SELECT place_id, COUNT(*) AS n, MAX(day) AS last, AVG(CASE WHEN json_valid(json) THEN json_extract(json, '$.spend') END) AS avg FROM place_visits WHERE ${sp.sql} GROUP BY place_id`)
      .all(...sp.args) as SummaryRow[];
    const byPlace = new Map(sums.map((s) => [s.place_id, s]));
    return rows.flatMap((r) => this.placeOf(r, byPlace.get(r.id)));
  }

  get(id: string): Place | null {
    const sp = this.spaces();
    const row = this.core.db.prepare(`SELECT id, json, space, by_person FROM places WHERE id = ? AND ${sp.sql}`).get(id, ...sp.args) as Row | undefined;
    if (!row) return null;
    const sum = this.core.db
      .prepare("SELECT place_id, COUNT(*) AS n, MAX(day) AS last, AVG(CASE WHEN json_valid(json) THEN json_extract(json, '$.spend') END) AS avg FROM place_visits WHERE place_id = ? AND space = ? GROUP BY place_id")
      .get(id, row.space ?? '') as SummaryRow | undefined;
    return this.placeOf(row, sum)[0] ?? null;
  }

  /** Cafés in one space (LIFE_LIMITS count per space). */
  count(space = ''): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM places WHERE space = ?').get(space) as { n: number }).n;
  }

  /** A new café in `space`, by `by` (the author is set once, here). */
  insert(p: Place, space: string, by: string): void {
    // `by` and `space` are columns: the stored schema has neither, so the parse drops them from the json.
    const { visits: _derived, ...stored } = PlaceSchema.parse(p);
    this.core.db
      .prepare('INSERT INTO places (id, best, updated_at, json, space, by_person) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, p.best, p.updatedAt, JSON.stringify(stored), space, by);
  }

  /** A café's new json, in the space it is in (its author never changes). */
  put(p: Place): void {
    // v0.10: the visits summary is derived when read, never stored; v0.11: nor its space or author (columns).
    const { visits: _derived, ...stored } = PlaceSchema.parse(p);
    const sp = this.spaces();
    this.core.db.prepare(`UPDATE places SET best = ?, updated_at = ?, json = ? WHERE id = ? AND ${sp.sql}`).run(p.best, p.updatedAt, JSON.stringify(stored), p.id, ...sp.args);
  }

  /** v0.11 People (P4): move a café and its visits from one space to another (one transaction). */
  move(id: string, from: string, to: string): boolean {
    return this.core.db.tx(() => {
      const n = Number(this.core.db.prepare('UPDATE places SET space = ? WHERE id = ? AND space = ?').run(to, id, from).changes);
      if (n !== 1) return false;
      this.core.db.prepare('UPDATE place_visits SET space = ? WHERE place_id = ? AND space = ?').run(to, id, from);
      return true;
    });
  }

  /** The café and every visit to it, in one transaction. True when there was a café to delete. */
  deletePlaceAndVisits(id: string): boolean {
    const sp = this.spaces();
    return this.core.db.tx(() => {
      this.core.db.prepare(`DELETE FROM place_visits WHERE place_id = ? AND ${sp.sql}`).run(id, ...sp.args);
      return Number(this.core.db.prepare(`DELETE FROM places WHERE id = ? AND ${sp.sql}`).run(id, ...sp.args).changes) > 0;
    });
  }

  // ---- visits ----------------------------------------------------------------

  /**
   * One page of a café's visits, newest first (day, then id), after the
   * visit `before` when given; `more` when older ones are left. Null when
   * `before` names no visit of this café.
   */
  visits(placeId: string, before: string | undefined, limit: number): { visits: PlaceVisit[]; more: boolean } | null {
    const sp = this.spaces();
    let rows: Row[];
    if (before === undefined) {
      rows = this.core.db.prepare(`SELECT id, json, space, by_person FROM place_visits WHERE place_id = ? AND ${sp.sql} ORDER BY day DESC, id DESC LIMIT ?`).all(placeId, ...sp.args, limit + 1) as Row[];
    } else {
      const at = this.core.db.prepare(`SELECT day FROM place_visits WHERE id = ? AND place_id = ? AND ${sp.sql}`).get(before, placeId, ...sp.args) as { day: string } | undefined;
      if (!at) return null;
      rows = this.core.db
        .prepare(`SELECT id, json, space, by_person FROM place_visits WHERE place_id = ? AND ${sp.sql} AND (day < ? OR (day = ? AND id < ?)) ORDER BY day DESC, id DESC LIMIT ?`)
        .all(placeId, ...sp.args, at.day, at.day, before, limit + 1) as Row[];
    }
    const more = rows.length > limit;
    return { visits: rows.slice(0, limit).flatMap((r) => this.visitOf(r)), more };
  }

  visitGet(placeId: string, visitId: string): PlaceVisit | null {
    const sp = this.spaces();
    const row = this.core.db.prepare(`SELECT id, json, space, by_person FROM place_visits WHERE id = ? AND place_id = ? AND ${sp.sql}`).get(visitId, placeId, ...sp.args) as Row | undefined;
    return row ? (this.visitOf(row)[0] ?? null) : null;
  }

  /** A new or changed visit, in its café's space; `by` is set on insert only. */
  visitPut(v: PlaceVisit, space = '', by = ''): void {
    const stored = PlaceVisitSchema.parse(v);
    this.core.db
      .prepare(
        `INSERT INTO place_visits (id, place_id, day, updated_at, json, space, by_person) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET day = excluded.day, updated_at = excluded.updated_at, json = excluded.json
         WHERE place_visits.place_id = excluded.place_id AND place_visits.space = excluded.space`,
      )
      .run(v.id, v.placeId, v.day, v.updatedAt, JSON.stringify(stored), space, by);
  }

  /** True when there was one to delete. */
  visitDelete(placeId: string, visitId: string): boolean {
    const sp = this.spaces();
    return Number(this.core.db.prepare(`DELETE FROM place_visits WHERE id = ? AND place_id = ? AND ${sp.sql}`).run(visitId, placeId, ...sp.args).changes) > 0;
  }

  /** Visits in one space (the cap counts per space). */
  visitCount(space = ''): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM place_visits WHERE space = ?').get(space) as { n: number }).n;
  }

  private placeOf(r: Row, sum: SummaryRow | undefined): Place[] {
    const parsed = PlaceSchema.safeParse(parse(r.json));
    if (parsed.success) {
      const shared = r.space !== undefined && r.space !== '';
      return [{ ...parsed.data, visits: summaryOf(sum), ...(shared ? { space: r.space as string, by: r.by_person ?? '' } : {}) }];
    }
    this.log.warn('life: a row failed its check and is left out', { table: 'places', id: r.id });
    return [];
  }

  private visitOf(r: Row): PlaceVisit[] {
    const parsed = PlaceVisitSchema.safeParse(parse(r.json));
    if (parsed.success) return [{ ...parsed.data, ...(r.space ? { by: r.by_person ?? '' } : {}) }];
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
