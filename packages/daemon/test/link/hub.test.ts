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
import { createHash, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linuxNodeSnapshot, nodeEvents, nodeSession } from '@jantar/fixtures';
import { EXTENSION_IDLE_MS, HEARTBEAT_MS, SettingsSchema } from '@jantar/protocol';
import { NODE_CLOSE, NODE_LIMITS, NODE_LINK_PATH, NODE_PROTO, type NodeCallReply, type NodeFrame } from '@jantar/protocol/node-link';
import { MAX_BUFFERED } from '../../src/api/events-ws.js';
import type { NodeFile } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { authFrame, newNonce, welcomeValid } from '../../src/link/handshake.js';
import { generateKeyPair, privateKeyOf, privateKeyPem } from '../../src/link/keys.js';
import { cleanup, joinNode, onCleanup, pass, rawNode, rawSocket, startHub, testCtx, upgrade, type RawPeer, type TestHub } from './harness.js';

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

/** A socket that upgrades by hand, then never answers anything (a close frame included). */
async function deafSocket(port: number, headers: Record<string, string>): Promise<Socket> {
  const sock = connect(port, '127.0.0.1');
  onCleanup(() => void sock.destroy());
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const key = randomBytes(16).toString('base64');
  sock.write(`GET ${NODE_LINK_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${extra}\r\n`);
  await new Promise<void>((resolve, reject) => {
    let got = '';
    sock.on('data', (c: Buffer) => {
      got += c.toString('latin1');
      if (got.startsWith('HTTP/1.1 101')) resolve();
      else if (got.includes('\r\n')) reject(new Error(got.split('\r\n')[0]));
    });
    sock.on('error', reject);
  });
  return sock;
}

