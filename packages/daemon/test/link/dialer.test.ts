/**
 * v0.6 Fleet, the node's dialler over real `ws` on port 0 (S10, S11, S13),
 * against the real hub or one played by hand: the welcome is checked
 * against the pinned key before anything is acted on (an impostor's call
 * never runs, and it is logged every time); redirects are never followed;
 * Cloudflare Access's 403 is counted and reported in the next auth; node.json
 * is read again before every attempt; the waits between attempts (full
 * jitter, reset after a minute linked, the wait each ending gets) on fake
 * time; the watchdog and heartbeats; a bad upload is the call's 400.
 */
import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linuxNodeSnapshot } from '@jantar/fixtures';
import { HEARTBEAT_MS, errorBody } from '@jantar/protocol';
import { NODE_CLOSE, NODE_LIMITS, NODE_PROTO, linkUrl, type NodeFrame, type NodeFrameOf } from '@jantar/protocol/node-link';
import type { Dialer, NodeFile, NodeLink, NodeLinkStatus } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import type { TestContext } from '../../src/core/testing.js';
import { CHALLENGE_V, challengeFrame, newNonce, welcomeFrame, type NodeSelf } from '../../src/link/handshake.js';
import { generateKeyPair, privateKeyPem, writeNodeFile, type LinkKeyPair } from '../../src/link/keys.js';
import { createDialer } from '../../src/node/dialer.js';
import { cleanup, joinNode, onCleanup, pass, rawHub, refusingDoor, startHub, testCtx, type RawPeer, type Refusal } from './harness.js';

afterEach(cleanup);

const NODE_ID = '01JN0DE0000000000000000001';
const SELF: NodeSelf = { os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: false };
const ACTOR = { deviceId: 'dev1', deviceName: 'iPhone', scopes: ['read' as const, 'control' as const] };
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const callFrame = (id: string, over: Partial<NodeFrameOf<'call'>> = {}): NodeFrameOf<'call'> => ({
  k: 'call',
  id,
  route: 'getScreen',
  params: { sid: 's1' },
  query: {},
  actor: ACTOR,
  ...over,
});

interface FakeHub {
  url: string;
  upgrades: { headers: Record<string, string | string[] | undefined> }[];
  peers: RawPeer[];
  auths: NodeFrameOf<'auth'>[];
}

/**
 * A hub played by hand: a challenge, then a welcome signed with `key` (the
 * pinned one, or an impostor's), then `then` per connection (n from 0).
 * `before`: frames to send before the challenge and before the welcome;
 * `refuse`: answer chosen upgrades with a status, as a door would.
 */
async function fakeHub(
  key: LinkKeyPair,
  then: (peer: RawPeer, n: number) => void = () => {},
  opts: { beforeChallenge?: NodeFrame[]; beforeWelcome?: NodeFrame[]; refuse?: (n: number) => Refusal | null } = {},
): Promise<FakeHub> {
  const peers: RawPeer[] = [];
  const auths: NodeFrameOf<'auth'>[] = [];
  const hub = await rawHub(
    (peer) => {
      const n = peers.length;
      peers.push(peer);
      const nonce = newNonce();
      for (const f of opts.beforeChallenge ?? []) peer.send(f);
      peer.send(challengeFrame(nonce));
      void peer.next('auth').then((f) => {
        const a = f as NodeFrameOf<'auth'>;
        auths.push(a);
        for (const b of opts.beforeWelcome ?? []) peer.send(b);
        peer.send(welcomeFrame(key.privateKey, 'build-1', a.nodeId, nonce, a.nonce));
        then(peer, n);
      });
    },
    opts.refuse ? { refuse: (_req, n) => opts.refuse!(n) } : {},
  );
  return { url: hub.url, upgrades: hub.upgrades, peers, auths };
}

