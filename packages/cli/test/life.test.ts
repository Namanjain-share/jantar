/**
 * jantar life against an in-memory daemon whose settings routes apply
 * patches as the real one does, and with the daemon down (config.json on a
 * synthetic HOME): status, on and off, set (zone, currency, lock-screen
 * details) with their checks, backup, and restore with its question, its
 * --yes, its name check and its list of backups.
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import type { LifeStatus } from '@jantar/protocol';
import life from '../src/commands/life.js';
import { EXIT } from '../src/command.js';
import { contextFor, fail, fakeCtl, fakeSettings, ok, type CtlCall } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };

function status(over: Partial<LifeStatus> = {}): LifeStatus {
  return {
    open: true,
    timezone: 'Asia/Kolkata',
    today: '2026-01-15',
    currency: 'INR',
    lockScreenDetails: false,
    modules: { todos: true, medicines: true, food: false, places: false, finance: false, posts: false },
    estimate: { available: false },
    backups: { last: '2026-01-15T07:00:00.000Z', count: 3 },
    push: { devices: 1, webpush: true },
    ...over,
  };
}

function daemon(start: Record<string, unknown> = {}, st: LifeStatus = status()) {
  const s = fakeSettings(start);
  const restores: CtlCall[] = [];
  const ctl = fakeCtl({
    ...s.routes,
    'GET /v1/life/status': () => ok(st),
    'POST /v1/life/backup': () => ok({ file: 'life-2026-01-15.db', at: '2026-01-15T10:00:00.000Z' }),
    'POST /v1/life/restore': (call) => {
      restores.push(call);
      const file = (call.body as { file: string }).file;
      return file === 'life-2020-01-01.db' ? fail('not_found', 'No such backup in the backups folder.', 404) : ok({ ok: true, kept: 'life.db.before-restore-2026-01-15T10-00-00-000Z' });
    },
  });
  return { s, ctl, restores };
}

describe('jantar life status', () => {
  it('prints the modules, zone, currency, lock screen, medicine pings and backups from the daemon', async () => {
    const { ctl } = daemon();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['status'], c.ctx)).toBe(EXIT.ok);
    const out = c.io.stdout;
    expect(out).toContain('Life data: open');
    expect(out).toContain('Life modules on: todos, medicines; off: food, places, finance');
    expect(out).toContain('Time zone: Asia/Kolkata (today is 2026-01-15)');
    expect(out).toContain('Currency: INR');
    expect(out).toContain('Lock screen details: off (pushes say "Medicine due", "Bill due" and "Post due", no names)');
    expect(out).toContain('Medicine pings: 1 device with notifications on');
    expect(out).toContain('Backups: 3 in /synthetic/state/backups, the newest 3h ago');
    expect(out).not.toContain('Ask Claude');
  });

  it('says when no device gets medicine pings, when Web Push is off, when broken, and what Ask Claude says', async () => {
    const none = daemon({}, status({ push: { devices: 0, webpush: true } }));
    const a = contextFor({ env: ENV }, { ctl: none.ctl });
    await life.run(['status'], a.ctx);
    expect(a.io.stdout).toContain('Medicine pings: no device gets them.');
    const off = daemon({}, status({ push: { devices: 2, webpush: false } }));
    const b = contextFor({ env: ENV }, { ctl: off.ctl });
    await life.run(['status'], b.ctx);
    expect(b.io.stdout).toContain('Medicine pings: none go out, because Web Push is off');
    const broken = daemon({}, status({ open: false, broken: 'Life data could not be opened.', modules: { todos: true, medicines: false, food: true, places: false, finance: false, posts: false }, estimate: { available: false, reason: 'No runner.' }, backups: { last: null, count: 0 } }));
    const c = contextFor({ env: ENV }, { ctl: broken.ctl });
    await life.run(['status'], c.ctx);
    expect(c.io.stdout).toContain('Life data: broken: Life data could not be opened.');
    expect(c.io.stdout).toContain('Ask Claude (calories): not available: No runner.');
    expect(c.io.stdout).toContain('Backups: none yet in /synthetic/state/backups');
  });

  describe('with the daemon down', () => {
    let home: FakeHome;
    beforeEach(async () => {
      home = await makeFakeHome({ sessions: [] });
    });
    afterEach(async () => {
      await home.cleanup();
    });

    it('reads config.json, and on/off write it', async () => {
      const st = contextFor(home);
      expect(await life.run(['status'], st.ctx)).toBe(EXIT.ok);
      expect(st.io.stdout).toContain('jantard is not running');
      expect(st.io.stdout).toContain('Life modules: all off');
      const on = contextFor(home);
      expect(await life.run(['on', 'medicines', 'food'], on.ctx)).toBe(EXIT.ok);
      expect(on.io.stdout).toContain('Saved to config.json');
      const saved = JSON.parse(await readFile(join(home.env.JANTAR_HOME as string, 'config.json'), 'utf8')) as { life: Record<string, unknown> };
      expect(saved.life).toMatchObject({ medicines: true, food: true, todos: false });
    });
  });
});

describe('jantar life on and off', () => {
  it('turns the named modules on or off over the daemon, once each', async () => {
    const { s, ctl } = daemon();
    const on = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['on', 'todos', 'medicines', 'todos'], on.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ life: { todos: true, medicines: true } }]);
    expect(on.io.stdout).toContain('On: todos (projects, todos and reminders), medicines (medicines and their pings).');
    expect(on.io.stdout).toContain('Life modules on: todos, medicines; off: food, places, finance, posts');
    const off = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['off', 'medicines'], off.ctx)).toBe(EXIT.ok);
    expect(s.settings.life.medicines).toBe(false);
  });

  it('all names every module', async () => {
    const { s, ctl } = daemon();
    expect(await life.run(['on', 'all'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.life).toMatchObject({ todos: true, medicines: true, food: true, places: true, finance: true, posts: true });
    expect(await life.run(['off', 'all'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.life).toMatchObject({ todos: false, medicines: false, food: false, places: false, finance: false, posts: false });
  });

  it('v0.7: turns posts on and off by name', async () => {
    const { s, ctl } = daemon();
    const on = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['on', 'posts'], on.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ life: { posts: true } }]);
    expect(on.io.stdout).toContain('On: posts (social posts and their reminders).');
    expect(await life.run(['off', 'posts'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.life.posts).toBe(false);
  });

  it('refuses no module, an unknown one, and all with others', async () => {
    const { s, ctl } = daemon();
    for (const bad of [['on'], ['off'], ['on', 'habits'], ['on', 'all', 'todos'], ['frob'], ['status', 'x'], ['backup', 'x'], ['on', 'todos', '--yes']]) {
      const c = contextFor({ env: ENV }, { ctl });
      expect(await life.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.patches).toEqual([]);
  });
});

describe('jantar life set', () => {
  it('timezone takes a known IANA zone, or none for the Mac', async () => {
    const { s, ctl } = daemon();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['set', 'timezone', 'Asia/Kolkata'], c.ctx)).toBe(EXIT.ok);
    expect(s.settings.life.timezone).toBe('Asia/Kolkata');
    expect(c.io.stdout).toContain('Time zone: Asia/Kolkata. Days and ping times follow it.');
    expect(await life.run(['set', 'timezone', 'none'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.life.timezone).toBeNull();
    const bad = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['set', 'timezone', 'Mars/Olympus_Mons'], bad.ctx)).toBe(EXIT.usage);
    expect(bad.io.stderr).toContain('is not a time zone this Mac knows');
  });

  it('currency takes three letters (upper-cased) or none', async () => {
    const { s, ctl } = daemon();
    expect(await life.run(['set', 'currency', 'inr'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.life.currency).toBe('INR');
    expect(await life.run(['set', 'currency', 'none'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.life.currency).toBeNull();
    for (const bad of ['RUPEE', 'R$', '12']) expect(await life.run(['set', 'currency', bad], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.usage);
  });

  it('lock-screen-details on or off', async () => {
    const { s, ctl } = daemon();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['set', 'lock-screen-details', 'on'], c.ctx)).toBe(EXIT.ok);
    expect(s.settings.life.lockScreenDetails).toBe(true);
    expect(c.io.stdout).toContain('name the medicine, the bill and its amount, and where a post goes');
    const off = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['set', 'lock-screen-details', 'off'], off.ctx)).toBe(EXIT.ok);
    expect(off.io.stdout).toBe('Lock screen details: off. Pushes say "Medicine due", "Bill due" and "Post due", no names.\n');
    expect(await life.run(['set', 'lock-screen-details', 'maybe'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.usage);
  });

  it('refuses a missing value, an extra word and an unknown key (no shorthand keys)', async () => {
    const { s, ctl } = daemon();
    for (const bad of [['set'], ['set', 'timezone'], ['set', 'currency', 'INR', 'x'], ['set', 'colour', 'red'], ['set', 'tz', 'UTC']]) {
      expect(await life.run(bad, contextFor({ env: ENV }, { ctl }).ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.patches).toEqual([]);
  });
});

describe('jantar life backup', () => {
  it('asks the daemon and prints where the backup went', async () => {
    const { ctl } = daemon();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['backup'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toBe('Backed up to /synthetic/state/backups/life-2026-01-15.db\n');
    expect(ctl.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/life/backup' });
  });

  it('with the daemon down, says so (exit 3)', async () => {
    const c = contextFor({ env: ENV }, { ctl: fakeCtl({}, { down: true }) });
    expect(await life.run(['backup'], c.ctx)).toBe(EXIT.daemonDown);
  });
});

describe('jantar life restore', () => {
  it('asks first; "y" restores and names the kept file', async () => {
    const { ctl, restores } = daemon();
    const c = contextFor({ env: ENV }, { ctl, ioOptions: { answers: ['y'] } });
    expect(await life.run(['restore', 'life-2026-01-14.db'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.questions).toEqual(['Put life-2026-01-14.db back as life.db? The current life.db is kept beside it. [y/N] ']);
    expect(restores.map((r) => r.body)).toEqual([{ file: 'life-2026-01-14.db' }]);
    expect(c.io.stdout).toBe('Restored life-2026-01-14.db. The previous life.db is kept as /synthetic/state/life.db.before-restore-2026-01-15T10-00-00-000Z\n');
  });

  it('anything but yes leaves it; no terminal needs --yes; --yes does not ask', async () => {
    const { ctl, restores } = daemon();
    const no = contextFor({ env: ENV }, { ctl, ioOptions: { answers: [''] } });
    expect(await life.run(['restore', 'life-2026-01-14.db'], no.ctx)).toBe(EXIT.ok);
    expect(no.io.stdout).toBe('Not restored.\n');
    const script = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['restore', 'life-2026-01-14.db'], script.ctx)).toBe(EXIT.usage);
    expect(script.io.stderr).toContain('add --yes');
    expect(restores).toEqual([]);
    const yes = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['restore', 'life-2026-01-14.db', '--yes'], yes.ctx)).toBe(EXIT.ok);
    expect(restores).toHaveLength(1);
  });

  it('refuses a name that is not a backup before asking; the daemon refuses an unknown one', async () => {
    const { ctl, restores } = daemon();
    for (const bad of ['../life.db', 'backups/life-2026-01-14.db', 'life.db', 'notes.txt']) {
      const c = contextFor({ env: ENV }, { ctl, ioOptions: { answers: ['y'] } });
      expect(await life.run(['restore', bad], c.ctx), bad).toBe(EXIT.usage);
      expect(c.io.questions).toEqual([]);
    }
    expect(restores).toEqual([]);
    const missing = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['restore', 'life-2020-01-01.db', '-y'], missing.ctx)).toBe(EXIT.failed);
    expect(missing.io.stderr).toContain('No such backup in the backups folder.');
  });

  describe('with no file', () => {
    let home: FakeHome;
    beforeEach(async () => {
      home = await makeFakeHome({ sessions: [] });
    });
    afterEach(async () => {
      await home.cleanup();
    });

    it('lists the backups on this Mac, newest first', async () => {
      const dir = join(home.env.JANTAR_HOME as string, 'backups');
      mkdirSync(dir, { recursive: true });
      for (const [name, t] of [['life-2026-01-13.db', 1_000], ['life-2026-01-14.db', 2_000], ['notes.txt', 3_000]] as const) {
        writeFileSync(join(dir, name), 'x');
        utimesSync(join(dir, name), t, t);
      }
      const c = contextFor(home);
      expect(await life.run(['restore'], c.ctx)).toBe(EXIT.usage);
      expect(c.io.stderr).toContain(`Backups in ${dir}, newest first:\n  life-2026-01-14.db\n  life-2026-01-13.db\n`);
      expect(c.io.stderr).not.toContain('notes.txt');
      const empty = contextFor({ env: ENV });
      expect(await life.run(['restore'], empty.ctx)).toBe(EXIT.usage);
      expect(empty.io.stderr).toContain('No backups in /synthetic/state/backups.');
    });
  });
});

it('--help shows every action', async () => {
  const c = contextFor({ env: ENV });
  expect(await life.run(['--help'], c.ctx)).toBe(EXIT.ok);
  for (const word of ['life status', 'life on <module...>', 'life set timezone', 'life set currency', 'life set lock-screen-details', 'life backup', 'life restore <file> [--yes]']) {
    expect(c.io.stdout).toContain(word);
  }
  expect(life.stub).toBeUndefined();
});
