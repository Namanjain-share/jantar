/**
 * v0.6 Fleet, lane L2: accounts as config dirs (accountsMode "dirs", spec 5),
 * on the fixture homes of a Linux server and a native Windows one.
 *
 * - dirsAccounts: ~/.claude is 0 ("claude"); each ~/.claude-<name> holding a
 *   .claude.json gets the next number the first time it is seen, kept in kv
 *   (accounts.dirIds) and never reused or renumbered; no .claude.json, a
 *   plain file, ~/.claude-swap-backup: no account. It only stats
 *   .claude.json: one that can't be read still counts, and nothing from a
 *   dir's other files reaches kv or an event.
 * - The usage source: the roster at start and every 10 minutes (no usage
 *   numbers, activeAccount 0), a refresh refused with FLEET_COPY.noUsage,
 *   no command run; the usage factory builds it in dirs mode.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLEET_COPY } from '@jantar/protocol';
import { FLEET_SECRET, linuxHome, windowsHome, writeHomeLayout } from '@jantar/fixtures';
import { createFakeExec, createTestContext } from '../../src/core/testing.js';
import { createUsageSource } from '../../src/sources/cswap/index.js';
import {
  DIRS_LIST_MS,
  DIR_IDS_KV_KEY,
  DirsUsageSource,
  createDirsUsageSource,
  dirAccount,
  dirsAccountFor,
  dirsAccounts,
} from '../../src/sources/cswap/dirs.js';
import { createMemoryDb } from '../../src/core/memory-db.js';
import { inertCcwLegacy } from '../../src/modes.js';

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jantar-dirs-'));
  home = join(root, 'home', 'sam');
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  await chmod(join(home, '.claude-locked', '.claude.json'), 0o644).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const paths = () => ({ claudeHome: join(home, '.claude') });
const ids = (list: { id: number; alias: string }[]) => list.map((a) => `${a.id}:${a.alias}`);

async function addDir(name: string, withJson = true): Promise<void> {
  await mkdir(join(home, name), { recursive: true });
  if (withJson) await writeFile(join(home, name, '.claude.json'), '{}\n');
}

describe('dirsAccounts: config dirs as accounts, numbered for good', () => {
  it('a Linux server: ~/.claude is 0, ~/.claude-work is 1; a dir without .claude.json is none', async () => {
    await writeHomeLayout(home, linuxHome());
    const db = createMemoryDb();
    const list = dirsAccounts(paths(), db.kv);
    expect(list).toEqual([
      { id: 0, alias: 'claude', dir: join(home, '.claude') },
      { id: 1, alias: 'work', dir: join(home, '.claude-work') },
    ]);
    expect(db.kv.get(DIR_IDS_KV_KEY)).toEqual({ '.claude-work': 1 });
  });

  it('a Windows profile: the same two', async () => {
    await writeHomeLayout(home, windowsHome());
    expect(ids(dirsAccounts(paths(), createMemoryDb().kv))).toEqual(['0:claude', '1:work']);
  });

  it('keeps every number when a dir is added, removed and comes back; a number is never reused', async () => {
    await writeHomeLayout(home, linuxHome());
    const { kv } = createMemoryDb();
    expect(ids(dirsAccounts(paths(), kv))).toEqual(['0:claude', '1:work']);
    // added later, sorting before "work": the next number, work keeps 1
    await addDir('.claude-alpha');
    expect(ids(dirsAccounts(paths(), kv))).toEqual(['0:claude', '1:work', '2:alpha']);
    // work goes away: alpha stays 2; a new dir gets 3, never 1
    await rm(join(home, '.claude-work'), { recursive: true });
    await addDir('.claude-beta');
    expect(ids(dirsAccounts(paths(), kv))).toEqual(['0:claude', '2:alpha', '3:beta']);
    // work comes back as 1
    await addDir('.claude-work');
    expect(ids(dirsAccounts(paths(), kv))).toEqual(['0:claude', '1:work', '2:alpha', '3:beta']);
    // the scratch dir gets a .claude.json (claude ran there): the next number
    await writeFile(join(home, '.claude-scratch', '.claude.json'), '{}\n');
    expect(ids(dirsAccounts(paths(), kv))).toEqual(['0:claude', '1:work', '2:alpha', '3:beta', '4:scratch']);
    expect(kv.get(DIR_IDS_KV_KEY)).toEqual({ '.claude-work': 1, '.claude-alpha': 2, '.claude-beta': 3, '.claude-scratch': 4 });
  });

  it('several new dirs at once are numbered in name order', async () => {
    for (const n of ['.claude-zeta', '.claude-beta', '.claude-mid']) await addDir(n);
    expect(ids(dirsAccounts(paths(), createMemoryDb().kv))).toEqual(['0:claude', '1:beta', '2:mid', '3:zeta']);
  });

  it('never: ~/.claude-swap-backup, a plain file, ~/.claude.json, a bare ".claude-", another prefix', async () => {
    await addDir('.claude-swap-backup');
    await addDir('.claude-');
    await addDir('.claudex');
    await addDir('claude-plain');
    await writeFile(join(home, '.claude-file'), 'synthetic\n');
    await writeFile(join(home, '.claude.json'), '{}\n');
    expect(ids(dirsAccounts(paths(), createMemoryDb().kv))).toEqual(['0:claude']);
  });

  it('~/.claude is 0 even before it exists', () => {
    expect(dirsAccounts(paths(), createMemoryDb().kv)).toEqual([{ id: 0, alias: 'claude', dir: join(home, '.claude') }]);
  });

  it('only stats .claude.json: an unreadable one still counts, and nothing in a dir reaches kv', async () => {
    await addDir('.claude-locked');
    await writeFile(join(home, '.claude-locked', '.claude.json'), `{"oauthAccount":"${FLEET_SECRET}"}\n`);
    await writeFile(join(home, '.claude-locked', '.credentials.json'), `${FLEET_SECRET}\n`);
    await chmod(join(home, '.claude-locked', '.claude.json'), 0o000);
    const { kv } = createMemoryDb();
    expect(ids(dirsAccounts(paths(), kv))).toEqual(['0:claude', '1:locked']);
    expect(JSON.stringify(kv.get(DIR_IDS_KV_KEY))).not.toContain(FLEET_SECRET);
  });

  it('junk in kv is ignored, and a kv that fails is survived', async () => {
    await addDir('.claude-work');
    const { kv } = createMemoryDb();
    kv.set(DIR_IDS_KV_KEY, { '.claude-old': 5, '.claude-bad': -1, '.claude-float': 1.5, '.claude-str': '7' });
    expect(ids(dirsAccounts(paths(), kv))).toEqual(['0:claude', '6:work']);
    kv.set(DIR_IDS_KV_KEY, ['not', 'a', 'map']);
    expect(ids(dirsAccounts(paths(), kv))).toEqual(['0:claude', '1:work']);
    const broken = { get: () => { throw new Error('db gone'); }, set: () => { throw new Error('db gone'); }, delete: () => undefined };
    expect(ids(dirsAccounts(paths(), broken))).toEqual(['0:claude', '1:work']);
  });

  it('dirsAccountFor: a session\'s config dir to its number, any spelling; others none', async () => {
    await writeHomeLayout(home, linuxHome());
    const list = dirsAccounts(paths(), createMemoryDb().kv);
    expect(dirsAccountFor(join(home, '.claude'), list)).toBe(0);
    expect(dirsAccountFor(`${join(home, '.claude-work')}/`, list)).toBe(1);
    expect(dirsAccountFor(join(home, '.claude-scratch'), list)).toBeNull();
    expect(dirsAccountFor('/somewhere/else', list)).toBeNull();
    expect(dirsAccountFor('', list)).toBeNull();
  });
});

describe('the dirs usage source', () => {
  function rig(mode: 'dirs' | 'cswap' = 'dirs') {
    const exec = createFakeExec();
    const ctx = createTestContext({ userHome: home, exec, accountsMode: mode });
    const events: { type: string; data: unknown }[] = [];
    ctx.store.subscribe((e) => events.push({ type: e.type, data: e.data }));
    return { ctx, exec, events };
  }

  it('emits the roster at start: no usage numbers, activeAccount 0, the default login flagged', async () => {
    await writeHomeLayout(home, linuxHome());
    const { ctx, exec, events } = rig();
    const src = createDirsUsageSource(ctx);
    await src.start();
    try {
      const updated = events.filter((e) => e.type === 'usage.updated');
      expect(updated).toHaveLength(1);
      expect(updated[0]?.data).toEqual({
        accounts: [
          { id: 0, alias: 'claude', emailMasked: '', isDefaultLogin: true, disabled: false, held: false, usageStatus: 'unknown', windows: [] },
          { id: 1, alias: 'work', emailMasked: '', isDefaultLogin: false, disabled: false, held: false, usageStatus: 'unknown', windows: [] },
        ],
        activeAccount: 0,
        fetchedAt: ctx.clock.iso(),
        source: 'cache',
      });
      expect(ctx.store.getState().accounts[1]?.alias).toBe('work');
      expect(src.latest()?.accounts.map((a) => a.id)).toEqual([0, 1]);
      expect(src.isPolling()).toBe(false);
      expect(src.requestRefresh('phone')).toEqual({ queued: false, reason: FLEET_COPY.noUsage(''), nextAllowedAt: null });
      expect(FLEET_COPY.noUsage('')).toBe('No usage numbers on this machine');
      expect(exec.calls).toEqual([]);
    } finally {
      await src.stop();
    }
  });

  it('lists the dirs again every 10 minutes: a new dir shows up with the next number', async () => {
    await writeHomeLayout(home, linuxHome());
    const { ctx, events } = rig();
    const src = createDirsUsageSource(ctx);
    await src.start();
    try {
      await addDir('.claude-ops');
      ctx.clock.advance(DIRS_LIST_MS - 1);
      expect(events.filter((e) => e.type === 'usage.updated')).toHaveLength(1);
      ctx.clock.advance(1);
      expect(events.filter((e) => e.type === 'usage.updated')).toHaveLength(2);
      expect(Object.values(ctx.store.getState().accounts).map((a) => `${a.id}:${a.alias}`)).toEqual(['0:claude', '1:work', '2:ops']);
      expect(DIRS_LIST_MS).toBe(600_000);
    } finally {
      await src.stop();
    }
    ctx.clock.advance(DIRS_LIST_MS * 3);
    expect(events.filter((e) => e.type === 'usage.updated')).toHaveLength(2);
  });

  it('read() lists without emitting; dirAccount shapes one dir', async () => {
    await addDir('.claude-work');
    const { ctx, events } = rig();
    const src = new DirsUsageSource(ctx);
    expect((await src.read()).accounts.map((a) => a.alias)).toEqual(['claude', 'work']);
    expect(events).toEqual([]);
    expect(dirAccount({ id: 3, alias: 'ops', dir: '/home/sam/.claude-ops' })).toMatchObject({ id: 3, alias: 'ops', isDefaultLogin: false, usageStatus: 'unknown', windows: [] });
  });

  it('the usage factory builds it in dirs mode', async () => {
    await writeHomeLayout(home, linuxHome());
    const { ctx } = rig('dirs');
    const src = createUsageSource(ctx, { ccwLegacy: inertCcwLegacy() });
    expect(src).toBeInstanceOf(DirsUsageSource);
  });
});
