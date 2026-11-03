/**
 * v0.12 People (P2): day plans and plan templates in life.db (`day_plans`,
 * `plan_templates`, spec 9.1.1). One plan per space and day, its steps and
 * check-betweens inline; `id`, `day` and `srev` are columns and win over
 * the json. Every statement names its space (T6). A row that no longer
 * parses is left out, never repaired.
 */
import { DayPlanSchema, PlanTemplateSchema, type DayPlan, type PlanTemplate } from '@jantar/protocol/people';
import type { LifeCore } from '../../contracts.js';

type Core = Pick<LifeCore, 'db'>;

interface PlanRow {
  id: string;
  space: string;
  day: string;
  srev: number;
  json: string;
}

function parsePlan(r: PlanRow): DayPlan | null {
  try {
    const p = DayPlanSchema.safeParse({ ...(JSON.parse(r.json) as object), id: r.id, day: r.day, srev: Number(r.srev) });
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export function getPlan(core: Core, space: string, day: string): DayPlan | null {
  const r = core.db.prepare('SELECT id, space, day, srev, json FROM day_plans WHERE space = ? AND day = ?').get(space, day) as PlanRow | undefined;
  return r ? parsePlan(r) : null;
}

/** A plan by its id in any person space (the scheduler's `system` read): with the space it lives in. */
export function planById(core: Core, id: string): { space: string; plan: DayPlan } | null {
  const r = core.db.prepare("SELECT id, space, day, srev, json FROM day_plans WHERE id = ? AND space != ''").get(id) as PlanRow | undefined;
  if (!r) return null;
  const plan = parsePlan(r);
  return plan ? { space: r.space, plan } : null;
}

export function savePlan(core: Core, space: string, plan: DayPlan): void {
  const { id, day, srev, ...rest } = DayPlanSchema.parse(plan);
  core.db
    .prepare(
      `INSERT INTO day_plans (id, space, day, srev, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (space, day) DO UPDATE SET srev = excluded.srev, updated_at = excluded.updated_at, json = excluded.json`,
    )
    .run(id, space, day, srev, rest.updatedAt, JSON.stringify(rest));
}

export function deletePlan(core: Core, space: string, day: string): void {
  core.db.prepare('DELETE FROM day_plans WHERE space = ? AND day = ?').run(space, day);
}

/** Her plans from `from` on (her rings), oldest first. */
export function plansFrom(core: Core, space: string, from: string): DayPlan[] {
  const rows = core.db.prepare('SELECT id, space, day, srev, json FROM day_plans WHERE space = ? AND day >= ? ORDER BY day').all(space, from) as unknown as PlanRow[];
  return rows.flatMap((r) => parsePlan(r) ?? []);
}

/** Every plan in her space (her export). */
export function allPlans(core: Core, space: string): DayPlan[] {
  return plansFrom(core, space, '0000-01-01');
}

// --- templates -------------------------------------------------------------------------

function parseTemplate(json: string, id: string): PlanTemplate | null {
  try {
    const p = PlanTemplateSchema.safeParse({ ...(JSON.parse(json) as object), id });
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export function listTemplates(core: Core, space: string): PlanTemplate[] {
  const rows = core.db.prepare('SELECT id, json FROM plan_templates WHERE space = ? ORDER BY id').all(space) as { id: string; json: string }[];
  return rows.flatMap((r) => parseTemplate(r.json, r.id) ?? []);
}

export function getTemplate(core: Core, space: string, id: string): PlanTemplate | null {
  const r = core.db.prepare('SELECT id, json FROM plan_templates WHERE space = ? AND id = ?').get(space, id) as { id: string; json: string } | undefined;
  return r ? parseTemplate(r.json, r.id) : null;
}

export function saveTemplate(core: Core, space: string, t: PlanTemplate): void {
  const { id, ...rest } = PlanTemplateSchema.parse(t);
  core.db
    .prepare(
      `INSERT INTO plan_templates (id, space, updated_at, json) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json WHERE plan_templates.space = excluded.space`,
    )
    .run(id, space, rest.updatedAt, JSON.stringify(rest));
}

export function deleteTemplate(core: Core, space: string, id: string): boolean {
  return Number(core.db.prepare('DELETE FROM plan_templates WHERE space = ? AND id = ?').run(space, id).changes) > 0;
}
