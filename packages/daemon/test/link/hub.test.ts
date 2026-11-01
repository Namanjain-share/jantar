/**
 * v0.6 Fleet, the hub's link server over real `ws` on port 0 (S6, S10, S12,
 * S13), with raw peers speaking the protocol by hand: what it takes to link
 * (auth signed over a fresh challenge by a key on record, the same link
 * version, within 10 s, nothing before it), what ends a link (4401 for a
 * revoked or idle key, 4409 for an older link with the key, 4400 for any
 * frame a server may not send or a bad bulk, 1009 past 1 MiB, a server that
 * stops answering pings), and the budgets: the handshake limiter per caller
 * and the cap on sockets not yet authenticated, both grown by the paired
 * servers.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linuxNodeSnapshot, nodeEvents, nodeSession } from '@jantar/fixtures';
import { EXTENSION_IDLE_MS, HEARTBEAT_MS, SettingsSchema } from '@jantar/protocol';
import { NODE_CLOSE, NODE_LIMITS, NODE_PROTO, type NodeCallReply, type NodeFrame } from '@jantar/protocol/node-link';
import type { NodeFile } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { authFrame, newNonce, welcomeValid } from '../../src/link/handshake.js';
import { generateKeyPair, privateKeyOf, privateKeyPem } from '../../src/link/keys.js';
import { cleanup, joinNode, pass, rawNode, rawSocket, startHub, testCtx, upgrade, type RawPeer, type TestHub } from './harness.js';

afterEach(cleanup);

const OTHER_ID = '01JN0DE0000000000000000009';
const ACTOR = { deviceId: 'dev1', deviceName: 'iPhone', scopes: ['read' as const] };
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A hub whose front door is Cloudflare, so each test socket picks its own rate key (CF-Connecting-IP from loopback). */
async function cloudflareHub(): Promise<TestHub> {
  const settings = SettingsSchema.parse({ fleet: { enabled: true }, remote: { mode: 'cloudflare', publicUrl: 'https://jantar.example.com' } });
  return startHub({ ctx: await testCtx({ settings, clock: new FakeClock(Date.parse('2026-11-01T10:00:00.000Z')) }) });
}

/** A raw node through the handshake and its snapshot: a live link on the hub. */
async function linked(hub: TestHub, node: NodeFile, opts: { autoPong?: boolean } = {}): Promise<RawPeer> {
  const before = hub.links.length;
  const p = await rawNode(hub.url, node, {}, opts);
  await p.next('welcome');
  p.send({ k: 'snapshot', state: linuxNodeSnapshot() });
  await vi.waitFor(() => expect(hub.links[before]?.snapshots).toHaveLength(1));
  return p;
}

const ip = (n: number): Record<string, string> => ({ 'CF-Connecting-IP': `198.51.100.${n}` });

