/**
 * LM1: the settings file migration (config.ts migrateSettingsFile), version
 * 1 to 2. The version-1 file is copied byte for byte to config.json.v1
 * before anything changes; the result has version 2 and v0.3's launch
 * values only where the file had none; a second run changes nothing; an
 * existing config.json.v1 is never overwritten; while a daemon answers on
 * ctl.sock nothing is touched and the call says why.
 */
import { createServer, type Server } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V03_LAUNCH_FLAGS } from '@jantar/protocol';
import { anotherDaemonReason, loadSettings, migrateSettingsFile, resolvePaths } from '../../src/config.js';
import type { Paths } from '../../src/contracts.js';

let dir: string;
let paths: Paths;
const noDaemon = { daemonAnswers: async () => false };

beforeEach(async () => {
  // Short: a Unix socket path must stay under 104 bytes.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mig-')));
  paths = resolvePaths({ env: {}, userHome: dir, home: join(dir, 's') });
  await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A config v0.3 wrote: every key, version 1, the user's own launch picks. */
const V03_WRITTEN = {
  version: 1,
  launch: { enabled: true, mode: 'cs-shell', csCommand: 'cs', defaultFlags: { permission: 'acceptEdits', chrome: false, effort: 'high', model: 'opus' } },
  notify: { bodies: 'short' },
  autoswitch: { hold: [4] },
};

function write(json: unknown): string {
  const text = `${JSON.stringify(json, null, 2)}\n`;
  writeFileSync(paths.configFile, text, { mode: 0o600 });
  return text;
}
const read = () => JSON.parse(readFileSync(paths.configFile, 'utf8')) as Record<string, unknown> & { launch: Record<string, unknown> };

describe('migrateSettingsFile', () => {
  it('copies the version-1 file byte for byte first, then writes version 2 keeping every value', async () => {
    const original = write(V03_WRITTEN);
    expect(await migrateSettingsFile(paths, noDaemon)).toEqual({ ok: true, migrated: true });
    expect(readFileSync(`${paths.configFile}.v1`, 'utf8')).toBe(original);
    expect(statSync(`${paths.configFile}.v1`).mode & 0o777).toBe(0o600);
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    const now = read();
    expect(now.version).toBe(2);
    // Values the file had stay; nothing about accounts is invented.
    expect(now.launch).toEqual(V03_WRITTEN.launch);
    expect(now.notify).toEqual({ bodies: 'short' });
    expect(now.autoswitch).toEqual({ hold: [4] });
    expect(now.accounts).toBeUndefined();
    const loaded = await loadSettings(paths);
    expect(loaded.error).toBeUndefined();
    expect(loaded.settings.accounts.kept).toEqual([]);
    expect(loaded.settings.launch.mode).toBe('cs-shell');
  });

  it("writes v0.3's launch defaults and cs-shell only where a hand-written file had none", async () => {
    write({ version: 1, notify: { bodies: 'generic' } });
    await migrateSettingsFile(paths, noDaemon);
    expect(read().launch).toEqual({ defaultFlags: { ...V03_LAUNCH_FLAGS }, mode: 'cs-shell' });
    write({ launch: { mode: 'cswap-run' } }); // no version at all reads as 1
    rmSync(`${paths.configFile}.v1`);
    await migrateSettingsFile(paths, noDaemon);
    expect(read()).toMatchObject({ version: 2, launch: { mode: 'cswap-run', defaultFlags: { ...V03_LAUNCH_FLAGS } } });
  });

  it('is idempotent: a second run changes nothing, and an existing config.json.v1 is never overwritten', async () => {
    const original = write(V03_WRITTEN);
    await migrateSettingsFile(paths, noDaemon);
    const after = readFileSync(paths.configFile, 'utf8');
    expect(await migrateSettingsFile(paths, noDaemon)).toEqual({ ok: true, migrated: false });
    expect(readFileSync(paths.configFile, 'utf8')).toBe(after);
    // A second version-1 file later (a rollback, then v0.4 again): the first backup stays.
    write({ ...V03_WRITTEN, notify: { bodies: 'full' } });
    await migrateSettingsFile(paths, noDaemon);
    expect(readFileSync(`${paths.configFile}.v1`, 'utf8')).toBe(original);
  });

  it('leaves a missing, unreadable or non-object file alone', async () => {
    expect(await migrateSettingsFile(paths, noDaemon)).toEqual({ ok: true, migrated: false });
    writeFileSync(paths.configFile, '{not json');
    expect(await migrateSettingsFile(paths, noDaemon)).toEqual({ ok: true, migrated: false });
    writeFileSync(paths.configFile, '[1, 2]');
    expect(await migrateSettingsFile(paths, noDaemon)).toEqual({ ok: true, migrated: false });
    expect(existsSync(`${paths.configFile}.v1`)).toBe(false);
  });

  describe('while a daemon answers on ctl.sock', () => {
    let server: Server;
    afterEach(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('touches neither the file nor its folder, and says why', async () => {
      server = createServer((c) => c.end());
      await new Promise<void>((r) => server.listen(paths.ctlSock, r));
      const original = write(V03_WRITTEN);
      const listing = readdirSync(paths.home).sort();
      const r = await migrateSettingsFile(paths);
      expect(r).toEqual({ ok: false, reason: anotherDaemonReason(paths.home) });
      expect(anotherDaemonReason(paths.home)).toBe(`Another Jantar daemon is using ${paths.home}. Stop it first, or point JANTAR_HOME at a test folder.`);
      expect(readFileSync(paths.configFile, 'utf8')).toBe(original);
      expect(readdirSync(paths.home).sort()).toEqual(listing);
    });
  });

  it('a stale socket file (nothing listening) is no daemon', async () => {
    writeFileSync(paths.ctlSock, '');
    write(V03_WRITTEN);
    expect(await migrateSettingsFile(paths)).toEqual({ ok: true, migrated: true });
  });
});

describe('loadSettings', () => {
  it('reads a version-1 file not migrated yet as it will read after the migration (nothing written)', async () => {
    const original = write({ version: 1, notify: { bodies: 'generic' } });
    const loaded = await loadSettings(paths);
    expect(loaded.error).toBeUndefined();
    expect(loaded.settings.version).toBe(2);
    expect(loaded.settings.launch.mode).toBe('cs-shell');
    expect(loaded.settings.launch.defaultFlags).toEqual(V03_LAUNCH_FLAGS);
    expect(readFileSync(paths.configFile, 'utf8')).toBe(original);
  });

  it('a fresh config is version 2 with the safe defaults', async () => {
    const loaded = await loadSettings(paths);
    expect(loaded.exists).toBe(false);
    expect(loaded.settings).toMatchObject({ version: 2, launch: { mode: 'claude', defaultFlags: { permission: 'manual' } } });
  });
});
