/**
 * The Life service (life/service.ts) on a temp state dir:
 *
 * - opens life.db only when a module is on, on the first switch turned on
 *   at the Mac; stops ringing when the last goes off (the db stays open,
 *   status says closed); a reminder missed while its module was off rings
 *   late once it is on again, whether or not another module stayed on; a
 *   zone change moves every ring; any life.* change emits life.changed {};
 * - a life.db that will not open: broken() is the sentence, the file is
 *   untouched, one "Life data needs attention" push, a code in the log;
 * - LD2: a module builder that throws leaves the daemon serving /healthz
 *   and the Board, and Life answering 503;
 * - status(): modules, zone (an unknown stored zone falls back to the
 *   Mac's), push devices (LS6: control, not revoked, subscribed; 0 with
 *   none) and the Web Push switch (LN5: false when off, and then no Life
 *   push goes out at all);
 * - Today: the parts of the modules that are on; a part that throws or
 *   does not parse is left out; a later day is refused;
 * - the lifeStatus and lifeToday routes.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, todoBody } from '@jantar/fixtures';
import { SettingsSchema, TodaySchema, type Scope, type Settings } from '@jantar/protocol';
import type { LifeModule, LifeModuleBuilders, LifePush, LifeService } from '../../src/contracts.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { LIFE_BROKEN_REASON } from '../../src/life/db.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import type { LifeSendResult } from '../../src/life/push.js';
import { LIFE_MISSING_REASON, LIFE_START_FAILED, buildLifeService, pushDevices } from '../../src/life/service.js';
import { buildTodosModule } from '../../src/life/todos/module.js';
import { WebPushNotifier } from '../../src/notify/webpush.js';
import { TEST_VAPID, h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';

const MIN = 60_000;
const ON = { todos: true };

let dir: string;
let ctx: TestContext;
let svc: LifeService | undefined;
let pushes: LifePush[];
let sendResult: LifeSendResult;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-life-svc-')));
  pushes = [];
  sendResult = { delivered: 1, failed: 0 };
});
afterEach(async () => {
  await svc?.stop();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

function settings(life: Partial<Settings['life']> = {}, more: Record<string, unknown> = {}): Settings {
  return SettingsSchema.parse({ life, ...more });
}

/** The real todos module, and stand-ins for the other four (`over` replaces any). */
function builders(over: Partial<LifeModuleBuilders> = {}): LifeModuleBuilders {
  const stub = (name: string, extra: Record<string, unknown> = {}) => () =>
    notBuilt<LifeModule>(name, { name, today: () => ({}), start: undefined, stop: undefined, ...extra } as unknown as Partial<LifeModule>);
  return {
    todos: buildTodosModule,
    medicines: stub('medicines'),
    food: stub('food', { estimateStatus: () => ({ available: false, reason: 'Synthetic: no runner.' }) }),
    places: stub('places'),
    finance: stub('finance'),
    ...over,
  } as LifeModuleBuilders;
}

function service(opts: { settings?: Settings; builders?: LifeModuleBuilders; at?: string; macZone?: string } = {}): LifeService {
  ctx = createTestContext({ home: dir, settings: opts.settings ?? settings(ON) });
  ctx.clock.set(opts.at ?? '2026-10-30T09:00:00.000Z');
  const f = makeFakes(ctx);
  svc = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, opts.builders ?? builders(), {
    macZone: opts.macZone ?? 'UTC',
    send: async (p) => {
      pushes.push(p);
      return { ...sendResult };
    },
  });
  return svc;
}

const lifeTicks = () => {
  const r = ctx.store.replay(0);
  return r.kind === 'events' ? r.events.filter((e) => e.type === 'life.changed') : [];
};
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A ping row's next_at, read beside the service's own connection. */
function pingAt(ref: string): string | null | undefined {
  const db = new DatabaseSync(ctx.paths.lifeDb, { readOnly: true });
  try {
    return (db.prepare('SELECT next_at FROM pings WHERE ref = ?').get(ref) as { next_at: string | null } | undefined)?.next_at;
  } finally {
    db.close();
  }
}

describe('with every real module', () => {
  it('every module on: start opens, each registers its rings, status and Today answer, stop is clean', async () => {
    const life = service({ settings: settings({ todos: true, medicines: true, food: true, places: true, finance: true }), builders: LIFE_MODULE_BUILDERS });
    await life.start();
    expect(life.broken()).toBeNull();
    expect(life.status()).toMatchObject({ open: true, modules: { todos: true, medicines: true, food: true, places: true, finance: true } });
    const today = life.today();
    expect(today.ok).toBe(true);
    expect(TodaySchema.safeParse(today.ok ? today.value : null).success).toBe(true);
    for (const m of [life.todos, life.medicines, life.food, life.places, life.finance]) expect(typeof m.today).toBe('function');
    await ctx.clock.tick(MIN);
    await life.stop();
    svc = undefined;
  });
});