describe('the handshake', () => {
  it("welcome: the name the Mac gave, signed with the pinned key over both nonces; a fresh challenge every time", async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub, { name: 'build-1' });
    const p = await rawNode(hub.url, node);
    const w = (await p.next('welcome')) as Extract<NodeFrame, { k: 'welcome' }>;
    expect(w.name).toBe('build-1');
    expect(welcomeValid(node.hubKey, node.nodeId, p.hubNonce, p.nodeNonce, w)).toBe(true);
    // Not a signature over any other pair of nonces.
    expect(welcomeValid(node.hubKey, node.nodeId, p.nodeNonce, p.hubNonce, w)).toBe(false);
    await vi.waitFor(() => expect(hub.links).toHaveLength(1));
    expect(hub.links[0]!.link.info).toEqual({ os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: false, accessRefused: 0 });
    expect(hub.linkServer.linked()).toEqual([node.nodeId]);
    const again = await rawSocket(hub.url);
    const c = (await again.next('challenge')) as Extract<NodeFrame, { k: 'challenge' }>;
    expect(c.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.nonce).not.toBe(p.hubNonce);
  });

  it('a recorded auth fails against a new challenge (4401), and nothing links', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const first = await rawNode(hub.url, node);
    await first.next('welcome');
    first.ws.close(1000);
    await first.closed;
    const replay = await rawSocket(hub.url);
    await replay.next('challenge');
    replay.send(first.auth);
    expect(await replay.closed).toBe(NODE_CLOSE.unknown);
    expect(replay.frames.map((f) => f.k)).toEqual(['challenge']);
    expect(hub.links).toHaveLength(1);
  });

  it('a key not on record, another key, a revoked or an idle server: 4401, never a welcome', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const stranger = await rawNode(hub.url, { ...node, nodeId: OTHER_ID });
    expect(await stranger.closed).toBe(NODE_CLOSE.unknown);
    const wrongKey = await rawNode(hub.url, { ...node, privateKey: privateKeyPem(generateKeyPair().privateKey) });
    expect(await wrongKey.closed).toBe(NODE_CLOSE.unknown);
    // Idle: unseen for 90 days, revoked when it next connects.
    const { node: idle } = await joinNode(hub);
    hub.ctx.clock.advance(EXTENSION_IDLE_MS + 1000);
    const late = await rawNode(hub.url, idle);
    expect(await late.closed).toBe(NODE_CLOSE.unknown);
    expect(hub.ctx.db.nodes.get(idle.nodeId)?.revokedAt).not.toBeNull();
    // Revoked: refused at once.
    hub.auth.revoke(node.nodeId, 'cli');
    const revoked = await rawNode(hub.url, node);
    expect(await revoked.closed).toBe(NODE_CLOSE.unknown);
    for (const p of [stranger, wrongKey, late, revoked]) expect(p.frames.map((f) => f.k)).toEqual(['challenge']);
    expect(hub.links).toHaveLength(0);
  });

  it('another link version is 4426, noted for the Machines line until a good link', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const newer = await rawNode(hub.url, node, { proto: NODE_PROTO + 1 });
    expect(await newer.closed).toBe(NODE_CLOSE.version);
    expect(hub.auth.lastRefusal(node.nodeId)).toEqual({ code: NODE_CLOSE.version, at: '2026-11-01T10:00:00.000Z' });
    await linked(hub, node);
    expect(hub.auth.lastRefusal(node.nodeId)).toBeNull();
  });

  it('nothing but auth before it (4400); no auth within 10 s is 4408', async () => {
    const hub = await startHub();
    const first: Record<string, unknown>[] = [
      { k: 'heartbeat', ts: '2026-11-01T10:00:00.000Z' },
      { k: 'snapshot', state: linuxNodeSnapshot() },
      { k: 'result', id: 'c1', status: 200, body: {} },
      { k: 'gossip' },
    ];
    for (const frame of first) {
      const p = await rawSocket(hub.url);
      await p.next('challenge');
      p.send(frame);
      expect(await p.closed, String(frame.k)).toBe(NODE_CLOSE.protocol);
    }
    const garbage = await rawSocket(hub.url);
    await garbage.next('challenge');
    garbage.sendText('not json');
    expect(await garbage.closed).toBe(NODE_CLOSE.protocol);
    const silent = await rawSocket(hub.url);
    await silent.next('challenge');
    hub.ctx.clock.advance(NODE_LIMITS.handshakeMs - 1);
    hub.ctx.clock.advance(1);
    expect(await silent.closed).toBe(NODE_CLOSE.handshakeTimeout);
  });

  it('the newest link with a key wins: the older closes 4409, and that is logged', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const older = await linked(hub, node);
    const newer = await linked(hub, node);
    expect(await older.closed).toBe(NODE_CLOSE.replaced);
    expect(hub.links.map((l) => l.closes)).toEqual([[NODE_CLOSE.replaced], []]);
    expect(hub.linkServer.linked()).toEqual([node.nodeId]);
    expect(hub.ctx.log.records.some((r) => r.level === 'warn' && /replaced a server link/.test(r.msg))).toBe(true);
    // The newer one works.
    newer.send({ k: 'event', event: nodeEvents.sessionAdded(nodeSession({ sid: '7a1c0000-0000-4000-8000-000000000077' })) });
    await vi.waitFor(() => expect(hub.links[1]!.events).toHaveLength(1));
  });
});

