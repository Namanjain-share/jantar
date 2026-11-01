/**
 * Life pushes (life/push.ts) and what a todo puts on the lock screen:
 *
 * - LN6: a Life push reaches the Web Push notifier only, never the mac or
 *   telegram ones, even with notify.mac and notify.telegram on.
 * - Only control-scope devices get one (minScope); a medicine ignores the
 *   mute, a reminder waits it out; notify.webpush off sends nothing (LN5,
 *   push part).
 * - LP4 (todo part): with notify.bodies generic no todo title is in the
 *   push (title, body, tag, url); short cuts it to 40 characters; a
 *   catch-up leads with "Missed at HH:MM".
 * - v0.5.3: a send that never left the Mac (no DNS) answers `offline`, so
 *   the scheduler waits for the network.
 * - withDeadline answers timedOut when the work outlasts it.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, todoBody } from '@jantar/fixtures';
import type { Scope } from '@jantar/protocol';
import type { LifePush, Notification, Notifier } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore, type TestContext, type TestLifeCore } from '../../src/core/testing.js';
import { WebPushNotifier } from '../../src/notify/webpush.js';
import { createLifeSend, lifeNotification, pushNotice, sendLifePush, withDeadline } from '../../src/life/push.js';
import { buildTodosModule } from '../../src/life/todos/module.js';
import { todoPush } from '../../src/life/todos/pings.js';
import { TEST_VAPID, makeFakes } from '../api/fakes.js';

const MIN = 60_000;
const PHONE = 'https://fcm.googleapis.com/fcm/send/phone';
const SCREEN = 'https://fcm.googleapis.com/fcm/send/screen';

let dir: string;
let ctx: TestContext;
let payloads: { endpoint: string; payload: Record<string, unknown> }[];
let webpush: WebPushNotifier;
let mac: Notifier & { got: Notification[] };
let telegram: Notifier & { got: Notification[] };

function recording(channel: 'mac' | 'telegram'): Notifier & { got: Notification[] } {
  const got: Notification[] = [];
  return {
    channel,
    got,
    send: async (n) => {
      got.push(n);
      return { delivered: 1, failed: 0 };
    },
  };
}

function addDevice(id: string, scopes: Scope[], endpoint: string) {
  ctx.db.devices.insert({ id, name: id, keyHash: `h-${id}`, scopes, createdAt: ctx.clock.iso(), lastSeenAt: ctx.clock.iso() });
  ctx.db.pushSubs.upsert({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, deviceId: id, createdAt: ctx.clock.iso(), kinds: ['permission'] });
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-life-push-')));
  ctx = createTestContext({ home: join(dir, 'state') });
  payloads = [];
  webpush = new WebPushNotifier(ctx, {
    vapid: TEST_VAPID,
    sender: async (sub, payload) => {
      payloads.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
    },
  });
  mac = recording('mac');
  telegram = recording('telegram');
  addDevice('phone', ['read', 'control'], PHONE);
  addDevice('screen', ['read'], SCREEN);
  await ctx.settings.patch({ notify: { mac: true, telegram: true, webpush: true } });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const medPush: LifePush = { kind: 'med', title: 'Medicine due', body: 'Tap to log · 08:00', url: '/today?dose=01JFZ8X8Y3T0V5G9WQK2M4N6PR@0800', tag: 'life:med:x' };
const todoPushOf: LifePush = { kind: 'life', title: 'Todo due', body: 'Tap to open · 11:00', url: '/todos?id=01JFZ8X8Y3T0V5G9WQK2M4N6PR', tag: 'life:todo:01JFZ8X8Y3T0V5G9WQK2M4N6PR' };

describe('sendLifePush', () => {
  it('LN6: Web Push only; the mac and telegram notifiers get nothing even when switched on', async () => {
    const r = await sendLifePush(ctx, [mac, webpush, telegram], medPush);
    expect(r).toEqual({ delivered: 1, failed: 0, muted: false });
    expect(mac.got).toEqual([]);
    expect(telegram.got).toEqual([]);
    const send = createLifeSend(ctx, [mac, telegram, webpush]);
    await send(todoPushOf);
    expect(mac.got).toEqual([]);
    expect(telegram.got).toEqual([]);
    expect(payloads).toHaveLength(2);
  });

  it('reaches control-scope devices only, whatever kinds they chose, with the push as built', async () => {
    await sendLifePush(ctx, [webpush], medPush);
    expect(payloads.map((p) => p.endpoint)).toEqual([PHONE]);
    expect(payloads[0]?.payload).toMatchObject({ kind: 'med', title: 'Medicine due', body: 'Tap to log · 08:00', url: medPush.url, tag: 'life:med:x', ts: ctx.clock.iso() });
    expect(lifeNotification(todoPushOf, 'T').minScope).toBe('control');
  });

  it('a medicine ignores the mute; a reminder waits it out', async () => {
    await ctx.settings.patch({ notify: { muted_until: ctx.clock.iso(ctx.clock.now() + 30 * MIN) } });
    expect(await sendLifePush(ctx, [webpush], medPush)).toMatchObject({ delivered: 1, muted: false });
    expect(await sendLifePush(ctx, [webpush], todoPushOf)).toEqual({ delivered: 0, failed: 0, muted: true });
    ctx.clock.advance(31 * MIN);
    expect(await sendLifePush(ctx, [webpush], todoPushOf)).toMatchObject({ delivered: 1, muted: false });
  });

  it('LN5 (push part): with notify.webpush off nothing goes out, to any notifier', async () => {
    await ctx.settings.patch({ notify: { webpush: false } });
    expect(await sendLifePush(ctx, [mac, webpush, telegram], medPush)).toEqual({ delivered: 0, failed: 0, muted: false });
    expect(payloads).toEqual([]);
    expect(mac.got).toEqual([]);
  });

  it('v0.5.3: passes on the failures where the push never left the Mac (offline)', async () => {
    const dark = new WebPushNotifier(ctx, {
      vapid: TEST_VAPID,
      sender: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND push.example.invalid'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' });
      },
    });
    expect(await sendLifePush(ctx, [dark], medPush)).toMatchObject({ delivered: 0, failed: 1, offline: 1 });
  });

  it('a notice never throws and says whether anything was delivered', async () => {
    const throwing = async () => {
      throw new Error('boom');
    };
    expect(await pushNotice(ctx, throwing, todoPushOf)).toBe(false);
    expect(await pushNotice(ctx, createLifeSend(ctx, [webpush]), todoPushOf)).toBe(true);
  });
});

describe('withDeadline', () => {
  it('passes the value when the work ends first', async () => {
    expect(await withDeadline(ctx.clock, Promise.resolve(7), 1000)).toEqual({ timedOut: false, value: 7 });
    expect(ctx.clock.pending()).toBe(0);
  });

  it('answers timedOut when the clock passes the deadline first', async () => {
    const out = withDeadline(ctx.clock, new Promise<number>(() => {}), 30_000);
    await ctx.clock.tick(29_999);
    let done = false;
    void out.then(() => (done = true));
    await ctx.clock.tick(0);
    expect(done).toBe(false);
    await ctx.clock.tick(1);
    expect(await out).toEqual({ timedOut: true });
  });
});

describe('LP4 (todo part): the lock screen', () => {
  const due = new Date('2026-10-30T05:30:00.000Z');
  const todo = { id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR', title: `Call the accountant about the quarterly filing deadline ${LIFE_MARKER}`, priority: 'normal' as const, createdAt: 'x', updatedAt: 'x' };

  it('generic: no title anywhere in the push', () => {
    for (const late of [false, true]) {
      const p = todoPush(todo, todo.id, due, late, 'Asia/Kolkata', 'generic');
      expect(JSON.stringify(p)).not.toContain(LIFE_MARKER);
      expect(JSON.stringify(p)).not.toContain('accountant');
      expect(p).toEqual({
        kind: 'life',
        title: 'Todo due',
        body: `${late ? 'Missed at 11:00 · ' : ''}Tap to open · 11:00`,
        url: `/todos?id=${todo.id}`,
        tag: `life:todo:${todo.id}`,
      });
    }
  });

  it('full: the title and the time; short: the first 40 characters', () => {
    expect(todoPush(todo, todo.id, due, false, 'Asia/Kolkata', 'full').body).toBe(`${todo.title} · 11:00`);
    const short = todoPush(todo, todo.id, due, false, 'Asia/Kolkata', 'short').body;
    expect(short).toBe('Call the accountant about the quarterly… · 11:00');
    expect(short).not.toContain(LIFE_MARKER);
    expect(todoPush(todo, todo.id, due, true, 'Asia/Kolkata', 'full').body).toBe(`Missed at 11:00 · ${todo.title} · 11:00`);
  });

  it("a deleted todo's push says nothing about it", () => {
    expect(todoPush(null, todo.id, due, false, 'UTC', 'full').body).toBe('Tap to open · 05:30');
  });

  describe("through the module's handler, by notify.bodies", () => {
    let core: TestLifeCore;
    afterEach(() => core.close());

    it('generic keeps the title off; full puts it on', async () => {
      core = createTestLifeCore({ tz: 'Asia/Kolkata', settings: { todos: true } });
      core.clock.set('2026-10-30T04:00:00.000Z');
      const f = makeFakes(ctx);
      const todos = buildTodosModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
      const made = todos.createTodo(todoBody({}, { marked: true, timed: { day: '2026-10-30', time: '11:00' } }), { kind: 'cli' });
      if (!made.ok) throw new Error(made.reason);
      const handler = core.scheduler.handlers.get('todo');
      const row = core.scheduler.row('todo', made.value.id);
      if (!handler || !row) throw new Error('no todo ping');
      await ctx.settings.patch({ notify: { bodies: 'generic' } });
      const generic = handler.push([row], new Date(row.nextAt as string), false);
      expect(JSON.stringify(generic)).not.toContain(LIFE_MARKER);
      await ctx.settings.patch({ notify: { bodies: 'full' } });
      expect(handler.push([row], new Date(row.nextAt as string), false).body).toContain(LIFE_MARKER);
    });
  });
});