describe('opening and closing with the switches', () => {
  it('with every module off nothing opens; the first switch turned on opens life.db', async () => {
    const life = service({ settings: settings() });
    await life.start();
    expect(existsSync(ctx.paths.lifeDb)).toBe(false);
    expect(life.status()).toMatchObject({ open: false, modules: { todos: false, medicines: false, food: false, places: false, finance: false } });
    expect(life.todos.listProjects()).toMatchObject({ ok: false, code: 'unavailable' });
    await ctx.settings.patch({ life: { todos: true } });
    expect(existsSync(ctx.paths.lifeDb)).toBe(true);
    expect(life.status()).toMatchObject({ open: true, modules: { todos: true } });
    expect(life.todos.listProjects()).toEqual({ ok: true, value: { projects: [] } });
    expect(lifeTicks().length).toBeGreaterThan(0);
  });

  it('the last module off stops the rings (the db stays open, status says closed); on again, they ring', async () => {
    const life = service({ at: '2026-10-30T10:58:00.000Z' });
    await life.start();
    const id = life.todos.createTodo(todoBody({}, { timed: { day: '2026-10-30', time: '11:00' } }), { kind: 'cli' });
    expect(id.ok).toBe(true);
    await ctx.settings.patch({ life: { todos: false } });
    expect(life.status().open).toBe(false);
    expect(life.todos.listProjects()).toMatchObject({ ok: true });
    await ctx.clock.tick(5 * MIN);
    expect(pushes).toHaveLength(0);
    await ctx.settings.patch({ life: { todos: true } });
    expect(life.status().open).toBe(true);
    await ctx.clock.tick(30_000);
    // The start sweep sends the missed ring, late; the resync keeps it while it is on its way.
    expect(pushes.map((p) => p.body)).toEqual(['Missed at 11:00 · Example todo · 11:00']);
  });

  it('a reminder missed while todos was off rings late once it is on again, with another module on throughout', async () => {
    const life = service({ settings: settings({ todos: true, places: true }), at: '2026-10-30T10:58:00.000Z' });
    await life.start();
    life.todos.createTodo(todoBody({}, { timed: { day: '2026-10-30', time: '11:00' } }), { kind: 'cli' });
    await ctx.settings.patch({ life: { todos: false } });
    await ctx.clock.tick(5 * MIN);
    expect(pushes).toHaveLength(0);
    await ctx.settings.patch({ life: { todos: true } });
    await ctx.clock.tick(30_000);
    expect(pushes.map((p) => p.body)).toEqual(['Missed at 11:00 · Example todo · 11:00']);
  });

  it('LS3 (todo part): a todo done before its time does not ring, nor a deleted one', async () => {
    const life = service({ at: '2026-10-30T10:58:00.000Z' });
    await life.start();
    const done = life.todos.createTodo(todoBody({}, { timed: { day: '2026-10-30', time: '11:00' } }), { kind: 'cli' });
    const gone = life.todos.createTodo(todoBody({}, { timed: { day: '2026-10-30', time: '11:01' } }), { kind: 'cli' });
    if (!done.ok || !gone.ok) throw new Error('not created');
    life.todos.setDone(done.value.id, true, { kind: 'cli' });
    life.todos.removeTodo(gone.value.id, { kind: 'cli' });
    for (let i = 0; i < 6; i++) await ctx.clock.tick(MIN);
    expect(pushes).toEqual([]);
  });

  it('a timed todo rings at its time, once, through the service', async () => {
    const life = service({ at: '2026-10-30T10:58:00.000Z' });
    await life.start();
    life.todos.createTodo(todoBody({}, { timed: { day: '2026-10-30', time: '11:00' } }), { kind: 'cli' });
    for (let i = 0; i < 6; i++) await ctx.clock.tick(MIN);
    expect(pushes).toEqual([expect.objectContaining({ kind: 'life', title: 'Todo due', body: 'Example todo · 11:00' })]);
  });

  it('a zone change moves every ring and emits life.changed', async () => {
    const life = service({ at: '2026-10-30T00:00:00.000Z' });
    await life.start();
    const made = life.todos.createTodo(todoBody({}, { timed: { day: '2026-10-30', time: '11:00' } }), { kind: 'cli' });
    if (!made.ok) throw new Error(made.reason);
    const nextAt = () => pingAt(made.value.id);
    expect(nextAt()).toBe('2026-10-30T11:00:00.000Z');
    const ticks = lifeTicks().length;
    await ctx.settings.patch({ life: { timezone: 'Asia/Kolkata' } });
    expect(life.status().timezone).toBe('Asia/Kolkata');
    expect(nextAt()).toBe('2026-10-30T05:30:00.000Z');
    expect(lifeTicks().length).toBe(ticks + 1);
    // A change elsewhere in settings is not a Life change.
    await ctx.settings.patch({ rewrite: { enabled: true } });
    expect(lifeTicks().length).toBe(ticks + 1);
  });

  it("a stored zone this runtime does not know falls back to the Mac's", async () => {
    const life = service({ settings: settings({ todos: true, timezone: 'Mars/Olympus_Mons' }), macZone: 'Europe/London' });
    await life.start();
    expect(life.status().timezone).toBe('Europe/London');
  });

  it('stop closes everything and leaves no timer behind', async () => {
    const life = service();
    await life.start();
    await life.stop();
    svc = undefined;
    expect(life.status().open).toBe(false);
    expect(ctx.clock.pending()).toBe(0);
  });
});

