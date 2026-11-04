/**
 * 0.14.0 Switching rules: the PATCH body, the reply, the plan's cap fields,
 * the two owner routes and the ccw_absent error.
 */
import { describe, expect, it } from 'vitest';
import {
  ERROR_STATUS,
  PlanResponseSchema,
  ROUTES,
  SWITCH_RULES,
  SwitchRulesPatchSchema,
  SwitchRulesSchema,
  WeeklyRampSchema,
  type RouteDef,
} from '../src/index.js';
import { PERSON_ROUTES } from '../src/people.js';

const ramp = { days: [50, 50, 50, 50, 75, 85, 95], lastHour: 100 };
const ok = (b: unknown) => SwitchRulesPatchSchema.safeParse(b).success;

describe('0.14.0 switching rules', () => {
  it('takes each of the five keys, alone or together', () => {
    expect(ok({ hold: [1, 3] })).toBe(true);
    expect(ok({ hold: [] })).toBe(true);
    expect(ok({ ceiling: 97 })).toBe(true);
    expect(ok({ weeklyCeiling: 99 })).toBe(true);
    expect(ok({ leadMin: 10 })).toBe(true);
    expect(ok({ weeklyRamp: { '2': ramp } })).toBe(true);
    expect(ok({ weeklyRamp: { '2': null, '0': ramp, '99': ramp } })).toBe(true);
    expect(ok({ hold: [0, 99], ceiling: 50, weeklyCeiling: 100, leadMin: 60, weeklyRamp: {} })).toBe(true);
    expect(SwitchRulesPatchSchema.parse({ weeklyRamp: { '2': null } })).toEqual({ weeklyRamp: { '2': null } });
  });

  it('refuses an empty save, unknown keys and values out of range', () => {
    expect(ok({})).toBe(false);
    expect(ok({ on: true })).toBe(false); // only the five keys
    expect(ok({ ceiling: 97, dry_run: false })).toBe(false);
    expect(ok({ hold: [1, 1] })).toBe(false); // each account once
    expect(ok({ hold: [100] })).toBe(false);
    expect(ok({ hold: [-1] })).toBe(false);
    expect(ok({ hold: [1.5] })).toBe(false);
    for (const v of [49, 101, 97.5, '97']) {
      expect(ok({ ceiling: v }), `ceiling ${v}`).toBe(false);
      expect(ok({ weeklyCeiling: v }), `weeklyCeiling ${v}`).toBe(false);
    }
    expect(ok({ leadMin: 0 })).toBe(false);
    expect(ok({ leadMin: 61 })).toBe(false);
  });

  it('takes a ramp of seven days and a last hour, each 1 to 100, under an account number', () => {
    expect(WeeklyRampSchema.safeParse(ramp).success).toBe(true);
    expect(WeeklyRampSchema.safeParse({ days: [1, 1, 1, 1, 1, 1, 1], lastHour: 1 }).success).toBe(true);
    expect(WeeklyRampSchema.safeParse({ days: [50, 50, 50, 50, 75, 85], lastHour: 100 }).success).toBe(false); // six days
    expect(WeeklyRampSchema.safeParse({ days: [...ramp.days, 95], lastHour: 100 }).success).toBe(false); // eight
    expect(WeeklyRampSchema.safeParse({ days: [0, 50, 50, 50, 75, 85, 95], lastHour: 100 }).success).toBe(false);
    expect(WeeklyRampSchema.safeParse({ days: [50, 50, 50, 50, 75, 85, 101], lastHour: 100 }).success).toBe(false);
    expect(WeeklyRampSchema.safeParse({ days: ramp.days, lastHour: 100.5 }).success).toBe(false);
    expect(WeeklyRampSchema.safeParse({ days: ramp.days }).success).toBe(false);
    for (const key of ['02', '-1', '100', 'two', '', ' 2', '2.0']) expect(ok({ weeklyRamp: { [key]: ramp } }), `key ${key}`).toBe(false);
    expect(ok({ weeklyRamp: { '2': { days: ramp.days, last_hour: 100 } } })).toBe(false); // the file's spelling is not the API's
  });

  it('has the preset the sheet fills in', () => {
    expect(SWITCH_RULES.preset).toEqual(ramp);
    expect(WeeklyRampSchema.safeParse(SWITCH_RULES.preset).success).toBe(true);
  });

  it('replies with the rules as saved', () => {
    const rules = { hold: [3], ceiling: 97, weeklyCeiling: 99, leadMin: 10, weeklyRamp: { '2': ramp } };
    expect(SwitchRulesSchema.parse(rules)).toEqual(rules);
  });

  it("puts a ccw plan's cap, when it next changes and to what on each account", () => {
    const plan = {
      source: 'ccw-legacy',
      next: null,
      updatedAt: null,
      accounts: [
        { id: 2, burnPctPerMin: 0, ridesReset: true, usable: true, weeklyCap: 50, capUntil: '2026-11-05T22:30:00.000Z', nextCap: 75 },
        { id: 3, burnPctPerMin: 0, ridesReset: true, usable: true },
      ],
    };
    expect(PlanResponseSchema.parse(plan)).toEqual(plan);
    expect(PlanResponseSchema.safeParse({ ...plan, accounts: [{ ...plan.accounts[0], weeklyCap: 0 }] }).success).toBe(false);
  });

  it('serves two owner routes at control scope, never one of hers', () => {
    const get = ROUTES.getSwitchRules as RouteDef;
    const patch = ROUTES.patchSwitchRules as RouteDef;
    expect([get.method, get.path, get.scope, get.phase]).toEqual(['GET', '/v1/accounts/switching', 'control', 'v0.14']);
    expect([patch.method, patch.path, patch.scope, patch.phase]).toEqual(['PATCH', '/v1/accounts/switching', 'control', 'v0.14']);
    expect(patch.body).toBe(SwitchRulesPatchSchema);
    const hers = Object.values(PERSON_ROUTES) as RouteDef[];
    expect(hers.some((d) => d.path.includes('/switching') || d.phase === 'v0.14')).toBe(false);
  });

  it('answers 404 ccw_absent on a Mac without ccw', () => {
    expect(ERROR_STATUS.ccw_absent).toBe(404);
  });
});
