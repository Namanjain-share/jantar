import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonEvent, SendJob } from '@jantar/protocol';
import type { Notification, Notifier } from '../../src/contracts.js';
import { createTestContext, fakePanes, type TestContext } from '../../src/core/testing.js';
import { NullTerminalBackend } from '../../src/modes.js';
import { NotificationRouterImpl, createNotificationRouter, type RoutedNotification } from '../../src/notify/index.js';
import { makeCard, makeSession } from '../api/fakes.js';

const MIN = 60_000;

class RecordingNotifier implements Notifier {
  readonly sent: RoutedNotification[] = [];
  constructor(readonly channel: Notifier['channel'] = 'webpush') {}
  async send(n: Notification) {
    this.sent.push(n as RoutedNotification);
    return { delivered: 1, failed: 0 };
  }
}

let ctx: TestContext;
let push: RecordingNotifier;
let router: NotificationRouterImpl;
let events: DaemonEvent[];

beforeEach(async () => {
  ctx = createTestContext();
  push = new RecordingNotifier();
  router = new NotificationRouterImpl(ctx, { notifiers: [push] });
  const s = makeSession();
  ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
  events = [];
  ctx.store.subscribe((ev) => events.push(ev));
  await router.start();
});

afterEach(async () => {
  await router.stop();
});

async function tick(ms: number) {
  ctx.clock.advance(ms);
  await router.whenIdle();
}

function openCard(over: Parameters<typeof makeCard>[0] = {}) {
  const card = makeCard({ createdAt: ctx.clock.iso(), settleUntil: ctx.clock.iso(ctx.clock.now() + 3000), ...over });
  ctx.store.emit({ type: 'pending.opened', sid: card.sid, data: { pending: card } });
  return card;
}

function resolve(id: string, state: 'decided' | 'closed' | 'handled-in-terminal' = 'closed') {
  ctx.store.emit({ type: 'pending.resolved', sid: 'sess-aaaa-1111', data: { id, state } });
}

describe('cards', () => {
  it('pushes a permission card only after the 3 s settle window', async () => {
    const card = openCard();
    await tick(2999);
    expect(push.sent).toHaveLength(0);
    await tick(1);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toMatchObject({ kind: 'permission', title: 'demo-app needs you', body: 'Permission · Bash: npm test', pendingId: card.id });
  });

  it('does not push a card that closed inside the settle window (auto-approved)', async () => {
    const card = openCard();
    await tick(1500);
    resolve(card.id);
    await tick(5000);
    expect(push.sent).toHaveLength(0);
  });

  it('settles permission cards for at least notify.settle_ms even if settleUntil is earlier', async () => {
    await ctx.settings.patch({ notify: { settle_ms: 5000 } });
    openCard({ settleUntil: ctx.clock.iso() });
    await tick(4999);
    expect(push.sent).toHaveLength(0);
    await tick(1);
    expect(push.sent).toHaveLength(1);
  });

  it('questions and plans push once their settleUntil passes; subagent info never pushes', async () => {
    openCard({ kind: 'question', tool: 'AskUserQuestion', input: {}, questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }], settleUntil: ctx.clock.iso() });
    await router.whenIdle();
    expect(push.sent.map((n) => n.kind)).toEqual(['question']);
    openCard({ kind: 'subagent-info', agentId: 'agent-1', settleUntil: ctx.clock.iso() });
    await tick(60 * MIN);
    expect(push.sent.filter((n) => n.title.startsWith('Subagent'))).toHaveLength(0);
  });
});

