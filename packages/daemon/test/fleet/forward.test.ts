/**
 * v0.6 Fleet (lane L4): the phone's calls for a node, end to end in one
 * process: targetOf on the hub's state -> forwardCall over a memory link ->
 * the node's executor -> the node's own API on the `link` transport (its
 * real handlers, fake parts, the real upload store on a throwaway home) ->
 * the reply.
 *
 * - Every NODE_ROUTES entry reaches the node's handler and comes back as the
 *   node answered it.
 * - S5: the node checks the phone's scopes again and its own switches; a
 *   read-only node refuses every write.
 * - S15: never queued across a disconnect; a retried write runs once (the
 *   node's idempotency cache, keyed by `idem`).
 * - S16: card decisions only from a phone with `control`, decided on the
 *   node as hub.<deviceId>.
 * - S13: the 17th call in flight is 429.
 * - Big replies (a 200-item page of 20,000 characters) and uploads of every
 *   size come back whole, with the same sha256 on the node's disk.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linuxNodeSnapshot, nodeCard, nodeSession } from '@jantar/fixtures';
import { DEFAULT_LAUNCH_FLAGS, SettingsSchema, type Settings, type TranscriptItem } from '@jantar/protocol';
import { NODE_LIMITS, NODE_ROUTES, type NodeCallActor, type NodeCallReply, type NodeRouteName } from '@jantar/protocol/node-link';
import type { FleetTarget, ForwardCall } from '../../src/contracts.js';
import { buildApp } from '../../src/api/app.js';
import { linkInjector } from '../../src/api/server.js';
import { sha256Hex } from '../../src/core/hash.js';
import { forwardCall, targetOf, waitForStoreSend } from '../../src/fleet/forward.js';
import { NodeRegistry } from '../../src/fleet/registry.js';
import { READ_ONLY_REASON } from '../../src/modes.js';
import { createExecutor } from '../../src/node/executor.js';
import { nodeSnapshot } from '../../src/node/feed.js';
import { PNG, tempHome } from '../uploads/helpers.js';
import { makeApi, type TestApi } from '../api/fakes.js';
import { MAC_CARD, MAC_SID, NODE_IDS, hubContext, linkTo, settle } from './helpers.js';

const S1 = '7a1c0000-0000-4000-8000-000000000001';
const S2 = '7a1c0000-0000-4000-8000-000000000002';
const CARD = '01JF1EETCARD000000000000AAbbCCddEEffGGhh00';
const UPLOAD = '01jfz8x8y3t0v5g9wqk2m4n6pr';
const TARGET: FleetTarget = { nodeId: NODE_IDS.build1, name: 'build-1' };
const PHONE: NodeCallActor = { deviceId: 'dev-1', deviceName: 'Sam phone', scopes: ['read', 'control', 'launch'] };

/** A call for each route that passes the node's validation. */
const CALLS: Record<NodeRouteName, Omit<ForwardCall, 'route' | 'actor'>> = {
  getTranscript: { params: { sid: S1 }, query: { limit: '5' } },
  getScreen: { params: { sid: S1 }, query: {} },
  sendPrompt: { params: { sid: S1 }, query: {}, body: { text: 'fix the tests;', onDraft: 'refuse' } },
  focusSession: { params: { sid: S1 }, query: {} },
  sessionKey: { params: { sid: S1 }, query: {}, body: { key: 'interrupt' } },
  sessionMode: { params: { sid: S1 }, query: {}, body: { mode: 'plan' } },
  sessionCommand: { params: { sid: S1 }, query: {}, body: { name: 'compact' } },
  sessionDialog: { params: { sid: S1 }, query: {}, body: { fingerprint: 'f'.repeat(64), option: 0 } },
  sessionKeypad: { params: { sid: S1 }, query: {}, body: { screen: 'e'.repeat(64), lines: 40 } },
  uploadCreate: { params: { sid: S1 }, query: { ext: 'txt' }, raw: Buffer.from('notes from the phone\n') },
  uploadDelete: { params: { sid: S1, id: UPLOAD }, query: {} },
  decidePending: { params: { id: CARD }, query: {}, body: { behavior: 'allow' } },
  launchGet: { params: { id: 'launch-0001' }, query: {} },
  launchAnswer: { params: { id: 'launch-0001' }, query: {}, body: { option: 0, title: 'Do you trust the files in this folder?' } },
  launchPreview: { params: {}, query: { root: 'r.code', path: 'api-server' } },
  launchStart: { params: {}, query: {}, body: { root: 'r.code', path: 'api-server', account: 'auto', flags: DEFAULT_LAUNCH_FLAGS } },
  launchHistory: { params: {}, query: { root: 'r.code', path: 'api-server' } },
  foldersRoots: { params: {}, query: {} },
  foldersList: { params: {}, query: { root: 'r.code' } },
  foldersRecent: { params: {}, query: {} },
  foldersPin: { params: {}, query: {}, body: { root: 'r.code', path: 'api-server', pinned: true } },
  foldersCreate: { params: {}, query: {}, body: { root: 'r.code', parent: '', name: 'new-app' } },
  refreshUsage: { params: {}, query: {} },
};

