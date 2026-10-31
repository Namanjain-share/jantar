/**
 * jantar import-ccw-v2 on a synthetic HOME: a ccw-v2 state dir built with
 * the daemon's own openers (a paired device, a push subscription, Life, a
 * version-1 config, push keys, a capture) is copied into the empty
 * JANTAR_HOME. The phone's key still authenticates against the copy, and
 * nothing in the old dir is moved, rewritten or deleted. Refusals: a target
 * that is not empty, a ccw-v2 daemon still answering, the old dir being the
 * new one. A database another connection holds open comes over with what is
 * still in its WAL. --dry-run writes nothing. Every value is made up.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, resolvePaths } from '@jantar/daemon';
import { DeviceAuth } from '@jantar/daemon/auth/devices';
import { openSqliteFile } from '@jantar/daemon/db/sqlite';
import { openLifeDb } from '@jantar/daemon/life/db';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { SETTINGS_VERSION, SettingsSchema, defaultSettings } from '@jantar/protocol';
import { EXIT, main, memoryIo } from '../src/index.js';
import { planImport } from '../src/lib/import-ccw-v2.js';
import { contextFor, testDeps } from './helpers.js';

const VAPID = `${JSON.stringify({ publicKey: 'synthetic-public', privateKey: 'synthetic-private', subject: 'mailto:someone@example.com', createdAt: '2026-01-15T10:00:00.000Z' })}\n`;
const CAPTURE = `${JSON.stringify({ id: 'cap-1', title: 'Synthetic capture', type: 'tool', captured_at: '2026-01-15T10:00:00.000Z' })}\n`;

/** Every file under `dir` with its bytes (base64), relative to `dir`. */
async function files(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.set(relative(dir, p), (await readFile(p)).toString('base64'));
    }
  };
  await walk(dir);
  return out;
}

