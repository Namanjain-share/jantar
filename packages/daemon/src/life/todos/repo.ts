/**
 * Projects and todos in life.db (tables `projects` and `todos`): a few
 * indexed columns beside the record's JSON, which is checked with the
 * protocol schema on every read and write. A row that no longer parses is
 * left out of every answer (never repaired, never deleted) and counted in
 * the log by table, not by content.
 *
 * Every call reads `core.db` afresh: a restore swaps the handle.
 *
 * v0.11 People: a repo works in one space (`''` the owner's, `<pid>` hers):
 * every query names it, so the owner's repo never sees a row of hers and
 * the reverse. `by_person` is the row's author, set on insert and never
 * changed; a row's json never holds `by` or `space` (they come from the
 * columns). Rows parse with PersonTodoSchema, the owner's Todo plus
 * People's optional fields, so no edit drops them. The ping handler alone
 * reads across spaces (`anySpace`), to ring each todo on its own person's
 * devices.
 */
import type { Project, Todo } from '@jantar/protocol';
import { PersonTodoSchema, StoredProjectSchema as ProjectSchema } from '@jantar/protocol/people';
import type { LifeCore, Logger } from '../../contracts.js';
import { foldText, holdsFolded } from '../../core/fold.js';

interface JsonRow {
  json: string;
  by_person?: string;
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
    /** v0.11: the space this repo reads and writes. */
    readonly space = '',
  ) {}

  /** This repo, in another space. */
  inSpace(space: string): TodosRepo {
    return space === this.space ? this : new TodosRepo(this.core, this.log, space);
  }

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
      if (p.success) out.push(this.space !== '' && r.by_person !== undefined ? ({ ...p.data, by: r.by_person } as T) : p.data);
      else bad += 1;
    }
    if (bad > 0) this.log.warn('life rows left out: they no longer parse', { table, rows: bad });
    return out;
  }

  // --- projects --------------------------------------------------------------

  project(id: string): Project | null {
    const r = this.core.db.prepare('SELECT json FROM projects WHERE space = ? AND id = ?').get(this.space, id) as JsonRow | undefined;
    return r ? (this.parse('projects', [r], ProjectSchema)[0] ?? null) : null;
  }

  projects(): Project[] {
    return this.parse('projects', this.core.db.prepare('SELECT json FROM projects WHERE space = ?').all(this.space) as unknown as JsonRow[], ProjectSchema);
  }

  projectCount(): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE space = ?').get(this.space) as { n: number }).n);
  }

  saveProject(p: Project): void {
    const json = JSON.stringify(ProjectSchema.parse(p));
    this.core.db
      .prepare(
        `INSERT INTO projects (id, status, updated_at, json, space) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, json = excluded.json
         WHERE projects.space = excluded.space`,
      )
      .run(p.id, p.status, p.updatedAt, json, this.space);
  }

  /** Delete a project; its todos move to no project (one transaction). */
  deleteProject(id: string, at: string): boolean {
    const db = this.core.db;
    return db.tx(() => {
      const gone = Number(db.prepare('DELETE FROM projects WHERE space = ? AND id = ?').run(this.space, id).changes) === 1;
      if (!gone) return false;
      const rows = db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND project_id = ?').all(this.space, id) as unknown as JsonRow[];
      for (const t of this.parse('todos', rows, PersonTodoSchema)) {
        const { projectId: _gone, ...rest } = t;
        this.saveTodo({ ...rest, updatedAt: at });
      }
      // A row that no longer parses still lets go of the project.
      db.prepare('UPDATE todos SET project_id = NULL WHERE space = ? AND project_id = ?').run(this.space, id);
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
           FROM todos WHERE space = ? AND done_at IS NULL AND project_id IS NOT NULL GROUP BY project_id`,
      )
      .all(today, today, nowHhmm, this.space) as unknown as { id: string; open: number; overdue: number | null }[];
    return new Map(rows.map((r) => [r.id, { open: Number(r.open), overdue: Number(r.overdue ?? 0) }]));
  }

  // --- todos -----------------------------------------------------------------

  todo(id: string): Todo | null {
    const r = this.core.db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND id = ?').get(this.space, id) as JsonRow | undefined;
    return r ? (this.parse('todos', [r], PersonTodoSchema)[0] ?? null) : null;
  }

  /** Open todos, of one project or of none ('none') when `project` is given. Unsorted. */
  open(project?: string): Todo[] {
    const db = this.core.db;
    const rows =
      project === undefined
        ? db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NULL').all(this.space)
        : project === 'none'
          ? db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NULL AND project_id IS NULL').all(this.space)
          : db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NULL AND project_id = ?').all(this.space, project);
    return this.parse('todos', rows as unknown as JsonRow[], PersonTodoSchema);
  }

  /** Open todos due on or before `day` (Today's part). Unsorted. */
  openDueBy(day: string): Todo[] {
    const rows = this.core.db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NULL AND due_day IS NOT NULL AND due_day <= ?').all(this.space, day);
    return this.parse('todos', rows as unknown as JsonRow[], PersonTodoSchema);
  }

  /** The newest done todos (of one project, or of none). */
  done(project?: string, limit = DONE_LIST_MAX): Todo[] {
    const db = this.core.db;
    const rows =
      project === undefined
        ? db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NOT NULL ORDER BY done_at DESC, id DESC LIMIT ?').all(this.space, limit)
        : project === 'none'
          ? db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NOT NULL AND project_id IS NULL ORDER BY done_at DESC, id DESC LIMIT ?').all(this.space, limit)
          : db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NOT NULL AND project_id = ? ORDER BY done_at DESC, id DESC LIMIT ?').all(this.space, project, limit);
    return this.parse('todos', rows as unknown as JsonRow[], PersonTodoSchema);
  }

  /**
   * v0.13: open todos (of one project, or of none), or the newest `limit`
   * done ones, whose title or notes hold `q`, any case or accent (foldText). `q` never reaches
   * the SQL: rows are read by the bound space and project, matched here.
   */
  matching(q: string, done: boolean, project?: string, limit = DONE_LIST_MAX): Todo[] {
    const needle = foldText(q);
    const holds = (t: { title?: unknown; notes?: unknown }) => holdsFolded(needle, t.title, t.notes);
    if (!done) return this.open(project).filter(holds);
    const db = this.core.db;
    const all = (
      project === undefined
        ? db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NOT NULL ORDER BY done_at DESC, id DESC').all(this.space)
        : project === 'none'
          ? db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NOT NULL AND project_id IS NULL ORDER BY done_at DESC, id DESC').all(this.space)
          : db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NOT NULL AND project_id = ? ORDER BY done_at DESC, id DESC').all(this.space, project)
    ) as unknown as JsonRow[];
    const hits: JsonRow[] = [];
    for (const r of all) {
      if (hits.length >= limit) break;
      let value: unknown;
      try {
        value = JSON.parse(r.json);
      } catch {
        continue;
      }
      if (value && typeof value === 'object' && holds(value)) hits.push(r);
    }
    return this.parse('todos', hits, PersonTodoSchema);
  }

  /** v0.13 (the project hub): when each of a project's todos done since `sinceIso` was done. */
  doneAtSince(project: string, sinceIso: string): string[] {
    const rows = this.core.db.prepare('SELECT done_at FROM todos WHERE space = ? AND project_id = ? AND done_at >= ?').all(this.space, project, sinceIso) as unknown as { done_at: string }[];
    return rows.map((r) => r.done_at);
  }

  /** v0.13 (the project hub): the newest change to any of a project's todos, or null when it has none. */
  lastTodoChange(project: string): string | null {
    const r = this.core.db.prepare('SELECT MAX(updated_at) AS at FROM todos WHERE space = ? AND project_id = ?').get(this.space, project) as { at: string | null } | undefined;
    return r?.at ?? null;
  }

  openCount(): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM todos WHERE space = ? AND done_at IS NULL').get(this.space) as { n: number }).n);
  }

  /** Open todos with a due time: the ones that ring. */
  openTimed(): Todo[] {
    const rows = this.core.db.prepare("SELECT json, by_person FROM todos WHERE space = ? AND done_at IS NULL AND json_extract(json, '$.due.time') IS NOT NULL").all(this.space);
    return this.parse('todos', rows as unknown as JsonRow[], PersonTodoSchema);
  }

  /**
   * The ping handler's reads (the `system` sweep, C4): a todo in any space
   * with the space it lives in, and every open timed todo of every space,
   * so a reminder of hers keeps ringing her devices after a restart.
   */
  /** v0.11: `by` is the row's author ('' the owner): his timed to-do in her space rings by her state (spec 3.6). */
  anySpace(id: string): { todo: Todo; space: string; by: string } | null {
    const r = this.core.db.prepare('SELECT json, space, by_person FROM todos WHERE id = ? AND space = space').get(id) as (JsonRow & { space: string }) | undefined;
    if (!r) return null;
    const t = this.parse('todos', [{ json: r.json }], PersonTodoSchema)[0];
    return t ? { todo: t, space: r.space, by: r.by_person ?? '' } : null;
  }

  openTimedAnySpace(): { todo: Todo; space: string }[] {
    const rows = this.core.db
      .prepare("SELECT json, space FROM todos WHERE space = space AND done_at IS NULL AND json_extract(json, '$.due.time') IS NOT NULL")
      .all() as unknown as (JsonRow & { space: string })[];
    return rows.flatMap((r) => {
      const t = this.parse('todos', [r], PersonTodoSchema)[0];
      return t ? [{ todo: t, space: r.space }] : [];
    });
  }

  /**
   * Insert or update. `by` (the author) is written on insert only and never
   * changed by an update; `by` and `space` never go into the json.
   */
  saveTodo(t: Todo, by = ''): void {
    const { by: _by, ...rest } = t as Todo & { by?: string };
    const json = JSON.stringify(PersonTodoSchema.parse(rest));
    this.core.db
      .prepare(
        `INSERT INTO todos (id, project_id, due_day, done_at, updated_at, json, space, by_person, contact_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, due_day = excluded.due_day,
           done_at = excluded.done_at, updated_at = excluded.updated_at, json = excluded.json, contact_id = excluded.contact_id
         WHERE todos.space = excluded.space`,
      )
      // v0.13 Work: contact_id, a follow-up's client beside its json (only his own todos ever carry one).
      .run(t.id, t.projectId ?? null, t.due?.day ?? null, t.doneAt ?? null, t.updatedAt, json, this.space, by, t.contactId ?? null);
  }

  // --- v0.13 Work: follow-ups (todos with a client) and projects with a client, in this repo's space

  /** Follow-ups: open ones (by any client, or by one), or one client's done ones (newest first). Unsorted when open. */
  followUps(contactId: string | null, done: boolean): Todo[] {
    const db = this.core.db;
    const rows =
      contactId === null
        ? done
          ? db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND contact_id IS NOT NULL AND done_at IS NOT NULL').all(this.space)
          : db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND contact_id IS NOT NULL AND done_at IS NULL').all(this.space)
        : done
          ? db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND contact_id = ? AND done_at IS NOT NULL ORDER BY done_at DESC, id DESC').all(this.space, contactId)
          : db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND contact_id = ? AND done_at IS NULL').all(this.space, contactId);
    return this.parse('todos', rows as unknown as JsonRow[], PersonTodoSchema);
  }

  /** How many todos (open or done) name the client. */
  followUpCount(contactId: string): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM todos WHERE space = ? AND contact_id = ?').get(this.space, contactId) as { n: number }).n);
  }

  /** Every todo naming the client (open and done), for unlinking it. */
  allOfContact(contactId: string): Todo[] {
    const rows = this.core.db.prepare('SELECT json, by_person FROM todos WHERE space = ? AND contact_id = ?').all(this.space, contactId);
    return this.parse('todos', rows as unknown as JsonRow[], PersonTodoSchema);
  }

  /** The column alone, for a row that no longer parses: it lets go of the client too. */
  clearContactColumn(contactId: string): void {
    this.core.db.prepare('UPDATE todos SET contact_id = NULL WHERE space = ? AND contact_id = ?').run(this.space, contactId);
  }

  deleteTodo(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM todos WHERE space = ? AND id = ?').run(this.space, id).changes) === 1;
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
