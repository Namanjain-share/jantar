/**
 * v0.6 Fleet, the shared fixtures every lane builds on (wave 0): the
 * in-memory link pair has the daemon's HubLink and NodeLink shapes and
 * behaves as the socket will (one snapshot, nothing queued across a drop,
 * every frame recorded), and the synthetic servers are valid wire data.
 */
import { describe, expect, it } from 'vitest';
import { NodeIdSchema, NodeViewSchema } from '@jantar/protocol';
import { NodeSnapshotSchema, type NodeCallRequest } from '@jantar/protocol/node-link';
import {
  FLEET_SECRET,
  NODE_IDS,
  linuxCswapNodeSnapshot,
  linuxHome,
  linuxNodeSnapshot,
  macNodeSnapshot,
  memoryLinkPair,
  nodeEvents,
  nodeSession,
  nodeViewFixture,
  oversizedNodeSnapshot,
  windowsHome,
  windowsNodeSnapshot,
  MEMORY_NODE_ID,
} from '@jantar/fixtures';
import type { HubLink, NodeLink } from '../src/contracts.js';

const call = (id: string): NodeCallRequest => ({ id, route: 'getScreen', params: { sid: 's1' }, query: { lines: '40' }, actor: { deviceId: 'dev-1', deviceName: 'Sam phone', scopes: ['read'] } });

describe('v0.6: memoryLinkPair', () => {
  it("has the daemon's link shapes", () => {
    const pair = memoryLinkPair();
    const hub: HubLink = pair.hub;
    const node: NodeLink = pair.node;
    expect(hub.nodeId).toBe(MEMORY_NODE_ID);
    expect(NodeIdSchema.safeParse(MEMORY_NODE_ID).success).toBe(true);
    expect(typeof node.sendSnapshot).toBe('function');
  });

  it('carries one snapshot, events in order, and calls with their results, recording every frame', async () => {
    const pair = memoryLinkPair();
    const snaps: unknown[] = [];
    const events: unknown[] = [];
    pair.hub.onSnapshot((s) => snaps.push(s));
    pair.hub.onEvent((e) => events.push(e));
    pair.node.onCall(async (req, bulk) => ({ status: 200, body: { route: req.route, bytes: bulk?.length ?? 0 } }));
    pair.node.sendSnapshot(linuxNodeSnapshot());
    const s = nodeSession({ sid: 'x1' });
    pair.node.sendEvent(nodeEvents.sessionAdded(s));
    pair.node.sendEvent(nodeEvents.sessionUpdated('x1', { status: 'idle' }));
    await Promise.resolve();
    expect(snaps).toHaveLength(1);
    expect(events.map((e) => (e as { type: string }).type)).toEqual(['session.added', 'session.updated']);
    expect(await pair.hub.call(call('c1'), Buffer.from('abc'))).toEqual({ status: 200, body: { route: 'getScreen', bytes: 3 } });
    expect(pair.frames.map((f) => `${f.dir}:${f.k}`)).toEqual(['toHub:snapshot', 'toHub:event', 'toHub:event', 'toNode:call', 'toHub:result']);
    expect(JSON.parse(pair.frames[3]?.text ?? '{}').bulk.size).toBe(3);
  });

  it('closes 4400 on a second snapshot, and a drop ends waiting calls node_offline with nothing queued', async () => {
    const pair = memoryLinkPair();
    const closed: number[] = [];
    pair.hub.onClose((c) => closed.push(c));
    pair.node.onClose((c) => closed.push(c));
    pair.node.sendSnapshot(linuxNodeSnapshot());
    pair.node.sendSnapshot(linuxNodeSnapshot());
    expect(closed).toEqual([4400, 4400]);
    expect(pair.open).toBe(false);
    expect((await pair.hub.call(call('c2'))).status).toBe(503);

    const again = memoryLinkPair();
    let release: (() => void) | null = null;
    again.node.onCall(() => new Promise((resolve) => (release = () => resolve({ status: 200, body: {} }))));
    const waiting = again.hub.call(call('c3'));
    again.drop(1006);
    expect((await waiting).status).toBe(503);
    release!();
    expect(again.frames.filter((f) => f.k === 'result')).toEqual([]);
  });
});

describe('v0.6: synthetic servers', () => {
  it('are valid snapshots and views with valid ids', () => {
    for (const snap of [linuxNodeSnapshot(), linuxCswapNodeSnapshot(), windowsNodeSnapshot(), macNodeSnapshot(), oversizedNodeSnapshot()]) {
      const r = NodeSnapshotSchema.safeParse(snap);
      expect(r.success, r.success ? '' : JSON.stringify(r.error.issues[0])).toBe(true);
    }
    for (const id of Object.values(NODE_IDS)) expect(NodeIdSchema.safeParse(id).success, id).toBe(true);
    expect(NodeViewSchema.safeParse(nodeViewFixture()).success).toBe(true);
    expect(Object.keys(linuxNodeSnapshot().sessions)).toHaveLength(3);
    expect(Object.keys(linuxNodeSnapshot().pending)).toHaveLength(1);
  });

  it('plant FLEET_SECRET where the clip tests need it, at 1 MiB', () => {
    const big = oversizedNodeSnapshot();
    const [s] = Object.values(big.sessions);
    expect(s?.lastReply?.text.length).toBeGreaterThan(1024 * 1024);
    expect(s?.lastReply?.text).toContain(FLEET_SECRET);
    expect(JSON.stringify(Object.values(big.pending)[0]?.input).length).toBeGreaterThan(1024 * 1024);
  });

  it('lay out homes with .claude.json marking each account dir', () => {
    const linux = Object.keys(linuxHome({ cswap: true }).files);
    expect(linux).toContain('.claude-work/.claude.json');
    expect(linux).toContain('.local/share/claude-swap/sequence.json');
    expect(linux.some((p) => p.startsWith('.claude-scratch/') && p.endsWith('.claude.json'))).toBe(false);
    expect(Object.keys(windowsHome().files)).toContain('.claude/projects/C--Users-sam-app/.keep');
  });
});