let home: ReturnType<typeof tempHome> | null = null;
let node: TestApi | null = null;
let closeLink: (() => Promise<void>) | null = null;
afterEach(async () => {
  await closeLink?.();
  await node?.close();
  home?.cleanup();
  home = null;
  node = null;
  closeLink = null;
});

/** A hub with build-1 linked, and build-1's own API behind the link (its sessions S1 and S2, card CARD on S1). */
async function rig(opts: { nodeSettings?: Settings; readOnly?: boolean } = {}) {
  home = tempHome();
  node = await makeApi({
    ctx: { userHome: home.home, home: join(home.home, '.jantar'), ...(opts.nodeSettings ? { settings: opts.nodeSettings } : {}) },
    sessions: [nodeSession({ sid: S1, paneId: '%3' }), nodeSession({ sid: S2, pid: 52002, tty: '/dev/pts/4' })],
    ...(opts.readOnly ? { api: { mode: { readOnly: true, terminal: 'tmux' as const } } } : {}),
  });
  node.ctx.store.emit({ type: 'pending.opened', sid: S1, data: { pending: nodeCard({ sid: S1, id: CARD }) } });
  const app = await buildApp(node.services, 'link');
  closeLink = () => app.close();
  const injector = linkInjector(app, node.services);
  const exec = createExecutor(node.ctx, injector);

  const hub = hubContext();
  const reg = new NodeRegistry(hub);
  const pair = linkTo(reg, NODE_IDS.build1);
  pair.node.onCall((req, bulk) => exec.run(req, bulk));
  pair.node.sendSnapshot(nodeSnapshot(node.ctx, node.ctx.store.getState()));
  await settle();
  const fwd = (route: NodeRouteName, call: Omit<ForwardCall, 'route' | 'actor'> = CALLS[route], actor: NodeCallActor = PHONE): Promise<NodeCallReply> =>
    forwardCall(reg.link(NODE_IDS.build1), TARGET, { route, actor, ...call });
  return { node, hub, reg, pair, exec, injector, fwd };
}

describe('targetOf', () => {
  it("finds the node of a session, a card, a launch and ?node=, from the hub's own state only", async () => {
    const { hub } = await rig();
    const st = hub.store.getState();
    expect(targetOf(st, 'sendPrompt', { sid: S1 }, {})).toEqual(TARGET);
    expect(targetOf(st, 'decidePending', { id: CARD }, {})).toEqual(TARGET);
    expect(targetOf(st, 'foldersRoots', {}, { node: NODE_IDS.build1 })).toEqual(TARGET);
    // The Mac's own: null, so the route runs on the Mac.
    expect(targetOf(st, 'sendPrompt', { sid: MAC_SID }, {})).toBeNull();
    expect(targetOf(st, 'decidePending', { id: MAC_CARD }, {})).toBeNull();
    expect(targetOf(st, 'foldersRoots', {}, {})).toBeNull();
    // Unknown, prototype names, malformed ids, arrays: nothing.
    for (const sid of ['nope', 'constructor', '__proto__', 'toString', '../x', 'a/b']) expect(targetOf(st, 'getScreen', { sid }, {}), sid).toBeNull();
    for (const q of [NODE_IDS.build2, 'constructor', 'build-1', [NODE_IDS.build1]]) expect(targetOf(st, 'foldersRoots', {}, { node: q })).toBeNull();
    // Never a node for a route outside NODE_ROUTES, whatever it names.
    expect(targetOf(st, 'getSession', { sid: S1 }, {})).toBeNull();
    expect(targetOf(st, 'sessionScreenshot', { sid: S1 }, {})).toBeNull();
  });

  it('a launch goes to the node that started it; an offline node is still a target', async () => {
    const { hub, pair } = await rig();
    hub.store.emit({
      type: 'launch.progress',
      data: {
        job: {
          id: 'launch-0001',
          createdAt: '2026-01-15T10:00:00.000Z',
          updatedAt: '2026-01-15T10:00:00.000Z',
          actor: 'device:dev-1',
          rootId: 'r.code',
          folder: '/home/sam/code/api-server',
          display: '~/code/api-server',
          account: 0,
          accountSource: 'auto',
          requested: 'auto',
          flags: DEFAULT_LAUNCH_FLAGS,
          dangerous: false,
          name: 'fix-tests',
          sid: S2,
          stage: 'opening',
          steps: [],
          node: NODE_IDS.build1,
        },
      },
    });
    expect(targetOf(hub.store.getState(), 'launchGet', { id: 'launch-0001' }, {})).toEqual(TARGET);
    pair.drop(1006);
    expect(targetOf(hub.store.getState(), 'sendPrompt', { sid: S1 }, {})).toEqual(TARGET);
  });
});

