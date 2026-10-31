/**
 * The folder and launch routes over both transports, on the real API
 * pipeline with the real launcher (fake path policy, fake Terminal window):
 * security rules L2 (the phone cannot pass argv: unknown keys and flags off
 * the allowlist are 400), L8 (launchAnswer is not on ctl.sock and is refused
 * when the dialog changed), L10 (a retried launchStart with the same
 * Idempotency-Key opens one window), device scopes granted on the Mac, the
 * per-device limiters, and audit rows without prompt text.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V03_LAUNCH_FLAGS, IDEMPOTENCY_HEADER, SettingsSchema, type LaunchJob } from '@jantar/protocol';
import { V03_LIMITS } from '../../src/api/services.js';
import { LauncherService } from '../../src/launcher/service.js';
import { h, makeApi, makeSession, pairCookie, type TestApi } from '../api/fakes.js';
import { FakeBackend, FakeCcw, FakePolicy, DEFAULT_ACCOUNTS, KEPT, T0, filesWith, trustScreen, until } from './helpers.js';

let api: TestApi;
let tmp: string;
let launcher: LauncherService;
let terminal: FakeBackend;
let ccw: FakeCcw;
afterEach(async () => {
  await launcher?.stop();
  await api?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

const SECRET = 'SECRET-PROMPT-9d2f refactor the parser';

/** Every refusal the launcher handed to Files' audit (files.denied and the probe alarm). */
let denied: [string, string, string][] = [];

async function setup(launch: Record<string, unknown> = {}) {
  denied = [];
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'ccw-launch-api-')));
  const work = join(tmp, 'work');
  await mkdir(join(work, 'alpha-app'), { recursive: true });
  await mkdir(join(work, 'beta'));
  terminal = new FakeBackend();
  api = await makeApi({
    ctx: { settings: SettingsSchema.parse({ launch: { enabled: true, mode: 'cs-shell', defaultFlags: V03_LAUNCH_FLAGS, ...launch }, accounts: { kept: KEPT } }) },
    sessions: [],
    deps: (ctx, fakes) => {
      launcher = new LauncherService(ctx, {
        sessions: fakes.sessions,
        terminal,
        writer: fakes.writer,
        usage: fakes.usage,
        ccwLegacy: (ccw = new FakeCcw()),
        files: {
          ...filesWith(new FakePolicy([{ id: 'r.work', label: 'work', real: work, display: '~/work' }])),
          denied: (_actor, root, rel, reason) => void denied.push([root, rel, reason]),
        },
        notifiers: [],
      });
      return { launcher };
    },
  });
  api.ctx.clock.set(T0);
  api.ctx.store.emit({ type: 'usage.updated', data: { accounts: DEFAULT_ACCOUNTS(), activeAccount: null, fetchedAt: T0, source: 'cache' } });
  await launcher.start();
  return { work };
}

const START = { root: 'r.work', path: 'alpha-app', account: 'auto', flags: V03_LAUNCH_FLAGS };

function post(url: string, payload: unknown, cookie: string, extra: Record<string, string> = {}) {
  return api.tcp.inject({ method: 'POST', url, headers: h(cookie, extra), payload: payload as object });
}

