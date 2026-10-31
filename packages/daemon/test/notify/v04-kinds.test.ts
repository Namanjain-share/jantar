/**
 * v0.4 notify kinds, through the sends that bypass the router
 * (notify/direct.ts), as life/push.ts makes them:
 *
 * - LN1: a `med` push reaches a device whose kinds list leaves `med` out,
 *   while `notify.muted_until` is in the future (ignoreMute).
 * - LN2: a `life` push is held while muted and goes out after; `notify.kinds`
 *   drops neither kind.
 * - LP5: both reach only devices with control scope (`minScope`): a
 *   read-scope device with a subscription gets none.
 * - LN5 (notify part): with `notify.webpush` off, no Life push goes out.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifyKind, Scope } from '@jantar/protocol';
import type { Notification, Notifier } from '../../src/contracts.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { ALWAYS_PUSHED, GENERIC_TITLE, KIND_WORD, WebPushNotifier, isMuted, sendDirect } from '../../src/notify/index.js';
import { TEST_VAPID } from '../api/fakes.js';

const MIN = 60_000;
let dir: string;
let ctx: TestContext;
let sentTo: string[];
let push: WebPushNotifier;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-v04-kinds-')));
  ctx = createTestContext({ home: join(dir, 'state') });
  sentTo = [];
  push = new WebPushNotifier(ctx, {
    vapid: TEST_VAPID,
    sender: async (sub) => {
      sentTo.push(sub.endpoint);
    },
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function addDevice(id: string, scopes: Scope[]) {
  ctx.db.devices.insert({ id, name: id, keyHash: `h-${id}`, scopes, createdAt: ctx.clock.iso(), lastSeenAt: ctx.clock.iso() });
}
function addSub(endpoint: string, deviceId: string, kinds?: NotifyKind[]) {
  ctx.db.pushSubs.upsert({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, deviceId, createdAt: ctx.clock.iso(), ...(kinds ? { kinds } : {}) });
}

const PHONE = 'https://fcm.googleapis.com/fcm/send/phone';
const SHARED_SCREEN = 'https://fcm.googleapis.com/fcm/send/screen';

function lifePush(kind: 'med' | 'life'): Notification {
  return { kind, title: kind === 'med' ? 'Medicine due' : 'Todo due', body: 'Tap to open · 08:00', url: '/today', tag: `life:${kind}:x`, ts: ctx.clock.iso(), minScope: 'control' };
}

describe('the med and life kinds', () => {
  beforeEach(() => {
    addDevice('phone', ['read', 'control']);
    // The phone chose permission cards only, before med and life existed.
    addSub(PHONE, 'phone', ['permission']);
    addDevice('screen', ['read']);
    addSub(SHARED_SCREEN, 'screen');
  });

  it('are pushed whatever kinds a device chose, urgently, with their own words', () => {
    expect(ALWAYS_PUSHED.has('med')).toBe(true);
    expect(ALWAYS_PUSHED.has('life')).toBe(true);
    expect(KIND_WORD.med).toBe('Medicine');
    expect(GENERIC_TITLE.med).toBe('Medicine due');
    expect(KIND_WORD.life).toBe('Reminder');
    expect(GENERIC_TITLE.life).toBe('Something is due');
  });

  it('LN1: a medicine reaches the phone while muted and outside its kinds list', async () => {
    await ctx.settings.patch({ notify: { muted_until: ctx.clock.iso(ctx.clock.now() + 60 * MIN), kinds: ['permission'] } });
    expect(isMuted(ctx.settings.get().notify, ctx.clock.now())).toBe(true);
    const r = await sendDirect(ctx, [push], lifePush('med'), { ignoreMute: true });
    expect(r).toEqual({ delivered: 1, failed: 0, muted: false });
    expect(sentTo).toEqual([PHONE]);
  });

  it('LN2: a reminder waits out the mute, then goes; notify.kinds drops neither kind', async () => {
    await ctx.settings.patch({ notify: { muted_until: ctx.clock.iso(ctx.clock.now() + 30 * MIN), kinds: ['permission'] } });
    expect(await sendDirect(ctx, [push], lifePush('life'))).toEqual({ delivered: 0, failed: 0, muted: true });
    expect(sentTo).toEqual([]);
    ctx.clock.advance(31 * MIN);
    expect(await sendDirect(ctx, [push], lifePush('life'))).toEqual({ delivered: 1, failed: 0, muted: false });
    expect(await sendDirect(ctx, [push], lifePush('med'))).toMatchObject({ delivered: 1 });
    expect(sentTo).toEqual([PHONE, PHONE]);
  });

  it('LP5: a read-only device with a subscription gets neither kind', async () => {
    await sendDirect(ctx, [push], lifePush('med'), { ignoreMute: true });
    await sendDirect(ctx, [push], lifePush('life'));
    expect(sentTo).not.toContain(SHARED_SCREEN);
    // Without minScope (a session's card, say) the read-only device still gets what it chose.
    await push.send({ kind: 'permission', title: 'A session needs you', body: '', ts: ctx.clock.iso() });
    expect(sentTo).toContain(SHARED_SCREEN);
  });

  it('LN5: with Web Push switched off at the Mac nothing goes out, medicine included', async () => {
    await ctx.settings.patch({ notify: { webpush: false } });
    expect(await sendDirect(ctx, [push], lifePush('med'), { ignoreMute: true })).toEqual({ delivered: 0, failed: 0, muted: false });
    expect(sentTo).toEqual([]);
  });

  it('only the notifiers handed in send: the mac and telegram channels follow their own switches', async () => {
    const got: string[] = [];
    const recorder = (channel: Notifier['channel']): Notifier => ({ channel, send: async (n) => (got.push(`${channel}:${n.kind}`), { delivered: 1, failed: 0 }) });
    await ctx.settings.patch({ notify: { mac: false, telegram: true } });
    await sendDirect(ctx, [recorder('mac'), recorder('telegram')], lifePush('life'));
    expect(got).toEqual(['telegram:life']);
  });

  it('a notifier that throws counts as one failure and the rest still send', async () => {
    const broken: Notifier = { channel: 'webpush', send: async () => Promise.reject(new Error('boom')) };
    const r = await sendDirect(ctx, [broken, push], lifePush('med'), { ignoreMute: true });
    expect(r).toEqual({ delivered: 1, failed: 1, muted: false });
    expect(JSON.stringify(ctx.log.records)).not.toContain('Medicine due');
  });
});
