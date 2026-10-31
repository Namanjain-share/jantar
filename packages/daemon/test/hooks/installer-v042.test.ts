/**
 * H5 (spec 4.5): the installer still edits one settings file, a test run can
 * never write under a real Claude or Jantar root, and install and uninstall
 * (dry run and --yes) end with the cswap profile line, which names slots by
 * number only. Temp homes only.
 */
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../src/config.js';
import type { Paths } from '../../src/contracts.js';
import { PICKUP, profileLines, runHooksCommand } from '../../src/hooks/cli.js';
import { guardRealFilesForTests } from '../../src/hooks/installer.js';
import { tempDir } from './helpers.js';

const ORIGINAL = `${JSON.stringify({ cleanupPeriodDays: 3650, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'synthetic-tool hook' }] }] } }, null, 2)}\n`;
const OWN = '{\n  "theme": "light"\n}\n';
const NOW = () => new Date('2026-01-15T10:00:00.000Z');
const node = process.execPath;
const LINE = 'cswap profiles: 2 of 3 share this settings file; slot 7 uses its own file and gets no hooks\n';

let tmp: Awaited<ReturnType<typeof tempDir>>;
let paths: Paths;

function io() {
  const o = {
    stdout: '',
    stderr: '',
    env: {},
    isTTY: false,
    out: (t: string) => {
      o.stdout += t;
    },
    err: (t: string) => {
      o.stderr += t;
    },
  };
  return o;
}

beforeEach(async () => {
  tmp = await tempDir('jantar-inst42-');
  const home = join(tmp.dir, 'home');
  paths = resolvePaths({ env: { HOME: home }, userHome: home, home: join(tmp.dir, 'state') });
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(paths.claudeSettings, ORIGINAL, { mode: 0o600 });
  // Two profiles link the main file; slot 7 keeps one of its own (its name carries account details).
  for (const name of ['2-synthetic-alpha', '3-synthetic-bravo', '7-synthetic-private_example']) {
    await mkdir(join(paths.cswapProfiles, name), { recursive: true });
    if (name.startsWith('7-')) await writeFile(join(paths.cswapProfiles, name, 'settings.json'), OWN);
    else await symlink(paths.claudeSettings, join(paths.cswapProfiles, name, 'settings.json'));
  }
});

afterEach(async () => {
  await tmp.cleanup();
});

/** Nothing but the main file changed: slot 7's file is byte-equal and the links still link. */
async function onlyMainFileWritten(): Promise<void> {
  expect(await readFile(join(paths.cswapProfiles, '7-synthetic-private_example', 'settings.json'), 'utf8')).toBe(OWN);
  expect((await lstat(join(paths.cswapProfiles, '7-synthetic-private_example', 'settings.json'))).isSymbolicLink()).toBe(false);
  for (const name of ['2-synthetic-alpha', '3-synthetic-bravo']) {
    expect((await lstat(join(paths.cswapProfiles, name, 'settings.json'))).isSymbolicLink()).toBe(true);
  }
}

function endsWithProfileLine(out: string, hint: string): void {
  expect(out.endsWith(`${LINE}${hint}\n`), out).toBe(true);
  // Slot numbers only: no profile name, and no path under the profiles dir.
  expect(out).not.toContain('synthetic-private');
  expect(out).not.toContain('synthetic-alpha');
  expect(out).not.toContain(paths.cswapProfiles);
}

const INSTALL_HINT = 'Link it to the main file, or run `jantar hooks install --settings <that file>`.';
const UNINSTALL_HINT = 'This leaves its own file as it is; run `jantar hooks uninstall --settings <that file>` for it.';

describe('a test run never writes a real file (H5)', () => {
  it('the guard throws for each real root and anything under it, and nowhere else', () => {
    const home = userInfo().homedir;
    for (const root of ['.claude', '.claude-swap-backup', '.jantar', '.ccw-v2', join('.config', 'ccw')]) {
      const real = join(home, root);
      expect(() => guardRealFilesForTests(real, 'x'), root).toThrow(/^refusing to write x under the real /);
      expect(() => guardRealFilesForTests(join(real, 'settings.json'), 'x'), root).toThrow(/refusing/);
      expect(() => guardRealFilesForTests(join(real, 'sessions', '1-a', 'settings.json'), 'x'), root).toThrow(/refusing/);
    }
    // A sibling whose name merely starts like a root, and a temp home, are fine.
    expect(() => guardRealFilesForTests(join(home, '.claude-synthetic-sibling', 'settings.json'), 'x')).not.toThrow();
    expect(() => guardRealFilesForTests(paths.claudeSettings, 'x')).not.toThrow();
  });
});

