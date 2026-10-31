/**
 * The v0.4 route table: 48 routes, every one at control scope (reads
 * included), each Life module behind its own switch, none of the health,
 * food or money routes on ctl.sock (LG4), write replies that carry ids only
 * (LP2), and no path taken or returned by the shelf (LI1, protocol part).
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  IdReplySchema,
  IntelCaptureReplySchema,
  IntelSourcesResponseSchema,
  LifeBackupResponseSchema,
  LifeRestoreResponseSchema,
  OkReplySchema,
  ROUTES,
  buildPath,
  type RouteDef,
  type RouteName,
} from '../src/index.js';

const routes = Object.entries(ROUTES) as [RouteName, RouteDef][];
const v04 = routes.filter(([, r]) => r.phase === 'v0.4');
const byFeature = (f: string | undefined) => v04.filter(([, r]) => r.feature === f).map(([n]) => n).sort();

/** The keys of an object schema (through refinements), or [] for anything else. */
function keysOf(schema: z.ZodType | undefined): string[] {
  const s = schema as unknown as { shape?: Record<string, unknown>; options?: z.ZodType[] } | undefined;
  if (!s) return [];
  if (s.shape) return Object.keys(s.shape);
  if (s.options) return s.options.flatMap((o) => keysOf(o));
  return [];
}

describe('v0.4 routes', () => {
  it('are 48, all under /v1 with a summary, GETs without a body', () => {
    expect(v04.length).toBe(48);
    for (const [name, r] of v04) {
      expect(r.path.startsWith('/v1/'), name).toBe(true);
      expect(r.summary.length, name).toBeGreaterThan(5);
      if (r.method === 'GET') expect(r.body, name).toBeUndefined();
    }
  });

  it('need control scope, reads included (U6)', () => {
    for (const [name, r] of v04) expect(r.scope, name).toBe('control');
  });

  it('sit behind their module, Life as a whole, the shelf or launching', () => {
    expect(byFeature('todos')).toEqual(['projectCreate', 'projectDelete', 'projectUpdate', 'projectsList', 'todoCreate', 'todoDelete', 'todoDone', 'todoSnooze', 'todoUpdate', 'todosList']);
    expect(byFeature('medicines')).toEqual(['doseLog', 'doseUndo', 'medCreate', 'medDelete', 'medStop', 'medUpdate', 'medsGet']);
    expect(byFeature('food')).toEqual(['foodAdd', 'foodDay', 'foodDelete', 'foodEstimate', 'foodSavedDelete', 'foodTargets', 'foodUpdate', 'weightDelete', 'weightSet']);
    expect(byFeature('places')).toEqual(['placeCreate', 'placeDelete', 'placeUpdate', 'placesList']);
    expect(byFeature('finance')).toEqual(['billCreate', 'billDelete', 'billPaid', 'billUpdate', 'budgetSet', 'moneyAdd', 'moneyDelete', 'moneyMonth', 'moneyUpdate']);
    expect(byFeature('life')).toEqual(['lifeToday']);
    expect(byFeature('intel')).toEqual(['intelCapture', 'intelGet', 'intelList', 'intelSources']);
    expect(byFeature('launch')).toEqual(['launchHistory']);
    // Status always answers (it says which modules are on); backup and restore work while every module is off.
    expect(byFeature(undefined)).toEqual(['lifeBackup', 'lifeRestore', 'lifeStatus']);
  });

  it('LG4: no health, food, money, todo or Today route is served on ctl.sock', () => {
    const PRIVATE = ['/v1/medicines', '/v1/food', '/v1/weights', '/v1/places', '/v1/money', '/v1/bills', '/v1/todos', '/v1/projects', '/v1/life/today'];
    for (const [name, r] of routes) {
      if (PRIVATE.some((p) => r.path === p || r.path.startsWith(`${p}/`))) expect(r.ctl, name).toBe(false);
    }
    expect(v04.filter(([, r]) => r.ctl).map(([n]) => n).sort()).toEqual(
      ['intelCapture', 'intelGet', 'intelList', 'intelSources', 'launchHistory', 'lifeBackup', 'lifeRestore', 'lifeStatus'].sort(),
    );
  });

  it('LG5: backup and restore are the Mac only', () => {
    expect(v04.filter(([, r]) => r.localOnly).map(([n]) => n).sort()).toEqual(['lifeBackup', 'lifeRestore']);
  });

  it('LP2: write replies carry ids or ok only (the estimate is the one computation)', () => {
    const ALLOWED: z.ZodType[] = [IdReplySchema, OkReplySchema, IntelCaptureReplySchema, LifeBackupResponseSchema, LifeRestoreResponseSchema];
    for (const [name, r] of v04) {
      if (r.method === 'GET' || name === 'foodEstimate') continue;
      expect(ALLOWED.includes(r.response as z.ZodType), name).toBe(true);
    }
    // The id and ok replies hold nothing else.
    expect(Object.keys(IdReplySchema.shape)).toEqual(['id']);
    expect(Object.keys(OkReplySchema.shape)).toEqual(['ok']);
    expect(Object.keys(IntelCaptureReplySchema.shape).sort()).toEqual(['duplicate', 'id']);
  });

  it('LI1: the shelf takes no path and gives none back', () => {
    for (const [name, r] of v04.filter(([, d]) => d.feature === 'intel')) {
      for (const key of [...keysOf(r.body), ...keysOf(r.query), ...keysOf(r.params)]) {
        expect(key, name).not.toMatch(/path|file|dir|source/i);
      }
    }
    const source = (IntelSourcesResponseSchema.shape.sources as unknown as { element: { shape: Record<string, unknown> } }).element.shape;
    expect(Object.keys(source).sort()).toEqual(['error', 'id', 'items', 'label', 'skipped', 'updatedAt']);
  });

  it('no two routes share a method and path', () => {
    const seen = new Set<string>();
    for (const [name, r] of routes) {
      const key = `${r.method} ${r.path}`;
      expect(seen.has(key), name).toBe(false);
      seen.add(key);
    }
  });

  it('encodes a shelf id in its path', () => {
    expect(buildPath(ROUTES.intelGet, { id: 'intel:abc/1' })).toBe('/v1/intel/items/intel%3Aabc%2F1');
  });
});
