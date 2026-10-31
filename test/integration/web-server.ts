/**
 * Serves the BUILT web app (packages/web/dist) the way the daemon does, with
 * the daemon's real response headers (its Content-Security-Policy included,
 * from packages/daemon/src/api/security.ts), and answers /v1 with the
 * synthetic web-fixture data. The built index.html adds the app's own strict
 * policy (style-src 'self') as a <meta>; a browser enforces both.
 *
 * Nothing here talks to a real daemon, a terminal or the user's files. The
 * event stream is refused, so the app falls back to polling /v1/state.
 *
 * With a v0.3 fixture (web-fixture-v03.ts) it also answers the Files, New
 * session, Rewrite and Controls routes from it. File bytes go out with the
 * daemon's own raw headers (files/raw.ts), and writes are kept in `writes`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { securityHeaders } from '@jantar/daemon/api/security';
import { rawHeaders } from '@jantar/daemon/files/raw';
import { SCREENSHOT_AT_HEADER, SCREENSHOT_DISTURBED_HEADER, SCREENSHOT_SIZE_HEADER, type LaunchFlags, type SendJob } from '@jantar/protocol';
import { transcriptFixture, type WebFixture } from './web-fixture.js';
import type { V03Fixture } from './web-fixture-v03.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  // pdf.js's standard fonts, typed as the daemon's static server types them.
  '.ttf': 'font/ttf',
  '.pfb': 'application/x-font-type1',
};

export interface WebServer {
  port: number;
  base: string;
  /** Every request path, in order (for debugging a failed run). */
  requests: string[];
  /** Every write with its JSON body, in order. */
  writes: Array<{ method: string; path: string; body: unknown }>;
  /** /v1 paths the fixture had no answer for. */
  misses: string[];
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function serveWebApp(dist: string, fixture: () => WebFixture & { v03?: V03Fixture }): Promise<WebServer> {
  const requests: string[] = [];
  const writes: WebServer['writes'] = [];
  const misses: string[] = [];
  let port = 0;

  const json = (res: ServerResponse, body: unknown, status = 200) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  };

  /** What a v0.3 route answers, from the v0.3 fixture; null when the path is not one of them. */
  type Reply = { status?: number; body: unknown } | { bytes: Buffer; type: string; headers: Record<string, string> };
  const missing = (message: string): Reply => ({ status: 404, body: { error: { code: 'not_found', message } } });
  const unsupported: Reply = { status: 415, body: { error: { code: 'unsupported_media_type', message: 'not this kind of file' } } };
  let lastRewrite: { job: ReturnType<V03Fixture['rewrite']['job']>; input: string } | null = null;

  const v03Reply = (method: string, url: URL, v: V03Fixture, body: unknown): Reply | null => {
    const path = url.pathname;
    const q = url.searchParams;
    const get = method === 'GET';
    const rel = (q.get('path') ?? '').replace(/\/+$/, '');
    let m: RegExpExecArray | null;
    if (get && (path === '/v1/files/roots' || path === '/v1/folders/roots')) return { body: { roots: v.roots } };
    if (get && path === '/v1/files/list') {
      const listing = v.dirs.get(rel);
      return listing ? { body: { ...listing, root: q.get('root') } } : missing('no such folder');
    }
    if (get && (path === '/v1/files/stat' || path === '/v1/files/text' || path === '/v1/files/raw')) {
      const file = v.files.get(rel);
      if (!file) return missing('no such file');
      if (path === '/v1/files/stat') return { body: file.stat };
      if (path === '/v1/files/text') return file.text ? { body: file.text } : unsupported;
      return file.raw ? { bytes: file.raw.body, type: file.raw.type, headers: rawHeaders(rel.slice(rel.lastIndexOf('/') + 1)) } : unsupported;
    }
    if (get && path === '/v1/files/changes') return { body: { changes: v.changes } };
    if (get && (m = /^\/v1\/sessions\/([^/]+)\/changes$/.exec(path))) {
      const sid = decodeURIComponent(m[1]!);
      return { body: { changes: v.changes.filter((c) => c.sid === sid), scan: { done: true, bytes: 48_000, total: 48_000 }, truncated: false } };
    }
    if (get && path === '/v1/folders') {
      const listing = v.folders.get(rel);
      return listing ? { body: listing } : missing('no such folder');
    }
    if (get && path === '/v1/folders/recent') return { body: { recent: [] } };
    if (get && path === '/v1/launch/preview') return { body: v.preview(q) };
    // v0.4's start sheet asks for the folder's past conversations: none in this fixture.
    if (get && path === '/v1/launch/history') return { body: { sessions: [] } };
    if (get && (m = /^\/v1\/launches\/([^/]+)$/.exec(path))) {
      const l = v.launches.get(decodeURIComponent(m[1]!));
      return l ? { body: l } : missing('no such launch');
    }
    if (method === 'POST' && path === '/v1/launches') {
      const b = body as { flags: LaunchFlags; account: number | 'auto' };
      const job = v.started(b.flags, b.account === 'auto' ? 7 : b.account);
      v.launches.set(job.id, { job });
      return { status: 202, body: { job } };
    }
    if (method === 'POST' && (m = /^\/v1\/sessions\/([^/]+)\/rewrite$/.exec(path))) {
      const text = String((body as { text?: string } | undefined)?.text ?? '');
      const job = v.rewrite.job(decodeURIComponent(m[1]!), text);
      lastRewrite = { job, input: text };
      return { status: 202, body: { jobId: job.id, job } };
    }
    if (/^\/v1\/rewrite\/[^/]+$/.test(path) && (get || method === 'DELETE')) {
      if (!lastRewrite) return missing('no such rewrite job');
      return get ? { body: v.rewrite.detail(lastRewrite.job, lastRewrite.input) } : { body: { job: { ...lastRewrite.job, state: 'cancelled' } } };
    }
    if (get && /^\/v1\/sessions\/[^/]+\/screenshot$/.test(path)) {
      const png = v.screenshot;
      return {
        bytes: png,
        type: 'image/png',
        headers: {
          'cache-control': 'no-store',
          etag: '"synthetic-shot"',
          [SCREENSHOT_AT_HEADER]: new Date().toISOString(),
          [SCREENSHOT_SIZE_HEADER]: `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`,
          [SCREENSHOT_DISTURBED_HEADER]: '0',
        },
      };
    }
    if (method === 'POST' && (m = /^\/v1\/sessions\/([^/]+)\/prompt$/.exec(path))) {
      const text = String((body as { text?: string } | undefined)?.text ?? '');
      const at = new Date().toISOString();
      const job = { id: 'send-e2e-1', sid: decodeURIComponent(m[1]!), textHash: 'sha256:x', textLength: text.length, stage: 'queued', attempts: 0, createdAt: at, updatedAt: at } as SendJob;
      return { body: { jobId: job.id, job } };
    }
    return null;
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const path = url.pathname;
    const f = fixture();
    const now = Date.now();
    const body = req.method === 'GET' ? undefined : await readJson(req);
    if (req.method !== 'GET') writes.push({ method: req.method ?? '', path, body });
    const reply = f.v03 ? v03Reply(req.method ?? 'GET', url, f.v03, body) : null;
    if (reply && 'bytes' in reply) {
      res.writeHead(200, { ...reply.headers, 'content-type': reply.type, 'content-length': String(reply.bytes.length) });
      res.end(reply.bytes);
      return;
    }
    if (reply) return json(res, reply.body, reply.status);
    if (req.method === 'GET' && path === '/v1/state') return json(res, f.state);
    if (req.method === 'GET' && path === '/v1/plan') return json(res, f.plan);
    if (req.method === 'GET' && path === '/v1/accounts') {
      const st = f.state.state;
      return json(res, { accounts: Object.values(st.accounts), activeAccount: st.activeAccount, fetchedAt: st.usage.fetchedAt, source: 'cache' });
    }
    if (req.method === 'GET' && path === '/v1/devices') {
      return json(res, {
        devices: [
          { id: 'dev1', name: 'Mac (Chrome)', scopes: ['read', 'control', 'admin'], createdAt: new Date(now - 3 * 86_400_000).toISOString(), lastSeenAt: new Date(now).toISOString() },
          { id: 'dev2', name: 'iPhone', scopes: ['read', 'control'], createdAt: new Date(now - 2 * 86_400_000).toISOString(), lastSeenAt: new Date(now - 12 * 60_000).toISOString() },
        ],
      });
    }
    if (req.method === 'GET' && /^\/v1\/sessions\/[^/]+\/transcript$/.test(path)) return json(res, transcriptFixture(now));
    if (req.method === 'GET' && /^\/v1\/sessions\/[^/]+\/screen$/.test(path)) {
      return json(res, { text: '> fix the login redirect\n\n  Grep(Set-Cookie)\n  Found 2 files\n', lines: 4, at: new Date(now).toISOString(), backend: 'scripted' });
    }
    if (req.method === 'POST' && path === '/v1/pair/start') {
      const code = 'SYNTHETICpairCODE0123456789abcdef';
      return json(res, { code, url: `http://127.0.0.1:${port}/pair#c=${code}`, expiresAt: new Date(now + 5 * 60_000).toISOString() });
    }
    misses.push(`${req.method} ${path}`);
    return json(res, { error: { code: 'not_found', message: 'not in the web fixture' } }, 404);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    requests.push(`${req.method} ${path}`);
    for (const [k, v] of Object.entries(securityHeaders(req.headers.host))) res.setHeader(k, v);
    if (path.startsWith('/v1/') || path === '/healthz') return void api(req, res, url);
    // Static files, with the SPA fallback to index.html (as packages/daemon/src/api/static.ts).
    const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    let file = join(dist, rel);
    if (!file.startsWith(dist + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      ...(file.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {}),
    });
    createReadStream(file).pipe(res);
  });
  // The event stream: refused, like a daemon that does not answer (the app polls).
  server.on('upgrade', (_req, socket) => socket.destroy());

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    requests,
    writes,
    misses,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
