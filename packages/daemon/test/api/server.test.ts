/**
 * Real listeners: TCP on 127.0.0.1 (port 0) and the control socket in a short
 * temp dir. Everything is stopped in afterEach.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_COOKIE, DEVICE_SECRET_HEADER, EVENTS_WS_PROTOCOL, SettingsSchema, eventsSocketProtocols, settingsFeatures } from '@jantar/protocol';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { ApiServerImpl, bindHost } from '../../src/api/server.js';
import { createApiServer } from '../../src/api/index.js';
import { depsOf, makeFakes, makeSession } from './fakes.js';

// The `ws` client that @fastify/websocket itself depends on (test only).
const requireHere = createRequire(import.meta.url);
const WebSocket = createRequire(requireHere.resolve('@fastify/websocket'))('ws') as new (
  url: string,
  protocols?: string[] | { headers?: Record<string, string> },
  opts?: { headers?: Record<string, string> },
) => {
  readonly protocol: string;
  on(ev: string, fn: (...a: unknown[]) => void): void;
  once(ev: string, fn: (...a: unknown[]) => void): void;
  close(): void;
};

/** The status a refused upgrade answers with (or the error text). */
function refusal(ws: InstanceType<typeof WebSocket>): Promise<string> {
  return new Promise<string>((resolve) => {
    ws.on('unexpected-response', (_req, res) => resolve(String((res as { statusCode: number }).statusCode)));
    ws.on('error', (e) => resolve(String((e as Error).message)));
  });
}

let dir: string;
let ctx: TestContext;
let server: ApiServerImpl | null = null;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-e-')));
  ctx = createTestContext({ home: join(dir, 'state') });
});

