/**
 * 0.14.1: a name search under a folder (GET /v1/files/find, files/find.ts).
 * The folder is refused as a listing of it is (no root, outside, protected,
 * not a folder, a bad path); the walk sees what Browse sees (no protected
 * entry, dot entries only with the listing's hidden flag) and never goes
 * into node_modules, .git or a symlink, which it lists only by its own name;
 * every cap (results, depth, entries, time on the FakeClock) says
 * `truncated` and which (`stopped`); the best matches come first; a folder
 * that goes away mid-walk is passed over; and a search stops when its
 * request goes away or a newer one from the same device starts.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILES_FIND_BUDGET_MS, FILES_FIND_MAX_DEPTH, FilesFindResponseSchema, type FilesFindQuery, type FilesFindResponse } from '@jantar/protocol';
import type { FileRefusal } from '../../src/contracts.js';
import { AUDIT_DEDUPE_MS } from '../../src/files/audit.js';
import { findKey, findNames, isFindAborted, type FindCaps } from '../../src/files/find.js';
import { isRefusal, type PathPolicy } from '../../src/files/policy.js';
import { FIND_STOPPED } from '../../src/api/routes/files.js';
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

const query = (q: string, over: Partial<FilesFindQuery> = {}): FilesFindQuery => ({ root: 'r.proj', path: '', q, limit: 100, hidden: false, ...over });

async function find(q: string, over: Partial<FilesFindQuery> = {}, caps?: Partial<FindCaps>): Promise<FilesFindResponse> {
  const r = await findNames(env.files.policy, query(q, over), { clock: env.ctx.clock, ...(caps ? { caps } : {}) });
  if (isRefusal(r)) throw new Error(`refused: ${r.refused}`);
  if (isFindAborted(r)) throw new Error('aborted');
  return FilesFindResponseSchema.parse(r);
}

async function refusal(q: string, over: Partial<FilesFindQuery>): Promise<FileRefusal['refused']> {
  const r = await findNames(env.files.policy, query(q, over), { clock: env.ctx.clock });
  if (isFindAborted(r) || !isRefusal(r)) throw new Error('not refused');
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
  it('never a protected name; dot entries only with the hidden flag, whatever the text starts with', async () => {
    env = fpEnv();
    env.write(join(env.proj, '.cache/deep/report.txt'), '');
    env.write(join(env.proj, 'report.md'), '');
    env.write(join(env.proj, 'docs/q3.pdf'), '');
    env.write(join(env.proj, '.drafts/old.pdf'), '');
    mkdirSync(join(env.proj, '.github'));
    expect(paths(await find('report'))).toEqual(['report.md']);
    // A text that starts with a dot is a text: ".pdf" finds the PDFs Browse shows.
    expect(paths(await find('.pdf'))).toEqual(['docs/q3.pdf']);
    expect(paths(await find('.git'))).toEqual([]);
    // With the flag (Browse's "Show hidden files"), dot entries and dot folders too; protected ones never (.git is one).
    expect(paths(await find('.pdf', { hidden: true }))).toEqual(['.drafts/old.pdf', 'docs/q3.pdf']);
    expect(paths(await find('.git', { hidden: true }))).toEqual(['.github', '.gitignore']);
    expect(paths(await find('report', { hidden: true }))).toEqual(['report.md', '.cache/deep/report.txt']);
    // Every secret of the fixture, by its own name: none, with the flag or without.
    for (const hidden of [false, true]) {
      for (const q of ['credentials', 'id_rsa', '.env', 'secret', 'token', '.npmrc', 'kubeconfig', 'tfstate', '.pem']) {
        const r = await find(q, { hidden });
        expect(r.entries.filter((e) => PROJECT_SECRETS.some((s) => s === e.path || s.startsWith(`${e.path}/`) || e.path.startsWith(`${s}/`))), q).toEqual([]);
      }
    }
    // aws/ is a plain folder; its credentials file is not.
    expect(paths(await find('aws'))).toEqual(['aws']);
  });

  it('a home root: no ~/Library and no top-level dot entry, even with the hidden flag; no secret is ever opened', async () => {
    env = fpEnv({ homeRoot: true });
    const seen: string[] = [];
    for (const op of ['open', 'openNoFollow', 'opendir', 'readFile', 'readdir'] as const) {
      const orig = (fsx[op] as (p: string) => Promise<unknown>).bind(fsx);
      vi.spyOn(fsx, op).mockImplementation(((p: string) => {
        seen.push(p);
        return orig(p);
      }) as never);
    }
    for (const hidden of [false, true]) {
      for (const q of ['.ssh', 'id_rsa', 'Keychains', 'credentials', '.claude', 'config', '.config', 'notes', 'history']) {
        const r = await find(q, { root: 'r.home', hidden });
        for (const e of r.entries) expect(HOME_SECRETS.some((s) => s === e.path || s.startsWith(`${e.path}/`)) && !e.path.startsWith('work/'), `${q}: ${e.path}`).toBe(false);
        expect(JSON.stringify(r)).not.toContain(SECRET_MARKER);
      }
    }
    expect(paths(await find('notes', { root: 'r.home' }))).toEqual(['notes.md']);
    expect(paths(await find('Library', { root: 'r.home', hidden: true }))).toEqual([]);
    const protectedDirs = ['.ssh', '.aws', '.gnupg', '.claude', '.claude-swap-backup', '.jantar', 'Library', '.config'].map((d) => join(env.home, d));
    expect(seen.filter((p) => protectedDirs.some((d) => p === d || p.startsWith(`${d}/`)))).toEqual([]);
  });

  it('never walks into node_modules or .git, in any letter case, though their own names can match', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'node_modules/left-pad/index.js'), '');
    env.write(join(env.proj, 'packages/web/node_modules/left-pad/index.js'), '');
    env.write(join(env.proj, 'vendor/Node_Modules/left-pad/index.js'), '');
    env.write(join(env.proj, 'packages/web/left-pad.ts'), '');
    const opened = vi.spyOn(env.files.policy, 'openDir');
    expect(paths(await find('left-pad'))).toEqual(['packages/web/left-pad.ts']);
    expect(opened.mock.calls.map((c) => c[1]).filter((p) => /node_modules|\.git/i.test(p))).toEqual([]);
    expect(paths(await find('node_mod'))).toEqual(['node_modules', 'vendor/Node_Modules', 'packages/web/node_modules']);
    // Even when dot entries are walked, .git is not (it is protected besides).
    await find('.git', { hidden: true });
    expect(opened.mock.calls.map((c) => c[1]).filter((p) => /(^|\/)\.git(\/|$)/i.test(p))).toEqual([]);
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

describe('caps: each one reached says truncated, and which', () => {
  it('results: at most `limit` (100 by default), the best ones; stopped "limit"', async () => {
    env = fpEnv();
    const d = join(env.proj, 'many');
    mkdirSync(d);
    for (let i = 0; i < 120; i++) writeFileSync(join(d, `item-${String(i).padStart(3, '0')}.txt`), '');
    writeFileSync(join(env.proj, 'item-top.txt'), '');
    const all = await find('item-');
    expect(all.entries).toHaveLength(100);
    expect([all.truncated, all.stopped]).toEqual([true, 'limit']);
    expect(all.entries[0]?.path).toBe('item-top.txt');
    const three = await find('item-', { limit: 3 });
    expect(paths(three)).toEqual(['item-top.txt', 'many/item-000.txt', 'many/item-001.txt']);
    expect([three.truncated, three.stopped]).toEqual([true, 'limit']);
    const exact = await find('item-11');
    expect(exact.entries).toHaveLength(10);
    expect([exact.truncated, exact.stopped]).toEqual([false, null]);
  });

  it(`depth: names at most ${FILES_FIND_MAX_DEPTH} levels below the folder; stopped "scan" only when something was past it`, async () => {
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
    expect([r.truncated, r.stopped]).toEqual([true, 'scan']);
    // From two levels down, the deepest ones are in reach, and nothing is left past the cap.
    const near = await find('deep-', { path: 'd1/d2' });
    expect(near.entries.map((e) => e.name)).toEqual(Array.from({ length: FILES_FIND_MAX_DEPTH }, (_, i) => `deep-${i + 3}.txt`));
    expect([near.truncated, near.stopped]).toEqual([false, null]);
  });

  it('depth: an empty folder at the cap (or one with only hidden entries) cuts nothing', async () => {
    env = fpEnv();
    let at = join(env.proj, 'chain');
    for (let k = 2; k <= FILES_FIND_MAX_DEPTH; k++) at = join(at, `c${k}`);
    mkdirSync(at, { recursive: true });
    env.write(join(env.proj, 'chain/chain-note.md'), '');
    const empty = await find('chain-');
    expect(paths(empty)).toEqual(['chain/chain-note.md']);
    expect([empty.truncated, empty.stopped]).toEqual([false, null]);
    // A dot file there is past the cap only when hidden entries are searched.
    env.write(join(at, '.keep'), '');
    expect((await find('chain-')).truncated).toBe(false);
    expect((await find('chain-', { hidden: true })).stopped).toBe('scan');
  });

  it('entries looked at: every entry read counts, dot entries too; no folder is read past the budget', async () => {
    env = fpEnv();
    for (const dir of ['a', 'b', 'c']) for (let i = 0; i < 8; i++) env.write(join(env.proj, dir, `f${i}.txt`), '');
    const opened = vi.spyOn(env.files.policy, 'openDir');
    const whole = await find('f', {}, { maxVisited: 1_000 });
    expect(whole.truncated).toBe(false);
    opened.mockClear();
    const cut = await find('f', {}, { maxVisited: 20 });
    expect([cut.truncated, cut.stopped]).toEqual([true, 'scan']);
    // Each read asks for no more than what is left of the budget.
    const asked = opened.mock.calls.map((c) => c[2]?.maxScan ?? Infinity);
    expect(asked[0]).toBe(20);
    expect(asked.every((n) => n <= 20)).toBe(true);
    expect(cut.entries.length).toBeLessThan(whole.entries.length);
    // A folder of dot files that are not searched still spends the budget.
    for (let i = 0; i < 30; i++) env.write(join(env.proj, 'dots', `.d${i}`), '');
    env.write(join(env.proj, 'dots', 'zz-last.txt'), '');
    expect(await find('zz-last', { path: 'dots' }, { maxVisited: 1_000 })).toMatchObject({ truncated: false, stopped: null });
    expect(await find('zz-last', { path: 'dots' }, { maxVisited: 10 })).toMatchObject({ truncated: true, stopped: 'scan' });
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
    expect([r.truncated, r.stopped]).toEqual([true, 'scan']);
    expect(r.entries.length).toBeLessThan(5);
    // A fast enough Mac reads every folder.
    opened.mockImplementation(orig);
    const all = await find('hit');
    expect(all.entries).toHaveLength(5);
    expect(all.truncated).toBe(false);
  });

  it('time: judging matched links waits for the same clock, and stops when it is spent', async () => {
    env = fpEnv();
    for (let i = 0; i < 6; i++) env.link(join(env.proj, 'README.md'), join(env.proj, `link-${i}.md`));
    const orig = env.files.policy.openForRead.bind(env.files.policy);
    const judged = vi.spyOn(env.files.policy, 'openForRead').mockImplementation(async (...args) => {
      env.ctx.clock.advance(600);
      return orig(...args);
    });
    const r = await find('link-');
    expect(judged).toHaveBeenCalledTimes(3);
    expect(paths(r)).toEqual(['link-0.md', 'link-1.md', 'link-2.md']);
    expect([r.truncated, r.stopped]).toEqual([true, 'scan']);
  });
});

describe('a walk that is called off, and a folder that goes away', () => {
  it('stops at the next folder once its signal aborts, and says so', async () => {
    env = fpEnv();
    for (const dir of ['a', 'b', 'c', 'd']) env.write(join(env.proj, dir, `${dir}-hit.txt`), '');
    const stop = new AbortController();
    const orig = env.files.policy.openDir.bind(env.files.policy);
    const opened = vi.spyOn(env.files.policy, 'openDir').mockImplementation(async (...args) => {
      if (opened.mock.calls.length === 2) stop.abort();
      return orig(...args);
    });
    const r = await findNames(env.files.policy, query('hit'), { clock: env.ctx.clock, signal: stop.signal });
    expect(isFindAborted(r)).toBe(true);
    expect(opened).toHaveBeenCalledTimes(2);
    // Already aborted: nothing is read at all.
    opened.mockClear();
    expect(isFindAborted(await findNames(env.files.policy, query('hit'), { clock: env.ctx.clock, signal: stop.signal }))).toBe(true);
    expect(opened).not.toHaveBeenCalled();
  });

  it('a folder removed while the walk is on its way is passed over; the rest is found', async () => {
    env = fpEnv();
    for (const dir of ['a', 'b', 'c']) env.write(join(env.proj, dir, `${dir}-hit.txt`), '');
    env.write(join(env.proj, 'b/deeper/b2-hit.txt'), '');
    const orig = env.files.policy.openDir.bind(env.files.policy);
    vi.spyOn(env.files.policy, 'openDir').mockImplementation(async (root, rel, o) => {
      if (rel === 'b') rmSync(join(env.proj, 'b'), { recursive: true, force: true });
      return orig(root, rel, o);
    });
    const r = await find('hit');
    expect(paths(r)).toEqual(['a/a-hit.txt', 'c/c-hit.txt']);
    expect([r.truncated, r.stopped]).toEqual([false, null]);
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
    const get = (qs: string, signal?: AbortSignal) => api!.tcp.inject({ method: 'GET', url: `/v1/files/find?${qs}`, headers: h(cookie), ...(signal ? { signal } : {}) });
    const other = await pairCookie(api);
    const getAsOther = (qs: string) => api!.tcp.inject({ method: 'GET', url: `/v1/files/find?${qs}`, headers: h(other.cookie) });
    // The policy the route walks with (the service's own).
    const policy = api.services.deps.files.policy as PathPolicy;
    return { get, getAsOther, deviceId, policy };
  }

  /** Hold every folder read after the first `free` until `release()`. */
  function holdReads(policy: PathPolicy, free: number) {
    const orig = policy.openDir.bind(policy);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(policy, 'openDir').mockImplementation(async (...args) => {
      if (spy.mock.calls.length > free) await gate;
      return orig(...args);
    });
    return { spy, release: () => release() };
  }

  it('dot entries with hidden=1 or folders.showHidden, as a listing; never for a text that only starts with a dot', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'docs/q3.pdf'), '');
    env.write(join(env.proj, '.drafts/old.pdf'), '');
    const { get } = await serve();
    const names = async (qs: string) => ((await get(qs)).json() as { entries: { path: string }[] }).entries.map((e) => e.path);
    expect(await names('root=r.proj&q=.pdf')).toEqual(['docs/q3.pdf']);
    expect(await names('root=r.proj&q=.pdf&hidden=1')).toEqual(['.drafts/old.pdf', 'docs/q3.pdf']);
    expect((await get('root=r.proj&q=.pdf&hidden=yes')).statusCode).toBe(400);
    await api!.ctx.settings.patch({ folders: { showHidden: true } });
    expect(await names('root=r.proj&q=.pdf')).toEqual(['.drafts/old.pdf', 'docs/q3.pdf']);
  });

  it('one walk per device: a newer search stops the one before it (409), another device\'s goes on', async () => {
    env = fpEnv();
    for (const dir of ['a', 'b', 'c']) env.write(join(env.proj, dir, `${dir}-hit.txt`), '');
    const { get, getAsOther, policy } = await serve();
    // The first search reads its folder, then waits on the next one.
    const held = holdReads(policy, 1);
    const first = get('root=r.proj&q=hit');
    await vi.waitFor(() => expect(held.spy.mock.calls.length).toBeGreaterThanOrEqual(2));
    held.spy.mockRestore();
    const second = await get('root=r.proj&q=hit');
    expect(second.statusCode).toBe(200);
    expect((second.json() as { entries: unknown[] }).entries).toHaveLength(3);
    held.release();
    const stopped = await first;
    expect([stopped.statusCode, stopped.json().error]).toEqual([409, { code: 'conflict', message: FIND_STOPPED }]);
    // Searches from two devices don't stop each other.
    const both = await Promise.all([get('root=r.proj&q=hit'), getAsOther('root=r.proj&q=hit')]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
  });

  it('a request already gone when it starts (late, out of order) stops nothing: the live search goes on', async () => {
    env = fpEnv();
    for (const dir of ['a', 'b', 'c']) env.write(join(env.proj, dir, `${dir}-hit.txt`), '');
    const { get, policy } = await serve();
    const held = holdReads(policy, 1);
    const live = get('root=r.proj&q=hit');
    await vi.waitFor(() => expect(held.spy.mock.calls.length).toBeGreaterThanOrEqual(2));
    const reads = held.spy.mock.calls.length;
    const late = new AbortController();
    late.abort();
    await get('root=r.proj&q=hi', late.signal).catch((e: unknown) => e);
    // It read nothing of its own.
    expect(held.spy.mock.calls.length).toBe(reads);
    held.release();
    const res = await live;
    expect(res.statusCode).toBe(200);
    expect((res.json() as { entries: unknown[] }).entries).toHaveLength(3);
  });

  it('a request that goes away stops its walk at the next folder', async () => {
    env = fpEnv();
    for (const dir of ['a', 'b', 'c', 'd']) env.write(join(env.proj, dir, `${dir}-hit.txt`), '');
    const { get, policy } = await serve();
    const held = holdReads(policy, 1);
    const gone = new AbortController();
    const req = get('root=r.proj&q=hit', gone.signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(held.spy.mock.calls.length).toBe(2));
    gone.abort();
    await req;
    held.release();
    await new Promise((r) => setTimeout(r, 50));
    // The root and the folder it was reading when the phone went away: no more.
    expect(held.spy).toHaveBeenCalledTimes(2);
  });

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
      stopped: null,
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
    // A search is audited as a listing is: once per device and folder per 10 min, folder and count only.
    expect((await get('root=r.proj&q=auth')).statusCode).toBe(200);
    const finds = api!.ctx.db.audit.list({ limit: 100 }).filter((r) => r.action === 'files.find');
    expect(finds.map((r) => [r.actor, r.target, r.params, r.result])).toEqual([[`device:${deviceId}`, 'r.proj', { root: 'r.proj', rel: '', count: 1 }, 'ok']]);
    api!.ctx.clock.advance(AUDIT_DEDUPE_MS);
    expect((await get('root=r.proj&path=src&q=auth')).statusCode).toBe(200);
    expect((await get('root=r.proj&q=auth')).statusCode).toBe(200);
    expect(api!.ctx.db.audit.list({ limit: 100 }).filter((r) => r.action === 'files.find').map((r) => r.params)).toEqual(
      expect.arrayContaining([{ root: 'r.proj', rel: 'src', count: 1 }, { root: 'r.proj', rel: '', count: 1 }]),
    );
    expect(api!.ctx.db.audit.list({ limit: 100 }).filter((r) => r.action === 'files.find')).toHaveLength(3);
    const denied = api!.ctx.db.audit.list({ limit: 100 }).filter((r) => r.action === 'files.denied');
    expect(denied.map((r) => (r.params as { reason: string }).reason).sort()).toEqual(['bad_path', 'no_root', 'not_dir', 'protected']);
    expect(denied.every((r) => r.actor === `device:${deviceId}`)).toBe(true);
    // The text searched for is in no audit row.
    const rows = JSON.stringify(api!.ctx.db.audit.list({ limit: 100 }));
    expect(rows).not.toContain('sess');
    expect(rows).not.toContain('auth"');
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