describe('profile line (H5)', () => {
  it('install: the dry run and the apply end with it, and only the main file is written', async () => {
    const dry = io();
    expect(await runHooksCommand(['install', '--dry-run'], { io: dry, paths, node })).toBe(0);
    expect(dry.stdout).toContain('Dry run: nothing was written.');
    endsWithProfileLine(dry.stdout, INSTALL_HINT);
    expect(await readFile(paths.claudeSettings, 'utf8')).toBe(ORIGINAL);

    const yes = io();
    expect(await runHooksCommand(['install', '--yes'], { io: yes, paths, node, now: NOW })).toBe(0);
    expect(yes.stdout).toContain(`Installed jantar hooks for `);
    expect(yes.stdout).toContain(`${PICKUP}\n${LINE}`);
    endsWithProfileLine(yes.stdout, INSTALL_HINT);
    expect(await readFile(paths.claudeSettings, 'utf8')).toContain('jantar-hook');
    await onlyMainFileWritten();

    // Already installed: still ends with it.
    const again = io();
    expect(await runHooksCommand(['install', '--yes'], { io: again, paths, node })).toBe(0);
    expect(again.stdout).toContain('already installed');
    endsWithProfileLine(again.stdout, INSTALL_HINT);
  });

  it('uninstall: the dry run and the apply end with it, and only the main file is written', async () => {
    expect(await runHooksCommand(['install', '--yes'], { io: io(), paths, node, now: NOW })).toBe(0);
    const installed = await readFile(paths.claudeSettings, 'utf8');

    const dry = io();
    expect(await runHooksCommand(['uninstall', '--dry-run'], { io: dry, paths, node })).toBe(0);
    endsWithProfileLine(dry.stdout, UNINSTALL_HINT);
    expect(await readFile(paths.claudeSettings, 'utf8')).toBe(installed);

    const yes = io();
    expect(await runHooksCommand(['uninstall', '--yes'], { io: yes, paths, node, now: NOW })).toBe(0);
    expect(yes.stdout).toContain("Removed Jantar's hook entries");
    endsWithProfileLine(yes.stdout, UNINSTALL_HINT);
    expect(await readFile(paths.claudeSettings, 'utf8')).toBe(ORIGINAL);
    await onlyMainFileWritten();

    const none = io();
    expect(await runHooksCommand(['uninstall', '--yes'], { io: none, paths, node })).toBe(0);
    expect(none.stdout).toContain('nothing to remove');
    endsWithProfileLine(none.stdout, UNINSTALL_HINT);
  });

  it('status prints the same line and the install hint', async () => {
    const st = io();
    expect(await runHooksCommand(['status'], { io: st, paths, node })).toBe(0);
    endsWithProfileLine(st.stdout, INSTALL_HINT);
  });

  it('install without a yes writes nothing and still says which slots get no hooks', async () => {
    const a = io();
    expect(await runHooksCommand(['install'], { io: a, paths, node })).toBe(1);
    expect(a.stderr).toContain('Nothing was written');
    endsWithProfileLine(a.stdout, INSTALL_HINT);
    expect(await readFile(paths.claudeSettings, 'utf8')).toBe(ORIGINAL);
  });

  it("install --settings <a slot's own file> counts that slot as sharing it", async () => {
    const own = join(paths.cswapProfiles, '7-synthetic-private_example', 'settings.json');
    const a = io();
    expect(await runHooksCommand(['install', '--settings', own, '--yes'], { io: a, paths, node, now: NOW })).toBe(0);
    expect(a.stdout).toContain('cswap profiles: 1 of 3 share this settings file; slots 2, 3 use their own files and get no hooks\n');
    expect(a.stdout).not.toContain('slot 7');
    expect(await readFile(own, 'utf8')).toContain('jantar-hook');
    expect(await readFile(paths.claudeSettings, 'utf8')).toBe(ORIGINAL);
  });

  it('a slot whose settings.json links to nothing has no settings file (not one of its own)', async () => {
    await mkdir(join(paths.cswapProfiles, '9-synthetic'), { recursive: true });
    await symlink(join(paths.cswapProfiles, '9-synthetic', 'gone.json'), join(paths.cswapProfiles, '9-synthetic', 'settings.json'));
    const st = io();
    expect(await runHooksCommand(['status'], { io: st, paths, node })).toBe(0);
    expect(st.stdout).toContain('cswap profiles: 2 of 4 share this settings file; slot 7 uses its own file and gets no hooks; slot 9 has no settings file and gets no hooks');
  });

  it('a refused settings file prints no profile line (nothing was read)', async () => {
    await writeFile(paths.claudeSettings, '{ nope');
    const a = io();
    expect(await runHooksCommand(['install', '--yes'], { io: a, paths, node })).toBe(1);
    expect(a.stdout).toBe('');
  });

  it('words every mix of slots, and says nothing without profiles', () => {
    const p = (name: string, settings: 'linked' | 'separate' | 'missing') => ({ name, settings });
    expect(profileLines(undefined, 'install')).toBe('');
    expect(profileLines([], 'uninstall')).toBe('');
    expect(profileLines([p('2-a', 'linked'), p('3-b', 'linked')], 'install')).toBe('cswap profiles: 2 of 2 share this settings file\n');
    expect(profileLines([p('2-a', 'linked'), p('5-e', 'separate'), p('6-f', 'separate'), p('8-h', 'missing')], 'install')).toBe(
      'cswap profiles: 1 of 4 share this settings file; slots 5, 6 use their own files and get no hooks; ' +
        'slot 8 has no settings file and gets no hooks\n' +
        'Link them to the main file, or run `jantar hooks install --settings <that file>` for each.\n',
    );
    expect(profileLines([p('2-a', 'linked'), p('8-h', 'missing'), p('9-i', 'missing')], 'uninstall')).toBe(
      'cswap profiles: 1 of 3 share this settings file; slots 8, 9 have no settings file and get no hooks\n',
    );
    expect(profileLines([p('5-e', 'separate'), p('6-f', 'separate')], 'uninstall')).toBe(
      'cswap profiles: 0 of 2 share this settings file; slots 5, 6 use their own files and get no hooks\n' +
        'This leaves their own files as they are; run `jantar hooks uninstall --settings <that file>` for each.\n',
    );
    // A dir without a leading slot number is still never named.
    expect(profileLines([p('private_example', 'separate')], 'install')).toContain('slot ? uses its own file');
  });

  it('help says when sessions pick the hooks up', async () => {
    const a = io();
    expect(await runHooksCommand(['--help'], { io: a, paths, node })).toBe(0);
    expect(a.stdout).toContain('Sessions pick hooks up on their next start or resume.');
    expect(a.stdout).toContain(PICKUP);
    expect(a.stdout).toContain('keeps going without cards; its dialogs are answered from the\nphone through the screen.');
  });
});