afterEach(async () => {
  await server?.stop();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(opts: { socketPath?: string; port?: number; method?: string; path: string; headers?: Record<string, string>; body?: unknown }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { ...opts.headers };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = request(
      {
        ...(opts.socketPath ? { socketPath: opts.socketPath } : { host: '127.0.0.1', port: opts.port }),
        method: opts.method ?? 'GET',
        path: opts.path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startServer(sock: string | false = join(dir, 'ctl.sock')): Promise<ApiServerImpl> {
  const fakes = makeFakes(ctx);
  const s = makeSession();
  ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
  server = new ApiServerImpl(ctx, depsOf(fakes), { port: 0, ctlSocket: sock, webDist: null });
  await server.start();
  return server;
}

describe('ApiServer', () => {
  it('listens on loopback, serves the control socket (0600) and stops cleanly', async () => {
    const srv = await startServer();
    const addr = srv.address();
    expect(addr?.host).toBe('127.0.0.1');
    expect(addr?.port).toBeGreaterThan(0);
    const sock = join(dir, 'ctl.sock');
    expect((await stat(sock)).mode & 0o777).toBe(0o600);

    const health = await http({ port: addr?.port, path: '/healthz', headers: { host: `127.0.0.1:${addr?.port}` } });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).ok).toBe(true);
    expect((await http({ port: addr?.port, path: '/v1/state', headers: { host: `127.0.0.1:${addr?.port}` } })).status).toBe(401);

    // The CLI's verbs over the socket.
    const status = await http({ socketPath: sock, path: '/ctl/status', headers: { host: 'jantar.local' } });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ api: { host: '127.0.0.1', port: addr?.port }, ctlSocket: sock });
    const pair = await http({ socketPath: sock, method: 'POST', path: '/v1/pair/start', headers: { host: 'jantar.local' }, body: { scopes: ['admin'] } });
    expect(pair.status).toBe(200);
    expect(JSON.parse(pair.body).url).toBe(`http://127.0.0.1:${addr?.port}/pair#c=${JSON.parse(pair.body).code}`);
    const send = await http({ socketPath: sock, method: 'POST', path: '/v1/sessions/sess-aaaa-1111/prompt', headers: { host: 'jantar.local' }, body: { text: 'hi' } });
    expect(send.status).toBe(202);
    expect((await http({ socketPath: sock, path: '/ctl/hooks', headers: { host: 'jantar.local' } })).status).toBe(200);
    // No approve verb on the socket.
    const approve = await http({ socketPath: sock, method: 'POST', path: '/v1/pending/x/decision', headers: { host: 'jantar.local' }, body: { behavior: 'allow' } });
    expect(approve.status).toBe(404);

    // daemon.version was emitted on start, with the feature switches (v0.3: only controls is on by default) and, since v0.4, the accounts mode.
    expect(ctx.store.getState().daemon).toEqual({ protocol: 3, daemonVersion: '0.0.0-test', webHash: null, features: settingsFeatures(ctx.settings.get()), accountsMode: 'cswap' });
    expect(ctx.store.getState().daemon?.features).toMatchObject({ files: false, launch: false, rewrite: false, controls: true, screenshots: false });

    await srv.stop();
    server = null;
    expect(existsSync(sock)).toBe(false);
  });

  it('end to end over real sockets: pair via the CLI socket, claim over TCP, then stream events', async () => {
    const srv = await startServer();
    const port = srv.address()?.port as number;
    const origin = `http://127.0.0.1:${port}`;
    const host = `127.0.0.1:${port}`;
    const sock = join(dir, 'ctl.sock');
    const code = JSON.parse((await http({ socketPath: sock, method: 'POST', path: '/v1/pair/start', headers: { host: 'x' }, body: {} })).body).code as string;
    const claim = await http({ port, method: 'POST', path: '/v1/pair/claim', headers: { host, origin }, body: { code, name: 'Browser' } });
    expect(claim.status).toBe(200);
    const setCookie = String(claim.headers['set-cookie']);
    const cookie = setCookie.split(';')[0] as string;
    expect(cookie.startsWith(`${DEVICE_COOKIE}=`)).toBe(true);
    const secret = JSON.parse(claim.body).deviceSecret as string;

    // The cookie alone (what another 127.0.0.1 port would see) does not open the stream.
    const cookieOnly = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, { headers: { origin, cookie } });
    expect(await refusal(cookieOnly)).toMatch(/401/);

    // A browser offers the secret as a second subprotocol; the daemon selects only "jantar".
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, eventsSocketProtocols(secret), { headers: { origin, cookie } });
    const got: { kind: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (d) => {
        got.push(JSON.parse(String(d)));
        if (got.length === 3) resolve();
      });
      ws.on('error', reject);
      ws.once('open', () => ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { mode: 'plan' } } }));
    });
    expect(got.map((m) => m.kind)).toEqual(['hello', 'snapshot', 'event']);
    expect(ws.protocol).toBe(EVENTS_WS_PROTOCOL);
    ws.close();

    // Writes: the cookie alone is refused, cookie plus secret is not.
    const bare = await http({ port, method: 'POST', path: '/v1/usage/refresh', headers: { host, origin, cookie } });
    expect(bare.status).toBe(401);
    const full = await http({ port, method: 'POST', path: '/v1/usage/refresh', headers: { host, origin, cookie, [DEVICE_SECRET_HEADER]: secret } });
    expect(full.status).toBe(202);

    // A wrong Origin is refused at the upgrade.
    const bad = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, eventsSocketProtocols(secret), { headers: { origin: 'https://evil.example', cookie } });
    expect(await refusal(bad)).toMatch(/403/);
  });

  it('replaces a stale control socket but refuses a live one or a non-socket file', async () => {
    const sock = join(dir, 'ctl.sock');
    // A crashed daemon leaves its socket file behind (process exits without closing it).
    execFileSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`]);
    expect(existsSync(sock)).toBe(true);
    const srv = await startServer(sock);
    expect(srv.services.ctlSocketPath).toBe(sock);

    const other = new ApiServerImpl(ctx, depsOf(makeFakes(ctx)), { port: 0, ctlSocket: sock, webDist: null });
    await expect(other.start()).rejects.toThrow(/already listening/);
    expect(other.address()).toBeNull();
    await srv.stop();
    server = null;

    const file = join(dir, 'not-a-socket');
    await writeFile(file, 'keep me');
    const third = new ApiServerImpl(ctx, depsOf(makeFakes(ctx)), { port: 0, ctlSocket: file, webDist: null });
    await expect(third.start()).rejects.toThrow(/not a socket/);
    expect(existsSync(file)).toBe(true);
  });

  it('binds loopback only unless remote.mode is "lan"', () => {
    const c = createTestContext({ settings: SettingsSchema.parse({ remote: { host: '0.0.0.0' } }) });
    expect(bindHost(c)).toBe('127.0.0.1');
    expect(bindHost(c, '::1')).toBe('::1');
    const lan = createTestContext({ settings: SettingsSchema.parse({ remote: { host: '0.0.0.0', mode: 'lan' } }) });
    expect(bindHost(lan)).toBe('0.0.0.0');
  });

  it('createApiServer matches the Factories signature', () => {
    const api = createApiServer(ctx, depsOf(makeFakes(ctx)));
    expect(api.address()).toBeNull();
  });
});
