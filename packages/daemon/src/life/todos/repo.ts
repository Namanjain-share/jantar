/**
 * Projects and todos in life.db (tables `projects` and `todos`): a few
 * indexed columns beside the record's JSON, which is checked with the
 * protocol schema on every read and write. A row that no longer parses is
 * left out of every answer (never repaired, never deleted) and counted in
 * the log by table, not by content.
 *
 * Every call reads `core.db` afresh: a restore swaps the handle.
 */
import { ProjectSchema, TodoSchema, type Project, type Todo } from '@jantar/protocol';
import type { LifeCore, Logger } from '../../contracts.js';

interface JsonRow {
  json: string;
}

export interface ProjectCounts {
  open: number;
  overdue: number;
}

/** Newest done todos `todosList?done=1` answers. */
export const DONE_LIST_MAX = 100;

export class TodosRepo {
  constructor(
    private readonly core: Pick<LifeCore, 'db'>,
    private readonly log: Logger,
  ) {}

  private parse<T>(table: string, rows: readonly JsonRow[], schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T[] {
    const out: T[] = [];
    let bad = 0;
    for (const r of rows) {
      let value: unknown;
      try {
        value = JSON.parse(r.json);
      } catch {
        bad += 1;
        continue;
      }
      const p = schema.safeParse(value);
      if (p.success) out.push(p.data);
      else bad += 1;
    }
    if (bad > 0) this.log.warn('life rows left out: they no longer parse', { table, rows: bad });
    return out;
  }

  // --- projects --------------------------------------------------------------

  project(id: string): Project | null {
    const r = this.core.db.prepare('SELECT json FROM projects WHERE id = ?').get(id) as JsonRow | undefined;
    return r ? (this.parse('projects', [r], ProjectSchema)[0] ?? null) : null;
  }

  projects(): Project[] {
    return this.parse('projects', this.core.db.prepare('SELECT json FROM projects').all() as unknown as JsonRow[], ProjectSchema);
  }

  projectCount(): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n);
  }

  saveProject(p: Project): void {
    const json = JSON.stringify(ProjectSchema.parse(p));
    this.core.db
      .prepare(
        `INSERT INTO projects (id, status, updated_at, json) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(p.id, p.status, p.updatedAt, json);
  }

  /** Delete a project; its todos move to no project (one transaction). */
  deleteProject(id: string, at: string): boolean {
    const db = this.core.db;
    return db.tx(() => {
      const gone = Number(db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) === 1;
      if (!gone) return false;
      const rows = db.prepare('SELECT json FROM todos WHERE project_id = ?').all(id) as unknown as JsonRow[];
      for (const t of this.parse('todos', rows, TodoSchema)) {
        const { projectId: _gone, ...rest } = t;
        this.saveTodo({ ...rest, updatedAt: at });
      }
      // A row that no longer parses still lets go of the project.
      db.prepare('UPDATE todos SET project_id = NULL WHERE project_id = ?').run(id);
      return true;
    });
  }

  /**
   * Open and overdue todo counts per project, in one grouped SELECT.
   * Overdue: due before `today`, or due today at a time before `nowHhmm`.
   */
  counts(today: string, nowHhmm: string): Map<string, ProjectCounts> {
    const rows = this.core.db
      .prepare(
        `SELECT project_id AS id, COUNT(*) AS open,
                SUM(CASE WHEN due_day < ? OR (due_day = ? AND json_extract(json, '$.due.time') < ?) THEN 1 ELSE 0 END) AS overdue
           FROM todos WHERE done_at IS NULL AND project_id IS NOT NULL GROUP BY project_id`,
      )
      .all(today, today, nowHhmm) as unknown as { id: string; open: number; overdue: number | null }[];
    return new Map(rows.map((r) => [r.id, { open: Number(r.open), overdue: Number(r.overdue ?? 0) }]));
  }

  // --- todos -----------------------------------------------------------------

  todo(id: string): Todo | null {
    const r = this.core.db.prepare('SELECT json FROM todos WHERE id = ?').get(id) as JsonRow | undefined;
    return r ? (this.parse('todos', [r], TodoSchema)[0] ?? null) : null;
  }

  /** Open todos, of one project or of none ('none') when `project` is given. Unsorted. */
  open(project?: string): Todo[] {
    const db = this.core.db;
    const rows =
      project === undefined
        ? db.prepare('SELECT json FROM todos WHERE done_at IS NULL').all()
        : project === 'none'
          ? db.prepare('SELECT json FROM todos WHERE done_at IS NULL AND project_id IS NULL').all()
          : db.prepare('SELECT json FROM todos WHERE done_at IS NULL AND project_id = ?').all(project);
    return this.parse('todos', rows as unknown as JsonRow[], TodoSchema);
  }

  /** Open todos due on or before `day` (Today's part). Unsorted. */
  openDueBy(day: string): Todo[] {
    const rows = this.core.db.prepare('SELECT json FROM todos WHERE done_at IS NULL AND due_day IS NOT NULL AND due_day <= ?').all(day);
    return this.parse('todos', rows as unknown as JsonRow[], TodoSchema);
  }

  /** The newest done todos (of one project, or of none). */
  done(project?: string, limit = DONE_LIST_MAX): Todo[] {
    const db = this.core.db;
    const rows =
      project === undefined
        ? db.prepare('SELECT json FROM todos WHERE done_at IS NOT NULL ORDER BY done_at DESC, id DESC LIMIT ?').all(limit)
        : project === 'none'
          ? db.prepare('SELECT json FROM todos WHERE done_at IS NOT NULL AND project_id IS NULL ORDER BY done_at DESC, id DESC LIMIT ?').all(limit)
          : db.prepare('SELECT json FROM todos WHERE done_at IS NOT NULL AND project_id = ? ORDER BY done_at DESC, id DESC LIMIT ?').all(project, limit);
    return this.parse('todos', rows as unknown as JsonRow[], TodoSchema);
  }

  openCount(): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM todos WHERE done_at IS NULL').get() as { n: number }).n);
  }

  /** Open todos with a due time: the ones that ring. */
  openTimed(): Todo[] {
    const rows = this.core.db.prepare("SELECT json FROM todos WHERE done_at IS NULL AND json_extract(json, '$.due.time') IS NOT NULL").all();
    return this.parse('todos', rows as unknown as JsonRow[], TodoSchema);
  }

  saveTodo(t: Todo): void {
    const json = JSON.stringify(TodoSchema.parse(t));
    this.core.db
      .prepare(
        `INSERT INTO todos (id, project_id, due_day, done_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, due_day = excluded.due_day,
           done_at = excluded.done_at, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(t.id, t.projectId ?? null, t.due?.day ?? null, t.doneAt ?? null, t.updatedAt, json);
  }

  deleteTodo(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM todos WHERE id = ?').run(id).changes) === 1;
  }

  /** A todo's ping row's next_at (null: no row, or parked after its ring). The scheduler writes `pings`; this only reads it. */
  pingAt(id: string): string | null {
    const r = this.core.db.prepare("SELECT next_at FROM pings WHERE kind = 'todo' AND ref = ?").get(id) as { next_at: string | null } | undefined;
    return r?.next_at ?? null;
  }

  /** Every `todo` ping row's next_at by ref (resync keeps the ones still set and clears the ones whose todo no longer rings). */
  pingTimes(): Map<string, string | null> {
    const rows = this.core.db.prepare("SELECT ref, next_at FROM pings WHERE kind = 'todo'").all() as unknown as { ref: string; next_at: string | null }[];
    return new Map(rows.map((r) => [r.ref, r.next_at]));
  }
}
