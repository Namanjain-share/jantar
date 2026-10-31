/**
 * Every Life module builder gives a module the service can drive, WP0's
 * stubs and the real modules that replace them alike: built on a test core,
 * its lifecycle hooks (`start?.()`, `stop?.()`) run without a throw, its part
 * of Today answers, and food says whether Ask Claude can run
 * (LifeStatus.estimate) instead of throwing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LifeModule, LifeModuleName } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { makeFakes } from '../api/fakes.js';

const ALL_ON = { todos: true, medicines: true, food: true, places: true, finance: true };

let core: TestLifeCore | undefined;
afterEach(() => {
  core?.close();
  core = undefined;
});

function deps() {
  const ctx = createTestContext();
  const f = makeFakes(ctx);
  return { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy };
}

describe('LIFE_MODULE_BUILDERS', () => {
  it('builds each module with its name; start?, stop? and today() do not throw', () => {
    core = createTestLifeCore({ tz: 'Asia/Kolkata', settings: ALL_ON });
    core.clock.set('2026-10-30T06:00:00.000Z');
    const d = deps();
    for (const [name, build] of Object.entries(LIFE_MODULE_BUILDERS) as [LifeModuleName, (c: TestLifeCore, x: typeof d) => LifeModule][]) {
      const m = build(core, d);
      expect(m.name, name).toBe(name);
      expect(() => m.start?.(), `${name} start`).not.toThrow();
      expect(() => m.today(core!.today()), `${name} today`).not.toThrow();
      expect(() => m.stop?.(), `${name} stop`).not.toThrow();
    }
  });

  it("food reports Ask Claude's availability without a throw", () => {
    core = createTestLifeCore({ settings: ALL_ON });
    const food = LIFE_MODULE_BUILDERS.food(core, deps());
    const status = food.estimateStatus();
    expect(typeof status.available).toBe('boolean');
    if (!status.available) expect(status.reason).toEqual(expect.any(String));
  });
});
