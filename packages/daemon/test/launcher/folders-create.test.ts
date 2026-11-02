/**
 * 0.10.1: New folder (Files and the start sheet) against the real path
 * policy, on a synthetic HOME in a temp dir, so symlinks, the denylist and
 * the probe alarm are the real ones. The one write a phone can make in a
 * user folder: one empty folder, never recursive, strictly below a root,
 * never through a link out of it, never with a protected name, never one
 * whose name folds (case, Unicode) onto a sibling's. Races are staged by
 * spying on `dirx`, the write facade, between the checks. Every path is made
 * up; nothing outside the temp dir is touched.
 */
import { lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../src/contracts.js';
import { PROBE_THRESHOLD } from '../../src/files/audit.js';
import { DIR_MAX_SCAN } from '../../src/files/policy.js';
import { Folders, TCC_SENTENCE, mkdirFailure, siblingClash } from '../../src/launcher/folders.js';
import { dirx } from '../../src/launcher/mkdir.js';
import { fpEnv, type FpEnv } from '../files/fp-helpers.js';

const LAUNCHER: Actor = { kind: 'device', deviceId: 'dev-launch', scopes: ['read', 'control', 'launch'] };
const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
const MOVED = 'The folder moved while it was being created';
const CAPITALS = 'names that differ only in capitals count as the same';

let env: FpEnv;
let folders: Folders;
/** Outside every root: where an escape would land. */
let outside: string;

afterEach(() => {
  vi.restoreAllMocks();
  env?.cleanup();
});

async function setup(opts: Parameters<typeof fpEnv>[0] = {}, perHour = 1000): Promise<void> {
  env = fpEnv(opts);
  outside = join(env.base, 'outside');
  mkdirSync(outside);
  await env.ctx.settings.patch({ launch: { rate: { foldersPerHour: perHour } } });
  folders = new Folders(env.ctx, () => env.files.policy, (actor, root, rel, r) => env.files.denied(actor, root, rel, r.refused));
}

const create = (parent: string, name: string, actor: Actor = LAUNCHER, root = 'r.desktop') => folders.create({ root, parent, name }, actor);

/** Every path under the temp dir, to prove a refusal made nothing anywhere. */
function tree(): string[] {
  return (readdirSync(env.base, { recursive: true }) as string[]).sort();
}

const rows = (action: string) => env.ctx.db.audit.list({ limit: 1000 }).filter((a) => a.action === action);
const isDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

describe('the parent cannot escape its root', () => {
  it("'' is the root itself: the new folder is root/name", async () => {
    await setup();
    expect(await create('', 'x')).toEqual({ ok: true, created: { root: 'r.desktop', path: 'x' } });
    expect(isDir(join(env.desktop, 'x'))).toBe(true);
  });

  it('a parent that is not a clean relative path is 400 and nothing is made anywhere', async () => {
    await setup();
    mkdirSync(join(env.desktop, 'a', 'b'), { recursive: true });
    const before = tree();
    for (const parent of ['../', '..', 'a/../..', '/abs', 'a//b', 'a\\b', 'a/./b', 'a\u0000b', 'a\nb', 'a/'.repeat(512) + 'b']) {
      expect(await create(parent, 'x'), JSON.stringify(parent.slice(0, 20))).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(tree()).toEqual(before);
  });

  it('a link out of the root is 403, audited as outside; nothing is made at its target', async () => {
    await setup();
    symlinkSync(outside, join(env.desktop, 'escape'));
    expect(await create('escape', 'x')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(readdirSync(outside)).toEqual([]);
    expect(rows('files.denied').map((r) => r.params)).toEqual([{ root: 'r.desktop', rel: 'escape', reason: 'outside' }]);
  });

  it('a link that stays inside the root is followed: the folder is made at its real target', async () => {
    await setup();
    mkdirSync(join(env.desktop, 'real-inner'));
    symlinkSync(join(env.desktop, 'real-inner'), join(env.desktop, 'inner'));
    expect(await create('inner', 'x')).toEqual({ ok: true, created: { root: 'r.desktop', path: 'inner/x' } });
    expect(isDir(join(env.desktop, 'real-inner', 'x'))).toBe(true);
  });

  it('a symlink loop is 403 and makes nothing', async () => {
    await setup();
    symlinkSync(join(env.desktop, 'loop'), join(env.desktop, 'loop'));
    const before = tree();
    expect(await create('loop', 'x')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(tree()).toEqual(before);
  });

  it('a protected parent is 403 and audited as protected: .ssh anywhere, ~/Library in a home root', async () => {
    await setup({ homeRoot: true });
    mkdirSync(join(env.desktop, '.ssh'));
    expect(await create('.ssh', 'x')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await create('Library', 'x', LAUNCHER, 'r.home')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await create('.config/gh', 'x', LAUNCHER, 'r.home')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(isDir(join(env.desktop, '.ssh', 'x'))).toBe(false);
    expect(isDir(join(env.home, 'Library', 'x'))).toBe(false);
    expect(rows('files.denied').map((r) => (r.params as { reason: string }).reason)).toEqual(['protected', 'protected', 'protected']);
  });

  it('a file as the parent is 400; a missing parent and an unknown root are 404', async () => {
    await setup();
    expect(await create('todo.txt', 'x')).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await create('nope', 'x')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await create('', 'x', LAUNCHER, 'r.nope')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await create('', 'x', LAUNCHER, 's.ended-session')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('never recursive: a missing parent two deep makes neither', async () => {
    await setup();
    expect(await create('a/b', 'x')).toMatchObject({ ok: false, code: 'not_found' });
    expect(exists(join(env.desktop, 'a'))).toBe(false);
  });
});

describe('the name', () => {
  it('one plain segment: dots, slashes, a leading dash or underscore and a trailing space or dot are 400', async () => {
    await setup();
    const before = tree();
    for (const bad of ['.', '..', '', '.hidden', 'a/b', 'a\\b', '../x', '/x', 'x/', 'trailing ', 'trailing.', '-dash', '_lead']) {
      expect(await create('', bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(tree()).toEqual(before);
  });

  it('control characters are 400', async () => {
    await setup();
    for (const bad of ['nul\u0000', 'tab\t', 'nl\n', 'del\u007f', 'nel\u0085', 'cr\rx']) {
      expect(await create('', bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
  });

  it('ASCII only: NFC and NFD accents, fullwidth, bidi overrides, zero-width, emoji and Cyrillic look-alikes are 400 with the allowed characters named', async () => {
    await setup();
    const before = tree();
    for (const bad of ['café', 'café', 'ｐｒｏｊｅｃｔ', '‮evil', 'a​b', '\u{1f680}app', 'аpp']) {
      const r = await create('', bad);
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(!r.ok && r.reason).toMatch(/letters A to Z, digits, spaces, dots, dashes and underscores/);
    }
    expect(tree()).toEqual(before);
  });

  it('at most 60 characters', async () => {
    await setup();
    expect((await create('', 'a'.repeat(60))).ok).toBe(true);
    expect(await create('', 'b'.repeat(61))).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('a protected name is 403 and counts toward the probe alarm (5 in 10 min: one security push)', async () => {
    await setup();
    env.ctx.db.devices.insert({ id: 'dev-launch', name: 'Sam’s iPhone', keyHash: 'k', scopes: ['read', 'control', 'launch'], createdAt: env.ctx.clock.iso(), lastSeenAt: env.ctx.clock.iso() });
    const names = ['id_rsa', 'credentials', 'secrets.json', 'kubeconfig', 'ID_RSA'];
    expect(names).toHaveLength(PROBE_THRESHOLD);
    for (const name of names) {
      expect(await create('', name)).toEqual({ ok: false, code: 'forbidden', reason: 'That name is on the protected list' });
      expect(exists(join(env.desktop, name))).toBe(false);
    }
    expect(rows('files.denied').map((r) => r.params)).toEqual(names.map((n) => ({ root: 'r.desktop', rel: n, reason: 'protected' })));
    expect(env.pushed).toHaveLength(1);
    expect(env.pushed[0]).toMatchObject({ kind: 'security', tag: 'security:dev-launch' });
    expect(rows('files.alert')).toHaveLength(1);
  });

  it('a protected name below a protected-by-name rule is refused in every letter case (the denylist folds)', async () => {
    await setup({ homeRoot: true });
    expect(await create('', 'library', LAUNCHER, 'r.home')).toMatchObject({ ok: false, code: 'forbidden', reason: 'That name is on the protected list' });
    expect(await create('', 'Kubeconfig')).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('the name is already taken', () => {
  it('a folder or a file of that exact name is 409, named by what it is', async () => {
    await setup();
    mkdirSync(join(env.desktop, 'taken'));
    writeFileSync(join(env.desktop, 'file'), '');
    expect(await create('', 'taken')).toEqual({ ok: false, code: 'conflict', reason: 'A folder named taken already exists here' });
    expect(await create('', 'file')).toEqual({ ok: false, code: 'conflict', reason: 'A file named file already exists here' });
  });

  it('a link of that name, even a dangling one, is 409 and nothing is made at its target', async () => {
    await setup();
    symlinkSync(join(outside, 'ghost'), join(env.desktop, 'ghost'));
    mkdirSync(join(outside, 'dir'));
    symlinkSync(join(outside, 'dir'), join(env.desktop, 'out'));
    expect(await create('', 'ghost')).toEqual({ ok: false, code: 'conflict', reason: 'Something named ghost already exists here' });
    expect(await create('', 'out')).toMatchObject({ ok: false, code: 'conflict' });
    expect(readdirSync(outside)).toEqual(['dir']);
    expect(readdirSync(join(outside, 'dir'))).toEqual([]);
  });

  it('a name that differs only in case is 409 naming what is there, on every volume (the pre-check decides)', async () => {
    await setup();
    mkdirSync(join(env.desktop, 'Project'));
    writeFileSync(join(env.desktop, 'README'), '');
    expect(await create('', 'project')).toEqual({ ok: false, code: 'conflict', reason: `A folder named Project already exists here; ${CAPITALS}` });
    expect(await create('', 'readme')).toEqual({ ok: false, code: 'conflict', reason: `A file named README already exists here; ${CAPITALS}` });
    expect(readdirSync(env.desktop).sort()).toEqual(['Project', 'README', 'todo.txt']);
  });

  it('siblingClash folds the way the denylist does (KELVIN SIGN is K) and skips protected entries', async () => {
    await setup();
    const dir = join(env.desktop, 'fold');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Keys'), '');
    mkdirSync(join(dir, 'Notes'));
    const policy = env.files.policy;
    expect(await siblingClash(dir, 'keys', policy)).toEqual({ name: 'Keys', type: 'file' });
    expect(await siblingClash(dir, 'NOTES', policy)).toEqual({ name: 'Notes', type: 'dir' });
    expect(await siblingClash(dir, 'other', policy)).toBeNull();
    expect(await create('fold', 'keys')).toMatchObject({ ok: false, code: 'conflict' });
    // A protected entry is never named back, even if a name folded onto it.
    writeFileSync(join(dir, 'kubeconfig'), '');
    expect(await siblingClash(dir, 'KUBECONFIG', policy)).toBeNull();
  });

  it(`more than ${DIR_MAX_SCAN} entries: the scan stops there and a free name is still made`, async () => {
    await setup();
    const dir = join(env.desktop, 'big');
    mkdirSync(dir);
    for (let i = 0; i <= DIR_MAX_SCAN; i++) writeFileSync(join(dir, `f${i}`), '');
    const spy = vi.spyOn(dirx, 'opendir');
    expect(await create('big', 'fresh')).toEqual({ ok: true, created: { root: 'r.desktop', path: 'big/fresh' } });
    expect(spy).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe('mode, scope and limits', () => {
  it('0755 at most (the umask applies), owner rwx; never chmod-widened', async () => {
    await setup();
    expect((await create('', 'mode-check')).ok).toBe(true);
    const st = await stat(join(env.desktop, 'mode-check'));
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o022).toBe(0);
    expect(st.mode & 0o700).toBe(0o700);
  });

  it('only the CLI or a device with launch: a control device, the system and the extension are refused', async () => {
    await setup();
    for (const actor of [PHONE, { kind: 'system' } as Actor, { kind: 'extension', extensionId: 'x' } as Actor]) {
      expect(await create('', 'nope', actor)).toMatchObject({ ok: false, code: 'forbidden', reason: expect.stringMatching(/jantar devices grant <device> launch/) });
    }
    expect(exists(join(env.desktop, 'nope'))).toBe(false);
    expect(await create('', 'from-cli', { kind: 'cli' })).toEqual({ ok: true, created: { root: 'r.desktop', path: 'from-cli' } });
  });

  it('launch.rate.foldersPerHour per actor; a 409 caught before mkdir is not charged', async () => {
    await setup({}, 3);
    expect((await create('', 'f0')).ok).toBe(true);
    expect(await create('', 'F0')).toMatchObject({ ok: false, code: 'conflict' });
    expect(await create('', 'f0')).toMatchObject({ ok: false, code: 'conflict' });
    expect((await create('', 'f1')).ok).toBe(true);
    expect((await create('', 'f2')).ok).toBe(true);
    expect(await create('', 'f3')).toMatchObject({ ok: false, code: 'rate_limited', retryAfterMs: expect.any(Number) });
    expect((await create('', 'f3', { kind: 'cli' })).ok).toBe(true);
  });

  it('requests sent at once cannot spend more than foldersPerHour: 10 parallel names with a budget of 3 make 3', async () => {
    await setup({}, 3);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => create('', `p${i}`)));
    expect(rs.filter((r) => r.ok)).toHaveLength(3);
    for (const r of rs.filter((x) => !x.ok)) expect(r).toMatchObject({ ok: false, code: 'rate_limited', retryAfterMs: expect.any(Number) });
    expect(readdirSync(env.desktop).filter((n) => /^p\d$/.test(n))).toHaveLength(3);
    // Another actor's budget is its own.
    expect((await create('', 'p-cli', { kind: 'cli' })).ok).toBe(true);
  });

  it('the 429 names the wait: minutes until the oldest folder of the hour drops out', async () => {
    await setup({}, 1);
    expect((await create('', 'w0')).ok).toBe(true);
    const r = await create('', 'w1');
    expect(r).toMatchObject({ ok: false, code: 'rate_limited', reason: 'At most 1 new folder an hour; try again in 60 minutes' });
  });

  it('a live session’s folder is a root too (s.<sid>)', async () => {
    await setup();
    const s = env.addSession({ sid: 'live-1', cwd: env.proj });
    expect(await create('src', 'feature', LAUNCHER, `s.${s.sid}`)).toEqual({ ok: true, created: { root: 's.live-1', path: 'src/feature' } });
    expect(isDir(join(env.proj, 'src', 'feature'))).toBe(true);
  });
});

describe('races (dirx spied between the checks)', () => {
  it('the parent swapped for a link out of the root before mkdir: 403, the folder made out there is removed, the alarm counts it', async () => {
    await setup();
    mkdirSync(join(env.desktop, 'a'));
    vi.spyOn(dirx, 'mkdirOne').mockImplementationOnce(async (p) => {
      await rename(join(env.desktop, 'a'), join(outside, 'a'));
      await symlink(join(outside, 'a'), join(env.desktop, 'a'));
      await mkdir(p, { mode: 0o755 });
    });
    expect(await create('a', 'x')).toEqual({ ok: false, code: 'forbidden', reason: MOVED });
    expect(exists(join(outside, 'a', 'x'))).toBe(false);
    expect(readdirSync(join(outside, 'a'))).toEqual([]);
    const warn = env.ctx.log.records.filter((r) => r.level === 'warn' && /did not land under its root/.test(r.msg));
    expect(warn).toHaveLength(1);
    expect(JSON.stringify(warn)).not.toContain(env.base);
    expect(rows('files.denied').map((r) => r.params)).toEqual([{ root: 'r.desktop', rel: 'a/x', reason: 'outside' }]);
  });

  it('an ancestor swapped (the parent keeps its inode): the realpath check catches it and removes the empty folder', async () => {
    await setup();
    mkdirSync(join(env.desktop, 'a', 'b'), { recursive: true });
    vi.spyOn(dirx, 'mkdirOne').mockImplementationOnce(async (p) => {
      await rename(join(env.desktop, 'a'), join(outside, 'a'));
      await symlink(join(outside, 'a'), join(env.desktop, 'a'));
      await mkdir(p, { mode: 0o755 });
    });
    expect(await create('a/b', 'x')).toEqual({ ok: false, code: 'forbidden', reason: MOVED });
    expect(readdirSync(join(outside, 'a', 'b'))).toEqual([]);
  });

  it('the parent swapped while its names were read: refused before mkdir, nothing made', async () => {
    await setup();
    mkdirSync(join(env.desktop, 'a'));
    const real = dirx.opendir.bind(dirx);
    vi.spyOn(dirx, 'opendir').mockImplementationOnce(async (p) => {
      const d = await real(p);
      await rename(join(env.desktop, 'a'), join(outside, 'a'));
      await symlink(join(outside, 'a'), join(env.desktop, 'a'));
      return d;
    });
    const made = vi.spyOn(dirx, 'mkdirOne');
    expect(await create('a', 'x')).toEqual({ ok: false, code: 'forbidden', reason: MOVED });
    expect(made).not.toHaveBeenCalled();
    expect(readdirSync(join(outside, 'a'))).toEqual([]);
  });

  it('the new folder replaced by another one before the rollback: that one is not ours and is left alone', async () => {
    await setup();
    const target = join(env.desktop, 'x');
    let theirs = -1n;
    vi.spyOn(dirx, 'realpath').mockImplementationOnce(async () => {
      // Made before ours goes, so it can never reuse our inode number.
      await mkdir(join(env.desktop, 'other'));
      await rmdir(target);
      await rename(join(env.desktop, 'other'), target);
      theirs = lstatSync(target, { bigint: true }).ino;
      return join(outside, 'x');
    });
    expect(await create('', 'x')).toEqual({ ok: false, code: 'forbidden', reason: MOVED });
    expect(isDir(target)).toBe(true);
    expect(lstatSync(target, { bigint: true }).ino).toBe(theirs);
  });

  it('the new folder swapped for a link: O_NOFOLLOW refuses it and the rollback never follows the link', async () => {
    await setup();
    mkdirSync(join(outside, 'decoy'));
    vi.spyOn(dirx, 'mkdirOne').mockImplementationOnce(async (p) => {
      await mkdir(p, { mode: 0o755 });
      await rename(p, join(outside, 'moved'));
      await symlink(join(outside, 'decoy'), p);
    });
    expect(await create('', 'x')).toEqual({ ok: false, code: 'forbidden', reason: MOVED });
    expect(lstatSync(join(env.desktop, 'x')).isSymbolicLink()).toBe(true);
    expect(isDir(join(outside, 'decoy'))).toBe(true);
  });

  it('created between the pre-check and mkdir: EEXIST is still a 409 with the right wording', async () => {
    await setup();
    vi.spyOn(dirx, 'mkdirOne').mockImplementationOnce(async (p) => {
      await writeFile(p, 'raced');
      await mkdir(p, { mode: 0o755 });
    });
    expect(await create('', 'late')).toEqual({ ok: false, code: 'conflict', reason: 'A file named late already exists here' });
  });
});

describe('mkdirFailure: errno to a sentence', () => {
  const err = (code: string) => Object.assign(new Error('synthetic'), { code });
  it.each([
    ['EEXIST', undefined, 'conflict', 'A folder named x already exists here'],
    ['EEXIST', 'dir', 'conflict', 'A folder named x already exists here'],
    ['EEXIST', 'file', 'conflict', 'A file named x already exists here'],
    ['EEXIST', 'link', 'conflict', 'Something named x already exists here'],
    ['EPERM', undefined, 'forbidden', TCC_SENTENCE],
    ['EACCES', undefined, 'forbidden', 'macOS refused to create a folder here (permission denied)'],
    ['ENOENT', undefined, 'not_found', 'The parent folder is gone'],
    ['ENOTDIR', undefined, 'not_found', 'The parent folder is gone'],
    ['ENOSPC', undefined, 'unavailable', 'The disk is full'],
    ['EIO', undefined, 'unavailable', 'The folder could not be created'],
  ] as const)('%s (%s) is %s', (code, kind, expected, reason) => {
    expect(mkdirFailure(err(code), 'x', kind)).toEqual({ ok: false, code: expected, reason });
  });
});