describe('a live link', () => {
  it('a server may not call, auth again, send events before its snapshot, or a second snapshot (4400)', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const snap = { k: 'snapshot', state: linuxNodeSnapshot() };
    const event = { k: 'event', event: nodeEvents.sessionRemoved('7a1c0000-0000-4000-8000-000000000041') };
    const cases: [string, (p: RawPeer & { auth: NodeFrame }) => void][] = [
      ['a call', (p) => p.send({ k: 'call', id: 'c1', route: 'getScreen', params: { sid: 's1' }, query: {}, actor: ACTOR })],
      ['a challenge', (p) => p.send({ k: 'challenge', v: 1, nonce: 'A'.repeat(43) })],
      ['auth again', (p) => p.send(p.auth)],
      ['an event before the snapshot', (p) => p.send(event)],
      ['a second snapshot', (p) => (p.send(snap), p.send(snap))],
      ['a chunk for no bulk', (p) => (p.send(snap), p.send({ k: 'chunk', id: 'x', i: 0, data: 'AAAA' }))],
      ['a result for no call', (p) => (p.send(snap), p.send({ k: 'result', id: 'c9', status: 200, body: {} }))],
      ['a known kind of the wrong shape', (p) => (p.send(snap), p.send({ k: 'heartbeat', ts: 5 }))],
      ['a binary frame', (p) => (p.send(snap), p.sendBinary(Buffer.from('{"k":"heartbeat"}')))],
      ['a snapshot bulk over 16 MiB', (p) => p.send({ k: 'snapshot', bulk: { size: NODE_LIMITS.bulkToHubBytes + 1, sha256: 'a'.repeat(64) } })],
    ];
    for (const [name, act] of cases) {
      const p = await rawNode(hub.url, node);
      await p.next('welcome');
      await vi.waitFor(() => expect(hub.linkServer.linked()).toEqual([node.nodeId]));
      const record = hub.links[hub.links.length - 1]!;
      act(p);
      expect(await p.closed, name).toBe(NODE_CLOSE.protocol);
      await vi.waitFor(() => expect(record.closes, name).toEqual([NODE_CLOSE.protocol]));
    }
    // Each is logged by kind and size, never a body.
    const logged = JSON.stringify(hub.ctx.log.records);
    expect(logged).toContain('server link protocol error');
    expect(logged).not.toContain('7a1c0000-0000-4000-8000-000000000041');
  });

  it('a snapshot bulk whose bytes do not match its sha256 closes 4400; a good one arrives whole', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const bytes = Buffer.from(JSON.stringify(linuxNodeSnapshot()));
    const bad = await rawNode(hub.url, node);
    await bad.next('welcome');
    bad.send({ k: 'snapshot', bulk: { size: bytes.length, sha256: sha256(Buffer.from('other')) } });
    bad.send({ k: 'chunk', id: 'snapshot', i: 0, data: bytes.toString('base64') });
    expect(await bad.closed).toBe(NODE_CLOSE.protocol);
    expect(hub.links[0]!.snapshots).toEqual([]);
    const good = await rawNode(hub.url, node);
    await good.next('welcome');
    good.send({ k: 'snapshot', bulk: { size: bytes.length, sha256: sha256(bytes) } });
    // Other frames may go between a bulk's chunks.
    good.send({ k: 'heartbeat', ts: '2026-11-01T10:00:00.000Z' });
    good.send({ k: 'chunk', id: 'snapshot', i: 0, data: bytes.subarray(0, 100).toString('base64') });
    good.send({ k: 'chunk', id: 'snapshot', i: 1, data: bytes.subarray(100).toString('base64') });
    await vi.waitFor(() => expect(hub.links[1]!.snapshots).toEqual([linuxNodeSnapshot()]));
  });

  it('a fifth bulk at once is one too many (4400); the calls waiting end node_offline', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const p = await linked(hub, node);
    const calls: Promise<NodeCallReply>[] = [];
    for (let i = 0; i < NODE_LIMITS.bulkInFlight + 1; i += 1) calls.push(hub.links[0]!.link.call({ id: `c${i}`, route: 'getTranscript', params: { sid: 's1' }, query: {}, actor: ACTOR }));
    await vi.waitFor(() => expect(p.frames.filter((f) => f.k === 'call')).toHaveLength(NODE_LIMITS.bulkInFlight + 1));
    for (let i = 0; i < NODE_LIMITS.bulkInFlight + 1; i += 1) p.send({ k: 'result', id: `c${i}`, status: 200, bulk: { size: 10, sha256: 'a'.repeat(64) } });
    expect(await p.closed).toBe(NODE_CLOSE.protocol);
    for (const r of await Promise.all(calls)) expect(r).toMatchObject({ status: 503, body: { error: { code: 'node_offline' } } });
  });

  it('a corrupted result chunk closes 4400 and the call ends node_offline; a good bulk answers it', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const body = Buffer.from(JSON.stringify({ items: ['x'.repeat(2000)] }));
    const p = await linked(hub, node);
    const ok = hub.links[0]!.link.call({ id: 'c1', route: 'getTranscript', params: { sid: 's1' }, query: {}, actor: ACTOR });
    await p.next('call');
    p.send({ k: 'result', id: 'c1', status: 200, bulk: { size: body.length, sha256: sha256(body) } });
    p.send({ k: 'chunk', id: 'c1', i: 0, data: body.toString('base64') });
    expect(await ok).toEqual({ status: 200, body: { items: ['x'.repeat(2000)] } });
    const broken = hub.links[0]!.link.call({ id: 'c2', route: 'getTranscript', params: { sid: 's1' }, query: {}, actor: ACTOR });
    await vi.waitFor(() => expect(p.frames.filter((f) => f.k === 'call')).toHaveLength(2));
    p.send({ k: 'result', id: 'c2', status: 200, bulk: { size: body.length, sha256: sha256(body) } });
    const flipped = Buffer.from(body);
    flipped[5] = flipped[5]! ^ 1;
    p.send({ k: 'chunk', id: 'c2', i: 0, data: flipped.toString('base64') });
    expect(await broken).toMatchObject({ status: 503, body: { error: { code: 'node_offline' } } });
    expect(await p.closed).toBe(NODE_CLOSE.protocol);
  });

  it('an unknown kind after welcome is ignored (a newer node); a frame over 1 MiB closes 1009', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const p = await linked(hub, node);
    p.send({ k: 'gossip', x: 1 });
    p.send({ k: 'event', event: nodeEvents.sessionRemoved('7a1c0000-0000-4000-8000-000000000041') });
    await vi.waitFor(() => expect(hub.links[0]!.events).toHaveLength(1));
    p.sendText(JSON.stringify({ k: 'heartbeat', ts: 'x'.repeat(NODE_LIMITS.frameBytes) }));
    expect(await p.closed).toBe(NODE_CLOSE.tooBig);
    await vi.waitFor(() => expect(hub.links[0]!.closes).toEqual([NODE_CLOSE.tooBig]));
  });

  it('liveness: pings and app heartbeats every 20 s; a server that stops answering pings is dropped', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const healthy = await linked(hub, node);
    await pass(hub.ctx.clock, HEARTBEAT_MS * 3);
    expect(healthy.frames.filter((f) => f.k === 'heartbeat').length).toBeGreaterThanOrEqual(3);
    expect(hub.links[0]!.closes).toEqual([]);
    healthy.ws.close(1000);
    await vi.waitFor(() => expect(hub.links[0]!.closes).toEqual([1000]));
    const deaf = await linked(hub, node, { autoPong: false });
    hub.ctx.clock.advance(HEARTBEAT_MS);
    await deaf.next('heartbeat');
    hub.ctx.clock.advance(HEARTBEAT_MS);
    expect(await deaf.closed).toBe(1006);
    expect(hub.links[1]!.closes).toEqual([1006]);
  });

  it("a server's heartbeat keeps lastSeenAt fresh, written at most every 5 minutes", async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const p = await linked(hub, node);
    expect(hub.ctx.db.nodes.get(node.nodeId)?.lastSeenAt).toBe('2026-11-01T10:00:00.000Z');
    await pass(hub.ctx.clock, 60_000);
    p.send({ k: 'heartbeat', ts: '2026-11-01T10:01:00.000Z' });
    await pass(hub.ctx.clock, 5000);
    expect(hub.ctx.db.nodes.get(node.nodeId)?.lastSeenAt).toBe('2026-11-01T10:00:00.000Z');
    await pass(hub.ctx.clock, 5 * 60_000);
    p.send({ k: 'heartbeat', ts: '2026-11-01T10:06:05.000Z' });
    await vi.waitFor(() => expect(hub.ctx.db.nodes.get(node.nodeId)?.lastSeenAt).toBe('2026-11-01T10:06:05.000Z'));
  });

  it('revocation works at once: 4401 now, and the next handshake is refused (S12)', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const p = await linked(hub, node);
    hub.auth.revoke(node.nodeId, 'cli');
    hub.linkServer.closeNode(node.nodeId, NODE_CLOSE.unknown, 'removed');
    // The owner hears it at once, before the socket finishes closing.
    expect(hub.links[0]!.closes).toEqual([NODE_CLOSE.unknown]);
    expect(await p.closed).toBe(NODE_CLOSE.unknown);
    const again = await rawNode(hub.url, node);
    expect(await again.closed).toBe(NODE_CLOSE.unknown);
  });

  it('Fleet off closes every link and every half-open socket 4403; stopping closes 1001 and refuses new ones', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const live = await linked(hub, node);
    const half = await rawSocket(hub.url);
    await half.next('challenge');
    hub.linkServer.closeAll(NODE_CLOSE.fleetOff, 'Fleet is off');
    expect(await live.closed).toBe(NODE_CLOSE.fleetOff);
    expect(await half.closed).toBe(NODE_CLOSE.fleetOff);
    const next = await linked(hub, node);
    await hub.linkServer.stop();
    expect(await next.closed).toBe(NODE_CLOSE.goingAway);
    expect(await upgrade(hub.url)).toMatchObject({ status: 404 });
  });
});

