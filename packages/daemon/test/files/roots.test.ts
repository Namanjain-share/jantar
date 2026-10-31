/**
 * Roots (v0.3 spec 4.4.1, security rule F10): configured roots come from
 * the Mac only, and `/`, `/Users`, `~/Library` and denylisted dirs are
 * refused as roots even when settings name them (ctl.sock can write any
 * settings). Live session folders are roots too, each folder listed once.
 */
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorBodySchema } from '@jantar/protocol';
import { createTestContext } from '../../src/core/testing.js';
import { buildFilesService } from '../../src/files/service.js';
import { isRefusal } from '../../src/files/policy.js';
import { ROOT_CACHE_MS } from '../../src/files/roots.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { ADMIN, CLI, PHONE, fpEnv, writeAt, type FpEnv } from './fp-helpers.js';

let env: FpEnv;
let api: TestApi | undefined;

function refusalOf(v: unknown): string | null {
  return isRefusal(v) ? v.refused : null;
}

afterEach(async () => {
  await api?.close();
  api = undefined;
  env?.cleanup();
});

describe('configured roots', () => {
  it('resolve to their realpath with the label from settings and a ~ display', async () => {
    env = fpEnv();
    const roots = await env.files.policy.roots();
    expect(roots.map((r) => [r.id, r.kind, r.label, r.display, r.home])).toEqual([
      ['r.proj', 'configured', 'proj', '~/work/proj', false],
      ['r.desktop', 'configured', 'Desktop', '~/Desktop', false],
    ]);
    expect(roots[0]?.real).toBe(env.proj);
  });

  it('a root of $HOME is in home mode', async () => {
    env = fpEnv({ homeRoot: true });
    expect(await env.files.policy.root('r.home')).toMatchObject({ id: 'r.home', home: true, display: '~', real: env.home });
  });

  it('absolute paths go to the CLI and admin devices only', async () => {
    env = fpEnv();
    const phone = await env.files.roots(PHONE);
    expect(phone[0]).toEqual({ id: 'r.proj', kind: 'configured', label: 'proj', display: '~/work/proj', home: false });
    expect(phone.some((r) => 'path' in r)).toBe(false);
    expect((await env.files.roots(ADMIN))[0]?.path).toBe(env.proj);
    expect((await env.files.roots(CLI))[0]?.path).toBe(env.proj);
  });

  it('F10: /, /Users, /Volumes, /private, /System, /Library, ~/Library and denylisted dirs are refused, whatever settings say', async () => {
    env = fpEnv();
    writeAt(join(env.proj, 'file.txt'), 'x');
    mkdirSync(join(env.home, 'Library/Mobile Documents'), { recursive: true });
    const bad = {
      slash: '/',
      users: '/Users',
      volumes: '/Volumes',
      private: '/private',
      system: '/System',
      library: '/Library',
      etc: '/etc',
      tmp: '/tmp',
      homelib: '~/Library',
      icloud: '~/Library/Mobile Documents',
      ssh: '~/.ssh',
      aws: '~/.aws',
      claude: '~/.claude',
      swap: '~/.claude-swap-backup',
      state: '~/.jantar',
      config: '~/.config',
      gh: '~/.config/gh',
      git: '~/work/proj/.git',
      file: '~/work/proj/file.txt',
      gone: '~/nowhere',
      relative: 'work/proj',
      dotdot: '~/work/proj/../../.ssh',
    };
    const entries = Object.entries(bad).map(([id, path]) => ({ id, path, label: id }));
    // Settings hold at most 20 roots: try them in two batches.
    for (const batch of [entries.slice(0, 11), entries.slice(11)]) {
      expect((await env.ctx.settings.patch({ folders: { roots: batch } })).ok).toBe(true);
      expect(await env.files.policy.roots()).toEqual([]);
      for (const { id } of batch) expect(await env.files.policy.root(`r.${id}`), id).toBeNull();
    }
    for (const id of Object.keys(bad)) {
      expect(env.ctx.log.records.filter((e) => e.msg === 'files root refused' && e.fields.root === `r.${id}`), id).toHaveLength(1);
    }
    // Each is logged once, not on every request.
    await env.files.policy.roots();
    expect(env.ctx.log.records.filter((e) => e.msg === 'files root refused')).toHaveLength(Object.keys(bad).length);
  });

  it('F10: ctl.sock can name any root, and the daemon still refuses the bad ones; a device cannot change roots at all', async () => {
    env = fpEnv();
    api = await makeApi({
      ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
      deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
    });
    const admin = await pairCookie(api, ['admin']);
    const roots = [
      { id: 'slash', path: '/', label: 'all' },
      { id: 'lib', path: '~/Library', label: 'lib' },
      { id: 'ssh', path: '~/.ssh', label: 'ssh' },
      { id: 'proj', path: '~/work/proj', label: 'proj' },
    ];
    const tcp = await api.tcp.inject({ method: 'PATCH', url: '/v1/settings', headers: h(admin.cookie), payload: { folders: { roots } } });
    expect(tcp.statusCode).toBe(403);
    expect(ErrorBodySchema.parse(tcp.json()).error.code).toBe('forbidden');
    const ctl = await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: { folders: { roots } } });
    expect(ctl.statusCode).toBe(200);
    const res = await api.tcp.inject({ method: 'GET', url: '/v1/files/roots', headers: h(admin.cookie) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { roots: { id: string }[] }).roots.map((r) => r.id)).toEqual(['r.proj']);
    const list = await api.tcp.inject({ method: 'GET', url: '/v1/files/list?root=r.slash', headers: h(admin.cookie) });
    expect(list.statusCode).toBe(404);
  });

  it('a $HOME given through a symlink matches in both forms (like /var and /private/var)', async () => {
    env = fpEnv();
    const viaLink = join(env.base, 'home-link');
    symlinkSync(env.home, viaLink);
    const ctx = createTestContext({ userHome: viaLink, home: join(viaLink, '.jantar'), settings: env.ctx.settings.get() });
    const files = buildFilesService(ctx, { sessions: { start: async () => {}, stop: async () => {}, scan: async () => [], current: () => [], accountForConfigDir: () => null }, notifiers: [] });
    await files.start();
    expect((await files.policy.roots()).map((r) => [r.id, r.display, r.real])).toEqual([
      ['r.proj', '~/work/proj', env.proj],
      ['r.desktop', '~/Desktop', env.desktop],
    ]);
    for (const home of [viaLink, env.home]) {
      expect(files.policy.isProtected(join(home, '.ssh/config')), home).toBe(true);
      expect(files.policy.isProtected(join(home, '.jantar/db')), home).toBe(true);
      expect(files.policy.isProtected(join(home, 'work/proj/src/app.ts')), home).toBe(false);
    }
  });

  it('realpaths are cached for 5 s', async () => {
    env = fpEnv();
    expect(await env.files.policy.root('r.desktop')).not.toBeNull();
    rmSync(env.desktop, { recursive: true });
    expect(await env.files.policy.root('r.desktop')).not.toBeNull();
    env.ctx.clock.advance(ROOT_CACHE_MS);
    expect(await env.files.policy.root('r.desktop')).toBeNull();
  });
});