/** A node's home whose node.json points at `url` and pins `hubKey`. */
async function nodeHome(url: string, hubKey: string, cfAccess: NodeFile['cfAccess'] = null) {
  const clock = new FakeClock(Date.parse('2026-11-01T10:00:00.000Z'));
  const ctx = await testCtx({ clock });
  const file: NodeFile = { v: 1, url, nodeId: NODE_ID, name: 'build-1', hubKey, privateKey: privateKeyPem(generateKeyPair().privateKey), cfAccess };
  await writeNodeFile(ctx.paths, file);
  return { ctx, clock, file };
}

function startDialer(ctx: TestContext, onLink: (link: NodeLink) => void = () => {}): { d: Dialer; links: NodeLink[] } {
  const links: NodeLink[] = [];
  const d = createDialer(ctx, ctx.paths.nodeFile, () => SELF);
  onCleanup(() => d.stop());
  d.start((link) => {
    links.push(link);
    onLink(link);
  });
  return { d, links };
}

/** Move fake time to the next attempt (if one is due) and wait for it to end: its status and the wait it chose. */
async function attempt(d: Dialer, clock: FakeClock): Promise<{ status: NodeLinkStatus; wait: number }> {
  const before = d.status().retryAt;
  if (before) clock.advance(Date.parse(before) - clock.now());
  await vi.waitFor(() => {
    const s = d.status();
    expect(s.state).toBe('waiting');
    expect(s.retryAt).not.toBe(before);
  });
  const status = d.status();
  return { status, wait: Date.parse(status.retryAt!) - clock.now() };
}

const logged = (ctx: TestContext, level: string, re: RegExp) => ctx.log.records.filter((r) => r.level === level && re.test(r.msg));

describe('the welcome is checked against the pinned key (S10)', () => {
  it('an impostor: the node closes 4400, links nothing, runs no call, and logs an error every time', async () => {
    const pinned = generateKeyPair();
    const impostor = generateKeyPair();
    const hub = await fakeHub(impostor, (peer) => peer.send(callFrame('c2')), { beforeWelcome: [callFrame('c1')] });
    const { ctx, clock } = await nodeHome(hub.url, pinned.publicKey);
    const ran: string[] = [];
    const { d, links } = startDialer(ctx, (l) => l.onCall(async (req) => (ran.push(req.id), { status: 200, body: {} })));
    const first = await attempt(d, clock);
    expect(await hub.peers[0]!.closed).toBe(NODE_CLOSE.protocol);
    expect(first.status).toMatchObject({ state: 'waiting', name: 'build-1', hubHost: '127.0.0.1', lastClose: { code: NODE_CLOSE.protocol } });
    expect(first.wait).toBeLessThan(NODE_LIMITS.backoffCapMs);
    await attempt(d, clock);
    expect(links).toEqual([]);
    expect(ran).toEqual([]);
    expect(hub.peers.flatMap((p) => p.frames).filter((f) => f.k === 'result')).toEqual([]);
    expect(logged(ctx, 'error', /not signed by the key this server joined with/)).toHaveLength(2);
  });

  it('calls before the challenge or the welcome are never run; after a verified welcome they run and answer', async () => {
    const pinned = generateKeyPair();
    const hub = await fakeHub(pinned, (peer) => peer.send(callFrame('c2')), { beforeChallenge: [callFrame('c0')], beforeWelcome: [callFrame('c1')] });
    const { ctx } = await nodeHome(hub.url, pinned.publicKey);
    const ran: string[] = [];
    const { d, links } = startDialer(ctx, (l) => l.onCall(async (req) => (ran.push(req.id), { status: 200, body: { ran: req.id } })));
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(await hub.peers[0]!.next('result')).toEqual({ k: 'result', id: 'c2', status: 200, body: { ran: 'c2' } });
    expect(ran).toEqual(['c2']);
    expect(d.status()).toEqual({ state: 'linked', name: 'build-1', hubHost: '127.0.0.1', lastClose: null, accessRefused: 0, retryAt: null });
    // What the node says of itself, under this link's version.
    expect(hub.auths[0]).toMatchObject({ nodeId: NODE_ID, proto: NODE_PROTO, os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: false, accessRefused: 0 });
  });

  it("a newer hub's challenge (another v, a field this version does not know) is 4426: hourly, 'update Jantar here'", async () => {
    const pinned = generateKeyPair();
    const seen: RawPeer[] = [];
    const newer = await rawHub((peer) => (seen.push(peer), peer.send({ k: 'challenge', v: CHALLENGE_V + 1, nonce: newNonce(), features: ['x'] })));
    const { ctx, clock } = await nodeHome(newer.url, pinned.publicKey);
    const { d } = startDialer(ctx);
    const r = await attempt(d, clock);
    expect(r.status.lastClose?.code).toBe(NODE_CLOSE.version);
    expect(r.wait).toBe(NODE_LIMITS.hourlyRetryMs);
    expect(await seen[0]!.closed).toBe(NODE_CLOSE.version);
    expect(logged(ctx, 'warn', /^the hub speaks another link version: update Jantar here$/)).toHaveLength(1);
    // This version's challenge with such a field is a protocol error.
    const odd = await rawHub((peer) => peer.send({ k: 'challenge', v: CHALLENGE_V, nonce: newNonce(), features: ['x'] }));
    const home = await nodeHome(odd.url, pinned.publicKey);
    expect((await attempt(startDialer(home.ctx).d, home.clock)).status.lastClose?.code).toBe(NODE_CLOSE.protocol);
  });

  it('a hub frame a hub may not send closes 4400', async () => {
    const pinned = generateKeyPair();
    const hub = await fakeHub(pinned, (peer) => peer.send({ k: 'snapshot', state: linuxNodeSnapshot() }));
    const { ctx, clock } = await nodeHome(hub.url, pinned.publicKey);
    const { d } = startDialer(ctx);
    expect((await attempt(d, clock)).status.lastClose?.code).toBe(NODE_CLOSE.protocol);
    expect(await hub.peers[0]!.closed).toBe(NODE_CLOSE.protocol);
  });
});