describe('kinds, mute and channels', () => {
  it('default kinds are permission, question, plan and send-failed (Done is opt-in)', async () => {
    ctx.store.emit({ type: 'session.done', sid: 'sess-aaaa-1111', data: { lastReply: { text: 'All green.', at: ctx.clock.iso() } } });
    await router.whenIdle();
    expect(push.sent).toHaveLength(0);
    await ctx.settings.patch({ notify: { kinds: ['done'] } });
    ctx.store.emit({ type: 'session.done', sid: 'sess-aaaa-1111', data: { lastReply: { text: 'All green.', at: ctx.clock.iso() } } });
    await router.whenIdle();
    expect(push.sent[0]).toMatchObject({ kind: 'done', title: 'demo-app finished', body: 'All green.', tag: 's:sess-aaaa-1111' });
  });

  it('mute holds everything except failed sends, which go out at once and only once', async () => {
    await ctx.settings.patch({ notify: { muted_until: ctx.clock.iso(ctx.clock.now() + 30 * MIN) } });
    const muted = openCard();
    await tick(10 * MIN);
    expect(push.sent).toHaveLength(0); // neither the card nor its 10-min reminder
    resolve(muted.id);

    const job: SendJob = {
      id: 'job-1',
      sid: 'sess-aaaa-1111',
      textHash: 'h',
      textLength: 3,
      stage: 'failed',
      attempts: 12,
      reason: 'not proven by the transcript',
      createdAt: ctx.clock.iso(),
      updatedAt: ctx.clock.iso(),
    };
    ctx.store.emit({ type: 'send.progress', sid: job.sid, data: { job: { ...job, stage: 'enter' } } });
    ctx.store.emit({ type: 'send.progress', sid: job.sid, data: { job } });
    ctx.store.emit({ type: 'send.progress', sid: job.sid, data: { job } });
    await router.whenIdle();
    expect(push.sent.map((n) => n.title)).toEqual(['Not delivered to demo-app']);

    // The mute ends.
    await tick(20 * MIN);
    openCard();
    await tick(3000);
    expect(push.sent.map((n) => n.kind)).toEqual(['send-failed', 'permission']);
  });

  it('respects the per-channel switch', async () => {
    const mac = new RecordingNotifier('mac');
    const r2 = createNotificationRouter(ctx, { notifiers: [mac], terminal: new NullTerminalBackend(), panes: fakePanes() });
    await r2.start();
    openCard({ settleUntil: ctx.clock.iso() });
    await tick(3000);
    expect(mac.sent).toHaveLength(0); // notify.mac is off by default
    await r2.stop();
    await ctx.settings.patch({ notify: { webpush: false } });
    openCard();
    await tick(3000);
    expect(push.sent).toHaveLength(1); // only the first card, before webpush was switched off
  });

  it('maps alerts and usage thresholds when their kinds are on', async () => {
    await ctx.settings.patch({ notify: { kinds: ['blocked', 'limit', 'error', 'usage'] } });
    const alert = { id: 'a1', ts: ctx.clock.iso(), kind: 'limit' as const, sid: 'sess-aaaa-1111', label: 'x', what: 'usage limit reached' };
    ctx.store.emit({ type: 'alert.limit', sid: alert.sid, data: { alert } });
    ctx.store.emit({ type: 'alert.rejected', sid: alert.sid, data: { alert: { ...alert, id: 'a2', kind: 'rejected', what: 'rejected' } } });
    ctx.store.emit({ type: 'usage.threshold', account: 4, data: { window: 'seven_day', pct: 95.2, threshold: 95 } });
    await router.whenIdle();
    expect(push.sent.map((n) => `${n.kind}|${n.title}`)).toEqual([
      'limit|acct 02 hit its limit',
      'blocked|demo-app is blocked',
      'usage|acct 04 at 95% of 7d',
    ]);
  });
});

describe('push copy facts from state (web direction.md 5.8)', () => {
  it('says how long a turn ran, and which account a limit stops and who is on it', async () => {
    await ctx.settings.patch({ notify: { kinds: ['done', 'limit'] } });
    ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { status: 'working', statusSince: ctx.clock.iso() } } });
    ctx.clock.advance(7 * MIN);
    ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { status: 'idle', statusSince: ctx.clock.iso() } } });
    ctx.store.emit({ type: 'session.done', sid: 'sess-aaaa-1111', data: { lastReply: { text: 'All green.\nDetails follow.', at: ctx.clock.iso() } } });
    await router.whenIdle();
    expect(push.sent[0]).toMatchObject({ title: 'demo-app finished · 7m', body: 'All green.' });

    const resetsAt = ctx.clock.iso(ctx.clock.now() + 90 * MIN);
    ctx.store.emit({
      type: 'usage.updated',
      data: {
        accounts: [
          {
            id: 2,
            emailMasked: 'u***@e***.com',
            isDefaultLogin: false,
            disabled: false,
            held: false,
            usageStatus: 'ok',
            windows: [{ kind: 'five_hour', pct: 100, resetsAt }],
          },
        ],
        activeAccount: 2,
        fetchedAt: ctx.clock.iso(),
        source: 'cache',
      },
    });
    const alert = { id: 'a9', ts: ctx.clock.iso(), kind: 'limit' as const, sid: 'sess-aaaa-1111', account: 2, label: 'x', what: 'hit a limit' };
    ctx.store.emit({ type: 'alert.limit', sid: alert.sid, account: 2, data: { alert } });
    await router.whenIdle();
    expect(push.sent[1]).toMatchObject({ kind: 'limit', title: 'acct 02 hit its 5-hour limit', tag: 'acct:2', url: '/accounts' });
    expect(push.sent[1]?.body).toMatch(/^Resets \d\d:\d\d\. demo-app is paused\.$/);
  });
});

