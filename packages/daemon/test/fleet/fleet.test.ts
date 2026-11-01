/**
 * v0.6 Fleet (lane L4): the hub's Fleet part (fleet/index.ts createFleet),
 * with L1's link server stood in by a fake that hands over memory links.
 *
 * - Built on every hub and inert while fleet.enabled is off: no link
 *   server, no timer, no hub key file; `?node=` names nothing.
 * - It follows the switch: on makes the hub key and the link server; off
 *   closes every link 4403 and takes each node off the board (the pairings
 *   stay, so turning it on again needs no re-join).
 * - A paired server that has not linked since the Mac started is still a
 *   machine: offline (503), not "no such machine" (404).
 * - Revoke: 4401, off the board at once. Stop: 1001, the board untouched.
 * - Join lines need a fixed front door.
 * - The Machines list carries a refused handshake (4426: update Jantar there).
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linuxNodeSnapshot, memoryLinkPair, type MemoryLinkPair } from '@jantar/fixtures';
import { FLEET_COPY } from '@jantar/protocol';
import { NODE_CLOSE, decodeJoinToken } from '@jantar/protocol/node-link';
import type { Actor, FleetService, HubLink, LinkServer, LinkServerHooks } from '../../src/contracts.js';
import type { TestContext } from '../../src/core/testing.js';
import { NodeAuth } from '../../src/auth/nodes.js';
import { createFleet } from '../../src/fleet/index.js';
import { NodeRegistry } from '../../src/fleet/registry.js';
import { tempHome } from '../uploads/helpers.js';
import { NODE_IDS, hubContext, nodeRecord, record, settle } from './helpers.js';

/** L1's link server, faked: the test hands it memory links; closing them closes the pairs. */
interface FakeServer extends LinkServer {
  hooks: LinkServerHooks;
  pairs: Map<string, MemoryLinkPair>;
  closes: { nodeId: string | null; code: number }[];
  stopped: boolean;
}

const h = vi.hoisted(() => ({ servers: [] as unknown[] }));

vi.mock('../../src/fleet/socket.js', () => ({
  createLinkServer: (_ctx: unknown, _auth: unknown, hooks: LinkServerHooks): LinkServer => {
    const pairs = new Map<string, MemoryLinkPair>();
    const s: FakeServer = {
      hooks,
      pairs,
      closes: [],
      stopped: false,
      accept: () => {},
      closeNode(nodeId, code) {
        s.closes.push({ nodeId, code });
        pairs.get(nodeId)?.drop(code);
      },
      closeAll(code) {
        s.closes.push({ nodeId: null, code });
        for (const p of pairs.values()) p.drop(code);
      },
      linked: () => [...pairs.entries()].filter(([, p]) => p.open).map(([id]) => id),
      stop: async () => {
        s.stopped = true;
      },
    };
    h.servers.push(s);
    return s;
  },
}));

const ADMIN: Actor = { kind: 'cli' };
const S1 = '7a1c0000-0000-4000-8000-000000000001';

let home: ReturnType<typeof tempHome>;
let ctx: TestContext;
let fleet: FleetService;

beforeEach(() => {
  h.servers.length = 0;
  home = tempHome();
  ctx = hubContext({ userHome: home.home, home: join(home.home, '.jantar') });
  fleet = createFleet(ctx, {});
});

afterEach(async () => {
  await fleet.stop();
  home.cleanup();
});

const servers = () => h.servers as FakeServer[];
const server = () => servers().at(-1) as FakeServer;

async function fleetOn(on = true): Promise<void> {
  const before = servers().length;
  await ctx.settings.patch({ fleet: { enabled: on } });
  if (on) await vi.waitFor(() => expect(servers().length).toBe(before + 1));
  else await vi.waitFor(() => expect(server().stopped).toBe(true));
}

/** A memory link for build-1 through the fake server, its snapshot sent. */
async function link(nodeId: string = NODE_IDS.build1): Promise<MemoryLinkPair> {
  const pair = memoryLinkPair({ nodeId });
  server().pairs.set(nodeId, pair);
  server().hooks.onLink(pair.hub as HubLink);
  pair.node.sendSnapshot(linuxNodeSnapshot());
  await settle();
  return pair;
}

const fakeSocket = () => {
  const sock = new PassThrough();
  let out = '';
  sock.on('data', (d: Buffer) => (out += d.toString()));
  return { sock, out: () => out };
};

