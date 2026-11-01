/**
 * v0.6 Fleet, `pairWithHub` (what `jantar node join` runs) against a hub on
 * loopback http (S8, S9, S11): the node's file comes back only when the
 * reply is signed by the key in the line; a wrong pinned key, a redirect,
 * Cloudflare Access's 403, Fleet off and a used line each say their own
 * sentence and return nothing to save; the Access headers ride on the claim.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeJoinToken, decodeJoinToken } from '@jantar/protocol/node-link';
import { generateKeyPair, privateKeyOf, publicKeyFor } from '../../src/link/keys.js';
import { pairWithHub } from '../../src/link/join.js';
import { cleanup, startHub } from './harness.js';

afterEach(cleanup);

const OPTS = { os: 'linux' as const, version: '0.6.0', cfAccess: null };

/** A server answering every request with `status` and `body`, counting requests. */
async function answering(status: number, body: string, headers: Record<string, string> = {}) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { url, hits, close };
}

function lineFor(url: string, hubKey = generateKeyPair().publicKey): string {
  return encodeJoinToken({ url, code: 'C'.repeat(22), hubKey });
}

describe('pairWithHub', () => {
  it('pairs: the node file holds the hub URL, the name the Mac gave, the pinned key and a fresh private key', async () => {
    const hub = await startHub();
    const token = await hub.token('build-1');
    const r = await pairWithHub(token, OPTS);
    if (!r.ok) throw new Error(r.reason);
    const d = decodeJoinToken(token);
    expect(d.ok && r.node).toMatchObject({ v: 1, url: hub.url, name: 'build-1', hubKey: d.ok ? d.token.hubKey : '', cfAccess: null });
    const rec = hub.ctx.db.nodes.get(r.node.nodeId);
    // The hub keeps the public half only, and it is the node's.
    expect(rec?.publicKey).toBe(publicKeyFor(privateKeyOf(r.node.privateKey)!));
    expect(JSON.stringify(hub.ctx.db.nodes.list())).not.toContain('PRIVATE KEY');
    // The same line again: the hub's one sentence, nothing to save.
    const again = await pairWithHub(token, OPTS);
    expect(again).toMatchObject({ ok: false, status: 401 });
    expect(again.ok ? '' : again.reason).toMatch(/not valid \(used, expired or mistyped\)/);
  });

  it('a wrong pinned key: the hub answered, but it is not the Mac that made the line', async () => {
    const hub = await startHub();
    const d = decodeJoinToken(await hub.token());
    if (!d.ok) throw new Error(d.reason);
    const forged = encodeJoinToken({ ...d.token, hubKey: generateKeyPair().publicKey });
    const r = await pairWithHub(forged, OPTS);
    expect(r).toEqual({
      ok: false,
      status: 201,
      reason:
        'The server at that address is not the Mac that made this line: nothing was saved. Someone else may answer at that address and have used the line: at the Mac, run jantar node revoke <name> for the name it was made for.',
    });
  });

  it('a redirect is never followed', async () => {
    const target = await answering(201, '{}');
    const redirect = await answering(307, '', { location: `${target.url}/v1/node/pair` });
    const r = await pairWithHub(lineFor(redirect.url), OPTS);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/redirect, and servers never follow one/);
    expect(redirect.hits).toEqual(['POST /v1/node/pair']);
    expect(target.hits).toEqual([]);
    await Promise.all([target.close(), redirect.close()]);
  });

  it("Cloudflare Access's 403 (no Jantar body) is told apart from the hub's own", async () => {
    const access = await answering(403, '<!doctype html><title>Forbidden</title>', { 'content-type': 'text/html' });
    const r = await pairWithHub(lineFor(access.url), OPTS);
    expect(r).toMatchObject({ ok: false, status: 403, accessRefused: true });
    expect(r.ok ? '' : r.reason).toMatch(/^Cloudflare Access refused the connection/);
    const jantar = await answering(403, JSON.stringify({ error: { code: 'forbidden', message: 'browsers cannot call this' } }));
    const own = await pairWithHub(lineFor(jantar.url), OPTS);
    expect(own.ok ? '' : own.reason).toMatch(/^The hub refused this server \(403\)/);
    expect(own).not.toHaveProperty('accessRefused');
    await Promise.all([access.close(), jantar.close()]);
  });

  it('Fleet off (404), versions (426), too many (429), each its own sentence; nothing the server wrote is printed', async () => {
    const said = 'PRINT-ME-\u001b[31m';
    for (const [status, re] of [
      [404, /^Fleet is off at the Mac/],
      [426, /different link versions/],
      [429, /^Too many attempts/],
      [500, /^The hub answered 500\.$/],
    ] as const) {
      const s = await answering(status, JSON.stringify({ error: { code: 'internal', message: said } }));
      const r = await pairWithHub(lineFor(s.url), OPTS);
      expect(r).toMatchObject({ ok: false, status });
      expect(r.ok ? '' : r.reason).toMatch(re);
      expect(JSON.stringify(r)).not.toContain('PRINT-ME');
      await s.close();
    }
  });

  it('a reply that is not a pairing reply saves nothing', async () => {
    const s = await answering(201, JSON.stringify({ nodeId: 'x' }));
    expect(await pairWithHub(lineFor(s.url), OPTS)).toMatchObject({ ok: false, status: 201, reason: /not understood/ });
    await s.close();
  });

  it('no hub there, or not a join line', async () => {
    const s = await answering(200, '');
    await s.close();
    const r = await pairWithHub(lineFor(s.url), OPTS);
    expect(r.ok ? '' : r.reason).toMatch(/^Could not reach the hub at 127\.0\.0\.1 \(ECONNREFUSED\)/);
    expect(await pairWithHub('jn1.!!!', OPTS)).toMatchObject({ ok: false, reason: /^This is not a join line/ });
    expect(await pairWithHub(encodeJoinToken({ url: 'https://h.example.com', code: 'C'.repeat(22), hubKey: generateKeyPair().publicKey }).replace('jn1.', 'jn2.'), OPTS)).toMatchObject({ ok: false });
  });

  it('sends the Access headers on the claim, and keeps them in the node file', async () => {
    const hub = await startHub();
    const cfAccess = { clientId: 'synthetic-id.access', clientSecret: 'synthetic-secret' };
    const r = await pairWithHub(await hub.token(), { ...OPTS, cfAccess });
    expect(r.ok && r.node.cfAccess).toEqual(cfAccess);
    expect(hub.pairHeaders[0]).toMatchObject({ 'cf-access-client-id': cfAccess.clientId, 'cf-access-client-secret': cfAccess.clientSecret });
    // The hub's own context never logged them.
    expect(JSON.stringify(hub.ctx.log.records)).not.toContain('synthetic-secret');
  });
});
