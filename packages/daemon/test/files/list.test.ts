/**
 * Directory listings (v0.3 spec 4.4.2): sorting, dot entries, protected
 * entries hidden and counted, the name cursor, the 500-entry page and the
 * 512 KiB reply, and F12's scan cap (a 100k-entry dir scans at most 10,000).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileListingSchema, type FileListing } from '@jantar/protocol';
import type { DirEntryInfo, FileRefusal } from '../../src/contracts.js';
import { LIST_REPLY_MAX, listPage } from '../../src/files/list.js';
import { DIR_MAX_SCAN, isRefusal, type ScannedDir } from '../../src/files/policy.js';
import { buildFilesService } from '../../src/files/service.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { PHONE, fpEnv, type FpEnv } from './fp-helpers.js';

let env: FpEnv;
let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  env?.cleanup();
});

function listing(v: FileListing | FileRefusal): FileListing {
  if (isRefusal(v)) throw new Error(`refused: ${v.refused}`);
  return FileListingSchema.parse(v);
}

const q = (path: string, over: Partial<{ after: string; limit: number; hidden: boolean }> = {}) => ({ root: 'r.proj', path, limit: 500, hidden: false, ...over });

describe('one directory page', () => {
  it('dirs first, then names in natural, case-insensitive order; files carry size and mtime', async () => {
    env = fpEnv();
    const d = join(env.proj, 'mix');
    for (const n of ['b.txt', 'A.txt', 'file10.txt', 'file2.txt']) env.write(join(d, n), 'abc');
    for (const n of ['zdir', 'Bdir', 'adir']) mkdirSync(join(d, n));
    const l = listing(await env.files.list(q('mix'), PHONE));
    expect(l.entries.map((e) => e.name)).toEqual(['adir', 'Bdir', 'zdir', 'A.txt', 'b.txt', 'file2.txt', 'file10.txt']);
    expect(l.entries[3]).toEqual({ name: 'A.txt', type: 'file', size: 3, mtime: expect.any(String) });
    expect(l.entries[0]).toEqual({ name: 'adir', type: 'dir', mtime: expect.any(String) });
    expect(l).toMatchObject({ root: 'r.proj', path: 'mix', next: null, hiddenProtected: 0, truncated: false });
  });

  it('dot entries only with hidden=1 (or folders.showHidden); protected entries never, and always counted', async () => {
    env = fpEnv();
    const plain = listing(await env.files.list(q(''), PHONE));
    expect(plain.entries.map((e) => e.name)).toEqual(['aws', 'certs', 'deploy', 'keys', 'src', 'README.md']);
    // The 27 top-level secrets of fp-helpers' PROJECT_SECRETS (.git counts once).
    expect(plain.hiddenProtected).toBe(27);
    const all = listing(await env.files.list(q('', { hidden: true }), PHONE));
    expect(all.entries.map((e) => e.name)).toEqual(['.claude', 'aws', 'certs', 'deploy', 'keys', 'src', '.gitignore', 'README.md']);
    expect(all.hiddenProtected).toBe(27);
    await env.setFolders({ showHidden: true });
    expect(listing(await env.files.list(q(''), PHONE)).entries.map((e) => e.name)).toContain('.gitignore');
    // Secrets one level down are hidden there too.
    const keys = listing(await env.files.list(q('keys', { hidden: true }), PHONE));
    expect(keys.entries).toEqual([]);
    expect(keys.hiddenProtected).toBe(1);
  });

  it('pages of `limit` with the last name as the cursor: no entry skipped or repeated', async () => {
    env = fpEnv();
    const d = join(env.proj, 'many');
    mkdirSync(d);
    for (let i = 0; i < 1203; i++) writeFileSync(join(d, `f${String(i).padStart(4, '0')}.txt`), '');
    for (let i = 0; i < 3; i++) mkdirSync(join(d, `dir${i}`));
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const l = listing(await env.files.list(q('many', after === undefined ? {} : { after }), PHONE));
      expect(l.entries.length).toBeLessThanOrEqual(500);
      seen.push(...l.entries.map((e) => e.name));
      after = l.next ?? undefined;
      pages += 1;
    } while (after !== undefined);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(1206);
    expect(new Set(seen).size).toBe(1206);
    expect(seen.slice(0, 4)).toEqual(['dir0', 'dir1', 'dir2', 'f0000.txt']);
  });

  it('a cursor whose entry vanished resumes without skipping anything', async () => {
    env = fpEnv();
    const d = join(env.proj, 'few');
    for (const n of ['a', 'b', 'c', 'd', 'e']) env.write(join(d, `${n}.txt`), '');
    mkdirSync(join(d, 'sub'));
    const first = listing(await env.files.list(q('few', { limit: 3 }), PHONE));
    expect(first.entries.map((e) => e.name)).toEqual(['sub', 'a.txt', 'b.txt']);
    rmSync(join(d, 'b.txt'));
    const second = listing(await env.files.list(q('few', { limit: 3, after: 'b.txt' }), PHONE));
    // A vanished cursor resumes where a dir of that name would sort: it may repeat, never skip.
    expect(second.entries.map((e) => e.name)).toEqual(['sub', 'a.txt', 'c.txt']);
    expect(listing(await env.files.list(q('few', { after: 'zzz-unknown' }), PHONE)).entries.map((e) => e.name)).toEqual(['a.txt', 'c.txt', 'd.txt', 'e.txt']);
  });

  it('refusals: unknown root, protected dir, a file, a missing dir, a bad path', async () => {
    env = fpEnv();
    const r = async (root: string, path: string) => {
      const v = await env.files.list({ ...q(path), root }, PHONE);
      return isRefusal(v) ? v.refused : 'listed';
    };
    expect(await r('r.nope', '')).toBe('no_root');
    expect(await r('r.proj', '.git')).toBe('protected');
    expect(await r('r.proj', 'README.md')).toBe('not_dir');
    expect(await r('r.proj', 'nope')).toBe('missing');
    expect(await r('r.proj', '../..')).toBe('bad_path');
  });

  it('the folder browser view: dirs and links to dirs inside the root only', async () => {
    env = fpEnv();
    env.link('src', join(env.proj, 'srclink'));
    env.link('README.md', join(env.proj, 'readme-link'));
    env.link(join(env.home, 'Desktop'), join(env.proj, 'desk'));
    const d = await env.files.policy.openDir('r.proj', '', { dirsOnly: true });
    if (isRefusal(d)) throw new Error(d.refused);
    expect(d.entries.map((e) => [e.name, e.type, e.link])).toEqual([
      ['aws', 'dir', undefined],
      ['certs', 'dir', undefined],
      ['deploy', 'dir', undefined],
      ['keys', 'dir', undefined],
      ['src', 'dir', undefined],
      ['srclink', 'link', 'inside'],
    ]);
  });
});

describe('F12: scan and reply limits', () => {
  it('a 100k-entry dir pages and scans at most 10,000 entries', async () => {
    env = fpEnv();
    const d = join(env.proj, 'huge');
    mkdirSync(d);
    // 600 real files that sort first, then 99,400 names the directory handle makes up.
    for (let i = 0; i < 600; i++) writeFileSync(join(d, `a${String(i).padStart(5, '0')}`), '');
    const open = fsx.opendir.bind(fsx);
    let reads = 0;
    vi.spyOn(fsx, 'opendir').mockImplementation(async (p: string) => {
      const real = await open(p);
      if (p !== d) return real;
      let made = 0;
      const fake = (name: string) => ({ name, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true });
      return Object.assign(Object.create(real) as typeof real, {
        read: async () => {
          reads += 1;
          const e = await real.read();
          if (e) return e;
          if (made >= 99_400) return null;
          made += 1;
          return fake(`z${String(made).padStart(6, '0')}`);
        },
        close: () => real.close(),
      });
    });
    const l = listing(await env.files.list(q('huge'), PHONE));
    expect(reads).toBeLessThanOrEqual(DIR_MAX_SCAN + 1);
    expect(l.truncated).toBe(true);
    expect(l.entries).toHaveLength(500);
    expect(l.entries[0]?.name).toBe('a00000');
    expect(l.next).toBe('a00499');
  });

  it('a real dir over the scan cap says truncated; openDir honours a smaller maxScan', async () => {
    env = fpEnv();
    const d = join(env.proj, 'big');
    mkdirSync(d);
    for (let i = 0; i < DIR_MAX_SCAN + 5; i++) writeFileSync(join(d, `f${i}`), '');
    const l = listing(await env.files.list(q('big'), PHONE));
    expect(l.truncated).toBe(true);
    const small = await env.files.policy.openDir('r.proj', 'src', { maxScan: 1 });
    if (isRefusal(small)) throw new Error(small.refused);
    expect(small).toMatchObject({ truncated: false, entries: [{ name: 'app.ts' }] });
    env.write(join(env.proj, 'src/b.ts'), '');
    const cut = await env.files.policy.openDir('r.proj', 'src', { maxScan: 1 });
    if (isRefusal(cut)) throw new Error(cut.refused);
    expect(cut.truncated).toBe(true);
    expect(cut.entries).toHaveLength(1);
  }, 30_000);

  it('a page stops before its JSON passes 512 KiB, and the cursor resumes there', async () => {
    // Names full of control characters grow sixfold in JSON (\u0001).
    const name = (i: number) => `${'\u0001'.repeat(240)}${String(i).padStart(4, '0')}`;
    const items = Array.from({ length: 500 }, (_, i) => ({ name: name(i), type: 'file' as const }));
    const scan = { real: '/x', rel: 'd', root: { id: 'r.x', kind: 'configured', label: 'x', real: '/x', display: '/x', home: false }, display: '/x/d', items, hiddenProtected: 0, truncated: false } satisfies ScannedDir;
    const policy = { describe: async (_d: unknown, page: readonly { name: string }[]) => ({ entries: page.map((p): DirEntryInfo => ({ name: p.name, type: 'file', size: 1 })), hiddenProtected: 0 }) };
    const l = await listPage(policy, scan, { limit: 500, iso: (ms) => new Date(ms).toISOString() });
    expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThanOrEqual(LIST_REPLY_MAX);
    expect(l.entries.length).toBeLessThan(500);
    expect(l.next).toBe(l.entries.at(-1)?.name);
    const rest = await listPage(policy, scan, { after: l.next ?? undefined, limit: 500, iso: (ms) => new Date(ms).toISOString() });
    expect(rest.entries[0]?.name).toBe(name(l.entries.length));
  });
});

describe('GET /v1/files/list', () => {
  it('answers a FileListing with no-store, and maps refusals to HTTP errors', async () => {
    env = fpEnv();
    api = await makeApi({
      ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
      deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
    });
    const { cookie } = await pairCookie(api);
    const get = (query: string) => api!.tcp.inject({ method: 'GET', url: `/v1/files/list?${query}`, headers: h(cookie) });
    const ok = await get('root=r.proj&hidden=1');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(FileListingSchema.parse(ok.json()).entries.map((e) => e.name)).toContain('.gitignore');
    const status = async (query: string) => [(await get(query)).statusCode, (await get(query)).json().error?.code];
    expect(await status('root=r.nope')).toEqual([404, 'not_found']);
    expect(await status('root=r.proj&path=.git')).toEqual([403, 'forbidden']);
    expect(await status('root=r.proj&path=README.md')).toEqual([422, 'refused']);
    expect(await status('root=r.proj&path=%2e%2e%2f%2e%2e')).toEqual([400, 'invalid_request']);
    expect(await status('root=r.proj&limit=501')).toEqual([400, 'invalid_request']);
    expect(await status('root=r.proj&hidden=yes')).toEqual([400, 'invalid_request']);
  });
});
