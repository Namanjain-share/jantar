/**
 * v0.6 Fleet (lane L4): what a node sends its hub (node/feed.ts).
 *
 * - The snapshot: its own sessions, live cards, recent sends, launches and
 *   alerts, clipped, within the hub's 64-session and 32-card caps.
 * - The stream: snapshot first, then every event after it and none before;
 *   only the events the hub takes, clipped.
 * - The ledger: nothing about a session or card the hub was never told of
 *   (the hub would refuse and count it); a left-out session is told when a
 *   place frees.
 * - The budget: session.updated held and merged per session to stay under
 *   300 events in 10 s; a status change and other events go at once, in
 *   order; a node with 64 working sessions updating every second never
 *   trips the hub's 1013.
 */
import { describe, expect, it } from 'vitest';
import { FLEET_SECRET, NODE_IDS, nodeCard, nodeSession, oversizedNodeSnapshot } from '@jantar/fixtures';
import { DEFAULT_LAUNCH_FLAGS, type Alert, type DaemonEvent, type EventInput, type EventOf, type LaunchJob, type SendJob, type Session } from '@jantar/protocol';
import { NODE_LIMITS, NodeSnapshotSchema, type NodeSnapshot } from '@jantar/protocol/node-link';
import type { NodeLink } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { NodeRegistry } from '../../src/fleet/registry.js';
import { REPLY_TEXT_MAX } from '../../src/sources/transcripts/parse.js';
import { createNodeFeed, mergeUpdated, nodeSnapshot } from '../../src/node/feed.js';
import { hubContext, linkTo, settle, warnings } from '../fleet/helpers.js';

const T0 = '2026-01-15T10:00:00.000Z';

