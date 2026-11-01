/**
 * The built extension (scripts/build.mjs, into temp folders):
 * - MP8: nothing remote: no http(s) URL but the daemon's 127.0.0.1 (with or
 *   without a port), the four meeting hosts and the SVG namespace, no eval
 *   or new Function, no inline script in the popup page. v0.8: the six post
 *   sites only in the manifest (the worker and the popup read them from it);
 *   the reader and the post shapes are in the worker's bundle.
 * - MP9: the content script holds neither IndexedDB nor the key header: the
 *   key stays in the worker.
 * - MP7 (bundle part): no console.log or console.debug anywhere.
 * - The test build differs from dist/ in its manifest only (MX1).
 * - Nothing of zod rides along; the files stay within the size gates (9.5).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExtension } from '../scripts/build.mjs';
import { MEETING_HOSTS } from '../src/shared/sites.js';
import { DAEMON_ORIGIN } from '../src/shared/wire.js';
import { POST_ORIGINS } from './manifest.test.js';

let root: string;
let dist: string;
let distTest: string;
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'jantar-ext-build-'));
  dist = await buildExtension({ outDir: join(root, 'dist') });
  distTest = await buildExtension({ outDir: join(root, 'dist-test'), test: true });
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const TEXT = /\.(js|html|css|json)$/;
const SVG_NS = 'http://www.w3.org/2000/svg';

describe('the built extension', () => {
  it('holds exactly the files Chrome loads', () => {
    const files = ['background.js', 'content.js', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon.png', 'manifest.json', 'popup.css', 'popup.html', 'popup.js'];
    expect(readdirSync(dist).sort()).toEqual(files);
    expect(readdirSync(distTest).sort()).toEqual(files);
    expect(readFileSync(join(dist, 'icon.png')).equals(readFileSync(new URL('../../web/public/icons/icon-192.png', import.meta.url)))).toBe(true);
    // The toolbar sizes are square PNGs of their own size (gen-icons.mjs).
    for (const px of [16, 32, 48]) {
      const png = readFileSync(join(dist, `icon-${px}.png`));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], `icon-${px}.png`).toEqual([px, px]);
    }
  });

  it('MP8: nothing remote, no eval, no inline script; the six post sites only in the manifest', () => {
    const posts = POST_ORIGINS.map((o) => o.replace(/\/\*$/, ''));
    for (const f of readdirSync(dist).filter((n) => TEXT.test(n))) {
      const allowed = new Set([DAEMON_ORIGIN, ...MEETING_HOSTS.map((h) => `https://${h}`), ...(f === 'manifest.json' ? posts : [])]);
      const text = read(dist, f);
      // The SVG namespace (createElementNS for the drawn icons) names a namespace and is never fetched: exactly it is skipped.
      // So is the manifest's homepage_url: Chrome shows it as a link on the extension's page and never loads it.
      const homepage = f === 'manifest.json' ? (JSON.parse(text) as { homepage_url?: string }).homepage_url : undefined;
      const scanned = (homepage ? text.split(JSON.stringify(homepage)).join('""') : text).split(SVG_NS).join('');
      // A trailing ':' goes with or without its port: `${DAEMON_ORIGIN}:${port}` bundles as "http://127.0.0.1:".
      for (const u of scanned.match(/https?:\/\/[A-Za-z0-9.[\]:-]*/g) ?? []) expect(allowed.has(u.replace(/:\d*$/, '')), `${f}: ${u}`).toBe(true);
      expect(text, f).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
    }
    const html = read(dist, 'popup.html');
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\bsrc="[^"]+"/);
    expect(html).not.toMatch(/<script\b[^>]*>[^<\s]/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<style\b|\sstyle\s*=/i);
  });

  it('MP9: the content script holds neither IndexedDB nor the key header', () => {
    const content = read(dist, 'content.js');
    expect(content).not.toContain('indexedDB');
    expect(content).not.toContain('x-jantar-extension-key');
  });

  it('MP7: no console.log or console.debug in any built file', () => {
    for (const f of readdirSync(dist).filter((n) => n.endsWith('.js'))) expect(read(dist, f), f).not.toMatch(/console\.(log|debug)\b/);
  });

  it('the test build differs only in its manifest', () => {
    for (const f of readdirSync(dist)) {
      if (f === 'manifest.json') continue;
      expect(readFileSync(join(distTest, f)).equals(readFileSync(join(dist, f))), f).toBe(true);
    }
    const a = JSON.parse(read(dist, 'manifest.json')) as Record<string, unknown>;
    const b = JSON.parse(read(distTest, 'manifest.json')) as Record<string, unknown>;
    expect(b.host_permissions).toEqual(['http://127.0.0.1/*', '<all_urls>', ...POST_ORIGINS]);
    expect(b).not.toHaveProperty('optional_host_permissions');
    const { host_permissions: _a, optional_host_permissions: _o, ...restA } = a;
    const { host_permissions: _b, ...restB } = b;
    expect(restB).toEqual(restA);
  });

  it('bundles nothing of zod, and stays within the size gates', () => {
    for (const f of ['content.js', 'background.js', 'popup.js']) expect(read(dist, f), f).not.toMatch(/\bZodError\b|\bzod\b/);
    expect(Buffer.byteLength(read(dist, 'content.js'))).toBeLessThanOrEqual(60 * 1024);
    // v0.8: the worker carries the in-page reader and the post shapes (unminified, so it can be read): 40 KB became 80.
    expect(Buffer.byteLength(read(dist, 'background.js'))).toBeLessThanOrEqual(80 * 1024);
    expect(Buffer.byteLength(read(dist, 'popup.js'))).toBeLessThanOrEqual(40 * 1024);
  });

  it('v0.8: the worker bundles the reader and the post shapes; the page script and the popup do not carry the reader', () => {
    const worker = read(dist, 'background.js');
    for (const name of ['function readPage', 'function chromePostOf', 'function isLoginPath', 'jantar-reads']) expect(worker, name).toContain(name);
    for (const f of ['content.js', 'popup.js']) expect(read(dist, f), f).not.toContain('function readPage');
    expect(read(dist, 'content.js')).not.toContain('chromePostOf');
  });
});
