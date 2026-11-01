/**
 * v0.6 Fleet (wave 0): every name a wave-1 lane builds on exists where the
 * plan says, with its final signature (TypeScript checks the types; this
 * checks the runtime exports and their arity), so each lane typechecks and
 * runs alone before any other lands. Until its lane replaces it, a stub
 * stays inert: no listener, no timer, no file, and every Mac route behaves
 * as in v0.5.2.
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/core/testing.js';

describe('v0.6: the cross-lane names', () => {
  it('L1, link and auth', async () => {
    const keys = await import('../src/link/keys.js');
    const codec = await import('../src/link/codec.js');
    const join = await import('../src/link/join.js');
    const backoff = await import('../src/link/backoff.js');
    const socket = await import('../src/fleet/socket.js');
    const nodes = await import('../src/auth/nodes.js');
    const dialer = await import('../src/node/dialer.js');
    const ws = await import('../src/link/ws-client.js');
    expect([keys.signPair.length, keys.signLink.length, keys.verifyLink.length]).toEqual([3, 5, 6]);
    expect(typeof keys.loadOrCreateHubKey).toBe('function');
    expect(typeof keys.readNodeFile).toBe('function');
    expect(typeof keys.writeNodeFile).toBe('function');
    expect(typeof codec.encodeFrame).toBe('function');
    expect(typeof codec.decodeFrame).toBe('function');
    expect(typeof codec.sendWithBulk).toBe('function');
    expect(typeof codec.BulkAssembler).toBe('function');
    expect(codec.CHUNK_HIGH_WATER).toBe(2 * 1024 * 1024);
    expect(join.pairWithHub.length).toBe(2);
    expect(typeof backoff.backoffDelay).toBe('function');
    expect(socket.createLinkServer.length).toBe(3);
    expect(dialer.createDialer.length).toBe(2);
    expect(typeof nodes.NodeAuth).toBe('function');
    // ws@8.22.0 is a direct dependency, loaded through the typed wrapper.
    const mod = ws.loadWs();
    expect(typeof mod.WebSocket).toBe('function');
    expect(typeof mod.WebSocketServer).toBe('function');
  });

  it('L2, the Linux node', async () => {
    const tmux = await import('../src/terminal/tmux/index.js');
    const dirs = await import('../src/sources/cswap/dirs.js');
    expect(tmux.createTmuxBackend.length).toBeGreaterThanOrEqual(1);
    expect(tmux.JANTAR_CHANGED).toBe('JANTAR-CHANGED');
    expect(tmux.GLOB_SPECIALS).toBe('#,{}*?[]\\');
    expect(tmux.tmuxGate.length).toBe(2);
    expect(typeof tmux.tmuxWrite).toBe('function');
    expect(dirs.dirsAccounts.length).toBe(2);
    expect(typeof dirs.createDirsUsageSource).toBe('function');
    const ctx = createTestContext();
    const backend = tmux.createTmuxBackend(ctx, { socket: '/tmp/jantar-test/tmux.sock' });
    expect(backend.kind).toBe('tmux');
    expect(await backend.available()).toBe(false);
  });

  it('L3, the Windows preview', async () => {
    const config = await import('../src/config.js');
    const installer = await import('../src/hooks/installer.js');
    expect(config.pipePath.length).toBe(2);
    expect(installer.execFormHook.length).toBe(2);
    expect(installer.MIN_CLAUDE_WINDOWS).toBe('2.1.310');
  });

  it('L4, hub aggregation and the node feed', async () => {
    const fleet = await import('../src/fleet/index.js');
    const registry = await import('../src/fleet/registry.js');
    const ingest = await import('../src/fleet/ingest.js');
    const forward = await import('../src/fleet/forward.js');
    const view = await import('../src/fleet/view.js');
    const clip = await import('../src/fleet/clip.js');
    const feed = await import('../src/node/feed.js');
    const executor = await import('../src/node/executor.js');
    const node = await import('../src/node/index.js');
    expect(Object.keys(fleet)).toEqual(['createFleet']);
    expect(Object.keys(node)).toEqual(['createNodeLink']);
    expect(typeof registry.NodeRegistry).toBe('function');
    expect([ingest.ingestEvent.length, ingest.ingestSnapshot.length]).toEqual([3, 3]);
    expect([forward.targetOf.length, forward.forwardCall.length]).toEqual([4, 3]);
    expect(view.nodeViewOf.length).toBe(5);
    expect([clip.clipSession, clip.clipCard, clip.clipEvent].every((f) => f.length === 1)).toBe(true);
    expect(feed.createNodeFeed.length).toBe(1);
    expect(executor.createExecutor.length).toBe(2);
    // Inert until L4 lands: no target, so every route runs on the Mac.
    const ctx = createTestContext();
    const f = fleet.createFleet(ctx, {});
    expect(f.target('sendPrompt', { sid: 'x' }, { node: 'y' })).toBeNull();
    expect(f.list()).toEqual([]);
    expect(node.createNodeLink(ctx, { executor: executor.createExecutor(ctx, { inject: async () => ({ status: 200, body: {} }) }) }).status().state).toBe('off');
  });
});
