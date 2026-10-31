/**
 * MA6: v0.5 adds an actor kind, `extension`. Every check that lets an actor
 * act names the kinds it allows, so the new kind is refused wherever it is
 * not named: the launcher (start and answer), the folder creator, Files'
 * roots (no absolute paths), the controls' screenshot select and the hooks
 * bridge. The audit names it `extension:<id>`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsSchema, V03_LAUNCH_FLAGS } from '@jantar/protocol';
import type { Actor } from '../../src/contracts.js';
import { actorId } from '../../src/core/actor.js';
import { NO_LAUNCH_SCOPE, mayLaunch } from '../../src/launcher/service.js';
import { seesAbsolutePaths } from '../../src/launcher/folders.js';
import { SID, drive, makeRig as controlsRig, pngShot } from '../controls/helpers.js';
import { fpEnv, type FpEnv } from '../files/fp-helpers.js';
import { harness, type Harness } from '../hooks/helpers.js';
import { makeRig as launcherRig, type Rig as LauncherRig } from '../launcher/helpers.js';

const EXT: Actor = { kind: 'extension', extensionId: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' };
const SYSTEM: Actor = { kind: 'system' };
const CLI: Actor = { kind: 'cli' };
const LAUNCHER: Actor = { kind: 'device', deviceId: 'dev-launch', scopes: ['read', 'control', 'launch'] };

let launcher: LauncherRig | undefined;
let files: FpEnv | undefined;
let hooks: Harness | undefined;
afterEach(async () => {
  await launcher?.close();
  launcher = undefined;
  files?.cleanup();
  files = undefined;
  await hooks?.close();
  hooks = undefined;
});

describe('MA6: an extension actor is refused wherever it is not named', () => {
  it('is named extension:<id> in the audit', () => {
    expect(actorId(EXT)).toBe('extension:01JFZ8X8Y3T0V5G9WQK2M4N6PR');
  });

  it('the launcher: no start and no answer, as the system; the CLI and a device with launch may', async () => {
    expect([EXT, SYSTEM, CLI, LAUNCHER].map(mayLaunch)).toEqual([false, false, true, true]);
    launcher = await launcherRig();
    const body = { root: 'r.work', path: 'alpha-app', account: 'auto' as const, flags: { ...V03_LAUNCH_FLAGS } };
    expect(await launcher.launcher.launch(body, EXT, 'k-ext')).toEqual({ ok: false, code: 'forbidden', reason: NO_LAUNCH_SCOPE });
    expect(await launcher.launcher.answer('01JFZ8X8Y3T0V5G9WQK2M4N6PS', { option: 1, title: 'Do you trust the files in this folder?' }, EXT)).toEqual({
      ok: false,
      code: 'forbidden',
      reason: NO_LAUNCH_SCOPE,
    });
    expect(launcher.terminal.calls ?? []).toEqual([]);
  });

  it('the folder creator: no new folder', async () => {
    launcher = await launcherRig();
    const r = await launcher.launcher.folders.create({ root: 'r.work', parent: '', name: 'from-the-extension' }, EXT);
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    const ok = await launcher.launcher.folders.create({ root: 'r.work', parent: '', name: 'from-the-mac' }, CLI);
    expect(ok.ok).toBe(true);
  });

  it("Files' roots: no absolute paths (only the CLI and an admin device see them)", async () => {
    files = fpEnv();
    const roots = await files.files.roots(EXT);
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) expect(r.path).toBeUndefined();
    expect(seesAbsolutePaths(EXT)).toBe(false);
    expect((await files.files.roots(CLI)).every((r) => typeof r.path === 'string')).toBe(true);
  });

  it("the controls' screenshot select is refused, and nothing is captured", async () => {
    const rig = controlsRig({ settings: SettingsSchema.parse({ screenshots: { enabled: true, allowSelect: true } }) });
    rig.terminal.shot = async () => ({ ok: true, ...pngShot() });
    expect(await rig.controls.screenshot(SID, { select: true }, EXT)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rig.controls.screenshot(SID, { select: true }, SYSTEM)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rig.terminal.shotCalls).toEqual([]);
    expect(await drive(rig.clock, rig.controls.screenshot(SID, { select: true }, CLI))).toMatchObject({ ok: true });
  });

  it('the hooks bridge: no card is answered', async () => {
    hooks = await harness();
    const r = await hooks.bridge.decide('01JFZ8X8Y3T0V5G9WQK2M4N6PR', { behavior: 'allow' }, EXT);
    expect(r).toEqual({ ok: false, code: 'forbidden', message: 'only a paired device with the control scope can answer a card' });
  });
});
