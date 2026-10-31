/**
 * File reads audit themselves (v0.3 spec 4.4.9): `files.read`, `files.raw`
 * and `files.list` once per device and path per 10 min, `files.denied` on
 * every refusal (capped per device), and security rule F13: 5 protected or
 * outside refusals from one device within 10 min raise one `security` push
 * to every device and one audit row. Plus the per-device request limit.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '@jantar/protocol';
import type { Actor } from '../../src/contracts.js';
import { AUDIT_DEDUPE_MS, DENIED_ROWS_PER_WINDOW, PROBE_THRESHOLD, PROBE_WINDOW_MS, auditPath } from '../../src/files/audit.js';
import { settleRawRow } from '../../src/files/raw.js';
import { buildFilesService } from '../../src/files/service.js';
import { V03_LIMITS } from '../../src/api/services.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { CLI, PHONE, SECRET_MARKER, fpEnv, type FpEnv } from './fp-helpers.js';

let env: FpEnv;
let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  env?.cleanup();
});

const OTHER: Actor = { kind: 'device', deviceId: 'dev-other', scopes: ['read', 'control'] };
const rows = (action?: string): AuditEntry[] => env.ctx.db.audit.list({ limit: 1000 }).filter((r) => !action || r.action === action);
const text = (path: string, actor: Actor = PHONE) => env.files.text({ root: 'r.proj', path, offset: 0, max: 4096 }, actor);

describe('read rows', () => {
  it('files.read: once per device and path per 10 min, with root, rel, bytes and kind only', async () => {
    env = fpEnv();
    await text('src/app.ts');
    await text('src/app.ts');
    await text('src/app.ts');
    expect(rows('files.read')).toHaveLength(1);
    expect(rows('files.read')[0]).toMatchObject({
      actor: 'device:dev-phone',
      action: 'files.read',
      target: 'r.proj',
      params: { root: 'r.proj', rel: 'src/app.ts', bytes: 26, kind: 'text' },
      result: 'ok',
    });
    await text('src/app.ts', OTHER);
    await text('README.md');
    expect(rows('files.read')).toHaveLength(3);
    env.ctx.clock.advance(AUDIT_DEDUPE_MS);
    await text('src/app.ts');
    expect(rows('files.read')).toHaveLength(4);
  });

  it('files.raw and files.list the same way; stat and roots are not logged', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    for (let i = 0; i < 2; i++) {
      const r = await env.files.raw({ root: 'r.proj', path: 'a.png' }, PHONE);
      if (!('fh' in r)) throw new Error(r.refused);
      // The row waits for the route's bytes budget (settleRawRow).
      expect(rows('files.raw')).toHaveLength(i);
      settleRawRow(r.fh, true);
      await r.fh.close();
      await env.files.list({ root: 'r.proj', path: 'src', limit: 500, hidden: false }, PHONE);
      await env.files.stat({ root: 'r.proj', path: 'src/app.ts' }, PHONE);
      await env.files.roots(PHONE);
    }
    expect(rows('files.raw').map((r) => r.params)).toEqual([{ root: 'r.proj', rel: 'a.png', bytes: 8, kind: 'image' }]);
    expect(rows('files.list').map((r) => r.params)).toEqual([{ root: 'r.proj', rel: 'src', count: 1 }]);
    expect(rows().map((r) => r.action).sort()).toEqual(['files.list', 'files.raw']);
  });

  it('rows never carry file content', async () => {
    env = fpEnv({ homeRoot: true });
    env.write(join(env.proj, 'marker.txt'), `${SECRET_MARKER}\n`);
    await text('marker.txt');
    for (const p of ['.env', 'keys/id_rsa', '.git/config']) await text(p);
    await env.files.text({ root: 'r.home', path: '.ssh/id_rsa', offset: 0, max: 4096 }, PHONE);
    expect(rows().length).toBeGreaterThan(4);
    expect(JSON.stringify(rows())).not.toContain(SECRET_MARKER);
  });
});

describe('denied rows', () => {
  it('every refusal but missing is logged with root, rel and reason', async () => {
    env = fpEnv();
    await text('.env');
    await text('../x');
    await text('src');
    await text('gone.ts');
    await env.files.text({ root: 'r.nope', path: 'a', offset: 0, max: 1 }, PHONE);
    expect(rows('files.denied').map((r) => [r.params, r.result])).toEqual([
      [{ root: 'r.proj', rel: '.env', reason: 'protected' }, 'refused'],
      [{ root: 'r.proj', rel: '../x', reason: 'bad_path' }, 'refused'],
      [{ root: 'r.proj', rel: 'src', reason: 'not_file' }, 'refused'],
      [{ root: 'r.nope', rel: 'a', reason: 'no_root' }, 'refused'],
    ]);
  });

  it('control characters in a refused path are masked and long paths clipped', async () => {
    env = fpEnv();
    await text('a\nb\u0000c');
    expect(rows('files.denied')[0]?.params).toMatchObject({ rel: 'a?b?c', reason: 'bad_path' });
    expect(auditPath('x'.repeat(1000))).toHaveLength(301);
  });

  it(`a noisy device gets at most ${DENIED_ROWS_PER_WINDOW} denied rows per 10 min, then one warning`, async () => {
    env = fpEnv();
    for (let i = 0; i < DENIED_ROWS_PER_WINDOW + 10; i++) await text(`../${i}`);
    expect(rows('files.denied')).toHaveLength(DENIED_ROWS_PER_WINDOW);
    expect(env.ctx.log.records.filter((r) => r.msg === 'files: denied rows dropped for a noisy device')).toHaveLength(1);
    await text('../x', OTHER);
    expect(rows('files.denied')).toHaveLength(DENIED_ROWS_PER_WINDOW + 1);
    env.ctx.clock.advance(AUDIT_DEDUPE_MS);
    await text('../y');
    expect(rows('files.denied')).toHaveLength(DENIED_ROWS_PER_WINDOW + 2);
  });
});

describe('F13: the probe alarm', () => {
  it('5 protected refusals in 10 min from one device raise one security push and one audit row', async () => {
    env = fpEnv();
    env.ctx.db.devices.insert({ id: 'dev-phone', name: 'Kitchen iPad', keyHash: 'k', scopes: ['read', 'control'], createdAt: env.ctx.clock.iso(), lastSeenAt: env.ctx.clock.iso() });
    for (let i = 0; i < PROBE_THRESHOLD - 1; i++) await text('.env');
    expect(env.pushed).toHaveLength(0);
    await text('server.pem');
    // The recording notifier keeps each notification as soon as it is sent.
    expect(env.pushed).toHaveLength(1);
    expect(env.pushed[0]).toMatchObject({
      kind: 'security',
      title: 'A device tried to open protected files',
      url: '/devices',
      tag: 'security:dev-phone',
    });
    expect(env.pushed[0]?.body).toContain('Kitchen iPad');
    expect(env.pushed[0]?.body).not.toContain('.env');
    expect(rows('files.alert')).toEqual([expect.objectContaining({ actor: 'device:dev-phone', params: { count: 5, windowMin: 10 }, result: 'refused' })]);
    expect(env.ctx.log.records.filter((r) => r.level === 'warn' && r.msg === 'a device tried to open protected files')).toHaveLength(1);
    // More refusals in the same window: no second push.
    for (let i = 0; i < 5; i++) await text('.env');
    expect(env.pushed).toHaveLength(1);
    expect(rows('files.alert')).toHaveLength(1);
  });

  it('outside refusals count too; other reasons, other devices and the CLI do not', async () => {
    env = fpEnv();
    env.link(join(env.home, 'notes.md'), join(env.proj, 'out'));
    for (let i = 0; i < 4; i++) await text('out');
    for (let i = 0; i < 4; i++) await text('../x');
    for (let i = 0; i < 4; i++) await text('src');
    await text('.env', OTHER);
    for (let i = 0; i < 10; i++) await text('.env', CLI);
    expect(env.pushed).toHaveLength(0);
    await text('.env');
    expect(env.pushed).toHaveLength(1);
  });

  it("refusals the folder browser and the start sheet met (files.denied) count with Files' own", async () => {
    env = fpEnv();
    for (let i = 0; i < PROBE_THRESHOLD - 1; i++) env.files.denied(PHONE, 'r.proj', `.ssh/${i}`, 'protected');
    env.files.denied(PHONE, 'r.proj', 'gone', 'missing');
    expect(env.pushed).toHaveLength(0);
    expect(rows('files.denied').map((r) => r.params)).toContainEqual({ root: 'r.proj', rel: '.ssh/0', reason: 'protected' });
    await text('.env');
    expect(env.pushed).toHaveLength(1);
  });

  it('refusals spread over more than 10 min never add up; after a window the alarm can ring again', async () => {
    env = fpEnv();
    for (let i = 0; i < 8; i++) {
      await text('.env');
      env.ctx.clock.advance(PROBE_WINDOW_MS / 4);
    }
    expect(env.pushed).toHaveLength(0);
    for (let i = 0; i < 5; i++) await text('.env');
    env.ctx.clock.advance(PROBE_WINDOW_MS);
    for (let i = 0; i < 5; i++) await text('.env');
    expect(env.pushed).toHaveLength(2);
  });

  it('locked on: pushed while notifications are muted; bodies:"generic" sends no names; a channel switched off gets nothing', async () => {
    env = fpEnv({ notify: { muted_until: '2099-01-01T00:00:00.000Z', bodies: 'generic' } });
    for (let i = 0; i < 5; i++) await text('.env');
    expect(env.pushed).toHaveLength(1);
    expect(env.pushed[0]?.body).toBe('');
    await env.ctx.settings.patch({ notify: { webpush: false } });
    env.ctx.clock.advance(PROBE_WINDOW_MS);
    for (let i = 0; i < 5; i++) await text('.env');
    expect(env.pushed).toHaveLength(1);
  });

  it('over HTTP: the push reaches a device that chose no security pushes (always pushed)', async () => {
    env = fpEnv();
    api = await makeApi({
      ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
      deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
    });
    const prober = await pairCookie(api, ['read', 'control'], 'Lost phone');
    const watcher = await pairCookie(api, ['read', 'control'], 'Mac browser');
    api.ctx.db.pushSubs.upsert({
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/watcher', keys: { p256dh: 'p', auth: 'a' } },
      deviceId: watcher.deviceId,
      kinds: ['done'],
      createdAt: api.ctx.clock.iso(),
    });
    for (const p of ['.env', '.env.local', '.npmrc', 'server.pem', 'keys%2Fid_rsa']) {
      const res = await api.tcp.inject({ method: 'GET', url: `/v1/files/text?root=r.proj&path=${p}`, headers: h(prober.cookie) });
      expect(res.statusCode).toBe(403);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(api.fakes.pushed).toHaveLength(1);
    const payload = JSON.parse(api.fakes.pushed[0]?.payload ?? '{}') as { kind: string; body: string };
    expect(payload.kind).toBe('security');
    expect(payload.body).toContain('Lost phone');
    expect(api.ctx.db.audit.list({ limit: 100 }).filter((r) => r.action === 'files.alert')).toHaveLength(1);
  });
});

describe('per-device request limit', () => {
  it(`the ${V03_LIMITS.files.limit + 1}th files request in 5 min from one device gets 429 with retry-after; other devices are not affected`, async () => {
    env = fpEnv();
    api = await makeApi({
      ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
      deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
    });
    const a = await pairCookie(api);
    const b = await pairCookie(api);
    const urls = ['/v1/files/roots', '/v1/files/list?root=r.proj', '/v1/files/stat?root=r.proj&path=README.md', '/v1/files/text?root=r.proj&path=README.md'];
    for (let i = 0; i < V03_LIMITS.files.limit; i++) {
      const res = await api.tcp.inject({ method: 'GET', url: urls[i % urls.length] as string, headers: h(a.cookie) });
      expect(res.statusCode, `request ${i}`).toBe(200);
    }
    const over = await api.tcp.inject({ method: 'GET', url: '/v1/files/raw?root=r.proj&path=a.png', headers: h(a.cookie) });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('rate_limited');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/files/roots', headers: h(b.cookie) })).statusCode).toBe(200);
    api.ctx.clock.advance(V03_LIMITS.files.windowMs);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/files/roots', headers: h(a.cookie) })).statusCode).toBe(200);
  }, 30_000);
});
