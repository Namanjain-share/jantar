/**
 * LG3: Life's switches and zone, the shelf's source paths and the kept
 * accounts change only at the Mac. A TCP `PATCH /v1/settings` touching
 * `life.`, `intel.` or `accounts.` is 403 even for an admin device, naming
 * the Mac command; the same patch over ctl.sock is applied. The shelf's
 * source paths are never shown over TCP (spec 1.6).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('LG3: v0.4 settings are Mac only', () => {
  const samples = {
    life: { medicines: true, timezone: 'Asia/Kolkata' },
    intel: { enabled: true, sources: ['/synthetic/home/bot/intel.jsonl'] },
    accounts: { kept: [3, 5] },
  };

  it('a TCP patch is refused for an admin device; ctl.sock applies it', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api, ['admin']);
    for (const [group, value] of Object.entries(samples)) {
      const res = await api.tcp.inject({ method: 'PATCH', url: '/v1/settings', headers: h(cookie), payload: { [group]: value } });
      expect(res.statusCode, group).toBe(403);
      expect(res.json().error.message).toBe(`${group} settings can only be changed on the Mac: jantar ${group}`);
    }
    expect(api.ctx.settings.get().life.medicines).toBe(false);
    expect(api.ctx.settings.get().accounts.kept).toEqual([]);
    for (const [group, value] of Object.entries(samples)) {
      expect((await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: { [group]: value } })).statusCode, group).toBe(200);
    }
    const s = api.ctx.settings.get();
    expect(s.life).toMatchObject({ medicines: true, timezone: 'Asia/Kolkata' });
    expect(s.intel.sources).toEqual(['/synthetic/home/bot/intel.jsonl']);
    expect(s.accounts.kept).toEqual([3, 5]);
  });

  it('an admin device can still read them (GET /v1/settings is admin-scoped, not Mac-only)', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api, ['admin']);
    const res = await api.tcp.inject({ method: 'GET', url: '/v1/settings', headers: h(cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.life.medicines).toBe(false);
  });

  it("no shelf source path ever reaches a device: TCP reads and patch replies show none; ctl.sock sees them", async () => {
    api = await makeApi();
    expect((await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: samples })).statusCode).toBe(200);
    const { cookie } = await pairCookie(api, ['admin']);
    const read = await api.tcp.inject({ method: 'GET', url: '/v1/settings', headers: h(cookie) });
    expect(read.json().settings.intel).toEqual({ read: false, speechLocale: 'en-IN', enabled: true, sources: [] });
    const patched = await api.tcp.inject({ method: 'PATCH', url: '/v1/settings', headers: h(cookie), payload: { notify: { webpush: true } } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().settings.intel.sources).toEqual([]);
    expect(read.body + patched.body).not.toContain('/synthetic/home');
    const local = await api.ctl.inject({ method: 'GET', url: '/v1/settings' });
    expect(local.json().settings.intel.sources).toEqual(['/synthetic/home/bot/intel.jsonl']);
    // The phone's copy never writes back over the Mac's list.
    expect(api.ctx.settings.get().intel.sources).toEqual(['/synthetic/home/bot/intel.jsonl']);
  });
});

describe('daemon.version carries life, intel and the accounts mode', () => {
  it('is emitted again when a Life or Intel switch changes, never with a per-module flag', async () => {
    const { ApiServerImpl } = await import('../../src/api/server.js');
    const { createTestContext } = await import('../../src/core/testing.js');
    const { depsOf, makeFakes } = await import('./fakes.js');
    const ctx = createTestContext({ accountsMode: 'single' });
    const srv = new ApiServerImpl(ctx, depsOf(makeFakes(ctx)), { port: 0, host: '127.0.0.1', ctlSocket: false, webDist: null });
    await srv.start();
    try {
      expect(ctx.store.getState().daemon).toMatchObject({ protocol: 3, accountsMode: 'single', features: { life: false, intel: false } });
      const before = ctx.store.seq;
      // Settings that are not switches change nothing on the wire.
      await ctx.settings.patch({ life: { timezone: 'UTC' } });
      expect(ctx.store.seq).toBe(before);
      await ctx.settings.patch({ life: { medicines: true } });
      expect(ctx.store.seq).toBe(before + 1);
      await ctx.settings.patch({ life: { food: true } });
      // Already on: a second module tells a read-only device nothing new.
      expect(ctx.store.seq).toBe(before + 1);
      await ctx.settings.patch({ intel: { enabled: true } });
      const daemon = ctx.store.getState().daemon;
      expect(daemon?.features).toMatchObject({ life: true, intel: true });
      expect(Object.keys(daemon?.features ?? {})).not.toContain('medicines');
    } finally {
      await srv.stop();
    }
  });
});
