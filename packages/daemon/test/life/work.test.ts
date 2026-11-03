/**
 * v0.13 Work, P1 (life/work): the switch.
 *
 * - `work` routes answer only while life.work and life.todos are both on
 *   (featureOn), with the sentence that names `jantar work on`, and 503
 *   while life.db is broken, as every Life route does;
 * - Life status says Work is on only while it works (Todos on too);
 * - the service builds Work after Todos, with every real module.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema, type Settings } from '@jantar/protocol';
import type { LifeService } from '../../src/contracts.js';
import { FEATURE_OFF, LIFE_FEATURES, featureOn } from '../../src/api/app.js';
import { createTestContext } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { makeFakes } from '../api/fakes.js';

const settings = (life: Partial<Settings['life']>): Settings => SettingsSchema.parse({ life });

describe('v0.13 the work switch', () => {
  it('a work route is on only while Work and Todos are both on', () => {
    const def = { feature: 'work' as const };
    expect(featureOn(def, settings({}))).toBe(false);
    expect(featureOn(def, settings({ work: true }))).toBe(false);
    expect(featureOn(def, settings({ todos: true }))).toBe(false);
    expect(featureOn(def, settings({ work: true, todos: true }))).toBe(true);
    expect(FEATURE_OFF.work).toEqual({ code: 'forbidden', message: 'Work is off. Turn it on at your Mac: jantar work on' });
    // Its routes answer 503 while life.db is broken, and count against the Life write limit.
    expect(LIFE_FEATURES.has('work')).toBe(true);
  });

  describe('the service', () => {
    let dir: string;
    let life: LifeService | undefined;
    beforeEach(async () => {
      dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-work-')));
    });
    afterEach(async () => {
      await life?.stop();
      life = undefined;
      await rm(dir, { recursive: true, force: true });
    });

    const start = async (s: Settings) => {
      const ctx = createTestContext({ home: dir, settings: s });
      ctx.clock.set('2026-11-03T09:00:00.000Z');
      const f = makeFakes(ctx);
      life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
      await life.start();
      return { ctx, life };
    };

    it('builds Work with every real module; status says it is on only with Todos on too', async () => {
      const { ctx, life } = await start(settings({ todos: true, work: true }));
      expect(life.broken()).toBeNull();
      expect(life.work.name).toBe('work');
      expect(life.status().modules).toMatchObject({ todos: true, work: true });
      await ctx.settings.patch({ life: { todos: false } });
      expect(life.status().modules).toMatchObject({ todos: false, work: false });
      const today = life.today();
      expect(today.ok).toBe(true);
    });
  });
});
