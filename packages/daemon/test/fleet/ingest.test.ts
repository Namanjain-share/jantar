/**
 * v0.6 Fleet (lane L4): a node's snapshot and events into the hub's state,
 * on memoryLinkPair through the registry.
 *
 * - S1: a node reports only its own sessions, cards, sends, launches and
 *   alerts; events about the Mac's or another node's are dropped, the state
 *   unchanged, and not counted (logged once per id: a server joined again
 *   under a new name shares ids with its old pairing and must not loop on
 *   4400); the 21st refusal in a minute closes 4400 with one log line that
 *   names the node, the type and the reason, never the payload.
 * - S13 (registry side): 64 sessions, 32 open cards, the 4 MiB state budget,
 *   300 events in 10 s and 4 MiB of them re-emitted in 10 s (1013), events
 *   before the snapshot wait for it.
 * - S17: a URL in a node's text makes the hub fetch nothing.
 * - S19: 1 MiB of reply arrives as 8,000 characters, a 1 MiB card input as {}.
 * - F17: an unknown event type is dropped and not counted; a known type with
 *   a bad payload is counted.
 * - The snapshot diff: only what changed; a card the hub has is never
 *   re-opened (or pushed) after a dropped link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_SECRET,
  linuxNodeSnapshot,
  nodeCard,
  nodeEvents,
  nodeSession,
  nodeWireEvent,
  oversizedNodeSnapshot,
  windowsNodeSnapshot,
} from '@jantar/fixtures';
import { DEFAULT_LAUNCH_FLAGS, type DaemonEvent, type LaunchJob, type PendingRequest, type Session } from '@jantar/protocol';
import { NODE_CLOSE, NODE_LIMITS, type NodeSnapshot } from '@jantar/protocol/node-link';
import type { TestContext } from '../../src/core/testing.js';
import { EVENT_BYTES_PER_10S, jsonBytes } from '../../src/fleet/clip.js';
import { ingestEvent } from '../../src/fleet/ingest.js';
import { NodeRegistry } from '../../src/fleet/registry.js';
import { REPLY_TEXT_MAX } from '../../src/sources/transcripts/parse.js';
import { MAC_CARD, MAC_SID, NODE_IDS, hubContext, linkTo, record, settle, warnings } from './helpers.js';

const S1 = '7a1c0000-0000-4000-8000-000000000001';
const S2 = '7a1c0000-0000-4000-8000-000000000002';
const S3 = '7a1c0000-0000-4000-8000-000000000003';
const CARD = '01JF1EETCARD000000000000AAbbCCddEEffGGhh00';

let ctx: TestContext;
let reg: NodeRegistry;
beforeEach(() => {
  ctx = hubContext();
  reg = new NodeRegistry(ctx);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** build-1 linked with the Linux fixture's snapshot (3 sessions, one card). */
async function linked(snap: NodeSnapshot = linuxNodeSnapshot(), nodeId: string = NODE_IDS.build1) {
  const pair = linkTo(reg, nodeId);
  pair.node.sendSnapshot(snap);
  await settle();
  return pair;
}

const stateOf = () => ctx.store.getState();

/** A card as large as clipping lets it stay (about 140 KB): 30 of them are over the 4 MiB budget. */
function fatCard(sid: string, i: number): PendingRequest {
  return nodeCard({
    sid,
    id: `01JF1EETCARDFAT${String(i).padStart(11, '0')}AAbbCCddEEffGG`,
    input: { parts: Array.from({ length: 8 }, () => 'x'.repeat(7990)) },
    suggestions: [{ a: 'y'.repeat(7990) }, { b: 'y'.repeat(7990) }],
    questions: Array.from({ length: 8 }, (_, q) => ({ question: `${q}${'q'.repeat(7900)}`, options: [{ label: 'Yes' }] })),
  });
}
const nodeSessions = (node: string = NODE_IDS.build1) => Object.values(stateOf().sessions).filter((s) => s.node === node);

/** 45 accounts with every string as long as a node can send: before the caps, one usage.updated became a node.updated of about 0.9 MB. */
function fatUsage(round: number): DaemonEvent {
  const text = '語'.repeat(1024);
  const accounts = Array.from({ length: 45 }, (_, id) => ({
    id,
    alias: text,
    emailMasked: text,
    isDefaultLogin: id === 0,
    disabled: false,
    held: false,
    usageStatus: text,
    windows: Array.from({ length: 16 }, () => ({ kind: text, pct: round })),
  }));
  return nodeWireEvent({ type: 'usage.updated', data: { accounts, activeAccount: 0, fetchedAt: '2026-01-15T10:01:00.000Z', source: 'cache' } });
}

const sendOf = (id: string, sid: string, stage: 'typed' | 'proven') => ({
  id,
  sid,
  textHash: 'h',
  textLength: 1,
  stage,
  attempts: 0,
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
});

const launchOf = (id: string, sid: string, more: Partial<LaunchJob> = {}): LaunchJob => ({
  id,
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
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
  sid,
  stage: 'opening',
  steps: [],
  ...more,
});