describe('waiting without a card (hook-less sessions)', () => {
  it('pushes after the settle delay, using waitingFor for the kind', async () => {
    ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { status: 'waiting', statusSince: ctx.clock.iso(), waitingFor: 'plan approval' } } });
    ctx.store.emit({ type: 'session.waiting', sid: 'sess-aaaa-1111', data: { waitingFor: 'plan approval' } });
    await tick(2999);
    expect(push.sent).toHaveLength(0);
    await tick(1);
    expect(push.sent.map((n) => `${n.kind}|${n.title}`)).toEqual(['plan|demo-app has a plan for you']);
  });

  it('a card arriving inside the settle window replaces the plain waiting push', async () => {
    ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { status: 'waiting', statusSince: ctx.clock.iso(), waitingFor: 'permission' } } });
    await tick(1000);
    openCard({ settleUntil: ctx.clock.iso() });
    await tick(5000);
    expect(push.sent.map((n) => n.kind)).toEqual(['permission']);
    expect(push.sent[0]?.pendingId).toBeTruthy();
  });

  it('no push if the session stopped waiting', async () => {
    ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { status: 'waiting', statusSince: ctx.clock.iso() } } });
    await tick(1000);
    ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { status: 'working', statusSince: ctx.clock.iso() } } });
    await tick(5000);
    expect(push.sent).toHaveLength(0);
  });
});

describe('reminders', () => {
  const reminders = () => events.filter((e) => e.type === 'session.reminder').map((e) => (e.type === 'session.reminder' ? e.data.afterMin : 0));

  it('emits session.reminder and pushes at 10 and 30 minutes while a card stays open', async () => {
    const card = openCard();
    await tick(3000);
    await tick(10 * MIN - 3000);
    expect(reminders()).toEqual([10]);
    const r = push.sent.at(-1);
    expect(r).toMatchObject({ kind: 'reminder', baseKind: 'permission', title: 'demo-app still needs you · 10m', pendingId: card.id });
    expect(r?.body).toBe('Permission · Bash: npm test');
    await tick(20 * MIN);
    expect(reminders()).toEqual([10, 30]);
    await tick(120 * MIN);
    expect(reminders()).toEqual([10, 30]);
    expect(push.sent.map((n) => n.kind)).toEqual(['permission', 'reminder', 'reminder']);
  });

  it('stops reminding once the card is answered', async () => {
    const card = openCard();
    await tick(15 * MIN);
    resolve(card.id, 'decided');
    await tick(60 * MIN);
    expect(reminders()).toEqual([10]);
    expect(ctx.clock.pending()).toBe(0);
  });

  it('does not repeat a reminder after a restart, and sends only the latest missed one', async () => {
    openCard();
    await tick(11 * MIN);
    expect(reminders()).toEqual([10]);
    await router.stop();

    // Restart at 12 min: the 10-min mark is remembered in the db.
    ctx.clock.advance(MIN);
    router = new NotificationRouterImpl(ctx, { notifiers: [push] });
    await router.start();
    await router.whenIdle();
    expect(reminders()).toEqual([10]);
    await tick(18 * MIN);
    expect(reminders()).toEqual([10, 30]);
  });

  it('a daemon that starts late sends only the latest overdue reminder', async () => {
    await router.stop();
    openCard({ createdAt: ctx.clock.iso(ctx.clock.now() - 35 * MIN), settleUntil: ctx.clock.iso(ctx.clock.now() - 35 * MIN) });
    router = new NotificationRouterImpl(ctx, { notifiers: [push] });
    await router.start();
    await router.whenIdle();
    expect(reminders()).toEqual([30]);
  });

  it('reminders follow notify.reminders_min ([] turns them off)', async () => {
    await ctx.settings.patch({ notify: { reminders_min: [] } });
    openCard();
    await tick(60 * MIN);
    expect(reminders()).toEqual([]);
    await ctx.settings.patch({ notify: { reminders_min: [5, 90] } });
    // 60 min in: the 5-min mark is overdue (sent once now), 90 is still ahead.
    await router.whenIdle();
    expect(reminders()).toEqual([5]);
    await tick(30 * MIN);
    expect(reminders()).toEqual([5, 90]);
  });

  it('LN3 (v0.4): mute never holds a medicine; it still holds a Life reminder', async () => {
    await ctx.settings.patch({ notify: { muted_until: ctx.clock.iso(ctx.clock.now() + 30 * MIN), kinds: ['med', 'life'] } });
    const n = (kind: 'med' | 'life'): RoutedNotification => ({ kind, title: 'Medicine due', body: 'Tap to log · 08:00', ts: ctx.clock.iso() });
    expect(router.allowed(n('med'))).toBe(true);
    expect(router.allowed(n('life'))).toBe(false);
    await ctx.settings.patch({ notify: { muted_until: null } });
    expect(router.allowed(n('life'))).toBe(true);
  });

  it('stop() clears every timer', async () => {
    openCard();
    ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { status: 'waiting', statusSince: ctx.clock.iso() } } });
    expect(ctx.clock.pending()).toBeGreaterThan(0);
    await router.stop();
    expect(ctx.clock.pending()).toBe(0);
  });
});
