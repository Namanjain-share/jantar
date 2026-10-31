/**
 * Raw bytes (v0.3 spec 4.4.5, security rule F9): raster images and PDF only,
 * extension and magic bytes must agree, the content type comes from the
 * daemon's table, never `text/html` or `image/svg+xml`, the sandbox CSP and
 * `nosniff` on every reply, the size caps, the bytes budget, and the file
 * handle closed on every path.
 */
import { appendFileSync, truncateSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBodySchema, FILES_RAW_IMAGE_MAX, FILES_RAW_PDF_MAX } from '@jantar/protocol';
import { V03_LIMITS } from '../../src/api/services.js';
import { RAW_CSP, RAW_TYPES, rawHeaders } from '../../src/files/raw.js';
import { isRefusal } from '../../src/files/policy.js';
import { buildFilesService } from '../../src/files/service.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { PHONE, SECRET_MARKER, fpEnv, type FpEnv } from './fp-helpers.js';

let env: FpEnv;
let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  env?.cleanup();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.from([0, 0, 0, 0])]);
const PDF = Buffer.from('%PDF-1.7\n%\u00e2\u00e3\n1 0 obj\n', 'latin1');
const HTML = Buffer.from(`<html><script>window.__pwned=1</script>${SECRET_MARKER}</html>`);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const GOOD: Record<string, [Buffer, string]> = {
  'a.png': [PNG, 'image/png'],
  'b.PNG': [PNG, 'image/png'],
  'c.jpg': [JPEG, 'image/jpeg'],
  'd.jpeg': [JPEG, 'image/jpeg'],
  'e.gif': [GIF, 'image/gif'],
  'f.webp': [WEBP, 'image/webp'],
  'g.avif': [ftyp('avif'), 'image/avif'],
  'h.heic': [ftyp('heic'), 'image/heic'],
  'i.heic': [ftyp('heix'), 'image/heic'],
  'j.heic': [ftyp('mif1'), 'image/heic'],
  'k.pdf': [PDF, 'application/pdf'],
};

const BAD: Record<string, Buffer> = {
  'html.png': HTML,
  'page.html': HTML,
  'page.htm': HTML,
  'pic.svg': SVG,
  'svg.png': SVG,
  'notes.txt': Buffer.from('hello'),
  'png.jpg': PNG,
  'jpeg.png': JPEG,
  'riff.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('AVI LIST')]),
  'heic.avif': ftyp('heic'),
  'avif.heic': ftyp('avis'),
  'mp4.heic': ftyp('isom'),
  'short.png': Buffer.from([0x89, 0x50]),
  'empty.pdf': Buffer.alloc(0),
  'html.pdf': HTML,
  'pic.bmp': Buffer.from('BM'),
  'constructor': PNG,
  'x.constructor': PNG,
};

function setup(): void {
  env = fpEnv();
  for (const [n, [bytes]] of Object.entries(GOOD)) env.write(join(env.proj, 'img', n), bytes);
  for (const [n, bytes] of Object.entries(BAD)) env.write(join(env.proj, 'img', n), bytes);
}

async function withApi() {
  api = await makeApi({
    ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
    deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
  });
  const { cookie, deviceId } = await pairCookie(api);
  const get = (path: string) => api!.tcp.inject({ method: 'GET', url: `/v1/files/raw?root=r.proj&path=${encodeURIComponent(path)}`, headers: h(cookie) });
  return { get, cookie, deviceId };
}

/** Records every handle the policy opens, to prove each one gets closed. */
function trackHandles(): FileHandle[] {
  const handles: FileHandle[] = [];
  const open = fsx.openNoFollow.bind(fsx);
  vi.spyOn(fsx, 'openNoFollow').mockImplementation(async (p: string) => {
    const fh = await open(p);
    handles.push(fh);
    return fh;
  });
  return handles;
}