describe('a snapshot', () => {
  it('puts the node on the board: its sessions stamped with its id, its card, its view online under the hub name', async () => {
    const events = record(ctx);
    await linked();
    const st = stateOf();
    expect(nodeSessions().map((s) => s.sid).sort()).toEqual([S1, S2, S3]);
    expect(st.pending[CARD]).toMatchObject({ sid: S1, tool: 'Bash' });
    expect(st.nodes?.[NODE_IDS.build1]).toMatchObject({
      id: NODE_IDS.build1,
      name: 'build-1',
      os: 'linux',
      backend: 'tmux',
      online: true,
      accountsMode: 'dirs',
      activeAccount: 0,
      features: { controls: true, files: false, rewrite: false, screenshots: false, life: false, intel: false, meetings: false, fleet: false },
    });
    expect(Object.keys(st.nodes?.[NODE_IDS.build1]?.accounts ?? {})).toEqual(['0', '1']);
    // The view goes first, so a push for the card already names the machine.
    expect(events[0]?.type).toBe('node.updated');
    expect(events.filter((e) => e.type === 'pending.opened')).toHaveLength(1);
    // The Mac's own session and card are untouched, and its accounts too.
    expect(st.sessions[MAC_SID]?.node).toBeUndefined();
    expect(st.pending[MAC_CARD]).toBeDefined();
    expect(st.accounts).toEqual({});
  });

  it('a Windows node: typing and starting are off whatever it says; the Mac-only parts always are', async () => {
    const snap = windowsNodeSnapshot();
    snap.daemon.features = { ...snap.daemon.features, controls: true, launch: true, files: true, rewrite: true };
    const pair = linkTo(reg, NODE_IDS.win1, { info: { os: 'windows', backend: 'none' } });
    pair.node.sendSnapshot(snap);
    await settle();
    expect(stateOf().nodes?.[NODE_IDS.win1]?.features).toMatchObject({ controls: false, launch: false, escape: false, clearDraft: false, files: false, rewrite: false });
  });

  it('a node cannot claim the Mac sid or name: its own `node` is overwritten, a Mac sid is dropped', async () => {
    const snap = linuxNodeSnapshot();
    const s1 = snap.sessions[S1] as Session;
    snap.sessions[S1] = { ...s1, node: NODE_IDS.build2, name: 'Mac' };
    snap.sessions[MAC_SID] = nodeSession({ sid: MAC_SID, cwd: '/home/sam/evil' });
    await linked(snap);
    expect(stateOf().sessions[S1]?.node).toBe(NODE_IDS.build1);
    expect(stateOf().sessions[MAC_SID]?.node).toBeUndefined();
    expect(stateOf().sessions[MAC_SID]?.cwd).not.toBe('/home/sam/evil');
    expect(stateOf().nodes?.[NODE_IDS.build1]?.name).toBe('build-1');
  });

  it('S19: the oversized fixture arrives clipped (8,000 characters of reply, {} for the card input)', async () => {
    const snap = oversizedNodeSnapshot();
    await linked(snap, NODE_IDS.build1);
    const s = nodeSessions()[0];
    expect(s?.lastReply?.text).toHaveLength(REPLY_TEXT_MAX);
    const card = Object.values(stateOf().pending).find((p) => p.sid === s?.sid);
    expect(card?.input).toEqual({});
    expect(card?.tool).toBe('Bash');
  });

  it('over the 4 MiB state budget: the link closes 4400 and nothing of it is kept', async () => {
    const snap = linuxNodeSnapshot();
    snap.pending = Object.fromEntries(Array.from({ length: 32 }, (_, i) => fatCard(S1, i)).map((p) => [p.id, p]));
    const events = record(ctx);
    const pair = await linked(snap);
    expect(pair.open).toBe(false);
    expect(events).toEqual([]);
    expect(nodeSessions()).toEqual([]);
    expect(warnings(ctx).at(-1)?.fields).toMatchObject({ node: NODE_IDS.build1, code: NODE_CLOSE.protocol, reason: 'over the state budget' });
  });

  it('keeps 64 sessions and 32 open cards of a snapshot, dropping the rest', async () => {
    const snap = linuxNodeSnapshot();
    for (let i = 0; i < 70; i++) {
      const sid = `bulk-${String(i).padStart(3, '0')}`;
      snap.sessions[sid] = nodeSession({ sid });
    }
    const pair = await linked(snap);
    // 73 offered, 64 kept: 9 refused, under the snapshot's refusal limit, so the link stays.
    expect(pair.open).toBe(true);
    expect(nodeSessions()).toHaveLength(NODE_LIMITS.sessions);
  });

  it('more than 20 bad entries close the link 4400 and nothing of it is kept', async () => {
    const snap = linuxNodeSnapshot();
    for (let i = 0; i < 21; i++) snap.sessions[`bad/${i}`] = nodeSession({ sid: `bad/${i}` });
    const events = record(ctx);
    const pair = await linked(snap);
    expect(pair.open).toBe(false);
    expect(events).toEqual([]);
    expect(warnings(ctx).at(-1)?.fields).toMatchObject({ code: NODE_CLOSE.protocol, reason: 'snapshot refused' });
  });

  it('keeps the unfinished sends and launches plus the newest 20 (84 each at most), counting the rest', async () => {
    const snap = linuxNodeSnapshot();
    for (let i = 0; i < 90; i++) {
      const job = sendOf(`send-${i}`, S1, 'typed');
      snap.sends[job.id] = job;
      const launch = launchOf(`launch-${i}`, `5e1f0000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      snap.launches[launch.id] = launch;
    }
    const pair = await linked(snap);
    // 6 + 6 over: under the snapshot's refusal limit.
    expect(pair.open).toBe(true);
    expect(Object.keys(stateOf().sends)).toHaveLength(NODE_LIMITS.sessions + 20);
    expect(Object.values(stateOf().launches).every((l) => l.node === NODE_IDS.build1)).toBe(true);
  });
});

describe('a server joined again under a new name, its old pairing still on the board', () => {
  /** The server's 25 sessions: the Linux fixture's 3 and 22 more. */
  function serverSnapshot(): NodeSnapshot {
    const snap = linuxNodeSnapshot();
    for (let i = 0; i < 22; i++) snap.sessions[`same-${i}`] = nodeSession({ sid: `same-${i}` });
    return snap;
  }

  it('links, shows its new sessions, drops its words about the old ones uncounted; once the old pairing is removed, its next link brings them', async () => {
    // build-1, the old pairing: linked, then gone (greyed).
    const old = await linked(serverSnapshot(), NODE_IDS.build1);
    old.drop(1006);
    // build-2, the new pairing of the same server: the same 25 sessions, and one started since.
    const again = (): NodeSnapshot => {
      const snap = serverSnapshot();
      snap.sessions['since-1'] = nodeSession({ sid: 'since-1' });
      return snap;
    };
    const b = linkTo(reg, NODE_IDS.build2);
    b.node.sendSnapshot(again());
    await settle();
    expect(b.open).toBe(true);
    expect(nodeSessions(NODE_IDS.build2).map((x) => x.sid)).toEqual(['since-1']);
    expect(nodeSessions(NODE_IDS.build1)).toHaveLength(25);
    // Its feed believes the hub knows all 26: every update about the old ones is dropped, never counted.
    for (let round = 0; round < 2; round++) {
      for (const sid of Object.keys(serverSnapshot().sessions)) b.node.sendEvent(nodeEvents.sessionUpdated(sid, { name: `renamed-${round}` }));
    }
    b.node.sendEvent(nodeEvents.pendingResolved(S1, CARD));
    await settle();
    expect(b.open).toBe(true);
    expect(nodeSessions(NODE_IDS.build1).some((x) => x.name?.startsWith('renamed'))).toBe(false);
    expect(stateOf().pending[CARD]).toBeDefined();
    expect(warnings(ctx).filter((r) => r.fields?.node === NODE_IDS.build2)).toEqual([]);

    // The user removes the old pairing: build-2's link is told to send its snapshot again, and the next one brings them.
    reg.remove(NODE_IDS.build1);
    expect(nodeSessions(NODE_IDS.build1)).toEqual([]);
    expect(b.open).toBe(false);
    expect(warnings(ctx).at(-1)?.fields).toMatchObject({ node: NODE_IDS.build2, code: NODE_CLOSE.goingAway });
    const next = linkTo(reg, NODE_IDS.build2);
    next.node.sendSnapshot(again());
    await settle();
    expect(next.open).toBe(true);
    expect(nodeSessions(NODE_IDS.build2)).toHaveLength(26);
    expect(stateOf().pending[CARD]).toBeDefined();
  });

  it("a session the Mac's own sources have is left out of a snapshot uncounted, with its card, sends and alerts", async () => {
    const snap = linuxNodeSnapshot();
    for (let i = 0; i < 25; i++) {
      const sid = i === 0 ? MAC_SID : `mac-${i}`;
      if (i > 0) ctx.store.emit({ type: 'session.added', sid, data: { session: nodeSession({ sid }) } });
      snap.sessions[sid] = nodeSession({ sid });
    }
    snap.pending['01JF1EETCARDONMAC00000000AAbbCCddEEffGGhh00'] = nodeCard({ sid: MAC_SID, id: '01JF1EETCARDONMAC00000000AAbbCCddEEffGGhh00' });
    snap.sends['job-on-mac'] = sendOf('job-on-mac', MAC_SID, 'typed');
    snap.alerts = [{ id: 'alert-on-mac', ts: '2026-01-15T10:00:00.000Z', kind: 'error', sid: MAC_SID, label: 'x', what: 'x' }];
    const pair = await linked(snap);
    expect(pair.open).toBe(true);
    expect(nodeSessions().map((x) => x.sid).sort()).toEqual([S1, S2, S3]);
    expect(stateOf().sessions[MAC_SID]?.node).toBeUndefined();
    expect(stateOf().sends['job-on-mac']).toBeUndefined();
  });
});

describe('events (S1: a node speaks for its own things only)', () => {
  it('re-emits its own events with the hub seq and time, stamped with its id', async () => {
    const pair = await linked();
    const events = record(ctx);
    const s = nodeSession({ sid: 'new-sess-1', node: NODE_IDS.build2 });
    pair.node.sendEvent(nodeWireEvent({ type: 'session.added', sid: s.sid, data: { session: s } }, 99_999));
    pair.node.sendEvent(nodeEvents.sessionUpdated(S2, { status: 'idle', statusSince: '2026-01-15T10:05:00.000Z' }));
    await settle();
    expect(events.map((e) => e.type)).toEqual(['session.added', 'session.updated']);
    expect(events[0]?.seq).toBeLessThan(99_999);
    expect(stateOf().sessions['new-sess-1']?.node).toBe(NODE_IDS.build1);
    expect(stateOf().sessions[S2]?.status).toBe('idle');
  });

  it('drops events about what the Mac or another node holds, uncounted and logged once per id; the 21st refusal closes 4400', async () => {
    const pair = await linked();
    const other = linkTo(reg, NODE_IDS.build2);
    other.node.sendSnapshot({ ...linuxNodeSnapshot(), sessions: { 'b2-sess': nodeSession({ sid: 'b2-sess' }) }, pending: {} });
    await settle();
    ctx.store.emit({
      type: 'send.progress',
      sid: 'b2-sess',
      data: { job: { id: 'job-b2', sid: 'b2-sess', textHash: 'h', textLength: 1, stage: 'typed', attempts: 0, createdAt: '2026-01-15T10:00:00.000Z', updatedAt: '2026-01-15T10:00:00.000Z' } },
    });
    const before = JSON.stringify(stateOf());
    const events = record(ctx);
    const bad: DaemonEvent[] = [
      nodeEvents.sessionUpdated(MAC_SID, { status: 'working' }),
      nodeEvents.sessionRemoved(MAC_SID),
      nodeEvents.pendingResolved(MAC_SID, MAC_CARD),
      nodeEvents.pendingResolved(S1, MAC_CARD),
      nodeEvents.sessionUpdated('b2-sess', { name: 'mine now' }),
      nodeWireEvent({
        type: 'send.progress',
        sid: S1,
        data: { job: { id: 'job-b2', sid: S1, textHash: 'h', textLength: 1, stage: 'failed', attempts: 0, createdAt: '2026-01-15T10:00:00.000Z', updatedAt: '2026-01-15T10:00:00.000Z' } },
      }),
      nodeEvents.sessionAdded(nodeSession({ sid: S1 })),
      nodeEvents.sessionAdded(nodeSession({ sid: MAC_SID })),
      nodeEvents.sessionAdded(nodeSession({ sid: 'a/b' })),
      nodeEvents.sessionUpdated('constructor', { name: 'x' }),
      nodeEvents.sessionUpdated('__proto__', { name: 'x' }),
      nodeEvents.pendingOpened(nodeCard({ sid: MAC_SID, id: '01JF1EETCARDMAC00000000000AAbbCCddEEffGGhh00' })),
      nodeEvents.pendingOpened(nodeCard({ sid: S1, id: MAC_CARD })),
      nodeWireEvent({ type: 'alert.error', data: { alert: { id: 'al-1', ts: '2026-01-15T10:00:00.000Z', kind: 'error', sid: MAC_SID, label: 'x', what: 'x' } } }),
      nodeWireEvent({ type: 'pending.resolved', sid: S1, data: { id: 'no-such-card-0000000000000', state: 'closed' } }),
    ];
    for (const ev of bad) pair.node.sendEvent(ev);
    // Many more about the Mac's session: still not counted.
    for (let i = 0; i < 40; i++) pair.node.sendEvent(nodeEvents.sessionUpdated(MAC_SID, { now: { kind: 'said', text: FLEET_SECRET } }));
    await settle();
    expect(events).toEqual([]);
    expect(JSON.stringify(stateOf())).toBe(before);
    expect(pair.open).toBe(true);
    // One line per id another machine holds, for this link.
    const held = ctx.log.records.filter((r) => r.msg === 'node spoke of an id another machine holds').map((r) => r.fields?.id);
    expect(held.sort()).toEqual([MAC_CARD, MAC_SID, 'b2-sess', 'job-b2'].sort());
    // Five of the list were refused (a duplicate of its own, a bad id, ids the hub has nowhere): 16 more, and the 21st closes, once.
    for (let i = 0; i < 16; i++) pair.node.sendEvent(nodeEvents.sessionUpdated('no-such-session', { now: { kind: 'said', text: FLEET_SECRET } }));
    await settle();
    expect(pair.open).toBe(false);
    const lines = warnings(ctx).filter((r) => r.msg === 'node link closed');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({ node: NODE_IDS.build1, code: NODE_CLOSE.protocol, type: 'session.updated', reason: 'not its session' });
    expect(JSON.stringify(ctx.log.records)).not.toContain(FLEET_SECRET);
    // Its sessions stay, greyed.
    expect(stateOf().nodes?.[NODE_IDS.build1]?.online).toBe(false);
    expect(nodeSessions()).toHaveLength(3);
  });

  it('a refusal older than a minute no longer counts', async () => {
    const pair = await linked();
    for (let i = 0; i < 20; i++) pair.node.sendEvent(nodeEvents.sessionRemoved('no-such-session'));
    await settle();
    ctx.clock.advance(61_000);
    for (let i = 0; i < 20; i++) pair.node.sendEvent(nodeEvents.sessionRemoved('no-such-session'));
    await settle();
    expect(pair.open).toBe(true);
    pair.node.sendEvent(nodeEvents.sessionRemoved('no-such-session'));
    await settle();
    expect(pair.open).toBe(false);
  });

  it('F17: unknown types are dropped and not counted; a known type with a bad payload is', async () => {
    const pair = await linked();
    const events = record(ctx);
    for (let i = 0; i < 30; i++) pair.node.sendEvent({ type: 'session.teleported', sid: S1, data: {} } as unknown as DaemonEvent);
    // Known to the hub but never a node's: dropped, not counted.
    for (let i = 0; i < 30; i++) pair.node.sendEvent(nodeWireEvent({ type: 'life.changed', data: {} }));
    for (let i = 0; i < 5; i++) pair.node.sendEvent(nodeWireEvent({ type: 'usage.threshold', account: 1, data: { window: 'five_hour', pct: 99, threshold: 90 } }));
    await settle();
    expect(pair.open).toBe(true);
    expect(events).toEqual([]);
    for (let i = 0; i < 21; i++) pair.node.sendEvent({ type: 'session.updated', sid: S1, data: { patch: { status: 'flying' } } } as unknown as DaemonEvent);
    await settle();
    expect(pair.open).toBe(false);
    expect(warnings(ctx).at(-1)?.fields).toMatchObject({ reason: 'invalid' });
  });

  it('S13: the 65th session and the 33rd card are refused', async () => {
    const pair = await linked();
    const events = record(ctx);
    for (let i = 0; i < 62; i++) pair.node.sendEvent(nodeEvents.sessionAdded(nodeSession({ sid: `more-${i}` })));
    await settle();
    expect(nodeSessions()).toHaveLength(NODE_LIMITS.sessions);
    expect(events.filter((e) => e.type === 'session.added')).toHaveLength(61);
    for (let i = 0; i < 32; i++) pair.node.sendEvent(nodeEvents.pendingOpened(nodeCard({ sid: `more-${i}`, id: `01JF1EETCARDMORE${String(i).padStart(10, '0')}AAbbCCddEEffGG` })));
    await settle();
    expect(Object.values(stateOf().pending).filter((p) => p.sid !== MAC_SID)).toHaveLength(NODE_LIMITS.openCards);
  });

  it('S13: an event that would take the node over the 4 MiB state budget is refused', async () => {
    const pair = await linked();
    for (let i = 0; i < 31; i++) pair.node.sendEvent(nodeEvents.pendingOpened(fatCard(S2, i)));
    await settle();
    const kept = Object.values(stateOf().pending).filter((p) => p.sid === S2).length;
    expect(kept).toBeGreaterThan(20);
    expect(kept).toBeLessThan(31);
    expect(reg.tally(NODE_IDS.build1).bytes).toBeLessThanOrEqual(NODE_LIMITS.stateBytes);
  });

  it('S13: more than 300 events in 10 s close the link 1013', async () => {
    const pair = await linked();
    for (let i = 0; i < 300; i++) pair.node.sendEvent(nodeEvents.sessionUpdated(S2, { subagentsRunning: i % 3 }));
    await settle();
    expect(pair.open).toBe(true);
    pair.node.sendEvent(nodeEvents.sessionUpdated(S2, { subagentsRunning: 1 }));
    await settle();
    expect(pair.open).toBe(false);
    expect(warnings(ctx).at(-1)?.fields).toMatchObject({ code: NODE_CLOSE.slow, reason: 'over the event rate' });
  });

  it('S13: what its events re-emit is capped too: over 4 MiB in 10 s closes 1013, and the hub keeps no more than that', async () => {
    const pair = await linked();
    const events = record(ctx);
    // Each a whole new view (a node.updated); far under the count.
    for (let round = 1; round <= 280 && pair.open; round++) {
      pair.node.sendEvent(fatUsage(round));
      await settle(1);
    }
    expect(pair.open).toBe(false);
    expect(warnings(ctx).at(-1)?.fields).toMatchObject({ code: NODE_CLOSE.slow, type: 'usage.updated', reason: 'over the byte rate' });
    const sizes = events.map((e) => jsonBytes(e));
    const biggest = Math.max(...sizes);
    // The caps keep each one small: 32 accounts of 128 characters a string.
    expect(Object.keys(stateOf().nodes?.[NODE_IDS.build1]?.accounts ?? {})).toHaveLength(32);
    expect(biggest).toBeLessThan(512 * 1024);
    // The replay ring, jantar.db and the phones got the budget and one event over it, never more.
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(EVENT_BYTES_PER_10S + 2 * biggest);
    expect(events.length).toBeLessThan(40);
  });

  it('the byte window slides: the same bytes spread over time keep the link', async () => {
    const pair = await linked();
    for (let round = 1; round <= 60; round++) {
      pair.node.sendEvent(fatUsage(round));
      await settle(1);
      ctx.clock.advance(2_000);
    }
    await settle();
    expect(pair.open).toBe(true);
  });

  it('session.waiting with a bad pendingId is refused', async () => {
    await linked();
    const out = ingestEvent(reg, NODE_IDS.build1, nodeWireEvent({ type: 'session.waiting', sid: S1, data: { waitingFor: 'permission', pendingId: 'a/b' } }));
    expect(out).toMatchObject({ ok: false, kind: 'refused', reason: 'bad id' });
  });

  it("launch.progress: its sid and first prompt's send must be ids, and never another machine's", async () => {
    await linked();
    ctx.store.emit({ type: 'send.progress', sid: MAC_SID, data: { job: sendOf('mac-send', MAC_SID, 'typed') } });
    const go = (job: LaunchJob) => ingestEvent(reg, NODE_IDS.build1, nodeWireEvent({ type: 'launch.progress', data: { job } }));
    expect(go(launchOf('l-bad-sid', 'a/b'))).toMatchObject({ kind: 'refused', reason: 'bad id' });
    expect(go(launchOf('l-bad-send', S1, { prompt: { hash: 'h', length: 1, sendJobId: '../x' } }))).toMatchObject({ kind: 'refused', reason: 'bad id' });
    expect(go(launchOf('l-mac-sid', MAC_SID))).toMatchObject({ kind: 'dropped' });
    expect(go(launchOf('l-mac-send', S1, { prompt: { hash: 'h', length: 1, sendJobId: 'mac-send' } }))).toMatchObject({ kind: 'dropped' });
    expect(Object.keys(stateOf().launches)).toEqual([]);
    // Its own, or a session it has not told yet (a launch comes before its session): kept.
    expect(go(launchOf('l-own', S1))).toMatchObject({ ok: true });
    expect(go(launchOf('l-new', '5e1f0000-0000-4000-8000-000000000009'))).toMatchObject({ ok: true });
  });

  it('events that come before the snapshot is whole wait for it, in order', async () => {
    const pair = linkTo(reg);
    pair.node.sendEvent(nodeEvents.sessionUpdated(S2, { name: 'renamed' }));
    expect(nodeSessions()).toEqual([]);
    await settle();
    pair.node.sendSnapshot(linuxNodeSnapshot());
    await settle();
    expect(stateOf().sessions[S2]?.name).toBe('renamed');
    expect(pair.open).toBe(true);
  });

  it("S17: a node's URL in any text makes the hub fetch nothing", async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const pair = await linked();
    pair.node.sendEvent(nodeEvents.sessionUpdated(S1, { now: { kind: 'said', text: 'https://evil.example/x' }, transcriptPath: 'https://evil.example/t' }));
    pair.node.sendEvent(
      nodeWireEvent({ type: 'alert.error', sid: S1, data: { alert: { id: 'al-2', ts: '2026-01-15T10:00:00.000Z', kind: 'error', sid: S1, label: 'https://evil.example', what: 'x' } } }),
    );
    await settle();
    expect(stateOf().alerts[0]).toMatchObject({ id: 'al-2', node: NODE_IDS.build1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('daemon.version and usage.updated become one node.updated; the Mac accounts never move', async () => {
    const pair = await linked();
    const events = record(ctx);
    pair.node.sendEvent(nodeWireEvent({ type: 'daemon.version', data: { protocol: 3, daemonVersion: '0.6.1', webHash: null, features: { ...linuxNodeSnapshot().daemon.features, launch: true, files: true } } }));
    pair.node.sendEvent(
      nodeWireEvent({
        type: 'usage.updated',
        data: {
          accounts: [{ id: 1, emailMasked: 's***', isDefaultLogin: true, disabled: false, held: false, usageStatus: 'ok', windows: [{ kind: 'five_hour', pct: 35 }] }],
          activeAccount: 1,
          fetchedAt: '2026-01-15T10:01:00.000Z',
          source: 'cache',
        },
      }),
    );
    // The same again: nothing new to say.
    pair.node.sendEvent(nodeWireEvent({ type: 'daemon.version', data: { protocol: 3, daemonVersion: '0.6.1', webHash: null, features: { ...linuxNodeSnapshot().daemon.features, launch: true, files: true } } }));
    await settle();
    expect(events.map((e) => e.type)).toEqual(['node.updated', 'node.updated']);
    const view = stateOf().nodes?.[NODE_IDS.build1];
    expect(view?.features).toMatchObject({ launch: true, files: false });
    expect(view?.accounts['1']?.windows[0]?.pct).toBe(35);
    expect(view?.activeAccount).toBe(1);
    expect(stateOf().accounts).toEqual({});
    expect(stateOf().activeAccount).toBeNull();
  });

  it('sends, launches and alerts: stamped and owned', async () => {
    const pair = await linked();
    const job = { id: 'job-1', sid: S1, textHash: 'h', textLength: 1, stage: 'typed' as const, attempts: 0, createdAt: '2026-01-15T10:00:00.000Z', updatedAt: '2026-01-15T10:00:00.000Z' };
    pair.node.sendEvent(nodeWireEvent({ type: 'send.progress', sid: S1, data: { job } }));
    // The same job id for another of its sessions: refused.
    pair.node.sendEvent(nodeWireEvent({ type: 'send.progress', sid: S2, data: { job: { ...job, sid: S2 } } }));
    const launch = {
      id: 'launch-1',
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:00:00.000Z',
      actor: 'device:hub.dev-1',
      rootId: 'r.code',
      folder: '/home/sam/code/api-server',
      display: '~/code/api-server',
      account: 0,
      accountSource: 'auto' as const,
      requested: 'auto' as const,
      flags: { permission: 'manual' as const, chrome: false, effort: 'default' as const, model: 'default' as const },
      dangerous: false,
      name: 'fix-tests',
      sid: '5e1f0000-0000-4000-8000-000000000009',
      stage: 'opening' as const,
      steps: [],
      node: NODE_IDS.build2,
    };
    pair.node.sendEvent(nodeWireEvent({ type: 'launch.progress', data: { job: launch } }));
    await settle();
    expect(stateOf().sends['job-1']?.sid).toBe(S1);
    expect(stateOf().launches['launch-1']?.node).toBe(NODE_IDS.build1);
    // Another node cannot touch build-1's launch.
    const other = linkTo(reg, NODE_IDS.build2);
    other.node.sendSnapshot({ ...linuxNodeSnapshot(), sessions: {}, pending: {} });
    await settle();
    other.node.sendEvent(nodeWireEvent({ type: 'launch.progress', data: { job: { ...launch, stage: 'failed' } } }));
    await settle();
    expect(stateOf().launches['launch-1']?.stage).toBe('opening');
  });
});

describe('S3, S4: no node-to-node, no verbs towards the hub', () => {
  it("node A's frames never reach node B, and B learns nothing of A", async () => {
    const a = await linked();
    const b = linkTo(reg, NODE_IDS.build2);
    b.node.sendSnapshot({ ...linuxNodeSnapshot(), sessions: { 'b2-only': nodeSession({ sid: 'b2-only' }) }, pending: {} });
    await settle();
    a.node.sendEvent(nodeEvents.sessionUpdated(S1, { name: FLEET_SECRET }));
    await settle();
    expect(b.frames.every((f) => f.dir === 'toHub')).toBe(true);
    expect(b.frames.some((f) => f.text.includes(FLEET_SECRET))).toBe(false);
    expect(a.frames.some((f) => f.text.includes('b2-only'))).toBe(false);
  });

  it("a node's side has only snapshot, event, the calls it answers and close; a call-shaped event is dropped", async () => {
    const pair = await linked();
    expect(Object.keys(pair.node).sort()).toEqual(['onCall', 'onClose', 'sendEvent', 'sendSnapshot']);
    const out = ingestEvent(reg, NODE_IDS.build1, { k: 'call', type: 'call', route: 'getSettings' });
    expect(out).toMatchObject({ ok: false, kind: 'dropped' });
  });
});

describe('offline, reconnect and the snapshot diff', () => {
  it('a drop greys the node out and keeps its sessions and cards', async () => {
    const pair = await linked();
    pair.drop(1006);
    expect(stateOf().nodes?.[NODE_IDS.build1]).toMatchObject({ online: false, since: ctx.clock.iso() });
    expect(nodeSessions()).toHaveLength(3);
    expect(stateOf().pending[CARD]).toBeDefined();
    expect(reg.rows().find((r) => r.id === NODE_IDS.build1)).toMatchObject({ online: false, sessions: 3, backend: 'tmux', lastClose: { code: 1006 } });
  });

  it('a reconnect emits only what changed and never re-opens a card the hub has', async () => {
    const first = await linked();
    first.drop(1006);
    const events = record(ctx);
    const snap = linuxNodeSnapshot();
    // S3 ended, S2 changed (a new name, its pane gone), a new session with a new card; the old card still open.
    delete snap.sessions[S3];
    const s2 = { ...(snap.sessions[S2] as Session), name: 'landing-v2' };
    delete s2.paneId;
    snap.sessions[S2] = s2;
    snap.sessions['fresh-1'] = nodeSession({ sid: 'fresh-1', status: 'waiting' });
    const fresh = nodeCard({ sid: 'fresh-1', id: '01JF1EETCARDFRESH00000000AAbbCCddEEffGGhh00' });
    snap.pending[fresh.id] = fresh;
    const second = linkTo(reg);
    second.node.sendSnapshot(snap);
    await settle();
    const summary = events.map((e) => `${e.type}:${e.sid ?? (e.type === 'pending.opened' ? e.data.pending.id : '')}`);
    expect(summary).toEqual(['node.updated:', 'session.removed:' + S3, 'session.updated:' + S2, 'session.added:fresh-1', 'pending.opened:fresh-1']);
    const upd = events.find((e) => e.type === 'session.updated');
    expect(upd?.type === 'session.updated' && upd.data).toEqual({ patch: { name: 'landing-v2' }, unset: ['paneId'] });
    expect(stateOf().nodes?.[NODE_IDS.build1]?.online).toBe(true);
    expect(stateOf().sessions[S2]?.paneId).toBeUndefined();
  });

  it('a card closed while the link was down is closed on the hub', async () => {
    const first = await linked();
    first.drop(1006);
    const events = record(ctx);
    const snap = linuxNodeSnapshot();
    snap.pending = {};
    const second = linkTo(reg);
    second.node.sendSnapshot(snap);
    await settle();
    expect(events.filter((e) => e.type === 'pending.resolved').map((e) => e.type === 'pending.resolved' && e.data)).toEqual([{ id: CARD, state: 'closed' }]);
    expect(stateOf().pending[CARD]).toBeUndefined();
  });

  it('a card decided while the link was down is settled, not re-opened; after a hub restart a decided card is kept, so its confirmation counts', async () => {
    const first = await linked();
    first.drop(1006);
    const events = record(ctx);
    const snap = linuxNodeSnapshot();
    snap.pending[CARD] = { ...(snap.pending[CARD] as PendingRequest), state: 'decided', decidedBy: 'device:hub.dev-1', decision: { behavior: 'allow' } };
    const second = linkTo(reg);
    second.node.sendSnapshot(snap);
    await settle();
    expect(events.filter((e) => e.type.startsWith('pending.')).map((e) => e.type === 'pending.resolved' && e.data)).toEqual([
      { id: CARD, state: 'decided', decidedBy: 'device:hub.dev-1', decision: { behavior: 'allow' } },
    ]);
    expect(stateOf().pending[CARD]?.state).toBe('decided');

    // A new hub (restarted): the decided card is kept as it is, never pushed, and its later confirmation is the node's own.
    ctx = hubContext();
    reg = new NodeRegistry(ctx);
    const fresh = linkTo(reg);
    fresh.node.sendSnapshot(snap);
    await settle();
    expect(stateOf().pending[CARD]?.state).toBe('decided');
    fresh.node.sendEvent(nodeWireEvent({ type: 'pending.resolved', sid: S1, data: { id: CARD, state: 'confirmed' } }));
    await settle();
    expect(stateOf().pending[CARD]).toBeUndefined();
    expect(warnings(ctx)).toEqual([]);
  });

  it('sends: an unfinished one is caught up, one that finished while away is too, an old finished one is not news', async () => {
    const first = await linked();
    const job = (id: string, stage: 'typed' | 'failed' | 'proven') => ({ id, sid: S1, textHash: 'h', textLength: 1, stage, attempts: 0, createdAt: '2026-01-15T10:00:00.000Z', updatedAt: '2026-01-15T10:00:00.000Z' });
    first.node.sendEvent(nodeWireEvent({ type: 'send.progress', sid: S1, data: { job: job('was-typed', 'typed') } }));
    await settle();
    first.drop(1006);
    const events = record(ctx);
    const snap = linuxNodeSnapshot();
    snap.sends = { 'was-typed': job('was-typed', 'proven'), 'old-failed': job('old-failed', 'failed'), running: job('running', 'typed') };
    const second = linkTo(reg);
    second.node.sendSnapshot(snap);
    await settle();
    expect(events.filter((e) => e.type === 'send.progress').map((e) => e.type === 'send.progress' && `${e.data.job.id}:${e.data.job.stage}`)).toEqual([
      'was-typed:proven',
      'running:typed',
    ]);
  });

  it('a newer link of the same node replaces the older; the older one closing changes nothing', async () => {
    const first = await linked();
    const second = linkTo(reg);
    second.node.sendSnapshot(linuxNodeSnapshot());
    await settle();
    first.drop(NODE_CLOSE.replaced);
    expect(stateOf().nodes?.[NODE_IDS.build1]?.online).toBe(true);
    expect(reg.link(NODE_IDS.build1)).toBe(second.hub);
  });

  it('remove and removeAll take nodes off the board; the pairings stay', async () => {
    await linked();
    const b = linkTo(reg, NODE_IDS.build2);
    b.node.sendSnapshot({ ...linuxNodeSnapshot(), sessions: { 'b2-sess': nodeSession({ sid: 'b2-sess' }) }, pending: {} });
    await settle();
    const events = record(ctx);
    reg.remove(NODE_IDS.build1);
    expect(events.map((e) => e.type)).toEqual(['node.removed']);
    expect(nodeSessions()).toEqual([]);
    expect(reg.link(NODE_IDS.build1)).toBeNull();
    reg.removeAll();
    expect(stateOf().nodes).toEqual({});
    expect(Object.keys(stateOf().sessions)).toEqual([MAC_SID]);
    expect(stateOf().pending[MAC_CARD]).toBeDefined();
    expect(reg.rows().map((r) => r.name)).toEqual(['build-1', 'build-2', 'win-1']);
  });
});