describe('session roots', () => {
  it('a live session folder is root s.<sid>, labelled with its folder name', async () => {
    env = fpEnv();
    const cwd = join(env.home, 'work/side');
    mkdirSync(cwd, { recursive: true });
    env.addSession({ sid: 'sess-side', cwd });
    const r = await env.files.policy.root('s.sess-side');
    expect(r).toMatchObject({ id: 's.sess-side', kind: 'session', sid: 'sess-side', label: 'side', display: '~/work/side', home: false, real: cwd });
    expect((await env.files.roots(PHONE)).map((x) => x.id)).toEqual(['r.proj', 'r.desktop', 's.sess-side']);
    expect((await env.files.roots(PHONE)).at(-1)).toEqual({ id: 's.sess-side', kind: 'session', label: 'side', sid: 'sess-side', display: '~/work/side', home: false });
  });

  it('a session in $HOME is a home-mode root labelled "home"', async () => {
    env = fpEnv();
    env.addSession({ sid: 'sess-home', cwd: env.home });
    expect(await env.files.policy.root('s.sess-home')).toMatchObject({ label: 'home', home: true, display: '~' });
  });

  it('folders shown once: a session in a configured root merges into it, two sessions in one folder show once, yet every s.<sid> resolves', async () => {
    env = fpEnv();
    env.addSession({ sid: 'sess-a', cwd: env.proj });
    const other = join(env.home, 'work/other');
    mkdirSync(other, { recursive: true });
    env.addSession({ sid: 'sess-b', cwd: other });
    env.addSession({ sid: 'sess-c', cwd: `${other}/` });
    expect((await env.files.policy.roots()).map((r) => r.id)).toEqual(['r.proj', 'r.desktop', 's.sess-b']);
    expect(await env.files.policy.root('s.sess-a')).toMatchObject({ id: 's.sess-a', real: env.proj });
    expect(await env.files.policy.root('s.sess-c')).toMatchObject({ id: 's.sess-c', real: other });
  });

  it('session folders that may not be roots are left out', async () => {
    env = fpEnv();
    mkdirSync(join(env.home, 'Library/Caches/x'), { recursive: true });
    env.addSession({ sid: 'sess-root', cwd: '/' });
    env.addSession({ sid: 'sess-lib', cwd: join(env.home, 'Library/Caches/x') });
    env.addSession({ sid: 'sess-ssh', cwd: join(env.home, '.ssh') });
    env.addSession({ sid: 'sess-gone', cwd: join(env.home, 'gone') });
    env.addSession({ sid: 'sess-rel', cwd: 'relative/dir' });
    env.addSession({ sid: 'sess-tmp', cwd: '/tmp' });
    for (const sid of ['sess-root', 'sess-lib', 'sess-ssh', 'sess-gone', 'sess-rel', 'sess-tmp']) {
      expect(await env.files.policy.root(`s.${sid}`), sid).toBeNull();
    }
    expect((await env.files.policy.roots()).map((r) => r.id)).toEqual(['r.proj', 'r.desktop']);
  });

  it('folders.sessionRoots off: no session roots at all', async () => {
    env = fpEnv({ folders: { sessionRoots: false } });
    env.addSession({ sid: 'sess-a', cwd: env.proj });
    expect(await env.files.policy.root('s.sess-a')).toBeNull();
    expect((await env.files.policy.roots()).map((r) => r.id)).toEqual(['r.proj', 'r.desktop']);
  });

  it('a session root ends with its session', async () => {
    env = fpEnv();
    const cwd = join(env.home, 'work/side');
    mkdirSync(cwd, { recursive: true });
    env.addSession({ sid: 'sess-side', cwd });
    expect(await env.files.policy.root('s.sess-side')).not.toBeNull();
    env.ctx.store.emit({ type: 'session.removed', sid: 'sess-side', data: { reason: 'ended' } });
    expect(await env.files.policy.root('s.sess-side')).toBeNull();
  });

  it('a session still in the store with status "ended" is not a root', async () => {
    env = fpEnv();
    const cwd = join(env.home, 'work/side');
    mkdirSync(cwd, { recursive: true });
    env.addSession({ sid: 'sess-side', cwd });
    env.addSession({ sid: 'sess-done', cwd: join(env.home, 'Desktop'), status: 'ended' });
    expect(await env.files.policy.root('s.sess-done')).toBeNull();
    expect(refusalOf(await env.files.policy.openDir('s.sess-done', ''))).toBe('no_root');
    expect((await env.files.policy.roots()).map((r) => r.id)).toEqual(['r.proj', 'r.desktop', 's.sess-side']);
    env.ctx.store.emit({ type: 'session.updated', sid: 'sess-side', data: { patch: { status: 'ended' } } });
    expect(await env.files.policy.root('s.sess-side')).toBeNull();
    expect((await env.files.policy.roots()).map((r) => r.id)).toEqual(['r.proj', 'r.desktop']);
  });
});