describe('the raw allowlist', () => {
  it('serves each raster type and PDF only when the extension and the magic bytes agree', async () => {
    setup();
    for (const [n, [, mime]] of Object.entries(GOOD)) {
      const r = await env.files.raw({ root: 'r.proj', path: `img/${n}` }, PHONE);
      if (isRefusal(r)) throw new Error(`${n}: ${r.refused}`);
      expect(r.mime, n).toBe(mime);
      expect(r.name).toBe(n);
      await r.fh.close();
    }
    for (const n of Object.keys(BAD)) {
      const r = await env.files.raw({ root: 'r.proj', path: `img/${n}` }, PHONE);
      expect(isRefusal(r) && r.refused, n).toBe('unsupported_type');
    }
  });

  it('the type table is a Map with no text, HTML or SVG type in it', () => {
    const mimes = [...RAW_TYPES.values()].map((t) => t.mime);
    expect(new Set(mimes)).toEqual(new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'application/pdf']));
    expect(RAW_TYPES.get('constructor')).toBeUndefined();
    expect(RAW_TYPES.get('svg')).toBeUndefined();
  });

  it('caps: images at 20 MiB, PDF at 50 MiB', async () => {
    env = fpEnv();
    const sized = (name: string, head: Buffer, size: number) => {
      const p = env.write(join(env.proj, name), head);
      truncateSync(p, size);
    };
    sized('big.png', PNG, FILES_RAW_IMAGE_MAX + 1);
    sized('ok.png', PNG, FILES_RAW_IMAGE_MAX);
    sized('mid.pdf', PDF, FILES_RAW_IMAGE_MAX + 1);
    sized('big.pdf', PDF, FILES_RAW_PDF_MAX + 1);
    const refusedWith = async (p: string) => {
      const r = await env.files.raw({ root: 'r.proj', path: p }, PHONE);
      if (isRefusal(r)) return r.refused;
      await r.fh.close();
      return 'served';
    };
    expect(await refusedWith('big.png')).toBe('too_large');
    expect(await refusedWith('ok.png')).toBe('served');
    expect(await refusedWith('mid.pdf')).toBe('served');
    expect(await refusedWith('big.pdf')).toBe('too_large');
  });

  it('protected and outside paths are refused before any type check', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'keys/id_rsa.png'), PNG);
    env.link(join(env.home, 'Desktop'), join(env.proj, 'desk'));
    env.write(join(env.desktop, 'shot.png'), PNG);
    const r1 = await env.files.raw({ root: 'r.proj', path: 'keys/id_rsa.png' }, PHONE);
    const r2 = await env.files.raw({ root: 'r.proj', path: 'desk/shot.png' }, PHONE);
    expect([isRefusal(r1) && r1.refused, isRefusal(r2) && r2.refused]).toEqual(['protected', 'outside']);
  });
});