describe('off: inert', () => {
  it('no link server, no timer, no hub key; ?node= names nothing and a forward is offline', async () => {
    await fleet.start();
    expect(servers()).toHaveLength(0);
    expect(ctx.clock.pending()).toBe(0);
    expect(existsSync(ctx.paths.hubKeyFile)).toBe(false);
    expect(fleet.target('foldersRoots', {}, { node: NODE_IDS.build1 })).toBeNull();
    expect(fleet.target('sendPrompt', { sid: S1 }, {})).toBeNull();
    const r = await fleet.forward({ nodeId: NODE_IDS.build1, name: 'build-1' }, { route: 'getScreen', params: { sid: S1 }, query: {}, actor: { deviceId: 'dev-1', deviceName: 'Sam phone', scopes: ['read'] } });
    expect(r.status).toBe(503);
    // An upgrade that got this far anyway is answered, not left hanging.
    const { sock, out } = fakeSocket();
    fleet.acceptLink({} as IncomingMessage, sock, Buffer.alloc(0));
    await settle();
    expect(out()).toMatch(/^HTTP\/1\.1 503 /);
  });
});

describe('the switch', () => {
  it('on: the hub key (0600) and the link server; a linked node is on the board and its calls forward', async () => {
    await fleet.start();
    await fleetOn();
    expect(statSync(ctx.paths.hubKeyFile).mode & 0o777).toBe(0o600);
    const pair = await link();
    pair.node.onCall(async () => ({ status: 200, body: { screen: 'ok' } }));
    expect(ctx.store.getState().nodes?.[NODE_IDS.build1]).toMatchObject({ name: 'build-1', online: true });
    const t = fleet.target('getScreen', { sid: S1 }, {});
    expect(t).toEqual({ nodeId: NODE_IDS.build1, name: 'build-1' });
    expect(await fleet.forward(t!, { route: 'getScreen', params: { sid: S1 }, query: {}, actor: { deviceId: 'dev-1', deviceName: 'Sam phone', scopes: ['read'] } })).toEqual({
      status: 200,
      body: { screen: 'ok' },
    });
    expect(fleet.list().find((r) => r.id === NODE_IDS.build1)).toMatchObject({ online: true, backend: 'tmux', sessions: 3 });
  });

  it('off: every link closes 4403 and every node leaves the board; on again needs no re-join', async () => {
    await fleet.start();
    await fleetOn();
    const a = await link(NODE_IDS.build1);
    const b = await link(NODE_IDS.build2);
    const events = record(ctx);
    await fleetOn(false);
    expect(server().closes).toEqual([{ nodeId: null, code: NODE_CLOSE.fleetOff }]);
    expect(a.open || b.open).toBe(false);
    expect(events.filter((e) => e.type === 'node.removed').map((e) => (e as { data: { id: string } }).data.id).sort()).toEqual([NODE_IDS.build1, NODE_IDS.build2].sort());
    // Gone, not greyed: the closing links changed nothing more.
    expect(events.filter((e) => e.type === 'node.updated')).toEqual([]);
    expect(ctx.store.getState().nodes).toEqual({});
    expect(Object.values(ctx.store.getState().sessions).every((s) => s.node === undefined)).toBe(true);
    expect(fleet.target('getScreen', { sid: S1 }, {})).toBeNull();
    // The pairings stay, and the Machines list says how their links closed (jantar fleet status, node list).
    expect(fleet.list().map((r) => r.name).sort()).toEqual(['build-1', 'build-2', 'win-1']);
    expect(fleet.list().find((r) => r.id === NODE_IDS.build1)).toMatchObject({ online: false, backend: 'tmux', lastClose: { code: NODE_CLOSE.fleetOff } });
    await fleetOn();
    await link(NODE_IDS.build1);
    expect(ctx.store.getState().nodes?.[NODE_IDS.build1]?.online).toBe(true);
  });

  it('on with a hub key that cannot be loaded: logged, and the link server still starts (each handshake loads it again)', async () => {
    vi.spyOn(NodeAuth.prototype, 'hubKey').mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await fleet.start();
    await fleetOn();
    expect(ctx.log.records.find((r) => r.msg === 'cannot load the hub key')?.level).toBe('error');
    const pair = await link();
    expect(pair.open).toBe(true);
    expect(ctx.store.getState().nodes?.[NODE_IDS.build1]?.online).toBe(true);
  });

  it("a paired server not linked since the Mac started is offline (503), and a revoked or unknown one is no machine", async () => {
    await fleet.start();
    await fleetOn();
    expect(fleet.target('foldersRoots', {}, { node: NODE_IDS.win1 })).toEqual({ nodeId: NODE_IDS.win1, name: 'win-1' });
    const r = await fleet.forward({ nodeId: NODE_IDS.win1, name: 'win-1' }, { route: 'foldersRoots', params: {}, query: {}, actor: { deviceId: 'dev-1', deviceName: 'Sam phone', scopes: ['read', 'launch'] } });
    expect(r).toEqual({ status: 503, body: { error: { code: 'node_offline', message: 'win-1 is offline. Nothing was sent.' } } });
    ctx.db.nodes.revoke(NODE_IDS.win1, ctx.clock.iso());
    expect(fleet.target('foldersRoots', {}, { node: NODE_IDS.win1 })).toBeNull();
    expect(fleet.target('foldersRoots', {}, { node: '01JF1EETN0DE0000000000000Z' })).toBeNull();
    // Never for a route that is not a node route.
    expect(fleet.target('getSettings', {}, { node: NODE_IDS.build1 })).toBeNull();
  });
});

