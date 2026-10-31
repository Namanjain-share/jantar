/**
 * `jantar hooks` through the CLI wrapper and the real installer, on a
 * synthetic HOME whose cswap profiles all link the main settings file but
 * one (v0.4.2 spec 4.5, H5): install and uninstall, as the dry run the
 * wrapper defaults to and with --yes, end with the profile line that names
 * that slot by number, and write only the main file.
 */
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import hooks, { loadHooksCli } from '../src/commands/hooks.js';
import { EXIT } from '../src/command.js';
import { contextFor } from './helpers.js';

const OWN_PROFILE = '9-synthetic-own_example';
const OWN = '{\n  "theme": "light"\n}\n';
const LINE = 'cswap profiles: 3 of 4 share this settings file; slot 9 uses its own file and gets no hooks\n';
const INSTALL_HINT = 'Link it to the main file, or run `jantar hooks install --settings <that file>`.\n';
const UNINSTALL_HINT = 'This leaves its own file as it is; run `jantar hooks uninstall --settings <that file>` for it.\n';

describe('profile line', async () => {
  const real = await loadHooksCli();
  let home: FakeHome;
  let own: string;
  beforeEach(async () => {
    // The fake home links profiles 2-4 to ~/.claude/settings.json, as cswap does; slot 9 keeps its own.
    home = await makeFakeHome({ sessions: [] });
    own = join(home.paths.cswapProfiles, OWN_PROFILE, 'settings.json');
    await mkdir(join(home.paths.cswapProfiles, OWN_PROFILE), { recursive: true });
    await writeFile(own, OWN);
  });
  afterEach(async () => {
    await home.cleanup();
  });

  function endsWith(out: string, hint: string): void {
    expect(out.endsWith(`${LINE}${hint}`), out).toBe(true);
    // Slot numbers only: never a profile name or its path.
    expect(out).not.toContain('synthetic-own');
    expect(out).not.toContain(home.paths.cswapProfiles);
  }

  async function profilesUntouched(): Promise<void> {
    expect(await readFile(own, 'utf8')).toBe(OWN);
    for (const a of home.accounts.filter((x) => x.profile)) {
      expect((await lstat(join(home.paths.cswapProfiles, a.profile as string, 'settings.json'))).isSymbolicLink()).toBe(true);
    }
  }

  it.skipIf(!real.ok)('install: the default dry run and --yes both end with it; only the main file is written', async () => {
    const before = await readFile(home.paths.claudeSettings, 'utf8');
    const dry = contextFor(home);
    expect(await hooks.run(['install'], dry.ctx)).toBe(EXIT.ok);
    expect(dry.io.stdout).toContain('Dry run: nothing was written.');
    endsWith(dry.io.stdout, INSTALL_HINT);
    expect(await readFile(home.paths.claudeSettings, 'utf8')).toBe(before);

    const yes = contextFor(home);
    expect(await hooks.run(['install', '--yes'], yes.ctx)).toBe(EXIT.ok);
    expect(yes.io.stdout).toContain('Sessions pick hooks up on their next start or resume.');
    endsWith(yes.io.stdout, INSTALL_HINT);
    expect(await readFile(home.paths.claudeSettings, 'utf8')).toContain('jantar-hook');
    await profilesUntouched();
  });

  it.skipIf(!real.ok)('uninstall: the default dry run and --yes both end with it; only the main file is written', async () => {
    const before = await readFile(home.paths.claudeSettings, 'utf8');
    expect(await hooks.run(['install', '--yes'], contextFor(home).ctx)).toBe(EXIT.ok);

    const dry = contextFor(home);
    expect(await hooks.run(['uninstall'], dry.ctx)).toBe(EXIT.ok);
    expect(dry.io.stdout).toContain('Dry run: nothing was written.');
    endsWith(dry.io.stdout, UNINSTALL_HINT);

    const yes = contextFor(home);
    expect(await hooks.run(['uninstall', '--yes'], yes.ctx)).toBe(EXIT.ok);
    endsWith(yes.io.stdout, UNINSTALL_HINT);
    expect(JSON.parse(await readFile(home.paths.claudeSettings, 'utf8'))).toEqual(JSON.parse(before));
    await profilesUntouched();
  });

  it.skipIf(!real.ok)('status prints it too', async () => {
    const st = contextFor(home);
    expect(await hooks.run(['status'], st.ctx)).toBe(EXIT.ok);
    endsWith(st.io.stdout, INSTALL_HINT);
  });

  it('help says when sessions pick the hooks up, and what the line means', async () => {
    const help = contextFor(home);
    expect(await hooks.run(['--help'], help.ctx)).toBe(EXIT.ok);
    expect(help.io.stdout).toContain('Sessions pick hooks up on their next');
    expect(help.io.stdout).toContain('cswap profile line');
  });
});
