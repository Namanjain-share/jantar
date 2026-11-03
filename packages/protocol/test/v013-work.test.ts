/**
 * v0.13 Work, P1 (protocol): the switch, a seventh Life module that counts
 * as on only while Todos is on too.
 */
import { describe, expect, it } from 'vitest';
import { LIFE_LIMITS, LIFE_MODULES, LifeSettingsSchema, SettingsSchema, lifeOn, settingsFeatures, workOn } from '../src/index.js';

describe('v0.13 the work switch', () => {
  it('is a seventh Life module, last, off by default', () => {
    expect(LIFE_MODULES.at(-1)).toBe('work');
    expect(LifeSettingsSchema.parse({}).work).toBe(false);
  });

  it('counts as on only while Todos is on too', () => {
    expect(workOn(SettingsSchema.parse({ life: { work: true } }))).toBe(false);
    expect(workOn(SettingsSchema.parse({ life: { todos: true } }))).toBe(false);
    expect(workOn(SettingsSchema.parse({ life: { work: true, todos: true } }))).toBe(true);
    // Alone it still opens life.db (any module on), so the switch can be read and turned off again.
    expect(lifeOn(SettingsSchema.parse({ life: { work: true } }))).toBe(true);
  });

  it('is never one of the features every device sees (which Life modules are on is a control read)', () => {
    expect(Object.keys(settingsFeatures(SettingsSchema.parse({ life: { work: true, todos: true } })))).not.toContain('work');
  });

  it('a project cap of 500 (done client projects pile up)', () => {
    expect(LIFE_LIMITS.projects).toBe(500);
  });
});
