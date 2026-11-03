/**
 * Work (v0.13): the owner's projects as a hub, and (later phases) his
 * clients, the log of calls and meetings, follow-ups and deals.
 *
 * - Owner-only by construction: its tables are named `work_*` and have no
 *   `space` column, only this folder names them (a source scan pins it),
 *   and nothing under the person routes, her Chat or her bundle imports it.
 * - It never runs SQL on `todos` or `projects`: projects and follow-ups are
 *   the Todos module's, which it is handed at build time and calls inside
 *   its own `db.tx` (a nested call joins it).
 * - Every method that takes an actor answers not_found for anyone but the
 *   owner (his devices, the CLI, the daemon itself).
 * - Nothing it logs, emits or audits names a client: ids and counts only.
 *
 * P1: the switch (`life.work`, on only while Todos is), no Today part,
 * search's clients and deals groups (empty until those exist), projects
 * made from client folders (`seed`), and a deleted project's links in
 * Work cleared inside the delete's transaction.
 */
import { LIFE_LIMITS, type SearchItem } from '@jantar/protocol';
import type { Actor, LifeCore, LifeModuleDeps, LifeResult, TodosModule, WorkModule } from '../../contracts.js';
import { TODO_REASONS, folderKey } from '../todos/module.js';

/** What a Work call says to anyone but the owner: there is nothing here. */
export const WORK_NOT_FOUND = 'Not found.';

/** The owner: his devices, the Mac's CLI, the daemon itself. A person (her app, her Chat) never is. */
export function isOwner(actor: Actor): boolean {
  return actor.kind === 'device' || actor.kind === 'cli' || actor.kind === 'system';
}

type Refusal = Extract<LifeResult, { ok: false }>;
const notFound: Refusal = { ok: false, code: 'not_found', reason: WORK_NOT_FOUND };

/** Thrown inside a transaction to roll it back with a module's refusal. */
class Rollback extends Error {
  constructor(readonly refusal: Refusal) {
    super('rollback');
  }
}

/** A folder as the seed compares it: as the Todos module does, any case (APFS ignores case). */
const seedKey = (folder: string) => folderKey(folder).toLowerCase();

class Work implements WorkModule {
  readonly name = 'work' as const;

  constructor(
    readonly core: LifeCore,
    readonly todos: TodosModule,
  ) {}

  /** No Today part until P2 (its card: check-ins, deals with no next step, quiet deals, closing this week). */
  today(_day: string): Record<string, never> {
    return {};
  }

  seed(items: readonly { folder: string; name: string }[], actor: Actor): LifeResult<{ projects: string[]; skipped: number }> {
    if (!isOwner(actor)) return notFound;
    const listed = this.todos.listProjects();
    if (!listed.ok) return listed;
    const linked = new Set(listed.value.projects.flatMap((p) => (p.folder ? [seedKey(p.folder)] : [])));
    const fresh: { folder: string; name: string }[] = [];
    let skipped = 0;
    for (const item of items) {
      const key = seedKey(item.folder);
      if (linked.has(key)) {
        skipped += 1;
        continue;
      }
      linked.add(key);
      fresh.push(item);
    }
    if (listed.value.projects.length + fresh.length > LIFE_LIMITS.projects) return { ok: false, code: 'conflict', reason: TODO_REASONS.projectsFull };
    try {
      const projects = this.core.db.tx(() =>
        fresh.map((item) => {
          const r = this.todos.createProject({ name: item.name, folder: item.folder }, actor);
          if (!r.ok) throw new Rollback(r);
          return r.value.id;
        }),
      );
      return { ok: true, value: { projects, skipped } };
    } catch (e) {
      if (e instanceof Rollback) return e.refusal;
      throw e;
    }
  }

  /** A deleted project's links in Work go with it, in the delete's own transaction (only this folder names work_ tables). */
  projectDeleted(projectId: string): void {
    const db = this.core.db;
    db.prepare('UPDATE work_log SET project_id = NULL WHERE project_id = ?').run(projectId);
    db.prepare("UPDATE work_deals SET json = json_remove(json, '$.projectId'), updated_at = ? WHERE json_extract(json, '$.projectId') = ?").run(this.core.now().toISOString(), projectId);
  }

  search(_q: string, _limit: number, actor: Actor): LifeResult<{ clients: SearchItem[]; deals: SearchItem[] }> {
    if (!isOwner(actor)) return notFound;
    // P2 fills clients (name, company, e-mails, phones by digits), P3 deals (title).
    return { ok: true, value: { clients: [], deals: [] } };
  }
}

/** Builds Work on `core`, after Todos (the service hands it over). */
export function buildWorkModule(core: LifeCore, _deps: LifeModuleDeps, todos: TodosModule): WorkModule {
  const work = new Work(core, todos);
  todos.onProjectDeleted((id) => work.projectDeleted(id));
  return work;
}
