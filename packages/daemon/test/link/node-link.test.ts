/**
 * v0.6 Fleet, a node's link part (node/index.ts) against the real hub over
 * real `ws` on port 0: on each verified link the feed sends the snapshot
 * from the node's own store, then its events; the hub's calls go to the
 * executor; what the node says of itself rides in its auth; status() is the
 * dialler's, and stop() ends the link.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeSession } from '@jantar/fixtures';
import { NODE_CLOSE, type NodeCallRequest } from '@jantar/protocol/node-link';
import { thisNodeOs } from '../../src/link/handshake.js';
import { createNodeLink } from '../../src/node/index.js';
import { cleanup, joinNode, onCleanup, startHub } from './harness.js';

afterEach(cleanup);

const SID = '7a1c0000-0000-4000-8000-000000000051';

describe('createNodeLink', () => {
  it('links, sends the snapshot then its events, runs the hub calls through the executor, and stops', async () => {
    const hub = await startHub();
    const { ctx, node } = await joinNode(hub, { name: 'build-1' });
    const runs: NodeCallRequest[] = [];
    const nodeLink = createNodeLink(ctx, {
      executor: { run: async (req) => (runs.push(req), { status: 200, body: { ran: req.route } }) },
      self: { backend: 'tmux', readOnly: true },
    });
    onCleanup(() => nodeLink.stop());
    expect(nodeLink.status().state).toBe('off');
    await nodeLink.start();
    await vi.waitFor(() => expect(hub.links[0]?.snapshots).toHaveLength(1));
    const r = hub.links[0]!;
    expect(r.link.info).toEqual({ os: thisNodeOs(), version: ctx.version.daemon, backend: 'tmux', readOnly: true, accessRefused: 0 });
    expect(nodeLink.status()).toMatchObject({ state: 'linked', name: 'build-1', hubHost: '127.0.0.1' });
    // A session the node starts after the snapshot reaches the hub as an event.
    ctx.store.emit({ type: 'session.added', sid: SID, data: { session: nodeSession({ sid: SID }) } });
    await vi.waitFor(() => expect(r.events.map((e) => (e as { type: string; sid?: string }).sid)).toContain(SID));
    const req: NodeCallRequest = { id: 'c1', route: 'getScreen', params: { sid: SID }, query: {}, actor: { deviceId: 'dev1', deviceName: 'iPhone', scopes: ['read'] } };
    expect(await r.link.call(req)).toEqual({ status: 200, body: { ran: 'getScreen' } });
    expect(runs).toEqual([req]);
    await nodeLink.stop();
    await vi.waitFor(() => expect(r.closes).toEqual([NODE_CLOSE.goingAway]));
    expect(nodeLink.status().state).toBe('off');
    expect(hub.ctx.db.nodes.get(node.nodeId)?.revokedAt).toBeNull();
  });

  it('a link that drops detaches the feed; the next link starts with a fresh snapshot', async () => {
    const hub = await startHub();
    const { ctx, node } = await joinNode(hub);
    const nodeLink = createNodeLink(ctx, { executor: { run: async () => ({ status: 200, body: {} }) } });
    onCleanup(() => nodeLink.stop());
    await nodeLink.start();
    await vi.waitFor(() => expect(hub.links[0]?.snapshots).toHaveLength(1));
    hub.linkServer.closeNode(node.nodeId, NODE_CLOSE.goingAway, 'going away');
    ctx.store.emit({ type: 'session.added', sid: SID, data: { session: nodeSession({ sid: SID }) } });
    await vi.waitFor(() => expect(nodeLink.status().state).toBe('waiting'));
    ctx.clock.advance(Date.parse(nodeLink.status().retryAt!) - ctx.clock.now());
    await vi.waitFor(() => expect(hub.links[1]?.snapshots).toHaveLength(1));
    // The session started while the link was down is in the new snapshot, not replayed as an event.
    expect(Object.keys(hub.links[1]!.snapshots[0]!.sessions)).toContain(SID);
    expect(hub.links[0]!.events).toEqual([]);
    expect(hub.links[1]!.events).toEqual([]);
  });
});

describe('thisNodeOs', () => {
  it('macOS, Windows, Linux, and Linux inside WSL2 (microsoft in osrelease)', () => {
    const never = (): string => {
      throw new Error('osrelease is read on Linux only');
    };
    expect(thisNodeOs('darwin', never)).toBe('macos');
    expect(thisNodeOs('win32', never)).toBe('windows');
    expect(thisNodeOs('linux', () => '6.8.0-45-generic\n')).toBe('linux');
    expect(thisNodeOs('linux', () => '5.15.153.1-microsoft-standard-WSL2\n')).toBe('wsl');
    expect(thisNodeOs('linux', () => '4.4.0-19041-Microsoft\n')).toBe('wsl');
    expect(thisNodeOs('linux', () => '')).toBe('linux');
  });
});