/** Hold the hub's key read open (the window between a good auth and its welcome); `fail` makes the next reads fail. */
function holdHubKey(hub: TestHub) {
  const read = hub.auth.hubKey.bind(hub.auth);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let asked = 0;
  let failing = false;
  hub.auth.hubKey = async () => {
    asked += 1;
    await gate;
    if (failing) throw new Error('unreadable');
    return read();
  };
  return {
    asked: () => asked,
    release,
    fail: () => (failing = true),
    restore: () => (hub.auth.hubKey = read),
  };
}

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

  it('another link version is 4426, noted for the Machines line (only when signed) until a good link', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    // Anyone may name a node id: a forged auth still hears 4426, but the server's Machines line is not touched.
    const forged = await rawNode(hub.url, { ...node, privateKey: privateKeyPem(generateKeyPair().privateKey) }, { proto: NODE_PROTO + 1 });
    expect(await forged.closed).toBe(NODE_CLOSE.version);
    expect(hub.auth.lastRefusal(node.nodeId)).toBeNull();
    // Read before the strict parse: a newer node's auth with a field this version does not know is 4426, not 4400.
    const newer = await rawNode(hub.url, node, { proto: NODE_PROTO + 1, features: ['x'] });
    expect(await newer.closed).toBe(NODE_CLOSE.version);
    expect(hub.auth.lastRefusal(node.nodeId)).toEqual({ code: NODE_CLOSE.version, at: '2026-11-01T10:00:00.000Z' });
    // The same version with such a field is a protocol error.
    const odd = await rawNode(hub.url, node, { features: ['x'] });
    expect(await odd.closed).toBe(NODE_CLOSE.protocol);
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

  it('a server removed while the hub reads its key is refused 4401, never welcomed (S12)', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const held = holdHubKey(hub);
    const p = await rawNode(hub.url, node);
    await vi.waitFor(() => expect(held.asked()).toBe(1));
    // The revoke finds no link to close yet: the handshake must stop it itself.
    hub.auth.revoke(node.nodeId, 'cli');
    hub.linkServer.closeNode(node.nodeId, NODE_CLOSE.unknown, 'removed');
    held.release();
    expect(await p.closed).toBe(NODE_CLOSE.unknown);
    expect(p.frames.map((f) => f.k)).toEqual(['challenge']);
    expect(hub.links).toHaveLength(0);
    expect(hub.linkServer.linked()).toEqual([]);
  });

  it("while the hub reads its key a frame is 4400; a key that cannot be read is 1011 and logged", async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const held = holdHubKey(hub);
    const early = await rawNode(hub.url, node);
    await vi.waitFor(() => expect(held.asked()).toBe(1));
    early.send({ k: 'heartbeat', ts: '2026-11-01T10:00:00.000Z' });
    expect(await early.closed).toBe(NODE_CLOSE.protocol);
    held.release();
    held.fail();
    const broken = await rawNode(hub.url, node);
    expect(await broken.closed).toBe(1011);
    expect(broken.frames.map((f) => f.k)).toEqual(['challenge']);
    expect(hub.ctx.log.records.some((r) => r.level === 'error' && /hub's key could not be read/.test(r.msg))).toBe(true);
    held.restore();
    await linked(hub, node);
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

  it('a fifth bulk at once is one too many (4400); the calls waiting (already sent) end node_timeout', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const p = await linked(hub, node);
    const calls: Promise<NodeCallReply>[] = [];
    for (let i = 0; i < NODE_LIMITS.bulkInFlight + 1; i += 1) calls.push(hub.links[0]!.link.call({ id: `c${i}`, route: 'getTranscript', params: { sid: 's1' }, query: {}, actor: ACTOR }));
    await vi.waitFor(() => expect(p.frames.filter((f) => f.k === 'call')).toHaveLength(NODE_LIMITS.bulkInFlight + 1));
    for (let i = 0; i < NODE_LIMITS.bulkInFlight + 1; i += 1) p.send({ k: 'result', id: `c${i}`, status: 200, bulk: { size: 10, sha256: 'a'.repeat(64) } });
    expect(await p.closed).toBe(NODE_CLOSE.protocol);
    for (const r of await Promise.all(calls)) expect(r).toMatchObject({ status: 504, body: { error: { code: 'node_timeout' } } });
  });

  it('a corrupted result chunk closes 4400 and the call ends node_timeout; a good bulk answers it', async () => {
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
    expect(await broken).toMatchObject({ status: 504, body: { error: { code: 'node_timeout' } } });
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

  it("a flood of heartbeats reads the server's row at most once every 5 s", async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const p = await linked(hub, node);
    const reads = vi.spyOn(hub.ctx.db.nodes, 'get');
    const flood = async (ts: string, events: number): Promise<void> => {
      for (let i = 0; i < 50; i += 1) p.send({ k: 'heartbeat', ts });
      p.send({ k: 'event', event: nodeEvents.sessionRemoved('7a1c0000-0000-4000-8000-000000000041') });
      await vi.waitFor(() => expect(hub.links[0]!.events).toHaveLength(events));
    };
    await flood('2026-11-01T10:00:00.000Z', 1);
    expect(reads).not.toHaveBeenCalled();
    hub.ctx.clock.advance(5000);
    await flood('2026-11-01T10:00:05.000Z', 2);
    expect(reads).toHaveBeenCalledTimes(1);
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

  it('a late result is taken for the last 64 calls that timed out; one older than that is 4400', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const p = await linked(hub, node);
    const link = hub.links[0]!.link;
    // Five rounds of sixteen: c0..c79 all time out.
    for (let r = 0; r < 5; r += 1) {
      const calls = Array.from({ length: NODE_LIMITS.callsInFlight }, (_v, i) =>
        link.call({ id: `c${r * NODE_LIMITS.callsInFlight + i}`, route: 'getScreen', params: { sid: 's1' }, query: {}, actor: ACTOR }),
      );
      await pass(hub.ctx.clock, NODE_LIMITS.callTimeoutMs);
      for (const c of await Promise.all(calls)) expect(c.status).toBe(504);
    }
    // The newest 64 (c16..c79) are dropped quietly when they come.
    p.send({ k: 'result', id: 'c79', status: 200, body: {} });
    p.send({ k: 'result', id: 'c16', status: 200, body: {} });
    p.send({ k: 'event', event: nodeEvents.sessionRemoved('7a1c0000-0000-4000-8000-000000000041') });
    await vi.waitFor(() => expect(hub.links[0]!.events).toHaveLength(1));
    expect(hub.links[0]!.closes).toEqual([]);
    p.send({ k: 'result', id: 'c15', status: 200, body: {} });
    expect(await p.closed).toBe(NODE_CLOSE.protocol);
  });

  it('a send buffer over MAX_BUFFERED is 1013', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const p = await linked(hub, node);
    // The socket behind the link, made to look backed up (a server reading nothing for minutes).
    const ws = (hub.links[0]!.link as unknown as { ws: object }).ws;
    Object.defineProperty(ws, 'bufferedAmount', { get: () => MAX_BUFFERED + 1 });
    hub.ctx.clock.advance(HEARTBEAT_MS);
    expect(await p.closed).toBe(NODE_CLOSE.slow);
    expect(hub.links[0]!.closes).toEqual([NODE_CLOSE.slow]);
  });

  it('closing a link with a code no close frame carries (1006) cuts the socket instead of throwing', async () => {
    const hub = await startHub();
    const { node } = await joinNode(hub);
    const p = await linked(hub, node);
    expect(() => hub.links[0]!.link.close(1006, 'dropped')).not.toThrow();
    expect(hub.links[0]!.closes).toEqual([1006]);
    expect(await p.closed).toBe(1006);
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

  it('a socket that never answers, nor closes back after its 4408, gives its place up at once', async () => {
    const hub = await cloudflareHub();
    const deaf = await Promise.all(Array.from({ length: NODE_LIMITS.unauthSockets }, (_v, i) => deafSocket(hub.port, ip(i))));
    expect((await upgrade(hub.url, ip(50))).status).toBe(429);
    hub.ctx.clock.advance(NODE_LIMITS.handshakeMs);
    // Each was sent its close frame and none closed back (ws would wait 30 s for that): the places are free now all the same.
    expect((await upgrade(hub.url, ip(51))).status).toBe(101);
    for (const d of deaf) expect(d.destroyed).toBe(false);
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
