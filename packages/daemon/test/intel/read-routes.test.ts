/**
 * The v0.8 Intel routes over the real pipeline (spec 2.4, 7, 11, 12): save
 * and read (a phone's is `via: phone`, ctl.sock's `via: cli`), the jobs,
 * Retry, Delete (captures only), a read item's thumbnails (raw JPEG, nosniff,
 * a sandbox CSP, private no-store) and the Mac-only status. Behind the
 * `intelRead` switch the routes answer 403 with the off sentence and no
 * handler runs. Audits hold the item id and counts, never a link or text.
 * No network: claude is a fake, and nothing here fetches a page.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INTEL_READ_REASONS, IntelJobsResponseSchema, IntelReadReplySchema, IntelReadStatusSchema, SettingsSchema } from '@jantar/protocol';
import { NO_SUCH_FRAME } from '../../src/api/routes/intel.js';
import type { FilesService } from '../../src/contracts.js';
import { createFakeExec } from '../../src/core/testing.js';
import { buildFilesService } from '../../src/files/service.js';
import { IntelShelfService } from '../../src/intel/service.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { TINY_JPEG } from './read-helpers.js';
import { ASSETS, NO_BROWSER, NO_NET, fakeClaude, until } from './read-env.js';

let api: TestApi;
let base: string;
let intel: IntelShelfService;
let files: FilesService;

afterEach(async () => {
  await intel?.stop();
  await files?.stop();
  await api?.close();
  rmSync(base, { recursive: true, force: true });
});

async function readApi(read = true): Promise<{ home: string }> {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-read-api-')));
  const home = join(base, 'home');
  mkdirSync(join(home, '.jantar'), { recursive: true });
  const settings = SettingsSchema.parse({ intel: { enabled: true, read } });
  api = await makeApi({
    ctx: { userHome: home, home: join(home, '.jantar'), settings, exec: createFakeExec(fakeClaude()), accountsMode: 'single' },
    deps: (ctx, fakes) => {
      ctx.paths.assetsDir = ASSETS;
      files = buildFilesService(ctx, { sessions: fakes.sessions, notifiers: [] });
      intel = new IntelShelfService(ctx, { files, usage: fakes.usage, ccwLegacy: fakes.ccwLegacy }, { watch: false, read: { net: NO_NET, browser: NO_BROWSER } });
      return { files, intel };
    },
  });
  await files.start();
  await intel.start();
  return { home };
}

const idle = () => until(() => intel.queue.counts().running === 0 && intel.queue.counts().waiting === 0, 8_000, 'the queue');

describe('save and read', () => {
  it('a phone saves (via phone), ctl.sock saves (via cli); the audit holds the id and counts only', async () => {
    await readApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const phone = await api.tcp.inject({ method: 'POST', url: '/v1/intel/reads', headers: h(cookie), payload: { text: 'A synthetic phone note', depth: 'light' } });
    expect(phone.statusCode).toBe(200);
    const p = IntelReadReplySchema.parse(phone.json());
    expect(p).toMatchObject({ duplicate: false, queued: true });
    const cli = await api.ctl.inject({ method: 'POST', url: '/v1/intel/reads', payload: { text: 'A synthetic cli note' } });
    const c = IntelReadReplySchema.parse(cli.json());
    await idle();
    await intel.refresh();
    expect(intel.get(p.id)?.fields).toContainEqual({ key: 'via', value: 'phone' });
    expect(intel.get(c.id)?.fields).toContainEqual({ key: 'via', value: 'cli' });
    const audit = JSON.stringify(api.ctx.db.audit.list());
    expect(audit).not.toContain('synthetic phone note');
    expect(audit).not.toContain('synthetic cli note');
    expect(api.ctx.db.audit.list().filter((a) => a.action === 'intel.read')).toHaveLength(2);
  });

  it('a strict body: an unknown key or an empty text is refused before the handler', async () => {
    await readApi();
    for (const payload of [{ text: 'x', via: 'cli' }, { text: '' }, { text: 'x', depth: 'deep' }]) {
      const r = await api.ctl.inject({ method: 'POST', url: '/v1/intel/reads', payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('reading off: save and Retry answer 403 with the off sentence; the jobs and Delete still answer', async () => {
    await readApi(false);
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const r = await api.tcp.inject({ method: 'POST', url: '/v1/intel/reads', headers: h(cookie), payload: { text: 'https://example.com/a' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: { message: INTEL_READ_REASONS.off } });
    const again = await api.tcp.inject({ method: 'POST', url: `/v1/intel/items/${encodeURIComponent('captures:01JC0000000000000000000000')}/read`, headers: h(cookie), payload: {} });
    expect(again.statusCode).toBe(403);
    const jobs = await api.tcp.inject({ method: 'GET', url: '/v1/intel/jobs', headers: h(cookie) });
    expect(IntelJobsResponseSchema.parse(jobs.json()).reading).toMatchObject({ on: false, canRun: false });
  });
});

describe('jobs, Retry, Delete, thumbnails, status', () => {
  it('the jobs reply fits its schema; Retry starts a new job; Delete removes a captures item and refuses another source', async () => {
    await readApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const saved = IntelReadReplySchema.parse((await api.ctl.inject({ method: 'POST', url: '/v1/intel/reads', payload: { text: 'A synthetic note' } })).json());
    await idle();
    const jobs = IntelJobsResponseSchema.parse((await api.tcp.inject({ method: 'GET', url: '/v1/intel/jobs', headers: h(cookie) })).json());
    expect(jobs.jobs.map((j) => [j.id, j.state])).toEqual([[saved.id, 'saved']]);
    const retry = await api.tcp.inject({ method: 'POST', url: `/v1/intel/items/${encodeURIComponent(saved.id)}/read`, headers: h(cookie), payload: { depth: 'full' } });
    expect(retry.json()).toEqual({ id: saved.id });
    await idle();
    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/intel/items/${encodeURIComponent(saved.id)}`, headers: h(cookie) });
    expect(del.json()).toEqual({ ok: true });
    expect(intel.get(saved.id)).toBeNull();
    const other = await api.tcp.inject({ method: 'DELETE', url: `/v1/intel/items/${encodeURIComponent('bot:abc')}`, headers: h(cookie) });
    expect(other.statusCode).toBe(403);
  });

  it('a thumbnail: raw JPEG with nosniff, a sandbox CSP and private no-store; none past the item\'s count', async () => {
    const { home } = await readApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const rid = '01JC0000000000000000000001';
    const intelDir = join(home, '.jantar', 'intel');
    mkdirSync(join(intelDir, 'media', rid), { recursive: true, mode: 0o700 });
    writeFileSync(join(intelDir, 'media', rid, '0.jpg'), TINY_JPEG, { mode: 0o600 });
    await intel.store.append([{ id: rid, captured_at: '2026-11-01T10:00:00.000Z', title: 'Example reel', url: 'https://www.instagram.com/reel/AbC123xyz/', platform: 'instagram', frames: 1 }]);
    await intel.refresh();
    const id = encodeURIComponent(`captures:${rid}`);
    const r = await api.tcp.inject({ method: 'GET', url: `/v1/intel/items/${id}/frames/0`, headers: h(cookie) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.rawPayload).toEqual(TINY_JPEG);
    const none = await api.tcp.inject({ method: 'GET', url: `/v1/intel/items/${id}/frames/1`, headers: h(cookie) });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ error: { message: NO_SUCH_FRAME } });
    // A file that is not a JPEG is never served.
    writeFileSync(join(intelDir, 'media', rid, '0.jpg'), '<svg onload=alert(1)>');
    expect((await api.tcp.inject({ method: 'GET', url: `/v1/intel/items/${id}/frames/0`, headers: h(cookie) })).statusCode).toBe(404);
  });

  it('the status is the Mac\'s alone (ctl.sock), and fits its schema', async () => {
    await readApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const tcp = await api.tcp.inject({ method: 'GET', url: '/v1/intel/read/status', headers: h(cookie) });
    expect(tcp.statusCode).toBeGreaterThanOrEqual(403);
    const ctl = await api.ctl.inject({ method: 'GET', url: '/v1/intel/read/status' });
    expect(ctl.statusCode).toBe(200);
    const s = IntelReadStatusSchema.parse(ctl.json());
    expect(s).toMatchObject({ on: true, canRun: true, sandbox: { found: false }, browser: { found: true }, ytdlp: { found: false }, queue: { waiting: 0, running: 0 } });
    expect(s.door.open).toBe(false);
  });
});
