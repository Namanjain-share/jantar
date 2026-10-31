/**
 * The new-session folder browser (spec 4.5.1) and security rule L11: a new
 * folder's name holds the regex (no leading dot, no "/", no trailing space
 * or dot), mkdir is never recursive, and an existing name is a conflict.
 * Everything runs in a temp dir through a fake path policy.
 */
import { chmod, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FoldersListResponseSchema, type FolderEntry } from '@jantar/protocol';
import { FOLDERS_PAGE, PINS_MAX, TCC_SENTENCE, mkdirFailure } from '../../src/launcher/folders.js';
import { T0, advance, device, flush, isDir, makeRig, session, settle, type Rig } from './helpers.js';

let rig: Rig;
afterEach(async () => {
  await rig?.close();
});

const phone = device('dev-phone', ['read', 'control']);
const launcher = device('dev-launch', ['read', 'control', 'launch']);
const admin = device('dev-admin', ['read', 'control', 'launch', 'admin']);

async function names(q: { path?: string; showHidden?: boolean } = {}): Promise<FolderEntry[]> {
  const r = await rig.launcher.folders.list({ root: 'r.work', path: q.path ?? '', showHidden: q.showHidden ?? false }, phone);
  if (!r.ok) throw new Error(r.reason);
  return r.listing.entries;
}

describe('roots', () => {
  it('the policy’s roots; absolute paths only for an admin device or the CLI', async () => {
    rig = await makeRig();
    expect(await rig.launcher.folders.roots(phone)).toEqual([{ id: 'r.work', kind: 'configured', label: 'work', display: '~/work', home: false }]);
    expect((await rig.launcher.folders.roots(admin))[0]?.path).toBe(rig.work);
    expect((await rig.launcher.folders.roots({ kind: 'cli' }))[0]?.path).toBe(rig.work);
  });
});

