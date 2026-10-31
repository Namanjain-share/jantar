import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET_MARKER, assistantText, makeSession } from '@jantar/fixtures';
import type { Account } from '@jantar/protocol';
import { createClaudeFilesSource } from '../../src/sources/claude-files/index.js';
import { computePlan, createCcwLegacy, createCcwLegacySource, parseBurn, parseSwitchConfig } from '../../src/sources/ccw-legacy/index.js';
import { createCswapUsageSource } from '../../src/sources/cswap/index.js';
import { createFileTranscriptReader, createTranscriptWatcherWith } from '../../src/sources/transcripts/index.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { SID, at, sourceEnv, type SourceEnv } from './helpers.js';

async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await stat(p);
        out[p] = `${st.mtimeMs}:${st.mode}:${createHash('sha256').update(await readFile(p)).digest('hex')}`;
      }
    }
  };
  await walk(dir);
  return out;
}

describe('ccw-legacy: reading ccw’s files', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv({ home: { ccw: true } });
    // a stand-in for the bot's secret config: it must never be opened
    await writeFile(join(env.home.paths.ccwDir, 'telegram.json'), JSON.stringify({ token: SECRET_MARKER }));
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('knows whether ccw is there', async () => {
    expect(createCcwLegacy(env.ctx).present()).toBe(true);
    const bare = await sourceEnv();
    try {
      const ccw = createCcwLegacy(bare.ctx);
      expect(ccw.present()).toBe(false);
      expect(await ccw.moves()).toEqual([]);
      expect(await ccw.switchConfig()).toBeNull();
      expect(await ccw.plan()).toEqual({ source: 'none', next: null, accounts: [], updatedAt: null });
      expect(await ccw.botRunning()).toBe(false);
      expect(await ccw.moveLocked(SID.busy)).toBe(false);
    } finally {
      await bare.cleanup();
    }
  });

  it('reads switch.json', async () => {
    expect(await createCcwLegacy(env.ctx).switchConfig()).toEqual({
      on: false,
      dryRun: true,
      hold: [3],
      groups: [['alpha-app', 'bravo-api']],
    });
    expect(parseSwitchConfig({})).toMatchObject({ on: true, dryRun: false, hold: [], ceiling: 97 }); // ccw's own defaults, minus personal values
  });

  it('keeps the last good switch.json while it is half-written', async () => {
    const ccw = createCcwLegacy(env.ctx);
    await ccw.switchConfig();
    await writeFile(join(env.home.paths.ccwDir, 'switch.json'), '{"on": tr');
    expect((await ccw.switchConfig())?.hold).toEqual([3]);
  });

  it('reads burn.json, including the old two-field entries, capped at 20 %/min', async () => {
    const burn = await createCcwLegacy(env.ctx).burn();
    const nowS = env.home.now / 1000;
    expect(burn.find((b) => b.sid === SID.busy)).toEqual({ sid: SID.busy, pctPerMin: 0.9, updatedAt: new Date((nowS - 300) * 1000).toISOString() });
    expect(parseBurn({ a: [1.5, nowS], b: [30, nowS, 40], c: 'junk', d: [1] })).toEqual([
      { sid: 'a', pctPerMin: 1.5, updatedMs: nowS * 1000 },
      { sid: 'b', pctPerMin: 20, updatedMs: nowS * 1000 },
    ]);
  });

  it('reads moves, and shows a move whose ccw process died as stuck (without touching the file)', async () => {
    const nowS = env.home.now / 1000;
    const owner = env.home.session(SID.idle).pid; // a pid the fake probe reports alive
    await env.home.writeCcwMove({ sid: SID.busy, name: 'add login form', folder: 'alpha-app', from: 1, to: 2, step: 'saving', why: 'account 1 full in 8m', since: nowS - 60, owner });
    await env.home.writeCcwMove({ sid: SID.idle, from: 2, step: 'parked', why: 'no room', since: nowS - 600, owner, wake_at: nowS + 1800 });
    await env.home.writeCcwMove({ sid: SID.waiting, from: 3, to: 4, step: 'restarting', why: 'x', since: nowS - 30, owner: 99_999 });
    await writeFile(join(env.home.paths.ccwSwitchDir, 'stray.json'), '{"hello": "world"}');
    const ccw = createCcwLegacy(env.ctx);
    const moves = await ccw.moves();
    expect(moves.map((m) => [m.sid, m.step])).toEqual([
      [SID.idle, 'parked'],
      [SID.busy, 'saving'],
      [SID.waiting, 'stuck'],
    ]);
    expect(moves[1]).toEqual({
      sid: SID.busy,
      from: 1,
      to: 2,
      step: 'saving',
      why: 'account 1 full in 8m',
      since: new Date((nowS - 60) * 1000).toISOString(),
      ownerPid: owner,
      name: 'add login form',
      folder: 'alpha-app',
    });
    expect(moves[0]?.wakeAt).toBe(new Date((nowS + 1800) * 1000).toISOString());
    expect(moves[2]).toMatchObject({ orphan: true, why: 'the ccw moving it stopped while restarting' });
    expect(await ccw.moveFor(SID.busy)).toEqual(moves[1]);
    expect(await ccw.moveFor('nope')).toBeNull();
    const raw = JSON.parse(await readFile(join(env.home.paths.ccwSwitchDir, `${SID.waiting}.json`), 'utf8'));
    expect(raw.step).toBe('restarting'); // we only read
  });

  it('says a move is locked while ccw holds the lock, or the move file says a typing step', async () => {
    const nowS = env.home.now / 1000;
    const owner = env.home.session(SID.idle).pid;
    await env.home.writeCcwMove({ sid: SID.idle, from: 2, step: 'parked', why: 'no room', since: nowS, owner });
    const ccw = createCcwLegacy(env.ctx);
    expect(await ccw.moveLocked(SID.idle)).toBe(false);
    const lock = join(env.home.paths.ccwSwitchDir, `${SID.idle}.lock`);
    await env.home.setLsofOpen({ [lock]: 4242 });
    expect(await ccw.moveLocked(SID.idle)).toBe(true);
    const lsofCalls = await env.home.calls('lsof');
    expect(lsofCalls.at(-1)?.args).toEqual(['-t', '--', lock]);
    expect(lsofCalls.at(-1)?.env.LC_ALL).toBe('C');

    await env.home.setLsofOpen({});
    await env.home.writeCcwMove({ sid: SID.idle, from: 2, to: 1, step: 'continuing', why: 'moved', since: nowS, owner });
    expect(await ccw.moveLocked(SID.idle)).toBe(true); // the move file alone says so
    // without lsof, the move file still decides
    const noLsof = createCcwLegacy({ ...env.ctx, bins: { ...env.ctx.bins, lsof: null } });
    expect(await noLsof.moveLocked(SID.idle)).toBe(true);
    expect(await ccw.moveLocked(SID.busy)).toBe(false);
    expect(await ccw.moveLocked('../escape')).toBe(false);
  });

  it('tells whether ccw’s bot is running from its lock, never from its config', async () => {
    const seen: string[] = [];
    for (const m of ['readText', 'readFile', 'open'] as const) {
      const orig = fsx[m].bind(fsx) as (p: string) => Promise<unknown>;
      vi.spyOn(fsx, m).mockImplementation(((p: string) => {
        seen.push(p);
        return orig(p);
      }) as never);
    }
    const ccw = createCcwLegacy(env.ctx, { botCacheMs: 0 });
    expect(await ccw.botRunning()).toBe(false); // no lock file: never started
    const lock = join(env.home.paths.ccwDir, 'telegram.lock');
    await writeFile(lock, '');
    expect(await ccw.botRunning()).toBe(false); // lock file, nobody holds it
    await env.home.setLsofOpen({ [lock]: 5150 });
    expect(await ccw.botRunning()).toBe(true);
    await ccw.switchConfig();
    await ccw.moves();
    await ccw.burn();
    await ccw.plan();
    expect(seen.some((p) => p.endsWith('telegram.json'))).toBe(false);
  });

  it('falls back to the process list when lsof is missing', async () => {
    await writeFile(join(env.home.paths.ccwDir, 'telegram.lock'), '');
    const ccw = createCcwLegacy({ ...env.ctx, bins: { ...env.ctx.bins, lsof: null } }, { botCacheMs: 0 });
    expect(await ccw.botRunning()).toBe(false);
    await env.home.setProcesses([
      ...env.home.processes(),
      { pid: 777, ppid: 1, tty: '??', stat: 'S', comm: 'python3', args: '/opt/py/bin/python3 /home/x/.local/bin/ccw --telegram', startMs: env.home.now, pcpu: 0, user: 'tester' },
    ]);
    expect(await ccw.botRunning()).toBe(true);
  });
});