describe('forwardCall', () => {
  it('every NODE_ROUTES entry reaches the node handler and comes back as the node answered it', async () => {
    const { fwd, injector } = await rig({ nodeSettings: SettingsSchema.parse({ controls: { enabled: true }, launch: { enabled: true } }) });
    const seen: Record<string, number> = {};
    for (const route of Object.keys(NODE_ROUTES) as NodeRouteName[]) {
      const reply = await fwd(route);
      seen[route] = reply.status;
      // Not the link app's "no such route" and not its "unknown call": the route ran in the node's pipeline.
      expect(reply.status, route).not.toBe(401);
      expect(JSON.stringify(reply.body), route).not.toBe(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
    }
    // What the phone needs most comes back as it does on a Mac.
    expect(seen).toMatchObject({ getTranscript: 200, getScreen: 200, sendPrompt: 202, decidePending: 200, uploadCreate: 201, refreshUsage: 202 });
    // And the reply is the node's own: the same as calling the node's API directly.
    const direct = await injector.inject({ method: 'GET', url: `/v1/sessions/${S1}/transcript?limit=5`, actor: PHONE });
    expect(await fwd('getTranscript')).toEqual(direct);
  });

  it('a 200-item page of 20,000-character items comes back whole (larger than a frame: the link sends it as a bulk)', async () => {
    const { fwd, node: n } = await rig();
    const items: TranscriptItem[] = Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, role: 'assistant', kind: 'text', text: `${i}`.padEnd(20_000, 'z') }));
    n.fakes.transcripts.items = items;
    const reply = await fwd('getTranscript', { params: { sid: S1 }, query: { limit: '200' } });
    expect(reply.status).toBe(200);
    const body = reply.body as { items: TranscriptItem[] };
    expect(body.items).toHaveLength(200);
    expect(body.items.every((x, i) => x.text === items[i]?.text)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(reply.body))).toBeGreaterThan(NODE_LIMITS.frameBytes);
  });

  it('uploads of 1 byte, 512 KiB, 512 KiB + 1 and 20 MiB are stored on the node with the same sha256', async () => {
    const { fwd, node: n } = await rig();
    const sizes = [1, 512 * 1024, 512 * 1024 + 1, 20 * 1024 * 1024];
    for (const size of sizes) {
      const bytes = size === 1 ? Buffer.from('a') : Buffer.concat([PNG, Buffer.alloc(size - PNG.length, 7)]);
      const reply = await fwd('uploadCreate', { params: { sid: S1 }, query: { ext: size === 1 ? 'txt' : 'png' }, raw: bytes });
      expect(reply.status, String(size)).toBe(201);
      const id = (reply.body as { upload: { id: string; bytes: number } }).upload.id;
      const dir = join(n.ctx.paths.uploadsDir, S1);
      const name = readdirSync(dir).find((f) => f.startsWith(`${id}.`));
      if (!name) throw new Error('not stored');
      expect(sha256Hex(readFileSync(join(dir, name))), String(size)).toBe(sha256Hex(bytes));
    }
  });

  it('S5: the node checks the phone scopes again, and its own switches', async () => {
    const { fwd } = await rig();
    const reader: NodeCallActor = { ...PHONE, scopes: ['read'] };
    expect((await fwd('sendPrompt', CALLS.sendPrompt, reader)).status).toBe(403);
    expect((await fwd('getScreen', CALLS.getScreen, reader)).status).toBe(200);
    // Starting needs the phone's launch scope...
    expect((await fwd('launchStart', CALLS.launchStart, { ...PHONE, scopes: ['read', 'control'] })).status).toBe(403);
    // ...and the node's own switch, off here by default (spec D6).
    const off = await fwd('foldersRoots');
    expect(off.status).toBe(403);
    expect((off.body as { error: { message: string } }).error.message).toMatch(/off/i);
  });

  it('S5: a read-only node refuses every write and still answers reads', async () => {
    const { fwd } = await rig({ readOnly: true });
    for (const route of ['sendPrompt', 'decidePending', 'uploadCreate', 'sessionKey'] as NodeRouteName[]) {
      const r = await fwd(route);
      expect(r.status, route).toBe(403);
      expect((r.body as { error: { message: string } }).error.message, route).toBe(READ_ONLY_REASON);
    }
    expect((await fwd('getScreen')).status).toBe(200);
  });

  it('S15: a retried write runs once on the node (its own idempotency cache, keyed by idem)', async () => {
    const { fwd, node: n } = await rig();
    const call = { ...CALLS.sendPrompt, idem: 'dev-1:k-0001' };
    const a = await fwd('sendPrompt', call);
    const b = await fwd('sendPrompt', call);
    expect(a.status).toBe(202);
    expect(b).toEqual(a);
    expect(n.fakes.writer.submits).toHaveLength(1);
    expect(n.fakes.writer.submits[0]?.actor).toEqual({ kind: 'device', deviceId: 'hub.dev-1', scopes: ['read', 'control', 'launch'] });
  });

  it('S15: offline is honest: 503 at once, nothing queued; a call in flight when the link drops ends 504 (it may have run)', async () => {
    const { fwd, pair, reg, node: n } = await rig();
    let release: (() => void) | null = null;
    n.fakes.transcripts.page = () => new Promise((r) => (release = () => r({ items: [], nextBefore: null })));
    const waiting = fwd('getTranscript');
    await settle();
    pair.drop(1006);
    expect(await waiting).toEqual({ status: 504, body: { error: { code: 'node_timeout', message: "build-1 didn't answer in time. Check the session before trying again." } } });
    (release as (() => void) | null)?.();
    expect(reg.link(NODE_IDS.build1)).toBeNull();
    const after = await fwd('sendPrompt');
    expect(after.status).toBe(503);
    expect(n.fakes.writer.submits).toHaveLength(0);
    expect(await forwardCall(null, TARGET, { route: 'sendPrompt', actor: PHONE, ...CALLS.sendPrompt })).toEqual(after);
  });

  it('S16: a card is decided on the node, by hub.<deviceId>, and only from a phone with control', async () => {
    const { fwd, node: n } = await rig();
    const read = await fwd('decidePending', CALLS.decidePending, { ...PHONE, scopes: ['read'] });
    expect(read.status).toBe(403);
    expect(n.fakes.hooks.decisions).toEqual([]);
    const ok = await fwd('decidePending');
    expect(ok.status).toBe(200);
    expect(n.fakes.hooks.decisions).toEqual([{ id: CARD, decision: { behavior: 'allow' }, actor: 'device:hub.dev-1' }]);
  });

  it('S13: the 17th call in flight to one node is 429', async () => {
    const { fwd, node: n } = await rig();
    const releases: (() => void)[] = [];
    n.fakes.transcripts.page = () => new Promise((r) => releases.push(() => r({ items: [], nextBefore: null })));
    const first = Array.from({ length: NODE_LIMITS.callsInFlight }, () => fwd('getTranscript'));
    await settle();
    const extra = await fwd('getTranscript');
    expect(extra.status).toBe(429);
    expect((extra.body as { error: { code: string } }).error.code).toBe('rate_limited');
    for (const r of releases) r();
    expect((await Promise.all(first)).every((x) => x.status === 200)).toBe(true);
    // Room again once they are done.
    n.fakes.transcripts.page = async () => ({ items: [], nextBefore: null });
    expect((await fwd('getTranscript')).status).toBe(200);
  });
});