describe('list', () => {
  it('folders only: no files, no dot dirs, node_modules, .git, dist or build unless showHidden', async () => {
    rig = await makeRig({ folders: ['app', '.cache', 'node_modules', '.git', 'dist', 'build', 'docs'] });
    await writeFile(join(rig.work, 'README.md'), 'not listed');
    expect((await names()).map((e) => e.name)).toEqual(['app', 'docs']);
    expect((await names({ showHidden: true })).map((e) => e.name)).toEqual(['.cache', '.git', 'app', 'build', 'dist', 'docs', 'node_modules']);
  });

  it('git and CLAUDE.md are name checks; links stay only when they stay inside the root', async () => {
    rig = await makeRig({ folders: ['repo/.git', 'notes', 'plain'] });
    await writeFile(join(rig.work, 'notes', 'CLAUDE.md'), 'x');
    await symlink(join(rig.work, 'plain'), join(rig.work, 'plain-link'));
    await symlink(rig.tmp, join(rig.work, 'out-link'));
    const rows = await names();
    expect(rows.map((e) => [e.name, e.git, e.claudeMd, e.link])).toEqual([
      ['notes', false, true, false],
      ['plain', false, false, false],
      ['plain-link', false, false, true],
      ['repo', true, false, false],
    ]);
  });

  it('sorted pinned, live, recent, then name, with the live count and the last account', async () => {
    rig = await makeRig({ folders: ['a-plain', 'b-recent', 'c-live', 'd-pinned'] });
    rig.ctx.store.emit({ type: 'session.added', sid: 'live-1', data: { session: session({ sid: 'live-1', cwd: join(rig.work, 'c-live'), account: 4 }) } });
    rig.ctx.store.emit({ type: 'session.added', sid: 'live-2', data: { session: session({ sid: 'live-2', cwd: join(rig.work, 'c-live'), account: 4 }) } });
    await settle(() => rig.ctx.db.folders.recentSeen(20).length === 1);
    rig.ctx.db.folders.seen({ cwd: join(rig.work, 'b-recent'), lastSeenAt: '2026-01-15T09:00:00.000Z', account: 9, name: 'b' });
    expect((await rig.launcher.folders.pin({ root: 'r.work', path: 'd-pinned', pinned: true }, phone)).ok).toBe(true);
    await flush();
    const rows = await names();
    expect(rows.map((e) => e.name)).toEqual(['d-pinned', 'c-live', 'b-recent', 'a-plain']);
    expect(rows.find((e) => e.name === 'c-live')).toMatchObject({ live: 2, lastAccount: 4 });
    expect(rows.find((e) => e.name === 'b-recent')).toMatchObject({ live: 0, lastAccount: 9, lastUsed: '2026-01-15T09:00:00.000Z' });
    expect(rows.find((e) => e.name === 'd-pinned')?.pinned).toBe(true);
  });

  it('a listing says where it is', async () => {
    rig = await makeRig({ folders: ['app/src'] });
    const r = await rig.launcher.folders.list({ root: 'r.work', path: 'app', showHidden: false }, phone);
    expect(r.ok && { root: r.listing.root, path: r.listing.path, display: r.listing.display, next: r.listing.next }).toEqual({
      root: 'r.work',
      path: 'app',
      display: '~/work/app',
      next: null,
    });
  });

  it('pages of 500 with a cursor', async () => {
    rig = await makeRig({ folders: [] });
    await Promise.all(Array.from({ length: FOLDERS_PAGE + 3 }, (_, i) => mkdir(join(rig.work, `d${String(i).padStart(4, '0')}`))));
    const first = await rig.launcher.folders.list({ root: 'r.work', path: '', showHidden: false }, phone);
    if (!first.ok) throw new Error(first.reason);
    expect(first.listing.entries).toHaveLength(FOLDERS_PAGE);
    expect(first.listing.next).toBe('d0499');
    const second = await rig.launcher.folders.list({ root: 'r.work', path: '', showHidden: false, after: 'd0499' }, phone);
    expect(second.ok && second.listing.entries.map((e) => e.name)).toEqual(['d0500', 'd0501', 'd0502']);
    expect(second.ok && second.listing.next).toBeNull();
  });

  it('every page counts the folders on all pages, hidden ones only with showHidden', async () => {
    rig = await makeRig({ folders: [] });
    await Promise.all(Array.from({ length: FOLDERS_PAGE + 3 }, (_, i) => mkdir(join(rig.work, `d${String(i).padStart(4, '0')}`))));
    await mkdir(join(rig.work, '.cache'));
    await mkdir(join(rig.work, 'node_modules'));
    const first = await rig.launcher.folders.list({ root: 'r.work', path: '', showHidden: false }, phone);
    if (!first.ok) throw new Error(first.reason);
    expect([first.listing.entries.length, first.listing.total]).toEqual([FOLDERS_PAGE, FOLDERS_PAGE + 3]);
    expect(FoldersListResponseSchema.parse(first.listing).total).toBe(FOLDERS_PAGE + 3);
    const second = await rig.launcher.folders.list({ root: 'r.work', path: '', showHidden: false, after: 'd0499' }, phone);
    expect(second.ok && second.listing.total).toBe(FOLDERS_PAGE + 3);
    const all = await rig.launcher.folders.list({ root: 'r.work', path: '', showHidden: true }, phone);
    expect(all.ok && all.listing.total).toBe(FOLDERS_PAGE + 5);
  });

  it('refusals: an unknown root, a path out of the root, a protected folder', async () => {
    rig = await makeRig({ folders: ['.ssh'] });
    const list = (root: string, path: string) => rig.launcher.folders.list({ root, path, showHidden: true }, phone);
    expect(await list('r.nope', '')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await list('r.work', '../..')).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await list('r.work', '.ssh')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await list('r.work', 'missing')).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('recent', () => {
  it('the newest 8 from folders_seen (every session.added) and launches; folders out of every root are left out', async () => {
    rig = await makeRig({ folders: Array.from({ length: 10 }, (_, i) => `p${i}`) });
    for (let i = 0; i < 10; i++) {
      rig.ctx.clock.set(Date.parse(T0) + i * 60_000);
      rig.ctx.store.emit({ type: 'session.added', sid: `s${i}`, data: { session: session({ sid: `s${i}`, cwd: join(rig.work, `p${i}`), account: i, name: `n${i}` }) } });
    }
    rig.ctx.store.emit({ type: 'session.added', sid: 'gone', data: { session: session({ sid: 'gone', cwd: '/elsewhere/entirely' }) } });
    await settle(() => rig.ctx.db.folders.recentSeen(20).length === 11);
    const recent = await rig.launcher.folders.recent(phone);
    expect(recent).toHaveLength(8);
    expect(recent[0]).toEqual({ rootId: 'r.work', path: 'p9', display: '~/work/p9', lastUsed: '2026-01-15T10:09:00.000Z', lastAccount: 9, name: 'n9' });
    expect(recent.map((r) => r.path)).toEqual(['p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2']);
  });
});

describe('pins', () => {
  it('pin needs a real folder under a root; unpin works even when it is gone; at most 20', async () => {
    rig = await makeRig({ folders: Array.from({ length: PINS_MAX + 1 }, (_, i) => `f${i}`) });
    expect(await rig.launcher.folders.pin({ root: 'r.work', path: 'nope', pinned: true }, phone)).toMatchObject({ ok: false, code: 'not_found' });
    for (let i = 0; i < PINS_MAX; i++) expect((await rig.launcher.folders.pin({ root: 'r.work', path: `f${i}/`, pinned: true }, phone)).ok).toBe(true);
    expect(rig.ctx.db.folders.pins()[0]).toMatchObject({ rootId: 'r.work', rel: 'f0', by: 'device:dev-phone' });
    expect(await rig.launcher.folders.pin({ root: 'r.work', path: `f${PINS_MAX}`, pinned: true }, phone)).toMatchObject({ ok: false, code: 'conflict' });
    // Pinning one again is fine.
    expect((await rig.launcher.folders.pin({ root: 'r.work', path: 'f0', pinned: true }, phone)).ok).toBe(true);
    expect((await rig.launcher.folders.pin({ root: 'r.work', path: 'gone-already', pinned: false }, phone)).ok).toBe(true);
    expect((await rig.launcher.folders.pin({ root: 'r.work', path: 'f1', pinned: false }, phone)).ok).toBe(true);
    expect(rig.ctx.db.folders.pins()).toHaveLength(PINS_MAX - 1);
  });
});

describe('L11: create a folder', () => {
  const create = (parent: string, name: string, actor = launcher) => rig.launcher.folders.create({ root: 'r.work', parent, name }, actor);

  it('one mkdir of a checked name, 0755, never recursive', async () => {
    rig = await makeRig({ folders: ['app'] });
    expect(await create('app', 'new-thing')).toEqual({ ok: true, created: { root: 'r.work', path: 'app/new-thing' } });
    const st = await stat(join(rig.work, 'app', 'new-thing'));
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o022).toBe(0);
    expect(await create('missing/deeper', 'x')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await isDir(join(rig.work, 'missing'))).toBe(false);
  });

  it('the name regex: no leading dot, no "/", no trailing space or dot, at most 60', async () => {
    rig = await makeRig();
    for (const bad of ['.hidden', 'a/b', 'trailing ', 'trailing.', '', '-dash', 'x'.repeat(61), '../up', 'nul\u0000']) {
      expect(await create('', bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect((await create('', 'My Project v2')).ok).toBe(true);
  });

  it('an existing name is a conflict, file or folder', async () => {
    rig = await makeRig({ folders: ['taken'] });
    await writeFile(join(rig.work, 'file'), '');
    expect(await create('', 'taken')).toEqual({ ok: false, code: 'conflict', reason: 'A folder named taken already exists here' });
    expect(await create('', 'file')).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('the parent must pass the policy: not protected, not out of the root through a link', async () => {
    rig = await makeRig({ folders: ['.ssh', 'ok'] });
    await symlink(rig.tmp, join(rig.work, 'escape'));
    expect(await create('.ssh', 'x')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await create('escape', 'x')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await isDir(join(rig.tmp, 'x'))).toBe(false);
    expect(await create('ok', 'id_rsa')).toEqual({ ok: false, code: 'forbidden', reason: 'That name is on the protected list' });
  });

  it('macOS refusals become sentences: EPERM is the privacy (TCC) one', async () => {
    rig = await makeRig({ folders: ['locked'] });
    await chmod(join(rig.work, 'locked'), 0o555);
    try {
      expect(await create('locked', 'x')).toMatchObject({ ok: false, code: 'forbidden', reason: expect.stringMatching(/permission denied/) });
    } finally {
      await chmod(join(rig.work, 'locked'), 0o755);
    }
    expect(mkdirFailure(Object.assign(new Error('x'), { code: 'EPERM' }), 'x')).toEqual({ ok: false, code: 'forbidden', reason: TCC_SENTENCE });
    expect(mkdirFailure(Object.assign(new Error('x'), { code: 'ENOSPC' }), 'x')).toMatchObject({ code: 'unavailable' });
  });

  it('at most launch.rate.foldersPerHour per actor', async () => {
    rig = await makeRig({ settings: { launch: { enabled: true, rate: { foldersPerHour: 3 } } } });
    for (let i = 0; i < 3; i++) expect((await create('', `f${i}`)).ok).toBe(true);
    const r = await create('', 'f3');
    expect(r).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(!r.ok && (r as { retryAfterMs?: number }).retryAfterMs).toBe(60 * 60_000);
    expect((await create('', 'other', device('dev-other'))).ok).toBe(true);
    await advance(rig.ctx.clock, 60 * 60_000 + 1, 60_000);
    expect((await create('', 'f3')).ok).toBe(true);
  });
});

describe('folders_seen', () => {
  it('every session.added records its folder realpath, account and name; sessions there at start too', async () => {
    rig = await makeRig({ folders: ['app'], start: false });
    rig.ctx.store.emit({ type: 'session.added', sid: 'early', data: { session: session({ sid: 'early', cwd: join(rig.work, 'app', '.'), account: 3, name: 'early' }) } });
    await rig.launcher.start();
    await settle(() => rig.ctx.db.folders.recentSeen(5).length === 1);
    expect(rig.ctx.db.folders.recentSeen(5)).toEqual([{ cwd: join(rig.work, 'app'), lastSeenAt: T0, account: 3, name: 'early' }]);
  });
});
