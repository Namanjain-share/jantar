/**
 * files and folders on a synthetic HOME, against an in-memory daemon whose
 * settings routes apply patches as the real one does: the Files switch, the
 * roots Files and New session share (spec F10: /, /Users, ~/Library and
 * protected folders are refused as roots over ctl.sock too, and nothing is
 * written), and the home dot exceptions.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roots, rootRefusal as daemonRootRefusal } from '@jantar/daemon/files/roots';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { defaultSettings } from '@jantar/protocol';
import files from '../src/commands/files.js';
import folders from '../src/commands/folders.js';
import { EXIT } from '../src/command.js';
import { denyRulesFor, displayPath, rootIdFrom, rootRefusal } from '../src/lib/roots.js';
import { contextFor, fail, fakeCtl, fakeSettings, ok } from './helpers.js';

let home: FakeHome;

beforeEach(async () => {
  home = await makeFakeHome({ sessions: [] });
  for (const d of ['Desktop/work', 'Other/Desktop', 'Library/Keychains', '.ssh', '.config/nvim', '.config/gh', 'Projects/.git', 'notes']) {
    await mkdir(join(home.home, d), { recursive: true });
  }
  await writeFile(join(home.home, 'Desktop', 'readme.txt'), 'not a folder\n');
});

afterEach(async () => {
  await home.cleanup();
});

/** An in-memory daemon with settings `start`, plus extra routes. */
function daemon(start: Record<string, unknown> = {}, routes: Parameters<typeof fakeCtl>[0] = {}) {
  const s = fakeSettings(start);
  return { s, ctl: fakeCtl({ ...s.routes, ...routes }) };
}