describe('budgets', () => {
  it('sockets not yet authenticated: at most 8 + paired servers at once (429, retry-after); freed as they go or link', async () => {
    const hub = await cloudflareHub();
    const { node } = await joinNode(hub);
    const cap = NODE_LIMITS.unauthSockets + 1;
    const open: RawPeer[] = [];
    for (let i = 0; i < cap; i += 1) {
      const u = await upgrade(hub.url, ip(i));
      if (!u.open) throw new Error(`socket ${i}: ${u.status}`);
      open.push(u.peer);
    }
    const over = await upgrade(hub.url, ip(100));
    expect(over).toMatchObject({ status: 429, headers: { 'retry-after': '5' } });
    // One goes: a place is free again.
    open[0]!.ws.close(1000);
    await open[0]!.closed;
    let n = 200;
    await vi.waitFor(async () => expect((await upgrade(hub.url, ip((n += 1)))).status).toBe(101));
    // A socket that links frees its place too.
    const p = open[1]!;
    const c = (await p.next('challenge')) as Extract<NodeFrame, { k: 'challenge' }>;
    p.send(authFrame(privateKeyOf(node.privateKey)!, node.nodeId, c.nonce, newNonce(), { os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: false }, 0));
    await p.next('welcome');
    await vi.waitFor(async () => expect((await upgrade(hub.url, ip((n += 1)))).status).toBe(101));
  });

  it('handshakes: 10 + 2 x paired servers a minute per caller (429, retry-after); other callers are not held back', async () => {
    const hub = await cloudflareHub();
    await joinNode(hub);
    await joinNode(hub);
    const limit = NODE_LIMITS.handshakesPerMin + NODE_LIMITS.handshakesPerNode * 2;
    for (let i = 0; i < limit; i += 1) {
      const u = await upgrade(hub.url, ip(1));
      expect(u.status, String(i)).toBe(101);
      if (u.open) {
        u.peer.ws.close(1000);
        await u.peer.closed;
      }
    }
    const refused = await upgrade(hub.url, ip(1));
    expect(refused).toMatchObject({ status: 429, headers: { 'retry-after': '60' } });
    expect(!refused.open && JSON.parse(refused.body)).toEqual({ error: { code: 'rate_limited', message: 'Too many link attempts: try again in a minute' } });
    expect((await upgrade(hub.url, ip(2))).status).toBe(101);
    hub.ctx.clock.advance(60_000);
    expect((await upgrade(hub.url, ip(1))).status).toBe(101);
  });

  it('the budgets grow with each server paired', async () => {
    const hub = await cloudflareHub();
    for (let i = 0; i < NODE_LIMITS.unauthSockets; i += 1) expect((await upgrade(hub.url, ip(i))).status).toBe(101);
    expect((await upgrade(hub.url, ip(50))).status).toBe(429);
    await joinNode(hub);
    await joinNode(hub);
    expect((await upgrade(hub.url, ip(51))).status).toBe(101);
    expect((await upgrade(hub.url, ip(52))).status).toBe(101);
    expect((await upgrade(hub.url, ip(53))).status).toBe(429);
  });
});