describe('revoke and stop', () => {
  it('revoke: 4401, off the board at once, the row kept with its time; an unknown id is not_found', async () => {
    await fleet.start();
    await fleetOn();
    const pair = await link();
    const events = record(ctx);
    const out = await fleet.revoke(NODE_IDS.build1, ADMIN);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.machine).toMatchObject({ id: NODE_IDS.build1, online: false, sessions: 0 });
    expect(out.ok && out.machine.revokedAt).toBeTruthy();
    expect(server().closes).toEqual([{ nodeId: NODE_IDS.build1, code: NODE_CLOSE.unknown }]);
    expect(pair.open).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['node.removed']);
    expect(ctx.store.getState().nodes?.[NODE_IDS.build1]).toBeUndefined();
    // The row keeps what the Machines list shows of it: its backend and the 4401.
    expect(fleet.list().find((r) => r.id === NODE_IDS.build1)).toMatchObject({ backend: 'tmux', lastClose: { code: NODE_CLOSE.unknown } });
    expect(await fleet.revoke('01JF1EETN0DE0000000000000Z', ADMIN)).toEqual({ ok: false, code: 'not_found', reason: 'no such machine' });
  });

  it('stop: links close 1001 and the board is left as it is; a switch after stop does nothing', async () => {
    await fleet.start();
    await fleetOn();
    await link();
    const events = record(ctx);
    await fleet.stop();
    expect(server().closes).toEqual([{ nodeId: null, code: NODE_CLOSE.goingAway }]);
    expect(server().stopped).toBe(true);
    expect(events.filter((e) => e.type === 'node.removed')).toEqual([]);
    await ctx.settings.patch({ fleet: { enabled: false } });
    await ctx.settings.patch({ fleet: { enabled: true } });
    await settle();
    expect(servers()).toHaveLength(1);
  });
});

