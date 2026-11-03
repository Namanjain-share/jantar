/**
 * v0.11 People, M12 and T9 (spec 9.7.2): push routing and content (P1).
 *
 * - Her pushes go only to her devices' `person_push_subs`, never Bea's and
 *   never his `push_subs`; his People pushes go only to `push_subs`.
 * - URLs are `/p…` for her and `/people…` for him.
 * - Every People push goes by Web Push only (sendLifePush): no other
 *   notifier is ever handed a person audience.
 * - Her lock screen (C36): `hide_all` strips titles and text.
 * - Mute is per person: her mute holds her pushes and not his, and his
 *   mute (notify.muted_until) never holds hers.
 * - After she leaves, her subscriptions are gone and nothing reaches them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification, Notifier } from '../../src/contracts.js';
import { sendLifePush } from '../../src/life/push.js';
import { OWNER_HOST, OWNER_ORIGIN, credHeaders, linkDevice, makeFixture, onHer, type Cred, type Fixture } from './isolation-fixture.js';

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
  f.api.fakes.pushed.length = 0;
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const EP = {
  asha: 'https://fcm.googleapis.com/fcm/send/asha-1',
  asha2: 'https://web.push.apple.com/asha-2',
  bea: 'https://fcm.googleapis.com/fcm/send/bea-1',
  sam: 'https://fcm.googleapis.com/fcm/send/sam-1',
};

async function subscribeHer(cred: Cred, endpoint: string): Promise<void> {
  const r = await onHer(f.api, 'POST', '/v1/p/push/subscribe', cred, { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  expect(r.statusCode, r.body).toBe(200);
}

async function subscribeHim(cred: Cred, endpoint: string): Promise<void> {
  const r = await f.api.tcp.inject({
    method: 'POST',
    url: '/v1/push/subscribe',
    headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(cred) },
    payload: { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } },
  });
  expect(r.statusCode, r.body).toBe(200);
}

const sent = () => f.api.fakes.pushed.map((p) => ({ endpoint: p.endpoint, ...(JSON.parse(p.payload) as { title: string; body: string; url?: string; kind: string }) }));
const to = (endpoint: string) => sent().filter((p) => p.endpoint === endpoint);

async function setup(): Promise<void> {
  await subscribeHer(f.asha.full, EP.asha);
  await subscribeHer(f.bea.full, EP.bea);
  await subscribeHim(f.owner.control, EP.sam);
}

describe('M12: who gets which push', () => {
  it("her pushes reach her devices only; his reach his only; never Bea's", async () => {
    await setup();
    // To her: a device linked, his revoke of one, his request for more.
    const second = await linkDevice(f.api, f.asha, 'Asha tablet');
    await subscribeHer({ ...second.cred, name: 'tablet' }, EP.asha2);
    await vi.waitFor(() => expect(to(EP.asha).length).toBeGreaterThan(0));
    f.api.fakes.pushed.length = 0;
    const rv = await f.api.tcp.inject({ method: 'DELETE', url: `/v1/people/${f.asha.id}/devices/${second.deviceId}`, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(f.owner.admin) } });
    expect(rv.statusCode).toBe(200);
    await vi.waitFor(() => expect(to(EP.asha)).toHaveLength(1));
    // The revoked tablet's subscription went with it.
    expect(to(EP.asha2)).toEqual([]);
    expect(to(EP.sam)).toEqual([]);
    expect(to(EP.bea)).toEqual([]);
    expect(to(EP.asha)[0]?.url).toMatch(/^\/p/);

    // To him: her narrowing and her pause.
    f.api.fakes.pushed.length = 0;
    expect((await onHer(f.api, 'POST', '/v1/p/agreement/narrow', f.asha.full, { see: { weight: false } })).statusCode).toBe(200);
    expect((await onHer(f.api, 'POST', '/v1/p/pause', f.asha.full, {})).statusCode).toBe(200);
    await vi.waitFor(() => expect(to(EP.sam)).toHaveLength(2));
    expect(to(EP.asha)).toEqual([]);
    expect(to(EP.bea)).toEqual([]);
    for (const p of to(EP.sam)) expect(p.url).toMatch(/^\/people/);
  });

  it('every People push goes by Web Push only: another notifier is never handed a person audience', async () => {
    const other: Notification[] = [];
    const mac: Notifier = { channel: 'mac', send: async (n) => (other.push(n), { delivered: 1, failed: 0 }) };
    const telegram: Notifier = { channel: 'telegram', send: async (n) => (other.push(n), { delivered: 1, failed: 0 }) };
    await subscribeHer(f.asha.full, EP.asha);
    await f.api.ctx.settings.patch({ notify: { mac: true, telegram: true } });
    const r = await sendLifePush(f.api.ctx, [mac, telegram, ...f.api.fakes.notifiers], { person: f.asha.id, kind: 'life', title: 'T', body: 'B', url: '/p', tag: 't' }, () => ({ lockScreen: 'all', muteUntil: null }));
    expect(r.delivered).toBe(1);
    expect(other).toEqual([]);
    expect(to(EP.asha)).toHaveLength(1);
  });

  it("her lock screen: hide_all strips the title and text; all shows them", async () => {
    await setup();
    expect((await onHer(f.api, 'PATCH', '/v1/p/prefs', f.asha.full, { lockScreen: 'hide_all' })).statusCode).toBe(200);
    const r = await onHer(f.api, 'POST', '/v1/p/push/test', f.asha.full);
    expect(r.json()).toEqual({ delivered: 1 });
    expect(to(EP.asha)[0]).toMatchObject({ title: 'Jantar', body: 'Something new in your space' });
    f.api.fakes.pushed.length = 0;
    expect((await onHer(f.api, 'PATCH', '/v1/p/prefs', f.asha.full, { lockScreen: 'all' })).statusCode).toBe(200);
    await onHer(f.api, 'POST', '/v1/p/push/test', f.asha.full);
    expect(to(EP.asha)[0]).toMatchObject({ title: 'Jantar', body: 'Notifications work.' });
  });

  it('mute is per person', async () => {
    await setup();
    const until = new Date(f.api.ctx.clock.now() + 3600_000).toISOString();
    expect((await onHer(f.api, 'PATCH', '/v1/p/prefs', f.asha.full, { muteUntil: until })).statusCode).toBe(200);
    expect((await onHer(f.api, 'POST', '/v1/p/push/test', f.asha.full)).json()).toEqual({ delivered: 0 });
    // Bea's pushes are hers to mute, not Asha's.
    expect((await onHer(f.api, 'POST', '/v1/p/push/test', f.bea.full)).json()).toEqual({ delivered: 1 });
    // His mute never holds hers.
    await f.api.ctx.settings.patch({ notify: { muted_until: until } });
    expect((await onHer(f.api, 'POST', '/v1/p/push/test', f.bea.full)).json()).toEqual({ delivered: 1 });
  });

  it('after she leaves, nothing reaches her old endpoints', async () => {
    await setup();
    expect((await onHer(f.api, 'POST', '/v1/p/leave', f.asha.full, { data: 'keep30', confirm: 'LEAVE' })).statusCode).toBe(200);
    // His "left" push went to him, and only to him.
    await vi.waitFor(() => expect(to(EP.sam)).toHaveLength(1));
    expect(to(EP.asha)).toEqual([]);
    expect(f.api.ctx.db.people.pushSubs.listFor(f.asha.id)).toEqual([]);
    f.api.fakes.pushed.length = 0;
    await sendLifePush(f.api.ctx, f.api.fakes.notifiers, { person: f.asha.id, kind: 'med', title: 'T', body: 'B', url: '/p', tag: 't' }, () => ({ lockScreen: 'all', muteUntil: null }));
    expect(sent()).toEqual([]);
  });

  it("a subscription of hers can't be dropped by Bea, nor a foreign push host stored", async () => {
    await setup();
    expect((await onHer(f.api, 'POST', '/v1/p/push/unsubscribe', f.bea.full, { endpoint: EP.asha })).statusCode).toBe(200);
    expect(f.api.ctx.db.people.pushSubs.listFor(f.asha.id).map((r) => r.endpoint)).toEqual([EP.asha]);
    const bad = await onHer(f.api, 'POST', '/v1/p/push/subscribe', f.asha.full, { subscription: { endpoint: 'https://evil.example.com/x', keys: { p256dh: 'p', auth: 'a' } } });
    expect(bad.statusCode).toBe(400);
  });
});
