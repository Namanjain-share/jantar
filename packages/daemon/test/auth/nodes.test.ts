/**
 * v0.6 Fleet, NodeAuth (S8, S9, S12): join lines (names reserved, single
 * use, 10 minutes, the token holds the URL, the code and the hub's public
 * key and nothing else), the claim (one generic 401, 426 for another link
 * version without spending the code, rate limited per caller, the reply
 * signed by the key in the line), the hub keeping public keys only, idle
 * expiry, touch and revoke.
 */
import { stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_IDLE_MS, PAIR_CODE_TTL_MS, type NodePairBody } from '@jantar/protocol';
import { NODE_PROTO, decodeJoinToken } from '@jantar/protocol/node-link';
import { JOIN_LINE_INVALID, NODE_CLAIMS_PER_MIN, NodeAuth } from '../../src/auth/nodes.js';
import { FakeClock } from '../../src/core/clock.js';
import { generateKeyPair, verifyPair } from '../../src/link/keys.js';
import { cleanup, testCtx } from '../link/harness.js';

afterEach(cleanup);

const HUB_URL = 'https://jantar.example.com';

async function setup() {
  const clock = new FakeClock(Date.parse('2026-11-01T10:00:00.000Z'));
  const ctx = await testCtx({ clock });
  return { ctx, clock, auth: new NodeAuth(ctx) };
}

async function lines(auth: NodeAuth, body: { name?: string; count?: number } = {}) {
  const r = await auth.makeTokens(body, { hubUrl: HUB_URL, createdBy: 'cli' });
  if (!r.ok) throw new Error(r.reason);
  return r.tokens;
}

function claimBody(token: string, over: Partial<NodePairBody> = {}): NodePairBody & { key: ReturnType<typeof generateKeyPair> } {
  const d = decodeJoinToken(token);
  if (!d.ok) throw new Error(d.reason);
  const key = generateKeyPair();
  return { code: d.token.code, publicKey: key.publicKey, os: 'linux', version: '0.6.0', proto: NODE_PROTO, key, ...over };
}

describe('NodeAuth.makeTokens', () => {
  it('a join line holds the hub URL, a one-time 128-bit code and the hub public key, nothing more', async () => {
    const { auth, ctx } = await setup();
    const [t] = await lines(auth, { name: 'build' });
    expect(t).toMatchObject({ name: 'build', expiresAt: '2026-11-01T10:10:00.000Z' });
    const json = JSON.parse(Buffer.from(t!.token.slice(4), 'base64url').toString('utf8')) as Record<string, string>;
    expect(Object.keys(json).sort()).toEqual(['c', 'h', 'u']);
    expect(json.u).toBe(HUB_URL);
    expect(Buffer.from(json.c!, 'base64url')).toHaveLength(16);
    expect(json.h).toBe((await auth.hubKey()).publicKey);
    // The hub key file: PKCS8 0600 in a 0700 dir; the db keeps no private key.
    if (process.platform !== 'win32') {
      expect((await stat(ctx.paths.hubKeyFile)).mode & 0o777).toBe(0o600);
      expect((await stat(ctx.paths.fleetDir)).mode & 0o777).toBe(0o700);
    }
  });

  it('names: node-<n> by default (the lowest free n), <name>-1..K with a count', async () => {
    const { auth } = await setup();
    expect((await lines(auth)).map((t) => t.name)).toEqual(['node-1']);
    expect((await lines(auth)).map((t) => t.name)).toEqual(['node-2']);
    expect((await lines(auth, { count: 3 })).map((t) => t.name)).toEqual(['node-3', 'node-4', 'node-5']);
    expect((await lines(auth, { name: 'build', count: 3 })).map((t) => t.name)).toEqual(['build-1', 'build-2', 'build-3']);
    expect((await lines(auth, { name: 'win', count: 1 })).map((t) => t.name)).toEqual(['win']);
  });

  it('a name already paired or waiting on a line is refused; a revoked one is free again', async () => {
    const { auth } = await setup();
    const [t] = await lines(auth, { name: 'build-1' });
    const again = await auth.makeTokens({ name: 'build-1' }, { hubUrl: HUB_URL, createdBy: 'cli' });
    expect(again).toMatchObject({ ok: false, code: 'conflict' });
    expect(await auth.makeTokens({ name: 'build', count: 2 }, { hubUrl: HUB_URL, createdBy: 'cli' })).toMatchObject({ ok: false, code: 'conflict' });
    const paired = await auth.pair(claimBody(t!.token), { rateKey: 'k' });
    if (!paired.ok) throw new Error(paired.reason);
    expect(await auth.makeTokens({ name: 'build-1' }, { hubUrl: HUB_URL, createdBy: 'cli' })).toMatchObject({ ok: false, code: 'conflict' });
    auth.revoke(paired.nodeId, 'cli');
    expect((await lines(auth, { name: 'build-1' })).map((x) => x.name)).toEqual(['build-1']);
  });

  it('a count that makes a name too long, or a door servers cannot use, is refused', async () => {
    const { auth } = await setup();
    expect(await auth.makeTokens({ name: 'a'.repeat(23), count: 2 }, { hubUrl: HUB_URL, createdBy: 'cli' })).toMatchObject({ ok: false, code: 'invalid_request' });
    for (const hubUrl of ['', 'http://jantar.example.com', 'https://x.example.com/path', 'not a url']) {
      expect(await auth.makeTokens({}, { hubUrl, createdBy: 'cli' }), hubUrl).toMatchObject({ ok: false, code: 'conflict' });
    }
    // Loopback http is the tests' door.
    expect(await auth.makeTokens({}, { hubUrl: 'http://127.0.0.1:7431', createdBy: 'cli' })).toMatchObject({ ok: true });
  });

  it('logs names and counts, never a code or a token', async () => {
    const { auth, ctx } = await setup();
    const ts = await lines(auth, { name: 'build', count: 2 });
    const logged = JSON.stringify(ctx.log.records);
    for (const t of ts) {
      expect(logged).not.toContain(t.token);
      const d = decodeJoinToken(t.token);
      if (d.ok) expect(logged).not.toContain(d.token.code);
    }
  });
});