describe('root ids that are Object.prototype keys', () => {
  const IDS = ['s.constructor', 's.__proto__', 's.toString', 's.hasOwnProperty', 's.valueOf', 'r.constructor', 'r.__proto__'];

  it('are unknown roots: refused with no_root, never thrown', async () => {
    env = fpEnv();
    // A real session too, so the sessions map is not empty.
    env.addSession({ sid: 'sess-a', cwd: env.proj });
    const p = env.files.policy;
    for (const id of IDS) {
      expect(await p.root(id), id).toBeNull();
      expect(refusalOf(await p.openForRead(id, 'a')), id).toBe('no_root');
      expect(refusalOf(await p.openDir(id, '')), id).toBe('no_root');
      expect(refusalOf(await p.resolveDir(id, '')), id).toBe('no_root');
      expect(refusalOf(await env.files.text({ root: id, path: 'a', offset: 0, max: 1024 }, PHONE)), id).toBe('no_root');
    }
    expect((await p.roots()).map((r) => r.id)).toEqual(['r.proj', 'r.desktop']);
  });

  it('over HTTP: 404 not_found, not 500', async () => {
    env = fpEnv();
    api = await makeApi({
      ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
      deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
    });
    const phone = await pairCookie(api);
    for (const url of [
      '/v1/files/list?root=s.__proto__',
      '/v1/files/list?root=s.constructor&path=',
      '/v1/files/stat?root=s.hasOwnProperty&path=a',
      '/v1/files/text?root=s.constructor&path=a',
      '/v1/files/raw?root=s.toString&path=a.png',
    ]) {
      const res = await api.tcp.inject({ method: 'GET', url, headers: h(phone.cookie) });
      expect(res.statusCode, url).toBe(404);
      expect(ErrorBodySchema.parse(res.json()).error.code, url).toBe('not_found');
    }
  });
});
