/**
 * The path policy (v0.3 spec 4.4.2) against a real temp tree: traversal
 * (F1), symlinks (F3), the swap race (F4), FIFOs and devices (F5), home mode
 * (F6), and the rest of the FilePolicy surface the launcher, Rewrite and the
 * changes list build on.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { perfBudgetMs } from '@jantar/fixtures';
import type { FileRefusal, OpenedFile } from '../../src/contracts.js';
import { REL_MAX_BYTES, inside, isRefusal, parseRel } from '../../src/files/policy.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { ROOT_CACHE_MS } from '../../src/files/roots.js';
import { PHONE, SECRET_MARKER, fpEnv, type FpEnv } from './fp-helpers.js';

let env: FpEnv;
afterEach(() => {
  env?.cleanup();
});

function refusedWith(v: unknown): string {
  if (!isRefusal(v)) throw new Error(`expected a refusal, got ${JSON.stringify(Object.keys(v as object))}`);
  return (v as FileRefusal).refused;
}

async function opened(v: Promise<OpenedFile | FileRefusal>): Promise<OpenedFile> {
  const r = await v;
  if (isRefusal(r)) throw new Error(`refused: ${r.refused}`);
  return r;
}

async function readAll(f: OpenedFile): Promise<string> {
  try {
    return (await f.fh.readFile()).toString('utf8');
  } finally {
    await f.fh.close();
  }
}

describe('F1: traversal and malformed paths are refused before the disk is touched', () => {
  it.each([
    ['..', 'parent'],
    ['../home', 'parent first'],
    ['a/../b', 'parent inside'],
    ['src/..', 'parent last'],
    ['.', 'dot'],
    ['./src/app.ts', 'dot first'],
    ['src/./app.ts', 'dot inside'],
    ['/etc/passwd', 'absolute'],
    ['//etc/passwd', 'double slash'],
    ['a\0b', 'NUL'],
    ['src\\app.ts', 'backslash'],
    ['..\\..\\etc', 'backslash traversal'],
    ['src/\napp.ts', 'newline'],
    ['src/app\r.ts', 'carriage return'],
    ['a\u0007b', 'bell'],
    ['a\u007fb', 'DEL'],
    ['a\u0085b', 'C1 control'],
    ['src//app.ts', 'empty segment'],
    ['src/', 'trailing slash'],
    ['a\ud800b', 'lone surrogate'],
  ])('%j (%s)', async (rel) => {
    env = fpEnv();
    const realpath = vi.spyOn(fsx, 'realpath');
    expect(parseRel(rel)).toBeNull();
    expect(refusedWith(await env.files.policy.openForRead('r.proj', rel))).toBe('bad_path');
    expect(refusedWith(await env.files.policy.openDir('r.proj', rel))).toBe('bad_path');
    expect(refusedWith(await env.files.policy.resolveDir('r.proj', rel))).toBe('bad_path');
    // Only the root's own realpath was taken; nothing under it.
    for (const call of realpath.mock.calls) expect(call[0]).not.toContain('/proj/');
  });

  it('length limits: 1024 bytes, 64 segments, 255 bytes per segment', () => {
    const segs = Array(5).fill('a'.repeat(200));
    expect(parseRel(segs.join('/'))).toEqual(segs);
    expect(parseRel(`${segs.join('/')}/${'b'.repeat(REL_MAX_BYTES - 1005)}`)).toHaveLength(6);
    expect(parseRel(`${segs.join('/')}/${'b'.repeat(REL_MAX_BYTES - 1004)}`)).toBeNull();
    expect(parseRel('a'.repeat(255))).toEqual(['a'.repeat(255)]);
    expect(parseRel('a'.repeat(256))).toBeNull();
    // Multi-byte letters count in bytes: 128 x 2 bytes = 256.
    expect(parseRel('\u00e9'.repeat(128))).toBeNull();
    expect(parseRel(Array(64).fill('a').join('/'))).toHaveLength(64);
    expect(parseRel(Array(65).fill('a').join('/'))).toBeNull();
    expect(parseRel(Array(200).fill('abcd').join('/'))).toBeNull();
  });

  it('clean paths parse into segments; "" is the root', () => {
    expect(parseRel('')).toEqual([]);
    expect(parseRel('src/app.ts')).toEqual(['src', 'app.ts']);
    expect(parseRel('.github/workflows/ci.yml')).toEqual(['.github', 'workflows', 'ci.yml']);
    expect(parseRel('..foo/bar..')).toEqual(['..foo', 'bar..']);
    expect(parseRel('%2e%2e/x')).toEqual(['%2e%2e', 'x']);
  });

  it('containment is by path segments, not string prefixes', () => {
    expect(inside('/a/b', '/a/b')).toBe(true);
    expect(inside('/a/b/c', '/a/b')).toBe(true);
    expect(inside('/a/bc/d', '/a/b')).toBe(false);
    expect(inside('/a', '/a/b')).toBe(false);
    expect(inside('/a/b/..x', '/a/b')).toBe(true);
  });
});

describe('opening files', () => {
  it('opens a regular file under a root and reads through the handle', async () => {
    env = fpEnv();
    const f = await opened(env.files.policy.openForRead('r.proj', 'src/app.ts'));
    expect(f.rel).toBe('src/app.ts');
    expect(f.real).toBe(join(env.proj, 'src/app.ts'));
    expect(f.root.id).toBe('r.proj');
    expect(f.stat.isFile()).toBe(true);
    expect(await readAll(f)).toBe('export const answer = 42;\n');
  });

  it('refuses unknown roots, missing files, dirs and every denylisted file in the project', async () => {
    env = fpEnv();
    const p = env.files.policy;
    for (const id of ['r.nope', 's.nope', 'x.proj', 'proj', '', 'r.', 's.']) expect(refusedWith(await p.openForRead(id, 'src/app.ts')), id).toBe('no_root');
    expect(refusedWith(await p.openForRead('r.proj', 'src/missing.ts'))).toBe('missing');
    expect(refusedWith(await p.openForRead('r.proj', 'src/app.ts/x'))).toBe('missing');
    expect(refusedWith(await p.openForRead('r.proj', 'src'))).toBe('not_file');
    expect(refusedWith(await p.openForRead('r.proj', ''))).toBe('not_file');
    for (const rel of ['.env', '.env.local', '.env.example', '.ENV', '.Env.Local', '.envrc', '.npmrc', '.git/config', 'server.pem', 'deploy/server.KEY', 'id_ed25519.pub', 'ID_ED25519.PUB', 'keys/id_rsa', 'client_secret_123.json', 'service-account-prod.json', 'credentials.json', 'aws/credentials', 'certs/store.p12', 'vault.kdbx']) {
      expect(refusedWith(await p.openForRead('r.proj', rel)), rel).toBe('protected');
    }
  });

  it('project .claude folders stay readable', async () => {
    env = fpEnv();
    expect(await readAll(await opened(env.files.policy.openForRead('r.proj', '.claude/commands/review.md')))).toBe('Review the diff.\n');
  });

  it('works while files.enabled is off (the launcher and Rewrite use it)', async () => {
    env = fpEnv();
    await env.ctx.settings.patch({ files: { enabled: false } });
    expect(env.ctx.settings.get().files.enabled).toBe(false);
    await readAll(await opened(env.files.policy.openForRead('r.proj', 'README.md')));
    expect(isRefusal(await env.files.policy.resolveDir('r.proj', 'src'))).toBe(false);
  });

  it('a permission-denied folder is os_permission, not missing', async () => {
    env = fpEnv();
    const locked = join(env.proj, 'locked');
    env.write(join(locked, 'a.txt'), 'x');
    chmodSync(locked, 0o000);
    try {
      const r = await env.files.policy.openForRead('r.proj', 'locked/a.txt');
      expect(refusedWith(r)).toBe('os_permission');
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe('F3: symlinks', () => {
  it('a link to ~/.ssh: refused by name, or as outside the root', async () => {
    env = fpEnv();
    env.link(join(env.home, '.ssh'), join(env.proj, 'sshlink'));
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'sshlink/id_rsa'))).toBe('protected');
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'sshlink/config'))).toBe('outside');
  });

  it('the same link seen from a $HOME root lands inside the root, on a protected path', async () => {
    env = fpEnv({ homeRoot: true });
    env.link(join(env.home, '.ssh'), join(env.proj, 'sshlink'));
    expect(refusedWith(await env.files.policy.openForRead('r.home', 'work/proj/sshlink/config'))).toBe('protected');
  });

  it('a link to /etc, a 3-link chain out, and a symlinked parent dir out are all refused', async () => {
    env = fpEnv();
    const outside = join(env.base, 'outside');
    env.write(join(outside, 'secret.txt'), SECRET_MARKER);
    env.link('/etc', join(env.proj, 'etclink'));
    env.link(join(outside, 'secret.txt'), join(env.proj, 'l3'));
    env.link(join(env.proj, 'l3'), join(env.proj, 'l2'));
    env.link('l2', join(env.proj, 'l1'));
    env.link(outside, join(env.proj, 'parent'));
    const p = env.files.policy;
    expect(refusedWith(await p.openForRead('r.proj', 'etclink/hosts'))).toBe('outside');
    expect(refusedWith(await p.openForRead('r.proj', 'l1'))).toBe('outside');
    expect(refusedWith(await p.openForRead('r.proj', 'parent/secret.txt'))).toBe('outside');
    expect(refusedWith(await p.openDir('r.proj', 'parent'))).toBe('outside');
    expect(refusedWith(await p.resolveDir('r.proj', 'parent'))).toBe('outside');
  });

  it('a missing path behind a link out of the root is outside, as an existing one is: no test of what exists there', async () => {
    env = fpEnv();
    const outside = join(env.base, 'outside');
    env.write(join(outside, 'real.txt'), 'x');
    env.link(outside, join(env.proj, 'out'));
    const p = env.files.policy;
    for (const rel of ['out/real.txt', 'out/nope.txt', 'out/a/b/nope.txt']) expect(refusedWith(await p.openForRead('r.proj', rel)), rel).toBe('outside');
    expect(refusedWith(await p.openDir('r.proj', 'out/nope'))).toBe('outside');
    expect(refusedWith(await p.resolveDir('r.proj', 'out/nope'))).toBe('outside');
    expect(refusedWith(await env.files.stat({ root: 'r.proj', path: 'out/nope.txt' }, PHONE))).toBe('outside');
    // Inside the root a missing path is still missing.
    for (const rel of ['src/nope.ts', 'nope/deeper.ts', 'README.md/x']) expect(refusedWith(await p.openForRead('r.proj', rel)), rel).toBe('missing');
    expect(refusedWith(await p.resolveDir('r.proj', 'src/nope'))).toBe('missing');
  });

  it('a missing name behind a link into a protected dir is protected, as an existing name there is', async () => {
    env = fpEnv({ homeRoot: true, folders: { allow: ['~/.config/nvim'] } });
    env.link(join(env.home, '.ssh'), join(env.proj, 'sshlink'));
    env.link(join(env.home, '.config'), join(env.proj, 'cfg'));
    const p = env.files.policy;
    for (const rel of ['sshlink/config', 'sshlink/nope', 'cfg/other/token', 'cfg/nope', 'cfg/nope/deeper']) {
      expect(refusedWith(await p.openForRead('r.home', `work/proj/${rel}`)), rel).toBe('protected');
    }
    expect(refusedWith(await p.openDir('r.home', 'work/proj/cfg/nope'))).toBe('protected');
    // The allowed path is judged as it would be if it existed.
    expect(refusedWith(await p.openForRead('r.home', 'work/proj/cfg/nvim/nope.lua'))).toBe('missing');
  });

  it('a link that stays inside the root opens its target', async () => {
    env = fpEnv();
    env.link('src/app.ts', join(env.proj, 'inlink.ts'));
    const f = await opened(env.files.policy.openForRead('r.proj', 'inlink.ts'));
    expect(f.real).toBe(join(env.proj, 'src/app.ts'));
    await f.fh.close();
  });

  it('a link to a protected file inside the root is refused on its realpath', async () => {
    env = fpEnv();
    env.link('.env', join(env.proj, 'settings.txt'));
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'settings.txt'))).toBe('protected');
  });

  it('a broken link shows as broken and cannot be opened; links say where they lead', async () => {
    env = fpEnv();
    env.link('does-not-exist', join(env.proj, 'broken'));
    env.link(join(env.home, 'notes.md'), join(env.proj, 'notelink'));
    env.link('src', join(env.proj, 'srclink'));
    env.link('/etc', join(env.proj, 'etclink'));
    env.link('.env', join(env.proj, 'envlink'));
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'broken'))).toBe('missing');
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'notelink'))).toBe('outside');
    const plain = await env.files.policy.openDir('r.proj', '', { hidden: true });
    if (isRefusal(plain)) throw new Error(plain.refused);
    const links = Object.fromEntries(plain.entries.filter((e) => e.type === 'link').map((e) => [e.name, e.link]));
    expect(links).toEqual({ broken: 'broken', notelink: 'outside', srclink: 'inside' });
    // Links to protected targets (/etc, .env) are hidden and counted with the protected entries.
    expect(plain.entries.find((e) => e.name === 'etclink' || e.name === 'envlink')).toBeUndefined();
    // 27 secrets at the top of the project (.env x3, .envrc, .npmrc, .git, server.pem, id_ed25519.pub,
    // client_secret, service-account, credentials.json, vault.kdbx, and the 15 added after review,
    // .env-local to serviceAccountKey.json) plus the two links.
    expect(plain.hiddenProtected).toBe(29);
  });
});

describe('F4: the swap race', () => {
  it('a file replaced by a symlink between realpath and open is refused (O_NOFOLLOW gives ELOOP)', async () => {
    env = fpEnv();
    const target = env.write(join(env.proj, 'race.txt'), 'harmless');
    const outside = env.write(join(env.base, 'outside/secret.txt'), SECRET_MARKER);
    const real = fsx.realpath.bind(fsx);
    vi.spyOn(fsx, 'realpath').mockImplementation(async (p: string) => {
      const r = await real(p);
      if (r === target) {
        rmSync(target);
        symlinkSync(outside, target);
      }
      return r;
    });
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'race.txt'))).toBe('outside');
  });

  it('a file renamed over between open and the inode check is refused, and its handle closed', async () => {
    env = fpEnv();
    const target = env.write(join(env.proj, 'race.txt'), 'first');
    const other = env.write(join(env.proj, 'other.txt'), 'second');
    const open = fsx.openNoFollow.bind(fsx);
    const closed: boolean[] = [];
    vi.spyOn(fsx, 'openNoFollow').mockImplementation(async (p: string) => {
      const fh = await open(p);
      const close = fh.close.bind(fh);
      fh.close = async () => {
        closed.push(true);
        await close();
      };
      if (p === target) renameSync(other, target);
      return fh;
    });
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'race.txt'))).toBe('outside');
    expect(closed).toEqual([true]);
  });

  it('a dir swapped for a link while it is listed is refused', async () => {
    env = fpEnv();
    const dir = join(env.proj, 'src');
    const outside = join(env.base, 'outside');
    env.write(join(outside, 'x.txt'), SECRET_MARKER);
    const opendir = fsx.opendir.bind(fsx);
    vi.spyOn(fsx, 'opendir').mockImplementation(async (p: string) => {
      const d = await opendir(p);
      if (p === dir) {
        renameSync(dir, join(env.proj, 'src-moved'));
        symlinkSync(outside, dir);
      }
      return d;
    });
    expect(refusedWith(await env.files.policy.openDir('r.proj', 'src'))).toBe('outside');
  });
});

describe('F5: FIFOs and devices never hang the daemon', () => {
  it('a FIFO returns at once with not_file', { timeout: perfBudgetMs(2000) }, async () => {
    env = fpEnv();
    const fifo = join(env.proj, 'pipe');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const t0 = Date.now();
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'pipe'))).toBe('not_file');
    expect(refusedWith(await env.files.text({ root: 'r.proj', path: 'pipe', offset: 0, max: 1024 }, { kind: 'cli' }))).toBe('not_file');
    expect(refusedWith(await env.files.raw({ root: 'r.proj', path: 'pipe' }, { kind: 'cli' }))).toBe('not_file');
    expect(refusedWith(await env.files.stat({ root: 'r.proj', path: 'pipe' }, { kind: 'cli' }))).toBe('not_file');
    expect(Date.now() - t0).toBeLessThan(perfBudgetMs(1000));
    const dir = await env.files.policy.openDir('r.proj', '');
    if (isRefusal(dir)) throw new Error(dir.refused);
    expect(dir.entries.find((e) => e.name === 'pipe')?.type).toBe('other');
  });

  it('a link to /dev/zero is refused', { timeout: perfBudgetMs(2000) }, async () => {
    env = fpEnv();
    env.link('/dev/zero', join(env.proj, 'zero'));
    env.link('/dev/random', join(env.proj, 'random.txt'));
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'zero'))).toBe('outside');
    expect(refusedWith(await env.files.text({ root: 'r.proj', path: 'random.txt', offset: 0, max: 1024 }, { kind: 'cli' }))).toBe('outside');
  });
});

describe('F6: home mode (a root that is $HOME)', () => {
  const HIDDEN_IN_HOME = ['Library', '.ssh', '.config', '.zsh_history', '.claude.json', '.claude', '.claude-swap-backup', '.example-tool', '.jantar', '.netrc', '.aws', '.gnupg', '.bash_history'];

  it('Library, .ssh, .config, .zsh_history and .claude.json are hidden in listings (even with hidden=1) and refused when opened', async () => {
    env = fpEnv({ homeRoot: true });
    const p = env.files.policy;
    const root = await p.root('r.home');
    expect(root?.home).toBe(true);
    expect(root?.display).toBe('~');
    const dir = await p.openDir('r.home', '', { hidden: true });
    if (isRefusal(dir)) throw new Error(dir.refused);
    const names = dir.entries.map((e) => e.name);
    for (const n of HIDDEN_IN_HOME) expect(names, n).not.toContain(n);
    expect(names).toEqual(['Desktop', 'work', 'notes.md']);
    expect(dir.hiddenProtected).toBe(HIDDEN_IN_HOME.length);
    for (const rel of ['Library/Application Support/x.txt', '.ssh/config', '.config/nvim/init.lua', '.config/other/token', '.zsh_history', '.claude.json', '.claude/settings.json', '.jantar/cf-token']) {
      expect(refusedWith(await p.openForRead('r.home', rel)), rel).toBe('protected');
    }
    for (const rel of ['Library', '.config', '.ssh']) expect(refusedWith(await p.openDir('r.home', rel)), rel).toBe('protected');
    expect(await readAll(await opened(p.openForRead('r.home', 'notes.md')))).toBe('# Notes\n');
  });

  it('folders.allow exposes only the named path', async () => {
    env = fpEnv({ homeRoot: true, folders: { allow: ['~/.config/nvim'] } });
    const p = env.files.policy;
    expect(await readAll(await opened(p.openForRead('r.home', '.config/nvim/init.lua')))).toBe('set number\n');
    expect(refusedWith(await p.openForRead('r.home', '.config/other/token'))).toBe('protected');
    // $HOME lists .config (on the way to nvim) only with hidden=1; .config lists nvim alone.
    const home = await p.openDir('r.home', '', { hidden: true });
    if (isRefusal(home)) throw new Error(home.refused);
    expect(home.entries.map((e) => e.name)).toEqual(['.config', 'Desktop', 'work', 'notes.md']);
    const config = await p.openDir('r.home', '.config', { hidden: true });
    if (isRefusal(config)) throw new Error(config.refused);
    expect(config.entries.map((e) => e.name)).toEqual(['nvim']);
    expect(config.hiddenProtected).toBe(5); // ccw, gcloud, gh, op, other
    // A way to the allowed path is not a folder to start a session in.
    expect(refusedWith(await p.resolveDir('r.home', '.config'))).toBe('protected');
    expect(isRefusal(await p.resolveDir('r.home', '.config/nvim'))).toBe(false);
  });

  it('stat answers a dir on the way to a folders.allow entry as a folder, as the listing shows it, with no denied row', async () => {
    env = fpEnv({ homeRoot: true, folders: { allow: ['~/.config/nvim', '~/.vimfile/x'] } });
    env.write(join(env.home, '.vimfile'), 'not a dir\n');
    const stat = (path: string) => env.files.stat({ root: 'r.home', path }, PHONE);
    // A viewer that stats before it lists: never refused, never counted toward the probe alarm.
    for (let i = 0; i < 6; i++) expect(await stat('.config')).toMatchObject({ type: 'dir' });
    expect(await stat('.config/nvim')).toMatchObject({ type: 'dir' });
    expect(env.ctx.db.audit.list({ limit: 100 }).filter((r) => r.action === 'files.denied')).toEqual([]);
    expect(env.pushed).toHaveLength(0);
    // Only the way there: the rest of the dir, the dir read as a file, a file on the way, and a folder to start in stay protected.
    expect(refusedWith(await stat('.config/other'))).toBe('protected');
    expect(refusedWith(await stat('.config/other/token'))).toBe('protected');
    expect(refusedWith(await stat('.vimfile'))).toBe('protected');
    expect(refusedWith(await env.files.text({ root: 'r.home', path: '.config', offset: 0, max: 1024 }, PHONE))).toBe('protected');
    expect(refusedWith(await env.files.policy.resolveDir('r.home', '.config'))).toBe('protected');
  });

  it('a home dot dir cannot be reached from another root either', async () => {
    env = fpEnv();
    env.link(join(env.home, '.config/nvim'), join(env.proj, 'nvim'));
    expect(refusedWith(await env.files.policy.openForRead('r.proj', 'nvim/init.lua'))).toBe('outside');
  });
});

describe('directories', () => {
  it('resolveDir checks a folder without listing it, and refuses files and protected dirs', async () => {
    env = fpEnv();
    const d = await env.files.policy.resolveDir('r.proj', 'src');
    expect(d).toEqual({ real: join(env.proj, 'src'), rel: 'src', root: expect.objectContaining({ id: 'r.proj' }), display: '~/work/proj/src' });
    expect(await env.files.policy.resolveDir('r.proj', '')).toMatchObject({ rel: '', display: '~/work/proj' });
    expect(refusedWith(await env.files.policy.resolveDir('r.proj', 'README.md'))).toBe('not_dir');
    expect(refusedWith(await env.files.policy.resolveDir('r.proj', '.git'))).toBe('protected');
    expect(refusedWith(await env.files.policy.resolveDir('r.proj', 'nope'))).toBe('missing');
  });

  it('resolveDir re-run after the folder was swapped for a link to ~ is refused', async () => {
    env = fpEnv();
    mkdirSync(join(env.proj, 'app'));
    expect(isRefusal(await env.files.policy.resolveDir('r.proj', 'app'))).toBe(false);
    rmSync(join(env.proj, 'app'), { recursive: true });
    symlinkSync(env.home, join(env.proj, 'app'));
    expect(refusedWith(await env.files.policy.resolveDir('r.proj', 'app'))).toBe('outside');
  });
});

describe('locate (changes rows link to the viewer with it)', () => {
  it('finds the deepest root holding a path, and its relative path', async () => {
    env = fpEnv({ folders: { roots: [
      { id: 'work', path: '~/work', label: 'work' },
      { id: 'proj', path: '~/work/proj', label: 'proj' },
    ] } });
    expect(await env.files.policy.locate(join(env.proj, 'src/app.ts'))).toEqual({ rootId: 'r.proj', rel: 'src/app.ts' });
    env.write(join(env.home, 'work/other.txt'), 'x');
    expect(await env.files.policy.locate(join(env.home, 'work/other.txt'))).toEqual({ rootId: 'r.work', rel: 'other.txt' });
    expect(await env.files.policy.locate(env.proj)).toEqual({ rootId: 'r.proj', rel: '' });
  });

  it('refuses protected, outside, missing and relative paths', async () => {
    env = fpEnv();
    const p = env.files.policy;
    expect(refusedWith(await p.locate(join(env.proj, '.env')))).toBe('protected');
    expect(refusedWith(await p.locate(join(env.proj, 'src/../.env')))).toBe('protected');
    expect(refusedWith(await p.locate(join(env.home, '.ssh/id_rsa')))).toBe('protected');
    expect(refusedWith(await p.locate(join(env.home, 'notes.md')))).toBe('outside');
    expect(refusedWith(await p.locate(join(env.proj, 'gone.ts')))).toBe('missing');
    expect(refusedWith(await p.locate('src/app.ts'))).toBe('bad_path');
    env.link(join(env.home, '.ssh/config'), join(env.proj, 'cfg'));
    expect(refusedWith(await p.locate(join(env.proj, 'cfg')))).toBe('protected');
  });

  it('a path outside every root is outside, missing or not, and the disk is never asked about it (no macOS privacy prompt)', async () => {
    env = fpEnv();
    const p = env.files.policy;
    await p.roots(); // the roots' own realpaths, cached
    const touched: string[] = [];
    for (const op of ['realpath', 'lstat', 'stat', 'open', 'openNoFollow', 'opendir'] as const) {
      const orig = (fsx[op] as (x: string) => Promise<unknown>).bind(fsx);
      vi.spyOn(fsx, op).mockImplementation(((x: string, ...rest: unknown[]) => {
        touched.push(String(x));
        return (orig as (...a: unknown[]) => Promise<unknown>)(x, ...rest);
      }) as never);
    }
    const documents = join(env.home, 'Documents', 'plan.md');
    for (const abs of [join(env.home, 'notes.md'), documents, join(env.home, 'work', 'other', 'gone.ts')]) {
      expect(await p.underRoot(abs), abs).toBe(false);
      expect(refusedWith(await p.locate(abs)), abs).toBe('outside');
    }
    // the denylist still names what it protects, outside the roots too
    expect(refusedWith(await p.locate(join(env.home, '.ssh', 'id_rsa')))).toBe('protected');
    expect(touched.filter((x) => !x.startsWith(env.proj) && !x.startsWith(env.desktop))).toEqual([]);
    // inside a root: resolved and judged as before (missing is only ever said there)
    expect(refusedWith(await p.locate(join(env.proj, 'gone.ts')))).toBe('missing');
    expect(touched).toContain(join(env.proj, 'gone.ts'));
    vi.restoreAllMocks();
  });

  it('underRoot: by a root realpath or the name it was given, case folded; a link out of a root is outside', async () => {
    env = fpEnv();
    // a root configured through a symlink: ~/code -> ~/work/proj
    env.link(env.proj, join(env.home, 'code'));
    await env.setFolders({ roots: [{ id: 'code', path: '~/code', label: 'code' }] });
    const p = env.files.policy;
    expect(await p.underRoot(join(env.proj, 'src', 'app.ts'))).toBe(true);
    expect(await p.underRoot(join(env.home, 'code', 'src', 'app.ts'))).toBe(true);
    expect(await p.underRoot(join(env.home, 'CODE', 'Src', 'app.ts'))).toBe(true);
    expect(await p.underRoot(join(env.home, 'codex', 'app.ts'))).toBe(false);
    expect(await p.underRoot('src/app.ts')).toBe(false);
    expect(await p.locate(join(env.home, 'code', 'src', 'app.ts'))).toEqual({ rootId: 'r.code', rel: 'src/app.ts' });
    // under a root by name, but its realpath leaves it
    env.link(join(env.home, 'notes.md'), join(env.proj, 'notes-link.md'));
    expect(await p.underRoot(join(env.proj, 'notes-link.md'))).toBe(true);
    expect(refusedWith(await p.locate(join(env.proj, 'notes-link.md')))).toBe('outside');
  });

  it.runIf(process.platform === 'darwin')('underRoot: /tmp, /var and /etc match a root by their /private spelling', async () => {
    env = fpEnv();
    const p = env.files.policy;
    expect(env.proj.startsWith('/private/var/')).toBe(true); // the temp tree is realpath'd
    expect(await p.underRoot(join(env.proj.slice('/private'.length), 'src', 'app.ts'))).toBe(true);
    expect(await p.underRoot(join(env.proj, 'src', 'app.ts'))).toBe(true);
  });

  it('a session root locates its files when no configured root holds them', async () => {
    env = fpEnv();
    const cwd = join(env.home, 'work/side');
    env.write(join(cwd, 'b.ts'), 'x');
    env.addSession({ sid: 'sess-side', cwd });
    expect(await env.files.policy.locate(join(cwd, 'b.ts'))).toEqual({ rootId: 's.sess-side', rel: 'b.ts' });
  });
});

describe('isProtected', () => {
  it('judges absolute paths by name and prefix without the disk', () => {
    env = fpEnv();
    const p = env.files.policy;
    const stat = vi.spyOn(fsx, 'stat');
    const realpath = vi.spyOn(fsx, 'realpath');
    expect(p.isProtected(join(env.proj, '.env'))).toBe(true);
    expect(p.isProtected(join(env.proj, 'src/app.ts'))).toBe(false);
    expect(p.isProtected(join(env.home, '.claude/settings.json'))).toBe(true);
    expect(p.isProtected(join(env.home, 'Library/x'))).toBe(true);
    expect(p.isProtected(join(env.home, '.config/nvim/init.lua'))).toBe(true);
    expect(p.isProtected(join(env.proj, 'src/../.git/config'))).toBe(true);
    // APFS opens "id_rſa" (a long s) as the real id_rsa; the lexical check folds it the same way.
    expect(p.isProtected(join(env.proj, 'keys/id_rſa'))).toBe(true);
    expect(p.isProtected('/etc/hosts')).toBe(true);
    expect(p.isProtected('relative/a.ts')).toBe(true);
    expect(stat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it('follows settings: extraDeny and allow apply at once', async () => {
    env = fpEnv();
    const p = env.files.policy;
    expect(p.isProtected(join(env.proj, 'data.sqlite'))).toBe(false);
    await env.setFolders({ extraDeny: ['*.sqlite'], allow: ['~/.config/nvim'] });
    expect(p.isProtected(join(env.proj, 'data.sqlite'))).toBe(true);
    expect(p.isProtected(join(env.home, '.config/nvim/init.lua'))).toBe(false);
  });

  it('an absolute or ~ extraDeny entry given through a symlink matches where it leads too', async () => {
    env = fpEnv({ homeRoot: true });
    env.write(join(env.proj, 'vault/plan.txt'), 'plans\n');
    env.write(join(env.proj, 'vault2/plan.txt'), 'plans\n');
    env.link(join(env.proj, 'vault'), join(env.base, 'vault-link'));
    env.link(join(env.proj, 'vault2'), join(env.home, 'vault2-link'));
    const p = env.files.policy;
    await env.setFolders({ extraDeny: [join(env.base, 'vault-link'), '~/vault2-link'] });
    for (const rel of ['vault/plan.txt', 'vault2/plan.txt']) expect(refusedWith(await p.openForRead('r.proj', rel)), rel).toBe('protected');
    expect(refusedWith(await p.openDir('r.proj', 'vault'))).toBe('protected');
    expect(refusedWith(await p.resolveDir('r.home', 'work/proj/vault2'))).toBe('protected');
    expect(p.isProtected(join(env.proj, 'vault/plan.txt'))).toBe(true);
    expect(p.isProtected(join(env.proj, 'vault2'))).toBe(true);
    const dir = await p.openDir('r.proj', '');
    if (isRefusal(dir)) throw new Error(dir.refused);
    expect(dir.entries.map((e) => e.name)).not.toContain('vault');
    expect(dir.entries.map((e) => e.name)).not.toContain('vault2');
    // The entry as written still matches, and the rest of the project is untouched.
    expect(p.isProtected(join(env.base, 'vault-link/plan.txt'))).toBe(true);
    expect(await readAll(await opened(p.openForRead('r.proj', 'src/app.ts')))).toContain('answer');
  });

  it('an extraDeny link made after the setting is matched within ROOT_CACHE_MS', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'vault/plan.txt'), 'plans\n');
    const p = env.files.policy;
    await env.setFolders({ extraDeny: [join(env.base, 'later-link')] });
    await (await opened(p.openForRead('r.proj', 'vault/plan.txt'))).fh.close();
    env.link(join(env.proj, 'vault'), join(env.base, 'later-link'));
    env.ctx.clock.advance(ROOT_CACHE_MS);
    expect(refusedWith(await p.openForRead('r.proj', 'vault/plan.txt'))).toBe('protected');
  });
});

describe('SECRET_MARKER never comes back from an open', () => {
  it('no handle is ever opened on a secret in the tree', async () => {
    env = fpEnv({ homeRoot: true });
    writeFileSync(join(env.proj, 'ok.txt'), 'fine');
    const opens = vi.spyOn(fsx, 'openNoFollow');
    const p = env.files.policy;
    for (const rel of ['.env', '.env.example', 'keys/id_rsa', '.git/config', 'credentials.json']) await p.openForRead('r.proj', rel);
    for (const rel of ['.ssh/id_rsa', '.aws/credentials', '.claude.json', 'Library/Keychains/login.keychain-db', '.config/ccw/telegram.json']) await p.openForRead('r.home', rel);
    expect(opens).not.toHaveBeenCalled();
  });
});
