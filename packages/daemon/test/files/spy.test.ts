/**
 * Security rule F11: across a sweep of every files route (a crawler that
 * follows every listing from every root, then every secret path, traversal
 * string, case variant and symlink aimed at a secret) and the policy calls
 * other parts make, an fsx spy shows no open, opendir or read of a path in a
 * denylisted place, and no reply, audit row, log line or event carries
 * SECRET_MARKER.
 *
 * realpath has to see where a symlink leads before the policy can refuse it,
 * so a realpath may return a protected path; what never follows is an open,
 * an opendir or a read of it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, FileListing } from '@jantar/protocol';
import { buildFilesService } from '../../src/files/service.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { HOME_SECRETS, PHONE, PROJECT_SECRETS, SECRET_MARKER, fpEnv, type FpEnv } from './fp-helpers.js';

let env: FpEnv;
let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  env?.cleanup();
});

type Access = { op: string; path: string };

function spyFsx(): Access[] {
  const seen: Access[] = [];
  for (const op of ['open', 'openNoFollow', 'opendir', 'readFile', 'readText', 'readdir'] as const) {
    const orig = (fsx[op] as (p: string) => Promise<unknown>).bind(fsx);
    vi.spyOn(fsx, op).mockImplementation(((p: string) => {
      seen.push({ op, path: p });
      return orig(p);
    }) as never);
  }
  return seen;
}

describe('F11: nothing in a denylisted place is ever opened, listed or served', () => {
  it('a crawler over every root plus every attack input', async () => {
    env = fpEnv({ homeRoot: true, folders: { allow: ['~/.config/nvim'] } });
    // Symlinks aimed at secrets, from inside the project.
    env.link(join(env.home, '.ssh'), join(env.proj, 'sshdir'));
    env.link(join(env.home, '.ssh/id_rsa'), join(env.proj, 'key.txt'));
    env.link('.env', join(env.proj, 'env-copy.txt'));
    env.link(join(env.home, '.claude'), join(env.proj, 'claude-home'));
    env.link(join(env.home, 'Library'), join(env.proj, 'lib'));
    env.link(join(env.home, '.config/other'), join(env.proj, 'other-config'));
    env.link('/etc', join(env.proj, 'etc'));
    env.write(join(env.proj, 'src/cafe\u0301.ts'), 'export {};\n');

    // Every protected place in the tree, by an oracle independent of the policy.
    const protectedPlaces = [
      ...HOME_SECRETS.map((r) => join(env.home, r)),
      ...PROJECT_SECRETS.map((r) => join(env.proj, r)),
      ...['.ssh', '.aws', '.gnupg', '.claude', '.claude-swap-backup', '.example-tool', '.jantar', 'Library', '.config/gh', '.config/ccw', '.config/other'].map((r) => join(env.home, r)),
      join(env.proj, '.git'),
      '/etc',
      '/private/etc',
    ];
    const isProtectedPlace = (p: string) => protectedPlaces.some((x) => p === x || p.startsWith(`${x}/`));

    api = await makeApi({
      ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
      deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
    });
    const admin = await pairCookie(api, ['admin']);
    const phone = await pairCookie(api);
    const seen = spyFsx();
    const bodies: string[] = [];
    const get = async (cookie: string, url: string) => {
      const res = await api!.tcp.inject({ method: 'GET', url, headers: h(cookie) });
      bodies.push(res.rawPayload.toString('latin1'));
      return res;
    };
    const qs = (root: string, path: string) => `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;

    // 1. The crawler: every listing (hidden entries too), every file it finds through stat, text and raw.
    const roots = ((await get(admin.cookie, '/v1/files/roots')).json() as { roots: { id: string }[] }).roots.map((r) => r.id);
    expect(roots).toEqual(['r.proj', 'r.desktop', 'r.home']);
    let files = 0;
    for (const root of roots) {
      const queue = [''];
      while (queue.length > 0) {
        const dir = queue.shift() as string;
        let after: string | null = null;
        do {
          const res = await get(phone.cookie, `/v1/files/list?${qs(root, dir)}&hidden=1${after ? `&after=${encodeURIComponent(after)}` : ''}`);
          expect(res.statusCode, `${root}:${dir}`).toBe(200);
          const l = res.json() as FileListing;
          for (const e of l.entries as FileEntry[]) {
            const rel = dir ? `${dir}/${e.name}` : e.name;
            if (e.type === 'dir' || (e.type === 'link' && e.link === 'inside')) {
              if (e.type === 'dir') queue.push(rel);
            }
            if (e.type === 'file' || e.type === 'link') {
              files += 1;
              await get(phone.cookie, `/v1/files/stat?${qs(root, rel)}`);
              await get(phone.cookie, `/v1/files/text?${qs(root, rel)}`);
              await get(phone.cookie, `/v1/files/raw?${qs(root, rel)}`);
            }
          }
          after = l.next;
        } while (after);
      }
    }
    expect(files).toBeGreaterThan(10);

    // 2. Every secret by name, in several spellings, through every route and both roots.
    const attacks = [
      ...PROJECT_SECRETS.map((r) => ['r.proj', r] as const),
      ...PROJECT_SECRETS.map((r) => ['r.proj', r.toUpperCase()] as const),
      ...PROJECT_SECRETS.map((r) => ['r.home', `work/proj/${r}`] as const),
      ...HOME_SECRETS.map((r) => ['r.home', r] as const),
      ...['sshdir/id_rsa', 'sshdir/config', 'key.txt', 'env-copy.txt', 'claude-home/settings.json', 'lib/Keychains/login.keychain-db', 'other-config/token', 'etc/hosts'].map((r) => ['r.proj', r] as const),
      ...['../.ssh/id_rsa', '../../.ssh/id_rsa', '%2e%2e/%2e%2e/.ssh/id_rsa', '/etc/passwd', `${env.home}/.ssh/id_rsa`, '.ssh\\id_rsa', '.Ssh/Id_Rsa', 'work/proj/.git/config', 'Library/Application Support/x.txt'].map((r) => ['r.home', r] as const),
      ['s.sess-aaaa-1111', '.env'] as const,
    ];
    for (const [root, rel] of attacks) {
      for (const route of ['stat', 'text', 'raw']) {
        const res = await get(phone.cookie, `/v1/files/${route}?${qs(root, rel)}`);
        expect(res.statusCode, `${route} ${root}:${rel}`).toBeGreaterThanOrEqual(400);
      }
      await get(phone.cookie, `/v1/files/list?${qs(root, rel)}&hidden=1`);
    }

    // 3. What other parts call: the folder browser, the launcher's re-check, the changes list.
    const policy = (api.services.deps.files as typeof env.files).policy;
    for (const rel of ['', '.config', 'work', 'Library', '.ssh']) await policy.openDir('r.home', rel, { hidden: true, dirsOnly: true });
    for (const rel of ['.ssh', '.claude', 'Library', '.config', 'work/proj/.git', 'work/proj']) await policy.resolveDir('r.home', rel);
    for (const p of protectedPlaces) await policy.locate(p);
    await policy.locate(join(env.proj, 'key.txt'));

    // Nothing in a denylisted place was opened, listed or read.
    const content = seen.filter((a) => isProtectedPlace(a.path));
    expect(content).toEqual([]);
    // The policy agrees: only a home dot dir on the way to a folders.allow entry (~/.config) is listed.
    for (const a of seen) {
      expect(policy.rules().check(a.path), `${a.op} ${a.path}`).toBe(a.op === 'opendir' && a.path === join(env.home, '.config') ? 'ancestor' : 'ok');
    }
    // Every file that was opened holds no secret.
    for (const a of seen.filter((x) => x.op === 'openNoFollow')) {
      let text = '';
      try {
        text = readFileSync(a.path, 'latin1');
      } catch {
        text = '';
      }
      expect(text, a.path).not.toContain(SECRET_MARKER);
    }
    expect(seen.some((a) => a.op === 'openNoFollow')).toBe(true);
    expect(seen.some((a) => a.op === 'opendir')).toBe(true);

    // No reply, audit row, log line or event carries the marker.
    for (const b of bodies) expect(b).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(api.ctx.db.audit.list({ limit: 10_000 }))).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(api.ctx.log.records)).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(api.ctx.db.events.since(0))).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(api.ctx.store.getState())).not.toContain(SECRET_MARKER);
  }, 60_000);

  it('the lexical check comes first: a protected path never reaches realpath, stat, lstat, opendir or open', async () => {
    env = fpEnv({ homeRoot: true, folders: { allow: ['~/.config/nvim'] } });
    const p = env.files.policy;
    // $HOME, the state dir and the roots resolved first, as in a running daemon.
    await p.ready();
    await p.roots();
    const seen: Access[] = [];
    for (const op of ['realpath', 'stat', 'lstat', 'opendir', 'openNoFollow', 'open'] as const) {
      const orig = (fsx[op] as (p: string) => Promise<unknown>).bind(fsx);
      vi.spyOn(fsx, op).mockImplementation(((path: string, ...rest: unknown[]) => {
        seen.push({ op, path });
        return (orig as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
      }) as never);
    }
    const inputs: (readonly [string, string])[] = [
      ...PROJECT_SECRETS.map((r) => ['r.proj', r] as const),
      ...PROJECT_SECRETS.map((r) => ['r.proj', r.toUpperCase()] as const),
      ...HOME_SECRETS.map((r) => ['r.home', r] as const),
      ...['keys/id_rſa', '.ſſh/config', 'sub/.ENV.local', 'a/.git/HEAD'].map((r) => ['r.proj', r] as const),
      ...['.ssh', '.claude', 'Library', '.config/gh', '.config/other', '.jantar', 'work/proj/.git'].map((r) => ['r.home', r] as const),
    ];
    for (const [root, rel] of inputs) {
      await p.openForRead(root, rel);
      await p.openDir(root, rel, { hidden: true });
      await p.resolveDir(root, rel);
      await env.files.stat({ root, path: rel }, PHONE);
      await env.files.text({ root, path: rel, offset: 0, max: 1024 }, PHONE);
      await env.files.raw({ root, path: rel }, PHONE);
      await env.files.list({ root, path: rel, limit: 500, hidden: true }, PHONE);
    }
    for (const rel of PROJECT_SECRETS) await p.locate(join(env.proj, rel));
    for (const rel of HOME_SECRETS) await p.locate(join(env.home, rel));
    // Listings that hold protected names skip them by name, before any lstat.
    for (const [root, rel] of [['r.home', ''], ['r.home', '.config'], ['r.proj', '']] as const) {
      await env.files.list({ root, path: rel, limit: 500, hidden: true }, PHONE);
    }
    const rules = p.rules();
    expect(seen.filter((a) => rules.check(a.path) === 'protected')).toEqual([]);
    // The spy saw the disk work the listings did.
    expect(seen.some((a) => a.op === 'realpath')).toBe(true);
    expect(seen.some((a) => a.op === 'opendir')).toBe(true);
  });
});