/** A synthetic server sid. */
const sidOf = (i: number): string => `7a1c0000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const cardOf = (i: number): string => `01JF1EETCARD${String(i).padStart(30, '0')}`;

/** Seconds after T0, as an ISO time. */
const at = (s: number): string => new Date(Date.parse(T0) + s * 1000).toISOString();

/** A NodeLink that records what the feed sends, with the clock time of each event. */
function recordingLink(clock: FakeClock) {
  const snaps: NodeSnapshot[] = [];
  const events: DaemonEvent[] = [];
  const times: number[] = [];
  const closers: ((code: number) => void)[] = [];
  const link: NodeLink = {
    sendSnapshot: (s) => void snaps.push(s),
    sendEvent: (e) => {
      events.push(e);
      times.push(clock.now());
    },
    onCall: () => {},
    onClose: (fn) => void closers.push(fn),
  };
  return { link, snaps, events, times, close: (code = 1006) => closers.forEach((fn) => fn(code)) };
}

function emit(ctx: TestContext, input: EventInput): void {
  ctx.store.emit(input);
}

function addSession(ctx: TestContext, s: Session): void {
  emit(ctx, { type: 'session.added', sid: s.sid, data: { session: s } });
}

/** The most events any 10 s window holds. */
function peak(times: number[]): number {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while ((times[hi] as number) - (times[lo] as number) >= 10_000) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

const sendJob = (id: string, sid: string, stage: SendJob['stage'], updatedAt: string): SendJob => ({
  id,
  sid,
  textHash: 'h',
  textLength: 4,
  stage,
  attempts: 1,
  createdAt: updatedAt,
  updatedAt,
});

const launchJob = (id: string, stage: LaunchJob['stage'], updatedAt: string): LaunchJob => ({
  id,
  createdAt: updatedAt,
  updatedAt,
  actor: 'device:hub.dev-1',
  rootId: 'r.code',
  folder: '/home/sam/code/api-server',
  display: '~/code/api-server',
  account: 0,
  accountSource: 'auto',
  requested: 'auto',
  flags: DEFAULT_LAUNCH_FLAGS,
  dangerous: false,
  name: 'fix-tests',
  sid: '7a1c0000-0000-4000-8000-000000000009',
  stage,
  steps: [],
});

describe('the snapshot', () => {
  it("holds the node's own sessions, live cards, recent jobs and alerts, its switches and accounts, clipped", () => {
    const ctx = createTestContext({ accountsMode: 'dirs' });
    const a = nodeSession({ sid: sidOf(1), lastReply: { text: `${FLEET_SECRET} ${'y'.repeat(20_000)}`, at: T0 } });
    const b = nodeSession({ sid: sidOf(2) });
    addSession(ctx, a);
    addSession(ctx, b);
    // A session that names another machine is never the node's to report.
    addSession(ctx, nodeSession({ sid: sidOf(3), node: NODE_IDS.build2 }));
    emit(ctx, { type: 'pending.opened', sid: a.sid, data: { pending: nodeCard({ sid: a.sid, id: cardOf(1) }) } });
    emit(ctx, { type: 'pending.opened', sid: a.sid, data: { pending: nodeCard({ sid: a.sid, id: cardOf(2) }) } });
    emit(ctx, { type: 'pending.opened', sid: b.sid, data: { pending: nodeCard({ sid: b.sid, id: cardOf(3) }) } });
    emit(ctx, { type: 'pending.resolved', sid: a.sid, data: { id: cardOf(2), state: 'decided', decidedBy: 'device:hub.dev-1' } });
    emit(ctx, { type: 'pending.resolved', sid: b.sid, data: { id: cardOf(3), state: 'closed' } });
    // 25 finished sends, the newest first, and one unfinished old one.
    for (let i = 0; i < 25; i++) emit(ctx, { type: 'send.progress', sid: a.sid, data: { job: sendJob(`job-${i}`, a.sid, 'proven', at(100 + i)) } });
    emit(ctx, { type: 'send.progress', sid: a.sid, data: { job: sendJob('job-old', a.sid, 'enter', at(1)) } });
    emit(ctx, { type: 'launch.progress', data: { job: launchJob('launch-0001', 'opening', at(5)) } });
    const alert: Alert = { id: 'alert-1', ts: T0, kind: 'error', sid: a.sid, label: 'error · api-server', what: 'API error' };
    emit(ctx, { type: 'alert.error', sid: a.sid, data: { alert } });
    emit(ctx, {
      type: 'usage.updated',
      data: {
        accounts: [{ id: 0, alias: 'claude', emailMasked: 's***@example.com', isDefaultLogin: true, disabled: false, held: false, usageStatus: 'ok', windows: [] }],
        activeAccount: 0,
        fetchedAt: T0,
        source: 'cli',
      },
    });

    const snap = nodeSnapshot(ctx, ctx.store.getState());
    expect(NodeSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(Object.keys(snap.sessions).sort()).toEqual([a.sid, b.sid]);
    expect(snap.sessions[a.sid]?.lastReply?.text).toHaveLength(REPLY_TEXT_MAX);
    // Open and decided cards (the decided one waits for its tool to run); closed ones are gone.
    expect(Object.keys(snap.pending).sort()).toEqual([cardOf(1), cardOf(2)]);
    expect(Object.keys(snap.sends)).toHaveLength(21);
    expect(snap.sends['job-old']?.stage).toBe('enter');
    expect(snap.sends['job-0']).toBeUndefined();
    expect(Object.keys(snap.launches)).toEqual(['launch-0001']);
    expect(snap.alerts.map((x) => x.id)).toEqual(['alert-1']);
    expect(snap.daemon.accountsMode).toBe('dirs');
    expect(Object.keys(snap.accounts)).toEqual(['0']);
    expect(snap.activeAccount).toBe(0);
    expect(snap.usage).toEqual({ fetchedAt: T0, source: 'cli' });
  });

  it('the oversized fixture goes out as the hub keeps it (8,000 characters of reply, {} of input)', () => {
    const ctx = createTestContext();
    const big = oversizedNodeSnapshot();
    for (const s of Object.values(big.sessions)) addSession(ctx, s);
    for (const p of Object.values(big.pending)) emit(ctx, { type: 'pending.opened', sid: p.sid, data: { pending: p } });
    const snap = nodeSnapshot(ctx, ctx.store.getState());
    const s = Object.values(snap.sessions)[0];
    expect(s?.lastReply?.text).toHaveLength(REPLY_TEXT_MAX);
    expect(Object.values(snap.pending)[0]?.input).toEqual({});
    expect(Buffer.byteLength(JSON.stringify(snap))).toBeLessThan(NODE_LIMITS.frameBytes);
  });

  it("stays within the hub's caps: the 64 most recently changed sessions and 32 live cards of theirs", () => {
    const ctx = createTestContext();
    for (let i = 1; i <= 70; i++) addSession(ctx, nodeSession({ sid: sidOf(i), statusSince: at(i) }));
    // A card on the oldest session (left out), then 40 on kept ones.
    emit(ctx, { type: 'pending.opened', sid: sidOf(1), data: { pending: nodeCard({ sid: sidOf(1), id: cardOf(100) }) } });
    for (let i = 1; i <= 40; i++) {
      emit(ctx, { type: 'pending.opened', sid: sidOf(70), data: { pending: nodeCard({ sid: sidOf(70), id: cardOf(i), createdAt: at(i) }) } });
    }
    const snap = nodeSnapshot(ctx, ctx.store.getState());
    expect(Object.keys(snap.sessions)).toHaveLength(NODE_LIMITS.sessions);
    expect(snap.sessions[sidOf(70)]).toBeDefined();
    expect(snap.sessions[sidOf(7)]).toBeDefined();
    expect(snap.sessions[sidOf(6)]).toBeUndefined();
    expect(Object.keys(snap.pending)).toHaveLength(NODE_LIMITS.openCards);
    expect(snap.pending[cardOf(100)]).toBeUndefined();
    // The oldest cards first: the newest wait, as Claude asks them in order.
    expect(snap.pending[cardOf(1)]).toBeDefined();
    expect(snap.pending[cardOf(33)]).toBeUndefined();
  });
});

describe('the stream', () => {
  it('the snapshot first, then every event after it and none before; only what the hub takes, clipped', () => {
    const ctx = createTestContext();
    addSession(ctx, nodeSession({ sid: sidOf(1) }));
    const rec = recordingLink(ctx.clock);
    createNodeFeed(ctx).attach(rec.link);
    expect(rec.snaps).toHaveLength(1);
    expect(rec.events).toEqual([]);
    emit(ctx, { type: 'session.updated', sid: sidOf(1), data: { patch: { lastReply: { text: 'z'.repeat(50_000), at: T0 } } } });
    emit(ctx, { type: 'life.changed', data: {} });
    emit(ctx, { type: 'session.reminder', sid: sidOf(1), data: { afterMin: 5, waitingSince: T0 } });
    emit(ctx, { type: 'session.done', sid: sidOf(1), data: {} });
    expect(rec.events.map((e) => e.type)).toEqual(['session.updated', 'session.done']);
    const patch = (rec.events[0] as EventOf<'session.updated'>).data.patch;
    expect(patch.lastReply?.text).toHaveLength(REPLY_TEXT_MAX);
  });

  it('the link closing detaches it: nothing more is sent and no timer is left', () => {
    const ctx = createTestContext();
    for (let i = 1; i <= 64; i++) addSession(ctx, nodeSession({ sid: sidOf(i) }));
    const rec = recordingLink(ctx.clock);
    createNodeFeed(ctx).attach(rec.link);
    for (let n = 0; n < 5; n++) for (let i = 1; i <= 64; i++) emit(ctx, { type: 'session.updated', sid: sidOf(i), data: { patch: { subagentsRunning: n } } });
    expect(ctx.clock.pending()).toBe(1);
    rec.close();
    const sent = rec.events.length;
    emit(ctx, { type: 'session.done', sid: sidOf(1), data: {} });
    ctx.clock.advance(60_000);
    expect(rec.events).toHaveLength(sent);
    expect(ctx.clock.pending()).toBe(0);
  });
});

describe('the ledger: nothing about what the hub was never told', () => {
  it('a session over the cap is left out with all its events, and told as it stands once a place frees', () => {
    const ctx = createTestContext();
    for (let i = 1; i <= 64; i++) addSession(ctx, nodeSession({ sid: sidOf(i), statusSince: at(i) }));
    const rec = recordingLink(ctx.clock);
    createNodeFeed(ctx).attach(rec.link);
    const extra = nodeSession({ sid: sidOf(65), statusSince: at(65) });
    addSession(ctx, extra);
    emit(ctx, { type: 'session.updated', sid: extra.sid, data: { patch: { subagentsRunning: 1 } } });
    emit(ctx, { type: 'pending.opened', sid: extra.sid, data: { pending: nodeCard({ sid: extra.sid, id: cardOf(1) }) } });
    emit(ctx, { type: 'send.progress', sid: extra.sid, data: { job: sendJob('job-x', extra.sid, 'typed', T0) } });
    emit(ctx, { type: 'session.done', sid: extra.sid, data: {} });
    expect(rec.events).toEqual([]);

    // A place frees: the next word about the left-out session tells it whole, the patch included.
    emit(ctx, { type: 'session.removed', sid: sidOf(1), data: { reason: 'ended' } });
    emit(ctx, { type: 'session.updated', sid: extra.sid, data: { patch: { subagentsRunning: 2 } } });
    expect(rec.events.map((e) => e.type)).toEqual(['session.removed', 'session.added']);
    const added = (rec.events[1] as EventOf<'session.added'>).data.session;
    expect(added).toMatchObject({ sid: extra.sid, subagentsRunning: 2 });
    // Its card opened before it was told is not the hub's to resolve; a new one is.
    emit(ctx, { type: 'pending.resolved', sid: extra.sid, data: { id: cardOf(1), state: 'closed' } });
    emit(ctx, { type: 'pending.opened', sid: extra.sid, data: { pending: nodeCard({ sid: extra.sid, id: cardOf(2) }) } });
    expect(rec.events.map((e) => e.type)).toEqual(['session.removed', 'session.added', 'pending.opened']);
  });

  it('cards: at most 32 live; a decided card stays known until its tool runs; a removed session takes its cards along', () => {
    const ctx = createTestContext();
    addSession(ctx, nodeSession({ sid: sidOf(1) }));
    const rec = recordingLink(ctx.clock);
    createNodeFeed(ctx).attach(rec.link);
    for (let i = 1; i <= 33; i++) emit(ctx, { type: 'pending.opened', sid: sidOf(1), data: { pending: nodeCard({ sid: sidOf(1), id: cardOf(i) }) } });
    expect(rec.events.filter((e) => e.type === 'pending.opened')).toHaveLength(NODE_LIMITS.openCards);
    // The 33rd was never told: its resolution is not sent.
    emit(ctx, { type: 'pending.resolved', sid: sidOf(1), data: { id: cardOf(33), state: 'closed' } });
    expect(rec.events).toHaveLength(32);
    emit(ctx, { type: 'pending.resolved', sid: sidOf(1), data: { id: cardOf(1), state: 'decided', decidedBy: 'device:hub.dev-1' } });
    emit(ctx, { type: 'pending.resolved', sid: sidOf(1), data: { id: cardOf(1), state: 'confirmed' } });
    expect(rec.events.slice(32).map((e) => (e as EventOf<'pending.resolved'>).data.state)).toEqual(['decided', 'confirmed']);
    // A place freed: a new card goes.
    emit(ctx, { type: 'pending.opened', sid: sidOf(1), data: { pending: nodeCard({ sid: sidOf(1), id: cardOf(40) }) } });
    expect(rec.events.at(-1)?.type).toBe('pending.opened');
    emit(ctx, { type: 'session.removed', sid: sidOf(1), data: { reason: 'ended' } });
    emit(ctx, { type: 'pending.resolved', sid: sidOf(1), data: { id: cardOf(2), state: 'closed' } });
    expect(rec.events.at(-1)?.type).toBe('session.removed');
  });
});

describe('the budget: under 300 events in 10 s', () => {
  it('mergeUpdated: later values win, unset lists join, a key set again is no longer unset', () => {
    const e = (patch: Partial<Session>, unset?: (keyof Session)[]): EventOf<'session.updated'> =>
      ({ seq: 1, ts: T0, type: 'session.updated', sid: sidOf(1), data: { patch, ...(unset ? { unset } : {}) } }) as EventOf<'session.updated'>;
    const m = mergeUpdated(e({ subagentsRunning: 1, mode: 'plan' }, ['away']), e({ subagentsRunning: 2, away: 'back' }, ['mode']));
    expect(m.data).toEqual({ patch: { subagentsRunning: 2, away: 'back' }, unset: ['mode'] });
  });

  it('holds and merges patches per session when short; a status change goes at once with its held patch, in order', () => {
    const ctx = createTestContext();
    for (let i = 1; i <= 64; i++) addSession(ctx, nodeSession({ sid: sidOf(i) }));
    const rec = recordingLink(ctx.clock);
    createNodeFeed(ctx).attach(rec.link);
    for (let n = 1; n <= 10; n++) for (let i = 1; i <= 64; i++) emit(ctx, { type: 'session.updated', sid: sidOf(i), data: { patch: { subagentsRunning: n } } });
    const sentNow = rec.events.length;
    expect(sentNow).toBe(NODE_LIMITS.eventsPer10s - 60);
    // Session 64's patches are held, merged into one; its status change takes it along, once.
    emit(ctx, { type: 'session.updated', sid: sidOf(64), data: { patch: { status: 'idle' } } });
    const last = rec.events.at(-1) as EventOf<'session.updated'>;
    expect(rec.events).toHaveLength(sentNow + 1);
    expect(last.data.patch).toEqual({ subagentsRunning: 10, status: 'idle' });
    // Other events go at once; a held patch of the same session just before.
    emit(ctx, { type: 'session.done', sid: sidOf(63), data: {} });
    expect(rec.events.slice(-2).map((e) => e.type)).toEqual(['session.updated', 'session.done']);
    expect((rec.events.at(-2) as EventOf<'session.updated'>).data.patch).toEqual({ subagentsRunning: 10 });
    // The rest go out as the window frees, each session's latest values, never over budget.
    ctx.clock.advance(15_000);
    const bySid = new Map<string, number>();
    for (const e of rec.events) if (e.type === 'session.updated' && e.data.patch.subagentsRunning !== undefined) bySid.set(e.sid as string, e.data.patch.subagentsRunning);
    expect(bySid.size).toBe(64);
    expect([...bySid.values()].every((v) => v === 10)).toBe(true);
    expect(peak(rec.times)).toBeLessThanOrEqual(NODE_LIMITS.eventsPer10s);
    expect(ctx.clock.pending()).toBe(0);
  });

  it("64 working sessions updating every second for a minute: the hub keeps up and never closes 1013", async () => {
    const clock = new FakeClock(T0);
    const node = createTestContext({ clock });
    for (let i = 1; i <= 64; i++) addSession(node, nodeSession({ sid: sidOf(i) }));
    const hub = hubContext({ clock });
    const reg = new NodeRegistry(hub);
    const pair = linkTo(reg, NODE_IDS.build1);
    const times: number[] = [];
    const counted: NodeLink = { ...pair.node, sendEvent: (e) => (times.push(clock.now()), pair.node.sendEvent(e)) };
    createNodeFeed(node).attach(counted);
    await settle();
    for (let t = 1; t <= 60; t++) {
      for (let i = 1; i <= 64; i++) emit(node, { type: 'session.updated', sid: sidOf(i), data: { patch: { subagentsRunning: t } } });
      clock.advance(1_000);
      await settle();
    }
    clock.advance(15_000);
    await settle();
    expect(warnings(hub)).toEqual([]);
    expect(pair.open).toBe(true);
    expect(peak(times)).toBeLessThanOrEqual(NODE_LIMITS.eventsPer10s);
    expect(times.length).toBeLessThan(64 * 60);
    // Nothing lost: the hub holds each session's last value.
    const onHub = Object.values(hub.store.getState().sessions).filter((s) => s.node === NODE_IDS.build1);
    expect(onHub).toHaveLength(64);
    expect(onHub.every((s) => s.subagentsRunning === 60)).toBe(true);
  });
});