describe('launchStart', () => {
  it('202 with the queued job; the window opens in the background', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const res = await post('/v1/launches', { ...START, prompt: SECRET }, cookie, { [IDEMPOTENCY_HEADER]: 'k1' });
    expect(res.statusCode).toBe(202);
    const job = res.json().job as LaunchJob;
    expect(job).toMatchObject({ stage: 'queued', account: 7, name: 'alpha-app', prompt: { length: SECRET.length } });
    expect(res.body).not.toContain('SECRET-PROMPT');
    await until(api.ctx.clock, () => terminal.opened.length === 1);
  });

  it('needs an Idempotency-Key', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const res = await post('/v1/launches', START, cookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Idempotency-Key/);
    expect(terminal.opened).toEqual([]);
  });

  it('L2: the phone cannot pass argv: unknown keys and flags off the allowlist are 400, and nothing runs', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const spy = vi.spyOn(launcher, 'launch');
    const bad: unknown[] = [
      { ...START, args: ['--settings', '/tmp/evil.json'] },
      { ...START, extraArgs: ['--add-dir', '/'] },
      { ...START, profile: 'ultracode' },
      { ...START, trust: true },
      { ...START, flags: { ...V03_LAUNCH_FLAGS, extra: '--mcp-config x' } },
      { ...START, flags: { ...V03_LAUNCH_FLAGS, permission: 'bypassPermissions' } },
      { ...START, flags: { ...V03_LAUNCH_FLAGS, model: 'opus --settings x' } },
      { ...START, flags: { ...V03_LAUNCH_FLAGS, effort: 'ultracode; rm -rf ~' } },
      { ...START, flags: { permission: 'skip' } },
      { ...START, name: 'two words' },
      { ...START, name: '--settings' },
      { ...START, account: '7' },
    ];
    for (const [i, payload] of bad.entries()) {
      const res = await post('/v1/launches', payload, cookie, { [IDEMPOTENCY_HEADER]: `bad-${i}` });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(terminal.opened).toEqual([]);
  });

  it('L10: a retried start with the same Idempotency-Key opens one window', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const first = await post('/v1/launches', START, cookie, { [IDEMPOTENCY_HEADER]: 'retry-me' });
    const again = await post('/v1/launches', START, cookie, { [IDEMPOTENCY_HEADER]: 'retry-me' });
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(202);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().job.id).toBe(first.json().job.id);
    await until(api.ctx.clock, () => terminal.opened.length > 0);
    await until(api.ctx.clock, () => false, 20_000).catch(() => undefined);
    expect(terminal.opened).toHaveLength(1);
    expect(api.ctx.db.launches.list()).toHaveLength(1);
  });

  it('the per-device limiter answers 429 with retry-after (on top of launch.rate)', async () => {
    await setup({ rate: { inFlight: 10, perTenMin: 100 } });
    const { cookie } = await pairCookie(api, ['launch']);
    terminal.openResult = { ok: false, code: 'failed', reason: 'no window' };
    for (let i = 0; i < V03_LIMITS.launch.limit; i++) {
      const r = await post('/v1/launches', START, cookie, { [IDEMPOTENCY_HEADER]: `n${i}` });
      expect(r.statusCode, r.body).toBe(202);
      const id = r.json().job.id as string;
      await until(api.ctx.clock, () => launcher.get(id)?.job.stage === 'failed');
    }
    const over = await post('/v1/launches', START, cookie, { [IDEMPOTENCY_HEADER]: 'over' });
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('launcher refusals map to their API codes', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const go = (payload: unknown, key: string) => post('/v1/launches', payload, cookie, { [IDEMPOTENCY_HEADER]: key });
    expect((await go({ ...START, account: 1 }, 'a')).statusCode).toBe(409);
    expect((await go({ ...START, root: 'r.nope' }, 'b')).statusCode).toBe(404);
    expect((await go({ ...START, path: '../..' }, 'c')).statusCode).toBe(400);
    expect((await go({ ...START, account: 42 }, 'd')).statusCode).toBe(400);
  });

  it('the audit row carries the prompt hash and length, never its text', async () => {
    await setup();
    const { cookie, deviceId } = await pairCookie(api, ['launch']);
    await post('/v1/launches', { ...START, prompt: SECRET }, cookie, { [IDEMPOTENCY_HEADER]: 'aud' });
    const row = api.ctx.db.audit.list({ limit: 100 }).find((a) => a.action === 'launchStart');
    expect(row).toMatchObject({ actor: `device:${deviceId}`, result: 'ok', params: { root: 'r.work', path: 'alpha-app', account: 7, promptLength: SECRET.length } });
    expect((row?.params as { promptHash?: string }).promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(api.ctx.db.audit.list({ limit: 100 }))).not.toContain('SECRET-PROMPT');
  });

  it('the CLI can start one over ctl.sock', async () => {
    await setup();
    const res = await api.ctl.inject({ method: 'POST', url: '/v1/launches', headers: { [IDEMPOTENCY_HEADER]: 'cli-1' }, payload: START });
    expect(res.statusCode).toBe(202);
    expect(res.json().job.actor).toBe('cli');
  });
});

