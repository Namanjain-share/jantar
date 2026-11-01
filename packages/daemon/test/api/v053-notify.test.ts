/**
 * v0.5.3: POST /v1/notify/test (jantar notify test [group]) over ctl.sock.
 * TCP refuses it before any handler (S6: v053-contracts.test.ts).
 *
 * - Each group sends its kind: urgent and needs a permission (urgent with a
 *   deadline two minutes ahead, so the payload's group is urgent and its
 *   TTL 120 s), done a done, care a life push, problem a send-failed.
 * - It skips notify.kinds and the mute; notify.webpush off sends nothing.
 * - Each device's own kinds still apply (life always passes); care reaches
 *   control-scope devices only, like every Life push.
 * - Strict body; the audit row names the group.
 * - At most 10 a minute: it skips the mute, so a loop must not ring on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ALERT_GROUPS, type AlertGroup, type NotifyKind, type Scope } from '@jantar/protocol';
import { NOTIFY_TEST_LIMITED } from '../../src/api/routes/notify.js';
import { V053_LIMITS } from '../../src/api/services.js';
import type { FakeClock } from '../../src/core/clock.js';
import { makeApi, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const ALL = 'https://web.push.apple.com/all';
const PERMISSION_ONLY = 'https://web.push.apple.com/permission-only';
const READ_ONLY = 'https://web.push.apple.com/read-only';

function device(t: TestApi, id: string, endpoint: string, scopes: Scope[], kinds?: NotifyKind[]) {
  const at = t.ctx.clock.iso();
  t.ctx.db.devices.insert({ id, name: id, keyHash: `h-${id}`, scopes, createdAt: at, lastSeenAt: at });
  t.ctx.db.pushSubs.upsert({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, deviceId: id, createdAt: at, ...(kinds ? { kinds } : {}) });
}

async function setup(): Promise<TestApi> {
  const t = await makeApi();
  device(t, 'phone', ALL, ['read', 'control']);
  device(t, 'tablet', PERMISSION_ONLY, ['read', 'control'], ['permission']);
  device(t, 'screen', READ_ONLY, ['read']);
  return t;
}

const test = (t: TestApi, body: unknown) => t.ctl.inject({ method: 'POST', url: '/v1/notify/test', payload: body as object });

function pushed(t: TestApi) {
  return t.fakes.pushed.map((p) => ({ endpoint: p.endpoint, payload: JSON.parse(p.payload) as Record<string, unknown>, ttl: (p.options as { TTL: number }).TTL }));
}

describe('POST /v1/notify/test', () => {
  it("sends each group's kind; urgent carries a deadline two minutes ahead", async () => {
    api = await setup();
    const got: Record<string, unknown> = {};
    for (const group of ALERT_GROUPS) {
      api.fakes.pushed.length = 0;
      const res = await test(api, { group });
      expect(res.statusCode, group).toBe(200);
      const p = pushed(api);
      got[group] = { answer: res.json(), kinds: [...new Set(p.map((x) => `${String(x.payload.kind)}|${String(x.payload.group)}`))], to: p.map((x) => x.endpoint).sort() };
      for (const x of p) {
        expect(x.payload, group).toMatchObject({ title: 'Jantar test', url: '/', tag: `test:${group}` });
        expect(String(x.payload.body), group).toMatch(/^This is how ".+" alerts arrive\.$/);
      }
    }
    expect(got).toEqual({
      // The read-only screen gets what it chose (all kinds): only Life is control-scope.
      urgent: { answer: { delivered: 3, failed: 0 }, kinds: ['permission|urgent'], to: [ALL, PERMISSION_ONLY, READ_ONLY] },
      needs: { answer: { delivered: 3, failed: 0 }, kinds: ['permission|needs'], to: [ALL, PERMISSION_ONLY, READ_ONLY] },
      // The tablet turned Done off: no Done test for it.
      done: { answer: { delivered: 2, failed: 0 }, kinds: ['done|done'], to: [ALL, READ_ONLY] },
      // Life passes every device's kinds, and reaches control-scope devices only.
      care: { answer: { delivered: 2, failed: 0 }, kinds: ['life|care'], to: [ALL, PERMISSION_ONLY] },
      problem: { answer: { delivered: 2, failed: 0 }, kinds: ['send-failed|problem'], to: [ALL, READ_ONLY] },
    });
    api.fakes.pushed.length = 0;
    await test(api, { group: 'urgent' });
    const u = pushed(api)[0];
    expect(u?.payload.deadline).toBe(api.ctx.clock.iso(api.ctx.clock.now() + 120_000));
    expect(u?.ttl).toBe(120);
  });

  it('skips notify.kinds and the mute; notify.webpush off sends nothing', async () => {
    api = await setup();
    await api.ctx.settings.patch({ notify: { kinds: ['question'], muted_until: api.ctx.clock.iso(api.ctx.clock.now() + 60 * 60_000) } });
    for (const group of ['needs', 'done'] satisfies AlertGroup[]) {
      const res = await test(api, { group });
      expect(res.json().delivered, group).toBeGreaterThan(0);
    }
    api.fakes.pushed.length = 0;
    await api.ctx.settings.patch({ notify: { webpush: false } });
    const off = await test(api, { group: 'needs' });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ delivered: 0, failed: 0 });
    expect(api.fakes.pushed).toEqual([]);
  });

  it('answers 0 delivered with no device, and refuses a body that is not exactly { group }', async () => {
    api = await makeApi();
    expect((await test(api, { group: 'needs' })).json()).toEqual({ delivered: 0, failed: 0 });
    for (const body of [{}, { group: 'loud' }, { group: 'needs', title: 'x' }, { group: 'NEEDS' }]) {
      const res = await test(api, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('10 a minute, then 429 with the sentence and nothing sent; a minute later it sends again', async () => {
    api = await setup();
    expect(V053_LIMITS.notifyTest).toEqual({ limit: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) expect((await test(api, { group: 'needs' })).statusCode, String(i)).toBe(200);
    api.fakes.pushed.length = 0;
    const over = await test(api, { group: 'needs' });
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toEqual({ code: 'rate_limited', message: NOTIFY_TEST_LIMITED });
    expect(NOTIFY_TEST_LIMITED).toBe('10 test pushes this minute. Try again in a moment.');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(api.fakes.pushed).toEqual([]);
    (api.ctx.clock as FakeClock).advance(60_001);
    expect((await test(api, { group: 'needs' })).statusCode).toBe(200);
    expect(api.fakes.pushed.length).toBeGreaterThan(0);
  });

  it("the audit row names the group and the Mac's CLI, nothing else", async () => {
    api = await setup();
    await test(api, { group: 'done' });
    const row = api.ctx.db.audit.list().find((e) => e.action === 'notifyTest');
    expect(row).toMatchObject({ actor: 'cli', action: 'notifyTest', target: 'done', result: 'ok' });
    expect(JSON.stringify(row)).not.toContain('alerts arrive');
  });
});
