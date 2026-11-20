/**
 * 0.14.1: a name search under a folder (GET /v1/files/find, files/find.ts).
 * The folder is refused as a listing of it is (no root, outside, protected,
 * not a folder, a bad path); the walk sees what Browse sees (no protected
 * entry, dot entries only for a text that starts with '.') and never goes
 * into node_modules, .git or a symlink, which it lists only by its own name;
 * every cap (results, depth, entries, time on the FakeClock) says
 * `truncated`; and the best matches come first.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILES_FIND_BUDGET_MS, FILES_FIND_MAX_DEPTH, FilesFindResponseSchema, type FilesFindQuery, type FilesFindResponse } from '@jantar/protocol';
import type { FileRefusal } from '../../src/contracts.js';
import { findKey, findNames, type FindCaps } from '../../src/files/find.js';
import { isRefusal } from '../../src/files/policy.js';
import { buildFilesService } from '../../src/files/service.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { HOME_SECRETS, PROJECT_SECRETS, SECRET_MARKER, fpEnv, type FpEnv } from './fp-helpers.js';

let env: FpEnv;
let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  env?.cleanup();
});

const query = (q: string, over: Partial<FilesFindQuery> = {}): FilesFindQuery => ({ root: 'r.proj', path: '', q, limit: 100, ...over });

async function find(q: string, over: Partial<FilesFindQuery> = {}, caps?: Partial<FindCaps>): Promise<FilesFindResponse> {
  const r = await findNames(env.files.policy, query(q, over), { clock: env.ctx.clock, ...(caps ? { caps } : {}) });
  if (isRefusal(r)) throw new Error(`refused: ${r.refused}`);
  return FilesFindResponseSchema.parse(r);
}

async function refusal(q: string, over: Partial<FilesFindQuery>): Promise<FileRefusal['refused']> {
  const r = await findNames(env.files.policy, query(q, over), { clock: env.ctx.clock });
  if (!isRefusal(r)) throw new Error('not refused');
  return r.refused;
}

const paths = (r: FilesFindResponse) => r.entries.map((e) => e.path);

describe('what it finds', () => {
  it('names that contain the text, in any letter case and either Unicode form, with kind, size and time', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'docs/Report-2026.pdf'), 'x'.repeat(42));
    env.write(join(env.proj, 'docs/q3/report.md'), '# Q3\n');
    mkdirSync(join(env.proj, 'reports'));
    // Written decomposed (e + U+0301), found by the composed text and by its capitals.
    env.write(join(env.proj, 'notes/café-menu.md'), '');
    const r = await find('REPORT');
    expect(paths(r)).toEqual(['reports', 'docs/Report-2026.pdf', 'docs/q3/report.md']);
    expect(r.truncated).toBe(false);
    expect(r.entries[0]).toEqual({ path: 'reports', name: 'reports', kind: 'dir', mtime: expect.any(String) });
    expect(r.entries[1]).toEqual({ path: 'docs/Report-2026.pdf', name: 'Report-2026.pdf', kind: 'file', size: 42, mtime: expect.any(String) });
    expect(paths(await find('café'))).toEqual(['notes/café-menu.md']);
    expect(paths(await find('CAFÉ-'))).toEqual(['notes/café-menu.md']);
    expect(findKey('Café')).toBe('café');
  });

  it('searches below the folder being browsed only, and gives paths from the root', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'a/todo.md'), '');
    env.write(join(env.proj, 'b/todo.md'), '');
    env.write(join(env.proj, 'b/c/todo-later.md'), '');
    expect(paths(await find('todo', { path: 'b' }))).toEqual(['b/todo.md', 'b/c/todo-later.md']);
    expect(paths(await find('todo'))).toEqual(['a/todo.md', 'b/todo.md', 'b/c/todo-later.md']);
  });

  it('best first: names that start with the text, then the shallower, then by name', async () => {
    env = fpEnv();
    for (const p of ['blog.md', 'Logo.png', 'catalog/x.txt', 'src/login.ts', 'src/a/logger.ts', 'src/a/b/changelog.md', 'src/log10.txt', 'src/log9.txt']) env.write(join(env.proj, p), '');
    expect(paths(await find('log'))).toEqual([
      'Logo.png',
      'src/log9.txt',
      'src/log10.txt',
      'src/login.ts',
      'src/a/logger.ts',
      'blog.md',
      'catalog',
      'src/a/b/changelog.md',
    ]);
  });
});

describe('what it never shows or walks into', () => {
  it('never a protected name; dot entries only for a text that starts with "."', async () => {
    env = fpEnv();
    env.write(join(env.proj, '.cache/deep/report.txt'), '');
    env.write(join(env.proj, 'report.md'), '');
    mkdirSync(join(env.proj, '.github'));
    expect(paths(await find('report'))).toEqual(['report.md']);
    // With a dot, the dot folders are walked too (protected ones never: .git is one).
    expect(paths(await find('.git'))).toEqual(['.github', '.gitignore']);
    expect(paths(await find('.cache'))).toEqual(['.cache']);
    // Every secret of the fixture, by its own name: none.
    for (const q of ['credentials', 'id_rsa', '.env', 'secret', 'token', '.npmrc', 'kubeconfig', 'tfstate', '.pem']) {
      const r = await find(q);
      expect(r.entries.filter((e) => PROJECT_SECRETS.some((s) => s === e.path || s.startsWith(`${e.path}/`) || e.path.startsWith(`${s}/`))), q).toEqual([]);
    }
    // aws/ is a plain folder; its credentials file is not.
    expect(paths(await find('aws'))).toEqual(['aws']);
  });

  it('a home root: no ~/Library and no top-level dot entry, even for a dotted text; no secret is ever opened', async () => {
    env = fpEnv({ homeRoot: true });
    const seen: string[] = [];
    for (const op of ['open', 'openNoFollow', 'opendir', 'readFile', 'readdir'] as const) {
      const orig = (fsx[op] as (p: string) => Promise<unknown>).bind(fsx);
      vi.spyOn(fsx, op).mockImplementation(((p: string) => {
        seen.push(p);
        return orig(p);
      }) as never);
    }
    for (const q of ['.ssh', 'id_rsa', 'Keychains', 'credentials', '.claude', 'config', '.config', 'notes', 'history']) {
      const r = await find(q, { root: 'r.home' });
      for (const e of r.entries) expect(HOME_SECRETS.some((s) => s === e.path || s.startsWith(`${e.path}/`)) && !e.path.startsWith('work/'), `${q}: ${e.path}`).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET_MARKER);
    }
    expect(paths(await find('notes', { root: 'r.home' }))).toEqual(['notes.md']);
    expect(paths(await find('Library', { root: 'r.home' }))).toEqual([]);
    const protectedDirs = ['.ssh', '.aws', '.gnupg', '.claude', '.claude-swap-backup', '.jantar', 'Library', '.config'].map((d) => join(env.home, d));
    expect(seen.filter((p) => protectedDirs.some((d) => p === d || p.startsWith(`${d}/`)))).toEqual([]);
  });

  it('never walks into node_modules or .git, though their own names can match', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'node_modules/left-pad/index.js'), '');
    env.write(join(env.proj, 'packages/web/node_modules/left-pad/index.js'), '');
    env.write(join(env.proj, 'packages/web/left-pad.ts'), '');
    const opened = vi.spyOn(env.files.policy, 'openDir');
    expect(paths(await find('left-pad'))).toEqual(['packages/web/left-pad.ts']);
    expect(opened.mock.calls.map((c) => c[1]).filter((p) => /node_modules|\.git/.test(p))).toEqual([]);
    expect(paths(await find('node_mod'))).toEqual(['node_modules', 'packages/web/node_modules']);
    // Even when dot entries are walked, .git is not (it is protected besides).
    await find('.git');
    expect(opened.mock.calls.map((c) => c[1]).filter((p) => /(^|\/)\.git(\/|$)/.test(p))).toEqual([]);
  });

  it('never follows a symlink: lists one by its own name when it leads inside the root, never one that leads out or nowhere', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'src/deep/needle.ts'), 'export {};\n');
    env.write(join(env.base, 'outside/needle-out.txt'), 'out\n');
    env.link(join(env.proj, 'src'), join(env.proj, 'needle-dir-link'));
    env.link(join(env.proj, 'README.md'), join(env.proj, 'needle-file-link'));
    env.link(join(env.base, 'outside'), join(env.proj, 'needle-escape'));
    env.link(join(env.proj, 'gone'), join(env.proj, 'needle-broken'));
    env.link(join(env.home, '.ssh'), join(env.proj, 'needle-ssh'));
    const opened = vi.spyOn(env.files.policy, 'openDir');
    const r = await find('needle');
    expect(paths(r)).toEqual(['needle-dir-link', 'needle-file-link', 'src/deep/needle.ts']);
    expect(r.entries[0]).toMatchObject({ kind: 'dir', name: 'needle-dir-link' });
    expect(r.entries[1]).toMatchObject({ kind: 'file', size: Buffer.byteLength('# Project\n\nHello.\n') });
    // Nothing behind a link was read: not the folder it leads to by its name, not the one outside.
    expect(opened.mock.calls.map((c) => c[1]).filter((p) => p.startsWith('needle'))).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('needle-out');
  });
});

describe('caps: each one reached says truncated', () => {
  it('results: at most `limit` (100 by default), the best ones', async () => {
    env = fpEnv();
    const d = join(env.proj, 'many');
    mkdirSync(d);
    for (let i = 0; i < 120; i++) writeFileSync(join(d, `item-${String(i).padStart(3, '0')}.txt`), '');
    writeFileSync(join(env.proj, 'item-top.txt'), '');
    const all = await find('item-');
    expect(all.entries).toHaveLength(100);
    expect(all.truncated).toBe(true);
    expect(all.entries[0]?.path).toBe('item-top.txt');
    const three = await find('item-', { limit: 3 });
    expect(paths(three)).toEqual(['item-top.txt', 'many/item-000.txt', 'many/item-001.txt']);
    expect(three.truncated).toBe(true);
    const exact = await find('item-11');
    expect(exact.entries).toHaveLength(10);
    expect(exact.truncated).toBe(false);
  });

  it(`depth: names at most ${FILES_FIND_MAX_DEPTH} levels below the folder`, async () => {
    env = fpEnv();
    // d1/d2/.../d13, and in each dK the file deep-(K+1).txt: every file is named by its depth.
    env.write(join(env.proj, 'deep-1.txt'), '');
    let at = env.proj;
    for (let k = 1; k <= FILES_FIND_MAX_DEPTH + 1; k++) {
      at = join(at, `d${k}`);
      env.write(join(at, `deep-${k + 1}.txt`), '');
    }
    const r = await find('deep-');
    expect(r.entries.map((e) => e.name)).toEqual(Array.from({ length: FILES_FIND_MAX_DEPTH }, (_, i) => `deep-${i + 1}.txt`));
    expect(r.truncated).toBe(true);
    // From two levels down, the deepest ones are in reach, and nothing is left past the cap.
    const near = await find('deep-', { path: 'd1/d2' });
    expect(near.entries.map((e) => e.name)).toEqual(Array.from({ length: FILES_FIND_MAX_DEPTH }, (_, i) => `deep-${i + 3}.txt`));
    expect(near.truncated).toBe(false);
  });

  it('entries looked at: no folder is read past the budget, and what is left says truncated', async () => {
    env = fpEnv();
    for (const dir of ['a', 'b', 'c']) for (let i = 0; i < 8; i++) env.write(join(env.proj, dir, `f${i}.txt`), '');
    const opened = vi.spyOn(env.files.policy, 'openDir');
    const whole = await find('f', {}, { maxVisited: 1_000 });
    expect(whole.truncated).toBe(false);
    opened.mockClear();
    const cut = await find('f', {}, { maxVisited: 20 });
    expect(cut.truncated).toBe(true);
    // Each read asks for no more than what is left of the budget.
    const asked = opened.mock.calls.map((c) => c[2]?.maxScan ?? Infinity);
    expect(asked[0]).toBe(20);
    expect(asked.every((n) => n <= 20)).toBe(true);
    expect(cut.entries.length).toBeLessThan(whole.entries.length);
  });

  it(`time: ${FILES_FIND_BUDGET_MS} ms on the context clock, checked before each folder`, async () => {
    env = fpEnv();
    for (const dir of ['a', 'b', 'c', 'd', 'e']) env.write(join(env.proj, dir, `${dir}-hit.txt`), '');
    const orig = env.files.policy.openDir.bind(env.files.policy);
    // Each folder read takes 600 ms on the FakeClock: the root, then two more, and the budget is spent.
    const opened = vi.spyOn(env.files.policy, 'openDir').mockImplementation(async (...args) => {
      env.ctx.clock.advance(600);
      return orig(...args);
    });
    const r = await find('hit');
    expect(opened).toHaveBeenCalledTimes(3);
    expect(r.truncated).toBe(true);
    expect(r.entries.length).toBeLessThan(5);
    // A fast enough Mac reads every folder.
    opened.mockImplementation(orig);
    const all = await find('hit');
    expect(all.entries).toHaveLength(5);
    expect(all.truncated).toBe(false);
  });
});

describe('the folder is refused as a listing of it is', () => {
  it('no root, a bad path, outside the root, protected, not a folder, gone', async () => {
    env = fpEnv();
    env.link(join(env.base), join(env.proj, 'up'));
    expect(await refusal('ab', { root: 'r.nope' })).toBe('no_root');
    expect(await refusal('ab', { path: '../..' })).toBe('bad_path');
    expect(await refusal('ab', { path: '/etc' })).toBe('bad_path');
    expect(await refusal('ab', { path: 'up' })).toBe('outside');
    expect(await refusal('ab', { path: '.git' })).toBe('protected');
    expect(await refusal('ab', { path: 'README.md' })).toBe('not_dir');
    expect(await refusal('ab', { path: 'nowhere' })).toBe('missing');
    // The same answers GET /v1/files/list gives.
    for (const path of ['../..', 'up', '.git', 'README.md', 'nowhere']) {
      const listed = await env.files.list({ root: 'r.proj', path, limit: 500, hidden: false }, { kind: 'cli' });
      expect(isRefusal(listed) ? listed.refused : 'listed', path).toBe(await refusal('ab', { path }));
    }
  });
});

describe('GET /v1/files/find', () => {
  async function serve() {
    api = await makeApi({
      ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
      deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
    });
    const { cookie, deviceId } = await pairCookie(api);
    const get = (qs: string) => api!.tcp.inject({ method: 'GET', url: `/v1/files/find?${qs}`, headers: h(cookie) });
    return { get, deviceId };
  }

  it('answers names with no-store, maps refusals to the listing errors and audits them, and checks the query', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'src/auth/session.ts'), '');
    const { get, deviceId } = await serve();
    const ok = await get('root=r.proj&q=sess');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(FilesFindResponseSchema.parse(ok.json())).toEqual({
      entries: [{ path: 'src/auth/session.ts', name: 'session.ts', kind: 'file', size: 0, mtime: expect.any(String) }],
      truncated: false,
    });
    const status = async (qs: string) => {
      const res = await get(qs);
      return [res.statusCode, res.json().error?.code];
    };
    expect(await status('root=r.nope&q=ab')).toEqual([404, 'not_found']);
    expect(await status('root=r.proj&path=.git&q=ab')).toEqual([403, 'forbidden']);
    expect(await status('root=r.proj&path=README.md&q=ab')).toEqual([422, 'refused']);
    expect(await status('root=r.proj&path=%2e%2e%2f%2e%2e&q=ab')).toEqual([400, 'invalid_request']);
    expect(await status('root=r.proj&q=a')).toEqual([400, 'invalid_request']);
    expect(await status('root=r.proj')).toEqual([400, 'invalid_request']);
    expect(await status('root=r.proj&q=ab&limit=101')).toEqual([400, 'invalid_request']);
    const denied = api!.ctx.db.audit.list({ limit: 100 }).filter((r) => r.action === 'files.denied');
    expect(denied.map((r) => (r.params as { reason: string }).reason).sort()).toEqual(['bad_path', 'no_root', 'not_dir', 'protected']);
    expect(denied.every((r) => r.actor === `device:${deviceId}`)).toBe(true);
    // The text searched for is in no audit row.
    expect(JSON.stringify(api!.ctx.db.audit.list({ limit: 100 }))).not.toContain('sess');
  });

  it('is behind the Files switch, and never on ctl.sock', async () => {
    env = fpEnv();
    const { get } = await serve();
    await api!.ctx.settings.patch({ files: { enabled: false } });
    const off = await get('root=r.proj&q=readme');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.message).toContain('jantar files on');
    expect((await api!.ctl.inject({ method: 'GET', url: '/v1/files/find?root=r.proj&q=readme' })).statusCode).toBe(404);
  });
});
