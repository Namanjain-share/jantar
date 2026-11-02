/**
 * v0.12 People: what her export holds (spec 8.6), section by section, as the
 * data map names them (data-map.ts, T11). Every query names her space (T6).
 * Shared rows (P4) and later phases' tables join as their phases land.
 */
import type { DaemonContext } from '../../contracts.js';
import type { PeopleModule } from './module.js';

function rows(core: NonNullable<ReturnType<PeopleModule['openCore']>>, sql: string, ...args: (string | number)[]): unknown[] {
  return (core.db.prepare(sql).all(...args) as { json?: string }[]).map((r) => {
    if (typeof r.json !== 'string') return r;
    try {
      return JSON.parse(r.json) as unknown;
    } catch {
      return null;
    }
  });
}

export interface PersonExport {
  exportVersion: 1;
  exportedAt: string;
  person: { id: string; name: string; joinedAt?: string } | null;
  agreementHistory: { version: number; action: string; at: string; agreement: unknown }[];
  todos: unknown[];
  projects: unknown[];
  medicines: unknown[];
  doses: unknown[];
  weights: unknown[];
  food: unknown[];
  foodsSaved: unknown[];
  targets: { kcalTarget: number | null; goalKg: number | null };
  activity: unknown[];
}

export function exportSections(ctx: Pick<DaemonContext, 'clock'>, people: PeopleModule, pid: string): PersonExport {
  const core = people.openCore();
  const p = people.person(pid);
  const agreementHistory = people.ledgerRows(pid).map((r) => ({ version: r.version, action: r.action, at: r.at, agreement: r.json.agreement }));
  const empty: PersonExport = {
    exportVersion: 1,
    exportedAt: ctx.clock.iso(),
    person: p ? { id: p.id, name: p.name, ...(p.joinedAt ? { joinedAt: p.joinedAt } : {}) } : null,
    agreementHistory,
    todos: [],
    projects: [],
    medicines: [],
    doses: [],
    weights: [],
    food: [],
    foodsSaved: [],
    targets: { kcalTarget: null, goalKg: null },
    activity: [],
  };
  if (!core) return empty;
  const num = (key: string): number | null => {
    const v = Number(core.db.meta(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const goal = num(`goal_kg10:${pid}`);
  return {
    ...empty,
    todos: rows(core, 'SELECT json FROM todos WHERE space = ? ORDER BY id', pid),
    projects: rows(core, 'SELECT json FROM projects WHERE space = ? ORDER BY id', pid),
    medicines: rows(core, 'SELECT json FROM medicines WHERE space = ? ORDER BY id', pid),
    doses: rows(core, 'SELECT id, med_id AS medId, day, slot, status, at FROM doses WHERE space = ? ORDER BY day, slot', pid),
    weights: (core.db.prepare('SELECT day, kg10 FROM weights WHERE space = ? ORDER BY day').all(pid) as { day: string; kg10: number }[]).map((r) => ({ day: r.day, kg: r.kg10 / 10 })),
    food: rows(core, 'SELECT json FROM food WHERE space = ? ORDER BY day, at', pid),
    foodsSaved: rows(core, 'SELECT json FROM foods_saved WHERE space = ? ORDER BY id', pid),
    targets: { kcalTarget: num(`kcal_target:${pid}`), goalKg: goal === null ? null : goal / 10 },
    activity: allActivity(people, pid),
  };
}

/** Every Activity row of hers, newest first (paged through). */
function allActivity(people: PeopleModule, pid: string): unknown[] {
  const out: unknown[] = [];
  let before: number | undefined;
  for (;;) {
    const r = people.activity(pid, before);
    if (!r.ok) return out;
    out.push(...r.value.activity);
    if (r.value.before === null) return out;
    before = r.value.before;
  }
}
