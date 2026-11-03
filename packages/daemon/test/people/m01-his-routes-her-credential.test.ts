/**
 * v0.11 People, M1 and T3 (a, b): every route of his × her credential
 * (spec 9.7.2; Noblot's "highest-value test"). Generated, not hand-listed:
 * it iterates ALL_ROUTES, so a route added later joins it the day it lands.
 *
 * - On her host nothing but hers exists: every non-person route, his event
 *   stream and the node link answer 404 with an empty body, whatever
 *   credential or Origin comes with it (his, at every scope, included).
 *   `/healthz` is the one exception (200, no data).
 * - On his hosts (his public hostname and loopback) her credential is
 *   inert: the status and body equal the same call with no credential, for
 *   her cookie, her secret alone, both, a revoked device's and a left
 *   person's old cookie, with her Origin, his, or none.
 */
import { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NODE_LINK_PATH } from '@jantar/protocol/node-link';
import { handleNodeUpgrade } from '../../src/api/node-upgrade.js';
import {
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  NONE,
  OWNER_HOST,
  OWNER_ORIGIN,
  PEOPLE_HOST,
  PEOPLE_ORIGIN,
  call,
  credHeaders,
  makeFixture,
  routeEntries,
  type Cred,
  type Fixture,
} from './isolation-fixture.js';

let f: Fixture;
beforeAll(async () => {
  f = await makeFixture();
}, 60_000);
afterAll(async () => {
  await f?.close();
});

const hisRoutes = () => routeEntries().filter(([, def]) => def.scope !== 'person');
const herCreds = (): Cred[] => [f.asha.cookie, f.asha.secretOnly, f.asha.full, f.asha.revoked, f.eli.oldCookie, f.fay.oldCookie];

/** The node link's raw upgrade (taken before Fastify), answered on a fake socket. */
async function nodeLink(host: string, headers: Record<string, string>): Promise<string> {
  let written = '';
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, done) {
      written += String(chunk);
      done();
    },
  });
  const s = f.api.services;
  const before = s.ctx.settings.get().fleet.enabled;
  if (!before) await s.ctx.settings.patch({ fleet: { enabled: true } });
  try {
    const req = { url: NODE_LINK_PATH, headers: { host, ...headers } } as never;
    handleNodeUpgrade(s, req, socket, Buffer.alloc(0));
    await new Promise((r) => setImmediate(r));
  } finally {
    if (!before) await s.ctx.settings.patch({ fleet: { enabled: false } });
  }
  return written.split('\r\n')[0] ?? '';
}

describe('M1 / T3 (b): on her host only hers exists', () => {
  it('every non-person route answers 404 with an empty body, with any credential and Origin (healthz: 200, no data)', async () => {
    const creds: Cred[] = [NONE, ...herCreds(), f.owner.read, f.owner.control, f.owner.launch, f.owner.admin, f.owner.cookieOnly];
    const bad: string[] = [];
    let n = 0;
    for (const [name, def] of hisRoutes()) {
      for (const cred of creds) {
        for (const origin of [PEOPLE_ORIGIN, OWNER_ORIGIN, undefined]) {
          const r = await call(f.api, def, { host: PEOPLE_HOST, cred, origin });
          n += 1;
          if (name === 'health') {
            if (r.status !== 200 || Object.keys(JSON.parse(r.body)).sort().join() !== 'daemonVersion,ok,protocol') bad.push(`${name} ${cred.name} ${origin}: ${r.status}`);
          } else if (r.status !== 404 || r.body !== '') {
            bad.push(`${name} ${cred.name} ${origin}: ${r.status} ${r.body.slice(0, 80)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(n).toBeGreaterThan(hisRoutes().length * 30);
  }, 120_000);

  it('his event stream and the node link do not open on her host (404)', async () => {
    for (const cred of [NONE, f.asha.full, f.owner.admin]) {
      await expect(
        f.api.tcp.injectWS('/v1/events', { headers: { host: PEOPLE_HOST, origin: PEOPLE_ORIGIN, ...credHeaders(cred) } }),
      ).rejects.toThrow(/404/);
    }
    expect(await nodeLink(PEOPLE_HOST, {})).toBe('HTTP/1.1 404 Not Found');
    // On his host the link's own checks run (no Origin: handed to Fleet; here a browser's Origin is 403).
    expect(await nodeLink(OWNER_HOST, { origin: OWNER_ORIGIN })).toBe('HTTP/1.1 403 Forbidden');
  });

  it("his static files and app shell are never served on her host; / redirects to /p", async () => {
    for (const path of ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/s/sess-aaaa-1111', '/today', '/assets/index-abc.js', '/v1/state', '/random']) {
      const r = await f.api.tcp.inject({ method: 'GET', url: path, headers: { host: PEOPLE_HOST, accept: 'text/html' } });
      if (path === '/') {
        expect(r.statusCode, path).toBe(302);
        expect(r.headers.location).toBe('/p');
      } else {
        expect([r.statusCode, r.body], path).toEqual([404, '']);
      }
    }
  });
});

describe('M1 / T3 (a): on his hosts her credential is inert', () => {
  it('every non-person route answers her credential exactly as no credential', async () => {
    const bad: string[] = [];
    for (const [name, def] of hisRoutes()) {
      for (const [host, hisOrigin] of [
        [OWNER_HOST, OWNER_ORIGIN],
        [LOOPBACK_HOST, LOOPBACK_ORIGIN],
      ] as const) {
        for (const origin of [PEOPLE_ORIGIN, hisOrigin, undefined]) {
          const bare = await call(f.api, def, { host, cred: NONE, origin });
          for (const cred of herCreds()) {
            const r = await call(f.api, def, { host, cred, origin });
            if (r.status !== bare.status || r.body !== bare.body) bad.push(`${name} ${host} ${cred.name} ${origin}: ${r.status} vs ${bare.status}`);
            // Nothing answers 2xx with data for her (only what answers anyone: /healthz).
            if (r.status < 300 && name !== 'health') bad.push(`${name} ${host} ${cred.name}: ${r.status}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('his event stream refuses her credential as it refuses none', async () => {
    for (const [host, origin] of [
      [OWNER_HOST, OWNER_ORIGIN],
      [LOOPBACK_HOST, LOOPBACK_ORIGIN],
      [OWNER_HOST, PEOPLE_ORIGIN],
    ] as const) {
      const bare = await f.api.tcp.injectWS('/v1/events', { headers: { host, origin } }).then(
        () => 'opened',
        (e: Error) => e.message,
      );
      expect(bare).not.toBe('opened');
      for (const cred of herCreds()) {
        const r = await f.api.tcp.injectWS('/v1/events', { headers: { host, origin, ...credHeaders(cred) } }).then(
          () => 'opened',
          (e: Error) => e.message,
        );
        expect(r, `${host} ${cred.name}`).toBe(bare);
      }
    }
  });

  it('her prefix does not exist on his hosts, nor her app files', async () => {
    for (const host of [OWNER_HOST, LOOPBACK_HOST]) {
      for (const path of ['/v1/p/me', '/v1/p/join/preview', '/v1/p/events', '/v1/p/whatever', '/p.html', '/p-sw.js', '/p.webmanifest']) {
        const r = await f.api.tcp.inject({ method: 'GET', url: path, headers: { host, ...credHeaders(f.asha.full) } });
        expect(r.statusCode, `${host} ${path}`).toBe(404);
      }
    }
  });
});