describe('forwarding to a linked node', () => {
  const PHONE = { deviceId: 'dev-1', deviceName: 'Sam phone', scopes: ['read', 'control', 'launch'] as ('read' | 'control' | 'launch')[] };
  const BUILD1 = { nodeId: NODE_IDS.build1, name: 'build-1' };
  const NO_PANE = '7a1c0000-0000-4000-8000-000000000003';
  const calls = (pair: MemoryLinkPair) => pair.frames.filter((f) => f.k === 'call').length;

  it("a typing call where the phone shows Jantar can't type gets the phone's sentence from the hub; nothing reaches the node", async () => {
    await fleet.start();
    await fleetOn();
    const pair = await link();
    pair.node.onCall(async () => ({ status: 202, body: { job: {} } }));
    const prompt = await fleet.forward(BUILD1, { route: 'sendPrompt', params: { sid: NO_PANE }, query: {}, body: { text: 'hi' }, actor: PHONE });
    expect(prompt).toEqual({ status: 422, body: { error: { code: 'refused', message: FLEET_COPY.notInTmux('build-1') } } });
    const key = await fleet.forward(BUILD1, { route: 'sessionKey', params: { sid: NO_PANE }, query: {}, body: { key: 'enter' }, actor: PHONE });
    expect(key.status).toBe(422);
    expect(calls(pair)).toBe(0);
    // Reading it, and typing into a session in tmux, go to the node.
    expect((await fleet.forward(BUILD1, { route: 'getScreen', params: { sid: NO_PANE }, query: {}, actor: PHONE })).status).toBe(202);
    expect((await fleet.forward(BUILD1, { route: 'sendPrompt', params: { sid: S1 }, query: {}, body: { text: 'hi' }, actor: PHONE })).status).toBe(202);
    expect(calls(pair)).toBe(2);
  });

  it('a watch-only node: every typing call is refused on the hub with its sentence', async () => {
    await fleet.start();
    await fleetOn();
    const pair = memoryLinkPair({ nodeId: NODE_IDS.build1, info: { readOnly: true } });
    server().pairs.set(NODE_IDS.build1, pair);
    server().hooks.onLink(pair.hub as HubLink);
    pair.node.sendSnapshot(linuxNodeSnapshot());
    await settle();
    const r = await fleet.forward(BUILD1, { route: 'sendPrompt', params: { sid: S1 }, query: {}, body: { text: 'hi' }, actor: PHONE });
    expect(r).toEqual({ status: 422, body: { error: { code: 'refused', message: FLEET_COPY.readOnlyNode('build-1') } } });
    expect(calls(pair)).toBe(0);
  });

  it("a launch job in the node's reply carries the node, as state.launches does", async () => {
    await fleet.start();
    await fleetOn();
    const pair = await link();
    pair.node.onCall(async (req) => (req.route === 'launchStart' ? { status: 202, body: { job: { id: 'launch-0001', stage: 'queued' } } } : { status: 404, body: { error: { code: 'not_found', message: 'no such launch' } } }));
    const started = await fleet.forward(BUILD1, { route: 'launchStart', params: {}, query: {}, body: {}, idem: 'dev-1:k-1', actor: PHONE });
    expect(started).toEqual({ status: 202, body: { job: { id: 'launch-0001', stage: 'queued', node: NODE_IDS.build1 } } });
    // A refusal is passed on as it came.
    expect(await fleet.forward(BUILD1, { route: 'launchGet', params: { id: 'launch-0002' }, query: {}, actor: PHONE })).toEqual({ status: 404, body: { error: { code: 'not_found', message: 'no such launch' } } });
  });
});

describe('join lines', () => {
  it('need a fixed https front door: none, or a quick tunnel, is refused; with one, each line names it', async () => {
    await fleet.start();
    await fleetOn();
    expect(await fleet.makeTokens({ count: 1 }, ADMIN)).toMatchObject({ ok: false, code: 'conflict' });
    await ctx.settings.patch({ remote: { mode: 'cloudflare', publicUrl: 'https://quiet-river-1234.trycloudflare.com' } });
    expect(await fleet.makeTokens({ count: 1 }, ADMIN)).toMatchObject({ ok: false, code: 'conflict' });
    await ctx.settings.patch({ remote: { publicUrl: 'https://jantar.example.com/' } });
    const out = await fleet.makeTokens({ name: 'build-3' }, ADMIN);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.tokens.map((t) => t.name)).toEqual(['build-3']);
    const decoded = decodeJoinToken(out.tokens[0]?.token ?? '');
    expect(decoded.ok && decoded.token.url).toBe('https://jantar.example.com');
  });
});

describe('the Machines list', () => {
  it('a handshake refused for its link version shows as the last close and the version problem', () => {
    const hub = hubContext();
    let refused: { code: number; at: string } | null = null;
    const reg = new NodeRegistry(hub, () => refused);
    expect(reg.rowOf(nodeRecord(NODE_IDS.build1, 'build-1'))).toMatchObject({ lastClose: null, online: false, backend: null });
    expect(reg.rowOf(nodeRecord(NODE_IDS.build1, 'build-1')).problem).toBeUndefined();
    refused = { code: NODE_CLOSE.version, at: hub.clock.iso() };
    expect(reg.rowOf(nodeRecord(NODE_IDS.build1, 'build-1'))).toMatchObject({ lastClose: refused, problem: 'version' });
  });
});