describe('jantar files', () => {
  it('on and off patch files.enabled through the daemon; status shows it and the roots', async () => {
    const { s, ctl } = daemon();
    const on = contextFor(home, { ctl });
    expect(await files.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ files: { enabled: true } }]);
    expect(s.settings.files.enabled).toBe(true);
    expect(on.io.stdout).toContain('Files is on.');
    expect(on.io.stdout).toContain('add more with: jantar files roots add ~/Desktop');
    expect(on.io.stdout).not.toContain('config.json');

    const st = contextFor(home, { ctl });
    expect(await files.run(['status'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toContain('Files: on');
    expect(st.io.stdout).toContain('Roots: none yet. Add one: jantar folders add-root ~/Desktop');

    const off = contextFor(home, { ctl });
    expect(await files.run(['off'], off.ctx)).toBe(EXIT.ok);
    expect(s.settings.files.enabled).toBe(false);
    expect(off.io.stdout).toContain('Files is off.');

    for (const bad of [[], ['maybe'], ['on', 'now'], ['off', '--id', 'x'], ['roots', 'frob']]) {
      const c = contextFor(home, { ctl });
      expect(await files.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.patches).toHaveLength(2);
  });

  it('writes config.json when the daemon is not running', async () => {
    const { ctx, io } = contextFor(home);
    expect(await files.run(['on'], ctx)).toBe(EXIT.ok);
    const config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    expect(config.files).toEqual({ enabled: true });
    expect(io.stdout).toContain('Saved to config.json; the daemon picks it up when it starts.');
  });

  it('files roots add, list and remove are the folders roots', async () => {
    const { s, ctl } = daemon();
    expect(await files.run(['roots', 'add', '~/Desktop/work', '--label', 'Work'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.folders.roots).toEqual([{ id: 'work', label: 'Work', path: join(home.home, 'Desktop', 'work') }]);
    const list = contextFor(home, { ctl });
    expect(await files.run(['roots'], list.ctx)).toBe(EXIT.ok);
    expect(list.io.stdout).toMatch(/ {2}work {2}Work {2}~\/Desktop\/work\n/);
    expect(await files.run(['roots', 'remove', 'r.work'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.folders.roots).toEqual([]);
    const gone = contextFor(home, { ctl });
    expect(await files.run(['roots', 'remove', 'work'], gone.ctx)).toBe(EXIT.failed);
    expect(gone.io.stderr).toContain('there is no root work');
  });
});

describe('jantar folders', () => {
  it('add-root refuses /, /Users, ~/Library, protected, missing and non-folders, over ctl.sock too, writing nothing (F10)', async () => {
    await symlink(join(home.home, 'Library'), join(home.home, 'Desktop', 'lib-link'));
    const { s, ctl } = daemon({ folders: { extraDeny: ['~/notes'] } });
    const refused: Array<[string, string]> = [
      ['/', 'a system folder'],
      ['/Users', 'a system folder'],
      ['/Volumes', 'a system folder'],
      ['~/Library', 'a protected folder'],
      [join(home.home, 'Library', 'Keychains'), 'a protected folder'],
      ['~/.ssh', 'a protected folder'],
      ['~/.config/gh', 'a protected folder'],
      ['~/Projects/.git', 'a protected folder'],
      ['~/notes', 'a protected folder'],
      [home.jantarHome, 'a protected folder'],
      ['~/Desktop/lib-link', `leads to ${join(home.home, 'Library')}, a protected folder`],
      ['~/missing', 'does not exist'],
      ['~/Desktop/readme.txt', 'is not a folder'],
    ];
    for (const [path, why] of refused) {
      const c = contextFor(home, { ctl });
      expect(await folders.run(['add-root', path], c.ctx), path).toBe(EXIT.failed);
      expect(c.io.stderr, path).toContain('not added:');
      expect(c.io.stderr, path).toContain(why);
    }
    expect(s.patches).toEqual([]);

    // with the daemon down, nothing reaches config.json either
    for (const path of ['/', '~/Library']) {
      expect(await folders.run(['add-root', path], contextFor(home).ctx), path).toBe(EXIT.failed);
    }
    expect(existsSync(join(home.jantarHome, 'config.json'))).toBe(false);
  });

  it('add-root takes the id and label from the folder name, refuses a folder twice and a taken or bad id', async () => {
    const { s, ctl } = daemon();
    const a = contextFor(home, { ctl });
    expect(await folders.run(['add-root', '~/Desktop'], a.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ folders: { roots: [{ id: 'desktop', path: join(home.home, 'Desktop'), label: 'Desktop' }] } }]);
    expect(a.io.stdout).toContain('Added root desktop · Desktop · ~/Desktop');
    expect(a.io.stdout).toContain('Files and New session are both off: jantar files on, jantar launch on');

    const again = contextFor(home, { ctl });
    expect(await folders.run(['add-root', join(home.home, 'Desktop', 'work', '..')], again.ctx)).toBe(EXIT.failed);
    expect(again.io.stderr).toContain('~/Desktop is already a root (desktop)');

    expect(await folders.run(['add-root', '~/Other/Desktop'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.folders.roots.map((r) => r.id)).toEqual(['desktop', 'desktop-2']);

    const named = contextFor(home, { ctl });
    expect(await folders.run(['add-root', '~/Desktop/work', '--id', 'work', '--label', 'Work stuff'], named.ctx)).toBe(EXIT.ok);
    expect(s.settings.folders.roots.at(-1)).toEqual({ id: 'work', label: 'Work stuff', path: join(home.home, 'Desktop', 'work') });

    await mkdir(join(home.home, 'Code'));
    for (const [args, why] of [
      [['--id', 'work'], 'a root with id work already exists'],
      [['--id', 'Work!'], '--id must be 1 to 24'],
      [['--label', 'x'.repeat(33)], '--label must be 1 to 32'],
      [['--label', 'tab\there'], '--label must be 1 to 32'],
    ] as const) {
      const c = contextFor(home, { ctl });
      expect(await folders.run(['add-root', '~/Code', ...args], c.ctx), args.join(' ')).toBe(EXIT.failed);
      expect(c.io.stderr).toContain(why);
    }
    expect(s.settings.folders.roots).toHaveLength(3);

    expect(await folders.run(['rm-root', 'desktop-2'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.folders.roots.map((r) => r.id)).toEqual(['desktop', 'work']);
    for (const bad of [['add-root'], ['rm-root'], ['frob'], ['list', 'x'], ['rm-root', 'work', '--label', 'x']]) {
      expect(await folders.run(bad, contextFor(home, { ctl }).ctx), bad.join(' ')).toBe(EXIT.usage);
    }
  });

  it('list marks the roots the daemon would not serve, and shows the session-roots switch and the exceptions', async () => {
    const { ctl } = daemon({
      folders: {
        roots: [
          { id: 'desk', path: '~/Desktop', label: 'Desk' },
          { id: 'gone', path: '~/nope', label: 'Gone' },
          { id: 'lib', path: '~/Library', label: 'Lib' },
        ],
        sessionRoots: false,
        allow: ['~/.config/nvim'],
      },
    });
    const { ctx, io } = contextFor(home, { ctl });
    expect(await folders.run(['list'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain('  desk  Desk  ~/Desktop\n');
    expect(io.stdout).toContain('  gone  Gone  ~/nope  (missing)\n');
    expect(io.stdout).toContain('  lib   Lib   ~/Library  (refused: a protected folder)\n');
    expect(io.stdout).toContain("Live sessions' folders: not roots (folders.sessionRoots is off)");
    expect(io.stdout).toContain('Hidden home folders opened: ~/.config/nvim');
  });

  it("roots prints what the running daemon serves, and the daemon's refusal when launching is off", async () => {
    const served = {
      roots: [
        { id: 'r.desk', kind: 'configured', label: 'Desk', display: '~/Desktop', home: false, path: '/synthetic/home/Desktop' },
        { id: 's.1111', kind: 'session', label: 'demo-app', sid: '1111', display: '~/demo-app', home: false, path: '/synthetic/home/demo-app' },
      ],
    };
    const { ctl } = daemon({}, { 'GET /v1/folders/roots': ok(served) });
    const a = contextFor(home, { ctl });
    expect(await folders.run(['roots'], a.ctx)).toBe(EXIT.ok);
    expect(a.io.stdout).toContain('  r.desk  root     Desk  /synthetic/home/Desktop\n');
    expect(a.io.stdout).toContain('  s.1111  session  demo-app  /synthetic/home/demo-app\n');

    const off = daemon({}, { 'GET /v1/folders/roots': fail('forbidden', 'Starting sessions from the phone is off. Turn it on at your Mac: jantar launch on', 403) });
    const b = contextFor(home, { ctl: off.ctl });
    expect(await folders.run(['roots'], b.ctx)).toBe(EXIT.failed);
    expect(b.io.stderr).toContain('Turn it on at your Mac: jantar launch on');
  });

  it('allow opens a hidden home folder, never one the hard denylist names; rm-allow hides it again', async () => {
    const { s, ctl } = daemon();
    const a = contextFor(home, { ctl });
    expect(await folders.run(['allow', join(home.home, '.config', 'nvim')], a.ctx)).toBe(EXIT.ok);
    expect(s.settings.folders.allow).toEqual(['~/.config/nvim']);
    expect(a.io.stdout).toContain('Allowed ~/.config/nvim');
    const again = contextFor(home, { ctl });
    expect(await folders.run(['allow', '~/.config/nvim'], again.ctx)).toBe(EXIT.ok);
    expect(again.io.stdout).toContain('already allowed');

    for (const [path, why] of [
      ['~/.ssh', 'stays protected'],
      ['~/.claude', 'stays protected'],
      ['~/.config/gh', 'stays protected'],
      ['~/.zsh_history', 'stays protected'],
      ['~/Desktop', 'is not a hidden home folder'],
      ['/etc', 'is not in your home folder'],
    ] as const) {
      const c = contextFor(home, { ctl });
      expect(await folders.run(['allow', path], c.ctx), path).toBe(EXIT.failed);
      expect(c.io.stderr, path).toContain(why);
    }
    expect(s.patches).toHaveLength(1);

    expect(await folders.run(['rm-allow', '~/.config/nvim'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.folders.allow).toEqual([]);
    expect(await folders.run(['rm-allow', '~/.config/nvim'], contextFor(home, { ctl }).ctx)).toBe(EXIT.failed);
  });
});

describe('roots lib', () => {
  it("rootRefusal is the daemon's own check, and says what Roots.refusal says", async () => {
    const paths = { userHome: home.home, home: home.jantarHome };
    const rules = await denyRulesFor(paths, defaultSettings().folders);
    const daemonRoots = new Roots({ ctx: {} as never, rules: () => rules, homes: () => [home.home] });
    const table = [
      '/',
      '/Users',
      '/users',
      '/Volumes',
      '/private',
      '/System',
      '/Library',
      '/Applications',
      '/opt/work',
      '/etc',
      '/var/tmp',
      home.home,
      join(home.home, 'Library'),
      join(home.home, 'Desktop'),
      join(home.home, '.ssh'),
      join(home.home, '.config', 'nvim'),
      home.jantarHome,
    ];
    expect(rootRefusal).toBe(daemonRootRefusal);
    for (const p of table) expect(rootRefusal(p, rules), p).toBe(daemonRoots.refusal(p));
  });

  it('derives root ids and shows paths under $HOME with ~', () => {
    expect(rootIdFrom('Desktop', new Set())).toBe('desktop');
    expect(rootIdFrom('My Work!', new Set())).toBe('my-work');
    expect(rootIdFrom('---', new Set())).toBe('root');
    expect(rootIdFrom('a'.repeat(30), new Set())).toBe('a'.repeat(24));
    expect(rootIdFrom('x', new Set(['x', 'x-2']))).toBe('x-3');
    expect(rootIdFrom('b'.repeat(30), new Set(['b'.repeat(24)]))).toBe(`${'b'.repeat(22)}-2`);
    expect(displayPath('/u/h', '/u/h')).toBe('~');
    expect(displayPath('/u/h/Desktop', '/u/h')).toBe('~/Desktop');
    expect(displayPath('/u/hx', '/u/h')).toBe('/u/hx');
  });
});
