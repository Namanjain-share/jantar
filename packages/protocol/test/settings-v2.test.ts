/**
 * Settings version 2 (v0.4): the life, intel and accounts groups (Mac only),
 * the `claude` launch mode and launch defaults that are safe for anyone.
 * A version-1 file is migrated by the daemon before it is parsed
 * (daemon/test/config/migrate.test.ts); the schema itself takes version 2 only.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAUNCH_FLAGS,
  LIFE_MODULES,
  MAC_ONLY_SETTING_GROUPS,
  SETTINGS_VERSION,
  SettingsSchema,
  V03_LAUNCH_FLAGS,
  applySettingsPatch,
  defaultSettings,
  launchFlagsDangerous,
  lifeOn,
  macOnlyGroupIn,
  settingsFeatures,
} from '../src/index.js';

describe('settings version 2', () => {
  it('is version 2 and refuses a version-1 object (the daemon migrates the file first)', () => {
    expect(SETTINGS_VERSION).toBe(2);
    expect(defaultSettings().version).toBe(2);
    expect(SettingsSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ version: 2 }).success).toBe(true);
  });

  it('ships every Life module, the shelf and the kept accounts off or empty', () => {
    const s = defaultSettings();
    expect(s.life).toEqual({
      todos: false,
      medicines: false,
      food: false,
      places: false,
      finance: false,
      posts: false,
      timezone: null,
      currency: null,
      lockScreenDetails: false,
    });
    expect(s.intel).toEqual({ enabled: false, sources: [] });
    expect(s.accounts).toEqual({ kept: [], prime: false, primeKept: false });
    expect(settingsFeatures(s)).toMatchObject({ life: false, intel: false });
  });

  it('starts sessions safely for someone new: claude mode, Claude asks before tools', () => {
    const s = defaultSettings();
    expect(s.launch.mode).toBe('claude');
    expect(s.launch.defaultFlags).toEqual(DEFAULT_LAUNCH_FLAGS);
    expect(DEFAULT_LAUNCH_FLAGS).toEqual({ permission: 'manual', chrome: false, effort: 'default', model: 'default' });
    expect(launchFlagsDangerous(DEFAULT_LAUNCH_FLAGS)).toBe(false);
    // What a version-1 config without its own defaults keeps through the migration.
    expect(V03_LAUNCH_FLAGS).toEqual({ permission: 'skip', chrome: true, effort: 'ultracode', model: 'default' });
    for (const mode of ['claude', 'cs-shell', 'cswap-run'] as const) {
      expect(applySettingsPatch(s, { launch: { mode } }).ok, mode).toBe(true);
    }
    expect(applySettingsPatch(s, { launch: { mode: 'tmux' } }).ok).toBe(false);
  });

  it('checks the zone, the currency code and the kept accounts', () => {
    const s = defaultSettings();
    expect(applySettingsPatch(s, { life: { timezone: 'Asia/Kolkata' } }).ok).toBe(true);
    expect(applySettingsPatch(s, { life: { timezone: null } }).ok).toBe(true);
    expect(applySettingsPatch(s, { life: { timezone: 'Mars/Olympus' } })).toMatchObject({ ok: false, path: 'life.timezone' });
    expect(applySettingsPatch(s, { life: { timezone: '../etc/zone' } })).toMatchObject({ ok: false, path: 'life.timezone' });
    // A zone this Node does not know, already in the file, keeps the rest of the config (Life falls back to the Mac's zone).
    const stored = SettingsSchema.parse({ life: { timezone: 'Mars/Olympus', medicines: true }, notify: { webpush: false } });
    expect(stored.life).toMatchObject({ timezone: 'Mars/Olympus', medicines: true });
    expect(stored.notify.webpush).toBe(false);
    expect(applySettingsPatch(stored, { life: { food: true } })).toMatchObject({ ok: true });
    expect(SettingsSchema.safeParse({ life: { timezone: 'Asia/Kolkata; rm' } }).success).toBe(false);
    expect(applySettingsPatch(s, { life: { currency: 'INR' } }).ok).toBe(true);
    expect(applySettingsPatch(s, { life: { currency: 'inr' } }).ok).toBe(false);
    expect(applySettingsPatch(s, { life: { currency: 'RUPEES' } }).ok).toBe(false);
    expect(applySettingsPatch(s, { accounts: { kept: [3, 5] } }).ok).toBe(true);
    expect(applySettingsPatch(s, { accounts: { kept: [-1] } }).ok).toBe(false);
    expect(applySettingsPatch(s, { accounts: { mode: 'single' } })).toMatchObject({ ok: false, path: 'accounts.mode' });
    expect(applySettingsPatch(s, { intel: { sources: Array(11).fill('/x/a.jsonl') } }).ok).toBe(false);
  });

  it('makes life, intel and accounts Mac-only groups', () => {
    for (const g of ['life', 'intel', 'accounts'] as const) expect(MAC_ONLY_SETTING_GROUPS).toContain(g);
    expect(macOnlyGroupIn({ life: { medicines: true } })).toBe('life');
    expect(macOnlyGroupIn({ notify: { bodies: 'short' }, intel: { enabled: true } })).toBe('intel');
    expect(macOnlyGroupIn({ accounts: { kept: [3] } })).toBe('accounts');
  });

  it('turns `life` on with any one of the six modules, and only then', () => {
    expect(LIFE_MODULES).toEqual(['todos', 'medicines', 'food', 'places', 'finance', 'posts']);
    expect(lifeOn(defaultSettings())).toBe(false);
    for (const m of LIFE_MODULES) {
      const s = SettingsSchema.parse({ life: { [m]: true } });
      expect(lifeOn(s), m).toBe(true);
      expect(settingsFeatures(s).life, m).toBe(true);
    }
    // The zone, currency and lock-screen details alone turn nothing on.
    expect(lifeOn(SettingsSchema.parse({ life: { timezone: 'UTC', currency: 'USD', lockScreenDetails: true } }))).toBe(false);
    expect(settingsFeatures(SettingsSchema.parse({ intel: { enabled: true } })).intel).toBe(true);
  });
});