describe('the door (S11)', () => {
  it('a redirect is never followed: its own status line, then backoff', async () => {
    const pinned = generateKeyPair();
    const target = await fakeHub(pinned);
    const door = await refusingDoor(() => ({ status: 302, headers: { Location: linkUrl(target.url) } }));
    const { ctx, clock } = await nodeHome(door.url, pinned.publicKey);
    const { d } = startDialer(ctx);
    const r = await attempt(d, clock);
    expect(r.status.lastClose?.code).toBe(302);
    expect(r.wait).toBeLessThan(NODE_LIMITS.backoffCapMs);
    expect(door.seen).toHaveLength(1);
    expect(target.upgrades).toEqual([]);
    expect(logged(ctx, 'warn', /redirect: servers never follow one/)).toHaveLength(1);
  });

  it("Cloudflare Access's 403 is counted and reported in the next auth; Jantar's own 403 is not; node.json is read again each time", async () => {
    const pinned = generateKeyPair();
    const access: Refusal = { status: 403, headers: { 'Content-Type': 'text/html' }, body: '<!doctype html><title>Forbidden</title>' };
    const own: Refusal = { status: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(errorBody('forbidden', 'no')) };
    const hub = await fakeHub(pinned, () => {}, { refuse: (n) => (n < 2 ? access : n === 2 ? own : null) });
    const { ctx, clock, file } = await nodeHome(hub.url, pinned.publicKey, { clientId: 'old-id.access', clientSecret: 'old-secret' });
    const { d, links } = startDialer(ctx);
    let r = await attempt(d, clock);
    expect(r.status).toMatchObject({ accessRefused: 1, lastClose: { code: 403 } });
    expect(r.wait).toBe(NODE_LIMITS.slowRetryMs);
    // `jantar node access` rewrote the token: the very next attempt carries it, no restart.
    await writeNodeFile(ctx.paths, { ...file, cfAccess: { clientId: 'new-id.access', clientSecret: 'new-secret' } });
    r = await attempt(d, clock);
    expect(r.status.accessRefused).toBe(2);
    r = await attempt(d, clock);
    expect(r.status).toMatchObject({ accessRefused: 2, lastClose: { code: 403 } });
    expect(r.wait).toBe(NODE_LIMITS.slowRetryMs);
    clock.advance(r.wait);
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(hub.auths[0]!.accessRefused).toBe(2);
    expect(d.status()).toMatchObject({ state: 'linked', accessRefused: 0 });
    expect(hub.upgrades.map((u) => [u.headers['cf-access-client-id'], u.headers['cf-access-client-secret']])).toEqual([
      ['old-id.access', 'old-secret'],
      ['new-id.access', 'new-secret'],
      ['new-id.access', 'new-secret'],
      ['new-id.access', 'new-secret'],
    ]);
    // The Access line once per change of ending, never a header value.
    expect(logged(ctx, 'warn', /^Cloudflare Access refused the connection/)).toHaveLength(1);
    const text = JSON.stringify(ctx.log.records);
    for (const secret of ['old-secret', 'new-secret', 'old-id.access', 'new-id.access']) expect(text).not.toContain(secret);
  });

  it('without node.json the dialler stops trying and says so', async () => {
    const pinned = generateKeyPair();
    const hub = await fakeHub(pinned, () => {}, { refuse: () => ({ status: 502 }) });
    const { ctx, clock } = await nodeHome(hub.url, pinned.publicKey);
    const { d } = startDialer(ctx);
    const r = await attempt(d, clock);
    expect(r.status.lastClose?.code).toBe(502);
    await unlink(ctx.paths.nodeFile);
    clock.advance(r.wait);
    await vi.waitFor(() => expect(d.status().state).toBe('off'));
    expect(logged(ctx, 'error', /node\.json is missing or unreadable/)).toHaveLength(1);
    clock.advance(NODE_LIMITS.hourlyRetryMs * 2);
    expect(hub.upgrades).toHaveLength(1);
  });
});

