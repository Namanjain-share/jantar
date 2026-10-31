import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeWebHash } from '../../src/api/static.js';
import { HOST, h, makeApi, pairCookie, type TestApi } from './fakes.js';

let dist: string;
let api: TestApi;

beforeAll(async () => {
  dist = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-e-web-')));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>t</title><script type="module" src="/assets/app-abc123.js"></script>');
  await writeFile(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  await writeFile(join(dist, 'sw.js'), 'self.addEventListener("push", () => {})');
  await writeFile(join(dist, 'manifest.webmanifest'), '{"name":"t"}');
  await writeFile(join(dist, '.env'), 'SECRET=1');
  api = await makeApi({ api: { webDist: dist } });
});

afterAll(async () => {
  await api?.close();
  await rm(dist, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  api.tcp.inject({ method: 'GET', url, headers: { host: HOST, accept: 'text/html', ...headers } });

describe('static web app', () => {
  it('serves index.html at / with a strict CSP and no referrer', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/assets/app-abc123.js');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('connect-src \'self\' ws://127.0.0.1:7420 wss://127.0.0.1:7420');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves client routes (/s/<sid>, /pair) from index.html', async () => {
    for (const url of ['/s/sess-aaaa-1111?card=x', '/pair']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    }
  });

  it('caches hashed assets for a year and revalidates sw.js and the manifest', async () => {
    const asset = await get('/assets/app-abc123.js', { accept: '*/*' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const sw = await get('/sw.js', { accept: '*/*' });
    expect(sw.headers['cache-control']).toBe('no-cache');
    expect(sw.headers['service-worker-allowed']).toBe('/');
    const manifest = await get('/manifest.webmanifest', { accept: '*/*' });
    expect(manifest.headers['content-type']).toMatch(/application\/manifest\+json/);
  });

  it('never serves dotfiles or paths outside the dist folder', async () => {
    for (const url of ['/.env', '/../package.json', '/assets/../../package.json', '/%2e%2e/package.json']) {
      const res = await get(url, { accept: '*/*' });
      expect(res.body, url).not.toContain('SECRET');
      expect(res.body, url).not.toContain('"name": "@jantar');
    }
  });

  it('API paths are never answered by the web app', async () => {
    const res = await get('/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'not found' } });
    const unauth = await get('/v1/state');
    expect(unauth.statusCode).toBe(401);
  });

  it('sends the web app hash in hello and in daemon state', async () => {
    const hash = computeWebHash(dist);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(api.services.webHash).toBe(hash);
    const { cookie } = await pairCookie(api);
    let first = '';
    const ws = await api.tcp.injectWS('/v1/events', { headers: h(cookie) }, { onInit: (s) => s.once('message', (d: Buffer) => (first = String(d))) });
    for (let i = 0; i < 40 && !first; i++) await new Promise((r) => setTimeout(r, 10));
    expect(JSON.parse(first)).toMatchObject({ kind: 'hello', webHash: hash });
    ws.terminate();
  });
});

describe('without a built web app', () => {
  it('answers / with a short "not built" page (503) and keeps the API working', async () => {
    const bare = await makeApi({ api: { webDist: join(dist, 'missing') } });
    try {
      const res = await bare.tcp.inject({ method: 'GET', url: '/', headers: { host: HOST, accept: 'text/html' } });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain('not built');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(bare.services.webHash).toBeNull();
    } finally {
      await bare.close();
    }
  });
});