describe('launchAnswer', () => {
  it('L8: never on ctl.sock; refused when the dialog changed; answered with the title the phone saw', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const res = await post('/v1/launches', START, cookie, { [IDEMPOTENCY_HEADER]: 'dlg' });
    const id = res.json().job.id as string;
    await until(api.ctx.clock, () => launcher.get(id)?.job.stage === 'starting');
    terminal.fg = 'claude';
    terminal.screen = trustScreen(0);
    await until(api.ctx.clock, () => launcher.get(id)?.job.stage === 'dialog');

    const viaCtl = await api.ctl.inject({ method: 'POST', url: `/v1/launches/${id}/answer`, payload: { option: 1, title: 'Accessing workspace:' } });
    expect(viaCtl.statusCode).toBe(404);

    const changed = await post(`/v1/launches/${id}/answer`, { option: 1, title: 'Do you trust the files in this folder?' }, cookie);
    expect(changed.statusCode).toBe(409);
    expect(terminal.keys).toEqual([]);

    const answering = post(`/v1/launches/${id}/answer`, { option: 1, title: 'Accessing workspace:' }, cookie);
    await until(api.ctx.clock, () => terminal.keys.length > 0, 5_000);
    const ok = await answering;
    expect(ok.statusCode).toBe(200);
    expect(ok.json().job.stage).toBe('starting');
    expect(terminal.keys).toEqual([{ key: 'down', repeat: 1 }]);
    const row = api.ctx.db.audit.list({ limit: 100 }).find((a) => a.action === 'launchAnswer' && a.result === 'ok');
    expect(row?.params).toEqual({ launchId: id, option: 1, title: 'Accessing workspace:' });
  });

  it('a control-only device is refused (launch scope)', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect((await post('/v1/launches/x/answer', { option: 0, title: 't' }, cookie)).statusCode).toBe(403);
  });
});

describe('folder reads and previews', () => {
  it('a protected or outside path goes to Files\' audit (the probe alarm counts it), from the browser and the preview', async () => {
    await setup();
    const { cookie } = await pairCookie(api);
    const get = (url: string) => api.tcp.inject({ method: 'GET', url, headers: h(cookie) });
    expect((await get('/v1/folders?root=r.work&path=.ssh')).statusCode).toBe(403);
    expect((await get('/v1/launch/preview?root=r.work&path=alpha-app%2F.env')).statusCode).toBe(403);
    expect((await get('/v1/folders?root=r.work&path=alpha-app')).statusCode).toBe(200);
    expect(denied).toEqual([
      ['r.work', '.ssh', 'protected'],
      ['r.work', 'alpha-app/.env', 'protected'],
    ]);
  });

  it(`at most ${V03_LIMITS.folders.limit} folder reads and previews a minute per device, then 429 with retry-after`, async () => {
    await setup();
    const { cookie } = await pairCookie(api);
    const urls = ['/v1/folders/roots', '/v1/folders?root=r.work', '/v1/folders/recent', '/v1/launch/preview?root=r.work&path=alpha-app'];
    for (let i = 0; i < V03_LIMITS.folders.limit; i++) {
      expect((await api.tcp.inject({ method: 'GET', url: urls[i % urls.length] as string, headers: h(cookie) })).statusCode).toBe(200);
    }
    const over = await api.tcp.inject({ method: 'GET', url: '/v1/folders?root=r.work', headers: h(cookie) });
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
    // Another device has its own budget.
    const other = await pairCookie(api, ['read', 'control'], 'Other');
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/folders/roots', headers: h(other.cookie) })).statusCode).toBe(200);
  });
});

