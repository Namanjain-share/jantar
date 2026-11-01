/**
 * v0.6 Fleet, the link end to end over real `ws` on port 0 (loopback http):
 * a paired node's dialler and the hub's link server. The handshake both
 * ways, the snapshot first then events, calls and their answers, and the
 * bulks both ways (S10, S13): a 3 MB result, a 20 MiB upload and a snapshot
 * over a frame cross with the right sha256. HubLink.call never rejects
 * (node_offline, node_timeout, 429 past 16 in flight; a call already sent
 * when the link drops is node_timeout, never "Nothing was sent"); an upload
 * the node refuses 429 never drops the link. Nothing a frame carries
 * reaches a log (S14).
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SECRET, linuxNodeSnapshot, nodeEvents, nodeSession, oversizedNodeSnapshot } from '@jantar/fixtures';
import { errorBody } from '@jantar/protocol';
import { NODE_CLOSE, NODE_LIMITS, NodeSnapshotSchema, type NodeCallReply, type NodeCallRequest } from '@jantar/protocol/node-link';
import { MAX_BUFFERED } from '../../src/api/events-ws.js';
import type { NodeFile, NodeLink } from '../../src/contracts.js';
import type { FakeClock } from '../../src/core/clock.js';
import type { TestContext } from '../../src/core/testing.js';
import type { NodeSelf } from '../../src/link/handshake.js';
import { createDialer } from '../../src/node/dialer.js';
import { cleanup, joinNode, onCleanup, pass, startHub, type TestHub } from './harness.js';

afterEach(cleanup);

const SELF: NodeSelf = { os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: false };
const ACTOR = { deviceId: 'dev1', deviceName: 'iPhone', scopes: ['read' as const, 'control' as const] };
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

type CallFn = (req: NodeCallRequest, bulk?: Buffer) => Promise<NodeCallReply>;

interface TestNode {
  ctx: TestContext & { clock: FakeClock };
  node: NodeFile;
  links: NodeLink[];
  dialer: ReturnType<typeof createDialer>;
}

async function startNode(hub: TestHub, opts: { onCall?: CallFn; self?: Partial<NodeSelf> } = {}): Promise<TestNode> {
  const { ctx, node } = await joinNode(hub);
  const links: NodeLink[] = [];
  const dialer = createDialer(ctx, ctx.paths.nodeFile, () => ({ ...SELF, ...opts.self }));
  onCleanup(() => dialer.stop());
  dialer.start((link) => {
    links.push(link);
    link.onCall(opts.onCall ?? (async (req) => ({ status: 200, body: { ran: req.route } })));
  });
  await vi.waitFor(() => expect(links).toHaveLength(1));
  await vi.waitFor(() => expect(hub.links).toHaveLength(1));
  return { ctx, node, links, dialer };
}

const call = (id: string, route: NodeCallRequest['route'], over: Partial<NodeCallRequest> = {}): NodeCallRequest => ({
  id,
  route,
  params: { sid: 's1' },
  query: {},
  actor: ACTOR,
  ...over,
});

describe('a paired node links', () => {
  it('the hub sees who it is; the node is told its name; status says linked', async () => {
    const hub = await startHub();
    const n = await startNode(hub, { self: { readOnly: true, backend: 'tmux' } });
    const h = hub.links[0]!.link;
    expect(h.nodeId).toBe(n.node.nodeId);
    expect(h.info).toEqual({ os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: true, accessRefused: 0 });
    expect(n.dialer.status()).toMatchObject({ state: 'linked', name: n.node.name, hubHost: '127.0.0.1', accessRefused: 0, retryAt: null });
    expect(hub.linkServer.linked()).toEqual([n.node.nodeId]);
    // Linking touched lastSeenAt.
    expect(hub.ctx.db.nodes.get(n.node.nodeId)?.lastSeenAt).toBe('2026-11-01T10:00:00.000Z');
  });

  it('the snapshot goes first, then events in order (events sent before it wait for it)', async () => {
    const hub = await startHub();
    const n = await startNode(hub);
    const link = n.links[0]!;
    const s = nodeSession({ sid: '7a1c0000-0000-4000-8000-000000000099' });
    link.sendEvent(nodeEvents.sessionAdded(s));
    link.sendSnapshot(linuxNodeSnapshot());
    link.sendEvent(nodeEvents.sessionRemoved(s.sid));
    const r = hub.links[0]!;
    await vi.waitFor(() => expect(r.events).toHaveLength(2));
    expect(r.snapshots).toEqual([linuxNodeSnapshot()]);
    expect(r.events.map((e) => (e as { type: string }).type)).toEqual(['session.added', 'session.removed']);
    expect(r.closes).toEqual([]);
  });

  it('a snapshot larger than a frame crosses as a bulk, whole, and events still follow it', async () => {
    const hub = await startHub();
    const n = await startNode(hub);
    const big = oversizedNodeSnapshot();
    expect(JSON.stringify(big).length).toBeGreaterThan(NODE_LIMITS.frameBytes);
    n.links[0]!.sendSnapshot(big);
    n.links[0]!.sendEvent(nodeEvents.sessionRemoved(Object.keys(big.sessions)[0]!));
    const r = hub.links[0]!;
    await vi.waitFor(() => expect(r.events).toHaveLength(1));
    expect(r.snapshots).toHaveLength(1);
    // The hub hands on what its schema parsed: the same value, keys in schema order.
    expect(sha256(Buffer.from(JSON.stringify(r.snapshots[0])))).toBe(sha256(Buffer.from(JSON.stringify(NodeSnapshotSchema.parse(big)))));
    // A second snapshot is never sent on one link.
    n.links[0]!.sendSnapshot(big);
    await new Promise((res) => setTimeout(res, 30));
    expect(r.closes).toEqual([]);
  });

  it('a call runs on the node and its answer comes back', async () => {
    const hub = await startHub();
    const seen: NodeCallRequest[] = [];
    await startNode(hub, {
      onCall: async (req) => {
        seen.push(req);
        return { status: 202, body: { ok: true, route: req.route } };
      },
    });
    const req = call('c1', 'sendPrompt', { body: { text: 'hi' }, idem: 'dev1:k1', query: { a: 'b' } });
    expect(await hub.links[0]!.link.call(req)).toEqual({ status: 202, body: { ok: true, route: 'sendPrompt' } });
    expect(seen).toEqual([req]);
  });

  it('a 3 MB result crosses as a bulk with the right bytes', async () => {
    const hub = await startHub();
    const text = 'z'.repeat(3_000_000);
    await startNode(hub, { onCall: async () => ({ status: 200, body: { items: [{ text }] } }) });
    const reply = await hub.links[0]!.link.call(call('c1', 'getTranscript'));
    expect(reply.status).toBe(200);
    expect(sha256(Buffer.from(JSON.stringify(reply.body)))).toBe(sha256(Buffer.from(JSON.stringify({ items: [{ text }] }))));
  });

  it('a 20 MiB upload crosses to the node as a bulk with the same sha256', async () => {
    const hub = await startHub();
    const got: { req: NodeCallRequest; sha: string; size: number }[] = [];
    await startNode(hub, {
      onCall: async (req, bulk) => {
        got.push({ req, sha: bulk ? sha256(bulk) : '', size: bulk?.length ?? 0 });
        return { status: 201, body: { id: 'u1' } };
      },
    });
    const bytes = Buffer.alloc(NODE_LIMITS.bulkToNodeBytes);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
    const reply = await hub.links[0]!.link.call(call('u1', 'uploadCreate'), bytes);
    expect(reply).toEqual({ status: 201, body: { id: 'u1' } });
    expect(got).toEqual([{ req: call('u1', 'uploadCreate'), sha: sha256(bytes), size: bytes.length }]);
  }, 30_000);

  it('events held for a snapshot that never goes out stop at 10 000: then the link is dropped 1013 (the next starts afresh)', async () => {
    const hub = await startHub();
    const n = await startNode(hub);
    for (let i = 0; i <= 10_000; i += 1) n.links[0]!.sendEvent(nodeEvents.sessionRemoved('7a1c0000-0000-4000-8000-000000000099'));
    await vi.waitFor(() => expect(hub.links[0]!.closes).toEqual([NODE_CLOSE.slow]));
    expect(hub.links[0]!.events).toEqual([]);
  });

  it("a node's send buffer over MAX_BUFFERED is 1013", async () => {
    const hub = await startHub();
    const n = await startNode(hub);
    // The socket behind the node's link, made to look backed up (a hub reading nothing for minutes).
    const ws = (n.links[0] as unknown as { ws: object }).ws;
    Object.defineProperty(ws, 'bufferedAmount', { get: () => MAX_BUFFERED + 1 });
    n.links[0]!.sendSnapshot(linuxNodeSnapshot());
    await vi.waitFor(() => expect(hub.links[0]!.closes).toEqual([NODE_CLOSE.slow]));
    expect(hub.links[0]!.snapshots).toEqual([]);
  });

  it('a call before the node wired its executor is 503 "jantard is starting"', async () => {
    const hub = await startHub();
    const { ctx } = await joinNode(hub);
    const dialer = createDialer(ctx, ctx.paths.nodeFile, () => SELF);
    onCleanup(() => dialer.stop());
    dialer.start(() => {});
    await vi.waitFor(() => expect(hub.links).toHaveLength(1));
    expect(await hub.links[0]!.link.call(call('c1', 'getScreen'))).toEqual({ status: 503, body: errorBody('unavailable', 'jantard is starting') });
  });

  it('a reply over 16 MiB is a 500 from the node, never a broken link', async () => {
    const hub = await startHub();
    await startNode(hub, { onCall: async () => ({ status: 200, body: { text: 'q'.repeat(NODE_LIMITS.bulkToHubBytes + 10) } }) });
    const reply = await hub.links[0]!.link.call(call('c1', 'getTranscript'));
    expect(reply).toEqual({ status: 500, body: { error: { code: 'internal', message: 'reply too large for the link' } } });
    expect(hub.links[0]!.closes).toEqual([]);
  }, 30_000);
});

describe('HubLink.call never rejects', () => {
  it('node_timeout after 30 s (60 s for an upload); a late answer is dropped; the 17th in flight is 429', async () => {
    const hub = await startHub();
    const answers: ((r: NodeCallReply) => void)[] = [];
    await startNode(hub, { onCall: () => new Promise((resolve) => answers.push(resolve)) });
    const link = hub.links[0]!.link;
    const slow = link.call(call('c1', 'getScreen'));
    const upload = link.call(call('u1', 'uploadCreate'), Buffer.from('tiny'));
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    await pass(hub.ctx.clock, NODE_LIMITS.callTimeoutMs);
    expect(await slow).toEqual({ status: 504, body: { error: { code: 'node_timeout', message: expect.stringMatching(/^build-1|^node-1/) } } });
    await pass(hub.ctx.clock, NODE_LIMITS.longCallTimeoutMs - NODE_LIMITS.callTimeoutMs);
    expect((await upload).status).toBe(504);
    // The node answers late: dropped, the link stays.
    answers[0]!({ status: 200, body: {} });
    answers[1]!({ status: 201, body: {} });
    const more = Array.from({ length: NODE_LIMITS.callsInFlight }, (_v, i) => link.call(call(`m${i}`, 'getScreen')));
    expect(await link.call(call('m16', 'getScreen'))).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    await vi.waitFor(() => expect(answers).toHaveLength(2 + NODE_LIMITS.callsInFlight));
    for (const a of answers.slice(2)) a({ status: 200, body: { ok: 1 } });
    expect((await Promise.all(more)).every((r) => r.status === 200)).toBe(true);
    expect(hub.links[0]!.closes).toEqual([]);
  });

  it('a link that drops ends a call already sent node_timeout (it may have run there); a call after it is node_offline', async () => {
    const hub = await startHub();
    const ran: string[] = [];
    await startNode(hub, { onCall: (req) => (ran.push(req.id), new Promise(() => {})) });
    const link = hub.links[0]!.link;
    const waiting = link.call(call('c1', 'sendPrompt', { body: { text: 'x' } }));
    await vi.waitFor(() => expect(ran).toEqual(['c1']));
    link.close(NODE_CLOSE.unknown, 'revoked');
    // Never "Nothing was sent": the prompt reached the node, so the phone is told to check the session.
    expect(await waiting).toMatchObject({ status: 504, body: { error: { code: 'node_timeout', message: expect.stringMatching(/didn't answer in time\. Check the session before trying again\.$/) } } });
    expect(await link.call(call('c2', 'getScreen'))).toMatchObject({ status: 503, body: { error: { code: 'node_offline', message: expect.stringMatching(/is offline\. Nothing was sent\.$/) } } });
    expect(hub.links[0]!.closes).toEqual([NODE_CLOSE.unknown]);
  });

  it('a node full of calls the hub gave up on answers an upload 429 and drops its chunks; the link stays up', async () => {
    const hub = await startHub();
    const answers: ((r: NodeCallReply) => void)[] = [];
    await startNode(hub, { onCall: () => new Promise((resolve) => answers.push(resolve)) });
    const link = hub.links[0]!.link;
    const stuck = Array.from({ length: NODE_LIMITS.callsInFlight }, (_v, i) => link.call(call(`s${i}`, 'getScreen')));
    await vi.waitFor(() => expect(answers).toHaveLength(NODE_LIMITS.callsInFlight));
    await pass(hub.ctx.clock, NODE_LIMITS.callTimeoutMs);
    for (const r of await Promise.all(stuck)) expect(r.status).toBe(504);
    // The hub has room again while the node still runs all sixteen: the upload is refused there, its chunks still coming.
    const bytes = Buffer.alloc(NODE_LIMITS.chunkBytes * 2 + 10, 7);
    expect(await link.call(call('u1', 'uploadCreate'), bytes)).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    // Once a place is free on the node, a call sent after those chunks runs: the link never dropped.
    answers[0]!({ status: 200, body: {} });
    const next = link.call(call('c1', 'getScreen'));
    await vi.waitFor(() => expect(answers).toHaveLength(NODE_LIMITS.callsInFlight + 1));
    answers[NODE_LIMITS.callsInFlight]!({ status: 200, body: { ok: 1 } });
    expect(await next).toEqual({ status: 200, body: { ok: 1 } });
    expect(hub.links[0]!.closes).toEqual([]);
  });
});

describe('logs', () => {
  it('carry kinds, sizes, ids and codes: never a frame body, a header or a key (S14)', async () => {
    const hub = await startHub();
    const n = await startNode(hub, { onCall: async () => ({ status: 200, body: { screen: `${FLEET_SECRET} on screen` } }) });
    n.links[0]!.sendSnapshot(oversizedNodeSnapshot());
    await vi.waitFor(() => expect(hub.links[0]!.snapshots).toHaveLength(1));
    await hub.links[0]!.link.call(call('c1', 'sendPrompt', { body: { text: `${FLEET_SECRET} prompt` } }));
    await hub.links[0]!.link.call(call('u1', 'uploadCreate'), Buffer.from(`${FLEET_SECRET} file`));
    hub.links[0]!.link.close(NODE_CLOSE.protocol, 'protocol error');
    await vi.waitFor(() => expect(n.dialer.status().state).toBe('waiting'));
    const logs = JSON.stringify([hub.ctx.log.records, n.ctx.log.records]);
    expect(logs).not.toContain(FLEET_SECRET);
    expect(logs).not.toContain('PRIVATE KEY');
    expect(logs).not.toContain(n.node.privateKey.slice(40, 70));
  });
});