describe('a life.db that will not open', () => {
  it('is broken with the sentence, untouched, said once on the phone, and logged by code', async () => {
    writeFileSync(ctx_dir_file(), Buffer.from(`not a database ${LIFE_MARKER} `.repeat(200)));
    const before = sha(ctx_dir_file());
    const life = service();
    await life.start();
    await ctx.clock.tick(0);
    expect(life.broken()).toBe(LIFE_BROKEN_REASON);
    expect(life.status()).toMatchObject({ open: false, broken: LIFE_BROKEN_REASON });
    expect(sha(ctx_dir_file())).toBe(before);
    expect(pushes).toEqual([expect.objectContaining({ kind: 'life', title: 'Life data needs attention', url: '/today' })]);
    expect(ctx.log.records.some((r) => r.fields.event === 'life.broken' && r.fields.code === 'not_sqlite')).toBe(true);
    expect(JSON.stringify(ctx.log.records)).not.toContain(LIFE_MARKER);
    // A switch flipped later does not reopen it or push again.
    await ctx.settings.patch({ life: { medicines: true } });
    expect(life.broken()).toBe(LIFE_BROKEN_REASON);
    expect(pushes).toHaveLength(1);
    expect(life.today()).toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('a life.db that is missing while backups of it exist', () => {
  it('is broken with its own sentence, creates no empty life.db or backup, and a restore mends it', async () => {
    const first = service();
    await first.start();
    first.todos.createTodo({ title: 'Kept in the backup' }, { kind: 'cli' });
    const b = await first.backup();
    if (!b.ok) throw new Error(b.reason);
    await first.stop();
    svc = undefined;
    for (const suffix of ['', '-wal', '-shm']) rmSync(ctx_dir_file() + suffix, { force: true });
    const backupsBefore = readdirSync(ctx.paths.backupsDir).sort();

    const life = service();
    await life.start();
    await ctx.clock.tick(0);
    expect(life.broken()).toBe(LIFE_MISSING_REASON);
    expect(life.status()).toMatchObject({ open: false, broken: LIFE_MISSING_REASON });
    expect(existsSync(ctx_dir_file())).toBe(false);
    expect(pushes.filter((p) => p.title === 'Life data needs attention')).toHaveLength(1);
    expect(ctx.log.records.some((r) => r.fields.event === 'life.broken' && r.fields.code === 'missing')).toBe(true);
    await ctx.clock.tick(24 * 60 * 60_000);
    expect(readdirSync(ctx.paths.backupsDir).sort()).toEqual(backupsBefore);

    expect((await life.restore(b.value.file)).ok).toBe(true);
    expect(life.broken()).toBeNull();
    const list = life.todos.listTodos({ done: false });
    expect(list.ok && list.value.todos.map((t) => t.title)).toEqual(['Kept in the backup']);
  });

  it('with no backups, a missing life.db is simply a new one', async () => {
    const life = service();
    await life.start();
    expect(life.broken()).toBeNull();
    expect(existsSync(ctx_dir_file())).toBe(true);
  });
});

function ctx_dir_file(): string {
  return join(dir, 'life.db');
}

describe('LD2: a module that fails to start', () => {
  const throwing = builders({
    medicines: () => {
      throw new Error(`builder bug ${LIFE_MARKER}`);
    },
  });

  it('start resolves; Life is broken with its own sentence; the log has no message text', async () => {
    const life = service({ builders: throwing });
    await expect(life.start()).resolves.toBeUndefined();
    expect(life.broken()).toBe(LIFE_START_FAILED);
    expect(life.status()).toMatchObject({ open: false, broken: LIFE_START_FAILED });
    expect(ctx.log.records.some((r) => r.fields.event === 'life.broken' && r.fields.code === 'start_failed')).toBe(true);
    expect(JSON.stringify(ctx.log.records)).not.toContain(LIFE_MARKER);
  });

  it('the daemon keeps serving /healthz and the Board; Life routes answer 503', async () => {
    let life!: LifeService;
    const api = await makeApi({
      ctx: { home: dir, settings: settings(ON) },
      deps: (c, f) => {
        life = buildLifeService(c, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, throwing, { macZone: 'UTC' });
        return { life };
      },
    });
    try {
      await life.start();
      const { cookie } = await pairCookie(api, ['read', 'control']);
      expect((await api.tcp.inject({ method: 'GET', url: '/healthz', headers: h() })).statusCode).toBe(200);
      expect((await api.tcp.inject({ method: 'GET', url: '/v1/sessions', headers: h(cookie) })).statusCode).toBe(200);
      expect((await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(cookie) })).statusCode).toBe(200);
      const today = await api.tcp.inject({ method: 'GET', url: '/v1/life/today', headers: h(cookie) });
      expect(today.statusCode).toBe(503);
      expect(today.json().error).toEqual({ code: 'life_unavailable', message: LIFE_START_FAILED });
      expect((await api.tcp.inject({ method: 'GET', url: '/v1/life/status', headers: h(cookie) })).json()).toMatchObject({ open: false, broken: LIFE_START_FAILED });
    } finally {
      await life.stop();
      await api.close();
    }
  });
});

describe('status', () => {
  function addDevice(id: string, scopes: Scope[], opts: { sub?: string | false; revoked?: boolean } = {}) {
    ctx.db.devices.insert({ id, name: id, keyHash: `h-${id}`, scopes, createdAt: ctx.clock.iso(), lastSeenAt: ctx.clock.iso(), ...(opts.revoked ? { revokedAt: ctx.clock.iso() } : {}) });
    if (opts.sub !== false) ctx.db.pushSubs.upsert({ subscription: { endpoint: opts.sub ?? `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: 'p', auth: 'a' } }, deviceId: id, createdAt: ctx.clock.iso() });
  }

  it('LS6: push.devices counts control devices, not revoked, with a subscription to a push service; 0 with none', async () => {
    const life = service();
    await life.start();
    expect(life.status().push).toEqual({ devices: 0, webpush: true });
    addDevice('phone', ['read', 'control']);
    addDevice('tablet', ['read', 'control', 'launch', 'admin']);
    addDevice('screen', ['read']);
    addDevice('old', ['read', 'control'], { revoked: true });
    addDevice('nosub', ['read', 'control'], { sub: false });
    addDevice('elsewhere', ['read', 'control'], { sub: 'https://push.example.com/x' });
    expect(life.status().push.devices).toBe(2);
    expect(pushDevices(ctx.db)).toBe(2);
  });

  it('the fields: modules, zone, today, currency, lock screen, estimate from food while food is on, backups', async () => {
    const life = service({ settings: settings({ todos: true, currency: 'INR', lockScreenDetails: true, timezone: 'Asia/Kolkata' }) });
    await life.start();
    expect(life.status()).toEqual({
      open: true,
      timezone: 'Asia/Kolkata',
      today: '2026-10-30',
      currency: 'INR',
      lockScreenDetails: true,
      modules: { todos: true, medicines: false, food: false, places: false, finance: false },
      estimate: { available: false },
      backups: expect.objectContaining({ count: expect.any(Number) }),
      push: { devices: 0, webpush: true },
    });
    await ctx.settings.patch({ life: { food: true } });
    expect(life.status().estimate).toEqual({ available: false, reason: 'Synthetic: no runner.' });
  });

  it('LN5: with notify.webpush off the status says so, and a due ring sends no push', async () => {
    ctx = createTestContext({ home: dir, settings: settings(ON, { notify: { webpush: false } }) });
    ctx.clock.set('2026-10-30T10:59:00.000Z');
    const sent: string[] = [];
    const webpush = new WebPushNotifier(ctx, { vapid: TEST_VAPID, sender: async (sub) => void sent.push(sub.endpoint) });
    const f = makeFakes(ctx);
    svc = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: [webpush] }, builders(), { macZone: 'UTC' });
    await svc.start();
    ctx.db.devices.insert({ id: 'phone', name: 'phone', keyHash: 'h', scopes: ['read', 'control'], createdAt: ctx.clock.iso(), lastSeenAt: ctx.clock.iso() });
    ctx.db.pushSubs.upsert({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/phone', keys: { p256dh: 'p', auth: 'a' } }, deviceId: 'phone', createdAt: ctx.clock.iso() });
    expect(svc.status().push).toEqual({ devices: 1, webpush: false });
    svc.todos.createTodo(todoBody({}, { timed: { day: '2026-10-30', time: '11:00' } }), { kind: 'cli' });
    for (let i = 0; i < 3; i++) await ctx.clock.tick(MIN);
    expect(sent).toEqual([]);
    // Switched back on, the next ring goes out.
    await ctx.settings.patch({ notify: { webpush: true } });
    svc.todos.createTodo(todoBody({}, { timed: { day: '2026-10-30', time: '11:05' } }), { kind: 'cli' });
    for (let i = 0; i < 3; i++) await ctx.clock.tick(MIN);
    expect(sent).toEqual(['https://fcm.googleapis.com/fcm/send/phone']);
  });
});

describe('Today', () => {
  /** No lifecycle hooks (notBuilt would hand back throwers for them). */
  const HOOKS = { start: undefined, stop: undefined };

  it('merges the parts of the modules that are on; a part that throws or does not parse is left out', async () => {
    const life = service({
      settings: settings({ todos: true, food: true, finance: true, places: true }),
      builders: builders({
        food: () => notBuilt('food', { ...HOOKS, name: 'food', today: () => ({ food: { kcal: 420, target: 1800, weight: null } }), estimateStatus: () => ({ available: false }) } as never),
        finance: () => notBuilt('finance', { ...HOOKS, name: 'finance', today: () => ({ bills: [{ not: 'a bill' }] }) } as never),
        places: () =>
          notBuilt('places', {
            ...HOOKS,
            name: 'places',
            today: () => {
              throw new Error('places bug');
            },
          } as never),
        medicines: () => notBuilt('medicines', { ...HOOKS, name: 'medicines', today: () => ({ meds: { day: 'x' } }) } as never),
      }),
    });
    await life.start();
    life.todos.createTodo({ title: 'Due today', due: { day: '2026-10-30' } }, { kind: 'cli' });
    const r = life.today();
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.value).sort()).toEqual(['day', 'food', 'todos']);
    expect(r.value.day).toBe('2026-10-30');
    expect(r.value.food).toEqual({ kcal: 420, target: 1800, weight: null });
    expect(r.value.todos?.today.map((t) => t.title)).toEqual(['Due today']);
    expect(ctx.log.records.filter((x) => x.msg.startsWith('life today part')).map((x) => x.fields.module).sort()).toEqual(['finance', 'places']);
  });

  it('an earlier day is fine; a later one is refused', async () => {
    const life = service();
    await life.start();
    expect(life.today('2026-10-01')).toMatchObject({ ok: true, value: { day: '2026-10-01' } });
    expect(life.today('2026-10-31')).toEqual({ ok: false, code: 'invalid_request', reason: 'Today shows today or an earlier day.' });
  });
});

describe('the lifeStatus and lifeToday routes', () => {
  let api: TestApi;
  let life: LifeService;
  beforeEach(async () => {
    api = await makeApi({
      ctx: { home: dir, settings: settings(ON) },
      deps: (c, f) => {
        life = buildLifeService(c, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, builders(), { macZone: 'UTC' });
        return { life };
      },
    });
    api.ctx.clock.set('2026-10-30T09:00:00.000Z');
    await life.start();
  });
  afterEach(async () => {
    await life.stop();
    await api.close();
  });

  it('status answers a control device and the CLI; Today answers a control device', async () => {
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const st = await api.tcp.inject({ method: 'GET', url: '/v1/life/status', headers: h(cookie) });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ open: true, timezone: 'UTC', today: '2026-10-30', modules: { todos: true } });
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/life/status' })).json()).toMatchObject({ open: true });
    life.todos.createTodo({ title: 'Due today', due: { day: '2026-10-30' } }, { kind: 'cli' });
    const today = await api.tcp.inject({ method: 'GET', url: '/v1/life/today?day=2026-10-30', headers: h(cookie) });
    expect(today.statusCode).toBe(200);
    expect(today.json().todos.today).toHaveLength(1);
    const later = await api.tcp.inject({ method: 'GET', url: '/v1/life/today?day=2026-11-30', headers: h(cookie) });
    expect(later.statusCode).toBe(400);
  });

  it('a read-only device gets neither', async () => {
    const { cookie } = await pairCookie(api, ['read']);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/life/status', headers: h(cookie) })).statusCode).toBe(403);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/life/today', headers: h(cookie) })).statusCode).toBe(403);
  });
});