describe('launchPreview, launchGet, launchList', () => {
  it('the preview: account, flags, the exact command line and warnings', async () => {
    const { work } = await setup();
    const { cookie } = await pairCookie(api);
    const res = await api.tcp.inject({ method: 'GET', url: '/v1/launch/preview?root=r.work&path=alpha-app&effort=high&chrome=0', headers: h(cookie) });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p).toMatchObject({
      root: 'r.work',
      path: 'alpha-app',
      display: '~/work/alpha-app',
      account: { pick: 7, source: 'auto', reason: 'most room · 5h 12% · resets in 3h40 · 13:40' },
      flags: { permission: 'skip', chrome: false, effort: 'high', model: 'default' },
      defaults: V03_LAUNCH_FLAGS,
      args: ['--dangerously-skip-permissions', '--effort', 'high'],
      name: 'alpha-app',
    });
    expect(p.command).toBe(`cd -- ${work}/alpha-app && cs 7 -- --dangerously-skip-permissions --effort high --session-id <session id> --name alpha-app`);
    // No legacy ccw tool here: nothing moves a session, so a lower effort has nothing to warn about.
    expect(p.warnings).toEqual([]);
    expect(p.accounts.map((a: { id: number; held: boolean }) => [a.id, a.held])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
      [5, true],
      [7, false],
    ]);
    expect(res.headers['cache-control']).toBe('no-store');
    // With the legacy ccw tool, a move would restart the session with ultracode effort: say so.
    ccw.isPresent = true;
    const again = await api.tcp.inject({ method: 'GET', url: '/v1/launch/preview?root=r.work&path=alpha-app&effort=high&chrome=0', headers: h(cookie) });
    expect(again.json().warnings).toContainEqual({ kind: 'effort', text: 'An account move restarts it with ultracode effort (ccw adds --effort ultracode)' });
  });

  it('U7: the command shows the Name typed on the sheet; a taken one warns; a bad one is 400', async () => {
    const { work } = await setup();
    const { cookie } = await pairCookie(api);
    const get = (q: string) => api.tcp.inject({ method: 'GET', url: `/v1/launch/preview?root=r.work&path=alpha-app${q}`, headers: h(cookie) });
    const typed = (await get('&name=my-custom-name')).json();
    expect(typed.name).toBe('my-custom-name');
    expect(typed.command).toBe(`cd -- ${work}/alpha-app && cs 7 -- --dangerously-skip-permissions --chrome --effort ultracode --session-id <session id> --name my-custom-name`);
    expect(typed.warnings).toEqual([]);
    api.ctx.store.emit({ type: 'session.added', sid: 'busy', data: { session: { ...makeSession({ sid: 'busy' }), name: 'busy-name' } } });
    const taken = (await get('&name=busy-name')).json();
    expect(taken.command).toMatch(/--name busy-name$/);
    expect(taken.warnings).toEqual([{ kind: 'name', text: 'A session named busy-name is already running or starting' }]);
    expect((await get('&name=two%20words')).statusCode).toBe(400);
    expect((await get('&name=')).statusCode).toBe(400);
  });

  it('starts from the flags this device used last; a held manual pick warns; stale usage warns', async () => {
    await setup();
    const { cookie, deviceId } = await pairCookie(api, ['launch']);
    api.ctx.db.launchFlags.set(`device:${deviceId}`, { permission: 'plan', chrome: false, effort: 'ultracode', model: 'opus' }, T0);
    api.ctx.clock.set(Date.parse(T0) + 14 * 60_000);
    const res = await api.tcp.inject({ method: 'GET', url: '/v1/launch/preview?root=r.work&path=beta&account=2', headers: h(cookie) });
    const p = res.json();
    expect(p.flags).toEqual({ permission: 'plan', chrome: false, effort: 'ultracode', model: 'opus' });
    expect(p.account).toMatchObject({ pick: 2, source: 'manual' });
    expect(p.warnings).toEqual([
      { kind: 'held', text: 'Held for other work. ccw will never move this session, even when 02 fills up.', account: 2 },
      { kind: 'stale', text: 'Based on usage readings 14m old' },
    ]);
  });

  it('bad queries are 400, unknown roots 404', async () => {
    await setup();
    const { cookie } = await pairCookie(api);
    const get = (q: string) => api.tcp.inject({ method: 'GET', url: `/v1/launch/preview?${q}`, headers: h(cookie) });
    expect((await get('root=r.work&path=alpha-app&account=')).statusCode).toBe(400);
    expect((await get('root=r.work&path=alpha-app&permission=bypass')).statusCode).toBe(400);
    expect((await get('root=r.nope&path=x')).statusCode).toBe(404);
  });

  it('get and list, on TCP for a read device and on ctl.sock', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const id = (await post('/v1/launches', START, cookie, { [IDEMPOTENCY_HEADER]: 'g' })).json().job.id as string;
    const reader = await pairCookie(api, ['read']);
    expect((await api.tcp.inject({ method: 'GET', url: `/v1/launches/${id}`, headers: h(reader.cookie) })).json().job.id).toBe(id);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/launches/nope', headers: h(reader.cookie) })).statusCode).toBe(404);
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/launches?active=1' })).json().jobs.map((j: LaunchJob) => j.id)).toEqual([id]);
  });
});