describe('NodeAuth.pair', () => {
  it('spends the code, keeps the public key and the reserved name, and signs the reply with the pinned key', async () => {
    const { auth, ctx } = await setup();
    const [t] = await lines(auth, { name: 'build-1' });
    const body = claimBody(t!.token);
    const r = await auth.pair(body, { rateKey: 'k' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.reply.name).toBe('build-1');
    const hubKey = (decodeJoinToken(t!.token) as { ok: true; token: { hubKey: string } }).token.hubKey;
    expect(verifyPair(hubKey, r.nodeId, body.publicKey, r.reply.sig)).toBe(true);
    expect(ctx.db.nodes.get(r.nodeId)).toEqual({
      id: r.nodeId,
      name: 'build-1',
      publicKey: body.publicKey,
      os: 'linux',
      version: '0.6.0',
      createdAt: '2026-11-01T10:00:00.000Z',
      lastSeenAt: null,
      revokedAt: null,
    });
    // Used: the same line again is the one generic refusal.
    expect(await auth.pair(claimBody(t!.token), { rateKey: 'k' })).toEqual({ ok: false, code: 'unauthorized', reason: JOIN_LINE_INVALID });
    expect(auth.pairedCount()).toBe(1);
  });

  it('expired, mistyped or never made: the same 401 sentence', async () => {
    const { auth, clock } = await setup();
    const [t] = await lines(auth);
    clock.advance(PAIR_CODE_TTL_MS + 1);
    const refusals = [
      await auth.pair(claimBody(t!.token), { rateKey: 'a' }),
      await auth.pair(claimBody(t!.token, { code: 'A'.repeat(22) }), { rateKey: 'a' }),
      await auth.pair(claimBody(t!.token, { code: 'not a code at all!' }), { rateKey: 'a' }),
    ];
    for (const r of refusals) expect(r).toEqual({ ok: false, code: 'unauthorized', reason: JOIN_LINE_INVALID });
    expect(auth.pairedCount()).toBe(0);
  });

  it('another link version is 426 and spends nothing', async () => {
    const { auth } = await setup();
    const [t] = await lines(auth);
    expect(await auth.pair(claimBody(t!.token, { proto: NODE_PROTO + 1 }), { rateKey: 'k' })).toMatchObject({ ok: false, code: 'node_version' });
    expect(await auth.pair(claimBody(t!.token), { rateKey: 'k' })).toMatchObject({ ok: true });
  });

  it('is rate limited per caller, with a retry-after; other callers are not', async () => {
    const { auth, clock } = await setup();
    const [t] = await lines(auth);
    for (let i = 0; i < NODE_CLAIMS_PER_MIN; i += 1) await auth.pair(claimBody(t!.token, { code: 'B'.repeat(22) }), { rateKey: 'busy' });
    const r = await auth.pair(claimBody(t!.token), { rateKey: 'busy' });
    expect(r).toMatchObject({ ok: false, code: 'rate_limited', headers: { 'retry-after': '60' } });
    // The refused attempt spent nothing: another caller pairs with the same line.
    expect(await auth.pair(claimBody(t!.token), { rateKey: 'other' })).toMatchObject({ ok: true });
    clock.advance(60_001);
    expect(await auth.pair(claimBody(t!.token), { rateKey: 'busy' })).toMatchObject({ ok: false, code: 'unauthorized' });
  });
});

describe('NodeAuth.verify, touch, revoke', () => {
  async function paired() {
    const s = await setup();
    const [t] = await lines(s.auth, { name: 'build-1' });
    const r = await s.auth.pair(claimBody(t!.token), { rateKey: 'k' });
    if (!r.ok) throw new Error(r.reason);
    return { ...s, id: r.nodeId };
  }

  it('unknown, revoked, or live', async () => {
    const { auth, id } = await paired();
    expect(auth.verify('01JN0DE0000000000000000009')).toEqual({ ok: false, why: 'unknown' });
    expect(auth.verify(id)).toMatchObject({ ok: true, node: { id, name: 'build-1' } });
    expect(auth.revoke(id, 'cli')?.revokedAt).toBe('2026-11-01T10:00:00.000Z');
    expect(auth.verify(id)).toEqual({ ok: false, why: 'revoked' });
    // Idempotent; an unknown id is null.
    expect(auth.revoke(id, 'cli')?.revokedAt).toBe('2026-11-01T10:00:00.000Z');
    expect(auth.revoke('01JN0DE0000000000000000009', 'cli')).toBeNull();
    expect(auth.pairedCount()).toBe(0);
    expect(auth.list()).toHaveLength(1);
  });

  it('a node unseen for 90 days is revoked when it next connects', async () => {
    const { auth, clock, id, ctx } = await paired();
    clock.advance(EXTENSION_IDLE_MS - 1000);
    expect(auth.verify(id).ok).toBe(true);
    auth.touch(id, { os: 'linux', version: '0.6.0' });
    clock.advance(EXTENSION_IDLE_MS - 1000);
    expect(auth.verify(id).ok).toBe(true);
    clock.advance(2000);
    expect(auth.verify(id)).toEqual({ ok: false, why: 'idle' });
    expect(ctx.db.nodes.get(id)?.revokedAt).not.toBeNull();
  });

  it('touch writes lastSeenAt at most every 5 minutes, and the OS and version when they change', async () => {
    const { auth, clock, id, ctx } = await paired();
    auth.touch(id, { os: 'linux', version: '0.6.0' });
    const first = ctx.db.nodes.get(id)?.lastSeenAt;
    expect(first).toBe('2026-11-01T10:00:00.000Z');
    clock.advance(60_000);
    auth.touch(id, { os: 'wsl', version: '0.6.1' });
    expect(ctx.db.nodes.get(id)).toMatchObject({ lastSeenAt: first, os: 'wsl', version: '0.6.1' });
    clock.advance(5 * 60_000);
    auth.touch(id, { os: 'wsl', version: '0.6.1' });
    expect(ctx.db.nodes.get(id)?.lastSeenAt).toBe('2026-11-01T10:06:00.000Z');
  });

  it('remembers a refused link version for a live node until a good link', async () => {
    const { auth, id } = await paired();
    auth.noteRefusal('01JN0DE0000000000000000009', 4426);
    expect(auth.lastRefusal('01JN0DE0000000000000000009')).toBeNull();
    auth.noteRefusal(id, 4426);
    expect(auth.lastRefusal(id)).toEqual({ code: 4426, at: '2026-11-01T10:00:00.000Z' });
    auth.clearRefusal(id);
    expect(auth.lastRefusal(id)).toBeNull();
  });
});