describe('the waits between attempts (spec 3.8, fake time)', () => {
  it('full jitter that doubles from 1 s, the count reset after a minute linked', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const clock = new FakeClock(Date.parse('2026-11-01T10:00:00.000Z'));
    const hub = await startHub({ ctx: await testCtx({ clock }) });
    let drop = true;
    hub.onLink((link) => {
      if (drop) link.close(NODE_CLOSE.goingAway, 'going away');
    });
    const { ctx, node } = await joinNode(hub, { clock });
    const { d, links } = startDialer(ctx);
    const waits: number[] = [];
    for (let i = 0; i < 4; i += 1) waits.push((await attempt(d, clock)).wait);
    expect(waits).toEqual([500, 1000, 2000, 4000]);
    expect(links).toHaveLength(4);
    drop = false;
    clock.advance(Date.parse(d.status().retryAt!) - clock.now());
    await vi.waitFor(() => expect(d.status().state).toBe('linked'));
    // A minute linked, heartbeats both ways keeping the hub's and the node's liveness checks happy.
    await pass(clock, NODE_LIMITS.backoffResetMs + 5000);
    expect(d.status().state).toBe('linked');
    hub.linkServer.closeNode(node.nodeId, NODE_CLOSE.protocol, 'protocol error');
    const after = await attempt(d, clock);
    expect(after.status.lastClose?.code).toBe(NODE_CLOSE.protocol);
    expect(after.wait).toBe(500);
  });

  it('each ending gets its wait: removed and other versions hourly, Fleet off every 10 min, 429 its retry-after (jittered)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const pinned = generateKeyPair();
    const closes = [NODE_CLOSE.unknown, NODE_CLOSE.version, NODE_CLOSE.fleetOff, NODE_CLOSE.replaced];
    const refusals: Record<number, Refusal> = {
      4: { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(errorBody('not_found', 'not found')) },
      5: { status: 429, headers: { 'Retry-After': '17' } },
      6: { status: 503 },
    };
    const hub = await fakeHub(pinned, (peer, n) => peer.ws.close(closes[n] ?? 1000, 'test'), { refuse: (n) => refusals[n] ?? null });
    const { ctx, clock } = await nodeHome(hub.url, pinned.publicKey);
    const { d } = startDialer(ctx);
    const seen: [number | undefined, number][] = [];
    for (let i = 0; i < 7; i += 1) {
      const r = await attempt(d, clock);
      seen.push([r.status.lastClose?.code, r.wait]);
    }
    expect(seen).toEqual([
      [NODE_CLOSE.unknown, NODE_LIMITS.hourlyRetryMs],
      [NODE_CLOSE.version, NODE_LIMITS.hourlyRetryMs],
      [NODE_CLOSE.fleetOff, NODE_LIMITS.slowRetryMs],
      // Replaced: backoff with a 10-minute cap (attempt 3: 8 s x 0.999999).
      [NODE_CLOSE.replaced, 7999],
      [404, NODE_LIMITS.slowRetryMs],
      // Its retry-after, plus up to as much again (16.999 s at the top).
      [429, 33_999],
      [503, NODE_LIMITS.backoffCapMs - 1],
    ]);
    // One line per kind of ending, saying what to do.
    expect(logged(ctx, 'warn', /^removed from the hub: run jantar node join with a new line$/)).toHaveLength(1);
    expect(logged(ctx, 'warn', /^the hub speaks another link version: update Jantar here$/)).toHaveLength(1);
    expect(logged(ctx, 'warn', /^Fleet is off at the Mac$/)).toHaveLength(1);
  });
});