describe('jantar import-ccw-v2', () => {
  let home: FakeHome;
  let old: string;
  let v1Config: string;
  let phoneKey: string;

  /** A ccw-v2 v0.4 state dir, as its daemon leaves it when stopped. */
  async function makeOldState(): Promise<void> {
    old = join(home.home, '.ccw-v2');
    await mkdir(join(old, 'push'), { recursive: true, mode: 0o700 });
    const clock = new FakeClock();
    const db = openSqliteFile(join(old, 'ccw-v2.db'));
    const issued = new DeviceAuth({ db, clock }).issue({ name: 'Synthetic phone', scopes: ['read', 'control'] });
    phoneKey = issued.key;
    db.pushSubs.upsert({
      subscription: { endpoint: 'https://push.example.com/send/synthetic', keys: { p256dh: 'synthetic-p256dh', auth: 'synthetic-auth' } },
      deviceId: issued.device.id,
      createdAt: clock.iso(),
    });
    db.close();
    const life = openLifeDb(join(old, 'life.db'));
    if (!life.ok) throw new Error(life.reason);
    life.db.setMeta('kcal_target', '1800');
    life.db.close();
    const v1: Record<string, unknown> = { ...defaultSettings(), version: 1 };
    delete (v1.launch as Record<string, unknown>).defaultFlags;
    v1Config = `${JSON.stringify(v1, null, 2)}\n`;
    await writeFile(join(old, 'config.json'), v1Config, { mode: 0o600 });
    await writeFile(join(old, 'push', 'vapid.json'), VAPID, { mode: 0o600 });
    await mkdir(join(old, 'intel'), { recursive: true });
    await writeFile(join(old, 'intel', 'captures.jsonl'), CAPTURE, { mode: 0o600 });
    // Never copied: logs, the old hook client, the run dir.
    for (const d of ['logs', 'bin', 'run']) await mkdir(join(old, d), { recursive: true });
    await writeFile(join(old, 'logs', 'daemon.err.log'), 'synthetic log line\n');
    await writeFile(join(old, 'bin', 'ccw-v2-hook'), '// synthetic old hook client\n');
    // Not ccw-v2's own, and not copied either: named in the report.
    await writeFile(join(old, 'cloudflared.yml'), '# synthetic tunnel config\n');
    await writeFile(join(old, 'config.json.pre-v03.bak'), '{}\n');
  }

  async function run(args: string[], env: Record<string, string> = home.env) {
    const io = memoryIo(env);
    const { ctx } = contextFor({ env }, { io, deps: testDeps() });
    const code = await main(['import-ccw-v2', ...args], { io, context: ctx });
    return { code, io };
  }

  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
    await makeOldState();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('copies the databases, settings, push keys and captures into the empty state dir, and the phone stays paired', async () => {
    const before = await files(old);
    const { code, io } = await run([]);
    expect(io.stderr).toBe('');
    expect(code).toBe(EXIT.ok);
    expect(io.stdout).toContain(`Copied ccw-v2's state from ${old} into ${home.jantarHome}:`);
    expect(io.stdout).toMatch(/jantar\.db\s+paired devices, push subscriptions, audit log \(from ccw-v2\.db\)/);
    expect(io.stdout).toContain('config.json');
    expect(io.stdout).toContain('moved to version 2 (as it was: config.json.v1)');
    expect(io.stdout).toContain(`Nothing in ${old} was moved or deleted, and no data there was changed.`);
    expect(io.stdout).toContain('jantar accounts keep <n...>');
    // What else is in the old dir is named, and stays: logs, the old hook client and run/ are ccw-v2's own.
    expect(io.stdout).toContain(`Left in ${old}, not copied`);
    expect(io.stdout).toContain('  cloudflared.yml\n');
    expect(io.stdout).toContain('  config.json.pre-v03.bak\n');
    expect(io.stdout).not.toMatch(/^ {2}(logs|bin|run)$/m);
    expect(io.stdout).toContain('jantar install');

    const to = home.jantarHome;
    expect([...(await files(to)).keys()].sort()).toEqual(
      ['config.json', 'config.json.v1', 'intel/captures.jsonl', 'jantar.db', 'life.db', 'push/vapid.json'].sort(),
    );
    for (const f of ['jantar.db', 'life.db', 'config.json', 'config.json.v1', 'push/vapid.json', 'intel/captures.jsonl']) {
      expect((await stat(join(to, f))).mode & 0o777, f).toBe(0o600);
    }
    expect((await stat(to)).mode & 0o777).toBe(0o700);

    // The phone's key authenticates against the copy; its push subscription came along.
    const db = openSqliteFile(join(to, 'jantar.db'));
    try {
      const auth = new DeviceAuth({ db, clock: new FakeClock() }).authenticate(phoneKey);
      expect(auth).toMatchObject({ ok: true, device: { name: 'Synthetic phone' } });
      expect(db.pushSubs.list().map((p) => p.subscription.endpoint)).toEqual(['https://push.example.com/send/synthetic']);
    } finally {
      db.close();
    }
    const life = openLifeDb(join(to, 'life.db'));
    if (!life.ok) throw new Error(life.reason);
    expect(life.db.meta('kcal_target')).toBe('1800');
    life.db.close();

    // Settings moved to version 2 the way v0.4 moves its own; the old file kept beside.
    expect(await readFile(join(to, 'config.json.v1'), 'utf8')).toBe(v1Config);
    const migrated = SettingsSchema.parse(JSON.parse(await readFile(join(to, 'config.json'), 'utf8')));
    expect(migrated.version).toBe(SETTINGS_VERSION);
    expect(await readFile(join(to, 'push', 'vapid.json'), 'utf8')).toBe(VAPID);
    expect(await readFile(join(to, 'intel', 'captures.jsonl'), 'utf8')).toBe(CAPTURE);

    // The old dir: every file still there, byte for byte, and nothing new (the -wal / -shm a read makes go again).
    expect(await files(old)).toEqual(before);
    // No staging folder left beside the target.
    expect((await readdir(home.root)).filter((n) => n.includes('.import-'))).toEqual([]);
  });

  it('copies what is still only in the WAL of a database another connection holds open (VACUUM INTO, not a file copy)', async () => {
    const writer = openSqliteFile(join(old, 'ccw-v2.db'));
    try {
      writer.raw.exec('PRAGMA wal_autocheckpoint = 0');
      const late = new DeviceAuth({ db: writer, clock: new FakeClock() }).issue({ name: 'Synthetic tablet', scopes: ['read'] });
      const mainFile = await readFile(join(old, 'ccw-v2.db'));
      const { code } = await run([]);
      expect(code).toBe(EXIT.ok);
      expect(await readFile(join(old, 'ccw-v2.db'))).toEqual(mainFile); // the source file was not written
      const copy = openSqliteFile(join(home.jantarHome, 'jantar.db'));
      try {
        expect(new DeviceAuth({ db: copy, clock: new FakeClock() }).authenticate(late.key)).toMatchObject({ ok: true, device: { name: 'Synthetic tablet' } });
      } finally {
        copy.close();
      }
    } finally {
      writer.close();
    }
  });

  it('a target that does not exist yet is created', async () => {
    await rm(home.jantarHome, { recursive: true });
    const { code } = await run([]);
    expect(code).toBe(EXIT.ok);
    expect((await readdir(home.jantarHome)).sort()).toEqual(['config.json', 'config.json.v1', 'intel', 'jantar.db', 'life.db', 'push']);
  });

  it('--from takes another dir (~ included), and only what is there is copied', async () => {
    const elsewhere = join(home.home, 'old-state');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, 'config.json'), `${JSON.stringify(defaultSettings(), null, 2)}\n`, { mode: 0o600 });
    const { code, io } = await run(['--from', '~/old-state']);
    expect(code).toBe(EXIT.ok);
    expect(io.stdout).toContain(`from ${elsewhere} into`);
    expect(io.stdout).toContain('already version 2');
    expect(await readdir(home.jantarHome)).toEqual(['config.json']);
  });

  it('refuses a target that is not empty, and changes nothing', async () => {
    await writeFile(join(home.jantarHome, 'config.json'), '{}\n');
    const before = await files(old);
    const { code, io } = await run([]);
    expect(code).toBe(EXIT.failed);
    expect(io.stderr).toContain(`jantar import-ccw-v2: ${home.jantarHome} is not empty.`);
    expect(await readdir(home.jantarHome)).toEqual(['config.json']);
    expect(await files(old)).toEqual(before);
  });

  it('refuses while a ccw-v2 daemon answers on the old ctl.sock', async () => {
    const server: Server = createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(join(old, 'run', 'ctl.sock'), r));
    try {
      const { code, io } = await run([]);
      expect(code).toBe(EXIT.failed);
      expect(io.stderr).toContain(`A ccw-v2 daemon is running for ${old}. Stop it first (ccw-v2 uninstall`);
      expect(await readdir(home.jantarHome)).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('--dry-run lists what it would copy and why a real run would refuse, and writes nothing anywhere', async () => {
    await writeFile(join(home.jantarHome, 'notes.txt'), 'synthetic\n');
    const before = await files(old);
    const plan = await planImport(resolvePaths({ env: home.env }), old, { daemonAnswers: async () => true });
    expect(plan.refusals).toHaveLength(2);
    const { code, io } = await run(['--dry-run']);
    expect(code).toBe(EXIT.ok);
    expect(io.stdout).toContain(`Would copy ccw-v2's state from ${old} into ${home.jantarHome}:`);
    expect(io.stdout).toContain('life.db');
    expect(io.stdout).toContain(`A real run would refuse: ${home.jantarHome} is not empty.`);
    expect(io.stdout).toContain('(dry run: nothing was written)');
    expect(await readdir(home.jantarHome)).toEqual(['notes.txt']);
    expect(await files(old)).toEqual(before); // not even a -wal: no database was opened
  });

  it("refuses while ccw-v2's LaunchAgent is still installed (launchd would start the old daemon at login); --dry-run says so", async () => {
    const agents = join(home.home, 'Library', 'LaunchAgents');
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'dev.ccw-v2.daemon.plist'), '<plist/>\n');
    const said = `ccw-v2's LaunchAgent is still installed (${join(agents, 'dev.ccw-v2.daemon.plist')}): launchd would start the old daemon again at login. Run ccw-v2 uninstall first (it keeps ${old}).`;
    const dry = await run(['--dry-run']);
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.io.stdout).toContain(`A real run would refuse: ${said}`);
    const before = await files(old);
    const { code, io } = await run([]);
    expect(code).toBe(EXIT.failed);
    expect(io.stderr).toContain(said);
    expect(await readdir(home.jantarHome)).toEqual([]);
    expect(await files(old)).toEqual(before);
  });

  it('a file that cannot be copied stops the import and leaves the target as it was', async () => {
    await writeFile(join(old, 'life.db'), 'not a database, only synthetic text\n'.repeat(200));
    const { code, io } = await run([]);
    expect(code).toBe(EXIT.failed);
    expect(io.stderr).toMatch(/^jantar import-ccw-v2: /);
    expect(await readdir(home.jantarHome)).toEqual([]);
    expect((await readdir(home.root)).filter((n) => n.includes('.import-'))).toEqual([]);
  });

  it('refuses a source that is missing or not a ccw-v2 state dir', async () => {
    let r = await run(['--from', join(home.home, 'nowhere')]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.io.stderr).toContain(`there is no ${join(home.home, 'nowhere')} to import from`);
    await mkdir(join(home.home, 'empty'));
    r = await run(['--from', join(home.home, 'empty')]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.io.stderr).toContain('is not a ccw-v2 state dir (it has no ccw-v2.db or config.json)');
  });

  it('with only the old CCW_V2_HOME naming the old dir, it is already the state dir: refused, with the deprecation line', async () => {
    const env = { ...home.env, CCW_V2_HOME: old } as Record<string, string>;
    delete env.JANTAR_HOME;
    const { code, io } = await run([], env);
    expect(code).toBe(EXIT.failed);
    expect(io.stderr).toContain('jantar: CCW_V2_HOME is deprecated: set JANTAR_HOME instead');
    expect(io.stderr).toContain(`${old} is already Jantar's state dir. Set JANTAR_HOME to a new folder to import into.`);
  });

  it('with only CCW_V2_HOME naming the old dir, every other command refuses and leaves it byte for byte as it was', async () => {
    const env = { ...home.env, CCW_V2_HOME: old } as Record<string, string>;
    delete env.JANTAR_HOME;
    const before = await files(old);
    for (const argv of [['life', 'on', 'todos'], ['files', 'on'], ['init', '--yes'], ['install']]) {
      const io = memoryIo(env);
      const { ctx } = contextFor({ env }, { io, deps: testDeps() });
      expect(await main(argv, { io, context: ctx }), argv.join(' ')).toBe(EXIT.usage);
      expect(io.stderr).toContain(`jantar: ${old} is a ccw-v2 state dir. Set JANTAR_HOME to a new folder and run: jantar import-ccw-v2 --from ${old}`);
    }
    const io = memoryIo(env);
    const { ctx } = contextFor({ env }, { io, deps: testDeps() });
    expect(await main(['version'], { io, context: ctx })).toBe(EXIT.ok);
    expect(await files(old)).toEqual(before);
    expect(await stat(join(old, 'jantar.db')).catch(() => null)).toBeNull();
  });
});