describe('ccw-legacy: service and plan', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv({ home: { ccw: true } });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('emits move events as ccw’s move files change, and never writes into ~/.config/ccw', async () => {
    const before = await snapshotDir(env.home.paths.ccwDir);
    const nowS = env.home.now / 1000;
    const owner = env.home.session(SID.idle).pid;
    const sessions = createClaudeFilesSource(env.ctx, { watch: false, pollMs: 1e9 });
    await sessions.start();
    await env.home.writeCcwMove({ sid: SID.busy, from: 1, to: 2, step: 'saving', why: 'full soon', since: nowS, owner });
    const afterWrite = await snapshotDir(env.home.paths.ccwDir);
    const ccw = createCcwLegacy(env.ctx, { pollMs: 1e9 });
    await ccw.start();
    expect(env.events.of('move.saving', SID.busy)).toHaveLength(1);
    expect(env.ctx.store.getState().sessions[SID.busy]?.move?.step).toBe('saving');
    await ccw.pollOnce();
    expect(env.events.of('move.saving')).toHaveLength(1); // unchanged: no repeat

    await env.home.writeCcwMove({ sid: SID.busy, from: 1, to: 2, step: 'parked', why: 'no room', since: nowS + 5, owner });
    await ccw.pollOnce();
    expect(env.events.of('move.parked', SID.busy)).toHaveLength(1);
    await env.home.removeCcwMove(SID.busy);
    const afterRemove = await snapshotDir(env.home.paths.ccwDir);
    await ccw.pollOnce();
    expect(env.events.of('move.cleared', SID.busy)).toHaveLength(1);
    expect(env.ctx.store.getState().moves).toEqual({});
    expect(env.ctx.store.getState().sessions[SID.busy]?.move).toBeUndefined();
    await ccw.plan();
    await ccw.moveLocked(SID.busy);
    await ccw.botRunning();
    await ccw.stop();
    await sessions.stop();
    expect(env.ctx.clock.pending()).toBe(0);
    // every change in the dir was made by the test, none by Jantar
    expect(Object.keys(before).every((k) => k in afterWrite)).toBe(true);
    expect(await snapshotDir(env.home.paths.ccwDir)).toEqual(afterRemove);
  });

  it('attaches a move published before its session appeared, and keeps Done quiet while ccw drives it', async () => {
    const nowS = env.home.now / 1000;
    const owner = env.home.session(SID.idle).pid;
    await env.home.writeCcwMove({ sid: SID.busy, from: 1, to: 2, step: 'saving', why: 'full soon', since: nowS, owner });
    const ccw = createCcwLegacy(env.ctx, { pollMs: 1e9 });
    await ccw.start(); // first, as in the integration order
    const sessions = createClaudeFilesSource(env.ctx, { watch: false, pollMs: 1e9 });
    await sessions.start();
    expect(env.ctx.store.getState().sessions[SID.busy]?.move?.step).toBe('saving');
    const watcher = createTranscriptWatcherWith(env.ctx, { sessions, transcripts: createFileTranscriptReader(env.ctx) }, { pollMs: 1e9 });
    await watcher.start();
    // ccw's save prompt gets its answer: idle with a reply, which is the move's business, not a Done
    const cwd = env.home.session(SID.busy).cwd;
    env.ctx.clock.advance(5000);
    await env.home.updateSessionFile(SID.busy, { status: 'idle', statusUpdatedAt: env.ctx.clock.now() });
    await env.home.appendTranscript(SID.busy, [assistantText(at(env.ctx, SID.busy, cwd), 'Saved. READY-TO-SWITCH')]);
    await sessions.scan();
    await watcher.pollOnce();
    env.ctx.clock.advance(1500);
    await watcher.pollOnce();
    expect(env.events.of('session.done')).toEqual([]);
    await watcher.stop();
    await sessions.stop();
    await ccw.stop();
  });

  it('projects burn and "full in" per account from ccw’s rates and cswap’s usage', async () => {
    await env.ctx.settings.patch({ usage: { poller: 'off' } }); // the cache only, deterministic
    const sessions = createClaudeFilesSource(env.ctx, { watch: false, pollMs: 1e9 });
    const ccw = createCcwLegacySource(env.ctx, {});
    const usage = createCswapUsageSource(env.ctx, { ccwLegacy: ccw }, { tickMs: 1e9 });
    await sessions.start();
    await usage.start();
    const plan = await ccw.plan();
    expect(plan.source).toBe('ccw-legacy');
    expect(plan.updatedAt).toEqual(expect.any(String));
    const a = Object.fromEntries(plan.accounts.map((x) => [x.id, x]));
    // live sessions and their learned rates: account 1 <- busy 0.9, 2 <- idle 1.2, 3 <- waiting 1.5, 4 <- docs pass 1.8
    expect([a[1]?.burnPctPerMin, a[2]?.burnPctPerMin, a[3]?.burnPctPerMin, a[4]?.burnPctPerMin]).toEqual([0.9, 1.2, 1.5, 1.8]);
    expect(a[1]?.usable).toBe(true);
    expect(a[2]?.usable).toBe(true);
    expect(a[3]?.usable).toBe(false); // held in ccw's config, and needs a re-login
    expect(a[4]?.usable).toBe(false); // weekly 96% is over the 95% ceiling
    // account 1: 42% read 45 s ago, +0.9 %/min since -> (97 - 42.675) / 0.9
    expect(a[1]?.fullInMin).toBeCloseTo((97 - (42 + 0.9 * 0.75)) / 0.9, 1);
    expect(a[1]?.ridesReset).toBe(false);
    expect(plan.next).toBeNull(); // nothing gives a typical session (1.5 %/min) the 20 minutes it needs
    // the ceilings ccw plans with, for clients that cannot read settings
    expect([plan.ceiling, plan.weeklyCeiling]).toEqual([97, 95]);
    await usage.stop();
    await sessions.stop();
  });
});