describe('folders', () => {
  it('roots, list and recent: 200 with no-store; the CLI sees absolute paths', async () => {
    const { work } = await setup();
    const { cookie } = await pairCookie(api);
    const roots = await api.tcp.inject({ method: 'GET', url: '/v1/folders/roots', headers: h(cookie) });
    expect(roots.json()).toEqual({ roots: [{ id: 'r.work', kind: 'configured', label: 'work', display: '~/work', home: false }] });
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/folders/roots' })).json().roots[0].path).toBe(work);
    const list = await api.tcp.inject({ method: 'GET', url: '/v1/folders?root=r.work', headers: h(cookie) });
    expect(list.json().entries.map((e: { name: string }) => e.name)).toEqual(['alpha-app', 'beta']);
    expect(list.headers['cache-control']).toBe('no-store');
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/folders/recent', headers: h(cookie) })).json()).toEqual({ recent: [] });
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/folders?root=r.work&path=../..', headers: h(cookie) })).statusCode).toBe(400);
  });

  it('pin: a phone write, not on ctl.sock, audited with the path', async () => {
    await setup();
    const { cookie } = await pairCookie(api);
    const res = await api.tcp.inject({ method: 'PUT', url: '/v1/folders/pins', headers: h(cookie), payload: { root: 'r.work', path: 'beta', pinned: true } });
    expect(res.json()).toEqual({ ok: true });
    expect((await api.ctl.inject({ method: 'PUT', url: '/v1/folders/pins', payload: { root: 'r.work', path: 'beta', pinned: true } })).statusCode).toBe(404);
    expect(api.ctx.db.audit.list({ limit: 100 }).find((a) => a.action === 'foldersPin')?.params).toEqual({ root: 'r.work', path: 'beta', pinned: true });
  });

  it('create: 201 {root, path}; 409 when it exists; 400 for a bad name; the per-device limiter (10 an hour)', async () => {
    await setup({ rate: { foldersPerHour: 100 } });
    const { cookie } = await pairCookie(api, ['launch']);
    const make = (name: string, key: string) => post('/v1/folders', { root: 'r.work', parent: 'beta', name }, cookie, { [IDEMPOTENCY_HEADER]: key });
    const ok = await make('new-one', 'c0');
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toEqual({ root: 'r.work', path: 'beta/new-one' });
    expect(api.ctx.db.audit.list({ limit: 100 }).find((a) => a.action === 'foldersCreate')?.params).toEqual({ root: 'r.work', parent: 'beta', name: 'new-one', rel: 'beta/new-one' });
    const exists = await make('new-one', 'c1');
    expect(exists.statusCode).toBe(409);
    expect(exists.json().error.code).toBe('conflict');
    expect((await make('.hidden', 'c2')).statusCode).toBe(400);
    // c0 and c1 count (the 400 never reaches the handler): eight more make ten.
    for (let i = 3; i < 11; i++) expect((await make(`f${i}`, `c${i}`)).statusCode).toBe(201);
    const limited = await make('f11', 'c11');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('deviceScopes (the Mac grants launch)', () => {
  it('ctl.sock adds and removes scopes; the device’s next call sees the change', async () => {
    await setup();
    const phone = await pairCookie(api, ['read', 'control']);
    const url = `/v1/devices/${phone.deviceId}/scopes`;
    expect((await post('/v1/launches', START, phone.cookie, { [IDEMPOTENCY_HEADER]: 's0' })).statusCode).toBe(403);
    const grant = await api.ctl.inject({ method: 'POST', url, payload: { add: ['launch'] } });
    expect(grant.statusCode).toBe(200);
    expect(grant.json().device.scopes).toEqual(['read', 'control', 'launch']);
    expect(grant.json().device).not.toHaveProperty('keyHash');
    expect(grant.json().device).not.toHaveProperty('secretHash');
    expect((await post('/v1/launches', START, phone.cookie, { [IDEMPOTENCY_HEADER]: 's1' })).statusCode).toBe(202);
    const revoke = await api.ctl.inject({ method: 'POST', url, payload: { remove: ['launch'] } });
    expect(revoke.json().device.scopes).toEqual(['read', 'control']);
    expect((await post('/v1/launches', { ...START, path: 'beta' }, phone.cookie, { [IDEMPOTENCY_HEADER]: 's2' })).statusCode).toBe(403);
    const row = api.ctx.db.audit.list({ limit: 100 }).filter((a) => a.action === 'deviceScopes')[0];
    expect(row).toMatchObject({ actor: 'cli', target: phone.deviceId, result: 'ok', params: { add: ['launch'], remove: [], before: ['read', 'control'], scopes: ['read', 'control', 'launch'] } });
  });

  it('removing a scope removes the ones above it, read always stays', async () => {
    await setup();
    const admin = await pairCookie(api, ['admin']);
    const res = await api.ctl.inject({ method: 'POST', url: `/v1/devices/${admin.deviceId}/scopes`, payload: { remove: ['control'] } });
    expect(res.json().device.scopes).toEqual(['read']);
  });

  it('404 for an unknown or revoked device; 400 for an empty change; 403 over TCP even for an admin', async () => {
    await setup();
    const phone = await pairCookie(api);
    expect((await api.ctl.inject({ method: 'POST', url: '/v1/devices/nope/scopes', payload: { add: ['launch'] } })).statusCode).toBe(404);
    expect((await api.ctl.inject({ method: 'POST', url: `/v1/devices/${phone.deviceId}/scopes`, payload: {} })).statusCode).toBe(400);
    const admin = await pairCookie(api, ['admin']);
    expect((await post(`/v1/devices/${phone.deviceId}/scopes`, { add: ['launch'] }, admin.cookie)).statusCode).toBe(403);
    await api.ctl.inject({ method: 'DELETE', url: `/v1/devices/${phone.deviceId}` });
    expect((await api.ctl.inject({ method: 'POST', url: `/v1/devices/${phone.deviceId}/scopes`, payload: { add: ['launch'] } })).statusCode).toBe(404);
  });
});