describe('a live link', () => {
  it('the hub not answering in 10 s, or silent for 45 s once linked, drops the socket; the node beats every 20 s', async () => {
    const pinned = generateKeyPair();
    const mute = await rawHub(() => {});
    const { ctx, clock } = await nodeHome(mute.url, pinned.publicKey);
    const { d } = startDialer(ctx);
    await vi.waitFor(() => expect(mute.upgrades).toHaveLength(1));
    await vi.waitFor(() => expect(clock.pending()).toBeGreaterThan(0));
    clock.advance(NODE_LIMITS.handshakeMs);
    await vi.waitFor(() => expect(d.status().state).toBe('waiting'));
    expect(d.status().lastClose?.code).toBe(1006);
    expect(logged(ctx, 'warn', /^the hub did not answer in time$/)).toHaveLength(1);

    const hub = await fakeHub(pinned);
    const home = await nodeHome(hub.url, pinned.publicKey);
    const live = startDialer(home.ctx);
    await vi.waitFor(() => expect(live.links).toHaveLength(1));
    home.clock.advance(HEARTBEAT_MS);
    const beat = (await hub.peers[0]!.next('heartbeat')) as NodeFrameOf<'heartbeat'>;
    expect(beat.ts).toBe('2026-11-01T10:00:20.000Z');
    home.clock.advance(NODE_LIMITS.watchdogMs - HEARTBEAT_MS);
    expect(await hub.peers[0]!.closed).toBe(1006);
    await vi.waitFor(() => expect(live.d.status().state).toBe('waiting'));
  });

  it("an upload that does not arrive whole is the call's 400 and nothing runs; a whole one runs with its bytes", async () => {
    const pinned = generateKeyPair();
    const hub = await fakeHub(pinned);
    const { ctx } = await nodeHome(hub.url, pinned.publicKey);
    const got: { id: string; sha: string }[] = [];
    const { links } = startDialer(ctx, (l) => l.onCall(async (req, bulk) => (got.push({ id: req.id, sha: bulk ? sha256(bulk) : '' }), { status: 201, body: {} })));
    await vi.waitFor(() => expect(links).toHaveLength(1));
    const peer = hub.peers[0]!;
    const bytes = Buffer.alloc(NODE_LIMITS.chunkBytes + 10, 5);
    peer.send(callFrame('u1', { route: 'uploadCreate', bulk: { size: bytes.length, sha256: sha256(Buffer.from('other')) } }));
    peer.send({ k: 'chunk', id: 'u1', i: 0, data: bytes.subarray(0, NODE_LIMITS.chunkBytes).toString('base64') });
    peer.send({ k: 'chunk', id: 'u1', i: 1, data: bytes.subarray(NODE_LIMITS.chunkBytes).toString('base64') });
    expect(await peer.next('result')).toMatchObject({ id: 'u1', status: 400, body: { error: { code: 'invalid_request' } } });
    peer.send(callFrame('u2', { route: 'uploadCreate', bulk: { size: bytes.length, sha256: sha256(bytes) } }));
    peer.send({ k: 'chunk', id: 'u2', i: 0, data: bytes.subarray(0, NODE_LIMITS.chunkBytes).toString('base64') });
    peer.send({ k: 'chunk', id: 'u2', i: 1, data: bytes.subarray(NODE_LIMITS.chunkBytes).toString('base64') });
    await vi.waitFor(() => expect(peer.frames.filter((f) => f.k === 'result')).toHaveLength(2));
    expect(got).toEqual([{ id: 'u2', sha: sha256(bytes) }]);
    // At most four uploads arriving at once: a fifth is its call's 400, before a byte is kept.
    for (const id of ['u3', 'u4', 'u5', 'u6', 'u7']) peer.send(callFrame(id, { route: 'uploadCreate', bulk: { size: bytes.length, sha256: sha256(bytes) } }));
    await vi.waitFor(() => expect(peer.frames.filter((f) => f.k === 'result')).toHaveLength(3));
    expect(peer.frames.filter((f) => f.k === 'result').map((f) => [(f as NodeFrameOf<'result'>).id, (f as NodeFrameOf<'result'>).status])).toEqual([
      ['u1', 400],
      ['u2', 201],
      ['u7', 400],
    ]);
    // A chunk for no call at all is the hub's protocol error.
    peer.send({ k: 'chunk', id: 'nobody', i: 0, data: 'AAAA' });
    expect(await peer.closed).toBe(NODE_CLOSE.protocol);
  });

  it("a call id the node is already running is the hub's protocol error (4400)", async () => {
    const pinned = generateKeyPair();
    const hub = await fakeHub(pinned, (peer) => (peer.send(callFrame('c1')), peer.send(callFrame('c1'))));
    const { ctx } = await nodeHome(hub.url, pinned.publicKey);
    startDialer(ctx, (l) => l.onCall(() => new Promise(() => {})));
    await vi.waitFor(() => expect(hub.peers).toHaveLength(1));
    expect(await hub.peers[0]!.closed).toBe(NODE_CLOSE.protocol);
  });

  it('a frame over 1 MiB from the hub closes 1009; stopping closes 1001 and tries no more', async () => {
    const pinned = generateKeyPair();
    const hub = await fakeHub(pinned);
    const { ctx, clock } = await nodeHome(hub.url, pinned.publicKey);
    const { d, links } = startDialer(ctx);
    await vi.waitFor(() => expect(links).toHaveLength(1));
    hub.peers[0]!.sendText(JSON.stringify({ k: 'heartbeat', ts: 'x'.repeat(NODE_LIMITS.frameBytes) }));
    expect(await hub.peers[0]!.closed).toBe(NODE_CLOSE.tooBig);
    const r = await attempt(d, clock);
    expect(r.status.lastClose?.code).toBe(NODE_CLOSE.tooBig);
    clock.advance(r.wait);
    await vi.waitFor(() => expect(links).toHaveLength(2));
    await d.stop();
    expect(await hub.peers[1]!.closed).toBe(NODE_CLOSE.goingAway);
    expect(d.status()).toMatchObject({ state: 'off', retryAt: null });
    clock.advance(NODE_LIMITS.hourlyRetryMs);
    expect(hub.upgrades).toHaveLength(2);
  });
});