describe('F9: GET /v1/files/raw', () => {
  it('replies with the bytes, the type from the table and the spec 4.4.5 headers', async () => {
    setup();
    const { get } = await withApi();
    for (const [n, [bytes, mime]] of Object.entries(GOOD)) {
      const res = await get(`img/${n}`);
      expect(res.statusCode, n).toBe(200);
      expect(res.rawPayload.equals(bytes), n).toBe(true);
      expect(res.headers['content-type']).toBe(mime);
      expect(res.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent(n)}`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['content-security-policy']).toBe(RAW_CSP);
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
  });

  it('never answers text/html or image/svg+xml: a .png holding HTML gets 415', async () => {
    setup();
    const { get } = await withApi();
    for (const n of Object.keys(BAD)) {
      const res = await get(`img/${n}`);
      expect(res.statusCode, n).toBe(415);
      expect(ErrorBodySchema.parse(res.json()).error.code).toBe('unsupported_media_type');
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.body).not.toContain(SECRET_MARKER);
      expect(res.body).not.toContain('<script');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('error statuses: 403 protected, 404 missing or unknown root, 413 too large, 400 bad path', async () => {
    env = fpEnv();
    const big = env.write(join(env.proj, 'big.png'), PNG);
    truncateSync(big, FILES_RAW_IMAGE_MAX + 1);
    const { get, cookie } = await withApi();
    const code = async (p: string) => (await get(p)).statusCode;
    expect(await code('server.pem')).toBe(403);
    expect(await code('.env')).toBe(403);
    expect(await code('gone.png')).toBe(404);
    expect(await code('big.png')).toBe(413);
    expect(await code('../x.png')).toBe(400);
    const other = await api!.tcp.inject({ method: 'GET', url: '/v1/files/raw?root=r.nope&path=a.png', headers: h(cookie) });
    expect(other.statusCode).toBe(404);
  });

  it('names with quotes, spaces and non-ASCII letters are encoded in content-disposition', () => {
    expect(rawHeaders("it's (1) *.png")['content-disposition']).toBe("inline; filename*=UTF-8''it%27s%20%281%29%20%2A.png");
    expect(rawHeaders('caf\u00e9.png')['content-disposition']).toBe("inline; filename*=UTF-8''caf%C3%A9.png");
  });

  it('closes the file handle on every path: served, refused, too large, HEAD, and over the bytes budget', async () => {
    setup();
    const big = env.write(join(env.proj, 'big.png'), PNG);
    truncateSync(big, FILES_RAW_IMAGE_MAX + 1);
    const { get, deviceId, cookie } = await withApi();
    const handles = trackHandles();
    expect((await get('img/a.png')).statusCode).toBe(200);
    expect((await get('img/k.pdf')).statusCode).toBe(200);
    expect((await get('img/html.png')).statusCode).toBe(415);
    expect((await get('big.png')).statusCode).toBe(413);
    // HEAD runs the same handler; the stream is dropped and its handle closed.
    const head = await api!.tcp.inject({ method: 'HEAD', url: '/v1/files/raw?root=r.proj&path=img%2Fa.png', headers: h(cookie) });
    expect([head.statusCode, head.rawPayload.length]).toEqual([200, 0]);
    // Spend the rest of the device's raw budget (a HEAD is charged like a GET), then ask once more.
    expect(api!.services.rawBytesBudget.take(`device:${deviceId}`, 200 * 1024 * 1024 - 2 * PNG.length - PDF.length - 4).ok).toBe(true);
    const over = await get('img/a.png');
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(handles).toHaveLength(6);
    await new Promise((r) => setTimeout(r, 20));
    for (const fh of handles) expect(fh.fd).toBe(-1);
  });

  it('a reply refused by the bytes budget leaves no files.raw row; the read that is served writes it', async () => {
    setup();
    const { get, deviceId } = await withApi();
    const rawRows = () => api!.ctx.db.audit.list({ limit: 100 }).filter((r) => r.action === 'files.raw').map((r) => (r.params as { rel: string }).rel);
    expect(api!.services.rawBytesBudget.take(`device:${deviceId}`, V03_LIMITS.rawBytes.limit).ok).toBe(true);
    expect((await get('img/c.jpg')).statusCode).toBe(429);
    expect(rawRows()).toEqual([]);
    api!.ctx.clock.advance(V03_LIMITS.rawBytes.windowMs);
    expect((await get('img/c.jpg')).statusCode).toBe(200);
    expect(rawRows()).toEqual(['img/c.jpg']);
  });

  it('never streams more than the size it checked and charged, even if the file grew', async () => {
    env = fpEnv();
    const p = env.write(join(env.proj, 'grow.png'), PNG);
    const { get } = await withApi();
    const take = api!.services.rawBytesBudget.take.bind(api!.services.rawBytesBudget);
    const charged: number[] = [];
    vi.spyOn(api!.services.rawBytesBudget, 'take').mockImplementation((key: string, amount: number) => {
      charged.push(amount);
      appendFileSync(p, Buffer.alloc(4096, 0x41));
      return take(key, amount);
    });
    const res = await get('grow.png');
    expect(res.statusCode).toBe(200);
    expect(charged).toEqual([PNG.length]);
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });
});
