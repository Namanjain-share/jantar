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
 * P1: the switch (`life.work`, on only while Todos is) and no Today part.
 */
import type { LifeCore, LifeModuleDeps, TodosModule, WorkModule } from '../../contracts.js';

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
}

/** Builds Work on `core`, after Todos (the service hands it over). */
export function buildWorkModule(core: LifeCore, _deps: LifeModuleDeps, todos: TodosModule): WorkModule {
  return new Work(core, todos);
}