describe("a node's own answers", () => {
  it("a node's unauthorized is never the phone's \"not paired\": a 500 that names the machine", async () => {
    const hub = hubContext();
    const reg = new NodeRegistry(hub);
    const pair = linkTo(reg, NODE_IDS.build1);
    pair.node.onCall(async (req) =>
      req.route === 'getScreen' ? { status: 401, body: { error: { code: 'unauthorized', message: 'not paired' } } } : { status: 403, body: { error: { code: 'unauthorized', message: 'x' } } },
    );
    pair.node.sendSnapshot(linuxNodeSnapshot());
    await settle();
    const go = (route: NodeRouteName) => forwardCall(reg.link(NODE_IDS.build1), TARGET, { route, actor: PHONE, ...CALLS[route] });
    const want = { status: 500, body: { error: { code: 'internal', message: 'build-1 refused the call' } } };
    expect(await go('getScreen')).toEqual(want);
    expect(await go('getTranscript')).toEqual(want);
  });

  it('a status the phone could not be answered with (1xx: no body, the call would hang) is a 502', async () => {
    const hub = hubContext();
    const reg = new NodeRegistry(hub);
    const pair = linkTo(reg, NODE_IDS.build1);
    pair.node.onCall(async (req) => ({ status: req.route === 'getScreen' ? 101 : 199, body: { lines: ['x'] } }));
    pair.node.sendSnapshot(linuxNodeSnapshot());
    await settle();
    const go = (route: NodeRouteName) => forwardCall(reg.link(NODE_IDS.build1), TARGET, { route, actor: PHONE, ...CALLS[route] });
    const want = { status: 502, body: { error: { code: 'internal', message: "build-1's reply was not understood" } } };
    expect(await go('getScreen')).toEqual(want);
    expect(await go('getTranscript')).toEqual(want);
  });
});

