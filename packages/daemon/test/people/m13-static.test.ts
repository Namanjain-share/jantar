/**
 * v0.11 People, M13 (spec 9.7.2, C15): static files × host, over a built
 * dist with both apps (synthetic files in the shape the web build writes).
 *
 * - Her host: her shell for /p and /p/<route>, p.html, p-sw.js (with
 *   `service-worker-allowed: /`), p.webmanifest, icons, and under /assets/
 *   only the files her build's manifest names; `/` is a 302 to /p;
 *   everything else (his shell, sw.js, his chunks, a random path) 404.
 * - His host: /p.html, /p-sw.js and /p.webmanifest are 404, /p/* is his
 *   own app's shell (his NotFound), and his files are served as before.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_HOST, PEOPLE_HOST, makeFixture, type Fixture } from './isolation-fixture.js';

let f: Fixture;
let dist: string;

function writeDist(dir: string): void {
  const files: Record<string, string> = {
    'index.html': '<!doctype html><title>owner</title><script type="module" src="/assets/index-AAAAAAAA.js"></script>',
    'sw.js': '/* owner worker */',
    'manifest.webmanifest': '{}',
    'assets/index-AAAAAAAA.js': 'export const owner = 1;',
    'assets/Board-BBBBBBBB.js': 'export const board = 1;',
    'p.html': '<!doctype html><title>hers</title><script type="module" src="/assets/p-CCCCCCCC.js"></script>',
    'p-sw.js': '/* her worker */',
    'p.webmanifest': '{"id":"/p"}',
    'assets/p-CCCCCCCC.js': 'export const hers = 1;',
    'assets/p-p-DDDDDDDD.css': 'body{}',
    'icons/icon-192.png': 'png',
    '.vite/p-manifest.json': JSON.stringify({ 'p.html': { file: 'assets/p-CCCCCCCC.js', isEntry: true, css: ['assets/p-p-DDDDDDDD.css'] } }),
  };
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'jantar-m13-'));
  writeDist(dist);
  f = await makeFixture({ api: { webDist: dist } });
}, 60_000);
afterAll(async () => {
  await f?.close();
  rmSync(dist, { recursive: true, force: true });
});

const get = (host: string, url: string) => f.api.tcp.inject({ method: 'GET', url, headers: { host, accept: 'text/html,*/*' } });

describe('M13: her host serves her app only', () => {
  it('her files', async () => {
    for (const [url, body] of [
      ['/p', 'hers'],
      ['/p/me', 'hers'],
      ['/p/join', 'hers'],
      ['/p.html', 'hers'],
      ['/assets/p-CCCCCCCC.js', 'hers = 1'],
      ['/assets/p-p-DDDDDDDD.css', 'body'],
      ['/p.webmanifest', '"/p"'],
      ['/icons/icon-192.png', 'png'],
    ] as const) {
      const r = await get(PEOPLE_HOST, url);
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).toContain(body);
    }
    const sw = await get(PEOPLE_HOST, '/p-sw.js');
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['service-worker-allowed']).toBe('/');
  });

  it('nothing of his', async () => {
    for (const url of ['/index.html', '/sw.js', '/manifest.webmanifest', '/assets/index-AAAAAAAA.js', '/assets/Board-BBBBBBBB.js', '/s/sess-aaaa-1111', '/random', '/p/../index.html', '/p/%2e%2e/sw.js', '/assets/..%2Findex.html']) {
      const r = await get(PEOPLE_HOST, url);
      expect([r.statusCode, r.body], url).toEqual([404, '']);
    }
    const root = await get(PEOPLE_HOST, '/');
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe('/p');
  });
});

describe("M13: his host never serves hers", () => {
  it('her app files are 404; /p/* is his own shell', async () => {
    for (const url of ['/p.html', '/p-sw.js', '/p.webmanifest']) expect((await get(OWNER_HOST, url)).statusCode, url).toBe(404);
    const shell = await get(OWNER_HOST, '/p/me');
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain('owner');
    expect(shell.body).not.toContain('hers');
    expect((await get(OWNER_HOST, '/sw.js')).headers['service-worker-allowed']).toBe('/');
    expect((await get(OWNER_HOST, '/assets/index-AAAAAAAA.js')).statusCode).toBe(200);
  });
});