describe('ccw-legacy: computePlan', () => {
  const now = Date.parse('2026-01-15T10:00:00Z');
  const iso = (min: number) => new Date(now + min * 60_000).toISOString();
  const acct = (id: number, pct5: number, resetMin: number | null, weekly = 10, over: Partial<Account> = {}): Account => ({
    id,
    emailMasked: 'x***@e***.com',
    isDefaultLogin: false,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    fetchedAt: new Date(now).toISOString(),
    ageS: 0,
    windows: [
      resetMin === null ? { kind: 'five_hour', pct: pct5 } : { kind: 'five_hour', pct: pct5, resetsAt: iso(resetMin) },
      { kind: 'seven_day', pct: weekly },
    ],
    ...over,
  });
  const cfg = parseSwitchConfig({ hold: [5] })!;

  it('prefers an unshared account, then one that resets before it fills, then the soonest reset', () => {
    const sessions = [makeSession({ sid: 's1', account: 1, status: 'working', folder: 'one' })];
    const burn = [{ sid: 's1', pctPerMin: 1, updatedMs: now - 60_000 }];
    const input = {
      nowMs: now,
      sessions,
      moves: [],
      burn,
      active: new Map([['s1', now - 1000]]),
      cfg,
      accounts: [
        acct(1, 10, 200), // has a session on it: shared
        acct(2, 10, 250),
        acct(3, 10, 60), // resets soonest
        acct(4, 10, 100, 99), // weekly over the ceiling
        acct(5, 0, 30), // held
      ],
    };
    const out = computePlan(input);
    expect(out.next).toBe(3);
    expect(out.accounts.map((a) => [a.id, a.usable])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
      [5, false],
    ]);
    expect(out.accounts[0]).toMatchObject({ burnPctPerMin: 1, fullInMin: 87 });
    expect(out.accounts[1]?.fullInMin).toBeUndefined(); // nothing burning there
  });

  it('counts a moving session where it is headed and a parked one nowhere', () => {
    const sessions = [makeSession({ sid: 's1', account: 1, status: 'working' }), makeSession({ sid: 's2', account: 1, status: 'working' })];
    const out = computePlan({
      nowMs: now,
      sessions,
      moves: [
        { sid: 's1', from: 1, to: 2, step: 'restarting', why: '', since: iso(-1) },
        { sid: 's2', from: 1, step: 'parked', why: '', since: iso(-1) },
      ],
      burn: [
        { sid: 's1', pctPerMin: 2, updatedMs: now },
        { sid: 's2', pctPerMin: 3, updatedMs: now },
      ],
      active: new Map(),
      cfg,
      accounts: [acct(1, 50, 100), acct(2, 20, 100)],
    });
    expect(out.accounts.map((a) => [a.id, a.burnPctPerMin])).toEqual([
      [1, 0],
      [2, 2],
    ]);
  });
});