describe('waitForStoreSend (/ctl/sends/:jobId/wait for a node job)', () => {
  it('settles on the re-emitted send.progress that finishes it, or gives the job as it stands at the timeout', async () => {
    const { hub, pair } = await rig();
    const job = { id: 'job-0001', sid: S1, textHash: 'h', textLength: 1, attempts: 0, createdAt: '2026-01-15T10:00:00.000Z', updatedAt: '2026-01-15T10:00:00.000Z' };
    pair.node.sendEvent({ seq: 1, ts: job.createdAt, type: 'send.progress', sid: S1, data: { job: { ...job, stage: 'typed' } } });
    await settle();
    const waiting = waitForStoreSend(hub.store, hub.clock, 'job-0001', 60_000);
    pair.node.sendEvent({ seq: 2, ts: job.createdAt, type: 'send.progress', sid: S1, data: { job: { ...job, stage: 'proven' } } });
    await settle();
    expect((await waiting)?.stage).toBe('proven');
    expect(await waitForStoreSend(hub.store, hub.clock, 'no-such-job', 10)).toBeUndefined();
    pair.node.sendEvent({ seq: 3, ts: job.createdAt, type: 'send.progress', sid: S1, data: { job: { ...job, id: 'job-0002', stage: 'enter' } } });
    await settle();
    const slow = waitForStoreSend(hub.store, hub.clock, 'job-0002', 5_000);
    hub.clock.advance(5_000);
    expect((await slow)?.stage).toBe('enter');
    expect(hub.clock.pending()).toBe(0);
  });

  it('settles when the job leaves the hub (its node removed), even with no timeout', async () => {
    const { hub, pair, reg } = await rig();
    const job = { id: 'job-0003', sid: S1, textHash: 'h', textLength: 1, attempts: 0, stage: 'typed' as const, createdAt: '2026-01-15T10:00:00.000Z', updatedAt: '2026-01-15T10:00:00.000Z' };
    pair.node.sendEvent({ seq: 1, ts: job.createdAt, type: 'send.progress', sid: S1, data: { job } });
    await settle();
    const waiting = waitForStoreSend(hub.store, hub.clock, 'job-0003');
    reg.remove(NODE_IDS.build1);
    expect((await waiting)?.stage).toBe('typed');
  });
});

describe('the fixtures', () => {
  it('the Linux fixture snapshot names the sessions the forward tests use', () => {
    expect(Object.keys(linuxNodeSnapshot().sessions)).toContain(S1);
  });
});
